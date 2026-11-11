'use strict';
// Read-only questions about a repository, for checking what an integrator reports (B6, E2b).
// Nothing here writes, merges, fetches or takes the merge lock. Every name is a plain
// argument after --end-of-options, and git runs without the person's configuration and without
// the repository's hooks, diff and text drivers, signature program, file monitor and optional
// locks. A question git cannot answer comes back as null: the caller treats that as "not verified".
// The reader does not judge the repository it is pointed at (its includes, alternates or linked
// metadata): whoever connects it chooses the repository and checks it first.
const { execFile } = require('node:child_process');
const worktree = require('./git-worktree.cjs');

const COMMIT = /^[0-9a-f]{7,40}$/u;
const FULL = /^[0-9a-f]{40}$/u;
const RANGE_LIMIT = 500;                 // commits in one range
const OUTPUT_LIMIT = 64 * 1024 * 1024;   // bytes of patch text read for one range

// A repository may ask for signatures to be shown, which runs the signature program it names.
const CONTROLS = [...worktree.controls, 'log.showSignature=false'];
// Output is bytes: patch text is not always valid UTF-8, and decoding it would make different changes look alike.
function run(repo, args, { input, timeout = 15000 } = {}) {
  return new Promise(resolve => {
    const binary = worktree.available();
    if (!binary) { resolve({ code: null, stdout: Buffer.alloc(0) }); return; }
    const argv = ['--no-optional-locks', ...CONTROLS.flatMap(value => ['-c', value]), ...args];
    const child = execFile(binary, argv, { cwd: repo, env: worktree.gitEnvironment(), encoding: 'buffer', timeout, maxBuffer: OUTPUT_LIMIT, windowsHide: true },
      (error, stdout) => resolve({ code: error ? (Number.isInteger(error.code) ? error.code : null) : 0, stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.alloc(0) }));
    child.stdin.on('error', () => {});
    child.stdin.end(input || '');
  });
}
const text = result => result.stdout.toString('utf8');

function reader(repo) {
  if (typeof repo !== 'string' || !repo.startsWith('/') || repo.includes('\0')) throw Error('A repository folder is required');
  // The full id of a commit named by 7 to 40 hex digits, or null.
  async function commit(revision) {
    if (typeof revision !== 'string' || !COMMIT.test(revision)) return null;
    const result = await run(repo, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${revision}^{commit}`]);
    const id = text(result).trim();
    // A branch or tag whose name looks like a short id is found before the commit: only an id
    // that begins with the given digits is the commit that was named.
    return result.code === 0 && FULL.test(id) && id.startsWith(revision) ? id : null;
  }
  // Whether the first commit is the second or one of its ancestors; null when git cannot say.
  async function isAncestor(ancestor, descendant) {
    if (!FULL.test(ancestor || '') || !FULL.test(descendant || '')) return null;
    const result = await run(repo, ['merge-base', '--is-ancestor', '--end-of-options', ancestor, descendant]);
    return result.code === 0 ? true : result.code === 1 ? false : null;
  }
  // The commits reachable from tip and not from base, newest first, each with the id of its
  // change. Merge commits have no single change and are left out. Null when the range is too
  // large or cannot be read.
  async function changes(base, tip) {
    if (!FULL.test(base || '') || !FULL.test(tip || '')) return null;
    const listed = await run(repo, ['rev-list', `--max-count=${RANGE_LIMIT + 1}`, '--end-of-options', `${base}..${tip}`]);
    if (listed.code !== 0) return null;
    const commits = text(listed).split('\n').filter(Boolean);
    if (commits.length > RANGE_LIMIT || commits.some(id => !FULL.test(id))) return null;
    if (!commits.length) return [];
    const patches = await run(repo, ['log', '--patch', '--no-ext-diff', '--no-textconv', '--no-show-signature', '--no-color', '--no-renames', '--full-index', '--format=commit %H',
      `--max-count=${RANGE_LIMIT}`, '--end-of-options', `${base}..${tip}`]);
    if (patches.code !== 0) return null;
    const ids = await run(repo, ['patch-id', '--stable'], { input: patches.stdout });
    if (ids.code !== 0) return null;
    const byCommit = new Map();
    for (const line of text(ids).split('\n').filter(Boolean)) {
      const [change, id] = line.split(' ');
      if (FULL.test(change || '') && FULL.test(id || '')) byCommit.set(id, change);
    }
    return commits.map(id => ({ commit: id, change: byCommit.get(id) || null }));
  }
  return { commit, isAncestor, changes };
}

module.exports = { reader, RANGE_LIMIT };
