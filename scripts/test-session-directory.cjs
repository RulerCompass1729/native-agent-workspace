// Real isolated Electron + service/filesystem; only the native transport is synthetic.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process'), { randomUUID } = require('node:crypto');
const scratch = require('./fixtures/test-scratch.cjs');
const { _electron } = scratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const { connect } = require(path.join(code, 'app/service-client.cjs'));
const evidence = process.env.NAW_EVIDENCE_DIR;
if (evidence) { assert.ok(!path.resolve(evidence).startsWith(root + path.sep)); fs.mkdirSync(evidence, { recursive: true, mode: 0o700 }); }
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID();
try { fs.mkdirSync(slot); } catch (e) { if (e.code !== 'EEXIST') throw e; console.error('GUI slot occupied; no application or fixture started.'); process.exit(75); }
const owner = { owner: 'Codex4', task: 'T96 directories', token, pid: process.pid, createdAt: new Date().toISOString() };
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify(owner));
const profile = scratch.directory(path.join(os.tmpdir(), 'naw-session-directory-'));
const legacy = path.join(profile, 'workspace'); fs.mkdirSync(legacy); fs.writeFileSync(path.join(legacy, 'keep.txt'), 'Existing files unchanged');
// Reuse the native fixture; only these two named test sessions fail at start.
const fixture = path.join(profile, 'directory-fixture.cjs');
fs.writeFileSync(fixture, `require(${JSON.stringify(path.join(__dirname, 'fixtures/loading-terminal.cjs'))});
const fs = require('node:fs'), path = require('node:path'), { NativeHost } = require(${JSON.stringify(path.join(code, 'app/adapters.cjs'))});
const original = NativeHost.prototype.create, held = new Map();
NativeHost.prototype.create = function(record) {
  const r = original.call(this, record);
  if (['Synthetic startup failure', 'Closed startup failure'].includes(record.name)) r.start = async () => {
    fs.writeFileSync(path.join(record.cwd, 'started.txt'), 'Retain native writes');
    if (record.name === 'Closed startup failure') await new Promise((resolve, reject) => held.set(record.id, () => reject(Error('Synthetic closed startup failed'))));
    throw Error('Synthetic native startup failed');
  };
  return r;
};
process.on('message', q => { if (q.method === 'directory-fail-start') held.get(q.target)?.(); });
`, { mode: 0o600 });
const child = scratch.childProcess.fork(path.join(code, 'app/daemon.cjs'), [profile], { execArgv: ['--require', fixture], env: { ...process.env, NAW_TEST_APP_ROOT: code, NAW_WORKSPACE: legacy, NAW_APP_VERSION: require(path.join(code, 'package.json')).version }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
let app, page, client; const checks = [], errors = [], delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { for (let i = 0; i < 160; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
const state = () => page.evaluate(() => workspace.initial());
const preview = () => page.locator('#chosen-folder').innerText();
const shot = name => evidence ? page.screenshot({ path: path.join(evidence, name + '.png') }) : Promise.resolve();
const check = text => { checks.push(text); console.log('PASS:', text); };
async function open(name) { await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="codex"]').check(); await page.locator('#initial-view').selectOption('chat'); await page.locator('#session-name').fill(name); return preview(); }
async function submit(name) { await page.locator('#confirm-create').click(); await page.locator('#create-dialog').waitFor({ state: 'hidden' }); return (await state()).sessions.find(s => s.name === name); }
async function run() {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Own fixture startup'); client = await connect(profile, 'directory-observer');
  app = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [code], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(8000); page.on('pageerror', e => errors.push(e.message)); await page.locator('#new-session').waitFor();
  await app.evaluate(({ dialog }) => { globalThis.directoryDialog = dialog.showOpenDialog; globalThis.directoryPick = null; dialog.showOpenDialog = async () => globalThis.directoryPick ? { canceled: false, filePaths: [globalThis.directoryPick] } : { canceled: true, filePaths: [] }; });
  const first = await open('Cancelled');
  assert.notEqual(first, legacy, 'Default preview must be a new directory, not the shared folder');
  assert.equal(path.dirname(first), legacy + '-sessions'); assert.equal(fs.existsSync(first), false);
  await page.locator('#session-name').fill('Edit name'); assert.equal(await preview(), first, 'Preview stable during one dialog');
  await page.locator('#choose-folder').click(); assert.equal(await preview(), first, 'Cancelled folder picker preserves preview');
  await shot('01-new-preview'); await page.locator('#cancel-create').click(); assert.equal(fs.existsSync(first), false);
  const aPath = await open('First automatic'); assert.notEqual(aPath, first); const a = await submit('First automatic');
  const bPath = await open('Second automatic'); const b = await submit('Second automatic');
  assert.equal(a.cwd, aPath); assert.equal(b.cwd, bPath); assert.notEqual(a.cwd, b.cwd);
  for (const cwd of [a.cwd, b.cwd]) { assert.deepEqual(fs.readdirSync(cwd), []); assert.equal(fs.statSync(cwd).mode & 0o777, 0o700); }
  check('Complete stable preview, cancel and picker cancel create nothing; two submits launch in different actual private empty directories');

  await app.evaluate((_, cwd) => { globalThis.directoryPick = cwd; }, legacy);
  await open('Existing folder'); await page.locator('#choose-folder').click(); assert.equal(await preview(), legacy);
  assert.match(await page.locator('#create-permission-note').innerText(), /已有目录/); assert.doesNotMatch(await page.locator('#create-permission-note').innerText(), /空目录/);
  const existing = await submit('Existing folder'); assert.equal(existing.cwd, legacy); assert.deepEqual(fs.readdirSync(legacy), ['keep.txt']);
  await open('Reset'); await page.locator('#choose-folder').click(); await page.locator('#new-folder').click(); const reset = await preview(); assert.notEqual(reset, legacy); assert.equal(fs.existsSync(reset), false);
  await page.locator('input[name="provider"][value="claude"]').check(); assert.equal(await page.locator('#open-native-history').isDisabled(), true);
  await page.locator('#claude-history-id').fill('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'); assert.equal(await page.locator('#confirm-create').isDisabled(), true);
  await page.locator('#choose-folder').click(); assert.equal(await page.locator('#open-native-history').isDisabled(), false); await page.locator('#cancel-create').click();
  check('Choose existing preserves original files and permissions wording; reset restores automatic mode; Claude history requires its original directory');

  const collision = await open('Collision'); fs.mkdirSync(collision); fs.writeFileSync(path.join(collision, 'keep'), 'Never overwrite');
  const before = (await state()).sessions.length; await page.locator('#confirm-create').click();
  await until(async () => (await page.locator('#create-error').innerText()).includes('已存在'), 'Visible directory collision');
  await until(async () => !(await page.locator('#confirm-create').isDisabled()), 'Create failure acknowledgement');
  assert.equal((await state()).sessions.length, before); assert.equal(fs.readFileSync(path.join(collision, 'keep'), 'utf8'), 'Never overwrite');
  assert.notEqual(await preview(), collision); assert.equal(await page.locator('#session-name').inputValue(), 'Collision'); await shot('02-collision'); await page.locator('#cancel-create').click();
  const missing = path.join(profile, 'missing-folder'); await app.evaluate((_, cwd) => { globalThis.directoryPick = cwd; }, missing);
  await open('Missing'); await page.locator('#choose-folder').click(); await page.locator('#confirm-create').click(); await until(async () => (await page.locator('#create-error').innerText()).includes('工作目录不可用'), 'Missing existing folder');
  assert.equal(fs.existsSync(missing), false); await page.locator('#cancel-create').click();
  check('Collision and missing existing folder show errors without launch or overwrite, preserve name and refresh only the automatic preview');

  const failedPath = await open('Synthetic startup failure'); await page.locator('#confirm-create').click();
  await until(async () => (await page.locator('#create-error').innerText()).includes('Synthetic native startup failed'), 'Native startup failure visible');
  const failed = (await state()).sessions.find(s => s.cwd === failedPath);
  assert.equal(failed.state, 'error'); assert.equal(fs.readFileSync(path.join(failedPath, 'started.txt'), 'utf8'), 'Retain native writes');
  assert.ok((await page.locator('#create-error').innerText()).includes(failed.id.replaceAll('-', '').slice(0, 6)), 'Failure identifies the exact saved row');
  assert.notEqual(await preview(), failedPath); await shot('03-startup-failure'); await page.locator('#cancel-create').click();
  const closedPath = await open('Closed startup failure'); await page.locator('#confirm-create').click();
  await until(() => fs.existsSync(path.join(closedPath, 'started.txt')), 'Held native startup has actually begun');
  const closed = (await client.call('initial')).sessions.find(s => s.cwd === closedPath);
  await page.keyboard.press('Escape'); await page.locator('#create-dialog').waitFor({ state: 'hidden' });
  child.send({ method: 'directory-fail-start', target: closed.id });
  await until(async () => (await page.locator('#toast').innerText()).includes('Synthetic closed startup failed'), 'Failure remains visible after Escape closes the dialog');
  assert.equal(fs.readFileSync(path.join(closedPath, 'started.txt'), 'utf8'), 'Retain native writes');
  check('Actual fixture start failure preserves files and exact error row; failure after Escape stays visible as a toast without resend');

  await page.locator(`[data-session-id="${existing.id}"]`).click(); const draft = 'Unsent original draft 你好'; await page.locator('#message-input').fill(draft);
  await until(async () => (await client.call('initial')).sessions.find(s => s.id === existing.id)?.liveDraft === draft, 'Original draft saved');
  const originalIds = (await state()).sessions.map(s => [s.id, s.nativeId, s.cwd]);
  await page.reload(); await page.locator('#new-session').waitFor();
  assert.deepEqual((await state()).sessions.map(s => [s.id, s.nativeId, s.cwd]), originalIds);
  await page.locator(`[data-session-id="${existing.id}"]`).click(); assert.equal(await page.locator('#message-input').inputValue(), draft);
  assert.deepEqual(fs.readdirSync(legacy), ['keep.txt']); assert.equal(fs.readFileSync(path.join(legacy, 'keep.txt'), 'utf8'), 'Existing files unchanged');
  assert.equal((await state()).diagnostics.dispatches, 0); assert.deepEqual(errors, []);
  check('Renderer reload retains exact native IDs, working folders and existing draft, with no dispatches or page errors');
  await app.evaluate((_, code) => {
    const load = process.getBuiltinModule('module').createRequire(code + '/package.json'), { WorkspaceClient } = load(code + '/app/workspace-client.cjs');
    globalThis.directorySnapshot = WorkspaceClient.prototype.snapshot;
    WorkspaceClient.prototype.snapshot = function () { const s = globalThis.directorySnapshot.call(this); s.capabilities = s.capabilities.filter(c => c !== 'newSessionDirectory'); delete s.newWorkspaceRoot; return s; };
  }, code);
  await page.reload(); await page.locator('#new-session').waitFor();
  const oldPreview = await open('Old backend'); assert.equal(oldPreview, legacy); assert.equal(await page.locator('#new-folder').isVisible(), false);
  assert.match(await page.locator('#create-permission-note').innerText(), /已有目录/); assert.doesNotMatch(await page.locator('#create-permission-note').innerText(), /空目录/);
  const old = await submit('Old backend'); assert.equal(old.cwd, legacy);
  await app.evaluate((_, code) => { const load = process.getBuiltinModule('module').createRequire(code + '/package.json'); load(code + '/app/workspace-client.cjs').WorkspaceClient.prototype.snapshot = globalThis.directorySnapshot; }, code);
  check('An older active backend shows the actual existing shared folder and wording, hides automatic mode and creates without a new-directory flag');
  if (evidence) fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ checks, errors, profile, legacy, sessions: originalIds, productModelCalls: 0, providers: 0 }, null, 2));
}
scratch.cleanup(async () => {
  if (app) { await app.evaluate(({ dialog }) => { if (globalThis.directoryDialog) dialog.showOpenDialog = globalThis.directoryDialog; }).catch(() => {}); await app.close(); }
  if (client) { for (const s of (await client.call('initial')).sessions) await client.call('stop', s.id); await client.call('shutdown'); client.close(); }
  if (child.connected) child.disconnect(); if (child.exitCode === null) child.kill('SIGTERM');
});
run().catch(async e => { console.error(e.stack); console.error(JSON.stringify({ checks, errors })); process.exitCode = 1; await shot('failure').catch(() => {}); }).finally(async () => {
  try { await scratch.release(); assert.equal(JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))).token, token); fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot); if (evidence) fs.writeFileSync(path.join(evidence, 'released.json'), JSON.stringify({ ...owner, releasedAt: new Date().toISOString(), profileGone: !fs.existsSync(profile) }, null, 2)); console.log('Owned GUI/profiles cleaned; canonical token released.'); }
  catch (e) { console.error('Cleanup unconfirmed; retain canonical lock:', e.stack); process.exitCode = 1; }
});
