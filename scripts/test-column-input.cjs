// Actual isolated source GUI/service. Only native output is synthetic.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const scratch = require(path.join(root,'scripts/fixtures/test-scratch.cjs')), { createIn } = require(path.join(root,'scripts/fixtures/create-view.cjs'));
const { _electron } = scratch.playwright(require('playwright'));
const evidence = process.env.NAW_EVIDENCE_DIR;
const columnCase = process.env.NAW_COLUMN_CASE || 'full';
assert.ok(['full','fallback','long','retry'].includes(columnCase), 'Unknown column acceptance case');
if (evidence) {
  const target = path.resolve(evidence); let existing = target;
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  const destination = path.join(fs.realpathSync(existing), path.relative(existing, target));
  for (const base of [root, code].map(p => fs.realpathSync(p))) assert.ok(destination !== base && !destination.startsWith(base + path.sep));
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
}
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID();
try { fs.mkdirSync(slot); } catch (e) { if (e.code !== 'EEXIST') throw e; console.error('GUI slot occupied; nothing started.'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Codex4', task: 'T84 column input source acceptance', token, pid: process.pid, time: new Date().toISOString() }));
const profile = scratch.directory(path.join(os.tmpdir(), 'naw-column-input-'));
const ownedProfile = fs.realpathSync(profile), workspacePath = path.join(profile, 'workspace');
assert.ok(path.resolve(ownedProfile, 'workspace').startsWith(ownedProfile + path.sep));
fs.mkdirSync(workspacePath, { recursive: true, mode: 0o700 }); assert.ok(fs.realpathSync(workspacePath).startsWith(ownedProfile + path.sep));
const child = scratch.childProcess.fork(path.join(code, 'app/daemon.cjs'), [profile], {
  execArgv: ['--require', path.join(root,'scripts/fixtures/column-input.cjs')],
  env: { ...process.env, NAW_TEST_APP_ROOT: code, NAW_WORKSPACE: workspacePath, NAW_APP_VERSION: require(path.join(code, 'package.json')).version },
  stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
});
const checks = [], errors = [], measurements = [];
let app, page, sequence = 0, failure = null;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { for (let i = 0; i < 200; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
function fixture(method, target, value) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const callback = reply => { if (reply.requestId === id) { clearTimeout(timer); child.off('message', callback); reply.error ? reject(Error(reply.error)) : resolve(reply); } };
    const timer = setTimeout(() => { child.off('message', callback); reject(Error('Fixture timed out')); }, 12000);
    child.on('message', callback); child.send({ id, method, target, value });
  });
}
const snapshot = () => page.evaluate(() => workspace.initial());
const check = text => { checks.push(text); console.log('PASS:', text); };
const sourceFiles = ['app/renderer/renderer.js','app/renderer/session-composer.js','app/renderer/collaboration-overview.js','app/renderer/collaboration-overview.css','app/renderer/context-menu.js','app/renderer/index.html','app/renderer/styles.css','scripts/build-ui.cjs','scripts/test-column-input.cjs','scripts/fixtures/column-input.cjs','app/tests/composer-action.test.cjs','docs/interaction.md','app/dsh/client.js'];
const sourceHashes = () => Object.fromEntries(sourceFiles.map(file=>[file,require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(code,file))).digest('hex')]));
const sourceBefore=sourceHashes();

async function launch() {
  app = await _electron.launch({ executablePath: require('electron'), args: [code], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message)); await page.locator('#new-session').waitFor();
  await app.evaluate(({ clipboard }) => { globalThis.pageCopies = []; clipboard.writeText = text => globalThis.pageCopies.push(text); });
}
async function create(name, provider = 'codex') {
  const previous = new Set((await snapshot()).sessions.map(s => s.id));
  await page.locator('#new-session').click(); await page.locator(`input[name="provider"][value="${provider}"]`).check();
  await page.locator('#session-name').fill(name); await createIn(page, 'chat');
  return (await snapshot()).sessions.find(s => s.name === name && !previous.has(s.id)).id;
}
async function capture(name) { if (evidence) await page.screenshot({ path: path.join(evidence, name + '.png') }); }
async function readingAnchor(host = page.locator('#messages')) {
  return host.evaluate(el => {
    const top = el.getBoundingClientRect().top;
    const row = [...el.querySelectorAll(':scope > [data-message-id]')].find(n => n.getBoundingClientRect().bottom > top);
    return row && { id: row.dataset.messageId, offset: row.getBoundingClientRect().top - top };
  });
}
async function copyOriginal(host, id, text) {
  const before = await app.evaluate(() => globalThis.pageCopies.length);
  const copy = host.locator(`[data-message-id="${id}"] .message-actions`).getByRole('button', { name: '复制', exact: true });
  await copy.focus(); await copy.press('Enter');
  await until(async () => await app.evaluate((_, n) => globalThis.pageCopies.length === n + 1 && globalThis.pageCopies.at(-1), before) === text, 'One fresh original copy receipt');
}

async function run(){
 await until(()=>fs.existsSync(path.join(profile,'connection.json')),'Owned fixture ready');await launch();
 const ownedRoot=fs.realpathSync(profile);assert.ok(fs.realpathSync((await snapshot()).defaultWorkspace).startsWith(ownedRoot+path.sep));
 const ids=[];
 for(let i=0;i<4;i++){
  const id=await create('Column '+(i+1), i===3?'claude':'codex');ids.push(id);
  await fixture('history',id,Array.from({length:6},(_,j)=>({id:'column-'+i+'-'+j,type:'agentMessage',turnId:'column-turn-'+i,text:'Original member '+i+' paragraph '+j})));
  await page.locator('#message-input').fill('Private column draft '+i);
  await until(async()=>(await snapshot()).sessions.find(s=>s.id===id).liveDraft==='Private column draft '+i,'Private draft saved');
  await page.locator('#session-header-more').click();await page.getByRole('menuitem',{name:'加入协作',exact:true}).click();
 }
 await page.locator('#room-nav').click();await (await app.browserWindow(page)).evaluate(win=>win.setContentSize(850,600));
 await delay(200);
 const columns=await page.locator('.collaboration-member-reader').evaluateAll(xs=>xs.map(el=>({id:el.dataset.memberId,textboxes:el.querySelectorAll('textarea,input:not([type=hidden])').length,box:el.getBoundingClientRect().toJSON()})));
 const state=await snapshot(),packet=await fixture('stats');assert.equal(packet.stats.inputs,0);assert.equal(packet.stats.sends,0);assert.equal(packet.overviewCalls.claim,0);
 assert.ok(state.sessions.every(s=>fs.realpathSync(s.cwd).startsWith(ownedRoot+path.sep)));
 measurements.push({label:'baseline-four-column-input',columns,identities:state.sessions.map(s=>[s.id,s.nativeId,s.owner,s.roomId,s.liveDraft]),stats:packet});
 await capture('01-four-columns');
 assert.ok(columns.length===4&&columns.every(x=>x.textboxes===1),'Every existing column has exactly one private composer');
 assert.deepEqual(errors,[]);check('Four column inputs mounted passively without claim, input or send');
 const field=id=>page.locator(`.collaboration-member-reader[data-member-id="${id}"] .session-message-input`);
 for(let i=0;i<ids.length;i++) { assert.equal(await field(ids[i]).inputValue(),'Private column draft '+i); await field(ids[i]).fill('Changed draft '+i); }
 await until(async()=>(await snapshot()).sessions.every((s,i)=>s.liveDraft==='Changed draft '+ids.indexOf(s.id)),'Each private draft persisted to its own session');
 const columnId=ids[1]; await fixture('bindSends',columnId); await field(columnId).press('Enter');
 await until(async()=>(await fixture('stats')).stats.sends===1,'One private send');
 const sent=await fixture('stats',columnId); assert.equal(sent.lastSend.text,'Changed draft 1');
 assert.equal((await snapshot()).room.messages.length,0); assert.equal((await fixture('stats')).overviewCalls.forward,0);
 check('Column Enter sends only to its bound member without a shared row or forward');
 await fixture('complete',columnId); await field(columnId).fill('Retained second draft');
 await page.getByRole('button',{name:'列表',exact:true}).click();assert.equal(await page.locator('.collaboration-member-input:visible').count(),0);
 await page.getByRole('button',{name:'网格',exact:true}).click();assert.equal(await field(columnId).inputValue(),'Retained second draft');
 await page.locator(`.collaboration-member-status[data-member-id="${columnId}"] .collaboration-member-name`).click();
 assert.equal(await page.locator('#message-input').inputValue(),'Retained second draft');await page.locator('#message-input').fill('Solo and column one draft');
 await page.getByRole('button',{name:'← 返回共同工作',exact:true}).click();assert.equal(await field(columnId).inputValue(),'Solo and column one draft');
 check('Grid, List, focused Solo and Back share the same per-session draft');
 await field(ids[0]).focus(); await field(ids[0]).press('Shift+Enter');assert.ok((await field(ids[0]).inputValue()).includes('\n'));
 const sendBefore=(await fixture('stats')).stats.sends;
 await field(ids[0]).dispatchEvent('compositionstart');await field(ids[0]).dispatchEvent('keydown',{key:'Enter',keyCode:229,isComposing:true});await field(ids[0]).dispatchEvent('compositionend',{data:'中文'});await field(ids[0]).dispatchEvent('keypress',{key:'Enter',keyCode:13});await field(ids[0]).dispatchEvent('keyup',{key:'Enter',keyCode:13});
 assert.equal((await fixture('stats')).stats.sends,sendBefore);check('Shift Enter adds a newline and IME confirmation Enter never sends');
 await capture('02-private-drafts');
 // Keep the shared @ draft independent from every private editor.
 const { chooseRecipient, fillRoomMessage } = require('./room-input.cjs');await chooseRecipient(page,ids[3]);await fillRoomMessage(page,'Shared unsent draft');
 const sharedText=await page.locator('#shared-input').inputValue(),sharedRecipient=await page.locator('#recipient').inputValue();
 // Delay a real private send response after service acceptance; a newer draft wins.
 await app.evaluate(({app})=>{const load=process.getBuiltinModule('module').createRequire(app.getAppPath()+'/package.json'),{ServiceClient}=load('./app/service-client.cjs'),call=ServiceClient.prototype.call;
 ServiceClient.prototype.call=async function(method,...args){const value=await call.call(this,method,...args);if(method==='send'&&args[1]==='Delayed private submission')await new Promise(resolve=>globalThis.releaseColumnSendAck=resolve);return value;};});
 await fixture('bindSends',ids[0]);await field(ids[0]).fill('Delayed private submission');await field(ids[0]).press('Enter');await until(()=>app.evaluate(()=>typeof globalThis.releaseColumnSendAck==='function'),'Private send response held');
 await field(ids[0]).fill('New draft after send');await app.evaluate(()=>globalThis.releaseColumnSendAck());await delay(80);assert.equal(await field(ids[0]).inputValue(),'New draft after send');await fixture('complete',ids[0]);
 check('Late private send acknowledgement never erases a newer column draft; shared @ draft and recipient stay independent');
 // Busy Claude uses the existing queue route even with no globally selected member.
 const queueId=ids[3];await fixture('columnQueue',queueId);await until(async()=>(await snapshot()).sessions.find(s=>s.id===queueId).queueAvailable,'Claude queue available');
 for(const newer of [false,true]) {
  await until(async()=>await page.locator(`.collaboration-member-reader[data-member-id="${queueId}"] .session-send-button`).innerText()==='等本轮结束后发送 ↑','Actual column queue action ready');
  await field(queueId).fill('Queued private text');await field(queueId).press('Enter');await until(async()=>(await fixture('stats')).waitingColumnQueues.includes(queueId),'Bound queue waiting');
  await until(async()=>await field(queueId).inputValue()==='','Queued input leaves its own column');if(newer)await field(queueId).fill('New queue draft');
  await fixture('columnRejectQueue',queueId);await until(async()=>await field(queueId).inputValue()===(newer?'New queue draft':'Queued private text'),'Non-send restores only untouched draft');
 }
 assert.ok((await fixture('stats')).columnQueues.every(q=>q.id===queueId&&q.text==='Queued private text'));await fixture('state',queueId,'idle');
 assert.equal((await snapshot()).room.messages.length,0);check('Busy Claude column uses the private queue; proven non-send restores only an untouched draft');
 const imageId=ids[2], imageField=field(imageId), png=await app.evaluate(({nativeImage})=>nativeImage.createFromBitmap(Buffer.from([40,80,120,255]),{width:1,height:1,scaleFactor:1}).toPNG().toString('base64'));
 const beforeImage=await fixture('stats'),savedViewBefore=(await snapshot()).viewState;
 await imageField.evaluate((el,png)=>{const data=Uint8Array.from(atob(png),c=>c.charCodeAt(0)),transfer=new DataTransfer();transfer.items.add(new File([data],'column.png',{type:'image/png'}));el.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:transfer}));},png);
 await until(async()=>(await fixture('stats')).columnInputs.length>beforeImage.columnInputs.length,'Native image path pasted');
 const afterImage=await fixture('stats');assert.equal(afterImage.columnInputs.at(-1).id,imageId);assert.ok(afterImage.columnInputs.at(-1).data.includes('.png'));assert.ok(!afterImage.columnInputs.at(-1).data.includes('\r'));
 assert.ok(afterImage.stats.resizes-beforeImage.stats.resizes<=1);assert.equal(afterImage.stats.sends,beforeImage.stats.sends);
 assert.equal((await snapshot()).sessions.find(s=>s.id===imageId).liveDraft,'Changed draft 2');
 const savedViewAfter=(await snapshot()).viewState;for(const key of ['mode','preference','terminalLayout','roomSession'])assert.equal(savedViewAfter[key],savedViewBefore[key]);
 assert.equal(await page.locator('#shared-input').inputValue(),sharedText);assert.equal(await page.locator('#recipient').inputValue(),sharedRecipient);
 const native=page.locator(`[data-terminal-id="${imageId}"]`);await native.locator('.xterm-helper-textarea').waitFor({state:'visible'});
 assert.equal(await page.locator('#room-session').isVisible(),false);assert.equal(await page.locator('.collaboration-member-reader').count(),4);
 await capture('03-image-native-confirmation');check('Image paste remains in the four-column Grid, targets the named native session, leaves Enter and GUI draft untouched');
 await native.locator('.terminal-surface').evaluate(el=>{const dt=new DataTransfer();dt.setData('text/plain','native-text');el.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:dt}));});
 await until(async()=>(await fixture('stats')).columnInputs.at(-1)?.data==='native-text','Direct native text paste');assert.equal((await fixture('stats')).columnInputs.at(-1).id,imageId);
 // Drop onto the native surface itself uses that entry's fixed identity.
 const beforeDrop=await fixture('stats');await native.locator('.terminal-surface').evaluate((el,png)=>{const dt=new DataTransfer();dt.items.add(new File([Uint8Array.from(atob(png),c=>c.charCodeAt(0))],'drop.png',{type:'image/png'}));el.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));},png);
 await until(async()=>(await fixture('stats')).columnInputs.length>beforeDrop.columnInputs.length,'Image drop onto native surface');const dropped=await fixture('stats');assert.equal(dropped.columnInputs.at(-1).id,imageId);assert.ok(!dropped.columnInputs.at(-1).data.includes('\r'));
 check('Image drop and direct native text paste both use the terminal entry target');
 // The existing native and field context menus use the bound column target.
 await app.evaluate(({clipboard,nativeImage})=>{clipboard.readText=()=> 'owned clipboard text';clipboard.readImage=()=>nativeImage.createEmpty();});
 await native.locator('.xterm-helper-textarea').focus();await page.keyboard.press('Shift+F10');await page.getByRole('menuitem',{name:'粘贴',exact:true}).click();
 await until(async()=>(await fixture('stats')).columnInputs.at(-1)?.data==='owned clipboard text','Native menu paste receipt');assert.equal((await fixture('stats')).columnInputs.at(-1).id,imageId);
 await field(ids[0]).focus();await field(ids[0]).evaluate(el=>el.setSelectionRange(el.value.length,el.value.length));await page.keyboard.press('Shift+F10');await page.getByRole('menuitem',{name:'粘贴',exact:true}).click();
 await until(async()=>await field(ids[0]).inputValue()==='New draft after sendowned clipboard text','Bound field menu paste');assert.equal((await snapshot()).sessions.find(s=>s.id===ids[1]).liveDraft,'Solo and column one draft');
 check('Existing native and text-field context-menu paste remain bound to their originating columns');
 // Hold only the image cache response; leaving Grid invalidates the gesture.
 await app.evaluate(({app},id)=>{const load=process.getBuiltinModule('module').createRequire(app.getAppPath()+'/package.json'),images=load('./app/local-images.cjs'),save=images.saveImages;
 images.saveImages=function(...args){const value=save.apply(this,args);if(args[1]!==id)return value;images.saveImages=save;return new Promise(resolve=>{globalThis.releaseColumnImageStage=()=>resolve(value);});};},imageId);
 const heldBefore=await fixture('stats');await imageField.evaluate((el,png)=>{const dt=new DataTransfer();dt.items.add(new File([Uint8Array.from(atob(png),c=>c.charCodeAt(0))],'held.png',{type:'image/png'}));el.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:dt}));},png);
 await until(()=>app.evaluate(()=>typeof globalThis.releaseColumnImageStage==='function'),'Image cache response held');await page.getByRole('button',{name:'列表',exact:true}).click();await app.evaluate(()=>globalThis.releaseColumnImageStage());await delay(100);
 const heldAfter=await fixture('stats');assert.equal(heldAfter.stats.inputs,heldBefore.stats.inputs);assert.equal(heldAfter.overviewCalls.claim,heldBefore.overviewCalls.claim);assert.equal(heldAfter.stats.resizes,heldBefore.stats.resizes);
 await page.getByRole('button',{name:'网格',exact:true}).click();check('A late cached image response after leaving Grid performs no native input, claim or resize');
 const passiveBefore=await fixture('stats');await page.getByRole('button',{name:'列表',exact:true}).click();await page.getByRole('button',{name:'网格',exact:true}).click();await delay(160);
 const passiveAfter=await fixture('stats');assert.equal(passiveAfter.stats.resizes,passiveBefore.stats.resizes);assert.equal(passiveAfter.overviewCalls.claim,passiveBefore.overviewCalls.claim);assert.equal(passiveAfter.stats.inputs,passiveBefore.stats.inputs);
 check('List and Grid return restore the same native entry without input, claim or resize');
 const geometry=await native.evaluate(el=>{const surface=el.querySelector('.terminal-surface'),cursor=el.querySelector('.xterm-cursor'),r=surface.getBoundingClientRect(),c=cursor?.getBoundingClientRect();return {surface:r.toJSON(),cursor:c?.toJSON(),overflow:[surface.scrollWidth,surface.clientWidth,surface.scrollHeight,surface.clientHeight]};});
 measurements.push({label:'native-cursor-850x600',geometry});assert.ok(geometry.cursor&&geometry.cursor.left>=geometry.surface.left-1&&geometry.cursor.right<=geometry.surface.right+1&&geometry.cursor.top>=geometry.surface.top-1&&geometry.cursor.bottom<=geometry.surface.bottom+1,'Actual pasted native cursor fits inside the column');
 const lines=await page.locator('.collaboration-messages').evaluateAll(xs=>xs.map(el=>{const r=el.getBoundingClientRect();return [...el.querySelectorAll('.message-body')].some(n=>{const range=document.createRange();range.selectNodeContents(n);return [...range.getClientRects()].some(q=>q.height>=14&&q.top>=r.top&&q.bottom<=r.bottom);});}));assert.ok(lines.every(Boolean),'Every column still shows a full 14px original text line');
 await native.locator('.xterm-helper-textarea').focus();await page.keyboard.press('Shift+F10');await page.getByRole('menuitem',{name:'粘贴',exact:true}).waitFor();await page.keyboard.press('Tab');
 await page.locator(`.collaboration-member-reader[data-member-id="${imageId}"] .collaboration-member-next`).focus();await page.keyboard.press('Enter');
 assert.equal(await page.locator(`.collaboration-member-status[data-member-id="${ids[3]}"] .collaboration-member-name`).evaluate(el=>el===document.activeElement),true);
 check('Native cursor and original text fit at 850x600; existing content menu and next-member route escape the terminal');
 await native.evaluate(el=>globalThis.oldColumnTerminal=el);await fixture('connection',imageId,'idle');await until(async()=>await native.evaluate(el=>el!==globalThis.oldColumnTerminal).catch(()=>false),'Replacement mounted');assert.equal(await native.count(),1);
 await page.getByRole('button',{name:'简化信息',exact:true}).click();assert.equal(await page.locator('.collaboration-member-input:visible').count(),0);await page.getByRole('button',{name:'简化信息',exact:true}).click();

 // A second intentional owned window observes without taking control.
 const windowOpened=app.waitForEvent('window');await page.evaluate(id=>workspace.newWindow(id),ids[1]);const peer=await windowOpened;await peer.locator('#new-session').waitFor();
 const claimsBefore=(await fixture('stats')).overviewCalls.claim;await delay(100);assert.equal((await fixture('stats')).overviewCalls.claim,claimsBefore);
 await peer.locator('#send-button').click();await until(async()=>{const value=await peer.evaluate(()=>workspace.initial());return value.sessions.find(s=>s.id===ids[1]).owner===value.owner;},'Explicit peer takeover');
 await until(()=>field(ids[1]).evaluate(el=>el.readOnly),'Column becomes read-only for peer owner');
 const claimButton=page.locator(`.collaboration-member-reader[data-member-id="${ids[1]}"] .session-send-button`);assert.equal(await claimButton.innerText(),'接管此窗口');await claimButton.click();await until(()=>field(ids[1]).evaluate(el=>!el.readOnly),'Explicit column takeover');await peer.close();
 check('A second window never passively claims input; explicit column takeover uses the existing owner gate');
 // Actual Chromium composition crosses an explicit zoom and an order change.
 const cdp=await page.context().newCDPSession(page),imeId=ids[0];await field(imeId).fill('Textbox prefix ');await field(imeId).focus();
 await cdp.send('Input.imeSetComposition',{text:'中文草稿',selectionStart:4,selectionEnd:4});
 const beforeIme=await fixture('stats');await page.locator(`.collaboration-member-status[data-member-id="${ids[1]}"] .collaboration-member-name`).click();
 await page.getByRole('button',{name:'← 返回共同工作',exact:true}).click();assert.equal(await field(imeId).inputValue(),'Textbox prefix 中文草稿');assert.equal((await fixture('stats')).stats.sends,beforeIme.stats.sends);
 const nativeIme=page.locator(`[data-terminal-id="${imageId}"] .xterm-helper-textarea`);await nativeIme.focus();
 await cdp.send('Input.imeSetComposition',{text:'终端组合',selectionStart:4,selectionEnd:4});const nativeImeBefore=await fixture('stats');
 await page.locator(`.collaboration-member-status[data-member-id="${imageId}"] .collaboration-member-name`).press('Alt+ArrowUp');await delay(120);
 const nativeImeAfter=await fixture('stats'),originInput=nativeImeAfter.columnInputs.slice(nativeImeBefore.columnInputs.length);
 const recovery=page.locator(`[data-terminal-id="${imageId}"] .terminal-input-recovery textarea`),retained=await recovery.inputValue();
 measurements.push({label:'native-ime-reorder',originInput,retained});assert.equal(originInput.length,0,'Reorder cancels pending native composition before input');assert.equal(retained,'终端组合','Cancelled native text retained exactly once at origin');
 check('Actual Chromium IME crossing zoom or reorder sends nothing and retains the text once at its origin');
 await page.locator(`[data-terminal-id="${imageId}"] .terminal-input-recovery`).getByRole('button',{name:'关闭提示',exact:true}).click();
 await nativeIme.focus();await cdp.send('Input.imeSetComposition',{text:'放大组合',selectionStart:4,selectionEnd:4});const zoomImeBefore=await fixture('stats');
 await page.locator(`.collaboration-member-status[data-member-id="${imageId}"] .collaboration-member-name`).click();await page.locator('#terminal-tab').click();await delay(100);
 const zoomImeAfter=await fixture('stats');assert.equal(zoomImeAfter.stats.inputs,zoomImeBefore.stats.inputs,'Zoom keeps the cancelled origin IME from writing after Solo mount');
 assert.equal(await recovery.inputValue(),'放大组合');await page.locator(`[data-terminal-id="${imageId}"] .terminal-input-recovery`).getByRole('button',{name:'关闭提示',exact:true}).click();
 const returnBefore=await fixture('stats');await nativeIme.focus();await nativeIme.press('z');await until(async()=>(await fixture('stats')).columnInputs.length===returnBefore.columnInputs.length+1,'New Solo key after cancelled composition');
 const newInput=(await fixture('stats')).columnInputs.at(-1);assert.equal(newInput.id,imageId);assert.equal(newInput.data,'z');await page.getByRole('button',{name:'← 返回共同工作',exact:true}).click();
 check('Native IME stays cancelled across zoom, while a fresh Solo key immediately reaches the same native session');
 await cdp.detach();
 const savedDrafts=(await snapshot()).sessions.map(s=>[s.id,s.nativeId,s.liveDraft]);
 const beforeReopen=await fixture('stats');await app.close();app=null;await launch();await page.locator('#room-nav').click();await (await app.browserWindow(page)).evaluate(win=>win.setContentSize(850,600));await delay(250);
 const reopened=await snapshot(),afterReopen=await fixture('stats');assert.deepEqual(reopened.sessions.map(s=>[s.id,s.nativeId,s.liveDraft]),savedDrafts);
 assert.equal(afterReopen.stats.resizes,beforeReopen.stats.resizes);assert.equal(afterReopen.stats.inputs,beforeReopen.stats.inputs);assert.equal(afterReopen.overviewCalls.claim,beforeReopen.overviewCalls.claim);
 assert.equal(await page.locator(`[data-terminal-id="${imageId}"]`).count(),1);assert.equal(await field(ids[1]).inputValue(),'Solo and column one draft');check('Full app reopen retains each private draft, original native identity and visible pending native input without resize, claim or input');
 // Create a fifth existing member: all per-column inputs park, shared @ stays.
 const fifth=await create('Column 5');await page.locator('#session-header-more').click();await page.getByRole('menuitem',{name:'加入协作',exact:true}).click();await page.locator('#room-nav').click();
 assert.equal(await page.locator('.collaboration-member-input:visible').count(),0);assert.equal(await page.locator('#shared-input').isVisible(),true);
 await page.evaluate(id=>workspace.join(id,false),fifth);await until(async()=>await page.locator('.collaboration-member-input:visible').count()===4,'Four columns restored');assert.equal(await field(ids[1]).inputValue(),'Solo and column one draft');
 const beforeRemove=await fixture('stats');await page.evaluate(id=>workspace.join(id,false),imageId);await until(async()=>await page.locator('.collaboration-member-reader').count()===3,'Removed column');
 assert.equal(await page.locator(`[data-terminal-id="${imageId}"]`).isVisible(),false);assert.equal((await fixture('stats')).stats.inputs,beforeRemove.stats.inputs);
 await page.evaluate(id=>workspace.join(id,true),imageId);await until(async()=>await page.locator('.collaboration-member-reader').count()===4,'Rejoined original member');assert.equal((await snapshot()).sessions.find(s=>s.id===imageId).nativeId,savedDrafts.find(s=>s[0]===imageId)[1]);
 check('Brief view, greater-than-four fallback and membership removal preserve the private drafts and native identity');
 assert.ok((await snapshot()).sessions.every(s=>fs.realpathSync(s.cwd).startsWith(ownedProfile+path.sep)));
 assert.deepEqual(errors,[]);



}
async function fallbackCase(){
 await until(()=>fs.existsSync(path.join(profile,'connection.json')),'Owned fixture ready');await launch();const ids=[];
 for(let i=0;i<4;i++){const id=await create('Native fallback '+i);ids.push(id);await page.evaluate(id=>workspace.join(id,true),id);}
 await page.locator('#room-nav').click();await page.getByRole('button',{name:'列表',exact:true}).click();await page.getByRole('button',{name:'网格',exact:true}).click();
 const observations=[];
 async function ascii(label,id,key){await page.locator('#terminal-tab').click();const input=page.locator(`[data-terminal-id="${id}"] .xterm-helper-textarea`);await input.focus();const before=await fixture('stats');await input.press(key);await delay(100);const after=await fixture('stats');observations.push({label,id,key,inputs:after.columnInputs.slice(before.columnInputs.length)});}
 await page.locator(`.collaboration-member-status[data-member-id="${ids[0]}"] .collaboration-member-name`).click();await ascii('Grid zoom native ASCII',ids[0],'a');
 const png=await app.evaluate(({nativeImage})=>nativeImage.createFromBitmap(Buffer.from([40,80,120,255]),{width:1,height:1,scaleFactor:1}).toPNG().toString('base64'));
 const before=await fixture('stats');await page.locator('#message-input').evaluate((el,png)=>{const dt=new DataTransfer();dt.items.add(new File([Uint8Array.from(atob(png),c=>c.charCodeAt(0))],'solo.png',{type:'image/png'}));el.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:dt}));},png);await delay(200);observations.push({label:'Solo image after Grid',id:ids[0],inputs:(await fixture('stats')).columnInputs.slice(before.columnInputs.length)});
 await page.locator('#room-nav').click();await page.locator(`[data-session-id="${ids[2]}"]`).click();await ascii('Sidebar native after Grid',ids[2],'b');
 const fifth=await create('Fifth native');await page.evaluate(id=>workspace.join(id,true),fifth);await page.locator('#room-nav').click();await page.locator(`.collaboration-member-status[data-member-id="${ids[1]}"] .collaboration-member-name`).click();await ascii('Greater than four zoom',ids[1],'c');
 measurements.push(...observations);console.log(JSON.stringify(observations));assert.ok(observations.every(x=>x.inputs.length===1&&x.inputs[0].id===x.id),'All explicit native fallback inputs must reach the original id');check('Zoom, sidebar, greater-than-four and Solo-image native fallbacks each deliver exactly once to the original id');
}

async function longCase(){
 await until(()=>fs.existsSync(path.join(profile,'connection.json')),'Owned fixture ready');await launch();
 const rootOwned=fs.realpathSync(profile);assert.ok(fs.realpathSync((await snapshot()).defaultWorkspace).startsWith(rootOwned+path.sep));
 await create('Long draft preservation');const input=page.locator('#message-input'),text='Long draft text '.repeat(1400);
 await input.focus();await page.keyboard.insertText(text);const value=await input.inputValue();measurements.push({requested:text.length,retained:value.length,maxLength:await input.getAttribute('maxlength')});
 assert.equal(value,text,'Ordinary long paste must remain intact, even when too large to send');await page.locator('#toast').waitFor({state:'visible'});assert.equal((await snapshot()).sessions[0].liveDraft,'');check('An ordinary 22400-character paste stays intact locally; existing server storage rejection remains visible');
}

async function retryCase(){
 await until(()=>fs.existsSync(path.join(profile,'connection.json')),'Owned fixture ready');await launch();const id=await create('Native reconnect'),nativeBefore=(await snapshot()).sessions.find(s=>s.id===id).nativeId;
 await page.evaluate(id=>workspace.join(id,true),id);await page.locator('#room-nav').click();
 await app.evaluate(({app},id)=>{const load=process.getBuiltinModule('module').createRequire(app.getAppPath()+'/package.json'),{ServiceClient}=load('./app/service-client.cjs'),call=ServiceClient.prototype.call;let failed=false;
 ServiceClient.prototype.call=function(method,...args){if(method==='terminalSnapshot'&&args[0]===id&&!failed){failed=true;return Promise.reject(new Error('Synthetic snapshot failure'));}return call.call(this,method,...args);};},id);
 await fixture('connection',id,'idle');await delay(120);
 const pane=page.locator(`.collaboration-member-reader[data-member-id="${id}"]`);await pane.locator('.session-native-button').click();await pane.locator('.terminal-loading').waitFor();
 await until(async()=>await pane.locator('.terminal-loading').innerText()==='终端未连接，重新选择此会话或视图可重试。','First snapshot failed');
 await pane.locator('.session-send-button').click();await pane.locator('.session-native-button').waitFor({state:'visible'});await pane.locator('.session-native-button').click();await delay(150);
 const status=await pane.locator('.terminal-loading').count();measurements.push({loadingAfterExplicitRetry:status,stats:await fixture('stats')});assert.equal(status,0,'Explicit native retry should replace failed local display in the same column');assert.equal((await snapshot()).sessions.find(s=>s.id===id).nativeId,nativeBefore);assert.equal(await pane.locator('[data-terminal-id]').count(),1);check('Explicit retry replaces a failed local terminal display once and retains the original native id');
}

({ full:run, fallback:fallbackCase, long:longCase, retry:retryCase }[columnCase])().catch(async e=>{failure=e.stack;process.exitCode=1;console.error(e.stack);if(page){ console.error(JSON.stringify(await page.evaluate(()=>({toast:document.querySelector('#toast').innerText,fields:[...document.querySelectorAll('.session-message-input')].filter(e=>e.checkVisibility()).map(e=>({id:e.dataset.composerSession,readonly:e.readOnly})),terminals:[...document.querySelectorAll('[data-terminal-id]')].map(e=>({id:e.dataset.terminalId,loading:e.querySelector('.terminal-loading')?.textContent,visible:e.checkVisibility()}))}))));console.error(JSON.stringify({sessions:(await snapshot()).sessions.map(s=>({id:s.id,nativeId:s.nativeId,owner:s.owner,view:s.view,controlRevision:s.controlRevision,connectionRevision:s.connectionRevision,terminalState:s.terminalState})),stats:await fixture('stats')}));await capture('failure'); }}).finally(async()=>{
 try{
  const sourceAfter=sourceHashes();if(JSON.stringify(sourceAfter)!==JSON.stringify(sourceBefore)){failure ||= 'Source changed during the actual GUI journey';process.exitCode=1;}
  if(evidence)fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify({columnCase,flowPassed:!failure,failure,checks,errors,measurements,sourceBefore,sourceAfter,profile,token},null,2));
  await scratch.release();const owner=JSON.parse(fs.readFileSync(path.join(slot,'owner.json')));assert.equal(owner.token,token);fs.unlinkSync(path.join(slot,'owner.json'));fs.rmdirSync(slot);
  if(evidence)fs.writeFileSync(path.join(evidence,'released.json'),JSON.stringify({profile,token,profileExists:fs.existsSync(profile),time:new Date().toISOString()},null,2));
  console.log('Owned fixture cleaned; exact GUI slot released.');
 }catch(e){console.error('Cleanup unconfirmed; owned lock retained:',e.stack);process.exitCode=1;}
});
