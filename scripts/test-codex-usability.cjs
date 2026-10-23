const { chooseRecipient, fillRoomMessage, roomBody } = require('./room-input.cjs');
// Real hidden Electron/DSH UI and service; synthetic history/output, no models.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const { fork, execFileSync } = require('node:child_process');
const { _electron } = require('playwright');
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const { connect } = require(path.join(code, 'app/service-client.cjs'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-reading-profile-'));
const child = fork(path.join(code, 'app/daemon.cjs'), [profile], { execArgv: ['--require', path.join(__dirname, 'fixtures/loading-terminal.cjs')], env: { ...process.env, NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_WORKSPACE: profile, NAW_TEST_APP_ROOT: code }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
const delay = ms => new Promise(r => setTimeout(r, ms));
let app, page, client, sequence = 0;
const observations = [], errors = [], resources = [];
async function until(fn, label) { for (let i = 0; i < 200; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
function fixture(method, target, value) { const id = ++sequence; return new Promise((resolve, reject) => {
  const cb = result => { if (result.requestId === id) { clearTimeout(timer); child.off('message', cb); resolve(result); } };
  const timer = setTimeout(() => { child.off('message', cb); reject(Error('Fixture timeout')); }, 10000);
  child.on('message', cb); child.send({ id, method, target, value });
}); }
const snapshot = () => page.evaluate(() => workspace.initial());
async function launch() {
  app = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root], ...(process.env.NAW_VIDEO_DIR?{recordVideo:{dir:process.env.NAW_VIDEO_DIR,size:{width:1280,height:900}}}:{}), env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#new-session').waitFor();
  // Capture app Copy payloads without touching the person's active clipboard.
  await app.evaluate(({ clipboard }) => { globalThis.copiedText = []; clipboard.writeText = text => globalThis.copiedText.push(text); });
}
async function create(name) {
  await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="codex"]').check();
  await page.locator('#initial-view').selectOption('chat'); await page.locator('#session-name').fill(name); await page.locator('#confirm-create').click();
  await until(async () => (await snapshot()).sessions.some(s => s.name === name && s.state === 'idle'), 'Created');
  return (await snapshot()).sessions.find(s => s.name === name).id;
}
async function run() {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Service'); client = await connect(profile, 'codex-usability'); await launch();
  const a = await create('Codex A');
  const completedAt = Math.floor(Date.now()/1000) - 30;
  await fixture('history', a, {items:[
    { id:'user-short',type:'userMessage',turnId:'old',content:[{type:'text',text:'h'}] },
    { id:'reply-short',type:'agentMessage',turnId:'old',text:'你好！有什么我能帮你？' },
    { id:'reply-code',type:'agentMessage',turnId:'code',text:'第一段。\n\n第二段。\n\n'+String.fromCharCode(96).repeat(3)+'js\nconst n = 1;\n'+String.fromCharCode(96).repeat(3) },
    { id:'search-one',type:'webSearch',turnId:'code',query:'Seattle forecast',action:{type:'search',query:'Seattle forecast',queries:null},results:[{title:'Weather result',snippet:'Exact native result, retained in full.'}] },
    { id:'reason-one',type:'reasoning',turnId:'code',summary:['原生摘要第一段。','原生摘要第二段。'] },
    { id:'command-one',type:'commandExecution',turnId:'code',command:'check-document',aggregatedOutput:'line one\nline two\nline three\nline four\nline five',status:'completed' }
  ],turns:[{id:'old',status:'completed',completedAt,durationMs:2300},{id:'code',status:'completed',completedAt:completedAt+5,durationMs:5000}]});
  await page.locator('#messages .message-body p').first().waitFor();
  await require('./check-theme.cjs').checkTheme(page);
  const geometry=[];
  for(const scheme of ['light','dark']) {
    await page.emulateMedia({colorScheme:scheme}); await page.waitForFunction(dark=>document.body.hasAttribute('data-ds-dark-theme')===dark,scheme==='dark');
    const values=await page.evaluate(()=>{
      const u=document.querySelector('#messages .user'), a=document.querySelector('#messages .assistant');
      const ub=u.querySelector('.message-body'), ab=a.querySelector('.message-body');
      return {humanHeight:u.getBoundingClientRect().height,humanWidth:u.getBoundingClientRect().width,readerWidth:u.parentElement.clientWidth,humanMargin:parseFloat(getComputedStyle(u).marginBottom),agentHeight:a.getBoundingClientRect().height,humanBackground:getComputedStyle(ub).backgroundColor,agentBackground:getComputedStyle(ab).backgroundColor,actionsOpacity:getComputedStyle(u.querySelector('.message-actions')).opacity};
    });
    assert.ok(values.humanHeight+values.humanMargin<90,'Short human message fits compact reader'); assert.ok(values.agentHeight<65);
    assert.notEqual(values.humanBackground,values.agentBackground);assert.ok(values.humanWidth<values.readerWidth/2,'Short messages use their content width');
    geometry.push({scheme,...values}); await capture('codex-compact-'+scheme);
  }
  const code=page.locator('#messages [data-message-id="reply-code"]');
  assert.match(await code.locator('pre').innerText(),/const n = 1;/);
  await code.hover(); await code.locator('.message-actions').getByRole('button',{name:'复制',exact:true}).click();
  assert.match(await app.evaluate(()=>globalThis.copiedText.at(-1)),/第一段。\n\n第二段。/);
  const boundary=page.locator('#messages .native-turn').first(); await boundary.waitFor();
  const completion=await boundary.locator('.message-body').innerText(); assert.match(completion,/Worked for 2s/);
  assert.ok(completion.includes(new Date(completedAt*1000).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})));
  await boundary.hover(); await boundary.getByRole('button',{name:'复制',exact:true}).click();
  assert.equal(await app.evaluate(()=>globalThis.copiedText.at(-1)),completion,'Copy includes the displayed native completion metadata');
  // Same-window task: full native originals, compact defaults, focused input only.
  const search = page.locator('#messages .process').filter({hasText:'Seattle forecast'});
  const reasoning = page.locator('#messages .process').filter({hasText:'原生摘要第一段。'});
  const command = page.locator('#messages .process').filter({hasText:'check-document'});
  assert.equal(await search.locator('.process-details').evaluate(el=>el.open),false);
  assert.equal(await reasoning.locator('.process-details').evaluate(el=>el.open),false);
  assert.equal(await command.locator('.process-tail').innerText(),'line three\nline four\nline five');
  await search.locator('.process-details > summary').click();assert.match(await search.locator('.message-body').innerText(),/Exact native result, retained in full/);
  await reasoning.locator('.process-details > summary').focus();await page.keyboard.press('Enter');assert.match(await reasoning.locator('.message-body').innerText(),/原生摘要第二段。/);
  await command.locator('.process-details > summary').click();await command.hover();await command.getByRole('button',{name:'复制',exact:true}).click();assert.equal(await app.evaluate(()=>globalThis.copiedText.at(-1)),'line one\nline two\nline three\nline four\nline five');
  await page.locator('#message-input').fill('终端加载期间仍可编辑的草稿');
  await until(async()=> (await fixture('stats')).pending.includes(a),'Passive same-session native attach');
  await fixture('release',a);await page.locator('#terminal-area .xterm-screen').waitFor();
  assert.equal(await page.locator('#message-input').inputValue(),'终端加载期间仍可编辑的草稿');
  assert.equal(await page.locator('#messages').isVisible(),true);assert.equal(await page.locator('#terminal-area').isVisible(),true);
  const nativeScreen=page.locator('#terminal-area .xterm-screen');
  await nativeScreen.click();await page.keyboard.type('native-only');
  await until(async()=> (await fixture('stats')).inputs.filter(i=>i.id===a).map(i=>i.data).join('').includes('native-only'),'Focused terminal input reaches same session');
  const nativeCount=(await fixture('stats')).inputs.length;
  await page.locator('#message-input').fill('聊天输入不会送进终端');
  await page.locator('#message-input').press('Shift+Enter');
  assert.equal((await fixture('stats')).inputs.length,nativeCount);
  await page.getByRole('button',{name:'加入协作',exact:true}).click();
  await nativeScreen.click();
  const paragraph=code.locator('.message-body p').first();await paragraph.scrollIntoViewIfNeeded();
  const paragraphBox=await paragraph.boundingBox();await page.mouse.click(paragraphBox.x+12,paragraphBox.y+8,{clickCount:3});
  const selectedText=await page.evaluate(()=>window.getSelection().toString());assert.ok(selectedText.includes('第一段。'));
  await page.getByRole('button',{name:'分享选中内容',exact:true}).click();
  await page.locator('#share-dialog').waitFor({state:'visible'});
  assert.equal(await page.locator('#share-text').inputValue(),selectedText,'Reader selection supersedes the terminal input mode');
  await page.locator('#cancel-share').click();
  await page.locator('#terminal-maximize').click();assert.equal(await page.locator('#messages').isVisible(),false);
  await page.locator('#terminal-maximize').click();assert.equal(await page.locator('#messages').isVisible(),true);
  await page.locator('#close-native-terminal').click();await page.locator('#terminal-area').waitFor({state:'hidden'});
  await page.locator('#terminal-tab').click();assert.equal(await page.locator('#terminal-area').isVisible(),true);
  assert.equal(await search.locator('.process-details').evaluate(el=>el.open),true,'Disclosure survives layout changes');
  const originalBounds=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].getBounds());
  for(const height of [850,600]) {
    await app.evaluate(({BrowserWindow},height)=>BrowserWindow.getAllWindows()[0].setSize(850,height),height);
    await page.waitForTimeout(100);
    const fits=await page.locator('#message-input').evaluate(el=>{const input=el.getBoundingClientRect(),pane=document.getElementById('conversation-pane').getBoundingClientRect();return {bottom:input.bottom,paneBottom:pane.bottom,viewport:innerHeight};});
    assert.ok(fits.bottom<=fits.paneBottom+1 && fits.bottom<=fits.viewport,'Narrow-window chat input remains within its visible pane: '+JSON.stringify(fits));
    assert.equal(await page.locator('#terminal-area').isVisible(),true);
  }
  await app.evaluate(({BrowserWindow},bounds)=>BrowserWindow.getAllWindows()[0].setBounds(bounds),originalBounds);
  await page.locator('#message-input').fill('');
  await capture('same-window-native-reader');
  const b=await create('Codex B');await page.getByRole('button',{name:'加入协作',exact:true}).click();
  await page.locator('#room-nav').click();await page.locator('#room-record').click();
  let input=page.locator('#shared-input');
  assert.equal(await page.locator('#mention-button').count(),0);
  await input.fill('正文保留');await input.evaluate(el=>el.setSelectionRange(0,0));await input.pressSequentially('@');
  await page.keyboard.press('Enter');
  assert.equal(await input.inputValue(),'@Codex A 正文保留');assert.equal(await page.locator('#recipient').inputValue(),a);
  assert.equal((await fixture('stats')).sends.length,0,'Choosing a recipient never sends');
  await capture('inline-mention');
  await input.press('ControlOrMeta+z');
  assert.equal(await input.inputValue(),'@正文保留','Native undo returns text before selecting a recipient');
  assert.equal(await page.locator('#recipient').inputValue(),'');assert.equal(await page.locator('#forward-button').isDisabled(),true);
  await input.press('ControlOrMeta+Shift+z');assert.equal(await page.locator('#recipient').inputValue(),'','Redo text does not regain routing authority');
  await input.fill('@no-such-member'); await input.pressSequentially('x');
  assert.equal(await page.locator('#mention-list [role="option"]').count(),0); assert.equal(await input.getAttribute('aria-activedescendant'),null);
  await input.fill('中文输入法正文');await chooseRecipient(page,b);await input.evaluate(el=>el.setSelectionRange(el.value.length,el.value.length));await input.pressSequentially(' continues');
  assert.equal(await page.locator('#recipient').inputValue(),b);
  await input.dispatchEvent('compositionstart');await input.dispatchEvent('keydown',{key:'Enter',isComposing:true,keyCode:229});await input.dispatchEvent('compositionend');
  assert.equal((await fixture('stats')).sends.length,0,'Composing Enter does not dispatch; this is an app IME event check, not a physical OS IME claim');
  const raw=await input.inputValue();await app.close();app=null;await launch();input=page.locator('#shared-input');
  assert.equal(await input.inputValue(),raw);assert.equal(await page.locator('#recipient').inputValue(),b);assert.equal(await roomBody(page),'中文输入法正文 continues');
  await input.fill(raw);assert.equal(await page.locator('#recipient').inputValue(),'','Pasting/replacing identical text does not regain identity');
  assert.equal(await page.locator('#forward-button').isDisabled(),true);
  await input.fill('消息 @literal 保留');await chooseRecipient(page,b);
  await page.evaluate(id=>workspace.rename(id,'新名称'),b);await until(()=>page.locator('#recipient').inputValue().then(v=>v===''),'Rename invalidates obsolete visible address');
  assert.ok((await input.inputValue()).includes('@Codex B'));assert.equal(await page.locator('#forward-button').isDisabled(),true);
  await input.fill('同名检查');await page.evaluate(id=>workspace.rename(id,'同名'),a);await page.evaluate(id=>workspace.rename(id,'同名'),b);await chooseRecipient(page,b);
  assert.ok((await input.inputValue()).includes(b.slice(0,6)),'Same-name address displays stable short identity');
  await page.locator('[data-session-id="'+a+'"]').click();await client.call('join',b,false);
  await page.locator('#chat-tab').click();await page.locator('#room-nav').click();await page.locator('#room-record').click();
  await until(()=>snapshot().then(s=>s.viewState.roomRecipient===''&&s.viewState.roomMention?.active===false),'Departure clears stale address while preserving view saves');
  assert.ok((await input.inputValue()).includes('同名检查'));assert.equal(await page.locator('#forward-button').isDisabled(),true);
  const inactiveDraft = await input.inputValue(); await app.close(); app=null; await launch(); input=page.locator('#shared-input');
  assert.equal(await input.inputValue(), inactiveDraft);
  await input.evaluate(el=>el.setSelectionRange(el.value.length,el.value.length)); await input.pressSequentially(' @');
  assert.equal(await page.locator('#mention-list [data-mention-id]').count(),1,'Open menu initially has only the current member');
  await client.call('join',b,true);
  await until(()=>snapshot().then(s=>s.sessions.find(v=>v.id===b)?.roomId),'Rejoin observed');
  assert.equal(await page.locator('#recipient').inputValue(),'','Rejoin never reauthorizes the inactive address');
  await page.locator('[data-room-session="'+b+'"]').waitFor();
  await page.locator('[data-mention-id="'+b+'"]').click();
  assert.equal((await roomBody(page)).trim(),'同名检查','Product reselect replaces only the trusted inactive range, with no obsolete address in native body');
  assert.equal(await page.locator('#recipient').inputValue(),b);
  assert.equal((await input.inputValue()).match(/@/gu).length,1,'One visible address after changing the recipient');
  assert.equal((await snapshot()).diagnostics.dispatches,0);assert.deepEqual(errors,[]);
  await page.evaluate(async ids=>{await workspace.rename(ids[0],'Codex A');await workspace.rename(ids[1],'Codex B');},[a,b]);
  const beforeTask=await snapshot();
  await page.locator(`[data-room-session="${a}"]`).click();
  assert.equal(await page.locator('#room-messages').isVisible(),true);
  assert.equal(await page.locator('#terminal-area').isVisible(),true);
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(850,600));
  await page.waitForTimeout(100);
  const roomFits=await page.locator('#forward-button').evaluate(el=>({bottom:el.getBoundingClientRect().bottom,paneBottom:document.getElementById('room-record-view').getBoundingClientRect().bottom,viewport:innerHeight}));
  assert.ok(roomFits.bottom<=roomFits.paneBottom+1 && roomFits.bottom<=roomFits.viewport,'Minimum-window shared Send remains visible: '+JSON.stringify(roomFits));
  await app.evaluate(({BrowserWindow},bounds)=>BrowserWindow.getAllWindows()[0].setBounds(bounds),originalBounds);
  await chooseRecipient(page,b);await fillRoomMessage(page,'核对材料：12、18、25，文档声称总额60。');await page.locator('#forward-button').click();
  assert.match(await page.locator('#native-pane-title').innerText(),/Codex A/,'Displaying A does not replace the addressed B');
  assert.equal((await fixture('stats')).sends.at(-1).id,b);
  await fixture('replyBound',b,{turnId:'check-b'});
  await page.locator('#run-status').getByText('Codex B · 正在处理',{exact:false}).waitFor();
  await fixture('nativeBlock',b,{id:'tool:check',kind:'tool',turnId:'check-b',title:'核对数字',input:'12 + 18 + 25',text:'逐项核对\n'.repeat(14),status:'running'});
  let process = page.locator('#room-messages .process').filter({hasText:'核对数字'});
  assert.equal(await process.locator('.process-details').evaluate(el=>el.open),false);
  assert.equal(await process.getAttribute('data-running'),'true');
  await process.locator('.process-details > summary').click();
  await fixture('nativeBlock',b,{id:'tool:check',kind:'tool',turnId:'check-b',title:'核对数字',input:'12 + 18 + 25',text:'逐项核对\n'.repeat(14)+'完整的追加结果',status:'running'});
  assert.equal(await process.locator('.process-details').evaluate(el=>el.open),true);
  await process.getByText('完整的追加结果',{exact:false}).waitFor();
  await process.locator('.process-details > summary').click();
  await page.locator('#room-filter').selectOption(a);
  await fixture('nativeBlock',b,{id:'tool:check',kind:'tool',turnId:'check-b',title:'核对数字',input:'12 + 18 + 25',text:'逐项核对\n'.repeat(14)+'原生失败信息',status:'failed'});
  await page.locator('#room-filter').selectOption('');
  await until(()=>process.locator('.process-details').evaluate(el=>el.open),'Native failure opens a previously collapsed process');
  await process.locator('.process-details > summary').click();
  await app.close();app=null;await launch();
  process = page.locator('#room-messages .process').filter({hasText:'核对数字'});
  assert.equal(await process.locator('.process-details').evaluate(el=>el.open),false,'Explicitly collapsing a known error survives whole-app close');
  await fixture('nativeBlock',b,{id:'tool:check',kind:'tool',turnId:'check-b',title:'核对数字',input:'12 + 18 + 25',text:'逐项核对\n'.repeat(14)+'原生中断信息',status:'interrupted'});
  await until(()=>process.locator('.process-details').evaluate(el=>el.open),'A different native error reopens the record');
  await app.close();app=null;await launch();
  assert.equal(await page.locator('#room-messages .process').filter({hasText:'核对数字'}).locator('.process-details').evaluate(el=>el.open),true,'New error remains open even on immediate whole-app close');
  await capture('shared-native-reader');
  await fixture('nativeBlock',b,{id:'response:check-b',kind:'response',turnId:'check-b',text:'核对中，正在检查材料中的合计。',status:'streaming'});
  await chooseRecipient(page,a);await fillRoomMessage(page,'独立复核这三个数字的合计。');await page.locator('#forward-button').click();
  await fixture('replyBound',a,{turnId:'check-a'});
  await fixture('nativeBlock',a,{id:'response:check-a',kind:'response',turnId:'check-a',text:'逐项复核：12 + 18 + 25 = 55。材料里的60有误。',status:'complete'});
  await fixture('nativeBlock',a,{id:'turn:check-a',kind:'turn',turnId:'check-a',text:'原生本轮已结束',status:'complete',nativeCompletedAt:completedAt*1000,nativeDurationMs:3400});
  await fixture('complete',a,{messageId:'native:synthetic-'+a+':response:check-a',text:'逐项复核：12 + 18 + 25 = 55。材料里的60有误。'});
  await fixture('nativeBlock',b,{id:'response:check-b',kind:'response',turnId:'check-b',text:'已核实，总额应为55，建议将60改为55。',status:'complete'});
  await fixture('nativeBlock',b,{id:'turn:check-b',kind:'turn',turnId:'check-b',text:'原生本轮已结束',status:'complete',nativeCompletedAt:(completedAt+2)*1000,nativeDurationMs:5800});
  await fixture('complete',b,{messageId:'native:synthetic-'+b+':response:check-b',text:'已核实，总额应为55，建议将60改为55。'});
  await page.locator('#run-status').waitFor({state:'hidden'});
  assert.equal(await page.locator('#run-status').isVisible(),false,'Completed agents do not leave a stale activity label');
  await page.locator('#room-messages').getByText('已核实，总额应为55，建议将60改为55。',{exact:true}).waitFor();
  assert.equal(await page.locator('#room-messages .native-turn').count(),2);
  const publicTask=(await snapshot()).room.messages;
  assert.equal(publicTask.filter(m=>m.sharedStream&&m.role==='assistant').length,2,'Streaming updates stay in their original attributed blocks');
  assert.ok(publicTask.some(m=>m.kind==='tool'&&m.text.split('\n').length>=14),'Collapsed process retains the complete native original');
  await page.locator('#room-messages .message-author').filter({hasText:'Codex A'}).first().click();
  assert.equal(await page.locator('#room-filter').inputValue(),a);await page.locator('#room-filter').selectOption('');
  await page.locator('#room-messages').hover();await page.mouse.wheel(0,2000);
  await capture('shared-short-long-interleaved');
  await page.locator('[data-session-id="'+b+'"]').click();await page.getByRole('button',{name:'脱出协作',exact:true}).click();
  await fixture('nativeBlock',b,{id:'response:private',kind:'response',turnId:'private-b',text:'PRIVATE CONTINUATION',status:'complete'});
  await page.locator('#message-input').fill('私下继续核对的草稿');
  assert.ok(!(await snapshot()).room.messages.some(m=>m.text.includes('PRIVATE CONTINUATION')));
  await app.close();app=null;await launch();
  assert.equal(await page.locator('#message-input').inputValue(),'私下继续核对的草稿');
  const reopened=await snapshot();
  assert.equal(reopened.sessions.find(s=>s.id===b).nativeId,beforeTask.sessions.find(s=>s.id===b).nativeId);
  assert.equal(reopened.sessions.find(s=>s.id===b).roomId,null);
  assert.deepEqual(reopened.room.messages,publicTask);assert.equal(reopened.diagnostics.dispatches,2);
  assert.equal(reopened.sessions.find(s=>s.id===a).messages.filter(m=>m.kind==='turn').length,3);
  await page.locator('#room-nav').click();await page.locator('#room-record').click();
  await chooseRecipient(page,a);await fillRoomMessage(page,'控制场景：开始核查，然后私下接管。');await page.locator('#forward-button').click();
  await fixture('replyBound',a,{turnId:'control-turn'});
  await fixture('nativeBlock',a,{id:'response:control',kind:'response',turnId:'control-turn',text:'共享中的片段',status:'streaming'});
  await page.locator('#run-status').getByText('Codex A · 正在处理',{exact:false}).waitFor();
  await fixture('nativeInput',a,'PRIVATE INTERVENTION');
  await page.locator('#run-status').waitFor({state:'hidden'});
  const privateState=(await snapshot()).sessions.find(s=>s.id===a);
  assert.equal(privateState.nativeActivity.turnId,'control-turn');assert.equal(privateState.sharedActivity,null);
  assert.equal(await page.locator('#run-status').isVisible(),false,'Private intervention retires room phase while the same native turn continues');
  await fixture('nativeBlock',a,{id:'response:control',kind:'response',turnId:'control-turn',text:'PRIVATE AFTER INTERVENTION',status:'complete'});
  assert.ok(!(await snapshot()).room.messages.some(m=>m.text.includes('PRIVATE AFTER INTERVENTION')));
  await fixture('complete',a,{messageId:'native:synthetic-'+a+':response:control',text:'PRIVATE AFTER INTERVENTION'});
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({geometry,checks:['Content-width human messages in light/dark; exact Markdown and native timing Copy','Native search/reasoning collapse by default; commands preview three lines; full original Copy and keyboard expansion','Same-window native/reader focus, layout hide/maximize and actual DOM selected-share source','Fold choices persist during streaming; off-page failure opens; acknowledged error collapse and changed error survive full reopen','Inline mentions/Undo/Redo/composition guard; roster changes and reopen retain drafts','Two attributed agents check a document while displayed A and addressed B remain independent','Member trajectory filter, private departure and whole-app reopening preserve records/identity/draft','Same-turn private intervention hides native phase and freezes shared content'],dispatches:3,providerCalls:0,errors,profile},null,2));
}
async function capture(name){if(process.env.NAW_EVIDENCE_DIR){fs.mkdirSync(process.env.NAW_EVIDENCE_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.NAW_EVIDENCE_DIR,name+'.png')});}}
run().catch(async error=>{console.error(error.stack);if(page&&!page.isClosed())await capture('usability-failed');process.exitCode=1}).finally(async()=>{try{if(app)await app.close();if(client){for(const s of(await client.call('initial')).sessions)await client.call('stop',s.id);await client.call('shutdown');client.close()}}finally{if(child.connected)child.disconnect();if(child.exitCode===null)child.kill('SIGTERM')}});
