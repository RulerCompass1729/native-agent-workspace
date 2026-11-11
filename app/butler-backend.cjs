'use strict';

// Dedicated backend reservation only. This module does not start NativeHost,
// select the ordinary active service, or claim that Codex's tool/context gates
// are available. A future trusted local driver must prove all four boundaries.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const FLAGS = ['tools', 'context', 'provider', 's2'];
const STATUSES = ['prepared', 'qualifying', 'blocked', 'recovering', 'starting', 'ready', 'failed', 'unknown'];
const REASONS = ['runtime-unqualified', 'credential-missing', 'credential-presence-invalid', 'qualification-invalid',
  ...FLAGS.map(name => `${name}-unqualified`), 'driver-unavailable', 'backend-busy', 'owner-unconfirmed',
  'recover-failed', 'liveness-unconfirmed', 'start-failed', 'start-unconfirmed', 'binding-mismatch', 'recovery-required'];
const BINDING_KEYS = ['purpose', 'profile', 'provider', 'model', 'runtimeVersion', 'backendRef', 'runnerRef', 'store', 'startNonce'];
const RECORD_KEYS = ['format', 'binding', 'status', 'blocked', 'credentialPresent', 'qualification', 'operation', 'createdAt', 'updatedAt'];
const fixed = { purpose: 'butler', profile: 'deepseek-pro', provider: 'deepseek', model: 'deepseek-v4-pro', store: 'store' };
const emptyQualification = () => Object.fromEntries(FLAGS.map(name => [name, false]));
const isName = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,119}$/.test(value);
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function failure(code) { return Object.assign(new Error(`Butler backend: ${code}`), { code }); }
function binding(value) {
  if (!exactKeys(value, BINDING_KEYS) || BINDING_KEYS.some(key => !isName(value[key])) ||
      Object.entries(fixed).some(([key, expected]) => value[key] !== expected) ||
      !value.backendRef.startsWith('butler-backend:') || !value.runnerRef.startsWith('butler-runner:')) throw failure('binding-mismatch');
  return Object.fromEntries(BINDING_KEYS.map(key => [key, value[key]]));
}
function publicBinding(value) {
  return Object.fromEntries(['runnerRef', 'backendRef', 'purpose', 'profile', 'provider', 'model', 'runtimeVersion'].map(key => [key, value[key]]));
}
function qualification(value) {
  return exactKeys(value, FLAGS) && FLAGS.every(key => typeof value[key] === 'boolean')
    ? Object.fromEntries(FLAGS.map(key => [key, value[key]])) : null;
}
function record(value) {
  if (!exactKeys(value, RECORD_KEYS) || value.format !== 1 || !STATUSES.includes(value.status) ||
      !Array.isArray(value.blocked) || value.blocked.some(reason => !REASONS.includes(reason)) ||
      new Set(value.blocked).size !== value.blocked.length ||
      ![null, true, false].includes(value.credentialPresent) || !qualification(value.qualification) ||
      !Number.isSafeInteger(value.createdAt) || value.createdAt < 0 || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < value.createdAt ||
      value.operation !== null && (!exactKeys(value.operation, ['id', 'pid']) || !isName(value.operation.id) ||
        !Number.isSafeInteger(value.operation.pid) || value.operation.pid < 1 || value.operation.pid > 2147483647)) throw failure('state-invalid');
  const normalized = { ...value, binding: binding(value.binding), qualification: qualification(value.qualification) };
  if (value.status === 'ready' && (value.operation !== null || value.credentialPresent !== true ||
      !FLAGS.every(key => value.qualification[key] === true) || value.blocked.length)) throw failure('state-invalid');
  return normalized;
}
function privateFile(stat) {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o600;
}
function ownerAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'ESRCH' ? false : null; }
}

class ButlerBackend {
  constructor(directory, { driver, credentialPresent = () => false, qualify = () => emptyQualification(),
    runtimeVersion = 'unknown', now = Date.now, id = randomUUID } = {}) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory) || !isName(runtimeVersion) ||
        ![credentialPresent, qualify, now, id].every(value => typeof value === 'function')) throw failure('invalid-options');
    this.directory = path.resolve(directory);
    this.file = path.join(this.directory, 'backend.json');
    this.lockFile = path.join(this.directory, 'backend.lock');
    this.store = path.join(this.directory, fixed.store);
    this.driver = driver; this.credentialPresent = credentialPresent; this.qualify = qualify;
    this.runtimeVersion = runtimeVersion; this.now = now; this.id = id;
    this.flight = null; this.confirmed = null;
  }
  _id() { const value = this.id(); if (!isName(value)) throw failure('invalid-id'); return value; }
  _time() { const value = this.now(); if (!Number.isSafeInteger(value) || value < 0) throw failure('invalid-time'); return value; }
  _directory(create = false) {
    if (create) try { fs.mkdirSync(this.directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw failure('directory-unavailable'); }
    let stat;
    try { stat = fs.lstatSync(this.directory); } catch (error) { if (!create && error.code === 'ENOENT') return null; throw failure('directory-unavailable'); }
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) throw failure('unsafe-directory');
    return stat;
  }
  _store(create = false) {
    if (create) try { fs.mkdirSync(this.store, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw failure('store-unavailable'); }
    let stat;
    try { stat = fs.lstatSync(this.store); } catch { throw failure('store-unavailable'); }
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) throw failure('unsafe-store');
  }
  _read() {
    if (!this._directory()) return null;
    let fd;
    try {
      fd = fs.openSync(this.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const opened = fs.fstatSync(fd), current = fs.lstatSync(this.file);
      if (!privateFile(opened) || !privateFile(current) || opened.dev !== current.dev || opened.ino !== current.ino || opened.size > 8192) throw failure('unsafe-record');
      let value;
      try { value = record(JSON.parse(fs.readFileSync(fd, 'utf8'))); } catch { throw failure('state-invalid'); }
      this._store();
      return value;
    } catch (error) {
      if (fd === undefined && error.code === 'ENOENT') return null;
      if (REASONS.includes(error.code) || ['unsafe-record', 'state-invalid', 'unsafe-store', 'store-unavailable'].includes(error.code)) throw error;
      throw failure('unsafe-record');
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  _unlinkOwn(file, owned) {
    let current;
    try { current = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return; throw failure('cleanup-unconfirmed'); }
    if (!privateFile(current) || current.dev !== owned.dev || current.ino !== owned.ino) throw failure('cleanup-unconfirmed');
    fs.unlinkSync(file);
  }
  _locked(action) {
    const directory = this._directory(true);
    let fd, owned;
    try {
      fd = fs.openSync(this.lockFile, 'wx', 0o600); owned = fs.fstatSync(fd);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, id: this._id() })); fs.fsyncSync(fd);
      const current = this._directory();
      if (directory.dev !== current.dev || directory.ino !== current.ino || !privateFile(owned)) throw failure('unsafe-directory');
      return action();
    } catch (error) {
      if (fd === undefined && error.code === 'EEXIST') throw failure('backend-busy');
      throw error;
    } finally {
      if (fd !== undefined) { fs.closeSync(fd); this._unlinkOwn(this.lockFile, owned); }
    }
  }
  _write(next, expected) {
    record(next);
    const directory = this._directory();
    if (!same(this._read(), expected)) throw failure('state-changed');
    const temp = `${this.file}.${this._id()}.tmp`;
    let fd, owned;
    try {
      fd = fs.openSync(temp, 'wx', 0o600); owned = fs.fstatSync(fd);
      fs.writeFileSync(fd, JSON.stringify(next)); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      const current = this._directory();
      if (directory.dev !== current.dev || directory.ino !== current.ino || !same(this._read(), expected)) throw failure('state-changed');
      fs.renameSync(temp, this.file);
      const dir = fs.openSync(this.directory, 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (owned) this._unlinkOwn(temp, owned);
    }
  }
  _prepare() {
    const previous = this._read();
    if (previous) {
      if (previous.binding.runtimeVersion !== this.runtimeVersion) throw failure('binding-mismatch');
      return previous;
    }
    this._store(true);
    if (fs.readdirSync(this.store).length) throw failure('unowned-store');
    const time = this._time();
    const value = { format: 1, binding: binding({ ...fixed, runtimeVersion: this.runtimeVersion,
      backendRef: `butler-backend:${this._id()}`, runnerRef: `butler-runner:${this._id()}`, startNonce: this._id() }),
    status: 'prepared', blocked: [], credentialPresent: null, qualification: emptyQualification(), operation: null, createdAt: time, updatedAt: time };
    this._write(value, null);
    return value;
  }
  _snapshot(value) {
    if (!value) return { prepared: false, binding: null, state: 'unprepared', ready: false, credentialPresent: false,
      credentialChecked: false, qualified: false, blocked: ['recovery-required'] };
    const ready = value.status === 'ready' && this.confirmed === JSON.stringify(value.binding);
    const recovery = value.status === 'ready' && !ready;
    return { prepared: true, binding: publicBinding(value.binding), state: recovery ? 'unconfirmed' : value.status, ready,
      credentialPresent: value.credentialPresent === true, credentialChecked: value.credentialPresent !== null,
      qualified: FLAGS.every(key => value.qualification[key]), blocked: recovery ? ['recovery-required'] : [...value.blocked] };
  }
  read() { const value = this._read(); return value ? this._snapshot(value) : null; }
  snapshot() { return this._snapshot(this._read()); }
  prepare() { return this._locked(() => this._snapshot(this._prepare())); }
  ensure() {
    if (!this.flight) this.flight = Promise.resolve().then(() => this._ensure()).finally(() => { this.flight = null; });
    return this.flight;
  }
  _change(owned, changes) {
    return this._locked(() => {
      const previous = this._read();
      if (!previous || !same(previous.binding, owned.binding) || !same(previous.operation, owned.operation)) throw failure('state-changed');
      const next = { ...previous, ...changes, updatedAt: Math.max(previous.updatedAt, this._time()) };
      this._write(next, previous); return next;
    });
  }
  _finish(owned, state, blocked, presence, qualified) {
    const next = this._change(owned, { status: state, blocked, credentialPresent: presence, qualification: qualified, operation: null });
    this.confirmed = state === 'ready' ? JSON.stringify(next.binding) : null;
    return state === 'ready' ? { ready: true, binding: publicBinding(next.binding) } : { ready: false, blocked: [...blocked] };
  }
  async _ensure() {
    this.confirmed = null;
    let owned;
    try {
      owned = this._locked(() => {
        const previous = this._prepare();
        if (previous.operation) {
          const alive = ownerAlive(previous.operation.pid);
          if (alive !== false) return { denied: alive ? 'backend-busy' : 'owner-unconfirmed' };
        }
        const next = { ...previous, status: 'qualifying', blocked: [], operation: { id: this._id(), pid: process.pid }, updatedAt: Math.max(previous.updatedAt, this._time()) };
        this._write(next, previous); return next;
      });
    } catch (error) {
      if (error.code === 'backend-busy') return { ready: false, blocked: ['backend-busy'] };
      throw error;
    }
    if (owned.denied) return { ready: false, blocked: [owned.denied] };
    const proof = Object.freeze({ ...owned.binding });
    let presence = null, qualified = emptyQualification(), invalidQualification = false;
    try { const value = await this.credentialPresent(); if (typeof value === 'boolean') presence = value; } catch { /* Presence stays unknown; no error text is persisted. */ }
    try { const value = qualification(await this.qualify(proof)); if (value) qualified = value; else invalidQualification = true; }
    catch { invalidQualification = true; }
    const blocked = [
      ...(this.runtimeVersion === 'unknown' ? ['runtime-unqualified'] : []),
      ...(presence === null ? ['credential-presence-invalid'] : presence ? [] : ['credential-missing']),
      ...(invalidQualification ? ['qualification-invalid'] : []),
      ...FLAGS.filter(key => qualified[key] !== true).map(key => `${key}-unqualified`),
    ];
    if (blocked.length) return this._finish(owned, 'blocked', blocked, presence, qualified);
    if (!this.driver || typeof this.driver.recover !== 'function' || typeof this.driver.start !== 'function') return this._finish(owned, 'blocked', ['driver-unavailable'], presence, qualified);
    this._change(owned, { status: 'recovering', credentialPresent: presence, qualification: qualified });
    let recovered;
    try { recovered = await this.driver.recover(proof); } catch { return this._finish(owned, 'failed', ['recover-failed'], presence, qualified); }
    if (!exactKeys(recovered, recovered?.status === 'present' ? ['status', 'binding'] : ['status']) || !['present', 'absent'].includes(recovered.status)) return this._finish(owned, 'unknown', ['liveness-unconfirmed'], presence, qualified);
    if (recovered.status === 'present') {
      let matching = false; try { matching = same(binding(recovered.binding), owned.binding); } catch {}
      if (!matching) { this._finish(owned, 'failed', ['binding-mismatch'], presence, qualified); throw failure('binding-mismatch'); }
      return this._finish(owned, 'ready', [], presence, qualified);
    }
    this._change(owned, { status: 'starting' });
    let started;
    try { started = await this.driver.start(proof); } catch { return this._finish(owned, 'failed', ['start-failed'], presence, qualified); }
    let matching = false;
    try { matching = exactKeys(started, ['status', 'binding']) && started.status === 'present' && same(binding(started.binding), owned.binding); } catch {}
    if (!matching) { this._finish(owned, 'failed', ['start-unconfirmed'], presence, qualified); return { ready: false, blocked: ['start-unconfirmed'] }; }
    return this._finish(owned, 'ready', [], presence, qualified);
  }
}

module.exports = { ButlerBackend };
