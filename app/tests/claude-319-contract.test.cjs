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
  const hooks = new Map(), clock = [], calls = [], modelReads = [];
  const id = '11111111-1111-4111-8111-111111111111';
  const api = {
    session: {
      id: async () => id,
      version: async () => ({ version }),
      model: async () => { modelReads.push(version); return 'fixture-model'; },
      usage: async () => { throw Error('Usage must remain outside this model-only check'); }
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
  return { hooks, api, calls, modelReads, clock };
}

test('T160 diagnostic: qualified 318 model-only cold start still binds and reads metadata', async t => {
  const f = await startup('2.1.318');
  assert.equal(f.calls[0]?.route, '/root-bind');
  assert.equal(f.modelReads.length, 1);
  // T-171: native blocks too, so workspace messages have their turn identity.
  assert.equal(f.calls.find(c => c.route === '/root-bind').body.nativeBlocks, true);
  assert.ok(f.calls.some(c => c.route === '/next'));
  assert.ok(f.calls.every(c => ['/root-bind', '/next', '/observe'].includes(c.route)));
  t.diagnostic(JSON.stringify({ version: '2.1.318', observedMockRoutes: f.calls.map(c => c.route), modelMetadataReads: f.modelReads.length, realProviderCalls: false }));
});

test('qualified 319 model-only cold start binds and reads its initial native model', async t => {
  const f = await startup('2.1.319');
  assert.equal(f.calls[0]?.route, '/root-bind');
  assert.equal(f.modelReads.length, 1);
  const binding = f.calls[0].body;
  assert.equal(binding.nativeBlocks, true, 'T-171: native blocks for workspace message turn identity');
  for (const key of ['nativeQueue', 'nativeInlineInput', 'nativePromptInput', 'nativeMedia', 'nativeAbort', 'nativeCapacity', 'nativeSharedDisplay', 'nativeTurnRecords', 'nativeNarration']) assert.equal(binding[key], false, key);
  t.diagnostic(JSON.stringify({ version: '2.1.319', observedMockRoutes: f.calls.map(c => c.route), modelMetadataReads: f.modelReads.length, realProviderCalls: false }));
});

test('319 uses the native post-switch model while keeping all input and tool capabilities off', async () => {
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

for (const version of ['2.1.319-beta', '2.1.320']) test(`unqualified model metadata ${version} remains off`, async () => {
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

test('T160 diagnostic: below-minimum version starts neither a poll nor model metadata', async () => {
  const f = await startup('2.1.301');
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.modelReads, []);
  assert.deepEqual(f.clock, []);
});
