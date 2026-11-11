'use strict';
const fs = require('node:fs'), path = require('node:path');
const { butlerBinding } = require('./butler-backend.cjs');
const { lockIdentity, ownerMayBeAlive } = require('./service-lock.cjs');
const failure = code => Object.assign(new Error('Butler service: ' + code), { code });
function privateStore(directory) {
  const parent = fs.lstatSync(directory);
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid() || (parent.mode & 0o077)) throw failure('unsafe-store');
}
function readPrivate(directory, name) {
  let fd;
  try {
    fd = fs.openSync(path.join(directory, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    privateStore(directory);
    const s = fs.fstatSync(fd);
    if (!s.isFile() || s.uid !== process.getuid() || (s.mode & 0o077) || s.size > 4096) throw failure('unsafe-record');
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return undefined; throw failure('binding-mismatch'); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function sameBinding(a, b) {
  return JSON.stringify(butlerBinding(a)) === JSON.stringify(butlerBinding(b));
}
function readBinding(directory) {
  const value = readPrivate(directory, 'service-binding.json');
  return value === undefined ? null : Object.freeze(butlerBinding(value));
}
function assertBinding(actual, expected = null) {
  if (expected === null ? actual != null : actual == null || !sameBinding(actual, expected)) throw failure('binding-mismatch');
}
function reserveBinding(directory, value) {
  privateStore(directory);
  const expected = butlerBinding(value), existing = readBinding(directory);
  if (existing) { assertBinding(existing, expected); return; }
  // A reservation never adopts an ordinary or an unrecorded existing service.
  if (fs.readdirSync(directory).length) throw failure('store-not-empty');
  fs.writeFileSync(path.join(directory, 'service-binding.json'), JSON.stringify(expected), { flag: 'wx', mode: 0o600 });
}
function runnerAbsent(directory) {
  const launch = readPrivate(directory, 'native-launch.json');
  if (launch === undefined) return true;
  if (launch?.status !== 'ready' || typeof launch.identity?.started !== 'string' || !launch.identity.started.trim() ||
      !Number.isSafeInteger(launch.identity?.pid) || launch.identity.pid < 2) return false;
  return !ownerMayBeAlive(launch.identity, directory, 'service');
}
function beginRunner(directory) {
  privateStore(directory);
  if (!runnerAbsent(directory)) throw failure('runner-exit-unconfirmed');
  // Write before spawn: a crash between spawn and identity persistence is unknown.
  fs.writeFileSync(path.join(directory, 'native-launch.json'), JSON.stringify({ status: 'starting' }), { mode: 0o600 });
}
function confirmRunner(directory, pid) {
  const identity = lockIdentity(pid);
  if (!identity?.started) throw failure('runner-identity-unconfirmed');
  const file = path.join(directory, 'native-launch.json');
  fs.writeFileSync(file + '.next', JSON.stringify({ status: 'ready', identity }), { flag: 'wx', mode: 0o600 });
  fs.renameSync(file + '.next', file);
}
module.exports = { failure, readBinding, sameBinding, assertBinding, reserveBinding, runnerAbsent, beginRunner, confirmRunner };
