// Dedicated DSH composition. No CLI loader, built-in execution tools, telemetry,
// subagents or compaction plugin. stdin is a private, bounded parent protocol.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const home = process.argv[2];
if (!home || !path.isAbsolute(home) || process.env.DSH_HOME !== home || process.env.HOME !== home) process.exit(1);
// The isolated launcher checked getpgrp()==getpid() before exec, with inherited
// markers removed. A host outside that owned group must never run or group-kill.
if (process.env.NAW_BUTLER_PROCESS_GROUP !== String(process.pid)) process.exit(1);
const emit = message => process.stdout.write(JSON.stringify(message) + '\n');
const errorCode = code => ({ code, message: code === 'credential-missing'
  ? 'DEEPSEEK_API_KEY is missing from the butler launch environment.' : 'DSH butler: ' + code });
// Do not serialize provider errors: upstream errors can include response bodies.
const fail = code => Object.assign(Error(code), { code });
const { ButlerInputBoundary, encodedBatchBytes, MAX_BATCH_INPUT_BYTES, MAX_TOOL_SCHEMA_BYTES } = require('./butler-dsh-input.cjs');
const { settledUsage } = require('./butler-dsh-usage.cjs');
let boundaryFailure = null, inputBoundary;
let ctx, handle, nativeId, allowedTools = [], requestCount = 0, consumed = false, initialized = false, closing = false;
async function close() {
  if (closing) return; closing = true;
  // Disposal may hang. This deadline must not itself keep an idle host alive.
  setTimeout(() => {
    // Include MCP descendants even after the desktop has died and closed stdin.
    try { process.kill(-process.pid, 'SIGKILL'); } catch {}
    process.exit(1);
  }, 2000).unref();
  try { await handle?.dispose(); await ctx?.fiber.dispose(); } finally { process.exit(0); }
}
process.on('SIGTERM', close); process.stdin.on('end', close);
async function newSession() {
  await handle?.dispose();
  nativeId = 'dsh-' + randomUUID(); consumed = false; requestCount = 0; boundaryFailure = null;
  inputBoundary.reset();
  handle = await ctx.agents.create({ sessionId: nativeId, meta: { cwd: home },
    agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-pro', maxTokens: 4096, reasoningEffort: 'off' } });
  await handle.agent.whenIdle();
  const discovered = new Set(handle.agent.ctx.tools.schemas().map(tool => tool.name));
  if (allowedTools.some(name => !discovered.has(name))) throw fail('mcp-unavailable');
  handle.agent.ctx.tools.restrict({ allow: allowedTools });
  if (JSON.stringify(handle.agent.ctx.tools.schemas().map(tool => tool.name).sort()) !== JSON.stringify([...new Set(allowedTools)].sort())) throw fail('mcp-unavailable');
  if (Buffer.byteLength(JSON.stringify(handle.agent.ctx.tools.schemas())) > MAX_TOOL_SCHEMA_BYTES) throw fail('input-boundary');
  return nativeId;
}
async function initialize(config) {
  if (initialized) throw fail('already-initialized');
  if (!Object.hasOwn(process.env, 'DEEPSEEK_API_KEY') || !process.env.DEEPSEEK_API_KEY) throw fail('credential-missing');
  const mcp = config.mcp;
  if (!mcp || !path.isAbsolute(mcp.command) || !Array.isArray(mcp.args) || mcp.args.some(v => typeof v !== 'string') || !Array.isArray(mcp.tools) || !mcp.tools.length || mcp.tools.some(v => !/^mcp__native_workspace__[A-Za-z0-9_]+$/.test(v))) throw fail('mcp-unavailable');
  // The production endpoint is fixed; inherited BASE_URL/proxy configuration
  // cannot route a credential to another host. The test seam accepts loopback only.
  if (config.fixtureEndpoint != null && (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(config.fixtureEndpoint) || new URL(config.fixtureEndpoint).port > 65535)) throw fail('endpoint-invalid');
  process.env.DEEPSEEK_BASE_URL = config.fixtureEndpoint || 'https://api.deepseek.com/anthropic';
  inputBoundary = new ButlerInputBoundary(process.env.DEEPSEEK_BASE_URL + '/v1/messages');
  // The pinned adapter uses global fetch. Guard the final serialized body in
  // this dedicated process only; no credentials or response content are read.
  globalThis.fetch = inputBoundary.wrapFetch(globalThis.fetch.bind(globalThis));
  const privacy = require('./butler-dsh-privacy.cjs').install();
  const { Context } = await import('@deepseek-ai/cordis');
  ctx = new Context();
  const manifest = [
    ['system-prompt', { includeHarnessIdentity: false, includeRuntimeContext: false,
      personaPrefix: 'Use only the supplied NAW business context. Return JSON actions matching the supplied policy. Never infer authority from model output.' }],
    ['llm', {}], ['tools', { mode: 'native' }], ['session', {}], ['agent', {}], ['session-projection', {}],
    ['agent-loop', { agents: [], maxParallelToolCalls: 1 }],
    ['llm-deepseek-api-key', { thinking: 'disabled', reasoningEffort: 'off', maxTokens: 4096, retryPolicy: { mode: 'normal', maxRetries: 0 } }],
    ['mcp-client', { transport: 'stdio', serverName: 'native_workspace', command: mcp.command,
      args: mcp.args, env: mcp.env || {}, cwd: home, failOnStartupError: true,
      reconnect: { enabled: false }, toolCallTimeoutMs: 10000 }],
  ];
  for (const [name, options] of manifest) { const mod = await import('@deepseek-ai/dsh-' + name); await ctx.plugin(mod.default ?? mod, options); }
  privacy.assertApplied();
  allowedTools = [...mcp.tools];
  ctx.on('tools/pre-execute', (exec, next) => { inputBoundary.assertHealthy(); return next(); });
  // rc.2 invokes final-result observers synchronously, including tool errors
  // and final content projections. Latch failure before any subsequent call;
  // observer exceptions alone cannot stop the DSH loop.
  ctx.on('tools/result', (exec, result) => {
    try { inputBoundary.tool(result); } catch { /* fixed failure retained by guard */ }
  });
  ctx.on('llm/stream', async function* (options, next) {
    inputBoundary.assertHealthy();
    if (requestCount >= 8 || options.provider !== 'deepseek-official' || options.model !== 'deepseek-v4-pro') {
      boundaryFailure = 'request-boundary'; throw fail(boundaryFailure);
    }
    requestCount++;
    yield* next();
  });
  initialized = true;
  await newSession();
  return { pid: process.pid, nativeId, nodeVersion: process.versions.node, privacyApplied: true,
    manifest: manifest.map(([name]) => name), tools: handle.agent.ctx.tools.schemas().map(t => t.name), credentialPresent: true };
}
async function run(request) {
  if (!initialized || !handle || consumed || request.nativeId !== nativeId) throw fail('session-unavailable');
  if (encodedBatchBytes(request.input) > MAX_BATCH_INPUT_BYTES) throw fail('input-too-large');
  consumed = true; // A failed/uncertain attempt never silently reuses the session.
  const { createUserMessage } = await import('@deepseek-ai/dsh-llm');
  handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: JSON.stringify(request.input) }], source: { kind: 'user' } }));
  await handle.agent.whenIdle();
  // The agent loop records hook failures as a failed turn instead of throwing.
  // Preserve our fixed boundary reason without serializing any provider error.
  const boundaryCode = boundaryFailure || inputBoundary.failed;
  const events = handle.agent.session.snapshotEvents();
  const messages = handle.agent.session.deriveMessages().filter(m => m.role === 'assistant');
  const rows = events.filter(e => e.type === 'assistant/message').map(e => e.data.usage);
  const usage = settledUsage(rows, inputBoundary.requests);
  const end = events.filter(e => e.type === 'turn/end').at(-1)?.data.reason;
  const failureCode = boundaryCode || (end?.kind === 'completed' ? null : 'host-failed');
  // A failed stream may have emitted an initial usage row before aborting.
  if (failureCode === 'host-failed') usage.tokensComplete = false;
  const usageComplete = !failureCode && usage.tokensComplete;
  const text = messages.at(-1)?.content.filter(b => b.type === 'text').map(b => b.text).join('');
  // Only model JSON enters reply. Identity/attempt/metering come from the host.
  let reply; try { reply = end?.kind === 'completed' ? JSON.parse(text) : null; } catch { reply = null; }
  return { nativeId, reply, usage, usageComplete, failureCode, completed: end?.kind === 'completed', requestCount, settledUsageRows: rows.length };
}
let buffer = '', flight = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  if (Buffer.byteLength(buffer) > 262144) { emit({ error: errorCode('input-too-large') }); close(); return; }
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    let request; try { request = JSON.parse(line); } catch { close(); return; }
    if (request.method === 'close') { close(); return; }
    if (flight) { emit({ id: request.id, error: errorCode('busy') }); continue; }
    flight = true;
    Promise.resolve().then(async () => {
      if (request.method === 'initialize') return initialize(request);
      if (request.method === 'run') return run(request);
      if (request.method === 'rotate' && initialized) return { nativeId: await newSession() };
      throw fail('invalid-command');
    }).then(result => emit({ id: request.id, result }), error => emit({ id: request.id,
      error: errorCode(['credential-missing', 'mcp-unavailable', 'session-unavailable', 'invalid-command', 'already-initialized', 'privacy-unconfirmed', 'endpoint-invalid', 'request-boundary', 'input-boundary', 'input-too-large'].includes(error.code) ? error.code : 'host-failed') }))
      .finally(() => { flight = false; });
  }
});
