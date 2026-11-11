'use strict';
// The model proposes business records. It never supplies a caller identity,
// dispatch target, native command, credential, delivery receipt or billed cost.
const { roomIds } = require('./collaboration-spaces.cjs');
const { MAX_BATCH_INPUT_BYTES, encodedBatchBytes } = require('./butler-dsh-input.cjs');
const plain = v => v && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const fail = (code = 'ERR_BUTLER_BUSINESS_DATA') => { throw Object.assign(Error('Invalid butler business data'), { code }); };
const obviousSecret = /\b(?:DEEPSEEK_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY)\s*[=:]\s*\S+|Authorization\s*:\s*Bearer\s+\S+|-----BEGIN [A-Z ]*PRIVATE KEY-----/iu;
const id = (v, limit = 200) => typeof v === 'string' && v.length > 0 && v.length <= limit && !/[\s\u0000-\u001f\u007f]/u.test(v) && !obviousSecret.test(v);
const EVENT_KINDS = ['request', 'queue-empty', 'ready', 'decision', 'failure', 'blocked', 'recovery'];
const QUEUE_STATUSES = ['queued', 'sent', 'waiting', 'done', 'failed', 'cancelled'];
const MAX_BUSINESS_INDEX_BYTES = 128 * 1024;
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
// The default model context is an index, not an implicit request for every
// queue body, delivery or member's private session. Archive reads are explicit.
function readableCatalogRows(catalog, { includeArchived = false } = {}) {
  const code = 'ERR_BUTLER_CATALOG';
  if (!Array.isArray(catalog) || catalog.length > 200 || typeof includeArchived !== 'boolean') fail(code);
  const ids = new Set();
  try {
    const rows = catalog.flatMap(s => {
      if (!plain(s)) fail(code);
      const archived = Boolean(s.archived);
      if (archived && !includeArchived) return [];
      const spaceId = s.id;
      if (!id(spaceId) || ids.has(spaceId)) fail(code); ids.add(spaceId);
      const queue = s.queue;
      if (!Array.isArray(queue) || queue.length > 300) fail(code);
      const queueCounts = Object.fromEntries(QUEUE_STATUSES.map(status => [status, 0]));
      for (const item of queue) {
        if (!plain(item)) fail(code);
        const status = item.status;
        if (!QUEUE_STATUSES.includes(status)) fail(code);
        queueCounts[status]++;
      }
      // Do not enumerate source values or inspect members, task/reply text,
      // private messages, environment or unrelated delivery metadata.
      return [{ id: spaceId, name: text(s.name, 200, code), writable: !archived && s.writable === true, queueCounts }];
    });
    if (Buffer.byteLength(JSON.stringify(rows)) > MAX_BUSINESS_INDEX_BYTES) fail(code);
    return rows;
  } catch { fail(code); }
}
// Compatibility name for existing callers; it now means readable metadata.
const catalogRows = readableCatalogRows;
function writableCatalogRows(catalog) { return readableCatalogRows(catalog).filter(row => row.writable === true); }
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
  const input = { version: 1, mode: 'record-only', batchId, events: normalizedEvents, spaces: readableCatalogRows(catalog), pendingQuestions };
  // Reserve the largest valid batch ID and attempt number added by the caller.
  if (encodedBatchBytes({ ...input, batchId: 'b'.repeat(200), attempt: Number.MAX_SAFE_INTEGER }) > MAX_BATCH_INPUT_BYTES) fail('ERR_BUTLER_INPUT_CAPACITY');
  return input;
}
function interpretResult(value, { events, catalog, questions = [] }) {
  const code = 'ERR_BUTLER_RESULT', questionCode = 'ERR_BUTLER_QUESTION_SOURCE';
  if (typeof value === 'string') {
    if (Buffer.byteLength(value) > 128 * 1024) fail(code);
    try { value = JSON.parse(value); } catch { fail(code); }
  }
  fields(value, ['actions'], ['actions'], code);
  if (!Array.isArray(value.actions) || value.actions.length > 100) fail(code);
  const sources = sourcesByRef(businessEvents(events)), spaces = readableCatalogRows(catalog);
  const writableSpaces = spaces.filter(space => space.writable === true);
  let includingArchived;
  // An explicit question/report reference can name a previously requested archive.
  // Queue and lifecycle target validation never requests archived metadata or bodies.
  const readableSpace = spaceId => spaces.some(space => space.id === spaceId) ||
    (includingArchived ||= readableCatalogRows(catalog, { includeArchived: true })).some(space => space.id === spaceId);
  if (!Array.isArray(questions)) fail(questionCode);
  const normalize = a => {
    fields(a, ['kind', 'sourceRef', 'text', 'spaceId', 'decisionKind', 'evidenceRevision', 'supersedes'], ['kind', 'sourceRef', 'text'], code);
    if (!['queue', 'open', 'archive', 'question', 'report'].includes(a.kind) || !sources.has(a.sourceRef)) fail(code);
    const result = { kind: a.kind, sourceRef: a.sourceRef, text: text(a.text, a.kind === 'queue' ? 6000 : 12000, code) };
    if (a.spaceId !== undefined) {
      if (!id(a.spaceId) || !(['queue', 'open', 'archive'].includes(a.kind)
        ? writableSpaces.some(space => space.id === a.spaceId) : readableSpace(a.spaceId))) fail(code);
      result.spaceId = a.spaceId;
    }
    if (a.kind === 'queue' && !result.spaceId) {
      if (writableSpaces.length !== 1) result.kind = 'question';
      else result.spaceId = writableSpaces[0].id;
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
module.exports = { validateEvent, catalogRows, readableCatalogRows, writableCatalogRows, MAX_BUSINESS_INDEX_BYTES,
  buildInput, interpretResult, rotationCandidates };
