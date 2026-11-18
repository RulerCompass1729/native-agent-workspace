'use strict';
// The DSH TUI 0.18.0 has no switch for its update check: every launch asks
// registry.npmjs.org (and, with a mirror, npmjs.org as well). All of its
// update requests go through resolveTuiUpdateTarget, so this load hook makes
// that function answer "unknown" at once. The digest gate fails closed: any
// other update.js source refuses to load instead of running unpatched.
const { createHash } = require('node:crypto');

const VERSION = '0.18.0';
const DIGEST = '5b9ce5743ab35063e8e093490f2121001e79722a1a6fea218138713c7a977891';
const ANCHOR = 'export async function resolveTuiUpdateTarget(signal) {\n';
const INJECTED = "    return { kind: 'unknown' }; // NAW: update checks are off\n";
const RELATIVE = 'node_modules/@deepseek-harness-tui/dsh-tui/lib/types/update.js';

function patchSource(source, version) {
  source = String(source);
  if (version !== VERSION) throw Error('DSH TUI update-off: unqualified TUI version');
  const digest = createHash('sha256').update(source).digest('hex');
  if (digest !== DIGEST) throw Error('DSH TUI update-off: unqualified update.js source');
  if (source.split(ANCHOR).length !== 2) throw Error('DSH TUI update-off: anchor not found exactly once');
  return source.replace(ANCHOR, ANCHOR + INJECTED);
}

// `from`: the runtime directory that holds node_modules.
function install({ from }) {
  const fs = require('node:fs');
  const path = require('node:path');
  const { pathToFileURL } = require('node:url');
  const { registerHooks } = require('node:module');
  if (typeof registerHooks !== 'function') throw Error('DSH TUI update-off: runtime unsupported');
  const file = path.join(from, RELATIVE);
  const manifest = path.join(from, 'node_modules/@deepseek-harness-tui/dsh-tui/package.json');
  const version = JSON.parse(fs.readFileSync(manifest, 'utf8')).version;
  const source = patchSource(fs.readFileSync(file, 'utf8'), version);
  const url = pathToFileURL(fs.realpathSync(file)).href;
  let applied = false;
  const hook = registerHooks({
    load(specifier, context, next) {
      if (specifier === url) {
        applied = true;
        return { format: 'module', source, shortCircuit: true };
      }
      return next(specifier, context);
    },
  });
  return {
    deregister: () => hook.deregister(),
    get applied() { return applied; },
  };
}

module.exports = { VERSION, DIGEST, ANCHOR, patchSource, install };
