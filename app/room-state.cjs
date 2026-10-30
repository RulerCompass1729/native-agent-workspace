const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { validateName } = require('./session-labels.cjs');
const { DEFAULT_ROOM_ID, roomId, roomIds, isMember, membershipRevision } = require('./collaboration-spaces.cjs');
const { captureSource, prepareBatch, assertCurrentSources, sameOperation, validateBatch } = require('./space-merge.cjs');
const orderId = id => typeof id === 'string' && id.length > 0 && id.length <= 100 && !/[\u0000-\u001f]/u.test(id);
const memberOrder = value => Array.isArray(value) && value.length <= 10000 ? [...new Set(value.filter(orderId))] : [];
const initialRoom = name => ({ version: 1, name, notes: '', revision: 0, events: [], archived: false, restoreMembers: [], memberOrder: [], files: [] });
const roomGate = id => id === DEFAULT_ROOM_ID ? 'room' : `room:${id}`;
const mergeSignature = value => createHash('sha256').update(JSON.stringify({ name: value.name, notes: value.notes,
  files: value.files, events: value.events.map(e => e.id), memberOrder: value.memberOrder })).digest('hex');
function validateMerge(value, id) {
  if (!value || typeof value !== 'object' || !value.batch || value.batch.version !== 1 || value.batch.targetId !== id ||
      !roomId(value.batch.operationId) || value.batch.operationId === DEFAULT_ROOM_ID ||
      !Array.isArray(value.batch.memberIds) || value.batch.memberIds.some(member => !orderId(member)) ||
      !Array.isArray(value.batch.sources) || value.batch.sources.length < 2 || value.batch.sources.some(source => !roomId(source.id) || source.id === id) ||
      !['keep', 'archive'].includes(value.batch.disposition) ||
      !['preparing', 'joining', 'archiving', 'ready', 'partial', 'failed', 'undoing', 'undone'].includes(value.stage) ||
      typeof value.imported !== 'boolean' || !Array.isArray(value.joins) || !Array.isArray(value.sources) ||
      value.sources.some(source => !roomId(source.id) || !['pending', 'done', 'failed', 'restored', 'changed'].includes(source.status) || !Array.isArray(source.members)) ||
      !Array.isArray(value.memberProofs) || !Array.isArray(value.failures)) throw Error('Invalid merge');
  if (['undoStarted', 'undoKeptTarget', 'undoTargetFailed'].some(key => value[key] !== undefined && typeof value[key] !== 'boolean') ||
      value.undoTargetRevision !== undefined && (!Number.isSafeInteger(value.undoTargetRevision) || value.undoTargetRevision < 0)) throw Error('Invalid undo');
  validateBatch(value.batch);
}
function validateRoom(data) {
  if (!data || data.version !== 1 || validateName(data.name) !== data.name || typeof data.notes !== 'string' || data.notes.length > 8000 || !Number.isSafeInteger(data.revision) || data.revision < 0 || !Array.isArray(data.events)) throw Error('Invalid room');
  for (const e of data.events) if (!e || typeof e.id !== 'string' || e.role !== 'system' || typeof e.text !== 'string' || !Number.isFinite(e.time) || (e.sessionId !== undefined && typeof e.sessionId !== 'string')) throw Error('Invalid event');
  for (const key of ['archivedSessions', 'restoreMembers']) if (data[key] !== undefined && (!Array.isArray(data[key]) || data[key].some(id => !orderId(id)))) throw Error('Invalid archive');
  if (data.archived !== undefined && typeof data.archived !== 'boolean') throw Error('Invalid archive');
  if (data.files !== undefined && (!Array.isArray(data.files) || data.files.some(f => !f || typeof f.id !== 'string' || !roomId(f.id) || f.id === DEFAULT_ROOM_ID || typeof f.path !== 'string' || !path.isAbsolute(f.path) || /\u0000/.test(f.path) || typeof f.name !== 'string' || !f.name || /[\u0000-\u001f]/u.test(f.name)) || new Set(data.files.map(f => f.id)).size !== data.files.length)) throw Error('Invalid files');
  if (data.merge !== undefined) validateMerge(data.merge, data.id);
  return { ...initialRoom(data.name), ...data, memberOrder: memberOrder(data.memberOrder) };
}

// One desktop-profile writer, independent of retained provider services.
// This is human-readable local context, never a provider memory injection.
class RoomState {
  constructor(directory) {
    this.file = path.join(directory, 'room-state.json');
    this.spacesFile = path.join(directory, 'collaboration-spaces.json');
    this.value = { ...initialRoom('共同工作'), archivedSessions: [] };
    this.spaces = { version: 1, rooms: [] };
    this.spacesWarning = '';
    this.warning = '';
    this.queue = Promise.resolve();
    this.gates = new Set();
    this.mergePreviews = new Map();
    this.mergeJobs = new Map();
    try {
      const stat = fs.lstatSync(this.file);
      if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077)) throw Error('Unsafe file');
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      // A damaged display preference must never block native input or sharing.
      this.value = { ...this.value, ...validateRoom(data) };
    } catch (error) { if (error.code !== 'ENOENT') this.warning = '协作资料暂时无法读取；原文件已保留，请检查本机数据后重开。'; }
    try {
      const stat = fs.lstatSync(this.spacesFile);
      if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077)) throw Error('Unsafe file');
      const data = JSON.parse(fs.readFileSync(this.spacesFile, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.rooms) || data.rooms.some(r => !r || !roomId(r.id) || r.id === DEFAULT_ROOM_ID) || new Set(data.rooms.map(r => r.id)).size !== data.rooms.length) throw Error('Invalid spaces');
      this.spaces = { version: 1, rooms: data.rooms.map(r => ({ ...validateRoom(r), id: r.id })) };
    } catch (error) { if (error.code !== 'ENOENT') this.spacesWarning = '其他协作空间的资料暂时无法读取；原文件已保留，请检查本机数据后重开。'; }
  }
  metadata(id = DEFAULT_ROOM_ID) {
    if (!roomId(id)) throw Error('无效协作空间。');
    if (id === DEFAULT_ROOM_ID) return this.value;
    if (this.spacesWarning) throw Error(this.spacesWarning);
    const value = this.spaces.rooms.find(r => r.id === id);
    if (!value) throw Error('找不到这个协作空间。');
    return value;
  }
  write(file, next) {
    const temp = `${file}.${randomUUID()}.tmp`; let fd;
    try {
      fd = fs.openSync(temp, 'wx', 0o600); fs.writeFileSync(fd, JSON.stringify(next)); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(temp, file);
    } catch { throw Error('协作资料未能保存，请检查磁盘空间与本机数据权限。'); }
    finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temp); } catch {} }
  }
  commit(next, id = DEFAULT_ROOM_ID) {
    this.metadata(id);
    if (id === DEFAULT_ROOM_ID) {
      if (this.warning) throw Error(this.warning);
      this.write(this.file, next); this.value = next;
    } else {
      const spaces = { ...this.spaces, rooms: this.spaces.rooms.map(r => r.id === id ? next : r) };
      this.write(this.spacesFile, spaces); this.spaces = spaces;
    }
  }
  create(name) {
    if (this.spacesWarning) throw Error(this.spacesWarning);
    const value = { ...initialRoom(validateName(name)), id: randomUUID() };
    const spaces = { ...this.spaces, rooms: [...this.spaces.rooms, value] };
    this.write(this.spacesFile, spaces); this.spaces = spaces;
    return value.id;
  }
  serial(action) {
    const operation = this.queue.then(action);
    this.queue = operation.catch(() => {}); return operation;
  }
  writable(id) {
    if (this.gates.has(roomGate(id))) throw Error('这个工作区正在更新；修改尚未保存，请保留草稿后稍后再试。');
  }
  mergeRecord(operationId) {
    return this.spaces.rooms.find(value => value.merge?.batch.operationId === operationId);
  }
  setMerge(id, fields) {
    const value = this.metadata(id), merge = { ...value.merge, ...fields };
    validateMerge(merge, id); this.update({ merge }, undefined, id); return this.metadata(id).merge;
  }
  mergeSources(snapshot, ids) {
    if (snapshot.storageWarning || this.warning || this.spacesWarning) throw Error(snapshot.storageWarning || this.warning || this.spacesWarning);
    const state = this.apply(snapshot);
    return ids.map(id => {
      const value = state.rooms.find(room => room.id === id);
      if (!value) throw Error('来源空间已变化，请重新预览。');
      return captureSource(value, state.sessions);
    });
  }
  async mergePreview(client, spec) {
    if (!spec || !Array.isArray(spec.sourceIds) || spec.sourceIds.length < 2 ||
        spec.sourceIds.some(id => !roomId(id)) || new Set(spec.sourceIds).size !== spec.sourceIds.length) throw Error('请选择至少两个不同的来源空间。');
    if (this.mergePreviews.size >= 64) throw Error('待确认的合并预览过多，请先关闭旧预览或重开工作窗口。');
    for (const id of spec.sourceIds) this.assertAvailable(null, true, id);
    const snapshot = await client.call('initial');
    if (!snapshot.capabilities?.includes('spaceMergeV1')) throw Error('当前后台尚不支持合并快照；原空间与草稿保留。');
    if (Array.isArray(spec.memberIds) && spec.memberIds.some(id => {
      const session = snapshot.sessions.find(session => session.id === id);
      return Array.isArray(session?.serviceCapabilities) && !session.serviceCapabilities.includes('collaborationSpacesV1');
    })) throw Error('选中的成员原后台尚不支持多个空间；原身份与草稿保留。');
    const sources = this.mergeSources(snapshot, spec.sourceIds);
    const batch = prepareBatch(sources, { ...spec, operationId: randomUUID(), targetId: randomUUID() });
    this.mergePreviews.set(batch.operationId, { batch, sources });
    return structuredClone(batch);
  }
  discardMergePreview(operationId) { this.mergePreviews.delete(operationId); }
  mergeJob(operationId, binding, kind, action) {
    const existing = this.mergeJobs.get(operationId);
    if (existing) return existing.binding === binding && existing.kind === kind ? existing.promise : Promise.reject(Error('合并步骤正在处理；新的操作暂未执行，没有重发。'));
    const job = Promise.resolve().then(action).finally(() => this.mergeJobs.delete(operationId));
    this.mergeJobs.set(operationId, { binding, kind, promise: job }); return job;
  }
  mergeCommit(client, operationId, binding, recover = false) {
    return this.mergeJob(operationId, binding, 'commit', () => this.performMerge(client, operationId, binding, recover));
  }
  verifyMergeImport(snapshot, batch) {
    const room = snapshot.rooms?.find(room => room.id === batch.targetId);
    const marker = room?.snapshotBatches?.find(value => value.operationId === batch.operationId);
    if (!marker) return false;
    if (snapshot.storageWarning || marker.binding !== batch.binding) throw Error('合并目标的保存结果无法核对；没有归档原空间。');
    const captured = this.mergeSources(snapshot, [batch.targetId])[0];
    const rows = room.messages.filter(row => row.snapshotBatch === batch.operationId);
    const expected = batch.blocks.flatMap(block => block.entries);
    if (rows.length !== expected.length || expected.some(entry => !rows.some(row =>
      row.snapshotHash === entry.hash && row.snapshotOrigin?.roomId === entry.origin.roomId && row.snapshotOrigin?.messageId === entry.origin.messageId)) ||
      captured.rows.filter(row => rows.some(raw => raw.id === row.sourceMessageId)).some(row => !row.complete)) throw Error('合并快照未完整保存；没有裁剪原文或归档原空间。');
    return true;
  }
  async performMerge(client, operationId, binding, recover) {
    let targetId;
    const prepared = await this.serial(async () => {
      const previous = this.mergeRecord(operationId), preview = this.mergePreviews.get(operationId);
      const batch = previous?.merge.batch || preview?.batch;
      if (!batch || batch.binding !== binding) throw Error('合并预览已失效；原空间与草稿保留，请重新预览。');
      sameOperation(batch, batch);
      if (previous && (!recover || previous.merge.undoStarted || ['ready', 'undone'].includes(previous.merge.stage))) return { existing: true, value: structuredClone(previous.merge) };
      if (batch.conflicts.length) throw Error('同一原生会话有多个归属记录，请先核对身份；没有创建或派发。');
      targetId = batch.targetId; this.gates.add(roomGate(targetId));
      try {
        let snapshot = await client.call('initial');
        if (!snapshot.capabilities?.includes('spaceMergeV1')) throw Error('后台合并能力已变化；没有归档原空间。');
        if (!previous) {
          const cuts = this.mergeSources(snapshot, batch.sources.map(source => source.id));
          assertCurrentSources(batch, cuts);
          if (this.spaces.rooms.some(room => room.id === targetId)) throw Error('合并目标已存在，请重新预览。');
          const value = { ...initialRoom(batch.name), id: targetId,
            files: batch.blocks.flatMap(block => block.files.map(file => ({ ...file, id: randomUUID(), snapshotBatch: operationId, origin: { roomId: block.roomId, fileId: file.id } }))), merge: {
            batch: structuredClone(batch), stage: 'preparing', imported: false, joins: [], failures: [],
            memberProofs: batch.memberIds.map(id => ({ id, nativeId: snapshot.sessions.find(s => s.id === id)?.nativeId })),
            sources: cuts.map(source => ({ id: source.id, status: 'pending', revision: source.metadataRevision,
              members: source.members.map(member => ({ id: member.id, nativeId: member.nativeId })) })) } };
          validateMerge(value.merge, targetId);
          const next = { ...this.spaces, rooms: [...this.spaces.rooms, value] };
          this.write(this.spacesFile, next); this.spaces = next;
        }
        let current = this.metadata(targetId).merge;
        if (current.imported && !this.verifyMergeImport(snapshot, batch)) throw Error('先前的合并快照暂时无法核对；没有归档原空间。');
        if (!current.imported) {
          assertCurrentSources(batch, this.mergeSources(snapshot, batch.sources.map(source => source.id)));
          if (!this.verifyMergeImport(snapshot, batch)) {
            const receipt = await client.call('mergeSnapshot', structuredClone(batch));
            if (!receipt || receipt.operationId !== operationId || receipt.binding !== binding || receipt.persisted !== true) throw Error('合并保存结果未确认；没有重发或归档原空间。');
            snapshot = await client.call('initial');
            if (!this.verifyMergeImport(snapshot, batch)) throw Error('合并快照保存后未能核对；没有归档原空间。');
          }
          assertCurrentSources(batch, this.mergeSources(snapshot, batch.sources.map(source => source.id)));
          this.setMerge(targetId, { imported: true, stage: 'joining' });
        }
        for (const id of batch.memberIds) {
          snapshot = await client.call('initial');
          const session = snapshot.sessions.find(session => session.id === id);
          if (!session || session.nativeId !== this.metadata(targetId).merge.memberProofs.find(proof => proof.id === id)?.nativeId) throw Error('目标成员原生身份已变化；没有归档原空间。');
          const result = await this.changeMember(client, id, true, session.name, targetId,
            { nativeId: session.nativeId, revision: membershipRevision(session, targetId) });
          const after = (await client.call('initial')).sessions.find(session => session.id === id);
          if (!after || !isMember(after, targetId)) throw Error('合并成员未全部确认；没有归档原空间。');
          const joins = this.metadata(targetId).merge.joins.filter(join => join.id !== id);
          joins.push({ id, nativeId: after.nativeId, revision: membershipRevision(after, targetId), changed: result.changed });
          this.setMerge(targetId, { joins });
        }
        const value = this.metadata(targetId);
        this.setMerge(targetId, { stage: batch.disposition === 'archive' ? 'archiving' : 'ready', failures: [],
          baseline: value.merge.baseline || mergeSignature(value) });
        return { existing: false, batch };
      } catch (error) {
        if (this.mergeRecord(operationId)) {
          try { this.setMerge(targetId, { stage: 'failed', failures: [error.message] }); } catch { /* Keep the last durable step and original data. */ }
        }
        throw error;
      }
    }).catch(error => { if (targetId) this.gates.delete(roomGate(targetId)); throw error; });
    if (prepared.existing) return prepared.value;
    // archiveRoom enqueues on the same queue: never await it from inside serial.
    try {
      if (prepared.batch.disposition === 'archive') for (const original of this.metadata(targetId).merge.sources) {
        if (original.status === 'done') continue;
        let status = 'done', error = '';
        try {
          if (this.metadata(original.id).revision !== original.revision) throw Error('来源资料已变化；请先核对，未继续归档。');
          const snapshot = await client.call('initial');
          const members = snapshot.sessions.filter(session => isMember(session, original.id));
          if (members.some(session => !original.members.some(member => member.id === session.id && member.nativeId === session.nativeId))) throw Error('来源成员身份已变化；未继续归档。');
          await this.serial(() => {
            const value = this.metadata(targetId).merge;
            this.setMerge(targetId, { sources: value.sources.map(source => source.id === original.id ? { ...source, touched: true } : source) });
          });
          await this.archiveRoom(client, undefined, original.id);
        } catch (failure) { status = 'failed'; error = failure.message; }
        await this.serial(() => {
          const value = this.metadata(targetId).merge;
          const sources = value.sources.map(source => source.id === original.id ? { ...source, status, error, revision: this.metadata(source.id).revision } : source);
          this.setMerge(targetId, { sources });
        });
      }
      await this.serial(() => {
        const value = this.metadata(targetId).merge, failures = value.sources.filter(source => source.status === 'failed').map(source => source.error);
        this.setMerge(targetId, { stage: failures.length ? 'partial' : 'ready', failures });
      });
      this.mergePreviews.delete(operationId);
      return structuredClone(this.metadata(targetId).merge);
    } finally { this.gates.delete(roomGate(targetId)); }
  }
  async mergeStatus(client, operationId) {
    const value = this.mergeRecord(operationId);
    if (!value) throw Error('找不到这次合并记录。');
    const snapshot = await client.call('initial');
    let observedSaved = false, warning = '';
    try { observedSaved = this.verifyMergeImport(snapshot, value.merge.batch); } catch (error) { warning = error.message; }
    return { ...structuredClone(value.merge), observedSaved, warning };
  }
  mergeUndo(client, operationId, binding, keepTarget = false) {
    return this.mergeJob(operationId, binding, 'undo', async () => {
      const value = this.mergeRecord(operationId);
      if (!value || value.merge.batch.binding !== binding) throw Error('合并记录无法核对；没有撤销其他工作。');
      if (value.merge.stage === 'undone') return structuredClone(value.merge);
      const targetId = value.id, gate = roomGate(targetId);
      if (this.gates.has(gate)) throw Error('工作区正在更新，请稍后核对。');
      this.gates.add(gate);
      try {
        const snapshot = await client.call('initial');
        if (snapshot.storageWarning) throw Error(snapshot.storageWarning);
        const current = this.metadata(targetId), record = current.merge;
        const room = snapshot.rooms?.find(room => room.id === targetId);
        const members = snapshot.sessions.filter(session => isMember(session, targetId));
        const sameMembers = members.length === record.joins.length && members.every(session => record.joins.some(join =>
          join.id === session.id && join.nativeId === session.nativeId && join.revision === membershipRevision(session, targetId)));
        const noLaterData = !room?.run && !room?.messages.some(message => message.snapshotBatch !== operationId);
        const ownPartialUndo = record.undoTargetFailed && current.revision === record.undoTargetRevision && members.every(session => record.joins.some(join =>
          join.id === session.id && join.nativeId === session.nativeId && join.revision === membershipRevision(session, targetId)));
        const laterWork = keepTarget || !noLaterData || !(record.baseline === mergeSignature(current) && sameMembers || ownPartialUndo);
        await this.serial(() => this.setMerge(targetId, { stage: 'undoing', undoStarted: true, undoTargetFailed: false, undoKeptTarget: laterWork, failures: [] }));
        if (!laterWork) {
          // archiveRoom owns the same gate and queue; leave both before entry.
          this.gates.delete(gate);
          try { await this.archiveRoom(client, undefined, targetId); }
          catch (error) {
            this.gates.add(gate);
            return await this.serial(() => structuredClone(this.setMerge(targetId, { stage: 'partial', undoTargetFailed: true,
              undoTargetRevision: this.metadata(targetId).revision + 1, failures: [error.message] })));
          }
          this.gates.add(gate);
        }
        for (const original of this.metadata(targetId).merge.sources) {
          if (!original.touched || original.status === 'restored') continue;
          let status = 'restored', error = '';
          try {
            if (this.metadata(original.id).revision !== original.revision) throw Error('来源归档后又有修改；原内容已保留，请从来源空间核对恢复。');
            const state = await client.call('initial');
            if (original.members.some(member => !state.sessions.some(session => session.id === member.id && session.nativeId === member.nativeId))) throw Error('来源会话身份已变化；没有自动恢复成员或重放任务。');
            await this.restoreRoom(client, undefined, original.id);
          } catch (failure) { status = 'changed'; error = failure.message; }
          await this.serial(() => {
            const record = this.metadata(targetId).merge;
            this.setMerge(targetId, { sources: record.sources.map(source => source.id === original.id ? { ...source, status, error, revision: this.metadata(source.id).revision } : source) });
          });
        }
        await this.serial(() => {
          const record = this.metadata(targetId).merge, failures = record.sources.filter(source => source.status === 'changed').map(source => source.error);
          this.setMerge(targetId, { stage: failures.length ? 'partial' : 'undone', failures });
        });
        return structuredClone(this.metadata(targetId).merge);
      } finally { this.gates.delete(gate); }
    });
  }
  update(fields, event, id = DEFAULT_ROOM_ID) {
    const value = this.metadata(id);
    if (value.revision === Number.MAX_SAFE_INTEGER) throw Error('协作资料版本已达上限，未覆盖原记录。');
    const events = event ? [...value.events, { id: randomUUID(), role: 'system', time: Date.now(), ...event }] : (fields.events || value.events);
    this.commit({ ...value, ...fields, revision: value.revision + 1, events }, id);
  }
  rename(name, id = DEFAULT_ROOM_ID) {
    this.writable(id);
    const validated = validateName(name);
    if (this.metadata(id).name !== validated) this.update({ name: validated }, { kind: 'rename', text: `工作区改名为「${validated}」` }, id);
  }
  notes(text, revision, id = DEFAULT_ROOM_ID) {
    this.writable(id);
    if (typeof text !== 'string' || text.length > 8000 || /\u0000/.test(text)) throw Error('共享笔记最多 8000 个字符，不能包含空字符。');
    const value = this.metadata(id);
    if (revision !== value.revision) throw Error('协作资料已在另一个窗口更新。请先复制你的修改，再重新打开核对。');
    if (text !== value.notes) this.update({ notes: text }, { kind: 'notes', text: text ? `更新了共享笔记（尚未发送给 agent）\n${text}` : '清空了共享笔记（不会撤回已经发送的内容）' }, id);
  }
  addFiles(files, id = DEFAULT_ROOM_ID) {
    this.writable(id);
    const value = this.metadata(id), next = [...value.files];
    if (!Array.isArray(files)) throw Error('无效文件列表。');
    for (const file of files) {
      if (typeof file !== 'string' || !path.isAbsolute(file) || /[\u0000-\u001f]/u.test(file)) throw Error('无效本机文件路径。');
      if (!next.some(f => f.path === file)) next.push({ id: randomUUID(), path: file, name: path.basename(file) });
    }
    if (next.length !== value.files.length) this.update({ files: next }, { kind: 'files', text: '添加了本机文件引用 · 尚未发送给 agent' }, id);
  }
  removeFile(fileId, revision, id = DEFAULT_ROOM_ID) {
    this.writable(id);
    const value = this.metadata(id);
    if (revision !== value.revision) throw Error('协作资料已更新，请重新核对文件列表。');
    if (value.files.some(f => f.id === fileId)) this.update({ files: value.files.filter(f => f.id !== fileId) }, { kind: 'files', text: '移除了文件引用 · 本机原文件保留' }, id);
  }
  moveMember(change, records, room = DEFAULT_ROOM_ID) {
    this.writable(room);
    if (!change || ![Object.prototype, null].includes(Object.getPrototypeOf(change)) || !orderId(change.id) || !orderId(change.target) || typeof change.after !== 'boolean') throw Error('无效成员顺序。');
    const value = this.metadata(room), people = records.filter(s => isMember(s, room) && !s.archived);
    for (const id of [change.id, change.target]) {
      this.assertAvailable(id, true, room);
      if (!people.some(s => s.id === id)) throw Error('成员已变化，顺序未更改。');
    }
    if (change.id === change.target) return;
    const ids = new Set(records.map(s => s.id)), order = value.memberOrder.filter(id => ids.has(id));
    for (const id of ids) if (!order.includes(id)) order.push(id);
    if (order.length > 10000 || order.some(id => !orderId(id))) throw Error('成员顺序过长或无效。');
    order.splice(order.indexOf(change.id), 1);
    order.splice(order.indexOf(change.target) + Number(change.after), 0, change.id);
    if (JSON.stringify(order) === JSON.stringify(value.memberOrder)) return;
    // Presentation changes neither invalidate notes/clear confirmations nor
    // create membership events, pause routing, or touch a native session.
    this.commit({ ...value, memberOrder: order }, room);
  }
  // Register human intervention immediately, then serialize membership changes
  // across windows. Record only acknowledged state transitions, not drag intent.
  enqueue(client, action, sessionId, room = DEFAULT_ROOM_ID) {
    const pause = typeof client.callSpace === 'function' ? Promise.all((Array.isArray(room) ? room : [room]).map(id => client.callSpace(id, 'pause', []))) : room === DEFAULT_ROOM_ID || Array.isArray(room) ? sessionId ? client.call('pause', sessionId) : client.call('pause') : client.call('pauseSpace', room); pause.catch(() => {});
    const operation = this.queue.then(async () => { await pause; return action(); });
    this.queue = operation.catch(() => {}); return operation;
  }
  membership(client, id, join, label, room = DEFAULT_ROOM_ID, expected) {
    if (typeof id !== 'string' || typeof join !== 'boolean') return Promise.reject(Error('无效成员操作。'));
    try { this.metadata(room); } catch (error) { return Promise.reject(error); }
    return this.enqueue(client, () => {
      if (join) this.assertAvailable(id, true, room);
      return this.changeMember(client, id, join, label, room, expected);
    }, id, room);
  }
  async changeMember(client, id, join, label, room = DEFAULT_ROOM_ID, expected) {
      const before = (await client.call('initial')).sessions.find(s => s.id === id);
      if (!before) throw Error('找不到这个会话。');
      if (expected !== undefined && (!expected || expected.nativeId !== before.nativeId || expected.revision !== membershipRevision(before, room))) throw Error('成员关系或原生身份已变化；这次撤销没有执行。');
      if (isMember(before, room) === join) return { changed: false, roomId: room, sessionId: id, joined: join };
      if (typeof client.callSpace === 'function') await client.callSpace(room, 'join', expected === undefined ? [id, join] : [id, join, expected]);
      else if (expected !== undefined) await client.call('joinSpace', id, join, room, expected);
      else if (room === DEFAULT_ROOM_ID) await client.call('join', id, join);
      else await client.call('joinSpace', id, join, room);
      const after = (await client.call('initial')).sessions.find(s => s.id === id);
      if (!after || isMember(after, room) !== join) throw Error('成员状态未确认，请重新连接核对。');
      try { this.update({}, { kind: join ? 'join' : 'leave', sessionId: id, name: label || before.name, text: join ? '加入了工作区 · 未发送历史或通知模型' : '离开了工作区 · 原生会话与已收到的内容保留' }, room); }
      catch { throw Error('成员关系已更新，但时间线未能保存。原生会话已保留，请检查本机数据。'); }
      return { changed: true, roomId: room, sessionId: id, joined: join, revision: membershipRevision(after, room), nativeId: after.nativeId };
  }
  assertAvailable(id, shared = false, room = DEFAULT_ROOM_ID) {
    if (this.warning) throw Error(this.warning);
    if (id && (this.value.archivedSessions.includes(id) || this.gates.has(id))) throw Error('这个会话已归档或正在归档，请先从归档列表恢复。');
    if (shared && (this.metadata(room).archived || this.gates.has(room === DEFAULT_ROOM_ID ? 'room' : `room:${room}`))) throw Error('这个工作区已归档或正在恢复，请先从归档列表恢复。');
    const merge = shared && this.metadata(room).merge;
    if (merge && (!merge.imported || merge.joins.length !== merge.batch.memberIds.length || ['preparing', 'joining', 'failed', 'undoing'].includes(merge.stage))) throw Error('合并步骤尚未全部核对；原空间与草稿保留，请先核对合并记录。');
  }
  archiveSession(client, id, label) {
    if (typeof id !== 'string' || !id || id.length > 100) return Promise.reject(Error('无效会话。'));
    if (this.gates.has(id)) return Promise.reject(Error('这个会话正在更新，请稍候。'));
    this.gates.add(id);
    return this.enqueue(client, async () => {
      if (this.value.archivedSessions.includes(id)) return;
      const session = (await client.call('initial')).sessions.find(s => s.id === id);
      if (!session) throw Error('找不到这个会话。');
      for (const space of roomIds(session)) { this.metadata(space); await this.changeMember(client, id, false, label, space); }
      this.update({ archivedSessions: [...this.value.archivedSessions, id] });
    }, id, typeof client.snapshot === 'function' ? roomIds(client.snapshot().sessions.find(s => s.id === id)) : DEFAULT_ROOM_ID).finally(() => this.gates.delete(id));
  }
  restoreSession(id) {
    if (this.gates.has(id)) throw Error('这个会话正在归档，请稍候。');
    if (this.value.archivedSessions.includes(id)) this.update({ archivedSessions: this.value.archivedSessions.filter(value => value !== id) });
  }
  archiveRoom(client, labels, room = DEFAULT_ROOM_ID) {
    const gate = room === DEFAULT_ROOM_ID ? 'room' : `room:${room}`;
    try { this.metadata(room); } catch (error) { return Promise.reject(error); }
    if (this.gates.has(gate)) return Promise.reject(Error('工作区正在更新，请稍候。'));
    this.gates.add(gate);
    return this.enqueue(client, async () => {
      const value = this.metadata(room);
      if (value.archived) return;
      const members = (await client.call('initial')).sessions.filter(s => isMember(s, room));
      // Save the intended roster before detaching so a partial failure cannot
      // lose the information needed for an explicit restore/retry.
      const restoreMembers = [...new Set([...value.restoreMembers, ...members.map(s => s.id)])];
      this.update({ restoreMembers }, undefined, room);
      for (const s of members) await this.changeMember(client, s.id, false, labels?.get(s.id), room);
      this.update({ archived: true }, { kind: 'archive', text: '工作区已归档 · 后续投递已暂停，原生任务仍可能继续' }, room);
    }, undefined, room).finally(() => this.gates.delete(gate));
  }
  restoreRoom(client, labels, room = DEFAULT_ROOM_ID) {
    const gate = room === DEFAULT_ROOM_ID ? 'room' : `room:${room}`;
    try { this.metadata(room); } catch (error) { return Promise.reject(error); }
    if (this.gates.has(gate)) return Promise.reject(Error('工作区正在更新，请稍候。'));
    this.gates.add(gate);
    return this.enqueue(client, async () => {
      const value = this.metadata(room);
      if (!value.archived && !value.restoreMembers.length) return;
      const sessions = (await client.call('initial')).sessions;
      const wanted = value.restoreMembers.filter(id => sessions.some(s => s.id === id) && !this.value.archivedSessions.includes(id));
      for (const id of wanted) await this.changeMember(client, id, true, labels?.get(id), room);
      this.update({ archived: false, restoreMembers: [] }, { kind: 'restore', text: '工作区已恢复 · 原记录与可用成员已保留，没有重发任务' }, room);
    }, undefined, room).finally(() => this.gates.delete(gate));
  }
  clear(revision, room = DEFAULT_ROOM_ID) {
    this.writable(room);
    const value = this.metadata(room);
    if (revision === undefined) revision = value.revision;
    if (revision !== value.revision) throw Error('协作资料已在清除期间更新，请核对后重新清除。');
    const fields = { notes: '', events: [] };
    if (value.merge) {
      // Clear the imported bodies too. Keep only a replay tombstone; the
      // independent original spaces and the person's file references remain.
      fields.merge = undefined;
      fields.clearedMerge = { operationId: value.merge.batch.operationId, binding: value.merge.batch.binding,
        sourceIds: value.merge.batch.sources.map(source => source.id) };
    }
    this.update(fields, undefined, room);
    if (value.merge) this.mergePreviews.delete(value.merge.batch.operationId);
  }
  apply(snapshot, selected = DEFAULT_ROOM_ID) {
    const metadata = [{ ...this.value, id: DEFAULT_ROOM_ID }, ...this.spaces.rooms];
    const rooms = metadata.map(value => {
      const backend = (snapshot.rooms || [snapshot.room]).find(r => r?.id === value.id || value.id === DEFAULT_ROOM_ID && r && !r.id);
      return { ...(backend || { id: value.id, revision: 0, run: null, messages: [] }), id: value.id, name: value.name, notes: value.notes, metadataRevision: value.revision, events: value.events, archived: value.archived, memberOrder: [...value.memberOrder], files: value.files.map(f => ({ ...f })),
        ...(value.merge ? { merge: { operationId: value.merge.batch.operationId, binding: value.merge.batch.binding, stage: value.merge.stage,
          imported: value.merge.imported, failures: [...value.merge.failures], undoKeptTarget: Boolean(value.merge.undoKeptTarget),
          sources: value.merge.sources.map(source => ({ id: source.id, name: value.merge.batch.sources.find(original => original.id === source.id)?.name, status: source.status, error: source.error || '' })),
          notes: value.merge.batch.blocks.filter(block => block.notes !== null && block.notes !== '').map(block => ({ roomId: block.roomId, name: block.name, text: block.notes })),
          events: value.merge.batch.blocks.filter(block => block.events.length).map(block => ({ roomId: block.roomId, name: block.name, events: structuredClone(block.events) })) } } : {}) };
    });
    return { ...snapshot, sessions: snapshot.sessions.map(s => ({ ...s, archived: this.value.archivedSessions.includes(s.id) })), roomStorageWarning: this.warning || this.spacesWarning, rooms, room: rooms.find(r => r.id === selected) || { id: selected, name: '空间资料未能读取', unavailable: true, archived: true, messages: [], events: [], files: [], notes: '', memberOrder: [], metadataRevision: 0 } };
  }
}
module.exports = { RoomState };
