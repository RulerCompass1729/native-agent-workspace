const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const PROMPT_ONE = '11111111-1111-4111-8111-111111111111';
const PROMPT_TWO = '22222222-2222-4222-8222-222222222222';
const PROMPT_PEER = '33333333-3333-4333-8333-333333333333';

// Loads the real register.js hook module with a small test seam so the
// mid-turn prompt scenario can be driven through the actual event handlers.
async function bridge() {
  const raw = fs.readFileSync(path.join(__dirname, '../claude-bridge/hooks/register.js'), 'utf8');
  const source = raw + `
export function prepareMidturn({ ambiguous = false, peer = false } = {}) {
  stopped = false; observationGap = false; nativeBlocks = true;
  rootBinding = { sessionId: 'fixture-root', socketPath: '/fixture/socket', token: 'fixture-token', lease: 'fixture-lease', observationEpoch: 'fixture-epoch', observationSequence: 0, gapThrough: 0, nativeTurnRecords: true };
  activeTurn = 'turn-one';
  rootPrompt = { id: '${PROMPT_ONE}', binding: rootBinding, pending: false, firstText: 'first text' };
  promptTurns.clear();
  promptTurns.set('${PROMPT_ONE}', { binding: rootBinding, turnId: 'turn-one', promptId: '${PROMPT_ONE}', ambiguous });
  rootIdle = false;
  collecting = null; foreignSubmissions = 0; queuedPrompts = []; turnTriggers = [];
  foreignInFlight.clear(); if (peer) foreignInFlight.add({ origin: 'peer' });
  operatorTools = Object.keys(operatorSchemas);
}
export function midturnState() {
  return { promptId: rootPrompt?.id, turnId: activeTurn, ambiguous: promptTurns.get(rootPrompt?.id)?.ambiguous === true };
}
//${randomUUID()}`;
  const mod = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  const hooks = new Map();
  mod.register((event, match, handler) => {
    if (typeof match === 'function') { hooks.set(event, match); return { catch() {} }; }
    if (match?.tool) hooks.set(`${event}:${match.tool}`, handler);
    return { catch() {} };
  });
  return { mod, hooks };
}

function controlHarness() {
  const args = { action: 'invoke', operation_id: 'op', method: 'rename', arguments: ['target'] };
  const next = async () => ({ text: JSON.stringify({ approved: true, background: args }) }); next.origin = { plugin: 'engine' };
  const $ = { http: { fetch: async (_url, spec) => {
    const body = JSON.parse(spec.body);
    return { ok: true, text: JSON.stringify({ state: 'complete', id: body.arguments.operation_id }) };
  } } };
  return { args, next, $ };
}

test('a mid-turn person prompt with a different id keeps the running turn authorization', async () => {
  const { mod, hooks } = await bridge();
  mod.prepareMidturn();
  const submit = hooks.get('classic.UserPromptSubmit');
  await submit({ clock: { after() {} } }, { agent_id: undefined, session_id: 'fixture-root', prompt_id: PROMPT_TWO, prompt: 'second text', source: undefined }, async () => ({}));
  assert.equal(mod.midturnState().promptId, PROMPT_ONE);
  const control = hooks.get('tool.call:mcp__native_workspace__workspace_control');
  const { args, next, $ } = controlHarness();
  const result = await control($, { ...args, tool_use_id: 'call-one' }, next);
  assert.equal(result.deny, undefined);
  assert.equal(JSON.parse(result.result).state, 'complete');
});

test('a sub-agent call is still refused', async () => {
  const { mod, hooks } = await bridge();
  mod.prepareMidturn();
  const control = hooks.get('tool.call:mcp__native_workspace__workspace_control');
  const { args, next, $ } = controlHarness();
  const result = await control($, { ...args, tool_use_id: 'call-one', agentId: 'native-child' }, next);
  assert.equal(result.deny, 'Background control requires the actual native root call.');
});

test('an ambiguous shell turn is still refused', async () => {
  const { mod, hooks } = await bridge();
  mod.prepareMidturn({ ambiguous: true });
  const control = hooks.get('tool.call:mcp__native_workspace__workspace_control');
  const { args, next, $ } = controlHarness();
  const result = await control($, { ...args, tool_use_id: 'call-one' }, next);
  assert.equal(result.deny, 'Background control requires the actual native root call.');
});

test('a peer-sourced mid-turn prompt does not take over the running turn authorization', async () => {
  const { mod, hooks } = await bridge();
  mod.prepareMidturn({ peer: true });
  const submit = hooks.get('classic.UserPromptSubmit');
  let tagged;
  await submit({ clock: { after() {} } }, { agent_id: undefined, session_id: 'fixture-root', prompt_id: PROMPT_PEER, prompt: 'peer text', source: undefined }, async event => { tagged = event.source; return {}; });
  assert.equal(tagged, 'naw-peer');
  assert.equal(mod.midturnState().promptId, PROMPT_ONE);
});
