const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { randomUUID } = require('node:crypto');
const { ViewStore, validViews } = require('../view-store.cjs');
const { ImagePreviews, imageSource } = require('../native-images.cjs');
const { uiError } = require('../ui-errors.cjs');
const images = require('../space-images.cjs'), main = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=', 'base64');
const decoder = { createFromBuffer: bytes => ({ isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }), toPNG: () => bytes,
  resize: () => ({ toPNG: () => bytes, toDataURL: () => 'data:image/png;base64,' + bytes.toString('base64') }), toDataURL: () => 'data:image/png;base64,' + bytes.toString('base64') }) };
function band(from, to) { const a = main.indexOf(from), z = main.indexOf(to, a); assert.ok(a >= 0 && z > a); return main.slice(a, z); }
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'space-draft-test-'))); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new ViewStore(root); store.load();
  const c = { view: { owner: 'synthetic-window', selected: 'room', mode: 'chat', roomViews: { shared: { sharedDraft: '@Builder ORIGINAL TEXT', roomRecipient: 'builder' } } } };
  store.save([c.view]); let failSave = false;
  const context = vm.createContext({ require: name => name === './space-images.cjs' ? images : require(path.join(__dirname, '..', name)),
    dataDir: root, nativeImage: decoder, randomUUID, uiError, validViews, structuredClone,
    roomState: { writable: () => {} }, saveViews: () => { if (failSave) throw Error('Synthetic save failure'); store.save([c.view]); } });
  vm.runInContext(band('function hasSavedSpaceDraft(', 'function connectionUpdateOptions('), context);
  const update = (action, value, version = c.view.roomViews.shared.roomImageVersion) => context.updateSpaceImageDraft(c, 'shared', action, value, version);
  return { root, c, store, context, update, failSave: value => { failSave = value; } };
}
test('actual Main image draft transaction saves before ACK and a fresh ViewStore restores the image with original text', t => {
  const f = fixture(t), saved = f.update('stageImages', [{ bytes: png, name: 'Screen.png' }]);
  const restored = new ViewStore(f.root).load()[0];
  assert.deepEqual(restored.roomViews.shared.roomImages, JSON.parse(JSON.stringify(saved.refs))); assert.equal(restored.roomViews.shared.roomImageVersion, saved.version);
  assert.equal(restored.roomViews.shared.sharedDraft, '@Builder ORIGINAL TEXT'); assert.equal(restored.roomViews.shared.roomRecipient, 'builder');
  assert.deepEqual(images.readSpaceImage(f.root, 'shared', saved.refs[0]).png, png);
  assert.equal(f.context.hasSavedSpaceDraft([restored], 'shared'), true);
  restored.roomViews.shared.sharedDraft = ''; assert.equal(f.context.hasSavedSpaceDraft([restored], 'shared'), true, 'image-only drafts block discarding a merged space');
});
test('failed import or removal save keeps prior memory and disk, and discards only the new unacknowledged copy', t => {
  const f = fixture(t), saved = f.update('stageImages', [{ bytes: png }]), before = fs.readFileSync(f.store.file), memory = JSON.stringify(f.c.view);
  f.failSave(true); assert.throws(() => f.update('stageImages', [{ bytes: png }]));
  assert.equal(JSON.stringify(f.c.view), memory); assert.deepEqual(fs.readFileSync(f.store.file), before);
  const file = images.readSpaceImage(f.root, 'shared', saved.refs[0]).path; assert.deepEqual(fs.readdirSync(path.dirname(file)), [saved.refs[0].id]);
  assert.throws(() => f.update('removeImage', saved.refs[0].id)); assert.equal(JSON.stringify(f.c.view), memory); assert.deepEqual(fs.readFileSync(f.store.file), before);
  assert.deepEqual(images.readSpaceImage(f.root, 'shared', saved.refs[0]).png, png);
});
test('a stale remove cannot clear a newer draft; accepted removal keeps text and the other image', t => {
  const f = fixture(t), first = f.update('stageImages', [{ bytes: png }]), next = f.update('stageImages', [{ bytes: png }]);
  assert.throws(() => f.update('unknown-action', first.refs[0].id));
  assert.throws(() => f.update('removeImage', first.refs[0].id, first.version));
  assert.equal(f.c.view.roomViews.shared.roomImages.length, 2);
  const removed = f.update('removeImage', first.refs[0].id, next.version); assert.equal(removed.refs.length, 1); assert.equal(removed.refs[0].id, next.refs[1].id);
  assert.equal(new ViewStore(f.root).load()[0].roomViews.shared.sharedDraft, '@Builder ORIGINAL TEXT');
});
test('actual viewState preserves a newer image draft against an older text-only save and omitted spaces', t => {
  const f = fixture(t), saved = f.update('stageImages', [{ bytes: png }]); let handler;
  f.context.register = (name, fn) => { assert.equal(name, 'viewState'); handler = fn; };
  vm.runInContext(band("  register('viewState',", "  register('openLocalFile',"), f.context);
  handler(f.c, { selected: 'room', mode: 'chat', roomViews: { shared: { sharedDraft: 'NEW TEXT', roomImages: [] } } });
  const loaded = new ViewStore(f.root).load()[0]; assert.equal(loaded.roomViews.shared.sharedDraft, 'NEW TEXT'); assert.deepEqual(loaded.roomViews.shared.roomImages, JSON.parse(JSON.stringify(saved.refs))); assert.equal(loaded.roomViews.shared.roomImageVersion, saved.version);
  const other = randomUUID(); handler(f.c, { selected: 'room', mode: 'chat', roomViews: { [other]: { sharedDraft: 'Other space text' } } });
  assert.deepEqual(new ViewStore(f.root).load()[0].roomViews.shared.roomImages, JSON.parse(JSON.stringify(saved.refs)));
});
test('ViewStore rejects cross-space references, path injection and oversized or unversioned image drafts', t => {
  const f = fixture(t), saved = f.update('stageImages', [{ bytes: png }]), original = new ViewStore(f.root).load();
  for (const mutate of [v => { v[0].roomViews[randomUUID()] = v[0].roomViews.shared; }, v => { v[0].roomViews.shared.roomImages[0].path = '/outside'; },
    v => { v[0].roomViews.shared.roomImages = Array(5).fill(saved.refs[0]); }, v => { delete v[0].roomViews.shared.roomImageVersion; }]) {
    const bad = structuredClone(original); mutate(bad); assert.equal(validViews(bad), false); assert.throws(() => f.store.save(bad));
  }
  assert.deepEqual(new ViewStore(f.root).load(), original);
});
test('actual local draft preview uses only this window draft authority, works offline, and invalidates a removed image token', async t => {
  const f = fixture(t), saved = f.update('stageImages', [{ bytes: png }]); let backendCalls = 0;
  f.c.client = { call: async () => { backendCalls++; throw Error('Backend offline'); } };
  Object.assign(f.context, { ImagePreviews, imageSource, validRoomId: require('../collaboration-spaces.cjs').roomId });
  const resolver = vm.runInContext(band('  const imagesFor = c =>', "  register('previewImage',") + '\nimagesFor;', f.context), previews = resolver(f.c);
  t.after(() => previews.close());
  const preview = await previews.preview({ kind: 'space-draft', roomId: 'shared', messageId: saved.version, index: 0 });
  assert.equal(preview.thumbnail, 'data:image/png;base64,' + png.toString('base64')); assert.equal(await previews.expand(preview.token), preview.thumbnail); assert.equal(backendCalls, 0);
  await assert.rejects(previews.preview({ kind: 'space-draft', roomId: randomUUID(), messageId: saved.version, index: 0 }));
  f.update('removeImage', saved.refs[0].id); await assert.rejects(previews.expand(preview.token)); assert.equal(backendCalls, 0);
});

async function widget(source, status = 'preview') {
  const bootstrap = fs.readFileSync(path.join(__dirname, '../dsh/bootstrap.js'), 'utf8'), from = bootstrap.indexOf('    function createDisplayBindings('), to = bootstrap.indexOf('    function mountWorkspace(', from);
  const createBindings = vm.runInNewContext('(' + bootstrap.slice(from, to).trim() + ')');
  let doc, language = 'zh', previews = 0, removed = 0, copied = 0;
  class E {
    constructor(tag) { this.tagName = tag; this.children = []; this.attrs = new Map(); this.dataset = {}; this.ownerDocument = doc; this.isConnected = true; this.classList = { toggle() {} }; this._text = ''; }
    get childElementCount() { return this.children.length; } get textContent() { return this._text; } set textContent(value) { this._text = value; this.children = []; }
    append(...items) { this.children.push(...items); } replaceChildren(...items) { this.children = items; }
    setAttribute(k, v) { this.attrs.set(k, v); } removeAttribute(k) { this.attrs.delete(k); } getAttribute(k) { return this.attrs.get(k) || null; }
    addEventListener() {} closest() { return null; } focus() {}
    querySelectorAll() { return this.children.flatMap(c => [...(c.attrs.has('data-naw-i18n-bound') ? [c] : []), ...c.querySelectorAll()]); }
  }
  doc = { createElement: tag => new E(tag) }; const host = new E('div');
  const locale = require('../ui-locale.js'), text = (k, p) => locale.format(language, k, p), display = createBindings(text), root = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/native-images.js'), 'utf8'), { window: root, Promise });
  const api = { previewImage: async () => { previews++; return { token: 'test-preview', key: 'test', width: 1, height: 1, thumbnail: 'data:image/png;base64,fixture' }; },
    expandImage: async () => 'data:image/png;base64,expanded', releaseImage: async () => {}, copyImage: async () => { copied++; } };
  const renderer = root.nativeWorkspaceImages.mount(host, api, { display, text, displayText: x => x, createError: locale.createError, remove: async () => { removed++; } });
  renderer.update([{ kind: 'space-upload', name: 'Screen.png' }], source, 'Draft', status); await new Promise(resolve => setImmediate(resolve));
  const all = el => el.children.flatMap(c => [c, ...all(c)]);
  return { host, renderer, nodes: () => all(host), stats: () => ({ previews, removed, copied }), english() { language = 'en'; display.refresh(host); } };
}
test('the actual image widget shows a local draft preview and removal without losing its image on language repaint', async t => {
  const w = await widget({ kind: 'space-draft', roomId: 'shared', messageId: randomUUID() }); t.after(() => w.renderer.dispose());
  const remove = w.nodes().find(e => e.className === 'native-image-remove'), image = w.nodes().find(e => e.tagName === 'img');
  assert.ok(remove); assert.ok(image); assert.equal(remove.getAttribute('aria-label'), '移除 Screen.png');
  assert.equal(image.src, 'data:image/png;base64,fixture'); w.english(); assert.equal(remove.getAttribute('aria-label'), 'Remove Screen.png'); assert.ok(w.nodes().includes(image));
  await remove.onclick(); assert.deepEqual(w.stats(), { previews: 1, removed: 1, copied: 0 });
});
test('the draft-only preview status and removal callback cannot enable a native row', async t => {
  const w = await widget({ kind: 'session', sessionId: 'session', nativeId: 'native', messageId: 'original' }); t.after(() => w.renderer.dispose());
  assert.equal(w.nodes().some(e => e.className === 'native-image-remove'), false); assert.deepEqual(w.stats(), { previews: 0, removed: 0, copied: 0 });
});

function rendererFixture(f, gate = Promise.resolve()) {
  let calls = 0;
  const source = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
  const context = vm.createContext({ initialViews: structuredClone(f.c.view.roomViews), Uint8Array, uiError, sharedSurface: () => true, render() {},
    api: { spaceAction: async (id, action, args) => { calls++; await gate; return f.context.updateSpaceImageDraft(f.c, id, action, structuredClone(args[0]), args[1]); } } });
  vm.runInContext("let roomViews=initialViews, selected='room', spaceId='shared', disconnected=false, state={room:{id:'shared'}}, roomDraftRevision=0;\n" +
    source.slice(source.indexOf('const roomImageRefs ='), source.indexOf('const imageFiles =')), context);
  return { context, calls: () => calls, state: () => JSON.parse(vm.runInContext('JSON.stringify({roomViews,spaceId,roomDraftRevision})', context)) };
}
const imageFile = () => ({ name: 'Async.png', size: png.length, arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.length) });
test('a completed merged space accepts an image draft while a pending or failed merge still refuses it', t => {
  const f = fixture(t), ui = rendererFixture(f);
  assert.equal(vm.runInContext("state.room.merge={imported:true,stage:'ready'};roomImageDraftEditable('shared')", ui.context), true);
  assert.equal(vm.runInContext("state.room.merge={imported:false,stage:'ready'};roomImageDraftEditable('shared')", ui.context), false);
  assert.equal(vm.runInContext("state.room.merge={imported:true,stage:'failed'};roomImageDraftEditable('shared')", ui.context), false);
});
test('actual renderer import settles into its original space after switching views and does not rewrite either text draft', async t => {
  const f = fixture(t); let finish; const gate = new Promise(resolve => { finish = resolve; }), ui = rendererFixture(f, gate), other = randomUUID();
  const pending = ui.context.addRoomImages([imageFile()]); await new Promise(resolve => setImmediate(resolve));
  ui.context.otherSpace = other; vm.runInContext("spaceId=otherSpace; state.room={id:otherSpace}; roomViews[otherSpace]={sharedDraft:'OTHER UNSENT TEXT',roomRecipient:'reader'}", ui.context);
  finish(); await pending;
  const state = ui.state(); assert.equal(state.spaceId, other); assert.equal(state.roomViews.shared.roomImages.length, 1); assert.equal(state.roomViews.shared.sharedDraft, '@Builder ORIGINAL TEXT');
  assert.equal(state.roomViews[other].sharedDraft, 'OTHER UNSENT TEXT'); assert.equal(state.roomViews[other].roomImages, undefined); assert.equal(state.roomDraftRevision, 0);
});
test('actual renderer retains its images after a failed save and rejects another import while the first is pending', async t => {
  const f = fixture(t); f.update('stageImages', [{ bytes: png }]); const initial = structuredClone(f.c.view.roomViews); let finish;
  const ui = rendererFixture(f, new Promise(resolve => { finish = resolve; })), pending = ui.context.addRoomImages([imageFile()]);
  await new Promise(resolve => setImmediate(resolve)); await assert.rejects(ui.context.addRoomImages([imageFile()])); assert.equal(ui.calls(), 1);
  f.failSave(true); finish(); await assert.rejects(pending);
  assert.deepEqual(ui.state().roomViews.shared.roomImages, initial.shared.roomImages); assert.equal(ui.state().roomViews.shared.sharedDraft, initial.shared.sharedDraft); assert.equal(ui.state().roomViews.shared.roomImagesImporting, false);
});
test('actual renderer removal finishing in another space preserves that space draft generation', async t => {
  const f = fixture(t), first = f.update('stageImages', [{ bytes: png }]); let finish;
  const ui = rendererFixture(f, new Promise(resolve => { finish = resolve; })), pending = ui.context.removeRoomImage('shared', first.refs[0].id), other = randomUUID();
  await new Promise(resolve => setImmediate(resolve)); ui.context.otherSpace = other;
  vm.runInContext("spaceId=otherSpace; state.room={id:otherSpace}; roomViews[otherSpace]={sharedDraft:'OTHER UNSENT TEXT'}", ui.context); finish(); await pending;
  assert.equal(ui.state().roomViews.shared.roomImages.length, 0); assert.equal(ui.state().roomDraftRevision, 0); assert.equal(ui.state().roomViews[other].sharedDraft, 'OTHER UNSENT TEXT');
});
