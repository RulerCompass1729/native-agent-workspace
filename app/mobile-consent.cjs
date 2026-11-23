// App-local, per-pairing passkey authority. Same-account code/file integrity is
// the desktop's existing boundary, not an isolation claim. No network or model.
const { randomBytes, randomUUID, randomInt, createHash, createPublicKey, verify, timingSafeEqual } = require('node:crypto');
const { TextDecoder } = require('node:util');
const denied = () => Object.assign(Error('Mobile confirmation proof is unavailable or changed'), { code: 'MOBILE_CONSENT_DENIED', notSent: true });
const hash = x => createHash('sha256').update(x).digest();
const stable = x => Array.isArray(x) ? x.map(stable) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(k => [k, stable(x[k])])) : x;
const digest = x => hash(JSON.stringify(stable(x))).toString('hex');
const same = (a, b) => Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.length === b.length && timingSafeEqual(a, b);
function bytes(value, max = 16384) {
  if (typeof value !== 'string' || !value.length || value.length > Math.ceil(max * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) throw denied();
  const b = Buffer.from(value, 'base64url'); if (b.length > max || b.toString('base64url') !== value) throw denied(); return b;
}
// Only definite-length CBOR integers, bytes, UTF-8 strings and maps are needed
// for fmt=none and an ES256 COSE key. Reject duplicates, tags, floats, arrays,
// indefinite items, trailing bytes and excessive depth/size; never general CBOR.
function cbor(input) {
  let offset = 0, items = 0;
  function take(n) { if (!Number.isSafeInteger(n) || n < 0 || offset + n > input.length) throw denied(); const b = input.subarray(offset, offset + n); offset += n; return b; }
  function read(depth = 0) {
    if (depth > 4 || ++items > 64) throw denied();
    const h = take(1)[0], major = h >> 5, ai = h & 31;
    let n;
    if (ai < 24) n = ai;
    else if (ai === 24) { n = take(1)[0]; if (n < 24) throw denied(); }
    else if (ai === 25) { n = take(2).readUInt16BE(); if (n < 256) throw denied(); }
    else if (ai === 26) { n = take(4).readUInt32BE(); if (n < 65536) throw denied(); }
    else throw denied();
    if (n > 16384) throw denied();
    if (major === 0) return n;
    if (major === 1) return -1 - n;
    if (major === 2) return take(n);
    if (major === 3) return new TextDecoder('utf-8', { fatal: true }).decode(take(n));
    if (major !== 5 || n > 16) throw denied();
    const map = new Map();
    for (let i = 0; i < n; i++) { const k = read(depth + 1); if (!['number', 'string'].includes(typeof k) || map.has(k)) throw denied(); map.set(k, read(depth + 1)); }
    return map;
  }
  const result = read(); if (offset !== input.length) throw denied(); return result;
}
function site(authority) {
  const url = new URL(authority.origin);
  if (url.protocol !== 'https:' || url.origin !== authority.origin || url.username || url.password || !url.hostname || !authority.generation || !authority.device?.id) throw denied();
  // RP is fixed by the Mac's configured HTTPS origin, never a phone parameter.
  // IP literals are not deployable RP IDs. Isolated browsers use localhost.
  if (/^[\d.]+$/.test(url.hostname) || url.hostname.includes(':')) throw denied();
  return url.hostname;
}
const owner = a => digest({ origin: a.origin, generation: a.generation, deviceId: a.device?.id });
function clientData(credential, challenge, origin, type) {
  const raw = bytes(credential?.response?.clientDataJSON, 4096);
  const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  if (data.type !== type || data.challenge !== challenge || data.origin !== origin || data.crossOrigin !== undefined && data.crossOrigin !== false || data.topOrigin !== undefined) throw denied();
  if (credential.type !== 'public-key' || !same(bytes(credential.id, 1023), bytes(credential.rawId, 1023)) ||
      credential.clientExtensionResults && Object.keys(credential.clientExtensionResults).length) throw denied();
  return raw;
}
function authenticator(raw, rpId, registration) {
  if (raw.length < 37 || !same(raw.subarray(0, 32), hash(rpId))) throw denied();
  const flags = raw[32];
  if ((flags & 5) !== 5 || flags & 0xa2 || flags & 16 && !(flags & 8) || Boolean(flags & 64) !== registration) throw denied();
  if (!registration && raw.length !== 37) throw denied();
}
function registration(credential, challenge, origin, rpId) {
  clientData(credential, challenge, origin, 'webauthn.create');
  const att = cbor(bytes(credential.response.attestationObject));
  if (!(att instanceof Map) || att.size !== 3 || att.get('fmt') !== 'none' || !(att.get('attStmt') instanceof Map) || att.get('attStmt').size) throw denied();
  const raw = att.get('authData'); if (!Buffer.isBuffer(raw)) throw denied(); authenticator(raw, rpId, true);
  if (raw.length < 55) throw denied();
  const size = raw.readUInt16BE(53); if (!size || size > 1023 || 55 + size >= raw.length) throw denied();
  const id = raw.subarray(55, 55 + size); if (!same(id, bytes(credential.id, 1023))) throw denied();
  const key = cbor(raw.subarray(55 + size));
  if (!(key instanceof Map) || key.size !== 5 || key.get(1) !== 2 || key.get(3) !== -7 || key.get(-1) !== 1 ||
      !Buffer.isBuffer(key.get(-2)) || key.get(-2).length !== 32 || !Buffer.isBuffer(key.get(-3)) || key.get(-3).length !== 32) throw denied();
  const publicKey = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: key.get(-2).toString('base64url'), y: key.get(-3).toString('base64url') }, format: 'jwk' });
  return { id: id.toString('base64url'), publicKey, fingerprint: hash(publicKey.export({ format: 'der', type: 'spki' })).toString('hex') };
}
function assertion(credential, key, challenge, authority, rpId) {
  const raw = clientData(credential, challenge, authority.origin, 'webauthn.get');
  if (credential.id !== key.id) throw denied();
  const data = bytes(credential.response.authenticatorData, 37); authenticator(data, rpId, false);
  const handle = credential.response.userHandle;
  if (handle != null && !same(bytes(handle, 64), Buffer.from(authority.device.id))) throw denied();
  if (!verify('sha256', Buffer.concat([data, hash(raw)]), key.publicKey, bytes(credential.response.signature, 80))) throw denied();
}
class MobileConsent {
  #now; #pending = null; #key = null; #enabled = false; #epoch = 0; #challenges = new Map();
  constructor({ now = Date.now } = {}) { this.#now = now; }
  snapshot(a){
    const key=this.#key?.owner===owner(a)?this.#key:null;
    return key?{version:1,owner:owner(a),enabled:this.#enabled,key:{id:key.id,publicKey:key.publicKey.export({format:'der',type:'spki'}).toString('base64url'),fingerprint:key.fingerprint,registrationId:key.registrationId,rpId:key.rpId}}:null;
  }
  restore(previous,current,value){
    this.revoke();if(value===null)return;
    const exact=(v,ks)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===ks.length&&ks.every(k=>Object.hasOwn(v,k));
    if(!exact(value,['version','owner','enabled','key'])||value.version!==1||value.owner!==owner(previous)||typeof value.enabled!=='boolean'||
      previous.origin!==current.origin||previous.device?.id!==current.device?.id||!exact(value.key,['id','publicKey','fingerprint','registrationId','rpId']))throw denied();
    const k=value.key,der=bytes(k.publicKey,256),publicKey=createPublicKey({key:der,format:'der',type:'spki'});
    bytes(k.id,1023);
    if(publicKey.asymmetricKeyType!=='ec'||publicKey.asymmetricKeyDetails?.namedCurve!=='prime256v1'||!same(publicKey.export({format:'der',type:'spki'}),der)||
      hash(der).toString('hex')!==k.fingerprint||k.rpId!==site(previous)||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(k.registrationId))throw denied();
    this.#key={...k,publicKey,owner:owner(current)};this.#enabled=value.enabled;
  }
  #time() { const t = this.#now(); if (!Number.isSafeInteger(t) || t < 0) throw denied(); return t; }
  revoke() { this.#epoch++; this.#enabled = false; this.#key = null; this.#pending = null; this.#challenges.clear(); }
  #pendingFor(a) { const p = this.#pending; if (!p || p.owner !== owner(a) || p.until <= this.#time()) throw denied(); return p; }
  #keyFor(a, enabled = true) { const k = this.#key; if (!k || k.owner !== owner(a) || enabled && !this.#enabled) throw denied(); return k; }
  status(a) {
    const k = this.#key?.owner === owner(a) ? this.#key : null, p = this.#pending?.owner === owner(a) && this.#pending.until > this.#time() ? this.#pending : null;
    return { enabled: Boolean(k && this.#enabled), registered: Boolean(k), registrationId: k?.registrationId || null, fingerprint: k?.fingerprint || null,
      pending: p ? { registrationId: p.registrationId, code: p.code, expiresAt: p.until, fingerprint: p.proved ? p.key.fingerprint : null, ready: p.proved === true } : null };
  }
  // These four management methods are called only by desktop-only Main IPC.
  beginRegistration(a) {
    const rpId = site(a); this.revoke();
    const p = { owner: owner(a), registrationId: randomUUID(), code: String(randomInt(1000000)).padStart(6, '0'),
      challenge: randomBytes(32).toString('base64url'), rpId, until: this.#time() + 120000, failures: 0, started: false };
    this.#pending = p; return this.status(a).pending;
  }
  // Broker-only: a redeemed, desktop-issued QR intent authorizes this single
  // candidate enrollment. These are not desktop-management HTTP methods.
  beginQrRegistration(a) { this.beginRegistration(a);this.#pending.qrAuthorized=true; }
  qrOptions(a,value) {
    if (!this.#pendingFor(a).qrAuthorized || !value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).length) throw denied();
    return this.registrationOptions(a,{code:this.#pending.code});
  }
  completeQrRegistration(a,value) {
    if (!this.#pendingFor(a).qrAuthorized) throw denied();
    this.proveRegistration(a,value);
    const p=this.#pendingFor(a);this.confirmRegistration(a,{registrationId:p.registrationId,fingerprint:p.key.fingerprint});
    return this.setEnabled(a,{enabled:true,registrationId:p.registrationId});
  }
  registrationOptions(a, value) {
    const p = this.#pendingFor(a);
    if (p.started || p.failures >= 10 || typeof value?.code !== 'string' || !same(Buffer.from(p.code), Buffer.from(value.code))) { p.failures++; throw denied(); }
    p.started = true;
    return { registrationId: p.registrationId, publicKey: { challenge: p.challenge, rp: { id: p.rpId, name: 'Native Agent Workspace' },
      user: { id: Buffer.from(a.device.id).toString('base64url'), name: 'NAW person', displayName: 'NAW person' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }], timeout: Math.max(1, p.until - this.#time()), attestation: 'none',
      authenticatorSelection: { residentKey: 'discouraged', userVerification: 'required' } } };
  }
  register(a, value) {
    const p = this.#pendingFor(a);
    if (!p.started || p.key || p.registrationId !== value?.registrationId) throw denied();
    p.key = registration(value.credential, p.challenge, a.origin, p.rpId);
    // fmt=none alone does not prove possession. A second UP+UV assertion must
    // verify before the Mac can accept this public key's fingerprint.
    p.proof = randomBytes(32).toString('base64url');
    return { fingerprint: p.key.fingerprint, publicKey: this.#options(p.proof, p.key, p.rpId, p.until) };
  }
  proveRegistration(a, value) {
    const p = this.#pendingFor(a);
    if (!p.key || p.proved || p.registrationId !== value?.registrationId) throw denied();
    assertion(value.assertion, p.key, p.proof, a, p.rpId); p.proved = true;
    return { fingerprint: p.key.fingerprint, awaitingDesktop: true };
  }
  confirmRegistration(a, value) {
    const p = this.#pendingFor(a);
    if (!p.proved || value?.registrationId !== p.registrationId || value.fingerprint !== p.key.fingerprint) throw denied();
    this.#key = { ...p.key, owner: p.owner, registrationId: p.registrationId, rpId: p.rpId }; this.#pending = null;
    return this.status(a);
  }
  setEnabled(a, value) {
    if (typeof value?.enabled !== 'boolean') throw denied();
    if (value.enabled && this.#keyFor(a, false).registrationId !== value.registrationId) throw denied();
    this.#epoch++; this.#challenges.clear(); this.#enabled = value.enabled; return this.status(a);
  }
  #options(challenge, k, rpId, until) { return { challenge, rpId, allowCredentials: [{ type: 'public-key', id: k.id }], userVerification: 'required', timeout: Math.max(1, until - this.#time()) }; }
  challenge(a, binding) {
    const key = this.#keyFor(a), now = this.#time();
    if (!Number.isSafeInteger(binding?.expiresAt) || binding.expiresAt <= now || !Number.isSafeInteger(binding.decision)) throw denied();
    for (const [id, row] of this.#challenges) if (row.until <= now) this.#challenges.delete(id);
    if (this.#challenges.size >= 256) throw denied();
    const row = { challengeId: randomUUID(), challenge: randomBytes(32).toString('base64url'), owner: owner(a), key, epoch: this.#epoch,
      binding: digest(binding), until: Math.min(binding.expiresAt, now + 120000), used: false };
    this.#challenges.set(row.challengeId, row);
    return { challengeId: row.challengeId, publicKey: this.#options(row.challenge, key, key.rpId, row.until) };
  }
  consume(a, value, binding) {
    const row = this.#challenges.get(value?.challengeId);
    const check = (authority, current) => {
      if (!row || this.#keyFor(authority) !== row.key || row.epoch !== this.#epoch || row.owner !== owner(authority) || row.until <= this.#time() || row.binding !== digest(current)) throw denied();
    };
    check(a, binding); if (row.used) throw denied();
    // One attempt consumes the challenge even if verification fails; another
    // user gesture may request a fresh challenge, never retry an old decision.
    row.used = true;
    assertion(value.assertion, row.key, row.challenge, a, row.key.rpId);
    return { check };
  }
}
module.exports = { MobileConsent };
