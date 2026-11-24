const { uiError, uiActivity, setWarning } = require('./ui-errors.cjs');
const { displayMessage } = require('./ui-locale.js');
// One explicit native intent, transferred once through the existing local services.
// No replay, model router, permission decision or native goal write lives here. The one timer offers again a message
// the designated butler refused only for its 60-second limit (option A, below).
const fs = require('node:fs'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const { readLayout } = require('./service-layout.cjs');
const spaces = require('./collaboration-spaces.cjs');
const backgroundOperation = require('./background-operation.cjs');
const CAPABILITY = 'agentWakeV1', PREFLIGHT = 'agentWakePreflightV1', COOLDOWN = 60000, MAX_STREAK = 3;
function root(w) { return w.peerRunner?.root() || (/^[a-f0-9]{20}$/.test(path.basename(w.dataDir)) && path.basename(path.dirname(w.dataDir)) === 'backends' ? path.dirname(path.dirname(w.dataDir)) : w.dataDir); }
function marker(w, name) { return path.join(root(w), name); }
function safeFile(file) {
  try { const s = fs.lstatSync(file); if (!s.isFile() || s.uid !== process.getuid() || (s.mode & 0o077)) throw uiError("error.wake.settingsPermissionUnconfirmed"); return true; }
  catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}
function enabled(w) {
  fs.accessSync(root(w), fs.constants.W_OK);
  if (safeFile(marker(w, 'agent-wake-disabled'))) return false;
  const current = boundary(w);
  if (w.wakeGuardFailure) {
    if (current === w.wakeFailureBoundary) return false;
    // A later successful shared control change supersedes the failed boundary.
    w.wakeGuardFailure = null; delete w.wakeGuardFailureUiMessage;
  }
  return true;
}
function boundary(w) {
  const file = marker(w, 'agent-wake-boundary');
  if (!safeFile(file)) throw uiError("error.wake.controlBoundaryUnavailable");
  const value = fs.readFileSync(file, 'utf8');
  if (!/^[a-f0-9-]{36}$/i.test(value)) throw uiError("error.wake.humanInputBoundaryUnconfirmed");
  return value;
}
// What withdrew a turn's automatic messages, for its refusal text and code only (the person, 11-23 「又是 communication
// 的 bug」): the proofs below stay the only check. 'boundary' and 'control' are the fallbacks when NAW has no name.
const REVOKED = Object.freeze({ input: 'Input', interrupt: 'Interrupt', takeover: 'Takeover', opened: 'Open', background: 'Background',
  stop: 'Stop', migration: 'Migration', reconnect: 'Reconnect', identity: 'Identity', 'native-input': 'NativeInput', control: 'Control',
  'native-turn': 'NativeTurn', switch: 'Switch', pause: 'Pause', upgrade: 'Upgrade', boundary: 'Boundary',
  'workspace-closed': 'Closed', 'storage-unavailable': 'Storage', 'source-runtime-changed': 'Runtime', 'automatic-messages-disabled': 'Disabled' });
const BOUNDARY_CAUSES = new Set(['switch', 'pause', 'upgrade', 'input', 'background', 'boundary']);
const revokedError = code => Object.assign(uiError('error.wake.revokedBy' + REVOKED[code]), { sourceIssue: code });
const labelled = code => backgroundOperation.current() ? 'background' : code;
// Runtime-only: the uncompensated changes of each session, newest last. `peer`: only its peer revision changed, which
// the turn's start proof does not carry, so it can name only a refusal where nothing else changed (review N1).
const causes = new WeakMap();
let causeSeq = 0;
function cause(s, code, peer = false) {
  if (!s || !Object.hasOwn(REVOKED, code)) return;
  causes.set(s, [...(causes.get(s) || []), { seq: ++causeSeq, code: labelled(code), peer }].slice(-8));
}
function controlCause(s, since, fallback = 'control', peer = false) {
  return (causes.get(s) || []).find(e => e.seq > (since ?? 0) && e.peer === peer)?.code || fallback;
}
// Which change replaced each shared boundary, so another backend's turn can name it. Advisory: unreadable means 'boundary'.
const CAUSES_FILE = 'agent-wake-boundary-causes';
function boundaryCauses(w) {
  const file = marker(w, CAUSES_FILE);
  if (!safeFile(file)) return [];
  const list = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Array.isArray(list) ? list : [];
}
function boundaryCause(w, replaced) {
  try {
    const found = boundaryCauses(w).find(e => Array.isArray(e) && e[0] === replaced);
    return found && BOUNDARY_CAUSES.has(found[1]) ? found[1] : 'boundary';
  } catch { return 'boundary'; }
}
function noteBoundary(w, replaced, code) {
  if (!replaced) return;
  const file = marker(w, CAUSES_FILE), temp = file + '.' + randomUUID() + '.tmp';
  try {
    let list = [];
    try { list = boundaryCauses(w); } catch { /* Started again. */ }
    fs.writeFileSync(temp, JSON.stringify([...list, [replaced, code]].slice(-8)), { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, file);
  } catch { /* Only the text falls back to 'boundary'. */ } finally { try { fs.unlinkSync(temp); } catch { /* Gone. */ } }
}
function revoke(w, code = 'boundary') {
  code = labelled(BOUNDARY_CAUSES.has(code) ? code : 'boundary');
  const file = marker(w, 'agent-wake-boundary'), temp = file + '.' + randomUUID() + '.tmp';
  let previous = null, saved = false;
  try { previous = boundary(w); } catch { /* Missing/invalid markers are never authority. */ }
  try {
    safeFile(file);
    fs.writeFileSync(temp, randomUUID(), { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, file);
    w.wakeGuardFailure = null; delete w.wakeGuardFailureUiMessage; saved = true;
    noteBoundary(w, previous, code);
  } catch {
    // Automatic input fails closed, but a new optional feature cannot take
    // away human control when its own storage is unavailable.
    setWarning(w, 'wakeGuardFailure', 'error.warning.wakeGuardStopped');
    w.wakeFailureBoundary = previous;
    try {
      const off = marker(w, 'agent-wake-disabled');
      if (!safeFile(off)) { const fd = fs.openSync(off, 'wx', 0o600); fs.closeSync(fd); }
    } catch {
      // Unlink needs no new descriptor: invalidate earlier nonces even when
      // allocation fails. A missing boundary rejects every automatic input.
      try { const stat = fs.lstatSync(file); if (stat.isFile() && stat.uid === process.getuid()) fs.unlinkSync(file); } catch { /* The local automatic path stays disabled. */ }
    }
  } finally { try { fs.unlinkSync(temp); } catch { /* Never block human controls on cleanup. */ } }
  for (const s of w.sessions.values()) for (const m of s.messages || []) if (['staged', 'held'].includes(m.wake?.status)) {
    w.edited?.(s); m.wake.status = 'cancelled'; m.wake.settledAt = Date.now(); m.wake.cancellation = { code, at: m.wake.settledAt };
    // A saved row the catalog cannot render (review N2) still ends, in plain text.
    try { const [text, uiMessage] = uiActivity('notice.wake.revokedBy' + REVOKED[code], { body: m.wake.body }); m.text = text; m.uiMessage = uiMessage || undefined; }
    catch { m.text = `自动消息的授权边界变了；自动消息未投递。\n${m.wake.body}`; m.uiMessage = undefined; }
  }
  return saved;
}
function initialize(w) {
  try { if (safeFile(marker(w, 'agent-wake-boundary'))) { boundary(w); return; } } catch { /* Revoke will disable only automatic input. */ }
  revoke(w);
}
function human(w, id) { const s = w.sessions.get(id); if (s) { s.wakeHumanRevision = (s.wakeHumanRevision || 0) + 1; } }
function setPolicy(w, id, value) {
  if (typeof value !== 'boolean') throw uiError("error.wake.invalidSetting");
  if (id === null) {
    const file = marker(w, 'agent-wake-disabled');
    if (value) { if (safeFile(file)) fs.unlinkSync(file); }
    else if (!safeFile(file)) { const fd = fs.openSync(file, 'wx', 0o600); fs.closeSync(fd); }
  } else { const s = w.get(id); s.wakeDisabled = !value; human(w, id); }
  const saved = revoke(w, 'switch'); w.changed(); w.persist();
  if (!saved) throw Object.assign(Error(w.wakeGuardFailure), { uiMessage: w.wakeGuardFailureUiMessage });
  if (w.storageWarning) throw uiError("error.wake.settingsIncomplete");
  return true;
}
function snapshot(w) { try { return { enabled: enabled(w), ...(w.wakeGuardFailure ? { warning: w.wakeGuardFailure, warningUiMessage: w.wakeGuardFailureUiMessage || null } : {}) }; } catch { const fallback = uiError('error.warning.wakeGuardUnavailable'); return { enabled: false, unavailable: true, warning: w.wakeGuardFailure || fallback.message, warningUiMessage: w.wakeGuardFailure ? w.wakeGuardFailureUiMessage || null : fallback.uiMessage }; } }
// The sender's human-control state when its turn started. Ordinary input into the session (the person typing, queueing
// or steering, another agent's message, a background notice) neither withdraws nor renews what the turn may send: every
// session has the input policy the designated butler has had since 2026-11-14 (the person, 2026-11-23). Count the
// exact control/peer changes made by that input, without hiding Esc, Ctrl-C, takeover, stop, connection, membership
// or permission changes. Runtime-only: reopening never replays a wake.
const inputChanges = new WeakMap();
function messageInput(w, s, { control = 0, peer = 0 }) {
  const prior = inputChanges.get(s) || { control: 0, peer: 0 };
  inputChanges.set(s, { control: prior.control + control, peer: prior.peer + peer });
}
function sourceIdentity(w, s) {
  const proof = identity(s), input = inputChanges.get(s);
  if (input) {
    if (input.control) proof.controlRevision -= input.control;
    if (input.peer) proof.peerRevision -= input.peer;
  }
  return proof;
}
const humanProof = (w, s) => s ? JSON.stringify([s.owner ?? null, sourceIdentity(w, s).controlRevision || 0, s.connectionRevision || 0]) : null;
function nativeStart(w, r, info, s) {
  // A wake still staged from an earlier turn of this native session: that turn's end never reached NAW (a failed turn
  // with no capacity report, a lost end row), so "after its turn ends normally" can no longer happen. Withdrawn now,
  // with that reason, instead of staying 已登记 for good (steward step 2).
  try {
    const earlier = new Set((s?.messages || []).filter(m => m.wake?.status === 'staged' && m.wake.nativeId === info.nativeId && m.wake.turnId !== info.turnId).map(m => m.wake.turnId));
    for (const turnId of earlier) complete(w, s, r, { nativeId: info.nativeId, turnId, status: 'unreported' });
  } catch { /* Withdrawn at the next start, or at reopen. */ }
  try { r.wakeTurn = { nativeId: info.nativeId, turnId: info.turnId, boundary: boundary(w), human: humanProof(w, s), since: causeSeq }; }
  catch { r.wakeTurn = null; }
}
function identity(s) { return require('./peer-handoffs.cjs').identity(s); }
function same(s, expected) { return s && JSON.stringify(identity(s)) === JSON.stringify(expected); }
function sourceIssue(w, s, r, intent) {
  if (w.closed) return { code: 'workspace-closed' };
  if (w.storageWarning) return { code: 'storage-unavailable' };
  if (w.runtimes.get(s.id) !== r || r.stopped || r.transportDisconnected) return { code: 'source-runtime-changed' };
  if (!enabled(w)) return { code: 'automatic-messages-disabled' };
  if (boundary(w) !== intent.boundary) return { code: 'authorization-boundary-changed' };
  const current = sourceIdentity(w, s);
  if (JSON.stringify(current) !== JSON.stringify(intent.sourceProof)) {
    // Record field names only, never owner IDs, process details or draft contents.
    return { code: 'source-identity-changed', fields: Object.keys(current).filter(key => JSON.stringify(current[key]) !== JSON.stringify(intent.sourceProof?.[key])) };
  }
  return null;
}
function sourceValid(w, s, r, intent) { return !sourceIssue(w, s, r, intent); }
function durable(w) { w.changed(); w.persist(); if (w.storageWarning) throw uiError("error.wake.recordSaveFailed"); }
function notSent(error, hold) {
  return { status: 'not-sent', reason: error.message, reasonUiMessage: displayMessage(error.uiMessage) || null, ...hold };
}
// Option A (board 11-12 21:2x, the person 「按你推荐的来」): 「被拒的自动消息先存着、每分钟补送一条，限制本身不变（不放宽）」.
// A message the designated butler refuses only for its 60-second limit is kept by its sender's backend and offered
// again when the limit allows: one a minute to the butler, as the limit already has it. Every other refusal (three in
// a row, busy, waiting, switched off, a changed identity) and every other recipient stay as before: not sent, not
// retried. Each offer is a full delivery attempt again, so the person acting on either session or pausing all
// handoffs still ends it. The recipient's backend says so, with the time its limit opens. No turn of the sender stands
// behind a held message, so the input allowance of a running turn does not cover it: any input into the sender since
// it was first held ends it (the person's and another agent's are one count there).
function holdFor(w, s, error) {
  if (error?.cooldown !== true || !isSteward(w, s)) return undefined;
  const at = s.wakeBudget?.lastAt;
  return Number.isSafeInteger(at) ? { hold: true, retryAt: at + COOLDOWN } : undefined;
}
// The sender's side checks the answer too: only a refusal for the limit, of a message to the person's designated
// butler, is ever held.
function holdable(w, intent, result) {
  if (result?.status !== 'not-sent' || result.hold !== true || !Number.isSafeInteger(result.retryAt) || result.reasonUiMessage?.key !== 'error.wake.recipientCooldown') return false;
  return stillButler(w, intent);
}
// The designation as it is now still names the recipient's native session: the person can end or move the role.
function stillButler(w, intent) {
  try { const steward = stewardNow(w); return Boolean(steward) && steward.sessionId === intent.recipientId && steward.nativeId === intent.targetProof?.nativeId; } catch { return false; }
}
// settledAt: when it finally did not go out; the butler is told of it by then, not by when it was staged (R119).
function refusedNotice(row, result) {
  row.wake.status = 'not-sent'; row.wake.settledAt = Date.now();
  row.text = `自动消息没有发出；不会自动重发。\n${result.reason}\n${row.wake.body}`;
  const cause = { message: result.reason, uiMessage: result.reasonUiMessage };
  row.uiMessage = displayMessage(uiError('error.wake.notSent', { reason: result.reason, body: row.wake.body }, { cause, param: 'reason' }).uiMessage, 'error.', row.text) || undefined;
}
// A migration's quiet window (quiet-windows.cjs) on the recipient's backend: its automatic messages are held here
// until the window closes, then tried as any held one (the recipient's side checks everything again). At most
// QUIET_HELD_MAX held at a time on this backend; the next one is not sent. A refusal that the window itself ends
// (the recipient at work, waiting or within its minute) is held too; every other refusal stays as it was.
const QUIET_HELD_MAX = 32, QUIET_CHECK_MS = 60000;
const QUIET_PASSING = Object.freeze(['error.wake.recipientBusy', 'error.wake.recipientInputPending', 'error.wake.recipientAwaiting', 'error.wake.recipientCooldown']);
function quietWindow(w, key) {
  try { return require('./quiet-windows.cjs').openWindow(root(w), key, Date.now()); } catch { return null; }
}
function quietRows(w) {
  let count = 0;
  for (const s of w.sessions.values()) for (const m of s.messages || []) if (m.wake?.quietWindow && ['staged', 'held'].includes(m.wake.status)) count++;
  return count;
}
const quietFull = () => notSent(uiError('error.wake.quietWindowFull', { limit: QUIET_HELD_MAX }));
// A sender on the backend being moved: the move ends this backend's store and every row held in it, so it is
// refused now, not held (the reviewer's B1, 11-23). Its key as peer-handoffs.cjs computes it.
const ownKey = w => path.relative(root(w), w.dataDir) || '.';
const quietSame = () => notSent(uiError('error.wake.quietWindowSameBackend'));
const shortKey = key => key === '.' ? 'root' : String(key).split('/').pop().slice(0, 7);
// Looked at again each minute (and at its deadline), so a window that closes early lets it go then.
function holdQuiet(w, row, window) {
  const intent = row.wake, now = Date.now();
  intent.status = 'held'; intent.heldAt ??= now;
  // As for the 60-second limit: once held, any input into its sender ends it.
  const s = w.sessions.get(intent.senderId);
  if (s) intent.heldProof ??= identity(s);
  intent.retryAt = Math.max(now + 1000, Math.min(window.deadline, now + QUIET_CHECK_MS));
  row.text = `收件方的后台在迁移前的安静窗口里；这条先存着，窗口结束后再试一次。\n${intent.body}`;
  row.uiMessage = displayMessage({ version: 1, key: 'notice.wake.quietHeld', params: { body: intent.body } }, 'notice.', row.text) || undefined;
}
// After a move the recipient lives on another backend: the same native session there, with its identity there.
async function relocate(w, intent) {
  const found = await w.peerRunner.lookupWake(intent.recipientId);
  if (found.key === intent.targetKey) return;
  if (!found.session || found.session.nativeId !== intent.targetProof?.nativeId) throw uiError('error.wake.recipientIdentityChanged');
  intent.targetKey = found.key; intent.targetProof = identity(found.session);
  durable(w);
}
function validateArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k => !['recipient_id', 'message'].includes(k)) ||
    typeof args.recipient_id !== 'string' || !args.recipient_id || args.recipient_id.length > 100 ||
    typeof args.message !== 'string' || !args.message.trim() || args.message.length > 6000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(args.message)) throw uiError("error.handoffRecipientAndBodyRequired");
}
// The designated butler (大管家) as main.cjs stewardCaller names it: the very session and native session the person's
// designation names now (after logged rotations), usable (not archived, its native context not pending) and in no
// space. Anything else, a designation that cannot be read included, is not, and keeps one message a turn. Read from
// the same file main.cjs keeps, only when it matters.
const STEWARD_RECIPIENTS = 4;
function stewardNow(w) { return new (require('./steward-role.cjs').StewardRole)(root(w)).current(); }
function isSteward(w, s) {
  try {
    const steward = stewardNow(w);
    return Boolean(steward && s && steward.sessionId === s.id && steward.nativeId === s.nativeId && !s.archived && !s.nativeContextPending && spaces.roomIds(s).length === 0);
  } catch { return false; }
}
// One automatic message a turn; the butler, one to each of up to four different recipients (the wake proposal, item 2,
// 2026-11-12: 「②只给指定大管家（每收件方 1 条、最多 4 个），其他 agent 不变」). `taken`: the recipients the turn already
// holds a message, or a call under way, for. Called only once the sender is known to be the butler.
function stewardLimit(taken, recipient) {
  if (taken.includes(recipient)) throw uiError("error.wake.turnRecipientRepeated");
  if (new Set(taken).size >= STEWARD_RECIPIENTS) throw uiError("error.wake.turnRecipientLimit", { limit: STEWARD_RECIPIENTS });
}
// R119 (the person, 11-23: 「不能错过项目经理的内容」): a message refused before it had a row of its own keeps only
// its code, recipient and time here; main tells the butler about those addressed to it (butler-ingress.cjs
// observeWakeUndelivered). Runtime-only, the last few.
const UNDELIVERED_KEPT = 20;
function undelivered(w, s, r, args, error) {
  const recipientId = args?.recipient_id;
  if (!r || typeof recipientId !== 'string' || !recipientId || recipientId.length > 100 || recipientId === s?.id) return false;
  const entry = { id: randomUUID(), at: Date.now(), recipientId, key: error?.uiMessage?.key || null };
  if (error?.sourceIssue) entry.sourceIssue = error.sourceIssue;
  r.wakeUndelivered = [...(r.wakeUndelivered || []), entry].slice(-UNDELIVERED_KEPT);
  try { w.changed?.(s?.id); } catch { /* Shown with the next state. */ }
  return true;
}
// Its own plugin refused the call before any of this saw it: no root turn of its own (register.js, r4).
function unbound(w, s, r, recipientId) { return undelivered(w, s, r, { recipient_id: recipientId }, { sourceIssue: 'root-turn-unbound' }); }
function stage(w, s, r, native, args) {
  try { return stageCall(w, s, r, native, args); }
  catch (error) { undelivered(w, s, r, args, error); throw error; }
}
// The refused turn's error names its change; with none, the same refusal as before.
function issueCause(w, s, issue, intent, since) {
  if (issue.code === 'authorization-boundary-changed') return boundaryCause(w, intent.boundary);
  if (issue.code === 'source-identity-changed') return controlCause(s, since, 'control', Boolean(issue.fields?.length) && issue.fields.every(field => field === 'peerRevision'));
  return Object.hasOwn(REVOKED, issue.code) ? issue.code : 'control';
}
function stageCall(w, s, r, native, args) {
  const started = r.wakeTurn, now = boundary(w);
  if (!started) throw uiError("error.wake.turnAuthorizationUnconfirmed");
  if (started.boundary !== now) throw revokedError(boundaryCause(w, started.boundary));
  if (native?.valid?.() === false) throw revokedError(controlCause(s, started.since, 'native-turn'));
  if (started.human !== humanProof(w, s)) throw revokedError(controlCause(s, started.since));
  const turn = r.wakeStagePending?.turnId === native?.turnId && r.wakeStagePending.nativeId === native?.nativeId ? r.wakeStagePending : null;
  const pending = turn?.calls.find(call => call.callId === native?.callId);
  if (pending) {
    if (pending.recipient === args?.recipient_id && pending.body === args?.message) return pending.promise.then(result => { const row = s.messages.find(m => m.id === result.id); return ['staged', 'not-sent'].includes(row?.wake?.status) ? result : { status: 'unconfirmed', id: result.id, message: '原登记已经撤销或结果未确认；不会重发。' }; });
    throw uiError("error.wake.turnAlreadyRequested");
  }
  // Any earlier call of the turn refuses everyone else's next, as before. For the butler, one that failed before
  // anything was registered does not count (a registered one is counted from its row in stageOnce).
  if (turn) {
    if (!isSteward(w, s)) throw uiError("error.wake.turnAlreadyRequested");
    stewardLimit(turn.calls.filter(call => !call.failed).map(call => call.recipient), args?.recipient_id);
  }
  const promise = stageOnce(w, s, r, native, args);
  const call = { callId: native?.callId, recipient: args?.recipient_id, body: args?.message, promise, failed: false };
  promise.catch(error => { call.failed = true; undelivered(w, s, r, args, error); });
  if (turn) turn.calls.push(call);
  else r.wakeStagePending = { nativeId: native?.nativeId, turnId: native?.turnId, calls: [call] };
  return promise;
}
async function stageOnce(w, s, r, native, args) {
  validateArgs(args);
  const turn = r.wakeTurn;
  if (!native || native.nativeId !== s.nativeId || native.turnId !== r.turnId || !turn || turn.nativeId !== native.nativeId || turn.turnId !== native.turnId ||
    typeof native.callId !== 'string' || !native.callId || native.callId.length > 160 || r.nativeInputRequired || s.approval || s.state !== 'working') throw uiError("error.wake.turnAuthorizationUnconfirmed");
  if (s.provider === 'claude' && (!native.promptId || native.promptId !== r.liveTurn?.promptId)) throw uiError("error.wake.claudePromptOriginUnconfirmed");
  if (args.recipient_id === s.id) throw uiError("error.wake.cannotWakeSelf");
  const replay = (s.messages || []).find(m => m.wake?.nativeId === native.nativeId && m.wake.callId === native.callId && m.wake.turnId !== native.turnId);
  if (replay) throw uiError("error.wake.nativeCallAlreadyRegistered");
  const ofTurn = (s.messages || []).filter(m => m.wake?.nativeId === native.nativeId && m.wake.turnId === native.turnId);
  const previous = ofTurn.find(m => m.wake.callId === native.callId);
  if (previous) {
    if (previous.wake.recipientId === args.recipient_id && previous.wake.body === args.message && previous.wake.status === 'staged') return { status: 'staged', id: previous.id, message: '同一调用已登记，尚未投递；不会重复登记。' };
    throw uiError("error.wake.turnAlreadyRegistered");
  }
  // Every row of the turn counts, a refused one too: each message is tried once.
  if (ofTurn.length) {
    if (!isSteward(w, s)) throw uiError("error.wake.turnAlreadyRegistered");
    stewardLimit(ofTurn.map(m => m.wake.recipientId), args.recipient_id);
  }
  const intent = { id: randomUUID(), nativeId: native.nativeId, turnId: native.turnId, callId: native.callId, senderId: s.id, senderName: s.name,
    sourceProof: sourceIdentity(w, s), recipientId: args.recipient_id, body: args.message, boundary: turn.boundary, time: Date.now(), status: 'staged' };
  const issue = sourceIssue(w, s, r, intent);
  if (issue) throw revokedError(issueCause(w, s, issue, intent, turn.since));
  const since = causeSeq;
  if (!w.peerRunner) throw uiError("error.wake.backendUnsupported");
  const target = await w.peerRunner.lookupWake(args.recipient_id, {
    id: intent.id, boundary: intent.boundary, senderId: s.id, senderNativeId: s.nativeId });
  const after = sourceIssue(w, s, r, intent);
  if (after) throw revokedError(issueCause(w, s, after, intent, since));
  if (native.valid?.() === false || r.turnId !== native.turnId) throw revokedError(controlCause(s, since, 'native-turn'));
  intent.targetKey = target.key; intent.targetProof = identity(target.session);
  const quiet = quietWindow(w, target.key), refused = target.readiness?.status === 'not-sent';
  let full = false, same = false;
  if (quiet && (!refused || QUIET_PASSING.includes(target.readiness.reasonUiMessage?.key))) {
    if (target.key === ownKey(w)) same = true;
    else if (quietRows(w) >= QUIET_HELD_MAX) full = true;
    else intent.quietWindow = { id: quiet.id, deadline: quiet.deadline };
  }
  const row = { id: intent.id, role: 'system', kind: 'notice', name: '自动消息', origin: 'agent-wake-intent', text: `发给 ${target.session.name} 的消息已登记，尚未投递。\n${args.message}`, status: 'complete', time: intent.time, wake: intent };
  row.uiMessage = displayMessage({ version: 1, key: 'notice.wake.registered', params: { name: target.session.name, body: args.message } }, 'notice.', row.text) || undefined;
  row.uiNameMessage = uiActivity('notice.wake.name')[1];
  // The butler's limit can open before this turn ends: the message stays staged, and is held then if it has not.
  const waits = !intent.quietWindow && !full && !same && refused && holdable(w, intent, target.readiness);
  if (same) refusedNotice(row, quietSame());
  else if (full) refusedNotice(row, quietFull());
  else if (!intent.quietWindow && refused && !waits) refusedNotice(row, target.readiness);
  s.messages.push(row);
  // T-137: also in the spaces they share, for the person to see. Must never throw: it runs between the
  // push and the save, and an unsaved staged wake would still be sent when the turn ends.
  w.mirrorWake?.(s, intent, target.session, row);
  try { durable(w); } catch (e) { intent.status = 'unconfirmed'; row.text = `自动消息未能保存，没有派发。\n${args.message}`; row.uiMessage = displayMessage({ version: 1, key: 'notice.wake.saveFailed', params: { body: args.message } }, 'notice.', row.text) || undefined; throw e; }
  if (intent.status === 'not-sent') return { status: 'not-sent', id: intent.id, recipient_id: intent.recipientId, message: row.text };
  if (intent.quietWindow) {
    const minutes = Math.max(1, Math.ceil((quiet.deadline - Date.now()) / 60000));
    return { status: 'staged', id: intent.id, readiness: 'held', message: `已保存，尚未投递。收件方的后台在安静窗口（迁移 ${shortKey(target.key)}）中，窗口最长还有约 ${minutes} 分钟，结束后由 NAW 再送一次；你不要等待或重试。真人可随时撤销。` };
  }
  if (waits) {
    // About when: the ones held here for the same recipient go first, a minute apart from the earliest, and none
    // before its limit opens.
    const queued = heldRows(w).filter(({ row: other }) => other.wake.recipientId === intent.recipientId).map(({ row: other }) => other.wake.retryAt);
    const at = Math.max(target.readiness.retryAt, queued.length ? Math.min(...queued) + COOLDOWN * queued.length : 0);
    const minutes = Math.max(1, Math.ceil((at - Date.now()) / 60000));
    return { status: 'staged', id: intent.id, readiness: 'held', message: `已保存，尚未投递。收件方 60 秒内刚收过一条自动消息：已排着，约 ${minutes} 分钟后由 NAW 再送一次（当前原生回合结束时限制已过就直接送）；你不要等待或重试。真人可随时撤销。` };
  }
  const readiness = target.readiness?.status === 'ready' ? 'checked' : 'deferred';
  // To the butler, the turn's end can still meet its limit; then the message is held instead of tried only once.
  const once = stillButler(w, intent) ? '当前原生回合正常结束后尝试投递；那时收件方若 60 秒内刚收过一条自动消息，NAW 先存着，限制过了再送一次；' : '当前原生回合正常结束后只尝试一次；';
  return { status: 'staged', id: intent.id, readiness, message: `已保存，尚未投递。${once}不要等待或重试。真人可随时撤销。` + (readiness === 'deferred' ? ' 收件后台不支持即时就绪检查，尚未确认它能接收。' : '') };
}
// Why a wake staged in a turn was withdrawn when that turn's end was reported. T-141: `boundary` is a turn whose
// authority an input or permission boundary took mid-turn; steward step 2, batch 0: `incomplete`, one that ended
// without NAW being able to confirm it saw all of it.
const TURN_END_CANCELLED = Object.freeze({
  boundary: ['发送方这一轮中途有新的输入或权限确认', 'notice.wake.turnBoundaryCancelled'],
  incomplete: ['发送方这一轮的原生内容没能确认完整', 'notice.wake.turnIncompleteCancelled'],
  unreported: ['发送方上一轮的结束 NAW 没有看到，下一轮已经开始', 'notice.wake.turnUnreportedCancelled'],
  completed: ['原生回合已正常结束，但授权校验未通过', 'notice.wake.completedTurnRevoked'],
  other: ['原生回合未正常结束或授权已变化', 'notice.wake.turnCancelled'],
  // Item 2: a turn's messages after its first went out only as the butler's; at the turn's end NAW could not confirm the
  // sender still is (revoked, changed, or the designation unreadable).
  steward: ['这一轮结束时没能确认发送方还是大管家，只发第一条', 'notice.wake.stewardEnded'],
});
function complete(w, s, r, info) {
  // The turn's first registered message, whatever became of it; only the butler's turn has others.
  const first = (s.messages || []).find(m => m.wake?.nativeId === info.nativeId && m.wake.turnId === info.turnId);
  let steward = null;
  for (const row of s.messages || []) {
    const intent = row.wake;
    if (intent?.status !== 'staged' || intent.nativeId !== info.nativeId || intent.turnId !== info.turnId) continue;
    // Input can end Claude's sharing proof even when the native turn completed: the turn's wake authority stays.
    // Missing, failed and permission-boundary ends still cancel.
    const completed = info.status === 'completed' || info.status === 'boundary' && info.completedAfterInput === true;
    let issue = !completed ? { code: 'turn-not-completed' } : sourceIssue(w, s, r, intent), reason = info.status;
    if (!issue && row !== first && !(steward ??= isSteward(w, s))) { issue = { code: 'steward-role-ended' }; reason = 'steward'; }
    if (issue) {
      intent.cancellation = { ...issue, nativeStatus: info.status ?? null, at: Date.now() };
      const [why, key] = TURN_END_CANCELLED[Object.hasOwn(TURN_END_CANCELLED, reason) ? reason : 'other'];
      intent.status = 'cancelled'; row.text = `${why}；自动消息未投递。\n${intent.body}`; row.uiMessage = displayMessage({ version: 1, key, params: { body: intent.body } }, 'notice.', row.text) || undefined; durable(w); continue;
    }
    deliver(w, row);
  }
}
// A window open now on the recipient's backend: the row is held for it, or refused as at registration. true: nothing
// goes now. Also for a row held for the butler's minute before the window opened (the reviewer, 11-23).
function keepQuiet(w, row) {
  const intent = row.wake, quiet = quietWindow(w, intent.targetKey);
  if (!quiet) return false;
  if (intent.targetKey === ownKey(w)) refusedNotice(row, quietSame());
  else if (!intent.quietWindow && quietRows(w) >= QUIET_HELD_MAX) refusedNotice(row, quietFull());
  else { intent.quietWindow = { id: quiet.id, deadline: quiet.deadline }; holdQuiet(w, row, quiet); }
  return true;
}
// At the turn's end: held while the recipient's backend is in a quiet window (one staged before it opened too),
// otherwise one attempt.
function deliver(w, row) {
  if (!keepQuiet(w, row)) return transfer(w, row, Boolean(row.wake.quietWindow));
  try { durable(w); } finally { arm(w); }
}
// One delivery attempt. Persist before it: reopening never replays sending/staged/held rows. Only an explicit refusal
// before anything was reserved or written (not-sent) can be held and offered again; an uncertain outcome never is.
function transfer(w, row, readdress = false) {
  const intent = row.wake;
  intent.status = 'sending'; durable(w);
  // A recipient that cannot be found again was never offered it: not sent.
  const located = readdress ? relocate(w, intent).then(() => null, error => notSent(error)) : Promise.resolve(null);
  return located.then(refused => refused || w.peerRunner.transferWake(intent)).then(result => {
    if (holdable(w, intent, result)) hold(w, row, result.retryAt);
    else if (result.status === 'not-sent') refusedNotice(row, result);
    else {
      intent.status = result.status; row.text = `发给原会话的自动消息：${result.status === 'submitted' ? '原生已接收' : '接收结果未确认'}。\n${intent.body}`; row.uiMessage = displayMessage({ version: 1, key: result.status === 'submitted' ? 'notice.wake.submitted' : 'notice.wake.unconfirmed', params: { body: intent.body } }, 'notice.', row.text) || undefined;
      // It took one: the others held here for it wait out its new minute instead of being refused for it first.
      if (result.status === 'submitted') {
        for (const other of heldRows(w)) if (other.row.wake.recipientId === intent.recipientId) other.row.wake.retryAt = Math.max(other.row.wake.retryAt, Date.now() + COOLDOWN);
        answeredButler(w, intent);
      }
    }
    durable(w);
  }).catch(error => { intent.status = 'unconfirmed'; intent.settledAt = Date.now(); row.text = `自动消息未确认投递；不会重发。\n${error.message}\n${intent.body}`; row.uiMessage = displayMessage(uiError('error.wake.deliveryUnconfirmed', { reason: error.message, body: intent.body }, { cause: error, param: 'reason' }).uiMessage, 'error.', row.text) || undefined; w.changed(); w.persist(); })
    .finally(() => arm(w));
}
function heldRows(w) {
  const rows = [];
  for (const s of w.sessions.values()) for (const row of s.messages || []) if (row.wake?.status === 'held') rows.push({ s, row });
  return rows;
}
function hold(w, row, retryAt) {
  const intent = row.wake, now = Date.now();
  intent.status = 'held'; intent.heldAt ??= now;
  const s = w.sessions.get(intent.senderId);
  if (s) intent.heldProof ??= identity(s);
  // Never sooner than a second from now, never later than the limit itself allows.
  intent.retryAt = Math.min(Math.max(retryAt, now + 1000), now + COOLDOWN + 1000);
  row.text = `收件方 60 秒内刚收过一条自动消息；这条先存着，限制过了再试一次。\n${intent.body}`;
  row.uiMessage = displayMessage({ version: 1, key: 'notice.wake.held', params: { body: intent.body } }, 'notice.', row.text) || undefined;
}
// The one timer: at the earliest time a held message may go. One recipient takes one attempt at a time, oldest first.
function arm(w) {
  clearTimeout(w.wakeHoldTimer); w.wakeHoldTimer = null; w.wakeHoldAt = null;
  if (w.closed) return;
  const rows = heldRows(w), sending = new Set();
  for (const s of w.sessions.values()) for (const m of s.messages || []) if (['sending', 'consumed'].includes(m.wake?.status)) sending.add(m.wake.recipientId);
  const next = Math.min(...rows.filter(({ row }) => !sending.has(row.wake.recipientId)).map(({ row }) => row.wake.retryAt));
  if (!Number.isFinite(next)) return;
  w.wakeHoldAt = next;
  // A timer callback that threw would end the whole service: it never does.
  w.wakeHoldTimer = setTimeout(() => { try { retryHeld(w); } catch { /* The rows stay held and shown. */ } }, Math.max(0, next - Date.now()));
  w.wakeHoldTimer.unref?.();
}
function dropHeld(w, row, issue) {
  const intent = row.wake;
  intent.status = 'cancelled'; intent.cancellation = { ...issue, at: Date.now() };
  row.text = `存着的自动消息没有补送：补送前核对发送方和授权没通过。\n${intent.body}`;
  row.uiMessage = displayMessage({ version: 1, key: 'notice.wake.heldCancelled', params: { body: intent.body } }, 'notice.', row.text) || undefined;
  try { durable(w); } catch { /* Shown now; the next save keeps it. */ }
}
function heldIssue(s, intent) {
  const current = identity(s);
  if (JSON.stringify(current) === JSON.stringify(intent.heldProof)) return null;
  return { code: 'source-identity-changed', fields: Object.keys(current).filter(key => JSON.stringify(current[key]) !== JSON.stringify(intent.heldProof?.[key])) };
}
function retryHeld(w) {
  clearTimeout(w.wakeHoldTimer); w.wakeHoldTimer = null; w.wakeHoldAt = null;
  if (w.closed) return;
  const sending = new Set(), due = Object.create(null);
  for (const s of w.sessions.values()) for (const m of s.messages || []) if (['sending', 'consumed'].includes(m.wake?.status)) sending.add(m.wake.recipientId);
  for (const { s, row } of heldRows(w)) {
    const intent = row.wake, first = due[intent.recipientId];
    if (intent.retryAt > Date.now() || sending.has(intent.recipientId) || first && first.row.wake.time <= intent.time) continue;
    due[intent.recipientId] = { s, row };
  }
  let pending = false;
  try {
    for (const { s, row } of Object.values(due)) {
      const r = w.runtimes.get(s.id);
      let issue;
      // The sender as complete() checks it at the turn's end, and the butler role; the recipient's side checks everything again.
      // A message held for a quiet window was never only the butler's to keep.
      const quietly = Boolean(row.wake.quietWindow);
      try { issue = !r ? { code: 'source-runtime-changed' } : !w.peerRunner ? { code: 'backend-unsupported' } : sourceIssue(w, s, r, row.wake) || heldIssue(s, row.wake) || (quietly || stillButler(w, row.wake) ? null : { code: 'steward-role-ended' }); }
      catch (error) { issue = { code: 'authorization-unreadable', reason: error.message }; }
      if (issue) { dropHeld(w, row, issue); continue; }
      if (keepQuiet(w, row)) { try { durable(w); } catch { /* Shown now; a later attempt checks storage first. */ } continue; }
      // A save that fails before the attempt sends nothing.
      try { transfer(w, row, quietly); pending = true; } catch (error) { dropHeld(w, row, { code: 'storage-unavailable', reason: error.message }); }
    }
  } finally { if (!pending) arm(w); }
}
function cancelParticipant(w, id, reason, reasonUiMessage) {
  // Name the boundary, so a cancelled wake can be traced (T-100: the 11-02 secretary wake).
  const why = typeof reason === 'string' && reason ? `（${reason.slice(0, 120)}）` : '';
  for (const row of w.sessions.get(id)?.messages || []) if (['staged', 'held'].includes(row.wake?.status)) {
    w.edited?.(w.sessions.get(id)); row.wake.status = 'cancelled'; row.wake.settledAt = Date.now(); row.text = `原生观察或控制边界已变化${why}；自动消息未投递。\n${row.wake.body}`; row.uiMessage = displayMessage({ version: 1, key: 'notice.wake.observationBoundaryReason', params: { why, body: row.wake.body } }, 'notice.', row.text) || undefined;
    const rawReason = typeof reason === 'string' ? reason.slice(0, 120) : '';
    const cause = displayMessage(reasonUiMessage, 'notice.', rawReason);
    if (cause && why) row.uiMessage = displayMessage({ version: 1, key: 'notice.wake.observationBoundaryKnownReason', params: { reason: rawReason, body: row.wake.body }, cause, causeParam: 'reason' }, 'notice.', row.text) || row.uiMessage;
  }
}
function take(w, spec) {
  const s = w.sessions.get(spec?.senderId), r = s && w.runtimes.get(s.id), row = s?.messages.find(m => m.id === spec.id), intent = row?.wake;
  if (!intent || intent.status !== 'sending' || intent.recipientId !== spec.recipientId || intent.targetKey !== spec.targetKey || !r || !sourceValid(w, s, r, intent)) throw uiError("error.wake.credentialInvalid");
  intent.status = 'consumed'; durable(w); return { ...intent };
}
function budgetView(s) {
  const raw = s.wakeBudget, humanRevision = s.wakeHumanRevision || 0;
  const lastAt = Number.isSafeInteger(raw?.lastAt) ? raw.lastAt : 0;
  if (raw?.version === 2 && raw.humanRevision === humanRevision && raw.senders && typeof raw.senders === 'object' && !Array.isArray(raw.senders)) return raw;
  // A pre-v2 flat streak has no sender. Keep only its receiver-wide cooldown; do not assign its streak to anyone.
  return { version: 2, lastAt, humanRevision, senders: {} };
}
function budgetSender(budget, senderId, senderKey) {
  const candidates = [budget.senders[senderKey], senderKey !== senderId ? budget.senders[senderId] : null].filter(Boolean);
  return candidates.reduce((best, value) => !best || (value.streak || 0) > (best.streak || 0) ? value : best, null);
}
function budgetIssue(s, id, senderId, senderKey = senderId) {
  const budget = budgetView(s);
  // Old senders omit senderId from preflight. Keep the receiver-wide cooldown usable; actual receive still requires the id.
  if (senderId === undefined) return budget.lastAt && Date.now() - budget.lastAt < COOLDOWN ? ['error.wake.recipientCooldown'] : null;
  if (typeof senderId !== 'string' || !senderId) return ['error.wake.recipientUnreachable'];
  if (typeof senderKey !== 'string' || !senderKey) return ['error.wake.recipientUnreachable'];
  const sender = budgetSender(budget, senderId, senderKey), streak = sender?.streak || 0;
  if (sender?.id === id) return streak <= MAX_STREAK ? null : ['error.wake.consecutiveLimit'];
  if (streak >= MAX_STREAK) return ['error.wake.consecutiveLimit'];
  if (budget.lastAt && Date.now() - budget.lastAt < COOLDOWN) return ['error.wake.recipientCooldown'];
  return null;
}
function budgetAllows(s, id, senderId, senderKey) {
  return !budgetIssue(s, id, senderId, senderKey);
}
function reserveBudget(s, id, senderId, senderKey = senderId) {
  if (typeof senderId !== 'string' || !senderId || typeof senderKey !== 'string' || !senderKey) return null;
  const budget = budgetView(s), streak = budgetSender(budget, senderId, senderKey)?.streak || 0;
  const senders = { ...budget.senders };
  if (senderKey !== senderId) delete senders[senderId];
  s.wakeBudget = { version: 2, lastAt: Date.now(), humanRevision: s.wakeHumanRevision || 0,
    senders: { ...senders, [senderKey]: { id, streak: streak + 1 } } };
  return s.wakeBudget;
}
// The person, 2026-11-23: a member's message the designated butler took clears the butler's run to that member. Both
// live here, in the member's backend: receive() counts the butler's messages on this session, transfer() sees this one
// taken. The receiver-wide minute (lastAt) and every other sender's run stay.
function clearSenderStreak(s, senderId, senderKey = senderId) {
  const budget = budgetView(s), senders = { ...budget.senders };
  let cleared = false;
  for (const key of new Set([senderKey, senderId])) {
    if (senders[key]?.streak) { senders[key] = { ...senders[key], streak: 0 }; cleared = true; }
  }
  if (cleared) s.wakeBudget = { ...budget, senders };
  return cleared;
}
function answeredButler(w, intent) {
  const s = w.sessions.get(intent.senderId);
  if (s && stillButler(w, intent)) clearSenderStreak(s, intent.recipientId, intent.targetProof.nativeId);
}
function goalAllows(status) { return status === null || status === 'active' || status === 'complete'; }
async function nativeGoalStatus(s, r, valid, rpc = r.host?.rpc) {
  if (s.provider !== 'codex') return null;
  let result;
  try { result = await rpc?.call('thread/goal/get', { threadId: s.nativeId }); }
  catch (error) { if (error?.nativeGoalsDisabled === true) result = { goal: null }; else throw error; }
  if (!valid()) throw uiError('error.wake.humanOrRecipientChanged');
  if (!result || !Object.hasOwn(result, 'goal') || (result.goal !== null &&
      (result.goal?.threadId !== s.nativeId || !['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete'].includes(result.goal?.status))))
    throw uiError('error.wake.nativeGoalDisallows');
  return result.goal?.status ?? null;
}
// How a message reaches the recipient now (the wake proposal, item 1, 2026-11-12): a turn of its own when it is idle;
// in the middle of a turn, the native way the person's own input takes there: Claude's queue (read at the running
// turn's next tool boundary, or as its next turn) and Codex's steer into the running turn. null: neither is open.
function routeFor(s, r) {
  if (s.state === 'idle') return { mode: 'send' };
  if (s.state !== 'working' || s.approval || r.nativeInputRequired) return null;
  if (s.provider === 'claude' && r.queueAvailable === true && !r.pendingQueue) return { mode: 'queue' };
  if (s.provider === 'codex' && r.steerAvailable === true && !r.pendingSteer && typeof r.turnId === 'string' && r.turnId) return { mode: 'steer', turnId: r.turnId };
  return null;
}
// The first reason the recipient cannot take this message now, as its own key, or null. One key per cause (the wake
// proposal, item 4, 2026-11-12), so the sender and the person read 「正在干活」 rather than one sentence covering a
// changed identity, the switch, approval and the limit alike. Checked in the order the single condition had.
// `mode` is the way in (by default the one open now); with `tag`, an input of that mode already under way, which
// keeps its own native slot and, for steer, the turn it named (`turnId`).
function recipientIssue(w, s, r, intent, tag, mode = routeFor(s, r)?.mode, turnId) {
  if (w.closed || w.storageWarning) return ['error.wake.recipientUnreachable'];
  if (!enabled(w) || s.wakeDisabled) return ['error.wake.recipientDisabled'];
  if (boundary(w) !== intent.boundary) return ['error.wake.recipientBoundaryChanged'];
  if (!same(s, intent.targetProof)) return ['error.wake.recipientIdentityChanged'];
  if (w.runtimes.get(s.id) !== r || r.stopped || r.transportDisconnected || r.chatAvailable === false) return ['error.wake.recipientUnreachable'];
  // The 60-second limit first among the recipient's current states: a message it refuses is named for it even while
  // the one it just took is still on its way in, so the butler's can be held (option A).
  const budget = budgetIssue(s, intent.id, intent.senderId, intent.senderNativeId || intent.nativeId || intent.senderId);
  if (budget) return budget;
  if (mode === 'queue' || mode === 'steer') {
    if (s.approval || r.nativeInputRequired || s.state === 'approval') return ['error.wake.recipientAwaiting'];
    const slot = mode === 'queue' ? r.pendingQueue : r.pendingSteer;
    if (slot && slot !== tag) return ['error.wake.recipientInputPending'];
    // A queued message the running turn did not take at a tool boundary runs as its next turn: the turn may end first.
    const open = mode === 'queue' ? s.state === 'working' || (Boolean(tag) && s.state === 'idle') : s.state === 'working' && r.turnId === (turnId ?? r.turnId);
    if (!open) return ['error.wake.recipientUnreachable'];
    if (s.nativeContextPending) return ['error.wake.recipientInputPending'];
    if (r.nativeAbortRequest) return ['error.wake.recipientBusy', { name: s.name }];
    return null;
  }
  if (s.state !== 'idle') {
    if (s.approval || r.nativeInputRequired || s.state === 'approval') return ['error.wake.recipientAwaiting'];
    if (s.state !== 'working') return ['error.wake.recipientUnreachable'];
    return r.pendingQueue || r.pendingSteer ? ['error.wake.recipientInputPending'] : ['error.wake.recipientBusy', { name: s.name }];
  }
  if (s.pendingTag && s.pendingTag !== tag) return ['error.wake.recipientInputPending'];
  if (s.approval) return ['error.wake.recipientAwaiting'];
  if (s.nativeContextPending) return ['error.wake.recipientInputPending'];
  if (r.nativeInputRequired) return ['error.wake.recipientAwaiting'];
  if (r.pendingQueue) return ['error.wake.recipientInputPending'];
  if (r.nativeAbortRequest) return ['error.wake.recipientBusy', { name: s.name }];
  return null;
}
function eligible(w, s, r, intent, tag, mode, turnId) { return !recipientIssue(w, s, r, intent, tag, mode, turnId); }
function refuseRecipient(w, s, r, intent) {
  const issue = recipientIssue(w, s, r, intent);
  if (issue) throw Object.assign(uiError(...issue), issue[0] === 'error.wake.recipientCooldown' ? { cooldown: true } : {});
}
// This read-only check reserves nothing and is not delivery authority. The
// receiver checks the consumed, exact sender intent again at actual dispatch.
async function check(w, spec) {
  if (!spec || typeof spec.id !== 'string' || !spec.id || (spec.senderId !== undefined && (typeof spec.senderId !== 'string' || !spec.senderId)) ||
      (spec.senderNativeId !== undefined && (typeof spec.senderNativeId !== 'string' || !spec.senderNativeId)) ||
      typeof spec.recipientId !== 'string' || !spec.recipientId ||
      typeof spec.boundary !== 'string' || !spec.targetProof || typeof spec.targetProof !== 'object') throw uiError('error.wake.sourceInvalid');
  let s;
  try {
    s = w.get(spec.recipientId); const r = w.runtime(s.id);
    refuseRecipient(w, s, r, spec);
    if (s.provider === 'codex') {
      const status = await nativeGoalStatus(s, r, () => eligible(w, s, r, spec));
      if (!goalAllows(status)) throw uiError('error.wake.nativeGoalStateDisallows', { status });
    }
    return { status: 'ready' };
  } catch (error) { return notSent(error, holdFor(w, s, error)); }
}
async function receive(w, spec) {
  if (!spec || typeof spec.sourceKey !== 'string' || !readLayout(root(w)).entries.includes(spec.sourceKey) || typeof spec.id !== 'string' ||
      typeof spec.senderId !== 'string' || !spec.senderId) throw uiError("error.wake.sourceInvalid");
  const s = w.get(spec.recipientId), r = w.runtime(s.id);
  const proof = identity(s), generation = boundary(w);
  const intent = await w.peerRunner.takeWake(spec);
  let route;
  try {
    if (intent.id !== spec.id || intent.senderId !== spec.senderId || intent.recipientId !== s.id) throw uiError('error.wake.credentialInvalid');
    if (intent.boundary !== generation) throw uiError('error.wake.recipientBoundaryChanged');
    if (!same(s, proof)) throw uiError('error.wake.recipientIdentityChanged');
    refuseRecipient(w, s, r, intent);
    if (s.provider === 'codex') {
      const status = await nativeGoalStatus(s, r, () => eligible(w, s, r, intent));
      if (!goalAllows(status)) throw uiError('error.wake.nativeGoalStateDisallows', { status });
    }
    refuseRecipient(w, s, r, intent);
    route = routeFor(s, r);
  } catch (error) { return notSent(error, holdFor(w, s, error)); }
  reserveBudget(s, intent.id, intent.senderId, intent.nativeId);
  // The ticket holds the way chosen here: a message sent as a turn of its own stays one, and a midturn one keeps
  // its slot and turn. Every native step checks it again.
  const ticket = { intent, mode: route.mode, valid: tag => eligible(w, s, r, intent, tag, route.mode, route.turnId) };
  const text = `[Workspace message from ${intent.senderName} · ${intent.senderId} at ${new Date(intent.time).toISOString()}]\n${intent.body}`;
  durable(w);
  if (route.mode !== 'send') {
    let tag;
    // A refusal before native held it is not-sent, with its reason; an uncertain outcome stays an error (unconfirmed).
    try { tag = await w.wakeMidturn(s.id, text, ticket, route); } catch (error) { if (error?.notSent === true) return notSent(error); throw error; }
    return { status: s.messages.find(m => m.id === tag)?.status === 'submitted' ? 'submitted' : 'unconfirmed', tag };
  }
  const tag = await w.send(s.id, text, null, null, null, null, null, ticket);
  const row = s.messages.find(m => m.id === tag);
  return { status: row?.status === 'submitted' ? 'submitted' : 'unconfirmed', tag };
}
module.exports = { CAPABILITY, PREFLIGHT, COOLDOWN, MAX_STREAK, routeFor, snapshot, enabled, boundary, budgetAllows, reserveBudget, clearSenderStreak, nativeGoalStatus, goalAllows, revoke, cause, initialize, human, cancelParticipant, setPolicy, nativeStart, messageInput, sourceIdentity, isSteward, stage, complete, take, receive, check, validateArgs, root, retryHeld, unbound };
