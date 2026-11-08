const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
// Playwright 1.64.1's waitForFunction does not await a predicate that returns a Promise: the Promise is truthy, so
// the wait ends after one evaluation even when that evaluation is false (found in T-151's check-room, 2026-11-08).
// A GUI script that waits on service state must poll and await each reading instead.
// This check catches only the inline form, waitForFunction(async ...). The same defect without `async` (a predicate
// returning workspace.initial().then(...), as in scripts/room-input.cjs) is not caught. check-tui.cjs and
// test-desktop.cjs still use the inline form; fixing them is deferred to a board follow-up, so they are listed here.
const legacy = new Set(['check-tui.cjs', 'test-desktop.cjs']);
test('no GUI script adds an inline async predicate to waitForFunction', () => {
  const dir = path.join(__dirname, '../../scripts');
  const files = [...fs.readdirSync(dir).filter(n => n.endsWith('.cjs')), ...fs.readdirSync(path.join(dir, 'fixtures')).filter(n => n.endsWith('.cjs')).map(n => 'fixtures/' + n)];
  const offenders = files.filter(n => !legacy.has(n) && /waitForFunction\(\s*async\b/.test(fs.readFileSync(path.join(dir, n), 'utf8')));
  assert.deepEqual(offenders, []);
});
