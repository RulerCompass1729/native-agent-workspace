const test = require('node:test'), assert = require('node:assert/strict');
const { Terminal } = require('@xterm/headless');
const { Claude } = require('../adapters.cjs');
const { Workspace } = require('../workspace.cjs');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const MODAL = 'Teach auto mode about your environment?\r\n❯ 1. Yes\r\n  2. Not now\r\nEnter to confirm · Esc to cancel';
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-local-approval-'));
  const screen = new Terminal({ cols: 100, rows: 30, allowProposedApi: true });
  let runtime, sent = 0; const states = [];
  const w = new Workspace({ binaries: {}, close() {}, create(record) {
    runtime = new Claude(record, {}, { attachOnly: true });
    runtime.terminal = { alive: true, screen }; runtime.ready = true; runtime.chatAvailable = true;
    runtime.bindRoot({ sessionId: record.nativeId, nativeBlocks: true });
    runtime.on('state', state => states.push(state));
    runtime.start = async () => runtime.emit('state', 'idle');
    runtime.send = async (_text, tag, guard) => { assert.ok(guard()); sent++; return tag; };
    runtime.close = () => {};
    return runtime;
  } }, dir);
  const id = await w.create('claude', dir, 'person', 'Synthetic member');
  t.after(() => { w.close(); screen.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
  const paint = async text => {
    await new Promise(resolve => screen.write('\x1b[2J\x1b[H' + text, resolve));
    runtime.emit('terminal', { sequence: 1 });
  };
  const hook = (kind = 'Notification', type = 'permission_prompt') => runtime.hook({
    session_id: runtime.record.nativeId, hook_event_name: kind, notification_type: type,
  });
  return { w, id, runtime, paint, hook, states, state: () => w.sessions.get(id).state,
    send: () => w.send(id, 'Synthetic queued task', 'naw-dispatcher', null, null, null, null, null, null, null, { itemId: 'synthetic-item' }),
    sent: () => sent };
}
for (const [kind, type] of [['PermissionRequest', ''], ['Notification', 'permission_prompt'], ['Notification', 'elicitation_dialog'], ['Notification', 'auth_success']]) {
  test(`a local ${kind}/${type} cannot strand dispatch after the empty native editor returns without Stop`, async t => {
    const f = await fixture(t); await f.paint(MODAL); f.hook(kind, type);
    assert.equal(f.state(), 'approval');
    await f.paint('Saved local settings.\r\n❯ ');
    assert.equal(f.runtime.turnId, null);
    assert.equal(f.state(), 'idle', 'a completed local command has no turn Stop to clear approval');
    await f.send(); assert.equal(f.sent(), 1, 'normal queued dispatch can use the recovered member');
  });
}
test('a local permission notification arriving after the editor returned is not sticky either', async t => {
  const f = await fixture(t); await f.paint('❯ '); f.hook();
  assert.equal(f.state(), 'idle');
  assert.ok(!f.states.includes('approval'), 'a late notification must not pause collaboration as a side effect');
});
for (const held of ['dialog', 'turn', 'native-permission', 'native-input', 'unreadable', 'output-only', 'draft', 'ending', 'unobserved-turns', 'observation-gap', 'new-observer', 'unidentified-work']) {
  test(`local approval recovery keeps ${held} blocked`, async t => {
    const f = await fixture(t); await f.paint(MODAL);
    if (held === 'turn') f.runtime.liveTurn = { id: 'native-turn', promptId: 'native-prompt' };
    if (held === 'unobserved-turns') f.runtime.nativeBlocks = false;
    if (held === 'unidentified-work') f.runtime.emit('state', 'working');
    f.hook();
    if (held === 'native-permission') f.runtime.livePermissions.set('permission:held', { id: 'permission:held' });
    if (held === 'native-input') f.runtime.nativeInputRequired = true;
    if (held === 'ending') f.runtime.rootEnding = { reason: 'exit' };
    if (held === 'observation-gap') f.runtime.displayGap = true;
    if (held === 'new-observer') f.runtime.observationEpoch = 'replacement-observer';
    if (held === 'unreadable') f.runtime.terminal.screen = null;
    await f.paint(held === 'dialog' ? MODAL : held === 'output-only' ? 'Still running a local command' : held === 'draft' ? '❯ human draft' : '❯ ');
    assert.equal(f.state(), 'approval');
    await assert.rejects(f.send()); assert.equal(f.sent(), 0);
  });
}
test('a new prompt before the local dialog closes cannot be turned idle by the old notification', async t => {
  const f = await fixture(t); await f.paint(MODAL); f.hook();
  f.runtime.hook({ session_id: f.runtime.record.nativeId, hook_event_name: 'UserPromptSubmit', prompt_id: 'new-prompt', prompt: 'Synthetic new task' });
  await f.paint('❯ ');
  assert.equal(f.state(), 'working');
});
