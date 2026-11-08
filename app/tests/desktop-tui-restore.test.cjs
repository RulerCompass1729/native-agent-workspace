const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../..');
const otherRoom = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const main = fs.readFileSync(path.join(root, 'app/main.cjs'), 'utf8');
const start = main.indexOf("  register('viewState', (c, next) => {");
const end = main.indexOf("  register('openLocalFile',", start);
assert.ok(start >= 0 && end > start, 'Locate the actual IPC handler');

for (const format of ['per-space', 'legacy', 'migrated']) for (const before of ['', 'Original unsent shared draft']) {
  test(`desktop TUI cleanup restores ${before ? 'nonempty' : 'empty'} draft (${format})`, async () => {
    const modern = format !== 'legacy';
    const original = { selected: 'session-a', mode: 'chat', preference: 'chat', sharedDraft: before, roomSession: 'session-a', terminalDisplay: { fontSize: 13, palette: 'dark' } };
    const view = { owner: 'owner-a', ...structuredClone(original), mode: 'terminal', sharedDraft: 'Synthetic check draft', roomSession: 'session-b', terminalDisplay: { fontSize: 17, palette: 'green' } };
    if (modern) {
      if (format === 'per-space') original.roomViews = { shared: { sharedDraft: before, roomSession: 'session-a' } };
      view.roomViews = { shared: { sharedDraft: 'Synthetic check draft', roomSession: 'session-b', roomSearch: 'Keep current search' }, [otherRoom]: { sharedDraft: 'Other space newer draft' } };
    }
    const untouched = modern && structuredClone(view.roomViews[otherRoom]);
    let handler, saved = 0;
    vm.runInNewContext(main.slice(start, end), {
      register(name, fn) { assert.equal(name, 'viewState'); handler = fn; },
      require: createRequire(path.join(root, 'app/main.cjs')),
      validViews: require('../view-store.cjs').validViews,
      structuredClone, uiError: key => Error(key), saveViews() { saved++; },
    });
    const module = { exports: {} }, claims = [];
    vm.runInNewContext(fs.readFileSync(path.join(root, 'scripts/check-tui.cjs'), 'utf8'), {
      // Resolve check-tui's own relative requires (fixtures/wait-state.cjs) from scripts/, as when it runs for real.
      module, require: createRequire(path.join(root, 'scripts/check-tui.cjs')), workspace: {
        async initial() { return { viewState: structuredClone(view), owner: 'owner-a', sessions: [{ id: 'session-a', owner: 'owner-a' }] }; },
        async claim(...args) { claims.push(args); },
        async viewState(next) { handler({ view }, next); },
      },
    });
    await module.exports.restoreTui({ evaluate: (fn, arg) => fn(arg) }, { original });
    assert.equal(saved, 1); assert.deepEqual(claims, [['session-a', 'chat']]);
    assert.equal(view.sharedDraft, before); assert.equal(view.roomSession, 'session-a');
    assert.equal(view.selected, 'session-a'); assert.equal(view.mode, 'chat');
    assert.equal(view.terminalDisplay.fontSize, original.terminalDisplay.fontSize);
    assert.equal(view.terminalDisplay.palette, original.terminalDisplay.palette);
    if (modern) {
      assert.equal(view.roomViews.shared.sharedDraft, before);
      assert.equal(view.roomViews.shared.roomSession, 'session-a');
      assert.equal(view.roomViews.shared.roomSearch, 'Keep current search');
      assert.deepEqual(view.roomViews[otherRoom], untouched);
    } else assert.equal(view.roomViews, undefined);
  });
}
