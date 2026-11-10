const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { QueueSecretary, successor } = require('../queue-secretary.cjs');
const selected = { sessionId: 'secretary', nativeId: 'native-secretary' };
const next = { sessionId: 'next', nativeId: 'native-next' };
const entry = (event, from = selected, to = next) => ({ time: 100, event, spaces: ['shared'], old: { id: from.sessionId, nativeId: from.nativeId }, new: { id: to.sessionId, nativeId: to.nativeId } });
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-queue-secretary-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, role: new QueueSecretary(dir) };
}
test('one persisted secretary replaces the former and can be revoked after reopen', t => {
  const { dir, role } = setup(t);
  assert.equal(role.current(), null);
  role.set(selected);
  assert.deepEqual(new QueueSecretary(dir).current(), selected);
  role.set(next);
  assert.deepEqual(role.current(), next);
  role.set(null);
  assert.equal(new QueueSecretary(dir).current(), null);
  assert.equal(fs.statSync(role.file).mode & 0o777, 0o600);
  assert.throws(() => role.set({ ...selected, extra: true }), /Invalid/);
});
test('only done follows a unique successor chain; kept, branches and native mismatches stay put', () => {
  assert.deepEqual(successor(selected, [entry('requested')]), selected);
  assert.deepEqual(successor(selected, [entry('kept')]), selected);
  assert.deepEqual(successor(selected, [entry('done')]), next);
  assert.deepEqual(successor(selected, [entry('done'), entry('done', next, { sessionId: 'third', nativeId: 'n-third' })]), { sessionId: 'third', nativeId: 'n-third' });
  for (const second of [entry('kept', selected, { sessionId: 'other', nativeId: null }), entry('done', selected, { sessionId: 'other', nativeId: 'native-other' })]) {
    assert.deepEqual(successor(selected, [entry('done'), second]), selected, 'ambiguous branch must not delegate');
  }
  assert.deepEqual(successor(selected, [entry('done'), entry('kept')]), selected);
  assert.deepEqual(successor(selected, [entry('done', { ...selected, nativeId: 'different' })]), selected);
  const mismatch = entry('done', { ...selected, nativeId: 'different' });
  assert.deepEqual(successor(selected, [mismatch, entry('done')]), selected, 'contradictory native identities cannot be upgraded by a later line');
  assert.deepEqual(successor(selected, [entry('done'), entry('done', next, selected)]), selected, 'cycle cannot grant a successor');
  assert.deepEqual(successor(selected, [entry('done'), entry('done', { sessionId: 'another-parent', nativeId: 'n-parent' }, next)]), selected);
});
test('actual written log moves authorization after done and keeps it at the source for a branch', t => {
  const { role } = setup(t);
  role.set(selected);
  const write = entries => fs.writeFileSync(role.logFile, entries.map(value => JSON.stringify(value)).join('\n') + '\n', { mode: 0o600 });
  write([entry('kept')]);
  assert.deepEqual(role.current(), selected);
  write([entry('done')]);
  assert.deepEqual(role.current(), next);
  write([entry('done'), entry('done', selected, { sessionId: 'other', nativeId: 'n-other' })]);
  assert.deepEqual(role.current(), selected);
});
test('authorization uses native identity and trusted labels, never a caller supplied name', t => {
  const { role } = setup(t); role.set(selected);
  const record = { id: selected.sessionId, nativeId: selected.nativeId, name: 'Native title', state: 'idle' };
  const actor = { id: record.id, nativeId: record.nativeId, name: 'forged display name' };
  assert.deepEqual(role.creator(actor, [record], new Map([[record.id, 'Secretary label']])), { kind: 'secretary', name: 'Secretary label', sessionId: record.id });
  for (const bad of [null, { ...actor, id: 'other' }, { ...actor, nativeId: 'other' }]) {
    assert.throws(() => role.creator(bad, [record], new Map()), error => error.uiMessage.key === 'error.queue.secretaryOnly');
  }
  for (const changes of [{ archived: true }, { nativeContextPending: true }, { state: 'ended' }, { state: 'background' }]) {
    assert.throws(() => role.creator(actor, [{ ...record, ...changes }], new Map()), error => error.uiMessage.key === 'error.queue.secretaryOnly');
  }
});
test('unreadable authorization or rotation records fail closed; a user can revoke a damaged designation', t => {
  const { dir, role } = setup(t); role.set(selected);
  fs.writeFileSync(role.logFile, '{broken\n', { mode: 0o600 });
  assert.throws(() => role.current(), error => error.uiMessage.key === 'error.queue.secretaryState');
  fs.writeFileSync(role.file, '{broken');
  const reopened = new QueueSecretary(dir);
  assert.throws(() => reopened.current(), error => error.uiMessage.key === 'error.queue.secretaryState');
  reopened.set(null);
  assert.equal(reopened.current(), null);
});
