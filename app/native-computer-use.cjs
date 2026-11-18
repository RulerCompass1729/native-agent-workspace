// Use existing computer-use MCP implementations, not a second NAW control API.
// This process does not alter native permission modes or auto-approve its tools.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { Transform } = require('node:stream');
const { spawn, execFileSync } = require('node:child_process');

const VERSION = '4.9.7';
const CLI_SHA256 = '7568134c863c578a11d6f674ce354e1d09b5acf7ad47a2500434dda2382de123';
const SOURCE = '5639e70501010ca9dcae5f594a0b57dd69e9b395';
const CLI = '/opt/homebrew/Cellar/peekaboo/4.9.7/bin/peekaboo';
const NAW_EXECUTABLE = '/Applications/Native Agent Workspace.app/Contents/MacOS/Native Agent Workspace';
function computerUseMcpServer({ viewLeaseFile } = {}) {
  if (viewLeaseFile !== undefined && (typeof viewLeaseFile !== 'string' || !path.isAbsolute(viewLeaseFile))) throw Error('An explicit absolute view lease file is required.');
  return { command: process.execPath, args: ['--disable-sigusr1', __filename,
    ...(viewLeaseFile === undefined ? ['--serve'] : ['--serve-view', viewLeaseFile])], env: { ELECTRON_RUN_AS_NODE: '1' } };
}
function codexComputerUseMcpArgs(options) {
  const server = computerUseMcpServer(options);
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
  const tools = list.tools.map(tool => {
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
      if (tool.name === 'click') {
        schema.properties.wait_for = { type: 'integer', minimum: 0, maximum: 5000, default: 5000 };
        required.add('expect');
        schema.properties.expect = { oneOf: [
          { type: 'object', additionalProperties: false, properties: { label: { type: 'string', minLength: 1, maxLength: 512 } }, required: ['label'] },
          { type: 'object', additionalProperties: false, properties: { focused: { const: true } }, required: ['focused'] },
        ], description: 'Postcondition: one exact enabled AX control label absent from the before snapshot and present on the resulting page, or focus on the clicked text field. Use inspect_ui before actions. Dispatch alone is not success.' };
      }
      if (tool.name === 'type') {
        for (const name of ['delay', 'wpm', 'profile']) delete schema.properties[name];
        required.add('text'); required.add('clear'); required.add('on'); schema.properties.clear = { type: 'boolean', const: true };
        schema.properties.text = { type: 'string', minLength: 1, maxLength: 16000, pattern: '^[^\\u0000-\\u001f\\u005c\\u007f]+$', description: 'One printable text line without backslashes for explicit replacement of an authorized field; no Enter/key commands. Observe first and preserve human drafts.' };
      }
    }
    schema.required = [...required];
    return { ...tool, description: 'NAW only: use one exact installed NAW window and a fresh explicit snapshot. For messages prefer collaboration-space @, and use the corresponding session GUI only if that route fails; verify target/body and the visible send result. Never send through a service or change goal status as a substitute for a message. Never approve permissions, issue terminal commands, or replace human drafts without authorization. ' + tool.description, inputSchema: schema };
  });
  // This acknowledgement belongs to the local gate, not the pinned desktop
  // catalog. It never reaches the bridge and never dispatches an input.
  return { ...list, tools: [...tools, {
    name: 'recover_input',
    description: 'After input completion became unknown: first review a fresh see/inspect_ui of the SAME exact NAW process/window, then explicitly acknowledge that the previous action remains unconfirmed. Never retry that action. This clears only the future-input block; observe again before any new authorized input.',
    inputSchema: { type: 'object', additionalProperties: false,
      properties: { app_target: { type: 'string', pattern: '^PID:[1-9][0-9]*$' },
        window_id: { type: 'integer', minimum: 1, maximum: 0xffffffff }, snapshot: { type: 'string', minLength: 1 },
        acknowledge_unknown: { type: 'boolean', const: true } },
      required: ['app_target', 'window_id', 'snapshot', 'acknowledge_unknown'] },
  }] };
}
function freshWindowGeneration(result, pid, windowId) {
  const meta = result?._meta, target = meta?.target_receipt;
  return result?.isError === false && meta?.used_cache === false && target?.pid === pid && target.window_id === windowId &&
    typeof target.process_start_identity_decimal === 'string' && /^[1-9][0-9]{0,19}$/.test(target.process_start_identity_decimal) &&
    Array.isArray(result.content) && result.content.length > 0 && result.content.every(block => ['text', 'image'].includes(block?.type))
    ? target.process_start_identity_decimal : null;
}
function actionObservation(result, pid, windowId) {
  const meta = result?._meta, target = meta?.target_receipt;
  if (result?.isError !== false || typeof meta?.snapshot_id !== 'string' || !meta.snapshot_id || meta.used_cache !== false ||
      target?.pid !== pid || target.window_id !== windowId || typeof target.process_start_identity_decimal !== 'string' ||
      !/^[1-9][0-9]{0,19}$/.test(target.process_start_identity_decimal) || !Array.isArray(meta.ui_elements) ||
      !Array.isArray(result.content) || !result.content.every(block => block.type === 'text')) return null;
  const elements = meta.ui_elements.filter(e => e?.is_actionable === true && e.is_enabled === true && typeof e.id === 'string' && e.id);
  return elements.length ? { meta, elements, generation: target.process_start_identity_decimal } : null;
}
function fieldFocused(element, focus, pid, windowId) {
  const bounds = element?.bounds, frame = focus?.frame;
  return Boolean(bounds && focus?.processIdentifier === pid && focus.windowID === windowId && focus.role === element.ax_role &&
    Array.isArray(frame) && frame.length === 2 && frame.every(v => Array.isArray(v) && v.length === 2) &&
    [bounds.x, bounds.y, bounds.width, bounds.height].every((n, i) => Number.isFinite(n) && Number.isFinite(frame.flat()[i]) && Math.abs(n - frame.flat()[i]) <= 1));
}
function actionResult(output, observed, kind, reason) {
  const meta = output?._meta;
  const refused = meta?.mutation_dispatched === false && meta?.dispatch_state === 'none';
  const result = { outcome: observed ? 'postcondition_observed' : refused ? 'refused' : 'dispatched_unverified', postcondition: kind,
    observed, deliveryVerified: false, dispatchState: typeof meta?.dispatch_state === 'string' ? meta.dispatch_state : 'unconfirmed',
    mutationDispatched: typeof meta?.mutation_dispatched === 'boolean' ? meta.mutation_dispatched : null,
    dispatchedUnitCount: Number.isSafeInteger(meta?.dispatched_unit_count) && meta.dispatched_unit_count >= 0 ? meta.dispatched_unit_count : null,
    retrySafe: refused && meta.retry_safe === true, ...(reason ? { reason } : {}) };
  return { isError: !observed, structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] };
}
function createComputerUseGate({ identity = nawProcessIdentity, now = Date.now } = {}) {
  let receipt = null, busy = false, completionUnknown = null, recovery = null, recoveredSnapshot = null;
  const markUnknown = (previous, postSnapshot) => {
    completionUnknown = { pid: previous.pid, windowId: previous.windowId, started: previous.started,
      generation: previous.generation, snapshot: previous.snapshot, postSnapshot };
    recovery = null;
  };
  return async (params, invoke) => {
    if (busy) throw Error('A computer-use operation is already in flight; observe again after it settles.');
    const name = params?.name, args = params?.arguments;
    if (!['see', 'inspect_ui', 'click', 'type', 'recover_input'].includes(name) || !args || typeof args !== 'object' || Array.isArray(args)) throw Error('Unsupported computer-use request.');
    if (completionUnknown && !['see', 'inspect_ui', 'recover_input'].includes(name)) throw Error('Previous input completion unknown; further input is blocked. Review a fresh see/inspect_ui of the same exact window, then use recover_input to acknowledge it. Do not retry the previous action.');
    busy = true;
    try {
      if (name === 'recover_input') {
        const previous = recovery; recovery = null; receipt = null;
        if (!completionUnknown) throw Error('No input recovery is pending.');
        if (!previous || Object.keys(args).some(key => !['app_target', 'window_id', 'snapshot', 'acknowledge_unknown'].includes(key)) ||
            args.acknowledge_unknown !== true || args.snapshot !== previous.snapshot || args.app_target !== `PID:${previous.pid}` ||
            args.window_id !== previous.windowId || now() - previous.at < 0 || now() - previous.at > 60000 ||
            identity(previous.pid)?.started !== previous.started) {
          throw Error('Recovery requires this client\'s fresh post-lock exact-window observation and explicit acknowledgement. The previous action remains unconfirmed; do not retry it.');
        }
        recoveredSnapshot = previous.snapshot; completionUnknown = null;
        const result = { outcome: 'input_recovery_acknowledged', previousAction: 'unconfirmed', inputBlocked: false,
          retrySafe: false, requiresFreshObservation: true };
        return { isError: false, structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) + '\nDo not retry the previous action. Observe again before any new authorized input.' }] };
      }
      if (name === 'see' || name === 'inspect_ui') {
        receipt = null; recovery = null;
        if (name === 'inspect_ui' && args.include_elements !== true) throw Error('AX-only inspection requires include_elements:true for its structured snapshot receipt.');
        if (typeof args.app_target !== 'string' || !/^PID:[1-9][0-9]{0,9}$/.test(args.app_target) ||
            !Number.isSafeInteger(args.window_id) || args.window_id < 1 || args.window_id > 0xffffffff || args.fresh !== true ||
            args.path !== undefined || args.snapshot !== undefined || args.ocr === true || args.web_focus === true) throw Error('Observation requires one exact NAW PID/window and fresh capture; broad targets and capture overrides are refused.');
        const pid = Number(args.app_target.slice(4)), before = identity(pid);
        if (!before) throw Error('The requested process is not the current user\'s installed NAW.');
        const result = await invoke(params), after = identity(pid), meta = result?._meta, snapshot = meta?.snapshot_id;
        if (result?.isError === true) return result;
        if (result?.isError !== false) throw Error('Observation has no explicit protocol success; no input authority was created.');
        if (typeof snapshot === 'string' && snapshot && after?.started === before.started) {
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
          const observed = actionObservation(result, pid, args.window_id);
          receipt = { pid, windowId: args.window_id, started: before.started, snapshot, at: now(),
            axElements: observed?.elements || axElements, focus: observed?.meta.focused_element, generation: observed?.generation };
        }
        if (!receipt) throw Error('Observation has no qualified snapshot; no input authority was created.');
        if (completionUnknown) {
          // Preserve diagnosis after an uncertain action, without treating a
          // later snapshot as proof that the original input finished safely.
          const generation = freshWindowGeneration(result, pid, args.window_id);
          if (generation && receipt.pid === completionUnknown.pid && receipt.windowId === completionUnknown.windowId &&
              receipt.started === completionUnknown.started && (!completionUnknown.generation || generation === completionUnknown.generation) &&
              snapshot !== completionUnknown.snapshot && snapshot !== completionUnknown.postSnapshot) recovery = { ...receipt, generation };
          receipt = null;
          return { ...result, _meta: { ...result._meta, naw_input_blocked: true, naw_recovery_available: Boolean(recovery) },
            content: [...result.content, { type: 'text', text: 'Previous input completion unknown. This is a read-only observation; input remains blocked. If recovery is available, review this window then call recover_input with this snapshot and acknowledge_unknown:true. Do not retry the previous action.' }] };
        }
        if (recoveredSnapshot !== null) {
          if (snapshot === recoveredSnapshot || !freshWindowGeneration(result, pid, args.window_id)) {
            receipt = null;
            throw Error('Input recovery requires a new fresh exact NAW snapshot after acknowledgement.');
          }
          recoveredSnapshot = null;
        }
        return result;
      }
      const previous = receipt; receipt = null;
      if (!previous || args.snapshot !== previous.snapshot || now() - previous.at < 0 || now() - previous.at > 60000 ||
          identity(previous.pid)?.started !== previous.started || (args.pid !== undefined && args.pid !== previous.pid) ||
          (args.window_id !== undefined && args.window_id !== previous.windowId) ||
          (args.app_target !== undefined && args.app_target !== `PID:${previous.pid}`) ||
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
      const expect = args.expect;
      if (name === 'click' && (!expect || typeof expect !== 'object' || Array.isArray(expect) || Object.keys(expect).length !== 1 ||
          !(expect.focused === true && Object.hasOwn(expect, 'focused') || Object.hasOwn(expect, 'label') && typeof expect.label === 'string' && expect.label.length > 0 && expect.label.length <= 512 && !/[\x00-\x1f\x7f]/.test(expect.label)))) {
        throw Error('Click requires one explicit page or text-field focus postcondition.');
      }
      if (name === 'click' && expect.label && (!previous.axElements || previous.axElements.some(e => e.label === expect.label))) {
        throw Error('Click needs a new page postcondition, not an already visible label; inspect the exact window first.');
      }
      if (name === 'type' && (args.clear !== true || typeof args.text !== 'string' || !args.text || args.text.length > 16000 || /[\x00-\x1f\x7f\\]/.test(args.text) ||
          ['delay', 'wpm', 'profile'].some(key => args[key] !== undefined))) {
        throw Error('The qualified type path requires explicit replacement with one printable text line; no Enter or terminal input.');
      }
      const field = previous.axElements?.find(e => e.id === args.on);
      if ((name === 'type' || expect?.focused) && (!field || field.is_value_settable !== true ||
          !['AXTextField', 'AXTextArea', 'AXSearchField', 'AXComboBox'].includes(field.ax_role) || field.label === 'Terminal input' ||
          (name === 'type' && !fieldFocused(field, previous.focus, previous.pid, previous.windowId)))) {
        throw Error('Input requires the exact focused settable field; terminal and unknown focus are refused.');
      }
      const { expect: _expect, ...wireArgs } = args;
      let output;
      try { output = await invoke({ ...params, arguments: wireArgs }); }
      catch (error) { markUnknown(previous); throw error; }
      if (output?.isError) {
        if (!(output._meta?.mutation_dispatched === false && output._meta?.dispatch_state === 'none')) markUnknown(previous);
        return actionResult(output, false, name === 'type' ? 'text_and_focus' : expect.focused ? 'focus' : 'page', 'Bridge refused or could not confirm the action; do not retry.');
      }
      let post, postResult;
      try { postResult = await invoke({ name: 'inspect_ui', arguments: { app_target: `PID:${previous.pid}`,
        window_id: previous.windowId, fresh: true, include_elements: true } }); post = actionObservation(postResult, previous.pid, previous.windowId); } catch { /* No repeat observation or mutation. */ }
      const current = identity(previous.pid);
      if (!post || current?.started !== previous.started || post.meta.snapshot_id === previous.snapshot ||
          previous.generation && post.generation !== previous.generation) {
        markUnknown(previous, postResult?._meta?.snapshot_id);
        return actionResult(output, false, name === 'type' ? 'text_and_focus' : 'page', 'Fresh same-window post-action observation is unavailable; do not retry.');
      }
      let verified;
      if (name === 'click' && expect.label) verified = post.elements.filter(e => e.label === expect.label).length === 1;
      else {
        const matches = post.elements.filter(e => e.ax_role === field.ax_role && e.label === field.label &&
          e.is_value_settable === true && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(field.bounds?.[key]) &&
            Number.isFinite(e.bounds?.[key]) && Math.abs(e.bounds[key] - field.bounds[key]) <= 1) &&
          fieldFocused(e, post.meta.focused_element, previous.pid, previous.windowId));
        verified = matches.length === 1 && (name !== 'type' || matches[0].value === args.text);
      }
      if (!verified) markUnknown(previous, postResult?._meta?.snapshot_id);
      return actionResult(output, verified, name === 'type' ? 'text_and_focus' : expect.focused ? 'focus' : 'page',
        verified ? undefined : 'Requested page, focus or complete literal text was not observed. Do not retry; further input is blocked until a fresh observation and explicit recover_input acknowledgement.');
    } finally { busy = false; }
  };
}
// Main owns the independent view and stock MCP connection. Native children get
// only this short-lived Unix lease, never a CDP endpoint or the stock catalog.
const VIEW_TOOLS = ['browser_snapshot', 'browser_click', 'browser_type'];
const VIEW_REFUSAL = 'Restricted NAW view unavailable or request refused; no fallback or retry was started.';
function viewTools() {
  return { tools: VIEW_TOOLS.map(name => ({ name,
    description: name === 'browser_snapshot' ? 'Observe only the authorized independent space composer. The returned JSON contains a single-use snapshot receipt.' :
      'Use a fresh snapshot receipt and exact element reference in the authorized space composer. No terminal, permission, clipboard or navigation actions. A tool acknowledgement is not delivery.',
    inputSchema: { type: 'object', additionalProperties: false,
      properties: name === 'browser_snapshot' ? {} : { snapshot: { type: 'string' }, target: { type: 'string', pattern: '^e[0-9]+$' },
        ...(name === 'browser_type' ? { text: { type: 'string', minLength: 1, maxLength: 16000 } } : {}) },
      required: name === 'browser_snapshot' ? [] : ['snapshot', 'target', ...(name === 'browser_type' ? ['text'] : [])] },
  })) };
}
function viewResult(value) { return { content: [{ type: 'text', text: JSON.stringify(value) }] }; }
function createComputerUseViewGate({ grant, invoke, inspect, target, now = Date.now, onRevoke = () => {} }) {
  if (!grant || !['owner', 'spaceId', 'recipientId', 'nativeId', 'memberRevision', 'text'].every(k => grant[k] !== undefined) ||
      typeof grant.text !== 'string' || !grant.text.trim() || grant.text.length > 16000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(grant.text) ||
      ![invoke, inspect, target].every(f => typeof f === 'function')) throw Error(VIEW_REFUSAL);
  grant = Object.freeze({ ...grant });
  let receipt, busy = false, revoked = false, submitted = false;
  const refuse = () => { throw Error(VIEW_REFUSAL); };
  const revoke = () => { if (!revoked) { revoked = true; receipt = null; onRevoke(); } };
  const active = () => { if (revoked) refuse(); };
  const valid = facts => {
    active();
    if (!facts || facts.closed || facts.owner !== grant.owner || facts.spaceId !== grant.spaceId || facts.selected !== 'room' ||
        facts.surface !== 'records' || facts.nativeId !== grant.nativeId || facts.memberRevision !== grant.memberRevision ||
        typeof facts.revision !== 'string' || !facts.revision) { revoke(); refuse(); }
  };
  return { revoke, async call(name, args = {}) {
    active();
    if (busy || !VIEW_TOOLS.includes(name) || (submitted && name !== 'browser_snapshot') || !args || typeof args !== 'object' || Array.isArray(args)) refuse();
    const snapshot = name === 'browser_snapshot', allowed = snapshot ? [] : name === 'browser_click' ? ['snapshot', 'target'] : ['snapshot', 'target', 'text'];
    if (Object.keys(args).some(k => !allowed.includes(k)) || (!snapshot && (typeof args.target !== 'string' || !/^e\d+$/.test(args.target)))) refuse();
    // The grant permits selecting its @ recipient, then replacing only its own
    // initially empty composer with the exact approved body. Never press Enter.
    if (name === 'browser_type' && args.text !== '@' && args.text !== grant.text) refuse();
    const previous = receipt; receipt = null;
    if (!snapshot && (!previous || args.snapshot !== previous.id || now() < previous.at || now() - previous.at > 60000)) refuse();
    busy = true;
    try {
      const facts = await inspect(); valid(facts);
      if (snapshot) {
        const output = await invoke(name, { target: '#room-composer' });
        valid(await inspect());
        if (output?.isError || !Array.isArray(output?.content) || output.content.some(b => b.type !== 'text')) refuse();
        // Stock output can contain tab URLs, generated code and file links.
        // Keep only its single inline composer snapshot; no raw error escapes.
        const text = output.content.map(b => b.text).join('\n');
        const trees = [...text.matchAll(/### Snapshot\s*\n```yaml\n([\s\S]*?)\n```/g)];
        if (trees.length !== 1 || !trees[0][1] || trees[0][1].length > 100000) refuse();
        receipt = { id: crypto.randomUUID(), at: now(), revision: facts.revision };
        return viewResult({ snapshot: receipt.id, tree: trees[0][1] });
      }
      if (facts.revision !== previous.revision) refuse();
      const control = await target(args.target); active();
      if (!control || control.disabled || !control.visible || (name === 'browser_type' ? control.id !== 'shared-input' || control.readOnly : !['mention', 'send'].includes(control.kind))) refuse();
      if (control.kind === 'mention' && control.recipientId !== grant.recipientId) refuse();
      if (name === 'browser_type' && !['', '@', grant.text].includes(facts.body)) refuse();
      if (control.kind === 'send' && (facts.recipientId !== grant.recipientId || facts.body !== grant.text || facts.ready !== true)) refuse();
      // Recheck after resolving the ref, before dispatch. The Main invoker must
      // serialize selection/inspection/action on this one owned stock view.
      const current = await inspect(); valid(current);
      if (current.revision !== facts.revision) refuse();
      // The independent outbox is already populated from the authorized body.
      // Observing that exact value must not retype it through keyboard/IME input.
      if (name === 'browser_type' && args.text === grant.text && current.body === grant.text) {
        return viewResult({ outcome: 'postcondition_observed', postcondition: 'literal_text',
          mutationDispatched: false, observeAgain: true, delivery: 'unconfirmed' });
      }
      const wire = { target: args.target, element: 'Authorized space composer',
        // Preserve the existing @ key-handler path; the authorized task body
        // is replaced as a whole rather than appended one key at a time.
        ...(name === 'browser_type' ? { text: args.text, submit: false, slowly: args.text === '@' } : {}) };
      let output;
      try {
        output = await invoke(name, wire); active(); if (output?.isError) throw Error();
        if (name === 'browser_type') {
          // Stock whole-field fill bypasses OS key synthesis. Its ACK alone
          // still cannot prove that the complete literal body reached the field.
          const after = await inspect(); valid(after);
          if (after.body !== args.text) throw Error();
        }
      }
      catch { revoke(); refuse(); }
      if (control.kind === 'send') submitted = true;
      return viewResult({ outcome: 'dispatched_unconfirmed', observeAgain: true, delivery: 'unconfirmed' });
    } catch { receipt = null; refuse(); }
    finally { busy = false; }
  } };
}
function privateViewEntry(filename, kind) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename) || fs.realpathSync(filename) !== filename) throw Error(VIEW_REFUSAL);
  const dir = fs.lstatSync(path.dirname(filename)), entry = fs.lstatSync(filename), uid = process.getuid?.();
  if (!dir.isDirectory() || dir.uid !== uid || (dir.mode & 0o777) !== 0o700 || entry.uid !== uid ||
      (entry.mode & 0o777) !== 0o600 || (kind === 'file' ? !entry.isFile() || entry.nlink !== 1 || entry.size > 4096 : !entry.isSocket())) throw Error(VIEW_REFUSAL);
  return entry;
}
function readViewLease(filename, now = Date.now()) {
  privateViewEntry(filename, 'file');
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let lease;
  try { lease = JSON.parse(fs.readFileSync(fd, 'utf8')); } finally { fs.closeSync(fd); }
  if (Object.keys(lease).sort().join(',') !== 'capability,expiresAt,socketPath,version' || lease.version !== 1 ||
      typeof lease.capability !== 'string' || !/^[a-f0-9]{64}$/.test(lease.capability) || !Number.isSafeInteger(lease.expiresAt) ||
      lease.expiresAt <= now || lease.expiresAt - now > 300000 || path.dirname(lease.socketPath) !== path.dirname(filename)) throw Error(VIEW_REFUSAL);
  privateViewEntry(lease.socketPath, 'socket');
  return lease;
}
// Bound each newline-delimited MCP frame before the existing SDK parses it.
function boundedViewInput(input, abort) {
  let length = 0;
  const bounded = new Transform({ transform(chunk, _encoding, done) {
    for (const byte of chunk) { length = byte === 10 ? 0 : length + 1; if (length > 256 * 1024) { abort(); return done(Error(VIEW_REFUSAL)); } }
    done(null, chunk);
  } });
  bounded.on('error', abort); input.on('error', abort); input.pipe(bounded); return bounded;
}
async function createComputerUseViewLease({ grant, invoke, inspect, target, dispose, ttlMs = 120000 }) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 300000 || typeof dispose !== 'function') throw Error(VIEW_REFUSAL);
  const { JsonRpcLineTransport } = await import('@deepseek-ai/dsh-sdk-protocol');
  const gate = createComputerUseViewGate({ grant, invoke, inspect, target, onRevoke: () => setImmediate(() => close()) });
  // Canonical short parent avoids Darwin's Unix socket path limit. This is a
  // private Unix listener, not a browser/debugging/TCP listener.
  const dir = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'naw-view-')); fs.chmodSync(dir, 0o700);
  const dirIdentity = fs.lstatSync(dir);
  const socketPath = path.join(dir, 'view.sock'), leaseFile = path.join(dir, 'lease.json');
  if (Buffer.byteLength(socketPath) > 100) { fs.rmdirSync(dir); throw Error(VIEW_REFUSAL); }
  const capability = crypto.randomBytes(32).toString('hex'), expiresAt = Date.now() + ttlMs;
  let socket, transport, timer, authenticated = false, closed = false, closePromise;
  const server = net.createServer(connection => {
    if (socket || closed) { connection.destroy(); return; }
    socket = connection;
    const handshake = setTimeout(() => connection.destroy(), 3000); handshake.unref();
    transport = new JsonRpcLineTransport(boundedViewInput(connection, () => connection.destroy()), connection);
    transport.onRequest(async (method, params) => {
      if (closed || Date.now() >= expiresAt) throw Error(VIEW_REFUSAL);
      if (method === 'initialize' && !authenticated) {
        const offered = params?._meta?.nawViewCapability;
        if (typeof offered !== 'string' || !/^[a-f0-9]{64}$/.test(offered) || !crypto.timingSafeEqual(Buffer.from(offered), Buffer.from(capability))) { connection.destroy(); throw Error(VIEW_REFUSAL); }
        authenticated = true; clearTimeout(handshake);
        return { protocolVersion: '2024-11-05', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'naw-restricted-view', version: '1' } };
      }
      if (!authenticated) throw Error(VIEW_REFUSAL);
      if (method === 'ping') return {};
      if (method === 'tools/list') return viewTools();
      if (method !== 'tools/call') throw Error(VIEW_REFUSAL);
      const deadline = setTimeout(() => { gate.revoke(); }, 15000); deadline.unref();
      try { return await gate.call(params?.name, params?.arguments); } finally { clearTimeout(deadline); }
    });
    transport.start();
    connection.once('close', () => { clearTimeout(handshake); transport.close(); if (authenticated) close(); else socket = null; });
  });
  function close() {
    if (closePromise) return closePromise;
    closed = true; gate.revoke(); clearTimeout(timer); socket?.destroy(); transport?.close();
    closePromise = (async () => {
      await new Promise(resolve => server.close(resolve));
      try { await dispose(); } finally {
        const current = fs.lstatSync(dir);
        if (current.ino !== dirIdentity.ino || current.dev !== dirIdentity.dev) throw Error(VIEW_REFUSAL);
        fs.rmSync(leaseFile, { force: true }); fs.rmdirSync(dir);
      }
    })();
    // Lifecycle callers can await failures, but an expiry callback cannot create
    // an unhandled rejection or expose the owner's raw cleanup error to native.
    closePromise.catch(() => {}); return closePromise;
  }
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    fs.chmodSync(socketPath, 0o600);
    fs.writeFileSync(leaseFile, JSON.stringify({ version: 1, socketPath, capability, expiresAt }), { mode: 0o600, flag: 'wx' });
    timer = setTimeout(close, Math.max(1, expiresAt - Date.now())); timer.unref();
    return { leaseFile, expiresAt, close };
  } catch { await close(); throw Error(VIEW_REFUSAL); }
}
async function serveView(leaseFile) {
  const lease = readViewLease(leaseFile);
  const { JsonRpcLineTransport } = await import('@deepseek-ai/dsh-sdk-protocol');
  const socket = net.createConnection(lease.socketPath);
  const client = new JsonRpcLineTransport(boundedViewInput(process.stdin, () => socket.destroy()), process.stdout);
  const bridge = new JsonRpcLineTransport(boundedViewInput(socket, () => socket.destroy()), socket);
  let initialized = false;
  const close = () => { clearTimeout(expiry); bridge.close(); client.close(); socket.destroy(); process.stdin.pause(); };
  const expiry = setTimeout(close, Math.max(1, lease.expiresAt - Date.now())); expiry.unref();
  socket.on('error', () => { process.exitCode = 1; close(); }); socket.once('close', close);
  bridge.start();
  client.onRequest(async (method, params) => {
    try {
      if (method === 'initialize' && !initialized) {
        const result = await bridge.request(method, { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'naw-native-view', version: '1' },
          _meta: { nawViewCapability: lease.capability } }, AbortSignal.timeout(5000));
        initialized = true; return result;
      }
      if (!initialized || !['ping', 'tools/list', 'tools/call'].includes(method)) throw Error();
      if (method === 'tools/list') return viewTools();
      return await bridge.request(method, params, AbortSignal.timeout(16000));
    } catch { throw Error(VIEW_REFUSAL); }
  });
  client.start(); process.stdin.once('end', close);
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, close);
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
  const view = process.argv.length === 4 && process.argv[2] === '--serve-view';
  const run = view ? () => serveView(process.argv[3]) : process.argv.length === 3 && process.argv[2] === '--serve' ? serve : null;
  if (!run) process.exitCode = 1;
  else run().catch(error => { process.stderr.write((view ? VIEW_REFUSAL : error.message) + '\n'); process.exitCode = 1; });
}
module.exports = { computerUseMcpServer, codexComputerUseMcpArgs, computerUseEnvironment, bridgeSocket, validateBridgeStatus, prepareComputerUse, scopedTools, createComputerUseGate, viewTools, createComputerUseViewGate, createComputerUseViewLease, readViewLease };
