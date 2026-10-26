const testScratch = require('./fixtures/test-scratch.cjs');
const { createIn } = require('./fixtures/create-view.cjs');
// Actual hidden Electron, xterm and PTY process; no Claude/Codex model task.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { fork } = testScratch.childProcess;
const { _electron } = testScratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const { connect } = require(path.join(code, 'app/service-client.cjs'));
const profile = testScratch.directory(path.join(os.tmpdir(), 'naw-pty-input-'));
const child = fork(path.join(code, 'app/daemon.cjs'), [profile], { execArgv: ['--require', path.join(__dirname, 'fixtures/pty-echo.cjs')], env: { ...process.env, NAW_WORKSPACE: profile, NAW_TEST_APP_ROOT: code, NAW_APP_VERSION: require(path.join(code, 'package.json')).version }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let app, page, client; const errors = [], passed = [];
async function until(fn, label) { for (let i = 0; i < 200; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
const snapshot = () => page.evaluate(() => workspace.initial());
async function open() {
  app = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#new-session').waitFor();
}
async function text() {
  // Read rendered rows, including a terminal restored before firstWindow()
  // resolves. A late constructor tap would miss that already visible instance.
  return page.locator('#terminal-area .xterm-rows').evaluateAll(rows => rows.filter(el => el.checkVisibility()).map(el => el.innerText).join('\n'));
}
async function input(value) {
  const target = page.locator('#terminal-area .xterm-helper-textarea');
  await until(() => target.evaluate(el => document.activeElement === el), 'Current terminal focused');
  await page.keyboard.type(value);
  await until(async () => (await text()).includes(value), 'Actual native echo of typed line before Enter');
  await page.keyboard.press('Enter');
  await until(async () => (await text()).includes('RECEIVED:' + JSON.stringify(value)), 'Exact native received line');
}
async function shot(name) { if (process.env.NAW_EVIDENCE_DIR) { fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, name + '.png') }); } }
(async () => {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Service ready'); client = await connect(profile, 'pty-observer');
  await open(); await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="claude"]').check();
  await createIn(page, 'terminal');
  await until(async () => (await text()).includes('PTY ECHO READY'), 'Actual child ready');
  await input('/resume synthetic-history-id'); await input('快速输入-中文-🌳');
  const first = (await snapshot()).sessions[0], pid = first.pid;
  assert.ok(pid > 1); passed.push('ASCII slash text and Unicode reach the real PTY once, with exact visible echoes');
  await page.locator('#chat-tab').click(); await page.locator('#message-input').fill('图形草稿保持未发送');
  await page.getByRole('button', { name: '加入协作', exact: true }).click(); await page.getByRole('button', { name: '脱出协作', exact: true }).click();
  await page.locator('#terminal-tab').click(); await input('AFTER-VIEW-SWITCH'); await shot('pty-input');
  assert.equal((await snapshot()).sessions[0].pid, pid);
  await app.close(); app = null; await open(); await page.locator(`[data-session-id="${first.id}"]`).click();
  await until(async () => (await text()).includes('RECEIVED:"AFTER-VIEW-SWITCH"'), 'Same PTY history after reopening');
  await input('AFTER-REOPEN');
  const visible = await text(); for (const value of ['/resume synthetic-history-id', '快速输入-中文-🌳', 'AFTER-VIEW-SWITCH', 'AFTER-REOPEN']) assert.equal(visible.split('RECEIVED:' + JSON.stringify(value)).length - 1, 1);
  const state = await snapshot(); assert.equal(state.sessions[0].pid, pid); assert.equal(state.sessions[0].nativeId, first.nativeId);
  await page.locator('#chat-tab').click(); assert.equal(await page.locator('#message-input').inputValue(), '图形草稿保持未发送'); await shot('pty-reopened');
  passed.push('GUI/TUI, join/detach and app reopen keep the same real PTY and private draft without replay');
  assert.equal(state.diagnostics.dispatches, 0); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed, provider: 'local Python echo fixture', realPty: true, modelCalls: 0, errors, profile }, null, 2));
})().catch(async error => { console.error(error.stack); await shot('failure').catch(() => {}); process.exitCode = 1; }).finally(testScratch.cleanup(async () => {
  if (app) await app.close().catch(() => {});
  if (client) { try { for (const s of (await client.call('initial')).sessions) await client.call('stop', s.id); await client.call('shutdown'); } finally { client.close(); } }
  if (child.connected) child.disconnect();
}));
