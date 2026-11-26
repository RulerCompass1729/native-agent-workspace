// Hidden source application and synthetic transport only; no provider calls.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto'), { execFileSync } = require('node:child_process'), { createRequire } = require('node:module');
const code = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '..'), req = createRequire(path.join(code, 'package.json'));
const scratch = req('./scripts/fixtures/test-scratch.cjs'), { _electron } = scratch.playwright(req('playwright'));
const { createSourceEntry } = req('./scripts/fixtures/synthetic-source-boot.cjs'), { connect } = req('./app/service-client.cjs'), { RoomState } = req('./app/room-state.cjs');
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' }).trim();
const slot = process.env.NAW_GUI_TEST_SLOT || path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID();
try { fs.mkdirSync(slot); } catch (e) { if (e.code !== 'EEXIST') throw e; console.error('GUI slot occupied; no launch.'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ token, task: 'task board synthetic GUI', pid: process.pid }));
let profile, app, child, client, page, sequence = 0; const checks = [], errors = [], observations = [];
const check = (yes, name) => { console.log(yes ? 'PASS' : 'FAIL', name); assert.ok(yes, name); checks.push(name); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, name) { const end = Date.now() + 15000; while (Date.now() < end) { if (await fn()) return; await wait(50); } throw Error(name); }
const settled = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
const env = more => ({ PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: path.join(profile, 'home'), LANG: 'en_US.UTF-8', ...more });
function fixture(method, target, value) { const id = ++sequence; return new Promise((resolve, reject) => {
  const timer = setTimeout(() => { child.off('message', receive); reject(Error('Fixture timeout')); }, 8000);
  const receive = row => { if (row.requestId !== id) return; clearTimeout(timer); child.off('message', receive); row.error ? reject(Error(row.error)) : resolve(row); }; child.on('message', receive); child.send({ id, method, target, value });
}); }
const clean = scratch.cleanup(async () => {
  if (app) { await app.close(); app = null; }
  if (client) { for (const s of (await client.call('initial')).sessions) await client.call('stop', s.id); await client.call('shutdown'); client.close(); client = null; }
  if (child) { if (child.connected) child.disconnect(); await until(() => child.exitCode !== null || child.signalCode !== null, 'Owned fixture exit'); }
});
(async () => { try {
  profile = scratch.directory(path.join(os.tmpdir(), 'naw-b-task-board-')); fs.mkdirSync(path.join(profile, 'home')); const work = path.join(profile, 'work'); fs.mkdirSync(work);
  const hook = path.join(profile, 'synthetic.cjs'); fs.writeFileSync(hook, `require(${JSON.stringify(path.join(code, 'scripts/fixtures/collaboration-overview.cjs'))});\n`);
  child = scratch.childProcess.fork(path.join(code, 'app/daemon.cjs'), [profile], { cwd: work, execArgv: ['--require', hook], env: env({ NAW_TEST_APP_ROOT: code, NAW_WORKSPACE: work, NAW_APP_VERSION: req('./package.json').version }), stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Synthetic service boot'); client = await connect(profile, 'task-board-gui');
  const ids = []; for (const [name, provider] of [['Synthetic A', 'codex'], ['Synthetic B', 'claude'], ['Independent A', 'codex'], ['Independent B', 'claude'], ['Independent question', 'codex']]) ids.push(await client.call('create', { name, provider, cwd: work, view: 'chat' }));
  await fixture('nativeBlock', ids[0], { id: 'private-conversation-fixture', kind: 'response', turnId: 'fixture-turn', status: 'complete', text: 'SYNTHETIC_CONVERSATION_NOT_A_QUEUE_ITEM' });
  for(const id of ids.slice(0,2)) await client.call('join',id,true);
  for(const id of ids.slice(0,4)) await fixture('state',id,'working');
  const state = new RoomState(profile), old = Date.now() - 8 * 86400000, sent = [];
  const item = (status, n, extra = {}) => ({ id: randomUUID(), status, text: 'Synthetic queue task ' + n, assignee: ids[n % 2], createdAt: old, ...extra });
  const queue = Array.from({ length: 193 }, (_, i) => item(i < 186 ? 'done' : 'cancelled', i, { finishedAt: Date.now() }));
  for (let i = 0; i < 6; i++) { const q = item('sent', i, { sentTo: ids[i % 2], sentAt: old, tag: 'synthetic-tag-' + i }); sent.push(q.id); queue.push(q); }
  queue.push(item('queued', 4, { assignee: null })); state.update({ name: '示例开发', queue }, undefined, 'shared');
  const empty = state.create('界面设计'), history = state.create('资料整理'), finished = state.create('文档核对');
  state.update({ queue: [item('done', 1, { finishedAt: old })] }, undefined, history);
  state.update({ queue: [item('done', 2, { finishedAt: old }), item('cancelled', 3, { finishedAt: old })] }, undefined, finished);
  const entry = createSourceEntry({ profile, code, fixturePid: child.pid }), file = path.join(entry, 'entry.cjs');
  const prefix = `globalThis.taskStatusTest={cards:[],now:Date.now()};const bg=require(${JSON.stringify(path.join(code,'app/background-control.cjs'))}),bc=bg.BackgroundControl;bg.BackgroundControl=class extends bc{constructor(...a){super(...a);globalThis.taskStatusTest.background=this;}confirmations(...a){return super.confirmations(...a).concat(globalThis.taskStatusTest.cards);}rows(id,...a){return super.rows(id,...a).concat(globalThis.taskStatusTest.cards.filter(c=>c.sessionId===id).map(c=>c.message));}};const rs=require(${JSON.stringify(path.join(code,'app/room-state.cjs'))}),originalRoomState=rs.RoomState;rs.RoomState=class extends originalRoomState{constructor(...args){super(...args);globalThis.taskBoardFixture=this;}};const e=require('electron');e.Notification.isSupported=()=>false;require(${JSON.stringify(path.join(code, 'app/preflight.cjs'))}).preflight=()=>({claude:true,codex:true,python:true,paths:{},configured:{}});for(const k of ['show','showInactive','focus'])e.BrowserWindow.prototype[k]=function(){};for(const k of ['showOpenDialog','showSaveDialog','showMessageBox','showOpenDialogSync','showSaveDialogSync','showMessageBoxSync'])e.dialog[k]=()=>{throw Error('OS dialog forbidden')};e.shell.openExternal=e.shell.openPath=async()=>{throw Error('External open forbidden')};`;
  fs.writeFileSync(file, prefix + '\n' + fs.readFileSync(file, 'utf8'));
  app = await _electron.launch({ executablePath: req('electron'), args: [entry], env: env({ NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid), NAW_TEST_VISIBLE: '0', NAW_TEST_UI_LANGUAGE: process.env.NAW_TEST_UI_LANGUAGE || 'zh' }), timeout: 60000 });
  page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', e => {errors.push(e.message);console.error('Synthetic renderer error:',e.stack);}); await page.locator('#header').waitFor(); await settled();

  const language = process.env.NAW_TEST_UI_LANGUAGE || 'zh', en=language==='en', base=await app.evaluate(()=>globalThis.taskStatusTest.now);
  const pictures = process.env.NAW_SCREENSHOTS_DIR; if(pictures){assert.ok(!path.resolve(pictures).startsWith(fs.realpathSync(code)+path.sep));fs.mkdirSync(pictures,{recursive:true});}
  check(await page.locator('#header #task-board').count()===1,'Global task status is inside the existing header');
  await req('./scripts/fixtures/default-space.cjs').revealDefaultSpace(page);await page.locator('#room-nav').click();
  await page.evaluate(now=>{window.taskStatusClock=now;Date.now=()=>window.taskStatusClock;},base);
  const normalQueue=queue.map(q=>({...q})),actor=(await client.call('initial')).sessions.find(s=>s.id===ids[0]);assert.ok(actor.nativeId);
  const syntheticCard=now=>({id:'synthetic-confirmation',key:actor.id+':'+actor.nativeId+':input',sessionId:actor.id,nativeId:actor.nativeId,operationId:'input',state:'confirmation-required',actionable:true,expiresAt:now+100000,message:{id:'synthetic-confirmation',role:'system',kind:'background-operation',name:'Synthetic actor',time:now,text:'Synthetic confirmation metadata',status:'error',backgroundOperation:{id:'input',sessionId:actor.id,nativeId:actor.nativeId,state:'confirmation-required',expiresAt:now+100000,confirmation:{kind:'message',options:{message:'Synthetic confirmation',buttons:['Cancel','Confirm'],cancelId:0}}}}});
  async function scene(kind){
    await app.evaluate((_,data)=>{const t=globalThis.taskStatusTest;t.background.failed= data.kind==='unknown';t.cards=data.kind==='waiting'?[data.card]:[];globalThis.taskBoardFixture.update({queue:data.queue},undefined,'shared');},{kind,card:syntheticCard(base),queue:kind==='waiting'?normalQueue.concat(item('waiting',200,{sentTo:actor.id,sentNative:actor.nativeId}),item('waiting',201,{sentTo:actor.id,sentNative:actor.nativeId})):normalQueue});
    await page.evaluate(now=>window.taskStatusClock=now,base);
    await fixture('state',ids[2],kind==='unknown'?'disconnected':'working');
    await fixture('state',ids[4],kind==='waiting'?'approval':'idle');
    await client.call('draft',ids[0],'Synthetic metadata-only push'); await settled();
    await until(async()=>{const b=await bar();return kind==='waiting'?b.due.includes('1:40'):kind==='unknown'?(await page.locator(`#agent-distribution .agent-cell[data-session-id="${ids[2]}"]`).getAttribute('data-agent-status'))==='stuck':!b.due&&!b.need;},'Scene projection '+kind);
  }
  // R250–R251 (11-25): one button «任务板 · N 件等你 · 卡 m:ss»; the board lists tasks only, grouped by status.
  const t=(key,params)=>req('./app/ui-locale.js').format(language,key,params);
  const bar=()=>page.evaluate(()=>{const b=document.querySelector('.task-board-toggle'),need=b.querySelector('.task-status-need'),due=b.querySelector('.task-status-due');
    return{need:need.hidden?'':need.textContent,due:due.hidden?'':due.textContent,label:b.getAttribute('aria-label'),text:b.textContent};});
  const boardView=()=>page.evaluate(()=>{const panel=document.getElementById('task-board-panel'),note=panel.querySelector('.task-board-availability');
    const groups=[...panel.querySelectorAll('.task-board-group')].map(g=>({key:g.dataset.groupKey,count:Number(g.querySelector('.task-board-group-count').textContent),open:g.querySelector('.task-board-fold').getAttribute('aria-expanded')==='true',
      rows:[...g.querySelectorAll('.task-board-task')].map(r=>{const e=r.querySelector('.task-board-entry'),sub=r.querySelector('.task-board-sub');return{id:e.dataset.itemId,kind:e.dataset.kind,source:e.dataset.source,sub:sub.hidden?'':sub.textContent};})}));
    return{groups,availability:note.hidden?'':note.textContent,text:panel.innerText};});
  const group=(v,key)=>v.groups.find(g=>g.key===key)||{count:0,open:false,rows:[]};
  const openBoard=async()=>{if(!await page.locator('#task-board-panel').isVisible())await page.locator('.task-board-toggle').click();await settled();};
  const showAll=async key=>{const more=page.locator(`#task-board-panel .task-board-group[data-group-key="${key}"] .task-board-more`);while(await more.count())await more.click();await settled();};
  const task=id=>page.locator(`#task-board-panel .task-board-task:has(.task-board-entry[data-item-id="${id}"])`);
  const expand=async id=>{await task(id).locator('.task-board-entry').click();await settled();return task(id);};
  const identities=()=>page.evaluate(async()=>{const x=await workspace.initial();return x.sessions.map(s=>({id:s.id,nativeId:s.nativeId,rooms:nativeWorkspaceSpaces.roomIds(s)}));});
  const selected=id=>until(async()=>(await page.evaluate(()=>workspace.initial())).viewState.selected===id,'Session selected '+id);
  const returnToSpace=async()=>{if(!await page.locator('#room-nav').isVisible())await page.locator('#sidebar-toggle').click();await req('./scripts/fixtures/default-space.cjs').revealDefaultSpace(page);await page.locator('#room-nav').click();await settled();};
  async function mixedScene(){
    const decision=item('waiting',300,{assignee:null,sentTo:ids[0],sentNative:actor.nativeId}),
      purpose=Array.from({length:7},(_,i)=>item('waiting',301+i,{reason:'input-purpose-unconfirmed',assignee:null,...(i===0?{sentTo:ids[0],sentNative:actor.nativeId}:{})})),
      silence=item('waiting',308,{reason:'no-reply',assignee:null,sentTo:ids[0],sentNative:actor.nativeId}),
      queue=normalQueue.concat(decision,...purpose,silence),
      unverified=Array.from({length:6},()=>({state:'confirmation-required',actionable:true,expiresAt:null})).concat({id:'synthetic-unverifiable',key:actor.id+':'+actor.nativeId+':verification',sessionId:actor.id,nativeId:actor.nativeId,operationId:'verification',state:'unverifiable',actionable:false,expiresAt:base+200000,
        message:{id:'synthetic-unverifiable',role:'system',kind:'background-operation',name:'Synthetic actor',time:base,text:'Synthetic unverifiable confirmation metadata',status:'error',backgroundOperation:{id:'verification',sessionId:actor.id,nativeId:actor.nativeId,state:'unverifiable'}}});
    await app.evaluate((_,d)=>{const t=globalThis.taskStatusTest;t.background.failed=false;t.cards=[d.card,...d.unverified];globalThis.taskBoardFixture.update({queue:d.queue},undefined,'shared');},{queue,card:syntheticCard(base),unverified});
    await page.evaluate(now=>window.taskStatusClock=now,base);
    await fixture('state',ids[2],'working');await fixture('state',ids[4],'approval');
    await client.call('draft',ids[0],'Synthetic mixed push');await settled();
    await until(async()=>{const b=await bar();return b.need===t('taskBoard.need',{count:11})&&b.due.includes('1:40');},'Mixed projection');
    return {decision,purpose,silence,unverifiedKey:actor.id+':'+actor.nativeId+':verification'};
  }
  const mixed=await mixedScene();
  for(const [width,height]of[[1240,820],[850,600]])for(const theme of['light','dark']){
    await app.evaluate(({BrowserWindow,nativeTheme},v)=>{BrowserWindow.getAllWindows()[0].setContentSize(v.width,v.height);nativeTheme.themeSource=v.theme;},{width,height,theme});await page.emulateMedia({colorScheme:theme});await page.waitForFunction(w=>innerWidth===w,width);await settled();
    await until(async()=>(await bar()).need===t('taskBoard.need',{count:11}),'Mixed resize projection');
    const b=await bar();
    check(b.label===[t('taskBoard.boardButton'),t('taskBoard.need',{count:11}),t('taskBoard.cardDueLabel',{time:'1:40'})].join(t('taskBoard.labelSeparator')),`mixed ${width} ${theme}: the button counts the decision, reviews, approval and card once, with only the actionable card's deadline (${b.label})`);
    if(pictures)await page.screenshot({scale:'css',path:path.join(pictures,`${language}-mixed-${theme}-${width}.png`)});
    await openBoard();await showAll('waiting');
    const v=await boardView(),w=group(v,'waiting'),kinds={};for(const r of w.rows)kinds[r.kind]=(kinds[r.kind]||0)+1;
    check(v.groups[0].key==='waiting'&&w.open&&w.count===11&&kinds.review===8&&kinds.waiting===1&&kinds.approval===1&&kinds['background-confirmation']===1,`mixed ${width} ${theme}: 等你 comes first with the decision, eight reviews, the approval and the card (${JSON.stringify(kinds)})`);
    check(w.rows.filter(r=>r.kind==='review').every(r=>r.sub===t('taskBoard.status.review')),`mixed ${width} ${theme}: review rows say 待查看 and never claim a decision`);
    const card=group(v,'problem').rows.find(r=>r.source==='confirmation');
    check(card&&card.id===mixed.unverifiedKey&&card.sub===t('taskBoard.cardsUnverified')&&!/\d+:\d{2}/.test(card.sub),`mixed ${width} ${theme}: the unverifiable card is under 异常 for checking, without a countdown`);
    if(pictures)await page.screenshot({scale:'css',path:path.join(pictures,`${language}-mixed-${theme}-${width}-open.png`)});
    await page.keyboard.press('Escape');await settled();
  }
  await openBoard();await showAll('waiting');
  const purposeRow=await expand(mixed.purpose[0].id),purposeText=await purposeRow.innerText();
  check(purposeText.includes('Synthetic A')&&purposeText.includes(t('taskBoard.reasonInputPurposeUnconfirmed')),'A dispatched input-purpose review opens in place with its owner and reason');
  const silenceRow=await expand(mixed.silence.id);check((await silenceRow.innerText()).includes(t('taskBoard.reasonNoReply')),'A dispatched no-reply review keeps its reason');
  await silenceRow.locator('.task-board-action[data-action="checkIn"]').click();await page.locator('#task-board-panel').waitFor({state:'hidden'});await selected(ids[0]);
  check(await page.locator('#queue-dialog').isHidden(),'A dispatched review opens its session, not the space queue');
  if(pictures)await page.screenshot({scale:'css',path:path.join(pictures,`${language}-mixed-review-session.png`)});
  await returnToSpace();await openBoard();await showAll('waiting');
  const unassignedRow=await expand(mixed.purpose[1].id),unassignedText=await unassignedRow.innerText();
  check(unassignedText.includes(t('taskBoard.unassigned'))&&unassignedText.includes(t('taskBoard.reasonInputPurposeUnconfirmed')),'An unassigned input-purpose review is listed with its reason and 未分配');
  await unassignedRow.locator('.task-board-action[data-action="openQueueOf"]').click();await page.locator('#queue-dialog').waitFor({state:'visible'});
  const dialog=await page.locator('#queue-dialog').innerText();
  check(dialog.includes(en?'Could not confirm this input belongs to this task':'没确认这段输入属于本项')&&dialog.includes(en?'For you to look at':'留给你看一眼')&&dialog.includes(en?'Unassigned':'未分配'),'Its queue opens with the same reason, review state and owner');
  await page.locator('#close-queue').click();await page.locator('#queue-dialog').waitFor({state:'hidden'});
  await scene('normal');
  for(const kind of ['normal','waiting','unknown']){
    await scene(kind);
    for(const [width,height]of[[1240,820],[850,600]])for(const theme of['light','dark']){
      await app.evaluate(({BrowserWindow,nativeTheme},v)=>{BrowserWindow.getAllWindows()[0].setContentSize(v.width,v.height);nativeTheme.themeSource=v.theme;},{width,height,theme});await page.emulateMedia({colorScheme:theme});await page.waitForFunction(w=>innerWidth===w,width);await settled();
      const g=await page.evaluate(()=>{const h=document.getElementById('header').getBoundingClientRect(),b=document.querySelector('.task-status-button');const items=['#agent-distribution','.task-status-button','#steward-wake-chip'].map(s=>document.querySelector('#header '+s)).filter(e=>e&&!e.hidden&&e.getClientRects().length).map(e=>{const r=e.getBoundingClientRect();return{id:e.id||e.className,x:r.x,right:r.right,top:r.top,bottom:r.bottom,width:e.clientWidth,scroll:e.scrollWidth};});return{text:b.textContent,items,header:{top:h.top,bottom:h.bottom},overflow:document.documentElement.scrollWidth-innerWidth,dark:document.body.hasAttribute('data-ds-dark-theme'),name:b.getAttribute('aria-label'),cells:[...document.querySelectorAll('#agent-distribution .agent-cell')].map(c=>({id:c.dataset.sessionId,cls:c.className.replace(/^agent-cell /,''),label:c.getAttribute('aria-label'),w:c.getBoundingClientRect().width,h:c.getBoundingClientRect().height})),groups:[...document.querySelectorAll('#agent-distribution .agent-group')].map(x=>({key:x.dataset.group,label:x.querySelector('.agent-group-label').textContent,count:Number(x.querySelector('.agent-group-count').textContent)})),dots:Object.fromEntries([...document.querySelectorAll('.session-link[data-session-id]')].map(l=>[l.dataset.sessionId,l.querySelector('.state-dot')?.className]))};});observations.push({kind,width,height,theme,g});
      // Every session keeps its square; a disconnected one reads 卡住 (agent-distribution.js since 60e5f40c, 11-24).
      check(g.cells.length===5&&(kind!=='unknown'||g.cells.find(c=>c.id===ids[2])?.cls.includes('disconnected')),`${kind} ${width} ${theme}: one square per agent; a disconnected independent session keeps its square as stuck`);
      check(g.groups.reduce((n,x)=>n+x.count,0)===g.cells.length&&g.groups.every(x=>x.label&&!ids.some(id=>x.label.includes(id))),`${kind} ${width} ${theme}: group counts add up to the squares and every group has a readable name`);
      check(g.cells.every(c=>c.w>=8&&c.h>=8&&c.label.split(' · ').length===3&&!ids.some(id=>c.label.includes(id))),`${kind} ${width} ${theme}: each square names its agent, state and model without an id ${JSON.stringify(g.cells.filter(c=>!(c.w>=8&&c.h>=8&&c.label.split(' · ').length===3)).map(c=>[c.label,c.w,c.h]))}`);
      // In a space the sidebar lists only its members (11-23), so only they have a corner dot to match.
      const listed=g.cells.filter(c=>c.id in g.dots);check(listed.length>0&&listed.every(c=>c.cls===g.dots[c.id]),`${kind} ${width} ${theme}: each square of an agent the sidebar lists uses the same look as its corner dot`);
      const title=await page.evaluate(()=>{const named=document.querySelector('#switch-space.space-switch-named:not([hidden]) .space-switch-name'),e=named||document.querySelector('#title');return{width:e.getBoundingClientRect().width,natural:e.scrollWidth,same:!named||named.textContent===document.querySelector('#title').textContent};});if(!(title.width+1>=Math.min(title.natural,64)&&title.width>0)){console.log('Title geometry',JSON.stringify(title));if(pictures)await page.screenshot({path:path.join(pictures,'title-layout-failure.png'),scale:'css'});}check(title.width+1>=Math.min(title.natural,64)&&title.width>0&&title.same,`${kind} ${width} ${theme}: the current space name remains visible`);
      const fits=g.items.length>=2&&g.items.every(r=>r.x>=0&&r.right<=width+1&&r.scroll<=r.width+1);if(!fits){console.log('Header geometry',JSON.stringify(g.items));if(pictures)await page.screenshot({path:path.join(pictures,`${language}-${kind}-${theme}-${width}-clipped.png`),scale:'css'});}check(fits,`${kind} ${width} ${theme}: every header item fits without clipping`);
      check(g.items.every(r=>r.top>=g.header.top&&r.bottom<=g.header.bottom),`${kind} ${width} ${theme}: existing header row owns the status`);
      check(g.dark===(theme==='dark')&&g.overflow<=0,`${kind} ${width} ${theme}: correct theme, no document overflow`);
      check(!/(^|\s)0 /u.test(g.text)&&!g.text.includes(t('taskBoard.group.sent'))&&!g.text.includes(t('taskBoard.group.problem')),`${kind} ${width} ${theme}: the button carries no progress, problem or healthy-zero count (B)`);
      if(kind==='waiting'){
        const b=await bar();
        check(b.need===t('taskBoard.need',{count:4})&&b.due===t('taskBoard.cardDue',{time:'1:40'}),`${width} ${theme}: the button counts two decisions, the approval and the card, with the card's deadline (${b.need} ${b.due})`);
        const contrast=await page.locator('.task-status-need').evaluate(e=>{const parse=s=>{const v=s.match(/[\d.]+/g).map(Number),k=s.startsWith('color(')?255:1;return{c:v.slice(0,3).map(x=>x*k),a:v.length>3?v[3]:1};};const lum=c=>c.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((a,v,i)=>a+v*[.2126,.7152,.0722][i],0);const layers=[];for(let p=e;p;p=p.parentElement){const b=parse(getComputedStyle(p).backgroundColor);if(b.a>0)layers.push(b);if(b.a>=1)break;}let bg=[255,255,255];for(const l of layers.reverse())bg=bg.map((v,i)=>l.c[i]*l.a+v*(1-l.a));const a=lum(parse(getComputedStyle(e).color).c),z=lum(bg);return(Math.max(a,z)+.05)/(Math.min(a,z)+.05);});check(contrast>=4.5,`${width} ${theme}: needs-you contrast is at least 4.5 (${contrast.toFixed(2)})`);
      }
      if(pictures)await page.screenshot({scale:'css',path:path.join(pictures,`${language}-${kind}-${theme}-${width}.png`)});
      if(kind==='unknown'){await openBoard();check((await boardView()).availability.includes(t('taskBoard.cardsUnavailable')),`${width} ${theme}: an unreadable card source is said on the board, not counted on the button`);await page.keyboard.press('Escape');await settled();}
      if(kind==='waiting'){
        await page.locator('.task-board-toggle').click();await settled();const p=await page.locator('#task-board-panel').evaluate(e=>{const r=e.getBoundingClientRect(),t=document.querySelector('.task-board-toggle').getBoundingClientRect();return{nonmodal:!document.querySelector('dialog:modal'),top:r.top,bottom:r.bottom,right:r.right,left:r.left,anchor:t.bottom};});
        check(p.nonmodal&&p.top>=p.anchor&&p.top-p.anchor<20&&p.bottom<=height&&p.left>=0&&p.right<=width,`${width} ${theme}: anchored nonmodal board stays in the viewport`);
        const v=await boardView(),counts=Object.fromEntries(v.groups.map(x=>[x.key,[x.count,x.open]]));
        check(JSON.stringify(counts)===JSON.stringify({waiting:[4,true],sent:[6,true],queued:[1,true],done:[188,false],cancelled:[8,false]}),`${width} ${theme}: six dispatched tasks are 在做, conversations are not tasks, every space's finished work stays folded (${JSON.stringify(counts)})`);
        if(pictures)await page.screenshot({scale:'css',path:path.join(pictures,`${language}-${kind}-${theme}-${width}-open.png`)});
        const entries=page.locator('#task-board-panel .task-board-entry');await entries.last().focus();check(await entries.last().evaluate(e=>{const r=e.getBoundingClientRect(),p=e.closest('.task-board-list').getBoundingClientRect();return r.top>=p.top&&r.bottom<=p.bottom+1;}),`${width} ${theme}: the last row can be reached with keyboard focus`);
        await page.locator('.task-board-toggle').click();check(await page.locator('#task-board-panel').isHidden(),`${width} ${theme}: a second click collapses the board`);
        await page.locator('.task-board-toggle').press('Enter');await entries.first().focus();await page.keyboard.press('Escape');check(await page.locator('.task-board-toggle').evaluate(e=>document.activeElement===e),`${width} ${theme}: Escape returns focus to the button`);
      }
    }
  }
  await page.locator('.task-board-toggle').click();const outsideDraft=await page.locator('#shared-input').inputValue();await page.locator('#header').click({position:{x:10,y:5}});check(await page.locator('#task-board-panel').isHidden(),'The exposed page header light-dismisses the global board');await page.locator('#shared-input').click({position:{x:10,y:10}});await page.locator('#shared-input').fill('Synthetic nonmodal input');check(await page.locator('#task-board-panel').isHidden()&&await page.locator('#shared-input').evaluate(e=>document.activeElement===e&&e.value==='Synthetic nonmodal input'),'Clicking the original composer dismisses the popover without taking input focus');await page.locator('#shared-input').fill(outsideDraft);
  await scene('normal');
  await app.evaluate((_,q)=>globalThis.taskBoardFixture.update({queue:q},undefined,'shared'),Array.from({length:24},(_,i)=>item('queued',i,{assignee:null})));await client.call('draft',ids[0],'Synthetic block overflow');
  for(const width of [1240,850]){await app.evaluate(({BrowserWindow},w)=>BrowserWindow.getAllWindows()[0].setContentSize(w,600),width);await page.waitForFunction(w=>innerWidth===w,width);await settled();check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),width+': many queued rows do not widen the header');await openBoard();await until(async()=>group(await boardView(),'queued').count===24,'Queued update').catch(()=>{});const q=group(await boardView(),'queued');check(q.count===24&&q.rows.length===8&&await page.locator('#task-board-panel .task-board-group[data-group-key="queued"] .task-board-more').count()===1,width+': the board keeps the exact queued count and shows eight, then 再显示');await page.keyboard.press('Escape');}
  await scene('normal');
  await app.evaluate(()=>globalThis.taskBoardFixture.update({queue:[]},undefined,'shared'));await client.call('draft',ids[0],'Synthetic native-only work');
  await until(async()=>(await page.locator('#agent-distribution [data-group="status:working"] .agent-group-count').textContent())==='4','Space members without queued tasks still count');
  check(true,'Native space work without queue items remains visible beside independent work');
  await fixture('state',ids[0],'approval');await until(async()=>(await page.locator(`#agent-distribution .agent-cell[data-session-id="${ids[0]}"]`).getAttribute('data-agent-status'))==='waiting','Native member needs a person');
  await until(async()=>(await bar()).need===t('taskBoard.needOne',{count:1}),'Native approval counted').catch(()=>{});check((await bar()).need===t('taskBoard.needOne',{count:1}),'A native member approval with no queue is one item waiting on the button');
  await fixture('state',ids[0],'disconnected');await until(async()=>(await page.locator(`#agent-distribution .agent-cell[data-session-id="${ids[0]}"]`).getAttribute('data-agent-status'))==='stuck','Disconnected member is shown as stuck or offline');
  check(!/(^|\s)0 /u.test((await bar()).text)&&(await page.locator(`#agent-distribution .agent-cell[data-session-id="${ids[0]}"]`).getAttribute('class')).includes('disconnected'),'A disconnected space member without a queue is never healthy zero and keeps its square');
  await fixture('state',ids[0],'working');
  await app.evaluate((_,queue)=>globalThis.taskBoardFixture.update({queue},undefined,'shared'),[item('queued',0)]);await client.call('draft',ids[0],'Synthetic queued-only assignment');
  await until(async()=>(await page.locator('#agent-distribution [data-group="status:working"] .agent-group-count').textContent())==='4','Queued assignment retains native work');
  check(true,'A queued assignee does not hide unrelated native work');
  await scene('waiting');
  await app.evaluate((_,q)=>globalThis.taskBoardFixture.update({queue:q},undefined,'shared'),normalQueue.concat(item('waiting',200,{reason:'no-reply',sentTo:actor.id,sentNative:actor.nativeId}),item('waiting',201,{sentTo:actor.id,sentNative:actor.nativeId})));await client.call('draft',ids[0],'Synthetic shared classification');
  await openBoard();await until(async()=>group(await boardView(),'waiting').rows.some(r=>r.kind==='review'),'Review arrives on the open board').catch(()=>{});
  check((await bar()).need===t('taskBoard.need',{count:4}),'The button counts the review with the decision, approval and card');
  const reviewRows=group(await boardView(),'waiting').rows.filter(r=>r.kind==='review');check(reviewRows.length===1&&reviewRows[0].sub===t('taskBoard.status.review'),'The review waits on the board as 待查看, never as a decision');await page.keyboard.press('Escape');await scene('waiting');
  const trigger=page.locator('.task-board-toggle'),originalIdentities=await identities();
  await openBoard();await task('approval:'+ids[4]).locator('.task-board-agent').click();await selected(ids[4]);check(JSON.stringify(await identities())===JSON.stringify(originalIdentities),'The agent chip routes to the real session and preserves native IDs and every membership');await returnToSpace();
  await openBoard();const cardRow=await expand(actor.id+':'+actor.nativeId+':input');await cardRow.locator('.task-board-action[data-action="fullCard"]').click();await selected(ids[0]);check(await page.locator('#messages [data-message-id="synthetic-confirmation"]').isVisible(),'The card opens the existing original card in its session without deciding');await returnToSpace();
  const queuedId=normalQueue.find(q=>q.status==='queued').id;
  await openBoard();const queuedRow=await expand(queuedId);await queuedRow.locator('.task-board-action[data-action="openQueueOf"]').click();await page.locator('#queue-dialog').waitFor({state:'visible'});check(await page.locator('#queue-dialog').isVisible(),'An unassigned row opens its original space queue');await page.locator('#close-queue').click();
  await trigger.focus();await trigger.press('Enter');check(await page.locator('#task-board-panel').isVisible(),'Enter opens the board');
  check(!(await page.locator('#task-board-panel').innerText()).includes('SYNTHETIC_CONVERSATION_NOT_A_QUEUE_ITEM'),'No native conversation body enters the task board');
  await page.locator('.task-board-search').fill('SYNTHETIC_CONVERSATION_NOT_A_QUEUE_ITEM');await settled();check(await page.locator('#task-board-panel .task-board-task').count()===0&&(await page.locator('.task-board-empty').innerText())===t('taskBoard.noMatches'),'Search cannot find native conversation bodies and says so');await page.locator('.task-board-search').fill('');await settled();
  const done=page.locator('#task-board-panel .task-board-group[data-group-key="done"]'),doneRows=()=>done.locator('.task-board-task').count(),more=done.locator('.task-board-more');
  await done.locator('.task-board-fold').click();check(await doneRows()===8,'The folded finished group opens to eight rows');await more.click();check(await doneRows()===16,'再显示 reaches sixteen rows');await more.click();check(await doneRows()===24,'and twenty-four');
  await more.focus();const before=await page.locator('.task-board-list').evaluate(list=>{window.boardMore=document.querySelector('.task-board-group[data-group-key="done"] .task-board-more');window.boardRows=[...list.querySelectorAll('.task-board-task')];return{top:list.scrollTop,keys:boardRows.map(e=>e.dataset.taskKey)};});
  await page.evaluate(id=>workspace.spaceAction('shared','queueResolve',[id]),sent[0]);await until(async()=>(await task(sent[0]).locator('.task-board-sub').innerText())===t('taskBoard.group.done'),'Resolved row renamed in place').catch(()=>{});
  const after=await page.locator('.task-board-list').evaluate(list=>({focused:document.activeElement===boardMore,sameMore:boardMore===document.querySelector('.task-board-group[data-group-key="done"] .task-board-more'),sameRows:boardRows.every((e,i)=>e===list.querySelectorAll('.task-board-task')[i]),top:list.scrollTop}));
  check(after.focused&&after.sameMore&&after.sameRows&&Math.abs(after.top-before.top)<=1,'Live push preserves row nodes, loaded count, focus and reading offset');
  check((await task(sent[0]).locator('.task-board-sub').innerText())===t('taskBoard.group.done'),'A task finished while the board is open keeps its place and names its new status (③)');
  for(const mode of ['agent','space']){await page.locator(`.task-board-mode[data-grouping="${mode}"]`).click();await settled();check(await page.locator('#task-board-panel .task-board-group').count()>0,'Grouping by '+mode+' remains reachable');}
  await page.keyboard.press('Escape');check(await trigger.evaluate(e=>document.activeElement===e),'Escape closes and returns to the same global trigger');
  await page.evaluate(now=>window.taskStatusClock=now+1000,base);await until(async()=>(await bar()).due.includes('1:39'),'Existing UI clock updates the confirmation countdown');
  await page.evaluate(now=>window.taskStatusClock=now+100000,base);await until(async()=>!(await bar()).due,'Expired confirmation leaves the button');
  check((await bar()).need===t('taskBoard.need',{count:3}),'Expiration removes the card, preserving three other waiting items');
  await app.evaluate(()=>globalThis.taskStatusTest.cards=[]);await client.call('draft',ids[0],'Synthetic post-expiry projection');await settled();
  await openBoard();await page.locator('.task-board-mode[data-grouping="space"]').click();await settled();
  const archive=page.locator(`#task-board-panel .task-board-group[data-group-key="${history}"]`);await archive.locator('.task-board-fold').click();await settled();
  check(await archive.locator('.task-board-task').count()===1,'The chosen historical queue row is unique in its space');
  const archived=await expand(await archive.locator('.task-board-entry').getAttribute('data-item-id'));await archived.locator('.task-board-action[data-action="openQueueOf"]').click();await page.locator('#queue-dialog').waitFor({state:'visible'});check((await page.locator('#queue-title').textContent()).includes('资料整理'),'The selected original space queue opens through its existing control');await page.locator('#close-queue').click();
  await page.locator('#independent-nav').click();
  const labels=await page.getByRole('menuitem').allTextContents(), independent=labels.filter(label=>label.startsWith('Independent A · '));assert.equal(independent.length,1);await page.getByRole('menuitem',{name:independent[0],exact:true}).click();
  for(const [width,height]of[[1240,820],[850,600]])for(const theme of['light','dark']){await app.evaluate(({BrowserWindow,nativeTheme},v)=>{BrowserWindow.getAllWindows()[0].setContentSize(v.width,v.height);nativeTheme.themeSource=v.theme;},{width,height,theme});await page.emulateMedia({colorScheme:theme});await page.waitForFunction(w=>innerWidth===w,width);await settled();const g=await trigger.evaluate(e=>{const r=e.getBoundingClientRect(),h=document.getElementById('header').getBoundingClientRect();const t=document.getElementById('session-toolbar').getBoundingClientRect();return{x:r.x,right:r.right,top:r.top,bottom:r.bottom,headerTop:h.top,headerBottom:h.bottom,scroll:e.scrollWidth,client:e.clientWidth,toolbarRight:t.right,toolbarTop:t.top};});check(g.x>=0&&g.right<=width+1&&g.scroll<=g.client+1&&g.top>=g.headerTop&&g.bottom<=g.headerBottom&&(Math.abs(g.top-g.toolbarTop)>28||g.x>=g.toolbarRight),`${width} ${theme}: independent conversation retains the global status at the right`);if(pictures)await page.screenshot({scale:'css',path:path.join(pictures,`${language}-independent-${theme}-${width}.png`)});}
  const hidden=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().every(w=>!w.isVisible()&&!w.isFocusable()));check(hidden,'All owned windows remain hidden and unfocusable');
  const stats=await fixture('stats',ids[0]);check(stats.stats.sends===0&&stats.stats.inputs===0,'Zero native input/model sends');if(errors.length)console.error('Renderer errors:',JSON.stringify(errors));check(errors.length===0,'No renderer errors');
  if(pictures)fs.writeFileSync(path.join(pictures,language+'-results.json'),JSON.stringify({checks,observations,before,after,stats,errors},null,2));console.log(`SUMMARY ${checks.length} pass / 0 fail / 0 skip`);
}finally{try{await clean();await scratch.release();}finally{const owner=JSON.parse(fs.readFileSync(path.join(slot,'owner.json')));if(owner.token===token){fs.unlinkSync(path.join(slot,'owner.json'));fs.rmdirSync(slot);}}}})().catch(e=>{console.error(e);process.exitCode=1;});
