'use strict';
// One dedicated read capability. It has no generic executor, session reader,
// native connection, file tool, model call or approval-based escape route.
const { createHash } = require('node:crypto');
const { types: { isProxy } } = require('node:util');
const path = require('node:path');
const { ButlerReadAudit, MAX_PAGES_PER_UTC_DAY } = require('./butler-read-audit.cjs');
const { roomId, DEFAULT_ROOM_ID } = require('./collaboration-spaces.cjs');
const { validReady, ITEM_TEXT_LIMIT, QUEUE_LIMIT } = require('./queue-dispatch.cjs');
const { storedReadySource } = require('./butler-ready.cjs');
const { storedQueueSource } = require('./butler-ingress.cjs');
const { validateEvent } = require('./butler-policy.cjs');
const MAX_BYTES = 64 * 1024, MAX_LIMIT = 50, MAX_SCAN_RECORDS = 2000, MAX_SPACES = 1000, MAX_WINDOW = 31 * 24 * 60 * 60 * 1000;
const STATUSES = ['queued', 'sent', 'waiting', 'done', 'failed', 'cancelled'];
const fail = code => { throw Object.assign(Error(code), { code }); };
const plain = value => value && typeof value === 'object' && !isProxy(value) && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const time = value => Number.isSafeInteger(value) && value >= 0;
function fields(value, allowed, required = []) {
  if (!plain(value) || Object.keys(value).some(key => !allowed.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')) ||
      required.some(key => !Object.hasOwn(value, key))) fail('ERR_BUTLER_BUSINESS_QUERY');
}
function safeText(value, limit) {
  if (typeof value !== 'string' || value.length > limit) fail('ERR_BUTLER_BUSINESS_UNAVAILABLE');
  validateEvent({ eventId: 'business-projection', sourceRef: 'business-projection', kind: 'blocked', payload: { text: value } });
  return value;
}
function safeId(value) {
  if (typeof value !== 'string' || !value.length || value.length > 200 || /[\s\u0000-\u001f\u007f]/u.test(value)) fail('ERR_BUTLER_BUSINESS_UNAVAILABLE');
  return safeText(value, 200);
}
const spaceRef = id => `naw:space:${id}`;
const recordRef = (kind, spaceId, id) => `${spaceRef(spaceId)}/${kind}:${encodeURIComponent(safeId(id))}`;
const revision = value => { if (!time(value)) fail('ERR_BUTLER_BUSINESS_UNAVAILABLE'); return value; };
function queryInput(value) {
  fields(value, ['kind', 'spaceId', 'includeArchived', 'fromTime', 'throughTime', 'limit', 'cursor'], ['kind']);
  if (!['spaces', 'queue', 'deliveries'].includes(value.kind)) fail('ERR_BUTLER_BUSINESS_QUERY');
  const allowed = value.kind === 'spaces' ? ['kind', 'includeArchived', 'limit', 'cursor'] :
    value.kind === 'queue' ? ['kind', 'spaceId', 'limit', 'cursor'] : ['kind', 'spaceId', 'fromTime', 'throughTime', 'limit', 'cursor'];
  fields(value, allowed, value.kind === 'spaces' ? [] : value.kind === 'queue' ? ['spaceId'] : ['spaceId', 'fromTime', 'throughTime']);
  const limit = value.limit === undefined ? 20 : value.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT || value.cursor !== undefined &&
      (typeof value.cursor !== 'string' || !/^[A-Za-z0-9_-]{1,8192}$/u.test(value.cursor))) fail('ERR_BUTLER_BUSINESS_QUERY');
  const query = { kind: value.kind, limit };
  if (value.kind === 'spaces') {
    if (value.includeArchived !== undefined && typeof value.includeArchived !== 'boolean') fail('ERR_BUTLER_BUSINESS_QUERY');
    query.includeArchived = value.includeArchived === true;
  } else {
    if (!roomId(value.spaceId)) fail('ERR_BUTLER_BUSINESS_QUERY'); query.spaceId = value.spaceId;
  }
  if (value.kind === 'deliveries') {
    if (!time(value.fromTime) || !time(value.throughTime) || value.throughTime < value.fromTime || value.throughTime - value.fromTime > MAX_WINDOW) fail('ERR_BUTLER_BUSINESS_QUERY');
    query.fromTime = value.fromTime; query.throughTime = value.throughTime;
  }
  return { query, cursor: value.cursor };
}
const scanRef = (scope, version, position) => `scan:${hash([scope, version, position])}`;
function decodeCursor(cursor, scope, version, length) {
  if (cursor === undefined) return 0;
  let value;
  try { value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); }
  catch { fail('ERR_BUTLER_BUSINESS_QUERY'); }
  fields(value, ['version', 'scope', 'revision', 'position', 'afterRef'], ['version', 'scope', 'revision', 'position', 'afterRef']);
  if (value.version !== 1 || !Number.isSafeInteger(value.position) || value.position < 1 || typeof value.afterRef !== 'string') fail('ERR_BUTLER_BUSINESS_QUERY');
  if (value.scope !== scope || value.revision !== version) fail('ERR_BUTLER_BUSINESS_STALE');
  if (value.position > length || scanRef(scope, version, value.position) !== value.afterRef) fail('ERR_BUTLER_BUSINESS_QUERY');
  return value.position;
}
const encodeCursor = (scope, version, position) => Buffer.from(JSON.stringify({ version: 1, scope, revision: version, position, afterRef: scanRef(scope, version, position) })).toString('base64url');

class ButlerBusiness {
  #role; #roomState; #view; #readAudit;
  constructor({ role, roomState, view, readAudit }) {
    if (!role || typeof role.authorize !== 'function' || !roomState || typeof roomState.metadata !== 'function' || typeof view !== 'function') fail('ERR_BUTLER_BUSINESS_OPTIONS');
    if (readAudit !== undefined && !(readAudit instanceof ButlerReadAudit) || typeof role.file !== 'string' || !path.isAbsolute(role.file)) fail('ERR_BUTLER_BUSINESS_OPTIONS');
    this.#role = role; this.#roomState = roomState; this.#view = view;
    this.#readAudit = readAudit || new ButlerReadAudit(path.dirname(role.file));
  }
  #records() {
    const state = this.#view();
    if (!state || !Array.isArray(state.records)) fail('ERR_BUTLER_UNAUTHORIZED');
    return state.records;
  }
  #authorize(binding) {
    const records = this.#records(), actor = records.find(record => record.id === binding.id && record.nativeId === binding.nativeId);
    if (!actor) fail('ERR_BUTLER_UNAUTHORIZED');
    return this.#role.authorize(actor, binding.expected, records);
  }
  bind(actualActorRecord, expected) {
    fields(expected, ['selectionRevision', 'runnerRef'], ['selectionRevision', 'runnerRef']);
    const records = this.#records(); this.#role.authorize(actualActorRecord, expected, records);
    const binding = { id: actualActorRecord.id, nativeId: actualActorRecord.nativeId,
      expected: Object.freeze({ selectionRevision: expected.selectionRevision, runnerRef: expected.runnerRef }) };
    return Object.freeze({
      catalog: () => {
        this.#authorize(binding);
        return { readOnly: true, activation: 'off', recordPeriod: 'off', methods: [{ name: 'readBusiness',
          kinds: ['spaces', 'queue', 'deliveries'], maxRecords: MAX_LIMIT, maxBytes: MAX_BYTES,
          maxScanRecords: MAX_SCAN_RECORDS, maxSpaces: MAX_SPACES, maxWindowMs: MAX_WINDOW,
          maxPagesPerUtcDay: MAX_PAGES_PER_UTC_DAY }] };
      },
      invoke: (method, input) => {
        this.#authorize(binding);
        if (method !== 'readBusiness') fail('ERR_BUTLER_BUSINESS_METHOD');
        const parsed = queryInput(input), { query } = parsed, page = this.#read(parsed);
        const selected = this.#authorize(binding);
        const scope = { kind: query.kind, spaceId: query.spaceId ?? null, limit: query.limit };
        if (query.kind === 'spaces') scope.includeArchived = query.includeArchived;
        if (query.kind === 'deliveries') Object.assign(scope, { fromTime: query.fromTime, throughTime: query.throughTime });
        try {
          const receipt = this.#readAudit.recordPage({
            actor: { sessionId: selected.identity.sessionId, nativeId: selected.identity.nativeId,
              selectionRevision: selected.selectionRevision, runnerRef: selected.runner.runnerRef },
            query: scope, result: { count: page.records.length, recordRefs: page.records.map(row => row.recordRef),
              scanned: page.scanned, truncated: page.truncated },
          });
          if (!receipt || !Number.isSafeInteger(receipt.sequence) || receipt.sequence < 1 ||
              !Number.isSafeInteger(receipt.pageOfDay) || receipt.pageOfDay < 1 || receipt.pageOfDay > MAX_PAGES_PER_UTC_DAY) fail('ERR_BUTLER_BUSINESS_AUDIT');
        } catch (error) {
          fail(error?.code === 'ERR_BUTLER_READ_LIMIT' ? 'ERR_BUTLER_BUSINESS_READ_LIMIT' : 'ERR_BUTLER_BUSINESS_AUDIT');
        }
        this.#authorize(binding);
        return page;
      },
    });
  }
  #writable(id, room) {
    if (room.archived) return false;
    try { this.#roomState.writable(id); return true; } catch { return false; }
  }
  #meta(id, room) {
    return { spaceId: id, spaceRecordRef: spaceRef(id), metadataRevision: revision(room.revision),
      archived: room.archived === true, writable: this.#writable(id, room), readOnly: true };
  }
  #space(id) {
    if (id === DEFAULT_ROOM_ID ? this.#roomState.warning : this.#roomState.spacesWarning) fail('ERR_BUTLER_BUSINESS_UNAVAILABLE');
    if (id !== DEFAULT_ROOM_ID && this.#roomState.spaces?.rooms?.length + 1 > MAX_SPACES) fail('ERR_BUTLER_BUSINESS_CAPACITY');
    return this.#roomState.metadata(id);
  }
  #spaceRow(id, room) {
    const metadata = this.#meta(id, room), queue = room.queue;
    const queueCounts = Object.fromEntries(STATUSES.map(status => [status, 0]));
    if (queue !== undefined && (!Array.isArray(queue) || queue.length > QUEUE_LIMIT)) fail('ERR_BUTLER_BUSINESS_UNAVAILABLE');
    for (const item of queue || []) {
      if (!STATUSES.includes(item.status)) fail('ERR_BUTLER_BUSINESS_UNAVAILABLE');
      queueCounts[item.status]++;
    }
    let name;
    try { name = safeText(room.name, 200); }
    catch { return { ...metadata, recordRef: spaceRef(id), time: null, status: 'unavailable' }; }
    return { ...metadata, recordRef: spaceRef(id), time: null, name, queueCounts };
  }
  #queueRow(item, metadata) {
    const ref = recordRef('item', metadata.spaceId, item.id);
    try {
      if (!STATUSES.includes(item.status) || !time(item.createdAt)) fail('ERR_BUTLER_BUSINESS_UNAVAILABLE');
      const result = { ...metadata, recordRef: ref, itemId: safeId(item.id), time: item.createdAt,
        text: safeText(item.text, ITEM_TEXT_LIMIT), status: item.status, assignee: item.assignee === null ? null : safeId(item.assignee) };
      for (const field of ['sentAt', 'finishedAt']) if (item[field] !== undefined) {
        if (!time(item[field])) fail('ERR_BUTLER_BUSINESS_UNAVAILABLE'); result[field] = item[field];
      }
      if (item.ready !== undefined) {
        if (validReady(item.ready)) result.ready = { branch: safeText(item.ready.branch, 200), commit: item.ready.commit };
        else result.readyStatus = 'unavailable';
      }
      return result;
    } catch { return { ...metadata, recordRef: ref, time: null, status: 'unavailable' }; }
  }
  #deliveryRow(event, metadata) {
    if (event.role !== 'system' || event.kind !== 'queue') return null;
    const monitor = event.monitor;
    if (monitor?.kind === 'ready') {
      const ref = recordRef('event', metadata.spaceId, event.id);
      try {
        if (event.role !== 'system' || !validReady(monitor) || monitor.key !== `ready:${metadata.spaceId}:${safeId(monitor.itemId)}`) fail('ERR_BUTLER_BUSINESS_UNAVAILABLE');
        const result = { ...metadata, recordRef: ref, eventId: safeId(event.id), itemId: safeId(monitor.itemId),
          itemRecordRef: recordRef('item', metadata.spaceId, monitor.itemId), time: event.time, kind: 'ready', status: 'done',
          branch: safeText(monitor.branch, 200), commit: monitor.commit, sourceTaskStatus: 'unavailable' };
        if (Object.hasOwn(event, 'butlerSource')) {
          const source = storedReadySource(metadata.spaceId, event);
          if (source.kind === 'ready') { result.sourceTask = safeText(source.payload.text, ITEM_TEXT_LIMIT); result.sourceTaskStatus = 'available'; }
        }
        return result;
      } catch { return { ...metadata, recordRef: ref, time: event.time, status: 'unavailable' }; }
    }
    if (!Object.hasOwn(event, 'butlerSource')) return null;
    const source = storedQueueSource(metadata.spaceId, event), ref = recordRef('event', metadata.spaceId, event.id);
    if (!['decision', 'failure'].includes(source.kind)) return { ...metadata, recordRef: ref, time: event.time, status: 'unavailable' };
    return { ...metadata, recordRef: ref, eventId: safeId(event.id), itemId: safeId(source.payload.itemId),
      itemRecordRef: recordRef('item', metadata.spaceId, source.payload.itemId), time: event.time,
      kind: source.kind, status: source.kind === 'decision' ? 'waiting' : 'failed' };
  }
  #read({ query, cursor }) {
    const scope = hash(query);
    let length, sourceAt, project, version, metadata = null;
    if (query.kind === 'spaces') {
      if (this.#roomState.warning || this.#roomState.spacesWarning || !Array.isArray(this.#roomState.spaces?.rooms)) fail('ERR_BUTLER_BUSINESS_UNAVAILABLE');
      const others = this.#roomState.spaces.rooms;
      length = others.length + 1;
      if (length > MAX_SPACES) fail('ERR_BUTLER_BUSINESS_CAPACITY');
      sourceAt = index => index === 0 ? { id: DEFAULT_ROOM_ID, room: this.#roomState.value } : { id: others[index - 1].id, room: others[index - 1] };
      const digest = createHash('sha256');
      for (let i = 0; i < length; i++) {
        const { id, room } = sourceAt(i);
        if (!roomId(id)) fail('ERR_BUTLER_BUSINESS_UNAVAILABLE');
        digest.update(JSON.stringify([id, revision(room.revision), room.archived === true, this.#writable(id, room)]));
      }
      version = digest.digest('hex');
      project = index => { const { id, room } = sourceAt(index); return room.archived && !query.includeArchived ? null : this.#spaceRow(id, room); };
    } else {
      const room = this.#space(query.spaceId); metadata = this.#meta(query.spaceId, room);
      const source = query.kind === 'queue' ? room.queue || [] : room.events;
      if (!Array.isArray(source) || query.kind === 'queue' && source.length > QUEUE_LIMIT) fail('ERR_BUTLER_BUSINESS_UNAVAILABLE');
      length = source.length; sourceAt = index => source[index];
      version = hash([metadata.metadataRevision, metadata.archived, metadata.writable]);
      project = index => {
        const value = sourceAt(index);
        if (query.kind === 'queue') return this.#queueRow(value, metadata);
        const recordedTime = value.time;
        if (!time(recordedTime) || recordedTime < query.fromTime || recordedTime > query.throughTime) return null;
        return this.#deliveryRow(value, metadata);
      };
    }
    const start = decodeCursor(cursor, scope, version, length), records = [];
    const base = { kind: query.kind, readOnly: true, activation: 'off', recordPeriod: 'off', limit: query.limit,
      ...(metadata || {}), ...(query.kind === 'deliveries' ? { fromTime: query.fromTime, throughTime: query.throughTime,
        coverage: 'structured-queue-events-only', legacyDetails: 'unavailable' } : {}) };
    let position = start, scanned = 0;
    const page = () => ({ ...base, records, scanned, truncated: position < length,
      nextCursor: position < length ? encodeCursor(scope, version, position) : null });
    for (let index = start; index < length && scanned < MAX_SCAN_RECORDS; index++) {
      scanned++; const row = project(index); position = index + 1; if (!row) continue;
      records.push(row);
      if (Buffer.byteLength(JSON.stringify(page())) > MAX_BYTES - 128) {
        records.pop(); position = index;
        if (!records.length) fail('ERR_BUTLER_BUSINESS_UNAVAILABLE');
        break;
      }
      if (records.length === query.limit) break;
    }
    const result = page();
    if (Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES) fail('ERR_BUTLER_BUSINESS_UNAVAILABLE');
    return result;
  }
}
module.exports = { ButlerBusiness, MAX_BYTES, MAX_LIMIT, MAX_WINDOW, MAX_SCAN_RECORDS, MAX_SPACES };
