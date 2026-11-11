'use strict';
// Live, read-only business projection, not precomputed model pages. Synthetic only.
const fs = require('node:fs'), path = require('node:path'), readline = require('node:readline');
const directory = process.argv[2];
const { business } = require('./butler-business-pages.cjs').createBusiness(directory);
const log = path.join(directory, 'reads.jsonl');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line); if (m.id === undefined) return;
  let result;
  if (m.method === 'initialize') result = { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'synthetic-business', version: '1' } };
  else if (m.method === 'tools/list') result = { tools: [{ name: 'readBusiness', description: 'Read one complete synthetic business page.', inputSchema: { type: 'object', properties: { kind: { const: 'queue' }, spaceId: { const: 'shared' }, cursor: { type: 'string' } }, required: ['kind', 'spaceId'], additionalProperties: false } }] };
  else if (m.method === 'tools/call' && m.params.name === 'readBusiness') {
    const page = business.invoke('readBusiness', m.params.arguments);
    const text = JSON.stringify(page);
    fs.appendFileSync(log, JSON.stringify({ query: m.params.arguments, page }) + '\n', { mode: 0o600 });
    result = { content: [{ type: 'text', text }], isError: false };
  } else if (m.method === 'ping') result = {};
  else return process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Unsupported fixture method' } }) + '\n');
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\n');
});
