const { uiError, uiNotice } = require('./ui-errors.cjs');
// The native processes belong here, never to an Electron window or renderer.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const serviceBinding = require('./service-binding.cjs');
const { NativeHost } = require('./adapters.cjs');
const { Workspace } = require('./workspace.cjs');
const { PeerLeases, PeerRunner, CAPABILITY, DIRECTED, identity: peerIdentity } = require('./peer-handoffs.cjs');
const { readFrames, REQUEST_BYTES, encodeFrame, createWriter } = require('./service-transport.cjs');
const { createStateEncoder, sendState } = require('./state-delta.cjs');
const { roomId: validRoomId, isMember, membershipRevision } = require('./collaboration-spaces.cjs');
const { displayMessage } = require('./ui-locale.js');
const gitWorktree = require('./git-worktree.cjs');
const background = require('./background-operation.cjs');
const { createLock, releaseLock } = require('./service-lock.cjs');

function dispatchScopedOutbox(workspace, client, args, send) {
  return workspace.scopedOutboxRequest(client, args[0], args[1], data => send(client, { event: 'scopedOutbox', data }));
}
async function main() {
  const dataDir = process.argv[2];
  if (!dataDir || !path.isAbsolute(dataDir)) throw new Error('Data directory required');
  const binding = serviceBinding.readBinding(dataDir);
  if (binding && binding.runtimeVersion !== (process.env.NAW_APP_VERSION || 'development')) throw serviceBinding.failure('binding-mismatch');
  const lockPath = path.join(dataDir, 'service.lock');
  const lock = createLock(lockPath, 'service', dataDir);
  const privateDir = fs.mkdtempSync('/tmp/naw-service-');
  // The socket directory belongs only to this daemon, also on startup failure.
  process.once('exit', () => { fs.rmSync(privateDir, { recursive: true, force: true }); });
  fs.chmodSync(privateDir, 0o700);
  const endpoint = path.join(privateDir, 'desktop.sock');
  const token = crypto.randomBytes(32).toString('hex');
  const defaultWorkspace = process.env.NAW_WORKSPACE || path.join(dataDir, 'workspace');
  fs.mkdirSync(defaultWorkspace, { recursive: true, mode: 0o700 });
  // Version decisions and the fallback clock must outlive this process: they go to the data directory.
  const host = new NativeHost(privateDir, dataDir, binding); await host.start();
  // A sibling, never inside the legacy shared cwd (including NAW_WORKSPACE).
  const workspace = new Workspace(host, dataDir, `${path.resolve(defaultWorkspace)}-sessions`); const clients = new Set(), writers = new Map();
  // Clients that take state deltas (state-delta.cjs), each with the states its next frame may build on.
  const deltas = new Map(), stateEncoder = createStateEncoder();
  workspace.peerLeases = new PeerLeases(workspace);
  const peerRunner = workspace.peerRunner = new PeerRunner(workspace, dataDir);
  const send = (client, value) => writers.get(client)?.send(value);
  // Retained copied runtimes must not advertise modules they do not contain.
  const mobileCapabilities = ['mobile-access.cjs', 'mobile-session.cjs'].every(name => fs.existsSync(path.join(__dirname, name))) ? ['humanMobileV1', 'humanMobilePreparedV1'] : [];
  // The sessions whose messages changed since the last state broadcast that reached a client, or null
  // when any record's may have (workspace.changed names a session only for a streamed reply).
  let stateChanges = new Set();
  const broadcast = (event, data) => {
    if (!clients.size) return;
    if (event === 'state') {
      const changed = stateChanges; stateChanges = new Set();
      try { sendState(stateEncoder, [...clients].map(client => ({ writer: writers.get(client), delta: deltas.get(client) || null })).filter(target => target.writer), data, changed); }
      catch { for (const client of clients) client.destroy(); }
      return;
    }
    let frame;
    try { frame = encodeFrame({ event, data }); }
    catch { for (const client of clients) client.destroy(); return; }
    // Only complete state snapshots supersede each other. Terminal bytes,
    // progress and RPC acknowledgements retain their order and payload.
    for (const client of clients) writers.get(client)?.sendFrame(frame, event === 'state' ? 'state' : null);
  };
  let scheduled = false;
  workspace.on('change', session => { if (stateChanges && typeof session === 'string') stateChanges.add(session); else stateChanges = null; if (!scheduled) { scheduled = true; setTimeout(() => { scheduled = false; broadcast('state', workspace.snapshot()); }, 35); } });
  workspace.on('terminal', data => broadcast('terminal', data));
  workspace.on('progress', data => broadcast('progress', data));
  let shuttingDown = false;
  const dispatch = async (owner, method, args, client, roomId = 'shared', scoped = false, inputProof = false) => {
    if (binding && !['initial', 'ensureButlerRunner', 'shutdown'].includes(method)) throw serviceBinding.failure('butler-qualification-required');
    if (shuttingDown) throw uiError("error.backendClosingActionNotExecuted");
    if (method === 'scopedOutbox') return dispatchScopedOutbox(workspace, client, args, send);
    switch (method) {
      case 'ensureButlerRunner': {
        if (!binding) throw serviceBinding.failure('binding-mismatch');
        serviceBinding.assertBinding(args[0], binding);
        await host.startCodex();
        return { binding, nativeReady: Boolean(host.rpc), credentialPresent: host.butlerCredentialPresent === true };
      }
      case 'initial': host.resolvePrograms?.(); return { ...(binding ? { serviceBinding: binding } : {}), ...workspace.snapshot(), owner, defaultWorkspace, newWorkspaceRoot: workspace.newWorkspaceRoot, servicePid: process.pid, protocol: 1, capabilities: [background.CAPABILITY, ...mobileCapabilities, ...(fs.existsSync(path.join(__dirname, 'scoped-outbox-runtime.cjs')) ? ['scopedNativeOutboxV1'] : []), ...(gitWorktree.available() ? [gitWorktree.CAPABILITY] : []), CAPABILITY, DIRECTED, 'operatorControl1a', 'spaceImageInputV1', 'collaborationSpacesV1', 'singleHomeMoveV1', 'spaceMergeV1', 'queueDispatchV1', 'createSettingsV1', 'agentAddressedHandoffs', 'agentWakeV1', require('./session-wake.cjs').PREFLIGHT, 'nativeSharedSteer', 'nativeSharedQueue', 'sharedInputOwnershipV1', 'nativeQueue', 'nativeSteer', 'replyThreads', 'nativeContextTransitions', 'nativeHistory', 'atomicShutdown', 'conditionalMaintenanceStopV1', 'guardedSessionStopV1', 'observe', 'resume', 'resubscribe', 'transportReconnect', 'retrySave', 'forget', 'clearSharedHistory', 'structuredClaudeSubmit', 'claudePromptIdentity', 'verifiedHandoffs', 'boundedReplyHandoffs', 'multiSessionHandoffs', 'nativePermissionDefaults', 'nativeInputIsolation', 'nativeApprovalSync', 'nativeApprovalLocalDecisions', 'claudeFork', 'claudeHistory', 'createSkipPermissions', 'newSessionDirectory', 'nativeQuestionAnswer', 'programAvailabilityV1'], runtimeVersion: process.env.NAW_APP_VERSION || 'development' };
      case 'mergeSnapshot': {
        if (roomId !== 'shared' || args.length !== 1) throw uiError("error.invalidSnapshotImport");
        return workspace.mergeSnapshot(args[0]);
      }
      case 'spaceAction': {
        const [space, action, values, expected] = args, bounds = { join: 3, forward: 5, queueShared: 4, steerShared: 5, run: 7, pause: 0, clearSharedHistory: 0 };
        if (roomId !== 'shared' || !validRoomId(space) || !Object.hasOwn(bounds, action) || !Array.isArray(values) || values.length > bounds[action]) throw uiError("error.invalidSpaceAction");
        const ids = action === 'run' ? values[0] : ['forward', 'queueShared', 'steerShared'].includes(action) ? [values[0]] : [];
        const sharedInput = ['forward', 'queueShared', 'steerShared'].includes(action);
        let proven = false;
        if (!Array.isArray(ids) || ids.some(id => {
          const s = workspace.get(id), proof = expected?.[id];
          if (!isMember(s, space)) return true;
          if (sharedInput && proof && typeof proof === 'object' && !Array.isArray(proof)) {
            proven = JSON.stringify(peerIdentity(s, space)) === JSON.stringify(proof);
            if (!proven) throw uiError('error.client.currentNativeSessionOrControlChanged');
            return false;
          }
          return proof !== membershipRevision(s, space);
        })) throw uiError("error.spaceMembershipChangedNoDispatch");
        return dispatch(owner, action, values, client, space, true, proven);
      }
      case 'mobileRead': return workspace.mobileRead(args[0]);
      case 'mobileSend':
      case 'mobileAnswer': throw uiError("error.mobileInputNeedsPreparation");
      case 'mobilePrepareSend': return workspace.mobilePrepare(args[0], args[1], 'send', client);
      case 'mobilePrepareAnswer': return workspace.mobilePrepare(args[0], args[1], 'answer', client);
      case 'mobileCommitSend': return workspace.mobileCommit(args[0], args[1], 'send', client);
      case 'mobileCommitAnswer': return workspace.mobileCommit(args[0], args[1], 'answer', client);
      case 'mobileCancelSend': return workspace.mobileCancel(args[0], args[1], 'send', client, args[2]);
      case 'mobileCancelAnswer': return workspace.mobileCancel(args[0], args[1], 'answer', client, args[2]);
      case 'mobileSendReceipt': return workspace.mobileReceipt(args[0], args[1], 'send');
      case 'mobileAnswerReceipt': return workspace.mobileReceipt(args[0], args[1], 'answer');
      case 'wakeTake': return require('./session-wake.cjs').take(workspace, args[0]);
      case 'wakeCheck': return require('./session-wake.cjs').check(workspace, args[0]);
      case 'wakeReceive': return require('./session-wake.cjs').receive(workspace, args[0]);
      case 'wakePolicy': return require('./session-wake.cjs').setPolicy(workspace, args[0], args[1]);
      case 'operatorAction': return workspace.operatorAction(...args);
      case 'peerRun': return peerRunner.start(owner, args[0]);
      case 'peerPrepare': return workspace.peerLeases.prepare(client, owner, args[0]);
      case 'peerTake': return workspace.peerLeases.take(client, args[0]);
      case 'peerSend': return workspace.peerLeases.send(client, owner, args[0]);
      case 'peerPause': return workspace.peerLeases.pause(client, args[0]?.id);
      case 'retrySave': return workspace.retrySave();
      case 'nativeHistory': return workspace.nativeHistory.list(args[0]);
      case 'importHistory': return workspace.importHistory(args[0], owner, args[1]);
      case 'observe': return workspace.observe(args[0]);
      case 'gitWorktreePreview': return gitWorktree.preview(args[0], args[1], args[2]);
      case 'create': return workspace.create(args[0].provider, args[0].cwd, owner, args[0].name, args[0].view, { fork: args[0].fork, skipPermissions: args[0].skipPermissions, newDirectory: args[0].newDirectory, gitWorktree: args[0].gitWorktree, settings: args[0].settings });
      case 'moveMembership': return workspace.moveMembership(args[0], args[1], args[2]);
      case 'join': {
        if (typeof args[1] !== 'boolean') throw uiError("error.invalidMemberAction");
        const s = workspace.get(args[0]), proof = args[2];
        if (proof !== undefined && (!proof || proof.nativeId !== s.nativeId || proof.revision !== membershipRevision(s, roomId))) throw uiError("error.membershipIdentityChangedNoRevocation");
        return workspace.join(args[0], args[1], roomId);
      }
      case 'claim': return workspace.claim(args[0], owner, args[1]);
      case 'send': {
        workspace.assertNativeContext(args[0], args[2]);
        if (/^\/[a-z-]+(?:\s|$)/i.test(args[1])) throw uiError("error.nativeCommandUseTerminal");
        const nativeId = workspace.get(args[0]).nativeId;
        const tag = await workspace.send(args[0], args[1], owner);
        const current = workspace.get(args[0]);
        return current.nativeId !== nativeId || current.nativeContextPending ? { tag, contextChanged: true } : tag;
      }
      case 'dispatch': {
        // A NAW queue item (queue-dispatch.cjs): sent under the person's automatic-message
        // switches, never as a takeover. Native commands stay terminal-only.
        if (typeof args[3] !== 'string' || !args[3] || args[3].length > 200) throw uiError("error.queue.invalid");
        workspace.assertNativeContext(args[0], args[2]);
        if (typeof args[1] !== 'string' || /^\/[a-z-]+(?:\s|$)/i.test(args[1])) throw uiError("error.nativeCommandUseTerminal");
        const nativeId = workspace.get(args[0]).nativeId;
        const tag = await workspace.send(args[0], args[1], owner, null, null, null, null, null, null, null, { itemId: args[3] });
        const current = workspace.get(args[0]);
        return current.nativeId !== nativeId || current.nativeContextPending ? { tag, contextChanged: true } : tag;
      }
      case 'draft': return workspace.setDraft(args[0], args[1], owner);
      case 'queue':
      case 'queueShared': {
        if (method === 'queueShared' && workspace.get(args[0]).owner !== owner && !inputProof) throw uiError('error.sharedInputOwnershipUnavailable');
        workspace.assertNativeContext(args[0], args[2]);
        const nativeId = workspace.get(args[0]).nativeId;
        const tag = await workspace.queue(args[0], args[1], owner, method === 'queueShared' ? { replyTo: args[3], roomId } : null);
        const current = workspace.get(args[0]);
        return current.nativeId !== nativeId || current.nativeContextPending ? { tag, contextChanged: true } : tag;
      }
      case 'steer':
      case 'steerShared': {
        if (method === 'steerShared' && workspace.get(args[0]).owner !== owner && !inputProof) throw uiError('error.sharedInputOwnershipUnavailable');
        workspace.assertNativeContext(args[0], args[2]);
        const nativeId = workspace.get(args[0]).nativeId;
        const tag = await workspace.steer(args[0], args[1], owner, args[3], method === 'steerShared' ? { replyTo: args[4], roomId } : null);
        const current = workspace.get(args[0]);
        return current.nativeId !== nativeId || current.nativeContextPending ? { tag, contextChanged: true } : tag;
      }
      case 'terminal': return workspace.terminal(args[0], owner);
      case 'terminalSnapshot': return workspace.terminalSnapshot(args[0], owner);
      case 'input': return workspace.input(args[0], args[1], owner);
      case 'resize': return workspace.resize(args[0], owner, args[1], args[2]);
      case 'interrupt': return workspace.interrupt(args[0], owner);
      case 'run': {
        if (!Array.isArray(args[0])) throw uiError("error.invalidSessionSelection");
        for (const id of args[0]) workspace.assertNativeContext(id, args[5]?.[id]);
        const contexts = args[0].map(id => [id, workspace.get(id).nativeId]);
        await workspace.startRun(args[0], args[1], args[2], args[3], args[4], args[5], args[6], roomId);
        return { contextChanged: contexts.some(([id, nativeId]) => workspace.get(id).nativeId !== nativeId || workspace.get(id).nativeContextPending) };
      }
      case 'pause':
        if (!scoped || (peerRunner.run?.roomId || 'shared') === roomId) await peerRunner.pause();
        // Only the person's explicit pause (and a backend upgrade) withdraws every staged wake;
        // the implicit pause before ordinary input to another session does not.
        if (!scoped) return args[0]?.withdrawWakes === true ? workspace.pauseAll('你暂停了后续交接；已经开始的原生工作仍由原生会话管理。', uiNotice('notice.run.humanPaused').uiMessage) : workspace.pause('你暂停了后续交接；已经开始的原生工作仍由原生会话管理。', undefined, false, uiNotice('notice.run.humanPaused').uiMessage);
        return workspace.pauseRoom(roomId, '你暂停了这个空间的后续交接；已接收的原生工作保留。', uiNotice('notice.run.humanSpacePaused').uiMessage);
      case 'forward': {
        if (method === 'forward' && workspace.get(args[0]).owner !== owner && !inputProof) throw uiError('error.sharedInputOwnershipUnavailable');
        workspace.assertNativeContext(args[0], args[2]);
        const nativeId = workspace.get(args[0]).nativeId;
        const tag = await workspace.forward(args[0], args[1], owner, args[3], roomId, args[4]);
        const current = workspace.get(args[0]);
        const receipt = args[4] && workspace.roomFor(roomId).messages.find(row => row.id === tag)?.imageReceipt;
        return { contextChanged: current.nativeId !== nativeId || Boolean(current.nativeContextPending), ...(background.current() ? { tag } : {}), ...(args[4] ? { tag, imageReceipt: receipt } : {}) };
      }
      case 'approve': return workspace.approve(args[0], args[1], args[2], owner);
      case 'answer': return workspace.answer(args[0], args[1], args[2], owner);
      case 'maintenanceStop': return workspace.maintenanceStop(args[0], args[1], args[2]);
      case 'maintenanceResume': return workspace.maintenanceResume(args[0], args[1], owner);
      case 'maintenanceShutdown':
        workspace.assertMaintenanceShutdown(args[0]);
        shuttingDown = true;
        setTimeout(shutdown, 100); return true;
      case 'stopUnusedSuccessor': return workspace.stopUnusedSuccessor(args[0], args[1]);
      case 'stop': return workspace.stop(args[0]);
      case 'resume': return workspace.resume(args[0], owner);
      case 'clearSharedHistory': return workspace.rooms.has(roomId) ? workspace.clearSharedHistory(roomId) : undefined;
      case 'forget': return workspace.forget(args[0]);
      case 'shutdown':
        if (workspace.pendingNativeImports) throw uiError("error.nativeImportPendingBackendClose");
        if ([...workspace.sessions.values()].some(s => !['ended', 'background'].includes(s.state))) throw uiError("error.endNativeSessionsBeforeBackend");
        shuttingDown = true;
        setTimeout(shutdown, 100); return true;
      default: throw uiError("error.unsupportedLocalAction");
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
        authenticated = true; owner = request.owner; clients.add(client); if (request.stateDelta === 1) deltas.set(client, { sent: null, waiting: null }); clearTimeout(authTimer); send(client, { ready: true }); return;
      }
      if (!Array.isArray(request.args) || request.args.length > (request.method === 'run' ? 7 : 5) || !Number.isInteger(request.id)) { client.destroy(); return; }
      Promise.resolve().then(() => request.backgroundActor
        ? background.run(request.backgroundActor, () => dispatch(owner, request.method, request.args, client))
        : dispatch(owner, request.method, request.args, client)).then(value => send(client, { id: request.id, ok: true, value }), error => send(client, { id: request.id, ok: false, error: error.message || '操作未完成。', uiMessage: error.message ? displayMessage(error.uiMessage) : uiError('error.main.operationIncomplete').uiMessage }));
    });
    client.on('close', () => { clearTimeout(authTimer); clients.delete(client); writers.delete(client); deltas.delete(client); workspace.scopedOutboxDisconnected(client); workspace.peerLeases.disconnected(client); if (mobileCapabilities.length) workspace.mobileDisconnected(client); if (!shuttingDown) workspace.release(owner); });
  });
  await new Promise(resolve => server.listen(endpoint, resolve)); fs.chmodSync(endpoint, 0o600);
  const connection = path.join(dataDir, 'connection.json'); const tmp = `${connection}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ protocol: 1, endpoint, token, pid: process.pid }), { mode: 0o600 }); fs.renameSync(tmp, connection);
  function shutdown() { shuttingDown = true; workspace.closeScopedOutbox(); workspace.close(); server.close(); for (const c of clients) c.destroy(); fs.rmSync(connection, { force: true }); releaseLock(lockPath, lock); setTimeout(() => process.exit(0), 500); }
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}
if (typeof module === 'undefined' || require.main === module) main().catch(() => process.exit(1));
if (typeof module === 'object') module.exports = { dispatchScopedOutbox };
