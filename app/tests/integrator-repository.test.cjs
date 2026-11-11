const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const locale = require('../ui-locale.js');
const { IntegrationRepository, FILE } = require('../integrator-repository.cjs');

// The person's choice of main repository for integration handoffs (B6). Real temporary
// repositories made with git; the module itself runs no program.
const refused = name => error => error.uiMessage?.key === name;
const gitEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/.test(name))), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Synthetic fixture', '-c', 'user.email=fixture@example.com', ...args],
  { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function fixture(t) {
  // The real path: the system's temporary folder is reached through a link, which the checks refuse.
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'naw-integration-repository-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const data = path.join(base, 'data'), repo = path.join(base, 'repository');
  fs.mkdirSync(data, { mode: 0o700 }); fs.mkdirSync(repo);
  git(repo, 'init', '--quiet', '--initial-branch=main');
  fs.writeFileSync(path.join(repo, 'synthetic.txt'), 'base\n'); git(repo, 'add', '--', 'synthetic.txt'); git(repo, 'commit', '--quiet', '-m', 'Synthetic base');
  fs.mkdirSync(path.join(repo, 'inside'));
  return { base, data, repo, file: path.join(data, FILE), open: () => new IntegrationRepository(data) };
}

test('the top folder of a main working tree is recorded, read back and checked again before every use', t => {
  const f = fixture(t);
  const record = f.open();
  assert.deepEqual([record.chosen(), record.usable(), fs.existsSync(f.file)], [null, null, false], 'Nothing is chosen at first, and nothing is written');
  assert.equal(record.check(f.repo), f.repo);
  assert.equal(fs.existsSync(f.file), false, 'Checking records nothing');
  assert.equal(record.set(f.repo), f.repo);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file, 'utf8')), { version: 1, root: f.repo });
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(f.data), [FILE], 'No temporary file is left behind');
  const again = f.open();
  assert.deepEqual([again.chosen(), again.usable()], [f.repo, f.repo]);
  // The repository changes after it was chosen: the choice stands, but it is not read.
  fs.appendFileSync(path.join(f.repo, '.git/config'), '[include]\n\tpath = /synthetic/elsewhere\n');
  assert.equal(again.chosen(), f.repo);
  assert.throws(() => again.usable(), refused('error.handoff.repositoryUnsafe'));
  // Cleared by the person: none.
  assert.equal(again.set(null), null);
  assert.deepEqual([f.open().chosen(), f.open().usable()], [null, null]);
});

test('a folder that is not the top of a main working tree, or a repository that reaches outside itself, is refused and nothing is recorded', t => {
  const f = fixture(t);
  const record = f.open();
  // A folder inside the repository, and a linked working tree of it: each has "main", but neither is the main checkout.
  const linked = path.join(f.base, 'linked');
  git(f.repo, 'worktree', 'add', '--quiet', '-b', 'lane/synthetic', linked);
  for (const folder of [path.join(f.repo, 'inside'), linked]) assert.throws(() => record.set(folder), refused('error.handoff.repositoryNotMain'), folder.slice(f.base.length));
  // Not a repository; a path through a link; not a path at all.
  const plain = path.join(f.base, 'plain'); fs.mkdirSync(plain);
  const link = path.join(f.base, 'link'); fs.symlinkSync(f.repo, link);
  for (const folder of [plain, link, path.join(link, 'inside'), 'relative/path', '', 7, undefined, {}, f.repo + '\u0000', path.join(f.base, 'missing')]) {
    assert.throws(() => record.set(folder), refused('error.handoff.repositoryUnsafe'), String(folder).slice(-20));
  }
  // Configuration that includes another file, and objects borrowed from another repository.
  const included = path.join(f.base, 'included'); fs.mkdirSync(included); git(included, 'init', '--quiet', '--initial-branch=main');
  fs.appendFileSync(path.join(included, '.git/config'), '[includeIf "gitdir:/synthetic/"]\n\tpath = /synthetic/elsewhere\n');
  const borrowing = path.join(f.base, 'borrowing'); fs.mkdirSync(borrowing); git(borrowing, 'init', '--quiet', '--initial-branch=main');
  fs.writeFileSync(path.join(borrowing, '.git/objects/info/alternates'), path.join(f.repo, '.git/objects') + '\n');
  for (const folder of [included, borrowing]) {
    const error = (() => { try { record.set(folder); } catch (caught) { return caught; } })();
    assert.equal(error?.uiMessage?.key, 'error.handoff.repositoryUnsafe', folder.slice(f.base.length));
    assert.match(String(error.cause), /^error\.git/, 'The helper\'s own reason is kept for the record, not shown as the sentence');
  }
  assert.deepEqual([record.chosen(), fs.existsSync(f.file)], [null, false]);
  // A good choice is not lost by a refused one after it.
  record.set(f.repo);
  assert.throws(() => record.set(plain), refused('error.handoff.repositoryUnsafe'));
  assert.equal(f.open().chosen(), f.repo);
});

test('a record that cannot be read is an error, never "none", and the person\'s next choice repairs it', t => {
  const f = fixture(t);
  const cases = [() => fs.writeFileSync(f.file, '{', { mode: 0o600 }), () => fs.writeFileSync(f.file, JSON.stringify({ version: 2, root: f.repo }), { mode: 0o600 }),
    () => fs.writeFileSync(f.file, JSON.stringify({ version: 1, root: 'relative' }), { mode: 0o600 }), () => fs.writeFileSync(f.file, JSON.stringify({ version: 1 }), { mode: 0o600 }),
    () => { fs.writeFileSync(f.file, JSON.stringify({ version: 1, root: f.repo }), { mode: 0o600 }); fs.chmodSync(f.file, 0o644); },
    () => { fs.writeFileSync(path.join(f.data, 'elsewhere.json'), JSON.stringify({ version: 1, root: f.repo }), { mode: 0o600 }); fs.symlinkSync(path.join(f.data, 'elsewhere.json'), f.file); }];
  for (const [index, damage] of cases.entries()) {
    fs.rmSync(f.file, { force: true });
    damage();
    const record = f.open();
    assert.throws(() => record.chosen(), refused('error.handoff.repositoryState'), String(index));
    assert.throws(() => record.usable(), refused('error.handoff.repositoryState'), String(index));
    assert.equal(record.set(f.repo), f.repo, String(index));
    assert.equal(f.open().chosen(), f.repo, String(index));
  }
  // A record that cannot be saved: the choice is not taken as made.
  const record = f.open();
  fs.chmodSync(f.data, 0o500);
  t.after(() => { try { fs.chmodSync(f.data, 0o700); } catch { /* Already removed. */ } });
  assert.throws(() => record.set(null), refused('error.handoff.repositoryState'));
  assert.throws(() => record.chosen(), refused('error.handoff.repositoryState'));
  fs.chmodSync(f.data, 0o700);
  assert.equal(f.open().chosen(), f.repo, 'What was saved before is still there');
});

test('the module runs no program, and its sentences exist in both languages', () => {
  const source = fs.readFileSync(path.join(__dirname, '../integrator-repository.cjs'), 'utf8');
  assert.ok(!/child_process|execFile|spawn/.test(source));
  for (const name of ['error.handoff.repositoryNotMain', 'error.handoff.repositoryUnsafe', 'error.handoff.repositoryNoMain', 'error.handoff.repositoryState', 'os.handoff.repositoryUnset']) {
    const zh = locale.format('zh', name, { count: 2 }), en = locale.format('en', name, { count: 2 });
    assert.ok(zh && en && zh !== en && zh !== name && en !== name, name);
  }
});
