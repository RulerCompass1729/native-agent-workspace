const fs = require('node:fs'), net = require('node:net'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { readFrames, RESPONSE_BYTES } = require('./service-transport.cjs');

class ServiceClient extends EventEmitter {
  constructor(socket) {
    super(); this.socket = socket; this.sequence = 0; this.pending = new Map(); this.receipts = new WeakMap(); let received = 0;
    readFrames(socket, RESPONSE_BYTES, m => {
      const value = m.event ? m.data : m.value;
      if (value && typeof value === 'object') this.receipts.set(value, ++received);
      if (m.ready) this.emit('ready');
      else if (m.event) this.emit(m.event, m.data);
      else if (this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); clearTimeout(p.timer); m.ok ? p.resolve(m.value) : p.reject(new Error(m.error)); }
    });
    socket.on('error', () => {});
    socket.on('close', () => { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('本地运行服务断开；原输入不会自动重发。')); } this.pending.clear(); this.emit('closed'); });
  }
  receivedOrder(value) { return this.receipts.get(value); }
  call(method, ...args) {
    return new Promise((resolve, reject) => {
      if (this.socket.destroyed) return reject(new Error('本地服务未连接。'));
      const id = ++this.sequence;
      // A native Claude queued input acknowledges when its next turn starts.
      // Its single pending operation is bounded by the native session/transport,
      // not an arbitrary timer that would suggest retrying accepted native work.
      const timer = ['queue', 'queueShared'].includes(method) ? null : setTimeout(() => { this.pending.delete(id); reject(new Error('本地操作等待确认超时；请检查原生会话，不会自动重试。')); }, 40000);
      this.pending.set(id, { resolve, reject, timer }); this.socket.write(JSON.stringify({ id, method, args }) + '\n');
    });
  }
  close() { this.socket.end(); }
}
async function connectService(dataDir, owner) {
  const filename = path.join(dataDir, 'connection.json'); const stat = fs.statSync(filename);
  if (stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('本地连接文件权限不安全。');
  const info = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (info.protocol !== 1) throw new Error('已有运行服务的协议不兼容；保留它的会话，不自动重启。');
  const parent = fs.statSync(path.dirname(info.endpoint));
  if (parent.uid !== process.getuid() || (parent.mode & 0o077)) throw new Error('本地 socket 目录权限不安全。');
  const socket = net.connect(info.endpoint); const client = new ServiceClient(socket);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('运行服务未响应。')); }, 2500);
    client.once('ready', () => { clearTimeout(timer); resolve(); });
    socket.once('error', () => { clearTimeout(timer); reject(new Error('无法连接已有运行服务。')); });
    socket.once('connect', () => socket.write(JSON.stringify({ protocol: 1, owner, token: info.token }) + '\n'));
  });
  return client;
}
module.exports = { ServiceClient, connectService };
