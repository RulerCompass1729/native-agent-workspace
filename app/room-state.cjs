const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { validateName } = require('./session-labels.cjs');

// One desktop-profile writer, independent of retained provider services.
// This is human-readable local context, never a provider memory injection.
class RoomState {
  constructor(directory) {
    this.file = path.join(directory, 'room-state.json');
    this.value = { version: 1, name: '共同工作', notes: '', revision: 0, events: [], archived: false, archivedSessions: [], restoreMembers: [] };
    this.warning = '';
    this.queue = Promise.resolve();
    this.gates = new Set();
    try {
      const stat = fs.lstatSync(this.file);
      if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077)) throw Error('Unsafe file');
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (data.version !== 1 || validateName(data.name) !== data.name || typeof data.notes !== 'string' || data.notes.length > 8000 || !Number.isSafeInteger(data.revision) || data.revision < 0 || !Array.isArray(data.events)) throw Error('Invalid room');
      for (const e of data.events) if (!e || typeof e.id !== 'string' || e.role !== 'system' || typeof e.text !== 'string' || !Number.isFinite(e.time) || (e.sessionId !== undefined && typeof e.sessionId !== 'string')) throw Error('Invalid event');
      for (const key of ['archivedSessions', 'restoreMembers']) if (data[key] !== undefined && (!Array.isArray(data[key]) || data[key].some(id => typeof id !== 'string' || !id || id.length > 100))) throw Error('Invalid archive');
      if (data.archived !== undefined && typeof data.archived !== 'boolean') throw Error('Invalid archive');
      this.value = { ...this.value, ...data };
    } catch (error) { if (error.code !== 'ENOENT') this.warning = '协作资料暂时无法读取；原文件已保留，请检查本机数据后重开。'; }
  }
  commit(next) {
    if (this.warning) throw Error(this.warning);
    const temp = `${this.file}.${randomUUID()}.tmp`; let fd;
    try {
      fd = fs.openSync(temp, 'wx', 0o600); fs.writeFileSync(fd, JSON.stringify(next)); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(temp, this.file);
    } catch { throw Error('协作资料未能保存，请检查磁盘空间与本机数据权限。'); }
    finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temp); } catch {} }
    this.value = next;
  }
  update(fields, event) {
    const events = event ? [...this.value.events, { id: randomUUID(), role: 'system', time: Date.now(), ...event }] : (fields.events || this.value.events);
    this.commit({ ...this.value, ...fields, revision: this.value.revision + 1, events });
  }
  rename(name) {
    const validated = validateName(name);
    if (this.value.name !== validated) this.update({ name: validated }, { kind: 'rename', text: `工作区改名为「${validated}」` });
  }
  notes(text, revision) {
    if (typeof text !== 'string' || text.length > 8000 || /\u0000/.test(text)) throw Error('共享笔记最多 8000 个字符，不能包含空字符。');
    if (revision !== this.value.revision) throw Error('协作资料已在另一个窗口更新。请先复制你的修改，再重新打开核对。');
    if (text !== this.value.notes) this.update({ notes: text }, { kind: 'notes', text: text ? `更新了共享笔记（尚未发送给 agent）\n${text}` : '清空了共享笔记（不会撤回已经发送的内容）' });
  }
  // Register human intervention immediately, then serialize membership changes
  // across windows. Record only acknowledged state transitions, not drag intent.
  enqueue(client, action, sessionId) {
    const pause = sessionId ? client.call('pause', sessionId) : client.call('pause'); pause.catch(() => {});
    const operation = this.queue.then(async () => { await pause; return action(); });
    this.queue = operation.catch(() => {}); return operation;
  }
  membership(client, id, join, label) {
    if (typeof id !== 'string' || typeof join !== 'boolean') return Promise.reject(Error('无效成员操作。'));
    return this.enqueue(client, () => {
      if (join) this.assertAvailable(id, true);
      return this.changeMember(client, id, join, label);
    }, id);
  }
  async changeMember(client, id, join, label) {
      const before = (await client.call('initial')).sessions.find(s => s.id === id);
      if (!before) throw Error('找不到这个会话。');
      if (Boolean(before.roomId) === join) return;
      await client.call('join', id, join);
      const after = (await client.call('initial')).sessions.find(s => s.id === id);
      if (!after || Boolean(after.roomId) !== join) throw Error('成员状态未确认，请重新连接核对。');
      try { this.update({}, { kind: join ? 'join' : 'leave', sessionId: id, name: label || before.name, text: join ? '加入了工作区 · 未发送历史或通知模型' : '离开了工作区 · 原生会话与已收到的内容保留' }); }
      catch { throw Error('成员关系已更新，但时间线未能保存。原生会话已保留，请检查本机数据。'); }
  }
  assertAvailable(id, shared = false) {
    if (this.warning) throw Error(this.warning);
    if (id && (this.value.archivedSessions.includes(id) || this.gates.has(id))) throw Error('这个会话已归档或正在归档，请先从归档列表恢复。');
    if (shared && (this.value.archived || this.gates.has('room'))) throw Error('这个工作区已归档或正在恢复，请先从归档列表恢复。');
  }
  archiveSession(client, id, label) {
    if (typeof id !== 'string' || !id || id.length > 100) return Promise.reject(Error('无效会话。'));
    if (this.gates.has(id)) return Promise.reject(Error('这个会话正在更新，请稍候。'));
    this.gates.add(id);
    return this.enqueue(client, async () => {
      if (this.value.archivedSessions.includes(id)) return;
      await this.changeMember(client, id, false, label);
      this.update({ archivedSessions: [...this.value.archivedSessions, id] });
    }, id).finally(() => this.gates.delete(id));
  }
  restoreSession(id) {
    if (this.gates.has(id)) throw Error('这个会话正在归档，请稍候。');
    if (this.value.archivedSessions.includes(id)) this.update({ archivedSessions: this.value.archivedSessions.filter(value => value !== id) });
  }
  archiveRoom(client, labels) {
    if (this.gates.has('room')) return Promise.reject(Error('工作区正在更新，请稍候。'));
    this.gates.add('room');
    return this.enqueue(client, async () => {
      if (this.value.archived) return;
      const members = (await client.call('initial')).sessions.filter(s => s.roomId === 'shared');
      // Save the intended roster before detaching so a partial failure cannot
      // lose the information needed for an explicit restore/retry.
      const restoreMembers = [...new Set([...this.value.restoreMembers, ...members.map(s => s.id)])];
      this.update({ restoreMembers });
      for (const s of members) await this.changeMember(client, s.id, false, labels?.get(s.id));
      this.update({ archived: true }, { kind: 'archive', text: '工作区已归档 · 后续投递已暂停，原生任务仍可能继续' });
    }).finally(() => this.gates.delete('room'));
  }
  restoreRoom(client, labels) {
    if (this.gates.has('room')) return Promise.reject(Error('工作区正在更新，请稍候。'));
    this.gates.add('room');
    return this.enqueue(client, async () => {
      if (!this.value.archived && !this.value.restoreMembers.length) return;
      const sessions = (await client.call('initial')).sessions;
      const wanted = this.value.restoreMembers.filter(id => sessions.some(s => s.id === id) && !this.value.archivedSessions.includes(id));
      for (const id of wanted) await this.changeMember(client, id, true, labels?.get(id));
      this.update({ archived: false, restoreMembers: [] }, { kind: 'restore', text: '工作区已恢复 · 原记录与可用成员已保留，没有重发任务' });
    }).finally(() => this.gates.delete('room'));
  }
  clear(revision = this.value.revision) {
    if (revision !== this.value.revision) throw Error('协作资料已在清除期间更新，请核对后重新清除。');
    this.update({ notes: '', events: [] });
  }
  apply(snapshot) {
    return { ...snapshot, sessions: snapshot.sessions.map(s => ({ ...s, archived: this.value.archivedSessions.includes(s.id) })), roomStorageWarning: this.warning, room: { ...snapshot.room, name: this.value.name, notes: this.value.notes, metadataRevision: this.value.revision, events: this.value.events, archived: this.value.archived } };
  }
}
module.exports = { RoomState };
