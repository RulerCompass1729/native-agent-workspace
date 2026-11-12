// What the person sees of the butler's read log: one pure function over records the existing person-only call
// `butlerReview('reads', …)` returns. It reads metadata only, because the log holds nothing else: when, which kind
// of record, which space (by id), how many, and which designation asked.
(function (root, factory) { const api = factory(); if (typeof module === 'object' && module.exports) module.exports = api; else root.nativeWorkspaceButlerReadsView = api; })(typeof self !== 'undefined' ? self : globalThis, function () {
  // The core's allowance of pages per UTC day and the most records one page can hold (app/butler-read-audit.cjs).
  const PAGES_PER_DAY = 64, RECORDS_PER_PAGE = 50;
  // From this many pages left the count is marked; the number itself is always shown.
  const NEAR_LEFT = 8;
  const KINDS = Object.freeze(['spaces', 'queue', 'deliveries']);
  const DAY_MS = 24 * 60 * 60 * 1000;
  const count = value => Number.isSafeInteger(value) && value >= 0;
  const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
  // A moment as ISO text, or null for one that has no four-digit year: the log accepts times far beyond any real
  // date, and such a moment is neither thrown on nor shown as something else.
  const iso = time => { try { const value = new Date(time).toISOString(); return /^\d{4}-/.test(value) ? value : null; } catch { return null; } };
  const utcDay = time => { const value = iso(time); return value ? value.slice(0, 10) : null; };
  // The window's own zone, as minutes east of UTC at that moment.
  const ownZone = time => -new Date(time).getTimezoneOffset();
  // One record as one row, or null when it is not a record this version understands: such a record is counted
  // as unreadable, never guessed at.
  function row(record, spaceNames, local) {
    const query = record && record.query, result = record && record.result, actor = record && record.actor;
    if (!record || record.version !== 1 || !count(record.sequence) || record.sequence < 1 || !count(record.time) || !day(record.day) || record.day !== utcDay(record.time) ||
        !count(record.pageOfDay) || record.pageOfDay < 1 || record.pageOfDay > PAGES_PER_DAY || !query || !KINDS.includes(query.kind) || !result || !count(result.count) ||
        typeof result.truncated !== 'boolean' || !actor || !count(actor.selectionRevision)) return null;
    const spaceId = query.kind === 'spaces' ? null : typeof query.spaceId === 'string' && query.spaceId ? query.spaceId : undefined;
    if (spaceId === undefined) return null;
    let name = null; if (spaceId !== null && typeof spaceNames === 'function') { try { name = spaceNames(spaceId); } catch { /* No name: the id is shown. */ } }
    // The core always records the time window a delivery lookup asked for; one without it is not a record this version knows.
    if (query.kind === 'deliveries' && !(count(query.fromTime) && count(query.throughTime) && query.throughTime >= query.fromTime)) return null;
    const window = query.kind === 'deliveries' ? { from: local(query.fromTime), through: local(query.throughTime) } : null, time = local(record.time);
    // A time that cannot be written as a local date is not guessed at.
    if (!time || window && (!window.from || !window.through)) return null;
    return { sequence: record.sequence, day: record.day, time, pageOfDay: record.pageOfDay, kind: query.kind, archived: query.kind === 'spaces' && query.includeArchived === true,
      space: spaceId === null ? null : { id: spaceId, short: spaceId.length > 12 ? spaceId.slice(0, 8) + '…' : spaceId, name: typeof name === 'string' && name ? name : null },
      window, count: result.count, more: result.truncated, revision: actor.selectionRevision };
  }
  // How large the log is, as the core reports it with a read (the log is kept whole, in blocks; the person set a line
  // at which they are reminded, not a cap), or null when the answer carries no such report or one that does not add
  // up: the dialog then says that it cannot tell.
  function storageView(value) {
    if (!value || !count(value.usedBytes) || !count(value.remindBytes) || value.remindBytes === 0 || !count(value.blocks) || !count(value.unreadableBlocks) ||
        value.unreadableBlocks > value.blocks || value.warning !== value.usedBytes > value.remindBytes) return null;
    return { usedBytes: value.usedBytes, remindBytes: value.remindBytes, over: value.warning, blocks: value.blocks, unreadable: value.unreadableBlocks };
  }
  // A block of the log that could not be read, as the core describes it, or null for one this version does not know.
  function gap(value, through) {
    if (!value || !count(value.fromSequence) || value.fromSequence < 1 || !count(value.throughSequence) || value.throughSequence < value.fromSequence ||
        count(through) && value.throughSequence > through || value.count !== value.throughSequence - value.fromSequence + 1 ||
        !Array.isArray(value.days) || !value.days.length || !value.days.every(day)) return null;
    const days = [...value.days].sort();
    return { gap: true, from: value.fromSequence, through: value.throughSequence, count: value.count, first: days[0], last: days[days.length - 1] };
  }
  // records: every record loaded so far, in any order; the newest one must be among them for today's count.
  // through: the log's highest sequence (throughSequence). now: the window's clock. spaceNames: id -> name the
  // window itself knows, or nothing. zone: minutes east of UTC at a given moment (the window's own by default).
  // Every time shown is local, as "MM-DD HH:MM"; the allowance is counted per UTC day, so each day says its local span.
  // gaps: the blocks of those positions that could not be read; each is listed in its place, never left out.
  function readsView({ records, gaps = [], through, now, spaceNames, zone = ownZone, storage }) {
    const local = time => { let offset; try { offset = zone(time); } catch { return null; } const value = Number.isFinite(offset) ? iso(time + offset * 60000) : null; return value ? value.slice(5, 16).replace('T', ' ') : null; };
    const today = utcDay(now), rows = [], seen = new Set(); let unreadable = 0, reached = count(through) && through === 0;
    for (const record of Array.isArray(records) ? records : []) {
      // Reached is not understood: the log's newest record may be on hand and still be one this version cannot show.
      if (record && count(through) && record.sequence === through) reached = true;
      const value = row(record, spaceNames, local);
      if (!value || seen.has(value.sequence)) { if (!value) unreadable++; continue; }
      seen.add(value.sequence); rows.push(value);
    }
    rows.sort((a, b) => b.sequence - a.sequence);
    const holes = [], covered = new Set();
    for (const value of Array.isArray(gaps) ? gaps : []) { const item = gap(value, through); if (item && !covered.has(item.from)) { covered.add(item.from); holes.push(item); } else if (!item) unreadable++; }
    holes.sort((a, b) => b.from - a.from);
    // Holes that touch (one block asked for over two pages, or two damaged blocks side by side) are one row.
    for (let index = holes.length - 1; index > 0; index--) {
      const newer = holes[index - 1], older = holes[index];
      if (older.through + 1 !== newer.from) continue;
      holes.splice(index - 1, 2, { gap: true, from: older.from, through: newer.through, count: older.count + newer.count, first: older.first < newer.first ? older.first : newer.first, last: older.last > newer.last ? older.last : newer.last });
    }
    // The newest position may be in a block that cannot be read: it was reached, and today's count cannot be told.
    const newestHole = holes.find(item => count(through) && item.through === through);
    if (newestHole) reached = true;
    const span = value => { const start = Date.parse(value + 'T00:00:00Z'); return { from: local(start), through: local(start + DAY_MS) }; };
    const days = [];
    for (const value of rows) {
      const last = days[days.length - 1];
      // A block that cannot be read between two lines of the same day splits the day, so that it is shown in its place.
      const between = last && holes.some(item => item.from > value.sequence && item.through < last.rows[last.rows.length - 1].sequence);
      if (last && last.day === value.day && !between) { last.rows.push(value); last.pages = Math.max(last.pages, value.pageOfDay); }
      else days.push({ day: value.day, ...span(value.day), pages: value.pageOfDay, rows: [value] });
    }
    const newest = rows[0], oldest = rows[rows.length - 1];
    // Today's pages are only known when the newest record of the log is on screen; pageOfDay is the day's running count.
    const complete = count(through) && (through === 0 || Boolean(newest) && newest.sequence === through);
    const pages = !complete ? null : newest && newest.day === today ? newest.pageOfDay : 0;
    const oldestPosition = Math.min(...(oldest ? [oldest.sequence] : []), ...holes.map(item => item.from));
    // A day's page count is its last record's running count, so it is the day's whole count only when that last
    // record is on screen: for the newest day when the log's newest record is, for an earlier day when its newest
    // row is the record just before the next day's oldest row. Otherwise the number is a lower bound. A day that
    // shows up again further on (the clock went back across UTC midnight) is counted on, so its earlier group is not whole.
    days.forEach((group, index) => { const later = days[index - 1];
      group.whole = index === 0 ? complete : group.rows[0].sequence + 1 === later.rows[later.rows.length - 1].sequence && !days.slice(0, index).some(other => other.day === group.day); });
    // A day whose lines may go on into a block that cannot be read is not whole either.
    for (const group of days) if (holes.some(item => item.first <= group.day && group.day <= item.last)) group.whole = false;
    const left = pages === null ? null : PAGES_PER_DAY - pages;
    return { today: { day: today, pages, left, limit: PAGES_PER_DAY, level: pages === null ? 'unknown' : left === 0 ? 'full' : left <= NEAR_LEFT ? 'near' : 'ok', inGap: Boolean(newestHole),
        // The counting day is a UTC day, which is not the person's own day: the line names its local start and end.
        from: span(today).from, resets: span(today).through },
      // newest: the log's newest record is on screen, so "the newest N" can be said. reached: it was at least read,
      // so "newer ones were not reached" would be false.
      days, gaps: holes, total: count(through) ? through : null, shown: rows.length, newest: complete, reached, unreadable, storage: storageView(storage), hasOlder: Number.isFinite(oldestPosition) && oldestPosition > 1 };
  }
  // Which page to ask for next. The log only pages forward, so the newest records are reached by position.
  const PAGE = 50;
  function tailRequest(through) { return { afterSequence: Math.max(0, through - PAGE), limit: PAGE }; }
  function olderRequest(oldestSequence) { const end = oldestSequence - 1, start = Math.max(0, end - PAGE); return end < 1 ? null : { afterSequence: start, limit: end - start }; }
  return Object.freeze({ readsView, tailRequest, olderRequest, PAGES_PER_DAY, RECORDS_PER_PAGE, NEAR_LEFT, PAGE, KINDS });
});
