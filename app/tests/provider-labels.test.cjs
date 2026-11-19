const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const renderer = fs.readFileSync(require.resolve('../renderer/renderer.js'), 'utf8');
function declaration(name) {
  const start = renderer.indexOf(`function ${name}(`), end = renderer.indexOf('\n}', start) + 2;
  assert.ok(start >= 0 && end > start);
  return renderer.slice(start, end);
}
function element(textContent = '') {
  const classes = new Set();
  return {
    textContent, dataset: {}, attributes: {}, children: [],
    classList: { contains: n => classes.has(n), toggle(n, on) { on ? classes.add(n) : classes.delete(n); }, remove: n => classes.delete(n) },
    contains: () => false,
    insertBefore(child) { child.parentElement = this; },
    append(...children) { for (const child of children) child.parentElement = this; },
    replaceChildren(...children) { this.children = children; },
    setAttribute(name, value) { this.attributes[name] = value; },
  };
}
function header() {
  const elements = new Map(), $ = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  $('run-status').parentElement = element();
  const assign = (n, slot, value) => { if (slot === 'text') n.textContent = value; else n.setAttribute(slot, value); };
  const context = vm.createContext({
    $, document: { activeElement: null }, window: { nativeWorkspaceSpaces: { roomIds: s => s.roomIds || [] } },
    state: { room: {} }, roomOverview: null, sessionMenu: null, roomMenu: null,
    captureReadingViews() {}, restoreOverviewReading() {}, archivedName: s => s.name,
    sessionShortId: id => id.slice(0, 6), uiText: key => key,
    ui: { displayText: value => value, display: { unbind() {}, computed: (n, slot, fn) => assign(n, slot, fn()), text: (n, value) => assign(n, 'text', value), attribute: assign } },
    node: (_tag, text) => element(text),
  });
  vm.runInContext(declaration('providerName') + '\n' + declaration('renderHeaderLayout'), context);
  return { $, render: s => context.renderHeaderLayout(s, false), providerName: context.providerName };
}
for (const [provider, expected] of [['dsh', 'DSH'], ['claude', 'Claude Code'], ['codex', 'Codex']]) {
  test(`${provider} header names its actual runtime in visible text, title and accessible name`, () => {
    const f = header(), session = { id: 'abcdef-session', nativeId: 'synthetic-native', provider, name: 'Synthetic session', model: 'synthetic-model' };
    f.render(session);
    const fields = f.$('subtitle').children;
    assert.equal(fields[0].textContent, expected);
    assert.equal(fields[0].title, expected);
    assert.equal(fields[0].attributes['aria-label'], expected);
    assert.equal(fields[1].textContent, 'abcdef');
    assert.equal(fields[2].textContent, 'synthetic-model');
    assert.equal(f.providerName(provider), provider === 'claude' ? 'Claude' : expected);
  });
}
test('switching between provider sessions replaces cached header identity', () => {
  const f = header(), session = { id: 'abcdef-session', nativeId: 'synthetic-native', name: 'Synthetic session' };
  for (const [provider, name] of [['codex', 'Codex'], ['dsh', 'DSH'], ['claude', 'Claude Code']]) {
    f.render({ ...session, provider });
    assert.equal(f.$('subtitle').children[0].textContent, name);
  }
});
test('phone home and space labels use the existing provider names including DSH', () => {
  const source = fs.readFileSync(require.resolve('../mobile-web/workspace.js'), 'utf8');
  const line = source.split('\n').find(s => s.trimStart().startsWith('const providerName ='));
  assert.ok(line);
  const name = vm.runInNewContext(line + '\nproviderName');
  for (const [provider, expected] of [['dsh', 'DSH'], ['claude', 'Claude'], ['codex', 'Codex'], ['deepseek', 'DeepSeek']]) assert.equal(name(provider), expected);
});
