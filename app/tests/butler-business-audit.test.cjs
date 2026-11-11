'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { ButlerBusiness } = require('../butler-business.cjs');
const { ButlerReadAudit } = require('../butler-read-audit.cjs');
const { ButlerRole } = require('../butler-role.cjs');
const { RoomState } = require('../room-state.cjs');
const NOW = Date.UTC(2026, 10, 11, 12);
const BODY = 'Synthetic task body that must never enter the read audit';
const runner = { purpose: 'butler', runnerRef: 'audit-runner', backendRef: 'audit-backend', profile: 'fixture', provider: 'fixture', model: 'fixture' };
function fixture(t, beforeClock = () => {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-business-audit-')); fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const person = Symbol('person'), role = new ButlerRole(directory, { authorizePerson: value => value === person });
  const actor = { id: 'selected-instance', nativeId: 'selected-native', provider: 'dsh', state: 'idle', roomIds: [], runner };
  role.set(person, { identity: { sessionId: actor.id, nativeId: actor.nativeId }, runner }, 0);
  const room = new RoomState(directory), records = [actor];
  room.value.name = 'Synthetic space name excluded from the audit';
  room.value.queue = [{ id: 'synthetic-item', text: BODY, status: 'queued', assignee: null, createdAt: NOW }];
  let privateReads = 0;
  Object.defineProperty(room.value.queue[0], 'reply', { enumerable: true, get() { privateReads++; throw Error('Private reply getter must stay untouched'); } });
  const audit = new ButlerReadAudit(directory, { authorizePerson: value => value === person,
    now: () => { beforeClock({ role, person }); return NOW; } });
  const business = new ButlerBusiness({ role, roomState: room, view: () => ({ records }), readAudit: audit });
  const expected = { selectionRevision: 1, runnerRef: runner.runnerRef };
  return { directory, person, role, actor, room, records, audit, business, expected,
    bind: () => business.bind(records[0], { selectionRevision: role.current().selectionRevision, runnerRef: runner.runnerRef }),
    privateReads: () => privateReads };
}
const query = { kind: 'queue', spaceId: 'shared', limit: 20 };

test('each successful business page has a durable metadata receipt before return, with no task, reply, name or cursor', t => {
  const f = fixture(t), cap = f.bind(), page = cap.invoke('readBusiness', query);
  assert.equal(page.records[0].text, BODY); assert.equal(f.privateReads(), 0);
  const audit = f.audit.read(f.person);
  assert.equal(audit.records.length, 1, 'The page must have a durable metadata record before it is returned');
  const row = audit.records[0];
  assert.equal(row.actor.sessionId, f.actor.id); assert.equal(row.actor.nativeId, f.actor.nativeId);
  assert.equal(row.actor.selectionRevision, 1); assert.equal(row.time, NOW);
  assert.deepEqual(row.query, { kind: 'queue', spaceId: 'shared', limit: 20 });
  assert.deepEqual(row.result, { count: 1, recordRefs: ['naw:space:shared/item:synthetic-item'], scanned: 1, truncated: false });
  const raw = fs.readFileSync(path.join(f.directory, 'butler-business-reads.jsonl'), 'utf8');
  assert.equal(raw.includes(BODY), false); assert.equal(raw.includes(f.room.value.name), false);
  for (const field of ['text', 'reply', 'name', 'cursor', 'question', 'reason', 'headers', 'env'])
    assert.equal(Object.hasOwn(row.query, field) || Object.hasOwn(row.result, field), false);
  assert.equal(Object.hasOwn(page, 'audit'), false); assert.equal(Object.hasOwn(page, 'actor'), false);
  assert.equal(cap.catalog().methods[0].maxPagesPerUtcDay, 64);
});

test('unknown tools, ordinary consent and revoked identity return no data and create no read record', t => {
  const f = fixture(t), cap = f.bind();
  assert.throws(() => cap.invoke('nativeHistory', { approved: true, sessionId: f.actor.id }), { code: 'ERR_BUTLER_BUSINESS_METHOD' });
  assert.throws(() => cap.invoke('readBusiness', { ...query, approved: true }), { code: 'ERR_BUTLER_BUSINESS_QUERY' });
  f.role.revoke(f.person, 1);
  assert.throws(() => cap.invoke('readBusiness', query), { code: 'ERR_BUTLER_UNAUTHORIZED' });
  assert.equal(fs.existsSync(path.join(f.directory, 'butler-business-reads.jsonl')), false);
  assert.equal(f.privateReads(), 0);
});

test('audit write failure withholds the business body and cannot expose a raw storage error', t => {
  const f = fixture(t), cap = f.bind();
  t.mock.method(fs, 'fsyncSync', () => { throw Error('Synthetic private storage detail'); });
  assert.throws(() => cap.invoke('readBusiness', query), error =>
    error.code === 'ERR_BUTLER_BUSINESS_AUDIT' && error.message === 'ERR_BUTLER_BUSINESS_AUDIT');
  assert.equal(f.privateReads(), 0);
});

test('a role revoked while the receipt is recorded cannot receive the prepared page', t => {
  let revoked = false;
  const f = fixture(t, ({ role, person }) => { if (!revoked) { revoked = true; role.revoke(person, 1); } });
  const cap = f.bind();
  assert.throws(() => cap.invoke('readBusiness', query), { code: 'ERR_BUTLER_UNAUTHORIZED' });
  // This is a preparation receipt, never a claim that the model received data.
  assert.equal(f.audit.read(f.person).records.length, 1);
});

test('a non-synchronous or missing audit receipt cannot approve a page', t => {
  for (const returned of [undefined, true, Promise.resolve({ sequence: 1, pageOfDay: 1 })]) {
    const f = fixture(t), cap = f.bind();
    const method = t.mock.method(f.audit, 'recordPage', () => returned);
    assert.throws(() => cap.invoke('readBusiness', query), { code: 'ERR_BUTLER_BUSINESS_AUDIT' });
    method.mock.restore();
  }
});

test('64 pages exhaust the same UTC-day allowance across rebind, role replacement and audit reconstruction', t => {
  const f = fixture(t), cap = f.bind();
  for (let index = 0; index < 64; index++) assert.equal(cap.invoke('readBusiness', query).records.length, 1);
  assert.throws(() => f.bind().invoke('readBusiness', query), { code: 'ERR_BUTLER_BUSINESS_READ_LIMIT' });
  const actor = { ...f.actor, id: 'replacement-instance', nativeId: 'replacement-native' };
  f.role.set(f.person, { identity: { sessionId: actor.id, nativeId: actor.nativeId }, runner }, 1); f.records[0] = actor;
  assert.throws(() => f.bind().invoke('readBusiness', query), { code: 'ERR_BUTLER_BUSINESS_READ_LIMIT' });
  const reopened = new ButlerBusiness({ role: f.role, roomState: f.room, view: () => ({ records: f.records }),
    readAudit: new ButlerReadAudit(f.directory, { now: () => NOW }) });
  assert.throws(() => reopened.bind(actor, { selectionRevision: 2, runnerRef: runner.runnerRef }).invoke('readBusiness', query),
    { code: 'ERR_BUTLER_BUSINESS_READ_LIMIT' });
  const first = f.audit.read(f.person), last = f.audit.read(f.person, { afterSequence: first.nextAfterSequence });
  assert.equal(first.records.length + last.records.length, 64); assert.equal(last.throughSequence, 64);
});


test('in-process proxy queries are refused before traps or record preparation', t => {
  const f = fixture(t), cap = f.bind(); let traps = 0;
  const input = new Proxy(query, {
    get(target, key) { traps++; return Reflect.get(target, key); },
    getPrototypeOf(target) { traps++; return Reflect.getPrototypeOf(target); },
    ownKeys(target) { traps++; return Reflect.ownKeys(target); },
  });
  assert.throws(() => cap.invoke('readBusiness', input), { code: 'ERR_BUTLER_BUSINESS_QUERY' });
  assert.equal(traps, 0);
  assert.equal(fs.existsSync(path.join(f.directory, 'butler-business-reads.jsonl')), false);
});
