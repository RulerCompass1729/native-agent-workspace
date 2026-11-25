// 「大管家的记录」 (steward step 2, batch 1): the butler's own steps through NAW, under its own name.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { StewardRecord, view, argumentsOf, cachedSteward } = require('../steward-record.cjs');
const history = require('../record-history.cjs');

const steward = { sessionId: 'butler', nativeId: 'native-butler' };
test('blocked wake records contain only a bounded reason and time, survive reopening and have human words', t => {
  const f = fixture(t);
  f.record.append({ kind: 'wakeBlocked', since: 0, reason: 'source-unavailable' });
  const rows = view(f.open(), { sessions: [] }).entries;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reason, 'source-unavailable');
  assert.equal(rows[0].minutes, Math.floor(rows[0].at / 60000));
  const ui = require('../renderer/steward-record.js').bind({ dialog: { addEventListener() {} }, document: {}, api: {} });
  assert.deepEqual(ui.what(rows[0]), ['stewardRecord.step.wakeBlocked', {}]);
  assert.deepEqual(ui.result(rows[0]), ['stewardWake.reason.source-unavailable', {}]);
  for (const extra of [{ text: 'PRIVATE BODY' }, { reason: 'PRIVATE BODY' }, { since: -1 }]) {
    assert.throws(() => f.record.append({ kind: 'wakeBlocked', since: 0, reason: 'source-unavailable', ...extra }));
  }
  assert.doesNotMatch(f.disk(), /PRIVATE BODY/u);
});
const sender = (provider = 'claude', over = {}) => ({ id: 'butler', nativeId: 'native-butler', provider, name: 'Claude manager', ...over });
const invoke = (method, args = [], id = 'op-1') => ({ action: 'invoke', method, arguments: args, operation_id: id });
function fixture(t, { current = () => steward, selected = () => steward, now } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-steward-record-')); fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = Date.parse('2026-11-12T10:00:00Z');
  const open = () => new StewardRecord(dir, { steward: current, selected, now: now || (() => clock += 1000) });
  return { dir, open, record: open(), disk: () => fs.readdirSync(path.join(dir, history.HISTORY_DIR, 'steward')).filter(name => history.parseBlockName(name)).map(name => fs.readFileSync(path.join(dir, history.HISTORY_DIR, 'steward', name), 'utf8')).join('') };
}

for (const provider of ['claude', 'codex']) test(`the butler's call is written before it runs and its outcome after, never its value (${provider})`, async t => {
  const f = fixture(t);
  let seenBefore = null;
  const result = await f.record.around(sender(provider), invoke('spaceAction', ['room-a', 'queueAdd', ['Fix the header', null]]), async () => {
    seenBefore = f.disk(); return { id: 'op-1', state: 'complete', value: 'PRIVATE RESULT' };
  });
  assert.equal(result.value, 'PRIVATE RESULT', 'the caller still gets its answer');
  assert.match(seenBefore, /"kind":"step"/, 'the step was on disk before the call ran');
  assert.doesNotMatch(seenBefore, /"kind":"outcome"/);
  const [entry] = f.record.entries().filter(e => e.kind === 'step');
  assert.deepEqual([entry.session.provider, entry.method, entry.operationId, entry.state, entry.recorded], [provider, 'spaceAction', 'op-1', 'complete', true]);
  assert.doesNotMatch(f.disk(), /PRIVATE RESULT/, 'a result is never kept');
});

test('anyone else, and receipts and the catalog, run unrecorded', async t => {
  const f = fixture(t);
  let ran = 0; const run = async () => { ran++; return { state: 'complete' }; };
  await f.record.around(sender('claude', { id: 'other', nativeId: 'native-other' }), invoke('send', ['x', 'hi']), run);
  await f.record.around(sender('claude', { nativeId: 'older-native' }), invoke('send', ['x', 'hi']), run);
  await f.record.around(sender(), { action: 'receipt', operation_id: 'op-1' }, run);
  await f.record.around(sender(), { action: 'catalog' }, run);
  assert.equal(ran, 4);
  assert.deepEqual(f.record.entries().filter(e => e.kind === 'step'), []);
});

test('a snapshot is a step without arguments; a refusal NAW answered without saving is recorded with its reason', async t => {
  const f = fixture(t);
  await f.record.around(sender(), { action: 'snapshot' }, async () => ({ state: 'complete', value: { sessions: ['PRIVATE STATE'] } }));
  await f.record.around(sender(), invoke('send', ['x', 'hi'], 'op-2'), async () => ({ state: 'not-executed', reason: 'another-operation-running', retry: false, method: 'send' }));
  const steps = f.record.entries().filter(e => e.kind === 'step');
  assert.deepEqual(steps.map(s => [s.action, s.method, s.arguments, s.state, s.reason]), [['snapshot', null, null, 'complete', null], ['invoke', 'send', '["x","hi"]', 'not-executed', 'another-operation-running']]);
  assert.doesNotMatch(f.disk(), /PRIVATE STATE/);
});

test('a call that throws keeps its step with an unconfirmed outcome and still throws', async t => {
  const f = fixture(t);
  await assert.rejects(f.record.around(sender(), invoke('openSession', ['x']), async () => { throw Error('Backend went away'); }), /Backend went away/);
  const [step] = f.record.entries().filter(e => e.kind === 'step');
  assert.deepEqual([step.state, step.error], ['unconfirmed', 'Backend went away']);
});

test('when the step cannot be written the call is refused and nothing runs, then and after', async t => {
  const f = fixture(t);
  f.record.log.append = () => { throw Error('Disk full'); };
  let ran = 0;
  await assert.rejects(f.record.around(sender(), invoke('send', ['x', 'hi']), async () => { ran++; }), error => error.uiMessage?.key === 'error.steward.recordUnavailable');
  delete f.record.log.append; // the record stays unusable for this run
  await assert.rejects(f.record.around(sender(), invoke('send', ['x', 'hi'], 'op-2'), async () => { ran++; }), error => error.uiMessage?.key === 'error.steward.recordUnavailable');
  assert.equal(ran, 0);
  // Someone else is not stopped.
  await f.record.around(sender('claude', { id: 'other' }), invoke('send', ['x', 'hi']), async () => { ran++; });
  assert.equal(ran, 1);
});

test('a designation that cannot be read lets the call run, unrecorded', async t => {
  const f = fixture(t, { current: () => { throw Error('Unreadable'); } });
  let ran = false; await f.record.around(sender(), invoke('send', ['x', 'hi']), async () => { ran = true; });
  assert.equal(ran, true); assert.deepEqual(f.record.entries(), []);
});

test('the record survives a restart, and role lines say how the butler came and went', async t => {
  let current = steward, selected = steward;
  const f = fixture(t, { current: () => current, selected: () => selected });
  f.record.designated(steward);
  await f.record.around(sender(), invoke('send', ['x', 'hi']), async () => ({ state: 'complete' }));
  // A rotation hands the role on: the designated session is still the original one.
  current = { sessionId: 'butler-2', nativeId: 'native-2' };
  f.record.sync(current);
  f.record.designated(null); current = null; selected = null;
  f.record.sync(null); // already said
  const again = f.open();
  assert.deepEqual(again.entries().map(e => e.kind === 'role' ? e.event : e.method), ['designated', 'send', 'followed', 'revoked']);
  assert.deepEqual(again.periods().map(p => [p.session.id, p.to !== null]), [['butler', true], ['butler-2', true]]);
});

test('a butler designated before the record existed starts it with a line', async t => {
  const f = fixture(t);
  await f.record.around(sender(), invoke('send', ['x', 'hi']), async () => ({ state: 'complete' }));
  assert.deepEqual(f.record.entries().map(e => e.kind === 'role' ? e.event : e.method), ['started', 'send']);
});

test('copied arguments are bounded and still read as arguments', () => {
  const long = 'x'.repeat(5000), copy = argumentsOf(invoke('spaceAction', ['room', 'queueAdd', [long, null]]));
  const parsed = JSON.parse(copy);
  assert.equal(parsed[2][0].length, 301); assert.ok(copy.length < 2000);
  assert.equal(argumentsOf({ action: 'snapshot' }), null);
});

test('the view: newest first, names from the current state, later states, messages only while the session held the role', async t => {
  const f = fixture(t);
  f.record.designated(steward);
  const designatedAt = f.record.periods()[0].from;
  await f.record.around(sender(), invoke('spaceAction', ['room-a', 'queueAdd', ['Fix the header', 'worker']], 'op-q'), async () => ({ state: 'complete' }));
  await f.record.around(sender(), invoke('readConversation', ['worker'], 'op-r'), async () => ({ state: 'confirmation-required' }));
  const snapshot = {
    room: { id: 'shared', name: 'Shared', messages: [] }, rooms: [{ id: 'room-a', name: 'Website', messages: [] }],
    sessions: [
      { id: 'worker', name: 'Claude front end', messages: [] },
      { id: 'butler', name: 'Claude manager', provider: 'claude', usage: { context: { window: 1 } }, messages: [
        { id: 'w-before', wake: { senderId: 'butler', nativeId: 'native-butler', recipientId: 'worker', body: 'Before it was the butler', time: designatedAt - 5, status: 'submitted' } },
        { id: 'w-after', wake: { senderId: 'butler', nativeId: 'native-butler', recipientId: 'worker', body: 'Take the next item', time: designatedAt + 10_000, status: 'staged' } }] }] };
  const shown = view(f.record, snapshot, { current: steward, stateOf: step => step.operationId === 'op-r' ? { state: 'complete', reason: null } : null });
  assert.deepEqual(shown.current, { id: 'butler', name: 'Claude manager', provider: 'claude', usage: { context: { window: 1 } } });
  const kinds = shown.entries.map(e => e.kind);
  assert.deepEqual(kinds, ['message', 'invoke', 'invoke', 'role']);
  const [message, read, queued, role] = shown.entries;
  assert.deepEqual([message.target, message.text, message.state], ['Claude front end', 'Take the next item', 'staged']);
  assert.deepEqual([read.method, read.target, read.state], ['readConversation', 'Claude front end', 'complete'], 'the state NAW knows now');
  assert.deepEqual([queued.spaceAction, queued.space, queued.text, queued.target], ['queueAdd', 'Website', 'Fix the header', 'Claude front end']);
  assert.equal(role.event, 'designated');
  assert.ok(!JSON.stringify(shown).includes('Before it was the butler'), 'a message from before it was the butler is not its step');
});

test('the steward lookup is read again only when its files change', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-steward-cache-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let reads = 0; const role = { file: path.join(dir, 'steward.json'), logFile: path.join(dir, 'rotation-log.jsonl'), selected: steward, current() { reads++; return steward; } };
  const lookup = cachedSteward(role);
  lookup(); lookup(); assert.equal(reads, 1);
  fs.writeFileSync(role.logFile, '{}\n'); lookup(); assert.equal(reads, 2);
  role.selected = null; lookup(); assert.equal(reads, 3);
});

test('the bell keeps this record like the others', t => {
  const reminders = require('../record-reminders.cjs');
  assert.ok(reminders.RECORDS.includes('steward'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-steward-bell-')); fs.chmodSync(dir, 0o700); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const status = reminders.status(dir, Date.now(), { unavailable: { steward: 'history' } });
  const item = status.records.find(r => r.record === 'steward').items[0];
  assert.deepEqual([item.kind, item.shown], ['unavailable', true]);
  reminders.acknowledge(dir, 'steward', 'unavailable', 1);
  assert.equal(reminders.status(dir, Date.now(), { unavailable: { steward: 'history' } }).records.find(r => r.record === 'steward').items[0].shown, false);
});

// Option A (the integrator, 11-12 21:2x: 「大管家记录里看得到存量和最老等待」).
test('the dialog says how many messages are held for the butler and how long the oldest has waited', async () => {
  const { bind } = require('../renderer/steward-record.js');
  const el = tag => ({ tag, children: [], className: '', textContent: '', dataset: {}, append(...c) { this.children.push(...c); }, replaceChildren(...c) { this.children = c; }, setAttribute() {}, addEventListener() {} });
  const lines = async shown => {
    const dialog = { ...el('dialog'), id: 'd', open: false, showModal() { this.open = true; }, close() {} };
    await bind({ dialog, document: { createElement: el }, api: { stewardRecord: async () => shown } }).open();
    return dialog.children.filter(c => c.className === 'steward-record-waiting').map(c => c.textContent);
  };
  const at = 1_800_000_000_000, base = { current: { id: 'butler', name: 'Butler', provider: 'claude', usage: null }, entries: [], total: 0, at };
  assert.deepEqual(await lines({ ...base, waiting: { count: 2, since: at - 125_000 } }), ['排着等送给大管家的自动消息：2 条，最早一条已等 2 分钟。']);
  assert.deepEqual(await lines({ ...base, waiting: { count: 1, since: at - 5_000 } }), ['排着等送给大管家的自动消息：1 条，最早一条刚排上（不到 1 分钟）。']);
  assert.deepEqual(await lines({ ...base, waiting: null }), []);
  assert.deepEqual(await lines({ ...base, current: null, waiting: { count: 1, since: at } }), [], 'no butler, no line');
});

test('every sentence the dialog can show exists in Chinese and English', () => {
  const messages = require('../ui-messages.js'), { bind } = require('../renderer/steward-record.js');
  const shown = bind({ dialog: { addEventListener() {} }, document: {}, api: {} });
  const entries = [
    ...['designated', 'revoked', 'followed', 'started'].map(event => ({ kind: 'role', event, name: 'A' })),
    { kind: 'snapshot', state: 'complete' },
    { kind: 'snapshot', state: 'complete', read: { target: 'B', messages: 3, through: 1, image: false } },
    { kind: 'snapshot', state: 'not-executed', read: { target: 'B', messages: null, through: null, image: false } },
    { kind: 'invoke', method: 'previewImage', state: 'complete', read: { target: 'B', messages: null, through: null, image: true } },
    { kind: 'invoke', method: 'initial', state: 'complete', read: { gone: true, image: false } },
    { kind: 'invoke', method: 'previewImage', state: 'complete', read: { gone: true, image: true } },
    ...['staged', 'sending', 'consumed', 'submitted', 'unconfirmed', 'not-sent', 'cancelled', 'odd'].map(state => ({ kind: 'message', target: 'B', text: 't', state })),
    { kind: 'invoke', method: 'spaceAction', spaceAction: 'queueAdd', text: 't', space: 'S', target: null, state: 'complete' },
    { kind: 'invoke', method: 'spaceAction', spaceAction: 'queueAdd', text: 't', space: 'S', target: 'B', state: 'complete' },
    { kind: 'invoke', method: 'spaceAction', spaceAction: 'queueCancel', space: 'S', state: 'complete' },
    { kind: 'invoke', method: 'spaceAction', spaceAction: 'queueResolve', space: 'S', state: 'complete' },
    { kind: 'invoke', method: 'spaceAction', spaceAction: 'notes', space: 'S', state: 'complete' },
    { kind: 'invoke', method: 'openSession', target: 'B', state: null },
    { kind: 'invoke', method: 'send', state: 'complete', duplicate: true },
    ...['running', 'complete', 'received', 'awaiting-native', 'confirmation-required', 'cancelled', 'unconfirmed', 'odd'].map(state => ({ kind: 'invoke', method: 'send', state })),
    ...['another-operation-running', 'unknown-command', 'confirmation-limit', 'originating-session-unavailable', 'conversation-access-denied', 'conversation-target-unavailable', 'model-change-unavailable', 'space-file-membership-required', 'explicit-paths-required', 'odd'].map(reason => ({ kind: 'invoke', method: 'send', state: 'not-executed', reason })),
    ...['sent', 'not-sent', 'unconfirmed', null].map(state => ({ kind: 'wake', target: 'B', state })),
    ...['on', 'off', 'check'].map(wake => ({ kind: 'invoke', method: 'stewardWake', wake, state: 'complete' })),
    { kind: 'invoke', method: 'stewardEvents', state: 'complete' },
    { kind: 'wakeSwitch', on: false },
  ];
  const keys = new Set(['stewardRecord.wake.switch', 'stewardRecord.wake.off', 'stewardRecord.wake.never', 'stewardRecord.wake.last', 'stewardRecord.wake.failed', 'stewardRecord.wake.cost', 'stewardRecord.wake.error', 'stewardRecord.title', 'stewardRecord.current', 'stewardRecord.none', 'stewardRecord.waiting', 'stewardRecord.waitingNew', 'stewardRecord.heading', 'stewardRecord.col.time', 'stewardRecord.col.what', 'stewardRecord.col.result',
    'stewardRecord.empty', 'stewardRecord.more', 'stewardRecord.note', 'stewardRecord.writeFailed', 'error.steward.designationUnreadable', 'stewardRecord.usage', 'stewardRecord.usageNone', 'stewardRecord.usageLimit', 'stewardRecord.failed', 'menu.stewardRecord',
    'error.steward.recordUnavailable', 'error.stewardRecord.personOnly', 'error.stewardRecord.unavailable', 'records.name.steward', 'records.item.stewardUnavailable', 'records.item.stewardUnavailableOther']);
  for (const entry of entries) { keys.add(shown.what(entry)[0]); const end = shown.result(entry); if (end) keys.add(end[0]); }
  for (const key of keys) for (const language of ['zh', 'en']) assert.equal(typeof messages[language][key], 'string', `${language} ${key}`);
});

// Review 1 of this batch.
test('a later state is taken only for an open outcome of the same command; an id reused for another command keeps its own', async t => {
  const f = fixture(t);
  await assert.rejects(f.record.around(sender(), invoke('spaceAction', ['room-a', 'queueAdd', ['Reused id', null]], 'op-x'), async () => { throw Error('operation_id already belongs to a different command'); }), /different command/);
  await f.record.around(sender(), invoke('rename', ['worker', 'New name'], 'op-c'), async () => ({ state: 'confirmation-required' }));
  await f.record.around(sender(), invoke('send', ['worker', 'hi'], 'op-d'), async () => ({ state: 'complete', duplicate: true }));
  await f.record.around(sender(), invoke('rename', ['worker', 'Other'], 'op-m'), async () => ({ state: 'confirmation-required' }));
  const later = { 'op-x': { state: 'complete', reason: null, method: 'send' }, 'op-c': { state: 'complete', reason: null, method: 'rename' },
    'op-d': { state: 'received', reason: null, method: 'send' }, 'op-m': { state: 'complete', reason: null, method: 'send' } };
  const steps = Object.fromEntries(f.record.entries({ stateOf: step => later[step.operationId] }).filter(e => e.kind === 'step').map(e => [e.operationId, [e.state, e.duplicate]]));
  assert.deepEqual(steps, { 'op-x': ['unconfirmed', false], 'op-c': ['complete', false], 'op-d': ['complete', true], 'op-m': ['confirmation-required', false] });
});

test('while the designation cannot be read, the butler the record last named is refused; others run', async t => {
  let broken = false;
  const f = fixture(t, { current: () => { if (broken) throw Error('Unreadable'); return steward; } });
  f.record.designated(steward); broken = true;
  let ran = 0;
  await assert.rejects(f.record.around(sender(), invoke('send', ['x', 'hi']), async () => { ran++; }), error => error.uiMessage?.key === 'error.steward.designationUnreadable');
  await f.record.around(sender('claude', { id: 'other', nativeId: 'native-other' }), invoke('send', ['x', 'hi']), async () => { ran++; });
  assert.equal(ran, 1);
});

test('deleting exported blocks keeps who held the role: no new "started" line, and periods hold', async t => {
  const day = 24 * 3600 * 1000; let clock = Date.parse('2026-11-01T10:00:00Z');
  const f = fixture(t, { now: () => clock });
  f.record.designated(steward); clock += 1000;
  await f.record.around(sender(), invoke('send', ['x', 'hi']), async () => ({ state: 'complete' }));
  clock += 2 * day; // the next line seals the first block
  await f.record.around(sender(), invoke('send', ['x', 'again'], 'op-2'), async () => ({ state: 'complete' }));
  const sealed = f.record.log.manifest.blocks.filter(b => b.status === 'sealed').map(b => b.name);
  assert.equal(sealed.length, 1);
  f.record.deleteBlocks(sealed);
  const before = f.record.lines.length;
  f.record.sync(steward);
  assert.equal(f.record.lines.length, before, 'still the butler the record named');
  assert.deepEqual(f.record.periods().map(p => [p.session.id, p.from]), [['butler', Date.parse('2026-11-01T10:00:00Z')]]);
  const reopened = f.open(); assert.equal(reopened.recorded.id, 'butler');
});

test('a successor a rotation handed the role to counts its messages from its start', async t => {
  let current = steward;
  const f = fixture(t, { current: () => current, selected: () => steward });
  f.record.designated(steward);
  current = { sessionId: 'butler-2', nativeId: 'native-2' };
  const early = Date.parse('2026-11-12T09:00:00Z'); // before the line that noticed the rotation
  f.record.sync(current);
  const snapshot = { sessions: [{ id: 'butler-2', name: 'Next', messages: [{ id: 'w', wake: { senderId: 'butler-2', nativeId: 'native-2', recipientId: 'x', body: 'From the successor', time: early, status: 'submitted' } }] }] };
  assert.ok(view(f.record, snapshot, { current }).entries.some(e => e.kind === 'message' && e.text === 'From the successor'));
});

test('long arguments are shortened further, not dropped', () => {
  const args = invoke('spaceAction', ['room', 'notes', Array.from({ length: 12 }, () => 'y'.repeat(500))]);
  const copy = argumentsOf(args); assert.ok(copy); assert.ok(copy.length <= 2000);
  assert.equal(JSON.parse(copy)[2][0].length, 81);
});

test('a record that stopped taking lines while NAW runs still shows what it holds, and says so', async t => {
  const f = fixture(t);
  await f.record.around(sender(), invoke('send', ['x', 'hi']), async () => ({ state: 'complete' }));
  f.record.log.append = () => { throw Error('Disk full'); };
  await assert.rejects(f.record.around(sender(), invoke('send', ['x', 'hi'], 'op-2'), async () => {}));
  const shown = view(f.record, { sessions: [] }, { current: steward });
  assert.equal(shown.writeFailed, true); assert.ok(shown.entries.some(e => e.method === 'send'));
});

// Review 2 of this batch: what the person sees comes from view(), not entries().
test('the view says a repeat was not done again, and a snapshot that asked the person shows the answer', async t => {
  const f = fixture(t);
  await f.record.around(sender(), invoke('send', ['x', 'hi'], 'op-a'), async () => ({ id: 'op-a', state: 'complete' }));
  await f.record.around(sender(), invoke('send', ['x', 'hi'], 'op-a'), async () => ({ id: 'op-a', state: 'complete', duplicate: true }));
  await f.record.around(sender(), { action: 'snapshot' }, async () => ({ id: 'op-given', state: 'confirmation-required' }));
  const asked = [];
  const shown = view(f.record, { sessions: [] }, { current: steward, stateOf: step => { asked.push(step.operationId); return step.operationId === 'op-given' ? { state: 'complete', reason: null, method: 'initial' } : null; } });
  const [snapshot, repeat, first] = shown.entries;
  assert.deepEqual([snapshot.kind, snapshot.state], ['snapshot', 'complete'], 'the person\'s answer, found by the id NAW gave');
  assert.deepEqual([repeat.duplicate, first.duplicate], [true, false]);
  const { bind } = require('../renderer/steward-record.js'), dialog = bind({ dialog: { addEventListener() {} }, document: {}, api: {} });
  assert.equal(dialog.result(repeat)[0], 'stewardRecord.result.duplicate');
  assert.deepEqual(asked, ['op-given'], 'a final outcome is never looked up again');
});

// Reads without the person's confirmation (the person, 2026-11-12 14:24): each read step says whom it read and how far,
// from what NAW ran (a snapshot is pinned to the selected session, whatever was asked), never what it read.
test('a read step says whom it read and how far, from what NAW ran', async t => {
  const f = fixture(t);
  await f.record.around(sender(), { action: 'snapshot' }, async () => ({ id: 'op-read', state: 'complete', value: 'PRIVATE BODY' }));
  await f.record.around(sender(), invoke('initial', ['asked-for'], 'op-pinned'), async () => ({ id: 'op-pinned', state: 'complete' }));
  await f.record.around(sender(), invoke('previewImage', [{ kind: 'session', sessionId: 'worker' }], 'op-image'), async () => ({ id: 'op-image', state: 'complete' }));
  await f.record.around(sender(), { action: 'snapshot' }, async () => ({ state: 'complete' }));
  await f.record.around(sender(), invoke('send', ['worker', 'hi'], 'op-send'), async () => ({ id: 'op-send', state: 'complete' }));
  const through = Date.parse('2026-11-12T09:58:00Z'), asked = [];
  const reads = { 'op-read': { sessionId: 'worker', name: 'Old name', messages: 40, through, unasked: true }, 'op-pinned': { sessionId: 'gone', name: 'Gone one', messages: 2, through: null },
    'op-image': { sessionId: 'worker' }, 'op-send': { sessionId: 'worker' } };
  const shown = view(f.record, { sessions: [{ id: 'worker', name: 'Worker' }, { id: 'asked-for', name: 'Asked for' }] }, { current: steward, readOf: step => { asked.push(step.operationId); return reads[step.operationId]; } });
  const [send, own, image, pinned, read] = shown.entries;
  assert.deepEqual(read.read, { target: 'Worker', image: false, messages: 40, through, unasked: true });
  assert.deepEqual(pinned.read, { target: 'Gone one', image: false, messages: 2, through: null, unasked: false }, 'the session NAW read, not the one asked for');
  assert.equal(pinned.target, undefined);
  assert.equal(image.read.image, true); assert.equal(own.read, undefined, 'a snapshot of NAW itself has no read');
  assert.equal(send.read, undefined); assert.equal(send.target, 'Worker');
  assert.deepEqual(asked.sort(), ['op-image', 'op-pinned', 'op-read'], 'only read steps are looked up');
  assert.doesNotMatch(JSON.stringify(shown), /PRIVATE BODY/);
  const { bind } = require('../renderer/steward-record.js'), dialog = bind({ dialog: { addEventListener() {} }, document: {}, api: {} });
  const now = Date.parse('2026-11-12T10:30:00Z'), local = new Date(through), hm = `${String(local.getHours()).padStart(2, '0')}:${String(local.getMinutes()).padStart(2, '0')}`;
  assert.deepEqual(dialog.what(read, now), ['stewardRecord.step.readThrough', { target: 'Worker', count: 40, through: hm }]);
  assert.deepEqual(dialog.what(pinned, now), ['stewardRecord.step.read', { target: 'Gone one' }]);
  assert.deepEqual(dialog.what(image, now), ['stewardRecord.step.readImage', { target: 'Worker' }]);
  assert.deepEqual(dialog.what(own, now), ['stewardRecord.step.snapshot', {}]);
  // The person deleted that operation's record: the step says a conversation was read, never a name it may not have read.
  const gone = view(f.record, { sessions: [{ id: 'asked-for', name: 'Asked for' }] }, { current: steward, readOf: step => step.operationId === 'op-pinned' || step.operationId === 'op-image' ? { gone: true } : null });
  const goneImage = gone.entries.find(entry => entry.method === 'previewImage'), gonePinned = gone.entries.find(entry => entry.method === 'initial');
  assert.deepEqual(gonePinned.read, { gone: true, image: false }); assert.equal(gonePinned.target, undefined);
  assert.deepEqual(dialog.what(gonePinned, now), ['stewardRecord.step.readGone', {}]);
  assert.deepEqual(dialog.what(goneImage, now), ['stewardRecord.step.readImageGone', {}]);
});
test('the record knows which running call it wrote as a step, and of whom', async t => {
  const f = fixture(t), other = { id: 'other', nativeId: 'native-other' };
  const seen = [];
  await f.record.around(sender(), { action: 'snapshot' }, async () => { await new Promise(resolve => setImmediate(resolve)); seen.push(f.record.recording(sender()), f.record.recording(other)); return { state: 'complete' }; });
  await f.record.around(sender('claude', other), { action: 'snapshot' }, async () => { seen.push(f.record.recording(other)); return { state: 'complete' }; });
  assert.deepEqual(seen, [true, false, false], 'only the butler\'s own recorded call; a call that was not written is not one');
  assert.equal(f.record.recording(sender()), false, 'nothing once the call is over');
  // A timer made during the butler's recorded call keeps its store, but is not that call once it has ended.
  let later;
  await f.record.around(sender(), { action: 'snapshot' }, async () => { later = new Promise(resolve => setTimeout(() => resolve(f.record.recording(sender())), 5)); return { state: 'complete' }; });
  assert.equal(await later, false, 'a timer the call left behind is not the call');
});

// NAW's switch for waking the butler, in the person's own window (the approved words for the butler: 「看得见、能关」;
// independent review note 5 of stewardWake: only the butler could turn it on or off).
function wakeDialog(shown, wakeCalls) {
  const { bind } = require('../renderer/steward-record.js');
  const el = tag => ({ tag, children: [], className: '', textContent: '', dataset: {}, attrs: {}, listeners: {}, hidden: false, checked: false, disabled: false,
    append(...c) { this.children.push(...c); }, replaceChildren(...c) { this.children = c; }, setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(type, f) { this.listeners[type] = f; } });
  const dialog = { ...el('dialog'), id: 'd', open: false, showModal() { this.open = true; }, close() {} };
  const api = { stewardRecord: async () => shown, stewardWake: async (...args) => { wakeCalls.push(args); return wakeCalls.answer(...args); } };
  return { dialog, open: () => bind({ dialog, document: { createElement: el }, api }).open() };
}
const all = node => [node, ...(node.children || []).flatMap(all)];
const find = (dialog, test) => all(dialog).filter(test);
// A step's line as the person reads it: what, result, and whether it stands out.
const stepLine = row => [find(row, n => n.className === 'disclosure-title')[0].textContent, find(row, n => n.className === 'disclosure-end')[0].textContent, row.className.split(' ').includes('attention') ? 'attention' : ''];

test('the person sees whether NAW wakes the butler and when it last tried, and can turn it on and off in place', async () => {
  const at = new Date(2026, 10, 13, 15, 0).getTime(), base = { current: { id: 'butler', name: 'Butler', provider: 'claude', usage: null }, entries: [], total: 0, at };
  const states = async (wake, current = base.current) => {
    const calls = []; calls.answer = () => { throw Error('not called'); };
    const d = wakeDialog({ ...base, current, wake }, calls); await d.open();
    const [box] = find(d.dialog, n => n.className === 'steward-record-wake'); if (!box) return null;
    const [input] = find(box, n => n.type === 'checkbox'), [status] = find(box, n => n.className === 'steward-record-wake-status');
    return [input.checked, status.textContent, find(box, n => n.tag === 'span' && n.textContent === 'NAW 记下新事件时唤醒它').length, find(box, n => n.textContent === '每次唤醒它会跑一轮，算进下面的用量；最多每分钟一次，它在忙时不唤醒。').length];
  };
  assert.deepEqual(await states({ on: false, at: null, failed: false }), [false, '关着', 1, 1]);
  assert.deepEqual(await states({ on: true, at: null, failed: false }), [true, '开着 · 还没唤醒过', 1, 1]);
  assert.deepEqual(await states({ on: true, at: at - 3_600_000, failed: false }), [true, '开着 · 上次尝试唤醒 14:00', 1, 1]);
  assert.deepEqual(await states({ on: true, at: at - 86_400_000, failed: false }), [true, '开着 · 上次尝试唤醒 11-12 15:00', 1, 1], 'an earlier day says the day');
  assert.deepEqual(await states({ on: false, at: null, failed: true }), [false, '它的设置没存好，现在按关处理；重新勾上就能用', 1, 1]);
  assert.equal(await states(null), null, 'not known: no switch');
  assert.equal(await states({ on: false, at: null, failed: false }, null), null, 'no butler: no switch');

  // Ticking it asks NAW to turn it on, and shows what NAW answers; unticking turns it off.
  const calls = []; let pending;
  calls.answer = on => new Promise(resolve => { pending = () => resolve(on === undefined ? { on: false, at: null, failed: false } : { on, at: null, failed: false }); });
  const d = wakeDialog({ ...base, wake: { on: false, at: null, failed: false } }, calls); await d.open();
  const [input] = find(d.dialog, n => n.type === 'checkbox'), [status] = find(d.dialog, n => n.className === 'steward-record-wake-status');
  input.checked = true; const turning = input.listeners.change();
  assert.equal(input.disabled, true, 'not clicked twice while NAW answers');
  pending(); await turning;
  assert.deepEqual(calls.slice(), [[true]]);
  assert.deepEqual([input.checked, input.disabled, status.textContent], [true, false, '开着 · 还没唤醒过']);
  input.checked = false; const off = input.listeners.change(); pending(); await off;
  assert.deepEqual(calls.slice(), [[true], [false]]);
  assert.deepEqual([input.checked, status.textContent], [false, '关着']);

  // Refused: says why, and shows how it stands from NAW, not as ticked.
  const refused = []; refused.answer = on => { if (on !== undefined) throw Error('还没有指定大管家，事件唤醒开不了。'); return { on: false, at: null, failed: false }; };
  const r = wakeDialog({ ...base, wake: { on: false, at: null, failed: false } }, refused); await r.open();
  const [box] = find(r.dialog, n => n.className === 'steward-record-wake'), [tick] = find(box, n => n.type === 'checkbox'), [alert] = find(box, n => n.attrs.role === 'alert');
  assert.equal(alert.hidden, true);
  tick.checked = true; await tick.listeners.change();
  assert.deepEqual(refused.slice(), [[true], []]);
  assert.deepEqual([tick.checked, tick.disabled, alert.hidden, alert.textContent], [false, false, false, '开关没改成：还没有指定大管家，事件唤醒开不了。']);

  // Neither the change nor the read answers: the box goes back, the alert says it was not changed, and the status keeps
  // the last state NAW gave rather than the one asked for.
  const silent = []; silent.answer = () => { throw Error('NAW 后台没有回应。'); };
  const q = wakeDialog({ ...base, wake: { on: true, at: null, failed: false } }, silent); await q.open();
  const [qbox] = find(q.dialog, n => n.className === 'steward-record-wake'), [qtick] = find(qbox, n => n.type === 'checkbox'),
    [qalert] = find(qbox, n => n.attrs.role === 'alert'), [qstatus] = find(qbox, n => n.className === 'steward-record-wake-status');
  // The status is read out with the switch.
  assert.deepEqual([qtick.attrs['aria-describedby'], qstatus.id], ['d-wake-status', 'd-wake-status']);
  qtick.checked = false; await qtick.listeners.change();
  assert.deepEqual(silent.slice(), [[false], []]);
  assert.deepEqual([qtick.checked, qtick.disabled, qalert.hidden, qalert.textContent, qstatus.textContent], [true, false, false, '开关没改成：NAW 后台没有回应。', '开着 · 还没唤醒过']);
});

test('NAW\'s wakes of the butler are rows of the record, under NAW\'s name, with whether they went out', async t => {
  const f = fixture(t);
  f.record.append({ kind: 'wake', id: 'w1', session: { id: 'butler', nativeId: 'native-butler' }, position: null });
  f.record.append({ kind: 'outcome', step: 'w1', state: 'sent', reason: null, error: null, duplicate: false, operationId: 'tag-1' });
  f.record.append({ kind: 'wake', id: 'w2', session: { id: 'gone-session-id', nativeId: 'native-gone' }, position: '0123456789abcdef:4' });
  f.record.append({ kind: 'outcome', step: 'w2', state: 'not-sent', reason: null, error: 'x'.repeat(300), duplicate: false, operationId: null });
  f.record.append({ kind: 'wake', id: 'w3', session: { id: 'butler', nativeId: 'native-butler' }, position: '0123456789abcdef:4' });
  const snapshot = { sessions: [{ id: 'butler', name: 'Butler', messages: [] }] };
  const shown = view(f.record, snapshot, { current: steward, wake: { on: true, at: 5, failed: false, extra: 'x' } });
  assert.deepEqual(shown.entries.filter(e => e.kind === 'wake').map(e => [e.target, e.state, e.recorded, e.error && e.error.length]),
    [['Butler', null, false, null], ['gone-ses', 'not-sent', true, 300], ['Butler', 'sent', true, null]], 'newest first; a name from now, or the id');
  assert.equal(JSON.stringify(shown.entries).includes('0123456789abcdef'), false, 'not the position it named');
  assert.deepEqual(shown.wake, { on: true, at: 5, failed: false });
  assert.equal(view(f.record, snapshot, { current: steward }).wake, null);
  assert.equal(view(f.record, snapshot, { current: steward, wake: { on: 'yes' } }).wake, null);

  // In the dialog: what NAW did and whether it went out; one that did not, or whose outcome is missing, stands out.
  const calls = []; calls.answer = () => { throw Error('not called'); };
  const d = wakeDialog(shown, calls); await d.open();
  const rows = find(d.dialog, n => n.tag === 'li' && n.dataset.kind === 'wake');
  assert.deepEqual(rows.map(stepLine),
    [['NAW 唤醒 Butler 来读新事件', '结果没有记下', 'attention'], ['NAW 唤醒 gone-ses 来读新事件', '没有发出', 'attention'], ['NAW 唤醒 Butler 来读新事件', '已发出', '']]);
});

// The board, 11:18:30: the butler's calls on the wake switch read as words, and the person turning it off is a line.
test('what the butler did with the wake switch reads as words, and the person turning it off is a line of the record', async t => {
  const f = fixture(t);
  const done = id => async () => ({ id, state: 'complete', value: { on: true } });
  await f.record.around(sender(), invoke('stewardWake', [true], 'op-on'), done('op-on'));
  await f.record.around(sender(), invoke('stewardWake', [], 'op-check'), done('op-check'));
  await f.record.around(sender(), invoke('stewardEvents', ['0123456789abcdef:1'], 'op-events'), done('op-events'));
  await f.record.around(sender(), invoke('stewardWake', [false], 'op-off'), done('op-off'));
  await f.record.around(sender(), invoke('stewardWake', ['yes'], 'op-odd'), async () => ({ id: 'op-odd', state: 'not-executed', reason: 'odd' }));
  f.record.wakeOff();
  const shown = view(f.record, { sessions: [{ id: 'butler', name: 'Butler', messages: [] }] }, { current: steward });
  assert.deepEqual(shown.entries.filter(e => e.kind !== 'role').map(e => [e.kind, e.method, e.wake, e.target, e.on]), [
    ['wakeSwitch', undefined, undefined, undefined, false], ['invoke', 'stewardWake', null, undefined, undefined], ['invoke', 'stewardWake', 'off', undefined, undefined],
    ['invoke', 'stewardEvents', undefined, undefined, undefined], ['invoke', 'stewardWake', 'check', undefined, undefined], ['invoke', 'stewardWake', 'on', undefined, undefined]]);
  assert.equal(JSON.stringify(shown.entries).includes('0123456789abcdef'), false, 'not the position it read from');
  // Survives a restart as written.
  assert.deepEqual(f.open().entries().filter(e => e.kind === 'wakeSwitch').map(e => [e.on, typeof e.at]), [[false, 'number']]);
  // Only as NAW writes it: off, and nothing else.
  const { check } = require('../steward-record.cjs'), at = Date.parse('2026-11-13T10:00:00Z');
  check({ kind: 'wakeSwitch', at, on: false });
  for (const line of [{ kind: 'wakeSwitch', at, on: true }, { kind: 'wakeSwitch', at, on: false, by: 'agent' }, { kind: 'wakeSwitch', at }, { kind: 'wakeSwitch', on: false }])
    assert.throws(() => check(line), /Invalid steward record line/);

  const calls = []; calls.answer = () => { throw Error('not called'); };
  const d = wakeDialog(shown, calls); await d.open();
  const rows = find(d.dialog, n => n.tag === 'li' && n.dataset.kind && n.dataset.kind !== 'role').map(stepLine);
  assert.deepEqual(rows, [['你关掉了事件唤醒', '', ''], ['stewardWake', rows[1][1], 'attention'], ['它关掉了事件唤醒', '完成', ''], ['它读了 NAW 记下的事件', '完成', ''],
    ['它查看了唤醒设置', '完成', ''], ['它打开了事件唤醒', '完成', '']], 'an argument NAW does not know keeps the command name');
});
