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
  // records: every record loaded so far, in any order; the newest one must be among them for today's count.
  // through: the log's highest sequence (throughSequence). now: the window's clock. spaceNames: id -> name the
  // window itself knows, or nothing. zone: minutes east of UTC at a given moment (the window's own by default).
  // Every time shown is local, as "MM-DD HH:MM"; the allowance is counted per UTC day, so each day says its local span.
  function readsView({ records, through, now, spaceNames, zone = ownZone }) {
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
    const span = value => { const start = Date.parse(value + 'T00:00:00Z'); return { from: local(start), through: local(start + DAY_MS) }; };
    const days = [];
    for (const value of rows) {
      const last = days[days.length - 1];
      if (last && last.day === value.day) { last.rows.push(value); last.pages = Math.max(last.pages, value.pageOfDay); }
      else days.push({ day: value.day, ...span(value.day), pages: value.pageOfDay, rows: [value] });
    }
    const newest = rows[0], oldest = rows[rows.length - 1];
    // Today's pages are only known when the newest record of the log is on screen; pageOfDay is the day's running count.
    const complete = count(through) && (through === 0 || Boolean(newest) && newest.sequence === through);
    const pages = !complete ? null : newest && newest.day === today ? newest.pageOfDay : 0;
    const left = pages === null ? null : PAGES_PER_DAY - pages;
    return { today: { day: today, pages, left, limit: PAGES_PER_DAY, level: pages === null ? 'unknown' : left === 0 ? 'full' : left <= NEAR_LEFT ? 'near' : 'ok',
        // The counting day is a UTC day, which is not the person's own day: the line names its local start and end.
        from: span(today).from, resets: span(today).through },
      // newest: the log's newest record is on screen, so "the newest N" can be said. reached: it was at least read,
      // so "newer ones were not reached" would be false.
      days, total: count(through) ? through : null, shown: rows.length, newest: complete, reached, unreadable, hasOlder: Boolean(oldest) && oldest.sequence > 1 };
  }
  // Which page to ask for next. The log only pages forward, so the newest records are reached by position.
  const PAGE = 50;
  function tailRequest(through) { return { afterSequence: Math.max(0, through - PAGE), limit: PAGE }; }
  function olderRequest(oldestSequence) { const end = oldestSequence - 1, start = Math.max(0, end - PAGE); return end < 1 ? null : { afterSequence: start, limit: end - start }; }
  return Object.freeze({ readsView, tailRequest, olderRequest, PAGES_PER_DAY, RECORDS_PER_PAGE, NEAR_LEFT, PAGE, KINDS });
});
