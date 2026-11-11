const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const { BackgroundControl } = require('../background-control.cjs'), operation = require('../background-operation.cjs'), locale = require('../ui-locale.js');
const main = fs.readFileSync(require.resolve('../main.cjs'), 'utf8');
function part(start, end) { const a = main.indexOf(start), b = main.indexOf(end, a + start.length); assert.ok(a >= 0 && b > a); return main.slice(a, b); }
const command = (method, args = [], operation_id = randomUUID()) => ({ action: 'invoke', method, arguments: args, operation_id });
function fixture(t, provider = 'codex') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-conversation-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const actor = { id: 'agent', nativeId: 'native-agent', provider, name: 'Agent' }, handlers = new Map(), contexts = [], audits = [], notices = [];
  const secret = 'OTHER_PRIVATE_BODY', own = 'OWN_BODY', third = 'THIRD_PRIVATE_BODY';
  const session = (id, nativeId, name, body) => ({ id, nativeId, name, provider, state: 'idle', roomIds: [], messages: [{ id: id + '-message', role: 'assistant', text: body, images: [{ path: body }] }],
    nativeActivity: { label: body }, activity: body, activityUiMessage: { params: { reason: body } }, claudeQuestion: { questions: [{ question: body }] }, approval: { params: { command: body } }, approvals: [{ params: { input: body } }], nativeApproval: { requests: [{ question: body }] }, fleet: [{ task: body }], futurePrivateField: body, liveDraft: body, draft: body });
  const state = { sessions: [session(actor.id, actor.nativeId, actor.name, own), session('other', 'native-other', 'Other 中文', secret), session('third', 'native-third', 'Third', third)], rooms: [{ id: 'shared', name: 'Shared', messages: [{ text: 'SHARED_RECORD' }], queue: [{ text: 'QUEUE_RECORD' }] }] };
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
    project: record => sandbox.projectBackgroundRecord ? sandbox.projectBackgroundRecord(record) : record,
    context: async (_actor, saved) => {
      const client = { snapshot: () => state, refresh: async () => {}, call: async method => { assert.equal(method, 'initial'); return state; }, close() {} };
      const c = { background: true, actor, view: saved || { owner: randomUUID(), selected: actor.id, mode: 'chat', preference: 'chat', active: false }, client, checkActor() {}, refresh: client.refresh, win: { isDestroyed: () => false, destroy() {} } };
      sandbox.context = c; sandbox.client = client; sandbox.actor = actor;
      if (main.includes('      context.metadataOnly =')) vm.runInContext(part('      context.metadataOnly =', '\n      context.refresh ='), sandbox);
      vm.runInContext(part('      context.fingerprint = command =>', '\n      context.delivery ='), sandbox); contexts.push(c); return c;
    } };
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
  const next = await cold.call(f.binding, { action: 'snapshot' }); assert.notEqual(next.id, first.id);
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
  const fresh = await f.controller.call(f.binding, { action: 'snapshot' }); assert.notEqual(fresh.id, replacement.id);
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
  const second = await f.controller.call(f.binding, read());
  const approved = await f.controller.decide('agent', 'native-agent', second.id, 1);
  assert.equal(approved.state, 'complete'); assert.ok(JSON.stringify(approved.value).includes(f.secret)); assert.equal(JSON.stringify(approved.value).includes(f.third), false);
  f.state.sessions[1].messages[0].text = 'NEW_UNREAD_CONTENT';
  const receipt = await f.controller.call(f.binding, { action: 'receipt', operation_id: second.id });
  assert.ok(JSON.stringify(receipt).includes(f.secret)); assert.equal(JSON.stringify(receipt).includes('NEW_UNREAD_CONTENT'), false);
  assert.equal((await f.controller.call(f.binding, read())).state, 'confirmation-required');
  assert.equal(JSON.stringify(f.sandbox.displayState(f.state, f.contexts[0])).includes(f.secret), false);
});
test('own snapshots and human windows keep their conversations; foreign unselected auxiliary fields are metadata-only', async t => {
  const f = fixture(t), facts = { intake: 'ready', activation: 'off', recordPeriod: 'off', vacancies: 2 };
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
  const own = await f.controller.call(f.binding, { action: 'snapshot' }); assert.equal(own.state, 'complete'); assert.ok(JSON.stringify(own).includes('QUEUE_RECORD'));
  await f.select('other'); const metadata = await f.controller.call(f.binding, { action: 'snapshot' });
  assert.equal(metadata.state, 'complete'); assert.equal(JSON.stringify(metadata).includes(f.secret), false); assert.ok(JSON.stringify(metadata).includes('QUEUE_RECORD'));
  const denied = await f.controller.call(f.binding, command('initial'));
  assert.equal(denied.state, 'unconfirmed'); assert.equal(JSON.stringify(denied).includes(f.secret), false);
});
test('private-image preview is a conversation read; shared and own images retain their existing path', async t => {
  const f = fixture(t); let reads = 0;
  f.config.handlers.set('previewImage', () => { reads++; return { thumbnail: f.secret }; });
  const source = { kind: 'session', sessionId: 'other', nativeId: 'native-other', messageId: 'known-message', index: 0 };
  const args = command('previewImage', [source]), pending = await f.controller.call(f.binding, args);
  assert.equal(pending.state, 'confirmation-required'); assert.equal(reads, 0); assert.equal(JSON.stringify(pending).includes(f.secret), false);
  assert.equal((await f.controller.decide('agent', 'native-agent', pending.id, 1)).state, 'complete'); assert.equal(reads, 1);
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
    conversationReaderAllowed: () => false, uiError: require('../ui-errors.cjs').uiError, context: c };
  vm.createContext(sandbox); vm.runInContext(part('  const imagesFor =', "  register('previewImage',"), sandbox);
  const previews = vm.runInContext('imagesFor(context)', sandbox);
  await assert.rejects(previews.options.snapshot({ kind: 'session', sessionId: 'other' })); assert.equal(calls, 0);
  await previews.options.snapshot({ kind: 'session', sessionId: 'agent' }); assert.equal(calls, 1);
  await previews.options.snapshot({ kind: 'room', sessionId: 'other' }); assert.equal(calls, 2);
});
