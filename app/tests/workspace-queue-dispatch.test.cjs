const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Workspace } = require('../workspace.cjs');
const wake = require('../session-wake.cjs');

// The backend half of queue dispatch (queue-dispatch.cjs): a NAW input that is
// neither a takeover nor human input, and that the person's switches and draft stop.
async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-workspace-dispatch-'));
  const sent = [];
  const host = {
    binaries: {},
    close() {},
    create(record) {
      const runtime = new EventEmitter();
      runtime.send = async (text, tag, guard) => {
        assert.ok(guard());
        sent.push({ id: record.id, text, tag });
      };
      runtime.start = async () => runtime.emit('state', 'idle');
      return runtime;
    },
  };
  const w = new Workspace(host, directory);
  t.after(() => {
    w.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const ids = [];
  for (const name of ['A', 'B', 'C']) {
    const id = await w.create('claude', directory, 'person', name);
    w.join(id, true);
    ids.push(id);
  }
  return { w, ids, sent };
}

function dispatch(w, id, text = '【NAW 派活】task') {
  return w.send(id, text, 'naw-dispatcher', null, null, null, null, null, null, null, { itemId: 'item-1' });
}

test('a dispatched item is sent without taking control and is recorded as NAW, not the person', async t => {
  const { w, ids, sent } = await fixture(t);
  const before = { ...w.get(ids[0]) };
  const tag = await dispatch(w, ids[0]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].tag, tag);
  const after = w.get(ids[0]);
  assert.equal(after.owner, before.owner, 'the person keeps control');
  assert.equal(after.view, before.view, 'the view is unchanged');
  assert.equal(after.controlRevision, before.controlRevision);
  assert.equal(after.wakeHumanRevision || 0, before.wakeHumanRevision || 0, 'not counted as human input');
  const message = after.messages.find(m => m.id === tag);
  assert.equal(message.origin, 'naw-dispatch');
  assert.equal(message.name, 'NAW 派活');
  assert.equal(message.dispatchItem, 'item-1');
});

test('a dispatch to one member does not pause a collaboration running between others', async t => {
  const { w, ids } = await fixture(t);
  await w.startRun([ids[1], ids[2]], 'Check 54 + 21', 2, 'replies');
  assert.equal(w.room.run.status, 'running');
  await dispatch(w, ids[0]);
  assert.equal(w.room.run.status, 'running');
  // The same input from the person pauses it: that is the human path, kept as before.
  await w.send(ids[0], 'person types', 'person').catch(() => {});
  assert.equal(w.room.run.status, 'paused');
});

test('the automatic-message switches and the person\'s draft stop a dispatch before anything is sent', async t => {
  const { w, ids, sent } = await fixture(t);
  w.setDraft(ids[0], 'half typed', 'person');
  await assert.rejects(dispatch(w, ids[0]), error => error.uiMessage?.key === 'error.queue.personTyping');
  w.setDraft(ids[0], '', 'person');
  wake.setPolicy(w, ids[0], false);
  await assert.rejects(dispatch(w, ids[0]), error => error.uiMessage?.key === 'error.backgroundMessagesDisabled');
  wake.setPolicy(w, ids[0], true);
  wake.setPolicy(w, null, false);
  await assert.rejects(dispatch(w, ids[0]), error => error.uiMessage?.key === 'error.backgroundMessagesDisabled');
  assert.equal(sent.length, 0);
  wake.setPolicy(w, null, true);
  await dispatch(w, ids[0]);
  assert.equal(sent.length, 1);
});

// eddb1c16 (11-13): on Claude 2.1.322 a background task the dispatched turn starts and finishes notifies during that
// turn, under its prompt id. NAW's own send is accepted and running then; nothing displaced it, so the item settles done.
// A member on the real Claude adapter, sent one queue item that native accepts as prompt 'turn'.
async function dispatchedClaude(t) {
  const { w, ids } = await fixture(t);
  const { Claude } = require('../adapters.cjs');
  const id = ids[0], s = w.get(id), runtime = Object.create(Claude.prototype); EventEmitter.call(runtime);
  runtime.record = s; runtime.ready = true; runtime.chatAvailable = true; runtime.terminal = { input() {} };
  runtime.submission = { request: async () => ({ promptId: 'turn' }) };
  w.runtimes.set(id, runtime); w.bind(s, runtime);
  const pauses = [], pause = w.pause.bind(w); w.pause = (...args) => { pauses.push(args[0]); return pause(...args); };
  const completed = []; runtime.on('complete', info => completed.push(info.tag));
  const hook = event => runtime.hook({ session_id: s.nativeId, prompt_id: 'turn', ...event });
  const control = s.controlRevision, sentAt = Date.now(), text = '【NAW 派活】task';
  const tag = await dispatch(w, id, text);
  // Shapes and order as the 11-12 loopback probe recorded them (real Claude 2.1.322 and 2.1.323).
  hook({ hook_event_name: 'UserPromptSubmit', prompt: text });
  hook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'toolu_1', background_task_id: 'bsynth001' });
  const stop = () => hook({ hook_event_name: 'Stop', last_assistant_message: 'Done: the build passed.', background_tasks: [], session_crons: [], stop_hook_active: false });
  // The queue's own rule, on this member's record, once it is idle.
  const verdict = () => {
    const rules = require('../queue-dispatch.cjs');
    const item = { id: 'item-1', text, status: 'sent', sentTo: id, sentAt, tag, control, createdAt: sentAt - 1000 };
    const member = { ...s, roomIds: ['shared'], roomId: 'shared', serviceCapabilities: [rules.CAPABILITY, 'guardedSessionStopV1'], fleet: [] };
    return rules.planDispatch({ rooms: [{ id: 'shared', name: 'Team', queue: [item] }], sessions: [member], wakePolicy: { enabled: true },
      idleSince: new Map([[id, Date.now() - 60000]]), now: Date.now() }).filter(action => action.kind === 'settle').map(action => [action.status, action.reason, action.reply]);
  };
  return { w, s, runtime, hook, stop, verdict, pauses, completed, control, tag };
}
const taskDone = '<task-notification>\n<task-id>bsynth001</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<status>completed</status>\n<summary>Synthetic task completed</summary>\n</task-notification>';

test('a background task the dispatched turn starts and finishes does not count as the person stepping in', async t => {
  const { s, hook, stop, verdict, pauses, completed, control, tag } = await dispatchedClaude(t);
  hook({ hook_event_name: 'UserPromptSubmit', prompt: taskDone });
  assert.equal(s.messages.at(-1).inputSource, 'task-notification', 'NAW recognises the notification as machine input');
  assert.equal(s.controlRevision, control, 'The control revision stays where the dispatch left it');
  assert.deepEqual(pauses, [], 'Nothing is paused');
  stop();
  assert.deepEqual(completed, [tag], 'The turn end is still the reply to the dispatch');
  assert.equal(s.pendingTag, null);
  assert.deepEqual(verdict(), [['done', undefined, 'Done: the build passed.']]);
});

test('what still counts inside or around the dispatched turn: a person typing there, and input that starts another turn', async t => {
  // A person typing during the dispatched turn: same prompt id on 2.1.316+, and still the person.
  const typed = await dispatchedClaude(t);
  typed.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'please also check the docs' });
  assert.equal(typed.s.controlRevision, typed.control + 1);
  assert.deepEqual(typed.pauses, ['真人在原生终端输入']);
  typed.stop();
  assert.deepEqual(typed.completed, [undefined], 'The reply is no longer bound to the dispatch');
  assert.deepEqual(typed.verdict(), [['waiting', 'person-intervened', 'Done: the build passed.']]);
  // Machine input under another prompt id is not inside the dispatched turn: it displaced the send, as before (528c0271).
  const other = await dispatchedClaude(t);
  other.hook({ hook_event_name: 'UserPromptSubmit', prompt_id: 'other', prompt: taskDone });
  assert.equal(other.s.messages.at(-1).inputSource, 'task-notification');
  assert.equal(other.s.controlRevision, other.control + 1);
  assert.deepEqual(other.pauses, ['原生自动输入抢在交接发送之前开始；请核对后再继续。']);
  assert.equal(other.runtime.pending, null);
});

test('a dispatch cannot be combined with another delivery kind', async t => {
  const { w, ids, sent } = await fixture(t);
  const forward = { roomId: 'shared' };
  await assert.rejects(w.send(ids[0], 'x', 'person', null, forward, null, null, null, null, null, { itemId: 'item-1' }), error => error.uiMessage?.key === 'error.queue.invalid');
  assert.equal(sent.length, 0);
});

test('B2: workspace exposes only ephemeral startup trust metadata and never creates an approval or answers native', async t => {
  const { w, ids, sent } = await fixture(t), id = ids[0], runtime = w.runtimes.get(id);
  const { Terminal } = require('@xterm/headless');
  const screen = new Terminal({ cols: 100, rows: 30, allowProposedApi: true }); t.after(() => screen.dispose());
  runtime.terminal = { alive: true, screen };
  runtime.emit('state', 'starting');
  let changes = 0; w.on('change', () => changes++);
  await new Promise(resolve => screen.write('Is this a project you created or one you trust?\r\n1. Yes, I trust this folder\r\n2. No, exit\r\n', resolve));
  runtime.emit('terminal', { sequence: 1, data: 'synthetic native output' });
  const seen = w.snapshot().sessions.find(s => s.id === id);
  assert.equal(seen.nativeStartupPrompt.kind, 'directory-trust');
  assert.equal(seen.approval, null); assert.equal(seen.nativeApproval, null);
  assert.equal(sent.length, 0); assert.equal(w.get(id).nativeStartupPrompt, undefined, 'screen metadata is not persisted into the session row');
  assert.ok(changes > 0, 'a newly observed startup prompt publishes state for the dispatcher');
  runtime.emit('state', 'idle');
  assert.equal(w.snapshot().sessions.find(s => s.id === id).nativeStartupPrompt, null, 'ready state retires startup classification even if the old screen has not repainted');
});
