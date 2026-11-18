// Hidden source application and synthetic transport only; no provider calls.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto'), { execFileSync } = require('node:child_process'), { createRequire } = require('node:module');
const { BAR_HEIGHT } = require('../app/renderer/task-board.js');
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
  const ids = []; for (const [name, provider] of [['Synthetic A', 'codex'], ['Synthetic B', 'claude']]) ids.push(await client.call('create', { name, provider, cwd: work, view: 'chat' }));
  await fixture('nativeBlock', ids[0], { id: 'private-conversation-fixture', kind: 'response', turnId: 'fixture-turn', status: 'complete', text: 'SYNTHETIC_CONVERSATION_NOT_A_QUEUE_ITEM' });
  const state = new RoomState(profile), old = Date.now() - 8 * 86400000, sent = [];
  const item = (status, n, extra = {}) => ({ id: randomUUID(), status, text: 'Synthetic queue task ' + n, assignee: ids[n % 2], createdAt: old, ...extra });
  const queue = Array.from({ length: 295 }, (_, i) => item(i < 288 ? 'done' : 'cancelled', i, { finishedAt: old }));
  for (let i = 0; i < 4; i++) { const q = item('sent', i, { sentTo: ids[i % 2], sentAt: old, tag: 'synthetic-tag-' + i }); sent.push(q.id); queue.push(q); }
  queue.push(item('queued', 4, { assignee: null })); state.update({ name: '示例开发', queue }, undefined, 'shared');
  const empty = state.create('界面设计'), history = state.create('资料整理'), finished = state.create('文档核对');
  state.update({ queue: [item('done', 1, { finishedAt: old })] }, undefined, history);
  state.update({ queue: [item('done', 2, { finishedAt: Date.now() }), item('cancelled', 3, { finishedAt: Date.now() })] }, undefined, finished);
  const entry = createSourceEntry({ profile, code, fixturePid: child.pid }), file = path.join(entry, 'entry.cjs');
  const prefix = `const rs=require(${JSON.stringify(path.join(code,'app/room-state.cjs'))}),originalRoomState=rs.RoomState;rs.RoomState=class extends originalRoomState{constructor(...args){super(...args);globalThis.taskBoardFixture=this;}};const e=require('electron');e.Notification.isSupported=()=>false;require(${JSON.stringify(path.join(code, 'app/preflight.cjs'))}).preflight=()=>({claude:true,codex:true,python:true,paths:{},configured:{}});for(const k of ['show','showInactive','focus'])e.BrowserWindow.prototype[k]=function(){};for(const k of ['showOpenDialog','showSaveDialog','showMessageBox','showOpenDialogSync','showSaveDialogSync','showMessageBoxSync'])e.dialog[k]=()=>{throw Error('OS dialog forbidden')};e.shell.openExternal=e.shell.openPath=async()=>{throw Error('External open forbidden')};`;
  fs.writeFileSync(file, prefix + '\n' + fs.readFileSync(file, 'utf8'));
  app = await _electron.launch({ executablePath: req('electron'), args: [entry], env: env({ NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid), NAW_TEST_VISIBLE: '0', NAW_TEST_UI_LANGUAGE: process.env.NAW_TEST_UI_LANGUAGE || 'zh' }), timeout: 60000 });
  page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message)); await page.locator('#header').waitFor(); await settled();
  check(await page.locator('.task-board-project').count() === 4, 'The actual source app renders all four queue projects');
  const pictures = process.env.NAW_SCREENSHOTS_DIR; if (pictures) { assert.ok(!path.resolve(pictures).startsWith(fs.realpathSync(code) + path.sep)); fs.mkdirSync(pictures, { recursive: true }); }
  const language = process.env.NAW_TEST_UI_LANGUAGE || 'zh';
  for (const [width, height] of [[1240, 820], [850, 600]]) for (const theme of ['light', 'dark']) {
    await app.evaluate(({ BrowserWindow }, [width, height]) => BrowserWindow.getAllWindows()[0].setContentSize(width, height), [width, height]); await page.emulateMedia({ colorScheme: theme }); await settled();
    const g = await page.locator('#task-board').evaluate(host => { const box = e => { const r = e.getBoundingClientRect(); return { width: r.width, height: r.height }; }; return { overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, bar: box(host), projects: [...host.querySelectorAll('.task-board-project')].map(e => ({ primary: e.querySelector('strong').textContent, sub: e.querySelector('.task-board-parts').textContent, name: e.querySelector('.task-board-project-name').textContent,label:e.getAttribute('aria-label'),nameClip:e.querySelector('.task-board-project-name span').scrollWidth>e.querySelector('.task-board-project-name span').clientWidth, partsHeight: box(e.querySelector('.task-board-parts')).height, font: parseFloat(getComputedStyle(e.querySelector('.task-board-parts')).fontSize) })) }; });
    observations.push({ width, height, theme, g }); check(g.overflow <= 0 && g.bar.height === BAR_HEIGHT, `${width} ${theme}: no document overflow and the shared height constant`);
    check(g.projects.every(p => p.font >= 12 && !p.nameClip), `${width} ${theme}: every part count is at least12px`);
    check(g.projects[0].primary.includes('5') && /4.*1/.test(g.projects[0].sub), `${width} ${theme}: 295 historic outcomes cannot hide five current tasks`);
    check(g.projects[1].label.includes(language==='zh'?'暂无任务':'No tasks yet') && g.projects[2].label.includes(language==='zh'?'当前无在途':'Nothing in transit'), `${width} ${theme}: accessible names distinguish empty from history`);
    if (pictures) await page.screenshot({ scale: 'css', path: path.join(pictures, `${language}-${theme}-${width}-closed.png`) });
  }
  await page.locator('.task-board-toggle').focus(); await page.locator('.task-board-toggle').press('Enter'); check(await page.locator('#task-board-panel').isVisible(), 'Enter opens task board');
  const emptyGroup=page.locator('.task-board-group').nth(1);await emptyGroup.locator('summary').click();check((await emptyGroup.locator('.task-board-empty').textContent()).includes(language==='zh'?'暂无任务':'No tasks yet'),'Expanded empty space has an explicit empty state');
  await page.locator('.task-board-options button').nth(1).click(); const group = page.locator('.task-board-group').first(), more = group.locator('.task-board-more');
  await more.click(); await more.click(); check(await group.locator('.task-board-task').count() === 9, 'All-history progressively loads three, six, then nine rows');
  if(pictures)await page.screenshot({scale:'css',path:path.join(pictures,language+'-open-history.png')});
  await more.focus(); await settled();
  const before = await group.evaluate(g => { window.boardMore = g.querySelector('.task-board-more'); window.boardRows = [...g.querySelectorAll('.task-board-task')]; const list = g.parentElement; return { top: list.scrollTop, ids: boardRows.map(e => e.dataset.taskKey), height: list.clientHeight }; });
  await page.evaluate(id => workspace.spaceAction('shared', 'queueResolve', [id]), sent[0]); await until(async () => (await page.locator('.task-board-project strong').first().textContent()).includes('4'), 'Real state push updates transit count'); await settled();
  const after = await group.evaluate(g => ({ sameMore: boardMore === g.querySelector('.task-board-more'), focused: document.activeElement === boardMore, sameRows: boardRows.every((e, i) => g.querySelectorAll('.task-board-task')[i] === e), rows: g.querySelectorAll('.task-board-task').length, top: g.parentElement.scrollTop, ids: [...g.querySelectorAll('.task-board-task')].map(e => e.dataset.taskKey) }));
  check(after.sameMore && after.focused, 'Status push preserves the exact focused load-more node'); check(after.rows === 9, 'Status push preserves loaded count'); check(after.sameRows && JSON.stringify(after.ids) === JSON.stringify(before.ids), 'Status change updates the row without reprioritizing or replacing it'); check(Math.abs(after.top - before.top) <= 1, 'Status push preserves reading scroll offset');
  await page.evaluate(id => workspace.spaceAction(id, 'queueAdd', ['Synthetic new task in another space', null]), empty); await settled();
  check(await more.evaluate(e => e === window.boardMore && document.activeElement === e), 'Another-space queue push preserves current control focus');
  for (const index of [1, 2]) {
    await page.locator('.task-board-controls .task-board-options').nth(1).locator('button').nth(index).click(); check(await page.locator('.task-board-task').count() > 0, 'Status/member classification remains reachable ' + index);
    const firstGroup=page.locator('.task-board-group').first(),button=firstGroup.locator('.task-board-more');await button.focus();
    const keys=await firstGroup.locator('.task-board-task').evaluateAll(xs=>xs.map(e=>e.dataset.taskKey));
    if(index===1)await page.evaluate(id=>workspace.spaceAction('shared','queueResolve',[id]),sent[1]);
    else {await app.evaluate((_,v)=>{const store=globalThis.taskBoardFixture;store.update({queue:store.metadata('shared').queue.map(q=>q.id===v.id?{...q,sentTo:v.member}:q)},undefined,'shared');},{id:sent[2],member:ids[1]});await client.call('draft',ids[0],'Synthetic metadata push');}
    await settled();await wait(150);
    const same=await firstGroup.locator('.task-board-task').evaluateAll(xs=>xs.map(e=>e.dataset.taskKey));check(JSON.stringify(same)===JSON.stringify(keys),'Live state/member change does not move the rows being read '+index);
    check(await button.evaluate(e=>document.activeElement===e),'Grouped update retains focus '+index);
    await page.locator('.task-board-regroup').click();check(!(await page.locator('.task-board-regroup').isVisible()),'Explicit regroup applies the pending membership change '+index);
  }
  check(!(await page.locator('#task-board-panel').textContent()).includes('SYNTHETIC_CONVERSATION_NOT_A_QUEUE_ITEM'), 'Task board does not include native conversation text');
  await page.keyboard.press('Escape'); check(await page.locator('.task-board-toggle').evaluate(e => document.activeElement === e), 'Escape closes and returns focus');
  await page.locator('.task-board-project').nth(2).click(); await page.locator('.task-board-footer select').selectOption(history); await page.locator('.task-board-footer button').click(); check(await page.locator('#queue-dialog').isVisible(), 'Original space queue opens from read-only task board'); check((await page.locator('#queue-title').textContent()).includes('资料整理'), 'Original queue opens for the selected space');
  await page.locator('#close-queue').click();
  const attention = queue.filter(q => ['sent','queued'].includes(q.status)).concat(item('waiting', 20), item('waiting', 21, { reason:'no-reply' }), item('failed', 22, { reason:'member-missing' }), queue.filter(q=>['done','cancelled'].includes(q.status)).slice(0,292));
  await app.evaluate((_, queue) => globalThis.taskBoardFixture.update({queue},undefined,'shared'), attention);
  await client.call('draft',ids[0],'Synthetic private draft not included in the task board');
  await until(async()=> (await page.locator('.task-board-project strong').first().textContent()).includes('7'),'Attention fixture reaches renderer via normal state push');
  for(const [width,height] of [[1240,820],[850,600]])for(const theme of ['light','dark']){
    await app.evaluate(({BrowserWindow},v)=>BrowserWindow.getAllWindows()[0].setContentSize(...v),[width,height]);await page.emulateMedia({colorScheme:theme});await settled();
    const parts=await page.locator('.task-board-parts').first().evaluate(e=>{const r=document.createRange();r.selectNodeContents(e);return {text:e.textContent,width:r.getBoundingClientRect().width,available:e.clientWidth,height:e.getBoundingClientRect().height};});
    check((parts.text.match(/\d+/g)||[]).map(Number).reduce((a,b)=>a+b,0)===7,`${width} ${theme}: full transit breakdown sums to7`);
    const contrast=await page.locator('.task-board-attention.failed').first().evaluate(e=>{const rgb=s=>s.match(/[\d.]+/g).map(Number),lum=c=>c.slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((a,v,i)=>a+v*[.2126,.7152,.0722][i],0);let p=e,b;while(p){const c=rgb(getComputedStyle(p).backgroundColor);if(c.length===3||c[3]===1){b=c;break;}p=p.parentElement;}const a=lum(rgb(getComputedStyle(e).color)),z=lum(b);return(Math.max(a,z)+.05)/(Math.min(a,z)+.05);});
    check(contrast>=4.5,`${width} ${theme}: warning text contrast is at least4.5 (${contrast.toFixed(2)})`);
    check(parts.width<=parts.available+1 || parts.height>14,`${width} ${theme}: all transit components fit without clipping`);
    if(pictures)await page.screenshot({scale:'css',path:path.join(pictures,`${language}-${theme}-${width}-attention.png`)});
  }
  const nextWindow = app.waitForEvent('window'); await page.evaluate(id => workspace.newWindow(id), ids[0]); const solo = await nextWindow;
  await solo.locator('.task-board-project').last().waitFor(); check(await solo.locator('.task-board-project').count() === 4, 'The same progress bar is present in a standalone session window');
  check((await client.call('initial')).sessions.length === 2, 'Opening the standalone view never creates a second native writer');
  if (await solo.locator('#open-native-terminal').isVisible()) { await solo.locator('#open-native-terminal').click(); check(await solo.locator('#task-board').isVisible(), 'Progress stays visible when the native terminal opens'); }
  const hidden = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(w => !w.isVisible() && !w.isFocusable())); check(hidden, 'All owned windows remain hidden and unfocusable');
  const stats = await fixture('stats', ids[0]); check(stats.stats.sends === 0 && stats.stats.inputs === 0, 'Zero native input and model sends'); check(errors.length === 0, 'No renderer errors');
  if (pictures) fs.writeFileSync(path.join(pictures, language + '-results.json'), JSON.stringify({ checks, observations, before, after, stats, errors }, null, 2));
  console.log(`SUMMARY ${checks.length} pass / 0 fail / 0 skip`);
} finally {
  try { await clean(); await scratch.release(); } finally { const owner = JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))); if (owner.token === token) { fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot); } }
} })().catch(e => { console.error(e); process.exitCode = 1; });
