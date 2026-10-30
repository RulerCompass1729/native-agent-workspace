const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { randomUUID } = require('node:crypto');
const { Workspace } = require('../workspace.cjs');
const { captureSource, prepareBatch, materializeBatch } = require('../space-merge.cjs');

function fixture(t, count = 2) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-merge-store-')), counters = { creates: 0 };
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const host = () => ({ binaries: {}, create() { counters.creates++; throw Error('A merge must never create a native runtime'); }, close() {} });
  const w = new Workspace(host(), dir); t.after(() => { if (!w.closed) w.close(); });
  const sources = [randomUUID(), randomUUID()].map((id, index) => {
    const messages = Array.from({ length: index ? 0 : count }, (_, row) => ({ id: `original-${row}`, role: 'tool', kind: 'tool', nativeId: 'original-native',
      text: `Exact original tool ${row}`, status: 'complete', volatile: true, time: row + 1 }));
    return captureSource({ id, name: `Source ${index}`, revision: 0, metadataRevision: 0, notes: '', events: [], files: [], messages }, []);
  });
  const spec = { operationId: randomUUID(), targetId: randomUUID(), name: 'C', memberIds: [], disposition: 'keep' };
  const batch = prepareBatch(sources, spec);
  return { dir, host, w, batch, counters, build: change => prepareBatch(sources, { ...spec, ...change }) };
}
test('actual Workspace saves all supplied 220 selected originals and their immutable provenance across cold reopen, with zero runtimes', t => {
  const f = fixture(t, 220), receipt = f.w.mergeSnapshot(f.batch);
  assert.equal(receipt.persisted, true); const expected = materializeBatch(f.batch);
  assert.deepEqual(f.w.roomFor(f.batch.targetId).messages, expected);
  const disk = JSON.parse(fs.readFileSync(path.join(f.dir, 'room-records.json'), 'utf8'));
  assert.deepEqual(disk.rooms[0].messages, expected); assert.equal(disk.rooms[0].snapshotBatches[0].binding, f.batch.binding);
  f.w.close(); const reopened = new Workspace(f.host(), f.dir); t.after(() => reopened.close());
  assert.equal(reopened.storageWarning, undefined); assert.deepEqual(reopened.roomFor(f.batch.targetId).messages, expected);
  assert.equal(reopened.sharedReplies.grants.size, 0); assert.equal(reopened.versions.dispatches, 0); assert.equal(f.counters.creates, 0);
  assert.equal(reopened.mergeSnapshot(f.batch).persisted, true); assert.equal(reopened.roomFor(f.batch.targetId).messages.length, 220);
});
test('exact same operation preserves later C rows and never imports again; a different operation cannot overwrite C', t => {
  const { w, batch, counters, build } = fixture(t); w.mergeSnapshot(batch);
  const later = { id: 'later', role: 'human', status: 'submitted', text: 'Later C work', time: 999 };
  w.roomFor(batch.targetId).messages.push(later); w.persist();
  w.mergeSnapshot(batch); assert.equal(w.roomFor(batch.targetId).messages.length, 3); assert.deepEqual(w.roomFor(batch.targetId).messages.at(-1), later);
  const other = build({ operationId: randomUUID() });
  assert.throws(() => w.mergeSnapshot(other), /目标空间已有独立记录/);
  assert.throws(() => w.mergeSnapshot(build({ name: 'Changed confirmation' })), /批次与这次确认不一致/);
  assert.equal(counters.creates, 0);
});
test('actual extension save failure refuses acknowledgment and preserves original room files without native dispatch', t => {
  const { w, batch, dir, counters } = fixture(t); w.persist();
  const rename = fs.renameSync, original = fs.readFileSync(path.join(dir, 'workspace.json'), 'utf8');
  t.mock.method(fs, 'renameSync', (from, to) => { if (to.endsWith('room-records.json')) throw Error('Synthetic extension failure'); return rename(from, to); });
  assert.throws(() => w.mergeSnapshot(batch), /保存失败/); assert.equal(w.rooms.has(batch.targetId), false);
  assert.equal(fs.readFileSync(path.join(dir, 'workspace.json'), 'utf8'), original);
  assert.equal(w.versions.dispatches, 0); assert.equal(counters.creates, 0);
});
test('corrupt copied body or missing batch marker cold-loads as an honest storage failure without overwriting the source file', t => {
  for (const corrupt of ['body', 'marker']) {
    const f = fixture(t); f.w.mergeSnapshot(f.batch); f.w.close();
    const file = path.join(f.dir, 'room-records.json'), stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (corrupt === 'body') stored.rooms[0].messages[0].text = 'Different bytes'; else delete stored.rooms[0].snapshotBatches;
    fs.writeFileSync(file, JSON.stringify(stored), { mode: 0o600 }); const before = fs.readFileSync(file, 'utf8');
    const reopened = new Workspace(f.host(), f.dir); t.after(() => reopened.close());
    assert.match(reopened.storageWarning, /未能读取/); assert.throws(() => reopened.mergeSnapshot(f.batch));
    reopened.close(); assert.equal(fs.readFileSync(file, 'utf8'), before);
  }
});
