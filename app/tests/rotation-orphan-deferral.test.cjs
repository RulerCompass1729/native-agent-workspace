'use strict';
// R129 (the person, 2026-11-23: 「"没被叫醒"是个 bug,需要修」): a deferral for the person under code before alpha.284
// dropped its record and left the backend episode invalid; the butler stayed held from 11-19 through every restart.
// NAW ends exactly that episode the way deferRotation ends one now; any other invalid episode stays the person's.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { ButlerLedger } = require('../butler-ledger.cjs'), { ButlerIngress } = require('../butler-ingress.cjs'), { RoomState } = require('../room-state.cjs');
const { StewardWake } = require('../steward-wake.cjs'), { QueueDispatcher, CAPABILITY } = require('../queue-dispatch.cjs'), { PersonActions } = require('../person-actions.cjs');
const NOW = 1800000000000, identity = { sessionId: 'butler', nativeId: 'native-butler' };
const EPOCH = 'epoch-a', TAG = 'tag-a', ASKED = NOW - 4 * 86400000;

function request(extra = {}) {
  return { id: TAG, role: 'user', text: 'synthetic', time: ASKED, status: 'submitted', origin: 'naw-dispatch', dispatchItem: 'rotation:butler',
    dispatchPurpose: { kind: 'rotation-request', nativeId: 'native-butler', itemId: 'rotation:butler', epoch: EPOCH }, ...extra };
}
function butler({ message = request(), episode = {} } = {}) {
  return { id: 'butler', nativeId: 'native-butler', provider: 'claude', model: 'claude-test-model', state: 'idle', roomIds: [], serviceCapabilities: [CAPABILITY],
    chatAvailable: true, background: 0, scheduled: 0, messages: message ? [message] : [], fleet: [], liveDraft: '', createdAt: NOW - 30 * 86400000,
    rotationEpisode: { nativeId: 'native-butler', epoch: EPOCH, state: 'invalid', tag: TAG, itemId: 'rotation:butler', ...episode } };
}
const entry = (time, event, extra = {}) => ({ time, event, spaces: [], old: { id: 'butler', nativeId: 'native-butler', name: 'Synthetic butler' }, new: null, ...extra });
const deferred = [entry(ASKED + 150, 'requested', { reason: 'compact' }), entry(ASKED + 100000, 'waiting', { reason: 'person-active' })];

function fixture(t, sessions, { log = deferred, runtimeVersion, refuse = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-b-orphan-deferral-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'rotation-log.jsonl'), log.map(e => JSON.stringify(e) + '\n').join(''));
  const clock = { now: NOW }, room = new RoomState(dir), ledger = new ButlerLedger(dir, { now: () => clock.now });
  const ingress = new ButlerIngress(dir, { roomState: room, ledger, now: () => clock.now }), actions = new PersonActions({ ingress, now: () => clock.now });
  const calls = [], backend = { runtimeVersion };
  const client = Object.assign(new EventEmitter(), {
    close() {}, refresh: async () => {},
    snapshot: () => ({ sessions, rooms: [], wakePolicy: { enabled: true }, operatorPolicy: { domains: [] } }),
    route: () => ({ client, state: { capabilities: [CAPABILITY], ...(backend.runtimeVersion ? { runtimeVersion: backend.runtimeVersion } : {}) } }),
    call: async (method, ...args) => {
      calls.push([method, ...args]);
      if (method === 'dispatch') { sessions.find(s => s.id === args[0]).state = 'working'; return 'receipt-tag'; }
      if (method === 'initial') return client.snapshot();
      if (method === 'invalidateRotation') {
        // As workspace.cjs invalidateRotation's deferred branch (a73629ca).
        const [id, nativeId, epoch, why] = args, s = sessions.find(x => x.id === id), ep = s?.rotationEpisode;
        if (refuse || !ep || s.nativeId !== nativeId || ep.epoch !== epoch || why?.tag !== ep.tag || why.reason !== 'person-active' ||
            !['invalid', 'complete'].includes(ep.state)) throw Error('error.workspace.rotationUnconfirmed');
        s.rotationEpisode = { ...ep, state: 'released', disposition: { action: 'release', outcome: 'failed', reason: 'person-active', actor: { kind: 'naw', id: 'rotation-dispatcher' } } };
        return { epoch, tag: ep.tag, state: 'released' };
      }
      throw Error(method);
    },
  });
  const wake = new StewardWake(dir, { ledger: () => ledger, selected: () => identity, now: () => clock.now, record() {}, changed() {} });
  wake.set(true);
  const d = new QueueDispatcher({ roomState: room, dataDir: dir, connect: async () => client, steward: () => identity, stewardWake: wake, now: () => clock.now,
    settleMs: 8000, tickMs: 3600000, observePersonActions: s => actions.observe(s, []), transcriptRoot: path.join(dir, 'none') });
  // A message for the butler waits meanwhile.
  actions.call('operatorAction', ['member', 'grant', {}], 'synthetic-domain');
  const invalidations = () => calls.filter(c => c[0] === 'invalidateRotation').map(c => c.slice(1));
  const dispatches = () => calls.filter(c => c[0] === 'dispatch').map(c => c[1]);
  const logged = () => fs.readFileSync(path.join(dir, 'rotation-log.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const pass = async (ms = 9000) => { await d.schedule(); clock.now += ms; await d.schedule(); };
  return { clock, wake, d, backend, invalidations, dispatches, logged, pass };
}

test('the orphaned deferral on a current backend is ended as NAW logged it, and the butler is woken', async t => {
  const s = butler(), f = fixture(t, [s]);
  await f.pass();
  assert.deepEqual(f.invalidations(), [['butler', 'native-butler', EPOCH, { tag: TAG, reason: 'person-active' }]]);
  assert.equal(s.rotationEpisode.state, 'released');
  assert.deepEqual(s.rotationEpisode.disposition.actor, { kind: 'naw', id: 'rotation-dispatcher' }, 'NAW ends its own deferral, not as the person');
  const last = f.logged().at(-1);
  assert.equal(last.event, 'waiting'); assert.equal(last.reason, 'person-active'); assert.equal(last.finished, true);
  assert.equal(f.wake.view().blocked, undefined);
  f.clock.now += 60000; await f.pass();
  assert.deepEqual(f.dispatches(), ['butler']);
  assert.equal(f.invalidations().length, 1);
});

test('on a backend before alpha.284 nothing is called and the person is told to update; once updated NAW ends it', async t => {
  const s = butler(), f = fixture(t, [s], { runtimeVersion: '0.1.0-alpha.270' });
  await f.pass();
  assert.deepEqual(f.invalidations(), []);
  assert.equal(f.wake.view().blocked.step, 'update-backend');
  assert.deepEqual(f.dispatches(), []);
  f.backend.runtimeVersion = '0.1.0-alpha.288';
  f.clock.now += 60000; await f.pass();
  assert.equal(f.invalidations().length, 1);
  assert.equal(s.rotationEpisode.state, 'released');
  f.clock.now += 60000; await f.pass();
  assert.deepEqual(f.dispatches(), ['butler']);
});

test('any other invalid episode stays the person\'s: nothing is called and the step is still shown', async t => {
  const cases = {
    'failed after the request': { log: [deferred[0], entry(ASKED + 100000, 'failed', { reason: 'native-error' })] },
    'requested, no deferral': { log: [deferred[0]] },
    'nothing logged': { log: [] },
    'a later request not deferred': { log: [...deferred, entry(ASKED + 200000, 'requested', { reason: 'compact' })] },
    'another native session\'s log': { log: deferred.map(e => ({ ...e, old: { ...e.old, nativeId: 'native-before' } })) },
    'logged before this request': { log: deferred.map(e => ({ ...e, time: ASKED - 1000 })) },
    'no request input': { session: butler({ message: null }) },
    'input not a rotation request': { session: butler({ message: request({ dispatchPurpose: { kind: 'queue', nativeId: 'native-butler', itemId: 'rotation:butler', epoch: EPOCH } }) }) },
    'input for another epoch': { session: butler({ message: request({ dispatchPurpose: { kind: 'rotation-request', nativeId: 'native-butler', itemId: 'rotation:butler', epoch: 'epoch-b' } }) }) },
    'input for another item': { session: butler({ message: request({ dispatchItem: 'rotation:someone' }) }) },
    'episode of an earlier native session': { session: butler({ episode: { nativeId: 'native-before' } }) },
  };
  for (const [name, { log = deferred, session = butler() }] of Object.entries(cases)) {
    const f = fixture(t, [session], { log });
    await f.pass();
    assert.deepEqual(f.invalidations(), [], name);
    assert.equal(session.rotationEpisode.state, 'invalid', name);
    // An earlier native session's episode never held the butler (steward-own-handoff.test.cjs).
    if (session.rotationEpisode.nativeId !== 'native-butler') continue;
    assert.deepEqual(f.dispatches(), [], name);
    assert.equal(f.wake.view().blocked.step, 'release', name);
  }
});

test('a refused ending is tried once per backend version, and the hold and its step stay', async t => {
  const s = butler(), f = fixture(t, [s], { refuse: true });
  for (let i = 0; i < 4; i++) { f.clock.now += 60000; await f.pass(); }
  assert.equal(f.invalidations().length, 1);
  assert.equal(f.wake.view().blocked.step, 'release');
  assert.deepEqual(f.dispatches(), []);
  f.backend.runtimeVersion = '0.1.0-alpha.289';
  f.clock.now += 60000; await f.pass();
  assert.equal(f.invalidations().length, 2);
});
