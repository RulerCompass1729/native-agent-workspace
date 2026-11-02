// T-116: a newly created, still-empty space accepts sessions from the grouped
// sidebar (group heading, space row, menu, invite). A session on a backend
// without other spaces is refused up front with the reason and next step, and
// a failed invite shows its error inside the modal. Synthetic transport only:
// two owned daemons, no provider, model, native input or daily app.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'), scratch = require('./fixtures/test-scratch.cjs');
const { connectService } = require('../app/service-connection.cjs'), { writeLayout } = require('../app/service-layout.cjs');
const { _electron } = scratch.playwright(require('playwright'));
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.resolve(common, '..', '.local/gui-test-slot.lock'), token = randomUUID(), owner = randomUUID();
const evidence = process.env.NAW_T116_EVIDENCE_DIR, checks = [], errors = [], delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const OLD_VERSION = '0.1.0-alpha.140', CURRENT_KEY = 'backends/bbbbbbbbbbbbbbbbbbbb';
const env = additions => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NAW_') && !key.startsWith('ELECTRON_') && !['NODE_OPTIONS', 'NODE_PATH'].includes(key))), ...additions });
let profile, app, page, lease = false, failure, space, sequence = 0;
const backends = {};
async function until(read, label) { for (let i = 0; i < 120; i++) { if (await read()) return; await delay(50); } throw Error(label); }
function fixture(backend, method, channel = '') {
  const id = ++sequence; return new Promise((resolve, reject) => {
    const receive = reply => { if (reply.requestId !== id || (reply.channel || '') !== channel) return; clearTimeout(timer); backend.child.off('message', receive); reply.error ? reject(Error(reply.error)) : resolve(reply); };
    const timer = setTimeout(() => { backend.child.off('message', receive); reject(Error('Owned fixture request timed out')); }, 5000);
    backend.child.on('message', receive); backend.child.send({ id, method, ...(channel ? { channel } : {}) });
  });
}
const snapshot = () => page.evaluate(() => workspace.initial());
const members = async () => (await snapshot()).sessions.filter(s => (s.roomIds || []).includes(space)).map(s => s.id).sort();
const toastText = () => page.locator('#toast-text').innerText();
async function check(name, run) {
  await run();
  const state = await snapshot();
  assert.deepEqual(state.sessions.map(s => s.liveDraft).sort(), Object.values(backends).flatMap(b => b.ids.map(id => b.drafts[id])).sort(), 'Native drafts preserved');
  for (const backend of Object.values(backends)) { const stats = (await fixture(backend, 'stats')).stats; assert.equal(stats.inputs, 0); assert.equal(stats.sends, 0); }
  checks.push(name); console.log('PASS:', name);
  await page.screenshot({ path: path.join(evidence, `${String(checks.length).padStart(2, '0')}.png`) });
}
async function backend(name, directory, version, fixtureFile, count) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const child = scratch.childProcess.fork(path.join(root, 'app/daemon.cjs'), [directory], { execArgv: ['--require', path.join(root, 'scripts/fixtures', fixtureFile)], env: env({ NAW_TEST_APP_ROOT: root, NAW_WORKSPACE: path.join(profile, 'workspace'), NAW_APP_VERSION: version }), stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const entry = backends[name] = { child, ids: [], drafts: {} };
  await until(() => fs.existsSync(path.join(directory, 'connection.json')), 'Owned synthetic daemon ready');
  entry.client = await connectService(directory, owner);
  for (let i = 0; i < count; i++) {
    const id = await entry.client.call('create', { provider: 'claude', cwd: profile, name: `${name} Claude ${i}`, view: 'chat' });
    entry.ids.push(id); entry.drafts[id] = `Private draft ${name} ${i}`; await entry.client.call('draft', id, entry.drafts[id]);
  }
}
async function seed() {
  profile = scratch.directory(path.join(os.tmpdir(), 'naw-t116-space-'));
  await backend('Old', profile, OLD_VERSION, 'old-spaces.cjs', 1);
  await backend('New', path.join(profile, CURRENT_KEY), require('../package.json').version, 'multispace.cjs', 4);
  writeLayout(profile, { format: 1, entries: ['.', CURRENT_KEY], active: CURRENT_KEY });
  fs.writeFileSync(path.join(profile, 'views.json'), JSON.stringify([{ owner, selected: backends.New.ids[0], mode: 'chat', active: true, sidebarView: 'grouped' }]), { mode: 0o600 });
  const entry = path.join(profile, 'gui-entry'); fs.mkdirSync(entry, { mode: 0o700 });
  fs.writeFileSync(path.join(entry, 'package.json'), JSON.stringify({ name: 'naw-t116-owned-source-gui', version: require('../package.json').version, main: 'main.cjs' }), { mode: 0o600 });
  fs.writeFileSync(path.join(entry, 'main.cjs'), `const cp = require('node:child_process'), path = require('node:path'), e = require('electron');
const spawn = cp.spawn;
cp.spawn = function(executable, args, options) {
  if (Array.isArray(args) && args.some(arg => typeof arg === 'string' && path.basename(arg) === 'daemon.cjs')) throw Error('Replacement backend prohibited');
  return spawn.call(this, executable, args, options);
};
for (const name of ['writeText', 'readText', 'readImage', 'writeImage', 'read', 'write', 'readBuffer', 'writeBuffer', 'clear']) e.clipboard[name] = () => { throw Error('OS clipboard prohibited'); };
e.shell.openPath = e.shell.openExternal = async () => { throw Error('External action prohibited'); };
const { WorkspaceClient } = require(${JSON.stringify(path.join(root, 'app/workspace-client.cjs'))});
WorkspaceClient.prototype.maintainService = function() { throw Error('Backend update prohibited'); };
require(${JSON.stringify(path.join(root, 'app/main.cjs'))});
`, { mode: 0o600 });
  return entry;
}
async function run() {
  assert.ok(evidence && path.isAbsolute(evidence), 'Explicit private screenshot/evidence path required');
  try { fs.mkdirSync(slot); } catch (error) { if (error.code !== 'EEXIST') throw error; console.error('OCCUPIED: no own profile or GUI started'); process.exitCode = 75; return; }
  lease = true; fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Claude main session', task: 'T-116 empty-space join', token, pid: process.pid, time: new Date().toISOString() }));
  fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
  const entry = await seed(), [a, b, c, d] = backends.New.ids, [old] = backends.Old.ids;
  app = await _electron.launch({ executablePath: require('electron'), args: [entry], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(7000); page.on('pageerror', error => errors.push(error.message)); await page.locator('#new-space').waitFor();
  assert.deepEqual((await snapshot()).sessions.map(s => s.id).sort(), [...backends.New.ids, old].sort(), 'GUI reads exactly both owned daemons');
  await check('01 create an empty space in the grouped sidebar', async () => {
    await page.locator('#new-space').click(); await page.locator('#space-create-name').fill('Claude 聊天室'); await page.locator('#confirm-space-create').click();
    await until(() => JSON.parse(fs.readFileSync(path.join(profile, 'collaboration-spaces.json'), 'utf8')).rooms.length === 1, 'New space stored');
    space = JSON.parse(fs.readFileSync(path.join(profile, 'collaboration-spaces.json'), 'utf8')).rooms[0].id;
    if (await page.locator('#sessions-grouped').getAttribute('aria-pressed') !== 'true') await page.locator('#sessions-grouped').click();
    await page.locator(`[data-session-group="${space}"] h3`).waitFor(); assert.deepEqual(await members(), []);
  });
  const independent = id => page.locator(`[data-session-group="independent"] [data-session-row="${id}"] .session-link`);
  await check('02 drag onto the empty group heading joins', async () => {
    await independent(a).dragTo(page.locator(`[data-session-group="${space}"] h3`));
    await until(async () => (await members()).includes(a), 'Joined by group heading'); assert.equal(await toastText(), '已加入「Claude 聊天室」；原来的空间归属保留。');
  });
  await check('03 drag onto the space row joins', async () => {
    await independent(b).dragTo(page.locator(`[data-space-id="${space}"] .room-nav`));
    await until(async () => (await members()).includes(b), 'Joined by space row'); assert.deepEqual(await members(), [a, b].sort());
  });
  await check('04 session menu joins', async () => {
    await page.locator(`[data-session-group="independent"] [data-session-row="${c}"] .session-more`).click();
    await page.getByRole('menuitem', { name: '加入「Claude 聊天室」', exact: true }).click();
    await until(async () => (await members()).includes(c), 'Joined by menu');
  });
  await check('05 old-backend session is refused with reason and next step', async () => {
    await page.locator(`[data-session-group="independent"] [data-session-row="${old}"] .session-more`).click();
    await page.getByRole('menuitem', { name: '加入「Claude 聊天室」', exact: true }).click();
    await until(async () => (await toastText()).includes('连着旧版后台'), 'Old-backend reason shown');
    const text = await toastText();
    assert.ok(text.includes(`（${OLD_VERSION}）`) && text.includes('原会话与草稿保留') && text.includes('「旧版会话」里核对并更新连接'), text);
    await page.locator('#toast-close').click();
    await independent(old).dragTo(page.locator(`[data-space-id="${space}"] .room-nav`));
    await until(async () => (await toastText()).includes('连着旧版后台') && await page.locator('#toast').isVisible(), 'Drag refusal shown');
    assert.deepEqual(await members(), [a, b, c].sort());
  });
  await check('06 invite marks the old-backend session and shows a failed join inside the dialog', async () => {
    await page.locator(`[data-space-id="${space}"] .room-nav`).click(); await page.locator('#manage-members').click(); await page.locator('#invite-dialog').waitFor();
    const blocked = page.locator(`[data-invite-session="${old}"]`);
    assert.equal(await blocked.getAttribute('aria-disabled'), 'true'); assert.ok((await blocked.innerText()).includes('当前后台不可加入新空间'));
    assert.ok((await page.locator('#invite-list p').innerText()).includes('「旧版会话」里核对并更新连接'));
    await blocked.focus(); await page.keyboard.press('Enter');
    await until(async () => (await page.locator('#invite-error').innerText()).includes(`（${OLD_VERSION}）`), 'Keyboard reaches the exact old-backend reason');
    assert.deepEqual(await members(), [a, b, c].sort());
    await fixture(backends.New, 'storageFailure', 't69');
    await page.locator(`[data-invite-session="${d}"]`).click();
    await until(async () => await page.locator('#invite-error').isVisible(), 'Inline invite error visible');
    assert.equal(await page.locator('#invite-error').innerText(), 'Synthetic space save failure');
    assert.equal(await page.locator('#invite-dialog').evaluate(el => el.open), true); assert.deepEqual(await members(), [a, b, c].sort());
    await fixture(backends.New, 'storageRecovered', 't69');
    await page.locator(`[data-invite-session="${d}"]`).click();
    await until(async () => !(await page.locator('#invite-dialog').evaluate(el => el.open)), 'Invite closes after join');
    await until(async () => (await members()).includes(d), 'Joined by invite'); assert.equal(await page.locator('#invite-error').isVisible(), false);
  });
  assert.deepEqual(errors, []);
}
const cleanup = scratch.cleanup(async () => { for (const entry of Object.values(backends)) { if (entry.client && entry.child?.connected) await entry.client.call('shutdown').catch(() => {}); entry.client?.close(); } });
(async () => {
  try { await run(); } catch (error) { failure = error; process.exitCode = 1; if (page && !page.isClosed() && evidence) await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {}); }
  finally {
    if (lease) {
      try { fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ checks, errors, failure: failure?.stack || null }, null, 2)); }
      catch (recordError) { failure ||= recordError; process.exitCode = 1; }
      await cleanup();
      assert.equal(JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'), 'utf8')).token, token); fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot);
      fs.writeFileSync(path.join(evidence, 'released.json'), JSON.stringify({ token, releasedAt: new Date().toISOString(), ownedProfileGone: !fs.existsSync(profile) }, null, 2));
    }
  }
  if (failure) console.error(failure.stack);
})();
