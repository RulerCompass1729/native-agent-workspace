// One owned source GUI: measure approved notes spacing and preserve edits made during Save.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), { randomUUID, createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const args = process.argv.slice(2), option = key => args.includes(key) ? args[args.indexOf(key) + 1] : undefined;
const plan = { profiles: 1, fakeBackends: 1, windows: 1, guiStarts: 1, syntheticSessions: 1, rooms: 1, activeMs: 120000, cleanupMs: 90000,
  realProviders: 0, productModels: 0, nativeInput: 0, sends: 0, OSClipboard: 0, actualOSDialogs: 0 };
if (args.includes('--plan')) { console.log(JSON.stringify(plan)); process.exit(0); }
assert.ok(args.includes('--run'), 'Explicit --run required');
const ownerRoot = path.resolve(__dirname, '..'), root = fs.realpathSync(option('--source-root') || ownerRoot), evidence = option('--evidence');
assert.ok(evidence && path.isAbsolute(evidence) && !fs.existsSync(evidence), 'Fresh absolute private evidence required');
assert.ok(!process.env.NAW_APP_EXECUTABLE && !process.env.NAW_TEST_APP_ROOT && !process.env.NAW_EVIDENCE_DIR, 'No ambient target');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const frozenFiles = ['app/renderer/renderer.js', 'app/renderer/styles.css', 'app/dsh/client.js', 'scripts/fixtures/loading-terminal.cjs'];
const pins = Object.fromEntries(frozenFiles.map(file => [file, hash(fs.readFileSync(path.join(root, file)))]));
pins.driver = hash(fs.readFileSync(__filename));
assert.ok(fs.readFileSync(path.join(root, 'app/dsh/client.js'), 'utf8').includes("const submitted = $('room-notes-text').value"), 'Build exact patched renderer first');
assert.ok(option('--baseline-css') && path.isAbsolute(option('--baseline-css')), 'Exact baseline CSS required');
const css = fs.readFileSync(path.join(root, 'app/renderer/styles.css'), 'utf8'), marker = '/* Compact existing notes dialog:', last = '/* End compact existing notes dialog. */';
const from = css.indexOf(marker), to = css.indexOf(last); assert.ok(from >= 0 && to > from); const delta = css.slice(from, to + last.length + 1);
assert.equal(hash(css.replace(delta, '')), hash(fs.readFileSync(option('--baseline-css'))), 'Only the exact approved spacing delta');
if (args.includes('--check')) { console.log(JSON.stringify({ sourcePreflight: true, root, pins, plan, CSSOnly: true })); process.exit(0); }
const scratch = require(path.join(root, 'scripts/fixtures/test-scratch.cjs'));
const { _electron } = scratch.playwright(require(path.join(root, 'node_modules/playwright')));
const { connect } = require(path.join(root, 'app/service-client.cjs'));
const { createSourceEntry } = require(path.join(root, 'scripts/fixtures/synthetic-source-boot.cjs'));
const { chooseRecipient, fillRoomMessage } = require(path.join(root, 'scripts/room-input.cjs'));
const locale = require(path.join(root, 'app/ui-locale.js'));
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: ownerRoot, encoding: 'utf8' }).trim();
const slot = path.resolve(common, '..', '.local/gui-test-slot.lock'), token = randomUUID();
try { fs.mkdirSync(slot, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; console.error('OCCUPIED: zero allocation'); process.exit(75); }
const lease = fs.lstatSync(slot);
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Codex2', task: 'T163 notes spacing and pending-save edits', token, pid: process.pid, at: new Date().toISOString(), plan }));
let profile, child, client, app, page, timer, sequence = 0, failure;
const began = Date.now(), result = { at: new Date().toISOString(), plan, pins, errors: [], stages: [], measurements: [] };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const env = extra => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NAW_') && !key.startsWith('ELECTRON_') && !['NODE_OPTIONS', 'NODE_PATH'].includes(key))), ...extra });
async function until(read, label) { for (let n = 0; n < 140; n++) { assert.ok(Date.now() - began < plan.activeMs, 'Active cap'); if (await read()) return; await delay(50); } throw Error(label); }
function fixture(method = 'stats', target, value) { const id = ++sequence; return new Promise((resolve, reject) => { const done = message => { if (message.requestId === id) { clearTimeout(timeout); child.off('message', done); fs.appendFileSync(path.join(evidence, 'fixture.jsonl'), JSON.stringify(message) + '\n'); resolve(message); } }; const timeout = setTimeout(() => { child.off('message', done); reject(Error('Owned fixture request timed out')); }, 5000); child.on('message', done); child.send({ id, method, target, value }); }); }
async function settle() { for (let n = 0; n < 6; n++) { const stats = await fixture(); assert.deepEqual(stats.waitingInputs, []); if (!stats.pending.length) return; for (const id of new Set(stats.pending)) await fixture('release', id); } throw Error('Passive synthetic snapshots did not settle'); }
const snapshot = () => page.evaluate(() => workspace.initial());
async function setCSS(fixed) { await page.evaluate(({ delta, fixed }) => { if (!window.inviteDensityOriginal) { const nodes = [...document.querySelectorAll('style')].filter(e => e.textContent.includes(delta)); if (nodes.length !== 1) throw Error('Exact compiled stylesheet missing'); window.inviteDensityNode = nodes[0]; window.inviteDensityOriginal = nodes[0].textContent; } window.inviteDensityNode.textContent = fixed ? window.inviteDensityOriginal : window.inviteDensityOriginal.replace(delta, ''); }, { delta, fixed }); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function sample() {
 return page.locator('#notes-dialog').evaluate(d => {
  const box = e => { const r = e.getBoundingClientRect(); return { x:r.x, y:r.y, w:r.width, h:r.height, right:r.right, bottom:r.bottom }; };
  const data = e => { const s=getComputedStyle(e); return { id:e.id,text:e.textContent,value:e.value,role:e.getAttribute('role'),disabled:e.disabled,hidden:e.hidden,rows:e.rows,maxLength:e.maxLength,readOnly:e.readOnly,resize:s.resize,font:s.fontSize,line:s.lineHeight,family:s.fontFamily,weight:s.fontWeight,box:box(e) }; };
  return { open:d.open,box:box(d),scrollHeight:d.scrollHeight,clientHeight:d.clientHeight,scrollTop:d.scrollTop,viewport:[innerWidth,innerHeight],fields:[d.querySelector('h2'),...d.querySelectorAll('p'),d.querySelector('textarea'),...d.querySelectorAll('button')].map(data) };
 });
}
async function capture(label) { const data=await sample(); fs.writeFileSync(path.join(evidence,label+'.json'),JSON.stringify(data,null,2)); await page.screenshot({path:path.join(evidence,label+'.png')}); result.stages.push({label,...data}); return data; }
const facts = s => s.fields.map(({box,...rest})=>rest);
async function compare(label) {
 await page.locator('#notes-dialog').evaluate(d=>{d.scrollTop=0;}); await setCSS(false); const before=await capture(label+'-before'); await setCSS(true); const after=await capture(label+'-after');
 const m={label,outerSaved:before.box.h-after.box.h,scrollSaved:before.scrollHeight-after.scrollHeight,editorShift:0}; result.measurements.push(m);
 assert.deepEqual(facts(after),facts(before),'Original text/value/state/fonts/rows/limits remain'); assert.equal(after.box.w,before.box.w); assert.equal(after.box.x,before.box.x);
 assert.ok(m.outerSaved>0||m.scrollSaved>0,'Actual same-content dialog must be shorter'); assert.ok(after.box.h<=before.box.h+.5);
 for(let i=0;i<after.fields.length;i++) { const f=after.fields[i],old=before.fields[i]; if(f.id==='room-notes-text'||f.id==='cancel-notes'||f.id==='save-notes') { assert.ok(Math.abs(f.box.w-old.box.w)<=.5&&Math.abs(f.box.h-old.box.h)<=.5,'Original editor/control size retained'); assert.ok(Math.abs(f.box.x-old.box.x)<=.5,'Original horizontal placement retained'); if(f.id==='room-notes-text')m.editorShift=(f.box.y-after.box.y)-(old.box.y-before.box.y); else assert.ok(f.box.h>=36); } }
 // Exact CSS, unchanged facts and original sizes constrain movement. Four-rule
 // spacing moves elements vertically; reviewer arithmetic was only a projection.
 assert.equal(after.fields.find(f=>f.id==='room-notes-text').font,'13px'); return after;
}
async function theme(value) { await page.emulateMedia({colorScheme:value}); await until(()=>page.evaluate(v=>document.body.hasAttribute('data-ds-dark-theme')===(v==='dark'),value),'Actual theme '+value); }
async function contrast(label) {
 const raw=await page.locator('#notes-dialog p:not([id])').evaluate(e=>{const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d',{willReadFrequently:true}),rgba=c=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=c;ctx.fillRect(0,0,1,1);const v=[...ctx.getImageData(0,0,1,1).data];return[...v.slice(0,3),v[3]/255];},backgrounds=[];for(let p=e;p;p=p.parentElement)backgrounds.push(rgba(getComputedStyle(p).backgroundColor));return{foreground:rgba(getComputedStyle(e).color),backgrounds};});
 let bg=[255,255,255];for(const c of raw.backgrounds.slice().reverse())bg=bg.map((v,i)=>c[i]*c[3]+v*(1-c[3]));const lum=c=>c.map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((v,x,i)=>v+x*[.2126,.7152,.0722][i],0),a=lum(raw.foreground.slice(0,3).map((v,i)=>v*raw.foreground[3]+bg[i]*(1-raw.foreground[3]))),b=lum(bg),ratio=(Math.max(a,b)+.05)/(Math.min(a,b)+.05);result.contrasts||=[];result.contrasts.push({label,raw,ratio});assert.ok(ratio>=4.5,'Help text contrast >=4.5');
}
async function counters() { const value = {}; if (child?.connected) value.fixture = await fixture(); if (app) value.main = await app.evaluate(() => globalThis.notesTest); result.counters = value; fs.writeFileSync(path.join(evidence, 'stop-counters.json'), JSON.stringify(value, null, 2)); return value; }
const clean = scratch.cleanup(async () => { if (app) await app.close(); if (client) { for (const s of (await client.call('initial')).sessions) await client.call('stop', s.id); await client.call('shutdown'); client.close(); } else if (child?.exitCode === null) child.kill('SIGTERM'); if (child?.connected) child.disconnect(); if (child) { const deadline = Date.now() + plan.cleanupMs; while (child.exitCode === null && Date.now() < deadline) await delay(25); assert.notEqual(child.exitCode, null); } });

(async () => {
 try {
  fs.mkdirSync(evidence); fs.writeFileSync(path.join(evidence, 'admitted.json'), JSON.stringify({ ...result, token }));
  profile = scratch.directory(path.join(os.tmpdir(), 'naw-notes-density-')); result.profile = profile; fs.writeFileSync(path.join(evidence, 'owned-profile.json'), JSON.stringify({ profile, token }));
  child = scratch.childProcess.fork(path.join(root, 'app/daemon.cjs'), [profile], { execArgv: ['--require', path.join(root, 'scripts/fixtures/loading-terminal.cjs')], env: env({ NAW_WORKSPACE: profile, NAW_TEST_APP_ROOT: root, NAW_APP_VERSION: require(path.join(root, 'package.json')).version }), stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  result.backend = { pid: child.pid, start: execFileSync('/bin/ps', ['-p', String(child.pid), '-o', 'lstart='], { encoding: 'utf8' }).trim() }; fs.writeFileSync(path.join(evidence, 'owned-backend.json'), JSON.stringify(result.backend)); child.stderr.on('data', b => fs.appendFileSync(path.join(evidence, 'backend.log'), b));
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Owned service ready'); client = await connect(profile, 'notes-density-seed'); assert.equal((await client.call('initial')).sessions.length, 0);
  const eligible = await client.call('create', { provider: 'claude', cwd: profile, name: 'Eligible synthetic', view: 'chat' });
  await client.call('join', eligible, true); result.ids = { eligible };
  const entry = createSourceEntry({ profile, code: root, fixturePid: child.pid }), entryFile = path.join(entry, 'entry.cjs');
  // This one synthetic record is a display fixture, NOT a qualified old backend.
  const prefix = `const e=require('electron');globalThis.notesTest={guards:{clipboard:0,external:0,dialogs:0},actions:[],holdNext:false,held:false};require(${JSON.stringify(path.join(root, 'app/preflight.cjs'))}).preflight=()=>({claude:true,codex:true,python:true,paths:{},configured:{}});for(const k of ['readText','writeText','readImage','writeImage','read','write','readBuffer','writeBuffer','clear'])e.clipboard[k]=()=>{globalThis.notesTest.guards.clipboard++;throw Error('OS clipboard prohibited');};e.shell.openExternal=e.shell.openPath=async()=>{globalThis.notesTest.guards.external++;throw Error('External open prohibited');};for(const k of ['showOpenDialog','showSaveDialog','showMessageBox','showOpenDialogSync','showSaveDialogSync','showMessageBoxSync'])e.dialog[k]=()=>{globalThis.notesTest.guards.dialogs++;throw Error('Actual OS dialog prohibited');};\n`;
  fs.writeFileSync(entryFile, prefix + fs.readFileSync(entryFile, 'utf8')); fs.copyFileSync(entryFile, path.join(evidence, 'actual-entry.cjs'));
  app = await _electron.launch({ executablePath: require(path.join(root, 'node_modules/electron')), args: [entry], env: env({ NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }), timeout: 45000 });
  result.gui = { pid: app.process().pid, start: execFileSync('/bin/ps', ['-p', String(app.process().pid), '-o', 'lstart='], { encoding: 'utf8' }).trim() }; fs.writeFileSync(path.join(evidence, 'owned-gui.json'), JSON.stringify(result.gui));
  page = await app.firstWindow(); page.setDefaultTimeout(7000); page.on('pageerror', e => result.errors.push(e.message)); timer = setTimeout(() => app.close().catch(() => {}), Math.max(1, plan.activeMs - (Date.now() - began)));
  await page.locator('#panorama-nav').waitFor(); result.windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ visible: w.isVisible(), focusable: w.isFocusable() }))); assert.deepEqual(result.windows, [{ visible: false, focusable: false }]);
  assert.equal(await app.evaluate(({ app }) => app.getVersion()), require(path.join(root, 'package.json')).version);
  await app.evaluate(({ipcMain}) => {
   const key='workspace:spaceAction', original=ipcMain._invokeHandlers.get(key); if(!original)throw Error('Original handler missing');
   ipcMain.removeHandler(key);ipcMain.handle(key,async(...args)=>{
    globalThis.notesTest.actions.push(args.slice(1));
    if(globalThis.notesTest.holdNext&&args[2]==='notes'){globalThis.notesTest.holdNext=false;globalThis.notesTest.held=true;await new Promise(resolve=>{globalThis.releaseNotes=resolve;});globalThis.notesTest.held=false;}
    return original(...args);
   });
  });
  const member=()=>page.locator('[data-panorama-session="'+eligible+'"]');
  async function privateView(){await page.locator('#panorama-nav').click();await member().locator('.panorama-member-heading>button').click();await settle();}
  async function sharedView(){await page.locator('#panorama-nav').click();await member().locator('[data-panorama-space="shared"]').click();await settle();}
  await privateView();await page.locator('#take-control').click();const privateText='PRIVATE UNSENT notes',sharedText='SHARED UNSENT notes';
  await page.locator('#message-input').fill(privateText);await until(async()=>JSON.stringify((await snapshot()).viewState).includes(privateText),'Private draft persisted');
  await sharedView();await chooseRecipient(page,eligible);await fillRoomMessage(page,sharedText);await until(async()=>JSON.stringify((await snapshot()).viewState).includes(sharedText),'Shared draft persisted');
  const savedShared=await page.locator('#shared-input').inputValue();result.before=await snapshot();
  async function records(){await sharedView();await page.locator('#room-record').click();await until(()=>page.locator('#room-record').getAttribute('aria-pressed').then(v=>v==='true'),'Actual records surface');}
  async function openNotes(){await records();await page.locator('#room-notes').click();await page.locator('#notes-dialog').waitFor();}
  async function closeNotes(){await page.locator('#cancel-notes').click();await until(()=>page.locator('#room-notes-text').inputValue().then(v=>v===''),'Actual close cleared notes');await until(()=>page.locator('#room-notes').evaluate(e=>e===document.activeElement),'Focus returned to Notes');}
  const room=async()=>{const s=await snapshot();return s.rooms.find(r=>r.id==='shared');};
  async function externalNotes(text){const r=await room();await page.evaluate(({text,revision})=>workspace.spaceAction('shared','notes',[text,revision]),{text,revision:r.metadataRevision});}
  async function widths(label){await theme('light');for(const width of[850,400]){await page.setViewportSize({width,height:900});await compare(label+'-'+width);}await page.setViewportSize({width:850,height:900});}
  const body='完整原文 中文与 English words\n'+Array.from({length:20},(_,i)=>'Original complete line '+i+' 原样保留').join('\n');
  for(const language of['zh','en']){
   if(language==='en'){await page.locator('#setup-button').click();await page.locator('#ui-language').selectOption('en');await until(async()=>await page.locator('#ui-language').getAttribute('aria-busy')==='false'&&await page.locator('#setup-title').textContent()===locale.format('en','common.settings'),'English preference');await page.locator('#close-setup').click();}
   await externalNotes('');await openNotes();assert.equal(await page.locator('#room-notes-text').inputValue(),'');await widths('empty-'+language);await closeNotes();
   await externalNotes(body);await openNotes();assert.equal(await page.locator('#room-notes-text').inputValue(),body);await widths('normal-'+language);
   await theme('dark');await compare('normal-dark-'+language);await contrast('dark-'+language);await theme('light');await contrast('light-'+language);
   await page.locator('#room-notes-text').focus();await page.keyboard.press('Tab');assert.equal(await page.locator('#cancel-notes').evaluate(e=>e===document.activeElement&&e.matches(':focus-visible')),true);
   await externalNotes('Another explicit owned revision '+language);await page.locator('#save-notes').click();await until(()=>page.locator('#notes-error').isVisible(),'Real revision conflict');
   assert.equal(await page.locator('#notes-error').textContent(),locale.format(language,'error.room.dataChangedElsewhere'));assert.equal(await page.locator('#room-notes-text').inputValue(),body);assert.equal((await room()).notes,'Another explicit owned revision '+language);await widths('conflict-'+language);
   await page.setViewportSize({width:400,height:300});await page.locator('#room-notes-text').hover();await page.mouse.wheel(0,10000);await until(()=>page.locator('#room-notes-text').evaluate(e=>e.scrollTop+e.clientHeight>=e.scrollHeight-2),'Editor final line reachable');
   await page.locator('#notes-dialog').hover({position:{x:5,y:5}});await page.mouse.wheel(0,10000);await until(()=>page.locator('#notes-dialog').evaluate(d=>{const b=d.querySelector('#save-notes').getBoundingClientRect(),r=d.getBoundingClientRect();return d.scrollTop>0&&b.bottom<=r.bottom-d.clientTop;}),'Short dialog Save reachable');
   await capture('short-conflict-'+language);await closeNotes();await page.setViewportSize({width:850,height:900});
   await openNotes();const submitted='Explicit submitted '+language,late='New unsaved late edit '+language;
   await page.locator('#room-notes-text').fill(submitted);await app.evaluate(()=>{globalThis.notesTest.holdNext=true;});await page.locator('#save-notes').click();
   await until(()=>app.evaluate(()=>globalThis.notesTest.held),'Owned original IPC held');assert.equal(await page.locator('#save-notes').isDisabled(),true);assert.equal(await page.locator('#cancel-notes').isEnabled(),true);assert.equal(await page.locator('#room-notes-text').isEditable(),true);
   await widths('saving-'+language);await page.locator('#room-notes-text').fill(late);await app.evaluate(()=>globalThis.releaseNotes());
   await until(()=>page.locator('#save-notes').isEnabled(),'Next explicit Save enabled');assert.equal(await page.locator('#notes-dialog').isVisible(),true);assert.equal(await page.locator('#room-notes-text').inputValue(),late);assert.equal((await room()).notes,submitted);await capture('late-edit-retained-'+language);
   await page.locator('#save-notes').click();await page.locator('#notes-dialog').waitFor({state:'hidden'});await until(async()=>(await room()).notes===late,'Second explicit Save persisted');await until(()=>page.locator('#room-notes-text').inputValue().then(v=>v===''),'Saved editor cleared');
  }
  await sharedView();assert.equal(await page.locator('#shared-input').inputValue(),savedShared);await privateView();assert.equal(await page.locator('#message-input').inputValue(),privateText);result.after=await snapshot();
  const identity=s=>s.sessions.map(r=>[r.id,r.nativeId,r.owner,r.roomIds]);assert.deepEqual(identity(result.after),identity(result.before));assert.ok(JSON.stringify(result.after.viewState).includes(privateText)&&JSON.stringify(result.after.viewState).includes(sharedText));
  result.noteDisk=JSON.parse(fs.readFileSync(path.join(profile,'room-state.json'),'utf8'));assert.equal(result.noteDisk.notes,'New unsaved late edit en');assert.ok(result.noteDisk.events.some(e=>e.text.includes('New unsaved late edit en')),'Actual retained note history');
  const final=await counters();for(const key of['inputs','sends','interruptions','waitingInputs','pending'])assert.deepEqual(final.fixture[key],[]);assert.deepEqual(final.main.guards,{clipboard:0,external:0,dialogs:0});assert.ok(final.main.actions.every(a=>a[0]==='shared'&&a[1]==='notes'),'Only intentional owned note actions');assert.deepEqual(result.errors,[]);
  for(const file of frozenFiles)assert.equal(hash(fs.readFileSync(path.join(root,file))),pins[file]);assert.equal(hash(fs.readFileSync(__filename)),pins.driver);result.outcome='SOURCE_GUI_NOTES_DENSITY_AND_LATE_EDIT_PASS_NOT_INSTALLED';
 } catch (error) { failure = error.stack; process.exitCode = 1; result.outcome = 'INCOMPLETE_NOT_PASS'; try { await counters(); } catch (e) { result.counterError = e.message; } if (page && !page.isClosed()) { await capture('failure').catch(() => {}); await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {}); } }
 finally { clearTimeout(timer); result.failure = failure; result.activeSeconds = (Date.now() - began) / 1000; fs.mkdirSync(evidence, { recursive: true }); fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2) + '\n'); const at = Date.now(); try { await clean(); assert.ok(!profile || !fs.existsSync(profile)); const current = fs.lstatSync(slot); assert.equal(current.ino, lease.ino); assert.equal(current.dev, lease.dev); assert.equal(JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))).token, token); fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot); const released = { at: new Date().toISOString(), token, profileGone: true, cleanupSeconds: (Date.now() - at) / 1000 }; fs.writeFileSync(path.join(evidence, 'released.json'), JSON.stringify(released)); console.log(JSON.stringify({ outcome: result.outcome, failure, density: result.measurements.map(m => [m.label,m.outerSaved,m.scrollSaved]), released })); } catch (e) { process.exitCode = 1; fs.writeFileSync(path.join(evidence, 'cleanup-failure.txt'), e.stack); console.error(e.stack); } }
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
