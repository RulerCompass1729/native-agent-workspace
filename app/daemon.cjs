// The native processes belong here, never to an Electron window or renderer.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { NativeHost } = require('./adapters.cjs');
const { Workspace } = require('./workspace.cjs');

async function main() {
  const dataDir = process.argv[2];
  if (!dataDir || !path.isAbsolute(dataDir)) throw new Error('Data directory required');
  const lockPath = path.join(dataDir, 'service.lock');
  const lock = fs.openSync(lockPath, 'wx', 0o600); fs.writeFileSync(lock, String(process.pid)); fs.closeSync(lock);
  const privateDir = fs.mkdtempSync('/tmp/naw-service-'); fs.chmodSync(privateDir, 0o700);
  const endpoint = path.join(privateDir, 'desktop.sock');
  const token = crypto.randomBytes(32).toString('hex');
  const defaultWorkspace = process.env.NAW_WORKSPACE || path.join(dataDir, 'workspace');
  fs.mkdirSync(defaultWorkspace, { recursive: true, mode: 0o700 });
  const host = new NativeHost(privateDir); await host.start();
  const workspace = new Workspace(host, dataDir); const clients = new Set();
  const send = (client, value) => { if (!client.destroyed && client.writableLength < 8 * 1024 * 1024) client.write(JSON.stringify(value) + '\n'); else client.destroy(); };
  const broadcast = (event, data) => { for (const client of clients) send(client, { event, data }); };
  let scheduled = false;
  workspace.on('change', () => { if (!scheduled) { scheduled = true; setTimeout(() => { scheduled = false; broadcast('state', workspace.snapshot()); }, 35); } });
  workspace.on('terminal', data => broadcast('terminal', data));
  let shuttingDown = false;
  const dispatch = async (owner, method, args) => {
    if (shuttingDown) throw new Error('后台正在关闭；操作未执行，请重新连接。');
    switch (method) {
      case 'initial': return { ...workspace.snapshot(), owner, defaultWorkspace, servicePid: process.pid, protocol: 1, capabilities: ['resume', 'forget', 'clearSharedHistory', 'structuredClaudeSubmit', 'verifiedHandoffs', 'nativePermissionDefaults', 'nativeInputIsolation'], runtimeVersion: process.env.NAW_APP_VERSION || 'development' };
      case 'create': return workspace.create(args[0].provider, args[0].cwd, owner, args[0].name, args[0].view);
      case 'join': if (typeof args[1] !== 'boolean') throw new Error('无效成员操作。'); return workspace.join(...args);
      case 'claim': return workspace.claim(args[0], owner, args[1]);
      case 'send': if (/^\/[a-z-]+(?:\s|$)/i.test(args[1])) throw new Error('原生命令请在终端执行；草稿已保留。'); return workspace.send(args[0], args[1], owner);
      case 'draft': return workspace.setDraft(args[0], args[1], owner);
      case 'terminal': return workspace.terminal(args[0], owner);
      case 'terminalSnapshot': { const t = await workspace.runtime(args[0]).openTerminal(); return t.snapshot(); }
      case 'input': return workspace.input(args[0], args[1], owner);
      case 'resize': return workspace.resize(args[0], owner, args[1], args[2]);
      case 'interrupt': return workspace.interrupt(args[0], owner);
      case 'run': return workspace.startRun(...args);
      case 'pause': return workspace.pause('你暂停了后续交接；已经开始的原生工作仍由原生会话管理。');
      case 'forward': return workspace.forward(args[0], args[1], owner);
      case 'approve': return workspace.approve(args[0], args[1], args[2], owner);
      case 'stop': return workspace.stop(args[0]);
      case 'resume': return workspace.resume(args[0], owner);
      case 'clearSharedHistory': return workspace.clearSharedHistory();
      case 'forget': return workspace.forget(args[0]);
      case 'shutdown':
        if ([...workspace.sessions.values()].some(s => s.state !== 'ended')) throw new Error('请先结束各原生会话，再关闭运行服务。');
        shuttingDown = true;
        setTimeout(shutdown, 100); return true;
      default: throw new Error('不支持的本地操作。');
    }
  };
  const server = net.createServer(client => {
    client.setEncoding('utf8');
    let authenticated = false, owner = null, buffered = '';
    const authTimer = setTimeout(() => { if (!authenticated) client.destroy(); }, 3000);
    client.on('error', () => {});
    client.on('data', chunk => {
      buffered += chunk.toString('utf8');
      if (buffered.length > 2 * 1024 * 1024) return client.destroy();
      for (let end; (end = buffered.indexOf('\n')) >= 0;) {
        const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
        let request; try { request = JSON.parse(line); } catch { client.destroy(); return; }
        if (!authenticated) {
          if (request.token !== token || request.protocol !== 1 || typeof request.owner !== 'string' || request.owner.length > 100) { client.destroy(); return; }
          authenticated = true; owner = request.owner; clients.add(client); clearTimeout(authTimer); send(client, { ready: true }); continue;
        }
        if (!Array.isArray(request.args) || request.args.length > 5 || !Number.isInteger(request.id)) { client.destroy(); return; }
        Promise.resolve().then(() => dispatch(owner, request.method, request.args)).then(value => send(client, { id: request.id, ok: true, value }), error => send(client, { id: request.id, ok: false, error: error.message || '操作未完成。' }));
      }
    });
    client.on('close', () => { clearTimeout(authTimer); clients.delete(client); if (!shuttingDown) workspace.release(owner); });
  });
  await new Promise(resolve => server.listen(endpoint, resolve)); fs.chmodSync(endpoint, 0o600);
  const connection = path.join(dataDir, 'connection.json'); const tmp = `${connection}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ protocol: 1, endpoint, token, pid: process.pid }), { mode: 0o600 }); fs.renameSync(tmp, connection);
  function shutdown() { shuttingDown = true; workspace.close(); server.close(); for (const c of clients) c.destroy(); fs.rmSync(connection, { force: true }); fs.rmSync(lockPath, { force: true }); setTimeout(() => process.exit(0), 500); }
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}
main().catch(() => process.exit(1));
