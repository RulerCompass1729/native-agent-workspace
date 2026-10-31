const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), Module = require('node:module');
const cp = require('node:child_process'), { EventEmitter, once } = require('node:events');
const { Terminal: Screen } = require('@xterm/headless');
const write = (screen, data = '') => new Promise(resolve => screen.write(data, resolve));
const source = fs.readFileSync(require.resolve('../renderer/renderer.js'), 'utf8');
const start = '      const snapshot = await api.terminalSnapshot(id);';
const end = '      entry.queued = []; loading.remove(); surface.hidden = false; surface.inert = false;';
const hydration = source.slice(source.indexOf(start), source.indexOf(end));
const eventWriter = source.match(/^function writeTerminal\(entry, event\) \{.+\}$/m)[0];
const fitSource = source.slice(source.indexOf('function fitTerminal(id) {'), source.indexOf('function writeTerminal(entry, event) {'));

function producer(t) {
  const worker = new EventEmitter(), commands = [];
  worker.stdout = new EventEmitter(); worker.stdout.setEncoding = () => worker.stdout;
  worker.stderr = new EventEmitter(); worker.stdin = new EventEmitter(); worker.stdin.writable = true;
  worker.stdin.write = line => { const command = JSON.parse(line); commands.push(command);
    assert.ok(!command.type || command.type === 'resize', 'No native input or stop'); return true; };
  const forbidden = () => { throw Error('Resize checks cannot start a native process or read runtime configuration'); };
  const names = ['spawn', 'spawnSync', 'fork', 'exec', 'execSync', 'execFile', 'execFileSync'];
  const saved = Object.fromEntries(names.map(n => [n, cp[n]])), cached = new Set(Object.keys(require.cache));
  const file = require.resolve('../adapters.cjs'), isolated = new Module(file, module);
  isolated.filename = file; isolated.paths = Module._nodeModulePaths(path.dirname(file));
  const original = isolated.require.bind(isolated);
  isolated.require = name => name === 'node:child_process' ? { ...saved, execFileSync: forbidden,
    spawn(binary, args) { assert.equal(binary, '/synthetic/no-exec'); assert.equal(path.basename(args[0]), 'pty_host.py'); return worker; } } :
    name === './platform.cjs' ? { executable: forbidden, pythonExecutable: () => '/synthetic/no-exec', nativeEnvironment: env => ({ ...env }) } : original(name);
  let terminal;
  try { for (const name of names) cp[name] = forbidden; isolated._compile(fs.readFileSync(file, 'utf8'), file);
    terminal = new isolated.exports.Terminal(['synthetic-no-provider'], '/synthetic/workspace'); }
  finally { Object.assign(cp, saved); for (const name of Object.keys(require.cache)) if (!cached.has(name)) delete require.cache[name]; }
  t.after(() => { terminal.cursorModes.dispose(); terminal.keyboardModes.dispose(); terminal.screen.dispose(); worker.removeAllListeners(); });
  return { terminal, commands, async output(data) { const done = once(terminal, 'data');
    worker.stdout.emit('data', JSON.stringify({ type: 'data', data: Buffer.from(data).toString('base64') }) + '\n'); return (await done)[0]; },
    async resize(cols, rows = 5) { const done = once(terminal, 'data'); terminal.resize(cols, rows); return (await done)[0]; } };
}
function capture(screen) {
  const groups = new Map(), buffers = {};
  for (const name of ['normal', ...(screen.buffer.active.type === 'alternate' ? ['alternate'] : [])]) {
    const buffer = screen.buffer[name];
    buffers[name] = { x: buffer.cursorX, y: buffer.cursorY, base: buffer.baseY,
      lines: Array.from({ length: buffer.length }, (_, y) => {
        const line = buffer.getLine(y); return { wrapped: line.isWrapped, cells: Array.from({ length: screen.cols }, (_, x) => {
          const cell = line.getCell(x), id = cell.hasExtendedAttrs() ? cell.extended.urlId : 0;
          const link = id ? screen._core._oscLinkService.getLinkData(id) : null, attr = cell.clone();
          attr.extended.urlId = 0; attr.updateExtended(); if (id && !groups.has(id)) groups.set(id, groups.size + 1);
          return { text: cell.getChars(), width: cell.getWidth(), fg: attr.fg, bg: attr.bg, extended: attr.extended.ext,
            uri: link?.uri || null, group: id ? groups.get(id) : 0 };
        }) };
      }) };
  }
  return { cols: screen.cols, rows: screen.rows, active: screen.buffer.active.type, buffers,
    cursorStyle: screen._core.coreService.decPrivateModes.cursorStyle, cursorBlink: screen._core.coreService.decPrivateModes.cursorBlink };
}
async function observer(t, frame, queued = []) {
  const term = new Screen({ cols: 40, rows: 5, scrollback: 5000, allowProposedApi: true });
  const id = 'synthetic-view', entry = { term, queued }, state = { sessions: [{ id, owner: 'other-owner', terminalState: { alive: true, epoch: frame.epoch } }] };
  const context = { term, entry, state, id, terminals: new Map([[id, entry]]),
    api: { terminalSnapshot: async () => frame, initial: async () => state }, document: { activeElement: null },
    reveals: 0, revealTerminalCursor() { context.reveals++; }, updateState(next) { context.state = next; } };
  vm.createContext(context);
  await vm.runInContext(eventWriter + '\nthis.writeObserved=writeTerminal;(async()=>{' + hydration + '})()', context);
  await write(term);
  t.after(() => { context.terminals.delete(id); term.dispose(); });
  return { id, term, entry, context, deliver(event) { context.writeObserved(entry, { id, ...event }); }, flush: () => write(term) };
}
const open = '\x1b]8;id=live-original;https://example.invalid/resize\x1b\\', close = '\x1b]8;;\x1b\\';

test('snapshot observation index is captured with its buffer before a later same-sequence resize', async t => {
  const p = producer(t); await p.resize(40); await p.output('INDEX');
  const pending = p.terminal.snapshot(), resized = p.resize(30);
  const [frame, event] = await Promise.all([pending, resized]);
  assert.equal(frame.observationIndex, 2); assert.equal(frame.cols, 40); assert.equal(frame.sequence, 1);
  assert.equal(event.index, 3); assert.equal(event.sequence, frame.sequence); assert.equal(p.terminal.screen.cols, 30);
});
for (const alternate of [false, true]) test('actual observer follows queued native resize, output and growth: ' + (alternate ? 'alternate' : 'normal'), async t => {
  const p = producer(t); await p.resize(40);
  await p.output('\x1b[6 q\x1b[>5u' + (alternate ? 'NORMAL\x1b[?1049h' : '') + '\x1b[38;2;12;145;231m' + open + 'A'.repeat(24) + '中' + 'B'.repeat(30) + close);
  const view = await observer(t, await p.terminal.snapshot()); assert.deepEqual(capture(view.term), capture(p.terminal.screen));
  const burst = [await p.output('PUSH'), await p.resize(25), await p.output('NEXT')];
  for (const event of burst) view.deliver(event); await view.flush();
  assert.deepEqual(capture(view.term), capture(p.terminal.screen), 'Pending output is parsed before changing grid');
  for (const cols of [30, 40]) { view.deliver(await p.resize(cols)); await view.flush(); assert.deepEqual(capture(view.term), capture(p.terminal.screen)); }
  if (alternate) { view.deliver(await p.output('\x1b[?1049l')); await view.flush(); assert.deepEqual(capture(view.term), capture(p.terminal.screen)); }
  assert.equal(view.entry.keyboardFlags, 5); assert.equal(view.entry.sequence, p.terminal.sequence);
});
test('snapshot queue discards captured resizes but keeps equal-sequence resizes after capture', async t => {
  const p = producer(t), first = await p.resize(40); await p.output('SHORT');
  const captured = await p.resize(25), frame = await p.terminal.snapshot(), after = await p.resize(30), output = await p.output('NEXT');
  const view = await observer(t, frame, [first, captured, after, output].map(event => ({ id: 'synthetic-view', ...event })));
  assert.deepEqual(capture(view.term), capture(p.terminal.screen)); assert.equal(view.entry.observationIndex, output.index);
});
test('resize preserves keyboard, sequence, focus and composition state in a hidden current entry', async t => {
  const p = producer(t); await p.resize(40); await p.output('\x1b[>5uSHORT');
  const frame = await p.terminal.snapshot(), view = await observer(t, frame), composition = {};
  Object.assign(view.entry, { composing: true, composition, fitPending: true, element: { isConnected: false, checkVisibility: () => false } });
  const focus = {}; view.context.document.activeElement = focus;
  view.deliver(await p.resize(30)); await view.flush();
  assert.equal(view.term.cols, 30); assert.equal(view.entry.keyboardFlags, 5); assert.equal(view.entry.sequence, frame.sequence);
  assert.equal(view.entry.composing, true); assert.equal(view.entry.composition, composition); assert.equal(view.entry.fitPending, true);
  assert.equal(view.context.document.activeElement, focus); assert.equal(view.context.reveals, 0);
});
test('malformed indexed events and stale epochs do not mutate the grid or advance the hint', async t => {
  const p = producer(t); await p.resize(40); await p.output('SAFE');
  const frame = await p.terminal.snapshot(), view = await observer(t, frame), event = await p.resize(30);
  const before = capture(view.term), ordinal = view.entry.observationIndex;
  const bad = [{ epoch: 'foreign' }, { index: frame.observationIndex }, { index: NaN }, { index: '3' }, { index: undefined },
    { sequence: NaN }, { sequence: '1' }, { sequence: -1 }, { cols: 19 }, { cols: 401 }, { cols: 30.5 }, { rows: 4 }, { rows: 201 }];
  for (const mutation of bad) { view.deliver({ ...event, ...mutation }); await view.flush(); assert.deepEqual(capture(view.term), before); assert.equal(view.entry.observationIndex, ordinal); }
  const output = { ...event, kind: 'output', data: 'BAD', sequence: frame.sequence + 1 };
  for (const mutation of [{ epoch: 'foreign' }, { index: NaN }, { index: '3' }, { sequence: NaN }, { sequence: '2' }, { data: null }]) {
    view.deliver({ ...output, ...mutation }); await view.flush(); assert.deepEqual(capture(view.term), before); assert.equal(view.entry.observationIndex, ordinal);
  }
});
test('a retired entry cannot resize after its parser barrier was scheduled', async t => {
  const p = producer(t); await p.resize(40); await p.output('SAFE'); const view = await observer(t, await p.terminal.snapshot());
  let resized = 0; const original = view.term.resize.bind(view.term); view.term.resize = (...args) => { resized++; return original(...args); };
  view.deliver(await p.resize(30)); view.context.terminals.delete(view.id); view.term.dispose();
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(resized, 0);
});
test('missing or malformed snapshot hints retain legacy output and resize behavior', async t => {
  const p = producer(t); await p.resize(40); await p.output('LEGACY'); const frame = await p.terminal.snapshot(), resized = await p.resize(30);
  for (const hint of [undefined, -1, NaN, '2']) {
    const view = await observer(t, { ...frame, observationIndex: hint });
    view.deliver(resized); await view.flush(); assert.equal(view.term.cols, 40);
    view.deliver({ epoch: frame.epoch, sequence: frame.sequence + 1, data: 'NEXT', keyboardFlags: 7 });
    await view.flush(); assert.equal(view.entry.keyboardFlags, 7); assert.equal(view.entry.sequence, frame.sequence + 1);
  }
});
test('legacy unindexed payload is preserved and withdraws indexed resize qualification', async t => {
  const p = producer(t); await p.resize(40); await p.output('LEGACY'); const frame = await p.terminal.snapshot(), view = await observer(t, frame);
  view.deliver({ epoch: frame.epoch, sequence: frame.sequence + 1, data: 'NEXT', keyboardFlags: 7 }); await view.flush();
  assert.equal(view.term.buffer.active.getLine(0).translateToString(true), 'LEGACYNEXT');
  assert.equal(view.entry.observationIndex, undefined); assert.equal(view.entry.keyboardFlags, 7);
});
test('owner local fits and echoed events have no API feedback or stale geometry replay', async t => {
  const p = producer(t); await p.resize(40); await p.output('\x1b[38;2;12;145;231m' + open + 'A'.repeat(24) + '中' + 'B'.repeat(30) + close); const view = await observer(t, await p.terminal.snapshot());
  const context = view.context, echoes = [], pending = [], requests = []; let wanted = 30;
  context.owner = 'owner'; context.state.sessions[0].owner = 'owner'; context.columnTerminalBinding = () => null;
  context.activeSessionId = () => view.id; context.terminalLayout = 'split';
  context.requestAnimationFrame = callback => callback(); context.attempt = callback => pending.push(callback());
  view.entry.element = { isConnected: true, checkVisibility: () => true }; view.entry.fit = { proposeDimensions: () => ({ cols: wanted, rows: 5 }) };
  context.api.resize = async (id, cols, rows) => { requests.push({ id, cols, rows }); echoes.push(await p.resize(cols, rows)); };
  vm.runInContext(fitSource + '\nthis.fitObserved=fitTerminal;', context);
  context.fitObserved(view.id); await Promise.all(pending); wanted = 40; context.fitObserved(view.id); await Promise.all(pending);
  const reveals = context.reveals; for (const event of echoes) view.deliver(event); await view.flush();
  assert.equal(requests.length, 2); assert.equal(context.reveals, reveals); assert.deepEqual(capture(view.term), capture(p.terminal.screen));
  let resized = 0; const original = view.term.resize.bind(view.term); view.term.resize = (...args) => { resized++; return original(...args); };
  view.deliver(echoes[0]); await view.flush(); assert.equal(resized, 0, 'A captured or stale 30-column echo cannot revert the acknowledged 40-column grid');
  assert.equal(requests.length, 2); assert.deepEqual(capture(view.term), capture(p.terminal.screen));
});
