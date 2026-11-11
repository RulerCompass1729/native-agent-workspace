'use strict';
// Display only. Startup keeps its separate fail-closed Boolean qualification.
// The child inherits its environment; JavaScript never reads or copies credential values.
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pythonExecutable } = require('./platform.cjs');
function displayCredentialPresent() {
  try {
    const python = pythonExecutable();
    if (typeof python !== 'string' || !python) return null;
    const result = spawnSync(python, ['-I', path.join(__dirname, 'butler-dsh-launch.py'), '--presence'],
      { encoding: 'utf8', timeout: 3000, maxBuffer: 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    if (!result || result.error || result.signal || result.status !== 0 || typeof result.stdout !== 'string' ||
        Buffer.byteLength(result.stdout) > 1024) return null;
    // Exact one-field JSON also rejects duplicate keys and diagnostic prefixes.
    const match = /^[ \t\r\n]*\{[ \t\r\n]*"credentialPresent"[ \t\r\n]*:[ \t\r\n]*(true|false)[ \t\r\n]*\}[ \t\r\n]*$/u.exec(result.stdout);
    return match ? match[1] === 'true' : null;
  } catch { return null; }
}
module.exports = { displayCredentialPresent };
