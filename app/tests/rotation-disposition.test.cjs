const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events'), { randomUUID } = require('node:crypto');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Workspace } = require('../workspace.cjs'), { RoomState } = require('../room-state.cjs');
const rules = require('../queue-dispatch.cjs');
const NOW = 1_800_000_000_000, AWAKE = { enabled: true };
const control = epoch => ({ kind: 'rotation-request', epoch });
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-rotation-episode-')), writes = [], calls = [];
  const host = { binaries: {}, close() {}, rpc: {} }, w = new Workspace(host, dir);
  const s = { id: 'member-a', nativeId: 'native-a', provider: 'codex', model: 'model-a', view: 'chat', cwd: dir, owner: 'window',
    state: 'idle', createdAt: NOW - 10000, messages: [], fleet: [], roomId: 'shared', roomIds: ['shared'], controlRevision: 0, memberRevision: 0,
    serviceCapabilities: [rules.CAPABILITY, 'rotationControlEpochV1'] };
  const runtime = new EventEmitter(); runtime.host = host; runtime.chatAvailable = true;
  runtime.send = async (text, tag, guard) => { if (!guard()) throw Object.assign(Error('not-sent'), { notSent: true }); writes.push({ text, tag }); runtime.emit('submitted', tag); };
  w.sessions.set(s.id, s); w.runtimes.set(s.id, runtime); w.bind(s, runtime); s.background = 0; s.scheduled = 0;
  const room = new RoomState(dir), client = { snapshot: () => w.snapshot(), refresh: async () => w.snapshot(),
    route: () => ({ client, state: { capabilities: [rules.CAPABILITY, 'rotationControlEpochV1'] } }),
    call: async (method, ...args) => { calls.push([method, ...args]);
      if (method === 'invalidateRotation') return w.invalidateRotation(...args);
      if (method === 'completeRotation') return w.completeRotation(...args);
      if (method === 'releaseRotation') return w.releaseRotation(...args);
      if (method === 'dispatch') return w.send(args[0], args[1], 'naw-dispatcher', null, null, null, null, null, null, null, { itemId: args[3], control: args[4] });
      throw Error('Unexpected control call: ' + method);
    } };
  const dispatcher = new rules.QueueDispatcher({ dataDir: dir, roomState: room, clients: () => client, now: () => NOW, settleMs: 0, tickMs: 3600000 });
  dispatcher.client = client; dispatcher.closed = false;
  t.after(() => { dispatcher.close(); w.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const snapshot = () => w.snapshot().sessions[0];
  const send = async (itemId, purpose) => { const tag = await client.call('dispatch', s.id, 'Synthetic input', s.nativeId, itemId, purpose); s.pendingTag = null; s.state = 'idle'; return tag; };
  return { dir, w, s, runtime, writes, calls, room, client, dispatcher, snapshot, send };
}
function input(s, itemId, tag, epoch = null) { return { id: tag, role: 'user', origin: 'naw-dispatch', dispatchItem: itemId,
  dispatchPurpose: { kind: 'queue', nativeId: s.nativeId, itemId, epoch }, text: 'Synthetic task', status: 'submitted' }; }
function settle(s, tag = 'task-tag', itemId = 'task-a') {
  const item = { id: itemId, text: 'Synthetic task', assignee: null, status: 'sent', createdAt: NOW - 10000, sentAt: NOW - 2000, sentTo: s.id, sentNative: s.nativeId, tag, control: 0 };
  return rules.planDispatch({ rooms: [{ id: 'shared', name: 'Synthetic team', queue: [item] }], sessions: [s],
    wakePolicy: AWAKE, idleSince: new Map([[s.id, NOW - 60000]]), now: NOW }).find(a => a.kind === 'settle');
}
const actor = { kind: 'person', id: 'synthetic-window' };
function disk(f) { return JSON.parse(fs.readFileSync(path.join(f.dir,'workspace.json'))).sessions[0]; }
function fault(f, fn) { const rename=fs.renameSync; fs.renameSync=function(a,b) { if(b===path.join(f.dir,'workspace.json')) throw Object.assign(Error('Synthetic EIO'),{code:'EIO'}); return rename.apply(this,arguments); }; try{return fn();}finally{fs.renameSync=rename;} }
async function invalid(f) { const epoch=randomUUID(),tag=await f.send('rotation:'+f.s.id,control(epoch)); f.w.invalidateRotation(f.s.id,f.s.nativeId,epoch);return {epoch,tag}; }
test('complete is not published before durable success; EIO keeps backend, freshReady and restart blocked',async t=>{
 const f=fixture(t),epoch=randomUUID(),tag=await f.send('rotation:'+f.s.id,control(epoch));f.runtime.emit('complete',{tag,text:'Synthetic handoff'});
 const observed=[];f.w.on('change',()=>observed.push(rules.sessionReady(f.snapshot(),AWAKE).ready));
 const record={phase:'requested',episodeEpoch:epoch,tag,oldId:f.s.id,oldNativeId:f.s.nativeId,oldControl:0,provider:'codex',cwd:f.dir,name:'Synthetic',roomIds:['shared']};f.dispatcher.rotations[f.s.id]=record;
 const pending=fault(f,()=>f.dispatcher.completeEpisode(f.s.id,record));await assert.rejects(pending);
 assert.equal(f.s.rotationEpisode.state,'open');assert.equal(disk(f).rotationEpisode.state,'open');assert.ok(observed.every(x=>!x));
 await f.dispatcher.failRotation(f.s.id,record,'handoff-purpose-unconfirmed',NOW,f.client.snapshot());assert.equal(f.s.rotationEpisode.state,'invalid');
 assert.equal(await f.dispatcher.freshReady(f.s.id,0),null);await assert.rejects(f.send('next-task'));assert.equal(f.writes.length,1);
});
test('explicit release durably fails the original control and enables the same native member without sending input',async t=>{
 const f=fixture(t),p=await invalid(f),before=f.writes.length;
 f.w.releaseRotation(f.s.id,f.s.nativeId,p.epoch,p.tag,actor,'discard-handoff');
 assert.equal(f.writes.length,before);assert.equal(rules.sessionReady(f.snapshot(),AWAKE).ready,true);
 const saved=disk(f);assert.equal(saved.rotationEpisode.state,'released');assert.equal(saved.messages.find(m=>m.id===p.tag).status,'failed');
 assert.deepEqual(saved.messages.find(m=>m.id===p.tag).rotationDisposition.actor,actor);assert.equal(saved.rotationEpisode.disposition.reason,'discard-handoff');
 assert.ok(saved.rotationEpisode.disposition.at>0);
 f.runtime.emit('complete',{tag:p.tag,text:'Synthetic late handoff'});f.runtime.emit('submitted',p.tag);assert.equal(f.s.rotationEpisode.state,'released');
 f.s.recovering=true;require('../native-blocks.cjs').applyCodexHistory(f.s,[{type:'userMessage',id:'native-old',clientId:p.tag,content:[{type:'text',text:'Synthetic original handoff'}]}],f.runtime);
 assert.equal(f.s.messages.find(m=>m.id===p.tag).status,'failed');assert.equal(f.s.messages.find(m=>m.id===p.tag).rotationDisposition.outcome,'failed');f.s.recovering=false;
 await f.send('next-task');assert.equal(f.writes.length,before+1);assert.equal(f.s.nativeId,'native-a');
});
test('release refuses wrong native, epoch, tag or actor and never replays an unknown send',async t=>{
 const f=fixture(t),p=await invalid(f);
 for(const [native,epoch,tag,who] of [['other',p.epoch,p.tag,actor],[f.s.nativeId,randomUUID(),p.tag,actor],[f.s.nativeId,p.epoch,'other-tag',actor],[f.s.nativeId,p.epoch,p.tag,{kind:'agent',id:'not-steward'}]])
  assert.throws(()=>f.w.releaseRotation(f.s.id,native,epoch,tag,who,'discard-handoff'));
 assert.equal(f.s.rotationEpisode.state,'invalid');assert.equal(f.writes.length,1);
});
test('release persistence failure cannot publish readiness or discard the old audit boundary',async t=>{
 const f=fixture(t),p=await invalid(f);assert.throws(()=>fault(f,()=>f.w.releaseRotation(f.s.id,f.s.nativeId,p.epoch,p.tag,actor,'discard-handoff')));
 assert.equal(f.s.rotationEpisode.state,'invalid');assert.equal(disk(f).rotationEpisode.state,'invalid');await assert.rejects(f.send('next-task'));assert.equal(f.writes.length,1);
});
test('coordinator release clears only the matching record, and cannot turn a late handoff into queue done',async t=>{
 const f=fixture(t),p=await invalid(f);f.dispatcher.rotations[f.s.id]={phase:'failed',oldId:f.s.id,oldNativeId:f.s.nativeId,episodeEpoch:p.epoch,tag:p.tag};
 await f.dispatcher.releaseRotation(f.s.id,f.s.nativeId,p.epoch,p.tag,actor,'discard-handoff');assert.equal(f.dispatcher.rotations[f.s.id],undefined);assert.equal(f.writes.length,1);
 f.s.messages.push({role:'assistant',text:'Synthetic old handoff'});
 assert.notEqual(settle(f.snapshot(),p.tag,'new-task')?.status,'done');
});

test('a lost-ACK control can be released after invalidation but is never replayed by release',async t=>{
 const f=fixture(t),epoch=randomUUID(),original=f.runtime.send;
 f.runtime.send=async(text,tag,guard)=>{assert.equal(guard(),true);f.writes.push({text,tag});f.runtime.emit('submitted',tag);throw Error('Synthetic lost ACK');};
 await assert.rejects(f.send('rotation:'+f.s.id,control(epoch)));const tag=f.s.rotationEpisode.tag;assert.equal(f.s.rotationEpisode.state,'open');
 f.w.invalidateRotation(f.s.id,f.s.nativeId,epoch);f.w.releaseRotation(f.s.id,f.s.nativeId,epoch,tag,actor,'discard-unknown-handoff');
 assert.equal(f.writes.length,1);f.w.invalidateRotation(f.s.id,f.s.nativeId,epoch);assert.equal(f.s.rotationEpisode.state,'released');
 f.runtime.send=original;await f.send('new-task');assert.equal(f.writes.length,2);
});

test('a durable release receipt repairs a coordinator left behind by a lost release response',async t=>{
 const f=fixture(t),p=await invalid(f);f.dispatcher.rotations[f.s.id]={phase:'failed',oldId:f.s.id,oldNativeId:f.s.nativeId,episodeEpoch:p.epoch,tag:p.tag};
 f.w.releaseRotation(f.s.id,f.s.nativeId,p.epoch,p.tag,actor,'discard-handoff');
 await f.dispatcher.advanceRotations(f.client.snapshot(),NOW);assert.equal(f.dispatcher.rotations[f.s.id],undefined);assert.equal(f.writes.length,1);
});
