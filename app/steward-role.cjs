'use strict';
// The one session the person designated as the butler they talk to (大管家), for all of NAW. A record only: it
// names which session sits at the top of the sidebar and where the window lands when the app starts, and whose
// calls main.cjs treats as the butler's (stewardCaller: adding, cancelling and resolving queue items, steward step 2
// batch 4). It grants no tools of its own. Only the person sets or clears it. After a session rotation the record
// follows the written log to the successor, by the same rules as the queue secretary and the integrator; the code
// below is the integrator's record (integrator-role.cjs) with its own file and its own error, kept apart so that
// neither role can write the other's record.
// This is not the built-in butler instance of butler-role.cjs, which stays behind its own closed switch.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { uiError } = require('./ui-errors.cjs');
const { successor } = require('./queue-secretary.cjs');

const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 100 && !/[\u0000-\u001f\u007f]/u.test(value);
// The duty statement the person last chose to send the butler (steward step 2, batch 4; the activation checklist,
// item 6): a prompt, not a permission. Absent means the default text of the person's language. Bounded in bytes so the
// whole file stays under the 4096 bytes every build reads (an older build takes a longer file for a broken record).
const DUTY_MAX = 3200, RECORD_MAX = 4096;
const validDuty = value => typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(JSON.stringify(value)) <= DUTY_MAX && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
function identity(value) {
  if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'nativeId,sessionId' || !validId(value.sessionId) || !validId(value.nativeId)) throw Error('Invalid steward identity');
  return { sessionId: value.sessionId, nativeId: value.nativeId };
}
function readPrivate(file, limit) {
  // Open first, then judge what was opened: a link is refused and nothing can be swapped in between.
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || stat.mode & 0o077 || stat.size > limit) throw Error('Unsafe steward record');
    return fs.readFileSync(fd, 'utf8');
  } finally { fs.closeSync(fd); }
}

class StewardRole {
  constructor(directory) {
    this.file = path.join(directory, 'steward.json');
    this.logFile = path.join(directory, 'rotation-log.jsonl');
    this.selected = null;
    this.duty = null;
    this.failed = false;
    try {
      const data = JSON.parse(readPrivate(this.file, RECORD_MAX));
      if (data.version !== 1 || !Object.hasOwn(data, 'selected') || Object.hasOwn(data, 'duty') && !validDuty(data.duty)) throw Error('Invalid steward record');
      this.selected = data.selected === null ? null : identity(data.selected);
      this.duty = data.duty ?? null;
    } catch (error) { if (error.code !== 'ENOENT') this.failed = true; }
  }
  // The designated session as it is now: the one selected, or its successor after rotations.
  // A record that cannot be read gives an error, never "nobody": a caller must not take a
  // broken record for a missing designation.
  current() {
    if (this.failed) throw uiError('error.steward.state');
    if (!this.selected) return null;
    let entries = [];
    try {
      const text = readPrivate(this.logFile, 32 * 1024 * 1024);
      entries = text.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
    } catch (error) { if (error.code !== 'ENOENT') throw uiError('error.steward.state'); }
    return successor(this.selected, entries);
  }
  set(value, duty = this.duty) {
    const selected = value === null ? null : identity(value);
    if (duty !== null && !validDuty(duty)) throw uiError('error.steward.dutyInvalid');
    // The ids are bounded in characters, and JSON writes a lone surrogate as six bytes: the whole file is what counts.
    const body = JSON.stringify({ version: 1, selected, ...(duty === null ? {} : { duty }) });
    if (Buffer.byteLength(body) > RECORD_MAX) throw uiError('error.steward.dutyInvalid');
    const temp = `${this.file}.${randomUUID()}.tmp`;
    let fd;
    try {
      fd = fs.openSync(temp, 'wx', 0o600);
      fs.writeFileSync(fd, body);
      fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(temp, this.file);
      const directory = fs.openSync(path.dirname(this.file), 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    } catch { this.failed = true; throw uiError('error.steward.state'); }
    finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temp); } catch {} }
    this.selected = selected;
    this.duty = duty;
    this.failed = false;
  }
}
module.exports = { StewardRole, DUTY_MAX, validDuty };
