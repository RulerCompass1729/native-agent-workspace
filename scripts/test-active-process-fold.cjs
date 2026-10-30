// Actual isolated source GUI/service. Only native output is synthetic.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const scratch = require(path.join(root,'scripts/fixtures/test-scratch.cjs')), { createIn } = require(path.join(root,'scripts/fixtures/create-view.cjs'));
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
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Codex4', task: 'T67 active process-fold acceptance', token, pid: process.pid, time: new Date().toISOString() }));
const profile = scratch.directory(path.join(os.tmpdir(), 'naw-active-fold-'));
const ownedProfile = fs.realpathSync(profile), workspacePath = path.join(profile, 'workspace');
assert.ok(path.resolve(ownedProfile, 'workspace').startsWith(ownedProfile + path.sep));
fs.mkdirSync(workspacePath, { recursive: true, mode: 0o700 }); assert.ok(fs.realpathSync(workspacePath).startsWith(ownedProfile + path.sep));
const child = scratch.childProcess.fork(path.join(code, 'app/daemon.cjs'), [profile], {
  execArgv: ['--require', path.join(root,'scripts/fixtures/process-groups.cjs')],
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
const sourceFiles = ['app/renderer/reading-list.js','app/renderer/styles.css','app/tests/command-actions.test.cjs','app/tests/process-groups.test.cjs','scripts/test-command-actions.cjs','scripts/test-process-group-reading.cjs','scripts/test-active-process-fold.cjs','scripts/fixtures/process-groups.cjs','app/dsh/client.js'];
const sourceHashes = () => Object.fromEntries(sourceFiles.map(file=>[file,require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(code,file))).digest('hex')]));
const sourceBefore=sourceHashes();

async function launch() {
  app = await _electron.launch({ executablePath: require('electron'), args: [code], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message)); await page.locator('#new-session').waitFor();
  await app.evaluate(({ clipboard }) => { globalThis.pageCopies = []; clipboard.writeText = text => globalThis.pageCopies.push(text); });
}
async function create(name, provider = 'codex') {
  const previous = new Set((await snapshot()).sessions.map(s => s.id));
  await page.locator('#new-session').click(); await page.locator(`input[name="provider"][value="${provider}"]`).check();
  await page.locator('#session-name').fill(name); await createIn(page, 'chat');
  return (await snapshot()).sessions.find(s => s.name === name && !previous.has(s.id)).id;
}
async function capture(name) { if (evidence) await page.screenshot({ path: path.join(evidence, name + '.png') }); }
async function copyOriginal(host, id, text) {
  const before = await app.evaluate(() => globalThis.pageCopies.length);
  const copy = host.locator(`[data-message-id="${id}"] .message-actions`).getByRole('button', { name: '复制', exact: true });
  await copy.focus(); await copy.press('Enter');
  await until(async () => await app.evaluate((_, n) => globalThis.pageCopies.length === n + 1 && globalThis.pageCopies.at(-1), before) === text, 'One fresh original copy receipt');
}


const reader=id=>page.locator(`.collaboration-member-reader[data-member-id="${id}"] .messages`);
const disclosure=el=>el.locator(':scope > details'), summary=el=>disclosure(el).locator(':scope > summary');
const sourceId=async(id,suffix)=>(await snapshot()).sessions.find(s=>s.id===id).messages.find(m=>m.id.endsWith(':'+suffix)).id;
const row=async(id,suffix,host=reader(id))=>host.locator(`[data-message-id="${await sourceId(id,suffix)}"]`);
const group=async(id,suffix,host=reader(id))=>host.locator(`[data-process-group="process:${await sourceId(id,suffix)}"]`);
const emit=(id,suffix,value)=>fixture('nativeBlock',id,{id:suffix,...value});
async function toggle(el,open,key,fold){if(await disclosure(el).evaluate(d=>d.open)!==open)await summary(el).click();await until(()=>disclosure(el).evaluate((d,x)=>d.open===x,open),'Actual disclosure state');if(key)await until(async()=>(await snapshot()).viewState.readingPositions?.[key]?.folds?.[fold]===open,'Actual saved manual choice');}
const identities=x=>x.sessions.map(s=>[s.id,s.nativeId,s.owner,s.roomId,s.liveDraft]).sort();
async function run(){
 await until(()=>fs.existsSync(path.join(profile,'connection.json')),'Owned fixture ready');await launch();const owned=fs.realpathSync(profile);assert.ok(fs.realpathSync((await snapshot()).defaultWorkspace).startsWith(owned+path.sep));
 const ids=[];for(const provider of ['claude','codex']){const id=await create('Active '+provider,provider);ids.push(id);await page.locator('#message-input').fill('Unsent '+provider+' draft');await until(async()=>(await snapshot()).sessions.find(s=>s.id===id).liveDraft==='Unsent '+provider+' draft','Draft stored');await page.evaluate(id=>workspace.join(id,true),id);await fixture('processTurn',id,{turnId:'active-'+provider,state:'working'});}
 const [a,b]=ids;for(let i=0;i<3;i++)await emit(a,'tool:bash-'+i,{kind:'tool',title:'Bash',turnId:'active-claude',status:i<2?'failed':'complete',input:'{"command":"echo step-'+i+'"}',text:'Original Claude step '+i+'\nOriginal detail '+i});
 for(let i=0;i<6;i++)await emit(b,'tool:command-'+i,{kind:'tool',toolKind:'commandExecution',commandSource:'agent',commandActions:i<2?[{type:'unknown',command:'printf step-'+i}]:[{type:i%2?'search':'read',command:i%2?'rg needle file-'+i:'cat file-'+i,name:'file-'+i,path:'file-'+i,query:'needle'}],title:'Command',turnId:'active-codex',status:'complete',input:'printf step-'+i,text:'Original Codex step '+i+'\nOriginal detail '+i});
 await page.locator('#room-nav').click();await (await app.browserWindow(page)).evaluate(win=>win.setContentSize(850,600));
 let ga=await group(a,'tool:bash-0'),gb=await group(b,'tool:command-0');await ga.waitFor();await gb.waitFor();const initial=identities(await snapshot()),calls=await fixture('stats'),keyA=`collaboration:shared:${a}`,keyB=`collaboration:shared:${b}`,foldA='process:'+await sourceId(a,'tool:bash-0'),foldB='process:'+await sourceId(b,'tool:command-0');
 assert.equal(await disclosure(ga).evaluate(d=>d.open),false);assert.equal(await disclosure(gb).evaluate(d=>d.open),false);assert.match(await summary(ga).innerText(),/失败 2/);
 assert.equal(await ga.locator(':scope > .process-latest').innerText(),'echo step-2');assert.equal(await gb.locator(':scope > .process-latest').innerText(),'rg needle file-5');
 for(const el of [ga,gb]){const g=await el.locator(':scope > .process-latest').boundingBox();assert.ok(g.height>0&&g.height<=19);assert.equal(await el.locator('.process-tail:visible').count(),0);}
 await capture('01-two-default-folded-active-groups');check('Claude failure2 and Codex6commands both default closed with exactly one rendered latest line');
 await ga.locator(':scope > .process-latest').evaluate(el=>{globalThis.selectedLatest=el.firstChild;const r=document.createRange();r.setStart(el.firstChild,0);r.setEnd(el.firstChild,4);getSelection().removeAllRanges();getSelection().addRange(r);});
 await emit(a,'tool:bash-2',{kind:'tool',title:'Bash',turnId:'active-claude',status:'complete',input:'{"command":"echo step-2"}',text:'Output changed, original collapsed command unchanged'});await delay(100);
 assert.equal(await page.evaluate(()=>getSelection().toString()),'echo');assert.equal(await ga.locator(':scope > .process-latest').evaluate(el=>el.firstChild===globalThis.selectedLatest),true);await page.evaluate(()=>getSelection().removeAllRanges());
 await emit(a,'tool:bash-3',{kind:'tool',title:'Bash',turnId:'active-claude',status:'complete',input:'{"command":"echo newest"}',text:'Original newest source'});await until(async()=>await ga.locator(':scope > .process-latest').innerText()==='echo newest','Latest original command updated');assert.equal(await disclosure(ga).evaluate(d=>d.open),false);check('Streaming output keeps the selected latest node; a new native step changes one line without opening the group');
 await toggle(gb,true,keyB,foldB);const exploration=await row(b,'tool:command-2');assert.equal(await disclosure(exploration).evaluate(d=>d.open),false);assert.equal(await exploration.locator(':scope > .process-tail').innerText(),'2 次读取 · 2 次搜索');assert.ok((await exploration.locator(':scope > .process-tail').boundingBox()).height<=19);
 await toggle(exploration,true,keyB,await sourceId(b,'tool:command-2'));for(const i of [2,3,4,5])assert.equal(await (await row(b,'tool:command-'+i)).count(),1);
 const last=await row(b,'tool:command-5');await toggle(last,true,keyB,await sourceId(b,'tool:command-5'));assert.equal(await last.locator(':scope > .process-details > .process-content > .message-body').textContent(),'Original Codex step 5\nOriginal detail 5');await copyOriginal(reader(b),await sourceId(b,'tool:command-5'),'Original Codex step 5\nOriginal detail 5');
 await capture('02-explored-open-originals');check('An individual Explored row shows one native-action count line, then all original rows and exact Copy on explicit expansion');
 await toggle(ga,true,keyA,foldA);await toggle(gb,false,keyB,foldB);await page.getByRole('button',{name:'列表',exact:true}).click();await page.getByRole('button',{name:'网格',exact:true}).click();assert.equal(await disclosure(ga).evaluate(d=>d.open),true);assert.equal(await disclosure(gb).evaluate(d=>d.open),false);
 await emit(b,'tool:later',{kind:'tool',title:'Read',turnId:'active-codex',status:'complete',input:'{"file_path":"later.txt"}',text:'Later original record'});await until(async()=>await gb.locator(':scope > .process-latest').innerText()==='later.txt','Closed group follows the new original step');assert.equal(await disclosure(gb).evaluate(d=>d.open),false);
 await emit(b,'tool:web',{kind:'tool',toolKind:'webSearch',title:'Searching fixture query',turnId:'active-codex',status:'running',input:'fixture query',text:'Original web result'});await until(async()=>await gb.locator(':scope > .process-latest').innerText()==='Searching fixture query','Existing native title supplies a latest step when no separate preview exists');
 await emit(a,'turn:end',{kind:'turn',turnId:'active-claude',status:'complete',text:''});await emit(b,'turn:end',{kind:'turn',turnId:'active-codex',status:'complete',text:''});await until(async()=>await ga.getAttribute('data-running')==='false'&&await gb.getAttribute('data-running')==='false','Native completion boundaries observed');assert.equal(await disclosure(ga).evaluate(d=>d.open),true);assert.equal(await disclosure(gb).evaluate(d=>d.open),false);assert.equal(await ga.locator(':scope > .process-latest').isVisible(),false);assert.equal(await gb.locator(':scope > .process-latest').isVisible(),false);check('Manual open and close survive layout and updates; native completion hides latest text while keeping explicit choices');
 await app.close();app=null;await launch();await page.locator('#room-nav').click();ga=await group(a,'tool:bash-0');gb=await group(b,'tool:command-0');await ga.waitFor();await gb.waitFor();assert.equal(await disclosure(ga).evaluate(d=>d.open),true);assert.equal(await disclosure(gb).evaluate(d=>d.open),false);assert.deepEqual(identities(await snapshot()),initial);check('Full app reopen retains the same per-reading-key manual choices, native identities and private drafts');
 // Fresh Solo reading key: both providers independently use the same defaults.
 for(const [id,provider]of [[a,'claude'],[b,'codex']]){await page.locator(`[data-session-id="${id}"]`).click();await fixture('processTurn',id,{turnId:'solo-'+provider,state:'working'});for(let i=0;i<2;i++)await emit(id,'tool:solo-'+i,{kind:'tool',title:'Bash',turnId:'solo-'+provider,status:'complete',input:'{"command":"solo '+provider+' '+i+'"}',text:'Original solo '+provider+' '+i});const g=await group(id,'tool:solo-0',page.locator('#messages'));await g.waitFor();assert.equal(await disclosure(g).evaluate(d=>d.open),false);assert.equal(await g.locator(':scope > .process-latest').innerText(),'solo '+provider+' 1');}
 check('Solo Claude and Codex also default closed and use the existing last-entry preview');
 // Focused key is distinct; search reveals its exact original without saving it.
 await page.locator('#room-nav').click();await page.locator(`.collaboration-member-status[data-member-id="${b}"] .collaboration-member-name`).click();const focused=`collaboration-focus:${b}`,fg=await group(b,'tool:solo-0',page.locator('#messages')),target=await row(b,'tool:solo-1',page.locator('#messages')),fgroup='process:'+await sourceId(b,'tool:solo-0'),ftarget=await sourceId(b,'tool:solo-1');await toggle(fg,true,focused,fgroup);await toggle(target,true,focused,ftarget);await toggle(target,false,focused,ftarget);await toggle(fg,false,focused,fgroup);
 await page.locator('#search-button').click();await page.locator('#search-input').fill('Original solo codex 1');await until(async()=>await page.locator('#search-results button').count()===1,'One original search result');await page.locator('#search-results button').click();await until(()=>target.evaluate(el=>document.activeElement===el),'Exact searched original focused');assert.equal(await disclosure(fg).evaluate(d=>d.open),true);assert.equal(await disclosure(target).evaluate(d=>d.open),true);await delay(80);const saved=(await snapshot()).viewState.readingPositions[focused].folds;assert.equal(saved[fgroup],false);assert.equal(saved[ftarget],false);assert.equal(await page.locator('#approval').evaluate(el=>el.closest('[data-process-group]')===null),true);check('Search reveals original ancestors without changing saved folds; the approval surface remains outside process groups');
 const after=await fixture('stats');for(const name of ['inputs','sends'])assert.equal(after.stats[name],calls.stats[name]);assert.equal(after.overviewCalls.claim,calls.overviewCalls.claim);assert.equal((await snapshot()).diagnostics.dispatches,0);assert.deepEqual(identities(await snapshot()),initial);assert.ok((await snapshot()).sessions.every(s=>fs.realpathSync(s.cwd).startsWith(owned+path.sep)));assert.deepEqual(errors,[]);
 measurements.push({label:'complete-flow-side-effects',before:calls,after,keys:[keyA,keyB,a,b,focused]});
}
run().catch(async e=>{failure=e.stack;process.exitCode=1;console.error(e.stack);if(page)await capture('failure');}).finally(async()=>{try{const sourceAfter=sourceHashes();if(JSON.stringify(sourceAfter)!==JSON.stringify(sourceBefore)){failure||='Source changed';process.exitCode=1;}if(evidence)fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify({flowPassed:!failure,failure,checks,errors,measurements,sourceBefore,sourceAfter,profile,token},null,2));await scratch.release();const held=JSON.parse(fs.readFileSync(path.join(slot,'owner.json')));assert.equal(held.token,token);fs.unlinkSync(path.join(slot,'owner.json'));fs.rmdirSync(slot);if(evidence)fs.writeFileSync(path.join(evidence,'released.json'),JSON.stringify({profile,token,exists:fs.existsSync(profile)},null,2));}catch(e){console.error(e.stack);process.exitCode=1;}});
