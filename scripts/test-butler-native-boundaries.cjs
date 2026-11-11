// Real Codex app-server, synthetic inputs and fixed loopback Responses only.
// This is a bounded native configuration experiment, not a provider qualification.
// 10 native turns, at most 30 fixed local responses (observed 15), 2 native
// sandbox commands; no outside model, no GUI, no installed app mutation.
'use strict';
const fs = require('node:fs'), path = require('node:path'), readline = require('node:readline');
const assert = require('node:assert/strict');
const scratch = require('./fixtures/test-scratch.cjs');
const loopback = require('./fixtures/loopback-model.cjs');
const { executable } = require('../app/platform.cjs');
const { trustOwnedFolder } = require('./native-trust.cjs');
const { once } = require('node:events');
const base = scratch.directory('/tmp/naw-b4-boundaries-');
const evidence = path.resolve(process.argv[2] || '.local/evidence/b4-boundaries-20261110/run');
fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
const binary = fs.realpathSync(executable('codex'));
const version = scratch.childProcess.execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
assert.equal(version, 'codex-cli 0.167.1', 'This experiment is bounded to the observed native version');
const cases = ['shell-off', 'project-positive', 'restricted', 'restricted-exec', 'restricted-patch', 'restricted-image', 'restricted-web', 'restricted-mcp', 'restricted-inherited-global', 'restricted-catalog'];
const summaries = [];
let activeChild, activeFixture;
const cleanup = scratch.cleanup(async () => {
  if (activeChild?.exitCode === null && activeChild?.signalCode === null) {
    const end = once(activeChild, 'exit'); activeChild.kill('SIGTERM'); await end;
  }
  await activeFixture?.stop();
});
function config(endpoint, restricted) {
  return [
    'model = "deepseek-v4-pro"', 'model_provider = "deepseek"',
    'analytics.enabled = false', 'feedback.enabled = false', 'check_for_update_on_startup = false',
    'model_reasoning_effort = "low"', 'approval_policy = "never"', 'sandbox_mode = "read-only"',
    'project_doc_max_bytes = 0', 'web_search = "disabled"',
    ...(restricted ? ['include_environment_context = false', 'include_environment_context_time = false',
      'include_permissions_instructions = false', 'include_apps_instructions = false',
      'include_collaboration_mode_instructions = false'] : []),
    '[tools.update_plan]', 'enabled = false', '[tools.experimental_request_user_input]', 'enabled = false',
    '[skills]', 'include_instructions = false', '[features]', 'shell_tool = false', 'daemon_auto_start = false',
    ...(restricted ? ['view_image', 'multi_env_copy_file', 'apps', 'plugins', 'memories', 'js_repl',
      'code_mode', 'code_mode_only', 'multi_agent', 'multi_agent_v2', 'image_generation',
      'request_permissions_tool', 'token_budget', 'current_time_reminder', 'sleep_tool', 'goals',
      'tool_suggest', 'tool_search', 'shell_snapshot'].map(key => key + ' = false') : []),
    '[model_providers.deepseek]', 'name = "Local boundary fixture"',
    'base_url = ' + JSON.stringify(endpoint + '/v1'), 'wire_api = "responses"',
    'requires_openai_auth = false', 'supports_websockets = false',
    'request_max_retries = 0', 'stream_max_retries = 0', '',
  ].join('\n');
}
function flattenTools(tools) {
  return (tools || []).flatMap(tool => tool.type === 'namespace'
    ? tool.tools.map(child => tool.name + '.' + child.name) : [tool.name || tool.type]);
}
async function run(name) {
  const restricted = name !== 'shell-off', directory = path.join(base, name);
  const home = path.join(directory, 'codex'), userHome = path.join(directory, 'home'), cwd = path.join(directory, 'work');
  for (const d of [directory, home, userHome, cwd]) fs.mkdirSync(d, { mode: 0o700 });
  const out = path.join(evidence, name); fs.mkdirSync(out, { mode: 0o700 });
  const globalMarker = 'B4_SYNTHETIC_GLOBAL_INSTRUCTION', projectMarker = 'B4_SYNTHETIC_PROJECT_INSTRUCTION';
  if (!restricted || name === 'restricted-inherited-global') fs.writeFileSync(path.join(home, 'AGENTS.md'), globalMarker);
  fs.writeFileSync(path.join(cwd, 'AGENTS.md'), projectMarker);
  const requests = [], events = []; let sequence = 0;
  const forbidden = path.join(cwd, 'forbidden-effect');
  const attack = name.slice('restricted-'.length);
  const attacks = {
    exec: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: '/usr/bin/touch ' + forbidden }) },
    patch: { type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch\n*** Add File: ' + forbidden + '\n+B4_FORBIDDEN_EFFECT\n*** End Patch' },
    image: { type: 'function_call', name: 'view_image', arguments: JSON.stringify({ path: path.join(cwd, 'AGENTS.md') }) },
    web: { type: 'function_call', name: 'web.run', arguments: JSON.stringify({ search_query: [{ q: 'B4_SYNTHETIC_NETWORK' }] }) },
    mcp: { type: 'function_call', name: 'mcp__synthetic__read', arguments: '{}' },
  };
  const fixture = activeFixture = loopback.create({ directory, provider: 'codex', respond(req, res, body) {
    assert.ok(req.url.endsWith('/responses'), 'Only the fixed Responses fixture');
    const input = JSON.parse(body); assert.equal(input.model, 'deepseek-v4-pro');
    assert.ok(requests.length < 3, 'At most three local requests per case, no real model');
    requests.push(input);
    fs.writeFileSync(path.join(out, 'request-' + requests.length + '.json'), JSON.stringify(input, null, 2));
    const emit = (type, data) => res.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, sequence_number: ++sequence, ...data }) + '\n\n');
    const response = { id: 'r_' + name + '_' + requests.length, object: 'response', status: 'in_progress', model: input.model,
      output: [], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } };
    let item = { id: 'answer_' + requests.length, type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'B4_SYNTHETIC_DONE', annotations: [] }] };
    if (requests.length === 1 && attacks[attack]) item = { id: 'call_' + name, call_id: 'call_' + name, status: 'completed', ...attacks[attack] };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    emit('response.created', { response }); emit('response.output_item.done', { output_index: 0, item });
    emit('response.completed', { response: { ...response, status: 'completed', output: [item] } }); res.end();
  } });
  await fixture.start(); await fixture.preflight();
  let toml = config(fixture.endpoint, restricted);
  if (name === 'project-positive') toml = toml.replace('project_doc_max_bytes = 0', 'project_doc_max_bytes = 32768');
  if (name === 'restricted-catalog') {
    // Public native model descriptor schema, synthetic metadata only. This is
    // a counterexample, never an approved provider model catalog.
    const catalog = path.join(home, 'catalog.json');
    fs.writeFileSync(catalog, JSON.stringify({ models: [{ slug: 'deepseek-v4-pro', display_name: 'Synthetic boundary counterexample',
      description: null, supported_reasoning_levels: [], shell_type: 'disabled', visibility: 'none', supported_in_api: true,
      priority: 99, availability_nux: null, upgrade: null, support_verbosity: false, default_verbosity: null,
      apply_patch_tool_type: 'freeform', truncation_policy: { mode: 'bytes', limit: 10000 },
      experimental_supported_tools: [], model_messages: { instructions_template: 'B4_SYNTHETIC_MODEL_POLICY' } }] }));
    toml = 'model_catalog_json = ' + JSON.stringify(catalog) + '\n' + toml;
  }
  fs.writeFileSync(path.join(home, 'config.toml'), toml, { mode: 0o600 });
  fs.writeFileSync(path.join(out, 'config.toml'), toml, { mode: 0o600 });
  trustOwnedFolder({ home, base, folder: cwd });
  const shim = fixture.wrapper(binary, { file: path.join(directory, 'codex-local'), env: { CODEX_HOME: home, HOME: userHome } });
  const child = activeChild = scratch.childProcess.spawn(shim, ['app-server', '--listen', 'stdio://'], {
    cwd, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: userHome, CODEX_HOME: home, LANG: 'en_US.UTF-8', TMPDIR: directory },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.on('data', data => fs.appendFileSync(path.join(out, 'stderr.log'), data));
  let id = 0, resolveDone, rejectDone;
  const pending = new Map(), done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  // Bound initialization/RPC failure as well as the native turn.
  done.catch(() => {});
  const fail = error => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); } pending.clear(); rejectDone(error); };
  child.once('error', fail); child.once('exit', () => fail(Error('Owned native process exited')));
  const deadline = setTimeout(() => rejectDone(Error('Native case exceeded 45 seconds')), 45000);
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', line => {
    fs.appendFileSync(path.join(out, 'native.jsonl'), line + '\n');
    const message = JSON.parse(line);
    if (!message.method && message.id != null && pending.has(message.id)) {
      const p = pending.get(message.id); pending.delete(message.id); clearTimeout(p.timer);
      if (message.error) p.reject(Error(JSON.stringify(message.error))); else p.resolve(message.result);
    } else if (message.method) {
      events.push(message);
      if (message.id) { child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'No host tool or approval is permitted in this fixture' } }) + '\n'); }
      if (message.method === 'turn/completed') resolveDone(message.params);
    }
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    const current = ++id, timer = setTimeout(() => { pending.delete(current); reject(Error('RPC timeout: ' + method)); }, 15000); pending.set(current, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id: current, method, params }) + '\n');
  });
  try {
    const initialize = await call('initialize', { clientInfo: { name: 'b4_boundary_fixture', version: '1' }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
    const thread = await call('thread/start', { cwd, ephemeral: true, model: 'deepseek-v4-pro', modelProvider: 'deepseek',
      baseInstructions: 'B4_SYNTHETIC_HOST_POLICY', developerInstructions: '', approvalPolicy: 'never', sandbox: 'read-only' });
    assert.equal(thread.model, 'deepseek-v4-pro');
    await call('turn/start', { threadId: thread.thread.id, input: [{ type: 'text', text: 'Reply with the fixed synthetic marker.', text_elements: [] }] });
    const completed = await done; assert.equal(completed.turn.status, 'completed');
    assert.ok(requests.length >= 1);
    assert.equal(fs.existsSync(forbidden), false, 'A forced forbidden tool must not write');
    if (restricted && name !== 'restricted-catalog') assert.deepEqual(flattenTools(requests[0].tools), [], 'No advertised tool under the tested configuration');
    if (attacks[attack]) {
      assert.equal(requests.length, 2, 'Exactly one forced tool rejection and the fixed final reply');
      const rejected = requests[1].input.find(item => item.call_id === 'call_' + name && item.type.endsWith('_output'));
      assert.ok(rejected, 'The attempted call has its own native tool result');
      assert.equal(rejected.output, (attack === 'patch' ? 'unsupported custom tool call: ' : 'unsupported call: ') + attacks[attack].name,
        'The native dispatcher rejected this exact tool, not an unrelated prompt substring');
    }
    let hostReadOnlyCanReadOutsideCwd = null, namedFileDeny = null;
    if (name === 'restricted') {
      const sentinel = path.join(directory, 'outside-cwd.txt');
      fs.writeFileSync(sentinel, 'B4_SYNTHETIC_FILE_CONTENT');
      const code = `import sys,socket,json
r={}
try:
 with open(sys.argv[1]) as f:r["read"]=f.read()=="B4_SYNTHETIC_FILE_CONTENT"
except OSError as e:r["read_errno"]=e.errno
s=socket.socket();s.settimeout(1)
try:s.connect(("192.0.2.1",443));r["network"]="connected"
except OSError as e:r["network_errno"]=e.errno
print(json.dumps(r))`;
      // No model endpoint is used: this is Codex's native sandbox command.
      // Running it directly avoids unsupported nested macOS sandbox_apply.
      const probe = profile => {
        const result = scratch.childProcess.spawnSync(binary, ['sandbox', '-C', cwd, '-P', profile, '--', '/usr/bin/python3', '-c', code, sentinel], {
          cwd, env: { PATH: '/usr/bin:/bin', HOME: userHome, CODEX_HOME: home, LANG: 'C', TMPDIR: directory }, encoding: 'utf8', timeout: 10000,
        });
        fs.writeFileSync(path.join(out, profile.replace(':', '') + '-sandbox.json'), JSON.stringify(result, null, 2));
        assert.equal(result.status, 0, result.stderr);
        return JSON.parse(result.stdout);
      };
      const readOnly = probe(':read-only');
      assert.equal(readOnly.read, true); assert.equal(readOnly.network_errno, 1);
      hostReadOnlyCanReadOutsideCwd = true;
      const policy = '\n[permissions.boundary]\nextends = ":read-only"\n[permissions.boundary.filesystem]\n' + JSON.stringify(sentinel) + ' = "deny"\n[permissions.boundary.network]\nenabled = false\n';
      fs.appendFileSync(path.join(home, 'config.toml'), policy);
      fs.writeFileSync(path.join(out, 'filesystem-profile.toml'), policy);
      namedFileDeny = probe('boundary');
      assert.equal(namedFileDeny.read, undefined); assert.ok([1,13].includes(namedFileDeny.read_errno)); assert.equal(namedFileDeny.network_errno, 1);
    }
    const text = JSON.stringify(requests[0]);
    const summary = { name, version, initialize, tools: flattenTools(requests[0].tools),
      hostReadOnlyCanReadOutsideCwd, namedFileDeny, globalInstructionSent: text.includes(globalMarker), projectInstructionSent: text.includes(projectMarker),
      localRequests: requests.length, forcedTool: attacks[attack]?.name || null, fixture: fixture.summary(), nativeTurns: events.filter(e => e.method === 'turn/completed').length };
    fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
    if (!restricted) { assert.equal(summary.globalInstructionSent, true); assert.equal(summary.projectInstructionSent, false); }
    else { assert.equal(summary.globalInstructionSent, name === 'restricted-inherited-global'); assert.equal(summary.projectInstructionSent, name === 'project-positive'); }
    if (name === 'restricted-catalog') assert.ok(summary.tools.includes('apply_patch'), 'Model catalog can restore patch despite every listed feature off');
    console.log(JSON.stringify({ name: summary.name, tools: summary.tools, globalInstructionSent: summary.globalInstructionSent, forcedTool: summary.forcedTool, localRequests: summary.localRequests, hostReadOnlyCanReadOutsideCwd })); summaries.push(summary); fixture.assertClean();
  } finally {
    clearTimeout(deadline);
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Error('Owned fixture closing')); } pending.clear();
    if (child.exitCode === null && child.signalCode === null) { const end = once(child, 'exit'); child.kill('SIGTERM'); await end; }
    activeChild = null; await fixture.stop(); activeFixture = null;
    const saved = summaries.find(s => s.name === name);
    if (saved) { saved.fixture = fixture.summary(); saved.nativeExited = child.exitCode !== null || child.signalCode !== null; fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(saved, null, 2)); }
  }
}
(async () => {
  try { for (const name of cases) await run(name); fs.writeFileSync(path.join(evidence, 'summary.json'), JSON.stringify(summaries, null, 2)); }
  finally { await cleanup(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
