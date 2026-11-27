(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.nativeWorkspaceTaskBoard = api;
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  const BAR_HEIGHT = 0;
  const COLORS = { sent: '#5c8fc1', queued: '#858276', waiting: '#e9b05b', review: '#b39b6a', stale: '#9c9483', failed: '#c95751', unknown: '#8a70a4', done: '#62916b', cancelled: '#aeb5aa', empty: '#eef0eb' };
  const KINDS = ['sent', 'queued', 'waiting', 'review', 'stale', 'failed', 'unknown', 'done', 'cancelled'];
  const PRIORITY = ['waiting', 'failed', 'unknown', 'review', 'stale', 'sent', 'queued', 'done', 'cancelled'];
  // The same rule as the 等你 strip (task-stream.js), resolved when called: the browser loads that file after this one.
  const endedSession = session => (typeof module === 'object' && module.exports ? require('../task-stream.js') : globalThis.nativeWorkspaceTaskStream).endedSession(session);
  const kind = item => !['sent', 'queued', 'waiting', 'failed', 'done', 'cancelled'].includes(item.status) ? 'unknown'
    : item.status === 'waiting' && ['no-reply', 'person-intervened', 'input-purpose-unconfirmed'].includes(item.reason) ? 'review' : item.status;
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
  function overview(input, now = Date.now()) {
    const sessions = new Map((input.sessions || []).map(s => [s.id, s]));
    let unknown = 0;
    const finish = p => {
      const current = p.all.filter(q => q.current), counts = Object.fromEntries(KINDS.map(k => [k, current.filter(q => q.kind === k).length]));
      return { ...p, current, counts, transit: counts.sent + counts.queued + counts.waiting + counts.review, attention: counts.waiting + counts.review + counts.stale + counts.failed + counts.unknown };
    };
    const historyGroups = project(input.rooms, input.sessions, now).map(p => {
      const statusExcluded = p.archived && p.available && !p.all.some(q => !['done', 'cancelled'].includes(q.kind));
      if (!p.available && !statusExcluded) unknown++;
      // A dispatched item stays 在做 whatever its session reports (R250 C, 11-25): the header square shows a lost session.
      return finish({ ...p, statusExcluded, source: 'space', all: p.all.map(q => ({ ...q, source: 'space',
        kind: q.kind === 'waiting' && endedSession(sessions.get(q.memberKey)) ? 'stale' : q.kind })) });
    });
    const groups = historyGroups.filter(p => !p.statusExcluded);
    const cards = new Map(), submittedCards = new Set();
    const cardsAvailable = input.confirmationsAvailable !== false && Array.isArray(input.confirmations);
    if (!cardsAvailable) unknown++;
    for (const card of Array.isArray(input.confirmations) ? input.confirmations : []) {
      if (!card || !['confirmation-required', 'unverifiable'].includes(card.state) || card.replacedBy || card.disposition) continue;
      const key = typeof card.key === 'string' && card.key ? card.key : [card.sessionId, card.nativeId, card.operationId].every(v => typeof v === 'string' && v) ? JSON.stringify([card.sessionId, card.nativeId, card.operationId]) : null;
      if (!key) { unknown++; continue; }
      if (card.state === 'confirmation-required' && card.submitted) { submittedCards.add(key); continue; }
      if (Number.isSafeInteger(card.expiresAt) && card.expiresAt <= now) continue;
      const session = sessions.get(card.sessionId);
      const current = session && !session.archived && Boolean(card.nativeId) && session.nativeId === card.nativeId;
      const valid = cardsAvailable && input.connected !== false && current && card.state === 'confirmation-required' && card.actionable === true && Number.isSafeInteger(card.expiresAt);
      const summary = current && !valid ? card.safeSummary : null;
      const text = summary?.titles?.[input.language] ? [summary.titles[input.language], summary.detail].filter(Boolean).join(' · ') : '';
      cards.set(key, { key: JSON.stringify(['confirmation', key]), id: key, source: 'confirmation', kind: valid ? 'waiting' : 'unknown',
        memberKey: current ? card.sessionId : '', text, expiresAt: Number.isSafeInteger(card.expiresAt) ? card.expiresAt : null });
    }
    const cardRows = [...cards.values()], current = groups.flatMap(p => p.current);
    unknown += current.filter(q => q.kind === 'unknown').length + cardRows.filter(c => c.kind === 'unknown').length;
    // Only a card the person can still act on has a deadline. An unverifiable card's stored expiry is evidence, not a countdown.
    const dueCards = cardRows.filter(c => c.kind === 'waiting' && c.expiresAt !== null);
    const cardCount = dueCards.length;
    return { groups, historyGroups, cards: cardRows, submittedCards, doing: current.filter(q => q.kind === 'sent').length,
      waiting: current.filter(q => q.kind === 'waiting').length + cardCount,
      done: current.filter(q => q.kind === 'done').length, cancelled: current.filter(q => q.kind === 'cancelled').length,
      failed: current.filter(q => q.kind === 'failed').length, unknown, cardCount, cardsAvailable,
      nextExpiry: dueCards.reduce((value, c) => value === null || c.expiresAt < value ? c.expiresAt : value, null), stale: input.connected === false };
  }
  // The tool a session is running now (11-24): its own running tool row in the current native turn.
  // Claude reports a command's output only when it ends, so only Codex rows have a last line.
  const firstLine = value => typeof value === 'string' ? (value.split(/\r?\n/).map(v => v.trim()).find(Boolean) || '').slice(0, 200) : '';
  // A Codex command's text grows with its output; only its tail can hold the last line.
  const lastLine = value => typeof value === 'string' ? (value.slice(-4096).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split(/\r\n|\n|\r/).map(v => v.trim()).filter(Boolean).at(-1) || '').slice(0, 200) : '';
  function stepDetail(m, preview) {
    if (m.toolKind === 'commandExecution') return firstLine(preview ? preview(m) : m.title);
    let input = null;
    if (typeof m.input === 'string' && m.input.length <= 262144) try { input = JSON.parse(m.input); } catch {}
    if (!input || typeof input !== 'object') return '';
    for (const key of ['description', 'command', 'file_path', 'path', 'pattern', 'url', 'query']) {
      const value = firstLine(input[key]);
      if (value) return value;
    }
    return '';
  }
  // preview: the renderer's own short form of a Codex command (nativeCommandPreview); a session waiting for the person runs nothing.
  function runningStep(s, preview) {
    if (!s || s.state !== 'working' || s.transportDisconnected || s.backendUnavailable || !Array.isArray(s.messages) || needsHuman(s)) return null;
    if (typeof s.nativeId !== 'string' || !s.nativeId || typeof s.activeTurnId !== 'string' || !s.activeTurnId) return null;
    for (let i = s.messages.length - 1; i >= Math.max(0, s.messages.length - 200); i--) {
      const m = s.messages[i];
      if (m?.role !== 'tool' || m.kind !== 'tool' || m.status !== 'running' || m.nativeId !== s.nativeId || m.turnId !== s.activeTurnId) continue;
      if (!Number.isFinite(m.time)) continue;
      const command = m.toolKind === 'commandExecution' || m.title === 'Bash';
      return { tool: command ? 'Bash' : typeof m.title === 'string' ? m.title.slice(0, 120) : '', detail: stepDetail(m, preview), startedAt: m.time,
        lastLine: m.toolKind === 'commandExecution' ? lastLine(m.text) : '' };
    }
    return null;
  }
  const stepClock = (value, lang) => new Intl.DateTimeFormat(lang || undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(value);
  // The board lists tasks only (R250, 11-25): six status groups, or one per agent or space.
  const GROUPS = ['waiting', 'sent', 'queued', 'problem', 'done', 'cancelled'], GROUPINGS = ['status', 'agent', 'space'], PAGE = 8;
  const GROUP_OF = { waiting: 'waiting', review: 'waiting', sent: 'sent', queued: 'queued', failed: 'problem', stale: 'problem', unknown: 'problem', done: 'done', cancelled: 'cancelled' };
  const SUB = { waiting: 'decide', review: 'look', failed: 'failed', stale: 'stale', unknown: 'unknown' };
  const FINISHED = { done: 'done', cancelled: 'cancelled', failed: 'failed' };
  const timestamp = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 8640000000000000 ? value : null;
  // Every retained queue item, then what waits for the person outside a queue (waitingItems, task-stream.js).
  // Queue decisions and reviews are queue items already; an expired card is gone.
  function taskRows(status, waiting = [], now = Date.now()) {
    const rows = [], spaces = new Map(status.historyGroups.map(p => [p.id, p]));
    for (const p of status.historyGroups) for (const q of p.all) rows.push({ key: q.key, id: q.id, source: 'space', kind: q.kind, group: GROUP_OF[q.kind], sub: SUB[q.kind] || '',
      text: q.text, reason: q.reason, memberKey: q.memberKey, memberName: q.memberName, route: q.actualRecipient ? q.memberKey : '', spaceId: p.id, spaceName: p.name, ready: q.ready, expiresAt: null,
      events: [['created', q.createdAt], ['sent', q.sentAt], [FINISHED[q.kind], FINISHED[q.kind] ? q.finishedAt : null]].filter(e => timestamp(e[1]) !== null) });
    for (const item of Array.isArray(waiting) ? waiting : []) {
      if (!item || typeof item.id !== 'string' || ['decide', 'look'].includes(item.kind)) continue;
      const card = item.kind === 'background-confirmation' ? item.card : null, expiresAt = Number.isSafeInteger(card?.expiresAt) ? card.expiresAt : null;
      if (expiresAt !== null && expiresAt <= now) continue;
      rows.push({ key: JSON.stringify(['waiting', item.id]), id: item.id, source: 'waiting', kind: item.kind, group: 'waiting', sub: card ? 'card' : item.kind,
        text: typeof item.title === 'string' ? item.title : '', reason: '', memberKey: item.actorId || item.sessionId || '', memberName: item.actorName || '', route: item.actorId || item.sessionId || '',
        spaceId: item.roomId || '', spaceName: spaces.get(item.roomId)?.name || '', ready: null, expiresAt, events: timestamp(item.time) === null ? [] : [['asked', item.time]], waiting: item });
    }
    // The stream lists only cards the person can act on; one that cannot be verified is checked under 异常, with no countdown.
    for (const card of status.cards || []) if (card.kind === 'unknown') rows.push({ key: card.key, id: card.id, source: 'confirmation', kind: 'unknown', group: 'problem', sub: 'unverified',
      text: card.text || '', reason: '', memberKey: card.memberKey, memberName: '', route: card.memberKey, spaceId: '', spaceName: '', ready: null, expiresAt: null, events: [] });
    return rows;
  }
  const latest = row => row.events.at(-1) || null;
  const stamp = row => latest(row)?.[1] ?? -1;
  function matches(row, term) {
    if (!term) return true;
    return [row.text, row.memberName, row.spaceName].some(v => typeof v === 'string' && v.toLowerCase().includes(term)) ||
      row.source === 'space' && (row.id.toLowerCase().startsWith(term.replace(/^#/, '')) || typeof row.ready?.commit === 'string' && row.ready.commit.toLowerCase().startsWith(term));
  }
  function bind({ host, document: doc, text, onQueue, onConfirmation, onSession, onOriginal, onWaiting, onConfirmationRefresh, confirmationTarget, now = () => Date.now() }) {
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
    let input = { rooms: [], sessions: [], connected: true }, waiting = [], opened = false, disposed = false, signature = '';
    let status = overview(input, now()), all = [], day = new Date(now()).toDateString(), grouping = 'status', term = '', expanded = '', frozen = null, rewound = false;
    const folds = new Map(), shown = new Map(), views = new Map(), groupViews = new Map();
    const toggle = control(event => { event.preventDefault(); opened ? close() : open(); }, 'task-board-toggle task-status-button');
    const confirmation = control(event => { event.preventDefault(); openConfirmations(); }, 'task-confirmation-entry task-status-button');
    confirmation.hidden = true;
    let opener = toggle;
    const board = make('span', 'task-status-board'), need = make('span', 'task-status-need'), due = make('span', 'task-status-due'), chevron = make('span', 'task-status-chevron');
    set(chevron, '⌄'); attr(chevron, 'aria-hidden', 'true'); toggle.append(board, need, due, chevron);
    const panel = make('section', 'task-board-panel'); panel.hidden = true; panel.id = 'task-board-panel';
    attr(panel, 'popover', 'auto'); attr(panel, 'aria-labelledby', 'task-board-title');
    for (const trigger of [confirmation, toggle]) { attr(trigger, 'popovertarget', panel.id); attr(trigger, 'aria-controls', panel.id); }
    const heading = make('div', 'task-board-heading'), h2 = make('h2'), dismiss = control(() => close(), 'task-board-close');
    h2.id = 'task-board-title'; h2.tabIndex = -1;
    const search = make('input', 'task-board-search'); search.type = 'search'; search.autocomplete = 'off';
    const switcher = make('div', 'task-board-grouping'), modes = new Map(); attr(switcher, 'role', 'group');
    for (const value of GROUPINGS) { const b = control(() => { if (grouping !== value) { grouping = value; relayout(); drawPanel(); } }, 'task-board-mode'); b.dataset.grouping = value; modes.set(value, b); switcher.append(b); }
    const total = make('span', 'task-board-total'); attr(total, 'role', 'status');
    heading.append(h2, search, switcher, total, dismiss);
    const availability = make('p', 'task-board-availability'); attr(availability, 'role', 'status');
    const list = make('div', 'task-board-list'), empty = make('p', 'task-board-empty');
    const footer = make('div', 'task-board-footer'), retention = make('span', 'task-board-retention'); footer.append(retention);
    panel.append(heading, availability, list, footer); host.classList.add('task-board'); host.append(confirmation, toggle, panel);
    const lang = () => doc.documentElement?.lang || undefined;
    function when(value) {
      const d = new Date(value), today = new Date(now()), yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
      const same = (x, y) => x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
      const clock = stepClock(value, lang());
      if (same(d, today)) return clock;
      if (same(d, yesterday)) return f('yesterday', { time: clock });
      return new Intl.DateTimeFormat(lang(), { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(value);
    }
    function remaining(expiresAt) {
      const seconds = Math.max(0, Math.ceil((expiresAt - now()) / 1000));
      return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    }
    // Search matches are marked; the text stays the person's own.
    function paint(e, value) {
      const key = term + '\u0000' + value;
      if (e.paintKey === key) return;
      e.paintKey = key;
      const lower = value.toLowerCase(), needle = term.replace(/^#/, '');
      if (!needle || lower.length !== value.length || !lower.includes(needle)) { e.textContent = value; return; }
      const parts = [];
      let at = 0;
      for (let i = lower.indexOf(needle); i >= 0; i = lower.indexOf(needle, at)) {
        if (i > at) { const plain = make('span'); plain.textContent = value.slice(at, i); parts.push(plain); }
        const mark = make('mark'); mark.textContent = value.slice(i, i + needle.length); parts.push(mark); at = i + needle.length;
      }
      if (at < value.length) { const plain = make('span'); plain.textContent = value.slice(at); parts.push(plain); }
      e.replaceChildren(...parts);
    }
    const liveSession = id => id && input.sessions?.find(s => s.id === id && !s.archived) || null;
    const title = row => row.text.split(/\r?\n/).map(line => line.trim()).find(Boolean) || (row.source === 'space' ? f('untitled', { id: row.id.slice(0, 8) }) : row.source === 'confirmation' ? f('confirmation') : text('stream.' + row.kind));
    const who = row => row.memberName || liveSession(row.memberKey)?.name || f(row.memberKey ? 'memberMissing' : 'unassigned');
    const where = row => row.spaceName || f('independent');
    const groupKey = (row, by = grouping) => by === 'status' ? row.group : by === 'agent' ? row.memberKey || '-' : row.spaceId || '-';
    const knownSpace = id => status.historyGroups.some(p => p.id === id);
    const unavailable = () => status.historyGroups.filter(p => !p.available && !p.statusExcluded);
    function subText(row) {
      if (row.sub === 'card') return f('sub.card', { time: remaining(row.expiresAt ?? now()) });
      if (row.sub === 'unverified') return f('cardsUnverified');
      if (row.source === 'waiting') return text('stream.' + row.kind);
      return row.sub ? f(row.sub === 'decide' ? 'status.waiting' : row.sub === 'look' ? 'status.review' : row.sub === 'failed' ? 'tab.failed' : 'status.' + row.sub) : '';
    }
    // The order and grouping are taken when the board opens and kept while it is open (③): rows change their text in place.
    function relayout() {
      const rows = all.filter(r => matches(r, term)).sort((a, b) => stamp(b) - stamp(a) || (a.key < b.key ? -1 : 1));
      const groups = new Map(grouping === 'status' ? GROUPS.map(k => [k, []]) : []);
      if (grouping === 'space') for (const p of unavailable()) groups.set(p.id, []);
      for (const r of rows) { const k = groupKey(r); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r.key); }
      const order = [...groups.keys()], byKey = new Map(rows.map(r => [r.key, r]));
      if (grouping !== 'status') {
        const first = k => byKey.get(groups.get(k)[0]), urgent = k => groups.get(k).some(key => byKey.get(key).group === 'waiting');
        order.sort((a, b) => urgent(b) - urgent(a) || (first(b) ? stamp(first(b)) : -1) - (first(a) ? stamp(first(a)) : -1));
      }
      frozen = { grouping, term, order, groups, where: new Map(), arrived: new Set() };
      rewound = true;
    }
    function arrange() {
      const byKey = new Map(all.filter(r => matches(r, term)).map(r => [r.key, r])), where = frozen.where;
      where.clear();
      for (const [k, keys] of frozen.groups) for (const key of keys) where.set(key, k);
      // A task that arrived while the board was open goes to the end of its group; one that waits for the person,
      // counted on the button, is never hidden behind 再显示 (N3).
      for (const r of byKey.values()) if (!where.has(r.key)) {
        const k = groupKey(r);
        if (!frozen.groups.has(k)) { frozen.groups.set(k, []); frozen.order.push(k); }
        frozen.groups.get(k).push(r.key); where.set(r.key, k); if (r.group === 'waiting') frozen.arrived.add(r.key);
      }
      const down = new Set(unavailable().map(p => p.id));
      return frozen.order.map(k => ({ key: k, items: frozen.groups.get(k).map(key => byKey.get(key)).filter(Boolean), unavailable: grouping === 'space' && down.has(k) }))
        .filter(g => g.items.length || g.unavailable);
    }
    function folded(g) {
      const id = grouping + '\u0000' + g.key;
      if (folds.has(id)) return folds.get(id);
      if (term) return false;
      if (grouping === 'status') return g.key === 'done' || g.key === 'cancelled';
      return !g.items.some(r => ['waiting', 'sent', 'queued', 'problem'].includes(r.group));
    }
    function groupName(g) {
      if (grouping === 'status') return f('group.' + g.key);
      const r = g.items[0];
      if (grouping === 'agent') return r ? who(r) : f('unassigned');
      return r ? where(r) : status.historyGroups.find(p => p.id === g.key)?.name || f('independent');
    }
    function translate() {
      attr(host, 'aria-label', f('title')); attr(toggle, 'aria-expanded', String(opened));
      set(h2, f('title')); set(dismiss, '×'); attr(dismiss, 'aria-label', f('collapse'));
      search.placeholder = f('searchPlaceholder'); attr(search, 'aria-label', f('search'));
      attr(switcher, 'aria-label', f('grouping'));
      for (const [value, b] of modes) { set(b, f('by.' + value)); attr(b, 'aria-pressed', String(value === grouping)); }
      set(retention, f('retention'));
    }
    function positionPanel() {
      const rect = toggle.getBoundingClientRect(), top = Math.min(rect.bottom + 8, Math.max(0, win.innerHeight - 160));
      const width = Math.max(1, Math.min(1140, win.innerWidth - (win.innerWidth <= 600 ? 0 : 32)));
      Object.assign(panel.style, { left: Math.max(0, (win.innerWidth - width) / 2) + 'px', top: top + 'px', width: width + 'px', maxHeight: Math.max(1, Math.min(780, win.innerHeight - top - 12)) + 'px' });
    }
    // Every opening starts grouped by status with 等你 first (F): no memory of the last choice.
    function open(options = {}) {
      if (disposed) return;
      settle();
      if (!opened) { grouping = 'status'; term = ''; search.value = ''; folds.clear(); shown.clear(); expanded = ''; }
      if (!opened || typeof options.expand === 'string') relayout();
      opened = true; panel.hidden = false; opener = options.source || toggle;
      if (typeof options.expand === 'string') { arrange(); reveal(options.expand); }
      drawBar(); drawPanel(); positionPanel(); panel.showPopover({ source: opener });
      const entry = views.get(options.expand)?.entry;
      if (opener === confirmation) (entry || h2).scrollIntoView({ block: 'nearest' });
      if (entry || opener === confirmation) (entry || h2).focus({ preventScroll: true });
    }
    function reveal(key) {
      const row = all.find(r => r.key === key);
      if (!row) return;
      expanded = key;
      const k = frozen.where.get(key), id = grouping + '\u0000' + k;
      if (k === undefined) return;
      folds.set(id, false); shown.set(id, Math.max(shown.get(id) || PAGE, frozen.groups.get(k).indexOf(key) + 1));
    }
    function closed(restore = false) {
      if (!opened) return;
      const inside = panel.contains(doc.activeElement), trigger = opener.hidden ? toggle : opener;
      opened = false; opener = toggle; panel.hidden = true; translate(); drawBar();
      // A closed board keeps no open row, so no hidden card keeps a countdown; the next opening starts folded (F).
      const v = views.get(expanded); expanded = '';
      if (v) { v.detail?.box.remove(); v.element.classList.remove('open'); attr(v.entry, 'aria-expanded', 'false'); }
      if ((restore || inside || doc.activeElement === doc.body) && trigger.isConnected && !doc.querySelector('dialog:modal')) trigger.focus({ preventScroll: true });
    }
    // A click outside hides the popover before its toggle event reports it (N2): that board is already closed.
    function settle() { if (opened && !panel.matches(':popover-open')) closed(); }
    function close(restore = true) { if (opened) { if (panel.matches(':popover-open')) panel.hidePopover(); closed(restore); } }
    panel.addEventListener('toggle', () => { if (!panel.matches(':popover-open')) closed(); });
    search.oninput = event => { if (!event.isComposing) { term = search.value.trim().toLowerCase(); relayout(); drawPanel(); } };
    search.oncompositionend = () => { term = search.value.trim().toLowerCase(); relayout(); drawPanel(); };
    const waitingRows = () => all.filter(r => r.group === 'waiting');
    function drawBar() {
      const cardCount = status.cardCount;
      const waitingForCheck = status.stale || (!status.cardsAvailable && input.confirmationsAvailable !== undefined) ||
        status.cards.some(c => c.kind === 'unknown');
      confirmation.hidden = !cardCount && !waitingForCheck;
      confirmation.dataset.state = cardCount ? 'pending' : 'unverified';
      set(confirmation, cardCount ? f('confirmationEntry', { count: cardCount }) : f('confirmationEntryUnverified'));
      attr(confirmation, 'aria-expanded', String(opened && opener === confirmation));
      // The card count is on its own entry. The board button shows the other waits.
      const rows = waitingRows().filter(row => !row.waiting?.card || confirmation.hidden && !status.submittedCards.has(row.id));
      const count = rows.length, next = rows.reduce((v, r) => r.expiresAt !== null && (v === null || r.expiresAt < v) ? r.expiresAt : v, null);
      const time = next === null ? '' : remaining(next);
      set(board, f('boardButton')); set(need, count ? f(count === 1 ? 'needOne' : 'need', { count }) : ''); need.hidden = !count;
      set(due, time ? f('cardDue', { time }) : ''); due.hidden = !time;
      attr(toggle, 'aria-label', [f('boardButton'), count ? f(count === 1 ? 'needOne' : 'need', { count }) : '', time ? f('cardDueLabel', { time }) : ''].filter(Boolean).join(f('labelSeparator')));
      attr(toggle, 'aria-expanded', String(opened)); host.hidden = false;
    }
    function go(row) {
      const session = liveSession(row.route);
      close(false);
      if (row.waiting?.messageId && onOriginal && session) onOriginal({ sessionId: session.id, messageId: row.waiting.messageId, nativeId: '' });
      else if (session && onSession) onSession(session.id, session.nativeId);
      else if (knownSpace(row.spaceId)) onQueue(row.spaceId);
    }
    function openCard(row) {
      const card = row.waiting?.card;
      if (!card || row.expiresAt !== null && row.expiresAt <= now()) { update(); return; }
      close(false); onConfirmation?.({ sessionId: card.sessionId, nativeId: card.nativeId, operationId: card.operationId, messageId: card.id, history: true });
    }
    function queue(spaceId) { close(false); onQueue(spaceId); }
    const REVIEW_REASONS = { 'no-reply': 'reasonNoReply', 'person-intervened': 'reasonIntervened', 'input-purpose-unconfirmed': 'reasonInputPurposeUnconfirmed' };
    function view(row) {
      let v = views.get(row.key);
      if (!v) {
        const element = make('li', 'task-board-task'), line = make('div', 'task-board-line'), dot = make('span', 'task-board-dot');
        const entry = control(() => { expanded = expanded === element.dataset.taskKey ? '' : element.dataset.taskKey; drawPanel(); }, 'task-board-entry');
        const name = make('span', 'task-board-task-title'), sub = make('span', 'task-board-sub'), agent = control(() => { const s = liveSession(v.row.route); if (s) { close(false); onSession?.(s.id, s.nativeId); } }, 'task-board-agent');
        const agentName = make('span'), space = make('span', 'task-board-space'), time = make('span', 'task-board-when'), event = make('b'), clock = make('span'), id = make('span', 'task-board-id');
        attr(dot, 'aria-hidden', 'true'); entry.append(name); agent.append(agentName); time.append(event, clock);
        line.append(dot, entry, sub, agent, space, time, id); line.onclick = e => { if (!e.target.closest?.('button')) entry.onclick(e); };
        element.append(line); element.dataset.taskKey = row.key;
        v = { element, line, dot, entry, name, sub, agent, agentName, space, time, event, clock, id, detail: null }; views.set(row.key, v);
      }
      v.row = row;
      const open = expanded === row.key, session = liveSession(row.route);
      Object.assign(v.entry.dataset, { itemId: row.id, kind: row.kind, source: row.source, sessionId: row.memberKey || '', spaceId: row.spaceId || '' });
      v.dot.dataset.group = row.group; attr(v.entry, 'aria-expanded', String(open)); v.element.classList.toggle('open', open);
      const words = title(row); paint(v.name, words); v.entry.title = words;
      // A row that changed status while the board is open keeps its place and names its new status.
      const moved = grouping === 'status' && frozen.where.get(row.key) !== row.group;
      const own = subText(row), label = (own === words ? '' : own) || (moved ? f('group.' + row.group) : row.ready ? f('ready', { commit: row.ready.commit.slice(0, 8) }) : grouping === 'status' ? '' : f('group.' + row.group));
      set(v.sub, label); v.sub.dataset.sub = row.sub || (!moved && row.ready ? 'ready' : 'plain'); v.sub.hidden = !label;
      v.agent.hidden = grouping === 'agent'; paint(v.agentName, who(row)); v.agent.disabled = !session;
      attr(v.agent, 'aria-label', session ? f('switchTo', { name: who(row) }) : who(row)); v.agent.title = v.agent.getAttribute('aria-label');
      v.space.hidden = grouping === 'space'; paint(v.space, where(row));
      const last = latest(row); set(v.event, last ? f('event.' + last[0]) : ''); set(v.clock, last ? when(last[1]) : '—');
      paint(v.id, row.source === 'space' ? '#' + row.id.slice(0, 8) : ''); v.id.hidden = row.source !== 'space';
      if (open) detail(v, row, session); else v.detail?.box.remove();
      return v.element;
    }
    function detail(v, row, session) {
      const d = v.detail ||= { box: make('div', 'task-board-detail'), full: make('p', 'task-board-full'), reason: make('p', 'task-board-reason'), timeline: make('p', 'task-board-timeline'), actions: make('div', 'task-board-actions'), slot: null };
      const parts = [];
      if (row.source === 'waiting' && onWaiting && ['background-confirmation', 'question', 'operator-creation'].includes(row.kind)) {
        // The conversation renderer's own card, answer form or creation card, kept while the row is open (11-25 A).
        if (!d.slot) {
          const box = make('div', 'task-board-waiting'), question = make('div', 'task-board-question'), heading = make('p'), actions = make('div');
          question.append(heading); box.append(question, actions); d.slot = { box, question, heading, entry: { item: box, actions } };
        }
        // The shared card countdown (renderer.js) ticks only under a row carrying the card's own id, not the row key.
        d.slot.box.dataset.waitingId = row.waiting.card?.id || row.id; set(d.slot.heading, row.kind === 'question' ? row.text : '');
        onWaiting(d.slot, row.waiting); parts.push(d.slot.box);
      }
      if (row.kind !== 'question' && row.source !== 'confirmation') { paint(d.full, row.text); if (row.text) parts.push(d.full); }
      const reason = row.kind === 'review' && REVIEW_REASONS[row.reason] ? f(REVIEW_REASONS[row.reason]) : '';
      set(d.reason, reason); if (reason) parts.push(d.reason);
      set(d.timeline, [...row.events.map(e => f('event.' + e[0]) + ' ' + when(e[1])), ...(row.ready ? [f('ready', { commit: row.ready.commit })] : [])].join(' → '));
      if (d.timeline.textContent) parts.push(d.timeline);
      const buttons = [], name = who(row);
      if (row.waiting?.card) buttons.push(['fullCard', {}, () => openCard(row)]);
      if (session && row.kind !== 'stale') buttons.push([['decide', 'waiting', 'approval', 'butler-question', 'question'].includes(row.kind) ? 'answerIn' : row.kind === 'review' ? 'checkIn' : 'openSessionOf', { name }, () => go(row)]);
      if (knownSpace(row.spaceId)) buttons.push(['openQueueOf', { name: where(row) }, () => queue(row.spaceId)]);
      d.buttons ||= new Map();
      const nodes = buttons.map(([key, params, act]) => { let b = d.buttons.get(key); if (!b) { b = control(() => b.act(), 'task-board-action'); b.dataset.action = key; d.buttons.set(key, b); } b.act = act; set(b, f(key, params)); return b; });
      move(d.actions, nodes); parts.push(d.actions);
      move(d.box, parts);
      if (d.box.parentElement !== v.element) v.element.append(d.box);
    }
    function groupView(g) {
      const id = grouping + '\u0000' + g.key;
      let v = groupViews.get(id);
      if (!v) {
        const element = make('section', 'task-board-group'), head = make('div', 'task-board-group-head'), fold = control(() => { folds.set(id, !folded(v.g)); drawPanel(); }, 'task-board-fold');
        const chev = make('span', 'task-board-chevron'), name = make('span', 'task-board-group-name'), count = make('span', 'task-board-group-count'), last = make('span', 'task-board-latest');
        const goTo = control(() => { if (grouping === 'agent') { const s = liveSession(v.g.key); if (s) { close(false); onSession?.(s.id, s.nativeId); } } else queue(v.g.key); }, 'task-board-go');
        const note = make('p', 'task-board-group-note'), rows = make('ul', 'task-board-rows'), more = control(() => { shown.set(id, (shown.get(id) || PAGE) + PAGE); drawPanel(); }, 'task-board-more');
        attr(chev, 'aria-hidden', 'true'); fold.append(chev, name, count); head.append(fold, last, goTo); element.dataset.groupKey = g.key;
        v = { element, head, fold, chev, name, count, last, goTo, note, rows, more }; groupViews.set(id, v);
      }
      v.g = g;
      const closedNow = folded(g), limit = shown.get(id) || PAGE, newest = g.items.reduce((best, r) => !best || stamp(r) > stamp(best) ? r : best, null);
      v.head.classList.toggle('waiting', grouping === 'status' && g.key === 'waiting');
      set(v.chev, closedNow ? '▸' : '▾'); set(v.name, groupName(g)); set(v.count, String(g.items.length)); attr(v.fold, 'aria-expanded', String(!closedNow));
      const last = newest && latest(newest); set(v.last, last ? f('event.' + last[0]) + ' ' + when(last[1]) : '');
      const session = grouping === 'agent' && liveSession(g.key), goes = Boolean(session) || grouping === 'space' && knownSpace(g.key);
      set(v.goTo, goes ? f(grouping === 'agent' ? 'openSession' : 'openQueue') : ''); v.goTo.hidden = !goes;
      set(v.note, g.unavailable ? f('spaceUnavailable') : '');
      const rows = closedNow ? [] : g.items.filter((r, i) => i < limit || frozen.arrived.has(r.key)).map(view);
      move(v.rows, rows);
      const left = closedNow ? 0 : g.items.length - rows.length;
      set(v.more, left ? f('more', { count: Math.min(PAGE, left), total: g.items.length }) : '');
      move(v.element, [v.head, ...(g.unavailable ? [v.note] : []), ...(rows.length ? [v.rows] : []), ...(left ? [v.more] : [])]);
      return v.element;
    }
    function drawPanel() {
      if (!opened) return;
      const focused = doc.activeElement, scroll = list.scrollTop;
      translate();
      if (!frozen || frozen.grouping !== grouping || frozen.term !== term) relayout();
      const groups = arrange(), used = new Set(groups.map(g => grouping + '\u0000' + g.key));
      const nodes = groups.map(groupView);
      if (!nodes.length) { set(empty, f(term ? 'noMatches' : 'empty')); nodes.push(empty); }
      move(list, nodes);
      for (const id of [...groupViews.keys()]) if (!used.has(id)) groupViews.delete(id);
      const keys = new Set(all.map(r => r.key));
      for (const key of [...views.keys()]) if (!keys.has(key)) views.delete(key);
      const found = groups.reduce((n, g) => n + g.items.length, 0);
      set(total, term ? f('found', { count: found }) : f(all.length === 1 ? 'totalOne' : 'total', { count: all.length }));
      const notes = [status.stale ? f('stale') : '', ...(grouping === 'space' ? [] : unavailable().map(p => f('spaceUnavailableNamed', { name: p.name }))), status.cardsAvailable ? '' : f('cardsUnavailable')].filter(Boolean);
      set(availability, notes.join(' · ')); availability.hidden = !notes.length;
      // A new order (opening, search, grouping) starts at the top; an update keeps the reading place (N10).
      list.scrollTop = rewound ? 0 : scroll; rewound = false;
      if (focused?.isConnected && doc.activeElement !== focused) focused.focus({ preventScroll: true });
    }
    function refreshRows() {
      all = taskRows(status, waiting, now());
      if (expanded && !all.some(r => r.key === expanded)) expanded = '';
    }
    function update(next = input, items = waiting) {
      if (disposed) return;
      const waitingChanged = items !== waiting;
      waiting = items; input = next; status = overview(input, now()); day = new Date(now()).toDateString();
      status.historyGroups = status.historyGroups.map(p => ({ ...p, name: p.archived ? f('archivedName', { name: p.name }) : p.name }));
      refreshRows();
      // A waiting row's message and card bodies stay with their renderer; the row's own fields decide a redraw.
      const nextSignature = JSON.stringify([all.map(r => ({ ...r, waiting: r.waiting ? r.waiting.id : undefined })), input.sessions?.map(s => [s.id, s.nativeId, s.name, s.archived]), status.stale, status.cardsAvailable, status.cardCount, [...status.submittedCards], unavailable().map(p => p.id), day, Math.floor(now() / 60000), f('title')]);
      if (signature === nextSignature) {
        if (waitingChanged && opened && expanded) { const v = views.get(expanded), row = all.find(r => r.key === expanded); if (v && row?.source === 'waiting') detail(v, row, liveSession(row.route)); }
        return;
      }
      signature = nextSignature; translate(); drawBar(); drawPanel();
    }
    // The waiting list's renderers keep their own state; an open row's card or answer form is refreshed on every pass.
    function setWaiting(items) { update(input, Array.isArray(items) ? items : []); }
    function tick() {
      if (disposed) return;
      const cards = all.filter(r => r.expiresAt !== null);
      const clock = now();
      if (status.cards.some(r => r.expiresAt !== null && r.expiresAt <= clock)) { refreshConfirmations(); return; }
      if (new Date(clock).toDateString() !== day || cards.some(r => r.expiresAt <= clock)) { update(); return; }
      if (cards.length) { drawBar(); for (const r of cards) { const v = views.get(r.key); if (v) set(v.sub, subText(r)); } }
    }
    function show(id) { settle(); if (opened && term) { term = ''; search.value = ''; } open({ expand: JSON.stringify(['waiting', id]) }); }
    function refreshConfirmations() { if (onConfirmationRefresh) onConfirmationRefresh(); else update(); }
    function openConfirmations() {
      refreshConfirmations(); settle();
      if (confirmation.hidden) return;
      if (opened && term) { term = ''; search.value = ''; relayout(); }
      const next = status.cards.reduce((first, card) => card.kind === 'waiting' &&
        (!first || card.expiresAt < first.expiresAt) ? card : first, null);
      const key = next ? JSON.stringify(['waiting', confirmationTarget?.(next.id) || next.id]) :
        status.cards.find(c => c.kind === 'unknown')?.key;
      open({ expand: key, source: confirmation });
    }
    const visible = () => { if (!doc.hidden) refreshConfirmations(); };
    const resize = () => { drawBar(); if (opened) positionPanel(); };
    const observer = new win.ResizeObserver(resize); observer.observe(host); win.addEventListener('resize', resize); doc.addEventListener('visibilitychange', visible);
    translate(); drawBar();
    return { update, open, close, tick, setWaiting, show, refresh: () => update(), dispose() { if (disposed) return; close(); disposed = true; observer.disconnect(); win.removeEventListener('resize', resize); doc.removeEventListener('visibilitychange', visible); host.replaceChildren(); groupViews.clear(); views.clear(); } };
  }
  return { BAR_HEIGHT, COLORS, kind, project, overview, taskRows, runningStep, stepClock, bind };
});
