const test = require('node:test'), assert = require('node:assert/strict');
const { windowPlacement } = require('../window-placement.cjs');
const primary = { x: 0, y: 30, width: 1440, height: 850 };
const left = { x: -1280, y: 0, width: 1280, height: 900 };
const screen = (areas = [primary], nearest = primary) => ({
  getAllDisplays: () => areas.map(workArea => ({ workArea })),
  getDisplayMatching: () => ({ workArea: nearest }),
});
test('accessible and intentional partly offscreen placements remain exact', () => {
  for (const bounds of [
    { x: 30, y: 50, width: 1100, height: 700 },
    { x: -600, y: 40, width: 1000, height: 800 },
    { x: -1200, y: 10, width: 1000, height: 800 },
  ]) assert.deepEqual(windowPlacement(bounds, screen([primary, left])), bounds);
});
test('a lost display is recovered into the current work area with reachable title and complete window', () => {
  const result = windowPlacement({ x: 12000, y: 12000, width: 4000, height: 2000 }, screen());
  assert.deepEqual(result, primary);
  const normal = windowPlacement({ x: -12000, y: 100, width: 1100, height: 700 }, screen());
  assert.deepEqual(normal, { x: 170, y: 105, width: 1100, height: 700 });
});
test('a hidden title bar or tiny visible sliver is recovered even when the body overlaps', () => {
  for (const bounds of [
    { x: 40, y: -600, width: 1100, height: 800 },
    { x: 1430, y: 40, width: 1100, height: 800 },
    { x: 30, y: 875, width: 1100, height: 800 },
  ]) {
    const result = windowPlacement(bounds, screen());
    assert.ok(result.x >= primary.x && result.y >= primary.y);
    assert.ok(result.x + result.width <= primary.x + primary.width);
    assert.ok(result.y + result.height <= primary.y + primary.height);
  }
});
test('recovery uses the chosen current display, including its negative coordinates and small work area', () => {
  assert.deepEqual(windowPlacement({ x: -12000, y: 2000, width: 1100, height: 700 }, screen([primary, left], left)),
    { x: -1190, y: 100, width: 1100, height: 700 });
  const small = { x: 0, y: 30, width: 800, height: 500 };
  assert.deepEqual(windowPlacement({ x: 9999, y: 9999, width: 100, height: 100 }, screen([small], small)), small);
});
test('reachable undersized records cannot lower the usable minimum on a normal display', () => {
  assert.deepEqual(windowPlacement({ x: 40, y: 50, width: 100, height: 100 }, screen()),
    { x: 40, y: 50, width: 850, height: 600 });
  const small = { x: 0, y: 30, width: 800, height: 500 };
  assert.deepEqual(windowPlacement({ x: 0, y: 30, width: 800, height: 500 }, screen([small], small)), small);
  assert.deepEqual(windowPlacement(small, screen()),
    { x: 0, y: 30, width: 850, height: 600 });
});
test('invalid geometry cannot reach native coordinate conversion; only bounds are restored', () => {
  for (const bounds of [null, {}, { x: Infinity, y: 0, width: 1000, height: 700 }, { x: 1e20, y: 0, width: 1000, height: 700 }, { x: 0.5, y: 0, width: 1000, height: 700 }, { x: 0, y: 0, width: -1, height: 700 }])
    assert.equal(windowPlacement(bounds, { getAllDisplays() { throw Error('Must not call native screen'); } }), undefined);
  assert.deepEqual(windowPlacement({ x: 40, y: 50, width: 1000, height: 700, show: true, alwaysOnTop: true }, screen()),
    { x: 40, y: 50, width: 1000, height: 700 });
});
