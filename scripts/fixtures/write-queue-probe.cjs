// Test-only measurement of the service's per-client write queue (service-transport.cjs createWriter).
// Preloaded into a synthetic daemon: the real module is compiled with three observer calls added, and the
// probe refuses to load when any anchor is missing, so it never silently measures nothing.
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '../..');
const log = process.env.NAW_WRITE_QUEUE_LOG;
if (!log || !path.isAbsolute(log)) throw Error('NAW_WRITE_QUEUE_LOG must be an absolute private file');
const file = require.resolve(path.join(root, 'app/service-transport.cjs'));
let source = fs.readFileSync(file, 'utf8');
const anchors = [
  ['blocked = !socket.write(entry.frame);', "blocked = !socket.write(entry.frame); globalThis.__nawWriteProbe(socket, entry.frame, entry.key, queuedBytes, queue.length, 'written');"],
  ['if (over) { refused(over);', 'if (over) { globalThis.__nawWriteProbe(socket, frame, key, queuedBytes, queue.length, over); refused(over);'],
  ['queue.push({ frame, key }); queuedBytes += frame.length;', "queue.push({ frame, key }); queuedBytes += frame.length; globalThis.__nawWriteProbe(socket, frame, key, queuedBytes, queue.length, 'queued');"],
];
for (const [from, to] of anchors) {
  if (source.split(from).length !== 2) throw Error('write-queue probe anchor not found exactly once: ' + from);
  source = source.replace(from, to);
}
const started = Date.now(), connections = new WeakMap(), all = [];
let next = 0;
const connection = socket => {
  if (!connections.has(socket)) { const c = { n: ++next, owner: null, page: null, methods: new Map(), peakBytes: 0, peakFrames: 0, peakWritable: 0, refused: null }; connections.set(socket, c); all.push(c); }
  return connections.get(socket);
};
function kind(frame, c) {
  const head = frame.subarray(0, 48).toString('utf8');
  if (head.startsWith('{"event":"state","delta":1')) return 'state-delta';
  const event = /^\{"event":"([a-zA-Z]+)"/.exec(head);
  if (event) return event[1];
  const reply = /^\{"id":(\d+),"ok":(true|false)/.exec(head);
  if (reply) return 'reply:' + (c.methods.get(Number(reply[1])) || '?');
  return head.startsWith('{"ready"') ? 'ready' : 'other';
}
globalThis.__nawWriteProbe = (socket, frame, key, queuedBytes, frames, action) => {
  const c = connection(socket), writable = socket.writableLength || 0;
  c.peakBytes = Math.max(c.peakBytes, queuedBytes); c.peakFrames = Math.max(c.peakFrames, frames); c.peakWritable = Math.max(c.peakWritable, writable);
  if (action !== 'queued' && action !== 'written') c.refused = action;
  // Small frames that leave at once are counted, not listed, to keep the log readable.
  if (action === 'written' && frame.length < 65536 && queuedBytes === 0) return;
  fs.appendFileSync(log, JSON.stringify({ t: Date.now() - started, conn: c.n, owner: c.owner, page: c.page, action, kind: kind(frame, c), bytes: frame.length, queuedBytes, frames, writable }) + '\n', { mode: 0o600 });
};
const m = new Module(file, module);
m.filename = file; m.paths = Module._nodeModulePaths(path.dirname(file));
m._compile(source, file); m.loaded = true; require.cache[file] = m;
// Requests name the method a reply answers; the handshake names the owner. The token is never recorded.
const readFrames = m.exports.readFrames;
m.exports.readFrames = (socket, max, onMessage, refused) => readFrames(socket, max, message => {
  const c = connection(socket);
  if (typeof message.token === 'string') { c.owner = message.owner; c.page = message.page !== false; }
  else if (Number.isInteger(message.id)) c.methods.set(message.id, message.method);
  onMessage(message);
}, refused);
process.on('exit', () => {
  fs.appendFileSync(log, JSON.stringify({ summary: all.map(({ n, owner, page, peakBytes, peakFrames, peakWritable, refused }) => ({ conn: n, owner, page, peakBytes, peakFrames, peakWritable, refused })) }) + '\n', { mode: 0o600 });
});
process.on('message', request => {
  if (request?.method !== 'writeQueueSummary') return;
  // daily-native.cjs answers every request by requestId, so this reply uses its own key.
  process.send({ writeQueueRequestId: request.id, summary: all.map(({ n, owner, page, peakBytes, peakFrames, peakWritable, refused }) => ({ conn: n, owner, page, peakBytes, peakFrames, peakWritable, refused })) });
});
