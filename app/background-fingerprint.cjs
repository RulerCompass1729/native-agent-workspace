// Shared consent fingerprint: the execution boundary and inbox inspect the same
// metadata rules. This function performs no I/O and opens no background view.
const backgroundOperation = require('./background-operation.cjs');
const { roomIds } = require('./collaboration-spaces.cjs');
const { uiError } = require('./ui-errors.cjs');
// Archive refuses a busy session; the installer's in-flight wake gate reads the same rule.
function sessionBusy(target) {
  if (['starting', 'working', 'approval', 'stopping', 'background'].includes(target.state)) {
    return true;
  }
  return Boolean(target.activeTurnId || target.pendingTag || target.pendingQueue || target.pendingSteer || target.nativeInputRequired ||
    target.approval || target.nativeApproval?.requests?.length || target.nativeGoal?.status === 'active' ||
    target.background > 0 || target.scheduled > 0);
}
function fingerprint(command, { state, actor, context, roomState, sessionLabels, client, spaceManagers }) {
  const strings = new Set();
  const scan = v => { if (typeof v === 'string') strings.add(v); else if (Array.isArray(v)) v.forEach(scan); else if (v && typeof v === 'object') Object.values(v).forEach(scan); };
  scan(command.arguments);
  const maintenance = backgroundOperation.maintenanceAction(command.method, command.arguments, actor);
  if (maintenance) {
    const metadata = roomState.apply(state), auditRooms = new Set();
    if (maintenance === 'archiveSession') {
      const target = metadata.sessions.find(s => s.id === command.arguments[0]);
      if (target && sessionBusy(target)) throw uiError('error.planWorking');
    }
    const controlTarget = ['interrupt', 'pause', 'claim', 'terminal', 'terminalSnapshot', 'resize', 'answer', 'input', 'prepareInput', 'observe', 'stageImages', 'pasteNativeContent'].includes(command.method) ? command.arguments[0] : null;
    for (const s of state.sessions) if (s.id === actor.id || strings.has(s.id)) {
      roomIds(s).forEach(id => auditRooms.add(id));
      roomState.value.sessionArchives[s.id]?.rooms.forEach(r => auditRooms.add(r.id));
    }
    for (const r of metadata.rooms) if (strings.has(r.id)) auditRooms.add(r.id);
    if (['archiveRoom', 'restoreRoom', 'join', 'roomRename'].includes(command.method)) auditRooms.add('shared');
    if (command.method === 'spaceMerge') {
      const id = command.arguments[1]?.operationId;
      const batch = roomState.mergePreviews.get(id)?.batch || roomState.mergeRecord(id)?.merge?.batch;
      batch?.sources.forEach(r => auditRooms.add(r.id));
    }
    // Placement and archive state are consent targets. Background native
    // progress and the audit event itself must not invalidate consent.
    const placement = s => ({ id: s.id, nativeId: s.nativeId, connectionRevision: s.connectionRevision,
      nativeContextPending: s.nativeContextPending, archived: s.archived, roomIds: roomIds(s), placementRevision: s.placementRevision,
      memberRevision: s.memberRevision, roomMembershipRevisions: s.roomMembershipRevisions,
      // Confirmed input does not depend on which window holds the target; a takeover still moves controlRevision.
      ...(s.id === controlTarget && s.id !== actor.id ? { ...(command.method === 'input' ? {} : { owner: s.owner }), controlRevision: s.controlRevision, activeTurnId: s.activeTurnId,
        approvalId: s.approval?.requestId, nativeApprovalIds: s.nativeApproval?.requests?.map(r => r.id), nativeInputRequired: s.nativeInputRequired } : {}) });
    if (maintenance === 'spaceManager') {
      const [roomId, memberId] = command.arguments;
      const room = metadata.rooms.find(r => r.id === roomId);
      return { auditRooms: [room?.id || 'shared'],
        sessions: metadata.sessions.filter(s => s.id === actor.id || s.id === memberId).map(placement),
        rooms: room ? [{ id: room.id, name: room.name, archived: room.archived, manager: spaceManagers.current(roomId) }] : [] };
    }
    // These operations do not depend on another member's progress, roster
    // ordering, unrelated archives or space notes. Keep identity/placement
    // for the actual member and actor, and only the affected space facts.
    if (['joinRoom', 'leaveRoom'].includes(maintenance)) {
      const targetId = command.method === 'spaceAction' ? command.arguments[2]?.[0] : command.arguments[0];
      const destination = command.method === 'spaceAction' ? command.arguments[0] : 'shared';
      const target = metadata.sessions.find(s => s.id === targetId);
      const affected = new Set([destination, ...(target ? roomIds(target) : [])]);
      return { auditRooms: [...auditRooms].sort(),
        sessions: metadata.sessions.filter(s => s.id === actor.id || s.id === targetId).map(placement),
        rooms: metadata.rooms.filter(r => affected.has(r.id)).map(r => ({ id: r.id, archived: r.archived })),
        sessionArchives: { [targetId]: roomState.value.sessionArchives[targetId] || null } };
    }
    if (maintenance === 'renameRoom') {
      const targetId = command.method === 'spaceAction' ? command.arguments[0] : 'shared';
      const requested = command.method === 'spaceAction' ? command.arguments[2]?.[0] : command.arguments[0];
      const name = typeof requested === 'string' ? requested.trim() : '';
      return { auditRooms: [...auditRooms].sort(),
        sessions: metadata.sessions.filter(s => s.id === actor.id).map(placement),
        rooms: metadata.rooms.filter(r => r.id === targetId).map(r => ({ id: r.id, name: r.name, archived: r.archived })),
        named: metadata.rooms.filter(r => r.id !== targetId && r.name === name).map(r => r.id).sort() };
    }
    if (maintenance === 'rename') {
      const targetId = command.arguments[0], name = typeof command.arguments[1] === 'string' ? command.arguments[1].trim() : '';
      const named = sessionLabels.apply(metadata).sessions;
      return { auditRooms: [...auditRooms].sort(),
        sessions: metadata.sessions.filter(s => s.id === actor.id || s.id === targetId).map(s => ({ ...placement(s),
          ...(s.id === targetId ? { name: named.find(x => x.id === targetId)?.name } : {}) })),
        named: named.filter(s => s.id !== targetId && s.name === name).map(s => s.id).sort() };
    }
    // A new session or space touches nothing that exists. Its consent is the asking session as it was, and which
    // sessions or spaces already carry the requested name: one appearing or renamed onto it voids the card, so
    // two answered cards cannot leave two of one name. Others the person confirms meanwhile do not (2026-11-13:
    // a space and two sessions confirmed together, and only the space was made).
    if (['create', 'spaceCreate'].includes(command.method)) {
      const requested = command.method === 'create' ? command.arguments[0]?.name : command.arguments[0];
      const name = typeof requested === 'string' ? requested.trim() : '';
      const holders = command.method === 'create' ? sessionLabels.apply(metadata).sessions : metadata.rooms;
      return { auditRooms: [...(auditRooms.size ? auditRooms : ['shared'])].sort(),
        sessions: metadata.sessions.filter(s => s.id === actor.id).map(placement),
        named: name ? holders.filter(x => x.name === name).map(x => x.id).sort() : [] };
    }
    // Bind maintenance consent to the records it can change. Other cards may
    // create, disconnect or archive independent sessions while this one waits.
    let targets = null, targetRooms = null;
    if (['archiveSession', 'restoreSession', 'resume', 'importHistory'].includes(maintenance)) {
      if (maintenance === 'importHistory') {
        const provider = command.arguments[1]?.provider ?? 'codex', requested = command.arguments[0];
        // Match WorkspaceClient's provider-specific native history identity.
        const nativeId = provider === 'claude' && typeof requested === 'string' ? requested.toLowerCase() : requested;
        targets = new Set(metadata.sessions.filter(s => s.provider === provider && s.nativeId === nativeId).map(s => s.id));
      } else targets = new Set([command.arguments[0]]);
      targetRooms = new Set();
      for (const s of metadata.sessions) if (targets.has(s.id)) roomIds(s).forEach(id => targetRooms.add(id));
      for (const id of targets) roomState.value.sessionArchives[id]?.rooms.forEach(r => targetRooms.add(r.id));
    } else if (['archiveRoom', 'restoreRoom'].includes(maintenance)) {
      const id = command.method === 'spaceAction' ? command.arguments[0] : 'shared';
      targetRooms = new Set([id]);
      targets = new Set(metadata.sessions.filter(s => roomIds(s).includes(id)).map(s => s.id));
      // Restore acts on detached saved members too, not just today's roster.
      roomState.metadata(id).restoreMembers.forEach(member => targets.add(member));
    } else {
      const scope = backgroundOperation.maintenanceTargets(command, actor, metadata, client);
      if (scope) { targets = new Set(scope.sessions); targetRooms = new Set(scope.rooms); }
    }
    if (targets) {
      targets.add(actor.id); // Keep the asking session's placement/connection guard as well as checkActor.
      targetRooms.forEach(id => auditRooms.add(id));
    }
    return { auditRooms: [...(auditRooms.size ? auditRooms : ['shared'])].sort(),
      ...(command.method === 'initial' ? { selected: context.view.selected } : {}),
      ...(command.method === 'pasteNativeContent' ? { clipboardRevision: context.clipboardRevision || null } : {}),
      ...(maintenance === 'archiveRoom' ? { archivePlan: roomState.roomArchivePlan(state, command.method === 'spaceAction' ? command.arguments[0] : 'shared') } : {}),
      sessions: metadata.sessions.filter(s => !targets || targets.has(s.id)).map(placement),
      rooms: metadata.rooms.filter(r => !targetRooms || targetRooms.has(r.id)).map(r => ({ id: r.id, name: r.name, archived: r.archived, memberOrder: r.memberOrder,
        // Session archive saves its neighbour/slot when it executes. Other
        // members leaving must not void its card; whole-room consent still binds the roster.
        ...(targetRooms && maintenance !== 'archiveSession' ? { memberIds: metadata.sessions.filter(s => roomIds(s).includes(r.id)).map(s => s.id).sort() } : {}),
        restoreMembers: roomState.metadata(r.id).restoreMembers, restorePlacements: roomState.metadata(r.id).restorePlacements })),
      sessionArchives: targets ? Object.fromEntries(Object.entries(roomState.value.sessionArchives).filter(([id]) => targets.has(id))) : roomState.value.sessionArchives };
  }
  // Stopping names the session, not who holds it meanwhile: a takeover, another pid or a running turn does
  // not change what the person confirmed, and voiding the other merged card for it made "Confirm all" dead
  // (R186.1). A replaced native session or an archived one still voids it.
  if (command.method === 'stop') {
    const target = roomState.apply(state).sessions.find(s => s.id === command.arguments[0]);
    return { sessions: target ? [{ id: target.id, nativeId: target.nativeId, archived: target.archived === true }] : [], rooms: [] };
  }
  const global = ['quitService', 'clearSharedHistory', 'archiveRoom', 'switchBackend', 'continueConnection'].includes(command.method);
  return { sessions: roomState.apply(state).sessions.filter(s => global || strings.has(s.id)).map(s => ({ id: s.id, nativeId: s.nativeId, pid: s.pid, owner: s.owner, state: s.state, activeTurnId: s.activeTurnId, pendingTag: s.pendingTag, controlRevision: s.controlRevision,
    connectionRevision: s.connectionRevision, archived: s.archived, approval: s.approval, nativeApproval: s.nativeApproval })),
    rooms: (state.rooms || [state.room]).filter(r => r && (global || strings.has(r.id))).map(r => ({ id: r.id, memberIds: r.memberIds })) };
}
module.exports = { fingerprint, sessionBusy };
