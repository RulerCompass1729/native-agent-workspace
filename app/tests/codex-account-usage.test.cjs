const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { NativeHost } = require('../adapters.cjs');
const { Workspace } = require('../workspace.cjs');
const { codexAccountUsage, usageLines } = require('../native-usage.js');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const snapshot = (percent, id = 'codex') => ({ limitId: id, limitName: null,
  primary: { usedPercent: percent, windowDurationMins: 300, resetsAt: 1730947200 }, secondary: null });
function connection(host, response = { rateLimits: snapshot(37) }) {
  const child = new EventEmitter(); child.exitCode = null; child.signalCode = null;
  host ||= Object.assign(Object.create(NativeHost.prototype), { closed: false, codexTargets: new Map() });
  const rpc = new EventEmitter(); rpc.ws = { readyState: 1 }; rpc.requests = [];
  rpc.call = (method, ...args) => { rpc.requests.push({ method, args }); return typeof response === 'function' ? response(method) : Promise.resolve(response); };
  const target = new EventEmitter(); target.host = host; target.nativeState = 'working'; target.approval = { id: 'actual-native-question' }; target.events = [];
  target.event = event => target.events.push(event);
  target.transportClosed = () => { target.transportDisconnected = true; };
  let changes = 0; target.on('accountUsage', () => changes++);
  host.codexProcess = child; host.codexTargets.set('thread-a', target);
  const watcher = host.watchCodexConnection(rpc, child); watcher.activate();
  return { host, rpc, target, watcher, changes: () => changes };
}

test('native account readings retain window values and are readable without token history', () => {
  const reading = codexAccountUsage({ rateLimits: { ...snapshot(37), secondary: { usedPercent: 81, windowDurationMins: 10080, resetsAt: null } } }, null, 1000);
  const lines = usageLines('codex', { account: reading }, 'en').join('\n');
  assert.match(lines, /Shared account limits.*codex/);
  assert.match(lines, /37%/); assert.match(lines, /81%/); assert.match(lines, /10080/);
  assert.doesNotMatch(lines, /quota windows: not reported|0 tokens/);
  assert.equal(reading.buckets[0].reportedAt, 1000);
  assert.equal(reading.buckets[0].windows[1].resetsAt, undefined);
});

test('missing and invalid quota values stay unknown, while a native zero is preserved', () => {
  assert.equal(codexAccountUsage({ rateLimits: null }), null);
  const reading = codexAccountUsage({ rateLimits: { limitId: 'codex', primary: { usedPercent: '0' }, secondary: { usedPercent: -1 } } });
  assert.deepEqual(reading.buckets[0].windows, []);
  assert.doesNotMatch(usageLines('codex', { account: reading }, 'en').join('\n'), /0%/);
  const zero = codexAccountUsage({ rateLimits: { ...snapshot(0), primary: { usedPercent: 0, resetsAt: 0 } } });
  assert.match(usageLines('codex', { account: zero }, 'en').join('\n'), /0%/);
  assert.equal(zero.buckets[0].windows[0].resetsAt, 0);
});

test('multi-bucket reads use native keys and updates retain other buckets and their timestamps', () => {
  const first = codexAccountUsage({ rateLimits: snapshot(37), rateLimitsByLimitId: { codex: snapshot(37), other: snapshot(48, 'other') } }, null, 1000);
  assert.equal(first.buckets.length, 2);
  const next = codexAccountUsage({ rateLimits: snapshot(82) }, first, 2000);
  assert.equal(next.buckets.find(b => b.id === 'codex').reportedAt, 2000);
  assert.equal(next.buckets.find(b => b.id === 'other').reportedAt, 1000);
  assert.equal(first.buckets.find(b => b.id === 'codex').windows[0].usedPercent, 37);
  assert.equal(codexAccountUsage({ rateLimitsByLimitId: { expected: snapshot(50, 'wrong') } }), null);
});

test('anonymous native updates replace ambiguous earlier readings without duplicating or guessing a bucket', () => {
  const first = codexAccountUsage({ rateLimitsByLimitId: { codex: snapshot(37), other: snapshot(48, 'other') } }, null, 1000);
  const anonymous = codexAccountUsage({ rateLimits: { ...snapshot(81), limitId: null } }, first, 2000);
  assert.equal(anonymous.buckets.length, 1);
  assert.equal(anonymous.buckets[0].id, undefined);
  assert.equal(anonymous.buckets[0].windows[0].usedPercent, 81);
  const named = codexAccountUsage({ rateLimits: snapshot(56) }, anonymous, 3000);
  assert.equal(named.buckets.length, 1); assert.equal(named.buckets[0].id, 'codex');
  assert.equal(first.buckets.length, 2);
});

test('native bucket labels preserve ordinary text and reject control characters', () => {
  const reading = codexAccountUsage({ rateLimitsByLimitId: { bucket: { ...snapshot(37, 'bucket'), limitName: 'Native quota label' } } });
  assert.equal(reading.buckets[0].name, 'Native quota label');
  const bad = codexAccountUsage({ rateLimits: { ...snapshot(37), limitName: 'native\u0001label' } });
  assert.equal(bad.buckets[0].name, undefined);
});

test('connection baseline is metadata only and account notifications do not become thread decisions', async () => {
  const f = connection(); await tick();
  assert.deepEqual(f.rpc.requests.map(r => r.method), ['account/rateLimits/read']);
  assert.equal(f.host.codexAccountUsage.buckets[0].windows[0].usedPercent, 37);
  f.rpc.emit('event', { method: 'account/rateLimits/updated', params: { rateLimits: snapshot(81) } });
  assert.equal(f.host.codexAccountUsage.buckets[0].windows[0].usedPercent, 81);
  assert.equal(f.target.nativeState, 'working'); assert.deepEqual(f.target.approval, { id: 'actual-native-question' });
  assert.equal(f.target.events.length, 0);
  f.rpc.emit('event', { method: 'thread/tokenUsage/updated', params: { threadId: 'thread-a', tokenUsage: { total: {} } } });
  assert.equal(f.target.events.length, 1);
  f.watcher.dispose();
});

test('a newer notification cannot be overwritten by a late initial read', async () => {
  const pending = deferred(), f = connection(null, () => pending.promise);
  f.rpc.emit('event', { method: 'account/rateLimits/updated', params: { rateLimits: snapshot(81) } });
  pending.resolve({ rateLimits: snapshot(9) }); await tick();
  assert.equal(f.host.codexAccountUsage.buckets[0].windows[0].usedPercent, 81);
  assert.equal(f.rpc.requests.length, 1); f.watcher.dispose();
});

test('account identity updates clear readings immediately and coalesce a replacement read', async () => {
  const old = deferred(), fresh = deferred(); let requests = 0;
  const f = connection(null, () => (++requests === 1 ? old.promise : fresh.promise));
  f.rpc.emit('event', { method: 'account/rateLimits/updated', params: { rateLimits: snapshot(81) } });
  for (let i = 0; i < 3; i++) f.rpc.emit('event', { method: 'account/updated', params: { authMode: 'chatgpt', planType: 'pro' } });
  assert.equal(f.host.codexAccountUsage, null); assert.equal(requests, 1);
  old.resolve({ rateLimits: snapshot(9) }); await tick(); assert.equal(requests, 2);
  assert.equal(f.host.codexAccountUsage, null);
  fresh.resolve({ rateLimits: snapshot(56) }); await tick();
  assert.equal(f.host.codexAccountUsage.buckets[0].windows[0].usedPercent, 56); f.watcher.dispose();
});

test('retired connections and disposed reads cannot restore account data', async () => {
  const old = deferred(), f = connection(null, () => old.promise);
  const newer = connection(f.host, { rateLimits: snapshot(56) }); await tick();
  old.resolve({ rateLimits: snapshot(9) }); await tick();
  f.rpc.emit('event', { method: 'account/rateLimits/updated', params: { rateLimits: snapshot(2) } });
  assert.equal(f.host.codexAccountUsage.buckets[0].windows[0].usedPercent, 56);
  newer.watcher.dispose();
  const late = deferred(), g = connection(null, () => late.promise); g.watcher.dispose(); late.resolve({ rateLimits: snapshot(99) }); await tick();
  assert.equal(g.host.codexAccountUsage, null);
});

test('disconnect clears connection quota; unsupported native reads stay unknown', async () => {
  const f = connection(); await tick(); f.rpc.ws.readyState = 3; f.rpc.emit('closed');
  assert.equal(f.host.codexAccountUsage, null); assert.equal(f.target.transportDisconnected, true); f.watcher.dispose();
  const g = connection(null, () => Promise.reject(Error('Method unavailable'))); await tick();
  assert.equal(g.host.codexAccountUsage, null); assert.equal(g.rpc.requests.length, 1); g.watcher.dispose();
});

test('workspace combines only its current connection account reading without persisting or summing it', () => {
  const a = { provider: 'codex', id: 'a', usage: { total: { inputTokens: 12 }, reportedAt: 10, account: { stale: true } } };
  const b = { provider: 'codex', id: 'b', usage: null };
  const host = { codexAccountUsage: codexAccountUsage({ rateLimits: snapshot(81) }, null, 1000) };
  const w = Object.create(Workspace.prototype), r = { host }; w.runtimes = new Map([['a', r], ['b', { host: {} }]]);
  const value = w.usageFor(a); assert.equal(value.total.inputTokens, 12); assert.equal(value.account, host.codexAccountUsage);
  assert.deepEqual(a.usage.account, { stale: true }); assert.equal(w.usageFor(b), null);
  r.transportDisconnected = true; assert.equal(w.usageFor(a).account, undefined);
  assert.match(usageLines('codex', value, 'en').join('\n'), /81%/);
  const claude = { provider: 'claude', usage: { source: 'claude-session-usage' } }; assert.equal(w.usageFor(claude), claude.usage);
});
