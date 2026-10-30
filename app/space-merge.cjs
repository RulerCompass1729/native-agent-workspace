const { createHash } = require('node:crypto');
const path = require('node:path');
const { roomId, roomIds, membershipRevision, completedSharedRecord: completed } = require('./collaboration-spaces.cjs');
const { validateName } = require('./session-labels.cjs');
const { REQUEST_BYTES, RESPONSE_BYTES } = require('./service-transport.cjs');

// Pure snapshot contract. Callers must recapture trusted shared room records;
// neither this module nor a preview grants delivery or changes native sessions.
const failure = () => Error('合并资料无法核对；原空间与草稿已保留，请重新预览。');
const object = value => value && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f]/u.test(value);
const revision = value => Number.isSafeInteger(value) && value >= 0;
const fields = ['id', 'role', 'text', 'input', 'name', 'time', 'sessionId', 'recipientId', 'replyTo',
  'status', 'kind', 'title', 'toolKind', 'commandActions', 'commandSource', 'exitCode', 'incomplete',
  'nativeMessageId', 'nativeId', 'turnId', 'displayTurnId', 'nativeStatus', 'nativeStartedAt',
  'nativeCompletedAt', 'nativeDurationMs', 'sharingStopped', 'finalReply', 'images', 'inputMode',
  'addressed', 'manualReply', 'deliveryTracked'];
const deliveryFields = ['id', 'recipientId', 'recipientName', 'text', 'status', 'time'];

function json(value) {
  // JSON-only local records, with a stable object key order for content cuts.
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(json);
  if (!object(value)) throw failure();
  return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, json(value[key])]));
}
const hash = value => createHash('sha256').update(JSON.stringify(json(value))).digest('hex');
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, json(value[key])]));

function captureSource(room, sessions) {
  if (!object(room) || !roomId(room.id) || room.unavailable || !revision(room.metadataRevision) ||
      !revision(room.revision) || typeof room.notes !== 'string' || room.notes.length > 8000 ||
      !Array.isArray(room.messages) || !Array.isArray(room.events) || !Array.isArray(room.files) || !Array.isArray(sessions)) throw failure();
  const seen = new Set();
  const rows = room.messages.map((message, sourceIndex) => {
    if (!object(message) || !id(message.id) || seen.has(message.id) ||
        !['human', 'assistant', 'tool', 'system'].includes(message.role) || typeof message.text !== 'string') throw failure();
    seen.add(message.id);
    const payload = pick(message, fields);
    if (Array.isArray(message.deliveries)) payload.deliveries = message.deliveries.map(delivery => pick(delivery, deliveryFields));
    const origin = message.snapshotOrigin ?? { roomId: room.id, messageId: message.id };
    if (!object(origin) || !roomId(origin.roomId) || !id(origin.messageId) ||
        Object.keys(origin).some(key => !['roomId', 'messageId'].includes(key))) throw failure();
    payload.id = origin.messageId;
    if (message.snapshotOrigin && message.snapshotHash !== hash(payload)) throw failure();
    return { sourceMessageId: message.id, sourceIndex, origin: json(origin), payload, complete: completed(message) };
  });
  const members = sessions.filter(session => roomIds(session).includes(room.id)).map(session => {
    if (!id(session.id) || !id(session.provider) || session.nativeId != null && !id(session.nativeId) ||
        !revision(session.controlRevision ?? 0) || !revision(session.connectionRevision ?? 0)) throw failure();
    return { id: session.id, provider: session.provider, nativeId: session.nativeId || null,
      name: typeof session.name === 'string' ? session.name : '', archived: Boolean(session.archived),
      memberRevision: membershipRevision(session, room.id), controlRevision: session.controlRevision ?? 0,
      connectionRevision: session.connectionRevision ?? 0,
      // A warning only: these booleans never carry an input, grant or permission.
      pending: Boolean(session.pendingQueue || session.pendingSteer || session.approval || session.activeTurnId) };
  }).sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(members.map(member => member.id)).size !== members.length) throw failure();
  const fileIds = new Set(), eventIds = new Set();
  const value = { id: room.id, name: validateName(room.name), revision: room.revision,
    metadataRevision: room.metadataRevision, archived: Boolean(room.archived), notes: room.notes,
    files: room.files.map(file => {
      if (!object(file) || !roomId(file.id) || file.id === 'shared' || typeof file.path !== 'string' || !path.isAbsolute(file.path) || /[\u0000-\u001f]/u.test(file.path) ||
          !id(file.name) || fileIds.has(file.id)) throw failure();
      fileIds.add(file.id);
      return pick(file, ['id', 'name', 'path']);
    }),
    events: room.events.map(event => {
      if (!object(event) || !id(event.id) || event.role !== 'system' || typeof event.text !== 'string' || eventIds.has(event.id)) throw failure();
      eventIds.add(event.id);
      return pick(event, ['id', 'role', 'text', 'kind', 'time', 'sessionId', 'name']);
    }),
    rows, members, run: room.run ? pick(room.run, ['id', 'status', 'steps', 'reason']) : null };
  return { ...value, cut: hash(value) };
}

function select(values, keys, keyOf) {
  if (keys === undefined) return values;
  const available = new Set(values.map(keyOf));
  if (!Array.isArray(keys) || keys.some(key => !id(key) || !available.has(key)) || new Set(keys).size !== keys.length) throw failure();
  // Preserve source order, regardless of the UI's selection order.
  const selected = new Set(keys);
  return values.filter(value => selected.has(keyOf(value)));
}
function block(source, selection = {}) {
  if (!object(selection) || selection.includeNotes !== undefined && typeof selection.includeNotes !== 'boolean') throw failure();
  const rows = select(source.rows, selection.messageIds, row => row.sourceMessageId);
  if (selection.messageIds !== undefined && rows.some(row => !row.complete)) throw failure();
  return { roomId: source.id, name: source.name,
    notes: selection.includeNotes === false ? null : source.notes,
    files: json(select(source.files, selection.fileIds, file => file.id)),
    events: json(select(source.events, selection.eventIds, event => event.id)),
    entries: rows.filter(row => row.complete).map(({ sourceMessageId, sourceIndex, origin, payload }) => ({
      origin: json(origin), sourceMessageId, sourceIndex,
      payload: json(payload), hash: hash(payload),
    })),
    omitted: source.rows.filter(row => !row.complete).map(({ payload }) => ({ id: payload.id, status: payload.status || 'unknown', incomplete: Boolean(payload.incomplete) })),
    pending: Boolean(source.run?.status === 'running' || source.members.some(member => member.pending)) };
}
function selectedCut(source, selected, memberIds) {
  // Pending/late output may progress in A/B. Only the original selected content
  // and membership/metadata authority are commitments for C's fixed snapshot.
  return hash({ id: source.id, name: source.name, metadataRevision: source.metadataRevision, archived: source.archived,
    members: source.members.filter(member => memberIds.includes(member.id)).map(member =>
      pick(member, ['id', 'provider', 'nativeId', 'archived', 'memberRevision', 'controlRevision', 'connectionRevision'])),
    entries: [...selected.entries, ...(selected.references || [])].sort((a, b) => a.sourceIndex - b.sourceIndex)
      .map(entry => pick(entry, ['origin', 'sourceMessageId', 'hash'])),
    notes: selected.notes, files: selected.files, events: selected.events });
}

function prepareBatch(sources, spec, maxBytes = REQUEST_BYTES) {
  if (!Array.isArray(sources) || sources.length < 2 || !object(spec) ||
      !roomId(spec.operationId) || spec.operationId === 'shared' || !roomId(spec.targetId) || spec.targetId === 'shared' ||
      !['keep', 'archive'].includes(spec.disposition) || !Array.isArray(spec.memberIds) ||
      new Set(spec.memberIds).size !== spec.memberIds.length || spec.memberIds.some(member => !id(member) || member.length > 100) ||
      !Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > RESPONSE_BYTES) throw failure();
  const ids = sources.map(source => source.id);
  if (new Set(ids).size !== ids.length || ids.includes(spec.targetId)) throw failure();
  for (const source of sources) {
    const { cut, ...value } = source;
    if (cut !== hash(value) || source.archived) throw failure();
  }
  const selections = spec.selections ?? [];
  if (!Array.isArray(selections) || selections.some(selection => !object(selection) || !ids.includes(selection.roomId)) ||
      new Set(selections.map(selection => selection.roomId)).size !== selections.length) throw failure();
  const members = new Map(), aliases = new Map(), conflicts = [];
  for (const source of sources) for (const member of source.members) {
    const existing = members.get(member.id);
    if (existing && (existing.provider !== member.provider || existing.nativeId !== member.nativeId ||
        existing.controlRevision !== member.controlRevision || existing.connectionRevision !== member.connectionRevision)) throw failure();
    members.set(member.id, member);
  }
  for (const memberId of spec.memberIds) {
    const member = members.get(memberId);
    if (!member || member.archived || !member.nativeId) throw failure();
    const alias = JSON.stringify([member.provider, member.nativeId]), other = aliases.get(alias);
    if (other) conflicts.push({ kind: 'native-alias', sessionIds: [other, member.id] });
    else aliases.set(alias, member.id);
  }
  const blocks = sources.map(source => block(source, selections.find(selection => selection.roomId === source.id)));
  const origins = new Map();
  for (const selected of blocks) {
    selected.references = [];
    selected.entries = selected.entries.filter(entry => {
      const key = JSON.stringify(entry.origin), previous = origins.get(key);
      if (!previous) { origins.set(key, entry); return true; }
      if (previous.hash !== entry.hash) throw Error('同一来源条目的内容不一致；没有合并或覆盖原文，请回到原空间核对。');
      selected.references.push(pick(entry, ['origin', 'sourceMessageId', 'sourceIndex', 'hash']));
      return false;
    });
  }
  const batch = { version: 1, operationId: spec.operationId, targetId: spec.targetId,
    name: validateName(spec.name), disposition: spec.disposition,
    sources: sources.map((source, index) => ({ id: source.id, name: source.name, cut: source.cut, selectedCut: selectedCut(source, blocks[index], spec.memberIds) })),
    // IDs are presentation-independent references, never copies of a session.
    memberIds: [...spec.memberIds], conflicts,
    blocks,
  };
  const encoded = JSON.stringify(batch), bytes = Buffer.byteLength(encoded, 'utf8');
  if (bytes > maxBytes) throw Error('选中的合并快照超过本次传输上限；没有裁剪原文或更改原空间，请缩小选择后重新预览。');
  return { ...batch, bytes, binding: hash(batch) };
}

function assertCurrentSources(batch, sources) {
  validateBinding(batch);
  if (!Array.isArray(sources) || sources.length !== batch.sources.length || sources.some((source, index) => {
    const { cut, ...value } = source;
    if (source.id !== batch.sources[index].id || cut !== hash(value)) return true;
    const selected = batch.blocks[index];
    const current = block(source, { messageIds: [...selected.entries, ...selected.references].map(entry => entry.sourceMessageId),
      fileIds: selected.files.map(file => file.id), eventIds: selected.events.map(event => event.id), includeNotes: selected.notes !== null });
    return selectedCut(source, current, batch.memberIds) !== batch.sources[index].selectedCut;
  })) throw failure();
}
function validateBinding(batch) {
  if (!object(batch)) throw failure();
  const { bytes, binding, ...body } = batch;
  if (binding !== hash(body) || bytes !== Buffer.byteLength(JSON.stringify(body), 'utf8')) throw failure();
}
function sameOperation(existing, candidate) {
  if (!existing || existing.operationId !== candidate.operationId) return false;
  validateBinding(existing); validateBinding(candidate);
  if (existing.binding !== candidate.binding) throw failure();
  return true;
}

function validateBatch(batch) {
  validateBinding(batch);
  if (batch.version !== 1 || !roomId(batch.operationId) || batch.operationId === 'shared' ||
      !roomId(batch.targetId) || batch.targetId === 'shared' || validateName(batch.name) !== batch.name ||
      !['keep', 'archive'].includes(batch.disposition) || !Array.isArray(batch.memberIds) ||
      batch.memberIds.some(member => !id(member) || member.length > 100) || new Set(batch.memberIds).size !== batch.memberIds.length ||
      !Array.isArray(batch.sources) || batch.sources.length < 2 || !Array.isArray(batch.blocks) ||
      batch.blocks.length !== batch.sources.length || !Array.isArray(batch.conflicts)) throw failure();
  const sources = new Set(), origins = new Map(), references = [];
  batch.sources.forEach((source, index) => {
    if (!object(source) || !roomId(source.id) || source.id === batch.targetId || sources.has(source.id) ||
        !/^[a-f0-9]{64}$/u.test(source.cut) || !/^[a-f0-9]{64}$/u.test(source.selectedCut)) throw failure();
    sources.add(source.id);
    const selected = batch.blocks[index];
    if (!object(selected) || selected.roomId !== source.id || typeof selected.name !== 'string' ||
        !(selected.notes === null || typeof selected.notes === 'string' && selected.notes.length <= 8000) ||
        !Array.isArray(selected.files) || !Array.isArray(selected.events) || !Array.isArray(selected.entries) ||
        !Array.isArray(selected.references) || !Array.isArray(selected.omitted)) throw failure();
    // Reuse the existing source schema for metadata, without looking at files.
    captureSource({ id: source.id, name: selected.name, revision: 0, metadataRevision: 0,
      notes: selected.notes || '', files: selected.files, events: selected.events, messages: [] }, []);
    const indices = new Set(), currentIds = new Set();
    for (const entry of [...selected.entries, ...selected.references]) {
      if (!object(entry) || !object(entry.origin) || !roomId(entry.origin.roomId) || !id(entry.origin.messageId) ||
          Object.keys(entry.origin).some(key => !['roomId', 'messageId'].includes(key)) || !id(entry.sourceMessageId) ||
          !Number.isSafeInteger(entry.sourceIndex) || entry.sourceIndex < 0 || indices.has(entry.sourceIndex) ||
          currentIds.has(entry.sourceMessageId) || !/^[a-f0-9]{64}$/u.test(entry.hash)) throw failure();
      indices.add(entry.sourceIndex); currentIds.add(entry.sourceMessageId);
    }
    for (const entry of selected.entries) {
      const payload = entry.payload;
      if (!object(payload) || payload.id !== entry.origin.messageId ||
          !['human', 'assistant', 'tool', 'system'].includes(payload.role) || typeof payload.text !== 'string' ||
          Object.keys(payload).some(key => ![...fields, 'deliveries'].includes(key)) ||
          !completed(payload) || hash(payload) !== entry.hash || origins.has(JSON.stringify(entry.origin))) throw failure();
      if (payload.deliveries !== undefined && (!Array.isArray(payload.deliveries) || payload.deliveries.some(delivery =>
        !object(delivery) || Object.keys(delivery).some(key => !deliveryFields.includes(key))))) throw failure();
      origins.set(JSON.stringify(entry.origin), entry.hash);
    }
    references.push(...selected.references);
  });
  if (references.some(reference => origins.get(JSON.stringify(reference.origin)) !== reference.hash)) throw failure();
  return batch;
}

function materializeBatch(batch) {
  validateBatch(batch);
  if (batch.conflicts.length) throw Error('原生身份归属存在冲突，没有导入或派发。');
  const messages = [], sourceIds = new Map();
  for (const block of batch.blocks) for (const entry of block.entries) {
    const message = { ...json(entry.payload), id: `snapshot:${batch.operationId}:${messages.length}`,
      snapshotOrigin: json(entry.origin), snapshotHash: entry.hash, snapshotBatch: batch.operationId,
      snapshotOrder: messages.length,
      snapshotSource: { roomId: block.roomId, messageId: entry.sourceMessageId, index: entry.sourceIndex } };
    messages.push(message); sourceIds.set(JSON.stringify([block.roomId, entry.sourceMessageId]), message.id);
  }
  const originals = new Map(messages.map(message => [JSON.stringify(message.snapshotOrigin), message.id]));
  for (const block of batch.blocks) for (const entry of block.references) sourceIds.set(
    JSON.stringify([block.roomId, entry.sourceMessageId]), originals.get(JSON.stringify(entry.origin)));
  for (const message of messages) if (message.replyTo) {
    const target = sourceIds.get(JSON.stringify([message.snapshotSource.roomId, message.replyTo]));
    if (target) message.snapshotReplyTo = target;
  }
  return messages;
}

module.exports = { captureSource, prepareBatch, assertCurrentSources, sameOperation, validateBatch, materializeBatch };
