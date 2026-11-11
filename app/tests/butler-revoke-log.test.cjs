'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { ButlerRole } = require('../butler-role.cjs');
const { ButlerPerson } = require('../butler-person.cjs');
const { ButlerLedger } = require('../butler-ledger.cjs');
const person = Symbol('actual person capability');
const original = { sessionId: 'log-original', nativeId: 'native-original' };
const next = { sessionId: 'log-next', nativeId: 'native-next' };
const third = { sessionId: 'log-third', nativeId: 'native-third' };
const runner = { runnerRef: 'log-runner', backendRef: 'log-backend', purpose: 'butler', profile: 'log-profile', provider: 'log-provider', model: 'log-model' };
const edge = (from = original, to = next) => JSON.stringify({ event: 'done', old: { id: from.sessionId, nativeId: from.nativeId }, new: { id: to.sessionId, nativeId: to.nativeId } }) + '\n';
const record = who => ({ id: who.sessionId, nativeId: who.nativeId, provider: 'dsh', state: 'idle', roomIds: [], runner: { ...runner } });
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-revoke-log-')); fs.chmodSync(directory, 0o700);
  t.after(() => { fs.chmodSync(directory, 0o700); fs.rmSync(directory, { recursive: true, force: true }); });
  const open = () => new ButlerRole(directory, { authorizePerson: actor => actor === person });
  const role = open(); role.set(person, { identity: original, runner, budget: { limitMicros: 17 } }, 0);
  fs.writeFileSync(role.logFile, edge(), { mode: 0o600 });
  const ledger = new ButlerLedger(directory); ledger.ingest({ eventId: 'fact', kind: 'request', sourceRef: 'task:fact', payload: { text: 'Synthetic retained task' } });
  const batch = ledger.beginBatch({ selectionRevision: 1, identity: next, runnerRef: runner.runnerRef }); ledger.failBatch(batch.batchId, 'usage-cost-unknown');
  let stops = 0;
  const api = new ButlerPerson({ role, ledger, authorizePerson: actor => actor === person,
    backend: { snapshot: () => ({ state: 'unprepared', ready: false }) }, stopOwned: target => { stops++; return { target, stopped: true, cleanupConfirmed: true }; } });
  return { directory, role, api, open, ledger, ledgerFile: path.join(directory, 'butler-ledger.jsonl'), stops: () => stops,
    expected: { selectionRevision: 1, runnerRef: runner.runnerRef } };
}
function readFault(file, mode, action) {
  const saved = fs.readSync, identity = fs.lstatSync(file); let fired = 0;
  fs.readSync = function(fd, ...args) {
    const stat = fs.fstatSync(fd), matches = stat.dev === identity.dev && stat.ino === identity.ino;
    if (matches && !fired && mode === 'eio') { fired++; throw Object.assign(Error('Synthetic read error'), { code: 'EIO' }); }
    const count = saved.call(this, fd, ...args);
    if (matches && !fired && count > 0) { fired++; fs.appendFileSync(file, '{"event":"unrelated-note"}\n'); }
    return count;
  };
  try { return action(); } finally { fs.readSync = saved; assert.equal(fired, 1, 'One bounded hook on the actual fixture inode'); }
}

for (const fault of ['append', 'eio', 'bad-tail']) test(`human status/revoke survives ${fault} without inventing the old or last-known current identity`, async t => {
  const f = fixture(t), roleBefore = fs.readFileSync(f.role.file), ledgerBefore = fs.readFileSync(f.ledgerFile);
  assert.deepEqual(f.api.status(person).role.selected.identity, next, 'Resolve a known successor before making the current view unknown');
  if (fault === 'bad-tail') fs.appendFileSync(f.role.logFile, '{partial-tail\n');
  const view = fault === 'bad-tail' ? f.api.status(person) : readFault(f.role.logFile, fault, () => f.api.status(person));
  assert.equal(view.state, 'unknown'); assert.equal(view.role.available, true); assert.equal(view.role.currentAvailable, false);
  assert.equal(view.role.revision, 1); assert.equal(view.role.selected.identity, null);
  assert.deepEqual(view.role.selected.configuration, { profile: runner.profile, provider: runner.provider, model: runner.model });
  assert.deepEqual(view.role.selected.budget, { currency: 'USD', limitMicros: 17, dayBoundary: 'UTC' });
  assert.equal(view.actions.revoke, true); assert.equal(view.actions.close, false); assert.equal(view.pause, null);
  assert.deepEqual(fs.readFileSync(f.role.file), roleBefore);
  const pending = fault === 'bad-tail' ? f.api.revoke(person, 1) : readFault(f.role.logFile, fault, () => f.api.revoke(person, 1));
  const result = await pending;
  assert.equal(result.revoked, true); assert.equal(result.revision, 2); assert.equal(result.shutdown.status, 'unconfirmed');
  assert.equal(result.shutdown.target, null); assert.equal(result.shutdown.stopped, null); assert.equal(result.shutdown.cleanupConfirmed, null);
  assert.equal(f.stops(), 0); assert.equal(f.open().snapshot().selected, null); assert.equal(f.role.current(), null);
  assert.deepEqual(fs.readFileSync(f.ledgerFile), ledgerBefore);
  assert.throws(() => f.role.authorize(record(next), f.expected, [record(next)]), { code: 'ERR_BUTLER_UNAUTHORIZED' });
});

for (const fault of ['append', 'eio', 'bad-tail']) test(`model authorization refuses ${fault} on every failed read and recovers only with a valid complete log`, t => {
  const f = fixture(t), old = record(original), successor = record(next), records = [old, successor];
  if (fault === 'bad-tail') fs.appendFileSync(f.role.logFile, '{partial-tail\n');
  for (const actor of records) {
    const invoke = () => f.role.authorize(actor, f.expected, records);
    assert.throws(() => fault === 'bad-tail' ? invoke() : readFault(f.role.logFile, fault, invoke), { code: 'ERR_BUTLER_STATE' });
    assert.equal(f.role.snapshot().revision, 1); assert.notEqual(f.role.snapshot().selected, null);
  }
  // Repair the unverified suffix without shrinking any safely observed history.
  fs.writeFileSync(f.role.logFile, edge() + JSON.stringify({ event: 'repaired-note', padding: 'x'.repeat(160) }) + '\n');
  assert.throws(() => f.role.authorize(old, f.expected, records), { code: 'ERR_BUTLER_UNAUTHORIZED' });
  assert.deepEqual(f.role.authorize(successor, f.expected, records).identity, next);
});

test('a later completed tail restores current status on the same object without modifying its designation', t => {
  const f = fixture(t), before = fs.readFileSync(f.role.file); fs.appendFileSync(f.role.logFile, '{partial-tail\n');
  assert.equal(f.api.status(person).role.currentAvailable, false);
  fs.writeFileSync(f.role.logFile, edge() + edge(next, third));
  const view = f.api.status(person); assert.equal(view.role.currentAvailable, true); assert.deepEqual(view.role.selected.identity, third);
  assert.deepEqual(fs.readFileSync(f.role.file), before);
});

test('a replacement after the human snapshot still wins the atomic revision check when cleanup resolution fails', async t => {
  const f = fixture(t), resolve = f.role.current.bind(f.role); let replacement;
  f.role.current = () => { f.open().set(person, { identity: third, runner }, 1); replacement = fs.readFileSync(f.role.file);
    throw Object.assign(Error('Synthetic log unavailable'), { code: 'ERR_BUTLER_STATE' }); };
  await assert.rejects(f.api.revoke(person, 1), { code: 'ERR_BUTLER_REVISION' });
  assert.deepEqual(fs.readFileSync(f.role.file), replacement); assert.equal(f.stops(), 0);
  f.role.current = resolve; assert.equal(f.role.snapshot().revision, 2);
});

test('status never mixes an old snapshot configuration with a concurrently replaced role identity', t => {
  const f = fixture(t), resolve = f.role.current.bind(f.role); let changed = false;
  f.role.current = () => { if (!changed) { changed = true; f.open().set(person, { identity: third, runner: { ...runner, profile: 'replacement-profile' } }, 1); } return resolve(); };
  const view = f.api.status(person);
  assert.equal(view.state, 'unknown'); assert.equal(view.role.available, true); assert.equal(view.role.revision, 2);
  assert.equal(view.role.currentAvailable, false); assert.equal(view.role.selected.identity, null);
  assert.equal(view.role.selected.configuration.profile, 'replacement-profile');
});

test('unresolved rotation does not grant close/designation operations or skip the human gate', async t => {
  const f = fixture(t); fs.appendFileSync(f.role.logFile, '{partial-tail\n');
  await assert.rejects(f.api.setActive(person, false, 1), { code: 'ERR_BUTLER_STATE' });
  assert.throws(() => f.api.designate(person, 1), { code: 'ERR_BUTLER_STATE' });
  await assert.rejects(f.api.revoke({ kind: 'person' }, 1), { code: 'ERR_BUTLER_PERSON' }); assert.equal(f.stops(), 0);
});

test('selection-file read EIO refuses that call and permits a later complete read before human revoke', async t => {
  const f = fixture(t), before = fs.readFileSync(f.role.file);
  const view = readFault(f.role.file, 'eio', () => f.api.status(person));
  assert.equal(view.role.available, false); assert.equal(view.actions.revoke, false);
  assert.deepEqual(fs.readFileSync(f.role.file), before); assert.equal(f.stops(), 0);
  const result = await f.api.revoke(person, 1);
  assert.equal(result.revoked, true); assert.equal(result.revision, 2);
  assert.equal(f.role.snapshot().selected, null); assert.equal(f.stops(), 1);
});

test('unsafe directory detected during log resolution remains sticky after its mode is restored', t => {
  const f = fixture(t), stat = fs.lstatSync, directory = stat(f.directory); let reads = 0, fired = 0;
  fs.lstatSync = function(file, ...args) {
    const observed = stat.call(this, file, ...args);
    if (observed.isDirectory() && observed.dev === directory.dev && observed.ino === directory.ino && ++reads === 2) {
      fired++; fs.chmodSync(f.directory, 0o755); return stat.call(this, file, ...args);
    }
    return observed;
  };
  try { assert.throws(() => f.role.current(), { code: 'ERR_BUTLER_STATE' }); }
  finally { fs.lstatSync = stat; fs.chmodSync(f.directory, 0o700); }
  assert.equal(fired, 1, 'The same real directory is made unsafe during log resolution even through a path alias');
  assert.throws(() => f.role.revoke(person, 1), { code: 'ERR_BUTLER_STATE' });
});

test('directory fsync failure after rename is never acknowledged as successful revoke or cleanup', async t => {
  const f = fixture(t), sync = fs.fsyncSync; let fired = 0;
  fs.fsyncSync = function(fd) { if (fs.fstatSync(fd).isDirectory()) { fired++; throw Object.assign(Error('Synthetic sync error'), { code: 'EIO' }); } return sync.call(this, fd); };
  try { await assert.rejects(f.api.revoke(person, 1), { code: 'ERR_BUTLER_STATE' }); }
  finally { fs.fsyncSync = sync; }
  assert.equal(fired, 1); assert.equal(f.stops(), 0); assert.throws(() => f.role.snapshot(), { code: 'ERR_BUTLER_STATE' });
  assert.equal(f.open().snapshot().selected, null, 'Rename occurred, but its durability receipt failed and was not called successful');
});

test('a foreign empty lock remains busy even when the log is malformed; no lock recovery is added', async t => {
  const f = fixture(t); fs.appendFileSync(f.role.logFile, '{partial-tail\n');
  const lock = path.join(f.directory, 'butler.json.lock'); fs.writeFileSync(lock, '', { mode: 0o600 }); const before = fs.lstatSync(lock);
  await assert.rejects(f.api.revoke(person, 1), { code: 'ERR_BUTLER_BUSY' });
  assert.equal(fs.lstatSync(lock).ino, before.ino); assert.equal(fs.readFileSync(lock).length, 0); assert.equal(f.role.snapshot().revision, 1);
});
