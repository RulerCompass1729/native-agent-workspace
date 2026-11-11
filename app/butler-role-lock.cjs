'use strict';
const fs = require('node:fs'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const ROLE_LOCK_NAME = 'butler.json.lock', PROTOCOL = 'naw-butler-role-lock-v1', MAX_MARKER = 512;
// Darwin SDK sys/fcntl.h: O_EXLOCK = 0x20. Node does not export this constant.
// open(2) combines it with O_NONBLOCK to obtain a cooperative flock at open.
const EXLOCK = 0x20;
let kernelLockUnavailable = false;
const busy = () => { throw Object.assign(Error('ERR_BUTLER_BUSY'), { code: 'EEXIST' }); };
const failed = () => { throw Object.assign(Error('ERR_BUTLER_STATE'), { code: 'ERR_BUTLER_STATE' }); };
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const unchanged = (a, b) => same(a, b) && a.size === b.size && a.nlink === b.nlink && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const privateFile = (stat, links) => stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid() &&
  (stat.mode & 0o777) === 0o600 && links.includes(stat.nlink) && stat.size <= MAX_MARKER;
const stageName = value => typeof value === 'string' && /^\.butler-role-lock-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/.test(value);
function checkDirectory(directory, directoryFd) {
  const opened = fs.fstatSync(directoryFd), present = fs.lstatSync(directory);
  if (![opened, present].every(value => value.isDirectory() && !value.isSymbolicLink() && value.uid === process.getuid() &&
      (value.mode & 0o777) === 0o700) || !same(opened, present)) failed();
}
function named(file) {
  try { return fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function markerFrom(fd, before, file) {
  const buffer = Buffer.alloc(MAX_MARKER + 1); let length = 0;
  while (length < buffer.length) {
    const count = fs.readSync(fd, buffer, length, buffer.length - length, length);
    if (!count) break;
    length += count;
  }
  const after = fs.fstatSync(fd), present = named(file);
  if (!present || !privateFile(after, [1, 2]) || !privateFile(present, [1, 2]) || length !== after.size ||
      !unchanged(before, after) || !unchanged(after, present)) busy();
  let value;
  try { value = JSON.parse(buffer.toString('utf8', 0, length)); } catch { busy(); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2 ||
      !Object.hasOwn(value, 'protocol') || !Object.hasOwn(value, 'stage') || value.protocol !== PROTOCOL || !stageName(value.stage)) busy();
  return { value, after };
}
function recoverOne(directory, directoryFd, lock, flags) {
  const before = named(lock);
  if (!before) return;
  // A legacy empty file or unknown writer does not participate in this protocol.
  // Getting a kernel lock on it would not authorize deleting it.
  if (!privateFile(before, [1, 2]) || before.size === 0) busy();
  let fd;
  try {
    try { fd = fs.openSync(lock, flags); }
    catch (error) {
      if (['EAGAIN', 'EWOULDBLOCK'].includes(error.code)) busy();
      if (error.code === 'ENOENT') return;
      throw error;
    }
    const opened = fs.fstatSync(fd);
    if (!privateFile(opened, [1, 2]) || !unchanged(before, opened)) busy();
    const { value, after } = markerFrom(fd, opened, lock), stage = path.join(directory, value.stage), staged = named(stage);
    if (after.nlink === 1 ? staged !== null : !staged || !privateFile(staged, [2]) || !unchanged(after, staged)) busy();
    checkDirectory(directory, directoryFd);
    let current = fs.fstatSync(fd), present = named(lock);
    if (!present || !unchanged(after, current) || !unchanged(current, present)) busy();
    // The second link is accepted only as the exact marker-named stage inode.
    // No other hard link is searched for or removed.
    if (staged) {
      const stageNow = named(stage);
      if (!stageNow || !unchanged(current, stageNow)) busy();
      fs.unlinkSync(stage);
      current = fs.fstatSync(fd); present = named(lock);
      if (!privateFile(current, [1]) || !present || !unchanged(current, present) ||
          current.size !== after.size || current.mtimeMs !== after.mtimeMs) busy();
    }
    fs.unlinkSync(lock);
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function removeOwn(file, identity) {
  const current = named(file);
  if (!current) return;
  if (!same(current, identity) || !privateFile(current, [1, 2])) failed();
  fs.unlinkSync(file);
}
function verifyKernelLock(stage, flags, identity) {
  const present = named(stage);
  if (!present || !privateFile(present, [1]) || !same(present, identity)) failed();
  let probe;
  try { probe = fs.openSync(stage, flags); }
  catch (error) {
    if (['EAGAIN', 'EWOULDBLOCK'].includes(error.code)) {
      const after = named(stage);
      if (!after || !privateFile(after, [1]) || !same(after, identity)) failed();
      return;
    }
    kernelLockUnavailable = true; throw error;
  }
  // A second open must conflict with our still-held first descriptor. If the
  // flag was ignored, no name may be published or reclaimed in this process.
  kernelLockUnavailable = true;
  fs.closeSync(probe); busy();
}
function acquireRoleLock(directory, directoryFd) {
  checkDirectory(directory, directoryFd);
  const lock = path.join(directory, ROLE_LOCK_NAME);
  if (process.platform !== 'darwin') {
    // Other platforms retain their previous no-recovery protocol.
    return fs.openSync(lock, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
  }
  if (kernelLockUnavailable) busy();
  const flags = fs.constants.O_RDWR | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK | EXLOCK;
  const stage = path.join(directory, `.butler-role-lock-${randomUUID()}.tmp`);
  let fd, identity, published = false;
  try {
    fd = fs.openSync(stage, flags | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    identity = fs.fstatSync(fd);
    if (!privateFile(identity, [1])) failed();
    verifyKernelLock(stage, flags, identity);
    fs.writeFileSync(fd, JSON.stringify({ protocol: PROTOCOL, stage: path.basename(stage) }));
    fs.fsyncSync(fd);
    checkDirectory(directory, directoryFd);
    try { fs.linkSync(stage, lock); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      recoverOne(directory, directoryFd, lock, flags);
      checkDirectory(directory, directoryFd);
      // An old O_EXCL writer can win this gap. Never recover a second lock here.
      fs.linkSync(stage, lock);
    }
    published = true;
    const opened = fs.fstatSync(fd), present = named(lock), staged = named(stage);
    if (!privateFile(opened, [2]) || !present || !staged || !unchanged(opened, present) ||
        !unchanged(opened, staged) || !same(opened, identity)) failed();
    fs.unlinkSync(stage);
    const ready = fs.fstatSync(fd), current = named(lock);
    if (!privateFile(ready, [1]) || !current || !unchanged(ready, current) || !same(ready, identity)) failed();
    return fd; // Caller must unlink its own published name before closing this fd.
  } catch (error) {
    let cleanupFailed = false;
    try {
      checkDirectory(directory, directoryFd);
      if (identity) {
        if (published) removeOwn(lock, identity);
        removeOwn(stage, identity);
      }
    } catch { cleanupFailed = true; }
    try { if (fd !== undefined) fs.closeSync(fd); } catch { cleanupFailed = true; }
    if (cleanupFailed) failed();
    throw error;
  }
}
module.exports = { acquireRoleLock, ROLE_LOCK_NAME };
Object.freeze(module.exports);
