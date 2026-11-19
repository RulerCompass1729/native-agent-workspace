const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { EventEmitter } = require('node:events');
const { Workspace } = require('../workspace.cjs'), { DshTui } = require('../dsh-tui.cjs');
const { TerminalJournal } = require('../observation.cjs'), { BackgroundControl } = require('../background-control.cjs');
const { RoomState } = require('../room-state.cjs'), { SessionLabels } = require('../session-labels.cjs');
const operation = require('../background-operation.cjs'), wake = require('../session-wake.cjs');
class SyntheticTerminal extends EventEmitter {
  constructor() { super(); this.alive = true; this.journal = new TerminalJournal(100, 30); this.writes = []; }
  input(data) { this.writes.push(data); }
  async stop() { this.alive = false; this.emit('closed', { confirmed: true }); }
}
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-dsh-identity-')), runtimes = [];
  const host = { binaries: {}, close() {}, create(record) {
    let runtime;
    if (record.provider === 'dsh') {
      runtime = new DshTui(record, host, { Terminal: SyntheticTerminal, key: () => { throw Error('No real key access'); }, egress: {}, witness: {} });
      runtime.start = async () => { runtime.attach(new SyntheticTerminal()); runtime.terminal.emit('started', process.pid); };
    } else { runtime = new EventEmitter(); runtime.start = async () => runtime.emit('state', 'idle'); runtime.stop = async () => ({}); }
    runtimes.push(runtime); return runtime;
  } };
  const workspace = new Workspace(host, dir); let controller;
  t.after(async () => { await controller?.close(); await Promise.all(runtimes.map(r => r.stop())); workspace.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const actorId = await workspace.create('claude', dir, 'owner', 'Tester'), id = await workspace.create('dsh', dir, 'owner', 'Synthetic terminal');
  const actor = { ...['id', 'nativeId', 'provider', 'name'].reduce((out, key) => ({ ...out, [key]: workspace.get(actorId)[key] }), {}) };
  const rooms = new RoomState(dir), labels = new SessionLabels(dir), client = { snapshot: () => workspace.snapshot(), close() {} };
  const context = { background: true, view: { selected: actor.id }, client, win: { destroy() {} }, checkActor: async () => {}, confirmationActors: () => workspace.snapshot().sessions };
  context.fingerprint = command => operation.controlFingerprint(command, { state: workspace.snapshot(), actor, context, roomState: rooms, sessionLabels: labels, client });
  wake.setPolicy(workspace, null, true);
  let now = Date.now();
  controller = new BackgroundControl({ dataDir: dir, now: () => now, context: async () => context,
    handlers: new Map([['input', (_c, target, data) => { const approved = operation.request().approved; return workspace.input(target, data, 'owner', { proof: approved.terminalConsent, expiresAt: approved.expiresAt }); }]]),
    confirmation: () => ({ message: 'Synthetic input', detail: 'Synthetic terminal only', buttons: ['Cancel', 'Confirm'], cancelId: 0 }), audit() {} });
  const runtime = workspace.runtimes.get(id), snapshot = () => workspace.snapshot().sessions.find(s => s.id === id);
  const ask = () => controller.call({ sender: actor, identity: { callId: 'call', turnId: 'turn' }, valid: () => true }, { action: 'invoke', operation_id: 'input-test', method: 'input', arguments: [id, '\x1b'] });
  return { workspace, controller, runtime, id, dir, actor, host, snapshot, ask, advance(ms) { now += ms; }, confirm(response = 1) { return controller.decide(actor.id, actor.nativeId, 'input-test', response); } };
}
test('started DSH terminal has an instance identity and a valid metadata-only proof', async t => {
  const f = await fixture(t), target = f.snapshot(), proof = operation.terminalInputProof(target);
  assert.match(target.nativeId, /^naw-dsh:[a-f0-9-]{36}$/); assert.equal(proof.nativeId, target.nativeId);
  assert.equal(operation.checkTerminalInput(proof, f.workspace.snapshot(), f.id).status, 'valid');
  assert.equal(target.nativeId, 'naw-dsh:' + f.runtime.terminal.journal.epoch);
});
test('person-confirmed DSH input uses the real controller and Workspace input boundary once', async t => {
  const f = await fixture(t), pending = await f.ask(); assert.equal(pending.state, 'confirmation-required');
  assert.ok(pending.terminalConsent); assert.equal(pending.terminalConsent.nativeId, f.snapshot().nativeId);
  const receipt = await f.confirm(); assert.equal(receipt.state, 'complete'); assert.deepEqual(f.runtime.terminal.writes, ['\x1b']);
  await assert.rejects(f.confirm()); assert.equal(f.runtime.terminal.writes.length, 1);
});
for (const kind of ['changed-id', 'new-terminal-with-reused-pid', 'output-frame', 'expired', 'rejected', 'closed']) test('old DSH card writes zero bytes after ' + kind, async t => {
  const f = await fixture(t); const pending = await f.ask(); assert.ok(pending.terminalConsent); const original = f.runtime.terminal;
  if (kind === 'changed-id') f.workspace.get(f.id).nativeId = 'naw-dsh:another';
  if (kind === 'new-terminal-with-reused-pid') { f.runtime.attach(new SyntheticTerminal()); f.runtime.terminal.emit('started', process.pid); }
  if (kind === 'output-frame') original.journal.append('data', 'synthetic frame', 100, 30, () => '');
  if (kind === 'expired') f.advance(120000);
  if (kind === 'closed') await original.stop();
  await f.confirm(kind === 'rejected' ? 0 : 1);
  assert.equal(original.writes.length + (f.runtime.terminal === original ? 0 : f.runtime.terminal.writes.length), 0);
});
test('checkpoint keeps active identity but reload retires it and cannot resume a new DSH as the old one', async t => {
  const f = await fixture(t), nativeId = f.snapshot().nativeId; assert.match(nativeId, /^naw-dsh:/);
  f.workspace.persist(); const stored = JSON.parse(fs.readFileSync(path.join(f.dir, 'workspace.json')));
  assert.equal(stored.sessions.find(s => s.id === f.id).nativeId, nativeId);
  const recovered = new Workspace(f.host, f.dir); t.after(() => recovered.close());
  assert.equal(recovered.get(f.id).nativeId, null); assert.equal(recovered.get(f.id).state, 'ended');
  const proof = operation.terminalInputProof(f.snapshot());
  assert.notEqual(operation.checkTerminalInput(proof, recovered.snapshot(), f.id).status, 'valid');
  await assert.rejects(recovered.resume(f.id, 'owner'), e => e.uiMessage?.key === 'error.workspace.cannotResume');
});
test('non-DSH creation identities remain unchanged', async t => {
  const f = await fixture(t); assert.match(f.workspace.get(f.actor.id).nativeId, /^[a-f0-9-]{36}$/);
  const codex = await f.workspace.create('codex', f.dir, 'owner', 'Synthetic Codex'); assert.equal(f.workspace.get(codex).nativeId, null);
});
test('null proof stays unknown even when the current DSH identity is valid', async t => {
  const f = await fixture(t); assert.ok(operation.terminalInputProof(f.snapshot()));
  assert.deepEqual(operation.checkTerminalInput(null, f.workspace.snapshot(), f.id), { status: 'unknown', reason: 'evidence-unavailable' });
  assert.throws(() => f.workspace.input(f.id, 'blocked', 'owner', { proof: null, expiresAt: Date.now() + 120000 })); assert.equal(f.runtime.terminal.writes.length, 0);
});
test('missing epoch or unconfirmed process start cannot mint an input identity', async t => {
  const f = await fixture(t), original = f.runtime.terminal, missing = new SyntheticTerminal(); missing.journal = null;
  f.runtime.attach(missing); missing.emit('started', process.pid); assert.equal(f.snapshot().nativeId, null); assert.equal(operation.terminalInputProof(f.snapshot()), null);
  const next = new SyntheticTerminal(); f.runtime.attach(next); assert.equal(f.snapshot().nativeId, null); next.emit('started', null);
  assert.equal(f.snapshot().nativeId, null); assert.equal(operation.terminalInputProof(f.snapshot()), null);
  original.emit('started', process.pid); assert.equal(f.snapshot().nativeId, null, 'old callback cannot name the new terminal');
});
test('late events from the previous terminal do not overwrite or clear the current identity', async t => {
  const f = await fixture(t), prior = f.runtime.terminal, next = new SyntheticTerminal(); f.runtime.attach(next); next.emit('started', process.pid);
  const id = f.snapshot().nativeId; assert.ok(id); assert.notEqual(id, 'naw-dsh:' + prior.journal.epoch);
  prior.emit('started', process.pid); prior.emit('closed', { confirmed: true }); assert.equal(f.snapshot().nativeId, id);
  assert.equal(operation.checkTerminalInput(operation.terminalInputProof(f.snapshot()), f.workspace.snapshot(), f.id).status, 'valid');
});
test('stopped and reloaded DSH stay non-resumable in the existing UI predicate', async t => {
  const f = await fixture(t); const vm = require('node:vm'), text = fs.readFileSync(require.resolve('../renderer/renderer.js'), 'utf8');
  const code = text.slice(text.indexOf('const canResume ='), text.indexOf('\nconst inputFocusAllowed', text.indexOf('const canResume =')));
  const canResume = vm.runInNewContext(code + '\ncanResume', { state: { capabilities: ['resume', 'nativePermissionDefaults'] } });
  assert.equal(Boolean(canResume(f.snapshot())), false); await f.runtime.terminal.stop();
  assert.equal(f.snapshot().nativeId, null); assert.equal(Boolean(canResume(f.snapshot())), false);
});
test('a checkpoint retains Claude and Codex identity behavior unchanged', async t => {
  const f = await fixture(t), claudeId = f.actor.nativeId, codex = await f.workspace.create('codex', f.dir, 'owner', 'Codex');
  f.workspace.get(codex).nativeId = 'synthetic-codex-id'; f.workspace.persist();
  const recovered = new Workspace(f.host, f.dir); t.after(() => recovered.close());
  assert.equal(recovered.get(f.actor.id).nativeId, claudeId); assert.equal(recovered.get(codex).nativeId, 'synthetic-codex-id');
});
test('proof and persisted identity contain metadata rather than terminal output', async t => {
  const f = await fixture(t); f.runtime.terminal.journal.append('data', 'SYNTHETIC_TERMINAL_BODY', 100, 30, () => '');
  const proof = operation.terminalInputProof(f.snapshot()); assert.ok(proof); assert.doesNotMatch(JSON.stringify(proof), /SYNTHETIC_TERMINAL_BODY/);
  f.workspace.persist(); assert.doesNotMatch(fs.readFileSync(path.join(f.dir, 'workspace.json'), 'utf8'), /SYNTHETIC_TERMINAL_BODY/);
});
test('a persisted input card cannot execute after workspace and controller reload', async t => {
  const f = await fixture(t); const pending = await f.ask(); assert.ok(pending.terminalConsent); f.workspace.persist(); await f.controller.close();
  const recovered = new Workspace(f.host, f.dir); let writes = 0;
  const rooms = new RoomState(f.dir), labels = new SessionLabels(f.dir), client = { snapshot: () => recovered.snapshot(), close() {} };
  const context = { background: true, view: {}, client, checkActor: async () => {}, confirmationActors: () => recovered.snapshot().sessions, win: { destroy() {} } };
  context.fingerprint = command => operation.controlFingerprint(command, { state: recovered.snapshot(), actor: f.actor, context, roomState: rooms, sessionLabels: labels, client });
  const controller = new BackgroundControl({ dataDir: f.dir, handlers: new Map([['input', () => { writes++; }]]), context: async () => context, confirmation() {}, audit() {} });
  try { await controller.decide(f.actor.id, f.actor.nativeId, pending.id, 1); assert.equal(writes, 0); assert.equal(recovered.runtimes.size, 0); }
  finally { await controller.close(); recovered.close(); }
});
test('a new live DSH identity does not upgrade a legacy card whose proof was null', async t => {
  const f = await fixture(t); await f.ask(); assert.ok(f.snapshot().nativeId);
  f.controller.commit(data => { data.records[0].terminalConsent = null; }); const result = await f.confirm();
  assert.equal(f.runtime.terminal.writes.length, 0); assert.equal(result.state, 'confirmation-required'); assert.equal(result.reason, 'evidence-unavailable');
});
