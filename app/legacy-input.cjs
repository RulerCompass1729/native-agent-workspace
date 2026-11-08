const { uiError, uiNotice, setWarning } = require('./ui-errors.cjs');
const { displayMessage } = require('./ui-locale.js');
// Explicit, same-process compatibility for inspected alpha.2 native hosts.
// Native hooks remain the sole writer of conversation history. This transport
// records dispatch metadata and explicitly shared text only. It never calls
// the old paste/Enter sender or infers which native reply may be shared.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { createSubmissionServer } = require('./claude-submit.cjs');
const { supportsLegacyObservation } = require('./legacy-observation.cjs');
const { processMayBeAlive, processIdentity } = require('./platform.cjs');
const { LegacyCodex, eligibleCodex, retainedSocket } = require('./legacy-codex.cjs');
const { LegacyClaude, readerPath } = require('./legacy-claude.cjs');
const { LegacyShared } = require('./legacy-shared.cjs');
const { installPlugin } = require('./claude-compat-plugin.cjs');
const { prepareManagedRecipient } = require('./managed-outbox-transport.cjs');

function eligible(state, record) {
  return eligibleCodex(state, record) || (supportsLegacyObservation(state, record) && /^[a-f0-9-]{36}$/i.test(record.nativeId || '')
    && Number.isSafeInteger(record.pid) && record.pid > 1);
}
function privateDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw uiError("error.legacy.inputDirectoryPermissions");
}
class LegacyInput extends EventEmitter {
  constructor(dataDir) {
    super(); this.dataDir = dataDir; this.servers = new Map(); this.targets = new Map(); this.readers = new Map(); this.pendingPrepare = new Map(); this.readerFailures = new Map(); this.outboxReceipts = new Map();
    this.filename = path.join(dataDir, 'legacy-dispatches.json'); this.records = []; this.closed = false; this.connecting = new Set(); this.readerGenerations = new Map();
    this.managedOutboxTargets = new Map();
    try { this.records = JSON.parse(fs.readFileSync(this.filename, 'utf8')); if (!Array.isArray(this.records)) throw Error('Invalid ledger'); }
    catch (e) { if (e.code !== 'ENOENT') this.storageError = true; }
    this.sharedReplies = new LegacyShared(dataDir, () => this.emit('change'));
  }
  save() {
    if (this.storageError) throw uiError("error.legacy.submissionRecordUnreadable");
    const temp = this.filename + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(this.records), { mode: 0o600 }); fs.renameSync(temp, this.filename);
  }
  saveLink(entry, record, readerStarted = false) {
    // Read at the synchronous commit point: another session may have connected
    // while this one awaited its native handshake.
    const filename = path.join(this.dataDir, 'legacy-links.json');
    let links = []; try { links = JSON.parse(fs.readFileSync(filename, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (!Array.isArray(links)) throw uiError("error.legacy.connectionRecordUnreadable");
    const previous = links.find(link => link.id === record.id && link.pid === record.pid && link.nativeId === record.nativeId);
    if (previous) { if (!readerStarted || previous.readerStarted) return; previous.readerStarted = true; }
    else links.push({ id: record.id, pid: record.pid, nativeId: record.nativeId, key: entry.key, ...(readerStarted ? { readerStarted: true } : {}) });
    const temp = filename + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
    try { fs.writeFileSync(temp, JSON.stringify(links), { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, filename); }
    finally { try { fs.unlinkSync(temp); } catch {} }
  }
  target(record) {
    if (!record) return null;
    const t = this.targets.get(record.id);
    return t && t.record.nativeId === record.nativeId && t.record.pid === record.pid ? t : null;
  }
  outboxTarget(record) {
    const target = record && this.managedOutboxTargets.get(record.id);
    return target?.record.nativeId === record.nativeId && target.record.pid === record.pid ? target : this.target(record);
  }
  async prepareOutbox(entry, record, grant) {
    if (this.closed || this.managedOutboxTargets.has(record.id)) throw uiError('error.nativeToolOriginUnconfirmed');
    const generation = this.readerGenerations.get(record.id) || 0;
    const target = await prepareManagedRecipient(entry, record, grant);
    if (this.closed || this.managedOutboxTargets.has(record.id) || (this.readerGenerations.get(record.id) || 0) !== generation) {
      await target.native.close(); throw uiError('error.nativeToolOriginUnconfirmed');
    }
    this.managedOutboxTargets.set(record.id, target); return target;
  }
  releaseOutbox(record, target) {
    if (target?.managed && this.managedOutboxTargets.get(record.id) === target) {
      for (const watch of this.outboxReceipts.values()) if (watch.sessionId === record.id) watch.close();
      this.managedOutboxTargets.delete(record.id); return target.native.close();
    }
  }
  localDispatchCount() { return this.records.filter(row => !row.managed).length; }
  effectiveState(record) {
    const target = this.target(record);
    // The retained Codex transport is the same authenticated native source
    // used by the reader. Its old host may still report the pre-interrupt state.
    // Never reuse an idle value after this connection has closed.
    if (target?.native) return target.native.connected && !target.native.closed ? target.native.state : 'disconnected';
    return target?.effectiveState?.(record) || record?.state;
  }
  connected(record) { return !!this.target(record)?.submission.connected; }
  prepared(record) { return !!this.target(record); }
  reader(record) { const reader = this.readers.get(record.id); return reader?.record.nativeId === record.nativeId ? reader : null; }
  readerUnavailable(record) { return this.readerFailures.get(record.id) === record.nativeId; }
  observeReader(target, message) {
    if (!message || this.closed || this.targets.get(target.record.id) !== target) return;
    // A fresh, authenticated native input can settle its historical receipt
    // after GUI exit. This is not a submission ACK or authority to share replies.
    if (target.retainedReader && target.record.provider === 'claude' &&
      message.nativeBlock === true && message.role === 'user' && message.kind === 'input' &&
      message.status === 'complete' && !message.incomplete && typeof message.inputTag === 'string' &&
      message.nativeId === target.record.nativeId &&
      message.id?.startsWith(`native:${message.nativeId}:prompt:`) &&
      /^[a-f0-9-]{36}$/i.test(message.id.slice(`native:${message.nativeId}:prompt:`.length))) {
      const row = this.records.find(row => row.id === message.inputTag && row.shared === true && row.inputMode === 'queue' &&
        row.sessionId === target.record.id && row.nativeId === message.nativeId && row.text === message.text);
      if (row && row.status !== 'accepted' && !this.storageError) {
        const previous = { status: row.status, replyPrivate: row.replyPrivate }; row.status = 'accepted';
        const grant = this.sharedReplies.grants.get(row.id);
        if (!grant || grant.closed) row.replyPrivate = true;
        try { this.save(); }
        catch {
          Object.assign(row, previous); this.storageError = true;
          setWarning(this, 'storageWarning', 'error.warning.legacyReceiptUnsaved');
        }
        this.emit('change');
      }
    }
    this.sharedReplies.observed(target, message);
  }
  sharedMessages() {
    const status = row => row.status === 'accepted' ? 'submitted' :
      this.targets.get(row.sessionId)?.pendingQueue === row.id ? 'awaiting-native' : 'unconfirmed';
    return [...this.records.filter(row => row.shared === true).map(row => ({
      id: row.id, role: row.senderId ? 'assistant' : 'human', ...(row.senderId ? { sessionId: row.senderId, senderNativeId: row.senderNativeId } : {}), recipientId: row.sessionId, name: row.name, ...(row.uiNameMessage ? { uiNameMessage: row.uiNameMessage } : {}), text: row.text, time: row.time,
      status: status(row), manualReply: row.sharedReply !== true || row.replyPrivate === true,
      ...(row.inputMode ? { inputMode: row.inputMode } : {}),
      deliveryTracked: true, ...(row.replyTo ? { replyTo: row.replyTo } : {}),
      deliveries: [{ id: row.id, recipientId: row.sessionId, recipientName: row.recipientName || row.name, text: row.text,
        status: status(row), time: row.time }],
    })), ...this.sharedReplies.snapshot()];
  }
  clearSharedHistory(ids = this.sharedMessages().map(row => row.id)) {
    this.sharedReplies.clear(ids);
    const selected = new Set(ids);
    const previous = this.records;
    this.records = previous.map(row => {
      if (!selected.has(row.id)) return row;
      const { text, name, uiNameMessage, recipientName, shared, replyTo, ...metadata } = row; return metadata;
    });
    try { this.save(); } catch (error) { this.records = previous; throw error; }
    this.emit('change');
  }
  forgetReader(record) {
    const managed = this.managedOutboxTargets.get(record.id);
    if (managed?.record.nativeId === record.nativeId) { this.managedOutboxTargets.delete(record.id); managed.native.close().catch(() => {}); }
    for (const watch of this.outboxReceipts.values()) if (watch.sessionId === record.id) watch.close();
    this.readerGenerations.set(record.id, (this.readerGenerations.get(record.id) || 0) + 1);
    // Revoke unpublished handshakes too. Their late RPC responses cannot
    // recreate a projection, connection reference or writer after deletion.
    for (const native of this.connecting) if (native.record.id === record.id && native.record.nativeId === record.nativeId) native.close();
    this.reader(record)?.close(); this.readers.delete(record.id);
    const target = this.targets.get(record.id);
    if (target?.record.nativeId === record.nativeId) {
      target.reader?.close(); target.submission.close();
      target.server?.targets.delete(target.token);
      if (target.descriptor) fs.rmSync(target.descriptor, { force: true });
      this.targets.delete(record.id);
    }
    if (['claude', 'codex'].includes(record.provider) && record.nativeId) fs.rmSync(readerPath(this.dataDir, record.nativeId), { force: true });
    const filename = path.join(this.dataDir, 'legacy-links.json');
    if (fs.existsSync(filename)) {
      const links = JSON.parse(fs.readFileSync(filename, 'utf8'));
      if (!Array.isArray(links)) throw uiError("error.legacy.connectionIndexCleanupFailed");
      const temporary = filename + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
      try {
        fs.writeFileSync(temporary, JSON.stringify(links.filter(link => link.id !== record.id || link.nativeId !== record.nativeId)), { mode: 0o600, flag: 'wx' });
        fs.renameSync(temporary, filename);
      } finally { fs.rmSync(temporary, { force: true }); }
    }
    this.readerFailures.delete(record.id);
  }
  async prepare(entry, record) {
    if (this.closed) throw uiError("error.legacy.windowClosed");
    if (this.pendingPrepare.has(record.id)) return this.pendingPrepare.get(record.id);
    const work = this.prepareOnce(entry, record).finally(() => this.pendingPrepare.delete(record.id));
    this.pendingPrepare.set(record.id, work); return work;
  }
  async prepareOnce(entry, record) {
    const generation = this.readerGenerations.get(record.id) || 0;
    const checkOpen = () => {
      if (this.closed) throw uiError("error.legacy.windowClosed");
      if ((this.readerGenerations.get(record.id) || 0) !== generation) throw uiError("error.legacy.sessionRemovedConnectionCancelled");
    };
    checkOpen();
    if (!eligible(entry.state, record) || record.processIdentity?.pid !== record.pid || !processMayBeAlive(record.processIdentity)) throw uiError("error.legacy.nativeStateChangedNoConnection");
    const existing = this.target(record);
    if (existing && (!existing.native || existing.native.connected)) return true;
    // Retain the last-known reader while reconnecting. A failed handshake must
    // not erase history that the old service never recorded. close() disables
    // sending; only a successful replacement may take over this target.
    if (existing) existing.submission.close();
    const connectionFile = path.join(this.dataDir, entry.key, 'connection.json');
    const stat = fs.lstatSync(connectionFile);
    if (stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw uiError("error.legacy.connectionFilePermissions");
    const connection = JSON.parse(fs.readFileSync(connectionFile, 'utf8'));
    if (connection.pid !== entry.state.servicePid) throw uiError("error.legacy.connectionChangedNoInputConnection");
    const directory = path.dirname(connection.endpoint); privateDirectory(directory);
    if (record.provider === 'codex') {
      const cached = existing?.native?.record;
      this.reader(record)?.close();
      let native;
      try {
        native = new LegacyCodex(cached ? { ...record, messages: cached.messages } : record, this.dataDir);
        if (this.readerUnavailable(record) && !native.initialized) throw uiError("error.legacy.readerUnavailable");
      } catch (error) { this.readerFailures.set(record.id, record.nativeId); this.emit('change'); throw error; }
      const target = { record: { ...record }, submission: native, native, reader: native, get sharedReplyAvailable() { return native.sharedReplyAvailable; } };
      this.connecting.add(native);
      try {
        await native.connect(retainedSocket(this.dataDir, entry, record)); checkOpen();
        if (native.storageError) throw uiError("error.legacy.readerSaveFailed");
        this.saveLink(entry, record, true);
        this.targets.set(record.id, target);
        this.readers.set(record.id, native); this.readerFailures.delete(record.id);
        native.on('change', () => this.emit('change'));
        native.on('progress', update => this.emit('progress', { id: record.id, ...update }));
        native.on('readerBlock', message => { if (message) this.sharedReplies.observed(native, message); });
        const metadata = () => { if (this.sharedReplies.restoreTurnMetadata(native.record)) this.sharedReplies.scheduleSave(); };
        native.on('readerMetadata', metadata); metadata();
        native.on('replyBound', identity => this.sharedReplies.bindNative(native, identity));
        native.on('complete', info => this.sharedReplies.completeNative(native, info));
        for (const event of ['nativeInput', 'approval', 'failed', 'fleet']) native.on(event, () => this.sharedReplies.revoke(record.id, '原生输入、权限或运行状态已改变；后续内容留在原会话', uiNotice('notice.sharing.nativeControlChanged').uiMessage));
        native.on('state', state => { if (!['idle', 'working'].includes(state)) this.sharedReplies.revoke(record.id, '原生运行状态已改变；后续内容留在原会话', uiNotice('notice.sharing.nativeStateChanged').uiMessage); });
        for (const event of ['complete', 'nativeInput', 'approval', 'failed', 'fleet']) native.on(event, (...args) => this.emit(event, record.id, ...args));
      } catch (error) { native.close(); throw error; }
      finally { this.connecting.delete(native); }
      this.emit('change'); return true;
    }
    installPlugin(record.cwd);
    let server = this.servers.get(directory);
    if (!server) {
      const socket = path.join(directory, 'gui-submit.sock');
      const ownerFile = path.join(directory, 'gui-owner.json');
      if (fs.existsSync(ownerFile)) {
        const st = fs.lstatSync(ownerFile);
        if (st.isSymbolicLink() || st.uid !== process.getuid() || st.mode & 0o077) throw uiError("error.legacy.inputRecordPermissions");
        const previous = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
        if (processMayBeAlive(previous)) throw uiError("error.legacy.inputConnectionExists");
        if (fs.existsSync(socket)) { if (!fs.lstatSync(socket).isSocket()) throw uiError("error.legacy.inputAddressOccupied"); fs.unlinkSync(socket); }
        fs.unlinkSync(ownerFile);
      } else if (fs.existsSync(socket)) throw uiError("error.legacy.inputAddressOccupiedNoReplace");
      fs.writeFileSync(ownerFile, JSON.stringify(processIdentity(process.pid)), { mode: 0o600, flag: 'wx' });
      const targets = new Map(), transport = createSubmissionServer(socket, targets, {
        restrictedOutboxCall: (proof, signal) => {
          if (this.closed || typeof this.restrictedOutboxCall !== 'function') throw Object.assign(Error('Restricted outbox is unavailable'), { notSent: true });
          return this.restrictedOutboxCall(proof, signal);
        },
        backgroundControlCall: (proof, signal) => {
          if (this.closed || typeof this.backgroundControlCall !== 'function') throw Error('Background control is unavailable');
          return this.backgroundControlCall(proof, signal);
        },
      });
      try { await transport.start(); checkOpen(); }
      catch (e) { transport.server.closeAllConnections(); transport.server.close(); fs.unlinkSync(ownerFile); throw e; }
      server = { transport, targets, socket, ownerFile }; this.servers.set(directory, server);
    }
    let target;
    try {
      this.reader(record)?.close();
      target = new LegacyClaude(record, this.dataDir, async () => {
        const state = await entry.client.call('initial');
        return state.sessions.find(s => s.id === record.id);
      });
      if (this.readerUnavailable(record) && !target.initialized) { target.close(); throw uiError("error.legacy.readerUnavailable"); }
    } catch (error) { this.readerFailures.set(record.id, record.nativeId); this.emit('change'); throw error; }
    target.markReader = () => this.saveLink(entry, record, true);
    const { token, submission } = target;
    Object.assign(target, { server, descriptor: path.join(directory, `gui-${record.nativeId}.json`) });
    target.beforeAuthorize = async () => { if (!target.refresh) throw Error('No active send'); await target.refresh(); };
    const temp = target.descriptor + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
    let published = false;
    try {
      checkOpen();
      fs.writeFileSync(temp, JSON.stringify({ sessionId: record.nativeId, socketPath: server.socket, token, compat: true, nativeBlocks: true }), { mode: 0o600, flag: 'wx' });
      this.saveLink(entry, record);
      fs.renameSync(temp, target.descriptor); published = true;
      server.targets.set(token, target); this.targets.set(record.id, target);
      this.readers.set(record.id, target);
      this.readerFailures.delete(record.id);
      submission.on('change', () => this.emit('change'));
      target.on('change', () => this.emit('change'));
      target.on('readerBlock', message => this.observeReader(target, message));
      target.on('sharingBoundary', kind => this.sharedReplies.revoke(record.id,
        kind === 'control:permission' ? '等待原生权限确认；后续内容留在原会话' : '原生输入已改变；后续内容留在原会话', uiNotice(kind === 'control:permission' ? 'notice.sharing.nativeApprovalBoundary' : 'notice.sharing.nativeInputChanged').uiMessage));
      target.on('contextEnd', () => this.sharedReplies.revoke(record.id, '原生上下文已结束', uiNotice('notice.sharing.nativeContextEnded').uiMessage));
    } catch (error) {
      for (const file of [temp, ...(published ? [target.descriptor] : [])]) try { fs.unlinkSync(file); } catch {}
      target.close(); throw error;
    }
    this.emit('change'); return true;
  }
  async restore(entries) {
    const generations = new Map(this.readerGenerations);
    let links = [];
    try { links = JSON.parse(fs.readFileSync(path.join(this.dataDir, 'legacy-links.json'), 'utf8')); if (!Array.isArray(links)) links = []; } catch {}
    // Mark every previously projected reader before any asynchronous work.
    for (const link of links) if (link.readerStarted) this.readerFailures.set(link.id, link.nativeId);
    for (const entry of entries) for (const record of entry.state.sessions || []) {
      if (!['claude', 'codex'].includes(record.provider) || typeof record.nativeId !== 'string') continue;
      // Another window shares this bridge. Its restore must not replace the
      // live event recipient with a disconnected cache copy or write old text.
      const existing = this.reader(record);
      if (existing) {
        if (existing.initialized) this.readerFailures.delete(record.id);
        continue;
      }
      try {
        fs.lstatSync(readerPath(this.dataDir, record.nativeId)); this.readerFailures.set(record.id, record.nativeId);
        // Reading ended history needs no live PID, transport or plugin install.
        const reader = record.provider === 'claude' ? new LegacyClaude(record, this.dataDir, async () => record) : new LegacyCodex(record, this.dataDir);
        if (reader.initialized) { this.readers.set(record.id, reader); this.readerFailures.delete(record.id); }
      } catch (e) { if (e.code !== 'ENOENT') this.readerFailures.set(record.id, record.nativeId); }
    }
    for (const link of links) {
      // The failed separate-native observer experiment is never restored.
      if (link.outboxOnly === true) continue;
      if ((this.readerGenerations.get(link.id) || 0) !== (generations.get(link.id) || 0)) continue;
      const entry = entries.find(e => e.key === link.key), record = entry?.state.sessions.find(s => s.id === link.id && s.pid === link.pid && s.nativeId === link.nativeId);
      if (record && eligible(entry.state, record)) {
        await this.prepare(entry, record).catch(() => { this.emit('change'); });
      }
    }
  }
  watchOutboxReceipt(record, target, tag) {
    if (target.managed) {
      let unsubscribe = () => {};
      const close = () => { unsubscribe(); this.outboxReceipts.delete(tag); };
      unsubscribe = target.watchReceipt(value => {
        if (value.inputTag !== tag || value.nativeId !== record.nativeId || value.nativeReceived !== true ||
            value.source !== 'codex-native' || this.outboxTarget(record) !== target) return;
        const row = this.records.find(row => row.id === tag && row.sessionId === record.id && row.nativeId === record.nativeId && row.senderId);
        if (!row) return;
        row.status = 'accepted';
        try { this.save(); } catch { this.storageError = true; setWarning(this, 'storageWarning', 'error.warning.legacyAcceptedUnsaved'); }
        this.emit('change');
        close();
      });
      this.outboxReceipts.set(tag, { sessionId: record.id, close }); return;
    }
    const runtime = target.native?.adapter, rpc = runtime?.host?.rpc, lifecycle = runtime?.lifecycleRevision;
    if (!rpc || typeof runtime.on !== 'function' || typeof runtime.off !== 'function' || this.outboxReceipts.size >= 64) throw uiError('error.nativeToolOriginUnconfirmed');
    const current = () => !this.closed && this.targets.get(record.id) === target && target.native.adapter === runtime &&
      runtime.host.rpc === rpc && runtime.lifecycleRevision === lifecycle && runtime.record.nativeId === record.nativeId && !runtime.stopped && !runtime.transportDisconnected;
    const close = () => {
      clearTimeout(timer); runtime.off('nativeAcceptedInput', observed); runtime.off('state', changed); this.outboxReceipts.delete(tag);
    };
    const observed = () => {
      if (!current()) { close(); return; }
      const input = runtime.nativeAcceptedInput;
      if (input?.tag !== tag) return;
      if (input.rpc !== rpc || input.lifecycle !== lifecycle || typeof input.turnId !== 'string' || !input.turnId || !runtime.ownInputs.has(tag)) { close(); return; }
      const row = this.records.find(row => row.id === tag && row.sessionId === record.id && row.nativeId === record.nativeId && row.senderId);
      close(); if (!row) return;
      row.status = 'accepted';
      try { this.save(); } catch {
        this.storageError = true; setWarning(this, 'storageWarning', 'error.warning.legacyAcceptedUnsaved');
      }
      this.emit('change');
    };
    const changed = state => { if (!current() || ['ended', 'disconnected', 'error'].includes(state)) close(); };
    const timer = setTimeout(close, 120000); timer.unref();
    this.outboxReceipts.set(tag, { sessionId: record.id, close });
    runtime.on('nativeAcceptedInput', observed); runtime.on('state', changed);
  }
  async send(record, text, refresh, guard, shared = false, replyTo, expectedTurnId, waitForNativeTurn = false, shareAuthority, outboxSource) {
    replyTo = require('./room-threads.js').replyReference(replyTo);
    const target = outboxSource === undefined ? this.target(record) : this.outboxTarget(record);
    if (target?.nativeInputRequired) throw uiError("error.claudePluginInputPaused");
    if (!target?.submission.connected) throw uiError("error.legacy.inputNotReadyDraftRetained");
    if (typeof text !== 'string' || !text.trim() || text.length > 16000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw uiError("error.legacy.inputTooLong");
    const source = outboxSource === undefined ? null : typeof outboxSource === 'function' && outboxSource();
    if (outboxSource !== undefined && (!shared || !source || !['id', 'nativeId', 'name'].every(key => typeof source[key] === 'string' && source[key] && source[key].length <= 160 && !/[\x00-\x1f\x7f]/.test(source[key])))) throw uiError('error.nativeToolOriginUnconfirmed');
    if (!source) text = text.trim();
    if (/^\/[a-z-]+(?:\s|$)/i.test(text)) throw uiError("error.nativeCommandUseTerminal");
    if (expectedTurnId !== undefined ? !target.native?.steerAvailable || target.native.pendingSteer : target.submission.pending) throw uiError("error.legacy.previousSendPending");
    if (waitForNativeTurn && !target.queueAvailable) throw uiError("error.legacy.waitingInputUnsupported");
    const row = { id: crypto.randomUUID(), sessionId: record.id, nativeId: record.nativeId, time: Date.now(), status: 'unconfirmed' };
    if (target.managed) row.managed = true;
    if (expectedTurnId !== undefined) row.inputMode = 'steer';
    if (waitForNativeTurn) row.inputMode = 'queue';
    if (shared) Object.assign(row, { shared: true, text, name: `你 → ${record.name}`,
      // An agent's routed row is renamed just below; only a person's row carries 你 → name (T-60).
      uiNameMessage: source ? undefined : displayMessage({ version: 1, key: 'notice.name.youToNamed', params: { name: record.name } }, 'notice.', `你 → ${record.name}`) || undefined, recipientName: record.name, ...(replyTo ? { replyTo } : {}) });
    if (source) Object.assign(row, { senderId: source.id, senderNativeId: source.nativeId, name: `${source.name} → ${record.name}` });
    if (source?.agentWakeBudget) row.agentWakeBudget = { ...source.agentWakeBudget };
    if (shared && !source && this.sharedReplies.authorize(record, target.native || target, row.id, row, shareAuthority)) row.sharedReply = true;
    if (shared && (expectedTurnId !== undefined || waitForNativeTurn) && !row.sharedReply) throw uiError("error.legacy.sharedReplyUnavailable");
    this.records.push(row);
    try { this.save(); } catch (error) { this.sharedReplies.close(row.id); throw error; }
    if (source) this.watchOutboxReceipt(record, target, row.id);
    target.refresh = refresh;
    try {
      if (!waitForNativeTurn && expectedTurnId === undefined && !target.native) target.claimFailedTurnInput?.();
      const pending = waitForNativeTurn ? target.queue(text, row.id, guard)
        : expectedTurnId !== undefined ? target.native.steer(text, row.id, expectedTurnId, refresh, guard, shared,
          () => this.sharedReplies.valid(this.sharedReplies.grants.get(row.id)))
        : target.native ? target.native.send(text, row.id, refresh, guard) : target.submission.request(text, row.id, guard);
      this.emit('change'); const receipt = await pending;
      if (shared && !target.native) this.sharedReplies.receipt(row.id, receipt);
      // Clearing shared text may replace a pending ledger row while native
      // acceptance is in flight. Update the retained metadata by stable ID.
      const stored = this.records.find(record => record.id === row.id);
      if (stored && !source) stored.status = 'accepted';
      try { this.save(); }
      catch {
        this.storageError = true;
        setWarning(this, 'storageWarning', 'error.warning.legacyAcceptedUnsaved');
      }
      return row.id;
    } catch (error) { this.sharedReplies.close(row.id, '接收结果未确认', uiNotice('notice.sharing.receiptUnconfirmed').uiMessage); throw error; }
    finally { target.refresh = null; this.emit('change'); }
  }
  close() {
    this.closed = true;
    for (const target of this.managedOutboxTargets.values()) target.native.close().catch(() => {});
    this.managedOutboxTargets.clear();
    for (const watch of this.outboxReceipts.values()) watch.close();
    this.sharedReplies.dispose();
    for (const native of this.connecting) native.close();
    this.connecting.clear();
    for (const t of this.targets.values()) { t.reader?.close(); t.submission.close(); if (t.descriptor) try { fs.unlinkSync(t.descriptor); } catch {} }
    for (const reader of this.readers.values()) reader.close(); this.readers.clear();
    for (const s of this.servers.values()) { s.transport.server.closeAllConnections(); s.transport.server.close(() => { try { fs.unlinkSync(s.ownerFile); } catch {} }); }
    this.targets.clear(); this.servers.clear();
  }
}
module.exports = { LegacyInput, eligible, installPlugin };
