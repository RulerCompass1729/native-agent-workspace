(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.nativeWorkspaceTaskBoard = api;
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  const BAR_HEIGHT = 0;
  const COLORS = { sent: '#5c8fc1', queued: '#858276', waiting: '#e9b05b', review: '#b39b6a', failed: '#c95751', unknown: '#8a70a4', done: '#62916b', cancelled: '#aeb5aa', empty: '#eef0eb' };
  const KINDS = ['sent', 'queued', 'waiting', 'review', 'failed', 'unknown', 'done', 'cancelled'];
  const PRIORITY = ['waiting', 'failed', 'unknown', 'review', 'sent', 'queued', 'done', 'cancelled'];
  const kind = item => !['sent', 'queued', 'waiting', 'failed', 'done', 'cancelled'].includes(item.status) ? 'unknown'
    : item.status === 'waiting' && ['no-reply', 'person-intervened'].includes(item.reason) ? 'review' : item.status;
  function project(rooms, sessions, now = Date.now()) {
    const day = new Date(now), start = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime(), end = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
    const members = new Map((sessions || []).map(s => [s.id, s.name]));
    return (rooms || []).map(room => {
      const all = (Array.isArray(room.queue) ? room.queue : []).filter(q => q && typeof q.id === 'string').map(q => {
        const memberKey = q.sentTo || q.assignee || '', k = kind(q);
        return { key: JSON.stringify([room.id, q.id]), id: q.id, spaceId: room.id, spaceName: room.name || '', kind: k,
          memberKey, memberName: members.get(memberKey) || '', actualRecipient: typeof q.sentTo === 'string' && Boolean(q.sentTo), text: typeof q.text === 'string' ? q.text : '',
          reason: typeof q.reason === 'string' ? q.reason : '', waiting: q.waiting === true,
          createdAt: q.createdAt ?? null, sentAt: q.sentAt ?? null, finishedAt: q.finishedAt ?? null, ready: typeof q.ready?.commit === 'string' ? { commit: q.ready.commit } : null,
          current: !['done', 'cancelled'].includes(k) || typeof q.finishedAt === 'number' && Number.isFinite(q.finishedAt) && q.finishedAt >= start && q.finishedAt < end };
      });
      const current = all.filter(q => q.current), counts = Object.fromEntries(KINDS.map(k => [k, current.filter(q => q.kind === k).length]));
      return { id: room.id, name: room.name || '', archived: room.archived === true, available: room.unavailable !== true && Array.isArray(room.queue), all, current, counts,
        transit: counts.sent + counts.queued + counts.waiting + counts.review, attention: counts.waiting + counts.review + counts.failed + counts.unknown };
    });
  }
  function needsHuman(s) {
    const requests = [s.claudeQuestion, s.approval, ...(s.approvals || []), ...(s.nativeApproval?.requests || [])].filter(Boolean);
    return Boolean(s.nativeInputRequired || s.approvalOverflow || requests.some(a => !a.pending) || s.state === 'approval' && !requests.length);
  }
  function fresh(s, connected) {
    return Boolean(connected && s && !s.archived && !s.backendUnavailable && !s.transportDisconnected && !s.nativeContextPending &&
      ['idle', 'working', 'approval', 'background'].includes(s.state));
  }
  function observedWork(s) { return s.state === 'working' || s.state === 'background' || s.runningChildren > 0 || s.backgroundStale === false && s.background > 0; }
  function uncertainIdle(s) { return s.state === 'idle' && !observedWork(s) && (s.workUnconfirmed || s.unknownChildren > 0); }
  function overview(input, now = Date.now()) {
    const sessions = new Map((input.sessions || []).map(s => [s.id, s]));
    let unknown = 0;
    const finish = p => {
      const current = p.all.filter(q => q.current), counts = Object.fromEntries(KINDS.map(k => [k, current.filter(q => q.kind === k).length]));
      return { ...p, current, counts, transit: counts.sent + counts.queued + counts.waiting + counts.review, attention: counts.waiting + counts.review + counts.failed + counts.unknown };
    };
    const historyGroups = project(input.rooms, input.sessions, now).map(p => {
      const statusExcluded = p.archived && p.available && !p.all.some(q => !['done', 'cancelled'].includes(q.kind));
      if (!p.available && !statusExcluded) unknown++;
      return finish({ ...p, statusExcluded, source: 'space', all: p.all.map(q => {
        const member = sessions.get(q.memberKey);
        const k = q.kind === 'sent' ? !fresh(member, input.connected !== false) ? 'unknown' : needsHuman(member) ? 'waiting' : uncertainIdle(member) ? 'unknown' : 'sent' : q.kind;
        return { ...q, kind: k, source: 'space' };
      }) });
    });
    const groups = historyGroups.filter(p => !p.statusExcluded);
    const represented = new Set(groups.flatMap(p => p.current.filter(q => q.actualRecipient && ['sent', 'waiting', 'unknown'].includes(q.kind)).map(q => q.memberKey)));
    const conversations = [];
    for (const s of sessions.values()) {
      if (s.archived || s.state === 'ended') continue;
      if (!Array.isArray(s.roomIds)) { if (s.membershipUnknown) unknown++; continue; }
      if (represented.has(s.id)) continue;
      const space = groups.find(p => p.source === 'space' && !p.archived && s.roomIds.includes(p.id));
      if (s.roomIds.length && !space) { if (!historyGroups.some(p => p.archived && s.roomIds.includes(p.id))) unknown++; continue; }
      const k = !fresh(s, input.connected !== false) ? 'unknown' : needsHuman(s) ? 'waiting' : uncertainIdle(s) ? 'unknown' : observedWork(s) ? 'sent' : null;
      if (!k) continue;
      const row = { key: JSON.stringify(['conversation', s.id]), id: s.id, source: 'conversation', spaceId: space?.id || '@independent', spaceName: space?.name || '',
        kind: k, memberKey: s.id, memberName: s.name || '', actualRecipient: true, text: s.name || '', current: true };
      if (space) { space.all.push(row); Object.assign(space, finish(space)); } else conversations.push(row);
    }
    if (conversations.length) groups.push(finish({ id: '@independent', source: 'conversation', name: '', available: true, all: conversations }));
    const cards = new Map();
    const cardsAvailable = input.confirmationsAvailable !== false && Array.isArray(input.confirmations);
    if (!cardsAvailable) unknown++;
    for (const card of Array.isArray(input.confirmations) ? input.confirmations : []) {
      if (!card || !['confirmation-required', 'unverifiable'].includes(card.state) || card.replacedBy || card.disposition) continue;
      const key = typeof card.key === 'string' && card.key ? card.key : [card.sessionId, card.nativeId, card.operationId].every(v => typeof v === 'string' && v) ? JSON.stringify([card.sessionId, card.nativeId, card.operationId]) : null;
      if (!key) { unknown++; continue; }
      if (Number.isSafeInteger(card.expiresAt) && card.expiresAt <= now) continue;
      const valid = card.state === 'confirmation-required' && card.actionable === true && Number.isSafeInteger(card.expiresAt);
      cards.set(key, { key: JSON.stringify(['confirmation', key]), id: key, source: 'confirmation', spaceId: '@confirmations',
        kind: valid ? 'waiting' : 'unknown', memberKey: card.sessionId || '', text: '', current: true,
        expiresAt: Number.isSafeInteger(card.expiresAt) ? card.expiresAt : null,
        target: [card.sessionId, card.nativeId, card.operationId, card.id].every(v => typeof v === 'string' && v) ?
          { sessionId: card.sessionId, nativeId: card.nativeId, operationId: card.operationId, messageId: card.id, history: true } : null });
    }
    const cardRows = [...cards.values()];
    if (cardRows.length || !cardsAvailable) groups.push(finish({ id: '@confirmations', source: 'confirmation', name: '', available: cardsAvailable, all: cardRows }));
    const current = groups.flatMap(p => p.current);
    unknown += current.filter(q => q.kind === 'unknown').length;
    const cardCount = cardRows.filter(c => c.expiresAt !== null).length;
    return { groups, historyGroups: historyGroups.concat(groups.filter(p => p.source !== 'space')), cards: cardRows, doing: current.filter(q => q.kind === 'sent').length,
      waiting: current.filter(q => q.kind === 'waiting' && q.source !== 'confirmation').length + cardCount,
      done: current.filter(q => q.kind === 'done').length, cancelled: current.filter(q => q.kind === 'cancelled').length,
      failed: current.filter(q => q.kind === 'failed').length, unknown, cardCount, cardsAvailable,
      nextExpiry: cardRows.reduce((value, c) => c.expiresAt !== null && (value === null || c.expiresAt < value) ? c.expiresAt : value, null), stale: input.connected === false };
  }
  const TABS = ['active', 'waiting', 'sent', 'queued', 'review', 'unknown', 'failed', 'done', 'cancelled', 'all'];
  const timestamp = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 8640000000000000 ? value : null;
  function taskTime(item, sort) {
    if (sort === 'create') return timestamp(item.createdAt);
    if (sort === 'finish') return timestamp(item.finishedAt);
    const times = [item.createdAt, item.sentAt, item.finishedAt].map(timestamp).filter(t => t !== null);
    return times.length ? Math.max(...times) : null;
  }
  function selectTasks(items, { tab = 'active', search = '', sort = 'recent', descending = true, scope = 'all', space = 'all' } = {}, now = Date.now()) {
    const day = new Date(now), start = new Date(day.getFullYear(), day.getMonth(), day.getDate() - (scope === 'week' ? 6 : 0)).getTime();
    const end = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime(), term = search.trim().toLowerCase();
    const pool = items.filter(q => (space === 'all' || q.spaceId === space) &&
      (scope === 'all' || !['done', 'cancelled'].includes(q.kind) || timestamp(q.finishedAt) !== null && q.finishedAt >= start && q.finishedAt < end) &&
      (!term || [q.text, q.memberName, q.spaceName].some(v => typeof v === 'string' && v.toLowerCase().includes(term)) ||
        typeof q.id === 'string' && q.id.toLowerCase().startsWith(term) || typeof q.ready?.commit === 'string' && q.ready.commit.toLowerCase().startsWith(term)));
    const counts = Object.fromEntries(KINDS.map(k => [k, pool.filter(q => q.kind === k).length]));
    counts.active = KINDS.filter(k => !['done', 'cancelled'].includes(k)).reduce((n, k) => n + counts[k], 0); counts.all = pool.length;
    const matching = pool.filter(q => tab === 'all' || (tab === 'active' ? !['done', 'cancelled'].includes(q.kind) : q.kind === tab));
    matching.sort((a, b) => {
      const x = taskTime(a, sort), y = taskTime(b, sort);
      const tie = a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
      if (x === null || y === null) return x === null && y === null ? tie : x === null ? 1 : -1;
      return (descending ? y - x : x - y) || tie;
    });
    return { counts, items: matching };
  }
  function bind({ host, document: doc, text, onQueue, onConfirmation, onSession, now = () => Date.now() }) {
    const win = doc.defaultView;
    const f = (key, params) => text('taskBoard.' + key, params), make = (tag, cls) => { const e = doc.createElement(tag); if (cls) e.className = cls; return e; };
    const set = (e, value) => { if (e.textContent !== value) e.textContent = value; };
    const attr = (e, name, value) => { if (e.getAttribute(name) !== value) e.setAttribute(name, value); };
    const control = (handler, cls) => { const e = make('button', cls); e.type = 'button'; e.onclick = handler; return e; };
    const move = (parent, nodes) => {
      nodes.forEach((node, i) => { const before = parent.children[i] || null; if (before !== node) {
        if (node.isConnected && parent.isConnected && node.getRootNode() === parent.getRootNode() && parent.moveBefore) parent.moveBefore(node, before); else parent.insertBefore(node, before);
      } });
      for (const node of [...parent.children]) if (!nodes.includes(node)) node.remove();
    };
    let input = { rooms: [], sessions: [], connected: true }, data = [], opened = false, disposed = false, signature = '';
    let status = overview(input, now()), day = new Date(now()).toDateString(), waitingCount = null, limit = 10, order = [], orderPending = false;
    const selection = { tab: 'active', search: '', sort: 'recent', descending: true, scope: 'all', space: 'all' };
    let mode = 'flat';
    const rows = new Map(), groups = new Map(), tabs = new Map();
    const toggle = control(event => { event.preventDefault(); opened ? close() : open(); }, 'task-board-toggle task-status-button');
    const track = make('span', 'task-status-track'); attr(track, 'aria-hidden', 'true');
    const doing = make('span', 'task-status-doing'), waiting = make('span', 'task-status-waiting'), cardTime = make('span', 'task-status-card-time'), done = make('span', 'task-status-done'), warning = make('span', 'task-status-warning');
    const queued = make('span', 'task-status-queued'), chevron = make('span', 'task-status-chevron'); set(chevron, '⌄'); attr(chevron, 'aria-hidden', 'true');
    toggle.append(track, doing, waiting, cardTime, queued, done, warning, chevron);
    const panel = make('section', 'task-board-panel'); panel.hidden = true; panel.id = 'task-board-panel'; panel.dataset.mode = 'full';
    attr(panel, 'popover', 'auto'); attr(panel, 'aria-labelledby', 'task-board-title'); attr(toggle, 'popovertarget', panel.id); attr(toggle, 'aria-controls', panel.id);
    const heading = make('div', 'task-board-heading'), h2 = make('h2'), caption = make('span'), dismiss = control(close, 'task-board-close');
    h2.id = 'task-board-title'; h2.tabIndex = -1; heading.append(h2, caption, dismiss);
    const tablist = make('div', 'task-board-tabs'); attr(tablist, 'role', 'tablist');
    for (const value of TABS) {
      const button = control(() => chooseTab(value), 'task-board-tab'); button.id = 'task-board-tab-' + value; button.dataset.boardTab = value;
      attr(button, 'role', 'tab');
      button.onkeydown = event => {
        const i = TABS.indexOf(value), next = event.key === 'ArrowRight' ? (i + 1) % TABS.length : event.key === 'ArrowLeft' ? (i + TABS.length - 1) % TABS.length : event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : null;
        if (next === null) return; event.preventDefault(); chooseTab(TABS[next]); tabs.get(TABS[next]).focus({ preventScroll: true });
      };
      tabs.set(value, button); tablist.append(button);
    }
    const controls = make('div', 'task-board-controls'), labels = new Map();
    const search = make('input', 'task-board-search'); search.type = 'search'; search.autocomplete = 'off';
    const sort = make('select', 'task-board-sort'), direction = control(() => { selection.descending = !selection.descending; resetView(); }, 'task-board-direction');
    const sortWrap = make('div', 'task-board-sort-controls'); sortWrap.append(sort, direction);
    const scope = make('select', 'task-board-scope'), space = make('select', 'task-board-space'), grouping = make('select', 'task-board-mode');
    function label(key, target, content, cls = '') {
      const e = make('label', 'task-board-field ' + cls), name = make('span'); name.id = 'task-board-label-' + key;
      attr(target, 'aria-labelledby', name.id); e.append(name, content || target); labels.set(key, name); return e;
    }
    controls.append(label('search', search, null, 'task-board-search-field'), label('sort', sort, sortWrap), label('completionScope', scope), label('spaceFilter', space));
    const results = make('div', 'task-board-results'), count = make('span'), regroup = control(() => { if (orderPending) resetView(); }, 'task-board-regroup');
    attr(count, 'role', 'status'); attr(count, 'aria-live', 'polite');
    results.append(count, regroup, label('view', grouping));
    const hint = make('p', 'task-board-query-hint'), availability = make('p', 'task-board-availability'); attr(availability, 'role', 'status');
    const list = make('div', 'task-board-list'), flat = make('ul', 'task-board-flat-list'), empty = make('p', 'task-board-empty');
    attr(list, 'role', 'tabpanel'); list.tabIndex = 0;
    const moreLine = make('div', 'task-board-more-line'), shown = make('span'), more = control(() => { if (!more.hasAttribute('aria-disabled')) { limit += 10; drawPanel(); } }, 'task-board-more');
    moreLine.append(shown, more);
    const footer = make('div', 'task-board-footer'), retention = make('span', 'task-board-retention'); footer.append(retention);
    panel.append(heading, tablist, controls, results, hint, availability, list, moreLine, footer); host.classList.add('task-board'); host.append(toggle, panel);
    function options(select, values, name) {
      const previous = select.value;
      move(select, values.map(value => { let o = [...select.options].find(o => o.value === value); if (!o) { o = make('option'); o.value = value; } set(o, name(value)); return o; }));
      if (values.includes(previous)) select.value = previous;
    }
    function translate() {
      attr(host, 'aria-label', f('title')); attr(toggle, 'aria-expanded', String(opened));
      set(h2, f('title')); set(caption, f('global')); set(dismiss, '×'); attr(dismiss, 'aria-label', f('collapse'));
      attr(tablist, 'aria-label', f('filter'));
      for (const [key, e] of labels) set(e, f(key));
      search.placeholder = f('searchPlaceholder');
      options(sort, ['recent', 'create', 'finish'], value => f('sort.' + value));
      options(scope, ['all', 'today', 'week'], value => f('completion.' + value));
      options(grouping, ['flat', 'space', 'member'], value => f('view.' + value));
      const spaces = ['all', ...data.map(p => p.id)];
      options(space, spaces, value => value === 'all' ? f('allSpaces') : data.find(p => p.id === value).name);
      if (!spaces.includes(selection.space)) selection.space = 'all';
      space.value = selection.space; sort.value = selection.sort; scope.value = selection.scope; grouping.value = mode;
      set(direction, selection.descending ? '↓' : '↑'); attr(direction, 'aria-label', f(selection.descending ? 'descending' : 'ascending'));
      set(retention, f('retention')); attr(regroup, 'aria-description', f('orderHint'));
    }
    search.oninput = event => { if (!event.isComposing) { selection.search = search.value; resetView(); } };
    search.oncompositionend = () => { selection.search = search.value; resetView(); };
    for (const [element, field] of [[sort, 'sort'], [scope, 'scope'], [space, 'space']]) element.onchange = () => { selection[field] = element.value; resetView(); };
    grouping.onchange = () => { mode = grouping.value; resetView(); };
    function resetView() { order = []; limit = 10; drawPanel(); list.scrollTop = 0; }
    function chooseTab(value) {
      selection.tab = value; resetView();
      tabs.get(value).scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    function positionPanel() {
      const rect = toggle.getBoundingClientRect(), top = Math.min(rect.bottom + 8, Math.max(0, win.innerHeight - 160));
      const width = Math.max(1, Math.min(1120, win.innerWidth - (win.innerWidth <= 600 ? 0 : 32)));
      Object.assign(panel.style, { left: Math.max(0, (win.innerWidth - width) / 2) + 'px', top: top + 'px', width: width + 'px', maxHeight: Math.max(1, Math.min(780, win.innerHeight - top - 12)) + 'px' });
    }
    function open() {
      if (disposed) return;
      if (!opened) {
        Object.assign(selection, { tab: 'active', search: '', sort: 'recent', descending: true, scope: 'all', space: 'all' });
        mode = 'flat'; order = []; limit = 10; search.value = ''; list.scrollTop = 0;
      }
      opened = true; panel.hidden = false; drawPanel(); positionPanel(); panel.showPopover({ source: toggle });
    }
    function closed(restore = false) {
      if (!opened) return;
      const inside = panel.contains(doc.activeElement);
      opened = false; panel.hidden = true; translate(); drawBar();
      if ((restore || inside || doc.activeElement === doc.body) && toggle.isConnected && !doc.querySelector('dialog:modal')) toggle.focus({ preventScroll: true });
    }
    function close(restore = true) { if (opened) { if (panel.matches(':popover-open')) panel.hidePopover(); closed(restore); } }
    panel.addEventListener('toggle', () => { if (!panel.matches(':popover-open')) closed(); });
    function currentItems() {
      const priority = q => q.source === 'confirmation' ? 0 : ({ waiting: 1, sent: 2, queued: 3, review: 4, failed: 5, unknown: 6 })[q.kind] ?? 7;
      return status.groups.flatMap(p => p.current).filter(q => !['done', 'cancelled'].includes(q.kind)).sort((a, b) => priority(a) - priority(b) || (a.source === 'confirmation' && b.source === 'confirmation' ? (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity) : 0));
    }
    function remaining(expiresAt) {
      const seconds = Math.max(0, Math.ceil((expiresAt - now()) / 1000));
      return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    }
    function drawBar() {
      const count = waitingCount ?? status.waiting - status.cardCount;
      set(doing, status.stale ? f('unupdated') : f('doingCount', { count: status.doing }));
      set(waiting, status.stale ? '' : f(status.unknown ? count ? 'waitingUnknown' : 'waitingUnavailable' : 'waitingCount', { count }));
      waiting.hidden = status.stale; waiting.classList.toggle('needs-person', count > 0);
      const uncertain = status.cards.some(c => c.kind === 'unknown');
      set(cardTime, [!status.cardsAvailable ? f('cardsUnavailable') : '', status.cardCount ? f(status.cardCount === 1 ? 'cardDeadlineOne' : 'cardDeadline', { count: status.cardCount, time: remaining(status.nextExpiry) }) : '', uncertain ? f('cardsUnverified') : ''].filter(Boolean).join(' · '));
      cardTime.hidden = !cardTime.textContent;
      set(done, status.stale ? '' : f('queueDoneToday', { count: status.done })); done.hidden = status.stale;
      set(warning, status.unknown ? f('unknownCount', { count: status.unknown }) : status.failed ? f('failedCount', { count: status.failed }) : ''); warning.hidden = !warning.textContent;
      const items = currentItems(), cap = win.innerWidth <= 1000 ? 8 : 20;
      track.hidden = !items.length || status.stale;
      const cells = items.slice(0, cap).map(item => { let cell = [...track.children].find(c => c.dataset.itemKey === item.key); if (!cell) cell = make('i'); cell.className = 'task-status-square ' + (item.source === 'confirmation' ? 'confirmation' : item.kind); cell.dataset.itemKey = item.key; return cell; });
      if (items.length > cap) { let more = track.querySelector('.task-status-more'); if (!more) more = make('span', 'task-status-more'); set(more, status.unknown ? '…' : '+' + (items.length - cap)); cells.push(more); }
      move(track, cells);
      const queuedCount = items.filter(q => q.kind === 'queued').length; set(queued, f('queuedCount', { count: queuedCount })); queued.hidden = !queuedCount || status.stale;
      attr(toggle, 'aria-label', [doing, waiting, cardTime, queued, done, warning].filter(e => !e.hidden).map(e => e.textContent).join(' · ') + ' · ' + f('expand'));
      attr(toggle, 'aria-expanded', String(opened)); host.hidden = false;
    }
    function activate(key) {
      const item = data.flatMap(p => p.all).find(q => q.key === key);
      if (!item) return;
      if (item.source === 'confirmation') {
        if (!item.target || item.expiresAt !== null && item.expiresAt <= now()) { update(); return; }
        close(false); onConfirmation?.(item.target); return;
      }
      const session = (item.source !== 'space' || item.actualRecipient) && input.sessions?.find(s => s.id === item.memberKey && !s.archived);
      close(false);
      if (session && onSession) onSession(session.id, session.nativeId);
      else if (data.some(p => p.source === 'space' && p.id === item.spaceId)) onQueue(item.spaceId);
    }

    function title(item, actorName) {
      if (item.source === 'confirmation') return f('confirmation');
      if (item.source === 'conversation') return actorName;
      return item.text.split(/\r?\n/).map(line => line.trim()).find(Boolean) || f('untitled', { id: item.id.slice(0, 8) });
    }
    function row(item) {
      let view = rows.get(item.key);
      if (!view) {
        const element = make('li', 'task-board-task'), link = control(() => activate(item.key), 'task-board-entry'), body = make('div'), name = make('span', 'task-board-task-title'), note = make('small'), state = make('span', 'task-board-status'), action = make('span', 'task-board-row-action');
        body.append(name, note); link.append(body, state, action); element.append(link); element.dataset.taskKey = item.key;
        view = { element, link, name, note, state, action }; rows.set(item.key, view);
      }
      const actor = input.sessions?.find(s => s.id === item.memberKey), actorName = item.memberName || actor?.name || f(item.memberKey ? 'memberMissing' : 'unassigned');
      const origin = item.spaceName || data.find(p => p.id === item.spaceId)?.name || f('independent');
      view.link.dataset.itemId = item.id; view.link.dataset.sessionId = item.memberKey || ''; view.link.dataset.spaceId = item.spaceId; view.link.dataset.kind = item.kind; view.link.dataset.source = item.source;
      view.link.disabled = item.source === 'confirmation' ? !item.target : !actor && !data.some(p => p.source === 'space' && p.id === item.spaceId);
      view.link.classList.toggle('task-board-card-link', item.source === 'confirmation');
      const name = title(item, actorName); set(view.name, name); view.name.title = name;
      const value = taskTime(item, selection.sort), time = value === null ? '—' : new Intl.DateTimeFormat(doc.documentElement?.lang || undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(value);
      set(view.note, [origin, actorName, f('time.' + selection.sort, { time }), '#' + item.id.slice(0, 8)].join(' · '));
      set(view.state, item.source === 'confirmation' ? item.expiresAt === null ? f('cardsUnverified') : f('cardState') + ' · ' + remaining(item.expiresAt) : f(item.kind === 'sent' ? 'conversationWorking' : 'status.' + item.kind));
      view.state.dataset.kind = item.kind;
      set(view.action, f(item.source === 'confirmation' ? 'openCard' : (item.source !== 'space' || item.actualRecipient) && actor && !actor.archived ? 'openSession' : 'openQueue'));
      return view.element;
    }
    function drawPanel() {
      if (!opened) return;
      const focused = doc.activeElement, inside = list.contains(focused), scroll = list.scrollTop;
      const first = [...list.querySelectorAll('.task-board-task')].find(e => e.getBoundingClientRect().bottom > list.getBoundingClientRect().top);
      const offset = first ? first.getBoundingClientRect().top - list.getBoundingClientRect().top : 0;
      translate();
      const pool = data.flatMap(p => p.all.map(q => ({ ...q, spaceName: p.name, memberName: q.memberName || input.sessions?.find(s => s.id === q.memberKey)?.name || '' }))), result = selectTasks(pool, selection, now());
      for (const [value, button] of tabs) {
        set(button, f('count', { status: f(value === 'active' ? 'activeTab' : value === 'all' ? 'allTab' : ['sent', 'waiting', 'failed'].includes(value) ? 'tab.' + value : 'status.' + value), count: result.counts[value] }));
        button.dataset.count = String(result.counts[value]); attr(button, 'aria-selected', String(value === selection.tab)); button.tabIndex = value === selection.tab ? 0 : -1;
      }
      attr(list, 'aria-labelledby', tabs.get(selection.tab).id);
      const byKey = new Map(result.items.map(q => [q.key, q])), sorted = result.items.map(q => q.key);
      order = order.filter(key => byKey.has(key)); const existing = new Set(order); order.push(...sorted.filter(key => !existing.has(key)));
      orderPending = order.some((key, i) => key !== sorted[i]);
      regroup.hidden = !orderPending && focused !== regroup; set(regroup, f(orderPending ? 'refreshOrder' : 'orderCurrent'));
      if (orderPending) regroup.removeAttribute('aria-disabled'); else attr(regroup, 'aria-disabled', 'true');
      const available = new Set(pool.map(q => q.key));
      for (const [key, view] of rows) if (!available.has(key)) { view.element.remove(); rows.delete(key); }
      const displayed = order.slice(0, limit).map(key => byKey.get(key));
      if (mode === 'flat') { move(flat, displayed.map(row)); move(list, [flat]); }
      else {
        const wanted = new Map();
        for (const item of displayed) { const key = mode === 'space' ? item.spaceId : item.memberKey; if (!wanted.has(key)) wanted.set(key, []); wanted.get(key).push(item); }
        const nodes = [];
        for (const [key, items] of wanted) {
          const groupKey = mode + ':' + key; let g = groups.get(groupKey);
          if (!g) { const element = make('section', 'task-board-group'), heading = make('h3'), tasks = make('ul'); element.dataset.groupKey = key; element.append(heading, tasks); g = { element, heading, tasks }; groups.set(groupKey, g); }
          const name = mode === 'space' ? items[0].spaceName : items[0].memberName || f(key ? 'memberMissing' : 'unassigned');
          const total = result.items.filter(q => (mode === 'space' ? q.spaceId : q.memberKey) === key).length;
          set(g.heading, f('count', { status: name, count: total })); move(g.tasks, items.map(row)); nodes.push(g.element);
        }
        move(list, nodes);
      }
      if (!displayed.length) { set(empty, f('noMatches')); list.append(empty); }
      set(count, f('resultCount', { count: result.items.length }));
      set(hint, f(selection.scope !== 'all' ? 'scopeHint' : selection.sort === 'recent' ? 'recentHint' : 'missingTimeHint'));
      availability.hidden = !status.stale && !status.unknown;
      set(availability, f(status.stale ? 'stale' : 'partialCounts'));
      set(shown, f('shown', { shown: displayed.length, total: result.items.length }));
      const left = Math.max(0, result.items.length - limit);
      set(more, left ? f(selection.sort === 'recent' && selection.descending ? 'earlier' : 'more', { count: Math.min(10, left), total: result.items.length }) : f('allShown'));
      if (left) more.removeAttribute('aria-disabled'); else attr(more, 'aria-disabled', 'true');
      if (first?.isConnected && list.contains(first) && first.getBoundingClientRect().height) list.scrollTop += first.getBoundingClientRect().top - list.getBoundingClientRect().top - offset; else list.scrollTop = scroll;
      if (focused?.isConnected && doc.activeElement !== focused) focused.focus({ preventScroll: true });
      else if (inside && !focused?.isConnected) tabs.get(selection.tab).focus({ preventScroll: true });
    }
    function update(next = input) {
      if (disposed) return;
      input = next; status = overview(input, now()); day = new Date(now()).toDateString();
      data = status.historyGroups.map(p => ({ ...p, name: p.source === 'conversation' ? f('independent') : p.source === 'confirmation' ? f('confirmations') : p.archived ? f('archivedName', { name: p.name }) : p.name }));
      const nextSignature = JSON.stringify([data, status, input.connected, day, f('title')]);
      if (signature === nextSignature) return; signature = nextSignature; translate(); drawBar(); drawPanel();
    }
    function tick() {
      if (disposed) return;
      if (new Date(now()).toDateString() !== day || status.nextExpiry !== null && status.nextExpiry <= now()) { update(); return; }
      if (status.nextExpiry !== null) {
        drawBar();
        for (const c of status.cards) if (rows.has(c.key) && c.expiresAt !== null) row(c);
      }
    }
    const visible = () => { if (!doc.hidden) update(); }, resize = () => { drawBar(); if (opened) positionPanel(); };
    const observer = new win.ResizeObserver(resize); observer.observe(host); win.addEventListener('resize', resize); doc.addEventListener('visibilitychange', visible);
    return { update, open, close, tick, setWaitingCount(count) { if (!disposed && Number.isSafeInteger(count) && count >= 0 && count !== waitingCount) { waitingCount = count; drawBar(); } }, refresh: () => update(), dispose() { if (disposed) return; close(); disposed = true; observer.disconnect(); win.removeEventListener('resize', resize); doc.removeEventListener('visibilitychange', visible); host.replaceChildren(); groups.clear(); rows.clear(); } };
  }
  return { BAR_HEIGHT, COLORS, kind, project, overview, selectTasks, bind };
});
