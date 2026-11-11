'use strict';
// Desktop composition stays outside the shared backend: the daemon copies that
// module but must not acquire the desktop service bootstrap's dependencies.
const { ButlerBackend } = require('./butler-backend.cjs');
const dedicated = require('./butler-service-driver.cjs');
function createDedicatedBackend(directory, { runtimeVersion = 'unknown', executablePath = process.execPath } = {}) {
  // Construction prepares no store, checks no profile/presence and starts no
  // process. Qualification retains the four false defaults, never UI options.
  return new ButlerBackend(directory, { runtimeVersion, credentialPresent: dedicated.credentialPresent,
    driver: new dedicated.ButlerServiceDriver(directory, { executablePath }) });
}
module.exports = { createDedicatedBackend };
