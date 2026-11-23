// The space's 「对话」 view: one stream of what the person, the butler and the members said to each other,
// with no NAW records. Reads existing state only (task-stream.js speechStream); never calls a model.
(function (root) {
  const PAGE = 50, FOLD_CHARS = 600, FOLD_LINES = 10, BOTTOM_SLACK = 32;
  const folds = text => text.length > FOLD_CHARS || text.split('\n').length > FOLD_LINES;
  function bind(host) {
    const doc = host.document, model = root.nativeWorkspaceTaskStream;
    const el = (tag, cls, text) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
    const t = (key, params) => host.text('speech.' + key, params);
    const button = (cls, act) => { const n = el('button', cls); n.type = 'button'; n.onclick = () => host.attempt(act); return n; };
    let roomId = '', chosen = '', limit = PAGE, signature = '', atBottom = true, unseen = 0, lastIds = [], drawnFor = '';
    const chosenByRoom = new Map(), cache = new Map();
    const panel = el('section', 'speech-stream'); panel.id = 'speech-stream'; panel.hidden = true;
    const names = el('div', 'speech-names'); names.setAttribute('role', 'toolbar');
    const list = el('div', 'speech-list'); list.tabIndex = 0;
    const earlier = button('disclosure-more speech-earlier', () => {
      const height = list.scrollHeight, top = list.scrollTop;
      limit += PAGE; signature = ''; draw();
      list.scrollTop = top + list.scrollHeight - height;
      status.textContent = host.text('disclosure.shown', { shown: Math.min(limit, lastIds.length), total: lastIds.length });
      list.querySelector('.speech-msg')?.focus({ preventScroll: true });
    });
    // Read out only after a press, never as messages arrive.
    const status = el('p', 'disclosure-status visually-hidden'); status.setAttribute('role', 'status');
    const fresh = button('speech-new', () => { list.scrollTop = list.scrollHeight; settle(); });
    fresh.hidden = true;
    panel.append(names, list, fresh, status);
    host.mount(panel);
    list.addEventListener('scroll', settle, { passive: true });
    function settle() {
      atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < BOTTOM_SLACK;
      if (atBottom && unseen) { unseen = 0; drawFresh(); }
    }
    function drawFresh() { fresh.hidden = !unseen; fresh.textContent = t('newMessages', { count: unseen }); }

    const validTime = time => Number.isFinite(time) && time > 0 && Math.abs(time) <= 8640000000000000;
    const clock = time => validTime(time) ? new Date(time).toLocaleTimeString(host.language(), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : '';
    const day = time => validTime(time) ? new Date(time).toLocaleDateString(host.language(), { year: 'numeric', month: 'long', day: 'numeric' }) : host.text('stream.unknownDate');
    const speaker = item => item.fromKind === 'person' ? t('you') : item.fromKind === 'dispatch' ? host.text('notice.queue.senderName')
      : (item.fromName || t('unknown')) + (item.unverified ? t('unverified') : '');

    // 「全部」, then the butler, then the members in their space order, then anyone else who spoke here.
    function people(items, members) {
      const butler = host.butlerId(), order = [], seen = new Set();
      const add = (id, name) => { if (id && !seen.has(id)) { seen.add(id); order.push({ id, name }); } };
      const involved = new Set(items.flatMap(i => [i.fromId, ...i.to.map(r => r.id)]));
      if (butler && (involved.has(butler) || members.some(s => s.id === butler))) add(butler, host.text('butler.name'));
      for (const s of members) add(s.id, s.name);
      for (const i of items) { if (i.fromKind === 'agent' && !i.unverified) add(i.fromId, i.fromName); for (const r of i.to) add(r.id, r.name); }
      return order;
    }
    function drawNames(order) {
      const options = [{ id: '', name: t('all') }, ...order];
      const keys = options.map(o => o.id).join('\n') + '\n' + options.map(o => o.name).join('\n');
      if (names.dataset.keys !== keys) {
        const focused = names.contains(doc.activeElement) ? doc.activeElement.dataset.member : null;
        names.replaceChildren(...options.map(o => {
          const b = button('speech-name', () => choose(o.id)); b.dataset.member = o.id; b.textContent = o.name; return b;
        }));
        names.dataset.keys = keys;
        if (focused !== null) names.querySelector(`[data-member="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
      }
      for (const b of names.children) {
        const on = b.dataset.member === chosen;
        b.setAttribute('aria-pressed', String(on)); b.tabIndex = on ? 0 : -1;
      }
    }
    names.addEventListener('keydown', event => {
      const all = [...names.children], index = all.indexOf(doc.activeElement);
      if (index < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? all.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + all.length) % all.length;
      all.forEach((b, i) => { b.tabIndex = i === next ? 0 : -1; });
      all[next].focus({ preventScroll: true }); all[next].scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    function choose(id) {
      chosen = id; chosenByRoom.set(roomId, id); limit = PAGE; signature = ''; unseen = 0; atBottom = true; drawnFor = '';
      draw();
    }

    function entryFor(item) {
      let entry = cache.get(item.id);
      if (entry) return entry;
      const article = el('article', 'speech-msg'); article.tabIndex = -1; article.dataset.speechId = item.id;
      const head = el('div', 'speech-head'), from = el('strong', 'speech-from'), arrow = el('span', 'speech-arrow', '→'), to = el('span', 'speech-to'), time = el('time', 'speech-time');
      arrow.setAttribute('aria-hidden', 'true');
      const toLabel = el('span', 'visually-hidden');
      const original = button('small speech-original', () => entry.item.target && host.original(entry.item.target));
      head.append(from, arrow, toLabel, to, time, original);
      const body = el('div', 'speech-body'), toggle = button('small speech-toggle', () => {
        const open = toggle.getAttribute('aria-expanded') !== 'true';
        toggle.setAttribute('aria-expanded', String(open)); body.classList.toggle('folded', !open); toggle.textContent = t(open ? 'collapse' : 'expand');
      });
      article.append(head, body, toggle);
      const id = 'speech-' + cache.size + '-' + Math.random().toString(36).slice(2, 8);
      from.id = id + '-from'; toLabel.id = id + '-tolabel'; to.id = id + '-to'; time.id = id + '-time';
      entry = { article, from, arrow, toLabel, to, time, original, body, toggle, item };
      cache.set(item.id, entry);
      return entry;
    }
    function fill(entry, item) {
      entry.item = item;
      const who = speaker(item), recipients = item.to.map(r => r.name || t('unknown')).join('、');
      if (entry.from.textContent !== who) entry.from.textContent = who;
      if (entry.to.textContent !== recipients) entry.to.textContent = recipients;
      entry.arrow.hidden = entry.to.hidden = entry.toLabel.hidden = !recipients;
      entry.toLabel.textContent = t('to');
      entry.article.setAttribute('aria-labelledby', [entry.from.id, ...(recipients ? [entry.toLabel.id, entry.to.id] : []), entry.time.id].join(' '));
      entry.article.classList.toggle('speech-person', item.fromKind === 'person');
      entry.time.textContent = clock(item.time);
      if (validTime(item.time)) entry.time.dateTime = new Date(item.time).toISOString(); else entry.time.removeAttribute('datetime');
      entry.original.textContent = host.text('stream.original'); entry.original.hidden = !item.target;
      if (entry.body.textContent !== item.text) entry.body.textContent = item.text;
      const long = folds(item.text), open = entry.toggle.getAttribute('aria-expanded') === 'true';
      entry.toggle.hidden = !long; entry.body.classList.toggle('folded', long && !open);
      entry.toggle.textContent = t(long && open ? 'collapse' : 'expand');
      if (!entry.toggle.hasAttribute('aria-expanded')) entry.toggle.setAttribute('aria-expanded', 'false');
    }

    // Cheap key of what the stream reads, so a redraw every second costs nothing while nothing was said.
    function inputKey(room, members) {
      const tail = list => { const m = list?.at?.(-1); return m ? [list.length, m.id, m.status, m.text?.length] : [0]; };
      return JSON.stringify([host.language(), roomId, chosen, limit, host.butlerId(), tail(room.messages),
        members.map(s => [s.id, s.name, s.state, s.nativeId, Boolean(s.messagesOmitted), tail(s.messages)])]);
    }
    function draw() {
      const room = host.room();
      if (!room || room.id !== roomId) return;
      const members = host.members();
      const key = inputKey(room, members);
      if (key === signature) return;
      signature = key;
      const items = model.speechStream(room, { sessions: members });
      drawNames(people(items, members));
      names.setAttribute('aria-label', t('names'));
      list.setAttribute('aria-label', t('list'));
      panel.setAttribute('aria-label', host.text('room.conversation'));
      const shown = chosen ? items.filter(i => model.speechInvolves(i, chosen)) : items;
      const first = drawnFor !== roomId + '\n' + chosen, follow = first || atBottom;
      const before = new Set(lastIds);
      const added = first ? 0 : shown.filter(i => !before.has(i.id)).length;
      // Scrolled up, new messages widen the page instead of pushing what is being read out above.
      if (!follow && added) { limit += added; signature = inputKey(room, members); }
      const rows = shown.slice(-limit);
      const nodes = [earlier];
      let previousDay = '';
      for (const item of rows) {
        const date = day(item.time);
        if (date !== previousDay) { nodes.push(el('h3', 'speech-day', date)); previousDay = date; }
        const entry = entryFor(item); fill(entry, item); nodes.push(entry.article);
      }
      if (!rows.length) {
        const name = chosen && (people(items, members).find(p => p.id === chosen)?.name || t('unknown'));
        nodes.push(el('p', 'quiet speech-empty', chosen ? t('emptyMember', { name }) : t('empty')));
      }
      earlier.hidden = shown.length <= rows.length;
      earlier.textContent = host.text('disclosure.older', { count: Math.min(PAGE, shown.length - rows.length), total: shown.length });
      // Day headings are rebuilt; message nodes are kept, so an expanded message, focus and reading place survive.
      // The first message in view keeps its place on screen whatever changes above it.
      const scroll = list.scrollTop, listTop = list.getBoundingClientRect().top;
      const anchor = follow ? null : [...list.querySelectorAll('.speech-msg')].find(n => n.getBoundingClientRect().bottom > listTop);
      const anchorAt = anchor ? anchor.getBoundingClientRect().top : 0;
      const focused = list.contains(doc.activeElement) ? doc.activeElement : null;
      for (let i = 0; i < nodes.length; i++) if (list.children[i] !== nodes[i]) list.insertBefore(nodes[i], list.children[i] || null);
      while (list.children.length > nodes.length) list.lastChild.remove();
      const kept = new Set(rows.map(i => i.id));
      for (const id of cache.keys()) if (!kept.has(id)) cache.delete(id);
      lastIds = shown.map(i => i.id);
      drawnFor = roomId + '\n' + chosen;
      if (follow) { list.scrollTop = list.scrollHeight; atBottom = true; unseen = 0; }
      else {
        if (anchor?.isConnected) list.scrollTop += anchor.getBoundingClientRect().top - anchorAt; else list.scrollTop = scroll;
        unseen += added;
      }
      if (focused?.isConnected && doc.activeElement !== focused) focused.focus({ preventScroll: true });
      drawFresh();
    }
    function render() {
      const room = host.room(), visible = host.visible() && Boolean(room);
      panel.hidden = !visible;
      if (!visible) return;
      if (room.id !== roomId) { roomId = room.id; chosen = chosenByRoom.get(roomId) || ''; limit = PAGE; signature = ''; unseen = 0; atBottom = true; drawnFor = ''; cache.clear(); }
      fresh.textContent = t('newMessages', { count: unseen });
      draw();
    }
    // Opens the stream on one member (the sidebar's space members use this; '' is everyone).
    function open(id, memberId = '') {
      roomId = id; chosen = memberId; chosenByRoom.set(id, memberId); limit = PAGE; signature = ''; unseen = 0; atBottom = true; drawnFor = ''; cache.clear();
      render();
    }
    return { render, open, chosen: () => chosen };
  }
  root.nativeWorkspaceSpeechStream = { bind, folds, PAGE };
})(globalThis);
