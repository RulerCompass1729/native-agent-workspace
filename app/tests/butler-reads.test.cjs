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
  showModal() { this.open = true; }
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
function fixture(log, { fail = () => false, display, text, storage, now = () => NOW, spaceName = id => ({ shared: '默认空间', [SPACE]: '发版准备' })[id], breakTable = () => false } = {}) {
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
      const found = state.log.filter(record => record.sequence > afterSequence).slice(0, limit), nextAfterSequence = found.at(-1)?.sequence ?? afterSequence;
      return { records: found, throughSequence: through, nextAfterSequence, truncated: nextAfterSequence < through, ...(storage ? { storage: storage() } : {}) };
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

test('pages written while the log is being read are followed, a bounded number of times', async t => {
  const log = many(t, 200);
  // Between the first call and the tail call the butler reads more: the tail is no longer the end.
  const grow = fixture(log.slice(0, 60), { fail: count => { if (count === 2) grow.state.log = log.slice(0, 75); return false; } });
  await grow.reads.open();
  assert.deepEqual(grow.requests(), [{ afterSequence: 0, limit: 50 }, { afterSequence: 10, limit: 50 }, { afterSequence: 60, limit: 50 }]); assert.equal(grow.rows().length, 65); assert.equal(grow.listed().textContent, '共 75 条，下面是最新的 65 条。');
  assert.equal(grow.today().hidden, false, 'With the newest record on screen the day\'s count is known');
  // A log that keeps growing faster than it is read: the reading stops, and neither today's count nor "the newest" is claimed.
  const sizes = [60, 120, 180, 200], racing = fixture(log.slice(0, 60), { fail: count => { racing.state.log = log.slice(0, sizes[Math.min(count, sizes.length) - 1]); return false; } });
  await racing.reads.open();
  assert.deepEqual(racing.requests(), [{ afterSequence: 0, limit: 50 }, { afterSequence: 10, limit: 50 }, { afterSequence: 60, limit: 50 }, { afterSequence: 110, limit: 50 }], 'One first page, one tail, at most two more');
  assert.deepEqual([racing.rows().length, racing.today().hidden, racing.dialog.dataset.readsLevel, racing.listed().textContent], [150, true, 'unknown', '共 200 条，下面显示了其中 150 条；还有更新的没读到，点「刷新」再读。']);
  // With a record this version does not understand among them, both things are still said.
  const odd = log.map((record, index) => index === 30 ? { ...record, version: 2 } : record), mixed = fixture(odd.slice(0, 60), { fail: count => { mixed.state.log = odd.slice(0, sizes[Math.min(count, sizes.length) - 1]); return false; } });
  await mixed.reads.open();
  assert.deepEqual([mixed.rows().length, mixed.listed().textContent, mixed.notes()], [149, '共 200 条，下面显示了其中 149 条；还有更新的没读到，点「刷新」再读。', ['有 1 条记录这一版看不懂，没有显示。']]);
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

test('whatever fails while drawing what was read, the dialog says the log could not be read and never stays on "reading"', async t => {
  let broken = true; const f = fixture(few(t), { breakTable: () => broken }); await f.reads.open();
  assert.equal(f.dialog.dataset.readsState, 'unavailable'); assert.deepEqual(f.notes(), [zh('butler.reads.unavailable'), zh('butler.reads.unavailableHelp')]);
  assert.deepEqual([f.rows().length, f.button('refresh').disabled, f.button('refresh').textContent, f.today().hidden], [0, false, '再读一次', true]);
  broken = false; await f.button('refresh').fire('click'); assert.deepEqual([f.dialog.dataset.readsState, f.rows().length], ['records', 5]);
  // The same for a clock that cannot be read when the log arrives.
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
  assert.deepEqual([none.rows().length, none.notes(), none.listed().hidden, none.today().hidden], [0, ['有 5 条记录这一版看不懂，没有显示。'], true, true]);
});

test('a newest record that was read but is not understood is not called "not reached", and Refresh is not offered as a cure', async t => {
  // The core accepts a delivery lookup whose time window lies far beyond any real date; no calendar can show it.
  const log = records(t, page => { page(NOW - 10 * MINUTE, 'queue', { spaceId: SPACE, count: 3 }); page(NOW - 5 * MINUTE, 'spaces', { count: 1 }); page(NOW - MINUTE, 'deliveries', { spaceId: SPACE, count: 0, window: [8.64e15 - DAY, 8.64e15] }); });
  assert.equal(log.length, 3); assert.equal(log[2].query.throughTime, 8.64e15, 'Written and read back by the real module');
  const f = fixture(log); await f.reads.open();
  assert.deepEqual([f.dialog.dataset.readsState, f.rows().length, f.listed().textContent, f.notes(), f.today().hidden], ['records', 2, '共 3 条，下面显示了其中 2 条；另外 1 条这一版看不懂，没有显示。', [], true]);
  assert.equal(f.dialog.text().includes('刷新」再读'), false);
});

test('the log file filling up is said beside the day\'s count, in the core\'s own words about when', async t => {
  const MIB = 1024 * 1024, report = used => ({ usedBytes: used, maxBytes: 32 * MIB, remainingBytes: 32 * MIB - used, warningThresholdBytes: 24 * MIB, warning: used >= 24 * MIB });
  const log = few(t);
  // No report at all (an older core), or no warning: nothing is said.
  for (const storage of [undefined, () => report(5 * MIB), () => report(24 * MIB - 1), () => ({ ...report(30 * MIB), warning: false }), () => ({ usedBytes: 9, maxBytes: 2, remainingBytes: 0, warning: true }), () => 'nearly full']) {
    const f = fixture(log, { storage }); await f.reads.open(); assert.deepEqual([f.full().hidden, f.full().textContent, f.dialog.dataset.readsState, f.rows().length], [true, '', 'records', 5]);
  }
  let used = 24 * MIB; const f = fixture(log, { storage: () => report(used) }); await f.reads.open();
  assert.equal(f.full().hidden, false); assert.equal(f.full().attributes.role, 'status');
  assert.equal(f.full().textContent, zh('butler.reads.storageWarning', { used: '24', max: '32' })); assert.ok(f.full().textContent.startsWith('记录文件快满了：已用 24 MiB，上限 32 MiB。到上限后大管家读不到任何'));
  assert.equal(f.today().textContent, '从 11-10 16:00 起已读 5 页，还剩 59 页。每天最多 64 页，11-11 16:00 重新计。', 'The day\'s count is still given; the warning says why it may not be usable');
  // Shown to one decimal and never emptier than it is.
  for (const [bytes, shown] of [[24 * MIB + 1, '24.1'], [25.04 * MIB, '25.1'], [31.5 * MIB, '31.5']]) { used = Math.floor(bytes); await f.button('refresh').fire('click'); assert.equal(f.full().textContent, zh('butler.reads.storageWarning', { used: shown, max: '32' }), String(bytes)); }
  // At the cap, or closer to it than the largest record, it is not "nearly": the butler's reads can be refused, and at the cap all are.
  for (const [bytes, shown, key] of [[32 * MIB - 128 * 1024, '31.9', 'storageWarning'], [32 * MIB - 128 * 1024 + 1, '31.9', 'storageFull'], [31.99 * MIB, '32', 'storageFull'], [32 * MIB, '32', 'storageFull']]) {
    used = Math.floor(bytes); await f.button('refresh').fire('click'); assert.equal(f.full().textContent, zh(`butler.reads.${key}`, { used: shown, max: '32' }), String(bytes)); }
  assert.ok(f.full().textContent.startsWith('记录文件已经到上限，或离上限不到一条记录的最大长度：已用 32 MiB，上限 32 MiB。从这里起大管家的读取可能被拒绝（一页的记录放不下就拒绝，通常先是返回条数多的页），到上限后全部被拒绝，')); assert.equal(f.full().textContent.includes('快满'), false);
  // What the sentence says about when a page is refused is the core's own rule: a page's record must fit in what is left.
  assert.ok(fs.readFileSync(path.join(__dirname, '..', 'butler-read-audit.cjs'), 'utf8').includes("if (bytes.length > MAX_RECORD_BYTES || (loaded.identity?.size || 0) + bytes.length > MAX_FILE_BYTES) fail('CAPACITY');"));
  // A full file is said even if a report should ever carry no warning with it.
  const odd = fixture(log, { storage: () => ({ ...report(32 * MIB), warning: false }) }); await odd.reads.open(); assert.equal(odd.full().textContent, zh('butler.reads.storageFull', { used: '32', max: '32' }));
  // The report is the newest answer's: once the file is no longer warned about, or cannot be read, the sentence goes.
  used = 3 * MIB; await f.button('refresh').fire('click'); assert.equal(f.full().hidden, true);
  used = 26 * MIB; await f.button('refresh').fire('click'); assert.equal(f.full().hidden, false); f.dialog.close();
  const g = fixture(log, { storage: () => report(26 * MIB), fail: count => count > 1 }); await g.reads.open(); assert.equal(g.full().hidden, false);
  await g.button('refresh').fire('click'); assert.deepEqual([g.dialog.dataset.readsState, g.full().hidden, g.full().textContent], ['unavailable', true, '']);
  // The report that comes with earlier records is newer than the one the dialog opened with.
  let size = 3 * MIB; const h = fixture(many(t), { storage: () => report(size) }); await h.reads.open(); assert.equal(h.full().hidden, true);
  size = 27 * MIB; await h.button('older').fire('click'); assert.equal(h.full().textContent, zh('butler.reads.storageWarning', { used: '27', max: '32' }));
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
  const nearlyFull = () => ({ usedBytes: 25 * 1048576, maxBytes: 32 * 1048576, remainingBytes: 7 * 1048576, warningThresholdBytes: 24 * 1048576, warning: true });
  const atCap = () => ({ usedBytes: 32 * 1048576, maxBytes: 32 * 1048576, remainingBytes: 0, warningThresholdBytes: 24 * 1048576, warning: true });
  for (const [value, options, after] of [[log], [[]], [full], [plain], [log, { storage: nearlyFull }], [log, { storage: atCap }], [log, { fail: () => true }], [log.map(r => ({ ...r, version: 2 }))], [log.map((r, i) => i ? r : { ...r, version: 2 })],
    [long, { fail: count => count > 1 && { answer: { records: long.slice(40, 60), throughSequence: 96, nextAfterSequence: 60, truncated: true } } }],
    [long, { fail: (count, options) => options.limit === 46 }, f => f.button('older').fire('click')]]) {
    const f = fixture(value, { ...options, text: record('zh') }); const opening = f.reads.open(); asked.add('butler.reads.loading'); await opening; if (after) await after(f);
  }
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

test('the page loads the view before the dialog and the dialog before the renderer, which gives it this window\'s space names', () => {
  const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8'), html = read('renderer/index.html'), build = fs.readFileSync(path.join(__dirname, '../../scripts/build-ui.cjs'), 'utf8'), renderer = read('renderer/renderer.js');
  for (const positions of [['src="../butler-reads-view.js"', 'src="butler-reads.js"', 'src="renderer.js"'].map(name => html.indexOf(name)), ["read('app/butler-reads-view.js')", "'butler-reads.js'", "'renderer.js'"].map(name => build.indexOf(name))])
    assert.ok(positions.every(value => value > 0) && positions[0] < positions[1] && positions[1] < positions[2]);
  assert.match(html, /<dialog closedby="any" id="butler-reads-dialog" class="butler-reads"><\/dialog>/);
  assert.match(renderer, /const butlerReads = window\.nativeWorkspaceButlerReads\.bind\(\{ dialog: \$\('butler-reads-dialog'\), document, api, text: \(key, params\) => uiText\(key, params\), display: ui\.display,\n\s*spaceName: id => \{ const room = spaceRecord\(id\); return room \? spaceName\(room\) : null; \} \}\);/);
  assert.match(renderer, /openReads: \(\) => butlerReads\.open\(\),\n/); assert.match(renderer, /\(\) => butlerReads\.dispose\(\),/);
  // The dialog asks the main process for nothing but the existing read of the log.
  const source = read('renderer/butler-reads.js');
  assert.deepEqual([...source.matchAll(/api\.(\w+)\(/g)].map(match => match[1]), ['butlerReview']); assert.ok(source.includes("api.butlerReview('reads', request)"));
  assert.equal(/createElement\('(input|textarea|select|a|form)'\)|make\('(input|textarea|select|a|form)'|innerHTML|localStorage|fetch\(/.test(source), false);
});
