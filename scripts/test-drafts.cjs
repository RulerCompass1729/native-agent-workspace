const testScratch = require('./fixtures/test-scratch.cjs');
// Real headed app, IPC, persistence and workspace; delayed synthetic transport.
// No provider processes, native sessions, credentials or model requests.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const { fork } = testScratch.childProcess;
const { _electron } = testScratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..');
const code = process.env.NAW_TEST_APP_ROOT || root;
const { connect } = require(path.join(code, 'app/service-client.cjs'));
const profile = testScratch.directory(path.join(os.tmpdir(), 'naw-draft-test-'));
const shots = process.env.NAW_EVIDENCE_DIR;
if (shots) fs.mkdirSync(shots, { recursive: true, mode: 0o700 });
const child = fork(path.join(code, 'app/daemon.cjs'), [profile], {
  execArgv: ['--require', path.join(__dirname, 'fixtures/delayed-native.cjs')],
  env: { ...process.env, NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_TEST_APP_ROOT: code, NAW_WORKSPACE: profile },
  stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
});
let app, page, client, sequence = 0;
const errors = [], passed = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { for (let i = 0; i < 100; i++) { if (await fn()) return; await delay(100); } throw Error(label); }
function native(method, fail = false) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.off('message', listener); reject(Error('Fixture response timed out')); }, 5000);
    const listener = message => { if (message.requestId === id) { clearTimeout(timer); child.off('message', listener); resolve(message); } };
    child.on('message', listener); child.send({ id, method, fail });
  });
}
async function launch() {
  assert.ok(!app, 'Only one test UI at a time');
  app = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await app.firstWindow(); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#new-session').waitFor({ state: 'visible' });
}
async function close() { if (app) { const old = app; app = null; await old.close(); } }
const snapshot = () => page.evaluate(() => workspace.initial());
const input = () => page.locator('#message-input');
const row = id => page.locator(`[data-session-id="${id}"]`);
async function edit(text, id) {
  await input().fill(text);
  await until(async () => (await snapshot()).sessions.find(s => s.id === id).liveDraft === text, 'Draft persistence');
}
async function checkDraft(id, expected) {
  assert.equal(await input().inputValue(), expected, 'Visible draft');
  const state = await snapshot();
  assert.equal(state.sessions.find(s => s.id === id).liveDraft, expected, 'Service draft');
  const saved = JSON.parse(fs.readFileSync(path.join(profile, 'views.json'))).find(v => v.owner === state.owner);
  assert.deepEqual(saved.draft, { id, text: expected }, 'Recovery draft');
}
async function send(id, text) {
  await row(id).click(); await edit(text, id);
  const count = (await native('stats')).sends.length;
  await page.locator('#send-button').click();
  await until(async () => (await native('stats')).sends.length === count + 1, 'Send reaches synthetic transport');
  assert.deepEqual((await native('stats')).sends.at(-1), { id, text: text.trim() });
}
async function release(fail = false) {
  await native('release', fail);
  if (fail) await page.locator('#toast').filter({ hasText: 'Synthetic acceptance failure' }).waitFor({ state: 'visible' });
  await until(async () => (await snapshot()).sessions.every(s => s.state === 'idle' && !s.pendingTag), 'Acceptance processed');
  await delay(150); // Allow the actual main-process IPC reply and UI task to run.
}
async function run() {
  console.log('Fixture profile:', profile);
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Fixture service startup');
  client = await connect(profile, 'fixture-cleanup'); await launch();
  for (const provider of ['codex', 'claude']) {
    await page.locator('#new-session').click();
    await page.locator(`input[name="provider"][value="${provider}"]`).check();
    await page.locator('#initial-view').selectOption('chat');
    await page.locator('#session-name').fill(provider + ' · 草稿测试');
    await page.locator('#confirm-create').click();
    await until(async () => (await snapshot()).sessions.some(s => s.provider === provider && s.state === 'idle'), 'Synthetic session');
  }
  const sessions = (await snapshot()).sessions;
  for (const session of sessions) {
    const id = session.id, text = '草稿测试：只发这一条。';
    await send(id, text); await edit('', id); await edit(text, id); await release();
    await checkDraft(id, text);
    if (shots) await page.screenshot({ path: path.join(shots, session.provider + '-retained.png') });
    await close(); await launch(); await checkDraft(id, text);
    passed.push(session.provider + ': same-text edit survives late success and UI reopen');
    await send(id, text); await edit(text + '  ', id); await release(); await checkDraft(id, text + '  ');
    await close(); await launch(); await checkDraft(id, text + '  ');
    passed.push(session.provider + ': whitespace edit survives success and reopen');
    await send(id, text); await release(true); await checkDraft(id, text);
    await send(id, text); await edit('发送期间的新草稿', id); await release(true); await checkDraft(id, '发送期间的新草稿');
    passed.push(session.provider + ': failed send retains original or newer draft');
    await send(id, text); await release(); await checkDraft(id, '');
    passed.push(session.provider + ': unchanged accepted draft clears');
  }
  const [a, b] = sessions;
  await send(a.id, '旧会话待发送');
  await row(b.id).click(); await edit('另一个会话的草稿', b.id);
  await release(); await checkDraft(b.id, '另一个会话的草稿');
  await row(a.id).click(); assert.equal(await input().inputValue(), '');
  await row(b.id).click(); await close(); await launch(); await checkDraft(b.id, '另一个会话的草稿');
  passed.push('switching session and reopening preserve the other draft');
  // Acceptance is a provider fact. A later local save failure must not turn it
  // into a send failure or leave a tempting duplicate in the composer.
  await send(a.id, '已接受的消息：保存失败也不能误报未发送');
  await app.evaluate(() => {
    const fs = process.getBuiltinModule('fs');
    global.draftTestRename = fs.renameSync;
    fs.renameSync = (source, destination) => {
      if (String(destination).endsWith('/views.json')) throw Error('Synthetic post-acceptance save failure');
      return global.draftTestRename(source, destination);
    };
  });
  try {
    const submissions = (await native('stats')).sends.length;
    await release();
    await until(async () => await input().inputValue() === '', 'Accepted draft clears despite later disk failure');
    assert.equal(await page.locator('#alert').isVisible(), true);
    assert.equal(await page.locator('#retry-save').isVisible(), true);
    assert.equal((await native('stats')).sends.length, submissions);
    assert.equal((await snapshot()).sessions.find(s => s.id === a.id).messages.filter(m => m.role === 'user' && m.text === '已接受的消息：保存失败也不能误报未发送').length, 1);
    if (shots) await page.screenshot({ path: path.join(shots, 'accepted-despite-save-failure.png') });
  } finally {
    await app.evaluate(() => { process.getBuiltinModule('fs').renameSync = global.draftTestRename; });
  }
  await page.locator('#retry-save').click();
  await until(() => page.locator('#alert').isHidden(), 'Explicit post-acceptance save retry');
  await checkDraft(a.id, '');
  passed.push('accepted message remains accepted through a later view-save failure; explicit save retry does not resubmit it');
  assert.deepEqual(errors, []); assert.equal(app.windows().length, 1);
  const final = await snapshot(); assert.equal(final.diagnostics.shellModelCalls, 0);
  console.log(JSON.stringify({ passed, errors, nativeModelCalls: 0, transport: 'synthetic; real headed desktop, IPC, service, persistence', sends: (await native('stats')).sends.length }));
}
run().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(testScratch.cleanup(async () => {
  try {
    await close(); client?.close();
    // Read the final layout: a UI version change may have added a backend
    // after the original cleanup connection was created.
    client = await connect(profile, 'fixture-final-cleanup');
    try {
      const state = await client.call('initial'), entries = client.entries.map(e => ({ key: e.key, pid: e.state.servicePid }));
      for (const s of state.sessions) await client.call('stop', s.id);
      await client.call('shutdown');
      await until(() => entries.every(e => {
        if (fs.existsSync(path.join(profile, e.key, 'connection.json'))) return false;
        try { process.kill(e.pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
      }), 'All test backends exited and removed their connection records');
    } finally { client.close(); }
  }
  finally { if (child.connected) child.disconnect(); setTimeout(() => { if (child.exitCode === null) child.kill('SIGTERM'); }, 1000).unref(); }
}));
