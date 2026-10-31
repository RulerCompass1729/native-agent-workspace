// Existing T69/T108 rail regression. One finite, owned, synthetic source GUI.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), { randomUUID, createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'), scratch = require('./fixtures/test-scratch.cjs');
const { connectService } = require('../app/service-connection.cjs'), { writeLayout } = require('../app/service-layout.cjs');
const { RoomState } = require('../app/room-state.cjs'), { _electron } = scratch.playwright(require('playwright'));
const slot = path.resolve(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim(), '..', '.local/gui-test-slot.lock');
const evidence = process.env.NAW_RAIL_EVIDENCE_DIR, token = randomUUID(), owner = randomUUID();
const plan = { task: 'T69/T108 existing collapsed membership controls', groups: 4, maxElectronStarts: 1, maxOwnedNodeStarts: 1, syntheticSessions: 7, productModels: 0, nativeInputs: 0, sends: 0, osClipboard: 0, maxRunMs: 120000, cleanupMs: 60000, canonicalLeaseRequired: true };
if (process.argv.includes('--plan')) { console.log(JSON.stringify(plan, null, 2)); process.exit(0); }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms)), hash = data => createHash('sha256').update(data).digest('hex');
const env = additions => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NAW_') && !key.startsWith('ELECTRON_') && !['NODE_OPTIONS', 'NODE_PATH'].includes(key))), ...additions });
const hashes = () => Object.fromEntries(Buffer.concat([execFileSync('git', ['ls-files', '-z'], { cwd: root }), execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root }), Buffer.from('app/dsh/client.js\0')]).toString().split('\0').filter(n => /^(app|scripts)\//.test(n)).map(n => [n, hash(fs.readFileSync(path.join(root, n)))]));
let profile, child, client, app, page, initial, roomA, roomB, lease, started, frozen, failure, sequence = 0;
const checks = [], errors = [];
async function until(read, reason) { for (let n = 0; n < 160; n++) { if (await read()) return; await delay(50); } throw Error(reason); }
function fixture(method) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const receive = reply => { if (reply.requestId !== id) return; clearTimeout(timer); child.off('message', receive); reply.error ? reject(Error(reply.error)) : resolve(reply); };
    const timer = setTimeout(() => { child.off('message', receive); reject(Error('Owned fixture timeout')); }, 5000);
    child.on('message', receive); child.send({ id, method });
  });
}
const snapshot = () => page.evaluate(() => workspace.initial());
const identities = state => state.sessions.map(s => [s.id, s.nativeId, s.liveDraft]);
const sidebar = () => page.locator('.naw[data-native-surface="sidebar"]');
async function capture(name) {
  await page.screenshot({ path: path.join(evidence, name + '.png') });
  fs.writeFileSync(path.join(evidence, name + '.json'), JSON.stringify(await snapshot(), null, 2));
}
async function group(name, work) {
  assert.ok(Date.now() - started < plan.maxRunMs, 'Two-minute group-entry budget');
  await work(); const state = await snapshot();
  assert.deepEqual(identities(state), identities(initial));
  assert.equal(state.viewState.roomViews[roomA].sharedDraft, 'Positive shared draft');
  assert.deepEqual((await fixture('stats')).stats, { inputs: 0, opens: 0, resizes: 0, sends: 0 });
  const metrics = await app.evaluate(() => globalThis.railGuards);
  assert.deepEqual(metrics, { clipboard: 0, external: 0, dialogs: 0, maintenance: 0, replacement: 0 });
  checks.push({ name, metrics }); console.log('PASS:', name); await capture(String(checks.length).padStart(2, '0'));
}
async function expand() {
  const win = await app.browserWindow(page); await win.evaluate(window => window.setContentSize(1240, 850));
  if ((await sidebar().getAttribute('data-collapsed')) === 'true') {
    if ((await page.locator('#archive-button').getAttribute('aria-expanded')) === 'true') await page.locator('#archive-button').click();
    await page.locator('#archive-button').focus(); await page.locator('#archive-button').press('Enter');
  }
  await until(async () => (await sidebar().getAttribute('data-collapsed')) === 'false', 'Existing archive action reveals original sidebar');
}
async function collapse() {
  const win = await app.browserWindow(page); await win.evaluate(window => window.setContentSize(950, 700));
  await until(async () => (await sidebar().getAttribute('data-collapsed')) === 'true', 'Actual DSH narrow rail');
}
async function hiddenRailControls() {
  for (const selector of ['#new-space', '.session-view-switch', '.session-space-badges', '.session-space-group h3']) {
    const loc = sidebar().locator(selector);
    for (let n = 0; n < await loc.count(); n++) assert.equal(await loc.nth(n).isVisible(), false, selector);
  }
  assert.equal(await sidebar().locator('.session-link').count() >= 7, true);
  for (const row of await sidebar().locator('.session-link').all()) {
    assert.ok(await row.getAttribute('aria-label')); assert.equal(await row.locator('.session-short-id').isVisible(), true);
  }
  assert.equal(await page.locator('#app-version-compact').isVisible(), true);
  assert.equal(await page.locator('#archive-button .rail-icon').isVisible(), true);
}
async function run() {
  assert.equal(process.env.NAW_RAIL_GUI_AUTHORIZED, '1', 'Record the bounded task authorization before launching');
  assert.ok(evidence && path.isAbsolute(evidence));
  // Reject an evidence location that strict scratch cleanup cannot export to,
  // including a nonexistent child of a symlink, before taking the GUI lease.
  let existing = evidence;
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  const destination = path.resolve(fs.realpathSync(existing), path.relative(existing, evidence));
  for (const repo of [fs.realpathSync(root), fs.realpathSync(path.resolve(slot, '../..'))]) {
    assert.ok(destination !== repo && !destination.startsWith(repo + path.sep), 'GUI evidence must be outside both repositories');
  }
  try { fs.mkdirSync(slot); } catch (error) { if (error.code !== 'EEXIST') throw error; process.exitCode = 75; console.error('OCCUPIED: no profile/daemon/GUI started'); return; }
  lease = true; started = Date.now(); fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Codex 3', task: plan.task, token, pid: process.pid, time: new Date().toISOString() }));
  fs.mkdirSync(evidence, { recursive: true }); process.env.NAW_EVIDENCE_DIR = path.join(evidence, 'scratch'); frozen = hashes();
  profile = scratch.directory(path.join(os.tmpdir(), 'naw-membership-rail-'));
  child = scratch.childProcess.fork(path.join(root, 'app/daemon.cjs'), [profile], { execArgv: ['--require', path.join(root, 'scripts/fixtures/collaboration-overview.cjs')], env: env({ NAW_TEST_APP_ROOT: root, NAW_WORKSPACE: path.join(profile, 'workspace'), NAW_APP_VERSION: require('../package.json').version }), stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Exact synthetic backend ready'); client = await connectService(profile, owner);
  const backend = await client.call('initial'); assert.equal(backend.servicePid, child.pid); assert.equal(backend.runtimeVersion, require('../package.json').version);
  const ids = [];
  for (let n = 0; n < 7; n++) { const id = await client.call('create', { provider: n % 2 ? 'claude' : 'codex', name: 'Rail member ' + n, cwd: profile, view: 'chat' }); ids.push(id); await client.call('draft', id, 'Positive private draft ' + n); }
  writeLayout(profile, { format: 1, entries: ['.'], active: '.' });
  const rooms = new RoomState(profile); roomA = rooms.create('Rail A'); roomB = rooms.create('Rail B');
  for (const [n, id] of ids.entries()) { await client.call('spaceAction', roomA, 'join', [id, true], {}); if (n < 4) await client.call('spaceAction', roomB, 'join', [id, true], {}); }
  const prepared = await client.call('initial');
  assert.deepEqual(prepared.sessions.map(s => [s.id, s.liveDraft]), ids.map((id, n) => [id, 'Positive private draft ' + n]));
  assert.ok(prepared.sessions.every(s => s.nativeId));
  fs.writeFileSync(path.join(profile, 'views.json'), JSON.stringify([{ owner, active: true, selected: 'room', mode: 'chat', spaceId: roomA, sharedDraft: 'Positive shared draft', roomViews: { [roomA]: { sharedDraft: 'Positive shared draft' } } }]), { mode: 0o600 });
  const entry = path.join(profile, 'entry'); fs.mkdirSync(entry);
  fs.writeFileSync(path.join(entry, 'package.json'), JSON.stringify({ name: 'naw-owned-membership-rail-gui', version: require('../package.json').version, main: 'main.cjs' }));
  fs.writeFileSync(path.join(entry, 'main.cjs'), `const cp=require('node:child_process'),path=require('node:path'),e=require('electron');
globalThis.railGuards={clipboard:0,external:0,dialogs:0,maintenance:0,replacement:0};
const spawn=cp.spawn;cp.spawn=function(bin,args,...rest){if(Array.isArray(args)&&args.some(arg=>typeof arg==='string'&&path.basename(arg)==='daemon.cjs')){globalThis.railGuards.replacement++;throw Error('Replacement backend prohibited');}return spawn.call(this,bin,args,...rest);};
for(const name of ['readText','writeText','readImage','writeImage','read','write','readBuffer','writeBuffer','clear'])e.clipboard[name]=()=>{globalThis.railGuards.clipboard++;throw Error('OS clipboard prohibited');};
e.shell.openPath=e.shell.openExternal=async()=>{globalThis.railGuards.external++;throw Error('External action prohibited');};
e.dialog.showOpenDialog=e.dialog.showMessageBox=async()=>{globalThis.railGuards.dialogs++;throw Error('OS dialog prohibited');};
const {WorkspaceClient}=require(${JSON.stringify(path.join(root, 'app/workspace-client.cjs'))});WorkspaceClient.prototype.maintainService=function(){globalThis.railGuards.maintenance++;throw Error('Backend update prohibited');};
require(${JSON.stringify(path.join(root, 'app/main.cjs'))});`);
  assert.ok(child.connected); process.kill(child.pid, 0);
  app = await _electron.launch({ executablePath: require('electron'), args: [entry], env: env({ NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }), timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(7000); page.on('pageerror', error => errors.push(error.message)); await page.locator('#new-space').waitFor({ state: 'attached' });
  initial = await snapshot(); assert.equal(initial.servicePid, child.pid); assert.equal(initial.sessions.length, 7);
  assert.deepEqual(identities(initial), identities(prepared));
  await group('01 expanded flat sidebar retains all seven original members and membership controls', async () => {
    await expand(); assert.equal(await page.locator('#new-space').isVisible(), true); assert.equal(await page.locator('#sessions-flat').isVisible(), true);
    assert.equal(await sidebar().locator('.session-row').count(), 7); assert.equal(await sidebar().locator('.session-space-badges:visible').count(), 7);
  });
  await group('02 actual collapsed flat rail hides wide-only controls and retains original IDs and archive action', async () => { await collapse(); await hiddenRailControls(); });
  await group('03 expanded sidebar restores controls and grouped occurrences without changing native identity or drafts', async () => {
    await expand(); assert.equal(await page.locator('#new-space').isVisible(), true); await page.locator('#sessions-grouped').click();
    assert.ok(await sidebar().locator('.session-row').count() > 7); assert.ok(await sidebar().locator('.session-space-group h3:visible').count() >= 2);
  });
  await group('04 grouped rail remains compact and returns to the same grouped membership and positive drafts', async () => {
    const count = await sidebar().locator('.session-row').count(); await collapse(); await hiddenRailControls(); await capture('04-grouped-rail');
    await expand(); assert.equal(await sidebar().locator('.session-row').count(), count); assert.equal(await page.locator('#sessions-grouped').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#new-space').isVisible(), true); assert.ok(await sidebar().locator('.session-space-badges:visible').count() >= 7);
  });
  assert.deepEqual(errors, []); assert.deepEqual(hashes(), frozen);
}
const cleanup = scratch.cleanup(async () => { if (child?.connected && client && !client.socket.destroyed) { await fixture('stop'); await client.call('shutdown'); } client?.close(); });
(async () => {
  try { await run(); } catch (error) { failure = error.stack; process.exitCode = 1; if (page && !page.isClosed()) await capture('failure').catch(() => {}); }
  finally { if (lease) {
    try { fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ checks, errors, failure, profile, ownedNodePid: child?.pid, ownedGuiPid: app?.process().pid, sourceBefore: frozen, sourceAfter: hashes(), fixtureStats: child?.connected ? await fixture('stats').catch(() => null) : null, metrics: app ? await app.evaluate(() => globalThis.railGuards).catch(() => null) : null }, null, 2)); }
    finally { await cleanup(); assert.equal(JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))).token, token); fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot); fs.writeFileSync(path.join(evidence, 'released.json'), JSON.stringify({ token, releasedAt: new Date().toISOString(), ownedProfileGone: !fs.existsSync(profile) })); }
  } }
  if (failure) console.error(failure);
})();
