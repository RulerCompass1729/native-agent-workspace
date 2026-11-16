const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const operation = require('../background-operation.cjs'), locale = require('../ui-locale.js');
const { BackgroundControl, dialog } = require('../background-control.cjs');
const main = fs.readFileSync(require.resolve('../main.cjs'), 'utf8');
const invisible = /[\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u2800]/u;
function productionConfirmation() {
  const start = main.indexOf('    confirmation: (actor, command, action'), end = main.indexOf('\n    audit:', start);
  assert.ok(start > 0 && end > start);
  const sandbox = vm.createContext({
    backgroundOperation: operation, displayText: (key, params) => locale.format('zh', key, params),
    roomState: { apply: value => value, value: {} }, sessionLabels: { apply: value => value },
    queueSecretary: { current: () => null }, roomIds: session => session.roomIds || [], uiError: require('../ui-errors.cjs').uiError,
  });
  vm.runInContext(main.slice(main.indexOf('function conversationReaderAllowed('), main.indexOf('function projectBackgroundRecord(')), sandbox);
  return vm.runInContext('(' + main.slice(start + '    confirmation: '.length, end).trim().replace(/,$/, '') + ')', sandbox);
}
const context = snapshot => ({ client: { snapshot: () => snapshot } });
test('actual maintenance confirmation escapes format and separator characters without changing Unicode payloads', () => {
  const chars = '\u00ad\u061c\u200b\u200c\u200d\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069\ufeff\u{e0001}\u2028\u2029\u115f\u2800\u3164\u1160\uffa0\u034f\u17b4\u17b5\ufe0f\u{e0100}';
  const actor = { name: 'Agent' + chars }, command = { method: 'input', arguments: ['target', 'echo αа中文' + chars], paths: ['/synthetic/' + chars] };
  const before = JSON.stringify(command), options = productionConfirmation()(actor, command, 'input', context({ sessions: [], rooms: [] }));
  assert.equal(invisible.test(options.message), false); assert.equal(invisible.test(options.detail), false);
  assert.match(options.message, /\\u202e/i); assert.match(options.detail, /\\u202e/i);
  assert.match(options.detail, /αа中文/); assert.equal(JSON.stringify(command), before);
});
test('confirmation keeps exact IDs and adds session, space and selected-file names', () => {
  const snapshot = { sessions: [{ id: 'agent', nativeId: 'native-agent', roomIds: ['room'] }, { id: 'target', name: 'Target 中文', provider: 'codex' }], rooms: [{ id: 'room', name: 'Space 中文', files: [{ id: 'file', name: '材料.txt' }] }] };
  const build = productionConfirmation(), actor = { id: 'agent', nativeId: 'native-agent', name: 'Agent' };
  const member = JSON.parse(build(actor, { method: 'spaceAction', arguments: ['room', 'join', ['target', true]] }, 'joinRoom', context(snapshot)).detail);
  assert.deepEqual(member.arguments, ['room', 'join', ['target', true]]);
  assert.ok(member.references.some(r => r.kind === 'session' && r.id === 'target' && r.name === 'Target 中文'));
  assert.ok(member.references.some(r => r.kind === 'space' && r.id === 'room' && r.name === 'Space 中文'));
  const file = JSON.parse(build(actor, { method: 'spaceFiles', arguments: ['room', 'file'] }, 'spaceFiles', context(snapshot)).detail);
  assert.ok(file.references.some(r => r.kind === 'file' && r.id === 'file' && r.name === '材料.txt'));
});
test('human approval sees escaped rows while the input handler receives the exact original command', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-consent-display-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const payload = 'echo safe\u202e; hidden\u2066\u200b\u2028', writes = [], actor = { id: 'agent', nativeId: 'native', name: 'Agent\u202e', provider: 'codex' };
  const c = { background: true, ...context({ sessions: [{ ...actor }, { id: 'target', nativeId: 'native-target', name: 'Target', provider: 'codex', state: 'idle', terminalState: { alive: true, epoch: 'synthetic-target', observationIndex: 1 } }], rooms: [] }), checkActor() {}, view: {} };
  c.fingerprint = () => ({ sessions: c.client.snapshot().sessions.map(s => ({ id: s.id, nativeId: s.nativeId })) });
  const controller = new BackgroundControl({ dataDir: dir, context: () => c, handlers: new Map([['input', (_c, _id, text) => writes.push(text)]]), confirmation: productionConfirmation(), audit() {} });
  const args = { action: 'invoke', method: 'input', arguments: ['target', payload], operation_id: 'input' };
  const pending = await controller.call({ sender: actor, identity: { callId: 'call', turnId: 'turn' }, valid: () => true }, args);
  assert.equal(pending.state, 'confirmation-required'); assert.deepEqual(writes, []);
  assert.equal(invisible.test(pending.confirmation.options.detail), false);
  assert.equal(invisible.test(controller.rows('agent')[0].name), false);
  assert.equal(invisible.test(controller.rows('agent')[0].text), false);
  assert.equal((await controller.decide('agent', 'native', 'input', 1)).state, 'complete');
  assert.deepEqual(writes, [payload]); assert.equal(controller.receipt(actor, 'input').command.arguments[1], payload);
});
test('existing own-input and stop dialogs escape text before binding the human decision', async () => {
  const c = { background: true }, actor = { id: 'agent', nativeId: 'native', name: 'Agent', provider: 'codex', callId: 'call', turnId: 'turn', operationId: 'operation' };
  const options = { message: 'Agent\u202e', detail: 'input\u2066\u2028', buttons: ['Cancel', 'Confirm'], cancelId: 0 };
  await assert.rejects(async () => operation.run(actor, () => dialog(c, 'message', options), { context: c, actor, args: {}, dialogIndex: 0 }), error => {
    assert.equal(invisible.test(error.confirmation.options.message), false);
    assert.equal(invisible.test(error.confirmation.options.detail), false); return true;
  });
});
test('the real consent fingerprint changes with the independent clipboard, including ABA writes', () => {
  const actor = { id: 'agent' }, snapshot = { sessions: [{ id: 'target', nativeId: 'native', roomIds: [] }], rooms: [] }, c = {};
  const sandbox = { context: c, actor, client: { snapshot: () => snapshot }, roomState: { apply: value => value, value: { sessionArchives: {} } }, backgroundOperation: operation, roomIds: () => [], randomUUID: require('node:crypto').randomUUID,
    register: (_name, handler) => { sandbox.copy = handler; }, clipboard: { writeText() { throw Error('System clipboard must not be read or written'); } } };
  vm.createContext(sandbox);
  const start = main.indexOf('      context.fingerprint = command =>'), end = main.indexOf('\n      context.delivery =', start);
  vm.runInContext(main.slice(start, end), sandbox);
  const copyStart = main.indexOf("  register('copy',"), copyEnd = main.indexOf('\n', copyStart);
  vm.runInContext(main.slice(copyStart, copyEnd), sandbox);
  c.background = true; const command = { method: 'pasteNativeContent', arguments: ['target', 'native'] };
  sandbox.copy(c, 'A'); const first = JSON.stringify(c.fingerprint(command));
  sandbox.copy(c, 'B'); const second = JSON.stringify(c.fingerprint(command));
  sandbox.copy(c, 'A'); const third = JSON.stringify(c.fingerprint(command));
  assert.notEqual(first, second); assert.notEqual(first, third);
  sandbox.imagesFor = () => ({ copy: (_token, destination) => destination.writeImage({ isEmpty: () => false }) });
  const imageStart = main.indexOf("  register('copyImage',"), imageEnd = main.indexOf('\n', imageStart);
  vm.runInContext(main.slice(imageStart, imageEnd), sandbox);
  sandbox.copy(c, 'image'); const fourth = JSON.stringify(c.fingerprint(command));
  assert.notEqual(third, fourth); assert.equal(c.clipboardText, '');
});
test('background pasteText reads only its own clipboard and leaves the system clipboard untouched', async () => {
  let handler;
  const start = main.indexOf("  register('pasteText',"), end = main.indexOf('\n', start);
  vm.runInNewContext(main.slice(start, end), { register: (_name, value) => { handler = value; }, clipboard: { readText() { throw Error('System clipboard must not be read'); } } });
  assert.equal(await handler({ background: true, clipboardText: 'Independent synthetic text' }), 'Independent synthetic text');
});
test('persisted confirmations from an earlier version are escaped when their row is displayed', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-legacy-consent-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = { dataDir: dir, handlers: new Map(), context() { throw Error('Displaying a row must not execute an operation'); } };
  const controller = new BackgroundControl(config);
  controller.commit(data => data.records.push({ id: 'old', actor: { id: 'agent', nativeId: 'native', name: 'Agent\u202e', provider: 'codex' }, command: { method: 'input', arguments: ['target', '\u202e'] }, state: 'confirmation-required', confirmation: { kind: 'message', options: { message: 'Old\u202e', detail: 'Old\u2066\u2028', buttons: ['Cancel', 'Confirm'] } } }));
  const row = new BackgroundControl(config).rows('agent')[0];
  assert.equal(invisible.test(row.backgroundOperation.confirmation.options.message), false);
  assert.equal(invisible.test(row.backgroundOperation.confirmation.options.detail), false);
  assert.match(row.backgroundOperation.confirmation.options.detail, /\\u2066/);
  assert.equal(new BackgroundControl(config).data.records[0].confirmation.options.detail, 'Old\u2066\u2028');
});
test('space audit actor names are visible, including legacy records and maximal escaped names', t => {
  const { RoomState } = require('../room-state.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-audit-visible-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = new RoomState(dir), raw = 'Agent\u202e\u115f\u3164\u2800';
  const row = { id: 'audit-name', actor: { id: 'agent', nativeId: 'native', name: raw, provider: 'codex' },
    command: { method: 'archiveRoom', arguments: [] }, state: 'confirmation-required', at: 1 };
  state.recordControlOperation(row);
  assert.equal(invisible.test(state.value.events[0].controlAudit.actor.name), false);
  assert.equal(row.actor.name, raw, 'Original transport identity is unchanged');
  const old = structuredClone(state.value.events[0]); old.name = old.controlAudit.actor.name = raw;
  old.text = 'Waiting ' + raw; old.uiMessage.params.name = raw;
  state.commit({ ...state.value, events: [old] });
  const cold = new RoomState(dir), display = cold.apply({ sessions: [], rooms: [{ id: 'shared' }] });
  assert.equal(invisible.test(JSON.stringify(display.rooms[0].events)), false);
  assert.equal(cold.value.events[0].controlAudit.actor.name, raw, 'Display projection does not rewrite legacy storage');
  row.id = 'maximal-name'; row.actor.name = '\u202e'.repeat(160); state.recordControlOperation(row);
  const reread = new RoomState(dir); assert.equal(reread.warning, '');
  assert.equal(reread.value.events.at(-1).controlAudit.actor.name.length, 960);
});
