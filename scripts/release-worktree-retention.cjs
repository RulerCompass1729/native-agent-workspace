// T-167 prevention (user 2026-11-08): after a successful whole build, remove old daily release worktrees
// (<main repo>/.local/release-worktrees/daily-ui-alphaN, about 350-750 MB each). Keep the installed build
// (installation.json and the installed app's Info.plist must agree, or nothing is removed), the 3 newest builds
// (the installed one counts among them, as in artifact-retention.cjs) and the worktree that is building. Any other directory there is left alone.
// A worktree is removed only when it is a registered git worktree, not locked, its HEAD is on a branch or tag,
// it has no changed or untracked files, no mounted disk image comes from it, and no process has it open or as its
// working directory. Removal is
// `git worktree remove` without --force, so git refuses anything unclean. A skipped worktree stays and is reported.
// Every decision is appended to <main repo>/.local/release-worktree-retention.jsonl.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const NAME = /^daily-ui-alpha(0|[1-9]\d*)$/;
const VERSION = /^0\.1\.0-alpha\.(0|[1-9]\d*)$/;
function run(command, args, cwd) {
  const res = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || (res.error ? res.error.message : '') };
}
// Paths are compared as real paths: git, lsof and callers may spell the same directory differently (/tmp, /var).
const real = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

// The main checkout that owns .local/release-worktrees, found from any of its worktrees.
function mainRoot(root) {
  const res = run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], root);
  const common = res.status === 0 ? res.stdout.trim() : '';
  if (path.basename(common) !== '.git') throw Error('Release worktree retention needs a non-bare checkout');
  // git already prints the real path today (/private/var for /var); real() keeps that true if it ever does not.
  return real(path.dirname(common));
}

// The installed build, only when both records agree; otherwise null and nothing is removed.
function installedVersion({
  installationFile = path.join(os.homedir(), 'Library/Application Support/Native Agent Workspace/installation.json'),
  appPlist = '/Applications/Native Agent Workspace.app/Contents/Info.plist',
} = {}) {
  let recorded = null;
  try { recorded = JSON.parse(fs.readFileSync(installationFile, 'utf8')).version; } catch { return null; }
  const res = run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', appPlist]);
  const shown = res.status === 0 ? res.stdout.trim() : null;
  return typeof recorded === 'string' && VERSION.test(recorded) && recorded === shown ? recorded : null;
}

// Pure choice of what to keep. names: directory names under release-worktrees.
function planWorktrees({ names, installed, building = null, keepLatest = 3 }) {
  const builds = names.map(name => ({ name, n: NAME.test(name) ? Number(name.match(NAME)[1]) : null }));
  const ignored = builds.filter(b => b.n === null).map(b => b.name).sort();
  const numbered = builds.filter(b => b.n !== null).sort((a, b) => a.n - b.n);
  const installedN = typeof installed === 'string' && VERSION.test(installed) ? Number(installed.match(VERSION)[1]) : null;
  if (installedN === null || !Number.isSafeInteger(keepLatest) || keepLatest < 1) {
    return { blocked: installedN === null ? 'installed-version-unconfirmed' : 'invalid-keep-count', keep: numbered.map(b => b.name), remove: [], ignored };
  }
  const keep = new Set([...numbered.filter(b => b.n === installedN), ...numbered.slice(-keepLatest)].map(b => b.name));
  if (building) keep.add(building);
  return { blocked: null, keep: numbered.filter(b => keep.has(b.name)).map(b => b.name), remove: numbered.filter(b => !keep.has(b.name)).map(b => b.name), ignored };
}

// Paths any process has open or as its working directory. Fails safe: null means unknown, so nothing is removed.
function openPaths() {
  const res = run('/usr/sbin/lsof', ['-nP', '-Fn']);
  if (res.status !== 0 || !res.stdout.trim()) return null;
  return res.stdout.split('\n').filter(line => line.startsWith('n/')).map(line => line.slice(1));
}

// Mounted disk images and mount points, as text. Fails safe: null means unknown, so nothing is removed.
function mountText() {
  const info = run('hdiutil', ['info']), mounts = run('mount', []);
  return info.status === 0 && mounts.status === 0 ? info.stdout + '\n' + mounts.stdout : null;
}

function checkRemovable(repo, dir, open, mounted = mountText()) {
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return 'not a directory';
  const list = run('git', ['worktree', 'list', '--porcelain'], repo);
  const block = list.status === 0 ? list.stdout.split('\n\n').find(b => b.startsWith('worktree ') && real(b.split('\n')[0].slice(9)) === dir) : null;
  if (!block) return 'not a registered worktree';
  if (/\nlocked/.test(block)) return 'locked';
  const head = run('git', ['rev-parse', 'HEAD'], dir).stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(head)) return 'no HEAD';
  if (!run('git', ['for-each-ref', '--contains', head, '--format=%(refname)', 'refs/heads', 'refs/tags'], repo).stdout.trim()) return 'HEAD on no branch or tag';
  const status = run('git', ['status', '--porcelain', '--untracked-files=normal'], dir);
  if (status.status !== 0 || status.stdout.trim()) return 'changed or untracked files';
  if (mounted === null) return 'mounts unknown';
  if (mounted.split('\n').some(line => line.includes(dir + '/') || line.endsWith(dir) || line.includes(dir + ' '))) return 'mounted image or mount point inside';
  if (!open) return 'open files unknown';
  // lsof reports real paths (for example /private/tmp), and dir is a real path here.
  if (open.some(p => p === dir || p.startsWith(dir + '/'))) return 'in use';
  return null;
}

// Called by package-mac.cjs after a successful whole build. Returns the summary; never throws for one worktree.
function retainReleaseWorktrees({ root, keepLatest = 3, installed = installedVersion(), open = openPaths, mounts = mountText, output = console.log } = {}) {
  const repo = mainRoot(root), dir = path.join(repo, '.local', 'release-worktrees');
  if (!fs.existsSync(dir)) return { removed: [], skipped: [], kept: [], blocked: 'no release worktrees' };
  const lock = path.join(repo, '.local', 'release-worktree-retention.lock');
  // A lock left by a crashed run keeps retention off (nothing removed) until someone removes it; the message names it.
  try { fs.mkdirSync(lock); } catch { output(`Release worktree retention: ${lock} exists (another run, or left by a crash); nothing removed.`); return { removed: [], skipped: [], kept: [], blocked: 'locked' }; }
  const receipts = path.join(repo, '.local', 'release-worktree-retention.jsonl');
  const record = entry => fs.appendFileSync(receipts, JSON.stringify({ at: new Date().toISOString(), installed, ...entry }) + '\n');
  try {
    const rel = path.relative(dir, fs.realpathSync(root));
    const building = !rel.startsWith('..') && !path.isAbsolute(rel) && NAME.test(rel.split(path.sep)[0]) ? rel.split(path.sep)[0] : null;
    const plan = planWorktrees({ names: fs.readdirSync(dir), installed, building, keepLatest });
    const summary = { removed: [], skipped: [], kept: plan.keep, blocked: plan.blocked };
    if (plan.blocked) { record({ status: 'blocked', reason: plan.blocked }); }
    for (const name of plan.remove) {
      const target = path.join(dir, name);
      const head = run('git', ['rev-parse', 'HEAD'], target).stdout.trim();
      let reason;
      try {
        reason = checkRemovable(repo, target, open(), mounts());
        if (!reason) {
          // Written before removal, so a crash mid-removal still leaves a record.
          record({ path: target, head, status: 'removing' });
          const res = run('git', ['worktree', 'remove', target], repo);
          if (res.status !== 0 || fs.existsSync(target)) reason = `git worktree remove failed: ${res.stderr.trim().slice(0, 200)}`;
        }
      } catch (error) { reason = `check failed: ${error.message}`; }
      if (reason) { summary.skipped.push({ name, reason }); record({ path: target, head, status: 'skipped', reason }); continue; }
      summary.removed.push(name); record({ path: target, head, status: 'removed' });
    }
    output(`Release worktree retention: kept ${summary.kept.join(', ') || 'none'}; removed ${summary.removed.join(', ') || 'none'}` +
      (summary.skipped.length ? `; skipped ${summary.skipped.map(s => `${s.name} (${s.reason})`).join(', ')}` : '') + (plan.blocked ? `; ${plan.blocked}, nothing removed` : '') + '.');
    return summary;
  } finally { fs.rmSync(lock, { recursive: true, force: true }); }
}

module.exports = { planWorktrees, installedVersion, openPaths, mountText, retainReleaseWorktrees };
