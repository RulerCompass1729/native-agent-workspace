const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { computerUseMcpServer, codexComputerUseMcpArgs, createComputerUseViewGate,
  createComputerUseViewLease, readViewLease, viewTools } = require('../native-computer-use.cjs');
const grant = { owner: 'owned-view', spaceId: 'shared', recipientId: 'agent-a', nativeId: 'native-a', memberRevision: 1, text: 'Approved task with literal spaces' };
const tree = '- textbox "Message" [ref=e1]\n- option "Agent A" [ref=e2]\n- button "Send" [ref=e3]';
const rawSnapshot = () => ({ content: [{ type: 'text', text: '### Page\n- Page URL: file:///PRIVATE_PAGE\n### Snapshot\n```yaml\n' + tree + '\n```\n[Saved](file:///PRIVATE_FILE)\n### Ran Playwright code\nPRIVATE_CODE' }] });
const decode = r => JSON.parse(r.content[0].text);
function fixture(options = {}) {
  const facts = { ...grant, selected: 'room', surface: 'records', body: '', revision: '1', ready: true, recipientId: '', ...options.facts };
  const calls = [];
  const inspect = async () => ({ ...facts });
  const target = async ref => ({ id: ref === 'e1' ? 'shared-input' : 'other', kind: ref === 'e2' ? 'mention' : ref === 'e3' ? 'send' : 'other',
    recipientId: grant.recipientId, visible: true, disabled: false, readOnly: false });
  const invoke = async (name, args) => {
    calls.push({ name, args });
    if (name === 'browser_snapshot') return rawSnapshot();
    if (name === 'browser_type') facts.body = args.text;
    if (args.target === 'e2') facts.recipientId = grant.recipientId;
    facts.revision += 'x';
    return { content: [{ type: 'text', text: 'PRIVATE_ACTION_OUTPUT' }] };
  };
  const config = { grant, inspect, target, invoke, ...options };
  return { facts, calls, config, gate: createComputerUseViewGate(config) };
}
async function action(gate, name, target, text) {
  const s = decode(await gate.call('browser_snapshot'));
  return gate.call(name, { snapshot: s.snapshot, target, ...(text === undefined ? {} : { text }) });
}
test('both provider factories explicitly select the same view entry and preserve default/approval settings', () => {
  assert.equal(computerUseMcpServer().args.at(-1), '--serve');
  const lease = '/tmp/owned/approval/lease.json';
  const server = computerUseMcpServer({ viewLeaseFile: lease });
  assert.deepEqual(server.args, ['--disable-sigusr1', require.resolve('../native-computer-use.cjs'), '--serve-view', lease]);
  assert.deepEqual(server.env, { ELECTRON_RUN_AS_NODE: '1' });
  assert.throws(() => computerUseMcpServer({ viewLeaseFile: 'relative' }));
  const flags = codexComputerUseMcpArgs({ viewLeaseFile: lease });
  assert.deepEqual(JSON.parse(flags[3].split('=').slice(1).join('=')), server.args);
  assert.equal(flags.length, 6);
  assert.deepEqual(flags.filter((_, i) => i % 2).map(flag => flag.slice(0, flag.indexOf('='))),
    ['mcp_servers.peekaboo.command', 'mcp_servers.peekaboo.args', 'mcp_servers.peekaboo.env.ELECTRON_RUN_AS_NODE'],
    'only the owned MCP settings are allowed; a file path may contain approval');
  assert.deepEqual(viewTools().tools.map(t => t.name), ['browser_snapshot', 'browser_click', 'browser_type']);
});
test('real composer journey preserves exact text, uses stock typing, and never claims delivery', async () => {
  const { gate, calls } = fixture();
  const first = decode(await gate.call('browser_snapshot'));
  assert.equal(first.tree, tree); assert.ok(first.snapshot);
  assert.ok(!JSON.stringify(first).includes('PRIVATE_'));
  assert.deepEqual(calls[0].args, { target: '#room-composer' });
  await action(gate, 'browser_type', 'e1', '@');
  await action(gate, 'browser_click', 'e2');
  await action(gate, 'browser_type', 'e1', grant.text);
  const out = decode(await action(gate, 'browser_click', 'e3'));
  assert.deepEqual(out, { outcome: 'dispatched_unconfirmed', observeAgain: true, delivery: 'unconfirmed' });
  assert.deepEqual(calls.find(c => c.args.text === grant.text).args, { target: 'e1', element: 'Authorized space composer', text: grant.text, submit: false, slowly: false });
  await assert.rejects(action(gate, 'browser_click', 'e3'), /refused/);
  assert.equal(calls.filter(c => c.name === 'browser_click' && c.args.target === 'e3').length, 1, 'one grant cannot double-send');
});
test('receipt is model-visible, single-use, expires and cannot cross a changed revision', async () => {
  let time = 1000; const { gate, facts, calls } = fixture({ now: () => time });
  let snap = decode(await gate.call('browser_snapshot')).snapshot;
  time += 60001;
  await assert.rejects(gate.call('browser_type', { snapshot: snap, target: 'e1', text: grant.text }));
  snap = decode(await gate.call('browser_snapshot')).snapshot; facts.revision = 'changed';
  await assert.rejects(gate.call('browser_type', { snapshot: snap, target: 'e1', text: grant.text }));
  await assert.rejects(gate.call('browser_type', { snapshot: snap, target: 'e1', text: grant.text }));
  assert.ok(calls.every(c => c.name === 'browser_snapshot'));
});
test('wrong stock selection, space, surface, native identity or membership revokes before reading/input', async () => {
  for (const delta of [{ owner: 'human-view' }, { spaceId: 'other' }, { selected: 'terminal' }, { surface: 'overview' }, { nativeId: 'replacement' }, { memberRevision: 2 }, { closed: true }]) {
    const { gate, facts, calls } = fixture({ facts: delta });
    await assert.rejects(gate.call('browser_snapshot'));
    Object.assign(facts, grant, { selected: 'room', surface: 'records', closed: false });
    await assert.rejects(gate.call('browser_snapshot'));
    assert.equal(calls.length, 0);
  }
});
test('forbidden tools/options/refs, other controls and unauthorized drafts never mutate', async () => {
  const { gate, facts, calls } = fixture();
  for (const name of ['browser_evaluate', 'browser_tabs', 'browser_press_key', 'browser_navigate', 'clipboard']) await assert.rejects(gate.call(name));
  await assert.rejects(gate.call('browser_snapshot', { filename: '/tmp/capture' }));
  for (const [name, target, text] of [['browser_click', 'e999'], ['browser_type', 'e1', 'unapproved'], ['browser_type', '#shared-input', grant.text], ['browser_type', 'e1', 'line\nEnter']])
    await assert.rejects(action(gate, name, target, text));
  facts.body = 'HUMAN_UNSENT'; await assert.rejects(action(gate, 'browser_type', 'e1', grant.text));
  assert.ok(calls.every(c => c.name === 'browser_snapshot'));
});
test('send requires exact recipient, body and current UI readiness; disabled/read-only targets refuse', async () => {
  for (const delta of [{ recipientId: 'other', body: grant.text }, { recipientId: grant.recipientId, body: 'other' }, { recipientId: grant.recipientId, body: grant.text, ready: false }]) {
    const { gate, calls } = fixture({ facts: delta }); await assert.rejects(action(gate, 'browser_click', 'e3')); assert.equal(calls.length, 1);
  }
  for (const delta of [{ disabled: true }, { visible: false }, { readOnly: true }, { id: 'terminal' }]) {
    const f = fixture(); f.config.target = async () => ({ id: 'shared-input', visible: true, ...delta });
    const gate = createComputerUseViewGate(f.config); await assert.rejects(action(gate, 'browser_type', 'e1', grant.text)); assert.equal(f.calls.length, 1);
  }
});
test('no receipt is granted by image/link-only/ambiguous/error snapshots and raw diagnostics stay private', async () => {
  for (const output of [{ isError: true, content: [{ type: 'text', text: 'PRIVATE_ERROR' }] }, { content: [{ type: 'resource_link', uri: 'file:///PRIVATE' }] }, { content: [{ type: 'image', data: 'PRIVATE' }] }, { content: [{ type: 'text', text: '[Snapshot](file:///PRIVATE)' }] }, { content: [{ type: 'text', text: rawSnapshot().content[0].text.repeat(2) }] }]) {
    const { gate } = fixture({ invoke: async () => output });
    await assert.rejects(gate.call('browser_snapshot'), error => !error.message.includes('PRIVATE'));
    await assert.rejects(gate.call('browser_type', { snapshot: 'invented', target: 'e1', text: grant.text }));
  }
});
test('unknown mutation poisons the grant; concurrent inspection and selection changes cannot dispatch', async () => {
  let writes = 0;
  const f = fixture({ invoke: async name => { if (name === 'browser_snapshot') return rawSnapshot(); writes++; throw Error('PRIVATE_STOCK_ERROR'); } });
  await assert.rejects(action(f.gate, 'browser_type', 'e1', grant.text), e => !e.message.includes('PRIVATE'));
  await assert.rejects(f.gate.call('browser_snapshot')); assert.equal(writes, 1);
  let release; const pending = new Promise(r => { release = r; });
  const g = fixture({ inspect: async () => { await pending; return { owner: 'other-view' }; } });
  const first = g.gate.call('browser_snapshot'); await assert.rejects(g.gate.call('browser_snapshot')); release(); await assert.rejects(first); assert.equal(g.calls.length, 0);
});
async function launch(t, f = fixture(), ttlMs = 20000) {
  let disposals = 0;
  const lease = await createComputerUseViewLease({ ...f.config, dispose: async () => { disposals++; }, ttlMs });
  t.after(async () => { await lease.close(); assert.equal(disposals, 1); });
  const server = computerUseMcpServer({ viewLeaseFile: lease.leaseFile });
  const child = spawn(server.command, server.args, { env: { PATH: '/usr/bin:/bin', ...server.env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let errors = ''; child.stderr.on('data', b => { errors += b; });
  t.after(async () => { child.stdin.end(); if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; } assert.ok(!errors.includes('PRIVATE')); });
  const { JsonRpcLineTransport } = await import('@deepseek-ai/dsh-sdk-protocol');
  const transport = new JsonRpcLineTransport(child.stdout, child.stdin); transport.start(); t.after(() => transport.close());
  const rpc = (method, params = {}) => transport.request(method, params, AbortSignal.timeout(3000));
  return { ...f, lease, child, rpc };
}
test('actual --serve-view stdio entry bypasses Peekaboo, authenticates private lease and completes the three-tool task', async t => {
  const { rpc, calls, lease } = await launch(t);
  const init = await rpc('initialize', { clientInfo: { name: 'isolated-no-model' } }); assert.equal(init.serverInfo.name, 'naw-restricted-view');
  assert.deepEqual((await rpc('tools/list')).tools.map(t => t.name), viewTools().tools.map(t => t.name));
  const call = (name, args) => rpc('tools/call', { name, arguments: args });
  const snap = decode(await call('browser_snapshot', {}));
  const response = decode(await call('browser_type', { snapshot: snap.snapshot, target: 'e1', text: grant.text }));
  assert.equal(response.delivery, 'unconfirmed'); assert.equal(calls[1].args.text, grant.text);
  await assert.rejects(call('browser_evaluate', {})); await assert.rejects(rpc('resources/list'));
  const raw = fs.readFileSync(lease.leaseFile, 'utf8'); assert.ok(!raw.includes('http') && !raw.includes(grant.text) && !raw.includes(grant.nativeId));
});
test('private descriptor rejects symlinks, readable permissions, extra destinations and expiry', async t => {
  const f = fixture(); const lease = await createComputerUseViewLease({ ...f.config, dispose: async () => {} }); t.after(() => lease.close());
  const original = fs.readFileSync(lease.leaseFile, 'utf8');
  assert.ok(readViewLease(lease.leaseFile).expiresAt > Date.now());
  const link = lease.leaseFile + '.link'; fs.symlinkSync(lease.leaseFile, link); assert.throws(() => readViewLease(link)); fs.unlinkSync(link);
  fs.chmodSync(lease.leaseFile, 0o644); assert.throws(() => readViewLease(lease.leaseFile)); fs.chmodSync(lease.leaseFile, 0o600);
  fs.writeFileSync(lease.leaseFile, JSON.stringify({ ...JSON.parse(original), endpoint: 'http://127.0.0.1:9222' })); assert.throws(() => readViewLease(lease.leaseFile));
  fs.writeFileSync(lease.leaseFile, original); assert.throws(() => readViewLease(lease.leaseFile, Date.now() + 300001));
});
test('unauthenticated local MCP cannot list/call tools; authenticated disconnect and expiry dispose exact lease', async t => {
  const f = fixture(); let disposed = 0;
  const lease = await createComputerUseViewLease({ ...f.config, dispose: async () => { disposed++; } }); t.after(() => lease.close());
  const descriptor = readViewLease(lease.leaseFile), socket = net.createConnection(descriptor.socketPath);
  const { JsonRpcLineTransport } = await import('@deepseek-ai/dsh-sdk-protocol');
  const rpc = new JsonRpcLineTransport(socket, socket); rpc.start();
  await assert.rejects(rpc.request('tools/list', {}, AbortSignal.timeout(1000))); assert.equal(f.calls.length, 0);
  await rpc.request('initialize', { _meta: { nawViewCapability: descriptor.capability } }, AbortSignal.timeout(1000));
  rpc.close(); const closed = once(socket, 'close'); socket.destroy(); await closed;
  await lease.close(); assert.equal(disposed, 1); assert.ok(!fs.existsSync(lease.leaseFile));
  const short = await createComputerUseViewLease({ ...f.config, dispose: async () => { disposed++; }, ttlMs: 30 });
  await new Promise(resolve => setTimeout(resolve, 70)); await short.close(); assert.equal(disposed, 2); assert.ok(!fs.existsSync(short.leaseFile));
});
