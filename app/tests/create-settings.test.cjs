const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createSettings } = require('../workspace.cjs');
const { Codex } = require('../adapters.cjs');

// A session NAW's rotation creates starts with the old session's settings (2026-11-08):
// otherwise four daily Codex sessions on gpt-6.1-sol would have moved to the gpt-6-astra default.

test('create accepts only a known model, effort and permission mode for each provider', () => {
  assert.equal(createSettings('claude', undefined), null);
  assert.equal(createSettings('claude', {}), null);
  assert.deepEqual(createSettings('claude', { model: 'claude-opus-5-5', effort: 'xhigh', permissionMode: 'auto' }), { model: 'claude-opus-5-5', effort: 'xhigh', permissionMode: 'auto' });
  assert.deepEqual(createSettings('codex', { model: 'gpt-6.1-sol', effort: 'ultra' }), { model: 'gpt-6.1-sol', effort: 'ultra' });
  const refused = [
    ['claude', { model: '--dangerously-skip-permissions' }],
    ['claude', { model: 'opus; rm' }],
    ['claude', { effort: 'ultra' }],
    ['claude', { permissionMode: 'everything' }],
    ['codex', { permissionMode: 'auto' }],
    ['codex', { effort: 'x"y' }],
    ['claude', { model: 'opus', extra: true }],
    ['claude', ['opus']],
  ];
  for (const [provider, settings] of refused) {
    assert.throws(() => createSettings(provider, settings), /无效|invalid/i, JSON.stringify(settings));
  }
});

test('a new Claude session gets the requested mode, model and effort; recovery and bypass keep their own rules', () => {
  const source = fs.readFileSync(path.join(__dirname, '../adapters.cjs'), 'utf8');
  const from = source.indexOf('    const posture =');
  const to = source.indexOf('\n    // A picker', from);
  const posture = record => Array.from(vm.runInNewContext(source.slice(from, to) + '\nposture', { record, EFFORT_LEVELS: ['low', 'medium', 'high', 'xhigh', 'max'] }));
  const requestedSettings = { model: 'claude-opus-5-5', effort: 'xhigh', permissionMode: 'auto' };
  assert.deepEqual(posture({ requestedSettings }), ['--permission-mode', 'auto', '--model', 'claude-opus-5-5', '--effort', 'xhigh']);
  assert.deepEqual(posture({ skipPermissions: true, requestedSettings }), ['--permission-mode', 'bypassPermissions', '--model', 'claude-opus-5-5', '--effort', 'xhigh']);
  assert.deepEqual(posture({ requestedSettings: { model: 'claude-opus-5-5' } }), ['--model', 'claude-opus-5-5']);
  assert.deepEqual(posture({}), []);
  // A recovered session resumes natively (its saved model and mode); the request is not re-applied.
  assert.deepEqual(posture({ recovering: true, requestedSettings, nativeEffort: 'high' }), ['--effort', 'high']);
});

function codexHost(calls) {
  return {
    binaries: { codex: 'codex-binary' },
    codexTargets: new Map(),
    codexProcess: { pid: 4321 },
    startCodex: async () => {},
    createCodex: fn => fn(),
    rpc: {
      call: async (method, params) => {
        calls.push({ method, params });
        return { thread: { id: 'synthetic-thread', sessionId: 'synthetic-session', turns: [] }, model: params.model || 'gpt-6-astra', reasoningEffort: null };
      },
    },
  };
}

test('a new Codex chat session asks thread/start for the requested model and effort', async () => {
  const calls = [];
  const record = { id: 'synthetic', cwd: '/tmp', provider: 'codex', view: 'chat', messages: [], requestedSettings: { model: 'gpt-6.1-sol', effort: 'ultra' } };
  await new Codex(record, codexHost(calls)).start();
  assert.equal(calls[0].method, 'thread/start');
  assert.equal(calls[0].params.model, 'gpt-6.1-sol');
  assert.deepEqual(calls[0].params.config, { model_reasoning_effort: 'ultra' });
  const plainCalls = [];
  await new Codex({ id: 'plain', cwd: '/tmp', provider: 'codex', view: 'chat', messages: [] }, codexHost(plainCalls)).start();
  assert.equal('model' in plainCalls[0].params, false);
  assert.equal('config' in plainCalls[0].params, false);
});

test('a new Codex terminal session starts the native terminal with the requested model and effort', async () => {
  const host = codexHost([]);
  const record = { id: 'synthetic', cwd: '/tmp', provider: 'codex', view: 'terminal', messages: [], requestedSettings: { model: 'gpt-6.1-sol', effort: 'ultra' } };
  const runtime = new Codex(record, host);
  let argv = null;
  runtime.terminalEndpoint = async () => '/tmp/synthetic-endpoint';
  runtime.makeTerminal = args => {
    argv = args;
    const terminal = new EventEmitter();
    terminal.alive = true;
    runtime.terminal = terminal;
    return terminal;
  };
  runtime.observeFirstTurn = async () => {};
  const started = runtime.startFromTerminal();
  await new Promise(resolve => setImmediate(resolve));
  host.pendingCodex({ id: 'synthetic-thread', sessionId: 'synthetic-session', model: 'gpt-6.1-sol' }, 'gpt-6.1-sol');
  await started;
  const remote = argv.indexOf('--remote');
  assert.ok(remote > 0);
  const options = argv.slice(0, remote);
  assert.deepEqual(options.slice(options.indexOf('-m'), options.indexOf('-m') + 2), ['-m', 'gpt-6.1-sol']);
  assert.ok(options.includes('model_reasoning_effort="ultra"'));
  assert.equal(options[options.indexOf('model_reasoning_effort="ultra"') - 1], '-c');
});
