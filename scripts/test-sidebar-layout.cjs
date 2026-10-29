const testScratch = require('./fixtures/test-scratch.cjs');
// Actual hidden Electron/DSH, desktop metadata and lifecycle; synthetic native
// transport only. No provider process, model, task send or terminal input.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { fork } = testScratch.childProcess, { _electron } = testScratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const { connect } = require(path.join(code, 'app/service-client.cjs'));
const common = require('node:child_process').execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = require('node:crypto').randomUUID();
try { fs.mkdirSync(slot); } catch (error) { if (error.code !== 'EEXIST') throw error; console.error('GUI slot occupied; no test app launched.'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Codex2', task: 'T68 sidebar layout', token, pid: process.pid, at: new Date().toISOString() }));
const profile = testScratch.directory(path.join(os.tmpdir(), 'naw-sidebar-layout-'));
const ids = Array.from({ length: 16 }, (_, i) => `10000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`);
fs.writeFileSync(path.join(profile, 'workspace.json'), JSON.stringify({ sessions: ids.map((id, i) => ({ id, provider: i === 1 ? 'claude' : 'codex', name: i < 2 ? '学习' : '常用', nativeId: i === 2 ? null : 'synthetic-native-' + i, model: 'fixture', cwd: profile, state: 'idle', messages: [] })) }), { mode: 0o600 });
fs.writeFileSync(path.join(profile, 'views.json'), JSON.stringify([{ owner: 'sidebar-owner', active: true, selected: ids[0], mode: 'chat' }, { owner: 'sidebar-observer', active: true, selected: '', mode: 'chat' }]), { mode: 0o600 });
const child = fork(path.join(code, 'app/daemon.cjs'), [profile], { execArgv: ['--require', path.join(__dirname, 'fixtures/native-progress.cjs')], env: { ...process.env, NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_TEST_APP_ROOT: code, NAW_WORKSPACE: profile }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms)), checks = [], errors = [];
let app, page, peer, client, sequence = 0;
async function until(fn, label) { for (let i = 0; i < 180; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
function fixture(method = 'stats', target, value) { const id = ++sequence; return new Promise((resolve, reject) => {
  const callback = result => { if (result.requestId === id) { clearTimeout(timer); child.off('message', callback); result.error ? reject(Error(result.error)) : resolve(result); } };
  const timer = setTimeout(() => { child.off('message', callback); reject(Error('Fixture timeout')); }, 8000);
  child.on('message', callback); child.send({ id, method, target, value });
}); }
const snapshot = () => page.evaluate(() => workspace.initial());
const rows = p => p.locator('#session-list [data-session-row]');
const order = p => rows(p).evaluateAll(list => list.map(row => row.dataset.sessionRow));
async function expectOrder(expected) { for (const p of [page, peer]) await until(async () => JSON.stringify(await order(p)) === JSON.stringify(expected), 'Same saved sidebar order in both windows'); }
async function launch() {
  app = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  await until(() => app.windows().length === 2, 'Two restored owned windows');
  for (const p of app.windows()) { p.setDefaultTimeout(15000); p.on('pageerror', e => errors.push(e.message)); await p.locator('#new-session').waitFor(); const s = await p.evaluate(() => workspace.initial()); if (s.viewState.owner === 'sidebar-owner') page = p; else peer = p; }
  await app.evaluate(({ clipboard }) => { globalThis.sidebarCopies = []; clipboard.writeText = value => globalThis.sidebarCopies.push(value); });
  for (const p of [page, peer]) { const w = await app.browserWindow(p); assert.equal(await w.evaluate(win => win.isVisible()), false); assert.equal(await w.evaluate(win => win.isFocusable()), false); }
}
async function menu(id, action, keyboard = false) {
  const trigger = page.locator(`[data-session-menu="${id}"]`);
  if (keyboard) { await trigger.focus(); await page.keyboard.press('Shift+F10'); } else await trigger.click();
  const item = page.getByRole('menuitem', { name: action, exact: true }); await item.waitFor();
  if (keyboard) { await until(async () => (await page.locator('.naw-session-menu [role="menuitem"]:focus').count()) === 1, 'Menu initial focus'); for (let i = 0; i < 12 && !(await item.evaluate(el => el === document.activeElement)); i++) await page.keyboard.press('ArrowDown'); assert.equal(await item.evaluate(el => el === document.activeElement), true); await page.keyboard.press('Enter'); }
  else await item.click();
  await page.locator('.naw-session-menu').waitFor({ state: 'hidden' });
}
async function dragTo(source, target, fraction = 0.5) {
  const a = await source.boundingBox(), b = await target.boundingBox(); assert.ok(a && b);
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 12, a.y + a.height / 2, { steps: 4 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height * fraction, { steps: 12 }); await page.mouse.up();
}
async function capture(name) {
  if (!process.env.NAW_EVIDENCE_DIR) return;
  fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true, mode: 0o700 });
  await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, name + '.png') });
}
async function dimensions(p = page) {
  return p.evaluate(() => ({ groups: ['sessions-group', 'workspace-group', 'archive-group'].map(id => { const e=document.getElementById(id),b=e.getBoundingClientRect(),h=e.querySelector('.nav-label').getBoundingClientRect();return {id,height:b.height,top:b.top,bottom:b.bottom,headerTop:h.top,headerBottom:h.bottom}; }), nav: document.querySelector('.sidebar-navigation').getBoundingClientRect().toJSON(), footer:document.querySelector('.sidebar-tools').getBoundingClientRect().toJSON(), innerHeight }));
}
const preference = async () => (await snapshot()).sidebar.weights;
const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);
async function saved(expected) { for (const p of [page,peer]) await until(async()=>equal((await p.evaluate(()=>workspace.initial())).sidebar.weights,expected),'Saved sizing observed in both actual windows'); }
async function dragSash(index, delta, release = true) {
 const target=page.locator(index===0?'#sidebar-session-sash':'#sidebar-workspace-sash');await target.scrollIntoViewIfNeeded();const b=await target.boundingBox();assert.ok(b);
 await page.mouse.move(b.x+b.width/2,b.y+b.height/2);await page.mouse.down();await page.mouse.move(b.x+b.width/2,b.y+b.height/2+delta,{steps:12});if(release)await page.mouse.up();
}
async function installSpy() {
 await app.evaluate(({ipcMain})=>{
  globalThis.layoutOps={sidebar:[],native:[],hold:false,pending:[]};
  for(const method of ['sidebar','claim','input','send','queue','steer','forward','run']){
   const channel='workspace:'+method,original=ipcMain._invokeHandlers.get(channel);if(!original)throw Error('Missing exact owned handler '+channel);
   ipcMain.removeHandler(channel);ipcMain.handle(channel,(event,...args)=>{
    if(method==='sidebar'){
     globalThis.layoutOps.sidebar.push(args[0]);
     if(globalThis.layoutOps.hold&&args[0].type==='resize')return new Promise(resolve=>globalThis.layoutOps.pending.push(resolve));
    }else globalThis.layoutOps.native.push(method);
    return original(event,...args);
   });
  }
 });
}
async function run() {
 await until(()=>fs.existsSync(path.join(profile,'connection.json')),'Fixture service ready');client=await connect(profile,'sidebar-layout-observer');await launch();
 assert.equal(await page.locator('.sidebar-sash').count(),2,'Both existing section boundaries must be draggable separators');
 await page.locator('#composer').getByRole('button',{name:'继续原生会话',exact:true}).click();
 await until(async()=>(await snapshot()).sessions.find(s=>s.id===ids[0]).state==='idle','Original synthetic session resumed');
 await page.locator('#message-input').fill('T68 private draft, never send');await until(async()=>(await snapshot()).sessions[0].liveDraft==='T68 private draft, never send','Draft acknowledged');
 await peer.evaluate(async list=>{for(const id of list)await workspace.archiveSession(id)},ids.slice(12));
 await installSpy();const original=(await snapshot()).sessions[0], beforeNative=await app.evaluate(()=>globalThis.layoutOps.native.length);
 const first=await dimensions();await dragSash(0,36);await until(async()=>Array.isArray(await preference()),'Sizing preference saved');const moved=await preference();await saved(moved);
 const after=await dimensions();assert.ok(after.groups[0].height>first.groups[0].height+30);assert.ok(after.groups[1].height<first.groups[1].height-30);
 assert.equal(await page.locator('#archive-group-body').isHidden(),true);
 assert.equal(await app.evaluate(()=>globalThis.layoutOps.sidebar.filter(x=>x.type==='resize').length),1,'Pointer move previews commit once on release');
 checks.push('Actual pointer drag sizes the original sections, commits once and is observed in both windows');

 const sash=page.locator('#sidebar-session-sash');await sash.focus();const saves=await app.evaluate(()=>globalThis.layoutOps.sidebar.filter(x=>x.type==='resize').length);
 await page.keyboard.down('ArrowUp');await page.keyboard.down('ArrowUp');await page.keyboard.down('ArrowUp');await page.keyboard.up('ArrowUp');
 await until(async()=>!equal(await preference(),moved),'Keyboard size saved');assert.equal(await app.evaluate(()=>globalThis.layoutOps.sidebar.filter(x=>x.type==='resize').length),saves+1,'Repeated keydown saves once at release');
 await sash.press('Home');await until(async()=>(await preference())[0]===1,'Home reaches minimum');await sash.press('End');await until(async()=>(await preference())[1]===1,'End reaches maximum');
 await sash.dblclick();await until(async()=>Math.abs((await preference())[0]-(await preference())[1])<=1,'Double click restores equal pair');
 await page.locator('#archive-button').click();await until(()=>page.locator('#archive-group-body').isVisible(),'Archive is original inline section');assert.equal(await page.locator('#archive-dialog').count(),0);
 const allOpen=await preference(), allSizes=await dimensions();await page.locator('#workspace-toggle').click();await until(()=>page.locator('#workspace-group-body').isHidden(),'Middle group folded');
 assert.equal(await page.locator('#sidebar-workspace-sash').getAttribute('aria-disabled'),'true');
 await page.locator('#workspace-toggle').press('ArrowRight');await until(()=>page.locator('#workspace-group-body').isVisible(),'Middle group restored');assert.deepEqual(await preference(),allOpen);
 const restored=await dimensions();assert.ok(Math.abs(restored.groups[1].height-allSizes.groups[1].height)<2,'Fold restores prior height, not an arbitrary new size');
 for(const id of ['solo-drop','workspace-toggle','archive-button'])await page.locator('#'+id).press('ArrowLeft');
 await until(async()=>(await dimensions()).groups.every(g=>g.height<50),'All folded sections occupy headers only');
 for(const id of ['solo-drop','workspace-toggle','archive-button'])await page.locator('#'+id).press('ArrowRight');await until(async()=>{for(const id of ['session-list','workspace-group-body','archive-group-body'])if(!await page.locator('#'+id).isVisible())return false;return true},'Three groups open again');
 checks.push('Keyboard repeat, Home, End and reset, three independent folds and restored sizes retain saved preferences');

 for(const id of ['session-list','workspace-group-body','archive-group-body']){
  if(id==='workspace-group-body'){await page.locator('#sidebar-workspace-sash').press('Home');await until(async()=>(await preference())[1]===1,'Room content shrunk for independent scroll');}
  const e=page.locator('#'+id);const metrics=await e.evaluate(n=>[n.scrollHeight,n.clientHeight]);assert.ok(metrics[0]>metrics[1],id+' has an independently scrollable body');
  const before=await page.evaluate(()=>['session-list','workspace-group-body','archive-group-body'].map(id=>document.getElementById(id).scrollTop));
  const b=await e.boundingBox();assert.ok(b);await page.mouse.move(b.x+b.width/2,b.y+b.height/2);await page.mouse.wheel(0,140);
  await until(async()=>(await e.evaluate(n=>n.scrollTop))>0,id+' responds to wheel');
  const after=await page.evaluate(()=>['session-list','workspace-group-body','archive-group-body'].map(id=>document.getElementById(id).scrollTop));
  const index=['session-list','workspace-group-body','archive-group-body'].indexOf(id);for(let i=0;i<3;i++)if(i!==index)assert.equal(after[i],before[i],'Other section did not scroll');
 }
 await capture('three-scrollable-sections');
 await page.locator('#sidebar-workspace-sash').dblclick();await until(async()=>(await preference())[1]>1000,'Restore room away from minimum before cancel/write-failure cases');
 const beforeCancel=await preference();await dragSash(0,20,false);await peer.locator('#workspace-toggle').press('ArrowLeft');await until(()=>page.locator('#workspace-group-body').isHidden(),'External collapse during gesture');await page.mouse.up();assert.deepEqual(await preference(),beforeCancel,'Structural change cancels unsaved drag');
 await page.locator('#workspace-toggle').press('ArrowRight');await until(()=>page.locator('#workspace-group-body').isVisible(),'Room expanded before failure cases');
 assert.equal(await app.evaluate(()=>globalThis.layoutOps.native.length),beforeNative,'Sizing/scrolling/folding never claims or inputs to a native session');
 const current=(await snapshot()).sessions[0];for(const k of ['id','nativeId','pid','owner','liveDraft','controlRevision'])assert.deepEqual(current[k],original[k]);
 checks.push('Each original section scrolls alone; external collapse cancels a pending drag without native control/input/draft changes');

 const metadata=fs.readFileSync(path.join(profile,'session-labels.json'),'utf8'),beforeFailure=await preference();assert.ok(beforeFailure[1]>1000,'Failure trial must have room to resize');
 await app.evaluate(()=>{const fs=process.getBuiltinModule('fs');globalThis.layoutRename=fs.renameSync;fs.renameSync=(from,to)=>{if(String(to).endsWith('/session-labels.json'))throw Error('Synthetic metadata disk failure');return globalThis.layoutRename(from,to)}});
 await sash.press('ArrowDown');await page.locator('#toast').getByText('未能保存会话显示设置',{exact:false}).waitFor();assert.equal(fs.readFileSync(path.join(profile,'session-labels.json'),'utf8'),metadata);assert.deepEqual(await preference(),beforeFailure);
 await app.evaluate(()=>{process.getBuiltinModule('fs').renameSync=globalThis.layoutRename});await sash.press('ArrowDown');await until(async()=>!equal(await preference(),beforeFailure),'Explicit resize retry saved');
 await app.evaluate(()=>{globalThis.layoutOps.hold=true});await sash.press('ArrowDown');await until(async()=>await app.evaluate(()=>globalThis.layoutOps.pending.length===1),'One held old resize ACK');
 await app.evaluate(()=>{globalThis.layoutOps.hold=false});await sash.press('ArrowDown');await delay(150);const newer=await preference(),newerSizes=await dimensions();
 await app.evaluate(()=>globalThis.layoutOps.pending.shift()({ok:false,error:'Synthetic old resize refused'}));await page.locator('#toast').getByText('Synthetic old resize refused',{exact:false}).waitFor();assert.deepEqual(await preference(),newer);assert.ok(Math.abs((await dimensions()).groups[0].height-newerSizes.groups[0].height)<2);
 checks.push('Actual atomic save failure preserves metadata and reverts geometry; retry succeeds; a late rejected old resize cannot undo newer sizing');

 await page.locator('#session-list').evaluate(n=>n.scrollTop=0);await menu(ids[0],'重命名…');await page.locator('#rename-name').fill('T68 unsaved inline name');await page.locator('#rename-name').evaluate(n=>{window.t68Editor=n});
 await dragSash(0,-30);assert.equal(await page.locator('#rename-name').evaluate(n=>n===window.t68Editor),true);assert.equal(await page.locator('#rename-name').inputValue(),'T68 unsaved inline name');
 await page.locator('#solo-drop').press('ArrowLeft');await page.locator('#solo-drop').press('ArrowRight');assert.equal(await page.locator('#rename-name').inputValue(),'T68 unsaved inline name');
 await peer.evaluate(id=>workspace.archiveSession(id),ids[0]);await until(()=>page.locator('#confirm-rename').isDisabled(),'Edited archived row is retained and unavailable');assert.equal(await page.locator('#rename-name').evaluate(n=>n===window.t68Editor),true);
 await peer.evaluate(id=>workspace.restoreSession(id),ids[0]);await until(()=>page.locator('#confirm-rename').isEnabled(),'Same edited row restored');await page.locator('#cancel-rename').click();assert.equal((await snapshot()).sessions[0].name,original.name);
 const archived=ids[12];await page.locator(`[data-archived-session="${archived}"]`).getByRole('button',{name:'恢复会话',exact:true}).click();await until(async()=>!(await snapshot()).sessions.find(s=>s.id===archived).archived,'Original archive restore');assert.equal((await snapshot()).sessions.find(s=>s.id===archived).nativeId,'synthetic-native-12');
 // Positive observation control after the identity-preservation phase: an explicit
 // claim on this owned synthetic record must traverse the same wrapped IPC.
 await page.evaluate(id=>workspace.claim(id,'chat'),ids[0]);
 await until(async()=>await app.evaluate(()=>globalThis.layoutOps.native.includes('claim')),'The same IPC observation sees a deliberate synthetic claim outside the resize phase');
 const observedNativeCalls=await app.evaluate(()=>globalThis.layoutOps.native);
 const originalRoom=(await snapshot()).room;await peer.evaluate(()=>workspace.archiveRoom());await until(()=>page.locator('[data-archived-room]').isVisible(),'Archived workspace is present in original inline archive');
 await page.locator('[data-archived-room]').getByRole('button',{name:'恢复工作区',exact:true}).click();await until(async()=>!(await snapshot()).room.archived&&await page.locator('#room-nav').isVisible()&&await page.locator('[data-archived-room]').count()===0,'Same archived workspace restored from sidebar');
 const restoredRoom=(await snapshot()).room;for(const k of ['id','name','notes','messages'])assert.deepEqual(restoredRoom[k],originalRoom[k]);assert.equal(await page.locator('#archive-button').getAttribute('aria-expanded'),'true','Restore preserves explicit archive section visibility');
 checks.push('Resizing/folding/external archive preserve the same unsent rename input node; inline session/workspace archive restore retains original identities, notes and history without replay');

 const win=await app.browserWindow(page);await win.evaluate(w=>w.setSize(850,600));await delay(400);
 if(await page.locator('.naw[data-native-surface="sidebar"]').getAttribute('data-collapsed')==='true'){const d=await dimensions();await capture('collapsed-rail-before-reveal');assert.ok(d.groups.every(g=>g.headerTop>=d.nav.top-1&&g.headerBottom<=d.nav.bottom+1),'Collapsed rail keeps ALL three section headers inside the navigation before reveal');assert.equal(await page.locator('#archive-button .rail-icon').isVisible(),true,'Original archive icon remains a visible action in the rail');}
 if(await page.locator('.naw[data-native-surface="sidebar"]').getAttribute('data-collapsed')==='true')await page.locator('#archive-button').click();
 await until(async()=>{const d=await dimensions();return d.nav.width>180&&d.groups.every(g=>g.headerTop>=d.nav.top-1&&g.headerBottom<=d.nav.bottom+1)&&d.footer.bottom<=d.innerHeight+1},'Small window retains all group headers and footer controls');
 await capture('narrow-three-sections');const persisted=await preference();await page.reload();await page.locator('#new-session').waitFor();await saved(persisted);
 assert.deepEqual(await preference(),persisted);await app.close();app=null;await launch();assert.deepEqual(await preference(),persisted);
 assert.equal((await snapshot()).sessions.find(s=>s.id===ids[0]).liveDraft,original.liveDraft);assert.deepEqual(errors,[]);const final=await fixture();assert.equal(final.stats.inputs,0);assert.equal(final.stats.sends,0);assert.equal((await snapshot()).diagnostics.dispatches,0);
 checks.push('Actual850×600 sidebar/rail reveal keeps headers/footer reachable; reload and app reopen retain sizing, original identities and unsent draft');
 const result={checks,errors,resizePhaseNativeCalls:0,observedNativeCalls,nativeStats:final.stats,productModels:0,realProviders:0,profile,scriptSha256:createHash('sha256').update(fs.readFileSync(__filename)).digest('hex')};fs.writeFileSync(path.join(profile,'sidebar-layout-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}
const cleanup = testScratch.cleanup(async () => {
  // The two preseeded historical rows have no live runtime to stop. Terminate
  // only this owned synthetic daemon, rather than asking it to forget history.
  try { if (app) await app.close(); if (client) { await fixture('stop'); client.close(); } }
  finally { if (child.connected) child.disconnect(); if (child.exitCode === null) child.kill('SIGTERM'); }
});
run().catch(async error => { console.error(error.stack); if (page && !page.isClosed()) { await capture('failed'); if (process.env.NAW_EVIDENCE_DIR) fs.writeFileSync(path.join(process.env.NAW_EVIDENCE_DIR, 'failure.txt'), await page.locator('body').innerText()); } process.exitCode = 1; }).finally(async () => {
  try { await cleanup(); const saved = JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))); assert.equal(saved.token, token); fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot);
    if (process.env.NAW_EVIDENCE_DIR) fs.writeFileSync(path.join(process.env.NAW_EVIDENCE_DIR, 'released.json'), JSON.stringify({ token, releasedAt: new Date().toISOString(), ownedProfilesAndProcessesGone: true, profile }, null, 2));
    console.log('Owned sidebar fixture cleaned; canonical GUI token released.');
  } catch (error) { console.error('Cleanup unconfirmed; own lock retained:', error.stack); process.exitCode = 1; }
});
