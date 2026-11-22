'use strict';
// Real Claude CLI + production NativeHost/Workspace/PTY/bridge; fixed loopback responses, no GUI, no paid model.
// Question (queue item 2026-11-20): the CLI compacts by itself in the middle of a root turn. Does that same
// turn's next workspace read, control call and message still reach NAW, as its calls before the compaction did?
// Bounded: 1 native session, 2 root turns (a warm-up, then the measured one), at most 8 fixed local responses, 210 s.
// Usage: node scripts/test-native-compact-continuation.cjs [evidence-dir]
// NAW_CLAUDE_BINARY names an exact CLI build; NAW_COMPACT_BRIDGE_DIR swaps in a diagnostic copy of the bridge.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const scratch = require('./fixtures/test-scratch.cjs');
const loopback = require('./fixtures/loopback-model.cjs');
const { executable, pythonExecutable } = require('../app/platform.cjs');
const binary = fs.realpathSync(process.env.NAW_CLAUDE_BINARY || executable('claude'));
const version = scratch.childProcess.execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim().split(' ')[0];
const evidence = process.argv[2] ? path.resolve(process.argv[2]) : null;
if (evidence) fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
// The data directory changes below; this run's temp receipt stays in the registry it was written to.
process.env.NAW_TEMP_REGISTRY_DIR = require('../app/temp-ownership.cjs').defaultDirectory();
// Short path: the host's Unix sockets live under it.
const base = scratch.directory('/tmp/naw-ccr-');
const home = path.join(base, 'home'), config = path.join(base, 'config'), cwd = path.join(base, 'work'), profile = path.join(base, 'data');
for (const dir of [home, config, cwd, profile]) fs.mkdirSync(dir, { mode: 0o700 });
Object.assign(process.env, { HOME: home, TMPDIR: base, CLAUDE_CONFIG_DIR: config, NAW_DATA_DIR: profile, NAW_RUNTIME_CONFIG: path.join(base, 'locations.json') });
const { NativeHost } = require('../app/adapters.cjs'), { Workspace } = require('../app/workspace.cjs');

const SESSIONS = 'mcp__native_workspace__workspace_sessions', MESSAGE = 'mcp__native_workspace__workspace_message', CONTROL = 'mcp__native_workspace__workspace_control';
const BRIDGE_DENIALS = ['Operator calls require this confirmed native root turn', '没有本原生主会话的定向协作授权', 'Background control requires the actual native root call'];
// Above the CLI's own compaction threshold (its debug log reported effectiveWindow=980000 for this model), so the next step compacts first.
const FULL_CONTEXT_TOKENS = Number(process.env.NAW_COMPACT_FULL_TOKENS || 970000);
const owner = 'compact-continuation-test', sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const requests = [], checks = [];
// Diagnostic runs only: NAW_COMPACT_CLI_ENV='{"NAME":"value"}' adds CLI environment values.
const diagnosticEnv = process.env.NAW_COMPACT_CLI_ENV ? JSON.parse(process.env.NAW_COMPACT_CLI_ENV) : {};
let workspace, fixture, steps = 0, compactions = 0;
async function until(read, label, limit = 30000) {
  const deadline = Date.now() + limit;
  while (Date.now() < deadline) { if (await read()) return; await sleep(50); }
  throw Error(label);
}
function event(res, type, fields) { res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`); }
function block(res, index, content) {
  event(res, 'content_block_start', { index, content_block: content.type === 'text' ? { type: 'text', text: '' } : { ...content, input: {} } });
  event(res, 'content_block_delta', { index, delta: content.type === 'text' ? { type: 'text_delta', text: content.text } : { type: 'input_json_delta', partial_json: JSON.stringify(content.input) } });
  event(res, 'content_block_stop', { index });
}
const parts = message => typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
const resultText = part => typeof part.content === 'string' ? part.content : (part.content || []).map(c => c.text || '').join('');
// What the model was told a call returned, read from the request that carries its result.
function toolResult(id) {
  for (const request of requests) for (const message of request.body.messages) if (message.role === 'user') {
    const part = parts(message).find(p => p.type === 'tool_result' && p.tool_use_id === id);
    if (part) return { text: resultText(part), isError: part.is_error === true, request: request.number };
  }
  return null;
}
// Fixed local responses, in order. The first root turn only gives the conversation a history the CLI can summarise.
const SCRIPT = [
  { kind: 'warmup-1', blocks: [{ type: 'tool_use', id: 'toolu_warmup', name: SESSIONS, input: {} }] },
  { kind: 'warmup-2', blocks: [{ type: 'text', text: 'COMPACT_WARMUP_DONE' }] },
  { kind: 'step-1', full: true, blocks: [{ type: 'tool_use', id: 'toolu_before_compact', name: SESSIONS, input: {} },
    { type: 'tool_use', id: 'toolu_control_before_compact', name: CONTROL, input: { action: 'catalog' } }] },
  { kind: 'step-2', blocks: [{ type: 'tool_use', id: 'toolu_after_compact', name: SESSIONS, input: {} },
    { type: 'tool_use', id: 'toolu_control_after_compact', name: CONTROL, input: { action: 'catalog' } },
    { type: 'tool_use', id: 'toolu_message_after_compact', name: MESSAGE, input: { recipient_id: 'fixture-absent-recipient', message: 'Fixture message after the compaction.' } }] },
  { kind: 'step-3', blocks: [{ type: 'text', text: 'COMPACT_CONTINUATION_DONE' }] }
];
const SUMMARY = '<analysis>Fixture conversation.</analysis>\n<summary>\n1. Primary Request: a fixed local fixture task with two workspace reads.\n2. Current Work: the second read is still to run.\n</summary>';
function respond(req, res, raw) {
  if (!req.url.startsWith('/v1/messages') || req.url.includes('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ input_tokens: 100, data: [] })); return; }
  const body = JSON.parse(raw), last = body.messages.at(-1);
  // The CLI's own summarising request: it offers no workspace tool, or asks for the summary in its last message.
  const summarising = !(body.tools || []).some(tool => tool.name === SESSIONS) || parts(last).some(p => p.type === 'text' && /summary of the conversation|create a detailed summary/i.test(p.text));
  if (requests.length >= 8) throw Error('Fixed response budget exceeded');
  const next = summarising ? { kind: 'compaction', blocks: [{ type: 'text', text: SUMMARY }] } : SCRIPT[steps++];
  if (!next) throw Error('The CLI asked for more steps than the fixed task has');
  if (summarising) compactions++;
  requests.push({ number: requests.length + 1, kind: next.kind, body });
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  event(res, 'message_start', { message: { id: `fixture-${requests.length}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: next.full ? FULL_CONTEXT_TOKENS : 10, output_tokens: 0 } } });
  next.blocks.forEach((content, index) => block(res, index, content));
  event(res, 'message_delta', { delta: { stop_reason: next.blocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } });
  event(res, 'message_stop', {}); res.end();
}
function save(name, value) { if (evidence) fs.writeFileSync(path.join(evidence, name), JSON.stringify(value, null, 2), { mode: 0o600 }); }
const cleanup = scratch.cleanup(async () => {
  if (evidence && fs.existsSync(path.join(base, 'cli-debug.txt'))) fs.copyFileSync(path.join(base, 'cli-debug.txt'), path.join(evidence, 'cli-debug.txt'));
  if (workspace) { const own = workspace; workspace = null; try { await Promise.all([...own.sessions.keys()].map(id => own.stop(id))); } finally { await own.close(); } }
  if (fixture) { const own = fixture; fixture = null; await own.stop(); }
});
(async () => {
  fixture = loopback.create({ directory: base, provider: 'claude', respond });
  await fixture.start(); await fixture.preflight();
  let shim = fixture.wrapper(binary, { file: path.join(base, 'claude-local'), env: { CLAUDE_CONFIG_DIR: config, ...diagnosticEnv }, args: ['--model', 'haiku', ...(evidence ? ['--debug-file', path.join(base, 'cli-debug.txt')] : [])] });
  if (process.env.NAW_COMPACT_BRIDGE_DIR) {
    const inner = shim, replaced = path.resolve(process.env.NAW_COMPACT_BRIDGE_DIR); shim = path.join(base, 'claude-diagnostic');
    fs.writeFileSync(shim, '#!/usr/bin/python3\nimport os,sys\na=sys.argv[1:]\n' +
      `for i,v in enumerate(a):\n  if v=="--plugin-dir" and i+1<len(a) and a[i+1].endswith("claude-bridge"): a[i+1]=${JSON.stringify(replaced)}\n` +
      `os.execv(${JSON.stringify(inner)},[${JSON.stringify(inner)}]+a)\n`, { mode: 0o700 });
  }
  fs.writeFileSync(path.join(config, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, customApiKeyResponses: { approved: [loopback.FIXTURE_KEY], rejected: [] }, theme: 'dark',
    projects: { [cwd]: { hasTrustDialogAccepted: true }, [fs.realpathSync(cwd)]: { hasTrustDialogAccepted: true } } }), { mode: 0o600 });
  // The daily session this was seen in runs without native permission prompts; workspace_control asks otherwise.
  fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify({ skipDangerousModePermissionPrompt: true }), { mode: 0o600 });
  fs.writeFileSync(process.env.NAW_RUNTIME_CONFIG, JSON.stringify({ claude: shim }), { mode: 0o600 });
  const host = new NativeHost(base, profile);
  host.checkClaudeVersion = () => {}; // This fixture is not a version qualification.
  host.qualificationTrialVersion = version;
  host.resolvePrograms = () => (host.binaries = { claude: shim, codex: null, python: pythonExecutable() });
  await host.start(); workspace = new Workspace(host, profile);
  const id = await workspace.create('claude', cwd, owner, 'Compaction continuation', 'terminal', { skipPermissions: true });
  const read = () => workspace.snapshot().sessions.find(row => row.id === id), runtime = () => workspace.runtime(id);
  await until(() => read()?.chatAvailable && read()?.state === 'idle', 'Native startup', 60000);
  workspace.operator.settings(null, true); workspace.operator.settings(id, true);
  await until(() => runtime().operatorAvailable === true && runtime().addressedSendAvailable === true, 'The bridge reported the workspace tools');
  const before = read(), states = [];
  const watch = setInterval(() => { const s = read(), r = runtime(); const row = { state: s?.state, liveTurn: r?.liveTurn?.id || null, rootTurn: r?.rootTurn?.id || null, steps, compactions };
    if (JSON.stringify(row) !== JSON.stringify(states.at(-1)?.row)) states.push({ at: Date.now(), row }); }, 20);
  let failure;
  try {
    await workspace.send(id, 'Run the fixed warm-up task.', owner);
    await until(() => steps >= 2 && read().state === 'idle' && read().messages.some(row => row.text?.includes('COMPACT_WARMUP_DONE')), 'The warm-up root turn completes', 60000);
    await workspace.send(id, 'Run the fixed local task.', owner);
    await until(() => steps >= 5 && read().state === 'idle' && read().messages.some(row => row.text?.includes('COMPACT_CONTINUATION_DONE')), 'The root turn completes', 150000);
    const first = toolResult('toolu_before_compact'), second = toolResult('toolu_after_compact'), message = toolResult('toolu_message_after_compact');
    const controlFirst = toolResult('toolu_control_before_compact'), controlSecond = toolResult('toolu_control_after_compact');
    assert.ok(first && second && message && controlFirst && controlSecond, 'Every call of the turn has a result the model read');
    assert.equal(compactions, 1, 'The CLI compacted exactly once, by itself');
    const order = requests.map(r => r.kind);
    assert.deepEqual(order, ['warmup-1', 'warmup-2', 'step-1', 'compaction', 'step-2', 'step-3'], 'One turn: a step, the compaction, then the same turn continues');
    checks.push(`CLI ${version} compacted by itself between two steps of one root turn (${order.join(' → ')})`);
    assert.ok(!BRIDGE_DENIALS.some(text => first.text.includes(text)) && JSON.parse(first.text).status !== undefined || Array.isArray(JSON.parse(first.text).sessions), 'Before the compaction NAW answers the read');
    checks.push('Before the compaction: the workspace read is answered by NAW');
    assert.ok(!BRIDGE_DENIALS.some(text => second.text.includes(text)), `After the compaction the same turn's read is not refused by the bridge: ${second.text.slice(0, 160)}`);
    assert.equal(second.isError, first.isError, 'The read after the compaction ends as the one before it did');
    assert.deepEqual(Object.keys(JSON.parse(second.text)).sort(), Object.keys(JSON.parse(first.text)).sort(), 'NAW answers both reads with the same kind of result');
    checks.push('After the compaction: the same turn\'s workspace read is answered by NAW again');
    assert.ok(!BRIDGE_DENIALS.some(text => controlFirst.text.includes(text)), `Before the compaction the control call reaches NAW: ${controlFirst.text.slice(0, 160)}`);
    assert.ok(!BRIDGE_DENIALS.some(text => controlSecond.text.includes(text)), `After the compaction the same turn's control call is not refused by the bridge: ${controlSecond.text.slice(0, 160)}`);
    // NAW's own root proof names these when the turn's references are gone.
    assert.ok(!/live-turn-missing|root-turn-missing|native-call-invalidated/.test(controlSecond.text), `After the compaction NAW's root proof holds: ${controlSecond.text.slice(0, 160)}`);
    // Without a space transport in this fixture NAW stops both calls at the same later step, after its root proof.
    const ending = result => { const answer = JSON.parse(result.text); return [result.isError, answer.state, answer.failureReason ?? null]; };
    assert.deepEqual(ending(controlSecond), ending(controlFirst), 'The control call after the compaction ends as the one before it did');
    checks.push(`After the compaction: the same turn's control call passes the bridge and NAW's root proof, and ends as before it (${ending(controlSecond).slice(1).join(', ')})`);
    assert.ok(!BRIDGE_DENIALS.some(text => message.text.includes(text)), `After the compaction the message call reaches NAW: ${message.text.slice(0, 160)}`);
    checks.push('After the compaction: the message call reaches NAW, which answers for its absent recipient');
    const idle = states.filter(s => s.row.state === 'idle' && s.row.steps > 2 && s.row.steps < 5);
    assert.deepEqual(idle, [], 'The session is not shown idle while its turn is still running');
    checks.push('The session stays working from the turn\'s first step to its last');
    const after = read();
    assert.equal(after.nativeId, before.nativeId); assert.equal(after.pid, before.pid);
    fixture.assertClean();
  } catch (error) { failure = error; }
  finally {
    clearInterval(watch);
    save('requests.json', requests.map(r => ({ number: r.number, kind: r.kind, messages: r.body.messages.length, tools: (r.body.tools || []).length, last: parts(r.body.messages.at(-1)).map(p => p.type === 'text' ? p.text.slice(0, 200) : p.type),
      results: r.body.messages.flatMap(m => m.role === 'user' ? parts(m).filter(p => p.type === 'tool_result').map(p => ({ id: p.tool_use_id, isError: p.is_error === true, text: resultText(p).slice(0, 400) })) : []) })));
    save('states.json', states);
    save('tool-results.json', { first: toolResult('toolu_before_compact'), second: toolResult('toolu_after_compact'), message: toolResult('toolu_message_after_compact'),
      controlFirst: toolResult('toolu_control_before_compact'), controlSecond: toolResult('toolu_control_after_compact') });
  }
  const summary = { passed: !failure, version, checks, localResponses: requests.length, compactions, paidModelCalls: 0, fixture: fixture.summary(), failure: failure?.message || null };
  save('result.json', summary);
  console.log(JSON.stringify(summary));
  if (failure) throw failure;
})().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(cleanup);
