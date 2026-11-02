// Real framed Unix RPC and daemon, synthetic NativeHost only: the pause RPC withdraws
// every staged wake only when the person explicitly paused all follow-up handoffs.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { fork } = require('node:child_process'), { once } = require('node:events');
const { connectService } = require('../service-connection.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
test('pause rotates the shared wake boundary only with the explicit withdraw flag', { timeout: 10000 }, async t => {
  const root = path.resolve(__dirname, '../..'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-wake-pause-')); fs.chmodSync(dir, 0o700);
  let client, stderr = '';
  const child = fork(path.join(root, 'app/daemon.cjs'), [dir], { execArgv: ['--require', path.join(root, 'scripts/fixtures/collaboration-overview.cjs')], env: { ...process.env, NAW_TEST_APP_ROOT: root, NAW_WORKSPACE: path.join(dir, 'workspace') }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      if (!client && fs.existsSync(path.join(dir, 'connection.json'))) client = await connectService(dir, 'wake-pause-cleanup');
      if (client) { await client.call('shutdown').catch(() => {}); await Promise.race([once(child, 'exit'), delay(3000)]); }
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
    client?.close(); fs.rmSync(dir, { recursive: true, force: true });
  });
  for (let i = 0; i < 100 && !fs.existsSync(path.join(dir, 'connection.json')) && child.exitCode === null; i++) await delay(10);
  assert.ok(fs.existsSync(path.join(dir, 'connection.json')), stderr);
  client = await connectService(dir, 'wake-pause-owner');
  assert.ok((await client.call('initial')).capabilities.includes('agentWakeV1'));
  const boundary = () => fs.readFileSync(path.join(dir, 'agent-wake-boundary'), 'utf8'), first = boundary();
  await client.call('pause');
  assert.equal(boundary(), first, 'An implicit pause leaves other agents\' wakes alone');
  await client.call('pause', { withdrawWakes: true });
  assert.notEqual(boundary(), first, 'The explicit pause withdraws every staged wake');
});
