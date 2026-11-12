// The read log dialog over a stand-in document. The records come from the product's own read log module; the
// stand-in `butlerReview` pages over them with the real call's contract. No process, no model.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { bind, COLUMNS } = require('../renderer/butler-reads.js');
const { ButlerReadAudit } = require('../butler-read-audit.cjs');
const messages = require('../ui-messages.js'), locale = require('../ui-locale.js');
const bootstrap = fs.readFileSync(path.join(__dirname, '../dsh/bootstrap.js'), 'utf8');
const createBindings = require('node:vm').runInNewContext('(' + bootstrap.slice(bootstrap.indexOf('    function createDisplayBindings('), bootstrap.indexOf('    function mountWorkspace(')).trim() + ')');

const NOW = Date.UTC(2026, 10, 11, 9, 30), DAY = 24 * 3600 * 1000, MINUTE = 60 * 1000, MIDNIGHT = Date.UTC(2026, 10, 11);
const SPACE = '11111111-1111-4111-8111-111111111111', GONE = '33333333-3333-4333-8333-333333333333';
const person = Object.freeze({}), zh = (key, params) => locale.format('zh', key, params);
class Element {
  constructor(tag, page) { this.tag = tag; this.page = page; this.children = []; this.listeners = {}; this.attributes = {}; this.dataset = {}; this.hidden = false; this.disabled = false; this.textContent = ''; this.className = ''; this.id = ''; this.open = false; }
  append(...values) { this.children.push(...values); }
  replaceChildren(...values) { this.children = values; }
  setAttribute(key, value) { this.attributes[key] = value; }
  getAttribute(key) { return this.attributes[key] ?? null; }
  hasAttribute(key) { return Object.hasOwn(this.attributes, key); }
  removeAttribute(key) { delete this.attributes[key]; }
  get childElementCount() { return this.children.length; }
  querySelectorAll(selector) { const names = selector.split(',').map(part => part.trim().slice(1, -1)); return this.children.flatMap(child => [...(names.some(name => child.hasAttribute(name)) ? [child] : []), ...child.querySelectorAll(selector)]); }
  addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
  removeEventListener(name, callback) { this.listeners[name] = (this.listeners[name] || []).filter(value => value !== callback); }
  fire(name) { return (this.listeners[name] || []).map(callback => callback())[0]; }
  focus() { this.page.activeElement = this; }
  all() { return [this, ...this.children.flatMap(child => child.all())]; }
  // Stricter than the platform, which lets an already modal dialog through: a second call is an error here.
  showModal() { if (this.open) throw Error('InvalidStateError: the dialog is already open'); this.open = true; }
  close() { if (!this.open) return; this.open = false; this.fire('close'); }
  text() { return this.hidden ? '' : [this.textContent, ...this.children.map(child => child.text())].filter(Boolean).join(' | '); }
}
// A real log in a scratch directory, read back whole through the person's own read.
function records(t, write) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-butler-reads-')); fs.chmodSync(dir, 0o700); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = NOW; const audit = new ButlerReadAudit(dir, { authorizePerson: actor => actor === person, now: () => clock });
  const page = (at, kind, { spaceId = null, count = 1, more = false, archived, revision = 3, window = [at - DAY, at] } = {}) => { clock = at;
    audit.recordPage({ actor: { sessionId: 'butler-session-synthetic', nativeId: 'butler-native-synthetic', selectionRevision: revision, runnerRef: 'butler-runner-synthetic' },
      query: { kind, spaceId: kind === 'spaces' ? null : spaceId, limit: 50, ...(kind === 'spaces' && archived !== undefined ? { includeArchived: archived } : {}), ...(kind === 'deliveries' ? { fromTime: window[0], throughTime: window[1] } : {}) },
      result: { count, recordRefs: Array.from({ length: count }, (_, index) => kind === 'spaces' ? `naw:space:${index ? SPACE : 'shared'}` : `naw:space:${spaceId}/${kind === 'queue' ? 'item' : 'event'}:synthetic-${index}`), scanned: count + (more ? 5 : 0), truncated: more } }); };
  write(page);
  const all = []; let after = 0;
  for (;;) { const result = audit.read(person, { afterSequence: after, limit: 50 }); all.push(...result.records); if (!result.truncated) break; after = result.nextAfterSequence; }
  return all;
}
const few = t => records(t, page => { const morning = NOW - 2 * 3600 * 1000;
  page(morning, 'spaces', { count: 2, archived: true }); page(morning + 2 * MINUTE, 'queue', { spaceId: SPACE, count: 12 }); page(morning + 5 * MINUTE, 'queue', { spaceId: GONE, count: 20, more: true });
  page(morning + 9 * MINUTE, 'deliveries', { spaceId: SPACE, count: 4 }); page(morning + 80 * MINUTE, 'queue', { spaceId: 'shared', count: 0 }); });
// Twenty-five minutes apart: at most 58 pages fall into one UTC day, under the core's 64.
const many = (t, pages = 96) => records(t, page => { for (let index = 0; index < pages; index++) page(MIDNIGHT - DAY + 600 * 1000 + index * 25 * MINUTE, index % 2 ? 'queue' : 'spaces', { spaceId: SPACE }); });
const HEALTHY = () => ({ usedBytes: 4096, remindBytes: 512 * 1048576, blocks: 1, unreadableBlocks: 0, warning: false });
// `storage`: the core's report of how large the log is, given with every read; null leaves it out of the answer.
// `gaps`: positions of the log in blocks that cannot be read, as the core reports them.
function fixture(log, { fail = () => false, display, text, storage = HEALTHY, gaps = [], now = () => NOW, spaceName = id => ({ shared: '默认空间', [SPACE]: '发版准备' })[id], breakTable = () => false } = {}) {
  const page = { activeElement: null, created: [], createElement(tag) { if (tag === 'table' && breakTable()) throw Error('The page cannot build a table'); page.created.push(tag); return new Element(tag, page); } }, dialog = new Element('dialog', page), body = new Element('body', page); dialog.id = 'butler-reads-dialog'; body.append(dialog);
  const calls = [], state = { log, pending: null };
  // Anything but the one existing person-only call is a failure of this test.
  const api = new Proxy({}, { get(_, name) {
    if (name !== 'butlerReview') throw Error('The read log may only use butlerReview: ' + String(name));
    return async (action, options, ...rest) => {
      calls.push([action, options, ...rest]);
      if (state.pending) await state.pending;
      // true: the call fails. { answer }: the call returns that instead of a page. Anything else: the real paging below.
      const failure = fail(calls.length, options); if (failure === true) throw Error('/PRIVATE_IPC_PATH'); if (failure && Object.hasOwn(failure, 'answer')) return failure.answer;
      const afterSequence = options.afterSequence ?? 0, limit = options.limit ?? 50, through = state.log.length;
      // Positions in order, a gap taking its positions like lines do (the core's own paging).
      const holes = gaps.filter(item => item.throughSequence > afterSequence), found = [], held = []; let next = afterSequence, taken = 0;
      for (const record of state.log.filter(item => item.sequence > afterSequence)) {
        while (holes.length && holes[0].fromSequence < record.sequence && taken < limit) { const item = holes.shift(), from = Math.max(item.fromSequence, next + 1), to = Math.min(item.throughSequence, from + limit - taken - 1); held.push({ ...item, fromSequence: from, throughSequence: to, count: to - from + 1 }); taken += to - from + 1; next = to; }
        if (taken >= limit) break;
        if (gaps.some(item => item.fromSequence <= record.sequence && record.sequence <= item.throughSequence)) continue;
        found.push(record); taken++; next = record.sequence;
      }
      // A gap after the last line the log could read.
      while (holes.length && taken < limit) { const item = holes.shift(), from = Math.max(item.fromSequence, next + 1), to = Math.min(item.throughSequence, from + limit - taken - 1); held.push({ ...item, fromSequence: from, throughSequence: to, count: to - from + 1 }); taken += to - from + 1; next = to; }
      const nextAfterSequence = next;
      return { records: found, ...(gaps.length ? { gaps: held } : {}), throughSequence: through, nextAfterSequence, truncated: nextAfterSequence < through, ...(storage ? { storage: storage() } : {}) };
    };
  } });
  const reads = bind({ dialog, document: page, api, now, zone: () => -480, display, text, spaceName });
  const find = cls => dialog.all().filter(node => node.className.split(' ').includes(cls)), button = action => dialog.all().find(node => node.tag === 'button' && node.dataset.action === action);
  const rows = () => dialog.all().filter(node => node.tag === 'tr' && !node.className && node.children[0]?.tag === 'td').map(row => row.children.map(cell => cell.textContent));
  const notes = () => find('butler-reads-note').filter(node => !node.hidden).map(node => node.textContent);
  return { page, dialog, body, calls, state, reads, find, button, rows, notes, today: () => find('butler-reads-today')[0], full: () => find('butler-reads-storage')[0], listed: () => dialog.all().filter(node => node.className === 'quiet')[1],
    days: () => dialog.all().filter(node => node.className === 'butler-reads-day').map(row => row.children[0].textContent), requests: () => calls.map(call => call[1]) };
}

test('opening reads the newest records once and shows only what the log holds', async t => {
  const f = fixture(few(t)); await f.reads.open();
  assert.equal(f.dialog.open, true); assert.equal(f.page.activeElement, f.button('done'), 'Opening puts the focus on Done'); assert.equal(f.dialog.attributes['aria-labelledby'], 'butler-reads-dialog-title');
  assert.deepEqual(f.calls, [['reads', { afterSequence: 0, limit: 50 }]]); assert.equal(f.dialog.dataset.readsState, 'records'); assert.equal(f.dialog.dataset.readsLevel, 'ok');
  assert.equal(f.today().textContent, '从 11-10 16:00 起已读 5 页，还剩 59 页。每天最多 64 页，11-11 16:00 重新计。'); assert.equal(f.listed().textContent, '共 5 条，都在下面。');
  assert.deepEqual(f.dialog.all().filter(node => node.tag === 'th' && node.attributes.scope === 'col').map(node => node.textContent), COLUMNS.map(column => zh(`butler.reads.column.${column}`)));
  assert.deepEqual(f.days(), ['11-10 16:00 至 11-11 16:00（按 UTC 算的 2026-11-11 这一天）· 5 页']);
  assert.deepEqual(f.rows(), [['11-11 00:50', '队列', '默认空间', '0 条', '第 3 次'], ['11-10 23:39', '交付记录（11-09 23:39 至 11-10 23:39）', '发版准备', '4 条', '第 3 次'],
    ['11-10 23:35', '队列', '这个窗口不认识的空间（33333333…）', '20 条，还有没读完的', '第 3 次'], ['11-10 23:32', '队列', '发版准备', '12 条', '第 3 次'], ['11-10 23:30', '空间列表（含已归档）', '—', '2 条', '第 3 次']]);
  // The whole id of a space this window no longer has is still there to be read.
  assert.equal(f.dialog.all().find(node => node.textContent === '这个窗口不认识的空间（33333333…）').attributes.title, GONE);
  const text = f.dialog.text();
  assert.ok(text.includes(zh('butler.reads.intro', { limit: 50 }))); assert.equal(/butler-session-synthetic|butler-native-synthetic|butler-runner-synthetic|synthetic-\d|naw:space/.test(text), false, 'No session, runner or record reference is shown');
  assert.deepEqual([f.button('older').hidden, f.button('refresh').disabled, f.button('refresh').textContent], [true, false, '刷新']); assert.deepEqual(f.notes(), []);
  // Nothing but text and buttons: no field, and nothing that could change the log.
  assert.deepEqual([...new Set(f.page.created)].sort(), ['button', 'div', 'h2', 'p', 'table', 'tbody', 'td', 'th', 'thead', 'tr']);
  assert.deepEqual(f.dialog.all().filter(node => node.tag === 'button').map(node => node.dataset.action), ['older', 'refresh', 'done']);
});

test('nothing read yet says so and still names the day\'s allowance', async () => {
  const f = fixture([]); await f.reads.open();
  assert.deepEqual([f.dialog.dataset.readsState, f.today().textContent, f.notes(), f.listed().hidden, f.rows().length], ['empty', '从 11-10 16:00 起还没有读过。每天最多 64 页，11-11 16:00 重新计。', ['还没有读取记录。'], true, 0]);
});

test('a long log shows its newest fifty first and earlier ones on request, asking only by position', async t => {
  const f = fixture(many(t)); await f.reads.open();
  assert.deepEqual(f.requests(), [{ afterSequence: 0, limit: 50 }, { afterSequence: 46, limit: 50 }]); assert.equal(f.rows().length, 50);
  assert.equal(f.listed().textContent, '共 96 条，下面是最新的 50 条。'); assert.equal(f.today().textContent, '从 11-10 16:00 起已读 38 页，还剩 26 页。每天最多 64 页，11-11 16:00 重新计。');
  assert.deepEqual([f.button('older').hidden, f.days().length], [false, 2]);
  await f.button('older').fire('click');
  assert.deepEqual(f.requests().slice(2), [{ afterSequence: 0, limit: 46 }]); assert.equal(f.rows().length, 96); assert.equal(f.listed().textContent, '共 96 条，都在下面。'); assert.equal(f.button('older').hidden, true);
  assert.equal(f.rows()[0][0], '11-11 07:45'); assert.equal(f.rows()[95][0], '11-09 16:10', 'Newest first, oldest last');
  // Refresh starts again from the newest.
  await f.button('refresh').fire('click'); assert.deepEqual(f.requests().slice(3), [{ afterSequence: 0, limit: 50 }, { afterSequence: 46, limit: 50 }]); assert.equal(f.rows().length, 50);
});

test('earlier records that are all in a block that cannot be read come as that block, not as a failure', async t => {
  const f = fixture(many(t), { gaps: [{ fromSequence: 1, throughSequence: 46, count: 46, days: ['2026-11-09', '2026-11-10'] }] }); await f.reads.open();
  assert.deepEqual([f.rows().length, f.button('older').hidden], [50, false]);
  await f.button('older').fire('click');
  assert.deepEqual(f.requests().slice(2), [{ afterSequence: 0, limit: 46 }]);
  const holes = f.dialog.all().filter(node => node.className === 'butler-reads-gap').map(body => body.children[0].children[0].textContent);
  assert.deepEqual(holes, [zh('butler.reads.gap', { from: 1, through: 46, count: 46, days: '2026-11-09 – 2026-11-10' })]);
  assert.deepEqual([f.rows().length, f.button('older').hidden, f.notes().includes(zh('butler.reads.olderFailed'))], [50, true, false]);
});

test('one opening reads the log at most twice; pages written meanwhile are said, not chased', async t => {
  const log = many(t, 200), unknownReach = '从 11-10 16:00 起已读多少页现在判断不了：最新的记录这次没读到。每天最多 64 页，11-11 16:00 重新计。';
  assert.equal(zh('butler.reads.todayUnknownReach', { from: '11-10 16:00', limit: 64, resets: '11-11 16:00' }), unknownReach);
  // Between the first read and the tail read the butler reads more: the tail is no longer the end.
  const grow = fixture(log.slice(0, 60), { fail: count => { if (count === 2) grow.state.log = log.slice(0, 75); return false; } });
  await grow.reads.open();
  assert.deepEqual(grow.requests(), [{ afterSequence: 0, limit: 50 }, { afterSequence: 10, limit: 50 }], 'One read to learn where the log ends, one for its tail, and no more');
  assert.equal(grow.rows().length, 50); assert.equal(grow.listed().textContent, '共 75 条，下面显示了其中 50 条；还有更新的没读到，点「刷新」再读。');
  // The day's count cannot be told without the newest record: that is said, with the reason, where the count would be.
  assert.deepEqual([grow.today().hidden, grow.today().textContent, grow.dialog.dataset.readsLevel], [false, unknownReach, 'unknown']);
  // The newest day's own header does not contradict it: its number is the highest page on screen, said as a lower bound.
  assert.match(grow.days()[0], /· 至少 \d+ 页$/); for (const header of grow.days().slice(1)) assert.doesNotMatch(header, /至少/);
  // Refresh reads again, twice, and then the newest record is on screen and the count is known.
  await grow.button('refresh').fire('click');
  assert.deepEqual(grow.requests().slice(2), [{ afterSequence: 0, limit: 50 }, { afterSequence: 25, limit: 50 }]); assert.equal(grow.listed().textContent, '共 75 条，下面是最新的 50 条。');
  assert.notEqual(grow.dialog.dataset.readsLevel, 'unknown'); assert.equal(grow.today().textContent.includes('判断不了'), false);
  for (const header of grow.days()) assert.doesNotMatch(header, /至少/);
  // A log that keeps growing is not chased: every opening and every refresh is two reads.
  const sizes = [60, 120, 180, 200], racing = fixture(log.slice(0, 60), { fail: count => { racing.state.log = log.slice(0, sizes[Math.min(count, sizes.length) - 1]); return false; } });
  await racing.reads.open(); assert.equal(racing.requests().length, 2);
  assert.deepEqual([racing.rows().length, racing.today().textContent, racing.listed().textContent], [50, unknownReach, '共 120 条，下面显示了其中 50 条；还有更新的没读到，点「刷新」再读。']);
  await racing.button('refresh').fire('click'); assert.equal(racing.requests().length, 4);
  // A log that fits one page is read once.
  const small = fixture(few(t)); await small.reads.open(); assert.equal(small.requests().length, 1);
  // With a record this version does not understand among them, both things are still said.
  const odd = log.map((record, index) => index === 30 ? { ...record, version: 2 } : record), mixed = fixture(odd.slice(0, 60), { fail: count => { if (count === 2) mixed.state.log = odd.slice(0, 120); return false; } });
  await mixed.reads.open();
  assert.deepEqual([mixed.rows().length, mixed.listed().textContent, mixed.notes(), mixed.today().textContent], [49, '共 120 条，下面显示了其中 49 条；还有更新的没读到，点「刷新」再读。', ['有 1 条记录这一版看不懂，没有显示。'], unknownReach]);
});

test('a log that cannot be read is said to be unreadable, with the rule and what to do, and nothing shown as if complete', async t => {
  const log = few(t);
  const answers = [{ records: 'none', throughSequence: 5, nextAfterSequence: 0, truncated: false }, { records: [], nextAfterSequence: 0, truncated: false }, { records: [], throughSequence: -1, nextAfterSequence: 0, truncated: false }, { records: [], throughSequence: 5, nextAfterSequence: 0 }, null, 'page',
    // A page that does not say where it ended cannot be followed or trusted to be the tail.
    { records: log, throughSequence: 5, truncated: false }, { records: log, throughSequence: 5, nextAfterSequence: '5', truncated: false },
    // A log that says it has records and gives none.
    { records: [], throughSequence: 5, nextAfterSequence: 0, truncated: false }];
  for (const fail of [() => true, ...answers.map(answer => () => ({ answer }))]) {
    const f = fixture(log, { fail }); await f.reads.open();
    assert.equal(f.dialog.dataset.readsState, 'unavailable'); assert.deepEqual(f.notes(), [zh('butler.reads.unavailable'), zh('butler.reads.unavailableHelp')]);
    assert.deepEqual([f.today().hidden, f.listed().hidden, f.rows().length, f.button('older').hidden, f.button('refresh').textContent, f.button('refresh').disabled], [true, true, 0, true, '再读一次', false]);
    assert.equal(f.dialog.text().includes('PRIVATE'), false);
  }
  // Reading again is the person's choice; when it works the log is shown and the warning goes.
  let broken = true; const f = fixture(log, { fail: () => broken }); await f.reads.open(); broken = false;
  await f.button('refresh').fire('click');
  assert.deepEqual([f.dialog.dataset.readsState, f.rows().length, f.notes(), f.button('refresh').textContent], ['records', 5, [], '刷新']);
});

test('whatever fails while drawing what was read, the dialog says the page could not show it, not that the log is unreadable or empty', async t => {
  let broken = true; const f = fixture(few(t), { breakTable: () => broken }); await f.reads.open();
  // The log was read; what failed is the page. It never stays on "reading", and it is not the unreadable-log state.
  assert.equal(f.dialog.dataset.readsState, 'broken');
  assert.deepEqual(f.notes(), ['读取记录读到了，但这一页显示不出来。这是界面的问题，不表示记录读不到，也不表示大管家没读过东西。点「再读一次」重试；还是这样，就把这句话告诉帮你维护 NAW 的人。']);
  assert.equal(f.notes()[0], zh('butler.reads.pageFailed.draw'));
  for (const wrong of [zh('butler.reads.unavailable'), zh('butler.reads.unavailableHelp'), zh('butler.reads.empty'), '还没有读过']) assert.equal(f.dialog.text().includes(wrong), false, wrong);
  assert.deepEqual([f.rows().length, f.button('refresh').disabled, f.button('refresh').textContent, f.today().hidden, f.full().hidden, f.listed().hidden], [0, false, '再读一次', true, true, true]);
  broken = false; await f.button('refresh').fire('click'); assert.deepEqual([f.dialog.dataset.readsState, f.rows().length], ['records', 5]);
  // Not the same for a clock that cannot be read when the log arrives: that is still said as a log that cannot be
  // read, though it was read. The window's clock is Date.now, which does not throw, so nothing reaches this today.
  const g = fixture(few(t), { now: () => { throw Error('no clock'); } }); await g.reads.open(); assert.equal(g.dialog.dataset.readsState, 'unavailable');
});

test('the count line is true as of the moment the log was read', async t => {
  let clock = NOW; const f = fixture(many(t), { now: () => clock }); await f.reads.open();
  const line = f.today().textContent; assert.equal(line, '从 11-10 16:00 起已读 38 页，还剩 26 页。每天最多 64 页，11-11 16:00 重新计。');
  // The dialog stays open past the next UTC midnight; asking for earlier records redraws, and the line does not turn into a new day's zero.
  clock = MIDNIGHT + DAY + MINUTE; await f.button('older').fire('click');
  assert.equal(f.rows().length, 96); assert.equal(f.today().textContent, line);
  await f.button('refresh').fire('click'); assert.equal(f.today().textContent, '从 11-11 16:00 起还没有读过。每天最多 64 页，11-12 16:00 重新计。');
});

test('earlier records that cannot be read leave what was read in place and say so under the list', async t => {
  let broken = false; const f = fixture(many(t), { fail: (count, options) => broken && options.limit === 46 }); await f.reads.open(); broken = true;
  await f.button('older').fire('click');
  assert.equal(f.rows().length, 50); assert.deepEqual(f.notes(), [zh('butler.reads.olderFailed')]); assert.equal(f.today().hidden, false); assert.equal(f.button('older').hidden, false, 'The person can ask again');
  // The sentence sits after the list in the dialog, where the earlier rows would have appeared.
  const order = f.dialog.children.map(node => node.className); assert.ok(order.indexOf('butler-reads-wrap') < order.lastIndexOf('butler-reads-note'));
  broken = false; await f.button('older').fire('click');
  assert.equal(f.rows().length, 96); assert.deepEqual(f.notes(), []);
  // An earlier page that comes back empty was not read either: said, not passed over in silence.
  const g = fixture(many(t), { fail: (count, options) => options.limit === 46 && { answer: { records: [], throughSequence: 96, nextAfterSequence: 0, truncated: true } } }); await g.reads.open();
  await g.button('older').fire('click'); assert.deepEqual([g.rows().length, g.notes(), g.button('older').hidden], [50, [zh('butler.reads.olderFailed')], false]);
});

test('records this version does not understand are counted, never drawn', async t => {
  const log = few(t), odd = log.map((record, index) => index === 1 ? { ...record, version: 2 } : index === 3 ? { ...record, query: { ...record.query, kind: 'notes' } } : record);
  const f = fixture(odd); await f.reads.open();
  assert.equal(f.rows().length, 3); assert.equal(f.listed().textContent, '共 5 条，下面显示了其中 3 条；另外 2 条这一版看不懂，没有显示。'); assert.deepEqual(f.notes(), []);
  const none = fixture(log.map(record => ({ ...record, version: 2 }))); await none.reads.open();
  // The day's count cannot be told either, and the dialog says so and why; Refresh would not change it.
  assert.deepEqual([none.rows().length, none.notes(), none.listed().hidden, none.today().hidden, none.today().textContent],
    [0, ['有 5 条记录这一版看不懂，没有显示。'], true, false, '从 11-10 16:00 起已读多少页现在判断不了：最新一条记录这一版看不懂。每天最多 64 页，11-11 16:00 重新计。']);
  assert.equal(none.dialog.text().includes('刷新」再读'), false);
});

test('a newest record that was read but is not understood is not called "not reached", and Refresh is not offered as a cure', async t => {
  // The core accepts a delivery lookup whose time window lies far beyond any real date; no calendar can show it.
  const log = records(t, page => { page(NOW - 10 * MINUTE, 'queue', { spaceId: SPACE, count: 3 }); page(NOW - 5 * MINUTE, 'spaces', { count: 1 }); page(NOW - MINUTE, 'deliveries', { spaceId: SPACE, count: 0, window: [8.64e15 - DAY, 8.64e15] }); });
  assert.equal(log.length, 3); assert.equal(log[2].query.throughTime, 8.64e15, 'Written and read back by the real module');
  const f = fixture(log); await f.reads.open();
  assert.deepEqual([f.dialog.dataset.readsState, f.rows().length, f.listed().textContent, f.notes(), f.today().hidden], ['records', 2, '共 3 条，下面显示了其中 2 条；另外 1 条这一版看不懂，没有显示。', [], false]);
  // Where the day's count would be, the dialog says it cannot tell and why. It is not left out.
  assert.equal(f.today().textContent, zh('butler.reads.todayUnknownNewest', { from: '11-10 16:00', limit: 64, resets: '11-11 16:00' })); assert.equal(f.dialog.dataset.readsLevel, 'unknown');
  // The day's header counts the two pages on screen as "at least": the third page of the day is the one not understood.
  assert.deepEqual(f.days(), ['11-10 16:00 至 11-11 16:00（按 UTC 算的 2026-11-11 这一天）· 至少 2 页']);
  assert.equal(f.dialog.text().includes('刷新」再读'), false);
});

test('past the person\'s reminder line the size of the log is said beside the day\'s count, with that nothing is deleted or stopped', async t => {
  const MIB = 1024 * 1024, LINE = 512 * MIB, report = (used, extra = {}) => ({ usedBytes: used, remindBytes: LINE, blocks: 3, unreadableBlocks: 0, warning: used > LINE, ...extra });
  const log = few(t);
  // Up to the line, nothing is said: the log is kept whole and there is no cap to warn of.
  for (const storage of [undefined, () => report(5 * MIB), () => report(LINE)]) {
    const f = fixture(log, { storage }); await f.reads.open(); assert.deepEqual([f.full().hidden, f.full().textContent, f.dialog.dataset.readsState, f.rows().length], [true, '', 'records', 5]);
  }
  // No report, or one that does not add up, is not "all is well": the dialog says it cannot tell how large the log is.
  const unknown = '这份记录有多大现在判断不了：这次读到的报告缺失或对不上。';
  assert.equal(zh('butler.reads.storageUnknown'), unknown);
  for (const storage of [null, () => ({ usedBytes: 9, remindBytes: 2, blocks: 1, unreadableBlocks: 0, warning: false }), () => 'over', () => report(5 * MIB, { warning: 'false' }), () => report(5 * MIB, { usedBytes: -1 }),
    () => report(5 * MIB, { unreadableBlocks: 4 }), () => report(5 * MIB, { remindBytes: 0 }), () => ({}), () => null,
    // The report of the old single file is not this log's: it does not add up here.
    () => ({ usedBytes: 4096, maxBytes: 32 * MIB, remainingBytes: 32 * MIB - 4096, warningThresholdBytes: 24 * MIB, warning: false })]) {
    const f = fixture(log, { storage }); await f.reads.open();
    assert.deepEqual([f.full().hidden, f.full().textContent, f.full().attributes.role, f.dialog.dataset.readsState, f.rows().length], [false, unknown, 'status', 'records', 5]);
    assert.equal(f.today().textContent, '从 11-10 16:00 起已读 5 页，还剩 59 页。每天最多 64 页，11-11 16:00 重新计。', 'The day\'s count is still given');
  }
  let used = LINE + 1; const f = fixture(log, { storage: () => report(used) }); await f.reads.open();
  assert.equal(f.full().hidden, false); assert.equal(f.full().attributes.role, 'status');
  assert.equal(f.full().textContent, '这份记录已有 512.1 MiB，超过 512 MiB 的提醒线。旧记录全部保留，不会自动删除，大管家也照常记录。');
  assert.equal(f.today().textContent, '从 11-10 16:00 起已读 5 页，还剩 59 页。每天最多 64 页，11-11 16:00 重新计。');
  // Shown to one decimal and never smaller than it is.
  for (const [bytes, shown] of [[600 * MIB + 1, '600.1'], [1024 * MIB, '1024'], [2048.04 * MIB, '2048.1']]) { used = Math.floor(bytes); await f.button('refresh').fire('click'); assert.equal(f.full().textContent, zh('butler.reads.storageOver', { used: shown, line: '512' }), String(bytes)); }
  // Nothing in it speaks of a cap, a full file or refused reads: past the line the core refuses nothing and deletes nothing.
  for (const word of ['上限', '满', '拒绝', '删掉', '读不到任何']) assert.equal(f.full().textContent.includes(word), false, word);
  // The report is the newest answer's: back under the line, or no answer, and the sentence goes.
  used = 3 * MIB; await f.button('refresh').fire('click'); assert.equal(f.full().hidden, true);
  used = LINE + MIB; await f.button('refresh').fire('click'); assert.equal(f.full().hidden, false); f.dialog.close();
  const g = fixture(log, { storage: () => report(LINE + MIB), fail: count => count > 1 }); await g.reads.open(); assert.equal(g.full().hidden, false);
  await g.button('refresh').fire('click'); assert.deepEqual([g.dialog.dataset.readsState, g.full().hidden, g.full().textContent], ['unavailable', true, '']);
  // The report that comes with earlier records is newer than the one the dialog opened with.
  let size = 3 * MIB; const h = fixture(many(t), { storage: () => report(size) }); await h.reads.open(); assert.equal(h.full().hidden, true);
  size = LINE + 27 * MIB; await h.button('older').fire('click'); assert.equal(h.full().textContent, zh('butler.reads.storageOver', { used: '539', line: '512' }));
  // The line is the shared module's, the one the person set: 0.5 GiB.
  assert.equal(require('../record-history.cjs').REMIND_TOTAL_BYTES, LINE);
  // Where to look when the log cannot be read names both places it can be: the folder of blocks and an older version's file.
  for (const language of ['zh', 'en']) for (const place of ['history/butler-reads', 'butler-business-reads.jsonl'])
    assert.ok(locale.format(language, 'butler.reads.unavailableHelp').includes(place), `${language}: ${place}`);
});

test('a block that cannot be read is one row in its place, with its numbers and days, and never reads as empty or as an unreadable log', async t => {
  const log = few(t), gap = { fromSequence: 2, throughSequence: 3, count: 2, days: ['2026-11-10'] };
  const f = fixture(log, { gaps: [gap] }); await f.reads.open();
  const holes = () => f.dialog.all().filter(node => node.className === 'butler-reads-gap').map(body => body.children[0].children[0]);
  assert.deepEqual(holes().map(cell => [cell.textContent, cell.attributes.colspan]), [['第 2–3 条（UTC 2026-11-10，共 2 条）现在读不到：这一块不见了、和记录清单对不上，或已损坏。NAW 没有动它，其他记录照常显示。', '5']]);
  assert.equal(f.rows().length, 3, 'The other three lines are drawn');
  // In its place: between the newer and the older lines, not at the end.
  const table = f.dialog.all().find(node => node.tag === 'table'), order = table.children.slice(1).map(body => body.className || 'day');
  assert.deepEqual(order, ['day', 'butler-reads-gap', 'day']);
  assert.equal(f.dialog.dataset.readsState, 'records');
  for (const wrong of [zh('butler.reads.empty'), zh('butler.reads.unavailable')]) assert.equal(f.dialog.text().includes(wrong), false, wrong);
  // The line above the list does not call what is shown "the newest 3": it says what is shown and what is in the gap.
  assert.equal(f.listed().textContent, zh('butler.reads.listedGap', { total: 5, shown: 3, missing: 2 }));
  // The newest position in a block that cannot be read: today's count cannot be told, and the reason is that block.
  const newest = fixture(log, { gaps: [{ fromSequence: 5, throughSequence: 5, count: 1, days: ['2026-11-11'] }] }); await newest.reads.open();
  assert.equal(newest.today().textContent, zh('butler.reads.todayUnknownGap', { from: '11-10 16:00', limit: 64, resets: '11-11 16:00' }));
  // A log whose every position is in such a block is not "cannot be read": its rows are said.
  const all = fixture(log, { gaps: [{ fromSequence: 1, throughSequence: 5, count: 5, days: ['2026-11-10', '2026-11-11'] }] }); await all.reads.open();
  assert.deepEqual([all.dialog.dataset.readsState, all.rows().length, all.listed().hidden, all.listed().textContent], ['records', 0, false, zh('butler.reads.listedGap', { total: 5, shown: 0, missing: 5 })]);
  assert.ok(all.dialog.text().includes('第 1–5 条（UTC 2026-11-10 – 2026-11-11，共 5 条）现在读不到'));
  // A gap this version does not know is counted as not understood, never drawn as something else.
  const odd = fixture(log, { gaps: [{ fromSequence: 3, throughSequence: 2, count: 0, days: [] }] }); await odd.reads.open();
  assert.equal(odd.dialog.all().filter(node => node.className === 'butler-reads-gap').length, 0);
});

test('closing drops what was read, and an answer that arrives afterwards is not drawn', async t => {
  const f = fixture(few(t)); await f.reads.open(); f.dialog.close();
  assert.deepEqual([f.dialog.open, f.rows().length], [false, 0]);
  // A slow answer: the dialog is closed while the call is still out.
  let release; f.state.pending = new Promise(resolve => { release = resolve; });
  const opening = f.reads.open(); assert.equal(f.dialog.dataset.readsState, 'loading'); assert.deepEqual([f.button('refresh').disabled, f.notes()], [true, ['正在读取…']]);
  f.dialog.close(); release(); await opening;
  assert.equal(f.rows().length, 0); assert.equal(f.dialog.open, false);
  // Disposing empties the dialog and stops listening.
  f.state.pending = null; await f.reads.open(); f.reads.dispose(); assert.deepEqual([f.dialog.open, f.dialog.children.length], [false, 0]);
});

test('every sentence is in the catalog in both languages, the catalog has no others, and a language switch repaints in place', async t => {
  // The keys the dialog asks for across every state, recorded as it draws.
  const asked = new Set(), record = language => (key, params) => { asked.add(key); return locale.format(language, key, params); };
  const log = few(t), long = many(t), full = records(t, page => { for (let index = 0; index < 64; index++) page(MIDNIGHT + MINUTE + index * 8 * MINUTE, 'deliveries', { spaceId: SPACE }); });
  const plain = records(t, page => { page(NOW - MINUTE, 'spaces'); page(NOW - 30000, 'deliveries', { spaceId: SPACE }); });
  const over = () => ({ usedBytes: 600 * 1048576, remindBytes: 512 * 1048576, blocks: 20, unreadableBlocks: 0, warning: true });
  const unknownSize = () => ({ usedBytes: 1 });
  const holes = [{ fromSequence: 2, throughSequence: 3, count: 2, days: ['2026-11-10'] }], newestHole = [{ fromSequence: 5, throughSequence: 5, count: 1, days: ['2026-11-11'] }];
  for (const [value, options, after] of [[log], [[]], [full], [plain], [log, { storage: over }], [log, { storage: unknownSize }], [log, { gaps: holes }], [log, { gaps: newestHole }], [log, { fail: () => true }], [log.map(r => ({ ...r, version: 2 }))], [log.map((r, i) => i ? r : { ...r, version: 2 })],
    [long, { fail: count => count > 1 && { answer: { records: long.slice(40, 60), throughSequence: 96, nextAfterSequence: 60, truncated: true } } }],
    [long, { fail: (count, options) => options.limit === 46 }, f => f.button('older').fire('click')], [log, { breakTable: () => true }]]) {
    const f = fixture(value, { ...options, text: record('zh') }); const opening = f.reads.open(); asked.add('butler.reads.loading'); await opening; if (after) await after(f);
  }
  // Three sentences are the window's own, said when this module could not be set up at all (tested below).
  for (const reason of ['module', 'element', 'setup', 'open']) asked.add(`butler.reads.pageFailed.${reason}`);
  const expected = Object.keys(messages.zh).filter(key => key.startsWith('butler.reads.'));
  assert.deepEqual(Object.keys(messages.en).filter(key => key.startsWith('butler.reads.')), expected);
  assert.deepEqual([...asked].filter(key => key.startsWith('butler.reads.')).sort(), [...expected].sort());
  assert.deepEqual([...asked].filter(key => !key.startsWith('butler.reads.')), ['common.done']);
  // The renderer's real display bindings repaint every sentence, including rows, on a language switch.
  let language = 'zh'; const format = (key, params) => locale.format(language, key, params), display = createBindings(format);
  // The window's name for the untouched default space follows the interface language; a name the person gave does not.
  const f = fixture(log, { display, text: format, spaceName: id => id === 'shared' ? (language === 'en' ? 'Shared space' : '默认空间') : id === SPACE ? '发版准备' : null }); await f.reads.open();
  assert.equal(f.today().textContent, '从 11-10 16:00 起已读 5 页，还剩 59 页。每天最多 64 页，11-11 16:00 重新计。'); assert.equal(f.rows()[0][2], '默认空间');
  language = 'en'; display.refresh(f.body);
  assert.equal(f.today().textContent, 'Since 11-10 16:00: 5 pages read, 59 left. At most 64 pages a day; the count restarts 11-11 16:00.');
  assert.deepEqual(f.rows()[1], ['11-10 23:39', 'Delivery records (11-09 23:39 to 11-10 23:39)', '发版准备', '4', 'No. 3'], 'The space name is the person\'s own and is not translated');
  assert.equal(f.rows()[0][2], 'Shared space', 'The default space is renamed with the language');
  assert.equal(/[一-鿿]/.test(f.dialog.text().replaceAll('发版准备', '')), false, 'Nothing else is left in the other language');
  f.dialog.close(); language = 'zh'; assert.doesNotThrow(() => display.refresh(f.body));
});

test('what a line shows and does not show is on the page without a click, in every state, as the real modules behave', async t => {
  const ZH = '一条记录表示 NAW 准许把这一页交给大管家（每一页都先记下，才交出），不能证明模型服务真的收到了。这份记录不防篡改：用你的账户运行的程序能删掉或改动它；删掉它或改系统时钟，都能绕过每天 64 页的上限。';
  const EN = 'A line means NAW approved giving the page to the butler (every page is logged before it is given), and does not show that the model service received it. The log is not tamper-proof: any program running under your account can delete or change it, and deleting it or changing the system clock gets around the limit of 64 pages a day.';
  assert.equal(zh('butler.reads.limits', { limit: 64 }), ZH); assert.equal(locale.format('en', 'butler.reads.limits', { limit: 64 }), EN.replace("model service", 'model service'));
  // "Approved", never "gave" or "received": a line can exist for a page the butler did not get.
  assert.equal(/交给了|已交给|收到了这一页|gave the page|was given/.test(ZH + EN), false);
  // Right under the introduction, and there whatever the log holds or whether it can be read at all.
  for (const [value, options] of [[few(t)], [[]], [few(t), { fail: () => true }], [few(t), { storage: null }]]) {
    const f = fixture(value, options), quiet = () => f.dialog.all().filter(node => node.tag === 'p' && node.className.split(' ').includes('quiet'));
    assert.deepEqual(quiet().slice(0, 2).map(node => node.textContent), [zh('butler.reads.intro', { limit: 50 }), ZH], 'Before the log is opened');
    await f.reads.open();
    assert.deepEqual(quiet().slice(0, 2).map(node => [node.textContent, node.hidden]), [[zh('butler.reads.intro', { limit: 50 }), false], [ZH, false]]);
    // The two share one box, directly under the title, before anything that was read.
    const about = f.dialog.children[1]; assert.equal(about.className, 'butler-reads-about'); assert.deepEqual(about.children, quiet().slice(0, 2));
  }
  // The order of giving way when the window is too small for everything: the list first, down to room for about two
  // records; then this explanation, scrolling in its own box. The count, a warning and the actions do not give way.
  const css = fs.readFileSync(path.join(__dirname, '../renderer/styles.css'), 'utf8');
  assert.ok(css.includes('.butler-reads-about { flex: 0 1 auto; min-height: 44px; overflow-y: auto; }'));
  assert.match(css, /\.butler-reads-wrap \{ position: relative; display: flex; flex-direction: column; min-height: 132px; flex: 1 100000000 auto;/);
  assert.match(css, /\.butler-reads \.dialog-actions \{ flex: none; flex-wrap: nowrap; margin-top: 14px; \}/);
  // The number in it is the core's own daily allowance.
  assert.ok(fs.readFileSync(path.join(__dirname, '../butler-read-audit.cjs'), 'utf8').includes('const MAX_PAGES_PER_UTC_DAY = 64;'));

  // What the two sentences rest on, on the real modules. A page is given only after its line is written:
  const business = fs.readFileSync(path.join(__dirname, '../butler-business.cjs'), 'utf8'), invoke = business.slice(business.indexOf('invoke: (method, input) => {'));
  assert.ok(invoke.indexOf('ButlerReadAudit.record(this.#readAudit') > 0 && invoke.indexOf('ButlerReadAudit.record(this.#readAudit') < invoke.indexOf('return page;'));
  const { ButlerReadAudit } = require('../butler-read-audit.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-butler-reads-limits-')); fs.chmodSync(dir, 0o700); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const person = {}, store = path.join(dir, 'history', 'butler-reads'), file = path.join(store, '000000001-2026-11-11.jsonl'); let clock = NOW;
  const open = () => new ButlerReadAudit(dir, { authorizePerson: actor => actor === person, now: () => clock });
  const page = audit => audit.recordPage({ actor: { sessionId: 'butler-session-synthetic', nativeId: 'butler-native-synthetic', selectionRevision: 1, runnerRef: 'butler-runner-synthetic' },
    query: { kind: 'spaces', spaceId: null, limit: 50 }, result: { count: 0, recordRefs: [], scanned: 0, truncated: false } });
  // The daily limit holds as long as the file and the clock are left alone.
  const audit = open(); for (let index = 0; index < 64; index++) page(audit);
  assert.throws(() => page(audit), { code: 'ERR_BUTLER_READ_LIMIT' }); assert.equal(audit.read(person, {}).throughSequence, 64);
  // Another program under the same account adds a well-formed line while NAW runs: the log takes it as its own.
  const last = JSON.parse(fs.readFileSync(file, 'utf8').trim().split('\n').at(-1));
  fs.appendFileSync(file, JSON.stringify({ ...last, sequence: 65, time: NOW - DAY * 400, day: new Date(NOW - DAY * 400).toISOString().slice(0, 10), pageOfDay: 1 }) + '\n');
  const forged = audit.read(person, { afterSequence: 64, limit: 50 }); assert.equal(forged.throughSequence, 65); assert.equal(forged.records[0].day, new Date(NOW - DAY * 400).toISOString().slice(0, 10));
  // The clock moved to another day: the same log gives a fresh allowance.
  clock = NOW + DAY; assert.equal(page(audit).pageOfDay, 1);
  // The log deleted while NAW is closed (its folder): the next start has an empty log and a fresh allowance for the same day.
  clock = NOW; fs.rmSync(path.join(dir, 'history'), { recursive: true }); const fresh = open();
  assert.deepEqual([fresh.read(person, {}).throughSequence, fresh.read(person, {}).records.length], [0, 0]); assert.equal(page(fresh).pageOfDay, 1);
});

// The renderer's own lines that set the read log page and the entry up, as written, run where the window's other
// parts are stand-ins. `parts` are the page's elements by id; a missing id is a missing element.
function windowSetup(window, { parts = {}, showModal, api = {} } = {}) {
  const renderer = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
  const reads = renderer.slice(renderer.indexOf('function failedButlerReads(reason) {'), renderer.indexOf('// The existing butler view owns visibility and state;'));
  assert.ok(reads.includes('\nfunction openButlerReads() {'), 'The slice holds the way the page is asked for');
  const entry = renderer.slice(renderer.indexOf('function failedButlerEntry(reason) {'), renderer.indexOf('let newDirectory = false, creatingSession = false;'));
  assert.ok(reads.startsWith('function failedButlerReads(reason) {') && reads.includes('\nlet butlerReads;\ntry { butlerReads = window.nativeWorkspaceButlerReads.bind('), reads.slice(0, 80));
  assert.ok(entry.startsWith('function failedButlerEntry(reason) {') && entry.includes('\nlet butlerEntry;\ntry { butlerEntry = window.nativeWorkspaceButlerEntry.bind(') && entry.trimEnd().endsWith("'setup'); }"), entry.slice(0, 120));
  const page = { activeElement: null, shown: 0, added: [] };
  const make = (tag, id) => { const element = new Element(tag, page); element.id = id || ''; element.after = other => { other.placedAfter = element; page.added.push(other); }; element.before = other => { other.placedBefore = element; page.added.push(other); };
    element.remove = () => { element.removed = true; };
    if (tag === 'dialog' && showModal) element.showModal = showModal; return element; };
  const elements = Object.fromEntries(Object.entries({ 'butler-dialog': 'dialog', 'butler-row': 'button', 'new-session': 'button', 'butler-review-dialog': 'dialog', ...parts }).map(([id, tag]) => [id, tag ? make(tag, id) : null]));
  // As the page has it: the row is there and hidden until an entry shows it.
  if (elements['butler-row']) elements['butler-row'].hidden = true;
  // What is bound, by element and by slot, as the window's own bindings keep it.
  const errors = [], said = [], bound = new Map(), slots = element => bound.get(element) || bound.set(element, new Map()).get(element);
  const display = { text: (element, key) => { slots(element).set('text', key); element.textContent = locale.format('zh', key); },
    computed: (element, slot, read) => { slots(element).set(slot, read); element.setAttribute(slot, read()); },
    unbind: (element, slot = 'text') => { const own = bound.get(element); if (own) { own.delete(slot); if (!own.size) bound.delete(element); } } };
  const body = make('body');
  const sandbox = { window, errors, console: { error: error => errors.push(error) }, $: id => elements[id] ?? null, document: { body }, api, uiText: (key, params) => locale.format('zh', key, params), ui: { display, showError() {} },
    node: (tag, text, cls) => { const element = make(tag); if (text !== undefined) element.textContent = text; if (cls) element.className = cls; return element; },
    spaceRecord: () => null, spaceName: () => '', openButlerReview() {}, uiError: key => ({ key }), toastError: error => said.push(error.key) };
  require('node:vm').runInNewContext(reads + entry + '\nthis.result = { get butlerReads() { return butlerReads; }, butlerEntry };', sandbox);
  return { get butlerReads() { return sandbox.result.butlerReads; }, butlerEntry: sandbox.result.butlerEntry, errors, said, page, elements, bound, body };
}

test('if the read log or the entry cannot be set up, the window still starts without it', () => {
  // A module that is not there (left out of the page or the bundle), or one whose bind fails (its element is missing).
  for (const window of [{}, { nativeWorkspaceButlerReads: null, nativeWorkspaceButlerEntry: undefined },
    { nativeWorkspaceButlerReads: { bind() { throw Error('no dialog element'); } }, nativeWorkspaceButlerEntry: { bind() { throw Error('no row element'); } } }]) {
    const { butlerReads, butlerEntry, errors } = windowSetup(window);
    assert.equal(errors.length, 2, 'Both failures are written to the console, not swallowed without a trace');
    // What the rest of the window calls on them does not throw.
    assert.doesNotThrow(() => { butlerReads.dispose(); butlerEntry.start(); butlerEntry.refresh(); butlerEntry.dispose(); });
  }
  // One failing does not take the other with it, and when both work they are what the window uses.
  let opens = 0; const bound = { open() { opens++; return 'opened'; }, dispose() {} }, row = { start() { return 'started'; }, refresh() {}, dispose() {} };
  const half = windowSetup({ nativeWorkspaceButlerReads: { bind: () => bound } }); assert.equal(half.butlerReads.open(), 'opened'); assert.equal(half.errors.length, 1); assert.equal(half.butlerEntry.failed, 'module');
  let given; const both = windowSetup({ nativeWorkspaceButlerReads: { bind: () => bound }, nativeWorkspaceButlerEntry: { bind: options => { given = options; return row; } } });
  assert.equal(both.errors.length, 0); assert.equal(both.butlerReads.failed, undefined); assert.equal(both.butlerEntry.start(), 'started');
  opens = 0; given.openReads(); assert.equal(opens, 1, 'The entry opens the read log that was set up'); assert.equal(both.errors.length, 0);
});

test('a read log page that could not be set up says so and why, in the page\'s own place, and never looks like an empty or unreadable log', async t => {
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const tail = '这是界面的问题，不表示大管家没读过东西；这一页只是显示记录，打不开不会改动记录文件。重新打开 NAW 再试一次；还是打不开，就把这句话告诉帮你维护 NAW 的人。';
  // It does not say that nobody touched the file: the window cannot know that.
  assert.equal(/没有被动过|not been touched/.test(JSON.stringify(messages)), false);
  // What "only displays" rests on. The page's program asks the window's interface for one thing, the read:
  assert.deepEqual(fs.readFileSync(path.join(__dirname, '../renderer/butler-reads.js'), 'utf8').match(/\bapi\.\w+\([^)]*/g), ["api.butlerReview('reads', request"]);
  // the main process answers it with the log's own read and nothing else:
  const main = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8'), answer = main.slice(main.indexOf("    if (action === 'reads') {\n      if (!butlerReadAudit)"), main.indexOf('    const ledger = butlerIngress?.ledger;'));
  assert.deepEqual(answer.match(/butlerReadAudit\.\w+/g), ['butlerReadAudit.read']);
  // and that read leaves the file byte for byte as it was, with no lock left beside it.
  { const { ButlerReadAudit } = require('../butler-read-audit.cjs'), person = {};
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-butler-reads-page-')); fs.chmodSync(dir, 0o700); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const audit = new ButlerReadAudit(dir, { authorizePerson: actor => actor === person, now: () => NOW }), store = path.join(dir, 'history', 'butler-reads');
    const files = () => fs.readdirSync(store).sort().map(name => [name, fs.readFileSync(path.join(store, name), 'hex'), fs.statSync(path.join(store, name)).mtimeMs]);
    for (let index = 0; index < 3; index++) audit.recordPage({ actor: { sessionId: 'butler-session-synthetic', nativeId: 'butler-native-synthetic', selectionRevision: 1, runnerRef: 'butler-runner-synthetic' },
      query: { kind: 'spaces', spaceId: null, limit: 50 }, result: { count: 0, recordRefs: [], scanned: 0, truncated: false } });
    const before = [files(), fs.readdirSync(dir).sort()];
    assert.equal(audit.read(person, { limit: 50 }).records.length, 3); assert.equal(audit.read(person, { afterSequence: 1, limit: 1 }).records.length, 1);
    assert.deepEqual([files(), fs.readdirSync(dir).sort()], before); assert.deepEqual(before[1], ['history']); assert.deepEqual(before[0].map(([name]) => name), ['000000001-2026-11-11.jsonl', 'manifest.json']); }
  const sentences = { module: '这一页打不开：这个窗口里缺少显示读取记录的那部分程序。' + tail, element: '这一页打不开：页面里缺少放读取记录的位置。' + tail, setup: '这一页打不开：准备这一页的时候出了错。' + tail,
    open: '这一页打不开：打开它的时候出了错。' + tail };
  const tailEn = 'This is a fault of the interface. It does not mean the butler read nothing. This page only displays the log, so its failing to open does not change the log file. Reopen NAW and try once more; if it still does not open, pass this sentence to whoever maintains NAW for you.';
  const english = { module: 'This page cannot open: the part of the program that shows the read log is missing from this window. ' + tailEn, element: 'This page cannot open: its place in the window is missing. ' + tailEn,
    setup: 'This page cannot open: setting it up failed. ' + tailEn, open: 'This page cannot open: it failed as it was opening. ' + tailEn };
  for (const [reason, sentence] of Object.entries(sentences)) { assert.equal(zh(`butler.reads.pageFailed.${reason}`), sentence); assert.equal(locale.format('en', `butler.reads.pageFailed.${reason}`), english[reason]); }
  // Each reason has its own sentence: the person can tell the maintainer which one it was.
  assert.equal(new Set(Object.values(sentences)).size, 4); assert.equal(new Set(Object.values(english)).size, 4);
  const entry = { nativeWorkspaceButlerEntry: { bind: options => ({ start() {}, refresh() {}, dispose() {}, options }) } };
  const cases = [
    // The page's program is not in this window.
    ['module', { ...entry }, { 'butler-reads-dialog': 'dialog' }],
    // Its program is there, its place in the page is not.
    ['element', { ...entry, nativeWorkspaceButlerReads: { bind({ dialog }) { return dialog.id; } } }, { 'butler-reads-dialog': null }],
    // Both are there and setting the page up failed.
    ['setup', { ...entry, nativeWorkspaceButlerReads: { bind() { throw Error('/PRIVATE/PATH in a stack'); } } }, { 'butler-reads-dialog': 'dialog' }]];
  for (const [reason, window, parts] of cases) {
    const w = windowSetup(window, { parts }), reads = w.butlerReads;
    assert.equal(reads.failed, reason); assert.equal(w.errors.length, 1); assert.deepEqual(w.said, [], 'Nothing is said until the page is asked for');
    // Asked for from the entry, as the person would.
    w.butlerEntry.options.openReads();
    const dialog = w.elements['butler-reads-dialog'] || w.page.added[0];
    assert.ok(dialog, 'There is a page to say it in, made if the window has none'); assert.equal(dialog.open, true);
    // The page's own element when the window has it; one made to look like it when it has not.
    assert.deepEqual([dialog.dataset.readsState, dialog.dataset.readsFailure, reason === 'element' ? dialog.className.split(' ').includes('butler-reads') && dialog.id === 'butler-reads-dialog' : dialog === w.elements['butler-reads-dialog']], ['page-failed', reason, true]);
    const [title, text, actions] = dialog.children;
    assert.deepEqual([title.tag, title.textContent, text.textContent, text.attributes.role, actions.children.map(button => [button.dataset.action, button.textContent])], ['h2', '大管家读过什么', sentences[reason], 'alert', [['done', '完成']]]);
    assert.equal(dialog.attributes['aria-labelledby'], title.id); assert.equal(w.page.activeElement, actions.children[0], 'The focus is on Done');
    // Not a toast that goes away, not an empty log, not "the log cannot be read", and no raw error text.
    assert.deepEqual(w.said, []);
    for (const wrong of [zh('butler.reads.empty'), zh('butler.reads.unavailable'), zh('error.butler.readAuditUnavailable'), '还没有读过', 'PRIVATE', 'Error']) assert.equal(dialog.text().includes(wrong), false, wrong);
    // Asked for again it is the same page, not a second one; Done closes it; the window's teardown clears it.
    if (reason === 'element') assert.deepEqual([dialog.placedAfter, w.body.children], [w.elements['butler-review-dialog'], []], 'Made where the page keeps this dialog, not in the body');
    reads.open(); assert.equal(dialog.children.length, 3); assert.equal(w.page.added.length, reason === 'element' ? 1 : 0); assert.deepEqual([dialog.open, w.said, w.errors.length], [true, [], 1], 'Asked for while it is open, it stays as it is');
    actions.children[0].fire('click'); assert.equal(dialog.open, false);
    reads.open(); assert.equal(dialog.open, true); reads.dispose();
    assert.equal(dialog.open, false); assert.equal(w.bound.size, 0, 'No text binding is left behind'); assert.equal(reason === 'element' ? dialog.removed : dialog.children.length === 0, true);
  }
  // A page that was set up and then fails as it is asked for (its element gone from the window, an error before
  // anything is drawn, or one that arrives later) ends in the same view, not in nothing; what was set up is torn down.
  for (const failing of [() => { throw Error('The element is not in a Document'); }, () => Promise.reject(Error('nothing could be drawn')), async () => { throw Error('later'); }]) {
    let disposed = 0;
    const w = windowSetup({ ...entry, nativeWorkspaceButlerReads: { bind: () => ({ open: failing, dispose() { disposed++; } }) } }, { parts: { 'butler-reads-dialog': 'dialog' } });
    assert.equal(w.errors.length, 0); assert.equal(w.butlerReads.failed, undefined);
    w.butlerEntry.options.openReads(); await settle();
    const dialog = w.elements['butler-reads-dialog'];
    assert.deepEqual([dialog.open, dialog.dataset.readsState, dialog.dataset.readsFailure, dialog.children[1].textContent, disposed, w.errors.length, w.said], [true, 'page-failed', 'open', sentences.open, 1, 1, []]);
    // From then on the page is the failure view: asking again shows it again and does not call the broken page.
    dialog.children[2].children[0].fire('click'); w.butlerEntry.options.openReads(); await settle();
    assert.deepEqual([dialog.open, dialog.children.length, disposed, w.errors.length], [true, 3, 1, 1]);
  }
  // Even when the page that failed cannot be torn down either, the failure view is shown.
  { const w = windowSetup({ ...entry, nativeWorkspaceButlerReads: { bind: () => ({ open() { throw Error('cannot open'); }, dispose() { throw Error('cannot tear down'); } }) } }, { parts: { 'butler-reads-dialog': 'dialog' } });
    w.butlerEntry.options.openReads(); const dialog = w.elements['butler-reads-dialog'];
    assert.deepEqual([dialog.open, dialog.dataset.readsFailure, dialog.children[1].textContent, w.said, w.butlerReads.failed], [true, 'open', sentences.open, [], 'open']); }
  // A page that opens is left alone, whatever it returns.
  for (const value of [undefined, 'opened', Promise.resolve('read')]) { let opened = 0;
    const w = windowSetup({ ...entry, nativeWorkspaceButlerReads: { bind: () => ({ open() { opened++; return value; }, dispose() {} }) } }, { parts: { 'butler-reads-dialog': 'dialog' } });
    w.butlerEntry.options.openReads(); await settle(); assert.deepEqual([opened, w.errors.length, w.elements['butler-reads-dialog'].open, w.elements['butler-reads-dialog'].children.length], [1, 0, false, 0]); }
  // If even that cannot be shown, the person is still told it is the page, in a notice.
  const last = windowSetup({ ...entry }, { parts: { 'butler-reads-dialog': 'dialog' }, showModal() { throw Error('cannot show'); } });
  last.butlerEntry.options.openReads();
  assert.deepEqual(last.said, ['error.butler.readsPage']); assert.equal(last.errors.length, 2);
  assert.equal(messages.zh['error.butler.readsPage'], '「它读过什么」这一页打不开，是界面的问题，不表示大管家没读过东西。重新打开 NAW 再试一次。');
  assert.equal(/[一-鿿]/.test(messages.en['error.butler.readsPage']), false);
});

// The entry that could not be set up. `answer` is what the main process says to the window's one question.
const entryWindows = () => {
  const reads = { opened: 0 }, withReads = { nativeWorkspaceButlerReads: { bind: () => ({ open() { reads.opened++; }, dispose() {} }) } };
  return { reads, cases: [
    // The entry's program is not in this window.
    ['module', { ...withReads }, {}],
    // Its program is there; the row, or the row's dialog, is not in the page.
    ['element', { ...withReads, nativeWorkspaceButlerEntry: { bind({ row }) { row.append('never'); } } }, { 'butler-row': null }],
    ['element', { ...withReads, nativeWorkspaceButlerEntry: { bind({ row, dialog }) { row.append(new Element('span')); dialog.setAttribute('x', 'y'); } } }, { 'butler-dialog': null }],
    // Both are there and setting it up failed half way, with something already put in the row and the dialog.
    ['setup', { ...withReads, nativeWorkspaceButlerEntry: { bind({ row, dialog }) { row.append(new Element('span'), new Element('span')); dialog.append(new Element('h2')); throw Error('/PRIVATE/PATH in a stack'); } } }, {}]] };
};
const refusal = key => Object.assign(Error('refused'), { uiMessage: { key } });
const asking = answer => { const calls = []; return { calls, api: { butler: (...args) => { calls.push(args); return answer(); } } }; };

test('an entry that could not be set up shows nothing until the main process says this window has one: with the switch closed it asks once and the window is as it was', async () => {
  const unreadable = Object.defineProperty(Error('refused'), 'uiMessage', { get() { throw Error('no key'); } });
  for (const answer of [() => Promise.reject(refusal('error.butler.entryDisabled')), () => Promise.reject(refusal('error.butler.personOnly')), () => Promise.reject(Error('the call did not arrive')),
    () => Promise.reject(unreadable), () => Promise.reject(refusal('error.butler.invalidRequest')), () => { throw refusal('error.butler.entryDisabled'); }]) {
    for (const [reason, window, parts] of entryWindows().cases) {
      const asked = asking(answer), w = windowSetup(window, { parts, api: asked.api }), entry = w.butlerEntry, row = w.elements['butler-row'], dialog = w.elements['butler-dialog'];
      assert.equal(entry.failed, reason); assert.equal(w.errors.length, 1, 'The failure is on the console');
      const before = [row?.children.length, dialog?.children.length];
      // Nothing before the question is asked, and nothing after its refusal.
      assert.deepEqual([asked.calls, row?.hidden], [[], row ? true : undefined]);
      await entry.start();
      assert.deepEqual(asked.calls, [['status']], 'One question, the one the entry itself asks');
      assert.deepEqual([row?.hidden, row?.children.length, dialog?.children.length, dialog?.open, w.page.added, w.body.children, w.said, w.bound.size, w.errors.length], [row ? true : undefined, before[0], before[1], dialog ? false : undefined, [], [], [], 0, 1]);
      assert.equal(row?.listeners.click?.length || 0, 0, 'Nothing listens for a click on a row that is not shown');
      // The window calls start on every render of its state, and may ask to refresh: no second question.
      assert.equal(entry.start(), undefined); entry.refresh(); await entry.start(); assert.deepEqual(asked.calls, [['status']]);
      entry.dispose(); assert.deepEqual([row?.hidden, w.said, w.page.added], [row ? true : undefined, [], []]);
    }
  }
  // A window without the person-only call at all: nothing is shown and nothing is said.
  const w = windowSetup({}, {}); await w.butlerEntry.start(); assert.deepEqual([w.elements['butler-row'].hidden, w.said, w.page.added], [true, [], []]);
  // The stand-in's rule and the entry's are the same rule, each in its own words: of all refusals only "cannot be
  // verified now" says this window has an entry. If either line changes, the other has to be looked at.
  const renderer = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8'), entry = fs.readFileSync(path.join(__dirname, '../renderer/butler-entry.js'), 'utf8');
  assert.equal(renderer.split("if (key !== 'error.butler.unavailable') return; }").length, 2); assert.equal(entry.split("if (key === 'error.butler.unavailable') answered = true;").length, 2);
  assert.equal(entry.split('render(answered ? { version: 1, unavailable: true, actions: [] } : undefined);').length, 2);
});

test('with an entry in this window, a row that could not be set up stays in its place and says the interface failed; its dialog says why and still opens the read log', async t => {
  const tail = '这是界面的问题，不表示没有指定大管家，也不会改动指定。修好之前，这个窗口里看不到大管家的状态，也不能指定或撤销。重新打开 NAW 再试一次；还是这样，就把这句话告诉帮你维护 NAW 的人。';
  const sentences = { module: '大管家的状态显示不出来：这个窗口里缺少显示它的那部分程序。' + tail, element: '大管家的状态显示不出来：页面里缺少放这一行或它的对话框的位置。' + tail, setup: '大管家的状态显示不出来：准备这一行的时候出了错。' + tail };
  const tailEn = 'This is a fault of the interface. It does not mean that no butler is designated, and it does not change the designation. Until it is fixed, this window cannot show the butler\'s state, and a butler cannot be designated or revoked here. Reopen NAW and try once more; if it stays like this, pass this sentence to whoever maintains NAW for you.';
  const english = { module: 'The butler\'s state cannot be shown: the part of the program that shows it is missing from this window. ' + tailEn, element: 'The butler\'s state cannot be shown: the place for this row or for its dialog is missing from the page. ' + tailEn,
    setup: 'The butler\'s state cannot be shown: setting this row up failed. ' + tailEn };
  for (const reason of Object.keys(sentences)) { assert.equal(zh(`butler.entryFailed.${reason}`), sentences[reason]); assert.equal(locale.format('en', `butler.entryFailed.${reason}`), english[reason]); }
  assert.equal(new Set(Object.values(sentences)).size, 3); assert.equal(new Set(Object.values(english)).size, 3);
  assert.deepEqual([zh('butler.row.failed'), locale.format('en', 'butler.row.failed')], ['界面出错', 'Interface fault']);
  const selected = { runner: { profile: 'deepseek-pro', provider: 'deepseek', model: 'deepseek-v4-pro' }, budget: null };
  // Every answer that says "this window has an entry": nothing designated, a designation, a record that cannot be
  // read, and the refusal an open entry gives when the state cannot be verified.
  for (const answer of [() => Promise.resolve({ version: 1, role: { revision: 0, selected: null }, actions: ['recheck'] }), () => Promise.resolve({ version: 1, role: { revision: 4, selected }, actions: ['revoke', 'recheck'] }),
    () => Promise.resolve({ version: 1, unavailable: true, actions: [] }), () => Promise.reject(refusal('error.butler.unavailable')),
    // And an answer this window does not understand: the entry would hide for it; this row draws nothing from the
    // answer and stays, since the main process answers only a window that has an entry.
    () => Promise.resolve({ version: 2 }), () => Promise.resolve(undefined)]) {
    const windows = entryWindows();
    for (const [reason, window, parts] of windows.cases) {
      const asked = asking(answer), w = windowSetup(window, { parts, api: asked.api }), entry = w.butlerEntry, opened = windows.reads.opened;
      await entry.start();
      const row = w.elements['butler-row'] || w.page.added.find(element => element.id === 'butler-row');
      assert.ok(row, 'There is a row, made if the page has none');
      // In its place: the page's own row, or one made like it and put where it belongs, before "new session".
      if (!w.elements['butler-row']) assert.deepEqual([row.tag, row.className, row.type, row.attributes['aria-haspopup'], row.placedBefore], ['button', 'butler-row', 'button', 'dialog', w.elements['new-session']]);
      assert.deepEqual([row.hidden, row.dataset.butlerState, row.dataset.butlerFailure, row.attributes['aria-label'], row.attributes.title], [false, 'failed', reason, '大管家：界面出错', '大管家：界面出错']);
      // Drawn as the entry's row is, so the same styles and the narrow rail apply; what a failed setup left is gone.
      const [icon, name, state] = row.children;
      assert.deepEqual(row.children.map(part => [part.tag, part.className]), [['span', 'rail-icon'], ['span', 'rail-label'], ['span', 'butler-state']]);
      assert.deepEqual([icon.textContent, icon.attributes['aria-hidden'], name.textContent, state.children.map(part => [part.className, part.attributes['aria-hidden'] ?? null, part.textContent])], ['◆', 'true', '大管家', [['butler-dot', 'true', ''], ['', null, '界面出错']]]);
      // It does not read as any state of a butler.
      for (const key of ['empty', 'ready', 'recording', 'held', 'blockedBuild', 'unknown']) assert.equal(row.text().includes(zh(`butler.row.${key}`)), false, key);
      assert.deepEqual([w.said, w.errors.length], [[], 1]);

      // Chosen, it opens a dialog with the reason, what cannot be done from here, and two things to do.
      row.fire('click');
      const dialog = w.elements['butler-dialog'] || w.page.added.find(element => element.id === 'butler-dialog');
      assert.ok(dialog, 'There is a dialog, made if the page has none');
      // Made where the page keeps this dialog, among its own dialogs: the page's styles do not reach the body.
      if (!w.elements['butler-dialog']) assert.deepEqual([dialog.tag, dialog.id, dialog.className, dialog.attributes.closedby, dialog.placedBefore], ['dialog', 'butler-dialog', 'butler-dialog', 'any', w.elements['butler-review-dialog']]);
      assert.deepEqual(w.body.children, [], 'Nothing is put in the body');
      const [title, text, actions] = dialog.children;
      assert.deepEqual([dialog.open, dialog.children.length, dialog.dataset.butlerState, dialog.dataset.butlerFailure, title.tag, title.textContent, dialog.attributes['aria-labelledby'] === title.id, text.className, text.attributes.role, text.textContent],
        [true, 3, 'failed', reason, 'h2', '大管家', true, 'butler-note', 'alert', sentences[reason]]);
      assert.deepEqual(actions.children.map(button => [button.tag, button.type, button.dataset.action, button.textContent]), [['button', 'button', 'reads', '它读过什么'], ['button', 'button', 'done', '完成']], 'Nothing that changes a designation is offered');
      assert.equal(w.page.activeElement, actions.children[1], 'The focus is on Done');
      for (const wrong of [zh('butler.status.empty'), zh('butler.status.unknown'), zh('butler.note.unknown'), zh('butler.note.empty'), 'PRIVATE', 'Error', 'deepseek']) assert.equal(dialog.text().includes(wrong), false, wrong);
      // Chosen again while it is open, it stays as it is; Done closes it; chosen again it is the same dialog.
      row.fire('click'); assert.deepEqual([dialog.open, dialog.children.length, dialog.children[1] === text, w.said], [true, 3, true, []]);
      actions.children[1].fire('click'); assert.equal(dialog.open, false);
      row.fire('click'); assert.deepEqual([dialog.open, dialog.children[1] === text, w.page.added.filter(element => element.id === 'butler-dialog').length], [true, true, w.elements['butler-dialog'] ? 0 : 1]);
      // The read log needs no entry: it opens from here, through the window's own way of asking for that page.
      actions.children[0].fire('click'); assert.deepEqual([dialog.open, windows.reads.opened], [false, opened + 1]);
      // All of it asked the main process one thing, once: the state.
      entry.start(); entry.refresh(); assert.deepEqual(asked.calls, [['status']]);
      // The window's teardown leaves nothing behind.
      row.fire('click'); assert.equal(dialog.open, true); entry.dispose();
      assert.deepEqual([row.hidden, row.children.length, dialog.open, dialog.children.length, row.listeners.click.length, w.bound.size], [true, 0, false, 0, 0, 0]);
      assert.deepEqual([Boolean(row.removed), Boolean(dialog.removed)], [!w.elements['butler-row'], !w.elements['butler-dialog']], 'What was made is taken out; what the page had stays');
    }
  }
  // A window torn down before the answer arrives shows nothing afterwards.
  { let answer; const asked = asking(() => new Promise(resolve => { answer = resolve; })), w = windowSetup({}, { api: asked.api }), starting = w.butlerEntry.start();
    w.butlerEntry.dispose(); answer({ version: 1, role: { revision: 0, selected: null }, actions: [] }); await starting;
    assert.deepEqual([w.elements['butler-row'].hidden, w.elements['butler-row'].children.length, w.said], [true, 0, []]); }
  // Asked for from here, a read log page that fails as it opens says so itself: the dialog asks for that page the
  // window's own way, which catches the failure.
  { const asked = asking(() => Promise.resolve({ version: 1, unavailable: true, actions: [] }));
    const w = windowSetup({ nativeWorkspaceButlerReads: { bind: () => ({ open() { throw Error('cannot open'); }, dispose() {} }) } }, { parts: { 'butler-reads-dialog': 'dialog' }, api: asked.api });
    await w.butlerEntry.start(); w.elements['butler-row'].fire('click'); w.elements['butler-dialog'].children[2].children[0].fire('click');
    assert.deepEqual([w.elements['butler-dialog'].open, w.elements['butler-reads-dialog'].open, w.elements['butler-reads-dialog'].dataset.readsFailure, w.said], [false, true, 'open', []]); }

  // What the sentence rests on. The stand-in asks the main process for the state and for nothing else:
  const renderer = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8'), own = renderer.slice(renderer.indexOf('function failedButlerEntry(reason) {'), renderer.indexOf("// The butler's row is drawn only from a view"));
  assert.deepEqual(own.match(/\bapi\.[\w.]+\([^)]*\)/g), ["api.butler('status')"]);
  // the main process answers that with the core's own look at the state:
  const main = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8');
  assert.ok(main.includes("      if (action === 'status') return shown(butlerPerson.status(c));"));
  // and that look leaves the designation record byte for byte as it was, designated or not.
  { const { ButlerRole } = require('../butler-role.cjs'), { ButlerPerson } = require('../butler-person.cjs'), person = {};
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-butler-entry-failed-')); fs.chmodSync(dir, 0o700); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const role = new ButlerRole(dir, { authorizePerson: actor => actor === person }), core = new ButlerPerson({ role, authorizePerson: actor => actor === person });
    const listing = () => fs.readdirSync(dir).sort().map(name => [name, fs.readFileSync(path.join(dir, name), 'hex'), fs.statSync(path.join(dir, name)).mtimeMs]);
    const empty = listing(); assert.equal(core.status(person).role.selected, null); assert.deepEqual(listing(), empty);
    role.set(person, { identity: { sessionId: 'butler-session-synthetic', nativeId: 'butler-native-synthetic' }, runner: { runnerRef: 'butler-runner:synthetic', backendRef: 'butler-backend:synthetic', purpose: 'butler', profile: 'deepseek-pro', provider: 'deepseek', model: 'deepseek-v4-pro' } }, 0);
    const designated = listing(); assert.ok(designated.length > 0);
    assert.equal(core.status(person).role.revision, 1); core.status(person); assert.deepEqual(listing(), designated); }
});

test('if even the row or its dialog cannot be shown, a notice says it is the interface, never that no butler is designated', async () => {
  assert.deepEqual([messages.zh['error.butler.entryRow'], messages.en['error.butler.entryRow']], ['大管家这一行显示不出来，是界面的问题，不表示没有指定大管家。重新打开 NAW 再试一次。',
    'The butler\'s row cannot be shown. This is a fault of the interface and does not mean that no butler is designated. Reopen NAW and try once more.']);
  const open = () => Promise.resolve({ version: 1, role: { revision: 0, selected: null }, actions: [] });
  // The read log is set up in these windows; only the entry is not (its program is missing).
  const only = () => entryWindows().cases[0][1];
  // No row in the page and nowhere known to put one.
  const nowhere = windowSetup(only(), { parts: { 'butler-row': null, 'new-session': null }, api: asking(open).api }); await nowhere.butlerEntry.start();
  assert.deepEqual([nowhere.said, nowhere.errors.length, nowhere.page.added], [['error.butler.entryRow'], 2, []]);
  // With the switch closed the same window says nothing.
  const closed = windowSetup(only(), { parts: { 'butler-row': null, 'new-session': null }, api: asking(() => Promise.reject(refusal('error.butler.entryDisabled'))).api }); await closed.butlerEntry.start();
  assert.deepEqual([closed.said, closed.errors.length], [[], 1]);
  // The row is shown and its dialog cannot be: the notice is said each time the row is chosen, and the row stays.
  const stuck = windowSetup(only(), { api: asking(open).api, showModal() { throw Error('cannot show'); } }); await stuck.butlerEntry.start();
  const row = stuck.elements['butler-row']; assert.deepEqual([row.hidden, stuck.said], [false, []]);
  row.fire('click'); row.fire('click'); assert.deepEqual([stuck.said, row.hidden, stuck.errors.length], [['error.butler.entryRow', 'error.butler.entryRow'], false, 3]);
  // The same when the page has no dialog for it and no place to make one.
  const placeless = windowSetup(only(), { parts: { 'butler-dialog': null, 'butler-review-dialog': null }, api: asking(open).api }); await placeless.butlerEntry.start();
  placeless.elements['butler-row'].fire('click'); assert.deepEqual([placeless.said, placeless.page.added, placeless.body.children, placeless.elements['butler-row'].hidden], [['error.butler.entryRow'], [], [], false]);
});

test('without the entry on screen the read log does not stay open', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
  // The renderer's own two lines of its state render, as written: the record table's rule and the read log's.
  const start = renderer.indexOf("  if ($('butler-row')?.hidden === true && $('butler-review-dialog')?.open)"), end = renderer.indexOf('\n', renderer.indexOf("$('butler-reads-dialog').close();", start)) + 1;
  assert.ok(start > 0 && end > start); const lines = renderer.slice(start, end); assert.equal(lines.split('\n').filter(line => line.trim() && !line.trim().startsWith('//')).length, 2);
  const run = (row, reads, review = { open: false }) => {
    const closed = [], make = (name, value) => value && { ...value, close() { closed.push(name); } };
    const parts = { 'butler-row': row, 'butler-reads-dialog': make('reads', reads), 'butler-review-dialog': make('review', review) };
    require('node:vm').runInNewContext(lines, { $: id => { assert.ok(Object.hasOwn(parts, id), id); return parts[id]; } });
    return closed;
  };
  assert.deepEqual(run({ hidden: true }, { open: true }), ['reads'], 'The entry is gone: the read log closes');
  assert.deepEqual(run({ hidden: false }, { open: true }), [], 'The entry is on screen: the read log stays');
  assert.deepEqual(run({ hidden: true }, { open: false }), [], 'A closed dialog is left alone');
  assert.deepEqual(run({ hidden: true }, { open: true }, { open: true }), ['review', 'reads'], 'Each dialog by its own rule');
  // A page without these elements (the guards above) is left alone too.
  assert.deepEqual(run(null, { open: true }), []); assert.deepEqual(run({ hidden: true }, null, null), []);
});

test('the page loads the view before the dialog and the dialog before the renderer, which gives it this window\'s space names', () => {
  const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8'), html = read('renderer/index.html'), build = fs.readFileSync(path.join(__dirname, '../../scripts/build-ui.cjs'), 'utf8'), renderer = read('renderer/renderer.js');
  for (const positions of [['src="../butler-reads-view.js"', 'src="butler-reads.js"', 'src="renderer.js"'].map(name => html.indexOf(name)), ["read('app/butler-reads-view.js')", "'butler-reads.js'", "'renderer.js'"].map(name => build.indexOf(name))])
    assert.ok(positions.every(value => value > 0) && positions[0] < positions[1] && positions[1] < positions[2]);
  assert.match(html, /<dialog closedby="any" id="butler-reads-dialog" class="butler-reads"><\/dialog>/);
  // If the dialog cannot be set up the window still starts: a stand-in that does nothing takes its place.
  assert.match(renderer, /let butlerReads;\ntry \{ butlerReads = window\.nativeWorkspaceButlerReads\.bind\(\{ dialog: \$\('butler-reads-dialog'\), document, api, text: \(key, params\) => uiText\(key, params\), display: ui\.display,\n\s*spaceName: id => \{ const room = spaceRecord\(id\); return room \? spaceName\(room\) : null; \} \}\); \}\ncatch \(error\) \{ console\.error\(error\); butlerReads = failedButlerReads\(!window\.nativeWorkspaceButlerReads \? 'module' : !\$\('butler-reads-dialog'\) \? 'element' : 'setup'\); \}\n/);
  // Without the entry on screen the read log does not stay open.
  assert.match(renderer, /if \(\$\('butler-row'\)\?\.hidden === true && \$\('butler-reads-dialog'\)\?\.open\) \$\('butler-reads-dialog'\)\.close\(\);/);
  assert.match(renderer, /openReads: \(\) => openButlerReads\(\),\n/); assert.match(renderer, /\(\) => butlerReads\.dispose\(\),/);
  // The dialog asks the main process for nothing but the existing read of the log.
  const source = read('renderer/butler-reads.js');
  assert.deepEqual([...source.matchAll(/api\.(\w+)\(/g)].map(match => match[1]), ['butlerReview']); assert.ok(source.includes("api.butlerReview('reads', request)"));
  assert.equal(/createElement\('(input|textarea|select|a|form)'\)|make\('(input|textarea|select|a|form)'|innerHTML|localStorage|fetch\(/.test(source), false);
});

for (const language of ['zh', 'en']) test(`read counts explain withheld pages in ${language}`, async t => {
  const f = fixture(few(t), { text: (key, params) => locale.format(language, key, params) });
  await f.reads.open();
  const visible = f.dialog.text();
  assert.match(visible, language === 'zh' ? /因容量不足被扣下、未发给模型的页仍计入每天 64 页/ : /Pages withheld for lack of capacity still count toward the daily 64 pages, even though they were not sent to the model/);
});
