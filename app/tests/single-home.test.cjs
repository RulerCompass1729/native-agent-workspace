const test = require('node:test'), assert = require('node:assert/strict');
const spaces = require('../collaboration-spaces.cjs');
const A = '10000000-0000-4000-8000-000000000001', B = '20000000-0000-4000-8000-000000000002';
const original = () => ({ id: 'logical-agent', nativeId: 'original-native', roomId: null, roomIds: [], memberRevision: 0,
  roomMembershipRevisions: {}, owner: 'original-owner', controlRevision: 4, connectionRevision: 7,
  draft: 'Original unsent draft 你好', messages: [{ role: 'user', text: 'Original private history' }],
  goal: { status: 'blocked', objective: 'Original task', createdAt: 1, tokenBudget: null }, nativeSettings: { model: 'native-original', effort: 'ultra' } });

test('one pure move candidate preserves the original agent across independent/A/B/independent', () => {
  const s = original(), a = spaces.withPlacement(s, A), b = spaces.withPlacement(a, B), solo = spaces.withPlacement(b, null);
  assert.deepEqual(spaces.roomIds(s), []); assert.deepEqual(spaces.roomIds(a), [A]); assert.deepEqual(spaces.roomIds(b), [B]); assert.deepEqual(spaces.roomIds(solo), []);
  assert.equal(spaces.placementRevision(a), 1); assert.equal(spaces.placementRevision(b), 2); assert.equal(spaces.placementRevision(solo), 3);
  for (const record of [a, b, solo]) for (const key of ['id', 'nativeId', 'owner', 'controlRevision', 'connectionRevision', 'draft', 'messages', 'goal', 'nativeSettings']) assert.equal(record[key], s[key]);
});
test('departed pair revisions cannot revive grants after A/B/A or shared/A/shared', () => {
  const a = spaces.withPlacement(original(), A), b = spaces.withPlacement(a, B), back = spaces.withPlacement(b, A);
  assert.equal(spaces.membershipRevision(back, A), spaces.membershipRevision(a, A) + 2);
  const shared = spaces.withPlacement(original(), 'shared'), other = spaces.withPlacement(shared, A), rejoined = spaces.withPlacement(other, 'shared');
  assert.equal(rejoined.memberRevision, shared.memberRevision + 2); assert.equal(rejoined.roomId, 'shared');
  assert.equal(spaces.isMember(other, 'shared'), false); assert.equal(other.roomId, null);
});
test('an unchanged placement is a true no-op without invalidating accepted current work', () => {
  const s = original(), a = spaces.withPlacement(s, A); assert.equal(spaces.withPlacement(s, null), s); assert.equal(spaces.withPlacement(a, A), a);
});
test('legacy ambiguous membership is retained and never automatically collapsed', () => {
  const s = spaces.withMembership(spaces.withMembership(original(), A, true), B, true), before = JSON.stringify(s);
  assert.throws(() => spaces.withPlacement(s, A)); assert.throws(() => spaces.withPlacement(s, null)); assert.equal(JSON.stringify(s), before);
});
test('malformed targets/generations fail without changing the original record', () => {
  const s = original(), before = JSON.stringify(s);
  for (const destination of [undefined, '', 'other', '../outside', '__proto__', {}, true]) assert.throws(() => spaces.withPlacement(s, destination));
  for (const placementRevision of [null, -1, '1', 1.5, Number.MAX_SAFE_INTEGER]) assert.throws(() => spaces.withPlacement({ ...s, placementRevision }, A));
  assert.equal(JSON.stringify(s), before);
});

const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events'), { randomUUID } = require('node:crypto');
const { Workspace } = require('../workspace.cjs');
async function backend(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-single-home-'));
  const calls = { starts: 0, sends: 0, stops: 0, interrupts: 0 };
  const host = { binaries: {}, close() {}, create(record) {
    const r = new EventEmitter(); r.record = record;
    r.start = async () => { calls.starts++; r.emit('state', 'idle'); };
    r.send = async () => { calls.sends++; }; r.stop = async () => { calls.stops++; };
    r.interrupt = async () => { calls.interrupts++; }; r.finishTurn = () => {}; return r;
  } };
  const w = new Workspace(host, dir); const id = await w.create('codex', dir, 'owner', 'Synthetic original');
  const s = w.get(id); s.nativeId = 'original-native'; s.connectionRevision = 7;
  s.goal = original().goal; s.nativeSettings = original().nativeSettings;
  s.messages.push({ id: randomUUID(), role: 'user', text: 'Original private input', status: 'complete', time: 1 });
  w.setDraft(id, 'Original unsent draft 你好', 'owner'); w.persist();
  t.after(() => { w.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { w, id, s, dir, host, calls, runtime: w.runtimes.get(id) };
}
const proofFor = (s, operationId = randomUUID()) => ({ nativeId: s.nativeId, revision: spaces.placementRevision(s), connectionRevision: s.connectionRevision || 0, operationId });
const savedSession = (f) => JSON.parse(fs.readFileSync(path.join(f.dir, 'workspace.json'), 'utf8')).sessions.find(s => s.id === f.id);

test('the owning writer publishes A to B once, with no intermediate standalone state or native action', async t => {
  const f = await backend(t), { w, id, s } = f; const before = { nativeId: s.nativeId, goal: s.goal, settings: s.nativeSettings, messages: s.messages, owner: s.owner, draft: w.drafts.get(id) };
  w.moveMembership(id, A, proofFor(s)); const seen = []; w.on('change', () => seen.push(spaces.roomIds(s)));
  let writes = 0; const rename = fs.renameSync; fs.renameSync = function (from, to) { if (to === path.join(f.dir, 'workspace.json')) writes++; return rename.call(this, from, to); };
  let receipt; try { receipt = w.moveMembership(id, B, proofFor(s)); } finally { fs.renameSync = rename; }
  assert.equal(writes, 1); assert.ok(seen.length); assert.ok(seen.every(ids => JSON.stringify(ids) === JSON.stringify([A]) || JSON.stringify(ids) === JSON.stringify([B])));
  assert.deepEqual(spaces.roomIds(s), [B]); assert.deepEqual(spaces.roomIds(savedSession(f)), [B]); assert.deepEqual(savedSession(f).placementReceipt.operationId, receipt.operationId);
  assert.equal(s, f.runtime.record); assert.equal(w.runtimes.get(id), f.runtime); assert.equal(s.nativeId, before.nativeId); assert.equal(s.goal, before.goal); assert.equal(s.nativeSettings, before.settings); assert.equal(s.messages, before.messages); assert.equal(s.owner, before.owner); assert.equal(w.drafts.get(id), before.draft);
  assert.deepEqual(f.calls, { starts: 1, sends: 0, stops: 0, interrupts: 0 });
});
test('same-operation reply-loss recovery returns its durable receipt without applying again', async t => {
  const f = await backend(t), p = proofFor(f.s), first = f.w.moveMembership(f.id, A, p), revision = spaces.placementRevision(f.s);
  const repeated = f.w.moveMembership(f.id, A, p); assert.equal(repeated.operationId, first.operationId); assert.equal(repeated.replayed, true); assert.equal(spaces.placementRevision(f.s), revision);
  assert.throws(() => f.w.moveMembership(f.id, B, p)); assert.deepEqual(spaces.roomIds(f.s), [A]);
});
test('a stale full-placement proof, old undo or native/connection identity cannot move a later placement', async t => {
  const f = await backend(t), stale = proofFor(f.s); f.w.moveMembership(f.id, A, stale); const afterA = proofFor(f.s); f.w.moveMembership(f.id, B, afterA);
  assert.throws(() => f.w.moveMembership(f.id, null, stale)); assert.throws(() => f.w.moveMembership(f.id, A, afterA));
  const current = proofFor(f.s); f.s.connectionRevision++; assert.throws(() => f.w.moveMembership(f.id, null, current));
  const fresh = proofFor(f.s); f.s.nativeId = 'new-native'; assert.throws(() => f.w.moveMembership(f.id, null, fresh)); assert.deepEqual(spaces.roomIds(f.s), [B]);
});
test('an unconfirmed failed workspace write leaves the original in-memory and saved home intact', async t => {
  const f = await backend(t); f.w.moveMembership(f.id, A, proofFor(f.s)); const first = f.s.placementReceipt;
  const rename = fs.renameSync; fs.renameSync = function (from, to) { if (to === path.join(f.dir, 'workspace.json')) throw Error('Synthetic write refusal'); return rename.call(this, from, to); };
  try { assert.throws(() => f.w.moveMembership(f.id, B, proofFor(f.s))); } finally { fs.renameSync = rename; }
  assert.ok(f.w.storageWarning); assert.deepEqual(spaces.roomIds(f.s), [A]); assert.deepEqual(spaces.roomIds(savedSession(f)), [A]); assert.equal(f.s.placementReceipt, first); assert.equal(f.calls.sends, 0);
});
test('a rename that completed before reporting failure is reconciled once rather than replayed', async t => {
  const f = await backend(t); const rename = fs.renameSync;
  fs.renameSync = function (from, to) { const result = rename.call(this, from, to); if (to === path.join(f.dir, 'workspace.json')) throw Error('Synthetic post-rename error'); return result; };
  let result;try { result = f.w.moveMembership(f.id, A, proofFor(f.s)); } finally { fs.renameSync = rename; }
  assert.equal(result.changed, true); assert.ok(f.w.storageWarning); assert.deepEqual(spaces.roomIds(f.s), [A]); assert.deepEqual(savedSession(f).placementReceipt.operationId, result.operationId); assert.equal(f.calls.sends, 0);
});
test('separate room-metadata failure does not misreport the saved placement as unapplied', async t => {
  const f = await backend(t); const rename = fs.renameSync;
  fs.renameSync = function (from, to) { if (to === path.join(f.dir, 'room-records.json')) throw Error('Synthetic separate-room write refusal'); return rename.call(this, from, to); };
  let result;try { result = f.w.moveMembership(f.id, A, proofFor(f.s)); } finally { fs.renameSync = rename; }
  assert.equal(result.changed, true); assert.ok(f.w.storageWarning); assert.deepEqual(spaces.roomIds(f.s), [A]); assert.deepEqual(spaces.roomIds(savedSession(f)), [A]); assert.equal(f.calls.sends, 0);
});
test('cold record reload keeps the saved operation and placement without replaying a native task', async t => {
  const f = await backend(t), result = f.w.moveMembership(f.id, A, proofFor(f.s)); f.w.close();
  const restored = new Workspace(f.host, f.dir);t.after(() => restored.close()); const s = restored.get(f.id);
  assert.deepEqual(spaces.roomIds(s), [A]); assert.equal(s.placementReceipt.operationId, result.operationId); assert.equal(s.nativeId, 'original-native'); assert.equal(restored.drafts.get(f.id), 'Original unsent draft 你好'); assert.equal(f.calls.sends, 0);
});
test('legacy join cannot append a second home, and existing multiple placements are not silently migrated', async t => {
  const f = await backend(t); f.w.join(f.id, true, A); assert.throws(() => f.w.join(f.id, true, B)); assert.deepEqual(spaces.roomIds(f.s), [A]);
  Object.assign(f.s, spaces.withMembership(f.s, B, true)); const before = JSON.stringify(spaces.roomIds(f.s));
  assert.throws(() => f.w.moveMembership(f.id, A, proofFor(f.s))); assert.equal(JSON.stringify(spaces.roomIds(f.s)), before); assert.equal(f.calls.sends, 0);
});

const { RoomState } = require('../room-state.cjs');
function metadataClient(f) {
  const controls = {}, calls = [];
  const client = {
    async call(method, ...args) {
      calls.push({ method, args });
      if (method === 'initial') return { ...f.w.snapshot(), capabilities: controls.capabilities || ['collaborationSpacesV1', 'singleHomeMoveV1', 'guardedSessionStopV1'] };
      if (method === 'moveMembership') { controls.beforeMove?.(); const result = f.w.moveMembership(...args); if (controls.loseReply) { controls.loseReply = false; throw Error('Synthetic lost reply'); } return result; }
      throw Error('Unexpected metadata request');
    },
    async callSpace(room, method) { assert.equal(method, 'pause'); calls.push({ method: 'pauseSpace', args: [room] }); f.w.pauseRoom(room); }
  };
  const state = new RoomState(f.dir), a = state.create('Source A'), b = state.create('Target B');
  return { state, client, a, b, controls, calls };
}
async function cleanupMember(t) {
  const f = await backend(t), m = metadataClient(f);
  await m.state.membership(m.client, f.id, true, 'Original', m.a);
  f.s.state = 'disconnected'; m.calls.length = 0;
  const pauses = [], pause = f.w.pauseRoom.bind(f.w);
  f.w.pauseRoom = (...args) => { pauses.push(args[0]); return pause(...args); };
  const expected = { nativeId: f.s.nativeId, placementRevision: spaces.placementRevision(f.s),
    connectionRevision: f.s.connectionRevision, unusedSuccessor: true };
  return { ...f, ...m, expected, pauses };
}
test('cleanup leave rejects a collaboration that starts after the desktop snapshot before move RPC', async t => {
  const f = await cleanupMember(t), before = JSON.stringify(f.s), metadata = JSON.stringify(f.state.metadata(f.a));
  assert.equal(f.w.rooms.get(f.a).run, null);
  let run;
  f.controls.beforeMove = () => { run = { status: 'running', ids: ['unrelated-member'] }; f.w.rooms.get(f.a).run = run; };
  await assert.rejects(f.state.membership(f.client, f.id, false, 'Original', f.a, f.expected));
  assert.deepEqual(f.pauses, []); assert.equal(JSON.stringify(f.s), before); assert.equal(JSON.stringify(f.state.metadata(f.a)), metadata);
  assert.equal(f.w.rooms.get(f.a).run, run); assert.equal(run.status, 'running');
  assert.equal(f.calls.filter(call => call.method === 'pauseSpace').length, 0);
});
for (const state of ['ended', 'recoverable', 'disconnected']) test(`cleanup leave passes the opt-in proof for an already ${state} unused member`, async t => {
  const f = await cleanupMember(t); f.s.state = state;
  const receipt = await f.state.membership(f.client, f.id, false, 'Original', f.a, f.expected);
  assert.equal(receipt.changed, true); assert.deepEqual(spaces.roomIds(f.s), []);
  assert.equal(f.calls.find(call => call.method === 'moveMembership').args[2].unusedSuccessor, true);
  assert.equal(f.calls.filter(call => call.method === 'pauseSpace').length, 0);
});
for (const blocked of ['spaceGate', 'sessionGate', 'archived', 'merge', 'storeWarning', 'nativeWarning']) test(`cleanup leave retains ${blocked} validation without an eager pause`, async t => {
  const f = await cleanupMember(t);
  if (blocked === 'spaceGate') f.state.gates.add(`room:${f.a}`);
  if (blocked === 'sessionGate') f.state.gates.add(f.id);
  if (blocked === 'archived') f.state.metadata(f.a).archived = true;
  if (blocked === 'merge') f.state.metadata(f.a).merge = { imported: false, stage: 'joining', joins: [], batch: { memberIds: [] } };
  if (blocked === 'storeWarning') f.state.spacesWarning = 'Synthetic metadata warning';
  if (blocked === 'nativeWarning') f.w.storageWarning = 'Synthetic native warning';
  await assert.rejects(f.state.membership(f.client, f.id, false, 'Original', f.a, f.expected));
  assert.deepEqual(spaces.roomIds(f.s), [f.a]); assert.deepEqual(f.pauses, []);
  assert.deepEqual(f.calls.map(call => call.method), blocked === 'storeWarning' ? [] : ['initial']);
});
for (const capabilities of [[], ['singleHomeMoveV1'], ['guardedSessionStopV1']]) test(`cleanup leave refuses unsupported backend without legacy fallback ${capabilities}`, async t => {
  const f = await cleanupMember(t); f.controls.capabilities = capabilities;
  await assert.rejects(f.state.membership(f.client, f.id, false, 'Original', f.a, f.expected));
  assert.deepEqual(spaces.roomIds(f.s), [f.a]); assert.deepEqual(f.pauses, []);
  assert.deepEqual(f.calls.map(call => call.method), ['initial']);
});
for (const state of ['starting', 'idle', 'working']) test(`native cleanup leave refuses a successor that became ${state}`, async t => {
  const f = await cleanupMember(t); f.controls.beforeMove = () => { f.s.state = state; };
  await assert.rejects(f.state.membership(f.client, f.id, false, 'Original', f.a, f.expected));
  assert.deepEqual(spaces.roomIds(f.s), [f.a]); assert.deepEqual(f.pauses, []); assert.equal(f.s.state, state);
});
test('native cleanup leave refuses an active source space without pausing', async t => {
  const f = await cleanupMember(t);
  f.w.rooms.get(f.a).run = { status: 'running', ids: ['unrelated-member'] };
  assert.throws(() => f.w.moveMembership(f.id, null, { ...proofFor(f.s), unusedSuccessor: true }));
  assert.deepEqual(spaces.roomIds(f.s), [f.a]); assert.deepEqual(f.pauses, []); assert.equal(f.w.rooms.get(f.a).run.status, 'running');
});
test('native cleanup flag cannot move a stopped session into another space', async t => {
  const f = await cleanupMember(t);
  assert.throws(() => f.w.moveMembership(f.id, f.b, { ...proofFor(f.s), unusedSuccessor: true }));
  assert.deepEqual(spaces.roomIds(f.s), [f.a]); assert.deepEqual(f.pauses, []);
});
test('desktop cleanup flag cannot join a stopped session to another space', async t => {
  const f = await cleanupMember(t);
  await assert.rejects(f.state.membership(f.client, f.id, true, 'Original', f.b, f.expected));
  assert.deepEqual(spaces.roomIds(f.s), [f.a]); assert.deepEqual(f.pauses, []); assert.deepEqual(f.calls, []);
});
test('ordinary membership still pauses an active space before leaving', async t => {
  const f = await cleanupMember(t); f.w.rooms.get(f.a).run = { status: 'running', ids: ['unrelated-member'] };
  await f.state.membership(f.client, f.id, false, 'Original', f.a);
  assert.deepEqual(spaces.roomIds(f.s), []); assert.equal(f.w.rooms.get(f.a).run.status, 'paused');
  assert.equal(f.calls.filter(call => call.method === 'pauseSpace').length, 1);
});
test('desktop membership uses one owning-backend move and undo restores the prior home', async t => {
  const f = await backend(t), m = metadataClient(f);
  await m.state.membership(m.client, f.id, true, 'Original', m.a);
  const receipt = await m.state.membership(m.client, f.id, true, 'Original', m.b);
  assert.deepEqual(spaces.roomIds(f.s), [m.b]); assert.equal(receipt.previousRoomId, m.a);
  await m.state.membership(m.client, f.id, true, 'Original', m.a, { nativeId: receipt.nativeId, placementRevision: receipt.placementRevision, connectionRevision: receipt.connectionRevision });
  assert.deepEqual(spaces.roomIds(f.s), [m.a]); assert.equal(m.calls.filter(c => c.method === 'moveMembership').length, 3);
  assert.equal(m.state.metadata(m.a).events.filter(e => e.kind === 'leave').length, 1); assert.equal(m.state.metadata(m.b).events.filter(e => e.kind === 'leave').length, 1); assert.equal(f.calls.sends, 0);
});
test('desktop reconciles a lost move reply from the exact stored operation without replay', async t => {
  const f = await backend(t), m = metadataClient(f);m.controls.loseReply = true;
  const receipt = await m.state.membership(m.client, f.id, true, 'Original', m.a);
  assert.equal(receipt.changed, true); assert.deepEqual(spaces.roomIds(f.s), [m.a]);assert.equal(m.calls.filter(c => c.method === 'moveMembership').length, 1);assert.equal(f.calls.sends, 0);
});
test('a different operation reaching the requested target is not an acknowledgement of this move', async t => {
  const f = await backend(t), m = metadataClient(f), call = m.client.call;
  m.client.call = async (method, ...args) => {
    if (method === 'moveMembership') { f.w.moveMembership(args[0], args[1], { ...args[2], operationId: randomUUID() });throw Error('Unconfirmed original operation'); }
    return call(method, ...args);
  };
  await assert.rejects(m.state.membership(m.client, f.id, true, 'Original', m.a), /Unconfirmed original operation/);
  assert.deepEqual(spaces.roomIds(f.s), [m.a]);assert.equal(m.state.metadata(m.a).events.length, 0);assert.equal(f.calls.sends, 0);
});
test('desktop rejects a stale global placement proof even when the destination pair did not change', async t => {
  const f = await backend(t), m = metadataClient(f); const stale = { nativeId: f.s.nativeId, placementRevision: 0, connectionRevision: f.s.connectionRevision };
  await m.state.membership(m.client, f.id, true, 'Original', m.a);
  await assert.rejects(m.state.membership(m.client, f.id, true, 'Original', m.b, stale)); assert.deepEqual(spaces.roomIds(f.s), [m.a]);
});

test('archive/restore rejoins only its exact saved standalone placement and retains the native session', async t => {
  const f = await backend(t), m = metadataClient(f);await m.state.membership(m.client, f.id, true, 'Original', m.a);
  await m.state.archiveRoom(m.client, null, m.a);assert.deepEqual(spaces.roomIds(f.s), []);
  const proof = m.state.metadata(m.a).restorePlacements[f.id];assert.equal(proof.nativeId, 'original-native');
  await m.state.restoreRoom(m.client, null, m.a);assert.deepEqual(spaces.roomIds(f.s), [m.a]);assert.equal(f.s.nativeId, 'original-native');assert.equal(f.calls.sends, 0);
});
test('restoring an old archive cannot steal a session moved elsewhere, including later-returned standalone ABA', async t => {
  for (const standalone of [false, true]) {
    const f = await backend(t), m = metadataClient(f);await m.state.membership(m.client, f.id, true, 'Original', m.a);await m.state.archiveRoom(m.client, null, m.a);
    await m.state.membership(m.client, f.id, true, 'Original', m.b);if (standalone) await m.state.membership(m.client, f.id, false, 'Original', m.b);
    const expected = spaces.roomIds(f.s);await m.state.restoreRoom(m.client, null, m.a);assert.deepEqual(spaces.roomIds(f.s), expected);
    assert.equal(m.state.metadata(m.a).events.at(-1).skippedSessions[0], f.id);assert.equal(f.calls.sends, 0);
  }
});

test('moving an accepted original reply closes its old grant without retargeting later native output', async t => {
 const f=await backend(t),r=f.runtime;r.nativeBlocks=true;
 let tag;r.send=async(_text,value,guard)=>{assert.equal(guard(),true);f.calls.sends++;tag=value;r.emit('submitted',value);};
 f.w.moveMembership(f.id,A,proofFor(f.s));await f.w.forward(f.id,'A shared request','owner','',A);
 r.emit('replyBound',{tag,nativeId:f.s.nativeId,turnId:'native-turn',promptId:'native-prompt'});
 const block=text=>r.emit('nativeBlock',{nativeId:f.s.nativeId,turnId:'native-turn',promptId:'native-prompt',id:'native-reply',kind:'response',text,status:'streaming'});
 block('A original streamed part');const row=f.w.roomFor(A).messages.find(m=>m.role==='assistant');assert.ok(row);assert.equal(row.text,'A original streamed part');
 f.w.moveMembership(f.id,B,proofFor(f.s));assert.equal(f.w.sharedReplies.grants.get(tag).closed,true);
 block('PRIVATE native continuation after move');r.emit('complete',{tag,messageId:'native-reply',text:'PRIVATE final after move'});
 assert.equal(row.text,'A original streamed part');assert.equal(f.w.roomFor(B).messages.length,0);assert.equal(f.calls.sends,1);assert.equal(f.calls.interrupts,0);assert.equal(f.calls.stops,0);assert.equal(f.s.nativeId,'original-native');
});
