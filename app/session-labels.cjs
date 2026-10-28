const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const loadWarning = '本地会话显示设置暂时无法读取，正在显示原有名称和顺序；原生会话不受影响。';
function validSidebar(value) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Array.isArray(value.order) && value.order.length <= 10000 && new Set(value.order).size === value.order.length &&
    value.order.every(id => typeof id === 'string' && id.length > 0 && id.length <= 100 && !/[\u0000-\u001f]/u.test(id)) &&
    typeof value.sessionsCollapsed === 'boolean' && typeof value.workspaceCollapsed === 'boolean';
}
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
    this.sidebar = { order: [], sessionsCollapsed: false, workspaceCollapsed: false };
    this.warning = '';
    try {
      const stat = fs.lstatSync(this.file);
      if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077)) throw new Error('Unsafe labels file');
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (saved.version !== 1 || !saved.labels || Array.isArray(saved.labels) || typeof saved.labels !== 'object') throw new Error('Invalid labels file');
      const labels = new Map();
      for (const [id, name] of Object.entries(saved.labels)) { validateId(id); labels.set(id, validateName(name)); }
      if (saved.sidebar !== undefined && !validSidebar(saved.sidebar)) throw new Error('Invalid sidebar metadata');
      this.labels = labels;
      if (saved.sidebar) this.sidebar = saved.sidebar;
    } catch (error) {
      if (error.code !== 'ENOENT') this.warning = loadWarning;
    }
  }
  commit(next, sidebar = this.sidebar) {
    if (this.warning) throw new Error('本地名称文件无法读取，未覆盖已有文件。请检查本机数据后重开应用。');
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    let fd;
    try {
      fd = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ version: 1, labels: Object.fromEntries(next), sidebar }));
      fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(temporary, this.file);
    } catch {
      throw new Error('未能保存会话显示设置，原有名称和顺序未更改。请检查磁盘空间与本机数据权限后重试。');
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(temporary); } catch {}
    }
    this.labels = next;
    this.sidebar = sidebar;
  }
  updateSidebar(change, records) {
    if (!change || typeof change !== 'object' || Array.isArray(change)) throw new Error('无效侧栏操作。');
    const next = { ...this.sidebar };
    if (change.type === 'collapse') {
      if (!['sessions', 'workspace'].includes(change.section) || typeof change.collapsed !== 'boolean') throw new Error('无效分区。');
      next[change.section + 'Collapsed'] = change.collapsed;
    } else if (change.type === 'move') {
      const ids = records.filter(s => !s.archived).map(s => s.id);
      if (!ids.includes(change.id) || !ids.includes(change.target) || typeof change.after !== 'boolean') throw new Error('会话已变化，顺序未更改。');
      if (change.id === change.target) return;
      const all = new Set(records.map(s => s.id));
      next.order = this.sidebar.order.filter(id => all.has(id));
      for (const id of all) if (!next.order.includes(id)) next.order.push(id);
      next.order.splice(next.order.indexOf(change.id), 1);
      next.order.splice(next.order.indexOf(change.target) + Number(change.after), 0, change.id);
    } else throw new Error('无效侧栏操作。');
    if (!validSidebar(next)) throw new Error('无效侧栏设置。');
    this.commit(new Map(this.labels), next);
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
    return { ...snapshot, sidebar: this.sidebar, sessionNameWarning: this.warning, sessions: snapshot.sessions.map(s => this.labels.has(s.id) ? { ...s, name: this.labels.get(s.id) } : s) };
  }
}

module.exports = { SessionLabels, validateName };
