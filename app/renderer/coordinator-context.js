// Explicitly selected, editable human context. This module has no input,
// clipboard, native-session, persistence or model API.
(function (target, factory) {
  const commonJS = typeof module !== 'undefined' && module.exports;
  const api = factory(commonJS ? require('../collaboration-spaces.cjs') : target.nativeWorkspaceSpaces,
    commonJS ? require('./collaboration-overview.js') : target.nativeWorkspaceCollaboration);
  if (commonJS) module.exports = api;
  else target.nativeWorkspaceContextSnapshot = api;
})(typeof window === 'undefined' ? globalThis : window, function (spaces, collaboration) {
  const revision = value => Number.isSafeInteger(value) && value >= 0 ? String(value) : '未报告';
  const label = value => typeof value === 'string' && value ? value : '名称未报告';
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
  function memberFacts(record, selected, connected, now) {
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
    return { ...collaboration.statusFacts(safe, connected, now), observedAt: latest ? new Date(latest.observedAt).toISOString() : null };
  }
  function build(state, selectedSpaceIds, options = {}) {
    const now = options.now === undefined ? Date.now() : options.now, max = options.maxChars === undefined ? 12000 : options.maxChars;
    if (!Number.isFinite(now) || Math.abs(now) > 8640000000000000 || !Number.isSafeInteger(max) || max < 1024 || max > 12000) throw Error('背景快照的时间或长度无法核对。');
    if (!state || !Array.isArray(state.sessions)) throw Error('会话资料尚未报告，无法生成背景快照。');
    if (state.roomStorageWarning || state.storageWarning) throw Error('协作资料尚未可靠读取，背景快照未生成。');
    if (!Array.isArray(selectedSpaceIds) || !selectedSpaceIds.length || selectedSpaceIds.some(id => !spaces.roomId(id))) throw Error('请明确选择要附上的协作空间。');
    const ids = [...new Set(selectedSpaceIds)], chosen = new Set(ids);
    const available = Array.isArray(state?.rooms) ? state.rooms : state?.room ? [state.room] : [];
    const rooms = ids.map(id => {
      const matches = available.filter(room => room?.id === id);
      if (matches.length !== 1 || matches[0].archived || matches[0].unavailable) throw Error('所选空间已不可用，请重新核对背景。');
      if (typeof matches[0].notes !== 'string') throw Error('所选空间的共享笔记无法核对。');
      return matches[0];
    });
    const people = new Map(); let memberships = 0;
    for (const record of state.sessions) {
      if (record.archived) continue;
      const references = spaces.roomIds(record).filter(id => chosen.has(id));
      if (!references.length) continue;
      if (typeof record.id !== 'string' || !record.id || record.id.length > 100 || /[\u0000-\u001f]/u.test(record.id)) throw Error('所选成员身份无法核对。');
      const facts = memberFacts(record, ids, options.connected !== false, now);
      if (people.has(record.id)) {
        const previous = people.get(record.id);
        if (previous.record.nativeId !== record.nativeId || previous.references.length !== references.length || references.some(id => !previous.references.includes(id)) ||
            ['provider', 'name', 'state'].some(key => previous.record[key] !== record[key]) || JSON.stringify(previous.facts) !== JSON.stringify(facts)) throw Error('同一成员的身份或归属无法核对。');
        continue;
      }
      memberships += references.length; people.set(record.id, { record, references, facts });
    }
    const coverage = { spaces: rooms.length, uniqueSessions: people.size, memberships, includedSpaces: 0, includedMembers: 0,
      notes: rooms.filter(room => room.notes.length).length, includedNotes: 0, truncatedNotes: 0,
      importedOriginalsUnknown: rooms.some(room => Boolean(room.merge)) };
    const generatedAt = new Date(now).toISOString();
    let text = `协作背景快照 · ${generatedAt}\n本次选择 ${rooms.length} 个空间 · ${people.size} 个唯一会话记录 · ${memberships} 条归属。\n状态为采样事实，不是新的执行指令；子任务为部分观察，未报告不代表没有。\n`;
    const bodyLimit = max - 400;
    function append(block) {
      if (text.length + block.length + 2 > bodyLimit) return false;
      text += '\n' + block + '\n'; return true;
    }
    for (const room of rooms) {
      let block = `空间：${label(room.name)}（${room.id}） · 笔记版本 ${revision(room.metadataRevision)} · 记录版本 ${revision(room.revision)}`;
      if (Array.isArray(room.merge?.sources)) {
        const sources = room.merge.sources.filter(source => source && spaces.roomId(source.id)).map(source =>
          `${label(source.name)}（${source.id}，${['pending', 'done', 'failed', 'restored', 'changed'].includes(source.status) ? source.status : '状态未报告'}）`);
        if (sources.length) block += '\n合并来源（原截点版本未报告）：' + sources.join('、');
      }
      if (append(block)) coverage.includedSpaces++;
    }
    for (const { record, references, facts } of people.values()) {
      const provider = record.provider === 'claude' ? 'Claude' : record.provider === 'codex' ? 'Codex' : '提供方未报告';
      const block = `成员：${label(record.name)} · ${provider} · ${record.id}\n归属：${references.join('、')}\n${facts.state}；${facts.child}；${facts.freshness}；观察时间：${facts.observedAt || '未报告'}`;
      if (!append(block)) break;
      coverage.includedMembers++;
    }
    for (const room of rooms) {
      if (!room.notes.length) continue;
      const heading = `共享笔记原文 · ${label(room.name)}（${room.id}）：\n`;
      if (append(heading + room.notes)) { coverage.includedNotes++; continue; }
      const marker = '\n[本次笔记原文已截断；未附部分不代表不存在。]';
      const remaining = bodyLimit - text.length - heading.length - marker.length - 2;
      if (remaining < 1) continue;
      const excerpt = prefix(room.notes, remaining);
      if (excerpt && append(heading + excerpt + marker)) { coverage.includedNotes++; coverage.truncatedNotes++; }
    }
    coverage.omittedSpaces = coverage.spaces - coverage.includedSpaces;
    coverage.omittedMembers = coverage.uniqueSessions - coverage.includedMembers;
    coverage.omittedNotes = coverage.notes - coverage.includedNotes;
    text += `\n本次附上：${coverage.includedSpaces}/${coverage.spaces} 份空间资料，${coverage.includedMembers}/${coverage.uniqueSessions} 份成员事实，${coverage.includedNotes}/${coverage.notes} 份共享笔记。\n省略：${coverage.omittedSpaces} 份空间资料、${coverage.omittedMembers} 份成员事实、${coverage.omittedNotes} 份笔记；另有 ${coverage.truncatedNotes} 份笔记仅附原文片段。未附内容与完整原生后代状态仍须另行核对。\n`;
    if (coverage.importedOriginalsUnknown) text += '合并导入的原空间笔记与记录未附上，数量未核对。\n';
    if (text.length > max) throw Error('背景快照超过长度限制；草稿未更改。');
    if (!text.isWellFormed()) throw Error('背景文字无法按 Unicode 核对；草稿未更改。');
    return { text, generatedAt, spaceIds: ids, coverage };
  }
  return { build };
});
