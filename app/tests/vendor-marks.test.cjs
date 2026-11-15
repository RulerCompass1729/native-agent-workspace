// The person, 2026-11-13: 「如何在侧边栏,或者其他地方区分不同的 agent 厂商?是否可以用他们的 icon 代替?」
// Letter fallback and native vendor identity; brand image files remain outside Git.
// A Codex session whose vendor is unreported keeps its shell letters. Synthetic records only.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { EventEmitter } = require('node:events');
const locale = require('../ui-locale.js'), messages = require('../ui-messages.js');
const { Workspace } = require('../workspace.cjs');
const { createRequire } = require('node:module');
const renderer = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');

// A minimal element: enough for paintVendorMark to set its classes and its first text node.
class Text { constructor(value) { this.nodeType = 3; this.nodeValue = value; } }
class Element {
  constructor(className = '') { this.nodeType = 1; this.className = className; this.dataset = {}; this.children = []; }
  get classList() { return { contains: name => this.className.split(/\s+/).includes(name) }; }
  get firstChild() { return this.children[0] || null; }
  prepend(child) { this.children.unshift(child); }
  append(child) { this.children.push(child); }
}
function page(lang) {
  const start = renderer.indexOf('const VENDOR_MARKS'), end = renderer.indexOf('\n', renderer.indexOf('function icon(record'));
  assert.ok(start > 0 && end > start, 'the vendor mark block');
  const context = vm.createContext({
    uiText: (key, params) => locale.format(lang, key, params), Node: { TEXT_NODE: 3 },
    document: { createTextNode: value => new Text(value) },
    node: (tag, text, className) => { const element = new Element(className); if (text !== undefined) element.append(new Text(text)); return element; },
  });
  vm.runInContext(renderer.slice(start, end) + '\nthis.api = { sessionMaker, makerLabel, paintVendorMark, icon };', context);
  return context.api;
}

test('both catalogs name the vendor and the shell, and say when the vendor is not reported', () => {
  for (const lang of ['zh', 'en']) {
    for (const key of ['vendor.label', 'vendor.unreported']) assert.ok(messages[lang][key]?.includes('{shell}'), `${lang} ${key}`);
    assert.ok(messages[lang]['vendor.label'].includes('{vendor}'));
  }
});

test('each session gets its vendor letter, and a Codex session not yet reported keeps its shell letters', () => {
  const { sessionMaker } = page('en'), pick = record => { const m = sessionMaker(record); return [m.mark, m.vendorName, m.shellName, m.tone]; };
  assert.deepEqual(pick({ provider: 'claude', vendor: 'anthropic', shell: 'claude' }), ['A', 'Anthropic', 'Claude Code', 'anthropic']);
  assert.deepEqual(pick({ provider: 'claude' }), ['A', 'Anthropic', 'Claude Code', 'anthropic'], 'a service that does not send the vendor yet');
  assert.deepEqual(pick({ provider: 'codex', vendor: 'openai', shell: 'codex' }), ['O', 'OpenAI', 'Codex', 'openai']);
  assert.deepEqual(pick({ provider: 'codex', vendor: 'deepseek', shell: 'codex' }), ['D', 'DeepSeek', 'Codex', 'deepseek']);
  assert.deepEqual(pick({ provider: 'codex', vendor: null, shell: 'codex' }), ['Cx', '', 'Codex', 'unknown']);
  assert.deepEqual(pick({ provider: 'codex' }), ['Cx', '', 'Codex', 'unknown']);
  // Another provider table the person configured: two letters, so it never passes for one of the three.
  assert.deepEqual(pick({ provider: 'codex', vendor: 'ollama', shell: 'codex' }), ['Ol', 'ollama', 'Codex', 'other']);
  assert.deepEqual(pick({ provider: 'codex', vendor: 'toString', shell: 'codex' }), ['To', 'toString', 'Codex', 'other']);
  assert.deepEqual(pick({ provider: 'codex', vendor: 'a', shell: 'codex' }), ['A·', 'a', 'Codex', 'other'], 'a one-letter id is not taken for A');
});

test('the label says the vendor and where it runs, in both languages', () => {
  const zh = page('zh'), en = page('en');
  assert.equal(en.makerLabel({ provider: 'codex', vendor: 'deepseek' }), 'DeepSeek model · runs in Codex');
  assert.equal(en.makerLabel({ provider: 'claude' }), 'Anthropic model · runs in Claude Code');
  assert.equal(en.makerLabel({ provider: 'codex' }), 'Runs in Codex · model vendor not reported');
  assert.equal(zh.makerLabel({ provider: 'codex', vendor: 'deepseek' }), 'DeepSeek 模型 · 在 Codex 里运行');
  assert.equal(zh.makerLabel({ provider: 'codex' }), '在 Codex 里运行 · 模型厂商未报告');
});

test('a mark repainted when Codex reports the vendor keeps the row\'s state dot', () => {
  const { icon, paintVendorMark } = page('en');
  const record = { provider: 'codex', vendor: null }, mark = icon(record), dot = { nodeType: 1, className: 'state-dot' };
  mark.append(dot);
  assert.equal(mark.firstChild.nodeValue, 'Cx'); assert.match(mark.className, /vendor-unknown/);
  record.vendor = 'openai'; paintVendorMark(mark, record);
  assert.equal(mark.firstChild.nodeValue, 'O'); assert.match(mark.className, /^agent-icon vendor-mark vendor-openai$/);
  assert.equal(mark.children.length, 2); assert.equal(mark.children[1], dot);
  assert.equal(mark.dataset.vendor, 'openai');
  paintVendorMark(mark, record, '◆'); assert.equal(mark.firstChild.nodeValue, '◆', 'the butler row keeps its own mark');
  const small = icon({ provider: 'claude' }, true); assert.match(small.className, / small$/);
  paintVendorMark(small, { provider: 'claude' }); assert.match(small.className, / small$/, 'repainting keeps the small size');
});


const helperFile = path.join(__dirname, 'reading-locale.test.cjs');
const readingScope = vm.createContext({ require: createRequire(helperFile), __dirname, console });
vm.runInContext(fs.readFileSync(helperFile, 'utf8').split("test('typed own notices")[0] + '\nglobalThis.makeFixture = fixture;', readingScope);

test('in a space record only a session\'s own reply or tool row carries its mark, not NAW notices that name it', () => {
  const rows = [], f = readingScope.makeFixture(rows, true), session = f.state.sessions[0];
  Object.getPrototypeOf(f.root).prepend ??= function (child) { this.insertBefore(child, this.childNodes[0] || null); };
  Object.assign(session, { vendor: 'deepseek', shell: 'codex' });
  const start = renderer.indexOf('const VENDOR_MARKS'), end = renderer.indexOf('// Paints the mark in place');
  vm.runInContext(renderer.slice(start, end) + "\nicon = (record, small) => node('span', sessionMaker(record).mark, 'agent-icon vendor-mark' + (small ? ' small' : ''));", f.context);
  rows.push(
    { id: 'reply', role: 'assistant', sessionId: session.id, name: session.name, text: 'Done.', status: 'complete', time: 1 },
    { id: 'tool', role: 'tool', kind: 'tool', sessionId: session.id, name: session.name, text: 'ls', status: 'complete', time: 2 },
    { id: 'queue', role: 'system', kind: 'queue', sessionId: session.id, time: 3, ...locale.createNotice('notice.queue.dispatched', { text: 'Fix the header', name: session.name }) },
    { id: 'pause', role: 'system', name: '协作', sessionId: session.id, text: 'Paused before a reply', time: 4 },
    { id: 'ask', role: 'human', recipientId: session.id, name: '你 → ' + session.name, text: 'Please check.', status: 'complete', time: 5 });
  f.context.messageList(f.root, rows, true, 'room');
  const mark = id => { const entry = f.view.entries.get(id); return entry?.heading?.childNodes.find(child => /vendor-mark/.test(child.className)) || null; };
  for (const id of ['reply', 'tool']) {
    const m = mark(id); assert.ok(m, id + ' carries the mark');
    assert.equal(m.textContent, 'D'); assert.equal(m.getAttribute('role'), 'img');
    assert.equal(m.getAttribute('aria-label'), 'DeepSeek 模型 · 在 Codex 里运行');
  }
  for (const id of ['queue', 'pause', 'ask']) assert.equal(mark(id), null, id + ' is not written by the session');
});
