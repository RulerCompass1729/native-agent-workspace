'use strict';
// Read the live cooked viewport, never scrollback or the GUI's scroll position.
// This observes a choice; it neither answers it nor changes native agent state.
const observed = new WeakMap(), frames = new WeakMap(), regions = new WeakMap();
const plainEdge = line => line.replace(/^[\s│┃╭╰─┌└]+|[\s│┃╮╯─┐┘]+$/g, '');
const keyLegend = text => /\b(?:enter|return)\b.*\b(?:confirm|select|continue|submit|set|accept|proceed|choose)\b/i.test(text) &&
  /\besc(?:ape)?\b.*\b(?:cancel|back|exit|dismiss)[ .·│]*$/i.test(text);
function dismiss(runtime) {
  observed.delete(runtime);
  const previous = regions.get(runtime);
  if (previous) regions.set(runtime, { key: null, since: previous.since });
  return null;
}
function readTerminalDialogPrompt(session, runtime) {
  if (!['claude', 'codex'].includes(session?.provider) || !runtime?.terminal?.alive ||
      ['ended', 'recoverable', 'disconnected', 'background'].includes(session.state)) return null;
  try {
    const screen = runtime.terminal.screen, buffer = screen?.buffer?.active;
    if (!buffer || !Number.isSafeInteger(screen.rows) || screen.rows < 1 || screen.rows > 200 ||
        !Number.isSafeInteger(screen.cols) || screen.cols < 1 || screen.cols > 400) return null;
    const lines = [];
    for (let i = buffer.baseY; i < buffer.baseY + screen.rows; i++) {
      const line = buffer.getLine(i);
      if (!line) continue;
      const text = line.translateToString(false).replace(/\0/g, ' ');
      if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    while (lines.length && !lines.at(-1).trim()) lines.pop();
    const footer = lines.slice(-3).join(' ');
    // The native key legend AND a selected multi-choice list must be current.
    // Requiring both avoids classifying ordinary prose, drafts and slash menus.
    if (!keyLegend(footer)) { return dismiss(runtime); }
    const choice = /^\s*[│┃]?\s*(?:[❯›>●]\s*)?\d+[.)]\s+\S/;
    const selected = /^\s*[│┃]?\s*[❯›>●]\s+\S/;
    const indexes = lines.map((line, i) => choice.test(line) ? i : -1).filter(i => i >= 0);
    let first = indexes[0];
    if (indexes.length < 2) {
      first = lines.findIndex(line => selected.test(line));
      if (first < 0 || !/^\s{2,}\S/.test(lines[first + 1] || '')) { return dismiss(runtime); }
    }
    if (!lines.slice(first, -1).some(line => selected.test(line))) { return dismiss(runtime); }
    const before = lines.slice(0, first).map((line, index) => ({ text: plainEdge(line), index })).filter(line => line.text);
    const heading = before.findLast(line => /[?？]$/.test(line.text) || /^(?:select|choose|confirm|allow|approve|permission|trust|folder)\b/i.test(line.text)) || before.at(-1);
    const title = (heading?.text || '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200);
    if (!title) return dismiss(runtime);
    // Until a separate legend is established, every row may be option content,
    // including a dot-only relative path. The region stays only in this WeakMap.
    const last = lines.length - 1;
    let key = lines.slice(heading.index).map(plainEdge).join('\n');
    const indent = line => line.replace(/^\s*[│┃]/, '').match(/^\s*/)[0].length;
    const optionIndent = Math.min(...(indexes.length >= 2 ? indexes : [first, first + 1]).map(i => indent(lines[i])));
    // Require a complete standalone key instruction after the choices, aligned
    // outside their hanging continuations. Ambiguous layouts keep the full key.
    for (let i = Math.max(first + 2, (indexes.at(-1) ?? first) + 1, lines.length - 3); i <= last; i++) {
      if (indent(lines[i]) > optionIndent || !/^(?:press\s+)?(?:enter|return)\b/i.test(plainEdge(lines[i]))) continue;
      if (!keyLegend(lines.slice(i).map(plainEdge).join(' '))) continue;
      let end = last;
      while (end > i && /^[ .·│]*$/.test(plainEdge(lines[end]))) end--;
      const legend = lines.slice(i, end + 1).map(plainEdge).join(' ');
      key = lines.slice(heading.index, i).map(plainEdge).join('\n') + '\n' + legend;
      break;
    }
    const previous = observed.get(runtime), memory = regions.get(runtime);
    if (previous?.title === title && memory?.key === key) return previous;
    const prompt = previous?.title === title
      ? { ...previous, revision: previous.revision + 1 }
      : { kind: 'choice', title, since: Math.max(Date.now(), (memory?.since || 0) + 1), revision: 0 };
    regions.set(runtime, { key, since: prompt.since });
    observed.set(runtime, prompt); return prompt;
  } catch { return observed.get(runtime) || null; } // An unreadable live frame does not prove dismissal.
}
// Most snapshots reuse one terminal frame. Do not decode every member's rows again.
function terminalDialogPrompt(session, runtime) {
  const terminal = runtime?.terminal, journal = terminal?.journal;
  if (!terminal || !Number.isSafeInteger(journal?.index)) return readTerminalDialogPrompt(session, runtime);
  const stamp = JSON.stringify([journal.epoch, journal.index, terminal.alive, terminal.screen?.cols, terminal.screen?.rows, session?.nativeId, session?.state]);
  const previous = frames.get(terminal);
  if (previous?.stamp === stamp) return previous.value;
  const value = readTerminalDialogPrompt(session, runtime);
  frames.set(terminal, { stamp, value }); return value;
}
// Positive evidence that Claude has returned to its empty editor. Missing or
// unreadable rows, ordinary output and a choice cursor are not an idle proof.
function claudeEmptyPrompt(runtime) {
  if (!runtime?.terminal?.alive) return false;
  try {
    const screen = runtime.terminal.screen, buffer = screen?.buffer?.active;
    if (!buffer || !Number.isSafeInteger(screen.rows) || screen.rows < 1 || screen.rows > 200 ||
        !Number.isSafeInteger(screen.cols) || screen.cols < 1 || screen.cols > 400 ||
        !Number.isSafeInteger(buffer.baseY) || buffer.baseY < 0 ||
        !Number.isSafeInteger(buffer.cursorY) || buffer.cursorY < 0 || buffer.cursorY >= screen.rows) return false;
    const line = buffer.getLine(buffer.baseY + buffer.cursorY);
    return Boolean(line && !line.isWrapped && /^\s*❯[ \t\u00a0]*$/.test(line.translateToString(true)));
  } catch { return false; }
}
module.exports = { terminalDialogPrompt, claudeEmptyPrompt };
