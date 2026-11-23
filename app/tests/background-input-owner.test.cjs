// 2026-11-23: two butler inputs the person had confirmed ended unconfirmed with 「另一个窗口正在控制这个会话。」: the
// targets were in other backends and held by the person's window. A confirmed input reaches its target whichever
// window holds it, without changing who holds it; what cannot be delivered says so before the click.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { EventEmitter, once } = require('node:events');
const { fork } = require('node:child_process');
const operation = require('../background-operation.cjs');
const workspaceClient = require('../workspace-client.cjs');
const { WorkspaceClient } = workspaceClient;
const { BackgroundControl } = require('../background-control.cjs');
const { Workspace } = require('../workspace.cjs');
const { TerminalJournal } = require('../observation.cjs');
const root = path.resolve(__dirname, '../..');
const OTHER = 'backends/bbbbbbbbbbbbbbbbbbbb';
const key = error => error?.uiMessage?.key;

// Real daemons over real sockets; only the native transport is synthetic and no model runs.
const NATIVE = `const path = require('node:path'), fs = require('node:fs'), { EventEmitter } = require('node:events');
const appRoot = process.env.NAW_TEST_APP_ROOT;
const { NativeHost } = require(path.join(appRoot, 'app/adapters.cjs'));
const { TerminalJournal } = require(path.join(appRoot, 'app/observation.cjs'));
NativeHost.prototype.start = async function () { this.binaries = { claude: 'fixture', codex: 'fixture', python: 'fixture' }; };
NativeHost.prototype.close = function () {};
NativeHost.prototype.create = function (record) {
  const runtime = new EventEmitter(), journal = new TerminalJournal(100, 30);
  journal.append('output', 'Synthetic terminal', 100, 30, () => 'Synthetic terminal');
  runtime.chatAvailable = true;
  runtime.terminal = { alive: true, journal, cols: 100, rows: 30, resize() {},
    input: data => fs.appendFileSync(process.env.NAW_TEST_INPUT_LOG, JSON.stringify({ id: record.id, data }) + '\\n') };
  runtime.start = async () => { runtime.emit('model', 'fixture-model'); runtime.emit('state', 'idle'); };
  runtime.stop = async () => ({ state: 'ended' });
  return runtime;
};
`;
async function backends(t, appRoots = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'naw-input-owner-'))); fs.chmodSync(dir, 0o700);
  fs.mkdirSync(path.join(dir, OTHER), { recursive: true, mode: 0o700 }); fs.chmodSync(path.join(dir, 'backends'), 0o700);
  fs.writeFileSync(path.join(dir, 'services.json'), JSON.stringify({ format: 1, active: '.', entries: ['.', OTHER] }), { mode: 0o600 });
  const native = path.join(dir, 'synthetic-native.cjs'), log = path.join(dir, 'typed.jsonl');
  fs.writeFileSync(native, NATIVE); fs.writeFileSync(log, '');
  const children = [], views = [];
  t.after(async () => {
    for (const view of views) view.close();
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { const ended = once(child, 'exit'); child.kill(); await ended; }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  for (const entry of ['.', OTHER]) {
    const appRoot = appRoots[entry] || root, home = path.join(dir, entry);
    children.push(fork(path.join(appRoot, 'app/daemon.cjs'), [home], { execArgv: ['--require', native],
      env: { PATH: process.env.PATH, HOME: dir, TMPDIR: os.tmpdir(), NAW_TEST_APP_ROOT: appRoot, NAW_WORKSPACE: dir, NAW_TEST_INPUT_LOG: log },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }));
  }
  const deadline = Date.now() + 10000;
  while (!['.', OTHER].every(entry => fs.existsSync(path.join(dir, entry, 'connection.json')))) {
    assert.ok(Date.now() < deadline && children.every(c => c.exitCode === null), 'both synthetic backends start');
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  const { connect } = require('../service-client.cjs');
  const open = async (owner, options) => { const view = await connect(dir, owner, options); views.push(view); return view; };
  const setup = await open('setup');
  const make = async (entry, name) => setup.entries.find(e => e.key === entry).client.call('create', { provider: 'claude', cwd: dir, name, view: 'terminal' });
  const butler = await make('.', 'Butler'), here = await make('.', 'Same backend'), there = await make(OTHER, 'Other backend');
  const person = await open('person-window'), agent = await open('butler-view', { page: false });
  const typed = () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  const record = async (view, id) => { await view.refresh(); return view.snapshot().sessions.find(s => s.id === id); };
  const consent = async (id, expiresAt = Date.now() + 60000) => ({ proof: operation.terminalInputProof(await record(agent, id)), expiresAt });
  return { dir, setup, person, agent, open, butler, here, there, typed, record, consent };
}

test('confirmed input reaches a target in another backend that the person\'s window holds, and it keeps holding it', { timeout: 20000 }, async t => {
  const f = await backends(t);
  await f.person.call('claim', f.there, 'terminal');
  assert.equal((await f.record(f.agent, f.there)).owner, 'person-window');
  assert.equal(f.agent.route(f.there).key, OTHER, 'the input goes to the target\'s own backend');
  let error = null;
  try { await f.agent.call('input', f.there, 'synthetic confirmed text', await f.consent(f.there)); } catch (e) { error = e; }
  t.diagnostic(JSON.stringify({ error: error && { message: error.message, key: key(error) }, typed: f.typed() }));
  assert.equal(error, null);
  assert.deepEqual(f.typed(), [{ id: f.there, data: 'synthetic confirmed text' }]);
  assert.equal((await f.record(f.person, f.there)).owner, 'person-window');
});

test('confirmed input reaches a target in the same backend held by another window, and it keeps holding it', { timeout: 20000 }, async t => {
  const f = await backends(t);
  await f.person.call('claim', f.here, 'chat');
  let error = null;
  try { await f.agent.call('input', f.here, 'synthetic confirmed text', await f.consent(f.here)); } catch (e) { error = e; }
  t.diagnostic(JSON.stringify({ error: error && { message: error.message, key: key(error) }, typed: f.typed() }));
  assert.equal(error, null);
  assert.deepEqual(f.typed(), [{ id: f.here, data: 'synthetic confirmed text' }]);
  const after = await f.record(f.person, f.here);
  assert.equal(after.owner, 'person-window'); assert.equal(after.view, 'chat');
});

test('confirmed input reaches a target no open window holds; nobody becomes its holder', { timeout: 20000 }, async t => {
  const f = await backends(t);
  // Its creator's window was closed by the person: it holds nothing against open windows.
  await f.setup.entries.find(e => e.key === OTHER).client.call('leave'); f.setup.close();
  await new Promise(resolve => setTimeout(resolve, 100));
  let error = null;
  try { await f.agent.call('input', f.there, 'synthetic confirmed text', await f.consent(f.there)); } catch (e) { error = e; }
  assert.equal(error, null, error && `${error.message} ${key(error)}`);
  assert.deepEqual(f.typed(), [{ id: f.there, data: 'synthetic confirmed text' }]);
  assert.equal((await f.record(f.person, f.there)).owner, 'setup');
});

test('without a valid confirmation nothing changes: same refusals, same codes, nothing typed', { timeout: 20000 }, async t => {
  const f = await backends(t);
  await f.person.call('claim', f.there, 'terminal');
  const refused = async (args, code) => {
    await assert.rejects(f.agent.call('input', f.there, ...args), error => { assert.equal(key(error), code, error.message); return true; });
  };
  await refused(['unconfirmed text'], 'error.workspace.controlledByAnotherWindow');
  await refused(['expired text', await f.consent(f.there, Date.now() - 1)], 'error.background.confirmationExpired');
  const stale = await f.consent(f.there);
  await f.person.call('input', f.there, 'person typed'); // The person typed after confirming: the proof no longer holds.
  await refused(['stale text', stale], 'error.background.terminalInvalidated');
  await refused(['no proof', { expiresAt: Date.now() + 60000 }], 'error.background.terminalUnverifiable');
  assert.deepEqual(f.typed(), [{ id: f.there, data: 'person typed' }]);
  assert.equal((await f.record(f.person, f.there)).owner, 'person-window');
});

// A backend kept from an earlier version still refuses input from a view that does not hold the session.
function olderBackend({ owner = 'person-window', capabilities = [] } = {}) {
  const record = { id: 'target', nativeId: 'n-target', provider: 'claude', state: 'idle', owner, view: 'terminal', controlRevision: 0, messages: [] };
  const typed = [], scope = Symbol();
  const view = viewOwner => {
    const client = new EventEmitter(), state = { owner: viewOwner, runtimeVersion: 'older-synthetic', capabilities: ['backgroundControlV1', ...capabilities],
      sessions: [record], diagnostics: {}, room: { revision: 0, messages: [], run: null } };
    client.call = async (method, ...args) => {
      if (method === 'initial') return structuredClone(state);
      if (method !== 'input') return true;
      if (args[2] && !capabilities.includes('consentedInputV1') || !args[2]) {
        if (record.owner !== viewOwner) throw Object.assign(Error('另一个窗口正在控制这个会话。'), { uiMessage: { key: 'error.workspace.controlledByAnotherWindow' } });
      }
      typed.push({ through: viewOwner, data: args[1], consent: Boolean(args[2]) }); return true;
    };
    client.close = () => client.emit('closed');
    // Every view reads the same record, as every view of one backend sees its sessions.
    return new WorkspaceClient([{ key: OTHER, client, state: { ...state, sessions: [record] } }], OTHER, scope);
  };
  return { record, typed, scope, view };
}
const consent = { proof: { version: 1 }, expiresAt: Date.now() + 60000 };

test('older backend: confirmed input goes through the holding window\'s connection; with no live holder it is refused before sending', async t => {
  const b = olderBackend(), person = b.view('person-window'), agent = b.view('butler-view');
  t.after(() => { person.close(); agent.close(); });
  assert.equal(typeof workspaceClient.consentedInputBlocked, 'function');
  assert.equal(workspaceClient.consentedInputBlocked(b.scope, 'target', 'butler-view'), '');
  await agent.call('input', 'target', 'synthetic confirmed text', consent);
  assert.deepEqual(b.typed, [{ through: 'person-window', data: 'synthetic confirmed text', consent: true }]);
  assert.equal(b.record.owner, 'person-window');
  // Without a confirmation the agent's own connection is used, as before, and refused.
  await assert.rejects(agent.call('input', 'target', 'unconfirmed'), error => key(error) === 'error.workspace.controlledByAnotherWindow');
  assert.equal(workspaceClient.consentedInputBlocked(b.scope, 'target', 'butler-view', { ...b.record, owner: null }), 'holder-unavailable', 'the shown copy decides');
  person.close();
  assert.equal(workspaceClient.consentedInputBlocked(b.scope, 'target', 'butler-view'), 'holder-unavailable');
  await assert.rejects(agent.call('input', 'target', 'synthetic confirmed text', consent), error => key(error) === 'error.background.inputHolderUnavailable');
  assert.equal(b.typed.length, 1, 'nothing sent once no open view holds it');
  // The answer follows the target as the asking window shows it, not another view's older copy.
  assert.equal(workspaceClient.consentedInputBlocked(b.scope, 'target', 'butler-view', { ...b.record, owner: 'butler-view' }), '');
  b.record.owner = null;
  assert.equal(workspaceClient.consentedInputBlocked(b.scope, 'target', 'butler-view'), 'holder-unavailable');
  b.record.owner = 'butler-view';
  assert.equal(workspaceClient.consentedInputBlocked(b.scope, 'target', 'butler-view'), '', 'the agent\'s own view holds it');
});

test('a backend that takes confirmed input from any view is sent to directly', async t => {
  const b = olderBackend({ owner: null, capabilities: ['consentedInputV1'] }), agent = b.view('butler-view');
  t.after(() => agent.close());
  assert.equal(workspaceClient.consentedInputBlocked(b.scope, 'target', 'butler-view'), '');
  await agent.call('input', 'target', 'synthetic confirmed text', consent);
  assert.deepEqual(b.typed, [{ through: 'butler-view', data: 'synthetic confirmed text', consent: true }]);
});

test('the daemon advertises that it takes confirmed input from any view', () => {
  const source = fs.readFileSync(path.join(__dirname, '../daemon.cjs'), 'utf8');
  assert.ok(source.includes("'consentedInputV1'"), 'consentedInputV1 in the daemon capabilities');
});

// The card: the butler asks, the person sees why it cannot be delivered before the click, and a click changes nothing.
async function cards(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-input-owner-card-')); fs.chmodSync(dir, 0o700);
  const bytes = [];
  const host = { binaries: {}, close() {}, create() {
    const runtime = new EventEmitter(), journal = new TerminalJournal(100, 30);
    journal.append('output', 'Synthetic terminal', 100, 30, () => 'Synthetic terminal');
    runtime.terminal = { alive: true, journal, cols: 100, rows: 30, input: data => bytes.push(data), resize() {} };
    runtime.start = async () => runtime.emit('state', 'idle'); runtime.stop = async () => ({ state: 'ended' });
    return runtime;
  } };
  const w = new Workspace(host, dir), id = await w.create('claude', dir, 'butler-view', 'Butler');
  const target = await w.create('claude', dir, 'setup', 'Target');
  const actor = { id, nativeId: w.get(id).nativeId, provider: 'claude', name: 'Butler' };
  const snapshot = () => w.snapshot(), client = { snapshot, close() {} };
  const rooms = { apply: x => x, value: { sessionArchives: {} }, metadata: () => ({ restoreMembers: [], restorePlacements: {} }) };
  const c = { background: true, actor, client, view: { owner: 'butler-view' }, win: { destroy() {} }, checkActor: async () => {}, refresh: async () => {},
    confirmationActors: () => snapshot().sessions, terminalConsentSnapshot: snapshot };
  const source = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8');
  const first = source.indexOf('      context.fingerprint = command =>'), end = source.indexOf('\n      context.delivery =', first);
  vm.runInContext(source.slice(first, end), vm.createContext({ context: c, client, actor, roomState: rooms, backgroundOperation: operation,
    sessionLabels: { apply: value => value, value: { labels: {} } } }));
  const handlers = new Map([['input', async (context, targetId, data) => {
    const approved = operation.request()?.approved;
    return w.input(targetId, data, 'butler-view', approved ? { proof: approved.terminalConsent, expiresAt: approved.expiresAt } : null);
  }]]);
  const delivery = { reason: '', asked: [] };
  const controller = new BackgroundControl({ dataDir: dir, handlers, context: async () => c, audit() {},
    confirmation: () => ({ message: 'Send input?', buttons: ['Cancel', 'Confirm'], cancelId: 0 }),
    inputDelivery: (sessionId, owner) => { delivery.asked.push([sessionId, owner]); return delivery.reason; } });
  t.after(async () => { await controller.close(); await w.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  let seq = 0;
  const ask = args => controller.call({ sender: actor, identity: { turnId: 'turn', callId: 'call-' + (++seq) }, valid: () => true },
    { action: 'invoke', method: 'input', arguments: args, operation_id: 'request-' + seq });
  const confirm = row => controller.decide(actor.id, actor.nativeId, row.id, 1);
  const shown = row => controller.confirmations(snapshot()).find(card => card.operationId === row.id);
  const message = row => controller.rows(actor.id, snapshot()).find(m => m.backgroundOperation.id === row.id).backgroundOperation;
  return { w, target, actor, controller, ask, confirm, shown, message, bytes, delivery };
}

test('a card that cannot be delivered says why before the click, and a click keeps it waiting with nothing typed', async t => {
  const f = await cards(t);
  f.delivery.reason = 'holder-unavailable';
  const card = await f.ask([f.target, 'synthetic text']);
  assert.equal(card.state, 'confirmation-required');
  const shown = f.shown(card);
  assert.equal(shown.actionable, false); assert.equal(shown.reason, 'holder-unavailable');
  assert.equal(f.message(card).deliveryBlocked, 'holder-unavailable', 'the conversation card carries the same reason');
  assert.deepEqual(f.delivery.asked.at(-1), [f.target, 'butler-view'], 'asked about the target for the asking agent\'s own view');
  const result = await f.confirm(card);
  assert.equal(result.state, 'confirmation-required');
  assert.equal(result.resultNotice?.key, 'background.card.reason.holder-unavailable');
  assert.deepEqual(f.bytes, []);
  // Once it can be delivered (the person opened the target), the same card is confirmed and the input is typed.
  f.delivery.reason = '';
  assert.equal(f.shown(card).actionable, true); assert.equal(f.message(card).deliveryBlocked, undefined);
  assert.equal((await f.confirm(card)).state, 'complete');
  assert.deepEqual(f.bytes, ['synthetic text']);
});

test('the person taking the target after the card was sent does not by itself void it (a terminal frame it shows still does); the input is typed and the person keeps the session', async t => {
  const f = await cards(t);
  f.w.get(f.target).owner = null;
  const card = await f.ask([f.target, 'synthetic text']);
  assert.equal(await f.w.claim(f.target, 'person-window', 'terminal', undefined, true), undefined);
  assert.equal(f.w.get(f.target).owner, 'person-window');
  const result = await f.confirm(card);
  assert.equal(result.state, 'complete', JSON.stringify({ state: result.state, disposition: result.disposition, reason: result.reason, error: result.error }));
  assert.deepEqual(f.bytes, ['synthetic text']);
  assert.equal(f.w.get(f.target).owner, 'person-window');
});

test('once the target\'s terminal moved on (the person opened it), the card says before the click that it cannot be sent; nothing is typed', async t => {
  const f = await cards(t);
  const card = await f.ask([f.target, 'synthetic text']);
  assert.equal(f.message(card).deliveryBlocked, undefined);
  f.w.runtimes.get(f.target).terminal.journal.append('output', 'Synthetic resize', 100, 30, () => 'Synthetic resize');
  assert.equal(f.shown(card).actionable, false);
  assert.equal(f.message(card).deliveryBlocked, 'state-changed', 'the conversation card says what a click would find');
  assert.notEqual((await f.confirm(card)).state, 'complete');
  assert.deepEqual(f.bytes, []);
});

test('only a card the person confirmed can carry a confirmation into input: callers cannot pass their own', () => {
  const source = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8');
  const start = source.indexOf("  for (const name of ['prepareInput', 'observe',"), end = source.indexOf('\n  });', start) + '\n  });'.length;
  assert.ok(start > 0 && end > start);
  const handlers = new Map();
  let approved = null;
  vm.runInContext(source.slice(start, end), vm.createContext({ register: (name, fn) => handlers.set(name, fn), roomState: { assertAvailable() {} },
    backgroundOperation: { request: () => (approved ? { approved } : null) } }));
  const calls = [], c = background => ({ background, client: { call: (...args) => { calls.push(args); return true; } } });
  const forged = { proof: { version: 1 }, expiresAt: Date.now() + 60000 };
  handlers.get('input')(c(true), 'target', 'text', forged);
  handlers.get('input')(c(false), 'target', 'text', forged);
  assert.deepEqual(calls, [['input', 'target', 'text'], ['input', 'target', 'text']]);
  approved = { terminalConsent: { version: 1, targetId: 'target' }, expiresAt: 42 };
  handlers.get('input')(c(true), 'target', 'text', forged);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), ['input', 'target', 'text', { proof: approved.terminalConsent, expiresAt: 42 }]);
});
