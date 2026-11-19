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
  profile = scratch.directory(path.join(os.tmpdir(), 'naw-task-board-')); fs.mkdirSync(path.join(profile, 'home')); const work = path.join(profile, 'work'); fs.mkdirSync(work);
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
  const prefix = `globalThis.taskStatusTest={cards:[],now:Date.now()};const bg=require(${JSON.stringify(path.join(code,'app/background-control.cjs'))}),bc=bg.BackgroundControl;bg.BackgroundControl=class extends bc{constructor(...a){super(...a);globalThis.taskStatusTest.background=this;}confirmations(...a){return super.confirmations(...a).concat(globalThis.taskStatusTest.cards);}};const rs=require(${JSON.stringify(path.join(code,'app/room-state.cjs'))}),originalRoomState=rs.RoomState;rs.RoomState=class extends originalRoomState{constructor(...args){super(...args);globalThis.taskBoardFixture=this;}};const e=require('electron');e.Notification.isSupported=()=>false;require(${JSON.stringify(path.join(code, 'app/preflight.cjs'))}).preflight=()=>({claude:true,codex:true,python:true,paths:{},configured:{}});for(const k of ['show','showInactive','focus'])e.BrowserWindow.prototype[k]=function(){};for(const k of ['showOpenDialog','showSaveDialog','showMessageBox','showOpenDialogSync','showSaveDialogSync','showMessageBoxSync'])e.dialog[k]=()=>{throw Error('OS dialog forbidden')};e.shell.openExternal=e.shell.openPath=async()=>{throw Error('External open forbidden')};`;
  fs.writeFileSync(file, prefix + '\n' + fs.readFileSync(file, 'utf8'));
  app = await _electron.launch({ executablePath: req('electron'), args: [entry], env: env({ NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid), NAW_TEST_VISIBLE: '0', NAW_TEST_UI_LANGUAGE: process.env.NAW_TEST_UI_LANGUAGE || 'zh' }), timeout: 60000 });
  page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message)); await page.locator('#header').waitFor(); await settled();

  const language = process.env.NAW_TEST_UI_LANGUAGE || 'zh', en=language==='en', base=await app.evaluate(()=>globalThis.taskStatusTest.now);
  const pictures = process.env.NAW_SCREENSHOTS_DIR; if(pictures){assert.ok(!path.resolve(pictures).startsWith(fs.realpathSync(code)+path.sep));fs.mkdirSync(pictures,{recursive:true});}
  check(await page.locator('#header #task-board').count()===1,'Global task status is inside the existing header');
  await req('./scripts/fixtures/default-space.cjs').revealDefaultSpace(page);await page.locator('#room-nav').click();
  await page.evaluate(now=>{window.taskStatusClock=now;Date.now=()=>window.taskStatusClock;},base);
  const normalQueue=queue.map(q=>({...q}));
  async function scene(kind){
    await app.evaluate((_,data)=>{const t=globalThis.taskStatusTest;t.background.failed= data.kind==='unknown';t.cards=data.kind==='waiting'?[{id:'synthetic-confirmation',key:'synthetic-actor:native:input',sessionId:'synthetic-actor',nativeId:'native',operationId:'input',state:'confirmation-required',actionable:true,expiresAt:data.now+100000}]:[];globalThis.taskBoardFixture.update({queue:data.queue},undefined,'shared');},{kind,now:base,queue:kind==='waiting'?normalQueue.concat(item('waiting',200),item('waiting',201)):normalQueue});
    await page.evaluate(now=>window.taskStatusClock=now,base);
    await fixture('state',ids[2],kind==='unknown'?'disconnected':'working');
    await fixture('state',ids[4],kind==='waiting'?'approval':'idle');
    await client.call('draft',ids[0],'Synthetic metadata-only push'); await settled();
    await until(async()=>{const x=await page.locator('.task-status-button').innerText();return kind==='waiting'?x.includes(en?'4 need you':'4 等你'):kind==='unknown'?x.includes(en?'unverified':'未确认'):x.includes(en?'0 need you':'0 等你');},'Scene projection '+kind);
  }
  for(const kind of ['normal','waiting','unknown']){
    await scene(kind);
    for(const [width,height]of[[1240,820],[850,600]])for(const theme of['light','dark']){
      await app.evaluate(({BrowserWindow,nativeTheme},v)=>{BrowserWindow.getAllWindows()[0].setContentSize(v.width,v.height);nativeTheme.themeSource=v.theme;},{width,height,theme});await page.emulateMedia({colorScheme:theme});await settled();
      const g=await page.locator('.task-status-button').evaluate(e=>{const r=e.getBoundingClientRect(),h=document.getElementById('header').getBoundingClientRect();return {text:e.innerText,rect:{x:r.x,right:r.right,top:r.top,bottom:r.bottom},header:{top:h.top,bottom:h.bottom},width:e.clientWidth,scroll:e.scrollWidth,overflow:document.documentElement.scrollWidth-innerWidth,dark:document.body.hasAttribute('data-ds-dark-theme'),name:e.getAttribute('aria-label')};});observations.push({kind,width,height,theme,g});
      check(g.rect.x>=0&&g.rect.right<=width+1&&g.scroll<=g.width+1,`${kind} ${width} ${theme}: all numbers fit without clipping`);
      check(g.rect.top>=g.header.top&&g.rect.bottom<=g.header.bottom,`${kind} ${width} ${theme}: existing header row owns the status`);
      check(g.dark===(theme==='dark')&&g.overflow<=0,`${kind} ${width} ${theme}: correct theme, no document overflow`);
      check(kind==='unknown'?!g.text.includes(en?'0 need you':'0 等你'):g.text.includes(en?'8 working':'8 在做'),`${kind} ${width} ${theme}: six queue tasks plus two independent conversations, no healthy-zero on unknown`);
      check(g.text.includes(en?'Queue done today 186':'今天队列完成 186'),`${kind} ${width} ${theme}: completion is queue-only and excludes cancellation/history`);
      if(kind==='waiting')check(g.text.includes('1:40')&&g.text.includes(en?'1 card':'1张卡'),`${width} ${theme}: one unexpired confirmation deadline is visible`);
      if(kind==='waiting'){const contrast=await page.locator('.task-status-waiting').evaluate(e=>{const lum=s=>s.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((a,v,i)=>a+v*[.2126,.7152,.0722][i],0);const c=getComputedStyle(e);let p=e,b;while(p){b=getComputedStyle(p).backgroundColor;if(!b.endsWith(', 0)')&&b!=='rgba(0, 0, 0, 0)')break;p=p.parentElement;}const a=lum(c.color),z=lum(b);return(Math.max(a,z)+.05)/(Math.min(a,z)+.05);});check(contrast>=4.5,`${width} ${theme}: needs-you contrast is at least 4.5 (${contrast.toFixed(2)})`);}
      if(pictures)await page.screenshot({scale:'css',path:path.join(pictures,`${language}-${kind}-${theme}-${width}.png`)});
    }
  }
  await scene('waiting');
  const trigger=page.locator('.task-board-toggle');await trigger.focus();await trigger.press('Enter');check(await page.locator('#task-board-panel').isVisible(),'Enter opens the original full task board');
  check((await page.locator('#task-board-panel').innerText()).includes(en?'Independent chats':'独立对话'),'Independent conversations have a separate read-only group');
  check((await page.locator('#task-board-panel').innerText()).includes(en?'Background confirmations':'后台确认卡'),'Confirmation cards stay reachable in the same full panel');
  check(!(await page.locator('#task-board-panel').innerText()).includes('SYNTHETIC_CONVERSATION_NOT_A_QUEUE_ITEM'),'No native conversation body enters the task board');
  const emptyGroup=page.locator('.task-board-group').filter({has:page.locator('summary',{hasText:'界面设计'})});
  await emptyGroup.locator('summary').click();check((await emptyGroup.locator('.task-board-empty').textContent()).includes(en?'No tasks yet':'暂无任务'),'Empty space retains its explicit empty state in the full panel');
  await page.locator('.task-board-options button').nth(1).click();
  const group=page.locator('.task-board-group').first(),more=group.locator('.task-board-more');await more.click();await more.click();check(await group.locator('.task-board-task').count()===9,'Progressive load still shows three, six, then nine rows');
  await more.focus();const before=await group.evaluate(g=>{window.boardMore=g.querySelector('.task-board-more');window.boardRows=[...g.querySelectorAll('.task-board-task')];return{top:g.parentElement.scrollTop,keys:boardRows.map(e=>e.dataset.taskKey)};});
  await page.evaluate(id=>workspace.spaceAction('shared','queueResolve',[id]),sent[0]);await settled();
  const after=await group.evaluate(g=>({focused:document.activeElement===boardMore,sameMore:boardMore===g.querySelector('.task-board-more'),sameRows:boardRows.every((e,i)=>e===g.querySelectorAll('.task-board-task')[i]),top:g.parentElement.scrollTop}));
  check(after.focused&&after.sameMore&&after.sameRows&&Math.abs(after.top-before.top)<=1,'Live push preserves row nodes, loaded count, focus and reading offset');
  for(const index of[1,2]){await page.locator('.task-board-controls .task-board-options').nth(1).locator('button').nth(index).click();check(await page.locator('.task-board-task').count()>0,'Status/member classification remains reachable '+index);}
  await page.keyboard.press('Escape');check(await trigger.evaluate(e=>document.activeElement===e),'Escape closes and returns to the same global trigger');
  await page.evaluate(now=>window.taskStatusClock=now+1000,base);await until(async()=>(await trigger.innerText()).includes('1:39'),'Existing UI clock updates the confirmation countdown');
  await page.evaluate(now=>window.taskStatusClock=now+100000,base);await until(()=>page.locator('.task-status-card-time').isHidden(),'Expired confirmation leaves the global waiting count');
  check((await trigger.innerText()).includes(en?'3 need you':'3 等你'),'Expiration removes just the card, preserving queue questions and independent waiting');
  await trigger.click();await page.locator('.task-board-footer select').selectOption(history);await page.locator('.task-board-footer button').click();check(await page.locator('#queue-dialog').isVisible(),'Original space queue opens through its existing control');check((await page.locator('#queue-title').textContent()).includes('资料整理'),'The selected original space queue is the recipient');await page.locator('#close-queue').click();
  await page.locator('#independent-nav').click();
  const labels=await page.getByRole('menuitem').allTextContents(), independent=labels.filter(label=>label.startsWith('Independent A · '));assert.equal(independent.length,1);await page.getByRole('menuitem',{name:independent[0],exact:true}).click();
  for(const [width,height]of[[1240,820],[850,600]])for(const theme of['light','dark']){await app.evaluate(({BrowserWindow,nativeTheme},v)=>{BrowserWindow.getAllWindows()[0].setContentSize(v.width,v.height);nativeTheme.themeSource=v.theme;},{width,height,theme});await page.emulateMedia({colorScheme:theme});await settled();const g=await trigger.evaluate(e=>{const r=e.getBoundingClientRect(),h=document.getElementById('header').getBoundingClientRect();const t=document.getElementById('session-toolbar').getBoundingClientRect();return{x:r.x,right:r.right,top:r.top,bottom:r.bottom,headerTop:h.top,headerBottom:h.bottom,scroll:e.scrollWidth,client:e.clientWidth,toolbarRight:t.right,toolbarTop:t.top};});check(g.x>=0&&g.right<=width+1&&g.scroll<=g.client+1&&g.top>=g.headerTop&&g.bottom<=g.headerBottom&&(Math.abs(g.top-g.toolbarTop)>28||g.x>=g.toolbarRight),`${width} ${theme}: independent conversation retains the global status at the right`);if(pictures)await page.screenshot({scale:'css',path:path.join(pictures,`${language}-independent-${theme}-${width}.png`)});}
  const hidden=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().every(w=>!w.isVisible()&&!w.isFocusable()));check(hidden,'All owned windows remain hidden and unfocusable');
  const stats=await fixture('stats',ids[0]);check(stats.stats.sends===0&&stats.stats.inputs===0,'Zero native input/model sends');check(errors.length===0,'No renderer errors');
  if(pictures)fs.writeFileSync(path.join(pictures,language+'-results.json'),JSON.stringify({checks,observations,before,after,stats,errors},null,2));console.log(`SUMMARY ${checks.length} pass / 0 fail / 0 skip`);
}finally{try{await clean();await scratch.release();}finally{const owner=JSON.parse(fs.readFileSync(path.join(slot,'owner.json')));if(owner.token===token){fs.unlinkSync(path.join(slot,'owner.json'));fs.rmdirSync(slot);}}}})().catch(e=>{console.error(e);process.exitCode=1;});
