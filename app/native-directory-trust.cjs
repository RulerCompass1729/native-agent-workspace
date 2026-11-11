'use strict';
// Reading only: a native startup screen may require the person's directory trust.
// This is neither an approval request nor evidence that any input was accepted.
function directoryTrustPrompt(session, runtime) {
  if (!['claude', 'codex'].includes(session?.provider) || session.state !== 'starting' || !runtime?.terminal?.alive) return null;
  try {
    const screen = runtime.terminal.screen, buffer = screen?.buffer?.active;
    if (!buffer || !Number.isSafeInteger(screen.rows) || screen.rows < 1 || screen.rows > 200 || !Number.isSafeInteger(screen.cols) || screen.cols < 1 || screen.cols > 400) return null;
    const first = buffer.baseY;
    if (!Number.isSafeInteger(first) || first < 0) return null;
    let text = '';
    for (let index = first; index < first + screen.rows; index++) {
      const line = buffer.getLine(index);
      if (!line) continue;
      text += (index > first && !line.isWrapped ? '\n' : '') + line.translateToString(false);
    }
    text = text.replace(/\0/g, ' ').replace(/\s+/g, ' ');
    const question = session.provider === 'claude'
      ? /\b(?:Is this a project you created or one you trust|Do you trust (?:the )?(?:files|contents)|Trust this folder)\b/i.test(text)
      : /\b(?:Do you trust the contents of this directory|Trust this folder)\b/i.test(text);
    const accept = session.provider === 'claude' ? /\bYes,\s*I trust (?:this|the) (?:folder|directory)\b/i.test(text) : /\b(?:Yes,\s*(?:continue|I trust this folder)|Trust and continue)\b/i.test(text);
    const decline = session.provider === 'claude' ? /\bNo,\s*(?:exit|quit)\b/i.test(text) : /\b(?:No,\s*(?:exit|quit)|Back to Agent Command Center)\b/i.test(text);
    return question && accept && decline ? { kind: 'directory-trust', provider: session.provider, source: 'native-terminal' } : null;
  } catch { return null; } // An unavailable/disposed native screen is not a decision.
}
module.exports = { directoryTrustPrompt };
