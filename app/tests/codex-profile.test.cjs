const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { readCodexProfile, catalogConfig, listCodexProfiles } = require('../codex-profile.cjs');
const { createSettings, sessionMaker, Workspace } = require('../workspace.cjs');
const { Codex } = require('../adapters.cjs');

// A DeepSeek member runs in Codex from one of the person's Codex profiles (2026-11-13). The
// profile below is synthetic; the key variable it would use is never read by NAW.
const PROFILE = [
  '# synthetic profile',
  'model = "deepseek-v4-pro"',
  'model_provider = "deepseek"',
  'model_catalog_json = "/tmp/synthetic-catalog/models.json"',
  "model_reasoning_effort = 'high'  # comment",
  'model_context_window = 950000',
  'approval_policy = "never"',
  'sandbox_mode = "danger-full-access"',
  'analytics.enabled = true',
  '',
  '[projects."/tmp/synthetic"]',
  'trust_level = "trusted"',
].join('\n');

function codexHome(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-codex-profile-'));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, `${name}.config.toml`), text);
  const before = process.env.CODEX_HOME;
  process.env.CODEX_HOME = dir;
  t.after(() => {
    if (before === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = before;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

const EXPECTED = {
  model: 'deepseek-v4-pro',
  model_provider: 'deepseek',
  model_catalog_json: '/tmp/synthetic-catalog/models.json',
  model_reasoning_effort: 'high',
  model_context_window: 950000,
};

test('a Codex profile gives its model settings up to its first table, and is refused whole when a line cannot be read', t => {
  codexHome(t, {
    'deepseek-pro': PROFILE,
    multiline: 'model = """deepseek"""\n',
    legacy: 'profile = "deepseek-pro"\n',
    array: 'model = ["a"]\n',
    open: 'model = "deepseek\n',
    trailing: 'model = "deepseek" extra\n',
    empty: '# nothing\n[table]\nmodel = "x"\n',
    permissions: 'approval_policy = "never"\n',
    large: `model = "${'x'.repeat(70 * 1024)}"\n`,
  });
  assert.deepEqual(readCodexProfile('deepseek-pro'), EXPECTED, 'approval, sandbox and analytics stay NAW\'s');
  assert.deepEqual(catalogConfig('deepseek-pro'), { model_catalog_json: '/tmp/synthetic-catalog/models.json' });
  for (const name of ['multiline', 'legacy', 'array', 'open', 'trailing', 'empty', 'permissions', 'large', 'missing', '../deepseek-pro', '', '-x']) {
    assert.throws(() => readCodexProfile(name), /无效|invalid/i, name);
  }
});

test('create accepts a Codex profile name, and only for Codex', () => {
  assert.deepEqual(createSettings('codex', { profile: 'deepseek-pro' }), { profile: 'deepseek-pro' });
  assert.deepEqual(createSettings('codex', { profile: 'deepseek-flash', effort: 'xhigh' }), { effort: 'xhigh', profile: 'deepseek-flash' });
  for (const [provider, settings] of [['claude', { profile: 'deepseek-pro' }], ['codex', { profile: '../deepseek-pro' }], ['codex', { profile: '' }], ['codex', { profile: 5 }]]) {
    assert.throws(() => createSettings(provider, settings), /无效|invalid/i, JSON.stringify([provider, settings]));
  }
});

function codexHost(calls, modelProvider = 'deepseek', onCall = null) {
  return {
    binaries: { codex: 'codex-binary' },
    codexTargets: new Map(),
    codexProcess: { pid: 4321 },
    startCodex: async () => {},
    createCodex: fn => fn(),
    rpc: {
      call: async (method, params) => {
        calls.push({ method, params });
        if (onCall) return onCall(method, params);
        return { thread: { id: 'synthetic-thread', sessionId: 'synthetic-session', turns: [], modelProvider }, model: params.config?.model || params.model || 'gpt-6-astra', modelProvider, reasoningEffort: null };
      },
    },
  };
}

test('a chat session from a profile starts its thread with the profile as configuration and reports its vendor', async t => {
  codexHome(t, { 'deepseek-pro': PROFILE });
  const calls = [];
  const runtime = new Codex({ id: 'synthetic', cwd: '/tmp', provider: 'codex', view: 'chat', messages: [], requestedSettings: { profile: 'deepseek-pro', effort: 'xhigh' } }, codexHost(calls));
  const vendors = [];
  runtime.on('modelProvider', value => vendors.push(value));
  await runtime.start();
  assert.equal(calls[0].method, 'thread/start');
  assert.deepEqual(calls[0].params.config, { ...EXPECTED, model_reasoning_effort: 'xhigh' }, 'an effort asked for replaces the profile\'s');
  assert.equal('model' in calls[0].params, false);
  assert.equal('modelProvider' in calls[0].params, false, 'the vendor comes from the profile configuration only');
  assert.deepEqual(vendors, ['deepseek']);
  const modelCalls = [];
  await new Codex({ id: 'm', cwd: '/tmp', provider: 'codex', view: 'chat', messages: [], requestedSettings: { profile: 'deepseek-pro', model: 'deepseek-v4-flash' } }, codexHost(modelCalls)).start();
  assert.equal(modelCalls[0].params.config.model, 'deepseek-v4-flash', 'a model asked for replaces the profile\'s');
  assert.equal(modelCalls[0].params.config.model_reasoning_effort, 'high');
});

test('a terminal session from a profile passes each profile setting to the native terminal', async t => {
  codexHome(t, { 'deepseek-pro': PROFILE });
  const host = codexHost([]);
  const runtime = new Codex({ id: 'synthetic', cwd: '/tmp', provider: 'codex', view: 'terminal', messages: [], requestedSettings: { profile: 'deepseek-pro' } }, host);
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
  const vendors = [];
  runtime.on('modelProvider', value => vendors.push(value));
  const started = runtime.startFromTerminal();
  await new Promise(resolve => setImmediate(resolve));
  host.pendingCodex({ id: 'synthetic-thread', sessionId: 'synthetic-session', model: 'deepseek-v4-pro', modelProvider: 'deepseek' }, 'deepseek-v4-pro');
  await started;
  const options = argv.slice(0, argv.indexOf('--remote'));
  const overrides = [];
  for (let index = 0; index < options.length; index += 1) if (options[index] === '-c') overrides.push(options[index + 1]);
  assert.deepEqual(overrides, [
    'analytics.enabled=false',
    'check_for_update_on_startup=false',
    'notice.hide_rate_limit_model_nudge=true',
    'model="deepseek-v4-pro"',
    'model_provider="deepseek"',
    'model_catalog_json="/tmp/synthetic-catalog/models.json"',
    'model_reasoning_effort="high"',
    'model_context_window=950000',
  ]);
  assert.equal(options.includes('-a'), false);
  assert.deepEqual(vendors, ['deepseek']);
});

async function recoveredResume(requestedSettings) {
  const calls = [];
  let runtime;
  const host = codexHost(calls, 'deepseek', (method, params) => {
    runtime.stopped = true;
    return { thread: { id: params.threadId, sessionId: 'synthetic-session', modelProvider: 'deepseek' } };
  });
  runtime = new Codex({ id: 'synthetic', nativeId: 'synthetic-thread', cwd: '/tmp', provider: 'codex', view: 'chat', recovering: true, messages: [], ...(requestedSettings ? { requestedSettings } : {}) }, host);
  await runtime.start();
  assert.equal(calls[0].method, 'thread/resume');
  return calls[0].params;
}

test('a profile session resumed after its service restarted gets its model catalog again', async t => {
  codexHome(t, { 'deepseek-pro': PROFILE, broken: 'model = [1]\n' });
  assert.deepEqual((await recoveredResume({ profile: 'deepseek-pro', effort: 'xhigh' })).config, { model_catalog_json: '/tmp/synthetic-catalog/models.json' },
    'only the catalog: the thread keeps its provider, model and effort natively');
  assert.equal('config' in await recoveredResume({ model: 'gpt-6.1-sol' }), false);
  assert.equal('config' in await recoveredResume(null), false);
  assert.equal('config' in await recoveredResume({ profile: 'broken' }), false, 'an unreadable profile resumes the thread as Codex has it');
});

test('each session names its model vendor and shell; a DeepSeek session shows no OpenAI account limits', () => {
  assert.deepEqual(sessionMaker({ provider: 'claude' }), { vendor: 'anthropic', shell: 'claude' });
  assert.deepEqual(sessionMaker({ provider: 'codex', modelProvider: 'deepseek' }), { vendor: 'deepseek', shell: 'codex' });
  assert.deepEqual(sessionMaker({ provider: 'codex', modelProvider: 'openai' }), { vendor: 'openai', shell: 'codex' });
  assert.deepEqual(sessionMaker({ provider: 'codex' }), { vendor: null, shell: 'codex' }, 'unknown until Codex reports it');
  const account = { primary: { usedPercent: 10 } };
  const runtime = { host: { codexAccountUsage: account } };
  const usageFor = s => Workspace.prototype.usageFor.call({ runtimes: new Map([[s.id, runtime]]) }, s);
  const tokens = { total: { totalTokens: 18 } };
  assert.deepEqual(usageFor({ id: 'o', provider: 'codex', modelProvider: 'openai', usage: tokens }), { ...tokens, account });
  assert.deepEqual(usageFor({ id: 'u', provider: 'codex', usage: tokens }), { ...tokens, account }, 'a session whose vendor is not known yet keeps today\'s view');
  assert.deepEqual(usageFor({ id: 'd', provider: 'codex', modelProvider: 'deepseek', usage: tokens }), tokens);
  assert.equal(usageFor({ id: 'e', provider: 'codex', modelProvider: 'deepseek', usage: null }), null);
});

test('the new-session dialog lists only profiles on another vendor, by name, with no other settings', t => {
  codexHome(t, {
    'deepseek-pro': PROFILE,
    'deepseek-flash': 'model = "deepseek-v4-flash"\nmodel_provider = "deepseek"\n',
    'plain-openai': 'model = "gpt-6-luna"\nmodel_provider = "openai"\n',
    'no-vendor': 'model = "deepseek-v4-pro"\n',
    'unreadable': 'model = """multi"""\nmodel_provider = "deepseek"\n',
    'bad name!': 'model = "x"\nmodel_provider = "deepseek"\n',
  });
  assert.deepEqual(listCodexProfiles(), [
    { name: 'deepseek-flash', model: 'deepseek-v4-flash', modelProvider: 'deepseek' },
    { name: 'deepseek-pro', model: 'deepseek-v4-pro', modelProvider: 'deepseek' },
  ]);
  assert.deepEqual(listCodexProfiles({ CODEX_HOME: path.join(os.tmpdir(), 'naw-codex-profile-absent-' + process.pid) }), []);
});
