// A newer app's startup (the real ensureService) over two old backends whose sessions are sending each other automatic
// messages: real daemons and sockets, synthetic native sessions, no model.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { fork } = require('node:child_process'), { once } = require('node:events');
const { connectService } = require('../service-connection.cjs');
const root = path.resolve(__dirname, '../..'), delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const ONE = '.', TWO = 'backends/aaaaaaaaaaaaaaaaaaaa', NEXT = 'backends/bbbbbbbbbbbbbbbbbbbb';

async function until(check, message, ms = 8000) {
  for (const end = Date.now() + ms; ;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw Error(message);
    await delay(50);
  }
}

async function world(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'naw-upgrade-wakes-'))), cwd = path.join(dir, 'workspace');
  for (const name of ['workspace', 'backends', TWO, NEXT]) fs.mkdirSync(path.join(dir, name), { mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'services.json'), JSON.stringify({ format: 1, active: TWO, entries: [ONE, TWO, NEXT] }), { mode: 0o600 });
  const children = {}, clients = {}, at = {}, saved = { NAW_APP_VERSION: process.env.NAW_APP_VERSION, NAW_WORKSPACE: process.env.NAW_WORKSPACE };
  let sequence = 0, stderr = '';
  for (const key of [ONE, TWO, NEXT]) {
    children[key] = fork(path.join(root, 'app/daemon.cjs'), [path.join(dir, key)], { cwd, execArgv: ['--require', path.join(root, 'scripts/fixtures/session-wake.cjs')],
      env: { ...process.env, NAW_APP_VERSION: key === NEXT ? '0.1.0-alpha.902' : '0.1.0-alpha.901', NAW_TEST_APP_ROOT: root, NAW_WORKSPACE: cwd }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    children[key].stderr.on('data', chunk => { stderr += chunk; });
  }
  const request = (key, fields) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { children[key].off('message', reply); reject(Error('Owned fixture request timed out')); }, 8000);
    const reply = row => { if (row.requestId !== id) return; clearTimeout(timer); children[key].off('message', reply); resolve(row); };
    children[key].on('message', reply);
    children[key].send(fields.method === 'wakeIntent' ? { id: 'wake-' + id, wakeRequestId: id, ...fields } : { id, ...fields });
  });
  t.after(async () => {
    for (const client of Object.values(clients)) client.close();
    for (const [key, child] of Object.entries(children)) if (child.exitCode === null && child.signalCode === null) {
      const client = await connectService(path.join(dir, key), 'cleanup');
      for (const s of (await client.call('initial')).sessions) if (s.state !== 'ended') await client.call('stop', s.id).catch(() => {});
      await Promise.race([client.call('shutdown').catch(() => {}), delay(2000)]);
      client.close();
      await Promise.race([once(child, 'exit'), delay(3000)]);
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
    }
    for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await until(() => [ONE, TWO, NEXT].every(key => fs.existsSync(path.join(dir, key, 'connection.json'))), 'backends started: ' + stderr);
  const open = async () => { for (const key of [ONE, TWO]) clients[key] = await connectService(path.join(dir, key), 'person-window'); };
  await open();
  const session = async id => (await clients[at[id]].call('initial')).sessions.find(s => s.id === id);
  const w = {
    call: (id, ...args) => clients[at[id]].call(...args),
    async claimElsewhere(id) { const other = await connectService(path.join(dir, at[id]), 'another-window'); try { await other.call('claim', id); } finally { other.close(); } },
    all: (...args) => Promise.all([ONE, TWO].map(key => clients[key].call(...args))),
    session,
    async member(key, name, working = true) {
      const id = await clients[key].call('create', { provider: 'codex', cwd, name, view: 'chat' });
      at[id] = key;
      await until(async () => { const s = await session(id); return s.state === 'idle' && s.chatAvailable; }, name + ' is ready');
      if (working) {
        await clients[key].call('send', id, 'work', 'synthetic-' + id);
        await until(async () => (await session(id)).state === 'working', name + ' works');
      }
      return id;
    },
    // What the session's own workspace_message call gives back to it.
    async message(from, to, body) {
      const row = await request(at[from], { method: 'wakeIntent', target: from, value: { recipientId: to, body, callId: 'call-' + body } });
      return row.wakeError || row.wakeResult.status;
    },
    finish: id => request(at[id], { method: 'release', target: id, value: 'done', text: 'done' }),
    async sent(id) { const wake = (await session(id)).messages.find(m => m.wake)?.wake; return [wake.status, wake.cancellation?.code].filter(Boolean).join('/'); },
    async received(id) { return (await request(at[id], { method: 'stats' })).sends.filter(row => row.id === id).map(row => row.text); },
    async upgrade() {
      const pids = Object.values(children).map(child => child.pid);
      for (const client of Object.values(clients)) client.close();
      process.env.NAW_APP_VERSION = '0.1.0-alpha.902'; process.env.NAW_WORKSPACE = cwd;
      await require('../service-client.cjs').ensureService(dir, process.execPath);
      assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'services.json'), 'utf8')).active, NEXT, 'the new version is in use');
      await open();
      assert.deepEqual(Object.values(children).map(child => [child.pid, child.exitCode]), pids.map(pid => [pid, null]), 'the old backends are the same processes');
    },
  };
  return w;
}

test('a newer version leaves messages on their way, and what a turn may still send, as they are', { timeout: 60000 }, async t => {
  const w = await world(t);
  const [a, held, late] = [await w.member(ONE, 'Sender'), await w.member(ONE, 'Held sender'), await w.member(ONE, 'Late sender')], back = await w.member(TWO, 'Sender on two');
  const [idle, idleLate] = [await w.member(TWO, 'Receiver', false), await w.member(TWO, 'Late receiver', false)], busy = await w.member(TWO, 'Working receiver'), home = await w.member(ONE, 'Receiver on one', false);
  for (const [from, to, body] of [[a, idle, 'MESSAGE-STAGED'], [back, home, 'MESSAGE-BACK'], [held, busy, 'MESSAGE-HELD']]) assert.equal(await w.message(from, to, body), 'staged', body);
  await w.finish(held);
  await until(async () => await w.sent(held) === 'held', 'the busy receiver holds it');

  await w.upgrade();

  assert.deepEqual([await w.sent(a), await w.sent(back), await w.sent(held)], ['staged', 'staged', 'held']);
  assert.equal(await w.message(late, idleLate, 'MESSAGE-LATE'), 'staged', 'a turn that ran through the change may still send');
  for (const id of [a, back, late]) await w.finish(id);
  for (const [to, body] of [[idle, 'MESSAGE-STAGED'], [home, 'MESSAGE-BACK'], [idleLate, 'MESSAGE-LATE']]) {
    await until(async () => (await w.received(to)).some(text => text.includes(body)), body + ' arrives');
  }
  assert.equal(await w.sent(held), 'held', 'the held one still waits for its receiver');
  assert.equal((await w.received(busy)).some(text => text.includes('MESSAGE-HELD')), false);
});

test("after a newer version started, the person's own stops still withdraw what they did before", { timeout: 60000 }, async t => {
  const w = await world(t);
  const names = ['taken', 'stopped', 'receiver', 'kept', 'kept-two'], from = {}, to = {};
  for (const name of names) { from[name] = await w.member(name === 'kept-two' ? TWO : ONE, 'Sender ' + name); to[name] = await w.member(name === 'kept-two' ? ONE : TWO, 'Receiver ' + name, false); }
  for (const name of names) assert.equal(await w.message(from[name], to[name], 'MESSAGE-' + name), 'staged', name);
  await w.upgrade();
  const statuses = async () => Object.fromEntries(await Promise.all(names.map(async name => [name, await w.sent(from[name])])));

  // In one session: only its own message, when its turn ends.
  await w.call(from.stopped, 'interrupt', from.stopped);
  await w.claimElsewhere(from.taken);
  await w.call(to.receiver, 'stop', to.receiver);
  for (const name of ['stopped', 'taken', 'receiver']) await w.finish(from[name]);
  await until(async () => { const now = await statuses(); return ['stopped', 'taken', 'receiver'].every(name => now[name] !== 'staged'); }, 'settled');
  const now = await statuses();
  assert.deepEqual([now.kept, now['kept-two'], now.receiver], ['staged', 'staged', 'not-sent'], JSON.stringify(now));
  for (const name of ['taken', 'stopped']) assert.match(now[name], /^cancelled/, JSON.stringify(now));

  // Everything: pause all.
  await w.all('pause', { withdrawWakes: true });
  assert.deepEqual([await w.sent(from.kept), await w.sent(from['kept-two'])], ['cancelled/pause', 'cancelled/pause']);
  assert.equal(await w.message(from.kept, to.kept, 'AFTER-PAUSE'), '全部交接已暂停，本回合的自动消息授权已撤销。');

  // Everything: the switch for automatic messages.
  const [switched, switchedTo] = [await w.member(ONE, 'Sender switch'), await w.member(TWO, 'Receiver switch', false)];
  assert.equal(await w.message(switched, switchedTo, 'MESSAGE-SWITCH'), 'staged');
  await w.call(switched, 'wakePolicy', null, false);
  assert.equal(await w.sent(switched), 'cancelled/switch');
  for (const name of names) assert.equal((await w.received(to[name])).some(text => text.includes('MESSAGE-')), false, name);
});
