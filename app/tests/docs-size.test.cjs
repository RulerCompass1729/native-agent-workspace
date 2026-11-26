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

// Lanes kept appending to these shared day files after the per-lane rule, and merges conflicted on them
// (alpha.294 to alpha.300). A correction to one of their entries is a new record in a lane file.
const FROZEN_DAY_FILES = {
  '2026-11-13.md': 'c21d0bfd89cf4284881b9eaa862521decfed91e77eef670baa17554b502d22e9',
  '2026-11-14.md': 'f177d46fd1db2892ae9727c239eae61c77d6b53b139a59858c107b780c57efbf',
  '2026-11-15.md': '41d6f94b101062f1102eb629171a800300abc804063980f434c6d4b13830730a',
  '2026-11-16.md': 'bcc6dec6676b73e02916fe87c0f730d22aa518a21b112ab69ccb2fca751c161c',
  '2026-11-17.md': '9e16ca88e72a927097ba0da4a9e0fd46ee8af6b642adf100c36cdbec4ef9b63a',
  '2026-11-18.md': 'b314e03e0fc28f2409ae15e1936d686ce4685215b371b4140f57d760a3dd5661',
  '2026-11-19.md': 'fc912e64735563049d0e91ecda48305d0282771099f73d27d4e3f54ba1505373',
  '2026-11-20.md': 'f87c66fe3914c310131def58124938c0e3b4f0e3d50fe7cdadf5e2520845b777',
  '2026-11-21.md': '0f23c1fd1af33397308f24340fd26b2a56e5a5ba998a59e4dcb55442449dd922',
  '2026-11-22.md': '6af1f5edd9b7eac68a48df54d37bb9cbf522943a641f0d41084bea145058059e',
  '2026-11-23.md': '149f62391df8756e0a44e0e03ee0923cae19332869704271b7599bcdb3f6a348',
  '2026-11-24.md': '4eec0b19d1520554ecf0e53c6245c1f44c29ba2112f95cc117cebcdecfba0d7f',
  '2026-11-25.md': '28d9545f9a343f6a094964ee4716f4ee9f0e98346099cef211a5033ef7011ae5',
};

test('no shared day file under docs/review/ is added or changed', () => {
  const dir = path.join(docs, 'review');
  const changed = [];
  for (const name of fs.readdirSync(dir)) {
    if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(name)) {
      continue;
    }
    const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, name))).digest('hex');
    if (FROZEN_DAY_FILES[name] !== sha) {
      changed.push(`docs/review/${name}`);
    }
  }
  for (const name of Object.keys(FROZEN_DAY_FILES)) {
    if (!fs.existsSync(path.join(dir, name))) {
      changed.push(`docs/review/${name} (missing)`);
    }
  }
  assert.deepEqual(changed, [], 'Shared day files are frozen. Restore them from main and put the new record, or '
    + 'the correction naming the entry, in docs/review/YYYY-MM-DD/<lane>.md for today.');
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
