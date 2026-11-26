// R248/R249: a space's 「总览」 (who does what, what waits for you) and 「信息流」 (one line per thing that happened).
// Both read existing state only (task-stream.js); neither calls a model nor asks the service for more sessions.
(function (root) {
  const PAGE = 50;
  const KINDS = ['say', 'reply', 'dispatch', 'ready', 'wait', 'answered', 'done', 'queue', 'join', 'space'];
  const GROUPS = ['all', 'say', 'work', 'wait'];
  const validTime = time => Number.isFinite(time) && time > 0 && Math.abs(time) <= 8640000000000000;

  function tools(host) {
    const doc = host.document;
    const el = (tag, cls, text) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
    const button = (cls, act) => { const n = el('button', cls); n.type = 'button'; n.onclick = event => host.attempt(() => act(event)); return n; };
    const clock = time => validTime(time) ? new Date(time).toLocaleTimeString(host.language(), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : '';
    const day = time => validTime(time) ? new Date(time).toLocaleDateString(host.language(), { year: 'numeric', month: 'long', day: 'numeric' }) : host.text('stream.unknownDate');
    return { doc, el, button, clock, day };
  }

  function bindFeed(host) {
    const model = root.nativeWorkspaceTaskStream, disclosure = root.nativeWorkspaceDisclosure;
    const { doc, el, button, clock, day } = tools(host);
    const t = (key, params) => host.text('feed.' + key, params);
    const scopes = new Map(), cache = new Map();
    let roomId = '', group = 'all', people = new Set(), limit = PAGE, signature = '', inputKey = '', items = [], preferred = '', seeking = '', found = '', restoring = null;
    // U22, as in the sidebar: a name another listed participant also has carries its short id.
    let repeated = new Set();
    const named = (id, name) => repeated.has(id) ? `${name} ${host.shortId(id)}` : name;
    const panel = el('section', 'space-feed'); panel.id = 'space-feed'; panel.hidden = true;
    const bar = el('div', 'feed-tools');
    const scopeGroup = el('div', 'feed-seg'); scopeGroup.setAttribute('role', 'group');
    const scopeButtons = ['space', 'all'].map(value => { const b = button('', () => setScope(value)); b.dataset.scope = value; scopeGroup.append(b); return b; });
    const kindGroup = el('div', 'feed-kinds'); kindGroup.setAttribute('role', 'group');
    const kindButtons = GROUPS.map(value => { const b = button('', () => { group = value; restoring = null; reset(); draw(); }); b.dataset.group = value; kindGroup.append(b); return b; });
    const search = el('input', 'feed-search'); search.type = 'search';
    search.oninput = () => { restoring = null; reset(); draw(); };
    bar.append(scopeGroup, kindGroup, search);
    // R249 (11-25 19:09): 「某个或者某几个 agent 的消息」. Any number of names; none chosen is everyone.
    const names = el('div', 'feed-people'); names.setAttribute('role', 'group');
    const list = el('div', 'feed-list'); list.tabIndex = 0;
    const more = disclosure.pager({ document: doc, say: (n, key, params) => { n.textContent = host.text(key, params()); }, onMore: () => {
      const before = new Set(cache.keys());
      limit += PAGE; signature = ''; draw();
      [...cache].find(([id]) => !before.has(id))?.[1].summary.focus();
    } });
    panel.append(bar, names, list, more.status);
    host.mount(panel);

    const reset = () => { limit = PAGE; signature = ''; };
    const scope = () => scopes.get(roomId) || (host.room()?.stewardTeam === true ? 'all' : 'space');
    function setScope(value) { scopes.set(roomId, value); people = new Set(); restoring = null; reset(); inputKey = ''; draw(); }
    function scopedRooms() {
      const all = host.rooms().filter(r => r && !r.archived);
      return scope() === 'all' ? all : all.filter(r => r.id === roomId);
    }
    // Cheap key of what the feed reads, so a redraw while nothing changed costs nothing.
    function readKey(rooms) {
      const tail = rows => { const m = Array.isArray(rows) ? rows.at(-1) : null; return m ? [rows.length, m.id, m.status, m.text?.length] : [0]; };
      // A request's or a wake's delivery can settle long after newer lines.
      const delivery = rows => (Array.isArray(rows) ? rows : []).filter(m => m?.role === 'human' || m?.kind === 'agent-wake').map(m => [m.status, m.wakeStatus]);
      return JSON.stringify([host.language(), roomId, scope(), host.butlerId(), rooms.map(r => [r.id, host.roomName(r), tail(r.messages), delivery(r.messages), tail(r.events),
        (r.queue || []).map(i => [i.id, i.status, i.sentTo]), host.membersOf(r.id).map(s => [s.id, s.name, s.state, Boolean(s.messagesOmitted), tail(s.messages)])])]);
    }
    function collect(rooms) {
      // What this window already holds for each space's members (no new pushes); a member in two spaces says a line once.
      const seen = new Set();
      return rooms.flatMap(r => model.spaceFeed(r, { sessions: host.membersOf(r.id) }))
        .sort((a, b) => b.time - a.time).filter(item => !seen.has(item.id) && seen.add(item.id));
    }
    const speaker = item => item.fromKind === 'person' ? t('you') : item.fromKind === 'naw' ? host.text('notice.queue.senderName')
      : item.fromName ? named(item.fromId, item.fromName) + (item.unverified ? host.text('speech.unverified') : '') : '';
    const recordText = item => item.uiMessage ? host.displayText(item.text, item.uiMessage) ?? item.text
      : item.text ?? host.displayText(item.row?.text, item.row?.uiMessage) ?? '';
    const recordBody = item => item.uiMessage ? recordText(item) : item.body ?? recordText(item);
    const words = item => item.text === null ? recordText(item) + '\n' + host.label(item.row) : '';
    function choices() {
      const order = [], seen = new Set();
      const add = (id, name) => { if (id && !seen.has(id) && name) { seen.add(id); order.push({ id, name }); } };
      add('@person', t('you'));
      const butler = host.butlerId();
      if (butler && items.some(i => i.involved.includes(butler))) add(butler, host.text('butler.name'));
      for (const r of scopedRooms()) for (const s of host.membersOf(r.id)) add(s.id, s.name);
      for (const i of items) { if (i.fromKind === 'agent' && !i.unverified) add(i.fromId, i.fromName); for (const r of i.to) add(r.id, r.name); }
      return order;
    }
    function drawNames() {
      const options = choices();
      repeated = host.sameName(options.filter(o => !o.id.startsWith('@')));
      const key = options.map(o => o.id + '\t' + named(o.id, o.name)).join('\n');
      for (const id of [...people]) if (!options.some(o => o.id === id)) people.delete(id);
      if (names.dataset.keys !== key) {
        const focused = names.contains(doc.activeElement) ? doc.activeElement.dataset.person : null;
        names.replaceChildren(...options.map(o => {
          const b = button('feed-person', () => { if (people.has(o.id)) people.delete(o.id); else people.add(o.id); restoring = null; reset(); draw(); });
          b.dataset.person = o.id; b.textContent = named(o.id, o.name); return b;
        }));
        names.dataset.keys = key;
        if (focused !== null) names.querySelector(`[data-person="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
      }
      for (const b of names.children) b.setAttribute('aria-pressed', String(people.has(b.dataset.person)));
    }
    function entryFor(item) {
      let entry = cache.get(item.id);
      if (entry) return entry;
      const parts = disclosure.line(doc, 'article');
      parts.row.className += ' feed-row'; parts.row.dataset.feedId = item.id;
      const kind = el('span', 'feed-kind'), space = el('span', 'feed-space'), who = el('span', 'feed-who'), text = el('span', 'feed-text');
      parts.text.append(kind, space, who, text);
      const body = el('div', 'feed-body'), link = button('small feed-original', () => entry.item.target && host.original(entry.item.target));
      parts.body.append(body, link);
      const answer = button('feed-answer', () => host.answer(entry.item));
      parts.actions.append(answer);
      entry = { ...parts, kind, space, who, text, bodyText: body, link, answer, item };
      cache.set(item.id, entry);
      return entry;
    }
    function fill(entry, item, allScope) {
      entry.item = item;
      entry.row.dataset.kind = item.kind;
      entry.kind.textContent = t('kind.' + item.kind); entry.kind.className = 'feed-kind k-' + item.kind;
      const room = allScope && host.rooms().find(r => r.id === item.roomId);
      entry.space.hidden = !room; entry.space.textContent = room ? host.roomName(room) : '';
      const from = item.text === null && !item.fromName ? '' : speaker(item), to = item.to.filter(r => r.name).map(r => named(r.id, r.name)).join('、');
      entry.who.textContent = from && to ? `${from} → ${to}` : from || (to ? `→ ${to}` : '');
      entry.who.hidden = !entry.who.textContent;
      const line = recordText(item).replace(/\s+/gu, ' ').trim();
      if (entry.text.textContent !== line) entry.text.textContent = line;
      const body = recordBody(item);
      if (entry.bodyText.textContent !== body) entry.bodyText.textContent = body;
      // What happened to a request's delivery, as its space record said it.
      const status = item.request ? host.requestStatus(item.request) : '';
      if (entry.end.textContent !== status) entry.end.textContent = status;
      entry.end.hidden = !status;
      entry.time.textContent = clock(item.time);
      if (validTime(item.time)) entry.time.dateTime = new Date(item.time).toISOString(); else entry.time.removeAttribute('datetime');
      entry.link.textContent = host.text('stream.original'); entry.link.hidden = !item.target;
      // Only a wait that still waits can be answered; an answered one stays as a record.
      const open = item.kind === 'wait' && model.NEEDS_YOU.includes(item.taskStatus);
      entry.answer.hidden = !open; entry.answer.textContent = t('answer');
      entry.row.classList.toggle('feed-waiting', open);
    }
    function draw() {
      const room = host.room();
      if (!room || room.id !== roomId) return;
      const rooms = scopedRooms(), key = readKey(rooms);
      if (key !== inputKey) { inputKey = key; items = collect(rooms); signature = ''; }
      if (seeking) seek(rooms);
      drawNames();
      const all = scope() === 'all', query = search.value.trim();
      const shown = items.filter(item => model.feedMatches(item, { group, people: [...people], query, words }));
      const rows = shown.slice(0, limit);
      const next = JSON.stringify([key, group, [...people], query, limit]);
      for (const b of scopeButtons) { b.textContent = t('scope.' + b.dataset.scope); b.setAttribute('aria-pressed', String(b.dataset.scope === scope())); }
      for (const b of kindButtons) { b.textContent = t('group.' + b.dataset.group); b.setAttribute('aria-pressed', String(b.dataset.group === group)); }
      search.placeholder = t('search'); search.setAttribute('aria-label', t('search'));
      scopeGroup.setAttribute('aria-label', t('scope')); kindGroup.setAttribute('aria-label', t('kinds')); names.setAttribute('aria-label', t('people'));
      list.setAttribute('aria-label', t('list')); panel.setAttribute('aria-label', host.text('room.stream'));
      if (next === signature) return;
      signature = next;
      // Rows are kept and reconciled in place: new records must not close an opened line, move focus or the reading place.
      const nodes = [], kept = new Set(), scroll = list.scrollTop, top = list.getBoundingClientRect().top;
      const anchor = scroll > 0 && [...list.querySelectorAll('[data-feed-id]')].find(n => n.getBoundingClientRect().bottom > top);
      const offset = anchor ? anchor.getBoundingClientRect().top - top : 0;
      const focused = list.contains(doc.activeElement) ? doc.activeElement : null;
      let previous = '';
      for (const item of rows) {
        const date = day(item.time);
        if (date !== previous) { nodes.push(el('h3', 'feed-day', date)); previous = date; }
        const entry = entryFor(item); fill(entry, item, all); nodes.push(entry.row); kept.add(item.id);
      }
      if (!rows.length) nodes.push(el('p', 'quiet feed-empty', t('empty')));
      nodes.push(more.button); more.show({ count: Math.min(PAGE, shown.length - rows.length), total: shown.length, shown: rows.length });
      for (let i = 0; i < nodes.length; i++) if (list.children[i] !== nodes[i]) list.insertBefore(nodes[i], list.children[i] || null);
      while (list.children.length > nodes.length) list.lastChild.remove();
      list.scrollTop = scroll;
      if (anchor?.isConnected) list.scrollTop += anchor.getBoundingClientRect().top - top - offset;
      if (focused?.isConnected && doc.activeElement !== focused) focused.focus({ preventScroll: true });
      for (const id of cache.keys()) if (!kept.has(id)) cache.delete(id);
      const target = found && cache.get(found);
      if (target) {
        found = '';
        for (const n of list.querySelectorAll('[data-search-target]')) delete n.dataset.searchTarget;
        target.row.dataset.searchTarget = 'true'; target.row.scrollIntoView({ block: 'center' }); target.summary.focus({ preventScroll: true });
      }
    }
    // A record searched for or named elsewhere: the line that shows it, with every filter cleared and its page drawn.
    function seek(rooms) {
      const id = seeking, row = rooms.flatMap(r => [...(r.messages || []), ...(r.events || [])]).find(m => m?.id === id);
      const keys = new Set(['room:' + id, 'record:' + id, row?.sessionId && row.nativeMessageId ? `reply:${row.sessionId}:${row.nativeMessageId}` : '']);
      const at = items.findIndex(item => keys.has(item.id));
      seeking = '';
      if (at < 0) return;
      found = items[at].id; group = 'all'; people = new Set(); search.value = '';
      limit = Math.max(PAGE, Math.ceil((at + 1) / PAGE) * PAGE); signature = '';
    }
    function render() {
      const room = host.room(), visible = host.visible() && Boolean(room);
      panel.hidden = !visible;
      // Built only while shown: a hidden feed keeps its filters, not its lines.
      if (!visible) { if (inputKey) { items = []; inputKey = ''; signature = ''; cache.clear(); list.replaceChildren(); } return; }
      if (room.id !== roomId) { roomId = room.id; group = 'all'; people = new Set(); search.value = ''; limit = PAGE; signature = ''; inputKey = ''; cache.clear(); list.scrollTop = 0; }
      if (restoring?.roomId === room.id) { ({ group } = restoring); people = new Set(restoring.people); search.value = restoring.search; restoring = null; reset(); }
      if (preferred) { people = new Set([preferred]); group = 'all'; preferred = ''; reset(); }
      draw();
    }
    // A member's 「相关记录」: the stream opens on that member's lines.
    const showPerson = id => { preferred = id || ''; };
    // Whether a record is a line here: reveal(id) before the next render, then shown() after it.
    const reveal = id => { seeking = id || ''; found = ''; restoring = null; for (const n of list.querySelectorAll('[data-search-target]')) delete n.dataset.searchTarget; };
    // Open waits in the open space, for the tab's count.
    const waiting = room => room ? model.roomTasks(room).tasks.filter(task => model.NEEDS_YOU.includes(task.status)).length : 0;
    // 「返回」 after a search: the names, group and words this feed had before it.
    const filters = () => ({ roomId, group, people: [...people], search: search.value });
    const restore = saved => {
      const ok = saved && typeof saved.roomId === 'string' && GROUPS.includes(saved.group) && Array.isArray(saved.people) && typeof saved.search === 'string';
      restoring = ok ? { roomId: saved.roomId, group: saved.group, people: saved.people.filter(id => typeof id === 'string'), search: saved.search } : null;
    };
    return { render, waiting, showPerson, reveal, filters, restore, shown: () => Boolean(list.querySelector('[data-search-target]')), panel };
  }

  function bindSummary(host) {
    const model = root.nativeWorkspaceTaskStream;
    const { el, button, clock } = tools(host);
    const t = (key, params) => host.text('summary.' + key, params);
    const panel = el('section', 'space-summary'); panel.id = 'space-summary'; panel.hidden = true;
    const waits = el('section', 'summary-waits'), waitsTitle = el('h3'), waitRows = el('div');
    waits.append(waitsTitle, waitRows);
    const people = el('section', 'summary-members'), peopleTitle = el('h3'), table = el('table', 'summary-table');
    const head = el('thead'), headRow = el('tr'), body = el('tbody');
    const columns = ['member', 'state', 'item', 'last', 'time'].map(key => { const th = el('th'); th.scope = 'col'; th.dataset.column = key; headRow.append(th); return th; });
    head.append(headRow); table.append(head, body); people.append(peopleTitle, table);
    const queueLine = el('p', 'summary-queue');
    panel.append(waits, people, queueLine);
    host.mount(panel);
    let signature = '';
    const firstLine = text => String(text ?? '').trim().split(/\r?\n/u)[0].replace(/\*\*/gu, '').trim();
    function lastWords(s) {
      const last = model.lastReply(s);
      return last ? { text: firstLine(last.text), time: last.time } : { text: '', time: 0 };
    }
    function draw() {
      const room = host.room();
      if (!room) return;
      const members = host.members(), tasks = model.roomTasks(room, { nameOf: id => members.find(s => s.id === id)?.name || '' }).tasks;
      const open = tasks.filter(task => model.NEEDS_YOU.includes(task.status));
      const current = id => tasks.filter(task => task.status === 'active' && task.ownerId === id).at(-1);
      const queued = tasks.filter(task => task.status === 'queued');
      const rows = members.map(s => ({ s, facts: host.facts(s), item: current(s.id), last: lastWords(s), manager: host.role(s) }));
      const key = JSON.stringify([host.language(), room.id, open.map(task => [task.id, task.status, task.question, task.ownerName]),
        rows.map(r => [r.s.id, r.s.name, r.facts.state, r.facts.tone, r.item?.id, r.item?.title, r.last.text, r.last.time, r.manager]), queued.map(task => [task.id, task.title])]);
      if (key === signature) return;
      signature = key;
      waits.hidden = !open.length;
      waitsTitle.textContent = t('waiting', { count: open.length });
      waitRows.replaceChildren(...open.map(task => {
        const row = el('div', 'summary-wait'), who = el('strong', '', task.ownerName || host.text('speech.unknown'));
        const question = el('span', 'summary-question', task.question || task.title), time = el('time', 'quiet', clock(task.time));
        const go = button('summary-answer', () => host.openMember(task.ownerId)); go.textContent = host.text('feed.answer');
        go.disabled = !members.some(s => s.id === task.ownerId);
        row.append(who, question, time, go);
        return row;
      }));
      peopleTitle.textContent = t('members', { count: members.length });
      for (const th of columns) th.textContent = t('column.' + th.dataset.column);
      body.replaceChildren(...rows.map(({ s, facts, item, last, manager }) => {
        const tr = el('tr', 'summary-row'); tr.dataset.sessionId = s.id;
        const name = el('td', 'summary-who'), open = button('summary-open', () => host.openMember(s.id));
        open.append(host.icon(s), el('span', '', s.name));
        if (manager) open.append(el('span', 'summary-tag', manager));
        name.append(open);
        const state = el('td', 'summary-state tone-' + facts.tone, facts.state);
        const work = el('td', 'summary-item');
        if (item) work.append(el('span', 'summary-id', item.id.slice(0, 8)), el('span', '', item.title)); else work.append(el('span', 'quiet', '—'));
        const said = el('td', 'summary-last', last.text), when = el('td', 'summary-time quiet', clock(last.time));
        tr.append(name, state, work, said, when);
        return tr;
      }));
      queueLine.replaceChildren();
      queueLine.hidden = !queued.length;
      if (queued.length) {
        queueLine.append(el('span', '', t('queued', { count: queued.length })));
        for (const task of queued.slice(0, 3)) queueLine.append(el('span', 'summary-queued', task.title), el('span', 'summary-id', task.id.slice(0, 8)));
        const openQueue = button('small', () => host.openQueue()); openQueue.textContent = t('openQueue');
        queueLine.append(openQueue);
      }
      panel.setAttribute('aria-label', host.text('room.summary'));
    }
    function render() {
      const visible = host.visible() && Boolean(host.room());
      panel.hidden = !visible;
      if (visible) draw(); else signature = '';
    }
    return { render, panel };
  }

  root.nativeWorkspaceSpaceFeed = { bindFeed, bindSummary, PAGE, KINDS, GROUPS };
})(globalThis);
