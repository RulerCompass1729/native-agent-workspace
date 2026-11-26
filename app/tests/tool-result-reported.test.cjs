'use strict';
// A workspace_control or workspace_message call that NAW gave no usable answer to: the agent is told why, and whether
// the work can have run. `deny` after the tool itself ran showed only a fixed sentence, whatever had happened.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), { randomUUID } = require('node:crypto');

const URL_TEXT = 'http://localhost/route';
// Claude Code 2.1.332's own texts, as its $.http.fetch throws them.
const FAILURES = {
  timeout: () => { throw Error(`naw: $.http.fetch(${URL_TEXT}) aborted: no complete answer within 30000ms`); },
  'too-large': () => { throw Error(`naw: $.http.fetch: ${URL_TEXT} refused: body of 5242880 bytes is over the 4194304-byte limit`); },
  connection: () => { throw Error(`naw: $.http.fetch(${URL_TEXT}) failed: ECONNRESET: socket hang up`); },
  http: () => ({ ok: false, status: 409, text: '{}' }),
  'http-5xx': () => ({ ok: false, status: 500, text: '' }),
  unreadable: () => ({ ok: true, status: 200, text: '{"state":' }),
};
const SAID = { timeout: /超时/u, 'too-large': /过大/u, connection: /没有收到 NAW 完整的答复/u, http: /HTTP 409/u, 'http-5xx': /HTTP 500：没有收到/u, unreadable: /没有收到 NAW 完整的答复/u };

async function plugin(fetch) {
  const source = fs.readFileSync(path.join(__dirname, '../claude-bridge/hooks/register.js'), 'utf8') + `
export function seed(binding) {
  stopped = false; observationGap = false; nativeBlocks = true; addressedTool = true; rootBinding = binding; activeTurn = 'turn-1'; rootIdle = false;
  rootPrompt = { id: 'prompt-1', binding, pending: false };
  promptTurns.set('prompt-1', { binding, turnId: 'turn-1', promptId: 'prompt-1', ambiguous: false });
}
//${randomUUID()}`;
  const mod = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  const hooks = new Map(), posted = [];
  mod.register((event, match, handler) => { hooks.set(typeof match === 'object' && match?.tool ? `${event}:${match.tool}` : event, typeof match === 'function' ? match : handler); return { catch() {} }; });
  const $ = { session: { id: async () => 'native-sender' }, env: { get: async name => ({ NAW_SUBMIT_SOCKET: '/fixture/socket', NAW_HOOK_TOKEN: 'fixture-token' })[name] },
    http: { fetch: async (url, spec) => { posted.push(url.slice('http://localhost'.length)); return fetch(url, spec); } } };
  mod.seed({ sessionId: 'native-sender', socketPath: '/fixture/socket', token: 'fixture-token', lease: 'lease-1', observationEpoch: 'epoch-1' });
  const engine = text => Object.assign(async () => ({ text }), { origin: { plugin: 'engine', tier: 'core' } });
  return { posted,
    control: args => hooks.get('tool.call:mcp__native_workspace__workspace_control')($, { tool_use_id: 'call-1', ...args }, engine(JSON.stringify({ approved: true, background: args }))),
    message: args => hooks.get('tool.call:mcp__native_workspace__workspace_message')($, { tool_use_id: 'call-1', ...args }, engine(JSON.stringify({ approved: true, ...args }))) };
}
const read = answer => { assert.equal(answer.deny, undefined, 'the tool ran: a refusal would hide what is known'); assert.equal(answer.isError, true); return JSON.parse(answer.result); };

for (const kind of Object.keys(FAILURES)) {
  const refused = kind === 'http';
  test(`workspace_control invoke: ${kind} is told as it is, ${refused ? 'not executed' : 'unknown, with the receipt to read'}, and never sent twice`, async () => {
    const p = await plugin(FAILURES[kind]), told = read(await p.control({ action: 'invoke', method: 'queueAdd', arguments: [], operation_id: 'op-1' }));
    assert.equal(told.state, refused ? 'not-executed' : 'unconfirmed'); assert.equal(told.retry, false);
    assert.match(told.message, SAID[kind]);
    if (refused) { assert.match(told.message, /没执行/u); assert.doesNotMatch(told.message, /不知道/u); }
    else { assert.match(told.message, /不知道/u); assert.match(told.message, /receipt 读 op-1/u); assert.match(told.message, /不要重发/u); }
    assert.deepEqual(p.posted, ['/background-control'], 'one request, no retry');
  });
  test(`workspace_message: ${kind} is told as it is, ${refused ? 'not executed' : 'unknown'}, and never sent twice`, async () => {
    const p = await plugin(FAILURES[kind]), told = read(await p.message({ recipient_id: 'member', message: 'SYNTHETIC PRIVATE MESSAGE' }));
    assert.equal(told.status, refused ? 'not-sent' : 'unconfirmed'); assert.equal(told.retry, false);
    assert.match(told.message, SAID[kind]); assert.match(told.message, refused ? /没执行/u : /不知道.*不要重发/u);
    assert.doesNotMatch(JSON.stringify(told), /SYNTHETIC PRIVATE/u);
    assert.deepEqual(p.posted, ['/addressed-message'], 'one request, no retry');
  });
  test(`workspace_control snapshot: ${kind} says that a read changed nothing`, async () => {
    const p = await plugin(FAILURES[kind]);
    for (const args of [{ action: 'snapshot' }, { action: 'catalog' }, { action: 'receipt', operation_id: 'op-1' }]) {
      const told = read(await p.control(args));
      assert.match(told.message, SAID[kind]); assert.match(told.message, /只是读，什么都没改/u); assert.doesNotMatch(told.message, /不知道/u);
    }
    assert.equal(p.posted.length, 3);
  });
}

test('an answer is passed on as it was: the kinds above are only for calls without one', async () => {
  const answer = value => async () => ({ ok: true, status: 200, text: JSON.stringify(value) });
  for (const [value, isError] of [[{ state: 'complete', value: 1 }, false], [{ state: 'unconfirmed', error: 'x' }, true], [{ state: 'not-executed', reason: 'y' }, true]]) {
    assert.deepEqual(await (await plugin(answer(value))).control({ action: 'invoke', method: 'queueAdd', arguments: [], operation_id: 'op-1' }), { result: JSON.stringify(value), isError });
  }
  for (const [value, isError] of [[{ status: 'staged' }, false], [{ status: 'not-sent' }, true]]) {
    assert.deepEqual(await (await plugin(answer(value))).message({ recipient_id: 'member', message: 'm' }), { result: JSON.stringify(value), isError });
  }
});
