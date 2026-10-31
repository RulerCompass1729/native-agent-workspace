// App-local mobile delegation. Importing or constructing starts no connection,
// listener, native session or model work. Transport and desktop UI stay separate.
const fs = require('node:fs');
const { randomUUID, randomBytes, createHash, timingSafeEqual } = require('node:crypto');
const { MobileAccess } = require('./mobile-access.cjs');
const { MAX_REQUESTS } = require('./mobile-session.cjs');
const { connect } = require('./service-client.cjs');
const { WorkspaceClient } = require('./workspace-client.cjs');
const denied = (code = 'MOBILE_BROKER_DENIED') => Object.assign(new Error('Mobile authorization or the original session changed. Nothing was retried.'), { code });
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const token = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const digest = value => createHash('sha256').update(value).digest('hex');
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const fingerprint = value => digest(JSON.stringify(stable(value)));
const receipt = (value, ticket, requestId, action) => {
  if (!value || value.requestId !== requestId || value.sessionId !== ticket.sessionId || value.nativeId !== ticket.nativeId || value.action !== action ||
      !['prepared', 'awaiting-native', 'submitted', 'unconfirmed', 'not-sent', 'reply-written'].includes(value.status)) throw denied('MOBILE_RECEIPT_UNKNOWN');
  return { requestId: value.requestId, sessionId: value.sessionId, action: value.action,
    status: value.status, error: value.error, storageWarning: value.storageWarning };
};

class MobileBroker {
  #access; #root; #scope; #client = null; #epoch = 0; #csrf = null;
  #contexts = new Map(); #requests = new Map();
  constructor(root, { exclusive } = {}) {
    this.#access = new MobileAccess(root, { exclusive });
    this.#root = this.#access.root;
    // WorkspaceClient shares human boundaries by the exact app scope string.
    // Keep that spelling while separately verifying its canonical authority.
    this.#scope = root;
  }
  #forget() { this.#epoch++; this.#csrf = null; this.#contexts.clear(); this.#requests.clear(); }
  #disconnect() { const client = this.#client; this.#client = null; client?.close(); }
  #bound() {
    const client = this.#client;
    if (!(client instanceof WorkspaceClient) || client.closing || client.socket.destroyed ||
        client.scope !== this.#scope || fs.realpathSync(client.scope) !== this.#root || this.#access.issuer.pid !== process.pid) throw denied();
    return client;
  }
  #authenticate(auth) {
    if (!auth || typeof auth !== 'object' || Array.isArray(auth) || Object.keys(auth).some(key => !['token', 'actor', 'origin', 'csrf'].includes(key))) throw denied();
    this.#bound();
    const state = this.#access.authenticate(auth);
    if (auth.origin !== undefined && auth.origin !== state.origin) throw denied();
    return state;
  }
  #writeState(auth) {
    const state = this.#authenticate(auth);
    if (auth.origin !== state.origin || !token(auth.csrf) || !timingSafeEqual(Buffer.from(digest(auth.csrf), 'hex'), Buffer.from(state.device.csrfHash, 'hex'))) throw denied();
    return state;
  }
  #grant(auth, id, action) {
    const state = this.#authenticate(auth), scope = state.scopes.find(value => value.sessionId === id && value.actions.includes(action));
    if (!scope) throw denied();
    const target = { serviceKey: scope.serviceKey, sessionId: scope.sessionId, nativeId: scope.nativeId };
    return { state, scope, ticket: this.#access.authorize({ ...auth, action, target }) };
  }
  #after(auth, ticket, client, epoch) {
    if (client !== this.#bound() || epoch !== this.#epoch) throw denied('MOBILE_RESULT_UNCONFIRMED');
    const fresh = this.#grant(auth, ticket.sessionId, ticket.action).ticket;
    if (fingerprint(fresh) !== fingerprint(ticket)) throw denied('MOBILE_RESULT_UNCONFIRMED');
  }
  // Only the local desktop owner may call this method. Never expose a generic
  // RPC dispatcher that lets a remote request choose this method or its scope.
  async beginPairing({ actor, origin, selection, replace = false }) {
    this.#access.owner();
    if (!Array.isArray(selection) || !selection.length || selection.length > MAX_REQUESTS || typeof replace !== 'boolean' ||
        selection.some(value => !exact(value, ['sessionId', 'actions']) || typeof value.sessionId !== 'string' ||
          !Array.isArray(value.actions) || !value.actions.includes('read') || value.actions.some(action => !['read', 'send', 'answer'].includes(action)) || new Set(value.actions).size !== value.actions.length) ||
        new Set(selection.map(value => value.sessionId)).size !== selection.length) throw denied();
    if (this.#access.initialized) {
      const old = this.#access.load();
      if (old.device && old.device.until > this.#access.time() && !replace) throw denied('MOBILE_REPLACE_REQUIRED');
      const revoked = this.#access.revoke(); this.#forget(); this.#disconnect();
      if (!revoked.confirmed) throw denied('MOBILE_REVOCATION_UNCONFIRMED');
    } else { this.#forget(); this.#disconnect(); }
    const epoch = this.#epoch;
    const client = await connect(this.#scope, 'mobile-' + randomUUID());
    if (epoch !== this.#epoch) { client.close(); throw denied(); }
    this.#client = client;
    client.once('closed', () => { if (this.#client === client) { this.#forget(); this.#disconnect(); } });
    try {
      this.#bound();
      const scopes = selection.map(value => {
        const entry = client.route(value.sessionId), record = entry.state.sessions.find(row => row.id === value.sessionId);
        if (!record || record.archived || record.nativeContextPending || typeof record.nativeId !== 'string' || !record.nativeId ||
            !entry.state.capabilities?.includes('humanMobileV1') || value.actions.some(action => action !== 'read') && !entry.state.capabilities.includes('humanMobilePreparedV1')) throw denied();
        return { serviceKey: entry.key, sessionId: record.id, nativeId: record.nativeId, actions: [...value.actions] };
      });
      if (!this.#access.initialized) this.#access.initialize();
      return this.#access.beginPairing({ actor, origin, scopes, replace });
    } catch (error) { this.#forget(); this.#disconnect(); throw error; }
  }
  pair(value) {
    this.#bound();
    if (!exact(value, ['secret', 'actor', 'origin'])) throw denied();
    const paired = this.#access.pair(value), state = this.#access.authenticate({ token: paired.cookieValue, actor: value.actor });
    this.#contexts.clear(); this.#requests.clear();
    this.#csrf = { generation: state.generation, deviceId: state.device.id, value: paired.csrf };
    // Preserve the existing non-enumerable cookie contract. A future HTTP
    // adapter may put it in Set-Cookie only, never JSON or a URL.
    const result = { deviceId: paired.deviceId, expiresAt: paired.expiresAt };
    Object.defineProperty(result, 'cookieValue', { value: paired.cookieValue });
    return Object.freeze(result);
  }
  session(auth) {
    const state = this.#authenticate(auth), csrf = this.#csrf;
    if (!csrf || csrf.generation !== state.generation || csrf.deviceId !== state.device.id || digest(csrf.value) !== state.device.csrfHash) throw denied('MOBILE_REPAIR_REQUIRED');
    return { deviceId: state.device.id, expiresAt: state.device.until, csrf: csrf.value,
      sessions: state.scopes.filter(value => value.actions.includes('read')).map(value => {
        const base = { id: value.sessionId, actions: [...value.actions] };
        try {
          const entry = this.#bound().route(value.sessionId), record = entry.state.sessions.find(row => row.id === value.sessionId);
          if (entry.key !== value.serviceKey || !record || record.archived || record.nativeContextPending || record.nativeId !== value.nativeId) return { ...base, available: false };
          const field = (input, max) => typeof input === 'string' && input.length <= max && input.isWellFormed() ? input : null;
          return { ...base, available: true, name: field(record.name, 200), provider: field(record.provider, 40), state: field(record.state, 80) };
        } catch { return { ...base, available: false }; }
      }) };
  }
  async read(auth, id) {
    const { ticket, scope } = this.#grant(auth, id, 'read'), client = this.#bound(), epoch = this.#epoch;
    const row = await client.call('mobileRead', ticket);
    this.#after(auth, ticket, client, epoch);
    if (!row || row.id !== ticket.sessionId || row.nativeId !== ticket.nativeId || !row.proof || row.proof.nativeId !== ticket.nativeId) throw denied();
    const contextId = randomBytes(32).toString('base64url');
    if (this.#contexts.size >= MAX_REQUESTS) this.#contexts.delete(this.#contexts.keys().next().value);
    this.#contexts.set(contextId, { ticket, proof: structuredClone(row.proof), questionId: row.question?.requestId || null });
    return { contextId, id: row.id, provider: row.provider, name: row.name, state: row.state,
      canSend: scope.actions.includes('send') && row.canSend === true,
      question: row.question && scope.actions.includes('answer') ? { questions: row.question.questions.map(value => ({
        id: value.id, header: value.header, question: value.question, multiSelect: value.multiSelect, isOther: value.isOther,
        options: value.options.map(option => ({ label: option.label, description: option.description })),
      })) } : null,
      questionOmitted: row.questionOmitted, messages: row.messages.map(value => ({
        id: value.id, kind: value.kind, status: value.status, text: value.text, textOmitted: value.textOmitted, unsupportedAttachments: value.unsupportedAttachments,
      })), earlierMessagesOmitted: row.earlierMessagesOmitted };
  }
  async #submit(auth, value, action) {
    const keys = action === 'send' ? ['contextId', 'requestId', 'text'] : ['contextId', 'requestId', 'answers'];
    if (!exact(value, keys) || !token(value.contextId) || !uuid(value.requestId) ||
        action === 'send' && (typeof value.text !== 'string' || !value.text.trim() || value.text.length > 16000 || !value.text.isWellFormed()) ||
        action === 'answer' && (!value.answers || typeof value.answers !== 'object' || Array.isArray(value.answers))) throw denied();
    if (Buffer.byteLength(JSON.stringify(value)) > 65536) throw denied();
    this.#writeState(auth);
    const previous = this.#requests.get(value.requestId), input = fingerprint(value);
    if (previous) {
      if (previous.action !== action || previous.input !== input) throw denied('MOBILE_REQUEST_CONFLICT');
      this.#grant(auth, previous.ticket.sessionId, action);
      if (previous.pending) return previous.pending;
      return this.receipt(auth, value.requestId);
    }
    const context = this.#contexts.get(value.contextId);
    if (this.#requests.size >= MAX_REQUESTS) throw denied('MOBILE_PAIR_LIMIT');
    if (!context) throw denied('MOBILE_CONTEXT_UNAVAILABLE');
    const { ticket } = this.#grant(auth, context.ticket.sessionId, action);
    if (ticket.deviceId !== context.ticket.deviceId || ticket.generation !== context.ticket.generation || ticket.nativeId !== context.ticket.nativeId || ticket.serviceKey !== context.ticket.serviceKey) throw denied();
    const spec = { requestId: value.requestId, proof: structuredClone(context.proof),
      ...(action === 'send' ? { text: value.text } : { questionId: context.questionId, answers: structuredClone(value.answers) }) };
    if (action === 'answer' && !uuid(spec.questionId)) throw denied();
    const client = this.#bound(), epoch = this.#epoch, entry = { action, input, ticket, spec, pending: null };
    this.#requests.set(value.requestId, entry);
    entry.pending = (async () => {
      try {
        const result = await client.call(action === 'send' ? 'mobileSend' : 'mobileAnswer', ticket, spec);
        this.#after(auth, ticket, client, epoch); return receipt(result, ticket, value.requestId, action);
      } finally { entry.pending = null; }
    })();
    return entry.pending;
  }
  send(auth, value) { return this.#submit(auth, value, 'send'); }
  answer(auth, value) { return this.#submit(auth, value, 'answer'); }
  async receipt(auth, requestId) {
    if (!uuid(requestId)) throw denied();
    this.#writeState(auth);
    const entry = this.#requests.get(requestId);
    if (!entry) throw denied('MOBILE_RECEIPT_UNKNOWN');
    const { ticket } = this.#grant(auth, entry.ticket.sessionId, entry.action), client = this.#bound(), epoch = this.#epoch;
    const result = await client.call(entry.action === 'send' ? 'mobileSendReceipt' : 'mobileAnswerReceipt', ticket, entry.spec);
    this.#after(auth, ticket, client, epoch); return receipt(result, ticket, requestId, entry.action);
  }
  logout(auth) {
    // Logging out a read-only device must not require send permission. It
    // still requires an explicit same-origin, session-bound CSRF token.
    this.#writeState(auth);
    return this.revoke();
  }
  revoke() {
    this.#forget();
    let result;
    try { result = this.#access.initialized ? this.#access.revoke() : { confirmed: true }; }
    finally { this.#disconnect(); }
    // Closing only this broker's own connection invalidates its uncommitted
    // reservations. A commit already written may still be native work.
    return { authorizationRevoked: result.confirmed === true, connectionClosed: true, committedWorkMayContinue: true };
  }
}
module.exports = { MobileBroker };
