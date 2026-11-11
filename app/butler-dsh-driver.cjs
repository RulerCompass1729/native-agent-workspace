'use strict';
const fs = require('node:fs'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const { butlerBinding } = require('./butler-backend.cjs');
const binding = require('./service-binding.cjs');
const { lockIdentity, ownerMayBeAlive } = require('./service-lock.cjs');
const runner = require('./butler-runner.cjs');
const { encodedBatchBytes, MAX_BATCH_INPUT_BYTES } = require('./butler-dsh-input.cjs');
const failure = code => Object.assign(new Error(code === 'credential-missing'
  ? 'DEEPSEEK_API_KEY is missing from the butler launch environment.' : 'DSH butler: ' + code), { code });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function dshBinding(value) {
  const proof = butlerBinding(value);
  if (proof.profile !== 'deepseek-pro' || proof.provider !== 'deepseek' || proof.model !== 'deepseek-v4-pro') throw failure('binding-mismatch');
  return proof;
}
class ButlerDshDriver {
  constructor(directory, { executablePath = process.execPath, mcp = null, priceUsage = () => null, fixtureEndpoint = null } = {}) {
    if (!path.isAbsolute(directory) || !path.isAbsolute(executablePath) || typeof priceUsage !== 'function') throw failure('invalid-options');
    this.store = path.join(directory, 'store'); this.home = path.join(this.store, 'dsh-home');
    this.file = path.join(this.store, 'dsh-owner.json'); this.executablePath = executablePath;
    // These are trusted host dependencies, never accepted from model or UI JSON.
    this.mcp = mcp; this.priceUsage = priceUsage; this.child = null; this.proof = null;
    if (fixtureEndpoint !== null && (typeof fixtureEndpoint !== 'string' || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(fixtureEndpoint) || Number(new URL(fixtureEndpoint).port) > 65535)) throw failure('endpoint-invalid');
    this.fixtureEndpoint = fixtureEndpoint;
    this.nativeId = null; this.pending = new Map(); this.starting = null; this.active = false;
    this.closing = null; this.lastError = null; this.generation = 0; this.shuttingDown = false;
  }
  readOwner() {
    let fd;
    try {
      fd = fs.openSync(this.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const s = fs.fstatSync(fd);
      if (!s.isFile() || s.nlink !== 1 || s.uid !== process.getuid() || (s.mode & 0o777) !== 0o600 || s.size > 8192) throw failure('owner-unconfirmed');
      const value = JSON.parse(fs.readFileSync(fd, 'utf8'));
      if (value.format !== 1 || !value.token || !same(dshBinding(value.binding), value.binding)) throw failure('owner-unconfirmed');
      return { value, ino: s.ino, dev: s.dev };
    } catch (error) { if (error.code === 'ENOENT') return null; throw failure('owner-unconfirmed'); }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  removeOwner(owned) {
    const now = this.readOwner();
    if (!now) return;
    if (!owned || now.ino !== owned.ino || now.dev !== owned.dev || !same(now.value, owned.value)) throw failure('owner-unconfirmed');
    fs.unlinkSync(this.file);
  }
  async recover(value) {
    const proof = dshBinding(value), stored = binding.readBinding(this.store);
    if (stored) binding.assertBinding(stored, proof);
    else if (fs.readdirSync(this.store).length) throw failure('binding-mismatch');
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
      if (!this.nativeId) throw failure('start-unconfirmed');
      binding.assertBinding(this.proof, proof); return { status: 'present', binding: proof };
    }
    // Never attach to or replace an unknown old daemon/Codex store.
    if (['service.lock', 'services.lock', 'native-launch.json', 'connection.json'].some(n => fs.existsSync(path.join(this.store, n)))) throw failure('legacy-butler-store');
    const owner = this.readOwner();
    if (owner) {
      binding.assertBinding(owner.value.binding, proof);
      if (!owner.value.identity?.started || ownerMayBeAlive(owner.value.identity, this.store, 'service')) throw failure('owner-unconfirmed');
      this.removeOwner(owner);
    }
    return { status: 'absent' };
  }
  beginShutdown() { this.shuttingDown = true; ++this.generation; }
  start(value) {
    if (this.shuttingDown) return Promise.reject(failure('closing'));
    if (this.starting || this.closing) return Promise.reject(failure('backend-busy'));
    this.starting = this.launch(value, ++this.generation).finally(() => { this.starting = null; });
    return this.starting;
  }
  async launch(value, generation) {
    const proof = dshBinding(value);
    if (!runner.dshCredentialPresent()) throw failure('credential-missing');
    if (!this.mcp) throw failure('mcp-unavailable');
    const recovered = await this.recover(proof);
    if (generation !== this.generation) throw failure('closed');
    if (recovered.status === 'present') return { status: 'present', binding: proof };
    binding.reserveBinding(this.store, proof);
    const token = randomUUID();
    fs.writeFileSync(this.file, JSON.stringify({ format: 1, token, binding: proof, identity: null }), { flag: 'wx', mode: 0o600 });
    this.owned = this.readOwner();
    try {
      fs.mkdirSync(this.home, { recursive: true, mode: 0o700 });
      const stat = fs.lstatSync(this.home);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw failure('unsafe-home');
      const child = this.child = runner.spawnDshRunner(this.executablePath, this.home); this.proof = proof;
      let text = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        text += chunk;
        if (Buffer.byteLength(text) > 524288) { this.rejectPending('output-too-large'); this.close(); return; }
        let end;
        while ((end = text.indexOf('\n')) >= 0) {
          const line = text.slice(0, end); text = text.slice(end + 1);
          let message; try {
            message = JSON.parse(line);
            if (!message || typeof message !== 'object' || typeof message.id !== 'string' || (!Object.hasOwn(message, 'result') && !Object.hasOwn(message, 'error'))) throw Error('Invalid packet');
          } catch { this.rejectPending('protocol-invalid'); this.close(); return; }
          const call = this.pending.get(message.id);
          if (call) { clearTimeout(call.timer); this.pending.delete(message.id); message.error ? call.reject(failure(message.error.code)) : call.resolve(message.result); }
        }
      });
      child.on('error', () => this.rejectPending('host-unavailable'));
      child.stdin.on('error', () => this.rejectPending('host-unavailable'));
      child.on('exit', () => { this.nativeId = null; this.rejectPending('host-exited'); });
      const identity = lockIdentity(child.pid);
      if (!identity?.started) throw failure('owner-unconfirmed');
      fs.writeFileSync(this.file, JSON.stringify({ format: 1, token, binding: proof, identity }), { mode: 0o600 });
      this.owned = this.readOwner();
      const ready = await this.request('initialize', { mcp: this.mcp, fixtureEndpoint: this.fixtureEndpoint }, 10000);
      if (!ready || ready.pid !== child.pid || typeof ready.nativeId !== 'string' || ready.credentialPresent !== true || ready.privacyApplied !== true ||
          !Array.isArray(ready.tools) || !same([...ready.tools].sort(), [...new Set(this.mcp.tools)].sort())) throw failure('start-unconfirmed');
      this.nativeId = ready.nativeId; this.readyReceipt = ready;
      return { status: 'present', binding: proof };
    } catch (error) { await this.close(); throw error; }
  }
  rejectPending(code) {
    for (const call of this.pending.values()) { clearTimeout(call.timer); call.reject(failure(code)); }
    this.pending.clear();
  }
  request(method, value, timeout = 120000) {
    if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) return Promise.reject(failure('host-unavailable'));
    const id = randomUUID(), wire = JSON.stringify({ id, method, ...value });
    if (Buffer.byteLength(wire) > 262143) return Promise.reject(failure('input-too-large'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(failure('host-timeout')); this.close(); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(wire + '\n', error => { if (error) this.rejectPending('host-unavailable'); });
    });
  }
  async run(input, selection) {
    if (this.active) throw failure('busy');
    if (!selection?.identity || selection.identity.nativeId !== this.nativeId || selection.runnerRef !== this.proof?.runnerRef ||
        !Number.isSafeInteger(selection.selectionRevision) || typeof input?.batchId !== 'string' || !Number.isSafeInteger(input.attempt)) throw failure('selection-mismatch');
    if (encodedBatchBytes(input) > MAX_BATCH_INPUT_BYTES) throw failure('input-too-large');
    const expected = structuredClone(selection), batchId = input.batchId, attempt = input.attempt;
    this.active = true;
    try {
      const result = await this.request('run', { input, nativeId: this.nativeId });
      if (result.nativeId !== expected.identity.nativeId) throw failure('selection-mismatch');
      if (result.usage && result.usageComplete && result.completed && !result.failureCode && result.usage.tokensComplete === true && result.requestCount === result.settledUsageRows) {
        let cost = null;
        try { const value = this.priceUsage(structuredClone(result.usage)); if (Number.isSafeInteger(value) && value >= 0) cost = value; } catch {}
        // Unknown pricing cannot discard already measured tokens or become $0.
        result.usage.costMicros = cost; result.usage.estimated = cost !== null;
      }
      return { batchId, attempt, selection: expected, reply: result.reply, usage: result.usage, readBudget: result.readBudget, failureCode: result.failureCode || null };
    } finally { this.active = false; }
  }
  async rotate() {
    if (this.active) throw failure('busy');
    const next = await this.request('rotate', {}, 10000);
    if (typeof next.nativeId !== 'string' || next.nativeId === this.nativeId) throw failure('rotation-unconfirmed');
    this.nativeId = next.nativeId; return { nativeId: this.nativeId };
  }
  close() {
    ++this.generation; // Invalidate a start that has not spawned its child yet.
    if (!this.closing) this.closing = this.stop().then(() => ({ stopped: true, cleanupConfirmed: true }), () => {
      this.lastError = 'owner-unconfirmed';
      return { stopped: !this.child || this.child.exitCode !== null || this.child.signalCode !== null, cleanupConfirmed: false, errorCode: this.lastError };
    }).finally(() => { this.closing = null; });
    return this.closing;
  }
  async stop() {
    const child = this.child;
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      await new Promise(resolve => {
        const kill = () => { if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } };
        const timer = setTimeout(kill, 3000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        child.stdin.end(JSON.stringify({ method: 'close' }) + '\n');
      });
    }
    this.rejectPending('closed'); this.child = null; this.nativeId = null;
    if (this.owned) { this.removeOwner(this.owned); this.owned = null; }
  }
}
module.exports = { ButlerDshDriver, credentialPresent: runner.dshCredentialPresent };
