'use strict';
// Fixed, read-only NAW-shaped MCP fixture. No workspace data or network.
const readline = require('node:readline'), fs = require('node:fs');
const log = process.argv[2];
fs.appendFileSync(log, JSON.stringify({ kind: 'started', pid: process.pid }) + '\n', { mode: 0o600 });
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line); if (m.id === undefined) return;
  let result;
  if (m.method === 'initialize') result = { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'synthetic-native-workspace', version: '1' } };
  else if (m.method === 'tools/list') result = { tools: [{ name: 'workspace_status', description: 'Read the fixed synthetic workspace status.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] };
  else if (m.method === 'tools/call' && m.params.name === 'workspace_status' && JSON.stringify(m.params.arguments) === '{}') {
    fs.appendFileSync(log, JSON.stringify({ method: m.method, tool: m.params.name, effect: 'none' }) + '\n', { mode: 0o600 });
    result = { content: [{ type: 'text', text: 'SYNTHETIC_WORKSPACE_READY' }], isError: false };
  } else if (m.method === 'ping') result = {};
  else return process.stdout.write(JSON.stringify({ id: m.id, jsonrpc: '2.0', error: { code: -32601, message: 'Unsupported fixture method' } }) + '\n');
  process.stdout.write(JSON.stringify({ id: m.id, jsonrpc: '2.0', result }) + '\n');
});
