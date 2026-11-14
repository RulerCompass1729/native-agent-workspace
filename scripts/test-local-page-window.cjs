// Actual isolated source GUI: a page the profile declares opens in its own NAW window.
// Temporary pages on 127.0.0.1 only; hidden test windows; no model or provider runtime.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const scratch = require(path.join(root, 'scripts/fixtures/test-scratch.cjs'));
const { _electron } = scratch.playwright(require('playwright'));
const evidence = process.env.NAW_EVIDENCE_DIR;
if (evidence) {
  const target = path.resolve(evidence); let existing = target;
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  const destination = path.join(fs.realpathSync(existing), path.relative(existing, target));
  for (const base of [root, code].map(p => fs.realpathSync(p))) assert.ok(destination !== base && !destination.startsWith(base + path.sep));
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
}
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID();
try { fs.mkdirSync(slot); } catch (e) { if (e.code !== 'EEXIST') throw e; console.error('GUI slot occupied; nothing started.'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Claude 5', task: 'local page window acceptance', token, pid: process.pid, time: new Date().toISOString() }));
const profile = scratch.directory(path.join(os.tmpdir(), 'naw-local-page-'));
const workspacePath = path.join(profile, 'workspace'); fs.mkdirSync(workspacePath, { mode: 0o700 });
const child = scratch.childProcess.fork(path.join(code, 'app/daemon.cjs'), [profile], {
  env: { ...process.env, NAW_TEST_APP_ROOT: code, NAW_WORKSPACE: workspacePath, NAW_APP_VERSION: require(path.join(code, 'package.json')).version },
  stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
});
const checks = [], errors = [];
let app, page, failure = null;
const servers = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { for (let i = 0; i < 200; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
const check = text => { checks.push(text); console.log('PASS:', text); };
const sourceFiles = ['app/local-pages.cjs', 'app/main.cjs', 'app/preload.cjs', 'app/ui-messages.js', 'scripts/test-local-page-window.cjs'];
const sourceHashes = () => Object.fromEntries(sourceFiles.map(file => [file, require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(code, file))).digest('hex')]));
const sourceBefore = sourceHashes();

function serve(handler) {
  return new Promise(resolve => {
    const requests = [], server = http.createServer((req, res) => { requests.push(req.url); handler(req, res); });
    server.on('upgrade', (req, socket) => { requests.push(req.url); socket.destroy(); });
    servers.push(server); server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, requests }));
  });
}
const demoPage = tab => `<!doctype html><html><head><meta charset="utf-8"><title>Synthetic page ${tab}</title>
<style>body{font:15px -apple-system,sans-serif;margin:0}nav{display:flex;gap:4px;padding:8px;background:#eef}nav a{padding:6px 12px;border-radius:6px;background:#fff;text-decoration:none}nav a.on{background:#335;color:#fff}main{padding:24px}</style></head>
<body><nav>${['a', 'b', 'c'].map(t => `<a class="${t === tab ? 'on' : ''}" href="/?tab=${t}">Tab ${t.toUpperCase()}</a>`).join('')}</nav><main><h1 id="tab">Tab ${tab.toUpperCase()}</h1><p>Synthetic local page served on 127.0.0.1 for the window test.</p></main></body></html>`;

async function run() {
  const other = await serve((_req, res) => { res.writeHead(200); res.end('other origin'); });
  const demo = await serve((req, res) => {
    if (req.url.startsWith('/api')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return; }
    if (req.url.startsWith('/hop')) { res.writeHead(302, { location: `http://127.0.0.1:${other.port}${req.url.replace('/hop', '/hopped')}` }); res.end(); return; }
    const tab = new URL(req.url, 'http://x').searchParams.get('tab') || 'a';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(demoPage(tab));
  });
  const closed = await serve(() => {}); await new Promise(resolve => servers.pop().close(resolve));
  fs.writeFileSync(path.join(profile, 'local-pages.json'), JSON.stringify({ pages: [
    { id: 'demo', title: 'Synthetic page', url: `http://127.0.0.1:${demo.port}/` },
    { id: 'down', title: 'Stopped page', url: `http://127.0.0.1:${closed.port}/` },
  ] }), { mode: 0o600 });
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Owned service ready');
  app = await _electron.launch({ executablePath: require('electron'), args: [code], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#new-session').waitFor({ timeout: 60000 });
  await app.evaluate(({ shell }) => { globalThis.externalOpened = []; shell.openExternal = async url => { globalThis.externalOpened.push(url); }; });
  const browserWindows = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  assert.equal(await browserWindows(), 1);

  // 1. The plugin's call opens one separate window on the declared page and path.
  const opened = app.waitForEvent('window');
  const result = await page.evaluate(() => workspace.openLocalPage('demo', '/?tab=b'));
  const local = await opened;
  assert.deepEqual(result, { id: 'demo', url: `http://127.0.0.1:${demo.port}/?tab=b`, reused: false });
  await local.locator('#tab').waitFor(); assert.equal(await local.locator('#tab').innerText(), 'Tab B');
  assert.equal(await browserWindows(), 2);
  const info = await app.evaluate(({ BrowserWindow, session }, port) => {
    const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith(`http://127.0.0.1:${port}/`)), prefs = win.webContents.getLastWebPreferences();
    return { title: win.getTitle(), partition: win.webContents.session === session.defaultSession ? 'default' : 'separate', preload: prefs.preload || null, sandbox: prefs.sandbox, contextIsolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration, webrtc: win.webContents.getWebRTCIPHandlingPolicy() };
  }, demo.port);
  assert.deepEqual(info, { title: 'Synthetic page', partition: 'separate', preload: null, sandbox: true, contextIsolation: true, nodeIntegration: false, webrtc: 'disable_non_proxied_udp' });
  check('openLocalPage(demo, /?tab=b) opens one separate window on the declared origin, titled by the declaration, outside the main session, WebRTC off direct UDP');

  // 2. No bridge, no Node in the page; permissions refused.
  assert.deepEqual(await local.evaluate(async () => ({ workspace: typeof window.workspace, locale: typeof window.__DSH_LOCALE__, require: typeof require, process: typeof process,
    notification: await Notification.requestPermission(), geolocation: (await navigator.permissions.query({ name: 'geolocation' })).state })),
  { workspace: 'undefined', locale: 'undefined', require: 'undefined', process: 'undefined', notification: 'denied', geolocation: 'denied' });
  check('The page has no window.workspace, no locale bridge, no require/process; notification and geolocation are denied');

  // 3. Requests reach only the declared origin.
  const fetched = await local.evaluate(async otherPort => ({
    same: await fetch('/api/x').then(r => r.json()).then(j => j.ok, () => 'blocked'),
    other: await fetch(`http://127.0.0.1:${otherPort}/leak`).then(() => 'reached', () => 'blocked'),
    localhost: await fetch(`http://localhost:${otherPort}/leak`).then(() => 'reached', () => 'blocked'),
    remote: await fetch('https://example.com/').then(() => 'reached', () => 'blocked'),
  }), other.port);
  assert.deepEqual(fetched, { same: true, other: 'blocked', localhost: 'blocked', remote: 'blocked' });
  // A same-origin address that redirects elsewhere, a frame and a WebSocket on another port.
  assert.equal(await local.evaluate(() => fetch('/hop-fetch').then(() => 'reached', () => 'blocked')), 'blocked');
  await local.evaluate(otherPort => {
    const frame = document.createElement('iframe'); frame.src = `http://127.0.0.1:${otherPort}/frame`; document.body.append(frame);
    const socket = new WebSocket(`ws://127.0.0.1:${otherPort}/socket`); socket.onerror = () => {};
  }, other.port);
  await delay(800);
  assert.deepEqual(other.requests, []);
  check('fetch: same origin works; another local port, localhost, a remote host, a cross-origin redirect, a frame and a WebSocket elsewhere are cancelled');

  // 4. Top-level navigation to another origin is blocked; same-origin links work.
  await local.evaluate(otherPort => { location.href = `http://127.0.0.1:${otherPort}/navigate`; }, other.port);
  await delay(600);
  assert.equal(await local.evaluate(() => location.href), `http://127.0.0.1:${demo.port}/?tab=b`);
  assert.equal(await app.evaluate(({ BrowserWindow }, port) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith(`http://127.0.0.1:${port}/`)).webContents.isLoading(), demo.port), false);
  // Playwright keeps waiting for the cancelled navigation, so the link is clicked in the page.
  await local.evaluate(() => [...document.querySelectorAll('nav a')].find(a => a.textContent === 'Tab C').click());
  await until(async () => (await local.locator('#tab').innerText()) === 'Tab C', 'Same-origin link');
  assert.deepEqual(other.requests, []);
  check('location to another origin stays on the page; a same-origin tab link navigates; the other server received 0 requests');

  // 5. window.open goes to the system browser, no new window.
  await local.evaluate(() => { window.open('https://example.com/doc', '_blank'); window.open('file:///etc/hosts'); });
  await until(async () => (await app.evaluate(() => globalThis.externalOpened.length)) === 1, 'External link handed over');
  await delay(300);
  assert.deepEqual(await app.evaluate(() => globalThis.externalOpened), ['https://example.com/doc']);
  assert.equal(await browserWindows(), 2);
  check('window.open(https) goes to the system browser (stubbed), file: is dropped, no new window');

  // 6. The same id reuses the window and moves it to the new path.
  assert.deepEqual(await page.evaluate(() => workspace.openLocalPage('demo', '/?tab=a')), { id: 'demo', url: `http://127.0.0.1:${demo.port}/?tab=a`, reused: true });
  await until(async () => (await local.locator('#tab').innerText().catch(() => '')) === 'Tab A', 'Reused window moved');
  assert.equal(await browserWindows(), 2);
  if (evidence) await local.screenshot({ path: path.join(evidence, '01-local-page-window.png') });
  check('A second call with the same id focuses the same window and moves it to /?tab=a');

  // 7. Refusals reach the plugin as one-sentence reasons.
  const refusal = (...args) => page.evaluate(args => workspace.openLocalPage(...args).then(() => null, e => ({ key: e.uiMessage?.key, message: e.message })), args);
  for (const [args, key] of [[['demo', `http://127.0.0.1:${other.port}/`], 'error.localPage.path'], [['demo', '//example.com/'], 'error.localPage.path'], [['missing'], 'error.localPage.unknown']]) {
    const r = await refusal(...args); assert.equal(r.key, key); assert.ok(r.message.length > 5 && !r.message.includes('\n'));
  }
  assert.equal(await browserWindows(), 2);
  check('A raw URL, a protocol-relative path and an unknown id reject with a one-sentence reason and open nothing');

  // 8. The main window keeps its own filter: it still cannot reach the local page's origin.
  assert.equal(await page.evaluate(port => fetch(`http://127.0.0.1:${port}/from-main`).then(() => 'reached', () => 'blocked'), demo.port), 'blocked');
  assert.equal(demo.requests.includes('/from-main'), false);
  check('The main window still cannot reach the declared origin (its request filter is unchanged)');

  // 9. A top-level same-origin address that redirects elsewhere ends on the explanation, not the other origin.
  await local.evaluate(() => { location.href = '/hop-page'; });
  await until(async () => /打不开|Cannot open/u.test(await local.locator('body').innerText().catch(() => '')), 'Redirect stopped');
  assert.equal(await local.evaluate(() => location.protocol), 'data:');
  assert.ok(demo.requests.includes('/hop-page'));
  assert.deepEqual(other.requests, []);
  check('A top-level redirect to another origin is cancelled and the window explains it; the other server received 0 requests');

  // 10. A page with no service says so in the window.
  const downOpened = app.waitForEvent('window');
  await page.evaluate(() => workspace.openLocalPage('down'));
  const down = await downOpened;
  await until(async () => /打不开|Cannot open/u.test(await down.locator('body').innerText().catch(() => '')), 'Unavailable message');
  const downText = await down.locator('body').innerText();
  assert.match(downText, new RegExp(`127\\.0\\.0\\.1:${closed.port}`, 'u'));
  assert.equal(await down.locator('a').getAttribute('href'), `http://127.0.0.1:${closed.port}/`);
  if (evidence) await down.screenshot({ path: path.join(evidence, '02-page-unavailable.png') });
  check('A declared page with nothing listening shows the reason and a retry link instead of a blank window');

  // 11. Size and position are remembered per page.
  await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows().find(w => w.getTitle() === 'Synthetic page'); win.setBounds({ x: 120, y: 140, width: 900, height: 640 }); win.close(); });
  await until(async () => (await browserWindows()) === 2, 'Demo window closed');
  const reopened = app.waitForEvent('window');
  await page.evaluate(() => workspace.openLocalPage('demo'));
  await reopened;
  const bounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.getTitle() === 'Synthetic page').getBounds());
  assert.deepEqual(bounds, { x: 120, y: 140, width: 900, height: 640 });
  check('Closing and reopening the page restores its saved size and position');
  assert.deepEqual(errors, []);
}
run().catch(async e => { failure = e.stack; process.exitCode = 1; console.error(e.stack); if (page && evidence) await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {}); }).finally(async () => {
  try {
    for (const server of servers) await new Promise(resolve => server.close(resolve));
    const sourceAfter = sourceHashes();
    if (JSON.stringify(sourceAfter) !== JSON.stringify(sourceBefore)) { failure ||= 'Source changed'; process.exitCode = 1; }
    if (evidence) fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ flowPassed: !failure, failure, checks, errors, sourceBefore, sourceAfter, token }, null, 2));
    await scratch.release();
    const held = JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))); assert.equal(held.token, token);
    fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot);
    console.log(failure ? 'FAILED' : `ALL ${checks.length} CHECKS PASSED`, 'profile removed:', !fs.existsSync(profile));
  } catch (e) { console.error(e.stack); process.exitCode = 1; }
});
