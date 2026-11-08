const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
// T-170: since 3751738 the default space (共同工作) stays hidden until something uses it. A GUI script that opens it
// (#room-nav) or moves a session into it from the session menu (移到「共同工作」, or 移到「${…}」 with a variable
// name) on a fresh profile must first make it shown with scripts/fixtures/default-space.cjs revealDefaultSpace; eleven
// scripts stalled on this in the 2026-11-08 census. The source cannot show whether the space is already in use at that
// moment, so this is a ratchet: the scripts that opened it before the helper existed are listed by name (generated
// mechanically on main 5ee81fc, not each checked to need nothing), and any other script that opens it must call the
// helper. The list may only shrink.
// Not caught: a click through a held locator, .first(), dblclick, a keypress or a drag onto the space; the English
// menu text; a script that only asserts the space is visible (test-navigation) or opens it through a shared check module
// (check-tui, check-room). The check looks for the helper anywhere in the file, not for its order, and also matches
// these patterns inside comments.
const opens = /locator\(\s*['"`]#room-nav['"`]\s*\)\s*\.click\(|\.click\(\s*['"`]#room-nav['"`]|移到「(?:共同工作|\$\{)/;
const usesHelper = source => /\brevealDefaultSpace\(/.test(source);
// Remove a name when its script adopts the helper or stops opening the space, and lower the cap with it. Never add one.
const legacyCap = 67;
const legacy = new Set([
  'check-room.cjs', 'check-tui.cjs', 'test-active-process-fold.cjs', 'test-bounded-away.cjs',
  'test-capacity-room.cjs', 'test-check-room.cjs', 'test-claude-image-reading.cjs', 'test-codex-usability.cjs',
  'test-collaboration-list-name.cjs', 'test-collaboration-list.cjs', 'test-collaboration-notices.cjs',
  'test-collaboration-overview.cjs', 'test-column-input.cjs', 'test-column-terminal-align.cjs',
  'test-column-terminal-latest.cjs', 'test-column-terminal-visibility.cjs', 'test-column-terminal.cjs',
  'test-command-actions.cjs', 'test-compact-header.cjs', 'test-compact-room.cjs', 'test-context-menu.cjs',
  'test-control-focus.cjs', 'test-desktop-workflow.cjs',
  'test-english-walkthrough.cjs', 'test-failed-tool-reading.cjs', 'test-five-member-columns.cjs',
  'test-forget-images.cjs', 'test-grid-follow.cjs', 'test-grouped-space-rename.cjs', 'test-inline-input-reading.cjs',
  'test-inline-rename.cjs', 'test-installed-workspace.cjs', 'test-markdown-copy.cjs', 'test-member-actions.cjs',
  'test-member-header-menu.cjs', 'test-member-order.cjs', 'test-membership-navigation.cjs',
  'test-message-file-links.cjs', 'test-native-addressed.cjs', 'test-native-blocks.cjs', 'test-native-concurrent.cjs',
  'test-native-context.cjs', 'test-native-cut.cjs', 'test-native-image-reading.cjs', 'test-native-plans.cjs',
  'test-native-queue.cjs', 'test-native-retained-claude.cjs', 'test-native-retained-codex.cjs',
  'test-native-steer.cjs', 'test-native-summaries.cjs', 'test-native-tools.cjs', 'test-native-version.cjs',
  'test-operator-control.cjs', 'test-peer-workflow.cjs', 'test-pending-actions.cjs',
  'test-process-group-reading.cjs', 'test-reading-pages.cjs', 'test-reading-turns.cjs', 'test-room-member-route.cjs',
  'test-room-send.cjs', 'test-room-waiting.cjs', 'test-search.cjs', 'test-session-menu.cjs',
  'test-six-session-workflow.cjs', 'test-solo-use.cjs', 'test-terminal-focus.cjs', 'test-terminal-ready.cjs'
]);
const dir = path.join(__dirname, '../../scripts');
const files = () => [...fs.readdirSync(dir).filter(n => n.endsWith('.cjs')), ...fs.readdirSync(path.join(dir, 'fixtures')).filter(n => n.endsWith('.cjs')).map(n => 'fixtures/' + n)];
const read = name => fs.readFileSync(path.join(dir, name), 'utf8');

test('the default-space rule matches the ways of opening it and accepts the helper', () => {
  for (const source of ["await page.locator('#room-nav').click();", 'await page.click("#room-nav");',
    "await page.getByRole('menuitem', { name: `移到「${room.name}」`, exact: true }).click();",
    "await page.getByRole('menuitem', { name: '移到「共同工作」', exact: true }).click();"]) {
    assert.equal(opens.test(source), true, source);
    assert.equal(usesHelper(source), false, source);
  }
  assert.equal(usesHelper("await revealDefaultSpace(page); await page.locator('#room-nav').click();"), true);
  for (const source of ["await page.locator('#room-nav').waitFor();", "assert.equal(await inView('#room-nav'), true);",
    "await page.getByRole('menuitem', { name: '移到「Space A」', exact: true }).click();"]) assert.equal(opens.test(source), false, source);
});

test('a GUI script that opens the default space makes it shown first, unless it is listed as existing', () => {
  const offenders = files().filter(n => !legacy.has(n) && opens.test(read(n)) && !usesHelper(read(n)));
  assert.deepEqual(offenders, []);
});

test('the list of existing scripts only shrinks', () => {
  assert.equal(legacy.size, legacyCap, 'The list must hold exactly legacyCap names: lower the cap when a name comes off, and make a new script call revealDefaultSpace instead of listing it');
  const all = new Set(files());
  const stale = [...legacy].filter(n => !all.has(n) || !opens.test(read(n)) || usesHelper(read(n)));
  assert.deepEqual(stale, [], 'Remove these names and lower the cap: the script is gone, no longer opens the space, or now uses the helper');
});
