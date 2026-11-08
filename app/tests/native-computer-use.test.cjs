const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const { computerUseMcpServer, codexComputerUseMcpArgs, computerUseEnvironment, bridgeSocket,
  validateBridgeStatus, prepareComputerUse, scopedTools, createComputerUseGate } = require('../native-computer-use.cjs');

function status(socket) {
  return { success: true, data: { selected: { source: 'remote', socketPath: socket, handshake: {
    hostKind: 'gui', trustMode: 'releaseSignature', permissions: { screenRecording: true, accessibility: true, postEvent: true },
    hostIdentity: { bundleIdentifier: 'boo.peekaboo.mac', bundleShortVersion: '4.9.7',
      sourceCommit: '5639e70501010ca9dcae5f594a0b57dd69e9b395', processIdentifier: 123 }
  } } } };
}
test('computer-use child gets no parent model credentials, local route override or native identity', () => {
  const parent = { HOME: '/tmp/naw-test-home', LANG: 'en_US.UTF-8', PATH: '/tmp/untrusted',
    OPENAI_API_KEY: 'DO_NOT_COPY', ANTHROPIC_API_KEY: 'DO_NOT_COPY', NAW_MESSAGE_TOKEN: 'DO_NOT_COPY',
    CODEX_THREAD_ID: 'DO_NOT_COPY', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--inspect',
    PEEKABOO_AI_PROVIDERS: 'unrequested-provider', PEEKABOO_NO_REMOTE: '1', PEEKABOO_ALLOW_TOOLS: 'agent,clipboard' };
  const env = computerUseEnvironment(parent);
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'LANG', 'PATH', 'PEEKABOO_AI_PROVIDERS', 'PEEKABOO_ALLOW_TOOLS'].sort());
  assert.equal(env.HOME, parent.HOME); assert.equal(env.PATH, '/usr/bin:/bin');
  assert.equal(env.PEEKABOO_AI_PROVIDERS, ''); assert.equal(env.PEEKABOO_ALLOW_TOOLS, 'see,inspect_ui,click,type');
  assert.equal(parent.PEEKABOO_ALLOW_TOOLS, 'agent,clipboard', 'caller settings are not mutated');
});

test('native tool catalog removes broad capture defaults and requires explicit native-window receipts', () => {
  const list = { tools: ['see', 'inspect_ui', 'click', 'type'].map(name => ({ name, description: '', inputSchema: { type: 'object', properties: { path: { type: 'string' }, snapshot: { type: 'string' } } } })) };
  const scoped = scopedTools(list), see = scoped.tools.find(t => t.name === 'see');
  assert.deepEqual(see.inputSchema.required, ['app_target', 'window_id', 'fresh']);
  assert.equal(see.inputSchema.properties.path, undefined); assert.equal(see.inputSchema.properties.fresh.const, true);
  const inspect = scoped.tools.find(t => t.name === 'inspect_ui');
  assert.deepEqual(inspect.inputSchema.required, ['app_target', 'window_id', 'fresh', 'include_elements']);
  assert.equal(inspect.inputSchema.properties.include_elements.const, true);
  assert.equal(inspect.inputSchema.properties.snapshot, undefined);
  assert.ok(scoped.tools.filter(t => ['click', 'type'].includes(t.name)).every(t => t.inputSchema.required.includes('snapshot')));
  const text = new RegExp(scoped.tools.find(t => t.name === 'type').inputSchema.properties.text.pattern);
  assert.equal(text.test('T58-OWNED'), true); assert.equal(text.test('hello\\n'), false); assert.equal(text.test('hello\n'), false);
  assert.throws(() => scopedTools({ tools: [...list.tools, { name: 'clipboard' }] }), /catalog changed/);
  assert.ok(list.tools[0].inputSchema.properties.path, 'original upstream schema is not mutated');
});
const capture = { name: 'see', arguments: { app_target: 'PID:123', window_id: 456, fresh: true } };
const inspectCapture = { name: 'inspect_ui', arguments: { ...capture.arguments, include_elements: true } };
function inspected(snapshot = 'owned-ax', value = 'OWNED') {
  return { isError: false, content: [{ type: 'text', text: 'Synthetic owned controls' }], _meta: {
    snapshot_id: snapshot, used_cache: false,
    target_receipt: { pid: 123, window_id: 456, process_start_identity_decimal: '1700000000123456' },
    focused_element: { processIdentifier: 123, windowID: 456, role: 'AXTextField', frame: [[10, 20], [100, 30]] },
    ui_elements: [
      { id: 'button', label: 'Synthetic button', ax_role: 'AXButton', is_actionable: true, is_enabled: true },
      { id: 'field', label: 'Synthetic field', value, bounds: { x: 10, y: 20, width: 100, height: 30 }, ax_role: 'AXTextField', is_actionable: true, is_enabled: true, is_value_settable: true },
      { id: 'disabled', ax_role: 'AXButton', is_actionable: true, is_enabled: false },
      ...(snapshot.startsWith('after') ? [{ id: 'new-button', label: 'Synthetic dialog cancel', ax_role: 'AXButton', is_actionable: true, is_enabled: true }] : []),
    ],
  } };
}
test('native AX-only observations are read through the same exact NAW PID/window gate', async () => {
  const gate = createComputerUseGate({ identity: pid => pid === 123 ? { pid, started: 'original' } : null });
  let calls = 0, reads = 0;
  const invoke = async params => { calls++; return params.name === 'inspect_ui' ? inspected(++reads === 1 ? 'owned-ax' : 'after-ax') : {}; };
  for (const args of [{}, { ...inspectCapture.arguments, app_target: 'frontmost' }, { ...inspectCapture.arguments, app_target: 'PID:999' },
    { ...inspectCapture.arguments, window_id: undefined }, { ...inspectCapture.arguments, fresh: false }, { ...inspectCapture.arguments, web_focus: true },
    { ...inspectCapture.arguments, snapshot: 'other-client' }]) await assert.rejects(gate({ name: 'inspect_ui', arguments: args }, invoke));
  assert.equal(calls, 0);
  await gate(inspectCapture, invoke);
  const result = await gate({ name: 'click', arguments: { snapshot: 'owned-ax', on: 'button', expect: { label: 'Synthetic dialog cancel' } } }, invoke);
  assert.equal(result.isError, false);
  assert.equal(calls, 3, 'one action and one read-only post-observation');
});
test('AX-only structured elements are required before any desktop read is invoked', async () => {
  const gate = createComputerUseGate({ identity: pid => ({ pid, started: 'original' }) });let reads = 0;
  for (const include_elements of [undefined, false, 'true']) {
    await assert.rejects(gate({ name: 'inspect_ui', arguments: { ...inspectCapture.arguments, include_elements } }, async () => { reads++; return inspected(); }), /include_elements:true/);
  }
  assert.equal(reads, 0, 'default omission never triggers a discarded desktop read');
});
test('AX-only input authority requires an exact fresh receipt and non-fallback row evidence', async () => {
  const gate = createComputerUseGate({ identity: pid => ({ pid, started: 'original' }) });
  let result, inputs = 0;
  const invoke = async params => params.name === 'inspect_ui' ? result : (inputs++, {});
  const invalid = [
    r => { delete r._meta.target_receipt; }, r => { r._meta.target_receipt.pid = 999; },
    r => { r._meta.target_receipt.window_id = 999; }, r => { delete r._meta.target_receipt.process_start_identity_decimal; },
    r => { r._meta.target_receipt.process_start_identity_decimal = 'not-a-generation'; },
    r => { r._meta.used_cache = true; }, r => { delete r._meta.used_cache; },
    r => { r._meta.ui_elements.forEach(e => { e.is_actionable = false; }); r._meta.actionable_count = 999; },
    r => { r._meta.ui_elements.forEach(e => { e.is_enabled = false; }); },
    r => { r.content.push({ type: 'image', mimeType: 'image/png', data: 'synthetic' }); },
  ];
  for (const change of invalid) {
    result = inspected(); await gate(inspectCapture, invoke);
    result = inspected(); change(result); await assert.rejects(gate(inspectCapture, invoke), /AX-only observation/);
    await assert.rejects(gate({ name: 'click', arguments: { snapshot: 'owned-ax', on: 'button', expect: { label: 'Synthetic dialog cancel' } } }, invoke), /fresh exact NAW snapshot/);
  }
  assert.equal(inputs, 0, 'failed inspection cannot reuse a previous valid input receipt');
});
test('AX-only input targets one current actionable ID; no coordinate/query or non-text typing', async () => {
  const gate = createComputerUseGate({ identity: pid => ({ pid, started: 'original' }) }); let inputs = 0;
  const invoke = async params => params.name === 'inspect_ui' ? inspected(inputs ? 'after-ax' : 'owned-ax') : (inputs++, {});
  for (const request of [
    { name: 'click', arguments: { on: 'missing' } }, { name: 'click', arguments: { on: 'disabled' } },
    { name: 'click', arguments: { coords: '100,200' } }, { name: 'click', arguments: { on: 'button', coords: '100,200' } },
    { name: 'click', arguments: { query: 'button' } },
    { name: 'type', arguments: { on: 'button', text: 'OWNED', clear: true } },
  ]) {
    await gate(inspectCapture, invoke);
    await assert.rejects(gate({ name: request.name, arguments: { snapshot: 'owned-ax', ...request.arguments } }, invoke), /AX-only input/);
  }
  assert.equal(inputs, 0);
  await gate(inspectCapture, invoke); const result = await gate({ name: 'type', arguments: { snapshot: 'owned-ax', on: 'field', text: 'OWNED', clear: true } }, invoke);
  assert.equal(result.isError, false);
  await assert.rejects(gate({ name: 'click', arguments: { snapshot: 'owned-ax', on: 'button', expect: { label: 'Synthetic dialog cancel' } } }, invoke), /fresh exact NAW snapshot/);
  assert.equal(inputs, 1, 'AX-only typing retains the existing single-use receipt');
});
test('broad, non-NAW, file-writing and focusing captures are rejected before invoking Peekaboo', async () => {
  const gate = createComputerUseGate({ identity: pid => pid === 123 ? { pid, started: 'original' } : null });
  let calls = 0; const invoke = async () => { calls++; return { isError: false, _meta: { snapshot_id: 'owned-snapshot' } }; };
  for (const args of [{}, { ...capture.arguments, app_target: 'frontmost' }, { ...capture.arguments, app_target: 'PID:999' },
    { ...capture.arguments, window_id: undefined }, { ...capture.arguments, fresh: false }, { ...capture.arguments, path: '/tmp/not-owned.png' },
    { ...capture.arguments, ocr: true }, { ...capture.arguments, web_focus: true }, { ...capture.arguments, snapshot: 'other-client' }]) {
    await assert.rejects(gate({ name: 'see', arguments: args }, invoke));
  }
  assert.equal(calls, 0);
  await gate(capture, invoke); assert.equal(calls, 1);
});
test('input is tied to the last capture and consumed once even when dispatch result is uncertain', async () => {
  const gate = createComputerUseGate({ identity: pid => ({ pid, started: 'original' }), now: () => 100 });
  let clicks = 0;
  const invoke = async params => params.name === 'see' ? inspected('owned') : (clicks++, { isError: true });
  await assert.rejects(gate({ name: 'click', arguments: { snapshot: 'owned', on: 'button', expect: { label: 'Synthetic dialog cancel' } } }, invoke), /fresh exact NAW snapshot/);
  await gate(capture, invoke);
  await gate({ name: 'click', arguments: { snapshot: 'owned', on: 'button', expect: { label: 'Synthetic dialog cancel' } } }, invoke);
  await assert.rejects(gate({ name: 'click', arguments: { snapshot: 'owned', on: 'button', expect: { label: 'Synthetic dialog cancel' } } }, invoke), /completion unknown/);
  assert.equal(clicks, 1, 'no automatic resend or stale replay');
});
test('uncertain mutation preserves read-only observation without reopening input from this client', async () => {
  for (const name of ['click', 'type']) {
    const gate = createComputerUseGate({ identity: pid => ({ pid, started: 'original' }) });
    let calls = 0;
    const invoke = async params => { calls++; if (['see', 'inspect_ui'].includes(params.name)) return inspected('owned'); throw Error('transport timed out; remote completion unknown'); };
    await gate(capture, invoke);
    await assert.rejects(gate({ name, arguments: { snapshot: 'owned', on: 'field', text: 'owned', clear: true, expect: { label: 'Synthetic dialog cancel' } } }, invoke), /timed out/);
    for (const observation of [capture, inspectCapture]) {
      const result = await gate(observation, invoke);
      assert.equal(result.isError, false);
      assert.equal(result._meta.naw_input_blocked, true);
      assert.match(JSON.stringify(result.content), /completion unknown/);
      for (const action of ['click', 'type']) {
        await assert.rejects(gate({ name: action, arguments: { snapshot: 'owned', on: 'field', text: 'owned', clear: true } }, invoke), /completion unknown/);
      }
    }
    assert.equal(calls, 4, 'only the two explicit observations reach the bridge after uncertain input');
  }
});
test('long click waits are refused before bridge dispatch', async () => {
  const gate = createComputerUseGate({ identity: pid => ({ pid, started: 'original' }) });
  let clicks = 0;
  const invoke = async params => ['see', 'inspect_ui'].includes(params.name) ? inspected(params.name === 'see' ? 'owned' : 'after') : (clicks++, {});
  for (const wait_for of [-1, 5001, 60000, 0.5, '5000']) {
    await gate(capture, invoke);
    await assert.rejects(gate({ name: 'click', arguments: { snapshot: 'owned', on: 'button', expect: { label: 'Synthetic dialog cancel' }, wait_for } }, invoke), /5000/);
  }
  assert.equal(clicks, 0);
  await gate(capture, invoke); assert.equal((await gate({ name: 'click', arguments: { snapshot: 'owned', on: 'button', expect: { label: 'Synthetic dialog cancel' }, wait_for: 5000 } }, invoke)).isError, false);
  assert.equal(clicks, 1);
});
test('stale, changed-process, cross-target and foreground input are refused', async () => {
  let time = 100, started = 'original', calls = 0;
  const gate = createComputerUseGate({ identity: pid => ({ pid, started }), now: () => time });
  const invoke = async params => ['see', 'inspect_ui'].includes(params.name) ? inspected(params.name === 'see' ? 'owned' : 'after') : (calls++, {});
  const click = { name: 'click', arguments: { snapshot: 'owned', on: 'button', expect: { label: 'Synthetic dialog cancel' } } };
  await gate(capture, invoke); assert.equal((await gate(click, invoke)).isError, false);
  assert.equal(calls, 1, 'positive control reaches the mutation exactly once');
  for (const change of [() => { time += 60001; }, () => { started = 'replacement'; }, () => { click.arguments.pid = 999; },
    () => { click.arguments.coordinate_reference = 'other'; }, () => { click.arguments.foreground = true; },
    () => { click.arguments.window_id = 999; }, () => { click.arguments.app_target = 'PID:999'; }]) {
    time = 100; started = 'original'; click.arguments = { snapshot: 'owned', on: 'button', expect: { label: 'Synthetic dialog cancel' } };
    await gate(capture, invoke); change(); await assert.rejects(gate(click, invoke), /fresh exact NAW snapshot/);
    assert.equal(calls, 1, 'the specific identity/freshness guard prevents another mutation');
  }
  assert.equal(calls, 1);
});
test('qualified type is explicit single-line replacement, never an Enter or implicit append', async () => {
  const gate = createComputerUseGate({ identity: pid => ({ pid, started: 'original' }) });let typed = 0;
  let typedText = 'OWNED';
  const invoke = async params => ['see', 'inspect_ui'].includes(params.name) ? inspected(params.name === 'see' ? 'owned' : 'after', typedText) : (typed++, typedText = params.arguments.text, {});
  for (const args of [{ text: 'hello' }, { text: 'hello\n' , clear: true }, { text: 'hello', clear: false },
    ...['n', 't', 'e', 'r'].map(char => ({ text: 'hello\\' + char, clear: true })),
    ...[{ delay: 10000 }, { wpm: 80 }, { profile: 'human' }].map(pacing => ({ text: 'hello', clear: true, ...pacing }))]) {
    await gate(capture, invoke); await assert.rejects(gate({ name: 'type', arguments: { snapshot: 'owned', on: 'field', ...args } }, invoke));
  }
  assert.equal(typed, 0);
  await gate(capture, invoke);assert.equal((await gate({ name: 'type', arguments: { snapshot: 'owned', on: 'field', text: 'T58-OWNED', clear: true } }, invoke)).isError, false);assert.equal(typed, 1);
});
test('computer-use startup requires an explicit signed pinned GUI Bridge with existing grants', () => {
  const socket = bridgeSocket('/tmp/naw-test-home'); assert.doesNotThrow(() => validateBridgeStatus(status(socket), socket));
  const changes = [
    x => { x.success = false; }, x => { x.data.selected.source = 'local'; },
    x => { x.data.selected.socketPath += '.replacement'; }, x => { x.data.selected.handshake.hostKind = 'daemon'; },
    x => { x.data.selected.handshake.trustMode = 'unsigned'; }, x => { x.data.selected.handshake.hostIdentity.bundleShortVersion = '4.9.8'; },
    x => { x.data.selected.handshake.hostIdentity.bundleIdentifier = 'different.app'; },
    x => { x.data.selected.handshake.hostIdentity.sourceCommit = 'different-source'; },
    x => { x.data.selected.handshake.hostIdentity.processIdentifier = 0; },
    ...['screenRecording', 'accessibility', 'postEvent'].map(key => x => { x.data.selected.handshake.permissions[key] = false; })
  ];
  for (const change of changes) { const value = status(socket); change(value); assert.throws(() => validateBridgeStatus(value, socket), /no local fallback/); }
});
test('missing or changed pinned CLI fails before any host query and never installs a replacement', () => {
  let queries = 0; const query = () => { queries++; throw Error('must not run'); };
  assert.throws(() => prepareComputerUse({ platform: 'linux', query }), /qualified Apple Silicon/);
  assert.throws(() => prepareComputerUse({ platform: 'darwin', arch: 'arm64', readFile() { throw Error('absent'); }, query }), /not installed/);
  assert.throws(() => prepareComputerUse({ platform: 'darwin', arch: 'arm64', readFile: () => Buffer.from('untrusted binary'), query }), /changed/);
  assert.equal(queries, 0);
});
test('Claude and Codex get the same stdio launcher without foreground/clipboard grants', () => {
  const server = computerUseMcpServer(), args = codexComputerUseMcpArgs(), decoded = {};
  for (let i = 0; i < args.length; i += 2) { assert.equal(args[i], '-c'); const [key, value] = [args[i + 1].slice(0, args[i + 1].indexOf('=')), args[i + 1].slice(args[i + 1].indexOf('=') + 1)]; decoded[key] = JSON.parse(value); }
  assert.equal(decoded['mcp_servers.peekaboo.command'], server.command);
  assert.deepEqual(decoded['mcp_servers.peekaboo.args'], server.args);
  assert.equal(decoded['mcp_servers.peekaboo.env.ELECTRON_RUN_AS_NODE'], '1');
  assert.deepEqual(server.args, ['--disable-sigusr1', path.resolve(__dirname, '../native-computer-use.cjs'), '--serve']);
  assert.equal(JSON.stringify(server).includes('--allow-foreground'), false);
  assert.equal(JSON.stringify(server).includes('--allow-temporary-clipboard'), false);
});
test('actual provider MCP construction preserves workspace messaging and injects computer use on both launch paths', () => {
  const source = fs.readFileSync(path.join(__dirname, '../adapters.cjs'), 'utf8');
  const begin = source.indexOf('    const mcp = JSON.stringify('), end = source.indexOf('\n    // Native --resume', begin);
  assert.ok(begin >= 0 && end > begin);
  const expression = source.slice(begin + '    const mcp = '.length, end).trim().replace(/;$/, '');
  const claude = JSON.parse(vm.runInNewContext(expression, { JSON, process, path, __dirname: path.resolve(__dirname, '..'), computerUseMcpServer }));
  assert.deepEqual(claude.mcpServers.peekaboo, computerUseMcpServer());
  assert.ok(claude.mcpServers.native_workspace.args.includes(path.resolve(__dirname, '../claude-message-tool.cjs')));
  const a = source.indexOf("      const mcpArgs = ['--disable-sigusr1'"), b = source.indexOf('\n      child.stderr.on', a);
  assert.ok(a >= 0 && b > a);
  let captured;
  const host = { codexBinary: '/tmp/naw-test-codex', codexSocket: '/tmp/naw-test-codex.sock', hookSocket: '/tmp/naw-test-hook.sock', codexMessageToken: 'test-only' };
  vm.runInNewContext('(function(){let child;' + source.slice(a, b) + '\n}).call(host)', {
    host, path, process, __dirname: path.resolve(__dirname, '..'), codexComputerUseMcpArgs,
    nativeEnvironment: () => ({}), spawn: (command, args) => { captured = args; return {}; }
  });
  for (const value of codexComputerUseMcpArgs().filter(x => x !== '-c')) assert.ok(captured.includes(value));
  assert.ok(captured.some(x => x.startsWith('mcp_servers.native_workspace.command=')));
  assert.deepEqual(Array.from(captured).slice(-3), ['app-server', '--listen', 'unix:///tmp/naw-test-codex.sock']);
  // Only the three explicitly approved operator tools join the existing message allowance; Peekaboo remains subject to native permission.
  assert.deepEqual(source.match(/'--allowedTools',\s*'([^']+)'/)[1].split(','), ['workspace_message', 'workspace_sessions', 'workspace_open', 'workspace_report'].map(name => 'mcp__native_workspace__' + name));
});
