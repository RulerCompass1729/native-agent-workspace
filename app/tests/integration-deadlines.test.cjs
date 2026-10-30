const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Workspace } = require('../workspace.cjs'), { Codex } = require('../adapters.cjs');

test('the shared interval expires each room while still reporting a silent native tool', t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1800000000000 });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-integration-deadline-'));
  const calls = [], host = { binaries: {}, codexTargets: new Map(), close() {}, rpc: {
    call: async method => { calls.push(method); throw Error('Unexpected native call'); },
  } };
  const w = new Workspace(host, directory);
  t.after(() => { w.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const s = { id: 'original', nativeId: randomUUID(), provider: 'codex', cwd: directory,
    messages: [], state: 'idle', owner: 'original-view', controlRevision: 0, memberRevision: 0 };
  const r = new Codex(s, host); w.sessions.set(s.id, s); w.runtimes.set(s.id, r); w.bind(s, r);
  const event = (method, params) => r.event({ method, params: { threadId: s.nativeId, ...params } });
  event('turn/started', { turn: { id: 'original-turn' } });
  event('item/started', { turnId: 'original-turn', item: { id: 'original-read', type: 'mcpToolCall', status: 'inProgress' } });
  w.setDraft(s.id, 'Original unsent text', s.owner);
  const extra = w.roomFor(randomUUID(), true), other = w.roomFor(randomUUID(), true), now = Date.now();
  for (const [room, delay] of [[w.room, 600000], [extra, 60000], [other, 120000]]) {
    room.run = { id: randomUUID(), roomId: room.id, status: 'running', ids: [], deadline: now + delay };
  }
  const identity = [s.nativeId, s.owner, s.controlRevision, s.memberRevision];
  // Exercise the real interval, not either component's manual tick method.
  t.mock.timers.tick(300000);
  assert.equal(extra.run.status, 'paused'); assert.equal(other.run.status, 'paused');
  assert.equal(w.room.run.status, 'running', 'An unrelated unexpired room keeps its authorization');
  assert.equal(r.nativeActivity.waitNotice?.kind, 'tool-wait');
  assert.equal(s.state, 'working', 'An advisory does not terminate or pause native work');
  assert.deepEqual([s.nativeId, s.owner, s.controlRevision, s.memberRevision], identity);
  assert.equal(w.drafts.get(s.id), 'Original unsent text'); assert.deepEqual(calls, []);
});
