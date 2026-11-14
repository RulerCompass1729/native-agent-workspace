// An expanded bottom-slot panel must not shrink NAW's sidebar: the sidebar column
// spans both DSH frame rows and the bottom slot starts at the next column.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const builder = fs.readFileSync(path.join(root, 'scripts/build-ui.cjs'), 'utf8');
const framePath = path.join(root, 'node_modules/@deepseek-ai/dsh-client-ui-layout/lib/client.js');
const rules = ':has(> [data-shell-bottom]) > :has(.naw[data-native-surface="sidebar"]){grid-row:1/-1}' +
  ':has(> * .naw[data-native-surface="sidebar"]) > [data-shell-bottom]{grid-column:2/-1}';
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
  // The rules find the sidebar by the surface NAW registers in DSH's sidebar slot.
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
