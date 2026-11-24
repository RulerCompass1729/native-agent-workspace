// Real daemon and Unix socket, synthetic NativeHost, no model: what a daily install does to an old backend while its
// sessions work. The old GUI quits (its connection closes without leaving), the new GUI's startup pauses the old
// backend and withdraws its staged wakes (service-client.cjs), then the new GUI connects again.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { fork } = require('node:child_process'), { once } = require('node:events');
const { connectService } = require('../service-connection.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('a turn in progress, an approval and a draft survive the GUI quit and the upgrade pause', { timeout: 20000 }, async t => {
  const root = path.resolve(__dirname, '../..'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-install-restart-')); fs.chmodSync(dir, 0o700);
  let sequence = 0, stderr = '';
  const clients = [];
  const child = fork(path.join(root, 'app/daemon.cjs'), [dir], { execArgv: ['--require', path.join(root, 'scripts/fixtures/native-progress.cjs')], env: { ...process.env, NAW_TEST_APP_ROOT: root, NAW_WORKSPACE: path.join(dir, 'workspace') }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const fixture = (method, target, value) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { child.off('message', listener); reject(Error('Owned fixture request timed out')); }, 2000);
    const listener = reply => { if (reply.requestId !== id) return; clearTimeout(timer); child.off('message', listener); reply.error ? reject(Error(reply.error)) : resolve(reply); };
    child.on('message', listener); child.send({ id, method, target, value });
  });
  const open = async owner => { const client = await connectService(dir, owner); clients.push(client); return client; };
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const client = clients.find(c => !c.closing && !c.socket.destroyed) || await connectService(dir, 'install-restart-cleanup');
      await fixture('stop'); await client.call('shutdown');
      await Promise.race([once(child, 'exit'), delay(3000).then(() => { throw Error('Owned synthetic daemon did not exit; profile retained'); })]);
      client.close();
    }
    for (const client of clients) client.close();
    assert.notEqual(child.exitCode, null, 'Only an exited owned fixture may be removed');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  for (let i = 0; i < 200 && !fs.existsSync(path.join(dir, 'connection.json')) && child.exitCode === null; i++) await delay(10);
  assert.ok(fs.existsSync(path.join(dir, 'connection.json')), stderr);

  const gui = await open('person-window');
  const worker = await gui.call('create', { provider: 'codex', cwd: dir, name: 'Working', view: 'chat' });
  const asker = await gui.call('create', { provider: 'codex', cwd: dir, name: 'Asking', view: 'chat' });
  await fixture('bindSends', worker); await delay(100);
  await gui.call('send', worker, 'Synthetic task', `synthetic-${worker}`);
  const turn = (await fixture('stats', worker)).lastSend.turnId;
  await fixture('nativeBlock', worker, { id: 'display:answer', turnId: turn, kind: 'response', text: 'first half', status: 'streaming' });
  await gui.call('draft', worker, 'typed but not sent');
  await fixture('approval', asker, { id: 'approval-synthetic', method: 'item/commandExecution/requestApproval', params: { command: 'echo synthetic (nothing runs)', cwd: dir } });
  await delay(150);
  const find = (state, id) => state.sessions.find(s => s.id === id);
  const before = await gui.call('initial');
  assert.deepEqual([find(before, worker).state, find(before, asker).state], ['working', 'approval']);

  // The old GUI quits; the new one pauses the old backend first, then connects.
  gui.close(); await delay(200);
  const upgrade = await open('upgrade');
  await upgrade.call('pause', { withdrawWakes: true }); upgrade.close();
  const reopened = await open('person-window');
  const after = await reopened.call('initial');
  const kept = find(after, worker), asking = find(after, asker);
  assert.deepEqual([kept.state, kept.nativeId, kept.liveDraft, kept.owner], ['working', find(before, worker).nativeId, 'typed but not sent', 'person-window']);
  assert.ok(kept.messages.some(m => m.text === 'first half'), 'the streamed part of the reply is kept');
  assert.equal(asking.state, 'approval');
  assert.deepEqual(asking.approval, find(before, asker).approval, 'the approval request is kept as it was');

  // Both carry on through the new connection: the reply completes and the person's answer reaches the native session.
  await fixture('nativeBlock', worker, { id: 'display:answer', turnId: turn, kind: 'response', text: 'first half, second half', status: 'complete' });
  await fixture('complete', worker, {});
  await reopened.call('approve', asker, asking.approval.requestId, 'accept');
  await delay(200);
  const done = await reopened.call('initial');
  assert.equal(find(done, worker).state, 'idle');
  assert.ok(find(done, worker).messages.some(m => m.text === 'first half, second half'), 'the finished reply arrives after the restart');
  const replies = (await fixture('stats', asker)).approvalReplies;
  assert.equal(replies.length, 1, 'the approval answer reached the native session');
  assert.equal(find(done, asker).state, 'idle');
});
