// Moves an old backend's sessions onto the current code (T-122). Only idle
// sessions are stopped. The old service is retired after its own stop results
// are confirmed, the current code starts on the same store, and only the
// sessions this flow stopped are reconnected. NAW sends nothing to them.
'use strict';
const fs = require('node:fs'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { connectService } = require('./service-connection.cjs');
const { processMayBeAlive, processIdentity } = require('./platform.cjs');

const RECORD = 'backend-switch.json', SETTINGS = 'backend-switch-settings.json';
const STATE_LABELS = { working: '正在工作', starting: '正在连接', stopping: '正在结束', approval: '在等确认', disconnected: '连接已断开，原生回合可能仍在运行', error: '状态异常' };
const CODEX_ENDS = 'Codex 不报告后台工作；更新会结束这个后台里的 Codex 程序，它的后台终端和子 agent 也会结束';

function waiting(record) {
  if (record.pendingTag) return '有一条输入的接收结果还在核对';
  if (record.approval || record.approvals?.length || record.approvalOverflow) return '有待处理的权限确认';
  if (record.claudeQuestion || record.question || record.pendingQuestion) return '有待回答的问题';
  if (record.capacityRecovery?.status === 'scheduled') return '已安排满载后自动继续';
  if (record.nativeContextPending || record.recovering) return '原生上下文正在变化';
  if (record.worktreePreparation && record.worktreePreparation.status !== 'ready') return 'Git 副本准备结果未确认';
  return '';
}
// Child agents and teammates seen through native events. The turn-end report
// does not list teammates, so a child last seen starting may still be running.
function children(record) {
  const latest = new Map();
  // Agent Teams teammates appear through these events; their end is not reported to the lead.
  const team = (record.fleet || []).some(event => ['TeammateIdle', 'TaskCompleted'].includes(event.event));
  for (const event of record.fleet || []) {
    const id = event.event === 'subAgentActivity' ? event.nativeId : ['SubagentStart', 'SubagentStop', 'thread/started'].includes(event.event) ? event.id : null;
    if (!id) continue;
    const ended = event.event === 'SubagentStop' || (event.event === 'subAgentActivity' && event.kind === 'completed');
    latest.set(id, ended ? null : event.stale === false ? 'current' : 'earlier');
  }
  const open = [...latest.values()];
  return { current: open.filter(v => v === 'current').length, earlier: open.filter(v => v === 'earlier').length, team };
}
// What would still be unknown if this idle session were stopped now. Empty
// means the runtime proved it; otherwise only an explicit click may proceed.
function unproven(record, fleet) {
  if (record.provider === 'codex') return CODEX_ENDS;
  if (typeof record.terminalInputPending !== 'boolean') return '这个后台的版本无法确认原生终端里没有没发出的字，也无法确认上次回合结束后没有新开后台任务';
  if (record.terminalInputPending) return '这个原生进程启动后在终端里输入过，可能有没发出的字';
  if (fleet.team) return '观察到团队成员（Agent Teams），团队是否已结束无法确认';
  if (fleet.earlier) return '以前观察到的子 agent 或团队成员是否结束未确认';
  // No turn since this process started (stale false, nothing reported) means nothing was started.
  const fresh = record.backgroundStale === false && record.background === null && record.scheduled === null;
  if (!fresh && (record.backgroundStale !== false || !Number.isSafeInteger(record.background) || !Number.isSafeInteger(record.scheduled))) return '上次回合结束后还没有新的后台任务报告';
  return '';
}
function sessionPlan(record, state, running = new Set()) {
  const name = record.name || record.provider || record.id;
  if (state === 'background') return { carry: true };
  if (['ended', 'recoverable'].includes(state)) {
    if (processMayBeAlive(record.processIdentity) || processMayBeAlive(record.serverIdentity)) return { block: `${name}：之前的原生进程可能仍在运行` };
    return { carry: true };
  }
  if (state !== 'idle') return { block: `${name}${STATE_LABELS[state] || `状态为 ${state}`}` };
  const wait = waiting(record); if (wait) return { block: `${name}：${wait}` };
  if (!record.nativeId) return { block: `${name}：还没有可恢复的原生身份` };
  if (!['claude', 'codex'].includes(record.provider)) return { block: `${name}：不支持的会话类型` };
  if (running.has(record.id)) return { block: `${name}：协作空间里有正在进行的自动接力` };
  if (record.provider === 'claude') {
    for (const [count, what] of [[record.background, '后台任务在跑'], [record.scheduled, '有定时唤醒']]) if (Number.isSafeInteger(count) && count > 0) return { block: `${name}：${what} · ${count} 项` };
  }
  const fleet = children(record);
  if (fleet.current) return { block: `${name}：子 agent 或团队成员可能还在运行（${fleet.current} 个）` };
  const reason = unproven(record, fleet);
  return { stop: { id: record.id, nativeId: record.nativeId, provider: record.provider, name, owner: record.owner || null }, auto: !reason, reason: reason ? `${name}：${reason}` : '' };
}
// Sessions in a running relay anywhere in this backend's own state.
function runningIn(state) {
  const ids = new Set();
  for (const room of [state.room, ...(Array.isArray(state.rooms) ? state.rooms : [])]) if (room?.run?.status === 'running') for (const id of room.run.ids || []) ids.add(id);
  return ids;
}
function backendPlan(state, sessionState = record => record.state, running = new Set()) {
  if (state.storageWarning) return { ready: false, auto: false, reason: '原记录存在保存异常，请先解决本地保存问题。', stops: [] };
  if (!['atomicShutdown', 'resume'].every(cap => state.capabilities?.includes(cap))) return { ready: false, auto: false, reason: '这个早期后台不支持安全的一步更新。', stops: [] };
  if (!Number.isSafeInteger(state.servicePid) || state.servicePid < 2) return { ready: false, auto: false, reason: '后台没有报告进程号，不能确认要结束的是哪个后台。', stops: [] };
  const busy = new Set([...running, ...runningIn(state)]), stops = [], blocks = [], unprovenReasons = [];
  for (const record of state.sessions || []) {
    const plan = sessionPlan(record, sessionState(record), busy);
    if (plan.block) blocks.push(plan.block);
    else if (plan.stop) { stops.push(plan.stop); if (!plan.auto) unprovenReasons.push(plan.reason); }
  }
  // Blocked by its sessions (not by the backend itself): the reason names them (T-131).
  if (blocks.length) return { ready: false, auto: false, blocked: true, reason: `等空闲后更新：${blocks.join('；')}。`, stops };
  return { ready: true, auto: stops.length > 0 && unprovenReasons.length === 0, reason: unprovenReasons.join('；'), stops,
    endsCodex: stops.some(s => s.provider === 'codex') };
}
const samePlan = (a, b) => JSON.stringify(a.stops.map(s => [s.id, s.nativeId, s.provider])) === JSON.stringify(b.stops.map(s => [s.id, s.nativeId, s.provider]));

function readSettings(dataDir) {
  try { const value = JSON.parse(fs.readFileSync(path.join(dataDir, SETTINGS), 'utf8')); return { auto: value?.auto !== false }; }
  catch { return { auto: true }; }
}
function atomicWrite(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.rmSync(temp, { force: true }); fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, file);
}
function writeSettings(dataDir, auto) { atomicWrite(path.join(dataDir, SETTINGS), { format: 1, auto: auto === true }); return readSettings(dataDir); }
// One record per backend: the sessions a move ended that are not reconnected yet.
function readRecords(dataDir) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dataDir, RECORD), 'utf8'));
    if (value?.format !== 2 || !value.backends || typeof value.backends !== 'object') return {};
    return Object.fromEntries(Object.entries(value.backends).filter(([, r]) => r && Array.isArray(r.sessions)));
  } catch { return {}; }
}
function writeRecord(dataDir, key, value) { atomicWrite(path.join(dataDir, RECORD), { format: 2, backends: { ...readRecords(dataDir), [key]: value } }); }
function clearRecord(dataDir, key) {
  const backends = readRecords(dataDir); delete backends[key];
  if (Object.keys(backends).length) atomicWrite(path.join(dataDir, RECORD), { format: 2, backends }); else fs.rmSync(path.join(dataDir, RECORD), { force: true });
}

// The old service's own guard refuses to shut down while a Codex session is
// only disconnected, so retiring it may need a signal. The signal goes only to
// a process proven to be this store's service: the lock, the service's own
// report and its command line must all agree.
function serviceProcess(directory, pid, commandLine) {
  const lock = Number(fs.readFileSync(path.join(directory, 'service.lock'), 'utf8'));
  if (lock !== pid) throw Error('后台进程记录不一致；没有结束任何进程。');
  const command = commandLine(pid);
  if (typeof command !== 'string' || !command.includes(path.join(directory, 'runtimes') + path.sep) || !/daemon\.cjs/.test(command)) throw Error('后台进程无法确认属于这个连接；没有结束任何进程。');
  return processIdentity(pid);
}
const psCommand = pid => execFileSync('/bin/ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
async function waitGone(directory, pid, identity, ms = 15000) {
  for (let i = 0; i < ms / 100; i++) {
    if (!processMayBeAlive(identity || { pid }) && !fs.existsSync(path.join(directory, 'service.lock'))) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error('旧后台尚未确认关闭；没有启动新后台。');
}

async function switchBackend({ dataDir, key, executablePath, expected, ensure, owner, applicationVersion = process.env.NAW_APP_VERSION,
  sessionState, running = () => new Set(), requireAuto = false, commandLine = psCommand, signal = (pid, name) => process.kill(pid, name), now = Date.now }) {
  const directory = path.join(dataDir, key), stopped = [];
  const effective = record => sessionState ? sessionState(record) : record.state;
  // Each session is reconnected as its own owner, so its window keeps control.
  const resumeAs = async session => {
    const who = session.owner || owner; if (!who) throw Error('没有可接回的窗口。');
    const connection = await connectService(directory, who);
    try { await connection.call('resume', session.id); } finally { connection.close(); }
  };
  const keep = list => writeRecord(dataDir, key, { phase: 'stopped', failedAt: now(), sessions: list });
  let client = await connectService(directory, 'backend-switch'), state, plan, pid, identity;
  try {
    state = await client.call('initial');
    plan = backendPlan(state, effective, running());
    // What the person confirmed (or the tick selected) must still be exactly what is unproven now.
    if (!plan.ready || (requireAuto && !plan.auto) || (expected && (!samePlan(plan, expected) || plan.auto !== expected.auto || plan.reason !== expected.reason)) || state.runtimeVersion === applicationVersion) throw Error('后台或会话状态已变化；没有结束任何会话。');
    // Prove which process would be retired before ending anything.
    pid = state.servicePid; identity = serviceProcess(directory, pid, commandLine);
  } catch (error) { client.close(); throw error; }
  try {
    for (const session of plan.stops) {
      const snapshot = await client.call('initial'), current = snapshot.sessions.find(s => s.id === session.id);
      const check = current && sessionPlan(current, effective(current), new Set([...running(), ...runningIn(snapshot)]));
      if (!check?.stop || check.stop.nativeId !== session.nativeId || (requireAuto && !check.auto)) throw Error(`${session.name} 的状态已变化；停止更新。`);
      // The record names a session before its stop is requested, never one that was not stopped.
      stopped.push(session); writeRecord(dataDir, key, { phase: 'stopping', startedAt: now(), sessions: stopped }); await client.call('stop', session.id);
      const after = (await client.call('initial')).sessions.find(s => s.id === session.id);
      if (!['ended', 'disconnected'].includes(after?.state) || after.nativeId !== session.nativeId) throw Error(`${session.name} 没有确认断开；停止更新。`);
    }
    state = await client.call('initial');
    for (const record of state.sessions) {
      const ours = stopped.some(s => s.id === record.id);
      const ok = ours ? (record.provider === 'codex' ? ['ended', 'disconnected'] : ['ended']).includes(record.state) && !(record.provider === 'claude' && processMayBeAlive(record.processIdentity))
        : sessionPlan(record, record.state).carry;
      if (!ok) throw Error(`${record.name || record.id} 的状态已变化；停止更新。`);
    }
    if (state.servicePid !== pid || processIdentity(pid)?.started !== identity?.started) throw Error('后台进程已变化；停止更新。');
    if (!state.sessions.every(s => ['ended', 'background'].includes(s.state))) serviceProcess(directory, pid, commandLine);
  } catch (error) {
    // Put back what this flow stopped, on the same old service and owners.
    const back = [];
    for (const session of stopped) { try { await resumeAs(session); back.push(session.id); } catch {} }
    client.close();
    if (back.length === stopped.length) clearRecord(dataDir, key); else keep(stopped.filter(s => !back.includes(s.id)));
    throw error;
  }
  // From here on, any failure names every stopped session for the person to continue.
  try {
    writeRecord(dataDir, key, { phase: 'restarting', startedAt: now(), sessions: stopped });
    // The old guard refuses shutdown while a Codex session is only disconnected;
    // only then is the proven service process signalled, with the same cleanup.
    if (state.sessions.every(s => ['ended', 'background'].includes(s.state))) { await client.call('shutdown'); client.close(); }
    else { client.close(); signal(pid, 'SIGTERM'); }
    await waitGone(directory, pid, identity);
    for (const record of state.sessions) if (record.provider === 'codex' && processMayBeAlive(record.serverIdentity)) {
      for (let i = 0; i < 50 && processMayBeAlive(record.serverIdentity); i++) await new Promise(resolve => setTimeout(resolve, 100));
      if (processMayBeAlive(record.serverIdentity)) throw Error('旧后台的 Codex 程序尚未退出；没有启动新后台。');
    }
    await ensure(dataDir, executablePath, key);
    const fresh = await connectService(directory, 'backend-switch-verify');
    try {
      const next = await fresh.call('initial');
      if (next.runtimeVersion !== applicationVersion || !stopped.every(session => {
        const record = next.sessions.find(s => s.id === session.id);
        return record && record.nativeId === session.nativeId && ['ended', 'recoverable'].includes(record.state);
      })) throw Error('新后台没有按原身份接上这些会话。');
    } finally { fresh.close(); }
  } catch (error) { client.close(); keep(stopped); throw error; }
  writeRecord(dataDir, key, { phase: 'resuming', startedAt: now(), sessions: stopped });
  const resumed = [], left = [];
  for (const session of stopped) { try { await resumeAs(session); resumed.push(session.id); } catch { left.push(session); } }
  if (left.length) keep(left); else clearRecord(dataDir, key);
  return { key, resumed, left: left.map(s => s.id) };
}

module.exports = { backendPlan, sessionPlan, switchBackend, readSettings, writeSettings, readRecords, clearRecord, RECORD, SETTINGS };
