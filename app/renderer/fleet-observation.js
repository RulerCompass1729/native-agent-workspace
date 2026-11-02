// Observed native events are a partial view, never a fleet inventory or a
// completion/permission signal. Reading them must not launch or query an agent.
(function (target) {
  function observedFleet(record, connected = true) {
    const entries = new Map();
    const live = connected && !record.backendUnavailable && !record.transportDisconnected &&
      !['disconnected', 'recoverable', 'ended', 'stopping'].includes(record.state);
    for (const event of record.fleet || []) {
      let id, status = 'unknown';
      if (event.event === 'subAgentActivity' && event.nativeId) {
        id = event.nativeId;
        if (event.kind === 'started') status = 'running';
        if (event.kind === 'completed') status = 'completed';
      } else if (['SubagentStart', 'SubagentStop'].includes(event.event) && event.id) {
        id = event.id; status = event.event === 'SubagentStart' ? 'running' : 'completed';
      } else if (event.event === 'thread/started' && event.id) id = event.id;
      // TaskCompleted is a task event, not proof that its teammate is idle.
      // Interaction/tool-call acknowledgement is not child-turn completion.
      if (!id) continue;
      const before = entries.get(id);
      entries.delete(id); // A later lifecycle event belongs in the recent list.
      entries.set(id, { id, name: event.name || before?.name || '原生子任务',
        model: event.model || before?.model || '', time: event.time,
        status: live && event.stale === false ? status : 'unknown' });
    }
    const children = [...entries.values()];
    return { children, observed: (record.fleet || []).length > 0,
      running: children.filter(c => c.status === 'running').length,
      unknown: children.filter(c => c.status === 'unknown').length };
  }
  // The latest native turn-end report lists in-flight background work of the
  // process that sent it. Only whitelisted type labels are shown, never task text.
  // A Claude turn that ended without a report (for example an interrupt) leaves it unconfirmed.
  const workLabels = { shell: '命令', subagent: '子 agent', monitor: '监视', workflow: '工作流' };
  function backgroundWork(record, connected = true) {
    const live = connected && !record.backendUnavailable && !record.transportDisconnected &&
      !['disconnected', 'recoverable', 'ended', 'stopping'].includes(record.state);
    const unconfirmed = live && record.backgroundStale === true;
    const reported = live && !unconfirmed && Number.isSafeInteger(record.background) && record.background >= 0;
    const count = reported ? record.background : 0;
    const kinds = new Map();
    // Type detail only when it accounts for every reported item.
    if (Array.isArray(record.backgroundKinds) && record.backgroundKinds.length === count) for (const kind of record.backgroundKinds) {
      const label = Object.hasOwn(workLabels, kind) ? workLabels[kind] : '其他';
      kinds.set(label, (kinds.get(label) || 0) + 1);
    }
    const detail = [...kinds].map(([label, n]) => kinds.size > 1 ? `${label} ${n}` : label).join('、');
    return { reported, unconfirmed, count, text: count ? `后台任务在跑 · ${count} 项${detail ? `（${detail}）` : ''}` : unconfirmed ? '后台状态待核对' : '' };
  }
  // A later turn-end report settles child records that were already unconfirmed.
  // It never ends a child observed as running: teammates may not be listed in that report.
  function currentFleet(record, connected = true) {
    const fleet = observedFleet(record, connected), work = backgroundWork(record, connected);
    const after = Number.isFinite(record.backgroundAt) ? record.backgroundAt : -Infinity;
    const children = fleet.children.filter(child => !(work.reported && child.status === 'unknown' && Number.isFinite(child.time) && child.time <= after));
    return { ...fleet, children, settled: children.length < fleet.children.length, work,
      running: children.filter(c => c.status === 'running').length, unknown: children.filter(c => c.status === 'unknown').length };
  }
  function fleetStatus(record, base, connected = true) {
    const fleet = currentFleet(record, connected), idle = record.state === 'idle';
    // A mixed fleet keeps both facts: running children never hide unknown ones.
    const children = (fleet.running ? ` · ${fleet.running} 个子任务进行中` : '') + (fleet.unknown ? ' · 子任务状态待核对' : '');
    if (idle && fleet.work.count) return fleet.work.text;
    if (idle && fleet.work.unconfirmed) return fleet.work.text + children;
    if (!fleet.observed || fleet.settled && !fleet.children.length) return base;
    return (idle ? '主会话就绪' : base) + children;
  }
  // Green means idle with nothing reported in flight. Codex has no turn-end report, so its dot is unchanged.
  function workTone(record, connected = true) {
    if (record.state !== 'idle' || record.provider === 'codex') return '';
    const fleet = currentFleet(record, connected);
    return fleet.work.count || fleet.running ? 'bg-work' : fleet.work.unconfirmed || fleet.unknown ? 'bg-unknown' : '';
  }
  const api = { observedFleet, currentFleet, fleetStatus, backgroundWork, workTone };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else target.nativeWorkspaceFleet = api;
})(typeof window === 'undefined' ? globalThis : window);
