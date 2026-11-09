// Moves an old backend's sessions onto the current code (T-122). Only idle
// sessions are stopped. The old service is retired after its own stop results
// are confirmed, the current code starts on the same store, and only the
// sessions this flow stopped are reconnected. NAW sends nothing to them.
'use strict';
const { uiError } = require('./ui-errors.cjs');
const fs = require('node:fs'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { connectService } = require('./service-connection.cjs');
const { processMayBeAlive, processIdentity } = require('./platform.cjs');

const RECORD = 'backend-switch.json', SETTINGS = 'backend-switch-settings.json';
const STATE_LABELS = { working: 'error.planWorking', starting: 'error.planStarting', stopping: 'error.planStopping', approval: 'error.planApproval', disconnected: 'error.planDisconnected', error: 'error.planError' };

function waiting(record) {
  if (record.activeTurnId || record.pendingQueue || record.pendingSteer || record.nativeInputRequired || record.interruptPending) return uiError('error.planPendingInput');
  if (record.pendingTag) return uiError('error.planPendingInput');
  if (record.approval || record.approvals?.length || record.approvalOverflow) return uiError('error.planPendingApproval');
  if (record.claudeQuestion || record.question || record.pendingQuestion) return uiError('error.planPendingQuestion');
  if (record.capacityRecovery?.status === 'scheduled') return uiError('error.planCapacityScheduled');
  if (record.nativeContextPending || record.recovering) return uiError('error.planContextChanging');
  if (record.worktreePreparation && record.worktreePreparation.status !== 'ready') return uiError('error.planWorktreeUnconfirmed');
  return '';
}
// Child agents and teammates seen through native events. The turn-end report
// does not list teammates, so a child last seen starting may still be running.
function children(record) {
  const latest = new Map();
  // Agent Teams teammates appear through these events; their end is not reported to the lead.
  const team = (record.fleet || []).some(event => ['TeammateIdle', 'TaskCompleted'].includes(event.event));
  for (const event of record.fleet || []) {
    const id = event.event === 'subAgentActivity' ? event.nativeId : ['SubagentStart', 'SubagentStop', 'thread/started'].includes(event.event) ? event.id : null;
    if (!id) continue;
    const ended = event.event === 'SubagentStop' || (event.event === 'subAgentActivity' && event.kind === 'completed');
    latest.set(id, ended ? null : event.stale === false ? 'current' : 'earlier');
  }
  const open = [...latest.values()];
  return { current: open.filter(v => v === 'current').length, earlier: open.filter(v => v === 'earlier').length, team };
}
// Whether NAW may move this session under the person's standing confirmation (automatic migration).
// The only parts it accepts unproven are text perhaps typed in the native terminal (saved first) and,
// for Codex, that its native program ends. Each condition is checked on its own: unproven() names
// only the first reason. Teammates, child agents, unreported background work and an active Codex goal
// still wait for the person's click.
function migrationSafe(record) {
  if (record.state !== 'idle' || waiting(record)) {
    return false;
  }
  const fleet = children(record);
  if (fleet.current || fleet.earlier || fleet.team) {
    return false;
  }
  if (record.provider === 'codex') {
    return !(record.nativeGoal && record.nativeGoal.status === 'active');
  }
  const fresh = record.backgroundStale === false && record.background === null && record.scheduled === null;
  const reported = record.backgroundStale === false && record.background === 0 && record.scheduled === 0;
  return fresh || reported;
}
// What would still be unknown if this idle session were stopped now. Empty
// means the runtime proved it; otherwise only an explicit click may proceed.
function unproven(record, fleet) {
  if (record.provider === 'codex') return uiError('error.planCodexEnds');
  if (typeof record.terminalInputPending !== 'boolean') return uiError('error.planInputUnreported');
  if (record.terminalInputPending) return uiError('error.planTerminalInput');
  if (fleet.team) return uiError('error.planTeamUnconfirmed');
  if (fleet.earlier) return uiError('error.planEarlierChildren');
  // No turn since this process started (stale false, nothing reported) means nothing was started.
  const fresh = record.backgroundStale === false && record.background === null && record.scheduled === null;
  if (!fresh && (record.backgroundStale !== false || !Number.isSafeInteger(record.background) || !Number.isSafeInteger(record.scheduled))) return uiError('error.planBackgroundUnreported');
  return '';
}
function sessionPlan(record, state, running = new Set()) {
  const name = record.name || record.provider || record.id;
  const named = (reason, colon = true) => uiError(colon ? 'error.planSessionReason' : 'error.planSessionState', { name, reason: reason.message }, { cause: reason, param: 'reason' });
  const blocked = (reason, colon = true) => { const error = named(reason, colon); return { block: error.message, blockUiMessage: error.uiMessage }; };
  if (state === 'background') return { carry: true };
  if (['ended', 'recoverable'].includes(state)) {
    if (processMayBeAlive(record.processIdentity) || processMayBeAlive(record.serverIdentity)) return blocked(uiError('error.planProcessMayRun'));
    return { carry: true };
  }
  if (state !== 'idle') return blocked(Object.hasOwn(STATE_LABELS, state) ? uiError(STATE_LABELS[state]) : uiError('error.planUnknownState', { state: String(state) }), false);
  const wait = waiting(record); if (wait) return blocked(wait);
  if (!record.nativeId) return blocked(uiError('error.planNativeIdentityMissing'));
  if (!['claude', 'codex'].includes(record.provider)) return blocked(uiError('error.planUnsupportedProvider'));
  if (running.has(record.id)) return blocked(uiError('error.planRelayRunning'));
  if (record.provider === 'claude') {
    for (const [count, what] of [[record.background, 'error.planBackgroundRunning'], [record.scheduled, 'error.planScheduledWork']]) if (Number.isSafeInteger(count) && count > 0) return blocked(uiError(what, { count }));
  }
  const fleet = children(record);
  if (fleet.current) return blocked(uiError('error.planCurrentChildren', { count: fleet.current }));
  const reason = unproven(record, fleet), warning = reason && named(reason);
  return { stop: { id: record.id, nativeId: record.nativeId, provider: record.provider, name, owner: record.owner || null,
    view: record.view ?? null, controlRevision: record.controlRevision ?? null, connectionRevision: record.connectionRevision ?? null,
    draftRevision: record.draftRevision ?? null, peerRevision: record.peerRevision ?? null }, auto: !reason, reason: warning ? warning.message : '', reasonUiMessage: warning ? warning.uiMessage : null };
}
// Sessions in a running relay anywhere in this backend's own state.
function runningIn(state) {
  const ids = new Set();
  for (const room of [state.room, ...(Array.isArray(state.rooms) ? state.rooms : [])]) if (room?.run?.status === 'running') for (const id of room.run.ids || []) ids.add(id);
  return ids;
}
function backendPlan(state, sessionState = record => record.state, running = new Set()) {
  const refused = key => { const error = uiError(key); return { ready: false, auto: false, reason: error.message, reasonUiMessage: error.uiMessage, stops: [] }; };
  if (state.storageWarning) return refused('error.planStorageWarning');
  if (!['atomicShutdown', 'resume'].every(cap => state.capabilities?.includes(cap))) return refused('error.planOldBackend');
  if (!Number.isSafeInteger(state.servicePid) || state.servicePid < 2) return refused('error.planPidMissing');
  const busy = new Set([...running, ...runningIn(state)]), stops = [], blocks = [], unprovenReasons = [], blockParts = [], reasonParts = [];
  for (const record of state.sessions || []) {
    const plan = sessionPlan(record, sessionState(record), busy);
    if (plan.block) { blocks.push(plan.block); blockParts.push({ message: plan.block, uiMessage: plan.blockUiMessage }); }
    else if (plan.stop) { stops.push(plan.stop); if (!plan.auto) { unprovenReasons.push(plan.reason); reasonParts.push({ message: plan.reason, uiMessage: plan.reasonUiMessage }); } }
  }
  // Blocked by its sessions (not by the backend itself): the reason names them (T-131).
  if (blocks.length) {
    const error = uiError('error.planBlockedReasons', { reasons: blocks.join('；') }, { parts: blockParts, param: 'reasons', separator: '；' });
    return { ready: false, auto: false, blocked: true, reason: error.message, reasonUiMessage: error.uiMessage, stops };
  }
  // Old services cannot compare the confirmed authority at their stop boundary.
  // Do not quietly substitute the ordinary, unconditional user-stop operation.
  if ((stops.length || (state.sessions || []).some(s => s.state === 'recoverable')) && !state.capabilities?.includes('conditionalMaintenanceStopV1')) return { ...refused('error.planOldBackend'), blocked: true, stops };
  const warning = unprovenReasons.length ? uiError('error.planUnprovenReasons', { reasons: unprovenReasons.join('；') }, { parts: reasonParts, param: 'reasons', separator: '；' }) : null;
  return { ready: true, auto: stops.length > 0 && unprovenReasons.length === 0, reason: warning ? warning.message : '', reasonUiMessage: warning ? warning.uiMessage : null, stops,
    endsCodex: stops.some(s => s.provider === 'codex') };
}
// A human may take control or change input mode while the confirmation is open
// or an earlier session is stopping. Do not retire that newer choice as the old owner.
const sameStop = (a, b) => Boolean(a && b) && ['id', 'nativeId', 'provider', 'owner', 'view', 'controlRevision', 'connectionRevision', 'draftRevision', 'peerRevision']
  .every(key => (a[key] ?? null) === (b[key] ?? null));
const samePlan = (a, b) => Array.isArray(a?.stops) && Array.isArray(b?.stops) && a.stops.length === b.stops.length && a.stops.every((s, i) => sameStop(s, b.stops[i]));
const maintenanceProof = record => Object.fromEntries(['id', 'nativeId', 'provider', 'owner', 'view', 'controlRevision', 'connectionRevision', 'draftRevision', 'peerRevision', 'state'].map(key => [key, record[key] ?? null]));

// auto: move proven backends by themselves. migrate: the person's standing confirmation that NAW may
// also move backends it cannot prove idle, after saving typed-into terminals (off unless turned on).
function readSettings(dataDir) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dataDir, SETTINGS), 'utf8'));
    return { auto: value?.auto !== false, migrate: value?.migrate === true };
  } catch {
    return { auto: true, migrate: false };
  }
}
function atomicWrite(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.rmSync(temp, { force: true }); fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, file);
}
function writeSettings(dataDir, auto, migrate) {
  let nextMigrate = migrate;
  if (typeof nextMigrate !== 'boolean') {
    nextMigrate = readSettings(dataDir).migrate;
  }
  atomicWrite(path.join(dataDir, SETTINGS), { format: 1, auto: auto === true, migrate: nextMigrate === true });
  return readSettings(dataDir);
}
// One record per backend: the sessions a move ended that are not reconnected yet.
function readRecords(dataDir) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dataDir, RECORD), 'utf8'));
    if (value?.format !== 2 || !value.backends || typeof value.backends !== 'object') return {};
    return Object.fromEntries(Object.entries(value.backends).filter(([, r]) => r && Array.isArray(r.sessions)));
  } catch { return {}; }
}
function writeRecord(dataDir, key, value) { atomicWrite(path.join(dataDir, RECORD), { format: 2, backends: { ...readRecords(dataDir), [key]: value } }); }
function clearRecord(dataDir, key) {
  const backends = readRecords(dataDir); delete backends[key];
  if (Object.keys(backends).length) atomicWrite(path.join(dataDir, RECORD), { format: 2, backends }); else fs.rmSync(path.join(dataDir, RECORD), { force: true });
}

// Confirm the old service's process identity before requesting maintenance.
// Retirement itself must pass its conditional, service-side shutdown guard.
function serviceProcess(directory, pid, commandLine) {
  const lock = Number(fs.readFileSync(path.join(directory, 'service.lock'), 'utf8'));
  if (lock !== pid) throw uiError("error.backendSwitchProcessMismatch");
  const command = commandLine(pid);
  if (typeof command !== 'string' || !command.includes(path.join(directory, 'runtimes') + path.sep) || !/daemon\.cjs/.test(command)) throw uiError("error.backendSwitchProcessUnconfirmed");
  return processIdentity(pid);
}
const psCommand = pid => execFileSync('/bin/ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
async function waitGone(directory, pid, identity, ms = 15000) {
  for (let i = 0; i < ms / 100; i++) {
    if (!processMayBeAlive(identity || { pid }) && !fs.existsSync(path.join(directory, 'service.lock'))) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw uiError("error.backendSwitchOldPending");
}

async function switchBackend({ dataDir, key, executablePath, expected, ensure, owner, applicationVersion = process.env.NAW_APP_VERSION,
  sessionState, running = () => new Set(), requireAuto = false, commandLine = psCommand, now = Date.now }) {
  const directory = path.join(dataDir, key), stopped = [];
  const effective = record => sessionState ? sessionState(record) : record.state;
  // Each session is reconnected as its own owner, so its window keeps control.
  const resumeAs = async (session, fresh = false) => {
    const who = session.owner || owner; if (!who) throw uiError("error.backendSwitchWindowMissing");
    const connection = await connectService(directory, who);
    try {
      let proof = session.stoppedState;
      if (fresh) {
        const snapshot = await connection.call('initial'), record = snapshot.sessions.find(s => s.id === session.id);
        // The new service resets owner/control/draft generations on loading.
        // A newer claimant must not be repinned as our restoration authority.
        if (!record || record.nativeId !== session.nativeId || record.provider !== session.provider || record.owner != null || record.controlRevision !== 0 || (record.draftRevision || 0) !== 0 || !['ended', 'recoverable'].includes(record.state)) throw uiError('error.backendSwitchSessionChanged', { name: session.name });
        proof = { ...maintenanceProof(record), draftRevision: record.draftRevision || 0 };
      }
      await connection.call('maintenanceResume', session.id, proof);
    } finally { connection.close(); }
  };
  const keep = list => writeRecord(dataDir, key, { phase: 'stopped', failedAt: now(), sessions: list });
  let client = await connectService(directory, 'backend-switch'), state, plan, pid, identity;
  try {
    state = await client.call('initial');
    plan = backendPlan(state, effective, running());
    // What the person confirmed (or the tick selected) must still be exactly what is unproven now.
    if (!plan.ready || (requireAuto && !plan.auto) || (expected && (!samePlan(plan, expected) || plan.auto !== expected.auto || plan.reason !== expected.reason)) || state.runtimeVersion === applicationVersion) throw uiError("error.backendSwitchStateChanged");
    // Prove which process would be retired before ending anything.
    pid = state.servicePid; identity = serviceProcess(directory, pid, commandLine);
  } catch (error) { client.close(); throw error; }
  try {
    for (const session of plan.stops) {
      const snapshot = await client.call('initial'), current = snapshot.sessions.find(s => s.id === session.id);
      const check = current && sessionPlan(current, effective(current), new Set([...running(), ...runningIn(snapshot)]));
      if (!check?.stop || !sameStop(check.stop, session) || (requireAuto && !check.auto)) throw uiError("error.backendSwitchSessionChanged", { name: session.name });
      // Persist an uncertain request for recovery, but rollback only a stop this
      // service acknowledged. A refused guard must never resume newer human work.
      writeRecord(dataDir, key, { phase: 'stopping', startedAt: now(), sessions: [...stopped, session] });
      let receipt;
      try { receipt = await client.call('maintenanceStop', session.id, session, requireAuto); }
      catch (error) {
        if (!error.uiMessage || error.uiMessage.key !== 'error.backendSwitchSessionChanged') error.maintenanceUnconfirmed = session;
        throw error;
      }
      if (receipt?.stopped !== true || !sameStop(receipt.expected, session) || !receipt.stoppedState || !sameStop(receipt.stoppedState, { ...session, controlRevision: (session.controlRevision || 0) + 1, connectionRevision: (session.connectionRevision || 0) + 1 })) { const error = uiError('error.backendSwitchDisconnectUnconfirmed', { name: session.name }); error.maintenanceUnconfirmed = session; throw error; }
      stopped.push({ ...session, stoppedState: receipt.stoppedState });
      const after = (await client.call('initial')).sessions.find(s => s.id === session.id);
      if (!['ended', 'disconnected'].includes(after?.state) || after.nativeId !== session.nativeId) throw uiError("error.backendSwitchDisconnectUnconfirmed", { name: session.name });
    }
    state = await client.call('initial');
    for (const record of state.sessions) {
      const ours = stopped.some(s => s.id === record.id);
      const ok = ours ? (record.provider === 'codex' ? ['ended', 'disconnected'] : ['ended']).includes(record.state) && !(record.provider === 'claude' && processMayBeAlive(record.processIdentity))
        : sessionPlan(record, record.state).carry;
      if (!ok) throw uiError("error.backendSwitchSessionChanged", { name: record.name || record.id });
    }
    if (state.servicePid !== pid || processIdentity(pid)?.started !== identity?.started) throw uiError("error.backendSwitchProcessChanged");
    if (!state.sessions.every(s => ['ended', 'background'].includes(s.state))) serviceProcess(directory, pid, commandLine);
  } catch (error) {
    // Put back what this flow stopped, on the same old service and owners.
    const back = [];
    for (const session of stopped) { try { await resumeAs(session); back.push(session.id); } catch {} }
    client.close();
    const left = stopped.filter(s => !back.includes(s.id));
    if (error.maintenanceUnconfirmed) left.push(error.maintenanceUnconfirmed);
    if (!left.length) clearRecord(dataDir, key); else keep(left);
    throw error;
  }
  // From here on, any failure names every stopped session for the person to continue.
  try {
    writeRecord(dataDir, key, { phase: 'restarting', startedAt: now(), sessions: stopped });
    // The service reserves shutdown in the same synchronous dispatch that
    // validates all final identities/control. Never signal past a newer input.
    if (state.capabilities?.includes('conditionalMaintenanceStopV1')) await client.call('maintenanceShutdown', state.sessions.map(maintenanceProof));
    else await client.call('shutdown'); // No occupied stops are admitted on legacy services.
    client.close();
    await waitGone(directory, pid, identity);
    for (const record of state.sessions) if (record.provider === 'codex' && processMayBeAlive(record.serverIdentity)) {
      for (let i = 0; i < 50 && processMayBeAlive(record.serverIdentity); i++) await new Promise(resolve => setTimeout(resolve, 100));
      if (processMayBeAlive(record.serverIdentity)) throw uiError("error.backendSwitchOldCodexPending");
    }
    await ensure(dataDir, executablePath, key);
    const fresh = await connectService(directory, 'backend-switch-verify');
    try {
      const next = await fresh.call('initial');
      if (next.runtimeVersion !== applicationVersion || !stopped.every(session => {
        const record = next.sessions.find(s => s.id === session.id);
        return record && record.nativeId === session.nativeId && ['ended', 'recoverable'].includes(record.state);
      })) throw uiError("error.backendSwitchIdentityMismatch");
    } finally { fresh.close(); }
  } catch (error) { client.close(); keep(stopped); throw error; }
  writeRecord(dataDir, key, { phase: 'resuming', startedAt: now(), sessions: stopped });
  const resumed = [], left = [];
  for (const session of stopped) { try { await resumeAs(session, true); resumed.push(session.id); } catch { left.push(session); } }
  if (left.length) keep(left); else clearRecord(dataDir, key);
  return { key, resumed, left: left.map(s => s.id) };
}

module.exports = { backendPlan, sessionPlan, samePlan, sameStop, maintenanceProof, switchBackend, readSettings, writeSettings, readRecords, clearRecord, migrationSafe, children, RECORD, SETTINGS };
