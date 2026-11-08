const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const box = { exports: {} };
vm.runInNewContext(process.binding('natives')['internal/deps/acorn/acorn/dist/acorn'], { module: box, exports: box.exports });
// Playwright 1.64.1's waitForFunction does not await a predicate that returns a Promise: the Promise is truthy, so
// the wait ends after one evaluation even when that evaluation is false (found in T-151's check-room, 2026-11-08).
// A GUI script that waits on service state must poll and await each reading instead (scripts/fixtures/wait-state.cjs).
// Caught here: an async predicate, and one that reaches a Promise through .then or a workspace/api call (T-169).
const promiseCall = node => node?.type === 'CallExpression' && node.callee.type === 'MemberExpression' &&
  (node.callee.property.name === 'then' || ['workspace', 'api'].includes(node.callee.object.name));
function returnsPromise(fn) {
  if (fn.async) return true;
  const pending = [fn.body];
  while (pending.length) {
    const node = pending.pop(); if (!node || typeof node !== 'object') continue;
    if (promiseCall(node)) return true;
    for (const value of Object.values(node)) if (value && typeof value === 'object') { if (Array.isArray(value)) pending.push(...value); else pending.push(value); }
  }
  return false;
}
function promiseWaits(source) {
  const lines = [], pending = [box.exports.parse(source, { ecmaVersion: 'latest', locations: true, allowReturnOutsideFunction: true })];
  while (pending.length) {
    const node = pending.pop(); if (!node || typeof node !== 'object') continue;
    const fn = node.arguments?.[0];
    if (node.type === 'CallExpression' && node.callee.property?.name === 'waitForFunction' && ['ArrowFunctionExpression', 'FunctionExpression'].includes(fn?.type) && returnsPromise(fn)) lines.push(node.loc.start.line);
    for (const value of Object.values(node)) if (value && typeof value === 'object') { if (Array.isArray(value)) pending.push(...value); else pending.push(value); }
  }
  return lines.sort((a, b) => a - b);
}

test('the wait check catches async and Promise-returning predicates, not plain DOM reads', () => {
  for (const source of [
    "page.waitForFunction(async id => (await workspace.initial()).x === id, id);",
    "page.waitForFunction(id => workspace.initial().then(s => s.x === id), id);",
    "page.waitForFunction(() => { return api.read().then(v => v.ok); });",
  ]) assert.deepEqual(promiseWaits(source), [1], source);
  for (const source of [
    "page.waitForFunction(() => document.hasFocus());",
    "page.waitForFunction(dark => document.body.hasAttribute('data-theme') === dark, true);",
    "waitForState(page, async id => (await workspace.initial()).x === id, id, 'saved');",
  ]) assert.deepEqual(promiseWaits(source), [], source);
});

test('no GUI script waits with waitForFunction on a predicate that returns a Promise', () => {
  const dir = path.join(__dirname, '../../scripts');
  const files = [...fs.readdirSync(dir).filter(n => n.endsWith('.cjs')), ...fs.readdirSync(path.join(dir, 'fixtures')).filter(n => n.endsWith('.cjs')).map(n => 'fixtures/' + n)];
  const offenders = files.flatMap(n => promiseWaits(fs.readFileSync(path.join(dir, n), 'utf8')).map(line => `${n}:${line}`));
  assert.deepEqual(offenders, []);
});
