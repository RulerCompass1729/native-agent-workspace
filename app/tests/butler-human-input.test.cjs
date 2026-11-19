'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { ButlerIngress } = require('../butler-ingress.cjs');
const { RoomState } = require('../room-state.cjs');
const { StewardWake } = require('../steward-wake.cjs');
const NOW = 1_800_000_000_000;
function fixture(t, now = NOW) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-human-input-')); fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const room = new RoomState(dir), clock = { now }, options = { steward: () => ({ sessionId: 'butler', nativeId: 'native-butler' }), name: s => s.name };
  const open = () => new ButlerIngress(dir, { roomState: room, now: () => clock.now });
  const ingress = open(); clock.now++;
  const message = extra => ({ id: 'human-input-1', role: 'user', origin: 'human', status: 'submitted', time: clock.now, text: 'Synthetic direct instruction', ...extra });
  const member = extra => ({ id: 'member-a', nativeId: 'native-a', name: 'Synthetic member', provider: 'codex', model: 'synthetic-model', state: 'idle', roomIds: ['shared'], roomId: 'shared', messages: [message()], ...extra });
  return { dir, room, clock, options, ingress, open, message, member,
    observe: sessions => ingress.observeHumanInputs(sessions, options), events: () => ingress.ledger.eventsAfter(null).events };
}
for (const origin of ['human', 'human-mobile', 'native-user']) test(origin + ' writes one bounded local notice and restart does not replay it', t => {
  const f = fixture(t), row = f.member({ messages: [f.message({ ...(origin === 'native-user' ? { origin: 'native', inputSource: 'user' } : { origin }), text: '字'.repeat(240) })] });
  f.observe([row]); const events = f.events(); assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'blocked'); assert.equal(events[0].payload.reason, 'human-message');
  assert.equal(events[0].payload.memberId, row.id); assert.equal(events[0].payload.memberName, row.name);
  assert.equal(events[0].payload.title, new Date(f.clock.now).toISOString()); assert.equal(events[0].payload.text, '字'.repeat(200));
  assert.equal(f.ingress.ledger.pendingEvents().length, 0, 'A notification does not open automatic-controller work');
  const bytes = fs.readFileSync(f.ingress.ledger.file);
  f.observe([row, row]);
  f.open().observeHumanInputs([{ ...row, name: 'Renamed', nativeId: 'replacement-native' }], f.options);
  assert.deepEqual(fs.readFileSync(f.ingress.ledger.file), bytes);
});
for (const origin of ['naw-dispatch', 'agent-wake', 'capacity-recovery', 'agent-control', 'room', 'native', undefined, 'future-source']) {
  test('no notice for non-proven human origin ' + origin, t => {
    const f = fixture(t); f.observe([f.member({ messages: [f.message({ origin })] })]); assert.equal(f.events().length, 0);
  });
}
test('conflicting agent evidence, an unsent draft, history and nonmembers do not become human notices', t => {
  const f = fixture(t);
  for (const extra of [{ agentControl: { id: 'agent' } }, { inputSource: 'system' }, { role: 'assistant' }, { time: NOW - 100 }, { time: NOW + 100 }, { text: '' }, { id: '' }]) {
    f.observe([f.member({ messages: [f.message(extra)] })]);
  }
  f.observe([f.member({ messages: [], liveDraft: 'Synthetic unsent words' }), f.member({ id: 'butler' }), f.member({ archived: true }), f.member({ roomIds: [], roomId: null })]);
  f.ingress.observeHumanInputs([f.member({ messages: [f.message()] })], { steward: () => null });
  assert.equal(f.events().length, 0);
});
test('human text quoting a dispatch marker is still human, and Unicode truncation preserves whole characters', t => {
  const f = fixture(t), text = '【NAW 派活】 ' + '😀'.repeat(240);
  f.observe([f.member({ messages: [f.message({ text })] })]);
  assert.equal(f.events().length, 1); assert.equal([...f.events()[0].payload.text].length, 200);
  assert.equal(f.events()[0].payload.text.isWellFormed(), true);
});
test('the notice carries the task active at that input and remains immutable after queue and member changes', t => {
  const f = fixture(t), itemId = f.room.queueAdd('Synthetic queued work', null);
  f.room.queueMarkSent('shared', itemId, 'member-a', 'Synthetic member', NOW - 100, false, 'native-a');
  f.room.queueSetDelivery('shared', itemId, 'dispatch-tag', 0);
  const row = f.member({ messages: [{ id: 'dispatch-tag', role: 'user', origin: 'naw-dispatch', time: NOW - 100, text: 'Synthetic task' }, f.message()] });
  f.observe([row]); assert.equal(f.events()[0].payload.itemId, itemId); assert.equal(f.events()[0].payload.spaceId, 'shared');
  const bytes = fs.readFileSync(f.ingress.ledger.file); f.room.queueSettle('shared', itemId, 'waiting', 'person-intervened', 'Synthetic member');
  f.observe([{ ...row, name: 'Changed name' }]); assert.deepEqual(fs.readFileSync(f.ingress.ledger.file), bytes);
});
test('a current human notice does not invent a link to a task sent after that input', t => {
  const f = fixture(t), itemId = f.room.queueAdd('Synthetic future work', null);
  f.room.queueMarkSent('shared', itemId, 'member-a', 'Synthetic member', NOW + 100, false, 'native-a');
  f.room.queueSetDelivery('shared', itemId, 'later-dispatch', 0);
  f.observe([f.member()]); assert.equal(f.events().length, 1); assert.equal(f.events()[0].payload.itemId, undefined);
});
test('a pruned input anchor can use the current native task and timestamp, but never another native session', t => {
  for (const nativeId of ['native-a', 'other-native']) {
    const f = fixture(t), itemId = f.room.queueAdd('Synthetic long-running work', null);
    f.room.queueMarkSent('shared', itemId, 'member-a', 'Synthetic member', NOW - 100, false, nativeId);
    f.room.queueSetDelivery('shared', itemId, 'pruned-anchor', 0); f.observe([f.member()]);
    assert.equal(f.events()[0].payload.itemId, nativeId === 'native-a' ? itemId : undefined);
  }
});
test('existing secret rejection yields metadata only, without swallowing the human-input fact', t => {
  const f = fixture(t), secret = ['Authorization:', 'Bearer', 'SYNTHETIC_DENIED_TOKEN'].join(' ');
  f.observe([f.member({ messages: [f.message({ text: secret })] })]);
  assert.equal(f.events().length, 1); assert.equal(f.events()[0].payload.text, undefined);
  assert.equal(f.events()[0].payload.reason, 'human-message-content-unavailable');
  assert.ok(!fs.readFileSync(f.ingress.ledger.file, 'utf8').includes(secret));
});
test('history, machine input and a repeated input never read their message bodies', t => {
  const f = fixture(t); let reads = 0;
  const unreadable = extra => Object.defineProperty(f.message(extra), 'text', { get() { reads++; throw Error('Must not read this body'); } });
  f.observe([f.member({ messages: [unreadable({ time: NOW - 1 }), unreadable({ origin: 'native' }), unreadable({ origin: undefined }), unreadable({ origin: 'agent-control' })] })]);
  f.observe([f.member()]); f.observe([f.member({ messages: [unreadable({})] })]);
  assert.equal(reads, 0); assert.equal(f.events().length, 1);
});
test('an actual Workspace send retains its human provenance and reaches local intake without another send', async t => {
  const { Workspace } = require('../workspace.cjs'), { Codex } = require('../adapters.cjs');
  const f = fixture(t, Date.now() - 1), calls = [];
  const host = { binaries: {}, codexTargets: new Map(), close() {}, rpc: { call: async (...args) => { calls.push(args); return { turn: { id: 'synthetic-turn' } }; } } };
  const w = new Workspace(host, f.dir), s = f.member({ messages: [], cwd: f.dir, owner: 'window', view: 'chat', controlRevision: 0, memberRevision: 0 });
  const runtime = new Codex(s, host); w.sessions.set(s.id, s); w.runtimes.set(s.id, runtime); w.bind(s, runtime);
  try {
    const tag = await w.send(s.id, 'Synthetic direct instruction', 'window'); f.clock.now = Date.now() + 1;
    f.observe(w.snapshot().sessions);
    assert.equal(f.events().length, 1); assert.equal(f.events()[0].payload.text, 'Synthetic direct instruction');
    assert.equal(s.messages.find(m => m.id === tag).origin, 'human'); assert.equal(calls.length, 1);
  } finally { await w.close(); }
});
test('native input keeps the existing source=user proof; SDK input is never relabelled as human', async t => {
  const { Workspace } = require('../workspace.cjs'), { Codex } = require('../adapters.cjs');
  const f = fixture(t, Date.now() - 1), host = { binaries: {}, codexTargets: new Map(), close() {}, rpc: {} };
  const w = new Workspace(host, f.dir), s = f.member({ messages: [], cwd: f.dir, owner: 'window', view: 'chat', controlRevision: 0, memberRevision: 0 });
  const runtime = new Codex(s, host); w.sessions.set(s.id, s); w.runtimes.set(s.id, runtime); w.bind(s, runtime);
  try {
    runtime.emit('nativeInput', 'Synthetic native human input', { id: 'native-human', source: 'user' });
    runtime.emit('nativeInput', 'Synthetic SDK input', { id: 'native-sdk', source: 'sdk' });
    f.clock.now = Date.now() + 1; f.observe(w.snapshot().sessions);
    assert.equal(f.events().length, 1); assert.equal(f.events()[0].payload.text, 'Synthetic native human input');
    assert.equal(s.messages.find(m => m.id === 'native-human').inputSource, 'user');
    assert.equal(s.messages.find(m => m.id === 'native-sdk').inputSource, undefined);
  } finally { await w.close(); }
});
test('the existing wake switch sees one notice, sends only its position, and stays off when not enabled', async t => {
  const f = fixture(t), selected = f.options.steward, lines = [], calls = [];
  const wake = new StewardWake(f.dir, { ledger: () => f.ingress.ledger, selected, record: x => lines.push(x), now: () => f.clock.now });
  assert.equal(wake.view().on, false); wake.set(true); f.observe([f.member()]); assert.equal(wake.due(), true);
  const send = async (text, id) => { calls.push({ text, id }); return 'synthetic-tag'; };
  await wake.wake({ id: 'butler', nativeId: 'native-butler' }, 'synthetic-model', send);
  f.observe([f.member()]); await wake.wake({ id: 'butler', nativeId: 'native-butler' }, 'synthetic-model', send);
  assert.equal(calls.length, 1); assert.ok(!calls[0].text.includes('Synthetic direct instruction'));
  wake.set(false); f.observe([f.member({ messages: [f.message({ id: 'human-input-2' })] })]); assert.equal(wake.due(), false);
});
test('Main state intake uses the real observer and preserves the quota event in the same snapshot', t => {
  const f = fixture(t), client = new EventEmitter(), context = { background: true, client, win: { isDestroyed: () => false } };
  const source = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8');
  const bind = source.slice(source.indexOf('function bindClient(context)'), source.indexOf('function displayState('));
  vm.runInNewContext(bind + '\nbindClient(context);', { context, butlerIngress: f.ingress, stewardRole: { current: f.options.steward },
    sessionLabels: { labels: new Map() }, roomState: f.room, broadcastRoom: async () => {} });
  client.emit('state', { sessions: [f.member({ nativeQuota: { kind: 'usage_limit_exceeded', nativeId: 'native-a', turnId: 'quota-turn', model: 'synthetic-model', observedAt: NOW } })] });
  assert.deepEqual(f.events().map(e => e.payload.reason).sort(), ['codex-usage-limit-exceeded', 'human-message']);
});
