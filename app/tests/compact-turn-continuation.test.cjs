const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm'), { randomUUID } = require('node:crypto');
const { Workspace } = require('../workspace.cjs'), { Claude } = require('../adapters.cjs');
const { ScopedOutboxRuntime } = require('../scoped-outbox-runtime.cjs'), { rootCall } = require('../background-control-native.cjs');
const { classifyOutboxFailure } = require('../computer-use-outbox-native.cjs');
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
  const stamp = sequence => `${r.observationEpoch}:${sequence}`;
  const settingsCompact = naw_compaction => r.hook({ hook_event_name: 'SessionStart', session_id: s.nativeId, source: 'compact', naw_compaction });
  return { w, s, r, binding, check, issue, mint, row, states, ends, settingsCompact, stamp, sequence: () => sequence, skip: n => { sequence = n; } };
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
  const hooks = new Map(), observed = [], reached = [], sent = [];
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
      reached.push(route); sent.push({ route, tool: body.tool ?? null, arguments: body.arguments });
      if (route === '/background-control') {
        try { rootCall(f.r, body, new AbortController().signal, () => true); return reply({ state: 'complete' }); }
        // As claude-submit.cjs answers a refused root call.
        catch (error) { return reply({ state: 'unconfirmed', error: error.message, retry: false, ...classifyOutboxFailure(error, 'binding', 'binding-unavailable') }); }
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
    let settingsNotice;
    await hooks.get('classic.SessionStart')($, { session_id: f.s.nativeId, source: 'compact' }, async event => {
      settingsNotice = event;
      if (hookFirst) f.settingsCompact(event.naw_compaction);
      return {};
    });
    await settle();
    return settingsNotice;
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
  // Any workspace tool by name, with the arguments the native MCP path approved.
  const tool = (name, input, approval) => {
    const next = async () => ({ text: JSON.stringify(approval) });
    next.origin = ENGINE;
    return hooks.get(`tool.call:mcp__native_workspace__${name}`)($, { ...input, tool_use_id: `toolu_${randomUUID()}` }, next);
  };
  const allDenied = async (label, options) => {
    const before = reached.length;
    for (const kind of KINDS) assert.equal((await call(kind, options)).deny, DENY[kind], `${kind}: ${label}`);
    assert.equal(reached.length, before, `${label}: nothing reaches NAW`);
  };
  const allAllowed = async label => { for (const kind of KINDS) assert.equal(allowed(await call(kind)), true, `${kind}: ${label}`); };
  return { mod, hooks, $, observed, reached, sent, settle, compact, step, call, tool, allDenied, allAllowed };
}
const RESTORED = { promptId: 'owned-prompt', turnId: 'owned-turn', observationGap: false }, RETIRED = { promptId: null, turnId: null, observationGap: false };

test('the engine\'s next step of the compacted root turn gives it back control, operator and message calls', async t => {
  const f = await fixture(t), b = await bridge(f), liveBefore = f.r.liveTurn;
  await b.allAllowed('before the compact');
  const sequence = f.sequence() + 1;
  const settings = await b.compact();
  assert.equal(settings.source, 'compact');
  assert.equal(settings.naw_compaction, f.stamp(sequence), 'bridge passes the exact ordered position to the settings hook');
  assert.deepEqual(b.mod.bridgeState(), RETIRED);
  assert.equal(f.r.liveTurn, null); assert.equal(f.r.rootTurn, null);
  await b.allDenied('between the compact and the turn\'s next step');
  assert.throws(() => f.mint(), 'NAW itself mints nothing for the compacted turn before the proof');
  f.settingsCompact(settings.naw_compaction); // measured order: the settings hook follows the ordered row
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

// Seen in daily use on 2026-11-21 (CLI 2.1.329, automatic compaction): a turn whose queue calls NAW had
// accepted compacted, and its next workspace_open and queueAdd got these two refusals until another turn began.
test('the daily sequence: queue calls, an automatic compaction, then workspace_open and queueAdd of the same turn', async t => {
  const f = await fixture(t), b = await bridge(f);
  const space = (action, args) => ({ action: 'invoke', method: 'spaceAction', arguments: ['fixture-room', action, args], operation_id: `fixture-${action}-${randomUUID()}` });
  const control = input => b.tool('workspace_control', input, { approved: true, background: input });
  const open = { action_id: 'fixture-open-1', provider: 'claude', cwd: '/fixture/work', name: 'Fixture reviewer', view: 'terminal', task: 'SYNTHETIC TASK', permission: 'default', grant_id: 'fixture-grant' };
  const opening = () => b.tool('workspace_open', open, { approved: true, operator: 'workspace_open', arguments: open });
  assert.equal(allowed(await control(space('releaseRotation', ['fixture-native', 'fixture-epoch']))), true, 'before the compact NAW takes the turn\'s queue call');
  await b.compact();
  const before = b.sent.length;
  assert.equal((await opening()).deny, DENY.operator); assert.equal((await control(space('queueAdd', ['SYNTHETIC ITEM', null]))).deny, DENY.control);
  assert.equal(b.sent.length, before, 'until the turn\'s next step neither call reaches NAW');
  await b.step(); await b.step(); // the turn goes on: its first step proves it, later ones change nothing
  const queued = space('queueAdd', ['SYNTHETIC ITEM', null]), opened = await opening(), added = await control(queued);
  assert.deepEqual([opened.deny, added.deny], [undefined, undefined], 'the bridge refuses neither call of the continued turn');
  assert.equal(allowed(opened) && allowed(added), true, 'NAW answers both');
  assert.deepEqual(b.sent.slice(before), [{ route: '/operator-call', tool: 'workspace_open', arguments: open }, { route: '/background-control', tool: null, arguments: queued }],
    'NAW receives both calls with the arguments the turn gave');
  assert.deepEqual(b.mod.bridgeState(), RESTORED);
  assert.deepEqual(b.observed.filter(id => id !== 'control:activity'), ['control:compact', 'control:turn-continue']);
});

// Also seen that day: NAW had declared a display gap in the turn, and answered its queue calls unconfirmed,
// before the turn compacted. The continuation is not a gap recovery: NAW's answer stays that same one.
test('a turn NAW holds a display gap for gets NAW\'s same answer after its compaction, not the turn back', async t => {
  const f = await fixture(t), b = await bridge(f);
  const queueAdd = () => {
    const input = { action: 'invoke', method: 'spaceAction', arguments: ['fixture-room', 'queueAdd', ['SYNTHETIC ITEM', null]], operation_id: `fixture-queueAdd-${randomUUID()}` };
    return b.tool('workspace_control', input, { approved: true, background: input });
  };
  const ending = result => {
    const answer = result.result ? JSON.parse(result.result) : {};
    return [result.deny ?? null, answer.state ?? null, answer.failureReason ?? null, answer.failureCheck ?? null];
  };
  f.r.observeRootGap({ sessionId: f.s.nativeId, lease: f.binding.lease, epoch: f.r.observationEpoch, gapThrough: f.sequence() });
  const before = ending(await queueAdd());
  assert.deepEqual(before, [null, 'unconfirmed', 'native-call-invalidated', 'display-gap'], 'before the compact NAW answers for its gap');
  await b.compact(); await b.step();
  assert.deepEqual(ending(await queueAdd()), before, 'after the compact the call still reaches NAW and gets that answer');
  assert.deepEqual(b.mod.bridgeState(), RESTORED, 'the bridge lost nothing and has its own turn back');
  assert.equal(f.r.liveTurn, null); assert.equal(f.r.rootTurn, null);
  assert.throws(() => f.mint(), 'NAW mints nothing for the turn while its gap stands');
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

// One compaction reaches NAW twice, by the ordered row and by the settings hook, and not together: the bridge
// flushes its row later, and the hook can even follow the continuation. Independent review of 7db73712 found a
// scope from before the compaction still valid between a settings notice and its ordered row.
const END = { id: 'turn:owned-turn', kind: 'turn', turnId: 'owned-turn', text: '' };
const retired = async (f, label) => {
  const old = await f.check();
  assert.equal(old.ok, false, `${label}: the scope from before the compaction is retired`); assert.equal(old.failureReason, 'grant-invalidated', label);
};
for (const [order, events] of [
  ['the settings notice first', ['hook', 'row', 'continue']],
  ['the ordered row first', ['row', 'hook', 'continue']],
  ['the settings notice after the continuation', ['row', 'continue', 'hook']],
]) test(`${order}: the first notice of a compaction retires, and only the proven turn holds a new scope`, async t => {
  const f = await fixture(t), before = f.r.liveTurn;
  assert.equal((await f.check()).ok, true);
  let fresh = null;
  const stamp = f.stamp(f.sequence() + 1);
  for (const event of events) {
    if (event === 'hook') f.settingsCompact(stamp); else f.row(event === 'row' ? { id: 'control:compact' } : CONTINUE);
    const label = `${order}, after ${event}`;
    await retired(f, label);
    assert.notEqual(f.r.liveTurn, before, `${label}: no reference from before the compaction is live`);
    if (event === 'continue') {
      assert.deepEqual({ id: f.r.liveTurn?.id, promptId: f.r.liveTurn?.promptId, sharing: f.r.rootTurn?.id }, { id: 'owned-turn', promptId: 'owned-prompt', sharing: 'owned-turn' }, label);
      fresh = await f.issue();
    } else if (!fresh) {
      assert.equal(f.r.liveTurn, null, label); assert.equal(f.r.rootTurn, null, label);
      assert.throws(() => f.mint(), `${label}: nothing is minted before the proof`);
    }
    if (fresh) assert.equal((await fresh()).ok, true, `${label}: the continued turn's own scope holds`);
    assert.deepEqual(f.states, [], `${label}: a turn that goes on is not reported idle`);
  }
  assert.deepEqual(f.ends, []);
  f.row(END);
  assert.deepEqual(f.ends, ['completed'], 'its end is reported once, when it ends');
  f.r.hook({ hook_event_name: 'Stop', session_id: f.s.nativeId, prompt_id: 'owned-prompt' });
  assert.deepEqual(f.states, ['idle'], 'and idle only then');
  assert.equal((await fresh()).ok, false, 'the turn\'s scope ends with it'); await retired(f, 'after the end');
});

test('a late settings notice hurts no turn; the next compaction\'s first notice retires again, whichever path brings it', async t => {
  const next = await fixture(t);
  const first = next.stamp(next.sequence() + 1);
  next.row({ id: 'control:compact' }); next.row(CONTINUE); next.row(END);
  next.row({ id: 'control:turn-start', status: 'running', turnId: 'next-turn', promptId: 'next-prompt' });
  const mine = next.r.liveTurn;
  next.settingsCompact(first);
  assert.equal(next.r.liveTurn, mine, 'the notice of the earlier compaction leaves the turn that started since');
  next.mint('next-turn', 'next-prompt');

  for (const second of ['hook', 'row']) {
    const f = await fixture(t);
    const first = f.stamp(f.sequence() + 1);
    f.row({ id: 'control:compact' }); f.row(CONTINUE); f.settingsCompact(first);
    const fresh = await f.issue();
    const stamp = f.stamp(f.sequence() + 1);
    if (second === 'hook') f.settingsCompact(stamp); else f.row({ id: 'control:compact' });
    assert.equal((await fresh()).ok, false, `${second}: a second compaction retires the continued turn's scope at its first notice`);
    assert.equal(f.r.liveTurn, null, second); assert.throws(() => f.mint(), second);
    if (second === 'hook') f.row({ id: 'control:compact' }); else f.settingsCompact(stamp);
    assert.equal(f.r.liveTurn, null, `${second}: its other notice restores nothing`);
    f.row(CONTINUE);
    assert.equal(f.r.liveTurn?.id, 'owned-turn', `${second}: its own proof continues the turn again`);
    assert.equal((await fresh()).ok, false, second); await retired(f, second);
    assert.deepEqual(f.states, [], second);
  }
});

test('a compact settings notice more than 10 seconds late preserves a different live turn', async t => {
  const f = await fixture(t);
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const first = f.stamp(f.sequence() + 1);
  f.row({ id: 'control:compact' }); f.row(CONTINUE); f.row(END);
  f.row({ id: 'control:turn-start', status: 'running', turnId: 'next-turn', promptId: 'next-prompt' });
  const next = f.r.liveTurn;
  assert.ok(f.mint('next-turn', 'next-prompt'));
  now += 10101;
  f.settingsCompact(first);
  assert.equal(f.r.liveTurn, next);
  assert.ok(f.mint('next-turn', 'next-prompt'));
  assert.deepEqual(f.states, [], 'the next turn never ended');
});

test('a distinct compact within 10 seconds retires at its settings notice even with an unpaired prior row', async t => {
  const f = await fixture(t);
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const first = f.stamp(f.sequence() + 1);
  f.row({ id: 'control:compact' }); f.row(CONTINUE);
  const scope = await f.issue();
  now += 8002;
  const second = f.stamp(f.sequence() + 1);
  f.settingsCompact(second);
  assert.equal((await scope()).failureReason, 'grant-invalidated', 'settings is the first notice of the second boundary');
  assert.throws(() => f.mint(), 'no scope until its own ordered continuation');
  f.settingsCompact(first);
  f.row({ id: 'control:compact' }); f.row(CONTINUE);
  const fresh = await f.issue();
  f.settingsCompact(second);
  assert.equal((await fresh()).ok, true, 'only the second proof authorizes the continued turn');
  assert.equal((await scope()).ok, false);
});

test('an unmarked or mismatched settings notice still retires rather than presuming a duplicate', async t => {
  for (const stamp of [undefined, 'invalid', `${'b'.repeat(32)}:2`, f => f.stamp(9007199254740992)]) {
    const f = await fixture(t);
    f.row({ id: 'control:compact' }); f.row(CONTINUE);
    const scope = await f.issue();
    f.settingsCompact(typeof stamp === 'function' ? stamp(f) : stamp);
    assert.equal((await scope()).failureReason, 'grant-invalidated');
    assert.throws(() => f.mint());
  }
});

test('a settings compact after a live observation gap does not report idle', async t => {
  const f = await fixture(t);
  f.r.emit('state', 'working'); f.states.length = 0;
  f.row({ id: 'control:heartbeat', gap: true });
  f.settingsCompact(f.stamp(f.sequence() + 1));
  f.row({ id: 'control:compact' }); f.row(CONTINUE);
  assert.equal(f.r.liveTurn, null, 'a continuation never repairs an observation gap');
  assert.deepEqual(f.states, []);
  assert.deepEqual(f.ends, []);
  await retired(f, 'a gap keeps the prior grant invalid');
  f.r.hook({ hook_event_name: 'Stop', session_id: f.s.nativeId, prompt_id: 'owned-prompt' });
  assert.deepEqual(f.states, ['idle']);
});

test('a settings notice that comes first keeps no more than its ordered row would', async t => {
  for (const [name, between] of [
    ['a permission boundary', f => f.row({ id: 'control:permission' })],
    ['the turn\'s end', f => f.row(END)],
    ['a compact row that carries a gap', null],
  ]) {
    const f = await fixture(t);
    f.settingsCompact();
    if (between) between(f);
    f.row({ id: 'control:compact', ...(between ? {} : { gap: true }) }); f.row(CONTINUE);
    assert.equal(f.r.liveTurn, null, name); assert.throws(() => f.mint(), name);
    await retired(f, name);
  }
  // A turn start the rows deliver after the notice was granted before the compaction: its row retires it.
  const f = await fixture(t);
  f.row(END);
  f.settingsCompact();
  f.row({ id: 'control:turn-start', status: 'running', turnId: 'next-turn', promptId: 'next-prompt' });
  f.mint('next-turn', 'next-prompt');
  f.row({ id: 'control:compact' });
  assert.equal(f.r.liveTurn, null); assert.throws(() => f.mint('next-turn', 'next-prompt'));
  f.row({ ...CONTINUE, turnId: 'next-turn', promptId: 'next-prompt' });
  assert.equal(f.r.liveTurn?.id, 'next-turn', 'and its own proof continues it');
});

test('through the bridge with the settings notice first, the turn is refused until its step and then continues', async t => {
  const f = await fixture(t), b = await bridge(f);
  const sequence = f.sequence() + 1;
  const settings = await b.compact({ hookFirst: true });
  assert.equal(settings.naw_compaction, f.stamp(sequence));
  assert.deepEqual(b.observed, ['control:compact']);
  await retired(f, 'after both notices');
  await b.allDenied('between the compaction and the step');
  await b.step();
  assert.deepEqual(b.mod.bridgeState(), RESTORED);
  await b.allAllowed('in the continued turn');
  await retired(f, 'after the continuation');
  assert.deepEqual(f.states, []);
});

test('an idle session\'s compaction is reported idle as before', async t => {
  for (const order of [['hook', 'row'], ['row', 'hook']]) {
    const idle = await fixture(t);
    idle.row(END);
    idle.states.length = 0;
    for (const event of order) if (event === 'hook') idle.settingsCompact(); else idle.row({ id: 'control:compact' });
    assert.deepEqual(idle.states, ['idle'], order.join(' then '));
    assert.equal(idle.r.compactedTurn, null);
  }
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
