const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { fork } = require('node:child_process');
const { connectService } = require('../service-client.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
test('actual daemon refuses shutdown while an import has no record yet', { timeout: 10000 }, async t => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-import-shutdown-'));
  const child = fork(path.join(__dirname, '../daemon.cjs'), [profile], { execArgv: ['--require', path.join(__dirname, '../../scripts/fixtures/native-history.cjs')], env: { ...process.env, NAW_APP_VERSION: 'test' }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  let client, seq = 0;
  t.after(async () => { client?.close(); if (child.exitCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await exited; } fs.rmSync(profile, { recursive: true, force: true }); });
  function control(method) { const id = ++seq; return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('Fixture timeout')), 3000); const receive = m => { if (m.requestId === id) { clearTimeout(timer); child.off('message', receive); resolve(m); } }; child.on('message', receive); child.send({ id, method }); }); }
  for (let n = 0; n < 100 && !fs.existsSync(path.join(profile, 'connection.json')); n++) await delay(30);
  client = await connectService(profile, 'race-owner'); await control('holdRead');
  const importing = client.call('importHistory', '00000000-0000-4000-8000-000000000001');
  for (let n = 0; n < 100; n++) { if ((await control('stats')).calls.some(c => c.method === 'thread/read')) break; await delay(20); }
  assert.equal((await client.call('initial')).sessions.length, 0);
  await assert.rejects(client.call('shutdown'), /正在接入/); assert.equal(child.exitCode, null);
  await control('releaseRead'); const id = await importing; assert.ok(id);
  assert.equal((await control('stats')).calls.filter(c => c.method === 'thread/resume').length, 1);
  await client.call('stop', id); await client.call('shutdown');
});
