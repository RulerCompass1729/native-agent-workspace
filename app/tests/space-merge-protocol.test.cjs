// Existing fully synthetic NativeHost, actual owned daemon and framed Unix RPC.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { fork } = require('node:child_process'), { once } = require('node:events');
const { connectService } = require('../service-connection.cjs');
const { WorkspaceClient } = require('../workspace-client.cjs');
const { RoomState } = require('../room-state.cjs');
const { membershipRevision, isMember } = require('../collaboration-spaces.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('actual Unix merge preserves scoped originals, native identity and positive draft through keep/archive/undo and cold reopen', { timeout: 15000 }, async t => {
  const root = path.resolve(__dirname, '../..'), directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-merge-unix-'));
  fs.chmodSync(directory, 0o700);
  const trials = []; let raw, client, sequence = 0;
  async function start() {
    assert.ok(trials.length < 2, 'Finite two-start source protocol budget');
    const child = fork(path.join(root, 'app/daemon.cjs'), [directory], {
      execArgv: ['--require', path.join(root, 'scripts/fixtures/collaboration-overview.cjs')],
      env: { ...process.env, NAW_TEST_APP_ROOT: root, NAW_WORKSPACE: path.join(directory, 'workspace'), NAW_APP_VERSION: 'development' },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    const trial = { child, stderr: '' }; trials.push(trial);
    child.stderr.on('data', data => { trial.stderr += data; });
    for (let i = 0; i < 150 && !fs.existsSync(path.join(directory, 'connection.json')) && child.exitCode === null; i++) await delay(10);
    assert.equal(child.exitCode, null, trial.stderr); assert.ok(fs.existsSync(path.join(directory, 'connection.json')), trial.stderr);
    raw = await connectService(directory, 'merge-protocol-owner');
    return trial;
  }
  function fixture(trial, method, target, value) {
    return new Promise((resolve, reject) => {
      const id = ++sequence, timer = setTimeout(() => { trial.child.off('message', receive); reject(Error('Owned synthetic fixture response timed out')); }, 1500);
      function receive(reply) { if (reply.requestId !== id) return; clearTimeout(timer); trial.child.off('message', receive); reply.error ? reject(Error(reply.error)) : resolve(reply); }
      trial.child.on('message', receive); trial.child.send({ id, method, target, value });
    });
  }
  async function stop(trial) {
    if (trial.child.exitCode !== null || trial.child.signalCode !== null) return;
    if (!raw || raw.socket.destroyed) raw = await connectService(directory, 'merge-protocol-cleanup');
    await fixture(trial, 'stop'); await raw.call('shutdown');
    await Promise.race([once(trial.child, 'exit'), delay(2500).then(() => { throw Error('Owned daemon not confirmed exited; profile retained'); })]);
    client?.close(); client = null; raw.close(); raw = null;
  }
  t.after(async () => {
    for (const trial of trials) if (trial.child.exitCode === null && trial.child.signalCode === null) await stop(trial);
    assert.ok(trials.every(trial => trial.child.exitCode !== null), 'Only exited owned fixtures may be removed');
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const first = await start();
  assert.ok((await raw.call('initial')).capabilities.includes('spaceMergeV1'));
  const id = await raw.call('create', { provider: 'codex', cwd: directory, name: 'Synthetic existing member', view: 'chat' });
  await raw.call('draft', id, 'SYNTHETIC UNSENT ORIGINAL');
  const initial = await raw.call('initial'), nativeId = initial.sessions[0].nativeId;
  client = new WorkspaceClient([{ key: 'owned-synthetic', client: raw, state: initial }], 'owned-synthetic');
  const profile = new RoomState(directory), a = profile.create('A'), b = profile.create('B');
  for (const room of [a, b]) await profile.membership(client, id, true, 'Existing member', room);
  await fixture(first, 'bindSends', id);
  for (const [room, label] of [[a, 'A'], [b, 'B']]) {
    const snapshot = await raw.call('initial'), record = snapshot.sessions.find(record => record.id === id);
    await raw.call('spaceAction', room, 'forward', [id, `${label} explicit original request`, nativeId], { [id]: membershipRevision(record, room) });
    const stats = await fixture(first, 'stats', id);
    await fixture(first, 'nativeBlock', id, { id: `tool:${label}`, turnId: stats.lastSend.turnId, kind: 'tool', text: `${label} exact original tool`, status: 'complete' });
    await fixture(first, 'complete', id, { text: `${label} exact original final` });
    profile.notes(`${label} original notes`, profile.metadata(room).revision, room);
  }
  await client.refresh();
  const before = await raw.call('initial'), identities = before.sessions.map(record => [record.id, record.nativeId]);
  const sourceTexts = before.rooms.filter(room => [a, b].includes(room.id)).flatMap(room => room.messages.map(row => row.text));
  assert.ok(sourceTexts.includes('A exact original tool')); assert.ok(sourceTexts.includes('B exact original tool'));
  const preview = disposition => profile.mergePreview(client, { sourceIds: [a, b], name: disposition === 'keep' ? 'Kept C' : 'Archived D', memberIds: [id], disposition });
  const keep = await preview('keep'), committed = await profile.mergeCommit(client, keep.operationId, keep.binding);
  assert.equal(committed.stage, 'ready'); const c = client.snapshot(keep.targetId).room;
  assert.deepEqual(c.messages.map(row => row.text), sourceTexts);
  assert.ok(c.messages.every(row => row.snapshotBatch === keep.operationId && row.snapshotOrigin && row.snapshotHash));
  assert.equal(profile.metadata(a).archived, false); assert.equal(profile.metadata(b).archived, false);
  assert.deepEqual((await raw.call('initial')).sessions.map(record => [record.id, record.nativeId]), identities);
  assert.equal(client.snapshot().sessions[0].liveDraft, 'SYNTHETIC UNSENT ORIGINAL');
  await profile.mergeCommit(client, keep.operationId, keep.binding);

  const late = 'Late original native text, outside the closed shared grant';
  const last = await fixture(first, 'stats', id);
  await fixture(first, 'nativeBlock', id, { id: 'tool:late', turnId: last.lastSend.turnId, kind: 'tool', text: late, status: 'complete' });
  const lateState = await raw.call('initial');
  assert.ok(lateState.sessions[0].messages.some(row => row.text === late));
  assert.equal(lateState.rooms.find(room => room.id === keep.targetId).messages.some(row => row.text === late), false);

  const archive = await preview('archive'); await profile.mergeCommit(client, archive.operationId, archive.binding);
  assert.equal(profile.metadata(a).archived, true); assert.equal(profile.metadata(b).archived, true);
  profile.notes('Later D notes retained', profile.metadata(archive.targetId).revision, archive.targetId);
  const undone = await profile.mergeUndo(client, archive.operationId, archive.binding);
  assert.equal(undone.stage, 'undone'); assert.equal(undone.undoKeptTarget, true);
  assert.equal(profile.metadata(a).archived, false); assert.equal(profile.metadata(b).archived, false);
  assert.equal(profile.metadata(archive.targetId).notes, 'Later D notes retained');
  const final = await raw.call('initial'), record = final.sessions[0];
  assert.deepEqual(final.sessions.map(record => [record.id, record.nativeId]), identities);
  for (const room of [a, b, keep.targetId, archive.targetId]) assert.equal(isMember(record, room), true);
  assert.equal(final.diagnostics.dispatches, 2); assert.equal(final.diagnostics.shellModelCalls, 0);
  const stats = await fixture(first, 'stats', id);
  assert.deepEqual(stats.stats, { opens: 0, inputs: 0, resizes: 0, sends: 2 });
  const originalCopies = JSON.stringify(final.rooms.find(room => room.id === keep.targetId).messages);
  await stop(first);

  const second = await start(); const reloaded = await raw.call('initial');
  assert.deepEqual(reloaded.sessions.map(record => [record.id, record.nativeId]), identities);
  assert.equal(reloaded.sessions[0].liveDraft, 'SYNTHETIC UNSENT ORIGINAL');
  assert.equal(JSON.stringify(reloaded.rooms.find(room => room.id === keep.targetId).messages), originalCopies);
  const reopened = new RoomState(directory);
  assert.equal(reopened.metadata(archive.targetId).merge.stage, 'undone');
  assert.equal(reopened.metadata(archive.targetId).notes, 'Later D notes retained');
  assert.equal((await fixture(second, 'stats', id)).stats.sends, 0, 'Cold reopen never replays or creates a runtime');
  await stop(second);
});
