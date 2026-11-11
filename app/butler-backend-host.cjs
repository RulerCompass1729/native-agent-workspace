'use strict';
// Desktop composition stays outside the shared backend: the daemon copies that
// module but must not acquire the desktop service bootstrap's dependencies.
const { ButlerBackend } = require('./butler-backend.cjs');
const dedicated = require('./butler-dsh-driver.cjs');
// Presentation only. Core _read/prepare/ensure retain their strict refusal and
// never accept, rewrite or migrate an incompatible saved binding.
class DesktopButlerBackend extends ButlerBackend {
  blocked(error) {
    const reason = ['binding-mismatch', 'unsafe-record', 'state-invalid', 'unsafe-store',
      'store-unavailable', 'unsafe-directory', 'directory-unavailable'].includes(error?.code) ? error.code : 'state-unavailable';
    return { prepared: false, binding: null, state: 'blocked', ready: false,
      credentialPresent: false, credentialChecked: false, qualified: false, blocked: [reason] };
  }
  read() { try { return super.read(); } catch (error) { return this.blocked(error); } }
  snapshot() { try { return super.snapshot(); } catch (error) { return this.blocked(error); } }
}
function createDedicatedBackend(directory, { runtimeVersion = 'unknown', executablePath = process.execPath } = {}) {
  // Construction prepares no store, checks no profile/presence and starts no
  // process. Qualification retains the four false defaults, never UI options.
  return new DesktopButlerBackend(directory, { runtimeVersion, credentialPresent: dedicated.credentialPresent,
    // A DSH composition name, not a Codex profile or a default user selection.
    configuration: { profile: 'deepseek-pro', provider: 'deepseek', model: 'deepseek-v4-pro' },
    driver: new dedicated.ButlerDshDriver(directory, { executablePath }) });

}
module.exports = { createDedicatedBackend };
