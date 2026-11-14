// Which window holds a session against the one the person uses. The person, 2026-11-13: two sessions the
// butler had created in the background read 「另一个窗口控制」 until they pressed 「接管此窗口」, although
// no other window was open. Real Workspace, and real framed Unix RPC to a daemon with the synthetic native
// fixture; no provider process, native input or model.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { fork } = require('node:child_process'), { once } = require('node:events');
const { Workspace } = require('../workspace.cjs');
const { connectService } = require('../service-connection.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-pageless-unit-'));
  const w = new Workspace({ binaries: {}, close() {} }, dir), paused = [];
  w.pause = (...args) => paused.push(args);
  t.after(() => { w.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const session = owner => {
    const s = { id: `s-${w.sessions.size}`, owner, view: 'chat', controlRevision: 0, messages: [], state: 'idle' };
    w.sessions.set(s.id, s); return s;
  };
  return { w, paused, session };
}

test('a window takes a session no open window holds without a takeover; another open window still holds one', t => {
  const { w, paused, session } = workspace(t);
  w.viewConnected('person-window'); w.viewConnected('hidden-request-window', false);
  const created = session('hidden-request-window'), restarted = session(null);
  const shown = id => w.snapshot().sessions.find(s => s.id === id);
  assert.equal(shown(created.id).ownerPageless, true);
  w.claim(created.id, 'person-window', 'chat'); w.claim(restarted.id, 'person-window', 'chat');
  assert.deepEqual([created.owner, created.controlRevision, restarted.owner, restarted.controlRevision], ['person-window', 0, 'person-window', 0]);
  assert.equal(paused.length, 0, 'nothing is paused for a session nobody was using');
  assert.equal(shown(created.id).ownerPageless, undefined);

  w.viewConnected('second-window');
  w.claim(created.id, 'second-window', 'chat');
  assert.equal(created.controlRevision, 1, 'a window the person has open is taken over as before');
  assert.equal(paused.length, 1);
  // The app quits, or the window's UI updates: it keeps its sessions until it reconnects.
  w.release('second-window');
  assert.equal(shown(created.id).ownerPageless, undefined, 'a window that only lost its connection still holds its session');
  w.viewConnected('second-window');
  // The person closes that window: it holds nothing against the open one.
  w.release('second-window', true, true);
  assert.equal(shown(created.id).ownerPageless, true, 'a closed window holds nothing against the open one');
  w.claim(created.id, 'person-window', 'chat');
  assert.equal(created.controlRevision, 1); assert.equal(paused.length, 1);
  // A closed window's owner that connects again holds its sessions again.
  w.claim(created.id, 'second-window', 'chat'); w.viewConnected('second-window');
  assert.equal(shown(created.id).ownerPageless, undefined);
});

test('owners that are gone and hold nothing are not kept', t => {
  const { w, session } = workspace(t);
  for (let i = 0; i < 50; i++) { w.viewConnected(`probe-${i}`); w.release(`probe-${i}`, true, i % 2 === 0); w.viewConnected(`hidden-${i}`, false); w.release(`hidden-${i}`, false); }
  assert.deepEqual([w.viewOwners.size, w.pagelessOwners.size], [0, 0]);
  w.viewConnected('hidden', false); session('hidden'); w.release('hidden', false);
  assert.deepEqual([...w.pagelessOwners], ['hidden'], 'one that still holds a session stays pageless');
});

test('a hidden connection over real Unix RPC creates a session the person window uses without a takeover', { timeout: 20000 }, async t => {
  const root = path.resolve(__dirname, '../..'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-pageless-rpc-')); fs.chmodSync(dir, 0o700);
  let stderr = ''; const clients = [];
  const child = fork(path.join(root, 'app/daemon.cjs'), [dir], { execArgv: ['--require', path.join(root, 'scripts/fixtures/native-progress.cjs')], env: { ...process.env, NAW_TEST_APP_ROOT: root, NAW_WORKSPACE: path.join(dir, 'workspace') }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    const alive = () => child.exitCode === null && child.signalCode === null;
    if (alive()) {
      const exited = once(child, 'exit');
      try {
        const client = clients.find(c => !c.closing) || await connectService(dir, 'pageless-cleanup');
        child.send({ method: 'stop' }); await client.call('shutdown');
        let timer; await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 10000); })]); clearTimeout(timer);
      } catch {}
      if (alive()) { child.kill('SIGKILL'); await exited; }
    }
    for (const client of clients) client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  for (const end = Date.now() + 5000; Date.now() < end && !fs.existsSync(path.join(dir, 'connection.json')) && child.exitCode === null;) await delay(10);
  assert.ok(fs.existsSync(path.join(dir, 'connection.json')), stderr);
  const open = async (owner, options) => { const client = await connectService(dir, owner, options); clients.push(client); return client; };
  const agent = await open('hidden-request-window', { page: false });
  const person = await open('person-window');
  const id = await agent.call('create', { provider: 'codex', cwd: dir, name: 'Created in the background', view: 'chat' });
  const record = async () => (await person.call('initial')).sessions.find(s => s.id === id);
  let s = await record();
  assert.deepEqual([s.owner, s.ownerPageless], ['hidden-request-window', true]);
  const control = s.controlRevision;
  await person.call('claim', id, 'chat');
  s = await record();
  assert.deepEqual([s.owner, s.ownerPageless, s.controlRevision], ['person-window', undefined, control]);

  const second = await open('second-window');
  await second.call('claim', id, 'chat');
  assert.equal((await record()).controlRevision, control + 1, 'two open windows: taking it over stays a takeover');
  // An app quit ends the connection without leaving: the window keeps the session for when it reconnects.
  const quitting = await open('quitting-window');
  await quitting.call('claim', id, 'chat'); quitting.close();
  await delay(300);
  s = await record();
  assert.deepEqual([s.owner, s.ownerPageless, s.controlRevision], ['quitting-window', undefined, control + 2]);
  const reopened = await open('quitting-window');
  await reopened.call('claim', id, 'chat'); await second.call('claim', id, 'chat');
  assert.equal((await record()).controlRevision, control + 3);
  // The person closes the second window: it leaves, and holds nothing afterwards.
  second.call('leave').catch(() => {}); second.close();
  for (const end = Date.now() + 5000; Date.now() < end && !(await record()).ownerPageless;) await delay(20);
  assert.equal((await record()).ownerPageless, true, 'a closed window holds nothing');
  await person.call('claim', id, 'chat');
  s = await record();
  assert.deepEqual([s.owner, s.controlRevision], ['person-window', control + 3]);
});

test('a free claim takes only a session no open window holds, atomically and without a takeover', t => {
  const { w, paused, session } = workspace(t);
  let changes = 0; const changed = w.changed.bind(w); w.changed = (...args) => { changes++; return changed(...args); };
  w.viewConnected('person-window'); w.viewConnected('other-window'); w.viewConnected('hidden-request-window', false);
  const held = session('other-window'), hidden = session('hidden-request-window'), nobody = session(null);
  // Two windows showing the same free session: the one that asks second finds it held and leaves it.
  assert.equal(w.claim(held.id, 'person-window', 'chat', undefined, true), false);
  assert.deepEqual([held.owner, held.controlRevision, paused.length], ['other-window', 0, 0]);
  for (const s of [hidden, nobody]) w.claim(s.id, 'person-window', 'terminal', undefined, true);
  assert.deepEqual([hidden.owner, hidden.view, nobody.owner, hidden.controlRevision, nobody.controlRevision, paused.length], ['person-window', 'terminal', 'person-window', 0, 0, 0]);
  // The hidden connection is still open, so it stays listed; once it is gone and holds nothing, it is not kept.
  assert.equal(w.pagelessOwners.has('hidden-request-window'), true);
  const again = session('hidden-request-window'); w.release('hidden-request-window', false);
  w.claim(again.id, 'person-window', 'chat', undefined, true);
  assert.equal(w.pagelessOwners.has('hidden-request-window'), false);
  // Another connection of an owner already counted changes nothing anyone sees.
  changes = 0; w.viewConnected('person-window'); w.viewConnected('hidden-other', false); w.viewConnected('hidden-other', false);
  assert.equal(changes, 1, 'only the new pageless owner is a change');
});

test('over real Unix RPC a free claim leaves a session another open window holds, and other claim forms are refused', { timeout: 20000 }, async t => {
  const root = path.resolve(__dirname, '../..'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-free-claim-rpc-')); fs.chmodSync(dir, 0o700);
  let stderr = ''; const clients = [];
  const child = fork(path.join(root, 'app/daemon.cjs'), [dir], { execArgv: ['--require', path.join(root, 'scripts/fixtures/native-progress.cjs')], env: { ...process.env, NAW_TEST_APP_ROOT: root, NAW_WORKSPACE: path.join(dir, 'workspace') }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    const alive = () => child.exitCode === null && child.signalCode === null;
    if (alive()) {
      const exited = once(child, 'exit');
      try {
        const client = clients.find(c => !c.closing) || await connectService(dir, 'free-claim-cleanup');
        child.send({ method: 'stop' }); await client.call('shutdown');
        let timer; await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 10000); })]); clearTimeout(timer);
      } catch {}
      if (alive()) { child.kill('SIGKILL'); await exited; }
    }
    for (const client of clients) client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  for (const end = Date.now() + 5000; Date.now() < end && !fs.existsSync(path.join(dir, 'connection.json')) && child.exitCode === null;) await delay(10);
  assert.ok(fs.existsSync(path.join(dir, 'connection.json')), stderr);
  const open = async (owner, options) => { const client = await connectService(dir, owner, options); clients.push(client); return client; };
  const agent = await open('hidden-request-window', { page: false }), person = await open('person-window'), other = await open('other-window');
  assert.ok((await person.call('initial')).capabilities.includes('freeClaimV1'));
  assert.ok((await person.call('initial')).capabilities.includes('eitherViewInputV1'), 'The service says it takes terminal keys on either side of the view (887d9fea)');
  const id = await agent.call('create', { provider: 'codex', cwd: dir, name: 'Created in the background', view: 'chat' });
  const record = async () => (await person.call('initial')).sessions.find(s => s.id === id);
  const control = (await record()).controlRevision;
  await other.call('claim', id, 'chat', 'free');
  assert.equal(await person.call('claim', id, 'chat', 'free'), false);
  let s = await record();
  assert.deepEqual([s.owner, s.controlRevision], ['other-window', control], 'the second window to ask takes nothing over');
  await assert.rejects(person.call('claim', id, 'chat', 'take'));
  assert.equal((await record()).owner, 'other-window');
  await person.call('claim', id, 'chat');
  s = await record();
  assert.deepEqual([s.owner, s.controlRevision], ['person-window', control + 1], 'the explicit takeover still is one');
});

test('a window taking a free session as it shows it does not hold queued work back as the person\'s', () => {
  const vm = require('node:vm'), source = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8');
  const start = source.indexOf('const HUMAN_SESSION_METHODS'), end = source.indexOf('// A key the person typed in a window', start);
  const sandbox = { queueRules: require('../queue-dispatch.cjs') }; vm.createContext(sandbox);
  vm.runInContext(source.slice(start, end), sandbox);
  const human = vm.runInContext('humanSessionWork', sandbox);
  assert.equal(human('claim', ['id', 'chat', 'free']), false);
  assert.equal(human('claim', ['id', 'chat']), true, 'choosing a view or taking over still is');
  assert.equal(human('draft', ['id', 'text']), true);
  assert.equal(human('input', ['id', '\x1b[I']), false);
});

test('the window shows 接管此窗口 only for a session another open window holds, or any other window\'s on a service without the check', () => {
  const vm = require('node:vm'), source = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
  const line = source.split('\n').find(l => l.startsWith('function heldElsewhere(s)'));
  const misses = source.split('\n').find(l => l.startsWith('const freeSessionMisses = '));
  const sandbox = { owner: 'this-window' }; vm.createContext(sandbox); vm.runInContext(misses + '\n' + line, sandbox);
  const held = vm.runInContext('heldElsewhere', sandbox);
  const cases = [
    [{ owner: 'this-window', freeClaim: true }, false], [{ owner: 'other-window', freeClaim: true }, true],
    [{ owner: 'hidden-request-window', ownerPageless: true, freeClaim: true }, false], [{ owner: null, freeClaim: true }, false],
    [{ owner: 'hidden-request-window', freeClaim: false }, true], [{ owner: null }, true], [{ owner: 'this-window' }, false],
  ];
  assert.deepEqual(cases.map(([s]) => held(s)), cases.map(([, expected]) => expected));
});

// Review of the pageless owner (2026-11-13): a take that missed because the composer showed another session
// meanwhile, or that failed, left the composer looking usable with no 接管此窗口, and sending was refused.
test('a free take retries after the composer comes back, and a failed one shows 接管此窗口', async () => {
  const vm = require('node:vm'), source = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
  const lines = source.split('\n'), from = lines.findIndex(l => l.startsWith('const freeSessionMisses = '));
  const to = lines.findIndex((l, i) => i > from && l.startsWith('function soloAction('));
  const held = lines.find(l => l.startsWith('function heldElsewhere(s)'));
  const calls = [], sandbox = { owner: 'this-window', disconnected: false, mode: 'chat', selectionRevision: 1, viewClaims: new Map(), current: true,
    nativeUsable: () => true, render: () => {}, composerCurrent: () => sandbox.current, attempt: action => { sandbox.running = action().catch(() => {}); },
    claimView: async id => { calls.push(id); return sandbox.outcome(); } };
  vm.createContext(sandbox); vm.runInContext(lines.slice(from, to).join('\n') + '\n' + held, sandbox);
  const takeNow = vm.runInContext('takeFreeSession', sandbox), heldElsewhere = vm.runInContext('heldElsewhere', sandbox);
  const binding = {}, s = { id: 'free', owner: null, freeClaim: true, controlRevision: 0 };
  const take = async (...args) => { sandbox.running = null; takeNow(...args); await sandbox.running; };
  // The composer shows another session before the claim is made: nothing is recorded against this one.
  sandbox.outcome = () => { sandbox.current = false; return false; };
  await take(binding, s); assert.equal(heldElsewhere(s), false);
  sandbox.current = true; sandbox.outcome = () => true;
  await take(binding, s); assert.deepEqual(calls, ['free', 'free'], 'Showing it again tries again');
  // A failure keeps the composer read-only with 接管此窗口, once, until the owner or control changes.
  sandbox.outcome = () => { throw Error('ipc closed'); };
  await take(binding, s); assert.equal(heldElsewhere(s), true);
  await take(binding, s); assert.equal(calls.length, 3, 'No retry loop');
  assert.equal(heldElsewhere({ ...s, controlRevision: 1 }), false);
  // Once this window holds it (接管此窗口), the miss is gone: free again later, it is taken as it shows.
  await take(binding, { ...s, owner: 'this-window' }); assert.equal(heldElsewhere(s), false);
});
