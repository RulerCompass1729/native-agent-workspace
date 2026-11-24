'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');

const { AgyTui, launchSpec, validConversationId } = require('../agy-tui.cjs');
const { NativeHost } = require('../adapters.cjs');
const { Workspace } = require('../workspace.cjs');
const { nativeEnvironment, pythonExecutable } = require('../platform.cjs');
const operation = require('../background-operation.cjs');

class SyntheticTerminal extends EventEmitter {
  constructor(argv, cwd, env) {
    super();
    this.argv = argv;
    this.cwd = cwd;
    this.env = env;
    this.alive = true;
    this.pid = null;
    this.writes = [];
    this.journal = { epoch: randomUUID(), index: 0 };
  }
  input(data) { this.writes.push(data); }
  resize() {}
  async stop() {
    this.alive = false;
    this.emit('closed', { confirmed: true });
  }
}

test('launchSpec keeps default model and effort, honors skipPermissions and UUID resume', () => {
  const id = randomUUID();
  const fresh = launchSpec({
    record: { skipPermissions: true, nativeId: `naw-agy:${id}` },
    binary: '/synthetic/bin/agy',
    hookToken: 'tok-1',
    hookSocket: '/tmp/synthetic.sock',
  });
  assert.deepEqual(fresh.argv, ['/synthetic/bin/agy', '--dangerously-skip-permissions']);
  assert.deepEqual(fresh.env, { NAW_HOOK_TOKEN: 'tok-1', NAW_HOOK_SOCKET: '/tmp/synthetic.sock' });

  const resumed = launchSpec({
    record: { recovering: true, nativeId: id, skipPermissions: true },
    binary: '/synthetic/bin/agy',
  });
  assert.deepEqual(resumed.argv, ['/synthetic/bin/agy', '--conversation', id, '--dangerously-skip-permissions']);
  assert.deepEqual(resumed.env, {});

  const nonUuidResume = launchSpec({
    record: { recovering: true, nativeId: `naw-agy:${id}` },
    binary: '/synthetic/bin/agy',
  });
  assert.deepEqual(nonUuidResume.argv, ['/synthetic/bin/agy']);

  assert.throws(() => launchSpec({ record: {}, binary: 'agy' }), e => e.uiMessage?.key === 'error.nativeRuntimeMissing');
});

test('Workspace creates agy as terminal-only, binds hook lifecycle and resumes real conversationId', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-agy-tui-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const launched = [];
  const hookTargets = new Map();
  const host = {
    binaries: { agy: '/synthetic/bin/agy', python: '/synthetic/bin/python3' },
    hookSocket: '/tmp/synthetic-hooks.sock',
    hookTargets,
    create(record) {
      const runtime = new AgyTui(record, host, {
        Terminal: class extends SyntheticTerminal {
          constructor(argv, cwd, env) {
            super(argv, cwd, env);
            launched.push({ runtime, terminal: this });
          }
        },
      });
      return runtime;
    },
    close() {},
  };
  const ws = new Workspace(host, dir);
  t.after(async () => { await ws.close(); });

  const sessionId = await ws.create('agy', dir, 'owner-1', '', 'chat', { skipPermissions: true });
  const record = ws.get(sessionId);
  assert.equal(record.provider, 'agy');
  assert.equal(record.view, 'terminal');
  assert.equal(record.name, 'Antigravity 1');
  assert.equal(record.skipPermissions, true);
  assert.equal(launched.length, 1);
  assert.deepEqual(launched[0].terminal.argv, ['/synthetic/bin/agy', '--dangerously-skip-permissions']);

  const first = launched[0];
  assert.equal(first.runtime.chatAvailable, false);
  assert.equal(hookTargets.get(first.runtime.token), first.runtime);

  first.terminal.emit('started', 42420);
  assert.equal(record.state, 'idle');
  assert.match(record.nativeId, /^naw-agy:/);

  const realId = randomUUID();
  first.runtime.hook({ hookEventName: 'SessionStart', conversationId: realId, modelName: 'Gemini 4 Neon (High)' });
  assert.equal(record.nativeId, realId);
  assert.equal(record.model, 'Gemini 4 Neon (High)');

  first.runtime.hook({ hookEventName: 'PreInvocation', conversationId: realId });
  assert.equal(record.state, 'working');

  first.runtime.hook({ hookEventName: 'Stop', conversationId: realId, terminationReason: 'NO_TOOL_CALL', fullyIdle: false });
  assert.equal(record.state, 'working', 'background work still running keeps session working');

  first.runtime.hook({ hookEventName: 'Stop', conversationId: realId, terminationReason: 'NO_TOOL_CALL', fullyIdle: true });
  assert.equal(record.state, 'idle');

  first.runtime.hook({ hookEventName: 'Stop', conversationId: realId, terminationReason: 'ERROR', fullyIdle: true });
  assert.equal(record.state, 'error');

  await first.terminal.stop();
  assert.equal(record.state, 'ended');
  assert.equal(record.nativeId, realId, 'real Antigravity conversationId survives exit for resume');
  assert.equal(hookTargets.has(first.runtime.token), false);

  ws.persist();
  const reloaded = new Workspace(host, dir);
  t.after(async () => { await reloaded.close(); });
  assert.equal(reloaded.get(sessionId).nativeId, realId);

  await reloaded.resume(sessionId, 'owner-1');
  assert.equal(launched.length, 2);
  assert.deepEqual(launched[1].terminal.argv, ['/synthetic/bin/agy', '--conversation', realId, '--dangerously-skip-permissions']);
});

test('unhooked agy session clears temporary identity on exit and reload', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-agy-temp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let active;
  const host = {
    binaries: { agy: '/synthetic/bin/agy', python: '/synthetic/bin/python3' },
    hookTargets: new Map(),
    create(record) {
      return new AgyTui(record, host, {
        Terminal: class extends SyntheticTerminal {
          constructor(argv, cwd, env) { super(argv, cwd, env); active = this; }
        },
      });
    },
    close() {},
  };
  const ws = new Workspace(host, dir);
  t.after(async () => { await ws.close(); });
  const id = await ws.create('agy', dir, 'owner-1');
  active.emit('started', 52520);
  assert.match(ws.get(id).nativeId, /^naw-agy:/);
  assert.equal(validConversationId(ws.get(id).nativeId), false);
  ws.persist();

  const reloaded = new Workspace(host, dir);
  t.after(async () => { await reloaded.close(); });
  assert.equal(reloaded.get(id).nativeId, null);
  assert.equal(reloaded.get(id).state, 'ended');

  await active.stop();
  assert.equal(ws.get(id).nativeId, null);
});

test('NativeHost refuses agy creation cleanly when binary is missing', () => {
  const native = Object.assign(Object.create(NativeHost.prototype), {
    dataDir: '/synthetic/backend',
    serviceBinding: null,
    binaries: { python: '/synthetic/python' },
    resolvePrograms() { return this.binaries; },
    createAgy() { throw Error('should not construct'); },
  });
  assert.throws(() => native.create({ id: 's1', provider: 'agy' }), e => e.uiMessage?.key === 'error.nativeRuntimeMissing');
});

test('nativeEnvironment strips launcher Antigravity session variables', () => {
  const keys = ['ANTIGRAVITY_CONVERSATION_ID', 'ANTIGRAVITY_LS_ADDRESS', 'ANTIGRAVITY_CSRF_TOKEN', 'ANTIGRAVITY_PROJECT_ID'];
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  for (const k of keys) process.env[k] = 'synthetic-' + k;
  try {
    const env = nativeEnvironment();
    for (const k of keys) assert.equal(env[k], undefined, k);
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test('background-operation summarizes agy create as terminal-only', () => {
  const summary = operation.operationSummary({
    method: 'create',
    arguments: [{ provider: 'agy', cwd: '/tmp/work', name: 'Agy 1', view: 'chat', skipPermissions: true }],
  });
  assert.equal(summary.provider, 'agy');
  assert.ok(summary.risks.includes('skipPermissions'));
  const sameView = operation.operationSummary({
    method: 'create',
    arguments: [{ provider: 'agy', cwd: '/tmp/work', name: 'Agy 2', view: 'terminal', skipPermissions: true }],
  });
  assert.equal(summary.createKey, sameView.createKey);
});

test('agy_hook.py is a no-op outside NAW and forwards only metadata inside NAW', async t => {
  const python = pythonExecutable();
  assert.ok(python, 'python3 required');
  const script = path.join(__dirname, '../agy_hook.py');
  const envClean = { ...process.env };
  delete envClean.NAW_HOOK_TOKEN;
  delete envClean.NAW_HOOK_SOCKET;
  const noop = execFileSync(python, [script], { input: '{"hookEventName":"SessionStart"}', encoding: 'utf8', env: envClean });
  assert.deepEqual(JSON.parse(noop), {});

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-agy-hook-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sock = path.join(dir, 'hooks.sock');
  const received = [];
  const server = net.createServer(conn => {
    let buf = '';
    conn.setEncoding('utf8');
    conn.on('data', chunk => { buf += chunk; });
    conn.on('end', () => { received.push(JSON.parse(buf)); });
  });
  await new Promise(resolve => server.listen(sock, resolve));
  t.after(() => server.close());

  const convId = randomUUID();
  const payload = JSON.stringify({
    hookEventName: 'Stop',
    conversationId: convId,
    modelName: 'Gemini 4 Neon (High)',
    terminationReason: 'ERROR',
    fullyIdle: true,
    stepIdx: 7,
    error: 'private error body',
    lastUserInput: 'SECRET_PROMPT_BODY',
    toolCall: { name: 'run_command', args: { CommandLine: 'SECRET_CMD' } },
  });
  const out = execFileSync(python, [script], {
    input: payload,
    encoding: 'utf8',
    env: { ...envClean, NAW_HOOK_TOKEN: 'hook-secret', NAW_HOOK_SOCKET: sock },
  });
  assert.deepEqual(JSON.parse(out), {});
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(received.length, 1);
  assert.deepEqual(received[0], {
    hookEventName: 'Stop',
    conversationId: convId,
    modelName: 'Gemini 4 Neon (High)',
    terminationReason: 'ERROR',
    fullyIdle: true,
    stepIdx: 7,
    hasError: true,
    token: 'hook-secret',
  });
  assert.doesNotMatch(JSON.stringify(received[0]), /SECRET_PROMPT_BODY|SECRET_CMD|private error body/);
});
