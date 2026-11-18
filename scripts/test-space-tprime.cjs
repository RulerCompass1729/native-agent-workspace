// Space navigation through the actual renderer, preload and synthetic service. No model or real native runtime.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process'), { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '..'), evidence = process.env.NAW_EVIDENCE_DIR;
assert.ok(evidence && path.isAbsolute(evidence), 'An outside-repository screenshot directory is required');
assert.ok(process.env.HOME && fs.realpathSync(process.env.HOME) !== fs.realpathSync(os.userInfo().homedir), 'Use an explicit isolated HOME');
const gitEnv = { ...process.env }; delete gitEnv.GIT_ASKPASS;
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, env: gitEnv, encoding: 'utf8' }).trim();
for (const repository of [root, path.dirname(common)]) assert.ok(!path.resolve(evidence).startsWith(repository + path.sep), 'Private evidence stays outside the repository');
const slot = path.resolve(common, '../.local/gui-test-slot.lock'), token = randomUUID();
try { fs.mkdirSync(slot); } catch (error) { if (error.code !== 'EEXIST') throw error; console.error('OCCUPIED: no GUI or service started'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Codex B', task: 'aligned member tabs', token, pid: process.pid }));
const scratch = require('./fixtures/test-scratch.cjs'), { _electron } = scratch.playwright(require('playwright'));
const { connect } = require('../app/service-client.cjs'), { createIn } = require('./fixtures/create-view.cjs'), locale = require('../app/ui-locale.js');
const profile = scratch.directory(path.join(os.tmpdir(), 'naw-space-tprime-'));
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NAW_') && !key.startsWith('ELECTRON_') && !['NODE_OPTIONS', 'NODE_PATH', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_CHILD_SESSION'].includes(key))), NAW_DATA_DIR: profile, NAW_WORKSPACE: path.join(profile, 'work'), NAW_TEST_APP_ROOT: root, NAW_TEST_PARENT_PID: String(process.pid), NAW_TEST_UI_LANGUAGE: 'zh', NAW_TEST_VISIBLE: '0', NAW_APP_VERSION: require('../package.json').version };
const child = scratch.childProcess.fork(path.join(root, 'app/daemon.cjs'), [profile], { execArgv: ['--require', path.join(__dirname, 'fixtures/loading-terminal.cjs')], env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
let app, page, client, seq = 0, errors = ''; const checks = [], shots = [];
child.stderr.on('data', data => { errors += data; }); const closed = new Promise(resolve => child.once('close', resolve));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { for (let i = 0; i < 240; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
function fixture(method = 'stats', target, value) { const id = ++seq; return new Promise((resolve, reject) => { const timer = setTimeout(() => { child.off('message', read); reject(Error('Fixture timeout: ' + method)); }, 10000); const read = r => { if (r.requestId === id) { clearTimeout(timer); child.off('message', read); resolve(r); } }; child.on('message', read); child.send({ id, method, target, value }); }); }
const check = label => { checks.push(label); console.log('PASS:', label); };
async function settle() { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); await delay(120); }
const cleanup = scratch.cleanup(async () => {
  if (app) { await app.close(); app = null; }
  if (client) { try { await client.call('shutdown'); } catch {} client.close(); client = null; }
  if (child.exitCode === null && child.signalCode === null) { await Promise.race([closed, delay(1500)]); if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); }
  await closed;
});
async function exportCompare() {
  if(!process.env.NAW_BEFORE_IMAGE)return;
  const {pathToFileURL}=require('node:url');const before=path.resolve(process.env.NAW_BEFORE_IMAGE),after=path.join(evidence,'images','8-zh-light-1280.png');assert.ok(fs.existsSync(before)&&fs.existsSync(after));
  const file=path.join(profile,'compare.html');fs.writeFileSync(file,`<!doctype html><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;padding:16px;background:#e5ebe7;color:#25362b;font:14px system-ui}h1{font-size:22px;margin:0 0 12px}article{background:white;margin-block:12px;border:1px solid #bdc9c0}h2{margin:0;padding:10px 12px;font-size:15px}img{display:block;width:100%}</style><h1>T-prime / T′: member tabs share their column boundaries</h1><article><h2>Before / C: progressive rows, no continuous tab strip</h2><img src="${pathToFileURL(before).href}"></article><article><h2>After / T′: responsive columns, swipe and continue buttons</h2><img src="${pathToFileURL(after).href}"></article>`);
  const data=await app.evaluate(async({BrowserWindow},{file})=>{const w=new BrowserWindow({width:1280,height:200,show:false,focusable:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});try{await w.loadFile(file);await w.webContents.executeJavaScript('Promise.all([...document.images].map(e=>e.decode()))');const height=await w.webContents.executeJavaScript('document.documentElement.scrollHeight');w.setContentSize(1280,height);await new Promise(r=>setTimeout(r,100));if(w.isVisible()||w.isFocused())throw Error('Export became visible');return(await w.webContents.capturePage()).toPNG().toString('base64');}finally{w.destroy();}},{file});fs.writeFileSync(path.join(evidence,'compare.png'),Buffer.from(data,'base64'));
}
async function run() {
  fs.mkdirSync(path.join(evidence,'images'),{recursive:true});
  await until(()=>fs.existsSync(path.join(profile,'connection.json')),'Synthetic service');client=await connect(profile,'tprime-person');scratch.ownService(profile);
  const ids=[];for(let i=0;i<8;i++){const id=await client.call('create',{name:'共同工作 · '+(i%2?'Codex':'Claude')+' '+(i+1),provider:i%2?'codex':'claude',cwd:path.join(profile,'work'),view:'chat'});ids.push(id);await fixture('history',id,[{id:'reply-'+i,type:'agentMessage',turnId:'demo-'+i,text:'Synthetic content only.\n\nThe member identity stays with this original session.\n\nNo message has been sent.'}]);await client.call('draft',id,'Unsent '+i);}
  const identity=(await client.call('initial')).sessions.map(s=>[s.id,s.nativeId,s.provider]);
  const sourceEntry=require('./fixtures/synthetic-source-boot.cjs').createSourceEntry({profile,code:root,fixturePid:child.pid});
  app=await _electron.launch({executablePath:require('electron'),args:[sourceEntry],env,timeout:60000});page=await app.firstWindow();page.setDefaultTimeout(15000);const pageErrors=[];page.on('pageerror',e=>pageErrors.push(e.message));
  await page.locator('#new-session').waitFor();if(await page.locator('#setup-dialog').isVisible())await page.keyboard.press('Escape');await require('./fixtures/default-space.cjs').revealDefaultSpace(page);
  for(const id of ids)await client.call('join',id,true);await page.locator('#room-nav').click();await page.locator('#room-overview').click();await settle();
  assert.equal(await page.locator('.collaboration-member-unit:not([hidden])').count(),8,'All eight members are horizontally available, without progressive expansion');
  await page.locator('.collaboration-page-next').waitFor({state:'visible'});check('Eight members are one horizontal strip with a continue button');
  for(let n=0;n<20;n++){const pending=(await fixture()).pending;if(!pending.length)break;await fixture('release',pending[0]);}
  async function metrics(label){
    await settle();const m=await page.evaluate(()=>{const host=document.getElementById('collaboration-overview'),strip=host.querySelector('.collaboration-readers'),r=strip.getBoundingClientRect(),heads=[...host.querySelectorAll('.collaboration-member-status')];let holes=0,samples=0;if(heads.length&&host.dataset.alignedTabs==='true'){const h=heads[0].getBoundingClientRect();for(const y of [h.top+.5,h.top+h.height/2,h.bottom-.5])for(let x=Math.ceil(r.left);x<r.left+strip.clientWidth;x++){samples++;if(!document.elementFromPoint(x+.1,y)?.closest('.collaboration-member-status,.collaboration-page'))holes++;}}return{holes,samples,windowWidth:innerWidth,capacity:Number(host.dataset.capacity),scroll:strip.scrollLeft,width:strip.clientWidth,available:strip.parentElement.clientWidth,total:strip.scrollWidth,columns:heads.map(h=>{const a=h.getBoundingClientRect(),u=h.closest('.collaboration-member-unit').getBoundingClientRect(),b=h.nextElementSibling.getBoundingClientRect();return{id:h.dataset.memberId,left:a.left,right:a.right,width:a.width,deltaLeft:a.left-u.left,deltaRight:a.right-u.right,readerLeft:a.left-b.left,readerRight:a.right-b.right,visible:a.right>r.left+1&&a.left<r.right-1};}),buttons:[...host.querySelectorAll('.collaboration-page')].map(b=>({class:b.className,hidden:b.hidden,text:b.textContent,label:b.getAttribute('aria-label')}))};});
    assert.equal(m.holes,0,label+': no exposed strip background');assert.equal(m.width,m.available,label+': strip fills current viewport');assert.equal(m.capacity,Math.max(1,Math.floor(m.width/260)),label+': live capacity');for(const b of m.buttons.filter(b=>!b.hidden))assert.ok(b.label&&/\d/.test(b.label),label+': counted accessible paging name');for(const c of m.columns){assert.equal(c.deltaLeft,0,label+': left');assert.equal(c.deltaRight,0,label+': right');assert.equal(c.readerLeft,0,label+': reader left');assert.equal(c.readerRight,0,label+': reader right');}for(let i=1;i<m.columns.length;i++)assert.equal(m.columns[i].left-m.columns[i-1].right,0,label+': gap');
    if(m.columns.length<=m.capacity)assert.ok(m.total<=m.width+1,label+': all fit without scroll');
    shots.push({label,...m});return m;
  }
  for(const lang of ['zh','en']){
    if(lang==='en'){await page.locator('#setup-button').click();await page.locator('#ui-language').selectOption(lang);await page.waitForFunction(v=>document.querySelector('#new-session').getAttribute('aria-label')===v,locale.format(lang,'sidebar.newSession'));await page.keyboard.press('Escape');}
    for(const theme of ['light','dark']){await app.evaluate(({nativeTheme},v)=>nativeTheme.themeSource=v,theme);await page.emulateMedia({colorScheme:theme});
      for(const count of [4,7,8]){for(let i=0;i<8;i++)await client.call('join',ids[i],i<count);await page.locator('#room-overview').click();await until(async()=>await page.locator('.collaboration-member-unit').count()===count,'Member fixture count');
        for(const width of [1280,1600]){await app.evaluate(({BrowserWindow},w)=>BrowserWindow.getAllWindows().forEach(win=>win.setContentSize(w,900)),width);await page.locator('.collaboration-readers').evaluate(e=>e.scrollLeft=0);const key=`${count}-${lang}-${theme}-${width}`;const initial=await metrics(key+' initial');assert.equal(initial.windowWidth,width,'Actual source viewport width');await page.screenshot({path:path.join(evidence,'images',key+'.png'),scale:'css'});
          let steps=0;while(await page.locator('.collaboration-page-next').isVisible()){await page.locator('.collaboration-page-next').click();await metrics(key+' next '+steps);await page.screenshot({path:path.join(evidence,'images',key+'-frame-'+steps+'.png'),scale:'css'});assert.ok(++steps<10);}
          const last=(await metrics(key+' last')).columns.at(-1);assert.equal(last.id,ids[count-1]);assert.ok(last.visible,'Continue reaches last member');
          if(await page.locator('.collaboration-page-previous').isVisible()){await page.locator('.collaboration-page-previous').focus();await page.keyboard.press('Enter');await metrics(key+' keyboard previous');}
          await page.locator('.collaboration-readers').evaluate(e=>e.scrollLeft=(e.scrollWidth-e.clientWidth)*.47);await metrics(key+' manual scroll');check(key+': aligned, continuous, next reaches last, keyboard previous');
        }
      }
    }
  }
  // Edge states stay readable beside paging controls; use the same real input
  // path as the reviewer's wheel counterexample rather than setting scrollLeft.
  await app.evaluate(({BrowserWindow,nativeTheme})=>{BrowserWindow.getAllWindows().forEach(win=>win.setContentSize(1280,900));nativeTheme.themeSource='light';});await page.emulateMedia({colorScheme:'light'});
  for(const lang of ['zh','en']){
    await page.locator('#setup-button').click();await page.locator('#ui-language').selectOption(lang);await page.waitForFunction(v=>document.querySelector('#new-session').getAttribute('aria-label')===v,locale.format(lang,'sidebar.newSession'));await page.keyboard.press('Escape');
    await page.locator('.collaboration-readers').evaluate(e=>e.scrollLeft=e.firstElementChild.getBoundingClientRect().width);await settle();
    const edgeIds=await page.evaluate(()=>['page-start','page-end'].map(c=>document.querySelector('.collaboration-member-status.'+c)?.dataset.memberId));assert.ok(edgeIds.every(Boolean));
    await fixture('native-activity',edgeIds[0],{turnId:'synthetic-edge-busy',label:'Working',observedAt:Date.now()});await fixture('native-permission',edgeIds[1],{requests:[{id:'synthetic-edge-permission'}],observedAt:Date.now()});
    await until(async()=>{const rows=(await client.call('initial')).sessions;return rows.find(s=>s.id===edgeIds[0]).state==='working'&&rows.find(s=>s.id===edgeIds[1]).state==='approval';},'Busy and approval edge states');await settle();
    const states=await page.evaluate(()=>[...document.querySelectorAll('.collaboration-member-status.page-start,.collaboration-member-status.page-end')].map(h=>{
      const el=h.querySelector('.collaboration-member-state'),r=el.getBoundingClientRect(),range=document.createRange();range.selectNodeContents(el);const text=range.getBoundingClientRect();
      return{state:h.dataset.state,text:el.textContent,width:r.width,height:r.height,clip:getComputedStyle(el).clipPath,textWidth:text.width,visible:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===el};
    }));
    await page.screenshot({path:path.join(evidence,'images',lang+'-busy-approval-edges.png'),scale:'css'});fs.writeFileSync(path.join(evidence,lang+'-edge-states.json'),JSON.stringify(states,null,2));
    for(const state of states){assert.ok(state.text.includes(locale.format(lang,state.state==='working'?'state.working':'state.approval')));assert.ok(state.height>=10&&state.width>=20&&state.clip==='none'&&state.visible,'Edge state must be directly readable, not a clipped accessibility-only node');assert.ok(state.textWidth<=state.width+1,'Busy/approval words fit without truncation');}
    for(const id of edgeIds){await fixture('native-permission',id,null);await fixture('native-activity',id,null);await fixture('state',id);}await settle();
    check(lang+': busy and approval edge words remain visible beside both paging buttons');
  }
  await fixture('history',ids[0],[{id:'scroll-regression',type:'agentMessage',turnId:'synthetic-scroll',text:'Synthetic scrolling paragraph.\n\n'.repeat(160)}]);
  const strip=page.locator('.collaboration-readers'),body=page.locator('.collaboration-messages').first();await strip.evaluate(e=>e.scrollLeft=0);
  await until(()=>body.evaluate(e=>e.scrollHeight>e.clientHeight+500),'Scrollable synthetic body');await body.evaluate(e=>e.scrollTop=0);await settle();
  let box=await body.boundingBox();assert.ok(box);await page.mouse.move(box.x+box.width/2,box.y+Math.min(100,box.height/2));await page.mouse.wheel(0,240);await delay(350);
  assert.ok(await body.evaluate(e=>e.scrollTop)>0,'Real vertical wheel scrolls the body');assert.equal(await strip.evaluate(e=>e.scrollLeft),0);
  await body.evaluate(e=>e.scrollTop=e.scrollHeight);const beforeY=await page.evaluate(()=>({page:scrollY,document:document.scrollingElement.scrollTop,strip:document.querySelector('.collaboration-readers').scrollTop}));await page.mouse.wheel(0,400);await delay(350);
  assert.deepEqual(await page.evaluate(()=>({page:scrollY,document:document.scrollingElement.scrollTop,strip:document.querySelector('.collaboration-readers').scrollTop})),beforeY,'Vertical boundary stays isolated');assert.equal(await body.evaluate(e=>getComputedStyle(e).overscrollBehaviorY),'contain');
  const bodyTop=await body.evaluate(e=>e.scrollTop);await page.mouse.wheel(380,0);await delay(350);const bodyWheel=await strip.evaluate(e=>e.scrollLeft);assert.ok(bodyWheel>0,'Horizontal wheel over conversation advances columns');assert.equal(await body.evaluate(e=>e.scrollTop),bodyTop);
  await strip.evaluate(e=>e.scrollLeft=0);await settle();box=await page.locator('.collaboration-member-status').first().boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.wheel(380,0);await delay(350);const headerWheel=await strip.evaluate(e=>e.scrollLeft);assert.ok(headerWheel>0,'Header horizontal wheel still advances columns');
  await strip.evaluate(e=>e.scrollLeft=0);await page.locator('.collaboration-member-name').first().focus();await page.keyboard.press('ArrowRight');await delay(350);const arrowScroll=await strip.evaluate(e=>e.scrollLeft);assert.ok(arrowScroll>0,'Native ArrowRight scrolling remains available');
  await strip.evaluate(e=>e.scrollLeft=0);await settle();await page.locator('.collaboration-page-next').focus();await page.keyboard.press('Enter');await until(()=>page.locator('.collaboration-page-next').isHidden(),'Keyboard continue reaches last group');assert.equal(await page.evaluate(()=>document.activeElement.closest('.collaboration-member-status')?.dataset.memberId),ids.at(-1));
  await page.locator('.collaboration-page-previous').focus();await page.keyboard.press('Enter');await until(()=>page.locator('.collaboration-page-previous').isHidden(),'Keyboard previous reaches first group');assert.equal(await page.evaluate(()=>document.activeElement.closest('.collaboration-member-status')?.dataset.memberId),ids[0]);
  fs.writeFileSync(path.join(evidence,'wheel-regression.json'),JSON.stringify({bodyWheel,headerWheel,arrowScroll,verticalBodyScroll:true,verticalBoundaryIsolated:true,keyboardPaging:true},null,2));check('Real body/header wheel, vertical isolation, ArrowRight and keyboard paging');
  await page.locator('.collaboration-readers').evaluate(e=>e.scrollLeft=0);await settle();const grip=page.locator('.collaboration-resize').first();const g=await grip.boundingBox();assert.ok(g);await page.mouse.move(g.x+g.width/2,g.y+10);await page.mouse.down();await page.mouse.move(g.x+g.width/2+30,g.y+10,{steps:5});await page.mouse.up();await metrics('real column drag');
  await page.locator('.collaboration-layout-controls button').nth(1).click();await settle();assert.equal(await page.locator('.collaboration-page:visible').count(),0);assert.equal(await page.locator('.collaboration-member-unit:not([hidden])').count(),8);check('List retains all eight members, without horizontal paging controls');
  await page.locator('.collaboration-layout-controls button').first().click();await page.locator('.collaboration-member-name').first().click();await page.locator('#conversation-pane-toolbar #room-member-tabs button').waitFor({state:'visible'});assert.equal(await page.locator('.collaboration-page:visible').count(),0);assert.equal(await page.locator('#message-input').inputValue(),'Unsent 0');await page.locator('#room-overview').click();await page.locator('#collaboration-overview').waitFor({state:'visible'});check('Focused member keeps its original draft; the original Member overview entry returns to the strip');
  assert.deepEqual((await client.call('initial')).sessions.map(s=>[s.id,s.nativeId,s.provider]),identity);const stats=await fixture();assert.equal(stats.sends.length,0);assert.equal(stats.inputs.length,0);assert.deepEqual(pageErrors,[]);assert.ok((await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().map(w=>[w.isVisible(),w.isFocused()]))).every(v=>v.every(x=>!x)));check('Same native identities, no model/send/input, no page errors, hidden window');
  await exportCompare();
  fs.writeFileSync(path.join(evidence,'gui-checks.json'),JSON.stringify({pass:checks.length,fail:0,checks,shots,pageErrors,pids:{main:app.process().pid,backend:child.pid},models:0,sends:0,inputs:0},null,2));console.log(`GUI ${checks.length}/0; ${shots.length} geometry states; models/sends/inputs 0`);
}
run().catch(error => { console.error(error.stack); console.error(errors); process.exitCode = 1; }).finally(async () => { try { await cleanup(); } finally { if (JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))).token === token) fs.rmSync(slot, { recursive: true }); } }).catch(error => { console.error(error.stack); process.exitCode = 1; });
