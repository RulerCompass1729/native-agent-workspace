'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { butlerBinding } = require('../butler-backend.cjs');
const source = fs.readFileSync(require.resolve('../butler-runner.cjs'), 'utf8');
const proof = () => ({ purpose: 'butler', profile: 'deepseek-pro', provider: 'deepseek', model: 'deepseek-v4-pro',
  runtimeVersion: 'runner-fixture', backendRef: 'butler-backend:fixture', runnerRef: 'butler-runner:fixture', store: 'store', startNonce: 'fixture' });

function fixture(receipt = { credentialPresent: true, ok: true, reason: null }) {
  const calls = [], env = Object.freeze({ SYNTHETIC_RUNNER: 'fixture' });
  const child = new EventEmitter(); child.stdio = [null, null, new PassThrough(), new PassThrough()];
  const module = { exports: {} };
  new Function('require', 'module', '__dirname', source)(name => {
    if (name === 'node:path') return path;
    if (name === './butler-backend.cjs') return { butlerBinding };
    if (name === './service-binding.cjs') return require('../service-binding.cjs');
    if (name === './platform.cjs') return {
      pythonExecutable() { calls.push(['python']); return '/synthetic/python'; },
      nativeEnvironment() { calls.push(['environment']); return env; }
    };
    if (name === 'node:child_process') return {
      spawn(binary, args, options) {
        calls.push(['spawn', binary, args, options]);
        process.nextTick(() => child.stdio[3].end(JSON.stringify(receipt)));
        return child;
      },
      spawnSync() { calls.push(['preflight']); throw Error('No process or credential preflight is permitted in this fixture'); }
    };
    throw Error('Unexpected runner dependency: ' + name);
  }, module, path.dirname(require.resolve('../butler-runner.cjs')));
  return { ...module.exports, calls, child, env };
}

for (const [field, value] of [['profile', 'another-profile'], ['provider', 'another-vendor'], ['model', 'another-model']]) {
  for (const explicitPython of [false, true]) test(`${field} mismatch is rejected before discovery, environment or process work (${explicitPython ? 'explicit' : 'default'} Python)`, () => {
    const f = fixture(), binding = { ...proof(), [field]: value };
    assert.doesNotThrow(() => butlerBinding(binding), 'The shared backend permits this otherwise valid configuration');
    const args = ['/synthetic/codex', ['app-server'], binding];
    if (explicitPython) args.push('/synthetic/explicit-python');
    assert.throws(() => f.spawnRunner(...args), { code: 'binding-mismatch' });
    assert.deepEqual(f.calls, [], 'A mismatch cannot discover Python, form an environment, read a profile or spawn');
  });
}

test('a malformed binding also fails before default Python discovery', () => {
  const f = fixture();
  assert.throws(() => f.spawnRunner('/synthetic/codex', [], null), { code: 'binding-mismatch' });
  assert.deepEqual(f.calls, []);
});

for (const explicitPython of [false, true]) test(`the fixed legacy tuple preserves its original pinned launch and metadata receipt (${explicitPython ? 'explicit' : 'default'} Python)`, async () => {
  const f = fixture(), args = ['-c', 'analytics.enabled=false', 'app-server', '--listen', 'unix:///synthetic/runner.sock'];
  const launched = explicitPython ? f.spawnRunner('/synthetic/codex', args, proof(), '/synthetic/explicit-python') :
    f.spawnRunner('/synthetic/codex', args, proof());
  assert.equal(launched.child, f.child); assert.equal(await launched.preflight, true);
  assert.deepEqual(f.calls.map(call => call[0]), explicitPython ? ['environment', 'spawn'] : ['python', 'environment', 'spawn']);
  const [, binary, actual, options] = f.calls.find(call => call[0] === 'spawn');
  assert.equal(binary, explicitPython ? '/synthetic/explicit-python' : '/synthetic/python');
  assert.deepEqual(actual, [path.join(path.dirname(require.resolve('../butler-runner.cjs')), 'butler-runner.py'), '/synthetic/codex',
    '--profile', 'deepseek-pro', '-c', 'model="deepseek-v4-pro"', '-c', 'model_provider="deepseek"',
    '-c', 'model_providers.deepseek.env_key="DEEPSEEK_API_KEY"', ...args]);
  assert.equal(options.env, f.env); assert.deepEqual(options.stdio, ['ignore', 'ignore', 'pipe', 'pipe']);
});

test('an accepted legacy binding still fails on a negative metadata-only child preflight', async () => {
  const f = fixture({ credentialPresent: false, ok: false, reason: 'profile-missing' });
  const launched = f.spawnRunner('/synthetic/codex', ['app-server'], proof());
  await assert.rejects(launched.preflight, { code: 'profile-missing' });
  assert.equal(f.calls.filter(call => call[0] === 'spawn').length, 1);
  assert.equal(f.calls.some(call => call[0] === 'preflight'), false);
});
