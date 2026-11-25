'use strict';
// Connecting to every backend, and looking for the one that holds a recipient: a few backends at a time instead of one
// after the other (24 of them answering slowly took longer than Claude Code waits). What each result means is unchanged.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), net = require('node:net'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { connect } = require('../service-client.cjs');
const { PeerRunner } = require('../peer-handoffs.cjs');
// NAW_CONNECT_DELAY=1000 repeats the timed cases with backends that take a second each.
const DELAY = Number(process.env.NAW_CONNECT_DELAY) || 100, AT_ONCE = 4;
const key = n => 'backends/' + String(n).padStart(20, '0');

// Real sockets speaking the service's protocol, each answering `initial` after `delay`.
async function backends(t, count, { delay = DELAY, state = () => ({}), answer = {}, down = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-ct-')), seen = { open: 0, accepted: 0, asked: 0, most: 0, waiting: 0, owners: [] }, servers = [], sockets = new Set();
  fs.mkdirSync(path.join(root, 'backends'), { mode: 0o700 });
  const entries = Array.from({ length: count }, (_, n) => key(n));
  for (const [n, name] of entries.entries()) {
    const directory = path.join(root, name), endpoint = path.join(root, 's' + n);
    fs.mkdirSync(directory, { mode: 0o700 });
    fs.writeFileSync(path.join(directory, 'connection.json'), JSON.stringify({ protocol: 1, endpoint, token: 'synthetic' }), { mode: 0o600 });
    if (down.includes(n)) continue;
    const server = net.createServer(socket => {
      let buffer = '', ready = false;
      seen.open++; seen.accepted++; sockets.add(socket);
      socket.on('error', () => {}); socket.on('close', () => { seen.open--; sockets.delete(socket); });
      socket.on('data', chunk => {
        buffer += chunk;
        for (let end; (end = buffer.indexOf('\n')) >= 0;) {
          const r = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
          if (!ready) { ready = true; seen.owners.push(r.owner); socket.write('{"ready":true}\n'); continue; }
          seen.asked++; seen.most = Math.max(seen.most, ++seen.waiting);
          setTimeout(() => {
            seen.waiting--;
            if (answer[n]) return answer[n](socket, r);
            socket.write(JSON.stringify({ id: r.id, ok: true, value: { capabilities: ['agentWakeV1'], sessions: [], rooms: [], room: { id: 'shared', messages: [] }, ...state(n) } }) + '\n');
          }, delay);
        }
      });
    });
    await new Promise(resolve => server.listen(endpoint, resolve)); servers.push(server);
  }
  fs.writeFileSync(path.join(root, 'services.json'), JSON.stringify({ format: 1, active: entries[count - 1], entries }), { mode: 0o600 });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, entries, seen };
}
const until = async (check, text) => { for (let n = 0; n < 200; n++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail(text); };
const session = (id, extra = {}) => ({ id, nativeId: 'native-' + id, provider: 'claude', messages: [], roomIds: [], ...extra });
const runner = (root, connectOne) => new PeerRunner(Object.assign(new EventEmitter(), { room: { id: 'shared', run: null }, spaces: { rooms: [] } }), root, connectOne);
const failsWith = uiKey => error => { assert.equal(error.uiMessage?.key, uiKey); return true; };
// The bound: rounds of AT_ONCE, plus what a busy machine adds; well under one after the other.
const bound = count => Math.ceil(count / AT_ONCE) * DELAY + Math.max(1000, DELAY), serial = count => count * DELAY;
const COUNT = DELAY >= 1000 ? 24 : 64;

test('connect: backends answer a few at a time, the entries stay in layout order and the active one is the active one', async t => {
  const f = await backends(t, COUNT, { state: n => ({ sessions: [session('s' + n)] }) }), started = Date.now();
  const client = await connect(f.root, 'person', { page: false }), took = Date.now() - started;
  t.diagnostic(`${COUNT} backends, ${DELAY} ms each: ${took} ms`);
  assert.ok(took < bound(COUNT) && took < serial(COUNT), `${took} ms`);
  assert.equal(f.seen.most, AT_ONCE, 'never more at once');
  assert.deepEqual(client.entries.map(entry => entry.key), f.entries);
  assert.deepEqual(client.entries.map(entry => entry.state.sessions[0].id), f.entries.map((_, n) => 's' + n));
  assert.equal(client.active.key, f.entries.at(-1)); assert.equal(f.seen.asked, COUNT, 'each is asked once');
  assert.ok(f.seen.owners.every(owner => owner === 'person'));
  client.close(); await until(() => f.seen.open === 0, 'closing the client closes every connection');
});

test('connect: one backend that is not there fails the whole, as before, and leaves nothing connected', async t => {
  for (const down of [0, 5, 23]) {
    const f = await backends(t, 24, { delay: 20, down: [down] });
    await assert.rejects(connect(f.root, 'person'), failsWith('error.serviceConnect'));
    const accepted = f.seen.accepted; await until(() => f.seen.open === 0, 'every connection is closed');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(f.seen.accepted, accepted, 'none comes up after the failure was told');
    assert.ok(accepted <= down + AT_ONCE, `${accepted} connected: no more is started`);
  }
});

test('connect: a backend that ends or refuses half-way, or is bound to another service, fails the whole', async t => {
  const cases = {
    'error.serviceClosed': { answer: { 7: socket => socket.destroy() } },
    refused: { answer: { 7: (socket, r) => socket.write(JSON.stringify({ id: r.id, ok: false, error: 'refused' }) + '\n') } },
    bound: { state: n => n === 7 ? { serviceBinding: { owner: 'another' } } : {} },
  };
  for (const [name, options] of Object.entries(cases)) {
    const f = await backends(t, 24, { delay: 20, ...options });
    await assert.rejects(connect(f.root, 'person'), error => name.startsWith('error.') ? failsWith(name)(error) : name === 'refused' ? error.message === 'refused' : /binding/u.test(error.code || error.message));
    await until(() => f.seen.open === 0, 'every connection is closed');
  }
});

test('lookupWake: the one backend with the recipient is found among backends that answer slowly', async t => {
  for (const holder of [0, 11, COUNT - 1]) {
    const f = await backends(t, COUNT, { state: n => ({ sessions: [session(n === holder ? 'recipient' : 's' + n)] }) }), started = Date.now();
    const found = await runner(f.root).lookupWake('recipient'), took = Date.now() - started;
    t.diagnostic(`${COUNT} backends, ${DELAY} ms each, in ${holder}: ${took} ms`);
    assert.equal(found.key, f.entries[holder]); assert.equal(found.session.id, 'recipient'); assert.equal(found.canCheckWake, false);
    assert.ok(took < bound(COUNT) && took < serial(COUNT), `${took} ms`); assert.equal(f.seen.most, AT_ONCE); assert.equal(f.seen.asked, COUNT, 'all are asked: one recipient in exactly one backend');
    await until(() => f.seen.open === 0, 'every connection is closed');
    if (DELAY >= 1000) return;
  }
});

test('lookupWake: in two backends, in none, not able to wake or with a storage warning: refused as before', async t => {
  const holding = (...which) => n => ({ sessions: which.includes(n) ? [session('recipient')] : [] });
  const unavailable = 'error.peer.recipientBackendUnavailable';
  for (const [options, expected] of [
    [{ state: holding(3, 4) }, unavailable], [{ state: holding(0, 23) }, unavailable], [{ state: holding(1, 2, 3) }, unavailable],
    [{ state: holding() }, 'error.peer.exactSessionMissing'],
    [{ state: n => ({ ...holding(6)(n), capabilities: [] }) }, unavailable],
    [{ state: n => ({ ...holding(6)(n), storageWarning: 'x' }) }, unavailable],
    // A backend without the recipient is not asked to be able to wake.
    [{ state: n => ({ ...holding(6)(n), ...(n === 6 ? {} : { capabilities: [], storageWarning: 'x' }) }) }, null],
    [{ state: holding(6), down: [20] }, 'error.serviceConnect'], [{ state: holding(6), down: [0] }, 'error.serviceConnect'],
    [{ state: holding(6), answer: { 9: socket => socket.destroy() } }, 'error.serviceClosed'],
    [{ state: holding(6), answer: { 6: socket => socket.destroy() } }, 'error.serviceClosed'],
  ]) {
    const f = await backends(t, 24, { delay: 10, ...options }), asked = runner(f.root).lookupWake('recipient');
    if (expected) await assert.rejects(asked, failsWith(expected)); else assert.equal((await asked).key, f.entries[6]);
    await until(() => f.seen.open === 0, 'every connection is closed');
  }
});

test('lookupWake: the readiness question goes only to the backend that holds the recipient, after the others answered', async t => {
  const f = await backends(t, 8, { delay: 10, state: n => ({ capabilities: ['agentWakeV1', 'agentWakePreflightV1'], sessions: n === 2 ? [session('recipient')] : [] }) });
  const calls = [], { connectService } = require('../service-connection.cjs');
  const asking = runner(f.root, async (directory, owner) => {
    const client = await connectService(directory, owner); calls.push([path.relative(f.root, directory), owner]);
    if (owner === 'workspace-wake-check') client.call = async (method, spec) => { calls.push([method, spec.recipientId]); return { status: 'ready' }; };
    return client;
  });
  const found = await asking.lookupWake('recipient', { id: 'x' });
  assert.deepEqual(found.readiness, { status: 'ready' });
  assert.deepEqual(calls.slice(8), [[f.entries[2], 'workspace-wake-check'], ['wakeCheck', 'recipient']]);
  assert.deepEqual(calls.slice(0, 8).map(c => c[0]).sort(), [...f.entries].sort());
});
