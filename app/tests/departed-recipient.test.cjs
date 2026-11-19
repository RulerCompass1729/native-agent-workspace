const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Workspace } = require('../workspace.cjs');
const { identity } = require('../peer-handoffs.cjs');

// T-169 ②: once a member has left a space, no space message reaches it.
// - Shared forwarding, queued input and steering each refuse that member at entry (workspace.cjs forward, queue, steer),
//   in the shared space and in a named space, before anything is sent or written to the space's record.
// - Input accepted while it was still a member is refused at the native write: the queue and steer guards need an open
//   shared-reply grant, and a leave closes it (SharedReplies.valid rechecks membership). The guards' own membership
//   clause is redundant with that. For Claude the last checks are in claude-submit.cjs; Codex steering checks its guard
//   and writes in the same tick, so the gap held open below only exists in real code for Claude.
// - Wakes address a session by its id, not a space. A wake's target identity holds the shared-space membership
//   revision, so leaving the shared space invalidates a staged wake; leaving a named space does not. Where a wake's
//   record row goes is T-143's open question.
// Covered elsewhere: the recipient saved in or restored to the view (room-recipient-reopen.test.cjs;
// scripts/test-collaboration.cjs leftRecipientCleared), and a member leaving while a send or a handoff is pending
// (workspace.test.cjs; addressed-handoffs.test.cjs).
async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'departed-recipient-'));
  const sends = [];
  const host = { binaries: {}, close() {}, create() {
    const runtime = new EventEmitter();
    runtime.start = async () => runtime.emit('state', 'idle');
    runtime.send = async (...args) => { sends.push(['send', ...args]); };
    runtime.finishTurn = () => {};
    // Like the real runtimes, check the workspace's guard right before writing.
    runtime.hold = Promise.resolve();
    runtime.queue = async (text, tag, guard) => { await runtime.hold; if (!guard()) throw Object.assign(Error('Synthetic not sent'), { notSent: true }); sends.push(['queue', text]); };
    runtime.steer = async (text, tag, expectedTurnId, guard) => { await runtime.hold; if (!guard()) throw Object.assign(Error('Synthetic not sent'), { notSent: true }); sends.push(['steer', text]); };
    return runtime;
  } };
  const workspace = new Workspace(host, directory);
  t.after(() => { workspace.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const claude = await workspace.create('claude', directory, 'owner', 'Claude member');
  const codex = await workspace.create('codex', directory, 'owner', 'Codex member');
  return { workspace, sends, claude, codex };
}
const spaceFor = (w, kind) => { if (kind === 'shared') return 'shared'; const id = randomUUID(); w.roomFor(id, true); return id; };
const left = e => e.uiMessage?.key === 'error.workspace.recipientLeftSpace';
// Each path gets a session in the state that path accepts, so only membership can refuse it.
const paths = {
  forward: { id: f => f.claude, prepare() {}, call: (w, id, space) => w.forward(id, 'forward to someone who left', 'owner', undefined, space) },
  queue: { id: f => f.claude, prepare(s, r) { s.state = 'working'; r.queueAvailable = true; }, call: (w, id, space) => w.queue(id, 'queue to someone who left', 'owner', { roomId: space }) },
  steer: { id: f => f.codex, prepare(s, r) { s.state = 'working'; r.steerAvailable = true; r.turnId = 'turn-1'; }, call: (w, id, space) => w.steer(id, 'steer someone who left', 'owner', 'turn-1', { roomId: space }) },
};

for (const [name, p] of Object.entries(paths)) for (const kind of ['shared', 'named']) {
  test(`${name}: a member who left ${kind === 'shared' ? 'the shared space' : 'a named space'} is refused before anything is sent or recorded`, async t => {
    const f = await fixture(t), w = f.workspace, space = spaceFor(w, kind), id = p.id(f);
    w.join(id, true, space); w.join(id, false, space);
    assert.equal(w.get(id).roomId ?? null, null);
    p.prepare(w.get(id), w.runtime(id));
    const before = w.roomFor(space).messages.length;
    await assert.rejects(p.call(w, id, space), left);
    assert.deepEqual(f.sends, [], 'Nothing reached a native runtime');
    assert.equal(w.roomFor(space).messages.length, before, 'Nothing was written to the space record');
  });
}

test('a member who left one space and joined another is still refused for the space it left', async t => {
  const f = await fixture(t), w = f.workspace, gone = spaceFor(w, 'named'), other = spaceFor(w, 'named');
  w.join(f.claude, true, gone); w.join(f.claude, false, gone); w.join(f.claude, true, other);
  await assert.rejects(paths.forward.call(w, f.claude, gone), left);
  assert.deepEqual(f.sends, []); assert.equal(w.roomFor(gone).messages.length, 0);
});

// Queue and steer both prove a non-send as not-sent: the Codex adapter's refusal before turn/steer carries notSent and
// Workspace.steer keeps it, as queue does (review C-a1, 2026-11-19; it was unconfirmed before).
for (const [name, status] of [['queue', 'not-sent'], ['steer', 'not-sent']]) test(`${name}: a member who leaves after its input is accepted, before the native write, gets nothing`, async t => {
  const f = await fixture(t), w = f.workspace, space = spaceFor(w, 'named'), p = paths[name], id = p.id(f);
  w.join(id, true, space);
  const runtime = w.runtime(id); p.prepare(w.get(id), runtime);
  let release; runtime.hold = new Promise(resolve => { release = resolve; });
  const pending = p.call(w, id, space); pending.catch(() => {});
  await new Promise(resolve => setImmediate(resolve));
  const row = w.roomFor(space).messages.find(m => m.recipientId === id);
  assert.equal(row?.status, 'awaiting-native', 'The input was accepted while still a member');
  w.join(id, false, space); release();
  await assert.rejects(pending, e => e.notSent === true);
  assert.deepEqual(f.sends, [], 'The guard checked at the native write refused it');
  assert.equal(row.status, status, 'The space record does not claim it was delivered');
});

test('leaving the shared space changes the identity a staged wake must still match', async t => {
  const f = await fixture(t), w = f.workspace;
  w.join(f.codex, true, 'shared');
  const proof = JSON.stringify(identity(w.get(f.codex)));
  w.join(f.codex, false, 'shared');
  assert.notEqual(JSON.stringify(identity(w.get(f.codex))), proof);
});
