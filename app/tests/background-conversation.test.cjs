const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const { BackgroundControl } = require('../background-control.cjs'), operation = require('../background-operation.cjs'), locale = require('../ui-locale.js');
const main = fs.readFileSync(require.resolve('../main.cjs'), 'utf8');
function part(start, end) { const a = main.indexOf(start), b = main.indexOf(end, a + start.length); assert.ok(a >= 0 && b > a); return main.slice(a, b); }
const command = (method, args = [], operation_id = randomUUID()) => ({ action: 'invoke', method, arguments: args, operation_id });

for (const provider of ['claude', 'codex']) for (const reason of ['conversation-access-denied', 'space-file-membership-required', 'conversation-target-unavailable'])
test(`${provider}: pre-consent ${reason} is explicitly not executed and summarized`, async t => {
  const f = reason === 'space-file-membership-required' ? spaceFileFixture(t, provider) : fixture(t, provider);
  f.controller.now = () => 60000;
  const other = f.state.sessions.find(s => s.id === 'other'); let entered = 0;
  const method = reason === 'conversation-access-denied' ? 'terminalSnapshot' : reason === 'space-file-membership-required' ? 'spaceFiles' : 'initial';
  f.config.handlers.set(method, () => { entered++; throw Error('Denied handler must never run'); });
  if (reason === 'conversation-access-denied') f.sandbox.secretary = { sessionId: f.actor.id, nativeId: f.actor.nativeId };
  if (reason === 'space-file-membership-required') f.state.sessions[0].roomIds = [];
  if (reason === 'conversation-target-unavailable') {
    await f.select('other');
    const confirmation = f.controller.confirmation;
    f.controller.confirmation = (...args) => { f.state.sessions = f.state.sessions.filter(s => s.id !== 'other'); return confirmation(...args); };
  }
  const before = f.controller.data.records.length;
  let result;
  for (let n = 0; n < 12; n++) {
    if (!f.state.sessions.includes(other)) f.state.sessions.push(other);
    result = await f.controller.call(f.binding, command(method, method === 'spaceFiles' ? ['shared', 'space-file'] : method === 'terminalSnapshot' ? ['other'] : [], 'denied-' + n));
    assert.equal(result.state, 'not-executed'); assert.equal(result.reason, reason);
    assert.equal(result.confirmation, undefined);
  }
  assert.equal(entered, 0); assert.equal(f.notices.length, 0);
  assert.equal(f.controller.data.records.length, before); assert.equal(f.controller.data.refusals.length, 1);
  assert.equal(f.controller.data.refusals[0].refusalSummary.count, 12);
  assert.equal((await f.controller.call(f.binding, { action: 'receipt', operation_id: result.id })).receipt.reason, reason);
});
function fixture(t, provider = 'codex', extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-conversation-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const actor = { id: 'agent', nativeId: 'native-agent', provider, name: 'Agent' }, handlers = new Map(), contexts = [], audits = [], notices = [];
  const secret = 'OTHER_PRIVATE_BODY', own = 'OWN_BODY', third = 'THIRD_PRIVATE_BODY';
  const session = (id, nativeId, name, body) => ({ id, nativeId, name, provider, state: 'idle', roomIds: [], messages: [{ id: id + '-message', role: 'assistant', text: body, images: [{ path: body }] }],
    nativeActivity: { label: body }, activity: body, activityUiMessage: { params: { reason: body } }, claudeQuestion: { questions: [{ question: body }] }, approval: { params: { command: body } }, approvals: [{ params: { input: body } }], nativeApproval: { requests: [{ question: body }] }, fleet: [{ task: body }], futurePrivateField: body, liveDraft: body, draft: body });
  const state = { sessions: [session(actor.id, actor.nativeId, actor.name, own), session('other', 'native-other', 'Other 中文', secret), session('third', 'native-third', 'Third', third)], rooms: [{ id: 'shared', name: 'Shared', messages: [{ text: 'SHARED_RECORD' }], queue: [{ id: 'queued-task', status: 'queued', assignee: 'agent', text: 'QUEUE_RECORD' }] }] };
  state.sessions[0].roomIds = ['shared'];
  const sandbox = { background: require('../background-control.cjs'), ...require('../shown-sessions.cjs'), backgroundOperation: operation, submissionState: s => s, sessionLabels: { apply: s => s }, roomState: { apply: s => s, value: { sessionArchives: {} }, metadata: () => ({ restoreMembers: [], restorePlacements: {} }) },
    queueSecretary: { current: () => sandbox.secretary || null }, backgroundControl: null, roomPeerIdentity: () => ({ nativeId: 'metadata' }), endedByMove: () => [], queueDispatcher: null, butlerIngress: null,
    confirmationInbox: require('../confirmation-inbox.cjs'), confirmationProjectionKey: '', windows: new Map(), operationsBlocks: -1, recordsChanged() {}, confirmationSnapshot: (client, snapshot) => snapshot || client.snapshot(),
    localVendorIcons: () => ({ openai: 'PRIVATE_VENDOR_IMAGE' }), stewardWake: null, sessionModelChanges: null,
    viewStorageWarning: '', viewStorageWarningUiMessage: null, backgroundUnavailable: false, outboxQuitFailed: false, outboxUnavailable: false,
    displayText: (key, params) => locale.format('zh', key, params), uiError: require('../ui-errors.cjs').uiError, applicationBuild: {}, app: { getVersion: () => 'fixture' }, localeWarning: '', preflight: () => ({}), notifyCapacity() {},
    require: id => require(id.replace('./', '../')),
    validViews: require('../view-store.cjs').validViews, saveViews() {}, structuredClone, register: (name, handler) => handlers.set(name, handler), roomIds: s => s.roomIds || [] };
  vm.createContext(sandbox);
  vm.runInContext(part('function displayState(', '\nfunction reportViewStorage('), sandbox);
  if (main.includes('function conversationReaderAllowed(')) vm.runInContext(part('function conversationReaderAllowed(', '\nfunction bindClient('), sandbox);
  vm.runInContext(part("  register('initial',", "  register('mobilePairing',"), sandbox);
  vm.runInContext(part("  register('viewState',", "  register('openLocalFile',"), sandbox);
  vm.runInContext(part("  register('newWindow',", "  register('copy',"), sandbox);
  const a = main.indexOf('    confirmation: (actor, command, action'), b = main.indexOf('\n    audit:', a);
  const confirmation = vm.runInContext('(' + main.slice(a + '    confirmation: '.length, b).trim().replace(/,$/, '') + ')', sandbox);
  const config = { dataDir: dir, handlers, confirmation, audit: record => audits.push(record), confirmationPending: record => notices.push(record),
    project: (record, context) => sandbox.projectBackgroundRecord ? sandbox.projectBackgroundRecord(record, context) : record,
    context: async (actor, saved) => {
      const client = { snapshot: () => state, refresh: async () => {}, call: async method => { assert.equal(method, 'initial'); return state; }, close() {} };
      const c = { background: true, actor, view: saved || { owner: randomUUID(), selected: actor.id, mode: 'chat', preference: 'chat', active: false }, client, checkActor() {}, refresh: client.refresh, win: { isDestroyed: () => false, destroy() {} } };
      sandbox.context = c; sandbox.client = client; sandbox.actor = actor;
      // Production captures this context's actor/client lexically. A shared VM
      // global would silently rebind older views when a second actor opens one.
      const scope = vm.createContext({ ...sandbox, context: c, client, actor });
      if (main.includes('      context.metadataOnly =')) vm.runInContext(part('      context.metadataOnly =', '\n      context.refresh ='), scope);
      vm.runInContext(part('      context.fingerprint = command =>', '\n      context.delivery ='), scope); contexts.push(c); return c;
    }, ...extra };
  const controller = new BackgroundControl(config); sandbox.backgroundControl = controller;
  const binding = { sender: actor, identity: { callId: randomUUID(), turnId: 'turn' }, valid: () => true };
  return { dir, actor, state, contexts, config, controller, binding, sandbox, audits, notices, secret, own, third,
    select: id => controller.call(binding, command('viewState', [{ selected: id, mode: 'chat' }])) };
}
for (const provider of ['claude', 'codex']) for (const kind of ['snapshot', 'initial']) test(`${provider} ${kind}: a space or missing selection returns metadata without conversation consent or audit`, async t => {
  const f = fixture(t, provider);
  for (const selected of ['room', 'missing-session', '']) {
    await f.select(selected);
    const audits = f.audits.length, notices = f.notices.length;
    const result = await f.controller.call(f.binding, kind === 'snapshot' ? { action: 'snapshot' } : command('initial', ['other']));
    assert.equal(result.state, 'complete', JSON.stringify(result));
    assert.equal(result.error, undefined);
    assert.equal(JSON.stringify(result).includes(f.secret), false);
    assert.ok(result.value.sessions.every(s => s.messages.length === 0));
    assert.ok(JSON.stringify(result.value).includes('SHARED_RECORD'));
    assert.equal(f.audits.length, audits); assert.equal(f.notices.length, notices);
  }
});
for (const provider of ['claude', 'codex']) test(`${provider}: repeated snapshots reuse only a current pending read, including after restart`, async t => {
  const f = fixture(t, provider); await f.select('other');
  const first = await f.controller.call(f.binding, { action: 'snapshot' }); assert.equal(first.state, 'confirmation-required');
  const audits = f.audits.length;
  for (let n = 0; n < 3; n++) {
    const again = await f.controller.call(f.binding, { action: 'snapshot' });
    assert.equal(again.id, first.id); assert.equal(again.state, 'confirmation-required'); assert.equal(again.duplicate, true);
    assert.equal(JSON.stringify(again).includes(f.secret), false);
  }
  assert.equal(f.audits.length, audits); assert.equal(f.notices.length, 1);
  const cold = new BackgroundControl(f.config); f.sandbox.backgroundControl = cold;
  assert.equal((await cold.call(f.binding, { action: 'snapshot' })).id, first.id); assert.equal(f.notices.length, 1);
  await cold.decide('agent', 'native-agent', first.id, 0);
  for (let n = 0; n < 3; n++) {
    const cancelled = await cold.call(f.binding, { action: 'snapshot' });
    assert.equal(cancelled.id, first.id); assert.equal(cancelled.state, 'cancelled');
  }
  const restarted = new BackgroundControl(f.config); f.sandbox.backgroundControl = restarted;
  assert.equal((await restarted.call(f.binding, { action: 'snapshot' })).id, first.id);
  assert.equal(f.notices.length, 1);
  const next = await cold.call(f.binding, { action: 'snapshot', operation_id: 'ask-again-explicitly' }); assert.notEqual(next.id, first.id);
  assert.equal(next.state, 'confirmation-required'); assert.equal(f.notices.length, 2);
  await cold.call(f.binding, command('viewState', [{ selected: 'third', mode: 'chat' }]));
  const third = await cold.call(f.binding, { action: 'snapshot' }); assert.notEqual(third.id, next.id);
  assert.ok(third.confirmation.options.detail.includes('Third'));
});
test('a replaced native target cannot reuse pending consent, and explicit operation IDs stay distinct', async t => {
  const f = fixture(t); await f.select('other');
  const first = await f.controller.call(f.binding, { action: 'snapshot' });
  f.state.sessions[1].nativeId = 'replacement';
  const replacement = await f.controller.call(f.binding, { action: 'snapshot' }); assert.notEqual(replacement.id, first.id);
  const explicit = await f.controller.call(f.binding, { action: 'snapshot', operation_id: 'explicit-read' });
  assert.equal(explicit.id, 'explicit-read'); assert.notEqual(explicit.id, replacement.id);
  await f.controller.decide('agent', 'native-agent', replacement.id, 1);
  // The remaining explicit read is current and may be reused; an approved copy alone never is.
  await f.controller.decide('agent', 'native-agent', explicit.id, 0);
  const fresh = await f.controller.call(f.binding, { action: 'snapshot' }); assert.equal(fresh.id, explicit.id); assert.equal(fresh.state, 'cancelled');
});
test('cancellation survives unrelated view edits, but a new selection or consent fingerprint releases it', async t => {
  const f = fixture(t); await f.select('other');
  const cancel = async () => {
    const row = await f.controller.call(f.binding, { action: 'snapshot' });
    assert.equal(row.state, 'confirmation-required');
    await f.controller.decide('agent', 'native-agent', row.id, 0); return row.id;
  };
  const id = await cancel();
  await f.controller.call(f.binding, command('viewState', [{ selected: 'other', mode: 'terminal' }]));
  assert.equal((await f.controller.call(f.binding, { action: 'snapshot' })).id, id);
  f.state.sessions[1].messages[0].text = 'NATIVE_PROGRESS_IS_NOT_NEW_CONSENT';
  assert.equal((await f.controller.call(f.binding, { action: 'snapshot' })).id, id);
  await f.select('third'); await f.select('other');
  const next = await cancel(); assert.notEqual(next, id);
  f.state.sessions[1].nativeId = 'new-native-target';
  const replaced = await f.controller.call(f.binding, { action: 'snapshot' });
  assert.equal(replaced.state, 'confirmation-required'); assert.notEqual(replaced.id, next);
});
test('a cancellation that has settled into its block is still the person\'s answer, also after a restart; a new selection still releases it', async t => {
  const DAY = 24 * 3600 * 1000; let clock = Date.UTC(2026, 10, 1, 12);
  const f = fixture(t); f.controller.now = () => clock; await f.select('other');
  const cancel = async controller => {
    const row = await controller.call(f.binding, { action: 'snapshot' });
    assert.equal(row.state, 'confirmation-required');
    await controller.decide('agent', 'native-agent', row.id, 0); return row.id;
  };
  const id = await cancel(f.controller);
  clock += 2 * DAY; await f.controller.call(f.binding, command('viewState', [{ selected: 'other', mode: 'terminal' }]));
  assert.equal(f.controller.data.records.some(r => r.id === id), false, 'The cancellation has moved to its block');
  assert.equal((await f.controller.call(f.binding, { action: 'snapshot' })).id, id);
  const reopened = new BackgroundControl(f.config); reopened.now = () => clock;
  assert.equal((await reopened.call(f.binding, { action: 'snapshot' })).id, id);
  clock += 2 * DAY; await reopened.call(f.binding, command('viewState', [{ selected: 'third', mode: 'chat' }]));
  clock += 2 * DAY; await reopened.call(f.binding, command('viewState', [{ selected: 'other', mode: 'chat' }]));
  const next = await cancel(reopened); assert.notEqual(next, id);
});

test('a cancellation that settles after a later change of selection is still released by it, as when nothing had settled', async t => {
  const DAY = 24 * 3600 * 1000, MINUTE = 60000; let clock = Date.UTC(2026, 10, 1, 12);
  const f = fixture(t); f.controller.now = () => clock; await f.select('other');
  clock += MINUTE; const asked = await f.controller.call(f.binding, { action: 'snapshot' }); assert.equal(asked.state, 'confirmation-required');
  clock += MINUTE; await f.select('third'); clock += MINUTE; await f.select('other');
  // The person answers the earlier question only now; the two selections settle a day before the cancellation does.
  clock += 10 * MINUTE; await f.controller.decide('agent', 'native-agent', asked.id, 0);
  clock += DAY - 5 * MINUTE; f.controller.commit(() => {});
  assert.equal(f.controller.data.records.some(r => r.id === asked.id), true, 'The cancellation has not settled yet');
  clock += DAY; f.controller.commit(() => {});
  assert.equal(f.controller.data.records.some(r => r.id === asked.id), false, 'Now it has, after the selections');
  const again = await f.controller.call(f.binding, { action: 'snapshot' });
  assert.equal(again.state, 'confirmation-required'); assert.notEqual(again.id, asked.id);
});

test('a cancelled read does not suppress an independent view or another actor', async t => {
  const f = fixture(t); await f.select('other');
  const cancelled = await f.controller.call(f.binding, { action: 'snapshot' });
  await f.controller.decide('agent', 'native-agent', cancelled.id, 0);
  const opened = await f.controller.call(f.binding, command('newWindow', ['other']));
  const independent = await f.controller.call(f.binding, { action: 'snapshot', view_id: opened.value.view_id });
  assert.equal(independent.state, 'confirmation-required'); assert.notEqual(independent.id, cancelled.id);
  const otherBinding = { ...f.binding, sender: { ...f.actor, id: 'third', nativeId: 'native-third', name: 'Third actor' } };
  const c = await f.controller.view(otherBinding.sender); c.view.selected = 'other';
  assert.equal(c.actor.id, 'third');
  const other = await f.controller.call(otherBinding, { action: 'snapshot' });
  assert.equal(other.state, 'confirmation-required'); assert.notEqual(other.id, cancelled.id);
  const original = await f.controller.call(f.binding, command('initial', [], 'return-to-original-actor'));
  assert.equal(original.state, 'confirmation-required');
});
for (const provider of ['claude', 'codex']) test(`${provider}: explicit read operations remain independent without repeating a pending notification`, async t => {
  const f = fixture(t, provider); await f.select('other');
  const a = await f.controller.call(f.binding, { action: 'snapshot', operation_id: 'explicit-a' });
  const b = await f.controller.call(f.binding, command('initial', [], 'explicit-b'));
  assert.notEqual(a.id, b.id); assert.equal(a.state, 'confirmation-required'); assert.equal(b.state, 'confirmation-required');
  assert.equal(f.notices.length, 1);
  await f.controller.decide('agent', 'native-agent', a.id, 0);
  const c = await f.controller.call(f.binding, { action: 'snapshot', operation_id: 'explicit-c' });
  assert.equal(c.state, 'confirmation-required'); assert.equal(f.notices.length, 1);
  await f.controller.decide('agent', 'native-agent', b.id, 0);
  await f.controller.decide('agent', 'native-agent', c.id, 0);
  await f.controller.call(f.binding, { action: 'snapshot', operation_id: 'explicit-d' });
  assert.equal(f.notices.length, 2);
  const opened = await f.controller.call(f.binding, command('newWindow', ['other']));
  await f.controller.call(f.binding, { action: 'snapshot', view_id: opened.value.view_id, operation_id: 'explicit-view' });
  assert.equal(f.notices.length, 3);
  await f.select('third'); await f.controller.call(f.binding, { action: 'snapshot', operation_id: 'explicit-third' });
  assert.equal(f.notices.length, 4);
});
for (const method of ['roomRename', 'spaceAction']) test(`${method}: a hosted space rename is confirmed against its original named space`, async t => {
  const f = fixture(t); let writes = 0;
  f.config.handlers.set(method, () => { writes++; });
  const args = command(method, method === 'roomRename' ? ['Replacement'] : ['shared', 'rename', ['Replacement']]);
  const pending = await f.controller.call(f.binding, args);
  assert.equal(pending.state, 'confirmation-required'); assert.equal(writes, 0);
  assert.ok(pending.confirmation.options.detail.includes('Shared'));
  f.state.rooms[0].name = 'Changed original space';
  assert.equal((await f.controller.decide('agent', 'native-agent', pending.id, 1)).state, 'unconfirmed');
  assert.equal(writes, 0);
});
for (const provider of ['claude', 'codex']) for (const kind of ['snapshot', 'initial']) test(`${provider} ${kind}: foreign conversation waits, cancels without a read, and one approval returns one bound snapshot`, async t => {
  const f = fixture(t, provider); await f.select('other');
  const read = () => kind === 'snapshot' ? { action: 'snapshot' } : command('initial');
  const pending = await f.controller.call(f.binding, read());
  assert.equal(pending.state, 'confirmation-required'); assert.equal(JSON.stringify(pending).includes(f.secret), false);
  assert.ok(pending.confirmation.options.detail.includes('Other 中文'));
  assert.ok(pending.confirmation.options.message.includes('Other 中文'));
  const before = JSON.stringify(f.contexts[0].view);
  assert.equal((await f.controller.decide('agent', 'native-agent', pending.id, 0)).state, 'cancelled');
  assert.equal(JSON.stringify(f.contexts[0].view), before);
  const second = await f.controller.call(f.binding, kind === 'snapshot' ? { action: 'snapshot', operation_id: 'explicit-after-cancel' } : read());
  const approved = await f.controller.decide('agent', 'native-agent', second.id, 1);
  assert.equal(approved.state, 'complete'); assert.equal(approved.value, undefined);
  f.state.sessions[1].messages[0].text = 'NEW_UNREAD_CONTENT';
  const receipt = await f.controller.call(f.binding, { action: 'receipt', operation_id: second.id });
  assert.ok(JSON.stringify(receipt).includes(f.secret)); assert.equal(JSON.stringify(receipt).includes('NEW_UNREAD_CONTENT'), false); assert.equal(JSON.stringify(receipt).includes(f.third), false);
  assert.equal((await f.controller.call(f.binding, read())).state, kind === 'snapshot' ? 'cancelled' : 'confirmation-required');
  assert.equal(JSON.stringify(f.sandbox.displayState(f.state, f.contexts[0])).includes(f.secret), false);
});
test('own snapshots and human windows keep their conversations; foreign unselected auxiliary fields are metadata-only', async t => {
  const f = fixture(t), facts = { intake: 'ready', activation: 'off', recordPeriod: 'off' };
  f.sandbox.butlerIngress = { status: () => facts };
  const wakeBlock = { since: 1000, minutes: 12, reason: 'source-unavailable' };
  f.sandbox.stewardWake = { view: () => ({ on: true, blocked: wakeBlock }) };
  const own = await f.controller.call(f.binding, { action: 'snapshot' });
  assert.equal(own.state, 'complete'); assert.ok(JSON.stringify(own.value).includes(f.own));
  assert.equal(JSON.stringify(own.value).includes(f.secret), false); assert.equal(JSON.stringify(own.value).includes(f.third), false);
  assert.equal(own.value.sessions.find(s => s.id === 'other').name, 'Other 中文');
  assert.ok(JSON.stringify(own.value).includes('SHARED_RECORD') && JSON.stringify(own.value).includes('QUEUE_RECORD'));
  assert.deepEqual(own.value.butler, facts);
  assert.equal(own.value.stewardWakeStatus, undefined, 'a global warning is only shown in the person window');
  const human = f.sandbox.displayState(f.state, { background: false, view: { selected: 'other' } });
  assert.ok(JSON.stringify(human).includes(f.secret)); assert.ok(JSON.stringify(human).includes(f.third));
  assert.deepEqual(human.butler, facts);
  assert.deepEqual(human.stewardWakeStatus, wakeBlock);
});
test('new hidden views and restored selections do not authorize a conversation read', async t => {
  const f = fixture(t), opened = await f.controller.call(f.binding, command('newWindow', ['other']));
  assert.equal(opened.state, 'complete');
  const pending = await f.controller.call(f.binding, { action: 'snapshot', view_id: opened.value.view_id });
  assert.equal(pending.state, 'confirmation-required'); assert.equal(JSON.stringify(pending).includes(f.secret), false);
  const cold = new BackgroundControl(f.config); f.sandbox.backgroundControl = cold;
  const restored = await cold.call(f.binding, { action: 'snapshot', view_id: opened.value.view_id });
  assert.equal(restored.state, 'confirmation-required'); assert.equal(JSON.stringify(restored).includes(f.secret), false);
});
test('changing selection or native identity while consent waits cannot reveal a different conversation', async t => {
  for (const mode of ['selection', 'native']) {
    const f = fixture(t); await f.select('other'); const pending = await f.controller.call(f.binding, { action: 'snapshot' });
    assert.equal(pending.state, 'confirmation-required');
    if (mode === 'selection') await f.select('third'); else f.state.sessions[1].nativeId = 'replacement-native';
    const result = await f.controller.decide('agent', 'native-agent', pending.id, 1);
    assert.equal(result.state, 'unconfirmed'); assert.equal(JSON.stringify(result).includes(f.secret), false); assert.equal(JSON.stringify(result).includes(f.third), false);
  }
});
test('a native replacement observed during the final read cannot reuse an earlier confirmation', async t => {
  const f = fixture(t); await f.select('other'); const pending = await f.controller.call(f.binding, { action: 'snapshot' });
  f.contexts[0].client.call = async () => { f.state.sessions[1].nativeId = 'replacement-during-read'; return f.state; };
  const result = await f.controller.decide('agent', 'native-agent', pending.id, 1);
  assert.equal(result.state, 'unconfirmed'); assert.equal(JSON.stringify(result).includes(f.secret), false);
});
test('the secretary designation does not grant foreign conversation access', async t => {
  const f = fixture(t); f.sandbox.secretary = { sessionId: f.actor.id, nativeId: f.actor.nativeId };
  const own = await f.controller.call(f.binding, { action: 'snapshot' }); assert.equal(own.state, 'complete'); assert.ok(JSON.stringify(own).includes('queued-task')); assert.equal(JSON.stringify(own).includes('QUEUE_RECORD'), false);
  await f.select('other'); const metadata = await f.controller.call(f.binding, { action: 'snapshot' });
  assert.equal(metadata.state, 'complete'); assert.equal(JSON.stringify(metadata).includes(f.secret), false); assert.ok(JSON.stringify(metadata).includes('queued-task')); assert.equal(JSON.stringify(metadata).includes('SHARED_RECORD'), false);
  const denied = await f.controller.call(f.binding, command('initial'));
  assert.equal(denied.state, 'not-executed'); assert.equal(denied.reason, 'conversation-access-denied'); assert.equal(JSON.stringify(denied).includes(f.secret), false);
});
test('private-image preview is a conversation read; shared and own images retain their existing path', async t => {
  const f = fixture(t); let reads = 0;
  f.config.handlers.set('previewImage', () => { reads++; return { thumbnail: f.secret }; });
  const source = { kind: 'session', sessionId: 'other', nativeId: 'native-other', messageId: 'known-message', index: 0 };
  const args = command('previewImage', [source]), pending = await f.controller.call(f.binding, args);
  assert.equal(pending.state, 'confirmation-required'); assert.equal(reads, 0); assert.equal(JSON.stringify(pending).includes(f.secret), false);
  const approved = await f.controller.decide('agent', 'native-agent', pending.id, 1);
  assert.equal(approved.state, 'complete'); assert.equal(approved.readTarget.name, 'Other 中文'); assert.equal(reads, 1);
  f.sandbox.secretary = { sessionId: 'agent', nativeId: 'native-agent' };
  assert.equal(JSON.stringify(await f.controller.call(f.binding, { action: 'receipt', operation_id: args.operation_id })).includes(f.secret), false);
  assert.equal(operation.maintenanceAction('previewImage', [{ ...source, kind: 'room' }], f.actor), null);
  assert.equal(operation.maintenanceAction('previewImage', [{ ...source, sessionId: 'agent' }], f.actor), null);
});
test('old unapproved initial receipts and duplicate calls cannot reveal saved foreign conversation data', async t => {
  const f = fixture(t); await f.select('other'); const args = command('initial', ['other'], 'legacy-initial');
  f.controller.commit(data => data.records.push({ id: args.operation_id, actor: { ...f.actor, callId: 'old-call', turnId: 'old-turn', operationId: args.operation_id }, command: args, state: 'complete', value: { ...f.state, viewState: { selected: 'other' } } }));
  const receipt = await f.controller.call(f.binding, { action: 'receipt', operation_id: args.operation_id });
  assert.equal(JSON.stringify(receipt).includes(f.secret), false); assert.equal(JSON.stringify(receipt).includes(f.third), false);
  const duplicate = await f.controller.call(f.binding, args); assert.equal(duplicate.duplicate, true); assert.equal(JSON.stringify(duplicate).includes(f.secret), false);
});
test('cached image reads recheck the secretary restriction before resolving the private source', async () => {
  let calls = 0;
  const actor = { id: 'agent', nativeId: 'native-agent' }, c = { background: true, actor, client: { call: async () => { calls++; return {}; } } };
  const sandbox = { nativeImage: {}, ImagePreviews: class { constructor(options) { this.options = options; } }, roomState: { apply: value => value },
    conversationReaderAllowed: () => false, conversationAccess: () => ({ secretary: true, roomIds: [] }), uiError: require('../ui-errors.cjs').uiError, context: c };
  vm.createContext(sandbox); vm.runInContext(part('  const imagesFor =', "  register('previewImage',"), sandbox);
  const previews = vm.runInContext('imagesFor(context)', sandbox);
  await assert.rejects(previews.options.snapshot({ kind: 'session', sessionId: 'other' })); assert.equal(calls, 0);
  await previews.options.snapshot({ kind: 'session', sessionId: 'agent' }); assert.equal(calls, 1);
  await assert.rejects(previews.options.snapshot({ kind: 'room', sessionId: 'other' })); assert.equal(calls, 2);
});
for (const provider of ['claude', 'codex']) test(`${provider}: an approved read is delivered once, stays frozen, and never stores its body in the receipt file`, async t => {
  const f = fixture(t, provider); await f.select('other');
  const pending = await f.controller.call(f.binding, { action: 'snapshot' });
  const approved = await f.controller.decide('agent', 'native-agent', pending.id, 1);
  assert.equal(approved.state, 'complete'); assert.equal(approved.value, undefined, 'Person approval returns only the receipt');
  assert.equal(fs.readFileSync(f.controller.file, 'utf8').includes(f.secret), false, 'No durable conversation body, even before pickup');
  f.state.sessions[1].messages[0].text = 'AFTER_APPROVAL_BODY';
  const read = await f.controller.call(f.binding, { action: 'receipt', operation_id: pending.id });
  assert.ok(JSON.stringify(read.receipt.value).includes(f.secret)); assert.equal(JSON.stringify(read).includes('AFTER_APPROVAL_BODY'), false);
  assert.equal(read.receipt.readState, 'consumed'); assert.ok(Number.isFinite(read.receipt.readConsumedAt));
  assert.equal(read.receipt.readTarget.sessionId, 'other'); assert.equal(read.receipt.readTarget.name, 'Other 中文');
  assert.equal(read.receipt.guard?.sessions, undefined, 'Settled reads retain audit routing, not a complete consent snapshot');
  assert.equal((await f.controller.call(f.binding, { action: 'receipt', operation_id: pending.id })).receipt.value, undefined);
  const duplicate = await f.controller.call(f.binding, command('initial', [], pending.id));
  assert.equal(duplicate.duplicate, true); assert.equal(duplicate.value, undefined);
  assert.equal(fs.readFileSync(f.controller.file, 'utf8').includes(f.secret), false);
});
test('a duplicate invocation can pick up a read once; cold restart expires unread copies without replay', async t => {
  const f = fixture(t); await f.select('other');
  const pending = await f.controller.call(f.binding, { action: 'snapshot' }); await f.controller.decide('agent', 'native-agent', pending.id, 1);
  const first = await f.controller.call(f.binding, command('initial', [], pending.id));
  assert.equal(first.duplicate, true); assert.ok(JSON.stringify(first.value).includes(f.secret));
  assert.equal((await f.controller.call(f.binding, { action: 'receipt', operation_id: pending.id })).receipt.value, undefined);
  const next = await f.controller.call(f.binding, { action: 'snapshot' }); await f.controller.decide('agent', 'native-agent', next.id, 1);
  for (const stage of ['available', 'pending']) {
    const saved = structuredClone(f.controller.data); saved.records.find(r => r.id === next.id).readState = stage;
    fs.writeFileSync(f.controller.file, JSON.stringify(saved), { mode: 0o600 });
    const cold = new BackgroundControl(f.config); f.sandbox.backgroundControl = cold;
    const expired = await cold.call(f.binding, { action: 'receipt', operation_id: next.id });
    assert.equal(expired.receipt.readState, 'expired'); assert.equal(expired.receipt.value, undefined);
    assert.equal(JSON.stringify(expired).includes(f.secret), false);
  }
});
test('old stored read bodies are removed on load; an exhausted copy budget leaves background control usable', async t => {
  const f = fixture(t, 'codex', { readCopyBytes: 1 }); await f.select('other');
  const pending = await f.controller.call(f.binding, { action: 'snapshot' }); await f.controller.decide('agent', 'native-agent', pending.id, 1);
  const limited = await f.controller.call(f.binding, { action: 'receipt', operation_id: pending.id });
  assert.equal(limited.receipt.readState, 'expired'); assert.equal(limited.receipt.readReason, 'copy-budget'); assert.equal(limited.receipt.value, undefined);
  f.config.handlers.set('rename', () => 'still usable');
  assert.equal((await f.controller.call(f.binding, command('rename', ['agent', 'Name']))).state, 'complete');
  const legacy = structuredClone(f.controller.data); legacy.records[0] = { ...legacy.records.find(r => r.id === pending.id), value: f.state };
  fs.writeFileSync(f.controller.file, JSON.stringify(legacy), { mode: 0o600 });
  const cold = new BackgroundControl(f.config);
  assert.equal(fs.readFileSync(cold.file, 'utf8').includes(f.secret), false);
  assert.equal(cold.receipt(f.actor, pending.id).value, undefined);
});
test('the unread-copy budget evicts older copies without retaining them in the durable ledger', async t => {
  const f = fixture(t, 'codex', { readCopyBytes: 1024 }); await f.select('other');
  f.config.handlers.set('initial', () => ({ sessions: [{ id: 'other', nativeId: 'native-other', name: 'Other', messages: [{ text: 'COPY_BODY_' + 'x'.repeat(400) }] }] }));
  const ids = [];
  for (let n = 0; n < 3; n++) {
    const pending = await f.controller.call(f.binding, { action: 'snapshot' }); ids.push(pending.id);
    await f.controller.decide('agent', 'native-agent', pending.id, 1);
  }
  assert.equal((await f.controller.call(f.binding, { action: 'receipt', operation_id: ids[0] })).receipt.readState, 'expired');
  const last = await f.controller.call(f.binding, { action: 'receipt', operation_id: ids.at(-1) });
  assert.ok(JSON.stringify(last).includes('COPY_BODY_'));
  assert.equal(fs.readFileSync(f.controller.file, 'utf8').includes('COPY_BODY_'), false);
});
test('navigation receipts do not expose native questions, while changed question content still invalidates consent', async t => {
  const f = fixture(t), selected = await f.select('other');
  assert.equal(JSON.stringify(selected).includes(f.secret), false);
  assert.equal(selected.guard.sessions[0].approval, undefined);
  let writes = 0;
  f.config.handlers.set('input', c => require('../background-control.cjs').dialog(c, 'message', { buttons: ['Cancel', 'Confirm'], cancelId: 0 }).then(() => writes++));
  const pending = await f.controller.call(f.binding, command('input', ['agent', 'input'])); assert.equal(pending.state, 'confirmation-required');
  assert.match(pending.guard.sessions[0].approval, /^sha256:[a-f0-9]{64}$/);
  f.state.sessions[0].approval.params.command = 'CHANGED_NATIVE_QUESTION';
  const refused = await f.controller.decide('agent', 'native-agent', pending.id, 1);
  assert.equal(refused.state, 'unconfirmed'); assert.equal(refused.disposition, 'invalidated'); assert.equal(refused.resultNotice.key, 'background.card.reason.partial-operation'); assert.equal(writes, 0);
  assert.equal(fs.readFileSync(f.controller.file, 'utf8').includes('CHANGED_NATIVE_QUESTION'), false);
});
for (const mode of ['leave', 'secretary', 'native']) test(`a frozen receipt uses current space authority, not saved membership: ${mode}`, async t => {
  const f = fixture(t); await f.select('other');
  const pending = await f.controller.call(f.binding, { action: 'snapshot' }); await f.controller.decide('agent', 'native-agent', pending.id, 1);
  if (mode === 'leave') f.state.sessions[0].roomIds = [];
  if (mode === 'native') f.state.sessions[0].nativeId = 'replacement-actor';
  if (mode === 'secretary') f.sandbox.secretary = { sessionId: 'agent', nativeId: 'native-agent' };
  const receipt = await f.controller.call(f.binding, { action: 'receipt', operation_id: pending.id });
  assert.equal(JSON.stringify(receipt).includes('SHARED_RECORD'), false); assert.equal(JSON.stringify(receipt).includes('QUEUE_RECORD'), false);
  assert.equal(receipt.receipt.value.rooms[0].queue[0].status, 'queued');
  if (mode === 'secretary') assert.equal(JSON.stringify(receipt).includes(f.secret), false);
});
test('the final actual initial handler filters its view, preflight, build and future fields while human windows stay complete', async t => {
  const f = fixture(t), c = await f.controller.view(f.actor);
  c.view.sharedDraft = 'PRIVATE_VIEW_BODY'; c.view.roomViews = { shared: { roomSearch: 'PRIVATE_QUERY' } };
  f.state.futurePrivate = 'PRIVATE_TOP'; f.state.peerLeases = [{ result: { text: 'PRIVATE_LEASE' } }];
  f.sandbox.applicationBuild = { version: 'fixture', commit: null, installedAt: null, future: 'PRIVATE_BUILD' };
  f.sandbox.preflight = () => ({ codex: true, claude: false, python: true, paths: { codex: 'PRIVATE_PATH' } });
  const hosted = (await f.controller.call(f.binding, { action: 'snapshot' })).value;
  for (const secret of ['PRIVATE_VIEW_BODY','PRIVATE_QUERY','PRIVATE_TOP','PRIVATE_LEASE','PRIVATE_BUILD','PRIVATE_PATH','PRIVATE_VENDOR_IMAGE']) assert.equal(JSON.stringify(hosted).includes(secret), false, secret);
  const human = await f.config.handlers.get('initial')({ background: false, client: c.client, view: c.view });
  assert.equal(human.viewState.sharedDraft, 'PRIVATE_VIEW_BODY'); assert.equal(human.preflight.paths.codex, 'PRIVATE_PATH');
  assert.equal(human.vendorIcons.openai, 'PRIVATE_VENDOR_IMAGE');
});
test('published space images require current membership for every source check; a private draft stays this view own data', async t => {
  const f = fixture(t), c = await f.controller.view(f.actor), sandbox = f.sandbox;
  sandbox.nativeImage = {}; sandbox.ImagePreviews = class { constructor(options) { this.options = options; } };
  vm.runInContext(part('  const imagesFor =', "  register('previewImage',"), sandbox);
  sandbox.imageContext = c;
  const previews = vm.runInContext('imagesFor(imageContext)', sandbox);
  for (const kind of ['room', 'space-message']) {
    const source = { kind, roomId: 'shared' }; await previews.options.snapshot(source);
    f.state.sessions[0].roomIds = []; await assert.rejects(previews.options.snapshot(source));
    f.state.sessions[0].roomIds = ['shared']; f.sandbox.secretary = { sessionId: 'agent', nativeId: 'native-agent' };
    await assert.rejects(previews.options.snapshot(source)); delete f.sandbox.secretary;
  }
  f.state.sessions[0].roomIds = [];
  assert.equal(await previews.options.snapshot({ kind: 'space-draft', roomId: 'shared' }), null);
});
const terminalReadBodies = {
  terminalSnapshot: { buffer: 'TERMINAL_PRIVATE_SCREEN\r\n中文', sequence: 7, cols: 80, rows: 24 },
  observe: { terminal: 'OBSERVE_PRIVATE_SCREEN', progress: { items: [{ text: 'OBSERVE_PRIVATE_PROGRESS' }], revision: 1 } },
  terminal: '\u001b[31mTERMINAL_PRIVATE_SERIALIZED\u001b[0m',
};
for (const provider of ['claude', 'codex']) for (const [method, body] of Object.entries(terminalReadBodies)) for (const when of ['before-request', 'before-approval', 'before-pickup']) test(`${provider} ${method}: secretary designated ${when} cannot receive another session's terminal`, async t => {
  const f = fixture(t, provider); let reads = 0;
  f.config.handlers.set(method, () => { reads++; return body; });
  const designate = () => { f.sandbox.secretary = { sessionId: f.actor.id, nativeId: f.actor.nativeId }; };
  if (when === 'before-request') designate();
  const pending = await f.controller.call(f.binding, command(method, ['other']));
  if (when === 'before-request') {
    assert.equal(pending.state, 'not-executed'); assert.equal(pending.reason, 'conversation-access-denied'); assert.equal(pending.confirmation, undefined);
    assert.equal(reads, 0); assert.equal(f.notices.length, 0); return;
  }
  assert.equal(pending.state, 'confirmation-required'); assert.equal(f.notices.length, 1);
  if (when === 'before-approval') designate();
  const approved = await f.controller.decide(f.actor.id, f.actor.nativeId, pending.id, 1);
  if (when === 'before-approval') {
    assert.equal(approved.state, 'not-executed'); assert.equal(approved.reason, 'conversation-access-denied'); assert.equal(approved.confirmation, undefined);
    assert.equal(reads, 0); assert.equal(f.notices.length, 1); return;
  }
  assert.equal(approved.state, 'complete'); assert.equal(approved.readState, 'available'); assert.equal(approved.value, undefined);
  designate();
  const pickup = (await f.controller.call(f.binding, { action: 'receipt', operation_id: pending.id })).receipt;
  assert.equal(pickup.value, undefined); assert.equal(pickup.readState, 'consumed');
  assert.equal(typeof pickup.readConsumedAt, 'number'); assert.equal(reads, 1);
  assert.equal(f.controller.readCopies.size, 0); assert.equal(f.controller.readBytes, 0);
  delete f.sandbox.secretary;
  assert.equal((await f.controller.call(f.binding, { action: 'receipt', operation_id: pending.id })).receipt.value, undefined);
  assert.equal(fs.readFileSync(f.controller.file, 'utf8').includes('_PRIVATE_'), false);
});
for (const [method, body] of Object.entries(terminalReadBodies)) test(`${method}: an unreadable secretary role discards an approved copy on pickup`, async t => {
  const f = fixture(t); f.config.handlers.set(method, () => body);
  const pending = await f.controller.call(f.binding, command(method, ['other']));
  await f.controller.decide(f.actor.id, f.actor.nativeId, pending.id, 1);
  f.sandbox.queueSecretary.current = () => { throw Error('Synthetic role storage unavailable'); };
  const pickup = (await f.controller.call(f.binding, { action: 'receipt', operation_id: pending.id })).receipt;
  assert.equal(pickup.value, undefined); assert.equal(pickup.readState, 'consumed');
  assert.equal(f.controller.readCopies.size, 0); assert.equal(f.controller.readBytes, 0);
});
for (const provider of ['claude', 'codex']) for (const [method, body] of Object.entries(terminalReadBodies)) test(`${provider} secretary keeps own ${method} direct and private`, async t => {
  const f = fixture(t, provider); f.config.handlers.set(method, (_context, id) => { assert.equal(id, f.actor.id); return body; });
  f.sandbox.secretary = { sessionId: f.actor.id, nativeId: f.actor.nativeId };
  const result = await f.controller.call(f.binding, command(method, [f.actor.id]));
  assert.equal(result.state, 'complete'); assert.deepEqual(result.value, body);
  assert.equal(f.notices.length, 0); assert.equal(fs.readFileSync(f.controller.file, 'utf8').includes('_PRIVATE_'), false);
});
for (const provider of ['claude', 'codex']) test(`${provider}: two simultaneous pickups of one approved copy return its body only once`, { timeout: 5000 }, async t => {
  const f = fixture(t, provider), body = terminalReadBodies.terminalSnapshot; let reads = 0, arrivals = 0, release;
  f.config.handlers.set('terminalSnapshot', () => { reads++; return body; });
  const pending = await f.controller.call(f.binding, command('terminalSnapshot', ['other']));
  await f.controller.decide(f.actor.id, f.actor.nativeId, pending.id, 1);
  const barrier = new Promise(resolve => { release = resolve; }), c = await f.controller.view(f.actor);
  c.delivery = async () => { if (++arrivals === 2) release(); await barrier; return null; };
  const receipts = await Promise.all([0, 1].map(() => f.controller.call(f.binding, { action: 'receipt', operation_id: pending.id })));
  assert.equal(arrivals, 2);
  const bodies = receipts.filter(r => Object.hasOwn(r.receipt, 'value'));
  assert.equal(bodies.length, 1); assert.deepEqual(bodies[0].receipt.value, body);
  assert.equal((await f.controller.call(f.binding, { action: 'receipt', operation_id: pending.id })).receipt.value, undefined);
  assert.equal(reads, 1); assert.equal(f.controller.readCopies.size, 0); assert.equal(f.controller.readBytes, 0);
  assert.equal(fs.readFileSync(f.controller.file, 'utf8').includes('_PRIVATE_'), false);
});
for (const provider of ['claude', 'codex']) test(`${provider}: two sessions picking up the same operation ID keep their copies separate`, { timeout: 5000 }, async t => {
  let arrivals = 0, release;
  const f = fixture(t, provider, { context: async owner => ({ background: true, actor: owner, view: { selected: owner.id },
    client: { snapshot: () => f.state, close() {} }, checkActor() {}, refresh: async () => {}, win: { isDestroyed: () => false, destroy() {} },
    fingerprint: () => ({ sessions: f.state.sessions.map(s => ({ id: s.id, nativeId: s.nativeId })) }) }) });
  f.config.handlers.set('terminalSnapshot', () => ({ buffer: operation.current().id + '_PRIVATE_SCREEN' }));
  const bindings = [f.binding, { ...f.binding, sender: { ...f.actor, id: 'third', nativeId: 'native-third', name: 'Third actor' } }];
  for (const binding of bindings) {
    const pending = await f.controller.call(binding, command('terminalSnapshot', ['other'], 'same-operation-id'));
    assert.equal(pending.state, 'confirmation-required');
    await f.controller.decide(binding.sender.id, binding.sender.nativeId, pending.id, 1);
  }
  const barrier = new Promise(resolve => { release = resolve; });
  for (const binding of bindings) (await f.controller.view(binding.sender)).delivery = async () => { if (++arrivals === 2) release(); await barrier; return null; };
  const results = await Promise.all(bindings.map(binding => f.controller.call(binding, { action: 'receipt', operation_id: 'same-operation-id' })));
  assert.equal(arrivals, 2);
  for (const [index, result] of results.entries()) assert.equal(result.receipt.value.buffer, bindings[index].sender.id + '_PRIVATE_SCREEN');
  assert.equal(f.controller.readCopies.size, 0); assert.equal(f.controller.readBytes, 0);
  assert.equal(fs.readFileSync(f.controller.file, 'utf8').includes('_PRIVATE_'), false);
});
function spaceFileFixture(t, provider = 'codex') {
  const f = fixture(t, provider); let reads = 0;
  f.state.rooms[0].files = [{ id: 'space-file', name: 'Shared material.txt', path: '/synthetic/shared-material.txt' }];
  f.sandbox.validRoomId = id => id === 'shared';
  f.sandbox.roomState.metadata = id => { assert.equal(id, 'shared'); return f.state.rooms[0]; };
  f.sandbox.readPreview = async () => {
    reads++; await f.onFileRead?.();
    return { token: 'preview-token', name: 'Shared material.txt', text: 'SPACE_FILE_PRIVATE_BODY', bytes: Buffer.from('SPACE_FILE_PRIVATE_BODY') };
  };
  vm.runInContext(part("  register('spaceFiles',", "  register('createDefaults',"), f.sandbox);
  Object.defineProperty(f, 'fileReads', { get: () => reads }); return f;
}
function spaceExportFixture(t, provider) {
  const f = spaceFileFixture(t, provider);
  Object.assign(f.sandbox, { path, textExtensions: require('../local-files.cjs').extensions, saveCopy: require('../local-files.cjs').saveCopy,
    showDialog: (c, kind, options) => require('../background-control.cjs').dialog(c, kind, options) });
  vm.runInContext(part("  register('openLocalFile',", "  register('chooseFolder',"), f.sandbox);
  return f;
}
for (const provider of ['claude', 'codex']) for (const [method, args] of [
  ['openLocalFile', ['agent']], ['saveLocalFile', ['preview-token']], ['runtimeLocation', ['codex']], ['spaceFiles', ['shared']],
]) for (const count of method === 'spaceFiles' ? [0] : [0, 2]) test(`${provider} ${method}: invalid path count ${count} refuses before human confirmation`, async t => {
  const f = spaceExportFixture(t, provider), c = await f.controller.view(f.actor);
  // Both refusals must share one 60-second summary window; the wall clock can cross a minute between them.
  f.controller.now = () => 60000;
  if (method === 'runtimeLocation') f.config.handlers.set(method, () => { throw Error('Handler must not run before consent'); });
  c.filePreview = { token: 'preview-token', name: 'Local.txt', bytes: Buffer.from('LOCAL'), text: 'LOCAL' };
  const paths = count ? [path.join(f.dir, 'one.txt'), path.join(f.dir, 'two.txt')] : [];
  const result = await f.controller.call(f.binding, { ...command(method, args), paths });
  assert.equal(result.state, 'not-executed'); assert.equal(result.reason, 'invalid-file-path-count');
  assert.deepEqual(Object.keys(result.guard), ['auditRooms']);
  assert.equal(result.confirmation, undefined); assert.equal(f.notices.length, 0); assert.equal(f.fileReads, 0);
  assert.equal(f.controller.data.records.length, 0);
  const receipt = (await f.controller.call(f.binding, { action: 'receipt', operation_id: result.id })).receipt;
  assert.equal(receipt.id, result.summaryId); assert.equal(receipt.reason, result.reason);
  const repeated = await f.controller.call(f.binding, { ...command(method, args, result.id), paths });
  assert.equal(repeated.summaryId, result.summaryId); assert.equal(repeated.count, 2); assert.equal(f.notices.length, 0);
});
for (const provider of ['claude', 'codex']) test(`${provider}: an expired export token never asks for a decision`, async t => {
  const f = spaceExportFixture(t, provider);
  const result = await f.controller.call(f.binding, { ...command('saveLocalFile', ['expired']), paths: [path.join(f.dir, 'copy.txt')] });
  assert.equal(result.state, 'not-executed'); assert.equal(result.reason, 'file-preview-changed');
  assert.deepEqual(Object.keys(result.guard), ['auditRooms']);
  assert.equal(result.confirmation, undefined); assert.equal(f.notices.length, 0);
  assert.equal(fs.existsSync(path.join(f.dir, 'copy.txt')), false);
});
test('valid explicit file selection asks before target metadata or content is read', async t => {
  const f = spaceExportFixture(t, 'codex'), file = path.join(f.dir, 'chosen.txt'); fs.writeFileSync(file, 'LOCAL');
  const statSync = fs.statSync; let metadataReads = 0;
  const mocked = t.mock.method(fs, 'statSync', (target, ...args) => { if (target === file) metadataReads++; return statSync(target, ...args); });
  const pending = await f.controller.call(f.binding, { ...command('openLocalFile', ['agent']), paths: [file] });
  assert.equal(pending.state, 'confirmation-required'); assert.equal(metadataReads, 0); assert.equal(f.fileReads, 0); mocked.mock.restore();
  assert.equal((await f.controller.decide(f.actor.id, f.actor.nativeId, pending.id, 1)).state, 'complete'); assert.equal(f.fileReads, 1);
});
test('runtime location reset and space-file reads do not require picker paths', async t => {
  const f = spaceExportFixture(t, 'codex'); f.config.handlers.set('runtimeLocation', () => true);
  const reset = await f.controller.call(f.binding, command('runtimeLocation', ['codex', true])); assert.equal(reset.state, 'confirmation-required');
  assert.equal((await f.controller.decide(f.actor.id, f.actor.nativeId, reset.id, 1)).state, 'complete');
  const read = await f.controller.call(f.binding, command('spaceFiles', ['shared', 'space-file'])); assert.equal(read.state, 'confirmation-required');
  assert.equal((await f.controller.decide(f.actor.id, f.actor.nativeId, read.id, 1)).state, 'complete');
  const invalidReference = await f.controller.call(f.binding, command('spaceFiles', ['shared', null]));
  assert.equal(invalidReference.state, 'confirmation-required', 'null remains a file-reference read, not an import');
});
test('multiple space import paths remain eligible for one human decision', async t => {
  const f = spaceExportFixture(t, 'codex');
  const request = { ...command('spaceFiles', ['shared']), paths: [path.join(f.dir, 'one.txt'), path.join(f.dir, 'two.txt')] };
  assert.equal((await f.controller.call(f.binding, request)).state, 'confirmation-required'); assert.equal(f.fileReads, 0);
});
for (const provider of ['claude', 'codex']) for (const change of ['closed', 'replaced', 'saving']) test(`${provider}: export preview ${change} while awaiting consent is explicitly not executed`, async t => {
  const f = spaceExportFixture(t, provider), c = await f.controller.view(f.actor); let entered = 0;
  c.filePreview = { token: 'token', name: 'Local.txt', bytes: Buffer.from('LOCAL') };
  f.config.handlers.set('saveLocalFile', () => { entered++; });
  const args = { ...command('saveLocalFile', ['token']), paths: [path.join(f.dir, 'copy.txt')] };
  const pending = await f.controller.call(f.binding, args); assert.equal(pending.state, 'confirmation-required');
  if (change === 'closed') c.filePreview = null;
  if (change === 'replaced') c.filePreview = { token: 'replacement' };
  if (change === 'saving') c.fileSaving = true;
  const result = await f.controller.decide(f.actor.id, f.actor.nativeId, pending.id, 1);
  assert.equal(result.state, 'not-executed'); assert.equal(result.reason, 'file-preview-changed'); assert.equal(entered, 0);
  assert.deepEqual(Object.keys(result.guard), ['auditRooms']); assert.equal(result.humanDecision, 1);
  assert.equal((await f.controller.call(f.binding, args)).duplicate, true); assert.equal(entered, 0);
});
for (const typed of [false, true]) test(`a ${typed ? 'typed precondition' : 'normal'} error from an entered handler keeps its outcome unknown`, async t => {
  const f = spaceExportFixture(t, 'codex'), c = await f.controller.view(f.actor); let entered = 0;
  c.filePreview = { token: 'token' };
  f.config.handlers.set('saveLocalFile', () => { entered++; throw typed ? new f.sandbox.background.PreconditionRefused(Error('Handler effect may have occurred'), 'file-preview-changed') : Error('Handler effect may have occurred'); });
  const args = { ...command('saveLocalFile', ['token']), paths: [path.join(f.dir, 'copy.txt')] };
  const pending = await f.controller.call(f.binding, args), result = await f.controller.decide(f.actor.id, f.actor.nativeId, pending.id, 1);
  assert.equal(result.state, 'unconfirmed'); assert.ok(result.guard.sessions); assert.equal(entered, 1);
  assert.equal((await f.controller.call(f.binding, args)).duplicate, true); assert.equal(entered, 1);
});
test('a policy refusal after a resumed handler has had effects retains its original unknown record', async t => {
  const f = fixture(t); let effects = 0;
  f.config.handlers.set('terminalSnapshot', async c => {
    effects++; await f.sandbox.background.dialog(c, 'message', { message: 'Follow-up', buttons: ['Cancel', 'Continue'], cancelId: 0 });
  });
  const args = command('terminalSnapshot', ['other']);
  const first = await f.controller.call(f.binding, args), second = await f.controller.decide(f.actor.id, f.actor.nativeId, first.id, 1);
  assert.equal(second.state, 'confirmation-required'); assert.equal(effects, 1);
  f.sandbox.secretary = { sessionId: f.actor.id, nativeId: f.actor.nativeId };
  const denied = await f.controller.decide(f.actor.id, f.actor.nativeId, first.id, 1);
  assert.equal(denied.state, 'unconfirmed'); assert.ok(denied.guard.sessions); assert.equal(denied.humanDecision, 1);
  assert.equal(f.controller.data.refusals.length, 0); assert.equal((await f.controller.call(f.binding, args)).duplicate, true); assert.equal(effects, 1);
});
test('a precondition after a previously entered resumable handler cannot erase earlier effects', async t => {
  const f = spaceExportFixture(t, 'codex'), c = await f.controller.view(f.actor); let effects = 0;
  c.filePreview = { token: 'token' };
  f.config.handlers.set('saveLocalFile', async context => { effects++; await f.sandbox.background.dialog(context, 'message', { message: 'Second question', buttons: ['Cancel', 'Continue'], cancelId: 0 }); });
  const args = { ...command('saveLocalFile', ['token']), paths: [path.join(f.dir, 'copy.txt')] };
  const first = await f.controller.call(f.binding, args), second = await f.controller.decide(f.actor.id, f.actor.nativeId, first.id, 1);
  assert.equal(second.state, 'confirmation-required'); assert.equal(effects, 1);
  c.filePreview = null;
  const result = await f.controller.decide(f.actor.id, f.actor.nativeId, first.id, 1);
  assert.equal(result.state, 'unconfirmed'); assert.ok(result.guard.sessions); assert.equal(effects, 1);
  assert.equal((await f.controller.call(f.binding, args)).duplicate, true); assert.equal(effects, 1);
});
for (const provider of ['claude', 'codex']) for (const when of ['before-pickup', 'after-pickup', 'after-leaving']) test(`${provider}: a space-file read has no reusable export preview ${when}`, async t => {
  const f = spaceExportFixture(t, provider), c = await f.controller.view(f.actor);
  const read = await f.controller.call(f.binding, command('spaceFiles', ['shared', 'space-file']));
  assert.equal((await f.controller.decide(f.actor.id, f.actor.nativeId, read.id, 1)).state, 'complete');
  let token = 'preview-token';
  if (when !== 'before-pickup') {
    const pickup = (await f.controller.call(f.binding, { action: 'receipt', operation_id: read.id })).receipt;
    assert.equal(pickup.value.text, 'SPACE_FILE_PRIVATE_BODY'); assert.equal(pickup.readState, 'consumed'); token = pickup.value.token;
  }
  if (when === 'after-leaving') f.state.sessions[0].roomIds = [];
  const target = path.join(f.dir, 'export.txt');
  const notices = f.notices.length;
  const pending = await f.controller.call(f.binding, { ...command('saveLocalFile', [token]), paths: [target] });
  assert.equal(pending.state, 'not-executed'); assert.equal(pending.reason, 'file-preview-changed');
  assert.deepEqual(Object.keys(pending.guard), ['auditRooms']); assert.equal(pending.confirmation, undefined); assert.equal(f.notices.length, notices);
  assert.equal(fs.existsSync(target), false);
  assert.equal(c.filePreview, null); assert.equal(fs.readFileSync(f.controller.file, 'utf8').includes('SPACE_FILE_PRIVATE_BODY'), false);
});
test('a person still previews and saves a space file in their own window', async t => {
  const f = spaceExportFixture(t, 'codex'), c = await f.controller.view(f.actor); c.background = false;
  const target = path.join(f.dir, 'human-copy.txt');
  f.sandbox.showDialog = async (_c, kind) => { assert.equal(kind, 'save'); return { canceled: false, filePath: target }; };
  const preview = await f.config.handlers.get('spaceFiles')(c, 'shared', 'space-file');
  assert.equal(c.filePreview.bytes.toString(), 'SPACE_FILE_PRIVATE_BODY');
  assert.equal(await f.config.handlers.get('saveLocalFile')(c, preview.token), true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'SPACE_FILE_PRIVATE_BODY');
});
test('explicit path-based background previews keep their existing human-approved export path', async t => {
  const f = spaceExportFixture(t, 'codex'), original = path.join(f.dir, 'chosen.txt'), target = path.join(f.dir, 'path-copy.txt');
  fs.writeFileSync(original, 'SPACE_FILE_PRIVATE_BODY'); f.state.sessions[0].roomIds = [];
  const pending = await f.controller.call(f.binding, { ...command('openLocalFile', ['agent']), paths: [original] });
  assert.equal((await f.controller.decide(f.actor.id, f.actor.nativeId, pending.id, 1)).state, 'complete');
  const preview = (await f.controller.call(f.binding, { action: 'receipt', operation_id: pending.id })).receipt.value;
  const save = await f.controller.call(f.binding, { ...command('saveLocalFile', [preview.token]), paths: [target] });
  assert.equal((await f.controller.decide(f.actor.id, f.actor.nativeId, save.id, 1)).state, 'complete');
  assert.equal(fs.readFileSync(target, 'utf8'), 'SPACE_FILE_PRIVATE_BODY');
});
for (const provider of ['claude', 'codex']) for (const role of ['member', 'nonmember', 'secretary']) test(`${provider} space file: ${role} cannot exceed current space authority after confirmation`, async t => {
  const f = spaceFileFixture(t, provider);
  if (role === 'nonmember') f.state.sessions[0].roomIds = [];
  if (role === 'secretary') f.sandbox.secretary = { sessionId: 'agent', nativeId: 'native-agent' };
  const args = command('spaceFiles', ['shared', 'space-file']), pending = await f.controller.call(f.binding, args);
  assert.equal(f.fileReads, 0);
  if (role !== 'member') {
    assert.equal(pending.state, 'not-executed'); assert.equal(pending.reason, 'space-file-membership-required'); assert.equal(pending.confirmation, undefined); assert.equal(pending.value, undefined);
    assert.equal(f.notices.length, 0); assert.equal(JSON.stringify(pending).includes('Shared material.txt'), false);
    await assert.rejects(f.controller.decide('agent', 'native-agent', pending.id, 1), /no longer current/);
    return;
  }
  assert.equal(pending.state, 'confirmation-required');
  const approved = await f.controller.decide('agent', 'native-agent', pending.id, 1);
  assert.equal(approved.value, undefined);
  if (role === 'member') {
    assert.equal(approved.state, 'complete'); assert.equal(f.fileReads, 1);
    assert.equal(approved.readAuthorization.roomId, 'shared');
    const first = await f.controller.call(f.binding, { action: 'receipt', operation_id: pending.id });
    assert.equal(first.receipt.value.text, 'SPACE_FILE_PRIVATE_BODY');
    assert.equal((await f.controller.call(f.binding, { action: 'receipt', operation_id: pending.id })).receipt.value, undefined);
    assert.equal((await f.controller.call(f.binding, args)).value, undefined);
  } else { assert.equal(approved.state, 'unconfirmed'); assert.equal(f.fileReads, 0); }
  assert.equal(fs.readFileSync(f.controller.file, 'utf8').includes('SPACE_FILE_PRIVATE_BODY'), false);
});
for (const when of ['during-read', 'before-pickup']) test(`space file authority is rechecked ${when}`, async t => {
  const f = spaceFileFixture(t);
  if (when === 'during-read') f.onFileRead = () => { f.state.sessions[0].roomIds = []; };
  const pending = await f.controller.call(f.binding, command('spaceFiles', ['shared', 'space-file']));
  const approved = await f.controller.decide('agent', 'native-agent', pending.id, 1);
  if (when === 'during-read') assert.equal(approved.state, 'unconfirmed');
  else { assert.equal(approved.state, 'complete'); f.state.sessions[0].roomIds = []; }
  assert.equal((await f.controller.call(f.binding, { action: 'receipt', operation_id: pending.id })).receipt.value, undefined);
  assert.equal(fs.readFileSync(f.controller.file, 'utf8').includes('SPACE_FILE_PRIVATE_BODY'), false);
});
test('legacy space file read bodies are purged on load', t => {
  const f = fixture(t), args = command('spaceFiles', ['shared', 'space-file'], 'legacy-space-file');
  fs.writeFileSync(f.controller.file, JSON.stringify({ version: 1, views: {}, records: [{ id: args.operation_id, actor: f.actor, command: args, state: 'complete', value: { text: 'SPACE_FILE_PRIVATE_BODY' } }] }), { mode: 0o600 });
  const cold = new BackgroundControl(f.config);
  assert.equal(cold.data.records[0].value, undefined); assert.equal(cold.data.records[0].readState, 'expired');
  assert.equal(cold.data.records[0].readTarget.roomId, 'shared');
  assert.equal(fs.readFileSync(cold.file, 'utf8').includes('SPACE_FILE_PRIVATE_BODY'), false);
});
for (const provider of ['claude', 'codex']) for (const [method, body] of Object.entries(terminalReadBodies)) test(`${provider} approved ${method}: person gets metadata, agent collects once, no durable body`, async t => {
  const f = fixture(t, provider); let reads = 0;
  f.config.handlers.set(method, (_c, id) => { assert.equal(id, 'other'); reads++; return body; });
  const args = command(method, ['other']), pending = await f.controller.call(f.binding, args);
  assert.equal(pending.state, 'confirmation-required'); assert.equal(reads, 0);
  const approved = await f.controller.decide('agent', 'native-agent', pending.id, 1);
  assert.equal(approved.state, 'complete'); assert.equal(approved.value, undefined); assert.equal(approved.readState, 'available');
  assert.deepEqual(approved.readAuthorization, { sessionId: 'other', nativeId: 'native-other' });
  assert.equal(approved.readTarget.name, 'Other 中文');
  assert.ok(f.controller.data.records.every(r => !Object.hasOwn(r, 'value')));
  assert.equal(fs.readFileSync(f.controller.file, 'utf8').includes('_PRIVATE_'), false);
  const first = await f.controller.call(f.binding, { action: 'receipt', operation_id: pending.id }); assert.deepEqual(first.receipt.value, body);
  assert.equal(first.receipt.readState, 'consumed');
  assert.equal((await f.controller.call(f.binding, { action: 'receipt', operation_id: pending.id })).receipt.value, undefined);
  assert.equal((await f.controller.call(f.binding, args)).value, undefined); assert.equal(reads, 1);
});
for (const [method, body] of Object.entries(terminalReadBodies)) test(`own ${method} returns directly and never stores a terminal body`, async t => {
  const f = fixture(t); f.config.handlers.set(method, () => body);
  const args = command(method, ['agent']), first = await f.controller.call(f.binding, args);
  assert.equal(first.state, 'complete'); assert.deepEqual(first.value, body); assert.equal(first.readState, 'consumed');
  assert.equal((await f.controller.call(f.binding, { action: 'receipt', operation_id: args.operation_id })).receipt.value, undefined);
  assert.equal((await f.controller.call(f.binding, args)).value, undefined);
  assert.ok(f.controller.data.records.every(r => !Object.hasOwn(r, 'value')));
  assert.equal(fs.readFileSync(f.controller.file, 'utf8').includes('_PRIVATE_'), false);
});
for (const [method, body] of Object.entries(terminalReadBodies)) test(`legacy ${method} copies are purged on load`, t => {
  const f = fixture(t), args = command(method, ['other'], 'legacy-terminal-read');
  fs.writeFileSync(f.controller.file, JSON.stringify({ version: 1, views: {}, records: [{ id: args.operation_id, actor: { ...f.actor, callId: 'old-call', turnId: 'old-turn', operationId: args.operation_id }, command: args, state: 'complete', value: body }] }), { mode: 0o600 });
  const cold = new BackgroundControl(f.config);
  assert.equal(cold.data.records[0].value, undefined); assert.equal(cold.data.records[0].readState, 'expired');
  assert.equal(cold.data.records[0].readTarget.sessionId, 'other');
  assert.equal(fs.readFileSync(cold.file, 'utf8').includes('_PRIVATE_'), false);
});
for (const method of Object.keys(terminalReadBodies)) test(`${method} refuses a native target replacement during its awaited read`, async t => {
  const f = fixture(t); f.config.handlers.set(method, async () => { f.state.sessions[1].nativeId = 'replacement-during-terminal-read'; return terminalReadBodies[method]; });
  const pending = await f.controller.call(f.binding, command(method, ['other']));
  const approved = await f.controller.decide('agent', 'native-agent', pending.id, 1);
  assert.equal(approved.state, 'unconfirmed'); assert.equal(approved.value, undefined);
  assert.equal((await f.controller.call(f.binding, { action: 'receipt', operation_id: pending.id })).receipt.value, undefined);
  assert.equal(fs.readFileSync(f.controller.file, 'utf8').includes('_PRIVATE_'), false);
});

// The butler reads another session's conversation without the person confirming each read (the person, 2026-11-12
// 14:24, 「按你推荐的来」), only while it is the designated butler in no space and its record takes lines.
function butlerFixture(t, provider = 'claude') {
  const a = main.indexOf('    unasked: (actor'), b = main.indexOf('\n    retireHold:', a);
  assert.ok(a > 0 && b > a, 'main.cjs passes the unasked gate to background control');
  let sandbox = null;
  const f = fixture(t, provider, { unasked: (...args) => vm.runInContext('(' + main.slice(a + '    unasked: '.length, b).trim().replace(/,$/, '') + ')', sandbox)(...args) });
  sandbox = f.sandbox;
  sandbox.stewardOf = () => ({ sessionId: f.actor.id, nativeId: f.actor.nativeId });
  // The butler's record as main.cjs keeps it: a call goes through it the way boot() sends every workspace_control call.
  const { StewardRecord } = require('../steward-record.cjs');
  const recordDir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-butler-record-')); t.after(() => fs.rmSync(recordDir, { recursive: true, force: true }));
  sandbox.stewardRecord = new StewardRecord(recordDir, { steward: () => sandbox.stewardOf() });
  f.call = (input, binding = f.binding) => sandbox.stewardRecord.around(binding.sender, input, () => f.controller.call(binding, input));
  f.steps = () => sandbox.stewardRecord.lines.filter(line => line.kind === 'step').length;
  f.state.sessions[0].roomIds = [];
  f.state.sessions[1].messages.push({ id: 'other-later', role: 'user', text: 'LATER', time: 1234 });
  return f;
}
for (const provider of ['claude', 'codex']) test(`${provider}: the butler in no space reads another conversation in one call, unasked, and the record says so`, async t => {
  const f = butlerFixture(t, provider); await f.select('other');
  const result = await f.call({ action: 'snapshot' });
  assert.equal(result.state, 'complete', JSON.stringify(result).slice(0, 400));
  assert.ok(JSON.stringify(result.value).includes(f.secret), 'what was read comes back in the same answer');
  assert.equal(result.readState, 'consumed'); assert.equal(result.unasked, true);
  assert.deepEqual(result.readTarget, { sessionId: 'other', nativeId: 'native-other', name: 'Other 中文', messages: 2, through: 1234 });
  assert.equal(f.notices.length, 0, 'no confirmation is asked for');
  assert.deepEqual(f.audits.map(r => [r.state, r.unasked === true]), [['running', true], ['complete', true]]);
  assert.equal(fs.readFileSync(f.controller.file, 'utf8').includes(f.secret), false, 'no durable conversation body');
  assert.equal(f.steps(), 1, 'written in the butler\'s record first');
  assert.equal((await f.call({ action: 'receipt', operation_id: result.id })).receipt.value, undefined, 'taken once');
  // An image of that conversation is read the same way.
  let entered = 0; f.config.handlers.set('previewImage', () => { entered++; return { dataUrl: 'data:image/png;base64,AA==' }; });
  const image = await f.call(command('previewImage', [{ kind: 'session', sessionId: 'other', messageId: 'other-message', index: 0 }]));
  assert.equal(image.state, 'complete', JSON.stringify(image).slice(0, 400)); assert.equal(entered, 1); assert.equal(image.value.dataUrl, 'data:image/png;base64,AA==');
  assert.equal(f.notices.length, 0);
});
for (const [label, change] of [
  ['a session that is not the butler', f => { f.sandbox.stewardOf = () => ({ sessionId: 'third', nativeId: 'native-third' }); }],
  ['the butler inside a space', f => { f.state.sessions[0].roomIds = ['shared']; }],
  ['the butler when the designation cannot be read', f => { f.sandbox.stewardOf = () => { throw Error('Unreadable'); }; }],
  // Each read is a step of the record first: a call the record did not write (here, sent to background control
  // directly) is not let through unasked, nor one designated only while it was already under way (the review's race).
  ['the butler in a call its record did not write', f => { f.call = input => f.controller.call(f.binding, input); }],
  ['a session designated while its call was under way', f => {
    const designation = f.sandbox.stewardOf; f.sandbox.stewardOf = () => null;
    f.call = input => f.sandbox.stewardRecord.around(f.binding.sender, input, () => { f.sandbox.stewardOf = designation; return f.controller.call(f.binding, input); });
  }],
]) test(`${label} still asks before reading another conversation`, async t => {
  const f = butlerFixture(t); change(f); await f.select('other');
  const pending = await f.call({ action: 'snapshot' });
  assert.equal(pending.state, 'confirmation-required'); assert.equal(JSON.stringify(pending).includes(f.secret), false);
  assert.equal(f.notices.length, 1); assert.equal(pending.unasked, undefined);
});
test('the butler still asks before reading another session\'s terminal', async t => {
  const f = butlerFixture(t); let entered = 0;
  f.config.handlers.set('terminalSnapshot', () => { entered++; return { text: f.secret }; });
  const pending = await f.call(command('terminalSnapshot', ['other']));
  assert.equal(pending.state, 'confirmation-required'); assert.equal(entered, 0); assert.equal(f.notices.length, 1);
});
test('an unasked read is released only while its reader is still the butler; nothing else unlocks a read', async t => {
  const f = butlerFixture(t); await f.select('other');
  const done = await f.call({ action: 'snapshot' });
  const value = { ...structuredClone(f.state), viewState: { selected: 'other' } };
  const record = { ...f.controller.receipt(f.actor, done.id), value };
  assert.ok(JSON.stringify(f.sandbox.projectBackgroundRecord(structuredClone(record), f.contexts[0])).includes(f.secret));
  f.sandbox.stewardOf = () => null;
  assert.equal(JSON.stringify(f.sandbox.projectBackgroundRecord(structuredClone(record), f.contexts[0])).includes(f.secret), false, 'revoked: metadata only');
  f.sandbox.stewardOf = () => ({ sessionId: f.actor.id, nativeId: f.actor.nativeId });
  const { unasked: _unasked, ...plain } = record;
  assert.equal(JSON.stringify(f.sandbox.projectBackgroundRecord(structuredClone(plain), f.contexts[0])).includes(f.secret), false, 'neither approved nor unasked: metadata only');
});
test('the space audit does not call an unasked read confirmed', t => {
  const { RoomState } = require('../room-state.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-audit-unasked-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = new RoomState(dir), row = { id: 'read-1', actor: { id: 'agent', nativeId: 'native', name: 'Butler', provider: 'claude' },
    command: { method: 'initial', arguments: ['other'] }, state: 'running', at: 1 };
  state.recordControlOperation({ ...row, unasked: true });
  assert.equal(state.value.events[0].uiMessage.key, 'notice.background.runningUnasked');
  assert.match(state.value.events[0].text, /不用确认/);
  state.recordControlOperation({ ...row, id: 'read-2' });
  assert.equal(state.value.events[1].uiMessage.key, 'notice.background.running');
});
test('the butler whose record takes no lines is refused before anything is read', async t => {
  const f = butlerFixture(t); await f.select('other'); f.sandbox.stewardRecord.failed = true;
  await assert.rejects(f.call({ action: 'snapshot' }), error => error.uiMessage?.key === 'error.steward.recordUnavailable');
  assert.equal(f.audits.length, 0); assert.equal(f.notices.length, 0);
});
// The review's blocking finding: a read the person answered must stay theirs, even when its reader may by then read
// without asking (designated meanwhile). It goes to the reader as an approved read, and is not said to be unasked.
for (const provider of ['claude', 'codex']) test(`${provider}: a read the person approved is never taken as unasked, also when its reader may now skip asking`, async t => {
  let skip = false;
  const f = fixture(t, provider, { unasked: () => skip }); await f.select('other');
  const pending = await f.controller.call(f.binding, { action: 'snapshot' });
  assert.equal(pending.state, 'confirmation-required');
  skip = true;
  const decided = await f.controller.decide(f.actor.id, f.actor.nativeId, pending.id, 1);
  assert.equal(JSON.stringify(decided).includes(f.secret), false, 'the person\'s answer does not take the read');
  const receipt = (await f.controller.call(f.binding, { action: 'receipt', operation_id: pending.id })).receipt;
  assert.ok(JSON.stringify(receipt.value).includes(f.secret), 'its reader gets what was read');
  assert.equal(receipt.unasked, undefined); assert.ok(f.audits.every(r => r.unasked === undefined), 'no audit line says it was not confirmed');
});
test('a session designated butler while its read waits gets that read once the person approves it', async t => {
  const f = butlerFixture(t); const designation = f.sandbox.stewardOf; f.sandbox.stewardOf = () => null; await f.select('other');
  const pending = await f.call({ action: 'snapshot' });
  assert.equal(pending.state, 'confirmation-required');
  f.sandbox.stewardOf = designation;
  await f.controller.decide(f.actor.id, f.actor.nativeId, pending.id, 1);
  const receipt = (await f.call({ action: 'receipt', operation_id: pending.id })).receipt;
  assert.ok(JSON.stringify(receipt.value).includes(f.secret)); assert.equal(receipt.unasked, undefined);
});

// Changing a session's model (N5): an agent can only ask for it, on a card, and the handler runs once the person confirms.
for (const provider of ['claude', 'codex']) test(`${provider}: a model change is asked about every time, also for the asking session itself, and runs once on the person's confirmation`, async t => {
  const f = fixture(t, provider), asked = []; f.state.capabilities = ['sessionModelV1'];
  f.config.handlers.set('changeModel', (c, ...args) => { asked.push(args); return { status: 'pending', waiting: 'turn' }; });
  for (const id of ['other', 'agent']) {
    const request = command('changeModel', [id, { model: 'claude-opus-5-5', effort: 'xhigh' }]);
    const pending = await f.controller.call(f.binding, request);
    assert.equal(pending.state, 'confirmation-required'); assert.equal(asked.length, 0);
    assert.equal(JSON.stringify(pending.confirmation).includes('claude-opus-5-5'), true);
    const done = await f.controller.decide(f.actor.id, f.actor.nativeId, pending.id, 1);
    assert.equal(done.state, 'complete'); assert.deepEqual(JSON.parse(JSON.stringify(asked.splice(0))), [[id, { model: 'claude-opus-5-5', effort: 'xhigh' }]]);
    const refused = await f.controller.call(f.binding, command('changeModel', [id, { model: 'claude-sonnet-5-5', effort: 'low' }]));
    await f.controller.decide(f.actor.id, f.actor.nativeId, refused.id, 0); assert.equal(asked.length, 0);
  }
});
test('a model change confirmed for one conversation never reaches the next one in the same session', async t => {
  const f = fixture(t, 'claude'); let entered = 0; f.state.capabilities = ['sessionModelV1'];
  f.config.handlers.set('changeModel', () => { entered++; });
  const pending = await f.controller.call(f.binding, command('changeModel', ['other', { model: 'claude-opus-5-5', effort: 'xhigh' }]));
  assert.equal(pending.state, 'confirmation-required');
  f.state.sessions.find(s => s.id === 'other').nativeId = 'native-replaced';
  const result = await f.controller.decide(f.actor.id, f.actor.nativeId, pending.id, 1).catch(error => ({ state: 'refused', error }));
  assert.notEqual(result.state, 'complete'); assert.equal(entered, 0);
});
test('a model change that cannot be made is refused with its reason before the person is asked', async t => {
  const f = fixture(t, 'claude'); f.controller.now = () => 60000; let entered = 0;
  f.config.handlers.set('changeModel', () => { entered++; });
  const other = f.state.sessions.find(s => s.id === 'other'), value = { model: 'claude-opus-5-5', effort: 'xhigh' };
  for (const [capabilities, patch, args] of [[[], {}, ['other', value]], [['sessionModelV1'], { state: 'ended' }, ['other', value]], [['sessionModelV1'], { provider: 'dsh' }, ['other', value]], [['sessionModelV1'], {}, ['other', { model: '--resume', effort: 'low' }]],
    [['sessionModelV1'], {}, ['other', { ...value, skipPermissions: true }]], [['sessionModelV1'], {}, ['other', value, 'native-other']], [['sessionModelV1'], {}, ['gone', value]], [['sessionModelV1'], {}, ['other']], [['sessionModelV1'], {}, []]]) {
    const before = { ...other }; Object.assign(other, patch); f.state.capabilities = capabilities;
    const result = await f.controller.call(f.binding, command('changeModel', args)); Object.assign(other, before);
    assert.deepEqual([result.state, result.reason, result.confirmation], ['not-executed', 'model-change-unavailable', undefined], JSON.stringify(args));
  }
  assert.equal(entered, 0); assert.equal(f.notices.length, 0);
  // A backend of its own may be older than the one beside it.
  f.state.capabilities = ['sessionModelV1']; other.serviceCapabilities = [];
  assert.equal((await f.controller.call(f.binding, command('changeModel', ['other', value]))).reason, 'model-change-unavailable');
});
test('a model change the person is asked about is tied to its session and the asking one, not to what other sessions do meanwhile', async t => {
  assert.deepEqual(operation.maintenanceTargets(command('changeModel', ['other', {}]), { id: 'agent' }, { sessions: [] }), { sessions: ['other'], rooms: [] });
  const f = fixture(t, 'claude'); let entered = 0; f.state.capabilities = ['sessionModelV1']; f.config.handlers.set('changeModel', () => { entered++; });
  f.state.sessions.push({ ...f.state.sessions.find(s => s.id === 'other'), id: 'third', name: 'Third', nativeId: 'native-third' });
  const pending = await f.controller.call(f.binding, command('changeModel', ['other', { model: 'claude-opus-5-5', effort: 'xhigh' }]));
  f.state.sessions.find(s => s.id === 'third').nativeId = 'native-replaced';
  assert.equal((await f.controller.decide(f.actor.id, f.actor.nativeId, pending.id, 1)).state, 'complete'); assert.equal(entered, 1);
});
test('what an agent may read of the choices needs no card, and withdrawing a change is not offered to agents', () => {
  assert.equal(operation.maintenanceAction('modelChoices', ['other'], { id: 'agent' }) || null, null);
  const source = fs.readFileSync(require.resolve('../background-control.cjs'), 'utf8');
  assert.match(source, /\n  modelChoices: \[/); assert.match(source, /\n  changeModel: \[/); assert.doesNotMatch(source, /\n  cancelModelChange: /);
  assert.match(main, /register\('cancelModelChange', [^\n]+\n  applicationHandlers\.delete\('cancelModelChange'\);/);
});
