const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const builder = fs.readFileSync(path.join(root, 'scripts/build-ui.cjs'), 'utf8');
const before = 'this._scrollableElement.getDomNode().style.backgroundColor=n.colors.background.css';
function build(transform = text => text) {
  let output;
  const files = Object.create(fs);
  files.readFileSync = (file, ...args) => {
    const value = fs.readFileSync(file, ...args);
    return file === path.join(root, 'node_modules/@xterm/xterm/lib/xterm.js') ? transform(value) : value;
  };
  files.writeFileSync = (file, value) => { assert.equal(file, path.join(root, 'app/dsh/client.js')); output = value; };
  vm.runInNewContext(builder, { __dirname: path.join(root, 'scripts'), console: { log() {} },
    require(name) { return name === 'node:fs' ? files : require(name); } });
  assert.equal(typeof output, 'string');
  return output;
}
test('the built terminal reuses its theme callback for the full legacy viewport', () => {
  const output = build();
  const start = output.indexOf(before);
  assert.notEqual(start, -1);
  const body = output.slice(start, output.indexOf('})))', start));
  const viewport = { style: {} }, scrollable = { style: {} };
  const context = vm.createContext({ n: { colors: { background: { css: '#15191f' } } },
    e: { querySelector(selector) { assert.equal(selector, '.xterm-viewport'); return viewport; } },
    target: { _scrollableElement: { getDomNode() { return scrollable; } } } });
  for (const color of ['#15191f', '#20261f', 'rgb(10, 60, 90)', '#15191f']) {
    context.n.colors.background.css = color;
    vm.runInContext(`(function(){${body}}).call(target)`, context);
    assert.equal(scrollable.style.backgroundColor, color);
    assert.equal(viewport.style.backgroundColor, color);
  }
  assert.deepEqual(Object.keys(viewport.style), ['backgroundColor']);
});
test('a changed pinned viewport callback fails the actual build instead of skipping the repair', () => {
  assert.throws(() => build(text => text.replace(before, before.replace('backgroundColor', 'color'))), /requalify.*background/i);
});
test('an ambiguous pinned viewport callback fails instead of patching only one occurrence', () => {
  assert.throws(() => build(text => text + `\n/* ${before} */`), /requalify.*background/i);
});
