const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events'), { randomUUID } = require('node:crypto');
const { Workspace } = require('../workspace.cjs'), { NativeHost } = require('../adapters.cjs');
const { WorkspaceClient } = require('../workspace-client.cjs');
const { ViewStore } = require('../view-store.cjs'), { uiError } = require('../ui-errors.cjs');
const media = require('../space-images.cjs');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=', 'base64');
const decoder = { createFromBuffer: bytes => ({ isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }), toPNG: () => bytes }) };
function directory(t) { const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'space-image-delivery-'))); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
function packet(root) { return { version: randomUUID(), refs: media.stageSpaceImages(root, 'shared', [{ bytes: png, name: 'Screen.png' }], decoder) }; }
async function backend(t) {
  const root = directory(t), native = new NativeHost(root), calls = []; let ack, reject;
  native.rpc = { nativeVersion: '0.166.0', ws: { readyState: 1 }, call(method, params) { calls.push({ method, params }); return new Promise((yes, no) => { ack = yes; reject = no; }); } };
  const host = { binaries: {}, close() {}, create(record) { const runtime = native.create(record); runtime.start = async () => { record.nativeId = randomUUID(); runtime.emit('state', 'idle'); }; return runtime; } };
  const w = new Workspace(host, root); t.after(() => w.close());
  const id = await w.create('codex', root, 'owner', 'Explicit recipient'); w.join(id, true);
  const runtime = w.runtime(id), images = packet(root);
  const echo = () => runtime.event({ method: 'item/completed', params: { threadId: w.get(id).nativeId, turnId: 'owned-turn',
    item: { type: 'userMessage', id: 'native-user-item', clientId: calls[0].params.clientUserMessageId,
      content: calls[0].params.input.map(part => part.type === 'localImage' ? { ...part, detail: null } : part) } } });
  return { root, w, runtime, id, images, calls, echo, ack: () => ack({ turn: { id: 'owned-turn' } }), reject: error => reject(error) };
}
test('the existing Workspace explicit forward carries images, and only its native echo qualifies the saved space record', async t => {
  const f = await backend(t), sending = f.w.forward(f.id, '', 'owner', null, 'shared', f.images);
  assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0].params.input.map(p => p.type), ['localImage']);
  assert.equal(f.w.room.messages.length, 1); const row = f.w.room.messages[0];
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root, 'workspace.json'))).sessions[0].messages.at(-1).spaceUploads, f.images.refs, 'image ownership is saved before the native call can finish');
  assert.equal(row.recipientId, f.id); assert.deepEqual(row.images, f.images.refs); assert.equal(row.imageReceipt.status, 'awaiting-native');
  f.ack(); const tag = await sending; assert.equal(row.id, tag); assert.equal(row.status, 'submitted'); assert.equal(row.imageReceipt.status, 'awaiting-native');
  f.echo(); assert.equal(row.imageReceipt.status, 'accepted'); assert.equal(row.imageReceipt.nativeItemId, 'native-user-item');
  const saved = JSON.parse(fs.readFileSync(path.join(f.root, 'workspace.json')));
  assert.deepEqual(saved.room.messages[0].images, f.images.refs); assert.equal(saved.room.messages[0].imageReceipt.status, 'accepted');
  await assert.rejects(f.w.forward(f.id, '', 'owner', null, 'shared', f.images)); assert.equal(f.calls.length, 1, 'the same image draft is never sent twice');
});
test('uncertain image submission retains its space copy and never upgrades from a late echo after rejection', async t => {
  const f = await backend(t), sending = f.w.forward(f.id, 'Keep the caption', 'owner', null, 'shared', f.images);
  f.reject(Error('Connection lost')); await assert.rejects(sending, /Connection lost/); f.echo();
  const row = f.w.room.messages[0]; assert.equal(row.status, 'unconfirmed'); assert.equal(row.imageReceipt.status, 'awaiting-native');
  assert.deepEqual(media.readSpaceImage(f.root, 'shared', row.images[0]).png, png); assert.equal(f.calls.length, 1);
});
test('unqualified or forged image forwarding stops before dispatch and preserves private drafts', async t => {
  const f = await backend(t); f.w.setDraft(f.id, 'PRIVATE DRAFT', 'owner');
  f.runtime.host.rpc.nativeVersion = '0.165.0'; await assert.rejects(f.w.forward(f.id, 'caption', 'owner', null, 'shared', f.images));
  f.runtime.host.rpc.nativeVersion = '0.166.0';
  await assert.rejects(f.w.forward(f.id, 'caption', 'owner', null, 'shared', { ...f.images, refs: [{ ...f.images.refs[0], roomId: randomUUID() }] }));
  assert.equal(f.calls.length, 0); assert.equal(f.w.drafts.get(f.id), 'PRIVATE DRAFT'); assert.equal(f.w.room.messages.length, 0);
});
test('service layout resolves image storage to its existing profile, without caller-supplied paths', t => {
  const root = directory(t), service = path.join(root, 'backends', 'a'.repeat(20)); fs.mkdirSync(service, { recursive: true, mode: 0o700 });
  assert.equal(media.spaceImageRoot(root), root); assert.equal(media.spaceImageRoot(service), root);
  assert.equal(media.validSpaceImagePacket({ ...packet(root), root: '/arbitrary' }, 'shared'), false);
});
function router(t, change = {}) {
  const root = directory(t), client = new EventEmitter(), calls = [], images = packet(root);
  const state = { owner: 'owner', runtimeVersion: 'synthetic-current', capabilities: ['nativeInputIsolation', 'nativeContextTransitions', 'collaborationSpacesV1', 'spaceImageInputV1'],
    sessions: [{ id: 'recipient', provider: 'codex', nativeId: 'native-recipient', roomId: 'shared', state: 'idle', spaceImagesAvailable: true, ...change }],
    room: { id: 'shared', revision: 0, messages: [] }, rooms: [], diagnostics: { dispatches: 0, shellModelCalls: 0 } };
  client.call = async (method, ...args) => { calls.push([method, ...args]); return method === 'initial' ? structuredClone(state) : { tag: 'accepted-tag' }; };
  client.close = () => {};
  const c = new WorkspaceClient([{ key: '.', client, state: structuredClone(state) }], '.', Symbol()); t.after(() => c.close());
  return { c, state, calls, images };
}
test('WorkspaceClient preserves the optional image packet through ordinary forwarding argument trimming', async t => {
  const f = router(t); await f.c.callSpace('shared', 'forward', ['recipient', '', 'native-recipient', undefined, f.images]);
  const wire = f.calls.find(([method]) => method === 'forward'); assert.ok(wire); assert.deepEqual(wire.slice(1), ['recipient', '', 'native-recipient', null, f.images]);
});
test('a retained backend or revoked image capability cannot silently reduce an image task to text', async t => {
  const f = router(t, { spaceImagesAvailable: false });
  await assert.rejects(f.c.callSpace('shared', 'forward', ['recipient', 'caption', 'native-recipient', null, f.images]));
  assert.equal(f.calls.some(([method]) => method === 'forward'), false);
});
function mainFixture(t) {
  const root = directory(t), store = new ViewStore(root), c = { view: { owner: 'window', selected: 'room', mode: 'chat', roomViews: { shared: { sharedDraft: '@Builder original caption' } } } }; store.load();
  const images = packet(root); Object.assign(c.view.roomViews.shared, { roomImages: images.refs, roomImageVersion: images.version }); store.save([c.view]);
  let failSave = false, sends = 0;
  const snapshot = { sessions: [{ id: 'recipient', nativeId: 'native-recipient', spaceImagesAvailable: true, serviceCapabilities: ['spaceImageInputV1'], state: 'idle' }], room: { id: 'shared', messages: [] } };
  c.client = { call: async () => snapshot, callSpace: async (_room, action, args) => { assert.equal(action, 'forward'); assert.equal(new ViewStore(root).load()[0].roomViews.shared.roomImageSend.version, images.version); sends++; return { tag: 'native-tag', imageReceipt: { status: 'awaiting-native' } }; } };
  c.client.entries = [{ key: '.' }]; c.client.control = { maintenance: new Set() };
  const context = vm.createContext({ require: name => name === './space-images.cjs' ? media : require(path.join(__dirname, '..', name)), dataDir: root, nativeImage: decoder, randomUUID, uiError, views: [c.view], viewStorageWarning: null,
    roomState: { assertAvailable() {}, writable() {} }, saveViews: () => { if (failSave) throw Error('Owned save failure'); store.save([c.view]); } });
  const main = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8');
  vm.runInContext(main.slice(main.indexOf('function hasSavedSpaceDraft('), main.indexOf('function connectionUpdateOptions(')), context);
  const send = () => context.forwardSpaceImages(c, 'shared', ['recipient', 'caption', 'native-recipient', null, { version: images.version }]);
  return { root, store, c, images, snapshot, context, send, failSave: value => { failSave = value; }, sends: () => sends };
}
test('Main reserves an image draft durably before forwarding, preserves an unknown outcome across reload and denies repeat send', async t => {
  const f = mainFixture(t); await f.send();
  const saved = new ViewStore(f.root).load()[0].roomViews.shared;
  assert.equal(saved.sharedDraft, '@Builder original caption'); assert.deepEqual(saved.roomImages, f.images.refs); assert.equal(saved.roomImageSend.version, f.images.version);
  await assert.rejects(f.send()); assert.equal(f.sends(), 1);
});
test('Main save failure cannot dispatch, and native ACK without image echo cannot clear a draft', async t => {
  const f = mainFixture(t); f.failSave(true); await assert.rejects(f.send(), /Owned save failure/); assert.equal(f.sends(), 0);
  assert.equal(f.c.view.roomViews.shared.roomImageSend, undefined);
  f.failSave(false); await f.send();
  const result = await f.context.acceptSpaceImageDraft(f.c, 'shared', f.images.version, 'native-tag'); assert.equal(result.accepted, false); assert.equal(f.c.view.roomViews.shared.roomImages.length, 1);
});
test('Main clears only the exact unchanged image draft after native echo, with rollback on save failure', async t => {
  const f = mainFixture(t); await f.send();
  const row = { id: 'native-tag', role: 'human', recipientId: 'recipient', imageDraftVersion: f.images.version, images: f.images.refs,
    imageReceipt: { status: 'accepted', tag: 'native-tag', recipientId: 'recipient', nativeId: 'native-recipient', nativeItemId: 'native-user-item', turnId: 'owned-turn', basis: 'native-local-image-echo' } };
  f.snapshot.room.messages.push(row);
  row.imageReceipt.nativeId = 'wrong-thread'; assert.equal((await f.context.acceptSpaceImageDraft(f.c, 'shared', f.images.version, row.id)).accepted, false); row.imageReceipt.nativeId = 'native-recipient';
  f.failSave(true); await assert.rejects(f.context.acceptSpaceImageDraft(f.c, 'shared', f.images.version, row.id)); assert.equal(f.c.view.roomViews.shared.roomImages.length, 1);
  f.failSave(false); const result = await f.context.acceptSpaceImageDraft(f.c, 'shared', f.images.version, row.id); assert.equal(result.accepted, true);
  const saved = new ViewStore(f.root).load()[0].roomViews.shared; assert.deepEqual(saved.roomImages, []); assert.equal(saved.roomImageSend, undefined); assert.equal(saved.sharedDraft, '@Builder original caption');
  assert.deepEqual(media.readSpaceImage(f.root, 'shared', f.images.refs[0]).png, png, 'the space record still owns its image copy');
});
function rendererFixture() {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8'), version = randomUUID(), refs = [{ id: 'synthetic-image' }];
  const input = { value: '@Builder caption', readOnly: false, focus() {} }, nodes = { 'shared-input': input, 'forward-button': { disabled: false }, recipient: { value: 'recipient' } };
  const recipient = { id: 'recipient', nativeId: 'native-recipient', state: 'idle', spaceImagesAvailable: true, serviceCapabilities: ['spaceImageInputV1'] };
  const view = { roomImages: refs, roomImageVersion: version, sharedDraft: input.value, roomRecipient: recipient.id, roomMention: null, draftRevision: 7 };
  const calls = []; let resolve;
  const context = vm.createContext({ spaceId: 'shared', roomViews: { shared: view }, roomDraftRevision: 7, roomMention: null, roomReplyTo: '', roomSubmitting: null,
    roomPendingRecipients: new Map(), queuedRoomInputs: new Map(), uiError, members: () => [recipient], roomRecipient: () => recipient.id,
    roomImageRefs: () => view.roomImages, $: id => nodes[id], interruptPending: () => false,
    nativeWorkspaceMentions: { body: (_mention, raw) => raw.replace('@Builder ', '') }, nativeUsable: () => true, participantLabel: s => s.id,
    captureRoomView: () => Object.assign(view, { sharedDraft: input.value, draftRevision: context.roomDraftRevision }), roomQueueAvailable: () => false, roomSteerAvailable: () => false,
    render() {}, persistView: async () => {}, writeRoomDraft: (_id, next) => { input.value = next.sharedDraft; },
    api: { spaceAction: async (...args) => { calls.push(args); return new Promise(yes => { resolve = yes; }); } } });
  vm.runInContext(source.slice(source.indexOf('function roomImageForwardAvailable('), source.indexOf('async function acknowledgeRoomImageReceipt(')) +
    source.slice(source.indexOf('async function submitRoom('), source.indexOf("$('room-composer').onsubmit")), context);
  return { context, input, view, version, refs, calls, resolve: value => resolve(value) };
}
test('the actual composer sends only its explicit image recipient and retains caption and images on unconfirmed acceptance', async () => {
  const f = rendererFixture(), sending = f.context.submitRoom(false); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0][0], 'shared'); assert.equal(f.calls[0][1], 'forward'); assert.equal(f.calls[0][2][0], 'recipient');
  assert.equal(f.calls[0][2][4].version, f.version); assert.equal(f.calls[0][2][4].refs, undefined, 'renderer cannot supply arbitrary image references');
  f.resolve({ tag: 'accepted-tag', imageReceipt: { status: 'awaiting-native' } }); await sending;
  assert.equal(f.input.value, '@Builder caption'); assert.equal(f.view.roomImages, f.refs); assert.equal(f.view.roomImageSend.version, f.version);
  await assert.rejects(f.context.submitRoom(false)); assert.equal(f.calls.length, 1);
});
test('confirmed image acceptance clears its original attachments but cannot clear text edited away and back during the request', async () => {
  const f = rendererFixture(), sending = f.context.submitRoom(false); await new Promise(resolve => setImmediate(resolve));
  f.context.roomDraftRevision += 2; // Same visible text, a genuinely newer edit generation.
  f.resolve({ tag: 'accepted-tag', imageDraft: { accepted: true, refs: [], version: randomUUID() } }); await sending;
  assert.equal(f.view.roomImages.length, 0); assert.equal(f.view.roomImageSend, undefined); assert.equal(f.input.value, '@Builder caption');
});
test('cache cleanup keeps every window, shared record and private native input owner, including copied room references', t => {
  const root = directory(t), refs = media.stageSpaceImages(root, 'shared', Array.from({ length: 4 }, () => ({ bytes: png })), decoder);
  const records = [{ roomViews: { shared: { roomImages: [refs[0]] } } }];
  const snapshot = { sessions: [{ messages: [{ spaceUploads: [refs[2]] }] }], rooms: [{ id: randomUUID(), messages: [{ images: [refs[1]] }] }] };
  const keep = media.spaceImageKeepIds(records, snapshot, 'shared');
  assert.deepEqual(new Set(keep), new Set(refs.slice(0, 3).map(ref => ref.id)));
  assert.equal(media.removeUnusedSpaceImages(root, 'shared', keep).removed, 1);
  for (const ref of refs.slice(0, 3)) assert.deepEqual(media.readSpaceImage(root, 'shared', ref).png, png);
  snapshot.rooms[0].messages = []; assert.equal(media.removeUnusedSpaceImages(root, 'shared', media.spaceImageKeepIds(records, snapshot, 'shared')).removed, 1);
  assert.deepEqual(media.readSpaceImage(root, 'shared', refs[2]).png, png, 'clearing space history cannot delete a private session input image');
  snapshot.sessions = []; assert.equal(media.removeUnusedSpaceImages(root, 'shared', media.spaceImageKeepIds(records, snapshot, 'shared')).removed, 1);
  assert.deepEqual(media.readSpaceImage(root, 'shared', refs[0]).png, png, 'another saved window draft still owns its copy');
  assert.throws(() => media.spaceImageKeepIds(records, { rooms: [] }, 'shared'));
});
test('actual Main cleanup waits for a complete available snapshot and does not delete a cache with an unavailable owner', async t => {
  const f = mainFixture(t), ref = f.images.refs[0];
  f.context.updateSpaceImageDraft(f.c, 'shared', 'removeImage', ref.id, f.images.version);
  f.c.client.entries[0].closed = true;
  assert.equal((await f.context.cleanupSpaceImageCopies(f.c, 'shared')).failed, true); assert.deepEqual(media.readSpaceImage(f.root, 'shared', ref).png, png);
  f.c.client.entries[0].closed = false;
  assert.equal((await f.context.cleanupSpaceImageCopies(f.c, 'shared')).removed, 1); assert.throws(() => media.readSpaceImage(f.root, 'shared', ref));
});
test('existing merge snapshot capture preserves image draft and receipt display metadata without private native image owners', t => {
  const root = directory(t), images = packet(root), { captureSource } = require('../space-merge.cjs');
  const receipt = { status: 'accepted', tag: 'original-tag', nativeId: 'native-recipient', recipientId: 'recipient', nativeItemId: 'native-user-item', turnId: 'owned-turn', basis: 'native-local-image-echo' };
  const source = captureSource({ id: 'shared', name: 'Original space', revision: 1, metadataRevision: 1, notes: '', events: [], files: [],
    messages: [{ id: 'original-tag', role: 'human', text: 'caption', recipientId: 'recipient', status: 'submitted', images: images.refs, imageDraftVersion: images.version, imageReceipt: receipt, spaceUploads: ['PRIVATE'] }] }, []);
  assert.equal(source.rows[0].payload.imageDraftVersion, images.version); assert.deepEqual(source.rows[0].payload.imageReceipt, receipt); assert.equal(source.rows[0].payload.spaceUploads, undefined);
});
test('R1 a draft cleared in another window during a stale snapshot read cannot lose its sent image', async t => {
  const f = mainFixture(t), ref = f.images.refs[0], other = structuredClone(f.c.view); other.owner = 'another-window';
  f.c.view.roomViews.shared = { sharedDraft: '' }; f.context.views.push(other);
  f.c.client.call = async () => { other.roomViews.shared = { sharedDraft: '' }; return f.snapshot; };
  const result = await f.context.cleanupSpaceImageCopies(f.c, 'shared');
  assert.equal(result.failed, false); assert.deepEqual(media.readSpaceImage(f.root, 'shared', ref).png, png);
});
test('R1 images created and accepted during a cleanup snapshot wait are outside its deletion cut', async t => {
  const f = mainFixture(t), old = f.images.refs[0]; f.c.view.roomViews.shared = { sharedDraft: '' }; let fresh;
  f.c.client.call = async () => { [fresh] = media.stageSpaceImages(f.root, 'shared', [{ bytes: png }], decoder); return f.snapshot; };
  await f.context.cleanupSpaceImageCopies(f.c, 'shared');
  assert.throws(() => media.readSpaceImage(f.root, 'shared', old));
  assert.deepEqual(media.readSpaceImage(f.root, 'shared', fresh).png, png);
});
test('R2 cleanup cannot remove images while a backend in the actual profile layout is absent from the client', async t => {
  const f = mainFixture(t), ref = f.images.refs[0]; f.c.view.roomViews.shared = { sharedDraft: '' };
  const key = 'backends/' + 'a'.repeat(20); fs.mkdirSync(path.join(f.root, key), { recursive: true, mode: 0o700 });
  require('../service-layout.cjs').writeLayout(f.root, { format: 1, active: '.', entries: ['.', key] });
  assert.equal((await f.context.cleanupSpaceImageCopies(f.c, 'shared')).failed, true);
  assert.deepEqual(media.readSpaceImage(f.root, 'shared', ref).png, png);
});
test('R4 an image submission keeps its typed forward branch when queue availability changes during the draft save', async () => {
  const f = rendererFixture(); f.context.persistView = async () => { f.context.roomQueueAvailable = () => true; f.context.roomSteerAvailable = () => true; };
  const sending = f.context.submitRoom(false); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls[0][1], 'forward'); assert.equal(f.calls[0][2][4].version, f.version);
  f.resolve({ tag: 'accepted-tag' }); await sending;
});
test('R5 the actual delivery status expression separates image echo acceptance from a text-only RPC acknowledgement', () => {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/reading-list.js'), 'utf8');
  const m = { imageDraftVersion: 'original-image-draft', images: [{ kind: 'space-upload' }] }, context = vm.createContext({ m, uiText: key => key });
  const start = source.indexOf('function readingDeliveryStatusKey(');
  if (start >= 0) vm.runInContext(source.slice(start, source.indexOf('\n}', start) + 2), context);
  const a = source.indexOf('const status = d =>'), z = source.indexOf('\n        ui.display.computed', a);
  const status = vm.runInContext(source.slice(a, z) + '\nstatus;', context);
  assert.equal(status({ status: 'submitted' }), 'roomImages.receiptPending');
  m.imageReceipt = { status: 'accepted', basis: 'native-local-image-echo' }; assert.equal(status({ status: 'submitted' }), 'roomImages.accepted');
  delete m.imageDraftVersion; assert.equal(status({ status: 'submitted' }), 'delivery.submitted');
});
test('R6 legacy Main forward cannot inject uploaded refs around the scoped canonical draft check', () => {
  const source = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8'), handlers = new Map(), calls = [];
  const context = vm.createContext({ register: (name, callback) => handlers.set(name, callback), roomState: { assertAvailable() {} }, uiError });
  vm.runInContext(source.slice(source.indexOf('  const submit = (c, method,'), source.indexOf("  register('uiReady',")), context);
  const c = { client: { call: (...args) => { calls.push(args); return Promise.resolve(true); } } };
  assert.throws(() => handlers.get('forward')(c, 'recipient', 'caption', 'native-recipient', null, { version: 'forged', refs: [] }));
  assert.equal(calls.length, 0); handlers.get('forward')(c, 'recipient', 'ordinary text', 'native-recipient'); assert.equal(calls.length, 1);
});
