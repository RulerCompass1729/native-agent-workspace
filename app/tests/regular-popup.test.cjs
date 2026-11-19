const test = require('node:test'), assert = require('node:assert/strict');
const { RegularPopup, create, DAILY_MICROS, emptyState } = require('../regular-popup.cjs');
const day = new Date(2026, 10, 18, 10).getTime();
const candidates = [{ id: 'one', title: 'Example tool', description: 'Public fixture', url: 'https://github.com/example/tool' }];
function fixture(extra = {}) {
  let at = day, saved = emptyState(), reads = 0, selections = 0, notices = [];
  const store = { read: () => structuredClone(saved), write: value => { saved = structuredClone(value); } };
  const engine = new RegularPopup({ store, now: () => at, permitted: true,
    readSource: async () => { reads++; return candidates; },
    select: async input => { selections++; assert.deepEqual(Object.keys(input).sort(), ['candidates', 'concern']); return { picks: [{ id: 'one', why: 'Matches the supplied concern' }], costMicros: 500 }; },
    notify: value => { notices.push(value); }, ...extra });
  return { engine, store, saved: () => saved, set: value => { at = value; }, stats: () => ({ reads, selections, notices }) };
}
const enable = f => f.engine.configure({ enabled: true, concern: 'Public development tools', time: '09:00' });
test('production factory starts off, offers approved opt-in and ignores caller-supplied transports', async () => {
  let calls = 0; const e = create({ store: { read: () => null, write() {} }, permitted: true, readSource: () => calls++, select: () => calls++ });
  assert.equal(e.status().config.enabled, false); assert.equal(e.status().allowed, true);
  e.configure({ enabled: false, concern: 'Tools', time: '09:00' });
  await e.tick(); assert.equal(calls, 0); e.dispose();
});
test('an enabled fixture record cannot start production execution after a restart', async () => {
  const stored = emptyState(); stored.config = { enabled: true, concern: 'Fixture only', time: '09:00' };
  const e = create({ store: { read: () => stored, write() { assert.fail(); } } });
  e.start(); await e.tick(); assert.equal(e.status().allowed, true); assert.equal(e.status().config.enabled, false); assert.equal(e.timer, null); assert.equal(e.status().runs.length, 0); e.dispose();
});
test('off means no source, selection, notification or timer', async () => {
  let timers = 0; const f = fixture({ setTimer() { timers++; } }); f.engine.start(); await f.engine.tick();
  assert.equal(f.stats().reads, 0); assert.equal(f.stats().selections, 0); assert.equal(timers, 0); f.engine.dispose();
});
test('due tick completes fixture pipeline, normalizes links and sends only a count', async () => {
  const f = fixture(); enable(f); await f.engine.tick(); const s = f.engine.status();
  assert.equal(s.runs[0].state, 'ready'); assert.equal(s.runs[0].items[0].url, candidates[0].url); assert.equal(s.unread, 1);
  assert.deepEqual(f.stats().notices, [{ count: 1 }]); f.engine.dispose();
});
test('repeated and concurrent ticks never select twice, including after a restart', async () => {
  const f = fixture(); enable(f); await Promise.all([f.engine.tick(), f.engine.tick(), f.engine.tick()]);
  assert.equal(f.stats().selections, 1); const e = new RegularPopup({ store: f.store, now: () => day, permitted: true, readSource: () => assert.fail('repeat source'), select: () => assert.fail('repeat selection') });
  await e.tick(); e.dispose(); f.engine.dispose();
});
test('manual read/ignore does not call the source or model and persists', async () => {
  const f = fixture(); enable(f); await f.engine.tick(); const id = f.engine.status().runs[0].id;
  f.engine.mark(id, 'one', 'read'); assert.equal(f.engine.status().unread, 0);
  f.engine.mark(id, 'one', 'ignored'); assert.equal(f.engine.status().runs[0].items[0].ignored, true);
  assert.equal(f.stats().selections, 1); f.engine.dispose();
});
test('daily $0.01 reservation is checked before any source or selection', async () => {
  const f = fixture(); enable(f); await f.engine.tick(); const data = f.saved();
  data.runs[0].day = '2026-11-17'; data.runs[0].chargedMicros = 5000; data.runs[0].attempted = false; f.store.write(data);
  let calls = 0; const e = new RegularPopup({ store: f.store, now: () => day, permitted: true, readSource: () => calls++, select: () => calls++ });
  await e.tick(); assert.equal(calls, 0); assert.equal(e.status().runs[0].state, 'budget'); assert.equal(DAILY_MICROS, 10000); e.dispose(); f.engine.dispose();
});
test('unknown usage holds the reservation and cannot be retried or shown as success', async () => {
  const f = fixture({ select: async () => ({ picks: [{ id: 'one', why: 'Example' }] }) }); enable(f); await f.engine.tick();
  assert.equal(f.engine.status().runs[0].state, 'unconfirmed'); assert.equal(f.engine.status().runs[0].chargedMicros, 7000);
  assert.equal(f.engine.status().unread, 0); assert.equal(f.stats().notices.length, 0); f.engine.dispose();
});
test('invalid and over-reservation usage fail closed', async () => {
  for (const costMicros of [-1, NaN, Infinity, 0.5, 7001]) { const f = fixture({ select: async () => ({ picks: [], costMicros }) }); enable(f); await f.engine.tick(); assert.equal(f.engine.status().runs[0].state, 'unconfirmed'); f.engine.dispose(); }
});
test('fetch failure never selects, and model failure never retries', async () => {
  const f = fixture({ readSource: async () => { throw Error('private upstream text'); } }); enable(f); await f.engine.tick();
  assert.equal(f.stats().selections, 0); assert.equal(f.engine.status().runs[0].state, 'source-failed'); assert.ok(!JSON.stringify(f.engine.status()).includes('private upstream')); f.engine.dispose();
  let n = 0; const g = fixture({ select: async () => { n++; throw Error('provider text'); } }); enable(g); await g.engine.tick(); await g.engine.tick(); assert.equal(n, 1); assert.equal(g.engine.status().runs[0].state, 'unconfirmed'); g.engine.dispose();
});
test('source and output URLs/IDs cannot introduce an external URL or an unknown item', async () => {
  for (const url of ['http://github.com/a/b', 'https://127.0.0.1/a/b', 'https://github.com@example.com/a/b', 'https://github.com/a/b?redirect=x', 'javascript:alert(1)']) {
    const f = fixture({ readSource: async () => [{ ...candidates[0], url }] }); enable(f); await f.engine.tick(); assert.equal(f.engine.status().runs[0].state, 'source-failed'); assert.equal(f.stats().selections, 0); f.engine.dispose();
  }
  const f = fixture({ select: async () => ({ picks: [{ id: 'forged', why: 'x' }], costMicros: 1 }) }); enable(f); await f.engine.tick(); assert.equal(f.engine.status().runs[0].state, 'unconfirmed'); assert.equal(f.stats().notices.length, 0); f.engine.dispose();
});
test('turning off while source is pending prevents selection', async () => {
  let release; const f = fixture({ readSource: () => new Promise(r => { release = r; }) }); enable(f); const flight = f.engine.tick();
  f.engine.configure({ enabled: false, concern: 'Public development tools', time: '09:00' }); release(candidates); await flight;
  assert.equal(f.stats().selections, 0); assert.equal(f.stats().notices.length, 0); f.engine.dispose();
});
test('late selection after a change cannot publish or notify', async () => {
  let release; const f = fixture({ select: () => new Promise(r => { release = r; }) }); enable(f); const flight = f.engine.tick();
  await new Promise(r => setImmediate(r)); f.engine.configure({ enabled: false, concern: 'Changed', time: '09:00' });
  release({ picks: [{ id: 'one', why: 'old' }], costMicros: 500 }); await flight; assert.equal(f.engine.status().unread, 0); assert.equal(f.stats().notices.length, 0); f.engine.dispose();
});
test('notification failure preserves the durable card', async () => {
  const f = fixture({ notify() { throw Error('notifications unavailable'); } }); enable(f); await f.engine.tick(); assert.equal(f.engine.status().runs[0].state, 'ready'); assert.equal(f.engine.status().unread, 1); f.engine.dispose();
});
test('one most recent missed day is caught up, and rollback cannot repeat it', async () => {
  const f = fixture(); enable(f); f.set(new Date(2026, 10, 22, 8).getTime()); await f.engine.tick();
  assert.equal(f.engine.status().runs.length, 1); assert.equal(f.engine.status().runs[0].day, '2026-11-21');
  f.set(new Date(2026, 10, 21, 10).getTime()); await f.engine.tick(); assert.equal(f.stats().selections, 1); f.engine.dispose();
});
test('a catch-up and current-day trigger share the execution-day paid-call limit', async () => {
  const f = fixture(); enable(f); f.set(new Date(2026, 10, 22, 8).getTime()); await f.engine.tick();
  f.set(new Date(2026, 10, 22, 10).getTime()); await f.engine.tick(); assert.equal(f.stats().selections, 1); assert.equal(f.engine.status().runs[0].state, 'daily-limit'); f.engine.dispose();
});
test('counterexample_fetch_crossing_midnight_preserves_daily_execution_budget', async () => {
  let at = new Date(2026, 10, 18, 23, 59).getTime(), release, reads = 0; const calls = [];
  const f = fixture({ now: () => at, readSource: () => ++reads === 1 ? new Promise(resolve => { release = resolve; }) : candidates,
    select: async () => { calls.push({ at, costMicros: 7000 }); return { picks: [], costMicros: 7000 }; } });
  f.engine.configure({ enabled: true, concern: 'Cross-midnight budget fixture', time: '00:00' });
  const first = f.engine.tick(); at = new Date(2026, 10, 19, 0, 2).getTime(); release(candidates); await first; await f.engine.tick();
  assert.ok(calls.reduce((n, call) => n + call.costMicros, 0) <= DAILY_MICROS);
  const paid = f.engine.status().runs.find(r => r.attempted);
  assert.equal(paid.day, '2026-11-18'); assert.equal(paid.budgetDay, '2026-11-19'); assert.equal(paid.budgetAt, at);
  assert.equal(calls.length, 1); f.engine.dispose();
});
test('budget is rechecked after fetching, with reservation durable before selection', async () => {
  let at = day, release, selected = 0;
  const f = fixture({ now: () => at, readSource: () => new Promise(resolve => { release = resolve; }),
    select: async () => { selected++; const paid = f.saved().runs.find(r => r.attempted); assert.equal(paid.budgetAt, at); assert.equal(paid.budgetDay, '2026-11-19'); assert.equal(paid.chargedMicros, 7000); return { picks: [], costMicros: 7000 }; } });
  enable(f); const pending = f.engine.tick(); at += 86400000; release(candidates); await pending;
  assert.equal(selected, 1); assert.equal(f.saved().runs[0].budgetAt, at); f.engine.dispose();
});
test('returning west to a spent budget date accumulates that date instead of resetting it', async () => {
  const previous = process.env.TZ; let calls = 0;
  try {
    process.env.TZ = 'Pacific/Honolulu'; const at = Date.parse('2026-11-19T09:30:00Z');
    const f = fixture({ now: () => at, select: async () => { calls++; return { picks: [], costMicros: 7000 }; } });
    f.engine.configure({ enabled: true, concern: 'Timezone fixture', time: '23:59' }); await f.engine.tick();
    assert.equal(f.saved().runs[0].day, '2026-11-17'); assert.equal(f.saved().runs[0].budgetDay, '2026-11-18');
    process.env.TZ = 'Pacific/Kiritimati'; enable(f); await f.engine.tick();
    assert.equal(calls, 2); assert.equal(f.saved().runs[0].budgetDay, '2026-11-19'); assert.equal(f.saved().runs[1].budgetDay, '2026-11-18');
    process.env.TZ = 'Pacific/Honolulu'; await f.engine.tick();
    assert.equal(calls, 2); assert.equal(f.saved().runs[0].day, '2026-11-18'); assert.equal(f.saved().runs[0].budgetDay, '2026-11-18'); assert.equal(f.saved().runs[0].state, 'budget'); f.engine.dispose();
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});
test('DST spring has distinct budget dates even when only 23 hours elapsed', async () => {
  const previous = process.env.TZ; let at = Date.parse('2026-03-07T14:00:00Z'), calls = 0;
  try {
    process.env.TZ = 'America/New_York';
    const f = fixture({ now: () => at, select: async () => { calls++; return { picks: [], costMicros: 7000 }; } });
    enable(f); await f.engine.tick(); at += 23 * 3600000;
    assert.equal(new Date(at).getHours(), 9); await f.engine.tick(); assert.equal(calls, 2);
    assert.deepEqual(f.saved().runs.map(r => r.budgetDay), ['2026-03-08', '2026-03-07']); f.engine.dispose();
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});
test('DST repeated hour cannot reset the same budget date for a new source period', async () => {
  const previous = process.env.TZ; let at = Date.parse('2026-11-01T05:30:00Z'), calls = 0;
  try {
    process.env.TZ = 'America/New_York';
    const f = fixture({ now: () => at, select: async () => { calls++; return { picks: [], costMicros: 7000 }; } });
    f.engine.configure({ enabled: true, concern: 'Repeated-hour fixture', time: '02:00' }); await f.engine.tick();
    assert.equal(f.saved().runs[0].day, '2026-10-31'); at += 3600000; assert.equal(new Date(at).getHours(), 1);
    f.engine.configure({ enabled: true, concern: 'Repeated-hour fixture', time: '00:00' }); await f.engine.tick(); assert.equal(calls, 1); assert.equal(f.saved().runs[0].day, '2026-11-01');
    assert.equal(f.saved().runs[0].budgetDay, '2026-11-01'); assert.equal(f.saved().runs[0].state, 'budget'); f.engine.dispose();
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});
test('wall-clock date change and restart use the stored date ledger without a rolling hold', async () => {
  let at = day, calls = 0;
  const options = { now: () => at, select: async () => { calls++; return { picks: [], costMicros: 7000 }; } };
  const f = fixture(options); enable(f); await f.engine.tick(); f.engine.dispose(); const prior = f.saved().runs[0]; at += 2 * 86400000;
  const e = new RegularPopup({ ...options, store: f.store, permitted: true, readSource: async () => candidates }); await e.tick();
  assert.equal(calls, 2); assert.deepEqual(e.status().runs[1], prior); assert.equal(e.status().runs[0].budgetDay, '2026-11-20'); e.dispose();
});
test('legacy and offline r2 clock metadata do not hold a different budget date or rewrite history', async () => {
  for (const legacy of [false, true]) {
    let at = day, calls = 0;
    const options = { now: () => at, select: async () => { calls++; return { picks: [], costMicros: 7000 }; } };
    const f = fixture(options); enable(f); await f.engine.tick(); f.engine.dispose();
    const s = f.saved(); if (legacy) { delete s.runs[0].budgetAt; delete s.runs[0].budgetMonoMs; } else s.runs[0].budgetMonoMs = 999999999;
    f.store.write(s); at += 86400000;
    const e = new RegularPopup({ ...options, store: f.store, permitted: true, readSource: async () => candidates }); await e.tick();
    assert.equal(calls, 2); assert.deepEqual(e.status().runs[1], s.runs[0]); e.dispose();
  }
});
test('adjacent midnight budget dates can each spend 7000 even two minutes apart', async () => {
  let at = new Date(2026, 10, 18, 23, 59).getTime(), calls = 0;
  const f = fixture({ now: () => at, select: async () => { calls++; return { picks: [], costMicros: 7000 }; } });
  f.engine.configure({ enabled: true, concern: 'Daily budget positive control', time: '00:00' }); await f.engine.tick();
  at += 2 * 60000; await f.engine.tick(); assert.equal(calls, 2);
  assert.deepEqual(f.saved().runs.map(r => [r.budgetDay, r.chargedMicros]), [['2026-11-19', 7000], ['2026-11-18', 7000]]); f.engine.dispose();
});
test('storage refusal is fail closed and never selects', async () => {
  const f = fixture({ store: { read() { throw Error('untrusted file'); }, write() { assert.fail(); } } });
  assert.equal(f.engine.status().error, 'storage-unavailable'); await f.engine.tick(); assert.equal(f.stats().reads, 0); f.engine.dispose();
});
test('configure only accepts known fields and valid local time', () => {
  const f = fixture(); for (const patch of [{ enabled: true, concern: 'x', time: '25:00' }, { enabled: true, concern: '', time: '09:00' }, { enabled: true, concern: 'x', time: '09:00', approved: true }]) assert.throws(() => f.engine.configure(patch)); f.engine.dispose();
});
test('a single due timer is armed and disposal cancels it', () => {
  let timers = 0, cancelled = 0; const f = fixture({ setTimer() { timers++; return { unref() {} }; }, clearTimer() { cancelled++; } });
  enable(f); f.engine.start(); assert.equal(timers, 1); f.engine.dispose(); assert.equal(cancelled, 1);
});
test('real fetch and HTTPS request paths remain unused with the fixture pipeline', async () => {
  const https = require('node:https'), originalFetch = global.fetch, originalRequest = https.request;
  let realCalls = 0; const forbidden = () => { realCalls++; throw Error('Real network forbidden'); };
  global.fetch = forbidden; https.request = forbidden;
  try { const f = fixture(); enable(f); await f.engine.tick(); assert.equal(f.stats().selections, 1); assert.equal(realCalls, 0); f.engine.dispose(); }
  finally { global.fetch = originalFetch; https.request = originalRequest; }
});
test('malformed persisted state cannot reset the daily budget', async () => {
  for (const value of [false, 0, {}, { ...emptyState(), runs: [{ chargedMicros: -1 }] }]) {
    const f = fixture({ store: { read: () => value, write() { assert.fail(); } } }); await f.engine.tick(); assert.equal(f.engine.status().error, 'storage-unavailable'); assert.equal(f.stats().reads, 0); f.engine.dispose();
  }
});
test('a synchronous cancellation at the reservation boundary prevents selection', async () => {
  let engine, selected = 0;
  const f = fixture({ select: () => { selected++; }, changed: value => { if (value.config.enabled && value.runs[0]?.state === 'generating') engine.configure({ enabled: false, concern: 'x', time: '09:00' }); } });
  engine = f.engine; enable(f); await engine.tick(); assert.equal(selected, 0); assert.equal(engine.status().error, null); assert.equal(engine.status().runs[0].state, 'cancelled'); engine.dispose();
});
test('the person-only Main handler rejects background callers before reading or changing a record', () => {
  const fs = require('node:fs'), vm = require('node:vm'), source = fs.readFileSync(require.resolve('../main.cjs'), 'utf8');
  const start = source.indexOf("  register('discoveries',"), end = source.indexOf("  register('connectionUpdates',", start); let handler, calls = 0;
  vm.runInNewContext(source.slice(start, end), { register: (_, fn) => handler = fn, isCurrentHumanContext: c => !c.background,
    uiError: code => Error(code), discoveries: { status: () => calls++, configure: () => calls++, mark: () => calls++ } });
  for (const action of ['status', 'configure', 'mark']) assert.throws(() => handler({ background: true }, action), /personOnly/);
  assert.equal(calls, 0); handler({ background: false }, 'status'); assert.equal(calls, 1);
});
test('file storage refuses a symbolic link and a FIFO without blocking', () => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), cp = require('node:child_process'), { FileStore } = require('../regular-popup.cjs');
  const scratch = require('../../scripts/fixtures/test-scratch.cjs'), root = scratch.directory(path.join(os.tmpdir(), 'naw-discovery-store-'));
  const target = path.join(root, 'regular-popup.json'); fs.symlinkSync(path.join(root, 'missing'), target); assert.throws(() => new FileStore(root).read()); fs.unlinkSync(target);
  cp.execFileSync('mkfifo', [target]); assert.throws(() => new FileStore(root).read()); fs.unlinkSync(target);
});
