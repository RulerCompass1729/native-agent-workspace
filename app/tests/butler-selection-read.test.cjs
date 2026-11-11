'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { ButlerRole } = require('../butler-role.cjs');
const { ButlerPerson } = require('../butler-person.cjs');
const { ButlerBusiness } = require('../butler-business.cjs');
const { ButlerReadAudit } = require('../butler-read-audit.cjs');
const { ButlerLedger } = require('../butler-ledger.cjs');
const { ButlerQueue } = require('../butler-queue.cjs');
const { RoomState } = require('../room-state.cjs');
const person = Symbol('synthetic person capability');
const identity = { sessionId: 'selection-reader', nativeId: 'selection-native' };
const runner = { runnerRef: 'selection-runner', backendRef: 'selection-backend', purpose: 'butler', profile: 'synthetic-profile', provider: 'synthetic-provider', model: 'synthetic-model' };
const expected = { selectionRevision: 1, runnerRef: runner.runnerRef };
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const readError = () => Object.assign(Error('Synthetic private filesystem failure'), { code: 'EIO' });
const stateError = { code: 'ERR_BUTLER_STATE' };
function fixture(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'naw-butler-selection-read-'))); fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const open = () => new ButlerRole(directory, { authorizePerson: actor => actor === person });
  const role = open(); role.set(person, { identity, runner }, 0);
  const actor = { id: identity.sessionId, nativeId: identity.nativeId, name: 'Synthetic reader', provider: 'dsh', state: 'idle', roomIds: [], runner };
  return { directory, role, open, actor, records: [actor], lock: path.join(directory, 'butler.json.lock') };
}
// Intercept the actual selection inode, rather than replacing Role or claiming
// that a generic EIO at an unknown phase is a safely retryable read.
function oneReadFault(t, file, { code = 'EIO', beforeThrow = () => {} } = {}) {
  const inode = fs.statSync(file), read = fs.readSync, stat = fs.fstatSync; let fired = 0;
  t.mock.method(fs, 'readSync', (fd, ...args) => {
    if (!fired && same(stat(fd), inode)) { fired++; beforeThrow(); throw Object.assign(Error('Synthetic selection read failure'), { code }); }
    return read(fd, ...args);
  });
  return () => { t.mock.restoreAll(); assert.equal(fired, 1, 'The bounded fault must hit the actual selection file once'); };
}
// Track only descriptors opened by this owned operation, so a synthetic close
// failure cannot leak one into a later test. Cleanup never guesses another fd.
function phaseFault(t, f, stage, target = 'selection') {
  const raw = Object.fromEntries(['openSync', 'closeSync', 'lstatSync', 'fstatSync', 'unlinkSync', 'writeFileSync', 'fsyncSync'].map(key => [key, fs[key]]));
  const file = target === 'lock' ? f.lock : target === 'directory' ? f.directory : f.role.file;
  const inode = target === 'lock' ? null : raw.lstatSync(file), owned = new Set(); let fired = 0, stats = 0;
  const matches = fd => {
    const wanted = inode || raw.lstatSync(file);
    return same(raw.fstatSync(fd), wanted);
  };
  t.mock.method(fs, 'openSync', (name, ...args) => {
    if (stage === 'open' && name === file && !fired++) throw readError();
    const fd = raw.openSync(name, ...args); owned.add(fd); return fd;
  });
  t.mock.method(fs, 'closeSync', fd => {
    const reject = stage === 'close' && !fired && matches(fd);
    const value = raw.closeSync(fd); owned.delete(fd);
    if (reject) { fired++; throw readError(); }
    return value;
  });
  if (stage === 'lstat') t.mock.method(fs, 'lstatSync', (name, ...args) => {
    if (name === file && !fired++) throw readError();
    return raw.lstatSync(name, ...args);
  });
  if (stage === 'opened-stat' || stage === 'final-stat') t.mock.method(fs, 'fstatSync', (fd, ...args) => {
    const value = raw.fstatSync(fd, ...args);
    if (same(value, inode) && ++stats === (stage === 'opened-stat' ? 1 : 2)) { fired++; throw readError(); }
    return value;
  });
  if (stage === 'unlink') t.mock.method(fs, 'unlinkSync', (name, ...args) => {
    if (name === file && !fired++) throw readError();
    return raw.unlinkSync(name, ...args);
  });
  if (stage === 'write') t.mock.method(fs, 'writeFileSync', (fd, ...args) => {
    if (typeof fd === 'number' && raw.fstatSync(fd).isFile() && !fired++) throw readError();
    return raw.writeFileSync(fd, ...args);
  });
  if (stage === 'fsync') t.mock.method(fs, 'fsyncSync', fd => {
    const stat = raw.fstatSync(fd), wanted = target === 'directory' ? stat.isDirectory() : stat.isFile();
    if (wanted && !fired++) throw readError();
    return raw.fsyncSync(fd);
  });
  return () => {
    t.mock.restoreAll();
    for (const fd of owned) { try { raw.closeSync(fd); } catch (error) { assert.equal(error.code, 'EBADF'); } }
    assert.equal(fired, 1, `The ${stage} fault must occur exactly once on the owned operation`);
  };
}

for (const operation of ['snapshot', 'current', 'authorize']) test(`one safely opened selection read EIO returns no ${operation} and the next explicit read can recover`, t => {
  const f = fixture(t), before = fs.readFileSync(f.role.file), restore = oneReadFault(t, f.role.file);
  try { assert.throws(() => operation === 'authorize' ? f.role.authorize(f.actor, expected, f.records) : f.role[operation](), stateError); }
  finally { restore(); }
  assert.deepEqual(fs.readFileSync(f.role.file), before);
  assert.equal(f.role.snapshot().revision, 1);
  assert.deepEqual(f.role.current().identity, identity);
  assert.deepEqual(f.role.authorize(f.actor, expected, f.records).identity, identity);
  assert.equal(f.role.revoke(person, 1).selected, null);
});

test('constructor selection read EIO does not permanently poison a later complete read on the same object', t => {
  const f = fixture(t), restore = oneReadFault(t, f.role.file); let reopened;
  try { reopened = f.open(); } finally { restore(); }
  assert.equal(reopened.snapshot().revision, 1);
  assert.deepEqual(reopened.current().identity, identity);
  assert.equal(reopened.revoke(person, 1).selected, null);
});

test('a safely opened constructor record cannot become a never-designated empty state after EIO and deletion', t => {
  const f = fixture(t), saved = fs.readFileSync(f.role.file), restore = oneReadFault(t, f.role.file); let reopened;
  try { reopened = f.open(); } finally { restore(); }
  fs.unlinkSync(f.role.file);
  assert.throws(() => reopened.snapshot(), stateError);
  fs.writeFileSync(f.role.file, saved, { mode: 0o600 });
  assert.throws(() => reopened.snapshot(), stateError, 'Deletion after safe observation is sticky even if a later file reappears');
});

for (const mutation of ['lower-revision', 'changed-same-revision', 'missing', 'unsafe', 'bad-json', 'incomplete', 'unknown-field']) test(`a read EIO does not forgive ${mutation} on the next read or after repairing it`, t => {
  const f = fixture(t), lower = fs.readFileSync(f.role.file);
  f.role.set(person, { identity, runner, budget: { limitMicros: 13 } }, 1);
  const good = fs.readFileSync(f.role.file), restore = oneReadFault(t, f.role.file);
  try { assert.throws(() => f.role.snapshot(), stateError); } finally { restore(); }
  if (mutation === 'lower-revision') fs.writeFileSync(f.role.file, lower);
  if (mutation === 'changed-same-revision') { const changed = JSON.parse(good); changed.selected.runner.profile = 'changed-profile'; fs.writeFileSync(f.role.file, JSON.stringify(changed)); }
  if (mutation === 'missing') fs.unlinkSync(f.role.file);
  if (mutation === 'unsafe') fs.chmodSync(f.role.file, 0o644);
  if (mutation === 'bad-json') fs.writeFileSync(f.role.file, '{synthetic-invalid');
  if (mutation === 'incomplete') fs.writeFileSync(f.role.file, good.subarray(0, good.length - 1));
  if (mutation === 'unknown-field') fs.writeFileSync(f.role.file, JSON.stringify({ ...JSON.parse(good), grants: ['synthetic-extra'] }));
  assert.throws(() => f.role.snapshot(), stateError);
  fs.writeFileSync(f.role.file, good, { mode: 0o600 }); fs.chmodSync(f.role.file, 0o600);
  assert.throws(() => f.role.snapshot(), stateError);
  assert.throws(() => f.role.revoke(person, 2), stateError);
});

for (const [stage, target] of [['lstat', 'directory'], ['lstat', 'selection'], ['open', 'selection'], ['opened-stat', 'selection'], ['final-stat', 'selection'], ['close', 'selection'], ['close', 'directory']]) test(`EIO from ${target} ${stage} remains sticky instead of being treated as a selection read`, t => {
  const f = fixture(t), restore = phaseFault(t, f, stage, target);
  try { assert.throws(() => f.role.snapshot(), stateError); } finally { restore(); }
  assert.throws(() => f.role.snapshot(), stateError);
  assert.throws(() => f.role.revoke(person, 1), stateError);
});

test('a real selection read failure other than EIO remains sticky', t => {
  const f = fixture(t), restore = oneReadFault(t, f.role.file, { code: 'EACCES' });
  try { assert.throws(() => f.role.snapshot(), stateError); } finally { restore(); }
  assert.throws(() => f.role.snapshot(), stateError);
});

test('locked revoke preflight read EIO writes no designation, removes only its own lock, and permits an explicit retry', t => {
  const f = fixture(t), before = fs.readFileSync(f.role.file), restore = oneReadFault(t, f.role.file, { beforeThrow() { assert.equal(fs.lstatSync(f.lock).isFile(), true); } });
  try { assert.throws(() => f.role.revoke(person, 1), stateError); } finally { restore(); }
  assert.deepEqual(fs.readFileSync(f.role.file), before);
  assert.equal(fs.existsSync(f.lock), false);
  assert.deepEqual(fs.readdirSync(f.directory), ['butler.json']);
  assert.equal(f.role.revoke(person, 1).selected, null);
});

for (const stage of ['close', 'unlink']) test(`locked preflight read EIO followed by owned-lock ${stage} failure remains sticky`, t => {
  const f = fixture(t), before = fs.readFileSync(f.role.file), cleanup = phaseFault(t, f, stage, 'lock'), restoreRead = oneReadFault(t, f.role.file);
  try { assert.throws(() => f.role.revoke(person, 1)); }
  finally { restoreRead(); cleanup(); }
  assert.deepEqual(fs.readFileSync(f.role.file), before);
  assert.throws(() => f.role.snapshot(), stateError);
  assert.throws(() => f.role.revoke(person, 1), stateError);
});

test('a replaced synthetic writer lock is retained and makes a preflight read failure sticky', t => {
  const f = fixture(t), marker = 'synthetic other writer marker';
  const restore = oneReadFault(t, f.role.file, { beforeThrow() {
    fs.renameSync(f.lock, path.join(f.directory, 'retained-owned-lock'));
    fs.writeFileSync(f.lock, marker, { mode: 0o600 });
  } });
  try { assert.throws(() => f.role.revoke(person, 1), stateError); } finally { restore(); }
  assert.equal(fs.readFileSync(f.lock, 'utf8'), marker);
  assert.throws(() => f.role.snapshot(), stateError);
});

for (const [stage, target] of [['write', 'selection'], ['fsync', 'selection'], ['fsync', 'directory']]) test(`uncertain ${target} ${stage} remains sticky and never acknowledges a revoke`, t => {
  const f = fixture(t), restore = phaseFault(t, f, stage, target);
  try { assert.throws(() => f.role.revoke(person, 1), stateError); } finally { restore(); }
  assert.throws(() => f.role.snapshot(), stateError);
  assert.throws(() => f.role.revoke(person, 1), stateError);
});

test('a later successful read accepts a newer complete revision but the old expected revision still loses CAS', t => {
  const f = fixture(t), restore = oneReadFault(t, f.role.file);
  try { assert.throws(() => f.role.snapshot(), stateError); } finally { restore(); }
  f.open().set(person, { identity, runner, budget: { limitMicros: 23 } }, 1);
  assert.equal(f.role.snapshot().revision, 2);
  assert.throws(() => f.role.revoke(person, 1), { code: 'ERR_BUTLER_REVISION' });
  assert.equal(f.role.snapshot().selected.budget.limitMicros, 23);
  assert.equal(f.role.revoke(person, 2).revision, 3);
});

test('human status fails closed for the failed read and a later explicit status and revoke recover', async t => {
  const f = fixture(t), ledger = new ButlerLedger(f.directory);
  const api = new ButlerPerson({ role: f.role, ledger, authorizePerson: actor => actor === person });
  const restore = oneReadFault(t, f.role.file); let unavailable;
  try { unavailable = api.status(person); } finally { restore(); }
  assert.equal(unavailable.role.available, false); assert.equal(unavailable.actions.revoke, false);
  const recovered = api.status(person);
  assert.equal(recovered.role.available, true); assert.deepEqual(recovered.role.selected.identity, identity);
  assert.equal((await api.revoke(person, 1)).revoked, true);
});

for (const operation of ['catalog', 'page']) test(`an existing Business ${operation} capability refuses a failed fresh selection read before returning or auditing another page`, t => {
  const f = fixture(t), roomState = new RoomState(f.directory), readAudit = new ButlerReadAudit(f.directory, { authorizePerson: actor => actor === person });
  const bound = new ButlerBusiness({ role: f.role, roomState, readAudit, dataDir: f.directory, view: () => ({ records: f.records }) }).bind(f.actor, expected);
  assert.equal(bound.invoke('readBusiness', { kind: 'spaces' }).readOnly, true);
  const log = path.join(f.directory, 'butler-business-reads.jsonl'), before = fs.readFileSync(log), restore = oneReadFault(t, f.role.file);
  try { assert.throws(() => operation === 'catalog' ? bound.catalog() : bound.invoke('readBusiness', { kind: 'spaces' }), stateError); }
  finally { restore(); }
  assert.deepEqual(fs.readFileSync(log), before);
  assert.equal(bound.catalog().readOnly, true);
});

test('a delayed Queue transaction rechecks selection at commit, writes nothing on EIO, and permits a later explicit retry', async t => {
  const f = fixture(t), ledger = new ButlerLedger(f.directory), selection = { selectionRevision: 1, identity, runnerRef: runner.runnerRef };
  ledger.ingest({ eventId: 'selection-event', sourceRef: 'task:selection', kind: 'request', payload: { text: 'Synthetic queue request' } });
  const batch = ledger.beginBatch(selection);
  ledger.completeBatch(batch.batchId, selection, { actions: [{ kind: 'queue', sourceRef: 'task:selection', spaceId: 'shared', text: 'Synthetic queue request' }] });
  const actionId = ledger.snapshot().actions[0].actionId; let fault = true, commits = 0;
  const adapter = { async transact(request, guard) {
    await Promise.resolve();
    if (fault) {
      fault = false; const restore = oneReadFault(t, f.role.file);
      try { guard(); } finally { restore(); }
    } else guard();
    commits++;
    return { operationId: request.operationId, fingerprint: request.fingerprint, spaceId: request.spaceId, itemId: 'synthetic-committed-item', duplicate: false };
  } };
  const queue = new ButlerQueue({ role: f.role, ledger, view: () => ({ records: f.records, spaces: [{ id: 'shared', archived: false, writable: true }] }), adapter, authorizeQueue: () => true });
  await assert.rejects(queue.add(f.actor, expected, actionId), stateError);
  assert.equal(commits, 0);
  assert.equal((await queue.add(f.actor, expected, actionId)).status, 'queued');
  assert.equal(commits, 1);
});

// The person reads a saved snapshot before resolving its current identity. Fail
// the next read's first byte, rather than accidentally hitting the snapshot.
function resolutionReadFault(t, file) {
  const inode = fs.statSync(file), read = fs.readSync, stat = fs.fstatSync; let starts = 0, fired = 0;
  t.mock.method(fs, 'readSync', (fd, ...args) => {
    if (same(stat(fd), inode) && args[1] === 0 && ++starts === 2) { fired++; throw readError(); }
    return read(fd, ...args);
  });
  return () => { t.mock.restoreAll(); assert.equal(fired, 1, 'Only the identity-resolution selection read fails'); };
}

test('human status may refresh saved selection after resolution EIO but never shows a guessed current identity', t => {
  const f = fixture(t), ledger = new ButlerLedger(f.directory), before = fs.readFileSync(f.role.file);
  let stops = 0;
  const api = new ButlerPerson({ role: f.role, ledger, authorizePerson: actor => actor === person, stopOwned() { stops++; } });
  const restore = resolutionReadFault(t, f.role.file); let view;
  try { view = api.status(person); } finally { restore(); }
  assert.equal(view.state, 'unknown'); assert.equal(view.role.available, true); assert.equal(view.role.currentAvailable, false);
  assert.equal(view.role.revision, 1); assert.equal(view.role.selected.identity, null);
  assert.equal(view.actions.revoke, true); assert.equal(view.actions.close, false); assert.equal(stops, 0);
  assert.deepEqual(fs.readFileSync(f.role.file), before);
  assert.deepEqual(f.role.current().identity, identity);
});

test('selection EIO while resolving human revoke still clears the saved role and never invents a stop target', async t => {
  const f = fixture(t), ledger = new ButlerLedger(f.directory); let stops = 0;
  ledger.ingest({ eventId: 'retained-selection-fact', sourceRef: 'task:retained-selection', kind: 'request', payload: { text: 'Synthetic retained task' } });
  const ledgerFile = path.join(f.directory, 'butler-ledger.jsonl'), before = fs.readFileSync(ledgerFile);
  const api = new ButlerPerson({ role: f.role, ledger, authorizePerson: actor => actor === person, stopOwned() { stops++; } });
  const restore = resolutionReadFault(t, f.role.file); let result;
  try { result = await api.revoke(person, 1); } finally { restore(); }
  assert.equal(result.revoked, true); assert.equal(result.revision, 2);
  assert.equal(result.shutdown.status, 'unconfirmed'); assert.equal(result.shutdown.target, null);
  assert.equal(result.shutdown.stopped, null); assert.equal(result.shutdown.cleanupConfirmed, null); assert.equal(stops, 0);
  assert.equal(f.role.snapshot().selected, null); assert.deepEqual(fs.readFileSync(ledgerFile), before);
});
