// Main supplies the authenticated caller, the dedicated composer and its
// existing recorded forward route. This module never reads a Workspace
// snapshot, a terminal, a private conversation or a browser endpoint.
const { randomUUID } = require('node:crypto');
const { createComputerUseViewLease } = require('./native-computer-use.cjs');
const { outboxError, classifyOutboxFailure } = require('./computer-use-outbox-native.cjs');

const REFUSED = 'The authorized outbox is unavailable; no automatic resend.';
const token = value => typeof value === 'string' && value.length > 0 && value.length <= 160 && !/[\x00-\x1f\x7f]/.test(value);
const copy = value => JSON.parse(JSON.stringify(value));

async function openOutbox(verifiedGrant, { createView, forwardOnce, watchReceipt }) {
  const keys = ['callerId', 'callerNativeId', 'spaceId', 'recipientId', 'nativeId'];
  if (!verifiedGrant || !keys.every(k => token(verifiedGrant[k])) ||
      verifiedGrant.callerId === verifiedGrant.recipientId || !Number.isSafeInteger(verifiedGrant.memberRevision) ||
      verifiedGrant.memberRevision < 0 || typeof verifiedGrant.text !== 'string' || !verifiedGrant.text ||
      verifiedGrant.text.length > 16000 || !verifiedGrant.text.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(verifiedGrant.text) ||
      ![createView, forwardOnce, watchReceipt].every(f => typeof f === 'function')) throw Error(REFUSED);
  const grant = Object.freeze({ ...verifiedGrant }), requestId = randomUUID();
  const recipient = Object.freeze({ id: grant.recipientId,
    label: token(grant.recipientName) ? grant.recipientName : grant.recipientId });
  let view, lease, unsubscribe, closed = false, attempted = false, ready = false;
  let painting = Promise.resolve(), renderFailed = false;
  let status = 'draft', messageId = null, turnId = null, nativeReceived = false, firstCommand = null, failure;
  const waiters = new Set();
  const receipt = () => copy({ requestId, senderId: grant.callerId, senderNativeId: grant.callerNativeId, spaceId: grant.spaceId, recipient, text: grant.text, messageId,
    nativeId: grant.nativeId, turnId, status, nativeReceived, firstCommand, retry: false, ...failure });
  const terminal = () => ['working', 'command-failed', 'not-sent', 'unconfirmed', 'closed'].includes(status);
  const publish = () => {
    if (!closed) {
      const value = receipt();
      painting = painting.then(() => { if (!closed) return view?.showReceipt(value); }).catch(() => {
        renderFailed = true; lease?.close().catch(() => {});
      });
    }
    if (terminal()) for (const finish of [...waiters]) finish(receipt());
  };
  const inspect = async () => {
    const facts = await view.inspect();
    // A shared provider process or a model-supplied sender is not a caller
    // binding. Main rechecks the originating native call on every operation.
    if (closed || facts?.callerValid !== true || facts.callerId !== grant.callerId ||
        facts.callerNativeId !== grant.callerNativeId) return { closed: true };
    return facts;
  };
  const receive = event => {
    if (closed || !event || event.messageId !== messageId || event.recipientId !== grant.recipientId ||
        event.nativeId !== grant.nativeId || event.inputTag !== messageId ||
        !['codex-native', 'claude-native'].includes(event.source) || event.nativeReceived !== true ||
        !token(event.turnId) || turnId && turnId !== event.turnId) return;
    nativeReceived = true; turnId = event.turnId;
    const command = event.firstCommand;
    if (!firstCommand && command?.kind === 'commandExecution' && token(command.id) &&
        ['completed', 'failed'].includes(command.status) && Number.isSafeInteger(command.exitCode) &&
        command.inputTag === messageId && command.turnId === turnId &&
        typeof command.command === 'string' && command.command.length > 0 && command.command.length <= 4096 &&
        !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(command.command)) {
      firstCommand = { id: command.id, command: command.command, source: event.source, status: command.status, exitCode: command.exitCode };
    }
    if (firstCommand) failure = undefined;
    status = firstCommand ? firstCommand.status === 'completed' && firstCommand.exitCode === 0 ? 'working' : 'command-failed' : 'received'; publish();
  };
  async function sendOnce() {
    if (closed || !ready || attempted) throw Error(REFUSED);
    attempted = true; status = 'checking';
    let phase = 'view-send';
    try {
      const facts = await inspect();
      if (facts.closed || facts.owner !== view.owner || facts.spaceId !== grant.spaceId ||
          facts.nativeId !== grant.nativeId || facts.memberRevision !== grant.memberRevision ||
          facts.recipientId !== grant.recipientId || facts.body !== grant.text || facts.ready !== true) {
        failure = classifyOutboxFailure(null, phase, 'grant-invalidated');
        status = 'not-sent'; publish(); return receipt();
      }
      status = 'sending'; publish();
      // This is the sole send site. The callback must revalidate and use the
      // existing shared-message route, not stage another message first.
      const id = await forwardOnce({ ...grant, requestId });
      if (closed) return receipt();
      if (!token(id)) throw Error(REFUSED);
      messageId = id; status = 'delivery-unconfirmed'; publish();
      phase = 'native-receipt';
      // Subscribe with an atomic initial receipt plus future updates. A native
      // event may already have arrived while forwardOnce was awaiting its ACK.
      unsubscribe = await watchReceipt({ messageId, recipientId: grant.recipientId, nativeId: grant.nativeId }, receive);
      if (typeof unsubscribe !== 'function') throw Error(REFUSED);
      if (closed) { unsubscribe(); unsubscribe = null; }
    } catch (error) {
      if (status !== 'working') {
        failure = classifyOutboxFailure(error, phase, phase === 'view-send' ? 'send-unconfirmed' : 'receipt-unconfirmed');
        status = 'unconfirmed';
      }
      publish();
    }
    return receipt();
  }
  async function dispose() {
    if (closed) return;
    closed = true; ready = false;
    if (!terminal()) status = attempted ? 'unconfirmed' : 'closed';
    try { unsubscribe?.(); } finally { unsubscribe = null; publish(); await view.close(); }
  }
  let phase = 'view-open';
  try {
    // No caller credentials, global endpoint, session list or extra grant
    // fields cross into the new renderer, even if Main's input contains them.
    view = await createView(copy({ requestId, spaceId: grant.spaceId, recipient, text: grant.text }), { send: sendOnce });
    if (!view || !token(view.owner) || !['inspect', 'target', 'invoke', 'showReceipt', 'close'].every(k => typeof view[k] === 'function')) throw Error(REFUSED);
    phase = 'lease';
    lease = await createComputerUseViewLease({ grant: { ...grant, owner: view.owner },
      inspect, target: ref => view.target(ref), invoke: (name, args) => view.invoke(name, args), dispose });
    ready = true; publish();
    return { leaseFile: lease.leaseFile, receipt,
      async flush() { await painting; return renderFailed ? { ...receipt(), status: 'unconfirmed', renderFailed: true } : receipt(); },
      wait({ timeoutMs = 30000 } = {}) {
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw Error(REFUSED);
        if (terminal()) return Promise.resolve(receipt());
        return new Promise(resolve => {
          const finish = result => { clearTimeout(timer); waiters.delete(finish); resolve(result); };
          const timer = setTimeout(() => finish({ ...receipt(), status: 'unconfirmed', timedOut: true }), timeoutMs);
          waiters.add(finish);
        });
      }, close: () => lease.close() };
  } catch (error) {
    const detail = classifyOutboxFailure(error, phase, phase === 'view-open' ? 'view-unavailable' : 'lease-unavailable');
    try { if (lease) await lease.close(); else if (view?.close) await view.close(); }
    catch { throw outboxError(detail.failureReason, detail.failurePhase, REFUSED, true); }
    throw outboxError(detail.failureReason, detail.failurePhase, REFUSED, detail.cleanupUnconfirmed === true);
  }
}

module.exports = { openOutbox };
