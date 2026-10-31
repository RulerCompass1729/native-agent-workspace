// Run under the user's standing task-board test authorization, after source/
// recipe review and an atomic canonical GUI lease; task-specific holds prevail.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), { randomUUID, createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'), scratch = require('./fixtures/test-scratch.cjs');
const { connectService } = require('../app/service-connection.cjs'), { writeLayout } = require('../app/service-layout.cjs');
const { RoomState } = require('../app/room-state.cjs'), { _electron } = scratch.playwright(require('playwright'));
const slot = path.resolve(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim(), '..', '.local/gui-test-slot.lock');
const token = randomUUID(), owner = randomUUID(), evidence = process.env.NAW_T81_COMPACT_EVIDENCE_DIR;
const hash = data => createHash('sha256').update(data).digest('hex'), delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const plan = { task: 'T81 compact backend versions source GUI', groups: 6, maxElectronStarts: 1, maxOwnedNodeStarts: 2, syntheticSessions: 7, sends: 0, productModels: 0, nativeInputs: 0, osClipboard: 0, syntheticCancelConfirmation: 1, actualBackendUpdates: 0, maxRunMs: 600000, cleanupMs: 60000, canonicalLeaseRequired: true, recordedTaskAuthorizationRequired: true };
if (process.argv.includes('--plan')) { console.log(JSON.stringify(plan, null, 2)); process.exit(0); }
const env = additions => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NAW_') && !key.startsWith('ELECTRON_') && !['NODE_OPTIONS', 'NODE_PATH'].includes(key))), ...additions });
const hashes = () => Object.fromEntries(Buffer.concat([execFileSync('git', ['ls-files', '-z'], { cwd: root }), execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root }), Buffer.from('app/dsh/client.js\0')]).toString().split('\0').filter(n => /^(app|scripts)\//.test(n)).map(n => [n, hash(fs.readFileSync(path.join(root, n)))]));
let profile, app, page, lease, started, frozen, failure, initial, roomA, roomB, sequence = 0;
const trials = [], checks = [], errors = [], layouts = [];
async function until(read, why) { for (let n = 0; n < 160; n++) { if (await read()) return; await delay(50); } throw Error(why); }
function fixture(trial, method, value, channel = 't81compact') {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const receive = reply => { if (reply.requestId !== id || (reply.channel || '') !== channel) return; clearTimeout(timer); trial.child.off('message', receive); reply.error ? reject(Error(reply.error)) : resolve(reply); };
    const timer = setTimeout(() => { trial.child.off('message', receive); reject(Error('Owned fixture timed out')); }, 5000);
    trial.child.on('message', receive); trial.child.send({ id, method, value, ...(channel ? { channel } : {}) });
  });
}
const snapshot = () => page.evaluate(() => workspace.initial());
const identity = state => state.sessions.map(s => [s.id, s.nativeId, s.liveDraft]);
const rows = () => page.locator('#session-list .session-row');
async function capture(name) {
  await page.screenshot({ path: path.join(evidence, name + '.png') });
  fs.writeFileSync(path.join(evidence, name + '.json'), JSON.stringify(await snapshot(), null, 2));
}
async function group(name, work) {
  assert.ok(Date.now() - started < plan.maxRunMs, 'Ten-minute group-entry budget');
  await work(); assert.deepEqual(identity(await snapshot()), identity(initial));
  for (const trial of trials) {
    const stats = await fixture(trial, 'stats', undefined, '');
    assert.deepEqual(stats.stats, { inputs: 0, opens: 0, resizes: 0, sends: 0 });
  }
  const metrics = await app.evaluate(() => globalThis.t81Compact);
  assert.equal(metrics.osClipboard, 0); assert.equal(metrics.external, 0); assert.equal(metrics.maintenance, 0); assert.equal(metrics.replacementSpawn, 0);
  checks.push({ name, metrics }); console.log('PASS:', name); await capture(String(checks.length).padStart(2, '0'));
}
async function createBackend(directory, version, count) {
  assert.ok(trials.length < 2); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const child = scratch.childProcess.fork(path.join(root, 'app/daemon.cjs'), [directory], { execArgv: ['--require', path.join(root, 'scripts/fixtures/compact-versions.cjs')], env: env({ NAW_TEST_APP_ROOT: root, NAW_WORKSPACE: path.join(profile, 'workspace'), NAW_APP_VERSION: version }), stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const trial = { child, directory, ids: [] }; trials.push(trial);
  await until(() => fs.existsSync(path.join(directory, 'connection.json')), 'Exact synthetic backend ready'); trial.client = await connectService(directory, owner);
  assert.equal((await trial.client.call('initial')).servicePid, child.pid);
  for (let n = 0; n < count; n++) {
    const id = await trial.client.call('create', { provider: n % 2 ? 'claude' : 'codex', name: 'Repeated member', cwd: profile, view: 'chat' });
    trial.ids.push(id); await trial.client.call('draft', id, `Positive private draft ${trials.length}-${n}`);
  }
  return trial;
}
async function seed() {
  profile = scratch.directory(path.join(os.tmpdir(), 'naw-t81-compact-'));
  const old = await createBackend(profile, '0.1.0-alpha.120', 4), key = 'backends/aaaaaaaaaaaaaaaaaaaa';
  const current = await createBackend(path.join(profile, key), require('../package.json').version, 3);
  writeLayout(profile, { format: 1, entries: ['.', key], active: key });
  const rooms = new RoomState(profile); roomA = rooms.create('Version A'); roomB = rooms.create('Version B');
  for (const id of old.ids) for (const room of [roomA, roomB]) await old.client.call('spaceAction', room, 'join', [id, true], {});
  for (const id of current.ids) await current.client.call('spaceAction', roomA, 'join', [id, true], {});
  fs.writeFileSync(path.join(profile, 'views.json'), JSON.stringify([{ owner, active: true, selected: 'room', mode: 'chat', spaceId: roomA, sharedDraft: 'Positive shared draft', roomViews: { [roomA]: { sharedDraft: 'Positive shared draft' } } }]), { mode: 0o600 });
  const entry = path.join(profile, 'entry'); fs.mkdirSync(entry);
  fs.writeFileSync(path.join(entry, 'package.json'), JSON.stringify({ name: 'naw-owned-compact-version-gui', version: require('../package.json').version, main: 'main.cjs' }));
  fs.writeFileSync(path.join(entry, 'main.cjs'), `const cp=require('node:child_process'),path=require('node:path'),e=require('electron');
globalThis.t81Compact={copies:[],osClipboard:0,external:0,maintenance:0,replacementSpawn:0,cancelDialogs:0};
const spawn=cp.spawn;cp.spawn=function(bin,args,...rest){if(Array.isArray(args)&&args.some(arg=>typeof arg==='string'&&path.basename(arg)==='daemon.cjs')){globalThis.t81Compact.replacementSpawn++;throw Error('Replacement backend prohibited');}return spawn.call(this,bin,args,...rest);};
e.clipboard.writeText=text=>globalThis.t81Compact.copies.push(text);for(const name of ['readText','readImage','writeImage','read','write','readBuffer','writeBuffer','clear'])e.clipboard[name]=()=>{globalThis.t81Compact.osClipboard++;throw Error('OS clipboard prohibited');};
e.shell.openPath=e.shell.openExternal=async()=>{globalThis.t81Compact.external++;throw Error('External action prohibited');};
e.dialog.showOpenDialog=async()=>{throw Error('OS chooser prohibited');};e.dialog.showMessageBox=async(win,options)=>{if(options.message!=='更新这个已结束会话的连接？')throw Error('Unexpected OS confirmation');globalThis.t81Compact.cancelDialogs++;return{response:0};};
const {WorkspaceClient}=require(${JSON.stringify(path.join(root, 'app/workspace-client.cjs'))});WorkspaceClient.prototype.maintainService=function(){globalThis.t81Compact.maintenance++;throw Error('Backend update prohibited');};
require(${JSON.stringify(path.join(root, 'app/main.cjs'))});`);
  for (const trial of trials) { assert.ok(trial.child.connected); process.kill(trial.child.pid, 0); }
  app = await _electron.launch({ executablePath: require('electron'), args: [entry], env: env({ NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }), timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(7000); page.on('pageerror', error => errors.push(error.message)); await page.locator('#new-space').waitFor();
  initial = await snapshot(); assert.equal(initial.sessions.length, 7);
  assert.deepEqual(initial.services.map(service => service.version), ['0.1.0-alpha.120', require('../package.json').version]);
  assert.equal(initial.servicePid, current.child.pid);
}
async function run() {
  assert.equal(process.env.NAW_T81_COMPACT_GUI_AUTHORIZED, '1', 'Record the task authorization and finite GUI plan before launching');
  assert.ok(evidence && path.isAbsolute(evidence));
  try { fs.mkdirSync(slot); } catch (error) { if (error.code !== 'EEXIST') throw error; process.exitCode = 75; console.error('OCCUPIED: no own profile/daemon/GUI started'); return; }
  lease = true; started = Date.now(); fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Codex 3', task: 'T81 compact versions six groups', token, pid: process.pid, time: new Date().toISOString() }));
  fs.mkdirSync(evidence, { recursive: true }); process.env.NAW_EVIDENCE_DIR = path.join(evidence, 'scratch'); frozen = hashes(); await seed();
  await group('01 inline compact version markers retain exact own versions and a unique-session summary', async () => {
    assert.equal(await page.locator('#backend-version-summary').innerText(), '4 旧版会话');
    assert.equal(await page.locator('#app-version-label').innerText(), 'v' + initial.appVersion);
    assert.equal(await rows().locator('.session-backend-version:visible').count(), 4);
    const row = page.locator(`[data-session-row="${trials[0].ids[0]}"]`), name = row.locator('.label > span').first(), badge = row.locator('.session-backend-version');
    const boxes = [await name.boundingBox(), await badge.boundingBox()]; assert.ok(Math.abs(boxes[0].y - boxes[1].y) < 8, 'Badge occupies the name line');
    assert.match(await row.locator('.session-link').getAttribute('aria-label'), /后台 0\.1\.0-alpha\.120/);
  });
  await group('02 grouping and space filtering repeat occurrences without changing the global unique count', async () => {
    await page.locator('#sessions-grouped').click(); assert.ok(await rows().count() > 7);
    assert.equal(await page.locator('#backend-version-summary').innerText(), '4 旧版会话');
    await page.locator(`[data-space-id="${roomB}"] .room-nav`).click(); assert.equal(await page.locator('#backend-version-summary').innerText(), '4 旧版会话');
    await page.locator('#clear-space-filter').click(); await page.locator('#sessions-flat').click();
  });
  await group('03 update choices preserve working connections and an explicit canceled ended-service confirmation performs no update', async () => {
    await page.locator('#backend-version-summary').focus(); await page.locator('#backend-version-summary').press('Enter'); await page.getByRole('menuitem', { name: '0.1.0-alpha.120 · 4 个会话 · 保留连接，查看原因', exact: true }).click();
    await until(async () => (await page.locator('#toast').innerText()).includes('未结束'), 'Working backend reason visible');
    await fixture(trials[0], 'ended'); await page.locator('#backend-version-summary').focus(); await page.locator('#backend-version-summary').press('Space');
    await page.getByRole('menuitem', { name: '0.1.0-alpha.120 · 4 个会话 · 核对并更新连接…', exact: true }).click();
    await until(async () => (await app.evaluate(() => globalThis.t81Compact.cancelDialogs)) === 1, 'Exactly one synthetic cancel confirmation');
  });
  await group('04 newer and unknown reports remain honest; matching all versions naturally removes both marker and summary', async () => {
    const newerVersion = initial.appVersion.replace(/^(.*-alpha\.)(\d+)$/, (_match, base, n) => base + String(Number(n) + 1));
    assert.notEqual(newerVersion, initial.appVersion, 'Owned fixture requires an alpha application version');
    for (const [value, label, name] of [[newerVersion, '版本不同', '04-newer'], ['?', '版本未知', '04-unknown']]) {
      await fixture(trials[0], 'version', value);
      await until(async () => (await rows().locator('.session-backend-version:visible').first().innerText()) === label, name);
      assert.equal(await page.locator('#backend-version-summary').innerText(), '4 会话待核对'); await capture(name);
    }
    await fixture(trials[0], 'version', initial.appVersion); await until(() => page.locator('#backend-version-summary').isHidden(), 'All versions match');
    assert.equal(await rows().locator('.session-backend-version:visible').count(), 0); await capture('04-all-current');
    await fixture(trials[0], 'version', '0.1.0-alpha.120'); await until(async () => (await page.locator('#backend-version-summary').innerText()) === '4 旧版会话', 'Own old report restored');
  });
  await group('05 actual DSH collapsed rail keeps version and update-summary controls reachable', async () => {
    const win = await app.browserWindow(page); await win.evaluate(window => window.setContentSize(950, 700));
    const sidebar = page.locator('.naw[data-native-surface="sidebar"]'); await until(async () => (await sidebar.getAttribute('data-collapsed')) === 'true', 'Actual narrow rail');
    assert.equal(await page.locator('#app-version-compact').isVisible(), true); assert.equal(await page.locator('#backend-version-summary').isVisible(), true);
    layouts.push(await page.locator('#backend-version-summary').boundingBox()); await capture('05-rail');
    await win.evaluate(window => window.setContentSize(1240, 850));
    if ((await sidebar.getAttribute('data-collapsed')) === 'true') { const archive = page.locator('#archive-button'); if ((await archive.getAttribute('aria-expanded')) === 'true') await archive.click(); await archive.click(); }
    await until(async () => (await sidebar.getAttribute('data-collapsed')) === 'false' && await page.locator('#app-version-label').isVisible(), 'Actual expanded sidebar settled');
  });
  await group('06 explicit keyboard version copy uses a virtual sink and all original identities and positive drafts remain', async () => {
    await page.locator('#app-version').focus(); await page.locator('#app-version').press('Enter');
    await until(async () => (await app.evaluate(() => globalThis.t81Compact.copies.length)) === 1, 'Exactly one virtual version copy');
    const copy = await app.evaluate(() => globalThis.t81Compact.copies[0]); assert.ok(copy.startsWith('Native Agent Workspace\n应用版本：' + initial.appVersion));
    for (const session of initial.sessions) for (const value of [session.id, session.nativeId, session.name, session.cwd, session.liveDraft]) if (value) assert.equal(copy.includes(value), false);
    assert.equal((await snapshot()).viewState.roomViews[roomA].sharedDraft, 'Positive shared draft');
  });
  assert.deepEqual(errors, []); assert.deepEqual(hashes(), frozen);
}
const cleanup = scratch.cleanup(async () => { for (const trial of trials) { if (trial.child.connected && trial.client && !trial.client.socket.destroyed) { await fixture(trial, 'stop', undefined, ''); await trial.client.call('shutdown'); } trial.client?.close(); } });
(async () => {
  try { await run(); } catch (error) { failure = error.stack; process.exitCode = 1; if (page && !page.isClosed()) await capture('failure').catch(() => {}); }
  finally { if (lease) {
    try { fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ checks, errors, failure, profile, layouts, ownedNodePids: trials.map(trial => trial.child.pid), ownedGuiPid: app?.process().pid, sourceBefore: frozen, sourceAfter: hashes(), metrics: app ? await app.evaluate(() => globalThis.t81Compact).catch(() => null) : null }, null, 2)); }
    finally { await cleanup(); assert.equal(JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))).token, token); fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot); fs.writeFileSync(path.join(evidence, 'released.json'), JSON.stringify({ token, releasedAt: new Date().toISOString(), ownedProfileGone: !fs.existsSync(profile) })); }
  } }
  if (failure) console.error(failure);
})();
