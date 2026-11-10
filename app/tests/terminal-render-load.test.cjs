const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../renderer/renderer.js'), 'utf8');
const start = source.indexOf('function renderTerminal('), end = source.indexOf('async function ensureTerminal(', start);
assert.ok(start >= 0 && end > start);
const flush = () => new Promise(resolve => setImmediate(resolve));
function harness() {
  const loads = [], errors = [], record = { id: 's', nativeId: 'native-A', connectionRevision: 1 };
  const c = vm.createContext({ state: { sessions: [record] }, terminalRenderLoads: new Map(), terminals: new Map(), mode: 'terminal',
    syncTerminalMount() {}, toastError: error => errors.push(error.message),
    ensureTerminal(id) {
      const entry = {}; c.terminals.set(id, entry);
      return new Promise((resolve, reject) => loads.push({ id, entry, resolve, reject }));
    },
  });
  vm.runInContext(source.slice(start, end), c);
  return { c, loads, errors, record, render: column => c.renderTerminal('s', column) };
}
test('repeated snapshots share one passive load while explicit callers remain independent', async () => {
  const h = harness();
  for (let i = 0; i < 2000; i++) { h.c.state.sessions = [{ ...h.record, messages: [{ text: 'snapshot-' + i }] }]; h.render(); }
  assert.equal(h.loads.length, 1); assert.equal(h.c.terminalRenderLoads.size, 1);
  h.loads[0].resolve(); await flush(); assert.equal(h.c.terminalRenderLoads.size, 0);
  h.render(); assert.equal(h.loads.length, 2, 'A settled display can fit or reconcile on the next render');
  const explicit = h.c.ensureTerminal('s', true); assert.equal(h.loads.length, 3, 'An explicit action does not wait behind the passive gate');
  h.loads[1].resolve(); h.loads[2].resolve(); await explicit; await flush();
});
test('native identity, connection generation and replaced display each bypass a stale pending load', async () => {
  for (const change of ['nativeId', 'connectionRevision', 'entry']) {
    const h = harness(); h.render();
    if (change === 'entry') h.c.terminals.delete('s'); else h.record[change] = change === 'nativeId' ? 'native-B' : 2;
    h.render(); assert.equal(h.loads.length, 2, change);
    h.loads[0].reject(Error('stale failure')); await flush();
    assert.deepEqual(h.errors, []); assert.equal(h.c.terminalRenderLoads.size, 1, 'Old settlement cannot remove the replacement');
    h.render(); assert.equal(h.loads.length, 2);
    h.loads[1].resolve(); await flush(); assert.equal(h.c.terminalRenderLoads.size, 0);
  }
});
test('a current load fails once and clears its gate; chat and column failure visibility is preserved', async () => {
  for (const [mode, column, visible] of [['terminal', false, true], ['chat', false, false], ['chat', true, true]]) {
    const h = harness(); h.c.mode = mode;
    for (let i = 0; i < 20; i++) h.render(column);
    h.loads[0].reject(Error('current failure')); await flush();
    assert.deepEqual(h.errors, visible ? ['current failure'] : []); assert.equal(h.c.terminalRenderLoads.size, 0);
    h.render(column); assert.equal(h.loads.length, 2); h.loads[1].resolve(); await flush();
  }
});
