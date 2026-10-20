const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');
const { LegacyObservation, supportsLegacyObservation } = require('../legacy-observation.cjs');
const { WorkspaceClient } = require('../workspace-client.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const write = (t, text) => new Promise(resolve => t.write(text, resolve));
const lines = t => Array.from({ length: t.buffer.active.length }, (_, i) => t.buffer.active.getLine(i).translateToString(false, 0, t.cols));

test('only the inspected legacy Claude snapshot is eligible, never legacy Codex or unknown versions', () => {
  const state = { runtimeVersion: '0.1.0-alpha.2' };
  assert.equal(supportsLegacyObservation(state, { provider: 'claude', terminalAvailable: true }), true);
  for (const [version, provider, terminalAvailable] of [['0.1.0-alpha.2', 'codex', true], ['development', 'claude', true], ['0.1.0-alpha.2', 'claude', false]])
    assert.equal(supportsLegacyObservation({ runtimeVersion: version }, { provider, terminalAvailable }), false);
});

test('legacy snapshots preserve native tool/timing/Unicode and dimensions without terminal input or guessed event ordering', async () => {
  const native = new Terminal({ cols: 70, rows: 12, allowProposedApi: true }), serializer = new SerializeAddon(); native.loadAddon(serializer);
  const display = new Terminal({ cols: 100, rows: 30, allowProposedApi: true }); let sequence = 0, calls = 0;
  const observer = new LegacyObservation(async () => { calls++; return { sequence, buffer: serializer.serialize(), cols: native.cols, rows: native.rows }; }, () => {});
  const compare = async () => {
    const { terminal } = await observer.observe(); const c = terminal.checkpoint;
    display.reset(); display.resize(c.cols, c.rows); await write(display, c.buffer);
    for (const e of terminal.events) { display.resize(e.cols, e.rows); await write(display, e.data); }
    assert.deepEqual(lines(display), lines(native)); assert.equal(display.cols, native.cols); assert.equal(display.rows, native.rows);
  };
  await write(native, '工具运行中：你好\r\n'); sequence++; await compare();
  await write(native, '\x1b[?1049h审批：请确认'); sequence++; await compare();
  native.resize(46, 9); await compare();
  await write(native, '\x1b[?1049lRan 1 shell command\r\nChurned for 3s · done 7:30 PM'); sequence++; await compare();
  const before = calls; await delay(100); assert.equal(calls, before, 'No idle polling');
  observer.release(); for (let i = 0; i < 100; i++) observer.changed(); await delay(60); assert.equal(calls, before);
  observer.dispose(); native.dispose(); display.dispose();
});

test('release/reopen ignores the old delayed snapshot and reads the current native frame', async () => {
  let release, reads = 0; const seen = [];
  const observer = new LegacyObservation(async () => {
    reads++; if (reads === 1) await new Promise(resolve => { release = resolve; });
    return { sequence: reads, cols: 80, rows: 24, buffer: String(reads) };
  }, event => seen.push(event));
  const first = observer.observe(); observer.release(); const second = observer.observe(); release(); await first; await second;
  assert.equal(reads, 2); assert.equal(seen.length, 1); assert.ok(seen[0].data.endsWith('2')); observer.dispose();
});

test('workspace routes compatible observe only to readonly snapshot; resize refreshes without unlocking send', async () => {
  const client = new EventEmitter(), calls = [];
  const state = { runtimeVersion: '0.1.0-alpha.2', owner: 'window', capabilities: [], sessions: [{ id: 'old', provider: 'claude', terminalAvailable: true, owner: 'window', state: 'idle' }], room: { messages: [], revision: 0 }, diagnostics: {} };
  client.call = async (method, ...args) => { calls.push([method, ...args]); if (method === 'terminalSnapshot') return { sequence: 0, cols: 80, rows: 24, buffer: 'native' }; if (method === 'initial') return state; };
  client.close = () => client.emit('closed'); const c = new WorkspaceClient([{ key: 'old', client, state }], 'old');
  assert.equal(c.snapshot().sessions[0].legacyObservation, true);
  assert.equal(c.snapshot().sessions[0].chatAvailable, false);
  await c.call('observe', 'old'); assert.deepEqual(calls.map(x => x[0]), ['terminalSnapshot']);
  await assert.rejects(c.call('send', 'old', 'Never dispatch'), /旧版会话/);
  await c.call('resize', 'old', 80, 24); await delay(80);
  assert.deepEqual(calls.map(x => x[0]), ['terminalSnapshot', 'resize', 'terminalSnapshot']);
  await c.call('unobserve', 'old'); const count = calls.length; client.emit('terminal', { id: 'old', sequence: 1, data: 'later' }); await delay(70); assert.equal(calls.length, count); c.close();
});
