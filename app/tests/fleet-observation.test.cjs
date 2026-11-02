const test = require('node:test'), assert = require('node:assert/strict');
const { observedFleet, fleetStatus, backgroundWork, workTone } = require('../renderer/fleet-observation.js');
const event = (kind, rest = {}) => ({ event: 'subAgentActivity', nativeId: 'child-a', name: '/root/check', kind, stale: false, ...rest });
const record = fleet => ({ state: 'idle', fleet });

test('root reply and child tool acknowledgement do not declare the child done', () => {
  const s = record([event('started', { model: 'synthetic-small' })]);
  assert.equal(observedFleet(s).running, 1);
  assert.equal(fleetStatus(s, '就绪'), '主会话就绪 · 1 个子任务进行中');
  s.fleet.push({ event: 'TaskCompleted', id: 'child-a', stale: false });
  assert.equal(observedFleet(s).running, 1, 'Task ID is not agent lifecycle identity');
  s.fleet.push(event('completed', { model: null }));
  assert.equal(observedFleet(s).running, 0);
  assert.equal(observedFleet(s).children[0].status, 'completed');
  assert.equal(observedFleet(s).children[0].model, 'synthetic-small');
  assert.equal(fleetStatus(s, '就绪'), '主会话就绪', 'No fleet-wide completion claim');
});

test('native identity separates same names; followup completion only updates its own child', () => {
  const s = record([event('started'), event('started', { nativeId: 'child-b' }), event('completed'), event('interacted')]);
  assert.equal(observedFleet(s).children.length, 2);
  assert.equal(observedFleet(s).running, 1);
  assert.equal(observedFleet(s).unknown, 1, 'Contacting an idle child does not prove a turn started');
});

test('recent child rows follow the latest observed event, including an older child', () => {
  const s = record(Array.from({ length: 9 }, (_, i) => event('started', { nativeId: `child-${i}` })));
  s.fleet.push(event('completed', { nativeId: 'child-0' }));
  assert.equal(observedFleet(s).children.slice(-8).at(-1).id, 'child-0');
  assert.equal(observedFleet(s).children.at(-1).status, 'completed');
});

test('connection gaps and legacy records cannot report historical activity as live', () => {
  for (const s of [record([event('started', { stale: undefined })]), record([event('started', { stale: true })]),
    { ...record([event('started')]), state: 'recoverable' }, { ...record([event('started')]), transportDisconnected: true }]) {
    assert.equal(observedFleet(s).running, 0); assert.equal(observedFleet(s).unknown, 1);
  }
  assert.equal(observedFleet(record([event('started')]), false).unknown, 1);
  assert.equal(observedFleet(record([{ event: 'collabAgentToolCall', active: true }])).observed, true);
  assert.equal(observedFleet(record([{ event: 'collabAgentToolCall', active: true }])).children.length, 0);
});

test('Claude idle/task hooks do not end an observed subagent; explicit Stop does', () => {
  const s = record([{ event: 'SubagentStart', id: 'native-child', name: 'check', stale: false },
    { event: 'TeammateIdle', id: 'native-child', stale: false }]);
  assert.equal(observedFleet(s).running, 1);
  s.fleet.push({ event: 'SubagentStop', id: 'native-child', stale: false });
  assert.equal(observedFleet(s).children[0].status, 'completed');
});

test('actual Codex start/completed envelope describes the activity, not child completion', () => {
  const { Codex } = require('../adapters.cjs');
  const runtime = new Codex({ nativeId: 'root', state: 'idle' }, { codexTargets: new Map() });
  const progress = [], fleet = []; runtime.on('progress', p => progress.push(p)); runtime.on('fleet', p => fleet.push(p));
  for (const method of ['item/started', 'item/completed']) runtime.event({ method, params: {
    threadId: 'root', turnId: 'root-turn', item: { type: 'subAgentActivity', id: 'spawn-tool', kind: 'started', agentThreadId: 'child', agentPath: '/root/check' },
  } });
  assert.equal(progress.length, 2); assert.ok(progress.every(p => p.status === 'observed' && p.title.includes('started')));
  assert.equal(fleet.length, 1); assert.equal(fleet[0].active, true);
});

test('a turn-end report of in-flight background work replaces ready and the green dot', () => {
  const s = { state: 'idle', fleet: [], background: 1, backgroundKinds: ['shell'], backgroundAt: 100 };
  assert.equal(fleetStatus(s, '就绪'), '后台任务在跑 · 1 项（命令）'); assert.equal(workTone(s), 'bg-work');
  Object.assign(s, { background: 3, backgroundKinds: ['shell', 'subagent', 'shell'] });
  assert.equal(fleetStatus(s, '就绪'), '后台任务在跑 · 3 项（命令 2、子 agent 1）');
  Object.assign(s, { background: 2, backgroundKinds: ['other', 'rm -rf PRIVATE'] });
  assert.equal(fleetStatus(s, '就绪'), '后台任务在跑 · 2 项（其他）', 'Unknown types never show raw text');
  Object.assign(s, { background: 1, backgroundKinds: null });
  assert.equal(fleetStatus(s, '就绪'), '后台任务在跑 · 1 项');
  Object.assign(s, { background: 0, backgroundKinds: null, backgroundAt: 200 });
  assert.equal(fleetStatus(s, '就绪'), '就绪'); assert.equal(workTone(s), '', 'An empty report is truly idle');
});
test('reported work only describes an idle live root; other states keep their own label', () => {
  const work = { fleet: [], background: 2, backgroundKinds: ['shell', 'shell'], backgroundAt: 100 };
  assert.equal(fleetStatus({ ...work, state: 'working' }, '正在工作'), '正在工作'); assert.equal(workTone({ ...work, state: 'working' }), '');
  for (const s of [{ ...work, state: 'recoverable' }, { ...work, state: 'idle', transportDisconnected: true }, { ...work, state: 'idle', backendUnavailable: true }])
    assert.equal(backgroundWork(s).count, 0);
  for (const background of [null, undefined, -1, 1.5, '1', NaN]) assert.equal(backgroundWork({ ...work, state: 'idle', background }).reported, false);
});
test('a later turn-end report settles only unconfirmed child records, never a running child', () => {
  const child = (time, rest = {}) => ({ event: 'SubagentStart', id: 'native-child', name: 'check', stale: false, time, ...rest });
  const s = { state: 'idle', fleet: [child(50)], background: null };
  assert.equal(fleetStatus(s, '就绪'), '主会话就绪 · 1 个子任务进行中'); assert.equal(workTone(s), 'bg-work', 'A running child is not idle');
  Object.assign(s, { background: 0, backgroundAt: 100 });
  assert.equal(fleetStatus(s, '就绪'), '主会话就绪 · 1 个子任务进行中', 'A teammate may be absent from the report; running is never inferred finished');
  assert.equal(workTone(s), 'bg-work');
  s.fleet.push(child(60, { event: 'SubagentStop' }));
  assert.equal(fleetStatus(s, '就绪'), '主会话就绪'); assert.equal(workTone(s), '');
});
test('unconfirmed child records are not shown as idle until a native report arrives', () => {
  const s = { state: 'idle', fleet: [{ event: 'SubagentStart', id: 'native-child', stale: true, time: 50 }], background: null };
  assert.equal(fleetStatus(s, '就绪'), '主会话就绪 · 子任务状态待核对'); assert.equal(workTone(s), 'bg-unknown');
  Object.assign(s, { background: 0, backgroundAt: 100 });
  assert.equal(fleetStatus(s, '就绪'), '就绪', 'The settled record no longer changes the wording'); assert.equal(workTone(s), '');
  s.fleet.push({ event: 'SubagentStart', id: 'later-child', stale: true, time: 150 });
  assert.equal(fleetStatus(s, '就绪'), '主会话就绪 · 子任务状态待核对'); assert.equal(workTone(s), 'bg-unknown');
  assert.equal(workTone({ state: 'idle', fleet: [] }), '', 'No observation and no report keeps the ordinary idle dot');
});
test('a Claude turn that ended without a report is unconfirmed, not ready', () => {
  const s = { state: 'idle', fleet: [], background: 0, backgroundAt: 100, backgroundStale: true };
  assert.equal(fleetStatus(s, '就绪'), '后台状态待核对'); assert.equal(workTone(s), 'bg-unknown');
  Object.assign(s, { background: 1, backgroundKinds: ['shell'] });
  assert.equal(fleetStatus(s, '就绪'), '后台状态待核对', 'An older count is not shown as current'); assert.equal(backgroundWork(s).count, 0);
  s.fleet.push({ event: 'SubagentStart', id: 'native-child', stale: false, time: 150 });
  assert.equal(fleetStatus(s, '就绪'), '后台状态待核对 · 1 个子任务进行中'); assert.equal(workTone(s), 'bg-work');
  assert.equal(fleetStatus({ ...s, state: 'working' }, '正在工作'), '正在工作 · 1 个子任务进行中');
});
test('type detail is shown only when it accounts for every reported item; Codex dots are unchanged', () => {
  assert.equal(fleetStatus({ state: 'idle', fleet: [], background: 3, backgroundKinds: ['shell', 'shell'], backgroundAt: 1 }, '就绪'), '后台任务在跑 · 3 项');
  for (const fleet of [[{ event: 'thread/started', id: 'codex-child', stale: false, time: 1 }], [{ event: 'subAgentActivity', nativeId: 'codex-child', kind: 'started', stale: false, time: 1 }]])
    assert.equal(workTone({ provider: 'codex', state: 'idle', fleet, background: null }), '');
});
