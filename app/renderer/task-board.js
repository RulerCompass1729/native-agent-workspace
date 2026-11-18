(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.nativeWorkspaceTaskBoard = api;
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  const BAR_HEIGHT = 84;
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
          memberKey, memberName: members.get(memberKey) || '', text: typeof q.text === 'string' ? q.text : '',
          reason: typeof q.reason === 'string' ? q.reason : '', waiting: Array.isArray(q.wait) && q.wait.length > 0,
          current: !['done', 'cancelled'].includes(k) || typeof q.finishedAt === 'number' && Number.isFinite(q.finishedAt) && q.finishedAt >= start && q.finishedAt < end };
      });
      const current = all.filter(q => q.current), counts = Object.fromEntries(KINDS.map(k => [k, current.filter(q => q.kind === k).length]));
      return { id: room.id, name: room.name || '', archived: room.archived === true, available: room.unavailable !== true && Array.isArray(room.queue), all, current, counts,
        transit: counts.sent + counts.queued + counts.waiting + counts.review, attention: counts.waiting + counts.review + counts.failed + counts.unknown };
    });
  }
  function bind({ host, document: doc, text, onQueue, now = Date.now }) {
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
    const projects = new Map(), groups = new Map(), rows = new Map(), inert = new Map(), placements = new Map();
    let needsRegroup = false;
    const bar = make('div', 'task-board-bar'), identity = make('div', 'task-board-identity'), title = make('strong'), total = make('span'), segments = make('div', 'task-board-segments');
    identity.append(title, total);
    const toggle = control(() => opened ? close() : open(), 'task-board-toggle');
    bar.append(identity, segments, toggle);
    const panel = make('section', 'task-board-panel'); panel.hidden = true; panel.id = 'task-board-panel';
    attr(panel, 'aria-labelledby', 'task-board-title'); attr(toggle, 'aria-controls', panel.id);
    const heading = make('div', 'task-board-heading'), h2 = make('h2'), caption = make('span'), dismiss = control(close, 'task-board-close');
    h2.id = 'task-board-title'; h2.tabIndex = -1; heading.append(h2, caption, dismiss);
    const summary = make('div', 'task-board-summary'), controls = make('div', 'task-board-controls'), scopeControls = make('div', 'task-board-options'), groupControls = make('div', 'task-board-options');
    const scopeButtons = new Map(), groupButtons = new Map();
    for (const value of ['today', 'all']) { const b = control(() => { scope = value; reset(); drawPanel(); }); scopeButtons.set(value, b); scopeControls.append(b); }
    for (const value of ['space', 'status', 'member']) { const b = control(() => { mode = value; reset(); drawPanel(); }); groupButtons.set(value, b); groupControls.append(b); }
    const select = make('select'); select.onchange = () => { filter = select.value; reset(); drawPanel(); };
    for (const k of ['all', ...KINDS]) { const o = make('option'); o.value = k; select.append(o); }
    const regroup = control(() => { if (needsRegroup) { groupButtons.get(mode).focus({ preventScroll: true }); reset(); drawPanel(); } }, 'task-board-regroup'); regroup.hidden = true;
    regroup.onblur = () => { if (!needsRegroup) regroup.hidden = true; };
    controls.append(scopeControls, groupControls, select, regroup);
    const list = make('div', 'task-board-list'), footer = make('div', 'task-board-footer'), hint = make('span'), queueSpace = make('select');
    const queue = control(() => { if (queueSpace.value) { const id = queueSpace.value; close(); onQueue(id); } });
    footer.append(hint, queueSpace, queue); panel.append(heading, summary, controls, list, footer);
    host.classList.add('task-board'); host.style.setProperty('--task-board-height', BAR_HEIGHT + 'px'); host.append(bar, panel); host.parentElement.classList.add('task-board-main');
    function translate() {
      attr(host, 'aria-label', f('title'));
      set(title, f('title')); set(toggle, f(opened ? 'collapse' : 'expand')); attr(toggle, 'aria-expanded', String(opened));
      set(h2, f('full')); set(caption, f(scope === 'today' ? 'range' : 'historyRange')); set(dismiss, '×'); attr(dismiss, 'aria-label', f('collapse'));
      attr(scopeControls, 'role', 'group'); attr(scopeControls, 'aria-label', f('scope')); attr(groupControls, 'role', 'group'); attr(groupControls, 'aria-label', f('group'));
      for (const [value, b] of scopeButtons) { set(b, f(value)); attr(b, 'aria-pressed', String(scope === value)); }
      for (const [value, b] of groupButtons) { set(b, f('by.' + value)); attr(b, 'aria-pressed', String(mode === value)); }
      for (const o of select.options) set(o, f(o.value === 'all' ? 'allStates' : 'status.' + o.value));
      attr(select, 'aria-label', f('filter')); attr(queueSpace, 'aria-label', f('chooseQueue')); set(queue, f('queue')); set(hint, f(input.connected === false ? 'stale' : 'readOnly'));
      set(regroup, f(needsRegroup ? 'regroup' : 'groupCurrent')); attr(regroup, 'aria-description', f('regroupHint')); regroup.title = f('regroupHint');
    }
    function freezeBackground() {
      for (const child of host.parentElement.children) if (child !== host && !inert.has(child)) { inert.set(child, child.inert); child.inert = true; }
    }
    function reset() { for (const g of groups.values()) g.element.remove(); groups.clear(); rows.clear(); placements.clear(); needsRegroup = false; list.scrollTop = 0; }
    function open(id) {
      if (disposed) return;
      if (!opened) { reset(); scope = 'today'; mode = 'space'; filter = 'all'; select.value = 'all'; }
      opened = true; panel.hidden = false; freezeBackground(); translate(); drawPanel();
      for (const [key, p] of projects) attr(p.button, 'aria-expanded', 'true');
      if (id) { queueSpace.value = id; const g = groups.get(id); if (g) { g.element.open = true; g.element.scrollIntoView({ block: 'nearest' }); } }
      h2.focus({ preventScroll: true });
    }
    function close() {
      if (!opened) return;
      opened = false; panel.hidden = true; for (const [child, before] of inert) child.inert = before; inert.clear();
      translate(); for (const p of projects.values()) attr(p.button, 'aria-expanded', 'false'); toggle.focus({ preventScroll: true });
    }
    function drawBar() {
      set(total, input.connected === false || data.some(p => !p.available) ? f('unupdated') : f('current', { count: data.reduce((n, p) => n + p.transit, 0) }));
      const wanted = [];
      for (const p of data) {
        let view = projects.get(p.id);
        if (!view) {
          const button = control(() => open(p.id), 'task-board-project'), line = make('div', 'task-board-project-name'), name = make('span'), flag = make('span', 'task-board-attention'), primary = make('strong'), sub = make('span', 'task-board-parts'), track = make('span', 'task-board-track');
          attr(track, 'aria-hidden', 'true'); line.append(name, flag); button.append(line, primary, sub, track); button.dataset.spaceId = p.id;
          const fills = new Map(); for (const k of KINDS) { const fill = make('i', k); fill.style.backgroundColor = COLORS[k]; track.append(fill); fills.set(k, fill); }
          view = { button, name, flag, primary, sub, fills }; projects.set(p.id, view);
        }
        const c = p.counts, parts = f('parts', { sent: c.sent, queued: c.queued }) + (c.waiting + c.review ? f('waitingPart', { count: c.waiting + c.review }) : '');
        const primary = !p.available ? f('unavailable') : !p.all.length ? f('empty') : !p.current.length ? f('noTransit') : f('transit', { count: p.transit });
        const sub = p.transit ? parts : c.done + c.cancelled ? f('finished', { done: c.done, cancelled: c.cancelled }) : p.all.length ? f('historyHint') : '';
        set(view.name, p.archived ? f('archivedName', { name: p.name }) : p.name); set(view.flag, f('attention', { count: p.attention })); view.flag.hidden = !p.attention; view.flag.classList.toggle('failed', c.failed > 0);
        set(view.primary, primary); set(view.sub, sub); attr(view.button, 'aria-controls', panel.id); attr(view.button, 'aria-expanded', String(opened));
        attr(view.button, 'aria-label', [p.name, p.attention && view.flag.textContent, primary, sub, p.archived && f('archived')].filter(Boolean).join('，'));
        attr(view.button, 'aria-description', [f('range'), ...KINDS.filter(k => c[k]).map(k => f('count', { status: f('status.' + k), count: c[k] }))].join('，'));
        for (const [k, fill] of view.fills) { fill.hidden = !c[k]; fill.style.width = (p.current.length ? c[k] / p.current.length * 100 : 0) + '%'; }
        wanted.push(view.button);
      }
      move(segments, wanted);
      for (const [id, view] of projects) if (!data.some(p => p.id === id)) { view.button.remove(); projects.delete(id); }
      if (!data.length && opened) close();
      host.hidden = data.length === 0;
    }
    function row(item) {
      let view = rows.get(item.key);
      if (!view) { const element = make('li', 'task-board-task'), body = make('div'), title = make('span', 'task-board-task-title'), note = make('small'), status = make('span', 'task-board-status'), member = make('span', 'task-board-owner'); body.append(title, note); element.append(body, status, member); element.dataset.taskKey = item.key; view = { element, title, note, status, member }; rows.set(item.key, view); }
      set(view.title, item.text); set(view.status, f('status.' + item.kind)); view.status.dataset.kind = item.kind;
      set(view.member, item.memberName || f(item.memberKey ? 'memberMissing' : 'unassigned'));
      set(view.note, item.reason || item.waiting ? f('reasonInQueue') : mode !== 'space' ? item.spaceName : ''); view.note.hidden = !view.note.textContent;
      return view.element;
    }
    function group(key, name, index) {
      let g = groups.get(key);
      if (!g) {
        const element = make('details', 'task-board-group'), summary = make('summary'), label = make('span'), count = make('small'), empty = make('p', 'task-board-empty'), tasks = make('ul'), moreLine = make('div', 'task-board-more-line'), shown = make('span');
        const more = control(() => { if (!more.hasAttribute('aria-disabled')) { g.limit += g.batch; drawPanel(); } }, 'task-board-more');
        summary.append(label, count); moreLine.append(shown, more); element.append(summary, empty, tasks, moreLine); element.open = index === 0; element.dataset.groupKey = key;
        g = { element, label, count, empty, tasks, shown, more, order: [], limit: doc.defaultView.innerHeight <= 650 ? 3 : 5, batch: doc.defaultView.innerHeight <= 650 ? 3 : 5 }; groups.set(key, g);
        summary.addEventListener('click', () => { if (mode === 'space') queueSpace.value = key; });
      }
      set(g.label, name); return g;
    }
    function drawPanel() {
      if (!opened) return;
      const focused = doc.activeElement, scroll = list.scrollTop, first = [...list.querySelectorAll('.task-board-task')].find(e => e.getBoundingClientRect().bottom > list.getBoundingClientRect().top);
      const offset = first ? first.getBoundingClientRect().top - list.getBoundingClientRect().top : null;
      translate(); freezeBackground();
      const tasks = data.flatMap(p => scope === 'today' ? p.current : p.all), counts = KINDS.map(k => [k, tasks.filter(q => q.kind === k).length]);
      if (!summary.children.length) { summary.append(make('strong')); for (const k of KINDS) { const label = make('span'); label.dataset.kind = k; const swatch = make('i'); swatch.style.backgroundColor = COLORS[k]; label.append(swatch, make('span')); summary.append(label); } }
      set(summary.firstElementChild, f('transit', { count: tasks.filter(q => ['sent', 'queued', 'waiting', 'review'].includes(q.kind)).length }));
      for (const [k, count] of counts) { const label = summary.querySelector('[data-kind="' + k + '"]'); label.hidden = count === 0; set(label.lastElementChild, f('count', { status: scope === 'today' && ['done', 'cancelled'].includes(k) ? f('todayStatus', { status: f('status.' + k) }) : f('status.' + k), count })); }
      const wanted = new Map(); if (mode === 'space' && filter === 'all') for (const p of data) wanted.set(p.id, { name: p.name, items: [] });
      const matching = new Set(tasks.filter(q => filter === 'all' || q.kind === filter).map(q => q.key));
      const pool = data.flatMap(p => p.all), available = new Set(pool.map(q => q.key));
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
      const options = data.map(p => { let o = [...queueSpace.options].find(o => o.value === p.id); if (!o) { o = make('option'); o.value = p.id; } set(o, p.name); return o; });
      const chosen = queueSpace.value || input.activeSpace; move(queueSpace, options); if (data.some(p => p.id === chosen)) queueSpace.value = chosen; queue.disabled = !queueSpace.value;
      if (first?.isConnected && list.contains(first) && first.getBoundingClientRect().height) list.scrollTop += first.getBoundingClientRect().top - list.getBoundingClientRect().top - offset; else list.scrollTop = scroll;
      if (focused?.isConnected && doc.activeElement !== focused) focused.focus({ preventScroll: true });
    }
    function update(next = input) {
      if (disposed) return;
      input = next; data = project(input.rooms, input.sessions, now());
      const nextSignature = JSON.stringify([data, input.connected, input.activeSpace, f('title')]);
      if (signature === nextSignature) return; signature = nextSignature; translate(); drawBar(); drawPanel();
    }
    const key = e => { if (opened && e.key === 'Escape') { e.stopPropagation(); close(); } }, visible = () => { if (!doc.hidden) update(); };
    doc.addEventListener('keydown', key); doc.addEventListener('visibilitychange', visible);
    return { update, open, close, refresh: () => update(), dispose() { if (disposed) return; close(); disposed = true; doc.removeEventListener('keydown', key); doc.removeEventListener('visibilitychange', visible); host.replaceChildren(); host.parentElement.classList.remove('task-board-main'); } };
  }
  return { BAR_HEIGHT, COLORS, kind, project, bind };
});
