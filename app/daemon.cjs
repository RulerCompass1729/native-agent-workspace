// The native processes belong here, never to an Electron window or renderer.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { NativeHost } = require('./adapters.cjs');
const { Workspace } = require('./workspace.cjs');
const { readFrames, REQUEST_BYTES, encodeFrame, createWriter } = require('./service-transport.cjs');

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
  const workspace = new Workspace(host, dataDir); const clients = new Set(), writers = new Map();
  const send = (client, value) => writers.get(client)?.send(value);
  const broadcast = (event, data) => {
    if (!clients.size) return;
    let frame;
    try { frame = encodeFrame({ event, data }); }
    catch { for (const client of clients) client.destroy(); return; }
    // Only complete state snapshots supersede each other. Terminal bytes,
    // progress and RPC acknowledgements retain their order and payload.
    for (const client of clients) writers.get(client)?.sendFrame(frame, event === 'state' ? 'state' : null);
  };
  let scheduled = false;
  workspace.on('change', () => { if (!scheduled) { scheduled = true; setTimeout(() => { scheduled = false; broadcast('state', workspace.snapshot()); }, 35); } });
  workspace.on('terminal', data => broadcast('terminal', data));
  workspace.on('progress', data => broadcast('progress', data));
  let shuttingDown = false;
  const dispatch = async (owner, method, args) => {
    if (shuttingDown) throw new Error('后台正在关闭；操作未执行，请重新连接。');
    switch (method) {
      case 'initial': return { ...workspace.snapshot(), owner, defaultWorkspace, servicePid: process.pid, protocol: 1, capabilities: ['nativeSteer', 'replyThreads', 'nativeContextTransitions', 'nativeHistory', 'atomicShutdown', 'observe', 'resume', 'resubscribe', 'transportReconnect', 'retrySave', 'forget', 'clearSharedHistory', 'structuredClaudeSubmit', 'claudePromptIdentity', 'verifiedHandoffs', 'boundedReplyHandoffs', 'multiSessionHandoffs', 'nativePermissionDefaults', 'nativeInputIsolation', 'nativeApprovalSync', 'nativeApprovalLocalDecisions'], runtimeVersion: process.env.NAW_APP_VERSION || 'development' };
      case 'retrySave': return workspace.retrySave();
      case 'nativeHistory': return workspace.nativeHistory.list(args[0]);
      case 'importHistory': return workspace.importHistory(args[0], owner);
      case 'observe': return workspace.observe(args[0]);
      case 'create': return workspace.create(args[0].provider, args[0].cwd, owner, args[0].name, args[0].view);
      case 'join': if (typeof args[1] !== 'boolean') throw new Error('无效成员操作。'); return workspace.join(...args);
      case 'claim': return workspace.claim(args[0], owner, args[1]);
      case 'send': {
        workspace.assertNativeContext(args[0], args[2]);
        if (/^\/[a-z-]+(?:\s|$)/i.test(args[1])) throw new Error('原生命令请在终端执行；草稿已保留。');
        const nativeId = workspace.get(args[0]).nativeId;
        const tag = await workspace.send(args[0], args[1], owner);
        const current = workspace.get(args[0]);
        return current.nativeId !== nativeId || current.nativeContextPending ? { tag, contextChanged: true } : tag;
      }
      case 'draft': return workspace.setDraft(args[0], args[1], owner);
      case 'steer': {
        workspace.assertNativeContext(args[0], args[2]);
        const nativeId = workspace.get(args[0]).nativeId;
        const tag = await workspace.steer(args[0], args[1], owner, args[3]);
        const current = workspace.get(args[0]);
        return current.nativeId !== nativeId || current.nativeContextPending ? { tag, contextChanged: true } : tag;
      }
      case 'terminal': return workspace.terminal(args[0], owner);
      case 'terminalSnapshot': return workspace.terminalSnapshot(args[0], owner);
      case 'input': return workspace.input(args[0], args[1], owner);
      case 'resize': return workspace.resize(args[0], owner, args[1], args[2]);
      case 'interrupt': return workspace.interrupt(args[0], owner);
      case 'run': {
        if (!Array.isArray(args[0])) throw Error('无效会话选择。');
        for (const id of args[0]) workspace.assertNativeContext(id, args[5]?.[id]);
        const contexts = args[0].map(id => [id, workspace.get(id).nativeId]);
        await workspace.startRun(...args);
        return { contextChanged: contexts.some(([id, nativeId]) => workspace.get(id).nativeId !== nativeId || workspace.get(id).nativeContextPending) };
      }
      case 'pause': return workspace.pause('你暂停了后续交接；已经开始的原生工作仍由原生会话管理。');
      case 'forward': {
        workspace.assertNativeContext(args[0], args[2]);
        const nativeId = workspace.get(args[0]).nativeId;
        await workspace.forward(args[0], args[1], owner, args[3]);
        const current = workspace.get(args[0]);
        return { contextChanged: current.nativeId !== nativeId || Boolean(current.nativeContextPending) };
      }
      case 'approve': return workspace.approve(args[0], args[1], args[2], owner);
      case 'stop': return workspace.stop(args[0]);
      case 'resume': return workspace.resume(args[0], owner);
      case 'clearSharedHistory': return workspace.clearSharedHistory();
      case 'forget': return workspace.forget(args[0]);
      case 'shutdown':
        if (workspace.pendingNativeImports) throw new Error('正在接入所选原生会话，请等待连接结果后再关闭后台。');
        if ([...workspace.sessions.values()].some(s => s.state !== 'ended')) throw new Error('请先结束各原生会话，再关闭运行服务。');
        shuttingDown = true;
        setTimeout(shutdown, 100); return true;
      default: throw new Error('不支持的本地操作。');
    }
  };
  const server = net.createServer(client => {
    writers.set(client, createWriter(client));
    let authenticated = false, owner = null;
    const authTimer = setTimeout(() => { if (!authenticated) client.destroy(); }, 3000);
    client.on('error', () => {});
    readFrames(client, REQUEST_BYTES, request => {
      if (!authenticated) {
        if (request.token !== token || request.protocol !== 1 || typeof request.owner !== 'string' || request.owner.length > 100) { client.destroy(); return; }
        authenticated = true; owner = request.owner; clients.add(client); clearTimeout(authTimer); send(client, { ready: true }); return;
      }
      if (!Array.isArray(request.args) || request.args.length > (request.method === 'run' ? 7 : 5) || !Number.isInteger(request.id)) { client.destroy(); return; }
      Promise.resolve().then(() => dispatch(owner, request.method, request.args)).then(value => send(client, { id: request.id, ok: true, value }), error => send(client, { id: request.id, ok: false, error: error.message || '操作未完成。' }));
    });
    client.on('close', () => { clearTimeout(authTimer); clients.delete(client); writers.delete(client); if (!shuttingDown) workspace.release(owner); });
  });
  await new Promise(resolve => server.listen(endpoint, resolve)); fs.chmodSync(endpoint, 0o600);
  const connection = path.join(dataDir, 'connection.json'); const tmp = `${connection}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ protocol: 1, endpoint, token, pid: process.pid }), { mode: 0o600 }); fs.renameSync(tmp, connection);
  function shutdown() { shuttingDown = true; workspace.close(); server.close(); for (const c of clients) c.destroy(); fs.rmSync(connection, { force: true }); fs.rmSync(lockPath, { force: true }); setTimeout(() => process.exit(0), 500); }
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}
main().catch(() => process.exit(1));
