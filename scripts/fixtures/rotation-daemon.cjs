// node --require for an isolated test daemon: the loopback CLI counts as a qualified Claude version, and the version
// check (which would start a qualification run of its own) stays off. Production code never imports this module.
const path = require('node:path');
const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '../..');
const { NativeHost } = require(path.join(root, 'app/adapters.cjs'));
const version = process.env.NAW_TEST_CLAUDE_VERSION;
NativeHost.prototype.checkClaudeVersion = function () {};
const start = NativeHost.prototype.start;
NativeHost.prototype.start = function (...args) {
  this.qualificationTrialVersion = version;
  return start.apply(this, args);
};
