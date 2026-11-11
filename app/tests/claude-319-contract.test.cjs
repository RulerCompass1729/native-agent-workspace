const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const vm = require('node:vm');

// Diagnostic contract check only. Imports the JavaScript mod with an in-memory
// API, never a Claude executable, provider, socket or real native session.
const sourceFile = process.env.NAW_T160_REGISTER_FIXTURE || path.join(__dirname, '../claude-bridge/hooks/register.js');
const source = fs.readFileSync(sourceFile, 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function startup(version) {
  const hooks = new Map(), clock = [], calls = [], modelReads = [], usageReads = [];
  const id = '11111111-1111-4111-8111-111111111111';
  const api = {
    session: {
      id: async () => id,
      version: async () => ({ version }),
      model: async () => { modelReads.push(version); return 'fixture-model'; },
      usage: async (...args) => { usageReads.push(args); return null; }
    },
    env: { get: async key => ({ NAW_SUBMIT_SOCKET: '/fixture/no-real-socket', NAW_HOOK_TOKEN: 'fixture-token' })[key] },
    clock: { after: (delay, callback) => { clock.push({ delay, callback }); return { cancel() {} }; } },
    tool: { list: async () => [] },
    prompt: { read: async () => ({ text: '' }), submit: async () => { throw Error('Model/input forbidden'); } },
    http: { fetch: async (url, options) => {
      const route = new URL(url).pathname;
      calls.push({ route, body: JSON.parse(options.body) });
      return { ok: true, text: JSON.stringify(route === '/root-bind'
        ? { lease: 'fixture-lease', observationEpoch: 'fixture-epoch', nativeBlocks: false }
        : route === '/next' ? { idle: true } : {}) };
    } }
  };
  const { register } = await import('data:text/javascript;base64,' + Buffer.from(source + '\n//' + randomUUID()).toString('base64'));
  register((name, callback) => { hooks.set(name, callback); return { catch() {} }; });
  await hooks.get('session.start')(api, {}, async event => event);
  const first = clock.shift();
  if (first) await first.callback();
  await tick(); await tick();
  return { hooks, api, calls, modelReads, usageReads, clock };
}

test('qualified 318 cold start binds and reads metadata without submitting a model task', async t => {
  const f = await startup('2.1.318');
  assert.equal(f.calls[0]?.route, '/root-bind');
  assert.equal(f.modelReads.length, 1);
  assert.deepEqual(f.usageReads, [[]], 'The bind-time usage read must be free and take no arguments');
  // T-171: native blocks too, so workspace messages have their turn identity.
  assert.equal(f.calls.find(c => c.route === '/root-bind').body.nativeBlocks, true);
  assert.ok(f.calls.some(c => c.route === '/next'));
  assert.ok(f.calls.every(c => ['/root-bind', '/next', '/observe'].includes(c.route)));
  t.diagnostic(JSON.stringify({ version: '2.1.318', observedMockRoutes: f.calls.map(c => c.route), modelMetadataReads: f.modelReads.length, realProviderCalls: false }));
});

test('qualified 319 cold start enables display metadata while keeping native input controls off', async t => {
  const f = await startup('2.1.319');
  assert.equal(f.calls[0]?.route, '/root-bind');
  assert.equal(f.modelReads.length, 1);
  assert.deepEqual(f.usageReads, [[]], 'The bind-time usage read must be free and take no arguments');
  const binding = f.calls[0].body;
  assert.equal(binding.nativeCapacity, true, 'T-32 capacity recovery does not require abort');
  assert.equal(binding.nativeBlocks, true, 'T-171: native blocks for workspace message turn identity');
  assert.equal(binding.nativeQueue, true);
  for (const key of ['nativeMedia', 'nativeTurnRecords', 'nativeNarration']) assert.equal(binding[key], true, key);
  for (const key of ['nativeInlineInput', 'nativePromptInput', 'nativeAbort', 'nativeSharedDisplay']) assert.equal(binding[key], false, key);
  t.diagnostic(JSON.stringify({ version: '2.1.319', observedMockRoutes: f.calls.map(c => c.route), modelMetadataReads: f.modelReads.length, realProviderCalls: false }));
});

test('319 uses the native post-switch model without changing unrelated control capabilities', async () => {
  const f = await startup('2.1.319');
  await f.hooks.get('classic.PostModelSwitch')(f.api, { session_id: '11111111-1111-4111-8111-111111111111', to_model: 'claude-native-selected' }, async event => event);
  await tick();
  for (const item of f.clock.splice(0)) await item.callback();
  await tick();
  assert.equal(f.modelReads.length, 1, 'The post event must not read an old model from the API');
  const rows = f.calls.filter(c => c.route === '/observation').map(c => c.body);
  assert.equal(rows.at(-1)?.model, 'claude-native-selected');
  assert.ok(rows.length > 0);
  assert.ok(rows.every(row => row.kind === 'control' && row.id === 'control:model'));
});

for (const version of ['2.1.321', '2.1.322']) test(`${version} cold start combines qualified display metadata with blocks, model, root, queue and capacity`, async () => {
  const f = await startup(version);
  assert.equal(f.calls[0]?.route, '/root-bind');
  assert.equal(f.modelReads.length, 1);
  assert.equal(f.calls[0].body.nativeBlocks, true);
  for (const key of ['nativeQueue', 'nativeCapacity']) assert.equal(f.calls[0].body[key], true, key);
  assert.deepEqual(f.usageReads, [[]], 'The bind-time usage read must be free and take no arguments');
  for (const key of ['nativeTurnRecords', 'nativeNarration']) assert.equal(f.calls[0].body[key], true, key);
  for (const key of ['nativeInlineInput', 'nativePromptInput', 'nativeMedia', 'nativeAbort', 'nativeSharedDisplay']) assert.equal(f.calls[0].body[key], false, key);
  assert.ok(f.calls.some(c => c.route === '/next'));
});

for (const version of ['2.1.319-beta', '2.1.320', '2.1.321-beta', '2.1.322+unqualified', '2.1.323']) test(`unqualified model metadata ${version} remains off`, async () => {
  const f = await startup(version);
  assert.equal(f.calls.some(c => c.route === '/root-bind'), false);
  assert.equal(f.modelReads.length, 0);
});

test('the native runner admits exact319 only in its solo model-only path', () => {
  const runner = fs.readFileSync(path.join(__dirname, '../../scripts/test-native-queue.cjs'), 'utf8');
  const guard = runner.split('\n').find(line => line.startsWith('assert.match(nativeVersion,'));
  assert.ok(guard);
  for (const version of ['2.1.319 (Claude Code)', '2.1.319']) vm.runInNewContext(guard, { assert, nativeVersion: version, inlineTrial: false, noModelServer: true });
  for (const version of ['2.1.319-beta (Claude Code)', '2.1.320 (Claude Code)']) assert.throws(() => vm.runInNewContext(guard, { assert, nativeVersion: version, inlineTrial: false, noModelServer: true }));
  for (const inlineTrial of [false, true]) assert.throws(() => vm.runInNewContext(guard, { assert, nativeVersion: '2.1.319 (Claude Code)', inlineTrial, noModelServer: false }));
});

// B11 rollout, 2026-11-10: the queue journey passed on real 2.1.322 through the loopback fixture (solo and shared).
test('the native runner admits exact322 in its queue journey, and no neighbouring or unverified version', () => {
  const runner = fs.readFileSync(path.join(__dirname, '../../scripts/test-native-queue.cjs'), 'utf8');
  const guard = runner.split('\n').find(line => line.startsWith('assert.match(nativeVersion,'));
  assert.ok(guard);
  // inlineTrial false with noModelServer false is the queue journey (solo or shared) and the shared model-only
  // journey; each of the three passed on real 2.1.322 (rollout-status.md, 2026-11-10).
  const queue = version => vm.runInNewContext(guard, { assert, nativeVersion: version, inlineTrial: false, noModelServer: false });
  for (const version of ['2.1.322 (Claude Code)', '2.1.322', '2.1.311 (Claude Code)']) queue(version);
  for (const version of ['2.1.322-beta (Claude Code)', '2.1.3220 (Claude Code)', '2.1.321 (Claude Code)', '2.1.323 (Claude Code)', '2.1.318 (Claude Code)', '2.2.322 (Claude Code)']) assert.throws(() => queue(version), version);
  assert.throws(() => vm.runInNewContext(guard, { assert, nativeVersion: '2.1.322 (Claude Code)', inlineTrial: true, noModelServer: false }), 'the inline journey stays on 312');
  assert.throws(() => vm.runInNewContext(guard, { assert, nativeVersion: '2.1.322 (Claude Code)', inlineTrial: false, noModelServer: true }), 'the model-only journey keeps its own list');
});

test('T160 diagnostic: below-minimum version starts neither a poll nor model metadata', async () => {
  const f = await startup('2.1.301');
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.modelReads, []);
  assert.deepEqual(f.clock, []);
});
