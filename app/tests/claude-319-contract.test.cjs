const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

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
  assert.equal(f.calls.find(c => c.route === '/root-bind').body.nativeBlocks, false);
  assert.ok(f.calls.some(c => c.route === '/next'));
  assert.ok(f.calls.every(c => ['/root-bind', '/next', '/observe'].includes(c.route)));
  t.diagnostic(JSON.stringify({ version: '2.1.318', observedMockRoutes: f.calls.map(c => c.route), modelMetadataReads: f.modelReads.length, realProviderCalls: false }));
});

test('T160 diagnostic: current 319 policy omits cold binding and model reads, not a protocol verdict', async t => {
  const f = await startup('2.1.319');
  assert.equal(f.calls[0]?.route, '/next');
  assert.equal(f.calls.some(c => c.route === '/root-bind'), false);
  assert.equal(f.modelReads.length, 0);
  assert.ok(f.calls.every(c => c.route === '/next'));
  t.diagnostic(JSON.stringify({ version: '2.1.319', observedMockRoutes: f.calls.map(c => c.route), modelMetadataReads: f.modelReads.length, realProviderCalls: false }));
});

test('T160 diagnostic: 319 PostModelSwitch cannot bypass the unqualified model gate', async () => {
  const f = await startup('2.1.319');
  await f.hooks.get('classic.PostModelSwitch')(f.api, {}, async event => event);
  await tick();
  assert.equal(f.modelReads.length, 0);
  assert.equal(f.calls.some(c => c.route === '/root-bind'), false);
});

test('T160 diagnostic: below-minimum version starts neither a poll nor model metadata', async () => {
  const f = await startup('2.1.301');
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.modelReads, []);
  assert.deepEqual(f.clock, []);
});
