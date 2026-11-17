const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8');
const source = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');

test('mode choices occupy one content band; pane headings are not duplicate controls', () => {
  const parents = new Map(), nodes = new Map(), stack = [];
  for (const match of html.matchAll(/<\/?([\w-]+)\b[^>]*>/g)) {
    const tag = match[1], text = match[0];
    if (text.startsWith('</')) { while (stack.length && stack.pop().tag !== tag) {} continue; }
    const attrs = Object.fromEntries([...text.matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
    if (attrs.id) { parents.set(attrs.id, stack.at(-1)?.attrs.id); nodes.set(attrs.id, { tag, attrs }); }
    if (!['input', 'img', 'br', 'hr', 'meta', 'link'].includes(tag)) stack.push({ tag, attrs });
  }
  assert.equal(parents.get('reading-mode-band'), 'session-view');
  assert.equal(parents.get('reading-mode-controls'), 'reading-mode-band');
  assert.ok(html.indexOf('id="reading-mode-band"') < html.indexOf('id="session-layout"'));
  for (const id of ['chat-tab', 'terminal-tab']) {
    assert.equal(parents.get(id), 'reading-mode-controls');
    assert.equal(nodes.get(id).tag, 'button'); assert.equal(nodes.get(id).attrs.type, 'button');
    assert.ok(['true', 'false'].includes(nodes.get(id).attrs['aria-pressed']));
  }
  assert.equal(nodes.get('reading-mode-controls').attrs.role, 'group');
  assert.equal(nodes.get('reading-mode-controls').attrs['aria-labelledby'], 'reading-mode-label');
  for (const id of ['chat-pane-tabs', 'native-pane-tabs']) {
    const content = html.slice(html.indexOf(`id="${id}"`)).split('</div>')[0];
    assert.match(content, /<span\b/); assert.doesNotMatch(content, /<button\b|tabindex=/);
  }
});

test('mode group stays fixed through split, hidden, maximized, room and locale redraws', () => {
  const make = id => ({ id, hidden: false, attrs: {}, parentElement: null, classList: { toggle() {} }, setAttribute(k, v) { this.attrs[k] = v; }, append(node) { node.parentElement = this; } });
  const nodes = Object.fromEntries(['reading-mode-band', 'reading-mode-controls', 'chat-tab', 'terminal-tab', 'chat-pane-tabs', 'native-pane-tabs', 'native-pane-title'].map(id => [id, make(id)]));
  for (const id of ['chat-tab', 'terminal-tab']) nodes[id].parentElement = nodes['reading-mode-controls'];
  const s = vm.createContext({ $: id => nodes[id], mode: 'chat', terminalLayout: 'split' });
  vm.runInContext(source.slice(source.indexOf('function renderPaneSwitches('), source.indexOf('function renderHeaderLayout(')), s);
  for (const inRoom of [false, true]) for (const layout of ['split', 'hidden', 'maximized']) for (const mode of ['chat', 'terminal']) {
    s.mode = mode; s.terminalLayout = layout; s.renderPaneSwitches({ id: 'synthetic' }, inRoom, layout !== 'hidden');
    for (const [id, value] of [['chat-tab', 'chat'], ['terminal-tab', 'terminal']]) {
      assert.equal(nodes[id].parentElement, nodes['reading-mode-controls'], `${inRoom}/${layout}: one fixed group`);
      assert.equal(nodes[id].attrs['aria-pressed'], String(mode === value));
    }
  }
});
