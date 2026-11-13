const { uiError, uiActivity, setWarning } = require('./ui-errors.cjs');
const { displayMessage } = require('./ui-locale.js');
// One explicit native intent, transferred once through the existing local services.
// No timer, replay, model router, permission decision or native goal write lives here.
const fs = require('node:fs'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const { readLayout } = require('./service-layout.cjs');
const spaces = require('./collaboration-spaces.cjs');
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
function revoke(w) {
  const file = marker(w, 'agent-wake-boundary'), temp = file + '.' + randomUUID() + '.tmp';
  let previous = null, saved = false;
  try { previous = boundary(w); } catch { /* Missing/invalid markers are never authority. */ }
  try {
    safeFile(file);
    fs.writeFileSync(temp, randomUUID(), { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, file);
    w.wakeGuardFailure = null; delete w.wakeGuardFailureUiMessage; saved = true;
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
  for (const s of w.sessions.values()) for (const m of s.messages || []) if (m.wake?.status === 'staged') { m.wake.status = 'cancelled'; m.text = `真人操作或交接边界已变化；自动消息未投递。\n${m.wake.body}`; m.uiMessage = displayMessage({ version: 1, key: 'notice.wake.humanBoundary', params: { body: m.wake.body } }, 'notice.', m.text) || undefined; }
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
  const saved = revoke(w); w.changed(); w.persist();
  if (!saved) throw Object.assign(Error(w.wakeGuardFailure), { uiMessage: w.wakeGuardFailureUiMessage });
  if (w.storageWarning) throw uiError("error.wake.settingsIncomplete");
  return true;
}
function snapshot(w) { try { return { enabled: enabled(w), ...(w.wakeGuardFailure ? { warning: w.wakeGuardFailure, warningUiMessage: w.wakeGuardFailureUiMessage || null } : {}) }; } catch { const fallback = uiError('error.warning.wakeGuardUnavailable'); return { enabled: false, unavailable: true, warning: w.wakeGuardFailure || fallback.message, warningUiMessage: w.wakeGuardFailure ? w.wakeGuardFailureUiMessage || null : fallback.uiMessage }; } }
// The sender's human-control state when its turn started. A person taking over,
// typing, queueing or steering later in that turn withdraws the turn's wake authority.
const humanProof = s => s ? JSON.stringify([s.owner ?? null, s.controlRevision || 0, s.connectionRevision || 0]) : null;
function nativeStart(w, r, info, s) {
  // A wake still staged from an earlier turn of this native session: that turn's end never reached NAW (a failed turn
  // with no capacity report, a lost end row), so "after its turn ends normally" can no longer happen. Withdrawn now,
  // with that reason, instead of staying 已登记 for good (steward step 2).
  try {
    const earlier = new Set((s?.messages || []).filter(m => m.wake?.status === 'staged' && m.wake.nativeId === info.nativeId && m.wake.turnId !== info.turnId).map(m => m.wake.turnId));
    for (const turnId of earlier) complete(w, s, r, { nativeId: info.nativeId, turnId, status: 'unreported' });
  } catch { /* Withdrawn at the next start, or at reopen. */ }
  try { r.wakeTurn = { nativeId: info.nativeId, turnId: info.turnId, boundary: boundary(w), human: humanProof(s) }; }
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
  if (!same(s, intent.sourceProof)) {
    const current = identity(s);
    // Record field names only, never owner IDs, process details or draft contents.
    return { code: 'source-identity-changed', fields: Object.keys(current).filter(key => JSON.stringify(current[key]) !== JSON.stringify(intent.sourceProof?.[key])) };
  }
  return null;
}
function sourceValid(w, s, r, intent) { return !sourceIssue(w, s, r, intent); }
function durable(w) { w.changed(); w.persist(); if (w.storageWarning) throw uiError("error.wake.recordSaveFailed"); }
function notSent(error) {
  return { status: 'not-sent', reason: error.message, reasonUiMessage: displayMessage(error.uiMessage) || null };
}
function refusedNotice(row, result) {
  row.wake.status = 'not-sent';
  row.text = `自动消息没有发出；不会自动重发。\n${result.reason}\n${row.wake.body}`;
  const cause = { message: result.reason, uiMessage: result.reasonUiMessage };
  row.uiMessage = displayMessage(uiError('error.wake.notSent', { reason: result.reason, body: row.wake.body }, { cause, param: 'reason' }).uiMessage, 'error.', row.text) || undefined;
}
function validateArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k => !['recipient_id', 'message'].includes(k)) ||
    typeof args.recipient_id !== 'string' || !args.recipient_id || args.recipient_id.length > 100 ||
    typeof args.message !== 'string' || !args.message.trim() || args.message.length > 6000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(args.message)) throw uiError("error.handoffRecipientAndBodyRequired");
}
// The designated butler (大管家) as main.cjs stewardCaller names it: the very session and native session the person's
// designation names now (after logged rotations), in no space. Anything else, a designation that cannot be read
// included, is not, and keeps one message a turn. Read from the same file main.cjs keeps, only when it matters.
const STEWARD_RECIPIENTS = 4;
function isSteward(w, s) {
  try {
    const steward = new (require('./steward-role.cjs').StewardRole)(root(w)).current();
    return Boolean(steward && s && steward.sessionId === s.id && steward.nativeId === s.nativeId && !s.archived && spaces.roomIds(s).length === 0);
  } catch { return false; }
}
// One automatic message a turn; the butler, one to each of up to four different recipients (the wake proposal, item 2,
// 2026-11-12: 「②只给指定大管家（每收件方 1 条、最多 4 个），其他 agent 不变」). `taken`: the recipients the turn already
// holds a message, or a call under way, for. Called only once the sender is known to be the butler.
function stewardLimit(taken, recipient) {
  if (taken.includes(recipient)) throw uiError("error.wake.turnRecipientRepeated");
  if (new Set(taken).size >= STEWARD_RECIPIENTS) throw uiError("error.wake.turnRecipientLimit", { limit: STEWARD_RECIPIENTS });
}
function stage(w, s, r, native, args) {
  if (r.wakeTurn?.boundary !== boundary(w) || native?.valid?.() === false || r.wakeTurn.human !== humanProof(s)) throw uiError("error.wake.turnRevokedByHuman");
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
  promise.catch(() => { call.failed = true; });
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
  const earlier = (s.messages || []).filter(m => m.wake?.nativeId === native.nativeId && m.wake.turnId === native.turnId);
  const previous = earlier.find(m => m.wake.callId === native.callId);
  if (previous) {
    if (previous.wake.recipientId === args.recipient_id && previous.wake.body === args.message && previous.wake.status === 'staged') return { status: 'staged', id: previous.id, message: '同一调用已登记，尚未投递；不会重复登记。' };
    throw uiError("error.wake.turnAlreadyRegistered");
  }
  // Every row of the turn counts, a refused one too: each message is tried once.
  if (earlier.length) {
    if (!isSteward(w, s)) throw uiError("error.wake.turnAlreadyRegistered");
    stewardLimit(earlier.map(m => m.wake.recipientId), args.recipient_id);
  }
  const intent = { id: randomUUID(), nativeId: native.nativeId, turnId: native.turnId, callId: native.callId, senderId: s.id, senderName: s.name,
    sourceProof: identity(s), recipientId: args.recipient_id, body: args.message, boundary: turn.boundary, time: Date.now(), status: 'staged' };
  if (!sourceValid(w, s, r, intent)) throw uiError("error.wake.turnRevokedByHumanOrSetting");
  if (!w.peerRunner) throw uiError("error.wake.backendUnsupported");
  const target = await w.peerRunner.lookupWake(args.recipient_id, { id: intent.id, boundary: intent.boundary });
  if (native.valid?.() === false || !sourceValid(w, s, r, intent) || r.turnId !== native.turnId) throw uiError("error.wake.authorizationInvalidated");
  intent.targetKey = target.key; intent.targetProof = identity(target.session);
  const row = { id: intent.id, role: 'system', kind: 'notice', name: '自动消息', origin: 'agent-wake-intent', text: `发给 ${target.session.name} 的消息已登记，尚未投递。\n${args.message}`, status: 'complete', time: intent.time, wake: intent };
  row.uiMessage = displayMessage({ version: 1, key: 'notice.wake.registered', params: { name: target.session.name, body: args.message } }, 'notice.', row.text) || undefined;
  row.uiNameMessage = uiActivity('notice.wake.name')[1];
  if (target.readiness?.status === 'not-sent') refusedNotice(row, target.readiness);
  s.messages.push(row);
  // T-137: also in the spaces they share, for the person to see. Must never throw: it runs between the
  // push and the save, and an unsaved staged wake would still be sent when the turn ends.
  w.mirrorWake?.(s, intent, target.session, row);
  try { durable(w); } catch (e) { intent.status = 'unconfirmed'; row.text = `自动消息未能保存，没有派发。\n${args.message}`; row.uiMessage = displayMessage({ version: 1, key: 'notice.wake.saveFailed', params: { body: args.message } }, 'notice.', row.text) || undefined; throw e; }
  if (intent.status === 'not-sent') return { status: 'not-sent', id: intent.id, recipient_id: intent.recipientId, message: row.text };
  const readiness = target.readiness?.status === 'ready' ? 'checked' : 'deferred';
  return { status: 'staged', id: intent.id, readiness, message: '已保存，尚未投递。当前原生回合正常结束后只尝试一次；不要等待或重试。真人可随时撤销。' + (readiness === 'deferred' ? ' 收件后台不支持即时就绪检查，尚未确认它能接收。' : '') };
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
  // Item 2: a turn's messages after its first went out only as the butler's; the role is gone when the turn ends.
  steward: ['发送方已不是大管家，这一轮只发第一条', 'notice.wake.stewardEnded'],
});
function complete(w, s, r, info) {
  // The turn's first registered message, whatever became of it; only the butler's turn has others.
  const first = (s.messages || []).find(m => m.wake?.nativeId === info.nativeId && m.wake.turnId === info.turnId);
  let steward = null;
  for (const row of s.messages || []) {
    const intent = row.wake;
    if (intent?.status !== 'staged' || intent.nativeId !== info.nativeId || intent.turnId !== info.turnId) continue;
    let issue = info.status !== 'completed' ? { code: 'turn-not-completed' } : sourceIssue(w, s, r, intent), reason = info.status;
    if (!issue && row !== first && !(steward ??= isSteward(w, s))) { issue = { code: 'steward-role-ended' }; reason = 'steward'; }
    if (issue) {
      intent.cancellation = { ...issue, nativeStatus: info.status ?? null, at: Date.now() };
      const [why, key] = TURN_END_CANCELLED[Object.hasOwn(TURN_END_CANCELLED, reason) ? reason : 'other'];
      intent.status = 'cancelled'; row.text = `${why}；自动消息未投递。\n${intent.body}`; row.uiMessage = displayMessage({ version: 1, key, params: { body: intent.body } }, 'notice.', row.text) || undefined; durable(w); continue;
    }
    intent.status = 'sending'; durable(w);
    // Persist before the one transfer. Reopening never replays sending/staged rows.
    w.peerRunner.transferWake(intent).then(result => {
      if (result.status === 'not-sent') refusedNotice(row, result);
      else { intent.status = result.status; row.text = `发给原会话的自动消息：${result.status === 'submitted' ? '原生已接收' : '接收结果未确认'}。\n${intent.body}`; row.uiMessage = displayMessage({ version: 1, key: result.status === 'submitted' ? 'notice.wake.submitted' : 'notice.wake.unconfirmed', params: { body: intent.body } }, 'notice.', row.text) || undefined; }
      durable(w);
    }).catch(error => { intent.status = 'unconfirmed'; row.text = `自动消息未确认投递；不会重发。\n${error.message}\n${intent.body}`; row.uiMessage = displayMessage(uiError('error.wake.deliveryUnconfirmed', { reason: error.message, body: intent.body }, { cause: error, param: 'reason' }).uiMessage, 'error.', row.text) || undefined; w.changed(); w.persist(); });
  }
}
function cancelParticipant(w, id, reason, reasonUiMessage) {
  // Name the boundary, so a cancelled wake can be traced (T-100: the 11-02 secretary wake).
  const why = typeof reason === 'string' && reason ? `（${reason.slice(0, 120)}）` : '';
  for (const row of w.sessions.get(id)?.messages || []) if (row.wake?.status === 'staged') {
    row.wake.status = 'cancelled'; row.text = `原生观察或控制边界已变化${why}；自动消息未投递。\n${row.wake.body}`; row.uiMessage = displayMessage({ version: 1, key: 'notice.wake.observationBoundaryReason', params: { why, body: row.wake.body } }, 'notice.', row.text) || undefined;
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
function budgetAllows(s, id) {
  const budget = s.wakeBudget || {}, streak = budget.humanRevision === (s.wakeHumanRevision || 0) ? budget.streak || 0 : 0;
  return budget.id === id ? streak <= MAX_STREAK : streak < MAX_STREAK && (!budget.lastAt || Date.now() - budget.lastAt >= COOLDOWN);
}
function reserveBudget(s, id) {
  const old = s.wakeBudget || {}, streak = old.humanRevision === (s.wakeHumanRevision || 0) ? old.streak || 0 : 0;
  s.wakeBudget = { id, lastAt: Date.now(), streak: streak + 1, humanRevision: s.wakeHumanRevision || 0 };
  return s.wakeBudget;
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
  if (mode === 'queue' || mode === 'steer') {
    if (s.approval || r.nativeInputRequired || s.state === 'approval') return ['error.wake.recipientAwaiting'];
    const slot = mode === 'queue' ? r.pendingQueue : r.pendingSteer;
    if (slot && slot !== tag) return ['error.wake.recipientInputPending'];
    // A queued message the running turn did not take at a tool boundary runs as its next turn: the turn may end first.
    const open = mode === 'queue' ? s.state === 'working' || (Boolean(tag) && s.state === 'idle') : s.state === 'working' && r.turnId === (turnId ?? r.turnId);
    if (!open) return ['error.wake.recipientUnreachable'];
    if (s.nativeContextPending) return ['error.wake.recipientInputPending'];
    if (r.nativeAbortRequest) return ['error.wake.recipientBusy', { name: s.name }];
    if (!budgetAllows(s, intent.id)) return ['error.wake.recipientCooldown'];
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
  if (!budgetAllows(s, intent.id)) return ['error.wake.recipientCooldown'];
  return null;
}
function eligible(w, s, r, intent, tag, mode, turnId) { return !recipientIssue(w, s, r, intent, tag, mode, turnId); }
function refuseRecipient(w, s, r, intent) { const issue = recipientIssue(w, s, r, intent); if (issue) throw uiError(...issue); }
// This read-only check reserves nothing and is not delivery authority. The
// receiver checks the consumed, exact sender intent again at actual dispatch.
async function check(w, spec) {
  if (!spec || typeof spec.id !== 'string' || !spec.id || typeof spec.recipientId !== 'string' || !spec.recipientId ||
      typeof spec.boundary !== 'string' || !spec.targetProof || typeof spec.targetProof !== 'object') throw uiError('error.wake.sourceInvalid');
  try {
    const s = w.get(spec.recipientId), r = w.runtime(s.id);
    const budget = s.wakeBudget || {};
    if (budget.humanRevision === (s.wakeHumanRevision || 0) && budget.streak >= MAX_STREAK) throw uiError('error.wake.consecutiveLimit');
    refuseRecipient(w, s, r, spec);
    if (s.provider === 'codex') {
      const status = await nativeGoalStatus(s, r, () => eligible(w, s, r, spec));
      if (!goalAllows(status)) throw uiError('error.wake.nativeGoalStateDisallows', { status });
    }
    return { status: 'ready' };
  } catch (error) { return notSent(error); }
}
async function receive(w, spec) {
  if (!spec || typeof spec.sourceKey !== 'string' || !readLayout(root(w)).entries.includes(spec.sourceKey) || typeof spec.id !== 'string' || typeof spec.senderId !== 'string') throw uiError("error.wake.sourceInvalid");
  const s = w.get(spec.recipientId), r = w.runtime(s.id);
  const proof = identity(s), generation = boundary(w);
  const intent = await w.peerRunner.takeWake(spec);
  let route;
  try {
    const budget = s.wakeBudget || {};
    if (budget.humanRevision === (s.wakeHumanRevision || 0) && budget.streak >= MAX_STREAK) throw uiError("error.wake.consecutiveLimit");
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
  } catch (error) { return notSent(error); }
  reserveBudget(s, intent.id);
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
module.exports = { CAPABILITY, PREFLIGHT, COOLDOWN, MAX_STREAK, routeFor, snapshot, enabled, boundary, budgetAllows, reserveBudget, nativeGoalStatus, goalAllows, revoke, initialize, human, cancelParticipant, setPolicy, nativeStart, stage, complete, take, receive, check, validateArgs, root };
