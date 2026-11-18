// Loaded with --import into the DSH TUI process before any TUI code runs.
// Both hooks are digest-gated: an unexpected source stops the launch here.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = process.env.NAW_DSH_TUI_ROOT;
if (typeof root !== 'string' || root === '') {
  throw Error('NAW DSH TUI preload: NAW_DSH_TUI_ROOT is not set');
}
// Drops the per-user and per-session identifiers from model requests.
require('./butler-dsh-privacy.cjs').install({ from: root });
// Turns the update check (registry.npmjs.org) off.
require('./dsh-tui-update-off.cjs').install({ from: root });
