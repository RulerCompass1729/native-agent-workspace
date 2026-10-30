// Actual isolated source GUI/service. Only native output is synthetic.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
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
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Codex4', task: 'T86 member order', token, pid: process.pid, time: new Date().toISOString() }));
const profile = scratch.directory(path.join(os.tmpdir(), 'naw-member-order-'));
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
  await page.evaluate(() => {
    for (const type of ['dragstart', 'dragover', 'drop', 'dragend']) document.addEventListener(type, event => {
      if (!globalThis.memberOrderDragTrace) return;
      const row = { type, x: event.clientX, y: event.clientY, target: event.target.closest?.('[data-member-id]')?.dataset.memberId,
        types: [...event.dataTransfer.types], id: event.dataTransfer.getData('application/x-native-room-member-order'),
        alt: event.altKey, ctrl: event.ctrlKey, shift: event.shiftKey, meta: event.metaKey, effect: event.dataTransfer.dropEffect, allowed: event.dataTransfer.effectAllowed };
      globalThis.memberOrderDragTrace.push(row); setTimeout(() => { row.prevented = event.defaultPrevented; }, 0);
    }, true);
  });
  await app.evaluate(({ipcMain})=>{
    const original=ipcMain._invokeHandlers.get('workspace:roomMemberOrder');globalThis.orderIpcTrace=[];
    if(original)ipcMain._invokeHandlers.set('workspace:roomMemberOrder',async(event,...args)=>{
      const call={args,started:Date.now()};globalThis.orderIpcTrace.push(call);
      try {const result=await original(event,...args);call.result=result;return result;}
      finally {call.finished=Date.now();}
    });
  });
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
  const copy = host.locator(`[data-message-id="${id}"] .message-actions`).getByRole('button', { name: '复制', exact: true });
  await copy.focus(); await copy.press('Enter');
  await until(async () => await app.evaluate((_, n) => globalThis.pageCopies.length === n + 1 && globalThis.pageCopies.at(-1), before) === text, 'One fresh original copy receipt');
}
async function run() {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Own fixture started'); await launch();
  const ownedRoot = fs.realpathSync(profile), defaultWorkspace = fs.realpathSync((await snapshot()).defaultWorkspace);
  assert.ok(defaultWorkspace.startsWith(ownedRoot + path.sep), 'Fixture cwd must be inside the owned profile before creating any automatic sibling workspace');
  const ids = [], labels = ['Order same', 'Order same', 'Order C', 'Order D'];
  for (let i = 0; i < labels.length; i++) {
    const id = await create(labels[i]); ids.push(id);
    await fixture('history', id, Array.from({ length: 24 }, (_, j) => ({ id: `order-${i}-${j}`, type: 'agentMessage', turnId: `turn-${i}`, text: `Original member ${i} paragraph ${j}.\n\nKeep selected source unchanged.` })));
    await page.locator('#message-input').fill('Private unsent order draft ' + i);
    await until(async () => (await snapshot()).sessions.find(s => s.id === id).liveDraft === 'Private unsent order draft ' + i, 'Original draft persisted');
    await page.locator('#session-header-more').click(); await page.getByRole('menuitem', { name: '加入协作', exact: true }).click();
  }
  const [a,b,c,d] = ids;
  await page.locator('#room-nav').click();
  let overview = page.locator('#collaboration-overview');
  const header = id => overview.locator(`.collaboration-member-status[data-member-id="${id}"]`), name = id => header(id).locator('.collaboration-member-name');
  const reader = id => overview.locator(`.collaboration-member-reader[data-member-id="${id}"] .messages`);
  const order = target => target.locator('#collaboration-overview .collaboration-member-status').evaluateAll(xs => xs.map(x => x.dataset.memberId));
  const expectOrder = async (target, expected) => until(async () => JSON.stringify(await order(target)) === JSON.stringify(expected), 'Same visible member order');
  const identity = s => s.sessions.map(x => [x.id,x.nativeId,x.owner,x.roomId,x.liveDraft,x.model,x.nativePermissionMode]).sort();
  const { chooseRecipient, fillRoomMessage } = require('./room-input.cjs');
  await chooseRecipient(page,c); await fillRoomMessage(page,'Original shared order draft');
  const original = identity(await snapshot()), shared = await page.locator('#shared-input').inputValue(), recipient = await page.locator('#recipient').inputValue();
  async function deliveryChoices() {
    await page.locator('#shared-input').fill('@'); await page.locator('#mention-list').waitFor();
    const mentions = await page.locator('#mention-list [data-mention-id]').evaluateAll(xs => xs.map(x => x.dataset.mentionId));
    await page.locator('#shared-input').press('Escape');
    await fillRoomMessage(page, 'Original shared order draft'); await chooseRecipient(page, c);
    await page.locator('#room-advanced > summary').click(); await page.locator('#run-button').click();
    const preview = await page.locator('#run-participants [data-run-member]').evaluateAll(xs => xs.map(x => [x.dataset.runMember, x.checked, x.disabled]));
    const sequence = await page.locator('#run-order').innerText(); await page.locator('#cancel-run').click();
    return { mentions, preview, sequence, recipient: await page.locator('#recipient').inputValue() };
  }
  const deliveryBefore = await deliveryChoices();
  const initialCalls = await fixture('stats');
  await page.evaluate(() => { globalThis.orderOriginalNodes = [...document.querySelectorAll('.collaboration-member-reader')].map(r => [r,r.querySelector('.messages')]); });
  await reader(a).hover(); await page.mouse.wheel(0,-180);
  await until(() => reader(a).evaluate(el => el.scrollHeight-el.clientHeight-el.scrollTop>80),'Old original text is in view');
  await delay(120); const anchor = await readingAnchor(reader(a));
  await reader(a).evaluate(el => { const box=el.getBoundingClientRect(); const body=[...el.querySelectorAll('.message-body')].find(x => x.getBoundingClientRect().bottom>box.top); const r=document.createRange();r.selectNodeContents(body);getSelection().removeAllRanges();getSelection().addRange(r); });
  const selected = await page.evaluate(() => getSelection().toString()); assert.ok(selected.includes('Original member 0'));
  const source = await name(a).boundingBox(), dest = await header(c).boundingBox();
  await page.mouse.move(source.x+source.width/2,source.y+source.height/2); await page.mouse.down();
  await page.mouse.move(source.x+source.width/2+12,source.y+source.height/2,{steps:5});
  await page.mouse.move(dest.x+dest.width-10,dest.y+dest.height/2,{steps:15});
  await page.mouse.move(dest.x+dest.width-9,dest.y+dest.height/2);
  await until(() => header(c).evaluate(el => el.classList.contains('member-order-after')),'Visible insertion marker before a real header drop');
  await capture('01-real-drag-insertion'); await page.mouse.up();
  await expectOrder(page,[b,c,a,d]);
  assert.equal(await page.evaluate(()=>globalThis.orderOriginalNodes.every(([r,m])=>r.isConnected&&r.querySelector('.messages')===m)),true);
  assert.equal(await page.evaluate(() => getSelection().toString()),selected,'Original selected text survives reordering around its retained member');
  const afterAnchor=await readingAnchor(reader(a)); assert.equal(afterAnchor.id,anchor.id); assert.ok(Math.abs(afterAnchor.offset-anchor.offset)<=2);
  assert.deepEqual(identity(await snapshot()),original); assert.equal(await page.locator('#shared-input').inputValue(),shared); assert.equal(await page.locator('#recipient').inputValue(),recipient);
  await capture('02-grid-reordered'); check('A real header drag displays its insertion target and reorders Grid without changing original selection, reading anchor, drafts, recipient or native identities');
  await page.getByRole('button',{name:'列表',exact:true}).click(); await expectOrder(page,[b,c,a,d]);
  async function pointerAfter(id,target,axis,shot) {
    await page.evaluate(()=>{globalThis.memberOrderDragTrace=[];});
    await name(id).hover();
    assert.equal(await name(id).getAttribute('draggable'),'true');
    const from=await name(id).boundingBox(),to=await header(target).boundingBox();
    assert.equal(await page.evaluate(([x,y])=>document.elementFromPoint(x,y)?.closest('.collaboration-member-status')?.dataset.memberId,[from.x+from.width/2,from.y+from.height/2]),id,'The drag starts on the exact ready member handle');
    const x=axis==='x'?to.x+to.width-9:to.x+to.width/2,y=axis==='x'?to.y+to.height/2:to.y+to.height-3;
    await page.mouse.move(from.x+from.width/2,from.y+from.height/2);await page.mouse.down();await page.mouse.move(from.x+from.width/2+12,from.y+from.height/2,{steps:5});
    await until(()=>page.evaluate(()=>globalThis.memberOrderDragTrace.some(e=>e.type==='dragstart')),'The browser really started the member drag before moving to a target');
    await page.mouse.move(x,y,{steps:15});await page.mouse.move(x+1,y);
    const unit=header(target).locator('..'),marker=axis==='y'?unit:header(target);
    await until(()=>marker.evaluate(el=>el.classList.contains('member-order-after')),'Actual pointer insertion target');
    const geometry=await marker.evaluate(el=>({axis:el.dataset.orderAxis,box:el.getBoundingClientRect().toJSON(),barBottom:getComputedStyle(el,'::before').bottom,barHeight:getComputedStyle(el,'::before').height,captionBottom:getComputedStyle(el,'::after').bottom,z:getComputedStyle(el).zIndex}));
    assert.equal(geometry.axis,axis);
    if(axis==='y'){assert.equal(geometry.barBottom,'0px');assert.equal(geometry.barHeight,'5px');assert.equal(geometry.captionBottom,'5px');assert.ok(geometry.box.bottom>(await header(target).boundingBox()).y+(await header(target).boundingBox()).height+10);}
    measurements.push({name:shot,...geometry});await capture(shot);
    await page.mouse.move(x+1,y);
    const hit=await page.evaluate(([x,y])=>document.elementFromPoint(x,y)?.closest('[data-member-id]')?.dataset.memberId,[x+1,y]);
    assert.equal(hit,target,'The exact member remains under the pointer immediately before release');
    measurements.push({name:shot+'-hit-before-drop',hit});
    await page.mouse.up();
    measurements.push({name:shot+'-events',trace:await page.evaluate(()=>globalThis.memberOrderDragTrace)});
  }
  await pointerAfter(d,c,'y','02b-list-whole-row-marker');await expectOrder(page,[b,c,d,a]);
  await name(d).focus();await name(d).press('Alt+ArrowDown');await expectOrder(page,[b,c,a,d]);
  await name(a).focus(); await name(a).press('Alt+ArrowUp'); await expectOrder(page,[b,a,c,d]);
  assert.equal(await name(a).evaluate(el=>document.activeElement===el),true);
  await until(()=>overview.locator('.collaboration-order-status').innerText().then(s=>s.includes('第 2')&&s.includes('4')),'Accessible position update');
  await name(a).press('Alt+ArrowDown'); await expectOrder(page,[b,c,a,d]);
  await page.getByRole('button',{name:'网格',exact:true}).click(); await expectOrder(page,[b,c,a,d]);
  const menuRead=await watchMovingMember(page,a),menuSelection=await page.evaluate(()=>getSelection().toString());
  assert.notEqual(menuRead.anchor.id,afterAnchor.id,'A new wheel scroll changed the original paragraph after the previous move');
  await header(a).locator('.collaboration-member-more').click(); await page.getByRole('menuitem',{name:'上移',exact:true}).click(); await expectOrder(page,[b,a,c,d]);
  assert.equal(await header(a).locator('.collaboration-member-more').evaluate(el=>document.activeElement===el),true);
  const menuAfter=await readingAnchor(reader(a)),menuScroll=await reader(a).evaluate(el=>el.scrollTop);
  assert.equal(menuAfter.id,menuRead.anchor.id);assert.ok(Math.abs(menuAfter.offset-menuRead.anchor.offset)<=2);assert.ok(Math.abs(menuScroll-menuRead.scroll)<=2);
  const menuRemoved=await page.evaluate(()=>{globalThis.memberMoveProbe.observer.disconnect();return globalThis.memberMoveProbe.removed;});assert.ok(menuRemoved.includes(a));
  measurements.push({name:'menu-fresh-reading-moved-earlier',before:menuRead,after:menuAfter,scrollAfter:menuScroll,removed:menuRemoved});
  await header(a).locator('.collaboration-member-more').click(); await capture('03b-existing-menu-order'); await page.getByRole('menuitem',{name:'下移',exact:true}).click(); await expectOrder(page,[b,c,a,d]);
  assert.equal(await page.evaluate(()=>getSelection().toString()),menuSelection);
  assert.ok((await name(a).getAttribute('aria-description')).includes('第 3 位')); assert.equal(await name(a).getAttribute('aria-keyshortcuts'),'Alt+ArrowUp Alt+ArrowDown');
  assert.deepEqual(await deliveryChoices(), deliveryBefore, 'Presentation order cannot alter mention options or the explicitly previewed run participants/order');
  const boundary = fs.readFileSync(path.join(profile, 'room-state.json'), 'utf8');
  await name(b).focus(); await name(b).press('Alt+ArrowUp'); assert.equal(fs.readFileSync(path.join(profile, 'room-state.json'), 'utf8'), boundary);
  await capture('03-keyboard-order'); check('Grid and List share one order; Alt arrows keep the original name focused and announce its new position');
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(850,600));
  await delay(160);
  if(await page.locator('.naw[data-native-surface="sidebar"]').getAttribute('data-collapsed')==='true')await page.locator('#archive-button').click();
  await until(()=>overview.evaluate(el=>el.clientWidth<=600),'Real expanded sidebar narrows the overview');
  const strip=await overview.locator('.collaboration-member-status').evaluateAll(xs=>xs.map(x=>({id:x.dataset.memberId,top:x.getBoundingClientRect().top})));
  assert.ok(new Set(strip.map(x=>Math.round(x.top))).size>1,'Actual grid status strip wraps');
  await pointerAfter(d,c,'x','03c-wrapped-grid-marker');await expectOrder(page,[b,c,d,a]);
  measurements.push({name:'wrapped-drop-real-ipc',trace:await app.evaluate(()=>globalThis.orderIpcTrace)});
  await name(d).focus();await name(d).press('Alt+ArrowDown');await expectOrder(page,[b,c,a,d]);
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1240,850));
  const windowPromise=app.waitForEvent('window'); await page.evaluate(()=>workspace.newWindow()); const other=await windowPromise; other.setDefaultTimeout(10000); await other.locator('#room-nav').click(); await expectOrder(other,[b,c,a,d]);
  async function watchMovingMember(target,id) {
    const r=target.locator(`.collaboration-member-reader[data-member-id="${id}"] .messages`),n=target.locator(`.collaboration-member-status[data-member-id="${id}"] .collaboration-member-name`);
    await n.focus();await r.hover();await target.mouse.wheel(0,-160);await delay(120);
    await r.evaluate(el=>{const box=el.getBoundingClientRect(),body=[...el.querySelectorAll('.message-body')].find(n=>n.getBoundingClientRect().bottom>box.top);const range=document.createRange();range.selectNodeContents(body);getSelection().removeAllRanges();getSelection().addRange(range);});
    await target.evaluate(()=>{globalThis.memberMoveProbe={removed:[],observer:new MutationObserver(records=>{for(const r of records)for(const n of r.removedNodes)if(n.dataset?.memberId)globalThis.memberMoveProbe.removed.push(n.dataset.memberId);})};globalThis.memberMoveProbe.observer.observe(document.querySelector('.collaboration-readers'),{childList:true});});
    return {selection:await target.evaluate(()=>getSelection().toString()),anchor:await readingAnchor(r),scroll:await r.evaluate(el=>el.scrollTop)};
  }
  const actorMover=await watchMovingMember(page,a),receiverMover=await watchMovingMember(other,a);
  await name(a).press('Alt+ArrowUp');await expectOrder(page,[b,a,c,d]);await expectOrder(other,[b,a,c,d]);
  for(const [target,before] of [[page,actorMover],[other,receiverMover]]) {
    const r=target.locator(`.collaboration-member-reader[data-member-id="${a}"] .messages`),after=await readingAnchor(r);
    assert.equal(await target.evaluate(()=>getSelection().toString()),before.selection);assert.equal(after.id,before.anchor.id);assert.ok(Math.abs(after.offset-before.anchor.offset)<=2);assert.ok(Math.abs(await r.evaluate(el=>el.scrollTop)-before.scroll)<=2);
    assert.equal(await target.locator(`.collaboration-member-status[data-member-id="${a}"] .collaboration-member-name`).evaluate(el=>document.activeElement===el),true);
    const moved=await target.evaluate(()=>{globalThis.memberMoveProbe.observer.disconnect();return globalThis.memberMoveProbe.removed;});assert.ok(moved.includes(a),'The observed reader DOM node itself was removed and reinserted earlier');
    measurements.push({name:target===page?'actor-actual-mover':'receiver-actual-mover',before,after,removed:moved});
  }
  await capture('03d-observed-member-moved-earlier');
  await name(a).press('Alt+ArrowDown');await expectOrder(page,[b,c,a,d]);await expectOrder(other,[b,c,a,d]);
  await name(a).press('Alt+ArrowDown');await expectOrder(page,[b,c,d,a]);await expectOrder(other,[b,c,d,a]);
  const finalCalls=await fixture('stats'); assert.deepEqual(finalCalls.overviewCalls,initialCalls.overviewCalls,'Presentation reorder has no native/session or membership actions');
  assert.equal(finalCalls.stats.sends,0); assert.equal((await snapshot()).diagnostics.dispatches,0); assert.deepEqual(errors,[]);
  await other.close(); await app.close(); await launch(); overview=page.locator('#collaboration-overview'); await page.locator('#room-nav').click(); await expectOrder(page,[b,c,d,a]);
  assert.deepEqual(identity(await snapshot()),original); assert.equal(await page.locator('#shared-input').inputValue(),shared); assert.equal(await page.locator('#recipient').inputValue(),recipient);
  const saved=JSON.parse(fs.readFileSync(path.join(profile,'room-state.json'),'utf8')); assert.deepEqual(saved.memberOrder,[b,c,d,a]);
  await capture('04-reopened-order'); check('The actual second window updates and a fresh main process reloads the same private order without native or membership actions');
  await assert.rejects(()=>page.evaluate(async id=>workspace.roomMemberOrder({id,target:'missing-member',after:true}),a));
  assert.deepEqual(await order(page),[b,c,d,a]);
  assert.equal(await page.evaluate(()=>globalThis.orderOriginalNodes?.every(([r,m])=>r.isConnected&&r.querySelector('.messages')===m)),undefined,'Fresh GUI intentionally has a fresh DOM');
  measurements.push({name:'final',order:await order(page),memberOrder:saved.memberOrder,before:initialCalls.overviewCalls,afterReorder:finalCalls.overviewCalls,identities:identity(await snapshot())});
  check('Invalid relative moves are rejected by the original authenticated Main handler with the saved order unchanged');
  const beforeFailure=fs.readFileSync(path.join(profile,'room-state.json'),'utf8');
  await app.evaluate((_,profile)=>{const fs=process.getBuiltinModule('fs'),path=process.getBuiltinModule('path'),rename=fs.renameSync; globalThis.restoreOrderRename=()=>{fs.renameSync=rename;};fs.renameSync=function(from,to){if(path.basename(to)==='room-state.json'&&fs.realpathSync(path.dirname(to))===fs.realpathSync(profile))throw Error('Synthetic order save failure');return rename.apply(this,arguments);};},profile);
  try { await name(b).focus(); await name(b).press('Alt+ArrowDown'); await until(()=>page.locator('.collaboration-order-status').innerText().then(s=>s.includes('未能保存')),'Failure is announced'); assert.ok((await page.locator('#toast-text').innerText()).includes('未能保存')); }
  finally { await app.evaluate(()=>globalThis.restoreOrderRename()); }
  assert.equal(fs.readFileSync(path.join(profile,'room-state.json'),'utf8'),beforeFailure); await expectOrder(page,[b,c,d,a]);
  check('Actual atomic disk failure announces the failure in the existing notice and live status without a predicted reorder');
  const extra=[];
  for(let i=0;i<4;i++) {const id=await create('Order extra '+i);extra.push(id);await fixture('history',id,Array.from({length:16},(_,j)=>({id:`extra-${i}-${j}`,type:'agentMessage',turnId:`extra-${i}`,text:`Extra member ${i} original ${j}`})));await page.locator('#session-header-more').click();await page.getByRole('menuitem',{name:'加入协作',exact:true}).click();}
  await page.locator('#room-nav').click(); await page.getByRole('button',{name:'列表',exact:true}).click();
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(850,600));
  await expectOrder(page,[b,c,d,a,...extra]);
  const secondPromise=app.waitForEvent('window');await page.evaluate(()=>workspace.newWindow());const second=await secondPromise;second.setDefaultTimeout(10000);await second.locator('#room-nav').click();await second.getByRole('button',{name:'列表',exact:true}).click();
  await (await app.browserWindow(second)).evaluate(win=>win.setContentSize(850,600));
  assert.deepEqual(await second.evaluate(()=>[innerWidth,innerHeight]),[850,600]);
  const outer=target=>target.locator('.collaboration-readers');
  await until(()=>outer(second).evaluate(el=>el.scrollHeight>el.clientHeight+80),'Eight member list really scrolls');
  await outer(second).evaluate((el,id)=>{const row=[...el.children].find(n=>n.dataset.memberId===id);el.scrollTop+=row.getBoundingClientRect().top-el.getBoundingClientRect().top+1;},c);
  const outerAnchor=target=>outer(target).evaluate(el=>{const top=el.getBoundingClientRect().top;const n=[...el.children].find(n=>n.getBoundingClientRect().bottom>top);return {id:n?.dataset.memberId,offset:n?.getBoundingClientRect().top-top,top:el.scrollTop};});
  const receiverBefore=await outerAnchor(second); assert.equal(receiverBefore.id,c);
  const visibleBody=second.locator(`.collaboration-member-reader[data-member-id="${c}"] .message-body`).last();
  await visibleBody.evaluate(el=>{const r=document.createRange();r.selectNodeContents(el);getSelection().removeAllRanges();getSelection().addRange(r);});
  const receiverSelection=await second.evaluate(()=>getSelection().toString());
  const beforeList=await fixture('stats'); await name(b).focus();const actorBefore=await outerAnchor(page);
  await name(b).press('Alt+ArrowDown');await expectOrder(page,[c,b,d,a,...extra]);await expectOrder(second,[c,b,d,a,...extra]);
  const receiverAfter=await outerAnchor(second),actorAfter=await outerAnchor(page);
  assert.equal(receiverAfter.id,receiverBefore.id);assert.ok(Math.abs(receiverAfter.offset-receiverBefore.offset)<=2);assert.equal(actorAfter.id,actorBefore.id);assert.ok(Math.abs(actorAfter.offset-actorBefore.offset)<=2);
  assert.equal(await second.evaluate(()=>getSelection().toString()),receiverSelection);assert.deepEqual((await fixture('stats')).overviewCalls,beforeList.overviewCalls);
  measurements.push({name:'eight-list-anchors',receiverBefore,receiverAfter,actorBefore,actorAfter});await capture('05-eight-member-list-anchors');await second.close();
  check('Eight-member List preserves the outer reading anchor and original selection in both the keyboard actor and the receiving window');
  const complete=await fixture('stats'); assert.equal(complete.stats.sends,0); assert.equal((await snapshot()).diagnostics.dispatches,0); assert.deepEqual(errors,[]);
  assert.ok((await snapshot()).sessions.every(s => fs.realpathSync(s.cwd).startsWith(ownedRoot + path.sep)), 'Every created working folder stays inside the owned profile');
  measurements.push({name:'complete-native-actions',stats:complete.stats,calls:complete.overviewCalls});
}
run().catch(async error => {
  console.error(error.stack); process.exitCode=1; failure=error.stack;
  if(evidence&&page&&!page.isClosed()) {await capture('failure'); fs.writeFileSync(path.join(evidence,'failure-details.json'),JSON.stringify({error:error.stack,view:(await snapshot()).viewState,room:(await snapshot()).room,stats:await fixture('stats'),dragTrace:await page.evaluate(()=>globalThis.memberOrderDragTrace),ipcTrace:await app.evaluate(()=>globalThis.orderIpcTrace)},null,2));}
}).finally(async()=>{
  try {
    if(evidence)fs.writeFileSync(path.join(evidence,'member-order-result.json'),JSON.stringify({flowPassed:!failure,failure,checks,errors,measurements,profile,token},null,2));
    await scratch.release(); const owner=JSON.parse(fs.readFileSync(path.join(slot,'owner.json'))); assert.equal(owner.token,token);fs.unlinkSync(path.join(slot,'owner.json'));fs.rmdirSync(slot);
    if(evidence)fs.writeFileSync(path.join(evidence,'released.json'),JSON.stringify({profile,token,profileExists:fs.existsSync(profile),time:new Date().toISOString()},null,2));
    console.log('Owned fixture cleaned; GUI slot released.');
  }catch(e){console.error('Cleanup not confirmed; owned lock retained:',e.stack);process.exitCode=1;}
});
