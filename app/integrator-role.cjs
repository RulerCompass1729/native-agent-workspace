'use strict';
// The one session the person designated as integrator, for all of NAW. The record names who
// receives integration handoffs and nothing else: it grants no tools, no queue powers and no
// permission. Only the person sets or clears it. After a session rotation the record follows
// the written log to the successor, by the same rules as the queue secretary.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { uiError } = require('./ui-errors.cjs');
const { successor, rotationEdges } = require('./queue-secretary.cjs');

const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 100 && !/[\u0000-\u001f\u007f]/u.test(value);
function identity(value) {
  if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'nativeId,sessionId' || !validId(value.sessionId) || !validId(value.nativeId)) throw Error('Invalid integrator identity');
  return { sessionId: value.sessionId, nativeId: value.nativeId };
}
function readPrivate(file, limit) {
  // Open first, then judge what was opened: a link is refused and nothing can be swapped in between.
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || stat.mode & 0o077 || stat.size > limit) throw Error('Unsafe integrator record');
    return fs.readFileSync(fd, 'utf8');
  } finally { fs.closeSync(fd); }
}

class IntegratorRole {
  constructor(directory) {
    this.file = path.join(directory, 'integrator.json');
    this.logFile = path.join(directory, 'rotation-log.jsonl');
    this.selected = null;
    this.failed = false;
    try {
      const data = JSON.parse(readPrivate(this.file, 4096));
      if (data.version !== 1 || !Object.hasOwn(data, 'selected')) throw Error('Invalid integrator record');
      this.selected = data.selected === null ? null : identity(data.selected);
    } catch (error) { if (error.code !== 'ENOENT') this.failed = true; }
  }
  // The designated session as it is now: the one selected, or its successor after rotations.
  // A record that cannot be read gives an error, never "nobody": a caller must not take a
  // broken record for a missing designation.
  current() {
    if (this.failed) throw uiError('error.integrator.state');
    if (!this.selected) return null;
    let entries = [];
    try {
      entries = rotationEdges(this.logFile);
    } catch (error) { if (error.code !== 'ENOENT') throw uiError('error.integrator.state'); }
    return successor(this.selected, entries);
  }
  set(value) {
    const selected = value === null ? null : identity(value);
    const temp = `${this.file}.${randomUUID()}.tmp`;
    let fd;
    try {
      fd = fs.openSync(temp, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ version: 1, selected }));
      fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(temp, this.file);
      const directory = fs.openSync(path.dirname(this.file), 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    } catch { this.failed = true; throw uiError('error.integrator.state'); }
    finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temp); } catch {} }
    this.selected = selected;
    this.failed = false;
  }
}
module.exports = { IntegratorRole };
