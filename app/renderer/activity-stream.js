// Design B: a shared record beside the member view, and the same confirmation
// cards above every view. Reads existing state; never creates a model call.
(function (root) {
  function waitingLabel(items, text) {
    const confirmations = items.filter(item => item.kind === 'background-confirmation').length, other = items.length - confirmations;
    return [confirmations ? text(confirmations === 1 ? 'confirmation' : 'confirmations', { count: confirmations }) : '', other ? text('waiting', { count: other }) : ''].filter(Boolean).join(' · ');
  }
  function bind(host) {
    const doc = host.document, model = root.nativeWorkspaceTaskStream;
    const el = (tag, cls, text) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
    const t = (key, params) => host.text('stream.' + key, params);
    const button = (cls, label, act) => { const n = el('button', cls, label); n.type = 'button'; n.onclick = () => host.attempt(act); return n; };
    const state = () => host.state(), sessions = () => state()?.sessions || [];
    const roomOf = id => host.rooms().find(r => !r.archived && host.isMember(sessions().find(s => s.id === id), r.id))?.id || '';
    const roomName = id => { const room = host.rooms().find(r => r.id === id); return room ? host.roomName(room) : ''; };
    const nameOf = id => sessions().find(s => s.id === id)?.name || '';
    let openRoom = '', waitingOpen = false, waitingKey = '', filter = 'all', scope = '', limit = 120, signature = '';
    const cache = new Map(), waitingRows = new Map(); let waitingNodes;
    const strip = el('section', 'stream-waiting'); strip.id = 'stream-waiting'; strip.hidden = true;
    const panel = el('aside', 'activity-stream'); panel.id = 'activity-stream'; panel.hidden = true;
    const head = el('div', 'stream-heading'); head.append(el('strong', '', host.text('room.records')),
      button('small', t('close'), () => { openRoom = ''; render(); host.toggleChanged(); }));
    const tools = el('div', 'stream-tools'), search = el('input'); search.type = 'search'; search.placeholder = t('search'); search.setAttribute('aria-label', t('search'));
    search.oninput = () => { limit = 120; signature = ''; drawFeed(); };
    const filters = el('div', 'stream-filters'); filters.setAttribute('role', 'group'); filters.setAttribute('aria-label', t('filter'));
    for (const key of ['all', 'mine', 'active', 'queued', 'ended']) {
      const b = button('small', t(key), () => { filter = key; limit = 120; signature = ''; drawFeed(); }); b.dataset.filter = key; filters.append(b);
    }
    tools.append(filters, search);
    const list = el('div', 'stream-list'); list.tabIndex = 0; list.setAttribute('aria-label', host.text('room.recordContents'));
    panel.append(head, tools, list);
    doc.getElementById('room-layout').append(panel);
    doc.getElementById('header').before(strip);
    const validTime = time => Number.isFinite(time) && Math.abs(time) <= 8640000000000000;
    const clock = time => validTime(time) ? new Date(time).toLocaleTimeString(host.language(), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : '';
    const day = time => validTime(time) ? new Date(time).toLocaleDateString(host.language(), { year: 'numeric', month: 'long', day: 'numeric' }) : t('unknownDate');
    async function go(item) {
      waitingOpen = false; waitingKey = ''; drawWaiting();
      if (item.card) return host.confirmation({ sessionId: item.sessionId, nativeId: item.card.nativeId, messageId: item.id });
      if (item.sessionId || item.actorId) return host.original({ sessionId: item.sessionId || item.actorId, messageId: item.messageId || '', nativeId: '' });
      if (item.roomId) { await host.selectSpace(item.roomId); open(item.roomId); }
    }
    function drawWaiting() {
      const items = model.waitingItems({ rooms: host.rooms(), sessions: sessions(), confirmations: state()?.backgroundConfirmations,
        butlerId: state()?.steward?.sessionId, roomOf, nameOf });
      const questionState = items.filter(i => i.kind === 'question').map(i => {
        const s = sessions().find(s => s.id === i.sessionId);
        return [s?.nativeId, s?.owner, s?.state, s?.approvalOverflow, s?.serviceCapabilities, state()?.capabilities];
      });
      const key = JSON.stringify([host.language(), host.connected(), waitingOpen, items, questionState]);
      if (key === waitingKey) return;
      waitingKey = key;
      const label = waitingLabel(items, t);
      strip.hidden = !items.length; strip.setAttribute('aria-label', label);
      if (!waitingNodes) {
        const lead = button('stream-waiting-lead', '', () => go(waitingNodes.first));
        const more = button('small stream-waiting-more', '', () => { waitingOpen = !waitingOpen; drawWaiting(); });
        more.id = 'stream-waiting-more'; more.setAttribute('aria-controls', 'stream-waiting-list');
        const menu = el('div', 'stream-waiting-list'); menu.id = 'stream-waiting-list'; menu.setAttribute('role', 'list');
        waitingNodes = { lead, more, menu }; strip.append(lead, more, menu);
      }
      const { lead, more, menu } = waitingNodes, first = items[0]; waitingNodes.first = first;
      more.textContent = t(waitingOpen ? 'close' : 'allItems'); more.setAttribute('aria-expanded', String(waitingOpen));
      menu.hidden = !waitingOpen;
      if (!first) { menu.replaceChildren(); waitingRows.clear(); return; }
      lead.replaceChildren();
      lead.append(el('strong', 'stream-waiting-count', label), el('span', 'stream-kind', t(first.kind)),
        el('strong', '', first.actorName), el('span', 'stream-waiting-title', (first.card && host.cardTitle?.(first.card.message)) || first.title || t('approval')), el('span', 'quiet', clock(first.time)));
      {
        const rows = [], retained = new Set();
        for (const item of items) {
          const row = item.kind === 'question' && waitingRows.get(item.id) || el('div', 'stream-waiting-row'); row.dataset.waitingId = item.id; row.setAttribute('role', 'listitem');
          const top = button('stream-waiting-link', '', () => go(item));
          top.append(el('span', 'stream-kind', t(item.kind)), el('strong', '', item.actorName), el('span', 'quiet', roomName(item.roomId)), el('time', 'quiet', clock(item.time)));
          if (row.firstChild) row.replaceChild(top, row.firstChild); else row.append(top);
          if (item.card) {
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
          (filter === 'all' || filter === 'mine' && ['decide', 'look'].includes(task?.status) || filter === 'active' && task?.status === 'active' ||
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
          const article = el('article', 'stream-row'); article.dataset.recordId = row.id;
          const link = button('stream-record-link', '', () => entry.target ? host.original(entry.target) : details.open = !details.open);
          const title = el('div', 'stream-row-heading'), author = el('strong'), time = el('time'); title.append(author, time);
          const preview = el('div', 'stream-preview'); link.append(title, preview);
          const details = el('details', 'stream-detail'), summary = el('summary', '', t('detail')), body = el('div', 'stream-body'); details.append(summary, body);
          article.append(link, details); entry = { article, link, author, time, preview, details, summary, body }; cache.set(row.id, entry);
        }
        entry.target = target;
        const text = host.displayText(row.text, row.uiMessage) || '', label = host.label(row);
        if (entry.author.textContent !== label) entry.author.textContent = label;
        entry.time.textContent = clock(row.time); if (validTime(row.time)) entry.time.dateTime = new Date(row.time).toISOString(); else entry.time.removeAttribute('datetime');
        entry.link.title = t(target ? 'original' : 'detail');
        const preview = text.length > 200 ? text.slice(0, 200) + '…' : text;
        if (entry.preview.textContent !== preview) entry.preview.textContent = preview;
        entry.summary.textContent = t('detail'); if (entry.body.textContent !== text) entry.body.textContent = text;
        entry.article.classList.toggle('stream-speech', row.role === 'human' || row.role === 'assistant' || Boolean(row.wake || row.peerMessage));
        retained.add(row.id); nodes.push(entry.article);
      }
      if (!rows.length) nodes.push(el('p', 'quiet', t('empty')));
      if (all.length > rows.length) nodes.push(button('small stream-more', t('more'), () => { limit += 120; drawFeed(); }));
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
      openRoom = roomId; scope = memberId; filter = 'all'; search.value = ''; limit = 120; signature = '';
      if (recordId) {
        const room = host.rooms().find(r => r.id === roomId), at = model.records(room).findIndex(r => r.id === recordId);
        if (at >= limit) limit = at + 1;
      }
      render(); host.toggleChanged();
      if (recordId) { const entry = cache.get(recordId); if (entry) { entry.details.open = true; entry.article.scrollIntoView({ block: 'center' }); entry.link.focus({ preventScroll: true }); } }
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
    doc.addEventListener('keydown', e => { if (e.key === 'Escape' && waitingOpen) { waitingOpen = false; drawWaiting(); doc.getElementById('stream-waiting-more')?.focus(); } });
    doc.addEventListener('pointerdown', e => { if (waitingOpen && !strip.contains(e.target)) { waitingOpen = false; drawWaiting(); } });
    return { render, open, toggle(roomId) { if (openRoom === roomId) { openRoom = ''; render(); host.toggleChanged(); } else open(roomId); } };
  }
  root.nativeWorkspaceActivityStream = { bind, waitingLabel };
})(globalThis);
