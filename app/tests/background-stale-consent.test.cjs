const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { BackgroundControl, dialog } = require('../background-control.cjs');
const operation = require('../background-operation.cjs');
const { Workspace } = require('../workspace.cjs');
const { EventEmitter } = require('node:events');
const { TerminalJournal } = require('../observation.cjs');
async function fixture(t, { realDetector = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-stale-consent-')); fs.chmodSync(dir, 0o700);
  let clock = 1800000000000, archived = false, disconnected = false;
  const bytes = [], runtimes = new Map();
  const host = { binaries: {}, close() {}, create(record) {
    const runtime = new EventEmitter(), journal = new TerminalJournal(100, 30);
    journal.append('output', 'Synthetic terminal', 100, 30, () => 'Synthetic terminal');
    runtime.terminal = { alive: true, journal, cols: 100, rows: 30, input: data => bytes.push(data), resize(cols, rows) {
      if (cols === this.cols && rows === this.rows) return;
      this.cols = cols; this.rows = rows; journal.append('resize', '', cols, rows, () => 'Synthetic terminal');
    } };
    if (realDetector) {
      const screen = new (require('@xterm/headless').Terminal)({ cols: 100, rows: 30, allowProposedApi: true });
      runtime.terminal.screen = screen; t.after(() => screen.dispose());
    }
    runtime.start = async () => runtime.emit('state', 'idle'); runtime.stop = async () => ({ state: 'ended' });
    runtimes.set(record.id, runtime); return runtime;
  } };
  const w = new Workspace(host, dir), id = await w.create('claude', dir, 'owner', 'Requester');
  const target = await w.create('claude', dir, 'owner', 'Target');
  // Both the desktop projection and Workspace.input's final conditional write
  // must observe the same synthetic dialog, including on the pre-detector base.
  const nativeSnapshot = w.snapshot.bind(w);
  if (!realDetector) w.snapshot = () => {
    const value = nativeSnapshot();
    return { ...value, sessions: value.sessions.map(s => ({ ...s, nativeTerminalDialog: runtimes.get(s.id)?.nativeTerminalDialog })) };
  };
  const actor = { id, nativeId: w.get(id).nativeId, provider: 'claude', name: 'Requester' };
  let missing = false;
  const snapshot = () => ({ ...w.snapshot(), sessions: w.snapshot().sessions.filter(s => !missing || s.id !== target).map(s => ({ ...s,
    archived: s.id === target && archived, transportDisconnected: s.id === target && disconnected,
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
  // A test longer than 150 ms starts a timed workspace checkpoint; wait for it to stop writing before removing the folder.
  t.after(async () => { await controller.close(); await w.close(); fs.rmSync(dir, { recursive: true, force: true }); });
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
  runtime.nativeTerminalDialog = { kind: 'choice', title: 'Synthetic choice?', since: 1, revision: 0 };
  const card = await f.ask(); runtime.nativeTerminalDialog = { ...runtime.nativeTerminalDialog, since: 2 };
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


// F1/F2: both the desktop and native conditional-write snapshot must see the dialog.
for (const change of ['none', 'output-1', 'output-5', 'resize']) test(`screen-only dialog after ${change}: changed frame needs a new card, then one Esc`, async t => {
  const f = await fixture(t), runtime = f.runtimes.get(f.target);
  runtime.nativeTerminalDialog = { kind: 'choice', title: 'Synthetic choice?', since: 1, revision: 0 };
  const card = await f.ask(), index = runtime.terminal.journal.index;
  assert.deepEqual(operation.terminalInputProof(f.w.snapshot().sessions.find(s => s.id === f.target)), card.terminalConsent,
    'The daemon and desktop agree before any redraw');
  const count = change === 'output-1' ? 1 : change === 'output-5' ? 5 : 0;
  for (let i = 0; i < count; i++) runtime.terminal.journal.append('output', 'Synthetic redraw', runtime.terminal.cols, runtime.terminal.rows, () => 'Synthetic redraw');
  if (change === 'resize') f.w.resize(f.target, 'owner', 80, 24);
  assert.equal(runtime.terminal.journal.index, index + (count || (change === 'resize' ? 1 : 0)));
  const result = await f.confirm(card);
  let accepted = card;
  if (change === 'none') assert.equal(result.state, 'complete', result.error || result.reason);
  else {
    assert.equal(result.disposition, 'invalidated'); assert.deepEqual(f.bytes, []);
    accepted = await f.ask(); assert.equal((await f.confirm(accepted)).state, 'complete');
  }
  assert.deepEqual(f.bytes, ['\x1b']);
  await assert.rejects(f.confirm(accepted)); assert.deepEqual(f.bytes, ['\x1b']);
});
test('same-title new dialog at the same observation index rejects solely by its instance', async t => {
  const f = await fixture(t), runtime = f.runtimes.get(f.target);
  runtime.nativeTerminalDialog = { kind: 'choice', title: 'Synthetic choice?', since: 1, revision: 0 };
  const card = await f.ask(), index = runtime.terminal.journal.index;
  runtime.nativeTerminalDialog = { ...runtime.nativeTerminalDialog, since: 2 };
  assert.deepEqual(f.w.snapshot().sessions.find(s => s.id === f.target).nativeTerminalDialog,
    f.c.terminalConsentSnapshot().sessions.find(s => s.id === f.target).nativeTerminalDialog, 'Both sides see the replacement instance');
  assert.equal(runtime.terminal.journal.index, index, 'A frame bump cannot make this test pass');
  const result = await f.confirm(card);
  assert.equal(result.disposition, 'invalidated'); assert.equal(result.reason, 'state-changed');
  assert.deepEqual(f.bytes, []);
});
for (const change of ['output', 'resize']) test(`without a dialog ${change} still invalidates the input card`, async t => {
  const f = await fixture(t), runtime = f.runtimes.get(f.target), card = await f.ask();
  if (change === 'resize') f.w.resize(f.target, 'owner', 80, 24);
  else runtime.terminal.journal.append('output', 'Synthetic redraw', 100, 30, () => 'Synthetic redraw');
  const result = await f.confirm(card);
  assert.equal(result.disposition, 'invalidated'); assert.deepEqual(f.bytes, []);
});

// PF12 uses the real cooked-screen detector in BOTH Workspace snapshots,
// through confirmation and the last conditional write. No dialog is injected.
function statusDialog({ title = 'Switch model?', body = 'Only change the synthetic model.',
  options = ['Use model-x', 'Keep current'], selected = 0, setting = 'Effort: High', status = '.', wrapped = false } = {}) {
  return '\x1b[2J\x1b[H' + [title, body, ...options.map((text, i) => `${i === selected ? '❯' : ' '} ${i + 1}. ${text}`), setting,
    wrapped ? 'Press enter to\r\nconfirm or esc to cancel' : 'Press enter to confirm or esc to cancel', status].join('\r\n');
}
async function statusFixture(t, initial = {}) {
  const f = await fixture(t, { realDetector: true }), runtime = f.runtimes.get(f.target);
  f.draw = async text => {
    await new Promise(resolve => runtime.terminal.screen.write(text, resolve));
    runtime.terminal.journal.append('output', text, 100, 30, () => text);
    return f.w.snapshot().sessions.find(s => s.id === f.target);
  };
  await f.draw(statusDialog(initial));
  return { ...f, runtime, current: () => f.w.snapshot().sessions.find(s => s.id === f.target) };
}
// PF11: one PTY output batch may contain a dismissal followed by an
// indistinguishable new choice. Exercise both approval gates, not a hand-made proof.
for (const [label, data] of [['Enter', '\r'], ['option key', '1'], ['Escape', '\x1b']]) {
  test(`PF11: a coalesced dismissal and identical replacement rejects old ${label} with zero bytes`, async t => {
    const f = await statusFixture(t), before = f.current();
    const card = await f.ask('input', [f.target, data]);
    assert.equal(card.state, 'confirmation-required');
    await f.draw('\x1b[2J\x1b[Hworking...\r\n' + statusDialog());
    const after = f.current();
    assert.deepEqual(after.nativeTerminalDialog, before.nativeTerminalDialog,
      'The cooked-screen identity alone cannot distinguish the replacement');
    assert.equal(after.terminalState.observationIndex, before.terminalState.observationIndex + 1,
      'Both native screens arrived in one output observation');
    const result = await f.confirm(card);
    assert.equal(result.disposition, 'invalidated'); assert.equal(result.state, 'not-executed');
    assert.deepEqual(f.bytes, [], 'No old-card bytes may reach the replacement instance');
  });
}
test('PF11 control: an observed disappearance before identical reopening rejects the old card', async t => {
  const f = await statusFixture(t), before = f.current(), card = await f.ask('input', [f.target, '\r']);
  await f.draw('\x1b[2J\x1b[Hworking...'); assert.equal(f.current().nativeTerminalDialog, null);
  await f.draw(statusDialog()); assert.notEqual(f.current().nativeTerminalDialog.since, before.nativeTerminalDialog.since);
  assert.equal((await f.confirm(card)).disposition, 'invalidated'); assert.deepEqual(f.bytes, []);
});
test('PF11 control: a new native approval request refuses an otherwise identical dialog', async t => {
  const f = await statusFixture(t);
  f.runtime.nativeApproval = { nativeOnly: true, requests: [{ id: 'approval-a', title: 'Synthetic approval' }] };
  const card = await f.ask('input', [f.target, '\r']), frame = f.current().terminalState.observationIndex;
  f.runtime.nativeApproval = { nativeOnly: true, requests: [{ id: 'approval-b', title: 'Synthetic approval' }] };
  assert.equal(f.current().terminalState.observationIndex, frame, 'A frame change cannot hide loss of the request-ID gate');
  assert.equal((await f.confirm(card)).disposition, 'invalidated'); assert.deepEqual(f.bytes, []);
});
test('PF11: an unchanged unrelated request ID cannot vouch for a replaced local TUI choice', async t => {
  const f = await statusFixture(t);
  f.runtime.nativeApproval = { nativeOnly: true, requests: [{ id: 'stable-tool-request', title: 'Synthetic tool approval' }] };
  const card = await f.ask('input', [f.target, '\r']);
  await f.draw('\x1b[2J\x1b[Hworking...\r\n' + statusDialog());
  assert.equal((await f.confirm(card)).disposition, 'invalidated'); assert.deepEqual(f.bytes, []);
});
for (const wrapped of [false, true]) for (const data of ['\x1b', '\r', '2']) test(`PF11 fallback: status below ${wrapped ? 'wrapped' : 'single-line'} legend preserves the detector but requires a fresh ${JSON.stringify(data)} card`, async t => {
  const f = await statusFixture(t, { wrapped }), before = f.current();
  assert.ok(before.nativeTerminalDialog, 'The original screen must be a detected dialog');
  const card = await f.ask('input', [f.target, data]); assert.equal(card.state, 'confirmation-required');
  await f.draw(statusDialog({ status: '..', wrapped }));
  const after = f.current(); assert.ok(after.nativeTerminalDialog, 'The repaint must still be detected');
  assert.notEqual(after.terminalState.observationIndex, before.terminalState.observationIndex);
  const result = await f.confirm(card);
  assert.equal(result.disposition, 'invalidated'); assert.deepEqual(f.bytes, []);
  assert.deepEqual(after.nativeTerminalDialog, before.nativeTerminalDialog, 'Status does not change the observed episode or revision');
  const fresh = await f.ask('input', [f.target, data]); assert.equal((await f.confirm(fresh)).state, 'complete');
  await assert.rejects(f.confirm(fresh)); assert.deepEqual(f.bytes, [data], 'Only the fresh card writes, exactly once');
});
test('PF11 fallback: a legend rewrapped during status repaint requires a new card', async t => {
  const f = await statusFixture(t), before = f.current(), card = await f.ask();
  await f.draw(statusDialog({ status: '..', wrapped: true }));
  const result = await f.confirm(card);
  assert.equal(result.disposition, 'invalidated'); assert.deepEqual(f.bytes, []);
  assert.deepEqual(f.current().nativeTerminalDialog, before.nativeTerminalDialog);
});

const statusChanges = [
  ['question', f => f.draw(statusDialog({ title: 'Choose a provider?', status: '..' }))],
  ['option', f => f.draw(statusDialog({ options: ['Use model-y', 'Keep current'], status: '..' }))],
  ['highlight', f => f.draw(statusDialog({ selected: 1, status: '..' }))],
  ['body', f => f.draw(statusDialog({ body: 'Also change the synthetic directory.', status: '..' }))],
  ['wrapped option detail', f => f.draw(statusDialog({ options: ['Use model-x', 'Keep current\r\n     Change synthetic directory'], status: '..' }))],
  ['setting after options', f => f.draw(statusDialog({ setting: 'Effort: Low', status: '..' }))],
  ['approval body', f => { f.runtime.nativeApproval = { requests: [{ id: 'same-request', title: 'Approve local action B' }] }; }],
  ['dialog replacement', async f => { await f.draw('\x1b[2J\x1b[Hworking'); await f.draw(statusDialog({ status: '..' })); }],
  ['selection away and back', async f => { await f.draw(statusDialog({ selected: 1 })); await f.draw(statusDialog({ status: '..' })); }],
  ['unrecognized trailing status', f => f.draw(statusDialog({ status: 'unrecognized trailing text' }))],
  ['epoch', f => { f.runtime.terminal.journal.epoch = 'replacement-epoch'; }],
];
for (const [change, mutate] of statusChanges) test(`PF12 real detector: ${change} still invalidates without a terminal byte`, async t => {
  const f = await statusFixture(t);
  if (change === 'approval body') f.runtime.nativeApproval = { requests: [{ id: 'same-request', title: 'Approve local action A' }] };
  assert.ok(f.current().nativeTerminalDialog);
  const card = await f.ask(); assert.equal(card.state, 'confirmation-required');
  await mutate(f);
  const result = await f.confirm(card);
  assert.equal(result.disposition, 'invalidated'); assert.deepEqual(f.bytes, []);
});
test('PF12 real detector: output without a dialog still invalidates the strict frame proof without bytes', async t => {
  const f = await statusFixture(t); await f.draw('\x1b[2J\x1b[Hplain output');
  assert.equal(f.current().nativeTerminalDialog, null);
  const card = await f.ask(); assert.equal(card.state, 'confirmation-required');
  await f.draw('\x1b[2J\x1b[Hmore output');
  assert.equal((await f.confirm(card)).disposition, 'invalidated'); assert.deepEqual(f.bytes, []);
});
test('PF12 real detector: option change after confirmation checks is refused at the last native input boundary', async t => {
  const f = await statusFixture(t), card = await f.ask(), original = f.handlers.get('input');
  f.handlers.set('input', async (...args) => {
    await f.draw(statusDialog({ options: ['Use model-y', 'Keep current'], status: '..' }));
    return original(...args);
  });
  assert.equal((await f.confirm(card)).disposition, 'invalidated'); assert.deepEqual(f.bytes, []);
});
test('PF12 real detector: shortcut text inside options cannot truncate the option signature', async t => {
  const f = await statusFixture(t);
  const ambiguous = model => `\x1b[2J\x1b[HSwitch model?\r\n❯ 1. Use ${model}; Enter to confirm\r\n  2. No; Esc to cancel\r\n.`;
  await f.draw(ambiguous('model-x')); assert.ok(f.current().nativeTerminalDialog);
  const card = await f.ask(); assert.equal(card.state, 'confirmation-required');
  await f.draw(ambiguous('model-y'));
  assert.equal((await f.confirm(card)).disposition, 'invalidated'); assert.deepEqual(f.bytes, []);
});

test('PF12 BLOCK: indented shortcut continuation is not an independent legend', async t => {
  const f = await statusFixture(t);
  const frame = folder => '\x1b[2J\x1b[HChoose working directory?\r\n  1. Cancel\r\n❯ 2. Open directory\r\n     Press Enter to confirm or Esc to cancel\r\n     ' + folder;
  await f.draw(frame('.')); assert.ok(f.current().nativeTerminalDialog);
  const card = await f.ask('input', [f.target, '\r']);
  await f.draw(frame('..'));
  const result = await f.confirm(card);
  assert.deepEqual(f.bytes, [], 'An indented option continuation cannot authorize dropping later content');
  assert.equal(result.disposition, 'invalidated');
});
test('PF12 BLOCK: a candidate legend must contain its own complete key instructions', async t => {
  const f = await statusFixture(t);
  const frame = folder => '\x1b[2J\x1b[HChoose working directory?\r\n  1. Cancel\r\n❯ 2. Open directory; Enter to confirm\r\nEnter folder; Esc to cancel\r\n' + folder;
  await f.draw(frame('.')); assert.ok(f.current().nativeTerminalDialog);
  const card = await f.ask('input', [f.target, '\r']); await f.draw(frame('..'));
  const result = await f.confirm(card);
  assert.deepEqual(f.bytes, []); assert.equal(result.disposition, 'invalidated');
});
test('PF11 fallback: bordered legend status repaint keeps its episode but revokes the old card', async t => {
  const f = await statusFixture(t);
  const frame = status => '\x1b[2J\x1b[H' + statusDialog({ status }).replace(/^\x1b\[2J\x1b\[H/, '').split('\r\n').map(line => '│ ' + line + ' │').join('\r\n');
  await f.draw(frame('.')); const before = f.current().nativeTerminalDialog; assert.ok(before);
  const card = await f.ask('input', [f.target, '\r']); await f.draw(frame('..'));
  assert.equal((await f.confirm(card)).disposition, 'invalidated'); assert.deepEqual(f.bytes, []);
  assert.deepEqual(f.current().nativeTerminalDialog, before);
});


test('PF12 BLOCK: a dot-only wrapped option path is content when shortcut words are inside the option',async t=>{
 const f=await statusFixture(t);
 const frame=folder=>'\x1b[2J\x1b[HChoose working directory?\r\n  1. Cancel\r\n❯ 2. Open directory; Enter to confirm or Esc to cancel\r\n     '+folder;
 const before=await f.draw(frame('.'));assert.ok(before.nativeTerminalDialog);
 const viewport=()=>Array.from({length:f.runtime.terminal.screen.rows},(_,i)=>{const l=f.runtime.terminal.screen.buffer.active.getLine(i);return {text:l.translateToString(true),wrapped:l.isWrapped};}).filter(l=>l.text);
 const beforeRows=viewport();
 const card=await f.ask('input',[f.target,'\r']);assert.equal(card.state,'confirmation-required');
 const after=await f.draw(frame('..'));assert.ok(after.nativeTerminalDialog);
 const result=await f.confirm(card);
 t.diagnostic(JSON.stringify({beforeRows,afterRows:viewport(),before:before.nativeTerminalDialog,after:after.nativeTerminalDialog,result:result.state,disposition:result.disposition,bytes:f.bytes}));
 assert.deepEqual(f.bytes,[],'A dot-only last-option directory change must not be mistaken for pulsing footer status');
 assert.equal(result.disposition,'invalidated');
});
test('PF12 BLOCK: dot-only option detail before a separate legend remains protected',async t=>{
 const f=await statusFixture(t);
 const frame=folder=>'\x1b[2J\x1b[HChoose working directory?\r\n  1. Cancel\r\n❯ 2. Open directory\r\n     '+folder+'\r\nPress Enter to confirm or Esc to cancel\r\n.';
 await f.draw(frame('.'));const card=await f.ask();await f.draw(frame('..'));
 const result=await f.confirm(card);assert.equal(result.disposition,'invalidated');assert.deepEqual(f.bytes,[]);
});
test('PF12 BLOCK: standalone legend words remain bound during a footer rewrap',async t=>{
 const f=await statusFixture(t);
 const frame=text=>'\x1b[2J\x1b[HSelect model\r\n  1. Default\r\n❯ 2. Opus\r\n  3. Haiku\r\n◉ xHigh effort ←/→ to adjust\r\nUse /fast to turn on Fast mode.\r\n'+text+'\r\n.';
 await f.draw(frame('Enter to set as default · s to use this session\r\nonly · Esc to cancel'));const card=await f.ask();
 await f.draw(frame('Enter to use this session only · s to set as default\r\n· Esc to cancel'));
 const result=await f.confirm(card);assert.equal(result.disposition,'invalidated');assert.deepEqual(f.bytes,[]);
});


const returnFrame=(legend,status='.')=>'\x1b[2J\x1b[HSelect model\r\n❯ 1. Model X\r\n  2. Cancel\r\n'+legend+'\r\n'+status;
test('PF11 fallback: rewrapping a Return legend keeps its detector but requires a new card',async t=>{
 const f=await statusFixture(t);await f.draw(returnFrame('Press Return to confirm or Escape to cancel'));
 const card=await f.ask();await f.draw(returnFrame('Press Return to\r\nconfirm or Escape to cancel','..'));
 assert.equal((await f.confirm(card)).disposition,'invalidated');assert.deepEqual(f.bytes,[]);
});
test('PF12 Return: changing a Return legend word revokes input without bytes',async t=>{
 const f=await statusFixture(t);await f.draw(returnFrame('Press Return to confirm or Escape to cancel'));
 const card=await f.ask();await f.draw(returnFrame('Press Return to\r\nselect or Escape to cancel','..'));
 assert.equal((await f.confirm(card)).disposition,'invalidated');assert.deepEqual(f.bytes,[]);
});

const boundaryClear='\x1b[2J\x1b[H',boundaryLegend='Press Enter to confirm or Esc to cancel';
async function boundaryReject(t,before,after){const f=await statusFixture(t);const a=await f.draw(boundaryClear+before.join('\r\n'));assert.ok(a.nativeTerminalDialog);const card=await f.ask('input',[f.target,'\r']);const rows=()=>Array.from({length:f.runtime.terminal.screen.rows},(_,i)=>{const l=f.runtime.terminal.screen.buffer.active.getLine(i);return {text:l.translateToString(true),wrapped:l.isWrapped};}).filter(l=>l.text);const beforeRows=rows();const z=await f.draw(boundaryClear+after.join('\r\n'));const result=await f.confirm(card);t.diagnostic(JSON.stringify({beforeRows,afterRows:rows(),before:a.nativeTerminalDialog,after:z.nativeTerminalDialog,result:result.state,disposition:result.disposition,bytes:f.bytes}));assert.deepEqual(f.bytes,[]);assert.equal(result.disposition,'invalidated');}
test('PF12 second BLOCK: unnumbered option with dot continuation has no independent legend',async t=>{
 // This accepted legacy layout keeps the Esc instruction in its second option.
 const accepted=p=>['Choose directory?','❯ Open directory; Enter to confirm','  Cancel; Esc to cancel','  '+p];
 await boundaryReject(t,accepted('.'),accepted('..'));
});
test('PF12 second BLOCK: legend between numbered choices cannot exclude a later dot path',async t=>{
 const frame=p=>['Choose directory?','  1. Cancel',boundaryLegend,'❯ 2. Open directory; Esc to cancel','     '+p];
 await boundaryReject(t,frame('.'),frame('..'));
});
test('PF12 second BLOCK: legend-like continuation in the body before a final legend keeps the path',async t=>{
 const frame=p=>['Choose directory?','  1. Cancel','❯ 2. Open directory','     '+boundaryLegend,'     '+p,boundaryLegend];
 await boundaryReject(t,frame('.'),frame('..'));
});
test('PF12 second BLOCK: body beginning Enter must not borrow a later complete legend to normalize command lines',async t=>{
 const frame=body=>['Choose shell action?','  1. Cancel','❯ 2. Run the command shown below',...body,boundaryLegend];
 await boundaryReject(t,frame(['Enter command: printf A','printf B']),frame(['Enter command: printf','A printf B']));
});

test('PF12 second BLOCK: Return body cannot borrow the following complete legend', async t => {
  const frame = body => ['Choose shell action?', '  1. Cancel', '❯ 2. Run command', ...body, boundaryLegend];
  await boundaryReject(t, frame(['Return command: printf A', 'printf B']), frame(['Return command: printf', 'A printf B']));
});
for (const key of ['Enter', 'Return']) test(`PF12 second BLOCK: ${key} action-like body with an Esc-only tail keeps hard lines`, async t => {
  const frame = body => ['Choose shell action?', '  1. Cancel', '❯ 2. Run command', ...body, 'Esc to cancel'];
  await boundaryReject(t, frame([`${key} to confirm printf A`, 'printf B']), frame([`${key} to confirm printf`, 'A printf B']));
});
test('PF12 second BLOCK: even instruction-shaped body lines stay bound before a final legend', async t => {
  const frame = body => ['Choose shell action?', '  1. Cancel', '❯ 2. Run command', ...body, boundaryLegend];
  await boundaryReject(t, frame(['Enter to confirm', 'or Esc to cancel']), frame(['Enter to', 'confirm or Esc to cancel']));
});
test('PF12 second BLOCK: a body cannot borrow a differently introduced trailing legend', async t => {
  const frame = body => ['Choose shell action?', '  1. Cancel', '❯ 2. Run command', ...body, 'Use Enter to confirm or Esc to cancel'];
  await boundaryReject(t, frame(['Return command: printf A', 'printf B']), frame(['Return command: printf', 'A printf B']));
});
test('PF11 fallback: complete model key instructions rewrap without a new detected episode but need a fresh card', async t => {
  const f = await statusFixture(t);
  const frame = (legend, status) => boundaryClear + ['Select model', '  1. Default', '❯ 2. Model X', legend, status].join('\r\n');
  await f.draw(frame('Enter to set as default · s to use this session\r\nonly · Esc to cancel', '.'));
  const before = f.current().nativeTerminalDialog, card = await f.ask('input', [f.target, '\r']);
  await f.draw(frame('Enter to set as default · s to use this\r\nsession only · Esc to cancel', '..'));
  assert.equal((await f.confirm(card)).disposition, 'invalidated'); assert.deepEqual(f.bytes, []);
  assert.deepEqual(f.current().nativeTerminalDialog, before);
  const fresh = await f.ask('input', [f.target, '\r']); assert.equal((await f.confirm(fresh)).state, 'complete');
  await assert.rejects(f.confirm(fresh)); assert.deepEqual(f.bytes, ['\r']);
});

test('PF11 fallback: an old persisted dialog proof without a frame cannot authorize a native write', async t => {
  const f = await statusFixture(t), proof = operation.terminalInputProof(f.current()); delete proof.stateMark.frame;
  assert.throws(() => f.w.input(f.target, '\r', 'owner', { proof, expiresAt: Date.now() + 60000 }),
    e => e.uiMessage?.key === 'error.background.terminalInvalidated');
  assert.deepEqual(f.bytes, []);
});
test('PF11 fallback: frame advance after desktop approval is rejected by the final native check', async t => {
  const f = await statusFixture(t), card = await f.ask('input', [f.target, '\r']), original = f.handlers.get('input');
  f.handlers.set('input', (...args) => {
    f.runtime.terminal.journal.append('output', '', 100, 30, () => '');
    return original(...args);
  });
  assert.equal((await f.confirm(card)).disposition, 'invalidated'); assert.deepEqual(f.bytes, []);
});
test('inbox reconciles a newly stale input before counting, retains its history and writes no terminal input', async t => {
  const f = await fixture(t), request = await f.ask();
  const list = () => f.controller.confirmations(f.c.client.snapshot());
  let rows = list(); assert.equal(rows.filter(r => r.actionable).length, 1);
  f.w.get(f.target).state = 'working'; rows = list();
  assert.equal(rows.filter(r => r.actionable).length, 0); assert.equal(rows.find(r => r.operationId === request.id).state, 'unverifiable');
  assert.equal(f.controller.receipt(f.actor, request.id).state, 'confirmation-required');
  assert.equal((await f.confirm(request)).disposition, 'invalidated'); assert.deepEqual(f.bytes, []);
});
test('inbox uncertainty excludes the count without claiming the disconnected target disappeared', async t => {
  const f = await fixture(t), request = await f.ask(); f.disconnect(true);
  let card = f.controller.confirmations(f.c.client.snapshot())[0];
  assert.equal(card.actionable, false); assert.equal(card.state, 'unverifiable'); assert.equal(card.reason, 'temporarily-unavailable');
  assert.equal(f.controller.receipt(f.actor, request.id).state, 'confirmation-required');
  f.disconnect(false); assert.equal(f.controller.confirmations(f.c.client.snapshot())[0].actionable, true); assert.deepEqual(f.bytes, []);
});
test('an incomplete disconnected snapshot never settles a missing target as gone', async t => {
 const f=await fixture(t),request=await f.ask();f.remove();
 let rows=f.controller.confirmations({...f.c.client.snapshot(),unavailable:true});assert.equal(rows[0].state,'unverifiable');assert.equal(f.controller.receipt(f.actor,request.id).state,'confirmation-required');
 rows=f.controller.confirmations(f.c.client.snapshot());assert.equal(rows[0].state,'unverifiable');assert.equal(rows[0].reason,'temporarily-unavailable');assert.equal(f.controller.receipt(f.actor,request.id).state,'confirmation-required');
 const result=await f.confirm(request);assert.equal(result.reason,'target-missing');assert.equal(result.disposition,'invalidated');assert.deepEqual(f.bytes,[]);
});
test('inbox all retains completed, withdrawn and expired cards with full original identity', async t => {
  const f = await fixture(t), first = await f.ask(); await f.confirm(first);
  const second = await f.ask(); await f.ask('backgroundWithdraw', [second.id]);
  const third = await f.ask(); f.setClock(f.clock() + 120000); f.controller.expirePending();
  const rows = f.controller.confirmations(f.c.client.snapshot());
  assert.equal(rows.length, 3); assert.equal(rows.filter(r => r.actionable).length, 0);
  assert.deepEqual(rows.map(r => [r.sessionId, r.nativeId, r.id]), [first, second, third].map(r => [f.actor.id, f.actor.nativeId, 'background:' + f.actor.nativeId + ':' + r.id]));
  assert.equal(rows[0].state, 'complete'); assert.equal(rows[1].disposition, 'withdrawn'); assert.equal(rows[2].disposition, 'expired');
  assert.deepEqual(f.bytes, ['\x1b']);
});
// PF11 binds the output frame: a redraw with the same title/since/revision is
// not proof of the same native popup, so the inbox stops offering the old card.
test('inbox stops offering a card after a redraw of the same dialog (PF11) and after a new instance', async t => {
  const f = await fixture(t), runtime = f.runtimes.get(f.target);
  runtime.nativeTerminalDialog = { kind: 'choice', title: 'Synthetic choice?', since: 1, revision: 0 };
  const row = id => f.controller.confirmations(f.c.client.snapshot()).find(r => r.operationId === id);
  const request = await f.ask();
  assert.equal(row(request.id).actionable, true, 'Actionable before any redraw');
  runtime.terminal.journal.append('output', 'redraw', 100, 30, () => 'redraw');
  assert.equal(row(request.id).actionable, false); assert.equal(row(request.id).state, 'unverifiable');
  assert.equal(f.controller.receipt(f.actor, request.id).state, 'confirmation-required', 'The projection settles nothing');
  assert.equal((await f.confirm(request)).disposition, 'invalidated'); assert.deepEqual(f.bytes, []);
  const fresh = await f.ask();
  assert.equal(row(fresh.id).actionable, true, 'A card asked at the current frame is offered');
  runtime.nativeTerminalDialog = { ...runtime.nativeTerminalDialog, since: 2 };
  assert.equal(row(fresh.id).actionable, false); assert.equal(row(fresh.id).state, 'unverifiable');
  assert.equal((await f.confirm(fresh)).disposition, 'invalidated'); assert.deepEqual(f.bytes, []);
});
test('inbox can verify after restart without opening a view; missing proof stays uncertain and never counted', async t => {
 const f=await fixture(t),request=await f.ask();
 const cold=new BackgroundControl({...f.config,context:()=>assert.fail('Projection must not open a background view'),confirmationFingerprint:(row,snapshot,view)=>operation.controlFingerprint(row.command,{state:snapshot,actor:row.actor,context:{view},roomState:{apply:s=>s,value:{sessionArchives:{}},metadata:()=>({restoreMembers:[],restorePlacements:{}})},sessionLabels:{apply:s=>s}})});
 try { assert.equal(cold.confirmations(f.c.client.snapshot())[0].actionable,true);cold.commit(d=>{delete d.records.find(r=>r.id===request.id).guard;});
 const row=cold.confirmations(f.c.client.snapshot())[0];assert.equal(row.actionable,false);assert.equal(row.state,'unverifiable');assert.equal(cold.receipt(f.actor,request.id).state,'confirmation-required'); }
 finally {await cold.close();}
 assert.deepEqual(f.bytes,[]);
});


function projectionFixture(controller) {
 const source=fs.readFileSync(require.resolve('../main.cjs'),'utf8'),events=[];
 const scope=vm.createContext({roomState:{apply:s=>s},sessionLabels:{apply:s=>s},submissionState:s=>s,
  confirmationInbox:require('../confirmation-inbox.cjs'),confirmationProjectionKey:'',confirmationProjectionKeys:new WeakMap(),recordsChanged:()=>events.push('changed'),
  confirmationSnapshot:(_client,snapshot)=>snapshot,backgroundControl:controller,backgroundUnavailable:false,outboxQuitFailed:false,outboxUnavailable:false,
  activeManagers:()=>({}),integratorRole:null,stewardRole:null,stewardWake:null,sessionModelChanges:null,queueDispatcher:null,butlerIngress:null,localVendorIcons:()=>({}),
  roomPeerIdentity:()=>null,endedByMove:()=>[],viewStorageWarning:'',viewStorageWarningUiMessage:null});
 vm.runInContext(source.slice(source.indexOf('function displayState('),source.indexOf('function reportViewStorage(')),scope);
 return {events,show:(snapshot,context={view:{},win:{}})=>scope.displayState(snapshot,context)};
}
for(const change of ['missing-target','missing-origin','different-native','working']) test(`follow-up: one stale snapshot (${change}) must not permanently invalidate a valid card`,async t=>{
 const f=await fixture(t),request=await f.ask(),fresh=f.c.client.snapshot();
 const lagging={...fresh,sessions:fresh.sessions.filter(s=>s.id!==(change==='missing-target'?f.target:change==='missing-origin'?f.actor.id:null)).map(s=>s.id===f.target?{...s,...(change==='different-native'?{nativeId:'previous-native'}:change==='working'?{state:'working'}:{})}:s)};
 const projected=f.controller.confirmations(lagging)[0];
 assert.equal(projected.actionable,false);assert.equal(projected.state,'unverifiable');assert.equal(projected.reason,'temporarily-unavailable');assert.equal(f.controller.receipt(f.actor,request.id).state,'confirmation-required');
 assert.equal(f.controller.confirmations(fresh)[0].actionable,true,'A fresh snapshot restores this same card');
 assert.equal((await f.confirm(request)).state,'complete');assert.deepEqual(f.bytes,['\x1b']);
});
test('follow-up: a real projection write failure retains the conversation and marks cards unverifiable',async t=>{
 const f=await fixture(t),request=await f.ask(),p=projectionFixture(f.controller),rename=fs.renameSync;
 f.setClock(f.clock()+120000);
 fs.renameSync=function(from,to,...rest){if(to===f.controller.file)throw Object.assign(Error('Synthetic write denied'),{code:'EACCES'});return rename.call(this,from,to,...rest);};
 let display;try{assert.doesNotThrow(()=>{display=p.show(f.c.client.snapshot());});}finally{fs.renameSync=rename;}
 assert.equal(f.controller.failed,true);assert.equal(display.sessions.length,2);assert.equal(display.backgroundConfirmations[0].state,'unverifiable');assert.equal(display.backgroundConfirmations[0].actionable,false);
 assert.equal(p.show(f.c.client.snapshot()).backgroundConfirmations[0].state,'unverifiable');
 await assert.rejects(f.confirm(request));assert.deepEqual(f.bytes,[]);
});
test('follow-up: per-window projection keys do not alternate between healthy and disconnected snapshots',()=>{
 const p=projectionFixture({rows:()=>[],confirmations:(_names,snapshot)=>[{id:'card',state:snapshot.unavailable?'unverifiable':'confirmation-required',actionable:!snapshot.unavailable}]}),a={view:{},win:{}},b={view:{},win:{}};
 const healthy={sessions:[]},disconnected={sessions:[],unavailable:true};
 p.show(healthy,a);p.show(disconnected,b);assert.equal(p.events.length,2);
 p.show(healthy,a);p.show(disconnected,b);assert.equal(p.events.length,2,'Unchanged windows do not force extra bell refreshes');
 p.show(disconnected,a);assert.equal(p.events.length,3,'An actual change in one window still notifies');
});


test('follow-up: uncertainty after an earlier step retains the partial-operation warning',async t=>{
 const f=await fixture(t);let effects=0;
 f.handlers.set('rename',async context=>{effects++;await dialog(context,'message',{message:'Continue synthetic step?',buttons:['Cancel','Continue'],cancelId:0});});
 const request=await f.ask('rename',[f.target,'New name']);const follow=await f.confirm(request);assert.equal(follow.state,'confirmation-required');assert.equal(effects,1);
 const fresh=f.c.client.snapshot(),lagging={...fresh,sessions:fresh.sessions.filter(s=>s.id!==f.target)};
 const row=f.controller.confirmations(lagging)[0];assert.equal(row.state,'unverifiable');assert.equal(row.afterStart,true);assert.equal(row.reason,'partial-operation');assert.equal(effects,1);
});
