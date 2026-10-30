// Real framed Unix RPC and daemon, with the existing synthetic NativeHost only.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { fork } = require('node:child_process'), { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { connectService } = require('../service-connection.cjs');
const { membershipRevision } = require('../collaboration-spaces.cjs');
const { WorkspaceClient } = require('../workspace-client.cjs');
const { RoomState } = require('../room-state.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
test('actual bounded space envelopes preserve membership and original output across Unix RPC, including stale undo refusal', { timeout: 10000 }, async t => {
  const root = path.resolve(__dirname, '../..'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-spaces-protocol-')); fs.chmodSync(dir, 0o700);
  let client, sequence = 0, stderr = '';
  const child = fork(path.join(root, 'app/daemon.cjs'), [dir], { execArgv: ['--require', path.join(root, 'scripts/fixtures/collaboration-overview.cjs')], env: { ...process.env, NAW_TEST_APP_ROOT: root, NAW_WORKSPACE: path.join(dir, 'workspace') }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const fixture = (method, target, value) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { child.off('message', listener); reject(Error('Owned fixture request timed out')); }, 1000);
    const listener = reply => { if (reply.requestId !== id) return; clearTimeout(timer); child.off('message', listener); reply.error ? reject(Error(reply.error)) : resolve(reply); };
    child.on('message', listener); child.send({ id, method, target, value });
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      if (!client && fs.existsSync(path.join(dir, 'connection.json'))) client = await connectService(dir, 'space-test-cleanup');
      if (client) { await fixture('stop'); await client.call('shutdown'); await Promise.race([once(child, 'exit'), delay(3000).then(() => { throw Error('Owned synthetic daemon did not exit; profile retained'); })]); }
    }
    client?.close();
    assert.notEqual(child.exitCode, null, 'Only an exited owned fixture may be removed');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  for (let i = 0; i < 100 && !fs.existsSync(path.join(dir, 'connection.json')) && child.exitCode === null; i++) await delay(10);
  assert.ok(fs.existsSync(path.join(dir, 'connection.json')), stderr);
  client = await connectService(dir, 'space-test-owner');
  assert.ok((await client.call('initial')).capabilities.includes('collaborationSpacesV1'));
  const id = await client.call('create', { provider: 'codex', cwd: dir, name: 'Synthetic native identity', view: 'chat' }), a = randomUUID(), b = randomUUID();
  for (const room of [a, b]) await client.call('spaceAction', room, 'join', [id, true], {});
  let snapshot = await client.call('initial'), session = snapshot.sessions.find(s => s.id === id);
  assert.equal(session.roomId, null); assert.deepEqual(session.roomIds, [a, b]); const nativeId = session.nativeId;
  const originalProof = { nativeId, revision: membershipRevision(session, a) };
  await client.call('spaceAction', a, 'join', [id, false], {}); await client.call('spaceAction', a, 'join', [id, true], {});
  await assert.rejects(client.call('spaceAction', a, 'join', [id, false, originalProof], {}), /撤销没有执行/);
  await fixture('bindSends', id); snapshot = await client.call('initial'); session = snapshot.sessions.find(s => s.id === id);
  const proof = { [id]: membershipRevision(session, a) };
  await client.call('spaceAction', a, 'forward', [id, 'Only A request', nativeId], proof);
  const sent = await fixture('stats', id);
  await fixture('nativeBlock', id, { id: 'display:answer', turnId: sent.lastSend.turnId, kind: 'response', text: 'Only A original reply', status: 'complete' });
  snapshot = await client.call('initial');
  assert.ok(snapshot.rooms.find(r => r.id === a).messages.some(m => m.text === 'Only A original reply'));
  assert.equal(snapshot.rooms.find(r => r.id === b).messages.length, 0); assert.equal(snapshot.room.messages.length, 0);
  await client.call('spaceAction', b, 'clearSharedHistory', [], {});
  assert.equal((await fixture('stats', id)).stats.sends, 1); assert.equal(sent.stats.inputs, 0); assert.equal(sent.stats.opens, 0);
  await assert.rejects(client.call('spaceAction', a, 'send', [id, 'Forbidden private route'], proof), /无效协作空间/);
  await assert.rejects(client.call('spaceAction', a, 'forward', [id, 'Stale proof', nativeId], { [id]: originalProof.revision }), /成员关系已变化/);
  assert.equal((await fixture('stats', id)).stats.sends, 1);
  await fixture('complete', id, { text: 'Only A original reply', messageId: 'display:answer' });
  const second = await client.call('create', { provider: 'claude', cwd: dir, name: 'Second synthetic identity', view: 'chat' });
  await client.call('spaceAction', a, 'join', [second, true], {});
  const third = await client.call('create', { provider: 'codex', cwd: dir, name: 'Independent B identity', view: 'chat' });
  await client.call('spaceAction', b, 'join', [third, true], {});
  snapshot = await client.call('initial');
  const contexts = Object.fromEntries(snapshot.sessions.map(s => [s.id, s.nativeId])), proofs = Object.fromEntries(snapshot.sessions.map(s => [s.id, membershipRevision(s, a)]));
  await client.call('spaceAction', a, 'run', [[id, second], 'A finite goal', 2, 'replies', {}, contexts], proofs);
  const broker = new WorkspaceClient([{ key: '.', client, state: await client.call('initial') }], '.'); t.after(() => broker.close());
  const metadata = new RoomState(dir), c = metadata.create('Independent C');
  await metadata.membership(broker, second, true, 'Second', c);
  assert.equal((await client.call('initial')).rooms.find(r => r.id === a).run.status, 'running', 'Changing idle C cannot pause A through profile/client/daemon');
  await metadata.archiveRoom(broker, null, c);
  assert.equal((await client.call('initial')).rooms.find(r => r.id === a).run.status, 'running', 'Archiving C cannot pause A');
  await broker.callSpace(b, 'forward', [third, 'Independent B manual request', contexts[third]]);
  assert.equal((await client.call('initial')).rooms.find(r => r.id === a).run.status, 'running', 'A run survives a public B send to a different physical session');
  await broker.callSpace('shared', 'pause', []);
  assert.equal((await client.call('initial')).rooms.find(r => r.id === a).run.status, 'running', 'Explicit shared-room pause cannot pause A');
  await broker.callSpace(a, 'pause', []);
  assert.equal((await client.call('initial')).rooms.find(r => r.id === a).run.status, 'paused');
  assert.equal((await fixture('stats', id)).stats.sends, 3);
});
