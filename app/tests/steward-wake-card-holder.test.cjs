'use strict';
// R209 for the holder that raised the card only (release 300's integration review, B4): the same workspace session can go
// on as another native session, and a click kept for it across a designation is then an ordinary event. The real intake,
// record, designation, wake and dispatcher, closed and opened again from disk. Synthetic sessions; no model.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { RoomState } = require('../room-state.cjs');
const rules = require('../queue-dispatch.cjs'), { QueueDispatcher, CAPABILITY } = rules;
const { ButlerLedger } = require('../butler-ledger.cjs'), { ButlerIngress } = require('../butler-ingress.cjs');
const { PersonActions } = require('../person-actions.cjs'), { BackgroundControl, dialog } = require('../background-control.cjs');
const { StewardWake } = require('../steward-wake.cjs'), { StewardRole } = require('../steward-role.cjs');

const SEC = 1000, MIN = 60 * SEC, HOUR = 60 * MIN, START = 1_800_000_000_000;
const CAPABILITIES = [CAPABILITY, rules.ROTATION_CAPABILITY, rules.CREATE_SETTINGS_CAPABILITY];
const session = (id, nativeId, extra = {}) => ({ id, name: `Synthetic ${id}`, provider: 'claude', nativeId, model: 'synthetic-model', state: 'idle', roomIds: [], roomId: null, cwd: '/tmp',
  createdAt: START - HOUR, lastActivityAt: START - MIN, background: 0, scheduled: 0, backgroundStale: false, chatAvailable: true, liveDraft: '', serviceCapabilities: [CAPABILITY], fleet: [], messages: [], ...extra });
const done = (from, to) => ({ time: START, event: 'done', spaces: [], old: { ...from, name: from.id }, new: { ...to, name: to.id } });
const as = (id, nativeId) => ({ id, nativeId }), named = ({ id, nativeId }) => ({ sessionId: id, nativeId });

function fixture(t, sessions) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-card-holder-')); fs.chmodSync(dir, 0o700);
  const clock = { now: START + MIN }, sent = [], now = () => clock.now;
  const client = Object.assign(new EventEmitter(), { state: { sessions, rooms: [{ id: 'shared', revision: 0, run: null, messages: [] }], wakePolicy: { enabled: true }, operatorPolicy: { domains: [] }, capabilities: CAPABILITIES },
    close() {}, snapshot: () => structuredClone(client.state), refresh: async () => client.snapshot(), route: () => ({ client, state: { capabilities: CAPABILITIES } }),
    call: async (method, ...args) => {
      if (method === 'initial') return client.snapshot();
      if (method !== 'dispatch') return undefined;
      sent.push({ id: args[0], kind: (args[3] || '').split(':')[0], at: clock.now });
      const s = sessions.find(x => x.id === args[0]); s.state = 'working'; s.lastActivityAt = clock.now;
      return `tag-${sent.length}`;
    } });
  const f = { dir, clock, sent };
  f.open = () => {
    const room = new RoomState(dir), ledger = new ButlerLedger(dir, { now }), ingress = new ButlerIngress(dir, { roomState: room, ledger, now });
    const actions = new PersonActions({ ingress, now });
    f.role = new StewardRole(dir);
    f.control = new BackgroundControl({ dataDir: dir, now, changed: () => actions.observe({}, f.control?.data?.records || []),
      handlers: new Map([['stop', async c => { await dialog(c, 'message', { message: 'Stop?', buttons: ['Cancel', 'Stop'], cancelId: 0 }); return null; }]]),
      context: async (actor, saved) => ({ background: true, view: saved || { selected: actor.id, draft: '' }, confirmationActors: () => [actor], checkActor: async () => {}, client: { close() {} }, win: { destroy() {} } }) });
    actions.observe({}, f.control.data.records);
    f.wake = new StewardWake(dir, { ledger: () => ledger, selected: () => f.role.selected, now, record() {}, changed() {}, askers: (...args) => f.control.askers(...args) });
    f.dispatcher = new QueueDispatcher({ roomState: room, dataDir: dir, connect: async () => client, now, settleMs: 8000, tickMs: 3000,
      steward: () => { const current = f.role.current(); return current && { ...current, duty: '' }; }, stewardWake: f.wake, transcriptRoot: path.join(dir, 'none'),
      sampleProcesses: async () => '', samplePressure: async () => '', compactions: { async sample() { return new Map(); } } });
  };
  f.open();
  t.after(() => { f.dispatcher.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  f.restart = async () => { await f.dispatcher.close(); f.open(); };
  // As main.cjs: `who` asks, the person answers.
  f.card = async (who, decision = 1, operation = 'op-1') => {
    const sender = { ...who, provider: 'claude', name: 'Asker' };
    await f.control.call({ sender, identity: { nativeId: who.nativeId, sessionId: 'native-session', turnId: 'turn', callId: 'call' }, valid: () => true }, { action: 'invoke', operation_id: operation, method: 'stop', arguments: [] });
    await f.control.decide(who.id, who.nativeId, operation, decision);
  };
  f.rotated = (from, to) => fs.appendFileSync(path.join(dir, 'rotation-log.jsonl'), `${JSON.stringify(done(from, to))}\n`, { mode: 0o600 });
  // Designated with the position the wake had reached kept: what is recorded after it is still to be told.
  f.designate = who => { f.role.set(named(who)); f.wake.write({ ...f.wake.state, on: true, designation: named(who), woken: f.position }); };
  f.run = async ms => { const end = clock.now + ms; do { await f.dispatcher.schedule(); clock.now += 3 * SEC; } while (clock.now <= end); };
  f.wakes = () => sent.filter(s => s.kind === 'steward-wake');
  return f;
}
// The butler at work, its card answered meanwhile: kept for the next wake. What happens after `then` follows a restart
// in which the person has just used the butler, which holds an ordinary event for two minutes.
async function kept(t, { asker, then, sessions, decision = 1, card = null, opened = () => {} }) {
  const f = fixture(t, sessions);
  f.role.set(named(asker)); f.wake.set(true); f.position = f.wake.state.woken;
  if (card) await card(f); else await f.card(asker, decision);
  await then(f);
  await f.restart(); opened(f);
  for (const s of sessions) if (s.state === 'working') { s.state = 'idle'; s.lastActivityAt = f.clock.now - MIN; }
  f.sent.length = 0;
  const butler = f.role.current().sessionId, at = f.clock.now;
  f.dispatcher.noteHuman(butler, 'send');
  await f.run(30 * SEC);
  return { f, at, butler };
}
const told = ({ f, at, butler }) => { assert.equal(f.wakes().length, 1, `${f.wakes().length} wakes, held by ${f.wake.view({ held: true }).blocked?.reason}`); assert.equal(f.wakes()[0].id, butler); assert.ok(f.wakes()[0].at - at <= 15 * SEC, `${f.wakes()[0].at - at} ms`); };
async function ordinary({ f, at, butler }) {
  assert.deepEqual(f.wakes(), [], 'not at once'); assert.equal(f.wake.clicked, false); assert.equal(f.wake.due(), true, 'not lost');
  await f.run(3 * MIN);
  assert.equal(f.wakes().length, 1); assert.equal(f.wakes()[0].id, butler); assert.ok(f.wakes()[0].at - at >= 2 * MIN); assert.equal(f.wake.due(), false);
}
const working = { state: 'working' };

test('a click kept for a workspace session that goes on as another native session is an ordinary event, told after the usual checks', async t => {
  for (const decision of [1, 0]) {
    const one = as('butler', 'native-1'), two = as('butler', 'native-2'), sessions = [session('butler', 'native-1', working)];
    await ordinary(await kept(t, { asker: one, decision, sessions, then: f => { sessions[0].nativeId = 'native-2'; f.designate(two); } }));
  }
});

test('its own background command holds that event as it holds any other', async t => {
  const sessions = [session('butler', 'native-1', { ...working, background: 1 })];
  const { f } = await kept(t, { asker: as('butler', 'native-1'), sessions, then: f => { sessions[0].nativeId = 'native-2'; f.designate(as('butler', 'native-2')); } });
  await f.run(5 * MIN); assert.deepEqual(f.wakes(), []); assert.equal(f.wake.due(), true); assert.equal(f.wake.view({ early: true }).blocked?.card, undefined, 'shown as any event is, after ten minutes');
  sessions[0].background = 0; await f.run(MIN); assert.equal(f.wakes().length, 1);
});

test('the holder that raised the card is told at once after a restart, confirmed or cancelled, also when designated again', async t => {
  for (const decision of [1, 0]) for (const then of [() => {}, f => f.designate(as('butler', 'native-1'))])
    told(await kept(t, { asker: as('butler', 'native-1'), decision, sessions: [session('butler', 'native-1', working)], then }));
});

test('its successors through rotations are told at once, the one that changed its native session in between is not', async t => {
  const first = as('first', 'native-first'), second = as('second', 'native-second'), third = as('third', 'native-third');
  const sessions = () => [session('first', 'native-first', working), session('second', 'native-second'), session('third', 'native-third')];
  told(await kept(t, { asker: first, sessions: sessions(), then: f => f.rotated(first, second) }));
  told(await kept(t, { asker: first, sessions: sessions(), then: f => { f.rotated(first, second); f.rotated(second, third); } }));
  // The first session had changed its native session after raising the card, and that one was rotated.
  const cleared = as('first', 'native-cleared');
  await ordinary(await kept(t, { asker: first, sessions: sessions(), then: f => { f.designate(cleared); f.rotated(cleared, second); } }));
  // The successor changed its own, and the person designated it again.
  const again = sessions();
  await ordinary(await kept(t, { asker: first, sessions: again, then: f => { f.rotated(first, second); again[1].nativeId = 'native-again'; f.designate(as('second', 'native-again')); } }));
  // A card of the successor from before that change.
  const later = sessions();
  await ordinary(await kept(t, { asker: first, sessions: later, card: f => f.card(second), then: f => { f.rotated(first, second); later[1].nativeId = 'native-again'; f.designate(as('second', 'native-again')); } }));
});

test('another workspace session that names the same native session is not the holder', async t => {
  await ordinary(await kept(t, { asker: as('butler', 'native-1'), sessions: [session('butler', 'native-1', working), session('other', 'native-1')], card: f => f.card(as('other', 'native-1')), then: () => {} }));
});

test('a record that goes round ends at the holder already listed, and an entry without its native session ends the line', async t => {
  const f = fixture(t, [session('butler', 'native-1')]), one = as('one', 'native-1'), two = as('two', 'native-2'), bare = as('bare');
  f.rotated(one, two); f.rotated(two, one); f.rotated(bare, as('last', 'native-last')); await f.restart();
  const of = who => f.dispatcher.holders(named(who)).map(h => [h.sessionId, h.nativeId]);
  assert.deepEqual(of(one), [['one', 'native-1'], ['two', 'native-2']]); assert.deepEqual(of(as('two', 'native-other')), [['two', 'native-other']]);
  assert.deepEqual(of(as('last', 'native-last')), [['last', 'native-last']]); assert.deepEqual(f.dispatcher.holders(null), []); assert.deepEqual(f.dispatcher.holders({ sessionId: 'one' }), []);
});

test('an operation id both native sessions used, one whose record is gone and one that cannot be read make no click and lose nothing', async t => {
  const one = as('butler', 'native-1'), two = as('butler', 'native-2');
  const both = [session('butler', 'native-1', working)];
  await ordinary(await kept(t, { asker: one, sessions: both, then: async f => { both[0].nativeId = 'native-2'; f.designate(two); await f.card(two); } }));
  for (const askers of [() => [], () => { throw Error('SYNTHETIC'); }])
    await ordinary(await kept(t, { asker: one, sessions: [session('butler', 'native-1', working)], then: () => {}, opened: f => { f.wake.askers = askers; } }));
});

test('background control tells the native session that asked: answered cards only, after a restart and after they moved to the history', async t => {
  const f = fixture(t, [session('butler', 'native-1')]), one = as('butler', 'native-1'), two = as('butler', 'native-2');
  await f.card(one, 1, 'op-yes'); await f.card(one, 0, 'op-no'); await f.card(as('other', 'native-other'), 1, 'op-yes');
  await f.control.call({ sender: { ...one, provider: 'claude', name: 'Asker' }, identity: { nativeId: 'native-1', sessionId: 's', turnId: 't', callId: 'c' }, valid: () => true }, { action: 'invoke', operation_id: 'op-open', method: 'stop', arguments: [] });
  const check = () => {
    assert.deepEqual(['op-yes', 'op-no', 'op-open', 'op-none', undefined].map(id => f.control.askers('butler', id)), [['native-1'], ['native-1'], [], [], []]);
    assert.deepEqual(f.control.askers('other', 'op-yes'), ['native-other']); assert.deepEqual(f.control.askers('nobody', 'op-yes'), []);
  };
  check(); await f.restart(); check();
  f.clock.now += 48 * HOUR; await f.card(two, 1, 'op-later'); await f.card(two, 1, 'op-again');
  assert.ok(f.control.archivedBySession.get('butler')?.some(r => r.id === 'op-yes'), 'moved to the history');
  assert.deepEqual(f.control.askers('butler', 'op-yes'), ['native-1']); await f.restart(); assert.deepEqual(f.control.askers('butler', 'op-yes'), ['native-1']); assert.deepEqual(f.control.askers('butler', 'op-later'), ['native-2']);
});

test('main.cjs gives the wake background control\'s own answer', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.cjs'), 'utf8');
  const wired = main.slice(main.indexOf('stewardWake ||= new StewardWake('), main.indexOf('} catch { stewardWake = null; }'));
  assert.match(wired, /askers: \(sessionId, id\) => backgroundControl\?\.askers\(sessionId, id\) \|\| \[\],/u);
});
