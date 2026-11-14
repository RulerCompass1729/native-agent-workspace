// B2: real Electron/main/service/Git worktrees; only NativeHost is synthetic.
// Default mode checks the human create flow. --migration additionally enables
// the explicitly isolated test-only dispatcher gate, not the product default.
// --trust checks the native startup decision pause through that same closed gate.
// --trust-timeout checks rollback after a bounded wait, without accepting trust.
// --trust-receipts clears only this fixture's space and trims the private log
// before real window restarts; durable attempts must prevent repeated notices.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process'), { randomUUID } = require('node:crypto');
const scratch = require('./fixtures/test-scratch.cjs');
const { _electron } = scratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const { connect } = require(path.join(code, 'app/service-client.cjs'));
const trustMode = process.argv.includes('--trust');
const trustTimeoutMode = process.argv.includes('--trust-timeout');
const trustReceiptsMode = process.argv.includes('--trust-receipts');
const trustTimeoutMs = trustTimeoutMode || trustReceiptsMode ? Number(process.env.NAW_B2_TEST_TRUST_TIMEOUT_MS || (trustReceiptsMode ? 45000 : 12000)) : null;
if (trustTimeoutMs !== null) assert.ok(Number.isSafeInteger(trustTimeoutMs) && trustTimeoutMs >= 1000 && trustTimeoutMs <= 60000, 'The isolated trust timeout is between 1 and 60 seconds');
const migration = process.argv.includes('--migration') || trustMode || trustTimeoutMode || trustReceiptsMode;
const evidence = path.resolve(process.env.NAW_EVIDENCE_DIR || path.join(process.env.NAW_PICTURES_DIR || path.join(os.homedir(), 'Pictures/naw-dogfood'), new Date().toISOString().slice(0, 7), 'b2-inheritance', String(Date.now())));
let existing = evidence; while (!fs.existsSync(existing)) existing = path.dirname(existing);
const destination = path.join(fs.realpathSync(existing), path.relative(existing, evidence));
for (const repo of [root, code].map(p => fs.realpathSync(p))) assert.ok(destination !== repo && !destination.startsWith(repo + path.sep), 'Evidence stays outside source repositories');
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID();
try { fs.mkdirSync(slot); } catch (error) { if (error.code !== 'EEXIST') throw error; console.error('GUI slot occupied; no profile, fixture or application started.'); process.exit(75); }
const receipt = { owner: 'Codex3', task: 'B2 creation defaults and recoverable worktree migration', token, pid: process.pid, createdAt: new Date().toISOString(), migration, trustMode, trustTimeoutMs, trustReceiptsMode };
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify(receipt));
fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
const profile = scratch.directory(path.join(os.tmpdir(), 'naw-b2-creation-'));
const legacy = path.join(profile, 'workspace'); fs.mkdirSync(legacy, { mode: 0o700 });
const source = path.join(profile, 'repository'); fs.mkdirSync(source, { mode: 0o700 });
const repository = fs.realpathSync(source), defaultsFile = path.join(profile, 'creation-defaults.json');
const rules = 'Synthetic B2 project rules. No provider task is sent.\n';
fs.writeFileSync(path.join(repository, 'CLAUDE.md'), rules); fs.symlinkSync('CLAUDE.md', path.join(repository, 'AGENTS.md'));
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
const git = (...args) => execFileSync('git', ['-C', repository, '-c', 'user.name=B2 Test', '-c', 'user.email=b2@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { encoding: 'utf8', env: { ...gitEnv, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } });
git('init', '-q', '--template='); git('add', 'CLAUDE.md', 'AGENTS.md'); git('commit', '-q', '-m', 'Synthetic B2 project rules');
const child = scratch.childProcess.fork(path.join(code, 'app/daemon.cjs'), [profile], {
  execArgv: ['--require', path.join(__dirname, 'fixtures/b2-creation-native.cjs')],
  env: { ...process.env, NAW_TEST_APP_ROOT: code, NAW_WORKSPACE: legacy, NAW_APP_VERSION: require(path.join(code, 'package.json')).version },
  stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
});
Object.assign(receipt, { profile, profileIdentity: { ino: fs.lstatSync(profile).ino, dev: fs.lstatSync(profile).dev }, daemonPid: child.pid, repository });
const saveReceipt = () => fs.writeFileSync(path.join(evidence, 'ownership.json'), JSON.stringify(receipt, null, 2)); saveReceipt();
let app, page, client, sequence = 0, roomId;
const checks = [], errors = [], clipboard = [], delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 20000) {
  const stop = Date.now() + timeout;
  while (Date.now() < stop) { if (await check()) return; await delay(80); }
  throw Error(label);
}
function fixture(method = 'stats', value = {}) {
  const id = ++sequence, special = method.startsWith('b2');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.off('message', listener); reject(Error('Owned B2 fixture timeout: ' + method)); }, 8000);
    const listener = reply => {
      if (reply.requestId !== id || special && reply.fixture !== 'b2-creation') return;
      clearTimeout(timer); child.off('message', listener); resolve(reply);
    };
    child.on('message', listener); child.send({ id, method, ...value });
  });
}
const snapshot = () => page.evaluate(() => workspace.initial());
const named = async name => (await snapshot()).sessions.filter(s => s.name === name);
const lanes = () => fs.existsSync(repository + '-lanes') ? fs.readdirSync(repository + '-lanes').sort() : [];
const rotation = id => JSON.parse(fs.readFileSync(path.join(profile, 'queue-dispatch.json'), 'utf8')).rotations[id];
const capture = name => page.screenshot({ path: path.join(evidence, name + '.png') });
const check = text => { checks.push(text); console.log('PASS:', text); };
function verifyRules(record) {
  assert.ok(record.cwd.startsWith(repository + '-lanes' + path.sep)); assert.notEqual(record.cwd, repository);
  assert.equal(fs.readFileSync(path.join(record.cwd, 'CLAUDE.md'), 'utf8'), rules);
  assert.equal(fs.lstatSync(path.join(record.cwd, 'AGENTS.md')).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(path.join(record.cwd, 'AGENTS.md')), 'CLAUDE.md');
}
async function launch() {
  assert.ok(!app, 'Only one owned GUI instance');
  app = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [code],
    env: { ...process.env, NAW_DATA_DIR: profile, NAW_WORKSPACE: legacy, NAW_TEST_PARENT_PID: String(process.pid), NAW_TEST_QUEUE_HUMAN_QUIET_MS: '0',
      ...(migration ? { NAW_TEST_QUEUE_CONTENT_LIMIT: '2', NAW_TEST_QUEUE_DIRECTORY_MIGRATION: '1' } : {}),
      ...(trustTimeoutMs !== null ? { NAW_QUEUE_DIRECTORY_TRUST_TIMEOUT_MS: String(trustTimeoutMs) } : {}) }, timeout: 70000 });
  receipt.electronPid = app.process().pid; receipt.connection = JSON.parse(fs.readFileSync(path.join(profile, 'connection.json'), 'utf8')); saveReceipt();
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message)); await page.locator('#new-session').waitFor();
  await app.evaluate(({ clipboard, dialog, Notification }) => {
    globalThis.b2Clipboard = { reads: 0, writes: 0 }; globalThis.b2Pick = null;
    for (const key of Object.getOwnPropertyNames(clipboard)) if (typeof clipboard[key] === 'function' && /^(read|write|clear$|availableFormats$|has$)/.test(key)) {
      clipboard[key] = () => { globalThis.b2Clipboard[/^(write|clear)/.test(key) ? 'writes' : 'reads']++; throw Error('System clipboard prohibited in B2 fixture'); };
    }
    dialog.showOpenDialog = async () => globalThis.b2Pick ? { canceled: false, filePaths: [globalThis.b2Pick] } : { canceled: true, filePaths: [] };
    // A synthetic rotation must not show an OS notification on the real desktop.
    Notification.isSupported = () => false;
  });
  await app.evaluate(({ ipcMain }) => {
    globalThis.b2HoldDefault = false; globalThis.b2HeldDefaults = []; globalThis.b2Creates = 0;
    const defaults = ipcMain._invokeHandlers.get('workspace:createDefaults'), create = ipcMain._invokeHandlers.get('workspace:create');
    if (!defaults || !create) throw Error('B2 creation handlers missing');
    ipcMain._invokeHandlers.set('workspace:createDefaults', async (...args) => {
      const hold = globalThis.b2HoldDefault; globalThis.b2HoldDefault = false;
      const result = await defaults(...args);
      if (hold) await new Promise(resolve => globalThis.b2HeldDefaults.push(resolve));
      return result;
    });
    ipcMain._invokeHandlers.set('workspace:create', (...args) => { globalThis.b2Creates++; return create(...args); });
  });
}
async function closeUi() {
  clipboard.push(await app.evaluate(() => ({ ...globalThis.b2Clipboard })));
  await app.close(); app = null; page = null;
}
async function relaunch() { await closeUi(); await launch(); }
async function open(name, provider = 'codex') {
  await page.locator('#new-session').click(); await page.locator(`input[name="provider"][value="${provider}"]`).check();
  if (provider === 'codex') await page.locator('#initial-view').selectOption('chat');
  await page.locator('#session-name').fill(name);
}
async function readyPreview() { await until(async () => await page.locator('#git-worktree').isChecked() && !(await page.locator('#confirm-create').isDisabled()), 'Current default worktree preview ready'); return page.locator('#chosen-folder').innerText(); }
async function pick(folder) { await app.evaluate((_, folder) => { globalThis.b2Pick = folder; }, folder); await page.locator('#choose-folder').click(); await until(async () => (await page.locator('#chosen-folder').innerText()) === folder, 'Chosen directory visible'); }
async function submit(name) {
  await page.locator('#confirm-create').click(); await page.locator('#create-dialog').waitFor({ state: 'hidden', timeout: 20000 });
  await until(async () => (await named(name)).length === 1, 'Exactly one created session: ' + name); return (await named(name))[0];
}
async function holdDefault() {
  await app.evaluate(() => { globalThis.b2HoldDefault = true; });
}
async function defaultHeld() { await until(() => app.evaluate(() => globalThis.b2HeldDefaults.length === 1), 'Default reply held after the real main handler'); }
async function releaseDefault() { await app.evaluate(() => { const release = globalThis.b2HeldDefaults.shift(); if (!release) throw Error('No owned held default'); release(); }); await delay(100); }
async function emptyMember(name, provider = 'claude') {
  await open(name, provider); await readyPreview(); await page.locator('#new-folder').click();
  assert.equal(await page.locator('#git-worktree').isChecked(), false);
  const record = await submit(name); assert.equal(path.dirname(record.cwd), legacy + '-sessions');
  fs.mkdirSync(path.join(record.cwd, '.local')); fs.writeFileSync(path.join(record.cwd, 'retained.txt'), 'B2_PRIVATE_FILE_CONTENT_MUST_NOT_BE_SENT');
  await page.evaluate(([roomId, id]) => workspace.spaceAction(roomId, 'join', [id, true]), [roomId, record.id]);
  return record;
}
async function addWork(id, text) { await page.evaluate(([roomId, id, text]) => workspace.spaceAction(roomId, 'queueAdd', [text, id]), [roomId, id, text]); }
async function sendTo(id, pattern, label) {
  let found; await until(async () => { found = (await fixture()).sends.find(row => row.id === id && pattern.test(row.text)); return Boolean(found); }, label, 45000); return found;
}
async function migrate(name, pause) {
  const old = await emptyMember(name), newName = name + ' · 续';
  await addWork(old.id, 'B2 prepare ' + name); await sendTo(old.id, /B2 prepare /, 'Preparation reaches old member');
  await fixture('release', { session: old.id, reply: 'B2 preparation complete.' });
  if (pause) await fixture('b2HoldStart', { name: newName });
  const before = lanes(); await addWork(old.id, 'B2 continue ' + name);
  await sendTo(old.id, /【NAW 换会话】/, 'Old member receives handoff request');
  await fixture('release', { session: old.id, reply: 'B2 synthetic handoff: continue the queued request.' });
  await until(async () => { const rows = await named(newName); return rows.length === 1 && rows[0].worktreePreparation?.status === 'ready'; }, 'One successor worktree prepared and stored', 45000);
  let fresh = (await named(newName))[0]; verifyRules(fresh);
  if (pause) {
    await until(async () => (await fixture('b2Stats')).held.includes(fresh.id), 'Successor held after real worktree preparation');
    const saved = rotation(old.id); assert.equal(saved.phase, 'creating'); assert.equal(saved.newWorktree.nonce, fresh.worktreePreparation.nonce); assert.equal(saved.newCwd, fresh.cwd);
    assert.equal(lanes().length, before.length + 1); await capture('05-creating-before-restart');
    await relaunch();
    assert.equal((await named(newName)).length, 1); assert.equal((await named(newName))[0].id, fresh.id);
    assert.equal((await fixture('b2Stats')).creations.filter(row => row.name === newName).length, 1, 'Restart only adopts the reserved successor');
    assert.equal(lanes().length, before.length + 1); assert.equal(rotation(old.id).newWorktree.nonce, saved.newWorktree.nonce);
    assert.equal((await fixture('b2ReleaseStart', { session: fresh.id })).released, true);
  }
  const handoff = await sendTo(fresh.id, /【NAW 换会话】/, 'Successor receives the retained handoff');
  await until(async () => (await snapshot()).sessions.find(s => s.id === old.id)?.state === 'ended', 'Old session ends only after successor accepts', 45000);
  fresh = (await named(newName))[0]; verifyRules(fresh);
  assert.ok(handoff.text.includes(old.cwd) && handoff.text.includes(fresh.cwd)); assert.match(handoff.text, /旧会话的工作目录/); assert.match(handoff.text, /\.local/); assert.match(handoff.text, /retained\.txt/);
  assert.equal(handoff.text.includes('B2_PRIVATE_FILE_CONTENT_MUST_NOT_BE_SENT'), false); assert.equal(fs.readFileSync(path.join(old.cwd, 'retained.txt'), 'utf8'), 'B2_PRIVATE_FILE_CONTENT_MUST_NOT_BE_SENT');
  assert.equal(fs.statSync(path.join(old.cwd, '.local')).isDirectory(), true); assert.equal(lanes().length, before.length + 1);
  await page.locator(`[data-session-id="${fresh.id}"]`).click(); await page.locator('#chat-tab').click(); await capture(pause ? '06-restart-adopted' : '04-directory-handoff');
  check(pause ? 'Creating restart adopts the same nonce and successor, creates exactly one worktree, then delivers the handoff' : 'An automatic UUID member moves to the saved repository worktree; names-only handoff and old files survive');
}
async function clearTrimAndRestart(old, fresh, noticeId, key, phase, label) {
  const logFile = path.join(profile, 'rotation-log.jsonl');
  const logRows = () => fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const attempts = () => logRows().filter(row => row.noticeId === noticeId).length;
  const attemptCount = attempts(); assert.equal(attemptCount, 1, 'The notice was attempted once before clearing');
  const stats = await fixture('b2Stats'), stopCount = stats.maintenanceStops.filter(id => id === fresh.id).length;
  // Confirm only this synthetic space's dialog. Any different OS dialog fails
  // the fixture rather than being accepted or sent to the person's desktop.
  await app.evaluate(({ dialog }, title) => {
    globalThis.b2SavedMessageBox = dialog.showMessageBox; globalThis.b2ClearDialogs = 0;
    dialog.showMessageBox = async (...args) => {
      const options = args.at(-1);
      if (options.message !== title || options.type !== 'warning' || options.defaultId !== 0 || options.cancelId !== 0 || options.buttons?.length !== 2) throw Error('Unexpected dialog during owned B2 space clear');
      globalThis.b2ClearDialogs++; return { response: 1, checkboxChecked: false };
    };
  }, '清除「B2 migration」的共享记录？');
  try {
    assert.equal(await page.evaluate(id => workspace.spaceAction(id, 'clearSharedHistory', []), roomId), true);
    assert.equal(await app.evaluate(() => globalThis.b2ClearDialogs), 1);
  } finally { await app.evaluate(({ dialog }) => { dialog.showMessageBox = globalThis.b2SavedMessageBox; delete globalThis.b2SavedMessageBox; }); }
  assert.equal((await snapshot()).rooms.find(room => room.id === roomId).events.filter(event => event.uiMessage?.key === key).length, 0);
  await closeUi();
  // readLog retains its last 1000 valid rows. Exercise that real startup path
  // with 1001 harmless entries in the owned synthetic profile, leaving receipt
  // state and native sessions untouched. No provider input or task is created.
  const trimmed = Array.from({ length: 1001 }, () => ({ time: Date.now(), event: 'waiting', spaces: [], old: { id: randomUUID(), nativeId: null, name: 'B2 synthetic log trim' }, new: null, reason: 'synthetic-retention-check' }));
  fs.appendFileSync(logFile, trimmed.map(row => JSON.stringify(row)).join('\n') + '\n');
  assert.ok(logRows().length > 1000); assert.equal(logRows().slice(-1000).some(row => row.noticeId === noticeId), false, 'The receipt marker is outside the retained log tail');
  await launch();
  await until(async () => rotation(old.id).phase === phase && (await named(fresh.name)).length === 1, 'Restart adopts the receipt-bearing rotation');
  await delay(3500); // Allow the restarted dispatcher to observe the native state and run a tick.
  assert.equal(rotation(old.id).phase, phase); assert.equal(rotation(old.id).newId, fresh.id);
  assert.equal((await named(fresh.name))[0].id, fresh.id);
  assert.equal((await fixture('b2Stats')).creations.filter(row => row.name === fresh.name).length, 1);
  assert.equal((await fixture('b2Stats')).maintenanceStops.filter(id => id === fresh.id).length, stopCount, 'Restart does not repeat a completed cleanup');
  assert.deepEqual((await fixture('b2Stats')).inputs, []); assert.equal(attempts(), attemptCount, 'A trimmed log does not cause another notice attempt');
  assert.equal((await snapshot()).rooms.find(room => room.id === roomId).events.filter(event => event.uiMessage?.key === key).length, 0, 'A cleared space notice is not recreated');
  await page.locator(`[data-space-id="${roomId}"] .room-nav`).click(); await page.locator('#room-record').click();
  const phrase = key === 'notice.rotation.needsTrust' ? '需要你决定：' : '目录信任确认等待已超时';
  assert.equal(await page.locator('#room-messages .message-body').filter({ hasText: phrase }).filter({ hasText: fresh.name }).count(), 0);
  await capture('trust-receipt-' + label);
  check(`A cleared ${label} notice and trimmed 1000-row log stay absent after a real window restart, without another successor, native input or cleanup`);
}
async function trustMigration(provider, expectTimeout = false, checkReceipts = false) {
  const name = 'B2 trust ' + provider, newName = name + ' · 续';
  const old = await emptyMember(name, provider), before = lanes();
  await addWork(old.id, 'B2 prepare ' + name); await sendTo(old.id, /B2 prepare /, 'Trust preparation reaches old member');
  await fixture('release', { session: old.id, reply: 'B2 preparation complete.' });
  await fixture('b2TrustStart', { name: newName });
  await addWork(old.id, 'B2 continue ' + name); await sendTo(old.id, /【NAW 换会话】/, 'Trust handoff request reaches old member');
  await fixture('release', { session: old.id, reply: 'B2 synthetic handoff: continue the queued request.' });
  await until(async () => (await named(newName)).length === 1 && rotation(old.id).phase === 'waiting-trust', 'Native viewport creates a durable trust wait', 45000);
  const fresh = (await named(newName))[0], saved = rotation(old.id);
  verifyRules(fresh); assert.equal(lanes().length, before.length + 1);
  assert.deepEqual(fresh.nativeStartupPrompt, { kind: 'directory-trust', provider, source: 'native-terminal' });
  assert.equal(fresh.state, 'starting'); assert.notEqual((await snapshot()).sessions.find(row => row.id === old.id).state, 'ended');
  const decisions = async () => (await snapshot()).rooms.find(room => room.id === roomId).events.filter(event => event.uiMessage?.key === 'notice.rotation.needsTrust');
  const ownDecision = async () => (await decisions()).filter(event => event.rotationReceipt === saved.trustNoticeId);
  await until(async () => (await ownDecision()).length === 1, 'One saved trust decision in the space');
  assert.match((await ownDecision())[0].text, /^需要你决定：/);
  await page.locator(`[data-space-id="${roomId}"] .room-nav`).click(); await page.locator('#room-record').click();
  const decisionRow = page.locator('#room-messages .message-body').filter({ hasText: '需要你决定：' }).filter({ hasText: newName });
  await until(async () => (await decisionRow.count()) === 1, 'The trust decision is rendered exactly once'); await decisionRow.waitFor();
  fs.writeFileSync(path.join(evidence, `trust-${provider}-before.txt`), await decisionRow.innerText());
  await capture(`trust-${provider}-waiting`);
  assert.equal((await fixture()).sends.filter(row => row.id === fresh.id).length, 0, 'No task or handoff to an untrusted successor');
  assert.deepEqual((await fixture('b2Stats')).inputs, [], 'No native trust input');
  if (checkReceipts) await clearTrimAndRestart(old, fresh, saved.trustNoticeId, 'notice.rotation.needsTrust', 'waiting-trust', 'waiting');
  if (expectTimeout) {
    await until(async () => rotation(old.id).phase === 'failed', 'The configured trust deadline rolls back the handoff', Math.max(45000, trustTimeoutMs + 30000));
    assert.equal(rotation(old.id).reason, 'native-directory-trust-timeout');
    await until(async () => (await named(newName))[0]?.state === 'ended', 'The timed-out synthetic successor is stopped');
    assert.notEqual((await snapshot()).sessions.find(row => row.id === old.id)?.state, 'ended', 'The old session remains available');
    assert.equal((await fixture()).sends.filter(row => row.id === fresh.id).length, 0, 'Timeout never sends a task or handoff to the successor');
    await sendTo(old.id, /^【NAW 派活】[\s\S]*B2 continue /, 'The original member receives its previously queued task after rollback');
    const failures = async () => (await snapshot()).rooms.find(room => room.id === roomId).events.filter(event => event.uiMessage?.key === 'notice.rotation.trustTimedOut');
    await until(async () => (await failures()).length === 1, 'One timeout event is saved in the space');
    const failureId = (await failures())[0].id;
    const timeoutRow = page.locator('#room-messages .message-body').filter({ hasText: '目录信任确认等待已超时' }).filter({ hasText: newName });
    await until(async () => (await timeoutRow.count()) === 1, 'The timeout is visibly explained exactly once'); await timeoutRow.waitFor();
    fs.writeFileSync(path.join(evidence, `trust-${provider}-timeout.txt`), await timeoutRow.innerText()); await capture(`trust-${provider}-timeout`);
    assert.deepEqual((await fixture('b2Stats')).inputs, []);
    if (checkReceipts) {
      assert.equal((await fixture('b2Stats')).maintenanceStops.filter(id => id === fresh.id).length, 1, 'The unused synthetic successor was guarded and stopped once');
      await clearTrimAndRestart(old, fresh, (await failures())[0].rotationReceipt, 'notice.rotation.trustTimedOut', 'failed', 'timeout');
    } else await relaunch();
    await until(async () => rotation(old.id).phase === 'failed', 'Window restart restores the recorded timeout');
    assert.equal(rotation(old.id).reason, 'native-directory-trust-timeout'); assert.equal(rotation(old.id).newId, fresh.id);
    assert.equal((await named(newName)).length, 1); assert.equal((await named(newName))[0].id, fresh.id); assert.equal((await named(newName))[0].state, 'ended');
    assert.equal((await fixture('b2Stats')).creations.filter(row => row.name === newName).length, 1, 'A failed wait never creates another successor');
    assert.equal(lanes().length, before.length + 1); assert.equal((await failures()).length, checkReceipts ? 0 : 1);
    if (!checkReceipts) assert.equal((await failures())[0].id, failureId);
    assert.notEqual((await snapshot()).sessions.find(row => row.id === old.id)?.state, 'ended'); assert.deepEqual((await fixture('b2Stats')).inputs, []);
    if (!checkReceipts) {
      await page.locator(`[data-space-id="${roomId}"] .room-nav`).click(); await page.locator('#room-record').click();
      const restoredTimeout = page.locator('#room-messages .message-body').filter({ hasText: '目录信任确认等待已超时' }).filter({ hasText: newName });
      await until(async () => (await restoredTimeout.count()) === 1, 'The reloaded timeout notice is not duplicated'); await restoredTimeout.waitFor(); await capture(`trust-${provider}-timeout-restored`);
    }
    check(`${provider}: the visible trust wait times out, stops only its unused successor, keeps the old session and dispatches its queued task; window restart preserves the single failure and creates no new successor or trust input`);
    await fixture('release', { session: old.id, reply: 'B2 timeout fixture complete.' });
    return;
  }
  await relaunch();
  await until(async () => rotation(old.id).phase === 'waiting-trust' && (await named(newName)).length === 1, 'Window restart restores the persisted trust wait');
  assert.equal((await named(newName))[0].id, fresh.id); assert.equal(rotation(old.id).trustNoticeId, saved.trustNoticeId);
  assert.equal(rotation(old.id).newWorktree.nonce, saved.newWorktree.nonce); assert.equal(lanes().length, before.length + 1);
  assert.equal((await fixture('b2Stats')).creations.filter(row => row.name === newName).length, 1, 'Window restart only adopts the same native successor');
  assert.equal((await ownDecision()).length, 1, 'Reloaded space does not duplicate the trust decision');
  await page.locator(`[data-space-id="${roomId}"] .room-nav`).click(); await page.locator('#room-record').click();
  const restoredRow = page.locator('#room-messages .message-body').filter({ hasText: '需要你决定：' }).filter({ hasText: newName });
  await until(async () => (await restoredRow.count()) === 1, 'The restored decision is rendered exactly once'); await restoredRow.waitFor(); await capture(`trust-${provider}-restored`);
  assert.equal((await fixture()).sends.filter(row => row.id === fresh.id).length, 0); assert.deepEqual((await fixture('b2Stats')).inputs, []);
  assert.equal((await fixture('b2TrustReady', { session: fresh.id })).released, true);
  await sendTo(fresh.id, /【NAW 换会话】/, 'Only an independent native-ready event resumes the handoff');
  await until(async () => (await snapshot()).sessions.find(row => row.id === old.id)?.state === 'ended', 'Old session ends after successor acceptance', 45000);
  assert.equal((await fixture()).sends.filter(row => row.id === fresh.id && /【NAW 换会话】/.test(row.text)).length, 1);
  assert.deepEqual((await fixture('b2Stats')).inputs, []); assert.equal((await ownDecision()).length, 1);
  check(`${provider}: visible directory-trust decision pauses delivery and keeps the old session; a window restart adopts the same successor and receipt; native readiness resumes exactly one handoff without trust input`);
  await fixture('release', { session: fresh.id, reply: 'B2 trust fixture complete.' });
}
async function run() {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Owned synthetic service ready'); client = await connect(profile, 'b2-creation-observer'); await launch();
  await open('B2 first worktree'); await until(async () => !(await page.locator('#confirm-create').isDisabled()), 'Initial empty-folder defaults loaded');
  await pick(repository); await page.locator('#git-worktree').check(); await readyPreview();
  const first = await submit('B2 first worktree'); verifyRules(first);
  assert.equal(JSON.parse(fs.readFileSync(defaultsFile, 'utf8')).repository, repository); assert.equal(fs.statSync(defaultsFile).mode & 0o777, 0o600);
  check('Human-selected repository creates a separate worktree with committed CLAUDE.md and AGENTS.md');
  await open('B2 automatic worktree'); const secondPreview = await readyPreview(); await capture('01-saved-worktree-default');
  const second = await submit('B2 automatic worktree'); verifyRules(second); assert.equal(second.cwd, secondPreview); assert.notEqual(first.cwd, second.cwd); assert.equal(lanes().length, 2);
  check('The next create dialog automatically selects the saved repository worktree and previews its new destination');
  await relaunch(); await open('B2 persistent default'); const restartedPreview = await readyPreview(); assert.ok(restartedPreview.startsWith(repository + '-lanes' + path.sep));
  await capture('02-default-after-relaunch'); await page.locator('#cancel-create').click(); assert.equal(lanes().length, 2);
  check('A normal GUI restart reloads the root-profile defaults; cancelling a preview creates no worktree');
  const savedDefaults = fs.readFileSync(defaultsFile, 'utf8');
  await holdDefault(); await open('B2 explicit empty'); await defaultHeld(); assert.equal(await page.locator('#confirm-create').isDisabled(), true);
  await page.locator('#new-folder').click(); const emptyCwd = await page.locator('#chosen-folder').innerText(); await releaseDefault();
  assert.equal(await page.locator('#chosen-folder').innerText(), emptyCwd); assert.equal(await page.locator('#git-worktree').isChecked(), false);
  const empty = await submit('B2 explicit empty'); assert.equal(empty.cwd, emptyCwd); assert.equal(fs.readFileSync(defaultsFile, 'utf8'), savedDefaults); assert.equal(lanes().length, 2);
  check('Explicit empty-folder creation wins over a late defaults reply and does not replace the saved repository');
  await holdDefault(); await open('B2 explicit folder'); await defaultHeld(); await pick(legacy); await releaseDefault();
  assert.equal(await page.locator('#chosen-folder').innerText(), legacy); assert.equal(await page.locator('#git-worktree').isChecked(), false); await page.locator('#cancel-create').click();
  await holdDefault(); await open('B2 old opening'); await defaultHeld(); await page.locator('#cancel-create').click(); await open('B2 new opening'); const currentPreview = await readyPreview();
  await releaseDefault(); assert.equal(await page.locator('#chosen-folder').innerText(), currentPreview); await capture('03-current-opening-kept'); await page.locator('#cancel-create').click();
  assert.equal(lanes().length, 2); check('Late defaults cannot overwrite a manual folder or a newer create-dialog opening');
  if (migration) {
    roomId = await page.evaluate(() => workspace.spaceCreate('B2 migration'));
    if (trustReceiptsMode) await trustMigration('claude', true, true);
    else if (trustTimeoutMode) await trustMigration('claude', true);
    else if (trustMode) { await trustMigration('claude'); await trustMigration('codex'); }
    else { await migrate('B2 migration source', false); await migrate('B2 restart source', true); }
  }
  const stats = await fixture('b2Stats'), sends = (await fixture()).sends;
  assert.deepEqual(stats.inputs, []); assert.deepEqual(errors, []); assert.equal(app.windows().length, 1);
  assert.equal(stats.providerProcesses, 0); assert.equal(stats.modelCalls, 0);
  clipboard.push(await app.evaluate(() => ({ ...globalThis.b2Clipboard }))); assert.ok(clipboard.every(item => item.reads === 0 && item.writes === 0));
  if (!migration) assert.deepEqual(sends, []);
  const result = { checks, errors, clipboard, providerProcesses: stats.providerProcesses, productModelCalls: stats.modelCalls, nativeInputs: stats.inputs.length, guardedSyntheticStops: stats.maintenanceStops.length, syntheticSends: sends.length,
    migration: migration ? 'isolated test-only main dispatcher gate; production remains off' : 'not run; product migration gate remains off', trustMode, trustTimeoutMode, trustTimeoutMs, trustReceiptsMode,
    limits: 'Synthetic native transport; actual native trust, rule loading, signed installation and daily use are not claimed' };
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
}
scratch.cleanup(async () => {
  if (app) await closeUi();
  if (child.connected) await fixture('b2ReleaseAll').catch(() => {});
  if (client) {
    try {
      // These records all belong to this owned synthetic profile. Shutdown
      // correctly refuses live sessions; finish them before requesting it.
      for (const session of (await client.call('initial')).sessions) if (session.state !== 'ended') await client.call('stop', session.id);
      await client.call('shutdown');
    } finally { client.close(); }
  }
  if (child.connected) child.disconnect();
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
});
run().catch(async error => { process.exitCode = 1; console.error(error.stack); console.error(JSON.stringify({ partialChecks: checks, errors })); if (page && !page.isClosed()) await capture('failure').catch(() => {}); }).finally(async () => {
  try {
    await scratch.release();
    const current = JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'), 'utf8')); assert.equal(current.token, token); assert.equal(current.pid, process.pid);
    fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot);
    receipt.releasedAt = new Date().toISOString(); receipt.cleanup = 'Owned processes, profile and socket directories verified removed; exact canonical token released'; saveReceipt();
    console.log('Owned B2 fixture cleanup confirmed; canonical GUI slot released.');
  } catch (error) { process.exitCode = 1; console.error('Cleanup unconfirmed; own GUI slot retained:', error.stack); }
});
