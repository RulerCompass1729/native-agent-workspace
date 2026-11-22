// Hidden source Electron, synthetic native transport and records; no provider or model.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto'), { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'), scratch = require(path.join(root,'scripts/fixtures/test-scratch.cjs')), { _electron } = scratch.playwright(require('playwright'));
const { createSourceEntry } = require(path.join(root,'scripts/fixtures/synthetic-source-boot.cjs')), messages = require(path.join(root,'app/ui-messages.js'));
const lang = process.env.NAW_TEST_UI_LANGUAGE || process.argv[2] || 'zh', out = process.env.NAW_SIDEBAR_EVIDENCE_DIR;
const plan = { task: 'collapsed sidebar geometry and recovery', maxElectronStarts: 1, maxOwnedDaemonStarts: 1, productModels: 0, providers: 0, nativeInputs: 0, sends: 0 };
if (process.argv.includes('--plan')) { console.log(JSON.stringify(plan, null, 2)); process.exit(0); }
assert.ok(['zh', 'en'].includes(lang), 'Language zh or en'); assert.ok(out && path.isAbsolute(out) && !fs.existsSync(out), 'NAW_SIDEBAR_EVIDENCE_DIR: a new absolute directory');
assert.ok(fs.existsSync(path.join(root, 'app/dsh/client.js')), 'Run node scripts/build-ui.cjs first');
const slot = path.resolve(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim(), '..', '.local/gui-test-slot.lock'), token = randomUUID();
const benign = new Set(['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'HOME', 'SHELL', 'USER', 'LOGNAME', 'TZ', 'TERM', 'COLORTERM', 'COMMAND_MODE', '__CF_USER_TEXT_ENCODING']);
const env = extra => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => benign.has(k))), ...extra });
const t = (key, params) => messages[lang][key].replace(/\{(\w+)\}/g, (_, name) => String(params[name]));
let profile, child, client, app, page, sequence = 0, lease = false;
const errors = [], ids = [], rooms = [], shots = [], checks = [];
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label, ms = 4000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await delay(25); } throw Error(label); }
function fixture(method, target, value) {
  const id = ++sequence;
  return new Promise((resolve, reject) => { const cb = reply => { if (reply.requestId !== id) return; clearTimeout(timer); child.off('message', cb); reply.error ? reject(Error(reply.error)) : resolve(reply); };
    const timer = setTimeout(() => { child.off('message', cb); reject(Error('Fixture deadline')); }, 8000); child.on('message', cb); child.send({ id, method, target, value }); });
}
const settle = async () => { await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))); await delay(150); };
const size = async (width, height) => { await app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].setContentSize(s.width, s.height), { width, height }); await settle(); };
const surface = () => page.locator('.naw[data-native-surface="sidebar"]');
const S = id => `.naw[data-native-surface="sidebar"] [data-session-row="${id}"]`, G = id => `.naw[data-native-surface="sidebar"] [data-session-group="${id}"] .session-space-heading`;
async function rail(on) { if (await surface().getAttribute('data-collapsed') !== String(on)) { await page.locator('#sidebar-toggle').click(); await until(async () => await surface().getAttribute('data-collapsed') === String(on), 'Sidebar ' + (on ? 'rail' : 'expanded')); await settle(); } }
const NAMES={sessions:lang==='zh'?['大管家','界面开发','测试','资料核对','说明文档','接口开发','代码检查','任务整理','回归验收','独立验收']:['Butler','UI work','Tests','Source check','Docs','API work','Code review','Task notes','Regression','Solo check'],spaces:lang==='zh'?['产品开发','资料整理']:['Product work','Reference'],queue:[],history:['Check the sidebar.','Synthetic sidebar fixture.']};
const PROVIDERS = ['claude', 'claude', 'codex', 'claude', 'codex', 'claude'];
// Session i → [vendor, model, cwd, worktree?]; times relative to launch. Synthetic paths only.
const FACTS = [['deepseek', 'deepseek-v4-pro', '/demo/projects/atlas-desktop-lanes/hover-details-round-2', { repository: '/demo/projects/atlas-desktop', nonce: 'e41f9c-27', branch: 'naw/session-e41f9c27' }],
  ['anthropic', 'claude-opus-5-5', '/demo/projects/atlas-desktop', null], ['openai', 'gpt-6.1-sol', '/demo/projects/atlas-desktop-lanes/check', { repository: '/demo/projects/atlas-desktop', nonce: 'b7720d-11', branch: 'naw/session-b7720d11' }],
  ['anthropic', 'claude-opus-5-5', '/demo/notes', null], ['openai', 'gpt-6.1-sol', '/demo/data', null], ['deepseek', 'deepseek-v4-pro', '', null]];

async function launch() {
  profile = scratch.directory(path.join(os.tmpdir(), 'naw-hover-card-')); const cwd = path.join(profile, 'workspace'); fs.mkdirSync(cwd);
  const nativeFixture = path.join(profile, 'status-fixture.cjs');
  fs.writeFileSync(nativeFixture, `require(${JSON.stringify(path.join(root,'scripts/fixtures/loading-terminal.cjs'))});
const {NativeHost}=require(${JSON.stringify(path.join(root,'app/adapters.cjs'))}),create=NativeHost.prototype.create,records=new Map();
NativeHost.prototype.create=function(record){const r=create.call(this,record);records.set(record.id,r);return r;};
process.on('message',q=>{if(q.method==='status-background')records.get(q.target)?.emit('background',q.value);});
`);
  child = scratch.childProcess.fork(path.join(root, 'app/daemon.cjs'), [profile], { cwd, execArgv: ['--require', nativeFixture], env: env({ NAW_TEST_APP_ROOT: root, NAW_WORKSPACE: cwd, NAW_APP_VERSION: require(path.join(root, 'package.json')).version }), stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Owned synthetic backend', 20000);
  client = await require(path.join(root, 'app/service-connection.cjs')).connectService(profile, 'hover-seed');
  for (const [i, name] of NAMES.sessions.entries()) ids.push(await client.call('create', { provider: PROVIDERS[i % PROVIDERS.length], cwd, name, view: 'chat' }));
  await fixture('set-state', ids[1], 'working'); await fixture('set-state', ids[2], 'approval'); await fixture('set-state', ids[5], 'working'); await fixture('set-state', ids[6], 'error');
  await client.call('wakePolicy', null, false); // automatic messages off: queued items stay queued
  fs.writeFileSync(path.join(profile,'steward.json'),JSON.stringify({version:1,selected:{sessionId:ids[0],nativeId:'synthetic-'+ids[0]}}),{mode:0o600});
  const now = Date.now(), entry = createSourceEntry({ profile, code: root, fixturePid: child.pid }), file = path.join(entry, 'entry.cjs');
  fs.writeFileSync(file, `const e=require('electron');e.Notification.isSupported=()=>false;globalThis.hoverGuards=[];globalThis.hoverQueue={};
for(const name of ['showOpenDialog','showSaveDialog','showMessageBox','showOpenDialogSync','showSaveDialogSync','showMessageBoxSync'])e.dialog[name]=()=>{hoverGuards.push(name);throw Error('OS dialog outside test');};
const {WorkspaceClient}=require(${JSON.stringify(path.join(root, 'app/workspace-client.cjs'))}), old=WorkspaceClient.prototype.snapshot, ids=${JSON.stringify(ids)}, facts=${JSON.stringify(FACTS)}, now=${now};
WorkspaceClient.prototype.snapshot=function(...args){const s=structuredClone(old.apply(this,args));
for(const r of s.sessions){const i=ids.indexOf(r.id);if(i<0)throw Error('Unexpected record');const [vendor,model,cwd,plan]=facts[i%facts.length];r.vendor=vendor;r.model=model;r.cwd=cwd;if(plan)r.worktreePreparation={...plan,target:cwd};
r.createdAt=now-3600e3;r.lastActivityAt=now-60e3;r.runtimeVersion='0.1.0-alpha.215';if(i===3)r.fleet=[{event:'subAgentActivity',nativeId:'synthetic-child',kind:'interacted',stale:false}];if(i===7){r.background=1;r.backgroundKinds=['shell'];r.backgroundAt=now;}}
s.steward={sessionId:ids[0],nativeId:s.sessions[0]?.nativeId};return s;};
const {RoomState}=require(${JSON.stringify(path.join(root, 'app/room-state.cjs'))}), oldApply=RoomState.prototype.apply;
RoomState.prototype.apply=function(...args){const s=oldApply.apply(this,args);if(!s||!Object.keys(hoverQueue).length)return s;const c=structuredClone(s);
for(const room of [c.room,...(c.rooms||[])].filter(Boolean))for(const item of room.queue||[]){const p=hoverQueue[item.text];if(p)Object.assign(item,p);}return c;};
` + fs.readFileSync(file, 'utf8'));
  app = await _electron.launch({ executablePath: require('electron'), args: [entry], env: env({ NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid), NAW_TEST_VISIBLE: '0', NAW_TEST_UI_LANGUAGE: lang }), timeout: 60000 });
  await until(async () => { for (const p of app.windows()) if (!p.isClosed() && await p.locator('#new-session').count()) { page = p; return true; } return false; }, 'Workspace page', 30000);
  page.setDefaultTimeout(8000); page.on('pageerror', e => errors.push(e.message));
  assert.deepEqual(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ visible: w.isVisible(), focusable: w.isFocusable() }))), [{ visible: false, focusable: false }]);
  await size(1240, 820);
  rooms.push('shared'); rooms.push(await page.evaluate(name => workspace.spaceCreate(name), NAMES.spaces[1]));
  for (const [r, i] of [[0,1],[0,2],[0,3],[0,4],[1,5],[1,6],[1,7],[1,8]]) await page.evaluate(({ room, id }) => workspace.spaceAction(room, 'join', [id, true]), { room: rooms[r], id: ids[i] });
  const patches = {};
  for (const [text, status, to] of NAMES.queue) if (status !== 'queued') patches[text] = { status, sentTo: ids[to], sentAt: now - 20 * 60e3 };
  await app.evaluate((_e, p) => { globalThis.hoverQueue = p; }, patches);
  for (const [text, , , r = 0] of NAMES.queue) await page.evaluate(({ room, text }) => workspace.spaceAction(room, 'queueAdd', [text, null]), { room: rooms[r], text });
  await page.locator('#sessions-grouped').click(); await page.locator(S(ids[0]) + ' .session-link').click(); await settle(); await fixture('release', ids[0]); await settle();
  // Synthetic conversation in the open session, so the translucent card has text behind it.
  const done = Math.floor(Date.now() / 1000) - 60;
  await fixture('history', ids[0], { items: [{ id: 'u1', type: 'userMessage', turnId: 't1', content: [{ type: 'text', text: NAMES.history[0] }] }, { id: 'a1', type: 'agentMessage', turnId: 't1', text: NAMES.history[1] }],
    turns: [{ id: 't1', status: 'completed', completedAt: done, durationMs: 4200 }] });
  await page.locator('#messages .message-body p').first().waitFor(); await settle();
}
const failures=[];
async function check(name,fn){try{await fn();checks.push(name);console.log('PASS '+name);}catch(e){failures.push({name,error:e.stack});console.error('FAIL '+name+'\n'+e.stack);}}
async function inspect(){return page.evaluate(()=>{
 const box=e=>{const r=e.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
 const drawn=e=>e.getClientRects().length&&getComputedStyle(e).display!=='none';
 const list=document.getElementById('session-list'), rail=document.querySelector('.naw[data-native-surface="sidebar"]');
 return {rail:box(rail),list:box(list),scrollHeight:list.scrollHeight,clientHeight:list.clientHeight,scrollTop:list.scrollTop,scrollbar:getComputedStyle(list).scrollbarWidth,scrollState:CSS.supports('container-type:scroll-state'),extraGroupControls:[...list.querySelectorAll('.session-space-toggle,.session-space-enter,.sidebar-space-lines')].filter(drawn).length,
  hints:[getComputedStyle(list,'::before').opacity,getComputedStyle(list,'::after').opacity],
  groups:[...list.querySelectorAll('.session-space-group:not([data-session-group="independent"])')].map(e=>({box:box(e),parts:[...e.querySelectorAll('h3 button,.sidebar-space-tile,.agent-icon,.state-dot')].filter(drawn).map(c=>({kind:c.className,box:box(c)}))})),
  rows:[...rail.querySelectorAll('.session-row')].filter(drawn).map(e=>{const s=e.querySelector('.sidebar-rail-status');return {height:box(e).height,name:e.querySelector('.session-link').getAttribute('aria-label'),word:s&&drawn(s)?s.textContent:null,versions:[...e.querySelectorAll('.session-backend-version')].some(drawn),markers:[...e.querySelectorAll('.sidebar-state-marker')].some(drawn),dotVisible:[...e.querySelectorAll('.agent-icon>.state-dot')].some(drawn)};}),
  tools:[...rail.querySelectorAll('.sidebar-tools button,#archive-button')].filter(drawn).map(e=>({id:e.id,box:box(e)})),
  version:{name:document.getElementById('backend-version-summary').getAttribute('aria-label'),short:getComputedStyle(document.getElementById('backend-version-summary'),'::before').content},
  fold:box(document.getElementById('solo-drop').querySelector('.group-chevron')),
  buttons:[...rail.querySelectorAll('button')].filter(drawn).map(e=>({id:e.id,cls:e.className,name:e.getAttribute('aria-label')||e.title||e.innerText,box:box(e),radius:getComputedStyle(e).borderRadius}))};
});}
async function behaviour(){
 for(const [width,height] of [[850,600],[1240,820]])for(const theme of ['light','dark']){
  await size(width,height);await rail(true);await page.emulateMedia({colorScheme:theme});await page.waitForFunction(d=>document.body.hasAttribute('data-ds-dark-theme')===d,theme==='dark');await page.mouse.move(width-10,5);await page.locator('#session-list').evaluate(e=>e.scrollTop=0);await delay(250);
  const data=await inspect(),label=`${width}x${height} ${theme}`,inside=(a,b)=>a.left>=b.left-.01&&a.right<=b.right+.01&&a.top>=b.top-.01&&a.bottom<=b.bottom+.01;
  await check(label+' space controls and avatars remain inside their own card',async()=>{assert.equal(data.extraGroupControls,0);for(const g of data.groups)for(const p of g.parts)assert.ok(inside(p.box,g.box),JSON.stringify({card:g.box,part:p}));});
  await check(label+' one status color block and readable word retain full facts',async()=>{assert.equal(data.rows.length,10);for(const r of data.rows){assert.ok(r.word);assert.equal(r.markers,false);assert.equal(r.dotVisible,true);assert.ok(r.name.includes(' · '));}for(const text of lang==='zh'?['就绪','在做','等你','待核实']:['Ready','Work','You','Check'])assert.ok(data.rows.some(r=>r.word===text),text);});
  await check(label+' row heights match without version arrows; version details remain named',async()=>{assert.ok(data.rows.every(r=>!r.versions));assert.ok(Math.max(...data.rows.map(r=>r.height))-Math.min(...data.rows.map(r=>r.height))<.1);assert.ok(data.version.name);assert.match(data.version.short,lang==='zh'?/版本/:/Version/);});
  await check(label+' every drawn button has a readable name and at least 24px target',async()=>{for(const b of data.buttons){assert.ok(b.name.trim(),b.id||b.cls);assert.ok(b.box.width>=24&&b.box.height>=24,JSON.stringify(b));}});
  await check(label+' list disclosure is centered',async()=>{assert.ok(Math.abs((data.fold.left+data.fold.right)/2-(data.rail.left+data.rail.right)/2)<2);});
  await check(label+' bottom actions fit completely inside the viewport and rail',async()=>{for(const t of data.tools){assert.ok(inside(t.box,data.rail),JSON.stringify(t));assert.ok(t.box.bottom<=height);}});
  await check(label+' navigation actions share the 32px rounded button shape',async()=>{for(const id of ['sidebar-toggle','new-session','search-button','panorama-nav','archive-button','discoveries-button','records-button','setup-button','privacy-button']){const b=data.buttons.find(b=>b.id===id);assert.ok(b,id);assert.equal(b.box.width,32);assert.equal(b.box.height,32);assert.equal(b.radius,'8px');}});
  await check(label+' scrollable list has a cue and reveals the last complete row',async()=>{assert.ok(data.scrollHeight>data.clientHeight);assert.notEqual(data.scrollbar,'none');if(data.scrollState)assert.ok(Number(data.hints[1])>0);await page.locator('#session-list').evaluate(e=>e.scrollTop=e.scrollHeight);await delay(180);const last=await page.locator('#session-list .session-row').last().boundingBox(),end=await inspect();assert.ok(last.y>=end.list.top&&last.y+last.height<=end.list.bottom+.1,JSON.stringify({last,list:end.list}));if(end.scrollState){assert.ok(Number(end.hints[0])>0);assert.equal(Number(end.hints[1]),0);}});
  await page.locator('#session-list').evaluate(e=>e.scrollTop=0);await delay(100);const file=`${lang}-${width}-${height}-${theme}`;await page.screenshot({path:path.join(out,file+'.png')});fs.writeFileSync(path.join(out,file+'.json'),JSON.stringify(data,null,2));
 }
 await parity();
 await check('space and session menus retain their keyboard anchor and return focus',async()=>{
  await page.locator('#session-list').evaluate(e=>e.scrollTop=0);const more=page.locator('[data-session-group="'+rooms[0]+'"] .space-group-more');await more.click();await page.locator('[role="menu"]').waitFor();await page.keyboard.press('Escape');assert.ok(await more.evaluate(e=>e===document.activeElement));
  const link=page.locator(S(ids[1])+' .session-link');await link.focus();await link.press('Shift+F10');await page.locator('[role="menu"]').waitFor();await page.keyboard.press('Escape');assert.ok(await link.evaluate(e=>e===document.activeElement));
  const ring=await link.evaluate(e=>{const r=e.getBoundingClientRect(),g=e.closest('.session-space-group').getBoundingClientRect(),c=getComputedStyle(e),extra=Math.max(0,parseFloat(c.outlineWidth)+parseFloat(c.outlineOffset));return {left:r.left-extra,right:r.right+extra,groupLeft:g.left,groupRight:g.right,style:c.outlineStyle};});assert.notEqual(ring.style,'none');assert.ok(ring.left>=ring.groupLeft&&ring.right<=ring.groupRight,JSON.stringify(ring));
 });
 await check('panorama navigation retains its selected background',async()=>{await rail(true);await page.locator('#panorama-nav').click();await until(async()=>await page.locator('#panorama-nav').evaluate(e=>e.classList.contains('active')),'Panorama selected');assert.notEqual(await page.locator('#panorama-nav').evaluate(e=>getComputedStyle(e).backgroundColor),'rgba(0, 0, 0, 0)');});
 await check('expanded sidebar keeps original names and no extra rail status words',async()=>{await rail(false);assert.equal(await page.locator('.sidebar-rail-status:visible').count(),0);assert.equal(await page.locator('.session-row .agent-icon>.state-dot:visible').count(),10);for(const id of ids)assert.ok((await page.locator(S(id)+' .session-link').getAttribute('aria-label')).length>10);});
}
async function routes(){
 for(const [width,height] of [[850,600],[1240,820]])for(const theme of ['light','dark'])for(const collapsed of [false,true]){
  await size(width,height);await page.emulateMedia({colorScheme:theme});await rail(collapsed);
  await check(`${width} ${theme} space to independent session restores ${collapsed?'collapsed':'expanded'} sidebar geometry`,async()=>{
   await page.locator(G(rooms[0])).click();await until(async()=>(await page.evaluate(()=>workspace.initial())).viewState.selected==='room','Space selected');await settle();if((await page.evaluate(()=>workspace.initial())).viewState.roomSession!==ids[1]){await page.locator('.collaboration-member-status[data-member-id="'+ids[1]+'"] .collaboration-member-name').click();await until(async()=>(await page.evaluate(()=>workspace.initial())).viewState.roomSession===ids[1],'Member focused');await settle();}
   await page.locator('#independent-nav').click();const names=await page.getByRole('menuitem').allTextContents(),matches=names.filter(n=>n.startsWith(NAMES.sessions[9]+' · '));assert.equal(matches.length,1,JSON.stringify(names));await page.getByRole('menuitem',{name:matches[0],exact:true}).click();await until(async()=>(await page.evaluate(()=>workspace.initial())).viewState.selected===ids[9],'Independent session selected');await settle();await delay(350);
   const data=await page.evaluate(()=>{const e=document.querySelector('.naw[data-native-surface="sidebar"]');return {collapsed:e.dataset.collapsed,width:e.getBoundingClientRect().width,frame:e.closest('[data-naw-shell-sidebar]')?.getBoundingClientRect().width,labels:[...e.querySelectorAll('.rail-label')].map(n=>{const r=document.createRange();r.selectNodeContents(n);return {text:n.textContent,visible:n.getClientRects().length>0,lines:r.getClientRects().length};})};});
   const file=`route-${width}-${theme}-${collapsed?'collapsed':'expanded'}`;await page.screenshot({path:path.join(out,file+'.png')});fs.writeFileSync(path.join(out,file+'.json'),JSON.stringify(data,null,2));
   assert.equal(data.collapsed,String(collapsed),JSON.stringify(data));assert.ok(collapsed?data.width<65:data.width>=250,JSON.stringify(data));
   for(const label of data.labels.filter(n=>n.visible))assert.ok(label.lines<=1,JSON.stringify(label));
  });
 }
}
async function parity(){
 const target=ids[1],words=lang==='zh'?['待核实','就绪','在做','等你','卡住']:['Check','Ready','Work','You','Stuck'];
 // An idle event without a Claude turn-end report leaves background work unconfirmed.
 const phases=[['idle without report','set-state','idle','idle','idle',words[0]],['reported idle','status-background',{count:0,kinds:[],scheduled:0,ids:[]},'idle','idle',words[1]],
  ['working','set-state','working','working','working',words[2]],['approval','set-state','approval','approval','waiting',words[3]],['error','set-state','error','error','stuck',words[4]],['working again','set-state','working','working','working',words[2]]];
 for(const theme of ['light','dark'])for(const collapsed of [true,false]){
  await size(1240,820);await rail(collapsed);await page.emulateMedia({colorScheme:theme});await page.waitForFunction(d=>document.body.hasAttribute('data-ds-dark-theme')===d,theme==='dark');await settle();
  await page.evaluate(id=>{
   const ctx=document.createElement('canvas').getContext('2d');
   window.sidebarParityRead=()=>[...document.querySelectorAll('.naw[data-native-surface="sidebar"] .session-row')].map(row=>{
    const sid=row.dataset.sessionRow,s=row.querySelector('.agent-icon>.state-dot'),h=document.querySelector('#agent-distribution .agent-strip .agent-cell[data-session-id="'+sid+'"]');
    if(!s||!h)return {id:sid,missing:!s?'sidebar':'header'};
    const a=getComputedStyle(s),b=getComputedStyle(h),color=a.getPropertyValue('--agent-color').trim();ctx.clearRect(0,0,1,1);ctx.fillStyle=color;ctx.fillRect(0,0,1,1);const rgb=ctx.getImageData(0,0,1,1).data,paint='rgb('+[...rgb].slice(0,3).join(', ')+')';
    const ink=c=>[c.backgroundColor,c.backgroundImage,c.borderTopColor,c.boxShadow].join(' '),look=e=>[...e.classList].filter(c=>c!=='agent-cell').sort().join(' ');
    return {id:sid,nativeState:s.dataset.nativeState,group:h.dataset.agentStatus,word:row.querySelector('.sidebar-rail-status')?.textContent,side:look(s),header:look(h),color,headerColor:b.getPropertyValue('--agent-color').trim(),sidePaint:ink(a).includes(paint),headerPaint:ink(b).includes(paint),visible:s.getClientRects().length>0};
   });
   window.sidebarParitySamples=[];window.sidebarParityObserver=new MutationObserver(()=>window.sidebarParitySamples.push(...window.sidebarParityRead().filter(x=>x.id===id)));window.sidebarParityObserver.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['class','style','data-native-state','data-agent-status']});
  },target);
  await check(theme+' '+(collapsed?'collapsed':'expanded')+' sidebar and header share classes and painted status colors',async()=>{
   const rows=await page.evaluate(()=>window.sidebarParityRead());assert.equal(rows.length,10);
   for(const r of rows){assert.equal(r.missing,undefined,JSON.stringify(r));assert.ok(r.visible,JSON.stringify(r));assert.ok(r.color,JSON.stringify(r));assert.equal(r.side,r.header,JSON.stringify(r));assert.equal(r.color,r.headerColor,JSON.stringify(r));assert.ok(r.sidePaint&&r.headerPaint,JSON.stringify(r));}
  });
  for(const [label,method,value,state,group,word] of phases)await check(theme+' '+(collapsed?'collapsed':'expanded')+' native '+label+' updates both surfaces in the same mutation checkpoint',async()=>{
   await page.evaluate(()=>window.sidebarParitySamples.length=0);await fixture(method,target,value);
   try{await until(async()=>await page.evaluate(({id,state,group,word})=>{const r=window.sidebarParityRead().find(x=>x.id===id);return r?.nativeState===state&&r.group===group&&r.word===word;},{id:target,state,group,word}),'Synchronized '+label,6000);}catch(error){fs.appendFileSync(path.join(out,'parity-failed.jsonl'),JSON.stringify({theme,collapsed,label,state,group,word,rows:await page.evaluate(()=>window.sidebarParityRead()),samples:await page.evaluate(()=>window.sidebarParitySamples)})+'\n');throw error;}
   const samples=await page.evaluate(()=>window.sidebarParitySamples);assert.ok(samples.length,'Mutation observer saw the native event');
   for(const r of samples){assert.equal(r.missing,undefined,JSON.stringify(r));assert.equal(r.side,r.header,JSON.stringify(r));assert.equal(r.color,r.headerColor,JSON.stringify(r));assert.ok(r.sidePaint&&r.headerPaint,JSON.stringify(r));if(r.nativeState===state){assert.equal(r.group,group,JSON.stringify(r));assert.equal(r.word,word,JSON.stringify(r));}}
   fs.appendFileSync(path.join(out,'parity-samples.jsonl'),JSON.stringify({theme,collapsed,label,state,group,samples})+'\n');
  });
  await page.evaluate(()=>window.sidebarParityObserver.disconnect());await page.locator('#session-list').evaluate(e=>e.scrollTop=0);await page.mouse.move(1200,5);await settle();await page.screenshot({path:path.join(out,'parity-'+theme+'-'+(collapsed?'collapsed':'expanded')+'.png')});
 }
 await rail(true);
}
const cleanup=scratch.cleanup(async()=>{if(app)await app.close();client?.close();if(child?.connected)child.disconnect();if(child&&child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');});
(async()=>{
 try{fs.mkdirSync(slot);}catch(e){if(e.code==='EEXIST'){console.log('OCCUPIED: no launch/profile');process.exitCode=75;return;}throw e;}
 lease=true;fs.writeFileSync(path.join(slot,'owner.json'),JSON.stringify({owner:'collapsed-sidebar test',task:plan.task,token,pid:process.pid}));fs.mkdirSync(out,{recursive:true});let counters;
 try{await launch();await behaviour();await routes();counters=await fixture('inspect');await check('zero sends, native inputs, page errors and OS dialogs',async()=>{assert.deepEqual(counters.sends,[]);assert.deepEqual(counters.inputs,[]);assert.deepEqual(errors,[]);assert.deepEqual(await app.evaluate(()=>globalThis.hoverGuards),[]);});if(failures.length)process.exitCode=1;}
 catch(e){failures.push({error:e.stack});console.error(e.stack);process.exitCode=1;if(page&&!page.isClosed())await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});}
 finally{await cleanup();assert.equal(JSON.parse(fs.readFileSync(path.join(slot,'owner.json'))).token,token);fs.unlinkSync(path.join(slot,'owner.json'));fs.rmdirSync(slot);const result={checks,failures,errors,sends:counters?.sends?.length??null,inputs:counters?.inputs?.length??null,modelCalls:0,profileRemoved:!profile||!fs.existsSync(profile),slotReleased:true};fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({pass:checks.length,fail:failures.length,profileRemoved:result.profileRemoved,slotReleased:true}));}
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
