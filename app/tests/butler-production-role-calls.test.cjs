'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const app = path.join(__dirname, '..');

test('production Butler modules authorize with three arguments and never supply parser fixture entries', () => {
  const actual = fs.readdirSync(app).filter(file => /^butler-.*\.cjs$/.test(file) && file !== 'butler-role.cjs').sort()
    .flatMap(file => fs.readFileSync(path.join(app, file), 'utf8').split('\n')
      .filter(line => /\.(?:authorize|current)\s*\(/.test(line))
      .map(line => [file, line.trim()]));
  // Pin every direct call site, including newly introduced Butler modules. A
  // fourth authorize argument or an explicit current array must change this list.
  // This is a source invariant for named direct calls, not a defence against aliases.
  assert.deepEqual(actual, [
    ['butler-business.cjs', 'return this.#role.authorize(actor, binding.expected, records);'],
    ['butler-business.cjs', 'const records = this.#records(); this.#role.authorize(actualActorRecord, expected, records);'],
    ['butler-controller.cjs', 'const current = this.role.current(); if (!current) return null;'],
    ['butler-controller.cjs', 'return this.role.authorize(record, { selectionRevision: current.selectionRevision, runnerRef: current.runner.runnerRef }, state.records);'],
    ['butler-person.cjs', 'const current = snapshot.selected ? this.role.current() : null;'],
    ['butler-queue.cjs', 'const selected = this.role.authorize(actualRecord, expected, view.records);'],
  ]);
});
