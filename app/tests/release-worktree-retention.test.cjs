// T-167 prevention: old daily release worktrees go after a successful build; the installed build, the 3 newest and the
// building one stay; anything unclean, unproven, locked, mounted or in use stays and is reported. Temporary git repos only.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { planWorktrees, installedVersion, openPaths, retainReleaseWorktrees } = require('../../scripts/release-worktree-retention.cjs');

const git = (cwd, ...args) => {
  const res = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8' });
  assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`); return res.stdout.trim();
};
const names = n => n.map(v => `daily-ui-alpha${v}`);
// Present without following links: alpha0 below is a symlink left dangling once alpha1 is removed.
const present = p => { try { fs.lstatSync(p); return true; } catch { return false; } };

test('the plan keeps the installed build, the 3 newest (the installed one counts) and the building one; other names are ignored', () => {
  const all = [...names([203, 204, 209, 214, 215, 216, 217, 218, 219, 220]), 'notes', 'daily-ui-alpha220-copy'];
  assert.deepEqual(planWorktrees({ names: all, installed: '0.1.0-alpha.220' }),
    { blocked: null, keep: names([218, 219, 220]), remove: names([203, 204, 209, 214, 215, 216, 217]), ignored: ['daily-ui-alpha220-copy', 'notes'] });
  assert.deepEqual(planWorktrees({ names: all, installed: '0.1.0-alpha.215' }).keep, names([215, 218, 219, 220]), 'installed older than the newest');
  assert.deepEqual(planWorktrees({ names: all, installed: '0.1.0-alpha.230' }).keep, names([218, 219, 220]), 'installed build has no worktree here');
  assert.deepEqual(planWorktrees({ names: all, installed: '0.1.0-alpha.220', building: 'daily-ui-alpha203' }).keep, names([203, 218, 219, 220]));
  for (const installed of [null, '', 'alpha.220', '0.1.0-alpha.220 ']) {
    const plan = planWorktrees({ names: all, installed });
    assert.equal(plan.blocked, 'installed-version-unconfirmed'); assert.deepEqual(plan.remove, []);
  }
});

test('the installed version counts only when installation.json and the installed app agree', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-retention-installed-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const installation = path.join(dir, 'installation.json'), plist = path.join(dir, 'Info.plist');
  const writePlist = v => fs.writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${v}</string></dict></plist>`);
  fs.writeFileSync(installation, JSON.stringify({ version: '0.1.0-alpha.220' })); writePlist('0.1.0-alpha.220');
  assert.equal(installedVersion({ installationFile: installation, appPlist: plist }), '0.1.0-alpha.220');
  writePlist('0.1.0-alpha.219'); assert.equal(installedVersion({ installationFile: installation, appPlist: plist }), null, 'disagreement');
  assert.equal(installedVersion({ installationFile: path.join(dir, 'missing.json'), appPlist: plist }), null, 'no record');
});

// Paths are built from os.tmpdir() as given (on macOS /var/folders/..., really /private/var/folders/...), while lsof and
// mount report real paths. Kept: 20 (installed, newest) and 19. Old candidates, each with one reason to stay or none:
// 1 clean (removed, with its ignored build output), 0 symlink, 2 untracked work, 3 HEAD on no ref, 4 locked, 5 in use,
// 6 a disk image mounted from inside it, 7 a separate git repo, 8 a worktree registered to another repo.
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-retention-')); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const repo = path.join(base, 'repo'), dir = path.join(repo, '.local', 'release-worktrees'), realDir = () => fs.realpathSync(dir);
  const commit = cwd => { git(cwd, 'init', '-q'); fs.writeFileSync(path.join(cwd, '.gitignore'), '.local/\nnode_modules/\n'); fs.writeFileSync(path.join(cwd, 'a.txt'), 'a\n'); git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'release'); };
  fs.mkdirSync(repo); commit(repo); git(repo, 'branch', 'release/x');
  const head = git(repo, 'rev-parse', 'HEAD');
  for (const v of [1, 2, 3, 4, 5, 6, 19, 20]) git(repo, 'worktree', 'add', '-q', '--detach', path.join(dir, `daily-ui-alpha${v}`), head);
  fs.mkdirSync(path.join(dir, 'daily-ui-alpha1', 'node_modules')); fs.writeFileSync(path.join(dir, 'daily-ui-alpha1', 'node_modules', 'x.js'), 'ignored output\n');
  fs.writeFileSync(path.join(dir, 'daily-ui-alpha2', 'work.txt'), 'someone else\n');
  fs.writeFileSync(path.join(dir, 'daily-ui-alpha3', 'a.txt'), 'b\n'); git(path.join(dir, 'daily-ui-alpha3'), 'commit', '-qam', 'only here');
  git(repo, 'worktree', 'lock', path.join(dir, 'daily-ui-alpha4'));
  fs.symlinkSync(path.join(dir, 'daily-ui-alpha1'), path.join(dir, 'daily-ui-alpha0'));
  fs.mkdirSync(path.join(dir, 'daily-ui-alpha7')); commit(path.join(dir, 'daily-ui-alpha7'));
  const other = path.join(base, 'other'); fs.mkdirSync(other); commit(other); git(other, 'branch', 'release/y');
  git(other, 'worktree', 'add', '-q', '--detach', path.join(dir, 'daily-ui-alpha8'), git(other, 'rev-parse', 'HEAD'));
  fs.mkdirSync(path.join(dir, 'notes'));
  const open = () => [path.join(realDir(), 'daily-ui-alpha5', 'a.txt')];
  const mounts = () => `/dev/disk9s1 on /Volumes/Native Agent Workspace (apfs, local, nodev, nosuid, read-only, noowners, mounted by t)\nimage-path      : ${path.join(realDir(), 'daily-ui-alpha6', 'dist', 'x.dmg')}\n`;
  return { repo, dir, head, other, open, mounts };
}

test('a successful build removes only clean, proven, unlocked, unmounted, unused old worktrees of this repo; the rest stay and are reported', t => {
  const { repo, dir, head, other, open, mounts } = fixture(t), lines = [];
  const summary = retainReleaseWorktrees({ root: repo, keepLatest: 2, installed: '0.1.0-alpha.20', open, mounts, output: l => lines.push(l) });
  assert.deepEqual(summary.removed, ['daily-ui-alpha1']);
  assert.deepEqual(Object.fromEntries(summary.skipped.map(s => [s.name, s.reason])), {
    'daily-ui-alpha0': 'not a directory', 'daily-ui-alpha2': 'changed or untracked files', 'daily-ui-alpha3': 'HEAD on no branch or tag',
    'daily-ui-alpha4': 'locked', 'daily-ui-alpha5': 'in use', 'daily-ui-alpha6': 'mounted image or mount point inside',
    'daily-ui-alpha7': 'not a registered worktree', 'daily-ui-alpha8': 'not a registered worktree' });
  assert.deepEqual(summary.kept, ['daily-ui-alpha19', 'daily-ui-alpha20']);
  assert.equal(present(path.join(dir, 'daily-ui-alpha1')), false, 'removed with its ignored build output');
  for (const v of [0, 2, 3, 4, 5, 6, 7, 8, 19, 20]) assert.equal(present(path.join(dir, `daily-ui-alpha${v}`)), true, `alpha${v} stays`);
  assert.equal(fs.readFileSync(path.join(dir, 'daily-ui-alpha2', 'work.txt'), 'utf8'), 'someone else\n');
  assert.equal(present(path.join(dir, 'notes')), true); assert.equal(git(repo, 'rev-parse', 'release/x'), head, 'branch kept');
  assert.match(git(other, 'worktree', 'list'), /daily-ui-alpha8/, 'the other repo keeps its worktree');
  assert.match(lines.join('\n'), /removed daily-ui-alpha1; skipped/);
  const receipts = fs.readFileSync(path.join(repo, '.local', 'release-worktree-retention.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const alpha1 = receipts.filter(r => r.path.endsWith('daily-ui-alpha1')).map(r => r.status);
  assert.deepEqual(alpha1, ['removing', 'removed'], 'recorded before and after removal');
  assert.equal(receipts.filter(r => r.status === 'skipped').length, 8);
  assert.equal(present(path.join(repo, '.local', 'release-worktree-retention.lock')), false, 'lock released');

  const again = retainReleaseWorktrees({ root: repo, keepLatest: 2, installed: '0.1.0-alpha.20', open, mounts, output: () => {} });
  assert.deepEqual(again.removed, [], 'a second run removes nothing more');
  for (const v of [0, 2, 3, 4, 5, 6, 7, 8, 19, 20]) assert.equal(present(path.join(dir, `daily-ui-alpha${v}`)), true);
});

test('nothing is removed without a confirmed installed build, with unknown open files or mounts, or while another run holds the lock', t => {
  const { repo, dir, open, mounts } = fixture(t), quiet = () => {};
  assert.deepEqual(retainReleaseWorktrees({ root: repo, keepLatest: 1, installed: null, open, mounts, output: quiet }).removed, []);
  assert.deepEqual(retainReleaseWorktrees({ root: repo, keepLatest: 1, installed: '0.1.0-alpha.20', open: () => null, mounts, output: quiet }).removed, []);
  assert.deepEqual(retainReleaseWorktrees({ root: repo, keepLatest: 1, installed: '0.1.0-alpha.20', open, mounts: () => null, output: quiet }).removed, []);
  fs.mkdirSync(path.join(repo, '.local', 'release-worktree-retention.lock'));
  assert.equal(retainReleaseWorktrees({ root: repo, keepLatest: 1, installed: '0.1.0-alpha.20', open, mounts, output: quiet }).blocked, 'locked');
  assert.equal(present(path.join(dir, 'daily-ui-alpha1')), true);
});

test('a build inside a release worktree keeps that worktree and finds the main checkout from it', t => {
  const { repo, dir, open, mounts } = fixture(t);
  const summary = retainReleaseWorktrees({ root: path.join(dir, 'daily-ui-alpha1'), keepLatest: 1, installed: '0.1.0-alpha.20', open, mounts, output: () => {} });
  assert.ok(summary.kept.includes('daily-ui-alpha1')); assert.equal(present(path.join(dir, 'daily-ui-alpha1')), true);
  assert.equal(present(path.join(repo, '.local', 'release-worktree-retention.jsonl')), true);
});

test('the real lsof scan sees a file this process holds open, by its real path', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-retention-lsof-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'held.txt'); fs.writeFileSync(file, 'held\n');
  const fd = fs.openSync(file, 'r'); t.after(() => fs.closeSync(fd));
  const open = openPaths();
  assert.ok(Array.isArray(open) && open.length > 0, 'lsof answered');
  assert.ok(open.includes(fs.realpathSync(file)), 'the held file is listed under its real path');
});

test('package-mac runs retention only after a successful whole build, and a retention error does not fail the build', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../scripts/package-mac.cjs'), 'utf8');
  const body = source.slice(source.indexOf('async function build()'), source.indexOf('if (require.main === module)'));
  const call = body.indexOf('retainReleaseWorktrees('), dmg = body.indexOf('buildDmg(app)'), report = body.indexOf('reportArtifactRetention(path.join(root');
  assert.ok(call > dmg && call > report, 'after the DMG and the retention report');
  assert.ok(call < body.indexOf('} finally {'), 'on the success path, not in finally');
  assert.match(body.slice(report, body.indexOf('} finally {')), /try \{[^]*retainReleaseWorktrees\([^]*\} catch \(error\) \{ console\.error\(/, 'its error is reported, not rethrown');
});


test('the real lsof scan sees held files when PATH excludes the system sbin directory', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-retention-path-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'held.txt'); fs.writeFileSync(file, 'held\n');
  const fd = fs.openSync(file, 'r'); t.after(() => fs.closeSync(fd));
  const modulePath = path.resolve(__dirname, '../../scripts/release-worktree-retention.cjs');
  const result = spawnSync(process.execPath, ['-e',
    'const open = require(process.argv[1]).openPaths(); process.stdout.write(JSON.stringify({ answered: Array.isArray(open), held: open?.includes(process.argv[2]) === true }))', modulePath, fs.realpathSync(file)], {
    env: { ...process.env, PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 30000,
  });
  assert.equal(result.status, 0, result.stderr);
  const observation = JSON.parse(result.stdout);
  assert.equal(observation.answered, true, 'lsof answered without the system sbin directory in PATH');
  assert.equal(observation.held, true, 'the actual held file remains protected');
});
