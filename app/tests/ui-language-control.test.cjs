const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const locale = require('../ui-locale.js');
const renderer = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
const begin = renderer.indexOf('// Language controls use the existing Host mirror;');
const end = renderer.indexOf('// End language/settings display controls.', begin);
assert.ok(begin >= 0 && end > begin);
function fixture() {
  const ids = ['ui-language', 'ui-language-label', 'ui-language-status', 'setup-title', 'setup-intro', 'refresh-setup', 'close-setup', 'setup-button'];
  const nodes = new Map(ids.map(id => [id, { id, textContent: '', attributes: {}, setAttribute(key, value) { this.attributes[key] = value; } }]));
  const control = nodes.get('ui-language'); control.options = [{ value: 'zh' }, { value: 'en' }];
  const rail = { textContent: '' }; nodes.get('setup-button').querySelector = () => rail;
  let accepted = 'zh', save, reviewRefreshes = 0;
  const writes = [], observers = [], calls = [];
  const state = { sessions: [{ nativeId: 'original-native', owner: 'original-owner', liveDraft: '中文 English unsent\n{raw}' }], sharedDraft: '@original 中文 draft' };
  const document = { activeElement: control };
  const ui = { language: { text: (key, params) => locale.format(accepted, key, params), getSnapshot: () => ({ active: accepted }),
    set: value => { writes.push(value); return new Promise((resolve, reject) => { save = { accept() { accepted = value; resolve(); for (const fn of observers) fn(); }, reject }; }); },
    subscribe: fn => { observers.push(fn); return () => {}; } } };
  const context = vm.createContext({ selected: '', ui, state, document, $: id => { assert.ok(nodes.has(id), 'Locale-only control must not reach another surface'); return nodes.get(id); }, uiText: ui.language.text,
    toast() {}, butlerReviewView: { refresh() { reviewRefreshes++; } }, api: new Proxy({}, { get(_target, key) { if (key === 'onLocale') return () => () => {}; calls.push(key); throw Error('Unexpected native/product API'); } }), disposers: [] });
  vm.runInContext(renderer.slice(begin, end), context);
  const hook = renderer.indexOf("$('ui-language').onchange =");
  const hookEnd = renderer.indexOf('for (const input of document.querySelectorAll', hook);
  assert.ok(hook > 0 && hookEnd > hook);
  vm.runInContext(renderer.slice(hook, hookEnd), context);
  return { context, control, nodes, document, state, writes, calls, reviewRefreshes: () => reviewRefreshes, save: () => save, get accepted() { return accepted; }, change: value => vm.runInContext(`changeInterfaceLanguage(${JSON.stringify(value)})`, context) };
}

test('pending language selection retains accepted display, focus, native identity and drafts without repeated writes', async () => {
  const f = fixture(), before = JSON.stringify(f.state);
  const pending = f.change('en');
  assert.equal(f.control.value, 'zh');
  assert.equal(f.control.attributes['aria-busy'], 'true'); assert.equal(f.reviewRefreshes(), 0);
  assert.equal(f.document.activeElement, f.control);
  await f.change('en'); assert.deepEqual(f.writes, ['en']);
  f.save().accept(); await pending;
  assert.equal(f.control.value, 'en');
  assert.equal(f.control.attributes['aria-busy'], 'false');
  assert.equal(f.nodes.get('setup-title').textContent, 'Settings'); assert.equal(f.reviewRefreshes(), 1);
  assert.equal(f.document.activeElement, f.control);
  assert.equal(JSON.stringify(f.state), before);
  assert.deepEqual(f.calls, []);
});

test('Host failure restores accepted language and gives only a fixed message in that language', async () => {
  const f = fixture(), before = JSON.stringify(f.state);
  const pending = f.change('en');
  f.save().reject(Error('PRIVATE_STORAGE_PATH_MUST_NOT_RENDER')); await pending;
  assert.equal(f.accepted, 'zh');
  assert.equal(f.control.value, 'zh');
  assert.equal(f.nodes.get('ui-language-status').textContent, '语言未能保存，请重试。');
  assert.equal(f.nodes.get('ui-language-status').hidden, false);
  assert.equal(JSON.stringify(f.state), before);
  assert.equal(f.document.activeElement, f.control);
  assert.deepEqual(f.calls, []);
});
