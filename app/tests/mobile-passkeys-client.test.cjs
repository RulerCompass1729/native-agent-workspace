const test = require('node:test'), assert = require('node:assert/strict');
const { create, KEY } = require('../mobile-web/passkeys.js');
test('lost approval response persists only the original receipt and reload never resends the decision', async () => {
  const disk = new Map(), calls = [], session = { deviceId: 'device', csrf: 'NOT_STORED' }, card = { id: 'session:card', version: 'version' };
  const storage = { getItem: k => disk.get(k), setItem: (k, v) => disk.set(k, v) };
  const credential = { toJSON: () => ({ assertion: 'NOT_STORED_SIGNATURE' }) }, credentials = { get: async () => credential };
  const request = async (route, value) => {
    calls.push(route);
    if (route.endsWith('/options')) return { challengeId: 'challenge', publicKey: { challenge: 'YQ', rpId: 'phone.example.test' } };
    if (route.endsWith('/decide')) { assert.match(disk.get(KEY), /challenge/); throw Error('Lost response'); }
    assert.deepEqual(value, { challengeId: 'challenge' }); return { challengeId: 'challenge', status: 'complete' };
  };
  const client = create({ storage, request, credentials }); await assert.rejects(client.decide(session, card, 'approve'));
  assert.equal(disk.get(KEY).includes('NOT_STORED'), false);
  const reloaded = create({ storage, request, credentials }); await assert.rejects(reloaded.decide(session, card, 'approve'));
  assert.deepEqual(calls, ['/mobile/consent/options', '/mobile/consent/decide']);
  await reloaded.receipt(session, reloaded.pending[0]); assert.equal(calls.at(-1), '/mobile/consent/receipt');
});
test('a failed receipt save prevents the approval POST', async () => {
  const calls = [];
  const client = create({ storage: { getItem: () => null, setItem: () => { throw Error('Full'); } }, credentials: { get: async () => ({ toJSON: () => ({}) }) },
    request: async route => { calls.push(route); return { challengeId: 'id', publicKey: { challenge: 'YQ', rpId: 'phone.example.test' } }; } });
  await assert.rejects(client.decide({ deviceId: 'device', csrf: 'csrf' }, { id: 'card', version: 'v' }, 'approve'));
  assert.deepEqual(calls, ['/mobile/consent/options']);
});
test('receipt capacity reclaims only known outcomes and preserves uncertain cards', async () => {
  const uncertain = { deviceId: 'device', challengeId: 'uncertain', id: 'unknown-card', status: 'unconfirmed' }, disk = new Map([[KEY, JSON.stringify([uncertain, ...Array.from({ length: 63 }, (_, i) => ({ deviceId: 'device', challengeId: 'old-' + i, id: 'old-' + i, status: 'complete' }))])]]);
  const client = create({ storage: { getItem: k => disk.get(k), setItem: (k, v) => disk.set(k, v) }, credentials: { get: async () => ({ toJSON: () => ({}) }) },
    request: async route => route.endsWith('/options') ? { challengeId: 'fresh', publicKey: { challenge: 'YQ', rpId: 'phone.example.test' } } : { challengeId: 'fresh', status: 'complete' } });
  await client.decide({ deviceId: 'device', csrf: 'csrf' }, { id: 'new-card', version: 'v' }, 'approve');
  assert.deepEqual(client.pending.map(p => p.challengeId), ['uncertain', 'fresh']);
  await assert.rejects(client.decide({ deviceId: 'device' }, { id: 'unknown-card', version: 'v' }, 'approve'));
});

test('decision capacity refusal after verification settles only the new no-op', async () => {
  const disk = new Map();
  const client = create({ storage: { getItem: k => disk.get(k), setItem: (k, v) => disk.set(k, v) },
    credentials: { get: async () => ({ toJSON: () => ({}) }) },
    request: async route => {
      if (route.endsWith('/options')) return { challengeId: 'fresh', publicKey: { challenge: 'YQ', rpId: 'phone.example.test' } };
      throw Object.assign(Error('full'), { code: 'MOBILE_PAIR_LIMIT' });
    } });
  await assert.rejects(client.decide({ deviceId: 'device', csrf: 'csrf' }, { id: 'card', version: 'v' }, 'deny'), { code: 'MOBILE_PAIR_LIMIT' });
  assert.equal(JSON.parse(disk.get(KEY))[0].status, 'not-sent');
});
