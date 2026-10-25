const testScratch = require('./fixtures/test-scratch.cjs');
// Real Electron controls with synthetic native protocol events; no provider/model.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { fork } = testScratch.childProcess, { _electron } = testScratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const profile = testScratch.directory(path.join(os.tmpdir(), 'naw-confirmation-ui-'));
const child = fork(path.join(code, 'app/daemon.cjs'), [profile], {
  execArgv: ['--require', path.join(__dirname, 'fixtures/reconnect-native.cjs')],
  env: { ...process.env, NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_WORKSPACE: profile, NAW_TEST_APP_ROOT: code },
  stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms)), checks = [], errors = [];
const evidence = process.env.NAW_EVIDENCE_DIR;
let app, page, sequence = 0;
async function until(fn, label) { for (let n = 0; n < 160; n++) { if (await fn()) return; await delay(50); } throw Error(label); }
function fixture(method, target, value) { const id = ++sequence; return new Promise((resolve, reject) => {
  const receive = result => { if (result.requestId === id) { clearTimeout(timer); child.off('message', receive); resolve(result); } };
  const timer = setTimeout(() => { child.off('message', receive); reject(Error('Fixture timeout')); }, 8000);
  child.on('message', receive); child.send({ id, method, target, value });
}); }
const snapshot = () => page.evaluate(() => workspace.initial());
const event = (target, value) => fixture('event', target, value);
const request = (target, id, command) => event(target, { id, method: 'item/commandExecution/requestApproval', params: { command, cwd: '/synthetic', reason: '合成权限检查，不执行命令' } });
const resolve = (target, requestId) => event(target, { method: 'serverRequest/resolved', params: { requestId } });
async function shot(name) { if (evidence) await page.screenshot({ path: path.join(evidence, name + '.png') }); }
async function run() {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Service ready');
  if (evidence) fs.mkdirSync(evidence, { recursive: true });
  app = await _electron.launch({
    executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'),
    args: process.env.NAW_APP_EXECUTABLE ? [] : [root],
    env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) },
    timeout: 70000,
  });
  page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  await page.locator('#new-session').waitFor({ timeout: 60000 });
  await page.locator('#new-session').click();
  await page.locator('input[name="provider"][value="codex"]').check();
  await page.locator('#initial-view').selectOption('chat'); await page.locator('#session-name').fill('原生确认同步');
  await page.locator('#confirm-create').click();
  await until(async () => (await snapshot()).sessions[0]?.state === 'idle', 'Session ready');
  const id = (await snapshot()).sessions[0].id;
  if (process.env.NAW_NATIVE_CLOSED_TRIAL === '1') {
    const before = (await snapshot()).sessions[0];
    await page.locator('#message-input').fill('Draft retained after native closure.');
    await event(id, { method: 'thread/closed', params: { threadId: before.nativeId } });
    await until(async () => (await snapshot()).sessions[0].state === 'ended', 'Native thread closure reaches the original GUI row');
    assert.match(await page.locator('#session-status').innerText(), /已结束/);
    const ended = await snapshot();
    assert.equal(ended.sessions[0].nativeId, before.nativeId);
    assert.equal(await page.locator('#message-input').inputValue(), 'Draft retained after native closure.');
    assert.equal((await fixture('inspect')).calls.some(c => ['turn/start', 'turn/steer'].includes(c.method)), false);
    assert.equal(ended.diagnostics.dispatches, 0); assert.deepEqual(errors, []);
    const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ visible: w.isVisible(), focusable: w.isFocusable() })));
    assert.deepEqual(windows, [{ visible: false, focusable: false }]);
    if (evidence) fs.writeFileSync(path.join(evidence, 'native-closed.json'), JSON.stringify(ended, null, 2));
    await shot('native-closed');
    console.log(JSON.stringify({ checks: ['Installed controlled thread/closed notification preserves native identity/draft and displays ended, without a task dispatch; display exit alone is separately native-tested'], modelTasks: 0, nativeProcesses: 0, profile, windows }));
    return;
  }
  await page.locator('#message-input').fill('这份草稿保留，不发送');
  await request(id, 7, '第一项合成确认');
  await page.locator('#approval').getByText('第一项合成确认', { exact: true }).waitFor();
  await page.locator('#approval').getByText('工作目录：/synthetic', { exact: true }).waitFor();
  await page.locator('#approval').getByText('原因：合成权限检查，不执行命令', { exact: true }).waitFor();
  const themes = await require('./check-theme.cjs').checkTheme(page);
  const oldButton = await page.getByRole('button', { name: '允许这一次', exact: true }).elementHandle();
  await shot('waiting');
  await request(id, '7', '第二项合成确认');
  await resolve(id, 7);
  await page.locator('#approval').getByText('第二项合成确认', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '允许这一次', exact: true }).isEnabled(), true);
  await oldButton.evaluate(el => el.click());
  await page.locator('#toast').getByText('权限请求已变化，请重新查看。', { exact: true }).waitFor();
  assert.deepEqual((await fixture('inspect')).replies, []);
  checks.push('Resolving an older numeric request leaves the current string-ID request actionable; its removed button cannot decide the newer request');
  await page.getByRole('button', { name: '拒绝', exact: true }).click();
  await page.locator('#approval').getByText('等待原生确认结果', { exact: true }).waitFor();
  await page.locator('#compose-hint').getByText('已提交决定，等待原生确认；可以继续编辑草稿。', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '允许这一次', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: '拒绝', exact: true }).isDisabled(), true);
  assert.equal((await snapshot()).sessions[0].state, 'approval');
  await request(id, '7', '第二项合成确认');
  assert.equal(await page.getByRole('button', { name: '拒绝', exact: true }).isDisabled(), true);
  await shot('decision-pending');
  await page.locator('#terminal-tab').click(); await page.locator('#terminal-area .xterm-screen').waitFor();
  await page.locator('#chat-tab').click();
  assert.equal(await page.getByRole('button', { name: '拒绝', exact: true }).isDisabled(), true);
  assert.equal(await page.locator('#message-input').inputValue(), '这份草稿保留，不发送');
  await resolve(id, '7');
  await page.locator('#approval').getByText('这项原生确认已处理', { exact: true }).waitFor();
  await page.locator('#compose-hint').getByText('确认已处理，等待原生状态更新；可以继续编辑草稿。', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '允许这一次', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '拒绝', exact: true }).count(), 0);
  const trace = page.locator('.progress-trace');
  if (!(await trace.evaluate(el => el.open))) await trace.locator('summary').click();
  await until(async () => (await trace.innerText()).split('原生确认已处理').length - 1 === 2, 'Both original progress records resolved');
  assert.equal((await snapshot()).sessions[0].state, 'approval');
  await shot('native-resolved');
  checks.push('One refusal stays pending through duplicate delivery and native-view switching, then native resolution removes decisions and updates both original progress records without claiming execution success');
  await event(id, { method: 'thread/status/changed', params: { status: { type: 'idle' } } });
  await until(async () => await page.locator('#approval').isHidden(), 'Native idle removes confirmation notice');
  assert.equal((await snapshot()).sessions[0].state, 'idle');
  for (const [requestId, params] of [
    [20, { networkApprovalContext: { host: 'synthetic.example', protocol: 'https' } }],
    [21, { kind: 'writeStdin' }],
    [22, { availableDecisions: ['decline', 'acceptForSession'] }],
  ]) {
    await event(id, { id: requestId, method: 'item/commandExecution/requestApproval',
      params: { command: '合成特殊权限', cwd: '/synthetic', reason: '不得被当成普通命令批准', ...params } });
    await page.locator('#approval').getByText('原因：不得被当成普通命令批准', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '允许这一次', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: '拒绝', exact: true }).isEnabled(), true);
    const blocked = await page.evaluate(async id => {
      const s = (await workspace.initial()).sessions.find(s => s.id === id);
      try { await workspace.approve(id, s.approval.requestId, 'accept'); return ''; } catch (error) { return error.message; }
    }, id);
    assert.match(blocked, /此界面不支持/);
    if (requestId === 20) await shot('native-scope-required');
    await resolve(id, requestId);
  }
  await request(id, 23, 'first line\nsecond line');
  await page.locator('#approval .approval-command').getByText('first line\nsecond line', { exact: true }).waitFor();
  assert.equal(await page.locator('#approval .approval-command').textContent(), 'first line\nsecond line');
  await page.getByRole('button', { name: '允许这一次', exact: true }).click();
  await page.locator('#approval').getByText('等待原生确认结果', { exact: true }).waitFor(); await resolve(id, 23);
  checks.push('Special permission scopes and native decision restrictions cannot be approved through either controls or direct IPC; a fully displayed multiline command retains one-time approval');
  await event(id, { id: 24, method: 'item/commandExecution/requestApproval', params: {
    kind: 'command', environmentId: 'local', command: '本机合成确认', cwd: '/synthetic',
    availableDecisions: ['accept', { acceptWithExecpolicyAmendment: {} }, 'cancel'],
  } });
  await page.locator('#approval').getByText('执行位置：本机', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '允许这一次', exact: true }).isEnabled(), true);
  assert.equal(await page.getByRole('button', { name: '拒绝', exact: true }).count(), 0);
  await page.getByRole('button', { name: '取消本轮', exact: true }).click();
  await page.locator('#approval').getByText('等待原生确认结果', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '取消本轮', exact: true }).isDisabled(), true);
  await shot('local-cancel'); await resolve(id, 24);
  checks.push('Local environment exposes literal one-time accept and turn cancellation; cancellation is pending until native resolution and never becomes a persistent policy grant');
  await request(id, 8, '连接中断前的合成确认');
  await page.locator('#approval').getByText('连接中断前的合成确认', { exact: true }).waitFor();
  await fixture('transport-close', id);
  await until(async () => await page.locator('#approval').isHidden(), 'Disconnected confirmation cannot be clicked');
  await until(async () => (await trace.innerText()).includes('原生确认结果未确认'), 'Lost resolution is marked unknown');
  assert.equal(await page.locator('#message-input').inputValue(), '这份草稿保留，不发送');
  await shot('disconnected');
  const log = await fixture('inspect');
  assert.deepEqual(log.replies, [{ id: '7', result: { decision: 'decline' } }, { id: 23, result: { decision: 'accept' } }, { id: 24, result: { decision: 'cancel' } }]);
  assert.equal(log.calls.some(c => ['turn/start', 'turn/steer'].includes(c.method)), false);
  assert.equal((await snapshot()).diagnostics.dispatches, 0);
  assert.deepEqual(errors, []);
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ visible: w.isVisible(), focusable: w.isFocusable() })));
  assert.deepEqual(windows, [{ visible: false, focusable: false }]);
  checks.push('Native idle and connection loss drive displayed status; lost decisions remain explicitly unknown; draft is intact, three explicit decisions, zero model tasks, one hidden non-focusable test window');
  console.log(JSON.stringify({ checks, themes, errors, modelTasks: 0, nativeProcesses: 0, profile, windows }, null, 2));
}
run().catch(async error => {
  console.error(error.stack); process.exitCode = 1;
  if (page && !page.isClosed()) {
    await shot('failure').catch(() => {});
    console.error(await page.locator('body').innerText().catch(() => 'Renderer unavailable'));
  }
}).finally(testScratch.cleanup(async () => {
  if (app) await app.close();
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Test-owned daemon did not exit')), 8000);
      child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill('SIGTERM');
    });
  }
  console.log(JSON.stringify({ testDaemonExited: child.exitCode !== null || child.signalCode !== null }));
}));
