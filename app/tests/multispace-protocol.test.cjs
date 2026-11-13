// Real framed Unix RPC and daemon, with the existing synthetic NativeHost only.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { fork, spawn } = require('node:child_process'), { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { connectService } = require('../service-connection.cjs');
const { membershipRevision } = require('../collaboration-spaces.cjs');
const { WorkspaceClient } = require('../workspace-client.cjs');
const { RoomState } = require('../room-state.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
// NAW_TEST_MULTISPACE_TIMEOUT_MS and NAW_TEST_MULTISPACE_PID_FILE are set only by the cleanup check at the end of this file.
test('actual bounded space envelopes preserve membership and original output across Unix RPC, including stale undo refusal', { timeout: Number(process.env.NAW_TEST_MULTISPACE_TIMEOUT_MS) || 10000 }, async t => {
  const root = path.resolve(__dirname, '../..'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-spaces-protocol-')); fs.chmodSync(dir, 0o700);
  let client, sequence = 0, stderr = '';
  const child = fork(path.join(root, 'app/daemon.cjs'), [dir], { execArgv: ['--require', path.join(root, 'scripts/fixtures/collaboration-overview.cjs')], env: { ...process.env, NAW_TEST_APP_ROOT: root, NAW_WORKSPACE: path.join(dir, 'workspace') }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  if (process.env.NAW_TEST_MULTISPACE_PID_FILE) fs.writeFileSync(process.env.NAW_TEST_MULTISPACE_PID_FILE, String(child.pid));
  child.stderr.on('data', chunk => { stderr += chunk; });
  const fixture = (method, target, value) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { child.off('message', listener); reject(Error('Owned fixture request timed out')); }, 1000);
    const listener = reply => { if (reply.requestId !== id) return; clearTimeout(timer); child.off('message', listener); reply.error ? reject(Error(reply.error)) : resolve(reply); };
    child.on('message', listener); child.send({ id, method, target, value });
  });
  // However the test ends, including its own timeout before the daemon is ready, the forked daemon
  // ends: an orderly stop first, then SIGKILL. A live daemon keeps this file's process from exiting.
  // The orderly stop took 5.4 s under load once (2.1.323 qualification run), hence 10 s before the kill.
  t.after(async () => {
    const alive = () => child.exitCode === null && child.signalCode === null;
    let failure = null;
    if (alive()) {
      const exited = once(child, 'exit');
      let timer;
      try {
        await Promise.race([(async () => {
          if (!client && fs.existsSync(path.join(dir, 'connection.json'))) client = await connectService(dir, 'space-test-cleanup');
          if (client) { await fixture('stop'); await client.call('shutdown'); await exited; }
        })(), new Promise((_resolve, reject) => { timer = setTimeout(() => reject(Error('Owned synthetic daemon did not exit within 10 s')), 10000); })]);
      } catch (error) { failure = error; } finally { clearTimeout(timer); }
      client?.close();
      if (alive()) { child.kill('SIGKILL'); await exited; }
    } else client?.close();
    if (failure) throw Error(`${failure.message}; it was killed and its profile retained: ${dir}\n${stderr}`);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  // The daemon writes connection.json once it listens. In a full-suite run on a busy machine that took over the
  // 1 s this used to allow, so wait up to 5 s, within the 10 s test timeout; stop once the daemon exits or is killed.
  for (const end = Date.now() + 5000; Date.now() < end && !fs.existsSync(path.join(dir, 'connection.json')) && child.exitCode === null && child.signalCode === null;) await delay(10);
  assert.ok(fs.existsSync(path.join(dir, 'connection.json')), stderr);
  client = await connectService(dir, 'space-test-owner');
  assert.ok((await client.call('initial')).capabilities.includes('collaborationSpacesV1'));
  const id = await client.call('create', { provider: 'codex', cwd: dir, name: 'Synthetic native identity', view: 'chat' });
  const roomMetadata=new RoomState(dir), a=roomMetadata.create('A'), b=roomMetadata.create('B');
  await client.call('spaceAction', a, 'join', [id, true], {});
  let snapshot = await client.call('initial'), session = snapshot.sessions.find(s => s.id === id);
  assert.equal(session.roomId, null); assert.deepEqual(session.roomIds, [a]); const nativeId = session.nativeId;
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
  assert.equal((snapshot.rooms.find(r => r.id === b)?.messages || []).length, 0); assert.equal(snapshot.room.messages.length, 0);
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
  const fourth = await client.call('create',{provider:'codex',cwd:dir,name:'Idle independent C member',view:'chat'});
  await metadata.membership(broker, fourth, true, 'Fourth', c);
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

  // Another view uses the existing envelope and peer-identity proof, not claim.
  const cross=await client.call('create',{provider:'codex',cwd:dir,name:'Independent view recipient',view:'chat'});
  await client.call('join',cross,true);await client.call('draft',cross,'POSITIVE PRIVATE DRAFT');await fixture('bindSends',cross);
  let record=(await client.call('initial')).sessions.find(s=>s.id===cross);
  const {identity}=require('../peer-handoffs.cjs'),stale=identity(record);
  const other=await connectService(dir,'independent-view');t.after(()=>other.close());await other.call('claim',cross,'chat');
  const beforeCount=(await fixture('stats',cross)).stats.sends;
  await assert.rejects(client.call('forward',cross,'No original controller proof',record.nativeId),e=>e.uiMessage?.key==='error.sharedInputOwnershipUnavailable');
  await assert.rejects(client.call('spaceAction','shared','forward',[cross,'STALE OWNER BODY',record.nativeId],{[cross]:stale}),e=>e.uiMessage?.key==='error.client.currentNativeSessionOrControlChanged');
  record=(await client.call('initial')).sessions.find(s=>s.id===cross);const proofNow=identity(record);
  for(const key of ['nativeId','owner','controlRevision','connectionRevision','memberRevision','peerRevision','backend']){
    const bad=structuredClone(proofNow);bad[key]=key==='backend'?{pid:12345,started:'wrong'}:typeof bad[key]==='number'?bad[key]+1:'wrong';
    await assert.rejects(client.call('spaceAction','shared','forward',[cross,'BAD PROOF BODY',record.nativeId],{[cross]:bad}));
  }
  assert.equal((await fixture('stats',cross)).stats.sends,beforeCount,'Every stale proof is refused before transport');
  await client.call('spaceAction','shared','forward',[cross,'EXPLICIT OTHER VIEW BODY',record.nativeId],{[cross]:proofNow});
  const after=(await client.call('initial')).sessions.find(s=>s.id===cross);assert.equal(after.owner,'independent-view');assert.equal(after.nativeId,record.nativeId);assert.equal(after.liveDraft,'POSITIVE PRIVATE DRAFT');assert.equal((await fixture('stats',cross)).stats.sends,beforeCount+1);
});

// 11-12: under load this test's own 10 s limit cancelled it before the daemon was ready; the cleanup
// skipped the forked daemon, whose IPC channel then kept the file's process, and the whole suite, alive.
test('the space protocol test above ends its forked daemon and exits after its own timeout', { skip: Boolean(process.env.NAW_TEST_MULTISPACE_TIMEOUT_MS), timeout: 60000 }, async t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-spaces-protocol-cleanup-')), pidFile = path.join(scratch, 'daemon.pid');
  // A fresh runner, as npm test starts it: without the parent's NODE_TEST_CONTEXT, which turns a nested run into a reporter child.
  const env = { ...process.env, NAW_TEST_MULTISPACE_TIMEOUT_MS: '1', NAW_TEST_MULTISPACE_PID_FILE: pidFile }; delete env.NODE_TEST_CONTEXT;
  const run = spawn(process.execPath, ['--test', '--test-timeout=0', __filename], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; run.stdout.on('data', chunk => { output += chunk; }); run.stderr.on('data', chunk => { output += chunk; });
  const living = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
  const daemon = () => { try { return Number(fs.readFileSync(pidFile, 'utf8')) || null; } catch { return null; } };
  t.after(() => {
    // Only what this check started: the run, and the daemon whose pid that run wrote.
    if (run.exitCode === null && run.signalCode === null) run.kill('SIGKILL');
    const pid = daemon(); if (pid && living(pid)) process.kill(pid, 'SIGKILL');
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  const ended = await Promise.race([once(run, 'exit').then(() => true), delay(20000).then(() => false)]);
  const pid = daemon();
  assert.ok(pid, `The run forked its daemon\n${output.slice(-2000)}`);
  assert.ok(ended, `The run must exit after its own timeout; still alive after 20 s, daemon ${living(pid) ? 'alive' : 'gone'}\n${output.slice(-2000)}`);
  assert.match(output, /timed out after 1ms/);
  assert.equal(run.exitCode, 1);
  assert.equal(living(pid), false, 'The forked daemon is gone once the run exits');
});
