const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm'), { randomUUID } = require('node:crypto');
const { Workspace } = require('../workspace.cjs'), { Claude } = require('../adapters.cjs');
const { ScopedOutboxRuntime } = require('../scoped-outbox-runtime.cjs'), { rootCall } = require('../background-control-native.cjs');
const bridgeSource = fs.readFileSync(path.join(__dirname, '../claude-bridge/hooks/register.js'), 'utf8');

// A mid-turn native compaction is followed by the engine's next step of the same root turn, with no new
// turn start or prompt (measured on 2.1.329). That step gives the turn back what it held; nothing else
// does, and everything issued before the compact stays retired. Real register.js hooks, Claude.bindRoot,
// observeRoot and hook, rootCall and ScopedOutboxRuntime; no provider process, model or daily app.
const TOOLS = { control: 'mcp__native_workspace__workspace_control', operator: 'mcp__native_workspace__workspace_sessions', message: 'mcp__native_workspace__workspace_message' };
const DENY = { control: 'Background control requires the actual native root call.',
  operator: 'Operator calls require this confirmed native root turn and its unambiguous prompt.', message: '没有本原生主会话的定向协作授权。' };
const KINDS = Object.keys(TOOLS), ENGINE = { plugin: 'engine', tier: 'core' };
const allowed = result => !result.deny && result.isError === false;

async function fixture(t, { capability = true, retained = false } = {}) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'naw-compact-continue-'));
  const w = new Workspace({ binaries: {}, close() {} }, dir);
  const s = { id: randomUUID(), nativeId: randomUUID(), provider: 'claude', owner: 'human', view: 'terminal',
    controlRevision: 0, peerRevision: 0, memberRevision: 0, messages: [], state: 'working' };
  const r = new Claude(s, w.host, { attachOnly: true });
  r.terminal = { alive: true, input() {} };
  if (retained) r.retainedReader = true;
  const binding = { sessionId: s.nativeId, ...r.bindRoot({ sessionId: s.nativeId, nativeBlocks: true, ...(capability ? { nativeTurnContinue: true } : {}) }) };
  let sequence = 0;
  const row = fields => r.observeRoot({ ...binding, epoch: r.observationEpoch, sequence: ++sequence, block: true, kind: 'control', status: 'complete', ...fields });
  row({ id: 'control:turn-start', status: 'running', turnId: 'owned-turn', promptId: 'owned-prompt' });
  w.sessions.set(s.id, s); w.runtimes.set(s.id, r);
  fs.writeFileSync(path.join(dir, 'steward.json'), JSON.stringify({ version: 1, selected: { sessionId: s.id, nativeId: s.nativeId } }), { mode: 0o600 });
  const producer = new ScopedOutboxRuntime(w), client = { destroyed: false };
  t.after(() => { producer.closeAll(); w.close(); fs.rmSync(dir, { recursive: true }); });
  let calls = 0;
  const mint = (turnId = 'owned-turn', promptId = 'owned-prompt') => rootCall(r, { ...binding, epoch: r.observationEpoch, turnId, promptId,
    callId: `owned-call-${++calls}`, arguments: { action: 'catalog' } }, new AbortController().signal, () => true);
  const issue = async () => {
    const proof = mint();
    const opened = await producer.request(client, 'controlCall', { op: randomUUID(), callerId: s.id, identity: proof.identity, arguments: { action: 'catalog' } }, () => {});
    assert.equal(opened.ok, true, JSON.stringify(opened));
    return () => producer.request(client, 'check', { token: opened.value.token }, () => {});
  };
  const check = await issue();
  w.bind(s, r);
  const states = [], ends = [];
  r.on('state', state => states.push(state)); r.on('nativeTurnEnd', end => ends.push(end.status));
  const settingsCompact = () => r.hook({ hook_event_name: 'SessionStart', session_id: s.nativeId, source: 'compact' });
  return { w, s, r, binding, check, issue, mint, row, states, ends, settingsCompact, sequence: () => sequence, skip: n => { sequence = n; } };
}

// The real hook module with a seed seam (as in compact-control-retirement.test.cjs). Its requests reach
// NAW as claude-submit.cjs routes them: rows to observeRoot, a control call to rootCall's own check.
async function bridge(f, { capability = true, ambiguous = false } = {}) {
  const source = bridgeSource + `
export function seedTurn(binding, ambiguous) {
  stopped = false; observationGap = false; nativeBlocks = true; addressedTool = true; operatorTools = Object.keys(operatorSchemas); rootBinding = binding;
  rootPrompt = { id: 'owned-prompt', binding: rootBinding, pending: false };
  activeTurn = 'owned-turn'; rootIdle = false;
  promptTurns.set('owned-prompt', { binding: rootBinding, turnId: 'owned-turn', promptId: 'owned-prompt', ambiguous });
}
export function bridgeState() { return { promptId: rootPrompt?.id ?? null, turnId: activeTurn, observationGap }; }
export function loseObservation() { markObservationGap(rootBinding); }
export function drained() { return !observing && !observations.length; }
//${randomUUID()}`;
  const mod = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  const hooks = new Map(), observed = [], reached = [];
  mod.register((event, match, handler) => {
    hooks.set(typeof match === 'object' && match?.tool ? `${event}:${match.tool}` : event, typeof match === 'function' ? match : handler);
    return { catch() {} };
  });
  mod.seedTurn({ sessionId: f.s.nativeId, socketPath: '/fixture/socket', token: 'fixture-token', lease: f.binding.lease,
    observationEpoch: f.binding.observationEpoch, observationSequence: f.sequence(), gapThrough: 0, nativeTurnContinue: capability && f.binding.nativeTurnContinue === true }, ambiguous);
  const reply = value => ({ ok: true, status: 200, text: JSON.stringify(value) });
  const $ = {
    session: { id: async () => f.s.nativeId },
    clock: { after(ms, fn) { const timer = setTimeout(fn, ms); return { cancel() { clearTimeout(timer); } }; } },
    http: { fetch: async (url, spec) => {
      const body = JSON.parse(spec.body), route = url.slice('http://localhost'.length);
      if (route === '/observation') {
        observed.push(body.id);
        try { const result = f.r.observeRoot(body); f.skip(body.sequence); return reply(result); }
        catch { return { ok: false, status: 409, text: '{}' }; }
      }
      if (!['/background-control', '/operator-call', '/addressed-message'].includes(route)) return reply({});
      reached.push(route);
      if (route === '/background-control') {
        try { rootCall(f.r, body, new AbortController().signal, () => true); return reply({ state: 'complete' }); }
        catch (error) { return reply({ state: 'unconfirmed', error: error.message }); }
      }
      // operator-control.cjs actor() and session-wake.cjs: the caller is NAW's live root turn and prompt.
      const live = f.r.liveTurn?.id === body.turnId && f.r.liveTurn.promptId === body.promptId;
      return reply({ status: live ? route === '/operator-call' ? 'complete' : 'staged' : 'refused' });
    } },
  };
  const settle = async () => {
    for (let i = 0; i < 500 && !mod.drained(); i++) await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal(mod.drained(), true, 'the observation queue drains');
  };
  const compact = async ({ hookFirst = false } = {}) => {
    await hooks.get('classic.SessionStart')($, { session_id: f.s.nativeId, source: 'compact' }, async () => { if (hookFirst) f.settingsCompact(); return {}; });
    await settle();
  };
  const step = async (turnId = 'owned-turn', { agentId, origin = ENGINE } = {}) => {
    const next = async function* () { yield { kind: 'text' }; return 'done'; };
    if (origin) next.origin = origin;
    const iterator = hooks.get('turn.step')($, { turnId, index: 1, ...(agentId ? { agentId } : {}) }, next);
    let item; do { item = await iterator.next(); } while (!item.done);
    await settle();
  };
  const call = (kind, { agentId, origin = ENGINE, toolUseId = `toolu_${randomUUID()}` } = {}) => {
    const input = { control: { action: 'catalog' }, operator: {}, message: { recipient_id: 'peer', message: 'SYNTHETIC MESSAGE' } }[kind];
    const approval = { control: { approved: true, background: input }, operator: { approved: true, operator: 'workspace_sessions', arguments: {} }, message: { approved: true, ...input } }[kind];
    const next = async () => ({ text: JSON.stringify(approval) });
    if (origin) next.origin = origin;
    return hooks.get(`tool.call:${TOOLS[kind]}`)($, { ...input, ...(agentId ? { agentId } : {}), ...(toolUseId === null ? {} : { tool_use_id: toolUseId }) }, next);
  };
  const allDenied = async (label, options) => {
    const before = reached.length;
    for (const kind of KINDS) assert.equal((await call(kind, options)).deny, DENY[kind], `${kind}: ${label}`);
    assert.equal(reached.length, before, `${label}: nothing reaches NAW`);
  };
  const allAllowed = async label => { for (const kind of KINDS) assert.equal(allowed(await call(kind)), true, `${kind}: ${label}`); };
  return { mod, hooks, $, observed, reached, settle, compact, step, call, allDenied, allAllowed };
}
const RESTORED = { promptId: 'owned-prompt', turnId: 'owned-turn', observationGap: false }, RETIRED = { promptId: null, turnId: null, observationGap: false };

test('the engine\'s next step of the compacted root turn gives it back control, operator and message calls', async t => {
  const f = await fixture(t), b = await bridge(f), liveBefore = f.r.liveTurn;
  await b.allAllowed('before the compact');
  await b.compact();
  assert.deepEqual(b.mod.bridgeState(), RETIRED);
  assert.equal(f.r.liveTurn, null); assert.equal(f.r.rootTurn, null);
  await b.allDenied('between the compact and the turn\'s next step');
  assert.throws(() => f.mint(), 'NAW itself mints nothing for the compacted turn before the proof');
  f.settingsCompact(); // measured order: the settings hook follows the ordered row
  await b.step();
  assert.deepEqual(b.mod.bridgeState(), RESTORED);
  assert.deepEqual(b.observed.slice(0, 2), ['control:compact', 'control:turn-continue']);
  assert.deepEqual([...new Set(b.observed.slice(2))], ['control:activity']);
  assert.notEqual(f.r.liveTurn, liveBefore, 'a new reference: nothing issued before the compact matches it');
  assert.deepEqual({ id: f.r.liveTurn.id, promptId: f.r.liveTurn.promptId }, { id: 'owned-turn', promptId: 'owned-prompt' });
  await b.allAllowed('in the continued turn');
  assert.equal(f.states.includes('idle'), false, 'a turn that goes on is not shown idle');
  const old = await f.check();
  assert.equal(old.ok, false, 'the scope issued before the compact stays retired'); assert.equal(old.failureReason, 'grant-invalidated');
  assert.equal((await (await f.issue())()).ok, true, 'a call of the continued turn opens its own scope');
  await b.hooks.get('turn.complete')(b.$, { turnId: 'owned-turn', reason: 'answer', answer: '' }, async () => ({}));
  await b.settle();
  assert.deepEqual(f.ends, ['completed'], 'the continued turn ends as the turn that started');
  for (const kind of KINDS) assert.equal(allowed(await b.call(kind)), false, `${kind}: NAW refuses a call after the turn ended`);
});

test('in the continued turn a sub-agent, another origin and a call without a tool use id are still refused', async t => {
  const f = await fixture(t), b = await bridge(f);
  await b.compact(); await b.step();
  assert.deepEqual(b.mod.bridgeState(), RESTORED);
  await b.allDenied('a sub-agent or background agent call', { agentId: 'agent-1' });
  await b.allDenied('a call another mod made', { origin: { plugin: 'another-mod', tier: 'user' } });
  await b.allDenied('a call with no origin', { origin: null });
  await b.allDenied('a call with no tool use id', { toolUseId: null });
  // Another session: NAW checks the binding itself, whatever a bridge sends.
  assert.throws(() => rootCall(f.r, { ...f.binding, sessionId: randomUUID(), epoch: f.r.observationEpoch, turnId: 'owned-turn', promptId: 'owned-prompt',
    callId: 'other-session-call', arguments: { action: 'catalog' } }, new AbortController().signal, () => true));
  await b.allAllowed('the root turn\'s own calls');
});

test('only the engine\'s own step of that same root turn proves the continuation', async t => {
  const f = await fixture(t), b = await bridge(f);
  await b.compact();
  await b.step('owned-turn', { agentId: 'agent-1' });
  await b.step('owned-turn', { origin: { plugin: 'another-mod', tier: 'user' } });
  await b.step('owned-turn', { origin: { plugin: 'engine', tier: 'user' } });
  await b.step('owned-turn', { origin: null });
  assert.deepEqual(b.mod.bridgeState(), RETIRED); assert.equal(f.r.liveTurn, null);
  await b.allDenied('after steps that prove nothing');
  await b.step();
  assert.deepEqual(b.mod.bridgeState(), RESTORED, 'those steps left the kept turn for the engine\'s own step');
  await b.allAllowed('after the engine\'s own step');
});

test('the engine\'s step of another turn restores nothing, then or later', async t => {
  const f = await fixture(t), b = await bridge(f);
  await b.compact();
  await b.step('another-turn');
  await b.step();
  assert.deepEqual(b.mod.bridgeState(), RETIRED);
  assert.deepEqual(b.observed, ['control:compact']);
  await b.allDenied('after another turn\'s step');
});

for (const [name, between, state = RETIRED] of [
  ['a prompt submitted in between', b => b.hooks.get('prompt.submit')(b.$, { origin: { kind: 'composer' } }, async () => ({}))],
  ['a root UserPromptSubmit in between', (b, f) => b.hooks.get('classic.UserPromptSubmit')(b.$, { session_id: f.s.nativeId, prompt_id: randomUUID(), prompt: 'SYNTHETIC NEW INPUT' }, async () => ({ block: true }))],
  ['the turn\'s end in between', b => b.hooks.get('turn.complete')(b.$, { turnId: 'owned-turn', reason: 'answer', answer: '' }, async () => ({}))],
  ['a lost observation in between', b => b.mod.loseObservation(), { ...RETIRED, observationGap: true }],
]) test(`${name} leaves the compacted turn retired`, async t => {
  const f = await fixture(t), b = await bridge(f);
  await b.compact();
  await between(b, f); await b.settle();
  await b.step();
  assert.deepEqual(b.mod.bridgeState(), state);
  assert.equal(b.observed.includes('control:turn-continue'), false);
  assert.equal(f.r.liveTurn, null);
  await b.allDenied(name);
});

test('a new turn after the compact holds only its own authorization', async t => {
  const f = await fixture(t), b = await bridge(f);
  await b.compact();
  await b.hooks.get('turn.start')(b.$, { turnId: 'next-turn' }, () => ({}));
  await b.step('next-turn'); await b.step();
  assert.deepEqual(b.mod.bridgeState(), { promptId: null, turnId: 'next-turn', observationGap: false });
  assert.equal(b.observed.includes('control:turn-continue'), false);
  await b.allDenied('a turn that no prompt of its own started');
});

test('a compaction with no running turn, or under an ambiguous prompt link, keeps nothing', async t => {
  const idle = await fixture(t), bi = await bridge(idle);
  await bi.hooks.get('turn.complete')(bi.$, { turnId: 'owned-turn', reason: 'answer', answer: '' }, async () => ({}));
  await bi.settle(); await bi.compact(); await bi.step();
  assert.equal(bi.observed.includes('control:turn-continue'), false);
  await bi.allDenied('after an idle compaction');
  const f = await fixture(t), b = await bridge(f, { ambiguous: true });
  await b.allDenied('an ambiguous link before the compact');
  await b.compact(); await b.step();
  assert.deepEqual(b.mod.bridgeState(), RETIRED);
  assert.equal(b.observed.includes('control:turn-continue'), false);
  await b.allDenied('an ambiguous link after the compact');
});

test('a second compaction before the proof still ends in one restored turn; one after it retires again', async t => {
  const f = await fixture(t), b = await bridge(f);
  await b.compact(); await b.compact();
  await b.step();
  assert.deepEqual(b.mod.bridgeState(), RESTORED);
  await b.allAllowed('after two compactions and the proof');
  const check = await f.issue();
  await b.compact();
  assert.equal((await check()).ok, false, 'each compaction retires what was issued before it');
  await b.allDenied('after the next compaction');
  await b.step();
  await b.allAllowed('after its own proof');
});

test('without the negotiated capability a compaction retires the turn as before', async t => {
  for (const [adapter, mod] of [[false, false], [true, false]]) {
    const f = await fixture(t, { capability: adapter }), b = await bridge(f, { capability: mod });
    await b.compact({ hookFirst: true }); await b.step();
    assert.deepEqual(b.mod.bridgeState(), RETIRED);
    assert.deepEqual(b.observed, ['control:compact']);
    assert.equal(f.r.liveTurn, null);
    await b.allDenied('an older bridge or NAW');
    assert.equal((await f.check()).ok, false);
  }
  const old = await fixture(t, { capability: false });
  assert.equal(old.binding.nativeTurnContinue, false);
  old.row({ id: 'control:compact' });
  assert.equal(old.states.at(-1), undefined);
  old.settingsCompact();
  assert.equal(old.states.at(-1), 'idle', 'the settings hook alone still reports idle there');
  assert.throws(() => old.row({ id: 'control:turn-continue', status: 'running', turnId: 'owned-turn', promptId: 'owned-prompt' }), /Invalid native turn continuation/);
  assert.equal(old.r.liveTurn, null);
  assert.equal((await fixture(t, { retained: true })).binding.nativeTurnContinue, false, 'a retained reader never gets it');
});

// NAW's own side, whatever order the rows and hooks arrive in.
const CONTINUE = { id: 'control:turn-continue', status: 'running', turnId: 'owned-turn', promptId: 'owned-prompt' };
for (const [name, between, fields = {}] of [
  ['a new prompt', f => f.r.hook({ hook_event_name: 'UserPromptSubmit', session_id: f.s.nativeId, prompt_id: randomUUID(), prompt: 'SYNTHETIC NEW INPUT' })],
  ['an input boundary', f => f.row({ id: 'control:input' })],
  ['a permission boundary', f => f.row({ id: 'control:permission' })],
  ['a declared gap', f => f.r.observeRootGap({ sessionId: f.s.nativeId, lease: f.binding.lease, epoch: f.r.observationEpoch, gapThrough: f.sequence() })],
  ['the turn\'s end', f => f.row({ id: 'turn:owned-turn', kind: 'turn', turnId: 'owned-turn', text: '' })],
  ['a new turn start', f => f.row({ id: 'control:turn-start', status: 'running', turnId: 'next-turn', promptId: 'next-prompt' }), null],
  ['a replayed continuation', () => {}, { replayed: true }],
  ['a continuation that carries a gap', () => {}, { gap: true }],
  ['a continuation of another turn', () => {}, { turnId: 'another-turn' }],
  ['a continuation under another prompt', () => {}, { promptId: 'another-prompt' }],
]) test(`NAW restores nothing after ${name}`, async t => {
  const f = await fixture(t);
  f.row({ id: 'control:compact' });
  between(f);
  const live = f.r.liveTurn;
  f.row({ ...CONTINUE, ...fields });
  assert.equal(f.r.liveTurn, live, 'the continuation changes nothing');
  assert.notEqual(f.r.liveTurn?.id, 'owned-turn');
  assert.throws(() => f.mint(), 'the compacted turn mints nothing');
  assert.equal((await f.check()).ok, false);
});

test('NAW accepts one continuation per compaction, only from its own root connection', async t => {
  const f = await fixture(t);
  f.row({ id: 'control:compact' });
  assert.throws(() => f.r.observeRoot({ sessionId: f.s.nativeId, lease: 'another-lease', epoch: f.r.observationEpoch, sequence: f.sequence() + 1, block: true, kind: 'control', ...CONTINUE }));
  assert.throws(() => f.row({ ...CONTINUE, status: 'complete' }), /Invalid native turn continuation/);
  assert.equal(f.r.liveTurn, null);
  f.row(CONTINUE);
  const live = f.r.liveTurn;
  assert.equal(live?.id, 'owned-turn'); assert.equal(f.r.rootTurn?.id, 'owned-turn');
  f.mint();
  f.row(CONTINUE);
  assert.equal(f.r.liveTurn, live, 'a repeated continuation is not a second grant');
  f.row({ id: 'control:compact' });
  assert.equal(f.r.liveTurn, null);
});

test('a prompt that arrived mid-turn before the compact is not given the turn\'s sharing by the continuation', async t => {
  const f = await fixture(t);
  f.r.hook({ hook_event_name: 'UserPromptSubmit', session_id: f.s.nativeId, prompt_id: randomUUID(), prompt: 'SYNTHETIC MID-TURN INPUT' });
  assert.equal(f.r.rootTurn, null); assert.equal(f.r.liveTurn?.id, 'owned-turn');
  f.row({ id: 'control:compact' }); f.row(CONTINUE);
  assert.equal(f.r.liveTurn?.id, 'owned-turn', 'the running turn\'s own calls come back, as before the compact');
  assert.equal(f.r.rootTurn, null, 'sharing was already withdrawn and stays so');
});

test('the settings hook neither retires nor reports idle for a turn whose rows decide', async t => {
  for (const order of ['before the compact row', 'after it', 'after the continuation']) {
    const f = await fixture(t);
    if (order === 'before the compact row') f.settingsCompact();
    f.row({ id: 'control:compact' });
    if (order === 'after it') f.settingsCompact();
    f.row(CONTINUE);
    if (order === 'after the continuation') f.settingsCompact();
    assert.equal(f.r.liveTurn?.id, 'owned-turn', order);
    assert.equal(f.states.includes('idle'), false, order);
    f.mint();
  }
  const idle = await fixture(t);
  idle.row({ id: 'turn:owned-turn', kind: 'turn', turnId: 'owned-turn', text: '' });
  idle.states.length = 0;
  idle.settingsCompact();
  assert.deepEqual(idle.states, ['idle'], 'an idle session\'s compaction is reported as before');
});

// The offer as the module's own bindRoot makes it (as in claude-native-queue-versions.test.cjs).
async function negotiate(answer, legacyOnly = false) {
  const start = bridgeSource.indexOf('async function bindRoot('), end = bridgeSource.indexOf('async function syncRoot(', start);
  let offered;
  const scope = vm.createContext({ legacyOnly, nativeBlocks: true, addressedTool: false, generation: 1, stopped: false, rootBinding: null, nativeReadImages: new Map(),
    connection: async () => ({ sessionId: 'synthetic-native' }),
    request: async (_api, route, body) => { offered = body; return { lease: 'synthetic-lease', nativeBlocks: true, ...answer }; },
    heartbeat() {}, observeModel() {}, observeUsage() {}, listen: async () => {}, nativeMediaVersion: () => false });
  vm.runInContext(bridgeSource.slice(bridgeSource.indexOf('let qualifiedNativeVersion'), bridgeSource.indexOf('let foreignRevision')), scope);
  vm.runInContext(bridgeSource.slice(start, end), scope);
  await scope.bindRoot({ session: { version: async () => ({ version: '2.1.329' }) }, clock: { after() {} } }, 1);
  return { offered: offered.nativeTurnContinue, bound: scope.rootBinding.nativeTurnContinue };
}
test('the capability holds only when this bridge offers it and NAW answers it', async () => {
  assert.deepEqual(await negotiate({ nativeTurnContinue: true }), { offered: true, bound: true });
  assert.deepEqual(await negotiate({}), { offered: true, bound: false }, 'an older NAW does not answer');
  assert.deepEqual(await negotiate({ nativeTurnContinue: true }, true), { offered: false, bound: false }, 'a compatibility copy never offers it');
});
