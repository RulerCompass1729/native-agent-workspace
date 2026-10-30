const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Codex } = require('../adapters.cjs'), { Workspace } = require('../workspace.cjs');

function fixture(t, recovering = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-effective-settings-'));
  const nativeId = randomUUID(), calls = [];
  const response = { thread: { id: nativeId, cwd: dir, status: { type: 'idle' }, turns: [] }, model: 'native/model-literal', reasoningEffort: 'high',
    developerInstructions: 'PRIVATE_CONFIGURATION', config: { privateKey: 'PRIVATE_CONFIGURATION' } };
  const host = { binaries: {}, codexTargets: new Map(), codexProcess: { pid: null }, startCodex: async () => {}, createCodex: operation => operation(), close() {} };
  host.rpc = { nativeVersion: '0.164.0', call: async (method, params) => {
    calls.push({ method, params });
    if (['thread/start', 'thread/resume'].includes(method)) return response;
    if (['thread/items/list', 'thread/turns/list'].includes(method)) return { data: [], nextCursor: null };
    throw Error('Unexpected protocol operation: ' + method);
  } };
  const w = new Workspace(host, dir), s = { id: 'owned', provider: 'codex', ...(recovering ? { nativeId, recovering: true } : {}), cwd: dir,
    view: 'chat', messages: [], owner: 'owned-view', state: 'starting', controlRevision: 0, memberRevision: 0 };
  const r = new Codex(s, host); w.sessions.set(s.id, s); w.runtimes.set(s.id, r); w.bind(s, r); w.drafts.set(s.id, 'Unsent original draft');
  t.after(() => { w.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { w, s, r, host, nativeId, response, calls };
}

for (const recovering of [false, true]) test(`effective model and effort reach the reader on ${recovering ? 'same-thread recovery' : 'thread creation'} without a settings event`, async t => {
  const f = fixture(t, recovering); await f.r.start();
  assert.equal(f.s.nativeId, f.nativeId);
  assert.deepEqual(f.w.snapshot().sessions[0].nativeSettings, { nativeId: f.nativeId, model: 'native/model-literal', effort: 'high', mode: null });
  assert.equal(f.s.model, 'native/model-literal'); assert.equal(f.w.drafts.get('owned'), 'Unsent original draft'); assert.equal(f.s.owner, 'owned-view');
  assert.ok(!JSON.stringify(f.w.snapshot()).includes('PRIVATE_CONFIGURATION'));
  assert.ok(f.calls.every(c => !/goal|turn\/start|interrupt|settings\/update/.test(c.method)));
  const request = f.calls.find(c => c.method === (recovering ? 'thread/resume' : 'thread/start'));
  for (const key of ['model', 'reasoningEffort', 'approvalPolicy', 'sandbox']) assert.equal(Object.hasOwn(request.params, key), false);
});

test('a delayed recovery response cannot replace a newer native model, effort or Plan event', async t => {
  const f = fixture(t, true), original = f.host.rpc.call;
  let resolve, requested; const waiting = new Promise(r => { requested = r; });
  f.host.rpc.call = async (method, params) => method === 'thread/resume' ? (requested(), new Promise(r => { resolve = r; })) : original(method, params);
  const start = f.r.start(); await waiting;
  f.r.event({ method: 'thread/settings/updated', params: { threadId: f.nativeId, threadSettings: { model: 'newer/native-model', effort: 'ultra', collaborationMode: { mode: 'plan' } } } });
  resolve(f.response); await start;
  assert.deepEqual(f.w.snapshot().sessions[0].nativeSettings, { nativeId: f.nativeId, model: 'newer/native-model', effort: 'ultra', mode: 'plan' });
  assert.equal(f.s.model, 'newer/native-model');
});

test('same-thread transport rejoin exposes the response effort without sending input', async t => {
  const f = fixture(t, true); f.r.stopped = true; await f.r.reconnect();
  assert.deepEqual(f.w.snapshot().sessions[0].nativeSettings, { nativeId: f.nativeId, model: 'native/model-literal', effort: 'high', mode: null });
  assert.equal(f.s.nativeId, f.nativeId); assert.equal(f.w.drafts.get('owned'), 'Unsent original draft');
  assert.ok(f.calls.every(c => !/goal|turn\/start|interrupt|settings\/update/.test(c.method)));
});

test('same native terminal response reports effort but cannot overwrite a settings event received while it was pending', t => {
  const f = fixture(t, true), rpc = { connected: true, reply() {} };
  f.r.observeTerminalContext({ kind: 'request', method: 'thread/resume', threadId: f.nativeId, key: 1 });
  f.r.observeTerminalContext({ kind: 'response', method: 'thread/resume', key: 1, rpc, result: f.response });
  assert.equal(f.w.snapshot().sessions[0].nativeSettings?.effort, 'high');
  f.r.observeTerminalContext({ kind: 'request', method: 'thread/resume', threadId: f.nativeId, key: 2 });
  f.r.event({ method: 'thread/settings/updated', params: { threadId: f.nativeId, threadSettings: { model: 'newer/native-model', effort: 'ultra' } } });
  f.r.observeTerminalContext({ kind: 'response', method: 'thread/resume', key: 2, rpc, result: f.response });
  assert.equal(f.s.model, 'newer/native-model'); assert.equal(f.w.snapshot().sessions[0].nativeSettings.effort, 'ultra');
});

for (const effort of [undefined, null]) test(`unreported native effort stays unknown (${effort})`, async t => {
  const f = fixture(t); f.response.reasoningEffort = effort; await f.r.start();
  assert.equal(f.w.snapshot().sessions[0].nativeSettings.effort, null);
});

test('a same-thread response preserves an independently observed Plan mode', async t => {
  const f = fixture(t, true);
  f.r.observeSettings({ model: 'earlier/native-model', effort: 'low', collaborationMode: { mode: 'plan' } });
  await f.r.start();
  assert.deepEqual(f.w.snapshot().sessions[0].nativeSettings, { nativeId: f.nativeId, model: 'native/model-literal', effort: 'high', mode: 'plan' });
});

test('a fresh terminal thread projects its actual response before any user model turn', async t => {
  const f = fixture(t); f.r.terminalEndpoint = async () => '/owned-unused-endpoint';
  f.r.makeTerminal = () => (f.r.terminal = new EventEmitter());
  const start = f.r.startFromTerminal(); await new Promise(setImmediate);
  f.r.observeTerminalContext({ kind: 'request', method: 'thread/start', key: 1 });
  f.r.observeTerminalContext({ kind: 'response', method: 'thread/start', key: 1, rpc: { connected: true }, result: f.response });
  await start;
  assert.equal(f.s.nativeId, f.nativeId); assert.equal(f.w.snapshot().sessions[0].nativeSettings.effort, 'high');
  assert.deepEqual(f.calls, [], 'The observed TUI response requires no additional subscription or model input');
});

test('initial native history attachment picks up the materialized response settings', async t => {
  const f = fixture(t, true), original = f.host.rpc.call; f.r.chatAvailable = false;
  f.host.rpc.call = (method, params) => method === 'thread/read' ? Promise.resolve({ thread: { ...f.response.thread, preview: 'Existing native result' } }) : original(method, params);
  await f.r.observeFirstTurn();
  assert.equal(f.w.snapshot().sessions[0].nativeSettings.effort, 'high'); assert.equal(f.r.chatAvailable, true);
});

test('terminal notification loss can rejoin the same native settings through the graphical connection', async t => {
  const f = fixture(t, true), rpc = f.r.terminalRpc = { connected: false }; f.r.terminalNotificationSource = true;
  f.r.observeTerminalContext({ kind: 'disconnected', rpc }); await f.r.observing;
  assert.equal(f.w.snapshot().sessions[0].nativeSettings.effort, 'high'); assert.equal(f.s.nativeId, f.nativeId);
});

test('a committed terminal identity change never inherits the former native effort or Plan mode', async t => {
  const f = fixture(t, true), nextId = randomUUID(), rpc = { connected: true };
  f.r.observeSettings({ model: 'earlier/native-model', effort: 'low', collaborationMode: { mode: 'plan' } });
  f.r.observeTerminalContext({ kind: 'request', method: 'thread/start', key: 1 });
  f.r.observeTerminalContext({ kind: 'response', method: 'thread/start', key: 1, rpc, result: { ...f.response, thread: { ...f.response.thread, id: nextId }, reasoningEffort: 'xhigh' } });
  await f.r.observing;
  assert.equal(f.s.nativeId, nextId); assert.deepEqual(f.w.snapshot().sessions[0].nativeSettings, { nativeId: nextId, model: 'native/model-literal', effort: 'xhigh', mode: null });
  assert.equal(f.w.drafts.get('owned'), 'Unsent original draft');
});

test('a response belonging to an earlier terminal request cannot replace the latest settings snapshot', t => {
  const f = fixture(t, true), rpc = { connected: true };
  f.r.observeTerminalContext({ kind: 'request', method: 'thread/resume', threadId: f.nativeId, key: 1 });
  f.r.observeTerminalContext({ kind: 'request', method: 'thread/resume', threadId: f.nativeId, key: 2 });
  f.r.observeTerminalContext({ kind: 'response', method: 'thread/resume', key: 1, rpc, result: f.response });
  assert.equal(f.r.nativeSettings, undefined);
  f.r.observeTerminalContext({ kind: 'response', method: 'thread/resume', key: 2, rpc, result: { ...f.response, reasoningEffort: 'ultra' } });
  assert.equal(f.w.snapshot().sessions[0].nativeSettings.effort, 'ultra');
});

test('an accepted native turn subscription also reports current effective settings', async t => {
  const f = fixture(t, true); await f.r.observeAcceptedTurn('observed-native-turn');
  assert.equal(f.w.snapshot().sessions[0].nativeSettings.effort, 'high');
  assert.ok(f.calls.every(c => !/goal|turn\/start|interrupt|settings\/update/.test(c.method)));
});

test('unidentified or foreign native responses cannot manufacture reader settings', t => {
  const f = fixture(t);
  assert.doesNotThrow(() => f.r.observeReplySettings({ model: 'unidentified', reasoningEffort: 'high' }, undefined));
  f.r.observeReplySettings(f.response, undefined);
  assert.equal(f.r.nativeSettings, undefined); assert.equal(f.s.model, undefined);
});
