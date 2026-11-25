// Changing the model of one session (N5). The rules, the app's own waiting, the backend's change and Codex's, over
// local stand-ins: no provider process, no model. The real CLIs were run apart, with fixed local replies.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const sessionModel = require('../session-model.cjs'), { ModelChanges, gate, openWake, HUMAN_QUIET_MS, REPORT_GRACE_MS } = require('../model-change.cjs');
const { Workspace } = require('../workspace.cjs'), { Codex, Claude } = require('../adapters.cjs');
const { sessionPlan, maintenanceProof } = require('../backend-switch.cjs');
const operation = require('../background-operation.cjs'), { uiError } = require('../ui-errors.cjs');
const key = error => error?.uiMessage?.key;
const refuses = name => error => key(error) === name;
const CLAUDE = extra => ({ id: 'a', name: 'Agent A', nativeId: 'native-a', provider: 'claude', state: 'idle', model: 'claude-fable-5-2', nativeEffort: 'high', owner: 'window', view: 'terminal',
  controlRevision: 3, connectionRevision: 2, draftRevision: 0, peerRevision: 0, messages: [], fleet: [], background: 0, scheduled: 0, backgroundStale: false, terminalInputPending: false, ...extra });
const CODEX = extra => ({ ...CLAUDE({ id: 'c', name: 'Agent C', nativeId: 'native-c', provider: 'codex', vendor: 'openai', model: 'gpt-6-sol', view: 'chat' }), nativeEffort: undefined, nativeSettings: { nativeId: 'native-c', model: 'gpt-6-sol', effort: 'low', mode: null }, ...extra });
const OPUS = { model: 'claude-opus-5-5', effort: 'xhigh' };

test('a value names a model and an effort, or null for the native default, and nothing else', () => {
  for (const value of [OPUS, { model: null, effort: null }, { model: 'gpt-6.2-sol', effort: null }, { model: 'vendor/model:tag[1m]', effort: 'x-high_2' }]) assert.equal(sessionModel.validValue(value), true, JSON.stringify(value));
  for (const value of [null, undefined, 'claude-opus-5-5', [], {}, { model: 'claude-opus-5-5' }, { ...OPUS, skipPermissions: true }, { model: '-c', effort: 'low' }, { model: '--resume', effort: 'low' },
    { model: 'a b', effort: 'low' }, { model: 'a\nb', effort: 'low' }, { model: '', effort: 'low' }, { model: 'x'.repeat(121), effort: 'low' }, { model: 7, effort: 'low' }, { model: undefined, effort: 'low' },
    { model: 'a', effort: 'Low' }, { model: 'a', effort: '' }, { model: 'a', effort: '--max' }, { model: 'a', effort: 'x'.repeat(41) }, { model: 'a', effort: 3 }]) assert.equal(sessionModel.validValue(value), false, JSON.stringify(value));
});

test('what a session runs now is what its native client reported for this native session', () => {
  assert.deepEqual(sessionModel.current(CLAUDE()), { model: 'claude-fable-5-2', effort: 'high' });
  assert.deepEqual(sessionModel.current(CLAUDE({ model: '原生默认', nativeEffort: undefined })), { model: null, effort: null });
  assert.deepEqual(sessionModel.current(CODEX()), { model: 'gpt-6-sol', effort: 'low' });
  // Settings reported for another native session do not count, and a Codex effort is never read from elsewhere.
  assert.deepEqual(sessionModel.current(CODEX({ nativeSettings: { nativeId: 'older', model: 'gpt-6-luna', effort: 'max' }, nativeEffort: 'max' })), { model: 'gpt-6-sol', effort: null });
});

test('Claude can be given a listed model or the native default; a model it runs that is not listed stays in its list', () => {
  const choices = sessionModel.claudeChoices(CLAUDE());
  assert.deepEqual(choices.models.map(entry => entry.model), ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-2', 'claude-haiku-5-5']);
  assert.deepEqual([choices.provider, choices.nativeDefault, choices.current], ['claude', true, { model: 'claude-fable-5-2', effort: 'high' }]);
  assert.deepEqual(choices.models[0].efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(sessionModel.claudeChoices(CLAUDE({ model: 'claude-opus-4-9' })).models[0].model, 'claude-opus-4-9');
  assert.deepEqual(sessionModel.claudeValue(OPUS), OPUS); assert.deepEqual(sessionModel.claudeValue({ model: null, effort: null }), { model: null, effort: null });
  for (const value of [{ model: 'claude-opus-5-5', effort: 'ultra' }, { model: '--x', effort: null }, null]) assert.throws(() => sessionModel.claudeValue(value), refuses('error.modelChange.unknown'));
});

test('a Claude change is kept as the settings the session is started with; the native default leaves them out and keeps the rest', () => {
  const record = CLAUDE({ requestedSettings: { permissionMode: 'auto', model: 'claude-fable-5-2', effort: 'high' }, modelUiMessage: { key: 'x' } });
  sessionModel.applyClaude(record, OPUS);
  assert.deepEqual([record.requestedSettings, record.model, record.nativeEffort, 'modelUiMessage' in record], [{ permissionMode: 'auto', ...OPUS }, 'claude-opus-5-5', 'xhigh', false]);
  sessionModel.applyClaude(record, { model: null, effort: 'low' });
  assert.deepEqual([record.requestedSettings, record.model, record.nativeEffort], [{ permissionMode: 'auto', effort: 'low' }, sessionModel.NATIVE_DEFAULT, 'low']);
  const bare = CLAUDE(); sessionModel.applyClaude(bare, { model: null, effort: null });
  assert.equal('requestedSettings' in bare, false); assert.equal(bare.nativeEffort, undefined);
});

test('Codex takes only a model and an effort it lists; hidden, damaged and repeated rows are left out', () => {
  const row = (model, efforts, extra) => ({ model, supportedReasoningEfforts: efforts.map(reasoningEffort => ({ reasoningEffort })), ...extra });
  const models = sessionModel.codexModels([row('gpt-6-sol', ['low', 'high'], { defaultReasoningEffort: 'high' }), row('gpt-6-sol', ['low']), row('secret', ['low'], { hidden: true }), row('-bad', ['low']),
    row('none', []), null, { model: 'x' }, row('gpt-6-luna', ['low', 7, 'BAD'], { defaultReasoningEffort: 'max' })]);
  assert.deepEqual(models, [{ model: 'gpt-6-sol', efforts: ['low', 'high'], defaultEffort: 'high' }, { model: 'gpt-6-luna', efforts: ['low'] }]);
  assert.deepEqual(sessionModel.codexValue({ model: 'gpt-6-sol', effort: 'high' }, models), { model: 'gpt-6-sol', effort: 'high' });
  for (const value of [{ model: 'gpt-6-sol', effort: 'max' }, { model: 'no-such', effort: 'low' }, { model: null, effort: 'low' }, { model: 'gpt-6-sol', effort: null }, { model: 'gpt-6-luna', effort: 'high' }]) assert.throws(() => sessionModel.codexValue(value, models), refuses('error.modelChange.unknown'), JSON.stringify(value));
});

test('what cannot be changed at all is known before the person is asked', () => {
  const able = [sessionModel.CAPABILITY], why = (session, value = OPUS, capabilities = able) => key(sessionModel.refused(session, capabilities, value)) ?? null;
  assert.equal(why(CLAUDE()), null); assert.equal(why(CLAUDE({ state: 'working' })), null, 'It waits for the turn to end');
  assert.equal(why(CODEX(), { model: 'gpt-6-luna', effort: 'low' }), null);
  for (const session of [undefined, CLAUDE({ archived: true }), CLAUDE({ state: 'ended' })]) assert.equal(why(session), 'error.modelChange.unavailable');
  for (const session of [CLAUDE({ provider: 'dsh' }), CLAUDE({ provider: 'agy' }), CODEX({ vendor: 'deepseek' }), CODEX({ requestedSettings: { profile: 'deepseek-pro' } })]) assert.equal(why(session, { model: 'gpt-6-luna', effort: 'low' }), 'error.modelChange.unsupported');
  assert.equal(why(CLAUDE(), OPUS, []), 'error.modelChange.backend'); assert.equal(why(CLAUDE(), OPUS, null), 'error.modelChange.backend');
  for (const value of [{ model: 'claude-opus-5-5', effort: 'ultra' }, { ...OPUS, x: 1 }, 'claude-opus-5-5']) assert.equal(why(CLAUDE(), value), 'error.modelChange.unknown');
  for (const value of [{ model: null, effort: 'low' }, { model: 'gpt-6-luna', effort: null }]) assert.equal(why(CODEX(), value), 'error.modelChange.unknown');
});

// What may hold a Claude change back.
const NOW = 1_800_000_000_000;
const input = (session, extra = {}) => ({ snapshot: { sessions: [session], rooms: [{ id: 'shared', queue: [] }] }, entryState: {}, rotations: {}, engaged: [], humanAt: new Map(), now: NOW, unreportedSince: null, ...extra });
const seen = (extra, more) => { const session = CLAUDE(extra), result = gate(session, input(session, more)); return result.ready ? (result.typed ? 'ready-typed' : 'ready') : result.wait ? 'wait:' + result.wait : 'refuse:' + result.refuse.key; };

test('a turn, an answer, a message or the person at work makes it wait; nothing is stopped meanwhile', () => {
  assert.equal(seen({}), 'ready');
  for (const state of ['working', 'starting', 'stopping']) assert.equal(seen({ state }), 'wait:turn');
  assert.equal(seen({ state: 'approval' }), 'wait:approval');
  assert.equal(seen({ approval: { id: 'x' } }), 'wait:input');
  assert.equal(seen({ claudeQuestion: { questions: [] }, nativeInputRequired: true }).startsWith('wait:'), true);
  assert.equal(seen({ pendingTag: 'sent' }), 'wait:input');
  assert.equal(seen({}, { snapshot: { sessions: [], rooms: [{ id: 'shared', queue: [], run: { status: 'running', ids: ['a'] } }] } }), 'wait:relay');
  assert.equal(seen({}, { entryState: { rooms: [{ run: { status: 'running', ids: ['a'] } }] } }), 'wait:relay');
  assert.equal(seen({}, { humanAt: new Map([['a', NOW - HUMAN_QUIET_MS + 1]]) }), 'wait:person');
  assert.equal(seen({}, { humanAt: new Map([['a', NOW - HUMAN_QUIET_MS], ['b', NOW]]) }), 'ready');
  assert.equal(seen({}, { engaged: ['a'] }), 'wait:queue'); assert.equal(seen({}, { engaged: ['b'] }), 'ready');
  const sent = { id: '1', status: 'sent', sentTo: 'a' };
  assert.equal(seen({}, { snapshot: { sessions: [], rooms: [{ id: 'shared', queue: [sent] }] } }), 'wait:queue');
  assert.equal(seen({}, { rotations: { a: { phase: 'handoff' } } }), 'wait:queue');
});

test('an automatic message on its way to or from the session makes it wait', () => {
  for (const status of ['staged', 'held', 'sending', 'consumed']) {
    assert.equal(openWake([{ id: 'b', messages: [{ wake: { status, recipientId: 'a' } }] }], 'a'), true, status);
    assert.equal(openWake([{ id: 'a', messages: [{ wake: { status, recipientId: 'b' } }] }], 'a'), true, status);
    assert.equal(openWake([{ id: 'b', messages: [{ wake: { status, recipientId: 'c' } }] }], 'a'), false);
  }
  for (const status of ['submitted', 'not-sent', 'unconfirmed', 'cancelled']) assert.equal(openWake([{ id: 'b', messages: [{ wake: { status, recipientId: 'a' } }] }], 'a'), false, status);
  assert.equal(seen({}, { snapshot: { sessions: [{ id: 'b', messages: [{ wake: { status: 'held', recipientId: 'a' } }] }], rooms: [] } }), 'wait:message');
});

test('running background work, scheduled work or teammates refuse it with what is running, also once the turn has ended', () => {
  assert.equal(seen({ background: 2 }), 'refuse:error.planBackgroundRunning'); assert.equal(seen({ scheduled: 1 }), 'refuse:error.planScheduledWork');
  assert.equal(seen({ fleet: [{ event: 'SubagentStart', id: 't', stale: false }] }), 'refuse:error.planCurrentChildren'); assert.equal(seen({ fleet: [{ event: 'TeammateIdle' }] }), 'refuse:error.planTeamUnconfirmed');
  const session = CLAUDE({ background: 2 });
  assert.deepEqual(gate(session, input(session)).refuse.params, { count: 2 });
});

test('a turn that just ended gets a moment to report its background work; one that never does is not stopped', () => {
  const session = CLAUDE({ background: null });
  const result = gate(session, input(session));
  assert.deepEqual([result.wait, result.unreported], ['report', true]);
  assert.equal(gate(session, input(session, { unreportedSince: NOW - REPORT_GRACE_MS + 1 })).wait, 'report');
  assert.equal(gate(session, input(session, { unreportedSince: NOW - REPORT_GRACE_MS })).refuse.key, 'error.planBackgroundUnreported');
});

test('text perhaps left in the terminal does not block the change; the screen is to be saved first', () => {
  assert.equal(seen({ terminalInputPending: true }), 'ready-typed'); assert.equal(seen({ terminalInputPending: undefined }), 'ready-typed'); assert.equal(seen({ terminalInputPending: false }), 'ready');
});

// The app's own list of changes, over one backend that can be made to refuse, hang or move.
function app(session, options = {}) {
  const calls = [], notices = [], state = { sessions: [session], rooms: [{ id: 'shared', queue: [] }], capabilities: options.capabilities ?? [sessionModel.CAPABILITY] };
  const backend = { modelChoices: async () => ({ provider: session.provider, models: [] }), changeModel: async () => null, ...options.backend };
  const target = { state, client: { call: async (method, ...args) => { calls.push([method, ...structuredClone(args)]); return backend[method](...args); } } };
  const client = { snapshot: () => state, refresh: async () => { calls.push(['refresh']); await options.refresh?.(); }, route: () => target, operationGuard: () => () => { calls.push(['guard']); options.guard?.(); } };
  const clock = { now: options.now ?? NOW };
  const changes = new ModelChanges({ client: () => options.offline ? null : client, apply: value => value, rotations: options.rotations, engaged: options.engaged, humanAt: options.humanAt, saveTerminal: options.saveTerminal || (async id => { calls.push(['screen', id]); return '/saved/' + id; }),
    changed: () => calls.push(['changed']), done: notice => notices.push(notice), now: () => clock.now, tickMs: 3600000, applyTimeoutMs: options.applyTimeoutMs, dataDir: options.dataDir });
  changes.schedule = () => {};
  const changeCalls = () => calls.filter(([method]) => method === 'changeModel').map(([, ...args]) => args);
  return { changes, calls, notices, state, clock, changeCalls, backend };
}
const scratch = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-model-change-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };

test('an idle Claude session is changed by one call that names its exact idle state; the person is told once', async () => {
  const session = CLAUDE(), f = app(session);
  assert.deepEqual(await f.changes.request('a', OPUS, 'native-a'), { status: 'pending', waiting: null });
  assert.deepEqual(f.changes.ids(), ['a']); assert.deepEqual(f.changes.view(), [{ sessionId: 'a', ...OPUS, waiting: null, applying: false }]);
  assert.deepEqual(f.changeCalls(), [], 'Nothing is done before the pass');
  await f.changes.pass();
  assert.deepEqual(f.changeCalls(), [['a', OPUS, sessionPlan(session, 'idle').stop, true]]);
  assert.deepEqual(f.notices, [{ sessionId: 'a', ...OPUS }]); assert.deepEqual(f.changes.ids(), []);
  await f.changes.pass(); assert.equal(f.changeCalls().length, 1);
});

test('a working Claude session is changed when its turn ends, and the reason it waits for is shown meanwhile', async () => {
  const session = CLAUDE({ state: 'working' }), f = app(session);
  assert.deepEqual(await f.changes.request('a', OPUS, 'native-a'), { status: 'pending', waiting: 'turn' });
  await f.changes.pass(); await f.changes.pass(); assert.deepEqual(f.changeCalls(), []);
  session.state = 'approval'; await f.changes.pass(); assert.equal(f.changes.view()[0].waiting, 'approval');
  session.state = 'idle'; session.background = 0; await f.changes.pass();
  assert.equal(f.changeCalls().length, 1); assert.equal(f.notices.length, 1);
});

test('work that a restart would cut off refuses it at once, or when the turn ends with it running; nothing is stopped', async () => {
  const busy = app(CLAUDE({ background: 1 }));
  await assert.rejects(busy.changes.request('a', OPUS, 'native-a'), error => key(error) === 'error.modelChange.busy' && error.uiMessage.params.reason.length > 0);
  assert.deepEqual([busy.changes.ids(), busy.changeCalls(), busy.notices], [[], [], []]);
  const session = CLAUDE({ state: 'working' }), f = app(session);
  await f.changes.request('a', OPUS, 'native-a'); session.state = 'idle'; session.background = 1; await f.changes.pass();
  assert.deepEqual([f.changes.ids(), f.changeCalls()], [[], []]); assert.equal(f.notices[0].errorUiMessage.key, 'error.modelChange.busy');
});

test('the value, the native session, the backend and the state are checked before anything is kept', async () => {
  for (const [session, args, name, extra] of [
    [CLAUDE(), ['a', { ...OPUS, x: 1 }, 'native-a'], 'error.modelChange.unknown'], [CLAUDE(), ['a', { model: 'claude-opus-5-5', effort: 'ultra' }, 'native-a'], 'error.modelChange.unknown'],
    [CLAUDE(), ['a', OPUS, 'another'], 'error.modelChange.changed'], [CLAUDE(), ['a', OPUS, undefined], 'error.modelChange.changed'], [CLAUDE(), ['gone', OPUS, 'native-a'], 'error.sessionMissing'],
    [CLAUDE({ archived: true }), ['a', OPUS, 'native-a'], 'error.modelChange.backend'], [CLAUDE(), ['a', OPUS, 'native-a'], 'error.modelChange.backend', { capabilities: ['maintenanceStop'] }],
    [CLAUDE({ model: 'claude-opus-5-5', nativeEffort: 'xhigh' }), ['a', OPUS, 'native-a'], 'error.modelChange.same'], [CLAUDE({ provider: 'dsh' }), ['a', OPUS, 'native-a'], 'error.modelChange.unsupported'],
    [CLAUDE({ state: 'ended' }), ['a', OPUS, 'native-a'], 'error.modelChange.unavailable'], [CLAUDE(), ['a', OPUS, 'native-a'], 'error.modelChange.unavailable', { offline: true }],
  ]) {
    const f = app(session, extra);
    await assert.rejects(f.changes.request(...args), refuses(name), name + JSON.stringify(args)); assert.deepEqual([f.changes.ids(), f.changeCalls()], [[], []], name);
  }
});

test('a second choice replaces the one that waits, the same as now withdraws it, and so does the person', async () => {
  const session = CLAUDE({ state: 'working' }), f = app(session);
  await f.changes.request('a', OPUS, 'native-a'); await f.changes.request('a', { model: 'claude-sonnet-5-5', effort: 'low' }, 'native-a');
  assert.deepEqual(f.changes.view().map(entry => entry.model), ['claude-sonnet-5-5']);
  await assert.rejects(f.changes.request('a', { model: 'claude-fable-5-2', effort: 'high' }, 'native-a'), refuses('error.modelChange.same'));
  assert.deepEqual(f.changes.ids(), []);
  await f.changes.request('a', OPUS, 'native-a'); assert.equal(f.changes.cancel('a'), true); assert.equal(f.changes.cancel('a'), false);
  session.state = 'idle'; await f.changes.pass(); assert.deepEqual([f.changeCalls(), f.notices], [[], []]);
});

test('what is withdrawn or replaced while the connection is read again is not made, and not reported', async () => {
  let during = null; const session = CLAUDE(), f = app(session, { refresh: () => { const act = during; during = null; return act?.(); } });
  await f.changes.request('a', OPUS, 'native-a'); during = () => f.changes.cancel('a'); await f.changes.pass();
  assert.deepEqual([f.changes.ids(), f.changeCalls(), f.notices], [[], [], []]);
  await f.changes.request('a', OPUS, 'native-a'); during = () => f.changes.request('a', { model: 'claude-sonnet-5-5', effort: 'low' }, 'native-a'); await f.changes.pass();
  assert.deepEqual([f.changeCalls(), f.notices], [[], []]); assert.equal(f.changes.view()[0].model, 'claude-sonnet-5-5');
  await f.changes.pass(); assert.deepEqual(f.changeCalls().map(([, value]) => value.model), ['claude-sonnet-5-5']);
});

test('waiting reads no backend: what the app already holds says that it waits', async () => {
  const session = CLAUDE({ state: 'working' }), f = app(session);
  await f.changes.request('a', OPUS, 'native-a'); f.calls.length = 0;
  await f.changes.pass(); await f.changes.pass(); assert.deepEqual(f.calls, []);
});

test('it is refused over what the backend says now, not over what the app held before it read again', async () => {
  const session = CLAUDE({ state: 'working' }); let after = null;
  const f = app(session, { refresh: () => { if (after !== null) session.background = after; } });
  await f.changes.request('a', OPUS, 'native-a'); session.state = 'idle'; session.background = 1; after = 0; await f.changes.pass();
  assert.equal(f.changeCalls().length, 1); assert.deepEqual(f.notices, [{ sessionId: 'a', ...OPUS }]);
});

test('the native default is never what a session already has: what it stands for is not known', async () => {
  const f = app(CLAUDE({ model: '原生默认', nativeEffort: undefined }));
  assert.equal((await f.changes.request('a', { model: null, effort: null }, 'native-a')).status, 'pending'); await f.changes.pass();
  assert.equal(f.changeCalls().length, 1); assert.equal(f.notices.length, 1);
});

test('while it is being changed it can be neither withdrawn nor changed again', async () => {
  let release; const f = app(CLAUDE(), { backend: { changeModel: () => new Promise(resolve => { release = resolve; }) } });
  await f.changes.request('a', OPUS, 'native-a'); const pass = f.changes.pass();
  while (!release) await new Promise(setImmediate);
  assert.equal(f.changes.view()[0].applying, true); assert.throws(() => f.changes.cancel('a'), refuses('error.modelChange.applying'));
  await assert.rejects(f.changes.request('a', { model: 'claude-sonnet-5-5', effort: 'low' }, 'native-a'), refuses('error.modelChange.applying'));
  assert.equal(f.changes.pass(), pass, 'One pass at a time'); release(); await pass; assert.equal(f.changeCalls().length, 1); assert.equal(f.notices.length, 1);
});

test('another conversation in the same session is never changed for the person who chose for the earlier one', async () => {
  const session = CLAUDE({ state: 'working' }), f = app(session);
  await f.changes.request('a', OPUS, 'native-a'); session.nativeId = 'native-b'; session.state = 'idle'; await f.changes.pass();
  assert.deepEqual([f.changeCalls(), f.changes.ids()], [[], []]); assert.equal(f.notices[0].errorUiMessage.key, 'error.modelChange.changed');
});

test('something that moves between the read and the stop makes it wait again, five times at most', async () => {
  const f = app(CLAUDE(), { backend: { changeModel: async () => { throw uiError('error.backendSwitchSessionChanged', { name: 'A' }); } } });
  await f.changes.request('a', OPUS, 'native-a');
  for (let n = 1; n <= 4; n++) { await f.changes.pass(); assert.equal(f.changeCalls().length, n); assert.deepEqual(f.changes.view().map(entry => [entry.waiting, entry.applying]), [['turn', false]]); assert.deepEqual(f.notices, []); }
  await f.changes.pass(); await f.changes.pass();
  assert.equal(f.changeCalls().length, 5); assert.equal(f.notices.length, 1); assert.equal(f.notices[0].errorUiMessage.key, 'error.backendSwitchSessionChanged'); assert.deepEqual(f.changes.ids(), []);
});

test('any other failure is not tried again, and one that never answers is unconfirmed', async () => {
  const failed = app(CLAUDE(), { backend: { changeModel: async () => { throw Error('gone'); } } });
  await failed.changes.request('a', OPUS, 'native-a'); await failed.changes.pass(); await failed.changes.pass();
  assert.equal(failed.changeCalls().length, 1); assert.equal(failed.notices[0].error, 'gone');
  const silent = app(CLAUDE(), { applyTimeoutMs: 5, backend: { changeModel: () => new Promise(() => {}) } });
  await silent.changes.request('a', OPUS, 'native-a'); await silent.changes.pass();
  assert.equal(silent.notices[0].errorUiMessage.key, 'error.modelChange.unconfirmed'); assert.deepEqual(silent.changes.ids(), []);
});

test('text perhaps left in the terminal is saved before the stop and named with the result; without the copy nothing is stopped', async () => {
  const f = app(CLAUDE({ terminalInputPending: true }));
  await f.changes.request('a', OPUS, 'native-a'); await f.changes.pass();
  assert.deepEqual(f.calls.filter(([name]) => ['screen', 'changeModel'].includes(name)).map(([name]) => name), ['screen', 'changeModel']);
  assert.equal(f.changeCalls()[0][3], 'typed'); assert.deepEqual(f.notices, [{ sessionId: 'a', ...OPUS, screen: '/saved/a' }]);
  const unsaved = app(CLAUDE({ terminalInputPending: true }), { saveTerminal: async () => { throw Error('disk'); } });
  await unsaved.changes.request('a', OPUS, 'native-a'); await unsaved.changes.pass();
  assert.deepEqual(unsaved.changeCalls(), []); assert.equal(unsaved.notices[0].errorUiMessage.key, 'error.modelChange.screen');
});

test('a backend that is away for a moment makes it wait; the connection is read again and held to before the stop', async () => {
  const session = CLAUDE({ state: 'working' }), f = app(session);
  await f.changes.request('a', OPUS, 'native-a'); session.state = 'idle'; session.backendUnavailable = true; await f.changes.pass();
  assert.deepEqual([f.changes.view()[0].waiting, f.changeCalls()], ['backend', []]);
  session.backendUnavailable = false; const held = f.state.sessions; f.state.sessions = []; await f.changes.pass(); assert.equal(f.changes.view()[0].waiting, 'backend');
  f.state.sessions = held; f.calls.length = 0; await f.changes.pass();
  assert.deepEqual(f.calls.filter(([name]) => ['refresh', 'guard', 'changeModel'].includes(name)).map(([name]) => name), ['refresh', 'guard', 'guard', 'changeModel']);
  // A turn that began while it was read again.
  const late = CLAUDE(), g = app(late, { refresh: () => { if (g.changes.ids().length) late.state = 'working'; } });
  await g.changes.request('a', OPUS, 'native-a'); await g.changes.pass(); assert.deepEqual([g.changeCalls(), g.changes.view()[0].waiting], [[], 'turn']);
  // A connection that was replaced meanwhile.
  const moved = app(CLAUDE(), { guard: () => { throw uiError('error.client.connectionChangedNoReplay'); } });
  await moved.changes.request('a', OPUS, 'native-a'); await moved.changes.pass(); assert.deepEqual(moved.changeCalls(), []); assert.equal(moved.notices[0].errorUiMessage.key, 'error.client.connectionChangedNoReplay');
});

test('a queued item, a rotation, a message or the person at work holds the change, not only a turn', async () => {
  const session = CLAUDE(), human = new Map([['a', NOW]]), f = app(session, { humanAt: () => human });
  assert.deepEqual(await f.changes.request('a', OPUS, 'native-a'), { status: 'pending', waiting: 'person' });
  await f.changes.pass(); assert.deepEqual(f.changeCalls(), []);
  f.clock.now += HUMAN_QUIET_MS; f.state.rooms[0].queue = [{ id: '1', status: 'sent', sentTo: 'a' }]; await f.changes.pass(); assert.equal(f.changes.view()[0].waiting, 'queue');
  f.state.rooms[0].queue = []; await f.changes.pass(); assert.equal(f.changeCalls().length, 1);
  const engaged = app(CLAUDE(), { engaged: () => ['a'] }); await engaged.changes.request('a', OPUS, 'native-a'); await engaged.changes.pass(); assert.deepEqual(engaged.changeCalls(), []);
});

test('Codex is changed at once, by its own call, also in the middle of a turn, and nothing waits', async () => {
  const session = CODEX({ state: 'working' }), f = app(session);
  assert.deepEqual(await f.changes.request('c', { model: 'gpt-6-luna', effort: 'high' }, 'native-c'), { status: 'applied' });
  assert.deepEqual(f.changeCalls(), [['c', { model: 'gpt-6-luna', effort: 'high' }, { nativeId: 'native-c' }]]);
  assert.deepEqual([f.changes.ids(), f.notices], [[], [{ sessionId: 'c', model: 'gpt-6-luna', effort: 'high' }]]);
  const refused = app(CODEX(), { backend: { changeModel: async () => { throw uiError('error.modelChange.unknown', { model: 'x' }); } } });
  await assert.rejects(refused.changes.request('c', { model: 'x', effort: 'low' }, 'native-c'), refuses('error.modelChange.unknown')); assert.deepEqual(refused.notices, []);
  for (const nativeId of ['another', undefined]) {
    const other = app(CODEX()); await assert.rejects(other.changes.request('c', { model: 'gpt-6-luna', effort: 'high' }, nativeId), refuses('error.modelChange.changed')); assert.deepEqual([other.changeCalls(), other.notices], [[], []]);
  }
  const moved = app(CODEX(), { guard: () => { throw uiError('error.client.connectionChangedNoReplay'); } });
  await assert.rejects(moved.changes.request('c', { model: 'gpt-6-luna', effort: 'high' }, 'native-c'), refuses('error.client.connectionChangedNoReplay')); assert.deepEqual([moved.changeCalls(), moved.notices], [[], []]);
});

test('what waits survives the app; a change that was being made then is only looked up', async t => {
  const dir = scratch(t), file = path.join(dir, 'model-changes.json'), session = CLAUDE({ state: 'working' });
  const first = app(session, { dataDir: dir }); await first.changes.request('a', OPUS, 'native-a');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600); first.changes.close();
  const again = app(session, { dataDir: dir }); assert.deepEqual(again.changes.view(), [{ sessionId: 'a', ...OPUS, waiting: null, applying: false }]);
  session.state = 'idle'; await again.changes.pass(); assert.equal(again.changeCalls().length, 1); assert.equal(fs.existsSync(file), false);
  const write = changes => fs.writeFileSync(file, JSON.stringify({ version: 1, changes }));
  const row = { id: 'a', nativeId: 'native-a', value: OPUS, at: NOW - 1000, applying: true };
  write([row]); const unsure = app(CLAUDE(), { dataDir: dir }); await unsure.changes.pass();
  assert.deepEqual(unsure.changeCalls(), []); assert.equal(unsure.notices[0].errorUiMessage.key, 'error.modelChange.unconfirmed');
  write([row]); const made = app(CLAUDE({ model: 'claude-opus-5-5', nativeEffort: 'xhigh' }), { dataDir: dir }); await made.changes.pass();
  assert.deepEqual([made.changeCalls(), made.notices], [[], [{ sessionId: 'a', ...OPUS }]]);
  // Not as a refusal either, whatever runs there now: it may have been made.
  write([row]); const ran = app(CLAUDE({ background: 1 }), { dataDir: dir }); await ran.changes.pass(); assert.deepEqual([ran.changeCalls(), ran.notices[0].errorUiMessage.key], [[], 'error.modelChange.unconfirmed']);
  // Saved again before it is looked up, it is still only looked up.
  write([row]); const held = app(CLAUDE({ backendUnavailable: true }), { dataDir: dir }); await held.changes.pass(); held.changes.moved();
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).changes[0].applying, true);
  for (const bad of [[{ ...row, at: NOW - 25 * 3600 * 1000 }], [{ ...row, at: NOW + 1000 }], [{ ...row, value: { model: '--x', effort: null } }], [{ ...row, id: 7 }], [null], 'x']) { write(bad); assert.deepEqual(app(CLAUDE(), { dataDir: dir }).changes.ids(), [], JSON.stringify(bad)); }
  fs.writeFileSync(file, '{'); assert.deepEqual(app(CLAUDE(), { dataDir: dir }).changes.ids(), []);
});

test('the waiting is NAW\'s own work, also when an agent\'s confirmed call asked for it', async () => {
  let inside = 'unset'; const session = CLAUDE();
  const f = app(session, { backend: { changeModel: async () => { inside = operation.current() ?? null; } }, refresh: () => { inside = operation.current() ?? null; } });
  await operation.run({ id: 'agent', name: 'Agent', nativeId: 'native-agent', provider: 'claude', callId: 'call', turnId: 'turn', operationId: 'operation' }, () => f.changes.request('a', OPUS, 'native-a'));
  assert.equal(inside, null);
});

test('the choices carry what still waits for the session', async () => {
  const f = app(CLAUDE({ state: 'working' })); assert.equal((await f.changes.choices('a')).pending, null);
  await f.changes.request('a', OPUS, 'native-a'); assert.deepEqual((await f.changes.choices('a')).pending, { sessionId: 'a', ...OPUS, waiting: 'turn', applying: false });
  await assert.rejects(app(CLAUDE(), { capabilities: [] }).changes.choices('a'), refuses('error.modelChange.backend'));
});

// The backend's change of a Claude session.
function workspace(extra = {}, options = {}) {
  const s = CLAUDE({ requestedSettings: { permissionMode: 'auto' }, ...extra }), calls = [];
  const r = Object.create(Claude.prototype); EventEmitter.call(r);
  const w = Object.create(Workspace.prototype); EventEmitter.call(w);
  Object.assign(r, { record: s, stop: async () => { calls.push('stop'); if (options.selfEnd) { w.endNativeContext(s, r, { nativeId: s.nativeId, reason: 'other' }); w.runtimes.delete(s.id); } s.state = 'ended'; return { state: options.onStop?.(s) || 'ended' }; } });
  Object.assign(w, { sessions: new Map([[s.id, s]]), runtimes: new Map([[s.id, r]]), draftRevisions: new Map(), drafts: new Map(), pendingDrafts: new Map(), stops: new Map(), rooms: new Map([['shared', { run: null }]]), approvalRoutes: new Map(),
    pause: () => calls.push('pause'), pauseParticipant: () => calls.push('pauseParticipant'), changed: () => {}, persist: () => calls.push('persist:' + s.state + ':' + JSON.stringify(s.requestedSettings ?? null)),
    resume: async (id, owner) => { calls.push(['resume', id, owner, structuredClone(s.requestedSettings ?? null)]); s.state = 'idle'; } });
  return { w, s, r, calls, expected: structuredClone(sessionPlan(s, s.state).stop) };
}

test('Claude is stopped in exactly the idle state that was read and resumed as the same session for the window that had it', async () => {
  for (const selfEnd of [false, true]) {
    const f = workspace({}, { selfEnd });
    assert.deepEqual(await f.w.changeModel('a', OPUS, f.expected, true), OPUS);
    assert.equal(f.calls.includes('pause'), false, 'Only what this session is in is paused');
    assert.deepEqual(f.calls.filter(call => Array.isArray(call)), [['resume', 'a', 'window', { permissionMode: 'auto', ...OPUS }]]);
    assert.ok(f.calls.indexOf('stop') < f.calls.findIndex(call => String(call).startsWith('persist:ended') && String(call).includes('claude-opus-5-5')), 'The choice is saved before the resume');
    assert.deepEqual([f.s.nativeId, f.s.owner, f.s.model, f.s.nativeEffort], ['native-a', 'window', 'claude-opus-5-5', 'xhigh']);
  }
});

test('anything that moved since the read refuses the change with the session still running', async () => {
  for (const change of [f => { f.s.state = 'working'; }, f => { f.s.controlRevision++; }, f => { f.s.owner = 'other'; }, f => { f.w.draftRevisions.set('a', 1); }, f => { f.s.peerRevision = 1; }, f => { f.s.background = 1; }, f => { f.s.background = null; },
    f => { f.s.terminalInputPending = true; }, f => { f.w.rooms.get('shared').run = { status: 'running', ids: ['a'] }; }]) {
    const f = workspace(); change(f);
    await assert.rejects(f.w.changeModel('a', OPUS, f.expected, true), refuses('error.backendSwitchSessionChanged'), String(change));
    assert.equal(f.calls.includes('stop'), false); assert.deepEqual(f.s.requestedSettings, { permissionMode: 'auto' });
  }
});

test('text in the terminal passes only for a caller that saved it, and nothing else is let through with it', async () => {
  const f = workspace({ terminalInputPending: true }); await f.w.changeModel('a', OPUS, f.expected, 'typed'); assert.ok(f.calls.includes('stop'));
  for (const change of [g => { g.s.background = null; }, g => { g.s.background = 1; }, g => { g.s.state = 'working'; }]) {
    const g = workspace({ terminalInputPending: true }); change(g);
    await assert.rejects(g.w.changeModel('a', OPUS, g.expected, 'typed'), refuses('error.backendSwitchSessionChanged')); assert.equal(g.calls.includes('stop'), false);
  }
  for (const requireAuto of [false, undefined, null, 'other', 1]) {
    const g = workspace({ terminalInputPending: true });
    if (requireAuto === undefined) await assert.rejects(g.w.changeModel('a', OPUS, g.expected), refuses('error.backendSwitchSessionChanged'));
    else await assert.rejects(g.w.changeModel('a', OPUS, g.expected, requireAuto), refuses('error.modelChange.changed'));
    assert.equal(g.calls.includes('stop'), false);
  }
});

test('a maintenance stop that is not a model change still refuses text left in the terminal', async () => {
  const f = workspace({ terminalInputPending: true });
  assert.throws(() => f.w.maintenanceStop('a', f.expected, true), refuses('error.backendSwitchSessionChanged')); assert.equal(f.calls.includes('stop'), false);
});

test('an invalid request never reaches the stop', async () => {
  for (const [args, name] of [[['a', { model: 'claude-opus-5-5', effort: 'ultra' }, undefined, true], 'error.modelChange.changed'], [['a', OPUS, { nativeId: 'other' }, true], 'error.modelChange.changed'], [['a', OPUS, null, true], 'error.modelChange.changed']]) {
    const f = workspace(); await assert.rejects(f.w.changeModel(...args), refuses(name)); assert.equal(f.calls.includes('stop'), false);
  }
  const f = workspace(); await assert.rejects(f.w.changeModel('a', { model: 'claude-opus-5-5', effort: 'ultra' }, f.expected, true), refuses('error.modelChange.unknown')); assert.equal(f.calls.includes('stop'), false);
  for (const [extra, name] of [[{ state: 'ended' }, 'error.modelChange.unavailable'], [{ recovering: true }, 'error.modelChange.unavailable'], [{ nativeContextPending: { id: 'x' } }, 'error.modelChange.unavailable'], [{ provider: 'dsh' }, 'error.modelChange.unsupported'], [{ requestedSettings: { profile: 'p' } }, 'error.modelChange.unsupported']]) {
    const g = workspace(extra); await assert.rejects(g.w.changeModel('a', OPUS, g.expected, true), refuses(name)); await assert.rejects(g.w.modelChoices('a'), refuses(name)); assert.equal(g.calls.includes('stop'), false);
  }
  const stored = workspace(); stored.w.storageWarning = 'disk'; await assert.rejects(stored.w.changeModel('a', OPUS, stored.expected, true), refuses('error.modelChange.changed'));
});

test('a session that came out of the stop as something else is left as it is, without a resume', async () => {
  for (const onStop of [s => { s.nativeId = 'native-b'; }, s => { s.owner = 'other'; }, s => { s.controlRevision++; s.connectionRevision++; s.nativeId = 'native-b'; }, () => 'background', () => 'disconnected']) {
    const f = workspace({}, { onStop }); await assert.rejects(f.w.changeModel('a', OPUS, f.expected, true));
    assert.deepEqual(f.calls.filter(Array.isArray), []); assert.deepEqual(f.s.requestedSettings, { permissionMode: 'auto' });
  }
  const failed = workspace(); failed.r.stop = async () => { throw Error('native did not end'); };
  await assert.rejects(failed.w.changeModel('a', OPUS, failed.expected, true)); assert.deepEqual(failed.calls.filter(Array.isArray), []);
});

// Codex's own change.
function codex(options = {}) {
  const s = CODEX({ state: 'working' }), calls = [];
  const r = Object.create(Codex.prototype); EventEmitter.call(r);
  const pages = options.pages || [{ data: [{ model: 'gpt-6-luna', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }], nextCursor: null }];
  Object.assign(r, { record: s, nativeSettings: { nativeId: 'native-c', model: 'gpt-6-sol', effort: 'low', mode: null }, nativeRequests: new Map(), host: { codexTargets: new Map(), rpc: { nativeVersion: options.version ?? '0.172.0', call: async (method, params) => {
    calls.push([method, params]);
    if (method === 'model/list') return options.list ? options.list(params) : pages[params.cursor ? Number(params.cursor) : 0];
    if (method === 'thread/settings/update') { if (options.refuse) throw options.refuse; if (!options.silent) r.nativeSettings = { nativeId: params.threadId, model: params.model, effort: options.effort ?? params.effort, mode: 'default' }; return {}; }
    throw Error('unexpected ' + method);
  } } } });
  const w = Object.create(Workspace.prototype); EventEmitter.call(w);
  Object.assign(w, { sessions: new Map([[s.id, s]]), runtimes: new Map([[s.id, r]]), stops: new Map(), rooms: new Map(), draftRevisions: new Map() });
  return { w, s, r, calls, updates: () => calls.filter(([method]) => method === 'thread/settings/update').map(([, params]) => params) };
}
const LUNA = { model: 'gpt-6-luna', effort: 'high' };

test('Codex gets its own settings call for this thread, with a model it lists, whatever its version, and starts no turn', async () => {
  for (const version of ['0.172.0', '0.199.0']) {
    const f = codex({ version });
    assert.deepEqual(await f.w.changeModel('c', LUNA, { nativeId: 'native-c' }), LUNA);
    assert.deepEqual(f.calls, [['model/list', { limit: 100 }], ['thread/settings/update', { threadId: 'native-c', ...LUNA }]]);
  }
  assert.deepEqual(await codex().w.modelChoices('c'), { provider: 'codex', current: { model: 'gpt-6-sol', effort: 'low' }, nativeDefault: false, models: [{ model: 'gpt-6-luna', efforts: ['low', 'high'] }] });
});

test('a model or effort Codex does not list never reaches it: it would take one it does not know without a word', async () => {
  for (const value of [{ model: 'no-such-model', effort: 'low' }, { model: 'gpt-6-luna', effort: 'max' }, { model: null, effort: null }, { ...LUNA, x: 1 }, null]) {
    const f = codex(); await assert.rejects(f.w.changeModel('c', value, { nativeId: 'native-c' }), refuses('error.modelChange.unknown')); assert.deepEqual(f.updates(), []);
  }
  const pages = [{ data: [], nextCursor: '1' }, { data: [{ model: 'gpt-6-luna', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }], nextCursor: null }], paged = codex({ pages });
  await paged.w.changeModel('c', LUNA, { nativeId: 'native-c' }); assert.equal(paged.updates().length, 1);
  for (const list of [() => ({}), () => ({ data: [], nextCursor: '1' }), () => ({ data: [], nextCursor: 5 })]) { const f = codex({ list }); await assert.rejects(f.w.changeModel('c', LUNA, { nativeId: 'native-c' }), refuses('error.modelChange.unavailable')); assert.deepEqual(f.updates(), []); }
});

test('only what Codex reports as taken counts as changed', async () => {
  const silent = codex({ silent: true }), other = codex({ effort: 'low' }), set = globalThis.setTimeout;
  globalThis.setTimeout = (fn, _ms, ...args) => set(fn, 0, ...args);
  try { for (const f of [silent, other]) { await assert.rejects(f.w.changeModel('c', LUNA, { nativeId: 'native-c' }), refuses('error.modelChange.unconfirmed')); assert.equal(f.updates().length, 1, 'Not sent twice'); } }
  finally { globalThis.setTimeout = set; }
  for (const name of ['error.nativeRequestTimeout', 'error.nativeDisconnectedNoReplay']) await assert.rejects(codex({ refuse: uiError(name) }).w.changeModel('c', LUNA, { nativeId: 'native-c' }), refuses('error.modelChange.unconfirmed'));
  await assert.rejects(codex({ refuse: uiError('error.nativeRequestRejected', { arg1: -32600 }) }).w.changeModel('c', LUNA, { nativeId: 'native-c' }), refuses('error.nativeRequestRejected'));
});

test('a thread that was replaced, stopped or disconnected while its models were listed is not changed', async () => {
  for (const change of [f => { f.s.nativeId = 'native-d'; }, f => { f.w.sessions.delete('c'); }, f => { f.w.closed = true; }, f => { f.w.stops.set('c', {}); }, f => { f.s.state = 'disconnected'; }, f => { f.r.stopped = true; }, f => { f.r.transportDisconnected = true; }, f => { f.r.backendExitConfirmed = true; }, f => { f.r.host.rpc = null; }]) {
    const f = codex({ list: () => { change(f); return { data: [{ model: 'gpt-6-luna', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }], nextCursor: null }; } });
    await assert.rejects(f.w.changeModel('c', LUNA, { nativeId: 'native-c' }), undefined, String(change)); assert.deepEqual(f.updates(), [], String(change));
  }
  const other = codex(); other.s.modelProvider = 'deepseek'; await assert.rejects(other.w.changeModel('c', LUNA, { nativeId: 'native-c' }), refuses('error.modelChange.unsupported')); assert.deepEqual(other.calls, []);
  await assert.rejects(codex().w.changeModel('c', LUNA, { nativeId: 'native-x' }), refuses('error.modelChange.changed'));
});

test('a backend that can do it says so, answers both calls and holds its module', () => {
  const daemon = fs.readFileSync(require.resolve('../daemon.cjs'), 'utf8');
  assert.match(daemon, /require\('\.\/session-model\.cjs'\)\.CAPABILITY, /);
  assert.match(daemon, /case 'modelChoices': return workspace\.modelChoices\(args\[0\]\);\n\s+case 'changeModel': return workspace\.changeModel\(args\[0\], args\[1\], args\[2\], args\[3\]\);/);
  assert.match(fs.readFileSync(require.resolve('../service-client.cjs'), 'utf8'), /'session-model\.cjs'/, 'Copied with the backend');
  assert.deepEqual(maintenanceProof(CLAUDE()).nativeId, 'native-a');
});
