const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const DAY = 86400000, NOW = Date.now(), dead = { pid: 2 ** 30, started: 'synthetic exited owner' };
function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'naw-temp-reminder-test-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const dataDir = path.join(base, 'profile'), registryDir = path.join(base, 'registry'); fs.mkdirSync(dataDir, { mode: 0o700 });
  const ownership = require('../temp-ownership.cjs'), { TempReminders } = require('../temp-reminders.cjs');
  let clock = NOW, system = { opened: [], mounted: [] }, alive = false;
  const manager = new TempReminders({ dataDir, registryDir, roots: [base], now: () => clock,
    inspect: async () => { if (system instanceof Error) throw system; return system; }, isAlive: () => alive, isPerson: c => c.person === true });
  function candidate(name = 'owned', days = 8) {
    const dir = fs.mkdtempSync(path.join(base, name)); fs.writeFileSync(path.join(dir, 'data'), 'synthetic temporary data');
    ownership.register(dir, { registryDir, now: () => NOW - days * DAY, owner: dead });
    for (const p of [path.join(dir, 'data'), dir]) fs.utimesSync(p, new Date(NOW-days*DAY), new Date(NOW-days*DAY));
    return dir;
  }
  return { base, registryDir, manager, candidate, ownership, time: x => { clock = x; }, system: x => { system = x; }, alive: x => { alive = x; } };
}
test('a creation receipt survives its producer and an unregistered naw-looking directory is excluded', async t => {
  const f = fixture(t), owned = f.candidate(), unknown = fs.mkdtempSync(path.join(f.base, 'naw-unregistered-'));
  fs.utimesSync(unknown, new Date(NOW-9*DAY), new Date(NOW-9*DAY));
  const status = await f.manager.status(); assert.equal(status.directories,1); assert.equal(status.shown,true);
  assert.ok(f.ownership.read(f.registryDir).some(r=>r.path===fs.realpathSync(owned)));
  const modulePath = require.resolve('../temp-ownership.cjs');
  const result = spawnSync(process.execPath, ['-e', 'const x=require(process.argv[1]).read(process.argv[2]); console.log(x.length)', modulePath, f.registryDir], { encoding:'utf8' });
  assert.equal(result.status,0); assert.equal(result.stdout.trim(),'1','A new process can read the durable receipt');
});
test('young, live, open, mounted, symlinked, and changed-identity directories are never offered', async t => {
  const f=fixture(t), dir=f.candidate();
  f.alive(true); assert.equal((await f.manager.status(true)).directories,0); f.alive(false);
  f.system({opened:[path.join(dir,'data')],mounted:[]}); assert.equal((await f.manager.status(true)).directories,0);
  f.system({opened:[],mounted:[dir]}); assert.equal((await f.manager.status(true)).directories,0);
  f.system({opened:[],mounted:[f.base]}); assert.equal((await f.manager.status(true)).directories,0);
  f.system({opened:[],mounted:[]}); fs.utimesSync(path.join(dir,'data'),new Date(NOW),new Date(NOW)); assert.equal((await f.manager.status(true)).directories,0);
  fs.utimesSync(path.join(dir,'data'),new Date(NOW-8*DAY),new Date(NOW-8*DAY));
  fs.symlinkSync(f.base,path.join(dir,'link')); assert.equal((await f.manager.status(true)).directories,0);
  fs.unlinkSync(path.join(dir,'link')); fs.renameSync(dir,dir+'-original'); fs.mkdirSync(dir); assert.equal((await f.manager.status(true)).directories,0);
});
test('only the displayed snapshot is cleaned; newly opened files and new candidates are kept', async t => {
  const f=fixture(t), first=f.candidate('first'), busy=f.candidate('busy'), c={person:true};
  const presented=await f.manager.present(c); const later=f.candidate('later');
  f.system({opened:[path.join(busy,'data')],mounted:[]});
  const result=await f.manager.clean(c,presented.ticket);
  assert.equal(result.cleaned,1); assert.equal(result.skipped,1); assert.ok(result.bytes>0);
  assert.equal(fs.existsSync(first),false); assert.ok(fs.existsSync(busy)); assert.ok(fs.existsSync(later));
  await assert.rejects(f.manager.clean(c,presented.ticket),/snapshot/i,'A cleanup ticket is single-use');
});
test('agent and butler contexts cannot present or clean, including a stolen person ticket', async t => {
  const f=fixture(t), dir=f.candidate(), person={person:true}, agent={person:false};
  const snapshot=await f.manager.present(person);
  await assert.rejects(f.manager.present(agent),/person/i);
  await assert.rejects(f.manager.clean(agent,snapshot.ticket),/person/i);
  await assert.rejects(f.manager.clean({person:true},snapshot.ticket),/snapshot/i);
  assert.ok(fs.existsSync(dir));
});
test('acknowledgement persists, then another seven days or another half GiB makes the reminder due', async t => {
  const f=fixture(t); f.candidate(); const c={person:true};
  let s=await f.manager.present(c); await f.manager.acknowledge(c,s.ticket);
  assert.equal((await f.manager.status(true)).shown,false);
  f.time(NOW+6*DAY); assert.equal((await f.manager.status(true)).shown,false);
  f.time(NOW+7*DAY); assert.equal((await f.manager.status(true)).shown,true);
  const publicState=JSON.parse(fs.readFileSync(path.join(f.base,'profile','temp-reminders.json')));
  assert.equal(publicState.reminder.id,'naw-temp-files'); assert.ok(publicState.reminder.version>=1);
  assert.equal(JSON.stringify(publicState.reminder).includes(f.base),false,'The shared phone summary has no filesystem paths');
});
test('failed inspection is a visible new anomaly and never permission to delete', async t => {
  const f=fixture(t), dir=f.candidate(), c={person:true}, before=await f.manager.present(c);
  const acknowledged=await f.manager.acknowledge(c,before.ticket); f.system(Error('synthetic lsof unavailable'));
  const status=await f.manager.status(true); assert.equal(status.shown,true); assert.equal(status.anomaly,'inspection-unavailable');
  const result=await f.manager.clean(c,acknowledged.ticket); assert.equal(result.cleaned,0); assert.ok(fs.existsSync(dir));
});
test('a changed subtree and mounted/open files discovered at execution fail closed', async t => {
  const f=fixture(t), dir=f.candidate(), c={person:true}, shown=await f.manager.present(c);
  fs.writeFileSync(path.join(dir,'new'),'new data after display');
  const result=await f.manager.clean(c,shown.ticket); assert.equal(result.cleaned,0); assert.equal(result.skipped,1); assert.ok(fs.existsSync(dir));
});
test('the deletion helper independently refuses a genuinely open file even if the first inspection missed it', async t => {
  const f=fixture(t), dir=f.candidate(), c={person:true}, shown=await f.manager.present(c);
  const fd=fs.openSync(path.join(dir,'data'),'r'); t.after(()=>fs.closeSync(fd));
  const result=await f.manager.clean(c,shown.ticket);
  assert.equal(result.cleaned,0); assert.equal(result.skipped,1); assert.ok(fs.existsSync(path.join(dir,'data')));
});
test('half-GiB and seven-day reminder thresholds use inclusive boundaries and acknowledged growth', () => {
  const {shouldShow,LINE}=require('../temp-reminders.cjs'); assert.equal(LINE,536870912);
  const fresh={bytes:LINE-1,oldestAt:NOW-2*DAY,anomaly:null};
  assert.equal(shouldShow(fresh,null,NOW),false); assert.equal(shouldShow({...fresh,bytes:LINE},null,NOW),true);
  assert.equal(shouldShow({...fresh,oldestAt:NOW-7*DAY},null,NOW),true);
  const ack={bytes:LINE,age:8*DAY,anomaly:null};
  assert.equal(shouldShow({...fresh,bytes:2*LINE-1},ack,NOW),false);
  assert.equal(shouldShow({...fresh,bytes:2*LINE},ack,NOW),true);
});
test('a cached ordinary status performs at most one scan per day; a person refresh is explicit', async t => {
  const f=fixture(t); f.candidate(); let reads=0; f.manager.inspect=async()=>{reads++;return {opened:[],mounted:[]};};
  await f.manager.status(); await f.manager.status(); assert.equal(reads,1);
  f.time(NOW+DAY-1); await f.manager.status(); assert.equal(reads,1);
  f.time(NOW+DAY); await f.manager.status(); assert.equal(reads,2);
  await f.manager.present({person:true},true); assert.equal(reads,3);
});
test('the actual records IPC handler refuses a background agent before reaching cleanup', async () => {
  const vm=require('node:vm'), main=fs.readFileSync(path.join(__dirname,'..','main.cjs'),'utf8');
  const start=main.indexOf("register('records',"), end=main.indexOf("applicationHandlers.delete('records');",start);
  const predicate=main.slice(main.indexOf('function isCurrentHumanContext('),main.indexOf('function showDialog('));
  let handler, calls=0;
  const win={isDestroyed:()=>false,webContents:{id:1}}, human={win,background:false}, agent={win,background:true};
  vm.runInNewContext(predicate+'\n'+main.slice(start,end),{windows:new Map([[1,human]]),register:(_n,h)=>{handler=h;},uiError:key=>Error(key),tempReminders:{clean:()=>{calls++;}},Date});
  await assert.rejects(handler(agent,'tempClean','stolen-ticket'),/personOnly/); assert.equal(calls,0);
  assert.ok(main.includes("applicationHandlers.delete('records');"));
});
test('an orphaned test creator cannot make a live service profile eligible', async t => {
  const f=fixture(t), dir=f.candidate();
  const file=path.join(dir,'service.lock');fs.writeFileSync(file,JSON.stringify({pid:process.pid}));
  for(const p of [file,dir]) fs.utimesSync(p,new Date(NOW-8*DAY),new Date(NOW-8*DAY));
  assert.equal((await f.manager.status()).directories,0);
});
test('after a cleanup receipt is received, a state-write failure preserves actual completion in the person reply', async t => {
  const f=fixture(t),dir=f.candidate(),c={person:true},shown=await f.manager.present(c);
  const save=f.manager.save;
  f.manager.save=()=>{throw Error('synthetic disk full');};
  const result=await f.manager.clean(c,shown.ticket);
  assert.equal(result.cleaned,1);assert.equal(result.skipped,0);assert.equal(result.bookkeepingFailed,true);assert.equal(fs.existsSync(dir),false);
  f.manager.save=save;await f.manager.status(true);
  assert.equal(require('../temp-reminders.cjs').readSummary(path.join(f.base,'profile')).result.cleaned,1,'The confirmed result reaches the shared source when writing recovers');
});
test('the shared mobile summary contains only safe reminder metadata and the actual result', async t => {
  const f=fixture(t);f.candidate();await f.manager.status();
  const {readSummary}=require('../temp-reminders.cjs'),summary=readSummary(path.join(f.base,'profile'));
  assert.equal(summary.id,'naw-temp-files');assert.equal(summary.directories,1);assert.equal(summary.version,1);
  assert.equal(JSON.stringify(summary).includes(f.base),false);assert.equal(Object.hasOwn(summary,'ticket'),false);assert.equal(Object.hasOwn(summary,'ack'),false);
});
test('a dismissed inspection anomaly reappears when it recurs after a healthy scan', async t => {
  const f=fixture(t),old=f.candidate(),c={person:true}; f.system(Error('synthetic inspection failure'));
  const failure=await f.manager.present(c);await f.manager.acknowledge(c,failure.ticket);
  fs.rmSync(old,{recursive:true}); f.candidate('young-',2);f.system({opened:[],mounted:[]});
  assert.equal((await f.manager.status(true)).shown,false);
  f.system(Error('synthetic inspection failure'));
  assert.equal((await f.manager.status(true)).shown,true);
});
test('creator identity remains live across a change of timezone', async t => {
  const f=fixture(t),dir=fs.mkdtempSync(path.join(f.base,'live-owner-'));
  const previous=process.env.TZ;
  try {
    process.env.TZ='Pacific/Honolulu';f.ownership.register(dir,{registryDir:f.registryDir,now:()=>NOW-8*DAY});
    if(previous===undefined)delete process.env.TZ;else process.env.TZ=previous;
    fs.utimesSync(dir,new Date(NOW-8*DAY),new Date(NOW-8*DAY));
    const {TempReminders}=require('../temp-reminders.cjs');
    const manager=new TempReminders({dataDir:path.join(f.base,'profile'),registryDir:f.registryDir,roots:[f.base],now:()=>NOW,inspect:async()=>({opened:[],mounted:[]}),isPerson:()=>true});
    assert.equal((await manager.status()).directories,0);
  } finally {if(previous===undefined)delete process.env.TZ;else process.env.TZ=previous;}
});
test('a second person window refreshing does not invalidate acknowledgement of the same reminder', async t => {
  const f=fixture(t);f.candidate();const first={person:true},second={person:true};
  const shown=await f.manager.present(first);await f.manager.present(second,true);
  assert.equal((await f.manager.acknowledge(first,shown.ticket)).shown,false);
});
test('a damaged shared result is unavailable, never silently reported as zero completed work', async t => {
  const f=fixture(t);f.candidate();await f.manager.status();
  const file=path.join(f.base,'profile','temp-reminders.json'),state=JSON.parse(fs.readFileSync(file,'utf8'));
  state.reminder.result={at:NOW,cleaned:'unknown',bytes:0,skipped:0};fs.writeFileSync(file,JSON.stringify(state));
  assert.throws(()=>require('../temp-reminders.cjs').readSummary(path.join(f.base,'profile')),/Invalid cleanup result/);
});
test('closing the person window preserves confirmed partial cleanup and skips the remaining snapshot', async t => {
  const f=fixture(t);f.candidate('one-');f.candidate('two-');f.candidate('three-');const c={person:true};
  const shown=await f.manager.present(c),first=f.manager.candidates[0].record.path;let checks=0;
  f.manager.inspect=async()=>{if(++checks===2)c.person=false;return {opened:[],mounted:[]};};
  let result;
  try {result=await f.manager.clean(c,shown.ticket);}
  catch(error) {
    const stored=JSON.parse(fs.readFileSync(path.join(f.base,'profile','temp-reminders.json'),'utf8')).reminder.result;
    console.log('PARTIAL-CLEANUP first directory removed='+!fs.existsSync(first)+'; stored result='+JSON.stringify(stored));throw error;
  }
  assert.equal(result.cleaned,1);assert.equal(result.skipped,2);
  assert.equal(require('../temp-reminders.cjs').readSummary(path.join(f.base,'profile')).result.cleaned,1);
});

test('unchanged refresh keeps the displayed cleanup ticket; a changed snapshot replaces it', async t => {
 const f=fixture(t);f.candidate();const c={person:true};
 const first=await f.manager.present(c),again=await f.manager.present(c);
 assert.equal(again.ticket,first.ticket,'A count-only bell refresh must not revoke the displayed cleanup');
 f.time(NOW+1000);const rescanned=await f.manager.present(c,true);assert.equal(rescanned.ticket,first.ticket,'A scan with identical contents keeps its ticket');
 f.candidate('another');const changed=await f.manager.present(c,true);assert.notEqual(changed.ticket,first.ticket);
 await assert.rejects(f.manager.clean(c,first.ticket),/snapshot/i);
});
