// Explicit, same-process compatibility for inspected alpha.2 native hosts.
// Native hooks remain the sole writer of conversation history. This transport
// records dispatch metadata and explicitly shared text only. It never calls
// the old paste/Enter sender or infers which native reply may be shared.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { SubmissionChannel, createSubmissionServer } = require('./claude-submit.cjs');
const { supportsLegacyObservation } = require('./legacy-observation.cjs');
const { processMayBeAlive, processIdentity } = require('./platform.cjs');
const { LegacyCodex, eligibleCodex, retainedSocket } = require('./legacy-codex.cjs');

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
  const previousHooks = new Set(['6e72f7d5eade95e90e4667ed22888e7923d535b5e9620d26074bc01c2a8303d1',
    '79a701e38fa7ab32e0551c2aa6c364bf34cd4ccd5942ab5ae899463f7b355cc6']);
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
    super(); this.dataDir = dataDir; this.servers = new Map(); this.targets = new Map(); this.pendingPrepare = new Map();
    this.filename = path.join(dataDir, 'legacy-dispatches.json'); this.records = []; this.closed = false; this.connecting = new Set();
    try { this.records = JSON.parse(fs.readFileSync(this.filename, 'utf8')); if (!Array.isArray(this.records)) throw Error('Invalid ledger'); }
    catch (e) { if (e.code !== 'ENOENT') this.storageError = true; }
  }
  save() {
    if (this.storageError) throw Error('本地发送记录无法读取，未发送。');
    const temp = this.filename + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(this.records), { mode: 0o600 }); fs.renameSync(temp, this.filename);
  }
  saveLink(entry, record) {
    // Read at the synchronous commit point: another session may have connected
    // while this one awaited its native handshake.
    const filename = path.join(this.dataDir, 'legacy-links.json');
    let links = []; try { links = JSON.parse(fs.readFileSync(filename, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (!Array.isArray(links)) throw Error('原会话连接记录无法读取。');
    if (links.some(link => link.id === record.id && link.pid === record.pid && link.nativeId === record.nativeId)) return;
    links.push({ id: record.id, pid: record.pid, nativeId: record.nativeId, key: entry.key });
    const temp = filename + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
    try { fs.writeFileSync(temp, JSON.stringify(links), { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, filename); }
    finally { try { fs.unlinkSync(temp); } catch {} }
  }
  target(record) {
    if (!record) return null;
    const t = this.targets.get(record.id);
    return t && t.record.nativeId === record.nativeId && t.record.pid === record.pid ? t : null;
  }
  connected(record) { return !!this.target(record)?.submission.connected; }
  prepared(record) { return !!this.target(record); }
  sharedMessages() {
    return this.records.filter(row => row.shared === true).map(row => ({
      id: row.id, role: 'human', recipientId: row.sessionId, name: row.name, text: row.text, time: row.time,
      status: row.status === 'accepted' ? 'submitted' : 'unconfirmed', manualReply: true,
      deliveryTracked: true, ...(row.replyTo ? { replyTo: row.replyTo } : {}),
      deliveries: [{ id: row.id, recipientId: row.sessionId, recipientName: row.recipientName || row.name, text: row.text,
        status: row.status === 'accepted' ? 'submitted' : 'unconfirmed', time: row.time }],
    }));
  }
  clearSharedHistory(ids = this.records.filter(row => row.shared === true).map(row => row.id)) {
    const selected = new Set(ids);
    const previous = this.records;
    this.records = previous.map(row => {
      if (!selected.has(row.id)) return row;
      const { text, name, recipientName, shared, replyTo, ...metadata } = row; return metadata;
    });
    try { this.save(); } catch (error) { this.records = previous; throw error; }
    this.emit('change');
  }
  async prepare(entry, record) {
    if (this.closed) throw Error('窗口连接已关闭。');
    if (this.pendingPrepare.has(record.id)) return this.pendingPrepare.get(record.id);
    const work = this.prepareOnce(entry, record).finally(() => this.pendingPrepare.delete(record.id));
    this.pendingPrepare.set(record.id, work); return work;
  }
  async prepareOnce(entry, record) {
    const checkOpen = () => { if (this.closed) throw Error('窗口连接已关闭。'); };
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
      const native = new LegacyCodex(cached ? { ...record, messages: cached.messages } : record);
      const target = { record: { ...record }, submission: native, native };
      this.connecting.add(native);
      try {
        await native.connect(retainedSocket(this.dataDir, entry, record)); checkOpen();
        this.saveLink(entry, record);
        this.targets.set(record.id, target);
        native.on('change', () => this.emit('change'));
        native.on('progress', update => this.emit('progress', { id: record.id, ...update }));
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
    const token = crypto.randomBytes(32).toString('hex'), submission = new SubmissionChannel();
    const target = { record: { ...record }, submission, token, server, descriptor: path.join(directory, `gui-${record.nativeId}.json`) };
    target.beforeAuthorize = async () => { if (!target.refresh) throw Error('No active send'); await target.refresh(); };
    const temp = target.descriptor + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
    let published = false;
    try {
      checkOpen();
      fs.writeFileSync(temp, JSON.stringify({ sessionId: record.nativeId, socketPath: server.socket, token, compat: true }), { mode: 0o600, flag: 'wx' });
      this.saveLink(entry, record);
      fs.renameSync(temp, target.descriptor); published = true;
      server.targets.set(token, target); this.targets.set(record.id, target);
      submission.on('change', () => this.emit('change'));
    } catch (error) {
      for (const file of [temp, ...(published ? [target.descriptor] : [])]) try { fs.unlinkSync(file); } catch {}
      submission.close(); throw error;
    }
    this.emit('change'); return true;
  }
  async restore(entries) {
    let links; try { links = JSON.parse(fs.readFileSync(path.join(this.dataDir, 'legacy-links.json'), 'utf8')); } catch { return; }
    if (!Array.isArray(links)) return;
    for (const link of links) {
      const entry = entries.find(e => e.key === link.key), record = entry?.state.sessions.find(s => s.id === link.id && s.pid === link.pid && s.nativeId === link.nativeId);
      if (record && eligible(entry.state, record)) await this.prepare(entry, record).catch(() => {});
    }
  }
  async send(record, text, refresh, guard, shared = false, replyTo, expectedTurnId) {
    replyTo = require('./room-threads.js').replyReference(replyTo);
    const target = this.target(record);
    if (!target?.submission.connected) throw Error('原会话输入连接尚未就绪，草稿已保留。');
    if (typeof text !== 'string' || !text.trim() || text.length > 16000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw Error('请输入有效文字；一次最多 16,000 个字符。');
    text = text.trim();
    if (/^\/[a-z-]+(?:\s|$)/i.test(text)) throw Error('原生命令请在终端执行；草稿已保留。');
    if (expectedTurnId !== undefined ? shared || !target.native?.steerAvailable || target.native.pendingSteer : target.submission.pending) throw Error('上一条发送仍待确认，或当前连接无法追加指令。');
    const row = { id: crypto.randomUUID(), sessionId: record.id, nativeId: record.nativeId, time: Date.now(), status: 'unconfirmed' };
    if (shared) Object.assign(row, { shared: true, text, name: `你 → ${record.name}`, recipientName: record.name, ...(replyTo ? { replyTo } : {}) });
    this.records.push(row); this.save(); target.refresh = refresh;
    try {
      const pending = expectedTurnId !== undefined ? target.native.steer(text, row.id, expectedTurnId, refresh, guard)
        : target.native ? target.native.send(text, row.id, refresh, guard) : target.submission.request(text, row.id, guard);
      this.emit('change'); await pending;
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
    } finally { target.refresh = null; this.emit('change'); }
  }
  close() {
    this.closed = true;
    for (const native of this.connecting) native.close();
    this.connecting.clear();
    for (const t of this.targets.values()) { t.submission.close(); if (t.descriptor) try { fs.unlinkSync(t.descriptor); } catch {} }
    for (const s of this.servers.values()) { s.transport.server.closeAllConnections(); s.transport.server.close(() => { try { fs.unlinkSync(s.ownerFile); } catch {} }); }
    this.targets.clear(); this.servers.clear();
  }
}
module.exports = { LegacyInput, eligible, installPlugin };
