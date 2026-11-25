const { uiError } = require('./ui-errors.cjs');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { readLayout, writeLayout, DSH_INHERIT_ATTEMPTS } = require('./service-layout.cjs');
const { WorkspaceClient } = require('./workspace-client.cjs');
const { processMayBeAlive } = require('./platform.cjs');
const { lockIdentity, readLock, createLock, releaseLock, ownerMayBeAlive } = require('./service-lock.cjs');

const dshCopy = require('./dsh-copy.cjs');
const serviceBinding = require('./service-binding.cjs');
const { ServiceClient, connectService } = require('./service-connection.cjs');
async function connect(dataDir, owner, options) {
  const layout = readLayout(dataDir);
  const entries = [];
  try {
    for (const key of layout.entries) {
      const client = await connectService(path.join(dataDir, key), owner, options);
      const entry = { key, client }; entries.push(entry); entry.state = await client.call('initial'); serviceBinding.assertBinding(entry.state.serviceBinding);
    }
    const client = new WorkspaceClient(entries, layout.active, dataDir); client.snapshot(); return client;
  } catch (error) { for (const e of entries) e.client.close(); throw error; }
}
async function waitForShutdown(client, dataDir, identity) {
  const lock = path.join(dataDir, 'service.lock');
  for (let i = 0; i < 30; i++) {
    const alive = ownerMayBeAlive(identity, dataDir, 'service');
    if (client.socket.destroyed && !fs.existsSync(lock) && !alive) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw uiError("error.service.backendCloseUnconfirmed");
}
async function ensureServiceAt(dataDir, executablePath, defaultWorkspace, allowEndedServiceRestart = false, expectedBinding = null) {
  if (expectedBinding && expectedBinding.runtimeVersion !== (process.env.NAW_APP_VERSION || 'development')) throw serviceBinding.failure('binding-mismatch');
  serviceBinding.assertBinding(serviceBinding.readBinding(dataDir), expectedBinding);
  let stopping = false;
  try {
    const c = await connectService(dataDir, 'bootstrap');
    try {
      const state = await c.call('initial');
      serviceBinding.assertBinding(state.serviceBinding, expectedBinding);
      if (expectedBinding) {
        if (state.runtimeVersion !== expectedBinding.runtimeVersion) throw serviceBinding.failure('binding-mismatch');
        return state;
      }
      if (state.room.run?.status === 'running' && (!state.capabilities?.includes('nativeInputIsolation') || !state.capabilities?.includes('verifiedHandoffs') || ((!state.capabilities?.includes('structuredClaudeSubmit') || !state.capabilities?.includes('claudePromptIdentity')) && state.sessions.some(s => s.provider === 'claude' && state.room.run.ids.includes(s.id))))) await c.call('pause');
      if (!process.env.NAW_APP_VERSION || state.runtimeVersion === process.env.NAW_APP_VERSION || state.sessions.some(s => s.state !== 'ended')) return state;
      if (state.sessions.length && !state.capabilities?.includes('atomicShutdown')) return state;
      // An ended top-level thread does not certify its shared native server or
      // descendants are gone. Only the explicit continuation dialog can permit
      // retiring such an all-ended backend; normal launch never does so.
      if (!allowEndedServiceRestart && state.sessions.some(s => processMayBeAlive(s.processIdentity) || processMayBeAlive(s.serverIdentity))) return state;
      // Install a newer backend only after every native session has confirmed
      // its end. An active/unknown fleet never becomes an update casualty.
      const identity = lockIdentity(state.servicePid) || { pid: state.servicePid };
      stopping = true; await c.call('shutdown');
      await waitForShutdown(c, dataDir, identity);
    } finally { c.close(); }
  } catch (error) { if (stopping || error.code === 'binding-mismatch') throw error; }
  const lock = path.join(dataDir, 'service.lock');
  const record = readLock(lock);
  if (record !== undefined) {
    if (!record) throw uiError("error.service.recordCorrupted");
    if (ownerMayBeAlive(record, dataDir, 'service') || !releaseLock(lock, record)) throw uiError("error.service.existingBackendUnreachable");
  }
  if (expectedBinding && !serviceBinding.runnerAbsent(dataDir)) throw serviceBinding.failure('runner-exit-unconfirmed');
  const names = ['service-binding.cjs', 'butler-backend.cjs', 'butler-runner.cjs', 'butler-runner.py', 'service-lock.cjs', 'ui-errors.cjs', 'ui-locale.js', 'ui-messages.js', 'service-transport.cjs', 'state-delta.cjs', 'state-share.cjs', 'daemon.cjs', 'adapters.cjs', 'agy-tui.cjs', 'agy_hook.py', 'discussion-guidelines.cjs', 'dsh-tui.cjs', 'dsh-egress.cjs', 'dsh-witness.cjs', 'dsh-tui-update-off.cjs', 'dsh-tui-preload.mjs', 'butler-dsh-privacy.cjs', 'native-accessibility.cjs', 'native-computer-use.cjs', 'computer-use-outbox-native.cjs', 'scoped-outbox-runtime.cjs', 'background-control.cjs', 'record-history.cjs', 'background-operation.cjs', 'background-fingerprint.cjs', 'background-control-native.cjs', 'native-root-proof.cjs', 'computer-use-outbox-tool.cjs', 'operator-control.cjs', 'terminal-keyboard.cjs', 'terminal-continuation.js', 'codex-terminal-bridge.cjs', 'codex-tool-content.cjs', 'workspace.cjs', 'submission-policy.cjs', 'renderer/fleet-observation.js', 'backend-switch.cjs', 'goal-continuation.cjs', 'goal-continuation-runner.cjs', 'git-worktree.cjs', 'collaboration-spaces.cjs', 'space-merge.cjs', 'session-labels.cjs', 'mobile-access.cjs', 'mobile-session.cjs', 'mobile-receipts.cjs', 'rotation-handoff.cjs', 'native-blocks.cjs', 'native-images.cjs', 'space-images.cjs', 'local-images.cjs', 'shared-replies.cjs', 'session-wake.cjs', 'session-model.cjs', 'quiet-windows.cjs', 'steward-role.cjs', 'queue-secretary.cjs', 'space-managers.cjs', 'addressed-handoffs.cjs', 'claude-message-tool.cjs', 'room-threads.js', 'native-history.cjs', 'claude-session-list.cjs', 'native-directory-trust.cjs', 'native-terminal-dialog.cjs', 'codex-qualification.cjs', 'codex-profile.cjs', 'claude-pin.cjs', 'claude-mod-check.cjs', 'claude-qualification.cjs', 'claude-native-journeys.cjs', 'claude-loopback.cjs', 'codex-surface.cjs', 'codex-surface/0.167.0.json', 'approval-policy.js', 'native-usage.js', 'peer-handoffs.cjs', 'service-connection.cjs', 'service-layout.cjs', 'observation.cjs', 'pty_host.py', 'claude_hook.py', 'platform.cjs', 'runtime-locations.cjs', 'claude-submit.cjs', 'claude-compat-plugin.cjs'];
  const localLocations = path.join(dataDir, 'runtime-locations.json');
  let runtimeConfig = process.env.NAW_RUNTIME_CONFIG;
  // Keep Settings reachable when the root backend shares the global file.
  if (!runtimeConfig || path.resolve(localLocations) !== path.resolve(runtimeConfig)) {
    try {
      fs.lstatSync(localLocations);
      // A backend's own file no longer applies: its entries are taken out now, while no native server of
      // this backend is running, and kept in a record beside it; the backend uses the shared Settings file
      // (runtime-locations.cjs). If that cannot be written, the file is used as it is.
      runtimeConfig = require('./runtime-locations.cjs').backendLocations(dataDir, runtimeConfig, { repair: true }).file;
    } catch (error) { if (error.code !== 'ENOENT') throw uiError("error.service.locationsUnreadable", { arg1: localLocations }); }
  }
  const pluginFiles = ['.claude-plugin/plugin.json', 'hooks/hooks.json', 'hooks/register.js'];
  // The mod's own tests, for the background check of an unqualified Claude version (claude-mod-check.cjs).
  // They are kept beside the mod's folder, so the folder real sessions load stays these three files.
  const pluginTests = ['native-media.test.ts', 'queued-input.test.ts', 'submission.test.ts', 'turn-records.test.ts'];
  const hash = crypto.createHash('sha256'); for (const name of names) hash.update(fs.readFileSync(path.join(__dirname, name)));
  for (const name of pluginFiles) hash.update(fs.readFileSync(path.join(__dirname, 'claude-bridge', name)));
  for (const name of pluginTests) hash.update(fs.readFileSync(path.join(__dirname, 'claude-bridge', name)));
  const runtime = path.join(dataDir, 'runtimes', hash.digest('hex').slice(0, 16)); fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
  for (const name of names) { const target = path.join(runtime, name); fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 }); fs.copyFileSync(path.join(__dirname, name), target); }
  for (const name of pluginFiles) { const destination = path.join(runtime, 'claude-bridge', name); fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 }); fs.copyFileSync(path.join(__dirname, 'claude-bridge', name), destination); }
  fs.mkdirSync(path.join(runtime, 'claude-bridge-tests'), { recursive: true, mode: 0o700 });
  for (const name of pluginTests) fs.copyFileSync(path.join(__dirname, 'claude-bridge', name), path.join(runtime, 'claude-bridge-tests', name));
  for (const name of ['ws', '@xterm/headless', '@xterm/addon-serialize', '@deepseek-ai/dsh-sdk-protocol']) {
    const source = path.dirname(require.resolve(`${name}/package.json`));
    const target = path.join(runtime, 'node_modules', name);
    fs.cpSync(source, target, { recursive: true });
    // These pinned xterm packages omit LICENSE from their npm file list. Their
    // reviewed upstream release shares the full xterm.js MIT notice.
    if (name.startsWith('@xterm/') && !fs.existsSync(path.join(target, 'LICENSE'))) {
      fs.copyFileSync(path.join(path.dirname(require.resolve('@xterm/xterm/package.json')), 'LICENSE'), path.join(target, 'LICENSE'));
    }
  }
  const child = spawn(executablePath, ['--disable-sigusr1', path.join(runtime, 'daemon.cjs'), dataDir], { detached: true, stdio: 'ignore', env: { ...process.env, NAW_RUNTIME_CONFIG: runtimeConfig, NAW_WORKSPACE: defaultWorkspace, ELECTRON_RUN_AS_NODE: '1' } }); child.unref();
  for (let i = 0; i < 100; i++) { try { const c = await connectService(dataDir, 'bootstrap'); try { const state = await c.call('initial'); serviceBinding.assertBinding(state.serviceBinding, expectedBinding); return state; } finally { c.close(); } } catch {} await new Promise(r => setTimeout(r, 100)); }
  throw uiError("error.service.startFailed");
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
  const record = readLock(lockFile);
  if (record !== undefined) {
    if (!record) throw uiError("error.service.invalidStartupRecord");
    if (ownerMayBeAlive(record, dataDir, 'startup') || !releaseLock(lockFile, record)) throw uiError("error.service.connecting");
  }
  const lock = createLock(lockFile, 'startup', dataDir);
  let attached = true; // false once this start has let go of the lock: a copy still running then re-reads the layout
  try {
    const layout = readLayout(dataDir), states = new Map();
    const defaultWorkspace = process.env.NAW_WORKSPACE || path.join(dataDir, 'workspace');
    if (endedServiceKey !== null) {
      if (!layout.entries.includes(endedServiceKey)) throw uiError("error.service.connectionOutsideWorkspace");
      // Explicit continuation owns exactly one store. Do not bootstrap, pause,
      // retire or replace any peer while its existing windows remain connected.
      await ensureServiceAt(path.join(dataDir, endedServiceKey), executablePath, defaultWorkspace, true);
      return;
    }
    for (const key of layout.entries) states.set(key, await ensureServiceAt(path.join(dataDir, key), executablePath, defaultWorkspace));
    const dsh = require('./dsh-tui.cjs'), version = process.env.NAW_APP_VERSION, retryVersion = version || 'development';
    const targetWarnings = ensureService.targetWarnings ||= new Map(), warningLimit = 64;
    const trimWarnings = () => { while (targetWarnings.size > warningLimit) targetWarnings.delete(targetWarnings.keys().next().value); };
    trimWarnings();
    const targetWarningState = (target, error) => {
      try {
        if (!Array.isArray(error?.targetEntry)) return null;
        const directory = path.join(dataDir, target), where = dsh.paths(directory);
        const identity = file => {
          try { const s = fs.lstatSync(file); return [s.dev, s.ino, s.uid, s.mode, ...(file === directory ? [] : [s.mtimeMs, s.ctimeMs])]; }
          catch (cause) { if (cause.code === 'ENOENT') return null; throw cause; }
        };
        const cause = error?.cause;
        return JSON.stringify([retryVersion, error.targetEntry, cause?.code || null,
          crypto.createHash('sha256').update(typeof cause?.message === 'string' ? cause.message : '').digest('hex'),
          ...[directory, where.base, where.root].map(identity)]);
      } catch { return null; }
    };
    const dshRows = current => current.dshInheritance?.version !== retryVersion ? [] : current.dshInheritance.failures.filter(row => current.entries.includes(row.source) &&
      (current.entries.includes(row.target) || current.pending === row.target) && !dsh.installed(path.join(dataDir, row.target)));
    const prior = layout.dshInheritance;
    let failures = dshRows(layout);
    const retryable = row => row && row.attempts < DSH_INHERIT_ATTEMPTS && ['deadline', 'filesystem'].includes(row.reason);
    const setDsh = (current, rows) => {
      if (rows.length) current.dshInheritance = { version: retryVersion, failures: rows };
      else delete current.dshInheritance;
    };
    const saveDsh = (required = false) => {
      setDsh(layout, failures);
      try { writeLayout(dataDir, layout); }
      catch (error) { if (required) throw error; console.warn('DSH runtime retry state unavailable'); }
    };
    if (prior && (prior.version !== retryVersion || prior.failures.length !== failures.length)) saveDsh();
    const recordDsh = async change => {
      if (attached) { failures = change(failures); saveDsh(); return; }
      try { await dshCopy.updateLayout(dataDir, current => setDsh(current, change(dshRows(current)))); }
      catch { console.warn('DSH runtime retry state unavailable'); }
    };
    const inheritDshFrom = async (source, target) => {
      const current = attached ? layout : readLayout(dataDir), rows = attached ? failures : dshRows(current);
      if (!attached && ![current.active, current.pending].includes(target)) return 'done';
      if (!attached && !current.entries.includes(source)) return 'next';
      const warningKey = JSON.stringify([dataDir, source, target]);
      const same = row => row.source === source && row.target === target, previous = rows.find(same);
      if (previous && !retryable(previous)) return 'next';
      try {
        const result = await dshCopy.copy(executablePath, path.join(dataDir, source), path.join(dataDir, target));
        targetWarnings.delete(warningKey);
        if (result.status === 'absent') return 'next';
        if (rows.some(row => row.target === target)) await recordDsh(known => known.filter(row => row.target !== target));
        return 'done';
      } catch (error) {
        const reason = ['deadline', 'filesystem', 'unqualified', 'target', 'stopped'].includes(error?.reason) ? error.reason : 'unavailable';
        // A target refusal, or a copier that ended without a verdict, is tried again without charging the source.
        if (!['target', 'stopped'].includes(reason)) await recordDsh(known => [...known.filter(row => !same(row)),
          { source, target, attempts: (previous?.attempts || 0) + 1, reason, ...error?.progress }]);
        // Only diagnostics are cached; every startup still performs preflight.
        const state = reason === 'target' ? targetWarningState(target, error) : null;
        if (!state || targetWarnings.get(warningKey) !== state) console.warn('DSH runtime inheritance skipped:', reason);
        targetWarnings.delete(warningKey);
        if (state) { targetWarnings.set(warningKey, state); trimWarnings(); }
        return reason === 'unqualified' ? 'next' : reason === 'target' ? 'done' : 'later';
      }
    };
    const hasDsh = key => fs.existsSync(dsh.paths(path.join(dataDir, key)).root);
    const inheritDsh = async target => {
      const sources = [layout.active, ...layout.entries.filter(key => key !== layout.active)].filter(key => key !== target && (hasDsh(key) || hasDsh(target)));
      if (sources.length) await dshCopy.start(dataDir, sources, source => inheritDshFrom(source, target));
    };
    if (layout.pending || (version && states.get(layout.active).runtimeVersion !== version)) {
      // Reuse a confirmed all-ended slot before adding another service. Its
      // own history stays in its store; no session is replayed or migrated.
      let key = layout.pending || layout.entries.find(entry => states.get(entry).runtimeVersion === version && states.get(entry).sessions.every(s => s.state === 'ended')) || layout.entries.find(entry => states.get(entry).runtimeVersion === version);
      if (!key) {
        const hash = crypto.createHash('sha256').update(version).update(fs.readFileSync(path.join(__dirname, 'daemon.cjs'))).update(fs.readFileSync(path.join(__dirname, 'adapters.cjs'))).update(fs.readFileSync(path.join(__dirname, 'codex-terminal-bridge.cjs'))).update(fs.readFileSync(path.join(__dirname, 'workspace.cjs'))).digest('hex').slice(0, 20);
        key = `backends/${hash}`;
        fs.mkdirSync(path.join(dataDir, key), { recursive: true, mode: 0o700 });
        // Publish ownership before launching. A crash or failed activation can
        // leave a pending slot, but never an unrecorded detached service.
        if (!layout.entries.includes(key)) { layout.pending = key; writeLayout(dataDir, layout); }
      }
      await inheritDsh(key);
      let next = states.get(key) || await ensureServiceAt(path.join(dataDir, key), executablePath, defaultWorkspace);
      if (version && next.runtimeVersion !== version) throw uiError("error.service.newBackendNotReady");
      // Global human choices and slot activation share services.lock. Only a slot new to the layout takes its setting
      // here, on if every other backend is on. A slot in use keeps its own: off may be only another slot's default, and
      // writing it would revoke this slot's creation grants without asking.
      if (!states.has(key) && next.capabilities?.includes('operatorControl1a') && !next.operatorPolicy?.error) {
        const enabled = states.size > 0 && [...states.values()].every(state => state.capabilities?.includes('operatorControl1a') &&
          state.operatorPolicy?.enabled === true && !state.operatorPolicy.error);
        if (next.operatorPolicy?.enabled !== enabled) {
          const client = await connectService(path.join(dataDir, key), 'upgrade');
          try {
            const pid = next.servicePid;
            if (await client.call('operatorAction', null, 'enabled', enabled) !== true) throw Error('Operator setting inheritance is unconfirmed');
            next = await client.call('initial');
            if (next.servicePid !== pid || version && next.runtimeVersion !== version ||
                next.operatorPolicy?.enabled !== enabled || next.operatorPolicy?.error) throw Error('Operator setting inheritance is unconfirmed');
          } finally { client.close(); }
        }
      }
      for (const old of layout.entries) {
        const client = await connectService(path.join(dataDir, old), 'upgrade');
        try { await client.call('pause', { withdrawWakes: true, cause: 'upgrade' }); } finally { client.close(); }
      }
      if (!layout.entries.includes(key)) layout.entries.push(key);
      layout.active = key; delete layout.pending; writeLayout(dataDir, layout); states.set(key, next);
    } else if (!hasDsh(layout.active)) {
      await inheritDsh(layout.active);
    }
    const runtimeMissing = !hasDsh(layout.active);
    // Retire only truly empty inactive services. Ended sessions, shared replies,
    // orphan drafts and unreadable stores all retain their service and records.
    for (const key of [...layout.entries]) {
      if (key === layout.active || !emptyService(states.get(key)) || !emptyStore(path.join(dataDir, key))) continue;
      // Preserve unattempted sources and the one remaining transient retry.
      const failure = failures.find(row => row.source === key && row.target === layout.active);
      if (runtimeMissing && hasDsh(key) && (!failure || retryable(failure))) continue;
      const client = await connectService(path.join(dataDir, key), 'retire-empty');
      try {
        const current = await client.call('initial');
        if (!emptyService(current)) continue;
        const identity = lockIdentity(current.servicePid) || { pid: current.servicePid };
        await client.call('shutdown');
        await waitForShutdown(client, path.join(dataDir, key), identity);
      } finally { client.close(); }
      layout.entries = layout.entries.filter(entry => entry !== key);
      failures = failures.filter(row => row.source !== key && row.target !== key); saveDsh(true);
      for (const slot of targetWarnings.keys()) {
        const [directory, source, target] = JSON.parse(slot);
        if (directory === dataDir && (source === key || target === key)) targetWarnings.delete(slot);
      }
    }
  } finally { attached = false; releaseLock(lockFile, lock); }
}
function continuationStatus(state, id) {
  const notReady = (key, params) => { const error = uiError(key, params); return { ready: false, reason: error.message, reasonUiMessage: error.uiMessage || null }; };
  const record = state.sessions.find(s => s.id === id);
  if (!record) throw uiError("error.service.originalSessionMissing");
  if (!record.nativeId) return notReady('error.connection.noHistory');
  const active = state.sessions.filter(s => s.state !== 'ended');
  if (active.length) return notReady('error.connection.activeSessions', { count: active.length, names: active.map(s => s.name || s.provider).join(', ') });
  if (state.storageWarning) return notReady('error.connection.storageWarning');
  if (!state.capabilities?.includes('atomicShutdown')) return notReady('error.connection.noAtomicShutdown');
  return { ready: true, nativeId: record.nativeId };
}
async function continueService(dataDir, executablePath, id) {
  const client = await connect(dataDir, 'continue-connection');
  let key, nativeId;
  try {
    await client.refresh(); const target = client.route(id), status = continuationStatus(target.state, id);
    if (!status.ready) throw Object.assign(new Error(status.reason), status.reasonUiMessage ? { uiMessage: status.reasonUiMessage } : {});
    key = target.key; nativeId = status.nativeId;
  } finally { client.close(); }
  await ensureService(dataDir, executablePath, key);
  const fresh = await connect(dataDir, 'verify-continuation');
  try {
    const target = fresh.route(id), record = target.state.sessions.find(s => s.id === id);
    if (target.key !== key || target.state.runtimeVersion !== process.env.NAW_APP_VERSION || !['observe', 'structuredClaudeSubmit', 'nativeInputIsolation', 'nativePermissionDefaults'].every(cap => target.state.capabilities?.includes(cap)) || record.nativeId !== nativeId || record.state !== 'ended') throw uiError("error.service.newConnectionUnconfirmed");
    return { key };
  } finally { fresh.close(); }
}
module.exports = { ServiceClient, connect, connectService, ensureService, continuationStatus, continueService, ensureServiceAt };
