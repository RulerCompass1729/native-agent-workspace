const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { ButlerLedger } = require('../butler-ledger.cjs');
const { uiError } = require('../ui-errors.cjs');
const { BackgroundControl } = require('../background-control.cjs');

// What the butler reads to report only what is new (the person, 2026-11-09: 「我希望 NAW 自己可以监控自己的 agent，并通过
// 自带的 agent（aka 大管家）来进行汇报」): the events NAW records without a model, after the position the last read gave.
// The manager's conditions, 2026-11-13 00:39:50: an old position still reads on, with nothing lost or repeated, after NAW
// restarts or the butler session changes, and one that does not match is refused so the reader starts over; a session that
// is not the designated butler is refused; a position already at the newest event returns nothing and stays where it is.
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-steward-events-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let now = 1000;
  const open = () => new ButlerLedger(directory, { now: () => now++ });
  return { directory, file: path.join(directory, 'butler-ledger.jsonl'), open };
}
const failure = n => ({ eventId: `butler-source:${n}`, sourceRef: `queue-outcome:space-1:${n}`, kind: 'failure',
  payload: { spaceId: 'space-1', itemId: `item-${n}`, reason: `Synthetic failure ${n}` } });
const sequences = read => read.events.map(event => event.sequence);
const origin = read => read.through.split(':')[0];

test('reads oldest first from the start, and from a position only what came after it', t => {
  const f = fixture(t), ledger = f.open();
  assert.deepEqual(ledger.eventsAfter(null), { events: [], through: null, more: false }, 'nothing recorded yet');
  for (const n of [1, 2, 3]) ledger.ingest(failure(n));
  const first = ledger.eventsAfter(null);
  assert.deepEqual(sequences(first), [1, 2, 3]);
  assert.deepEqual(first.events[0], { sequence: 1, time: 1000, kind: 'failure', payload: failure(1).payload });
  assert.match(first.through, /^[0-9a-f]{16}:3$/u);
  assert.equal(first.more, false);
  ledger.ingest(failure(4));
  const second = ledger.eventsAfter(first.through);
  assert.deepEqual(sequences(second), [4], 'only the one recorded since');
  assert.equal(second.through, `${origin(first)}:4`);
});

test('a position already at the newest event returns nothing and stays the same', t => {
  const f = fixture(t), ledger = f.open();
  for (const n of [1, 2]) ledger.ingest(failure(n));
  const { through } = ledger.eventsAfter(null);
  assert.deepEqual(ledger.eventsAfter(through), { events: [], through, more: false });
  assert.deepEqual(ledger.eventsAfter(through), { events: [], through, more: false }, 'and again');
});

test('a long backlog comes in pieces with nothing lost or repeated', t => {
  const f = fixture(t), ledger = f.open();
  for (let n = 1; n <= 7; n++) ledger.ingest(failure(n));
  const seen = [];
  let position = null, more = true;
  while (more) {
    const read = ledger.eventsAfter(position, 3);
    seen.push(...sequences(read)); position = read.through; more = read.more;
    assert.ok(read.events.length <= 3);
  }
  assert.deepEqual(seen, [1, 2, 3, 4, 5, 6, 7]);
});

// A provider limits how much one tool answer may carry; an answer over it fails (the reader stays at the same position
// for good) or loses events from its middle. Long events come a few at a time, and one always comes.
test('long events come a few at a time under a size bound, and one that is longer than the bound still comes', t => {
  const f = fixture(t), ledger = f.open(), size = read => Buffer.byteLength(JSON.stringify(read.events));
  const long = (n, length) => ({ ...failure(n), payload: { ...failure(n).payload, text: '合'.repeat(length) } });
  for (let n = 1; n <= 6; n++) ledger.ingest(long(n, 1000));
  ledger.ingest(long(7, 6000));
  ledger.ingest(failure(8));
  const reads = [];
  let position = null;
  do { reads.push(ledger.eventsAfter(position)); position = reads.at(-1).through; } while (reads.at(-1).more && reads.length < 20);
  assert.deepEqual(reads.flatMap(sequences), [1, 2, 3, 4, 5, 6, 7, 8], 'nothing lost or repeated');
  assert.ok(reads.length >= 3 && reads.length < 20, `${reads.length} reads`);
  assert.ok(reads[0].events.length > 1, 'several fit in one answer');
  for (const read of reads) assert.ok(read.events.length === 1 || size(read) <= 8 * 1024, `${size(read)} bytes`);
  const alone = reads.find(read => sequences(read).includes(7));
  assert.ok(size(alone) > 8 * 1024 && sequences(alone)[0] === 7, 'the longest one comes first in its own answer');
});

test('after NAW restarts, the old position reads on; reading takes nothing from the separate butler', t => {
  const f = fixture(t), ledger = f.open();
  for (const n of [1, 2]) ledger.ingest(failure(n));
  const pending = JSON.stringify(ledger.pendingEvents()), bytes = fs.readFileSync(f.file);
  const { through } = ledger.eventsAfter(null);
  assert.equal(JSON.stringify(ledger.pendingEvents()), pending, 'the separate butler still has every event to take');
  assert.ok(fs.readFileSync(f.file).equals(bytes), 'a read writes nothing');
  // A new process reads the same file: the position names the same record, so it reads on from there.
  const reopened = f.open();
  reopened.ingest(failure(3));
  const next = reopened.eventsAfter(through);
  assert.deepEqual(sequences(next), [3]);
  assert.equal(origin(next), through.split(':')[0]);
  // The position is not the session's: whichever session is the butler next passes it and reads on the same way.
  assert.deepEqual(sequences(f.open().eventsAfter(through)), [3]);
});

test('a space whose queue ran empty is read as its own event', t => {
  const f = fixture(t), ledger = f.open();
  ledger.observeSource('queue-vacancy:space-1', true, { spaceId: 'space-1', spaceName: 'Synthetic space' });
  const read = ledger.eventsAfter(null);
  assert.deepEqual(read.events.map(event => [event.kind, event.payload.spaceId]), [['queue-empty', 'space-1']]);
});

test('a position this record did not give is refused, so the reader starts again from the beginning', t => {
  const f = fixture(t), ledger = f.open();
  for (const n of [1, 2]) ledger.ingest(failure(n));
  const { through } = ledger.eventsAfter(null), stale = { code: 'BUTLER_POSITION_STALE' };
  assert.throws(() => ledger.eventsAfter(`${origin({ through })}:3`), stale, 'past the newest event');
  for (const bad of ['', '3', 'zz:1', `${origin({ through })}:01`, `${origin({ through })}:-1`, 2, {}]) {
    assert.throws(() => ledger.eventsAfter(bad), stale, `malformed ${JSON.stringify(bad)}`);
  }
  // The record is replaced (a new profile, a removed file): the same numbers mean other events now, so the old position
  // is refused rather than silently skipping or repeating them.
  fs.rmSync(f.file);
  const replaced = f.open();
  for (const n of [5, 6, 7]) replaced.ingest(failure(n));
  assert.throws(() => replaced.eventsAfter(through), stale);
  assert.deepEqual(sequences(replaced.eventsAfter(null)), [1, 2, 3], 'from the start it reads everything');
});

// The actual handler from main.cjs, with the butler check and the record stubbed.
function handler({ butler, ledger }) {
  const source = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8');
  const start = source.indexOf("  register('stewardEvents', async (c, position = null) => {");
  const end = source.indexOf('  // B6: the person\'s own actions on an integration handoff', start);
  assert.ok(start > 0 && end > start);
  let registered;
  const reads = [];
  const context = vm.createContext({
    register: (name, fn) => { assert.equal(name, 'stewardEvents'); registered = fn; },
    stewardCaller: async c => (c.background && butler ? { id: 'butler', name: 'Synthetic butler' } : null),
    butlerIngress: ledger === undefined ? null : { ledger: { eventsAfter: (...args) => { reads.push(args); return ledger(...args); } } },
    uiError,
  });
  vm.runInContext(source.slice(start, end), context);
  return { call: (...args) => registered({ background: true }, ...args), person: (...args) => registered({ background: false }, ...args), reads };
}
const refusal = key => error => error?.uiMessage?.key === key;

test('only the designated butler reads; anyone else is refused before the record is read', async () => {
  const value = { events: [], through: null, more: false };
  const other = handler({ butler: false, ledger: () => value });
  await assert.rejects(other.call(null), refusal('error.steward.eventsButlerOnly'));
  assert.deepEqual(other.reads, [], 'another session reads nothing');
  const butler = handler({ butler: true, ledger: () => value });
  await assert.rejects(butler.person(null), refusal('error.steward.eventsButlerOnly'), 'not a call through NAW');
  assert.deepEqual(await butler.call('abc:1'), value);
  assert.deepEqual(butler.reads, [['abc:1']]);
  assert.deepEqual((await butler.call(), butler.reads.at(-1)), [null], 'no position reads from the start');
});

test('a position the record refuses, and a record that cannot be read, say which it is', async () => {
  const stale = handler({ butler: true, ledger: () => { throw Object.assign(Error('stale'), { code: 'BUTLER_POSITION_STALE' }); } });
  await assert.rejects(stale.call('abc:9'), refusal('error.steward.eventsPosition'));
  const broken = handler({ butler: true, ledger: () => { throw Object.assign(Error('failed'), { code: 'BUTLER_LEDGER_FAILED' }); } });
  await assert.rejects(broken.call(null), refusal('error.steward.eventsUnavailable'));
  await assert.rejects(handler({ butler: true }).call(null), refusal('error.steward.eventsUnavailable'), 'no record at all');
});

// What the butler read (queue text, deliveries, failure reasons) goes back in the same answer and is not kept in the
// durable operation log, as a conversation read is not.
test('the read comes back in the same answer and stays out of the operation log', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-steward-events-log-')); fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const secret = 'Synthetic failure reason only the butler reads';
  const value = { events: [{ sequence: 1, time: 1, kind: 'failure', payload: { spaceId: 'space-1', reason: secret } }], through: 'abc:1', more: false };
  const handlers = new Map([['stewardEvents', () => value]]);
  const controller = new BackgroundControl({ dataDir: directory, handlers, context: async actor => ({ background: true, view: { selected: actor.id, draft: '' },
    confirmationActors: () => [actor], checkActor: async () => {}, client: { close() {} }, win: { destroy() {} } }) });
  const sender = { id: 'butler', nativeId: 'native-butler', provider: 'codex', name: 'Synthetic butler' };
  const binding = { sender, identity: { nativeId: 'native-butler', sessionId: 'native-session', turnId: 'turn', callId: 'call' }, valid: () => true };
  const answer = await controller.call(binding, { action: 'invoke', operation_id: 'read-1', method: 'stewardEvents', arguments: [null] });
  assert.equal(answer.state, 'complete');
  assert.deepEqual(answer.value, value);
  const kept = fs.readdirSync(directory, { recursive: true }).map(name => path.join(directory, name)).filter(file => fs.statSync(file).isFile());
  assert.ok(kept.length > 0, 'the operation itself is recorded');
  for (const file of kept) assert.equal(fs.readFileSync(file, 'utf8').includes(secret), false, `${path.basename(file)} keeps what was read`);
});
