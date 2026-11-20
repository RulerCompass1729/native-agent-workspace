// Actual phone UI, isolated WebKit, synthetic HTTP and no provider runtime.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const scratch = require('./fixtures/test-scratch.cjs');
const { webkit, devices } = require('playwright');
const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '..');
const home = scratch.directory(path.join(os.tmpdir(), 'naw-f-phone-connection-'));
const results = [], errors = [];
const check = (name, pass) => { results.push({ name, pass: Boolean(pass) }); console.log(JSON.stringify(results.at(-1))); };
let browser;
async function scene(lang) {
  const context = await browser.newContext({ ...devices['iPhone 13'], viewport: { width: 375, height: 667 }, serviceWorkers: 'block' });
  const page = await context.newPage(), writes = [];
  let offline = false, failWorkspace = false, holdWorkspace = false, releaseWorkspace;
  const sessions = [{ id: 'one', name: 'Synthetic session', provider: 'claude', available: true, state: 'idle', actions: ['read', 'send'] }];
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== 'https://phone.invalid') { errors.push('external-request'); return route.abort(); }
    if (offline || failWorkspace && url.pathname === '/mobile/workspace') return route.abort('internetdisconnected');
    let data;
    if (url.pathname === '/mobile/session') data = { deviceId: '00000000-0000-4000-8000-000000000001', csrf: 'C'.repeat(43), workspace: true, sessions };
    else if (url.pathname === '/mobile/read/one') data = { id: 'one', contextId: 'B'.repeat(43), canSend: true, sendMode: 'send', question: null, messages: [] };
    else if (url.pathname === '/mobile/send') {
      writes.push(request.postDataJSON()); data = { requestId: writes.at(-1).requestId, sessionId: 'one', action: 'send', status: 'unconfirmed' };
    } else if (url.pathname === '/mobile/workspace') {
      if (holdWorkspace) await new Promise(resolve => { releaseWorkspace = resolve; });
      data = { sessions: sessions.map(s => ({ ...s, messages: [] })), rooms: [], confirmations: [], reminders: null, capabilities: { push: false } };
    }
    if (data) return route.fulfill({ json: data }).catch(() => {});
    const file = url.pathname === '/mobile/' ? 'index.html' : url.pathname.slice('/mobile/'.length);
    if (!['index.html', 'client.js', 'workspace.js', 'passkeys.js', 'push.js', 'style.css', 'manifest.webmanifest'].includes(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'application/json', body: fs.readFileSync(path.join(root, 'app/mobile-web', file)) });
  });
  await page.goto('https://phone.invalid/mobile/#' + lang + '/chat/one');
  await page.waitForFunction(() => document.documentElement.dataset.loading === 'false' && document.querySelector('#message'));
  return { page, writes, setOffline(value) { offline = value; }, failWorkspace(value) { failWorkspace = value; },
    async refresh() { await page.evaluate(() => nawPhone.refresh()); },
    async heldRefresh() { holdWorkspace = true; await page.evaluate(() => { globalThis.testRefresh = nawPhone.refresh(); }); for (let i = 0; !releaseWorkspace && i < 200; i++) await page.waitForTimeout(10); if (!releaseWorkspace) throw Error('Workspace read did not start'); },
    async release() { holdWorkspace = false; releaseWorkspace?.(); await page.evaluate(() => testRefresh); },
    async close() { releaseWorkspace?.(); await context.close(); } };
}
(async () => {
  try {
    browser = await webkit.launch({ headless: true, executablePath: process.env.NAW_BROWSER_EXECUTABLE, env: { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: home } });
    for (const lang of ['zh', 'en']) {
      const s = await scene(lang), closeName = lang === 'zh' ? '关闭提示' : 'Dismiss notification';
      try {
        await s.page.locator('#message').fill('SYNTHETIC_DRAFT'); s.setOffline(true); await s.refresh();
        check(lang + ' failure shows offline feedback', await s.page.locator('#toast').isVisible());
        const close = s.page.locator('#toast').getByRole('button', { name: closeName, exact: true });
        check(lang + ' feedback has a close control', await close.count() === 1);
        if (await close.count()) {
          const box = await close.boundingBox();
          check(lang + ' close does not cover the composer', box.y + box.height <= (await s.page.locator('#compose').boundingBox()).y);
          check(lang + ' close receives touch at phone size', box.width >= 44 && box.height >= 44);
          await close.tap(); check(lang + ' touch closes only the feedback', await s.page.locator('#toast').isHidden() && await s.page.locator('#message').inputValue() === 'SYNTHETIC_DRAFT' && s.writes.length === 0);
          await s.refresh(); await close.focus(); await s.page.keyboard.press('Enter'); check(lang + ' keyboard also dismisses feedback', await s.page.locator('#toast').isHidden());
          await s.refresh();
        }
        s.setOffline(false); s.failWorkspace(true); await s.refresh();
        check(lang + ' a partial failed refresh keeps offline feedback', await s.page.locator('#toast').isVisible());
        s.failWorkspace(false); await s.refresh();
        check(lang + ' a successful full refresh clears old offline feedback', await s.page.locator('#toast').isHidden());
        check(lang + ' reconnect keeps draft and never sends', await s.page.locator('#message').inputValue() === 'SYNTHETIC_DRAFT' && s.writes.length === 0);
        s.setOffline(true); await s.refresh(); s.setOffline(false); await s.heldRefresh();
        if (await close.count()) await close.tap();
        await s.page.locator('#send-message').tap();
        await s.page.waitForFunction(() => !nawPhone.client.state.busy && nawPhone.client.state.pending.some(p => p.status === 'unconfirmed'));
        await s.release();
        check(lang + ' an older refresh preserves newer unconfirmed feedback', await s.page.locator('#toast').isVisible() && (await s.page.locator('#toast').innerText()).includes(lang === 'zh' ? '未确认' : 'unconfirmed'));
        if (await close.count()) await close.tap();
        check(lang + ' closing never forgets uncertain receipt or draft', await s.page.locator('.receipt').count() === 1 && await s.page.locator('#message').inputValue() === 'SYNTHETIC_DRAFT');
        await s.refresh(); check(lang + ' no automatic resend after reconnect or dismiss', s.writes.length === 1);
      } finally { await s.close(); }
    }
    check('no page errors or external requests', errors.length === 0);
  } finally { await browser?.close(); }
  console.log(JSON.stringify({ pass: results.filter(r => r.pass).length, fail: results.filter(r => !r.pass).length }));
  process.exitCode = results.some(r => !r.pass) ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(scratch.cleanup());
