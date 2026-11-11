const test = require('node:test'), assert = require('node:assert/strict');
const path = require('node:path'), { execFileSync } = require('node:child_process');

test('retained reader rows release old complete snapshots; heavyweight callback captures are detected', { timeout: 20000 }, () => {
  const output = execFileSync(process.execPath, ['--expose-gc', path.join(__dirname, 'fixtures/reading-retention-probe.cjs')],
    { encoding: 'utf8', timeout: 15000, maxBuffer: 65536 });
  const result = JSON.parse(output);
  assert.equal(result.normal.rows, 50);
  assert.deepEqual(result.normal.retained, { session: false, original: false, filtered: false, context: false },
    'An unchanged page must not retain a prior session, original/filtered history or context');
  assert.equal(result.session.retained.session, true, 'The probe detects session capture in a row callback');
  assert.equal(result.session.retained.original, true);
  assert.equal(result.messages.retained.filtered, true, 'Track the actual filtered full array, not only the source array');
  assert.equal(result.context.retained.context, true, 'The probe detects context capture in a row callback');
  assert.equal(result.context.retained.original, true);
});
