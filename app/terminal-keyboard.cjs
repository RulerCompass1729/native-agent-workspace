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
module.exports = { trackKeyboardModes };
