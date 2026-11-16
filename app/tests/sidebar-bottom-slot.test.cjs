// An expanded bottom-slot panel must not shrink NAW's sidebar: the sidebar column
// spans both DSH frame rows and the bottom slot starts at the next column.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const builder = fs.readFileSync(path.join(root, 'scripts/build-ui.cjs'), 'utf8');
const framePath = path.join(root, 'node_modules/@deepseek-ai/dsh-client-ui-layout/lib/client.js');
const rules = ':root [data-naw-shell-frame] > [data-naw-shell-sidebar]{grid-row:1/-1}' +
  ':root [data-naw-shell-frame] > [data-shell-bottom]{grid-column:2/-1}';
function build(transform = text => text) {
  let output;
  const files = Object.create(fs);
  files.readFileSync = (file, ...args) => {
    const value = fs.readFileSync(file, ...args);
    return file === framePath ? transform(value) : value;
  };
  files.writeFileSync = (file, value) => { assert.equal(file, path.join(root, 'app/dsh/client.js')); output = value; };
  vm.runInNewContext(builder, { __dirname: path.join(root, 'scripts'), console: { log() {} },
    require(name) { return name === 'node:fs' ? files : require(name); } });
  assert.equal(typeof output, 'string');
  return output;
}
test('the built styles keep the sidebar full height beside the bottom slot', () => {
  const output = build();
  // LOCAL_STYLES is embedded as a JSON string.
  assert.equal(output.split(JSON.stringify(rules).slice(1, -1)).length, 2);
  assert.ok(!output.includes(JSON.stringify(':has(.naw[data-native-surface="sidebar"])').slice(1, -1)));
  // The registered sidebar marks its fixed shell ancestors once.
  assert.match(output, /'data-native-surface': kind/);
  assert.match(output, /Surface, \{ kind: 'sidebar'/);
});
test('the pinned DSH frame still has the two rows and the full-width bottom slot the rules assume', () => {
  const frame = fs.readFileSync(framePath, 'utf8');
  assert.equal(frame.split('grid-template-rows:minmax(0,1fr) auto;').length, 2);
  assert.match(frame, /_bottomRow\{[^}]*grid-column:1\/-1;/);
  assert.equal(frame.split('"data-shell-bottom": true').length, 2);
});
for (const [name, transform] of [
  ['a bottom slot no longer spanning every column', text => text.replace(/(_bottomRow\{[^}]*)grid-column:1\/-1;/, '$1grid-column:2/-1;')],
  ['a different row template', text => text.replace('grid-template-rows:minmax(0,1fr) auto;', 'grid-template-rows:auto minmax(0,1fr) auto;')],
  ['a renamed bottom slot marker', text => text.replace('"data-shell-bottom": true', '"data-shell-panel": true')],
  ['a second bottom slot marker', text => text + '\n/* "data-shell-bottom": true */'],
]) {
  test(`${name} fails the build until the sidebar layout is requalified`, () => {
    assert.throws(() => build(transform), /requalify the full-height sidebar beside the bottom slot/);
  });
}

function shellBinder() {
  const source = fs.readFileSync(path.join(root, 'app/dsh/bootstrap.js'), 'utf8');
  const start = source.indexOf('function bindShellFrame('), end = source.indexOf('function createDisplayBindings(', start);
  assert.ok(start >= 0 && end > start, 'Shell binding is a separately testable mount operation');
  return vm.runInNewContext(source.slice(start, end) + ';bindShellFrame');
}
function element(...children) {
  const node = { children, parentElement: null, attributes: new Map(), writes: 0,
    hasAttribute(name) { return this.attributes.has(name); },
    setAttribute(name, value) { this.attributes.set(name, value); this.writes++; },
    removeAttribute(name) { this.attributes.delete(name); } };
  for (const child of children) child.parentElement = node;
  return node;
}
test('a sidebar mount marks only the direct shell column and frame, even with extra wrappers', () => {
  const bind = shellBinder(), surface = element(), column = element(element(element(surface))), bottom = element();
  bottom.setAttribute('data-shell-bottom', ''); const frame = element(column, element(), bottom);
  const release = bind(surface);
  assert.ok(frame.hasAttribute('data-naw-shell-frame')); assert.ok(column.hasAttribute('data-naw-shell-sidebar'));
  assert.ok(!surface.hasAttribute('data-naw-shell-sidebar'));
  assert.equal(frame.writes + column.writes, 2, 'There is no ongoing per-output marker work');
  surface.children.push(element()); assert.equal(frame.writes + column.writes, 2);
  release(); assert.ok(!frame.hasAttribute('data-naw-shell-frame')); assert.ok(!column.hasAttribute('data-naw-shell-sidebar'));
});
test('without a direct shell bottom sibling, no ancestor gets a layout marker', () => {
  const surface = element(), column = element(surface), frame = element(column, element());
  const release = shellBinder()(surface); release();
  assert.equal(frame.writes + column.writes + surface.writes, 0);
});
test('unmount and remount cleanly transfer the markers to the new frame', () => {
  const bind = shellBinder(), surface = element(), firstColumn = element(surface), firstBottom = element();
  firstBottom.setAttribute('data-shell-bottom', ''); const firstFrame = element(firstColumn, firstBottom);
  const release = bind(surface); release();
  const secondColumn = element(element(surface)), secondBottom = element(); secondBottom.setAttribute('data-shell-bottom', '');
  const secondFrame = element(secondColumn, secondBottom), releaseSecond = bind(surface);
  assert.ok(!firstFrame.hasAttribute('data-naw-shell-frame')); assert.ok(!firstColumn.hasAttribute('data-naw-shell-sidebar'));
  assert.ok(secondFrame.hasAttribute('data-naw-shell-frame')); assert.ok(secondColumn.hasAttribute('data-naw-shell-sidebar'));
  releaseSecond();
});
