const fs = require('node:fs'), path = require('node:path'), net = require('node:net'), crypto = require('node:crypto');
const { openOutbox } = require('./computer-use-outbox.cjs');
const { readViewLease } = require('./native-computer-use.cjs');
const { privateFile } = require('./computer-use-outbox-tool.cjs');
const { processIdentity, processMayBeAlive } = require('./platform.cjs');
const { outboxError, classifyOutboxFailure } = require('./computer-use-outbox-native.cjs');
const FAIL = { status: 'unconfirmed', retry: false, message: 'The authorized outbox could not confirm delivery; do not resend automatically.' };
const failed = (phase, reason, error) => ({ ...FAIL, ...classifyOutboxFailure(error, phase, reason) });
async function operateOutbox(binding, createView, signal) {
  let box, socket, transport, phase = 'view-open', primary;
  const aborted = () => { box?.close().catch(() => {}); };
  signal.addEventListener('abort', aborted, { once: true });
  try {
    if (signal.aborted) { primary = classifyOutboxFailure(null, phase, 'cancelled'); return { ...FAIL, ...primary }; }
    box = await openOutbox(binding.grant, { ...binding,
      createView: (model, actions) => createView(model, actions, { inspectGrant: binding.inspectGrant }) });
    if (signal.aborted) { primary = classifyOutboxFailure(null, phase, 'cancelled'); return { ...FAIL, ...primary }; }
    phase = 'lease';
    const lease = readViewLease(box.leaseFile);
    const { JsonRpcLineTransport } = await import('@deepseek-ai/dsh-sdk-protocol');
    socket = net.connect(lease.socketPath); socket.on('error', () => {});
    transport = new JsonRpcLineTransport(socket, socket); transport.start();
    const call = (method, params) => transport.request(method, params, AbortSignal.any([signal, AbortSignal.timeout(20000)]));
    await call('initialize', { _meta: { nawViewCapability: lease.capability } });
    phase = 'view-snapshot';
    const snapshot = await call('tools/call', { name: 'browser_snapshot', arguments: {} });
    const observed = JSON.parse(snapshot.content[0].text);
    const buttons = [...observed.tree.matchAll(/button "发送" \[ref=(e\d+)\]/g)];
    if (buttons.length !== 1) { primary = classifyOutboxFailure(null, phase, 'ambiguous-target'); return { ...FAIL, ...primary }; }
    // A single observed, uniquely identified send button in the leased view.
    phase = 'view-send';
    await call('tools/call', { name: 'browser_click', arguments: { snapshot: observed.snapshot, target: buttons[0][1] } });
    phase = 'native-receipt';
    const receipt = await box.wait({ timeoutMs: 60000 });
    phase = 'receipt-render';
    const rendered = await box.flush();
    const result = rendered.renderFailed ? rendered : receipt;
    if (result.status === 'working') return result;
    primary = result.failurePhase ? classifyOutboxFailure(outboxError(result.failureReason, result.failurePhase, undefined, result.cleanupUnconfirmed === true), phase, 'operation-unconfirmed')
      : classifyOutboxFailure(null, rendered.renderFailed ? phase : result.messageId ? 'native-receipt' : 'view-send', rendered.renderFailed ? 'render-unconfirmed'
        : !result.messageId ? 'send-unconfirmed' : result.status === 'command-failed' ? 'command-failed' : result.nativeReceived ? 'command-unconfirmed' : 'receipt-unconfirmed');
    return { ...result, ...primary };
  } catch (error) {
    primary = classifyOutboxFailure(error, phase, signal.aborted ? 'cancelled'
      : ({ 'view-open': 'view-unavailable', lease: 'lease-unavailable', 'view-snapshot': 'snapshot-unavailable',
        'view-send': 'send-unconfirmed', 'native-receipt': 'receipt-unconfirmed', 'receipt-render': 'render-unconfirmed' })[phase]);
    throw outboxError(primary.failureReason, primary.failurePhase, undefined, primary.cleanupUnconfirmed === true);
  } finally {
    // Do not disconnect the lease until the receipt has been gathered: a
    // native tool ACK is not receipt, and socket close revokes this view.
    try {
      try { if (box) await box.close(); } finally { signal.removeEventListener('abort', aborted); transport?.close(); socket?.destroy(); await binding.close(); }
    } catch {
      throw outboxError(primary?.failureReason || 'cleanup-unconfirmed', primary?.failurePhase || 'cleanup', undefined, true);
    }
  }
}
async function createOutboxBroker({ descriptorFile, bind, createView, bindControl, control }) {
  if (!path.isAbsolute(descriptorFile) || ![bind, createView].every(f => typeof f === 'function')) throw Error('Outbox owner unavailable');
  const issuer = processIdentity(process.pid);
  if (!issuer) throw Error('Outbox process identity unavailable');
  let previous;
  try { previous = fs.lstatSync(descriptorFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous) {
    const old = privateFile(descriptorFile);
    if (!Number.isSafeInteger(old.issuer?.pid) || old.issuer.pid < 2 || typeof old.issuer.started !== 'string' || !old.issuer.started ||
        processMayBeAlive(old.issuer) || typeof old.socketPath !== 'string' || !path.isAbsolute(old.socketPath)) throw Error('An outbox owner already exists');
    const absent = await new Promise(resolve => {
      const probe = net.connect(old.socketPath), done = value => { probe.destroy(); resolve(value); };
      probe.once('connect', () => done(false)); probe.once('error', error => done(['ENOENT', 'ECONNREFUSED'].includes(error.code))); probe.setTimeout(500, () => done(false));
    });
    const current = fs.lstatSync(descriptorFile);
    if (!absent || current.ino !== previous.ino || current.dev !== previous.dev || JSON.stringify(privateFile(descriptorFile)) !== JSON.stringify(old)) throw Error('Outbox owner changed');
    // Only the stale descriptor is ours to replace. Do not remove another
    // process's old directory or terminate any retained native/browser child.
    fs.unlinkSync(descriptorFile);
  }
  const dir = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'naw-outbox-owner-')); fs.chmodSync(dir, 0o700);
  const socketPath = path.join(dir, 'outbox.sock'), capability = crypto.randomBytes(32).toString('hex');
  const sockets = new Set(), operations = new Set(), controllers = new Set(); let busy = false, closed = false, closing;
  const submitControlAuthenticated = (factory, signal) => {
    if (closed || signal?.aborted || typeof factory !== 'function' || typeof control !== 'function' || controllers.size >= 32)
      return Promise.resolve({ state: 'not-executed', reason: 'background-control-unavailable', retry: false });
    const abort = new AbortController(), cancelled = () => abort.abort();
    signal?.addEventListener('abort', cancelled, { once: true }); controllers.add(abort);
    const job = Promise.resolve().then(async () => {
      let binding;
      try { binding = await factory(abort.signal); return await control(binding, binding.args); }
      finally { await binding?.close?.(); }
    }).catch(error => ({ state: 'unconfirmed', error: error.message, retry: false })).finally(() => {
      signal?.removeEventListener('abort', cancelled); controllers.delete(abort); operations.delete(job);
    });
    operations.add(job); return job;
  };
  const submitAuthenticated = (factory, signal) => {
    if (closed || busy || signal?.aborted || typeof factory !== 'function') return Promise.resolve(failed('admission',
      closed ? 'owner-closed' : busy ? 'busy' : signal?.aborted ? 'cancelled' : 'invalid-request'));
    busy = true;
    const abort = new AbortController(), cancelled = () => abort.abort();
    const timer = setTimeout(cancelled, 100000);
    signal?.addEventListener('abort', cancelled, { once: true }); controllers.add(abort);
    const operation = Promise.resolve().then(async () => {
      if (abort.signal.aborted) return failed('admission', 'cancelled');
      const binding = await factory(abort.signal);
      return operateOutbox(binding, createView, abort.signal);
    }).catch(error => failed('binding', abort.signal.aborted ? 'cancelled' : 'binding-unavailable', error)).finally(() => {
      clearTimeout(timer); signal?.removeEventListener('abort', cancelled); controllers.delete(abort); operations.delete(operation); busy = false;
    });
    operations.add(operation); return operation;
  };
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('error', () => {});
    const abort = new AbortController(); let data = '', accepted = false;
    const timer = setTimeout(() => { abort.abort(); socket.destroy(); }, 100000);
    socket.on('close', () => { clearTimeout(timer); abort.abort(); sockets.delete(socket); });
    socket.setEncoding('utf8');
    socket.on('data', part => {
      if (accepted) { abort.abort(); socket.destroy(); return; }
      data += part; if (Buffer.byteLength(data) > 140000) { socket.destroy(); return; }
      const end = data.indexOf('\n'); if (end < 0) return;
      accepted = true;
      const operation = Promise.resolve().then(async () => {
        const request = JSON.parse(data.slice(0, end));
        const background = request.kind === 'control';
        if (Object.keys(request).sort().join(',') !== (background ? 'arguments,capability,identity,kind' : 'arguments,capability,identity') ||
            typeof request.capability !== 'string' || !/^[a-f0-9]{64}$/.test(request.capability) ||
            !crypto.timingSafeEqual(Buffer.from(capability), Buffer.from(request.capability))) return failed('admission', 'invalid-request');
        if (background) {
          if (typeof bindControl !== 'function') return { state: 'not-executed', reason: 'background-control-unavailable', retry: false };
          return submitControlAuthenticated(signal => bindControl(request.identity, request.arguments, signal), abort.signal);
        }
        if (closed || busy) return failed('admission', closed ? 'owner-closed' : 'busy');
        return submitAuthenticated(signal => bind(request.identity, request.arguments, signal), abort.signal);
      }).catch(() => failed('admission', 'invalid-request')).then(result => { if (!socket.destroyed) socket.end(JSON.stringify(result) + '\n'); });
      operations.add(operation); operation.finally(() => operations.delete(operation));
    });
  });
  let descriptorIdentity;
  const close = () => {
    if (closing) return closing;
    closed = true;
    closing = (async () => {
      for (const socket of sockets) socket.destroy();
      for (const controller of controllers) controller.abort();
      await new Promise(resolve => server.close(resolve));
      await Promise.allSettled([...operations]);
      if (descriptorIdentity) {
        const current = fs.lstatSync(descriptorFile);
        if (current.ino === descriptorIdentity.ino && current.dev === descriptorIdentity.dev) fs.unlinkSync(descriptorFile);
      }
      fs.rmSync(dir, { recursive: true });
    })();
    closing.catch(() => {}); return closing;
  };
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    fs.chmodSync(socketPath, 0o600);
    // Exclusive descriptor: an occupied owner must never be replaced silently.
    fs.writeFileSync(descriptorFile, JSON.stringify({ version: 1, socketPath, capability, issuer }), { flag: 'wx', mode: 0o600 });
    descriptorIdentity = fs.lstatSync(descriptorFile);
    // How many requests are under way: background windows are not closed while any is.
    return { descriptorFile, close, submitAuthenticated, submitControlAuthenticated, active: () => operations.size };
  } catch (error) { await close(); throw error; }
}
module.exports = { createOutboxBroker, operateOutbox };
