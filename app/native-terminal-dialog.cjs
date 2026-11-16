'use strict';
// Read the live cooked viewport, never scrollback or the GUI's scroll position.
// This observes a choice; it neither answers it nor changes native agent state.
const observed = new WeakMap(), frames = new WeakMap();
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
    if (!/\b(?:enter|return)\b.*\b(?:confirm|select|continue|submit|set|accept|proceed|choose)\b/i.test(footer) ||
        !/\besc(?:ape)?\b.*\b(?:cancel|back|exit|dismiss)[ .·│]*$/i.test(footer)) { observed.delete(runtime); return null; }
    const choice = /^\s*[│┃]?\s*(?:[❯›>●]\s*)?\d+[.)]\s+\S/;
    const selected = /^\s*[│┃]?\s*[❯›>●]\s+\S/;
    const indexes = lines.map((line, i) => choice.test(line) ? i : -1).filter(i => i >= 0);
    let first = indexes[0];
    if (indexes.length < 2) {
      first = lines.findIndex(line => selected.test(line));
      if (first < 0 || !/^\s{2,}\S/.test(lines[first + 1] || '')) { observed.delete(runtime); return null; }
    }
    if (!lines.slice(first, -1).some(line => selected.test(line))) { observed.delete(runtime); return null; }
    const before = lines.slice(0, first).map(line => line.replace(/^[\s│┃╭╰─┌└]+|[\s│┃╮╯─┐┘]+$/g, '')).filter(Boolean);
    const title = (before.findLast(line => /[?？]$/.test(line) || /^(?:select|choose|confirm|allow|approve|permission|trust|folder)\b/i.test(line)) || before.at(-1) || '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200);
    if (!title) { observed.delete(runtime); return null; }
    const previous = observed.get(runtime);
    if (previous?.title === title) return previous;
    const prompt = { kind: 'choice', title, since: Math.max(Date.now(), (previous?.since || 0) + 1) };
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
module.exports = { terminalDialogPrompt };
