'use strict';
// A window's page gets the messages only of the sessions it shows (UI lag, 2026-11-12). Every other
// session keeps its metadata, with no messages, `messagesOmitted: true` and the few facts the page reads
// from messages elsewhere (sidebar times, handoff chain, terminal start, newest reply excerpt). The page
// reports what it shows; until its first report a window gets every message, as before.

// What the page reads from a session's messages when it does not show them. Each field follows the page
// code it replaces, rule for rule: sessionActivityTime (latestAt), sessionChainModel (turnFirstAt,
// turnLastAt), the terminal checks (hasAssistant) and collaboration excerpt (lastAssistant).
// Not cached: some message lists grow in place.
function messageSummary(messages) {
  let latestAt = null, turnFirstAt = null, turnLastAt = null, hasAssistant = false, lastAssistant = null;
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'assistant') {
      hasAssistant = true;
      if (typeof m.id === 'string' && m.id && typeof m.text === 'string' && m.text.trim()) lastAssistant = m;
    }
    if (m.volatile || m.kind === 'gap' || !Number.isFinite(m.time)) continue;
    if (Number.isFinite(new Date(m.time).getTime())) latestAt = latestAt === null ? m.time : Math.max(latestAt, m.time);
    if (m.role === 'user' || m.role === 'assistant') {
      turnFirstAt = turnFirstAt === null ? m.time : Math.min(turnFirstAt, m.time);
      turnLastAt = turnLastAt === null ? m.time : Math.max(turnLastAt, m.time);
    }
  }
  return { latestAt, turnFirstAt, turnLastAt, hasAssistant, lastAssistant };
}

function omitted(session) {
  return { ...session, messages: [], messagesOmitted: true, messageSummary: messageSummary(session.messages) };
}

// shown: a Set of session ids, or null for every session.
function omitHidden(display, shown) {
  if (!shown || !display || !Array.isArray(display.sessions)) return display;
  return { ...display, sessions: display.sessions.map(s => shown.has(s.id) ? s : omitted(s)) };
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
  for (const s of display().sessions || []) if (wanted.has(s.id)) messages[s.id] = s.messages;
  return { shown, messages };
}

module.exports = { messageSummary, omitHidden, reportShown, validShown };
