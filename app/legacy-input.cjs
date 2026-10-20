// Explicit, same-process compatibility for the inspected alpha.2 Claude host.
// Native hooks remain the sole writer of conversation history. This transport
// records only dispatch metadata and never calls the old paste/Enter sender.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { SubmissionChannel, createSubmissionServer } = require('./claude-submit.cjs');
const { supportsLegacyObservation } = require('./legacy-observation.cjs');
const { processMayBeAlive, processIdentity } = require('./platform.cjs');

function eligible(state, record) {
  return supportsLegacyObservation(state, record) && /^[a-f0-9-]{36}$/i.test(record.nativeId || '')
    && Number.isSafeInteger(record.pid) && record.pid > 1;
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
  // Never replace someone else's plugin or their edited copy.
  for (const [name, content] of files) {
    const filename = path.join(directory, name);
    if (fs.existsSync(filename) && (fs.lstatSync(filename).isSymbolicLink() || fs.readFileSync(filename, 'utf8') !== content)) throw Error('已有同名插件内容不同，未覆盖；原会话继续保留。');
  }
  for (const [name, content] of files) {
    const filename = path.join(directory, name);
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(filename)) fs.writeFileSync(filename, content, { mode: 0o600, flag: 'wx' });
  }
}

class LegacyInput extends EventEmitter {
  constructor(dataDir) {
    super(); this.dataDir = dataDir; this.servers = new Map(); this.targets = new Map(); this.pendingPrepare = new Map();
    this.filename = path.join(dataDir, 'legacy-dispatches.json'); this.records = []; this.closed = false;
    try { this.records = JSON.parse(fs.readFileSync(this.filename, 'utf8')); if (!Array.isArray(this.records)) throw Error('Invalid ledger'); }
    catch (e) { if (e.code !== 'ENOENT') this.storageError = true; }
  }
  save() {
    if (this.storageError) throw Error('本地发送记录无法读取，未发送。');
    const temp = this.filename + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(this.records), { mode: 0o600 }); fs.renameSync(temp, this.filename);
  }
  target(record) {
    if (!record) return null;
    const t = this.targets.get(record.id);
    return t && t.record.nativeId === record.nativeId && t.record.pid === record.pid ? t : null;
  }
  connected(record) { return !!this.target(record)?.submission.connected; }
  prepared(record) { return !!this.target(record); }
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
    if (this.target(record)) return true;
    const connectionFile = path.join(this.dataDir, entry.key, 'connection.json');
    const stat = fs.lstatSync(connectionFile);
    if (stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw Error('原连接文件权限不安全。');
    const connection = JSON.parse(fs.readFileSync(connectionFile, 'utf8'));
    if (connection.pid !== entry.state.servicePid) throw Error('原连接已变化，未接入输入。');
    const directory = path.dirname(connection.endpoint); privateDirectory(directory);
    const linksFile = path.join(this.dataDir, 'legacy-links.json');
    let links = []; try { links = JSON.parse(fs.readFileSync(linksFile, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (!Array.isArray(links)) throw Error('原会话连接记录无法读取。');
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
    const linksTemp = linksFile + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
    let published = false;
    try {
      checkOpen();
      fs.writeFileSync(temp, JSON.stringify({ sessionId: record.nativeId, socketPath: server.socket, token, compat: true }), { mode: 0o600, flag: 'wx' });
      if (!links.some(link => link.id === record.id && link.pid === record.pid && link.nativeId === record.nativeId)) links.push({ id: record.id, pid: record.pid, nativeId: record.nativeId, key: entry.key });
      fs.writeFileSync(linksTemp, JSON.stringify(links), { mode: 0o600, flag: 'wx' }); fs.renameSync(linksTemp, linksFile);
      fs.renameSync(temp, target.descriptor); published = true;
      server.targets.set(token, target); this.targets.set(record.id, target);
      submission.on('change', () => this.emit('change'));
    } catch (error) {
      for (const file of [temp, linksTemp, ...(published ? [target.descriptor] : [])]) try { fs.unlinkSync(file); } catch {}
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
  async send(record, text, refresh, guard) {
    const target = this.target(record);
    if (!target?.submission.connected) throw Error('原会话输入连接尚未就绪，草稿已保留。');
    if (typeof text !== 'string' || !text.trim() || text.length > 16000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw Error('请输入有效文字；一次最多 16,000 个字符。');
    text = text.trim();
    if (/^\/[a-z-]+(?:\s|$)/i.test(text)) throw Error('原生命令请在终端执行；草稿已保留。');
    if (target.submission.pending) throw Error('上一条发送仍待确认。');
    const row = { id: crypto.randomUUID(), sessionId: record.id, nativeId: record.nativeId, time: Date.now(), status: 'unconfirmed' };
    this.records.push(row); this.save(); target.refresh = refresh;
    try {
      const pending = target.submission.request(text, row.id, guard); this.emit('change'); await pending;
      row.status = 'accepted'; this.save(); return row.id;
    } finally { target.refresh = null; this.emit('change'); }
  }
  close() {
    this.closed = true;
    for (const t of this.targets.values()) { t.submission.close(); try { fs.unlinkSync(t.descriptor); } catch {} }
    for (const s of this.servers.values()) { s.transport.server.closeAllConnections(); s.transport.server.close(() => { try { fs.unlinkSync(s.ownerFile); } catch {} }); }
    this.targets.clear(); this.servers.clear();
  }
}
module.exports = { LegacyInput, eligible, installPlugin };
