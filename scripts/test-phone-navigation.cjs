// Synthetic browser transport; no pairing, provider, or daily profile.
const fs = require('node:fs'), path = require('node:path');
const { devices, ...browsers } = require('playwright');
const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '..');
const engine = process.env.NAW_NAV_ENGINE || 'webkit', results = [], errors = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let i = 0; i < 100; i++) { if (await fn()) return; await wait(20); } throw Error('Synthetic navigation did not settle'); }
const check = (name, pass, actual) => { results.push({ name, pass: Boolean(pass), actual }); console.log(JSON.stringify(results.at(-1))); };
const sessions = ['claude', 'codex'].map(id => ({ id, nativeId: 'native-' + id, provider: id, name: 'Synthetic ' + id, available: true, state: 'idle', messages: [] }));
let browser;
async function scene(language, options = {}) {
  const context = await browser.newContext({ ...devices['iPhone 13'], locale: language === 'zh' ? 'zh-CN' : 'en-US', serviceWorkers: 'block' });
  const page = await context.newPage(), held = [], writes = [];
  let hold = options.deep ? '/mobile/read/claude' : null;
  page.on('pageerror', e => errors.push(e.message));
  const row = id => ({ id, contextId: 'B'.repeat(43), canSend: true, messages: [], question: null });
  const session = { deviceId: '00000000-0000-4000-8000-000000000001', csrf: 'A'.repeat(43), sessions, workspace: true };
  const workspace = { sessions, rooms: [], confirmations: [], reminders: { count: 0, records: [] }, capabilities: { push: false }, syncedAt: 1 };
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== 'https://phone.invalid') { errors.push('Unexpected external request'); return route.abort(); }
    if (request.method() === 'POST') writes.push(url.pathname);
    const data = url.pathname === '/mobile/session' ? session : (url.pathname === '/mobile/workspace' || /^\/mobile\/workspace\/(summary|session\/[^/]+|room\/[^/]+)$/.test(url.pathname)) ? workspace :
      url.pathname.startsWith('/mobile/read/') ? row(decodeURIComponent(url.pathname.slice('/mobile/read/'.length))) :
      url.pathname === '/mobile/send' ? { requestId: request.postDataJSON().requestId, sessionId: 'claude', action: 'send', status: 'submitted' } : null;
    const fulfill = () => data ? route.fulfill({ json: data }) : route.fulfill({ status: 404, body: '' });
    if ((url.pathname === hold || hold === '/mobile/workspace' && /^\/mobile\/workspace\//.test(url.pathname))) { held.push({ route, fulfill }); return; }
    if (data) return fulfill();
    const file = url.pathname === '/mobile/' ? 'index.html' : url.pathname.slice('/mobile/'.length);
    if (!['index.html', 'client.js', 'workspace.js', 'passkeys.js', 'push.js', 'style.css', 'manifest.webmanifest'].includes(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'application/json', body: fs.readFileSync(path.join(root, 'app/mobile-web', file)) });
  });
  await page.goto('https://phone.invalid/mobile/#' + language + (options.deep ? '/chat/claude' : '/home'));
  if (options.deep) await until(() => held.length);
  else await page.waitForFunction(() => document.documentElement.dataset.loading === 'false' && document.querySelector('#content a[href$="/chat/claude"]'));
  return { page, writes, held, hold(value) { hold = value; }, async release(only) {
    if (!only) hold = null;
    for (const item of [...held]) if (!only || new URL(item.route.request().url()).pathname === only) { held.splice(held.indexOf(item), 1); await item.fulfill(); }
  },
    async close() { for (const item of held.splice(0)) await item.route.abort().catch(() => {}); await context.close(); } };
}
async function back(s, language, name) {
  const link = s.page.locator(`#top a[href="#${language}/home"]`);
  const hit = await link.evaluate(e => { const r = e.getBoundingClientRect(), p = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return r.y >= 0 && r.bottom <= innerHeight && (p === e || e.contains(p)); });
  check(name + ' back control receives touch', hit);
  await link.tap();
  await s.page.waitForFunction(() => document.documentElement.dataset.page === 'home', null, { timeout: 1000 }).catch(() => {});
  const actual = await s.page.evaluate(() => ({ hash: location.hash, page: document.documentElement.dataset.page }));
  check(name + ' returns home before the old response', actual.page === 'home' && actual.hash === '#' + language + '/home', actual);
}
(async () => {
  try {
    browser = await browsers[engine].launch({ headless: true, ...(process.env.NAW_BROWSER_EXECUTABLE ? { executablePath: process.env.NAW_BROWSER_EXECUTABLE } : {}) });
    for (const language of ['zh', 'en']) {
      for (const id of ['claude', 'codex']) for (const stalled of ['read', 'session', 'workspace', 'none']) {
        const s = await scene(language), name = `${engine} ${language} ${id} ${stalled}`;
        try {
          if (stalled !== 'none') s.hold(stalled === 'read' ? '/mobile/read/' + id : '/mobile/' + stalled);
          await s.page.locator(`#content a[href="#${language}/chat/${id}"]`).tap();
          await s.page.waitForFunction(() => document.documentElement.dataset.page === 'chat');
          if (stalled !== 'none') await until(() => s.held.length);
          else await s.page.waitForFunction(() => document.documentElement.dataset.loading === 'false');
          await s.page.locator('#message').fill('Synthetic draft ' + id);
          await back(s, language, name);
          await s.release();
          await s.page.waitForFunction(() => document.documentElement.dataset.page === 'home');
          await s.page.locator(`#content a[href="#${language}/chat/${id}"]`).tap();
          await s.page.waitForFunction(() => document.documentElement.dataset.loading === 'false');
          check(name + ' keeps the draft after returning', await s.page.locator('#message').inputValue() === 'Synthetic draft ' + id);
          check(name + ' has no writes', s.writes.length === 0);
        } finally { await s.close(); }
      }
      const deep = await scene(language, { deep: true });
      try { await back(deep, language, `${engine} ${language} initial deep read`); } finally { await deep.close(); }
      const changing = await scene(language);
      try {
        changing.hold('/mobile/read/claude'); await changing.page.locator(`#content a[href="#${language}/chat/claude"]`).tap();
        await until(() => changing.held.length);
        await back(changing, language, `${engine} ${language} superseded read`);
        changing.hold('/mobile/read/codex'); await changing.page.evaluate(lang => { location.hash = '#' + lang + '/chat/codex'; }, language);
        await changing.page.waitForTimeout(100);
        check(`${engine} ${language} next route starts before the old read`, await changing.page.evaluate(() => nawPhone.client.state.selected === 'codex'));
        await changing.release('/mobile/read/claude');
        await until(() => changing.held.some(r => r.route.request().url().endsWith('/mobile/read/codex')));
        await changing.page.waitForTimeout(100);
        check(`${engine} ${language} stale completion cannot finish the current loading state`, await changing.page.evaluate(() => document.documentElement.dataset.loading === 'true'));
        await changing.release(); await changing.page.waitForFunction(() => document.documentElement.dataset.loading === 'false');
        check(`${engine} ${language} the latest route remains selected`, await changing.page.evaluate(() => nawPhone.client.state.selected === 'codex' && location.hash.endsWith('/chat/codex')));
      } finally { await changing.close(); }
      const s = await scene(language);
      try {
        await s.page.locator(`#content a[href="#${language}/chat/claude"]`).tap();
        await s.page.waitForFunction(() => document.documentElement.dataset.loading === 'false');
        await s.page.locator('#message').fill('Synthetic original send'); s.hold('/mobile/send');
        await s.page.locator('#send-message').tap(); await until(() => s.held.length);
        await back(s, language, `${engine} ${language} pending send`);
        await s.page.locator(`#content a[href="#${language}/chat/codex"]`).tap();
        await s.page.waitForFunction(() => document.documentElement.dataset.loading === 'false');
        await s.page.locator('#message').fill('Synthetic other draft');
        await s.release(); await until(() => s.page.evaluate(() => !nawPhone.client.state.busy));
        check(`${engine} ${language} late acknowledgement preserves the other draft`, await s.page.locator('#message').inputValue() === 'Synthetic other draft');
        check(`${engine} ${language} sends exactly once without navigation replay`, s.writes.length === 1 && s.writes[0] === '/mobile/send');
      } finally { await s.close(); }
    }
    check(engine + ' no page errors or external requests', errors.length === 0, errors);
  } finally { if (browser) await browser.close(); }
  const summary = { pass: results.filter(r => r.pass).length, fail: results.filter(r => !r.pass).length, skipped: 0, engine };
  console.log('SUMMARY ' + JSON.stringify(summary));
  if (process.env.NAW_EVIDENCE_DIR) fs.writeFileSync(path.join(process.env.NAW_EVIDENCE_DIR, engine + '-results.json'), JSON.stringify({ results, errors, summary }, null, 2));
  process.exitCode = summary.fail ? 1 : 0;
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
