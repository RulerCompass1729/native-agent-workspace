// Use the existing Peekaboo MCP implementation, not a second NAW control API.
// This process does not alter native permission modes or auto-approve its tools.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');

const VERSION = '4.9.7';
const CLI_SHA256 = '7568134c863c578a11d6f674ce354e1d09b5acf7ad47a2500434dda2382de123';
const SOURCE = '5639e70501010ca9dcae5f594a0b57dd69e9b395';
const CLI = '/opt/homebrew/Cellar/peekaboo/4.9.7/bin/peekaboo';
const NAW_EXECUTABLE = '/Applications/Native Agent Workspace.app/Contents/MacOS/Native Agent Workspace';
function computerUseMcpServer() {
  return { command: process.execPath, args: ['--disable-sigusr1', __filename, '--serve'], env: { ELECTRON_RUN_AS_NODE: '1' } };
}
function codexComputerUseMcpArgs() {
  const server = computerUseMcpServer();
  return [['command', server.command], ['args', server.args], ['env.ELECTRON_RUN_AS_NODE', '1']]
    .flatMap(([key, value]) => ['-c', `mcp_servers.peekaboo.${key}=${JSON.stringify(value)}`]);
}
function bridgeSocket(home = os.homedir()) {
  return path.join(home, 'Library', 'Application Support', 'Peekaboo', 'bridge.sock');
}
function computerUseEnvironment(parent = process.env) {
  // Do not give the desktop bridge a model API key, provider/session identity,
  // inherited local-routing override, Node preload, or caller debug options.
  const env = {};
  for (const key of ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', '__CF_USER_TEXT_ENCODING']) {
    if (typeof parent[key] === 'string') env[key] = parent[key];
  }
  env.PATH = '/usr/bin:/bin';
  env.PEEKABOO_AI_PROVIDERS = '';
  env.PEEKABOO_ALLOW_TOOLS = 'see,inspect_ui,click,type';
  return env;
}
function validateBridgeStatus(status, socket) {
  const selected = status?.data?.selected, handshake = selected?.handshake, identity = handshake?.hostIdentity;
  if (status?.success !== true || selected?.source !== 'remote' || selected?.socketPath !== socket ||
      handshake?.hostKind !== 'gui' || handshake?.trustMode !== 'releaseSignature' ||
      identity?.bundleIdentifier !== 'boo.peekaboo.mac' || identity?.bundleShortVersion !== VERSION ||
      identity?.sourceCommit !== SOURCE || !Number.isSafeInteger(identity?.processIdentifier) || identity.processIdentifier < 2 ||
      !['screenRecording', 'accessibility', 'postEvent'].every(key => handshake?.permissions?.[key] === true)) {
    throw Error('The pinned Peekaboo GUI Bridge is unavailable or unqualified; no local fallback was started.');
  }
}
function prepareComputerUse({ platform = process.platform, arch = process.arch, home = os.homedir(), parent = process.env,
  readFile = fs.readFileSync, stat = fs.lstatSync, uid = process.getuid?.(), query = execFileSync } = {}) {
  if (platform !== 'darwin' || arch !== 'arm64') throw Error('Computer use requires the qualified Apple Silicon Peekaboo installation.');
  let digest;
  try { digest = crypto.createHash('sha256').update(readFile(CLI)).digest('hex'); }
  catch { throw Error('The pinned Peekaboo CLI is not installed; no installation was attempted.'); }
  if (digest !== CLI_SHA256) throw Error('The pinned Peekaboo CLI changed; requalification is required.');
  const socket = bridgeSocket(home), env = computerUseEnvironment(parent);
  let entry;
  try { entry = stat(socket); } catch { throw Error('The Peekaboo GUI Bridge socket is unavailable; no local fallback was started.'); }
  if (!entry.isSocket() || entry.uid !== uid) throw Error('The Peekaboo GUI Bridge socket identity is unconfirmed.');
  let status;
  try { status = JSON.parse(query(CLI, ['bridge', 'status', '--bridge-socket', socket, '--json'],
    { env, encoding: 'utf8', timeout: 8000, maxBuffer: 256 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })); }
  catch { throw Error('The Peekaboo GUI Bridge could not be confirmed; no local fallback was started.'); }
  validateBridgeStatus(status, socket);
  return { command: CLI, args: ['mcp', 'serve', '--transport', 'stdio', '--bridge-socket', socket], env };
}
function nawProcessIdentity(pid) {
  try {
    const { processIdentity } = require('./platform.cjs'), before = processIdentity(pid);
    if (!before) return null;
    const owner = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'uid='], { encoding: 'utf8', timeout: 1000 }).trim();
    const executable = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8', timeout: 1000 }).trim();
    const after = processIdentity(pid);
    if (Number(owner) !== process.getuid() || before.started !== after?.started ||
        fs.realpathSync(executable) !== fs.realpathSync(NAW_EXECUTABLE)) return null;
    return before;
  } catch { return null; }
}
function scopedTools(list) {
  const names = new Set(['see', 'inspect_ui', 'click', 'type']);
  if (!Array.isArray(list?.tools) || list.tools.length !== 4 || new Set(list.tools.map(tool => tool.name)).size !== 4 ||
      list.tools.some(tool => !names.has(tool.name))) throw Error('The qualified Peekaboo tool catalog changed.');
  return { ...list, tools: list.tools.map(tool => {
    const schema = { ...tool.inputSchema, properties: { ...tool.inputSchema.properties } };
    const required = new Set(schema.required || []);
    if (tool.name === 'see' || tool.name === 'inspect_ui') {
      for (const name of ['app_target', 'window_id', 'fresh']) required.add(name);
      delete schema.properties.path;
      delete schema.properties.snapshot;
      schema.properties.app_target = { type: 'string', pattern: '^PID:[1-9][0-9]*$', description: 'Exact installed NAW process, for example PID:123. Screen/frontmost/other apps are refused.' };
      schema.properties.fresh = { type: 'boolean', const: true };
      if (tool.name === 'see') schema.properties.ocr = { type: 'boolean', const: false };
      if (tool.name === 'inspect_ui') {
        required.add('include_elements'); schema.properties.include_elements = { type: 'boolean', const: true };
      }
      schema.properties.web_focus = { type: 'boolean', const: false };
    } else {
      required.add('snapshot');
      if (tool.name === 'click') schema.properties.wait_for = { type: 'integer', minimum: 0, maximum: 5000, default: 5000 };
      if (tool.name === 'type') {
        for (const name of ['delay', 'wpm', 'profile']) delete schema.properties[name];
        required.add('text'); required.add('clear'); schema.properties.clear = { type: 'boolean', const: true };
        schema.properties.text = { type: 'string', minLength: 1, maxLength: 16000, pattern: '^[^\\u0000-\\u001f\\u005c\\u007f]+$', description: 'One printable text line without backslashes for explicit replacement of an authorized field; no Enter/key commands. Observe first and preserve human drafts.' };
      }
    }
    schema.required = [...required];
    return { ...tool, description: 'NAW only: use one exact installed NAW window and a fresh explicit snapshot. For messages prefer collaboration-space @, and use the corresponding session GUI only if that route fails; verify target/body and the visible send result. Never send through a service or change goal status as a substitute for a message. Never approve permissions, issue terminal commands, or replace human drafts without authorization. ' + tool.description, inputSchema: schema };
  }) };
}
function createComputerUseGate({ identity = nawProcessIdentity, now = Date.now } = {}) {
  let receipt = null, busy = false, completionUnknown = false;
  return async (params, invoke) => {
    if (completionUnknown) throw Error('Previous input completion unknown; this computer-use instance refuses further operations.');
    if (busy) throw Error('A computer-use operation is already in flight; observe again after it settles.');
    const name = params?.name, args = params?.arguments;
    if (!['see', 'inspect_ui', 'click', 'type'].includes(name) || !args || typeof args !== 'object' || Array.isArray(args)) throw Error('Unsupported computer-use request.');
    busy = true;
    try {
      if (name === 'see' || name === 'inspect_ui') {
        receipt = null;
        if (name === 'inspect_ui' && args.include_elements !== true) throw Error('AX-only inspection requires include_elements:true for its structured snapshot receipt.');
        if (typeof args.app_target !== 'string' || !/^PID:[1-9][0-9]{0,9}$/.test(args.app_target) ||
            !Number.isSafeInteger(args.window_id) || args.window_id < 1 || args.window_id > 0xffffffff || args.fresh !== true ||
            args.path !== undefined || args.snapshot !== undefined || args.ocr === true || args.web_focus === true) throw Error('Observation requires one exact NAW PID/window and fresh capture; broad targets and capture overrides are refused.');
        const pid = Number(args.app_target.slice(4)), before = identity(pid);
        if (!before) throw Error('The requested process is not the current user\'s installed NAW.');
        const result = await invoke(params), after = identity(pid), meta = result?._meta, snapshot = meta?.snapshot_id;
        if (!result?.isError && typeof snapshot === 'string' && snapshot && after?.started === before.started) {
          let axElements;
          if (name === 'inspect_ui') {
            const target = meta.target_receipt;
            // The pinned host projects out the fallback flag. Its element-table
            // contract sets every is_actionable to false for application fallback.
            axElements = Array.isArray(meta.ui_elements) ? meta.ui_elements.filter(e => e?.is_actionable === true && e.is_enabled === true && typeof e.id === 'string' && e.id) : [];
            if (meta.used_cache !== false || target?.pid !== pid || target.window_id !== args.window_id ||
                typeof target.process_start_identity_decimal !== 'string' || !/^[1-9][0-9]{0,19}$/.test(target.process_start_identity_decimal) ||
                !axElements.length || !Array.isArray(result.content) || !result.content.every(block => block.type === 'text')) {
              throw Error('AX-only observation lacks a qualified exact-window receipt; no input authority was created.');
            }
          }
          receipt = { pid, started: before.started, snapshot, at: now(), axElements };
        }
        return result;
      }
      const previous = receipt; receipt = null;
      if (!previous || args.snapshot !== previous.snapshot || now() - previous.at < 0 || now() - previous.at > 60000 ||
          identity(previous.pid)?.started !== previous.started || (args.pid !== undefined && args.pid !== previous.pid) ||
          (args.coordinate_reference !== undefined && args.coordinate_reference !== previous.snapshot) || args.foreground === true ||
          args.background === false || args.modifiers !== undefined) throw Error('Input requires this client\'s fresh exact NAW snapshot; foreground and stale targets are refused.');
      if (previous.axElements) {
        const element = previous.axElements.find(e => e.id === args.on);
        if (!element || args.coords !== undefined || args.query !== undefined ||
            (name === 'type' && (element.is_value_settable !== true || !['AXTextField', 'AXTextArea', 'AXSearchField', 'AXComboBox'].includes(element.ax_role)))) {
          throw Error('AX-only input requires an exact actionable element ID; typing also requires a settable text field. No coordinate or query input.');
        }
      }
      if (name === 'click' && args.wait_for !== undefined && (!Number.isInteger(args.wait_for) || args.wait_for < 0 || args.wait_for > 5000)) throw Error('Click observation is limited to 5000 milliseconds.');
      if (name === 'type' && (args.clear !== true || typeof args.text !== 'string' || !args.text || args.text.length > 16000 || /[\x00-\x1f\x7f\\]/.test(args.text) ||
          ['delay', 'wpm', 'profile'].some(key => args[key] !== undefined))) {
        throw Error('The qualified type path requires explicit replacement with one printable text line; no Enter or terminal input.');
      }
      try { return await invoke(params); }
      catch (error) { completionUnknown = true; throw error; }
    } finally { busy = false; }
  };
}
async function serve() {
  const config = prepareComputerUse();
  const { JsonRpcLineTransport } = await import('@deepseek-ai/dsh-sdk-protocol');
  const child = spawn(config.command, config.args, { env: config.env, stdio: ['pipe', 'pipe', 'inherit'] });
  const bridge = new JsonRpcLineTransport(child.stdout, child.stdin), client = new JsonRpcLineTransport(process.stdin, process.stdout);
  const gate = createComputerUseGate();
  bridge.start();
  const request = (method, params) => bridge.request(method, params, AbortSignal.timeout(25000));
  client.onRequest(async (method, params) => {
    if (method === 'initialize') return { ...await request(method, params), capabilities: { tools: { listChanged: false } } };
    if (method === 'ping') return request(method, params);
    if (method === 'tools/list') return scopedTools(await request(method, params));
    if (method === 'tools/call') return gate(params, value => request(method, value));
    throw Error('Unsupported computer-use protocol request.');
  });
  client.onNotification((method, params) => { if (method === 'notifications/initialized') bridge.notify(method, params); });
  client.start();
  process.stdin.once('end', () => { client.close(); child.stdin.end(); });
  child.once('error', () => { process.stderr.write('Peekaboo MCP could not start.\n'); process.exitCode = 1; });
  child.once('exit', code => { bridge.close(); client.close(); process.stdin.pause(); process.exitCode = Number.isInteger(code) ? code : 1; });
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  });
}
if (require.main === module) {
  if (process.argv.length !== 3 || process.argv[2] !== '--serve') process.exitCode = 1;
  else serve().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
}
module.exports = { computerUseMcpServer, codexComputerUseMcpArgs, computerUseEnvironment, bridgeSocket, validateBridgeStatus, prepareComputerUse, scopedTools, createComputerUseGate };
