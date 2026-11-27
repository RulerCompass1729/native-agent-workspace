'use strict';

const { isDeepStrictEqual } = require('node:util');
const { roomIds, placementRevision } = require('./collaboration-spaces.cjs');
const { maintenanceProof, sameStop, sessionPlan } = require('./backend-switch.cjs');

const CAPABILITY = 'guardedSessionRetirementV1';
const WAKE_PENDING = new Set(['staged', 'held', 'sending', 'consumed']);
const OPEN_QUEUE = new Set(['queued', 'sent', 'waiting']);

const proof = session => ({ ...maintenanceProof(session), placementRevision: placementRevision(session),
  lastActivityAt: session.lastActivityAt ?? null, waitingInput: session.terminalInputPending ?? null,
  lastMessage: session.messages?.at(-1)?.id ?? null });
const unresolved = message => WAKE_PENDING.has(message.wake?.status) ||
  message.operator?.actionable && (message.operator.reportQuestion || message.operator.creation === 'pending-authorization') ||
  ['awaiting-native', 'queued', 'running', 'streaming', 'unconfirmed'].includes(message.status);

function idle(session, running) {
  return session.state === 'idle' && typeof session.nativeId === 'string' && session.nativeId.length > 0 &&
    !session.archived && !session.backendUnavailable && !session.transportDisconnected && !roomIds(session).length &&
    !session.liveDraft && session.terminalInputPending === false && !session.nativeApproval &&
    !session.rotationEpisode && !session.stopHookActive && !session.fleetPending &&
    Array.isArray(session.messages) && !session.messages.some(unresolved) && !running?.has(session.id);
}

function quietClaude(session) {
  if (session.provider !== 'claude' || !idle(session) ||
      !(session.retirementUnused || session.background === 0 && session.scheduled === 0)) return false;
  const plan = sessionPlan(session, session.state);
  return Boolean(plan.stop && plan.auto);
}

function heldInRooms(rooms, sessions) {
  const ids = new Set();
  for (const room of rooms) {
    if (room.run && ['running', 'starting'].includes(room.run.status)) for (const id of room.run.ids || []) ids.add(id);
    for (const item of room.queue || []) if (OPEN_QUEUE.has(item.status)) {
      if (item.assignee) ids.add(item.assignee);
      if (item.sentTo) ids.add(item.sentTo);
    }
  }
  for (const session of sessions) for (const message of session.messages || []) {
    if (WAKE_PENDING.has(message.wake?.status)) ids.add(message.wake.recipientId);
  }
  return ids;
}

function eligibility(session, latest, sessions, context, now) {
  const { at, ttlMs } = context ?? {};
  if (!Number.isSafeInteger(session.lastActivityAt) || !Number.isSafeInteger(at) || at <= 0 ||
      !Number.isSafeInteger(ttlMs) || ttlMs <= 0 || now - Math.max(at, session.lastActivityAt) < ttlMs) return null;
  if (latest) {
    const successor = sessions.get(latest.new?.id);
    return latest.event === 'done' && latest.old.nativeId === session.nativeId &&
      Number.isSafeInteger(latest.time) && session.lastActivityAt <= latest.time &&
      successor?.nativeId && successor.nativeId === latest.new.nativeId && !successor.archived
      ? 'confirmed-successor' : null;
  }
  return session.retirementUnused === true ? 'unused' : 'cache-expired';
}

function viewProtects(id, views, windows) {
  return views.some(view => view.active && view.selected === id) ||
    windows.some(context => !context.background && !context.win.isDestroyed() &&
      (context.view.selected === id || context.shown?.has(id)));
}

class SessionRetirement {
  constructor({ room, protectedIds, rotations, log, now = Date.now, counter }) {
    this.room = room;
    this.protectedIds = protectedIds;
    this.rotations = rotations;
    this.log = log;
    this.now = now;
    this.counter = counter;
    this.missingCodex = new Set();
  }

  localProtection(snapshot) {
    if (snapshot.storageWarning || this.room.warning || this.room.spacesWarning) return null;
    const protectedIds = this.protectedIds(snapshot);
    if (!protectedIds) return null;
    const held = heldInRooms(snapshot.rooms || [], snapshot.sessions);
    return new Set([...protectedIds, ...held, ...this.room.value.restoredSessions, ...Object.keys(this.room.value.sessionArchives)]);
  }

  async pass(client, version) {
    const snapshot = this.room.apply(client.snapshot());
    const held = this.localProtection(snapshot);
    if (!held) return false;
    const now = this.now(), candidates = [];
    const codex = new Set();
    for (const session of snapshot.sessions) {
      const codexIdentity = session.provider === 'codex' ? session.id + ':' + session.nativeId : null;
      if (codexIdentity && this.missingCodex.has(codexIdentity)) codex.add(codexIdentity);
      if (held.has(session.id) || this.room.gates.has(session.id) || !idle(session)) continue;
      const entry = client.route(session.id);
      if (entry.closed || entry.closing || entry.state.runtimeVersion !== version || entry.state.storageWarning ||
          !entry.state.capabilities?.includes(CAPABILITY)) continue;
      if (codexIdentity) {
        codex.add(codexIdentity);
        if (!this.missingCodex.has(codexIdentity)) {
          try { this.log({ sessionId: session.id, nativeId: session.nativeId, reason: 'native-exit-receipt-unavailable' }); }
          catch { /* Missing diagnostics never authorizes a stop. */ }
        }
      } else if (quietClaude(session)) candidates.push(session);
    }
    this.missingCodex = codex;
    if (!candidates.length) return false;
    await this.counter.sample(candidates, now);
    const rotations = new Map(this.rotations().map(entry => [entry.old.id, entry]));
    const byId = new Map(snapshot.sessions.map(session => [session.id, session]));
    for (const session of candidates) {
      const reason = eligibility(session, rotations.get(session.id), byId, this.counter.contexts.get(session.id), now);
      if (reason) return this.retire(client, session, reason, version);
    }
    return false;
  }

  protect(id) {
    if (this.pending?.id === id) this.pending.revoked = true;
  }

  async retire(client, session, reason, version) {
    const id = session.id, expected = proof(session);
    const entry = client.route(id), guard = client.operationGuard(entry);
    const service = entry.client;
    const pending = this.pending = { id, revoked: false };
    try {
      const observation = await service.call('observeRetirement', id);
      if (!observation?.alive || typeof observation.epoch !== 'string' || !Number.isSafeInteger(observation.index)) return false;
      await this.counter.recheck(session, this.now());
      const observed = await service.call('initial');
      guard();
      const fresh = this.room.apply(client.snapshot()), held = this.localProtection(fresh);
      const byId = new Map(fresh.sessions.map(row => [row.id, row])), current = byId.get(id);
      const native = observed.sessions.find(row => row.id === id);
      if (observed.storageWarning || !native || !quietClaude(native) || !isDeepStrictEqual(proof(native), expected)) return false;
      const latest = this.rotations().findLast(row => row.old.id === id);
      if (pending.revoked || entry.state.runtimeVersion !== version || !held || held.has(id) || this.room.gates.has(id) || !current || !quietClaude(current) || !isDeepStrictEqual(proof(current), expected) ||
          eligibility(current, latest, byId, this.counter.contexts.get(id), this.now()) !== reason) return false;
      const result = await service.call('retireSession', id, expected, { epoch: observation.epoch, index: observation.index });
      guard();
      if (result?.stopped !== true || !sameStop(result.expected, expected) || result.stoppedState?.id !== id ||
          result.stoppedState.nativeId !== expected.nativeId || result.stoppedState.state !== 'ended') return false;
      await this.room.archiveSession(client, id, current.name, { automatic: true, automaticCheck: row => {
        guard();
        const state = this.room.apply(client.snapshot()), protectedIds = this.localProtection(state);
        return Boolean(!pending.revoked && protectedIds && !protectedIds.has(id) && row.state === 'ended' &&
          placementRevision(row) === expected.placementRevision && sameStop(row, result.stoppedState));
      } });
      return this.room.value.archivedSessions.includes(id);
    } catch {
      return false;
    } finally {
      if (this.pending === pending) this.pending = null;
    }
  }
}

module.exports = { CAPABILITY, SessionRetirement, proof, quietClaude, heldInRooms, viewProtects };
