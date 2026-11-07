const fs = require('node:fs'), path = require('node:path'), net = require('node:net'), crypto = require('node:crypto');
const { openOutbox } = require('./computer-use-outbox.cjs');
const { readViewLease } = require('./native-computer-use.cjs');
const { privateFile } = require('./computer-use-outbox-tool.cjs');
const { processIdentity, processMayBeAlive } = require('./platform.cjs');
const FAIL = { status: 'unconfirmed', retry: false, message: 'The authorized outbox could not confirm delivery; do not resend automatically.' };
async function operateOutbox(binding, createView, signal) {
  let box, socket, transport;
  const aborted = () => { box?.close().catch(() => {}); };
  signal.addEventListener('abort', aborted, { once: true });
  try {
    if (signal.aborted) return FAIL;
    box = await openOutbox(binding.grant, { ...binding,
      createView: (model, actions) => createView(model, actions, { inspectGrant: binding.inspectGrant }) });
    if (signal.aborted) return FAIL;
    const lease = readViewLease(box.leaseFile);
    const { JsonRpcLineTransport } = await import('@deepseek-ai/dsh-sdk-protocol');
    socket = net.connect(lease.socketPath); socket.on('error', () => {});
    transport = new JsonRpcLineTransport(socket, socket); transport.start();
    const call = (method, params) => transport.request(method, params, AbortSignal.any([signal, AbortSignal.timeout(20000)]));
    await call('initialize', { _meta: { nawViewCapability: lease.capability } });
    const snapshot = await call('tools/call', { name: 'browser_snapshot', arguments: {} });
    const observed = JSON.parse(snapshot.content[0].text);
    const buttons = [...observed.tree.matchAll(/button "发送" \[ref=(e\d+)\]/g)];
    if (buttons.length !== 1) return FAIL;
    // A single observed, uniquely identified send button in the leased view.
    await call('tools/call', { name: 'browser_click', arguments: { snapshot: observed.snapshot, target: buttons[0][1] } });
    const receipt = await box.wait({ timeoutMs: 60000 });
    const rendered = await box.flush();
    return rendered.renderFailed ? rendered : receipt;
  } finally {
    // Do not disconnect the lease until the receipt has been gathered: a
    // native tool ACK is not receipt, and socket close revokes this view.
    try { if (box) await box.close(); } finally { signal.removeEventListener('abort', aborted); transport?.close(); socket?.destroy(); binding.close(); }
  }
}
async function createOutboxBroker({ descriptorFile, bind, createView }) {
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
  const sockets = new Set(), operations = new Set(); let busy = false, closed = false, closing;
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('error', () => {});
    const abort = new AbortController(); let data = '', accepted = false;
    const timer = setTimeout(() => { abort.abort(); socket.destroy(); }, 100000);
    socket.on('close', () => { clearTimeout(timer); abort.abort(); sockets.delete(socket); });
    socket.setEncoding('utf8');
    socket.on('data', part => {
      if (accepted) { abort.abort(); socket.destroy(); return; }
      data += part; if (Buffer.byteLength(data) > 100000) { socket.destroy(); return; }
      const end = data.indexOf('\n'); if (end < 0) return;
      accepted = true;
      const operation = Promise.resolve().then(async () => {
        const request = JSON.parse(data.slice(0, end));
        if (closed || busy || Object.keys(request).sort().join(',') !== 'arguments,capability,identity' ||
            typeof request.capability !== 'string' || !/^[a-f0-9]{64}$/.test(request.capability) ||
            !crypto.timingSafeEqual(Buffer.from(capability), Buffer.from(request.capability))) return FAIL;
        busy = true;
        try { const binding = await bind(request.identity, request.arguments, abort.signal); return await operateOutbox(binding, createView, abort.signal); }
        finally { busy = false; }
      }).catch(() => FAIL).then(result => { if (!socket.destroyed) socket.end(JSON.stringify(result) + '\n'); });
      operations.add(operation); operation.finally(() => operations.delete(operation));
    });
  });
  let descriptorIdentity;
  const close = () => {
    if (closing) return closing;
    closed = true;
    closing = (async () => {
      for (const socket of sockets) socket.destroy();
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
    return { descriptorFile, close };
  } catch (error) { await close(); throw error; }
}
module.exports = { createOutboxBroker, operateOutbox };
