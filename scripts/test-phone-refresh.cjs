const scratch = require('./fixtures/test-scratch.cjs');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { webkit, devices } = require('playwright');
const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '..');
const { MobileWorkspace } = require(path.join(root, 'app/mobile-workspace.cjs'));
const { RoomState } = require(path.join(root, 'app/room-state.cjs'));
const profile = scratch.directory(path.join(os.tmpdir(), 'naw-phone-refresh-'));
const pictures = process.env.NAW_PICTURES_DIR || profile; fs.mkdirSync(pictures, { recursive: true });
const results = [], errors = [], wait = ms => new Promise(r => setTimeout(r, ms));
const check = (name, pass) => { results.push({ name, pass: Boolean(pass) }); console.log(JSON.stringify(results.at(-1))); };
async function until(fn) { for (let i = 0; i < 200; i++) { if (await fn()) return; await wait(10); } throw Error('Synthetic refresh did not settle'); }
let browser;
async function scene(lang = 'en', sendStatus = 'submitted') {
  const context = await browser.newContext({ ...devices['iPhone 13'], viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const page = await context.newPage(), calls = [], held = [];
  const sessions = ['a', 'b'].map(id => ({ id, nativeId: 'native-' + id, provider: 'claude', name: 'Synthetic ' + id, state: 'idle',
    messages: [{ id: 'body-' + id, role: 'assistant', text: 'ORIGINAL-' + id, time: 1 }] }));
  const room = { id: 'shared', name: 'Synthetic room', messages: [{ id: 'room', role: 'human', text: 'ROOM-BODY' }], queue: [] };
  const scopes = sessions.map(s => ({ sessionId: s.id, nativeId: s.nativeId, serviceKey: '.', actions: ['read', 'send'] }));
  let allowed = ['a', 'b'], device = '10000000-0000-4000-8000-000000000001', csrf = 'c'.repeat(43), holdA = false;
  const desktop = new MobileWorkspace({ snapshot: () => ({ sessions, rooms: [room], room, backgroundConfirmations: [] }),
    roomState: new RoomState(profile), records: { status: () => ({ count: 0, records: [] }), acknowledge() {} } });
  const client = { refresh: async () => {}, route: () => ({ key: '.' }) };
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin !== 'https://phone.invalid') { errors.push('external request'); return route.abort(); }
    const value = req.method() === 'POST' ? req.postDataJSON() : null; calls.push({ path: url.pathname, method: req.method(), value });
    let data;
    if (url.pathname === '/mobile/session') data = { deviceId: device, csrf, workspace: true,
      sessions: sessions.filter(s => allowed.includes(s.id)).map(s => ({ id: s.id, name: s.name, provider: s.provider, available: scopes.some(p => p.sessionId === s.id && p.nativeId === s.nativeId), actions: ['read', 'send'] })) };
    else if (url.pathname === '/mobile/pair') { allowed = ['b']; device = '10000000-0000-4000-8000-000000000002'; csrf = 'd'.repeat(43); data = { paired: true }; }
    else if (url.pathname.startsWith('/mobile/read/')) data = { id: url.pathname.split('/').at(-1), contextId: 'x'.repeat(43), canSend: true, sendMode: 'send', messages: [], question: null };
    else if (url.pathname === '/mobile/send') { if (sendStatus === 'submitted') sessions[0].messages.push({ id: value.requestId, role: 'user', text: value.text, time: 2 }); data = { requestId: value.requestId, sessionId: 'a', action: 'send', status: sendStatus }; }
    else if (url.pathname === '/mobile/receipt') data = { requestId: value.requestId, sessionId: 'a', action: 'send', status: sendStatus };
    else if (/^\/mobile\/workspace(?:\/(summary|session\/[^/]+|room\/[^/]+))?$/.test(url.pathname)) {
      const p = url.pathname.split('/'), choice = p.length === 3 ? undefined : p[3] === 'summary' ? { kind: 'summary' } : { kind: p[3], id: p[4] };
      try { data = await desktop.read(client, { roomIds: ['shared'], records: false }, scopes.filter(s => allowed.includes(s.sessionId)), choice); data.capabilities.push = false; }
      catch { return route.fulfill({ status: 403, json: { error: 'MOBILE_WORKSPACE_DENIED' } }); }
      if (holdA && (url.pathname.endsWith('/session/a') || url.pathname === '/mobile/workspace' && page.url().endsWith('/chat/a'))) {
        const frozen = structuredClone(data); held.push(() => route.fulfill({ json: frozen }).catch(() => {})); return;
      }
    }
    if (data) return route.fulfill({ json: data });
    const file = url.pathname === '/mobile/' ? 'index.html' : url.pathname.slice('/mobile/'.length);
    if (!['index.html', 'client.js', 'workspace.js', 'passkeys.js', 'push.js', 'style.css', 'manifest.webmanifest'].includes(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'application/json', body: fs.readFileSync(path.join(root, 'app/mobile-web', file)) });
  });
  await page.goto('https://phone.invalid/mobile/#' + lang + '/home');
  await page.waitForFunction(() => document.documentElement.dataset.loading === 'false' && document.querySelector('a[href$="/chat/a"]'));
  return { page, context, calls, held, sessions, hold: () => { holdA = true; }, release: async () => { holdA = false; for (const release of held.splice(0)) await release(); },
    narrow: () => { allowed = ['b']; csrf = 'd'.repeat(43); }, replace: () => { sessions[0].nativeId = 'successor-native'; },
    close: async () => { holdA = false; for (const release of held.splice(0)) await release(); await context.close(); } };
}
const route = async (s, hash) => { await s.page.evaluate(hash => { location.hash = hash; }, hash); await s.page.waitForFunction(hash => document.documentElement.dataset.loading === 'false' && (hash.startsWith('#pair=') ? nawPhone.client.state.session?.deviceId.endsWith('2') : document.documentElement.dataset.route === hash), hash); };
(async () => {
  browser = await webkit.launch({ headless: true, executablePath: process.env.NAW_BROWSER_EXECUTABLE, env: { PATH: '/usr/bin:/bin', HOME: profile, TMPDIR: profile } });
  console.log('WebKit ' + browser.version());
  for (const lang of ['zh', 'en']) {
    const s = await scene(lang);
    try {
      check(lang + ' home requests summary without full endpoint', s.calls.some(c => c.path === '/mobile/workspace/summary') && !s.calls.some(c => c.path === '/mobile/workspace'));
      s.hold(); await s.page.locator('a[href="#' + lang + '/chat/a"]').tap(); await until(() => s.held.length);
      await s.page.locator('#message').fill('RETAINED-DRAFT-A');
      check(lang + ' unloaded conversation is loading, never an empty conversation', (await s.page.locator('#content').innerText()).includes(lang === 'zh' ? '正在读取对话内容' : 'Loading this conversation') && !(await s.page.locator('#content').innerText()).includes(lang === 'zh' ? '当前没有记录' : 'No records to show'));
      await s.page.screenshot({ path: path.join(pictures, lang + '-loading.png'), scale: 'css' });
      s.sessions[1].messages[0].text = 'CURRENT-B';
      await route(s, '#' + lang + '/home'); await route(s, '#' + lang + '/chat/b');
      await s.page.locator('#message').fill('RETAINED-DRAFT-B');
      check(lang + ' B refresh finishes while A is still held', s.held.length > 0 && (await s.page.locator('#content').innerText()).includes('CURRENT-B'));
      await s.release(); await wait(50);
      check(lang + ' late A cannot overwrite B or its draft', (await s.page.locator('#content').innerText()).includes('CURRENT-B') && !(await s.page.locator('#content').innerText()).includes('ORIGINAL-a') && await s.page.locator('#message').inputValue() === 'RETAINED-DRAFT-B');
      await route(s, '#' + lang + '/chat/a');
      check(lang + ' A draft survives route changes', await s.page.locator('#message').inputValue() === 'RETAINED-DRAFT-A');
      await s.page.screenshot({ path: path.join(pictures, lang + '-loaded.png'), scale: 'css' });
      s.hold(); const before = s.calls.filter(c => c.path === '/mobile/workspace/session/a').length;
      await s.page.evaluate(() => { void nawPhone.refresh(); void nawPhone.refresh(); void nawPhone.refresh(); }); await until(() => s.held.length);
      check(lang + ' only same-route duplicate reads are coalesced', s.calls.filter(c => c.path === '/mobile/workspace/session/a').length === before + 1); await s.release();
      await route(s, '#' + lang + '/space/shared'); check(lang + ' room uses selected body endpoint', s.calls.some(c => c.path === '/mobile/workspace/room/shared') && (await s.page.locator('#content').innerText()).includes('ROOM-BODY'));
      await route(s, '#' + lang + '/queue/shared'); check(lang + ' queue uses summaries', s.calls.at(-1).path === '/mobile/workspace/summary');
      check(lang + ' read navigation performs no writes', s.calls.every(c => c.method === 'GET'));
    } finally { await s.close(); }
  }
  for (const change of ['pair', 'scope', 'native']) {
    const s = await scene();
    try {
      await route(s, '#en/chat/a'); s.hold(); await s.page.evaluate(() => { void nawPhone.refresh(); }); await until(() => s.held.length);
      if (change === 'pair') await route(s, '#pair=' + 'P'.repeat(43));
      else { if (change === 'scope') s.narrow(); else s.replace(); await route(s, '#en/home'); }
      await s.release(); await wait(50);
      check(change + ' change rejects the old conversation response', !(await s.page.locator('#content').innerText()).includes('ORIGINAL-a') && await s.page.locator('.thread').count() === 0);
      check(change + ' change never resends', s.calls.filter(c => c.method === 'POST').every(c => c.path === '/mobile/pair'));
    } finally { await s.close(); }
  }
  const sent = await scene();
  try {
    sent.hold(); await sent.page.locator('a[href="#en/chat/a"]').tap(); await until(() => sent.held.length);
    await sent.page.locator('#message').fill('CONFIRMED-ONCE'); await sent.page.locator('#send-message').tap(); await until(() => sent.calls.some(c => c.path === '/mobile/send')); await wait(50);
    check('confirmed input remains visible before the fresh body returns', (await sent.page.locator('#content').innerText()).includes('CONFIRMED-ONCE'));
    await sent.held.shift()(); await wait(50);
    check('older body cannot remove a newer confirmed input', (await sent.page.locator('#content').innerText()).includes('CONFIRMED-ONCE'));
    await sent.release(); await until(() => sent.page.locator('.thread .bubble').filter({ hasText: 'CONFIRMED-ONCE' }).count().then(n => n === 1));
    check('one explicit input still makes one POST', sent.calls.filter(c => c.path === '/mobile/send').length === 1);
  } finally { await sent.close(); }
  const pending = await scene('en', 'unconfirmed');
  try {
    pending.hold(); await pending.page.locator('a[href="#en/chat/a"]').tap(); await until(() => pending.held.length);
    await pending.page.locator('#message').fill('UNCERTAIN-ONCE'); await pending.page.locator('#send-message').tap();
    await until(() => pending.page.evaluate(() => !nawPhone.client.state.busy));
    for (let i = 0; i < 50 && !(await pending.page.locator('.receipt').count()); i++) await wait(10);
    check('original pending receipt remains queryable while the body is loading', await pending.page.locator('.receipt').getByRole('button', { name: "Check this message's status", exact: true }).count() === 1);
    check('pending body read never resends or discards the draft', pending.calls.filter(c => c.path === '/mobile/send').length === 1 && await pending.page.locator('#message').inputValue() === 'UNCERTAIN-ONCE');
  } finally { await pending.close(); }
  check('no page errors or external requests', errors.length === 0);
  const fail = results.filter(r => !r.pass).length; console.log(JSON.stringify({ pass: results.length - fail, fail, skipped: 0 })); if (fail) process.exitCode = 1;
})().finally(scratch.cleanup(async () => { await browser?.close(); })).catch(e => { console.error(e.stack); process.exitCode = 1; });
