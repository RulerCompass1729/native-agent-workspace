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
    globalThis.t115Calls = { create: 0, spaceCreate: 0, join: 0, initial: 0 }; globalThis.t115Faults = [];
    for (const name of ['create', 'spaceCreate', 'spaceAction', 'initial']) {
      const key = 'workspace:' + name, original = ipcMain._invokeHandlers.get(key); if (!original) throw Error(key);
      ipcMain._invokeHandlers.set(key, async (event, ...args) => {
        const kind = name === 'spaceAction' ? (args[1] === 'join' ? 'join' : '') : name; if (kind) globalThis.t115Calls[kind]++;
        // A sticky fault stays queued (every matching call fails) until the test clears it.
        const fault = kind && globalThis.t115Faults.findIndex(f => f.kind === kind), found = fault >= 0 ? globalThis.t115Faults[fault] : null;
        const queued = found && !found.sticky ? globalThis.t115Faults.splice(fault, 1)[0] : found;
        if (queued?.when === 'hold') await new Promise(resolve => { globalThis.t115Held = resolve; }); // released by the test
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

  // 4d. The session is created but the next two reads of the state fail: its returned id is kept (I158).
  markCreate = await calls(); await fault('initial', 'before'); await fault('initial', 'before');
  await open('读取失败'); await page.locator('#create-space-kind').selectOption('existing'); await page.locator('#create-space-existing').selectOption(studyId);
  await page.locator('#confirm-create').click();
  await until(async () => (await page.locator('#create-error').innerText()).includes('可以点「仅继续加入」'), 'The returned id is kept despite two failed reads');
  assert.equal(await page.locator('#confirm-create').innerText(), '仅继续加入');
  await page.locator('#confirm-create').click(); await page.locator('#create-dialog').waitFor({ state: 'hidden' });
  const [readFail] = await named('读取失败'); assert.equal((await named('读取失败')).length, 1); assert.deepEqual(await spacesOf(readFail.id), [studyId]);
  nowCreate = await calls(); assert.deepEqual([nowCreate.create - markCreate.create, nowCreate.join - markCreate.join], [1, 1]);
  markCreate = nowCreate; await fault('initial', 'before'); await fault('initial', 'before');
  await open('独立读取失败'); const keptFolder = await page.locator('#chosen-folder').innerText(); await page.locator('#confirm-create').click();
  await until(async () => (await page.locator('#create-error').innerText()).includes('保留在侧栏'), 'An independent session is reported kept');
  assert.equal(await page.locator('#chosen-folder').innerText(), keptFolder, 'Its folder is kept, not replaced by a new one');
  const noSecond = async name => {
    assert.equal(await page.locator('#confirm-create').isDisabled(), true, name + ': 创建 is off once the session exists');
    assert.match(await page.locator('#create-readiness').innerText(), /关闭对话框即可；这里不会再建一个/);
    assert.equal(await page.locator('#cancel-create').innerText(), '关闭，保留结果');
    assert.equal(await page.locator('#git-worktree-source-help').isVisible(), false, name + ': no Git copy instruction while the form is locked');
    // I159: continuing or branching another session, or another folder, would add a session too.
    for (const id of ['#open-native-history', '#choose-folder', '#new-folder']) assert.equal(await page.locator(id).isDisabled(), true, name + ': ' + id + ' is off');
    await page.locator('#cancel-create').click(); assert.equal((await named(name)).length, 1, name + ': one session');
  };
  await noSecond('独立读取失败'); const [readFailSolo] = await named('独立读取失败');
  // The same with a chosen existing folder, which several sessions may share: only the disabled 创建 prevents a second.
  await fault('initial', 'before'); await fault('initial', 'before');
  await pick(legacy); await open('已有目录读取失败'); await page.locator('#choose-folder').click(); await page.locator('#confirm-create').click();
  await until(async () => (await page.locator('#create-error').innerText()).includes('保留在侧栏'), 'A chosen-folder session is reported kept');
  await noSecond('已有目录读取失败'); const [readFailFolder] = await named('已有目录读取失败'); assert.equal(readFailFolder.cwd, legacy);
  // No id and no fresh read: whether it exists is unknown, so the dialog asks for a look and keeps the folder.
  markCreate = await calls(); await fault('create', 'after'); await fault('initial', 'before');
  await open('结果未知'); const unknownFolder = await page.locator('#chosen-folder').innerText(); await page.locator('#confirm-create').click();
  await until(async () => (await page.locator('#create-error').innerText()).includes('无法确认会话是否已经建好'), 'An unknown result asks for a look');
  assert.equal(await page.locator('#chosen-folder').innerText(), unknownFolder, 'The folder is not replaced, so a retry cannot land elsewhere');
  await page.locator('#confirm-create').click();
  // I159: the retry meets the folder the first attempt made, so the session very likely exists; no third try. I160: the
  // service's advice to use another folder is not shown beside a locked form.
  await until(async () => await page.locator('#confirm-create').isDisabled(), 'A retry stops at the folder the first attempt created');
  assert.match(await page.locator('#create-error').innerText(), /会话很可能已经建好|已保留在侧栏/); assert.doesNotMatch(await page.locator('#create-error').innerText(), /请改用新目录/);
  assert.equal(await page.locator('#chosen-folder').innerText(), unknownFolder, 'Still the same folder');
  // Which of the two the retry reaches depends on whether a state push already listed the first session (then it is found and kept).
  assert.equal(await page.locator('#confirm-create').isDisabled(), true); assert.match(await page.locator('#create-readiness').innerText(), /无法确认会话是否已经建好|会话已建好并保留在侧栏/);
  await page.locator('#cancel-create').click(); assert.equal((await named('结果未知')).length, 1, 'Still one session');
  // I159: with a chosen existing folder, which other sessions may share, an unknown result stops this dialog at once.
  await fault('create', 'after'); await fault('initial', 'before');
  await pick(legacy); await open('已有目录结果未知'); await page.locator('#choose-folder').click(); await page.locator('#confirm-create').click();
  await until(async () => (await page.locator('#create-error').innerText()).includes('关掉对话框重新打开再建'), 'An unknown result in a shared folder stops the dialog');
  assert.equal(await page.locator('#confirm-create').isDisabled(), true); await page.locator('#cancel-create').click();
  assert.equal((await named('已有目录结果未知')).length, 1); const [unknownShared] = await named('已有目录结果未知');
  const [unknownSolo] = await named('结果未知');
  check('Once a created session\'s id is known, the dialog offers no second 创建, continue or branch (automatic or chosen folder); an unknown result asks for a look, keeps its folder, and stops once its folder proves taken or is shared');

  // 4e. A step that retrying can't fix ends the retry instead of inviting it.
  const doomedId = await page.evaluate(() => workspace.spaceCreate('将归档'));
  await fault('join', 'before'); await open('归档后加入'); await page.locator('#create-space-kind').selectOption('existing'); await page.locator('#create-space-existing').selectOption(doomedId);
  await page.locator('#confirm-create').click();
  await until(async () => (await page.locator('#create-error').innerText()).includes('Synthetic join failure'), 'Join failure before archiving');
  await page.evaluate(id => workspace.spaceAction(id, 'archive', []), doomedId);
  await page.locator('#confirm-create').click();
  await until(async () => (await page.locator('#create-error').innerText()).includes('请关闭对话框'), 'An archived space ends the retry');
  assert.doesNotMatch(await page.locator('#create-error').innerText(), /可以点「仅继续加入」/); assert.equal(await page.locator('#confirm-create').isDisabled(), true);
  await page.locator('#cancel-create').click(); const [doomed] = await named('归档后加入'); assert.deepEqual(await spacesOf(doomed.id), []);
  check('When the space was archived meanwhile, the dialog says to close instead of retrying, and 仅继续加入 is off');

  // 4f. I160 ①: the selection moves while an independent create is in flight (the focused member leaves its space).
  await open('焦点成员'); const focusMember = await createdInto('焦点成员', studyId);
  await page.locator(`[data-space-id="${studyId}"] .room-nav`).first().click(); await page.locator('#room-overview').click();
  await page.locator(`#collaboration-overview .collaboration-member-status[data-member-id="${focusMember.id}"] .collaboration-member-name`).click();
  await fault('create', 'hold'); await open('视图变了'); await page.locator('#confirm-create').click();
  await until(() => app.evaluate(() => Boolean(globalThis.t115Held)), 'Create held');
  await page.evaluate(([room, id]) => workspace.spaceAction(room, 'join', [id, false]), [studyId, focusMember.id]);
  await until(async () => (await spacesOf(focusMember.id)).length === 0, 'The focused member left');
  await app.evaluate(() => { const release = globalThis.t115Held; globalThis.t115Held = null; release(); });
  await until(async () => (await named('视图变了')).length === 1, 'The held create finished');
  // Wait for the stopped text, not just a disabled button: buttons are also off while the request is in flight.
  await until(async () => /关闭对话框即可；这里不会再建一个/.test(await page.locator('#create-readiness').innerText()), 'The still-open dialog is stopped');
  assert.equal(await page.locator('#create-dialog').evaluate(d => d.open), true, 'The moved selection kept the dialog open');
  assert.match(await page.locator('#create-readiness').innerText(), /关闭对话框即可；这里不会再建一个/);
  await page.locator('#cancel-create').click(); assert.equal((await named('视图变了')).length, 1); const [movedView] = await named('视图变了');
  // 4f. I160 ②: no id came back, but the fresh read finds the new, working session: the dialog stops too.
  markCreate = await calls(); await fault('create', 'after');
  await open('找回会话'); await page.locator('#confirm-create').click();
  await until(async () => (await page.locator('#create-error').innerText()).includes('已保留在侧栏'), 'The found session is reported kept');
  assert.equal(await page.locator('#confirm-create').isDisabled(), true); await page.locator('#cancel-create').click();
  assert.equal((await named('找回会话')).length, 1); const [foundAgain] = await named('找回会话');
  check('A session from this opening stops the dialog even when the selection moved meanwhile or no id came back; the found session is not created twice');

  // 4g. I161: 从已有 Claude 会话分支… creates through its own path; the same stop applies there.
  const forkStopped = async name => {
    for (const id of ['#confirm-create', '#open-native-history']) assert.equal(await page.locator(id).isDisabled(), true, name + ': ' + id + ' is off');
    assert.match(await page.locator('#create-readiness').innerText(), /关闭对话框即可；这里不会再建一个/);
    await page.locator('#cancel-create').click(); assert.equal((await named(name)).length, 1, name + ': one session');
  };
  // ① The selection moves while the branch is being created (another focused member leaves).
  await open('焦点成员二'); const focusMember2 = await createdInto('焦点成员二', studyId);
  await page.locator(`[data-space-id="${studyId}"] .room-nav`).first().click(); await page.locator('#room-overview').click();
  await page.locator(`#collaboration-overview .collaboration-member-status[data-member-id="${focusMember2.id}"] .collaboration-member-name`).click();
  await pick(legacy); await fault('create', 'hold'); await open('分支视图变了', 'claude'); await page.locator('#choose-folder').click();
  assert.match(await page.locator('#open-native-history').innerText(), /从已有 Claude 会话分支/); await page.locator('#open-native-history').click();
  await until(() => app.evaluate(() => Boolean(globalThis.t115Held)), 'Branch create held');
  await page.evaluate(([room, id]) => workspace.spaceAction(room, 'join', [id, false]), [studyId, focusMember2.id]);
  await until(async () => (await spacesOf(focusMember2.id)).length === 0, 'The second focused member left');
  await app.evaluate(() => { const release = globalThis.t115Held; globalThis.t115Held = null; release(); });
  await until(async () => (await named('分支视图变了')).length === 1, 'The held branch finished');
  await until(async () => /关闭对话框即可；这里不会再建一个/.test(await page.locator('#create-readiness').innerText()), 'The still-open dialog is stopped after a branch');
  assert.equal(await page.locator('#create-dialog').evaluate(d => d.open), true, 'The moved selection kept the dialog open');
  await forkStopped('分支视图变了'); const [forkMoved] = await named('分支视图变了');
  // ② The branch returns its id but the next read fails: the id is kept, so the dialog stops.
  await fault('initial', 'before'); await open('分支读取失败', 'claude'); await page.locator('#choose-folder').click(); await page.locator('#open-native-history').click();
  await until(async () => /关闭对话框即可；这里不会再建一个/.test(await page.locator('#create-readiness').innerText()), 'A branch whose read failed still stops the dialog');
  await forkStopped('分支读取失败'); const [forkReadFail] = await named('分支读取失败');
  // ③ The branch's reply is lost although its session was made: found again, it stops the dialog.
  await fault('create', 'after'); await open('分支回复丢失', 'claude'); await page.locator('#choose-folder').click(); await page.locator('#open-native-history').click();
  await until(async () => /关闭对话框即可；这里不会再建一个/.test(await page.locator('#create-readiness').innerText()), 'A branch found again stops the dialog');
  await forkStopped('分支回复丢失'); const [forkLost] = await named('分支回复丢失');
  // ④ The reply is lost and the read fails too: nobody can tell, so the dialog stops as unconfirmed.
  await fault('create', 'after'); await fault('initial', 'before'); await open('分支结果未知', 'claude'); await page.locator('#choose-folder').click(); await page.locator('#open-native-history').click();
  await until(async () => /无法确认会话是否已经建好/.test(await page.locator('#create-readiness').innerText()), 'An unknown branch result stops the dialog');
  for (const id of ['#confirm-create', '#open-native-history']) assert.equal(await page.locator(id).isDisabled(), true, '分支结果未知: ' + id + ' is off');
  assert.match(await page.locator('#create-readiness').innerText(), /无法确认会话是否已经建好/);
  await page.locator('#cancel-create').click(); assert.equal((await named('分支结果未知')).length, 1); const [forkUnknown] = await named('分支结果未知');
  check('从已有 Claude 会话分支… stops the dialog once its session exists, also when the selection moved, the next read failed, or its reply was lost');

  // 4h. The remaining rows of the branch table (evidence t115f-branch-table-20261103/branch-table.md).
  const release = () => app.evaluate(() => { const r = globalThis.t115Held; globalThis.t115Held = null; r(); });
  const held = label => until(() => app.evaluate(() => Boolean(globalThis.t115Held)), label);
  // E1-F3: the dialog is closed while 创建 is in flight: the session is kept, and the next opening starts fresh.
  await fault('create', 'hold'); await open('关闭期间建好'); await page.locator('#confirm-create').click(); await held('Create held (close)');
  await page.locator('#cancel-create').click(); await page.locator('#create-dialog').waitFor({ state: 'hidden' }); await release();
  await until(async () => (await named('关闭期间建好')).length === 1, 'Kept while the dialog was closed');
  await page.locator('#new-session').click(); assert.equal(await page.locator('#confirm-create').innerText(), '创建会话');
  assert.equal(await page.locator('#session-name').isDisabled(), false, 'The next opening starts fresh'); await page.locator('#cancel-create').click();
  const [closedKept] = await named('关闭期间建好');
  // E2-F2: a spaced 创建 whose selection moved: the session exists, the join waits for 仅继续加入, nothing is created twice.
  await open('焦点成员三'); const focusMember3 = await createdInto('焦点成员三', studyId);
  await page.locator(`[data-space-id="${studyId}"] .room-nav`).first().click(); await page.locator('#room-overview').click();
  await page.locator(`#collaboration-overview .collaboration-member-status[data-member-id="${focusMember3.id}"] .collaboration-member-name`).click();
  markCreate = await calls(); await fault('create', 'hold'); await open('空间视图变了'); await page.locator('#create-space-kind').selectOption('existing'); await page.locator('#create-space-existing').selectOption(studyId);
  await page.locator('#confirm-create').click(); await held('Spaced create held');
  await page.evaluate(([room, id]) => workspace.spaceAction(room, 'join', [id, false]), [studyId, focusMember3.id]);
  await until(async () => (await spacesOf(focusMember3.id)).length === 0, 'The third focused member left'); await release();
  await until(async () => /选中的内容变了，还没有加入空间/.test(await page.locator('#create-error').innerText()), 'A moved selection pauses before the join, in the open dialog');
  assert.equal(await page.locator('#confirm-create').innerText(), '仅继续加入'); const [spacedMoved] = await named('空间视图变了'); assert.deepEqual(await spacesOf(spacedMoved.id), []);
  await page.locator('#confirm-create').click(); await page.locator('#create-dialog').waitFor({ state: 'hidden' });
  assert.deepEqual(await spacesOf(spacedMoved.id), [studyId]); assert.equal((await named('空间视图变了')).length, 1);
  nowCreate = await calls(); assert.equal(nowCreate.create - markCreate.create, 1, 'One create for the spaced session');
  // E3-F1: a Claude branch that succeeds closes the dialog with one session.
  await pick(legacy); await open('分支成功', 'claude'); await page.locator('#choose-folder').click(); await page.locator('#open-native-history').click();
  await page.locator('#create-dialog').waitFor({ state: 'hidden' }); assert.equal((await named('分支成功')).length, 1); const [forkOk] = await named('分支成功');
  // E3-F6: a branch rejected before any write stays retryable, and the retry makes exactly one.
  markCreate = await calls(); await fault('create', 'before'); await open('分支先失败', 'claude'); await page.locator('#choose-folder').click(); await page.locator('#open-native-history').click();
  await until(async () => (await page.locator('#toast-text').innerText()).includes('Synthetic create failure'), 'The branch failure is shown');
  await until(async () => !(await page.locator('#open-native-history').isDisabled()), 'Nothing was created, so the branch can be retried');
  assert.doesNotMatch(await page.locator('#create-readiness').innerText(), /这里不会再建一个|无法确认/); assert.deepEqual(await named('分支先失败'), []);
  await page.locator('#open-native-history').click(); await page.locator('#create-dialog').waitFor({ state: 'hidden' });
  assert.equal((await named('分支先失败')).length, 1); nowCreate = await calls(); assert.equal(nowCreate.create - markCreate.create, 2);
  const [forkRetried] = await named('分支先失败');
  // E1-F8 (Git copy): an unknown result for a Git copy can't be told apart either (a retry previews a new path): it stops.
  await pick(repo); await open('副本结果未知'); await page.locator('#choose-folder').click(); await page.locator('#git-worktree').check();
  await until(async () => (await page.locator('#git-worktree-preview').innerText()).includes('工作目录：'), 'Second Git copy preview ready');
  // Every state read fails until cleared. Even so, the service's state push usually delivers the new session before the
  // catch runs (a Git copy takes a while), so the dialog stops by finding it (kept) rather than as unconfirmed; the
  // unconfirmed rule for a Git copy is reached only when no push has listed it, and is checked in source, not here.
  await fault('create', 'after'); await app.evaluate(() => { globalThis.t115Faults.push({ kind: 'initial', when: 'before', sticky: true }); });
  await page.locator('#confirm-create').click();
  await until(async () => /关闭对话框即可；这里不会再建一个|无法确认会话是否已经建好/.test(await page.locator('#create-readiness').innerText()), 'A Git copy whose reply and read were lost stops the dialog');
  assert.equal(await page.locator('#confirm-create').isDisabled(), true); assert.doesNotMatch(await page.locator('#git-worktree-preview').innerText(), /要再创建/);
  await app.evaluate(() => { globalThis.t115Faults = globalThis.t115Faults.filter(f => !f.sticky); });
  await page.locator('#cancel-create').click(); assert.equal((await named('副本结果未知')).length, 1); const [copyUnknown] = await named('副本结果未知');
  // E2, the join itself while the selection moves: the join completes, and the open dialog closes (nothing is left to do).
  await open('焦点成员四'); const focusMember4 = await createdInto('焦点成员四', studyId);
  await page.locator(`[data-space-id="${studyId}"] .room-nav`).first().click(); await page.locator('#room-overview').click();
  await page.locator(`#collaboration-overview .collaboration-member-status[data-member-id="${focusMember4.id}"] .collaboration-member-name`).click();
  await fault('join', 'hold'); await open('加入时视图变了'); await page.locator('#create-space-kind').selectOption('existing'); await page.locator('#create-space-existing').selectOption(studyId);
  await page.locator('#confirm-create').click(); await held('Join held');
  await page.evaluate(([room, id]) => workspace.spaceAction(room, 'join', [id, false]), [studyId, focusMember4.id]);
  await until(async () => (await spacesOf(focusMember4.id)).length === 0, 'The fourth focused member left'); await release();
  await page.locator('#create-dialog').waitFor({ state: 'hidden' });
  const [joinMoved] = await named('加入时视图变了'); assert.deepEqual(await spacesOf(joinMoved.id), [studyId]); assert.equal((await named('加入时视图变了')).length, 1);
  check('Branch table rows: closed mid-create keeps one and reopens fresh; a moved spaced create waits for 仅继续加入; a branch succeeds once and retries after a pre-write failure; a Git copy whose reply and read were lost stops; a join finished after the selection moved closes the dialog');

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
  const expected = { [solo.id]: [], [helper.id]: [studyId], [weekend.id]: [weekendRoom.id], [chosenFolder.id]: [studyId], [copy.id]: [weekendRoom.id], [skipped.id]: [studyId], [createRetry.id]: [studyId], [createLost.id]: [createLostRooms[0].id], [readFail.id]: [studyId], [readFailSolo.id]: [], [readFailFolder.id]: [], [unknownSolo.id]: [], [unknownShared.id]: [], [focusMember.id]: [], [movedView.id]: [], [foundAgain.id]: [], [focusMember2.id]: [], [forkMoved.id]: [], [forkReadFail.id]: [], [forkLost.id]: [], [forkUnknown.id]: [], [closedKept.id]: [], [focusMember3.id]: [], [spacedMoved.id]: [studyId], [forkOk.id]: [], [forkRetried.id]: [], [copyUnknown.id]: [], [focusMember4.id]: [], [joinMoved.id]: [studyId], [doomed.id]: [], [lost.id]: [lostRooms[0].id], [spaceFail.id]: [retryRooms[0].id], [joinFail.id]: [studyId], [closed.id]: [] };
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
