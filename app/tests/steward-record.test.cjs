// 「大管家的记录」 (steward step 2, batch 1): the butler's own steps through NAW, under its own name.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { StewardRecord, view, argumentsOf, cachedSteward } = require('../steward-record.cjs');
const history = require('../record-history.cjs');

const steward = { sessionId: 'butler', nativeId: 'native-butler' };
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

test('every sentence the dialog can show exists in Chinese and English', () => {
  const messages = require('../ui-messages.js'), { bind } = require('../renderer/steward-record.js');
  const shown = bind({ dialog: { addEventListener() {} }, document: {}, api: {} });
  const entries = [
    ...['designated', 'revoked', 'followed', 'started'].map(event => ({ kind: 'role', event, name: 'A' })),
    { kind: 'snapshot', state: 'complete' },
    ...['staged', 'sending', 'consumed', 'submitted', 'unconfirmed', 'not-sent', 'cancelled', 'odd'].map(state => ({ kind: 'message', target: 'B', text: 't', state })),
    { kind: 'invoke', method: 'spaceAction', spaceAction: 'queueAdd', text: 't', space: 'S', target: null, state: 'complete' },
    { kind: 'invoke', method: 'spaceAction', spaceAction: 'queueAdd', text: 't', space: 'S', target: 'B', state: 'complete' },
    { kind: 'invoke', method: 'spaceAction', spaceAction: 'queueCancel', space: 'S', state: 'complete' },
    { kind: 'invoke', method: 'spaceAction', spaceAction: 'queueResolve', space: 'S', state: 'complete' },
    { kind: 'invoke', method: 'spaceAction', spaceAction: 'notes', space: 'S', state: 'complete' },
    { kind: 'invoke', method: 'openSession', target: 'B', state: null },
    { kind: 'invoke', method: 'send', state: 'complete', duplicate: true },
    ...['running', 'complete', 'received', 'awaiting-native', 'confirmation-required', 'cancelled', 'unconfirmed', 'odd'].map(state => ({ kind: 'invoke', method: 'send', state })),
    ...['another-operation-running', 'unknown-command', 'confirmation-limit', 'originating-session-unavailable', 'conversation-access-denied', 'conversation-target-unavailable', 'space-file-membership-required', 'explicit-paths-required', 'odd'].map(reason => ({ kind: 'invoke', method: 'send', state: 'not-executed', reason })),
  ];
  const keys = new Set(['stewardRecord.title', 'stewardRecord.current', 'stewardRecord.none', 'stewardRecord.heading', 'stewardRecord.col.time', 'stewardRecord.col.what', 'stewardRecord.col.result',
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
