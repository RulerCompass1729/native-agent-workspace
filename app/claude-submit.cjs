const { rootValidity } = require('./native-root-proof.cjs');
const { outboxError, classifyOutboxFailure } = require('./computer-use-outbox-native.cjs');
const { uiError } = require('./ui-errors.cjs');
// Private Unix-socket transport for Claude's native prompt.submit API.
// No terminal writes, TCP listener, model calls, or automatic send retries.
const http = require('node:http');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');

const COMPACTION_MS = 300000;

class SubmissionChannel extends EventEmitter {
  constructor(timeout = 15000) { super(); this.timeout = timeout; this.poll = null; this.pending = null; this.connected = false; this.compacting = false; }
  status(connected) { if (this.connected !== connected) { this.connected = connected; this.emit('change'); } }
  receive(response) {
    // The native listener asks for another command only after the previous
    // submit/result attempt has settled. If its result was lost, end this
    // uncertain wait; never redeliver the already-authorized native input.
    if ((this.pending?.waitForNativeTurn || this.compacting) && this.pending?.delivered && this.pending.authorized) this.finish(uiError("error.nativeWaitingInputUnconfirmed"));
    // A held message is gone with the listener that held it (a reload): never authorized, so never sent.
    else if (this.pending?.held && !this.pending.authorized) this.finish(uiError("error.submission.holdEnded"));
    if (this.poll) this.poll.end(JSON.stringify({ idle: true }));
    this.poll = response; this.status(true);
    const timer = setTimeout(() => { if (this.poll === response) { this.poll = null; response.end(JSON.stringify({ idle: true })); } }, 20000);
    response.once('close', () => { clearTimeout(timer); if (this.poll === response) { this.poll = null; this.status(false); } });
    this.flush();
  }
  // midturn: the mod may hold the message for the running turn's next tool boundary
  // (it answers /hold), so the first-answer limit ends there; authorization stays at dispatch.
  // A guard marked ownInput is the person's own private message: the mod sends it beside a draft
  // in the native prompt, which stays as typed (measured); anything else still waits for the draft.
  request(text, tag, guard, waitForNativeTurn = false, midturn = false, midturnText) {
    if (!this.connected) return Promise.reject(Object.assign(uiError("error.safeSubmissionNotReady"), { notSent: true }));
    if (this.pending) return Promise.reject(Object.assign(uiError("error.previousSubmissionPending"), { notSent: true }));
    return new Promise((resolve, reject) => {
      const timer = this.limit();
      this.pending = { text, tag, guard, resolve, reject, timer, delivered: false, authorized: false, waitForNativeTurn, midturn: midturn === true, midturnText: midturn === true && typeof midturnText === 'string' && midturnText ? midturnText : undefined, held: false, own: guard?.ownInput === true, deadline: Date.now() + this.timeout };
      this.flush();
    });
  }
  flush() {
    const p = this.pending, response = this.poll;
    if (!p || !response || p.delivered) return;
    if (!p.guard()) return this.finish(uiError("error.submissionRevokedByHuman"));
    p.delivered = true; this.poll = null;
    response.end(JSON.stringify({ id: p.tag, text: p.text, ...(p.midturn ? { midturn: true } : {}), ...(p.midturnText ? { midturnText: p.midturnText } : {}), ...(p.own ? { own: true } : {}) }));
  }
  hold(message) {
    const p = this.pending;
    if (!p || !p.midturn || p.tag !== message.id || !p.delivered || p.authorized || p.held || Date.now() >= p.deadline) return false;
    if (!p.guard()) { this.finish(uiError("error.submissionRevokedByHuman")); return false; }
    // Unauthorized while held: any later failure still proves it was not sent.
    p.held = true; clearTimeout(p.timer);
    return true;
  }
  read(message) {
    // After the receipt the request is settled; the adapter matches tag and row id.
    if (typeof message.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(message.uuid || '') || !/^[a-zA-Z0-9_:-]{1,160}$/.test(message.turnId || '')) return false;
    this.emit('read', { tag: message.id, uuid: message.uuid, turnId: message.turnId });
    return true;
  }
  authorize(message) {
    const p = this.pending;
    if (!p || p.tag !== message.id || p.text !== message.text || !p.delivered || p.authorized || (!p.held && Date.now() >= p.deadline) || !p.guard()) return false;
    p.authorized = true;
    // Claude's own submit promise may wait until its queued turn starts. Once
    // authorized, a wall-clock timeout would invite a duplicate of native work
    // that is still queued. Connection/context closure still rejects the wait.
    if (p.waitForNativeTurn || this.compacting) clearTimeout(p.timer);
    return true;
  }
  // Native compacts this session's context: it keeps an authorized input queued and answers when its turn starts,
  // after the compaction (2.1.332, measured: 30 to 220 s). That time is not counted; the whole limit follows it.
  // An end nobody reports (a compaction that failed) is taken after COMPACTION_MS.
  compaction(running) {
    if (this.compacting === running) return;
    this.compacting = running; clearTimeout(this.compactionTimer);
    if (running) this.compactionTimer = setTimeout(() => this.compaction(false), COMPACTION_MS).unref();
    const p = this.pending;
    if (!p?.authorized || p.waitForNativeTurn) return;
    clearTimeout(p.timer);
    if (!running) p.timer = this.limit();
  }
  limit() { return setTimeout(() => this.finish(uiError("error.nativeSubmissionUnconfirmed")), this.timeout); }
  result(message) {
    const p = this.pending;
    if (!p || p.tag !== message.id) return false;
    const turnId = typeof message.turnId === 'string' && /^[a-zA-Z0-9_:-]{1,160}$/.test(message.turnId) ? message.turnId : null;
    // Stored in the running turn: its own row id and that turn, no prompt of its own.
    if (message.status === 'accepted' && p.authorized && p.midturn && message.mode === 'append') {
      const uuid = typeof message.uuid === 'string' && /^[a-f0-9-]{36}$/i.test(message.uuid) ? message.uuid : null;
      if (uuid && turnId) this.finish(null, { mode: 'append', uuid, turnId, promptId: null });
      else this.finish(Object.assign(uiError('error.submission.nativeResultUnconfirmed'), { notSent: false }));
    } else if (message.status === 'accepted' && p.authorized) this.finish(null, {
      turnId,
      promptId: typeof message.promptId === 'string' && /^[a-f0-9-]{36}$/i.test(message.promptId) ? message.promptId : null,
    });
    else {
      const notSent = message.status === 'draft' || message.status === 'blocked';
      this.finish(Object.assign(uiError(message.status === 'draft' ? 'error.submission.nativeDraft' : notSent ? 'error.submission.nativeRejected' : 'error.submission.nativeResultUnconfirmed'), { notSent, ...(message.status === 'blocked' && message.reason === 'input-changed' ? { inputChanged: true } : {}) }));
    }
    return true;
  }
  finish(error, receipt) {
    const p = this.pending; if (!p) return;
    // The mod authorizes right before its native submit: until then native
    // cannot hold this prompt. After it, a failure leaves the outcome uncertain.
    if (error) error.notSent ??= !p.authorized;
    this.pending = null; clearTimeout(p.timer); error ? p.reject(error) : p.resolve(receipt);
  }
  close() { this.compaction(false); this.status(false); this.finish(uiError("error.safeSubmissionClosed")); this.poll?.end(JSON.stringify({ closed: true })); this.poll = null; }
}

// This credential never crosses JSON. Only the already authenticated native
// root hook can mint it; an outbox binder consumes it once before opening UI.
const outboxProofs = new WeakMap(), outboxCalls = new WeakMap();
const validToken = value => typeof value === 'string' && value.length > 0 && value.length <= 160 && !/[\x00-\x1f\x7f]/.test(value);
function rootOutboxProof(target, message, signal, stillTarget) {
  const root = target.rootTurn;
  const valid = rootValidity(target, message, signal, stillTarget, true);
  if (!['turnId', 'promptId', 'callId'].every(key => validToken(message[key]))) throw outboxError('provenance-unconfirmed', 'binding', 'Native root outbox authority is unavailable');
  const check = valid.failureCheck();
  if (check) throw outboxError('native-call-invalidated', 'binding', 'Native root outbox authority is unavailable', false, check);
  let calls = outboxCalls.get(target);
  if (calls?.root !== root) { calls = { root, ids: new Set() }; outboxCalls.set(target, calls); }
  if (calls.ids.has(message.callId) || calls.ids.size >= 64) throw Error('Native root outbox call was already used');
  calls.ids.add(message.callId);
  const args = Object.freeze(require('./computer-use-outbox-native.cjs').validateOutboxArgs(message.arguments));
  const proof = Object.freeze({});
  outboxProofs.set(proof, { target, args, valid, consumed: false });
  return proof;
}
function consumeRootOutboxProof(proof) {
  const value = outboxProofs.get(proof);
  const refused = (reason, check) => outboxError(reason, 'binding', 'Native root outbox call could not be verified', false, check);
  if (!value) throw refused('native-call-missing');
  if (value.consumed) throw refused('duplicate-call');
  const check = value.valid.failureCheck();
  if (check) throw refused('native-call-invalidated', check);
  value.consumed = true;
  return { target: value.target, args: value.args, valid: value.valid };
}
function createSubmissionServer(filename, targets, { restrictedOutboxCall, backgroundControlCall } = {}) {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const target = targets.get(req.headers['x-workspace-token']);
    if (req.method !== 'POST' || !target?.submission) { res.writeHead(403); res.end('{}'); return; }
    let body = '';
    req.setEncoding('utf8');
    req.on('error', () => {});
    req.on('data', chunk => { body += chunk; if (body.length > (req.url === '/observation' ? target.nativeMedia === true ? 2 * 1024 * 1024 : 600000 : 100000)) req.destroy(); });
    req.on('end', async () => {
      let message;
      try { message = JSON.parse(body); } catch { res.writeHead(400); res.end('{}'); return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) { res.writeHead(400); res.end('{}'); return; }
      if (['/root-bind', '/root-end', '/root-clear'].includes(req.url)) {
        const method = { '/root-bind': 'bindRoot', '/root-end': 'endRoot', '/root-clear': 'clearRoot' }[req.url];
        try {
          if (typeof target[method] !== 'function') throw Error('Unavailable');
          return res.end(JSON.stringify(await target[method](message)));
        } catch { res.writeHead(409); res.end('{}'); return; }
      }
      if (target.rootLease && !target.validRootBinding(message)) { res.writeHead(409); res.end('{}'); return; }
      if (message.sessionId !== target.record.nativeId) { res.writeHead(409); res.end('{}'); return; }
      if (req.url === '/prompt-identity') {
        try { return res.end(JSON.stringify(await target.promptIdentity(message))); }
        catch { res.writeHead(409); res.end('{}'); return; }
      }
      if (req.url === '/control-refused') {
        if (!target.validRootBinding?.(message) || !['root-call-unconfirmed', 'root-changed'].includes(message.reason) || typeof target.controlRefused !== 'function') { res.writeHead(409); res.end('{}'); return; }
        return res.end(JSON.stringify({ status: target.controlRefused(message.reason) ? 'recorded' : 'ignored' }));
      }
      if (req.url === '/addressed-refused') {
        if (!target.validRootBinding?.(message) || typeof message.recipientId !== 'string' || !message.recipientId || message.recipientId.length > 100 ||
            typeof target.addressedRefused !== 'function') { res.writeHead(409); res.end('{}'); return; }
        return res.end(JSON.stringify({ status: target.addressedRefused(message.recipientId) ? 'recorded' : 'ignored' }));
      }
      if (req.url === '/background-control') {
        const abort = new AbortController(), closed = () => abort.abort();
        res.once('close', closed);
        try {
          const proof = require('./background-control-native.cjs').rootCall(target, message, abort.signal, () => targets.get(req.headers['x-workspace-token']) === target);
          const result = backgroundControlCall
            ? await backgroundControlCall(proof.credential, abort.signal)
            : await require('./computer-use-outbox-tool.cjs').requestOutbox(process.env.NAW_OUTBOX_DESCRIPTOR, proof.identity, proof.args, abort.signal, true);
          if (!res.destroyed) res.end(JSON.stringify(result));
        } catch (error) { if (!res.destroyed) res.end(JSON.stringify({ state: 'unconfirmed', error: error.message, retry: false, ...classifyOutboxFailure(error, 'binding', 'binding-unavailable') })); }
        finally { res.off('close', closed); }
        return;
      }
      if (req.url === '/operator-capability') {
        const names = require('./operator-control.cjs').names;
        if (!target.validRootBinding(message) || !Array.isArray(message.tools) || message.tools.some(n => !names.includes(n))) { res.writeHead(409); res.end('{}'); return; }
        target.operatorAvailable = names.every(n => message.tools.includes(n)) && target.nativeBlocks === true && !target.retainedReader;
        target.emit('capability'); return res.end(JSON.stringify({ received: true }));
      }
      if (req.url === '/operator-call') {
        try {
          if (!target.operatorAvailable || !target.validRootBinding(message) || message.epoch !== target.observationEpoch || !target.operatorCall) throw Error('Native operator tools are not confirmed on this root connection');
          const identity = { nativeId: message.sessionId, turnId: message.turnId, promptId: message.promptId, callId: message.callId };
          return res.end(JSON.stringify(await target.operatorCall(identity, message.tool, message.arguments)));
        } catch (error) { return res.end(JSON.stringify({ status: 'refused', message: error.message })); }
      }
      if (req.url === '/addressed-capability') {
        if (!target.validRootBinding(message) || typeof message.available !== 'boolean') { res.writeHead(409); res.end('{}'); return; }
        target.addressedSendAvailable = message.available && target.nativeBlocks === true && !target.retainedReader;
        target.emit('capability'); return res.end(JSON.stringify({ received: true }));
      }
      if (req.url === '/addressed-message' || req.url === '/addressed-failed') {
        // Retained roots keep their ordinary addressed/operator gates closed.
        // This one existing hook route can use the app's restricted outbox.
        if (target.retainedReader && typeof restrictedOutboxCall === 'function') {
          const abort = new AbortController(), closed = () => abort.abort();
          let proof;
          try { proof = rootOutboxProof(target, message, abort.signal, () => targets.get(req.headers['x-workspace-token']) === target); }
          catch { return res.end(JSON.stringify({ status: 'not-sent', retry: false })); }
          if (req.url === '/addressed-failed') return res.end(JSON.stringify({ status: 'not-sent', retry: false }));
          res.once('close', closed);
          if (res.destroyed) abort.abort();
          try {
            const receipt = await restrictedOutboxCall(proof, abort.signal);
            // Old loaded native hooks accept only 'staged'. Preserve that
            // envelope solely after the full outbox's native command proof.
            const confirmed = receipt?.status === 'working' && receipt.nativeReceived === true &&
              validToken(receipt.messageId) && validToken(receipt.turnId) &&
              receipt.firstCommand?.status === 'completed' && receipt.firstCommand.exitCode === 0;
            const status = confirmed ? 'staged' : receipt?.status === 'working' ? 'unconfirmed' : receipt?.status || 'unconfirmed';
            return res.end(JSON.stringify({ status, receipt, retry: false }));
          } catch (error) { return res.end(JSON.stringify({ status: error.notSent === true ? 'not-sent' : 'unconfirmed', retry: false })); }
          finally { res.off('close', closed); }
        }
        try {
          if (!target.addressedSendAvailable || !target.validRootBinding(message) || message.epoch !== target.observationEpoch || !target.addressedCall) throw uiError("error.nativeDirectedUnsupported");
          const identity = { nativeId: message.sessionId, turnId: message.turnId, promptId: message.promptId, callId: message.callId };
          const result = req.url === '/addressed-failed' ? target.addressedFailed(identity) : target.addressedCall(identity, message.arguments);
          if (result?.then) return result.then(value => res.end(JSON.stringify(value)), error => res.end(JSON.stringify({ status: 'unconfirmed', message: error.message })));
          return res.end(JSON.stringify(result));
        } catch (error) {
          try { target.addressedFailed?.({ nativeId: message.sessionId, turnId: message.turnId, promptId: message.promptId, callId: message.callId }); } catch { /* Not the authorized root. */ }
          return res.end(JSON.stringify({ status: 'not-sent', message: error.message }));
        }
      }
      if (req.url === '/observation') {
        try { const observed = target.observeRoot(message); return res.end(JSON.stringify({ ...observed, abort: target.nativeAbortCommand?.() || undefined })); }
        catch { res.writeHead(409); res.end('{}'); return; }
      }
      if (req.url === '/abort-result') {
        try { return res.end(JSON.stringify(target.nativeAbortResult(message))); }
        catch { res.writeHead(409); res.end('{}'); return; }
      }
      if (req.url === '/next') {
        if (message.observationGap === true && target.observeRootGap) {
          try { target.observeRootGap(message); }
          catch { res.writeHead(409); res.end('{}'); return; }
        }
        return target.submission.receive(res);
      }
      if (req.url === '/hold') return res.end(JSON.stringify({ held: target.submission.hold(message) }));
      if (req.url === '/midturn-read') return res.end(JSON.stringify({ received: target.submission.read(message) }));
      if (req.url === '/authorize') {
        try { if (target.beforeAuthorize) await target.beforeAuthorize(); }
        catch { return res.end(JSON.stringify({ allowed: false })); }
        return res.end(JSON.stringify({ allowed: target.submission.authorize(message) }));
      }
      if (req.url === '/result') {
        const received = target.submission.result(message); target.completeNativeAbort?.();
        return res.end(JSON.stringify({ received }));
      }
      res.writeHead(404); res.end('{}');
    });
  });
  server.requestTimeout = 5000;
  return { server, async start() { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(filename, resolve); }); fs.chmodSync(filename, 0o600); } };
}
module.exports = { SubmissionChannel, createSubmissionServer, consumeRootOutboxProof };
