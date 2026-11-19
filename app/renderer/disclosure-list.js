/* One list for everything that grows (progressive disclosure; the person, 2026-11-19: 「如果内容过多就都用渐进式展开的
   方式做」). One line per item that opens in place to all of it, and a button where the earlier items will appear,
   so every item stays within reach. */
(function (global) {
  'use strict';
  const PAGE = 15;

  // The button that brings the next earlier items, and the count read out after each press.
  function pager({ document, say, onMore }) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'disclosure-more';
    button.hidden = true;
    const status = document.createElement('p');
    status.className = 'disclosure-status';
    status.setAttribute('role', 'status');
    const counts = { count: 0, total: 0, shown: 0 };
    let busy = false;
    button.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      button.disabled = true;
      try {
        await onMore();
      } finally {
        busy = false;
        button.disabled = false;
      }
    });
    function show({ count, total, shown }) {
      Object.assign(counts, { count, total, shown });
      button.hidden = count <= 0;
      say(button, 'disclosure.older', () => ({ count: counts.count, total: counts.total }));
      say(status, 'disclosure.shown', () => ({ shown: counts.shown, total: counts.total }));
    }
    return { button, status, show };
  }

  // One line and the part it opens to. A list that redraws its own rows in place (the activity stream) uses it too.
  function line(document, tag = 'li') {
    const row = document.createElement(tag);
    row.className = 'disclosure-item';
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    const time = document.createElement('time');
    time.className = 'disclosure-time';
    const text = document.createElement('span');
    text.className = 'disclosure-title';
    const end = document.createElement('span');
    end.className = 'disclosure-end';
    const body = document.createElement('div');
    body.className = 'disclosure-body';
    const actions = document.createElement('span');
    actions.className = 'disclosure-actions';
    summary.append(time, text, end);
    details.append(summary, body);
    row.append(details, actions);
    return { row, details, summary, time, text, end, body, actions };
  }

  // items: in the order they are listed. `older` says where the earlier ones appear: 'below' for a newest-first
  // list, 'above' for one read from the top down. `fill(item, parts)` writes one item into its line and body.
  // `load(count)`, when the list holds only part of them, returns { items, total } with up to `count` items.
  function create({ document, say, pageSize = PAGE, older = 'below', key, fill, load = null }) {
    const box = document.createElement('section');
    box.className = 'disclosure';
    const list = document.createElement('ol');
    list.className = 'disclosure-list';
    let items = [], total = 0, shown = 0, rows = new Map();
    const opened = new Set();
    const more = pager({ document, say, onMore: () => earlier() });
    if (older === 'above') box.append(more.button, list, more.status);
    else box.append(list, more.button, more.status);

    function row(item, id) {
      const parts = line(document);
      parts.row.dataset.key = id;
      fill(item, parts);
      parts.details.open = opened.has(id);
      parts.details.addEventListener('toggle', () => {
        if (parts.details.open) opened.add(id);
        else opened.delete(id);
      });
      return parts.row;
    }
    // Keys stay the same for the same item from one draw to the next; a repeated key counts its repeats.
    function keyed(list) {
      const seen = new Map();
      return list.map(item => {
        const base = String(key(item));
        const n = seen.get(base) || 0;
        seen.set(base, n + 1);
        return [n ? `${base}#${n}` : base, item];
      });
    }
    function draw() {
      const visible = keyed(items.slice(0, shown));
      const next = new Map();
      const nodes = [];
      for (const [id, item] of visible) {
        const li = row(item, id);
        next.set(id, li);
        nodes.push(li);
      }
      rows = next;
      list.replaceChildren(...(older === 'above' ? nodes.reverse() : nodes));
      more.show({ count: Math.min(pageSize, total - shown), total, shown });
    }
    async function earlier() {
      const before = new Set(rows.keys());
      const want = shown + pageSize;
      if (load && items.length < Math.min(want, total)) {
        const next = await load(want);
        if (next && Array.isArray(next.items)) {
          items = next.items;
          total = Math.max(Number(next.total) || 0, items.length);
        }
      }
      shown = Math.min(want, items.length);
      draw();
      // Keyboard and screen reader go on from the first item that just appeared.
      const fresh = [...rows.entries()].filter(([id]) => !before.has(id)).map(([, li]) => li);
      const first = older === 'above' ? fresh.at(-1) : fresh[0];
      first?.querySelector('summary')?.focus();
    }
    // New items or a new total (the list read again): what was shown stays shown.
    function update(next, nextTotal = next.length) {
      items = next;
      total = Math.max(nextTotal, next.length);
      shown = Math.min(items.length, Math.max(shown, pageSize));
      draw();
    }
    return { box, list, update, earlier, get shown() { return shown; } };
  }

  const value = Object.freeze({ PAGE, create, pager, line });
  if (typeof module === 'object' && module.exports) module.exports = value;
  else global.nativeWorkspaceDisclosure = value;
})(globalThis);
