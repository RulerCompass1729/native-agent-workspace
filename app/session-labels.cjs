const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const loadWarning = '本地会话名称暂时无法读取，正在显示原有名称；原生会话不受影响。';
function validateName(value) {
  if (typeof value !== 'string') throw new Error('请输入会话名称。');
  const name = value.trim();
  if (!name) throw new Error('会话名称不能为空。');
  if (name.length > 60) throw new Error('会话名称最多 60 个字符。');
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(name)) throw new Error('会话名称不能包含换行或控制字符。');
  return name;
}
function validateId(id) {
  if (typeof id !== 'string' || !id || id.length > 100 || /[\u0000-\u001f]/u.test(id)) throw new Error('无效会话。');
}

// Display metadata belongs to the desktop profile, not a provider or daemon.
// Native titles/history are not renamed. Explicit bounded-run authorization
// may snapshot a display name as the human-visible source label for that run.
class SessionLabels {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'session-labels.json');
    this.labels = new Map();
    this.warning = '';
    try {
      const stat = fs.lstatSync(this.file);
      if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077)) throw new Error('Unsafe labels file');
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (saved.version !== 1 || !saved.labels || Array.isArray(saved.labels) || typeof saved.labels !== 'object') throw new Error('Invalid labels file');
      const labels = new Map();
      for (const [id, name] of Object.entries(saved.labels)) { validateId(id); labels.set(id, validateName(name)); }
      this.labels = labels;
    } catch (error) {
      if (error.code !== 'ENOENT') this.warning = loadWarning;
    }
  }
  commit(next) {
    if (this.warning) throw new Error('本地名称文件无法读取，未覆盖已有文件。请检查本机数据后重开应用。');
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    let fd;
    try {
      fd = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ version: 1, labels: Object.fromEntries(next) }));
      fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(temporary, this.file);
    } catch {
      throw new Error('未能保存会话名称，原有名称未更改。请检查磁盘空间与本机数据权限后重试。');
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(temporary); } catch {}
    }
    this.labels = next;
  }
  set(id, value) {
    validateId(id); const name = validateName(value);
    const next = new Map(this.labels); next.set(id, name); this.commit(next);
    return name;
  }
  remove(id) {
    validateId(id);
    if (this.warning) throw new Error('本地名称文件无法读取，未能清理显示名。');
    if (!this.labels.has(id)) return;
    const next = new Map(this.labels); next.delete(id); this.commit(next);
  }
  apply(snapshot) {
    return { ...snapshot, sessionNameWarning: this.warning, sessions: snapshot.sessions.map(s => this.labels.has(s.id) ? { ...s, name: this.labels.get(s.id) } : s) };
  }
}

module.exports = { SessionLabels, validateName };
