const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../../scripts/test-background-control.cjs'), 'utf8');
const start = source.indexOf('async function checkDesktopState('), end = source.indexOf('const wait =', start);
assert.ok(start >= 0 && end > start);

function fixture(windows, current) {
  const saved = [], context = vm.createContext({ assert,
    app: { evaluate: callback => callback({ BrowserWindow: { getAllWindows: () => windows.map(w => ({ isVisible: () => w.visible, isFocused: () => w.focused })) } }) },
    desktop: () => current, save: (stage, value) => saved.push({ stage, value }),
  });
  vm.runInContext(source.slice(start, end), context);
  return { saved, check: context.checkDesktopState };
}
const hidden = { visible: false, focused: false };
for (const [name, desktop] of [
  ['unchanged', { frontmostPid: 100, x: 10, y: 20 }],
  ['pointer moved', { frontmostPid: 100, x: 14, y: 20 }],
  ['foreground changed', { frontmostPid: 200, x: 10, y: 20 }],
  ['both changed', { frontmostPid: 200, x: 500, y: 800 }],
]) test(`desktop activity is an unattributed observation: ${name}`, async () => {
  const f = fixture([hidden, hidden], desktop);
  await f.check('owned-stage', 2);
  assert.equal(f.saved.length, 1); assert.equal(f.saved[0].stage, 'owned-stage');
  for (const key of ['frontmostPid', 'x', 'y']) assert.equal(f.saved[0].value[key], desktop[key]);
  assert.equal(f.saved[0].value.attribution, 'unattributed');
  assert.equal(f.saved[0].value.physicalPointerIsolation, 'unverified');
});
for (const [name, window] of [
  ['visible', { visible: true, focused: false }],
  ['focused', { visible: false, focused: true }],
]) test(`an owned ${name} window still fails the isolation check`, async () => {
  const f = fixture([hidden, window], { frontmostPid: 100, x: 10, y: 20 });
  await assert.rejects(f.check('owned-stage'), /stay hidden and unfocused/);
  assert.equal(f.saved.length, 0);
});
for (const [name, windows, minimum] of [
  ['missing application windows', [], 1],
  ['missing independent control window', [hidden], 2],
]) test(`${name} cannot pass by an empty observation`, async () => {
  const f = fixture(windows, { frontmostPid: 100, x: 10, y: 20 });
  await assert.rejects(f.check('owned-stage', minimum), /remain observable/);
  assert.equal(f.saved.length, 0);
});
