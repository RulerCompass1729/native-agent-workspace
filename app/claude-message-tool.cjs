// Native MCP execution checkpoint. Claude owns PreToolUse, rules and approval.
// This process cannot dispatch: it only returns the exact approved arguments.
// The root-bound mod stages a handoff after next(e) returns this result, and the
// workspace revalidates the finite human grant before any actual delivery.
const { tool } = require('./addressed-handoffs.cjs');
async function main() {
  const { JsonRpcLineTransport } = await import('@deepseek-ai/dsh-sdk-protocol');
  const transport = new JsonRpcLineTransport(process.stdin, process.stdout);
  transport.onRequest(async (method, params) => {
    if (method === 'initialize') return { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'workspace', version: '1' } };
    if (method === 'ping') return {};
    if (method === 'tools/list') return { tools: [{ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }] };
    if (method !== 'tools/call' || params.name !== tool.name) throw Error('Unsupported workspace tool request');
    const a = params.arguments;
    if (!a || typeof a !== 'object' || Array.isArray(a) || Object.keys(a).some(k => !['recipient_id', 'message'].includes(k)) ||
      typeof a.recipient_id !== 'string' || typeof a.message !== 'string' || !a.message.trim() || a.message.length > 6000) throw Error('Invalid addressed message');
    return { content: [{ type: 'text', text: JSON.stringify({ approved: true, recipient_id: a.recipient_id, message: a.message }) }] };
  });
  transport.start();
}
main().catch(() => { process.exitCode = 1; });
