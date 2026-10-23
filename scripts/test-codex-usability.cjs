const { chooseRecipient, roomBody } = require('./room-input.cjs');
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
  app = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
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
  await fixture('history', a, [
    { id:'user-short',type:'userMessage',turnId:'old',content:[{type:'text',text:'h'}] },
    { id:'reply-short',type:'agentMessage',turnId:'old',text:'你好！有什么我能帮你？' },
    { id:'reply-code',type:'agentMessage',turnId:'code',text:'第一段。\n\n第二段。\n\n'+String.fromCharCode(96).repeat(3)+'js\nconst n = 1;\n'+String.fromCharCode(96).repeat(3) }
  ]);
  await page.locator('#messages .message-body p').first().waitFor();
  await require('./check-theme.cjs').checkTheme(page);
  const geometry=[];
  for(const scheme of ['light','dark']) {
    await page.emulateMedia({colorScheme:scheme}); await page.waitForFunction(dark=>document.body.hasAttribute('data-ds-dark-theme')===dark,scheme==='dark');
    const values=await page.evaluate(()=>{
      const u=document.querySelector('#messages .user'), a=document.querySelector('#messages .assistant');
      const ub=u.querySelector('.message-body'), ab=a.querySelector('.message-body');
      return {humanHeight:u.getBoundingClientRect().height,humanMargin:parseFloat(getComputedStyle(u).marginBottom),agentHeight:a.getBoundingClientRect().height,humanBackground:getComputedStyle(ub).backgroundColor,agentBackground:getComputedStyle(ab).backgroundColor,humanBorder:parseFloat(getComputedStyle(ub).borderLeftWidth),heading:u.querySelector('.message-heading').getBoundingClientRect().top,actions:u.querySelector('.message-actions').getBoundingClientRect().top};
    });
    assert.ok(values.humanHeight+values.humanMargin<90,'Short human message fits compact reader'); assert.ok(values.agentHeight<65);
    assert.notEqual(values.humanBackground,values.agentBackground);assert.ok(values.humanBorder>=2);assert.ok(Math.abs(values.heading-values.actions)<8);
    geometry.push({scheme,...values}); await capture('codex-compact-'+scheme);
  }
  const code=page.locator('#messages [data-message-id="reply-code"]');
  assert.match(await code.locator('pre').innerText(),/const n = 1;/);
  await code.locator('.message-actions').getByRole('button',{name:'复制',exact:true}).click();
  assert.match(await app.evaluate(()=>globalThis.copiedText.at(-1)),/第一段。\n\n第二段。/);
  await page.getByRole('button',{name:'加入协作',exact:true}).click();
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
  console.log(JSON.stringify({geometry,checks:['Compact light/dark human and agent distinction; exact Markdown/code Copy','Inline keyboard mention, no separate selector; choose does not send','Native textarea Undo/Redo revokes identity while retaining prior text','Body edits, app composition Enter guard, reopen and same-text replacement','Same-name IDs, rename and departure retain drafts and require explicit reselect'],dispatches:0,errors,profile},null,2));
}
async function capture(name){if(process.env.NAW_EVIDENCE_DIR){fs.mkdirSync(process.env.NAW_EVIDENCE_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.NAW_EVIDENCE_DIR,name+'.png')});}}
run().catch(async error=>{console.error(error.stack);if(page&&!page.isClosed())await capture('usability-failed');process.exitCode=1}).finally(async()=>{try{if(app)await app.close();if(client){for(const s of(await client.call('initial')).sessions)await client.call('stop',s.id);await client.call('shutdown');client.close()}}finally{if(child.connected)child.disconnect();if(child.exitCode===null)child.kill('SIGTERM')}});
