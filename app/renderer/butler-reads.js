/* "What it has read": the butler's read log, for the person. Read-only, and only through the existing person-only
   call butlerReview('reads', …). It shows what the log holds (when, which kind, which space, how many, which
   designation) and nothing else; a log that cannot be read is said to be unreadable, not empty. */
(function (global) {
  'use strict';
  const COLUMNS = ['time', 'what', 'space', 'count', 'revision'];
  function bind({ dialog, document, api, text, display, now = Date.now, spaceName, zone }) {
    const { readsView, tailRequest, olderRequest, PAGE, RECORDS_PER_PAGE, PAGES_PER_DAY } = global.nativeWorkspaceButlerReadsView || require('../butler-reads-view.js');
    const locale = global.nativeWorkspaceLocale || (typeof require === 'function' ? require('../ui-locale.js') : null);
    const format = text || ((key, params) => locale.format('zh', key, params));
    const say = (el, key, params) => { if (display) display.text(el, key, params); else el.textContent = format(key, params); return el; };
    const quiet = el => { if (display) display.unbind(el); el.textContent = ''; return el; };
    const make = (tag, cls, key, params) => { const el = document.createElement(tag); if (cls) el.className = cls; if (key) say(el, key, params); return el; };
    const control = (key, action, handler) => { const el = make('button', '', key); el.type = 'button'; el.dataset.action = action; el.addEventListener('click', handler); return el; };

    const title = make('h2', '', 'butler.reads.title'); title.id = (dialog.id || 'butler-reads-dialog') + '-title'; dialog.setAttribute('aria-labelledby', title.id);
    const today = make('p', 'butler-reads-today'), full = make('p', 'butler-reads-storage'), listed = make('p', 'quiet'), note = make('p', 'butler-reads-note'), help = make('p', 'butler-reads-note');
    const wrap = make('div', 'butler-reads-wrap'), list = make('div', 'butler-reads-list'), foot = make('p', 'butler-reads-note'), actions = make('div', 'dialog-actions');
    today.setAttribute('role', 'status'); full.setAttribute('role', 'status'); full.hidden = true; note.setAttribute('role', 'status'); foot.setAttribute('role', 'status'); wrap.append(list);
    // Rows below the fold are announced by a fade; the list's own scrollbar stays visible.
    const below = () => { wrap.dataset.more = String(list.scrollTop + list.clientHeight < list.scrollHeight - 1); };
    list.addEventListener('scroll', below);
    const older = control('butler.reads.older', 'older', () => loadOlder()), refresh = control('butler.reads.refresh', 'refresh', () => load()), done = control('common.done', 'done', () => dialog.close());
    older.className = 'subtle butler-apart';
    actions.append(older, refresh, done);
    // What a line does and does not show, under what a line is. It is on the page without a click, whatever was
    // read: these two limits are what the person needs to decide how far to rely on the log. The two paragraphs
    // share one box, which is the part that gives way when the window is too small for everything.
    const about = make('div', 'butler-reads-about');
    about.append(make('p', 'quiet', 'butler.reads.intro', { limit: RECORDS_PER_PAGE }), make('p', 'quiet butler-reads-limits', 'butler.reads.limits', { limit: PAGES_PER_DAY }));
    dialog.append(title, about, today, full, listed, note, help, wrap, foot, actions);

    let records = [], gaps = [], through = null, storage = null, state = 'idle', ticket = 0, olderFailed = false, readAt = 0;
    // One decimal, never rounded down: the file is not shown emptier than it is.
    const mib = bytes => { const tenths = Math.ceil(bytes / 104857.6); return tenths % 10 ? (tenths / 10).toFixed(1) : String(tenths / 10); };
    const valid = page => page && Array.isArray(page.records) && (page.gaps === undefined || Array.isArray(page.gaps)) && Number.isSafeInteger(page.throughSequence) && page.throughSequence >= 0 && typeof page.truncated === 'boolean' &&
      Number.isSafeInteger(page.nextAfterSequence) && page.nextAfterSequence >= 0;
    const ask = async request => { const page = await api.butlerReview('reads', request); if (!valid(page)) throw Error('unreadable'); return page; };
    // Whatever goes wrong while drawing what was read, the dialog does not stay on "reading". It says that the page
    // could not show what it read: the log was read, so this is not "the log cannot be read", and not an empty log.
    // Only that case is caught here. A failure while drawing "reading", "cannot be read" or this sentence itself is
    // thrown on: when the page is being opened the window shows its failure view; from Refresh or "earlier records"
    // nothing catches it.
    function draw() { try { paint(); } catch (error) { if (state !== 'ready') throw error; state = 'broken'; paint(); } }
    function paint() {
      const loading = state === 'loading';
      older.disabled = refresh.disabled = loading;
      if (state !== 'ready') {
        today.hidden = full.hidden = listed.hidden = foot.hidden = true; quiet(today); quiet(full); quiet(listed); quiet(foot); list.replaceChildren(); older.hidden = true; below();
        note.hidden = false; say(note, state === 'unavailable' ? 'butler.reads.unavailable' : state === 'broken' ? 'butler.reads.pageFailed.draw' : 'butler.reads.loading');
        // The rule is general; a log this window cannot read does not prove the butler's own writes fail.
        help.hidden = state !== 'unavailable'; if (state === 'unavailable') say(help, 'butler.reads.unavailableHelp'); else quiet(help);
        say(refresh, state === 'unavailable' || state === 'broken' ? 'butler.reads.retry' : 'butler.reads.refresh');
        dialog.dataset.readsState = state; return;
      }
      // The count line is true as of the moment the log was read; Refresh reads again.
      const view = readsView({ records, gaps, through, now: readAt, spaceNames: spaceName, storage, ...(zone ? { zone } : {}) });
      help.hidden = true; quiet(help);
      dialog.dataset.readsState = view.shown || view.gaps.length ? 'records' : 'empty'; dialog.dataset.readsLevel = view.today.level;
      say(refresh, 'butler.reads.refresh');
      // Today's count is the core's own running count, known only with the newest record on screen. When it cannot
      // be told, that is said with the reason: a missing line would read as "nothing to report".
      today.hidden = false;
      if (view.today.pages === null) say(today, view.today.inGap ? 'butler.reads.todayUnknownGap' : view.reached ? 'butler.reads.todayUnknownNewest' : 'butler.reads.todayUnknownReach', { from: view.today.from, limit: view.today.limit, resets: view.today.resets });
      else if (view.today.level === 'full') say(today, 'butler.reads.todayFull', { from: view.today.from, limit: view.today.limit, resets: view.today.resets });
      else if (!view.today.pages) say(today, 'butler.reads.todayNone', { from: view.today.from, limit: view.today.limit, resets: view.today.resets });
      else say(today, 'butler.reads.today', { from: view.today.from, pages: view.today.pages, left: view.today.left, limit: view.today.limit, resets: view.today.resets });
      // The log is kept whole: there is no cap, only the line the person set at which they are reminded. Past it this
      // is said beside the day's count, with that nothing is deleted and the butler is not stopped by it. A report that
      // is missing or does not add up is not "all is well": how large the log is cannot be told, and that is said.
      const warned = !view.storage || view.storage.over;
      full.hidden = !warned;
      if (!view.storage) say(full, 'butler.reads.storageUnknown');
      else if (warned) say(full, 'butler.reads.storageOver', { used: mib(view.storage.usedBytes), line: mib(view.storage.remindBytes) });
      else quiet(full);
      // How much of the log is listed, so a short list is not taken for the whole of it.
      listed.hidden = !view.shown && !view.gaps.length;
      if (listed.hidden) quiet(listed);
      // When the log's newest record was not even read, "the newest N" would not be true: say how many are shown and how
      // to get the rest. A newest record that was read but is not understood is not something Refresh can change.
      else if (!view.reached) say(listed, 'butler.reads.listedPart', { total: view.total, shown: view.shown });
      // With a block that cannot be read, "the newest N" would not be true of what is below: say what is shown and
      // how many are in such blocks, which are marked in their places.
      else if (view.gaps.length) say(listed, 'butler.reads.listedGap', { total: view.total, shown: view.shown, missing: view.gaps.reduce((sum, item) => sum + item.count, 0) });
      else if (view.unreadable) say(listed, 'butler.reads.listedSome', { total: view.total, shown: view.shown, count: view.unreadable });
      else say(listed, view.shown === view.total ? 'butler.reads.listedAll' : 'butler.reads.listed', { total: view.total, shown: view.shown });
      const notes = [];
      if (!view.shown && !view.unreadable && !view.gaps.length) notes.push(['butler.reads.empty']);
      if (view.unreadable && (!view.shown || !view.reached || view.gaps.length)) notes.push(['butler.reads.unreadable', { count: view.unreadable }]);
      note.hidden = !notes.length; if (notes.length) say(note, ...notes[notes.length - 1]); else quiet(note);
      // Said where the earlier rows would have appeared: under the list.
      foot.hidden = !olderFailed; if (olderFailed) say(foot, 'butler.reads.olderFailed'); else quiet(foot);
      if (!view.shown && !view.gaps.length) list.replaceChildren();
      else {
        const table = make('table', 'butler-reads-table'), head = make('thead'), headRow = make('tr');
        for (const column of COLUMNS) { const cell = make('th', '', `butler.reads.column.${column}`); cell.setAttribute('scope', 'col'); headRow.append(cell); }
        head.append(headRow); table.append(head);
        // A block that could not be read is one row in its place among the days, never left out.
        const holes = [...view.gaps], hole = item => {
          const body = make('tbody', 'butler-reads-gap'), row = make('tr', 'butler-reads-gap-row'), cell = make('td', '', 'butler.reads.gap', { from: item.from, through: item.through, count: item.count, days: item.first === item.last ? item.first : `${item.first} – ${item.last}` });
          cell.setAttribute('colspan', String(COLUMNS.length)); row.append(cell); body.append(row); table.append(body);
        };
        for (const group of view.days) {
          while (holes.length && holes[0].from > group.rows[0].sequence) hole(holes.shift());
          const body = make('tbody'), dayRow = make('tr', 'butler-reads-day'), dayCell = make('th', '', group.whole ? 'butler.reads.day' : 'butler.reads.dayAtLeast', { from: group.from, through: group.through, day: group.day, pages: group.pages });
          dayCell.setAttribute('colspan', String(COLUMNS.length)); dayCell.setAttribute('scope', 'rowgroup'); dayRow.append(dayCell); body.append(dayRow);
          for (const row of group.rows) {
            const line = make('tr');
            const what = row.kind === 'deliveries' ? make('td', '', 'butler.reads.kind.deliveries', { from: row.window.from, through: row.window.through })
              : make('td', '', `butler.reads.kind.${row.kind === 'spaces' && row.archived ? 'spacesArchived' : row.kind}`);
            // The log holds a space id only. A name is this window's own; an id it cannot name is shown as the id.
            const space = !row.space ? make('td', '', 'butler.reads.spaceNone') : row.space.name ? make('td') : make('td', '', 'butler.reads.spaceUnknown', { id: row.space.short });
            // The name is the window's own and may follow the interface language (the untouched default space does).
            const named = () => { try { const value = spaceName(row.space.id); return typeof value === 'string' && value ? value : row.space.name; } catch { return row.space.name; } };
            if (row.space && row.space.name) { if (display) display.computed(space, 'text', named); else space.textContent = row.space.name; } else if (row.space) space.setAttribute('title', row.space.id);
            line.append(make('td', 'butler-reads-time', 'butler.reads.time', { time: row.time }), what, space,
              make('td', '', row.more ? 'butler.reads.countMore' : 'butler.reads.count', { count: row.count }), make('td', '', 'butler.reads.revision', { revision: row.revision }));
            body.append(line);
          }
          table.append(body);
        }
        while (holes.length) hole(holes.shift());
        list.replaceChildren(table);
      }
      older.hidden = !view.hasOlder; below();
    }
    // The newest records first. The log pages forward only, so the tail is reached by position: one read to learn where
    // the log ends, and one for its tail. Each read makes the main process go through the whole file, so there are
    // never more than these two for one opening or refresh; pages written between them are not chased. They show as
    // "newer ones were not reached", and Refresh reads again.
    async function load() {
      const mine = ++ticket; state = 'loading'; olderFailed = false; draw();
      try {
        let page = await ask({ afterSequence: 0, limit: PAGE }), got = page.records, holes = page.gaps || [];
        if (page.truncated) { page = await ask(tailRequest(page.throughSequence)); got = page.records; holes = page.gaps || []; }
        if (mine !== ticket) return;
        // A log that says it has records and gives none was not read. A block that could not be read is said, not this.
        if (!got.length && !holes.length && page.throughSequence > 0) throw Error('unreadable');
        records = got; gaps = holes; through = page.throughSequence; storage = page.storage ?? null; readAt = now(); state = 'ready';
      } catch { if (mine !== ticket) return; state = 'unavailable'; }
      draw();
    }
    async function loadOlder() {
      if (state !== 'ready' || !records.length && !gaps.length) return;
      const request = olderRequest(Math.min(...records.map(record => record.sequence), ...gaps.map(item => item.fromSequence)));
      if (!request) return;
      const mine = ++ticket; older.disabled = true; olderFailed = false;
      // An earlier page that comes back empty was not read either.
      try {
        const page = await ask(request); if (mine !== ticket) return;
        if (!page.records.length && !(page.gaps || []).length) throw Error('unreadable');
        records = page.records.concat(records); gaps = (page.gaps || []).concat(gaps); if (page.storage) storage = page.storage;
      }
      catch { if (mine !== ticket) return; olderFailed = true; }
      draw();
    }
    function open() { if (!dialog.open) dialog.showModal(); done.focus(); return load(); }
    const closed = () => { ticket++; records = []; gaps = []; through = null; storage = null; state = 'idle'; olderFailed = false; list.replaceChildren(); };
    dialog.addEventListener('close', closed);
    return { open, load, loadOlder, dispose() { ticket++; dialog.removeEventListener('close', closed); if (dialog.open) dialog.close(); dialog.replaceChildren(); } };
  }
  const value = { bind, COLUMNS };
  if (typeof module === 'object' && module.exports) module.exports = value;
  else global.nativeWorkspaceButlerReads = value;
})(globalThis);
