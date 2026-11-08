const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

// Import the unmodified mod and drive its public hooks. No seeded root/turn
// globals, Claude executable, model, real HTTP, socket or native session.
// This checks the qualified 317 contract, not native 318/319 qualification.
const source = fs.readFileSync(path.join(__dirname, '../claude-bridge/hooks/register.js'), 'utf8');
const tool = 'mcp__native_workspace__workspace_message';
const tick = () => new Promise(resolve => setImmediate(resolve));
const body = 'Read README.md\nOriginal: \u4fdd\u7559\u6b63\u6587 `one` and @literal';

async function fixture(t) {
  const sessionId = randomUUID(), hooks = new Map(), clock = [], requests = [];
  const state = { nativeCalls: 0, failStage: false };
  const api = {
    session: {
      id: async () => sessionId,
      version: async () => ({ version: '2.1.317' }),
      model: async () => 'fixture-model',
      usage: async () => null
    },
    env: { get: async key => ({ NAW_SUBMIT_SOCKET: '/fixture/no-socket', NAW_HOOK_TOKEN: 'fixture-token' })[key] },
    clock: {
      now: async () => 1000,
      after(delay, callback) {
        const item = { delay, callback, active: true };
        clock.push(item);
        return { cancel() { item.active = false; } };
      }
    },
    tool: { list: async () => [{ name: tool }] },
    prompt: {
      read: async () => ({ text: '' }),
      submit: async () => assert.fail('No native prompt may be submitted')
    },
    http: { fetch: async (url, options) => {
      const route = new URL(url).pathname, payload = JSON.parse(options.body);
      requests.push({ route, payload });
      if (route === '/addressed-message' && state.failStage) throw Error('fixture transport result lost');
      const result = route === '/root-bind'
        ? { lease: 'fixture-lease', observationEpoch: 'fixture-epoch', nativeBlocks: true }
        : route === '/next' ? { idle: true }
        : route === '/addressed-message' ? { status: 'staged', id: 'fixture-ticket' } : {};
      return { ok: true, text: JSON.stringify(result) };
    } }
  };
  const mod = await import('data:text/javascript;base64,' + Buffer.from(source + '\n//' + randomUUID()).toString('base64'));
  mod.register((name, filter, handler) => {
    if (typeof filter === 'function') handler = filter;
    hooks.set(name + (filter?.tool ? ':' + filter.tool : ''), handler);
    return { catch() {} };
  });
  const invoke = (name, event, next = async value => value) => hooks.get(name)(api, event, next);
  const settle = async () => { await tick(); await tick(); };
  await invoke('session.start', {});
  const startup = clock.shift();
  assert.equal(startup.delay, 0);
  await startup.callback();
  await settle();
  assert.equal(requests.find(row => row.route === '/root-bind').payload.nativeBlocks, true);
  assert.equal(requests.find(row => row.route === '/addressed-capability').payload.available, true);
  t.after(async () => { await invoke('session.end', { sessionId }); clock.length = 0; await settle(); });
  const start = async turnId => invoke('turn.start', { turnId, text: 'fixture work' });
  const prompt = async (event = {}, next) => invoke('classic.UserPromptSubmit', {
    session_id: sessionId, prompt_id: randomUUID(), prompt: 'fixture work', ...event
  }, next);
  const call = async (approval, event = {}) => {
    const input = { recipient_id: 'fixture-recipient', message: body, tool_use_id: 'fixture-call', ...event };
    const next = Object.assign(async e => {
      state.nativeCalls++;
      return approval ? approval(e) : { text: JSON.stringify({ approved: true, recipient_id: e.recipient_id, message: e.message }) };
    }, { origin: { plugin: 'engine' } });
    return invoke('tool.call:' + tool, input, next);
  };
  return { sessionId, state, requests, clock, invoke, start, prompt, call, settle,
    staged: () => requests.filter(row => row.route === '/addressed-message') };
}

test('a current native root prompt stages the exact recipient and original body once', async t => {
  const f = await fixture(t), promptId = randomUUID();
  await f.prompt({ prompt_id: promptId }); await f.start('current-turn');
  const result = await f.call();
  assert.equal(result.isError, false);
  assert.equal(JSON.parse(result.result).status, 'staged');
  assert.equal(f.state.nativeCalls, 1);
  assert.equal(f.staged().length, 1);
  const payload = f.staged()[0].payload;
  assert.deepEqual(payload.arguments, { recipient_id: 'fixture-recipient', message: body });
  assert.equal(payload.sessionId, f.sessionId);
  assert.equal(payload.turnId, 'current-turn');
  assert.equal(payload.promptId, promptId);
  assert.equal(payload.callId, 'fixture-call');
});

test('a non-human source label is not rejected when a new native prompt heads its own turn', async t => {
  const f = await fixture(t);
  // A synthetic label tests this hook's predicate, not the real event schema.
  await f.prompt({ source: 'task-notification' }); await f.start('event-turn');
  assert.equal((await f.call()).isError, false);
  assert.equal(f.staged().length, 1);
});

test('a background-only turn cannot reuse the previous completed prompt authority', async t => {
  const f = await fixture(t);
  await f.prompt(); await f.start('original-turn');
  await f.invoke('turn.complete', { turnId: 'original-turn', reason: 'answer', answer: '' });
  await f.start('background-turn');
  assert.ok((await f.call()).deny);
  assert.equal(f.state.nativeCalls, 0);
  assert.equal(f.staged().length, 0);
});

for (const source of ['foreign session', 'child agent', 'blocked prompt']) {
  test(`${source} cannot establish the new root turn's authority`, async t => {
    const f = await fixture(t);
    const event = source === 'foreign session' ? { session_id: randomUUID() }
      : source === 'child agent' ? { agent_id: 'fixture-child' } : {};
    await f.prompt(event, source === 'blocked prompt' ? async () => ({ block: 'fixture-blocked' }) : undefined);
    await f.start('unconfirmed-turn');
    assert.ok((await f.call()).deny);
    assert.equal(f.state.nativeCalls, 0);
    assert.equal(f.staged().length, 0);
  });
}

for (const field of ['recipient_id', 'message']) {
  test(`native approval changing ${field} never stages a handoff`, async t => {
    const f = await fixture(t);
    await f.prompt(); await f.start('original-turn');
    const result = await f.call(e => ({ text: JSON.stringify({ approved: true,
      recipient_id: e.recipient_id, message: e.message, [field]: 'changed' }) }));
    assert.ok(result.deny);
    assert.equal(f.state.nativeCalls, 1);
    assert.equal(f.staged().length, 0);
    assert.equal(f.requests.filter(row => row.route === '/addressed-failed').length, 1);
  });
}

test('native permission denial is preserved without staging or retry', async t => {
  const f = await fixture(t);
  await f.prompt(); await f.start('original-turn');
  assert.deepEqual(await f.call(() => ({ deny: 'fixture-native-denied' })), { deny: 'fixture-native-denied' });
  assert.equal(f.state.nativeCalls, 1);
  assert.equal(f.staged().length, 0);
});

test('a root turn change during native approval cancels staging', async t => {
  const f = await fixture(t);
  await f.prompt(); await f.start('original-turn');
  const result = await f.call(async e => {
    await f.start('later-turn');
    return { text: JSON.stringify({ approved: true, recipient_id: e.recipient_id, message: e.message }) };
  });
  assert.ok(result.deny);
  assert.equal(f.state.nativeCalls, 1);
  assert.equal(f.staged().length, 0);
});

test('an unconfirmed local stage is not replayed by scheduled metadata/reconnect work', async t => {
  const f = await fixture(t);
  await f.prompt(); await f.start('original-turn');
  f.state.failStage = true;
  assert.ok((await f.call()).deny);
  assert.equal(f.staged().length, 1);
  // Run each already scheduled callback once; never drain the recurring poll.
  for (const item of f.clock.splice(0)) if (item.active) await item.callback();
  await f.settle();
  assert.equal(f.staged().length, 1);
  assert.equal(f.state.nativeCalls, 1);
});
