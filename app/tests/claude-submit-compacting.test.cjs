const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events'), { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const fs = require('node:fs'), net = require('node:net'), os = require('node:os'), path = require('node:path');
const { Workspace } = require('../workspace.cjs');
const { Claude } = require('../adapters.cjs');
const { SubmissionChannel } = require('../claude-submit.cjs');

// edbc6b7f (11-25): a queue item sent to a session 6.7 s into Claude's own idle compaction was recorded failed after
// 15 s and started when the compaction ended, 46 s in. What native does while it compacts, as it reports it: the
// PreCompact settings hook at the start, the bridge's compact row and the SessionStart hook at the end.
const turn = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-submit-compacting-'));
  const host = { binaries: {}, close() {}, create(record) {
    const r = Object.create(Claude.prototype); EventEmitter.call(r); r.record = record; r.ready = true; r.pending = null;
    r.terminal = { alive: true, pid: 1234, input() {} }; r.submission = new SubmissionChannel();
    r.submission.on('change', () => { r.chatAvailable = r.submission.connected; r.emit('capability'); }); r.chatAvailable = false;
    r.start = async () => r.emit('state', 'idle'); return r;
  } };
  const w = new Workspace(host, dir), id = await w.create('claude', dir, 'owner', 'Member'), s = w.get(id), r = w.runtimes.get(id);
  t.after(() => { r.submission.close(); w.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  r.bindRoot({ sessionId: s.nativeId });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const listen = () => {
    const response = new EventEmitter();
    response.end = text => { response.value = JSON.parse(text); response.emit('close'); };
    r.submission.receive(response); return response;
  };
  const hook = event => r.hook({ session_id: s.nativeId, ...event });
  const started = extra => hook({ hook_event_name: 'PreCompact', ...extra });
  const ended = () => hook({ hook_event_name: 'SessionStart', source: 'compact' });
  // One queue item as the dispatcher sends it, delivered to the mod, and authorized unless told otherwise.
  const send = async (authorize = true) => {
    const response = listen(), text = '【NAW 派活】task', outcome = { settled: false };
    const sending = w.send(id, text, 'naw-dispatcher', null, null, null, null, null, null, null, { itemId: 'item-1' })
      .then(tag => { Object.assign(outcome, { settled: true, tag }); }, error => { Object.assign(outcome, { settled: true, error }); });
    await turn();
    const tag = response.value?.id;
    if (authorize) assert.equal(r.submission.authorize({ id: tag, text }), true);
    const accept = async () => { r.submission.result({ id: tag, status: 'accepted', promptId: randomUUID(), turnId: 'turn-1' }); await sending; };
    const row = () => s.messages.find(m => m.id === tag)?.status;
    return { outcome, accept, row, tag };
  };
  // Second by second: a timer set by another one during a single tick would count from the tick's end.
  const pass = async seconds => { for (let left = Math.round(seconds * 1000); left > 0; left -= 1000) t.mock.timers.tick(Math.min(1000, left)); await turn(); await turn(); };
  return { t, w, id, s, r, hook, started, ended, send, pass, listen };
}

test('an authorized send native holds through a compaction is not failed after 15 s; it is accepted when the compaction ends', async t => {
  const f = await fixture(t);
  f.started();
  await f.pass(6.7);
  const sent = await f.send();
  await f.pass(45);
  assert.deepEqual([sent.outcome.settled, sent.row(), f.s.pendingTag], [false, 'awaiting-native', sent.tag], 'still waiting, nothing recorded as failed');
  f.ended();
  await f.pass(0.1);
  await sent.accept();
  assert.deepEqual([sent.outcome.error, sent.outcome.tag, sent.row()], [undefined, sent.tag, 'submitted']);
});

test('a compaction that starts after the authorization holds it too, and its end gives the send a whole 15 s', async t => {
  const f = await fixture(t), sent = await f.send();
  await f.pass(10);
  f.started();
  await f.pass(60);
  f.ended();
  await f.pass(14.9);
  assert.equal(sent.outcome.settled, false);
  await f.pass(0.2);
  assert.deepEqual([sent.outcome.error?.uiMessage?.key, sent.outcome.error?.notSent, sent.row()], ['error.nativeSubmissionUnconfirmed', false, 'unconfirmed'], 'nothing 15 s after the end: uncertain, as before');
});

test('with no compaction an authorized send is uncertain after 15 s', async t => {
  const f = await fixture(t), sent = await f.send();
  await f.pass(10);
  f.listen();
  await f.pass(4.9);
  assert.equal(sent.outcome.settled, false, 'a listener that comes back changes nothing, as before');
  await f.pass(0.2);
  assert.deepEqual([sent.outcome.error?.uiMessage?.key, sent.outcome.error?.notSent, sent.row()], ['error.nativeSubmissionUnconfirmed', false, 'unconfirmed']);
});

test('a compaction that is over changes nothing for a later send', async t => {
  const f = await fixture(t);
  f.started(); await f.pass(20); f.ended();
  const sent = await f.send();
  await f.pass(15.1);
  assert.equal(sent.outcome.error?.uiMessage?.key, 'error.nativeSubmissionUnconfirmed');
});

test('the limit of an earlier compaction does not end a later one', async t => {
  const f = await fixture(t);
  f.started(); await f.pass(10); f.ended(); await f.pass(200);
  f.started();
  const sent = await f.send();
  await f.pass(120);
  assert.equal(sent.outcome.settled, false, '330 s after the first, 120 s into the second');
  f.ended(); await sent.accept();
  assert.equal(sent.row(), 'submitted');
});

test('a channel that closed during a compaction holds nothing later', async t => {
  const f = await fixture(t);
  f.started();
  f.r.submission.close();
  const sent = await f.send();
  await f.pass(15.1);
  assert.equal(sent.outcome.error?.uiMessage?.key, 'error.nativeSubmissionUnconfirmed');
});

test('a message waiting for its own native turn has no clock, before, during or after a compaction', async t => {
  const f = await fixture(t), response = f.listen();
  let settled = false;
  f.r.submission.request('queued', 'tag-q', () => true, true).then(() => { settled = true; }, () => { settled = true; });
  assert.equal(f.r.submission.authorize(response.value), true);
  f.started(); await f.pass(60); f.ended(); await f.pass(60);
  assert.equal(settled, false);
});

for (const [name, before] of [['that began before it', true], ['that begins after it', false]]) test(`an unauthorized send is not sent after 15 s, with a compaction ${name}`, async t => {
  const f = await fixture(t);
  if (before) f.started();
  const sent = await f.send(false);
  await f.pass(5);
  if (!before) f.started();
  await f.pass(10.1);
  assert.deepEqual([sent.outcome.error?.uiMessage?.key, sent.outcome.error?.notSent], ['error.nativeSubmissionUnconfirmed', true]);
  assert.equal(f.r.submission.authorize({ id: sent.tag, text: '【NAW 派活】task' }), false);
});

for (const [name, cut] of [
  ['its channel closes', f => f.r.submission.close()],
  ['the mod binds again', f => f.r.bindRoot({ sessionId: f.s.nativeId })],
  ['the context ends', f => f.r.contextEnding('clear')],
]) test(`a send held through a compaction fails at once, uncertain, when ${name}`, async t => {
  const f = await fixture(t);
  f.started();
  const sent = await f.send();
  await f.pass(30);
  assert.equal(sent.outcome.settled, false);
  cut(f);
  await f.pass(0);
  assert.deepEqual([sent.outcome.error?.uiMessage?.key, sent.outcome.error?.notSent, sent.row()], ['error.safeSubmissionClosed', false, 'unconfirmed']);
});

test('a listener that comes back while the clock is stopped has lost the result: uncertain at once, never sent again', async t => {
  const f = await fixture(t);
  f.started();
  const sent = await f.send();
  await f.pass(30);
  assert.equal(sent.outcome.settled, false);
  const again = f.listen();
  await f.pass(0);
  assert.deepEqual([sent.outcome.error?.notSent, sent.row(), again.value], [false, 'unconfirmed', undefined]);
});

test('a listener that comes back during a compaction is given a send it has not had', async t => {
  const f = await fixture(t);
  f.started();
  f.listen().emit('close');
  let outcome = 'waiting';
  f.r.submission.connected = true;
  f.r.submission.request('task', 'tag-u', () => true).then(() => { outcome = 'accepted'; }, () => { outcome = 'ended'; });
  const again = f.listen();
  await f.pass(0);
  assert.deepEqual([outcome, again.value], ['waiting', { id: 'tag-u', text: 'task' }]);
});

for (const [name, event] of [['a turn end', { hook_event_name: 'Stop', last_assistant_message: '' }], ['a session start', { hook_event_name: 'SessionStart', source: 'compact' }]])
  test(`with no compaction ${name} does not give an authorized send more time`, async t => {
    const f = await fixture(t), sent = await f.send();
    await f.pass(10);
    f.hook(event);
    await f.pass(5.1);
    assert.equal(sent.outcome.error?.uiMessage?.key, 'error.nativeSubmissionUnconfirmed');
  });

test('a compaction whose end is never reported stops holding after its limit', async t => {
  const f = await fixture(t);
  f.started();
  const sent = await f.send();
  await f.pass(299);
  assert.equal(sent.outcome.settled, false);
  await f.pass(1); await f.pass(14.9);
  assert.equal(sent.outcome.settled, false);
  await f.pass(0.2);
  assert.equal(sent.outcome.error?.uiMessage?.key, 'error.nativeSubmissionUnconfirmed');
});

for (const [name, event] of [['a prompt it runs next', { hook_event_name: 'UserPromptSubmit', prompt: 'x', prompt_id: randomUUID() }],
  ['a turn end', { hook_event_name: 'Stop', last_assistant_message: '' }], ['a failed turn', { hook_event_name: 'StopFailure' }]])
  test(`a compaction that failed without notice is over at ${name}`, async t => {
    const f = await fixture(t);
    f.started();
    f.hook(event);
    f.r.emit('state', 'idle');
    const sent = await f.send();
    await f.pass(15.1);
    assert.equal(sent.outcome.error?.uiMessage?.key, 'error.nativeSubmissionUnconfirmed');
  });

for (const [name, extra] of [['a subagent', { agent_id: 'child-1' }], ['another session', { session_id: randomUUID() }]])
  test(`the compaction of ${name} holds nothing`, async t => {
    const f = await fixture(t);
    f.started(extra);
    const sent = await f.send();
    await f.pass(15.1);
    assert.equal(sent.outcome.error?.uiMessage?.key, 'error.nativeSubmissionUnconfirmed');
  });

test('a compaction changes neither the session\'s state nor its rows', async t => {
  const f = await fixture(t), states = [], rows = f.s.messages.length;
  f.r.on('state', state => states.push(state));
  f.started();
  assert.deepEqual([states, f.s.state, f.s.messages.length], [[], 'idle', rows]);
});

test('Claude is launched with the hook that reports a compaction\'s start', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-precompact-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const argvFile = path.join(dir, 'argv.txt'), binary = path.join(dir, 'claude');
  fs.writeFileSync(binary, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argvFile}'\n`, { mode: 0o700 });
  const host = { binaries: { claude: binary }, privateDir: dir, hookTargets: new Map(), hookSocket: path.join(dir, 'hook.sock'), submitSocket: path.join(dir, 'submit.sock') };
  const r = new Claude({ id: randomUUID(), nativeId: randomUUID(), name: 'Compacting', cwd: dir }, host);
  await new Promise(resolve => r.terminal.once('closed', resolve)); r.submission.close();
  const argv = fs.readFileSync(argvFile, 'utf8').trim().split('\n'), { hooks } = JSON.parse(fs.readFileSync(argv[argv.indexOf('--settings') + 1], 'utf8'));
  assert.deepEqual(hooks.PreCompact, hooks.Stop, 'the same observing command and limit as the other hooks');
  assert.equal(hooks.PreCompact[0].hooks[0].command.includes('--ask'), false);
});

// Native adds a PreCompact hook's output to the summary's instructions and lets exit 2 stop the compaction.
for (const [name, backend] of [['a backend listening', true], ['none', false]])
  test(`the compaction hook prints nothing and never stops a compaction, with ${name}`, async t => {
    const dir = fs.mkdtempSync('/tmp/naw-pc-'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const socket = path.join(dir, 's'); let received = '';
    if (backend) {
      const server = net.createServer(c => c.on('data', d => { received += d; }));
      await new Promise(resolve => server.listen(socket, resolve)); t.after(() => server.close());
    }
    const result = await new Promise(resolve => {
      const child = execFile('python3', [path.join(__dirname, '..', 'claude_hook.py')], { env: { ...process.env, NAW_HOOK_SOCKET: socket, NAW_HOOK_TOKEN: 'token' } },
        (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
      child.stdin.end(JSON.stringify({ hook_event_name: 'PreCompact', session_id: 'session', trigger: 'auto', custom_instructions: 'private' }));
    });
    assert.deepEqual(result, { code: 0, stdout: '', stderr: '' });
    if (backend) assert.deepEqual(JSON.parse(received), { hook_event_name: 'PreCompact', session_id: 'session', token: 'token' });
  });
