const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Terminal: HeadlessTerminal } = require('@xterm/headless');
const { TerminalJournal, ProgressJournal } = require('../observation.cjs');
const { Terminal, Claude, Codex } = require('../adapters.cjs');
const { Workspace } = require('../workspace.cjs');
const { pythonExecutable } = require('../platform.cjs');
const write = (screen, data) => new Promise(resolve => screen.write(data, resolve));
function cells(screen) {
  const b = screen.buffer.active;
  return { cols: screen.cols, rows: screen.rows, type: b.type, cursor: [b.cursorX, b.cursorY], lines: Array.from({ length: b.length }, (_, i) => Array.from({ length: screen.cols }, (_, x) => { const c = b.getLine(i).getCell(x); return [c.getChars(), c.getWidth(), c.getFgColorMode(), c.getFgColor(), c.getBgColorMode(), c.getBgColor(), c.isBold(), c.isItalic(), c.isUnderline(), c.isInverse()]; })) };
}
async function replay(raw) {
  const base = raw.checkpoint;
  const screen = new HeadlessTerminal({ cols: base.cols, rows: base.rows, allowProposedApi: true, scrollback: 5000 });
  await write(screen, base.buffer);
  for (const event of raw.events) { screen.resize(event.cols, event.rows); await write(screen, event.data); }
  return screen;
}
test('real PTY output replay preserves Unicode, overwritten temporary text, alternate screen and canonical resize', async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-observation-'));
  const source = 'import sys,time\nfor x in ["准备：你好🌳\\n", "temporary\\r\\x1b[2Kdone\\n", "\\x1b[?1049h\\x1b[31m批准?\\x1b[0m", "\\x1b[?1049l\\x1b[32mrestored\\x1b[0m\\n"]:\n sys.stdout.write(x);sys.stdout.flush();time.sleep(.15)\ntime.sleep(3)';
  const terminal = new Terminal([pythonExecutable(), '-u', '-c', source], folder);
  t.after(async () => { await terminal.stop(); fs.rmSync(folder, { recursive: true, force: true }); });
  const events = []; terminal.on('data', event => events.push(event));
  await once(terminal, 'data');
  terminal.resize(62, 17);
  for (let i = 0; i < 100 && !events.some(e => e.data.includes('restored')); i++) await new Promise(r => setTimeout(r, 20));
  const raw = await terminal.observe(), restored = await replay(raw);
  t.after(() => restored.dispose());
  assert.deepEqual(cells(restored), cells(terminal.screen));
  assert.ok(raw.events.some(e => e.data.includes('temporary')));
  assert.ok(raw.events.some(e => e.kind === 'resize' && e.cols === 62));
  assert.ok(raw.events.some(e => e.data.includes('1049h')));
  assert.deepEqual(raw.events.map(e => e.index), Array.from({ length: raw.index }, (_, i) => i + 1));
});
test('observation truncation is bounded and explicit, including a too-large checkpoint', () => {
  const journal = new TerminalJournal(80, 24, { maxBytes: 300, maxEvents: 2, maxCheckpointBytes: 20 });
  journal.append('output', 'one', 80, 24, () => 'one');
  journal.append('resize', '', 60, 15, () => 'one');
  journal.append('output', 'two', 60, 15, () => 'two');
  let raw = journal.snapshot(); assert.equal(raw.truncated, true); assert.equal(raw.checkpoint.index, 3); assert.equal(raw.events.length, 0);
  journal.append('output', 'x'.repeat(301), 60, 15, () => 'y'.repeat(21));
  raw = journal.snapshot(); assert.equal(raw.checkpoint, null); assert.ok(raw.unavailable); assert.equal(raw.bytes, 0);
});
test('structured output updates one stable item, bounds memory and flags truncation', () => {
  const journal = new ProgressJournal(); journal.update({ id: 'tool', title: 'Command', status: 'running', source: 'native' });
  journal.update({ id: 'tool', delta: 'x'.repeat(15000) }); journal.update({ id: 'tool', status: 'completed' });
  let state = journal.snapshot(); assert.equal(state.items.length, 1); assert.equal(state.items[0].status, 'completed'); assert.equal(state.items[0].truncated, true); assert.equal(state.items[0].text.length, 12000);
  for (let i = 0; i < 300; i++) journal.update({ id: String(i), text: 'y'.repeat(12000) });
  state = journal.snapshot(); assert.ok(state.items.length <= 200); assert.ok(JSON.stringify(state).length < 1024 * 1024); assert.equal(state.truncated, true);
});
test('observing private room members does not open terminals, claim input, change routing or persist the observation', async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-observe-private-'));
  const runtimes = [];
  const host = { binaries: {}, close() {}, create() { const runtime = new EventEmitter(); runtime.openTerminal = () => { throw Error('observer attempted to open'); }; runtime.start = async () => runtime.emit('state', 'idle'); runtimes.push(runtime); return runtime; } };
  const w = new Workspace(host, folder); t.after(() => { w.close(); fs.rmSync(folder, { recursive: true, force: true }); });
  const id = await w.create('claude', folder, 'human', 'Observer fixture'); w.join(id, true);
  const before = JSON.stringify(w.snapshot());
  runtimes[0].emit('progress', { id: 'private-tool', title: 'SYNTHETIC_PRIVATE_OUTPUT', status: 'running' });
  const observed = await w.observe(id); assert.equal(observed.terminal, null); assert.equal(observed.progress.items[0].title, 'SYNTHETIC_PRIVATE_OUTPUT');
  assert.equal(JSON.stringify(w.snapshot()), before); w.persist();
  assert.ok(!fs.readFileSync(path.join(folder, 'workspace.json'), 'utf8').includes('SYNTHETIC_PRIVATE_OUTPUT'));
});
test('provider adapters retain intermediate tool status/output without inferring completion of the task', () => {
  const c = new Codex({ id: 'fixture', nativeId: 'native', view: 'chat' }, { codexTargets: new Map() });
  const progress = []; c.on('progress', e => progress.push(e));
  c.event({ method: 'item/started', params: { turnId: 'turn', item: { id: 'cmd', type: 'commandExecution', command: 'synthetic-command' } } });
  c.event({ method: 'item/commandExecution/outputDelta', params: { turnId: 'turn', itemId: 'cmd', delta: 'halfway' } });
  c.event({ method: 'item/completed', params: { turnId: 'turn', item: { id: 'cmd', type: 'commandExecution', aggregatedOutput: 'halfway\ndone', status: 'completed' } } });
  assert.equal(progress.length, 3); assert.equal(progress[1].delta, 'halfway'); assert.equal(progress[2].status, 'completed');
  const claude = Object.create(Claude.prototype); EventEmitter.call(claude); claude.record = { nativeId: 'native' }; claude.pending = null;
  const hooks = []; claude.on('progress', e => hooks.push(e));
  for (const name of ['PreToolUse', 'PostToolUse']) claude.hook({ hook_event_name: name, session_id: 'native', tool_use_id: 'tool', tool_name: 'Read' });
  assert.deepEqual(hooks.map(h => h.id), ['tool', 'tool']); assert.deepEqual(hooks.map(h => h.status), ['running', 'completed']);
  const models = []; claude.on('model', model => models.push(model));
  claude.hook({ hook_event_name: 'SessionStart', session_id: 'native', source: 'resume' });
  assert.deepEqual(models, ['原生未报告'], 'Missing model on native resume must not be presented as a known default');
});
