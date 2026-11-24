'use strict';
// Read-only backend checks shared by upgrade verification and pre-launch recovery.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), crypto = require('node:crypto');
function createInspector(config, platform) {
  // The operator verifies this module and the clean release commit before importing.
  const DATA = config.data, HERE = config.resultDir, NEW_VERSION = config.newVersion;
  const { connectService } = require(path.join(config.release, 'app/service-connection.cjs'));
  const { readLayout } = require(path.join(config.release, 'app/service-layout.cjs'));
  const { readSettings } = require(path.join(config.release, 'app/backend-switch.cjs'));
  const { processIdentity, processMayBeAlive } = require(path.join(config.release, 'app/platform.cjs'));
  const { sessionBusy } = require(path.join(config.release, 'app/background-fingerprint.cjs'));
  const run = platform.run;
async function readBackends() {
  const layout = readLayout(DATA);
  const backends = [];
  for (const key of layout.entries) {
    const client = await connectService(path.join(DATA, key), 'installer-readonly');
    const timeout = setTimeout(() => client.socket.destroy(), 5000);
    try {
      backends.push({ key, state: await client.call('initial') });
    } finally {
      clearTimeout(timeout); client.close();
    }
  }
  return { layout, backends };
}

function roomMessageCount(state) {
  let count = 0;
  const rooms = [state.room, ...(Array.isArray(state.rooms) ? state.rooms : [])];
  for (const room of rooms) {
    if (room && Array.isArray(room.messages)) {
      count += room.messages.length;
    }
  }
  return count;
}

function summary(view) {
  const sessions = [];
  const services = [];
  for (const backend of view.backends) {
    const pid = backend.state.servicePid;
    services.push({ key: backend.key, pid, identity: processIdentity(pid), version: backend.state.runtimeVersion, sessions: backend.state.sessions.length, messages: roomMessageCount(backend.state) });
    for (const s of backend.state.sessions) {
      let identity = null;
      if (Number.isSafeInteger(s.pid) && s.pid > 1) {
        identity = processIdentity(s.pid);
      }
      const settings = JSON.stringify([s.model || null, s.nativeEffort || null, s.nativePermissionMode || null, s.nativeSettings || null]);
      sessions.push({ id: s.id, nativeId: s.nativeId || null, state: s.state, backend: backend.key, pid: s.pid || null, identity, settings, draft: crypto.createHash('sha256').update(JSON.stringify(s.liveDraft ?? null)).digest('hex') });
    }
  }
  return { sessions, services, active: view.layout.active, pending: view.layout.pending || null };
}

// A staged wake goes out only when its turn's end reaches NAW. If the sender is idle and on another turn, that end
// was lost: its next turn withdraws the wake as unreported (session-wake nativeStart) and a reopen marks it
// unconfirmed, never sent. Such a wake is not in flight; capture lists it instead.
function staleWake(state, s, m) {
  if (m.wake.status !== 'staged') {
    return null;
  }
  const sender = m.wake.senderId === s.id ? s : state.sessions.find(other => other.id === m.wake.senderId);
  if (!sender || sessionBusy(sender)) {
    return null;
  }
  if (m.wake.nativeId === sender.nativeId && m.wake.turnId === sender.activeTurnId) {
    return null;
  }
  return { id: m.wake.id ?? null, sender: sender.id, turnId: m.wake.turnId ?? null, reason: 'staged; sender idle and the wake turn is not its current turn' };
}
// A relay or automatic message in flight would be paused or withdrawn by the new app's startup.
// A held wake still goes out from the butler limit timer, so it blocks too. Each blocker says who and where.
function quietBlockers(view) {
  const blockers = [], stale = [];
  if (view.layout.pending) {
    blockers.push({ kind: 'activation', backend: view.layout.pending, message: 'No pending backend activation' });
  }
  for (const backend of view.backends) {
    const state = backend.state;
    const name = id => (state.sessions.find(s => s.id === id) || {}).name || null;
    const rooms = [state.room, ...(Array.isArray(state.rooms) ? state.rooms : [])];
    for (const room of rooms) {
      if (room && room.run && room.run.status === 'running') {
        blockers.push({ kind: 'relay', backend: backend.key, room: room.id || 'shared', roomName: room.name || null, message: 'No running collaboration relay: ' + backend.key });
      }
    }
    for (const lease of state.peerLeases || []) {
      if (lease && lease.status === 'running') {
        blockers.push({ kind: 'peer-lease', backend: backend.key, message: 'No running peer lease: ' + backend.key });
      }
    }
    for (const s of state.sessions) {
      for (const m of s.messages || []) {
        const wake = m && m.wake && staleWake(state, s, m);
        if (wake) {
          stale.push({ backend: backend.key, ...wake });
          continue;
        }
        if (['staged', 'sending', 'held'].includes(m && m.wake && m.wake.status)) {
          const sender = m.wake.senderId || s.id;
          blockers.push({ kind: 'wake', backend: backend.key, status: m.wake.status, sender, senderName: name(sender), session: s.id, sessionName: s.name || null, message: 'No automatic message in flight: ' + backend.key });
        }
      }
    }
  }
  return { blockers, stale };
}
function assertQuiet(view) {
  const { blockers, stale } = quietBlockers(view);
  assert.ok(!blockers.length, blockers.length ? blockers[0].message : '');
  return stale;
}

// Startup restarts an older backend on the new code when every session in it ended and none of their
// processes may still run (service-client.cjs ensureServiceAt), keeping its store and records. Session
// rotation leaves such backends behind. A restart closes what the service still hosts, so each one it
// restarts must have no child process left.
function startupRestarts(backend) {
  const state = backend.state;
  if (state.runtimeVersion === NEW_VERSION) {
    return false;
  }
  if (state.sessions.some(s => s.state !== 'ended')) {
    return false;
  }
  if (!state.capabilities || !state.capabilities.includes('atomicShutdown')) {
    return false;
  }
  return !state.sessions.some(s => processMayBeAlive(s.processIdentity) || processMayBeAlive(s.serverIdentity));
}
function serviceChildren(pid) {
  const children = [];
  for (const row of run('/bin/ps', ['-axo', 'pid=,ppid=']).trim().split('\n')) {
    const [child, parent] = row.trim().split(/\s+/).map(Number);
    if (parent === pid) {
      children.push(child);
    }
  }
  return children;
}
function restartedKeys(view) {
  return view.backends.filter(backend => startupRestarts(backend)).map(backend => backend.key);
}
function assertRestartsSafe(view) {
  for (const backend of view.backends) {
    if (!startupRestarts(backend)) {
      continue;
    }
    const children = serviceChildren(backend.state.servicePid);
    assert.equal(children.length, 0, 'Backend ' + backend.key + ' that startup restarts still hosts processes ' + children.join(', ') + '; stop here');
  }
}
// The backend startup makes active (service-client.cjs bootstrap): the active one when it starts on
// the new code, else the first all-ended one on the new code, else the first on the new code, else a
// new backend (null). A backend with no sessions is restarted on the new code too.
function versionAfterStartup(backend) {
  const state = backend.state;
  if (state.runtimeVersion !== NEW_VERSION && (!state.sessions.length || startupRestarts(backend))) {
    return NEW_VERSION;
  }
  return state.runtimeVersion;
}
function predictActive(view) {
  const byKey = new Map(view.backends.map(backend => [backend.key, backend]));
  if (versionAfterStartup(byKey.get(view.layout.active)) === NEW_VERSION) {
    return view.layout.active;
  }
  for (const key of view.layout.entries) {
    const backend = byKey.get(key);
    if (versionAfterStartup(backend) === NEW_VERSION && backend.state.sessions.every(s => s.state === 'ended')) {
      return key;
    }
  }
  for (const key of view.layout.entries) {
    if (versionAfterStartup(byKey.get(key)) === NEW_VERSION) {
      return key;
    }
  }
  return null;
}
// What startup will restart, saved before it does: the store and room records of each backend.
function backUpRestarted(view) {
  const saved = [];
  for (const key of restartedKeys(view)) {
    const target = path.join(HERE, 'restart-backup.noindex', key.replace(/[^a-zA-Z0-9]/g, '_'));
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    for (const name of ['workspace.json', 'room-records.json']) {
      const file = path.join(DATA, key, name);
      if (fs.existsSync(file)) {
        fs.copyFileSync(file, path.join(target, name));
        fs.chmodSync(path.join(target, name), 0o600);
      }
    }
    saved.push({ key, target });
  }
  return saved;
}

function views() {
  const hash = value => crypto.createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
  const rows = [];
  for (const view of JSON.parse(fs.readFileSync(path.join(DATA, 'views.json'), 'utf8'))) {
    const room = { ...view, ...((view.roomViews && view.roomViews.shared) || {}) };
    const spaces = [];
    for (const id of Object.keys(view.roomViews || {}).sort()) {
      const space = view.roomViews[id] || {};
      spaces.push([id, space.sharedDraft || '', space.roomRecipient || '', space.roomMention || null]);
    }
    rows.push({ owner: view.owner, draft: hash(view.draft || null), shared: hash(room.sharedDraft || ''), recipient: hash([room.roomRecipient || '', room.roomMention || null]), spaces: hash(spaces) });
  }
  return rows;
}


  async function capture() {
    assert.equal(readSettings(DATA).auto, false, 'Automatic backend switching must be off');
    const view = await readBackends(); const staleWakes = assertQuiet(view); assertRestartsSafe(view);
    const state = { ...summary(view), staleWakes };
    for (const service of state.services) assert.ok(service.identity, 'Backend identity unavailable');
    return { state, views: views(), restarting: restartedKeys(view), expectedActive: predictActive(view), view };
  }
  // A session still working may finish its turn, reply or start the next one meanwhile; it stays on its backend.
  // Only a loss stops the install: a backend or session gone or restarted, a session ended, a record dropped or a
  // draft changed (alpha.284 rolled back on a session going from working to idle).
  function retained(before, after) {
    const was = before.state, now = after.state;
    assert.deepEqual([now.active, now.pending], [was.active, was.pending], 'Active backend retained');
    assert.deepEqual(now.services.map(s => s.key), was.services.map(s => s.key), 'Backends retained');
    for (const service of was.services) {
      const kept = now.services.find(s => s.key === service.key);
      assert.deepEqual([kept.pid, kept.identity, kept.version], [service.pid, service.identity, service.version], 'Backend process unchanged: ' + service.key);
      assert.ok(kept.sessions >= service.sessions, 'Sessions kept: ' + service.key);
      assert.ok(kept.messages >= service.messages, 'Room records kept: ' + service.key);
    }
    const stopped = ['ended', 'recoverable'];
    for (const session of was.sessions) {
      const kept = now.sessions.find(s => s.id === session.id);
      assert.ok(kept, 'Session retained: ' + session.id);
      assert.deepEqual([kept.nativeId, kept.backend, kept.settings, kept.draft], [session.nativeId, session.backend, session.settings, session.draft], 'Session, settings and native draft retained: ' + session.id);
      assert.ok(stopped.includes(session.state) || !stopped.includes(kept.state), 'Session not ended: ' + session.id);
      if (session.identity) {
        assert.deepEqual([kept.pid, kept.identity], [session.pid, session.identity], 'Native process retained: ' + session.id);
      }
    }
    assert.deepEqual(after.views, before.views, 'Flushed UI drafts retained');
  }
  async function verifyUpgrade(baseline) {
    const final = baseline.state, restarting = baseline.restarting;
    const expectedActive = baseline.expectedActive, flushed = baseline.views;
    let afterView = null, lastError = null;
    const deadline = Date.now() + 60000;
    do {
      try {
        const view = await readBackends();
        const active = view.backends.find(b => b.key === view.layout.active);
        if (active?.state.runtimeVersion === NEW_VERSION && !view.layout.pending) { afterView = view; break; }
      } catch (error) { lastError = error.message; }
      await new Promise(resolve => setTimeout(resolve, 500));
    } while (Date.now() < deadline);
    assert.ok(afterView, 'New backend did not become active' + (lastError ? ': ' + lastError : ''));
  if (expectedActive) {
    assert.equal(afterView.layout.active, expectedActive, 'Startup made the predicted backend active: ' + expectedActive);
  } else {
    assert.ok(!final.services.some(service => service.key === afterView.layout.active), 'Startup made a new backend active');
  }
  const active = afterView.backends.find(backend => backend.key === afterView.layout.active);
  for (const capability of ['queueDispatchV1', 'createSettingsV1']) {
    assert.ok(active.state.capabilities.includes(capability), 'New backend has ' + capability);
  }
  const after = summary(afterView);
  for (const session of final.sessions) {
    const kept = after.sessions.find(s => s.id === session.id);
    assert.ok(kept, 'Session retained: ' + session.id);
    assert.equal(kept.nativeId, session.nativeId, 'Native id retained: ' + session.id);
  }
  for (const service of final.services) {
    if (service.sessions === 0) {
      // An empty backend may be restarted at the new version or retired; it held no session.
      continue;
    }
    const kept = after.services.find(s => s.key === service.key);
    assert.ok(kept, 'Backend retained: ' + service.key);
    if (restarting.includes(service.key)) {
      const unchanged = JSON.stringify(kept.identity) === JSON.stringify(service.identity);
      assert.ok(unchanged || kept.version === NEW_VERSION, 'Restarted on the new code or left as it was: ' + service.key);
      assert.ok(kept.messages >= service.messages, 'Room records kept: ' + service.key);
      for (const session of final.sessions.filter(s => s.backend === service.key)) {
        assert.equal(after.sessions.find(s => s.id === session.id).state, 'ended', 'Ended session stays ended: ' + session.id);
      }
      continue;
    }
    assert.deepEqual(kept.identity, service.identity, 'Backend process unchanged: ' + service.key);
  }
  const reopened = views();
  for (const view of flushed) {
    const kept = reopened.find(row => row.owner === view.owner);
    assert.ok(kept, 'View retained');
    assert.deepEqual(kept, view, 'Drafts retained for view ' + view.owner);
  }
  for (const session of final.sessions) {
    const kept = after.sessions.find(s => s.id === session.id);
    assert.equal(kept.draft, session.draft, 'Native draft retained: ' + session.id);
    assert.equal(kept.settings, session.settings, 'Model and settings retained: ' + session.id);
    if (session.identity) {
      assert.equal(kept.pid, session.pid, 'Native process retained: ' + session.id);
      assert.deepEqual(processIdentity(kept.pid), session.identity, 'Native process start time retained: ' + session.id);
    }
  }

    return after;
  }
  // For an operator's bounded wait: what capture would refuse now, without refusing.
  async function blockers() {
    const view = await readBackends();
    return { view, ...quietBlockers(view) };
  }
  return { capture, retained, verifyUpgrade, blockers, backUp: snapshot => backUpRestarted(snapshot.view) };
}
module.exports = { createInspector };
