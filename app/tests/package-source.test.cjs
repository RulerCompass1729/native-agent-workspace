const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { sourceRevision } = require('../../scripts/package-mac.cjs');

test('packaging identifies a clean commit and refuses staged, unstaged and untracked source', t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-package-source-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  // Synthetic local repository only; never run the person's global Git hooks.
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=' + path.join(folder, 'no-hooks'), ...args], { cwd: folder, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@users.noreply.github.com');
  fs.writeFileSync(path.join(folder, '.gitignore'), 'generated.js\n');
  fs.writeFileSync(path.join(folder, 'source.js'), 'original\n');
  git('add', '.'); git('commit', '-m', 'Synthetic packaging source');
  const revision = git('rev-parse', 'HEAD');
  assert.equal(sourceRevision(folder), revision);
  fs.writeFileSync(path.join(folder, 'generated.js'), 'stale generated output');
  assert.equal(sourceRevision(folder), revision, 'The builder regenerates ignored output from committed inputs');
  fs.appendFileSync(path.join(folder, 'source.js'), 'dirty\n');
  assert.throws(() => sourceRevision(folder), /Commit source changes/);
  git('add', 'source.js'); assert.throws(() => sourceRevision(folder), /Commit source changes/);
  git('restore', '--staged', 'source.js'); git('restore', 'source.js');
  fs.writeFileSync(path.join(folder, 'untracked.js'), 'uncommitted input');
  assert.throws(() => sourceRevision(folder), /Commit source changes/);
  fs.unlinkSync(path.join(folder, 'untracked.js')); assert.equal(sourceRevision(folder), revision);
});
