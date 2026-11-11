'use strict';
// Fixed, read-only NAW-shaped MCP fixture. No workspace data or network.
const readline = require('node:readline'), fs = require('node:fs');
const log = process.argv[2];
let pageIndex = 0;
const pagesArg = process.argv.indexOf('--business-pages');
const pages = pagesArg < 0 ? null : JSON.parse(fs.readFileSync(process.argv[pagesArg + 1], 'utf8'));
const mode = process.argv.includes('--input-fixture') ? process.argv[process.argv.indexOf('--input-fixture') + 1] : null;
// Only the shutdown-failure fixture opts in to a child that survives stdin EOF.
if (process.argv.includes('--ignore-eof')) setInterval(() => {}, 1000);
fs.appendFileSync(log, JSON.stringify({ kind: 'started', pid: process.pid, ppid: process.ppid, providerCredentialPresent: Object.hasOwn(process.env, 'DEEPSEEK_API_KEY') }) + '\n', { mode: 0o600 });
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line); if (m.id === undefined) return;
  let result;
  if (m.method === 'initialize') result = { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'synthetic-native-workspace', version: '1' } };
  else if (m.method === 'tools/list') result = { tools: process.argv.includes('--empty') ? [] : [{ name: 'workspace_status', description: mode === 'large-schema' ? 'x'.repeat(300000) : 'Read the fixed synthetic workspace status.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] };
  else if (m.method === 'tools/call' && m.params.name === 'workspace_status' && JSON.stringify(m.params.arguments) === '{}') {
    fs.appendFileSync(log, JSON.stringify({ method: m.method, tool: m.params.name, effect: 'none' }) + '\n', { mode: 0o600 });
    result = { content: [{ type: 'text', text: pages ? JSON.stringify(pages[pageIndex++ % pages.length]) : mode === 'error-tool' ? 'x'.repeat(150000) : mode === 'large-tool' ? 'x'.repeat(400000) : mode === 'accumulated-input' ? 'x'.repeat(65000) : 'SYNTHETIC_WORKSPACE_READY' }], isError: ['error-tool', 'small-error'].includes(mode) };
  } else if (m.method === 'ping') result = {};
  else return process.stdout.write(JSON.stringify({ id: m.id, jsonrpc: '2.0', error: { code: -32601, message: 'Unsupported fixture method' } }) + '\n');
  process.stdout.write(JSON.stringify({ id: m.id, jsonrpc: '2.0', result }) + '\n');
});
