const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');

class ServiceClient extends EventEmitter {
  constructor(socket) {
    super(); this.socket = socket; this.sequence = 0; this.pending = new Map(); let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 16 * 1024 * 1024) return socket.destroy();
      for (let end; (end = buffer.indexOf('\n')) >= 0;) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); let m; try { m = JSON.parse(line); } catch { socket.destroy(); return; }
        if (m.ready) this.emit('ready');
        else if (m.event) this.emit(m.event, m.data);
        else if (this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); clearTimeout(p.timer); m.ok ? p.resolve(m.value) : p.reject(new Error(m.error)); }
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('本地运行服务断开；原输入不会自动重发。')); } this.pending.clear(); this.emit('closed'); });
  }
  call(method, ...args) {
    return new Promise((resolve, reject) => {
      if (this.socket.destroyed) return reject(new Error('本地服务未连接。'));
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('本地操作等待确认超时；请检查原生会话，不会自动重试。')); }, 40000);
      this.pending.set(id, { resolve, reject, timer }); this.socket.write(JSON.stringify({ id, method, args }) + '\n');
    });
  }
  close() { this.socket.end(); }
}
async function connect(dataDir, owner) {
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
async function ensureService(dataDir, executablePath) {
  try {
    const c = await connect(dataDir, 'bootstrap');
    try {
      const state = await c.call('initial');
      if (state.room.run?.status === 'running' && (!state.capabilities?.includes('verifiedHandoffs') || (!state.capabilities?.includes('structuredClaudeSubmit') && state.sessions.some(s => s.provider === 'claude' && state.room.run.ids.includes(s.id))))) await c.call('pause');
      if (!process.env.NAW_APP_VERSION || state.runtimeVersion === process.env.NAW_APP_VERSION || state.sessions.some(s => s.state !== 'ended')) return;
      // Install a newer backend only after every native session has confirmed
      // its end. An active/unknown fleet never becomes an update casualty.
      await c.call('shutdown');
      for (let i = 0; i < 30 && !c.socket.destroyed; i++) await new Promise(r => setTimeout(r, 100));
    } finally { c.close(); }
  } catch {}
  const lock = path.join(dataDir, 'service.lock');
  if (fs.existsSync(lock)) {
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid < 2) throw new Error('运行服务记录损坏；保留原文件，请检查后再启动。');
    let alive = true; try { process.kill(pid, 0); } catch (error) { alive = error.code !== 'ESRCH'; }
    if (alive) throw new Error('已有运行服务仍存在但无法连接；为保住会话，不启动替代进程。');
    fs.rmSync(lock); // Dead PID only; never kill or replace a live owner.
  }
  const names = ['daemon.cjs', 'adapters.cjs', 'workspace.cjs', 'pty_host.py', 'claude_hook.py', 'platform.cjs', 'claude-submit.cjs'];
  const pluginFiles = ['.claude-plugin/plugin.json', 'hooks/hooks.json', 'hooks/register.js'];
  const hash = crypto.createHash('sha256'); for (const name of names) hash.update(fs.readFileSync(path.join(__dirname, name)));
  for (const name of pluginFiles) hash.update(fs.readFileSync(path.join(__dirname, 'claude-bridge', name)));
  const runtime = path.join(dataDir, 'runtimes', hash.digest('hex').slice(0, 16)); fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
  for (const name of names) fs.copyFileSync(path.join(__dirname, name), path.join(runtime, name));
  for (const name of pluginFiles) { const destination = path.join(runtime, 'claude-bridge', name); fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 }); fs.copyFileSync(path.join(__dirname, 'claude-bridge', name), destination); }
  for (const name of ['ws', '@xterm/headless', '@xterm/addon-serialize']) {
    const source = path.dirname(require.resolve(`${name}/package.json`));
    const target = path.join(runtime, 'node_modules', name);
    fs.cpSync(source, target, { recursive: true });
    // These pinned xterm packages omit LICENSE from their npm file list. Their
    // reviewed upstream release shares the full xterm.js MIT notice.
    if (name.startsWith('@xterm/') && !fs.existsSync(path.join(target, 'LICENSE'))) {
      fs.copyFileSync(path.join(path.dirname(require.resolve('@xterm/xterm/package.json')), 'LICENSE'), path.join(target, 'LICENSE'));
    }
  }
  const child = spawn(executablePath, [path.join(runtime, 'daemon.cjs'), dataDir], { detached: true, stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }); child.unref();
  for (let i = 0; i < 100; i++) { try { const c = await connect(dataDir, 'bootstrap'); c.close(); return; } catch {} await new Promise(r => setTimeout(r, 100)); }
  throw new Error('运行服务未能启动。原生会话没有自动重发。');
}
module.exports = { ServiceClient, connect, ensureService };
