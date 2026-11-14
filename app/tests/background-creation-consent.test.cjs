// Several creation requests waiting for the person at once (2026-11-13: the butler asked for a new space and two
// sessions; the person confirmed all three and only the space was created, the other two were left "unconfirmed:
// The operation target changed before execution"). Real Workspace, RoomState and SessionLabels, with main.cjs's own
// consent fingerprint and create/spaceCreate/archiveSession handlers.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const { randomUUID } = require('node:crypto'), { EventEmitter } = require('node:events');
const { BackgroundControl, dialog } = require('../background-control.cjs'), operation = require('../background-operation.cjs');
const { RoomState } = require('../room-state.cjs'), { Workspace } = require('../workspace.cjs'), { SessionLabels } = require('../session-labels.cjs');
const main = fs.readFileSync(require.resolve('../main.cjs'), 'utf8');
function part(start, end) { const a = main.indexOf(start), b = main.indexOf(end, a + start.length); assert.ok(a >= 0 && b > a, start); return main.slice(a, b); }
async function fixture(t, provider) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-creation-consent-'));
  const host = { binaries: {}, close() {}, create(record) { record.nativeId = randomUUID(); const runtime = new EventEmitter(); runtime.start = async () => runtime.emit('state', 'idle'); runtime.stop = async () => ({ state: 'ended' }); return runtime; } };
  const workspace = new Workspace(host, dir), rooms = new RoomState(dir), labels = new SessionLabels(dir); let controller;
  t.after(async () => { await controller?.close(); workspace.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const id = await workspace.create(provider, dir, 'owner', 'Butler'), other = await workspace.create(provider, dir, 'owner', 'Other');
  const client = { snapshot: () => workspace.snapshot(), refresh: async () => workspace.snapshot(), close() {}, call: async (method, ...args) => {
    if (method === 'initial') return { ...workspace.snapshot(), capabilities: ['nativePermissionDefaults', 'singleHomeMoveV1'] };
    // Only the hand-made archive below reaches pause; a voided archive card must not.
    if (method === 'pause') return;
    // Only the hand-made join below moves a session.
    if (method === 'moveMembership') return workspace.moveMembership(...args);
    if (method === 'create') { const o = args[0]; return workspace.create(o.provider, o.cwd, 'owner', o.name, o.view); }
    throw Error('Unexpected business call: ' + method);
  } };
  // One backend that has adopted background control, as main.cjs checks before a non-local command.
  Object.defineProperty(client, 'entries', { get: () => [{ key: 'backend', state: { ...workspace.snapshot(), capabilities: [operation.CAPABILITY] } }] });
  const actor = { id, nativeId: workspace.get(id).nativeId, provider, name: 'Butler' };
  const c = { background: true, actor, client, view: {}, refresh: client.refresh, win: { destroy() {}, isDestroyed: () => false } };
  const handlers = new Map();
  const scope = vm.createContext({ context: c, client, actor, roomState: rooms, sessionLabels: labels, backgroundOperation: operation, roomIds: require('../collaboration-spaces.cjs').roomIds,
    applicationHandlers: handlers, ipcMain: { handle() {} }, showDialog: (context, kind, options) => dialog(context, kind, options), displayText: key => key, uiError: require('../ui-errors.cjs').uiError,
    assertNativeCreation: require('../submission-policy.cjs').assertNativeCreation, creationDefaults: { remember() { throw Error('A background creation must not save desktop defaults'); } }, broadcastRoom: async () => {} });
  vm.runInContext(part('function controlRequestActors(', '\nfunction projectBackgroundRecord('), scope);
  vm.runInContext(part('      context.confirmationActors =', '      context.fingerprint ='), scope);
  vm.runInContext(part('      context.fingerprint = command =>', '\n      context.delivery ='), scope);
  vm.runInContext(part('function register(', '\nasync function replaceBackendSockets('), scope);
  for (const [start, end] of [["  register('archiveSession',", "  register('restoreSession',"], ["  register('spaceCreate',", "  register('spaceMerge',"], ["  register('create',", "  register('nativeHistory',"]])
    vm.runInContext(part(start, end), scope);
  // The card carries what main.cjs shows: its detail names the sessions and spaces the request refers to.
  const confirmation = (_actor, command) => ({ type: 'warning', message: 'Maintenance', detail: operation.confirmationDetail(command, labels.apply(rooms.apply(client.snapshot()))),
    buttons: ['Cancel', 'Confirm'], defaultId: 0, cancelId: 0 });
  controller = new BackgroundControl({ dataDir: dir, handlers, context: () => c, confirmation, audit() {} });
  const ask = (method, args, operationId = randomUUID()) => controller.call({ sender: actor, identity: { callId: 'call-' + operationId, turnId: 'turn' }, valid: () => true },
    { action: 'invoke', method, arguments: args, operation_id: operationId });
  const confirm = pending => controller.decide(id, actor.nativeId, pending.id, 1);
  const named = name => labels.apply(workspace.snapshot()).sessions.filter(s => s.name === name);
  const spaces = name => rooms.apply(workspace.snapshot()).rooms.filter(r => r.name === name);
  return { dir, workspace, client, rooms, labels, actor, other, ask, confirm, named, spaces, controller };
}
const session = (f, name, extra = {}) => [{ provider: f.actor.provider, cwd: f.dir, name, ...extra }];
for (const provider of ['claude', 'codex']) {
  test(`${provider}: a new space and two new sessions confirmed together are all created`, async t => {
    const f = await fixture(t, provider);
    const space = await f.ask('spaceCreate', ['Panel']), dev = await f.ask('create', session(f, 'Panel · dev')), check = await f.ask('create', session(f, 'Panel · check'));
    assert.deepEqual([space.state, dev.state, check.state], ['confirmation-required', 'confirmation-required', 'confirmation-required']);
    assert.equal(f.spaces('Panel').length + f.named('Panel · dev').length + f.named('Panel · check').length, 0, 'Nothing is created before the person answers');
    const answers = [await f.confirm(space), await f.confirm(dev), await f.confirm(check)];
    assert.deepEqual(answers.map(r => r.state), ['complete', 'complete', 'complete'], answers.map(r => r.error).join(' | '));
    assert.equal(f.spaces('Panel').length, 1); assert.equal(f.named('Panel · dev').length, 1); assert.equal(f.named('Panel · check').length, 1);
    assert.equal(answers[0].value, f.spaces('Panel')[0].id); assert.equal(answers[1].value, f.named('Panel · dev')[0].id);
  });
  test(`${provider}: the order the person answers in does not matter`, async t => {
    const f = await fixture(t, provider);
    const space = await f.ask('spaceCreate', ['Panel']), dev = await f.ask('create', session(f, 'Panel · dev')), check = await f.ask('create', session(f, 'Panel · check'));
    const answers = [await f.confirm(check), await f.confirm(space), await f.confirm(dev)];
    assert.deepEqual(answers.map(r => r.state), ['complete', 'complete', 'complete'], answers.map(r => r.error).join(' | '));
    assert.equal(f.spaces('Panel').length, 1); assert.equal(f.named('Panel · dev').length, 1); assert.equal(f.named('Panel · check').length, 1);
  });
  test(`${provider}: an unrelated rename, space and archive while a card waits do not void it`, async t => {
    const f = await fixture(t, provider);
    const dev = await f.ask('create', session(f, 'Panel · dev'));
    f.labels.set(f.other, 'Renamed'); f.rooms.create('Elsewhere'); await f.rooms.archiveSession(f.client, f.other);
    assert.equal((await f.confirm(dev)).state, 'complete'); assert.equal(f.named('Panel · dev').length, 1);
  });
  test(`${provider}: a session given the requested name before the answer voids that card, and nothing is created`, async t => {
    const f = await fixture(t, provider);
    // Two different requests for one name: answering both would leave two sessions of that name.
    const chat = await f.ask('create', session(f, 'Panel · dev')), terminal = await f.ask('create', session(f, 'Panel · dev', { view: 'terminal' }));
    assert.equal((await f.confirm(chat)).state, 'complete');
    const late = await f.confirm(terminal);
    assert.equal(late.state, 'unconfirmed'); assert.match(late.error, /operation target changed/i); assert.equal(f.named('Panel · dev').length, 1);
    // A rename onto the requested name does the same.
    const next = await f.ask('create', session(f, 'Panel · check'));
    f.labels.set(f.other, 'Panel · check');
    const renamed = await f.confirm(next);
    assert.equal(renamed.state, 'unconfirmed'); assert.match(renamed.error, /operation target changed/i); assert.equal(f.named('Panel · check').length, 1);
  });
  test(`${provider}: a space made by hand with the requested name voids the card, and no second space is made`, async t => {
    const f = await fixture(t, provider);
    const space = await f.ask('spaceCreate', ['Panel']);
    f.rooms.create('Panel');
    const late = await f.confirm(space);
    assert.equal(late.state, 'unconfirmed'); assert.match(late.error, /operation target changed/i); assert.equal(f.spaces('Panel').length, 1);
  });
  test(`${provider}: the asking session moving into a space before the answer voids its card`, async t => {
    const f = await fixture(t, provider);
    const dev = await f.ask('create', session(f, 'Panel · dev'));
    await f.rooms.membership(f.client, f.actor.id, true);
    const late = await f.confirm(dev);
    assert.equal(late.state, 'unconfirmed'); assert.match(late.error, /operation target changed/i); assert.equal(f.named('Panel · dev').length, 0);
  });
  test(`${provider}: other waiting maintenance still voids on any session change`, async t => {
    const f = await fixture(t, provider);
    const archive = await f.ask('archiveSession', [f.other]), dev = await f.ask('create', session(f, 'Panel · dev'));
    assert.equal((await f.confirm(dev)).state, 'complete');
    const late = await f.confirm(archive);
    assert.equal(late.state, 'unconfirmed'); assert.match(late.error, /operation target changed/i);
    assert.notEqual(f.rooms.apply(f.workspace.snapshot()).sessions.find(s => s.id === f.other).archived, true);
  });
}
// 80184fc5 (2026-11-13): the butler asked to create "Claude 5" again under a new operation id while the first card
// still waited; the person saw two equal cards side by side, each with the raw command twice and no sign that
// skipPermissions loosens permissions, and nearly created two sessions.
const rowFor = (f, controller, pending) => controller.rows(f.actor.id, f.labels.apply(f.rooms.apply(f.workspace.snapshot())))
  .find(r => r.backgroundOperation.id === pending.id).backgroundOperation;
for (const provider of ['claude', 'codex']) {
  test(`${provider}: a creation card is one sentence with its risk marked, and its raw command once`, async t => {
    const f = await fixture(t, provider);
    const card = await f.ask('create', session(f, 'Claude 5', { skipPermissions: true }));
    const row = rowFor(f, f.controller, card);
    assert.deepEqual(row.summary, { action: 'create', method: 'create', risks: ['skipPermissions'], name: 'Claude 5', provider, folder: path.basename(f.dir) });
    assert.equal(JSON.parse(row.arguments)[0].skipPermissions, true);
    assert.equal(row.replacedBy, null); assert.equal(row.repeated, null);
  });
  test(`${provider}: a card asked again is void on the old card, and the old one cannot be confirmed after the new one`, async t => {
    const f = await fixture(t, provider);
    const first = await f.ask('create', session(f, 'Claude 5')), again = await f.ask('create', session(f, 'Claude 5'));
    assert.notEqual(first.id, again.id);
    assert.equal(rowFor(f, f.controller, first).replacedBy.state, 'waiting'); assert.equal(rowFor(f, f.controller, again).replacedBy, null);
    // A request with other arguments is a different request, not a copy.
    const other = await f.ask('create', session(f, 'Claude 6'));
    assert.equal(rowFor(f, f.controller, other).replacedBy, null); assert.equal(rowFor(f, f.controller, again).replacedBy, null);
    assert.equal((await f.confirm(again)).state, 'complete');
    assert.equal(rowFor(f, f.controller, first).replacedBy.state, 'confirmed');
    await assert.rejects(f.confirm(first), /同样的请求已在之后的卡上确认过/);
    assert.equal(f.named('Claude 5').length, 1);
    // Cancelling the old card stays possible: it releases the agent's slot and carries nothing out.
    assert.equal((await f.controller.decide(f.actor.id, f.actor.nativeId, first.id, 0)).state, 'cancelled');
  });
  test(`${provider}: a card is refused once the same request was confirmed on any later card, even with a newer one still waiting`, async t => {
    const f = await fixture(t, provider);
    const first = await f.ask('create', session(f, 'Claude 5')), middle = await f.ask('create', session(f, 'Claude 5')), last = await f.ask('create', session(f, 'Claude 5'));
    assert.equal((await f.confirm(middle)).state, 'complete');
    assert.equal(rowFor(f, f.controller, first).replacedBy.state, 'waiting');
    await assert.rejects(f.confirm(first), /同样的请求已在之后的卡上确认过/);
    assert.equal(f.named('Claude 5').length, 1);
    assert.equal((await f.controller.decide(f.actor.id, f.actor.nativeId, last.id, 0)).state, 'cancelled');
  });
  test(`${provider}: an agent's own view of its rows carries no card words`, async t => {
    const f = await fixture(t, provider);
    const card = await f.ask('create', session(f, 'Claude 5', { skipPermissions: true }));
    const row = f.controller.rows(f.actor.id, null).find(r => r.backgroundOperation.id === card.id).backgroundOperation;
    for (const field of ['summary', 'arguments', 'replacedBy', 'repeated', 'error']) assert.equal(Object.hasOwn(row, field), false, field);
    assert.equal(row.state, 'confirmation-required');
  });
  test(`${provider}: a card for a request the person already confirmed says so`, async t => {
    const f = await fixture(t, provider);
    assert.equal((await f.confirm(await f.ask('create', session(f, 'Claude 5')))).state, 'complete');
    const again = await f.ask('create', session(f, 'Claude 5')), other = await f.ask('create', session(f, 'Claude 6'));
    assert.equal(typeof rowFor(f, f.controller, again).repeated.time, 'number'); assert.equal(rowFor(f, f.controller, again).replacedBy, null);
    assert.equal(rowFor(f, f.controller, other).repeated, null);
  });
}
