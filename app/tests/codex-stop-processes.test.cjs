// Real OS processes through Workspace.stop -> Codex.stop -> Terminal -> PTY.
// The synthetic native tree ignores SIGTERM; no provider binary or model runs.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { Codex } = require('../adapters.cjs');
const { Workspace } = require('../workspace.cjs');
const { RoomState } = require('../room-state.cjs');
const { pythonExecutable } = require('../platform.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function exists(pid) { try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; } }
async function until(check, message) {
  for (let i = 0; i < 200; i++) { if (check()) return; await delay(20); }
  assert.fail(message);
}
async function fixture(t, mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-stop-tree-')), calls = [], terminals = [];
  const foreign = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', 'app-server'], { stdio: 'ignore', detached: true });
  await once(foreign, 'spawn');
  const host = { binaries: {}, codexTargets: new Map(), codexProcess: foreign, close() {},
    rpc: { async call(method, args) { calls.push([method, args]); return { status: 'unsubscribed' }; } } };
  const w = new Workspace(host, dir), rooms = new RoomState(dir);
  t.after(async () => {
    w.close();
    for (const { terminal, tree } of terminals) {
      // Only groups created and acknowledged by this fixture; never scan names.
      if (tree && exists(-tree.group)) process.kill(-tree.group, 'SIGKILL');
      if (terminal.alive) { terminal.worker.stdin.end(); await once(terminal.worker, 'close'); }
    }
    if (foreign.exitCode === null && foreign.signalCode === null) { const exited = once(foreign, 'exit'); foreign.kill('SIGKILL'); await exited; }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  async function session(id, behaviour) {
    const s = { id, name: id, nativeId: 'native-' + id, provider: 'codex', cwd: dir, state: 'idle', view: 'terminal', messages: [], fleet: [], controlRevision: 0, connectionRevision: 0 };
    const r = new Codex(s, host); w.sessions.set(id, s); w.runtimes.set(id, r); host.codexTargets.set(s.nativeId, r); w.bind(s, r);
    const receipt = path.join(dir, id + '.json'), terminal = r.makeTerminal([pythonExecutable(), path.join(__dirname, 'fixtures/terminal-process-tree.py'), receipt, behaviour]);
    const entry = { terminal }; terminals.push(entry);
    await until(() => { try { entry.tree = JSON.parse(fs.readFileSync(receipt)); return true; } catch { return false; } }, 'native fixture must acknowledge its child and process group');
    await until(() => terminal.pid === entry.tree.leader, 'Terminal must observe the real native leader');
    assert.equal(entry.tree.leader, entry.tree.group, 'only the isolated PTY group is owned');
    return { s, r, receipt, ...entry };
  }
  const target = await session('target', mode), other = await session('other', 'stubborn');
  const client = { snapshot: () => w.snapshot(), async call(method) {
    if (method === 'initial') return w.snapshot();
    if (method === 'pause' || method === 'pauseSpace') return;
    throw Error('Unexpected archive operation: ' + method);
  } };
  return { w, rooms, client, target, other, foreign, calls };
}
test('disconnect lets native shutdown finish its delayed save', { timeout: 15000 }, async t => {
  const f = await fixture(t, 'graceful'), started = Date.now();
  await f.w.stop(f.target.s.id);
  assert.equal(fs.existsSync(f.target.receipt + '.saved'), true, 'TERM cleanup must complete before force-kill');
  assert.equal(fs.readFileSync(f.target.receipt + '.saved', 'utf8'), 'saved before exit');
  if (process.platform === 'darwin') assert.ok(Date.now() - started < 4500, 'a fully exited native group need not wait out the force-kill deadline');
  assert.equal(exists(-f.target.tree.group), false);
});
for (const mode of ['stubborn', 'leader-exits']) test(`disconnect then archive reaps the owned Codex terminal group: ${mode}`, { timeout: 20000 }, async t => {
  const f = await fixture(t, mode), { leader, child, group } = f.target.tree;
  let failure;
  try { await f.w.stop(f.target.s.id); } catch (error) { failure = error; }
  if (!failure) await f.rooms.archiveSession(f.client, f.target.s.id);
  const alive = { leader: exists(leader), child: exists(child), group: exists(-group) };
  t.diagnostic(JSON.stringify({ mode, alive, state: f.target.s.state, failure: failure?.message }));
  assert.equal(exists(f.other.tree.leader), true, 'another NAW session survives');
  assert.equal(exists(f.other.tree.child), true, 'another session child survives');
  assert.equal(exists(f.foreign.pid), true, 'an app-server not owned by this Terminal survives');
  assert.deepEqual(alive, { leader: false, child: false, group: false }, 'disconnect/archive must not leave the owned native process or group alive');
  assert.equal(failure, undefined);
  assert.equal(f.target.s.state, 'disconnected');
  assert.equal(f.rooms.value.archivedSessions.includes(f.target.s.id), true);
  assert.deepEqual(f.calls, [['thread/unsubscribe', { threadId: f.target.s.nativeId }]]);
});

for (const how of ['eof', 'signal', 'repeated-stop']) test(`owned native group cleanup also completes after ${how}`, { timeout: 15000 }, async t => {
  const f = await fixture(t, 'stubborn'), terminal = f.target.terminal;
  const closed = once(terminal, 'closed');
  let repeated;
  if (how === 'eof') terminal.worker.stdin.end();
  else if (how === 'signal') terminal.worker.kill('SIGTERM');
  else {
    terminal.command({ type: 'stop' });
    repeated = setInterval(() => { if (terminal.alive) terminal.command({ type: 'stop' }); }, 100);
  }
  t.after(() => clearInterval(repeated));
  const [result] = await closed; clearInterval(repeated);
  assert.equal(result.confirmed, true);
  assert.equal(exists(f.target.tree.child), false);
  assert.equal(exists(-f.target.tree.group), false);
  assert.equal(exists(f.other.tree.child), true);
  assert.equal(exists(f.foreign.pid), true);
});
