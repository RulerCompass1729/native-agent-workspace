// App-local mobile delegation. Importing or constructing starts no connection,
// listener, native session or model work. Transport and desktop UI stay separate.
const fs = require('node:fs'), path = require('node:path');
const { randomUUID, randomBytes, createHash, timingSafeEqual } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { MobileAccess, SESSION_MS, FILE } = require('./mobile-access.cjs');
const { MobileConsent } = require('./mobile-consent.cjs');
const { currentTarget } = require('./mobile-session.cjs');
const { MAX_REQUESTS, ReceiptLedger, confirmedNative } = require('./mobile-receipts.cjs');
const { readLayout } = require('./service-layout.cjs');
const { connect } = require('./service-client.cjs');
const { WorkspaceClient } = require('./workspace-client.cjs');
const denied = (code = 'MOBILE_BROKER_DENIED') => Object.assign(new Error('Mobile authorization or the original session changed. Nothing was retried.'), { code });
const unavailable = () => denied('MOBILE_SOURCE_UNAVAILABLE');
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
// Only these fixed words cross to the phone: how a send would go now, or why it cannot (mobile-session.cjs sendMode).
const SEND_MODES = ['send', 'queue', 'queueMidturn', 'steer'], SEND_BLOCKS = ['steerBusy', 'noQueue', 'queueBusy', 'question', 'answerPending', 'approval', 'interrupt', 'disconnected', 'storage', 'notReady', 'ended'];
const nativePrefix = text => /^[!#/]/.test(text.normalize('NFKC').replace(/^[\s\p{Cc}\p{Default_Ignorable_Code_Point}]+/u, ''));
const receipt = (value, ticket, requestId, action) => {
  if (!value || value.requestId !== requestId || value.sessionId !== ticket.sessionId || value.nativeId !== ticket.nativeId || value.action !== action ||
      !['prepared', 'awaiting-native', 'submitted', 'unconfirmed', 'not-sent', 'reply-written'].includes(value.status)) throw denied('MOBILE_RECEIPT_UNKNOWN');
  return { requestId: value.requestId, sessionId: value.sessionId, action: value.action,
    status: value.status, ...(value.status === 'awaiting-native' && value.queued === true ? { queued: true } : {}), error: value.error, storageWarning: value.storageWarning };
};
// The session row a send was delivered as (mobile-session.cjs receipt). Kept on this side for the queue answer's
// proof; the phone's receipt above does not carry it.
const rowTag = (value, before) => typeof value?.tag === 'string' && value.tag ? value.tag : before;

class MobileBroker {
  #persistence;#endpoint=null;#staging=null;
  #candidate=null; #candidateSerial=0; #activatedCandidate=null;
  #fullLayout = null; #fullGeneration = null; #refreshing = null;
  #access; #root; #scope; #client = null; #epoch = 0; #csrf = null; #changed;
  #contexts = new Map();
  #requests = new ReceiptLedger(row => !row.pending && !row.queueTarget && confirmedNative(row.result));
  #desktop; #human; #workspaceGrant = null; #workspaceRequests = new ReceiptLedger(row => ['complete', 'not-sent'].includes(row.result.status));
  #push = null; #pushOptions; #pushStore;
  #reconnectState = null; #reconnecting = null;
  #consent = new MobileConsent(); #decisions = new ReceiptLedger(row => !row.pending && ['complete', 'not-sent'].includes(row.status)); #consentView = false;
  // changed() runs after the phone pairs or logs out, so the app can close its listener when nothing stays open.
  constructor(root, { exclusive, changed, desktop, onHumanInput = () => {}, pushOptions = {}, persistence } = {}) {
    this.#persistence=persistence||null;
    this.#access = new MobileAccess(root, { exclusive,...(persistence?{transaction:(state,save)=>this.#persist(state,save),pauseTransaction:(state,mirror,save)=>persistence.pause(state,this.#details(state),mirror,save),recover:receipt=>persistence.take(receipt)}:{}) });
    this.#changed = typeof changed === 'function' ? changed : () => {};
    this.#root = this.#access.root;
    this.#desktop = desktop || null;
    this.#human = onHumanInput;
    this.#pushOptions = pushOptions;
    this.#pushStore = pushOptions.persistence || (pushOptions.adapter ? new (require('./mobile-push.cjs').PushStore)(root, { adapter: pushOptions.adapter }) : null);
    // WorkspaceClient shares human boundaries by the exact app scope string.
    // Keep that spelling while separately verifying its canonical authority.
    this.#scope = root;
  }
  async preparePersistence(phase='load'){
    await this.#persistence?.ready?.(phase);
    if(this.#pushStore){
      let state;try{state=this.#access.initialized?this.#access.load():this.#persistence?.checkpoint().authority;}catch{}
      await this.#pushStore.reconcile(state?.enabled&&state.device?this.#pushBinding(state):null,state?.device?.until).catch(()=>{});
    }
  }
  async settlePersistence(quitting=false){
    if(quitting){
      const deadline=performance.now()+5000,remaining=()=>Math.max(0,deadline-performance.now());
      const pairing=this.#persistence?.finish?this.#persistence.finish(remaining()):this.#persistence?.flush?.();
      const push=this.#pushStore?.finish(remaining()).catch(()=>{});
      const [result]=await Promise.all([pairing,push]);return result;
    }
    const result = await this.#persistence?.flush?.();
    await this.#pushStore?.flush().catch(()=>{}); return result;
  }
  #details(state){
    if(this.#staging)return this.#staging;
    return {endpoint:this.#endpoint,all:this.#all(state),workspace:this.#workspaceGrant?.generation===state.generation?this.#workspaceGrant.value:null,
      consent:this.#consent.snapshot(state),consentView:this.#consentView};
  }
  #persist(state,save){
    if(this.#pushStore){const task=state.enabled&&state.device?this.#pushStore.retain(this.#pushBinding(state)):this.#pushStore.clear();task.catch(()=>{});}
    return this.#persistence.commit(state,state.enabled?this.#details(state):null,save);
  }
  #checkpoint(){
    if(!this.#persistence||!this.#access.initialized||this.#access.closed)return;
    try{const state=this.#access.load();if(state.enabled)this.#access.save(state);}
    catch{this.#access.revoke();this.#forget();throw denied('MOBILE_STORAGE');}
  }
  setEndpoint(value){
    this.#access.owner();if(exact(value,['origin','actor','port']))value={...value,binding:null};
    if(!exact(value,['origin','actor','port','binding'])||!Number.isSafeInteger(value.port)||value.port<1024||value.port>65535||
      value.binding!==null&&(!require('./mobile-carrier.cjs').validBinding(value.binding)||!['origin','actor','port'].every(k=>value[k]===value.binding[k])))throw denied();
    this.#endpoint=structuredClone(value);this.#checkpoint();
  }
  resumeInfo(){
    this.#access.owner();if(!this.#persistence||this.#access.initialized)return null;
    try{const c=this.#persistence.checkpoint();if(c.authority.device.until<=this.#access.time()||c.authority.device.until>this.#access.time()+SESSION_MS)return null;return structuredClone(c.details.endpoint);}catch{return null;}
  }
  async resume(validate){
    this.#access.owner();if(typeof validate!=='function'||!this.#persistence||this.#access.initialized)throw denied();
    await this.preparePersistence('restore');
    const checkpoint=this.#persistence.checkpoint(),previous=checkpoint.authority,details=checkpoint.details,serial=++this.#candidateSerial;
    const consent=new MobileConsent();consent.restore(previous,previous,details.consent);
    const client=await connect(this.#scope,'mobile-resume-'+randomUUID());
    try{
      if(serial!==this.#candidateSerial||await validate()!==true||serial!==this.#candidateSerial||!(client instanceof WorkspaceClient)||client.closing||client.socket.destroyed||client.scope!==this.#scope||fs.realpathSync(client.scope)!==this.#root)throw denied();
      const endpoint=this.#endpoint;
      if(!endpoint||!['origin','actor','port'].every(k=>endpoint[k]===details.endpoint[k])||!require('./mobile-carrier.cjs').sameBinding(endpoint.binding,details.endpoint.binding))throw denied();
      const layout=details.all?this.#layout():null,grant=details.workspace===null?null:this.#desktop?.grant(client,details.workspace);
      if(details.workspace!==null&&!grant)throw denied();
      await this.#persistence.confirm?.(checkpoint);
      if(serial!==this.#candidateSerial||await validate()!==true||serial!==this.#candidateSerial||client.closing||client.socket.destroyed)throw denied();
      const result=this.#access.resume(checkpoint,{beforeSave:next=>{
        consent.restore(previous,next,details.consent);this.#staging={...details,endpoint,consent:consent.snapshot(next)};
      }});
      this.#client=client;this.#endpoint=endpoint;this.#fullLayout=layout;this.#fullGeneration=details.all?result.state.generation:null;
      this.#workspaceGrant=grant&&{value:grant,generation:result.state.generation};this.#consent=consent;this.#consentView=details.consentView;
      this.#csrf={generation:result.state.generation,deviceId:result.state.device.id,value:result.csrf};
      this.#watch(client);
      if(details.all)this.#access.syncAllScopes(this.#scopes(result.state));
      await this.settlePersistence();if(!this.#liveGeneration(result.state.generation,client))throw denied();if(this.#persistence.status?.()==='temporary'){this.#access.revoke();this.#forget();this.#disconnect();throw denied('MOBILE_STORAGE');}
      await this.#restorePush(result.state, client);
      if(!this.#liveGeneration(result.state.generation,client))throw denied();
      this.#changed();return {restored:true};
    }catch(error){if(this.#client!==client)try{client.close();}catch{}throw error;}
    finally{this.#staging=null;}
  }
  suspend(){
    this.#access.owner();if(!this.#access.initialized)this.#persistence?.cancelRecovery?.();const result=this.#access.pause();this.#candidateSerial++;let clean=true;
    for(const close of [()=>this.#forget(),()=>this.#dropCandidate(),()=>this.#disconnect()])try{close();}catch{clean=false;}
    return {...result,connectionClosed:clean};
  }
  #forget() { const push = this.#push; this.#push = null;this.#activatedCandidate=null; this.#fullLayout = this.#fullGeneration = this.#refreshing = null; this.#reconnectState = this.#reconnecting = null; this.#epoch++; this.#csrf = null; this.#contexts.clear(); this.#requests.clear(); this.#workspaceGrant = null; this.#workspaceRequests.clear(); this.#consent.revoke(); this.#decisions.clear(); this.#consentView = false; push?.close(); }
  #disconnect() { const client = this.#client; this.#client = null; client?.close(); }
  #liveGeneration(generation,client){
    try{if(this.#client!==client||client.closing||client.socket.destroyed||this.#access.closed||this.#access.disabledMarker())return false;
      const state=this.#access.load();return state.enabled&&state.generation===generation&&state.device.until>this.#access.time();
    }catch{return false;}
  }
  // A reader that cannot be reconnected ends this phone's session. Its push, while still bound to the paired
  // device, says so once and then ends too. Kept here so that a revoke or a new pairing stops it first.
  #lost() { const push = this.#push; this.#push = null; this.#forget(); this.#push = push; this.#disconnect(); push?.end(); }
  #bound() {
    const client = this.#client;
    if (!client && this.#reconnectState) throw unavailable();
    if (!(client instanceof WorkspaceClient) || client.closing || client.socket.destroyed ||
        client.scope !== this.#scope || fs.realpathSync(client.scope) !== this.#root || this.#access.issuer.pid !== process.pid) throw denied();
    return client;
  }
  #authenticate(auth) {
    if (!this.#reconnectState) this.#bound();
    const state = this.#authenticateAccess(auth);
    this.#bound();
    return state;
  }
  #authenticateAccess(auth) {
    if (!auth || typeof auth !== 'object' || Array.isArray(auth) || Object.keys(auth).some(key => !['token', 'actor', 'origin', 'csrf'].includes(key))) throw denied();
    const state = this.#access.authenticate(auth);
    if (auth.origin !== undefined && auth.origin !== state.origin) throw denied();
    return state;
  }
  #identity(state) { return fingerprint([state.issuer, state.generation, state.actor, state.origin, state.device]); }
  #watch(client) { client.once('closed', () => {
    if (this.#client !== client) return;
    try { this.#reconnectState = this.#identity(this.#access.load()); }
    catch { this.#lost(); return; }
    this.#epoch++; this.#contexts.clear(); this.#consent.revoke();
    this.#refreshing = null;
    // The subscription stays through a reconnect: it says the lost service once, and later that it cleared.
    this.#disconnect();
    this.#push?.refresh();
  }); }
  // Only a same-authority session GET replaces this reader; pending writes are never replayed.
  async #recover(auth) {
    const state = this.#authenticateAccess(auth);
    if (this.#client) return;
    const identity = this.#reconnectState, epoch = this.#epoch;
    if (!identity || this.#identity(state) !== identity) throw denied();
    if (this.#reconnecting) { await this.#reconnecting; this.#authenticate(auth); return; }
    const work = async () => {
      let next;
      try {
        next = await connect(this.#scope, 'mobile-' + randomUUID());
        if (epoch !== this.#epoch || identity !== this.#reconnectState || this.#identity(this.#authenticateAccess(auth)) !== identity ||
            !(next instanceof WorkspaceClient) || next.scope !== this.#scope || fs.realpathSync(next.scope) !== this.#root || next.closing || next.socket.destroyed) throw denied();
        this.#client = next; this.#reconnectState = null; this.#epoch++; this.#watch(next);
      } catch (error) {
        if (next && this.#client !== next) next.close();
        if (epoch !== this.#epoch || identity !== this.#reconnectState || this.#identity(this.#authenticateAccess(auth)) !== identity) throw denied();
        throw unavailable();
      }
    };
    const pending = work(); this.#reconnecting = pending;
    try { await pending; } finally { if (this.#reconnecting === pending) this.#reconnecting = null; }
  }
  async #reading(auth, read) {
    const identity = this.#identity(this.#authenticateAccess(auth)), epoch = this.#epoch;
    try { return await read(); }
    catch (error) {
      let current; try { current = this.#identity(this.#authenticateAccess(auth)); } catch { throw error; }
      if (current === identity && (epoch !== this.#epoch || this.#reconnectState)) throw unavailable();
      throw error;
    }
  }
  #writeState(auth) {
    const state = this.#authenticate(auth);
    if (auth.origin !== state.origin || !token(auth.csrf) || !timingSafeEqual(Buffer.from(digest(auth.csrf), 'hex'), Buffer.from(state.device.csrfHash, 'hex'))) throw denied();
    return state;
  }
  #grant(auth, id, action) {
    const state = this.#authenticate(auth), scope = this.#scopes(state).find(value => value.sessionId === id && value.actions.includes(action));
    if (!scope) throw denied();
    const target = { serviceKey: scope.serviceKey, sessionId: scope.sessionId, nativeId: scope.nativeId };
    return { state, scope, ticket: this.#access.authorize({ ...auth, action, target }) };
  }
  #after(auth, ticket, client, epoch) {
    if (client !== this.#bound() || epoch !== this.#epoch) throw denied('MOBILE_RESULT_UNCONFIRMED');
    const fresh = this.#grant(auth, ticket.sessionId, ticket.action).ticket;
    if (fingerprint(fresh) !== fingerprint(ticket)) throw denied('MOBILE_RESULT_UNCONFIRMED');
  }
  #dropCandidate(id) {
    const c=this.#candidate;if(!c || id!==undefined && c.id!==id)return false;
    this.#candidate=null;this.#candidateSerial++;this.#access.cancelCandidate(c.id);c.consent.revoke();c.client.close();return true;
  }
  candidateInfo(id) {
    this.#access.owner();
    try {
      const current=this.#activatedCandidate;
      if(current?.id===id && !this.#access.closed) {
        const s=this.#access.load();
        if(s.enabled && s.device?.until>this.#access.time() && s.generation===current.generation)return current.pending?{...current.pending,state:'redeemed',redeemed:true}:{setupId:id,state:'complete'};
      }
    } catch {}
    return this.#access.candidateInfo(id);
  }
  cancelCandidate(id,{unredeemedOnly=false}={}) {
    this.#access.owner();
    if (unredeemedOnly) {
      const info=this.#access.candidateInfo(id);
      if (info.redeemed) return {cancelled:false,redeemed:true};
      if (!['waiting','expired'].includes(info.state)) return {cancelled:false,unconfirmed:true};
    }
    return {cancelled:this.#dropCandidate(id)};
  }
  #candidateFor(auth,write=false) {
    const c=this.#candidate,state=this.#access.candidateAuthenticate(auth,write);
    if(!c || c.id!==this.#access.candidateStatus()?.id || c.client.closing || c.client.socket.destroyed)throw denied();
    return {c,state};
  }
  async beginCandidate({actor,origin,replace=false,validate=async()=>true,renew=false,refreshOf,automatic=false,endpoint=this.#endpoint}) {
    this.#access.owner();if(this.#persistence?.ready){const epoch=this.#epoch,serial=++this.#candidateSerial;await this.preparePersistence('pair');if(epoch!==this.#epoch||serial!==this.#candidateSerial)throw denied();}if(typeof replace!=='boolean' || typeof validate!=='function')throw denied();
    if (refreshOf!==undefined) this.#access.assertCandidateRefresh(refreshOf,automatic);
    else if (!renew) this.#dropCandidate();
    const serial=++this.#candidateSerial,client=await connect(this.#scope,'mobile-candidate-'+randomUUID());let result;
    try {
      if((refreshOf===undefined && serial!==this.#candidateSerial) || !(client instanceof WorkspaceClient) || client.scope!==this.#scope || fs.realpathSync(client.scope)!==this.#root || client.socket.destroyed)throw denied();
      if(!this.#access.initialized){try{await this.#persistence?.prepareFresh?.();}catch{throw denied('MOBILE_STORAGE');}if(serial!==this.#candidateSerial||client.closing||client.socket.destroyed)throw denied();this.#persistence?.fresh?.();this.#access.initialize();}
      const layout=this.#layout(),grant=this.#desktop?.grant(client,{allRooms:true,records:true});if(!grant)throw denied();
      if (refreshOf!==undefined && await validate()!==true) throw denied('MOBILE_SETUP_UNCONFIRMED');
      // Recheck after all awaits, then replace without yielding to a phone exchange.
      result=this.#access.beginCandidate({actor,origin,replace,renew,refreshOf,automatic});
      this.#dropCandidate();
      const c={id:result.id,client,layout,grant,validate,endpoint,consent:new MobileConsent(),activating:false};this.#candidate=c;
      client.once('closed',()=>{if(this.#candidate===c)this.#dropCandidate(c.id);});
      return {...result,setupId:result.id};
    } catch(error){if(result)this.#access.cancelCandidate(result.id);client.close();throw error;}
  }
  #candidateSession(auth) {
    const {c,state}=this.#candidateFor(auth),consent=c.consent.status(state),status=this.#access.candidateStatus();
    return {candidate:true,deviceId:state.device.id,expiresAt:status.expiresAt,csrf:this.#access.candidateCsrf(auth),sessions:[],consent:{registered:consent.registered,enabled:false,verified:consent.enabled},workspace:false};
  }
  #currentScopes(client) {
    const seen=new Set(),scopes=[];
    for(const entry of client.entries)for(const record of entry.state.sessions){
      if(!currentTarget(record) || !entry.state.capabilities?.includes('humanMobileV1'))continue;
      if(seen.has(record.id))throw denied();seen.add(record.id);
      scopes.push({serviceKey:entry.key,sessionId:record.id,nativeId:record.nativeId,actions:entry.state.capabilities.includes('humanMobilePreparedV1')?['read','send','answer']:['read']});
    }
    return scopes;
  }
  async activateCandidate(auth,value) {
    if(!exact(value,['mode']) || !['verified','basic'].includes(value.mode))throw denied();
    const {c,state}=this.#candidateFor(auth,true);if(c.activating || value.mode==='verified' && !c.consent.status(state).enabled)throw denied();
    c.activating=true;
    try {
      await c.client.refresh();if(await c.validate()!==true)throw denied();
      if(this.#candidateFor(auth,true).c!==c || c.layout!==this.#layout())throw denied();
      // Keep uncertain receipt recovery and in-flight work on its original
      // generation. The person may explicitly revoke instead of replacing.
      if([...this.#requests.values(),...this.#workspaceRequests.values(),...this.#decisions.values()].some(r=>r.pending || ['unconfirmed','prepared','awaiting-native'].includes(r.result?.status) || r.status==='unconfirmed'))throw denied('MOBILE_REQUEST_CONFLICT');
      if(this.#access.load().enabled&&this.#persistence?.prepareReplacement){
        let commit;try{commit=await this.#persistence.prepareReplacement();}catch{try{this.#dropCandidate(c.id);}catch{}throw denied('MOBILE_STORAGE');}
        if(await c.validate()!==true||this.#candidateFor(auth,true).c!==c||c.layout!==this.#layout())throw denied();
        if([...this.#requests.values(),...this.#workspaceRequests.values(),...this.#decisions.values()].some(r=>r.pending||['unconfirmed','prepared','awaiting-native'].includes(r.result?.status)||r.status==='unconfirmed'))throw denied('MOBILE_REQUEST_CONFLICT');
        try{commit();}catch{throw denied('MOBILE_STORAGE');}
      }
      const scopes=this.#currentScopes(c.client);
      this.#push?.close();this.#push=null;
      this.#staging={endpoint:c.endpoint,all:true,workspace:c.grant,consent:value.mode==='verified'?c.consent.snapshot(state):null,consentView:false};
      const pendingInfo=this.#access.candidateInfo(c.id),next=this.#access.activateCandidate(c.id,scopes),old=this.#client;
      this.#forget();this.#client=c.client;this.#endpoint=c.endpoint;this.#candidate=null;this.#candidateSerial++;this.#activatedCandidate={id:c.id,generation:next.generation,pending:pendingInfo};
      this.#fullLayout=c.layout;this.#fullGeneration=next.generation;this.#workspaceGrant={value:c.grant,generation:next.generation};
      this.#consent=c.consent;if(value.mode==='basic')this.#consent.revoke();
      this.#csrf={generation:next.generation,deviceId:next.device.id,value:auth.csrf};
      this.#watch(c.client);
      try{old?.close();if(old && (!old.closing || !old.socket.destroyed))throw denied();}
      catch{this.revoke();this.#changed();throw denied('MOBILE_CLEANUP_UNCONFIRMED');}
      await this.settlePersistence();if(!this.#liveGeneration(next.generation,c.client))throw denied();this.#activatedCandidate={id:c.id,generation:next.generation};this.#changed();
      return {activated:true,sensitiveDecisions:value.mode==='verified'};
    } finally {this.#staging=null;c.activating=false;}
  }
  // Only the local desktop owner may call this method. Never expose a generic
  // RPC dispatcher that lets a remote request choose this method or its scope.
  async beginPairing({ actor, origin, selection, replace = false, workspace, all = false }) {
    if(this.#persistence?.ready){const epoch=this.#epoch,serial=++this.#candidateSerial;await this.preparePersistence('pair');if(epoch!==this.#epoch||serial!==this.#candidateSerial)throw denied();}
    this.#access.owner();
    this.#dropCandidate();
    if (typeof all !== 'boolean' || all && (selection !== undefined || workspace !== undefined)) throw denied();
    if (all) selection = [];
    if (!Array.isArray(selection) || !all && !selection.length || selection.length > MAX_REQUESTS || typeof replace !== 'boolean' ||
        selection.some(value => !exact(value, ['sessionId', 'actions']) || typeof value.sessionId !== 'string' ||
          !Array.isArray(value.actions) || !value.actions.includes('read') || value.actions.some(action => !['read', 'send', 'answer'].includes(action)) || new Set(value.actions).size !== value.actions.length) ||
        new Set(selection.map(value => value.sessionId)).size !== selection.length) throw denied();
    if (this.#access.initialized) {
      const old = this.#access.load();
      if (old.device && old.device.until > this.#access.time() && !replace) throw denied('MOBILE_REPLACE_REQUIRED');
      if(old.enabled&&this.#persistence?.prepareReplacement){
        try{const commit=await this.#persistence.prepareReplacement();commit();}catch{throw denied('MOBILE_STORAGE');}
      }
      const revoked = this.#access.revoke(); this.#forget(); this.#disconnect();
      if (!revoked.confirmed) throw denied('MOBILE_REVOCATION_UNCONFIRMED');
    } else { this.#forget(); this.#disconnect(); }
    const epoch = this.#epoch;
    const client = await connect(this.#scope, 'mobile-' + randomUUID());
    if (epoch !== this.#epoch) { client.close(); throw denied(); }
    this.#client = client;
    this.#watch(client);
    try {
      this.#bound();
      const scopes = selection.map(value => {
        const entry = client.route(value.sessionId), record = entry.state.sessions.find(row => row.id === value.sessionId);
        if (!record || record.archived || record.nativeContextPending || typeof record.nativeId !== 'string' || !record.nativeId ||
            !entry.state.capabilities?.includes('humanMobileV1') || value.actions.some(action => action !== 'read') && !entry.state.capabilities.includes('humanMobilePreparedV1')) throw denied();
        return { serviceKey: entry.key, sessionId: record.id, nativeId: record.nativeId, actions: [...value.actions] };
      });
      const workspaceGrant = all ? this.#desktop?.grant(client, { allRooms: true, records: true }) : workspace === undefined ? null : this.#desktop?.grant(client, workspace);
      if (all && !workspaceGrant) throw denied();
      if (workspace !== undefined && !workspaceGrant) throw denied();
      if (!this.#access.initialized) {try{await this.#persistence?.prepareFresh?.();}catch{throw denied('MOBILE_STORAGE');}if(epoch!==this.#epoch||this.#bound()!==client)throw denied();this.#persistence?.fresh?.();this.#access.initialize();}
      const layout = all ? this.#layout() : null;
      const result = this.#access.beginPairing({ actor, origin, scopes, replace, all });
      this.#fullLayout = layout;
      this.#fullGeneration = all ? this.#access.load().generation : null;
      if (all) this.#access.syncAllScopes(this.#scopes(this.#access.load()));
      this.#workspaceGrant = workspaceGrant && { value: workspaceGrant, generation: this.#access.load().generation };
      return result;
    } catch (error) { this.#forget(); this.#disconnect(); throw error; }
  }
  pair(value) {
    if (!exact(value, ['secret', 'actor', 'origin'])) throw denied();
    if(this.#candidate && this.#access.candidateStatus()) {
      const c=this.#candidate;
      return (async()=>{
        if(await c.validate()!==true || this.#candidate!==c || c.id!==this.#access.candidateStatus()?.id)throw denied();
        const paired=this.#access.pairCandidate(value),state=this.#access.candidateAuthenticate({token:paired.cookieValue,actor:value.actor,origin:value.origin});
        c.consent.beginQrRegistration(state);this.#changed();
        const result={candidate:true,deviceId:paired.deviceId,expiresAt:paired.expiresAt};Object.defineProperty(result,'cookieValue',{value:paired.cookieValue});return Object.freeze(result);
      })();
    }
    this.#bound();
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
    try{return this.#candidateSession(auth);}catch{}
    const state = this.#authenticate(auth), csrf = this.#csrf;
    if (!csrf || csrf.generation !== state.generation || csrf.deviceId !== state.device.id || digest(csrf.value) !== state.device.csrfHash) throw denied('MOBILE_REPAIR_REQUIRED');
    const consent = this.#consent.status(state);
    return { deviceId: state.device.id, expiresAt: state.device.until, csrf: csrf.value, consent: { registered: consent.registered, enabled: consent.enabled },
      ...(this.#workspaceGrant || this.#consentView ? { workspace: true } : {}),
      sessions: this.#scopes(state).filter(value => value.actions.includes('read')).map(value => {
        const base = { id: value.sessionId, actions: [...value.actions] };
        try {
          const entry = this.#bound().route(value.sessionId), record = entry.state.sessions.find(row => row.id === value.sessionId);
          if (entry.key !== value.serviceKey || !record || record.archived || record.nativeContextPending || record.nativeId !== value.nativeId) return { ...base, available: false };
          const field = (input, max) => typeof input === 'string' && input.length <= max && input.isWellFormed() ? input : null;
          return { ...base, available: true, name: field(record.name, 200), provider: field(record.provider, 40), state: field(record.state, 80) };
        } catch { return { ...base, available: false }; }
      }) };
  }
  #layout() {
    const layout = readLayout(this.#root);
    if (layout.pending) throw denied();
    return JSON.stringify([...layout.entries].sort());
  }
  #scopes(state) {
    if (!this.#all(state)) return state.scopes;
    if (this.#layout() !== this.#fullLayout) throw denied('MOBILE_RESULT_UNCONFIRMED');
    return this.#currentScopes(this.#bound());
  }
  #all(state) { return this.#fullLayout !== null && this.#fullGeneration === state.generation; }
  async #refreshFull(auth) {
    const state = this.#authenticate(auth);
    if (!this.#all(state)) return;
    if (this.#refreshing) { await this.#refreshing; this.#authenticate(auth); return; }
    const work = async () => {
      const layout = this.#layout(), epoch = this.#epoch;
      if (layout !== this.#fullLayout) {
        if ([...this.#requests.values(), ...this.#workspaceRequests.values()].some(r => r.pending)) throw denied('MOBILE_REQUEST_CONFLICT');
        const next = await connect(this.#scope, 'mobile-' + randomUUID());
        try {
          const fresh = this.#authenticate(auth);
          if (epoch !== this.#epoch || fresh.generation !== state.generation || layout !== this.#layout() || !(next instanceof WorkspaceClient) || fs.realpathSync(next.scope) !== this.#root || next.socket?.destroyed) throw denied();
          const old = this.#client; this.#client = next; this.#epoch++; this.#contexts.clear(); this.#fullLayout = layout;
          this.#watch(next);
          old.close();
        } catch (error) { if (this.#client !== next) next.close(); throw error; }
      }
      const client = this.#bound(), current = this.#epoch; await client.refresh();
      if (client !== this.#bound() || current !== this.#epoch || state.generation !== this.#authenticate(auth).generation || this.#fullLayout !== this.#layout()) throw denied();
      this.#access.syncAllScopes(this.#scopes(this.#authenticate(auth)));
    };
    const pending = work(); this.#refreshing = pending;
    try { await pending; } finally { if (this.#refreshing === pending) this.#refreshing = null; }
  }
  async refreshSession(auth) { try{return this.#candidateSession(auth);}catch{} return this.#reading(auth, async () => { await this.#recover(auth); await this.#refreshFull(auth); return this.session(auth); }); }
  async read(auth, id) {
    this.#authenticate(auth); return this.#reading(auth, () => this.#read(auth, id));
  }
  async #read(auth, id) {
    if (this.#all(this.#authenticate(auth))) await this.#refreshFull(auth);
    const { ticket, scope } = this.#grant(auth, id, 'read'), client = this.#bound(), epoch = this.#epoch;
    const row = await client.call('mobileRead', ticket);
    this.#after(auth, ticket, client, epoch);
    if (this.#all(this.#authenticate(auth)) && !currentTarget(row)) throw denied();
    if (!row || row.id !== ticket.sessionId || row.nativeId !== ticket.nativeId || !row.proof || row.proof.nativeId !== ticket.nativeId) throw denied();
    const contextId = randomBytes(32).toString('base64url');
    if (this.#contexts.size >= MAX_REQUESTS) this.#contexts.delete(this.#contexts.keys().next().value);
    this.#contexts.set(contextId, { ticket, proof: structuredClone(row.proof), sendMode: row.sendMode, questionId: row.question?.requestId || null });
    return { contextId, id: row.id, provider: row.provider, name: row.name, state: row.state,
      canSend: scope.actions.includes('send') && row.canSend === true,
      sendMode: scope.actions.includes('send') && row.canSend === true && SEND_MODES.includes(row.sendMode) ? row.sendMode : null,
      sendBlocked: !scope.actions.includes('send') ? 'readOnly' : row.canSend !== true && SEND_BLOCKS.includes(row.sendBlocked) ? row.sendBlocked : null,
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
  async workspaceRead(auth, selection) {
    this.#authenticate(auth); return this.#reading(auth, () => this.#workspaceRead(auth, selection));
  }
  async #workspaceRead(auth, selection) {
    if (this.#all(this.#authenticate(auth))) await this.#refreshFull(auth);
    const state = this.#workspaceState(auth), client = this.#bound(), epoch = this.#epoch, scopes = this.#scopes(state);
    const grant = this.#workspaceGrant?.value || { roomIds: [], records: false };
    const result = await this.#desktop.read(client, grant, scopes, selection);
    if (epoch !== this.#epoch || client !== this.#bound()) throw denied();
    const currentScopes = this.#scopes(this.#workspaceState(auth));
    if (selection?.kind === 'session') {
      const before = scopes.find(s => s.sessionId === selection.id && s.actions.includes('read'));
      const after = currentScopes.find(s => s.sessionId === selection.id && s.actions.includes('read'));
      const route = client.route(selection.id), record = route.state.sessions.find(s => s.id === selection.id);
      if (!before || !after || before.nativeId !== after.nativeId || before.serviceKey !== after.serviceKey || route.key !== before.serviceKey ||
          !record || record.archived || record.nativeContextPending || record.nativeId !== before.nativeId) throw denied();
    }
    if (selection?.kind === 'room') {
      const current = this.#desktop.snapshot(client);
      if (!this.#desktop.resolveGrant(grant, current).roomIds.includes(selection.id) ||
          !(current.rooms || [current.room]).some(r => r?.id === selection.id && !r.archived)) throw denied();
    }
    const consent = this.#consent.status(state);
    result.capabilities.sensitiveDecisions = consent.enabled;
    result.capabilities.push = this.#workspaceGrant?.value.records === true;
    for (const card of result.confirmations) card.canDecide = Boolean(consent.enabled && card.version && card.state === 'confirmation-required' && !card.disposition && card.expiresAt > Date.now());
    return result;
  }
  // What a subscription lives by: the paired device alone, so that a lost service can still be reported.
  #pushBinding(s) { return fingerprint([s.actor, s.origin, s.device.id, s.device.tokenHash, s.device.until]); }
  async #restorePush(state, client) {
    if(!this.#pushStore || this.#workspaceGrant?.value.records !== true)return;
    const valid=()=>this.#liveGeneration(state.generation,client)&&this.#pushAuthority();
    let saved;
    try { saved=await this.#pushStore.load(this.#pushBinding(state),state.device.until,valid); }
    catch { if(valid())await this.#pushStore.clear().catch(()=>{}); return; }
    if(!valid())return;
    if(!saved)return;
    try { this.#makePush().restore(saved); this.refreshPush(); }
    catch { this.#push?.close(); this.#push=null; if(valid())await this.#pushStore.clear().catch(()=>{}); }
  }
  #pushDevice() {
    try {
      if (this.#access.closed || this.#access.disabledMarker()) return null;
      const s = this.#access.load();
      if (!s.enabled || !s.device || s.device.until <= this.#access.time()) { this.#pushStore?.clear().catch(()=>{}); return null; }
      return fingerprint([s.issuer, s.generation, s.device.id, s.device.until]);
    } catch { return null; }
  }
  // Who may subscribe and read the count: that device, connected, holding the reminders permission.
  #pushAuthority() {
    try {
      this.#bound();
      if (this.#workspaceGrant?.generation !== this.#access.load().generation || this.#workspaceGrant.value.records !== true) return null;
      return this.#pushDevice();
    } catch { return null; }
  }
  #pushAlerts() {
    const alerts = []; let client = null, status = null;
    try { client = this.#bound(); } catch { alerts.push({ code: 'service-disconnected' }); }
    // The app judges waiting cards from the same reminder status the count comes from.
    try { if (client && this.#pushAuthority()) status = this.#desktop.records.status(null, client); } catch { status = null; }
    const source = this.#pushOptions.alerts;
    if (!source) return { alerts, unknown: [] };
    let more; try { more = source(status); } catch { more = null; }
    // The lost service is known here. When the app cannot answer, every other code is unknown, never "no problems".
    if (!more || !Array.isArray(more.alerts)) return { alerts, unknown: require('./mobile-push.cjs').ALERTS.filter(code => code !== 'service-disconnected') };
    return { alerts: alerts.concat(more.alerts), unknown: Array.isArray(more.unknown) ? more.unknown : [] };
  }
  pushInfo(auth) {
    this.#workspaceState(auth);
    if (!this.#pushAuthority()) throw denied();
    return this.#makePush().configuration();
  }
  #makePush() {
    return this.#push ||= new (require('./mobile-push.cjs').MobilePush)({ ...this.#pushOptions, authority: () => this.#pushDevice(),
      count: () => this.#pushAuthority() ? this.#desktop.records.status(null, this.#bound()).count : null, alerts: () => this.#pushAlerts(), expired: () => { this.#pushStore?.clear().catch(()=>{}); } });
  }
  pushAction(auth, value) {
    if (exact(value, ['action']) && value.action === 'unsubscribe') {
      const state=this.#authenticateAccess(auth);
      if(auth.origin!==state.origin||!token(auth.csrf)||!timingSafeEqual(Buffer.from(digest(auth.csrf),'hex'),Buffer.from(state.device.csrfHash,'hex')))throw denied();
      this.#push?.close(); this.#push = null;
      const off={enabled:false,state:'off',lastSubmittedAt:null};
      return this.#pushStore?this.#pushStore.clear().then(()=>off,()=>({...off,storageWarning:'MOBILE_PUSH_STORAGE_UNCONFIRMED'})):off;
    }
    this.#workspaceState(auth, true);
    if (!exact(value, ['action', 'subscription']) || value.action !== 'subscribe') throw denied();
    this.pushInfo(auth); const push=this.#push, subscription=require('./mobile-push.cjs').subscriptionValue(value.subscription);
    const activate=()=>{this.#workspaceState(auth,true);if(this.#push!==push)throw denied();push.subscribe(subscription);this.refreshPush();return push.status();};
    if(!this.#pushStore)return activate();
    const state=this.#authenticateAccess(auth),binding=this.#pushBinding(state),stamp=this.#pushDevice();
    return this.#pushStore.save(binding,state.device.until,{vapid:push.keys,subscription},()=>this.#push===push&&this.#pushDevice()===stamp).then(activate);
  }
  refreshPush() { return this.#push?.refresh(); }
  #desktopConsentState() {
    this.#bound(); const s = this.#access.load();
    if (this.#access.closed || !s.enabled || !s.device || s.device.until <= this.#access.time() || this.#access.disabledMarker()) throw denied();
    return s;
  }
  approvalStatus() {
    try { const s = this.#desktopConsentState(); return { paired: true, origin: s.origin, ...this.#consent.status(s),...(this.#persistence?.status?.()==='temporary'?{temporaryPairing:true}:{}) }; }
    catch {
      const resumeRequired = Boolean(this.resumeInfo());
      return { paired: false, enabled: false, registered: false, pending: null, ...(resumeRequired ? { resumeRequired: true } :
        this.#persistence && !this.#access.initialized && fs.existsSync(path.join(this.#root, FILE)) ? { reconnectRequired: true } : {}) };
    }
  }
  approvalBegin() { try{return this.#consent.beginRegistration(this.#desktopConsentState());}finally{this.#checkpoint();} }
  approvalConfirm(value) { const result=this.#consent.confirmRegistration(this.#desktopConsentState(), value);this.#checkpoint();return result; }
  approvalEnable(value) {
    const result = this.#consent.setEnabled(this.#desktopConsentState(), value);
    // Enabling cards also exposes their read projection for already-paired
    // sessions. It grants no rooms or reminders, and survives key revocation so
    // the phone can still check its original card/receipt without approving.
    if (result.enabled && this.#desktop) this.#consentView = true;
    this.#checkpoint();
    return result;
  }
  approvalRevoke() { this.#consent.revoke();this.#checkpoint();return { enabled: false, registered: false }; }
  registrationOptions(auth, value) {
    let candidate;try{candidate=this.#candidateFor(auth,true);}catch{}
    return candidate?candidate.c.consent.qrOptions(candidate.state,value):this.#consent.registrationOptions(this.#writeState(auth),value);
  }
  registerPasskey(auth, value) {
    let candidate;try{candidate=this.#candidateFor(auth,true);}catch{}
    if(!candidate)return this.#consent.register(this.#writeState(auth),value);
    if(!exact(value,['registrationId','credential']))throw denied();
    const result=candidate.c.consent.register(candidate.state,value);return {publicKey:result.publicKey};
  }
  registrationProof(auth, value) {
    let candidate;try{candidate=this.#candidateFor(auth,true);}catch{}
    if(!candidate)return this.#consent.proveRegistration(this.#writeState(auth),value);
    if(!exact(value,['registrationId','assertion']))throw denied();
    return {verified:candidate.c.consent.completeQrRegistration(candidate.state,value).enabled};
  }
  async decisionOptions(auth, value) {
    if (!exact(value, ['id', 'version', 'decision'])) throw denied();
    this.#workspaceState(auth, true);
    const client = this.#bound(), epoch = this.#epoch; await client.refresh();
    if (epoch !== this.#epoch || client !== this.#bound()) throw denied();
    const state = this.#workspaceState(auth, true), binding = this.#desktop.confirmationBinding(client, this.#scopes(state), value);
    this.#decisions.assertAvailable();
    return this.#consent.challenge(state, binding);
  }
  async decide(auth, value) {
    if (!exact(value, ['id', 'version', 'decision', 'challengeId', 'assertion'])) throw denied();
    const state = this.#workspaceState(auth, true), client = this.#bound(), epoch = this.#epoch;
    const binding = this.#desktop.confirmationBinding(client, this.#scopes(state), value), permit = this.#consent.consume(state, value, binding);
    const row = { challengeId: value.challengeId, status: 'unconfirmed', state: null, pending:true }; this.#decisions.reserve(value.challengeId, row);
    const valid = () => {
      if (epoch !== this.#epoch || client !== this.#bound()) throw denied();
      return this.#workspaceState(auth, true);
    };
    try {
      const result = await this.#desktop.decision(client, this.#scopes(state), structuredClone(value), permit, valid);
      row.state = result.state;
      row.status = ['complete', 'cancelled', 'not-executed', 'confirmation-required'].includes(result.state) ? 'complete' : 'unconfirmed';
    } catch (error) { if (error.notSent === true) row.status = 'not-sent'; } finally {row.pending=false;}
    valid(); return structuredClone(row);
  }
  decisionReceipt(auth, value) {
    this.#workspaceState(auth, true);
    if (!exact(value, ['challengeId']) || !uuid(value.challengeId)) throw denied('MOBILE_RECEIPT_UNKNOWN');
    const row = this.#decisions.get(value.challengeId) || this.#decisions.retired(value.challengeId);
    if (!row) throw denied('MOBILE_RECEIPT_UNKNOWN');
    return structuredClone(row);
  }
  async workspaceAction(auth, value) {
    this.#workspaceState(auth, true);
    if (!value || typeof value !== 'object' || Array.isArray(value) || !uuid(value.requestId)) throw denied();
    if (value.action === 'receipt' && exact(value, ['action', 'requestId'])) {
      const result = this.#workspaceRequests.get(value.requestId)?.result || this.#workspaceRequests.retired(value.requestId);
      if (!result) throw denied('MOBILE_RECEIPT_UNKNOWN');
      return structuredClone(result);
    }
    if (!['queueAdd', 'queueCancel', 'queueResolve', 'recordAcknowledge'].includes(value.action)) throw denied();
    const mark = fingerprint(value), previous = this.#workspaceRequests.get(value.requestId);
    if (previous) {
      if (previous.mark !== mark) throw denied('MOBILE_REQUEST_CONFLICT');
      return structuredClone(previous.result);
    }
    const row = { mark, result: { requestId: value.requestId, status: 'unconfirmed' } };
    this.#workspaceRequests.reserve(value.requestId, row);
    const client = this.#bound(), epoch = this.#epoch, grant = this.#workspaceGrant?.value || { roomIds: [], records: false };
    const valid = () => {
      if (epoch !== this.#epoch || client !== this.#bound()) throw denied();
      this.#workspaceState(auth, true);
    };
    try {
      const answerProof = () => {
        valid();
        const entry = this.#requests.get(value.answerRequestId), target = entry?.queueTarget;
        if (!entry || entry.action !== 'send' || entry.pending || entry.result.status !== 'submitted' || entry.result.storageWarning ||
            !target || target.roomId !== value.roomId || target.itemId !== value.itemId || target.questionId !== value.questionId) throw Object.assign(denied(), { notSent: true });
        this.#after(auth, entry.ticket, client, epoch);
        return { requestId: value.answerRequestId, sessionId: entry.ticket.sessionId, nativeId: entry.ticket.nativeId,
          serviceKey: entry.ticket.serviceKey, text: entry.spec.text, ...(entry.tag ? { tag: entry.tag } : {}) };
      };
      const result = await this.#desktop.action(client, grant, structuredClone(value), valid, answerProof);
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
    const keys = action === 'send' ? ['contextId', 'requestId', 'text', ...(Object.hasOwn(value || {}, 'queueTarget') ? ['queueTarget'] : [])] : ['contextId', 'requestId', 'answers'];
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
    if (!context) throw denied('MOBILE_CONTEXT_UNAVAILABLE');
    const { ticket } = this.#grant(auth, context.ticket.sessionId, action);
    if (ticket.deviceId !== context.ticket.deviceId || ticket.generation !== context.ticket.generation || ticket.nativeId !== context.ticket.nativeId || ticket.serviceKey !== context.ticket.serviceKey) throw denied();
    let queueTarget;
    if (Object.hasOwn(value, 'queueTarget')) {
      const grant = this.#workspaceGrant?.value;
      this.#workspaceState(auth, true);
      if (action !== 'send' || !grant || typeof this.#desktop.queueAnswerTarget !== 'function' || context.sendMode === 'steer' || context.proof.sendMode === 'steer' || value.text.length > 6000) throw denied();
      queueTarget = this.#desktop.queueAnswerTarget(this.#bound(), grant, value.queueTarget);
      if (queueTarget.sessionId !== ticket.sessionId || queueTarget.nativeId !== ticket.nativeId || queueTarget.serviceKey !== ticket.serviceKey) throw denied();
    }
    const spec = { requestId: value.requestId, proof: structuredClone(context.proof),
      ...(action === 'send' ? { text: value.text } : { questionId: context.questionId, answers: structuredClone(value.answers) }) };
    if (action === 'answer' && !uuid(spec.questionId)) throw denied();
    const client = this.#bound(), epoch = this.#epoch, entry = { action, input, ticket, spec, ...(queueTarget ? { queueTarget } : {}), pending: null, result:{status:'unconfirmed'} };
    this.#requests.reserve(value.requestId, entry);
    this.#human(ticket.sessionId);
    entry.pending = (async () => {
      try {
        const result = await client.call(action === 'send' ? 'mobileSend' : 'mobileAnswer', ticket, spec);
        this.#after(auth, ticket, client, epoch); entry.result=receipt(result, ticket, value.requestId, action);
        entry.tag = rowTag(result, entry.tag); return entry.result;
      } catch (error) {
        if (error.uiMessage?.key !== 'error.mobile.receiptLimit') throw error;
        this.#after(auth, ticket, client, epoch);
        this.#requests.release(value.requestId, entry);
        throw denied('MOBILE_PAIR_LIMIT');
      } finally { entry.pending = null; }
    })();
    return entry.pending;
  }
  send(auth, value) { return this.#submit(auth, value, 'send'); }
  answer(auth, value) { return this.#submit(auth, value, 'answer'); }
  async receipt(auth, requestId) {
    if (!uuid(requestId)) throw denied();
    this.#writeState(auth);
    const retired = this.#requests.retired(requestId);
    if (retired) {
      this.#grant(auth, retired.sessionId, retired.action);
      return structuredClone(retired);
    }
    const entry = this.#requests.get(requestId);
    if (!entry) throw denied('MOBILE_RECEIPT_UNKNOWN');
    const { ticket } = this.#grant(auth, entry.ticket.sessionId, entry.action), client = this.#bound(), epoch = this.#epoch;
    const result = await client.call(entry.action === 'send' ? 'mobileSendReceipt' : 'mobileAnswerReceipt', ticket, entry.spec);
    this.#after(auth, ticket, client, epoch); entry.result=receipt(result, ticket, requestId, entry.action);
    entry.tag = rowTag(result, entry.tag); return entry.result;
  }
  logout(auth) {
    // Revocation needs the phone's authority and CSRF, never an online backend.
    let candidate;try{candidate=this.#candidateFor(auth,true);}catch{}
    if(candidate){try{this.#dropCandidate(candidate.c.id);}finally{this.#changed();}return {authorizationRevoked:true,connectionClosed:true,committedWorkMayContinue:false};}
    const state = this.#authenticateAccess(auth);
    if (auth.origin !== state.origin || !token(auth.csrf) || !timingSafeEqual(Buffer.from(digest(auth.csrf), 'hex'), Buffer.from(state.device.csrfHash, 'hex'))) throw denied();
    try { return this.revoke(); }
    finally { this.#changed(); }
  }
  // Until when the app's listener is needed: an unexpired pairing link or paired device. 0 when nothing is open,
  // including when access is closed or the state is unreadable. The OFF marker is written only when a revocation could
  // not be saved (which also closes access); it voids a device here too, as authentication already does.
  openUntil() {
    const candidate=this.#access.candidateStatus();
    let candidateUntil=candidate?.expiresAt || 0;
    if (this.#candidate) {
      let info;try{info=this.#access.candidateInfo(this.#candidate.id);}catch{info={state:'unconfirmed'};}
      if (!info.redeemed && ['waiting','expired'].includes(info.state) && info.renewUntil>this.#access.time()) candidateUntil=info.renewUntil;
      else if (!candidate) this.#dropCandidate();
    }
    try {
      if (!this.#access.initialized || this.#access.closed) return candidateUntil;
      let off = true;
      try { off = this.#access.disabledMarker(); } catch { off = true; }
      const s = this.#access.load(), time = this.#access.time();
      const until = Math.max(s.pairing ? s.pairing.until : 0, s.enabled && s.device && !off ? s.device.until : 0);
      return Math.max(until > time ? until : 0,candidateUntil);
    } catch { return candidateUntil; }
  }
  revoke() {
    const retryPersistence=this.#persistence?.status?.()==='temporary';
    this.#candidateSerial++;
    let result, cleanupFailed = false;
    // Authorization must fail closed before any transport/observer can throw.
    // Attempt every cleanup even if an earlier one failed; never report success
    // for an unconfirmed close. Cancelling only a candidate remains separate.
    try {
      if(this.#access.initialized)result=this.#access.revoke();
      else if(this.#persistence){
        try{this.#persistence.revoke();result={confirmed:true};}
        finally{if(!this.#access.invalidate())result={confirmed:false};}
      }else result={confirmed:true};
    }
    finally {
      for (const cleanup of [() => this.#forget(), () => this.#dropCandidate(), () => this.#disconnect()]) {
        try { cleanup(); } catch { cleanupFailed = true; }
      }
    }
    if (cleanupFailed) throw denied('MOBILE_CLEANUP_UNCONFIRMED');
    // Closing only this broker's own connection invalidates its uncommitted
    // reservations. A commit already written may still be native work.
    const summary={ authorizationRevoked: result.confirmed === true, connectionClosed: true, committedWorkMayContinue: true };
    const pushRevoked=result.confirmed===true?this.#pushStore?.clear():null;pushRevoked?.catch(()=>{});
    let resultSummary=summary;
    if(this.#persistence?.flush){const confirmed=retryPersistence&&this.#persistence.sealRevocation?this.#persistence.sealRevocation():this.#persistence.flush().then(()=>this.#persistence.status()==='ready');resultSummary=confirmed.then(ok=>({...summary,authorizationRevoked:summary.authorizationRevoked&&ok}),()=>({...summary,authorizationRevoked:false}));}
    return pushRevoked?Promise.resolve(resultSummary).then(async value=>{await pushRevoked;return value;}):resultSummary;
  }
}
module.exports = { MobileBroker };
