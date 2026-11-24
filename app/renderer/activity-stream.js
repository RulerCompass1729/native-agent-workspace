// Design B: a shared record beside the member view, and the same confirmation
// cards above every view. Reads existing state; never creates a model call.
(function (root) {
  const waitingCount = items => items.filter(item => item.kind !== 'background-confirmation' && item.kind !== 'look').length;
  function waitingLabel(items, text) {
    const other = waitingCount(items), confirmations = items.filter(item => item.kind === 'background-confirmation').length, reviews = items.filter(item => item.kind === 'look').length;
    return [confirmations ? text(confirmations === 1 ? 'confirmation' : 'confirmations', { count: confirmations }) : '', other ? text('waiting', { count: other }) : '',
      reviews ? text('reviewCount', { count: reviews }) : ''].filter(Boolean).join(' · ');
  }
  function bind(host) {
    const doc = host.document, model = root.nativeWorkspaceTaskStream, disclosure = root.nativeWorkspaceDisclosure, PAGE = disclosure.PAGE;
    const el = (tag, cls, text) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
    const t = (key, params) => host.text('stream.' + key, params);
    const button = (cls, label, act) => { const n = el('button', cls, label); n.type = 'button'; n.onclick = () => host.attempt(act); return n; };
    const state = () => host.state(), sessions = () => state()?.sessions || [];
    const roomOf = id => host.rooms().find(r => !r.archived && host.isMember(sessions().find(s => s.id === id), r.id))?.id || '';
    const roomName = id => { const room = host.rooms().find(r => r.id === id); return room ? host.roomName(room) : ''; };
    const nameOf = id => sessions().find(s => s.id === id)?.name || '';
    let openRoom = '', waitingOpen = false, grantsOpen = false, waitingKey = '', filter = 'all', scope = '', limit = PAGE, signature = '';
    const cache = new Map(), waitingRows = new Map(), grantRows = new Map(); let waitingNodes;
    const strip = el('section', 'stream-waiting'); strip.id = 'stream-waiting'; strip.hidden = true;
    const panel = el('aside', 'activity-stream'); panel.id = 'activity-stream'; panel.hidden = true;
    const head = el('div', 'stream-heading'); head.append(el('strong', '', host.text('room.records')),
      button('small', t('close'), () => { openRoom = ''; render(); host.toggleChanged(); }));
    const tools = el('div', 'stream-tools'), search = el('input'); search.type = 'search'; search.placeholder = t('search'); search.setAttribute('aria-label', t('search'));
    search.oninput = () => { limit = PAGE; signature = ''; drawFeed(); };
    const filters = el('div', 'stream-filters'); filters.setAttribute('role', 'group'); filters.setAttribute('aria-label', t('filter'));
    for (const key of ['all', 'mine', 'active', 'queued', 'ended']) {
      const b = button('small', t(key), () => { filter = key; limit = PAGE; signature = ''; drawFeed(); }); b.dataset.filter = key; filters.append(b);
    }
    tools.append(filters, search);
    const list = el('div', 'stream-list'); list.tabIndex = 0; list.setAttribute('aria-label', host.text('room.recordContents'));
    // The next 15 earlier records; focus goes on from the first one that appears.
    const more = disclosure.pager({ document: doc, say: (n, key, params) => { n.textContent = host.text(key, params()); }, onMore: () => {
      const before = new Set(cache.keys());
      limit += PAGE; signature = ''; drawFeed();
      [...cache].find(([id]) => !before.has(id))?.[1].summary.focus();
    } });
    more.button.className += ' stream-more';
    panel.append(head, tools, list, more.status);
    doc.getElementById('room-layout').append(panel);
    // In the header row since 11-22: the needs-you count is shown once, beside the card countdown.
    doc.getElementById('header').insertBefore(strip, doc.getElementById('task-board'));
    const validTime = time => Number.isFinite(time) && Math.abs(time) <= 8640000000000000;
    const clock = time => validTime(time) ? new Date(time).toLocaleTimeString(host.language(), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : '';
    const day = time => validTime(time) ? new Date(time).toLocaleDateString(host.language(), { year: 'numeric', month: 'long', day: 'numeric' }) : t('unknownDate');
    async function go(item) {
      if (item.kind === 'operator-creation') { showCreation(item.sessionId, item.message.operator.actionKey); return; }
      waitingOpen = false; grantsOpen = false; waitingKey = ''; drawWaiting();
      if (item.card) return host.confirmation({ sessionId: item.sessionId, nativeId: item.card.nativeId, messageId: item.card.id, operationId: item.card.operationId });
      if (item.sessionId || item.actorId) return host.original({ sessionId: item.sessionId || item.actorId, messageId: item.messageId || '', nativeId: '' });
      if (item.roomId) { await host.selectSpace(item.roomId); open(item.roomId); }
    }
    function drawWaiting() {
      const items = model.waitingItems({ rooms: host.rooms(), sessions: sessions(), confirmations: state()?.backgroundConfirmations, operatorCreations: state()?.operatorCreations,
        butlerId: state()?.steward?.sessionId, roomOf, nameOf }).filter(item => !(item.card && host.cardHidden?.(item.card)));
      host.waitingChanged?.(waitingCount(items));
      const questionState = items.filter(i => i.kind === 'question').map(i => {
        const s = sessions().find(s => s.id === i.sessionId);
        return [s?.nativeId, s?.owner, s?.state, s?.approvalOverflow, s?.serviceCapabilities, state()?.capabilities];
      });
      const creationState = items.some(i => i.kind === 'operator-creation') ? [host.rooms().map(r => [r.id, r.name, r.archived]),
        sessions().map(s => [s.id, s.nativeId, s.serviceCapabilities])] : null;
      const grants = host.quota ? (state()?.operatorPolicy?.domains || []).filter(d => !d.revokedAt && d.expiresAt > Date.now()) : [];
      const key = JSON.stringify([host.language(), host.connected(), waitingOpen, grantsOpen, items, questionState, creationState, grants,
        state()?.operatorPolicy?.error, grants.length ? [sessions().map(s => [s.id, s.nativeId, s.name, s.state, s.archived, s.nativeContextPending, s.serviceCapabilities]), state()?.capabilities, host.rooms().map(r => [r.id, r.name, r.archived])] : null]);
      if (key === waitingKey) return;
      waitingKey = key;
      const label = waitingLabel(items, t);
      strip.hidden = !items.length && !grants.length; strip.setAttribute('aria-label', label || host.text('operator.quota.entry', { count: grants.length }));
      if (!waitingNodes) {
        const lead = button('stream-waiting-lead stream-waiting-more', '', () => { waitingOpen = !waitingOpen; grantsOpen = false; drawWaiting(); });
        lead.id = 'stream-waiting-more'; lead.setAttribute('aria-controls', 'stream-waiting-list');
        const menu = el('div', 'stream-waiting-list'); menu.id = 'stream-waiting-list'; menu.setAttribute('role', 'list');
        const grantsButton = button('small operator-grants-toggle', '', () => showGrants()); grantsButton.setAttribute('aria-controls', 'operator-grants-list');
        const grantsMenu = el('div', 'stream-waiting-list operator-grants-list'); grantsMenu.id = 'operator-grants-list'; grantsMenu.setAttribute('role', 'region');
        waitingNodes = { lead, menu, grantsButton, grantsMenu }; strip.append(lead, grantsButton, menu, grantsMenu);
      }
      const { lead, menu } = waitingNodes, first = items[0];
      lead.hidden = !first;
      lead.setAttribute('aria-expanded', String(waitingOpen && Boolean(first)));
      const { grantsButton, grantsMenu } = waitingNodes;
      grantsButton.hidden = !grants.length; grantsButton.textContent = host.text('operator.quota.entry', { count: grants.length }); grantsButton.setAttribute('aria-expanded', String(grantsOpen));
      grantsButton.title = host.text('operator.quota.entryHelp'); grantsButton.setAttribute('aria-description', grantsButton.title);
      grantsMenu.hidden = !grantsOpen || !grants.length; grantsMenu.setAttribute('aria-label', host.text('operator.quota.entry', { count: grants.length }));
      const grantNodes = [];
      for (const domain of grants) {
        let entry = grantRows.get(domain.id);
        if (!entry) { const row = el('div', 'stream-waiting-row'), actions = el('div'); row.append(actions); entry = { item: row, actions }; grantRows.set(domain.id, entry); }
        host.quota(entry, domain); grantNodes.push(entry.item);
      }
      for (const row of [...grantsMenu.children]) if (!grantNodes.includes(row)) row.remove();
      for (let i = 0; i < grantNodes.length; i++) if (grantsMenu.children[i] !== grantNodes[i]) grantsMenu.insertBefore(grantNodes[i], grantsMenu.children[i] || null);
      for (const id of grantRows.keys()) if (!grants.some(d => d.id === id)) grantRows.delete(id);
      menu.hidden = !waitingOpen || !first;
      if (!first) { menu.replaceChildren(); waitingRows.clear(); return; }
      lead.replaceChildren();
      lead.append(el('strong', 'stream-waiting-count', label), el('span', 'stream-kind', t(first.kind)),
        el('strong', '', first.actorName), el('span', 'stream-waiting-title', (first.card && host.cardTitle?.(first.card.message)) || first.title || t('approval')), el('span', 'quiet', clock(first.time)));
      {
        const rows = [], retained = new Set();
        for (const item of items) {
          const retainedKind = ['question', 'operator-creation'].includes(item.kind);
          const row = retainedKind && waitingRows.get(item.id) || el('div', 'stream-waiting-row'); row.dataset.waitingId = item.id; row.setAttribute('role', 'listitem');
          const top = retainedKind && row.firstChild || button('stream-waiting-link', '', () => go(item));
          top.onclick = () => host.attempt(() => go(item)); top.replaceChildren();
          top.append(el('span', 'stream-kind', t(item.kind)), el('strong', '', item.actorName), el('span', 'quiet', roomName(item.roomId)), el('time', 'quiet', clock(item.time)));
          if (row.firstChild !== top) { if (row.firstChild) row.replaceChild(top, row.firstChild); else row.append(top); }
          if (item.kind === 'operator-creation' && host.creation) {
            if (!row.operatorEntry) { const actions = el('div'); row.append(actions); row.operatorEntry = { item: row, actions }; }
            host.creation(row.operatorEntry, item.message);
            waitingRows.set(item.id, row); retained.add(item.id);
          } else if (item.card) {
            // The conversation renderer owns the full warning, stale/repeat
            // checks, buttons, disconnect state and backgroundDecision call.
            const actions = el('div'); row.append(actions);
            host.card({ item: row, actions }, item.card.message);
          } else if (item.kind === 'question' && host.question) {
            // A question that does not block its turn: its text and the session view's answer form, answered here.
            host.question(row, item);
            waitingRows.set(item.id, row); retained.add(item.id);
          } else row.append(button('stream-waiting-question', item.title || t('approval'), () => go(item)));
          rows.push(row);
        }
        // Keep an unchanged question's input connected, including during IME
        // composition. Updating another member must not erase the person's work.
        const wanted = new Set(rows);
        for (const row of [...menu.children]) if (!wanted.has(row)) row.remove();
        for (let i = 0; i < rows.length; i++) if (menu.children[i] !== rows[i]) menu.insertBefore(rows[i], menu.children[i] || null);
        for (const id of waitingRows.keys()) if (!retained.has(id)) waitingRows.delete(id);
      }
    }
    function showCreation(sessionId, actionKey) {
      waitingOpen = true; grantsOpen = false; waitingKey = ''; drawWaiting();
      waitingRows.get(`operator-creation:${sessionId}:${actionKey}`)?.operatorEntry?.operatorHeading?.focus();
    }
    async function showGrants(id) {
      grantsOpen = id ? true : !grantsOpen; waitingOpen = false; waitingKey = ''; drawWaiting();
      if (grantsOpen) { await host.refresh?.(); drawWaiting(); if (id) grantRows.get(id)?.quotaHeading?.focus(); }
    }
    function drawFeed() {
      const room = host.rooms().find(r => r.id === openRoom);
      if (!room) return;
      const tasks = model.roomTasks(room, { nameOf }), byEvent = new Map();
      for (const task of tasks.tasks) for (const event of task.history) byEvent.set(event.id, task);
      const query = search.value.trim().toLocaleLowerCase();
      const all = model.records(room).filter(row => {
        const task = byEvent.get(row.id), target = model.originalTarget(row, task?.item);
        return (!scope || target?.sessionId === scope || row.sessionId === scope) &&
          (!query || (host.displayText(row.text, row.uiMessage) + ' ' + host.label(row)).toLocaleLowerCase().includes(query)) &&
          (filter === 'all' || filter === 'mine' && task?.status === 'decide' || filter === 'active' && task?.status === 'active' ||
            filter === 'queued' && task?.status === 'queued' || filter === 'ended' && model.ENDED.includes(task?.status));
      });
      for (const b of filters.children) { b.textContent = t(b.dataset.filter); b.setAttribute('aria-pressed', String(b.dataset.filter === filter)); }
      search.placeholder = t('search');
      const rows = all.slice(0, limit), next = JSON.stringify([host.language(), rows, tasks.tasks.map(t => [t.id, t.status]), sessions().map(s => [s.id, s.name]), query, scope, limit]);
      if (next === signature) return;
      signature = next;
      const nodes = [], retained = new Set(), scroll = list.scrollTop, top = list.getBoundingClientRect().top;
      const anchor = scroll > 0 && [...list.querySelectorAll('[data-record-id]')].find(n => n.getBoundingClientRect().bottom > top);
      const offset = anchor ? anchor.getBoundingClientRect().top - top : 0;
      const focused = list.contains(doc.activeElement) ? doc.activeElement : null; let previousDay = '';
      for (const row of rows) {
        const date = day(row.time);
        if (date !== previousDay) { nodes.push(el('h3', 'stream-day', date)); previousDay = date; }
        const task = byEvent.get(row.id), target = model.originalTarget(row, task?.item);
        let entry = cache.get(row.id);
        if (!entry) {
          // One line (time · who · the start of the record) that opens to the whole record and the way to its original.
          const parts = disclosure.line(doc, 'article');
          parts.row.className += ' stream-row'; parts.row.dataset.recordId = row.id; parts.details.className = 'stream-detail';
          const author = el('strong'), preview = el('span', 'stream-preview'); parts.text.append(author, preview);
          const body = el('div', 'stream-body'), link = button('small stream-record-link', '', () => entry.target && host.original(entry.target));
          parts.body.append(body, link);
          entry = { article: parts.row, details: parts.details, summary: parts.summary, author, time: parts.time, preview, body, link }; cache.set(row.id, entry);
        }
        entry.target = target;
        const text = host.displayText(row.text, row.uiMessage) || '', label = host.label(row);
        if (entry.author.textContent !== label) entry.author.textContent = label;
        entry.time.textContent = clock(row.time); if (validTime(row.time)) entry.time.dateTime = new Date(row.time).toISOString(); else entry.time.removeAttribute('datetime');
        entry.link.textContent = t('original'); entry.link.hidden = !target;
        const preview = text.length > 200 ? text.slice(0, 200) + '…' : text;
        if (entry.preview.textContent !== preview) entry.preview.textContent = preview;
        if (entry.body.textContent !== text) entry.body.textContent = text;
        entry.article.classList.toggle('stream-speech', row.role === 'human' || row.role === 'assistant' || Boolean(row.wake || row.peerMessage));
        retained.add(row.id); nodes.push(entry.article);
      }
      if (!rows.length) nodes.push(el('p', 'quiet', t('empty')));
      nodes.push(more.button); more.show({ count: Math.min(PAGE, all.length - rows.length), total: all.length, shown: rows.length });
      // Reconcile existing entries in place: incoming events must not discard
      // an expanded record, keyboard focus or the person's reading position.
      for (let i = 0; i < nodes.length; i++) if (list.children[i] !== nodes[i]) list.insertBefore(nodes[i], list.children[i] || null);
      while (list.children.length > nodes.length) list.lastChild.remove();
      list.scrollTop = scroll;
      if (anchor?.isConnected) list.scrollTop += anchor.getBoundingClientRect().top - top - offset;
      if (focused?.isConnected && doc.activeElement !== focused) focused.focus({ preventScroll: true });
      for (const [id] of cache) if (!retained.has(id)) cache.delete(id);
    }
    function open(roomId, memberId = '', recordId = '') {
      openRoom = roomId; scope = memberId; filter = 'all'; search.value = ''; limit = PAGE; signature = '';
      if (recordId) {
        const room = host.rooms().find(r => r.id === roomId), at = model.records(room).findIndex(r => r.id === recordId);
        if (at >= limit) limit = at + 1;
      }
      render(); host.toggleChanged();
      if (recordId) { const entry = cache.get(recordId); if (entry) { entry.details.open = true; entry.article.scrollIntoView({ block: 'center' }); entry.summary.focus({ preventScroll: true }); } }
    }
    function render() {
      drawWaiting();
      const visible = host.inRoom() && openRoom === state()?.room?.id;
      panel.hidden = !visible;
      const layout = doc.getElementById('room-layout'); layout.classList.toggle('stream-open', visible);
      panel.setAttribute('aria-label', host.text('room.records'));
      head.firstChild.textContent = host.text('room.records'); head.lastChild.textContent = t('close');
      if (visible) drawFeed();
      const control = doc.getElementById('room-record');
      if (host.inRoom()) doc.getElementById('header-actions').append(control);
      control.hidden = !host.inRoom(); control.setAttribute('aria-pressed', String(visible));
    }
    doc.addEventListener('keydown', e => { if (e.key === 'Escape' && (waitingOpen || grantsOpen)) { const target = grantsOpen ? waitingNodes.grantsButton : waitingNodes.lead; waitingOpen = false; grantsOpen = false; drawWaiting(); target.focus(); } });
    doc.addEventListener('pointerdown', e => { if ((waitingOpen || grantsOpen) && !strip.contains(e.target)) { waitingOpen = false; grantsOpen = false; drawWaiting(); } });
    return { render, open, showCreation, showGrants, toggle(roomId) { if (openRoom === roomId) { openRoom = ''; render(); host.toggleChanged(); } else open(roomId); } };
  }
  root.nativeWorkspaceActivityStream = { bind, waitingLabel, waitingCount };
})(globalThis);
