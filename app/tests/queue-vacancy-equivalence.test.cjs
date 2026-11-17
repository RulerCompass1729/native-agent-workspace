const test = require('node:test');
const assert = require('node:assert/strict');
const { QueueDispatcher, sessionReady, CAPABILITY } = require('../queue-dispatch.cjs');
const { roomIds } = require('../collaboration-spaces.cjs');

// Frozen pre-optimization reference. Compare state transitions, including failures,
// against the production method; no constructor, timers or real session controls.
function previousObserve(snapshot, now) {
  if (!Array.isArray(snapshot?.sessions)) {
    this.vacancySince.clear(); this.vacancyIdentity.clear(); return;
  }
  const observed = new Set();
  for (const session of snapshot.sessions) {
    if (!session || typeof session.id !== 'string') continue;
    observed.add(session.id);
    let identity;
    try {
      if (this.roomState.value.archivedSessions?.includes(session.id) ||
          !sessionReady(session, snapshot.wakePolicy).ready || humanRecent(session.id, this.humanAt, now, this.humanQuietMs)) throw Error('not-ready');
      identity = JSON.stringify([session.nativeId, session.provider, session.connectionRevision || 0,
        session.controlRevision || 0, roomIds(session).sort()]);
    } catch { this.vacancySince.delete(session.id); this.vacancyIdentity.delete(session.id); continue; }
    if (this.vacancyIdentity.get(session.id) !== identity) {
      this.vacancyIdentity.set(session.id, identity); this.vacancySince.set(session.id, now);
    }
  }
  for (const id of this.vacancySince.keys()) if (!observed.has(id)) {
    this.vacancySince.delete(id); this.vacancyIdentity.delete(id);
  }
}
function humanRecent(id, map, now, quiet) {
  const at = map.get(id);
  return Number.isFinite(at) && now - at < quiet;
}
function member(id = 'a', extra = {}) {
  return { id, nativeId: `native-${id}`, provider: 'claude', state: 'idle',
    serviceCapabilities: [CAPABILITY], roomId: 'shared', roomIds: ['shared'],
    background: 0, scheduled: 0, fleet: [], ...extra };
}
function context() {
  return { roomState: { value: { archivedSessions: [] } }, humanAt: new Map(), humanQuietMs: 100,
    vacancySince: new Map(), vacancyIdentity: new Map() };
}
function pair() { return [context(), context()]; }
function compare(contexts, makeSnapshot, now) {
  previousObserve.call(contexts[0], makeSnapshot(0), now);
  QueueDispatcher.prototype.observeVacancyReadiness.call(contexts[1], makeSnapshot(1), now);
  assert.deepEqual([...contexts[1].vacancySince], [...contexts[0].vacancySince]);
  assert.deepEqual([...contexts[1].vacancyIdentity], [...contexts[0].vacancyIdentity]);
}
function seed(contexts) { compare(contexts, () => ({ sessions: [member()], wakePolicy: { enabled: true } }), 1000); }

for (const cause of ['archived', 'not-ready', 'recent-person']) {
  test(`normal ${cause} clears both vacancy maps exactly as before and continues`, () => {
    const contexts = pair(); seed(contexts);
    if (cause === 'archived') for (const c of contexts) c.roomState.value.archivedSessions = ['a'];
    if (cause === 'recent-person') for (const c of contexts) c.humanAt.set('a', 1099);
    compare(contexts, () => ({ sessions: [member('a', cause === 'not-ready' ? { state: 'working' } : {}), member('b')], wakePolicy: { enabled: true } }), 1100);
    assert.deepEqual([...contexts[1].vacancySince], [['b', 1100]]);
    assert.deepEqual([...contexts[1].vacancyIdentity.keys()], ['b']);
  });
}

test('ready identity changes reset since, unchanged identity and quiet boundary keep it', () => {
  const contexts = pair(); seed(contexts);
  const changes = [{}, { nativeId: 'replacement' }, { nativeId: 'replacement' },
    { connectionRevision: 1 }, { controlRevision: 2 }, { provider: 'codex' },
    { roomId: null, roomIds: ['11111111-1111-4111-8111-111111111111'] }];
  let prior, since = 1000;
  for (let i = 0; i < changes.length; i++) {
    const record = member('a', changes[i]), now = 1100 + i;
    compare(contexts, () => ({ sessions: [record], wakePolicy: { enabled: true } }), now);
    const key = contexts[1].vacancyIdentity.get('a');
    if (i === 0) prior = key;
    if (key !== prior) since = now;
    assert.equal(contexts[1].vacancySince.get('a'), since); prior = key;
  }
  for (const c of contexts) c.humanAt.set('a', 2000);
  compare(contexts, () => ({ sessions: [member()], wakePolicy: { enabled: true } }), 2099);
  assert.equal(contexts[1].vacancySince.has('a'), false);
  compare(contexts, () => ({ sessions: [member()], wakePolicy: { enabled: true } }), 2100);
  assert.equal(contexts[1].vacancySince.get('a'), 2100);
});

test('a disappeared session is removed from both maps', () => {
  const contexts = pair(); seed(contexts);
  compare(contexts, () => ({ sessions: [member('b'), null, { id: 4 }], wakePolicy: { enabled: true } }), 1100);
  assert.deepEqual([...contexts[1].vacancySince], [['b', 1100]]);
  assert.deepEqual([...contexts[1].vacancyIdentity.keys()], ['b']);
});

test('missing or invalid session lists clear both maps', () => {
  const contexts = pair();
  for (const snapshot of [undefined, {}, { sessions: null }, { sessions: {} }]) {
    seed(contexts); compare(contexts, () => snapshot, 1100);
    assert.equal(contexts[1].vacancySince.size, 0); assert.equal(contexts[1].vacancyIdentity.size, 0);
  }
});

for (const failure of ['sessionReady', 'humanRecent', 'roomIds', 'JSON.stringify']) {
  test(`a real ${failure} exception still fails closed and the next session is observed`, () => {
    const contexts = pair(); seed(contexts); const hits = [0, 0];
    compare(contexts, index => {
      const record = member();
      const throws = () => { hits[index]++; throw Error(`Synthetic ${failure} failure`); };
      if (failure === 'sessionReady') Object.defineProperty(record, 'state', { get: throws });
      if (failure === 'humanRecent') contexts[index].humanAt = { get(id) { if (id === 'a') return throws(); } };
      if (failure === 'roomIds') Object.defineProperty(record, 'roomIds', { get: throws });
      if (failure === 'JSON.stringify') record.nativeId = { toJSON: throws };
      return { sessions: [record, member('b')], wakePolicy: { enabled: true } };
    }, 1100);
    assert.deepEqual(hits, [1, 1], 'both implementations must reach the intended failing subcall');
    assert.deepEqual([...contexts[1].vacancySince], [['b', 1100]]);
    assert.deepEqual([...contexts[1].vacancyIdentity.keys()], ['b']);
  });
}
