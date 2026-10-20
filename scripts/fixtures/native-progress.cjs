// Synthetic provider output through the real daemon/IPC/renderer path. No model.
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');
const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '../..');
const { NativeHost } = require(path.join(root, 'app/adapters.cjs'));
const { Workspace } = require(path.join(root, 'app/workspace.cjs'));
const held = new Set(), waiting = new Map(), noRaw = new Set(), observe = Workspace.prototype.observe;
Workspace.prototype.observe = async function(id) { const result = await observe.call(this, id); if (noRaw.has(id)) result.terminal = null; if (held.delete(id)) await new Promise(resolve => waiting.set(id, resolve)); return result; };
const { TerminalJournal } = require(path.join(root, 'app/observation.cjs'));
const runtimes = new Map(), stats = { opens: 0, inputs: 0, resizes: 0, sends: 0 };
const write = (screen, data) => new Promise(resolve => screen.write(data, resolve));
NativeHost.prototype.start = async function () { this.binaries = { claude: 'fixture', codex: 'fixture', python: 'fixture' }; };
NativeHost.prototype.close = function () { for (const r of runtimes.values()) r.screen.dispose(); };
NativeHost.prototype.create = function (record) {
  const r = new EventEmitter(); r.record = record; r.chatAvailable = true;
  record.nativeId ||= 'synthetic-' + record.id;
  r.screen = new Terminal({ cols: 80, rows: 24, allowProposedApi: true, scrollback: 5000 });
  r.serializer = new SerializeAddon(); r.screen.loadAddon(r.serializer);
  r.journal = new TerminalJournal(80, 24); r.sequence = 0;
  r.terminal = {
    alive: true, input() { stats.inputs++; }, resize() { stats.resizes++; },
    observe: async () => ({ ...r.journal.snapshot(), alive: true, legacySnapshots: !!r.legacyFrames }),
    snapshot: async () => ({ buffer: r.serializer.serialize(), sequence: r.sequence, cols: r.screen.cols, rows: r.screen.rows }),
  };
  r.start = async () => r.emit('state', 'idle'); r.stop = async () => ({ state: 'ended' });
  r.send = async () => { stats.sends++; }; r.openTerminal = async () => { stats.opens++; return r.terminal; };
  runtimes.set(record.id, r); return r;
};
process.on('message', async q => {
  try {
    const r = runtimes.get(q.target);
    if (q.method === 'hold') held.add(q.target);
    if (q.method === 'connection') { r.record.connectionRevision = (r.record.connectionRevision || 0) + 1; r.emit('state', q.value); }
    if (q.method === 'rawUnavailable') q.value ? noRaw.add(q.target) : noRaw.delete(q.target);
    if (q.method === 'release') { waiting.get(q.target)?.(); waiting.delete(q.target); }
    if (q.method === 'legacyFrames') r.legacyFrames = true;
    if (q.method === 'output' || q.method === 'burst') {
      const items = q.method === 'burst' ? q.value : [q.value];
      for (const item of items) {
        const receivedAt = Date.now();
        if (item.cols) r.screen.resize(item.cols, item.rows);
        await write(r.screen, item.data || '');
        const event = r.journal.append(r.legacyFrames ? 'snapshot' : item.cols ? 'resize' : 'output', r.legacyFrames ? '\x1bc' + r.serializer.serialize() : item.data || '', r.screen.cols, r.screen.rows, () => r.serializer.serialize());
        r.emit('terminal', { ...event, receivedAt, sequence: ++r.sequence });
        if (item.delay) await new Promise(resolve => setTimeout(resolve, item.delay));
      }
    }
    if (q.method === 'progress') r.emit('progress', q.value);
    if (q.method === 'fleet') r.emit('fleet', q.value);
    if (q.method === 'history') r.emit('history', q.value);
    if (q.method === 'approval') { r.emit('approval', q.value); r.emit('state', 'approval'); }
    if (q.method === 'gap') r.emit('terminal', { epoch: r.journal.epoch, index: r.journal.index + 2, data: 'must-not-paint', cols: 80, rows: 24 });
    if (q.method === 'stop') for (const x of runtimes.values()) x.emit('state', 'ended');
    const b = r?.screen.buffer.active;
    process.send({ requestId: q.id, stats, waiting: [...waiting.keys()], screen: b && { cols: r.screen.cols, rows: r.screen.rows, type: b.type, cursor: [b.cursorX, b.cursorY], lines: Array.from({ length: b.length }, (_, i) => b.getLine(i).translateToString()) }, index: r?.journal.index });
  } catch (error) { process.send({ requestId: q.id, error: error.message }); }
});
