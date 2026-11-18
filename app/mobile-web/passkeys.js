/* Explicit user gestures only. No password/cookie fallback for sensitive cards. */
(function (global) {
  'use strict';
  const KEY = 'naw.mobile.consent.v1';
  const decode = text => Uint8Array.from(global.atob(text.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
  const encode = value => global.btoa(String.fromCharCode(...new Uint8Array(value))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  function options(value, creation) {
    const method = creation ? 'parseCreationOptionsFromJSON' : 'parseRequestOptionsFromJSON';
    if (typeof global.PublicKeyCredential?.[method] === 'function') return global.PublicKeyCredential[method](value);
    // Older WebAuthn browsers: same fixed schema, no new dependency or CDN.
    const result = { ...value, challenge: decode(value.challenge) };
    if (creation) result.user = { ...value.user, id: decode(value.user.id) };
    for (const key of ['allowCredentials', 'excludeCredentials']) if (value[key]) result[key] = value[key].map(c => ({ ...c, id: decode(c.id) }));
    return result;
  }
  function serialize(c) {
    if (typeof c?.toJSON === 'function') return c.toJSON();
    const response = {};
    for (const key of ['clientDataJSON', 'attestationObject', 'authenticatorData', 'signature', 'userHandle']) if (key in c.response) response[key] = c.response[key] === null ? null : encode(c.response[key]);
    return { id: c.id, rawId: encode(c.rawId), type: c.type, response, clientExtensionResults: c.getClientExtensionResults() };
  }
  function create({ request, storage, credentials = global.navigator?.credentials }) {
    let pending = [], busy = false, storageError = false;
    try {
      const raw = storage.getItem(KEY);
      if (raw) { if (raw.length > 65536) throw Error('limit'); pending = JSON.parse(raw); if (!Array.isArray(pending) || pending.length > 64 || pending.some(p => !p || typeof p.deviceId !== 'string' || typeof p.challengeId !== 'string' || typeof p.id !== 'string' || !['complete', 'not-sent', 'unconfirmed'].includes(p.status))) throw Error('invalid'); }
    } catch { storageError = true; }
    function save() { try { storage.setItem(KEY, JSON.stringify(pending)); } catch { storageError = true; throw Error('MOBILE_STORAGE_UNAVAILABLE'); } }
    async function get(publicKey, creation = false) {
      if (!credentials || typeof credentials[creation ? 'create' : 'get'] !== 'function') throw Error('PASSKEY_UNAVAILABLE');
      const credential = await credentials[creation ? 'create' : 'get']({ publicKey: options(publicKey, creation) });
      if (!credential) throw Error('PASSKEY_CANCELLED'); return serialize(credential);
    }
    async function enroll(session,value) {
      if (busy || !session) throw Error('MOBILE_CONSENT_BUSY'); busy = true;
      try {
        const start = await request('/mobile/consent/registration/options', value, session.csrf);
        const credential = await get(start.publicKey, true);
        const registered = await request('/mobile/consent/register', { registrationId: start.registrationId, credential }, session.csrf);
        const assertion = await get(registered.publicKey);
        return await request('/mobile/consent/registration/proof', { registrationId: start.registrationId, assertion }, session.csrf);
      } finally { busy = false; }
    }
    const register=(session,code)=>enroll(session,{code});
    function registerCandidate(session){if(session?.candidate!==true)throw Error('MOBILE_ENROLLMENT_UNAVAILABLE');return enroll(session,{});}
    async function decide(session, card, decision) {
      if (busy || storageError || !session || pending.some(p => p.id === card.id && !['complete', 'not-sent'].includes(p.status))) throw Error('MOBILE_ACTION_UNCONFIRMED');
      // Confirmed outcomes remain in the original durable desktop record. Only
      // those browser copies may make room; uncertain receipts are never evicted.
      if (pending.length >= 64) { pending = pending.filter(p => p.status === 'unconfirmed'); save(); if (pending.length >= 64) throw Error('MOBILE_ACTION_UNCONFIRMED'); }
      busy = true;
      try {
        const fields = { id: card.id, version: card.version, decision };
        const start = await request('/mobile/consent/options', fields, session.csrf), assertion = await get(start.publicKey);
        const row = { deviceId: session.deviceId, id: card.id, challengeId: start.challengeId, status: 'unconfirmed' };
        pending.push(row); save(); // Save only receipt identity, never an assertion or biometric/CSRF data.
        const result = await request('/mobile/consent/decide', { ...fields, challengeId: row.challengeId, assertion }, session.csrf);
        if (result.challengeId !== row.challengeId || !['complete', 'not-sent', 'unconfirmed'].includes(result.status)) throw Error('MOBILE_ACTION_UNCONFIRMED');
        row.status = result.status; save(); return result;
      } finally { busy = false; }
    }
    async function receipt(session, row) {
      if (busy || !session || row.deviceId !== session.deviceId) throw Error('MOBILE_RECEIPT_UNAVAILABLE');
      const result = await request('/mobile/consent/receipt', { challengeId: row.challengeId }, session.csrf);
      if (result.challengeId !== row.challengeId || !['complete', 'not-sent', 'unconfirmed'].includes(result.status)) throw Error('MOBILE_ACTION_UNCONFIRMED');
      row.status = result.status; save(); return result;
    }
    return { register,registerCandidate, decide, receipt, get pending() { return pending; }, get busy() { return busy; } };
  }
  const value = { create, options, serialize, KEY };
  if (typeof module === 'object' && module.exports) module.exports = value; else global.NAWMobilePasskeys = value;
})(globalThis);
