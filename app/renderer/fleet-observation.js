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
  function fleetStatus(record, base, connected = true) {
    const fleet = observedFleet(record, connected);
    if (!fleet.observed) return base;
    const root = record.state === 'idle' ? '主会话就绪' : base;
    return root + (fleet.running ? ` · ${fleet.running} 个子任务进行中` : fleet.unknown ? ' · 子任务状态待核对' : '');
  }
  const api = { observedFleet, fleetStatus };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else target.nativeWorkspaceFleet = api;
})(typeof window === 'undefined' ? globalThis : window);
