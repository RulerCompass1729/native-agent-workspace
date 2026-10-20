const test = require('node:test'), assert = require('node:assert/strict');
const { observedFleet, fleetStatus } = require('../renderer/fleet-observation.js');
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
  assert.equal(progress.length, 2); assert.ok(progress.every(p => p.status === 'observed' && p.title.includes('子任务已启动')));
  assert.equal(fleet.length, 1); assert.equal(fleet[0].active, true);
});
