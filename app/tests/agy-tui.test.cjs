'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { createHash, randomUUID } = require('node:crypto');

const { AgyTui, editorState, launchSpec, prepareBridge, resolveSessionTranscript, readFinalReply, validConversationId } = require('../agy-tui.cjs');
const { Terminal: HeadlessTerminal } = require('@xterm/headless');
const { NativeHost } = require('../adapters.cjs');
const { Workspace } = require('../workspace.cjs');
const { nativeEnvironment, pythonExecutable } = require('../platform.cjs');
const operation = require('../background-operation.cjs');

const sha256 = v => createHash('sha256').update(String(v), 'utf8').digest('hex');

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

test('prepareBridge writes separate MCP token + PreToolUse/PostToolUse matchers; transcript checks bind realpath to session', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-agy-bridge-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bridgeDir = prepareBridge({
    privateDir: dir,
    sessionId: 'sess-1',
    mcpToken: 'mcp-tok-abc',
    hookSocket: '/tmp/hooks.sock',
    pythonBinary: '/usr/bin/python3',
    execPath: '/usr/local/bin/node',
    appDir: path.resolve(__dirname, '..'),
  });
  const pluginDir = path.join(bridgeDir, '.agents', 'plugins', 'naw');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(pluginDir, 'plugin.json'), 'utf8')), { name: 'naw' });
  const hooks = JSON.parse(fs.readFileSync(path.join(pluginDir, 'hooks.json'), 'utf8'));
  assert.deepEqual(Object.keys(hooks['naw-lifecycle']), ['SessionStart', 'PreInvocation', 'PostInvocation', 'PreToolUse', 'PostToolUse', 'Stop']);
  assert.equal(hooks['naw-lifecycle'].PreToolUse[0].matcher, '^.*workspace_message$');
  assert.equal(hooks['naw-lifecycle'].PostToolUse[0].matcher, '^.*workspace_message$');
  const mcp = JSON.parse(fs.readFileSync(path.join(pluginDir, 'mcp_config.json'), 'utf8'));
  assert.equal(mcp.mcpServers.workspace.env.NAW_MESSAGE_TOKEN, 'mcp-tok-abc');
  assert.ok(mcp.mcpServers.workspace.args.includes('--agy'));

  // Transcript must resolve inside brainRoot/<nativeId>/ and end with transcript.jsonl; symlinks to other sessions fail.
  const brainRoot = path.join(dir, 'brain');
  const ownId = randomUUID(), otherId = randomUUID();
  const ownLogs = path.join(brainRoot, ownId, '.system_generated', 'logs');
  const otherLogs = path.join(brainRoot, otherId, '.system_generated', 'logs');
  fs.mkdirSync(ownLogs, { recursive: true });
  fs.mkdirSync(otherLogs, { recursive: true });
  const ownTranscript = path.join(ownLogs, 'transcript.jsonl');
  const otherTranscript = path.join(otherLogs, 'transcript.jsonl');
  fs.writeFileSync(ownTranscript, [
    JSON.stringify({ type: 'PLANNER_RESPONSE', step_index: 3, content: 'old turn reply' }),
    JSON.stringify({ type: 'PLANNER_RESPONSE', step_index: 10, content: 'calling tool', tool_calls: [{ name: 'read_file' }] }),
    JSON.stringify({ type: 'PLANNER_RESPONSE', step_index: 12, content: 'done\nREADY lane/test 1234567' }),
  ].join('\n') + '\n');
  fs.writeFileSync(otherTranscript, JSON.stringify({ type: 'PLANNER_RESPONSE', step_index: 12, content: 'OTHER SESSION SECRET' }) + '\n');

  // Symlinked parent directory escaping to another conversation must be rejected.
  const evilParent = path.join(brainRoot, ownId, 'evil-link');
  fs.symlinkSync(otherLogs, evilParent);
  const escapedPath = path.join(evilParent, 'transcript.jsonl');

  assert.ok(resolveSessionTranscript(ownTranscript, ownId, brainRoot));
  assert.equal(resolveSessionTranscript(otherTranscript, ownId, brainRoot), null);
  assert.equal(resolveSessionTranscript(escapedPath, ownId, brainRoot), null);
  assert.equal(readFinalReply(ownTranscript, 10, ownId, brainRoot), 'done\nREADY lane/test 1234567');
  assert.equal(readFinalReply(ownTranscript, 13, ownId, brainRoot), '', 'never returns an earlier turn reply');
  assert.equal(readFinalReply(otherTranscript, 0, ownId, brainRoot), '', 'never reads another session transcript');
  assert.equal(readFinalReply(escapedPath, 0, ownId, brainRoot), '', 'never follows symlinked parent to another session');
});

test('Workspace creates agy as terminal-only, enforces claim=terminal, delivers atomic send() after readiness, guards Stop/transcripts, and resumes', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-agy-tui-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const privateDir = path.join(dir, 'private');
  const brainRoot = path.join(dir, 'brain');
  fs.mkdirSync(privateDir, { mode: 0o700 });
  fs.mkdirSync(brainRoot, { mode: 0o700 });
  const launched = [];
  const hookTargets = new Map();
  const agyMcpTargets = new Map();
  const host = {
    privateDir,
    binaries: { agy: '/synthetic/bin/agy', python: '/synthetic/bin/python3' },
    hookSocket: path.join(privateDir, 'hooks.sock'),
    hookTargets,
    agyMcpTargets,
    create(record) {
      const rt = new AgyTui(record, host, {
        sendTimeoutMs: 500,
        humanInputQuietMs: 0,
        brainRoot,
        Terminal: class extends SyntheticTerminal {
          constructor(argv, cwd, env) {
            super(argv, cwd, env);
            launched.push({ runtime: null, terminal: this });
          }
        },
      });
      const prevStart = rt.start.bind(rt);
      rt.start = async () => {
        await prevStart();
        launched[launched.length - 1].runtime = rt;
      };
      return rt;
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

  // Finding 6: claim() enforces terminal-only after creation too.
  ws.claim(sessionId, 'owner-1', 'chat');
  assert.equal(record.view, 'terminal');

  const first = launched[0];
  assert.notEqual(first.runtime.token, first.runtime.mcpToken, 'hook and MCP tokens are separate');
  assert.equal(first.terminal.env.NAW_HOOK_TOKEN, first.runtime.token);
  assert.equal(first.terminal.env.NAW_MESSAGE_TOKEN, undefined, 'MCP token is never placed in child env');
  assert.equal(hookTargets.get(first.runtime.token), first.runtime);
  assert.equal(agyMcpTargets.get(first.runtime.mcpToken), first.runtime);

  // Finding 4: before prompt readiness, chatAvailable is false and send() refuses without writing.
  first.terminal.emit('started', 42420);
  assert.equal(record.state, 'idle');
  assert.equal(first.runtime.chatAvailable, false);
  await assert.rejects(first.runtime.send('too early', 'tag-early', () => true), e => e.notSent === true);
  assert.equal(first.terminal.writes.length, 0);

  // Trust prompt keeps chatAvailable false; ? for shortcuts marks prompt ready.
  first.terminal.emit('data', { data: 'Do you trust the contents of this project?' });
  assert.equal(first.runtime.chatAvailable, false);
  first.terminal.emit('data', { data: '? for shortcuts' });
  assert.equal(first.runtime.chatAvailable, true);
  assert.equal(first.runtime.addressedSendAvailable, true);

  // Finding 4: human native terminal typing sets terminalInputPending and blocks automated send() before writing any byte.
  ws.input(sessionId, 'human draft', 'owner-1');
  assert.equal(record.terminalInputPending, true);
  const writesBeforeBlocked = first.terminal.writes.length;
  await assert.rejects(first.runtime.send('auto task', 'tag-blocked', () => true), e => e.notSent === true);
  assert.equal(first.terminal.writes.length, writesBeforeBlocked, 'zero bytes written when human draft is pending');
  record.terminalInputPending = false;

  const realId = randomUUID();
  const otherId = randomUUID();
  const ownTranscript = path.join(brainRoot, realId, 'transcript.jsonl');
  const otherTranscript = path.join(brainRoot, otherId, 'transcript.jsonl');
  fs.mkdirSync(path.dirname(ownTranscript), { recursive: true });
  fs.mkdirSync(path.dirname(otherTranscript), { recursive: true });
  fs.writeFileSync(ownTranscript, JSON.stringify({ type: 'PLANNER_RESPONSE', step_index: 2, content: 'stale' }) + '\n');
  fs.writeFileSync(otherTranscript, JSON.stringify({ type: 'PLANNER_RESPONSE', step_index: 8, content: 'OTHER CONVO' }) + '\n');

  first.runtime.hook({ hookEventName: 'SessionStart', conversationId: realId, modelName: 'Gemini 4 Neon (High)' });
  assert.equal(record.nativeId, realId);
  assert.equal(record.model, 'Gemini 4 Neon (High)');

  // Atomic bracketed-paste + Enter single write.
  const sendPromise = ws.send(sessionId, 'Run task now', 'owner-1');
  assert.equal(first.terminal.writes.at(-1), '\x1b[200~Run task now\x1b[201~\r');

  first.runtime.hook({ hookEventName: 'PreInvocation', conversationId: realId, invocationNum: 1, initialNumSteps: 5, transcriptPath: ownTranscript });
  await sendPromise;
  assert.equal(record.state, 'working');
  const turnId = first.runtime.turnId;
  assert.ok(turnId);

  // Second model invocation inside same turn keeps the same turnId.
  first.runtime.hook({ hookEventName: 'PreInvocation', conversationId: realId, invocationNum: 2, initialNumSteps: 7, transcriptPath: ownTranscript });
  assert.equal(first.runtime.turnId, turnId);

  // NO_TOOL_CALL with fullyIdle: false keeps session working.
  first.runtime.hook({ hookEventName: 'Stop', conversationId: realId, terminationReason: 'NO_TOOL_CALL', fullyIdle: false, transcriptPath: ownTranscript });
  assert.equal(record.state, 'working');
  assert.equal(first.runtime.turnId, turnId);

  // Finding 3: Stop attempting to override transcriptPath with another conversation's transcript imports nothing.
  fs.appendFileSync(ownTranscript, JSON.stringify({ type: 'PLANNER_RESPONSE', step_index: 8, content: 'All checks pass.\nREADY lane/agy-demo 89abcdef' }) + '\n');
  first.runtime.hook({ hookEventName: 'Stop', conversationId: realId, terminationReason: 'NO_TOOL_CALL', fullyIdle: true, transcriptPath: otherTranscript });
  assert.equal(record.state, 'idle');
  assert.equal(record.messages.some(m => m.role === 'assistant' && m.text.includes('OTHER CONVO')), false);

  // Normal matching transcript succeeds and records READY reply.
  const send2 = ws.send(sessionId, 'Second task', 'owner-1');
  first.runtime.hook({ hookEventName: 'PreInvocation', conversationId: realId, invocationNum: 1, initialNumSteps: 8, transcriptPath: ownTranscript });
  await send2;
  first.runtime.hook({ hookEventName: 'Stop', conversationId: realId, terminationReason: 'NO_TOOL_CALL', fullyIdle: true, transcriptPath: ownTranscript });
  assert.equal(record.state, 'idle');
  const assistant = record.messages.find(m => m.role === 'assistant');
  assert.ok(assistant);
  assert.match(assistant.text, /READY lane\/agy-demo 89abcdef/);

  // Finding 5: USER_CANCELED with fullyIdle: false still closes the turn and never blocks future sends.
  const endStatuses = [];
  first.runtime.on('nativeTurnEnd', info => endStatuses.push(info.status));
  first.runtime.hook({ hookEventName: 'PreInvocation', conversationId: realId, invocationNum: 1, initialNumSteps: 9 });
  assert.ok(first.runtime.turnId);
  first.runtime.hook({ hookEventName: 'Stop', conversationId: realId, terminationReason: 'USER_CANCELED', fullyIdle: false });
  assert.equal(first.runtime.turnId, null);
  assert.equal(record.state, 'idle');
  assert.equal(endStatuses.at(-1), 'interrupted');

  // Finding 5: missing or unknown terminationReason never completes as success (emits incomplete, never releases staged wakes).
  first.runtime.hook({ hookEventName: 'PreInvocation', conversationId: realId, invocationNum: 1, initialNumSteps: 10 });
  first.runtime.hook({ hookEventName: 'Stop', conversationId: realId, terminationReason: 'MAX_INVOCATIONS', fullyIdle: true });
  assert.equal(first.runtime.turnId, null);
  assert.equal(endStatuses.at(-1), 'incomplete');

  first.runtime.hook({ hookEventName: 'PreInvocation', conversationId: realId, invocationNum: 1, initialNumSteps: 11 });
  first.runtime.hook({ hookEventName: 'Stop', conversationId: realId, fullyIdle: true });
  assert.equal(first.runtime.turnId, null);
  assert.equal(endStatuses.at(-1), 'incomplete');

  // Error stop transitions to error.
  first.runtime.hook({ hookEventName: 'PreInvocation', conversationId: realId, invocationNum: 1, initialNumSteps: 12 });
  first.runtime.hook({ hookEventName: 'Stop', conversationId: realId, terminationReason: 'ERROR', fullyIdle: true });
  assert.equal(record.state, 'error');
  assert.equal(endStatuses.at(-1), 'failed');

  const bridgeBeforeStop = first.runtime.bridgeDir;
  await first.terminal.stop();
  assert.equal(record.state, 'ended');
  assert.equal(record.nativeId, realId);
  assert.equal(hookTargets.has(first.runtime.token), false);
  assert.equal(agyMcpTargets.has(first.runtime.mcpToken), false);
  assert.equal(fs.existsSync(bridgeBeforeStop), false);

  ws.persist();
  const reloaded = new Workspace(host, dir);
  t.after(async () => { await reloaded.close(); });
  assert.equal(reloaded.get(sessionId).nativeId, realId);

  await reloaded.resume(sessionId, 'owner-1');
  assert.equal(launched.length, 2);
  assert.ok(launched[1].terminal.argv.includes('--conversation'));
  assert.ok(launched[1].terminal.argv.includes(realId));
});

test('send() rejects cleanly on expired guard, timeout and strips ESC atomically', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-agy-timeout-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const term = new SyntheticTerminal(['/bin/agy'], dir, {});
  const rt = new AgyTui({ id: 's1', provider: 'agy', cwd: dir }, { hookSocket: '/tmp/h.sock', hookTargets: new Map(), agyMcpTargets: new Map() }, { sendTimeoutMs: 40 });
  rt.attach(term);
  term.emit('started', 12345);
  term.emit('data', { data: '? for shortcuts' });
  await assert.rejects(rt.send('hello', 'tag-1', () => false), e => e.uiMessage?.key === 'error.workspace.handoffExpired');
  assert.equal(term.writes.length, 0);
  await assert.rejects(rt.send('esc \x1b[31mtest', 'tag-2', () => true), e => e.uiMessage?.key === 'error.nativeSendUnavailable');
  assert.equal(term.writes.length, 1, 'atomic single paste+Enter write');
  assert.equal(term.writes[0], '\x1b[200~esc [31mtest\x1b[201~\r');
});

test('Finding 2: real NativeHost + claude-message-tool.cjs --agy enforces separate mcpToken and PreToolUse call-origin proof', async t => {
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
  host.agyMcpTargets.set(rt.mcpToken, rt);
  rt.attach(term);
  term.emit('started', 33333);
  term.emit('data', { data: '? for shortcuts' });

  const calls = [];
  rt.addressedCall = async (identity, args) => {
    calls.push({ nativeId: identity.nativeId, turnId: identity.turnId, callId: identity.callId, valid: identity.valid(), args });
    return { status: 'staged', id: 'wake-1', message: 'staged' };
  };

  const rpcCall = async (token, method, params) => {
    const child = spawn(process.execPath, [path.join(__dirname, '../claude-message-tool.cjs'), '--agy'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NAW_MESSAGE_SOCKET: host.hookSocket, NAW_MESSAGE_TOKEN: token },
    });
    try {
      let buf = '';
      child.stdout.setEncoding('utf8');
      const waitResp = id => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('MCP timeout')), 6000);
        const onData = chunk => {
          buf += chunk;
          for (let at; (at = buf.indexOf('\n')) >= 0;) {
            const line = buf.slice(0, at); buf = buf.slice(at + 1);
            if (!line.trim()) continue;
            const msg = JSON.parse(line);
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

  const listed = await rpcCall(rt.mcpToken, 'tools/list', {});
  assert.deepEqual(listed.result.tools.map(tool => tool.name), ['workspace_message']);

  // Start a live turn.
  rt.hook({ hookEventName: 'PreInvocation', conversationId: realId, invocationNum: 1, initialNumSteps: 1 });

  // Shell hook token must NOT be accepted for MCP staging.
  const hookTokenRefusal = await rpcCall(rt.token, 'tools/call', { name: 'workspace_message', arguments: { recipient_id: 'peer-1', message: 'hello peer' } });
  assert.equal(hookTokenRefusal.result.isError, true);
  assert.equal(calls.length, 0);

  // Even with mcpToken, calling without a matching PreToolUse proof fails.
  const noProofRefusal = await rpcCall(rt.mcpToken, 'tools/call', { name: 'workspace_message', arguments: { recipient_id: 'peer-1', message: 'unproven' } });
  assert.equal(noProofRefusal.result.isError, true);
  assert.equal(calls.length, 0);

  // Register real native PreToolUse proof, then MCP call succeeds with that exact native callId.
  rt.hook({
    hookEventName: 'PreToolUse',
    conversationId: realId,
    toolCallId: 'toolu_agy_01',
    toolName: 'naw_workspace__workspace_message',
    recipientId: 'peer-1',
    messageHash: sha256('hello peer'),
  });
  const ok = await rpcCall(rt.mcpToken, 'tools/call', { name: 'workspace_message', arguments: { recipient_id: 'peer-1', message: 'hello peer' } });
  assert.equal(ok.result.isError, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].callId, 'toolu_agy_01');
  assert.equal(calls[0].nativeId, realId);
  assert.equal(calls[0].turnId, rt.turnId);
  assert.equal(calls[0].valid, true);

  // Replay of the same call without a new PreToolUse proof must be refused.
  const replay = await rpcCall(rt.mcpToken, 'tools/call', { name: 'workspace_message', arguments: { recipient_id: 'peer-1', message: 'hello peer' } });
  assert.equal(replay.result.isError, true);
  assert.equal(calls.length, 1);
});

test('Finding 1 (R2 #1): renderAgyProvider fallback to Claude clears auto-checked skipPermissions while preserving manual check', () => {
  const vm = require('node:vm');
  const text = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
  assert.match(text, /const agyTerminalOnly = s\?\.provider === 'agy';/);

  const mkEl = () => {
    const attrs = new Map();
    return {
      hidden: false,
      checked: false,
      setAttribute(k, v) { attrs.set(k, String(v)); },
      getAttribute(k) { return attrs.get(k) ?? null; },
      removeAttribute(k) { attrs.delete(k); },
    };
  };
  const els = { 'agy-provider': mkEl(), 'skip-permissions': mkEl() };
  const radios = {
    claude: Object.assign(mkEl(), { value: 'claude', checked: false }),
    agy: Object.assign(mkEl(), { value: 'agy', checked: true }),
  };
  const ctx = vm.createContext({
    state: { available: { agy: false } },
    $: id => els[id],
    document: {
      querySelector(sel) {
        if (sel === 'input[name="provider"]:checked') return Object.values(radios).find(r => r.checked) || null;
        if (sel === 'input[name="provider"][value="claude"]') return radios.claude;
        return null;
      },
    },
  });
  const fnStart = text.indexOf('function renderAgyProvider()');
  const fnEnd = text.indexOf('function chosenProvider()', fnStart);
  vm.runInContext(text.slice(fnStart, fnEnd), ctx);

  // Auto-checked skipPermissions for agy must be cleared when agy disappears and falls back to Claude.
  els['skip-permissions'].checked = true;
  els['skip-permissions'].setAttribute('data-agy-auto-skip', 'true');
  ctx.renderAgyProvider();
  assert.equal(radios.claude.checked, true);
  assert.equal(els['agy-provider'].hidden, true);
  assert.equal(els['skip-permissions'].checked, false);
  assert.equal(els['skip-permissions'].getAttribute('data-agy-auto-skip'), null);

  // Manually checked skipPermissions (without data-agy-auto-skip) is preserved on fallback.
  radios.claude.checked = false;
  radios.agy.checked = true;
  els['skip-permissions'].checked = true;
  ctx.renderAgyProvider();
  assert.equal(radios.claude.checked, true);
  assert.equal(els['skip-permissions'].checked, true);
});

test('R2 #3 (r3 #3): bound nativeId is immutable and rejects mismatched, malformed, or missing conversationId hooks', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-agy-lock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const brainRoot = path.join(dir, 'brain');
  const ownId = randomUUID(), otherId = randomUUID();
  const ownTranscript = path.join(brainRoot, ownId, 'transcript.jsonl');
  const otherTranscript = path.join(brainRoot, otherId, 'transcript.jsonl');
  fs.mkdirSync(path.dirname(ownTranscript), { recursive: true });
  fs.mkdirSync(path.dirname(otherTranscript), { recursive: true });
  fs.writeFileSync(ownTranscript, JSON.stringify({ type: 'PLANNER_RESPONSE', step_index: 2, content: 'own reply' }) + '\n');
  fs.writeFileSync(otherTranscript, JSON.stringify({ type: 'PLANNER_RESPONSE', step_index: 2, content: 'HIJACKED REPLY' }) + '\n');

  const term = new SyntheticTerminal(['/bin/agy'], dir, {});
  const record = { id: 's-lock', provider: 'agy', cwd: dir, nativeId: null, state: 'idle' };
  const rt = new AgyTui(record, { hookSocket: '/tmp/h.sock', hookTargets: new Map(), agyMcpTargets: new Map() }, { brainRoot });
  const completes = [];
  rt.on('complete', c => completes.push(c));
  rt.attach(term);
  term.emit('started', 22222);

  // Initial SessionStart binds nativeId once.
  rt.hook({ hookEventName: 'SessionStart', conversationId: ownId });
  assert.equal(record.nativeId, ownId);

  // Subsequent hook claiming another conversationId (or malformed ID) is dropped before mutating nativeId or starting a turn.
  for (const badId of [otherId, 'not-a-uuid', '', 12345, null, {}]) {
    rt.hook({ hookEventName: 'PreInvocation', conversationId: badId, initialNumSteps: 0, transcriptPath: otherTranscript });
    assert.equal(record.nativeId, ownId);
    assert.equal(rt.turnId, null);
  }

  // Start a legitimate bound turn, then attempt to complete it with malformed, empty, numeric, null, missing, or foreign IDs.
  rt.hook({ hookEventName: 'PreInvocation', conversationId: ownId, initialNumSteps: 0, transcriptPath: ownTranscript });
  const activeTurn = rt.turnId;
  assert.ok(activeTurn);
  for (const badStop of [
    { hookEventName: 'Stop', conversationId: otherId, terminationReason: 'NO_TOOL_CALL', fullyIdle: true, transcriptPath: otherTranscript },
    { hookEventName: 'Stop', conversationId: 12345, terminationReason: 'NO_TOOL_CALL', fullyIdle: true, transcriptPath: ownTranscript },
    { hookEventName: 'Stop', conversationId: '', terminationReason: 'NO_TOOL_CALL', fullyIdle: true, transcriptPath: ownTranscript },
    { hookEventName: 'Stop', conversationId: null, terminationReason: 'NO_TOOL_CALL', fullyIdle: true, transcriptPath: ownTranscript },
    { hookEventName: 'Stop', terminationReason: 'NO_TOOL_CALL', fullyIdle: true, transcriptPath: ownTranscript },
  ]) {
    rt.hook(badStop);
    assert.equal(rt.turnId, activeTurn, 'malformed or missing conversationId never closes a bound turn');
    assert.equal(completes.length, 0);
  }

  // Matching conversationId completes the bound turn cleanly.
  rt.hook({ hookEventName: 'Stop', conversationId: ownId, terminationReason: 'NO_TOOL_CALL', fullyIdle: true, transcriptPath: ownTranscript });
  assert.equal(rt.turnId, null);
  assert.equal(completes.length, 1);
  assert.equal(completes[0].text, 'own reply');

  // Pre-bound resumed session also rejects retargeting on the very first hook.
  const resumedRecord = { id: 's-resumed', provider: 'agy', cwd: dir, nativeId: ownId, recovering: true, state: 'idle' };
  const resumedRt = new AgyTui(resumedRecord, { hookSocket: '/tmp/h.sock', hookTargets: new Map(), agyMcpTargets: new Map() }, { brainRoot });
  const resumedTerm = new SyntheticTerminal(['/bin/agy'], dir, {});
  resumedRt.attach(resumedTerm);
  resumedTerm.emit('started', 22223);
  resumedRt.hook({ hookEventName: 'SessionStart', conversationId: otherId });
  assert.equal(resumedRecord.nativeId, ownId);
});

test('R2 #4 (r3 #1/#2): xterm editorState blocks un-echoed keystroke race, stale composer above selection, cursor outside composer, and live drafts while allowing send after clear', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-agy-screen-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const rule = '─'.repeat(80);
  // cursorRow is 0-indexed viewport row; defaults to the first `>` line when present.
  const paint = async (term, lines, cursorRow = lines.findIndex(l => l.startsWith('>'))) => {
    const move = cursorRow >= 0 ? `\x1b[${cursorRow + 1};3H` : '';
    const payload = '\x1b[2J\x1b[H' + lines.join('\r\n') + move;
    await new Promise(resolve => term.screen.write(payload, resolve));
    term.emit('data', { data: payload });
  };

  class XtermTerminal extends SyntheticTerminal {
    constructor(argv, cwd, env) {
      super(argv, cwd, env);
      this.screen = new HeadlessTerminal({ cols: 100, rows: 30, allowProposedApi: true });
    }
  }

  let activeTerm;
  let clock = 1000;
  const host = {
    privateDir: dir,
    binaries: { agy: '/synthetic/bin/agy', python: '/synthetic/bin/python3' },
    hookSocket: path.join(dir, 'hooks.sock'),
    hookTargets: new Map(),
    agyMcpTargets: new Map(),
    create(record) {
      return new AgyTui(record, host, {
        sendTimeoutMs: 500,
        humanInputQuietMs: 500,
        now: () => clock,
        Terminal: class extends XtermTerminal {
          constructor(argv, cwd, env) { super(argv, cwd, env); activeTerm = this; }
        },
      });
    },
    close() {},
  };
  const ws = new Workspace(host, dir);
  t.after(async () => { await ws.close(); });

  const sessionId = await ws.create('agy', dir, 'owner-1', '', 'terminal', { skipPermissions: true });
  const record = ws.get(sessionId);
  const rt = ws.runtimes.get(sessionId);
  activeTerm.emit('started', 61616);

  // Trust prompt blocks dispatch.
  await paint(activeTerm, ['Accessing workspace:', dir, 'Do you trust the contents of this project?', '> Yes, I trust this folder']);
  assert.equal(editorState(activeTerm.screen), 'blocked');
  assert.equal(rt.chatAvailable, false);
  await assert.rejects(rt.send('blocked on trust', 't1', () => true), e => e.notSent === true);
  assert.equal(activeTerm.writes.length, 0);

  // r3 #2: Old empty composer above a newer selection prompt (non-empty rows below ? for shortcuts) is rejected.
  await paint(activeTerm, [
    'Antigravity CLI 1.5.16',
    rule,
    '> ',
    rule,
    '? for shortcuts',
    'Select a model:',
    '> Gemini 4 Neon',
  ], 6);
  assert.equal(editorState(activeTerm.screen), 'unknown');
  assert.equal(rt.chatAvailable, false);
  await assert.rejects(rt.send('blocked on selection below composer', 't-below', () => true), e => e.notSent === true);
  assert.equal(activeTerm.writes.length, 0);

  // r3 #2: Even with nothing below ? for shortcuts, cursor outside the composer box is rejected.
  await paint(activeTerm, [
    'Antigravity CLI 1.5.16',
    rule,
    '> ',
    rule,
    '? for shortcuts',
  ], 4);
  assert.equal(editorState(activeTerm.screen), 'unknown');
  assert.equal(rt.chatAvailable, false);

  // Default Auto mode idle placeholder with cursor inside composer is empty and dispatchable.
  await paint(activeTerm, [
    'Antigravity CLI 1.5.16',
    rule,
    '> Auto mode: edits & safe commands auto-approved (shift+tab to cycle)',
    rule,
    '? for shortcuts                                      auto · Gemini 4 Neon · high',
  ]);
  assert.equal(editorState(activeTerm.screen), 'empty');
  assert.equal(rt.chatAvailable, true);

  // r3 #1: Human types into TUI -> BEFORE any PTY repaint (screen still holds old empty frame), dispatch MUST refuse with 0 extra bytes written!
  ws.input(sessionId, 'h', 'owner-1');
  assert.equal(record.terminalInputPending, true);
  assert.equal(rt.chatAvailable, false);
  const writesRightAfterKey = activeTerm.writes.length;
  await assert.rejects(rt.send('race before echo', 't-race', () => true), e => e.notSent === true);
  assert.equal(activeTerm.writes.length, writesRightAfterKey, 'zero dispatch bytes written during un-echoed keystroke window');

  // r4/r5 #1: Even AFTER the quiet deadline expires, neither no-repaint NOR unrelated ANSI output (like \x1b[0m color reset)
  // that leaves the composer unchanged may re-enable readiness without observing the editor actually leave empty (or run a turn)!
  clock += 1000;
  rt.syncScreenState(activeTerm.screen);
  assert.equal(rt.chatAvailable, false, 'stale cached frame never re-enables readiness after deadline without editor transition');
  await assert.rejects(rt.send('still no repaint after 1s', 't-no-repaint', () => true), e => e.notSent === true);
  assert.equal(activeTerm.writes.length, writesRightAfterKey);

  // Unrelated nonempty ANSI sequence (\x1b[0m) after the 500ms deadline leaves editor unchanged -> MUST stay blocked!
  await new Promise(resolve => activeTerm.screen.write('\x1b[0m', resolve));
  activeTerm.emit('data', { data: '\x1b[0m' });
  assert.equal(rt.chatAvailable, false, 'unrelated ANSI output leaving editor unchanged never confirms human keystroke');
  await assert.rejects(rt.send('after unrelated color reset', 't-ansi', () => true), e => e.notSent === true);
  assert.equal(activeTerm.writes.length, writesRightAfterKey);

  // Once agy actually echoes the draft, editor transitions out of empty into editing state (still blocked while drafting).
  await paint(activeTerm, [
    'Antigravity CLI 1.5.16',
    rule,
    '> hello draft',
    rule,
    '                                                     auto · Gemini 4 Neon · high',
  ]);
  assert.equal(editorState(activeTerm.screen), 'unknown');
  assert.equal(rt.chatAvailable, false);
  await assert.rejects(rt.send('auto while drafting', 't2', () => true), e => e.notSent === true);
  assert.equal(activeTerm.writes.length, writesRightAfterKey, 'zero bytes written while human draft is present');

  // Even if ? for shortcuts were visible alongside non-placeholder text, editorState still reports draft.
  await paint(activeTerm, ['Antigravity CLI 1.5.16', rule, '> hello draft', rule, '? for shortcuts']);
  assert.equal(editorState(activeTerm.screen), 'draft');
  assert.equal(rt.chatAvailable, false);

  // Multi-line draft is also blocked.
  await paint(activeTerm, ['Antigravity CLI 1.5.16', rule, '> ', 'second line', rule, '? for shortcuts']);
  assert.equal(editorState(activeTerm.screen), 'draft');

  // Human clears draft (Ctrl+U) while in editing state -> blocked during settle window, then empty skipPermissions prompt re-enables automated send()!
  ws.input(sessionId, '\x15', 'owner-1');
  const writesAfterClear = activeTerm.writes.length;
  clock += 100;
  await paint(activeTerm, [
    'Antigravity CLI 1.5.16',
    rule,
    '> ',
    rule,
    '? for shortcuts                                      auto · Gemini 4 Neon · high',
  ]);
  assert.equal(rt.chatAvailable, false, 'still settling immediately after Ctrl+U');
  await assert.rejects(rt.send('too soon after clear', 't-settle', () => true), e => e.notSent === true);
  assert.equal(activeTerm.writes.length, writesAfterClear);

  clock += 500;
  rt.syncScreenState(activeTerm.screen);
  assert.equal(record.terminalInputPending, true, 'workspace sticky flag stays intact');
  assert.equal(editorState(activeTerm.screen), 'empty');
  assert.equal(rt.chatAvailable, true);

  const convId = randomUUID();
  const sendOk = ws.send(sessionId, 'Dispatched after TUI use', 'owner-1');
  assert.equal(activeTerm.writes.at(-1), '\x1b[200~Dispatched after TUI use\x1b[201~\r');
  rt.hook({ hookEventName: 'PreInvocation', conversationId: convId, invocationNum: 1, initialNumSteps: 1 });
  await sendOk;
  assert.equal(record.state, 'working');
});

test('unhooked agy session clears temporary identity on exit and reload', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-agy-temp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let active;
  const host = {
    binaries: { agy: '/synthetic/bin/agy', python: '/synthetic/bin/python3' },
    hookTargets: new Map(),
    agyMcpTargets: new Map(),
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

test('agy_hook.py is a no-op outside NAW and forwards metadata + hashed PreToolUse proof inside NAW', async t => {
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
  const preOut = execFileSync(python, [script], {
    input: JSON.stringify({
      hookEventName: 'PreToolUse',
      conversationId: convId,
      toolCall: { id: 'toolu_77', name: 'naw_workspace__workspace_message', args: { recipient_id: 'peer-9', message: 'SECRET_MSG' } },
      lastUserInput: 'SECRET_PROMPT_BODY',
    }),
    encoding: 'utf8',
    env: { ...envClean, NAW_HOOK_TOKEN: 'hook-secret', NAW_HOOK_SOCKET: sock },
  });
  assert.deepEqual(JSON.parse(preOut), { decision: 'allow' });

  const stopOut = execFileSync(python, [script], {
    input: JSON.stringify({
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
    }),
    encoding: 'utf8',
    env: { ...envClean, NAW_HOOK_TOKEN: 'hook-secret', NAW_HOOK_SOCKET: sock },
  });
  assert.deepEqual(JSON.parse(stopOut), {});
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(received.length, 2);
  assert.deepEqual(received[0], {
    hookEventName: 'PreToolUse',
    conversationId: convId,
    toolCallId: 'toolu_77',
    toolName: 'naw_workspace__workspace_message',
    recipientId: 'peer-9',
    messageHash: sha256('SECRET_MSG'),
    token: 'hook-secret',
  });
  assert.doesNotMatch(JSON.stringify(received), /SECRET_PROMPT_BODY|SECRET_MSG|private error body/);
});
