// Native MCP checkpoint. Claude's existing root-bound mod owns its approval path.
// Codex supplies provenance in native MCP metadata; model arguments never identify
// the sender. The helper awaits durable staging through the existing hook socket.
const net = require('node:net');
const { tool } = require('./addressed-handoffs.cjs');
const operator = require('./operator-control.cjs');
function metadataIdentity(meta) {
  let turn = meta?.['x-codex-turn-metadata'];
  if (typeof turn === 'string') { try { turn = JSON.parse(turn); } catch { turn = null; } }
  const identity = { nativeId: meta?.threadId, sessionId: meta?.sessionId, turnId: turn?.turn_id, callId: meta?.callId };
  if (Object.values(identity).some(v => typeof v !== 'string' || !v || v.length > 160) || turn?.thread_id !== identity.nativeId) throw Error('Native workspace tool provenance is missing or inconsistent');
  return identity;
}
function stageNative(identity, args) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(process.env.NAW_MESSAGE_SOCKET); let data = '';
    const fail = () => { socket.destroy(); reject(Error('Workspace staging result is unconfirmed; do not retry.')); };
    socket.setEncoding('utf8'); socket.setTimeout(10000, fail); socket.once('error', fail);
    socket.once('connect', () => socket.write(JSON.stringify({ token: process.env.NAW_MESSAGE_TOKEN, workspaceMessage: true, identity, arguments: args }) + '\n'));
    socket.on('data', part => {
      data += part; if (data.length > 16384) return fail();
      const end = data.indexOf('\n'); if (end < 0) return;
      try { const result = JSON.parse(data.slice(0, end)); socket.destroy(); resolve(result); } catch { fail(); }
    });
    socket.once('end', () => { if (!data.includes('\n')) fail(); });
  });
}
async function main() {
  const { JsonRpcLineTransport } = await import('@deepseek-ai/dsh-sdk-protocol');
  const transport = new JsonRpcLineTransport(process.stdin, process.stdout);
  transport.onRequest(async (method, params) => {
    if (method === 'initialize') return { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'workspace', version: '1' } };
    if (method === 'ping') return {};
    if (method === 'tools/list') return { tools: [tool, ...(process.argv.includes('--codex') ? [] : operator.tools)].map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema,
      annotations: { destructiveHint: false, openWorldHint: false, readOnlyHint: t.name === 'workspace_sessions' } })) };
    if (method !== 'tools/call') throw Error('Unsupported workspace tool request');
    if (!process.argv.includes('--codex') && operator.names.includes(params.name)) {
      const args = operator.validate(params.name, params.arguments);
      // This is only native permission approval. The root-bound bridge must
      // replace it with the synchronous authenticated workspace result.
      return { content: [{ type: 'text', text: JSON.stringify({ approved: true, operator: params.name, arguments: args }) }] };
    }
    if (params.name !== tool.name) throw Error('Unsupported workspace tool request');
    const args = params.arguments; require('./session-wake.cjs').validateArgs(args);
    if (process.argv.includes('--codex')) {
      const result = await stageNative(metadataIdentity(params._meta), args);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: result.status !== 'staged' };
    }
    return { content: [{ type: 'text', text: JSON.stringify({ approved: true, recipient_id: args.recipient_id, message: args.message }) }] };
  });
  transport.start();
}
if (require.main === module) main().catch(() => { process.exitCode = 1; });
module.exports = { metadataIdentity };
