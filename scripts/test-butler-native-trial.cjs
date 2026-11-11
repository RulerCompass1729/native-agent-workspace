'use strict';
// Default: real native binary with a fixed local upstream. Live use requires the
// explicit one-off flag and a durable exclusive claim; never auto-retry a run.
const fs = require('node:fs'), path = require('node:path'), readline = require('node:readline');
const assert = require('node:assert/strict'), { execFileSync } = require('node:child_process'), { randomUUID } = require('node:crypto');
const testScratch = require('./fixtures/test-scratch.cjs');
const loopback = require('./fixtures/loopback-model.cjs');
const { config } = require('./fixtures/butler-native-config.cjs');
const trial = require('./fixtures/butler-trial-gateway.cjs');
const { executable } = require('../app/platform.cjs');
const { checkProfile } = require('../app/butler-runner.cjs');
const { trustOwnedFolder } = require('./native-trust.cjs');
const live = process.argv[2] === '--live-authorized-20261110';
assert.ok(process.argv.length === 2 || live && process.argv.length === 4 && process.argv[3] === '--allow-native-auth-relay',
  'Live requires both the dated flag and explicit approval of the native-auth relay');
const root = path.resolve(__dirname, '../.local/evidence/b4-native-trial-20261110');
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
const evidence = live ? path.join(root, 'live') : path.join(root, 'fixture-' + randomUUID());
if (!live) fs.mkdirSync(evidence, { mode: 0o700 });
if (live) {
  assert.equal(new Date().toISOString().slice(0, 10), '2026-11-11', 'Reverify the price and execution plan on a later day');
  assert.equal(Object.hasOwn(process.env, 'NODE_EXTRA_CA_CERTS'), false, 'Extra certificate authorities are forbidden in the live relay');
  const fd = fs.openSync(path.join(root, 'live-authorized-once.json'), 'wx', 0o600);
  fs.writeSync(fd, JSON.stringify({ authorized: '2026-11-10 person approval relayed by integrator', limits: trial.LIMITS, startedAt: new Date().toISOString() })); fs.fsyncSync(fd); fs.closeSync(fd);
  fs.mkdirSync(evidence, { mode: 0o700 });
}
const state = { mode: live ? 'live' : 'fixture', nativeTurns: 0, providerRequests: 0, fixedToolCalls: 0, outcome: 'starting' };
const save = () => fs.writeFileSync(path.join(evidence, 'summary.json'), JSON.stringify(state, null, 2), { mode: 0o600 });
const record = row => { const fd = fs.openSync(path.join(evidence, 'events.jsonl'), 'a', 0o600); fs.writeSync(fd, JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n'); fs.fsyncSync(fd); fs.closeSync(fd); };
// These are retained native evidence, not temporary profiles. The shared
// finalizer owns processes; it must not delete the retained synthetic thread.
const directory = path.join(evidence, 'native'); fs.mkdirSync(directory, { mode: 0o700 });
const home = path.join(directory, 'codex'), userHome = path.join(directory, 'home'), cwd = path.join(directory, 'work');
for (const dir of [home, userHome, cwd]) fs.mkdirSync(dir, { mode: 0o700 });
const binary = fs.realpathSync(executable('codex'));
state.version = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
assert.equal(state.version, 'codex-cli 0.167.1');
let child, probe, gateway, deadline;
const cleanup = testScratch.cleanup(async () => { clearTimeout(deadline); await gateway?.close(); await probe?.stop(); });
const fixedResponse = (index, input) => {
  const item = index === 1 ? { type: 'function_call', id: 'fixed_call', call_id: 'fixed_call', name: trial.TOOL, arguments: '{}', status: 'completed' }
    : { type: 'message', id: 'fixed_answer', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: trial.ANSWER, annotations: [] }] };
  const response = { id: 'fixed_response_' + index, model: trial.MODEL, object: 'response', status: 'completed', output: [item],
    usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 0 }, output_tokens: 20, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 120 } };
  return Buffer.from([{ type: 'response.created', response: { ...response, status: 'in_progress', output: [], usage: null } },
    { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response }]
    .map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join(''));
};
(async () => {
  try {
    // This is the only credential observation in author-owned JS: boolean only.
    if (live) { state.credentialPresent = Boolean(process.env.DEEPSEEK_API_KEY); assert.equal(state.credentialPresent, true); state.profileNamesConfirmed = checkProfile(); }
    let upstreamCount = 0;
    gateway = trial.createGateway({ record, transport: live ? trial.liveTransport : async (body, _auth, _register, written) => {
      upstreamCount++; const data = JSON.parse(body);
      assert.equal(data.max_output_tokens, 1024); assert.equal(data.model, trial.MODEL);
      assert.ok(_auth?.equals(Buffer.from('authorization: Bearer synthetic-fixture-only')), 'Native must send exactly one synthetic auth header');
      assert.ok(!body.includes(Buffer.from('PRIVATE_CANARY')));
      record({ state: 'fixed-upstream', index: upstreamCount, maxOutputTokens: data.max_output_tokens, nativeAuthPresent: Boolean(_auth) });
      written();
      return fixedResponse(upstreamCount, data);
    } });
    // Reuse the established policy and its positive network/keychain preflight.
    // Its own server is never the inference destination; verify the same policy
    // shape with the gateway port and a real listener there before native boot.
    probe = loopback.create({ directory, provider: 'codex', respond: (_req, res) => { res.writeHead(403); res.end(); } });
    await probe.start(); await probe.preflight();
    const allowedPort = probe.port;
    state.networkPreflight = probe.summary().preflight;
    await probe.stop();
    await gateway.start(allowedPort);
    const policy = loopback.policy(gateway.port);
    const networkProbe = execFileSync('/usr/bin/sandbox-exec', ['-p', policy, process.execPath, '-e',
      "const n=require('net');let left=2,r={};for(const [k,p]of[['allowed',+process.argv[1]],['other',+process.argv[2]]]){const s=n.connect({host:'127.0.0.1',port:p});s.on('connect',()=>{r[k]='connected';s.destroy();if(!--left)console.log(JSON.stringify(r))});s.on('error',e=>{r[k]=e.code;if(!--left)console.log(JSON.stringify(r))})}", String(gateway.port), '1'], { encoding: 'utf8', timeout: 5000 });
    state.gatewayNetworkProbe = JSON.parse(networkProbe); assert.deepEqual(state.gatewayNetworkProbe, { allowed: 'connected', other: 'EPERM' });
    // The live gate is protected by the same local-only native policy. The
    // relay itself has one literal TLS destination and ignores proxy variables.
    let toml = config(gateway.endpoint, true).replace(gateway.endpoint + '/v1', gateway.endpoint);
    toml += 'env_key = "DEEPSEEK_API_KEY"\n';
    fs.writeFileSync(path.join(home, 'config.toml'), toml, { mode: 0o600 });
    trustOwnedFolder({ home, base: directory, folder: cwd });
    const shim = path.join(directory, 'launch.py');
    // Retain the native key in the inherited environment only; no read, copy,
    // serialization, argv, config value or stdin transfer of its value.
    fs.writeFileSync(shim, 'import os\n' +
      `allowed=${JSON.stringify(['PATH', 'LANG', ...(live ? ['DEEPSEEK_API_KEY'] : [])])}\n` +
      'for k in list(os.environ):\n if k not in allowed: os.environ.pop(k,None)\n' +
      (live ? '' : 'os.environ["DEEPSEEK_API_KEY"]="synthetic-fixture-only"\n') +
      `os.environ.update(${JSON.stringify({ HOME: userHome, CODEX_HOME: home, TMPDIR: directory })})\n` +
      `os.execv('/usr/bin/sandbox-exec',['sandbox-exec','-p',${JSON.stringify(policy)},${JSON.stringify(binary)},'app-server','--listen','stdio://'])\n`, { mode: 0o600 });
    child = testScratch.childProcess.spawn('/usr/bin/python3', [shim], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    // Native stderr is counted but never dumped; authentication failures must
    // not echo response/header material to evidence or the caller.
    let stderrBytes = 0; child.stderr.on('data', b => { stderrBytes += b.length; });
    let id = 0, finish, rejectTurn; const pending = new Map();
    const done = new Promise((resolve, reject) => { finish = resolve; rejectTurn = reject; }); done.catch(() => {});
    const failure = code => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Error(code)); } pending.clear(); rejectTurn(Error(code)); };
    child.once('error', () => failure('native-start-error')); child.once('exit', () => failure('native-exited'));
    deadline = setTimeout(() => { failure('trial-timeout'); child.kill('SIGTERM'); }, 120000);
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', line => {
      try {
        const m = JSON.parse(line);
        if (!m.method && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(Error('native-rpc-error')) : p.resolve(m.result); }
        else if (m.method === 'item/tool/call' && m.id != null) {
          if (m.params.threadId !== state.threadId) throw Error('foreign-thread-tool');
          const result = gateway.handleTool(m.params); state.fixedToolCalls++;
          child.stdin.write(JSON.stringify({ id: m.id, result }) + '\n');
        } else if (m.id != null && m.method) { child.stdin.write(JSON.stringify({ id: m.id, error: { code: -32601, message: 'No other host action is allowed' } }) + '\n'); failure('unexpected-native-request'); child.kill('SIGTERM'); }
        else if (m.method === 'turn/completed') finish(m.params.turn.status);
      } catch { failure('native-protocol-or-tool-error'); child.kill('SIGTERM'); }
    });
    const call = (method, params) => new Promise((resolve, reject) => {
      const current = ++id, timer = setTimeout(() => { pending.delete(current); reject(Error('native-rpc-timeout')); }, 15000);
      pending.set(current, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id: current, method, params }) + '\n');
    });
    const init = await call('initialize', { clientInfo: { name: 'b4_finite_trial', version: '1' }, capabilities: { experimentalApi: true } });
    assert.match(init.userAgent, /\/0\.167\.1 /); state.initialized = true;
    child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
    const created = await call('thread/start', { cwd, ephemeral: false, model: trial.MODEL, modelProvider: 'deepseek',
      baseInstructions: 'Synthetic transport validation only.', developerInstructions: '', approvalPolicy: 'never', sandbox: 'read-only',
      dynamicTools: [{ type: 'function', name: trial.TOOL, description: 'Return a fixed synthetic result; no side effects.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] });
    assert.equal(created.model, trial.MODEL); state.threadId = created.thread.id;
    state.nativeTurns = 1; save();
    await call('turn/start', { threadId: created.thread.id, input: [{ type: 'text', text: trial.PROMPT, text_elements: [] }] });
    assert.equal(await done, 'completed'); assert.equal(gateway.requestCount, 2); assert.equal(state.fixedToolCalls, 1);
    state.outcome = 'completed'; state.stderrBytes = stderrBytes;
  } catch (e) { state.outcome = 'failed'; state.error = /^[-a-z0-9]+$/.test(e.code || e.message) ? (e.code || e.message) : 'trial-check-failed'; process.exitCode = 1; }
  finally {
    await cleanup();
    state.nativeExited = !child || child.exitCode !== null || child.signalCode !== null;
    state.providerRequests = live ? gateway?.requestCount || 0 : 0;
    state.requestsWritten = live ? gateway?.records.filter(r => r.state === 'upstream-request-written').length || 0 : 0;
    state.requestCountBasis = live ? 'reserved attempts; requestsWritten separately records native-authenticated TLS writes' : 'fixed loopback responses only';
    state.localFixedRequests = live ? 0 : gateway?.requestCount || 0;
    state.rawUsage = gateway?.records.filter(r => r.state === 'provider-usage-raw') || [];
    state.usage = gateway?.records.filter(r => r.state === 'provider-usage') || [];
    state.estimatedMicros = live && state.usage.length === state.providerRequests ? state.usage.reduce((n, r) => n + r.estimatedMicros, 0) : live ? null : 0;
    state.actualProviderAmount = live ? null : 0; save(); console.log(JSON.stringify(state));
  }
})();
