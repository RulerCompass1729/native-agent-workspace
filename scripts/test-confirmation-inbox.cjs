// Hidden integration check of product confirmation cards; synthetic transport, no DOM/CSS replacement.
const scratch = require('./fixtures/test-scratch.cjs');
const { revealDefaultSpace } = require('./fixtures/default-space.cjs');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { _electron } = scratch.playwright(require('playwright'));
const { connectService } = require('../app/service-connection.cjs');
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const { createSourceEntry } = require('./fixtures/synthetic-source-boot.cjs');
const { execFileSync } = require('node:child_process');
const output = process.env.NAW_EVIDENCE_DIR;
if (!output || !path.isAbsolute(output) || output.startsWith(root + path.sep)) throw Error('Private evidence directory required');
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
const pictures = process.env.NAW_PICTURES_DIR;
if (!pictures || !path.isAbsolute(pictures) || pictures.startsWith(root + path.sep)) throw Error('An explicit private screenshot directory is required');
fs.mkdirSync(pictures, { recursive: true, mode: 0o700 });
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID();
fs.mkdirSync(path.dirname(slot), { recursive: true });
try { fs.mkdirSync(slot); } catch (e) { if (e.code !== 'EEXIST') throw e; console.error('GUI slot occupied'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ token, pid: process.pid, task: 'confirmation inbox verification' }));
let child, client, app, page, helper, sequence = 0; const errors = [], checks = [];
const profile = fs.realpathSync(scratch.directory(path.join(os.tmpdir(), 'naw-confirmation-inbox-')));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { for (let i = 0; i < 200; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
const record = name => { checks.push(name); console.log('PASS', name); };
function checkForeground() {
  const pid = Number(execFileSync('osascript', ['-l', 'JavaScript', '-e',
    "ObjC.import('AppKit'); Number($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier)"], { encoding: 'utf8' }).trim());
  assert.ok(Number.isSafeInteger(pid) && pid > 1, 'Foreground app is observable');
  assert.notEqual(pid, app.process().pid, 'The hidden test app never becomes the foreground app');
}
function fixture(method, target, value) {
  const id = ++sequence, field = method === 'backgroundProof' ? 'proofRequestId' : 'requestId';
  if (method === 'backgroundComplete') { child.send({ id, method, target, value }); return Promise.resolve(); }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.off('message', cb); reject(Error('Fixture timeout: ' + method)); }, 10000);
    const cb = r => { if (r[field] === id) { clearTimeout(timer); child.off('message', cb); r.error ? reject(Error(r.error)) : resolve(r); } };
    child.on('message', cb); child.send({ id, method, target, value });
  });
}
function mcp() {
  helper = scratch.childProcess.spawn(process.execPath, [path.join(code, 'app/claude-message-tool.cjs'), '--codex'], {
    env: { ...process.env, NAW_CONTROL_DESCRIPTOR: path.join(profile, 'outbox-owner.json') }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = ''; const pending = new Map();
  helper.stdout.setEncoding('utf8'); helper.stdout.on('data', chunk => { buffer += chunk; let end; while ((end = buffer.indexOf('\n')) >= 0) {
    const r = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); pending.get(r.id)?.(r); pending.delete(r.id);
  } }); helper.stderr.on('data', value => errors.push(String(value)));
  return (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => reject(Error('MCP timeout')), 20000);
    pending.set(id, r => { clearTimeout(timer); r.error ? reject(Error(JSON.stringify(r.error))) : resolve(r.result); });
    helper.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

async function main() {
  // Real record writer and durable temp registration, confined to this owned profile.
  let clock; const audit=new (require('../app/butler-read-audit.cjs').ButlerReadAudit)(profile,{now:()=>clock});
  const now=Date.now();for(let n=32;n>=0;n--){clock=now-n*86400000;audit.recordPage({actor:{sessionId:'synthetic-reader',nativeId:'synthetic-reader-native',selectionRevision:1,runnerRef:'synthetic-runner'},query:{kind:'spaces',spaceId:null,limit:50},result:{count:0,recordRefs:[],scanned:0,truncated:false}});}
  const candidates=path.join(profile,'candidates'),registry=path.join(profile,'receipts');fs.mkdirSync(candidates,{mode:0o700});
  const produced=require('node:child_process').spawnSync(process.execPath,[path.join(root,'scripts/fixtures/temp-reminder-producer.cjs'),candidates,registry],{encoding:'utf8',env:{...process.env,NODE_OPTIONS:'',NAW_TEST_TEMP_JOURNAL:''}});assert.equal(produced.status,0,produced.stderr);
  child=scratch.childProcess.fork(path.join(code,'app/daemon.cjs'),[profile],{execArgv:['--require',path.join(root,'scripts/fixtures/background-control.cjs')],env:{...process.env,NAW_TEST_APP_ROOT:code,NAW_WORKSPACE:profile,NAW_APP_VERSION:require(path.join(code,'package.json')).version},stdio:['ignore','ignore','inherit','ipc']});
  await until(()=>fs.existsSync(path.join(profile,'connection.json')),'Synthetic service starts');
  client=await connectService(profile,'human-view');
  const source=await client.call('create',{provider:'codex',cwd:profile,name:'Codex · 设计助手',view:'chat'}),other=await client.call('create',{provider:'claude',cwd:profile,name:'Claude · 方案复核',view:'chat'});
  await client.call('join',source,true);await client.call('join',other,true);await client.call('draft',other,'保留这份未发送的草稿。');
  fs.writeFileSync(path.join(profile,'views.json'),JSON.stringify([{owner:'human-view',active:true,selected:other,mode:'chat'}]),{mode:0o600});
  const entry=createSourceEntry({profile,code,fixturePid:child.pid}),entryFile=path.join(entry,'entry.cjs');
  // Only expose the owned controller to this test's clock. No production test API.
  fs.writeFileSync(entryFile,`const mod=require(${JSON.stringify(path.join(code,'app/background-control.cjs'))}),Original=mod.BackgroundControl;mod.BackgroundControl=class extends Original{constructor(options){super(options);globalThis.inboxFixture=this;}};require('electron').Notification.isSupported=()=>false;\n`+fs.readFileSync(entryFile,'utf8'));
  app=await _electron.launch({executablePath:require('electron'),args:[entry],env:{...process.env,NAW_DATA_DIR:profile,NAW_TEMP_REGISTRY_DIR:registry,NAW_TEST_PARENT_PID:String(process.pid),NAW_TEST_UI_LANGUAGE:'zh'},timeout:70000});
  page=await app.firstWindow();page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));await page.locator('#new-session').waitFor({timeout:45000});await revealDefaultSpace(page);checkForeground();
  const rpc=mcp();await rpc('initialize');
  async function control(method,args,expected='confirmation-required'){
    const request={action:'invoke',method,arguments:args,operation_id:randomUUID()},proof=await fixture('backgroundProof',source,{callId:randomUUID(),arguments:request});
    const result=await rpc('tools/call',{name:'workspace_control',arguments:request,_meta:{threadId:proof.nativeId,sessionId:proof.sessionId,callId:proof.callId,'x-codex-turn-metadata':{thread_id:proof.nativeId,turn_id:proof.turnId}}});
    await fixture('backgroundComplete',source,{callId:proof.callId,arguments:request});const row=JSON.parse(result.content[0].text);assert.equal(row.state,expected,JSON.stringify(row));return row;
  }
  const create=name=>control('create',[{provider:'claude',name,cwd:profile}]);
  const old=await create('布局检查'),valid=await create('布局检查');
  await app.evaluate(()=>{inboxFixture.now=()=>Date.now()-660000;});const expired=await create('已过期的请求');await app.evaluate(()=>{inboxFixture.now=Date.now;inboxFixture.expirePending();});
  const withdrawn=await create('发起者撤回的请求');await control('backgroundWithdraw',[withdrawn.id],'complete');
  const cancelled=await create('已取消的请求');await page.evaluate(r=>workspace.backgroundDecision(r.actor.id,r.actor.nativeId,r.id,0),cancelled);
  const invalid=await create('名称已被占用');await page.evaluate(([id,name])=>workspace.rename(id,name),[other,'名称已被占用']);
  let status=await page.evaluate(()=>workspace.records('status',true));assert.equal(status.confirmationCount,1);assert.equal(status.count,3);assert.equal(status.confirmations.length,6);
  assert.equal(status.confirmations.find(c=>c.operationId===old.id).state,'replaced');assert.equal(status.confirmations.find(c=>c.operationId===expired.id).disposition,'expired');assert.equal(status.confirmations.find(c=>c.operationId===withdrawn.id).disposition,'withdrawn');assert.equal(status.confirmations.find(c=>c.operationId===invalid.id).state,'unverifiable');
  record('one valid card + record reminder + temp reminder = bell 3; all six histories retained');
  const ticket=status.temp.ticket;await create('刷新用卡片');status=await page.evaluate(()=>workspace.records('status'));assert.equal(status.temp.ticket,ticket,'Card refresh preserves unchanged cleanup ticket');
  const refreshCard=status.confirmations.find(c=>c.operationId!==valid.id&&c.actionable);await control('backgroundWithdraw',[refreshCard.operationId],'complete');
  const win=await app.browserWindow(page),shots=[],themeMetrics=[];
  async function language(lang){await page.keyboard.press('Escape');await page.locator('#setup-button').click();await page.locator('#ui-language').selectOption(lang);await until(async()=>await page.locator('#setup-title').textContent()===(lang==='zh'?'设置':'Settings'),'Language changes');await page.locator('#close-setup').click();}
  async function shot(lang,width,view){
    await win.evaluate((w,width)=>w.setContentSize(width,width===850?720:900),width);
    for(const theme of ['light','dark']){
      await app.evaluate(({nativeTheme},theme)=>{nativeTheme.themeSource=theme;},theme);await page.emulateMedia({colorScheme:theme});await delay(500);
      // Capture a normal open in the settled theme, rather than an in-flight
      // native theme repaint of an already-open top-layer surface.
      await page.keyboard.press('Escape');await page.locator('#records-button').click();
      await page.locator(`[data-action="${view.startsWith('all')?'allConfirmations':'pendingConfirmations'}"]`).click();
      if(view==='all-ended')await page.locator(`[data-confirmation-key="${invalid.actor.id}:${invalid.actor.nativeId}:${invalid.id}"]`).scrollIntoViewIfNeeded();
      await delay(250);
      const metrics=await page.locator('#records-dialog').evaluate(el=>({right:el.getBoundingClientRect().right,bottom:el.getBoundingClientRect().bottom,width:innerWidth,height:innerHeight,overflow:el.scrollWidth>el.clientWidth+1,dark:document.body.hasAttribute('data-ds-dark-theme'),primary:[...el.querySelectorAll('button.primary')].map(b=>({text:b.textContent,ink:getComputedStyle(b).color,fill:getComputedStyle(b).webkitTextFillColor,opacity:getComputedStyle(b).opacity,background:getComputedStyle(b).backgroundColor}))}));
      assert.ok(metrics.right<=metrics.width&&metrics.bottom<=metrics.height&&!metrics.overflow,'Dialog fits');assert.equal(metrics.dark,theme==='dark');themeMetrics.push({lang,width,view,theme,...metrics});
      const name=`implemented-${lang}-${theme}-${width}-${view}.png`;await page.screenshot({path:path.join(pictures,name)});shots.push(name);checkForeground();
    }
  }
  for(const lang of ['zh','en']){
    await language(lang);await page.locator('#room-nav').click();await page.locator('#room-overview').click();assert.ok(await page.locator('#records-button').isVisible());
    await page.locator('#records-button').click();await page.locator('[data-action="openConfirmation"]').waitFor();
    assert.equal(await page.locator('#records-badge').innerText(),'3');assert.equal(await page.locator('[data-action="openConfirmation"]').count(),1);
    assert.equal(await page.locator('#records-dialog section').first().getAttribute('data-record'),'confirmations');assert.equal(await page.locator('[data-record="confirmations"] [data-action="acknowledge"]').count(),0);
    const row=page.locator(`[data-confirmation-key="${valid.actor.id}:${valid.actor.nativeId}:${valid.id}"]`);await row.focus();const firstTime=await row.locator('time').first().textContent();await delay(1200);assert.notEqual(await row.locator('time').first().textContent(),firstTime,'Wait clock advances locally');
    await app.evaluate(()=>inboxFixture.changed({confirmations:true}));
    await until(()=>row.evaluate(el=>el===document.activeElement),'Live refresh keeps the focused original-card row');
    await page.evaluate(()=>workspace.records('status'));assert.equal(await page.locator('[data-action="openConfirmation"]').count(),1);
    for(const width of [1240,850])await shot(lang,width,'pending');
    await page.locator('[data-action="allConfirmations"]').click();assert.equal(await page.locator('[data-action="openConfirmation"]').count(),7);
    for(const width of [1240,850])await shot(lang,width,'all');
    await page.locator(`[data-confirmation-key="${invalid.actor.id}:${invalid.actor.nativeId}:${invalid.id}"]`).scrollIntoViewIfNeeded();
    for(const width of [1240,850])await shot(lang,width,'all-ended');
    const history=page.locator(`[data-confirmation-key="${cancelled.actor.id}:${cancelled.actor.nativeId}:${cancelled.id}"]`);await history.click();await until(()=>page.locator(`[data-message-id="background:${cancelled.actor.nativeId}:${cancelled.id}"][data-search-target]`).isVisible(),'Ended card reaches exact original');
    await page.locator('#records-button').click();await page.locator(`[data-confirmation-key="${valid.actor.id}:${valid.actor.nativeId}:${valid.id}"]`).click();await until(()=>page.locator(`[data-message-id="background:${valid.actor.nativeId}:${valid.id}"][data-search-target]`).isVisible(),'Pending card reaches exact original');
    assert.equal(await page.locator('#records-dialog').isVisible(),false);assert.equal(await page.locator('#records-button').isVisible(),true);
    record(`${lang}: overview bell, pending/all, local wait clock, exact pending/history navigation, wide/narrow fit`);
  }
  // Make the last card expire while the dialog is open: source expiry pushes a new count without a records block.
  await page.locator('#records-button').click();await app.evaluate(()=>{inboxFixture.now=()=>Date.now()+660000;inboxFixture.expirePending();});
  await until(()=>page.locator('#records-badge').innerText().then(n=>n==='2'),'Expiry removes only the card from bell');assert.equal(await page.locator('[data-action="openConfirmation"]').count(),0);record('source TTL removes card and pushes badge without changing record block count');
  await page.keyboard.press('Escape');assert.equal(await page.locator('#records-dialog').isVisible(),false);
  assert.equal(await page.evaluate(()=>document.activeElement.id),'records-button','Esc restores focus to the bell');
  for(const lang of ['zh','en']){
    await language(lang);await page.locator('#records-button').click();
    if(lang==='zh'){
      await page.locator('[data-action="tempAcknowledge"]').click();
      await page.locator('[data-record="butler-reads"] [data-action="acknowledge"]').click();
      await until(()=>page.locator('#records-badge').innerText().then(n=>n===''),'Acknowledged reminders leave empty bell');
    }
    assert.equal(await page.locator('[data-action="openConfirmation"]').count(),0);
    for(const width of [1240,850])await shot(lang,width,'zero-pending');await page.keyboard.press('Escape');
  }
  record('zero badge remains reachable in both languages and widths; confirmations have no acknowledge action');
  await page.locator(`.session-link[data-session-id="${other}"]`).click();await page.locator('#chat-tab').click();assert.equal(await page.locator('#message-input').inputValue(),'保留这份未发送的草稿。');
  const final=await client.call('initial');assert.equal(final.sessions.length,2);const stats=await fixture('stats');assert.equal(stats.modelCalls,0);assert.equal(stats.nativeProcesses,0);assert.deepEqual(stats.inputs,[]);assert.deepEqual(stats.sends,[]);assert.deepEqual(stats.decisions,[]);assert.deepEqual(errors,[]);
  const windows=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().map(w=>({visible:w.isVisible(),focused:w.isFocused()})));assert.ok(windows.every(w=>!w.visible&&!w.focused));record('no requested create executed; draft preserved; zero native/model calls and renderer errors');
  const differences='实际入口沿用侧栏常驻小铃铛，打开现有 dialog；原型是顶部入口和右侧面板。数字包含有效待确认和待处理提醒；列表分节。筛选为「待确认 / 全部」；行内补等待和剩余时间。点行只跳原卡；失效、过期、撤回和取消只留历史，不提供「知道了」。';
  fs.writeFileSync(path.join(pictures,'index.html'),`<!doctype html><html lang="zh"><meta charset="utf-8"><title>待你确认进小铃铛 · 迁移候选</title><style>body{max-width:1800px;margin:24px auto;padding:0 20px;font:16px/1.6 system-ui;background:#f8f8f5;color:#26372e}.pair{display:grid;grid-template-columns:1fr 1fr;gap:16px}img{width:100%;border:1px solid #ccc}figure{margin:0}@media(max-width:850px){.pair{grid-template-columns:1fr}}</style><h1>待你确认进小铃铛 · 迁移候选</h1><p>全部为合成数据，真实 renderer。未合并、安装、推送。</p><p>${differences}</p>${shots.map(name=>`<h2>${name}</h2><div class="pair"><figure><figcaption>迁移候选</figcaption></figure><figure><figcaption>实现</figcaption><a href="${name}"><img src="${name}"></a></figure></div>`).join('')}</html>`);
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({checks,shots,themeMetrics,stats,windows,errors,pictures},null,2));console.log(JSON.stringify({passed:checks.length,failed:0,skipped:0,screenshots:shots.length,pictures}));
}
main().catch(async e => {
  console.error(e.stack); process.exitCode = 1;
  if (page && !page.isClosed()) { await page.screenshot({ path: path.join(pictures, 'failure.png') }).catch(() => {});
    fs.writeFileSync(path.join(output, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); }
}).finally(scratch.cleanup(async () => {
  if (helper) helper.stdin.end();
  if (app) await app.close().catch(() => {});
  if (client) { await client.call('shutdown').catch(() => {}); client.close(); }
  if (child?.connected) child.disconnect();
  if (child?.exitCode === null) child.kill('SIGTERM');
  const owner = JSON.parse(fs.readFileSync(path.join(slot, 'owner.json')));
  if (owner.token === token) { fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot); }
}));
