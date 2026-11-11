'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { ButlerRole } = require('../butler-role.cjs');
const { ButlerLedger } = require('../butler-ledger.cjs');
const { ButlerBackend } = require('../butler-backend.cjs');
const { summarizeUsage } = require('../butler-usage.cjs');
const person = Symbol('opaque person');
const identity = { sessionId: 'person-butler', nativeId: 'person-native' };
const runner = { runnerRef: 'person-runner', backendRef: 'person-backend', purpose: 'butler',
  profile: 'host-profile', provider: 'host-provider', model: 'host-model' };
const selected = (extra = {}) => ({ identity: { ...identity }, runner: { ...runner }, ...extra });
const now = Date.UTC(2026, 10, 11, 12);
const construct = options => new (require('../butler-person.cjs').ButlerPerson)(options);
function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-butler-person-')); fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const role = new ButlerRole(directory, { authorizePerson: actor => actor === person });
  const ledger = new ButlerLedger(directory, { now: () => now });
  const backend = { snapshot: () => ({ state: 'unprepared', ready: false, blocked: ['runtime-unqualified'] }) };
  const make = extra => construct({ role, ledger, backend, now: () => now, authorizePerson: actor => actor === person, ...options, ...extra });
  return { directory, role, ledger, backend, make };
}
const bytes = file => fs.existsSync(file) ? fs.readFileSync(file) : null;
const ledgerFile = f => path.join(f.directory, 'butler-ledger.jsonl');
const sameFiles = (f, before) => { assert.deepEqual(bytes(f.role.file), before.role); assert.deepEqual(bytes(ledgerFile(f)), before.ledger); };

test('all five actions require literal opaque person authorization before reading or affecting dependencies', async t => {
  const f = fixture(t), calls = [];
  for (const name of ['snapshot', 'current', 'set', 'revoke']) { const original = f.role[name].bind(f.role); f.role[name] = (...args) => { calls.push('role:' + name); return original(...args); }; }
  const api = f.make({ ledger: { snapshot() { calls.push('ledger'); throw Error('Must not read'); } },
    backend: { snapshot() { calls.push('backend'); } }, credentialPresent() { calls.push('presence'); return true; },
    stopOwned() { calls.push('stop'); } });
  for (const actor of [undefined, null, { kind: 'person' }, Symbol('opaque person')]) {
    assert.throws(() => api.status(actor), { code: 'ERR_BUTLER_PERSON' });
    assert.throws(() => api.recheck(actor), { code: 'ERR_BUTLER_PERSON' });
    assert.throws(() => api.designate(actor, 0), { code: 'ERR_BUTLER_PERSON' });
    await assert.rejects(api.revoke(actor, 0), { code: 'ERR_BUTLER_PERSON' });
    await assert.rejects(api.setActive(actor, false, 0), { code: 'ERR_BUTLER_PERSON' });
  }
  assert.deepEqual(calls, []);
  for (const authorizePerson of [undefined, () => 1, () => { throw Error('Unknown human'); }]) {
    const denied = construct({ role: f.role, authorizePerson });
    assert.throws(() => denied.status(person), { code: 'ERR_BUTLER_PERSON' });
  }
});

test('empty status is off, unverified rather than a measured zero, and does not create a designation or budget', t => {
  const f = fixture(t), api = f.make(), view = api.status(person);
  assert.equal(view.state, 'empty'); assert.equal(view.activation, 'off'); assert.equal(view.recordPeriod, 'off');
  assert.deepEqual(view.role, { available: true, currentAvailable: true, revision: 0, selected: null });
  assert.equal(view.credentialPresent, null); assert.equal(view.usage.state, 'unverified');
  assert.equal(view.usage.today.costMicros.value, null); assert.equal(view.usage.today.costMicros.knownLowerBound, 0);
  assert.equal(view.usage.today.providerRequestCount, null); assert.equal(view.usage.today.recordedRunCount, 0);
  assert.deepEqual(view.dailyReminder, { currency: 'USD', amountMicros: 2000000, dayBoundary: 'UTC', onReached: 'undecided' });
  assert.deepEqual(view.actions, { designate: false, recheck: true, revoke: false, open: false, close: false });
  assert.equal(fs.existsSync(f.role.file), false); assert.equal(fs.existsSync(ledgerFile(f)), false);
});

test('a selected ready backend remains disabled and is never presented as physically running or stopped', t => {
  const f = fixture(t); f.role.set(person, selected(), 0);
  const api = f.make({ backend: { snapshot: () => ({ state: 'ready', ready: true, binding: { secret: 'omit' } }),
    ensure() { throw Error('No ensure'); }, prepare() { throw Error('No prepare'); }, start() { throw Error('No start'); } }, credentialPresent: () => true });
  const view = api.status(person);
  assert.equal(view.state, 'selected-disabled'); assert.equal(view.backend.ready, true);
  assert.equal(view.activation, 'off'); assert.equal(view.recordPeriod, 'off');
  assert.equal(view.role.selected.budget, null); assert.equal(view.actions.open, false); assert.equal(view.actions.close, false);
  assert.equal(view.running, undefined); assert.equal(view.stopped, undefined); assert.equal(view.backend.binding, undefined);
  assert.equal(f.role.snapshot().selected.budget, null);
});

test('only explicit recheck calls presence once; status reads the instance cache without probing', t => {
  const f = fixture(t);
  for (const [value, expected] of [[true, true], [false, false], [null, null], [undefined, null], ['set', null], [{ credentialPresent: true }, null], [Promise.resolve(true), null]]) {
    let probes = 0;
    const api = f.make({ credentialPresent: () => { probes++; return value; } });
    assert.equal(probes, 0); assert.equal(api.status(person).credentialPresent, null); assert.equal(probes, 0);
    assert.equal(api.recheck(person).credentialPresent, expected); assert.equal(probes, 1);
    assert.equal(api.status(person).credentialPresent, expected); assert.equal(probes, 1);
  }
  assert.equal(f.make({ credentialPresent() { throw Error('Private launch details'); } }).recheck(person).credentialPresent, null);
});

test('legacy backend presence is never treated as a successful display probe', t => {
  const f = fixture(t);
  for (const [checked, present] of [[true, true], [true, false], [false, false], [undefined, true], [true, 'set']]) {
    const api = f.make({ backend: { snapshot: () => ({ state: 'blocked', ready: false, credentialChecked: checked, credentialPresent: present }) },
      credentialPresent: () => undefined });
    assert.equal(api.status(person).credentialPresent, null);
    assert.equal(api.recheck(person).credentialPresent, null); assert.equal(api.status(person).credentialPresent, null);
  }
  let probes = 0;
  const options = { credentialPresent: () => { probes++; return true; } };
  assert.equal(f.make(options).recheck(person).credentialPresent, true);
  assert.equal(f.make(options).status(person).credentialPresent, null); assert.equal(probes, 1, 'A new instance inherits no presence cache');
  const unread = { state: 'blocked', ready: false };
  for (const key of ['credentialPresent', 'credentialChecked']) Object.defineProperty(unread, key, { get() { throw Error('Do not consult legacy presence'); } });
  assert.equal(f.make({ backend: { snapshot: () => unread } }).status(person).backend.available, true);
});

test('real backend upgrade mismatch is a small blocked reading without raw binding, paths or exception text', t => {
  const f = fixture(t); f.role.set(person, selected(), 0);
  const directory = path.join(f.directory, 'backend');
  new ButlerBackend(directory, { runtimeVersion: 'old', configuration: { profile: 'old-profile', provider: 'old-provider', model: 'old-model' } }).prepare();
  const backend = new ButlerBackend(directory, { runtimeVersion: 'new', configuration: { profile: 'new-profile', provider: 'new-provider', model: 'new-model' } });
  const view = f.make({ backend }).status(person);
  assert.equal(view.state, 'unknown'); assert.deepEqual(view.backend, { available: false, state: 'blocked', ready: false, blocked: ['binding-mismatch'] });
  for (const omitted of [directory, 'old-profile', 'new-profile', 'binding.json']) assert.equal(JSON.stringify(view).includes(omitted), false);
  const readOnly = f.make({ backend: { read() { throw Object.assign(Error('Private exception body'), { code: 'binding-mismatch' }); } } }).status(person);
  assert.deepEqual(readOnly.backend, view.backend); assert.equal(JSON.stringify(readOnly).includes('Private exception body'), false);
});

test('the DSH factory storage-refusal codes remain visible as unknown instead of an ordinary disabled state', t => {
  const f = fixture(t); f.role.set(person, selected(), 0);
  for (const reason of ['unsafe-record', 'state-invalid', 'unsafe-store', 'store-unavailable', 'unsafe-directory', 'directory-unavailable', 'state-unavailable']) {
    const view = f.make({ backend: { snapshot: () => ({ state: 'blocked', ready: false, binding: null, blocked: [reason] }) } }).status(person);
    assert.equal(view.state, 'unknown', reason); assert.deepEqual(view.backend.blocked, [reason]);
  }
});

test('unavailable role and ledger stay unknown and never export raw exception messages', t => {
  const f = fixture(t); f.role.set(person, selected(), 0);
  const failed = f.make({ ledger: { snapshot() { throw Error('Private native body'); } } }).status(person);
  assert.equal(failed.state, 'unknown'); assert.deepEqual(failed.usage, { state: 'unavailable' }); assert.equal(failed.pause, null);
  const roleMissing = f.make({ role: null }).status(person); assert.equal(roleMissing.state, 'unknown'); assert.equal(roleMissing.role.available, false);
  assert.equal(roleMissing.actions.recheck, false, 'Main cannot validate a recheck revision while the role is unavailable');
  assert.equal(JSON.stringify([failed, roleMissing]).includes('Private native body'), false);
});

test('an unverifiable snapshot cannot supply a pause or a contradictory ready claim', t => {
  const f = fixture(t); f.role.set(person, selected(), 0);
  const malformed = { sequence: 4, activeBatch: { batchId: 'unverified', status: 'failed', failedAt: now, physicalSeq: 2,
    selection: { selectionRevision: 1, identity, runnerRef: runner.runnerRef }, failure: 'usage-cost-unknown' } };
  const view = f.make({ ledger: { snapshot: () => malformed }, backend: { snapshot: () => ({ state: 'unconfirmed', ready: true }) } }).status(person);
  assert.equal(view.state, 'unknown'); assert.equal(view.usage.state, 'unavailable'); assert.equal(view.pause, null);
  assert.equal(view.backend.ready, false);
});

test('usage reuses shared readings, preserves unknown source and estimate counts, and omits arbitrary source bodies', t => {
  const f = fixture(t), snapshot = { attempts: [
    { batchId: 'known', startedAt: now, usage: { costMicros: 7, inputTokens: 2, source: 'PRIVATE_SOURCE_BODY', estimated: true } },
    { batchId: 'unknown', startedAt: now, usage: null }
  ], batches: [], events: [], activeBatch: null, sequence: 4 };
  Object.defineProperty(snapshot, 'nativeHistory', { get() { throw Error('Do not read private history'); } });
  const expected = summarizeUsage(snapshot, { now }), view = f.make({ ledger: { snapshot: () => snapshot } }).status(person);
  assert.deepEqual(view.usage.today.costMicros, expected.today.costMicros); assert.deepEqual(view.usage.today.tokens, expected.today.tokens);
  assert.deepEqual(view.usage.today.estimated, expected.today.estimated); assert.equal(view.usage.today.sources.unknownRuns, 1);
  assert.equal(view.usage.today.sources.knownCount, 1); assert.equal(view.usage.today.providerRequestCount, null);
  assert.deepEqual(view.usage.guard, expected.guard); assert.equal(JSON.stringify(view).includes('PRIVATE_SOURCE_BODY'), false);
  assert.equal(view.pause, null, 'Computed usage guard is not a recorded pause');
});

test('pause is only a recorded failed active batch matching current role and exposes honest sequence names', t => {
  const f = fixture(t); f.role.set(person, selected(), 0);
  f.ledger.ingest({ eventId: 'request', sourceRef: 'task:one', kind: 'request', payload: { text: 'Synthetic task' } });
  const batch = f.ledger.beginBatch({ selectionRevision: 1, identity, runnerRef: runner.runnerRef });
  const api = f.make(); assert.equal(api.status(person).pause, null, 'A running batch is never paused');
  f.ledger.failBatch(batch.batchId, 'usage-cost-unknown'); const snapshot = f.ledger.snapshot(), pause = api.status(person).pause;
  assert.deepEqual(pause, { batchId: batch.batchId, batchPhysicalSeq: snapshot.activeBatch.physicalSeq,
    ledgerThroughSequence: snapshot.sequence, failedAt: now, reason: 'usage-cost-unknown' });
  f.role.set(person, selected(), 1); assert.equal(api.status(person).pause, null, 'Former designation revision cannot pause a replacement');
});

test('B1 blocked events and a rotated identity with the same revision never become a current butler pause', t => {
  const f = fixture(t); f.role.set(person, selected(), 0);
  f.ledger.ingest({ eventId: 'b1', sourceRef: 'queue:b1', kind: 'blocked', payload: { reason: 'usage-cost-unknown' } });
  const api = f.make(); assert.equal(api.status(person).pause, null);
  const batch = f.ledger.beginBatch({ selectionRevision: 1, identity, runnerRef: runner.runnerRef }); f.ledger.failBatch(batch.batchId, 'Synthetic private failure text');
  assert.equal(api.status(person).pause.reason, 'recorded-batch-failure');
  fs.writeFileSync(f.role.logFile, JSON.stringify({ event: 'done', old: { id: identity.sessionId, nativeId: identity.nativeId },
    new: { id: 'next-person-butler', nativeId: 'next-person-native' } }) + '\n', { mode: 0o600 });
  assert.equal(api.status(person).pause, null);
});

test('designation stays blocked without an actual trusted producer and never writes an inferred budget or identity', t => {
  const f = fixture(t), api = f.make(), before = { role: bytes(f.role.file), ledger: bytes(ledgerFile(f)) };
  assert.deepEqual(api.designate(person, 0), { status: 'blocked', reason: 'trusted-candidate-unavailable', activation: 'off', recordPeriod: 'off' });
  assert.throws(() => api.designate(person, { expectedRevision: 0, identity, runner, budget: { limitMicros: 2000000 } }), { code: 'ERR_BUTLER_REQUEST' });
  assert.throws(() => api.designate(person, 1), { code: 'ERR_BUTLER_REVISION' }); sameFiles(f, before);
});

test('activation true is a hard phase rejection before any dependency work', async () => {
  const api = construct({ authorizePerson: actor => actor === person,
    credentialPresent() { throw Error('No presence check'); }, stopOwned() { throw Error('No stop'); } });
  await assert.rejects(api.setActive(person, true, 0), { code: 'ERR_BUTLER_ACTIVATION_DISABLED' });
});

test('human requests cannot supply another identity, runner, scope or control capability', async () => {
  const api = construct({ authorizePerson: actor => actor === person,
    credentialPresent() { throw Error('Invalid arguments must not inspect presence'); },
    stopOwned() { throw Error('Invalid arguments must not stop anything'); } });
  const invented = { identity, runner, capabilities: ['start'], scope: 'all-sessions' };
  assert.throws(() => api.status(person, invented), { code: 'ERR_BUTLER_REQUEST' });
  assert.throws(() => api.recheck(person, invented), { code: 'ERR_BUTLER_REQUEST' });
  assert.throws(() => api.designate(person, 0, invented), { code: 'ERR_BUTLER_REQUEST' });
  await assert.rejects(api.revoke(person, 0, invented), { code: 'ERR_BUTLER_REQUEST' });
  await assert.rejects(api.setActive(person, false, 0, invented), { code: 'ERR_BUTLER_REQUEST' });
});

test('an empty designation never falls back to stopping another runtime', async t => {
  const f = fixture(t); let stops = 0;
  const api = f.make({ stopOwned() { stops++; throw Error('No designated target'); } });
  assert.equal((await api.setActive(person, false, 0)).status, 'unconfirmed');
  assert.equal((await api.revoke(person, 0)).shutdown.status, 'unconfirmed');
  assert.equal(stops, 0);
});

test('a close request without an owned stop adapter is unconfirmed and retains role and ledger', async t => {
  const f = fixture(t); f.role.set(person, selected(), 0); f.ledger.ingest({ eventId: 'fact', sourceRef: 'task:fact', kind: 'request', payload: { text: 'Retained fact' } });
  const before = { role: bytes(f.role.file), ledger: bytes(ledgerFile(f)) }, result = await f.make().setActive(person, false, 1);
  assert.equal(result.status, 'unconfirmed'); assert.equal(result.stopped, null); assert.equal(result.cleanupConfirmed, null);
  assert.equal(result.reason, 'owned-stop-unavailable'); assert.equal(result.activation, 'off'); sameFiles(f, before);
});

test('only an exact owned target receipt confirms physical cleanup; source off is not a persisted closed state', async t => {
  const f = fixture(t); f.role.set(person, selected(), 0); let target;
  const api = f.make({ stopOwned: async value => { target = value; return { target: value, stopped: true, cleanupConfirmed: true }; } });
  assert.equal(api.status(person).actions.close, true);
  const result = await api.setActive(person, false, 1);
  assert.equal(result.status, 'confirmed'); assert.equal(result.stopped, true); assert.equal(result.cleanupConfirmed, true);
  assert.deepEqual(target.identity, identity); assert.deepEqual(target.runner, runner); assert.equal(target.selectionRevision, 1);
  assert.equal(Object.isFrozen(target), true); assert.equal(Object.isFrozen(target.identity), true);
  assert.equal(api.status(person).state, 'selected-disabled'); assert.equal(f.role.snapshot().selected.budget, null);
});

test('boolean, missing, copied and negative receipts cannot turn Controller.close-like results into proof', async t => {
  const f = fixture(t); f.role.set(person, selected(), 0);
  for (const receipt of [() => true, () => false, () => undefined, target => ({ target, stopped: true, cleanupConfirmed: false }),
    target => ({ target, stopped: false, cleanupConfirmed: true }), target => ({ target: { ...target }, stopped: true, cleanupConfirmed: true }),
    () => Promise.resolve()]) {
    const result = await f.make({ stopOwned: async target => receipt(target) }).setActive(person, false, 1);
    assert.equal(result.status, 'unconfirmed'); assert.equal(result.stopped, null); assert.equal(result.cleanupConfirmed, null);
  }
});

test('a delayed close is bound to the old identity and cannot confirm a replacement stopped', async t => {
  const f = fixture(t); f.role.set(person, selected(), 0); let resolve, captured;
  const api = f.make({ stopOwned: target => { captured = target; return new Promise(done => { resolve = done; }); } });
  const pending = api.setActive(person, false, 1);
  const next = { sessionId: 'replacement', nativeId: 'replacement-native' }; f.role.set(person, selected({ identity: next }), 1);
  resolve({ target: captured, stopped: true, cleanupConfirmed: true });
  const result = await pending; assert.equal(result.status, 'unconfirmed'); assert.equal(result.reason, 'selection-changed');
  assert.deepEqual(captured.identity, identity); assert.deepEqual(f.role.snapshot().selected.identity, next);
});

test('done succession during cleanup invalidates a shutdown receipt even without a role revision change', async t => {
  const f = fixture(t); f.role.set(person, selected(), 0); let resolve, target;
  const api = f.make({ stopOwned: captured => { target = captured; return new Promise(done => { resolve = done; }); } });
  const pending = api.setActive(person, false, 1);
  fs.writeFileSync(f.role.logFile, JSON.stringify({ event: 'done', old: { id: identity.sessionId, nativeId: identity.nativeId },
    new: { id: 'rotated-person', nativeId: 'rotated-native' } }) + '\n', { mode: 0o600 });
  assert.equal(f.role.snapshot().revision, 1);
  resolve({ target, stopped: true, cleanupConfirmed: true });
  const result = await pending; assert.equal(result.status, 'unconfirmed'); assert.equal(result.reason, 'selection-changed');
  assert.deepEqual(target.identity, identity);
});

test('owned stop exceptions return fixed uncertainty without exposing native details', async t => {
  const f = fixture(t); f.role.set(person, selected(), 0);
  const result = await f.make({ stopOwned() { throw Error('PRIVATE_NATIVE_STOP_BODY'); } }).setActive(person, false, 1);
  assert.equal(result.status, 'unconfirmed'); assert.equal(result.reason, 'owned-stop-unconfirmed');
  assert.equal(JSON.stringify(result).includes('PRIVATE_NATIVE_STOP_BODY'), false);
});

test('revoke persists the real role first, preserves the ledger and then only asks to stop the captured instance', async t => {
  const f = fixture(t); f.role.set(person, selected(), 0); f.ledger.ingest({ eventId: 'kept', sourceRef: 'task:kept', kind: 'request', payload: { text: 'Retained record' } });
  const before = bytes(ledgerFile(f)); let seen;
  const api = f.make({ stopOwned: async target => { assert.equal(f.role.snapshot().selected, null); seen = target;
    return { target, stopped: true, cleanupConfirmed: true }; } });
  await assert.rejects(api.revoke(person, 0), { code: 'ERR_BUTLER_REVISION' }); assert.equal(seen, undefined);
  const result = await api.revoke(person, 1);
  assert.equal(result.revoked, true); assert.equal(result.revision, 2); assert.equal(result.shutdown.status, 'confirmed');
  assert.deepEqual(seen.identity, identity); assert.deepEqual(bytes(ledgerFile(f)), before);
  assert.equal(new ButlerRole(f.directory, { authorizePerson: actor => actor === person }).snapshot().selected, null);
});

test('revoke without a stop adapter succeeds durably but never claims the process stopped', async t => {
  const f = fixture(t); f.role.set(person, selected(), 0);
  const result = await f.make().revoke(person, 1);
  assert.equal(result.revoked, true); assert.equal(result.shutdown.status, 'unconfirmed'); assert.equal(result.shutdown.stopped, null);
  assert.equal(f.role.snapshot().selected, null); assert.equal(result.activation, 'off');
});

test('a new designation during revoked-instance cleanup cannot be labelled stopped', async t => {
  const f = fixture(t); f.role.set(person, selected(), 0); let resolve, target;
  const api = f.make({ stopOwned: captured => { target = captured; return new Promise(done => { resolve = done; }); } });
  const pending = api.revoke(person, 1); assert.equal(f.role.snapshot().selected, null);
  f.role.set(person, selected({ identity: { sessionId: 'new-owner', nativeId: 'new-native' } }), 2);
  resolve({ target, stopped: true, cleanupConfirmed: true });
  const result = await pending; assert.equal(result.shutdown.status, 'unconfirmed'); assert.equal(result.shutdown.reason, 'selection-changed');
  assert.equal(f.role.snapshot().revision, 3);
});
