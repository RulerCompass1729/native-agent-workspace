const { uiError, uiNotice } = require('./ui-errors.cjs');
// A human delegate on the existing native session, never a desktop owner or agent.
const fs = require('node:fs'), path = require('node:path');
const { createHash, randomUUID, randomBytes } = require('node:crypto');
const { verifyTicket } = require('./mobile-access.cjs');
const { readLayout } = require('./service-layout.cjs');
const { nativeApprovalPolicy, nonBlockingQuestion } = require('./approval-policy.js');
const wake = require('./session-wake.cjs');
const { MAX_REQUESTS, MAX_RETIRED_IDS, confirmedNative } = require('./mobile-receipts.cjs');
const CAPABILITY = 'humanMobileV1', TEXT_BYTES = 65536;
const PREPARED = 'humanMobilePreparedV1', PREPARE_MS = 40000;
const delegates = new WeakSet();
const pending = new WeakMap();
const clock = () => Number(process.hrtime.bigint() / 1000000n);
const denied = () => uiError("error.mobile.requestChanged");
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
function readableTarget(s) { return Boolean(s && !s.archived && !s.nativeContextPending && typeof s.nativeId === 'string' && s.nativeId); }
// Current all-mode grants exclude ended targets; selected historical reads
// intentionally retain their existing semantics through readableTarget().
function currentTarget(s, runtime) {
  return readableTarget(s) && !['ended','closed'].includes(s.state) && !s.backendUnavailable && !s.backendExitConfirmed && !s.stopped && !runtime?.stopped && !runtime?.backendExitConfirmed;
}
// How a phone message would go now, decided as the Mac composer decides (renderer.js composer choice): an idle
// session takes it at once; a working Claude session takes one queued message (Workspace.queue); a working Codex
// session takes one added instruction into its current turn (Workspace.steer). Nothing else does.
function sendMode(s, r) {
  if (!r || r.transportDisconnected || r.chatAvailable === false || r.nativeInputRequired || r.nativeAbortRequest || r.pendingQueue || s.approval) return null;
  if (s.state === 'idle') return s.pendingTag ? null : 'send';
  if (s.state === 'working' && s.provider === 'claude' && r.queueAvailable) return r.midturnAvailable === true ? 'queueMidturn' : 'queue';
  if (s.state === 'working' && s.provider === 'codex' && r.steerAvailable && !r.pendingSteer && typeof r.turnId === 'string' && r.turnId) return 'steer';
  return null;
}
// Why the phone cannot send now, so the phone can say it instead of only greying the button.
function sendBlocked(s, r, question) {
  if (!r || r.transportDisconnected || r.chatAvailable === false) return 'disconnected';
  if (r.nativeAbortRequest || r.nativeInputRequired) return 'interrupt';
  if (question) return 'question';
  // An answer already given (from the phone or the Mac) waits for native, not for the person.
  if (s.approval?.pending === true) return 'answerPending';
  if (s.approval || s.state === 'approval') return 'approval';
  if (r.pendingQueue || s.state === 'idle' && s.pendingTag) return 'queueBusy';
  if (s.state === 'working' && s.provider === 'codex' && r.pendingSteer) return 'steerBusy';
  if (s.state === 'working') return 'noQueue';
  // Starting, stopping, an error, a cancelled reconnect (recoverable): the phone says so instead of telling the person to wait for idle.
  return 'notReady';
}
function checked(w, ticket, action) {
  const { root, key } = location(w), s = w.get(ticket?.sessionId);
  const target = { serviceKey: key, sessionId: s.id, nativeId: s.nativeId };
  if (w.closed || !readableTarget(s)) throw denied();
  verifyTicket(root, ticket, target, action);
  return s;
}
const PROOF = ['nativeId', 'controlRevision', 'connectionRevision'], QUEUED = ['queue', 'queueMidturn'], TURNED = [...QUEUED, 'steer'];
const turnOf = r => typeof r?.turnId === 'string' && r.turnId ? r.turnId : null;
// What the phone was shown: a queued send or a steer also names its mode and the turn it was read in (a steer always
// has one). An idle send keeps the original three keys, so receipts stored before keep their digest. The proof stays
// in the broker (mobile-broker.cjs #contexts) and never reaches the phone.
function proof(s, r = null, mode = sendMode(s, r)) {
  const base = { nativeId: s.nativeId, controlRevision: number(s.controlRevision), connectionRevision: number(s.connectionRevision) };
  if (!TURNED.includes(mode)) return base;
  const turnId = turnOf(r);
  return { ...base, sendMode: mode, ...(turnId ? { turnId } : {}) };
}
const turnShape = v => typeof v.turnId === 'string' && v.turnId.length > 0 && v.turnId.length <= 512;
const proofShape = v => exact(v, PROOF) || TURNED.includes(v?.sendMode) &&
  (v.sendMode !== 'steer' && exact(v, [...PROOF, 'sendMode']) || exact(v, [...PROOF, 'sendMode', 'turnId']) && turnShape(v));
function sameProof(s, value) { const current = proof(s, null, null); return proofShape(value) && PROOF.every(k => value[k] === current[k]); }
// A send goes only the way the phone showed it, and a queued one or a steer only into the turn it was read in
// (Claude 7, F1: NAW's own dispatch starts a turn without a control change). An unsendable state is left to the
// send's own refusal.
function asShown(s, r, value) { const now = proof(s, r); return (now.sendMode || 'send') === (value.sendMode || 'send') && (now.turnId || null) === (value.turnId || null); }
const CHANGED = '手机读到后会话的状态已经变了，没有发送。';
function request(spec, action) {
  const keys = action === 'send' ? ['requestId', 'proof', 'text'] : ['requestId', 'proof', 'questionId', 'answers'];
  if (!exact(spec, keys) || !uuid(spec.requestId) || !proofShape(spec.proof)) throw denied();
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
function retiredFor(w, ticket) {
  const retired = w.mobileRetiredRequests;
  if (retired === null) return {};
  if (!exact(retired, ['deviceId', 'rows']) || !uuid(retired.deviceId) ||
    !retired.rows || Object.getPrototypeOf(retired.rows) !== Object.prototype) throw denied();
  const entries = Object.entries(retired.rows);
  if (entries.length > MAX_RETIRED_IDS || entries.some(([id, row]) => !uuid(id) ||
    !exact(row, ['key', 'tag', 'status']) || !/^[a-f0-9]{64}$/.test(row.key) || !uuid(row.tag) || !confirmedNative(row))) throw denied();
  return retired.deviceId === ticket.deviceId ? retired.rows : {};
}
function retiredBinding(row) {
  return digest([row.issuer, row.generation, row.serviceKey, row.sessionId, row.nativeId, row.action, row.digest]);
}
function lookup(w, ticket, spec, action) {
  checked(w, ticket, action); request(spec, action);
  if (Object.hasOwn(retiredFor(w, ticket), spec.requestId)) throw denied();
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
  // Resume rotates issuer and generation but preserves the paired device.
  const rows = records(w).filter(r => r.deviceId === ticket.deviceId);
  let retiredRows = retiredFor(w, ticket);
  if (rows.length >= MAX_REQUESTS) {
    const oldest = Object.keys(retiredRows).length < MAX_RETIRED_IDS ? rows.findIndex(confirmedNative) : -1;
    if (oldest < 0) throw uiError("error.mobile.receiptLimit");
    const [retired] = rows.splice(oldest, 1);
    const entries = pending.get(w);
    for (const [lease, delegate] of entries || []) if (delegate.row === retired) entries.delete(lease);
    retiredRows = { ...retiredRows, [retired.requestId]: { key: retiredBinding(retired), tag: retired.tag, status: retired.status } };
  }
  const row = { deviceId: ticket.deviceId, generation: ticket.generation, issuer: ticket.issuer.instance, requestId: spec.requestId,
    serviceKey: ticket.serviceKey, sessionId: ticket.sessionId, nativeId: ticket.nativeId, action, digest: digest(spec), tag, status: 'awaiting-native', error: null, at: Date.now() };
  rows.push(row);
  w.mobileRetiredRequests = Object.keys(retiredRows).length ? { deviceId: ticket.deviceId, rows: retiredRows } : null;
  w.mobileRequests = rows;
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
      wake.human(w, s.id); w.pause('手机真人输入优先', undefined, false, uiNotice('notice.run.mobileHuman').uiMessage); w.cancelCapacity(s.id);
      if (!d.valid()) throw denied();
      s.peerRevision = (s.peerRevision || 0) + 1; s.controlRevision++; control = s.controlRevision;
    },
    reserve(tag, status = 'awaiting-native') {
      if (!d.valid()) throw denied();
      if (d.row) { if (d.row.tag !== tag || !records(w).includes(d.row)) throw denied(); }
      else d.row = reserve(w, ticket, spec, action, tag);
      d.row.status = status; w.persist();
      if (w.storageWarning) { d.row.status = 'not-sent'; throw Object.assign(uiError("error.mobile.receiptSaveFailed"), { notSent: true }); }
    },
    prepare() { if (d.validationOnly) return false; if (!d.valid()) throw denied(); d.reserve(d.row?.tag || randomUUID()); d.human(); },
  };
  delegates.add(d); return d;
}
function valid(d) { return delegates.has(d) && d.valid(); }
function sent(w, d, s, error) {
  if (error) { if (!d.row) throw error; d.row.status = !d.started || error.notSent === true ? 'not-sent' : 'unconfirmed'; d.row.error = String(error.message || error).slice(0, 16000); }
  if (!d.row) throw denied();
  if (s.messages.find(m => m.id === d.row.tag)?.status === 'submitted') d.row.status = 'submitted';
  else if (d.row.status === 'awaiting-native') d.row.status = 'unconfirmed';
  w.persist(); return receipt(w, d.row);
}
async function executeSend(w, d) {
  const s = w.get(d.ticket.sessionId), r = w.runtimes.get(s.id), mode = sendMode(s, r);
  if (!asShown(s, r, d.spec.proof)) return sent(w, d, s, Object.assign(Error(CHANGED), { notSent: true }));
  // Only into the turn the phone read: Workspace.steer and native turn/steer both refuse any other turn, and nothing
  // falls back to a new turn. The turn/steer receipt is the end.
  if (mode === 'steer') {
    try { await w.steer(s.id, d.spec.text, null, d.spec.proof.turnId, null, d); } catch (e) { return sent(w, d, s, e); }
    return sent(w, d, s);
  }
  if (!QUEUED.includes(mode)) {
    try { await w.send(s.id, d.spec.text, null, null, null, null, null, null, d); } catch (e) { return sent(w, d, s, e); }
    return sent(w, d, s);
  }
  // Claude reads a queued message only at its next tool step or after its turn, possibly minutes later. As the butler
  // designation does (main.cjs stewardDuty), the phone hears back once the message stands queued; its receipt follows.
  const outcome = w.queue(s.id, d.spec.text, null, null, d).then(() => null, error => error || denied());
  const first = await Promise.race([outcome, new Promise(resolve => setImmediate(resolve, 'waiting'))]);
  if (first !== 'waiting') return sent(w, d, s, first || undefined);
  // Early only when this request's own row, the native queue slot and the queued message share one tag (B's review, C1).
  const tag = d.row?.tag, standing = d.row?.status === 'awaiting-native' && w.runtimes.get(s.id)?.pendingQueue === tag && s.messages.some(m => m.id === tag && m.status === 'awaiting-native');
  if (!standing) return sent(w, d, s, (await outcome) || undefined);
  outcome.then(error => { try { sent(w, d, s, error || undefined); } catch { /* The stored row keeps its last status. */ } });
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
  // A stored outcome remains readable; only a new submission is refused.
  // Same rule as mobile-broker.cjs: a native terminal prefix, also after leading invisible characters or in full-width form.
  if (action === 'send' && /^[!#/]/.test(spec.text.normalize('NFKC').replace(/^[\s\p{Cc}\p{Default_Ignorable_Code_Point}]+/u, ''))) throw denied();
  if (!connection || typeof connection !== 'object' || connection.destroyed) throw denied();
  ticket = JSON.parse(JSON.stringify(ticket)); spec = JSON.parse(JSON.stringify(spec));
  const s = w.get(ticket.sessionId), r = w.runtime(s.id);
  // A steer read whose turn has gone is answered not-sent below, as 9afe5cdf did; other unsendable states are refused.
  if (action === 'send' && !sendMode(s, r) && spec.proof.sendMode !== 'steer') throw denied();
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
  if (action === 'send' && !asShown(s, r, spec.proof)) { d.used = true; d.row.status = 'not-sent'; d.row.error = CHANGED; w.persist(); return { receipt: receipt(w, d.row) }; }
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
  // The same rule as Workspace.answer: a non-blocking question is open while its turn works or after it ended.
  const waiting = s.state === 'approval' || nonBlockingQuestion(row?.approval) && ['working', 'idle'].includes(s.state);
  if (!row || !qs || qs.some(q => q.isSecret) || queue.overflow || row.approval.pending || !waiting || row.runtime !== w.runtimes.get(s.id) ||
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
  const q = question(w, s), mode = currentTarget(s, r) && !w.storageWarning ? sendMode(s, r) : null;
  return { id: s.id, nativeId: s.nativeId, provider: s.provider, name: s.name, state: s.state, proof: proof(s, r, mode),
    canSend: Boolean(mode), sendMode: mode, sendBlocked: mode ? null : !currentTarget(s, r) ? 'ended' : w.storageWarning ? 'storage' : sendBlocked(s, r, q),
    question: q && Buffer.byteLength(JSON.stringify(q)) <= TEXT_BYTES ? q : null, questionOmitted: Boolean(q && Buffer.byteLength(JSON.stringify(q)) > TEXT_BYTES),
    messages, earlierMessagesOmitted: Math.max(0, rows.length - messages.length) };
}
function find(w, ticket, spec, action) {
  checked(w, ticket, action); request(spec, action);
  const retired = retiredFor(w, ticket)[spec.requestId];
  if (retired) {
    const { generation, serviceKey, sessionId, nativeId } = ticket;
    if (retired.key !== retiredBinding({ issuer: ticket.issuer.instance, generation, serviceKey, sessionId, nativeId, action, digest: digest(spec) })) throw denied();
    return { requestId: spec.requestId, tag: retired.tag, sessionId, nativeId, action, status: retired.status,
      error: null, storageWarning: w.storageWarning || null };
  }
  const row = lookup(w, ticket, spec, action);
  return row ? receipt(w, row) : null;
}
module.exports = { CAPABILITY, PREPARED, PREPARE_MS, MAX_REQUESTS, currentTarget, read, send, answer, find, valid, prepare, commit, cancel, disconnected };
