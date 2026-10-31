// A read-only projection of existing sessions. Space membership is a reference,
// never a second participant, native session, input owner or sharing grant.
(function (target, factory) {
  const commonJS = typeof module !== 'undefined' && module.exports;
  const api = factory(commonJS ? require('../collaboration-spaces.cjs') : target.nativeWorkspaceSpaces,
    commonJS ? require('./collaboration-overview.js') : target.nativeWorkspaceCollaboration);
  if (commonJS) module.exports = api;
  else target.nativeWorkspacePanorama = api;
})(typeof window === 'undefined' ? globalThis : window, function (spaces, collaboration) {
  const knownStates = new Set(['starting', 'idle', 'working', 'approval', 'stopping', 'disconnected', 'recoverable', 'ended', 'background', 'error']);
  const validObservation = (value, record, now) => value && record.nativeId && value.nativeId === record.nativeId &&
    (!record.activeTurnId || !value.turnId || value.turnId === record.activeTurnId) &&
    Number.isFinite(value.observedAt) && value.observedAt <= now;
  function project(state, options = {}, connected = true, now = Date.now()) {
    const rooms = state.rooms || (state.room ? [state.room] : []);
    const roomById = new Map(rooms.map(room => [room.id, room]));
    const byId = new Map();
    for (const record of state.sessions || []) {
      if (record && typeof record.id === 'string' && record.id && !record.archived && !byId.has(record.id)) byId.set(record.id, record);
    }
    // Native updates can arrive in a different array order. Keep the person's
    // current targets in place, appending newly observed IDs at the end.
    const order = [...new Set([...(options.order || []), ...byId.keys()])].filter(id => byId.has(id));
    let memberships = 0;
    const all = order.map(id => {
      const record = byId.get(id);
      const references = [...new Set(spaces.roomIds(record))].map(roomId => {
        const room = roomById.get(roomId);
        return { id: roomId, name: room?.name || roomId, unavailable: !room || Boolean(room.archived), archived: Boolean(room?.archived) };
      });
      memberships += references.length;
      // projectSpace supplies only the current space's sharedActivity. A global
      // reader must also consider valid observations from the other memberships.
      const shared = [record.sharedActivity, ...references.map(room => record.sharedActivities?.[room.id])]
        .filter(value => validObservation(value, record, now)).sort((a, b) => b.observedAt - a.observedAt)[0];
      const observed = { ...record, sharedActivity: shared };
      return { record, spaces: references, facts: collaboration.statusFacts(observed, connected, now),
        timeReported: [record.nativeActivity, record.nativeApproval, shared].some(value => validObservation(value, record, now)),
        excerpt: collaboration.excerpt(record) };
    });
    const query = String(options.query || '').trim().toLocaleLowerCase();
    const people = all.filter(person => (!options.spaceId || person.spaces.some(room => room.id === options.spaceId)) &&
      (!query || [person.record.name, person.record.id, person.record.nativeId, ...person.spaces.map(room => room.name)]
        .some(value => typeof value === 'string' && value.toLocaleLowerCase().includes(query))));
    const stats = { waiting: 0, disconnected: 0, unknownState: 0, unreportedTime: 0, stale: 0 };
    for (const person of all) {
      const r = person.record;
      if (r.state === 'approval' || r.claudeQuestion || r.approval?.method === 'item/tool/requestUserInput' ||
          r.nativeApproval?.requests?.length || r.approvals?.length) stats.waiting++;
      if (!connected || r.transportDisconnected || r.backendUnavailable || ['disconnected', 'recoverable'].includes(r.state)) stats.disconnected++;
      if (!knownStates.has(r.state) || r.nativeContextPending || !r.nativeId) stats.unknownState++;
      if (!person.timeReported) stats.unreportedTime++;
      if (person.facts.stale) stats.stale++;
    }
    return { people, order, total: all.length, memberships, stats };
  }

  function pruneReading(positions, activeKeys = [], limit = 128) {
    const keys = Object.keys(positions), protectedKeys = new Set(activeKeys);
    if (!Number.isSafeInteger(limit) || limit < 1 || keys.filter(key => protectedKeys.has(key)).length > limit) throw Error('活跃阅读位置超过保留上限。');
    const remove = new Set(keys.filter(key => !protectedKeys.has(key)).slice(0, Math.max(0, keys.length - limit)));
    const result = Object.create(null);
    for (const key of keys) if (!remove.has(key)) result[key] = positions[key];
    return result;
  }
  function create(options) {
    const host = options.host, doc = host.ownerDocument;
    const element = (tag, text, cls) => { const el = doc.createElement(tag); if (text !== undefined) el.textContent = text; if (cls) el.className = cls; return el; };
    const control = (text, action) => { const el = element('button', text); el.type = 'button'; el.addEventListener('click', action); return el; };
    let data = { sessions: [], rooms: [] }, connected = true, order = [], origin, firstRender = true;
    const saved = options.view || {};
    let layout = saved.layout === 'grid' ? 'grid' : 'list', query = saved.query || '', scope = saved.spaceId || '';
    const toolbar = element('div', undefined, 'panorama-tools');
    const search = element('input'); search.type = 'search'; search.maxLength = 1000; search.value = query; search.placeholder = '查找成员或空间'; search.setAttribute('aria-label', '查找全部空间的成员');
    const filter = element('select'); filter.setAttribute('aria-label', '全景空间筛选');
    const grid = control('网格', () => setLayout('grid')), list = control('列表', () => setLayout('list'));
    const summary = element('span', undefined, 'quiet'); summary.setAttribute('role', 'status');
    toolbar.append(search, filter, grid, list, summary);
    const reader = element('div', undefined, 'panorama-members'); reader.tabIndex = -1; reader.setAttribute('aria-label', '跨空间全部成员');
    const empty = element('p', '没有符合筛选的会话。', 'quiet');
    host.classList.add('collaboration-panorama'); host.append(toolbar, reader, empty);
    const rows = new Map();
    function rememberBeforePointer(event) {
      if (event.button !== 0) return;
      captureOrigin(true, event.currentTarget);
    }
    // Match the existing member reader: remember before the browser's button
    // default can collapse the document selection, not after the click.
    doc.addEventListener('pointercancel', () => { if (origin?.pointerCaptured) origin = null; });
    doc.addEventListener('pointerup', () => {
      const pending = origin;
      setTimeout(() => { if (origin === pending && pending?.pointerCaptured) origin = null; }, 0);
    });
    function snapshot() { return { layout, query, spaceId: scope, top: reader.scrollTop }; }
    function changed() { options.onChange?.(snapshot()); }
    function setLayout(value) { layout = value; render(); changed(); }
    search.addEventListener('input', () => { query = search.value; render(); changed(); });
    filter.addEventListener('change', () => { scope = filter.value; render(); changed(); });
    let scrollFrame;
    reader.addEventListener('scroll', () => {
      if (scrollFrame) return;
      scrollFrame = requestAnimationFrame(() => { scrollFrame = null; changed(); });
    });
    function addRow(id) {
      const article = element('article', undefined, 'panorama-member'); article.dataset.panoramaSession = id;
      const heading = element('div', undefined, 'panorama-member-heading');
      const name = control('', () => options.onSession?.(id)); name.dataset.panoramaFocus = id;
      name.addEventListener('pointerdown', rememberBeforePointer);
      const status = element('span', undefined, 'panorama-state');
      heading.append(name, status);
      const references = element('div', undefined, 'panorama-spaces');
      const observations = element('p', undefined, 'panorama-observation quiet');
      const quote = element('blockquote'), source = control('查看原文', () => {
        const row = rows.get(id);
        if (row?.snippet) options.onSession?.(id, row.snippet);
      });
      source.className = 'panorama-source'; source.dataset.panoramaSource = id;
      source.addEventListener('pointerdown', rememberBeforePointer);
      article.append(heading, references, observations, quote, source);
      const row = { article, name, status, references, observations, quote, source, snippet: null };
      rows.set(id, row); return row;
    }
    function write(el, text) { if (el.textContent !== text) el.textContent = text; }
    function render() {
      const selection = doc.getSelection();
      const selectedQuote = selection && !selection.isCollapsed && selection.anchorNode?.parentElement?.closest('blockquote');
      const selectedArticle = selectedQuote && reader.contains(selectedQuote) && selectedQuote.contains(selection.focusNode) && selectedQuote.closest('[data-panorama-session]');
      const heldSource = origin?.source || (selectedArticle ? { sessionId: selectedArticle.dataset.panoramaSession, messageId: selectedQuote.dataset.messageId } : null);
      const visibleTop = reader.clientHeight ? [...reader.children].find(row => !row.hidden && row.getBoundingClientRect().bottom > reader.getBoundingClientRect().top) : null;
      const offset = visibleTop ? visibleTop.getBoundingClientRect().top - reader.getBoundingClientRect().top : 0;
      const projection = project(data, { order, query, spaceId: scope }, connected);
      order = projection.order; host.dataset.layout = layout;
      grid.setAttribute('aria-pressed', String(layout === 'grid')); list.setAttribute('aria-pressed', String(layout === 'list'));
      const counts = [[projection.stats.waiting, '待处理'], [projection.stats.disconnected, '连接待核对'],
        [projection.stats.unknownState, '状态待核对'], [projection.stats.unreportedTime, '更新时间未报告'], [projection.stats.stale, '最后观察']]
        .filter(([count]) => count).map(([count, label]) => count + ' ' + label);
      write(summary, projection.people.length + ' / ' + projection.total + ' 个会话 · ' + projection.memberships + ' 条空间归属' +
        (counts.length ? ' · 全体：' + counts.join(' · ') : ''));
      summary.title = '全体读数按原会话去重；待处理、连接、状态与观察时间可以重叠。未报告跨空间阻塞关系，不按零处理。';
      const spaceRecords = data.rooms || (data.room ? [data.room] : []);
      const signature = JSON.stringify([scope, spaceRecords.filter(room => !room.archived).map(room => [room.id, room.name])]);
      if (filter.dataset.signature !== signature) {
        const values = [['', '全部空间'], ...spaceRecords.filter(room => !room.archived).map(room => [room.id, room.name])];
        if (scope && !values.some(([id]) => id === scope)) values.push([scope, '原空间已不可用']);
        filter.replaceChildren(...values.map(([id, name]) => { const option = element('option', name); option.value = id; return option; }));
        filter.dataset.signature = signature;
      }
      filter.value = scope;
      const visible = new Set(projection.people.map(person => person.record.id));
      for (const [id, row] of rows) if (!visible.has(id)) row.article.hidden = true;
      for (const [index, person] of projection.people.entries()) {
        const record = person.record, row = rows.get(record.id) || addRow(record.id);
        row.article.hidden = false;
        write(row.name, options.label ? options.label(record) : record.name);
        write(row.status, person.facts.state);
        row.status.title = person.facts.child + ' · ' + person.facts.freshness;
        row.article.dataset.state = record.state || 'unknown'; row.article.dataset.stale = String(person.facts.stale);
        write(row.observations, [person.facts.compactChild, person.facts.freshnessReported && person.facts.freshness].filter(Boolean).join(' · '));
        row.observations.hidden = !row.observations.textContent;
        const referenceSignature = JSON.stringify(person.spaces);
        if (row.references.dataset.signature !== referenceSignature) {
          row.references.replaceChildren(...person.spaces.map(room => {
            const reference = room.unavailable ? element('span', room.name + (room.archived ? ' · 已归档' : ' · 未核对'))
              : control(room.name, () => options.onSpace?.(room.id));
            if (!room.unavailable) reference.addEventListener('pointerdown', rememberBeforePointer);
            reference.dataset.panoramaSpace = room.id; return reference;
          }));
          if (!person.spaces.length) row.references.append(element('span', '独立会话'));
          row.references.dataset.signature = referenceSignature;
        }
        // Keep the originally selected source while visiting a member. A newer
        // reply must not silently replace the text to which a return refers.
        const held = heldSource?.sessionId === record.id ? record.messages?.find(message => message.id === heldSource.messageId) : null;
        const snippet = held ? collaboration.excerpt(record, [held]) : person.excerpt;
        row.snippet = snippet;
        write(row.quote, snippet?.text || '原会话尚未报告可摘录的消息。');
        row.quote.dataset.messageId = snippet?.messageId || '';
        row.source.hidden = !snippet;
        row.quote.title = snippet ? '原会话原文；查看不代表分享或发送。' : '';
        if (reader.children[index] !== row.article) reader.insertBefore(row.article, reader.children[index] || null);
      }
      // Removed sessions do not remain as hidden routing targets.
      for (const [id, row] of rows) if (!order.includes(id)) { row.article.remove(); rows.delete(id); }
      empty.hidden = projection.people.length > 0;
      if (visibleTop?.isConnected && !visibleTop.hidden) reader.scrollTop += visibleTop.getBoundingClientRect().top - reader.getBoundingClientRect().top - offset;
    }
    function captureOrigin(beforePointer = false, control = doc.activeElement) {
      if (!beforePointer && origin?.pointerCaptured) { origin.pointerCaptured = false; return origin; }
      const selection = doc.getSelection(), active = control?.closest('[data-panorama-focus],[data-panorama-source],[data-panorama-space]');
      const anchor = selection?.anchorNode?.parentElement?.closest('blockquote');
      const article = anchor?.closest('[data-panorama-session]');
      const range = selection && !selection.isCollapsed && anchor && reader.contains(anchor) && anchor.contains(selection.focusNode) ? selection.getRangeAt(0).cloneRange() : null;
      origin = { view: snapshot(), focusId: active?.closest('[data-panorama-session]')?.dataset.panoramaSession || '',
        focusKind: active?.dataset.panoramaSource ? 'source' : active?.dataset.panoramaSpace ? 'space' : 'member', focusSpace: active?.dataset.panoramaSpace || '',
        range, startNode: range?.startContainer, endNode: range?.endContainer, pointerCaptured: beforePointer,
        source: range ? { sessionId: article.dataset.panoramaSession, messageId: anchor.dataset.messageId } : null };
      return origin;
    }
    function restoreOrigin(point = origin) {
      if (!point) return false;
      layout = point.view.layout; query = point.view.query; scope = point.view.spaceId;
      search.value = query; render(); reader.scrollTop = point.view.top;
      const row = rows.get(point.focusId);
      const target = row && !row.article.hidden ? point.focusKind === 'source' ? row.source
        : point.focusKind === 'space' ? [...row.references.children].find(el => el.tagName === 'BUTTON' && el.dataset.panoramaSpace === point.focusSpace) : row.name : null;
      (target || reader).focus({ preventScroll: true });
      let restored = true;
      if (point.range) {
        const source = rows.get(point.source.sessionId);
        const original = source?.snippet;
        // A text node replaced by an edit detaches the Range's original child.
        // Never recreate a selection on another source or a neighbouring row.
        restored = Boolean(original?.messageId === point.source.messageId && point.startNode?.isConnected && point.endNode?.isConnected &&
          point.range.startContainer === point.startNode && point.range.endContainer === point.endNode &&
          source.quote.contains(point.startNode) && source.quote.contains(point.endNode) && !point.range.collapsed);
        const selection = doc.getSelection(); selection.removeAllRanges();
        if (restored) selection.addRange(point.range);
        else options.onReadingLost?.();
      }
      origin = null; changed(); return restored;
    }
    return {
      update(next, isConnected = true) {
        data = next; connected = isConnected; render();
        if (firstRender) { reader.scrollTop = saved.top || 0; firstRender = false; }
      },
      snapshot, captureOrigin, restoreOrigin, reader, refresh: render,
      dispose() { if (scrollFrame) cancelAnimationFrame(scrollFrame); host.replaceChildren(); rows.clear(); },
    };
  }
  return { project, pruneReading, create };
});
