// A human delegate on the existing native session, never a desktop owner or agent.
const fs = require('node:fs'), path = require('node:path');
const { createHash, randomUUID, randomBytes } = require('node:crypto');
const { verifyTicket } = require('./mobile-access.cjs');
const { readLayout } = require('./service-layout.cjs');
const { nativeApprovalPolicy } = require('./approval-policy.js');
const wake = require('./session-wake.cjs');
const CAPABILITY = 'humanMobileV1', MAX_REQUESTS = 256, TEXT_BYTES = 65536;
const PREPARED = 'humanMobilePreparedV1', PREPARE_MS = 40000;
const delegates = new WeakSet();
const pending = new WeakMap();
const clock = () => Number(process.hrtime.bigint() / 1000000n);
const denied = () => Error('手机请求、原会话或授权已变化；没有重新派发，请核对原记录。');
const exact = (o, keys) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).length === keys.length && keys.every(k => Object.hasOwn(o, k));
const uuid = x => typeof x === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(x);
const stable = x => Array.isArray(x) ? x.map(stable) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(k => [k, stable(x[k])])) : x;
const digest = x => createHash('sha256').update(JSON.stringify(stable(x))).digest('hex');
const number = x => x ?? 0;
function location(w) {
  const dir = path.resolve(w.dataDir), root = /^[a-f0-9]{20}$/.test(path.basename(dir)) && path.basename(path.dirname(dir)) === 'backends' ? path.dirname(path.dirname(dir)) : dir;
  const key = path.relative(root, dir) || '.';
  const layout = readLayout(root);
  if (!layout.entries.includes(key) || fs.realpathSync(dir) !== path.join(fs.realpathSync(root), key === '.' ? '' : key)) throw denied();
  return { root, key, layout };
}
function serviceProof(w) {
  const { layout } = location(w); if (layout.pending) throw denied();
  return JSON.stringify([...layout.entries].sort());
}
function checked(w, ticket, action) {
  const { root, key } = location(w), s = w.get(ticket?.sessionId);
  const target = { serviceKey: key, sessionId: s.id, nativeId: s.nativeId };
  if (w.closed || s.archived || s.nativeContextPending) throw denied();
  verifyTicket(root, ticket, target, action);
  return s;
}
function proof(s) { return { nativeId: s.nativeId, controlRevision: number(s.controlRevision), connectionRevision: number(s.connectionRevision) }; }
function sameProof(s, value) { return exact(value, ['nativeId', 'controlRevision', 'connectionRevision']) && Object.entries(proof(s)).every(([k, v]) => value[k] === v); }
function request(spec, action) {
  const keys = action === 'send' ? ['requestId', 'proof', 'text'] : ['requestId', 'proof', 'questionId', 'answers'];
  if (!exact(spec, keys) || !uuid(spec.requestId) || !exact(spec.proof, ['nativeId', 'controlRevision', 'connectionRevision'])) throw denied();
  if (action === 'send') {
    if (typeof spec.text !== 'string' || !spec.text.trim() || spec.text.length > 16000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(spec.text) || /^\//.test(spec.text.trim())) throw denied();
  } else if (!uuid(spec.questionId) || !spec.answers || typeof spec.answers !== 'object' || Array.isArray(spec.answers) || Buffer.byteLength(JSON.stringify(spec.answers)) > TEXT_BYTES) throw denied();
}
function records(w) {
  if (!Array.isArray(w.mobileRequests) || w.mobileRequests.length > MAX_REQUESTS || w.mobileRequests.some(r =>
    !exact(r, ['deviceId', 'generation', 'issuer', 'requestId', 'serviceKey', 'sessionId', 'nativeId', 'action', 'digest', 'tag', 'status', 'error', 'at']) ||
    !['deviceId', 'generation', 'issuer', 'requestId', 'tag'].every(k => uuid(r[k])) || !['send', 'answer'].includes(r.action) ||
    !['serviceKey', 'sessionId', 'nativeId'].every(k => typeof r[k] === 'string' && r[k].length > 0 && r[k].length <= 512) ||
    !/^[a-f0-9]{64}$/.test(r.digest) || !(r.error === null || typeof r.error === 'string' && r.error.length <= 16000) || !['prepared', 'awaiting-native', 'submitted', 'unconfirmed', 'not-sent', 'reply-written'].includes(r.status) || !Number.isSafeInteger(r.at))) throw denied();
  return w.mobileRequests;
}
function lookup(w, ticket, spec, action) {
  checked(w, ticket, action); request(spec, action);
  const row = records(w).find(r => r.deviceId === ticket.deviceId && r.requestId === spec.requestId);
  if (row && (row.issuer !== ticket.issuer.instance || row.generation !== ticket.generation || row.action !== action || row.digest !== digest(spec) ||
    row.serviceKey !== ticket.serviceKey || row.sessionId !== ticket.sessionId || row.nativeId !== ticket.nativeId)) throw denied();
  return row || null;
}
function receipt(w, row) {
  const message = w.sessions.get(row.sessionId)?.messages.find(m => m.id === row.tag);
  const held = row.status === 'prepared' && [...(pending.get(w)?.values() || [])].find(d => d.row === row);
  const expired = held && !held.used && (held.connection.destroyed || clock() >= held.until);
  const status = expired ? 'not-sent' : row.action === 'send' && message?.status === 'submitted' ? 'submitted' : row.status;
  return { requestId: row.requestId, tag: row.tag, sessionId: row.sessionId, nativeId: row.nativeId, action: row.action, status, error: expired ? '手机预备已过期或连接已断开，没有派发。' : row.error, storageWarning: w.storageWarning || null };
}
function reserve(w, ticket, spec, action, tag) {
  const rows = records(w).filter(r => r.deviceId === ticket.deviceId && r.generation === ticket.generation && r.issuer === ticket.issuer.instance);
  if (rows.length >= MAX_REQUESTS) throw Error('本次手机连接的回执已达上限，请先核对记录，再在 Mac 重新配对。');
  const row = { deviceId: ticket.deviceId, generation: ticket.generation, issuer: ticket.issuer.instance, requestId: spec.requestId,
    serviceKey: ticket.serviceKey, sessionId: ticket.sessionId, nativeId: ticket.nativeId, action, digest: digest(spec), tag, status: 'awaiting-native', error: null, at: Date.now() };
  rows.push(row); w.mobileRequests = rows;
  return row;
}
function delegate(w, ticket, spec, action) {
  const s = checked(w, ticket, action), runtime = w.runtime(s.id);
  if (w.storageWarning || !sameProof(s, spec.proof)) throw denied();
  const services = serviceProof(w);
  let control = s.controlRevision;
  const connection = s.connectionRevision, native = s.nativeId;
  const d = {
    valid() {
      try { return checked(w, ticket, action) === s && serviceProof(w) === services && !w.storageWarning && w.runtimes.get(s.id) === runtime && !runtime.stopped && !runtime.backendExitConfirmed &&
        !runtime.transportDisconnected && s.nativeId === native && s.controlRevision === control && s.connectionRevision === connection &&
        (!d.connection || d.used || !d.connection.destroyed && clock() < d.until) && (!d.questionValid || d.questionValid()); } catch { return false; }
    },
    human() {
      if (!d.valid()) throw denied();
      wake.human(w, s.id); w.pause('手机真人输入优先'); w.cancelCapacity(s.id);
      if (!d.valid()) throw denied();
      s.peerRevision = (s.peerRevision || 0) + 1; s.controlRevision++; control = s.controlRevision;
    },
    reserve(tag, status = 'awaiting-native') {
      if (!d.valid()) throw denied();
      if (d.row) { if (d.row.tag !== tag || !records(w).includes(d.row)) throw denied(); }
      else d.row = reserve(w, ticket, spec, action, tag);
      d.row.status = status; w.persist();
      if (w.storageWarning) { d.row.status = 'not-sent'; throw Object.assign(Error('手机请求回执未能保存，没有向原生派发。'), { notSent: true }); }
    },
    prepare() { if (d.validationOnly) return false; if (!d.valid()) throw denied(); d.reserve(d.row?.tag || randomUUID()); d.human(); },
  };
  delegates.add(d); return d;
}
function valid(d) { return delegates.has(d) && d.valid(); }
async function executeSend(w, d) {
  const s = w.get(d.ticket.sessionId);
  try { await w.send(s.id, d.spec.text, null, null, null, null, null, null, d); }
  catch (e) { if (!d.row) throw e; d.row.status = !d.started || e.notSent === true ? 'not-sent' : 'unconfirmed'; d.row.error = String(e.message || e).slice(0, 16000); }
  if (!d.row) throw denied();
  if (s.messages.find(m => m.id === d.row.tag)?.status === 'submitted') d.row.status = 'submitted';
  else if (d.row.status === 'awaiting-native') d.row.status = 'unconfirmed';
  w.persist(); return receipt(w, d.row);
}
function executeAnswer(w, d) {
  try { w.answer(d.ticket.sessionId, d.spec.questionId, d.spec.answers, null, d); }
  catch (e) { if (!d.row) throw e; d.row.status = !d.started || e.notSent === true ? 'not-sent' : 'unconfirmed'; d.row.error = String(e.message || e).slice(0, 16000); }
  if (!d.row) throw denied();
  if (d.row.status === 'awaiting-native') d.row.status = 'reply-written';
  w.persist(); return receipt(w, d.row);
}
function leases(w) { if (!pending.has(w)) pending.set(w, new Map()); return pending.get(w); }
function prepare(w, ticket, spec, action, connection) {
  if (!['send', 'answer'].includes(action)) throw denied();
  const previous = lookup(w, ticket, spec, action); if (previous) return { receipt: receipt(w, previous) };
  if (!connection || typeof connection !== 'object' || connection.destroyed) throw denied();
  if (records(w).filter(r => r.deviceId === ticket.deviceId && r.generation === ticket.generation && r.issuer === ticket.issuer.instance).length >= MAX_REQUESTS) throw denied();
  ticket = JSON.parse(JSON.stringify(ticket)); spec = JSON.parse(JSON.stringify(spec));
  const s = w.get(ticket.sessionId), r = w.runtime(s.id);
  if (action === 'send' && (s.state !== 'idle' || s.pendingTag || s.approval || r.pendingQueue || r.nativeInputRequired || r.nativeAbortRequest || r.chatAvailable === false)) throw denied();
  const d = delegate(w, ticket, spec, action);
  d.ticket = ticket; d.spec = spec; d.action = action; d.connection = connection; d.until = clock() + PREPARE_MS; d.used = false;
  if (action === 'answer') {
    const original = question(w, s); if (!original || original.requestId !== spec.questionId) throw denied();
    const fingerprint = digest(original);
    d.questionValid = () => { const current = question(w, s); return current && current.requestId === spec.questionId && digest(current) === fingerprint; };
    d.validationOnly = true;
    try { w.answer(s.id, spec.questionId, spec.answers, null, d); } finally { d.validationOnly = false; }
  }
  try { d.reserve(randomUUID(), 'prepared'); }
  catch (e) {
    if (!d.row) throw e;
    d.row.status = 'not-sent'; d.row.error = String(e.message || e).slice(0, 16000);
    return { receipt: receipt(w, d.row) };
  }
  const entries = leases(w);
  for (const [key, old] of entries) if (old.ticket.deviceId !== ticket.deviceId || old.ticket.generation !== ticket.generation) entries.delete(key);
  const lease = randomBytes(32).toString('base64url'); entries.set(lease, d);
  return { prepared: true, lease, receipt: receipt(w, d.row) };
}
function prepared(w, ticket, lease, connection, action) {
  const d = pending.get(w)?.get(lease);
  if (!d || d.connection !== connection || d.action !== action || d.ticket.deviceId !== ticket?.deviceId || d.ticket.generation !== ticket.generation || d.ticket.sessionId !== ticket.sessionId) throw denied();
  return d;
}
function cancel(w, ticket, lease, connection, action, reason = '手机请求在提交前停止，没有向原生派发。') {
  const d = prepared(w, ticket, lease, connection, action);
  if (!d.used) { d.used = true; d.row.status = 'not-sent'; d.row.error = reason; if (!w.closed) w.persist(); }
  return receipt(w, d.row);
}
function commit(w, ticket, lease, connection, action) {
  checked(w, ticket, action);
  const d = prepared(w, ticket, lease, connection, action);
  if (d.used) return receipt(w, d.row);
  if (!d.valid()) return cancel(w, ticket, lease, connection, action);
  d.used = true;
  return action === 'send' ? executeSend(w, d) : executeAnswer(w, d);
}
function disconnected(w, connection) {
  let changed = false;
  for (const d of pending.get(w)?.values() || []) if (d.connection === connection && !d.used) {
    d.used = true; d.row.status = 'not-sent'; d.row.error = '手机桥接连接已断开，没有向原生派发。'; changed = true;
  }
  if (changed && !w.closed) w.persist();
}
// Local helpers share the same machinery. The daemon exposes the prepared path.
async function send(w, ticket, spec) {
  const connection = {}, ready = prepare(w, ticket, spec, 'send', connection);
  return ready.prepared ? commit(w, ticket, ready.lease, connection, 'send') : ready.receipt;
}
function answer(w, ticket, spec) {
  const connection = {}, ready = prepare(w, ticket, spec, 'answer', connection);
  return ready.prepared ? commit(w, ticket, ready.lease, connection, 'answer') : ready.receipt;
}
function question(w, s) {
  if (s.provider === 'claude') {
    const held = w.claudeAsks.get(s.id);
    if (!held || s.roomId || s.view !== 'chat' || !held.open()) return null;
    return { requestId: held.requestId, questions: held.questions.map(q => ({ question: q.question, header: q.header, multiSelect: Boolean(q.multiSelect), options: (q.options || []).map(o => ({ label: o.label, description: o.description })) })) };
  }
  const queue = w.approvalRoutes.get(s.id), row = queue?.current;
  const qs = nativeApprovalPolicy(row?.approval).questions;
  if (!row || !qs || qs.some(q => q.isSecret) || queue.overflow || row.approval.pending || s.state !== 'approval' || row.runtime !== w.runtimes.get(s.id) ||
    !(row.rpc === w.host.rpc || row.runtime.currentRpc?.(row.rpc)) || row.runtime.transportDisconnected || row.runtime.backendExitConfirmed) return null;
  return { requestId: row.requestId, questions: qs.map(q => ({ id: q.id, header: q.header, question: q.question, isOther: Boolean(q.isOther), options: (q.options || []).map(o => ({ label: o.label, description: o.description })) })) };
}
function read(w, ticket) {
  const s = checked(w, ticket, 'read'), r = w.runtimes.get(s.id);
  const boundary = s.messages.findLastIndex(m => s.nativeContexts?.some(c => c.boundaryId === m.id));
  const rows = s.messages.slice(boundary + 1).filter(m => m.role === 'assistant' && (!m.nativeId || m.nativeId === s.nativeId));
  let remaining = TEXT_BYTES;
  const messages = rows.slice(-6).reverse().map(m => {
    const text = typeof m.text === 'string' ? m.text : '', bytes = Buffer.byteLength(text), omitted = bytes > remaining;
    if (!omitted) remaining -= bytes;
    return { id: m.id, kind: m.kind || null, status: m.status || null, text: omitted ? null : text, textOmitted: omitted,
      unsupportedAttachments: Array.isArray(m.images) ? m.images.length : 0 };
  }).reverse();
  const q = question(w, s);
  return { id: s.id, nativeId: s.nativeId, provider: s.provider, name: s.name, state: s.state, proof: proof(s),
    canSend: s.state === 'idle' && !!r && !r.stopped && !r.backendExitConfirmed && !r.transportDisconnected && r.chatAvailable !== false && !r.nativeInputRequired && !r.nativeAbortRequest && !r.pendingQueue && !s.pendingTag && !s.approval && !w.storageWarning,
    question: q && Buffer.byteLength(JSON.stringify(q)) <= TEXT_BYTES ? q : null, questionOmitted: Boolean(q && Buffer.byteLength(JSON.stringify(q)) > TEXT_BYTES),
    messages, earlierMessagesOmitted: Math.max(0, rows.length - messages.length) };
}
function find(w, ticket, spec, action) { const row = lookup(w, ticket, spec, action); return row ? receipt(w, row) : null; }
module.exports = { CAPABILITY, PREPARED, PREPARE_MS, MAX_REQUESTS, read, send, answer, find, valid, prepare, commit, cancel, disconnected };
