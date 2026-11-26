// 每日发现 (R252, 11-25): content first, settings behind a toggle, × and outside click close, an unsaved draft survives.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const locale = require('../ui-locale.js'), { fixture } = require('./fixtures/task-board-dom.cjs');

function day(offset) {
  const d = new Date(); d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function status(extra = {}) {
  const item = (id, read = false) => ({ id, title: 'Synthetic project ' + id, why: 'matches the synthetic concern', url: 'https://example.com/' + id, read, ignored: false });
  return {
    config: { enabled: true, concern: 'Saved synthetic concern', time: '09:00' }, source: 'https://github.com/trending', allowed: true, error: null, suggestion: null, unread: 2, popup: false,
    runs: [
      { id: 'today', state: 'ready', day: day(0), budgetDay: day(0), chargedMicros: 1200, items: [item('a'), item('b')] },
      { id: 'older', state: 'ready', day: day(-2), budgetDay: day(-2), chargedMicros: 900, items: [item('c', true), item('d')] },
    ],
    ...extra,
  };
}
async function setup(value = status()) {
  const f = fixture(), proto = Object.getPrototypeOf(f.host);
  if (!Object.getOwnPropertyDescriptor(proto, 'firstChild')) Object.defineProperty(proto, 'firstChild', { get() { return this.children[0]; } });
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(require.resolve('../renderer/regular-popup.js'), 'utf8'), context);
  f.value = value; f.calls = [];
  f.api = {
    discoveries: async (action, ...args) => { f.calls.push([action, ...args]); return f.value; },
    onDiscoveries: callback => { f.push = callback; return () => {}; },
    openExternal: async () => {},
  };
  f.button = f.doc.createElement('button'); f.badge = f.doc.createElement('span'); f.doc.body.append(f.button);
  f.view = context.nativeWorkspaceRegularPopup.bind({ host: f.host, button: f.button, badge: f.badge, document: f.doc, api: f.api, text: (k, p) => locale.format('zh', k, p) });
  await new Promise(resolve => setImmediate(resolve));
  f.dialog = f.host.querySelector('.discoveries-dialog'); f.popup = f.host.querySelector('.discoveries-popup');
  f.settings = f.host.querySelector('.discoveries-settings'); f.toggle = f.host.querySelector('.discoveries-settings-toggle');
  f.concern = f.host.querySelector('textarea'); f.unsaved = f.host.querySelector('.discoveries-unsaved');
  f.open = async () => { await f.button.onclick(); };
  return f;
}

test('the dialog closes on an outside click or ×, and shows content before its folded settings', async () => {
  const f = await setup();
  assert.equal(f.dialog.getAttribute('closedby'), 'any');
  await f.open();
  assert.equal(f.dialog.open, true);
  assert.deepEqual(f.dialog.children.map(e => e.tagName + '.' + e.className), ['HEADER.', 'SECTION.discoveries-settings', 'DIV.discoveries-content', 'FOOTER.discoveries-footer']);
  assert.equal(f.settings.hidden, true, 'a running source opens to its content');
  assert.equal(f.toggle.getAttribute('aria-expanded'), 'false'); assert.equal(f.toggle.textContent, '设置 ⌄');
  // aria-expanded names the state, so a screen reader hears 设置 without the arrow (N7).
  const mark = f.toggle.querySelector('.discoveries-settings-mark');
  assert.equal(mark.getAttribute('aria-hidden'), 'true'); assert.equal(f.toggle.children[0].textContent, '设置');
  assert.equal(f.host.querySelector('.discoveries-summary').textContent, 'GitHub Trending · 每日 · 每天 09:00 · 已开启');
  f.toggle.fire('click');
  assert.equal(f.settings.hidden, false); assert.equal(f.toggle.textContent, '设置 ⌃');
  const x = f.dialog.querySelectorAll('.discoveries-x')[0];
  assert.equal(x.textContent, '×'); assert.equal(x.getAttribute('aria-label'), locale.format('zh', 'discoveries.closeLabel'));
  x.fire('click');
  assert.equal(f.dialog.open, false);
  f.view.dispose();
});

test('a source that is off opens with its settings, and privacy and budget read as one paragraph', async () => {
  const f = await setup(status({ config: { enabled: false, concern: '', time: '09:00' }, runs: [], unread: 0 }));
  await f.open();
  assert.equal(f.settings.hidden, false);
  const terms = f.host.querySelectorAll('.discoveries-privacy');
  assert.equal(terms.length, 1); assert.match(terms[0].textContent, /DeepSeek/); assert.match(terms[0].textContent, /预算每天 \$0\.01/, 'the budget is daily (N6)');
  assert.match(locale.format('en', 'discoveries.terms'), /\$0\.01 daily budget; it stops when the budget is exceeded or the usage is unclear\./);
  assert.equal(f.host.querySelector('.discoveries-location'), null);
  assert.equal(f.host.querySelector('.discoveries-empty').hidden, false);
  f.view.dispose();
});

// E: an outside click keeps the unsaved draft; the next opening shows the settings, marked 未保存.
test('an unsaved draft survives a dismissal and a status push, and reopens its settings marked 未保存', async () => {
  const f = await setup();
  await f.open();
  f.concern.value = 'Unsaved synthetic draft'; f.concern.fire('input');
  assert.equal(f.unsaved.textContent, '未保存'); assert.equal(f.unsaved.hidden, false);
  f.dialog.close();
  f.push(status({ config: { enabled: true, concern: 'A newer saved concern', time: '10:00' } }));
  assert.equal(f.concern.value, 'Unsaved synthetic draft');
  await f.open();
  assert.equal(f.settings.hidden, false); assert.equal(f.toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(f.unsaved.textContent, '未保存'); assert.equal(f.doc.activeElement, f.concern);
  assert.equal(f.concern.value, 'Unsaved synthetic draft');
  f.view.dispose();
});

test('today comes first; earlier days fold one per day with their counts', async () => {
  const f = await setup();
  await f.open();
  const content = f.host.querySelector('.discoveries-content'), today = content.children[0], list = content.children[1];
  assert.equal(today.textContent, locale.format('zh', 'discoveries.today', { count: 2 }));
  assert.deepEqual(list.querySelectorAll('h3').map(e => e.textContent), ['Synthetic project a', 'Synthetic project b']);
  const days = f.host.querySelectorAll('.discoveries-day');
  assert.equal(days.length, 1); assert.equal(days[0].open, undefined, 'folded until clicked');
  assert.equal(days[0].querySelector('summary').textContent, day(-2) + locale.format('zh', 'discoveries.dayUnread', { count: 2, unread: 1 }));
  assert.deepEqual(days[0].querySelectorAll('h3').map(e => e.textContent), ['Synthetic project c', 'Synthetic project d']);
  f.view.dispose();
});

// ②: the arrival card stays manual, so opening it never closes an open task board; an outside click closes it.
test('the new-result card closes on an outside click, listening only while it is open', async () => {
  const f = await setup();
  assert.equal(f.popup.getAttribute('popover'), 'manual');
  f.push(status({ popup: true }));
  assert.equal(f.popup.popoverOpen, true);
  f.doc.fire('toggle', { target: f.popup });
  assert.equal(f.doc.listeners.get('pointerdown')?.size, 1);
  f.doc.fire('pointerdown', { target: f.popup.querySelector('article') });
  assert.equal(f.popup.popoverOpen, true, 'a click inside keeps it');
  f.doc.fire('pointerdown', { target: f.content });
  assert.equal(f.popup.popoverOpen, false);
  f.doc.fire('toggle', { target: f.popup });
  assert.equal(f.doc.listeners.get('pointerdown')?.size || 0, 0);
  f.view.dispose();
});
