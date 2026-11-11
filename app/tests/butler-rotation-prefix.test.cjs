'use strict';
// This is a same-process, file-backed history check. Explicit entries remain a
// trusted synthetic fixture interface; no persistence across cold restart is claimed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ButlerRole } = require('../butler-role.cjs');

const person = Symbol('synthetic person capability');
const A = { sessionId: 'synthetic-butler-a', nativeId: 'synthetic-native-a' };
const B = { sessionId: 'synthetic-butler-b', nativeId: 'synthetic-native-b' };
const C = { sessionId: 'synthetic-butler-c', nativeId: 'synthetic-native-c' };
const runner = { runnerRef: 'synthetic-runner', backendRef: 'synthetic-backend', purpose: 'butler', profile: 'synthetic-profile', provider: 'deepseek', model: 'synthetic-model' };
const expected = { selectionRevision: 1, runnerRef: runner.runnerRef };
const edge = (from = A, to = B, event = 'done') => ({ event, old: { id: from.sessionId, nativeId: from.nativeId }, new: { id: to.sessionId, nativeId: to.nativeId } });
const line = value => JSON.stringify(value) + '\n';
const note = line({ event: 'synthetic-note', message: 'safe prefix before the handoff' });
const prefix = note + line(edge());
const stateError = { code: 'ERR_BUTLER_STATE' };
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-butler-rotation-prefix-'));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const role = new ButlerRole(directory, { authorizePerson: actor => actor === person });
  role.set(person, { identity: A, runner }, 0);
  const records = [A, B, C].map(who => ({ id: who.sessionId, nativeId: who.nativeId, provider: 'dsh', state: 'idle', roomId: null, runner: { ...runner } }));
  return { directory, role, records, write: text => fs.writeFileSync(role.logFile, text, { mode: 0o600 }) };
}
function result(fn) {
  try { return { identity: fn()?.identity ?? null }; }
  catch (error) { return { code: error.code }; }
}
function assertRefused(f, identities = [A, B]) {
  const attempts = [result(() => f.role.current()), ...identities.map(who => result(() => f.role.authorize(f.records.find(record => record.id === who.sessionId), expected, f.records)))];
  assert.deepEqual(attempts, attempts.map(() => stateError), 'Neither a stale original nor a previously resolved identity is a substitute for the current verified file');
}
function assertCurrent(f, who) {
  assert.deepEqual(f.role.current().identity, who);
  assert.deepEqual(f.role.authorize(f.records.find(record => record.id === who.sessionId), expected, f.records).identity, who);
}
function logReadError(t, f) {
  const identity = fs.statSync(f.role.logFile), read = fs.readSync;
  let intercepted = 0;
  t.mock.method(fs, 'readSync', (fd, ...args) => {
    const opened = fs.fstatSync(fd);
    if (opened.dev === identity.dev && opened.ino === identity.ino) {
      intercepted++; throw Object.assign(Error('synthetic rotation read fault'), { code: 'EIO' });
    }
    return read(fd, ...args);
  });
  return () => { t.mock.restoreAll(); assert.ok(intercepted > 0, 'The actual rotation file read must encounter the injected fault'); };
}

for (const fault of ['bad-tail', 'EIO']) for (const rollback of ['remove', 'short-prefix', 'same-length-kept', 'padded-old-prefix']) {
  test(`file-backed ${fault} followed by ${rollback} cannot restore original or cached authorization`, t => {
    const f = fixture(t); f.write(prefix); assertCurrent(f, B);
    if (fault === 'bad-tail') {
      fs.appendFileSync(f.role.logFile, '{synthetic-torn-tail\n');
      assertRefused(f);
    } else {
      const restore = logReadError(t, f);
      assertRefused(f); restore();
    }
    const observedLength = fs.statSync(f.role.logFile).size;
    if (rollback === 'remove') fs.unlinkSync(f.role.logFile);
    if (rollback === 'short-prefix') f.write(note);
    if (rollback === 'same-length-kept') {
      const rewritten = note + line(edge(A, B, 'kept'));
      assert.equal(Buffer.byteLength(rewritten), Buffer.byteLength(prefix));
      f.write(rewritten + ' '.repeat(observedLength - Buffer.byteLength(rewritten)));
      assert.equal(fs.statSync(f.role.logFile).size, observedLength);
    }
    if (rollback === 'padded-old-prefix') {
      f.write(note + ' '.repeat(observedLength + 8192));
      assert.ok(fs.statSync(f.role.logFile).size > observedLength, 'A size-only high-water check would accept this rollback');
    }
    assertRefused(f);
  });
}

test('the first safe observed file still counts as seen when its read fails before parsing', t => {
  const f = fixture(t); f.write(prefix);
  const restore = logReadError(t, f);
  assertRefused(f); restore();
  fs.unlinkSync(f.role.logFile);
  assertRefused(f);
});

test('file rollback refusal leaves the designation snapshot and person revoke usable without reading history', t => {
  const f = fixture(t); f.write(prefix); assertCurrent(f, B);
  const selected = fs.readFileSync(f.role.file);
  fs.appendFileSync(f.role.logFile, '{synthetic-torn-tail\n'); assertRefused(f);
  fs.unlinkSync(f.role.logFile);
  assert.equal(f.role.snapshot().revision, 1);
  assert.deepEqual(fs.readFileSync(f.role.file), selected, 'Read failure does not modify the designation');
  assert.equal(f.role.revoke(person, 1).selected, null);
  assert.equal(f.role.current(), null);
});

test('an unchanged verified prefix may append the next unambiguous done handoff', t => {
  const f = fixture(t); f.write(prefix); assertCurrent(f, B);
  fs.appendFileSync(f.role.logFile, line(edge(B, C)));
  assertCurrent(f, C);
  assert.equal(f.role.snapshot().revision, 1);
  for (const stale of f.records.slice(0, 2)) assert.throws(() => f.role.authorize(stale, expected, f.records), { code: 'ERR_BUTLER_UNAUTHORIZED' });
});

test('repairing only an unverified tail to a complete nondecreasing file preserves the verified prefix', t => {
  const f = fixture(t); f.write(prefix); assertCurrent(f, B);
  const torn = '{synthetic-torn-tail-with-unknown-content\n';
  fs.appendFileSync(f.role.logFile, torn); assertRefused(f);
  const repaired = prefix + line({ event: 'synthetic-note', message: 'x'.repeat(torn.length + 80) }) + line(edge(B, C));
  assert.ok(Buffer.byteLength(repaired) >= Buffer.byteLength(prefix + torn));
  f.write(repaired); assertCurrent(f, C);
});

for (const [name, suffix] of [
  ['a branch at the original identity', edge(A, C)],
  ['a cycle back to the original identity', edge(B, A)],
  ['a later kept decision for the original edge', edge(A, B, 'kept')],
]) {
  test(`after observing A to B, appending ${name} cannot authorize A or silently reuse cached B`, t => {
    const f = fixture(t); f.write(prefix); assertCurrent(f, B);
    fs.appendFileSync(f.role.logFile, line(suffix));
    assertRefused(f);
  });
}

test('unsafe log permissions refuse this call but a complete nondecreasing safe log can recover', t => {
  const f = fixture(t); f.write(prefix); assertCurrent(f, B);
  fs.chmodSync(f.role.logFile, 0o644); assertRefused(f);
  fs.chmodSync(f.role.logFile, 0o600);
  fs.appendFileSync(f.role.logFile, line(edge(B, C)));
  assertCurrent(f, C);
});

test('a read EIO refuses this call but does not poison the next complete nondecreasing log', t => {
  const f = fixture(t); f.write(prefix); assertCurrent(f, B);
  const restore = logReadError(t, f); assertRefused(f); restore();
  fs.appendFileSync(f.role.logFile, line(edge(B, C))); assertCurrent(f, C);
});

test('a file appended during its read is refused, then its complete nondecreasing contents recover', t => {
  const f = fixture(t); f.write(prefix); assertCurrent(f, B);
  const inode = fs.statSync(f.role.logFile), read = fs.readSync;
  let changed = false;
  t.mock.method(fs, 'readSync', (fd, ...args) => {
    const opened = fs.fstatSync(fd), size = read(fd, ...args);
    if (!changed && size > 0 && opened.dev === inode.dev && opened.ino === inode.ino) {
      changed = true; fs.appendFileSync(f.role.logFile, line(edge(B, C)));
    }
    return size;
  });
  assert.deepEqual(result(() => f.role.current()), stateError);
  t.mock.restoreAll(); assert.equal(changed, true);
  assertCurrent(f, C);
});

test('a named-path swap after the descriptor read cannot authorize the now-unlinked handoff', t => {
  const f = fixture(t); f.write(prefix); assertCurrent(f, B);
  const inode = fs.statSync(f.role.logFile), stat = fs.fstatSync;
  let observed = 0, replaced = false;
  t.mock.method(fs, 'fstatSync', (fd, ...args) => {
    const value = stat(fd, ...args);
    if (value.dev === inode.dev && value.ino === inode.ino && ++observed === 2) {
      fs.renameSync(f.role.logFile, path.join(f.directory, 'retained-synthetic-log'));
      f.write(note + line(edge(A, B, 'kept')));
      replaced = true;
    }
    return value;
  });
  assert.deepEqual(result(() => f.role.current()), stateError, 'The descriptor result alone cannot authorize after its named path was replaced');
  t.mock.restoreAll(); assert.equal(replaced, true);
  f.write(prefix + line(edge(B, C))); assertCurrent(f, C);
});

test('explicit trusted entry fixtures retain successor semantics and do not replace file-backed observations', t => {
  const f = fixture(t); f.write(prefix); assertCurrent(f, B);
  assert.deepEqual(f.role.current([]).identity, A);
  assert.deepEqual(f.role.current([edge(), edge(B, C)]).identity, C);
  assert.deepEqual(f.role.current([edge(), edge(B, A)]).identity, A);
  assert.deepEqual(f.role.authorize(f.records[0], expected, f.records, []).identity, A);
  assertCurrent(f, B);
});

// The existence check alone cannot catch a still-existing but shortened file
// when the first read failed before any prefix could be validated.
test('the first safe observed size still prevents truncation after an initial read EIO', t => {
  const f = fixture(t); f.write(prefix);
  const restore = logReadError(t, f); assertRefused(f); restore();
  f.write(''); assertRefused(f);
  assert.equal(f.role.snapshot().revision, 1);
  assert.equal(f.role.revoke(person, 1).selected, null);
});
