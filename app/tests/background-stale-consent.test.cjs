const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { BackgroundControl, dialog } = require('../background-control.cjs');
const operation = require('../background-operation.cjs');
const { Workspace } = require('../workspace.cjs');
const { EventEmitter } = require('node:events');
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-stale-consent-')); fs.chmodSync(dir, 0o700);
  let clock = 1800000000000, archived = false, disconnected = false;
  const bytes = [], runtimes = new Map();
  const host = { binaries: {}, close() {}, create(record) {
    const runtime = new EventEmitter(); runtime.terminal = { alive: true, journal: { epoch: 'epoch-' + record.id, index: 1 }, input: data => bytes.push(data) };
    runtime.start = async () => runtime.emit('state', 'idle'); runtime.stop = async () => ({ state: 'ended' });
    runtimes.set(record.id, runtime); return runtime;
  } };
  const w = new Workspace(host, dir), id = await w.create('claude', dir, 'owner', 'Requester');
  const target = await w.create('claude', dir, 'owner', 'Target');
  const actor = { id, nativeId: w.get(id).nativeId, provider: 'claude', name: 'Requester' };
  let missing = false;
  const snapshot = () => ({ ...w.snapshot(), sessions: w.snapshot().sessions.filter(s => !missing || s.id !== target).map(s => ({ ...s,
    archived: s.id === target && archived, transportDisconnected: s.id === target && disconnected, nativeTerminalDialog: runtimes.get(s.id).nativeTerminalDialog,
    terminalState: { ...s.terminalState, observationIndex: runtimes.get(s.id).terminal.journal.index },
  })) });
  const client = { snapshot, close() {} };
  const rooms = { apply: x => x, value: { sessionArchives: {} }, metadata: () => ({ restoreMembers: [], restorePlacements: {} }) };
  const c = { background: true, actor, client, view: {}, win: { destroy() {} }, checkActor: async () => {}, refresh: async () => {}, confirmationActors: () => snapshot().sessions,
    terminalConsentSnapshot: snapshot };
  const source = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8');
  const first = source.indexOf('      context.fingerprint = command =>'), end = source.indexOf('\n      context.delivery =', first);
  const scope = vm.createContext({ context: c, client, actor, roomState: rooms, roomIds: s => s.roomIds || [], backgroundOperation: operation, sessionLabels: { apply: value => value, value: { labels: {} } } });
  vm.runInContext(source.slice(first, end), scope);
  const handlers = new Map([['input', async (context, targetId, data) => {
    const approved = operation.request()?.approved;
    return w.input(targetId, data, 'owner', approved ? { proof: approved.terminalConsent, expiresAt: approved.expiresAt } : null);
  }]]);
  let controller;
  handlers.set('backgroundWithdraw', (context, operationId) => controller.withdraw(context.actor, operationId, context));
  const config = { dataDir: dir, handlers, context: async () => c, now: () => clock, audit() {}, confirmation: () => ({ message: 'Send input?', buttons: ['Cancel', 'Confirm'], cancelId: 0 }) };
  controller = new BackgroundControl(config);
  t.after(async () => { await controller.close(); w.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  let seq = 0;
  const ask = (method = 'input', args = [target, '\x1b'], sender = actor) => controller.call({ sender, identity: { turnId: 'turn', callId: 'call-' + (++seq) }, valid: () => true }, { action: 'invoke', method, arguments: args, operation_id: 'request-' + seq });
  const confirm = row => controller.decide(actor.id, actor.nativeId, row.id, 1);
  return { dir, w, target, actor, c, config, controller, handlers, ask, confirm, bytes, runtimes, setClock: value => { clock = value; }, clock: () => clock,
    archive: () => { archived = true; }, disconnect: value => { disconnected = value; }, remove: () => { missing = true; } };
}
test('old Esc card cannot write into a member that has started work', async t => {
  const f = await fixture(t), card = await f.ask(); assert.equal(card.state, 'confirmation-required');
  f.w.get(f.target).state = 'working';
  const result = await f.confirm(card);
  assert.deepEqual(f.bytes, [], 'stale Esc must reach no terminal');
  assert.equal(result.disposition, 'invalidated'); assert.equal(result.reason, 'target-working');
  const reopened = new BackgroundControl(f.config);
  try { assert.equal(reopened.receipt(f.actor, card.id).disposition, 'invalidated'); } finally { await reopened.close(); }
});
test('same-title replacement dialog is a different instance', async t => {
  const f = await fixture(t), runtime = f.runtimes.get(f.target);
  runtime.nativeTerminalDialog = { kind: 'choice', title: 'Synthetic choice?', since: 1 };
  const card = await f.ask(); runtime.nativeTerminalDialog = { ...runtime.nativeTerminalDialog, since: 2 };
  f.runtimes.get(f.target).terminal.journal.index++;
  const result = await f.confirm(card); assert.deepEqual(f.bytes, []); assert.equal(result.disposition, 'invalidated');
});
test('valid card executes once, and an uncertain observation never writes', async t => {
  const f = await fixture(t), card = await f.ask();
  const accepted = await f.confirm(card); assert.equal(accepted.state, 'complete', accepted.error); assert.deepEqual(f.bytes, ['\x1b']);
  await assert.rejects(f.confirm(card)); assert.equal(f.bytes.length, 1);
  const pending = await f.ask(); f.disconnect(true);
  const unknown = await f.confirm(pending);
  assert.equal(unknown.state, 'confirmation-required'); assert.equal(unknown.reason, 'temporarily-unavailable'); assert.equal(f.bytes.length, 1);
});
for (const change of ['archive', 'remove']) test(`authoritative target ${change} invalidates without input`, async t => {
  const f = await fixture(t), card = await f.ask(); f[change]();
  assert.equal((await f.confirm(card)).disposition, 'invalidated'); assert.deepEqual(f.bytes, []);
});
test('input TTL expires inclusively at two minutes, persists, and leaves pending counts', async t => {
  const f = await fixture(t), card = await f.ask(); f.setClock(f.clock() + 120000);
  const expired = await f.confirm(card);
  assert.deepEqual(f.bytes, [], 'at the exact deadline the old card cannot execute');
  assert.equal(expired.disposition, 'expired'); assert.equal(f.controller.pending().length, 0);
  const reopened = new BackgroundControl(f.config);
  try { assert.equal(reopened.receipt(f.actor, card.id).disposition, 'expired'); assert.equal(reopened.pending().length, 0); }
  finally { await reopened.close(); }
});
test('originator can withdraw only its own pending card; state survives restart', async t => {
  const f = await fixture(t), card = await f.ask();
  const stranger = { ...f.actor, id: 'stranger', nativeId: 'stranger-native' };
  const refused = await f.ask('backgroundWithdraw', [card.id], stranger);
  assert.notEqual(refused.state, 'complete'); assert.equal(f.controller.receipt(f.actor, card.id).state, 'confirmation-required');
  const withdrawn = await f.ask('backgroundWithdraw', [card.id]); assert.equal(withdrawn.state, 'complete');
  assert.equal(f.controller.receipt(f.actor, card.id).disposition, 'withdrawn'); assert.equal(f.controller.pending().length, 0); assert.deepEqual(f.bytes, []);
  const reopened = new BackgroundControl(f.config);
  try { assert.equal(reopened.receipt(f.actor, card.id).disposition, 'withdrawn'); }
  finally { await reopened.close(); }
});

for (const field of ['nativeId', 'connectionRevision', 'controlRevision']) test(`changed ${field} invalidates an input card`, async t => {
  const f = await fixture(t), card = await f.ask(), target = f.w.get(f.target);
  target[field] = field === 'nativeId' ? 'replacement-native' : (target[field] || 0) + 1;
  assert.equal((await f.confirm(card)).disposition, 'invalidated'); assert.deepEqual(f.bytes, []);
});
test('expiry during identity refresh prevents execution at the final handler boundary', async t => {
  const f = await fixture(t), card = await f.ask(); let checks = 0;
  f.c.checkActor = async () => { if (++checks === 2) f.setClock(card.at + 120000); };
  assert.equal((await f.confirm(card)).disposition, 'expired'); assert.deepEqual(f.bytes, []);
});
test('last native input boundary rejects changed state after human decide checked it', async t => {
  const f = await fixture(t), card = await f.ask(), original = f.handlers.get('input');
  f.handlers.set('input', (...args) => { f.w.get(f.target).state = 'working'; return original(...args); });
  assert.equal((await f.confirm(card)).disposition, 'invalidated'); assert.deepEqual(f.bytes, []);
});
test('other confirmation classes expire at ten minutes and old pending records expire on load', async t => {
  const f = await fixture(t); f.handlers.set('rename', async c => dialog(c, 'message', { buttons: ['Cancel', 'Confirm'], cancelId: 0 }));
  const card = await f.ask('rename', [f.target, 'Renamed']); assert.equal(card.state, 'confirmation-required', JSON.stringify(card));
  f.setClock(card.at + 599999); assert.equal(f.controller.pending().length, 1);
  await f.controller.close(); f.setClock(card.at + 600000);
  const reopened = new BackgroundControl(f.config);
  try { assert.equal(reopened.receipt(f.actor, card.id).disposition, 'expired'); assert.equal(reopened.pending().length, 0); }
  finally { await reopened.close(); }
});
test('expiration while the actor is reserved leaves pending count and gray rows immediately', { timeout: 5000 }, async t => {
  const f = await fixture(t), card = await f.ask(); let release, entered;
  const ready = new Promise(r => { entered = r; }), held = f.controller.exclusive(f.actor, () => { entered(); return new Promise(r => { release = r; }); });
  try { await ready; f.setClock(card.at + 120000);
    assert.equal(f.controller.pending().length, 0);
    assert.equal(f.controller.rows(f.actor.id)[0].backgroundOperation.disposition, 'expired');
  } finally { release(); await held; }
  assert.equal(f.controller.receipt(f.actor, card.id).disposition, 'expired');
});
test('withdraw and confirmation share the same exclusive actor boundary', async t => {
  const f = await fixture(t), card = await f.ask(); let enter, release;
  const ready = new Promise(r => { enter = r; });
  let checks = 0; f.c.checkActor = async () => { if (++checks === 1) { enter(); await new Promise(r => { release = r; }); } };
  const confirming = f.confirm(card); await ready;
  const competing = await f.ask('backgroundWithdraw', [card.id]);
  assert.notEqual(competing.state, 'complete');
  f.c.checkActor = async () => {}; release();
  assert.equal((await confirming).state, 'complete'); assert.deepEqual(f.bytes, ['\x1b']);
});
test('legacy pending input without observation proof stays unverifiable and never writes', async t => {
  const f = await fixture(t), card = await f.ask();
  f.controller.commit(d => { delete d.records.find(r => r.id === card.id).terminalConsent; });
  const result = await f.confirm(card); assert.equal(result.reason, 'evidence-unavailable');
  assert.equal(result.state, 'confirmation-required'); assert.deepEqual(f.bytes, []);
});

test('one expiry timer settles an untouched pending card without a click or poll', async t => {
  const f = await fixture(t), card = await f.ask(), start = Date.now();
  f.controller.now = () => card.at + 119980 + Date.now() - start; f.controller.scheduleExpiry();
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(f.controller.receipt(f.actor, card.id).disposition, 'expired'); assert.deepEqual(f.bytes, []);
});
test('expired cards release the originator quota for a new confirmation', async t => {
  const f = await fixture(t), card = await f.ask();
  f.controller.commit(d => { const row = d.records[0]; d.records = Array.from({ length: 32 }, (_, n) => ({ ...structuredClone(row), id: 'old-' + n })); });
  assert.equal((await f.ask()).reason, 'confirmation-limit');
  f.setClock(card.at + 120000);
  assert.equal((await f.ask()).state, 'confirmation-required'); assert.equal(f.controller.pending().length, 1); assert.deepEqual(f.bytes, []);
});

test('unchanged native approval within an active turn accepts once; resumed same turn refuses', async t => {
  const f = await fixture(t), runtime = f.runtimes.get(f.target);
  runtime.turnId = 'still-same-turn'; runtime.nativeApproval = { requests: [{ id: 'approve-1', type: 'choice' }] };
  f.w.get(f.target).state = 'approval';
  const card = await f.ask(); assert.equal((await f.confirm(card)).state, 'complete'); assert.deepEqual(f.bytes, ['\x1b']);
  const next = await f.ask(); runtime.nativeApproval = null; f.w.get(f.target).state = 'working';
  assert.equal((await f.confirm(next)).disposition, 'invalidated'); assert.equal(f.bytes.length, 1);
});
for (const disposition of ['expired', 'withdrawn']) test(`follow-up ${disposition} preserves uncertainty about earlier executed steps`, async t => {
  const f = await fixture(t); let writes = 0;
  f.handlers.set('rename', async c => {
    writes++;
    await dialog(c, 'message', { buttons: ['Cancel', 'Second confirm'], cancelId: 0 });
    writes++;
  });
  const card = await f.ask('rename', [f.target, 'Renamed']);
  const followup = await f.confirm(card); assert.equal(followup.state, 'confirmation-required'); assert.equal(writes, 1);
  if (disposition === 'expired') { f.setClock(card.at + 600000); f.controller.expirePending(); }
  else assert.equal((await f.ask('backgroundWithdraw', [card.id])).state, 'complete');
  const saved = f.controller.receipt(f.actor, card.id);
  assert.equal(saved.disposition, disposition); assert.equal(saved.state, 'unconfirmed');
  assert.equal(saved.resultNotice.key, 'background.card.reason.partial-operation'); assert.equal(writes, 1);
  assert.match(f.controller.rows(f.actor.id).find(r => r.backgroundOperation.id === card.id).text, /后续未执行/);
});

test('native conditional write also rejects the exact deadline before any terminal side effect', async t => {
  const f = await fixture(t), proof = operation.terminalInputProof(f.w.snapshot().sessions.find(s => s.id === f.target));
  const before = f.w.get(f.target).controlRevision || 0;
  assert.throws(() => f.w.input(f.target, '\x1b', 'owner', { proof, expiresAt: Date.now() }), e => e.uiMessage?.key === 'error.background.confirmationExpired');
  assert.deepEqual(f.bytes, []); assert.equal(f.w.get(f.target).controlRevision || 0, before);
});
