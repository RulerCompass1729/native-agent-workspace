const test = require('node:test'), assert = require('node:assert/strict');
const core = require('../regular-popup.cjs');
test('approved factory is default-off; existing unapproved enabled records do not acquire transports', async () => {
  const state = core.emptyState(); state.config = { enabled: true, concern: 'fixture', time: '00:00' };
  const e = core.create({ store: { read: () => state, write() { assert.fail(); } } });
  assert.equal(e.status().allowed, true); assert.equal(e.status().config.enabled, false); e.start(); await e.tick(); assert.equal(e.timer, null); e.dispose();
});
test('unknown yesterday cost does not silently consume today; same-day catch-up skip is explicit', async () => {
  let at = new Date(2026, 10, 18, 9, 5).getTime(), calls = 0, saved = null;
  const e = new core.RegularPopup({ store: { read: () => saved, write: v => saved = structuredClone(v) }, now: () => at, permitted: true,
    readSource: async () => [{ id: 'x', title: 'fixture', description: 'public', url: 'https://github.com/example/tool' }], select: async () => { calls++; if (calls === 1) throw Error('unknown'); return { picks: [], costMicros: 2000 }; } });
  e.configure({ enabled: true, concern: 'tools', time: '09:00' }); await e.tick(); assert.equal(saved.runs[0].chargedMicros, 7000);
  at = new Date(2026, 10, 19, 9).getTime(); await e.tick(); assert.equal(calls, 2); assert.equal(saved.runs[0].state, 'ready'); e.dispose();
  let release; at = new Date(2026, 10, 18, 23, 59).getTime(); calls = 0;
  const f = new core.RegularPopup({ store: { read: () => null, write() {} }, now: () => at, permitted: true,
    readSource: () => new Promise(resolve => release = resolve), select: async () => { calls++; throw Error('unknown'); } });
  f.configure({ enabled: true, concern: 'tools', time: '00:00' }); const pending = f.tick(); at += 3 * 60000;
  release([{ id: 'x', title: 'fixture', description: 'public', url: 'https://github.com/example/tool' }]); await pending; await f.tick();
  assert.equal(calls, 1); assert.equal(f.status().runs[0].skipReason, 'usage-unconfirmed'); assert.equal(f.status().runs[0].day, '2026-11-19'); f.dispose();
});
test('cancel during credential resolution never starts a worker or egress', async () => {
  const { runWorker } = require('../regular-popup-transport.cjs'); let release, calls = 0; const signal = new AbortController();
  const p = runWorker({ concern: 'tools', candidates: [] }, { directory: '/unused-fixture', signal: signal.signal }, { readKey: () => new Promise(r => release = r), egress: { startEgress: () => calls++ }, spawn: () => calls++ });
  signal.abort(); release('fixture-only'); await assert.rejects(p); assert.equal(calls, 0);
});
test('dispatch handshake after credential/startup delay rebooks the actual day and cannot be replayed', async () => {
  let at = new Date(2026, 10, 18, 23, 59).getTime(), release, calls = 0, saved = null;
  const e = new core.RegularPopup({ store: { read: () => saved, write: v => saved = structuredClone(v) }, now: () => at, permitted: true,
    readSource: async () => [{ id: 'x', title: 'fixture', description: 'public', url: 'https://github.com/example/tool' }],
    select: async (_, { authorize }) => { await new Promise(resolve => release = resolve); const grant = authorize(); assert.equal(grant.budgetDay, '2026-11-19'); assert.equal(saved.runs[0].budgetDay, grant.budgetDay); assert.equal(saved.runs[0].chargedMicros, 7000); assert.throws(authorize); calls++; return { picks: [], costMicros: 7000 }; } });
  e.configure({ enabled: true, concern: 'tools', time: '00:00' }); const pending = e.tick(); await new Promise(resolve => setImmediate(resolve));
  at += 180000; release(); await pending; assert.equal(saved.runs[0].budgetDay, '2026-11-19'); await e.tick(); assert.equal(calls, 1); assert.equal(saved.runs[1].day, '2026-11-18'); assert.equal(saved.runs[1].budgetDay, '2026-11-19'); e.dispose();
});
test('human disable while a worker is waiting for dispatch denies all model sends', async () => {
  let release, calls = 0;
  const e = new core.RegularPopup({ store: { read: () => null, write() {} }, permitted: true,
    readSource: async () => [{ id: 'x', title: 'fixture', description: 'public', url: 'https://github.com/example/tool' }], select: async (_, { authorize }) => { await new Promise(resolve => release = resolve); authorize(); calls++; return { picks: [], costMicros: 100 }; } });
  e.configure({ enabled: true, concern: 'tools', time: '00:00' }); const pending = e.tick(); await new Promise(resolve => setImmediate(resolve));
  e.configure({ enabled: false, concern: 'tools', time: '00:00' }); release(); await pending; assert.equal(calls, 0); assert.equal(e.status().runs[0].state, 'cancelled'); e.dispose();
});
test('dispatch reservation write failure refuses the model request before a grant', async () => {
  let generating = 0, calls = 0, saved = null;
  const e = new core.RegularPopup({ store: { read: () => saved, write: v => { if (v.runs[0]?.state === 'generating' && ++generating === 2) throw Error('fixture disk failure'); saved = structuredClone(v); } }, permitted: true,
    readSource: async () => [{ id: 'x', title: 'fixture', description: 'public', url: 'https://github.com/example/tool' }], select: async (_, { authorize }) => { authorize(); calls++; return { picks: [], costMicros: 100 }; } });
  e.configure({ enabled: true, concern: 'tools', time: '00:00' }); await assert.rejects(e.tick()); assert.equal(calls, 0); assert.equal(e.status().error, 'storage-unavailable'); assert.equal(saved.runs[0].chargedMicros, 7000); e.dispose();
});
test('owned actual sandbox worker cannot read/write outside its home, execute shell or expose key in argv', async () => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), { runWorker } = require('../regular-popup-transport.cjs');
  const scratch = require('../../scripts/fixtures/test-scratch.cjs'), root = scratch.directory(path.join(os.tmpdir(), 'naw-popup-sandbox-'));
  fs.writeFileSync(path.join(root, 'must-not-read'), 'synthetic private marker');
  const result = await runWorker({ concern: 'tools', candidates: [] }, { directory: root, signal: new AbortController().signal, authorize: () => { const d = new Date(); return { budgetDay: `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` }; } }, {
    execPath: require('electron'), entry: path.resolve(__dirname, '../../scripts/fixtures/regular-popup-worker.cjs'), readKey: async () => 'fixture-only', egress: { startEgress: async () => ({ port: 43123, close: async () => {}, violated: false }) },
  });
  assert.deepEqual(result.probe, { readDenied: true, writeDenied: true, execDenied: true, credentialPresent: true, keyInArgv: false });
  assert.equal(fs.readFileSync(path.join(root, 'must-not-read'), 'utf8'), 'synthetic private marker');
  assert.deepEqual(fs.readdirSync(root), ['must-not-read']);
});
test('actual sandboxed DSH worker completes via a fake wire with real metering and zero network/model calls', async () => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), { runWorker } = require('../regular-popup-transport.cjs');
  const scratch = require('../../scripts/fixtures/test-scratch.cjs'), root = scratch.directory(path.join(os.tmpdir(), 'naw-popup-dsh-'));
  const result = await runWorker({ concern: 'tools', candidates: [{ id: 'x', title: 'fixture', description: 'public' }] }, { directory: root, signal: new AbortController().signal, authorize: () => { const d = new Date(); return { budgetDay: `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` }; } }, {
    execPath: require('electron'), entry: path.resolve(__dirname, '../../scripts/fixtures/regular-popup-dsh.cjs'), readKey: async () => 'fixture-only', egress: { startEgress: async () => ({ port: 43123, close: async () => {}, violated: false }) },
  });
  assert.equal(result.costMicros, 421); assert.equal(result.picks[0].id, 'x'); assert.equal(result.usage.totalTokens, 1200); assert.equal(result.usage.tier, 'peak'); assert.deepEqual(fs.readdirSync(root), []);
});
test('actual production factory acquires fake transport only after human configure; disable/dispose prevent further calls', async () => {
  const module = require('../regular-popup-transport.cjs'), original = module.createTransport; let made = 0, source = 0, selected = 0, closed = 0, saved = null;
  module.createTransport = () => { made++; return { readSource: async () => { source++; return [{ id: 'x', title: 'fixture', description: 'public', url: 'https://github.com/example/tool' }]; }, select: async () => { selected++; return { picks: [], costMicros: 2000 }; }, close() { closed++; } }; };
  try {
    const e = core.create({ store: { read: () => saved, write: v => saved = structuredClone(v) } }); e.now = () => new Date(2026, 10, 18, 9, 5).getTime();
    await e.tick(); assert.equal(made, 0); e.configure({ enabled: true, concern: 'tools', time: '09:00' }); await e.tick(); assert.deepEqual([made, source, selected], [1, 1, 1]);
    e.now = () => new Date(2026, 10, 19, 9).getTime(); await e.tick(); assert.equal(selected, 2); assert.equal(saved.runs[0].chargedMicros, 2000);
    e.configure({ enabled: false, concern: 'tools', time: '09:00' }); e.now = () => new Date(2026, 10, 20, 9).getTime(); await e.tick(); assert.equal(selected, 2);
    e.dispose(); await e.tick(); assert.equal(selected, 2); assert.equal(closed, 1);
  } finally { module.createTransport = original; }
});
