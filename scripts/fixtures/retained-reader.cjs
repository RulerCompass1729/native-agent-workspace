// Old portal store plus a controlled native socket. Real current compatibility
// reader and Electron are exercised; no provider process or model is started.
const { EventEmitter } = require('node:events'), http = require('node:http'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { WebSocketServer } = require('ws');
const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '../..');
const { NativeHost } = require(path.join(root, 'app/adapters.cjs'));
const { processIdentity } = require(path.join(root, 'app/platform.cjs'));
let record, server, sockets = new Set(), requests = [];
const history = [
  { turnId: 'history', item: { id: 'human-history', type: 'userMessage', content: [{ type: 'text', text: 'Native terminal question' }] } },
  { turnId: 'history', item: { id: 'agent-history', type: 'agentMessage', text: 'Native terminal answer' } },
];
NativeHost.prototype.start = async function () {
  this.binaries = { codex: 'fixture', python: 'fixture' };
  server = http.createServer(); const wss = new WebSocketServer({ server });
  wss.on('connection', ws => {
    sockets.add(ws); ws.on('close', () => sockets.delete(ws));
    ws.on('message', bytes => {
      const m = JSON.parse(bytes); requests.push(m.method);
      const reply = result => ws.send(JSON.stringify({ id: m.id, result }));
      const event = (method, params) => ws.send(JSON.stringify({ method, params: { threadId: record.nativeId, ...params } }));
      if (m.method === 'initialize') reply({});
      if (m.method === 'thread/loaded/list') reply({ data: [record.nativeId] });
      if (m.method === 'thread/resume') reply({ model: 'synthetic-current-model', thread: { id: record.nativeId, status: { type: 'idle' } } });
      if (m.method === 'thread/items/list') reply({ data: history, nextCursor: null });
      if (m.method === 'turn/start') {
        history.push({ turnId: 'gui-turn', item: { id: 'gui-human', type: 'userMessage', clientId: m.params.clientUserMessageId, content: m.params.input } });
        reply({ turn: { id: 'gui-turn' } });
        event('turn/started', { turn: { id: 'gui-turn' } });
        event('item/agentMessage/delta', { turnId: 'gui-turn', itemId: 'gui-answer', delta: 'Live reply from original session' });
        event('item/started', { turnId: 'gui-turn', item: { id: 'gui-tool', type: 'commandExecution', command: 'Inspect synthetic material' } });
        event('item/commandExecution/outputDelta', { turnId: 'gui-turn', itemId: 'gui-tool', delta: 'Native intermediate tool output' });
      }
    });
  });
  await new Promise(resolve => server.listen(this.codexSocket, resolve)); fs.chmodSync(this.codexSocket, 0o600);
};
NativeHost.prototype.close = function () { for (const ws of sockets) ws.terminate(); server.close(); };
NativeHost.prototype.create = function (s) {
  record = s; const r = new EventEmitter(); r.chatAvailable = false;
  s.nativeId = crypto.randomUUID(); s.model = 'stale-model'; s.pid = process.pid;
  s.processIdentity = processIdentity(process.pid); s.serverIdentity = processIdentity(process.pid);
  r.terminal = { alive: true, input() {}, resize() {}, snapshot: async () => ({ buffer: 'Native terminal fixture', cols: 80, rows: 24, sequence: 0 }) };
  r.openTerminal = async () => r.terminal;
  r.start = async () => r.emit('state', 'idle'); r.stop = async () => ({ state: 'ended' }); return r;
};
process.on('message', q => {
  if (q.method === 'finish') {
    history.push({ turnId: 'gui-turn', item: { id: 'gui-answer', type: 'agentMessage', text: 'Live reply from original session completed' } });
    for (const ws of sockets) {
    ws.send(JSON.stringify({ method: 'item/completed', params: { threadId: record.nativeId, turnId: 'gui-turn', item: { id: 'gui-tool', type: 'commandExecution', command: 'Inspect synthetic material', aggregatedOutput: 'Native intermediate tool output', status: 'completed' } } }));
    ws.send(JSON.stringify({ method: 'item/completed', params: { threadId: record.nativeId, turnId: 'gui-turn', item: { id: 'gui-answer', type: 'agentMessage', text: 'Live reply from original session completed' } } }));
    ws.send(JSON.stringify({ method: 'turn/completed', params: { threadId: record.nativeId, turn: { id: 'gui-turn', status: 'completed' } } }));
    }
  }
  process.send({ id: q.id, requests });
});
