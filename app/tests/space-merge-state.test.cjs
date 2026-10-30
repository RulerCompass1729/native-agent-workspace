const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { RoomState } = require('../room-state.cjs');
const { withMembership, isMember, membershipRevision } = require('../collaboration-spaces.cjs');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-merge-state-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const state = new RoomState(directory), a = state.create('A'), b = state.create('B');
  const sessions = new Map(['s', 't'].map(id => [id, withMembership(withMembership({ id, provider: 'codex', name: id,
    nativeId: `native-${id}`, roomId: null, controlRevision: 1, connectionRevision: 1,
    liveDraft: 'UNSENT PRIVATE', goal: { status: 'blocked' } }, a, true), b, true)]));
  const rooms = new Map([a, b].map((id, i) => [id, { id, revision: 1, run: null, messages: [
    { id: `original-${i}`, role: 'assistant', sessionId: 's', nativeId: 'native-s', text: `Exact original ${i}`, status: 'complete', time: i + 1 } ] }]));
  const controls = {}, calls = [], counters = { imports: 0, sends: 0, inputs: 0 };
  const ensureRoom = id => { if (!rooms.has(id)) rooms.set(id, { id, revision: 0, run: null, messages: [] }); return rooms.get(id); };
  const client = {
    async call(method, ...args) {
      calls.push({ method, args: structuredClone(args) });
      if (method === 'initial') return structuredClone({ capabilities: controls.old ? [] : ['collaborationSpacesV1', 'spaceMergeV1'],
        sessions: [...sessions.values()], rooms: [...rooms.values()], room: { id: 'shared', revision: 0, messages: [] }, storageWarning: controls.warning || null });
      if (method === 'mergeSnapshot') {
        counters.imports++; const batch = args[0];
        if (controls.beforeImport) await controls.beforeImport(batch);
        if (controls.failImport) throw Error('Synthetic target write failure');
        const room = ensureRoom(batch.targetId);
        const marker = room.snapshotBatches?.find(record => record.operationId === batch.operationId);
        if (!marker) {
          room.messages.push(...batch.blocks.flatMap(block => block.entries).map((entry, index) => ({ ...structuredClone(entry.payload),
            id: `snapshot:${batch.operationId}:${index}`, snapshotBatch: batch.operationId,
            snapshotOrigin: structuredClone(entry.origin), snapshotHash: entry.hash })));
          room.snapshotBatches = [{ operationId: batch.operationId, binding: batch.binding }];
        }
        if (controls.dropRow) room.messages.pop();
        if (controls.afterImport) await controls.afterImport(batch);
        return { operationId: batch.operationId, binding: batch.binding, persisted: true };
      }
      throw Error('Unexpected synthetic client operation');
    },
    async callSpace(roomId, method, args) {
      calls.push({ roomId, method, args: structuredClone(args) });
      if (method === 'pause') { const run = rooms.get(roomId)?.run; if (run) run.status = 'paused'; return; }
      assert.equal(method, 'join');
      const [id, joined, expected] = args, session = sessions.get(id);
      if (controls.failLeave === roomId && !joined) throw Error('Synthetic source detach failure');
      if (controls.failJoin && joined && ![a, b].includes(roomId)) throw Error('Synthetic target member failure');
      if (expected && (expected.nativeId !== session.nativeId || expected.revision !== membershipRevision(session, roomId))) throw Error('Synthetic stale identity');
      sessions.set(id, withMembership(session, roomId, joined)); ensureRoom(roomId);
    },
  };
  const preview = extra => state.mergePreview(client, { sourceIds: [a, b], name: 'New C', memberIds: ['s', 't'], disposition: 'keep', ...extra });
  return { state, directory, a, b, sessions, rooms, controls, counters, calls, client, preview };
}

test('preview is read-only and commit saves a new independent C without changing original native IDs, private drafts or run', async t => {
  const f = fixture(t), before = fs.readFileSync(f.state.spacesFile, 'utf8'), original = JSON.stringify([...f.sessions.values()]);
  f.rooms.get(f.a).run = { id: 'original-run', status: 'running' };
  const batch = await f.preview();
  assert.equal(fs.readFileSync(f.state.spacesFile, 'utf8'), before); assert.equal(f.counters.imports, 0);
  const result = await f.state.mergeCommit(f.client, batch.operationId, batch.binding);
  assert.equal(result.stage, 'ready'); assert.equal(f.counters.imports, 1);
  assert.equal(f.rooms.get(batch.targetId).messages.length, 2); assert.equal(f.rooms.get(f.a).run.status, 'running');
  for (const session of f.sessions.values()) {
    assert.equal(session.nativeId, `native-${session.id}`); assert.equal(session.liveDraft, 'UNSENT PRIVATE'); assert.equal(session.goal.status, 'blocked');
    assert.equal(isMember(session, f.a), true); assert.equal(isMember(session, f.b), true); assert.equal(isMember(session, batch.targetId), true);
  }
  assert.equal(f.counters.sends, 0); assert.equal(f.counters.inputs, 0); assert.notEqual(JSON.stringify([...f.sessions.values()]), original, 'Only membership references changed');
});
test('target metadata save failure prevents import and all source archive/detach', async t => {
  const f = fixture(t), batch = await f.preview({ disposition: 'archive' });
  t.mock.method(f.state, 'write', () => { throw Error('Synthetic profile write failure'); });
  await assert.rejects(f.state.mergeCommit(f.client, batch.operationId, batch.binding), /profile write failure/);
  assert.equal(f.counters.imports, 0); assert.equal(f.calls.some(call => call.method === 'pause'), false);
  assert.equal(f.state.metadata(f.a).archived, false);
});
test('target backend failure or missing copied row leaves sources intact and C unavailable', async t => {
  for (const mode of ['failImport', 'dropRow']) {
    const f = fixture(t), batch = await f.preview({ disposition: 'archive' }); f.controls[mode] = true;
    await assert.rejects(f.state.mergeCommit(f.client, batch.operationId, batch.binding));
    assert.equal(f.state.metadata(f.a).archived, false); assert.equal(f.state.metadata(f.b).archived, false);
    assert.equal(f.calls.some(call => call.method === 'join' && call.args[1] === false), false);
    assert.throws(() => f.state.assertAvailable(null, true, batch.targetId), /合并步骤/);
  }
});
test('archive completes without queue reentry deadlock, only after verified target save, and records each source', { timeout: 1000 }, async t => {
  const f = fixture(t), batch = await f.preview({ disposition: 'archive' });
  const result = await f.state.mergeCommit(f.client, batch.operationId, batch.binding);
  assert.equal(result.stage, 'ready'); assert.ok(result.sources.every(source => source.status === 'done'));
  assert.equal(f.state.metadata(f.a).archived, true); assert.equal(f.state.metadata(f.b).archived, true);
  const importedAt = f.calls.findIndex(call => call.method === 'mergeSnapshot');
  const detachedAt = f.calls.findIndex(call => call.method === 'join' && call.args[1] === false);
  assert.ok(importedAt >= 0 && detachedAt > importedAt);
  assert.equal(f.rooms.get(batch.targetId).messages.length, 2);
});
test('one source archive failure is partial; repeated same operation does not re-import or retry source actions', async t => {
  const f = fixture(t), batch = await f.preview({ disposition: 'archive' }); f.controls.failLeave = f.a;
  const result = await f.state.mergeCommit(f.client, batch.operationId, batch.binding);
  assert.equal(result.stage, 'partial'); assert.equal(result.sources[0].status, 'failed'); assert.equal(result.sources[1].status, 'done');
  const before = f.calls.length;
  assert.deepEqual(await f.state.mergeCommit(f.client, batch.operationId, batch.binding), result);
  assert.equal(f.calls.length, before); assert.equal(f.counters.imports, 1);
  f.controls.failLeave = null;
  const continued = await f.state.mergeCommit(f.client, batch.operationId, batch.binding, true);
  assert.equal(continued.stage, 'ready'); assert.equal(f.counters.imports, 1);
  assert.equal(f.state.metadata(f.a).archived, true);
});
test('cold metadata reopen preserves partial operation and returns its state without replay', async t => {
  const f = fixture(t), batch = await f.preview({ disposition: 'archive' }); f.controls.failLeave = f.b;
  await f.state.mergeCommit(f.client, batch.operationId, batch.binding);
  const reopened = new RoomState(f.directory), before = f.calls.length;
  const result = await reopened.mergeCommit(f.client, batch.operationId, batch.binding);
  assert.equal(result.stage, 'partial'); assert.equal(f.calls.length, before); assert.equal(f.counters.imports, 1);
  assert.equal((await reopened.mergeStatus(f.client, batch.operationId)).observedSaved, true);
});
test('identity, stale selected source, native alias, and old backend refuse before creating C', async t => {
  for (const mode of ['stale', 'identity', 'alias', 'old']) {
    const f = fixture(t);
    if (mode === 'alias') f.sessions.get('t').nativeId = f.sessions.get('s').nativeId;
    const batch = await f.preview();
    if (mode === 'stale') f.rooms.get(f.a).messages[0].text = 'changed after preview';
    if (mode === 'identity') f.sessions.get('s').nativeId = 'replacement';
    if (mode === 'old') f.controls.old = true;
    await assert.rejects(f.state.mergeCommit(f.client, batch.operationId, batch.binding));
    assert.equal(f.counters.imports, 0); assert.equal(f.state.spaces.rooms.length, 2);
  }
});
test('a failed import can be explicitly recovered but restart alone never replays it', async t => {
  const f = fixture(t), batch = await f.preview(); f.controls.failImport = true;
  await assert.rejects(f.state.mergeCommit(f.client, batch.operationId, batch.binding));
  const reopened = new RoomState(f.directory), before = f.counters.imports;
  assert.equal((await reopened.mergeCommit(f.client, batch.operationId, batch.binding)).stage, 'failed');
  assert.equal(f.counters.imports, before);
  f.controls.failImport = false;
  assert.equal((await reopened.mergeCommit(f.client, batch.operationId, batch.binding, true)).stage, 'ready');
  assert.equal(f.counters.imports, before + 1);
});
test('undo with later C notes, message and membership preserves them and all imported originals', async t => {
  const f = fixture(t), batch = await f.preview({ disposition: 'archive' });
  await f.state.mergeCommit(f.client, batch.operationId, batch.binding);
  f.state.notes('Later C notes', f.state.metadata(batch.targetId).revision, batch.targetId);
  f.rooms.get(batch.targetId).messages.push({ id: 'later', role: 'human', text: 'Later original C message', status: 'submitted' });
  const before = JSON.stringify(f.rooms.get(batch.targetId).messages);
  const result = await f.state.mergeUndo(f.client, batch.operationId, batch.binding);
  assert.equal(result.stage, 'undone'); assert.equal(result.undoKeptTarget, true);
  assert.equal(f.state.metadata(batch.targetId).archived, false); assert.equal(f.state.metadata(batch.targetId).notes, 'Later C notes');
  assert.equal(JSON.stringify(f.rooms.get(batch.targetId).messages), before);
  assert.equal(f.state.metadata(f.a).archived, false); assert.equal(f.state.metadata(f.b).archived, false);
  for (const session of f.sessions.values()) for (const roomId of [f.a, f.b, batch.targetId]) assert.equal(isMember(session, roomId), true);
  assert.equal(f.counters.imports, 1); assert.equal(f.counters.sends, 0);
});
test('undo without later work archives C and restores sources without old run or replay', { timeout: 1000 }, async t => {
  const f = fixture(t); f.rooms.get(f.a).run = { id: 'old-run', status: 'running' };
  const batch = await f.preview({ disposition: 'archive' }); await f.state.mergeCommit(f.client, batch.operationId, batch.binding);
  const result = await f.state.mergeUndo(f.client, batch.operationId, batch.binding);
  assert.equal(result.stage, 'undone'); assert.equal(result.undoKeptTarget, false); assert.equal(f.state.metadata(batch.targetId).archived, true);
  assert.equal(f.rooms.get(f.a).run.status, 'paused'); assert.equal(f.state.metadata(f.a).archived, false);
  assert.equal(f.rooms.get(batch.targetId).messages.length, 2); assert.equal(f.counters.imports, 1);
  assert.equal((await f.state.mergeCommit(f.client, batch.operationId, batch.binding, true)).stage, 'undone');
});
test('a saved unsent C draft supplied by the trusted window guard retains C even when it has no sent work', async t => {
  const f = fixture(t), batch = await f.preview({ disposition: 'archive' });
  await f.state.mergeCommit(f.client, batch.operationId, batch.binding);
  const before = JSON.stringify(f.rooms.get(batch.targetId).messages);
  const result = await f.state.mergeUndo(f.client, batch.operationId, batch.binding, true);
  assert.equal(result.stage, 'undone'); assert.equal(result.undoKeptTarget, true);
  assert.equal(f.state.metadata(batch.targetId).archived, false); assert.equal(JSON.stringify(f.rooms.get(batch.targetId).messages), before);
  assert.equal(f.state.metadata(f.a).archived, false);
});
test('undo refuses to overwrite subsequently changed source metadata or native identity', async t => {
  const f = fixture(t), batch = await f.preview({ disposition: 'archive' }); await f.state.mergeCommit(f.client, batch.operationId, batch.binding);
  f.state.notes('Changed archived source', f.state.metadata(f.a).revision, f.a);
  f.sessions.get('s').nativeId = 'new-native-context';
  const result = await f.state.mergeUndo(f.client, batch.operationId, batch.binding);
  assert.equal(result.stage, 'partial'); assert.ok(result.failures.length > 0);
  assert.equal(f.state.metadata(f.a).notes, 'Changed archived source'); assert.equal(f.state.metadata(f.a).archived, true);
  assert.equal(f.sessions.get('s').nativeId, 'new-native-context');
});
test('source notes and same-name references are retained separately without reading or moving originals', async t => {
  const f = fixture(t);
  f.state.notes('A original note', f.state.metadata(f.a).revision, f.a); f.state.notes('B original note', f.state.metadata(f.b).revision, f.b);
  f.state.addFiles(['/synthetic/a/same.md'], f.a); f.state.addFiles(['/synthetic/b/same.md'], f.b);
  const batch = await f.preview(); await f.state.mergeCommit(f.client, batch.operationId, batch.binding);
  const target = f.state.metadata(batch.targetId); assert.equal(target.notes, ''); assert.equal(target.files.length, 2);
  assert.notEqual(target.files[0].id, target.files[1].id); assert.notEqual(target.files[0].path, target.files[1].path);
  const view = f.state.apply(await f.client.call('initial'), batch.targetId);
  assert.deepEqual(view.room.merge.notes.map(note => note.text), ['A original note', 'B original note']);
});
test('concurrent identical commit shares one operation, a different binding rejects, and target edits remain drafts while pending', async t => {
  const f = fixture(t), batch = await f.preview(); let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  f.controls.beforeImport = async () => { started(); await new Promise(resolve => { release = resolve; }); };
  const one = f.state.mergeCommit(f.client, batch.operationId, batch.binding); await entered;
  const two = f.state.mergeCommit(f.client, batch.operationId, batch.binding);
  await assert.rejects(f.state.mergeCommit(f.client, batch.operationId, 'different'));
  await assert.rejects(f.state.mergeUndo(f.client, batch.operationId, batch.binding), /新的操作暂未执行/);
  assert.throws(() => f.state.notes('Pending draft', f.state.metadata(batch.targetId).revision, batch.targetId), /草稿/);
  release(); assert.deepEqual(await one, await two); assert.equal(f.counters.imports, 1);
});
test('clearing C also removes imported payloads from profile metadata and cannot replay the old operation', async t => {
  const f = fixture(t), batch = await f.preview(); await f.state.mergeCommit(f.client, batch.operationId, batch.binding);
  const originalA = JSON.stringify(f.rooms.get(f.a).messages), sourceBody = 'Exact original 0';
  assert.ok(fs.readFileSync(f.state.spacesFile, 'utf8').includes(sourceBody));
  f.state.clear(f.state.metadata(batch.targetId).revision, batch.targetId);
  assert.equal(fs.readFileSync(f.state.spacesFile, 'utf8').includes(sourceBody), false);
  assert.equal(f.state.metadata(batch.targetId).merge, undefined);
  assert.equal(JSON.stringify(f.rooms.get(f.a).messages), originalA);
  await assert.rejects(f.state.mergeCommit(f.client, batch.operationId, batch.binding)); assert.equal(f.counters.imports, 1);
});
test('a partially failed target archive during undo is recorded and a manual retry does not mistake its own changes for later user work', async t => {
  const f = fixture(t), batch = await f.preview({ disposition: 'archive' }); await f.state.mergeCommit(f.client, batch.operationId, batch.binding);
  const call = f.client.callSpace.bind(f.client); let leaves = 0, failed = false;
  f.client.callSpace = async (room, method, args) => {
    if (room === batch.targetId && method === 'join' && !args[1] && ++leaves === 2 && !failed) {
      failed = true; throw Error('Synthetic undo target detach failure');
    }
    return call(room, method, args);
  };
  const partial = await f.state.mergeUndo(f.client, batch.operationId, batch.binding);
  assert.equal(partial.stage, 'partial'); assert.match(partial.failures[0], /undo target detach failure/);
  assert.equal(f.state.metadata(f.a).archived, true);
  const done = await f.state.mergeUndo(f.client, batch.operationId, batch.binding);
  assert.equal(done.stage, 'undone'); assert.equal(done.undoKeptTarget, false);
  assert.equal(f.state.metadata(batch.targetId).archived, true); assert.equal(f.state.metadata(f.a).archived, false);
  assert.equal(f.counters.imports, 1); assert.equal(f.counters.sends, 0);
});
