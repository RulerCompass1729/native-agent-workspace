// Synthetic HTTP boundaries, actual phone scripts and WebKit; no native provider.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { webkit, devices } = require('playwright');
const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '..');
const results = [], errors = [], wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-send-')), identity = fs.statSync(scratch);
const check = (name, pass) => { results.push({ name, pass: Boolean(pass) }); console.log(JSON.stringify(results.at(-1))); };
async function until(fn) { for (let i = 0; i < 200; i++) { if (await fn()) return; await wait(10); } throw Error('Synthetic phone did not settle'); }
let browser;
async function scene(lang) {
  const context = await browser.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' }), page = await context.newPage();
  const sessions = ['a', 'b'].map(id => ({ id, name: 'Synthetic ' + id, provider: 'claude', state: 'idle', available: true, actions: ['read', 'send'] }));
  let generation = 0, hold = false, releaseNative, releaseWorkspace;
  const messages = [];
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
    } else if (url.pathname === '/mobile/workspace') {
      data = { sessions: sessions.map(s => ({ ...s, messages: s.id === 'a' ? [...messages] : [] })), rooms: [], confirmations: [], reminders: { count: 0, records: [] }, capabilities: { push: false }, syncedAt: 1 };
      if (hold) { held.push(route); await new Promise(resolve => { releaseWorkspace = resolve; }); }
    }
    if (data) return route.fulfill({ json: data }).catch(() => {});
    const name = url.pathname === '/mobile/' ? 'index.html' : url.pathname.slice('/mobile/'.length);
    if (!['index.html', 'client.js', 'workspace.js', 'passkeys.js', 'push.js', 'style.css', 'manifest.webmanifest'].includes(name)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.html') ? 'text/html' : 'application/json', body: fs.readFileSync(path.join(root, 'app/mobile-web', name)) });
  });
  await page.goto('https://phone.invalid/mobile/#' + lang + '/home');
  await page.waitForFunction(() => document.documentElement.dataset.loading === 'false' && document.querySelector('#content a[href$="/chat/a"]'));
  await page.locator(`#content a[href="#${lang}/chat/a"]`).click();
  await page.waitForFunction(() => document.documentElement.dataset.loading === 'false' && document.querySelector('#message'));
  return { page, posted, held, async send() { await page.locator('#message').fill('SYNTHETIC_ORIGINAL'); await page.locator('#send-message').tap(); await until(() => releaseNative); },
    native(status) { releaseNative(status); }, replaceGrant() { generation++; },
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
        const response = s.page.waitForResponse(r => r.url().endsWith('/mobile/workspace')); await s.release(); await (await response).finished(); await wait(100);
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
    check('no browser errors', errors.length === 0);
    const failed = results.filter(r => !r.pass); console.log(JSON.stringify({ pass: results.length - failed.length, fail: failed.length, skipped: 0 }));
    if (failed.length) process.exitCode = 1;
  } finally {
    await browser?.close();
    const stat = fs.lstatSync(scratch);
    if (stat.uid !== process.getuid() || stat.dev !== identity.dev || stat.ino !== identity.ino || stat.isSymbolicLink()) throw Error('Synthetic scratch identity changed');
    fs.rmSync(scratch, { recursive: true });
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
