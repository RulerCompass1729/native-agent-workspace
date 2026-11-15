// Person-owned permission for reversible local organization. No native controls,
// reads, file operations or external actions are covered by this policy.
const fs = require('node:fs'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const { roomIds } = require('./collaboration-spaces.cjs');
const HOUR = 3600000, LIMIT = 30;
const same = (a, b) => Boolean(a && b && a.sessionId === b.sessionId && a.nativeId === b.nativeId);
const localAction = command => {
  if (['create', 'spaceCreate', 'join', 'rename', 'roomRename', 'archiveSession', 'restoreSession', 'archiveRoom', 'restoreRoom', 'roomMemberOrder'].includes(command.method)) return command.method;
  if (command.method === 'spaceAction' && ['join', 'rename', 'archive', 'restore', 'memberOrder'].includes(command.arguments?.[1])) return command.arguments[1];
  return null;
};
// Native defaults and named Codex profiles depend on directory configuration.
// Only an explicit permission mode can be compared without guessing that config.
function creationCovered(options, peers) {
  if (!options || options.gitWorktree != null || options.settings?.profile) return false;
  const mode = options.skipPermissions === true ? 'bypassPermissions' : options.settings?.permissionMode;
  if (!['claude', 'codex'].includes(options.provider)) return false;
  return peers.some(p => p.provider === options.provider && !p.archived &&
    (p.skipPermissions === true || p.nativePermissionMode === 'bypassPermissions'
      ? mode === 'bypassPermissions' || options.provider === 'claude' && ['plan', 'default', 'acceptEdits', 'dontAsk', 'auto'].includes(mode)
      : options.provider === 'claude' && mode && mode === p.nativePermissionMode));
}
class StewardStanding {
  constructor(directory, { role, person, now = Date.now }) {
    this.file = path.join(directory, 'steward-standing.json'); Object.assign(this, { role, person, now });
  }
  read() {
    try {
      const fd = fs.openSync(this.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const s = fs.fstatSync(fd);
        if (!s.isFile() || s.nlink !== 1 || s.uid !== process.getuid() || s.mode & 0o077 || s.size > 16384) throw Error('Unsafe standing permission');
        const v = JSON.parse(fs.readFileSync(fd, 'utf8'));
        if (v.version !== 1 || typeof v.on !== 'boolean' || !Number.isSafeInteger(v.revision) || v.revision < 0 || !Array.isArray(v.used) || v.used.length > LIMIT ||
            v.used.some(x => !Number.isSafeInteger(x.at) || typeof x.id !== 'string') || v.on && (!v.designation?.sessionId || !v.designation?.nativeId)) throw Error('Invalid standing permission');
        return v;
      } finally { fs.closeSync(fd); }
    } catch (e) { if (e.code === 'ENOENT') return { version: 1, on: false, revision: 0, designation: null, used: [] }; throw e; }
  }
  write(value) {
    const temp = this.file + '.' + randomUUID() + '.tmp'; let fd;
    try {
      fd = fs.openSync(temp, 'wx', 0o600); fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(temp, this.file); const dir = fs.openSync(path.dirname(this.file), 'r');
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    } finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temp); } catch {} }
  }
  view() {
    try { const s = this.read(); return { on: s.on && same(s.designation, this.role.selected), limit: LIMIT, unavailable: false }; }
    catch { return { on: false, limit: LIMIT, unavailable: true }; }
  }
  set(context, on) {
    if (!this.person(context) || typeof on !== 'boolean') throw Error('Only the current person window can change standing permission');
    const current = this.role.current();
    if (on && !current) throw Error('Choose a butler first');
    const s = this.read();
    this.write({ ...s, on, designation: this.role.selected, revision: s.revision + 1 });
    return this.view();
  }
  authorized(actor, command, state, roomId) {
    const s = this.read(), current = this.role.current();
    if (!s.on || !same(s.designation, this.role.selected) || !same(current, { sessionId: actor.id, nativeId: actor.nativeId }) || !localAction(command)) return null;
    const owner = state.sessions.find(x => x.id === actor.id && x.nativeId === actor.nativeId && !x.archived && !x.nativeContextPending);
    if (!owner || roomIds(owner).length) return null;
    if (command.method === 'create' && !creationCovered(command.arguments[0], state.sessions.filter(x => roomIds(x).includes(roomId)))) return null;
    return s;
  }
  take(actor, command, state, roomId) {
    let s; try { s = this.authorized(actor, command, state, roomId); } catch { return null; }
    if (!s) return null;
    const now = this.now(), used = s.used.filter(x => x.at > now - HOUR); // Future timestamps consume slots after clock rollback.
    if (used.length >= LIMIT) return null;
    const names = require('./background-operation.cjs'), summary = names.operationSummary(command, actor, state);
    const target = state.sessions.find(x => x.id === command.arguments?.[0]);
    const before = { name: target?.name, rooms: target ? roomIds(target) : [], room: state.rooms?.find(x => x.id === roomId)?.name, order: state.rooms?.find(x => x.id === roomId)?.memberOrder || [] };
    this.write({ ...s, used: [...used, { at: now, id: actor.nativeId + ':' + command.operation_id }] });
    return { revision: s.revision, action: localAction(command), summary, before };
  }
  valid(actor, command, state, roomId, grant) {
    try { return this.authorized(actor, command, state, roomId)?.revision === grant.revision; } catch { return false; }
  }
}
module.exports = { StewardStanding, creationCovered, localAction, LIMIT };
