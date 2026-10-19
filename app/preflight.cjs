const { executable, pythonExecutable } = require('./platform.cjs');
const { readLocations } = require('./runtime-locations.cjs');
function preflight() {
  // Avoid the macOS developer-tools installer shim during startup.
  try {
    const paths = { python: pythonExecutable(), claude: executable('claude'), codex: executable('codex') };
    const configured = readLocations();
    return { ...Object.fromEntries(Object.entries(paths).map(([key, value]) => [key, Boolean(value)])), paths, configured };
  } catch (error) { return { python: false, claude: false, codex: false, paths: {}, configured: {}, error: error.message }; }
}
module.exports = { preflight };
