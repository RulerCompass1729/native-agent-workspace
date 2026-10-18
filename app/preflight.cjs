const { executable, pythonExecutable } = require('./platform.cjs');
function preflight() {
  // Avoid the macOS developer-tools installer shim during startup.
  return { python: Boolean(pythonExecutable()), claude: Boolean(executable('claude')), codex: Boolean(executable('codex')) };
}
module.exports = { preflight };
