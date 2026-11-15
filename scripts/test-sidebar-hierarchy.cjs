// Real hidden source Electron, synthetic native hosts, owned temporary profile. No model or real user data.
const scratch = require('./fixtures/test-scratch.cjs');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { _electron } = scratch.playwright(require('playwright'));
const { createSourceEntry } = require('./fixtures/synthetic-source-boot.cjs');
const root = path.resolve(__dirname, '..'), evidence = process.env.NAW_EVIDENCE_DIR, baseline = process.env.NAW_SIDEBAR_BASELINE === '1';
assert.ok(evidence && path.isAbsolute(evidence) && !path.resolve(evidence).startsWith(root + path.sep));
fs.mkdirSync(evidence, { recursive: true });
const slot = path.join(root, '.local/gui-test-slot.lock'), token = randomUUID();
fs.mkdirSync(path.dirname(slot), { recursive: true });
try { fs.mkdirSync(slot); } catch (e) { if (e.code !== 'EEXIST') throw e; console.error('GUI slot occupied; no allocation.'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ token, owner: 'Codex B', task: 'sidebar 1B+2', pid: process.pid }));
const benign = new Set(['PATH','TMPDIR','LANG','LC_ALL','LC_CTYPE','HOME','SHELL','USER','LOGNAME','TZ','TERM','COLORTERM','COMMAND_MODE','__CF_USER_TEXT_ENCODING']);
const env = extra => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => benign.has(key))), ...extra });
let profile, child, client, app, page, sequence = 0;
const checks = [], errors = [], ids = [], rooms = [];
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label) { for (let n = 0; n < 200; n++) { if (await fn()) return; await delay(50); } throw Error(label); }
function fixture(method, target, value) {
  const id = ++sequence;
  return new Promise((resolve,reject) => { const cb = reply => { if (reply.requestId !== id) return; clearTimeout(timer); child.off('message',cb); reply.error ? reject(Error(reply.error)) : resolve(reply); };
    const timer = setTimeout(() => { child.off('message',cb); reject(Error('Fixture deadline')); },8000); child.on('message',cb); child.send({ id,method,target,value }); });
}
const settle = async () => { await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))); await delay(200); };
const size = async (width,height) => { await app.evaluate(({BrowserWindow},s) => BrowserWindow.getAllWindows()[0].setContentSize(s.width,s.height),{width,height}); await settle(); };
const capture = async name => { await page.mouse.move(700,200); await settle(); return page.screenshot({ path:path.join(evidence,name+'.png') }); };
const surface = () => page.locator('.naw[data-native-surface="sidebar"]');
const row = id => surface().locator(`[data-session-row="${id}"]`);
const snapshot = () => page.evaluate(() => workspace.initial());
const identities = s => s.sessions.map(r=>[r.id,r.nativeId,r.liveDraft]).sort();
const check = label => { checks.push(label); console.log('PASS:',label); };
async function language(code) { await page.locator('#setup-button').click(); await page.locator('#ui-language').selectOption(code); await until(async()=>await page.locator('#setup-title').textContent()===(code==='zh'?'设置':'Settings'),'Language changed'); await page.locator('#close-setup').click(); await settle(); }
async function expanded() { if (await surface().getAttribute('data-collapsed') === 'true') { if (baseline) await page.keyboard.press('Alt+Meta+b'); else await page.locator('#sidebar-toggle').click(); await until(async()=>await surface().getAttribute('data-collapsed')==='false','Sidebar expanded'); } }
async function run() {
  profile = scratch.directory(path.join(os.tmpdir(),'naw-sidebar-hierarchy-')); const cwd=path.join(profile,'workspace');fs.mkdirSync(cwd);
  child=scratch.childProcess.fork(path.join(root,'app/daemon.cjs'),[profile],{cwd,execArgv:['--require',path.join(__dirname,'fixtures/loading-terminal.cjs')],env:env({NAW_TEST_APP_ROOT:root,NAW_WORKSPACE:cwd,NAW_APP_VERSION:require('../package.json').version}),stdio:['ignore','ignore','inherit','ipc']});
  await until(()=>fs.existsSync(path.join(profile,'connection.json')),'Owned synthetic backend');
  client=await require('../app/service-connection.cjs').connectService(profile,'sidebar-seed');
  for (const [name,provider] of [['界面整理','claude'],['组件实现','codex'],['回归检查','codex'],['说明文档','claude'],['数据核对','codex'],['临时讨论','claude']]) {
    const id=await client.call('create',{provider,cwd,name,view:'chat'});ids.push(id);await client.call('draft',id,'尚未发送的草稿：继续核对左栏层次。');
  }
  const entry=createSourceEntry({profile,code:root,fixturePid:child.pid}), file=path.join(entry,'entry.cjs');
  fs.writeFileSync(file,`const e=require('electron');e.Notification.isSupported=()=>false;globalThis.sidebarGuards=[];
for(const name of ['showOpenDialog','showSaveDialog','showMessageBox','showOpenDialogSync','showSaveDialogSync','showMessageBoxSync'])e.dialog[name]=()=>{sidebarGuards.push(name);throw Error('OS dialog outside test');};
const {WorkspaceClient}=require(${JSON.stringify(path.join(root,'app/workspace-client.cjs'))}), old=WorkspaceClient.prototype.snapshot, ids=${JSON.stringify(ids)};
WorkspaceClient.prototype.snapshot=function(...args){const s=structuredClone(old.apply(this,args));for(const r of s.sessions){const i=ids.indexOf(r.id);if(i<0)throw Error('Unexpected record');r.cwd=['/demo/atlas','/demo/atlas-lanes/ui','/demo/atlas-lanes/check','/demo/notes','/other/notes',''][i];if(i===1||i===2)r.worktreePreparation={repository:'/demo/atlas',target:r.cwd,nonce:i===1?'ab1234-56':'cd5678-90',branch:'naw/session-'+i};if(i===1)r.state='working';if(i===2)r.nativeInputRequired=true;}return s;};
`+fs.readFileSync(file,'utf8'));
  app=await _electron.launch({executablePath:require('electron'),args:[entry],env:env({NAW_DATA_DIR:profile,NAW_TEST_PARENT_PID:String(process.pid),NAW_TEST_VISIBLE:'0',NAW_TEST_UI_LANGUAGE:'zh'}),timeout:60000});
  await until(async()=>{for(const p of app.windows())if(!p.isClosed()&&await p.locator('#new-session').count()){page=p;return true;}return false;},'Workspace page');
  page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));
  assert.deepEqual(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().map(w=>({visible:w.isVisible(),focusable:w.isFocusable()}))),[{visible:false,focusable:false}]);
  await size(1240,820);
  for(const name of ['产品开发','资料整理'])rooms.push(await page.evaluate(name=>workspace.spaceCreate(name),name));
  for(let i=0;i<5;i++)await page.evaluate(({room,id})=>workspace.spaceAction(room,'join',[id,true]),{room:rooms[i<3?0:1],id:ids[i]});
  await page.locator('#sessions-grouped').click();await row(ids[1]).locator('.session-link').click();await settle();await fixture('release',ids[1]);await settle();
  const initial=identities(await snapshot());
  for(const [name,w,h] of [['wide',1240,820],['narrow',850,600]]){await size(w,h);await capture(`${name}-space-${w}x${h}`);if(!baseline&&name==='narrow'){await expanded();await capture('narrow-space-expanded-850x600');}}
  check('Chinese before/after snapshots at 1240x820 and 850x600, using one hidden unfocusable window');
  if(baseline)return;
  await size(1240,820);await expanded();
  assert.equal(await page.evaluate(()=>document.documentElement.dataset.sidebarLook),'b');
  assert.equal(await page.evaluate(()=>localStorage.getItem('naw.sidebarDesignPrototype')),null);
  assert.equal(await page.evaluate(()=>localStorage.getItem('naw.sidebarHierarchyPrototype')),null);
  const space=surface().locator(`[data-session-group="${rooms[0]}"]`), title=space.locator('.session-space-heading');
  assert.equal(await title.evaluate(e=>e.tagName),'BUTTON');
  assert.equal(await space.evaluate(e=>getComputedStyle(e).borderTopWidth),'1px');
  assert.match(await row(ids[1]).locator('.hier-folder').innerText(),/atlas.*工作树 ab1234/);
  assert.equal(await row(ids[2]).locator('.session-metadata small').isVisible(),true,'Needs-person status remains visible');
  await title.focus();await page.keyboard.press('Enter');await until(async()=>(await snapshot()).viewState.selected==='room','Real title button opens its space');
  await row(ids[1]).locator('.session-link').click();
  check('B space cards and folder rows are the default; real title button enters its space without prototype flags');
  const crumb=page.locator('#sidebar-folder-path');assert.match(await crumb.innerText(),/产品开发.*atlas.*工作树 ab1234/);assert.match(await crumb.getAttribute('title'),/\/demo\/atlas-lanes\/ui/);
  for(const [name,w,h] of [['wide',1240,820],['narrow',850,600]]){await size(w,h);const g=await crumb.evaluate(e=>{const r=e.getBoundingClientRect(),p=e.parentElement.getBoundingClientRect();return{first:e.parentElement.firstElementChild===e,left:r.left,right:r.right,bar:p.toJSON(),scroll:e.parentElement.scrollWidth,width:e.parentElement.clientWidth};});assert.ok(g.first&&g.left>=g.bar.left&&g.right<=g.bar.right&&g.scroll<=g.width+1);}
  check('Toolbar path stays in the existing row at its left, with full-path tooltip and no horizontal overflow');
  await size(1240,820);await expanded();await page.locator('#sessions-folders').click();await settle();
  const folders=surface().locator('.hier-folder-group');assert.equal(await folders.count(),4,'Repository, two distinct notes folders, and unknown');
  assert.equal(await surface().locator('[data-hier-folder="/demo/notes"] .hier-folder-name').innerText(),'demo/notes');
  assert.equal(await surface().locator('[data-hier-folder=":unknown"] .hier-folder-name').innerText(),'文件夹没有记录');
  const atlas=surface().locator('[data-hier-folder="/demo/atlas"]');assert.equal(await atlas.locator('.session-row').count(),3);
  assert.equal(await surface().locator('.session-row').count(),6,'No duplicate native sessions in folder view');
  assert.equal(await page.locator('#sessions-folders').getAttribute('aria-pressed'),'true');assert.equal(await page.locator('#sessions-flat').getAttribute('aria-pressed'),'false');
  await capture('wide-folders-1240x820');
  check('Folder view groups recorded worktrees and main checkout, keeps same-name folders distinct, and lists every session once');
  await atlas.locator('.hier-folder-toggle').focus();await page.keyboard.press('Enter');await until(async()=>await atlas.locator('.hier-folder-toggle').getAttribute('aria-expanded')==='false','Folder folded');
  assert.equal(await atlas.locator('.session-row').first().isVisible(),false);assert.equal(await atlas.locator('.hier-folder-attention').isVisible(),true);
  await until(async()=>(await snapshot()).viewState.sidebarCollapsedFolders?.includes('/demo/atlas'),'Fold saved');await capture('wide-folders-folded-1240x820');
  await page.reload();await page.locator('#sessions-folders').waitFor();await settle();assert.equal(await page.locator('#sessions-folders').getAttribute('aria-pressed'),'true');assert.equal(await atlas.locator('.hier-folder-toggle').getAttribute('aria-expanded'),'false');
  await atlas.locator('.hier-folder-toggle').click();await row(ids[1]).locator('.session-link').click();
  check('Folder folding is keyboard-accessible, shows attention, and survives reload with view and drafts retained');
  await language('en');assert.equal(await page.locator('#sessions-folders').innerText(),'Folders');assert.match(await row(ids[1]).locator('.hier-folder').innerText(),/Worktree ab1234/);assert.match(await crumb.getAttribute('title'),/^Folder:/);await language('zh');
  check('Language switching updates folder labels and path tooltips in place');
  for(const [name,w,h] of [['wide',1240,820],['narrow',850,600]]){await size(w,h);if(name==='narrow'){await capture('narrow-folders-rail-850x600');await expanded();}await capture(`${name}-folders-${w}x${h}`);}
  await size(1240,820);await expanded();await page.locator('#sessions-grouped').click();
  await space.locator('.session-space-toggle').click();assert.equal(await row(ids[1]).isVisible(),false);await space.locator('.session-space-toggle').click();
  await page.locator('#sidebar-toggle').click();await until(async()=>await surface().getAttribute('data-collapsed')==='true','Rail');
  const link=row(ids[1]).locator('.session-link');await link.focus();await page.keyboard.press('Shift+F10');await page.locator('.naw-session-menu').waitFor();await page.keyboard.press('Escape');assert.equal(await link.evaluate(e=>e===document.activeElement),true);
  const spaceMore=space.locator('.space-group-more');assert.equal(await spaceMore.isVisible(),true);await spaceMore.click();await page.getByRole('menu').waitFor();await page.keyboard.press('Escape');assert.equal(await spaceMore.evaluate(e=>e===document.activeElement),true);
  await page.locator('#sidebar-toggle').click();await until(async()=>await surface().getAttribute('data-collapsed')==='false','Expanded again');
  assert.deepEqual(identities(await snapshot()),initial);
  check('Space folding and rail keyboard menu still work; selection changes never alter identities or unsent drafts');
  const counters=await fixture('inspect');assert.deepEqual(counters.sends,[]);assert.deepEqual(counters.inputs,[]);assert.deepEqual(errors,[]);assert.deepEqual(await app.evaluate(()=>globalThis.sidebarGuards),[]);
  check('Zero page errors, model calls, native inputs, sends or OS dialogs');
}
const cleanup=scratch.cleanup(async()=>{if(app)await app.close();client?.close();if(child?.connected)child.disconnect();if(child&&child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');});
(async()=>{try{await run();}catch(e){process.exitCode=1;console.error(e.stack);fs.writeFileSync(path.join(evidence,'failure.txt'),e.stack);if(page&&!page.isClosed())await capture('failure').catch(()=>{});}finally{await cleanup();assert.equal(JSON.parse(fs.readFileSync(path.join(slot,'owner.json'))).token,token);assert.ok(!profile||!fs.existsSync(profile));fs.unlinkSync(path.join(slot,'owner.json'));fs.rmdirSync(slot);const result={checks,errors,baseline,pass:checks.length,failed:process.exitCode?1:0,modelCalls:0,realProviderProcesses:0,slotReleased:true};fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));}})().catch(e=>{console.error(e.stack);process.exitCode=1;});
