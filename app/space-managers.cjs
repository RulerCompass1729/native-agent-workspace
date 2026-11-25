'use strict';
// The project manager (项目经理) of each collaboration space: at most one session per space, and one space per
// session. Only the person designates it (main.cjs); it may add to that space's queue and reads that space only.
// After a session rotation the record follows the written log to the one clear successor, by the same rules as the
// butler's and the integrator's. A record that cannot be read is an error, never "nobody".
// It took the place of the one secretary for all of NAW (queue-secretary.cjs), whose file it reads once and never writes.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { uiError } = require('./ui-errors.cjs');
const { roomId: validRoomId, roomIds, isMember } = require('./collaboration-spaces.cjs');
const { successor, rotationEdges, usableRecord } = require('./queue-secretary.cjs');

const RECORD_MAX = 256 * 1024;
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 100 && !/[\u0000-\u001f\u007f]/u.test(value);
const plain = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function identity(value) {
  if (!plain(value) || Object.keys(value).sort().join(',') !== 'nativeId,sessionId' || !validId(value.sessionId) || !validId(value.nativeId)) {
    throw Error('Invalid manager identity');
  }
  return { sessionId: value.sessionId, nativeId: value.nativeId };
}

function readPrivate(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || stat.mode & 0o077 || stat.size > RECORD_MAX) {
      throw Error('Unsafe manager record');
    }
    return fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function parse(text) {
  const data = JSON.parse(text);
  const retired = data?.secretaryRetired;
  if (!plain(data) || data.version !== 1 || !plain(data.managers) ||
      retired !== null && (!plain(retired) || Object.keys(retired).join(',') !== 'roomId' || retired.roomId !== null && !validRoomId(retired.roomId))) {
    throw Error('Invalid manager record');
  }
  const managers = new Map();
  for (const [roomId, value] of Object.entries(data.managers)) {
    if (!validRoomId(roomId)) {
      throw Error('Invalid manager record');
    }
    managers.set(roomId, value === null ? null : identity(value));
  }
  return { managers, secretaryRetired: retired };
}

class SpaceManagers {
  constructor(directory) {
    this.file = path.join(directory, 'space-managers.json');
    this.logFile = path.join(directory, 'rotation-log.jsonl');
    // Space → its manager. Until the former secretary is retired, null for a space the person left without one.
    this.managers = new Map();
    // null until the former secretary was retired; then the space it became the manager of, if any.
    this.secretaryRetired = null;
    this.read();
  }
  read() {
    this.failed = false;
    try {
      Object.assign(this, parse(readPrivate(this.file)));
    } catch (error) {
      this.failed = error.code !== 'ENOENT';
    }
  }
  // Each space's designated session as it is now. Two spaces naming the same session is no one's role.
  all() {
    if (this.failed) {
      throw uiError('error.manager.state');
    }
    let entries = [];
    if (this.managers.size) {
      try {
        entries = rotationEdges(this.logFile);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          throw uiError('error.manager.state');
        }
      }
    }
    const current = new Map();
    for (const [roomId, selected] of this.managers) {
      if (selected) {
        current.set(roomId, successor(selected, entries));
      }
    }
    return current;
  }
  current(roomId) {
    return this.all().get(roomId) || null;
  }
  // The space this native session was designated for, whether or not it is a member now.
  designated(actor) {
    if (!actor) {
      return null;
    }
    const found = [];
    for (const [roomId, value] of this.all()) {
      if (value.sessionId === actor.id && value.nativeId === actor.nativeId) {
        found.push(roomId);
      }
    }
    return found.length === 1 ? found[0] : null;
  }
  // The space this session manages now, or null: the role counts only while the session is in that space.
  roomOf(record) {
    const roomId = this.designated(record);
    return roomId && isMember(record, roomId) ? roomId : null;
  }
  // Who is told what a new version brought: the manager of the space the former secretary went to, as it is now.
  versionReceiver() {
    const roomId = this.secretaryRetired?.roomId;
    return roomId ? this.current(roomId) : null;
  }
  // Every session that manages a space now.
  activeIds(sessions) {
    return new Set(sessions.filter(session => this.roomOf(session)).map(session => session.id));
  }
  // Only the manager of this very space adds here, and never for a manager: no item one adds can come back to it,
  // directly or through another space's manager.
  creator(actor, roomId, assignee, records, labels) {
    const record = usableRecord(actor, records);
    if (!record || this.roomOf(record) !== roomId) {
      throw uiError('error.queue.managerOnly');
    }
    if (assignee !== null && this.activeIds(records).has(assignee)) {
      throw uiError('error.queue.managerSelf');
    }
    return { kind: 'secretary', name: labels.get(record.id) || record.name, sessionId: record.id };
  }
  // `reset`: the person agreed to start over from a record that cannot be read, which drops every other space's manager.
  set(roomId, value, { reset = false } = {}) {
    if (!validRoomId(roomId)) {
      throw Error('Invalid manager space');
    }
    if (this.failed && !reset) {
      throw uiError('error.manager.state');
    }
    const selected = value === null ? null : identity(value);
    const managers = new Map(this.managers);
    if (selected) {
      for (const [other, now] of this.failed ? [] : this.all()) {
        if (now.sessionId === selected.sessionId) {
          managers.set(other, null);
        }
      }
    }
    managers.set(roomId, selected);
    if (!this.failed) {
      this.save(managers, this.secretaryRetired);
      return;
    }
    // The unreadable record is kept aside, and the former secretary is not handed a space a second time.
    const aside = `${this.file}.damaged-${randomUUID()}`;
    try {
      fs.linkSync(this.file, aside);
    } catch {
      throw uiError('error.manager.save');
    }
    try {
      this.save(managers, { roomId: null });
    } catch (error) {
      try {
        fs.unlinkSync(aside);
      } catch {}
      throw error;
    }
  }
  // Once: the former secretary becomes the manager of the one live space it is in; in none or in several, it is only
  // retired. `waiting` while it or one of its spaces cannot be told yet: not listed, stopped, or its backend away.
  retireSecretary(secretary, sessions, rooms) {
    if (this.failed) {
      throw uiError('error.manager.state');
    }
    if (this.secretaryRetired) {
      return { status: 'done' };
    }
    if (!secretary) {
      this.save(this.managers, { roomId: null });
      return { status: 'retired', roomId: null };
    }
    const record = sessions.find(session => session.id === secretary.sessionId);
    const listed = record ? roomIds(record).map(id => rooms.find(room => room.id === id)) : [];
    const usable = usableRecord({ id: secretary.sessionId, nativeId: secretary.nativeId }, sessions);
    const stopped = record && !record.archived && (record.nativeContextPending || ['ended', 'background'].includes(record.state));
    if (!record || stopped || listed.some(room => !room || room.unavailable)) {
      return { status: 'waiting' };
    }
    const spaces = listed.filter(room => !room.archived).map(room => room.id);
    const roomId = usable && spaces.length === 1 && !this.managers.has(spaces[0]) ? spaces[0] : null;
    const managers = new Map(this.managers);
    if (roomId) {
      managers.set(roomId, identity(secretary));
    }
    this.save(managers, { roomId });
    return { status: 'retired', roomId, name: record.name, sessionId: record.id };
  }
  save(next, secretaryRetired) {
    const managers = new Map([...next].filter(([, value]) => value || !secretaryRetired));
    const body = JSON.stringify({ version: 1, managers: Object.fromEntries(managers), secretaryRetired });
    if (Buffer.byteLength(body) > RECORD_MAX) {
      throw uiError('error.manager.save');
    }
    const temp = `${this.file}.${randomUUID()}.tmp`;
    let fd;
    try {
      fd = fs.openSync(temp, 'wx', 0o600);
      fs.writeFileSync(fd, body);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(temp, this.file);
    } catch {
      // The record on disk and the one held here are as they were.
      throw uiError('error.manager.save');
    } finally {
      if (fd !== undefined) {
        fs.closeSync(fd);
      }
      try {
        fs.unlinkSync(temp);
      } catch {}
    }
    this.managers = managers;
    this.secretaryRetired = secretaryRetired;
    this.failed = false;
    try {
      const directory = fs.openSync(path.dirname(this.file), 'r');
      try {
        fs.fsyncSync(directory);
      } finally {
        fs.closeSync(directory);
      }
    } catch { /* Saved; only its surviving a power cut is not certain. */ }
  }
}

// Which of NAW's sessions this one is shown: a space's manager, its own space's members. For a record that cannot be
// read, a session in a space is shown only the sessions it shares a space with; one in no space manages nothing.
function visibleTo(directory, session) {
  const own = roomIds(session);
  if (!own.length) {
    return () => true;
  }
  let within = own;
  try {
    const roomId = new SpaceManagers(directory).roomOf(session);
    if (!roomId) {
      return () => true;
    }
    within = [roomId];
  } catch {}
  return other => {
    if (other.id === session.id) {
      return true;
    }
    try {
      return within.some(id => isMember(other, id));
    } catch {
      return false;
    }
  };
}

// Whether this session may be a space's manager: all that can be told without its record.
function mayManage(directory, id) {
  try {
    return [...new SpaceManagers(directory).all().values()].some(value => value.sessionId === id);
  } catch {
    return true;
  }
}

// The space that keeps this sender's messages from its manager, or null. The person, 2026-11-23: 「保证不会让项目经理被
// 其他空间的任务干扰」: a session in another space is refused; one in no space (the butler, an integrator) is not.
function refusedSpace(managers, sender, recipient) {
  const own = roomIds(sender), theirs = roomIds(recipient);
  if (!own.length || !theirs.length) {
    return null;
  }
  let roomId;
  try {
    roomId = managers.roomOf(recipient);
  } catch (error) {
    if (theirs.every(id => own.includes(id))) {
      return null;
    }
    throw error;
  }
  return roomId && !own.includes(roomId) ? roomId : null;
}

module.exports = { SpaceManagers, visibleTo, mayManage, refusedSpace };
