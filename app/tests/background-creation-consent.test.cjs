// Several creation requests waiting for the person at once (2026-11-13: the butler asked for a new space and two
// sessions; the person confirmed all three and only the space was created, the other two were left "unconfirmed:
// The operation target changed before execution"). Real Workspace, RoomState and SessionLabels, with main.cjs's own
// consent fingerprint and maintenance handlers. All native activity is synthetic.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const { randomUUID } = require('node:crypto'), { EventEmitter } = require('node:events');
const { BackgroundControl, dialog } = require('../background-control.cjs'), operation = require('../background-operation.cjs');
const { RoomState } = require('../room-state.cjs'), { Workspace } = require('../workspace.cjs'), { SessionLabels } = require('../session-labels.cjs');
const main = fs.readFileSync(require.resolve('../main.cjs'), 'utf8');
function part(start, end) { const a = main.indexOf(start), b = main.indexOf(end, a + start.length); assert.ok(a >= 0 && b > a, start); return main.slice(a, b); }
async function fixture(t, provider) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-creation-consent-'));
  const host = { binaries: {}, close() {}, create(record) { record.nativeId ||= randomUUID(); const runtime = new EventEmitter(); runtime.start = async () => runtime.emit('state', 'idle'); runtime.stop = async () => ({ state: 'ended' }); return runtime; } };
  const workspace = new Workspace(host, dir), rooms = new RoomState(dir), labels = new SessionLabels(dir); let controller;
  workspace.nativeHistory.ready = async () => {};
  workspace.nativeHistory.read = async nativeId => ({ nativeId, cwd: dir, name: 'Imported' });
  t.after(async () => { await controller?.close(); workspace.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const id = await workspace.create(provider, dir, 'owner', 'Butler'), other = await workspace.create(provider, dir, 'owner', 'Other');
  const calls = [];
  const client = { snapshot: () => workspace.snapshot(), refresh: async () => workspace.snapshot(), close() {}, call: async (method, ...args) => {
    calls.push(method);
    if (method === 'initial') return { ...workspace.snapshot(), capabilities: ['nativePermissionDefaults', 'singleHomeMoveV1'] };
    // Synthetic transport only: archive pauses routing, never a native process.
    if (method === 'pause' || method === 'pauseSpace') return;
    if (method === 'moveMembership') return workspace.moveMembership(...args);
    if (method === 'create') { const o = args[0]; return workspace.create(o.provider, o.cwd, 'owner', o.name, o.view); }
    if (method === 'resume') return workspace.resume(args[0], 'owner');
    if (method === 'importHistory') return workspace.importHistory(args[0], 'owner', args[1]);
    throw Error('Unexpected business call: ' + method);
  } };
  // One backend that has adopted background control, as main.cjs checks before a non-local command.
  Object.defineProperty(client, 'entries', { get: () => [{ key: 'backend', state: { ...workspace.snapshot(), capabilities: [operation.CAPABILITY] } }] });
  const actor = { id, nativeId: workspace.get(id).nativeId, provider, name: 'Butler' };
  const c = { background: true, actor, client, view: {}, refresh: client.refresh, win: { destroy() {}, isDestroyed: () => false } };
  const handlers = new Map();
  const scope = vm.createContext({ context: c, client, actor, roomState: rooms, sessionLabels: labels, backgroundOperation: operation, roomIds: require('../collaboration-spaces.cjs').roomIds,
    applicationHandlers: handlers, ipcMain: { handle() {} }, showDialog: (context, kind, options) => dialog(context, kind, options), displayText: (key, params) => require('../ui-locale.js').format('en', key, params), uiError: require('../ui-errors.cjs').uiError,
    assertNativeCreation: require('../submission-policy.cjs').assertNativeCreation, capabilitiesFor: () => ['resume', 'resubscribe', 'transportReconnect'],
    validRoomId: require('../collaboration-spaces.cjs').roomId,
    creationDefaults: { remember() { throw Error('A background creation must not save desktop defaults'); } }, broadcastRoom: async () => {} });
  vm.runInContext(part('function controlRequestActors(', '\nfunction projectBackgroundRecord('), scope);
  vm.runInContext(part('      context.confirmationActors =', '      context.fingerprint ='), scope);
  vm.runInContext(part('      context.fingerprint = command =>', '\n      context.delivery ='), scope);
  vm.runInContext(part('function roomArchiveDetail(', '\nfunction register('), scope);
  vm.runInContext(part('function register(', '\nasync function replaceBackendSockets('), scope);
  for (const [start, end] of [["  register('archiveSession',", "  register('spaceMerge',"], ["  register('spaceAction',", "  register('spaceFiles',"],
    ["  register('create',", "  register('nativeHistory',"], ["  register('importHistory',", "  register('butlerReview',"],
    ["  for (const action of ['resume', 'forget'])", "  register('stop',"]])
    vm.runInContext(part(start, end), scope);
  // The card carries what main.cjs shows: its detail names the sessions and spaces the request refers to.
  const confirmation = vm.runInContext('(' + part('    confirmation: (actor, command, action, context) => {', '\n    audit:').trim().slice('confirmation: '.length).replace(/,$/, '') + ')', scope);
  controller = new BackgroundControl({ dataDir: dir, handlers, context: () => c, confirmation, audit() {} });
  const ask = (method, args, operationId = randomUUID()) => controller.call({ sender: actor, identity: { callId: 'call-' + operationId, turnId: 'turn' }, valid: () => true },
    { action: 'invoke', method, arguments: args, operation_id: operationId });
  const confirm = pending => controller.decide(id, actor.nativeId, pending.id, 1);
  const cancel = pending => controller.decide(id, actor.nativeId, pending.id, 0);
  const named = name => labels.apply(workspace.snapshot()).sessions.filter(s => s.name === name);
  const spaces = name => rooms.apply(workspace.snapshot()).rooms.filter(r => r.name === name);
  return { dir, workspace, client, rooms, labels, actor, other, ask, confirm, cancel, named, spaces, calls };
}
const archived = (f, id) => f.rooms.apply(f.workspace.snapshot()).sessions.find(s => s.id === id).archived;
const addSession = f => f.workspace.create('codex', f.dir, 'owner', 'Unrelated');
const join = (f, id, room = 'shared', joined = true) => f.rooms.membership(f.client, id, joined, undefined, room);
async function refused(f, card, pattern = /operation target changed/i) {
  assert.equal(card.state, 'confirmation-required', card.error);
  const before = f.calls.length, result = await f.confirm(card);
  assert.equal(result.state, 'unconfirmed'); assert.match(result.error, pattern);
  assert.equal(f.calls.length, before, 'Refusal must happen before the business handler');
}
for (const method of ['archiveSession', 'restoreSession', 'resume', 'importHistory']) {
  test(`${method}: unrelated stop, placement, archive and room changes leave the card valid`, async t => {
    const f = await fixture(t, 'codex'), c = await addSession(f);
    if (method === 'restoreSession') await f.rooms.archiveSession(f.client, f.other);
    if (method === 'resume') await f.workspace.stop(f.other);
    const args = method === 'importHistory' ? [randomUUID()] : [f.other];
    const card = await f.ask(method, args);
    assert.equal(card.state, 'confirmation-required', card.error);
    const room = f.rooms.create('Elsewhere'); await join(f, c, room); await join(f, c, room, false);
    await f.workspace.stop(c); await f.rooms.archiveSession(f.client, c); f.rooms.rename('Changed elsewhere', room);
    const result = await f.confirm(card);
    assert.equal(result.state, 'complete', result.error);
    if (method === 'archiveSession' || method === 'restoreSession') assert.equal(archived(f, f.other), method === 'archiveSession');
    if (method === 'resume') assert.equal(f.workspace.get(f.other).state, 'idle');
    if (method === 'importHistory') assert.equal(f.workspace.get(result.value).nativeId, args[0]);
  });
}
for (const change of ['move-in', 'move-out', 'move-away-and-back', 'archive', 'reconnect', 'native-id', 'pending-identity']) {
  test(`archiveSession: target ${change} still voids the card`, async t => {
    const f = await fixture(t, 'codex');
    if (change === 'move-out') await join(f, f.other);
    const card = await f.ask('archiveSession', [f.other]);
    if (change === 'move-in' || change === 'move-away-and-back') await join(f, f.other, f.rooms.create('Destination'));
    if (change === 'move-out') await join(f, f.other, 'shared', false);
    if (change === 'move-away-and-back') await join(f, f.other, f.workspace.get(f.other).roomIds[0], false);
    if (change === 'archive') await f.rooms.archiveSession(f.client, f.other);
    if (change === 'reconnect') { await f.workspace.stop(f.other); await f.workspace.resume(f.other, 'owner'); }
    if (change === 'native-id') f.workspace.get(f.other).nativeId = randomUUID();
    if (change === 'pending-identity') f.workspace.get(f.other).nativeContextPending = true;
    await refused(f, card);
    assert.equal(archived(f, f.other), change === 'archive');
  });
}
for (const change of ['move', 'archive', 'native-id', 'pending-identity', 'reconnect']) {
  test(`archiveSession: asking session ${change} still voids the card`, async t => {
    const f = await fixture(t, 'codex'), card = await f.ask('archiveSession', [f.other]);
    if (change === 'move') await join(f, f.actor.id);
    if (change === 'archive') await f.rooms.archiveSession(f.client, f.actor.id);
    if (change === 'native-id') f.workspace.get(f.actor.id).nativeId = randomUUID();
    if (change === 'pending-identity') f.workspace.get(f.actor.id).nativeContextPending = true;
    if (change === 'reconnect') { await f.workspace.stop(f.actor.id); await f.workspace.resume(f.actor.id, 'owner'); }
    await refused(f, card, ['move', 'reconnect'].includes(change) ? /operation target changed/i : /originating native session changed/i);
    assert.equal(archived(f, f.other), false);
  });
}
for (const sameRoom of [false, true]) {
  test(`two archive cards both succeed: ${sameRoom ? 'shared home' : 'independent targets'}`, async t => {
    const f = await fixture(t, 'codex'), b = await addSession(f);
    if (sameRoom) { await join(f, f.other); await join(f, b); }
    const aCard = await f.ask('archiveSession', [f.other]), bCard = await f.ask('archiveSession', [b]);
    const first = await f.confirm(aCard); assert.equal(first.state, 'complete', first.error); assert.equal(archived(f, f.other), true);
    const second = await f.confirm(bCard); assert.equal(second.state, 'complete', second.error); assert.equal(archived(f, b), true);
  });
}
for (const roomKind of ['shared', 'named']) for (const order of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
  test(`${roomKind}: three archive cards succeed in order ${order.join('')} and restore to their original space`, async t => {
    const f = await fixture(t, 'codex'), ids = [f.other, await addSession(f), await addSession(f)];
    const room = roomKind === 'shared' ? 'shared' : f.rooms.create('Original');
    for (const id of ids) await join(f, id, room);
    const cards = [];
    for (const id of ids) cards.push(await f.ask('archiveSession', [id]));
    assert.ok(cards.every(card => card.state === 'confirmation-required'));
    assert.ok(ids.every(id => !archived(f, id)), 'Asking must not archive any member');
    for (const index of order) {
      const result = await f.confirm(cards[index]);
      assert.equal(result.state, 'complete', result.error); assert.equal(result.humanDecision, 1);
      assert.equal(archived(f, ids[index]), true);
      const before = f.calls.length;
      await assert.rejects(f.confirm(cards[index]), /confirmation is no longer current/i);
      assert.equal(f.calls.length, before, 'A replay cannot enter the business handler');
    }
    // Reopen desktop archive metadata to prove the saved homes survive a restart.
    const cold = new RoomState(f.dir);
    for (const index of [...order].reverse()) {
      assert.equal(cold.value.sessionArchives[ids[index]].rooms[0].id, room);
      const restored = await cold.restoreSession(f.client, ids[index]);
      assert.equal(restored.placement, 'restored');
      assert.deepEqual(f.workspace.get(ids[index]).roomIds, [room]);
    }
  });
}
test('cancelling one same-space archive does not approve it or void its sibling', async t => {
  const f = await fixture(t, 'codex'), b = await addSession(f);
  await join(f, f.other); await join(f, b);
  const aCard = await f.ask('archiveSession', [f.other]), bCard = await f.ask('archiveSession', [b]);
  assert.equal((await f.cancel(aCard)).state, 'cancelled'); assert.equal(archived(f, f.other), false);
  assert.equal((await f.confirm(bCard)).state, 'complete'); assert.equal(archived(f, b), true);
  await assert.rejects(f.confirm(aCard), /confirmation is no longer current/i);
  assert.equal(archived(f, f.other), false);
});
for (const change of ['working', 'approval', 'active-turn', 'pending-input', 'deleted']) {
  test(`same-space archive still refuses its own target becoming ${change}`, async t => {
    const f = await fixture(t, 'codex'); await join(f, f.other);
    const card = await f.ask('archiveSession', [f.other]);
    if (change === 'working' || change === 'approval') f.workspace.runtimes.get(f.other).emit('state', change);
    if (change === 'active-turn') f.workspace.runtimes.get(f.other).turnId = 'synthetic-active-turn';
    if (change === 'pending-input') f.workspace.get(f.other).pendingTag = 'synthetic-pending-input';
    if (change === 'deleted') { await f.workspace.stop(f.other); f.workspace.forget(f.other); }
    const before = f.calls.length, result = await f.confirm(card);
    assert.equal(result.state, 'unconfirmed', result.error);
    assert.equal(f.calls.length, before, 'No handler or membership call after the target changed');
    assert.equal(f.rooms.value.archivedSessions.includes(f.other), false);
  });
}
for (const change of ['restore', 'archive-record', 'saved-room', 'native-id', 'reconnect']) {
  test(`restoreSession: target ${change} still voids the card`, async t => {
    const f = await fixture(t, 'codex'); await join(f, f.other); await f.rooms.archiveSession(f.client, f.other);
    const card = await f.ask('restoreSession', [f.other]);
    if (change === 'restore') await f.rooms.restoreSession(f.client, f.other);
    if (change === 'archive-record') f.rooms.value.sessionArchives[f.other].rooms[0].index++;
    if (change === 'saved-room') f.rooms.rename('Changed home');
    if (change === 'native-id') f.workspace.get(f.other).nativeId = randomUUID();
    if (change === 'reconnect') { await f.workspace.stop(f.other); await f.workspace.resume(f.other, 'owner'); }
    await refused(f, card);
    assert.equal(archived(f, f.other), change !== 'restore');
  });
}
for (const method of ['archiveRoom', 'restoreRoom', 'spaceArchive', 'spaceRestore']) {
  const restore = method === 'restoreRoom' || method === 'spaceRestore', scoped = method.startsWith('space');
  test(`${method}: unrelated sessions and spaces leave the card valid`, async t => {
    const f = await fixture(t, 'codex'), room = scoped ? f.rooms.create('Target') : 'shared';
    await join(f, f.other, room);
    if (restore) await f.rooms.archiveRoom(f.client, f.labels.labels, room);
    const card = await f.ask(scoped ? 'spaceAction' : method, scoped ? [room, restore ? 'restore' : 'archive', []] : []);
    assert.equal(card.state, 'confirmation-required', card.error);
    const c = await addSession(f), elsewhere = f.rooms.create('Elsewhere'); await join(f, c, elsewhere);
    await f.workspace.stop(c); await f.rooms.archiveSession(f.client, c);
    const result = await f.confirm(card); assert.equal(result.state, 'complete', result.error);
    assert.equal(f.rooms.metadata(room).archived, !restore);
    assert.equal(f.workspace.get(f.other).roomIds.includes(room), restore);
  });
  for (const change of ['member-move', 'member-reconnect', 'member-archive', 'room-name', 'room-archive-state']) {
    test(`${method}: target ${change} voids the card`, async t => {
      const f = await fixture(t, 'codex'), room = scoped ? f.rooms.create('Target') : 'shared';
      await join(f, f.other, room);
      if (restore) await f.rooms.archiveRoom(f.client, f.labels.labels, room);
      const card = await f.ask(scoped ? 'spaceAction' : method, scoped ? [room, restore ? 'restore' : 'archive', []] : []);
      if (change === 'member-move') { if (restore) await f.rooms.restoreSession(f.client, f.other); await join(f, f.other, f.rooms.create('Destination')); }
      if (change === 'member-reconnect') { await f.workspace.stop(f.other); await f.workspace.resume(f.other, 'owner'); }
      if (change === 'member-archive') await f.rooms[restore ? 'restoreSession' : 'archiveSession'](f.client, f.other);
      if (change === 'room-name') f.rooms.rename('Changed target', room);
      if (change === 'room-archive-state') await f.rooms[restore ? 'restoreRoom' : 'archiveRoom'](f.client, f.labels.labels, room);
      await refused(f, card);
    });
  }
}
for (const change of ['archive', 'reconnect', 'move']) {
  test(`resume: target ${change} voids the card`, async t => {
    const f = await fixture(t, 'codex'); await f.workspace.stop(f.other);
    const card = await f.ask('resume', [f.other]);
    if (change === 'archive') await f.rooms.archiveSession(f.client, f.other);
    if (change === 'reconnect') await f.workspace.resume(f.other, 'owner');
    if (change === 'move') await join(f, f.other);
    await refused(f, card);
  });
}
for (const provider of ['codex', 'claude']) {
  test(`importHistory ${provider}: a record for the requested native identity appearing voids the card`, async t => {
    const f = await fixture(t, 'codex'), nativeId = randomUUID(), options = { provider, cwd: f.dir };
    const card = await f.ask('importHistory', [provider === 'claude' ? nativeId.toUpperCase() : nativeId, options]);
    await f.workspace.importHistory(nativeId, 'owner', options);
    await refused(f, card);
  });
  test(`importHistory ${provider}: changes to its existing record void the card`, async t => {
    const f = await fixture(t, provider), card = await f.ask('importHistory', [f.workspace.get(f.other).nativeId, { provider, cwd: f.dir }]);
    await f.rooms.archiveSession(f.client, f.other);
    await refused(f, card);
  });
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
  test(`${provider}: creating an unrelated session does not void a waiting archive`, async t => {
    const f = await fixture(t, provider);
    const archive = await f.ask('archiveSession', [f.other]), dev = await f.ask('create', session(f, 'Panel · dev'));
    assert.equal((await f.confirm(dev)).state, 'complete');
    const late = await f.confirm(archive);
    assert.equal(late.state, 'complete', late.error);
    assert.equal(f.rooms.apply(f.workspace.snapshot()).sessions.find(s => s.id === f.other).archived, true);
  });
}

for (const named of [false, true]) for (const change of ['idle-to-working', 'working-to-idle']) {
  test(`space archive consent binds eligible members: ${named ? 'named' : 'shared'}, ${change}`, async t => {
    const f = await fixture(t, 'codex'), room = named ? f.rooms.create('Target') : 'shared';
    await join(f, f.other, room);
    f.workspace.get(f.other).state = change === 'idle-to-working' ? 'idle' : 'working';
    const card = await f.ask(named ? 'spaceAction' : 'archiveRoom', named ? [room, 'archive', []] : []);
    assert.ok(card.confirmation.options.detail.includes(f.other));
    f.workspace.get(f.other).state = change === 'idle-to-working' ? 'working' : 'idle';
    await refused(f, card); assert.equal(archived(f, f.other), false);
  });
}
test('a background archive cannot expand consent after its guard check and before the handler runs', async t => {
  const f = await fixture(t, 'codex'); await join(f, f.other);
  f.workspace.get(f.other).state = 'working';
  const card = await f.ask('archiveRoom', []), call = f.client.call;
  f.client.call = async (method, ...args) => {
    if (method === 'initial') f.workspace.get(f.other).state = 'idle';
    return call(method, ...args);
  };
  const result = await f.confirm(card);
  assert.equal(result.state, 'unconfirmed'); assert.equal(archived(f, f.other), false);
  assert.equal(f.rooms.value.archived, false);
});
