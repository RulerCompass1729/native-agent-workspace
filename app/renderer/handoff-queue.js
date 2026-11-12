// What a space's queue panel says about the integration handoff (B6): where each delivered task
// stands, and what waits for the person. Display only: it reads the person's own view of the
// handoff, the space's queue and the sessions, and decides nothing.
(function (global) {
  const WAITS = { 'no-reply': 'noReply', 'person-intervened': 'typed', 'integrator-in-space': 'inSpace' };
  const nothing = () => ({ block: null, rows: Object.create(null), keep: [], orphans: [], need: 0 });
  const only = fault => ({ ...nothing(), block: { head: [], faults: [fault], none: null, stops: [], repository: null, ask: null } });
  // view: what the person's handoff entry gives for this space; failed: it could not be read;
  // queue: the space's tasks; sessions: every session; members: the ids of the sessions that can
  // take a task in this space; integrator: the designated session or null; unnamed: what a
  // member without a name is called; generic: the word for the integrator when none is designated.
  function model({ view = null, failed = false, queue = [], sessions = [], members = [], integrator = null, unnamed = '', generic = '' } = {}) {
    if (failed) return only({ key: 'queue.handoff.fault.view', params: {} });
    if (!view) return nothing();
    const name = id => sessions.find(session => session.id === id)?.name || '';
    // The handoff step could not be built: that is all there is to say.
    if (view.started !== true) return only({ key: 'queue.handoff.fault.notStarted', params: { message: view.engineFault?.message || '' } });
    const result = nothing();
    const items = view.items && typeof view.items === 'object' ? view.items : {};
    const open = view.summary?.handoff || null, waiting = view.waiting || null;
    const designated = integrator ? name(integrator.sessionId) || unnamed : '';
    // The integrator as a sentence calls it: by its session's name, or by the general word.
    const called = designated || generic;
    // Whoever holds the open handoff; it is the designated session unless the person chose another meanwhile.
    const who = open ? name(open.integrator?.sessionId) || unnamed : designated;
    const kind = !waiting ? '' : typeof waiting.reason === 'string' && waiting.reason.startsWith('conflict:') ? 'asks' : WAITS[waiting.reason] || 'other';
    // Nothing is handed out while there is no usable main repository, or while the integrator sits in a space.
    // (Both are read only once there is an integrator: before that, designating one is the step to take.)
    const unread = Boolean(view.repository) && (!view.repository.root || Boolean(view.repository.problem));
    const inSpace = Boolean(integrator) && (view.reasons || []).some(reason => reason?.reason === 'integrator-in-space');
    const counts = { queued: 0, handed: 0 };
    for (const [itemId, item] of Object.entries(items)) {
      const where = item.state === 'queued' ? (!integrator ? 'queuedNone' : unread || inSpace ? 'queuedStopped' : waiting ? 'queuedAsk' : open ? 'queuedBusy' : 'queuedNext')
        : item.state === 'returned' && item.redone ? 'redone' : item.state === 'asking' && kind !== 'asks' ? 'stalled' : item.state;
      if (item.state === 'queued') counts.queued += 1;
      if (item.state === 'handed' || item.state === 'asking') counts.handed += 1;
      const member = name(item.memberId) || item.memberName || unnamed;
      const row = { where, status: { key: 'queue.handoff.row.' + where, params: { name: member, who } }, why: null, action: null, more: null, need: false, front: false };
      if (where === 'held') {
        // With nobody designated there is no session to settle a conflict in and no button to press: the cause says only that.
        const why = item.why && !integrator && item.why.key === 'queue.handoff.why.conflict' ? { key: 'queue.handoff.why.conflictIdle', params: {} } : item.why;
        row.need = true; row.why = why ? { key: why.key, params: { ...why.params, who: called } } : null;
        // Sending it again means something once there is an integrator to send it to.
        const send = integrator ? { kind: 'send', key: item.key, label: { key: 'queue.handoff.send', params: { who: called } } } : null;
        // A hold that keeps the merge that was reported is checked again first: sending it again cannot verify a
        // merge that was already made. Sending stays beside it, for a check that can never be answered.
        // (For a merge made before the handoff began that second step is the person's own confirmation: a step of its own, called that.)
        const confirm = item.reason === 'merged-earlier';
        row.action = item.recheck ? { kind: confirm ? 'confirm' : 'recheck', key: item.key, label: { key: confirm ? 'queue.handoff.confirm' : 'queue.handoff.recheck', params: {} } } : send;
        row.more = item.recheck ? send : null;
      } else if (where === 'returned') {
        row.need = true; row.why = item.note ? { key: 'queue.handoff.why.returned', params: { note: item.note } } : { key: 'queue.handoff.why.returnedPlain', params: {} };
        // The task goes back to the member who did it while that member can take it; to anyone otherwise.
        const again = Boolean(item.memberId) && members.includes(item.memberId);
        row.action = { kind: 'redo', key: item.key, label: again ? { key: 'queue.handoff.redo', params: { name: member } } : { key: 'queue.handoff.redoAnyone', params: {} } };
      }
      // A row that needs the person, or that the handoff waiting for them is about, comes first when the panel opens
      // and stays in the list however old its task is.
      row.front = row.need || item.state === 'asking';
      result.rows[itemId] = row;
      if (row.need) result.need += 1;
      if (row.front) {
        if (queue.some(task => task.id === itemId)) result.keep.push(itemId);
        else result.orphans.push({ itemId, text: item.text || item.branch || '' });
      }
    }
    const faults = [];
    if (view.engineFault && !view.engineFault.recoveredAt) faults.push({ key: 'queue.handoff.fault.step', params: { message: view.engineFault.message || '' } });
    if (view.fault) faults.push({ key: 'queue.handoff.fault.record', params: { message: view.fault.message || '' } });
    // A space with no delivery says nothing about handoffs, unless the step itself is in trouble.
    if (!Object.keys(items).length && !faults.length) return result;
    const head = [];
    if (designated) head.push({ key: 'queue.handoff.integrator', params: { name: designated } });
    if (counts.handed && open?.status === 'sent') head.push({ key: 'queue.handoff.sent', params: { n: counts.handed, who } });
    if (integrator && counts.queued && !unread && !inSpace) head.push({ key: waiting ? 'queue.handoff.behindAsk' : 'queue.handoff.behind', params: { n: counts.queued, who } });
    // What pauses every handoff, and a handoff that waits for the person, are this space's concern (said with weight, and
    // counted) only while one of its own deliveries is on its way: in line, or with the integrator.
    const live = counts.queued + counts.handed > 0;
    const block = { head, faults, none: integrator ? null : { count: counts.queued }, stops: inSpace && live && kind !== 'inSpace' ? [{ key: 'queue.handoff.stopped.inSpace', params: {} }] : [], repository: null, ask: null };
    if (block.stops.length) result.need += 1;
    // Where merges are checked, once there is an integrator. Nothing chosen, or a folder that cannot be read now, stops every handoff: the person's to mend.
    if (view.repository && integrator) {
      block.repository = { root: view.repository.root || '', problem: view.repository.problem || '', need: unread && live, who: called };
      if (block.repository.need) result.need += 1;
    }
    if (waiting) {
      const keys = new Set(Object.values(items).map(item => item.key)), entries = waiting.entries || [];
      const about = entries.filter(entry => keys.has(entry.key)).map(entry => ({ text: entry.text || entry.branch || '', member: entry.memberName || '' }));
      // It is this space's when it is about one of its deliveries (then the person's steps are here), or when its
      // deliveries are in line behind it (then the panel says where it is dealt with).
      if (about.length || counts.queued) {
        block.ask = { kind, here: about.length > 0, handoffId: waiting.handoffId, sessionId: waiting.sessionId, name: name(waiting.sessionId) || who || unnamed, known: sessions.some(session => session.id === waiting.sessionId),
          question: kind === 'asks' ? waiting.question || '' : '', about,
          elsewhere: [...new Set(entries.filter(entry => !keys.has(entry.key) && typeof entry.roomId === 'string').map(entry => entry.roomId))] };
        result.need += 1;
      }
    }
    result.block = block;
    return result;
  }
  // The order of the rows: what needs the person first when the panel opens; while it stays open
  // nothing changes place, and a row that appears later goes to the end.
  function order(previous, ids, needs) {
    if (!previous) return [...ids.filter(id => needs.has(id)), ...ids.filter(id => !needs.has(id))];
    const present = new Set(ids), kept = previous.filter(id => present.has(id)), known = new Set(kept);
    return [...kept, ...ids.filter(id => !known.has(id))];
  }
  const api = { model, order };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.nativeWorkspaceHandoffQueue = api;
})(typeof window === 'undefined' ? globalThis : window);
