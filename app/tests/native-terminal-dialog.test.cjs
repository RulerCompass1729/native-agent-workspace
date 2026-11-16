const test = require('node:test'), assert = require('node:assert/strict');
const { Terminal } = require('@xterm/headless');
const { terminalDialogPrompt } = require('../native-terminal-dialog.cjs');
const { sessionReady, CAPABILITY, planDispatch } = require('../queue-dispatch.cjs');
const { Workspace } = require('../workspace.cjs');
const { EventEmitter } = require('node:events');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const MODAL = 'Teach auto mode about your environment?\r\n❯ 1. Yes\r\n  2. Not now\r\n  3. Don\'t show again\r\nEnter to confirm · Esc to cancel';
const write = (screen, text) => new Promise(resolve => screen.write(text, resolve));
async function terminal(t, text, cols = 100) {
  const screen = new Terminal({ cols, rows: 30, allowProposedApi: true });
  t.after(() => screen.dispose()); await write(screen, text);
  return { terminal: { alive: true, screen } };
}
const member = extra => ({ id: 'a', provider: 'claude', nativeId: 'native-a', state: 'idle', roomIds: ['shared'],
  serviceCapabilities: [CAPABILITY], terminalState: { alive: true }, background: 0, scheduled: 0, ...extra });
for (const [provider, text] of [['claude', MODAL], ['codex', 'Would you like to proceed?\r\n› 1. Yes, proceed\r\n  2. No, cancel\r\nPress enter to confirm or esc to exit']]) {
  test(`${provider}: current choice, wrapped title, dismissal and scrollback`, async t => {
    const runtime = await terminal(t, '\x1b[32m' + text + '\x1b[0m', 38);
    const session = member({ provider }), prompt = terminalDialogPrompt(session, runtime);
    assert.ok(prompt); assert.match(prompt.title, /environment\?|proceed\?/);
    assert.equal(terminalDialogPrompt(session, runtime), prompt, 'a repaint is one observed episode');
    assert.equal(sessionReady({ ...session, nativeTerminalDialog: prompt }, { enabled: true }).reason, 'native-terminal-dialog');
    const plan = extra => planDispatch({ sessions: [{ ...session, ...extra }], rooms: [{ id: 'shared', queue: [{ id: 'i', text: 'task', status: 'queued', assignee: 'a', createdAt: 1 }] }], wakePolicy: { enabled: true }, idleSince: new Map([['a', 1]]), now: 100000 });
    assert.equal(plan({ nativeTerminalDialog: prompt }).some(a => a.kind === 'dispatch'), false);
    await write(runtime.terminal.screen, '\r\nnormal output\r\n'.repeat(35) + '❯ ');
    assert.equal(terminalDialogPrompt(session, runtime), null);
    assert.equal(plan({ nativeTerminalDialog: null }).some(a => a.kind === 'dispatch'), true, 'normal dispatch resumes');
  });
}
test('prose, drafts, slash menus and a quoted old choice above the editor stay dispatchable', async t => {
  for (const text of ['1. first\r\n2. second', '❯ draft with Enter to confirm', '/model\r\n❯ first\r\n  second\r\nUse arrows to navigate', MODAL + '\r\n❯ unsent draft', MODAL.replace('❯', ' ')]) {
    const runtime = await terminal(t, text);
    assert.equal(terminalDialogPrompt(member(), runtime), null, text);
  }
});
test('backend refuses a stale dispatcher and rechecks a newly appeared modal at native authorization', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-dialog-backend-'));
  const runtime = Object.assign(new EventEmitter(), await terminal(t, MODAL));
  let sent = 0, valid;
  runtime.start = async () => runtime.emit('state', 'idle');
  runtime.send = async (_text, _tag, guard) => { assert.ok(guard()); valid = guard; sent++; };
  const w = new Workspace({ binaries: {}, create: () => runtime, close() {} }, dir);
  t.after(() => { w.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const id = await w.create('claude', dir, 'person', 'Synthetic member');
  const send = () => w.send(id, 'task', 'naw-dispatcher', null, null, null, null, null, null, null, { itemId: 'i' });
  assert.equal(w.snapshot().sessions[0].nativeTerminalDialog?.title, 'Teach auto mode about your environment?');
  await assert.rejects(send(), error => error.uiMessage?.key === 'error.queue.terminalDialog'); assert.equal(sent, 0);
  await write(runtime.terminal.screen, '\x1b[2J\x1b[H❯ '); runtime.emit('terminal', { sequence: 1 });
  await send(); assert.equal(sent, 1);
  await write(runtime.terminal.screen, '\x1b[2J\x1b[H' + MODAL);
  assert.equal(valid(), false, 'dialog appearing between planning and native acceptance revokes the send');
});
module.exports = { MODAL };

test('stewardEvents records each episode and recovery once without transcript or model work', t => {
  const { ButlerIngress } = require('../butler-ingress.cjs'), { RoomState } = require('../room-state.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-dialog-events-')); fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ingress = new ButlerIngress(dir, { roomState: new RoomState(dir) });
  const s = member({ name: 'Member', nativeTerminalDialog: { title: 'Choose a model?', since: 1 }, messages: [{ text: 'PRIVATE TRANSCRIPT NEVER COPIED' }] });
  ingress.observeTerminalDialogs([s]); ingress.observeTerminalDialogs([s]);
  ingress.observeTerminalDialogs([{ ...s, nativeTerminalDialog: null }]);
  ingress.observeTerminalDialogs([{ ...s, nativeTerminalDialog: null }]);
  const events = ingress.ledger.eventsAfter(null).events;
  assert.deepEqual(events.map(e => e.kind), ['blocked', 'recovery']);
  assert.equal(events[0].payload.title, 'Choose a model?');
  assert.ok(!JSON.stringify(events).includes('PRIVATE TRANSCRIPT'));
  assert.equal(ingress.ledger.pendingEvents().length, 0, 'the observation does not start model work');
});
test('existing collaboration status text names the dialog in both languages', () => {
  const { statusFacts } = require('../renderer/collaboration-overview.js');
  const s = member({ nativeTerminalDialog: { title: 'Choose a model?' } });
  assert.match(statusFacts(s).state, /等你：终端停在弹窗.*Choose a model/);
  assert.match(statusFacts(s, true, Date.now(), 'en').state, /Waiting for you: terminal dialog/);
});

test('the one real Claude 2.1.323 model selector has a wrapped set-as-default legend', async t => {
  const text = 'Select model\r\nSwitch between Claude models. Your pick becomes the\r\ndefault for new sessions.\r\n  1. Default\r\n❯ 2. Opus\r\n  3. Haiku\r\n◉ xHigh effort ←/→ to adjust\r\nUse /fast to turn on Fast mode.\r\nEnter to set as default · s to use this session\r\nonly · Esc to cancel';
  const runtime = await terminal(t, text);
  assert.equal(terminalDialogPrompt(member(), runtime)?.title, 'Select model');
  await write(runtime.terminal.screen, '\r\n❯ draft');
  assert.equal(terminalDialogPrompt(member(), runtime), null, 'legend above a live editor is historical');
});
test('unchanged journal frames are decoded once; dismissal invalidates the frame cache', async t => {
  const runtime = await terminal(t, MODAL); runtime.terminal.journal = { epoch: 'synthetic', index: 1 };
  const buffer = runtime.terminal.screen.buffer.active, getLine = buffer.getLine.bind(buffer); let reads = 0;
  buffer.getLine = (...args) => { reads++; return getLine(...args); };
  const first = terminalDialogPrompt(member(), runtime);
  for (let i = 0; i < 100; i++) assert.equal(terminalDialogPrompt(member(), runtime), first);
  assert.equal(reads, 30);
  await write(runtime.terminal.screen, '\x1b[2J\x1b[H❯ '); runtime.terminal.journal.index++;
  assert.equal(terminalDialogPrompt(member(), runtime), null);
});


test('reopening after a member rename reuses its immutable episode; other members and recovery keep recording', t => {
  const { ButlerIngress } = require('../butler-ingress.cjs'), { RoomState } = require('../room-state.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-dialog-reopen-')); fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const first = member({ name: 'Former name', nativeTerminalDialog: { title: 'Choose?', since: 1 } });
  new ButlerIngress(dir, { roomState: new RoomState(dir) }).observeTerminalDialogs([first]);
  const second = new ButlerIngress(dir, { roomState: new RoomState(dir) });
  const renamed = { ...first, name: 'Current name' }, other = member({ id: 'b', nativeId: 'native-b', name: 'Other member', nativeTerminalDialog: { title: 'Confirm?', since: 2 } });
  second.observeTerminalDialogs([renamed, other]);
  assert.equal(second.ledger.eventsAfter(null).events.length, 2);
  assert.equal(second.ledger.eventsAfter(null).events[0].payload.memberName, 'Former name');
  second.observeTerminalDialogs([{ ...renamed, nativeTerminalDialog: null, transportDisconnected: true }]);
  second.observeTerminalDialogs([{ ...renamed, nativeTerminalDialog: null, terminalState: null }]);
  const oldBackend = { ...renamed }; delete oldBackend.nativeTerminalDialog;
  second.observeTerminalDialogs([oldBackend]);
  assert.equal(second.ledger.eventsAfter(null).events.length, 2, 'unknown observation is not recovery');
  second.observeTerminalDialogs([{ ...renamed, nativeTerminalDialog: null }]);
  assert.equal(second.ledger.eventsAfter(null).events.at(-1).kind, 'recovery');
  const third = new ButlerIngress(dir, { roomState: new RoomState(dir) });
  third.observeTerminalDialogs([{ ...renamed, nativeTerminalDialog: null }]);
  assert.equal(third.ledger.eventsAfter(null).events.length, 3);
});

test('a possibly accepted send is not reclassified or silently replayed when a dialog appears', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-dialog-uncertain-'));
  const runtime = Object.assign(new EventEmitter(), await terminal(t, '❯ '));
  runtime.start = async () => runtime.emit('state', 'idle');
  runtime.send = async (_text, _tag, guard) => {
    assert.equal(guard(), true);
    await write(runtime.terminal.screen, '\x1b[2J\x1b[H' + MODAL);
    assert.equal(guard(), false);
    throw Object.assign(require('../ui-errors.cjs').uiError('error.nativeSubmissionUnconfirmed'), { notSent: false });
  };
  const w = new Workspace({ binaries: {}, create: () => runtime, close() {} }, dir);
  t.after(() => { w.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const id = await w.create('claude', dir, 'person', 'Synthetic member');
  await assert.rejects(w.send(id, 'task', 'naw-dispatcher', null, null, null, null, null, null, null, { itemId: 'i' }), error => error.uiMessage?.key === 'error.nativeSubmissionUnconfirmed' && error.notSent === false);
});
