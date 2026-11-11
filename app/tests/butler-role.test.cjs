'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ButlerRole } = require('../butler-role.cjs');
const { QueueSecretary, successor } = require('../queue-secretary.cjs');
const person = Symbol('person capability');
const identity = { sessionId: 'butler-original', nativeId: 'native-original' };
const next = { sessionId: 'butler-next', nativeId: 'native-next' };
const binding = { runnerRef: 'dedicated-runner', backendRef: 'dedicated-backend', purpose: 'butler', profile: 'deepseek-pro', provider: 'deepseek', model: 'deepseek-v4-pro' };
const designation = (changes = {}) => ({ identity: { ...identity }, runner: { ...binding }, ...changes });
const record = (who = identity, changes = {}) => ({ id: who.sessionId, nativeId: who.nativeId, provider: 'dsh', state: 'idle', roomId: null, runner: { ...binding }, ...changes });
const edge = (event = 'done', from = identity, to = next) => ({ event, old: { id: from.sessionId, nativeId: from.nativeId }, new: { id: to.sessionId, nativeId: to.nativeId } });
const options = { authorizePerson: actor => actor === person };
const code = expected => error => error.code === expected;
function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-butler-role-'));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, role: new ButlerRole(directory, options) };
}
test('only the injected person capability designates or revokes a role; secretary remains independent', t => {
  const { directory, role } = setup(t), secretary = new QueueSecretary(directory);
  secretary.set({ sessionId: 'queue-secretary', nativeId: 'native-secretary' });
  const secretaryBefore = fs.readFileSync(secretary.file);
  assert.deepEqual(role.snapshot(), { version: 1, revision: 0, selected: null });
  for (const actor of [null, { kind: 'person' }, { role: 'person', permission: 'bypass' }, Symbol('person capability')]) {
    assert.throws(() => role.set(actor, designation(), 0), code('ERR_BUTLER_PERSON'));
    assert.throws(() => role.revoke(actor, 0), code('ERR_BUTLER_PERSON'));
  }
  assert.throws(() => new ButlerRole(directory).set(person, designation(), 0), code('ERR_BUTLER_PERSON'));
  const first = role.set(person, designation(), 0);
  assert.equal(first.revision, 1); assert.equal(first.selected.budget, null);
  assert.equal(fs.statSync(role.file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(role.file).nlink, 1);
  assert.deepEqual(new ButlerRole(directory, options).snapshot(), first);
  role.revoke(person, 1);
  assert.equal(new ButlerRole(directory, options).current(), null);
  assert.deepEqual(fs.readFileSync(secretary.file), secretaryBefore);
});
test('selection revisions invalidate former batches across instances, replacement and revoke', t => {
  const { directory, role } = setup(t);
  role.set(person, designation(), 0);
  const peer = new ButlerRole(directory, options), original = record();
  assert.equal(role.authorize(original, { selectionRevision: 1, runnerRef: binding.runnerRef }, [original], []).mode, 'record-only');
  peer.set(person, designation({ identity: next }), 1);
  assert.throws(() => role.set(person, designation(), 1), code('ERR_BUTLER_REVISION'));
  assert.throws(() => role.authorize(original, { selectionRevision: 1, runnerRef: binding.runnerRef }, [original], []), code('ERR_BUTLER_UNAUTHORIZED'));
  assert.equal(role.snapshot().revision, 2);
  peer.revoke(person, 2);
  const nextRecord = record(next);
  assert.throws(() => role.authorize(nextRecord, { selectionRevision: 2, runnerRef: binding.runnerRef }, [nextRecord], []), code('ERR_BUTLER_UNAUTHORIZED'));
  assert.equal(role.snapshot().revision, 3);
});
test('only a designated, non-member DSH instance with the current native and runner identity is authorized', t => {
  const { role } = setup(t); role.set(person, designation(), 0);
  const expected = { selectionRevision: 1, runnerRef: binding.runnerRef }, good = record();
  assert.deepEqual(role.authorize(good, expected, [good], []).identity, identity);
  assert.throws(() => role.authorize({ ...good }, expected, [good], []), code('ERR_BUTLER_UNAUTHORIZED'), 'JSON assertions are not the canonical actor record');
  for (const changes of [
    { id: 'other' }, { nativeId: 'changed-native' }, { provider: 'claude' }, { provider: 'codex' }, { archived: true }, { nativeContextPending: true },
    { state: 'ended' }, { state: 'background' }, { state: 'disconnected' }, { roomId: 'shared' }, { roomIds: ['shared'], roomId: 'shared' },
    { roomIds: 'unverifiable' }, { runner: null },
    ...Object.keys(binding).map(key => ({ runner: { ...binding, [key]: 'other' } })),
  ]) {
    const bad = record(identity, changes);
    assert.throws(() => role.authorize(bad, expected, [bad], []), code('ERR_BUTLER_UNAUTHORIZED'), JSON.stringify(changes));
  }
  for (const bad of [{ ...expected, selectionRevision: 0 }, { ...expected, runnerRef: 'old-runner' }, { ...expected, mode: 'queue-only' }, { ...expected, lifecycle: true }]) {
    assert.throws(() => role.authorize(good, bad, [good], []), code('ERR_BUTLER_UNAUTHORIZED'));
  }
});
test('rotation reuses all secretary done/kept/branch/loop rules and validates the resolved native record', t => {
  const { role } = setup(t); role.set(person, designation(), 0);
  const third = { sessionId: 'third', nativeId: 'native-third' };
  const cases = [[], [edge('requested')], [edge('kept')], [edge()], [edge(), edge('done', next, third)],
    [edge(), edge('kept')], [edge(), edge('done', identity, third)], [edge(), edge('done', next, identity)],
    [edge('done', { ...identity, nativeId: 'wrong' })],
    [edge('done', { ...identity, nativeId: 'wrong' }), edge()],
    [edge(), edge('done', { sessionId: 'another-parent', nativeId: 'native-parent' }, next)]];
  for (const entries of cases) {
    const resolved = successor(identity, entries), before = role.snapshot();
    assert.deepEqual(role.current(entries).identity, resolved);
    assert.deepEqual(role.snapshot(), before, 'Following a written handoff does not create a new designation revision');
    const target = record(resolved);
    assert.deepEqual(role.authorize(target, { selectionRevision: 1, runnerRef: binding.runnerRef }, [target], entries).identity, resolved);
    const wrong = record(resolved, { nativeId: 'not-the-resolved-native' });
    assert.throws(() => role.authorize(wrong, { selectionRevision: 1, runnerRef: binding.runnerRef }, [wrong], entries), code('ERR_BUTLER_UNAUTHORIZED'));
    if (resolved.sessionId !== next.sessionId) {
      const ungranted = record(next);
      assert.throws(() => role.authorize(ungranted, { selectionRevision: 1, runnerRef: binding.runnerRef }, [ungranted], entries), code('ERR_BUTLER_UNAUTHORIZED'));
    }
  }
});
test('the actual private rotation log follows done; malformed log fails closed without changing designation', t => {
  const { role } = setup(t); role.set(person, designation(), 0);
  const before = fs.readFileSync(role.file);
  fs.writeFileSync(role.logFile, JSON.stringify(edge()) + '\n', { mode: 0o600 });
  assert.deepEqual(role.current().identity, next);
  fs.writeFileSync(role.logFile, '{broken\n');
  assert.throws(() => role.current(), code('ERR_BUTLER_STATE'));
  assert.deepEqual(fs.readFileSync(role.file), before);
  assert.equal(role.snapshot().revision, 1, 'A bad rotation view does not poison the readable designation');
  const nextRecord = record(next);
  assert.throws(() => role.authorize(nextRecord, { selectionRevision: 1, runnerRef: binding.runnerRef }, [nextRecord]), code('ERR_BUTLER_STATE'));
  assert.equal(role.revoke(person, 1).selected, null, 'The actual person can revoke without resolving the broken log');
});
test('the budget stores only a configured USD limit and explicit UTC boundary; unknown remains null', t => {
  const { role } = setup(t);
  role.set(person, designation({ budget: { limitMicros: 0 } }), 0);
  assert.deepEqual(role.current([]).budget, { currency: 'USD', limitMicros: 0, dayBoundary: 'UTC' });
  role.set(person, designation({ budget: { currency: 'USD', limitMicros: 1234567, dayBoundary: 'UTC' } }), 1);
  assert.deepEqual(role.snapshot().selected.budget, { currency: 'USD', limitMicros: 1234567, dayBoundary: 'UTC' });
  role.set(person, designation(), 2); assert.equal(role.current([]).budget, null);
  for (const bad of [{}, { limitMicros: null }, { limitMicros: -1 }, { limitMicros: 0.5 }, { limitMicros: NaN }, { limitMicros: Infinity },
    { limitMicros: Number.MAX_SAFE_INTEGER + 1 }, { limitMicros: 1, currency: 'CNY' }, { limitMicros: 1, dayBoundary: 'local' }, { limitMicros: 1, spentMicros: 0 }]) {
    assert.throws(() => role.set(person, designation({ budget: bad }), 3), code('ERR_BUTLER_INVALID'));
  }
  assert.equal(role.snapshot().revision, 3);
});
test('unknown capabilities and malformed selections cannot widen record-only authority', t => {
  const { role } = setup(t);
  for (const bad of [null, { ...designation(), mode: 'queue-only' }, { ...designation(), lifecycle: true }, { ...designation(), capabilities: ['queueAdd'] },
    designation({ identity: { ...identity, sessionId: '' } }), designation({ identity: { ...identity, nativeId: 'line\nbreak' } }),
    designation({ runner: { ...binding, profile: 'invalid profile' } }), designation({ runner: { ...binding, unexpected: 'must-not-be-accepted' } })]) {
    assert.throws(() => role.set(person, bad, 0), code('ERR_BUTLER_INVALID'));
  }
  assert.equal(role.current(), null);
});
test('snapshots and current results cannot mutate persisted authority or runner binding', t => {
  const { role } = setup(t); const input = designation({ budget: { limitMicros: 5 } });role.set(person, input, 0);
  input.identity.sessionId = 'changed-input'; input.runner.runnerRef = 'changed-input'; input.budget.limitMicros = 0;
  const view = role.snapshot(), current = role.current([]);
  view.selected.identity.nativeId = 'changed-copy'; current.runner.runnerRef = 'changed-copy'; current.budget.limitMicros = 0;
  assert.deepEqual(role.current([]).identity, identity);assert.equal(role.current([]).runner.runnerRef, binding.runnerRef);assert.equal(role.current([]).budget.limitMicros, 5);
});
test('corrupt, public, symlinked and hardlinked records are retained and cannot be overwritten', async t => {
  for (const kind of ['corrupt', 'oversized', 'public', 'symlink', 'hardlink']) await t.test(kind, t => {
    const { directory, role } = setup(t);role.set(person, designation(), 0);
    const original = fs.readFileSync(role.file), other = path.join(directory, 'retained-original.json');
    if (kind === 'corrupt') fs.writeFileSync(role.file, '{broken');
    if (kind === 'oversized') fs.writeFileSync(role.file, ' '.repeat(16 * 1024 + 1));
    if (kind === 'public') fs.chmodSync(role.file, 0o644);
    if (kind === 'symlink') { fs.renameSync(role.file, other);fs.symlinkSync(other, role.file); }
    if (kind === 'hardlink') fs.linkSync(role.file, other);
    const before = fs.readFileSync(role.file), reopened = new ButlerRole(directory, options);
    assert.throws(() => reopened.current(), code('ERR_BUTLER_STATE'));
    assert.throws(() => reopened.revoke(person, 1), code('ERR_BUTLER_STATE'));
    assert.deepEqual(fs.readFileSync(role.file), before);
    if (['symlink', 'hardlink'].includes(kind)) assert.deepEqual(fs.readFileSync(other), original);
  });
});
test('directory permissions, symlinks and replacement are checked before authority or writes', t => {
  const { directory, role } = setup(t);role.set(person, designation(), 0);
  const original = fs.readFileSync(role.file);
  fs.chmodSync(directory, 0o755);
  assert.throws(() => new ButlerRole(directory, options).snapshot(), code('ERR_BUTLER_STATE'));
  assert.throws(() => role.revoke(person, 1), code('ERR_BUTLER_STATE'));
  assert.deepEqual(fs.readFileSync(role.file), original);fs.chmodSync(directory, 0o700);
  const link = path.join(directory, 'directory-link');fs.symlinkSync(directory, link);
  assert.throws(() => new ButlerRole(link, options).snapshot(), code('ERR_BUTLER_STATE'));
  const nested = path.join(directory, 'private-role');fs.mkdirSync(nested, { mode: 0o700 });
  const replaced = new ButlerRole(nested, options);replaced.set(person, designation(), 0);
  const retained = path.join(directory, 'retained-role');fs.renameSync(nested, retained);fs.mkdirSync(nested, { mode: 0o700 });
  assert.throws(() => replaced.snapshot(), code('ERR_BUTLER_STATE'));
  assert.equal(fs.readFileSync(path.join(retained, 'butler.json'), 'utf8'), JSON.stringify({ version: 2, revision: 1, selected: designation({ budget: null }) }));
  assert.equal(fs.existsSync(path.join(nested, 'butler.json')), false);
});
test('a missing or rolled-back record never resets an existing authority revision', t => {
  const { directory, role } = setup(t);role.set(person, designation(), 0);
  const old = fs.readFileSync(role.file);role.revoke(person, 1);
  fs.writeFileSync(role.file, old);
  assert.throws(() => role.snapshot(), code('ERR_BUTLER_STATE'));
  const reopened = new ButlerRole(directory, options);assert.equal(reopened.snapshot().revision, 1);
  fs.unlinkSync(reopened.file);
  assert.throws(() => reopened.current(), code('ERR_BUTLER_STATE'));
  assert.equal(fs.existsSync(reopened.file), false);
});
test('another writer lock is neither stolen nor removed and a successful write leaves no temporary files', t => {
  const { directory, role } = setup(t);role.set(person, designation(), 0);
  const lock = path.join(directory, 'butler.json.lock');fs.writeFileSync(lock, 'another writer', { mode: 0o600 });
  assert.throws(() => role.revoke(person, 1), code('ERR_BUTLER_BUSY'));
  assert.equal(fs.readFileSync(lock, 'utf8'), 'another writer');assert.equal(role.snapshot().revision, 1);
  fs.unlinkSync(lock);role.revoke(person, 1);
  assert.deepEqual(fs.readdirSync(directory).sort(), ['butler-rotation-proof.json', 'butler.json']);
});
