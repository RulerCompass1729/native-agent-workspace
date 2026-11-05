// Real image promises and reader callbacks, without providers or a browser.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const filename = path.join(__dirname, 'reading-locale.test.cjs');
const helpers = fs.readFileSync(filename, 'utf8').split("test('typed own notices")[0];
assert.ok(helpers.includes('function fixture('));
const shared = vm.createContext({ require: createRequire(filename), __dirname, console });
vm.runInContext(helpers + '\nglobalThis.makeReadingFixture = fixture;', shared);
// The locale fixture normally ignores input. Record the real reader listeners
// here so these checks can deliver capture, activation and scroll separately.
vm.runInContext(`Element.prototype.addEventListener = function(type, listener, options) {
  (this.listeners ||= {})[type] = listener;
  (this.listenerOptions ||= {})[type] = options;
};`, shared);
const settle = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  let preview, expanded, expands = 0;
  const f = shared.makeReadingFixture([{ id: 'image-row', role: 'assistant', status: 'complete', text: 'Original image', images: [{}] }], false, {}, {
    previewImage: () => new Promise(resolve => { preview = resolve; }),
    expandImage: () => expands++ ? Promise.resolve('data:image/png;base64,FULL')
      : new Promise(resolve => { expanded = resolve; }),
    releaseImage: () => Promise.resolve(), readingState: () => Promise.resolve(),
  });
  f.context.attempt = fn => fn();
  Object.assign(f.root, { clientHeight: 500, scrollHeight: 1000, scrollTop: 120,
    getClientRects: () => [{}], getBoundingClientRect: () => ({ top: 0, bottom: 500 }) });
  const descendants = node => [node, ...node.childNodes.flatMap(descendants)];
  const toggle = descendants(f.root).find(n => n.tagName === 'button' && n.className === 'native-image-toggle');
  assert.ok(toggle); toggle.closest = selector => selector === '.native-image-toggle' ? toggle : null;
  toggle.focus = () => { f.document.activeElement = toggle; };
  const host = descendants(f.root).find(n => n.className === 'message-images');
  const saved = () => JSON.parse(vm.runInContext('JSON.stringify(readingPositions)', f.context))['session-A'];
  return { ...f, saved,
    // Capture phase precedes activation, including an assistive click with no pointerdown.
    click() {
      if (host.listeners?.click) { assert.equal(host.listenerOptions.click, true); host.listeners.click({ target: toggle }); }
      return toggle.onclick();
    },
    escape() {
      let stopped = false;
      const event = { target: toggle, key: 'Escape', preventDefault() {}, stopPropagation() { stopped = true; } };
      if (host.listeners?.keydown) { assert.equal(host.listenerOptions.keydown, true); host.listeners.keydown(event); }
      toggle.parentElement.listeners.keydown(event);
      assert.equal(stopped, true, 'the image handler prevents the reader bubble handler');
    },
    async preview() { preview({ token: 'synthetic-token', key: 'image-fold', thumbnail: 'data:image/png;base64,THUMB', width: 32, height: 16 }); await settle(); },
    async expanded(opening) { expanded('data:image/png;base64,FULL'); await opening; await settle(); },
    latest() { f.context.changeReadingPage(f.view, 'latest'); f.root.scrollTop = 500; f.view.assignedTop = 500; assert.equal(saved().follow, true); },
  };
}
test('delayed image expansion cannot overwrite a later Latest intent or its fold choice', async () => {
  const f = fixture(); await f.preview(); const opening = f.click(); await settle();
  f.latest(); await f.expanded(opening);
  assert.equal(f.saved().follow, true); assert.equal(f.saved().anchor, '');
  assert.equal(f.saved().folds['image-fold'], true);
});
test('a first preview that returns after Latest cannot restore its earlier manual reading intent', async () => {
  const f = fixture(), opening = f.click(); f.latest(); await f.preview(); await settle();
  await f.expanded(opening); assert.equal(f.saved().follow, true); assert.equal(f.saved().anchor, '');
  assert.equal(f.saved().folds['image-fold'], true);
});
test('a newer search position survives the image reply without losing the chosen fold', async () => {
  const f = fixture(); await f.preview(); const opening = f.click(); await settle();
  f.context.pendingSearch = { top: 160, follow: false, anchor: 'search-result', offset: 16 };
  vm.runInContext('messageViews.values().next().value.intent = { position: pendingSearch }; saveReading(messageViews.values().next().value, pendingSearch);', f.context);
  await f.expanded(opening);
  assert.equal(f.saved().anchor, 'search-result'); assert.equal(f.saved().offset, 16);
  assert.equal(f.saved().follow, false); assert.equal(f.saved().folds['image-fold'], true);
});
test('a fresh assistive image activation after Latest remains an explicit manual reading choice', async () => {
  const f = fixture(); await f.preview(); f.latest();
  const opening = f.click(); await settle(); assert.equal(f.saved().follow, false);
  await f.expanded(opening); assert.equal(f.saved().follow, false);
});
test('manual scrolling after Latest remains manual when the older image promise resolves', async () => {
  const f = fixture(); await f.preview(); const opening = f.click(); await settle(); f.latest();
  f.view.intent = null; f.view.assignedTop = undefined; f.view.pageChanging = false; f.root.scrollTop = 120;
  f.root.listeners.scroll(); assert.equal(f.saved().follow, false);
  await f.expanded(opening); assert.equal(f.saved().follow, false); assert.equal(f.saved().top, 120);
});
test('Escape collapsing an image after Latest remains manual even when its keydown stops propagation', async () => {
  const f = fixture(); await f.preview(); const opening = f.click(); await settle(); await f.expanded(opening);
  f.latest(); f.escape();
  assert.equal(f.saved().follow, false); assert.equal(f.saved().folds['image-fold'], false);
});
