// Observed native events are a partial view, never a fleet inventory or a
// completion/permission signal. Reading them must not launch or query an agent.
(function (target) {
  const locale = typeof module !== 'undefined' && module.exports ? require('../ui-locale.js') : target.nativeWorkspaceLocale;
  const defaultText = (key, params) => locale.format('zh', key, params);
  function observedFleet(record, connected = true, text = defaultText) {
    text ||= defaultText;
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
      entries.set(id, { id, name: event.name || before?.name || text('fleet.childFallback'),
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
  const workLabels = { shell: 'fleet.work.shell', subagent: 'fleet.work.subagent', monitor: 'fleet.work.monitor', workflow: 'fleet.work.workflow', other: 'fleet.work.other' };
  function backgroundWork(record, connected = true, text = defaultText) {
    text ||= defaultText;
    const live = connected && !record.backendUnavailable && !record.transportDisconnected &&
      !['disconnected', 'recoverable', 'ended', 'stopping'].includes(record.state);
    const unconfirmed = live && record.backgroundStale === true;
    const reported = live && !unconfirmed && Number.isSafeInteger(record.background) && record.background >= 0;
    const count = reported ? record.background : 0;
    const kinds = new Map();
    // Type detail only when it accounts for every reported item.
    if (Array.isArray(record.backgroundKinds) && record.backgroundKinds.length === count) for (const reportedKind of record.backgroundKinds) {
      const kind = Object.hasOwn(workLabels, reportedKind) ? reportedKind : 'other';
      kinds.set(kind, (kinds.get(kind) || 0) + 1);
    }
    const detail = [...kinds].map(([kind, n]) => { const label = text(workLabels[kind]); return kinds.size > 1 ? `${label} ${n}` : label; }).join(text('context.rosterSeparator'));
    return { reported, unconfirmed, count, text: count ? text('fleet.workRunning', { count, detail: detail ? text('fleet.workDetail', { detail }) : '' }) : unconfirmed ? text('fleet.workUnconfirmed') : '' };
  }
  // A later turn-end report settles child records that were already unconfirmed.
  // It never ends a child observed as running: teammates may not be listed in that report.
  function currentFleet(record, connected = true, text = defaultText) {
    const fleet = observedFleet(record, connected, text), work = backgroundWork(record, connected, text);
    const after = Number.isFinite(record.backgroundAt) ? record.backgroundAt : -Infinity;
    const children = fleet.children.filter(child => !(work.reported && child.status === 'unknown' && Number.isFinite(child.time) && child.time <= after));
    return { ...fleet, children, settled: children.length < fleet.children.length, work,
      running: children.filter(c => c.status === 'running').length, unknown: children.filter(c => c.status === 'unknown').length };
  }
  // `text` renders catalog keys in the display language (T-60); without it the Chinese originals stay.
  function goalStatus(record, connected = true, text = defaultText) {
    text ||= defaultText;
    const empty = { text: '', tone: '' };
    if (record.provider !== 'codex' || record.archived || typeof record.nativeId !== 'string' || !record.nativeId || record.nativeGoal == null) return empty;
    const goal = record.nativeGoal;
    if (goal.status === null && goal.known !== false) return empty;
    const keys = { active: 'goalStatus.active', paused: 'goalStatus.paused', blocked: 'goalStatus.blocked',
      usageLimited: 'goalStatus.usageLimited', budgetLimited: 'goalStatus.budgetLimited', complete: 'goalStatus.complete' };
    const live = connected && !record.backendUnavailable && !record.transportDisconnected && !record.nativeContextPending &&
      !['disconnected', 'recoverable', 'ended', 'stopping'].includes(record.state);
    if (!live || goal.known === false || goal.nativeId !== record.nativeId ||
        typeof goal.status !== 'string' || !Object.hasOwn(keys, goal.status) || !Number.isFinite(goal.observedAt)) return { text: text('goalStatus.unconfirmed'), tone: 'bg-unknown' };
    return { text: text(keys[goal.status]), tone: goal.status === 'active' ? 'goal-enabled' : goal.status === 'paused' ? 'bg-unknown'
      : ['blocked', 'usageLimited', 'budgetLimited'].includes(goal.status) ? 'goal-stopped' : '' };
  }
  function fleetStatus(record, base, connected = true, text = defaultText) {
    text ||= defaultText;
    const fleet = currentFleet(record, connected, text), idle = record.state === 'idle';
    // A mixed fleet keeps both facts: running children never hide unknown ones.
    const children = (fleet.running ? text('fleet.running', { count: fleet.running }) : '') + (fleet.unknown ? text('fleet.unknown') : '');
    const status = idle && fleet.work.count ? fleet.work.text : idle && fleet.work.unconfirmed ? fleet.work.text + children
      : !fleet.observed || fleet.settled && !fleet.children.length ? base : (idle ? text('fleet.rootReady') : base) + children;
    const goal = goalStatus(record, connected, text);
    return status + (goal.text ? ' · ' + goal.text : '');
  }
  // Green means idle with nothing reported in flight. Codex has no turn-end report, so its dot is unchanged.
  function workTone(record, connected = true) {
    if (record.state !== 'idle') return '';
    if (record.provider === 'codex') return goalStatus(record, connected).tone;
    const fleet = currentFleet(record, connected);
    return fleet.work.count || fleet.running ? 'bg-work' : fleet.work.unconfirmed || fleet.unknown ? 'bg-unknown' : '';
  }
  const api = { observedFleet, currentFleet, fleetStatus, backgroundWork, workTone, goalStatus };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else target.nativeWorkspaceFleet = api;
})(typeof window === 'undefined' ? globalThis : window);
