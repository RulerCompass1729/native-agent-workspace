// Private mobile authority only. Importing this module starts no transport or native work.
const fs = require('node:fs'), path = require('node:path');
const { randomBytes, randomUUID, createHash, timingSafeEqual } = require('node:crypto');
const { TextDecoder } = require('node:util');
const { processIdentity, processMayBeAlive } = require('./platform.cjs');
const FILE = 'mobile-authority.json', OFF = 'mobile-disabled';
const PAIR_MS = 120000, SESSION_MS = 12 * 60 * 60 * 1000, MAX_BYTES = 256 * 1024;
const actions = new Set(['read', 'send', 'answer']);
const hash = value => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const text = (s, max = 512) => typeof s === 'string' && s.length > 0 && s.length <= max && !/[\u0000-\u001f\u007f-\u009f]/u.test(s);
const uuid = s => typeof s === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(s);
const digest = s => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
const token = s => typeof s === 'string' && /^[A-Za-z0-9_-]{43}$/.test(s);
const exact = (o, keys) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).length === keys.length && keys.every(k => Object.hasOwn(o, k));
const denied = (code = 'MOBILE_DENIED') => Object.assign(Error('手机授权未确认或已变化，请重新连接。'), { code });
function origin(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && value === u.origin; } catch { return false; }
}
function sameDigest(a, b) { return digest(a) && digest(b) && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex')); }
function sameIssuer(a, b) { return a?.pid === b?.pid && a?.started === b?.started && a?.instance === b?.instance; }
function issuerAlive(issuer) { const now = processIdentity(issuer?.pid); return Boolean(now && now.started === issuer.started); }
function rootPath(root, io) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw denied();
  const resolved = io.realpathSync(root), stat = io.lstatSync(resolved);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o022)) throw denied();
  return resolved;
}
function privateFile(stat) { return stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid() && !(stat.mode & 0o077); }
function sameFile(a, b) { return ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(k => a[k] === b[k]); }
function disabled(root, io) {
  try { io.lstatSync(path.join(root, OFF)); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}
function validScopes(scopes) {
  if (!Array.isArray(scopes)) return false;
  const seen = new Set();
  return scopes.every(s => {
    if (!exact(s, ['serviceKey', 'sessionId', 'nativeId', 'actions']) || !['serviceKey', 'sessionId', 'nativeId'].every(k => text(s[k])) ||
      !Array.isArray(s.actions) || !s.actions.length || s.actions.some(a => !actions.has(a)) || new Set(s.actions).size !== s.actions.length) return false;
    const key = JSON.stringify([s.serviceKey, s.sessionId]); if (seen.has(key)) return false; seen.add(key); return true;
  });
}
function validState(s) {
  if (!exact(s, ['version', 'issuer', 'generation', 'enabled', 'actor', 'origin', 'scopes', 'pairing', 'device']) || s.version !== 1 ||
    !exact(s.issuer, ['pid', 'started', 'instance']) || !Number.isSafeInteger(s.issuer.pid) || s.issuer.pid < 2 || !text(s.issuer.started) || !uuid(s.issuer.instance) ||
    !uuid(s.generation) || typeof s.enabled !== 'boolean' || !validScopes(s.scopes)) return false;
  if (s.actor === null || s.origin === null) {
    if (s.actor !== null || s.origin !== null || s.scopes.length || s.enabled || s.pairing !== null || s.device !== null) return false;
  } else if (!text(s.actor, 320) || !origin(s.origin) || !s.scopes.length) return false;
  if (s.pairing !== null && (!exact(s.pairing, ['hash', 'until']) || !digest(s.pairing.hash) || !Number.isSafeInteger(s.pairing.until) || s.pairing.until < 0)) return false;
  if (s.device !== null && (!exact(s.device, ['id', 'tokenHash', 'csrfHash', 'until']) || !uuid(s.device.id) ||
    !digest(s.device.tokenHash) || !digest(s.device.csrfHash) || !Number.isSafeInteger(s.device.until) || s.device.until < 0)) return false;
  return s.enabled ? s.device !== null && s.pairing === null : s.device === null;
}
function readState(root, { io = fs, allowDisabled = false } = {}) {
  let fd;
  try {
    root = rootPath(root, io);
    if (!allowDisabled && disabled(root, io)) throw denied();
    if (fs.constants.O_NOFOLLOW === undefined) throw denied();
    const file = path.join(root, FILE);
    fd = io.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const before = io.fstatSync(fd);
    if (!privateFile(before) || before.size > MAX_BYTES) throw denied();
    const bytes = io.readFileSync(fd); if (bytes.length > MAX_BYTES) throw denied();
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), after = io.lstatSync(file);
    if (!privateFile(after) || !sameFile(before, after) || !validState(value) || !allowDisabled && disabled(root, io)) throw denied();
    return value;
  } catch { throw denied(); } finally { if (fd !== undefined) io.closeSync(fd); }
}
function activeState(root, { io = fs, now = Date.now, alive = issuerAlive } = {}) {
  const s = readState(root, { io }), time = now();
  if (!Number.isSafeInteger(time) || time < 0 || !s.enabled || !s.device || s.device.until <= time || alive(s.issuer) !== true) throw denied();
  return s;
}
function scopeOf(s, target, action) {
  if (!actions.has(action) || !exact(target, ['serviceKey', 'sessionId', 'nativeId'])) throw denied();
  const found = s.scopes.find(x => x.serviceKey === target.serviceKey && x.sessionId === target.sessionId && x.nativeId === target.nativeId && x.actions.includes(action));
  if (!found) throw denied(); return found;
}
// Backend callers derive root and target from their own Workspace/route, never from phone JSON.
function verifyTicket(root, ticket, target, expectedAction, options) {
  if (!exact(ticket, ['issuer', 'generation', 'deviceId', 'tokenHash', 'action', 'serviceKey', 'sessionId', 'nativeId']) ||
    !actions.has(expectedAction) || ticket.action !== expectedAction || !target || target.nativeContextPending ||
    !['serviceKey', 'sessionId', 'nativeId'].every(k => ticket[k] === target[k])) throw denied();
  const s = activeState(root, options);
  if (!sameIssuer(ticket.issuer, s.issuer) || ticket.generation !== s.generation || ticket.deviceId !== s.device.id || !sameDigest(ticket.tokenHash, s.device.tokenHash)) throw denied();
  scopeOf(s, { serviceKey: target.serviceKey, sessionId: target.sessionId, nativeId: target.nativeId }, ticket.action);
  return true;
}
class MobileAccess {
  constructor(root, { io = fs, now = Date.now, identity = processIdentity(process.pid), exclusive } = {}) {
    if (!identity || !Number.isSafeInteger(identity.pid) || identity.pid < 2 || !text(identity.started) || typeof exclusive !== 'function') throw denied();
    this.io = io; this.now = now; this.root = rootPath(root, io); this.exclusive = exclusive;
    this.issuer = { ...identity, instance: randomUUID() }; this.closed = true; this.initialized = false;
    this.failures = { since: 0, count: 0 };
  }
  owner() { if (this.exclusive() !== true) throw denied(); }
  time() { const t = this.now(); if (!Number.isSafeInteger(t) || t < 0 || t > Number.MAX_SAFE_INTEGER - SESSION_MS) throw denied(); return t; }
  load() {
    this.owner(); if (!this.initialized) throw denied();
    const s = readState(this.root, { io: this.io, allowDisabled: true }); if (!sameIssuer(s.issuer, this.issuer)) throw denied(); return s;
  }
  save(s) {
    this.owner(); if (!validState(s)) throw denied();
    const data = JSON.stringify(s); if (Buffer.byteLength(data) > MAX_BYTES) throw denied('MOBILE_SCOPE_TOO_LARGE');
    const file = path.join(this.root, FILE), temp = file + '.' + randomUUID() + '.tmp'; let fd, own;
    try {
      try { if (!privateFile(this.io.lstatSync(file))) throw denied(); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      fd = this.io.openSync(temp, 'wx', 0o600); own = this.io.fstatSync(fd); this.io.writeFileSync(fd, data, 'utf8');
      this.io.closeSync(fd); fd = undefined; this.io.renameSync(temp, file);
    } finally {
      if (fd !== undefined) this.io.closeSync(fd);
      try { const stat = this.io.lstatSync(temp); if (own && stat.dev === own.dev && stat.ino === own.ino && privateFile(stat)) this.io.unlinkSync(temp); } catch { /* Only our temporary file is eligible for cleanup. */ }
    }
  }
  invalidate() {
    this.closed = true;
    try {
      if (disabled(this.root, this.io)) return true;
      const fd = this.io.openSync(path.join(this.root, OFF), 'wx', 0o600); this.io.closeSync(fd); return true;
    } catch {
      try {
        const file = path.join(this.root, FILE), before = this.io.lstatSync(file);
        if (!privateFile(before)) return false;
        const s = readState(this.root, { io: this.io, allowDisabled: true }); if (!sameIssuer(s.issuer, this.issuer)) return false;
        const after = this.io.lstatSync(file); if (!sameFile(before, after)) return false;
        this.io.unlinkSync(file); return true;
      } catch (e) { return e.code === 'ENOENT'; }
    }
  }
  store(s) {
    try { this.save(s); } catch {
      const confirmed = this.invalidate(); throw Object.assign(denied('MOBILE_STORAGE'), { revocationConfirmed: confirmed });
    }
  }
  initialize({ alive = processMayBeAlive } = {}) {
    this.owner();
    const file = path.join(this.root, FILE);
    try {
      this.io.lstatSync(file); const old = readState(this.root, { io: this.io, allowDisabled: true });
      if (!sameIssuer(old.issuer, this.issuer) && alive(old.issuer) !== false) throw denied();
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const s = { version: 1, issuer: this.issuer, generation: randomUUID(), enabled: false, actor: null, origin: null, scopes: [], pairing: null, device: null };
    this.store(s); this.initialized = true; this.closed = false;
  }
  beginPairing({ actor, origin: site, scopes, replace = false }) {
    const s = this.load(), time = this.time();
    if (!text(actor, 320) || !origin(site) || !validScopes(scopes) || !scopes.length || typeof replace !== 'boolean') throw denied();
    if (s.device && s.device.until > time && replace !== true) throw denied('MOBILE_REPLACE_REQUIRED');
    const pairingSecret = secret();
    const next = { ...s, generation: randomUUID(), enabled: false, actor, origin: site, scopes: JSON.parse(JSON.stringify(scopes)),
      pairing: { hash: hash(pairingSecret), until: time + PAIR_MS }, device: null };
    this.store(next); this.closed = false; this.failures = { since: time, count: 0 };
    return Object.freeze({ secret: pairingSecret, expiresAt: next.pairing.until });
  }
  pair({ secret: pairingSecret, actor, origin: site }) {
    if (this.closed) throw denied();
    const s = this.load(), time = this.time();
    if (actor !== s.actor || site !== s.origin) throw denied();
    if (time - this.failures.since >= 60000) this.failures = { since: time, count: 0 };
    if (this.failures.count >= 10) throw denied('MOBILE_PAIR_LIMIT');
    if (!s.pairing || s.pairing.until <= time || !token(pairingSecret) || !sameDigest(hash(pairingSecret), s.pairing.hash)) {
      this.failures.count++; throw denied();
    }
    const value = secret(), csrf = secret(), next = { ...s, enabled: true, pairing: null,
      device: { id: randomUUID(), tokenHash: hash(value), csrfHash: hash(csrf), until: time + SESSION_MS } };
    this.store(next);
    try {
      const off = path.join(this.root, OFF);
      if (disabled(this.root, this.io)) { if (!privateFile(this.io.lstatSync(off))) throw denied(); this.io.unlinkSync(off); }
    } catch { const confirmed = this.invalidate(); throw Object.assign(denied('MOBILE_STORAGE'), { revocationConfirmed: confirmed }); }
    const result = { csrf, deviceId: next.device.id, expiresAt: next.device.until };
    Object.defineProperty(result, 'cookieValue', { value, enumerable: false }); return Object.freeze(result);
  }
  authenticate({ token: value, actor }) {
    if (this.closed || !token(value)) throw denied();
    const s = this.load(), time = this.time();
    if (disabled(this.root, this.io) || !s.enabled || !s.device || s.device.until <= time || actor !== s.actor || !sameDigest(hash(value), s.device.tokenHash)) throw denied();
    return s;
  }
  authorize({ token: value, actor, origin: site, csrf, action, target }) {
    const s = this.authenticate({ token: value, actor }); scopeOf(s, target, action);
    if (action === 'read' ? site !== undefined && site !== s.origin : site !== s.origin || !token(csrf) || !sameDigest(hash(csrf), s.device.csrfHash)) throw denied();
    return Object.freeze({ issuer: { ...s.issuer }, generation: s.generation, deviceId: s.device.id, tokenHash: s.device.tokenHash,
      action, serviceKey: target.serviceKey, sessionId: target.sessionId, nativeId: target.nativeId });
  }
  revoke() {
    this.closed = true;
    let s;
    // An unreadable or replaced issuer is not authority to overwrite somebody
    // else's grant. Stop this entry, and keep shared cancellation unconfirmed.
    try { s = this.load(); } catch { return { confirmed: false }; }
    try { this.save({ ...s, generation: randomUUID(), enabled: false, pairing: null, device: null }); return { confirmed: true }; }
    catch { return { confirmed: this.invalidate() }; }
  }
}
module.exports = { MobileAccess, verifyTicket, FILE, OFF, PAIR_MS, SESSION_MS, MAX_BYTES };
