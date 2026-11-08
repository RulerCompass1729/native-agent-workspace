// The native-facing catalog has one scoped task-send tool, no app debugger.
const fs = require('node:fs'), net = require('node:net'), path = require('node:path');
const { metadataIdentity } = require('./claude-message-tool.cjs');
const { validateOutboxArgs } = require('./computer-use-outbox-native.cjs');
const FAIL = 'Outbox delivery is unconfirmed; retain the task and do not resend automatically.';
const outboxTool = { name: 'workspace_outbox', description: 'Send this one task to a specified existing idle NAW agent in the shared space, using an independent outbox without changing the current page. Success requires native receipt and the first actual command. Unknown delivery must not be retried.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {
    recipient_id: { type: 'string', minLength: 1, maxLength: 160 }, message: { type: 'string', minLength: 1, maxLength: 16000 },
    space_id: { type: 'string', enum: ['shared'] } }, required: ['recipient_id', 'message'] },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } };
function privateFile(filename) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename) || fs.realpathSync(filename) !== filename) throw Error(FAIL);
  const stat = fs.lstatSync(filename), parent = fs.lstatSync(path.dirname(filename));
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 || stat.size > 4096 ||
      !parent.isDirectory() || parent.uid !== process.getuid() || (parent.mode & 0o777) !== 0o700) throw Error(FAIL);
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { const current = fs.fstatSync(fd); if (current.ino !== stat.ino || current.dev !== stat.dev) throw Error(FAIL); return JSON.parse(fs.readFileSync(fd, 'utf8')); }
  finally { fs.closeSync(fd); }
}
function requestOutbox(filename, identity, args, signal, control = false) {
  if (control) require('./background-control.cjs').validate(args); else validateOutboxArgs(args);
  const info = privateFile(filename), dir = fs.lstatSync(path.dirname(info.socketPath)), endpoint = fs.lstatSync(info.socketPath);
  if (info.version !== 1 || typeof info.capability !== 'string' || !/^[a-f0-9]{64}$/.test(info.capability) ||
      fs.realpathSync(info.socketPath) !== info.socketPath || !endpoint.isSocket() || endpoint.uid !== process.getuid() || (endpoint.mode & 0o777) !== 0o600 ||
      !dir.isDirectory() || dir.uid !== process.getuid() || (dir.mode & 0o777) !== 0o700) throw Error(FAIL);
  return new Promise((resolve, reject) => {
    const socket = net.connect(info.socketPath); let data = '', settled = false;
    const aborted = () => finish(true);
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', aborted); socket.destroy(); error ? reject(Error(FAIL)) : resolve(value); };
    const timer = setTimeout(() => finish(true), 110000);
    if (signal?.aborted) { finish(true); return; }
    signal?.addEventListener('abort', aborted, { once: true });
    socket.on('error', () => finish(true)); socket.on('end', () => { if (!settled) finish(true); });
    socket.on('connect', () => socket.write(JSON.stringify({ capability: info.capability, identity, arguments: args, ...(control ? { kind: 'control' } : {}) }) + '\n'));
    socket.setEncoding('utf8'); socket.on('data', part => {
      data += part; if (Buffer.byteLength(data) > (control ? 4 * 1024 * 1024 : 100000)) return finish(true);
      const end = data.indexOf('\n'); if (end < 0) return;
      try { finish(false, JSON.parse(data.slice(0, end))); } catch { finish(true); }
    });
  });
}
function outboxMcpServer(descriptorFile) {
  if (typeof descriptorFile !== 'string' || !path.isAbsolute(descriptorFile)) throw Error(FAIL);
  return { command: process.execPath, args: ['--disable-sigusr1', __filename, '--serve', descriptorFile], env: { ELECTRON_RUN_AS_NODE: '1' }, tool_timeout_sec: 115 };
}
function codexOutboxMcpArgs(descriptorFile) {
  const server = outboxMcpServer(descriptorFile);
  return Object.entries({ command: server.command, args: server.args, 'env.ELECTRON_RUN_AS_NODE': '1', tool_timeout_sec: server.tool_timeout_sec })
    .flatMap(([key, value]) => ['-c', `mcp_servers.native_outbox.${key}=${JSON.stringify(value)}`]);
}
// Main's explicit original-host adoption port. It never starts/resumes a
// thread, writes a goal, changes native permissions or reloads user settings.
// The caller supplies the exact already-reviewed config layer/version; this
// method does not read the rest of the user's config or conversation history.
async function registerOriginalOutbox({ rpc, nativeId, descriptorFile, configFile, expectedVersion, valid }) {
  if (!rpc || typeof rpc.call !== 'function' || typeof nativeId !== 'string' || !nativeId || !path.isAbsolute(configFile) ||
      typeof expectedVersion !== 'string' || !expectedVersion || typeof valid !== 'function' || !valid()) throw Error(FAIL);
  privateFile(descriptorFile);
  const server = outboxMcpServer(descriptorFile);
  const result = await rpc.call('config/value/write', { keyPath: 'mcp_servers.native_outbox', value: server,
    mergeStrategy: 'upsert', filePath: configFile, expectedVersion });
  if (!valid() || result.status !== 'ok' || result.filePath !== configFile || typeof result.version !== 'string') throw Error(FAIL);
  await rpc.call('config/mcpServer/reload', {});
  if (!valid()) throw Error(FAIL);
  const catalog = await rpc.call('mcpServerStatus/list', { threadId: nativeId, detail: 'toolsAndAuthOnly' });
  const registered = valid() && catalog.data?.some(s => s.name === 'native_outbox' && Object.hasOwn(s.tools || {}, 'workspace_outbox'));
  return { status: registered ? 'registered' : 'unconfirmed', nativeId, actualNativeCall: false, actualDelivery: false, retry: false };
}
async function main(filename) {
  const { JsonRpcLineTransport } = await import('@deepseek-ai/dsh-sdk-protocol');
  const transport = new JsonRpcLineTransport(process.stdin, process.stdout);
  const lifecycle = new AbortController();
  process.stdin.once('end', () => lifecycle.abort());
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { lifecycle.abort(); transport.close(); process.stdin.pause(); });
  transport.onRequest(async (method, params) => {
    if (method === 'initialize') return { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'naw-outbox', version: '1' } };
    if (method === 'ping') return {};
    if (method === 'tools/list') return { tools: [outboxTool] };
    if (method !== 'tools/call' || params?.name !== outboxTool.name) throw Error(FAIL);
    validateOutboxArgs(params.arguments);
    let result;
    try { result = await requestOutbox(filename, metadataIdentity(params._meta), params.arguments, lifecycle.signal); } catch { throw Error(FAIL); }
    return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: result?.status !== 'working' };
  });
  transport.start();
}
if (require.main === module) {
  if (process.argv.length !== 4 || process.argv[2] !== '--serve') process.exitCode = 1;
  else main(process.argv[3]).catch(() => { process.exitCode = 1; });
}
module.exports = { outboxTool, outboxMcpServer, codexOutboxMcpArgs, registerOriginalOutbox, requestOutbox, privateFile };
