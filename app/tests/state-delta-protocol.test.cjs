// Real daemon and Unix socket, synthetic NativeHost: a client that asks for state deltas and one that does not
// (an older app) receive the same broadcasts; the first rebuilds exactly what the second is sent whole.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { fork } = require('node:child_process'), { once } = require('node:events');
const { connectService } = require('../service-connection.cjs');
const { readFrames, RESPONSE_BYTES } = require('../service-transport.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('a delta client rebuilds the whole state an older client is sent, while a reply streams', { timeout: 15000 }, async t => {
  const root = path.resolve(__dirname, '../..'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-state-delta-')); fs.chmodSync(dir, 0o700);
  let client, raw, sequence = 0, stderr = '';
  const child = fork(path.join(root, 'app/daemon.cjs'), [dir], { execArgv: ['--require', path.join(root, 'scripts/fixtures/native-progress.cjs')], env: { ...process.env, NAW_TEST_APP_ROOT: root, NAW_WORKSPACE: path.join(dir, 'workspace') }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const fixture = (method, target, value) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { child.off('message', listener); reject(Error('Owned fixture request timed out')); }, 2000);
    const listener = reply => { if (reply.requestId !== id) return; clearTimeout(timer); child.off('message', listener); reply.error ? reject(Error(reply.error)) : resolve(reply); };
    child.on('message', listener); child.send({ id, method, target, value });
  });
  t.after(async () => {
    raw?.destroy();
    if (child.exitCode === null && child.signalCode === null) {
      if (!client && fs.existsSync(path.join(dir, 'connection.json'))) client = await connectService(dir, 'state-delta-cleanup');
      if (client) { await fixture('stop'); await client.call('shutdown'); await Promise.race([once(child, 'exit'), delay(3000).then(() => { throw Error('Owned synthetic daemon did not exit; profile retained'); })]); }
    }
    client?.close();
    assert.notEqual(child.exitCode, null, 'Only an exited owned fixture may be removed');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  for (let i = 0; i < 200 && !fs.existsSync(path.join(dir, 'connection.json')) && child.exitCode === null; i++) await delay(10);
  assert.ok(fs.existsSync(path.join(dir, 'connection.json')), stderr);
  client = await connectService(dir, 'state-delta-owner');
  // What arrives on the delta client's socket, before ServiceClient rebuilds it.
  const wire = []; let pending = '';
  client.socket.on('data', chunk => { pending += chunk; let end; while ((end = pending.indexOf('\n')) >= 0) { const m = JSON.parse(pending.slice(0, end)); pending = pending.slice(end + 1); if (m.event === 'state') wire.push(m); } });
  const rebuilt = []; client.on('state', state => rebuilt.push(state));
  // The older client: the same handshake without stateDelta.
  const info = JSON.parse(fs.readFileSync(path.join(dir, 'connection.json'), 'utf8')), whole = [];
  raw = net.connect(info.endpoint);
  await once(raw, 'connect');
  const ready = new Promise(resolve => readFrames(raw, RESPONSE_BYTES, m => { if (m.ready) resolve(); else if (m.event === 'state') whole.push(m); }));
  raw.write(JSON.stringify({ protocol: 1, owner: 'older-app', token: info.token }) + '\n');
  await ready;

  const id = await client.call('create', { provider: 'codex', cwd: dir, name: 'Synthetic streaming', view: 'chat' });
  await fixture('bindSends', id); await delay(100);
  await client.call('send', id, 'First request', `synthetic-${id}`);
  const sent = await fixture('stats', id);
  for (let i = 1; i <= 6; i++) {
    await fixture('nativeBlock', id, { id: 'display:answer', turnId: sent.lastSend.turnId, kind: 'response', text: 'part '.repeat(i), status: i < 6 ? 'streaming' : 'complete' });
    await delay(80);
  }
  await client.call('draft', id, 'typed but not sent'); await delay(150);

  assert.ok(whole.length >= 5, `older client received ${whole.length} state frames`);
  assert.equal(whole.some(m => m.delta), false, 'the older client is never sent a delta');
  assert.equal(wire[0].delta, undefined, 'the first frame of a delta client is whole');
  const deltas = wire.filter(m => m.delta === 1);
  assert.ok(deltas.length >= 4, `delta frames: ${deltas.length} of ${wire.length}`);
  assert.ok(deltas.some(m => m.data.sessions.find(s => s.id === id)?.messagesKeep >= 1), 'the streamed session is sent as kept messages plus the rest');
  // Both clients got every broadcast, in order; each rebuilt state reads exactly as the whole one did.
  assert.equal(rebuilt.length, whole.length);
  for (let i = 0; i < whole.length; i++) assert.equal(JSON.stringify(rebuilt[i]), JSON.stringify(whole[i].data), `frame ${i}`);
  const last = rebuilt.at(-1).sessions.find(s => s.id === id);
  assert.equal(last.messages.at(-1).text.trim(), 'part '.repeat(6).trim()); assert.equal(last.liveDraft, 'typed but not sent');
});
