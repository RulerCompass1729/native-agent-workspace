const { uiError, uiNotice, setWarning } = require('./ui-errors.cjs');
const { spaceWords } = require('./integrator-words.cjs');
const { displayMessage } = require('./ui-locale.js');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { validateName } = require('./session-labels.cjs');
const { DEFAULT_ROOM_ID, roomId, roomIds, isMember, membershipRevision, placementRevision } = require('./collaboration-spaces.cjs');
const { captureSource, prepareBatch, assertCurrentSources, sameOperation, validateBatch } = require('./space-merge.cjs');
const queueRules = require('./queue-dispatch.cjs');
const { archiveIdle, currentFleet } = require('./renderer/fleet-observation.js');
const { queueOutcomeSource, storedQueueSource, noReplyContext, noReplyFact } = require('./butler-ingress.cjs');
const { queueReadySource, queueDoneSource } = require('./butler-ready.cjs');
const orderId = id => typeof id === 'string' && id.length > 0 && id.length <= 100 && !/[\u0000-\u001f]/u.test(id);
const memberOrder = value => Array.isArray(value) && value.length <= 10000 ? [...new Set(value.filter(orderId))] : [];
const contentEvents = events => events.filter(e => !(e.kind === 'control-audit' && e.controlAudit));
const initialRoom = name => ({ version: 1, name, notes: '', revision: 0, events: [], archived: false, restoreMembers: [], restorePlacements: {}, memberOrder: [], files: [] });
const initialShared = () => ({ ...initialRoom('共同工作'), archivedSessions: [], sessionArchives: {}, restoredSessions: [] });
const roomGate = id => id === DEFAULT_ROOM_ID ? 'room' : `room:${id}`;
const mergeSignature = value => createHash('sha256').update(JSON.stringify({ name: value.name, notes: value.notes,
  files: value.files, events: contentEvents(value.events).map(e => e.id), memberOrder: value.memberOrder })).digest('hex');
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
function restorePlacement(session) {
  return { nativeId: session.nativeId ?? null, connectionRevision: session.connectionRevision || 0,
    revision: placementRevision(session), signature: JSON.stringify([roomIds(session).sort(), session.memberRevision || 0,
      Object.entries(session.roomMembershipRevisions || {}).sort(([a], [b]) => a.localeCompare(b))]) };
}
function sameHome(session, saved) {
  if (!session || !saved) return false;
  const { connectionRevision: _currentConnection, ...current } = restorePlacement(session);
  const { connectionRevision: _savedConnection, ...original } = saved;
  return JSON.stringify(current) === JSON.stringify(original);
}
function validPlacement(p) {
  return p && typeof p === 'object' && (p.nativeId === null || typeof p.nativeId === 'string') &&
    Number.isSafeInteger(p.connectionRevision) && p.connectionRevision >= 0 && Number.isSafeInteger(p.revision) && p.revision >= 0 &&
    typeof p.signature === 'string' && p.signature.length <= 1048576;
}
function validMove(p) {
  return p && roomId(p.operationId) && p.operationId !== DEFAULT_ROOM_ID &&
    (p.nativeId === null || typeof p.nativeId === 'string') &&
    ['revision', 'placementRevision', 'connectionRevision'].every(k => Number.isSafeInteger(p[k]) && p[k] >= 0);
}
function validSessionArchive(p) {
  return p && typeof p === 'object' && (p.nativeId === null || typeof p.nativeId === 'string') && Array.isArray(p.rooms) && p.rooms.length <= 10000 &&
    new Set(p.rooms.map(r => r?.id)).size === p.rooms.length && p.rooms.every(r => r && roomId(r.id) && Number.isSafeInteger(r.index) && r.index >= 0 && r.index <= 10000 &&
      (r.next === undefined || r.next === null || orderId(r.next)) &&
      typeof r.done === 'boolean' && (r.expected === null || validMove(r.expected))) &&
    (p.archivedByRoom === undefined || roomId(p.archivedByRoom) && p.rooms.length === 1 && p.rooms[0].id === p.archivedByRoom) && validPlacement(p.checkpoint) && (p.detached === null || validPlacement(p.detached)) && (p.restoreExpected === undefined || validMove(p.restoreExpected));
}
function validControlAudit(a) {
  const token = v => typeof v === 'string' && v.length > 0 && v.length <= 160 && !/[\u0000-\u001f\u007f]/u.test(v);
  const state = v => ['confirmation-required', 'complete', 'cancelled', 'unconfirmed', 'running', 'not-executed'].includes(v);
  // A 160-unit transport name may expand to six visible units per character.
  const name = v => typeof v === 'string' && v.length > 0 && v.length <= 960 && !/[\u0000-\u001f\u007f]/u.test(v);
  return a && token(a.operationId) && a.actor && ['id', 'nativeId'].every(k => token(a.actor[k])) && name(a.actor.name) &&
    ['claude', 'codex'].includes(a.actor.provider) && token(a.method) && token(a.action) && state(a.state) &&
    (a.resultState === undefined || state(a.resultState));
}
function validateRoom(data) {
  if (!data || data.version !== 1 || validateName(data.name) !== data.name || typeof data.notes !== 'string' || data.notes.length > 8000 || !Number.isSafeInteger(data.revision) || data.revision < 0 || !Array.isArray(data.events)) throw Error('Invalid room');
  for (const e of data.events) if (!e || typeof e.id !== 'string' || e.role !== 'system' || typeof e.text !== 'string' || !Number.isFinite(e.time) || (e.sessionId !== undefined && typeof e.sessionId !== 'string')) throw Error('Invalid event');
  if (data.events.some(e => e.rotationReceipt !== undefined && (e.kind !== 'rotation' || typeof e.rotationReceipt !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(e.rotationReceipt)))) throw Error('Invalid rotation receipt');
  if (data.events.some(e => e.controlAudit !== undefined && (e.kind !== 'control-audit' || !validControlAudit(e.controlAudit)))) throw Error('Invalid maintenance event');
  // B4 metadata is auxiliary; intake policy must not disable this space.
  for (const key of ['archivedSessions', 'restoreMembers', 'restoredSessions']) if (data[key] !== undefined && (!Array.isArray(data[key]) || data[key].some(id => !orderId(id)))) throw Error('Invalid archive');
  if (data.sessionArchives !== undefined && (!data.sessionArchives || typeof data.sessionArchives !== 'object' || Array.isArray(data.sessionArchives) || Object.keys(data.sessionArchives).length > 10000 ||
      Object.entries(data.sessionArchives).some(([id, p]) => !orderId(id) || !validSessionArchive(p)))) throw Error('Invalid session archive placement');
  if (data.archived !== undefined && typeof data.archived !== 'boolean') throw Error('Invalid archive');
  if (data.restorePlacements !== undefined && (!data.restorePlacements || typeof data.restorePlacements !== 'object' || Array.isArray(data.restorePlacements) || Object.entries(data.restorePlacements).some(([id, p]) => !orderId(id) || !p || typeof p !== 'object' || p.nativeId !== null && typeof p.nativeId !== 'string' || !Number.isSafeInteger(p.connectionRevision) || p.connectionRevision < 0 || !Number.isSafeInteger(p.revision) || p.revision < 0 || typeof p.signature !== 'string' || p.signature.length > 1048576))) throw Error('Invalid restore placement');
  if (data.files !== undefined && (!Array.isArray(data.files) || data.files.some(f => !f || typeof f.id !== 'string' || !roomId(f.id) || f.id === DEFAULT_ROOM_ID || typeof f.path !== 'string' || !path.isAbsolute(f.path) || /\u0000/.test(f.path) || typeof f.name !== 'string' || !f.name || /[\u0000-\u001f]/u.test(f.name)) || new Set(data.files.map(f => f.id)).size !== data.files.length)) throw Error('Invalid files');
  if (data.merge !== undefined) validateMerge(data.merge, data.id);
  const room = { ...initialRoom(data.name), ...data, memberOrder: memberOrder(data.memberOrder) };
  // An unreadable switch is off: nothing is attached that the person did not turn on.
  if (room.notesToQueue !== true || !Number.isSafeInteger(room.notesToQueueSince) || room.notesToQueueSince < 0) {
    delete room.notesToQueue; delete room.notesToQueueSince;
  }
  if (data.queue !== undefined) {
    room.queue = queueRules.validateQueue(data.queue);
  }
  return room;
}

// What NAW notices about a queue from the write that changed it (B6 E1 and E2). Both are
// records only: no model, no message and no notification follows from them here.
// - A delivery line (READY <branch> <commit>) is recorded once, when its item becomes done.
// - A steward-assigned ordinary done is a separate report fact; person-assigned items stay quiet.
// - A queue that runs dry is recorded by the write that took its last queued or sent item
//   away, and by no other write. The space counts these, so each record has its own key and
//   a restart, a later write or an older build that added items cannot repeat one.
const queueRound = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const toSend = item => ['queued', 'sent'].includes(item.status);
function queueFacts(room, roomId, previous, next, queue, replyTitle, memberName) {
  const facts = [], fields = {};
  // A delivery line is recorded when its item becomes done, or when the reply to the person's answer is added to a
  // decision that had none (queueAnswered).
  const answered = previous?.status === 'done' && Boolean(previous.answerTag) && !next?.answerTag && !previous.ready;
  if (previous && next && (previous.status !== 'done' || answered) && next.status === 'done' && next.ready) {
    // The name NAW recorded when it sent this member its item; a member holds one item at a time.
    const name = room.events.findLast(e => e.sessionId === next.sentTo && e.uiMessage?.key === 'notice.queue.dispatched')?.uiMessage?.params?.name;
    const params = { text: queueRules.shortText(next.text), branch: next.ready.branch, commit: next.ready.commit.slice(0, 12) };
    facts.push({ kind: 'queue', itemId: next.id, ...(next.sentTo ? { sessionId: next.sentTo } : {}),
      ...(name ? uiNotice('notice.queue.ready', { ...params, name }) : uiNotice('notice.queue.readyUnnamed', params)),
      monitor: { kind: 'ready', key: `ready:${roomId}:${next.id}`, itemId: next.id, branch: next.ready.branch, commit: next.ready.commit },
      butlerSource: queueReadySource(roomId, next, name) });
  } else if (previous?.status === 'sent' && next?.status === 'done' && !next.ready &&
      previous.addedBy === 'steward' && next.addedBy === 'steward') {
    const name = room.events.findLast(e => e.sessionId === next.sentTo && e.uiMessage?.key === 'notice.queue.dispatched')?.uiMessage?.params?.name ?? memberName;
    const title = queueRules.reportTitle(replyTitle ?? next.reply);
    // Older source readers ignore this new auxiliary key rather than rejecting an unknown done kind.
    facts.push({ kind: 'queue', itemId: next.id, sessionId: next.sentTo, text: title,
      monitor: { kind: 'done', key: `done:${roomId}:${next.id}`, itemId: next.id, addedBy: 'steward' },
      butlerDoneSource: queueDoneSource(roomId, next, name, title) });
  }
  if (previous && next && toSend(previous) && !toSend(next) && !queue.some(toSend)) {
    const round = queueRound(room.queueDryRound) + 1, waiting = queue.filter(item => item.status === 'waiting').length;
    fields.queueDryRound = round;
    // 'queue-dry' is this record's own kind; B4's ledger kind 'queue-empty' has another definition.
    facts.push({ kind: 'queue', ...(waiting ? uiNotice('notice.queue.dryWaiting', { count: waiting }) : uiNotice('notice.queue.dry')),
      monitor: { kind: 'queue-dry', key: `queue-dry:${roomId}:${round}`, round, waiting } });
  }
  return { facts, fields };
}

// A detached copy of a space queue for display and dispatch decisions. A queued item the dispatcher's last pass did
// not send carries why, member by member (`wait`, RoomState.setQueueWaits).
function copyQueue(queue, waits = null) {
  const copy = [];
  if (!Array.isArray(queue)) {
    return copy;
  }
  for (const item of queue) {
    const wait = item.status === 'queued' && waits ? waits.get(item.id) : undefined;
    copy.push({ ...item, ...(item.creator ? { creator: { ...item.creator } } : {}), ...(item.ready ? { ready: { ...item.ready } } : {}),
      ...(wait ? { wait: wait.map(entry => ({ ...entry })) } : {}) });
  }
  return copy;
}

// Audit rows store their action, target and undo words in the language of the moment, or the
// method name; these labels let ui-locale show them in the reader's language (old rows too).
// ui-locale checks each label against the stored words, so a name that is not a label stays.
// A value may only be its own built-in phrase; a previous name never is, and a model or effort
// the saved creation details name is not the native default.
const ownPhrase = { target: ['standing.newSession'], model: ['standing.nativeDefault'], effort: ['standing.nativeDefault'], home: ['sidebar.independent'] };
function templateLabel(raw, keys, chosen = {}) {
  const messages = require('./ui-messages.js');
  for (const key of keys) for (const locale of ['zh', 'en']) {
    const template = messages[locale][key], names = [...template.matchAll(/\{(\w+)\}/g)].map(match => match[1]);
    const pattern = template.split(/\{\w+\}/).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('([\\s\\S]*?)');
    const found = new RegExp('^' + pattern + '$', 'u').exec(raw);
    if (!found) continue;
    const params = Object.fromEntries(names.map((name, i) => [name, found[i + 1]]));
    const labels = {};
    for (const name of names) {
      const label = ownPhrase[name] && chosen[name] == null && templateLabel(params[name], ownPhrase[name]);
      if (label) labels[name] = label;
    }
    return { key, ...(names.length ? { params } : {}), ...(Object.keys(labels).length ? { labels } : {}) };
  }
  return null;
}
function auditLabels(event) {
  const params = event.uiMessage?.params, audit = event.controlAudit;
  if (!params || !String(event.uiMessage.key).startsWith('notice.background.')) return null;
  const labels = {}, action = 'background.action.' + audit.action;
  if (typeof params.command === 'string' && Object.hasOwn(require('./ui-messages.js').en, action)) labels.command = { key: action };
  const standing = String(event.uiMessage.key).startsWith('notice.background.standing.');
  const targetKeys = ['standing.creationTarget', ...(/^create/.test(audit.action) ? ['standing.newSession'] : [])];
  const target = standing && typeof params.target === 'string' && templateLabel(params.target, targetKeys, audit.creation || {});
  if (target) labels.target = target;
  const undoKeys = Object.keys(require('./ui-messages.js').en).filter(key => key.startsWith('standing.undo.'));
  const undo = standing && typeof params.undo === 'string' && templateLabel(params.undo, undoKeys);
  if (undo) labels.undo = undo;
  return Object.keys(labels).length ? labels : null;
}

// Internal intake records stay in local space storage, including malformed
// records kept for recovery. They are not part of a renderer event projection.
function displayEvents(events) {
  return events.map(event => {
    if (!Object.hasOwn(event, 'butlerSource') && !event.controlAudit) return event;
    const display = { ...event }; delete display.butlerSource;
    if (event.controlAudit) {
      const { visibleText } = require('./background-operation.cjs');
      display.name = visibleText(event.name || event.controlAudit.actor.name);
      display.text = visibleText(event.text);
      display.controlAudit = { ...event.controlAudit, actor: { ...event.controlAudit.actor, name: visibleText(event.controlAudit.actor.name) } };
      if (typeof event.uiMessage?.params?.name === 'string') display.uiMessage = { ...event.uiMessage, params: { ...event.uiMessage.params, name: visibleText(event.uiMessage.params.name) } };
      const labels = auditLabels(event);
      if (labels) display.uiMessage = { ...display.uiMessage, labels };
    }
    return display;
  });
}

// One desktop-profile writer, independent of retained provider services.
// This is human-readable local context, never a provider memory injection.
class RoomState {
  constructor(directory) {
    this.file = path.join(directory, 'room-state.json');
    this.spacesFile = path.join(directory, 'collaboration-spaces.json');
    this.value = initialShared();
    this.spaces = { version: 1, rooms: [] };
    this.spacesWarning = '';
    this.warning = '';
    this.queue = Promise.resolve();
    this.gates = new Set();
    this.mergePreviews = new Map();
    this.queueWaits = new Map();
    this.mergeJobs = new Map();
    this.readRoom();
    this.readSpaces();
  }
  readRoom() {
    try {
      const stat = fs.lstatSync(this.file);
      if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077)) throw Error('Unsafe file');
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      // A damaged display preference must never block native input or sharing.
      this.value = { ...initialShared(), ...validateRoom(data) };
    } catch (error) { if (error.code !== 'ENOENT') setWarning(this, 'warning', 'error.warning.roomRead'); }
  }
  readSpaces() {
    try {
      const stat = fs.lstatSync(this.spacesFile);
      if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077)) throw Error('Unsafe file');
      const data = JSON.parse(fs.readFileSync(this.spacesFile, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.rooms) || data.rooms.some(r => !r || !roomId(r.id) || r.id === DEFAULT_ROOM_ID) || new Set(data.rooms.map(r => r.id)).size !== data.rooms.length) throw Error('Invalid spaces');
      this.spaces = { version: 1, rooms: data.rooms.map(r => ({ ...validateRoom(r), id: r.id })) };
    } catch (error) { if (error.code !== 'ENOENT') setWarning(this, 'spacesWarning', 'error.warning.otherRoomDataRead'); }
  }
  // In the same copy, since others hold it (a retried start). A file the person put in place before the retry counts,
  // whatever was read before. A missing one changes nothing: it is written with the next change.
  readAgain() {
    this.warning = this.spacesWarning = '';
    delete this.warningUiMessage; delete this.spacesWarningUiMessage;
    this.readRoom(); this.readSpaces();
  }
  metadata(id = DEFAULT_ROOM_ID) {
    if (!roomId(id)) throw uiError("error.main.invalidSpace");
    if (id === DEFAULT_ROOM_ID) return this.value;
    if (this.spacesWarning) throw Object.assign(Error(this.spacesWarning), { uiMessage: this.spacesWarningUiMessage });
    const value = this.spaces.rooms.find(r => r.id === id);
    if (!value) throw uiError("error.room.missing");
    return value;
  }
  write(file, next) {
    const temp = `${file}.${randomUUID()}.tmp`; let fd;
    try {
      fd = fs.openSync(temp, 'wx', 0o600); fs.writeFileSync(fd, JSON.stringify(next)); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(temp, file);
    } catch { throw uiError("error.room.saveFailed"); }
    finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temp); } catch {} }
  }
  commit(next, id = DEFAULT_ROOM_ID) {
    this.metadata(id);
    if (id === DEFAULT_ROOM_ID) {
      if (this.warning) throw Object.assign(Error(this.warning), { uiMessage: this.warningUiMessage });
      this.write(this.file, next); this.value = next;
    } else {
      const spaces = { ...this.spaces, rooms: this.spaces.rooms.map(r => r.id === id ? next : r) };
      this.write(this.spacesFile, spaces); this.spaces = spaces;
    }
  }
  directoryTrustIsolation() {
    return this.value.directoryTrustIsolation === undefined ? undefined : structuredClone(this.value.directoryTrustIsolation);
  }
  saveDirectoryTrustIsolation(next) {
    if (!next || typeof next !== 'object' || Array.isArray(next)) throw Error('Invalid directory trust isolation');
    const copy = structuredClone(next);
    if (!isDeepStrictEqual(copy, JSON.parse(JSON.stringify(copy)))) throw Error('Invalid directory trust isolation');
    // Internal safety state is independent of cleared history and does not
    // change the person's metadata revision or appear in renderer projections.
    this.commit({ ...this.value, directoryTrustIsolation: copy });
  }
  create(name) {
    if (this.spacesWarning) throw Object.assign(Error(this.spacesWarning), { uiMessage: this.spacesWarningUiMessage });
    const validated = validateName(name);
    this.assertSpaceNameAvailable(validated);
    const value = { ...initialRoom(validated), id: randomUUID() };
    const spaces = { ...this.spaces, rooms: [...this.spaces.rooms, value] };
    this.write(this.spacesFile, spaces); this.spaces = spaces;
    return value.id;
  }
  assertSpaceNameAvailable(name, excludedIds = []) {
    if (!excludedIds.includes(DEFAULT_ROOM_ID) && this.value.name === name) throw uiError("error.room.nameTaken", { name });
    if (this.spaces.rooms.some(room => !excludedIds.includes(room.id) && room.name === name)) throw uiError("error.room.nameTaken", { name });
  }
  serial(action) {
    const operation = this.queue.then(action);
    this.queue = operation.catch(() => {}); return operation;
  }
  writable(id) {
    if (this.gates.has(roomGate(id))) throw uiError("error.room.updatingDraftRetained");
  }
  mergeRecord(operationId) {
    return this.spaces.rooms.find(value => value.merge?.batch.operationId === operationId);
  }
  setMerge(id, fields) {
    const value = this.metadata(id), merge = { ...value.merge, ...fields };
    validateMerge(merge, id); this.update({ merge }, undefined, id); return this.metadata(id).merge;
  }
  mergeSources(snapshot, ids) {
    if (snapshot.storageWarning || this.warning || this.spacesWarning) throw Object.assign(Error(snapshot.storageWarning || this.warning || this.spacesWarning), { uiMessage: snapshot.storageWarning ? snapshot.storageWarningUiMessage : this.warning ? this.warningUiMessage : this.spacesWarningUiMessage });
    const state = this.apply(snapshot);
    return ids.map(id => {
      const value = state.rooms.find(room => room.id === id);
      if (!value) throw uiError("error.room.mergeSourceChanged");
      return captureSource({ ...value, events: contentEvents(value.events) }, state.sessions, state.nativeImageCacheRoots || (state.nativeImageCacheRoot ? [state.nativeImageCacheRoot] : []));
    });
  }
  async mergePreview(client, spec) {
    if (!spec || !Array.isArray(spec.sourceIds) || spec.sourceIds.length < 2 ||
        spec.sourceIds.some(id => !roomId(id)) || new Set(spec.sourceIds).size !== spec.sourceIds.length) throw uiError("error.room.selectDistinctMergeSources");
    if (this.mergePreviews.size >= 64) throw uiError("error.room.mergePreviewLimit");
    for (const id of spec.sourceIds) this.assertAvailable(null, true, id);
    const snapshot = await client.call('initial');
    if (!snapshot.capabilities?.includes('spaceMergeV1')) throw uiError("error.room.mergeSnapshotUnsupported");
    if (Array.isArray(spec.memberIds) && spec.memberIds.some(id => {
      const session = snapshot.sessions.find(session => session.id === id);
      return Array.isArray(session?.serviceCapabilities) && !session.serviceCapabilities.includes('collaborationSpacesV1');
    })) throw uiError("error.room.mergeMembersSpacesUnsupported");
    const sources = this.mergeSources(snapshot, spec.sourceIds);
    const batch = prepareBatch(sources, { ...spec, operationId: randomUUID(), targetId: randomUUID() });
    this.assertMergeImageSupport(snapshot, batch);
    this.mergePreviews.set(batch.operationId, { batch, sources });
    return structuredClone(batch);
  }
  assertMergeImageSupport(snapshot, batch) {
    if (!snapshot.nativeImageCacheRoot && batch.blocks.some(block => block.entries.some(entry =>
      Array.isArray(entry.payload.images) && entry.payload.images.some(ref => ref?.kind === 'native-pixels' && !ref.unavailable)))) throw uiError('error.room.mergeSnapshotUnsupported');
  }
  discardMergePreview(operationId) { this.mergePreviews.delete(operationId); }
  mergeJob(operationId, binding, kind, action) {
    const existing = this.mergeJobs.get(operationId);
    if (existing) return existing.binding === binding && existing.kind === kind ? existing.promise : Promise.reject(uiError("error.room.mergeStepBusy"));
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
    if (snapshot.storageWarning || marker.binding !== batch.binding) throw uiError("error.room.mergeTargetSaveUnverifiable");
    const captured = this.mergeSources(snapshot, [batch.targetId])[0];
    const rows = room.messages.filter(row => row.snapshotBatch === batch.operationId);
    const expected = batch.blocks.flatMap(block => block.entries);
    if (rows.length !== expected.length || expected.some(entry => !rows.some(row =>
      row.snapshotHash === entry.hash && row.snapshotOrigin?.roomId === entry.origin.roomId && row.snapshotOrigin?.messageId === entry.origin.messageId)) ||
      captured.rows.filter(row => rows.some(raw => raw.id === row.sourceMessageId)).some(row => !row.complete)) throw uiError("error.room.mergeSnapshotIncomplete");
    return true;
  }
  async performMerge(client, operationId, binding, recover) {
    let targetId;
    const prepared = await this.serial(async () => {
      const previous = this.mergeRecord(operationId), preview = this.mergePreviews.get(operationId);
      const batch = previous?.merge.batch || preview?.batch;
      if (!batch || batch.binding !== binding) throw uiError("error.room.mergePreviewExpired");
      sameOperation(batch, batch);
      if (previous && (!recover || previous.merge.undoStarted || ['ready', 'undone'].includes(previous.merge.stage))) return { existing: true, value: structuredClone(previous.merge) };
      if (batch.conflicts.length) throw uiError("error.room.mergeIdentityConflict");
      targetId = batch.targetId; this.gates.add(roomGate(targetId));
      try {
        let snapshot = await client.call('initial');
        if (!snapshot.capabilities?.includes('spaceMergeV1')) throw uiError("error.room.mergeCapabilityChanged");
        if (!previous) this.assertMergeImageSupport(snapshot, batch);
        if (!previous) {
          const cuts = this.mergeSources(snapshot, batch.sources.map(source => source.id));
          assertCurrentSources(batch, cuts);
          if (this.spaces.rooms.some(room => room.id === targetId)) throw uiError("error.room.mergeTargetExists");
          // A keep merge leaves its sources active, so their names stay taken. Only
          // an archive merge frees source names for the target to reuse.
          this.assertSpaceNameAvailable(batch.name, batch.disposition === 'archive' ? batch.sources.map(source => source.id) : []);
          for (const id of batch.memberIds) {
            const session = snapshot.sessions.find(s => s.id === id);
            if (!session || roomIds(session).length > 1) throw uiError('error.movePlacementAmbiguous');
            if (!(session.serviceCapabilities || snapshot.capabilities || []).includes('singleHomeMoveV1')) throw uiError('error.movePlacementUnsupported');
          }
          const value = { ...initialRoom(batch.name), id: targetId,
            files: batch.blocks.flatMap(block => block.files.map(file => ({ ...file, id: randomUUID(), snapshotBatch: operationId, origin: { roomId: block.roomId, fileId: file.id } }))), merge: {
            batch: structuredClone(batch), stage: 'preparing', imported: false, joins: [], failures: [], failuresUiMessage: null,
            memberProofs: batch.memberIds.map(id => { const session = snapshot.sessions.find(s => s.id === id); return {
              id, nativeId: session?.nativeId, placementRevision: placementRevision(session),
              connectionRevision: session.connectionRevision || 0, operationId: randomUUID() }; }),
            sources: cuts.map(source => ({ id: source.id, status: 'pending', revision: source.metadataRevision,
              members: source.members.map(member => ({ id: member.id, nativeId: member.nativeId })) })) } };
          validateMerge(value.merge, targetId);
          const next = { ...this.spaces, rooms: [...this.spaces.rooms, value] };
          this.write(this.spacesFile, next); this.spaces = next;
        }
        let current = this.metadata(targetId).merge;
        if (current.imported && !this.verifyMergeImport(snapshot, batch)) throw uiError("error.room.previousMergeSnapshotUnverifiable");
        if (!current.imported) {
          assertCurrentSources(batch, this.mergeSources(snapshot, batch.sources.map(source => source.id)));
          if (!this.verifyMergeImport(snapshot, batch)) {
            const receipt = await client.call('mergeSnapshot', structuredClone(batch));
            if (!receipt || receipt.operationId !== operationId || receipt.binding !== binding || receipt.persisted !== true) throw uiError("error.room.mergeSaveUnconfirmed");
            snapshot = await client.call('initial');
            if (!this.verifyMergeImport(snapshot, batch)) throw uiError("error.room.savedMergeSnapshotUnverifiable");
          }
          assertCurrentSources(batch, this.mergeSources(snapshot, batch.sources.map(source => source.id)));
          this.setMerge(targetId, { imported: true, stage: 'joining' });
        }
        for (const id of batch.memberIds) {
          snapshot = await client.call('initial');
          const session = snapshot.sessions.find(session => session.id === id);
          if (!session || session.nativeId !== this.metadata(targetId).merge.memberProofs.find(proof => proof.id === id)?.nativeId) throw uiError("error.room.mergeTargetIdentityChanged");
          const savedProof = this.metadata(targetId).merge.memberProofs.find(proof => proof.id === id);
          if (savedProof.placementRevision === undefined || !savedProof.operationId) throw uiError('error.movePlacementUnsupported');
          const result = await this.changeMember(client, id, true, session.name, targetId,
            { nativeId: savedProof.nativeId, placementRevision: savedProof.placementRevision,
              connectionRevision: savedProof.connectionRevision, operationId: savedProof.operationId });
          const after = (await client.call('initial')).sessions.find(session => session.id === id);
          if (!after || !isMember(after, targetId)) throw uiError("error.room.mergeMembersUnconfirmed");
          const joins = this.metadata(targetId).merge.joins.filter(join => join.id !== id);
          joins.push({ id, nativeId: after.nativeId, revision: membershipRevision(after, targetId), changed: result.changed,
            placementRevision: result.placementRevision, previousRoomId: result.previousRoomId, connectionRevision: result.connectionRevision });
          const sources = this.metadata(targetId).merge.sources.map(source => {
            const event = result.metadataChanges?.find(change => change.roomId === source.id);
            return event && source.revision === event.beforeRevision ? { ...source, revision: event.revision } : source;
          });
          this.setMerge(targetId, { joins, sources });
        }
        const value = this.metadata(targetId);
        this.setMerge(targetId, { stage: batch.disposition === 'archive' ? 'archiving' : 'ready', failures: [], failuresUiMessage: null,
          baseline: value.merge.baseline || mergeSignature(value) });
        return { existing: false, batch };
      } catch (error) {
        if (this.mergeRecord(operationId)) {
          try { this.setMerge(targetId, { stage: 'failed', failures: [error.message], failuresUiMessage: error.uiMessage || null }); } catch { /* Keep the last durable step and original data. */ }
        }
        throw error;
      }
    }).catch(error => { if (targetId) this.gates.delete(roomGate(targetId)); throw error; });
    if (prepared.existing) return prepared.value;
    // archiveRoom enqueues on the same queue: never await it from inside serial.
    try {
      if (prepared.batch.disposition === 'archive') for (const original of this.metadata(targetId).merge.sources) {
        if (original.status === 'done') continue;
        let status = 'done', error = '', errorUiMessage = null;
        try {
          if (this.metadata(original.id).revision !== original.revision) throw uiError("error.room.mergeSourceDataChanged");
          const snapshot = await client.call('initial');
          const members = snapshot.sessions.filter(session => isMember(session, original.id));
          if (members.some(session => !original.members.some(member => member.id === session.id && member.nativeId === session.nativeId))) throw uiError("error.room.mergeSourceIdentityChanged");
          await this.serial(() => {
            const value = this.metadata(targetId).merge;
            this.setMerge(targetId, { sources: value.sources.map(source => source.id === original.id ? { ...source, touched: true } : source) });
          });
          await this.archiveRoom(client, undefined, original.id);
        } catch (failure) { status = 'failed'; error = failure.message; errorUiMessage = failure.uiMessage || null; }
        await this.serial(() => {
          const value = this.metadata(targetId).merge;
          const sources = value.sources.map(source => source.id === original.id ? { ...source, status, error, errorUiMessage, revision: this.metadata(source.id).revision } : source);
          this.setMerge(targetId, { sources });
        });
      }
      await this.serial(() => {
        const value = this.metadata(targetId).merge, failures = value.sources.filter(source => source.status === 'failed').map(source => source.error);
        const failureDisplay = uiError('error.warningLines', { warnings: failures.join('\n') }, { parts: value.sources.filter(source => source.status === 'failed').map(source => ({ message: source.error, uiMessage: source.errorUiMessage })), param: 'warnings', separator: '\n' });
        this.setMerge(targetId, { stage: failures.length ? 'partial' : 'ready', failures, failuresUiMessage: failureDisplay.uiMessage || null });
      });
      this.mergePreviews.delete(operationId);
      return structuredClone(this.metadata(targetId).merge);
    } finally { this.gates.delete(roomGate(targetId)); }
  }
  async mergeStatus(client, operationId) {
    const value = this.mergeRecord(operationId);
    if (!value) throw uiError("error.room.mergeRecordMissing");
    const snapshot = await client.call('initial');
    let observedSaved = false, warning = '', warningUiMessage = null;
    try { observedSaved = this.verifyMergeImport(snapshot, value.merge.batch); } catch (error) { warning = error.message; warningUiMessage = error.uiMessage || null; }
    return { ...structuredClone(value.merge), observedSaved, warning, warningUiMessage };
  }
  mergeUndo(client, operationId, binding, keepTarget = false) {
    return this.mergeJob(operationId, binding, 'undo', async () => {
      const value = this.mergeRecord(operationId);
      if (!value || value.merge.batch.binding !== binding) throw uiError("error.room.mergeRecordUnverifiable");
      if (value.merge.stage === 'undone') return structuredClone(value.merge);
      const targetId = value.id, gate = roomGate(targetId);
      if (this.gates.has(gate)) throw uiError("error.room.workspaceUpdating");
      this.gates.add(gate);
      try {
        const snapshot = await client.call('initial');
        if (snapshot.storageWarning) throw Object.assign(Error(snapshot.storageWarning), { uiMessage: snapshot.storageWarningUiMessage });
        const current = this.metadata(targetId), record = current.merge;
        if (record.joins.some(join => join.placementRevision === undefined || join.previousRoomId === undefined)) throw uiError('error.movePlacementUnsupported');
        const room = snapshot.rooms?.find(room => room.id === targetId), members = snapshot.sessions.filter(session => isMember(session, targetId));
        const undoIds = new Set(record.joins.map(join => join.undoOperationId).filter(Boolean));
        const base = { ...current, events: current.events.filter(event => ![...undoIds].some(id => event.id === `placement:${id}:leave`)) };
        const samePlacements = members.every(session => record.joins.some(join => join.id === session.id)) && record.joins.every(join => {
          const session = snapshot.sessions.find(s => s.id === join.id);
          if (!session || session.nativeId !== join.nativeId) return false;
          const restored = join.undoOperationId && session.placementReceipt?.operationId === join.undoOperationId &&
            session.placementReceipt.roomId === join.previousRoomId && session.placementReceipt.revision === placementRevision(session);
          return restored || isMember(session, targetId) && placementRevision(session) === join.placementRevision && membershipRevision(session, targetId) === join.revision;
        });
        const noLaterData = !room?.run && !room?.messages.some(message => message.snapshotBatch !== operationId);
        const laterWork = keepTarget || !noLaterData || record.baseline !== mergeSignature(base) || !samePlacements;
        await this.serial(() => this.setMerge(targetId, { stage: 'undoing', undoStarted: true, undoTargetFailed: false,
          undoKeptTarget: laterWork, failures: [], failuresUiMessage: null,
          joins: record.joins.map(join => ({ ...join, undoOperationId: join.undoOperationId || randomUUID() })) }));
        // Restore only source-space metadata we archived, before returning people.
        // This never resurrects old shared grants or steals a later placement.
        for (const original of this.metadata(targetId).merge.sources) {
          if (!original.touched || original.status === 'restored') continue;
          let status = 'restored', error = '', errorUiMessage = null;
          try {
            if (this.metadata(original.id).revision !== original.revision) throw uiError("error.room.archivedSourceChanged");
            const state = await client.call('initial');
            if (original.members.some(member => !state.sessions.some(session => session.id === member.id && session.nativeId === member.nativeId))) throw uiError("error.room.sourceSessionIdentityChanged");
            await this.restoreRoom(client, undefined, original.id);
          } catch (failure) { status = 'changed'; error = failure.message; errorUiMessage = failure.uiMessage || null; }
          await this.serial(() => {
            const record = this.metadata(targetId).merge;
            this.setMerge(targetId, { sources: record.sources.map(source => source.id === original.id ? { ...source, status, error, errorUiMessage, revision: this.metadata(source.id).revision } : source) });
          });
        }
        const movementFailures = [];
        if (!laterWork) {
          for (const join of this.metadata(targetId).merge.joins) {
            try {
              if (join.previousRoomId && this.metadata(join.previousRoomId).archived) throw uiError('error.room.archivedSourceChanged');
              const receipt = await this.changeMember(client, join.id, Boolean(join.previousRoomId), undefined, join.previousRoomId || targetId,
                { nativeId: join.nativeId, placementRevision: join.placementRevision, connectionRevision: join.connectionRevision, operationId: join.undoOperationId });
              await this.serial(() => {
                const record = this.metadata(targetId).merge;
                this.setMerge(targetId, { joins: record.joins.map(value => value.id === join.id ? { ...value, undoReceipt: receipt } : value) });
              });
            } catch (error) { movementFailures.push(error); break; }
          }
          if (!movementFailures.length) {
            // The target is empty after exact C->original moves; no transient solo hop.
            this.gates.delete(gate);
            try { await this.archiveRoom(client, undefined, targetId); }
            catch (error) { movementFailures.push(error); }
            this.gates.add(gate);
          }
        }
        await this.serial(() => {
          const record = this.metadata(targetId).merge;
          const parts = [...record.sources.filter(source => source.status === 'changed').map(source => ({ message: source.error, uiMessage: source.errorUiMessage })),
            ...movementFailures.map(error => ({ message: error.message, uiMessage: error.uiMessage || null }))];
          const failures = parts.map(part => part.message), failureDisplay = uiError('error.warningLines', { warnings: failures.join('\n') }, { parts, param: 'warnings', separator: '\n' });
          this.setMerge(targetId, { stage: failures.length ? 'partial' : 'undone', undoTargetFailed: movementFailures.length > 0,
            failures, failuresUiMessage: failureDisplay.uiMessage || null });
        });
        return structuredClone(this.metadata(targetId).merge);
      } finally { this.gates.delete(gate); }
    });
  }

  update(fields, event, id = DEFAULT_ROOM_ID, facts = []) {
    const value = this.metadata(id);
    if (value.revision === Number.MAX_SAFE_INTEGER) throw uiError("error.room.dataVersionLimit");
    const time = Date.now(), record = event ? { id: randomUUID(), role: 'system', time, ...event } : null;
    // Facts noticed in this write are saved with it, before its own event: that event stays the
    // last one and keeps its ID, which the decision notification and its readers rely on.
    // An event or a fact is added to the stored events; fields.events applies only without them.
    const noticed = facts.map(fact => ({ id: randomUUID(), role: 'system', time, ...fact }));
    const events = record || noticed.length ? [...value.events, ...noticed, ...(record ? [record] : [])] : (fields.events || value.events);
    this.commit({ ...value, ...fields, revision: value.revision + 1, events }, id);
    // The queue change, delivery source and typed fact are durable before
    // intake can see them. A failed auxiliary consumer cannot undo this write.
    for (const fact of noticed) if (['ready', 'done'].includes(fact.monitor?.kind) && (fact.butlerSource || fact.butlerDoneSource)) {
      try { this.onButlerReady?.(id, fact.id); } catch { /* The stored source is replayable. */ }
    }
    return record?.id || null;
  }
  recordControlOperation(record, rooms = [DEFAULT_ROOM_ID]) {
    if (record.refusalSummary) return this.recordControlRefusal(record, rooms);
    const action = require('./background-operation.cjs').maintenanceAction(record.command.method, record.command.arguments, record.actor);
    if (!action) return;
    const states = { 'confirmation-required': 'waiting', complete: 'complete', cancelled: 'cancelled', unconfirmed: 'unconfirmed', running: 'running', 'not-executed': 'refused' };
    const state = states[record.state];
    if (!state || !orderId(record.actor.id) || !['claude', 'codex'].includes(record.actor.provider)) throw Error('Invalid maintenance audit');
    const id = `control:${record.actor.provider}:${record.actor.nativeId}:${record.id}`;
    const command = record.command.method + (['spaceAction', 'spaceMerge'].includes(record.command.method) ? '.' + record.command.arguments[record.command.method === 'spaceAction' ? 1 : 0] : '');
    const name = require('./background-operation.cjs').visibleText(record.actor.name);
    const event = { id, role: 'system', kind: 'control-audit', sessionId: record.actor.id, name,
      // A read the butler makes without the person's confirmation is not said to be confirmed.
      time: record.at || Date.now(), ...uiNotice('notice.background.' + (state === 'running' && record.unasked === true ? 'runningUnasked' : state), { name, command }),
      controlAudit: { operationId: record.id, actor: { id: record.actor.id, nativeId: record.actor.nativeId, name, provider: record.actor.provider },
        method: record.command.method, action, state: record.state, ...(record.resultState ? { resultState: record.resultState } : {}) } };
    const available = rooms.filter(id => id === DEFAULT_ROOM_ID || this.spaces.rooms.some(r => r.id === id));
    for (const room of new Set(available.length ? available : [DEFAULT_ROOM_ID])) {
      const value = this.metadata(room), previous = value.events.find(e => e.id === id);
      const standing = record.approvedBy === 'standing' && record.standing;
      const next = { ...event, time: previous?.time || event.time,
        ...(standing ? { ...uiNotice('notice.background.standing.' + state, { name, command: standing.actionText || record.command.method, target: standing.target || '', undo: standing.undo || '' }),
          controlAudit: { ...event.controlAudit, approvedBy: 'standing', undo: standing.undo,
            ...(standing.creation ? { creation: { model: standing.creation.model, effort: standing.creation.effort } } : {}) } } : {}) };
      const events = previous ? value.events.map(e => e.id === id ? next : e) : [...value.events, next];
      // Audit-only changes do not edit notes or invalidate a merge preview's
      // source cut. They stay in the source space rather than copied snapshots.
      this.commit({ ...value, events }, room);
    }
  }
  recordControlRefusal(record, rooms) {
    const summary = record.refusalSummary;
    const notices = { 'confirmation-limit': 'refusalLimit', 'originating-session-unavailable': 'refusalActor', 'another-operation-running': 'refusalBusy',
      'explicit-paths-required': 'refusalPaths', 'invalid-file-path-count': 'refusalPaths', 'file-preview-changed': 'refusalPreview',
      'conversation-access-denied': 'refusalAccess', 'space-file-membership-required': 'refusalAccess', 'conversation-target-unavailable': 'refusalTarget', 'model-change-unavailable': 'refusalModelChange' };
    if (record.state !== 'not-executed' || !Object.hasOwn(notices, summary.reason) || !orderId(record.actor.id) || !['claude', 'codex'].includes(record.actor.provider)) throw Error('Invalid refusal audit');
    const id = `control-refusal:${record.actor.provider}:${record.actor.nativeId}:${record.id}`;
    const name = require('./background-operation.cjs').visibleText(record.actor.name);
    const available = rooms.filter(id => roomId(id) && (id === DEFAULT_ROOM_ID || this.spaces.rooms.some(r => r.id === id)));
    if (!available.length) throw Error('The refusal audit space is unavailable');
    for (const room of new Set(available)) {
      const count = summary.rooms?.[room];
      if (!count || !Number.isSafeInteger(count.count) || count.count < 1 || !Number.isSafeInteger(count.sequence) || count.sequence < 1) throw Error('Invalid refusal count');
      const value = this.metadata(room), previous = value.events.find(e => e.id === id);
      if ((previous?.controlAudit?.refusalSummary?.sequence || 0) >= count.sequence) continue;
      const event = { id, role: 'system', kind: 'control-audit', sessionId: record.actor.id, name, time: previous?.time ?? record.at,
        ...uiNotice('notice.background.' + notices[summary.reason], { name, count: count.count, command: count.lastMethod }),
        controlAudit: { operationId: record.id, actor: { id: record.actor.id, nativeId: record.actor.nativeId, name, provider: record.actor.provider },
          method: 'backgroundRefusal', action: 'refusedRequests', state: 'not-executed',
          refusalSummary: { reason: summary.reason, count: count.count, sequence: count.sequence, lastMethod: count.lastMethod, windowStart: summary.windowStart, windowEnd: summary.windowEnd } } };
      let events = [...value.events.filter(e => e.id !== id), event];
      const retained = new Set(require('./background-operation.cjs').retainRefusalRows(events.filter(e => e.controlAudit?.refusalSummary), 128, 32).map(e => e.id));
      events = events.filter(e => !e.controlAudit?.refusalSummary || retained.has(e.id));
      // Only this bounded summary format is retained. Other space records and
      // legacy audit events are not a cleanup target.
      this.commit({ ...value, events }, room);
    }
  }
  rename(name, id = DEFAULT_ROOM_ID) {
    this.writable(id);
    const validated = validateName(name);
    if (this.metadata(id).name === validated) return;
    this.assertSpaceNameAvailable(validated, [id]);
    this.update({ name: validated }, { kind: 'rename', ...uiNotice('notice.room.renamed', { name: validated }) }, id);
  }
  // R121 (a): attach is the person's 「派活时附上这份笔记」 (queue-dispatch.cjs notesDue). While it is on only the
  // person changes the notes, so what goes out with queued work is what the person sees in this dialog.
  notes(text, revision, id = DEFAULT_ROOM_ID, { person = false, attach } = {}) {
    this.writable(id);
    if (typeof text !== 'string' || text.length > 8000 || /\u0000/.test(text)) throw uiError("error.room.notesLimit");
    if (attach !== undefined && typeof attach !== 'boolean') throw uiError("error.invalidSpaceAction");
    const value = this.metadata(id), on = value.notesToQueue === true;
    const fields = {};
    if (text !== value.notes) fields.notes = text;
    if (attach !== undefined && attach !== on) {
      // The revision that turned it on: turning it on again sends the notes once more.
      Object.assign(fields, attach ? { notesToQueue: true, notesToQueueSince: value.revision + 1 } : { notesToQueue: undefined, notesToQueueSince: undefined });
    }
    if (!person && Object.hasOwn(fields, 'notesToQueue')) throw uiError("error.room.notesAttachPersonOnly");
    if (!person && on && Object.hasOwn(fields, 'notes')) throw uiError("error.room.notesPersonOnly");
    if (revision !== value.revision) throw uiError("error.room.dataChangedElsewhere");
    const events = [];
    if (Object.hasOwn(fields, 'notesToQueue')) events.push({ kind: 'notes', ...uiNotice(attach ? 'notice.room.notesAttachOn' : 'notice.room.notesAttachOff') });
    if (Object.hasOwn(fields, 'notes')) events.push({ kind: 'notes', ...uiNotice(text ? 'notice.room.notesUpdated' : 'notice.room.notesCleared', text ? { text } : undefined) });
    if (events.length) this.update(fields, events.pop(), id, events);
  }
  addFiles(files, id = DEFAULT_ROOM_ID) {
    this.writable(id);
    const value = this.metadata(id), next = [...value.files];
    if (!Array.isArray(files)) throw uiError("error.room.invalidFileList");
    for (const file of files) {
      if (typeof file !== 'string' || !path.isAbsolute(file) || /[\u0000-\u001f]/u.test(file)) throw uiError("error.room.invalidLocalPath");
      if (!next.some(f => f.path === file)) next.push({ id: randomUUID(), path: file, name: path.basename(file) });
    }
    if (next.length !== value.files.length) this.update({ files: next }, { kind: 'files', ...uiNotice('notice.room.filesAdded') }, id);
  }
  removeFile(fileId, revision, id = DEFAULT_ROOM_ID) {
    this.writable(id);
    const value = this.metadata(id);
    if (revision !== value.revision) throw uiError("error.room.fileListChanged");
    if (value.files.some(f => f.id === fileId)) this.update({ files: value.files.filter(f => f.id !== fileId) }, { kind: 'files', ...uiNotice('notice.room.fileRemoved') }, id);
  }
  // Task queue (queue-dispatch.cjs). The person, the space's project manager or the butler adds; NAW sends.
  // These compact sources live with the durable space event. Recovery does not
  // depend on a notification callback, a retained queue item or native history.
  butlerSources() {
    if (this.warning || this.spacesWarning) throw Object.assign(Error(this.warning || this.spacesWarning), {
      uiMessage: this.warning ? this.warningUiMessage : this.spacesWarningUiMessage });
    return structuredClone([{ id: DEFAULT_ROOM_ID, events: this.value.events }, ...this.spaces.rooms].flatMap(room => room.events
      .filter(event => Object.hasOwn(event, 'butlerSource') || Object.hasOwn(event, 'butlerDoneSource') || Object.hasOwn(event, 'butlerNoReplySource'))
      .map(event => storedQueueSource(room.id, event))));
  }
  // Who the person made this space's project manager, or that they revoked it.
  noteManager(id, key, params, sessionId) {
    this.update({}, { kind: 'manager', ...(sessionId ? { sessionId } : {}), ...uiNotice(key, params) }, id);
  }
  queueItems(id) {
    const value = this.metadata(id);
    if (Array.isArray(value.queue)) {
      return value.queue;
    }
    return [];
  }
  queueFind(id, itemId) {
    for (const item of this.queueItems(id)) {
      if (item.id === itemId) {
        return item;
      }
    }
    throw uiError("error.queue.itemMissing");
  }
  queueReplace(id, itemId, next, event, reportTitle, memberName) {
    this.writable(id);
    const queue = [];
    let previous = null;
    for (const item of this.queueItems(id)) {
      if (item.id === itemId) {
        previous = item;
        queue.push(next);
      } else {
        queue.push(item);
      }
    }
    const checked = queueRules.validateQueue(queue);
    const noticed = queueFacts(this.metadata(id), id, previous, next, checked, reportTitle, memberName);
    return this.update({ queue: checked, ...noticed.fields }, event ? { ...event, itemId } : event, id, noticed.facts);
  }
  // `by` is 'steward' when the butler acts (steward step 2, batch 4): kept on the item, which older builds read as it is.
  queueAdd(text, assignee, id = DEFAULT_ROOM_ID, creator, by = null) {
    this.writable(id);
    if (this.metadata(id).archived) {
      throw uiError("error.queue.archived");
    }
    let item;
    try {
      item = queueRules.newItem(text, assignee ?? null, Date.now(), creator);
      if (by === 'steward') item = { ...item, addedBy: 'steward' };
    } catch {
      throw uiError("error.queue.invalid");
    }
    const items = this.queueItems(id);
    let open = 0;
    for (const existing of items) {
      if (['queued', 'sent', 'waiting'].includes(existing.status)) {
        open += 1;
      }
    }
    if (open >= queueRules.QUEUE_LIMIT) {
      throw uiError("error.queue.full");
    }
    const queue = queueRules.trimQueue([...items, item]);
    const params = { text: queueRules.shortText(text) };
    let notice = 'notice.queue.added';
    if (by === 'steward') { notice = 'notice.queue.addedBySteward'; params.name = item.creator.name; }
    else if (item.creator) {
      if (item.creator.kind === 'secretary') {
        notice = 'notice.queue.addedBySecretary';
        params.name = item.creator.name;
        params.sessionId = item.creator.sessionId;
      } else notice = 'notice.queue.addedByPerson';
    }
    const event = { kind: 'queue', itemId: item.id, ...uiNotice(notice, params) };
    this.update({ queue }, event, id);
    return item.id;
  }
  queueCancel(itemId, id = DEFAULT_ROOM_ID, by = null) {
    const item = this.queueFind(id, itemId);
    if (item.status !== 'queued') {
      throw uiError("error.queue.notCancellable");
    }
    const next = { ...item, status: 'cancelled', finishedAt: Date.now(), ...(by === 'steward' ? { finishedBy: 'steward' } : {}) };
    const event = { kind: 'queue', ...uiNotice(by === 'steward' ? 'notice.queue.cancelledBySteward' : 'notice.queue.cancelled', { text: queueRules.shortText(item.text) }) };
    this.queueReplace(id, itemId, next, event);
  }
  // The session that queued an item takes it back before it is sent; anyone else's, or one already sent, stays the
  // person's to cancel. The item keeps the form older builds read: the record line says who took it back.
  queueWithdraw(itemId, id = DEFAULT_ROOM_ID, author) {
    const item = this.queueFind(id, itemId);
    if (typeof author?.sessionId !== 'string' || !author.sessionId || item.creator?.kind !== 'secretary' || item.creator.sessionId !== author.sessionId) {
      throw uiError("error.queue.withdrawOwnOnly");
    }
    if (item.status !== 'queued') {
      throw uiError("error.queue.notCancellable");
    }
    const event = { kind: 'queue', ...uiNotice('notice.queue.withdrawn', { text: queueRules.shortText(item.text), name: author.name, sessionId: author.sessionId }) };
    this.queueReplace(id, itemId, { ...item, status: 'cancelled', finishedAt: Date.now() }, event);
  }
  // A member already doing an item queued for it (taken from the board, say) claims it, so that NAW does not send it
  // the same work again (queue item 6897c6e3, part 1). From now it counts as sent to that member: NAW settles it by
  // the member's reply when its turn ends, as for an item NAW sent. Nothing is sent. The tag is the input the member's
  // turn began with (`member.input`), so the reply is what follows it, as after NAW's own input; without one, a tag that
  // matches no message makes it what follows the claim's time. `control` is the member's control revision now.
  queueClaim(itemId, id = DEFAULT_ROOM_ID, member, now = Date.now()) {
    const item = this.queueFind(id, itemId);
    if (typeof member?.sessionId !== 'string' || !member.sessionId || item.assignee !== member.sessionId) {
      throw uiError("error.queue.claimOwnOnly");
    }
    if (item.status !== 'queued') {
      throw uiError("error.queue.notQueued");
    }
    // One sent item per member: the planner settles each sent item on the member's reply after its
    // anchor, so two at once would both settle on the same reply. With a room file unread, the
    // member's other items cannot all be seen, so nothing is claimed.
    if (this.warning || this.spacesWarning) throw Object.assign(Error(this.warning || this.spacesWarning), {
      uiMessage: this.warning ? this.warningUiMessage : this.spacesWarningUiMessage });
    for (const room of [{ ...this.value, id: DEFAULT_ROOM_ID }, ...this.spaces.rooms]) {
      if ((room.queue || []).some(other => other.status === 'sent' && other.sentTo === member.sessionId)) {
        throw uiError("error.queue.claimBusy");
      }
    }
    const tag = typeof member.input === 'string' && member.input.length > 0 && member.input.length <= 100 && !/[\u0000-\u001f]/u.test(member.input) ? member.input : `claimed:${item.id}`;
    const next = { ...item, status: 'sent', sentTo: member.sessionId, sentAt: now, tag, control: member.control,
      claimed: true, claimEpoch: member.claimEpoch ?? null, ...(member.nativeId ? { sentNative: member.nativeId } : {}) };
    const params = { text: queueRules.shortText(item.text), name: member.name, sessionId: member.sessionId };
    const event = { kind: 'queue', sessionId: member.sessionId, ...uiNotice('notice.queue.claimed', params) };
    this.queueReplace(id, itemId, next, event);
  }
  // Besides an item waiting for them, the person or the butler may mark handled one already sent whose work was done
  // another way (11-12: the butler could not close it, item 0bcc3c9c). NAW then does not settle it; the dispatcher
  // leaves an item it finds closed as it is (queue-dispatch.cjs, stillSent). So too one still queued for a member who
  // did it from the board: on 11-13 the butler could only cancel items 61f9c09b and 862d6abb, done and merged, and the
  // record said 「已取消」. NAW never sends an item that is no longer queued (queueMarkSent), as for a cancel. One queued
  // for nobody is cancelled instead: marked done, it would name nobody in its row (queue.status.doneBySteward).
  // answer: what the person sent from the row of an item waiting for them, recorded once native received it; only
  // their window passes it (main.cjs spaceAction).
  // recipient: the session that received the answer. A decision can go to a successor (queueCarry) while an answer
  // is on its way to the session before: the record then names that one, which did receive it.
  // tag: the message row the answer was delivered as in the session that holds the item. It stays on the item as
  // answerTag until what that session wrote after it is read (queueAnswered); an answer the session before received
  // closes the item there and keeps no row.
  queueResolve(itemId, id = DEFAULT_ROOM_ID, by = null, answer, recipient, tag) {
    const item = this.queueFind(id, itemId);
    const assigned = item.status === 'queued' && typeof item.assignee === 'string' && item.assignee.length > 0;
    if (!assigned && !['waiting', 'sent'].includes(item.status) || answer !== undefined && (by !== null || item.status !== 'waiting')) {
      throw uiError("error.queue.notWaiting");
    }
    const now = Date.now(), next = { ...item, status: 'done', finishedAt: now, ...(by === 'steward' ? { finishedBy: 'steward' } : {}) };
    if (answer !== undefined) {
      if (recipient !== undefined && recipient !== item.sentTo) {
        const before = item.carriedFrom;
        if (typeof recipient !== 'string') {
          throw uiError("error.queue.invalid");
        }
        if (!before || before.id !== recipient) {
          throw uiError("error.queue.notWaiting");
        }
        next.sentTo = before.id;
        if (before.nativeId) {
          next.sentNative = before.nativeId;
        } else {
          delete next.sentNative;
        }
        delete next.carriedFrom;
      } else if (tag !== undefined) {
        next.answerTag = tag;
      }
      next.answer = { text: answer, deliveredAt: now };
      try { queueRules.validateQueue([next]); } catch { throw uiError("error.queue.invalid"); }
    }
    const event = { kind: 'queue', ...uiNotice(by === 'steward' ? 'notice.queue.resolvedBySteward' : 'notice.queue.resolved', { text: queueRules.shortText(item.text) }) };
    this.queueReplace(id, itemId, next, event);
  }
  // The dispatcher read the session after the row an answered decision names: the reply and its READY line go on
  // the item, which stays handled, and the row's mark goes. Once an item; false when there is nothing to do.
  queueAnswered(id, itemId, tag, reply = '', ready) {
    const item = this.queueFind(id, itemId);
    if (item.status !== 'done' || !item.answerTag || item.answerTag !== tag) {
      return false;
    }
    const next = { ...item };
    delete next.answerTag;
    if (reply) {
      next.reply = reply;
    }
    // A question that carried a delivery line had it recorded when the person handled it: one delivery an item.
    if (ready && !item.ready) {
      next.ready = ready;
    }
    this.queueReplace(id, itemId, next);
    return true;
  }
  queueMarkSent(id, itemId, sessionId, name, now, afterDecision = false, nativeId = null, notesSent = null) {
    const item = this.queueFind(id, itemId);
    if (item.status !== 'queued') {
      throw uiError("error.queue.notQueued");
    }
    // The refusal that put it back is over once it is sent; attempts keeps the count (queueRequeue).
    const next = { ...item, status: 'sent', sentTo: sessionId, sentAt: now, tag: null };
    delete next.reason; delete next.claimed; delete next.claimEpoch;
    // The native session that gets it, so an answer from the queue row goes only there (search-view.js queueAnswerTarget).
    if (nativeId) {
      next.sentNative = nativeId;
    } else {
      delete next.sentNative;
    }
    // Sent while that member's decision is open (queue-dispatch.cjs, replyAfter).
    if (afterDecision) {
      next.afterDecision = true;
    } else {
      delete next.afterDecision;
    }
    // Which version of the space's notes went with it (queue-dispatch.cjs notesDue).
    if (notesSent) {
      next.notesSent = notesSent;
    } else {
      delete next.notesSent;
    }
    const params = { text: queueRules.shortText(item.text), name };
    const event = { kind: 'queue', sessionId, ...uiNotice('notice.queue.dispatched', params) };
    this.queueReplace(id, itemId, next, event);
  }
  // The backend's delivery tag and the member's control revision when NAW sent it.
  queueSetDelivery(id, itemId, tag, control) {
    const item = this.queueFind(id, itemId);
    this.queueReplace(id, itemId, { ...item, tag, control });
  }
  // Refused before anything was sent: back to the queue, a bounded number of times.
  queueRequeue(id, itemId, reason, maxAttempts, name) {
    const item = this.queueFind(id, itemId);
    if (item.status !== 'sent') {
      throw uiError("error.queue.notSent");
    }
    const attempts = (item.attempts || 0) + 1;
    if (attempts >= maxAttempts) {
      this.queueSettle(id, itemId, 'failed', `not-sent: ${reason}`, name);
      return;
    }
    const next = { ...item, status: 'queued', attempts, reason };
    delete next.sentTo;
    delete next.sentNative;
    delete next.sentAt;
    delete next.tag;
    delete next.control;
    delete next.afterDecision; delete next.claimed; delete next.claimEpoch; delete next.notesSent;
    this.queueReplace(id, itemId, next);
  }
  // reply is the member's own answer, kept so the queue row can show what came back.
  queueSettle(id, itemId, status, reason, name, reply = '', question, ready, reportTitle, session) {
    const item = this.queueFind(id, itemId);
    if (item.status !== 'sent') {
      throw uiError("error.queue.notSent");
    }
    const next = { ...item, status, finishedAt: Date.now() };
    if (reason) {
      next.reason = reason;
    }
    if (reply) {
      next.reply = reply;
    }
    if (ready) {
      next.ready = ready;
    }
    // No-reply notifies the butler without creating a question for the person.
    let event;
    const text = queueRules.shortText(item.text);
    if (status === 'waiting') {
      // Only a decision asks the person something. An item the person stepped into, or whose turn came back
      // empty, is left for them to look at while its member goes on (follow-up 4, 11-12).
      event = { kind: 'queue', sessionId: item.sentTo, ...uiNotice(reason ? 'notice.queue.lookAt' : 'notice.queue.waiting', { text, name }) };
    } else if (status === 'failed') {
      const params = { text, name, reason: reason || '' };
      event = { kind: 'queue', sessionId: item.sentTo, ...uiNotice('notice.queue.failed', params) };
    }
    const needsPerson = status === 'failed' || status === 'waiting' && !reason;
    const noReply = status === 'waiting' && reason === 'no-reply';
    const decisionQuestion = question ?? queueRules.shortText(item.text);
    if (event && noReply) {
      event.id = randomUUID();
      event.queueSettlement = noReplyFact(id, event.id, item, session);
      event.butlerNoReplySource = noReplyContext(event.queueSettlement);
    }
    if (event && needsPerson) {
      // The event and its B4 source must share this exact persisted identity.
      // update() retains an explicitly supplied ID when it constructs the row.
      event.id = randomUUID();
      const source = queueOutcomeSource({ roomId: id, itemId, eventId: event.id, status, reason,
        memberId: item.sentTo, memberName: name, task: item.text, question: decisionQuestion });
      if (source) event.butlerSource = source;
    }
    const eventId = this.queueReplace(id, itemId, next, event, reportTitle, name);
    if (eventId && noReply) {
      try { this.onButlerReady?.(id, eventId); } catch { /* Recovery reads the persisted outcome. */ }
    }
    if (eventId && needsPerson) {
      try {
        this.onQueueOutcome?.({ roomId: id, itemId, eventId, status, reason, memberId: item.sentTo,
          memberName: name, task: queueRules.shortText(item.text, 40), reply,
          question: decisionQuestion });
      } catch { /* Notification failure cannot undo the persisted space record. */ }
    }
  }
  // The open decisions of a session that handed over to a successor now point at the successor: the row answers
  // it, and what the person writes there is that decision's answer. askedBy keeps who first asked; carriedFrom the
  // session just before, where an answer already sent may still arrive (queueResolve). Nothing is announced: the
  // rotation's own line says who took over. A second call with the same sessions changes nothing.
  queueCarry(id, fromId, toId, toNative = null) {
    this.writable(id);
    const queue = [];
    let changed = false;
    for (const item of this.queueItems(id)) {
      if (item.sentTo !== fromId || !queueRules.openDecision(item)) {
        queue.push(item);
        continue;
      }
      const from = { id: fromId, ...(item.sentNative ? { nativeId: item.sentNative } : {}) };
      const next = { ...item, sentTo: toId, askedBy: item.askedBy || from, carriedFrom: from };
      if (toNative) {
        next.sentNative = toNative;
      } else {
        delete next.sentNative;
      }
      changed = true;
      queue.push(next);
    }
    if (changed) {
      this.update({ queue: queueRules.validateQueue(queue) }, undefined, id);
    }
  }
  queueReassign(id, fromId, toId) {
    this.writable(id);
    const queue = [];
    let changed = false;
    for (const item of this.queueItems(id)) {
      if (item.status === 'queued' && item.assignee === fromId) {
        changed = true;
        queue.push({ ...item, assignee: toId });
      } else {
        queue.push(item);
      }
    }
    if (changed) {
      this.update({ queue }, undefined, id);
    }
  }
  // detailMessage: the notice that detail is written from (a failure's reason), so each reader sees it in their language.
  rotationEvent(ids, phase, oldName, detail, receiptId, detailMessage, rotationReason) {
    if (rotationReason !== undefined && (!rotationReason || Object.keys(rotationReason).sort().join() !== 'reason,sessionId' ||
        !orderId(rotationReason.sessionId) || typeof rotationReason.reason !== 'string' || !/^[A-Za-z0-9:._-]{1,160}$/.test(rotationReason.reason))) throw Error('Invalid rotation reason');
    if (receiptId !== undefined && (typeof receiptId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(receiptId))) throw Error('Invalid rotation receipt');
    const keys = { requested: 'notice.rotation.requested', waiting: 'notice.rotation.waiting', done: 'notice.rotation.done', archived: 'notice.rotation.archived', oldKept: 'notice.rotation.oldKept', failed: 'notice.rotation.failed', deferred: 'notice.rotation.deferred', withdrawn: 'notice.rotation.withdrawn', needsTrust: 'notice.rotation.needsTrust', trustTimedOut: 'notice.rotation.trustTimedOut', trustTimeoutUnconfirmed: 'notice.rotation.trustTimeoutUnconfirmed', trustCleanupUnconfirmed: 'notice.rotation.trustCleanupUnconfirmed', trustStateInvalid: 'notice.rotation.trustStateInvalid', trustStateUnknown: 'notice.rotation.trustStateUnknown' };
    let recorded = 0;
    for (const id of ids) {
      try {
        this.metadata(id);
        this.writable(id);
      } catch {
        continue;
      }
      if (receiptId && this.metadata(id).events.some(event => event.kind === 'rotation' && event.rotationReceipt === receiptId)) { recorded++; continue; }
      const params = phase === 'trustStateUnknown' ? {} : ['deferred', 'withdrawn'].includes(phase) ? { name: oldName } : { name: oldName, detail: detail || '' };
      const notice = uiNotice(keys[phase], params);
      const cause = detailMessage && displayMessage(detailMessage, 'notice.', params.detail);
      if (cause) notice.uiMessage = displayMessage({ ...notice.uiMessage, cause, causeParam: 'detail' }, 'notice.', notice.text) || notice.uiMessage;
      const event = { kind: 'rotation', ...(receiptId ? { rotationReceipt: receiptId } : {}),
        ...(rotationReason ? { rotationReason: { ...rotationReason } } : {}), ...notice };
      this.update({}, event, id); recorded++;
    }
    return recorded;
  }
  // B6 E4. The backend marks a session stuck (workspace.cjs stuckFor): an interrupt that has
  // not taken effect, or a permission prompt nobody answered. Each mark is recorded once in
  // every space the session is a member of, and once more when it is gone. Records only: the
  // session is not stopped, approved, messaged or notified about. Returns whether it wrote.
  // A session that was deleted while marked keeps its mark open; nothing is written for it.
  stuckOpen() {
    const open = new Map();
    for (const room of [{ ...this.value, id: DEFAULT_ROOM_ID }, ...this.spaces.rooms]) {
      for (const event of room.events) {
        const fact = event.monitor;
        if (!fact || typeof fact.key !== 'string') continue;
        if (fact.kind === 'stuck') {
          const entry = open.get(fact.key) || { sessionId: fact.sessionId, cause: fact.cause, since: fact.since, rooms: new Set() };
          entry.rooms.add(room.id); open.set(fact.key, entry);
        } else if (fact.kind === 'stuck-ended') {
          const entry = open.get(fact.key);
          if (entry) { entry.rooms.delete(room.id); if (!entry.rooms.size) open.delete(fact.key); }
        }
      }
    }
    return open;
  }
  recordStuck(sessions, name = session => session.name, now = Date.now()) {
    if (!Array.isArray(sessions) || this.warning || this.spacesWarning) return false;
    const current = new Map();
    for (const session of sessions) {
      if (!session || !orderId(session.id) || !Array.isArray(session.stuck)) continue;
      for (const mark of session.stuck) {
        if (mark && ['interrupt', 'approval'].includes(mark.kind) && Number.isSafeInteger(mark.since) && mark.since > 0 &&
            mark.key === `stuck:${session.id}:${mark.kind}:${mark.since}`) current.set(mark.key, { session, mark });
      }
    }
    // Rebuilt from the saved records once, so a restart of the desktop repeats nothing.
    this.stuckRecorded ||= this.stuckOpen();
    if (!current.size && !this.stuckRecorded.size) return false;
    const minutes = since => Math.max(1, Math.round((now - since) / 60000));
    // true: written. null: no such space any more, or it is archived. false: busy now, try again later.
    const write = (room, event) => {
      try { if (this.metadata(room).archived) return null; } catch { return null; }
      try { this.writable(room); this.update({}, event, room); return true; } catch { return false; }
    };
    let wrote = false;
    for (const [key, { session, mark }] of current) {
      const entry = this.stuckRecorded.get(key) || { sessionId: session.id, cause: mark.kind, since: mark.since, rooms: new Set(), left: new Set() };
      let member = [];
      try { member = roomIds(session); } catch { /* Unreadable membership: nowhere to record. */ }
      // Spaces that were busy at the last state are tried again; archived or missing ones are left.
      const todo = member.filter(room => !entry.rooms.has(room) && !entry.left?.has(room));
      if (!todo.length) continue;
      const who = { name: name(session) || session.id }, held = mark.kind === 'interrupt' && mark.held && typeof mark.held === 'object' ? mark.held : null;
      const count = Number.isSafeInteger(held?.params?.count) && held.params.count > 0 ? held.params.count : 1;
      let notice;
      if (mark.kind === 'approval') {
        notice = session.approvalOverflow === true ? uiNotice('notice.monitor.approvalOverflow', who) : uiNotice('notice.monitor.approvalWaiting', { ...who, minutes: minutes(mark.since) });
      } else if (held?.key === 'notice.activity.interruptWaitsForSubagent' && typeof held.params?.name === 'string') {
        // The sub-agent's name goes into a record other members can read: one bounded line of it.
        notice = uiNotice('notice.monitor.interruptHeldSubagent', { ...who, minutes: minutes(mark.since), agent: queueRules.shortText(held.params.name, 80), count });
      } else if (held?.key === 'notice.activity.interruptWaitsForBackground') {
        notice = uiNotice('notice.monitor.interruptHeldBackground', { ...who, minutes: minutes(mark.since), count });
      } else notice = uiNotice('notice.monitor.interruptHeld', { ...who, minutes: minutes(mark.since) });
      for (const room of todo) {
        const result = write(room, { kind: 'monitor', sessionId: session.id, ...notice,
          monitor: { kind: 'stuck', key, cause: mark.kind, sessionId: session.id, since: mark.since } });
        if (result) { entry.rooms.add(room); wrote = true; } else if (result === null) (entry.left ||= new Set()).add(room);
      }
      if (entry.rooms.size) this.stuckRecorded.set(key, entry);
    }
    const present = new Map(sessions.filter(session => session && orderId(session.id)).map(session => [session.id, session]));
    for (const [key, entry] of this.stuckRecorded) {
      const session = present.get(entry.sessionId);
      // A session missing from this state may only be on a backend that is not connected now.
      if (current.has(key) || !session) continue;
      const notice = uiNotice(entry.cause === 'approval' ? 'notice.monitor.approvalEnded' : 'notice.monitor.interruptEnded',
        { name: name(session) || session.id, minutes: minutes(entry.since) });
      for (const room of [...entry.rooms]) {
        const result = write(room, { kind: 'monitor', sessionId: entry.sessionId, ...notice,
          monitor: { kind: 'stuck-ended', key, cause: entry.cause, sessionId: entry.sessionId, since: entry.since, ended: now } });
        if (result !== false) entry.rooms.delete(room);
        if (result) wrote = true;
      }
      if (!entry.rooms.size) this.stuckRecorded.delete(key);
    }
    return wrote;
  }
  // B5: a session opened under the person's grant that names this space (operator-control.cjs placements). One
  // record per session, keyed, so several windows, later states and a restart repeat nothing: that it joined, or
  // that it could not. Records only; no queue item is added here, and the opener's task is not delivered.
  recordOpened(room, opened) {
    const value = this.metadata(room);
    const key = `opened:${opened.sessionId}`, existing = value.events.find(event => event.monitor?.kind === 'opened' && event.monitor.key === key);
    if (existing) return { recorded: false, joined: existing.monitor.joined === true };
    this.writable(room);
    const joined = opened.joined === true;
    this.update({}, { kind: 'monitor', sessionId: opened.sessionId, ...uiNotice(joined ? 'notice.monitor.opened' : 'notice.monitor.openedNotPlaced', { name: opened.name, initiator: opened.initiator }),
      monitor: { kind: 'opened', key, sessionId: opened.sessionId, initiatorId: opened.initiatorId, joined } }, room);
    return { recorded: true, joined };
  }
  // B6 E2b: where a delivery stands with the integrator (handed out, merged, returned, on hold,
  // waiting for the person), written into the space that delivered it. One record per state:
  // the same delivery and label again writes nothing, so a repeat after a crash is harmless.
  // A space that no longer exists has nothing to write to; a space that is being updated is
  // refused for now (the caller tries again).
  recordHandoff(fact) {
    const words = spaceWords(fact);
    if (!words || typeof fact.key !== 'string' || typeof fact.label !== 'string' || !fact.key || !fact.label) return { recorded: false, why: 'no-words' };
    let value;
    try { value = this.metadata(fact.roomId); }
    catch (error) { if (error?.uiMessage?.key === 'error.room.missing' || error?.uiMessage?.key === 'error.main.invalidSpace') return { recorded: false, why: 'space-missing' }; throw error; }
    const key = `handoff:${fact.key}:${fact.label}`;
    if (value.events.some(event => event.monitor?.kind === 'handoff' && event.monitor.key === key)) return { recorded: false, why: 'known' };
    this.writable(fact.roomId);
    this.update({}, { kind: 'monitor', ...(typeof fact.memberId === 'string' && fact.memberId ? { sessionId: fact.memberId } : {}), ...uiNotice(words.key, words.params),
      monitor: { kind: 'handoff', key, itemId: fact.itemId, outcome: fact.outcome, branch: fact.branch, commit: fact.commit,
        ...(fact.handoffId ? { handoffId: fact.handoffId } : {}), ...(fact.reason ? { reason: fact.reason } : {}), ...(fact.as ? { as: fact.as } : {}) } }, fact.roomId);
    return { recorded: true };
  }
  // B6: a member that holds an open integration handoff gets no work from this space's queue
  // until the handoff is closed. Said once in the space, per handoff and per state of it (still
  // open, or waiting for the person), and once more when that handoff is over (closed), if the
  // space had been told about it. A repeat, a missing space and a space that is being updated
  // are treated as in recordHandoff; an archived space is told nothing.
  recordHandoffHolder(fact) {
    if (!fact || typeof fact.sessionId !== 'string' || !fact.sessionId || typeof fact.handoffId !== 'string' || !fact.handoffId) return { recorded: false, why: 'no-words' };
    const state = fact.closed === true ? 'closed' : fact.waiting === true ? 'waiting' : 'sent';
    let value;
    try { value = this.metadata(fact.roomId); }
    catch (error) { if (error?.uiMessage?.key === 'error.room.missing' || error?.uiMessage?.key === 'error.main.invalidSpace') return { recorded: false, why: 'space-missing' }; throw error; }
    // An archived space has no queue at work: there is nothing to say.
    if (value.archived) return { recorded: false, why: 'space-archived' };
    const key = `handoff-holder:${fact.handoffId}:${fact.sessionId}:${state}`;
    if (value.events.some(event => event.monitor?.kind === 'handoff-holder' && event.monitor.key === key)) return { recorded: false, why: 'known' };
    // The end is said only where the handoff was said to be open.
    const open = `handoff-holder:${fact.handoffId}:${fact.sessionId}:`;
    if (state === 'closed' && !value.events.some(event => event.monitor?.kind === 'handoff-holder' && [open + 'sent', open + 'waiting'].includes(event.monitor.key))) return { recorded: false, why: 'nothing-open' };
    this.writable(fact.roomId);
    const name = typeof fact.name === 'string' && fact.name.trim() ? fact.name.trim().slice(0, 60) : fact.sessionId;
    this.update({}, { kind: 'monitor', sessionId: fact.sessionId, ...uiNotice(`notice.handoff.holder.${state}`, { name }),
      monitor: { kind: 'handoff-holder', key, handoffId: fact.handoffId, state } }, fact.roomId);
    return { recorded: true };
  }
  // B5: said once in a space, where the person can see it: after NAW replaced a session, the person's grant
  // went with the replacing session, or stayed behind and has to be given again. One entry per outcome; the
  // outcome is final in the journal that owns the grant, so the entry never has to be taken back.
  recordCarried(room, carried) {
    const value = this.metadata(room);
    const key = `carried:${carried.oldId}:${carried.at}`;
    if (value.events.some(event => event.monitor?.kind === 'carried' && event.monitor.key === key)) return { recorded: false };
    this.writable(room);
    const done = carried.carried === true, grants = done && Number.isSafeInteger(carried.inForce) && carried.inForce > 0 ? carried.inForce : 0;
    // With no grant in force among those that went with it, the entry says that only the interface permission
    // went on: a revoked or expired grant is carried as it is and must not read as a usable one.
    this.update({}, { kind: 'monitor', sessionId: done ? carried.newId : carried.oldId,
      ...uiNotice(!done ? 'notice.monitor.grantNotCarried' : grants ? 'notice.monitor.grantCarried' : 'notice.monitor.interfaceCarried', done ? { old: carried.old, new: carried.new } : { old: carried.old }),
      monitor: { kind: 'carried', key, oldId: carried.oldId, ...(carried.newId ? { newId: carried.newId } : {}), carried: done, ...(done ? { grants } : { reason: carried.reason }) } }, room);
    return { recorded: true };
  }
  // The spaces that were told a member's handoff is open and not yet that it is over, as their
  // records say it: [{ roomId, sessionId, handoffId, name }]. Read once after a start, so that
  // a handoff that ended while the app was down still gets its closing line.
  handoffHolderLines() {
    const lines = [];
    for (const room of [{ ...this.value, id: DEFAULT_ROOM_ID }, ...this.spaces.rooms]) {
      if (room.archived) continue;
      const seen = new Map();
      for (const event of room.events) {
        const fact = event.monitor;
        if (fact?.kind !== 'handoff-holder' || typeof fact.handoffId !== 'string' || typeof event.sessionId !== 'string') continue;
        const id = `${fact.handoffId}\n${event.sessionId}`;
        if (fact.state === 'closed') seen.set(id, null);
        else if (seen.get(id) !== null) seen.set(id, { roomId: room.id, sessionId: event.sessionId, handoffId: fact.handoffId, name: event.uiMessage?.params?.name });
      }
      for (const line of seen.values()) if (line) lines.push(line);
    }
    return lines;
  }
  // B6 E4, the version gate. A member whose native version NAW has not verified keeps working with
  // fewer features. The session's own header says so; this records it once in each of its spaces,
  // per session and version, and never again for that version. Records only. Because a record is
  // permanent, a fact that may change a moment later is not written:
  // - Codex: a check that has finished and kept capabilities closed (nativeVersionCheck.held). A
  //   check still running reads as unverified too, and may open everything a moment later. A
  //   check that failed also keeps them closed, for this backend run; it is tried again at the
  //   next start, and the record stays even if that try passes.
  // - Claude: the fallback of claude-pin.cjs. While it lasts the session runs the older verified
  //   version; once its time is up the session runs the newer, unverified one. These are two facts.
  // - Only a session that is running: a stopped one keeps the fields of its last launch.
  versionGates() {
    const seen = new Map();
    for (const room of [{ ...this.value, id: DEFAULT_ROOM_ID }, ...this.spaces.rooms]) {
      for (const event of room.events) {
        const fact = event.monitor;
        if (fact?.kind !== 'version-gate' || typeof fact.key !== 'string') continue;
        if (!seen.has(fact.key)) seen.set(fact.key, new Set());
        seen.get(fact.key).add(room.id);
      }
    }
    return seen;
  }
  recordVersionGates(sessions, name = session => session.name) {
    if (!Array.isArray(sessions) || this.warning || this.spacesWarning) return false;
    const version = value => typeof value === 'string' && /^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(value);
    let wrote = false;
    for (const session of sessions) {
      if (!session || !orderId(session.id)) continue;
      if (!['idle', 'working', 'approval'].includes(session.state)) continue;
      let gate = null;
      const held = session.nativeVersionCheck?.held, pin = session.nativePin;
      if (session.provider === 'codex' && session.nativeVersionStatus === 'unverified' && version(session.nativeVersion) && Array.isArray(held) && held.length > 0) {
        gate = { provider: 'codex', version: session.nativeVersion, count: held.length };
      } else if (session.provider === 'claude' && pin && typeof pin === 'object' && version(pin.requested) && version(pin.pinned) && [undefined, false, true].includes(pin.expired)) {
        gate = { provider: 'claude', version: pin.requested, pinned: pin.pinned, expired: pin.expired === true };
      }
      if (!gate) continue;
      // Rebuilt from the saved records once, so a restart of the desktop repeats nothing.
      this.versionRecorded ||= this.versionGates();
      const key = `version-gate:${session.id}:${gate.provider}:${gate.version}${gate.expired ? ':expired' : ''}`;
      const rooms = this.versionRecorded.get(key) || new Set(), left = (this.versionLeft ||= new Map()).get(key) || new Set();
      let member = [];
      try { member = roomIds(session); } catch { /* Unreadable membership: nowhere to record. */ }
      const todo = member.filter(room => !rooms.has(room) && !left.has(room));
      if (!todo.length) continue;
      const who = name(session) || session.id;
      const notice = gate.provider === 'codex' ? uiNotice('notice.monitor.versionCodex', { name: who, version: gate.version, count: gate.count })
        : uiNotice(gate.expired ? 'notice.monitor.versionClaudeExpired' : 'notice.monitor.versionClaude', { name: who, pinned: gate.pinned, requested: gate.version });
      for (const room of todo) {
        // An archived or missing space is left alone until the desktop starts again; a busy one is tried at the next state.
        try { if (this.metadata(room).archived) { left.add(room); continue; } } catch { left.add(room); continue; }
        try {
          this.writable(room);
          this.update({}, { kind: 'monitor', sessionId: session.id, ...notice,
            monitor: { kind: 'version-gate', key, provider: gate.provider, version: gate.version, sessionId: session.id, ...(gate.expired ? { expired: true } : {}) } }, room);
          rooms.add(room); wrote = true;
        } catch { /* Busy now. */ }
      }
      if (rooms.size) this.versionRecorded.set(key, rooms);
      if (left.size) this.versionLeft.set(key, left);
    }
    return wrote;
  }
  moveMember(change, records, room = DEFAULT_ROOM_ID) {
    this.writable(room);
    if (!change || ![Object.prototype, null].includes(Object.getPrototypeOf(change)) || !orderId(change.id) || !orderId(change.target) || typeof change.after !== 'boolean') throw uiError("error.room.invalidMemberOrder");
    const value = this.metadata(room), people = records.filter(s => isMember(s, room) && !s.archived);
    for (const id of [change.id, change.target]) {
      this.assertAvailable(id, true, room);
      if (!people.some(s => s.id === id)) throw uiError("error.room.membersChangedOrderRetained");
    }
    if (change.id === change.target) return;
    const ids = new Set(records.map(s => s.id)), order = value.memberOrder.filter(id => ids.has(id));
    for (const id of ids) if (!order.includes(id)) order.push(id);
    if (order.length > 10000 || order.some(id => !orderId(id))) throw uiError("error.room.memberOrderLimit");
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
    if (typeof id !== 'string' || typeof join !== 'boolean') return Promise.reject(uiError("error.invalidMemberAction"));
    try { this.metadata(room); } catch (error) { return Promise.reject(error); }
    // Every join meets here, whoever asks (the person, an agent, a session NAW opened for a space, a rotation's
    // successor): `joinGuard(id)`, when set, is asked at the moment the join runs, in this one queue.
    const action = () => {
      if (join) { this.assertAvailable(id, true, room); this.joinGuard?.(id); }
      return this.changeMember(client, id, join, label, room, expected);
    };
    // Cleanup is conditional on the owning backend's final run check. An eager
    // human-intervention pause would affect unrelated work before that check.
    return expected?.unusedSuccessor === true ? this.serial(action) : this.enqueue(client, action, id, room);
  }
  async changeMember(client, id, join, label, room = DEFAULT_ROOM_ID, expected, archivePlacement = false) {
      if (expected?.unusedSuccessor === true && join) throw uiError('error.invalidMemberAction');
      const legacyDetach = archivePlacement && !join;
      const snapshot = await client.call('initial'), before = snapshot.sessions.find(s => s.id === id);
      if (!before) throw uiError("error.sessionMissing");
      const recovered = expected?.operationId && before.placementReceipt?.operationId === expected.operationId &&
        before.placementReceipt.nativeId === before.nativeId && before.placementReceipt.roomId === (join ? room : null) &&
        before.placementReceipt.revision === placementRevision(before) && before.placementReceipt.beforeRevision === expected.placementRevision &&
        before.placementReceipt.connectionRevision === (before.connectionRevision || 0);
      if (expected !== undefined && (!expected || expected.nativeId !== (before.nativeId ?? null) ||
          expected.revision !== undefined && !recovered && expected.revision !== membershipRevision(before, room) ||
          expected.placementRevision !== undefined && !recovered && expected.placementRevision !== placementRevision(before) ||
          expected.connectionRevision !== undefined && expected.connectionRevision !== (before.connectionRevision || 0))) throw uiError("error.room.membershipChangedNoRevocation");
      const prior = roomIds(before), modern = (before.serviceCapabilities || snapshot.capabilities || []).includes('singleHomeMoveV1') && !(legacyDetach && prior.length > 1);
      const guarded = expected?.unusedSuccessor === true;
      if (expected?.failedHandoff && (!guarded || !(before.serviceCapabilities || snapshot.capabilities || []).includes('failedSuccessorCleanupV1'))) throw uiError('error.movePlacementUnsupported');
      const idleArchive = expected?.archiveIdle === true;
      if (idleArchive && join) throw uiError('error.invalidMemberAction');
      // Older writers ignore unknown proof fields; never fall back to a detach
      // that cannot enforce this archive's idle requirement atomically.
      if (idleArchive && (!modern || !(before.serviceCapabilities || snapshot.capabilities || []).includes('archiveIdleMoveV1'))) throw uiError('error.movePlacementUnsupported');
      if (guarded) {
        if (!modern || !(before.serviceCapabilities || snapshot.capabilities || []).includes('guardedSessionStopV1')) throw uiError('error.movePlacementUnsupported');
        if (snapshot.storageWarning || this.spacesWarning) throw Object.assign(Error(snapshot.storageWarning || this.spacesWarning), { uiMessage: snapshot.storageWarning ? snapshot.storageWarningUiMessage : this.spacesWarningUiMessage });
        for (const place of new Set([room, ...prior])) { this.writable(place); this.assertAvailable(id, true, place); }
      }
      if (before.nativeContextPending || prior.length > 1 && !(legacyDetach && !join)) throw uiError(prior.length > 1 ? 'error.movePlacementAmbiguous' : 'error.movePlacementChanged');
      if (isMember(before, room) === join && !recovered) return { changed: false, roomId: room, sessionId: id, joined: join };
      // Both histories must be readable before changing an owning backend.
      this.metadata(room);
      if (modern && prior[0] && prior[0] !== room) this.metadata(prior[0]);
      let move;
      if (modern) {
        const proof = { operationId: expected?.operationId || randomUUID(), nativeId: before.nativeId,
          revision: placementRevision(before), connectionRevision: before.connectionRevision || 0,
          ...(guarded ? { unusedSuccessor: true, ...(expected?.failedHandoff ? { failedHandoff: expected.failedHandoff } : {}) } : {}), ...(idleArchive ? { archiveIdle: true } : {}) };
        try { move = recovered ? { ...before.placementReceipt, changed: true } : await client.call('moveMembership', id, join ? room : null, proof); }
        catch (error) {
          // Lost replies are reconciled from the same writer's saved receipt, never retried.
          const current = (await client.call('initial').catch(() => null))?.sessions.find(s => s.id === id);
          if (current?.nativeId !== before.nativeId || current?.placementReceipt?.operationId !== proof.operationId) throw error;
          move = { ...current.placementReceipt, changed: true };
        }
      } else {
        // Preserve old literal standalone join/leave. Never emulate A->B with two writes.
        if (join && prior.length) throw uiError('error.movePlacementUnsupported');
        // Individual archives retain the old backend's literal membership path;
        // room-owned archives require the atomic guard above. Without a receipt, validate the saved cut
        // above, issue once, and refuse a changed cut after an uncertain reply.
        const remoteExpected = archivePlacement ? undefined : expected;
        if (typeof client.callSpace === 'function') await client.callSpace(room, 'join', remoteExpected === undefined ? [id, join] : [id, join, { nativeId: remoteExpected.nativeId, revision: remoteExpected.revision ?? membershipRevision(before, room) }]);
        else if (room === DEFAULT_ROOM_ID) await client.call('join', id, join, ...(remoteExpected === undefined ? [] : [{ nativeId: remoteExpected.nativeId, revision: remoteExpected.revision ?? membershipRevision(before, room) }]));
        else if (remoteExpected !== undefined) await client.call('joinSpace', id, join, room, { nativeId: remoteExpected.nativeId, revision: remoteExpected.revision ?? membershipRevision(before, room) });
        else await client.call('joinSpace', id, join, room);
      }
      const after = (await client.call('initial')).sessions.find(s => s.id === id);
      if (!after || after.nativeId !== before.nativeId || isMember(after, room) !== join || roomIds(after).length > 1 && !legacyDetach ||
          modern && (!move || after.placementReceipt?.operationId !== move.operationId || placementRevision(after) !== move.revision)) throw uiError("error.room.memberStateUnconfirmed");
      const metadataChanges = [];
      try {
        const event = (space, kind) => {
          const key = modern ? `placement:${move.operationId}:${kind}` : null;
          const saved = key && this.metadata(space).events.find(e => e.id === key && e.sessionId === id);
          if (saved) { if (Number.isSafeInteger(saved.beforeRevision)) metadataChanges.push({ roomId: space, beforeRevision: saved.beforeRevision, revision: saved.beforeRevision + 1 }); return; }
          const beforeRevision = this.metadata(space).revision;
          this.update({}, { kind, sessionId: id, name: label || before.name,
            ...uiNotice(kind === 'join' ? 'notice.room.joined' : 'notice.room.left'), ...(key ? { id: key, beforeRevision } : {}) }, space);
          metadataChanges.push({ roomId: space, beforeRevision, revision: beforeRevision + 1 });
        };
        if (modern && move.previousRoomId && move.previousRoomId !== room) event(move.previousRoomId, 'leave');
        event(room, join ? 'join' : 'leave');
      } catch { throw uiError("error.room.membershipSavedTimelineFailed"); }
      return { changed: true, roomId: room, sessionId: id, joined: join, revision: membershipRevision(after, room), nativeId: after.nativeId,
        ...(modern ? { placementRevision: move.revision, previousRoomId: move.previousRoomId, connectionRevision: move.connectionRevision, operationId: move.operationId, metadataChanges } : { legacyPlacement: true }) };
  }
  assertAvailable(id, shared = false, room = DEFAULT_ROOM_ID) {
    if (this.warning) throw Object.assign(Error(this.warning), { uiMessage: this.warningUiMessage });
    if (id && (this.value.archivedSessions.includes(id) || this.gates.has(id))) throw uiError("error.room.sessionArchived");
    if (shared && (this.metadata(room).archived || this.gates.has(room === DEFAULT_ROOM_ID ? 'room' : `room:${room}`))) throw uiError("error.room.workspaceArchived");
    const merge = shared && this.metadata(room).merge;
    if (merge && (!merge.imported || merge.joins.length !== merge.batch.memberIds.length || ['preparing', 'joining', 'failed', 'undoing'].includes(merge.stage))) throw uiError("error.room.mergeStepsUnconfirmed");
  }
  // automatic: NAW's own archive of a session in no space (an old session a rotation replaced). It never leaves
  // or pauses a space on its own: a session still in one is refused, and nothing waits on a pause.
  archiveSession(client, id, label, { automatic = false, automaticCheck } = {}) {
    if (typeof id !== 'string' || !id || id.length > 100) return Promise.reject(uiError("error.main.invalidSession"));
    if (this.gates.has(id)) return Promise.reject(uiError("error.room.sessionUpdating"));
    // Read before the gate: a session the snapshot does not hold must not leave its gate set.
    let spaces;
    try { spaces = typeof client.snapshot === 'function' ? roomIds(client.snapshot().sessions.find(s => s.id === id)) : DEFAULT_ROOM_ID; }
    catch { return Promise.reject(uiError("error.sessionMissing")); }
    this.gates.add(id);
    const action = () => this.archiveSessionNow(client, id, label, { automatic, automaticCheck });
    return (automatic ? this.serial(action) : this.enqueue(client, action, id, spaces)).finally(() => this.gates.delete(id));
  }
  // Called only inside this.queue; public entry points own gates and serialization.
  async archiveSessionNow(client, id, label, { automatic = false, automaticCheck, archivedByRoom } = {}) {
      if (this.value.archivedSessions.includes(id)) return;
      const snapshot = await client.call('initial'), session = snapshot.sessions.find(s => s.id === id);
      if (!session) throw uiError("error.sessionMissing");
      if (archivedByRoom && !this.roomArchiveIdle(session)) throw uiError('error.planWorking');
      const check = automatic ? automaticCheck : null;
      if (automatic && (roomIds(session).length || check && !check(session))) throw uiError('error.room.sessionRestoreChanged');
      let plan = Object.hasOwn(this.value.sessionArchives, id) ? this.value.sessionArchives[id] : null;
      if (plan && (check || archivedByRoom && plan.archivedByRoom !== archivedByRoom)) throw uiError('error.room.sessionRestoreChanged');
      const pending = plan?.rooms.find(r => !r.done);
      if (plan && ((session.nativeId ?? null) !== plan.nativeId || plan.detached ||
          JSON.stringify(restorePlacement(session)) !== JSON.stringify(plan.checkpoint) &&
          !(pending?.expected && session.placementReceipt?.operationId === pending.expected.operationId))) {
        if (archivedByRoom) throw uiError('error.room.sessionRestoreChanged');
        // A failed archive is not a permanent reservation on a session. A new
        // explicit archive starts at its current location, never the stale one.
        const remaining = { ...this.value.sessionArchives }; delete remaining[id];
        this.update({ sessionArchives: remaining }); plan = null;
      }
      if (!plan) {
        const rooms = roomIds(session).map(space => {
          const value = this.metadata(space), members = snapshot.sessions.filter(s => isMember(s, space) && !this.value.archivedSessions.includes(s.id)).map(s => s.id);
          const ids = new Set(snapshot.sessions.map(s => s.id));
          // Save and restore count the same unknown slots. A forgotten member
          // cannot be distinguished from an absent backend by this snapshot.
          const order = [...value.memberOrder.filter(member => members.includes(member) || !ids.has(member) && !this.value.archivedSessions.includes(member)),
            ...members.filter(member => !value.memberOrder.includes(member))];
          const index = order.indexOf(id);
          return { id: space, index, next: order[index + 1] || null, expected: null, done: false };
        });
        plan = { nativeId: session.nativeId ?? null, rooms, checkpoint: restorePlacement(session), detached: null, ...(archivedByRoom ? { archivedByRoom } : {}) };
        if (!check) this.update({ sessionArchives: { ...this.value.sessionArchives, [id]: plan } });
      }
      if ((session.nativeId ?? null) !== plan.nativeId || plan.detached) throw uiError('error.room.sessionRestoreChanged');
      const capabilities = session.serviceCapabilities || snapshot.capabilities || [];
      if (archivedByRoom && session.state === 'ended' && roomIds(session).length === 1 && isMember(session, archivedByRoom) &&
          (currentFleet(session).unknown || session.backendUnavailable || session.transportDisconnected ||
            !['singleHomeMoveV1', 'archiveIdleMoveV1'].every(cap => capabilities.includes(cap)))) {
        // Older writers cannot guard a detach, or still reject historical fleet
        // observations. Keep the ended member's home and archive only the local
        // conversation; restoration accepts this same home. No native stop/join.
        const current = (await client.call('initial')).sessions.find(s => s.id === id);
        if (!current || current.state !== 'ended' || !this.roomArchiveIdle(current) ||
            !isDeepStrictEqual(restorePlacement(current), plan.checkpoint) ||
            roomIds(current).length !== 1 || !isMember(current, archivedByRoom)) throw uiError('error.room.sessionRestoreChanged');
        this.saveRoomSessionArchive(current, archivedByRoom, plan.rooms[0]);
        return;
      }
      for (let index = 0; index < plan.rooms.length; index++) {
        let step = plan.rooms[index]; if (step.done) continue;
        const current = (await client.call('initial')).sessions.find(s => s.id === id);
        if (!current || (current.nativeId ?? null) !== plan.nativeId) throw uiError('error.room.sessionRestoreChanged');
        if (archivedByRoom && !this.roomArchiveIdle(current)) throw uiError('error.planWorking');
        if (!step.expected) {
          if (!isMember(current, step.id)) throw uiError('error.room.sessionRestoreChanged');
          const expected = { operationId: randomUUID(), nativeId: current.nativeId ?? null, revision: membershipRevision(current, step.id),
            placementRevision: placementRevision(current), connectionRevision: current.connectionRevision || 0 };
          plan = { ...plan, rooms: plan.rooms.map((r, i) => i === index ? { ...r, expected } : r) };
          this.update({ sessionArchives: { ...this.value.sessionArchives, [id]: plan } }); step = plan.rooms[index];
        }
        await this.changeMember(client, id, false, label, step.id,
          archivedByRoom ? { ...step.expected, archiveIdle: true } : step.expected, true);
        const after = (await client.call('initial')).sessions.find(s => s.id === id);
        plan = { ...plan, checkpoint: restorePlacement(after), rooms: plan.rooms.map((r, i) => i === index ? { ...r, done: true } : r) };
        this.update({ sessionArchives: { ...this.value.sessionArchives, [id]: plan } });
      }
      const current = (await client.call('initial')).sessions.find(s => s.id === id);
      if (!current || (current.nativeId ?? null) !== plan.nativeId || roomIds(current).length ||
          JSON.stringify(restorePlacement(current)) !== JSON.stringify(plan.checkpoint)) throw uiError('error.room.sessionRestoreChanged');
      if (archivedByRoom && !this.roomArchiveIdle(current)) throw uiError('error.planWorking');
      if (check && !check(current)) throw uiError('error.room.sessionRestoreChanged');
      plan = { ...plan, detached: restorePlacement(current) };
      this.update({ archivedSessions: [...this.value.archivedSessions, id], sessionArchives: { ...this.value.sessionArchives, [id]: plan } });
  }
  restoreSession(client, id, label) {
    if (!orderId(id)) return Promise.reject(uiError('error.main.invalidSession'));
    if (this.gates.has(id)) return Promise.reject(uiError("error.room.sessionArchiving"));
    this.gates.add(id);
    return this.serial(() => this.restoreSessionNow(client, id, label)).finally(() => this.gates.delete(id));
  }
  async restoreSessionNow(client, id, label, restoringRoom) {
      const saved = Object.hasOwn(this.value.sessionArchives, id) ? this.value.sessionArchives[id] : null;
      if (!this.value.archivedSessions.includes(id)) {
        if (saved) { const remaining = { ...this.value.sessionArchives }; delete remaining[id]; this.update({ sessionArchives: remaining }); }
        return { restored: false };
      }
      let current, readError;
      try { current = (await client.call('initial')).sessions.find(s => s.id === id); }
      catch (error) { readError = error; }
      await client.retainRestoredSuccessor?.(id, current);
      let placement = 'unavailable';
      try {
        if (!saved || !saved.detached || saved.rooms.length > 1) throw Error('No unambiguous saved home');
        if (readError) throw readError;
        if (!current) throw Error('Native session unavailable');
        const recovered = saved.restoreExpected && current.placementReceipt?.operationId === saved.restoreExpected.operationId;
        if ((current.nativeId ?? null) !== saved.nativeId || !recovered && !sameHome(current, saved.detached)) throw Error('Placement changed');
        const place = saved.rooms[0];
        if (place) {
          let metadata; try { metadata = this.metadata(place.id); } catch { throw uiError('error.room.sessionRestoreUnavailable'); }
          if (metadata.archived && !(restoringRoom === place.id && saved.archivedByRoom === restoringRoom)) throw uiError('error.room.sessionRestoreUnavailable');
          let plan = saved;
          if (!plan.restoreExpected || !recovered && plan.restoreExpected.connectionRevision !== (current.connectionRevision || 0)) {
            plan = { ...plan, restoreExpected: { operationId: randomUUID(), nativeId: current.nativeId ?? null, revision: membershipRevision(current, place.id),
              placementRevision: placementRevision(current), connectionRevision: current.connectionRevision || 0 } };
            this.update({ sessionArchives: { ...this.value.sessionArchives, [id]: plan } });
          }
          // A backend pause/rejoin failure only prevents placement restoration;
          // it must never prevent the local session from leaving the archive.
          if (typeof client.callSpace === 'function') await client.callSpace(place.id, 'pause', []);
          else await client.call('pause', id);
          await this.changeMember(client, id, true, label, place.id, plan.restoreExpected, true);
          const snapshot = await client.call('initial'), ids = new Set(snapshot.sessions.map(s => s.id));
          const members = snapshot.sessions.filter(s => isMember(s, place.id) && (s.id === id || !this.value.archivedSessions.includes(s.id))).map(s => s.id);
          metadata = this.metadata(place.id);
          // An absent backend is not evidence that its saved members vanished.
          // Retain their slots and count unarchived unknowns when locating the
          // saved active index, so a returning member keeps its relative order.
          const rest = [...metadata.memberOrder.filter(member => member !== id), ...members.filter(member => member !== id && !metadata.memberOrder.includes(member))];
          const active = rest.filter(member => members.includes(member) || !ids.has(member) && !this.value.archivedSessions.includes(member)), next = active[place.index];
          // A saved neighbour survives changes to the number of earlier members.
          // For a legacy plan or missing neighbour, keep the retained raw slot
          // when present; only then fall back to the old active index.
          const slot = metadata.memberOrder.indexOf(id);
          const offset = place.next && rest.includes(place.next) ? rest.indexOf(place.next)
            : slot >= 0 ? metadata.memberOrder.slice(0, slot).filter(member => rest.includes(member)).length
            : place.next === null ? rest.length
            : next ? rest.indexOf(next) : rest.length;
          this.commit({ ...metadata, memberOrder: [...rest.slice(0, offset), id, ...rest.slice(offset)] }, place.id);
        }
        placement = 'restored';
      } catch (error) {
        // Room restore remains retryable after backend/disk failure; individual
        // restore still offers its existing standalone fallback.
        if (restoringRoom) throw error;
      }
      const remaining = { ...this.value.sessionArchives }; delete remaining[id];
      const notice = placement === 'restored' ? null : uiNotice('notice.room.sessionRestoreFallback');
      // Standalone restore can leave every backend revision unchanged.
      this.update({ archivedSessions: this.value.archivedSessions.filter(value => value !== id), sessionArchives: remaining,
        restoredSessions: [...new Set([...this.value.restoredSessions, id])] },
        notice ? { kind: 'restore-session', sessionId: id, ...notice } : undefined);
      return { restored: true, placement, ...(notice || {}) };
  }
  roomArchiveIdle(session) {
    return archiveIdle(session);
  }
  saveRoomSessionArchive(session, room, step) {
    const cut = restorePlacement(session);
    this.update({ archivedSessions: [...new Set([...this.value.archivedSessions, session.id])],
      sessionArchives: { ...this.value.sessionArchives, [session.id]: { nativeId: session.nativeId ?? null,
        rooms: [{ ...step, done: true }], checkpoint: cut, detached: cut, archivedByRoom: room } } });
  }
  archiveMemberNotice(room, id, session, labels, reason, error) {
    const name = labels?.get(id) || session?.name || id;
    const failure = error?.uiMessage?.key;
    const key = reason !== 'failed' ? reason : failure === 'error.planWorking' ? 'failedWorking'
      : failure === 'error.movePlacementUnsupported' ? 'failedUnsupported'
      : failure === 'error.room.sessionRestoreChanged' || failure === 'error.movePlacementChanged' ? 'failedChanged' : 'failed';
    this.update({}, { kind: 'archive-member', sessionId: id, name, archiveReason: reason,
      ...(failure ? { archiveError: failure } : {}), ...uiNotice(`notice.room.archiveMember.${key}`, { name }) }, room);
  }
  archiveKeepReason(session) {
    if (!session) return 'changed';
    if (roomIds(session).length > 1) return 'elsewhere';
    return ['working', 'starting', 'stopping', 'approval', 'background'].includes(session.state) ||
      session.activeTurnId || session.pendingTag || session.pendingQueue || session.pendingSteer || session.nativeInputRequired ||
      session.approval || session.nativeApproval?.requests?.length || session.nativeGoal?.status === 'active' ||
      session.background > 0 || session.scheduled > 0 || currentFleet(session).running ? 'working' : 'unconfirmed';
  }
  roomArchivePlan(snapshot, room = DEFAULT_ROOM_ID) {
    const value = this.metadata(room);
    const pending = id => value.restoreMembers.includes(id) && !this.value.archivedSessions.includes(id);
    const members = snapshot.sessions.filter(s => !this.value.archivedSessions.includes(s.id) && (isMember(s, room) || pending(s.id)));
    const archive = members.filter(s => this.roomArchiveIdle(s) && (roomIds(s).length === 1 && isMember(s, room) ||
      pending(s.id) && !roomIds(s).length && (this.value.sessionArchives[s.id]?.archivedByRoom === room ||
        isDeepStrictEqual(restorePlacement(s), value.restorePlacements[s.id])))).map(s => s.id);
    const missing = value.restoreMembers.filter(id => pending(id) && !snapshot.sessions.some(s => s.id === id));
    return { room, name: value.name, archived: value.archived, archive, keep: [...members.filter(s => !archive.includes(s.id)).map(s => s.id), ...missing],
      members: [...members.map(s => ({ id: s.id, ...restorePlacement(s) })), ...missing.map(id => ({ id, missing: true }))] };
  }
  archiveRoom(client, labels, room = DEFAULT_ROOM_ID, approved) {
    const gate = room === DEFAULT_ROOM_ID ? 'room' : `room:${room}`;
    try { this.metadata(room); } catch (error) { return Promise.reject(error); }
    if (this.gates.has(gate)) return Promise.reject(uiError("error.room.workspaceBusy"));
    this.gates.add(gate);
    return this.enqueue(client, async () => {
      const value = this.metadata(room);
      const snapshot = await client.call('initial'), plan = this.roomArchivePlan(snapshot, room);
      if (approved && !isDeepStrictEqual(plan, approved)) throw uiError('error.room.sessionRestoreChanged');
      if (value.archived && !plan.archive.length && !plan.keep.length) return;
      // Persist the intent first. Each session's saved archive owns its original
      // placement and room provenance, including retries after a partial detach.
      const restoreMembers = [...new Set([...value.restoreMembers, ...plan.archive])];
      this.update({ restoreMembers }, undefined, room);
      for (const id of plan.keep) {
        const current = snapshot.sessions.find(s => s.id === id);
        const saved = this.value.sessionArchives[id];
        const proof = saved?.archivedByRoom === room ? saved.checkpoint : value.restorePlacements?.[id];
        const changed = !current || !isMember(current, room) && (!proof || !isDeepStrictEqual(restorePlacement(current), proof));
        this.archiveMemberNotice(room, id, current, labels, changed ? 'changed' : this.archiveKeepReason(current));
      }
      for (const id of plan.archive) {
        if (this.value.archivedSessions.includes(id)) continue;
        const saved = this.value.sessionArchives[id], current = (await client.call('initial')).sessions.find(s => s.id === id);
        const owned = saved?.archivedByRoom === room;
        if (!current || !this.roomArchiveIdle(current)) {
          this.archiveMemberNotice(room, id, current, labels, this.archiveKeepReason(current)); continue;
        }
        try {
          if (!owned && !isDeepStrictEqual({ id, ...restorePlacement(current) }, plan.members.find(s => s.id === id))) throw uiError('error.room.sessionRestoreChanged');
          if (!saved && !roomIds(current).length && value.restoreMembers.includes(id) &&
              isDeepStrictEqual(restorePlacement(current), value.restorePlacements?.[id])) {
            // The old room-only archive already detached this exact identity. Its
            // saved cut authorizes local repair, never a second backend mutation.
            const index = value.restoreMembers.indexOf(id);
            this.saveRoomSessionArchive(current, room, { id: room, index, next: value.restoreMembers[index + 1] || null, expected: null });
            continue;
          }
          if (!owned && (roomIds(current).length !== 1 || !isMember(current, room))) throw uiError('error.room.sessionRestoreChanged');
          if (owned && (!isDeepStrictEqual(restorePlacement(current), saved.checkpoint) &&
              !saved.rooms.some(r => r.expected?.operationId && r.expected.operationId === current.placementReceipt?.operationId))) throw uiError('error.room.sessionRestoreChanged');
          await this.archiveSessionNow(client, id, labels?.get(id), { archivedByRoom: room });
        } catch (error) {
          this.archiveMemberNotice(room, id, current, labels, 'failed', error);
          throw error;
        }
      }
      this.update({ archived: true }, { kind: 'archive', ...uiNotice('notice.room.archived') }, room);
    }, undefined, room).finally(() => this.gates.delete(gate));
  }
  restoreRoom(client, labels, room = DEFAULT_ROOM_ID) {
    const gate = room === DEFAULT_ROOM_ID ? 'room' : `room:${room}`;
    try { this.metadata(room); } catch (error) { return Promise.reject(error); }
    if (this.gates.has(gate)) return Promise.reject(uiError("error.room.workspaceBusy"));
    this.gates.add(gate);
    return this.enqueue(client, async () => {
      const value = this.metadata(room);
      if (!value.archived && !value.restoreMembers.length) return;
      const sessions = (await client.call('initial')).sessions;
      const wanted = value.restoreMembers.filter(id => sessions.some(s => s.id === id) && (!this.value.archivedSessions.includes(id) || this.value.sessionArchives[id]?.archivedByRoom === room));
      const skipped = [];
      for (const id of wanted) {
        const saved = this.value.sessionArchives[id];
        if (saved?.archivedByRoom === room) {
          const current = (await client.call('initial')).sessions.find(s => s.id === id);
          const recovered = saved.restoreExpected && current?.placementReceipt?.operationId === saved.restoreExpected.operationId;
          if (!current || (current.nativeId ?? null) !== saved.nativeId) { skipped.push(id); continue; }
          if (!saved.detached) {
            // A local save can fail after the backend detached. Its exact saved
            // checkpoint/receipt is enough to restore, without replaying detach.
            const receipt = saved.rooms[0]?.expected?.operationId && saved.rooms[0].expected.operationId === current.placementReceipt?.operationId;
            if (!sameHome(current, saved.checkpoint) && !receipt) { skipped.push(id); continue; }
            if (isMember(current, room)) {
              const remaining = { ...this.value.sessionArchives }; delete remaining[id];
              this.update({ sessionArchives: remaining }); continue;
            }
            if (roomIds(current).length) { skipped.push(id); continue; }
            this.update({ archivedSessions: [...new Set([...this.value.archivedSessions, id])], sessionArchives: { ...this.value.sessionArchives,
              [id]: { ...saved, detached: restorePlacement(current) } } });
          } else if (!recovered && !sameHome(current, saved.detached)) { skipped.push(id); continue; }
          try { this.joinGuard?.(id); } catch { skipped.push(id); continue; }
          await this.restoreSessionNow(client, id, labels?.get(id), room);
          this.update({ restoreMembers: this.metadata(room).restoreMembers.filter(value => value !== id) }, undefined, room);
          continue;
        }

        const current = (await client.call('initial')).sessions.find(s => s.id === id), proof = this.metadata(room).restorePlacements?.[id];
        if (current && roomIds(current).length === 1 && isMember(current, room)) continue;
        if (!current || !proof || roomIds(current).length || JSON.stringify(restorePlacement(current)) !== JSON.stringify(proof)) { skipped.push(id); continue; }
        // A former member that may not join now (the butler) is left out, as one placed elsewhere is; the space restores.
        try { this.joinGuard?.(id); } catch { skipped.push(id); continue; }
        await this.changeMember(client, id, true, labels?.get(id), room, { nativeId: current.nativeId, placementRevision: placementRevision(current), connectionRevision: current.connectionRevision || 0 });
        const remaining = { ...this.metadata(room).restorePlacements }; delete remaining[id];
        this.update({ restoreMembers: this.metadata(room).restoreMembers.filter(value => value !== id), restorePlacements: remaining }, undefined, room);
      }
      this.update({ archived: false, restoreMembers: [], restorePlacements: {} }, { kind: 'restore',
        ...uiNotice(skipped.length ? 'notice.room.restoredPlacementRetained' : 'notice.room.restored', skipped.length ? { count: skipped.length } : undefined), ...(skipped.length ? { skippedSessions: skipped } : {}) }, room);
    }, undefined, room).finally(() => this.gates.delete(gate));
  }
  clear(revision, room = DEFAULT_ROOM_ID) {
    this.writable(room);
    const value = this.metadata(room);
    if (revision === undefined) revision = value.revision;
    if (revision !== value.revision) throw uiError("error.room.updatedDuringClear");
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
  // Why each queued item was not sent on the dispatcher's last pass (queue-dispatch.cjs planDispatch `waits`): kept in
  // memory only and replaced on every pass. Returns whether it changed, so the windows are told.
  setQueueWaits(waits) {
    const next = new Map();
    for (const [id, list] of waits || []) next.set(id, list.map(entry => ({ ...entry })));
    const changed = JSON.stringify([...next]) !== JSON.stringify([...this.queueWaits]);
    this.queueWaits = next;
    return changed;
  }
  apply(snapshot, selected = DEFAULT_ROOM_ID) {
    const metadata = [{ ...this.value, id: DEFAULT_ROOM_ID }, ...this.spaces.rooms];
    const rooms = metadata.map(value => {
      const backend = (snapshot.rooms || [snapshot.room]).find(r => r?.id === value.id || value.id === DEFAULT_ROOM_ID && r && !r.id);
      return { ...(backend || { id: value.id, revision: 0, run: null, messages: [] }), id: value.id, name: value.name, notes: value.notes, notesToQueue: value.notesToQueue === true, notesToQueueSince: value.notesToQueue === true ? value.notesToQueueSince : 0, metadataRevision: value.revision, events: displayEvents(value.events), archived: value.archived, memberOrder: [...value.memberOrder], files: value.files.map(f => ({ ...f })), queue: copyQueue(value.queue, this.queueWaits),
        ...(value.merge ? { merge: { operationId: value.merge.batch.operationId, binding: value.merge.batch.binding, stage: value.merge.stage,
          imported: value.merge.imported, failures: [...value.merge.failures], failuresUiMessage: value.merge.failuresUiMessage || null, undoKeptTarget: Boolean(value.merge.undoKeptTarget),
          sources: value.merge.sources.map(source => ({ id: source.id, name: value.merge.batch.sources.find(original => original.id === source.id)?.name, status: source.status, error: source.error || '', errorUiMessage: source.errorUiMessage || null })),
          notes: value.merge.batch.blocks.filter(block => block.notes !== null && block.notes !== '').map(block => ({ roomId: block.roomId, name: block.name, text: block.notes })),
          events: value.merge.batch.blocks.filter(block => block.events.length).map(block => ({ roomId: block.roomId, name: block.name, events: structuredClone(displayEvents(block.events)) })) } } : {}) };
    });
    return { ...snapshot, sessions: snapshot.sessions.map(s => ({ ...s, archived: this.value.archivedSessions.includes(s.id) })), roomStorageWarning: this.warning || this.spacesWarning, roomStorageWarningUiMessage: this.warning ? this.warningUiMessage : this.spacesWarningUiMessage, rooms, room: rooms.find(r => r.id === selected) || { id: selected, name: '空间资料未能读取', unavailable: true, archived: true, messages: [], events: [], files: [], notes: '', memberOrder: [], metadataRevision: 0 } };
  }
}
module.exports = { RoomState, sameHome };
