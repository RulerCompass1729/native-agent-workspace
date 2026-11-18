// Exercise the actual shared reader with synthetic native result shapes.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const helper = path.join(__dirname, 'reading-locale.test.cjs');
const text = fs.readFileSync(helper, 'utf8').split('\ntest(')[0];
const load = createRequire(helper), io = { ...fs, readFileSync(file, ...args) {
  return process.env.NAW_READING_SOURCE && path.resolve(file) === path.resolve(__dirname, '../renderer/reading-list.js')
    ? fs.readFileSync(process.env.NAW_READING_SOURCE, ...args) : fs.readFileSync(file, ...args);
} };
const fixture = vm.compileFunction(text + '\nreturn fixture;', ['require', '__dirname'])(name => name === 'node:fs' ? io : load(name), __dirname);
const output = Array.from({ length: 300 }, (_, i) => `elem_${i} - synthetic AX element ${i}`).join('\n');
const image = { unavailable: 'Synthetic native image placeholder' };
function draw(extra = {}, room = false) {
  const row = { id: 'native:native-A:tool:synthetic', nativeId: 'native-A', role: 'tool', kind: 'tool', title: 'mcp__synthetic__see',
    input: '{}', text: output, status: 'complete', ...extra };
  const f = fixture([row], room, {}, { readingState: async () => {} });
  f.context.performance = performance;
  f.context.attempt = action => action();
  f.row = row; f.entry = () => f.view.entries.get(row.id);
  f.redraw = () => f.context.messageList(f.root, [row], room, room ? 'room' : 'session-A');
  return f;
}
test('Bash retains its existing two-line preview and hidden-line count', () => {
  const f = draw({ title: 'Bash', toolKind: 'commandExecution', status: 'running' }), e = f.entry();
  assert.equal(Boolean(e.disclosure.open), false);
  assert.equal(e.tail.textContent, output.split('\n').slice(-2).join('\n')); assert.match(e.more.textContent, /298/);
});
for (const status of ['running', 'complete']) for (const media of ['text', 'unsupported', 'image']) {
  test(`${status} ${media} tool output uses the same compact preview and retains full text`, () => {
    const f = draw({ status, ...(media === 'unsupported' ? { incomplete: true } : media === 'image' ? { images: [image] } : {}) });
    const e = f.entry(); assert.ok(e.disclosure, 'tool text has a disclosure even with media');
    assert.equal(Boolean(e.disclosure.open), false, 'incomplete media must not force long logs open');
    assert.equal(e.body.textContent, output);
    assert.equal(e.tail.textContent, output.split('\n').slice(status === 'running' ? -2 : 0, status === 'running' ? undefined : 2).join('\n'));
    assert.match(e.more.textContent, /298/); assert.equal(e.more.hidden, false);
    if (media === 'image') { const host = e.item.childNodes.find(n => n.className === 'message-images'); assert.ok(host); assert.equal(e.disclosure.contains(host), false); }
  });
}
test('late media preserves body identity, text selection and explicit fold across redraw and completion', () => {
  const f = draw({ status: 'running' }), e = f.entry(), body = e.body, disclosure = e.disclosure;
  f.context.window.getSelection().isCollapsed = false;
  Object.assign(f.context.window.getSelection(), { anchorNode: body, focusNode: body });
  f.view.folds[f.row.id] = true; f.row.images = [image]; f.redraw();
  assert.equal(e.disclosure, disclosure); assert.equal(e.body, body); assert.equal(disclosure.open, true);
  f.view.folds[f.row.id] = false; f.row.status = 'complete'; f.redraw();
  assert.equal(disclosure.open, false); assert.equal(e.body, body); assert.equal(e.body.textContent, output);
  assert.equal(f.context.window.getSelection().anchorNode, body);
});
test('more opens the entire payload; subsequent updates respect the manual choice', () => {
  const f = draw({ incomplete: true }), e = f.entry();
  assert.equal(Boolean(e.disclosure.open), false); e.more.onclick();
  assert.equal(e.disclosure.open, true); assert.equal(e.body.textContent, output);
  f.row.text += '\nFINAL_SYNTHETIC_LINE'; f.redraw();
  assert.equal(e.disclosure.open, true); assert.ok(e.body.textContent.endsWith('FINAL_SYNTHETIC_LINE'));
  assert.equal(f.view.folds[f.row.id], true);
});
test('shared mirrors use the same fold, while assistant/user image messages stay outside tool disclosures', () => {
  const f = draw({ images: [image] }, true); assert.ok(f.entry().disclosure); assert.equal(Boolean(f.entry().disclosure.open), false);
  for (const role of ['assistant', 'user']) { const f = draw({ role, kind: role === 'user' ? 'input' : 'response', images: [image] }); assert.equal(f.entry().disclosure, undefined); }
});
test('Codex MCP multi-content normalizes into this same shared reader', () => {
  const { toolContent } = require('../codex-tool-content.cjs');
  const data = toolContent({ type: 'mcpToolCall', server: 'synthetic', tool: 'see', arguments: {}, result: { content: [
    { type: 'text', text: output }, { type: 'image', data: 'SYNTHETIC_MEDIA' }, { type: 'text', text: 'FINAL_BLOCK' },
  ] } });
  assert.equal(data.text, output + '\n\nFINAL_BLOCK'); assert.equal(data.incomplete, true);
  const f = draw({ ...data, toolKind: 'mcpToolCall' }); assert.equal(Boolean(f.entry().disclosure.open), false);
  assert.equal(f.entry().body.textContent, data.text);
});
