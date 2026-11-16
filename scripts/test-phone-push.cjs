// Real isolated browser, HTTP handlers and service worker. Fake browser push
// subscription and owned loopback receiver; no real provider or push service.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { MobilePush } = require('../app/mobile-push.cjs'), { createMobileHandler } = require('../app/mobile-http.cjs');
const pictures = process.env.NAW_PUSH_PICTURES, evidence = process.env.NAW_EVIDENCE_DIR;
if (![pictures, evidence].every(p => p && path.isAbsolute(p))) throw Error('Private output paths required');
fs.mkdirSync(pictures, { recursive: true }); fs.mkdirSync(evidence, { recursive: true });
const key = crypto.createECDH('prime256v1'); key.generateKeys();
const wire = { endpoint: 'https://web.push.apple.com/synthetic', expirationTime: null,
  keys: { p256dh: key.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } };
let active = true, count = 1, offline = false, received = 0, push, browser, server;
const checks = [], errors = [];
function check(name, fn) { fn(); checks.push(name); console.log('PASS ' + name); }
async function main() {
  push = new MobilePush({ authority: () => active ? 'synthetic-device-generation' : null, count: () => count,
    transport: (details, guard) => new Promise((resolve, reject) => {
      if (offline || !guard.valid()) return reject(Error('Local offline fixture'));
      const req = http.request({ host: '127.0.0.1', port: server.address().port, path: '/fake-push', method: 'POST', headers: details.headers, signal: guard.signal }, res => { res.resume(); res.once('end', () => resolve(res.statusCode)); });
      req.once('error', reject); req.end(details.body);
    }) });
  const csrf = 'c'.repeat(43), deviceId = '00000000-0000-4000-8000-000000000001';
  const broker = { pair() { throw Error('No pairing in fixture'); }, session: () => ({ deviceId, csrf, expiresAt: Date.now() + 600000, workspace: true, sessions: [] }),
    read() {}, send() {}, answer() {}, receipt() {}, logout: () => { active = false; push.close(); return { authorizationRevoked: true }; },
    workspaceRead: async () => ({ sessions: [], rooms: [], confirmations: [], syncedAt: Date.now(), reminders: { count, records: [
      { record: 'operations', blocks: 31, bytes: 1048576, items: [{ kind: 'age', blocks: 31, level: 2, shown: true }] },
    ] } }), pushInfo: () => push.configuration(), pushAction: (_auth, value) => {
      if (!active) throw Error('Revoked');
      if (value.action === 'unsubscribe') { push.close(); return push.status(); }
      push.configuration(); push.subscribe(value.subscription); push.refresh(); return push.status();
    } };
  const handler = createMobileHandler({ broker, origin: 'https://phone.example.test', actor: 'synthetic-human' });
  server = http.createServer((req, res) => {
    if (req.url === '/fake-push') {
      const chunks = []; req.on('data', b => chunks.push(b)); req.on('end', () => {
        const payload = require('http_ece').decrypt(Buffer.concat(chunks), { version: 'aes128gcm', privateKey: key, authSecret: wire.keys.auth });
        assert.deepEqual(JSON.parse(payload), { count }); received++; res.writeHead(201); res.end();
      }); return;
    }
    // Synthetic private carrier: browser stays on trusted loopback; never TLS,
    // Tailscale or cookies from the person's real profile.
    const headers = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) if (!['host', 'origin', 'cookie', 'tailscale-user-login'].includes(req.rawHeaders[i].toLowerCase())) headers.push(req.rawHeaders[i], req.rawHeaders[i + 1]);
    req.rawHeaders = [...headers, 'Host', 'phone.example.test', 'Tailscale-User-Login', 'synthetic-human', 'Cookie', '__Host-naw-mobile=' + 'b'.repeat(43), ...(req.method === 'POST' ? ['Origin', 'https://phone.example.test'] : [])];
    handler(req, res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  let executablePath = process.env.NAW_BROWSER_EXECUTABLE || chromium.executablePath();
  if (!fs.existsSync(executablePath)) executablePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ executablePath, headless: true });
  for (const lang of ['zh', 'en']) for (const width of [390, 760]) {
    active = true; offline = false; count = 1; push.close(); const before = received;
    const context = await browser.newContext({ viewport: { width, height: 844 }, locale: lang === 'zh' ? 'zh-CN' : 'en-US' });
    await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    await context.addInitScript(wire => {
      window.__permissionCalls = 0; window.__subscriptionCalls = 0; window.__gesture = false;
      Object.defineProperty(Notification, 'requestPermission', { value: () => { window.__permissionCalls++; window.__gesture = navigator.userActivation.isActive; return Promise.resolve('granted'); } });
      let sub = null;
      Object.defineProperty(ServiceWorkerRegistration.prototype, 'pushManager', { get() { return {
        getSubscription: async () => sub,
        subscribe: async () => { window.__subscriptionCalls++; sub = { toJSON: () => wire, unsubscribe: async () => { sub = null; return true; } }; return sub; },
      }; } });
    }, wire);
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/mobile/#${lang}/reminders`);
    await page.locator('#push-toggle').waitFor();
    check(`${lang}/${width}: no automatic permission/subscription`, () => assert.equal(received, before));
    assert.deepEqual(await page.evaluate(() => [window.__permissionCalls, window.__subscriptionCalls, navigator.serviceWorker.controller]), [0, 0, null]);
    await page.screenshot({ path: path.join(pictures, `${lang}-${width}-off.png`), fullPage: true });
    await page.locator('#push-toggle').click();
    await page.locator('#push-toggle').filter({ hasText: lang === 'zh' ? '关闭提醒' : 'Disable reminders' }).waitFor();
    await page.locator('#connection').getByRole('button', { name: lang === 'zh' ? '刷新' : 'Refresh', exact: true }).click();
    await page.locator('#push-status').filter({ hasText: lang === 'zh' ? '已交给推送服务' : 'Accepted by the push service' }).waitFor();
    check(`${lang}/${width}: real SW and loopback encrypted count`, () => assert.equal(received, before + 1));
    assert.equal(await page.evaluate(() => window.__gesture), true);
    await page.screenshot({ path: path.join(pictures, `${lang}-${width}-accepted.png`), fullPage: true });
    offline = true; count = 2; await push.refresh();
    await page.locator('#connection').getByRole('button', { name: lang === 'zh' ? '刷新' : 'Refresh', exact: true }).click();
    await page.locator('#push-status').filter({ hasText: lang === 'zh' ? '提交未确认' : 'Submission unconfirmed' }).waitFor();
    await page.screenshot({ path: path.join(pictures, `${lang}-${width}-delayed.png`), fullPage: true });
    await page.locator('#push-toggle').click();
    await page.locator('#push-toggle').filter({ hasText: lang === 'zh' ? '开启提醒' : 'Enable reminders' }).waitFor();
    offline = false; count = 3; await push.refresh();
    check(`${lang}/${width}: disable stops further pushes`, () => assert.equal(received, before + 1));
    // A second enable uses the same Trusted Types policy and current key.
    await page.locator('#push-toggle').click();
    await page.locator('#push-toggle').filter({ hasText: lang === 'zh' ? '关闭提醒' : 'Disable reminders' }).waitFor();
    await page.locator('#top').getByRole('button', { name: lang === 'zh' ? '管理' : 'Manage', exact: true }).click();
    await page.getByRole('button', { name: lang === 'zh' ? '撤销此手机并退出' : 'Revoke this phone and sign out', exact: true }).click();
    await page.locator('#pair-code').waitFor();
    check(`${lang}/${width}: logout revokes push`, () => assert.equal(push.status().enabled, false));
    await context.close();
  }
  for (const lang of ['zh', 'en']) for (const mode of ['denied', 'unsupported']) {
    active = true; push.close(); count = 1; const before = received;
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    await context.addInitScript(mode => {
      if (mode === 'unsupported') Object.defineProperty(window, 'PushManager', { value: undefined });
      else Object.defineProperty(Notification, 'requestPermission', { value: () => Promise.resolve('denied') });
    }, mode);
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/mobile/#${lang}/reminders`);
    await page.locator('#push-card').waitFor();
    if (mode === 'denied') {
      await page.locator('#push-toggle').click();
      await page.locator('#push-status').filter({ hasText: lang === 'zh' ? '未允许' : 'was not granted' }).waitFor();
    } else assert.equal(await page.locator('#push-toggle').count(), 0);
    assert.equal(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length), 0);
    check(`${lang}: ${mode} creates no worker or push`, () => assert.equal(received, before));
    await page.screenshot({ path: path.join(pictures, `${lang}-390-${mode}.png`), fullPage: true });
    await context.close();
  }
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(evidence, 'browser-results.json'), JSON.stringify({ passed: checks.length, errors, realSubscriptions: 0, externalPushRequests: 0, localPayloads: received }, null, 2));
  console.log(`PHONE PUSH GUI: ${checks.length} pass, 0 fail; real subscriptions 0, external pushes 0`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => {
  push?.close(); await browser?.close();
  if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
});
