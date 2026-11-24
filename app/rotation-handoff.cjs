'use strict';
const id = v => typeof v === 'string' && v.length > 0 && v.length <= 2000 && !/[\u0000-\u001f]/u.test(v);
const rev = v => Number.isSafeInteger(v) && v >= 0;
function validOwner(p) {
  return p && typeof p === 'object' && !Array.isArray(p) && Object.keys(p).sort().join() === 'controlRevision,draftRevision,nativeId,placementRevision' &&
    (p.nativeId === null || id(p.nativeId)) && ['controlRevision', 'draftRevision', 'placementRevision'].every(k => rev(p[k]));
}
function handoffInput(s, tag) {
  return s?.messages?.find(m => m.id === tag && m.role === 'user' && m.origin === 'naw-dispatch' && m.dispatchPurpose?.kind === 'rotation-handoff');
}
function outcome(s, tag) {
  const input = handoffInput(s, tag);
  if (!s || !input || input.nativeId && input.nativeId !== s.nativeId) return 'pending';
  if (input.nativeId === s.nativeId && id(input.turnId)) {
    const end = s.messages.find(m => m.kind === 'turn' && m.nativeId === input.nativeId && m.turnId === input.turnId);
    if (end && (['failed', 'interrupted', 'incomplete'].includes(end.status) || end.incomplete)) return 'failed';
    if (end?.status === 'complete') return 'complete';
  }
  return s.state === 'error' || input.status === 'failed' ? 'failed' : 'pending';
}
function owned(s, proof, tag) {
  const input = handoffInput(s, tag);
  return Boolean(s && validOwner(proof) && id(tag) && input && s.nativeId === proof.nativeId &&
    (s.controlRevision || 0) === proof.controlRevision && (s.draftRevision || 0) === proof.draftRevision &&
    (s.placementRevision || 0) === proof.placementRevision && !s.liveDraft && !s.nativeContextPending &&
    s.messages.every(m => m.role !== 'user' || m === input) &&
    (!s.pendingTag || s.pendingTag === tag) && (!s.activeTurnId || s.activeTurnId === input.turnId) &&
    !s.pendingQueue && !s.pendingSteer && !s.nativeInputRequired && !s.approval && !s.interruptPending &&
    s.nativeGoal?.status !== 'active' && s.nativeGoal?.known !== false && !(s.background > 0) && !(s.scheduled > 0) && !s.fleet?.length);
}
function validStopReceipt(r) {
  return r && Object.keys(r).sort().join() === 'basis,owner,proof,tag' && r.basis === 'stopped-by-this-attempt' && id(r.tag) &&
    validOwner(r.owner) && validOwner(r.proof) && r.proof.nativeId !== null && r.proof.nativeId === r.owner.nativeId;
}
function sameStopReceipt(a, b) {
  return validStopReceipt(a) && validStopReceipt(b) && a.tag === b.tag &&
    ['owner', 'proof'].every(part => Object.keys(a[part]).every(key => a[part][key] === b[part][key]));
}
function validObservation(r) {
  return r && Object.keys(r).sort().join() === 'basis,proof,state' && r.basis === 'observed-inactive' &&
    ['ended', 'recoverable', 'disconnected'].includes(r.state) && validOwner(r.proof);
}
function failedReason(reason) {
  return ['successor-turn-failed', 'handoff-unconfirmed'].includes(reason) || /^settings-differ:(model|model-provider|permission-mode|effort|collaboration-mode)$/.test(reason);
}
function validCleanup(record) {
  const c = record.failureCleanup;
  return record.phase === 'failed' && !record.handoffConfirmed && id(record.handoffTag) &&
    id(record.oldId) && id(record.newId) && record.oldId !== record.newId &&
    failedReason(record.reason) &&
    (record.successorOwner == null || validOwner(record.successorOwner)) &&
    c && Object.keys(c).sort().join() === 'id,log,os,release,rooms,stop,v' && c.v === 1 &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(c.id) &&
    ['pending', 'done'].includes(c.release) && ['pending', 'attempted'].includes(c.log) && ['pending', 'attempted'].includes(c.os) && c.stop && ['receipt,state', 'observation,receipt,state'].includes(Object.keys(c.stop).sort().join()) &&
    ['pending', 'started', 'done', 'retained'].includes(c.stop.state) &&
    (c.stop.receipt === null || validStopReceipt(c.stop.receipt)) && (c.stop.state !== 'done' || validStopReceipt(c.stop.receipt)) &&
    (c.stop.observation == null || validObservation(c.stop.observation)) && !(c.stop.receipt && c.stop.observation) &&
    c.rooms && typeof c.rooms === 'object' && !Array.isArray(c.rooms) &&
    JSON.stringify(Object.keys(c.rooms).sort()) === JSON.stringify([...record.roomIds].sort()) &&
    Object.values(c.rooms).every(r => r && Object.keys(r).sort().join() === 'leave,notice,queue' &&
      ['pending', 'done'].includes(r.queue) && ['pending', 'done'].includes(r.notice) && ['pending', 'done', 'retained'].includes(r.leave));
}
module.exports = { validOwner, handoffInput, outcome, owned, validCleanup, failedReason, validStopReceipt, sameStopReceipt, validObservation };
