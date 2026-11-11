const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const { BackgroundControl } = require('../background-control.cjs'), operation = require('../background-operation.cjs'), locale = require('../ui-locale.js');
const main = fs.readFileSync(require.resolve('../main.cjs'), 'utf8');
function part(start, end) { const a = main.indexOf(start), b = main.indexOf(end, a + start.length); assert.ok(a >= 0 && b > a); return main.slice(a, b); }
const command = (method, args = [], operation_id = randomUUID()) => ({ action: 'invoke', method, arguments: args, operation_id });
function fixture(t, provider = 'codex', extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-conversation-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const actor = { id: 'agent', nativeId: 'native-agent', provider, name: 'Agent' }, handlers = new Map(), contexts = [], audits = [], notices = [];
  const secret = 'OTHER_PRIVATE_BODY', own = 'OWN_BODY', third = 'THIRD_PRIVATE_BODY';
  const session = (id, nativeId, name, body) => ({ id, nativeId, name, provider, state: 'idle', roomIds: [], messages: [{ id: id + '-message', role: 'assistant', text: body, images: [{ path: body }] }],
    nativeActivity: { label: body }, activity: body, activityUiMessage: { params: { reason: body } }, claudeQuestion: { questions: [{ question: body }] }, approval: { params: { command: body } }, approvals: [{ params: { input: body } }], nativeApproval: { requests: [{ question: body }] }, fleet: [{ task: body }], futurePrivateField: body, liveDraft: body, draft: body });
  const state = { sessions: [session(actor.id, actor.nativeId, actor.name, own), session('other', 'native-other', 'Other 中文', secret), session('third', 'native-third', 'Third', third)], rooms: [{ id: 'shared', name: 'Shared', messages: [{ text: 'SHARED_RECORD' }], queue: [{ id: 'queued-task', status: 'queued', assignee: 'agent', text: 'QUEUE_RECORD' }] }] };
  state.sessions[0].roomIds = ['shared'];
  const sandbox = { backgroundOperation: operation, submissionState: s => s, sessionLabels: { apply: s => s }, roomState: { apply: s => s, value: { sessionArchives: {} }, metadata: () => ({ restoreMembers: [], restorePlacements: {} }) },
    queueSecretary: { current: () => sandbox.secretary || null }, backgroundControl: null, roomPeerIdentity: () => ({ nativeId: 'metadata' }), endedByMove: () => [], queueDispatcher: null, butlerIngress: null,
    viewStorageWarning: '', viewStorageWarningUiMessage: null, backgroundUnavailable: false, outboxQuitFailed: false, outboxUnavailable: false,
    displayText: (key, params) => locale.format('zh', key, params), uiError: require('../ui-errors.cjs').uiError, applicationBuild: {}, app: { getVersion: () => 'fixture' }, localeWarning: '', preflight: () => ({}), notifyCapacity() {},
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
    context: async (_actor, saved) => {
      const client = { snapshot: () => state, refresh: async () => {}, call: async method => { assert.equal(method, 'initial'); return state; }, close() {} };
      const c = { background: true, actor, view: saved || { owner: randomUUID(), selected: actor.id, mode: 'chat', preference: 'chat', active: false }, client, checkActor() {}, refresh: client.refresh, win: { isDestroyed: () => false, destroy() {} } };
      sandbox.context = c; sandbox.client = client; sandbox.actor = actor;
      if (main.includes('      context.metadataOnly =')) vm.runInContext(part('      context.metadataOnly =', '\n      context.refresh ='), sandbox);
      vm.runInContext(part('      context.fingerprint = command =>', '\n      context.delivery ='), sandbox); contexts.push(c); return c;
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
test('a cancelled read does not suppress an independent view or another actor', async t => {
  const f = fixture(t); await f.select('other');
  const cancelled = await f.controller.call(f.binding, { action: 'snapshot' });
  await f.controller.decide('agent', 'native-agent', cancelled.id, 0);
  const opened = await f.controller.call(f.binding, command('newWindow', ['other']));
  const independent = await f.controller.call(f.binding, { action: 'snapshot', view_id: opened.value.view_id });
  assert.equal(independent.state, 'confirmation-required'); assert.notEqual(independent.id, cancelled.id);
  const otherBinding = { ...f.binding, sender: { ...f.actor, nativeId: 'another-actor-native' } };
  const c = await f.controller.view(otherBinding.sender); c.view.selected = 'other';
  const other = await f.controller.call(otherBinding, { action: 'snapshot' });
  assert.equal(other.state, 'confirmation-required'); assert.notEqual(other.id, cancelled.id);
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
  const own = await f.controller.call(f.binding, { action: 'snapshot' });
  assert.equal(own.state, 'complete'); assert.ok(JSON.stringify(own.value).includes(f.own));
  assert.equal(JSON.stringify(own.value).includes(f.secret), false); assert.equal(JSON.stringify(own.value).includes(f.third), false);
  assert.equal(own.value.sessions.find(s => s.id === 'other').name, 'Other 中文');
  assert.ok(JSON.stringify(own.value).includes('SHARED_RECORD') && JSON.stringify(own.value).includes('QUEUE_RECORD'));
  assert.deepEqual(own.value.butler, facts);
  const human = f.sandbox.displayState(f.state, { background: false, view: { selected: 'other' } });
  assert.ok(JSON.stringify(human).includes(f.secret)); assert.ok(JSON.stringify(human).includes(f.third));
  assert.deepEqual(human.butler, facts);
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
  assert.equal(denied.state, 'unconfirmed'); assert.equal(JSON.stringify(denied).includes(f.secret), false);
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
  assert.match(selected.guard.sessions[0].approval, /^sha256:[a-f0-9]{64}$/);
  let writes = 0;
  f.config.handlers.set('input', c => require('../background-control.cjs').dialog(c, 'message', { buttons: ['Cancel', 'Confirm'], cancelId: 0 }).then(() => writes++));
  const pending = await f.controller.call(f.binding, command('input', ['agent', 'input'])); assert.equal(pending.state, 'confirmation-required');
  f.state.sessions[0].approval.params.command = 'CHANGED_NATIVE_QUESTION';
  assert.equal((await f.controller.decide('agent', 'native-agent', pending.id, 1)).state, 'unconfirmed'); assert.equal(writes, 0);
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
  for (const secret of ['PRIVATE_VIEW_BODY','PRIVATE_QUERY','PRIVATE_TOP','PRIVATE_LEASE','PRIVATE_BUILD','PRIVATE_PATH']) assert.equal(JSON.stringify(hosted).includes(secret), false, secret);
  const human = await f.config.handlers.get('initial')({ background: false, client: c.client, view: c.view });
  assert.equal(human.viewState.sharedDraft, 'PRIVATE_VIEW_BODY'); assert.equal(human.preflight.paths.codex, 'PRIVATE_PATH');
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
for (const provider of ['claude', 'codex']) for (const role of ['member', 'nonmember', 'secretary']) test(`${provider} space file: ${role} cannot exceed current space authority after confirmation`, async t => {
  const f = spaceFileFixture(t, provider);
  if (role === 'nonmember') f.state.sessions[0].roomIds = [];
  if (role === 'secretary') f.sandbox.secretary = { sessionId: 'agent', nativeId: 'native-agent' };
  const args = command('spaceFiles', ['shared', 'space-file']), pending = await f.controller.call(f.binding, args);
  assert.equal(pending.state, 'confirmation-required'); assert.equal(f.fileReads, 0);
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
