// T-115: 开始一个会话 can put the new session in a collaboration space: independent (default), an existing space, or a
// new space it names. Real isolated Electron + service; only the native transport is synthetic. Failures are injected by
// wrapping the app's own IPC handlers, and each handler call is counted, so a retry provably creates nothing twice.
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
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Claude 2', task: 'T-115 create space choice', token, pid: process.pid, createdAt: new Date().toISOString() }));
const profile = scratch.directory(path.join(os.tmpdir(), 'naw-create-space-'));
const legacy = path.join(profile, 'workspace'); fs.mkdirSync(legacy);
const child = scratch.childProcess.fork(path.join(code, 'app/daemon.cjs'), [profile], { execArgv: ['--require', path.join(__dirname, 'fixtures/loading-terminal.cjs')], env: { ...process.env, NAW_TEST_APP_ROOT: code, NAW_WORKSPACE: legacy, NAW_APP_VERSION: require(path.join(code, 'package.json')).version }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
let app, page, client; const checks = [], errors = [], delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { for (let i = 0; i < 160; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
const state = () => page.evaluate(() => workspace.initial());
const shot = name => evidence ? page.screenshot({ path: path.join(evidence, name + '.png') }) : Promise.resolve();
const check = text => { checks.push(text); console.log('PASS:', text); };
const named = async name => (await state()).sessions.filter(s => s.name === name);
const roomsNamed = async name => (await state()).rooms.filter(r => r.name === name && !r.archived);
const memberOf = (id, roomId) => page.evaluate(([id, roomId]) => workspace.initial().then(s => window.nativeWorkspaceSpaces.isMember(s.sessions.find(x => x.id === id), roomId)), [id, roomId]);
const spacesOf = id => page.evaluate(id => workspace.initial().then(s => s.rooms.filter(r => window.nativeWorkspaceSpaces.isMember(s.sessions.find(x => x.id === id), r.id)).map(r => r.id)), id);
const calls = () => app.evaluate(() => ({ ...globalThis.t115Calls }));
// Wrap the app's own handlers: count every call; a queued fault replaces (before) or follows (after) the real handler.
// A fault is returned the way register() returns any handler error, { ok: false, error }, so the renderer sees a real failure.
async function instrument() {
  await app.evaluate(({ ipcMain }) => {
    globalThis.t115Calls = { create: 0, spaceCreate: 0, join: 0 }; globalThis.t115Faults = [];
    for (const name of ['create', 'spaceCreate', 'spaceAction']) {
      const key = 'workspace:' + name, original = ipcMain._invokeHandlers.get(key); if (!original) throw Error(key);
      ipcMain._invokeHandlers.set(key, async (event, ...args) => {
        const kind = name === 'spaceAction' ? (args[1] === 'join' ? 'join' : '') : name; if (kind) globalThis.t115Calls[kind]++;
        const fault = kind && globalThis.t115Faults.findIndex(f => f.kind === kind), queued = fault >= 0 ? globalThis.t115Faults.splice(fault, 1)[0] : null;
        if (queued?.when === 'before') return { ok: false, error: 'Synthetic ' + kind + ' failure' };
        const result = await original(event, ...args);
        if (queued?.when === 'after') return { ok: false, error: 'Synthetic ' + kind + ' reply lost' };
        return result;
      });
    }
  });
}
const fault = (kind, when) => app.evaluate((_, f) => { globalThis.t115Faults.push(f); }, { kind, when });
async function open(name, provider = 'codex') {
  await page.locator('#new-session').click(); await page.locator(`input[name="provider"][value="${provider}"]`).check();
  if (provider === 'codex') await page.locator('#initial-view').selectOption('chat');
  await page.locator('#session-name').fill(name);
}
async function launch() {
  app = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [code], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(8000); page.on('pageerror', e => errors.push(e.message)); await page.locator('#new-session').waitFor();
  await instrument();
  // The folder picker returns a path the test sets, as in test-session-directory.
  await app.evaluate(({ dialog }) => { globalThis.t115Pick = null; dialog.showOpenDialog = async () => globalThis.t115Pick ? { canceled: false, filePaths: [globalThis.t115Pick] } : { canceled: true, filePaths: [] }; });
}
const pick = folder => app.evaluate((_, folder) => { globalThis.t115Pick = folder; }, folder);
async function createdInto(name, roomId) {
  await page.locator('#create-space-kind').selectOption('existing'); await page.locator('#create-space-existing').selectOption(roomId);
  await page.locator('#confirm-create').click(); await page.locator('#create-dialog').waitFor({ state: 'hidden', timeout: 20000 });
  const [record] = await named(name); assert.ok(record, name + ' exists'); assert.deepEqual(await spacesOf(record.id), [roomId], name + ' joined'); return record;
}
async function run() {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Own fixture startup'); client = await connect(profile, 'create-space-observer');
  await launch();
  const studyId = await page.evaluate(() => workspace.spaceCreate('学习小组'));

  // 1. Independent stays the default and changes nothing about creation.
  await open('独立会话');
  assert.equal(await page.locator('#create-space-kind').inputValue(), 'independent');
  assert.equal(await page.locator('#create-space-help').isVisible(), false);
  assert.equal(await page.locator('#confirm-create').innerText(), '创建会话');
  await page.locator('#confirm-create').click(); await page.locator('#create-dialog').waitFor({ state: 'hidden' });
  const [solo] = await named('独立会话'); assert.ok(solo); assert.deepEqual(await spacesOf(solo.id), []);
  assert.equal(path.dirname(solo.cwd), legacy + '-sessions', 'Independent creation keeps the automatic private directory');
  check('Independent is the default: the session is created as before, in its own new directory, and joins no space');

  // 2. An incomplete choice creates nothing; cancel creates nothing.
  const before = await calls();
  await open('取消的会话'); await page.locator('#create-space-kind').selectOption('existing');
  assert.equal(await page.locator('#confirm-create').isDisabled(), true); assert.match(await page.locator('#create-readiness').innerText(), /选择一个还在的协作空间/);
  await page.locator('#create-space-kind').selectOption('new');
  assert.equal(await page.locator('#create-space-name').inputValue(), '取消的会话', 'A new space is prefilled with the session name');
  await page.locator('#create-space-name').fill('   ');
  assert.equal(await page.locator('#confirm-create').isDisabled(), true); assert.match(await page.locator('#create-readiness').innerText(), /新空间的名称/);
  assert.equal(await page.locator('#open-native-history').isDisabled(), true, 'Continuing a session cannot also take a space choice');
  assert.equal(await page.locator('#create-space-kind').getAttribute('aria-describedby'), 'create-space-help');
  assert.match(await page.locator('#create-space-help').innerText(), /先继续，再从会话菜单加入空间/);
  await page.locator('#create-space-name').fill('不会建出的空间'); assert.equal(await page.locator('#confirm-create').innerText(), '创建并加入空间');
  await shot('01-new-space-choice');
  await page.locator('#cancel-create').click(); await page.locator('#create-dialog').waitFor({ state: 'hidden' });
  assert.deepEqual(await calls(), before); assert.deepEqual(await named('取消的会话'), []); assert.deepEqual(await roomsNamed('不会建出的空间'), []);
  check('A missing space or a blank name disables 创建 with the reason; cancel creates no session and no space');

  // 3. Join an existing space (Claude entry).
  await open('学习助手', 'claude'); await page.locator('#create-space-kind').selectOption('existing');
  assert.ok((await page.locator('#create-space-existing option').allInnerTexts()).includes('学习小组'));
  await page.locator('#create-space-existing').selectOption(studyId);
  await page.locator('#confirm-create').click(); await page.locator('#create-dialog').waitFor({ state: 'hidden' });
  const [helper] = await named('学习助手'); assert.equal(helper.provider, 'claude'); assert.deepEqual(await spacesOf(helper.id), [studyId]);
  await until(async () => (await page.locator('#toast-text').innerText()).includes('新会话已加入「学习小组」'), 'Join toast');
  check('A Claude session created with 加入已有空间 is a member of exactly that space, and the result is shown');

  // 4. Create a new space and join (Codex entry).
  await open('周末计划'); await page.locator('#create-space-kind').selectOption('new');
  await page.locator('#create-space-name').fill('周末小组');
  await page.locator('#confirm-create').click(); await page.locator('#create-dialog').waitFor({ state: 'hidden' });
  const [weekend] = await named('周末计划'), [weekendRoom] = await roomsNamed('周末小组');
  assert.ok(weekendRoom); assert.deepEqual(await spacesOf(weekend.id), [weekendRoom.id]);
  assert.equal(path.dirname(weekend.cwd), legacy + '-sessions', 'A spaced session still gets its own new directory');
  check('新建空间并加入 creates one space with the typed name; the new session is its member, in its own new directory');

  // 4b. The space choice works with a chosen folder, a Git work copy and skipped permissions.
  await pick(legacy); await open('已有目录'); await page.locator('#choose-folder').click();
  assert.equal(await page.locator('#chosen-folder').innerText(), legacy);
  const chosenFolder = await createdInto('已有目录', studyId); assert.equal(chosenFolder.cwd, legacy);
  // A Git copy refuses a path through a link (/var is a link to /private/var on macOS), so the repo is picked by its real path.
  fs.mkdirSync(path.join(profile, 'repo')); const repo = fs.realpathSync(path.join(profile, 'repo')); fs.writeFileSync(path.join(repo, 'notes.md'), 'committed\n');
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=T115 Test', '-c', 'user.email=t115@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
  git('init', '-q'); git('add', 'notes.md'); git('commit', '-q', '-m', 'Synthetic commit');
  await pick(repo); await open('Git 副本'); await page.locator('#choose-folder').click(); await page.locator('#git-worktree').check();
  await until(async () => (await page.locator('#git-worktree-preview').innerText()).includes('工作目录：'), 'Git copy preview ready');
  const copyPath = (await page.locator('#git-worktree-preview').innerText()).match(/工作目录：(.+)$/m)[1].trim();
  const copy = await createdInto('Git 副本', weekendRoom.id); assert.equal(copy.cwd, copyPath); assert.ok(fs.existsSync(path.join(copyPath, 'notes.md')), 'The work copy holds the committed file');
  await open('跳过确认'); assert.equal(await page.locator('#skip-permissions-option').isVisible(), true); await page.locator('#skip-permissions').check();
  const skipped = await createdInto('跳过确认', studyId); assert.equal(skipped.skipPermissions, true);
  check('A space choice combines with a chosen folder, a Git work copy and skipped permissions; each keeps its own effect');

  // 4c. Creating the session fails with a space chosen.
  let markCreate = await calls(); await fault('create', 'before');
  await open('会话失败'); await page.locator('#create-space-kind').selectOption('existing'); await page.locator('#create-space-existing').selectOption(studyId);
  await page.locator('#confirm-create').click();
  await until(async () => (await page.locator('#create-error').innerText()).includes('Synthetic create failure'), 'Create failure shown');
  assert.deepEqual(await named('会话失败'), [], 'Nothing was created'); assert.equal(await page.locator('#confirm-create').innerText(), '创建并加入空间');
  assert.equal(await page.locator('#session-name').isDisabled(), false, 'With nothing created the form stays editable');
  await page.locator('#confirm-create').click(); await page.locator('#create-dialog').waitFor({ state: 'hidden' });
  const [createRetry] = await named('会话失败'); assert.deepEqual(await spacesOf(createRetry.id), [studyId]);
  let nowCreate = await calls(); assert.deepEqual([nowCreate.create - markCreate.create, nowCreate.spaceCreate - markCreate.spaceCreate, nowCreate.join - markCreate.join], [2, 0, 1]);
  markCreate = nowCreate; await fault('create', 'after');
  await open('会话回复丢失'); await page.locator('#create-space-kind').selectOption('new'); await page.locator('#create-space-name').fill('回复丢失小组');
  await page.locator('#confirm-create').click();
  await until(async () => (await page.locator('#create-error').innerText()).includes('不会重建会话'), 'Kept session adopted');
  assert.equal((await named('会话回复丢失')).length, 1); assert.equal(await page.locator('#confirm-create').innerText(), '仅继续加入');
  await page.locator('#confirm-create').click(); await page.locator('#create-dialog').waitFor({ state: 'hidden' });
  const [createLost] = await named('会话回复丢失'), createLostRooms = await roomsNamed('回复丢失小组');
  assert.equal((await named('会话回复丢失')).length, 1); assert.equal(createLostRooms.length, 1); assert.deepEqual(await spacesOf(createLost.id), [createLostRooms[0].id]);
  nowCreate = await calls(); assert.deepEqual([nowCreate.create - markCreate.create, nowCreate.spaceCreate - markCreate.spaceCreate, nowCreate.join - markCreate.join], [1, 1, 1]);
  check('A failed session creation retries only when nothing was created; a session kept despite the error is joined, not created again');

  // 5. The space write happened but its reply was lost: the one new space is kept, not created again.
  let mark = await calls(); await fault('spaceCreate', 'after');
  await open('丢失回复'); await page.locator('#create-space-kind').selectOption('new');
  await page.locator('#confirm-create').click(); await page.locator('#create-dialog').waitFor({ state: 'hidden' });
  const [lost] = await named('丢失回复'), lostRooms = await roomsNamed('丢失回复');
  assert.equal(lostRooms.length, 1, 'Exactly one space exists'); assert.deepEqual(await spacesOf(lost.id), [lostRooms[0].id]);
  let now = await calls(); assert.deepEqual([now.create - mark.create, now.spaceCreate - mark.spaceCreate, now.join - mark.join], [1, 1, 1]);
  check('When the space was written but the reply failed, that one space is used: no second space, the session joins it');

  // 6. Creating the space fails: the session is kept, everything but retry is locked, retry creates only the space.
  mark = await calls(); await fault('spaceCreate', 'before');
  await open('空间失败'); await page.locator('#create-space-kind').selectOption('new'); await page.locator('#create-space-name').fill('重试小组');
  await page.locator('#confirm-create').click();
  await until(async () => (await page.locator('#create-error').innerText()).includes('还没加入空间'), 'Space failure shown in the dialog');
  const [spaceFail] = await named('空间失败'); assert.ok(spaceFail, 'The created session is kept'); assert.deepEqual(await roomsNamed('重试小组'), []);
  assert.match(await page.locator('#create-error').innerText(), /会话“空间失败”已保留在侧栏；还没加入空间：Synthetic spaceCreate failure。可以点「仅继续加入」再试/);
  assert.equal(await page.locator('#confirm-create').innerText(), '仅继续加入'); assert.equal(await page.locator('#cancel-create').innerText(), '关闭，保留结果');
  for (const id of ['#session-name', '#create-space-kind', '#create-space-name', '#choose-folder', 'input[name="provider"][value="claude"]']) assert.equal(await page.locator(id).isDisabled(), true, id + ' is locked after the session exists');
  await shot('02-space-failure-retry');
  await page.locator('#confirm-create').click(); await page.locator('#create-dialog').waitFor({ state: 'hidden' });
  const retryRooms = await roomsNamed('重试小组'); assert.equal(retryRooms.length, 1); assert.deepEqual(await spacesOf(spaceFail.id), [retryRooms[0].id]);
  assert.equal((await named('空间失败')).length, 1, 'Retry did not create the session again');
  now = await calls(); assert.deepEqual([now.create - mark.create, now.spaceCreate - mark.spaceCreate, now.join - mark.join], [1, 2, 1]);
  check('A failed space creation keeps the session, locks the form, and 仅继续加入 creates only the space and joins');

  // 7. Joining fails: retry joins without creating the session again.
  mark = await calls(); await fault('join', 'before');
  await open('加入失败'); await page.locator('#create-space-kind').selectOption('existing'); await page.locator('#create-space-existing').selectOption(studyId);
  await page.locator('#confirm-create').click();
  await until(async () => (await page.locator('#create-error').innerText()).includes('Synthetic join failure'), 'Join failure shown');
  const [joinFail] = await named('加入失败'); assert.deepEqual(await spacesOf(joinFail.id), []);
  assert.match(await page.locator('#create-error').innerText(), /空间「学习小组」也已保留/);
  await page.locator('#confirm-create').click(); await page.locator('#create-dialog').waitFor({ state: 'hidden' });
  assert.deepEqual(await spacesOf(joinFail.id), [studyId]); assert.equal((await named('加入失败')).length, 1);
  now = await calls(); assert.deepEqual([now.create - mark.create, now.spaceCreate - mark.spaceCreate, now.join - mark.join], [1, 0, 2]);
  check('A failed join keeps the session and space; 仅继续加入 joins once more without creating anything again');

  // 8. Closing after a partial failure keeps what exists and starts nothing more.
  mark = await calls(); await fault('join', 'before');
  await open('关闭保留'); await page.locator('#create-space-kind').selectOption('existing'); await page.locator('#create-space-existing').selectOption(studyId);
  await page.locator('#confirm-create').click();
  await until(async () => (await page.locator('#create-error').innerText()).includes('Synthetic join failure'), 'Second join failure shown');
  await page.locator('#cancel-create').click(); await page.locator('#create-dialog').waitFor({ state: 'hidden' }); await delay(300);
  const [closed] = await named('关闭保留'); assert.ok(closed); assert.deepEqual(await spacesOf(closed.id), []);
  now = await calls(); assert.deepEqual([now.create - mark.create, now.spaceCreate - mark.spaceCreate, now.join - mark.join], [1, 0, 1]);
  await open('下一次'); assert.equal(await page.locator('#create-space-kind').inputValue(), 'independent'); assert.equal(await page.locator('#confirm-create').innerText(), '创建会话');
  assert.equal(await page.locator('#session-name').isDisabled(), false); await page.locator('#cancel-create').click();
  check('关闭，保留结果 keeps the session outside the space and starts no further step; the next opening starts fresh');

  // 9. Memberships survive a whole-app reopen.
  const expected = { [solo.id]: [], [helper.id]: [studyId], [weekend.id]: [weekendRoom.id], [chosenFolder.id]: [studyId], [copy.id]: [weekendRoom.id], [skipped.id]: [studyId], [createRetry.id]: [studyId], [createLost.id]: [createLostRooms[0].id], [lost.id]: [lostRooms[0].id], [spaceFail.id]: [retryRooms[0].id], [joinFail.id]: [studyId], [closed.id]: [] };
  await app.close(); app = null; await launch();
  for (const [id, rooms] of Object.entries(expected)) assert.deepEqual(await spacesOf(id), rooms, 'Membership after reopen: ' + id);
  await page.locator(`[data-session-id="${helper.id}"]`).first().waitFor();
  await shot('03-after-reopen');
  assert.equal((await state()).diagnostics.dispatches, 0); assert.deepEqual(errors, []);
  check('After a whole-app reopen every session is in exactly the spaces it was created into; no dispatches or page errors');
  if (evidence) fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ checks, errors, profile, productModelCalls: 0, providers: 0 }, null, 2));
}
scratch.cleanup(async () => {
  if (app) await app.close();
  if (client) { for (const s of (await client.call('initial')).sessions) await client.call('stop', s.id); await client.call('shutdown'); client.close(); }
  if (child.connected) child.disconnect(); if (child.exitCode === null) child.kill('SIGTERM');
});
run().catch(async e => { console.error(e.stack); console.error(JSON.stringify({ checks, errors })); process.exitCode = 1; await shot('failure').catch(() => {}); }).finally(async () => {
  try { await scratch.release(); assert.equal(JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))).token, token); fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot); }
  catch (e) { console.error('Cleanup unconfirmed; retain canonical lock:', e.stack); process.exitCode = 1; }
});
