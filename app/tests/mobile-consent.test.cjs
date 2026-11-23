const test = require('node:test'), assert = require('node:assert/strict');
const crypto = require('node:crypto');
let MobileConsent;
try { ({ MobileConsent } = require('../mobile-consent.cjs')); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
const b64 = b => Buffer.from(b).toString('base64url');
function cbor(v) {
  const head = (m, n) => n < 24 ? Buffer.from([m * 32 + n]) : n < 256 ? Buffer.from([m * 32 + 24, n]) : Buffer.from([m * 32 + 25, n >> 8, n & 255]);
  if (typeof v === 'number') return v < 0 ? head(1, -1-v) : head(0, v);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === 'string') return Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v)]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw Error('Unsupported fixture value');
}
function fixture() {
  assert.equal(typeof MobileConsent, 'function', 'The phone needs a per-card passkey verifier');
  let now = 1700000000000;
  const consent = new MobileConsent({ now: () => now });
  const state = { origin: 'https://phone.example.test', generation: crypto.randomUUID(), device: { id: crypto.randomUUID() } };
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }), id = crypto.randomBytes(32);
  const rp = crypto.createHash('sha256').update('phone.example.test').digest();
  const client = (challenge, type = 'webauthn.get', origin = state.origin) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  function assertion(options, changes = {}) {
    const data = client(options.challenge, changes.type, changes.origin);
    const auth = Buffer.concat([changes.rpId ? crypto.createHash('sha256').update(changes.rpId).digest() : rp, Buffer.from([changes.flags ?? 5]), Buffer.alloc(4)]);
    const signature = crypto.sign('sha256', Buffer.concat([auth, crypto.createHash('sha256').update(data).digest()]), privateKey);
    return { id: b64(id), rawId: b64(id), type: 'public-key', response: { clientDataJSON: b64(data), authenticatorData: b64(auth), signature: b64(signature), userHandle: null }, clientExtensionResults: {} };
  }
  function enroll(config = {}) {
    const start = consent.beginRegistration(state), options = consent.registrationOptions(state, { code: start.code });
    const key = cbor(new Map([[1, 2], [3, config.alg ?? -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
    const size = Buffer.alloc(2); size.writeUInt16BE(id.length);
    const auth = Buffer.concat([rp, Buffer.from([config.flags ?? 0x45]), Buffer.alloc(4), Buffer.alloc(16), size, id, key]);
    const response = { clientDataJSON: b64(client(options.publicKey.challenge, 'webauthn.create', config.origin)), attestationObject: b64(cbor(new Map([['fmt', config.fmt ?? 'none'], ['authData', auth], ['attStmt', new Map()]]))) };
    config.mutate?.(response);
    const registered = consent.register(state, { registrationId: options.registrationId, credential: { id: b64(id), rawId: b64(id), type: 'public-key', response, clientExtensionResults: {} } });
    config.beforeProof?.(registered, options);
    consent.proveRegistration(state, { registrationId: options.registrationId, assertion: assertion(registered.publicKey) });
    const ready = consent.status(state).pending;
    config.beforeConfirm?.(ready);
    consent.confirmRegistration(state, { registrationId: ready.registrationId, fingerprint: ready.fingerprint });
    return consent.status(state);
  }
  const binding = (changes = {}) => ({ sessionId: 'session', nativeId: 'native', operationId: 'card', version: 'immutable-card-digest', decision: 1, expiresAt: now + 120000, ...changes });
  function enabled() { const status = enroll(); consent.setEnabled(state, { enabled: true, registrationId: status.registrationId }); }
  return { consent, state, enroll, enabled, binding, assertion, advance: n => { now += n; } };
}
test('registration requires Mac initiation, possession proof and exact fingerprint confirmation; enable defaults off', () => {
  const f = fixture(); assert.equal(f.consent.status(f.state).enabled, false);
  assert.throws(() => f.consent.registrationOptions(f.state, { code: '123456' }));
  const status = f.enroll(); assert.equal(status.registered, true); assert.equal(status.enabled, false);
  assert.match(status.fingerprint, /^[a-f0-9]{64}$/);
});
test('only a cookie, even with CSRF, cannot create a per-card decision without a registered enabled key', () => {
  const f = fixture(); assert.throws(() => f.consent.challenge(f.state, f.binding()));
  const s = f.enroll(); assert.throws(() => f.consent.challenge(f.state, f.binding()));
  assert.throws(() => f.consent.setEnabled(f.state, { enabled: true, registrationId: 'another-key' }));
  f.consent.setEnabled(f.state, { enabled: true, registrationId: s.registrationId });
  const c = f.consent.challenge(f.state, f.binding()); assert.throws(() => f.consent.consume(f.state, { challengeId: c.challengeId }, f.binding()));
});
test('an ES256 UP+UV assertion authorizes exactly one immutable card, without relying on a signature counter', () => {
  const f = fixture(); f.enabled(); const binding = f.binding(), c = f.consent.challenge(f.state, binding);
  const value = { challengeId: c.challengeId, assertion: f.assertion(c.publicKey) };
  const permit = f.consent.consume(f.state, value, binding); assert.doesNotThrow(() => permit.check(f.state, binding));
  assert.throws(() => f.consent.consume(f.state, value, binding));
});
for (const [name, change] of Object.entries({ 'cross-card replay': { operationId: 'other' }, 'changed card': { version: 'new-version' }, 'changed native identity': { nativeId: 'successor' }, 'different decision': { decision: 0 } })) test(name + ' is rejected', () => {
  const f = fixture(); f.enabled(); const c = f.consent.challenge(f.state, f.binding());
  assert.throws(() => f.consent.consume(f.state, { challengeId: c.challengeId, assertion: f.assertion(c.publicKey) }, f.binding(change)));
});
for (const [name, change] of Object.entries({ 'wrong Origin': { origin: 'https://attacker.example.test' }, 'wrong RP': { rpId: 'other.example.test' }, 'missing UV': { flags: 1 }, 'missing UP': { flags: 4 }, 'wrong ceremony': { type: 'webauthn.create' }, 'invalid backup flags': { flags: 21 } })) test(name + ' is rejected even with a valid key signature', () => {
  const f = fixture(); f.enabled(); const c = f.consent.challenge(f.state, f.binding());
  assert.throws(() => f.consent.consume(f.state, { challengeId: c.challengeId, assertion: f.assertion(c.publicKey, change) }, f.binding()));
});
test('revocation and disable invalidate an already verified permit before the original handler starts', () => {
  for (const revoke of [f => f.consent.revoke(), f => f.consent.setEnabled(f.state, { enabled: false })]) {
    const f = fixture(); f.enabled(); const binding = f.binding(), c = f.consent.challenge(f.state, binding);
    const permit = f.consent.consume(f.state, { challengeId: c.challengeId, assertion: f.assertion(c.publicKey) }, binding);
    revoke(f); assert.throws(() => permit.check(f.state, binding));
  }
});
test('expired cards, re-pairing and app restart never revive old challenges', () => {
  const f = fixture(); f.enabled(); const binding = f.binding(), c = f.consent.challenge(f.state, binding), value = { challengeId: c.challengeId, assertion: f.assertion(c.publicKey) };
  assert.throws(() => f.consent.consume({ ...f.state, generation: crypto.randomUUID() }, value, binding));
  f.advance(120001); assert.throws(() => f.consent.consume(f.state, value, binding));
  assert.throws(() => new MobileConsent().consume(f.state, value, binding));
});
test('registration code has a short lifetime and bounded guesses; replacing a key disables old approval authority immediately', () => {
  const f = fixture(); f.enabled(); f.consent.beginRegistration(f.state);
  assert.equal(f.consent.status(f.state).enabled, false);
  const code = f.consent.status(f.state).pending.code;
  for (let n = 0; n < 10; n++) assert.throws(() => f.consent.registrationOptions(f.state, { code: code === '000000' ? '000001' : '000000' }));
  assert.throws(() => f.consent.registrationOptions(f.state, { code }));
  const next = f.consent.beginRegistration(f.state); f.advance(120001); assert.throws(() => f.consent.registrationOptions(f.state, { code: next.code }));
});
test('the assertion signature, credential id and strict byte encodings are checked', () => {
  for (const mutate of [v => { v.response.signature = b64(Buffer.alloc(70)); }, v => { v.id = b64(Buffer.alloc(32)); }, v => { v.response.clientDataJSON += '='; }]) {
    const f = fixture(); f.enabled(); const c = f.consent.challenge(f.state, f.binding()), assertion = f.assertion(c.publicKey); mutate(assertion);
    assert.throws(() => f.consent.consume(f.state, { challengeId: c.challengeId, assertion }, f.binding()));
  }
});
for (const [name, config] of Object.entries({ algorithm: { alg: -257 }, attestation: { fmt: 'packed' }, 'registration UV': { flags: 0x41 }, 'registration Origin': { origin: 'https://attacker.example.test' },
  'CBOR trailing bytes': { mutate: r => { r.attestationObject = b64(Buffer.concat([Buffer.from(r.attestationObject, 'base64url'), Buffer.from([0])])); } },
  'CBOR indefinite map': { mutate: r => { r.attestationObject = b64(Buffer.from([0xbf, 0xff])); } },
  'CBOR duplicate keys': { mutate: r => { r.attestationObject = b64(Buffer.from([0xa2, 0x61, 0x78, 0x00, 0x61, 0x78, 0x01])); } },
  'truncated authenticator data': { mutate: r => { r.attestationObject = b64(cbor(new Map([['fmt', 'none'], ['authData', Buffer.alloc(36)], ['attStmt', new Map()]]))); } },
})) test('unsupported or malformed ' + name + ' cannot register', () => {
  const f = fixture(); assert.throws(() => f.enroll(config)); assert.equal(f.consent.status(f.state).registered, false);
});
test('neither missing possession proof nor a different Mac fingerprint can confirm registration', () => {
  const f = fixture();
  f.enroll({ beforeProof: (registered, options) => assert.throws(() => f.consent.confirmRegistration(f.state, { registrationId: options.registrationId, fingerprint: registered.fingerprint })),
    beforeConfirm: ready => assert.throws(() => f.consent.confirmRegistration(f.state, { registrationId: ready.registrationId, fingerprint: '0'.repeat(64) })) });
  assert.equal(f.consent.status(f.state).enabled, false);
});
test('challenge pressure cannot evict a consumed record or unlock a replay', () => {
  const f = fixture(); f.enabled(); const binding = f.binding(), first = f.consent.challenge(f.state, binding);
  const value = { challengeId: first.challengeId, assertion: f.assertion(first.publicKey) }; f.consent.consume(f.state, value, binding);
  for (let i = 1; i < 256; i++) f.consent.challenge(f.state, binding);
  assert.throws(() => f.consent.challenge(f.state, binding)); assert.throws(() => f.consent.consume(f.state, value, binding));
});
module.exports = { fixture, cbor };
test('a recovered public key keeps per-card verification and never restores old challenges',()=>{
 const f=fixture();f.enabled();const old=f.consent.challenge(f.state,f.binding()),saved=f.consent.snapshot(f.state),next={...f.state,generation:crypto.randomUUID()};
 const restored=new MobileConsent({now:()=>1700000000000});restored.restore(f.state,next,saved);assert.equal(restored.status(next).enabled,true);
 assert.throws(()=>restored.consume(next,{challengeId:old.challengeId,assertion:f.assertion(old.publicKey)},f.binding()));
 const bad=restored.challenge(next,f.binding());assert.throws(()=>restored.consume(next,{challengeId:bad.challengeId,assertion:f.assertion(bad.publicKey,{flags:1})},f.binding()));
 const fresh=restored.challenge(next,f.binding());assert.ok(restored.consume(next,{challengeId:fresh.challengeId,assertion:f.assertion(fresh.publicKey)},f.binding()));
 assert.equal(Object.hasOwn(saved.key,'privateKey'),false);
});
test('recovery refuses a changed origin, device, owner, RP, public key or schema',()=>{
 const f=fixture();f.enabled();for(const change of ['origin','device','owner','rp','key','extra']){
  const saved=f.consent.snapshot(f.state),next={...f.state,generation:crypto.randomUUID()};
  if(change==='origin')next.origin='https://other.example.test';if(change==='device')next.device={id:crypto.randomUUID()};
  if(change==='owner')saved.owner='0'.repeat(64);if(change==='rp')saved.key.rpId='other.example.test';
  if(change==='key')saved.key.publicKey=Buffer.alloc(80).toString('base64url');if(change==='extra')saved.key.extra=true;
  const restored=new MobileConsent();assert.throws(()=>restored.restore(f.state,next,saved));assert.equal(restored.status(next).enabled,false);
 }
});
test('recovery of a disabled key or revoked enrollment never enables approvals',()=>{
 const f=fixture();f.enroll();const restored=new MobileConsent();restored.restore(f.state,f.state,f.consent.snapshot(f.state));
 assert.equal(restored.status(f.state).registered,true);assert.equal(restored.status(f.state).enabled,false);
 f.consent.revoke();restored.restore(f.state,f.state,f.consent.snapshot(f.state));assert.equal(restored.status(f.state).registered,false);
});
