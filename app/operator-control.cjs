// One Workspace owns this journal. Native tools supply no caller identity,
// version or permission. No delivery, model invocation or retry lives here.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const spaces = require('./collaboration-spaces.cjs');
const { uiNotice } = require('./ui-errors.cjs');

const CAPABILITY = 'operatorControl1a';
const STATES = ['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped'];
const names = ['workspace_sessions', 'workspace_open', 'workspace_report'];
const string = (max = 160) => ({ type: 'string', minLength: 1, maxLength: max });
const tools = [
  { name: names[0], description: 'Read local top-level session metadata and authorized requests. No private conversation text. Does not deliver messages.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: names[1], description: 'Create at most one native session per action_id under an explicit human grant. Creation only: the initial task remains pending delivery. No model selection or inherited general control.',
    inputSchema: { type: 'object', properties: { action_id: string(), provider: { enum: ['claude', 'codex'] }, cwd: string(4096), name: string(60), view: { enum: ['chat', 'terminal'] }, task: string(8000), permission: { enum: ['default', 'bypass'] }, grant_id: string() }, required: ['action_id', 'provider', 'cwd', 'task', 'permission'], additionalProperties: false } },
  { name: names[2], description: 'Durably save a report for your immutable dispatch. A report does not finish a request or deliver a notification. question: string asks the person, null withdraws, omission preserves; ready clears and cannot include question.',
    inputSchema: { type: 'object', properties: { request_id: string(), dispatch_id: string(), state: { enum: STATES }, body: string(8000), question: { anyOf: [string(2000), { type: 'null' }] } }, required: ['request_id', 'dispatch_id', 'state', 'body'], additionalProperties: false } },
];
const fail = message => { throw Error(message); };
function text(value, max, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value)) fail(`Invalid ${label}`);
  return value; // In particular, never trim/rewrite a question or report.
}
function validate(name, args) {
  const tool = tools.find(t => t.name === name);
  if (!tool || !args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k => !Object.hasOwn(tool.inputSchema.properties, k))) fail('Invalid operator tool arguments');
  for (const key of tool.inputSchema.required || []) if (!Object.hasOwn(args, key)) fail(`Missing ${key}`);
  for (const key of ['request_id', 'dispatch_id', 'action_id', 'grant_id']) if (args[key] !== undefined) text(args[key], 160, key);
  if (name === names[1]) {
    if (!['claude', 'codex'].includes(args.provider) || !['default', 'bypass'].includes(args.permission)) fail('Invalid provider or permission');
    if (args.view !== undefined && !['chat', 'terminal'].includes(args.view)) fail('Invalid view');
    text(args.cwd, 4096, 'directory'); if (!path.isAbsolute(args.cwd)) fail('An absolute existing directory is required');
    text(args.task, 8000, 'task'); if (args.name !== undefined) text(args.name, 60, 'name');
  }
  if (name === names[2]) {
    if (!STATES.includes(args.state)) fail('state must be progress, waiting, ready, blocked, failed or dropped');
    text(args.body, 8000, 'report body');
    if (Object.hasOwn(args, 'question')) { if (args.state === 'ready') fail('ready cannot include question'); if (args.question !== null) text(args.question, 2000, 'question'); }
  }
  return args;
}
const initial = () => ({ version: 1, sequence: 0, enabled: false, sessions: {}, domains: {}, requests: {}, dispatches: {}, actions: {}, reports: {}, calls: {}, audit: [] });
const copy = value => JSON.parse(JSON.stringify(value));
// B5: whether the person had given this grant by the time a replacement was logged. A grant with no time of
// its own cannot be shown to have been there.
const givenBy = (domain, at) => Number.isSafeInteger(domain.createdAt) && domain.createdAt <= at;
const day = at => new Date(at).toISOString().slice(0, 10);
const actualModel = s => s?.model && s.modelUiMessage?.key !== 'notice.model.nativeDefault' ? s.model : null;
const permission = s => s?.nativePermissionMode === 'bypassPermissions' ? 'bypass' : ['default', 'acceptEdits'].includes(s?.nativePermissionMode) ? 'default' : 'unknown';
const within = (cwd, root) => cwd === root || cwd.startsWith(root + path.sep);
const sessionMetadata = s => {
  const observed = !s.transportDisconnected && !s.backendUnavailable && !s.nativeContextPending && ['starting', 'idle', 'working', 'approval', 'stopping', 'background', 'error'].includes(s.state);
  return { id: s.id, name: s.name, provider: s.provider, state: observed ? s.state : 'unknown',
    canReport: Boolean(observed && s.provider === 'claude' && s.operatorAvailable === true) };
};
function insertRows(original, additions) {
  if (!additions.length) return original;
  const pending = [...additions].sort((a, b) => a.time - b.time), result = []; let next = 0;
  // Native source order and imported batch order carry meaning beyond their
  // clocks. Only insert our new records; never sort existing records.
  for (const row of original) {
    if (!row.snapshotBatch && Number.isFinite(row.time)) while (next < pending.length && pending[next].time <= row.time) result.push(pending[next++]);
    result.push(row);
  }
  return result.concat(pending.slice(next));
}
function validateJournal(data) {
  if (data.version !== 1 || ['sessions', 'domains', 'requests', 'dispatches', 'actions', 'reports', 'calls'].some(k => !data[k] || Array.isArray(data[k]) || typeof data[k] !== 'object') || !Array.isArray(data.audit) || typeof data.enabled !== 'boolean' || !Number.isSafeInteger(data.sequence) || data.sequence < 0) fail('Invalid operator journal');
  // B5: what the journal itself writes when a grant follows a replaced session, in exactly these shapes.
  const record = value => value && typeof value === 'object' && !Array.isArray(value);
  const holder = value => record(value) && Object.keys(value).sort().join() === 'id,nativeId' && typeof value.id === 'string' && value.id && typeof value.nativeId === 'string' && value.nativeId;
  const carriedFrom = value => record(value) && Object.keys(value).sort().join() === 'at,id,nativeId' && holder({ id: value.id, nativeId: value.nativeId }) && Number.isSafeInteger(value.at);
  const succession = value => record(value) && Number.isSafeInteger(value.at) && typeof value.carried === 'boolean' && (!Object.hasOwn(value, 'told') || value.told === true) &&
    Object.keys(value).every(k => ['at', 'carried', 'told', value.carried ? 'to' : 'reason'].includes(k)) && (value.carried ? holder(value.to) : typeof value.reason === 'string' && /^[a-z-]{1,60}$/.test(value.reason));
  for (const setting of Object.values(data.sessions)) if (!setting || typeof setting.enabled !== 'boolean' || typeof setting.nativeId !== 'string' ||
    Object.hasOwn(setting, 'enabledAt') && !Number.isSafeInteger(setting.enabledAt) || Object.hasOwn(setting, 'carriedFrom') && !carriedFrom(setting.carriedFrom) ||
    Object.hasOwn(setting, 'succession') && !succession(setting.succession)) fail('Invalid operator setting');
  for (const domain of Object.values(data.domains)) if (domain && Object.hasOwn(domain, 'carried') && (!Array.isArray(domain.carried) || domain.carried.some(c => !record(c) || Object.keys(c).sort().join() !== 'at,from,to' || !holder(c.from) || !holder(c.to) || !Number.isSafeInteger(c.at)))) fail('Invalid operator grant');
  for (const [id, domain] of Object.entries(data.domains)) {
    if (domain?.id !== id || !Array.isArray(domain.initiators) || !domain.initiators.length || domain.initiators.some(i => !i || typeof i.id !== 'string' || typeof i.nativeId !== 'string') ||
      !Array.isArray(domain.providers) || !domain.providers.length || domain.providers.some(p => !['claude', 'codex'].includes(p)) ||
      !Array.isArray(domain.directories) || !domain.directories.length || domain.directories.some(d => typeof d !== 'string' || !path.isAbsolute(d)) ||
      !['default', 'bypass'].includes(domain.permission) || !Number.isSafeInteger(domain.daily) || domain.daily < 1 || !Number.isSafeInteger(domain.concurrent) || domain.concurrent < 1 || !Number.isSafeInteger(domain.expiresAt) ||
      Object.hasOwn(domain, 'quotaRevision') && (!Number.isSafeInteger(domain.quotaRevision) || domain.quotaRevision < 0) ||
      Object.hasOwn(domain, 'quotaUpdatedAt') && !Number.isSafeInteger(domain.quotaUpdatedAt) ||
      // B5: the space a grant names is saved only as a space id; anything else in its place disables the interface.
      Object.hasOwn(domain, 'space') && !spaces.roomId(domain.space)) fail('Invalid operator grant');
  }
  for (const [id, request] of Object.entries(data.requests)) if (request?.id !== id || !Object.hasOwn(data.domains, request.domainId) || typeof request.initiatorId !== 'string' || typeof request.initiatorNativeId !== 'string' || !Number.isSafeInteger(request.version) || request.version < 1 ||
    request.currentDispatchId && (!Object.hasOwn(data.dispatches, request.currentDispatchId) || data.dispatches[request.currentDispatchId].requestId !== id || data.dispatches[request.currentDispatchId].version !== request.version) ||
    request.question != null && typeof request.question !== 'string' || request.closed && !['accepted', 'cancelled'].includes(request.closed.reason)) fail('Invalid operator request');
  for (const [id, dispatch] of Object.entries(data.dispatches)) if (dispatch?.id !== id || !Object.hasOwn(data.requests, dispatch.requestId) || dispatch.domainId !== data.requests[dispatch.requestId].domainId || !Number.isSafeInteger(dispatch.version) || dispatch.version < 1 || typeof dispatch.executorId !== 'string' || dispatch.executorNativeId !== null && typeof dispatch.executorNativeId !== 'string') fail('Invalid operator dispatch');
  for (const [id, report] of Object.entries(data.reports)) {
    const dispatch = data.dispatches[report?.dispatchId];
    if (report?.id !== id || !dispatch || report.requestId !== dispatch.requestId || report.version !== dispatch.version || report.executorId !== dispatch.executorId || report.executorNativeId !== dispatch.executorNativeId ||
      report.initiatorId !== data.requests[report.requestId].initiatorId || !Number.isSafeInteger(report.order) || !Array.isArray(report.roomIds) || report.roomIds.some(id => !spaces.roomId(id))) fail('Invalid saved operator report');
    validate(names[2], { request_id: report.requestId, dispatch_id: report.dispatchId, state: report.state, body: report.body, ...(Object.hasOwn(report, 'question') ? { question: report.question } : {}) });
  }
  for (const [key, action] of Object.entries(data.actions)) {
    validate(names[1], action?.args);
    if (action.key !== key || key !== JSON.stringify([action.initiatorNativeId, action.id]) || action.args.action_id !== action.id || !['pending-authorization', 'authorized', 'creating', 'created', 'unconfirmed', 'not-created', 'cancelled'].includes(action.status) ||
      action.requestId && !Object.hasOwn(data.requests, action.requestId)) fail('Invalid saved operator action');
    // B5: a saved placement result is exactly what placed() writes, for a created session, into the space its grant names.
    const placement = action.placement;
    if (Object.hasOwn(action, 'placement') && (!placement || typeof placement !== 'object' || Array.isArray(placement) || Object.keys(placement).some(k => !['space', 'at', 'joined', 'error'].includes(k)) ||
      !spaces.roomId(placement.space) || !Number.isSafeInteger(placement.at) || typeof placement.joined !== 'boolean' ||
      Object.hasOwn(placement, 'error') && (typeof placement.error !== 'string' || !/^[a-z-]{1,60}$/.test(placement.error)) || !placement.joined && !Object.hasOwn(placement, 'error') ||
      action.status !== 'created' || typeof action.sessionId !== 'string' || data.domains[action.domainId]?.space !== placement.space)) fail('Invalid saved operator action');
  }
  for (const reportId of Object.values(data.calls)) if (!Object.hasOwn(data.reports, reportId)) fail('Invalid operator call receipt');
}

class OperatorControl {
  constructor(workspace) {
    this.w = workspace; this.file = path.join(workspace.dataDir, 'operator-records.json'); this.data = initial(); this.error = null; this.inflight = new Map();
    try {
      const stat = fs.lstatSync(this.file);
      if (!stat.isFile() || stat.mode & 0o077 || process.getuid && stat.uid !== process.getuid()) fail('Unsafe operator journal');
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      validateJournal(saved);
      this.data = saved;
      // Recovery preserves results but never replays an uncertain creation.
      for (const action of Object.values(saved.actions)) if (action.status === 'creating') action.status = 'unconfirmed';
      // B5: a setting turned on before that time was recorded gets it now. Any replacement logged after this
      // moment is certainly later than the turning on, so nothing older can be taken for a replacement of it.
      for (const setting of Object.values(saved.sessions)) if (setting.enabled && !Number.isSafeInteger(setting.enabledAt)) setting.enabledAt = Date.now();
    } catch (error) { if (error.code !== 'ENOENT') this.error = 'Operator records could not be read; the interface is disabled.'; }
  }
  commit(change) {
    if (this.error || this.w.closed || this.w.storageWarning) fail(this.error || 'Workspace storage is unavailable; nothing was saved');
    const next = copy(this.data); next.sequence = (next.sequence || 0) + 1;
    const result = change(next), temp = `${this.file}.${randomUUID()}.tmp`;
    let fd, renamed = false;
    try {
      fd = fs.openSync(temp, 'wx', 0o600); fs.writeFileSync(fd, JSON.stringify(next)); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(temp, this.file); renamed = true;
      const directory = fs.openSync(this.w.dataDir, 'r'); try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    } catch {
      if (fd !== undefined) try { fs.closeSync(fd); } catch { /* owned descriptor */ }
      try { fs.unlinkSync(temp); } catch { /* only this transaction's temporary file */ }
      // A post-rename failure is uncertain, not an acknowledged save. Latch the
      // interface so a caller cannot turn uncertainty into a second side effect.
      this.error = renamed ? 'Operator save outcome is unconfirmed; do not retry. Reopen and inspect the records.' : 'Operator records were not saved; the interface is disabled.';
      this.w.emit('change'); fail(this.error);
    }
    this.data = next; this.w.emit('change'); return result;
  }
  policy() { return { enabled: !this.error && this.data.enabled, error: this.error,
    sessions: copy(this.data.sessions), domains: Object.values(this.data.domains).map(d => ({ ...copy(d), usage: this.quotaUsage(d.id) })), placements: this.placements(), successions: this.successions() }; }
  quotaUsage(domainId) {
    const today = day(Date.now()), reservations = Object.values(this.data.actions).filter(a => a.domainId === domainId && ['creating', 'created', 'unconfirmed'].includes(a.status));
    return { day: today, usedToday: reservations.filter(a => !Number.isSafeInteger(a.startedAt) || !Number.isFinite(new Date(a.startedAt).getTime()) || day(a.startedAt) === today).length,
      concurrent: reservations.filter(a => !a.sessionId || this.w.sessions.get(a.sessionId)?.state !== 'ended').length };
  }
  // B5: a grant may name one space, chosen by the person. A session created under such a grant is
  // listed here until the desktop, which alone owns spaces, has placed it and written the result
  // back. Only while the grant is still in force: revoking it, its expiry, turning the interface
  // off for the initiator or for everyone, or the initiator going away all end a pending placement.
  // Nothing about the task is involved: it stays undelivered, as the tool and the consent text say.
  // (Archiving is the desktop's own list, which this journal does not see; main.cjs placeOpened checks it.)
  placing(action, data = this.data) {
    const domain = data.domains[action.domainId], initiator = this.w.sessions.get(action.initiatorId);
    return Boolean(domain?.space && !domain.revokedAt && domain.expiresAt > Date.now() && data.enabled && initiator && !initiator.archived &&
      this.held(action.initiatorId, data) && data.sessions[action.initiatorId].nativeId === initiator.nativeId && initiator.nativeId === action.initiatorNativeId);
  }
  placements() {
    if (this.error) return [];
    return Object.values(this.data.actions).filter(a => a.status === 'created' && a.sessionId && !a.placement && this.placing(a))
      .map(a => ({ key: a.key, initiatorId: a.initiatorId, sessionId: a.sessionId, space: this.data.domains[a.domainId].space }));
  }
  placeable(key, inForce = true) {
    const action = this.data.actions[key];
    if (!action || action.status !== 'created' || !action.sessionId || !this.data.domains[action.domainId]?.space) fail('No created session waits for a space under this grant');
    if (inForce && !action.placement && !this.placing(action)) fail('The grant that named a space is no longer in force');
    return action;
  }
  // Desktop only (workspace.cjs operatorAction): where this session goes, from the journal that owns the action.
  placement(key) {
    const action = this.placeable(key);
    return { key, space: this.data.domains[action.domainId].space, sessionId: action.sessionId, placed: Boolean(action.placement) };
  }
  // Desktop only: the result of placing it, saved once. A later call cannot change it. It is a statement of
  // what happened, so it is accepted even if the grant ended while the desktop was in the middle of the join.
  placed(key, result) {
    const action = this.placeable(key, false);
    if (!result || typeof result.joined !== 'boolean' || Object.keys(result).some(k => !['joined', 'error'].includes(k)) ||
        result.error !== undefined && (typeof result.error !== 'string' || !/^[a-z-]{1,60}$/.test(result.error)) || !result.joined && result.error === undefined) fail('Invalid placement result');
    if (action.placement) return copy(action.placement);
    return this.commit(data => {
      const a = data.actions[key];
      a.placement = { space: data.domains[a.domainId].space, at: Date.now(), joined: result.joined, ...(result.error ? { error: result.error } : {}) };
      // The identity is the open this result belongs to; the entry itself is written by the desktop, not by the agent.
      this.audit(data, { id: a.initiatorId, nativeId: a.initiatorNativeId }, a.identity, names[1], result.joined ? 'placed' : 'not-placed', { targetId: a.sessionId, actionId: a.id, domainId: a.domainId, by: 'desktop' });
      return copy(a.placement);
    });
  }
  // B5: the person's grant follows a session NAW replaced, one finished replacement at a time. A holder whose
  // session has ended is listed here until what became of its grant is decided and the person has been told.
  // The desktop, which owns the rotation log, looks for the one unambiguous successor and names it; this
  // journal checks everything it can see itself and re-binds the interface setting and the grants to that
  // session, or saves why it did not. Either outcome is final: a grant that stayed is never moved later behind
  // a notice that said it stayed. Nothing else changes: quotas are counted per grant, so they continue; a
  // revoked or expired grant stays revoked or expired; each open still checks the holder's permission posture.
  // Narrowed on the person's decision of 2026-11-11: the interface setting follows only together with a grant
  // that is in force. A holder with the interface on and no grant, or only revoked or expired ones, is not
  // followed at all: its successor gets nothing, nothing is decided and nothing is said. The grant in force must
  // be one the holder had when it was replaced; given one only afterwards, it is not followed either. And only
  // what the holder had when it was replaced goes on: a grant given afterwards stays with the old session.
  successions() {
    if (this.error || !this.data.enabled) return [];
    const listed = [];
    for (const [id, setting] of Object.entries(this.data.sessions)) {
      const s = this.w.sessions.get(id), outcome = setting.succession;
      if (!s) continue;
      if (outcome && !outcome.told) listed.push({ id, nativeId: setting.nativeId, outcome: copy(outcome) });
      else if (this.undecided(setting) && s.state === 'ended' && s.nativeId === setting.nativeId && this.inForce(id, setting.nativeId)) listed.push({ id, nativeId: setting.nativeId });
    }
    return listed;
  }
  // A holder is open for a decision when it has the interface and nothing was decided for it, or what was
  // decided is older than the person's turning its interface on again: that is a holder anew, and only a
  // replacement logged after that moment concerns it.
  undecided(setting) { return Boolean(setting?.enabled && (!setting.succession || Number.isSafeInteger(setting.enabledAt) && setting.succession.at < setting.enabledAt)); }
  // Whether this holder has at least one grant the person gave it that is neither revoked nor expired. With the
  // time a replacement was logged, only a grant the person had given by then counts: a grant given to a session
  // after it was replaced does not make that replacement one to follow.
  inForce(id, nativeId, by = null) {
    return Object.values(this.data.domains).some(domain => !domain.revokedAt && domain.expiresAt > Date.now() && (by === null || givenBy(domain, by)) &&
      domain.initiators.some(i => i.id === id && i.nativeId === nativeId));
  }
  // Desktop only (workspace.cjs operatorAction), in three steps: 'carry' to the successor the log names,
  // 'refuse' for what only the desktop can see (an ambiguous log, an archived successor), and 'told' once the
  // person can read the outcome in a space. An answer with saved: false decided nothing.
  succession(oldId, value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.nativeId !== 'string' || !value.nativeId || !['carry', 'refuse', 'told'].includes(value.step)) fail('Invalid succession');
    const keys = Object.keys(value).sort().join(), to = value.to;
    if (value.step === 'carry' && (keys !== 'loggedAt,nativeId,step,to' || !Number.isSafeInteger(value.loggedAt) || !to || typeof to !== 'object' || Object.keys(to).sort().join() !== 'id,nativeId' ||
          typeof to.id !== 'string' || !to.id || typeof to.nativeId !== 'string' || !to.nativeId || to.id === oldId || to.nativeId === value.nativeId) ||
        value.step === 'refuse' && (keys !== 'loggedAt,nativeId,reason,step' || value.loggedAt !== null && !Number.isSafeInteger(value.loggedAt) || !['ambiguous', 'successor-unavailable'].includes(value.reason)) ||
        value.step === 'told' && keys !== 'nativeId,step') fail('Invalid succession');
    const undecided = reason => ({ carried: false, reason, saved: false });
    if (this.error || !this.data.enabled) return undecided('interface-off');
    const setting = this.data.sessions[oldId], old = this.w.sessions.get(oldId);
    if (!setting || setting.nativeId !== value.nativeId) return undecided('not-held');
    const saved = outcome => ({ ...copy(outcome), saved: true });
    if (value.step === 'told') {
      if (!setting.succession) return undecided('not-decided');
      if (!setting.succession.told) this.commit(data => { data.sessions[oldId].succession.told = true; });
      return saved(this.data.sessions[oldId].succession);
    }
    // Decided once: asked again, the journal says what it decided and changes nothing.
    if (setting.succession && !this.undecided(setting)) return saved(setting.succession);
    if (!setting.enabled) return undecided('not-held');
    // The replacement is finished only when the old session has ended; a holder still running keeps its grant.
    if (!old || old.nativeId !== value.nativeId || old.state !== 'ended') return undecided('old-in-use');
    // A replacement logged before the person turned this holder's interface on is not a replacement of this
    // holder: nothing is decided and nothing is said, as for a holder the person simply stopped. A line whose
    // time is unknown is not given that benefit.
    if (!Number.isSafeInteger(setting.enabledAt) || Number.isSafeInteger(value.loggedAt) && value.loggedAt < setting.enabledAt) return undecided('not-replaced');
    // The interface does not go on by itself. With no grant in force there is nothing to carry and nothing to
    // refuse: the holder keeps its setting, its successor gets none, and no outcome is saved or announced.
    // Checked here as well as in the list, because a grant can be revoked or run out between the two, and
    // because only here is the time of the replacement known: the list shows a holder with any grant in force,
    // and a holder whose grants in force were all given after it was replaced is answered here. A line whose
    // time is unknown can only be refused, which moves nothing; for it any grant in force counts.
    if (!this.inForce(oldId, value.nativeId, Number.isSafeInteger(value.loggedAt) ? value.loggedAt : null)) return undecided('no-grant');
    const refuse = reason => this.commit(data => {
      data.sessions[oldId].succession = { at: Date.now(), carried: false, reason };
      this.audit(data, { id: oldId, nativeId: value.nativeId }, null, 'operator_succession', 'not-carried', { reason, ...(to ? { targetId: to.id } : {}), by: 'desktop' });
      return saved(data.sessions[oldId].succession);
    });
    if (value.step === 'refuse') return refuse(value.reason);
    const next = this.w.sessions.get(to.id);
    // The journal and its quota counts live in this backend; a successor elsewhere cannot continue them.
    if (!next) return refuse('successor-elsewhere');
    if (next.provider !== 'claude' || next.nativeId !== to.nativeId || next.nativeContextPending) return refuse('successor-mismatch');
    // The person already decided something for that session; that decision stands.
    if (Object.hasOwn(this.data.sessions, to.id)) return refuse('successor-has-setting');
    return this.commit(data => {
      const at = Date.now(), from = { id: oldId, nativeId: value.nativeId }, holder = { id: to.id, nativeId: to.nativeId };
      // The successor holds the interface from the moment the replacement was logged, so a replacement of the
      // successor itself, logged after that, can be followed in its turn.
      data.sessions[to.id] = { enabled: true, nativeId: to.nativeId, enabledAt: value.loggedAt, carriedFrom: { ...from, at } };
      // One holder: the old session, if the person brings it back, no longer has the interface. Its grants are
      // not revoked by this: they have moved. Those it had when it was replaced, that is, in force or not; one
      // the person gave it after that, before this step, was not there to go on and stays in its name, where
      // nothing new can be started under it while that session's interface is off, and the person can revoke
      // it from the old session's menu.
      data.sessions[oldId] = { ...data.sessions[oldId], enabled: false, succession: { at, carried: true, to: { ...holder } } };
      const moved = [];
      for (const domain of Object.values(data.domains)) {
        if (!domain.initiators.some(i => i.id === oldId && i.nativeId === value.nativeId) || !givenBy(domain, value.loggedAt)) continue;
        domain.initiators = domain.initiators.map(i => i.id === oldId && i.nativeId === value.nativeId ? { ...holder } : i);
        (domain.carried ||= []).push({ from: { ...from }, to: { ...holder }, at }); moved.push(domain.id);
      }
      this.audit(data, from, null, 'operator_succession', 'carried', { targetId: to.id, targetNativeId: to.nativeId, domains: moved, by: 'desktop' });
      return saved(data.sessions[oldId].succession);
    });
  }
  // A holder whose grant went on to its successor is not a holder the person turned off: what it had already
  // started (a report from a session it opened, a session waiting to join its space) still counts under the
  // grant, which is still checked for itself.
  held(id, data = this.data) { const setting = data.sessions[id]; return Boolean(setting && (setting.enabled || setting.succession?.carried === true)); }
  actor(s, r, identity) {
    if (s.provider !== 'claude' || this.w.runtimes.get(s.id) !== r || !r.operatorAvailable || r.retainedReader || r.stopped || r.disposed || r.transportDisconnected || this.w.closed || s.nativeContextPending ||
        identity?.nativeId !== s.nativeId || typeof identity.callId !== 'string' || !identity.callId || identity.callId.length > 160 ||
        !r.liveTurn || r.liveTurn.id !== identity.turnId || !identity.promptId || r.liveTurn.promptId !== identity.promptId || r.rootEnding) fail('The current native Claude root turn and prompt are not confirmed');
    // peerRevision, human control and permission state deliberately are not
    // report authority: a person may answer or approve while work continues.
  }
  initiator(s, data = this.data) {
    if (s.archived || !data.enabled || !data.sessions[s.id]?.enabled || data.sessions[s.id].nativeId !== s.nativeId) fail('The person has not enabled this initiator interface');
  }
  eligible(dispatch, data = this.data, now = Date.now()) {
    const domain = data.domains[dispatch?.domainId], request = data.requests[dispatch?.requestId];
    return Boolean(data.enabled && dispatch && !dispatch.revokedAt && !request?.closed && domain && !domain.revokedAt && domain.expiresAt > now &&
      this.held(request?.initiatorId, data) && data.sessions[request.initiatorId].nativeId === request.initiatorNativeId &&
      this.w.sessions.get(request.initiatorId)?.nativeId === request.initiatorNativeId);
  }
  audit(data, s, identity, tool, result, extra = {}) {
    data.audit.push({ callerId: s.id, nativeId: s.nativeId, turnId: identity?.turnId || null, callId: identity?.callId || null, tool, at: Date.now(), result, cost: 'unknown', ...extra });
  }
  settings(id, enabled) {
    if (typeof enabled !== 'boolean') fail('Invalid operator setting');
    const s = id === null ? null : this.w.get(id);
    if (s && enabled && s.provider !== 'claude') fail('Only Claude initiators are supported in phase 1a');
    return this.commit(data => {
      if (id === null) data.enabled = enabled;
      // B5: when it was turned on is kept, so a replacement logged before that is never taken for a replacement of
      // this holder. Where the setting came from, and what a replacement decided for this session, stay on record:
      // a decision that was made is not made a second time because the person toggled the switch.
      else data.sessions[id] = { enabled, nativeId: s.nativeId, ...(enabled ? { enabledAt: Date.now() } : {}),
        ...(data.sessions[id]?.carriedFrom ? { carriedFrom: data.sessions[id].carriedFrom } : {}), ...(data.sessions[id]?.succession ? { succession: data.sessions[id].succession } : {}) };
      if (!enabled) {
        // Turning a session off also reaches a grant that has since gone on to the session that replaced it.
        for (const domain of Object.values(data.domains)) if (id === null || domain.initiators.some(i => i.id === id) || domain.carried?.some(c => c.from.id === id)) domain.revokedAt = Date.now();
        for (const dispatch of Object.values(data.dispatches)) if (id === null || dispatch.executorId === id) dispatch.revokedAt = Date.now();
      }
      return true;
    });
  }
  grant(initiatorId, spec) {
    const s = this.w.get(initiatorId); this.initiator(s);
    if (permission(s) === 'unknown') fail('The current initiator permission ceiling is unknown or cannot safely be compared; no creation grant was recorded');
    if (!spec || Object.keys(spec).some(k => !['providers', 'directories', 'permission', 'daily', 'concurrent', 'expiresAt', 'space'].includes(k)) || !Array.isArray(spec.providers) || !spec.providers.length || spec.providers.some(p => !['claude', 'codex'].includes(p)) ||
        !Array.isArray(spec.directories) || !spec.directories.length || spec.directories.length > 16 || !['default', 'bypass'].includes(spec.permission) ||
        !Number.isSafeInteger(spec.daily) || spec.daily < 1 || !Number.isSafeInteger(spec.concurrent) || spec.concurrent < 1 || !Number.isSafeInteger(spec.expiresAt) || spec.expiresAt <= Date.now()) fail('Explicit providers, directories, permission, daily/concurrent quotas and expiry are required');
    if (spec.permission === 'bypass' && permission(s) !== 'bypass') fail('The grant cannot exceed the initiator permission posture');
    // Optional, and only from the person's own grant form: the one space sessions created under this grant join.
    if (spec.space !== undefined && (typeof spec.space !== 'string' || !spaces.roomId(spec.space))) fail('The space for new sessions is not a space');
    const directories = spec.directories.map(dir => { text(dir, 4096, 'directory'); if (!path.isAbsolute(dir) || !fs.statSync(dir).isDirectory()) fail('An existing absolute directory is required'); return fs.realpathSync(dir); });
    return this.commit(data => {
      const id = randomUUID(); data.domains[id] = { id, initiators: [{ id: s.id, nativeId: s.nativeId }], providers: [...new Set(spec.providers)], directories, permission: spec.permission,
        daily: spec.daily, concurrent: spec.concurrent, expiresAt: spec.expiresAt, model: 'native-default', createdAt: Date.now(), source: 'human',
        ...(spec.space !== undefined ? { space: spec.space } : {}) };
      return id;
    });
  }
  revoke(id) {
    return this.commit(data => { const domain = data.domains[id]; if (!domain) fail('Authorization domain no longer exists'); domain.revokedAt = Date.now(); return true; });
  }
  quota(initiatorId, spec) {
    if (require('./background-operation.cjs').current()) fail('Only the person can adjust creation quotas');
    if (!spec || typeof spec !== 'object' || Array.isArray(spec) || Object.keys(spec).sort().join() !== 'concurrent,consent,daily,domainId,nativeId,revision' || spec.consent !== true ||
        typeof spec.domainId !== 'string' || typeof spec.nativeId !== 'string' || !Number.isSafeInteger(spec.daily) || spec.daily < 1 || !Number.isSafeInteger(spec.concurrent) || spec.concurrent < 1 ||
        !Number.isSafeInteger(spec.revision) || spec.revision < 0 || spec.revision === Number.MAX_SAFE_INTEGER) fail('Explicit consent and positive safe integer quota limits are required');
    const s = this.w.get(initiatorId), domain = Object.hasOwn(this.data.domains, spec.domainId) && this.data.domains[spec.domainId];
    if (!domain || domain.revokedAt || domain.expiresAt <= Date.now() || (domain.quotaRevision || 0) !== spec.revision ||
        s.nativeId !== spec.nativeId || s.nativeContextPending || s.archived || ['ended', 'recoverable'].includes(s.state) ||
        !domain.initiators.some(i => i.id === s.id && i.nativeId === spec.nativeId)) fail('The grant or its current holder changed; reopen the quota card');
    return this.commit(data => {
      const d = data.domains[spec.domainId], previous = { daily: d.daily, concurrent: d.concurrent };
      d.daily = spec.daily; d.concurrent = spec.concurrent; d.quotaRevision = spec.revision + 1; d.quotaUpdatedAt = Date.now();
      this.audit(data, s, null, 'operator_quota', 'changed', { domainId: d.id, previous, daily: d.daily, concurrent: d.concurrent, by: 'human' });
      return copy(d);
    });
  }
  view(request, data = this.data) {
    const dispatch = data.dispatches[request.currentDispatchId], report = Object.values(data.reports).filter(r => r.dispatchId === dispatch?.id).at(-1);
    const question = request.closed ? null : request.question ?? null;
    const answered = Boolean(question && request.humanOrder >= request.questionOrder);
    const attention = !request.closed && ['blocked', 'failed', 'dropped'].includes(report?.state) && !(request.humanOrder >= report.order);
    return { id: request.id, version: request.version, executorId: dispatch?.executorId || null, dispatchId: dispatch?.id || null,
      state: request.closed ? 'closed' : question ? answered ? 'answered' : 'question' : attention ? 'attention' : report?.state === 'ready' ? 'ready' : 'processing',
      reportState: report?.state || null, question, answered, attention: Boolean(question && !answered || attention),
      cannotUpdate: Boolean(dispatch && !this.eligible(dispatch, data)), closedReason: request.closed?.reason || null,
      delivery: request.closed ? 'voided' : 'pending', latestReportId: report?.id || null, unread: Object.values(data.reports).filter(r => r.requestId === request.id && !r.readAt).length };
  }
  localMetadata(s) {
    const r = this.w.runtimes.get(s.id);
    const observed = Boolean(r && !r.stopped && !r.disposed && !r.transportDisconnected && !r.backendExitConfirmed && !s.transportDisconnected && !s.backendUnavailable && !s.nativeContextPending);
    return sessionMetadata({ ...s, transportDisconnected: !observed,
      operatorAvailable: Boolean(observed && !r.retainedReader && !r.rootEnding && r.operatorAvailable === true) });
  }
  list(s, shown = () => true) {
    this.initiator(s);
    const domains = Object.values(this.data.domains).filter(d => d.initiators.some(i => i.id === s.id && i.nativeId === s.nativeId));
    const ids = new Set(domains.map(d => d.id));
    return { status: 'ok', sessions: [...this.w.sessions.values()].filter(x => !x.archived && shown(x)).map(x => this.localMetadata(x)),
      domains: domains.map(d => ({ id: d.id, providers: d.providers, directories: d.directories, permission: d.permission, model: d.model, daily: d.daily, concurrent: d.concurrent, expiresAt: d.expiresAt, revoked: Boolean(d.revokedAt) })),
      requests: Object.values(this.data.requests).filter(r => ids.has(r.domainId)).map(r => ({ ...this.view(r), task: r.task,
        latestReport: (() => { const report = this.data.reports[this.view(r).latestReportId]; return report ? { id: report.id, state: report.state, body: report.body.slice(0, 8000), at: report.at, turnAbnormal: report.turnAbnormal === true } : null; })() })) };
  }
  async visibleSessions(fallback, shown = () => true) {
    const peer = this.w.peerRunner;
    if (!peer?.root || !peer.connect) return { sessions: fallback, metadataIncomplete: false };
    // The same authenticated local registry/initial channel already used by
    // lookupWake. Only this whitelist ever crosses the native tool boundary.
    // No new daemon, provider, prompt or remote endpoint is involved.
    const root = peer.root(), layout = require('./service-layout.cjs').readLayout(root), deadline = Date.now() + 2000;
    const { readRetiredBackend } = require('./service-client.cjs');
    const sessions = new Map(fallback.map(s => [s.id, s])), duplicates = new Set(); let incomplete = false;
    for (const key of layout.entries) {
      const directory = path.join(root, key);
      if (path.resolve(directory) === path.resolve(this.w.dataDir)) continue;
      const remaining = deadline - Date.now(); if (remaining <= 0) { incomplete = true; break; }
      let client, timer, cancelled = false;
      try {
        const read = (async () => {
          const retired = readRetiredBackend(root, key, layout);
          if (retired) return retired;
          client = await peer.connect(directory, 'workspace-operator-metadata', { page: false });
          if (cancelled) { client.close(); return null; }
          return client.call('initial');
        })();
        const state = await Promise.race([read, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Metadata deadline')), remaining); })]);
        if (!Array.isArray(state?.sessions)) throw Error('Session metadata unavailable');
        for (const session of state.sessions) if (!session.archived && typeof session.id === 'string' && shown(session)) {
          if (sessions.has(session.id)) duplicates.add(session.id);
          sessions.set(session.id, sessionMetadata(session));
        }
      } catch { incomplete = true; }
      finally { cancelled = true; clearTimeout(timer); client?.close(); }
    }
    for (const id of duplicates) sessions.set(id, { ...sessions.get(id), state: 'unknown', canReport: false });
    return { sessions: [...sessions.values()], metadataIncomplete: incomplete };
  }
  report(s, identity, args) {
    validate(names[2], args);
    const key = JSON.stringify([s.nativeId, identity.callId]);
    if (Object.hasOwn(this.data.calls, key)) return { status: 'duplicate', reportId: this.data.calls[key], message: 'This native call was already recorded; no new report was saved.' };
    return this.commit(data => {
      const dispatch = data.dispatches[args.dispatch_id];
      if (!dispatch || dispatch.requestId !== args.request_id || dispatch.executorNativeId !== s.nativeId || dispatch.executorId !== s.id) fail('The dispatch does not belong to this native executor and request');
      if (!this.eligible(dispatch, data)) fail('The request is closed or report eligibility was revoked or expired; no new report was saved');
      const request = data.requests[dispatch.requestId], at = Date.now(), id = randomUUID();
      const report = { id, requestId: request.id, dispatchId: dispatch.id, version: dispatch.version, executorId: s.id, executorNativeId: s.nativeId, initiatorId: request.initiatorId,
        callerTurnId: identity.turnId, callId: identity.callId, state: args.state, body: args.body, ...(Object.hasOwn(args, 'question') ? { question: args.question } : {}),
        at, order: data.sequence, notification: 'pending-1b', roomIds: spaces.roomIds(s).filter(id => spaces.roomIds(this.w.get(request.initiatorId)).includes(id)) };
      data.reports[id] = report; data.calls[key] = id;
      if (request.currentDispatchId === dispatch.id) {
        if (args.state === 'ready' || args.question === null) { request.question = null; request.questionAt = null; }
        else if (typeof args.question === 'string') { request.question = args.question; request.questionAt = at; request.questionOrder = data.sequence; request.humanAt = null; request.humanOrder = null; }
      }
      this.audit(data, s, identity, names[2], 'saved', { targetId: request.initiatorId, domainId: dispatch.domainId, requestId: request.id, dispatchId: dispatch.id, reportId: id, version: dispatch.version });
      return { status: 'saved', reportId: id, requestId: request.id, dispatchId: dispatch.id, version: dispatch.version, notification: 'pending-1b' };
    });
  }
  human(id) {
    if (!Object.values(this.data.requests).some(r => !r.closed && this.data.dispatches[r.currentDispatchId]?.executorId === id)) return;
    this.commit(data => { for (const request of Object.values(data.requests)) if (!request.closed && data.dispatches[request.currentDispatchId]?.executorId === id) { request.humanAt = Date.now(); request.humanOrder = data.sequence; } });
  }
  turnEnd(id, info) {
    // `incomplete`: native ended the turn normally, only NAW could not confirm it saw all of it, so the report's turn
    // is not "未正常结束" (steward step 2, batch 0).
    if (info.status === 'completed' || info.status === 'incomplete' || !Object.values(this.data.reports).some(r => r.executorId === id && r.executorNativeId === info.nativeId && r.callerTurnId === info.turnId)) return;
    this.commit(data => { for (const report of Object.values(data.reports)) if (report.executorId === id && report.executorNativeId === info.nativeId && report.callerTurnId === info.turnId) report.turnAbnormal = true; });
  }
  close(requestId, reason) {
    if (!['accepted', 'cancelled'].includes(reason)) fail('Invalid request ending');
    return this.commit(data => {
      const request = data.requests[requestId]; if (!request) fail('Request no longer exists'); if (request.closed) return true;
      if (reason === 'accepted' && this.view(request, data).reportState !== 'ready') fail('Only a ready result can be accepted');
      request.closed = { reason, at: Date.now() };
      for (const action of Object.values(data.actions)) if (action.requestId === requestId && ['pending-authorization', 'authorized'].includes(action.status)) action.status = 'cancelled';
      return true;
    });
  }
  markRead(requestId) {
    return this.commit(data => { if (!data.requests[requestId]) fail('Request no longer exists'); for (const report of Object.values(data.reports)) if (report.requestId === requestId) report.readAt = Date.now(); return true; });
  }
  dismiss(key) {
    return this.commit(data => { const action = data.actions[key]; if (!action || !['pending-authorization', 'authorized'].includes(action.status)) fail('Creation confirmation is stale'); action.status = 'cancelled'; return true; });
  }
  covering(s, args, domain, data = this.data) {
    return domain && !domain.revokedAt && domain.expiresAt > Date.now() && domain.initiators.some(i => i.id === s.id && i.nativeId === s.nativeId) && domain.providers.includes(args.provider) &&
      domain.directories.some(dir => within(args.cwd, dir)) && permission(s) !== 'unknown' && (args.permission !== 'bypass' || domain.permission === 'bypass' && permission(s) === 'bypass') && data.enabled;
  }
  coveringDomain(action) {
    if (action.status !== 'pending-authorization') return null;
    const s = this.w.sessions.get(action.initiatorId);
    if (this.error || !s || s.nativeId !== action.initiatorNativeId) return null;
    try { this.initiator(s); } catch { return null; }
    const saved = this.data.domains[action.domainId];
    return (this.covering(s, action.args, saved) ? saved : Object.values(this.data.domains).find(d => this.covering(s, action.args, d)))?.id || null;
  }
  open(s, identity, args) {
    validate(names[1], args); this.initiator(s);
    const key = JSON.stringify([s.nativeId, args.action_id]), previous = this.data.actions[key];
    if (previous) {
      if (Object.keys(previous.args).length !== Object.keys(args).length || Object.keys(args).some(k => args[k] !== previous.args[k])) fail('action_id was already used with different arguments');
      return this.inflight.get(key) || this.openResult(previous);
    }
    const cwd = fs.realpathSync(args.cwd); if (!fs.statSync(cwd).isDirectory()) fail('Directory unavailable');
    if (cwd !== path.resolve(args.cwd)) fail('Use the canonical directory shown by the person');
    const domain = args.grant_id ? this.data.domains[args.grant_id] : Object.values(this.data.domains).find(d => this.covering(s, args, d));
    const action = { key, id: args.action_id, args, initiatorId: s.id, initiatorNativeId: s.nativeId, identity, at: Date.now(), status: this.covering(s, args, domain) ? 'authorized' : 'pending-authorization', domainId: domain?.id || null };
    this.commit(data => { data.actions[key] = action; this.audit(data, s, identity, names[1], action.status, { actionId: action.id, domainId: action.domainId }); });
    return action.status === 'authorized' ? this.startOpen(key) : this.openResult(action);
  }
  openResult(action) {
    const s = action.sessionId && this.w.sessions.get(action.sessionId);
    return { status: action.status, actionId: action.id, sessionId: action.sessionId || null, requestId: action.requestId || null, dispatchId: action.dispatchId || null,
      domainId: action.domainId || null,
      provider: s?.provider || action.args.provider, cwd: s?.cwd || action.args.cwd, model: actualModel(s) || 'unknown', modelSelection: 'native-default', permission: action.args.permission, permissionObserved: s?.nativePermissionMode || this.w.runtimes.get(s?.id)?.nativeSettings?.sandboxMode || null,
      delivery: this.data.requests[action.requestId]?.closed ? 'voided' : 'pending-1b', canReport: Boolean(s && this.localMetadata(s).canReport),
      // Where the person's grant sends the new session, and what the desktop did. The task stays undelivered.
      space: this.data.domains[action.domainId]?.space || null, ...this.placementResult(action),
      ...(action.error ? { message: action.error } : {}) };
  }
  placementResult(action) {
    if (action.status !== 'created' || !this.data.domains[action.domainId]?.space) return { placement: null };
    if (action.placement) return { placement: action.placement.joined ? 'joined' : 'not-placed', ...(action.placement.error ? { placementError: action.placement.error } : {}) };
    return this.placing(action) ? { placement: 'pending' } : { placement: 'not-placed', placementError: 'grant-ended' };
  }
  authorize(key, domainId) {
    const action = this.data.actions[key]; if (!action || action.status !== 'pending-authorization') fail('The creation confirmation is stale');
    const s = this.w.get(action.initiatorId); this.initiator(s);
    if (s.nativeId !== action.initiatorNativeId || !this.covering(s, action.args, this.data.domains[domainId])) fail('The explicit grant does not cover this action');
    this.commit(data => { data.actions[key].domainId = domainId; data.actions[key].status = 'authorized'; });
    return this.startOpen(key);
  }
  startOpen(key) {
    if (this.inflight.has(key)) return this.inflight.get(key);
    const pending = this.create(key).catch(error => {
      if (!this.error && this.data.actions[key]?.status === 'authorized') this.commit(data => { data.actions[key].status = 'not-created'; data.actions[key].error = String(error.message).slice(0, 2000); });
      throw error;
    }); this.inflight.set(key, pending); pending.finally(() => this.inflight.delete(key)).catch(() => {}); return pending;
  }
  async create(key) {
    const action = this.data.actions[key], s = this.w.get(action.initiatorId); this.initiator(s);
    if (action.status !== 'authorized') return this.openResult(action);
    const domain = this.data.domains[action.domainId];
    if (!this.covering(s, action.args, domain)) fail('The creation grant was revoked or expired');
    const usage = this.quotaUsage(domain.id);
    if (usage.usedToday >= domain.daily || usage.concurrent >= domain.concurrent) fail('The authorization domain daily or concurrent creation quota is exhausted');
    const requestId = randomUUID();
    this.commit(data => {
      const a = data.actions[key]; a.status = 'creating'; a.startedAt = Date.now(); a.requestId = requestId;
      data.requests[requestId] = { id: requestId, domainId: domain.id, initiatorId: s.id, initiatorNativeId: s.nativeId, version: 1, task: action.args.task, at: a.startedAt, question: null };
    });
    try {
      const id = await this.w.create(action.args.provider, action.args.cwd, null, action.args.name, action.args.view, action.args.permission === 'bypass' ? { skipPermissions: true } : {}, session => {
        // Reserve the exact session before any host/runtime allocation. If the
        // writer dies after this point the action remains unconfirmed, never replayed.
        this.initiator(s);
        if (!this.covering(s, action.args, this.data.domains[domain.id])) fail('The creation grant changed before native allocation');
        session.operatorCreation = { permission: action.args.permission };
        this.commit(data => { data.actions[key].sessionId = session.id; });
        this.w.persist(); if (this.w.storageWarning) fail('The new session reservation could not be saved');
      });
      const created = this.w.get(id), dispatchId = randomUUID();
      // Codex learns its native identity during start. The reservation saved
      // before allocation still contains null; save the resolved identity
      // before returning a durable created receipt from the other journal.
      this.w.persist(); if (this.w.storageWarning) fail('The created native session identity could not be saved; creation is unconfirmed');
      this.commit(data => {
        const a = data.actions[key]; a.status = 'created'; a.dispatchId = dispatchId;
        const request = data.requests[requestId]; request.currentDispatchId = dispatchId;
        data.dispatches[dispatchId] = { id: dispatchId, requestId, domainId: domain.id, version: 1, executorId: id, executorNativeId: created.nativeId, at: Date.now(), delivery: 'pending-1b' };
        this.audit(data, s, action.identity, names[1], 'created', { targetId: id, actionId: action.id, requestId, dispatchId, domainId: domain.id });
      });
      return this.openResult(this.data.actions[key]);
    } catch (error) {
      if (!this.error) this.commit(data => { data.actions[key].status = 'unconfirmed'; data.actions[key].error = String(error.message).slice(0, 2000); });
      throw error;
    }
  }
  async call(s, r, identity, name, args) {
    this.actor(s, r, identity); validate(name, args);
    if (name === names[2]) return this.report(s, identity, args);
    if (name === names[1]) return this.open(s, identity, args);
    if (name === names[0]) {
      // A space's project manager is told of its own space's sessions only (space-managers.cjs).
      const root = this.w.peerRunner?.root?.() || this.w.dataDir, shown = require('./space-managers.cjs').visibleTo(root, s);
      const result = this.list(s, shown), visible = await this.visibleSessions(result.sessions, shown);
      this.actor(s, r, identity); this.initiator(s);
      this.commit(data => this.audit(data, s, identity, name, 'read')); return { ...result, ...visible };
    }
    fail('Unsupported operator tool');
  }
  rows(sessionId, roomId = null) {
    const rows = [];
    for (const report of Object.values(this.data.reports)) {
      if (roomId ? !report.roomIds.includes(roomId) : report.initiatorId !== sessionId) continue;
      const request = this.data.requests[report.requestId], current = this.view(request), old = request.currentDispatchId !== report.dispatchId;
      const executor = this.w.sessions.get(report.executorId), initiator = this.w.sessions.get(report.initiatorId);
      const params = { sender: executor?.name || report.executorId, recipient: initiator?.name || report.initiatorId, request: request.id, version: report.version, body: report.body };
      rows.push({ id: `operator:report:${report.id}`, role: 'system', kind: 'operator-report', name: `${params.sender} → ${params.recipient}`, time: report.at, status: 'complete',
        ...uiNotice('notice.operator.report', params), operator: { ...current, requestId: request.id, reportId: report.id, old, reportVersion: report.version, senderId: report.executorId, recipientId: report.initiatorId,
          executorId: report.executorId, reportState: report.state, reportQuestion: report.question ?? null, turnAbnormal: Boolean(report.turnAbnormal), unread: !report.readAt, actionable: !old && report.id === current.latestReportId } });
    }
    if (!roomId) for (const action of Object.values(this.data.actions)) {
      if (action.initiatorId !== sessionId) continue;
      const request = this.data.requests[action.requestId], view = request ? this.view(request) : null;
      rows.push({ id: `operator:open:${action.key}`, role: 'system', kind: 'operator-open', name: 'NAW', time: action.at, status: 'complete',
        ...uiNotice('notice.operator.open', { provider: action.args.provider, cwd: action.args.cwd, task: action.args.task }),
        operator: { ...(view || {}), requestId: request?.id || null, actionKey: action.key, initiatorId: action.initiatorId, initiatorNativeId: action.initiatorNativeId,
          args: action.args, creation: action.status, actual: this.openResult(action), coveredDomainId: this.coveringDomain(action), actionable: !request?.closed } });
    }
    return rows;
  }
  decorate(snapshot) {
    return { ...snapshot, operatorPolicy: this.policy(), sessions: snapshot.sessions.map(s => ({ ...s, operatorEnabled: this.data.sessions[s.id]?.enabled === true && this.data.sessions[s.id].nativeId === s.nativeId,
      operatorAvailable: this.localMetadata(s).canReport, messages: insertRows(s.messages, this.rows(s.id)) })),
      rooms: snapshot.rooms.map(room => ({ ...room, messages: insertRows(room.messages, this.rows(null, room.id)) })),
      room: { ...snapshot.room, messages: insertRows(snapshot.room.messages, this.rows(null, snapshot.room.id)) } };
  }
}
module.exports = { OperatorControl, CAPABILITY, tools, names, validate, actualModel };
