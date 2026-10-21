const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { readLayout, writeLayout } = require('./service-layout.cjs');
const { WorkspaceClient } = require('./workspace-client.cjs');
const { processMayBeAlive } = require('./platform.cjs');
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
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('本地操作等待确认超时；请检查原生会话，不会自动重试。')); }, 40000);
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
async function connect(dataDir, owner) {
  const layout = readLayout(dataDir);
  const entries = [];
  try {
    for (const key of layout.entries) {
      const client = await connectService(path.join(dataDir, key), owner);
      const entry = { key, client }; entries.push(entry); entry.state = await client.call('initial');
    }
    const client = new WorkspaceClient(entries, layout.active, dataDir); client.snapshot(); return client;
  } catch (error) { for (const e of entries) e.client.close(); throw error; }
}
async function waitForShutdown(client, dataDir, pid) {
  const lock = path.join(dataDir, 'service.lock');
  for (let i = 0; i < 30; i++) {
    let alive = false;
    if (Number.isSafeInteger(pid) && pid > 1) { try { process.kill(pid, 0); alive = true; } catch (error) { alive = error.code !== 'ESRCH'; } }
    if (client.socket.destroyed && !fs.existsSync(lock) && !alive) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('后台尚未确认关闭；原记录已保留，没有启动替代进程。');
}
async function ensureServiceAt(dataDir, executablePath, defaultWorkspace, allowEndedServiceRestart = false) {
  let stopping = false;
  try {
    const c = await connectService(dataDir, 'bootstrap');
    try {
      const state = await c.call('initial');
      if (state.room.run?.status === 'running' && (!state.capabilities?.includes('nativeInputIsolation') || !state.capabilities?.includes('verifiedHandoffs') || ((!state.capabilities?.includes('structuredClaudeSubmit') || !state.capabilities?.includes('claudePromptIdentity')) && state.sessions.some(s => s.provider === 'claude' && state.room.run.ids.includes(s.id))))) await c.call('pause');
      if (!process.env.NAW_APP_VERSION || state.runtimeVersion === process.env.NAW_APP_VERSION || state.sessions.some(s => s.state !== 'ended')) return state;
      if (state.sessions.length && !state.capabilities?.includes('atomicShutdown')) return state;
      // An ended top-level thread does not certify its shared native server or
      // descendants are gone. Only the explicit continuation dialog can permit
      // retiring such an all-ended backend; normal launch never does so.
      if (!allowEndedServiceRestart && state.sessions.some(s => processMayBeAlive(s.processIdentity) || processMayBeAlive(s.serverIdentity))) return state;
      // Install a newer backend only after every native session has confirmed
      // its end. An active/unknown fleet never becomes an update casualty.
      stopping = true; await c.call('shutdown');
      await waitForShutdown(c, dataDir, state.servicePid);
    } finally { c.close(); }
  } catch (error) { if (stopping) throw error; }
  const lock = path.join(dataDir, 'service.lock');
  if (fs.existsSync(lock)) {
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid < 2) throw new Error('运行服务记录损坏；保留原文件，请检查后再启动。');
    let alive = true; try { process.kill(pid, 0); } catch (error) { alive = error.code !== 'ESRCH'; }
    if (alive) throw new Error('已有运行服务仍存在但无法连接；为保住会话，不启动替代进程。');
    fs.rmSync(lock); // Dead PID only; never kill or replace a live owner.
  }
  const names = ['service-transport.cjs', 'daemon.cjs', 'adapters.cjs', 'workspace.cjs', 'native-history.cjs', 'approval-policy.js', 'observation.cjs', 'pty_host.py', 'claude_hook.py', 'platform.cjs', 'runtime-locations.cjs', 'claude-submit.cjs'];
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
  const child = spawn(executablePath, [path.join(runtime, 'daemon.cjs'), dataDir], { detached: true, stdio: 'ignore', env: { ...process.env, NAW_WORKSPACE: defaultWorkspace, ELECTRON_RUN_AS_NODE: '1' } }); child.unref();
  for (let i = 0; i < 100; i++) { try { const c = await connectService(dataDir, 'bootstrap'); try { return await c.call('initial'); } finally { c.close(); } } catch {} await new Promise(r => setTimeout(r, 100)); }
  throw new Error('运行服务未能启动。原生会话没有自动重发。');
}
function emptyService(state) {
  return state && !state.storageWarning && state.sessions.length === 0 && state.room.messages?.length === 0 && !state.room.run;
}
function emptyStore(directory) {
  try {
    const stored = JSON.parse(fs.readFileSync(path.join(directory, 'workspace.json'), 'utf8'));
    return Array.isArray(stored.sessions) && stored.sessions.length === 0 && Array.isArray(stored.room?.messages) && stored.room.messages.length === 0 && stored.drafts && typeof stored.drafts === 'object' && Object.keys(stored.drafts).length === 0;
  } catch (error) { return error.code === 'ENOENT'; }
}
async function ensureService(dataDir, executablePath, endedServiceKey = null) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const lockFile = path.join(dataDir, 'services.lock');
  if (fs.existsSync(lockFile)) {
    const pid = Number(fs.readFileSync(lockFile, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid < 2) throw new Error('后台启动记录无效；原会话已保留。');
    try { process.kill(pid, 0); throw new Error('后台正在连接，请稍后重试。'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; fs.rmSync(lockFile); }
  }
  const lock = fs.openSync(lockFile, 'wx', 0o600); fs.writeFileSync(lock, String(process.pid)); fs.closeSync(lock);
  try {
    const layout = readLayout(dataDir), states = new Map();
    const defaultWorkspace = process.env.NAW_WORKSPACE || path.join(dataDir, 'workspace');
    if (endedServiceKey !== null) {
      if (!layout.entries.includes(endedServiceKey)) throw new Error('原连接不在当前工作区中；没有更新任何后台。');
      // Explicit continuation owns exactly one store. Do not bootstrap, pause,
      // retire or replace any peer while its existing windows remain connected.
      await ensureServiceAt(path.join(dataDir, endedServiceKey), executablePath, defaultWorkspace, true);
      return;
    }
    for (const key of layout.entries) states.set(key, await ensureServiceAt(path.join(dataDir, key), executablePath, defaultWorkspace));
    const version = process.env.NAW_APP_VERSION;
    if (layout.pending || (version && states.get(layout.active).runtimeVersion !== version)) {
      // Reuse a confirmed all-ended slot before adding another service. Its
      // own history stays in its store; no session is replayed or migrated.
      let key = layout.pending || layout.entries.find(entry => states.get(entry).runtimeVersion === version && states.get(entry).sessions.every(s => s.state === 'ended')) || layout.entries.find(entry => states.get(entry).runtimeVersion === version);
      if (!key) {
        const hash = crypto.createHash('sha256').update(version).update(fs.readFileSync(path.join(__dirname, 'daemon.cjs'))).update(fs.readFileSync(path.join(__dirname, 'adapters.cjs'))).update(fs.readFileSync(path.join(__dirname, 'workspace.cjs'))).digest('hex').slice(0, 20);
        key = `backends/${hash}`;
        fs.mkdirSync(path.join(dataDir, key), { recursive: true, mode: 0o700 });
        // Publish ownership before launching. A crash or failed activation can
        // leave a pending slot, but never an unrecorded detached service.
        if (!layout.entries.includes(key)) { layout.pending = key; writeLayout(dataDir, layout); }
      }
      const next = states.get(key) || await ensureServiceAt(path.join(dataDir, key), executablePath, defaultWorkspace);
      if (version && next.runtimeVersion !== version) throw new Error('新版后台未就绪；旧会话未改动。');
      for (const old of layout.entries) {
        const client = await connectService(path.join(dataDir, old), 'upgrade');
        try { await client.call('pause'); } finally { client.close(); }
      }
      if (!layout.entries.includes(key)) layout.entries.push(key);
      layout.active = key; delete layout.pending; writeLayout(dataDir, layout); states.set(key, next);
    }
    // Retire only truly empty inactive services. Ended sessions, shared replies,
    // orphan drafts and unreadable stores all retain their service and records.
    for (const key of [...layout.entries]) {
      if (key === layout.active || !emptyService(states.get(key)) || !emptyStore(path.join(dataDir, key))) continue;
      const client = await connectService(path.join(dataDir, key), 'retire-empty');
      try {
        const current = await client.call('initial');
        if (!emptyService(current)) continue;
        await client.call('shutdown');
        await waitForShutdown(client, path.join(dataDir, key), current.servicePid);
      } finally { client.close(); }
      layout.entries = layout.entries.filter(entry => entry !== key); writeLayout(dataDir, layout);
    }
  } finally { fs.rmSync(lockFile, { force: true }); }
}
function continuationStatus(state, id) {
  const record = state.sessions.find(s => s.id === id);
  if (!record) throw new Error('找不到原会话；未更改任何连接。');
  if (!record.nativeId) return { ready: false, reason: '原生会话还没有可恢复的历史身份。请先在原生终端核对。' };
  const active = state.sessions.filter(s => s.state !== 'ended');
  if (active.length) return { ready: false, reason: `这个旧连接仍保留 ${active.length} 个未结束会话：${active.map(s => s.name || s.provider).join('、')}。请在原生终端完成工作并退出；共同团队和后台任务也须先核对。仅关闭窗口、回复结束或脱出协作不算退出。随后回到此处更新，原记录和草稿会保留。` };
  if (state.storageWarning) return { ready: false, reason: '原记录存在保存异常。请先解决本地保存问题，再更新连接。' };
  if (!state.capabilities?.includes('atomicShutdown')) return { ready: false, reason: '这个早期连接尚不支持安全的一步更新。请确认所有原生工作及团队已结束后，在“隐私与用量”中主动关闭运行服务，再重新打开应用；原身份、历史和草稿会保留，随后可点“继续原生会话”。仅关闭窗口不会关闭运行服务。' };
  return { ready: true, nativeId: record.nativeId };
}
async function continueService(dataDir, executablePath, id) {
  const client = await connect(dataDir, 'continue-connection');
  let key, nativeId;
  try {
    await client.refresh(); const target = client.route(id), status = continuationStatus(target.state, id);
    if (!status.ready) throw new Error(status.reason);
    key = target.key; nativeId = status.nativeId;
  } finally { client.close(); }
  await ensureService(dataDir, executablePath, key);
  const fresh = await connect(dataDir, 'verify-continuation');
  try {
    const target = fresh.route(id), record = target.state.sessions.find(s => s.id === id);
    if (target.key !== key || target.state.runtimeVersion !== process.env.NAW_APP_VERSION || !['observe', 'structuredClaudeSubmit', 'nativeInputIsolation', 'nativePermissionDefaults'].every(cap => target.state.capabilities?.includes(cap)) || record.nativeId !== nativeId || record.state !== 'ended') throw new Error('新版连接未能确认；原记录已保留，没有自动恢复或发送。');
    return { key };
  } finally { fresh.close(); }
}
module.exports = { ServiceClient, connect, connectService, ensureService, continuationStatus, continueService };
