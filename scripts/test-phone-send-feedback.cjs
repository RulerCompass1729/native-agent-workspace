// Synthetic HTTP boundaries, actual phone scripts and WebKit; no native provider.
const testScratch = require('./fixtures/test-scratch.cjs');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { webkit, devices } = require('playwright');
const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '..');
const results = [], errors = [], wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const scratch = testScratch.directory(path.join(os.tmpdir(), 'naw-phone-send-'));
const check = (name, pass) => { results.push({ name, pass: Boolean(pass) }); console.log(JSON.stringify(results.at(-1))); };
async function until(fn) { for (let i = 0; i < 200; i++) { if (await fn()) return; await wait(10); } throw Error('Synthetic phone did not settle'); }
let browser;
async function scene(lang, history = false, completed = 0, viewport, tail) {
  const context = await browser.newContext({ ...devices['iPhone 13'], ...(viewport ? { viewport } : {}), serviceWorkers: 'block' }), page = await context.newPage();
  const sessions = ['a', 'b'].map(id => ({ id, name: 'Synthetic ' + id, provider: 'claude', state: 'idle', available: true, actions: ['read', 'send'] }));
  let generation = 0, hold = false, releaseNative, releaseWorkspace;
  const messages = history ? Array.from({ length: 60 }, (_, i) => ({ id: 'history-' + i, role: 'assistant', text: 'Synthetic history ' + i + ' '.repeat(2) + 'Earlier conversation. '.repeat(6), time: 1000 + i })) : [];
  if (history && tail) messages.at(-1).text = tail;
  const posted = [], held = [];
  page.on('pageerror', e => errors.push(e.message));
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== 'https://phone.invalid') return route.abort();
    let data;
    if (url.pathname === '/mobile/session') data = { deviceId: '00000000-0000-4000-8000-000000000001', csrf: (generation ? 'C' : 'A').repeat(43), workspace: true, sessions };
    else if (url.pathname.startsWith('/mobile/read/')) data = { id: url.pathname.split('/').at(-1), contextId: 'B'.repeat(43), canSend: true, sendMode: 'send', question: null, messages: [] };
    else if (url.pathname === '/mobile/send') {
      const value = request.postDataJSON(); posted.push(value);
      const status = await new Promise(resolve => { releaseNative = resolve; });
      hold = true; if (status === 'submitted') messages.push({ id: value.requestId, role: 'user', text: value.text, time: 1 });
      data = { requestId: value.requestId, sessionId: 'a', action: 'send', status };
    } else if ((url.pathname === '/mobile/workspace' || /^\/mobile\/workspace\/(summary|session\/[^/]+|room\/[^/]+)$/.test(url.pathname))) {
      data = { sessions: sessions.map(s => ({ ...s, messages: s.id === 'a' ? [...messages] : [] })), rooms: [], confirmations: [], reminders: { count: 0, records: [] }, capabilities: { push: false }, ...(history ? { steward: { state: 'shared', sessionId: 'a' } } : {}), syncedAt: 1 };
      if (hold) { held.push(route); await new Promise(resolve => { releaseWorkspace = resolve; }); }
    }
    if (data) return route.fulfill({ json: data }).catch(() => {});
    const name = url.pathname === '/mobile/' ? 'index.html' : url.pathname.slice('/mobile/'.length);
    if (!['index.html', 'client.js', 'workspace.js', 'passkeys.js', 'push.js', 'style.css', 'manifest.webmanifest'].includes(name)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.html') ? 'text/html' : 'application/json', body: fs.readFileSync(path.join(root, 'app/mobile-web', name)) });
  });
  if (completed) await context.addInitScript(saved => localStorage.setItem('naw.mobile.v1', JSON.stringify(saved)), {
    version: 1, drafts: [], pending: Array.from({ length: completed }, (_, i) => ({
      deviceId: '00000000-0000-4000-8000-000000000001', sessionId: 'a',
      requestId: '00000000-0000-4000-8000-' + String(i + 10).padStart(12, '0'),
      action: 'answer', text: '', revision: 0, status: 'reply-written',
    })),
  });
  await page.goto('https://phone.invalid/mobile/#' + lang + '/home');
  await page.waitForFunction(() => document.documentElement.dataset.loading === 'false' && document.querySelector('#content a[href$="/chat/a"]'));
  await page.locator(`#content a[href="#${lang}/chat/a"]`).click();
  await page.waitForFunction(() => document.documentElement.dataset.loading === 'false' && document.querySelector('#message'));
  return { page, posted, held, async send(text = 'SYNTHETIC_ORIGINAL') { await page.locator('#message').fill(text); await page.locator('#send-message').tap(); await until(() => releaseNative); },
    native(status) { releaseNative(status); }, reply() { messages.push({ id: 'reply-after-long', role: 'assistant', text: 'SYNTHETIC_REPLY_AFTER_LONG', time: 2 }); }, replaceGrant() { generation++; },
    async release() { hold = false; releaseWorkspace?.(); },
    async close() { releaseNative?.('unconfirmed'); releaseWorkspace?.(); await context.close(); } };
}
async function count(page) { return page.locator('.thread .bubble').filter({ hasText: 'SYNTHETIC_ORIGINAL' }).count(); }
(async () => {
  try {
    browser = await webkit.launch({ headless: true, executablePath: process.env.NAW_BROWSER_EXECUTABLE, env: { PATH: '/usr/bin:/bin', HOME: scratch, TMPDIR: scratch } });
    for (const lang of ['zh', 'en']) {
      const s = await scene(lang);
      try {
        await s.send(); check(lang + ' no bubble before native receipt', await count(s.page) === 0);
        s.native('submitted'); await until(() => s.held.length);
        check(lang + ' confirmed input appears before workspace snapshot', await count(s.page) === 1);
        check(lang + ' confirmed bubble is on screen', await s.page.locator('.thread .bubble').filter({ hasText: 'SYNTHETIC_ORIGINAL' }).evaluateAll(nodes => nodes.length === 1 && nodes[0].getBoundingClientRect().bottom <= innerHeight && nodes[0].getBoundingClientRect().top >= 0));
        await s.release(); await s.page.locator('.thread time[datetime="1970-01-01T00:00:00.001Z"]').waitFor();
        check(lang + ' final snapshot has one native bubble', await count(s.page) === 1);
        check(lang + ' one POST only', s.posted.length === 1);
      } finally { await s.close(); }
    }
    for (const status of ['awaiting-native', 'unconfirmed', 'not-sent']) {
      const s = await scene('zh');
      try {
        await s.send(); s.native(status); await until(() => s.held.length);
        check(status + ' never becomes a confirmed input bubble', await count(s.page) === 0);
        check(status + ' preserves draft', await s.page.locator('#message').inputValue() === 'SYNTHETIC_ORIGINAL');
        check(status + ' never retries', s.posted.length === 1);
      } finally { await s.close(); }
    }
    {
      const s = await scene('zh');
      try {
        await s.send(); s.native('submitted'); await until(() => s.held.length);
        await s.page.locator('#message').fill('SYNTHETIC_SECOND'); await s.page.locator('#send-message').tap(); await until(() => s.posted.length === 2);
        s.native('submitted'); await until(async () => await s.page.locator('.thread .bubble').filter({ hasText: 'SYNTHETIC_SECOND' }).count() === 1);
        const response = s.page.waitForResponse(r => new URL(r.url()).pathname === '/mobile/workspace/session/a'); await s.release(); await (await response).finished(); await wait(100);
        check('older full snapshot cannot remove a newer confirmed input', await s.page.locator('.thread .bubble').filter({ hasText: 'SYNTHETIC_SECOND' }).count() === 1);
        await s.page.locator('#connection button').click(); await s.page.locator('.thread time[datetime="1970-01-01T00:00:00.001Z"]').first().waitFor();
        check('later native snapshot replaces both transient rows', await count(s.page) === 1 && await s.page.locator('.thread .bubble').filter({ hasText: 'SYNTHETIC_SECOND' }).count() === 1);
        check('two explicit sends use exactly two distinct requests', s.posted.length === 2 && s.posted[0].requestId !== s.posted[1].requestId);
      } finally { await s.close(); }
    }
    {
      const s = await scene('zh');
      try {
        await s.send(); await s.page.locator('#message').fill('SYNTHETIC_NEW_DRAFT'); s.native('submitted'); await until(() => s.held.length);
        check('new draft survives old submitted receipt', await s.page.locator('#message').inputValue() === 'SYNTHETIC_NEW_DRAFT');
        check('submitted echo uses the original input', await count(s.page) === 1);
      } finally { await s.close(); }
    }
    {
      const s = await scene('zh');
      try {
        await s.send(); await s.page.evaluate(() => { location.hash = '#zh/chat/b'; });
        await s.page.waitForFunction(() => document.documentElement.dataset.route === '#zh/chat/b');
        s.native('submitted'); await wait(100);
        check('late A receipt never puts A text in B', await count(s.page) === 0);
        check('navigation never repeats A send', s.posted.length === 1);
      } finally { await s.close(); }
    }
    {
      const s = await scene('zh');
      try {
        await s.send(); s.replaceGrant(); await s.page.locator('#connection button').click();
        await wait(100); s.native('submitted'); await wait(150);
        check('changed authorization never echoes old input', await count(s.page) === 0);
        check('changed authorization never resends', s.posted.length === 1);
      } finally { await s.close(); }
    }
    for (const viewport of [{ width: 375, height: 667 }, { width: 430, height: 932 }]) {
      const s = await scene('zh', true, 5, viewport);
      const visible = () => s.page.locator('.thread .message:last-child .bubble').evaluate(e => {
        const r = e.getBoundingClientRect(), compose = document.querySelector('#compose').getBoundingClientRect();
        return r.top >= Math.max(0, document.querySelector('#top').getBoundingClientRect().bottom) && r.bottom <= compose.top;
      });
      try {
        await s.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        console.log(JSON.stringify(await s.page.evaluate(() => ({ viewport: innerHeight, receipts: document.querySelectorAll('.receipt').length, tail: document.querySelector('.thread .message:last-child .bubble').getBoundingClientRect().toJSON(), compose: document.querySelector('#compose').getBoundingClientRect().toJSON() }))));
        check(viewport.width + ' opens latest message above compose with five receipts', await visible());
        s.reply(); await s.page.evaluate(() => nawPhone.refresh());
        check(viewport.width + ' follows newest reply while reading the end', await visible());
        await s.page.evaluate(() => scrollTo(0, 400));
        const before = await s.page.evaluate(() => scrollY);
        await s.page.evaluate(() => nawPhone.refresh());
        check(viewport.width + ' refresh preserves earlier reading position', await s.page.evaluate(() => scrollY) === before);
        check(viewport.width + ' opening and refresh do not send', s.posted.length === 0);
      } finally { await s.close(); }
    }
    {
      const s = await scene('zh', true, 5, { width: 667, height: 375 }, 'SYNTHETIC_LATEST_REPLY\n合成最新回复的第二行。');
      try {
        const geometry = await s.page.locator('.thread .message:last-child .bubble').evaluate(e => {
          const r = e.getBoundingClientRect(), header = document.querySelector('#top').getBoundingClientRect(), compose = document.querySelector('#compose').getBoundingClientRect();
          const hit = [0.2, 0.5, 0.8].every(x => [0.2, 0.5, 0.8].every(y => { const at = document.elementFromPoint(r.left + x * r.width, r.top + y * r.height); return at === e || e.contains(at); }));
          return { height: r.height, top: r.top, bottom: r.bottom, header: header.bottom, compose: compose.top, hit };
        });
        console.log(JSON.stringify({ scenario: 'landscape two-line reply', ...geometry }));
        check('landscape regression has a real two-line latest reply', geometry.height > 40);
        check('landscape latest reply is fully visible between header and composer', geometry.top >= geometry.header && geometry.bottom <= geometry.compose && geometry.hit);
        const input = await s.page.locator('#message').evaluate(e => ({ height: e.getBoundingClientRect().height, font: parseFloat(getComputedStyle(e).fontSize) }));
        check('landscape input retains readable type and a touch-sized field', input.height >= 48 && input.font >= 16);
        check('landscape opening does not send', s.posted.length === 0);
      } finally { await s.close(); }
    }
    for (const earlier of [false, true]) {
      const s = await scene('zh', true), label = earlier ? 'reading earlier' : 'at bottom';
      const frames = () => s.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const geometry = () => s.page.evaluate(() => {
        const tail = document.querySelector('.thread .message:last-child .bubble').getBoundingClientRect();
        return { bottom: tail.bottom, height: tail.height, composeTop: document.querySelector('#compose').getBoundingClientRect().top,
          headerBottom: document.querySelector('#top').getBoundingClientRect().bottom, gap: document.documentElement.scrollHeight - innerHeight - scrollY };
      });
      try {
        await frames();
        if (earlier) await s.page.evaluate(() => scrollTo(0, 400));
        const before = await geometry();
        check(label + ' fixture starts at intended reading position', earlier ? before.gap > 80 : before.gap <= 2);
        await s.send('合成消息'.repeat(80)); s.native('submitted'); await until(() => s.held.length); await frames();
        const echoed = await geometry(); console.log(JSON.stringify({ scenario: label, phase: 'confirmed', ...echoed }));
        check(label + ' long confirmed message ends above compose', echoed.height > 190 && echoed.bottom <= echoed.composeTop + 1 && echoed.bottom >= echoed.headerBottom);
        await s.release(); await s.page.locator('.thread time[datetime="1970-01-01T00:00:00.001Z"]').waitFor();
        s.reply(); await s.page.evaluate(() => globalThis.nawPhone.refresh());
        await until(async () => await s.page.locator('.thread .bubble').filter({ hasText: 'SYNTHETIC_REPLY_AFTER_LONG' }).count() === 1); await frames();
        const reply = await geometry(); console.log(JSON.stringify({ scenario: label, phase: 'reply', ...reply }));
        check(label + ' later reply ends above compose', reply.bottom <= reply.composeTop + 1 && reply.bottom >= reply.headerBottom);
        check(label + ' long send is never repeated', s.posted.length === 1);
      } finally { await s.close(); }
    }
    check('no browser errors', errors.length === 0);
    const failed = results.filter(r => !r.pass); console.log(JSON.stringify({ pass: results.length - failed.length, fail: failed.length, skipped: 0 }));
    if (failed.length) process.exitCode = 1;
  } finally {
    await browser?.close();
  }
})().finally(testScratch.cleanup(async () => { await browser?.close(); })).catch(error => { console.error(error.stack); process.exitCode = 1; });
