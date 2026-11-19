const test = require('node:test'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createMobileClient, KEY } = require('../mobile-web/client.js');
const deviceA = '10000000-0000-4000-8000-000000000001', deviceB = '10000000-0000-4000-8000-000000000002';
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
function fixture() {
  const disk = new Map(), calls = [];
  let session = { deviceId: deviceA, csrf: 'A'.repeat(43), sessions: [{ id: 'a', actions: ['read', 'send'] }, { id: 'b', actions: ['read', 'send'] }] };
  const held = new Map();
  const client = createMobileClient({ storage: { getItem: key => disk.get(key), setItem: (key, value) => disk.set(key, value) }, newId: randomUUID,
    request: async (route, value) => {
      calls.push({ route, value });
      const result = route === '/mobile/session' ? structuredClone(session) : route === '/mobile/pair' ? {} : route === '/mobile/logout' ? { authorizationRevoked: true } :
        route.startsWith('/mobile/read/') ? { id: route.split('/').at(-1), contextId: 'X'.repeat(43), canSend: true, messages: [] } :
        { requestId: value.requestId, sessionId: 'a', action: 'send', status: 'submitted' };
      const wait = held.get(route); if (wait) await wait.promise;
      return result;
    } });
  return { client, calls, disk, grant: value => { session = value; }, hold: route => { const wait = gate(); held.set(route, wait); return () => { held.delete(route); wait.release(); }; } };
}
test('pairing immediately isolates selected content and draft, without deleting device-scoped drafts', async () => {
  const f = fixture(), c = f.client; await c.start(); await c.select('a'); c.setDraft('Original A draft');
  const release = f.hold('/mobile/pair'), changing = c.start('P'.repeat(43));
  assert.equal(c.state.session, null); assert.equal(c.state.selected, null); assert.equal(c.state.row, null); assert.equal(c.state.draft, '');
  await assert.rejects(c.send());
  const reads = f.calls.filter(r => r.route === '/mobile/session').length; await c.start();
  assert.equal(f.calls.filter(r => r.route === '/mobile/session').length, reads, 'refresh cannot reinstall the old grant during pairing');
  f.grant({ deviceId: deviceB, csrf: 'B'.repeat(43), sessions: [{ id: 'b' }] }); release(); await changing;
  await assert.rejects(c.select('a')); await c.select('b'); assert.equal(c.state.draft, '');
  assert.equal(JSON.parse(f.disk.get(KEY)).drafts[0].text, 'Original A draft');
  f.grant({ deviceId: deviceA, csrf: 'C'.repeat(43), sessions: [{ id: 'a' }] }); await c.start('Q'.repeat(43)); await c.select('a');
  assert.equal(c.state.draft, 'Original A draft'); assert.equal(f.calls.filter(r => r.route === '/mobile/send').length, 0);
});
test('old reads cannot install content after a new pairing, including the same device ID', async () => {
  const f = fixture(), c = f.client; await c.start();
  const release = f.hold('/mobile/read/a'), reading = c.select('a');
  f.grant({ deviceId: deviceA, csrf: 'B'.repeat(43), sessions: [{ id: 'b' }] }); await c.start('P'.repeat(43));
  release(); await reading; assert.equal(c.state.row, null); assert.equal(c.state.selected, null); await assert.rejects(c.select('a'));
});
test('an older session response cannot restore the previous grant', async () => {
  const f = fixture(), c = f.client; await c.start(); await c.select('a');
  const release = f.hold('/mobile/session'), reading = c.start();
  f.grant({ deviceId: deviceB, csrf: 'B'.repeat(43), sessions: [{ id: 'b' }] });
  // Release just the old snapshot; the new start must capture the new grant.
  release(); const changing = c.start('P'.repeat(43)); await Promise.all([reading, changing]);
  assert.equal(c.state.session.deviceId, deviceB); assert.deepEqual(c.state.session.sessions.map(s => s.id), ['b']); assert.equal(c.state.row, null);
});
test('ordinary grant refresh invalidates a narrowed scope', async () => {
  const f = fixture(), c = f.client; await c.start(); await c.select('a'); c.setDraft('Retained');
  const before = c.state.authorization;
  f.grant({ deviceId: deviceA, csrf: 'A'.repeat(43), sessions: [{ id: 'b', actions: ['read'] }] }); await c.start();
  assert.ok(c.state.authorization > before); assert.equal(c.state.selected, null); assert.equal(c.state.row, null); assert.equal(c.state.draft, '');
  await assert.rejects(c.send()); assert.equal(JSON.parse(f.disk.get(KEY)).drafts[0].text, 'Retained');
});
test('a late send receipt is retained without clearing a new authorization draft or resending', async () => {
  const f = fixture(), c = f.client; await c.start(); await c.select('a'); c.setDraft('Original');
  const release = f.hold('/mobile/send'), sending = c.send();
  f.grant({ deviceId: deviceA, csrf: 'B'.repeat(43), sessions: [{ id: 'a' }] }); await c.start('P'.repeat(43)); await c.select('a');
  const revision = c.state.revision; release(); await sending;
  assert.equal(c.state.draft, 'Original'); assert.equal(c.state.revision, revision); assert.equal(c.state.pending[0].status, 'submitted');
  assert.equal(f.calls.filter(r => r.route === '/mobile/send').length, 1);
});
test('a stale logout completion cannot remove a newer device authorization', async () => {
  const f = fixture(), c = f.client; await c.start(); const release = f.hold('/mobile/logout'), leaving = c.logout();
  f.grant({ deviceId: deviceB, csrf: 'B'.repeat(43), sessions: [{ id: 'b' }] }); await c.start('P'.repeat(43)); await c.select('b'); c.setDraft('B draft');
  release(); await leaving; assert.equal(c.state.session.deviceId, deviceB); assert.equal(c.state.selected, 'b'); assert.equal(c.state.draft, 'B draft');
});
test('unavailable targets and changed approval grants invalidate the cached reading context', async () => {
  for (const change of [{ available: false }, { available: true, consent: { registered: true, enabled: false } }]) {
    const f = fixture(), c = f.client; await c.start(); await c.select('a');
    const before = c.state.authorization;
    f.grant({ deviceId: deviceA, csrf: 'A'.repeat(43), consent: change.consent, sessions: [{ id: 'a', actions: ['read', 'send'], available: change.available }] });
    await c.start(); assert.ok(c.state.authorization > before); assert.equal(c.state.selected, null); assert.equal(c.state.row, null);
    if (!change.available) await assert.rejects(c.select('a'));
  }
});
test('authorization rejection invalidates pending reads without discarding scoped drafts', async () => {
  const f = fixture(), c = f.client; await c.start(); await c.select('a'); c.setDraft('Retained after rejection');
  const release = f.hold('/mobile/read/a'), reading = c.refresh(); c.invalidate();
  assert.equal(c.state.session, null); assert.equal(c.state.selected, null); assert.equal(c.state.row, null); assert.equal(c.state.draft, '');
  release(); await reading; assert.equal(c.state.row, null); await assert.rejects(c.send());
  await c.start(); await c.select('a'); assert.equal(c.state.draft, 'Retained after rejection');
});
