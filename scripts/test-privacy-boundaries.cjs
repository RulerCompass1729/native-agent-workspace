// Actual rendered model content and network boundary, entirely on loopback.
// The local receiver contains no credentials or real user data.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const http = require('node:http'), assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { fork } = require('node:child_process'), { _electron } = require('playwright');
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const { connect } = require(path.join(code, 'app/service-client.cjs'));
const { readLayout } = require(path.join(code, 'app/service-layout.cjs'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-privacy-ui-'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const received = [], errors = [], checks = [];
const receiver = http.createServer((request, response) => { received.push(request.url); response.end('synthetic receiver'); });
receiver.on('upgrade', (request, socket) => { received.push(request.url); socket.destroy(); });
let app, page, child, client, sequence = 0;
async function until(check, label) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await delay(50); }
  throw Error(label);
}
function fixture(method, target, value) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const receive = message => { if (message.requestId === id) { clearTimeout(timer); child.off('message', receive); resolve(message); } };
    const timer = setTimeout(() => { child.off('message', receive); reject(Error('Fixture timeout')); }, 10000);
    child.on('message', receive); child.send({ id, method, target, value });
  });
}
async function run() {
  console.log('Synthetic privacy profile:', profile);
  await new Promise(resolve => receiver.listen(0, '127.0.0.1', resolve));
  const destination = `http://127.0.0.1:${receiver.address().port}`;
  const canary = path.join(profile, 'private-canary.svg');
  fs.writeFileSync(canary, '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><text>SYNTHETIC_PRIVATE_CANARY</text></svg>', { mode: 0o600 });
  const canaryUrl = pathToFileURL(canary).href, codeText = 'const synthetic = "copied";';
  child = fork(path.join(code, 'app/daemon.cjs'), [profile], {
    execArgv: ['--require', path.join(__dirname, 'fixtures/loading-terminal.cjs')],
    env: { ...process.env, NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_TEST_APP_ROOT: code, NAW_WORKSPACE: profile },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Private service');
  client = await connect(profile, 'privacy-test-observer');
  app = await _electron.launch({
    executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root],
    env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000,
  });
  page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ clipboard, shell }) => {
    globalThis.privacyProbe = { reads: 0, copies: [], links: [] };
    clipboard.readText = () => { globalThis.privacyProbe.reads++; return 'Synthetic explicit paste'; };
    clipboard.writeText = text => globalThis.privacyProbe.copies.push(text);
    shell.openExternal = async href => { globalThis.privacyProbe.links.push(href); };
  });
  // firstWindow can still be on the startup document. Instrument the loaded
  // product page so navigation does not discard the clipboard interceptor.
  await page.locator('#new-session').waitFor({ state: 'visible' });
  await page.evaluate(() => {
    window.browserClipboardProbe = { reads: 0, copies: [] };
    navigator.clipboard.readText = async () => { window.browserClipboardProbe.reads++; return 'Synthetic browser paste'; };
    navigator.clipboard.writeText = async text => { window.browserClipboardProbe.copies.push(text); };
  });
  await page.locator('#new-session').click();
  await page.locator('input[name="provider"][value="codex"]').check();
  await page.locator('#initial-view').selectOption('chat');
  await page.locator('#session-name').fill('隐私边界验证');
  await page.locator('#confirm-create').click();
  await until(async () => (await client.call('initial')).sessions[0]?.state === 'idle', 'Session ready');
  const id = (await client.call('initial')).sessions[0].id;
  const text = [
    '<script>window.syntheticScriptExecuted = true</script>',
    '<img src="invalid" onerror="window.syntheticScriptExecuted = true">',
    `![网络探针图片](${destination}/image?data=synthetic-only)`,
    '[不执行脚本](javascript:window.syntheticScriptExecuted=true)',
    `![不读取本机文件](${canaryUrl})`,
    `[明确打开测试链接](${destination}/explicit?data=synthetic-only)`,
    '```js\n' + codeText + '\n```',
  ].join('\n\n');
  await fixture('messageItem', id, { id: 'unsafe-markdown', text });
  const body = page.locator('[data-message-id="unsafe-markdown"] .message-body');
  await body.getByRole('link', { name: '明确打开测试链接', exact: true }).waitFor();
  await body.scrollIntoViewIfNeeded(); await delay(300);
  assert.equal(await page.evaluate(() => window.syntheticScriptExecuted), undefined);
  assert.equal(await body.locator('script, img[onerror], iframe, a[href^="javascript:"], img[src^="file:"]').count(), 0);
  assert.equal(await body.textContent().then(text => text.includes('SYNTHETIC_PRIVATE_CANARY')), false);
  assert.equal(await page.evaluate(url => fetch(url).then(response => response.ok ? 'unexpected' : 'rejected', () => 'rejected'), canaryUrl), 'rejected');
  assert.equal(await page.evaluate(() => typeof require), 'undefined');
  assert.equal(await page.evaluate(() => typeof process), 'undefined');
  assert.deepEqual(received, []);
  checks.push('Rendered HTML stays text; script stays inert and the owned local canary cannot load through Markdown image or fetch');
  const outcomes = await page.evaluate(async base => {
    const fetchResult = await fetch(base + '/fetch?data=synthetic-only').then(() => 'unexpected', () => 'blocked');
    const socketResult = await new Promise(resolve => {
      const socket = new WebSocket(base.replace('http:', 'ws:') + '/socket');
      const timer = setTimeout(() => { socket.close(); resolve('timeout'); }, 3000);
      socket.onopen = () => { clearTimeout(timer); socket.close(); resolve('unexpected'); };
      socket.onerror = () => { clearTimeout(timer); resolve('blocked'); };
    });
    navigator.sendBeacon(base + '/beacon', 'synthetic-only');
    return { fetchResult, socketResult };
  }, destination);
  assert.deepEqual(outcomes, { fetchResult: 'blocked', socketResult: 'blocked' });
  await delay(300); assert.deepEqual(received, []);
  let probe = await app.evaluate(() => globalThis.privacyProbe);
  assert.deepEqual(probe, { reads: 0, copies: [], links: [] });
  assert.deepEqual(await page.evaluate(() => window.browserClipboardProbe), { reads: 0, copies: [] });
  checks.push('Images, fetch, WebSocket and beacon cannot reach another loopback port; no automatic clipboard or browser action');
  await body.getByRole('link', { name: '明确打开测试链接', exact: true }).click();
  await until(async () => (await app.evaluate(() => globalThis.privacyProbe.links)).length === 1, 'Explicit link delegates once');
  assert.equal((await app.evaluate(() => globalThis.privacyProbe.links))[0], destination + '/explicit?data=synthetic-only');
  const rejected = await page.evaluate(async () => {
    try { await workspace.openExternal('file:///synthetic-private-file'); return false; } catch { return true; }
  });
  assert.equal(rejected, true); assert.equal((await app.evaluate(() => globalThis.privacyProbe.links)).length, 1);
  await page.locator('[data-message-id="unsafe-markdown"] .message-actions').getByRole('button', { name: '复制', exact: true }).click();
  assert.deepEqual((await app.evaluate(() => globalThis.privacyProbe.copies)), [text]);
  await body.getByRole('button', { name: '复制', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.browserClipboardProbe), { reads: 0, copies: [codeText] });
  await page.locator('#privacy-button').click();
  assert.ok((await page.locator('#trust-status').textContent()).includes('未报告；不能据此判断为零'));
  await page.locator('#refresh-trust').click(); await page.locator('#close-privacy').click();
  probe = await app.evaluate(() => globalThis.privacyProbe);
  assert.equal(probe.reads, 0); assert.deepEqual(received, []);
  const final = await client.call('initial');
  assert.equal(final.diagnostics.dispatches, 0);
  assert.equal((await fixture('stats')).sends.length, 0);
  await until(() => fs.existsSync(path.join(profile, 'workspace.json')), 'Local state');
  for (const filename of ['workspace.json', 'views.json', 'connection.json']) assert.equal(fs.statSync(path.join(profile, filename)).mode & 0o077, 0);
  checks.push('Message/code Copy and links delegate only on click; privacy refresh preserves zero dispatch and missing-usage disclosure; files remain private');
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ visible: w.isVisible(), focusable: w.isFocusable() })));
  assert.ok(windows.every(w => !w.visible && !w.focusable)); assert.deepEqual(errors, []);
  if (process.env.NAW_EVIDENCE_DIR) { fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true, mode: 0o700 }); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'privacy-boundaries.png') }); }
  console.log(JSON.stringify({ checks, received, errors, windows, modelTasks: 0, nativeProviderProcesses: 0, clipboard: 'intercepted; system clipboard untouched', externalBrowser: 'intercepted; not opened' }, null, 2));
}
run().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(async () => {
  if (app) await app.close();
  try {
    client?.close();
    if (readLayout(profile).entries.some(key => fs.existsSync(path.join(profile, key, 'connection.json')))) {
      client = await connect(profile, 'privacy-final-cleanup');
      try {
        const state = await client.call('initial'), entries = client.entries.map(e => ({ key: e.key, pid: e.state.servicePid }));
        for (const s of state.sessions) await client.call('stop', s.id);
        await client.call('shutdown');
        await until(() => entries.every(e => {
          if (fs.existsSync(path.join(profile, e.key, 'connection.json'))) return false;
          try { process.kill(e.pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
        }), 'All owned privacy-test services exited');
      } finally { client.close(); }
    }
  } finally {
    if (child?.connected) child.disconnect();
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    receiver.closeAllConnections(); receiver.close();
  }
});
