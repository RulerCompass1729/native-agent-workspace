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
