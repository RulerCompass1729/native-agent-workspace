// Real daemon and Unix socket, synthetic NativeHost: a client that asks for state deltas and one that does not
// (an older app) receive the same broadcasts; the first rebuilds exactly what the second is sent whole.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { fork } = require('node:child_process'), { once } = require('node:events');
const { connectService } = require('../service-connection.cjs');
const { readFrames, RESPONSE_BYTES } = require('../service-transport.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('a delta client rebuilds the whole state an older client is sent, while a reply streams', { timeout: 20000 }, async t => {
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
  const ready = new Promise(resolve => readFrames(raw, RESPONSE_BYTES, m => { if (m.ready) resolve(); else if (m.event === 'state') { m.at = Date.now(); whole.push(m); } }));
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

  // A streamed reply names its session, and the daemon digests only that session again. A change to another
  // session's messages that reports nothing is carried, and reaches the delta client within 2 seconds.
  const other = await client.call('create', { provider: 'codex', cwd: dir, name: 'Synthetic quiet', view: 'chat' });
  await fixture('nativeBlock', other, { id: 'display:quiet', turnId: 'quiet-turn', kind: 'response', text: 'before', status: 'complete' });
  await client.call('draft', other, 'everything digested again'); await delay(150);
  const from = whole.length, edited = Date.now();
  await fixture('quietEdit', other, 'changed quietly');
  for (let i = 1; i <= 5; i++) { await fixture('nativeBlock', id, { id: 'display:more', turnId: sent.lastSend.turnId, kind: 'response', text: 'more '.repeat(i), status: 'streaming' }); await delay(80); }
  await delay(2100 - (Date.now() - edited));
  await fixture('nativeBlock', id, { id: 'display:more', turnId: sent.lastSend.turnId, kind: 'response', text: 'more '.repeat(6), status: 'complete' }); await delay(150);
  assert.equal(rebuilt.length, whole.length);
  const quiet = i => rebuilt[i].sessions.find(s => s.id === other).messages.at(-1).text, late = [];
  for (let i = from; i < whole.length; i++) if (JSON.stringify(rebuilt[i]) !== JSON.stringify(whole[i].data)) late.push({ i, after: whole[i].at - edited, text: quiet(i) });
  assert.ok(late.length >= 1 && late.every(frame => frame.text === 'before'), `carried: the delta client still read the quiet session as before (${JSON.stringify(late)})`);
  assert.ok(late.every(frame => frame.after < 2250), `never later than 2 seconds (${JSON.stringify(late)})`);
  assert.equal(JSON.stringify(rebuilt.at(-1)), JSON.stringify(whole.at(-1).data)); assert.equal(quiet(rebuilt.length - 1), 'changed quietly');
  // A change reported without naming a session (a draft here) digests everything again: an earlier change in place
  // that reported nothing goes with it at once.
  const reported = whole.length;
  await fixture('quietEdit', other, 'changed, then any change reported'); await client.call('draft', id, 'reported'); await delay(150);
  assert.ok(whole.length > reported); assert.equal(rebuilt.length, whole.length);
  for (let i = reported; i < whole.length; i++) assert.equal(JSON.stringify(rebuilt[i]), JSON.stringify(whole[i].data), `frame ${i}`);
  assert.equal(quiet(rebuilt.length - 1), 'changed, then any change reported');
});
