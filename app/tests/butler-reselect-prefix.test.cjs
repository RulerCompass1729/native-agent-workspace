'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createHash } = require('node:crypto');
const { ButlerRole } = require('../butler-role.cjs');
const person = Symbol('synthetic reselect person');
const A = { sessionId: 'reselect-a', nativeId: 'native-reselect-a' }, B = { sessionId: 'reselect-b', nativeId: 'native-reselect-b' };
const C = { sessionId: 'reselect-c', nativeId: 'native-reselect-c' }, D = { sessionId: 'reselect-d', nativeId: 'native-reselect-d' };
const runner = { runnerRef: 'reselect-runner', backendRef: 'reselect-backend', purpose: 'butler', profile: 'synthetic-profile', provider: 'synthetic-provider', model: 'synthetic-model' };
const line = value => JSON.stringify(value) + '\n';
const edge = (from = A, to = B, event = 'done') => ({ event, old: { id: from.sessionId, nativeId: from.nativeId }, new: { id: to.sessionId, nativeId: to.nativeId } });
const note = line({ event: 'synthetic-note' }), AB = note + line(edge()), ABC = AB + line(edge(B, C));
const stateError = { code: 'ERR_BUTLER_STATE' };
const observed = action => { try { return { identity: action()?.identity ?? null }; } catch (error) { return { code: error.code }; } };
const readProof = f => JSON.parse(fs.readFileSync(f.proof));
const hash = value => createHash('sha256').update(value).digest('hex');
function fixture(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'naw-butler-reselect-'))); fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const open = () => new ButlerRole(directory, { authorizePerson: actor => actor === person });
  const role = open(); role.set(person, { identity: A, runner }, 0);
  return { directory, role, open, proof: path.join(directory, 'butler-rotation-proof.json') };
}
function verifiedB(f) {
  fs.writeFileSync(f.role.logFile, AB, { mode: 0o600 }); assert.deepEqual(f.role.current().identity, B);
  return readProof(f).prefix;
}
function paddedRollback(f) { fs.writeFileSync(f.role.logFile, note + ' '.repeat(Buffer.byteLength(ABC) + 8192)); }
function expectColdRefusal(f, label) {
  const actual = observed(() => f.open().current()); console.log(JSON.stringify({ reselectRollback: label, actual }));
  assert.deepEqual(actual, stateError, 'Re-designation must not erase the verified byte constraint across a restart');
}

for (const mutation of ['same-length-kept', 'padded-prefix']) test(`cold re-designation preserves the verified prefix against ${mutation}`, t => {
  const f = fixture(t), prefix = verifiedB(f);
  if (mutation === 'same-length-kept') {
    const rewritten = note + line(edge(A, B, 'kept')); assert.equal(Buffer.byteLength(rewritten), Buffer.byteLength(AB));
    fs.writeFileSync(f.role.logFile, rewritten);
  } else paddedRollback(f);
  assert.equal(f.open().set(person, { identity: A, runner }, 1).revision, 2);
  expectColdRefusal(f, mutation);
  assert.deepEqual(readProof(f).prefix, prefix);
});

test('a cold designation after revoke retains the old proof prefix even though its selection hash differs', t => {
  const f = fixture(t), prefix = verifiedB(f), previousHash = readProof(f).selection;
  assert.equal(f.role.revoke(person, 1).selected, null);
  assert.notEqual(previousHash, hash(JSON.stringify(f.open().snapshot())));
  paddedRollback(f);
  assert.equal(f.open().set(person, { identity: A, runner }, 2).revision, 3);
  expectColdRefusal(f, 'revoke-then-cold-designate');
  assert.deepEqual(readProof(f).prefix, prefix);
});

test('re-designation takes the newer disk prefix instead of an older in-memory observation', t => {
  const f = fixture(t); verifiedB(f);
  fs.appendFileSync(f.role.logFile, line(edge(B, C)));
  assert.deepEqual(f.open().current().identity, C); const stronger = readProof(f).prefix;
  // The actual log is still ABC when set runs, so refusing an already-rolled-back
  // log cannot accidentally satisfy this check.
  assert.equal(f.role.set(person, { identity: A, runner }, 1).revision, 2);
  fs.writeFileSync(f.role.logFile, AB);
  expectColdRefusal(f, 'peer-disk-prefix-newer-than-ram');
  assert.deepEqual(readProof(f).prefix, stronger);
});

test('an older disk proof cannot make re-designation forget a stronger in-memory prefix', t => {
  const f = fixture(t); verifiedB(f); const earlier = fs.readFileSync(f.proof);
  fs.appendFileSync(f.role.logFile, line(edge(B, C))); assert.deepEqual(f.role.current().identity, C);
  const stronger = readProof(f).prefix, before = fs.readFileSync(f.role.file); fs.writeFileSync(f.proof, earlier);
  let selected;
  try { selected = f.role.set(person, { identity: A, runner }, 1); }
  catch (error) { assert.equal(error.code, 'ERR_BUTLER_STATE'); }
  if (selected) {
    assert.equal(selected.revision, 2); assert.deepEqual(readProof(f).prefix, stronger);
    fs.writeFileSync(f.role.logFile, AB); expectColdRefusal(f, 'ram-prefix-newer-than-disk');
  } else {
    assert.deepEqual(fs.readFileSync(f.role.file), before);
    assert.deepEqual(fs.readFileSync(f.proof), earlier);
  }
  assert.equal(f.role.revoke(person, f.role.snapshot().revision).selected, null);
});

test('same-length conflicting disk and memory prefix hashes refuse re-designation without replacing evidence', t => {
  const f = fixture(t); verifiedB(f); const before = fs.readFileSync(f.role.file), proof = readProof(f);
  proof.prefix.digest = proof.prefix.digest === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64);
  fs.writeFileSync(f.proof, JSON.stringify(proof)); const conflict = fs.readFileSync(f.proof);
  assert.throws(() => f.role.set(person, { identity: A, runner }, 1), stateError);
  assert.deepEqual(fs.readFileSync(f.role.file), before); assert.deepEqual(fs.readFileSync(f.proof), conflict);
  assert.equal(f.role.revoke(person, 1).selected, null);
});

test('cold re-designation with a new runner keeps the prefix while normal B-to-C growth remains valid', t => {
  const f = fixture(t), prefix = verifiedB(f);
  const nextRunner = { ...runner, runnerRef: 'reselect-next-runner', profile: 'synthetic-next-profile' };
  const saved = f.open().set(person, { identity: A, runner: nextRunner }, 1), immediate = readProof(f);
  assert.equal(saved.version, 1); assert.equal(saved.revision, 2); assert.equal(immediate.selection, hash(JSON.stringify(saved)));
  fs.appendFileSync(f.role.logFile, line(edge(B, C))); const actual = f.open().current();
  assert.deepEqual(actual.identity, C); assert.deepEqual(actual.runner, nextRunner);
  assert.deepEqual(immediate.prefix, prefix, 'Set itself must carry the constraint; a later current must not create it from scratch');
});

test('a new unrelated identity inherits only the byte constraint rather than the former resolved authority', t => {
  const f = fixture(t), prefix = verifiedB(f);
  f.open().set(person, { identity: D, runner }, 1); const immediate = readProof(f);
  assert.deepEqual(immediate.identity, D); assert.deepEqual(f.open().current().identity, D);
  assert.deepEqual(immediate.prefix, prefix);
});

test('an interrupted selector rename retains the prefix through a cold explicit designation retry', t => {
  const f = fixture(t), prefix = verifiedB(f), before = fs.readFileSync(f.role.file), rename = fs.renameSync; let failed = 0;
  t.mock.method(fs, 'renameSync', (from, to, ...args) => {
    if (to === f.role.file && !failed) { failed++; throw Object.assign(Error('Synthetic selector rename failure'), { code: 'EIO' }); }
    return rename(from, to, ...args);
  });
  try { assert.throws(() => f.open().set(person, { identity: D, runner }, 1), stateError); }
  finally { t.mock.restoreAll(); }
  assert.equal(failed, 1); assert.deepEqual(fs.readFileSync(f.role.file), before);
  assert.notEqual(readProof(f).selection, hash(JSON.stringify(f.open().snapshot())));
  paddedRollback(f);
  assert.equal(f.open().set(person, { identity: A, runner }, 1).revision, 2);
  expectColdRefusal(f, 'interrupted-selector-rename-then-retry');
  assert.deepEqual(readProof(f).prefix, prefix);
});

for (const newer of ['disk', 'memory']) test(`different-length ${newer}-newer prefixes require an actual matching log before re-designation`, t => {
  const f = fixture(t); verifiedB(f); const earlier = fs.readFileSync(f.proof);
  fs.appendFileSync(f.role.logFile, line(edge(B, C)));
  if (newer === 'disk') assert.deepEqual(f.open().current().identity, C);
  else { assert.deepEqual(f.role.current().identity, C); fs.writeFileSync(f.proof, earlier); }
  // Keep the shorter verified AB bytes but replace the ABC suffix without
  // shortening the file. Only the longer hash is now unsatisfied.
  fs.writeFileSync(f.role.logFile, AB + ' '.repeat(Buffer.byteLength(ABC) + 8192));
  const selectedBefore = fs.readFileSync(f.role.file), proofBefore = fs.readFileSync(f.proof);
  assert.throws(() => f.role.set(person, { identity: A, runner }, 1), stateError);
  assert.deepEqual(fs.readFileSync(f.role.file), selectedBefore);
  assert.deepEqual(fs.readFileSync(f.proof), proofBefore);
  assert.equal(f.role.snapshot().revision, 1);
  assert.equal(f.role.revoke(person, 1).selected, null);
});
