// Explicitly selected, editable human context. This module has no input,
// clipboard, native-session, persistence or model API.
(function (target, factory) {
  const commonJS = typeof module !== 'undefined' && module.exports;
  const api = factory(commonJS ? require('../collaboration-spaces.cjs') : target.nativeWorkspaceSpaces,
    commonJS ? require('./collaboration-overview.js') : target.nativeWorkspaceCollaboration,
    commonJS ? require('../ui-locale.js') : target.nativeWorkspaceLocale);
  if (commonJS) module.exports = api;
  else target.nativeWorkspaceContextSnapshot = api;
})(typeof window === 'undefined' ? globalThis : window, function (spaces, collaboration, locale) {
  const revision = (value, language) => Number.isSafeInteger(value) && value >= 0 ? String(value) : locale.format(language, 'version.unreported');
  const label = (value, language) => typeof value === 'string' && value ? value : locale.format(language, 'context.nameUnreported');
  function prefix(text, length) {
    let result = '';
    for (const point of text) { if (result.length + point.length > length) break; result += point; }
    return result;
  }
  function observation(value, record, now) {
    if (!value || typeof record.nativeId !== 'string' || !record.nativeId || value.nativeId !== record.nativeId ||
        record.activeTurnId && value.turnId && value.turnId !== record.activeTurnId ||
        !Number.isFinite(value.observedAt) || Math.abs(value.observedAt) > 8640000000000000 || value.observedAt > now) return null;
    return { nativeId: value.nativeId, turnId: value.turnId, observedAt: value.observedAt, stale: value.stale };
  }
  function memberFacts(record, selected, connected, now, language) {
    const shared = selected.map(id => observation(record.sharedActivities?.[id], record, now)).filter(Boolean)
      .sort((a, b) => b.observedAt - a.observedAt)[0] || null;
    const native = observation(record.nativeActivity, record, now), permission = observation(record.nativeApproval, record, now);
    const latest = [native, permission, shared].filter(Boolean).sort((a, b) => b.observedAt - a.observedAt)[0];
    // Whitelist the helper's facts; private text and child names/models never
    // enter the projection, even as intermediate helper inputs.
    const nativeId = typeof record.nativeId === 'string' && record.nativeId ? record.nativeId : null;
    const safe = { state: record.state, nativeId, activeTurnId: record.activeTurnId,
      transportDisconnected: record.transportDisconnected, backendUnavailable: record.backendUnavailable,
      nativeContextPending: record.nativeContextPending || !nativeId, claudeQuestion: Boolean(record.claudeQuestion),
      approval: record.approval?.method === 'item/tool/requestUserInput' ? { method: 'item/tool/requestUserInput', params: { isBlocking: record.approval.params?.isBlocking } } : null,
      approvals: { length: Array.isArray(record.approvals) ? record.approvals.length : 0 },
      nativeActivity: native, nativeApproval: record.nativeApproval ? { ...permission,
        requests: { length: Array.isArray(record.nativeApproval.requests) ? record.nativeApproval.requests.length : 0 } } : null,
      sharedActivity: shared,
      fleet: Array.isArray(record.fleet) ? record.fleet.filter(Boolean).map(event => ({
        event: event.event, id: event.id, nativeId: event.nativeId, kind: event.kind, stale: event.stale,
      })) : [],
    };
    return { ...collaboration.statusFacts(safe, connected, now, language), observedAt: latest ? new Date(latest.observedAt).toISOString() : null };
  }
  function build(state, selectedSpaceIds, options = {}) {
    const language = options.language === 'en' ? 'en' : 'zh', t = (key, params) => locale.format(language, key, params);
    const now = options.now === undefined ? Date.now() : options.now, max = options.maxChars === undefined ? 12000 : options.maxChars;
    if (!Number.isFinite(now) || Math.abs(now) > 8640000000000000 || !Number.isSafeInteger(max) || max < 1024 || max > 12000) throw locale.createError('error.contextSnapshotInvalidTime');
    if (!state || !Array.isArray(state.sessions)) throw locale.createError('error.contextSnapshotSessionsMissing');
    if (state.roomStorageWarning || state.storageWarning) throw locale.createError('error.contextSnapshotStorageUnreadable');
    if (!Array.isArray(selectedSpaceIds) || !selectedSpaceIds.length || selectedSpaceIds.some(id => !spaces.roomId(id))) throw locale.createError('error.contextSnapshotChooseSpaces');
    const ids = [...new Set(selectedSpaceIds)], chosen = new Set(ids);
    const available = Array.isArray(state?.rooms) ? state.rooms : state?.room ? [state.room] : [];
    const rooms = ids.map(id => {
      const matches = available.filter(room => room?.id === id);
      if (matches.length !== 1 || matches[0].archived || matches[0].unavailable) throw locale.createError('error.contextSnapshotSpaceMissing');
      if (typeof matches[0].notes !== 'string') throw locale.createError('error.contextSnapshotNotesInvalid');
      return matches[0];
    });
    const people = new Map(); let memberships = 0;
    for (const record of state.sessions) {
      if (record.archived) continue;
      const references = spaces.roomIds(record).filter(id => chosen.has(id));
      if (!references.length) continue;
      if (typeof record.id !== 'string' || !record.id || record.id.length > 100 || /[\u0000-\u001f]/u.test(record.id)) throw locale.createError('error.contextSnapshotMemberInvalid');
      const facts = memberFacts(record, ids, options.connected !== false, now, language);
      if (people.has(record.id)) {
        const previous = people.get(record.id);
        if (previous.record.nativeId !== record.nativeId || previous.references.length !== references.length || references.some(id => !previous.references.includes(id)) ||
            ['provider', 'name', 'state'].some(key => previous.record[key] !== record[key]) || JSON.stringify(previous.facts) !== JSON.stringify(facts)) throw locale.createError('error.contextSnapshotMemberConflict');
        continue;
      }
      memberships += references.length; people.set(record.id, { record, references, facts });
    }
    const coverage = { spaces: rooms.length, uniqueSessions: people.size, memberships, includedSpaces: 0, includedMembers: 0,
      notes: rooms.filter(room => room.notes.length).length, includedNotes: 0, truncatedNotes: 0,
      importedOriginalsUnknown: rooms.some(room => Boolean(room.merge)) };
    const generatedAt = new Date(now).toISOString();
    let text = t('context.snapshotHeader', { generatedAt, spaces: rooms.length, uniqueSessions: people.size, memberships });
    const bodyLimit = max - 400;
    function append(block) {
      if (text.length + block.length + 2 > bodyLimit) return false;
      text += '\n' + block + '\n'; return true;
    }
    for (const room of rooms) {
      let block = t('context.snapshotSpace', { name: label(room.name, language), id: room.id, notesRevision: revision(room.metadataRevision, language), revision: revision(room.revision, language) });
      if (Array.isArray(room.merge?.sources)) {
        const sources = room.merge.sources.filter(source => source && spaces.roomId(source.id)).map(source =>
          t('context.snapshotMergeSource', { name: label(source.name, language), id: source.id, status: ['pending', 'done', 'failed', 'restored', 'changed'].includes(source.status) ? source.status : t('collab.stateMissing') }));
        if (sources.length) block += t('context.snapshotMergeSources', { sources: sources.join(t('context.rosterSeparator')) });
      }
      if (append(block)) coverage.includedSpaces++;
    }
    for (const { record, references, facts } of people.values()) {
      const provider = record.provider === 'claude' ? 'Claude' : record.provider === 'codex' ? 'Codex' : record.provider === 'dsh' ? 'DSH' : record.provider === 'agy' ? 'Antigravity' : record.provider === 'pi' ? 'pi' : t('context.providerUnreported');
      const block = t('context.snapshotMember', { name: label(record.name, language), provider, id: record.id, references: references.join(t('context.rosterSeparator')), state: facts.state, child: facts.child, freshness: facts.freshness, observedAt: facts.observedAt || t('version.unreported') });
      if (!append(block)) break;
      coverage.includedMembers++;
    }
    for (const room of rooms) {
      if (!room.notes.length) continue;
      const heading = t('context.snapshotNotesHeader', { name: label(room.name, language), id: room.id });
      if (append(heading + room.notes)) { coverage.includedNotes++; continue; }
      const marker = t('context.snapshotNotesTruncated');
      const remaining = bodyLimit - text.length - heading.length - marker.length - 2;
      if (remaining < 1) continue;
      const excerpt = prefix(room.notes, remaining);
      if (excerpt && append(heading + excerpt + marker)) { coverage.includedNotes++; coverage.truncatedNotes++; }
    }
    coverage.omittedSpaces = coverage.spaces - coverage.includedSpaces;
    coverage.omittedMembers = coverage.uniqueSessions - coverage.includedMembers;
    coverage.omittedNotes = coverage.notes - coverage.includedNotes;
    text += t('context.snapshotFooter', coverage);
    if (coverage.importedOriginalsUnknown) text += t('context.snapshotImportedOmitted');
    if (text.length > max) throw locale.createError('error.contextSnapshotTooLong');
    if (!text.isWellFormed()) throw locale.createError('error.contextSnapshotUnicodeInvalid');
    return { text, generatedAt, spaceIds: ids, coverage };
  }
  return { build };
});
