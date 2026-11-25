// node --require for an isolated test daemon: the loopback CLI counts as a qualified Claude version, and the version
// check (which would start a qualification run of its own) stays off. Production code never imports this module.
// Refused in any process but that daemon on this test's private folder.
const fs = require('node:fs'), path = require('node:path');
const root = process.env.NAW_TEST_APP_ROOT;
const real = file => { try { return fs.realpathSync(file); } catch { return null; } };
if (!root || !process.argv[1] || real(process.argv[1]) !== real(path.join(root, 'app/daemon.cjs'))) throw Error('rotation-daemon: the isolated test daemon only');
require('./simulated-person.cjs').assertPrivate(process.argv[2]);
const { NativeHost } = require(path.join(root, 'app/adapters.cjs'));
const version = process.env.NAW_TEST_CLAUDE_VERSION;
NativeHost.prototype.checkClaudeVersion = function () {};
const start = NativeHost.prototype.start;
NativeHost.prototype.start = function (...args) {
  this.qualificationTrialVersion = version;
  return start.apply(this, args);
};
