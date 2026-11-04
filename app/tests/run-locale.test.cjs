const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { EventEmitter } = require('node:events');
const { Workspace } = require('../workspace.cjs'), locale = require('../ui-locale.js');
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-run-locale-'));
  const host = { close() {}, create() { throw Error('Unexpected native start'); }, startCodex() { throw Error('Unexpected native provider'); } };
  const w = new Workspace(host, directory);
  const sessions = ['A', 'B', 'C'].map(id => ({ id, name: 'RAW 中文 ' + id, nativeId: 'native-' + id, provider: 'codex', state: 'idle', owner: 'owner-' + id, messages: [], fleet: [], model: 'RAW model', controlRevision: 0, memberRevision: 0 }));
  for (const s of sessions) { w.sessions.set(s.id, s); w.drafts.set(s.id, 'RAW UNSENT 中文 ' + s.id); }
  const workspaces = [w]; t.after(() => { for (const value of workspaces) value.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const run = ids => w.room.run = { id: 'run-' + ids.join(''), roomId: 'shared', ids, status: 'running', steps: 0, maxSteps: 3, awaiting: null, reason: '' };
  return { w, host, directory, sessions, run, own: value => workspaces.push(value) };
}
test('an actual native approval producer labels the pause and its existing event without changing identities or unsent drafts', t => {
  const f = fixture(t), { w } = f, s = f.sessions[0], r = new EventEmitter(); w.runtimes.set(s.id, r); w.bind(s, r); const run = f.run(['A', 'B']);
  const identities = f.sessions.map(s => [s.id, s.nativeId, s.owner, s.model]), drafts = [...w.drafts]; r.emit('state', 'approval');
  assert.equal(run.status, 'paused'); assert.equal(run.reason, '等待原生权限确认');
  assert.equal(locale.displayText('en', run.reason, run.reasonUiMessage), 'Waiting for native permission approval');
  const event = w.room.messages.at(-1); assert.equal(event.text, run.reason); assert.equal(locale.displayText('en', event.text, event.uiMessage), 'Waiting for native permission approval');
  assert.equal(locale.displayText('en', event.name, event.uiNameMessage), 'Collaboration');
  assert.deepEqual(f.sessions.map(s => [s.id, s.nativeId, s.owner, s.model]), identities); assert.deepEqual([...w.drafts], drafts);
});
test('default pauses are owned while an untagged native reason clears old display metadata and retains every original character', t => {
  const f = fixture(t), { w } = f, first = f.run(['B', 'C']); w.pause();
  assert.equal(first.status, 'paused'); assert.equal(locale.displayText('en', first.reason, first.reasonUiMessage), 'Handoffs paused');
  const second = f.run(['B', 'C']); second.reasonUiMessage = first.reasonUiMessage; const raw = 'RAW native 原文 <reason>{key}'; w.pause(raw);
  assert.equal(second.reason, raw); assert.equal(second.reasonUiMessage, undefined); assert.equal(locale.displayText('en', second.reason, second.reasonUiMessage), raw);
  const event = w.room.messages.at(-1); assert.equal(event.text, raw); assert.equal(event.uiMessage, undefined);
  const third = f.run(['B', 'C']); w.pauseRoom('shared'); assert.equal(locale.displayText('en', third.reason, third.reasonUiMessage), 'Further handoffs in this space are paused');
});
test('reopening a saved running collaboration replaces its stale descriptor along with its original recovery reason without a native start', t => {
  const f = fixture(t), { w, directory } = f, stale = locale.createNotice('notice.turnTimeUnavailable').uiMessage; f.run(['B', 'C']); w.room.run.reasonUiMessage = stale; w.persist();
  const before = JSON.parse(fs.readFileSync(path.join(directory, 'workspace.json'), 'utf8')); assert.equal(before.room.run.status, 'running'); w.close();
  const restored = new Workspace(f.host, directory); f.own(restored);
  assert.equal(restored.room.run.status, 'paused');
  assert.equal(locale.displayText('en', restored.room.run.reason, restored.room.run.reasonUiMessage), 'The runtime service was interrupted. The task was not resent; check the native results.');
  assert.notDeepEqual(restored.room.run.reasonUiMessage, stale); assert.deepEqual([...restored.drafts], [...w.drafts]);
  assert.deepEqual([...restored.sessions.values()].map(s => [s.id, s.nativeId, s.model]), f.sessions.map(s => [s.id, s.nativeId, s.model]));
});
