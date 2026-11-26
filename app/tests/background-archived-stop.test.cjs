// R231.1: archiving keeps a session's process running, so a stop card for an archived session must reach the person.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { BackgroundControl, dialog } = require('../background-control.cjs');
const { fingerprint } = require('../background-fingerprint.cjs');
const { inboxStatus } = require('../confirmation-inbox.cjs');

const actor = { id: 'butler', nativeId: 'butler-native', provider: 'claude', name: 'Butler' };
const identity = { nativeId: actor.nativeId, sessionId: 'native-session', turnId: 'turn', callId: 'call' };

function scene(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-archived-stop-'));
  fs.chmodSync(dir, 0o700);
  const sessions = [
    { ...actor, state: 'idle', roomIds: [] },
    { id: 'old', nativeId: 'old-native', name: 'Old', provider: 'claude', state: 'idle', roomIds: [], archived: true, pid: 4242 },
  ];
  const state = () => ({ sessions, rooms: [] });
  // The parts of room state and labels that the real fingerprint reads.
  const roomState = { apply: value => value, value: { sessionArchives: {} }, metadata: () => ({ restoreMembers: [], restorePlacements: [] }) };
  const sessionLabels = { apply: metadata => metadata };
  const effects = [];
  const c = {
    background: true, view: { selected: actor.id, draft: '' }, confirmationActors: () => [actor], checkActor: async () => {},
    client: { snapshot: state, close() {} }, win: { destroy() {} },
  };
  const guard = command => fingerprint(command, { state: state(), actor, context: c, roomState, sessionLabels, client: c.client });
  c.fingerprint = guard;
  const control = new BackgroundControl({
    dataDir: dir, context: async () => c,
    handlers: new Map([
      // stop asks its own question, as main's handler does.
      ['stop', async (context, id) => {
        const answer = await dialog(context, 'message', { message: 'End?', buttons: ['Keep session', 'End session'], cancelId: 0 });
        if (answer.response === 1) effects.push('stop:' + id);
      }],
      ['interrupt', async (_context, id) => { effects.push('interrupt:' + id); }],
      ['rename', async (_context, id) => { effects.push('rename:' + id); }],
    ]),
    confirmation: (_actor, args) => args.method === 'stop' ? null : { message: args.method + '?', buttons: ['Cancel', 'Confirm'], cancelId: 0 },
    audit: () => {}, confirmationFingerprint: row => guard(row.command),
  });
  t.after(async () => {
    await control.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const ask = async (id, method, args) => {
    const result = await control.call({ sender: actor, identity, valid: () => true }, { action: 'invoke', operation_id: id, method, arguments: args });
    assert.equal(result.state, 'confirmation-required', method);
  };
  const card = id => control.confirmations({ sessions, rooms: [] }).find(item => item.operationId === id);
  const bell = () => inboxStatus({ count: 0 }, null, control.confirmations({ sessions, rooms: [] })).confirmationCount;
  return { control, sessions, effects, ask, card, bell };
}

test('a stop card for an archived session is in the bell, and confirming it ends that session', async t => {
  const f = scene(t);
  await f.ask('stop-old', 'stop', ['old']);
  const shown = f.card('stop-old');
  assert.deepEqual([shown.state, shown.actionable, shown.reason], ['confirmation-required', true, null]);
  assert.equal(f.bell(), 1);
  assert.equal((await f.control.decide(actor.id, actor.nativeId, 'stop-old', 1)).state, 'complete');
  assert.deepEqual(f.effects, ['stop:old']);
});

test('other actions on an archived session, and a stop whose target was archived after asking, stay out of the bell', async t => {
  const f = scene(t);
  await f.ask('interrupt-old', 'interrupt', ['old']);
  await f.ask('rename-old', 'rename', ['old', 'New name']);
  for (const id of ['interrupt-old', 'rename-old']) {
    const shown = f.card(id);
    assert.deepEqual([shown.state, shown.actionable, shown.reason], ['unverifiable', false, 'temporarily-unavailable'], id);
  }
  assert.equal(f.bell(), 0);
  const old = f.sessions.find(s => s.id === 'old');
  old.archived = false;
  await f.ask('stop-live', 'stop', ['old']);
  assert.equal(f.card('stop-live').actionable, true);
  // Archiving after the person was asked changes what the card was asked against.
  old.archived = true;
  assert.deepEqual([f.card('stop-live').state, f.card('stop-live').actionable], ['unverifiable', false]);
  assert.equal(f.bell(), 0);
  assert.deepEqual(f.effects, []);
});

test('a stop card asked by an archived session stays out of the bell', async t => {
  const f = scene(t);
  await f.ask('stop-old', 'stop', ['old']);
  f.sessions.find(s => s.id === actor.id).archived = true;
  assert.equal(f.card('stop-old').actionable, false);
  assert.equal(f.bell(), 0);
  assert.deepEqual(f.effects, []);
});
