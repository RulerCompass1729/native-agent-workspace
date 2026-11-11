const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { execFileSync } = require('node:child_process');
const worktree = require('../git-worktree.cjs');
const { reader, RANGE_LIMIT } = require('../integrator-git.cjs');

// A real temporary repository; nothing outside it is read or written.
function fixture(t) {
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'naw-integrator-git-')));
  const repo = path.join(temporary, 'repository'); fs.mkdirSync(repo);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/.test(key))),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
  const git = (...args) => execFileSync(worktree.available(), ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false',
    '-c', 'user.name=Synthetic fixture', '-c', 'user.email=fixture@example.com', ...args], { cwd: repo, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  let serial = 0;
  const commit = (file, text) => { fs.writeFileSync(path.join(repo, file), text); git('add', '--', file); git('commit', '--quiet', '-m', `Synthetic change ${++serial}`); return git('rev-parse', 'HEAD'); };
  git('init', '--quiet', '--initial-branch=main');
  const base = commit('base.txt', 'base\n');
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  return { temporary, repo, git, commit, base, read: reader(repo) };
}

function fixtureCommit(repo, git) {
  fs.writeFileSync(path.join(repo, 'named.txt'), 'named\n'); git('add', '--', 'named.txt'); git('commit', '--quiet', '-m', 'Synthetic named change');
  return git('rev-parse', 'HEAD');
}
test('a commit is named by hex digits only, and an unknown or unsafe name is not resolved', async t => {
  const { read, base, git, repo } = fixture(t);
  assert.equal(await read.commit(base), base);
  assert.equal(await read.commit(base.slice(0, 7)), base);
  for (const bad of ['main', 'HEAD', base.slice(0, 6), '--upload-pack=x', `${base}^`, 'f'.repeat(40), '', null, 7, `${base}\n`]) assert.equal(await read.commit(bad), null, String(bad));
  // A tag or tree with a hex name is not a commit.
  const tree = git('rev-parse', 'HEAD^{tree}');
  assert.equal(await read.commit(tree), null);
  assert.throws(() => reader('relative/path'));
  assert.equal(await reader(path.join(repo, 'missing')).commit(base), null, 'A folder git cannot read answers null');
  // A branch or tag named like a short id is found by git before the commit. Such a name is not
  // taken for the commit it imitates; the full id still names the commit.
  const next = fixtureCommit(repo, git);
  git('branch', next.slice(0, 7), base); git('tag', next.slice(0, 12), base);
  assert.equal(git('rev-parse', '--verify', '--quiet', `${next.slice(0, 7)}^{commit}`), base, 'git itself resolves the name to the branch');
  assert.equal(await read.commit(next.slice(0, 7)), null);
  assert.equal(await read.commit(next.slice(0, 12)), null);
  assert.equal(await read.commit(next.slice(0, 9)), next, 'A short id no ref imitates is still resolved');
  assert.equal(await read.commit(next), next);
});

test('ancestry is answered yes, no, or not at all', async t => {
  const { read, base, commit, git } = fixture(t);
  const next = commit('a.txt', 'a\n');
  git('checkout', '--quiet', '-b', 'side', base); const side = commit('b.txt', 'b\n');
  assert.equal(await read.isAncestor(base, next), true);
  assert.equal(await read.isAncestor(next, next), true);
  assert.equal(await read.isAncestor(next, base), false);
  assert.equal(await read.isAncestor(side, next), false);
  for (const [a, b] of [[base.slice(0, 7), next], [base, 'main'], ['f'.repeat(40), next], [base, 'e'.repeat(40)], [undefined, next]]) assert.equal(await read.isAncestor(a, b), null, `${a} ${b}`);
});

test('the changes of a range keep their ids across a fast-forward and a cherry-pick, and differ when the change differs', async t => {
  const { read, base, commit, git } = fixture(t);
  // A delivery of two commits on its own branch.
  git('checkout', '--quiet', '-b', 'lane/work', base);
  const first = commit('one.txt', 'one\n'), second = commit('two.txt', 'two\n');
  const delivered = await read.changes(base, second);
  assert.deepEqual(delivered.map(entry => entry.commit), [second, first]);
  assert.ok(delivered.every(entry => /^[0-9a-f]{40}$/.test(entry.change)) && delivered[0].change !== delivered[1].change);
  // Main moved on, and the delivery is cherry-picked on top: new commit ids, the same change ids.
  git('checkout', '--quiet', 'main'); const moved = commit('other.txt', 'other\n');
  git('cherry-pick', first, second); const picked = git('rev-parse', 'HEAD');
  const merged = await read.changes(base, picked);
  assert.equal(merged.length, 3);
  assert.ok(!merged.some(entry => [first, second].includes(entry.commit)), 'The picked commits are new commits');
  const mergedChanges = new Set(merged.map(entry => entry.change));
  assert.ok(delivered.every(entry => mergedChanges.has(entry.change)), 'Every delivered change is found in what was merged');
  assert.ok(mergedChanges.has((await read.changes(base, moved))[0].change), 'The unrelated commit main moved on by is among them too');
  // The same file with other content is another change.
  git('checkout', '--quiet', '-b', 'lane/other', base); const different = commit('one.txt', 'not one\n');
  assert.ok(!mergedChanges.has((await read.changes(base, different))[0].change));
  // A fast-forward keeps the very same commits.
  git('checkout', '--quiet', '-b', 'ff-main', base); git('merge', '--quiet', '--ff-only', 'lane/work');
  assert.deepEqual(await read.changes(base, git('rev-parse', 'HEAD')), delivered);
  // Nothing between a commit and itself; an unknown end is not answered.
  assert.deepEqual(await read.changes(second, second), []);
  assert.equal(await read.changes(base, 'f'.repeat(40)), null);
  assert.equal(await read.changes(base.slice(0, 7), second), null);
  assert.equal(RANGE_LIMIT, 500);
});

test('changes that differ only in bytes that are not valid text are different changes', async t => {
  const { read, base, git, repo } = fixture(t);
  // The same line in two encodings of one letter: read as text, both would become the same replacement character.
  const write = (branch, bytes) => { git('checkout', '--quiet', '-b', branch, base); fs.writeFileSync(path.join(repo, 'name.txt'), Buffer.from(bytes)); git('add', '--', 'name.txt'); git('commit', '--quiet', '-m', `Synthetic ${branch}`); return git('rev-parse', 'HEAD'); };
  const one = write('lane/one', [0x63, 0x61, 0x66, 0xe9, 0x0a]), other = write('lane/other', [0x63, 0x61, 0x66, 0xe8, 0x0a]);
  const [first] = await read.changes(base, one), [second] = await read.changes(base, other);
  assert.match(first.change, /^[0-9a-f]{40}$/); assert.match(second.change, /^[0-9a-f]{40}$/);
  assert.notEqual(first.change, second.change);
  // The same bytes again are the same change.
  git('checkout', '--quiet', '-b', 'lane/again', base); git('cherry-pick', one);
  assert.equal((await read.changes(base, git('rev-parse', 'HEAD')))[0].change, first.change);
});

test('a merge commit has no single change, so a range holding one is not fully identified', async t => {
  const { read, base, commit, git } = fixture(t);
  git('checkout', '--quiet', '-b', 'side', base); commit('side.txt', 'side\n');
  git('checkout', '--quiet', 'main'); commit('main.txt', 'main\n');
  git('merge', '--quiet', '--no-ff', '-m', 'Synthetic merge', 'side');
  const range = await read.changes(base, git('rev-parse', 'HEAD'));
  assert.equal(range.length, 3);
  assert.equal(range.filter(entry => entry.change === null).length, 1, 'The merge commit carries no change id');
});

test('reading runs none of the repository\'s own programs and writes nothing', async t => {
  const { read, base, commit, git, repo, temporary } = fixture(t);
  const marker = path.join(temporary, 'ran');
  // A repository that would run a program on any diff, hook or file-system query.
  const program = path.join(temporary, 'program.sh');
  fs.writeFileSync(program, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\ncat "$1" 2>/dev/null\n`, { mode: 0o700 });
  git('config', 'diff.evil.textconv', program); git('config', 'diff.evil.command', program); git('config', 'core.fsmonitor', program);
  git('config', 'diff.external', program); git('config', 'core.pager', program);
  fs.mkdirSync(path.join(repo, '.git/hooks'), { recursive: true });
  for (const hook of ['post-checkout', 'pre-commit', 'reference-transaction']) fs.writeFileSync(path.join(repo, '.git/hooks', hook), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, { mode: 0o700 });
  commit('.gitattributes', '*.txt diff=evil\n');
  // A repository that asks for signatures to be shown, and names the program that checks them.
  const signed = path.join(temporary, 'signature-checked'), signer = path.join(temporary, 'signer.sh');
  fs.writeFileSync(signer, ['#!/bin/sh', `touch ${JSON.stringify(signed)}`, 'case "$*" in *--verify*) echo "[GNUPG:] GOODSIG 0000000000000000 Synthetic"; exit 0 ;; esac',
    'echo "[GNUPG:] SIG_CREATED D 1 8 00 0 0000000000000000000000000000000000000000" >&2', "printf -- '-----BEGIN PGP SIGNATURE-----\\n\\nc3ludGhldGlj\\n-----END PGP SIGNATURE-----\\n'", ''].join('\n'), { mode: 0o700 });
  fs.writeFileSync(path.join(repo, 'data.txt'), 'data\n'); git('add', '--', 'data.txt');
  git('-c', `gpg.program=${signer}`, 'commit', '--quiet', '-S', '-m', 'Synthetic signed change');
  const next = git('rev-parse', 'HEAD');
  assert.match(git('cat-file', 'commit', next), /^gpgsig /m, 'The fixture commit carries a signature');
  git('config', 'log.showSignature', 'true'); git('config', 'gpg.program', signer);
  fs.rmSync(signed, { force: true });
  const listing = () => JSON.stringify(fs.readdirSync(path.join(repo, '.git')).sort()) + fs.readFileSync(path.join(repo, '.git/HEAD'), 'utf8') +
    fs.readFileSync(path.join(repo, '.git/refs/heads/main'), 'utf8') + fs.statSync(path.join(repo, '.git/index')).mtimeMs;
  fs.rmSync(marker, { force: true });   // the fixture's own commits are not what is measured
  const before = listing();
  assert.equal(await read.commit(next), next);
  assert.equal(await read.isAncestor(base, next), true);
  const range = await read.changes(base, next);
  assert.ok(range.length >= 1 && range.every(entry => entry.change));
  assert.equal(fs.existsSync(marker), false, 'No configured driver, pager, monitor or hook ran');
  assert.equal(fs.existsSync(signed), false, 'The signature program did not run');
  assert.equal(listing(), before, 'The repository is as it was');
  // Listing the same range the ordinary way does run the signature program: that trap is real too.
  execFileSync(worktree.available(), ['log', '--format=%H', `${base}..${next}`], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  assert.equal(fs.existsSync(signed), true, 'An unprotected listing would have run it');
  assert.equal(fs.existsSync(marker), false);
  // The same range read the ordinary way does run the configured program: the fixture is a real trap.
  execFileSync(worktree.available(), ['log', '--patch', '--textconv', `${base}..${next}`], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  assert.equal(fs.existsSync(marker), true, 'An unprotected read would have run it');
  // A GIT_DIR in the environment does not redirect the reader.
  const saved = process.env.GIT_DIR; process.env.GIT_DIR = path.join(temporary, 'elsewhere');
  try { assert.equal(await read.commit(next), next); } finally { if (saved === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved; }
});

test('the reader is not connected: nothing in the app or its scripts loads it or the handoff record yet', () => {
  const root = path.join(__dirname, '../..');
  const sources = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return ['node_modules', 'tests', 'dist', '.git'].includes(entry.name) ? [] : sources(file);
    return /\.(?:c?js|mjs|html)$/.test(entry.name) ? [file] : [];
  });
  const files = [...sources(path.join(root, 'app')), ...sources(path.join(root, 'scripts'))].filter(file => !/integrator-(?:git|handoff)\.cjs$/.test(file));
  assert.ok(files.length > 100 && files.some(file => file.endsWith('renderer.js')) && files.some(file => file.includes(`${path.sep}scripts${path.sep}`)), 'The scan covers the app, its subfolders and the scripts');
  // The two module names as a program would load them (the lock script's folder of release records has another name).
  for (const file of files) assert.ok(!/integrator-(?:git|handoff)(?:\.cjs)?['"`]/.test(fs.readFileSync(file, 'utf8')), path.relative(root, file));
});

test('a change of a submodule is read as its two commit ids; git is not run inside the submodule', async t => {
  const { read, base, git, repo, temporary } = fixture(t);
  // A library with a program of its own for diffs, checked out as a submodule of the repository.
  const marker = path.join(temporary, 'submodule-program-ran'), program = path.join(temporary, 'submodule-program.sh');
  fs.writeFileSync(program, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, { mode: 0o700 });
  const library = path.join(temporary, 'library'); fs.mkdirSync(library);
  const inLibrary = (...args) => execFileSync(worktree.available(), ['-c', 'user.name=Synthetic fixture', '-c', 'user.email=fixture@example.com', '-c', 'commit.gpgsign=false', '-c', 'protocol.file.allow=always', ...args],
    { cwd: library, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  inLibrary('init', '--quiet', '--initial-branch=main'); fs.writeFileSync(path.join(library, 'part.txt'), 'one\n'); inLibrary('add', '--', 'part.txt'); inLibrary('commit', '--quiet', '-m', 'Synthetic library one');
  git('-c', 'protocol.file.allow=always', 'submodule', '--quiet', 'add', library, 'library'); git('commit', '--quiet', '-m', 'Synthetic add library');
  const added = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(library, 'part.txt'), 'two\n'); inLibrary('commit', '--quiet', '-am', 'Synthetic library two');
  git('-C', 'library', '-c', 'protocol.file.allow=always', 'pull', '--quiet', 'origin', 'main'); git('commit', '--quiet', '-am', 'Synthetic move library');
  const moved = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(library, 'part.txt'), 'three\n'); inLibrary('commit', '--quiet', '-am', 'Synthetic library three');
  git('-C', 'library', '-c', 'protocol.file.allow=always', 'pull', '--quiet', 'origin', 'main'); git('commit', '--quiet', '-am', 'Synthetic move library again');
  const movedAgain = git('rev-parse', 'HEAD');
  git('config', 'diff.submodule', 'diff'); git('-C', 'library', 'config', 'diff.external', program);
  fs.rmSync(marker, { force: true });
  const range = await read.changes(base, movedAgain);
  assert.deepEqual(range.map(entry => entry.commit), [movedAgain, moved, added]);
  assert.ok(range.every(entry => /^[0-9a-f]{40}$/.test(entry.change)));
  assert.equal(new Set(range.map(entry => entry.change)).size, 3, 'Two different moves of the same submodule are two different changes');
  assert.equal(fs.existsSync(marker), false, 'The submodule\'s program did not run');
  // The same range read the ordinary way does run it: the trap is real.
  execFileSync(worktree.available(), ['log', '--patch', `${base}..${movedAgain}`], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  assert.equal(fs.existsSync(marker), true, 'An unprotected read would have run it');
});

test('a grafts file does not change what the reader answers about ancestry', async t => {
  const { read, base, commit, git, repo } = fixture(t);
  const next = commit('a.txt', 'a\n');
  git('checkout', '--quiet', '-b', 'side', base); const side = commit('b.txt', 'b\n');
  assert.equal(await read.isAncestor(next, side), false);
  // A graft that claims the side commit descends from the other one.
  fs.mkdirSync(path.join(repo, '.git/info'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.git/info/grafts'), `${side} ${next}\n`);
  assert.doesNotThrow(() => git('merge-base', '--is-ancestor', next, side), 'git itself now believes the graft');
  assert.equal(await read.isAncestor(next, side), false, 'The reader is not told otherwise by the graft');
  assert.deepEqual((await read.changes(base, side)).map(entry => entry.commit), [side]);
});

test('the reader only reads: its source has no writing git command', () => {
  const source = fs.readFileSync(path.join(__dirname, '../integrator-git.cjs'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  const commands = [...source.matchAll(/run\(repo, \['([a-z-]+)'/g)].map(match => match[1]).sort();
  assert.deepEqual(commands, ['log', 'merge-base', 'patch-id', 'rev-list', 'rev-parse']);
  for (const word of ["'merge'", "'commit'", "'push'", "'fetch'", "'checkout'", "'reset'", "'update-ref'", "'cherry-pick'", "'rebase'", 'integrator-lock', 'writeFile', 'unlink', 'renameSync', 'mkdir']) assert.ok(!source.includes(word), word);
});
