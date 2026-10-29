// One explicit native intent, transferred once through the existing local services.
// No timer, replay, model router, permission decision or native goal write lives here.
const fs = require('node:fs'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const { readLayout } = require('./service-layout.cjs');
const CAPABILITY = 'agentWakeV1', COOLDOWN = 60000, MAX_STREAK = 3;
function root(w) { return w.peerRunner?.root() || (/^[a-f0-9]{20}$/.test(path.basename(w.dataDir)) && path.basename(path.dirname(w.dataDir)) === 'backends' ? path.dirname(path.dirname(w.dataDir)) : w.dataDir); }
function marker(w, name) { return path.join(root(w), name); }
function safeFile(file) {
  try { const s = fs.lstatSync(file); if (!s.isFile() || s.uid !== process.getuid() || (s.mode & 0o077)) throw Error('自动消息设置权限未确认。'); return true; }
  catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}
function enabled(w) {
  fs.accessSync(root(w), fs.constants.W_OK);
  if (safeFile(marker(w, 'agent-wake-disabled'))) return false;
  const current = boundary(w);
  if (w.wakeGuardFailure) {
    if (current === w.wakeFailureBoundary) return false;
    // A later successful shared control change supersedes the failed boundary.
    w.wakeGuardFailure = null;
  }
  return true;
}
function boundary(w) {
  const file = marker(w, 'agent-wake-boundary');
  if (!safeFile(file)) throw Error('自动消息控制边界暂不可用。');
  const value = fs.readFileSync(file, 'utf8');
  if (!/^[a-f0-9-]{36}$/i.test(value)) throw Error('真人输入边界未能确认。');
  return value;
}
function revoke(w) {
  const file = marker(w, 'agent-wake-boundary'), temp = file + '.' + randomUUID() + '.tmp';
  let previous = null, saved = false;
  try { previous = boundary(w); } catch { /* Missing/invalid markers are never authority. */ }
  try {
    safeFile(file);
    fs.writeFileSync(temp, randomUUID(), { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, file);
    w.wakeGuardFailure = null; saved = true;
  } catch {
    // Automatic input fails closed, but a new optional feature cannot take
    // away human control when its own storage is unavailable.
    w.wakeGuardFailure = '自动消息守卫暂不可用，已停止自动消息；人工操作仍可使用。';
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
  for (const s of w.sessions.values()) for (const m of s.messages || []) if (m.wake?.status === 'staged') { m.wake.status = 'cancelled'; m.text = `真人操作或交接边界已变化；自动消息未投递。\n${m.wake.body}`; }
  return saved;
}
function initialize(w) {
  try { if (safeFile(marker(w, 'agent-wake-boundary'))) { boundary(w); return; } } catch { /* Revoke will disable only automatic input. */ }
  revoke(w);
}
function human(w, id) { const s = w.sessions.get(id); if (s) { s.wakeHumanRevision = (s.wakeHumanRevision || 0) + 1; } }
function setPolicy(w, id, value) {
  if (typeof value !== 'boolean') throw Error('自动消息开关无效。');
  if (id === null) {
    const file = marker(w, 'agent-wake-disabled');
    if (value) { if (safeFile(file)) fs.unlinkSync(file); }
    else if (!safeFile(file)) { const fd = fs.openSync(file, 'wx', 0o600); fs.closeSync(fd); }
  } else { const s = w.get(id); s.wakeDisabled = !value; human(w, id); }
  const saved = revoke(w); w.changed(); w.persist();
  if (!saved) throw Error(w.wakeGuardFailure);
  if (w.storageWarning) throw Error('自动消息设置未能完整保存；请核对后重试。');
  return true;
}
function snapshot(w) { try { return { enabled: enabled(w), ...(w.wakeGuardFailure ? { warning: w.wakeGuardFailure } : {}) }; } catch { return { enabled: false, unavailable: true, warning: w.wakeGuardFailure || '自动消息守卫暂不可用；人工操作仍可使用。' }; } }
function nativeStart(w, r, info) {
  try { r.wakeTurn = { nativeId: info.nativeId, turnId: info.turnId, boundary: boundary(w) }; }
  catch { r.wakeTurn = null; }
}
function identity(s) { return require('./peer-handoffs.cjs').identity(s); }
function same(s, expected) { return s && JSON.stringify(identity(s)) === JSON.stringify(expected); }
function sourceValid(w, s, r, intent) {
  return !w.closed && !w.storageWarning && w.runtimes.get(s.id) === r && !r.stopped && !r.transportDisconnected &&
    enabled(w) && boundary(w) === intent.boundary && same(s, intent.sourceProof);
}
function durable(w) { w.changed(); w.persist(); if (w.storageWarning) throw Error('自动消息记录未能保存；没有派发。'); }
function validateArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k => !['recipient_id', 'message'].includes(k)) ||
    typeof args.recipient_id !== 'string' || !args.recipient_id || args.recipient_id.length > 100 ||
    typeof args.message !== 'string' || !args.message.trim() || args.message.length > 6000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(args.message)) throw Error('请提供准确的接收者 ID 和不超过 6000 字符的完整消息。');
}
function stage(w, s, r, native, args) {
  if (r.wakeTurn?.boundary !== boundary(w) || native?.valid?.() === false) throw Error('真人操作已撤销本回合的自动消息授权。');
  const pending = r.wakeStagePending;
  if (pending?.turnId === native?.turnId && pending.nativeId === native?.nativeId) {
    if (pending.callId === native.callId && pending.recipient === args?.recipient_id && pending.body === args?.message) return pending.promise.then(result => { const row = s.messages.find(m => m.id === result.id); return row?.wake?.status === 'staged' ? result : { status: 'unconfirmed', id: result.id, message: '原登记已经撤销或结果未确认；不会重发。' }; });
    throw Error('这个原生回合已经请求过自动消息；未追加。');
  }
  const promise = stageOnce(w, s, r, native, args);
  r.wakeStagePending = { nativeId: native?.nativeId, turnId: native?.turnId, callId: native?.callId, recipient: args?.recipient_id, body: args?.message, promise };
  return promise;
}
async function stageOnce(w, s, r, native, args) {
  validateArgs(args);
  const turn = r.wakeTurn;
  if (!native || native.nativeId !== s.nativeId || native.turnId !== r.turnId || !turn || turn.nativeId !== native.nativeId || turn.turnId !== native.turnId ||
    typeof native.callId !== 'string' || !native.callId || native.callId.length > 160 || r.nativeInputRequired || s.approval || s.state !== 'working') throw Error('本次原生回合的自动消息授权未确认。');
  if (s.provider === 'claude' && (!native.promptId || native.promptId !== r.liveTurn?.promptId)) throw Error('本次 Claude 原生回合的 prompt 来源未确认。');
  if (args.recipient_id === s.id) throw Error('不能叫醒当前会话自身。');
  const replay = (s.messages || []).find(m => m.wake?.nativeId === native.nativeId && m.wake.callId === native.callId && m.wake.turnId !== native.turnId);
  if (replay) throw Error('这个原生调用已经登记过；不同回合不会重发。');
  const previous = (s.messages || []).find(m => m.wake?.nativeId === native.nativeId && m.wake.turnId === native.turnId);
  if (previous) {
    if (previous.wake.callId === native.callId && previous.wake.recipientId === args.recipient_id && previous.wake.body === args.message && previous.wake.status === 'staged') return { status: 'staged', id: previous.id, message: '同一调用已登记，尚未投递；不会重复登记。' };
    throw Error('这个原生回合已经登记过自动消息；未追加或重发。');
  }
  const intent = { id: randomUUID(), nativeId: native.nativeId, turnId: native.turnId, callId: native.callId, senderId: s.id, senderName: s.name,
    sourceProof: identity(s), recipientId: args.recipient_id, body: args.message, boundary: turn.boundary, time: Date.now(), status: 'staged' };
  if (!sourceValid(w, s, r, intent)) throw Error('真人操作或自动消息开关已撤销本回合授权。');
  if (!w.peerRunner) throw Error('本后台尚未接通自动消息；未派发。');
  const target = await w.peerRunner.lookupWake(args.recipient_id);
  if (native.valid?.() === false || !sourceValid(w, s, r, intent) || r.turnId !== native.turnId) throw Error('真人操作或原生回合变化使授权失效。');
  intent.targetKey = target.key; intent.targetProof = identity(target.session);
  const row = { id: intent.id, role: 'system', kind: 'notice', name: '自动消息', origin: 'agent-wake-intent', text: `发给 ${target.session.name} 的消息已登记，尚未投递。\n${args.message}`, status: 'complete', time: intent.time, wake: intent };
  s.messages.push(row);
  try { durable(w); } catch (e) { intent.status = 'unconfirmed'; throw e; }
  return { status: 'staged', id: intent.id, message: '已保存，尚未投递。当前原生回合正常结束后只尝试一次；不要等待或重试。真人可随时撤销。' };
}
function complete(w, s, r, info) {
  for (const row of s.messages || []) {
    const intent = row.wake;
    if (intent?.status !== 'staged' || intent.nativeId !== info.nativeId || intent.turnId !== info.turnId) continue;
    if (info.status !== 'completed' || !sourceValid(w, s, r, intent)) { intent.status = 'cancelled'; row.text = `原生回合未正常结束或授权已变化；自动消息未投递。\n${intent.body}`; durable(w); continue; }
    intent.status = 'sending'; durable(w);
    // Persist before the one transfer. Reopening never replays sending/staged rows.
    w.peerRunner.transferWake(intent).then(result => {
      intent.status = result.status; row.text = `发给原会话的自动消息：${result.status === 'submitted' ? '原生已接收' : '接收结果未确认'}。\n${intent.body}`;
      durable(w);
    }).catch(error => { intent.status = 'unconfirmed'; row.text = `自动消息未确认投递；不会重发。\n${error.message}\n${intent.body}`; w.changed(); w.persist(); });
  }
}
function cancelParticipant(w, id) {
  for (const row of w.sessions.get(id)?.messages || []) if (row.wake?.status === 'staged') {
    row.wake.status = 'cancelled'; row.text = `原生观察或控制边界已变化；自动消息未投递。\n${row.wake.body}`;
  }
}
function take(w, spec) {
  const s = w.sessions.get(spec?.senderId), r = s && w.runtimes.get(s.id), row = s?.messages.find(m => m.id === spec.id), intent = row?.wake;
  if (!intent || intent.status !== 'sending' || intent.recipientId !== spec.recipientId || intent.targetKey !== spec.targetKey || !r || !sourceValid(w, s, r, intent)) throw Error('自动消息凭据已撤销、已使用或来源未确认。');
  intent.status = 'consumed'; durable(w); return { ...intent };
}
function eligible(w, s, r, intent, tag) {
  const budget = s.wakeBudget || {}, streak = budget.humanRevision === (s.wakeHumanRevision || 0) ? budget.streak || 0 : 0;
  const reserved = budget.id === intent.id;
  return !w.closed && !w.storageWarning && enabled(w) && !s.wakeDisabled && boundary(w) === intent.boundary && same(s, intent.targetProof) &&
    w.runtimes.get(s.id) === r && !r.stopped && !r.transportDisconnected && r.chatAvailable !== false && s.state === 'idle' &&
    (!s.pendingTag || s.pendingTag === tag) && !s.approval && !s.nativeContextPending && !r.nativeInputRequired && !r.pendingQueue && !r.nativeAbortRequest &&
    (reserved ? streak <= MAX_STREAK : streak < MAX_STREAK && (!budget.lastAt || Date.now() - budget.lastAt >= COOLDOWN));
}
async function receive(w, spec) {
  if (!spec || typeof spec.sourceKey !== 'string' || !readLayout(root(w)).entries.includes(spec.sourceKey) || typeof spec.id !== 'string' || typeof spec.senderId !== 'string') throw Error('自动消息来源无效。');
  const s = w.get(spec.recipientId), r = w.runtime(s.id);
  const proof = identity(s), generation = boundary(w);
  const intent = await w.peerRunner.takeWake(spec);
  const budget = s.wakeBudget || {};
  if (budget.humanRevision === (s.wakeHumanRevision || 0) && budget.streak >= MAX_STREAK) throw Error('已达到连续 3 次自动消息上限；请真人核对原会话后再继续。');
  if (intent.id !== spec.id || intent.senderId !== spec.senderId || intent.recipientId !== s.id || intent.boundary !== generation || !same(s, proof) || !eligible(w, s, r, intent)) throw Error('接收者已忙碌、身份或真人授权已变化，或已达到自动消息限制。');
  if (s.provider === 'codex') {
    const result = await r.host?.rpc?.call('thread/goal/get', { threadId: s.nativeId }).catch(error => { if (error?.nativeGoalsDisabled === true) return { goal: null }; throw error; });
    if (!result || !Object.hasOwn(result, 'goal') || result.goal && !['active', 'complete'].includes(result.goal.status)) throw Error('原生 goal 状态未允许自动输入；未更改目标。');
    if (!eligible(w, s, r, intent)) throw Error('真人或接收者状态已变化。');
  }
  const old = s.wakeBudget || {}, streak = old.humanRevision === (s.wakeHumanRevision || 0) ? old.streak || 0 : 0;
  s.wakeBudget = { id: intent.id, lastAt: Date.now(), streak: streak + 1, humanRevision: s.wakeHumanRevision || 0 };
  const ticket = { intent, valid: tag => eligible(w, s, r, intent, tag) };
  const text = `[Workspace message from ${intent.senderName} · ${intent.senderId} at ${new Date(intent.time).toISOString()}]\n${intent.body}`;
  durable(w);
  const tag = await w.send(s.id, text, null, null, null, null, null, ticket);
  const row = s.messages.find(m => m.id === tag);
  return { status: row?.status === 'submitted' ? 'submitted' : 'unconfirmed', tag };
}
module.exports = { CAPABILITY, COOLDOWN, MAX_STREAK, snapshot, enabled, boundary, revoke, initialize, human, cancelParticipant, setPolicy, nativeStart, stage, complete, take, receive, validateArgs, root };
