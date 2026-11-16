const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const card = require('../renderer/sidebar-hover-card.js');
const messages = require('../ui-messages.js');
const root = path.resolve(__dirname, '..', '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

test('the card sits beside the item past the sidebar edge, top-aligned, inside the window', () => {
  const view = { width: 1240, height: 820 }, sidebar = rect(0, 0, 300, 820), anchor = rect(8, 200, 284, 52), size = rect(0, 0, 288, 180);
  const at = card.place(anchor, sidebar, size, view);
  assert.deepEqual(at, { left: 308, top: 200 });
  // Low in the window it moves up, still beside the item.
  const low = card.place(rect(8, 760, 284, 52), sidebar, size, view);
  assert.equal(low.left, 308); assert.equal(low.top, 820 - 180 - 8);
  // The rail: beside the narrow column.
  assert.deepEqual(card.place(rect(6, 120, 44, 44), rect(0, 0, 56, 600), size, { width: 850, height: 600 }), { left: 64, top: 120 });
});

test('with no room to the right the card goes below the item, or above it, and never covers it', () => {
  const view = { width: 560, height: 600 }, sidebar = rect(0, 0, 300, 600), size = rect(0, 0, 288, 180);
  for (const anchor of [rect(8, 60, 284, 52), rect(8, 470, 284, 52), rect(8, 260, 284, 52)]) {
    const at = card.place(anchor, sidebar, size, view), box = rect(at.left, at.top, size.width, size.height);
    assert.ok(!overlaps(box, anchor), JSON.stringify({ anchor, at }));
    assert.ok(box.left >= 8 && box.top >= 8 && box.right <= view.width - 8 && box.bottom <= view.height - 8, JSON.stringify(at));
  }
  assert.equal(card.place(rect(8, 60, 284, 52), sidebar, size, view).top, 120, 'below');
  assert.equal(card.place(rect(8, 470, 284, 52), sidebar, size, view).top, 470 - 8 - 180, 'above');
});

function clock() {
  let now = 0, id = 0; const timers = new Map();
  return {
    schedule: (fn, ms) => { timers.set(++id, { at: now + ms, fn }); return id; },
    cancel: timer => { timers.delete(timer); },
    tick(ms) { now += ms; for (const [timer, entry] of [...timers].sort((a, b) => a[1].at - b[1].at)) if (entry.at <= now && timers.has(timer)) { timers.delete(timer); entry.fn(); } },
  };
}
function harness() {
  const time = clock(), shown = [], hidden = [];
  const control = card.controller({ ...time, show: key => shown.push(key), hide: () => hidden.push(true) });
  return { time, shown, hidden, control };
}

test('the first card waits about 600 ms; leaving earlier shows nothing', () => {
  const h = harness();
  h.control.enter('row:a', 'pointer'); h.time.tick(599); assert.deepEqual(h.shown, []);
  h.time.tick(1); assert.deepEqual(h.shown, ['row:a']);
  const g = harness();
  g.control.enter('row:a', 'pointer'); g.time.tick(300); g.control.leave('row:a', 'pointer'); g.time.tick(1000);
  assert.deepEqual(g.shown, []); assert.deepEqual(g.hidden, []);
});

test('while a card is open, the next item switches at once; leaving closes after a short grace', () => {
  const h = harness();
  h.control.enter('row:a', 'pointer'); h.time.tick(600);
  h.control.leave('row:a', 'pointer'); h.control.enter('space:s', 'pointer');
  assert.deepEqual(h.shown, ['row:a', 'space:s']); assert.deepEqual(h.hidden, []);
  h.control.leave('space:s', 'pointer'); h.time.tick(card.GRACE - 1); assert.equal(h.hidden.length, 0);
  // Back within the grace: the same card stays.
  h.control.enter('space:s', 'pointer'); h.time.tick(1000); assert.equal(h.hidden.length, 0); assert.deepEqual(h.shown, ['row:a', 'space:s']);
  h.control.leave('space:s', 'pointer'); h.time.tick(card.GRACE); assert.equal(h.hidden.length, 1); assert.equal(h.control.open, null);
  // Closed: the next item waits the full delay again.
  h.control.enter('row:b', 'pointer'); h.time.tick(599); assert.equal(h.shown.length, 2); h.time.tick(1); assert.deepEqual(h.shown.at(-1), 'row:b');
});

test('a dismissed item stays quiet until it is left; keyboard focus and pointer are tracked apart', () => {
  const h = harness();
  h.control.enter('row:a', 'pointer'); h.time.tick(600); h.control.dismiss();
  assert.equal(h.hidden.length, 1); h.time.tick(5000); assert.deepEqual(h.shown, ['row:a']);
  h.control.enter('row:a', 'pointer'); h.time.tick(5000); assert.deepEqual(h.shown, ['row:a'], 'moving inside the item does not bring it back');
  h.control.leave('row:a', 'pointer'); h.control.enter('row:a', 'pointer'); h.time.tick(600); assert.deepEqual(h.shown, ['row:a', 'row:a']);
  // A dismissal before the delay also cancels it.
  const p = harness(); p.control.enter('row:a', 'pointer'); p.time.tick(300); p.control.dismiss(); p.time.tick(5000); assert.deepEqual(p.shown, []);
  // Focus keeps the card while the pointer leaves; it closes when focus leaves too.
  const f = harness();
  f.control.enter('row:a', 'focus'); f.time.tick(600); f.control.enter('row:a', 'pointer'); f.control.leave('row:a', 'pointer'); f.time.tick(1000);
  assert.equal(f.hidden.length, 0); f.control.leave('row:a', 'focus'); f.time.tick(card.GRACE); assert.equal(f.hidden.length, 1);
  // An item that disappeared closes without staying quiet.
  const d = harness(); d.control.enter('row:a', 'pointer'); d.time.tick(600); d.control.drop(); assert.equal(d.hidden.length, 1);
  d.control.enter('row:a', 'pointer'); d.time.tick(600); assert.deepEqual(d.shown, ['row:a', 'row:a']);
});

test('the card ships in both builds, stays out of the mouse and accessibility tree, and is translucent at the chosen level', () => {
  const build = read('scripts/build-ui.cjs'), html = read('app/renderer/index.html'), css = read('app/renderer/sidebar-hover-card.css'), js = read('app/renderer/sidebar-hover-card.js');
  assert.match(build, /read\('app\/renderer\/activity-stream\.css'\) \+ '\\n' \+ read\('app\/renderer\/sidebar-hover-card\.css'\)/);
  assert.match(build, /'activity-stream\.js', 'sidebar-hover-card\.js', 'renderer\.js'/);
  assert.ok(html.indexOf('href="sidebar-hover-card.css"') > html.indexOf('href="activity-stream.css"'));
  assert.ok(html.indexOf('src="sidebar-hover-card.js"') > 0 && html.indexOf('src="sidebar-hover-card.js"') < html.indexOf('src="renderer.js"'));
  assert.match(css, /--naw-hover-card-opacity:80%/);
  assert.match(css, /background:color-mix\(in srgb,var\(--raised\) var\(--naw-hover-card-opacity\),transparent\)/);
  assert.match(css, /pointer-events:none/);
  assert.match(js, /setAttribute\('aria-hidden', 'true'\)/);
  assert.doesNotMatch(js, /\bapi\.|fetch\(|setInterval\(/, 'Display only: no product API, network or polling');
});

test('hover card texts exist in Chinese and English with the same placeholders', () => {
  const zh = messages.zh || messages.messages?.zh, en = messages.en || messages.messages?.en;
  assert.ok(zh && en, 'message tables');
  const keys = ['backend', 'spaces', 'doing', 'folder', 'branch', 'time', 'unrecorded', 'waiting', 'members', 'more', 'queue', 'queueEmpty', 'queueCounts', 'separator'].map(key => 'hover.' + key);
  const holes = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
  for (const key of keys) {
    assert.equal(typeof zh[key], 'string', key); assert.equal(typeof en[key], 'string', key);
    assert.deepEqual(holes(zh[key]), holes(en[key]), key);
  }
});
