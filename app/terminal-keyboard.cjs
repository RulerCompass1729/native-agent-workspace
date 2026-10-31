// Observe the native program's CSI-u push/set/pop requests on the canonical
// terminal. Do not advertise a complete keyboard-protocol implementation.
function trackKeyboardModes(screen) {
  const stacks = { normal: [0], alternate: [0] };
  const stack = () => stacks[screen.buffer.active.type];
  const handlers = [];
  const register = (prefix, action) => handlers.push(screen.parser.registerCsiHandler({ prefix, final: 'u' }, params => {
    if (params.some(value => !Number.isInteger(value) || value < 0)) return false;
    action(stack(), params); return true;
  }));
  register('>', (values, params) => {
    // Bound malformed/unbalanced native output while retaining the newest mode.
    if (values.length === 64) values.splice(1, 1);
    values.push(params[0] || 0);
  });
  register('=', (values, params) => {
    const flags = params[0] || 0, mode = params[1] || 1, index = values.length - 1;
    if (mode === 1) values[index] = flags;
    else if (mode === 2) values[index] |= flags;
    else if (mode === 3) values[index] &= ~flags;
  });
  register('<', (values, params) => values.splice(Math.max(1, values.length - (params[0] || 1))));
  return { get flags() { return stack().at(-1); }, dispose() { for (const handler of handlers) handler.dispose(); } };
}

// Keep native cursor requests for snapshots without replacing the receiver's
// defaults. These observers always leave parsing and device replies to xterm.
function trackCursorModes(screen) {
  let fallback, shape = 0, blinkOnly;
  const handlers = [];
  for (const [final, value] of [['h', true], ['l', false]]) {
    handlers.push(screen.parser.registerCsiHandler({ prefix: '?', final }, params => {
      if (params.includes(12)) fallback = value;
      return false;
    }));
  }
  const resetShape = () => { shape = 0; blinkOnly = undefined; return false; };
  handlers.push(screen.parser.registerCsiHandler({ intermediates: ' ', final: 'q' }, params => {
    const first = Array.isArray(params[0]) ? params[0][0] : params[0] ?? 0;
    if (!Number.isSafeInteger(first) || first < 0 || first > 2147483647) return false;
    if (first === 0) resetShape();
    else if (first <= 6) { shape = first; blinkOnly = undefined; }
    else blinkOnly = first;
    return false;
  }));
  handlers.push(screen.parser.registerCsiHandler({ intermediates: '!', final: 'p' }, resetShape));
  handlers.push(screen.parser.registerEscHandler({ final: 'c' }, resetShape));
  return {
    snapshot() {
      return (fallback === undefined ? '' : `\x1b[?12${fallback ? 'h' : 'l'}`)
        + '\x1b[0 q' + (shape ? `\x1b[${shape} q` : '')
        + (blinkOnly === undefined ? '' : `\x1b[${blinkOnly} q`);
    },
    dispose() { for (const handler of handlers) handler.dispose(); },
  };
}
module.exports = { trackKeyboardModes, trackCursorModes };
