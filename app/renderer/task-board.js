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
    let input = { rooms: [], sessions: [], connected: true }, data = [], opened = false, disposed = false, signature = '', mode = 'space', scope = 'today', filter = 'all';
    const groups = new Map(), rows = new Map(), placements = new Map();
    let full = false, needsRegroup = false, waitingCount = null, status = overview(input, now()), day = new Date(now()).toDateString();
    const toggle = control(event => { event.preventDefault(); opened ? close() : open(); }, 'task-board-toggle task-status-button');
    const track = make('span', 'task-status-track'); attr(track, 'aria-hidden', 'true');
    const doing = make('span', 'task-status-doing'), waiting = make('span', 'task-status-waiting'), cardTime = make('span', 'task-status-card-time'), done = make('span', 'task-status-done'), warning = make('span', 'task-status-warning');
    const queued = make('span', 'task-status-queued'), chevron = make('span', 'task-status-chevron'); set(chevron, '⌄'); attr(chevron, 'aria-hidden', 'true');
    toggle.append(track, doing, waiting, cardTime, queued, done, warning, chevron);
    const panel = make('section', 'task-board-panel'); panel.hidden = true; panel.id = 'task-board-panel'; attr(panel, 'popover', 'auto'); attr(toggle, 'popovertarget', panel.id);
    attr(panel, 'aria-labelledby', 'task-board-title'); attr(toggle, 'aria-controls', panel.id);
    const heading = make('div', 'task-board-heading'), h2 = make('h2'), caption = make('span'), dismiss = control(close, 'task-board-close');
    h2.id = 'task-board-title'; h2.tabIndex = -1;
    const back = control(() => changeView(false), 'task-board-current'); heading.append(back, h2, caption, dismiss);
    const summary = make('div', 'task-board-summary'), controls = make('div', 'task-board-controls'), scopeControls = make('div', 'task-board-options'), groupControls = make('div', 'task-board-options');
    const scopeButtons = new Map(), groupButtons = new Map();
    for (const value of ['today', 'all']) { const b = control(() => { scope = value; reset(); drawPanel(); }); scopeButtons.set(value, b); scopeControls.append(b); }
    for (const value of ['space', 'status', 'member']) { const b = control(() => { mode = value; reset(); drawPanel(); }); groupButtons.set(value, b); groupControls.append(b); }
    const select = make('select'); select.onchange = () => { filter = select.value; reset(); drawPanel(); };
    for (const k of ['all', ...KINDS]) { const o = make('option'); o.value = k; select.append(o); }
    const regroup = control(() => { if (needsRegroup) { groupButtons.get(mode).focus({ preventScroll: true }); reset(); drawPanel(); } }, 'task-board-regroup'); regroup.hidden = true;
    regroup.onblur = () => { if (!needsRegroup) regroup.hidden = true; };
    controls.append(scopeControls, groupControls, select, regroup);
    const currentList = make('ul', 'task-board-current-list');
    const list = make('div', 'task-board-list'), footer = make('div', 'task-board-footer'), hint = make('span'), queueSpace = make('select');
    const queue = control(() => { if (data.some(p => p.source === 'space' && p.id === queueSpace.value)) { const id = queueSpace.value; close(); onQueue(id); } }, 'task-board-queue');
    const fullButton = control(() => changeView(true), 'task-board-full');
    footer.append(hint, queueSpace, queue, fullButton); panel.append(heading, summary, controls, currentList, list, footer);
    host.classList.add('task-board'); host.append(toggle, panel);
    function translate() {
      attr(host, 'aria-label', f('title'));
      attr(toggle, 'aria-label', f(opened ? 'collapse' : 'expand')); attr(toggle, 'aria-expanded', String(opened));
      set(h2, f(full ? 'full' : 'currentTasks')); set(caption, full ? f(scope === 'today' ? 'range' : 'historyRange') : f('currentItemCount', { count: currentItems().length }));
      set(fullButton, f('fullView')); set(back, f('backCurrent')); back.hidden = !full; set(dismiss, '×'); attr(dismiss, 'aria-label', f('collapse'));
      attr(scopeControls, 'role', 'group'); attr(scopeControls, 'aria-label', f('scope')); attr(groupControls, 'role', 'group'); attr(groupControls, 'aria-label', f('group'));
      for (const [value, b] of scopeButtons) { set(b, f(value)); attr(b, 'aria-pressed', String(scope === value)); }
      for (const [value, b] of groupButtons) { set(b, f('by.' + value)); attr(b, 'aria-pressed', String(mode === value)); }
      for (const o of select.options) set(o, f(o.value === 'all' ? 'allStates' : 'status.' + o.value));
      attr(select, 'aria-label', f('filter')); attr(queueSpace, 'aria-label', f('chooseQueue')); set(queue, f('queue')); set(hint, f(input.connected === false ? 'stale' : full ? 'readOnly' : 'currentHint'));
      set(regroup, f(needsRegroup ? 'regroup' : 'groupCurrent')); attr(regroup, 'aria-description', f('regroupHint')); regroup.title = f('regroupHint');
    }
    function positionPanel() {
      const rect = toggle.getBoundingClientRect(), top = Math.min(rect.bottom + 6, Math.max(12, win.innerHeight - 160));
      const width = Math.max(1, Math.min(full ? 860 : win.innerWidth <= 1000 ? 530 : 600, win.innerWidth - 24));
      Object.assign(panel.style, { left: Math.max(12, Math.min(rect.right - width, win.innerWidth - width - 12)) + 'px', top: top + 'px', width: width + 'px', maxHeight: Math.max(1, Math.min(560, win.innerHeight - top - 14)) + 'px' });
    }
    function currentItems() {
      const priority = q => q.source === 'confirmation' ? 0 : ({ waiting: 1, sent: 2, queued: 3, review: 4, failed: 5, unknown: 6 })[q.kind] ?? 7;
      return status.groups.flatMap(p => p.current).filter(q => !['done', 'cancelled'].includes(q.kind)).sort((a, b) => priority(a) - priority(b) || (a.source === 'confirmation' && b.source === 'confirmation' ? (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity) : 0));
    }
    function reset() { for (const g of groups.values()) g.element.remove(); groups.clear(); rows.clear(); placements.clear(); currentList.replaceChildren(); needsRegroup = false; list.scrollTop = 0; }
    function changeView(value) { full = value; reset(); drawPanel(); positionPanel(); h2.focus({ preventScroll: true }); }
    function open(id) {
      if (disposed) return;
      if (!opened) { reset(); full = Boolean(id); scope = 'today'; mode = 'space'; filter = 'all'; select.value = 'all'; }
      opened = true; panel.hidden = false; translate(); drawPanel(); positionPanel(); panel.showPopover({ source: toggle });
      if (id) { queueSpace.value = id; const g = groups.get(id); if (g) { g.element.open = true; g.element.scrollIntoView({ block: 'nearest' }); } }
    }
    function closed(restore = false) {
      if (!opened) return;
      const inside = panel.contains(doc.activeElement);
      opened = false; panel.hidden = true; translate(); drawBar();
      if ((restore || inside || doc.activeElement === doc.body) && toggle.isConnected && !doc.querySelector('dialog:modal')) toggle.focus({ preventScroll: true });
    }
    function close(restore = true) { if (opened) { if (panel.matches(':popover-open')) panel.hidePopover(); closed(restore); } }
    panel.addEventListener('toggle', () => { if (!panel.matches(':popover-open')) closed(); });
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
      const session = input.sessions?.find(s => s.id === item.memberKey && !s.archived);
      close(false);
      if (session && onSession) onSession(session.id, session.nativeId);
      else if (data.some(p => p.source === 'space' && p.id === item.spaceId)) onQueue(item.spaceId);
    }
    function row(item) {
      let view = rows.get(item.key);
      if (!view) {
        const element = make('li', 'task-board-task'), link = control(() => activate(item.key), 'task-board-entry'), body = make('div'), title = make('span', 'task-board-task-title'), note = make('small'), status = make('span', 'task-board-status'), member = make('span', 'task-board-owner');
        const arrow = make('span', 'task-board-entry-chevron'); set(arrow, '›'); attr(arrow, 'aria-hidden', 'true'); body.append(title, note); link.append(body, status, member, arrow); element.append(link); element.dataset.taskKey = item.key; view = { element, link, title, note, status, member }; rows.set(item.key, view);
      }
      const actor = input.sessions?.find(s => s.id === item.memberKey), actorName = item.memberName || actor?.name || f(item.memberKey ? 'memberMissing' : 'unassigned');
      const origin = (item.source === 'confirmation' ? input.rooms?.find(p => actor?.roomIds?.includes(p.id))?.name : item.spaceName || data.find(p => p.id === item.spaceId)?.name) || f(item.source === 'confirmation' ? 'confirmations' : 'independent');
      view.link.dataset.itemId = item.id; view.link.dataset.sessionId = item.memberKey || ''; view.link.dataset.spaceId = item.spaceId; view.link.dataset.kind = item.kind; view.link.dataset.source = item.source;
      view.link.disabled = item.source === 'confirmation' ? !item.target : !actor && !data.some(p => p.source === 'space' && p.id === item.spaceId);
      view.link.classList.toggle('task-board-card-link', item.source === 'confirmation');
      set(view.title, item.source === 'confirmation' ? f('confirmation') : item.source === 'conversation' ? f(item.kind === 'sent' ? 'nativeWork' : 'status.' + item.kind) : item.text);
      set(view.status, !full && item.source === 'confirmation' ? item.expiresAt === null ? f('cardsUnverified') : f('cardState') + ' · ' + remaining(item.expiresAt) : f((!full || item.source === 'conversation') && item.kind === 'sent' ? 'conversationWorking' : 'status.' + item.kind)); view.status.dataset.kind = item.kind;
      set(view.member, actorName);
      set(view.note, !full ? origin + ' · ' + actorName : item.source === 'confirmation' ? item.expiresAt === null ? f('cardsUnverified') : f('cardDeadlineOne', { count: 1, time: remaining(item.expiresAt) }) : item.reason || item.waiting ? f('reasonInQueue') : mode !== 'space' ? origin : ''); view.note.hidden = !view.note.textContent;
      return view.element;
    }
    function drawCurrent() {
      const scroll = currentList.scrollTop, focused = doc.activeElement;
      const first = [...currentList.children].find(e => e.getBoundingClientRect().bottom > currentList.getBoundingClientRect().top), offset = first ? first.getBoundingClientRect().top - currentList.getBoundingClientRect().top : 0;
      const items = currentItems(), keys = new Set(items.map(q => q.key));
      for (const [key, view] of rows) if (!keys.has(key)) { view.element.remove(); rows.delete(key); }
      move(currentList, items.map(row));
      if (!items.length) currentList.append(make('li', 'task-board-empty')); if (!items.length) set(currentList.firstElementChild, f(status.unknown || status.stale ? 'unavailable' : 'noRecords'));
      if (first?.isConnected && currentList.contains(first)) currentList.scrollTop += first.getBoundingClientRect().top - currentList.getBoundingClientRect().top - offset; else currentList.scrollTop = scroll;
      if (focused?.isConnected && doc.activeElement !== focused) focused.focus({ preventScroll: true });
    }
    function group(key, name, index) {
      let g = groups.get(key);
      if (!g) {
        const element = make('details', 'task-board-group'), summary = make('summary'), label = make('span'), count = make('small'), empty = make('p', 'task-board-empty'), tasks = make('ul'), moreLine = make('div', 'task-board-more-line'), shown = make('span');
        const more = control(() => { if (!more.hasAttribute('aria-disabled')) { g.limit += g.batch; drawPanel(); } }, 'task-board-more');
        summary.append(label, count); moreLine.append(shown, more); element.append(summary, empty, tasks, moreLine); element.open = index === 0; element.dataset.groupKey = key;
        g = { element, label, count, empty, tasks, shown, more, order: [], limit: doc.defaultView.innerHeight <= 650 ? 3 : 5, batch: doc.defaultView.innerHeight <= 650 ? 3 : 5 }; groups.set(key, g);
        summary.addEventListener('click', () => { if (mode === 'space' && data.some(p => p.id === key && p.source === 'space')) queueSpace.value = key; });
      }
      set(g.label, name); return g;
    }
    function drawPanel() {
      if (!opened) return;
      panel.dataset.mode = full ? 'full' : 'current'; currentList.hidden = full; list.hidden = !full; summary.hidden = controls.hidden = queueSpace.hidden = queue.hidden = !full; fullButton.hidden = full;
      if (!full) { translate(); drawCurrent(); return; }
      const focused = doc.activeElement, scroll = list.scrollTop, first = [...list.querySelectorAll('.task-board-task')].find(e => e.getBoundingClientRect().bottom > list.getBoundingClientRect().top);
      const offset = first ? first.getBoundingClientRect().top - list.getBoundingClientRect().top : null;
      translate();
      const panelData = data.filter(p => scope === 'all' || !p.statusExcluded);
      const tasks = panelData.flatMap(p => scope === 'today' ? p.current : p.all), counts = KINDS.map(k => [k, tasks.filter(q => q.kind === k).length]);
      if (!summary.children.length) { summary.append(make('strong')); for (const k of KINDS) { const label = make('span'); label.dataset.kind = k; const swatch = make('i'); swatch.style.backgroundColor = COLORS[k]; label.append(swatch, make('span')); summary.append(label); } }
      set(summary.firstElementChild, f('transit', { count: tasks.filter(q => ['sent', 'queued', 'waiting', 'review'].includes(q.kind)).length }));
      for (const [k, count] of counts) { const label = summary.querySelector('[data-kind="' + k + '"]'); label.hidden = count === 0; set(label.lastElementChild, f('count', { status: scope === 'today' && ['done', 'cancelled'].includes(k) ? f('todayStatus', { status: f('status.' + k) }) : f('status.' + k), count })); }
      const wanted = new Map(); if (mode === 'space' && filter === 'all') for (const p of panelData) wanted.set(p.id, { name: p.name, items: [] });
      const matching = new Set(tasks.filter(q => filter === 'all' || q.kind === filter).map(q => q.key));
      const pool = panelData.flatMap(p => p.all), available = new Set(pool.map(q => q.key));
      for (const key of placements.keys()) if (!available.has(key)) placements.delete(key);
      for (const [key, view] of rows) if (!available.has(key)) { view.element.remove(); rows.delete(key); }
      needsRegroup = false;
      for (const item of pool.filter(q => matching.has(q.key) || placements.has(q.key))) {
        const actual = mode === 'space' ? item.spaceId : mode === 'status' ? item.kind : item.memberKey;
        const key = placements.has(item.key) ? placements.get(item.key) : actual;
        placements.set(item.key, key);
        if (key !== actual || !matching.has(item.key)) needsRegroup = true;
        const memberName = mode === 'member' && input.sessions?.find(s => s.id === key)?.name;
        if (!wanted.has(key)) wanted.set(key, { name: mode === 'space' ? item.spaceName : mode === 'status' ? f('status.' + key) : memberName || f(key ? 'memberMissing' : 'unassigned'), items: [] });
        wanted.get(key).items.push(item);
      }
      regroup.hidden = !needsRegroup && doc.activeElement !== regroup;
      if (needsRegroup) regroup.removeAttribute('aria-disabled'); else attr(regroup, 'aria-disabled', 'true');
      set(regroup, f(needsRegroup ? 'regroup' : 'groupCurrent'));
      // Freeze the relative order while open; pushes append new items instead of reprioritizing the reader's rows.
      const entries = [...wanted]; if (mode === 'status') entries.sort((a, b) => PRIORITY.indexOf(a[0]) - PRIORITY.indexOf(b[0]));
      for (const [key, value] of entries) {
        const g = group(key, value.name, groups.size), byId = new Map(value.items.map(q => [q.key, q]));
        const fresh = value.items.filter(q => !g.order.includes(q.key)); if (!g.order.length) fresh.sort((a, b) => PRIORITY.indexOf(a.kind) - PRIORITY.indexOf(b.kind));
        g.order = g.order.filter(id => byId.has(id)).concat(fresh.map(q => q.key));
        move(g.tasks, g.order.slice(0, g.limit).map(id => row(byId.get(id))));
        g.empty.hidden = value.items.length > 0;
        const p = mode === 'space' && data.find(p => p.id === key);
        set(g.empty, f(p && !p.available ? 'unavailable' : p && !p.all.length ? 'empty' : 'noRecords'));
        set(g.count, f('items', { count: value.items.length })); set(g.shown, f('shown', { shown: Math.min(g.limit, value.items.length), total: value.items.length }));
        const left = Math.max(0, value.items.length - g.limit); set(g.more, left ? f('more', { count: Math.min(g.batch, left), left }) : f('allShown'));
        if (left) g.more.removeAttribute('aria-disabled'); else attr(g.more, 'aria-disabled', 'true');
      }
      for (const [key, g] of groups) if (!wanted.has(key)) { move(g.tasks, []); g.empty.hidden = false; set(g.empty, f('noRecords')); set(g.count, f('items', { count: 0 })); set(g.shown, f('shown', { shown: 0, total: 0 })); set(g.more, f('allShown')); attr(g.more, 'aria-disabled', 'true'); }
      move(list, [...groups.values()].map(g => g.element));
      const options = data.filter(p => p.source === 'space').map(p => { let o = [...queueSpace.options].find(o => o.value === p.id); if (!o) { o = make('option'); o.value = p.id; } set(o, p.name); return o; });
      const chosen = queueSpace.value || input.activeSpace; move(queueSpace, options); if (data.some(p => p.source === 'space' && p.id === chosen)) queueSpace.value = chosen; queue.disabled = !data.some(p => p.source === 'space' && p.id === queueSpace.value);
      if (first?.isConnected && list.contains(first) && first.getBoundingClientRect().height) list.scrollTop += first.getBoundingClientRect().top - list.getBoundingClientRect().top - offset; else list.scrollTop = scroll;
      if (focused?.isConnected && doc.activeElement !== focused) focused.focus({ preventScroll: true });
    }
    function update(next = input) {
      if (disposed) return;
      input = next; status = overview(input, now()); day = new Date(now()).toDateString(); data = status.historyGroups.map(p => ({ ...p, name: p.source === 'conversation' ? f('independent') : p.source === 'confirmation' ? f('confirmations') : p.name }));
      const nextSignature = JSON.stringify([data, status, input.connected, input.activeSpace, f('title')]);
      if (signature === nextSignature) return; signature = nextSignature; translate(); drawBar(); drawPanel();
    }
    function tick() {
      if (disposed) return;
      if (new Date(now()).toDateString() !== day || status.nextExpiry !== null && status.nextExpiry <= now()) { update(); return; }
      if (status.nextExpiry !== null) {
        drawBar();
        for (const c of status.cards) { const view = rows.get(c.key); if (view && c.expiresAt !== null) row(c); }
      }
    }
    const visible = () => { if (!doc.hidden) update(); }, resize = () => { drawBar(); if (opened) positionPanel(); };
    const observer = new win.ResizeObserver(resize); observer.observe(host); win.addEventListener('resize', resize);
    doc.addEventListener('visibilitychange', visible);
    return { update, open, close, tick, setWaitingCount(count) { if (!disposed && Number.isSafeInteger(count) && count >= 0 && count !== waitingCount) { waitingCount = count; drawBar(); } }, refresh: () => update(), dispose() { if (disposed) return; close(); disposed = true; observer.disconnect(); win.removeEventListener('resize', resize); doc.removeEventListener('visibilitychange', visible); host.replaceChildren(); groups.clear(); rows.clear(); placements.clear(); } };
  }
  return { BAR_HEIGHT, COLORS, kind, project, overview, bind };
});
