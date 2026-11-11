'use strict';
// The one repository whose "main" the integration handoff reads (B6): the person's own choice.
// The record names a folder and nothing else; only the person sets or clears it. The working
// folder of the integrator's session is never read in its place: a separate clone or a linked
// working tree there would have another "main".
// The folder must be the top of a repository's main working tree, and the repository must not
// reach outside itself (included configuration, borrowed objects, linked paths, a partial
// clone). Those checks are the worktree helper's; they are made when the folder is chosen and
// again before every use, because a repository can change after it was chosen.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { uiError } = require('./ui-errors.cjs');
const worktree = require('./git-worktree.cjs');

const FILE = 'integration-repository.json';
function readPrivate(file, limit) {
  // Open first, then judge what was opened: a link is refused and nothing can be swapped in between.
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || stat.mode & 0o077 || stat.size > limit) throw Error('Unsafe repository record');
    return fs.readFileSync(fd, 'utf8');
  } finally { fs.closeSync(fd); }
}
const validRoot = value => typeof value === 'string' && path.isAbsolute(value) && value.length <= 4096 && !/[\x00-\x1f\x7f]/u.test(value);

// The top folder of the repository if `selected` is exactly that, is its main working tree and
// passes the helper's checks. Anything else is refused in words of this feature's own (the
// helper's own words are about automatic copies).
function mainCheckout(selected) {
  let found;
  try { found = worktree.repository(selected); }
  catch (error) { throw Object.assign(uiError('error.handoff.repositoryUnsafe'), { cause: error?.uiMessage?.key }); }
  if (found.directory !== found.root || found.gitDir !== path.join(found.root, '.git') || found.common !== found.gitDir) throw uiError('error.handoff.repositoryNotMain');
  return found.root;
}

class IntegrationRepository {
  constructor(directory) {
    this.file = path.join(directory, FILE);
    this.root = null;
    this.failed = false;
    try {
      const data = JSON.parse(readPrivate(this.file, 16384));
      if (data.version !== 1 || !Object.hasOwn(data, 'root') || !(data.root === null || validRoot(data.root))) throw Error('Invalid repository record');
      this.root = data.root;
    } catch (error) { if (error.code !== 'ENOENT') this.failed = true; }
  }
  // The folder as the person chose it, or null for none. A record that cannot be read gives an
  // error, never "none": a caller must not take a broken record for a missing choice.
  chosen() {
    if (this.failed) throw uiError('error.handoff.repositoryState');
    return this.root;
  }
  // The folder to read now: the chosen one, if it still passes every check. Null when none is
  // chosen; an error when the record cannot be read or the folder no longer passes.
  usable() {
    const root = this.chosen();
    return root === null ? null : mainCheckout(root);
  }
  // What `selected` would be recorded as, without recording it.
  check(selected) { return mainCheckout(selected); }
  // The person's choice: a folder (checked first), or null to clear it.
  set(selected) {
    const root = selected === null ? null : mainCheckout(selected);
    const temp = `${this.file}.${randomUUID()}.tmp`;
    let fd;
    try {
      fd = fs.openSync(temp, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ version: 1, root }));
      fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(temp, this.file);
      const directory = fs.openSync(path.dirname(this.file), 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    } catch { this.failed = true; throw uiError('error.handoff.repositoryState'); }
    finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temp); } catch { /* Renamed away, or never made. */ } }
    this.root = root; this.failed = false;
    return root;
  }
}

module.exports = { IntegrationRepository, FILE };
