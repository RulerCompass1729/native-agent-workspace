const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { randomUUID } = require('node:crypto');
const { Workspace } = require('../workspace.cjs'), { Claude } = require('../adapters.cjs');
const { ScopedOutboxRuntime } = require('../scoped-outbox-runtime.cjs'), { rootCall } = require('../background-control-native.cjs');
const { rootValidity } = require('../native-root-proof.cjs'), { classifyOutboxFailure } = require('../computer-use-outbox-native.cjs');

// P0-A+B combined boundary (C's review 2026-11-15, blocking point 3): authority
// issued before a native compaction must not survive it, whichever path brings
// the compaction to NAW. Real Workspace.bind, register.js hooks, Claude.hook,
// Claude.observeRoot and ScopedOutboxRuntime; no provider process, model or daily app.
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'naw-compact-control-'));
  const w = new Workspace({ binaries: {}, close() {} }, dir);
  const s = { id: randomUUID(), nativeId: randomUUID(), provider: 'claude', owner: 'human', view: 'terminal',
    controlRevision: 0, peerRevision: 0, memberRevision: 0, messages: [], state: 'working' };
  const r = new Claude(s, w.host, { attachOnly: true });
  r.terminal = { alive: true, input() {} };
  const binding = { sessionId: s.nativeId, ...r.bindRoot({ sessionId: s.nativeId, nativeBlocks: true }) };
  r.observeRoot({ ...binding, epoch: r.observationEpoch, sequence: 1, block: true, id: 'control:turn-start',
    kind: 'control', status: 'running', turnId: 'owned-turn', promptId: 'owned-prompt' });
  w.sessions.set(s.id, s); w.runtimes.set(s.id, r);
  fs.writeFileSync(path.join(dir, 'steward.json'), JSON.stringify({ version: 1, selected: { sessionId: s.id, nativeId: s.nativeId } }), { mode: 0o600 });
  const producer = new ScopedOutboxRuntime(w), client = { destroyed: false }, events = [];
  t.after(() => { producer.closeAll(); w.close(); fs.rmSync(dir, { recursive: true }); });
  let calls = 0;
  const issue = async (turnId = 'owned-turn', promptId = 'owned-prompt') => {
    const args = { action: 'catalog' }, callId = `owned-call-${++calls}`;
    const proof = rootCall(r, { ...binding, epoch: r.observationEpoch, turnId, promptId, callId, arguments: args },
      new AbortController().signal, () => true);
    const opened = await producer.request(client, 'controlCall', { op: randomUUID(), callerId: s.id, identity: proof.identity, arguments: args }, event => events.push(event));
    assert.equal(opened.ok, true, JSON.stringify(opened));
    return () => producer.request(client, 'check', { token: opened.value.token }, () => {});
  };
  const check = await issue();
  w.bind(s, r);
  return { w, s, r, binding, events, check, issue, producer };
}

// The real register.js hook module with a small seed seam (as in midturn-root-prompt.test.cjs).
// Its observation requests go to Claude.observeRoot exactly as the /observation route does.
async function bridge(f, { legacy = false, refuseCompact = false } = {}) {
  let raw = fs.readFileSync(path.join(__dirname, '../claude-bridge/hooks/register.js'), 'utf8');
  if (legacy) raw = raw.replace('const legacyOnly = false;', 'const legacyOnly = true;');
  const source = raw + `
export function seedCompact(binding) {
  stopped = false; observationGap = false; nativeBlocks = true; rootBinding = binding;
  rootPrompt = { id: 'owned-prompt', binding: rootBinding, pending: false };
  activeTurn = 'owned-turn'; rootIdle = false;
  promptTurns.set('owned-prompt', { binding: rootBinding, turnId: 'owned-turn', promptId: 'owned-prompt', ambiguous: false });
}
export function compactState() { return { promptId: rootPrompt?.id ?? null, turnId: activeTurn, observationGap }; }
//${randomUUID()}`;
  const mod = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  const hooks = new Map(), observed = [];
  mod.register((event, match, handler) => { hooks.set(event, typeof match === 'function' ? match : handler); return { catch() {} }; });
  mod.seedCompact({ sessionId: f.s.nativeId, socketPath: '/fixture/socket', token: 'fixture-token', lease: f.binding.lease,
    observationEpoch: f.binding.observationEpoch, observationSequence: 1, gapThrough: 0 });
  const $ = {
    session: { id: async () => f.s.nativeId },
    clock: { after(ms, fn) { const timer = setTimeout(fn, ms); return { cancel() { clearTimeout(timer); } }; } },
    http: { fetch: async (url, spec) => {
      const body = JSON.parse(spec.body);
      if (url !== 'http://localhost/observation') return { ok: true, status: 200, text: '{}' };
      observed.push(body.id);
      if (refuseCompact && body.id === 'control:compact') return { ok: false, status: 409, text: '{}' };
      try { return { ok: true, status: 200, text: JSON.stringify(f.r.observeRoot(body)) }; }
      catch { return { ok: false, status: 409, text: '{}' }; }
    } },
  };
  // SessionStart(source=compact) through the plugin hook. `settingsHook` is NAW's
  // separate settings-hook delivery of the same event, which can be absent.
  const compact = async ({ settingsHook }) => {
    await hooks.get('classic.SessionStart')($, { session_id: f.s.nativeId, source: 'compact' }, async () => {
      if (settingsHook) f.r.hook({ hook_event_name: 'SessionStart', session_id: f.s.nativeId, source: 'compact' });
      return {};
    });
    // enqueueBlock flushes on clock.after(0) (a timer), so yield to timers and
    // wait for both the observed compact row and, when refused, the declared gap.
    for (let i = 0; i < 100 && (!observed.includes('control:compact') || refuseCompact && !mod.compactState().observationGap); i++) await new Promise(resolve => setTimeout(resolve, 2));
    await new Promise(resolve => setImmediate(resolve));
  };
  return { mod, compact, observed };
}

test('compact retires a butler control scope issued and bound before typing (C counterexample)', async t => {
  const f = await fixture(t), b = await bridge(f);
  f.w.input(f.s.id, 'x', f.s.owner);
  assert.equal((await f.check()).ok, true, 'typing alone keeps the issued butler scope');
  await b.compact({ settingsHook: true });
  assert.deepEqual(b.mod.compactState(), { promptId: null, turnId: null, observationGap: false });
  const after = await f.check();
  assert.equal(after.ok, false, 'compaction must retire the existing service control scope');
  assert.equal(after.failureReason, 'grant-invalidated');
});

test('compact retires the issued scope on the ordered observation even when the settings hook is lost', async t => {
  const f = await fixture(t), b = await bridge(f);
  f.w.input(f.s.id, 'x', f.s.owner);
  await b.compact({ settingsHook: false });
  const notice = f.events.find(e => e.kind === 'invalidated'), after = await f.check();
  assert.equal(after.ok, false, 'a lost settings hook must not leave the issued scope valid');
  assert.equal(notice?.failureCheck, 'live-turn-missing', 'the open scope is told at once, not only at its next check');
  assert.equal(f.r.liveTurn, null); assert.deepEqual(b.observed, ['control:compact']);
});

test('compact retires a retained reader root outbox authority, which has no settings hook', async t => {
  const f = await fixture(t), b = await bridge(f, { legacy: true });
  f.r.retainedReader = true;
  const message = { sessionId: f.s.nativeId, lease: f.binding.lease, epoch: f.r.observationEpoch, turnId: 'owned-turn', promptId: 'owned-prompt' };
  const valid = rootValidity(f.r, message, new AbortController().signal, () => true, true);
  assert.equal(valid.failureCheck(), null);
  await b.compact({ settingsHook: false });
  assert.equal(valid.failureCheck(), 'root-turn-missing', 'a retained root outbox authority must not survive the compact');
});

test('after compact the old turn cannot mint a call; only a new native turn re-authorizes', async t => {
  const f = await fixture(t), b = await bridge(f);
  await b.compact({ settingsHook: true });
  assert.throws(() => rootCall(f.r, { ...f.binding, epoch: f.r.observationEpoch, turnId: 'owned-turn', promptId: 'owned-prompt',
    callId: 'late-call', arguments: { action: 'catalog' } }, new AbortController().signal, () => true), e => classifyOutboxFailure(e, 'binding', 'binding-unavailable').failureCheck === 'live-turn-missing');
  // A repeated start of the compacted turn is tombstoned; it revives nothing.
  f.r.observeRoot({ ...f.binding, epoch: f.r.observationEpoch, sequence: 10, block: true, id: 'control:turn-start',
    kind: 'control', status: 'running', turnId: 'owned-turn', promptId: 'owned-prompt' });
  assert.equal(f.r.liveTurn, null);
  f.r.observeRoot({ ...f.binding, epoch: f.r.observationEpoch, sequence: 11, block: true, id: 'control:turn-start',
    kind: 'control', status: 'running', turnId: 'next-turn', promptId: 'next-prompt' });
  const check = await f.issue('next-turn', 'next-prompt');
  assert.equal((await check()).ok, true);
});

test('an older NAW that refuses the compact row gets a declared gap, which also retires authority', async t => {
  const f = await fixture(t), b = await bridge(f, { refuseCompact: true });
  await b.compact({ settingsHook: false });
  assert.equal(b.mod.compactState().observationGap, true);
  f.r.observeRootGap({ sessionId: f.s.nativeId, lease: f.binding.lease, epoch: f.r.observationEpoch, gapThrough: 2 });
  assert.equal((await f.check()).ok, false);
});

test('a compact row must be complete', async t => {
  const f = await fixture(t);
  assert.throws(() => f.r.observeRoot({ ...f.binding, epoch: f.r.observationEpoch, sequence: 2, block: true,
    id: 'control:compact', kind: 'control', status: 'running' }), /Invalid native compact/);
  assert.equal((await f.check()).ok, true);
});

// C's reviewer checks kept as regressions of the combined boundary.
test('exact native proof is still required; observed calls cannot be replayed or replaced', async t => {
  const f = await fixture(t);
  const request = identity => f.producer.request({ destroyed: false }, 'controlCall', { op: randomUUID(), callerId: f.s.id, identity, arguments: { action: 'catalog' } }, () => {});
  const base = { provider: 'claude', nativeId: f.s.nativeId, sessionId: f.s.nativeId, turnId: 'owned-turn', promptId: 'owned-prompt', callId: 'owned-call-1' };
  for (const [identity, reason] of [[{ ...base, callId: 'invented-call' }, 'native-call-missing'], [base, 'duplicate-call'],
    [{ ...base, nativeId: randomUUID() }, 'caller-unavailable']]) {
    const result = await request(identity);
    assert.equal(result.ok, false); assert.equal(result.failureReason, reason);
  }
});

test('Enter keeps the current root, but a confirmed new turn invalidates its issued control scope', async t => {
  const f = await fixture(t);
  f.w.input(f.s.id, '\r', f.s.owner);
  f.r.hook({ hook_event_name: 'UserPromptSubmit', session_id: f.s.nativeId, prompt_id: randomUUID(), prompt: 'SYNTHETIC NEW INPUT' });
  assert.equal((await f.check()).ok, true);
  f.r.observeRoot({ ...f.binding, epoch: f.r.observationEpoch, sequence: 2, block: true, id: 'control:turn-start',
    kind: 'control', status: 'running', turnId: 'new-native-turn', promptId: randomUUID() });
  const after = await f.check();
  assert.equal(after.ok, false); assert.equal(after.failureReason, 'grant-invalidated');
});
