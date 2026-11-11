// Explicit upstream DSH composition: no CLI base, account, telemetry,
// compaction, built-in execution tools or subagent plugin is mounted.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
const [deps, evidence] = process.argv.slice(2);
if (!deps || !evidence || !process.env.DSH_HOME?.includes('/.local/') || !/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(process.env.DEEPSEEK_BASE_URL || '')) throw Error('An isolated loopback fixture launch is required');
const require = createRequire(path.join(deps, 'package.json'));
const load = async name => import(pathToFileURL(require.resolve('@deepseek-ai/' + name)).href);
const started = performance.now();
const { Context } = await load('cordis');
const { createUserMessage } = await load('dsh-llm');
const ctx = new Context();
const manifest = [
  ['system-prompt', { includeHarnessIdentity: false, includeRuntimeContext: false, personaPrefix: 'Process only the provided synthetic butler business context. Return JSON with actions.' }],
  ['llm', {}], ['tools', { mode: 'native' }], ['session', {}], ['agent', {}], ['session-projection', {}],
  ['agent-loop', { agents: [], maxParallelToolCalls: 1 }],
  ['llm-deepseek-api-key', { thinking: 'disabled', reasoningEffort: 'off', maxTokens: 1024, retryPolicy: { mode: 'normal', maxRetries: 0 } }],
  ['mcp-client', { transport: 'stdio', serverName: 'native_workspace', command: process.execPath,
    args: [path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcp.cjs'), path.join(evidence, 'mcp.jsonl')],
    cwd: process.cwd(), failOnStartupError: true, reconnect: { enabled: false }, toolCallTimeoutMs: 3000 }],
];
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
try {
  for (const [name, config] of manifest) { const module = await load('dsh-' + name); await ctx.plugin(module.default ?? module, config); }
  send({ type: 'ready', pid: process.pid, manifest: manifest.map(x => x[0]), startupMs: performance.now() - started, rss: process.memoryUsage().rss });
} catch (e) { send({ type: 'boot-error', message: e.message }); await ctx.fiber.dispose(); process.exit(1); }
let handling = Promise.resolve();
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', line => { handling = handling.then(async () => {
  const request = JSON.parse(line);
  if (request.type === 'status') { send({ type: 'status', pid: process.pid, rss: process.memoryUsage().rss }); return; }
  if (request.type === 'close') { await ctx.fiber.dispose(); process.exit(0); }
  if (request.type !== 'run') throw Error('Invalid fixture command');
  // A new session for every batch; no native history is inherited or loaded.
  const handle = await ctx.agents.create({ sessionId: request.sessionId, meta: { cwd: process.cwd() },
    agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-pro', maxTokens: 1024, reasoningEffort: 'off' } });
  try {
    const agent = handle.agent; await agent.whenIdle();
    agent.followup(createUserMessage({ content: [{ type: 'text', text: JSON.stringify(request.input) }], source: { kind: 'user' } }));
    await agent.whenIdle();
    const flushed = await ctx.sessions.flush(agent.session);
    const events = agent.session.snapshotEvents();
    const requestUsage = events.filter(e => e.type === 'assistant/message').map(e => {
      const usage = e.data.usage;
      if (!usage || !['inputTokens', 'outputTokens', 'totalTokens'].every(k => Number.isSafeInteger(usage[k]) && usage[k] >= 0)) throw Error('Missing measured DSH request usage');
      return { eventSequence: e.seq, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens };
    });
    fs.writeFileSync(path.join(evidence, request.sessionId + '.json'), JSON.stringify(events, null, 2), { mode: 0o600 });
    const messages = agent.session.deriveMessages().filter(e => e.role === 'assistant');
    const final = messages.at(-1)?.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const end = events.filter(e => e.type === 'turn/end').at(-1)?.data.reason;
    send({ type: 'result', sessionId: request.sessionId, final, end, flushed, requestUsage, eventTypes: [...new Set(events.map(e => e.type))], rss: process.memoryUsage().rss });
  } finally { await handle.dispose(); }
}).catch(error => send({ type: 'run-error', message: error.message })); });
process.on('SIGTERM', async () => { await ctx.fiber.dispose(); process.exit(0); });
