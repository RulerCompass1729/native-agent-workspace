// The read log as the person sees it, over records the product's own read log module wrote and read back.
// Synthetic identities and space ids; nothing is started and no model is called.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { readsView, tailRequest, olderRequest, PAGES_PER_DAY, RECORDS_PER_PAGE, NEAR_LEFT, PAGE, KINDS } = require('../butler-reads-view.js');
const { ButlerReadAudit, MAX_PAGES_PER_UTC_DAY } = require('../butler-read-audit.cjs');

const NOW = Date.UTC(2026, 10, 11, 9, 30), DAY = 24 * 3600 * 1000, MINUTE = 60 * 1000, MIDNIGHT = Date.UTC(2026, 10, 11);
const SPACES = { a: '11111111-1111-4111-8111-111111111111', b: '22222222-2222-4222-8222-222222222222', gone: '33333333-3333-4333-8333-333333333333' };
const names = id => ({ shared: 'Default', [SPACES.a]: 'Release', [SPACES.b]: 'Parser' })[id];
const pacific = () => -480, beijing = () => 480;
const person = Object.freeze({});
function log(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-butler-reads-view-')); fs.chmodSync(dir, 0o700); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = NOW; const audit = new ButlerReadAudit(dir, { authorizePerson: actor => actor === person, now: () => clock });
  const page = (at, kind, { spaceId = null, count = 1, more = false, archived, revision = 3 } = {}) => { clock = at;
    return audit.recordPage({ actor: { sessionId: 'butler-session-synthetic', nativeId: 'butler-native-synthetic', selectionRevision: revision, runnerRef: 'butler-runner-synthetic' },
      query: { kind, spaceId: kind === 'spaces' ? null : spaceId, limit: 50, ...(kind === 'spaces' && archived !== undefined ? { includeArchived: archived } : {}), ...(kind === 'deliveries' ? { fromTime: at - DAY, throughTime: at } : {}) },
      result: { count, recordRefs: Array.from({ length: count }, (_, index) => kind === 'spaces' ? `naw:space:${index ? SPACES.a : 'shared'}` : `naw:space:${spaceId}/${kind === 'queue' ? 'item' : 'event'}:synthetic-${index}`), scanned: count + (more ? 5 : 0), truncated: more } }); };
  const fill = (start, pages, options = {}) => { for (let index = 0; index < pages; index++) page(start + index * (options.step || 7 * MINUTE), index % 2 ? 'queue' : 'spaces', { spaceId: SPACES.a, ...options }); };
  const all = () => { const records = []; let after = 0, through = 0;
    for (;;) { const result = audit.read(person, { afterSequence: after, limit: 50 }); records.push(...result.records); through = result.throughSequence; if (!result.truncated) break; after = result.nextAfterSequence; }
    return { records, through }; };
  return { audit, page, fill, all, dir };
}

test('the view shows the core\'s own limits', () => {
  assert.equal(PAGES_PER_DAY, MAX_PAGES_PER_UTC_DAY);
  const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
  // The most records one page can hold, and the most a person's read of the log may ask for at once.
  assert.equal(Number(read('butler-read-audit.cjs').match(/const MAX_LIMIT = (\d+),/)[1]), RECORDS_PER_PAGE);
  // The reminder line is the shared one the person set (0.5 GiB), not a number of this page's own.
  assert.equal(require('../record-history.cjs').REMIND_TOTAL_BYTES, 512 * 1024 * 1024);
  assert.ok(read('main.cjs').includes('value.limit > ' + PAGE + ')'), 'The main process accepts a page of this size and no larger');
  assert.deepEqual([...KINDS], ['spaces', 'queue', 'deliveries']); assert.ok(NEAR_LEFT > 0 && NEAR_LEFT < PAGES_PER_DAY);
});

test('nothing read yet: no rows, the whole allowance left, and the counting day named in local time', t => {
  const { records, through } = log(t).all();
  assert.deepEqual(readsView({ records, through, now: NOW, spaceNames: names, zone: pacific }), { today: { day: '2026-11-11', pages: 0, left: 64, limit: 64, level: 'ok', inGap: false, from: '11-10 16:00', resets: '11-11 16:00' },
    days: [], gaps: [], total: 0, shown: 0, newest: true, reached: true, unreadable: 0, storage: null, hasOlder: false });
  assert.deepEqual(readsView({ records, through, now: NOW, zone: beijing }).today, { day: '2026-11-11', pages: 0, left: 64, limit: 64, level: 'ok', inGap: false, from: '11-11 08:00', resets: '11-12 08:00' });
});

test('each record is one row of what the log holds, newest first, with nothing else from it', t => {
  const l = log(t), morning = NOW - 2 * 3600 * 1000;
  l.page(morning, 'spaces', { count: 2, archived: true }); l.page(morning + 2 * MINUTE, 'queue', { spaceId: SPACES.a, count: 12 }); l.page(morning + 5 * MINUTE, 'queue', { spaceId: SPACES.b, count: 20, more: true });
  l.page(morning + 9 * MINUTE, 'deliveries', { spaceId: SPACES.a, count: 4 }); l.page(morning + 31 * MINUTE, 'queue', { spaceId: SPACES.gone, count: 1, revision: 4 }); l.page(morning + 80 * MINUTE, 'queue', { spaceId: 'shared', count: 0, revision: 4 });
  const { records, through } = l.all(), view = readsView({ records, through, now: NOW, spaceNames: names, zone: pacific });
  assert.deepEqual(view.today, { day: '2026-11-11', pages: 6, left: 58, limit: 64, level: 'ok', inGap: false, from: '11-10 16:00', resets: '11-11 16:00' });
  assert.deepEqual([view.total, view.shown, view.newest, view.unreadable, view.hasOlder, view.days.length], [6, 6, true, 0, false, 1]);
  assert.deepEqual({ ...view.days[0], rows: undefined }, { day: '2026-11-11', from: '11-10 16:00', through: '11-11 16:00', pages: 6, whole: true, rows: undefined });
  assert.deepEqual(view.days[0].rows, [
    { sequence: 6, day: '2026-11-11', time: '11-11 00:50', pageOfDay: 6, kind: 'queue', archived: false, space: { id: 'shared', short: 'shared', name: 'Default' }, window: null, count: 0, more: false, revision: 4 },
    { sequence: 5, day: '2026-11-11', time: '11-11 00:01', pageOfDay: 5, kind: 'queue', archived: false, space: { id: SPACES.gone, short: '33333333…', name: null }, window: null, count: 1, more: false, revision: 4 },
    { sequence: 4, day: '2026-11-11', time: '11-10 23:39', pageOfDay: 4, kind: 'deliveries', archived: false, space: { id: SPACES.a, short: '11111111…', name: 'Release' }, window: { from: '11-09 23:39', through: '11-10 23:39' }, count: 4, more: false, revision: 3 },
    { sequence: 3, day: '2026-11-11', time: '11-10 23:35', pageOfDay: 3, kind: 'queue', archived: false, space: { id: SPACES.b, short: '22222222…', name: 'Parser' }, window: null, count: 20, more: true, revision: 3 },
    { sequence: 2, day: '2026-11-11', time: '11-10 23:32', pageOfDay: 2, kind: 'queue', archived: false, space: { id: SPACES.a, short: '11111111…', name: 'Release' }, window: null, count: 12, more: false, revision: 3 },
    { sequence: 1, day: '2026-11-11', time: '11-10 23:30', pageOfDay: 1, kind: 'spaces', archived: true, space: null, window: null, count: 2, more: false, revision: 3 }]);
  // The session, the native identity, the runner and the record references stay out of what is drawn.
  assert.equal(/butler-session-synthetic|butler-native-synthetic|butler-runner-synthetic|synthetic-\d|recordRefs|scanned/.test(JSON.stringify(view)), false);
  // The order records arrive in does not matter, a record given twice is one row, and names are only what the window gives.
  const shuffled = readsView({ records: [...records].reverse().concat(records.slice(0, 2)), through, now: NOW, spaceNames: names, zone: pacific });
  assert.deepEqual(shuffled, view);
  for (const spaceNames of [undefined, null, () => undefined, () => '', () => 7, 'names']) assert.deepEqual(readsView({ records, through, now: NOW, spaceNames, zone: pacific }).days[0].rows.map(row => row.space && row.space.name), [null, null, null, null, null, null]);
  // Another zone moves every time shown, and the span of the same counting day.
  const east = readsView({ records, through, now: NOW, spaceNames: names, zone: beijing });
  assert.deepEqual([east.days[0].from, east.days[0].through, east.days[0].rows[0].time, east.days[0].rows[2].window], ['11-11 08:00', '11-12 08:00', '11-11 16:50', { from: '11-10 15:39', through: '11-11 15:39' }]);
});

test('days are the core\'s UTC days, each with its own page count, and today\'s count is the core\'s running count', t => {
  const l = log(t);
  l.fill(MIDNIGHT - 2 * DAY + 3600 * 1000, 20, { revision: 2 }); l.fill(MIDNIGHT - DAY + 600 * 1000, 64, { revision: 2, step: 20 * MINUTE }); l.fill(MIDNIGHT + 1800 * 1000, 12, { step: 30 * MINUTE });
  const { records, through } = l.all(); assert.equal(through, 96);
  const view = readsView({ records, through, now: NOW, zone: pacific });
  assert.deepEqual(view.days.map(day => [day.day, day.from, day.through, day.pages, day.rows.length]), [['2026-11-11', '11-10 16:00', '11-11 16:00', 12, 12], ['2026-11-10', '11-09 16:00', '11-10 16:00', 64, 64], ['2026-11-09', '11-08 16:00', '11-09 16:00', 20, 20]]);
  assert.deepEqual([view.today.pages, view.today.left, view.today.level, view.hasOlder], [12, 52, 'ok', false]);
  // The newest fifty only: the oldest day on screen still has its full count, and there is more to ask for.
  const tail = readsView({ records: records.slice(-50), through, now: NOW, zone: pacific });
  assert.deepEqual(tail.days.map(day => [day.day, day.pages, day.rows.length]), [['2026-11-11', 12, 12], ['2026-11-10', 64, 38]]); assert.deepEqual([tail.shown, tail.total, tail.hasOlder, tail.today.pages], [50, 96, true, 12]);
  // A new UTC day with nothing read yet starts from zero, with yesterday still listed.
  const next = readsView({ records, through, now: MIDNIGHT + DAY + 3600 * 1000, zone: pacific });
  assert.deepEqual([next.today.day, next.today.pages, next.today.left, next.today.from, next.today.resets, next.days[0].day], ['2026-11-12', 0, 64, '11-11 16:00', '11-12 16:00', '2026-11-11']);
  // Without the newest record on screen today's count is not known, and is not guessed from an older one.
  for (const partial of [records.slice(0, 90), records.slice(10, 40), []]) { const part = readsView({ records: partial, through, now: NOW, zone: pacific }); assert.deepEqual([part.today.pages, part.today.level, part.newest, part.reached], [null, 'unknown', false, false]); }
  for (const total of [undefined, null, -1, '96', 1.5]) assert.deepEqual([readsView({ records, through: total, now: NOW, zone: pacific }).today.pages, readsView({ records, through: total, now: NOW, zone: pacific }).total], [null, null]);
});

test('close to the day\'s allowance and at it, where the core itself refuses the next page', t => {
  const near = log(t); near.fill(MIDNIGHT + MINUTE, PAGES_PER_DAY - NEAR_LEFT, { step: 8 * MINUTE });
  assert.deepEqual((({ pages, left, level }) => [pages, left, level])(readsView({ ...near.all(), now: NOW }).today), [56, 8, 'near']);
  const before = log(t); before.fill(MIDNIGHT + MINUTE, PAGES_PER_DAY - NEAR_LEFT - 1, { step: 8 * MINUTE });
  assert.deepEqual((({ pages, left, level }) => [pages, left, level])(readsView({ ...before.all(), now: NOW }).today), [55, 9, 'ok']);
  const full = log(t); full.fill(MIDNIGHT + MINUTE, PAGES_PER_DAY, { step: 8 * MINUTE });
  assert.deepEqual((({ pages, left, level }) => [pages, left, level])(readsView({ ...full.all(), now: NOW }).today), [64, 0, 'full']);
  assert.throws(() => full.page(NOW - MINUTE, 'spaces'), { code: 'ERR_BUTLER_READ_LIMIT' }); assert.equal(full.all().through, 64, 'A refused page leaves no record');
});

test('what the dialog says about an unreadable log is true of the core', t => {
  // "If reading again still fails … once it is repaired, NAW has to be reopened": a log found damaged stays
  // unreadable for the object that found it, even after the file is put back; a new object reads it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-butler-reads-damaged-')); fs.chmodSync(dir, 0o700); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const make = () => new ButlerReadAudit(dir, { authorizePerson: actor => actor === person, now: () => NOW }), running = make(), file = path.join(dir, 'history', 'butler-reads', '000000001-2026-11-11.jsonl');
  running.recordPage({ actor: { sessionId: 'butler-session-synthetic', nativeId: 'butler-native-synthetic', selectionRevision: 1, runnerRef: 'butler-runner-synthetic' }, query: { kind: 'spaces', spaceId: null, limit: 50 }, result: { count: 0, recordRefs: [], scanned: 0, truncated: false } });
  assert.equal(running.read(person, { afterSequence: 0, limit: 50 }).throughSequence, 1);
  const kept = fs.readFileSync(file); fs.appendFileSync(file, 'not a record\n');
  assert.throws(() => running.read(person, { afterSequence: 0, limit: 50 }), { code: 'ERR_BUTLER_READ_AUDIT_STATE' });
  fs.writeFileSync(file, kept, { mode: 0o600 });
  assert.throws(() => running.read(person, { afterSequence: 0, limit: 50 }), { code: 'ERR_BUTLER_READ_AUDIT_STATE' }, 'Reading again does not help while the app keeps running');
  assert.throws(() => running.recordPage({ actor: { sessionId: 'butler-session-synthetic', nativeId: 'butler-native-synthetic', selectionRevision: 1, runnerRef: 'butler-runner-synthetic' }, query: { kind: 'spaces', spaceId: null, limit: 50 }, result: { count: 0, recordRefs: [], scanned: 0, truncated: false } }),
    { code: 'ERR_BUTLER_READ_AUDIT_STATE' }, 'A page that cannot be logged is not released');
  assert.equal(make().read(person, { afterSequence: 0, limit: 50 }).throughSequence, 1, 'A reopened app reads the repaired log');
});

test('after going back to an older version and returning, today\'s count is the one the allowance keeps', t => {
  // This version logs 3 pages; an older version, gone back to, logs 60 more the same day in its own single file,
  // counted from 1; this version then takes that file in. Written here by the product's own module into a second
  // folder, whose first block is byte for byte what an older version's single file is.
  const l = log(t); l.fill(NOW - 3600 * 1000, 3, { step: MINUTE });
  const older = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-butler-reads-older-')); fs.chmodSync(older, 0o700); t.after(() => fs.rmSync(older, { recursive: true, force: true }));
  let clock = NOW - 1800 * 1000; const other = new ButlerReadAudit(older, { now: () => clock });
  for (let index = 0; index < 60; index++) { clock += 1000; other.recordPage({ actor: { sessionId: 'butler-session-synthetic', nativeId: 'butler-native-synthetic', selectionRevision: 3, runnerRef: 'butler-runner-synthetic' },
    query: { kind: 'spaces', spaceId: null, limit: 50 }, result: { count: 0, recordRefs: [], scanned: 0, truncated: false } }); }
  const file = path.join(older, 'history', 'butler-reads', '000000001-2026-11-11.jsonl');
  fs.copyFileSync(file, path.join(l.dir, 'butler-business-reads.jsonl')); fs.chmodSync(path.join(l.dir, 'butler-business-reads.jsonl'), 0o600);
  const fresh = new ButlerReadAudit(l.dir, { authorizePerson: actor => actor === person, now: () => NOW }), records = [];
  let after = 0; for (;;) { const page = fresh.read(person, { afterSequence: after, limit: 50 }); records.push(...page.records); if (!page.truncated) break; after = page.nextAfterSequence; }
  const view = readsView({ records, through: 63, now: NOW, zone: pacific });
  assert.deepEqual([view.today.pages, view.today.left, view.days.length, view.days[0].pages], [63, 1, 1, 63]);
  fresh.recordPage({ actor: { sessionId: 'butler-session-synthetic', nativeId: 'butler-native-synthetic', selectionRevision: 3, runnerRef: 'butler-runner-synthetic' },
    query: { kind: 'spaces', spaceId: null, limit: 50 }, result: { count: 0, recordRefs: [], scanned: 0, truncated: false } });
  assert.throws(() => fresh.recordPage({ actor: { sessionId: 'butler-session-synthetic', nativeId: 'butler-native-synthetic', selectionRevision: 3, runnerRef: 'butler-runner-synthetic' },
    query: { kind: 'spaces', spaceId: null, limit: 50 }, result: { count: 0, recordRefs: [], scanned: 0, truncated: false } }), { code: 'ERR_BUTLER_READ_LIMIT' }, 'The one page left was the only one');
  // Gone back once more, the older version counts the day from 1 again and logs a page: the day now holds 65. Its
  // line is shown like any other, and the day is full.
  const again = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-butler-reads-older-')); fs.chmodSync(again, 0o700); t.after(() => fs.rmSync(again, { recursive: true, force: true }));
  new ButlerReadAudit(again, { now: () => NOW }).recordPage({ actor: { sessionId: 'butler-session-synthetic', nativeId: 'butler-native-synthetic', selectionRevision: 3, runnerRef: 'butler-runner-synthetic' },
    query: { kind: 'spaces', spaceId: null, limit: 50 }, result: { count: 0, recordRefs: [], scanned: 0, truncated: false } });
  fs.copyFileSync(path.join(again, 'history', 'butler-reads', '000000001-2026-11-11.jsonl'), path.join(l.dir, 'butler-business-reads.jsonl')); fs.chmodSync(path.join(l.dir, 'butler-business-reads.jsonl'), 0o600);
  const back = new ButlerReadAudit(l.dir, { authorizePerson: actor => actor === person, now: () => NOW }), all = [];
  after = 0; for (;;) { const page = back.read(person, { afterSequence: after, limit: 50 }); all.push(...page.records); if (!page.truncated) break; after = page.nextAfterSequence; }
  const full = readsView({ records: all, through: 65, now: NOW, zone: pacific });
  assert.deepEqual([full.shown, full.unreadable, full.today.pages, full.today.left, full.today.level, full.days[0].pages], [65, 0, 65, 0, 'full', 65]);
});

test('a block that cannot be read is shown in its place, once, and makes no count look whole', t => {
  const l = log(t); l.fill(NOW - 3600 * 1000, 6);
  const { records, through } = l.all(), view = (rows, gaps) => readsView({ records: rows, gaps, through, now: NOW, zone: pacific });
  const hole = (from, to, days = ['2026-11-11']) => ({ fromSequence: from, throughSequence: to, count: to - from + 1, days });
  const kept = records.filter(record => ![3, 4].includes(record.sequence));
  // Two holes that touch (one block over two pages) are one row, and the day is split around it.
  const split = view(kept, [hole(4, 4), hole(3, 3)]);
  assert.deepEqual(split.gaps.map(item => [item.from, item.through, item.count, item.first, item.last]), [[3, 4, 2, '2026-11-11', '2026-11-11']]);
  assert.deepEqual(split.days.map(day => day.rows.map(row => row.sequence)), [[6, 5], [2, 1]]);
  assert.deepEqual(split.days.map(day => day.whole), [false, false], 'A day that may go on into the hole is not said to be whole');
  assert.equal(view(kept, [hole(3, 4), hole(3, 4)]).gaps.length, 1, 'The same hole twice is shown once');
  // A deleted block next to one that cannot be read stays a row of its own.
  assert.deepEqual(view(kept, [hole(4, 4), { ...hole(3, 3), deletedAt: NOW - DAY }]).gaps.map(item => [item.from, item.through, item.deletedAt !== null]), [[4, 4, false], [3, 3, true]]);
  // The newest position in a hole: the end of the log was reached, and today's count cannot be told.
  const top = view(records.filter(record => record.sequence < 6), [hole(6, 6)]);
  assert.deepEqual([top.reached, top.newest, top.today.pages, top.today.level, top.today.inGap], [true, false, null, 'unknown', true]);
  // A hole at the bottom is the start of the log; one in the middle leaves older records to ask for.
  assert.equal(view(records.filter(record => record.sequence > 2), [hole(1, 2)]).hasOlder, false);
  assert.equal(view(records.filter(record => record.sequence > 4), [hole(3, 4)]).hasOlder, true);
  // A hole that does not add up, or lies past the end of the log, is counted as not understood and not shown.
  for (const bad of [hole(3, 2), { ...hole(3, 4), count: 3 }, hole(6, 7), { ...hole(3, 3), days: [] }, { ...hole(3, 3), days: ['today'] }, null])
    assert.deepEqual((value => [value.gaps.length, value.unreadable])(view(records, [bad])), [0, 1], JSON.stringify(bad));
});

test('a record this version does not understand is counted and left out, never guessed at', t => {
  const l = log(t); l.fill(NOW - 3600 * 1000, 4);
  const { records, through } = l.all(), good = records[0];
  const broken = [{ ...good, version: 2 }, { ...good, sequence: 0 }, { ...good, sequence: '1' }, { ...good, time: -1 }, { ...good, day: '2026-11-12' }, { ...good, day: 'today' }, { ...good, pageOfDay: 0 },
    { ...good, query: { ...good.query, kind: 'notes' } }, { ...good, query: null }, { ...records[1], query: { ...records[1].query, spaceId: '' } }, { ...records[1], query: { ...records[1].query, spaceId: 7 } },
    { ...good, query: { kind: 'deliveries', spaceId: 'shared', limit: 50 } }, { ...good, query: { kind: 'deliveries', spaceId: 'shared', limit: 50, fromTime: 9, throughTime: 3 } },
    { ...good, result: { ...good.result, count: -1 } }, { ...good, result: { ...good.result, truncated: 'no' } }, { ...good, result: null }, { ...good, actor: null }, { ...good, actor: { ...good.actor, selectionRevision: '3' } }, null, 'record', 7];
  for (const record of broken) { const view = readsView({ records: [record], through: 1, now: NOW }); assert.deepEqual([view.shown, view.unreadable, view.days.length, view.today.pages], [0, 1, 0, null], JSON.stringify(record)); }
  const mixed = readsView({ records: [...records.slice(0, 3), { ...records[3], version: 2 }], through, now: NOW });
  assert.deepEqual([mixed.shown, mixed.unreadable, mixed.today.pages, mixed.newest, mixed.reached], [3, 1, null, false, true], 'With the newest record not understood, today\'s count is unknown too, but that record was reached');
  assert.equal(readsView({ records: records.slice(0, 3), through, now: NOW }).reached, false, 'Not on hand at all is a different thing');
  assert.deepEqual([readsView({ records: 'nothing', through: 0, now: NOW }).shown, readsView({ through: 0, now: NOW }).shown], [0, 0]);
});

test('a time the log accepts but no calendar can show is never thrown on and never shown as another time', t => {
  // The core accepts any safe non-negative time for a delivery lookup's window, far beyond the last real date.
  const l = log(t), LAST = 8.64e15; l.page(NOW - MINUTE, 'queue', { spaceId: SPACES.a });
  const { records, through } = l.all(), good = records[0];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-butler-reads-extreme-')); fs.chmodSync(dir, 0o700); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const audit = new ButlerReadAudit(dir, { authorizePerson: actor => actor === person, now: () => NOW });
  audit.recordPage({ actor: good.actor, query: { kind: 'deliveries', spaceId: SPACES.a, limit: 50, fromTime: LAST - DAY, throughTime: LAST }, result: { count: 0, recordRefs: [], scanned: 0, truncated: false } });
  const stored = audit.read(person, { afterSequence: 0, limit: 50 }).records; assert.equal(stored.length, 1, 'The core stores such a record');
  for (const zone of [beijing, pacific, () => 0, () => 840, () => -720]) {
    const view = readsView({ records: [...records, { ...stored[0], sequence: 2, pageOfDay: 2 }], through: 2, now: NOW, zone });
    assert.deepEqual([view.shown, view.unreadable, view.days[0].rows.length], [1, 1, 1], 'The one real row is shown, the other is counted as not understood');
  }
  // Year 10000 and later would print with a sign and more digits: not shown as a wrong time either.
  const far = { ...good, query: { kind: 'deliveries', spaceId: SPACES.a, limit: 50, fromTime: Date.UTC(9999, 11, 31, 23), throughTime: Date.UTC(9999, 11, 31, 23, 30) } };
  assert.equal(readsView({ records: [far], through: 1, now: NOW, zone: pacific }).shown, 1); assert.equal(readsView({ records: [far], through: 1, now: NOW, zone: beijing }).unreadable, 1);
  for (const time of [LAST + 1, Number.MAX_SAFE_INTEGER, Date.UTC(10000, 0, 1)]) assert.deepEqual((v => [v.shown, v.unreadable])(readsView({ records: [{ ...good, time }], through: 1, now: NOW, zone: pacific })), [0, 1]);
  // A zone that cannot be asked, or answers nonsense, shows no time rather than a wrong one; a name lookup that fails gives no name.
  for (const zone of [() => { throw Error('no zone'); }, () => NaN, () => 'east', () => Infinity]) assert.deepEqual((v => [v.shown, v.unreadable])(readsView({ records, through, now: NOW, zone })), [0, 1]);
  assert.equal(readsView({ records, through, now: NOW, zone: pacific, spaceNames: () => { throw Error('no names'); } }).days[0].rows[0].space.name, null);
});

test('the local span of a counting day follows the zone at each moment, across a daylight-saving change', () => {
  // 2026-11-01 is the UTC day on which US Pacific time goes from UTC-7 to UTC-8 (at 09:00 UTC).
  const change = Date.UTC(2026, 10, 1, 9), zone = time => time < change ? -420 : -480, at = Date.UTC(2026, 10, 1, 12);
  const record = { version: 1, sequence: 1, time: Date.UTC(2026, 10, 1, 8, 30), day: '2026-11-01', pageOfDay: 1, actor: { selectionRevision: 1 }, query: { kind: 'spaces', spaceId: null, limit: 50 }, result: { count: 0, truncated: false } };
  const later = { ...record, sequence: 2, time: Date.UTC(2026, 10, 1, 9, 30), pageOfDay: 2 };
  const view = readsView({ records: [record, later], through: 2, now: at, zone });
  assert.deepEqual([view.days[0].from, view.days[0].through, view.today.from, view.today.resets], ['10-31 17:00', '11-01 16:00', '10-31 17:00', '11-01 16:00']);
  assert.deepEqual(view.days[0].rows.map(row => row.time), ['11-01 01:30', '11-01 01:30'], 'An hour apart in fact, the same clock time on the day the clocks go back');
});

test('a day\'s page count is its whole count only when the day\'s last record is on screen', t => {
  // Three UTC days: two pages, three pages, two pages, written and read back by the real module.
  const l = log(t);
  for (const [day, pages] of [[2, 2], [1, 3], [0, 2]]) for (let page = 0; page < pages; page++) l.page(NOW - day * DAY - (pages - page) * MINUTE, 'spaces');
  const all = l.audit.read(person, { afterSequence: 0, limit: 50 }).records; assert.equal(all.length, 7);
  const view = records => readsView({ records, through: 7, now: NOW, zone: pacific }).days.map(day => [day.pages, day.whole]);
  // Everything on screen: every day's number is its whole count.
  assert.deepEqual(view(all), [[2, true], [3, true], [2, true]]);
  // The newest record missing (not reached, or not understood): the newest day's number is a lower bound only.
  assert.deepEqual(view(all.slice(0, 6)), [[1, false], [3, true], [2, true]]);
  assert.deepEqual(view(all.map(record => record.sequence === 7 ? { ...record, version: 2 } : record)), [[1, false], [3, true], [2, true]]);
  // An earlier day's last record missing: that day's number is a lower bound; the days around it are not affected.
  assert.deepEqual(view(all.filter(record => record.sequence !== 5)), [[2, true], [2, false], [2, true]]);
  // A day's first record missing: which day the missing record belongs to cannot be told, so the day before it is not called whole.
  assert.deepEqual(view(all.filter(record => record.sequence !== 3)), [[2, true], [3, true], [2, true]].map(([pages, whole], index) => index === 2 ? [pages, false] : [pages, whole]));
  // A record missing in the middle of a day does not change the day's last record.
  assert.deepEqual(view(all.filter(record => record.sequence !== 4)), [[2, true], [3, true], [2, true]]);
  // The clock went back across UTC midnight: the core goes on counting the earlier day, which then shows as two groups.
  // The earlier of them is not that day's whole count, although the record after it is on screen.
  const back = log(t); for (const at of [NOW - DAY - 2 * MINUTE, NOW - DAY - MINUTE, NOW - MINUTE, NOW - DAY]) back.page(at, 'spaces');
  const again = back.audit.read(person, { afterSequence: 0, limit: 50 }).records;
  assert.deepEqual(again.map(record => [record.day, record.pageOfDay]), [['2026-11-10', 1], ['2026-11-10', 2], ['2026-11-11', 1], ['2026-11-10', 3]], 'Written and read back by the real module');
  assert.deepEqual(readsView({ records: again, through: 4, now: NOW, zone: pacific }).days.map(day => [day.day, day.pages, day.whole]), [['2026-11-10', 3, true], ['2026-11-11', 1, true], ['2026-11-10', 2, false]]);
});

test('how large the log is comes from the core\'s own report and its own reminder line, or is not said at all', t => {
  const l = log(t); l.page(NOW - MINUTE, 'spaces');
  const answer = l.audit.read(person, { afterSequence: 0, limit: 50 });
  // The report as the core gives it with every read of the log: every block is kept, so there is no cap, only the line.
  assert.deepEqual(Object.keys(answer.storage).sort(), ['blocks', 'remindBytes', 'unreadableBlocks', 'usedBytes', 'warning']);
  assert.deepEqual([answer.storage.remindBytes, answer.storage.warning, answer.storage.blocks, answer.storage.unreadableBlocks, answer.storage.usedBytes > 0], [512 * 1024 * 1024, false, 1, 0, true]);
  const view = value => readsView({ records: answer.records, through: answer.throughSequence, now: NOW, zone: pacific, storage: value }).storage;
  assert.deepEqual(view(answer.storage), { usedBytes: answer.storage.usedBytes, remindBytes: 512 * 1024 * 1024, over: false, blocks: 1, unreadable: 0 });
  // Over the line is the core's word: this view has no line of its own, and the core's word has to match its numbers.
  const over = { ...answer.storage, usedBytes: 513 * 1024 * 1024, blocks: 17, warning: true };
  assert.deepEqual(view(over), { usedBytes: 513 * 1024 * 1024, remindBytes: 512 * 1024 * 1024, over: true, blocks: 17, unreadable: 0 });
  assert.equal(view({ ...over, usedBytes: 512 * 1024 * 1024 }), null, 'Exactly at the line is not over it, so a report that says so does not add up');
  assert.equal(view({ ...over, warning: false }), null, 'A report whose word and numbers disagree says nothing');
  // No report, or one that does not add up, says nothing rather than something wrong.
  for (const value of [undefined, null, {}, 'over', { ...over, warning: 'true' }, { ...over, warning: 1 }, { ...over, usedBytes: -1 }, { ...over, remindBytes: 0 }, { ...over, unreadableBlocks: 18 },
    { ...over, blocks: 1.5 }, { usedBytes: 1, remindBytes: 2, warning: false }, { ...over, usedBytes: '537919488' }]) assert.equal(view(value), null);
});

test('the log pages forward only, so the newest and the earlier records are asked for by position', () => {
  assert.deepEqual([tailRequest(96), tailRequest(50), tailRequest(51), tailRequest(3)], [{ afterSequence: 46, limit: 50 }, { afterSequence: 0, limit: 50 }, { afterSequence: 1, limit: 50 }, { afterSequence: 0, limit: 50 }]);
  assert.deepEqual([olderRequest(47), olderRequest(51), olderRequest(52), olderRequest(2), olderRequest(1)], [{ afterSequence: 0, limit: 46 }, { afterSequence: 0, limit: 50 }, { afterSequence: 1, limit: 50 }, { afterSequence: 0, limit: 1 }, null]);
});

test('the renderer loads the same module as a plain script', t => {
  const browser = { self: {} }; browser.self.self = browser.self;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../butler-reads-view.js'), 'utf8'), browser, { filename: 'butler-reads-view.js' });
  const l = log(t); l.fill(NOW - 3600 * 1000, 3); const { records, through } = l.all();
  assert.deepEqual(JSON.parse(JSON.stringify(browser.self.nativeWorkspaceButlerReadsView.readsView({ records: JSON.parse(JSON.stringify(records)), through, now: NOW, zone: () => -480 }))), JSON.parse(JSON.stringify(readsView({ records, through, now: NOW, zone: pacific }))));
});
