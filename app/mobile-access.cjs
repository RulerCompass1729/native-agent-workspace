const { uiError } = require('./ui-errors.cjs');
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
const denied = (code = 'MOBILE_DENIED') => Object.assign(uiError("error.mobile.authorizationUnconfirmed"), { code });
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
  const all = s?.version === 2 && s.sessionPolicy === 'all';
  if (!exact(s, ['version', 'issuer', 'generation', 'enabled', 'actor', 'origin', 'scopes', 'pairing', 'device', ...(all ? ['sessionPolicy'] : [])]) || (s.version !== 1 && !all) ||
    !exact(s.issuer, ['pid', 'started', 'instance']) || !Number.isSafeInteger(s.issuer.pid) || s.issuer.pid < 2 || !text(s.issuer.started) || !uuid(s.issuer.instance) ||
    !uuid(s.generation) || typeof s.enabled !== 'boolean' || !validScopes(s.scopes) || all && s.scopes.length !== 0) return false;
  if (s.actor === null || s.origin === null) {
    if (s.actor !== null || s.origin !== null || s.scopes.length || s.enabled || s.pairing !== null || s.device !== null) return false;
  } else if (!text(s.actor, 320) || !origin(s.origin) || !all && !s.scopes.length) return false;
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
function scopeOf(s, target, action, root) {
  if (!actions.has(action) || !exact(target, ['serviceKey', 'sessionId', 'nativeId'])) throw denied();
  if (s.version === 2 && s.sessionPolicy === 'all') {
    // Empty bootstrap/withdrawal is not a wildcard. Main must first observe
    // eligible native targets and mirror their exact concrete v1 scopes.
    throw denied();
  }
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
  scopeOf(s, { serviceKey: target.serviceKey, sessionId: target.sessionId, nativeId: target.nativeId }, ticket.action, root);
  return true;
}
class MobileAccess {
  #allGeneration = null;
  #candidate = null;
  #base(s) { return hash(JSON.stringify([s.issuer,s.generation,s.enabled,s.actor,s.origin,s.device,s.pairing])); }
  #pending(id) {
    const c=this.#candidate;
    if (!c || id !== undefined && id !== c.id || c.until <= this.time() || c.base !== this.#base(this.load())) throw denied();
    return c;
  }
  candidateStatus() {
    try { const c=this.#pending(); return {id:c.id,expiresAt:c.until,redeemed:!!c.state.device}; } catch { return null; }
  }
  // Desktop-issued enrollment intent stays in memory, separate from the active
  // file. Neither preparing nor exchanging this QR grants ordinary API access.
  candidateInfo(id) {
    this.owner();
    const c=this.#candidate;
    try {
      if (!uuid(id) || !c || c.id!==id || c.base!==this.#base(this.load())) return {state:'unconfirmed'};
      return {setupId:c.id,expiresAt:c.until,renewUntil:c.renewUntil || c.until,redeemed:!!c.state.device,
        state:c.until<=this.time()?'expired':c.state.device?'redeemed':'waiting'};
    } catch { return {state:'unconfirmed'}; }
  }
  assertCandidateRefresh(id, automatic=false) {
    const info=this.candidateInfo(id);
    if (info.redeemed) throw denied('MOBILE_SETUP_REDEEMED');
    if (!['waiting','expired'].includes(info.state) || automatic && info.renewUntil<=this.time()) throw denied('MOBILE_SETUP_UNCONFIRMED');
    return info;
  }
  beginCandidate({actor,origin:site,replace=false,renew=false,refreshOf,automatic=false}) {
    const s=this.load(),time=this.time();
    if (typeof renew!=='boolean' || typeof automatic!=='boolean' || (refreshOf!==undefined && (!renew || !uuid(refreshOf))) || automatic && (!renew || !refreshOf)) throw denied();
    const previous=refreshOf!==undefined?this.assertCandidateRefresh(refreshOf,automatic):null;
    if (renew && !previous && this.#candidate) this.assertCandidateRefresh(this.#candidate.id);
    // The listener lease may outlive this QR; #pending still enforces its 120 seconds.
    const renewUntil=renew ? automatic ? previous.renewUntil : time+600000 : time+PAIR_MS;
    if (!text(actor,320) || !origin(site) || typeof replace !== 'boolean') throw denied();
    if (s.enabled && s.device?.until > time && (!replace || s.actor !== actor || s.origin !== site)) throw denied('MOBILE_REPLACE_REQUIRED');
    const value=secret(),id=randomUUID();
    this.#candidate={id,base:this.#base(s),until:time+PAIR_MS,renewUntil,failures:0,csrf:null,state:{...s,version:2,sessionPolicy:'all',generation:randomUUID(),enabled:false,actor,origin:site,scopes:[],pairing:{hash:hash(value),until:time+PAIR_MS},device:null}};
    return {id,secret:value,expiresAt:time+PAIR_MS};
  }
  cancelCandidate(id) { if (this.#candidate?.id===id) { this.#candidate=null;return true; } return false; }
  pairCandidate(value) {
    const c=this.#pending(),s=c.state,time=this.time();
    if (!exact(value,['secret','actor','origin']) || value.actor !== s.actor || value.origin !== s.origin || !s.pairing || c.failures>=10 || !token(value.secret) || !sameDigest(hash(value.secret),s.pairing.hash)) { c.failures++;throw denied(); }
    const bearer=secret(),csrf=secret();c.csrf=csrf;c.until=time+PAIR_MS;
    c.state={...s,enabled:true,pairing:null,device:{id:randomUUID(),tokenHash:hash(bearer),csrfHash:hash(csrf),until:time+SESSION_MS}};
    const result={csrf,deviceId:c.state.device.id,expiresAt:c.state.device.until};Object.defineProperty(result,'cookieValue',{value:bearer});return Object.freeze(result);
  }
  candidateAuthenticate(auth,write=false) {
    const c=this.#pending(),s=c.state;
    if (!auth || typeof auth!=='object' || Array.isArray(auth) || Object.keys(auth).some(k=>!['token','actor','origin','csrf'].includes(k)) || !s.device || !token(auth.token) || auth.actor!==s.actor || !sameDigest(hash(auth.token),s.device.tokenHash) ||
      (write ? auth.origin!==s.origin || !token(auth.csrf) || !sameDigest(hash(auth.csrf),s.device.csrfHash) : auth.origin!==undefined && auth.origin!==s.origin)) throw denied();
    return s;
  }
  candidateCsrf(auth) { this.candidateAuthenticate(auth);return this.#pending().csrf; }
  // Called only after the broker verifies the candidate completion. One atomic
  // rename is the authority boundary. A known pre-rename failure keeps old
  // access; an uncertain disk state fails closed, never restores a stale grant.
  activateCandidate(id,scopes) {
    const c=this.#pending(id),before=this.load();if(!c.state.device || !validScopes(scopes))throw denied();
    const next={...c.state,version:scopes.length?1:2,scopes:JSON.parse(JSON.stringify(scopes))};if(scopes.length)delete next.sessionPolicy;
    try { this.save(next); } catch (error) {
      if(error.persistenceUnconfirmed){this.invalidate();throw denied('MOBILE_STORAGE');}
      let actual;try {actual=readState(this.root,{io:this.io,allowDisabled:true});}catch{}
      if(!actual || hash(JSON.stringify(actual))!==hash(JSON.stringify(next))) {
        if(actual && hash(JSON.stringify(actual))===hash(JSON.stringify(before))) throw denied('MOBILE_STORAGE');
        this.invalidate();throw denied('MOBILE_STORAGE');
      }
    }
    try { if(disabled(this.root,this.io)){const off=path.join(this.root,OFF);if(!privateFile(this.io.lstatSync(off)))throw denied();this.io.unlinkSync(off);} }
    catch {this.invalidate();throw denied('MOBILE_STORAGE');}
    this.#candidate=null;this.#allGeneration=next.generation;this.closed=false;return next;
  }
  constructor(root, { io = fs, now = Date.now, identity = processIdentity(process.pid), exclusive, transaction, pauseTransaction, recover } = {}) {
    if (!identity || !Number.isSafeInteger(identity.pid) || identity.pid < 2 || !text(identity.started) || typeof exclusive !== 'function') throw denied();
    this.io = io; this.now = now; this.root = rootPath(root, io); this.exclusive = exclusive;
    this.transaction = transaction;this.pauseTransaction=pauseTransaction;this.recover=recover;
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
    if(this.transaction)return this.transaction(s,()=>this.#write(s));
    return this.#write(s);
  }
  #write(s) {
    const data = JSON.stringify(s); if (Buffer.byteLength(data) > MAX_BYTES) throw denied('MOBILE_SCOPE_TOO_LARGE');
    const file = path.join(this.root, FILE), temp = file + '.' + randomUUID() + '.tmp'; let fd, own;
    try {
      try { if (!privateFile(this.io.lstatSync(file))) throw denied(); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      fd = this.io.openSync(temp, 'wx', 0o600); own = this.io.fstatSync(fd); this.io.writeFileSync(fd, data, 'utf8');this.io.fsyncSync(fd);
      this.io.closeSync(fd); fd = undefined; this.io.renameSync(temp, file);
      const directory=this.io.openSync(this.root,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
      try{this.io.fsyncSync(directory);}finally{this.io.closeSync(directory);}
    } finally {
      if (fd !== undefined) this.io.closeSync(fd);
      try { const stat = this.io.lstatSync(temp); if (own && stat.dev === own.dev && stat.ino === own.ino && privateFile(stat)) this.io.unlinkSync(temp); } catch { /* Only our temporary file is eligible for cleanup. */ }
    }
  }
  // Whether the OFF marker exists: written only by invalidate(), when a revocation could not be saved; pair() removes a
  // stale one. authenticate() refuses a device while it exists. Throws if it cannot be read.
  disabledMarker() { return disabled(this.root, this.io); }
  invalidate() {
    this.closed = true; this.#allGeneration = null; this.#candidate=null;
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
    this.#allGeneration = null; this.#candidate=null;
    const file = path.join(this.root, FILE);
    try {
      this.io.lstatSync(file); const old = readState(this.root, { io: this.io, allowDisabled: true });
      if (!sameIssuer(old.issuer, this.issuer) && alive(old.issuer) !== false) throw denied();
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const s = { version: 1, issuer: this.issuer, generation: randomUUID(), enabled: false, actor: null, origin: null, scopes: [], pairing: null, device: null };
    this.store(s); this.initialized = true; this.closed = false;
  }
  pause(){
    this.owner();if(!this.initialized||this.closed)return {paused:true};
    this.closed=true;this.#allGeneration=null;this.#candidate=null;
    try{
      const state=this.load(),mirror={...state,generation:randomUUID(),enabled:false,pairing:null,device:null};
      if(state.enabled&&typeof this.pauseTransaction==='function')this.pauseTransaction(state,mirror,()=>this.#write(mirror));
      else this.save(mirror);
      return {paused:true};
    }catch{return {paused:false,authorizationPaused:this.invalidate()};}
  }
  resume(checkpoint,{alive=processMayBeAlive,beforeSave=()=>{}}={}){
    this.owner();if(this.initialized||typeof this.recover!=='function')throw denied();
    const {authority:s,details}=this.recover(checkpoint),time=this.time();
    if(!s.enabled||!s.device||s.pairing||s.device.until<=time||s.device.until>time+SESSION_MS||alive(s.issuer)!==false)throw denied();
    const csrf=secret(),next={...s,issuer:this.issuer,generation:randomUUID(),device:{...s.device,csrfHash:hash(csrf)}};
    beforeSave(next);this.store(next);this.initialized=true;this.closed=false;this.#allGeneration=details.all?next.generation:null;
    return {state:next,csrf};
  }
  beginPairing({ actor, origin: site, scopes, replace = false, all = false }) {
    const s = this.load(), time = this.time();
    if (!text(actor, 320) || !origin(site) || !validScopes(scopes) || (all ? scopes.length !== 0 : !scopes.length) || typeof all !== 'boolean' || typeof replace !== 'boolean') throw denied();
    if (s.device && s.device.until > time && replace !== true) throw denied('MOBILE_REPLACE_REQUIRED');
    this.#candidate=null;
    const pairingSecret = secret();
    const next = { ...s, version: all ? 2 : 1, generation: randomUUID(), enabled: false, actor, origin: site, scopes: JSON.parse(JSON.stringify(scopes)),
      pairing: { hash: hash(pairingSecret), until: time + PAIR_MS }, device: null };
    if (all) next.sessionPolicy = 'all'; else delete next.sessionPolicy;
    this.store(next); this.closed = false; this.failures = { since: time, count: 0 };
    this.#allGeneration = all ? next.generation : null;
    return Object.freeze({ secret: pairingSecret, expiresAt: next.pairing.until });
  }
  // Main's lifetime-scoped policy leaves old backend verification exact: only
  // observed concrete native tuples are mirrored into its strict v1 authority.
  syncAllScopes(scopes) {
    const s = this.load();
    if (!this.#allGeneration || s.generation !== this.#allGeneration || !validScopes(scopes)) throw denied();
    const next = { ...s, version: scopes.length ? 1 : 2, scopes: JSON.parse(JSON.stringify(scopes)) };
    if (scopes.length) delete next.sessionPolicy; else next.sessionPolicy = 'all';
    if (JSON.stringify(s) !== JSON.stringify(next)) this.store(next);
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
    const s = this.authenticate({ token: value, actor }); scopeOf(s, target, action, this.root);
    if (action === 'read' ? site !== undefined && site !== s.origin : site !== s.origin || !token(csrf) || !sameDigest(hash(csrf), s.device.csrfHash)) throw denied();
    return Object.freeze({ issuer: { ...s.issuer }, generation: s.generation, deviceId: s.device.id, tokenHash: s.device.tokenHash,
      action, serviceKey: target.serviceKey, sessionId: target.sessionId, nativeId: target.nativeId });
  }
  revoke() {
    this.closed = true;this.#candidate=null;
    let s;
    // An unreadable or replaced issuer is not authority to overwrite somebody
    // else's grant. Stop this entry, and keep shared cancellation unconfirmed.
    try { s = this.load(); } catch { return { confirmed: false }; }
    try { this.save({ ...s, generation: randomUUID(), enabled: false, pairing: null, device: null }); return { confirmed: true }; }
    catch(error) { const shared=this.invalidate();return { confirmed: shared&&(!this.transaction||error.persistenceRevoked===true) }; }
  }
}
module.exports = { MobileAccess, verifyTicket, readState, validState, FILE, OFF, PAIR_MS, SESSION_MS, MAX_BYTES };
