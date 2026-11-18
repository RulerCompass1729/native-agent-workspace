// The provider protocol is synthetic; Terminal/pty_host, Workspace, Codex and
// their input/identity bindings are real. No installed provider or model runs.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const http = require('node:http');
const WebSocket = require('ws');
const { Workspace } = require('../workspace.cjs');
const { Codex, Terminal } = require('../adapters.cjs');
const { QueueDispatcher, CAPABILITY } = require('../queue-dispatch.cjs');
const { RoomState } = require('../room-state.cjs');

const until = async check => {
  for (let n = 0; n < 250; n++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw Error('Bounded synthetic TUI wait expired');
};
test('Codex successor has one native identity and a real PTY accepting its handoff and native input without a seed turn', { timeout: 15000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-default-tui-'));
  const home = path.join(dir, 'home'); fs.mkdirSync(home);
  const socket = path.join(dir, 'native.sock'), server = http.createServer(), native = new WebSocket.Server({ server });
  const nativeId = '11111111-1111-4111-8111-111111111111', requests = [], terminals = [];
  let runtime, w, peer, dispatcher;
  t.after(async () => {
    dispatcher?.close();
    if (runtime) runtime.stopped = true;
    for (const terminal of terminals) { await terminal.stop(); terminal.screen.dispose(); }
    runtime?.terminalBridge?.close();
    for (const client of native.clients) client.terminate();
    await new Promise(resolve => native.close(resolve)); await new Promise(resolve => server.close(resolve));
    w?.close(); fs.rmSync(dir, { recursive: true, force: true });
  });
  native.on('connection', client => {
    peer = client;
    client.on('message', bytes => {
      const request = JSON.parse(bytes); requests.push(request);
      if (request.method === 'thread/start') client.send(JSON.stringify({ id: request.id, result: { thread: { id: nativeId, sessionId: 'synthetic-session', status: { type: 'idle' } }, model: 'synthetic-model' } }));
    });
  });
  await new Promise(resolve => server.listen(socket, resolve));
  const cli = path.join(dir, 'synthetic-tui.cjs');
  fs.writeFileSync(cli, `const WS=require(${JSON.stringify(require.resolve('ws'))}),net=require('node:net');
const client=new WS('ws://localhost',{createConnection:()=>net.connect(process.argv[2])});
client.on('open',()=>client.send(JSON.stringify({id:1,method:'thread/start',params:{}})));
client.on('message',data=>{if(JSON.parse(data).id===1)process.stdout.write('PTY='+process.stdin.isTTY+' READY\\r\\n');});
process.stdin.on('data',data=>process.stdout.write('NATIVE_INPUT:'+data.toString().trim()+'\\r\\n'));
`);
  const host = { privateDir: dir, binaries: { codex: 'synthetic-only' }, codexSocket: socket,
    codexTargets: new Map(), codexProcess: { pid: process.pid }, rpc: { nativeVersion: '0.167.0', connected: true,
      async call(method, params) {
        requests.push({ method, params });
        assert.equal(method, 'turn/start'); assert.equal(params.threadId, nativeId);
        return { turn: { id: 'real-handoff-turn' } };
      } },
    startCodex: async () => {}, createCodex: fn => fn(), close() {},
    create(record) {
      runtime = new Codex(record, this);
      runtime.makeTerminal = argv => {
        const endpoint = argv[argv.indexOf('--remote') + 1].slice('unix://'.length);
        const terminal = runtime.terminal = new Terminal([process.execPath, cli, endpoint], dir, { HOME: home, CODEX_HOME: home, TMPDIR: dir });
        terminals.push(terminal);
        terminal.on('started', pid => runtime.emit('pid', pid)); terminal.on('data', data => runtime.emit('terminal', data));
        return terminal;
      };
      return runtime;
    } };
  w = new Workspace(host, dir);
  const now = Date.now(), room = new RoomState(dir);
  const old = { id: 'old', nativeId: 'old-native', provider: 'codex', cwd: dir, name: 'Synthetic member', state: 'idle', controlRevision: 0, messages: [], roomIds: ['shared'], view: 'chat' };
  const client = {
    snapshot: () => ({ ...w.snapshot(), sessions: [old, ...w.snapshot().sessions].map(s => ({ ...s, serviceCapabilities: [CAPABILITY] })), wakePolicy: { enabled: true } }),
    refresh: async () => {}, close() {},
    route() { return { client: this, state: { capabilities: [CAPABILITY] } }; },
    async call(method, ...args) {
      if (method === 'create') { const o = args[0]; return w.create(o.provider, o.cwd, 'synthetic-window', o.name, o.view, o); }
      if (method === 'dispatch') {
        w.assertNativeContext(args[0], args[2]);
        return w.send(args[0], args[1], 'naw-dispatcher', null, null, null, null, null, null, null, { itemId: args[3] });
      }
      throw Error('Unexpected successor operation: ' + method);
    },
  };
  room.membership = async (_client, id, join) => w.join(id, join);
  const queued = room.queueAdd('Retain the original queued task', old.id);
  dispatcher = new QueueDispatcher({ roomState: room, dataDir: dir, connect: async () => client, settleMs: 0, now: () => now });
  dispatcher.client = client;
  const rotation = dispatcher.rotations.old = { phase: 'creating', provider: 'codex', view: 'terminal', cwd: dir,
    name: old.name, oldNativeId: old.nativeId, oldControl: 0, roomIds: ['shared'], creatingAt: now, handoff: 'Actual saved handoff', carry: { model: 'synthetic-model' } };
  await dispatcher.advanceRotation(old.id, rotation, client.snapshot(), now);
  const id = rotation.newId;
  const startup = { nativeId: w.get(id).nativeId, phase: rotation.phase, assignee: room.queueItems('shared').find(i => i.id === queued).assignee };
  assert.equal(w.get(id).view, 'terminal');
  await until(async () => runtime.terminal?.pid && (await runtime.terminal.snapshot()).buffer.includes('PTY=true READY'));
  if (!startup.nativeId) {
    assert.equal(startup.phase, 'joining', 'native startup must not transfer the old queue early');
    assert.equal(startup.assignee, old.id);
  }
  assert.equal(w.get(id).nativeId, nativeId); assert.equal(w.snapshot().sessions[0].terminalState.alive, true);
  assert.equal(requests.filter(r => r.method === 'thread/start').length, 1);
  assert.equal(requests.some(r => r.method === 'turn/start'), false, 'no invented first input');
  assert.equal(terminals.length, 1); assert.equal(native.clients.size, 1); assert.equal(w.sessions.size, 1);
  assert.equal(w.get(id).skipPermissions, undefined);
  dispatcher.idleSince.set(id, now - 1);
  if (rotation.phase === 'joining') await dispatcher.advanceRotation(old.id, rotation, client.snapshot(), now);
  assert.equal(rotation.phase, 'created', JSON.stringify(require('../queue-dispatch.cjs').sessionReady(client.snapshot().sessions.find(s => s.id === id), { enabled: true })));
  assert.equal(room.queueItems('shared').find(i => i.id === queued).assignee, id);
  await dispatcher.advanceRotation(old.id, rotation, client.snapshot(), now);
  assert.equal(rotation.phase, 'handed');
  const handoffs = requests.filter(r => r.method === 'turn/start');
  assert.equal(handoffs.length, 1); assert.equal(handoffs[0].params.threadId, nativeId);
  assert.match(handoffs[0].params.input[0].text, /Actual saved handoff/);
  assert.equal(w.get(id).messages.filter(m => m.dispatchItem === 'rotation-handoff:old').length, 1);
  assert.equal(room.queueItems('shared').filter(i => i.id === queued).length, 1);
  assert.throws(() => w.input(id, 'wrong-owner', 'other-window'), /控制|controlled/i);
  w.input(id, 'synthetic-native-input\r', 'synthetic-window');
  await until(async () => (await runtime.terminal.snapshot()).buffer.includes('NATIVE_INPUT:synthetic-native-input'));
  assert.equal(w.get(id).nativeId, nativeId); assert.equal(terminals.length, 1);
  assert.equal(peer.readyState, WebSocket.OPEN);
});
