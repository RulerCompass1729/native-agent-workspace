// The person's model change of one session (N5): applied at once for Codex, and for Claude as soon as nothing
// would be cut off by stopping and resuming it. Held by the app while it waits; nothing here starts a turn.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { uiError } = require('./ui-errors.cjs');
const { sessionPlan, runningIn } = require('./backend-switch.cjs');
const sessionModel = require('./session-model.cjs');
const queueRules = require('./queue-dispatch.cjs');
const { detached } = require('./background-operation.cjs');

const TICK_MS = 2000;
const HUMAN_QUIET_MS = 10000;
// How long a turn's end may take to report its background work.
const REPORT_GRACE_MS = 20000;
const ATTEMPTS = 5;
const APPLY_TIMEOUT_MS = 90000;
const KEEP_MS = 24 * 3600 * 1000;
const FILE = 'model-changes.json';
const LIVE_STATES = ['idle', 'working', 'starting', 'approval', 'stopping'];
const OPEN_WAKES = ['staged', 'held', 'sending', 'consumed'];
const GRACE_KEYS = ['error.planBackgroundUnreported'];
// What a turn that is still under way, or an answer to it, settles by itself.
const PASSING_KEYS = ['error.planPendingInput', 'error.planPendingApproval', 'error.planPendingQuestion', 'error.planContextChanging', 'error.planRelayRunning', 'error.planCapacityScheduled'];

const reasonOf = plan => plan.reasonUiMessage || plan.blockUiMessage;
// sessionPlan names the session around its reason; the reason alone says what is in the way.
const inner = message => message?.cause ?? message;
const innerKey = message => inner(message)?.key ?? null;

function openWake(sessions, id) {
  for (const session of sessions) {
    for (const message of session.messages || []) {
      if (message.wake && OPEN_WAKES.includes(message.wake.status) && (session.id === id || message.wake.recipientId === id)) return true;
    }
  }
  return false;
}

// { ready: plan, typed } | { wait: reason key } | { refuse: uiMessage }, from the state as the app holds it now.
function gate(session, input) {
  const { snapshot, entryState, rotations, engaged, humanAt, now, unreportedSince } = input;
  if (['working', 'starting', 'approval', 'stopping'].includes(session.state)) return { wait: session.state === 'approval' ? 'approval' : 'turn' };
  const running = new Set([...runningIn(snapshot), ...runningIn(entryState)]);
  // Text perhaps typed in the native terminal is saved before the stop, as a migration saves it.
  const plan = sessionPlan({ ...session, terminalInputPending: false }, session.state, running);
  if (!plan.stop) {
    const key = innerKey(reasonOf(plan));
    return PASSING_KEYS.includes(key) ? { wait: key === 'error.planPendingQuestion' ? 'question' : key === 'error.planRelayRunning' ? 'relay' : 'input' } : { refuse: inner(reasonOf(plan)) };
  }
  if (!plan.auto) {
    const key = innerKey(plan.reasonUiMessage);
    if (GRACE_KEYS.includes(key) && (unreportedSince === null || now - unreportedSince < REPORT_GRACE_MS)) return { wait: 'report', unreported: true };
    return { refuse: inner(plan.reasonUiMessage) };
  }
  if (queueRules.engagedSessions(rotations, snapshot.rooms).has(session.id) || engaged.includes(session.id)) return { wait: 'queue' };
  if (openWake(snapshot.sessions, session.id)) return { wait: 'message' };
  const at = humanAt.get(session.id);
  if (Number.isFinite(at) && now - at < HUMAN_QUIET_MS) return { wait: 'person' };
  return { ready: plan, typed: session.terminalInputPending !== false };
}

const timeout = (promise, ms) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(uiError('error.modelChange.unconfirmed')), ms);
  promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});

const same = (a, b) => a.model === b.model && a.effort === b.effort;
const named = value => value.model !== null && value.effort !== null;

// What still waited when the app closed. A change that was being made then is only looked up, never made again.
function readPending(file, now) {
  let rows;
  try { rows = JSON.parse(fs.readFileSync(file, 'utf8')).changes; } catch { return []; }
  return (Array.isArray(rows) ? rows : []).filter(row => row && typeof row.id === 'string' && typeof row.nativeId === 'string' &&
    sessionModel.validValue(row.value) && Number.isFinite(row.at) && now >= row.at && now - row.at < KEEP_MS);
}
function writePending(file, entries) {
  const rows = entries.map(({ id, nativeId, value, at, applying, unconfirmed }) => ({ id, nativeId, value, at, applying: applying || unconfirmed }));
  if (!rows.length) return fs.rmSync(file, { force: true });
  const next = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(next, JSON.stringify({ version: 1, changes: rows }), { mode: 0o600 });
  fs.renameSync(next, file);
}

class ModelChanges {
  constructor(options) {
    this.client = options.client;
    this.apply = options.apply;
    this.rotations = options.rotations || (() => ({}));
    this.engaged = options.engaged || (() => []);
    this.humanAt = options.humanAt || (() => new Map());
    this.saveTerminal = options.saveTerminal;
    this.changed = options.changed || (() => {});
    this.done = options.done || (() => {});
    this.now = options.now || Date.now;
    this.tickMs = options.tickMs ?? TICK_MS;
    this.applyTimeoutMs = options.applyTimeoutMs ?? APPLY_TIMEOUT_MS;
    this.file = options.dataDir ? path.join(options.dataDir, FILE) : null;
    this.pending = new Map();
    this.timer = null;
    this.passing = null;
    this.closed = false;
    for (const row of this.file ? readPending(this.file, this.now()) : []) {
      this.pending.set(row.id, { ...this.entry(row.id, row.nativeId, row.value, row.at), unconfirmed: row.applying === true });
    }
  }
  entry(id, nativeId, value, at) {
    return { id, nativeId, value: { model: value.model, effort: value.effort }, at, waiting: null, applying: false, unconfirmed: false, attempts: 0, unreportedSince: null, screen: null };
  }
  // Best effort: a change that cannot be saved still waits in this run.
  moved() {
    if (this.file && !this.closed) try { writePending(this.file, [...this.pending.values()]); } catch { /* as above */ }
    this.changed();
  }
  // The sessions whose model is about to change: the dispatcher sends them no queued item meanwhile.
  ids() { return [...this.pending.keys()]; }
  view() {
    return [...this.pending.values()].map(entry => ({ sessionId: entry.id, model: entry.value.model, effort: entry.value.effort, waiting: entry.waiting, applying: entry.applying }));
  }
  read(client, id) {
    const snapshot = this.apply(client.snapshot());
    const session = snapshot.sessions.find(s => s.id === id);
    if (!session) throw uiError('error.sessionMissing');
    const target = client.route(id);
    if (session.archived || !target.state.capabilities?.includes(sessionModel.CAPABILITY)) throw uiError('error.modelChange.backend');
    return { snapshot, session, target };
  }
  currentClient() {
    const client = this.client();
    if (!client) throw uiError('error.modelChange.unavailable');
    return client;
  }
  async choices(id) {
    const { target } = this.read(this.currentClient(), id);
    return { ...await target.client.call('modelChoices', id), pending: this.view().find(entry => entry.sessionId === id) || null };
  }
  inspect(entry, client) {
    const held = this.apply(client.snapshot()).sessions.find(s => s.id === entry.id);
    // Its backend is away for a moment, as while the app starts.
    if (!held || held.backendUnavailable) return { result: { wait: 'backend' } };
    const { snapshot, session, target } = this.read(client, entry.id);
    if (session.nativeId !== entry.nativeId) throw uiError('error.modelChange.changed');
    if (!LIVE_STATES.includes(session.state)) throw uiError('error.modelChange.unavailable');
    const result = gate(session, { snapshot, entryState: target.state, rotations: this.rotations(), engaged: this.engaged() || [], humanAt: this.humanAt(), now: this.now(), unreportedSince: entry.unreportedSince });
    if (!result.unreported) entry.unreportedSince = null;
    else if (entry.unreportedSince === null) entry.unreportedSince = this.now();
    return { session, target, result };
  }
  // `nativeId`: the session the person chose for. Codex: in effect from its next turn. Claude: pending until it can be
  // stopped and resumed, or refused with what is running.
  async request(id, value, nativeId) {
    if (!sessionModel.validValue(value)) throw uiError('error.modelChange.unknown', { model: String(value?.model ?? '') });
    // What follows is NAW's own work for the person, also when an agent's confirmed call asked for it.
    return detached(() => this.requested(id, value, nativeId));
  }
  async requested(id, value, nativeId) {
    const client = this.currentClient();
    await client.refresh();
    const { session, target } = this.read(client, id);
    if (typeof nativeId !== 'string' || session.nativeId !== nativeId) throw uiError('error.modelChange.changed');
    if (this.pending.get(id)?.applying) throw uiError('error.modelChange.applying');
    if (session.provider === 'codex') {
      client.operationGuard(target)();
      await target.client.call('changeModel', id, value, { nativeId });
      this.done({ sessionId: id, model: value.model, effort: value.effort });
      return { status: 'applied' };
    }
    if (session.provider !== 'claude') throw uiError('error.modelChange.unsupported');
    sessionModel.claudeValue(value);
    if (named(value) && same(value, sessionModel.current(session))) {
      if (this.pending.delete(id)) this.moved();
      throw uiError('error.modelChange.same');
    }
    const entry = this.entry(id, nativeId, value, this.now());
    const { result } = this.inspect(entry, client);
    if (result.refuse) throw refusal(result.refuse);
    entry.waiting = result.wait || null;
    this.pending.set(id, entry);
    this.moved();
    this.schedule(0);
    return { status: 'pending', waiting: entry.waiting };
  }
  cancel(id) {
    const entry = this.pending.get(id);
    if (!entry) return false;
    if (entry.applying) throw uiError('error.modelChange.applying');
    this.pending.delete(id);
    this.moved();
    return true;
  }
  schedule(delay = this.tickMs) {
    if (this.closed || this.timer || !this.pending.size) return;
    this.timer = detached(() => setTimeout(() => {
      this.timer = null;
      this.pass().catch(() => {}).finally(() => this.schedule());
    }, delay));
    this.timer.unref?.();
  }
  pass() {
    this.passing ||= this.passOnce().finally(() => { this.passing = null; });
    return this.passing;
  }
  async passOnce() {
    const client = this.client();
    if (!client || this.closed) return;
    for (const entry of [...this.pending.values()]) {
      if (this.pending.get(entry.id) !== entry) continue;
      try { await this.step(entry, client); }
      catch (error) { this.finish(entry, { error }); }
    }
  }
  wait(entry, reason) {
    if (entry.waiting === reason) return;
    entry.waiting = reason;
    this.changed();
  }
  async step(entry, client) {
    const first = this.inspect(entry, client).result;
    if (first.wait && (first.wait === 'backend' || !entry.unconfirmed)) return this.wait(entry, first.wait);
    try { await client.refresh(); }
    catch { return this.wait(entry, 'backend'); }
    if (this.pending.get(entry.id) !== entry) return;
    const { session, target, result } = this.inspect(entry, client);
    if (result.wait === 'backend') return this.wait(entry, result.wait);
    if (named(entry.value) && same(entry.value, sessionModel.current(session))) return this.finish(entry);
    if (entry.unconfirmed) return this.finish(entry, { error: uiError('error.modelChange.unconfirmed') });
    if (result.refuse) return this.finish(entry, { error: refusal(result.refuse) });
    if (result.wait) return this.wait(entry, result.wait);
    const guard = client.operationGuard(target); guard();
    entry.applying = true;
    this.moved();
    if (result.typed && !entry.screen) {
      try { entry.screen = { file: await this.saveTerminal(entry.id) }; }
      catch { throw uiError('error.modelChange.screen'); }
    }
    try {
      guard();
      await timeout(target.client.call('changeModel', entry.id, entry.value, result.ready.stop, result.typed ? 'typed' : true), this.applyTimeoutMs);
    } catch (error) {
      // Something moved between this read and the stop: nothing was changed, so it waits again.
      if (error?.uiMessage?.key !== 'error.backendSwitchSessionChanged' || ++entry.attempts >= ATTEMPTS) throw error;
      entry.applying = false; entry.screen = null; entry.waiting = 'turn';
      return this.moved();
    }
    this.finish(entry);
  }
  finish(entry, { error = null } = {}) {
    if (this.pending.get(entry.id) === entry) this.pending.delete(entry.id);
    this.moved();
    this.done({ sessionId: entry.id, model: entry.value.model, effort: entry.value.effort,
      ...(error ? { error: error.message, errorUiMessage: error.uiMessage || null } : {}),
      ...(entry.screen?.file ? { screen: entry.screen.file } : {}) });
  }
  // What still waits stays saved.
  close() { this.closed = true; clearTimeout(this.timer); this.timer = null; }
}

// What is in the way, as the sentence the person reads.
function refusal(reason) {
  if (!reason?.key) return uiError('error.modelChange.unavailable');
  const cause = uiError(reason.key, reason.params);
  return uiError('error.modelChange.busy', { reason: cause.message }, { cause, param: 'reason' });
}

module.exports = { ModelChanges, gate, openWake, HUMAN_QUIET_MS, REPORT_GRACE_MS };
