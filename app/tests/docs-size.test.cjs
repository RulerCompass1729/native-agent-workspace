// The push guard (scripts/privacy_guard.py, MAX_BLOB) refuses any file over 2 MiB. This fails at 1.5 MiB, while a
// file under docs/ can still be split before a push is refused. docs/review.md passed that size and is frozen
// (2026-11-13). New review records go in docs/review/YYYY-MM-DD/<lane>.md, one file per lane and day; the
// recursive walk below covers them (CLAUDE.md, "The review record").
const test = require('node:test'), assert = require('node:assert/strict');
const crypto = require('node:crypto'), fs = require('node:fs'), path = require('node:path');

const docs = path.resolve(__dirname, '../../docs');
const LIMIT = 1.5 * 1024 * 1024;
const FROZEN_REVIEW_SHA256 = '18ebd904447ff2e8974109a7dc57b0cce3efb3d57fb785aad816d7aa777ce23b';

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .flatMap(entry => entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
}

test('docs/review.md stays as it was frozen', () => {
  const file = path.join(docs, 'review.md');
  const sha = fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : 'missing';
  assert.equal(sha, FROZEN_REVIEW_SHA256, 'docs/review.md is frozen. Restore the frozen copy (main has it once the '
    + 'freeze is merged; before that, the branch that froze it) and put the new record, or the correction naming the '
    + 'entry, in docs/review/YYYY-MM-DD/<lane>.md for today.');
});

test('no other file under docs/ passes 1.5 MiB', () => {
  const over = [];
  for (const file of files(docs)) {
    const name = path.relative(docs, file).split(path.sep).join('/'), size = fs.statSync(file).size;
    if (name !== 'review.md' && size > LIMIT) over.push(`docs/${name}: ${size} bytes`);
  }
  assert.deepEqual(over, [], `over ${LIMIT} bytes; split before the push guard's 2 MiB limit refuses it`);
});

// Codex reads at most 32 KiB of project instructions (project_doc_max_bytes) and silently drops the rest; before the
// maintainer overlay was split out, Codex sessions never saw the Push rules at the end.
test('CLAUDE.md stays under the 32 KiB Codex reads', () => {
  const size = fs.statSync(path.resolve(__dirname, '../../CLAUDE.md')).size;
  assert.ok(size < 32768, `CLAUDE.md is ${size} bytes; Codex drops everything after 32768`);
});
