'use strict';
// One rule for "the person stopped": Esc in any encoding a terminal reports, or Ctrl-C's own byte.
// The queue dispatcher (R207) and the wake messages (R238) read the same rule, so one Esc cannot be a
// stop on one side and typing on the other (R207.1).
// Esc anywhere in one piece of terminal input, or Esc as a key report. Arrow and editing keys, a
// paste's marks and an Option key (Esc and one character) are not stops. Ctrl-C's own byte is told
// apart before `interrupts`; a key report that carries it (CSI 27;5;99~) is Esc-like.
function interrupts(data) {
  if (/^\x1b[^\x1b]$/u.test(data) && !/^\x1b[[O]$/.test(data)) return false;
  return data.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|O[ -~])/g, key => /^\x1b\[(?:27;\d+;)?(?:27|67|99)(?:[;:][\d;:]*)?[u~]$/.test(key) ? '\x1b' : '').includes('\x1b');
}
function interrupt(data) {
  return typeof data === 'string' && (data.includes('\x03') || interrupts(data));
}
module.exports = { interrupts, interrupt };
