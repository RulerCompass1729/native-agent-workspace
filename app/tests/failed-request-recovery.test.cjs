const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events'), { randomUUID } = require('node:crypto');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Workspace } = require('../workspace.cjs'), { Claude } = require('../adapters.cjs');

// Independent-review counterexample: real adapter/channel event order, without
// a CLI/model. Native completion can beat both the ACK and settings state.
for (const boundary of ['none', 'permission', 'gap', 'private-input'])
test(`failed-request recovery completes before ACK; boundary=${boundary}`, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'request-recovery-')); let runtime;
  const workspace = new Workspace({ binaries: {}, close() {}, create(session) {
    runtime = new Claude(session, null, { attachOnly: true }); runtime.terminal = { alive: true };
    runtime.start = async () => {
      runtime.ready = true; runtime.bindRoot({ sessionId: session.nativeId, nativeBlocks: true });
      runtime.emit('state', 'idle');
    };
    return runtime;
  } }, dir);
  t.after(() => { runtime.submission.close(); workspace.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const id = await workspace.create('claude', dir, 'owner', 'Claude'); workspace.join(id, true);
  const a = randomUUID(), b = randomUUID(); let sequence = 0;
  const event = fields => runtime.observeBlock({ block: true, sessionId: runtime.record.nativeId,
    lease: runtime.rootLease, epoch: runtime.observationEpoch, sequence: ++sequence, ...fields });
  const hook = fields => runtime.hook({ session_id: runtime.record.nativeId, ...fields });
  runtime.lastPromptId = a;
  event({ id: 'control:turn-start', kind: 'control', turnId: 'A', promptId: a, status: 'running' });
  hook({ hook_event_name: 'StopFailure', prompt_id: a });
  event({ id: 'turn:A', kind: 'turn', turnId: 'A', status: 'failed', failedRequest: true, text: 'failure A' });
  let packet;
  const response = new EventEmitter();
  response.end = body => { packet = JSON.parse(body); response.emit('close'); };
  runtime.submission.receive(response);
  const sending = workspace.forward(id, 'new B', 'owner');
  assert.ok(packet); assert.equal(runtime.submission.authorize(packet), true);
  hook({ hook_event_name: 'UserPromptSubmit', prompt_id: b, prompt: 'new B' });
  event({ id: 'control:turn-start', kind: 'control', turnId: 'B', promptId: b, status: 'running' });
  event({ id: 'display:B', kind: 'response', turnId: 'B', promptId: b, index: 0, delta: 'good reply', status: 'complete' });
  event({ id: 'turn:B', kind: 'turn', turnId: 'B', status: 'complete', finalDisplayId: 'display:B', text: 'done B' });
  assert.equal(runtime.rootTurn.status, null); assert.equal(runtime.rootTurn.completed, true);
  assert.equal(workspace.get(id).state, 'error', 'Do not fabricate idle/working before native acceptance');
  hook({ hook_event_name: 'Stop', prompt_id: b, last_assistant_message: 'unused raw text', stop_hook_active: false });
  if (boundary === 'permission') event({ id: 'control:permission', kind: 'control', status: 'complete' });
  if (boundary === 'private-input') event({ id: 'control:input', kind: 'control', status: 'complete' });
  if (boundary === 'gap') runtime.observeRootGap({ sessionId: runtime.record.nativeId, lease: runtime.rootLease, epoch: runtime.observationEpoch });
  runtime.submission.result({ id: packet.id, status: 'accepted', promptId: b, turnId: 'B' }); await sending;
  const row = workspace.room.messages.find(m => m.role === 'assistant');
  if (boundary === 'none') {
    assert.equal(row?.text, 'good reply'); assert.equal(row.finalReply, true);
    assert.equal(workspace.room.messages.find(m => m.id === packet.id).status, 'submitted');
  } else assert.ok(!row?.finalReply);
  assert.equal(workspace.versions.dispatches, 1);
});
