'use strict';
// A person-designated, dedicated DSH butler instance. This record grants only the B4
// record-only role; it never grants queue-secretary or lifecycle powers.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { successor } = require('./queue-secretary.cjs');
const { roomIds } = require('./collaboration-spaces.cjs');
const { acquireRoleLock, ROLE_LOCK_NAME } = require('./butler-role-lock.cjs');
const { PROOF_FILE_NAME, parseRotationProof, initialRotationProof, advanceRotationProof, selectionFingerprint } = require('./butler-rotation-proof.cjs');

const MAX_RECORD = 16 * 1024, MAX_LOG = 32 * 1024 * 1024;
const codeError = code => Object.assign(Error(code), { code });
const fail = code => { throw codeError(code); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fields = (value, allowed, required = allowed) => plain(value) && Object.keys(value).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key));
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 100 && !/[\u0000-\u001f\u007f]/u.test(value);
const copy = value => structuredClone(value);
const configurationName = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,119}$/.test(value);
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const unchanged = (a, b) => sameFile(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
// A failed read still throws ERR_BUTLER_STATE. Only this internally branded,
// safely opened selection read may be retried on a later explicit call.
const selectionReadFailures = new WeakSet(), proofWriteFailures = new WeakSet();
function proofWriteFailure() { const error = codeError('ERR_BUTLER_STATE'); proofWriteFailures.add(error); return error; }
function selectionReadFailure() {
  const error = codeError('ERR_BUTLER_STATE'); selectionReadFailures.add(error); return error;
}
const revision = value => Number.isSafeInteger(value) && value >= 0;
function identity(value) {
  if (!fields(value, ['sessionId', 'nativeId']) || !id(value.sessionId) || !id(value.nativeId)) fail('ERR_BUTLER_INVALID');
  return { sessionId: value.sessionId, nativeId: value.nativeId };
}
function runner(value) {
  if (!fields(value, ['runnerRef', 'backendRef', 'purpose', 'profile', 'provider', 'model']) ||
      !id(value.runnerRef) || !id(value.backendRef) || value.purpose !== 'butler' ||
      !['profile', 'provider', 'model'].every(key => configurationName(value[key]))) fail('ERR_BUTLER_INVALID');
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
  if (!fields(value, ['version', 'revision', 'selected']) || ![1, 2].includes(value.version) || !revision(value.revision) || value.revision === 0) fail('ERR_BUTLER_INVALID');
  return { version: 1, revision: value.revision, selected: value.selected === null ? null : selection(value.selected) };
}
function safePrivateFile(stat, limit) {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.getuid() && !(stat.mode & 0o077) && stat.size <= limit;
}

class ButlerRole {
  #directory; #directoryIdentity; #file; #logFile; #proofFile; #authorizePerson; #state = { version: 1, revision: 0, selected: null };
  #failed = false; #seenRecord = false; #diskVersion = 1; #proofHighwater = null; #proofDurable = null;
  // Process-local integrity observations, never a cached authorization result.
  #seenLog = false; #logMinimum = 0; #logPrefix = null; #resolvedLog = null;
  constructor(directory, { authorizePerson = () => false } = {}) {
    this.#authorizePerson = authorizePerson;
    try {
      if (typeof authorizePerson !== 'function' || typeof directory !== 'string') fail('ERR_BUTLER_STATE');
      const initial = fs.lstatSync(directory);
      if (!initial.isDirectory() || initial.isSymbolicLink() || initial.uid !== process.getuid() || (initial.mode & 0o777) !== 0o700) fail('ERR_BUTLER_STATE');
      this.#directory = fs.realpathSync(directory); this.#directoryIdentity = initial;
      this.#file = path.join(this.#directory, 'butler.json'); this.#logFile = path.join(this.#directory, 'rotation-log.jsonl');
      this.#proofFile = path.join(this.#directory, PROOF_FILE_NAME);
      this.#load();
    } catch (error) { if (!selectionReadFailures.has(error)) this.#failed = true; }
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
    } catch { this.#failed = true; if (fd !== undefined) fs.closeSync(fd); fail('ERR_BUTLER_STATE'); }
  }
  #read(file, limit, expectedPrefix = null) {
    const directoryFd = this.#directoryFd(), rotation = file === this.#logFile, selected = file === this.#file; let fd;
    try {
      const before = fs.lstatSync(file);
      if (rotation) this.#seenLog = true;
      if (!safePrivateFile(before, limit)) fail('ERR_BUTLER_STATE');
      if (rotation) this.#logMinimum = Math.max(this.#logMinimum, before.size);
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const opened = fs.fstatSync(fd);
      if (!sameFile(opened, before) || !safePrivateFile(opened, limit)) fail('ERR_BUTLER_STATE');
      if (selected) this.#seenRecord = true;
      const buffer = Buffer.alloc(limit + 1); let length = 0;
      while (length < buffer.length) {
        let read;
        try { read = fs.readSync(fd, buffer, length, buffer.length - length, length); }
        catch (error) {
          if (selected && error.code === 'EIO') throw selectionReadFailure();
          throw error;
        }
        if (!read) break;
        length += read;
      }
      const text = buffer.toString('utf8', 0, length), after = fs.fstatSync(fd), present = selected ? after : fs.lstatSync(file);
      if (rotation) for (const info of [opened, after, present]) {
        if (safePrivateFile(info, limit)) this.#logMinimum = Math.max(this.#logMinimum, info.size);
      }
      if (!unchanged(before, after) || !unchanged(after, present) || !safePrivateFile(after, limit) ||
          !safePrivateFile(present, limit) || length !== after.size || Buffer.byteLength(text) > limit) fail('ERR_BUTLER_STATE');
      if (rotation) {
        if (length < this.#logMinimum) fail('ERR_BUTLER_STATE');
        const full = digest(buffer.subarray(0, length)), hashes = new Map([[length, full]]);
        for (const prefix of [this.#logPrefix, expectedPrefix]) {
          if (!prefix) continue;
          if (length < prefix.length) fail('ERR_BUTLER_STATE');
          if (!hashes.has(prefix.length)) hashes.set(prefix.length, digest(buffer.subarray(0, prefix.length)));
          if (hashes.get(prefix.length) !== prefix.digest) fail('ERR_BUTLER_STATE');
        }
        return { text, prefix: { length, digest: full } };
      }
      if (!selected) {
        // Reading a complete stored proof also confirms its file and directory
        // durability, including after an earlier writer's unconfirmed fsync.
        const fingerprint = digest(buffer.subarray(0, length));
        if (!this.#proofDurable || !unchanged(this.#proofDurable.stat, after) || this.#proofDurable.digest !== fingerprint) {
          fs.fsyncSync(fd); fs.fsyncSync(directoryFd); this.#proofDurable = { stat: after, digest: fingerprint };
        }
      }
      return text;
    } finally { if (fd !== undefined) fs.closeSync(fd); fs.closeSync(directoryFd); }
  }
  #load() {
    if (this.#failed) fail('ERR_BUTLER_STATE');
    try {
      let loaded, record;
      try { record = JSON.parse(this.#read(this.#file, MAX_RECORD)); loaded = state(record); }
      catch (error) { if (error.code === 'ENOENT' && !this.#seenRecord) return; throw error; }
      if (loaded.revision < this.#state.revision || loaded.revision === this.#state.revision && JSON.stringify(loaded) !== JSON.stringify(this.#state)) fail('ERR_BUTLER_STATE');
      this.#state = loaded; this.#seenRecord = true; this.#diskVersion = record.version;
    } catch (error) {
      if (selectionReadFailures.has(error)) throw error;
      this.#failed = true; fail('ERR_BUTLER_STATE');
    }
  }
  #person(actor) {
    let authorized = false;
    try { authorized = this.#authorizePerson(actor) === true; } catch { /* No caller-provided assertion grants this role. */ }
    if (!authorized) fail('ERR_BUTLER_PERSON');
  }
  #locked(operation) {
    let directoryFd, lockFd, lockIdentity;
    const lock = path.join(this.#directory || '', ROLE_LOCK_NAME);
    try {
      directoryFd = this.#directoryFd();
      try { lockFd = acquireRoleLock(this.#directory, directoryFd); }
      catch (error) { if (error.code === 'EEXIST') fail('ERR_BUTLER_BUSY'); throw error; }
      lockIdentity = fs.fstatSync(lockFd);
      if (!safePrivateFile(lockIdentity, MAX_RECORD)) fail('ERR_BUTLER_STATE');
      return operation(directoryFd);
    } finally {
      let uncertain = false;
      if (lockIdentity) {
        try {
          const present = fs.lstatSync(lock);
          if (sameFile(present, lockIdentity) && safePrivateFile(present, MAX_RECORD)) fs.unlinkSync(lock);
          else uncertain = true;
        } catch (error) { if (error.code !== 'ENOENT') uncertain = true; }
      }
      for (const fd of [lockFd, directoryFd]) {
        try { if (fd !== undefined) fs.closeSync(fd); } catch { uncertain = true; }
      }
      if (uncertain) { this.#failed = true; fail('ERR_BUTLER_STATE'); }
    }
  }
  #replace(file, value, directoryFd) {
    const temp = `${file}.${randomUUID()}.tmp`; let fd, owned;
    try {
      fd = fs.openSync(temp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
      owned = fs.fstatSync(fd);
      if (!safePrivateFile(owned, MAX_RECORD)) fail('ERR_BUTLER_STATE');
      fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd);
      const closing = fd; fd = undefined; fs.closeSync(closing);
      const checked = this.#directoryFd(); fs.closeSync(checked);
      fs.renameSync(temp, file); fs.fsyncSync(directoryFd);
      if (file === this.#proofFile) {
        const present = fs.lstatSync(file);
        if (!sameFile(present, owned) || !safePrivateFile(present, MAX_RECORD)) fail('ERR_BUTLER_STATE');
        this.#proofDurable = { stat: present, digest: digest(Buffer.from(JSON.stringify(value))) };
      }
    } finally {
      let uncertain = false;
      try { if (fd !== undefined) fs.closeSync(fd); } catch { uncertain = true; }
      if (owned) {
        try {
          const present = fs.lstatSync(temp);
          if (sameFile(present, owned) && safePrivateFile(present, MAX_RECORD)) fs.unlinkSync(temp);
          else uncertain = true;
        } catch (error) { if (error.code !== 'ENOENT') uncertain = true; }
      }
      if (uncertain) fail('ERR_BUTLER_STATE');
    }
  }
  #storedProof() { return parseRotationProof(JSON.parse(this.#read(this.#proofFile, MAX_RECORD))); }
  #proofSeen(proof) {
    const fingerprint = selectionFingerprint(proof), prior = this.#proofHighwater;
    if (prior?.selection === proof.selection && (proof.revision < prior.revision ||
        proof.revision === prior.revision && fingerprint !== prior.fingerprint)) fail('ERR_BUTLER_STATE');
    this.#proofHighwater = { selection: proof.selection, revision: proof.revision, fingerprint };
  }
  #write(selected, expectedRevision) {
    if (!revision(expectedRevision)) fail('ERR_BUTLER_REVISION');
    try {
      return this.#locked(directoryFd => {
        this.#load();
        if (expectedRevision !== this.#state.revision || this.#state.revision === Number.MAX_SAFE_INTEGER) fail('ERR_BUTLER_REVISION');
        const next = { version: 1, revision: this.#state.revision + 1, selected }; let proof;
        if (selected) {
          try {
            try { this.#storedProof(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
            proof = initialRotationProof(next, this.#logPrefix);
            // The public selector stays unchanged until its new proof is durable.
            this.#replace(this.#proofFile, proof, directoryFd);
          } catch { throw proofWriteFailure(); }
        }
        this.#replace(this.#file, { ...next, version: 2 }, directoryFd);
        this.#state = next; this.#seenRecord = true; this.#diskVersion = 2;
        if (proof) this.#proofSeen(proof);
        return copy(this.#state);
      });
    } catch (error) {
      if (['ERR_BUTLER_BUSY', 'ERR_BUTLER_REVISION'].includes(error.code) || selectionReadFailures.has(error) || proofWriteFailures.has(error)) throw error;
      this.#failed = true; fail('ERR_BUTLER_STATE');
    }
  }
  set(actor, value, expectedRevision) { this.#person(actor); return this.#write(selection(value), expectedRevision); }
  revoke(actor, expectedRevision) { this.#person(actor); return this.#write(null, expectedRevision); }
  snapshot() { this.#load(); return copy(this.#state); }
  current(entries) {
    this.#load();
    if (!this.#state.selected) return null;
    // Explicit entries are the trusted parser-fixture API, never a production
    // authority source or a way to create/advance persistent history.
    if (entries !== undefined) {
      if (!Array.isArray(entries)) fail('ERR_BUTLER_STATE');
      return { ...copy(this.#state.selected), identity: successor(this.#state.selected.identity, entries),
        selectionRevision: this.#state.revision, mode: 'record-only' };
    }
    try {
      return this.#locked(directoryFd => {
        this.#load();
        if (!this.#state.selected) return null;
        if (this.#diskVersion !== 2) fail('ERR_BUTLER_STATE');
        // The complete read/verify/advance is serialized. A reader that saw B
        // cannot overwrite proof C written by a later reader at the same role rev.
        const proof = this.#storedProof();
        if (proof.selection !== selectionFingerprint(this.#state)) fail('ERR_BUTLER_STATE');
        this.#proofSeen(proof);
        if (proof.prefix) { this.#seenLog = true; this.#logMinimum = Math.max(this.#logMinimum, proof.prefix.length); }
        let observed = null, parsed;
        try {
          const read = this.#read(this.#logFile, MAX_LOG, proof.prefix);
          parsed = read.text.split('\n').filter(line => line.trim()).map(line => JSON.parse(line)); observed = read.prefix;
        } catch (error) { if (error.code !== 'ENOENT' || this.#seenLog) throw error; parsed = []; }
        const resolved = successor(this.#state.selected.identity, parsed);
        if (JSON.stringify(successor(proof.identity, parsed)) !== JSON.stringify(resolved) ||
            this.#resolvedLog?.revision === this.#state.revision &&
            JSON.stringify(successor(this.#resolvedLog.identity, parsed)) !== JSON.stringify(resolved)) fail('ERR_BUTLER_STATE');
        const next = advanceRotationProof(proof, observed, resolved);
        if (next !== proof) this.#replace(this.#proofFile, next, directoryFd);
        this.#proofSeen(next);
        if (observed) this.#logPrefix = observed;
        this.#resolvedLog = { revision: this.#state.revision, identity: copy(resolved) };
        return { ...copy(this.#state.selected), identity: resolved, selectionRevision: this.#state.revision, mode: 'record-only' };
      });
    } catch (error) { if (error.code === 'ERR_BUTLER_BUSY') throw error; fail('ERR_BUTLER_STATE'); }
  }
  authorize(actorRecord, expected, records, entries) {
    if (!fields(expected, ['selectionRevision', 'runnerRef']) || !revision(expected.selectionRevision) || !id(expected.runnerRef)) fail('ERR_BUTLER_UNAUTHORIZED');
    const current = this.current(entries);
    if (!current || current.selectionRevision !== expected.selectionRevision || current.runner.runnerRef !== expected.runnerRef ||
        !Array.isArray(records) || !records.includes(actorRecord) || actorRecord?.id !== current.identity.sessionId ||
        actorRecord.nativeId !== current.identity.nativeId || actorRecord.provider !== 'dsh' || actorRecord.archived ||
        actorRecord.nativeContextPending || !['idle', 'working', 'approval'].includes(actorRecord.state)) fail('ERR_BUTLER_UNAUTHORIZED');
    try {
      if (roomIds(actorRecord).length || JSON.stringify(runner(actorRecord.runner)) !== JSON.stringify(current.runner)) fail('ERR_BUTLER_UNAUTHORIZED');
    } catch { fail('ERR_BUTLER_UNAUTHORIZED'); }
    return current;
  }
}
module.exports = { ButlerRole };
