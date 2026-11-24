'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');

const { AgyTui, launchSpec, prepareBridge, readFinalReply, validConversationId } = require('../agy-tui.cjs');
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

test('launchSpec keeps default model and effort, honors bridgeDir, skipPermissions and UUID resume', () => {
  const id = randomUUID();
  const fresh = launchSpec({
    record: { skipPermissions: true, nativeId: `naw-agy:${id}` },
    binary: '/synthetic/bin/agy',
    bridgeDir: '/tmp/synthetic-bridge',
    hookToken: 'tok-1',
    hookSocket: '/tmp/synthetic.sock',
  });
  assert.deepEqual(fresh.argv, ['/synthetic/bin/agy', '--add-dir', '/tmp/synthetic-bridge', '--dangerously-skip-permissions']);
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

test('prepareBridge writes per-session plugin files and readFinalReply respects minStep', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-agy-bridge-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bridgeDir = prepareBridge({
    privateDir: dir,
    sessionId: 'sess-1',
    token: 'tok-abc',
    hookSocket: '/tmp/hooks.sock',
    pythonBinary: '/usr/bin/python3',
    execPath: '/usr/local/bin/node',
    appDir: path.resolve(__dirname, '..'),
  });
  const pluginDir = path.join(bridgeDir, '.agents', 'plugins', 'naw');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(pluginDir, 'plugin.json'), 'utf8')), { name: 'naw' });
  const hooks = JSON.parse(fs.readFileSync(path.join(pluginDir, 'hooks.json'), 'utf8'));
  assert.deepEqual(Object.keys(hooks['naw-lifecycle']), ['SessionStart', 'PreInvocation', 'PostInvocation', 'Stop']);
  const mcp = JSON.parse(fs.readFileSync(path.join(pluginDir, 'mcp_config.json'), 'utf8'));
  assert.equal(mcp.mcpServers.workspace.env.NAW_MESSAGE_TOKEN, 'tok-abc');
  assert.ok(mcp.mcpServers.workspace.args.includes('--agy'));

  const transcript = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(transcript, [
    JSON.stringify({ type: 'PLANNER_RESPONSE', step_index: 3, content: 'old turn reply' }),
    JSON.stringify({ type: 'PLANNER_RESPONSE', step_index: 10, content: 'calling tool', tool_calls: [{ name: 'read_file' }] }),
    JSON.stringify({ type: 'PLANNER_RESPONSE', step_index: 12, content: 'done\nREADY lane/test 1234567' }),
  ].join('\n') + '\n');
  assert.equal(readFinalReply(transcript, 10), 'done\nREADY lane/test 1234567');
  assert.equal(readFinalReply(transcript, 13), '', 'never returns an earlier turn reply');
});

test('Workspace creates agy as terminal-only, delivers send() via PTY+hooks, records READY reply and resumes', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-agy-tui-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const privateDir = path.join(dir, 'private');
  fs.mkdirSync(privateDir, { mode: 0o700 });
  const launched = [];
  const hookTargets = new Map();
  const host = {
    privateDir,
    binaries: { agy: '/synthetic/bin/agy', python: '/synthetic/bin/python3' },
    hookSocket: path.join(privateDir, 'hooks.sock'),
    hookTargets,
    create(record) {
      return new AgyTui(record, host, {
        enterDelayMs: 0,
        sendTimeoutMs: 500,
        Terminal: class extends SyntheticTerminal {
          constructor(argv, cwd, env) {
            super(argv, cwd, env);
            launched.push({ runtime: null, terminal: this });
          }
        },
      });
    },
    close() {},
  };
  const origCreate = host.create;
  host.create = record => {
    const rt = origCreate(record);
    const prevStart = rt.start.bind(rt);
    rt.start = async () => {
      await prevStart();
      launched[launched.length - 1].runtime = rt;
    };
    return rt;
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

  const first = launched[0];
  assert.ok(first.runtime.bridgeDir && fs.existsSync(first.runtime.bridgeDir));
  assert.ok(first.terminal.argv.includes('--add-dir'));
  assert.ok(first.terminal.argv.includes('--dangerously-skip-permissions'));
  assert.equal(hookTargets.get(first.runtime.token), first.runtime);

  first.terminal.emit('started', 42420);
  assert.equal(record.state, 'idle');
  assert.equal(first.runtime.chatAvailable, true);
  assert.equal(first.runtime.addressedSendAvailable, true);
  assert.match(record.nativeId, /^naw-agy:/);

  const realId = randomUUID();
  first.runtime.hook({ hookEventName: 'SessionStart', conversationId: realId, modelName: 'Gemini 4 Neon (High)' });
  assert.equal(record.nativeId, realId);
  assert.equal(record.model, 'Gemini 4 Neon (High)');

  const transcript = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ type: 'PLANNER_RESPONSE', step_index: 2, content: 'stale' }) + '\n');

  const sendPromise = ws.send(sessionId, 'Run task now', 'owner-1');
  assert.equal(first.terminal.writes[0], '\x1b[200~Run task now\x1b[201~');
  assert.equal(first.terminal.writes[1], '\r');

  first.runtime.hook({ hookEventName: 'PreInvocation', conversationId: realId, invocationNum: 1, initialNumSteps: 5, transcriptPath: transcript });
  await sendPromise;
  assert.equal(record.state, 'working');
  const turnId = first.runtime.turnId;
  assert.ok(turnId);

  // Second model invocation inside the same turn preserves the exact same turnId.
  first.runtime.hook({ hookEventName: 'PreInvocation', conversationId: realId, invocationNum: 2, initialNumSteps: 7, transcriptPath: transcript });
  assert.equal(first.runtime.turnId, turnId);

  // Background task still running keeps session working.
  first.runtime.hook({ hookEventName: 'Stop', conversationId: realId, terminationReason: 'NO_TOOL_CALL', fullyIdle: false, transcriptPath: transcript });
  assert.equal(record.state, 'working');
  assert.equal(first.runtime.turnId, turnId);

  fs.appendFileSync(transcript, JSON.stringify({ type: 'PLANNER_RESPONSE', step_index: 8, content: 'All checks pass.\nREADY lane/agy-demo 89abcdef' }) + '\n');
  first.runtime.hook({ hookEventName: 'Stop', conversationId: realId, terminationReason: 'NO_TOOL_CALL', fullyIdle: true, transcriptPath: transcript });
  assert.equal(record.state, 'idle');
  assert.equal(first.runtime.turnId, null);
  const assistant = record.messages.find(m => m.role === 'assistant');
  assert.ok(assistant);
  assert.match(assistant.text, /READY lane\/agy-demo 89abcdef/);
  assert.equal(assistant.nativeId, realId);
  assert.equal(assistant.turnId, turnId);

  // Error stop transitions to error.
  first.runtime.hook({ hookEventName: 'PreInvocation', conversationId: realId, invocationNum: 1, initialNumSteps: 9 });
  first.runtime.hook({ hookEventName: 'Stop', conversationId: realId, terminationReason: 'ERROR', fullyIdle: true });
  assert.equal(record.state, 'error');

  const bridgeBeforeStop = first.runtime.bridgeDir;
  await first.terminal.stop();
  assert.equal(record.state, 'ended');
  assert.equal(record.nativeId, realId, 'real Antigravity conversationId survives exit for resume');
  assert.equal(hookTargets.has(first.runtime.token), false);
  assert.equal(fs.existsSync(bridgeBeforeStop), false, 'per-session bridge directory is cleaned up on exit');

  ws.persist();
  const reloaded = new Workspace(host, dir);
  t.after(async () => { await reloaded.close(); });
  assert.equal(reloaded.get(sessionId).nativeId, realId);

  await reloaded.resume(sessionId, 'owner-1');
  assert.equal(launched.length, 2);
  assert.ok(launched[1].terminal.argv.includes('--conversation'));
  assert.ok(launched[1].terminal.argv.includes(realId));
  assert.ok(launched[1].terminal.argv.includes('--dangerously-skip-permissions'));
});

test('send() rejects cleanly when PreInvocation never confirms or guard expires', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-agy-timeout-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const term = new SyntheticTerminal(['/bin/agy'], dir, {});
  const rt = new AgyTui({ id: 's1', provider: 'agy', cwd: dir }, { hookSocket: '/tmp/h.sock', hookTargets: new Map() }, { sendTimeoutMs: 40, enterDelayMs: 0 });
  rt.attach(term);
  term.emit('started', 12345);
  await assert.rejects(rt.send('hello', 'tag-1', () => false), e => e.uiMessage?.key === 'error.workspace.handoffExpired');
  assert.equal(term.writes.length, 0);
  await assert.rejects(rt.send('esc \x1b[31mtest', 'tag-2', () => true), e => e.uiMessage?.key === 'error.nativeSendUnavailable');
  assert.equal(term.writes[0], '\x1b[200~esc [31mtest\x1b[201~', 'ESC is stripped before bracketed paste');
  assert.equal(term.writes[1], '\r');
});

test('real NativeHost + claude-message-tool.cjs --agy authenticates per-session token and stages workspace_message', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-agy-mcp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const privateDir = path.join(dir, 'priv');
  fs.mkdirSync(privateDir, { mode: 0o700 });
  const host = new NativeHost(privateDir, dir);
  await new Promise((resolve, reject) => { host.hooks.once('error', reject); host.hooks.listen(host.hookSocket, resolve); });
  t.after(() => { host.hooks.close(); host.submissions.server.close(); });

  const realId = randomUUID();
  const term = new SyntheticTerminal(['/synthetic/bin/agy'], dir, {});
  const record = { id: 'agy-sender', provider: 'agy', cwd: dir, nativeId: realId, state: 'working' };
  const rt = new AgyTui(record, host, { Terminal: SyntheticTerminal });
  rt.bridgeDir = privateDir;
  host.hookTargets.set(rt.token, rt);
  rt.attach(term);
  term.emit('started', 33333);

  const calls = [];
  rt.addressedCall = async (identity, args) => {
    calls.push({ nativeId: identity.nativeId, turnId: identity.turnId, valid: identity.valid(), args });
    return { status: 'staged', id: 'wake-1', message: 'staged' };
  };

  const rpcCall = async (token, method, params) => {
    const child = spawn(process.execPath, [path.join(__dirname, '../claude-message-tool.cjs'), '--agy'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NAW_MESSAGE_SOCKET: host.hookSocket, NAW_MESSAGE_TOKEN: token },
    });
    try {
      const responses = [];
      let buf = '';
      child.stdout.setEncoding('utf8');
      const waitResp = id => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('MCP timeout')), 5000);
        const onData = chunk => {
          buf += chunk;
          for (let at; (at = buf.indexOf('\n')) >= 0;) {
            const line = buf.slice(0, at); buf = buf.slice(at + 1);
            if (!line.trim()) continue;
            const msg = JSON.parse(line);
            responses.push(msg);
            if (msg.id === id) { clearTimeout(timer); child.stdout.off('data', onData); resolve(msg); return; }
          }
        };
        child.stdout.on('data', onData);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
      await waitResp(1);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method, params }) + '\n');
      return await waitResp(2);
    } finally {
      child.kill('SIGTERM');
    }
  };

  const listed = await rpcCall(rt.token, 'tools/list', {});
  assert.deepEqual(listed.result.tools.map(tool => tool.name), ['workspace_message']);

  // Idle session (no live turn) must be refused.
  const idleRefusal = await rpcCall(rt.token, 'tools/call', { name: 'workspace_message', arguments: { recipient_id: 'peer-1', message: 'hi' } });
  assert.equal(idleRefusal.result.isError, true);
  assert.equal(calls.length, 0);

  // Start a turn, then wrong token must still be refused.
  rt.hook({ hookEventName: 'PreInvocation', conversationId: realId, invocationNum: 1, initialNumSteps: 1 });
  const badToken = await rpcCall('wrong-token', 'tools/call', { name: 'workspace_message', arguments: { recipient_id: 'peer-1', message: 'hi' } });
  assert.equal(badToken.result.isError, true);
  assert.equal(calls.length, 0);

  // Valid per-session token during live turn stages with authoritative runtime identity.
  const ok = await rpcCall(rt.token, 'tools/call', { name: 'workspace_message', arguments: { recipient_id: 'peer-1', message: 'hello peer' } });
  assert.equal(ok.result.isError, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].nativeId, realId);
  assert.equal(calls[0].turnId, rt.turnId);
  assert.equal(calls[0].valid, true);
  assert.deepEqual(calls[0].args, { recipient_id: 'peer-1', message: 'hello peer' });
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
    invocationNum: 2,
    initialNumSteps: 5,
    transcriptPath: '/tmp/synthetic-transcript.jsonl',
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
    invocationNum: 2,
    initialNumSteps: 5,
    transcriptPath: '/tmp/synthetic-transcript.jsonl',
    hasError: true,
    token: 'hook-secret',
  });
  assert.doesNotMatch(JSON.stringify(received[0]), /SECRET_PROMPT_BODY|SECRET_CMD|private error body/);
});
