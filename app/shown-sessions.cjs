'use strict';
// A window's page gets the messages only of the sessions it shows (UI lag, 2026-11-12). Every other
// session keeps its metadata, with no messages, `messagesOmitted: true` and the few facts the page reads
// from messages elsewhere (sidebar times, handoff chain, terminal start, newest reply excerpt). The page
// reports what it shows; until its first report a window gets every message, as before.

// The times a Date can hold. Not asked of a Date: one per message of every session was most of a push's garbage.
const MAX_DATE = 8.64e15;
// What the page reads from a session's messages when it does not show them. Each field follows the page
// code it replaces, rule for rule: sessionActivityTime (latestAt), sessionChainModel (turnFirstAt,
// turnLastAt), the terminal checks (hasAssistant) and collaboration excerpt (lastAssistant).
// Not cached: some message lists grow in place.
function messageSummary(messages) {
  let latestAt = -Infinity, turnFirstAt = Infinity, turnLastAt = -Infinity, hasAssistant = false, lastAssistant = null;
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'assistant') {
      hasAssistant = true;
      if (typeof m.id === 'string' && m.id && typeof m.text === 'string' && m.text.trim()) lastAssistant = m;
    }
    const { time } = m;
    if (m.volatile || m.kind === 'gap' || !Number.isFinite(time)) continue;
    if (Math.abs(time) <= MAX_DATE) latestAt = Math.max(latestAt, time);
    if (m.role === 'user' || m.role === 'assistant') {
      turnFirstAt = Math.min(turnFirstAt, time);
      turnLastAt = Math.max(turnLastAt, time);
    }
  }
  const known = time => Number.isFinite(time) ? time : null;
  return { latestAt: known(latestAt), turnFirstAt: known(turnFirstAt), turnLastAt: known(turnLastAt), hasAssistant, lastAssistant };
}

// A session's operation rows, not made until it is known what the page gets: messages() makes its messages with them,
// times() only their times, if any. A summary needs no more, but needs them in place: sorting moves messages around them.
const RECORDS = Symbol('records');
function leaveRecords(session, records) { session[RECORDS] = records; }
function bare(session) { const { [RECORDS]: _, ...rest } = session; return rest; }
function whole(session) { return session?.[RECORDS] ? { ...bare(session), messages: session[RECORDS].messages() } : session; }

function omitted(session) {
  const times = session[RECORDS]?.times();
  return { ...bare(session), messages: [], messagesOmitted: true,
    messageSummary: messageSummary(times ? [...session.messages, ...times].sort((a, b) => a.time - b.time) : session.messages) };
}

// shown: a Set of session ids, or null for every session.
function omitHidden(display, shown) {
  if (!display || !Array.isArray(display.sessions)) return display;
  if (!shown) return display.sessions.some(s => s?.[RECORDS]) ? { ...display, sessions: display.sessions.map(whole) } : display;
  return { ...display, sessions: display.sessions.map(s => shown.has(s.id) ? whole(s) : omitted(s)) };
}

const MAX_SHOWN = 1000;
function validShown(ids) {
  return Array.isArray(ids) && ids.length <= MAX_SHOWN && ids.every(id => typeof id === 'string' && id.length > 0 && id.length <= 100);
}

// The page's new report. It returns the messages of the sessions the page did not get until now, read
// from `display()` only when there are some: the page needs them before it shows such a session.
function reportShown(previous, ids, display) {
  const shown = new Set(ids);
  if (!previous) return { shown, messages: {} };
  const added = ids.filter(id => !previous.has(id));
  if (!added.length) return { shown, messages: {} };
  const wanted = new Set(added), messages = {};
  for (const s of display().sessions || []) if (wanted.has(s.id)) messages[s.id] = whole(s).messages;
  return { shown, messages };
}

module.exports = { messageSummary, leaveRecords, omitHidden, reportShown, validShown };
