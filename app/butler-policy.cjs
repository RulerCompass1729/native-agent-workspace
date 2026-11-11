'use strict';
// The model proposes business records. It never supplies a caller identity,
// dispatch target, native command, credential, delivery receipt or billed cost.
const { roomIds } = require('./collaboration-spaces.cjs');
const plain = v => v && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const fail = (code = 'ERR_BUTLER_BUSINESS_DATA') => { throw Object.assign(Error('Invalid butler business data'), { code }); };
const obviousSecret = /\b(?:DEEPSEEK_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY)\s*[=:]\s*\S+|Authorization\s*:\s*Bearer\s+\S+|-----BEGIN [A-Z ]*PRIVATE KEY-----/iu;
const id = (v, limit = 200) => typeof v === 'string' && v.length > 0 && v.length <= limit && !/[\s\u0000-\u001f\u007f]/u.test(v) && !obviousSecret.test(v);
const EVENT_KINDS = ['request', 'queue-empty', 'ready', 'decision', 'failure', 'blocked', 'recovery'];
const PAYLOAD_LIMITS = { text: 12000, title: 400, spaceId: 200, spaceName: 200, memberName: 200,
  memberId: 200, itemId: 200, outcome: 200, reason: 2000, decisionKind: 200, questionKey: 600, supersedes: 200 };
function text(v, limit = 12000, code) {
  if (typeof v !== 'string' || !v.trim() || v.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(v)) fail(code);
  // No credential store or environment is read. These are only obvious secret
  // forms in caller-supplied text; absence is not a general DLP guarantee.
  if (obviousSecret.test(v)) fail(code);
  return v;
}
function fields(v, allowed, required = [], code) {
  if (!plain(v) || Object.keys(v).some(k => !allowed.includes(k)) || required.some(k => !Object.hasOwn(v, k))) fail(code);
}
function validateEvent(value) {
  fields(value, ['eventId', 'kind', 'sourceRef', 'payload'], ['eventId', 'kind', 'sourceRef', 'payload']);
  if (!id(value.eventId) || !EVENT_KINDS.includes(value.kind)) fail();
  const sourceRef = text(value.sourceRef, 600);
  fields(value.payload, Object.keys(PAYLOAD_LIMITS));
  const payload = {};
  for (const key of Object.keys(value.payload)) payload[key] = text(value.payload[key], PAYLOAD_LIMITS[key]);
  return { eventId: value.eventId, kind: value.kind, sourceRef, payload };
}
function catalogRows(catalog) {
  const code = 'ERR_BUTLER_CATALOG';
  if (!Array.isArray(catalog) || catalog.length > 200) fail(code);
  const ids = new Set();
  try {
    return catalog.filter(s => { if (!plain(s)) fail(code); return !s.archived && s.writable === true; }).map(s => {
      if (!id(s.id) || ids.has(s.id)) fail(code); ids.add(s.id);
      if (!Array.isArray(s.members) || s.members.length > 100 || !Array.isArray(s.queue) || s.queue.length > 300) fail(code);
      // Project only approved business fields. Never enumerate space/member
      // values, which may include private conversation or environment getters.
      return { id: s.id, name: text(s.name, 200, code), members: s.members.map(m => {
        if (!plain(m) || !id(m.id) || !id(m.state)) fail(code);
        return { id: m.id, name: text(m.name, 200, code), state: m.state };
      }), queue: s.queue.map(q => {
        if (!plain(q) || !id(q.id) || !['queued', 'sent', 'waiting', 'done', 'failed', 'cancelled'].includes(q.status)) fail(code);
        return { id: q.id, text: text(q.text, 12000, code), status: q.status };
      }) };
    });
  } catch { fail(code); }
}
function businessEvents(events) {
  if (!Array.isArray(events) || events.length > 100) fail();
  // Persisted ledger rows also have sequence/time. They stay local; no other
  // top-level values or getters are read into the model's context.
  return events.map(e => { if (!plain(e)) fail(); return validateEvent({ eventId: e.eventId, sourceRef: e.sourceRef, kind: e.kind, payload: e.payload }); });
}
function sourcesByRef(events) {
  const sources = new Map();
  for (const event of events) {
    const previous = sources.get(event.sourceRef);
    if (previous) previous.push(event); else sources.set(event.sourceRef, [event]);
  }
  return sources;
}
function buildInput({ batchId, events, catalog, questions = [] }) {
  if (!id(batchId)) fail();
  const normalizedEvents = businessEvents(events);
  if (!Array.isArray(questions)) fail('ERR_BUTLER_CATALOG');
  const pending = questions.filter(q => { if (!plain(q)) fail('ERR_BUTLER_CATALOG'); return q.status === 'open'; });
  if (pending.length > 500) fail('ERR_BUTLER_CATALOG');
  const pendingQuestions = pending.map(q => {
    const code = 'ERR_BUTLER_CATALOG';
    if (!id(q.questionId) || !id(q.decisionKind)) fail(code);
    const result = { questionId: q.questionId, sourceRef: text(q.sourceRef, 600, code), decisionKind: q.decisionKind, text: text(q.text, 12000, code) };
    if (q.decisionSource !== undefined) result.decisionSource = text(q.decisionSource, 600, code);
    return result;
  });
  return { version: 1, mode: 'record-only', batchId, events: normalizedEvents, spaces: catalogRows(catalog), pendingQuestions };
}
function interpretResult(value, { events, catalog, questions = [] }) {
  const code = 'ERR_BUTLER_RESULT', questionCode = 'ERR_BUTLER_QUESTION_SOURCE';
  if (typeof value === 'string') {
    if (Buffer.byteLength(value) > 128 * 1024) fail(code);
    try { value = JSON.parse(value); } catch { fail(code); }
  }
  fields(value, ['actions'], ['actions'], code);
  if (!Array.isArray(value.actions) || value.actions.length > 100) fail(code);
  const sources = sourcesByRef(businessEvents(events)), spaces = catalogRows(catalog);
  if (!Array.isArray(questions)) fail(questionCode);
  const normalize = a => {
    fields(a, ['kind', 'sourceRef', 'text', 'spaceId', 'decisionKind', 'evidenceRevision', 'supersedes'], ['kind', 'sourceRef', 'text'], code);
    if (!['queue', 'open', 'archive', 'question', 'report'].includes(a.kind) || !sources.has(a.sourceRef)) fail(code);
    const result = { kind: a.kind, sourceRef: a.sourceRef, text: text(a.text, a.kind === 'queue' ? 6000 : 12000, code) };
    if (a.spaceId !== undefined) {
      if (!id(a.spaceId) || !spaces.some(s => s.id === a.spaceId)) fail(code);
      result.spaceId = a.spaceId;
    }
    if (a.kind === 'queue' && !result.spaceId) {
      if (spaces.length !== 1) result.kind = 'question';
      else result.spaceId = spaces[0].id;
    }
    if (result.kind === 'question') {
      const hosts = sources.get(a.sourceRef), { questionKey, decisionKind } = hosts[0].payload;
      if (questionKey === undefined || !id(decisionKind) ||
          !hosts.every(e => e.payload.questionKey === questionKey && e.payload.decisionKind === decisionKind) ||
          a.decisionKind !== undefined && a.decisionKind !== decisionKind) fail(questionCode);
      result.decisionKind = decisionKind;
      if (a.evidenceRevision !== undefined || a.supersedes !== undefined) {
        if (!id(a.evidenceRevision) || !id(a.supersedes)) fail(questionCode);
        const evidence = hosts.find(e => e.eventId === a.evidenceRevision && e.payload.outcome === 'facts-changed' && e.payload.supersedes === a.supersedes);
        const previous = questions.filter(q => q?.questionId === a.supersedes);
        if (!evidence || previous.length !== 1 || !['answered', 'withdrawn'].includes(previous[0].status) ||
            previous[0].decisionSource !== questionKey || previous[0].decisionKind !== decisionKind) fail(questionCode);
        result.evidenceRevision = evidence.eventId; result.supersedes = a.supersedes;
      }
    } else if (['decisionKind', 'evidenceRevision', 'supersedes'].some(key => a[key] !== undefined)) {
      fail(code);
    }
    return result;
  };
  const actions = [], suspended = [];
  for (const [index, candidate] of value.actions.entries()) {
    try { actions.push(normalize(candidate)); }
    catch (error) {
      // Invalid candidates are auditable without discarding independent work
      // in this reply. Never retain unknown fields, unsafe text or an invented
      // source, and never evaluate getters while constructing the audit row.
      const row = { stage: 'policy', index, reason: error?.code === questionCode ? questionCode : code };
      const own = key => plain(candidate) ? Object.getOwnPropertyDescriptor(candidate, key)?.value : undefined;
      const kind = own('kind'), sourceRef = own('sourceRef'), proposedText = own('text');
      if (['queue', 'open', 'archive', 'question', 'report'].includes(kind)) row.kind = kind;
      if (sources.has(sourceRef)) row.sourceRef = sourceRef;
      try { row.text = text(proposedText, kind === 'queue' ? 6000 : 12000, code); }
      catch { row.redacted = true; }
      suspended.push(row);
    }
  }
  // Only the ledger can generate action IDs and effect:none. No output field
  // can choose an executor, invoke a lifecycle method or claim a real effect.
  return { actions, ...(suspended.length ? { suspended } : {}) };
}
function rotationCandidates(selection, records) {
  if (!selection || selection.mode !== 'record-only' || !plain(selection.runner) || !Array.isArray(records)) return [];
  const record = records.find(s => s.id === selection.identity?.sessionId && s.nativeId === selection.identity?.nativeId);
  if (!record || record.provider !== 'dsh' || record.archived || record.nativeContextPending || ['ended', 'background'].includes(record.state)) return [];
  if (roomIds(record).length || !record.runner || Object.keys(selection.runner).some(k => record.runner[k] !== selection.runner[k])) return [];
  return [record.id];
}
module.exports = { validateEvent, catalogRows, buildInput, interpretResult, rotationCandidates };
