'use strict';
// A person-designated, dedicated Codex runner. This record grants only the B4
// record-only role; it never grants queue-secretary or lifecycle powers.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { successor } = require('./queue-secretary.cjs');
const { roomIds } = require('./collaboration-spaces.cjs');

const MAX_RECORD = 16 * 1024, MAX_LOG = 32 * 1024 * 1024;
const codeError = code => Object.assign(Error(code), { code });
const fail = code => { throw codeError(code); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fields = (value, allowed, required = allowed) => plain(value) && Object.keys(value).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key));
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 100 && !/[\u0000-\u001f\u007f]/u.test(value);
const copy = value => structuredClone(value);
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const revision = value => Number.isSafeInteger(value) && value >= 0;
function identity(value) {
  if (!fields(value, ['sessionId', 'nativeId']) || !id(value.sessionId) || !id(value.nativeId)) fail('ERR_BUTLER_INVALID');
  return { sessionId: value.sessionId, nativeId: value.nativeId };
}
function runner(value) {
  if (!fields(value, ['runnerRef', 'backendRef', 'purpose', 'profile', 'provider', 'model']) ||
      !id(value.runnerRef) || !id(value.backendRef) || value.purpose !== 'butler' || value.profile !== 'deepseek-pro' ||
      value.provider !== 'deepseek' || value.model !== 'deepseek-v4-pro') fail('ERR_BUTLER_INVALID');
  return { runnerRef: value.runnerRef, backendRef: value.backendRef, purpose: value.purpose, profile: value.profile, provider: value.provider, model: value.model };
}
function budget(value) {
  if (value === undefined || value === null) return null;
  if (!fields(value, ['currency', 'limitMicros', 'dayBoundary'], ['limitMicros']) || !revision(value.limitMicros) ||
      value.currency !== undefined && value.currency !== 'USD' || value.dayBoundary !== undefined && value.dayBoundary !== 'UTC') fail('ERR_BUTLER_INVALID');
  // Only the amount supplied by the person is recorded. Unknown is never zero.
  return { currency: 'USD', limitMicros: value.limitMicros, dayBoundary: 'UTC' };
}
function selection(value) {
  if (!fields(value, ['identity', 'runner', 'budget'], ['identity', 'runner'])) fail('ERR_BUTLER_INVALID');
  return { identity: identity(value.identity), runner: runner(value.runner), budget: budget(value.budget) };
}
function state(value) {
  if (!fields(value, ['version', 'revision', 'selected']) || value.version !== 1 || !revision(value.revision) || value.revision === 0) fail('ERR_BUTLER_INVALID');
  return { version: 1, revision: value.revision, selected: value.selected === null ? null : selection(value.selected) };
}
function safePrivateFile(stat, limit) {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.getuid() && !(stat.mode & 0o077) && stat.size <= limit;
}

class ButlerRole {
  #directory; #directoryIdentity; #file; #logFile; #authorizePerson; #state = { version: 1, revision: 0, selected: null };
  #failed = false; #seenRecord = false;
  constructor(directory, { authorizePerson = () => false } = {}) {
    this.#authorizePerson = authorizePerson;
    try {
      if (typeof authorizePerson !== 'function' || typeof directory !== 'string') fail('ERR_BUTLER_STATE');
      const initial = fs.lstatSync(directory);
      if (!initial.isDirectory() || initial.isSymbolicLink() || initial.uid !== process.getuid() || (initial.mode & 0o777) !== 0o700) fail('ERR_BUTLER_STATE');
      this.#directory = fs.realpathSync(directory); this.#directoryIdentity = initial;
      this.#file = path.join(this.#directory, 'butler.json'); this.#logFile = path.join(this.#directory, 'rotation-log.jsonl');
      this.#load();
    } catch { this.#failed = true; }
  }
  get file() { return this.#file; }
  get logFile() { return this.#logFile; }
  #directoryFd() {
    if (this.#failed) fail('ERR_BUTLER_STATE');
    let fd;
    try {
      const current = fs.lstatSync(this.#directory);
      if (!current.isDirectory() || current.isSymbolicLink() || current.uid !== process.getuid() || (current.mode & 0o777) !== 0o700 || !sameFile(current, this.#directoryIdentity)) fail('ERR_BUTLER_STATE');
      fd = fs.openSync(this.#directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      if (!sameFile(fs.fstatSync(fd), current)) fail('ERR_BUTLER_STATE');
      return fd;
    } catch { if (fd !== undefined) fs.closeSync(fd); fail('ERR_BUTLER_STATE'); }
  }
  #read(file, limit) {
    const directoryFd = this.#directoryFd(); let fd;
    try {
      const before = fs.lstatSync(file);
      if (!safePrivateFile(before, limit)) fail('ERR_BUTLER_STATE');
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const opened = fs.fstatSync(fd);
      if (!sameFile(opened, before) || !safePrivateFile(opened, limit)) fail('ERR_BUTLER_STATE');
      const buffer = Buffer.alloc(limit + 1); let length = 0;
      while (length < buffer.length) {
        const read = fs.readSync(fd, buffer, length, buffer.length - length, length);
        if (!read) break;
        length += read;
      }
      const text = buffer.toString('utf8', 0, length), after = fs.fstatSync(fd);
      if (!sameFile(after, before) || !safePrivateFile(after, limit) || length !== after.size || before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || Buffer.byteLength(text) > limit) fail('ERR_BUTLER_STATE');
      return text;
    } finally { if (fd !== undefined) fs.closeSync(fd); fs.closeSync(directoryFd); }
  }
  #load() {
    if (this.#failed) fail('ERR_BUTLER_STATE');
    try {
      let loaded;
      try { loaded = state(JSON.parse(this.#read(this.#file, MAX_RECORD))); }
      catch (error) { if (error.code === 'ENOENT' && !this.#seenRecord) return; throw error; }
      if (loaded.revision < this.#state.revision || loaded.revision === this.#state.revision && JSON.stringify(loaded) !== JSON.stringify(this.#state)) fail('ERR_BUTLER_STATE');
      this.#state = loaded; this.#seenRecord = true;
    } catch { this.#failed = true; fail('ERR_BUTLER_STATE'); }
  }
  #person(actor) {
    let authorized = false;
    try { authorized = this.#authorizePerson(actor) === true; } catch { /* No caller-provided assertion grants this role. */ }
    if (!authorized) fail('ERR_BUTLER_PERSON');
  }
  #write(selected, expectedRevision) {
    if (!revision(expectedRevision)) fail('ERR_BUTLER_REVISION');
    let directoryFd, lockFd, lockIdentity, tempFd, tempIdentity, next;
    const lock = path.join(this.#directory || '', 'butler.json.lock'), temp = `${this.#file}.${randomUUID()}.tmp`;
    try {
      directoryFd = this.#directoryFd();
      try { lockFd = fs.openSync(lock, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600); }
      catch (error) { if (error.code === 'EEXIST') fail('ERR_BUTLER_BUSY'); throw error; }
      lockIdentity = fs.fstatSync(lockFd);
      if (!safePrivateFile(lockIdentity, MAX_RECORD)) fail('ERR_BUTLER_STATE');
      this.#load();
      if (expectedRevision !== this.#state.revision || this.#state.revision === Number.MAX_SAFE_INTEGER) fail('ERR_BUTLER_REVISION');
      next = { version: 1, revision: this.#state.revision + 1, selected };
      tempFd = fs.openSync(temp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
      tempIdentity = fs.fstatSync(tempFd);
      if (!safePrivateFile(tempIdentity, MAX_RECORD)) fail('ERR_BUTLER_STATE');
      fs.writeFileSync(tempFd, JSON.stringify(next)); fs.fsyncSync(tempFd); fs.closeSync(tempFd); tempFd = undefined;
      const checkedFd = this.#directoryFd(); fs.closeSync(checkedFd);
      fs.renameSync(temp, this.#file); fs.fsyncSync(directoryFd);
      this.#state = next; this.#seenRecord = true;
    } catch (error) {
      if (['ERR_BUTLER_BUSY', 'ERR_BUTLER_REVISION'].includes(error.code)) throw error;
      this.#failed = true; fail('ERR_BUTLER_STATE');
    } finally {
      if (tempFd !== undefined) fs.closeSync(tempFd);
      if (lockFd !== undefined) fs.closeSync(lockFd);
      // Only remove files created by this invocation, never another writer's lock.
      for (const [file, owned] of [[temp, tempIdentity], [lock, lockIdentity]]) {
        if (!owned) continue;
        try { const present = fs.lstatSync(file); if (sameFile(present, owned) && safePrivateFile(present, MAX_RECORD)) fs.unlinkSync(file); else this.#failed = true; }
        catch (error) { if (error.code !== 'ENOENT') { this.#failed = true; } }
      }
      if (directoryFd !== undefined) fs.closeSync(directoryFd);
    }
    if (this.#failed) fail('ERR_BUTLER_STATE');
    return copy(this.#state);
  }
  set(actor, value, expectedRevision) { this.#person(actor); return this.#write(selection(value), expectedRevision); }
  revoke(actor, expectedRevision) { this.#person(actor); return this.#write(null, expectedRevision); }
  snapshot() { this.#load(); return copy(this.#state); }
  current(entries) {
    this.#load();
    if (!this.#state.selected) return null;
    try {
      if (entries === undefined) {
        try { entries = this.#read(this.#logFile, MAX_LOG).split('\n').filter(line => line.trim()).map(line => JSON.parse(line)); }
        catch (error) { if (error.code !== 'ENOENT') throw error; entries = []; }
      }
      if (!Array.isArray(entries)) fail('ERR_BUTLER_STATE');
      const resolved = successor(this.#state.selected.identity, entries);
      return { ...copy(this.#state.selected), identity: resolved, selectionRevision: this.#state.revision, mode: 'record-only' };
    } catch { this.#failed = true; fail('ERR_BUTLER_STATE'); }
  }
  authorize(actorRecord, expected, records, entries) {
    if (!fields(expected, ['selectionRevision', 'runnerRef']) || !revision(expected.selectionRevision) || !id(expected.runnerRef)) fail('ERR_BUTLER_UNAUTHORIZED');
    const current = this.current(entries);
    if (!current || current.selectionRevision !== expected.selectionRevision || current.runner.runnerRef !== expected.runnerRef ||
        !Array.isArray(records) || !records.includes(actorRecord) || actorRecord?.id !== current.identity.sessionId ||
        actorRecord.nativeId !== current.identity.nativeId || actorRecord.provider !== 'codex' || actorRecord.archived ||
        actorRecord.nativeContextPending || !['idle', 'working', 'approval'].includes(actorRecord.state)) fail('ERR_BUTLER_UNAUTHORIZED');
    try {
      if (roomIds(actorRecord).length || JSON.stringify(runner(actorRecord.runner)) !== JSON.stringify(current.runner)) fail('ERR_BUTLER_UNAUTHORIZED');
    } catch { fail('ERR_BUTLER_UNAUTHORIZED'); }
    return current;
  }
}
module.exports = { ButlerRole };
