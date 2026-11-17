const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8');
const source = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
const catalog = require('../ui-messages.js');

test('mode buttons belong to their panes, without a full-width mode row', () => {
  const parents = new Map(), nodes = new Map(), stack = [];
  for (const match of html.matchAll(/<\/?([\w-]+)\b[^>]*>/g)) {
    const tag = match[1], text = match[0];
    if (text.startsWith('</')) { while (stack.length && stack.pop().tag !== tag) {} continue; }
    const attrs = Object.fromEntries([...text.matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
    if (attrs.id) { const parent = stack.at(-1)?.attrs; parents.set(attrs.id, parent?.id || parent?.class); nodes.set(attrs.id, { tag, attrs }); }
    if (!['input', 'img', 'br', 'hr', 'meta', 'link'].includes(tag)) stack.push({ tag, attrs });
  }
  assert.equal(nodes.has('reading-mode-band'), false);
  assert.equal(nodes.has('reading-mode-controls'), false);
  assert.equal(parents.get('chat-tab'), 'chat-pane-tabs');
  assert.equal(parents.get('terminal-tab'), 'native-pane-tabs');
  assert.equal(parents.get('open-native-terminal'), 'conversation-pane-toolbar');
  assert.equal(parents.get('return-to-chat'), 'native-pane-actions');
  for (const id of ['chat-tab', 'terminal-tab', 'open-native-terminal', 'return-to-chat']) {
    assert.equal(nodes.get(id).tag, 'button'); assert.equal(nodes.get(id).attrs.type, 'button');
    assert.ok(nodes.has(nodes.get(id).attrs['aria-controls']), id + ' controls a real pane');
  }
  for (const id of ['chat-tab', 'terminal-tab']) assert.ok(['true', 'false'].includes(nodes.get(id).attrs['aria-pressed']));
  assert.equal(nodes.get('close-native-terminal').attrs['data-naw-aria-label'], 'terminal.collapse');
  for (const [id, key] of [['open-native-terminal', 'view.openTerminal'], ['return-to-chat', 'terminal.returnChat']]) {
    assert.equal(nodes.get(id).attrs['data-naw-text'], key);
    assert.equal(nodes.get(id).attrs['data-naw-aria-label'], key);
    for (const lang of ['zh', 'en']) assert.ok(catalog[lang][key]);
  }
});

function harness() {
  const make = id => ({ id, hidden: false, disabled: false, visible: true, attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; }, getClientRects() { return this.visible && !this.hidden ? [{}] : []; } });
  const ids = ['conversation-pane', 'native-pane', 'chat-tab', 'terminal-tab', 'chat-pane-tabs', 'native-pane-tabs', 'native-pane-title', 'open-native-terminal', 'return-to-chat'];
  const nodes = Object.fromEntries(ids.map(id => [id, make(id)]));
  const context = vm.createContext({ $: id => nodes[id], mode: 'chat', terminalLayout: 'split' });
  vm.runInContext(source.slice(source.indexOf('function renderPaneSwitches('), source.indexOf('function renderHeaderLayout(')), context);
  return { nodes, context };
}

test('pane-local entry and return controls follow split, closed, maximized and room states', () => {
  const { nodes, context } = harness();
  for (const layout of ['split', 'hidden', 'maximized']) for (const mode of ['chat', 'terminal']) {
    context.terminalLayout = layout; context.mode = mode; nodes['native-pane'].hidden = layout === 'hidden';
    vm.runInContext('renderPaneSwitches({ id: "synthetic" }, false)', context);
    assert.equal(nodes['chat-tab'].attrs['aria-pressed'], String(mode === 'chat'));
    assert.equal(nodes['terminal-tab'].attrs['aria-pressed'], String(mode === 'terminal'));
    assert.equal(nodes['open-native-terminal'].hidden, layout !== 'hidden');
    assert.equal(nodes['open-native-terminal'].attrs['aria-expanded'], String(layout !== 'hidden'));
    assert.equal(nodes['return-to-chat'].hidden, layout !== 'maximized');
    assert.equal(nodes['native-pane-title'].hidden, true);
  }
  vm.runInContext('renderPaneSwitches({ id: "synthetic" }, true)', context);
  assert.equal(nodes['native-pane-title'].hidden, false, 'focused space member keeps its identity beside the terminal control');
  nodes['conversation-pane'].hidden = true;
  vm.runInContext('renderPaneSwitches({ id: "synthetic" }, true)', context);
  for (const id of ['chat-pane-tabs', 'native-pane-tabs', 'open-native-terminal', 'return-to-chat']) assert.equal(nodes[id].hidden, true);
  assert.equal(nodes['native-pane-title'].hidden, false);
});

test('native menu finds visible pane controls after collapse/maximize but not a hidden or disabled action', () => {
  const { nodes, context } = harness();
  const control = mode => vm.runInContext(`visibleModeControl(${JSON.stringify(mode)})`, context);
  assert.equal(control('terminal'), nodes['terminal-tab']);
  nodes['terminal-tab'].visible = false;
  assert.equal(control('terminal'), nodes['open-native-terminal']);
  nodes['chat-tab'].visible = false;
  assert.equal(control('chat'), nodes['return-to-chat']);
  nodes['return-to-chat'].hidden = true; nodes['open-native-terminal'].disabled = true;
  assert.equal(control('chat'), undefined); assert.equal(control('terminal'), undefined);
});
