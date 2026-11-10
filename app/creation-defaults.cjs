// Desktop-wide creation choices, shared by all native backends. They are
// updated only after a person successfully creates a session through main.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const validPath = value => typeof value === 'string' && value.length <= 4096 && path.isAbsolute(value) && !/[\u0000-\u001f\u007f]/u.test(value);
const empty = () => ({ repository: null, directory: null });
function valid(value) {
  return value && !Array.isArray(value) && Object.keys(value).sort().join(',') === 'directory,repository' &&
    [value.repository, value.directory].every(item => item === null || validPath(item));
}
class CreationDefaults {
  constructor(directory, { defaultWorkspace, newWorkspaceRoot }) {
    this.file = path.join(directory, 'creation-defaults.json');
    this.defaultWorkspace = defaultWorkspace; this.newWorkspaceRoot = newWorkspaceRoot;
    this.value = empty(); this.seed = false;
    let fd;
    try {
      fd = fs.openSync(this.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 || stat.size > 16384) throw Error('Unsafe creation defaults');
      const bytes = Buffer.alloc(16385), count = fs.readSync(fd, bytes, 0, bytes.length, 0);
      if (count > 16384) throw Error('Creation defaults too large');
      const value = JSON.parse(bytes.subarray(0, count).toString('utf8'));
      if (!valid(value)) throw Error('Invalid creation defaults');
      this.value = value;
    } catch (error) { this.seed = error.code === 'ENOENT'; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  get(sessions = []) {
    if (this.seed) {
      this.seed = false;
      const recent = sessions.filter(session => validPath(session.worktreePreparation?.repository))
        .sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0))[0];
      if (recent) {
        const next = { repository: recent.worktreePreparation.repository, directory: null };
        try { this.save(next); } catch { /* A missing optional preference cannot block a session. */ }
      }
    }
    return { ...this.value };
  }
  remember(options = {}) {
    const next = this.get();
    if (options.gitWorktree != null) {
      if (!validPath(options.gitWorktree.repository)) return next;
      next.repository = options.gitWorktree.repository;
    } else {
      if (options.newDirectory || !validPath(options.cwd) || require('./queue-dispatch.cjs').nawMadeDirectory(options.cwd, this.defaultWorkspace, this.newWorkspaceRoot)) return next;
      next.directory = options.cwd;
    }
    try { this.save(next); } catch { /* Keep the successful create and previous defaults. */ }
    return this.get();
  }
  save(value) {
    if (!valid(value)) throw Error('Invalid creation defaults');
    const temp = `${this.file}.${randomUUID()}.tmp`;
    let fd;
    try {
      fd = fs.openSync(temp, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(temp, this.file);
      const directory = fs.openSync(path.dirname(this.file), 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      this.value = { ...value };
    } finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temp); } catch {} }
  }
}
module.exports = { CreationDefaults };
