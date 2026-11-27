// Person-owned permission for reversible local organization. No native controls,
// reads, file operations or external actions are covered by this policy.
// The designated butler may switch it too, but once the person turned it off only the person turns it on (R234).
const fs = require('node:fs'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const { roomIds } = require('./collaboration-spaces.cjs');
const HOUR = 3600000, LIMIT = 30, SWITCHES = 15;
const CREATION_OBSERVATION_MAX_AGE_MS = 60000;
const same = (a, b) => Boolean(a && b && a.sessionId === b.sessionId && a.nativeId === b.nativeId);
const localAction = command => {
  if (command.method === 'create' && Object.hasOwn(command.arguments?.[0] ?? {}, 'initialMessage')) return null;
  if (command.method === 'spaceManager' && command.arguments?.length === 2 && typeof command.arguments[1] === 'string') return command.method;
  if (['create', 'spaceCreate', 'join', 'rename', 'roomRename', 'archiveSession', 'restoreSession', 'archiveRoom', 'restoreRoom', 'roomMemberOrder'].includes(command.method)) return command.method;
  if (command.method === 'spaceAction' && ['join', 'rename', 'archive', 'restore', 'memberOrder'].includes(command.arguments?.[1])) return command.arguments[1];
  return null;
};
// Native defaults and named Codex profiles depend on directory configuration.
// Only an explicit permission mode can be compared without guessing that config.
function creationCovered(options, peers, now = Date.now()) {
  if (!options || options.fork != null || options.gitWorktree != null || options.settings?.profile) return false;
  const mode = options.skipPermissions === true ? 'bypassPermissions' : options.settings?.permissionMode;
  if (!['claude', 'codex'].includes(options.provider)) return false;
  // Explicit cost settings must match current native observations, not old launch requests.
  // An omitted value keeps the person's provider default; no price inference is made.
  const settingMatches = (key, peer) => {
    if (options.settings?.[key] === undefined) return true;
    const settings = peer.nativeCreationSettings, observed = settings?.[key];
    return typeof options.settings[key] === 'string' && !!observed?.value && options.settings[key] === observed.value &&
      typeof peer.nativeId === 'string' && settings.nativeId === peer.nativeId &&
      Number.isSafeInteger(settings.controlRevision) && settings.controlRevision >= 0 && settings.controlRevision === (peer.controlRevision ?? 0) &&
      Number.isSafeInteger(observed.observedAt) && observed.observedAt >= 0 && now >= observed.observedAt &&
      now - observed.observedAt <= CREATION_OBSERVATION_MAX_AGE_MS;
  };
  if (options.provider === 'codex') {
    // Only this existing launch option pins both permissions explicitly. Native
    // defaults, named profiles and narrower/custom sandboxes are not inferred.
    if (options.skipPermissions !== true) return false;
    return peers.some(p => {
      const observed = p.nativeCreationSettings, permission = observed?.permissions;
      return p.provider === 'codex' && !p.archived && !p.nativeContextPending &&
        typeof p.nativeId === 'string' && observed?.nativeId === p.nativeId &&
        Number.isSafeInteger(observed.controlRevision) && observed.controlRevision >= 0 && observed.controlRevision === (p.controlRevision ?? 0) &&
        permission?.modelProvider === 'openai' && permission.approvalPolicy === 'never' && permission.sandboxMode === 'dangerFullAccess' &&
        Number.isSafeInteger(permission.observedAt) && permission.observedAt >= 0 && now >= permission.observedAt &&
        now - permission.observedAt <= CREATION_OBSERVATION_MAX_AGE_MS &&
        settingMatches('model', p) && settingMatches('effort', p);
    });
  }
  return peers.some(p => p.provider === options.provider && !p.archived &&
    settingMatches('model', p) && settingMatches('effort', p) &&
    ((p.nativePermissionMode ? p.nativePermissionMode === 'bypassPermissions' : p.skipPermissions === true)
      ? mode === 'bypassPermissions' || options.provider === 'claude' && ['plan', 'default', 'acceptEdits', 'dontAsk', 'auto'].includes(mode)
      : options.provider === 'claude' && mode && mode === p.nativePermissionMode && options.newDirectory !== true &&
        typeof options.cwd === 'string' && typeof p.cwd === 'string' && path.resolve(options.cwd) === path.resolve(p.cwd)));
}
// What a file that is not there reads as: nobody switched it, and nobody turned it off.
const NOBODY = Object.freeze({ by: 'nobody' });
// Who switched it last ({ by, at }). Tied to the revision: a NAW that does not write it leaves nothing that still holds.
const switched = s => Number.isSafeInteger(s.source?.at) && s.source.revision === s.revision ? s.source : null;
const personOff = s => !s.on && s.source !== NOBODY && switched(s)?.by !== 'butler';
const switchRows = s => (Array.isArray(s.switches) ? s.switches : []).filter(x => x && typeof x.on === 'boolean' && ['person', 'butler'].includes(x.by) &&
  Number.isSafeInteger(x.at) && Number.isSafeInteger(x.revision)).map(({ revision, on, by, at }) => ({ revision, on, by, at })).slice(-SWITCHES);
// Everything the permission requires of one action, given the permission state s. Not exported: only authorized()
// passes the state as read, and fallback() only the designation the person has now.
function covered(policy, s, actor, command, state, roomId) {
  const current = policy.role.current();
  if (!s.on || !same(s.designation, policy.role.selected) || !same(current, { sessionId: actor.id, nativeId: actor.nativeId }) || !localAction(command)) return null;
  const owner = state.sessions.find(x => x.id === actor.id && x.nativeId === actor.nativeId && !x.archived && !x.nativeContextPending);
  if (!owner || roomIds(owner).length) return null;
  if (command.method === 'create' && !creationCovered(command.arguments[0], state.sessions.filter(x => roomIds(x).includes(roomId)), policy.now())) return null;
  return s;
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
    } catch (e) { if (e.code === 'ENOENT') return { version: 1, on: false, revision: 0, designation: null, used: [], source: NOBODY }; throw e; }
  }
  write(value) {
    const temp = this.file + '.' + randomUUID() + '.tmp'; let fd;
    try {
      fd = fs.openSync(temp, 'wx', 0o600); fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(temp, this.file); const dir = fs.openSync(path.dirname(this.file), 'r');
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    } finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temp); } catch {} }
  }
  // On for an earlier designation reads off, with why: the person designated another butler since (R118).
  view() {
    try {
      const s = this.read(), on = s.on && same(s.designation, this.role.selected);
      // With nobody designated there is no one to turn it on for again.
      const other = s.on && !on && Boolean(this.role.selected);
      const by = on === s.on ? switched(s) : null;
      return { on, limit: LIMIT, unavailable: false, ...(other ? { reason: 'other-designation' } : {}), ...(by?.by === 'butler' ? { by: 'butler', at: by.at } : {}) };
    } catch { return { on: false, limit: LIMIT, unavailable: true }; }
  }
  // Why the current butler's action asks instead: it would be covered, within the hourly limit, had the permission
  // been turned on for the current designation, so turning it on again fixes it. A code only.
  fallback(actor, command, state, roomId) {
    try {
      const s = this.read();
      if (!s.on || !this.role.selected || same(s.designation, this.role.selected)) return null;
      if (!covered(this, { ...s, designation: this.role.selected }, actor, command, state, roomId)) return null;
      const now = this.now();
      if (s.used.filter(x => x.at > now - HOUR).length >= LIMIT) return null;
      return 'standing-other-designation';
    } catch { return null; }
  }
  // The last switches, oldest first, for the bell. Kept with the state they made: a switch cannot be without its line.
  // A file that cannot be read is not one without switches: the rows last read, and known false.
  switches() {
    try { return { rows: this.rows = switchRows(this.read()), known: true }; }
    catch { return { rows: this.rows ?? [], known: false }; }
  }
  // An error after the file was replaced (its directory could not be synced) is not a failed switch: what the file says
  // now decides. Neither known: STEWARD_STANDING_UNKNOWN.
  save(value) {
    try { this.write(value); }
    catch (error) {
      let revision; try { revision = this.read().revision; } catch { throw Object.assign(Error('Standing permission could not be read back'), { code: 'STEWARD_STANDING_UNKNOWN', cause: error }); }
      if (revision !== value.revision) throw error;
    }
  }
  change(s, on, by) {
    const at = this.now(), revision = s.revision + 1;
    this.save({ ...s, on, designation: this.role.selected, revision, source: { by, at, revision }, switches: [...switchRows(s), { revision, on, by, at }].slice(-SWITCHES) });
  }
  set(context, on) {
    if (!this.person(context) || typeof on !== 'boolean') throw Error('Only the current person window can change standing permission');
    const current = this.role.current();
    if (on && !current) throw Error('Choose a butler first');
    this.change(this.read(), on, 'person');
    return this.view();
  }
  // The butler's own switch (main.cjs stewardStanding, after stewardCaller). It is for the person's designation, as the
  // person's is. What already stands is left as it is: who turned it on, the person's off, and grants in use.
  setByButler(actor, on) {
    if (typeof on !== 'boolean' || !same(this.role.current(), { sessionId: actor?.id, nativeId: actor?.nativeId })) throw Error('Only the current butler can change standing permission here');
    const s = this.read();
    if (on && personOff(s)) throw Object.assign(Error('The person turned standing permission off'), { code: 'STEWARD_STANDING_PERSON_OFF' });
    const changed = s.on !== on || on && !same(s.designation, this.role.selected);
    if (changed) this.change(s, on, 'butler');
    return { ...this.view(), changed };
  }
  // The person designates another butler (main.cjs steward): asked before the designation moves, null unless they have
  // it on for the butler being replaced, or were asked and took it back (`standing` false: the butler may have turned it
  // off since, which is not the person's off). The step returned, after it moved, puts it on for the new one, or turns
  // it off; true when that was the person's off.
  carry(context, standing = null) {
    if (!this.person(context) || standing !== false && !this.view().on) return null;
    return keep => {
      const s = this.read();
      if (!keep) { if (personOff(s)) return; this.change(s, false, 'person'); return true; }
      if (!s.on || same(s.designation, this.role.selected)) return;
      const by = switched(s), revision = s.revision + 1;
      this.save({ ...s, designation: this.role.selected, revision, ...(by ? { source: { ...by, revision } } : {}) });
    };
  }
  authorized(actor, command, state, roomId) {
    return covered(this, this.read(), actor, command, state, roomId);
  }
  take(actor, command, state, roomId) {
    let s; try { s = this.authorized(actor, command, state, roomId); } catch { return null; }
    if (!s) return null;
    const now = this.now(), used = s.used.filter(x => x.at > now - HOUR); // Future timestamps consume slots after clock rollback.
    if (used.length >= LIMIT) return null;
    const names = require('./background-operation.cjs'), summary = names.operationSummary(command, actor, state);
    const target = state.sessions.find(x => x.id === command.arguments?.[0]);
    const before = { name: target?.name, rooms: target ? roomIds(target) : [], room: state.rooms?.find(x => x.id === roomId)?.name, order: state.rooms?.find(x => x.id === roomId)?.memberOrder || [] };
    // These are the requested settings; null explicitly means the person's native default.
    const creation = command.method === 'create' ? { model: command.arguments[0].settings?.model ?? null,
      effort: command.arguments[0].settings?.effort ?? null } : undefined;
    this.write({ ...s, used: [...used, { at: now, id: actor.nativeId + ':' + command.operation_id, ...(creation ? { creation } : {}) }] });
    return { revision: s.revision, action: localAction(command), summary, before, ...(creation ? { creation } : {}) };
  }
  valid(actor, command, state, roomId, grant) {
    try { return this.authorized(actor, command, state, roomId)?.revision === grant.revision; } catch { return false; }
  }
}
module.exports = { StewardStanding, creationCovered, localAction, LIMIT, CREATION_OBSERVATION_MAX_AGE_MS };
