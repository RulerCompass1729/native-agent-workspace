// Actual isolated source GUI/service. Only native output is synthetic.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { joinSpace } = require('./fixtures/space-membership.cjs');
const assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const scratch = require('./fixtures/test-scratch.cjs'), { createIn } = require('./fixtures/create-view.cjs');
const { _electron } = scratch.playwright(require('playwright'));
const evidence = process.env.NAW_EVIDENCE_DIR;
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
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Codex6', task: 'T163 compact member header', token, pid: process.pid, time: new Date().toISOString() }));
const profile = scratch.directory(path.join(os.tmpdir(), 'naw-compact-room-'));
const workspacePath = path.join(profile, 'workspace'); fs.mkdirSync(workspacePath, { recursive: true, mode: 0o700 });
const child = scratch.childProcess.fork(path.join(code, 'app/daemon.cjs'), [profile], {
  execArgv: ['--require', path.join(__dirname, 'fixtures/collaboration-overview.cjs')],
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
async function launch() {
  app = await _electron.launch({ executablePath: require('electron'), args: [code], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message)); await page.locator('#new-session').waitFor();
  await app.evaluate(({ clipboard }) => { globalThis.pageCopies = []; clipboard.writeText = text => globalThis.pageCopies.push(text); });
}
async function create(name) {
  const previous = new Set((await snapshot()).sessions.map(s => s.id));
  await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="codex"]').check();
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
  const copy = host.locator(`[data-message-id="${id}"] .message-actions`).getByRole('button', { name: /^复制：/ });
  await copy.focus(); await copy.press('Enter');
  await until(async () => await app.evaluate((_, n) => globalThis.pageCopies.length === n + 1 && globalThis.pageCopies.at(-1), before) === text, 'One fresh original copy receipt');
}
const identity = s => s.sessions.map(x => [x.id,x.nativeId,x.owner,x.roomId,x.liveDraft,x.model,x.nativePermissionMode]).sort();
const sources = ['app/renderer/renderer.js','app/renderer/styles.css','app/renderer/collaboration-overview.js','app/renderer/collaboration-overview.css','app/tests/collaboration-overview.test.cjs','scripts/test-compact-room.cjs','app/dsh/client.js'];
const hashes = () => Object.fromEntries(sources.map(f=>[f,require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(code,f))).digest('hex')]));
const sourceBefore=hashes();
async function sidebar(expanded) {
  if((await page.locator('.naw[data-native-surface=sidebar]').getAttribute('data-collapsed')==='true')===expanded) await page.keyboard.press('Meta+Alt+b');
  await until(async()=>(await page.locator('.naw[data-native-surface=sidebar]').getAttribute('data-collapsed')==='true')===!expanded,'Exact requested sidebar state');
  let previous, stable=0;
  await until(async()=>{const x=(await page.locator('#header').boundingBox()).x;stable=x===previous?stable+1:0;previous=x;return stable>=3&&(expanded?x>=264:x<=56);},'Sidebar animation settled at the requested real width');
}
async function geometry(label) {
  const m=await page.evaluate(()=>{
    const rect=e=>e.getBoundingClientRect().toJSON(),header=document.querySelector('#header'),tabs=document.querySelector('#room-tabs');
    const visible=e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
    return {header:rect(header),tabs:rect(tabs),toolsInHeader:header.contains(tabs)&&header.contains(document.querySelector('.collaboration-toolbar')),
      sidebarCollapsed:document.querySelector('.naw[data-native-surface=sidebar]').dataset.collapsed,viewport:[innerWidth,innerHeight],
      overflow:document.documentElement.scrollWidth>innerWidth,
      controls:[...header.querySelectorAll('button')].filter(visible).map(e=>({text:e.innerText,box:rect(e)})),
      headers:[...document.querySelectorAll('.collaboration-member-status')].map(e=>({text:e.innerText,box:rect(e)})),
      readers:[...document.querySelectorAll('.collaboration-member-reader')].map(rect)};
  });measurements.push({label,...m});return m;
}
async function memberGeometry(label) {
  const value=await page.evaluate(()=>{
    const rect=e=>e.getBoundingClientRect().toJSON(), visible=e=>e?.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
    const parts=['#header','#room-tabs','#session-toolbar'].map(selector=>({selector,element:document.querySelector(selector)})).filter(x=>visible(x.element)).map(x=>({selector:x.selector,box:rect(x.element)}));
    return {parts,chromeHeight:Math.max(...parts.map(x=>x.box.bottom))-Math.min(...parts.map(x=>x.box.top)),reader:rect(document.querySelector('#messages')),
      titleSize:parseFloat(getComputedStyle(document.querySelector('#title')).fontSize),overflow:document.documentElement.scrollWidth>innerWidth,viewport:[innerWidth,innerHeight]};
  });measurements.push({label,...value});return value;
}
// Exercise the real preload state channel for identity/membership invalidation.
// The synthetic snapshot never changes the daemon or adds a fixture capability.
async function displaySnapshot(value) {
  const receipt=randomUUID();
  await page.evaluate(id=>{globalThis.compactStateReceipt='';globalThis.compactStateOff=workspace.onState(next=>{if(next.compactTestReceipt===id)globalThis.compactStateReceipt=id;});},receipt);
  try {
    await (await app.browserWindow(page)).evaluate((win,next)=>win.webContents.send('workspace:state',next),{...value,compactTestReceipt:receipt});
    await until(()=>page.evaluate(id=>globalThis.compactStateReceipt===id,receipt),'The actual preload received the synthetic renderer snapshot');
  } finally { await page.evaluate(()=>{globalThis.compactStateOff();delete globalThis.compactStateOff;delete globalThis.compactStateReceipt;}); }
}
async function interfaceLanguage(value) {
  await page.locator('#setup-button').click();await page.locator('#ui-language').selectOption(value);
  await until(async()=>await page.locator('#ui-language').getAttribute('aria-busy')==='false'&&await page.locator('#setup-title').innerText()===(value==='en'?'Settings':'设置'),'The actual interface language control accepts the requested language');
  assert.equal(await page.locator('#ui-language-status').isHidden(),true,'The interface language is saved without a warning');
  await page.locator('#close-setup').click();await page.locator('#setup-dialog').waitFor({state:'hidden'});
}
async function run() {
  await until(()=>fs.existsSync(path.join(profile,'connection.json')),'Own fixture ready');await launch();
  const ownedRoot=fs.realpathSync(profile);assert.ok(fs.realpathSync((await snapshot()).defaultWorkspace).startsWith(ownedRoot+path.sep),'Containment before automatic directories');
  const ids=[],labels=['Same member','Same member','LongEnglishMemberIdentity'.repeat(3).slice(0,60),'Member D'];
  for(let i=0;i<4;i++){
    const id=await create(labels[i]);ids.push(id);await fixture('history',id,Array.from({length:24},(_,j)=>({id:`compact-${i}-${j}`,type:'agentMessage',turnId:`compact-turn-${i}`,text:`Original member ${i} paragraph ${j}.\n\nKeep selected source unchanged.`})));
    await page.locator('#message-input').fill('Private compact draft '+i);
    await until(async()=>(await snapshot()).sessions.find(s=>s.id===id).liveDraft==='Private compact draft '+i,'Private draft saved');
    await joinSpace(page);
  }
  const [a,b,c,d]=ids,overview=page.locator('#collaboration-overview'),header=id=>overview.locator(`.collaboration-member-status[data-member-id="${id}"]`),name=id=>header(id).locator('.collaboration-member-name'),reader=id=>overview.locator(`.collaboration-member-reader[data-member-id="${id}"] .messages`);
  for (const i of [1,2,3]) await fixture('fleet',a,{event:'thread/started',id:'compact-unknown-'+i,stale:false});
  await page.locator('#room-nav').click();await (await app.browserWindow(page)).evaluate(win=>win.setContentSize(850,600));
  const {chooseRecipient,fillRoomMessage}=require('./room-input.cjs');await chooseRecipient(page,c);await fillRoomMessage(page,'Unsent shared compact draft');
  const original=identity(await snapshot()),shared=await page.locator('#shared-input').inputValue(),recipient=await page.locator('#recipient').inputValue(),beforeCalls=await fixture('stats');
  await page.evaluate(()=>{globalThis.compactOriginalNodes=[...document.querySelectorAll('.collaboration-member-reader')].map(r=>[r,r.querySelector('.messages')]);});
  for(const expanded of [false,true]){
    await sidebar(expanded);
    for(const layout of ['网格','列表']){
      await page.getByRole('button',{name:layout,exact:true}).click();await delay(180);
      const g=await geometry(`${expanded?'expanded':'collapsed'}-${layout}`);
      assert.equal(g.toolsInHeader,true);assert.ok(g.header.height<=100,'Root fixed tools fit two compact rows');assert.equal(g.overflow,false);
      const colors=await page.getByRole('button',{name:layout,exact:true}).evaluate(el=>{const c=getComputedStyle(el);return [c.color,c.backgroundColor];});
      const luminance=color=>{const channels=color.match(/[\d.]+/g).map(Number).slice(0,3).map(n=>{n/=255;return n<=0.04045?n/12.92:((n+0.055)/1.055)**2.4;});return channels.reduce((v,n,i)=>v+n*[0.2126,0.7152,0.0722][i],0);};
      assert.ok((Math.max(...colors.map(luminance))+0.05)/(Math.min(...colors.map(luminance))+0.05)>=4.5,'The selected layout remains readable after entering the nav');
      assert.ok(g.controls.every(x=>x.box.left>=g.header.left-1&&x.box.right<=g.header.right+1&&x.box.bottom<=g.header.bottom+1),'All controls fit the compact header');
      assert.ok(g.headers[0].box.height<=48,'Three unknown children fit the two-line card header');
      assert.ok((await header(a).locator('.collaboration-member-child-compact').innerText()).includes('3 个子任务状态未知')); // T-145 wording
      assert.ok((await header(a).locator('.collaboration-member-child').textContent()).includes('3 项状态未知（部分观察）'));
      if(layout==='列表')assert.ok(g.readers.every(r=>r.height>=22.4),'Four rows retain at least one original 14px text line');
      await capture(`01-${expanded?'expanded':'collapsed'}-${layout==='网格'?'grid':'list'}`);
    }
  }
  check('At 850×600 with the actual sidebar collapsed and expanded, root tools fit two rows and List keeps four readable originals; partial child uncertainty remains visible');
  // T-163: opening a member must leave useful reading space at the same size.
  await name(a).click();
  const status=page.locator('#room-member-status'),statusDialog=page.locator('#room-member-status-dialog'),statusRows=page.locator('#room-member-status-list button[data-room-status-member]');
  const memberTab=id=>page.locator(`#room-member-tabs [data-room-session="${id}"]`),statusRow=id=>page.locator(`#room-member-status-list button[data-room-status-member="${id}"]`);
  const memberOpen=async id=>until(async()=>{const view=(await snapshot()).viewState;return view.selected==='room'&&view.roomSession===id;},'The expected member opens passively');
  await memberOpen(a);
  for(const expanded of [false,true]){
    await sidebar(expanded);await status.focus();
    const member=await memberGeometry(`member850-${expanded?'expanded':'collapsed'}`);
    assert.deepEqual(member.viewport,[850,600]);assert.equal(member.overflow,false);assert.equal(member.titleSize,19,'Compact member title keeps its 19px type');
    assert.ok(member.chromeHeight<=(expanded?190:160),'Header/navigation/view union leaves room for the member transcript');
    assert.ok(member.reader.height>=180,'The original transcript grows substantially beyond the 113px baseline');
    assert.ok(member.parts.every(x=>x.box.left>=0&&x.box.right<=850&&x.box.bottom<=600),'Member chrome stays inside the small window');
    for(const id of ids){
      const short=memberTab(id).locator('.room-member-id');await short.scrollIntoViewIfNeeded();
      assert.ok((await short.innerText()).length>=6,'Every member keeps a visible distinguishing short ID');
      assert.equal(await short.evaluate(el=>parseFloat(getComputedStyle(el).fontSize)),13,'The short ID retains the original member-label size');
      assert.equal(await short.evaluate(el=>{const r=el.getBoundingClientRect(),p=el.closest('button').getBoundingClientRect();return el.clientWidth>=el.scrollWidth&&r.left>=p.left&&r.right<=p.right;}),true,'A short ID is never clipped inside its member tab');
      assert.equal(await memberTab(id).locator('.room-member-name').evaluate(el=>parseFloat(getComputedStyle(el).fontSize)),13);
    }
    assert.notEqual(await memberTab(a).locator('.room-member-id').innerText(),await memberTab(b).locator('.room-member-id').innerText());
    await memberTab(a).scrollIntoViewIfNeeded();await status.focus();await status.press('Enter');await statusDialog.waitFor();
    assert.equal(await statusRows.count(),4);
    const box=await statusDialog.boundingBox();assert.ok(box.x>=0&&box.y>=0&&box.x+box.width<=850&&box.y+box.height<=600,'All member states have a dialog inside the viewport');
    for(let i=0;i<ids.length;i++){
      const row=statusRow(ids[i]);await row.scrollIntoViewIfNeeded();
      const label=await row.locator('.room-member-name').innerText();assert.ok(label.includes(labels[i])&&label.includes('Codex')&&label.includes(await memberTab(ids[i]).locator('.room-member-id').innerText()),'The status row exposes the full name, provider and short ID');
      assert.equal(await row.locator('.room-member-state').evaluate(el=>{const c=getComputedStyle(el);return parseFloat(c.fontSize)===11&&el.scrollWidth<=el.clientWidth+1&&el.scrollHeight<=el.clientHeight+1&&c.textOverflow!=='ellipsis'&&(!c.webkitLineClamp||c.webkitLineClamp==='none');}),true,'Full status wraps without clipping or smaller type');
    }
    assert.ok((await statusRow(a).innerText()).includes('3 个子任务状态未知'),'The entry preserves other members’ complete child uncertainty');
    await capture(`01d-member850-${expanded?'expanded':'collapsed'}-states`);
    await page.keyboard.press('Escape');await statusDialog.waitFor({state:'hidden'});assert.equal(await status.evaluate(el=>document.activeElement===el),true,'Escape restores the status entry focus');
  }
  // Ordinary progress changes update the open list; identity changes invalidate it.
  await status.click();await fixture('state',b,'approval');
  await until(()=>statusRow(b).innerText().then(text=>text.includes('等待确认')),'The open status list updates a member’s current state');
  await fixture('state',b,'idle');await fixture('connection',c,'disconnected');
  await until(()=>statusRow(c).innerText().then(text=>/已断开|连接状态待核对/.test(text)),'An open status list retains explicit disconnect information');
  await fixture('connection',c,'idle');await page.keyboard.press('Escape');
  const pending=await snapshot(),pendingMember=pending.sessions.find(s=>s.id===b);pendingMember.nativeApproval={...(pendingMember.nativeApproval||{}),requests:[{id:'compact-pending-1'},{id:'compact-pending-2'}]};
  await displaySnapshot(pending);
  assert.match(await status.innerText(),/1.*待审批|待审批.*1/,'The entry counts members needing approval, rather than requests');
  await displaySnapshot(await snapshot());await until(()=>status.innerText().then(text=>!text.includes('待审批')),'Zero pending members removes the pending text');
  await status.click();await statusRow(b).click();await memberOpen(b);
  await status.click();await statusRow(b).click();await until(async()=>!(await snapshot()).viewState.roomSession,'Choosing the current member follows its tab back to overview');
  await name(a).click();await memberOpen(a);
  assert.equal(await page.evaluate(()=>globalThis.compactOriginalNodes.every(([r,m])=>r.isConnected&&r.querySelector('.messages')===m)),true,'Passive status navigation retains the existing original readers');
  for(const change of ['native identity','membership']){
    await status.click();const stale=await statusRow(b).elementHandle(),originalState=await snapshot(),next=structuredClone(originalState),record=next.sessions.find(s=>s.id===b);
    if(change==='native identity')record.nativeId='synthetic-replaced-'+b;
    else Object.assign(record,require(path.join(code,'app/collaboration-spaces.cjs')).withMembership(record,'shared',false));
    try {
      await displaySnapshot(next);await stale.evaluate(el=>el.click());await delay(100);
      assert.equal((await snapshot()).viewState.roomSession,a,`A retained status row cannot reopen a member after its ${change} changes`);
    } finally {await stale.dispose();await displaySnapshot(originalState);if(await statusDialog.isVisible())await page.keyboard.press('Escape');}
  }
  await status.click();const staleOutside=await statusRow(b).elementHandle();await page.keyboard.press('Escape');
  await sidebar(true);await page.locator(`[data-session-id="${d}"].session-link`).click();await until(async()=>(await snapshot()).viewState.selected===d,'Actual solo navigation leaves the member context');
  await staleOutside.evaluate(el=>el.click());await delay(100);assert.equal((await snapshot()).viewState.selected,d,'A retained room status row cannot navigate from a solo context');await staleOutside.dispose();
  await page.locator('#room-nav').click();await memberOpen(a);
  await memberTab(c).click();await memberOpen(c);
  const originalRoomName=(await snapshot()).room.name,memberRoomTitle='FocusedMemberWorkspaceTitle'.repeat(3).slice(0,60);
  await page.evaluate(value=>workspace.roomRename(value),memberRoomTitle);await until(()=>page.locator('#title').innerText().then(text=>text===memberRoomTitle),'The focused member still identifies its actual workspace');
  await page.locator('#messages').hover();await page.mouse.wheel(0,-350);await delay(180);
  const memberAnchor=await readingAnchor();assert.ok(memberAnchor&&await page.locator('#messages').evaluate(el=>el.scrollTop>100),'The focused member has an older reading anchor before title reveal');
  const memberAnchorKept=async()=>{const now=await readingAnchor();return now?.id===memberAnchor.id&&Math.abs(now.offset-memberAnchor.offset)<=2;};
  await page.locator('#title').focus();await until(memberAnchorKept,'The old member reading anchor survives title reveal');
  assert.equal(await page.locator('#title').evaluate(el=>el.clientWidth>=el.scrollWidth&&el.clientHeight>=el.scrollHeight),true,'The long workspace title expands fully on focus');
  await page.locator('#title').press('Tab');assert.equal(await page.locator('#subtitle').evaluate(el=>el.contains(document.activeElement)),true,'Keyboard navigation reaches the full member identity');
  const subtitle=page.locator('#subtitle'),focusedRecord=(await snapshot()).sessions.find(s=>s.id===c),focusedShortId=await memberTab(c).locator('.room-member-id').innerText();
  await subtitle.focus();const identityText=await subtitle.innerText();assert.ok(identityText.includes('Codex')&&identityText.includes(focusedShortId)&&(!focusedRecord.model||identityText.includes(focusedRecord.model)),'The original subtitle retains provider, short ID and any recorded model');
  assert.equal(await subtitle.evaluate(el=>el.clientWidth>=el.scrollWidth&&el.clientHeight>=el.scrollHeight),true,'The focused subtitle reveals the complete original identity line');
  await status.focus();await until(memberAnchorKept,'The old member reading anchor survives subtitle reveal and focus return');await page.evaluate(value=>workspace.roomRename(value),originalRoomName);await sidebar(true);
  try {
    await interfaceLanguage('en');await until(()=>status.innerText().then(text=>text==='Member status · 4'),'The actual English member entry updates');await status.focus();
    const englishMember=await memberGeometry('member850-expanded-English');assert.equal(englishMember.overflow,false);assert.ok(englishMember.chromeHeight<=190&&englishMember.reader.height>=180,'Real English labels retain useful member reading space with the sidebar expanded');
    const entryBox=await status.boundingBox();assert.ok(entryBox.x>=0&&entryBox.y>=0&&entryBox.x+entryBox.width<=850&&entryBox.y+entryBox.height<=600,'The English status entry remains visible');
    const strip=page.locator('#room-member-tabs');assert.equal(await strip.isVisible(),true);
    const stripState=await strip.evaluate(el=>({overflow:getComputedStyle(el).overflowX,scrollWidth:el.scrollWidth,clientWidth:el.clientWidth}));
    assert.ok(stripState.scrollWidth<=stripState.clientWidth+1||['auto','scroll'].includes(stripState.overflow),'Any English member-strip overflow is scrollable');
    await memberTab(c).focus();await memberTab(c).press('End');assert.equal(await memberTab(d).evaluate(el=>document.activeElement===el),true,'Keyboard navigation scrolls to the final member without opening it');
    assert.equal(await memberTab(d).evaluate(el=>{const r=el.getBoundingClientRect(),p=el.parentElement.getBoundingClientRect();return r.left>=p.left-2&&r.right<=p.right+2;}),true,'The final English member tab can be completely revealed');
    const englishPending=await snapshot();englishPending.sessions.find(s=>s.id===b).nativeApproval={requests:[{id:'compact-English-pending'}]};
    await displaySnapshot(englishPending);await until(()=>status.innerText().then(text=>text==='Member status · 4 · 1 awaiting approval'),'Off-screen approval stays explicit in the real English entry');
    const englishApproval=await memberGeometry('member850-expanded-English-pending');assert.equal(englishApproval.overflow,false);assert.ok(englishApproval.chromeHeight<=190&&englishApproval.reader.height>=180,'The longer live English approval entry still leaves useful reading space');
    await capture('01f-member850-expanded-English-pending');await displaySnapshot(await snapshot());await until(()=>status.innerText().then(text=>text==='Member status · 4'),'The ordinary English entry is restored');
    await status.click();await statusDialog.waitFor();assert.equal(await statusRows.count(),4);await capture('01e-member850-expanded-English-states');await page.keyboard.press('Escape');
  } finally {if(await statusDialog.isVisible())await page.keyboard.press('Escape');await interfaceLanguage('zh');}
  await until(()=>status.innerText().then(text=>text==='成员状态 · 4'),'Chinese is restored before the original compact-room checks');
  await memberTab(c).click();await until(async()=>!(await snapshot()).viewState.roomSession,'The original overview is restored');
  await page.getByRole('button',{name:'列表',exact:true}).click();
  // A deliberate native identity invalidation may correctly replace that reader.
  // Start the following unchanged-identity reading tests from the restored view.
  await page.evaluate(()=>{globalThis.compactOriginalNodes=[...document.querySelectorAll('.collaboration-member-reader')].map(r=>[r,r.querySelector('.messages')]);});
  assert.deepEqual(identity(await snapshot()),original);assert.equal(await page.locator('#shared-input').inputValue(),shared);assert.equal(await page.locator('#recipient').inputValue(),recipient);
  const memberCalls=await fixture('stats');assert.equal(memberCalls.stats.inputs,0);assert.equal(memberCalls.stats.sends,0);
  for(const key of ['claim','input','send','queue','steer','forward','approve','answer','run','resume'])assert.equal(memberCalls.overviewCalls[key],beforeCalls.overviewCalls[key]);
  check('Focused members at 850×600 keep 19/13/11px type, useful reading space, visible IDs and live full states; keyboard identities and stale rows remain safe without sending, claiming or changing drafts');
  await sidebar(false);await page.getByRole('button',{name:'网格',exact:true}).click();
  const suffixes=await Promise.all([a,b].map(id=>header(id).locator('.collaboration-name-suffix').innerText()));assert.notEqual(suffixes[0],suffixes[1]);
  for(const id of [a,b])assert.equal(await header(id).locator('.collaboration-name-suffix').evaluate(el=>el.clientWidth>=el.scrollWidth&&el.getBoundingClientRect().right<=el.closest('button').getBoundingClientRect().right),true);
  await page.getByRole('button',{name:'列表',exact:true}).click();await reader(a).hover();await page.mouse.wheel(0,-350);await delay(180);
  const anchor=await readingAnchor(reader(a));assert.ok(anchor);
  await reader(a).evaluate(el=>{const top=el.getBoundingClientRect().top,p=[...el.querySelectorAll('.message-body')].find(n=>n.getBoundingClientRect().bottom>top);const r=document.createRange();r.selectNodeContents(p);getSelection().removeAllRanges();getSelection().addRange(r);});
  const selected=await page.evaluate(()=>getSelection().toString());assert.ok(selected.includes('Original member 0'));
  await page.getByRole('button',{name:'简化信息',exact:true}).click();assert.equal(await page.getByRole('button',{name:'简化信息',exact:true}).getAttribute('aria-pressed'),'true');
  await page.getByRole('button',{name:'简化信息',exact:true}).click();assert.equal(await page.evaluate(()=>getSelection().toString()),selected);
  await page.locator('#room-record').click();assert.equal(await page.locator('#room-record').getAttribute('aria-pressed'),'true');
  await page.locator('#room-overview').click();const restored=await readingAnchor(reader(a));assert.equal(restored.id,anchor.id);assert.ok(Math.abs(restored.offset-anchor.offset)<=2);
  await page.getByRole('button',{name:'网格',exact:true}).click();
  await page.locator('#room-overview').focus();await page.keyboard.press('Tab');await name(a).focus();await delay(120);
  assert.equal(await name(a).evaluate(el=>el.matches(':focus-visible')&&el.classList.contains('is-revealed')&&el.querySelector('.collaboration-name-text').scrollWidth<=el.querySelector('.collaboration-name-text').clientWidth),true,'A sighted keyboard user can read the full duplicate name');
  await capture('01c-full-duplicate-name-keyboard');await page.getByRole('button',{name:'列表',exact:true}).click();await name(a).focus();
  const beforeBack=await readingAnchor(reader(a));await name(a).press('Enter');await page.locator('#room-member-tabs [data-room-session="'+a+'"]').click();
  await until(async()=>{const x=await readingAnchor(reader(a));return x?.id===beforeBack.id&&Math.abs(x.offset-beforeBack.offset)<=2;},'Back restores the original source anchor after moving header tools');
  assert.equal(await name(a).evaluate(el=>document.activeElement===el),true);
  assert.equal(await page.evaluate(()=>globalThis.compactOriginalNodes.every(([r,m])=>r.isConnected&&r.querySelector('.messages')===m)),true);
  await copyOriginal(reader(a),'compact-0-23','Original member 0 paragraph 23.\n\nKeep selected source unchanged.');
  check('Duplicate identities remain visible; simplified originals restore selection, records/focus/Back retain readers and anchors, and Copy returns exact source');
  const order=()=>overview.locator('.collaboration-member-status').evaluateAll(xs=>xs.map(x=>x.dataset.memberId));
  await name(c).focus();await name(c).press('Alt+ArrowDown');await until(async()=>JSON.stringify(await order())===JSON.stringify([a,b,d,c]),'Compact List keyboard order');
  await name(c).press('Alt+ArrowUp');await until(async()=>JSON.stringify(await order())===JSON.stringify(ids),'Original order restored');
  await page.getByRole('button',{name:'网格',exact:true}).click();await name(c).hover();
  const from=await name(c).boundingBox(),to=await header(d).boundingBox();
  await page.mouse.move(from.x+from.width/2,from.y+from.height/2);await page.mouse.down();await page.mouse.move(from.x+from.width/2+12,from.y+from.height/2,{steps:5});
  await page.mouse.move(to.x+to.width-8,to.y+to.height/2,{steps:15});await until(()=>header(d).evaluate(el=>el.classList.contains('member-order-after')),'Real compact header drag marker');
  await capture('01b-compact-drag-marker');await page.mouse.move(to.x+to.width-7,to.y+to.height/2);assert.equal(await page.evaluate(([x,y])=>document.elementFromPoint(x,y)?.closest('[data-member-id]')?.dataset.memberId,[to.x+to.width-7,to.y+to.height/2]),d);await page.mouse.up();
  await until(async()=>JSON.stringify(await order())===JSON.stringify([a,b,d,c]),'Real compact header drop');
  await header(c).locator('.collaboration-member-more').click();await page.getByRole('menuitem',{name:'上移',exact:true}).click();await until(async()=>JSON.stringify(await order())===JSON.stringify(ids),'Existing member menu restores order');
  check('Compact headers preserve real pointer insertion/drop, List keyboard ordering and existing menu ordering');
  const more=page.locator('#room-header-more'),items=()=>page.getByRole('menuitem').allTextContents();
  await more.click();const expected=await items();assert.ok(expected.includes('用量')&&expected.includes('共享笔记')&&expected.some(x=>x.includes('agent 自动消息')));
  const menuBox=await page.getByRole('menu').boundingBox(),openerBox=await more.boundingBox();assert.ok(menuBox.x>openerBox.x-350&&menuBox.x+menuBox.width<=850);
  await page.keyboard.press('Escape');assert.equal(await more.evaluate(el=>document.activeElement===el),true);assert.equal(await more.getAttribute('aria-expanded'),'false');
  await more.click();await more.click();assert.equal(await page.getByRole('menuitem').count(),0);
  await sidebar(true);await page.locator('#room-more').click();assert.deepEqual(await items(),expected);await page.keyboard.press('Escape');assert.equal(await page.locator('#room-more').evaluate(el=>document.activeElement===el),true);
  await page.locator('#room-nav').click({button:'right'});assert.deepEqual(await items(),expected);await page.keyboard.press('Escape');
  await sidebar(false);await more.click();await page.keyboard.press('ArrowDown');await page.keyboard.press('Escape');assert.equal(await more.evaluate(el=>document.activeElement===el),true);
  await more.click();await page.keyboard.press('Tab');assert.equal(await page.getByRole('menuitem').count(),0);
  await more.click();await page.getByRole('menuitem',{name:'重命名…',exact:true}).click();await page.locator('#rename-name').fill('Compact workspace');await page.locator('#rename-name').press('Enter');
  await until(async()=>(await snapshot()).room.name==='Compact workspace','Room rename committed');assert.equal(await more.evaluate(el=>document.activeElement===el),true);
  await more.click();await page.getByRole('menuitem',{name:'重命名…',exact:true}).click();await page.locator('#rename-name').press('Escape');assert.equal(await more.evaluate(el=>document.activeElement===el),true);
  await more.click();await page.getByRole('menuitem',{name:'共享笔记',exact:true}).click();await page.locator('#room-notes-text').fill('Original compact room note');await page.locator('#save-notes').click();await until(async()=>(await snapshot()).room.notes==='Original compact room note','Room notes saved');
  await page.locator('#manage-members').click();await page.locator('#close-invite').click();assert.equal(await page.locator('#manage-members').evaluate(el=>document.activeElement===el),true);
  await more.click();await page.getByRole('menuitem',{name:'协作说明',exact:true}).click();assert.ok((await page.locator('#toast-text').innerText()).includes('你决定谁参与'));await page.locator('#toast-close').click();
  check('Header/sidebar/context menus share existing actions and wake controls, toggle cleanly, and restore keyboard focus; rename, notes and Invite remain usable');
  await sidebar(true);await page.locator(`[data-session-id="${d}"].session-link`).click();await page.locator('#room-more').click();await page.getByRole('menuitem',{name:'用量',exact:true}).click();await page.locator('#privacy-dialog').waitFor();
  assert.equal(await page.locator('#privacy-heading').innerText(),'Compact workspace · 用量');assert.equal(await page.locator('[data-usage-session]').count(),4);await page.locator('#close-privacy').click();
  await page.locator('#room-nav').click();await page.getByRole('button',{name:'列表',exact:true}).click();await sidebar(false);
  const longRoom='LongEnglishWorkspaceName'.repeat(3).slice(0,60);await page.evaluate(name=>workspace.roomRename(name),longRoom);await delay(150);
  const anchorsBefore=await Promise.all(ids.map(id=>readingAnchor(reader(id))));await page.locator('#title').focus();await delay(100);assert.equal(await page.locator('#title').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
  await page.locator('#title').press('Tab');await delay(150);const anchorsAfter=await Promise.all(ids.map(id=>readingAnchor(reader(id))));for(let i=0;i<4;i++){assert.equal(anchorsAfter[i]?.id,anchorsBefore[i]?.id);assert.ok(Math.abs(anchorsAfter[i].offset-anchorsBefore[i].offset)<=2);}
  const g=await geometry('long-English-title');assert.equal(g.overflow,false);await capture('02-long-English');
  for(const id of ids){await reader(id).hover();await page.mouse.wheel(0,-400);await until(()=>reader(id).evaluate(el=>el.scrollHeight-el.clientHeight-el.scrollTop>100),'Each reader has an old source anchor');}
  await page.evaluate(name=>workspace.roomRename(name),'测'.repeat(60));await delay(120);
  const wrapBefore=await Promise.all(ids.map(id=>readingAnchor(reader(id)))),normalHeight=(await page.locator('#header').boundingBox()).height;
  const sameAnchors=async()=>{const now=await Promise.all(ids.map(id=>readingAnchor(reader(id))));return now.every((a,i)=>a?.id===wrapBefore[i]?.id&&Math.abs(a.offset-wrapBefore[i].offset)<=2);};
  await page.locator('#title').focus();await until(async()=>(await page.locator('#header').boundingBox()).height>normalHeight+4,'The 60-CJK title actually grows the header');
  await until(sameAnchors,'All four old anchors survive the real title reveal');const wrapped=await geometry('actual-60-CJK-title-reveal');assert.ok(wrapped.header.height>normalHeight+4);await capture('02c-actual-title-reveal');
  await page.locator('#title').press('Tab');await until(sameAnchors,'All four old anchors survive leaving the title reveal');await page.evaluate(name=>workspace.roomRename(name),longRoom);
  // Geometry stress only: this does not implement or claim a translated UI.
  const english=[['#room-overview','Member overview'],['#room-record','Shared history'],['.collaboration-layout-controls button:nth-child(1)','Grid view'],['.collaboration-layout-controls button:nth-child(2)','List view'],['.collaboration-toolbar > button:last-child','Simplify information'],['#manage-members','Invite existing sessions']];
  const originalLabels=await page.evaluate(entries=>entries.map(([selector,text])=>{const el=document.querySelector(selector),old=el.textContent;el.textContent=text;return [selector,old];}),english);
  for(const expanded of [false,true]){await sidebar(expanded);const stress=await geometry(`English-label-stress-${expanded?'expanded':'collapsed'}`);assert.equal(stress.overflow,false);assert.ok(stress.controls.every(x=>x.box.left>=stress.header.left-1&&x.box.right<=stress.header.right+1&&x.box.bottom<=stress.header.bottom+1));await capture(`02b-English-${expanded?'expanded':'collapsed'}`);}
  await page.evaluate(entries=>entries.forEach(([selector,text])=>{document.querySelector(selector).textContent=text;}),originalLabels);
  await fixture('state',b,'approval');await until(()=>header(b).locator('.collaboration-member-state').innerText().then(x=>x.includes('等待确认')),'Approval visible');await fixture('state',b,'idle');
  await fixture('connection',c,'disconnected');await until(()=>header(c).locator('.collaboration-member-state').innerText().then(x=>/已断开|连接状态待核对/.test(x)),'Disconnected remains explicit');await capture('03-exceptions');await fixture('connection',c,'idle');
  assert.deepEqual(identity(await snapshot()),original);assert.equal(await page.locator('#shared-input').inputValue(),shared);assert.equal(await page.locator('#recipient').inputValue(),recipient);
  const afterCalls=await fixture('stats');assert.equal(afterCalls.stats.inputs,0);assert.equal(afterCalls.stats.sends,0);for(const key of ['claim','input','send','queue','steer','forward','approve','answer','run','resume'])assert.equal(afterCalls.overviewCalls[key],beforeCalls.overviewCalls[key]);
  check('Room usage stays room-scoped from a solo view; long English title reveal preserves all anchors; approval and disconnected states remain explicit without native input');
  await more.click();await page.getByRole('menuitem',{name:'归档工作区',exact:true}).click();await page.locator('#welcome').waitFor();
  assert.equal(await page.locator('#header #room-tabs').count(),0);assert.equal(await page.locator('#header .collaboration-toolbar').count(),0);
  await sidebar(true);if(await page.locator('#archive-group-body').isHidden())await page.locator('#archive-button').click();
  await page.getByRole('button',{name:'恢复工作区',exact:true}).click();await page.locator('#room-nav').click();assert.equal(await more.isVisible(),true);
  assert.equal((await geometry('restored-root')).toolsInHeader,true);assert.deepEqual(identity(await snapshot()),original);
  assert.ok((await snapshot()).sessions.every(s=>fs.realpathSync(s.cwd).startsWith(ownedRoot+path.sep)));assert.deepEqual(errors,[]);
  measurements.push({label:'native-actions-before-archive',before:beforeCalls,after:afterCalls,sourceBefore,sourceAfter:hashes()});assert.deepEqual(hashes(),sourceBefore);
  check('Workspace archive returns to welcome without leaked header tools; explicit restore recovers compact root, identities and drafts; all owned working folders are contained');
  // One deliberate synthetic exchange proves the moved human Pause control.
  // No completion is emitted, so there can be only one fixture send and no handoff.
  await fixture('bindSends',a);await chooseRecipient(page,a);await fillRoomMessage(page,'Synthetic compact pause qualification');
  if(!await page.locator('#room-advanced').evaluate(el=>el.open))await page.locator('#room-advanced > summary').click();
  await page.locator('#run-button').click();
  for(const input of await page.locator('#run-participants [data-run-member]').all()){const id=await input.getAttribute('data-run-member');if(!await input.isDisabled())await input.setChecked([a,b].includes(id));}
  await page.locator('#run-limit').selectOption('2');await page.locator('#run-consent').check();await page.locator('#confirm-run').click();
  await until(async()=>(await fixture('stats')).stats.sends===1,'Exactly one deliberately authorized fixture send');
  await until(async()=>await page.locator('#pause-button').isVisible()&&(await page.locator('#run-status').innerText()).includes('0/2'),'The accepted run and its human Pause are visible');
  assert.equal(await page.locator('#pause-button').evaluate(el=>el.closest('#header')!==null),true);
  const runGeometry=await geometry('actual-synthetic-run-with-pause');assert.equal(runGeometry.overflow,false);assert.ok(runGeometry.controls.some(x=>x.text==='暂停交接'));await capture('04-visible-human-pause');
  await page.locator('#pause-button').click();await until(async()=>(await snapshot()).room.run.status==='paused','Existing Pause actually stops further handoff');
  const deliberate=await fixture('stats');assert.equal(deliberate.stats.sends,1);measurements.push({label:'explicit-synthetic-run-and-pause',calls:deliberate.overviewCalls,stats:deliberate.stats,run:(await snapshot()).room.run});
  check('One explicit synthetic exchange keeps the original Pause visible in the header; one click pauses it after exactly one fixture send and no native inference');
  for(const id of ids){await header(id).locator('.collaboration-member-more').click();await page.getByRole('menuitem',{name:'脱出协作',exact:true}).click();await until(async()=>(await snapshot()).sessions.find(s=>s.id===id).roomId===null,'Explicit detach keeps original session');}
  await until(()=>page.locator('#manage-members').evaluate(el=>document.activeElement===el),'Last member removal focuses the still-visible Invite');
  await page.locator('#manage-members').press('Enter');await page.locator(`[data-invite-session="${a}"]`).click();await until(async()=>(await snapshot()).sessions.find(s=>s.id===a).roomId==='shared','Existing Invite rejoins original native session');
  assert.equal(await page.locator('#manage-members').evaluate(el=>document.activeElement===el),true);
  check('Removing the last card returns focus to visible Invite; keyboard Invite rejoins the same original session');
}
run().catch(async error=>{
  failure=error.stack;process.exitCode=1;console.error(error.stack);
  if(evidence&&page&&!page.isClosed()){await capture('failure');fs.writeFileSync(path.join(evidence,'failure-details.json'),JSON.stringify({error:failure,view:(await snapshot()).viewState,room:(await snapshot()).room,stats:await fixture('stats'),buttons:await page.locator('button').evaluateAll(xs=>xs.filter(x=>x.getClientRects().length).map(x=>({id:x.id,text:x.innerText,aria:x.getAttribute('aria-label')})))},null,2));}
}).finally(async()=>{
  try{
    if(evidence)fs.writeFileSync(path.join(evidence,'compact-room-result.json'),JSON.stringify({flowPassed:!failure,failure,checks,errors,measurements,profile,token,sourceBefore,sourceAfter:hashes()},null,2));
    await scratch.release();const owner=JSON.parse(fs.readFileSync(path.join(slot,'owner.json')));assert.equal(owner.token,token);fs.unlinkSync(path.join(slot,'owner.json'));fs.rmdirSync(slot);
    if(evidence)fs.writeFileSync(path.join(evidence,'released.json'),JSON.stringify({profile,token,profileExists:fs.existsSync(profile),time:new Date().toISOString()},null,2));
    console.log('Owned fixture cleaned; GUI slot released.');
  }catch(error){console.error('Cleanup unconfirmed; owned lock retained:',error.stack);process.exitCode=1;}
});
