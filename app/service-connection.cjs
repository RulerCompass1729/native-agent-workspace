const fs = require('node:fs'), net = require('node:net'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { readFrames, RESPONSE_BYTES } = require('./service-transport.cjs');
const { rebuildState } = require('./state-delta.cjs');
const { uiError } = require('./ui-errors.cjs');
const { displayMessage } = require('./ui-locale.js');
const background = require('./background-operation.cjs');

class ServiceClient extends EventEmitter {
  constructor(socket) {
    super(); this.socket = socket; this.sequence = 0; this.pending = new Map(); this.receipts = new WeakMap(); let received = 0;
    // The last whole state, which a delta frame builds on (state-delta.cjs).
    let state = null;
    readFrames(socket, RESPONSE_BYTES, m => {
      if (m.event === 'state') {
        if (m.delta === 1) {
          try { m = { ...m, data: rebuildState(state, m.data) }; } catch { this.closeReason = 'state-rebuild'; socket.destroy(); return; }
        }
        state = m.data;
      }
      const value = m.event ? m.data : m.value;
      if (value && typeof value === 'object') this.receipts.set(value, ++received);
      if (m.ready) this.emit('ready');
      else if (m.event) this.emit(m.event, m.data);
      else if (this.pending.has(m.id)) {
        const p = this.pending.get(m.id); this.pending.delete(m.id); clearTimeout(p.timer);
        if (m.ok) p.resolve(m.value);
        else {
          const error = new Error(m.error), uiMessage = displayMessage(m.uiMessage);
          if (uiMessage) error.uiMessage = uiMessage;
          p.reject(error);
        }
      }
    });
    // closeReason: who ended this transport, for the connection record (service-reconnect.cjs). 'peer' or an error
    // code: the service's side; 'local-destroy': a frame this side refused (service-transport.cjs readFrames).
    socket.on('error', error => { this.closeReason ||= error.code || 'error'; });
    socket.on('end', () => { this.closeReason ||= 'peer'; });
    socket.on('close', () => { this.closeReason ||= 'local-destroy'; for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(uiError('error.serviceClosed')); } this.pending.clear(); this.emit('closed'); });
  }
  receivedOrder(value) { return this.receipts.get(value); }
  call(method, ...args) {
    // A retained old daemon must reject this method, never ignore a new guard argument.
    if (method === 'input' && args[2] !== undefined) method = 'inputIfCurrent';
    return new Promise((resolve, reject) => {
      if (this.socket.destroyed) return reject(uiError('error.serviceDisconnected'));
      const id = ++this.sequence;
      // A native Claude queued input acknowledges when its next turn starts.
      // Its single pending operation is bounded by the native session/transport,
      // not an arbitrary timer that would suggest retrying accepted native work.
      // From a collaboration space the same input arrives as spaceAction(roomId, 'queueShared', …). An automatic
      // message to a session mid-turn goes the same native way (wakeReceive, session-wake.cjs) and answers when
      // the running turn reads it at a tool boundary or its own turn starts; its other steps keep their own limits.
      const queued = ['queue', 'queueShared', 'wakeReceive'].includes(method) || method === 'spaceAction' && args[1] === 'queueShared';
      const timer = queued ? null : setTimeout(() => { this.pending.delete(id); reject(uiError('error.confirmationTimeout')); }, 40000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(JSON.stringify({ id, method, args, ...(background.current() ? { backgroundActor: background.current() } : {}) }) + '\n');
    });
  }
  close() { this.closeReason ||= 'local-close'; this.socket.end(); }
}
// page: false for a connection no one sees, such as the hidden window an agent's request runs in. The service
// does not count its owner as a window that holds a session (workspace.cjs viewConnected).
async function connectService(dataDir, owner, { page = true } = {}) {
  const filename = path.join(dataDir, 'connection.json'); const stat = fs.statSync(filename);
  if (stat.uid !== process.getuid() || (stat.mode & 0o077)) throw uiError('error.connectionPermissions');
  const info = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (info.protocol !== 1) throw uiError('error.protocol');
  const parent = fs.statSync(path.dirname(info.endpoint));
  if (parent.uid !== process.getuid() || (parent.mode & 0o077)) throw uiError('error.socketPermissions');
  const socket = net.connect(info.endpoint); const client = new ServiceClient(socket);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.destroy(); reject(uiError('error.serviceUnresponsive')); }, 2500);
    client.once('ready', () => { clearTimeout(timer); resolve(); });
    socket.once('error', () => { clearTimeout(timer); reject(uiError('error.serviceConnect')); });
    // stateDelta: this client rebuilds delta state frames. An older service ignores it and sends whole ones.
    socket.once('connect', () => socket.write(JSON.stringify({ protocol: 1, owner, token: info.token, stateDelta: 1, ...(page ? {} : { page: false }) }) + '\n'));
  });
  return client;
}
module.exports = { ServiceClient, connectService };
