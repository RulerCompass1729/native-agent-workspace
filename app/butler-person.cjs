'use strict';
// Person-only, source-phase controls. No provider bootstrap or activation state.
const { ButlerRole } = require('./butler-role.cjs');
const { summarizeUsage } = require('./butler-usage.cjs');
const off = () => ({ activation: 'off', recordPeriod: 'off' });
const fail = code => { throw Object.assign(Error(code), { code }); };
const revision = value => Number.isSafeInteger(value) && value >= 0;
const runnerFields = ['runnerRef', 'backendRef', 'purpose', 'profile', 'provider', 'model'];
const backendStates = new Set(['unprepared', 'prepared', 'qualifying', 'blocked', 'recovering', 'starting', 'ready', 'failed', 'unknown', 'unconfirmed']);
const backendUnreadable = new Set(['binding-mismatch', 'unsafe-record', 'state-invalid', 'unsafe-store', 'store-unavailable',
  'unsafe-directory', 'directory-unavailable', 'state-unavailable']);
const backendReasons = new Set(['configuration-unset', 'runtime-unqualified', 'credential-missing', 'credential-presence-invalid',
  'qualification-invalid', 'tools-unqualified', 'context-unqualified', 'provider-unqualified', 's2-unqualified', 'driver-unavailable',
  'backend-busy', 'owner-unconfirmed', 'recover-failed', 'liveness-unconfirmed', 'start-failed', 'start-unconfirmed', 'recovery-required', ...backendUnreadable]);
const failureReasons = new Set(['usage-cost-unknown', 'usage-cost-invalid', 'daily-budget-reached', 'next-batch-cost-unknown', 'budget-unset', 'restart-unconfirmed']);
const plain = value => value && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
function sameTarget(current, target) {
  return current?.selectionRevision === target.selectionRevision && current.identity?.sessionId === target.identity.sessionId &&
    current.identity?.nativeId === target.identity.nativeId && runnerFields.every(key => current.runner?.[key] === target.runner[key]);
}
function targetFor(current) {
  if (!current?.identity?.sessionId || !current.identity.nativeId) fail('ERR_BUTLER_STATE');
  return Object.freeze({ selectionRevision: current.selectionRevision, identity: Object.freeze({ ...current.identity }),
    runner: Object.freeze(Object.fromEntries(runnerFields.map(key => [key, current.runner[key]]))) });
}
function shutdown(target, status, reason) {
  return { ...off(), status, stopped: status === 'confirmed' ? true : null, cleanupConfirmed: status === 'confirmed' ? true : null,
    target: target ? { selectionRevision: target.selectionRevision, identity: { ...target.identity }, runnerRef: target.runner.runnerRef } : null,
    ...(reason ? { reason } : {}) };
}
function usageReading(snapshot, now) {
  const value = summarizeUsage(snapshot, { now }), { sources, ...today } = value.today;
  const result = structuredClone({ state: today.recordedRunCount ? 'recorded' : 'unverified', utcDay: value.utcDay, asOf: value.asOf,
    today: { ...today, sources: { knownCount: sources.values.length, unknownRuns: sources.unknownRuns } }, guard: value.guard });
  // The helper's zero means no recorded amounts. It cannot certify that an
  // unobserved provider made zero requests or spent zero money.
  if (!today.recordedRunCount) for (const reading of [result.today.costMicros, ...Object.values(result.today.tokens)]) reading.value = null;
  return result;
}
function recordedPause(snapshot, current) {
  const batch = snapshot?.activeBatch;
  if (!current || batch?.status !== 'failed' || batch.selection?.selectionRevision !== current.selectionRevision ||
      batch.selection.runnerRef !== current.runner.runnerRef || batch.selection.identity?.sessionId !== current.identity.sessionId ||
      batch.selection.identity?.nativeId !== current.identity.nativeId || !revision(batch.physicalSeq) || !revision(snapshot.sequence) ||
      batch.physicalSeq > snapshot.sequence || !revision(batch.failedAt)) return null;
  return { batchId: batch.batchId, batchPhysicalSeq: batch.physicalSeq, ledgerThroughSequence: snapshot.sequence,
    failedAt: batch.failedAt, reason: failureReasons.has(batch.failure) ? batch.failure : 'recorded-batch-failure' };
}

class ButlerPerson {
  #presence;
  constructor({ role, ledger, backend, credentialPresent, stopOwned, authorizePerson = () => false, now = Date.now } = {}) {
    this.role = role; this.ledger = ledger; this.backend = backend;
    this.credentialPresent = credentialPresent; this.stopOwned = stopOwned;
    this.authorizePerson = authorizePerson; this.now = now;
  }
  #person(actor) {
    let allowed = false;
    try { allowed = this.authorizePerson(actor) === true; } catch {}
    if (!allowed) fail('ERR_BUTLER_PERSON');
  }
  #role() {
    if (!(this.role instanceof ButlerRole)) fail('ERR_BUTLER_STATE');
    const snapshot = this.role.snapshot(), current = snapshot.selected ? this.role.current() : null;
    if (snapshot.selected && (!current?.identity || current.selectionRevision !== snapshot.revision)) fail('ERR_BUTLER_STATE');
    return { snapshot, current };
  }
  #expected(expected) {
    if (!revision(expected)) fail('ERR_BUTLER_REQUEST');
    const state = this.#role();
    if (state.snapshot.revision !== expected) fail('ERR_BUTLER_REVISION');
    return state;
  }
  #backend() {
    try {
      const raw = typeof this.backend?.snapshot === 'function' ? this.backend.snapshot() : this.backend?.read();
      if (raw == null && this.backend) return { available: true, state: 'unprepared', ready: false, blocked: [] };
      if (!plain(raw)) throw Error('Unavailable');
      return { available: true, state: backendStates.has(raw.state) ? raw.state : 'unknown', ready: raw.state === 'ready' && raw.ready === true,
        blocked: Array.isArray(raw.blocked) ? raw.blocked.filter(reason => backendReasons.has(reason) &&
          (reason !== 'credential-missing' || this.#presence === false)) : [] };
    } catch (error) {
      let mismatch = false; try { mismatch = error?.code === 'binding-mismatch'; } catch {}
      return { available: false, state: mismatch ? 'blocked' : 'unknown', ready: false, blocked: [mismatch ? 'binding-mismatch' : 'backend-unavailable'] };
    }
  }
  #view() {
    let state = null, rawLedger = null, usage = { state: 'unavailable' };
    try { state = this.#role(); } catch {}
    try { rawLedger = this.ledger.snapshot(); usage = usageReading(rawLedger, this.now()); } catch {}
    const backend = this.#backend(), selected = state?.snapshot.selected, current = state?.current;
    // Old Boolean gates persisted false for both absent and unconfirmed. Only
    // this object's explicit display probe can establish a presence reading.
    const presence = this.#presence === undefined ? null : this.#presence;
    const unknown = !state || !backend.available || ['unknown', 'unconfirmed', 'failed'].includes(backend.state) ||
      backend.blocked.some(reason => backendUnreadable.has(reason)) || usage.state === 'unavailable';
    let pause = null; if (usage.state !== 'unavailable') { try { pause = recordedPause(rawLedger, current); } catch {} }
    return { ...off(), state: !state ? 'unknown' : !selected ? 'empty' : unknown ? 'unknown' : 'selected-disabled',
      role: state ? { available: true, revision: state.snapshot.revision, selected: selected ? {
        identity: { ...current.identity }, configuration: { profile: current.runner.profile, provider: current.runner.provider, model: current.runner.model },
        budget: selected.budget ? { ...selected.budget } : null } : null } : { available: false, revision: null, selected: null },
      backend, credentialPresent: presence, usage, pause,
      dailyReminder: { currency: 'USD', amountMicros: 2000000, dayBoundary: 'UTC', onReached: 'undecided' },
      actions: { designate: false, recheck: Boolean(state), revoke: Boolean(state && selected), open: false, close: Boolean(current && typeof this.stopOwned === 'function') } };
  }
  status(actor) { this.#person(actor); if (arguments.length !== 1) fail('ERR_BUTLER_REQUEST'); return this.#view(); }
  recheck(actor) {
    this.#person(actor); if (arguments.length !== 1) fail('ERR_BUTLER_REQUEST');
    this.#presence = null;
    try { const value = this.credentialPresent?.(); this.#presence = value === true ? true : value === false ? false : null; } catch {}
    return this.#view();
  }
  designate(actor, expectedRevision) {
    this.#person(actor); if (arguments.length !== 2) fail('ERR_BUTLER_REQUEST'); this.#expected(expectedRevision);
    // C5 does not yet supply the persistent actual record/proof producer. Do
    // not turn a person intent into an invented identity or a Role.set call.
    return { ...off(), status: 'blocked', reason: 'trusted-candidate-unavailable' };
  }
  async #stop(actor, target, unchanged) {
    if (!target || typeof this.stopOwned !== 'function') return shutdown(target, 'unconfirmed', 'owned-stop-unavailable');
    try { this.#person(actor); if (!unchanged()) return shutdown(target, 'unconfirmed', 'selection-changed'); }
    catch { return shutdown(target, 'unconfirmed', 'selection-changed'); }
    let receipt;
    try { receipt = await this.stopOwned(target); } catch { return shutdown(target, 'unconfirmed', 'owned-stop-unconfirmed'); }
    try { this.#person(actor); if (!unchanged()) return shutdown(target, 'unconfirmed', 'selection-changed'); }
    catch { return shutdown(target, 'unconfirmed', 'selection-changed'); }
    // The host adapter owns target resolution and the real exit receipt. A
    // copied target or Controller.close's void result is not that receipt.
    if (!plain(receipt) || receipt.target !== target || receipt.stopped !== true || receipt.cleanupConfirmed !== true)
      return shutdown(target, 'unconfirmed', 'owned-stop-unconfirmed');
    return shutdown(target, 'confirmed');
  }
  async setActive(actor, active, expectedRevision) {
    this.#person(actor); if (arguments.length !== 3 || typeof active !== 'boolean') fail('ERR_BUTLER_REQUEST');
    if (active) fail('ERR_BUTLER_ACTIVATION_DISABLED');
    const { current } = this.#expected(expectedRevision), target = current ? targetFor(current) : null;
    return this.#stop(actor, target, () => sameTarget(this.#role().current, target));
  }
  async revoke(actor, expectedRevision) {
    this.#person(actor); if (arguments.length !== 2) fail('ERR_BUTLER_REQUEST');
    const { current } = this.#expected(expectedRevision), target = current ? targetFor(current) : null;
    const result = this.role.revoke(actor, expectedRevision);
    const cleanup = await this.#stop(actor, target, () => { const state = this.role.snapshot(); return state.revision === result.revision && state.selected === null; });
    return { ...off(), revoked: true, revision: result.revision, shutdown: cleanup };
  }
}
module.exports = { ButlerPerson };
