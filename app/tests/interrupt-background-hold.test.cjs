// 11-09: a Claude session was interrupted while a background sub-agent kept its turn running. NAW pressed Esc (no
// native abort for that version) and for 45 minutes showed only "check team tasks in the native terminal", while
// every message to it was refused. The interrupt notice now says which background work holds the turn, since when
// NAW saw it, and where it can be stopped, and it follows that work as it stops. Messages are not delivered meanwhile:
// a direct send keeps its draft and a space queue item waits; after the interrupted turn ends, Claude needs one input in
// the native terminal before NAW can send again. Zero model: a real Workspace bound to a real Claude adapter.
// Not decided here [需用户]: stopping sub-agents on interrupt, or holding direct and peer messages for later.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { randomUUID } = require('node:crypto'), { EventEmitter } = require('node:events');
const { Claude } = require('../adapters.cjs'), { Workspace } = require('../workspace.cjs'), { SubmissionChannel } = require('../claude-submit.cjs');
const locale = require('../ui-locale.js'), queue = require('../queue-dispatch.cjs');

const START = Date.UTC(2026, 10, 9, 18, 51), clock = time => new Date(time).toTimeString().slice(0, 5);
function stuck(t, { abort = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-interrupt-hold-')), w = new Workspace({ binaries: {}, close() {} }, dir);
  const r = Object.create(Claude.prototype); EventEmitter.call(r);
  r.record = { nativeId: randomUUID() }; r.terminal = { alive: true, keys: [], input(key) { this.keys.push(key); } };
  r.submission = new SubmissionChannel(); r.bindRoot({ sessionId: r.record.nativeId });
  const s = r.record; Object.assign(s, { id: 'synthetic', name: 'Synthetic', owner: 'window', view: 'chat', controlRevision: 0, memberRevision: 0, provider: 'claude', messages: [], fleet: [], state: 'working' });
  w.sessions.set(s.id, s); w.runtimes.set(s.id, r); w.bind(s, r);
  // A version without native abort: NAW falls back to Esc, and the native turn stays running behind its sub-agent.
  r.nativeAbortAvailable = abort; r.rootTurn = { id: 'native-turn', status: 'working' }; r.ready = true; r.chatAvailable = true;
  t.after(() => { w.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const child = (event, id, name, time, extra = {}) => { r.emit('fleet', { event, id, name, ...extra }); s.fleet.at(-1).time = time; };
  return { w, r, s, child };
}
const shown = (s, language) => locale.format(language, s.activityUiMessage.key, s.activityUiMessage.params);

test('an interrupt held by a running sub-agent names it, says since when and where to stop it, in both languages', async t => {
  const f = stuck(t);
  f.child('SubagentStart', 'agent-1', 'general-purpose', START);
  await f.w.interrupt(f.s.id, 'window');
  assert.deepEqual(f.r.terminal.keys, ['\x1b'], 'The Esc fallback, as in the incident');
  assert.equal(f.s.activityUiMessage.key, 'notice.activity.interruptWaitsForSubagent');
  assert.deepEqual(f.s.activityUiMessage.params, { name: 'general-purpose', since: clock(START), count: 1 });
  for (const language of ['zh', 'en']) {
    const text = shown(f.s, language);
    for (const fact of ['general-purpose', clock(START), locale.format(language, 'advanced.end'), locale.format(language, 'header.resume')]) assert.ok(text.includes(fact), `${language}: ${fact}`);
  }
  assert.doesNotMatch(shown(f.s, 'en'), /[㐀-鿿]/, 'The English notice has no Chinese');
  assert.equal(f.s.activity, shown(f.s, 'zh'), 'The stored text is the Chinese catalog text');
});

test('with several running sub-agents the earliest one is named and all are counted; a stopped one is not', async t => {
  const f = stuck(t);
  f.child('SubagentStart', 'agent-1', 'reviewer', START + 60000);
  f.child('SubagentStart', 'agent-2', 'general-purpose', START);
  f.child('SubagentStart', 'agent-3', 'finished', START - 60000); f.child('SubagentStop', 'agent-3', 'finished', START + 120000);
  await f.w.interrupt(f.s.id, 'window');
  assert.deepEqual(f.s.activityUiMessage.params, { name: 'general-purpose', since: clock(START), count: 2 });
});

test('background work known only from the last turn-end report, or a child without a native name, is counted without a name', async t => {
  for (const setup of [
    f => f.r.emit('background', { count: 2, scheduled: 0, kinds: ['subagent', 'shell'], ids: ['task-1', 'task-2'] }),
    f => f.child('SubagentStart', 'agent-1', '原生团队活动', START, { nameUiMessage: { key: 'notice.fleet.nativeTeamActivity' } }),
  ]) {
    const f = stuck(t); setup(f);
    await f.w.interrupt(f.s.id, 'window');
    assert.equal(f.s.activityUiMessage.key, 'notice.activity.interruptWaitsForBackground');
    assert.doesNotMatch(shown(f.s, 'en'), /[㐀-鿿]/);
  }
});

test('the notice follows the sub-agents as NAW sees them stop', async t => {
  const f = stuck(t);
  f.child('SubagentStart', 'agent-1', 'general-purpose', START); f.child('SubagentStart', 'agent-2', 'reviewer', START + 60000);
  await f.w.interrupt(f.s.id, 'window');
  assert.deepEqual(f.s.activityUiMessage.params, { name: 'general-purpose', since: clock(START), count: 2 });
  f.child('SubagentStop', 'agent-1', 'general-purpose', START + 120000);
  assert.deepEqual(f.s.activityUiMessage.params, { name: 'reviewer', since: clock(START + 60000), count: 1 });
  f.child('SubagentStop', 'agent-2', 'reviewer', START + 180000);
  assert.equal(f.s.activityUiMessage.key, 'notice.activity.interruptRequested', 'Nothing observed is left; the turn itself has not ended yet');
});

test('with nothing observed in the background the interrupt notice is unchanged', async t => {
  const f = stuck(t);
  f.child('SubagentStart', 'agent-1', 'general-purpose', START); f.child('SubagentStop', 'agent-1', 'general-purpose', START + 1000);
  await f.w.interrupt(f.s.id, 'window');
  assert.equal(f.s.activityUiMessage.key, 'notice.activity.interruptRequested');
});

test('while the sub-agent holds the turn, a direct message is refused with its draft kept and a queue item waits until the member is free', async t => {
  const f = stuck(t);
  f.child('SubagentStart', 'agent-1', 'general-purpose', START);
  await f.w.interrupt(f.s.id, 'window');
  f.w.drafts.set(f.s.id, 'The next direction');
  await assert.rejects(f.w.send(f.s.id, 'The next direction', 'window'), e => e.uiMessage?.key === 'error.workspace.sessionNotReady');
  assert.equal(f.w.drafts.get(f.s.id), 'The next direction', 'The draft is kept');
  assert.equal(f.w.versions.dispatches, 0, 'Nothing reached the native session');
  // The person moves the message from the draft into the space queue (an unsent draft also keeps the queue out).
  f.w.drafts.delete(f.s.id);
  const ready = () => queue.sessionReady({ ...f.w.snapshot().sessions[0], serviceCapabilities: [queue.CAPABILITY] }, { enabled: true });
  assert.equal(ready().reason, 'not-idle', 'The queue does not send into the held turn');
  // The sub-agent stops and the interrupted turn ends: Claude then waits for one input in the native terminal.
  f.child('SubagentStop', 'agent-1', 'general-purpose', START + 45 * 60000);
  f.r.rootTurn.status = 'idle'; f.r.finishInterrupted('native-turn');
  assert.equal(f.s.state, 'idle'); assert.equal(f.s.activity, '', 'The interrupt notice is cleared');
  assert.equal(ready().reason, 'busy', 'The queue item still waits, as the notice says');
  // The person types once in the native terminal; that turn clears the pause (adapters.cjs, a new root turn).
  f.r.nativeInputRequired = false; f.r.emit('inputRequired', false);
  assert.equal(ready().ready, true, 'Now the queue may send it');
});
