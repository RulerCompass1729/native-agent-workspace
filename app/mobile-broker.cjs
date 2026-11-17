// App-local mobile delegation. Importing or constructing starts no connection,
// listener, native session or model work. Transport and desktop UI stay separate.
const fs = require('node:fs');
const { randomUUID, randomBytes, createHash, timingSafeEqual } = require('node:crypto');
const { MobileAccess } = require('./mobile-access.cjs');
const { MobileConsent } = require('./mobile-consent.cjs');
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
// A leading ! (shell), # (memory) or / (command) has meaning in a native terminal. Phone text is plain prompt text, so
// it is refused before any record or call. The check folds compatibility forms (so full-width ！＃／ count) and looks
// past leading whitespace, control characters and invisible characters that trim() keeps (U+0085, U+200B and other
// default-ignorables). The same rule is in mobile-web/client.js and mobile-session.cjs.
const nativePrefix = text => /^[!#/]/.test(text.normalize('NFKC').replace(/^[\s\p{Cc}\p{Default_Ignorable_Code_Point}]+/u, ''));
const receipt = (value, ticket, requestId, action) => {
  if (!value || value.requestId !== requestId || value.sessionId !== ticket.sessionId || value.nativeId !== ticket.nativeId || value.action !== action ||
      !['prepared', 'awaiting-native', 'submitted', 'unconfirmed', 'not-sent', 'reply-written'].includes(value.status)) throw denied('MOBILE_RECEIPT_UNKNOWN');
  return { requestId: value.requestId, sessionId: value.sessionId, action: value.action,
    status: value.status, error: value.error, storageWarning: value.storageWarning };
};

class MobileBroker {
  #access; #root; #scope; #client = null; #epoch = 0; #csrf = null; #changed;
  #contexts = new Map(); #requests = new Map();
  #desktop; #human; #workspaceGrant = null; #workspaceRequests = new Map();
  #push = null; #pushOptions;
  #consent = new MobileConsent(); #decisions = new Map(); #consentView = false;
  // changed() runs after the phone pairs or logs out, so the app can close its listener when nothing stays open.
  constructor(root, { exclusive, changed, desktop, onHumanInput = () => {}, pushOptions = {} } = {}) {
    this.#access = new MobileAccess(root, { exclusive });
    this.#changed = typeof changed === 'function' ? changed : () => {};
    this.#root = this.#access.root;
    this.#desktop = desktop || null;
    this.#human = onHumanInput;
    this.#pushOptions = pushOptions;
    // WorkspaceClient shares human boundaries by the exact app scope string.
    // Keep that spelling while separately verifying its canonical authority.
    this.#scope = root;
  }
  #forget() { this.#push?.close(); this.#push = null; this.#epoch++; this.#csrf = null; this.#contexts.clear(); this.#requests.clear(); this.#workspaceGrant = null; this.#workspaceRequests.clear(); this.#consent.revoke(); this.#decisions.clear(); this.#consentView = false; }
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
  async beginPairing({ actor, origin, selection, replace = false, workspace }) {
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
      const workspaceGrant = workspace === undefined ? null : this.#desktop?.grant(client, workspace);
      if (workspace !== undefined && !workspaceGrant) throw denied();
      if (!this.#access.initialized) this.#access.initialize();
      const result = this.#access.beginPairing({ actor, origin, scopes, replace });
      this.#workspaceGrant = workspaceGrant && { value: workspaceGrant, generation: this.#access.load().generation };
      return result;
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
    this.#changed();
    return Object.freeze(result);
  }
  session(auth) {
    const state = this.#authenticate(auth), csrf = this.#csrf;
    if (!csrf || csrf.generation !== state.generation || csrf.deviceId !== state.device.id || digest(csrf.value) !== state.device.csrfHash) throw denied('MOBILE_REPAIR_REQUIRED');
    const consent = this.#consent.status(state);
    return { deviceId: state.device.id, expiresAt: state.device.until, csrf: csrf.value, consent: { registered: consent.registered, enabled: consent.enabled },
      ...(this.#workspaceGrant || this.#consentView ? { workspace: true } : {}),
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
  #workspaceState(auth, write = false) {
    const state = write ? this.#writeState(auth) : this.#authenticate(auth);
    if (!this.#desktop || !this.#workspaceGrant && !this.#consentView || this.#workspaceGrant && this.#workspaceGrant.generation !== state.generation) throw denied();
    return state;
  }
  async workspaceRead(auth) {
    const state = this.#workspaceState(auth), client = this.#bound(), epoch = this.#epoch;
    const result = await this.#desktop.read(client, this.#workspaceGrant?.value || { roomIds: [], records: false }, state.scopes);
    if (epoch !== this.#epoch || client !== this.#bound()) throw denied();
    this.#workspaceState(auth);
    const consent = this.#consent.status(state);
    result.capabilities.sensitiveDecisions = consent.enabled;
    for (const card of result.confirmations) card.canDecide = Boolean(consent.enabled && card.version && card.state === 'confirmation-required' && !card.disposition && card.expiresAt > Date.now());
    return result;
  }
  #pushAuthority() {
    try {
      this.#bound();
      if (this.#access.closed || this.#access.disabledMarker()) return null;
      const s = this.#access.load();
      if (!s.enabled || !s.device || s.device.until <= this.#access.time() ||
          this.#workspaceGrant?.generation !== s.generation || this.#workspaceGrant.value.records !== true) return null;
      return fingerprint([s.issuer, s.generation, s.device.id, s.device.until]);
    } catch { return null; }
  }
  pushInfo(auth) {
    this.#workspaceState(auth);
    if (!this.#pushAuthority()) throw denied();
    this.#push ||= new (require('./mobile-push.cjs').MobilePush)({ ...this.#pushOptions,
      authority: () => this.#pushAuthority(), count: () => this.#desktop.records.status(null, this.#bound()).count });
    return this.#push.configuration();
  }
  pushAction(auth, value) {
    this.#workspaceState(auth, true);
    if (exact(value, ['action']) && value.action === 'unsubscribe') {
      this.#push?.close(); this.#push = null;
      return { enabled: false, state: 'off', lastSubmittedAt: null };
    }
    if (!exact(value, ['action', 'subscription']) || value.action !== 'subscribe') throw denied();
    this.pushInfo(auth); this.#push.subscribe(value.subscription); this.refreshPush();
    return this.#push.status();
  }
  refreshPush() { return this.#push?.refresh(); }
  #desktopConsentState() {
    this.#bound(); const s = this.#access.load();
    if (this.#access.closed || !s.enabled || !s.device || s.device.until <= this.#access.time() || this.#access.disabledMarker()) throw denied();
    return s;
  }
  approvalStatus() {
    try { const s = this.#desktopConsentState(); return { paired: true, origin: s.origin, ...this.#consent.status(s) }; }
    catch { return { paired: false, enabled: false, registered: false, pending: null }; }
  }
  approvalBegin() { return this.#consent.beginRegistration(this.#desktopConsentState()); }
  approvalConfirm(value) { return this.#consent.confirmRegistration(this.#desktopConsentState(), value); }
  approvalEnable(value) {
    const result = this.#consent.setEnabled(this.#desktopConsentState(), value);
    // Enabling cards also exposes their read projection for already-paired
    // sessions. It grants no rooms or reminders, and survives key revocation so
    // the phone can still check its original card/receipt without approving.
    if (result.enabled && this.#desktop) this.#consentView = true;
    return result;
  }
  approvalRevoke() { this.#consent.revoke(); return { enabled: false, registered: false }; }
  registrationOptions(auth, value) { return this.#consent.registrationOptions(this.#writeState(auth), value); }
  registerPasskey(auth, value) { return this.#consent.register(this.#writeState(auth), value); }
  registrationProof(auth, value) { return this.#consent.proveRegistration(this.#writeState(auth), value); }
  async decisionOptions(auth, value) {
    if (!exact(value, ['id', 'version', 'decision'])) throw denied();
    this.#workspaceState(auth, true);
    const client = this.#bound(), epoch = this.#epoch; await client.refresh();
    if (epoch !== this.#epoch || client !== this.#bound()) throw denied();
    const state = this.#workspaceState(auth, true), binding = this.#desktop.confirmationBinding(client, state.scopes, value);
    return this.#consent.challenge(state, binding);
  }
  async decide(auth, value) {
    if (!exact(value, ['id', 'version', 'decision', 'challengeId', 'assertion'])) throw denied();
    const state = this.#workspaceState(auth, true), client = this.#bound(), epoch = this.#epoch;
    const binding = this.#desktop.confirmationBinding(client, state.scopes, value), permit = this.#consent.consume(state, value, binding);
    if (this.#decisions.size >= MAX_REQUESTS) throw denied();
    const row = { challengeId: value.challengeId, status: 'unconfirmed', state: null }; this.#decisions.set(value.challengeId, row);
    const valid = () => {
      if (epoch !== this.#epoch || client !== this.#bound()) throw denied();
      return this.#workspaceState(auth, true);
    };
    try {
      const result = await this.#desktop.decision(client, state.scopes, structuredClone(value), permit, valid);
      row.state = result.state;
      row.status = ['complete', 'cancelled', 'not-executed', 'confirmation-required'].includes(result.state) ? 'complete' : 'unconfirmed';
    } catch (error) { if (error.notSent === true) row.status = 'not-sent'; }
    valid(); return structuredClone(row);
  }
  decisionReceipt(auth, value) {
    this.#workspaceState(auth, true);
    if (!exact(value, ['challengeId']) || !uuid(value.challengeId) || !this.#decisions.has(value.challengeId)) throw denied('MOBILE_RECEIPT_UNKNOWN');
    return structuredClone(this.#decisions.get(value.challengeId));
  }
  async workspaceAction(auth, value) {
    this.#workspaceState(auth, true);
    if (!value || typeof value !== 'object' || Array.isArray(value) || !uuid(value.requestId)) throw denied();
    if (value.action === 'receipt' && exact(value, ['action', 'requestId'])) {
      const previous = this.#workspaceRequests.get(value.requestId);
      if (!previous) throw denied('MOBILE_RECEIPT_UNKNOWN');
      return structuredClone(previous.result);
    }
    if (!['queueAdd', 'queueCancel', 'queueResolve', 'recordAcknowledge'].includes(value.action)) throw denied();
    const mark = fingerprint(value), previous = this.#workspaceRequests.get(value.requestId);
    if (previous) {
      if (previous.mark !== mark) throw denied('MOBILE_REQUEST_CONFLICT');
      return structuredClone(previous.result);
    }
    // Do not evict uncertain outcomes: a repeated ID must never execute twice.
    if (this.#workspaceRequests.size >= MAX_REQUESTS) throw denied('MOBILE_REQUEST_CONFLICT');
    const row = { mark, result: { requestId: value.requestId, status: 'unconfirmed' } };
    this.#workspaceRequests.set(value.requestId, row);
    const client = this.#bound(), epoch = this.#epoch, grant = this.#workspaceGrant?.value || { roomIds: [], records: false };
    const valid = () => {
      if (epoch !== this.#epoch || client !== this.#bound()) throw denied();
      this.#workspaceState(auth, true);
    };
    try {
      const result = await this.#desktop.action(client, grant, structuredClone(value), valid);
      valid();
      row.result = { requestId: value.requestId, status: result.status === 'complete' ? 'complete' : 'unconfirmed',
        ...(typeof result.itemId === 'string' ? { itemId: result.itemId } : {}) };
    } catch (error) {
      // A business write may already be durable: report uncertainty and never retry.
      row.result = { requestId: value.requestId, status: error.notSent === true ? 'not-sent' : 'unconfirmed' };
    }
    valid(); return structuredClone(row.result);
  }
  async #submit(auth, value, action) {
    const keys = action === 'send' ? ['contextId', 'requestId', 'text'] : ['contextId', 'requestId', 'answers'];
    if (!exact(value, keys) || !token(value.contextId) || !uuid(value.requestId) ||
        action === 'send' && (typeof value.text !== 'string' || !value.text.trim() || value.text.length > 16000 || !value.text.isWellFormed() || nativePrefix(value.text)) ||
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
    this.#human(ticket.sessionId);
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
    const result = this.revoke();
    this.#changed();
    return result;
  }
  // Until when the app's listener is needed: an unexpired pairing link or paired device. 0 when nothing is open,
  // including when access is closed or the state is unreadable. The OFF marker is written only when a revocation could
  // not be saved (which also closes access); it voids a device here too, as authentication already does.
  openUntil() {
    try {
      if (!this.#access.initialized || this.#access.closed) return 0;
      let off = true;
      try { off = this.#access.disabledMarker(); } catch { off = true; }
      const s = this.#access.load(), time = this.#access.time();
      const until = Math.max(s.pairing ? s.pairing.until : 0, s.enabled && s.device && !off ? s.device.until : 0);
      return until > time ? until : 0;
    } catch { return 0; }
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
