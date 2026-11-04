// I182: one native session moves between homes. Actual GUI and owned synthetic Unix backends; no provider or model turns.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(process.env.NAW_TEST_APP_ROOT || path.join(__dirname, '..')), scratch = require('./fixtures/test-scratch.cjs');
const { connectService } = require(path.join(root, 'app/service-connection.cjs')), { writeLayout, readLayout } = require(path.join(root, 'app/service-layout.cjs'));
const { _electron } = scratch.playwright(process.env.NAW_APP_EXECUTABLE ? { _electron: require('./fixtures/installed-renderer.cjs') } : require('playwright'));
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.resolve(common, '..', '.local/gui-test-slot.lock'), token = randomUUID(), owner = randomUUID();
const evidence = process.env.NAW_EVIDENCE_DIR, checks = [], errors = [], delay = ms => new Promise(resolve => setTimeout(resolve, ms));
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
  const child = scratch.childProcess.fork(path.join(root, 'app/daemon.cjs'), [directory], { execArgv: ['--require', path.join(__dirname, 'fixtures', fixtureFile)], env: env({ NAW_TEST_APP_ROOT: root, NAW_WORKSPACE: path.join(profile, 'workspace'), NAW_APP_VERSION: version }), stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const entry = backends[name] = { child, ids: [], drafts: {} };
  await until(() => fs.existsSync(path.join(directory, 'connection.json')), 'Owned synthetic daemon ready');
  entry.client = await connectService(directory, owner);
  for (let i = 0; i < count; i++) {
    const id = await entry.client.call('create', { provider: 'codex', cwd: profile, name: `${name} Claude ${i}`, view: 'chat' });
    entry.ids.push(id); entry.drafts[id] = `Private draft ${name} ${i}`; await entry.client.call('draft', id, entry.drafts[id]);
  }
}
async function seed() {
  profile = scratch.directory(path.join(os.tmpdir(), 'naw-single-home-'));
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
  assert.ok(evidence && path.isAbsolute(evidence), 'Explicit private evidence root required');
  try { fs.mkdirSync(slot); } catch (error) { if (error.code !== 'EEXIST') throw error; console.error('OCCUPIED: no own profile or GUI started'); process.exitCode = 75; return; }
  lease = true; fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'CodexMain', task: 'I182 single-home installed journey', token, pid: process.pid, time: new Date().toISOString() }));
  fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
  const entry = await seed(), [a, b, c, d] = backends.New.ids, [old] = backends.Old.ids;
  app = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [entry], env: env({ NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid), NAW_EVIDENCE_DIR:evidence, ...(process.env.NAW_TEST_EXPECTED_SOURCE?{NAW_TEST_EXPECTED_SOURCE:process.env.NAW_TEST_EXPECTED_SOURCE}:{}), ...(process.env.NAW_TEST_EXPECTED_CDHASH?{NAW_TEST_EXPECTED_CDHASH:process.env.NAW_TEST_EXPECTED_CDHASH}:{}) }), timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(8000); page.on('pageerror', error => errors.push(error.message)); await page.locator('#new-session').waitFor();
  const identity = new Map((await snapshot()).sessions.map(s => [s.id, { nativeId:s.nativeId, draft:s.liveDraft, model:s.model }]));
  const home = async id => (await snapshot()).sessions.find(s => s.id === id).roomIds || [];
  const row = id => page.locator(`#session-list [data-session-row="${id}"] .session-link`);
  const heading = id => page.locator(`#session-list [data-session-group="${id}"] .session-space-heading`);
  async function unique() {
    assert.deepEqual((await snapshot()).sessions.map(s=>s.id).sort(),[a,b,c,d,old].sort(),'No extra or missing sessions');
    assert.deepEqual(readLayout(profile).entries.slice().sort(),['.',CURRENT_KEY].sort(),'No replacement or extra backend');
    for(const [key,entry] of Object.entries(backends)){const directory=key==='Old'?profile:path.join(profile,CURRENT_KEY);assert.equal(JSON.parse(fs.readFileSync(path.join(directory,'connection.json'))).pid,entry.child.pid,'Exact owned daemon remains');}
    for (const id of [a,b,c,d,old]) assert.equal(await page.locator(`#session-list [data-session-row="${id}"]`).count(), 1, 'A native session is listed once');
    for (const s of (await snapshot()).sessions) assert.deepEqual({ nativeId:s.nativeId,draft:s.liveDraft,model:s.model }, identity.get(s.id));
  }
  async function placement(id, expected) { await until(async()=>JSON.stringify(await home(id))===JSON.stringify(expected), 'Confirmed same-native placement'); await unique(); }
  async function create(name) { await page.locator('#new-space').click(); await page.locator('#space-create-name').fill(name); await page.locator('#confirm-space-create').click(); await page.locator('#space-create-dialog').waitFor({state:'hidden'}); return (await snapshot()).rooms.find(r=>r.name===name).id; }
  async function menu(id, text) { await page.locator(`#session-list [data-session-menu="${id}"]`).click(); await page.getByRole('menuitem',{name:text,exact:true}).click(); }
  async function undo(name) { await page.getByRole('button',{name:`撤销移动到「${name}」`,exact:true}).click(); }
  await check('01 V3 zero-space discovery and permanent creation in grouped and flat views', async()=>{
    await unique(); assert.equal(await page.locator('#space-discovery').isVisible(), true);
    assert.equal(await page.locator('#workspace-group').isVisible(), false);
    assert.equal(await page.locator('#panorama-nav').innerText(), '会话总览');
    assert.equal(await page.locator('#new-space').isVisible(), true);
    const creationBox=await page.locator('#new-space').boundingBox(), sidebarBox=await page.locator('.sidebar').boundingBox();
    assert.ok(creationBox.x+creationBox.width<=sidebarBox.x+sidebarBox.width,'Create control stays within sidebar');
    await page.locator('#solo-drop').click(); assert.equal(await page.locator('#new-space').isVisible(), true); await page.locator('#solo-drop').click();
    await page.locator('#sessions-flat').click(); assert.equal(await page.locator('#workspace-group').isVisible(),true); assert.equal(await page.locator('#new-space').isVisible(),true);
    await page.locator('#sessions-grouped').click();
  });
  const roomA=await create('Space A'), roomB=await create('Space B'); space=roomA;
  await check('02 menu moves Independent to A without changing native identity or draft', async()=>{ await menu(a,'移到「Space A」'); await placement(a,[roomA]); assert.equal(await page.locator('#space-discovery').isVisible(),false); });
  await check('03 real drag moves A to B, and Undo restores A rather than making a copy', async()=>{
    await row(a).dragTo(heading(roomB)); await placement(a,[roomB]); await undo('Space B'); await placement(a,[roomA]);
  });
  await check('04 current menu move to B, then to Independent, each appears only once', async()=>{
    await menu(a,'移到「Space B」'); await placement(a,[roomB]);
    await menu(a,'移出「Space B」到独立会话'); await placement(a,[]);
  });
  await check('05 dragging onto an Independent row moves out, not just reorders', async()=>{
    await menu(a,'移到「Space A」'); await placement(a,[roomA]); await row(a).dragTo(row(b)); await placement(a,[]);
  });
  await check('06 flat view retains spaces; dragging into space row moves the same session', async()=>{
    await page.locator('#sessions-flat').click(); await row(a).dragTo(page.locator(`[data-space-id="${roomB}"] .room-nav`)); await placement(a,[roomB]);
    await page.locator('#sessions-grouped').click(); await unique();
  });
  await check('07 stale Undo cannot steal a later placement', async()=>{
    await menu(a,'移到「Space A」'); await placement(a,[roomA]);
    const record=(await snapshot()).sessions.find(s=>s.id===a);
    await page.evaluate(async ({id,room,proof})=>workspace.spaceAction(room,'join',[id,true,proof]),{id:a,room:roomB,proof:{nativeId:record.nativeId,placementRevision:record.placementRevision,connectionRevision:record.connectionRevision||0}});
    await placement(a,[roomB]); await undo('Space A'); await until(async()=> (await toastText()).includes('已变化'), 'Stale Undo refused visibly'); await placement(a,[roomB]);
  });
  await check('08 old backend refused without changing identity or placement', async()=>{
    await menu(old,'移到「Space A」'); await until(async()=> (await toastText()).includes('旧版后台'), 'Old backend reason visible'); await placement(old,[]);
  });
  await check('09 window reload keeps saved single homes and native drafts', async()=>{
    await page.reload(); await page.locator('#new-session').waitFor(); await placement(a,[roomB]); assert.equal(await page.locator('#new-space').isVisible(),true);
  });
  assert.deepEqual(errors, []);
  const installed = process.env.NAW_APP_EXECUTABLE ? { executable:app.process().spawnfile,version:(await snapshot()).appVersion } : await app.evaluate(({app})=>({executable:app.getPath('exe'),version:app.getVersion()}));
  assert.equal(installed.version,require(path.join(root,'package.json')).version);
  fs.writeFileSync(path.join(evidence,'runtime.json'),JSON.stringify({installed,profile,expectedBackends:Object.fromEntries(Object.entries(backends).map(([k,v])=>[k,v.child.pid])), productModelTurns:0,providerStarts:0,checks:checks.length},null,2));
}
const cleanup = scratch.cleanup(async () => { for (const entry of Object.values(backends)) { if (entry.client && entry.child?.connected) await entry.client.call('shutdown').catch(() => {}); entry.client?.close(); } });
(async () => {
  try { await run(); } catch (error) { failure = error; process.exitCode = 1; if (page && !page.isClosed() && evidence) await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {}); }
  finally {
    if (lease) {
      try { fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ checks, errors, failure: failure?.stack || null }, null, 2)); }
      catch (recordError) { failure ||= recordError; process.exitCode = 1; }
      if (page && !page.isClosed()) fs.writeFileSync(path.join(evidence,'final-ui.json'),JSON.stringify(await page.evaluate(()=>({html:document.querySelector('.sidebar').outerHTML,boxes:[...document.querySelectorAll('.sidebar > *, .sidebar-group, .sidebar-sash, #new-space')].map(e=>({id:e.id,cls:e.className,hidden:e.hidden,box:e.getBoundingClientRect().toJSON(),flex:getComputedStyle(e).flex})),toast:document.getElementById('toast-text').textContent})),null,2));
      await cleanup();
      if(process.env.NAW_APP_EXECUTABLE){
        const bundle=path.resolve(path.dirname(process.env.NAW_APP_EXECUTABLE),'../..');
        execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',bundle]);
        const sig=require('node:child_process').spawnSync('/usr/bin/codesign',['-d','--verbose=4',bundle],{encoding:'utf8'});assert.equal(sig.status,0);
        const cdhash=sig.stderr.match(/^CDHash=(\w+)$/m)?.[1];assert.ok(cdhash);if(process.env.NAW_TEST_EXPECTED_CDHASH)assert.equal(cdhash,process.env.NAW_TEST_EXPECTED_CDHASH);
        fs.writeFileSync(path.join(evidence,'signature-after-gui.json'),JSON.stringify({strictSignature:true,cdhash,afterOwnedCleanup:true},null,2));
      }
      assert.equal(JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'), 'utf8')).token, token); fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot);
      fs.writeFileSync(path.join(evidence, 'released.json'), JSON.stringify({ token, releasedAt: new Date().toISOString(), ownedProfileGone: !fs.existsSync(profile) }, null, 2));
    }
  }
  if (failure) console.error(failure.stack);
})();
