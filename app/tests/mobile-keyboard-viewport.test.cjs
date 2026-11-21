const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../mobile-web/workspace.js'), 'utf8');
function scene() {
  const classes = new Set(), properties = new Map(), listeners = [];
  const field = {}, box = { hidden: false, getBoundingClientRect: () => ({ top: 20, height: 51 }) };
  const nav = { getBoundingClientRect: () => ({ height: 75 }) }, header = { getBoundingClientRect: () => ({ height: 64 }) };
  const d = { activeElement: field, body: { classList: { contains: k => classes.has(k), toggle(k, yes) { if (yes) classes.add(k); else classes.delete(k); } } }, documentElement: { style: { setProperty: (k, v) => properties.set(k, v) } }, addEventListener: (k, fn) => listeners.push(['document', k, fn]) };
  const viewport = { height: 66, offsetTop: 24, scale: 1, addEventListener: (k, fn) => listeners.push(['viewport', k, fn]) };
  let positions = 0;
  const context = { d, el: id => ({ compose: box, navigation: nav, top: header })[id] || field, readingPosition: () => { positions++; }, global: { innerHeight: 390, visualViewport: viewport, addEventListener: (k, fn) => listeners.push(['window', k, fn]) } };
  const start = source.indexOf('    function composeSpace() {'), end = source.indexOf('    function updateCompose()', start);
  assert.ok(start >= 0 && end > start);
  vm.runInNewContext(source.slice(start, end) + '\nthis.layout = composeSpace;', context);
  return { ...context, viewport, classes, properties, listeners, box, field, positions: () => positions };
}
test('visual-only keyboard shrink anchors the composer and uses the compact layout', () => {
  const s = scene(); s.layout();
  assert.equal(s.properties.get('--keyboard-inset'), '300px');
  assert.equal(s.properties.get('--compose-space'), '370px');
  assert.ok(s.classes.has('keyboard-compose') && s.classes.has('compact-compose'));
  assert.equal(s.properties.get('--mobile-bottom'), '90px');
  assert.equal(s.properties.get('--nav-height'), '75px');
  assert.equal(s.properties.get('--compose-height'), '51px');
  assert.equal(s.properties.get('--mobile-header-height'), '64px');
  assert.equal(s.positions(), 1);
  for (const event of ['resize', 'scroll']) assert.ok(s.listeners.some(([target, k, fn]) => target === 'viewport' && k === event && fn === s.layout));
});
test('moving focus to Send cannot move the form before the keyboard closes', () => {
  const s = scene(); s.layout(); s.d.activeElement = {}; s.layout();
  assert.ok(s.classes.has('keyboard-compose'));
  s.viewport.height = 390; s.layout();
  assert.equal(s.properties.get('--keyboard-inset'), '0px'); assert.equal(s.classes.size, 0);
});
test('zoom, unrelated focus and a hidden compose box never activate keyboard layout', () => {
  for (const variant of ['zoom', 'focus', 'hidden']) {
    const s = scene();
    if (variant === 'zoom') s.viewport.scale = 2;
    if (variant === 'focus') s.d.activeElement = {};
    if (variant === 'hidden') s.box.hidden = true;
    s.layout(); assert.equal(s.classes.size, 0, variant);
    assert.equal(s.properties.get('--keyboard-inset'), '0px');
  }
});
test('portrait keyboard keeps the full composer; missing visualViewport remains supported', () => {
  const s = scene(); s.global.innerHeight = 844; s.viewport.height = 360; s.layout();
  assert.ok(s.classes.has('keyboard-compose')); assert.ok(!s.classes.has('compact-compose'));
  s.global.visualViewport = undefined; s.layout(); assert.equal(s.classes.size, 0);
});

test('short landscape without a keyboard frees reading space and restores portrait layout', () => {
  const s = scene();
  s.global.innerWidth = 667; s.global.innerHeight = 375;
  s.viewport.height = 375; s.viewport.offsetTop = 0;
  s.d.activeElement = {};
  s.layout();
  assert.ok(s.classes.has('compact-compose'));
  assert.ok(!s.classes.has('keyboard-compose'));
  assert.equal(s.properties.get('--keyboard-inset'), '0px');
  assert.equal(s.properties.get('--mobile-bottom'), '375px');
  s.global.innerWidth = 375; s.global.innerHeight = 667; s.viewport.height = 667;
  s.layout(); assert.equal(s.classes.size, 0);
  s.global.innerWidth = 844; s.global.innerHeight = 390; s.viewport.height = 390;
  s.box.hidden = true; s.layout(); assert.equal(s.classes.size, 0);
});
