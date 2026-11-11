'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs');

test('the complete Main source has one lazy shared ButlerRole constructor site', () => {
  const source = fs.readFileSync(require.resolve('../main.cjs'), 'utf8');
  const sites = [...source.matchAll(/\bnew\s+ButlerRole\s*\(/g)];
  assert.equal(sites.length, 1, 'A second site outside the initializer must not bypass the shared Role observations');
  assert.match(source.slice(Math.max(0, sites[0].index - 40), sites[0].index), /\bbutlerRole\s*\|\|=\s*$/,
    'Repeated initialization reuses the same Role rather than discarding its observations');
});
