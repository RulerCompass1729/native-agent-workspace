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

function eligible(state, record) {
  return eligibleCodex(state, record) || (supportsLegacyObservation(state, record) && /^[a-f0-9-]{36}$/i.test(record.nativeId || '')
    && Number.isSafeInteger(record.pid) && record.pid > 1);
}
function privateDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw Error('原连接目录权限不安全，未接入输入。');
}
function installPlugin(cwd) {
  let directory = cwd;
  for (const part of ['.claude', 'skills', 'native-workspace-compat']) {
    directory = path.join(directory, part);
    try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) throw Error('本地插件目录不可安全写入，原会话未改动。');
  }
  const files = new Map();
  for (const name of ['.claude-plugin/plugin.json', 'hooks/hooks.json', 'hooks/register.js']) {
    let content = fs.readFileSync(path.join(__dirname, 'claude-bridge', name), 'utf8');
    if (name.endsWith('plugin.json')) content = JSON.stringify({ ...JSON.parse(content), name: 'native-workspace-compat' }, null, 2) + '\n';
    if (name.endsWith('register.js')) content = content.replace('const legacyOnly = false;', 'const legacyOnly = true;');
    files.set(name, content);
  }
  for (const part of ['.claude-plugin', 'hooks']) {
    const parent = path.join(directory, part);
    try { fs.mkdirSync(parent, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const stat = fs.lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) throw Error('本地插件路径不安全，未写入插件文件。');
  }
  // Upgrade only our byte-exact previous hook. Edited copies remain untouched.
  const previousHooks = new Set(['0c04a03d3a7cb3c191405bd9637c218f7603aa6dfad6345741b5e39177ca8017',
    '4bc48cb24744f5f4795d16ad95f13ccfa0583baaf35941ba11f43fb8cbed6ee3',
    'dcbff5190245c72761ef3e0d110b8976f5f49740b0ef3a839654cdcb933764ba',
    '069c66cb4889031f0cc460dcbb75d0892cf41835c9bac02e9dbf796cd52c7a40',
    '6e72f7d5eade95e90e4667ed22888e7923d535b5e9620d26074bc01c2a8303d1',
    '0833cbf4165cc439bfdd04ff7e7676886f5e40d518c47cfda25ba62e3292009a',
    '79a701e38fa7ab32e0551c2aa6c364bf34cd4ccd5942ab5ae899463f7b355cc6',
    'dc1140fd7d19d57cafd7f8545be466efd177012960763a43c769b79a92229687',
    'a3462c9cb8bb11cdd6fdfb26baebf780bb9af9f7ef72535dd08bfa3f0ae7b359',
    '39a213b15740f1723dfb9886d709a1a4dd92a71e651a261d42ceac188e29f388']);
  const upgrades = new Set();
  for (const [name, content] of files) {
    const filename = path.join(directory, name);
    if (!fs.existsSync(filename)) continue;
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid()) throw Error('已有同名插件内容不同，未覆盖；原会话继续保留。');
    const prior = fs.readFileSync(filename, 'utf8');
    if (prior === content) continue;
    if (name === 'hooks/register.js' && previousHooks.has(crypto.createHash('sha256').update(prior).digest('hex'))) upgrades.add(name);
    else throw Error('已有同名插件内容不同，未覆盖；原会话继续保留。');
  }
  for (const [name, content] of files) {
    const filename = path.join(directory, name);
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(filename)) fs.writeFileSync(filename, content, { mode: 0o600, flag: 'wx' });
    else if (upgrades.has(name)) {
      const temp = filename + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
      try { fs.writeFileSync(temp, content, { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, filename); }
      finally { fs.rmSync(temp, { force: true }); }
    }
  }
}

class LegacyInput extends EventEmitter {
  constructor(dataDir) {
    super(); this.dataDir = dataDir; this.servers = new Map(); this.targets = new Map(); this.readers = new Map(); this.pendingPrepare = new Map(); this.readerFailures = new Map();
    this.filename = path.join(dataDir, 'legacy-dispatches.json'); this.records = []; this.closed = false; this.connecting = new Set(); this.readerGenerations = new Map();
    try { this.records = JSON.parse(fs.readFileSync(this.filename, 'utf8')); if (!Array.isArray(this.records)) throw Error('Invalid ledger'); }
    catch (e) { if (e.code !== 'ENOENT') this.storageError = true; }
    this.sharedReplies = new LegacyShared(dataDir, () => this.emit('change'));
  }
  save() {
    if (this.storageError) throw Error('本地发送记录无法读取，未发送。');
    const temp = this.filename + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(this.records), { mode: 0o600 }); fs.renameSync(temp, this.filename);
  }
  saveLink(entry, record, readerStarted = false) {
    // Read at the synchronous commit point: another session may have connected
    // while this one awaited its native handshake.
    const filename = path.join(this.dataDir, 'legacy-links.json');
    let links = []; try { links = JSON.parse(fs.readFileSync(filename, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (!Array.isArray(links)) throw Error('原会话连接记录无法读取。');
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
          this.storageWarning = '已核实原生接收，但本地发送记录未能保存。没有重发，后续发送暂停；请检查磁盘与文件权限。';
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
      id: row.id, role: 'human', recipientId: row.sessionId, name: row.name, text: row.text, time: row.time,
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
      const { text, name, recipientName, shared, replyTo, ...metadata } = row; return metadata;
    });
    try { this.save(); } catch (error) { this.records = previous; throw error; }
    this.emit('change');
  }
  forgetReader(record) {
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
      if (!Array.isArray(links)) throw Error('原连接索引无法清理。');
      const temporary = filename + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
      try {
        fs.writeFileSync(temporary, JSON.stringify(links.filter(link => link.id !== record.id || link.nativeId !== record.nativeId)), { mode: 0o600, flag: 'wx' });
        fs.renameSync(temporary, filename);
      } finally { fs.rmSync(temporary, { force: true }); }
    }
    this.readerFailures.delete(record.id);
  }
  async prepare(entry, record) {
    if (this.closed) throw Error('窗口连接已关闭。');
    if (this.pendingPrepare.has(record.id)) return this.pendingPrepare.get(record.id);
    const work = this.prepareOnce(entry, record).finally(() => this.pendingPrepare.delete(record.id));
    this.pendingPrepare.set(record.id, work); return work;
  }
  async prepareOnce(entry, record) {
    const generation = this.readerGenerations.get(record.id) || 0;
    const checkOpen = () => {
      if (this.closed) throw Error('窗口连接已关闭。');
      if ((this.readerGenerations.get(record.id) || 0) !== generation) throw Error('会话记录已移除，连接操作已取消。');
    };
    checkOpen();
    if (!eligible(entry.state, record) || record.processIdentity?.pid !== record.pid || !processMayBeAlive(record.processIdentity)) throw Error('原生会话状态已变化，未接入输入。');
    const existing = this.target(record);
    if (existing && (!existing.native || existing.native.connected)) return true;
    // Retain the last-known reader while reconnecting. A failed handshake must
    // not erase history that the old service never recorded. close() disables
    // sending; only a successful replacement may take over this target.
    if (existing) existing.submission.close();
    const connectionFile = path.join(this.dataDir, entry.key, 'connection.json');
    const stat = fs.lstatSync(connectionFile);
    if (stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw Error('原连接文件权限不安全。');
    const connection = JSON.parse(fs.readFileSync(connectionFile, 'utf8'));
    if (connection.pid !== entry.state.servicePid) throw Error('原连接已变化，未接入输入。');
    const directory = path.dirname(connection.endpoint); privateDirectory(directory);
    if (record.provider === 'codex') {
      const cached = existing?.native?.record;
      this.reader(record)?.close();
      let native;
      try {
        native = new LegacyCodex(cached ? { ...record, messages: cached.messages } : record, this.dataDir);
        if (this.readerUnavailable(record) && !native.initialized) throw Error('原生阅读记录不可用，未以旧后台内容替换。请在原生终端继续。');
      } catch (error) { this.readerFailures.set(record.id, record.nativeId); this.emit('change'); throw error; }
      const target = { record: { ...record }, submission: native, native, reader: native, get sharedReplyAvailable() { return native.sharedReplyAvailable; } };
      this.connecting.add(native);
      try {
        await native.connect(retainedSocket(this.dataDir, entry, record)); checkOpen();
        if (native.storageError) throw Error('原生阅读记录未能保存，请检查磁盘与文件权限。');
        this.saveLink(entry, record, true);
        this.targets.set(record.id, target);
        this.readers.set(record.id, native); this.readerFailures.delete(record.id);
        native.on('change', () => this.emit('change'));
        native.on('progress', update => this.emit('progress', { id: record.id, ...update }));
        native.on('readerBlock', message => { if (message) this.sharedReplies.observed(native, message); });
        native.on('replyBound', identity => this.sharedReplies.bindNative(native, identity));
        native.on('complete', info => this.sharedReplies.completeNative(native, info));
        for (const event of ['nativeInput', 'approval', 'failed', 'fleet']) native.on(event, () => this.sharedReplies.revoke(record.id, '原生输入、权限或运行状态已改变；后续内容留在原会话'));
        native.on('state', state => { if (!['idle', 'working'].includes(state)) this.sharedReplies.revoke(record.id, '原生运行状态已改变；后续内容留在原会话'); });
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
        if (st.isSymbolicLink() || st.uid !== process.getuid() || st.mode & 0o077) throw Error('输入连接记录权限不安全。');
        const previous = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
        if (processMayBeAlive(previous)) throw Error('已有输入连接，请在原窗口继续；没有替换它。');
        if (fs.existsSync(socket)) { if (!fs.lstatSync(socket).isSocket()) throw Error('输入连接地址被占用。'); fs.unlinkSync(socket); }
        fs.unlinkSync(ownerFile);
      } else if (fs.existsSync(socket)) throw Error('输入连接地址被占用，未替换。');
      fs.writeFileSync(ownerFile, JSON.stringify(processIdentity(process.pid)), { mode: 0o600, flag: 'wx' });
      const targets = new Map(), transport = createSubmissionServer(socket, targets);
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
      if (this.readerUnavailable(record) && !target.initialized) { target.close(); throw Error('原生阅读记录不可用，未以旧后台内容替换。请在原生终端继续。'); }
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
        kind === 'control:permission' ? '等待原生权限确认；后续内容留在原会话' : '原生输入已改变；后续内容留在原会话'));
      target.on('contextEnd', () => this.sharedReplies.revoke(record.id, '原生上下文已结束'));
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
      if ((this.readerGenerations.get(link.id) || 0) !== (generations.get(link.id) || 0)) continue;
      const entry = entries.find(e => e.key === link.key), record = entry?.state.sessions.find(s => s.id === link.id && s.pid === link.pid && s.nativeId === link.nativeId);
      if (record && eligible(entry.state, record)) {
        await this.prepare(entry, record).catch(() => { this.emit('change'); });
      }
    }
  }
  async send(record, text, refresh, guard, shared = false, replyTo, expectedTurnId, waitForNativeTurn = false, shareAuthority) {
    replyTo = require('./room-threads.js').replyReference(replyTo);
    const target = this.target(record);
    if (target?.nativeInputRequired) throw Error('Claude 已暂停插件输入；请在原生终端输入一次后继续，草稿保留。');
    if (!target?.submission.connected) throw Error('原会话输入连接尚未就绪，草稿已保留。');
    if (typeof text !== 'string' || !text.trim() || text.length > 16000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw Error('请输入有效文字；一次最多 16,000 个字符。');
    text = text.trim();
    if (/^\/[a-z-]+(?:\s|$)/i.test(text)) throw Error('原生命令请在终端执行；草稿已保留。');
    if (expectedTurnId !== undefined ? !target.native?.steerAvailable || target.native.pendingSteer : target.submission.pending) throw Error('上一条发送仍待确认，或当前连接无法追加指令。');
    if (waitForNativeTurn && !target.queueAvailable) throw Error('当前连接不支持等待输入；草稿保留。');
    const row = { id: crypto.randomUUID(), sessionId: record.id, nativeId: record.nativeId, time: Date.now(), status: 'unconfirmed' };
    if (expectedTurnId !== undefined) row.inputMode = 'steer';
    if (waitForNativeTurn) row.inputMode = 'queue';
    if (shared) Object.assign(row, { shared: true, text, name: `你 → ${record.name}`, recipientName: record.name, ...(replyTo ? { replyTo } : {}) });
    if (shared && this.sharedReplies.authorize(record, target.native || target, row.id, row, shareAuthority)) row.sharedReply = true;
    if (shared && (expectedTurnId !== undefined || waitForNativeTurn) && !row.sharedReply) throw Error('共享回复连接不可用；草稿保留，没有发送。');
    this.records.push(row);
    try { this.save(); } catch (error) { this.sharedReplies.close(row.id); throw error; }
    target.refresh = refresh;
    try {
      const pending = waitForNativeTurn ? target.queue(text, row.id, guard)
        : expectedTurnId !== undefined ? target.native.steer(text, row.id, expectedTurnId, refresh, guard, shared,
          () => this.sharedReplies.valid(this.sharedReplies.grants.get(row.id)))
        : target.native ? target.native.send(text, row.id, refresh, guard) : target.submission.request(text, row.id, guard);
      this.emit('change'); const receipt = await pending;
      if (shared && !target.native) this.sharedReplies.receipt(row.id, receipt);
      // Clearing shared text may replace a pending ledger row while native
      // acceptance is in flight. Update the retained metadata by stable ID.
      const stored = this.records.find(record => record.id === row.id);
      if (stored) stored.status = 'accepted';
      try { this.save(); }
      catch {
        this.storageError = true;
        this.storageWarning = '原生会话已接收消息，但本地发送记录未能保存。请在原生会话核对；没有重发，后续发送暂停。';
      }
      return row.id;
    } catch (error) { this.sharedReplies.close(row.id, '接收结果未确认'); throw error; }
    finally { target.refresh = null; this.emit('change'); }
  }
  close() {
    this.closed = true;
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
