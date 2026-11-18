'use strict';
// Host-local patch, not a node_modules edit or a proxy. Upstream rc.2 has no
// attribution opt-out or model-fetch injection hook. Its Files API fetch hook
// does not cover model requests. Keep the exact source digest fail-closed.
const { createHash } = require('node:crypto');
const VERSION = '0.2.1-rc.2';
const DIGEST = 'eba35025ed1eedda89c51f2da46a3a968f7be1d59719f2ceeadfc4518dff37d6';
const LINES = [
  '\t\t\t\t\t\t"x-deepseek-harness-user-id": this.dependencies.resolveUserId(),\n',
  '\t\t\t\t\t\t...options.sessionId === void 0 ? {} : { "x-deepseek-harness-session-id": String(options.sessionId) },\n',
];
function patchSource(source, version) {
  source = String(source);
  if (version !== VERSION || createHash('sha256').update(source).digest('hex') !== DIGEST ||
      LINES.some(line => source.split(line).length !== 2)) throw Error('DSH privacy patch: unqualified upstream source');
  for (const line of LINES) source = source.replace(line, '');
  // The removed user-id expression was the only call to resolveUserId.
  if (source.includes('this.dependencies.resolveUserId(') || source.includes('"x-deepseek-harness-session-id"')) throw Error('DSH privacy patch incomplete');
  return source;
}
// `from`: the directory whose node_modules holds the DSH install (the DSH TUI
// runtime). Without it, the package resolves next to this file, as before.
function install({ from } = {}) {
  const fs = require('node:fs'), path = require('node:path');
  const { pathToFileURL } = require('node:url');
  const { registerHooks } = require('node:module');
  if (typeof registerHooks !== 'function') throw Error('DSH privacy patch: runtime unsupported');
  let file;
  if (from === undefined) file = require.resolve('@deepseek-ai/dsh-llm-deepseek');
  else file = require.resolve('@deepseek-ai/dsh-llm-deepseek', { paths: [from] });
  const version = JSON.parse(fs.readFileSync(path.join(path.dirname(file), '../package.json'), 'utf8')).version;
  const source = patchSource(fs.readFileSync(file, 'utf8'), version);
  const url = pathToFileURL(file).href;
  let applied = false;
  const hook = registerHooks({ load(specifier, context, next) {
    if (specifier === url) { applied = true; return { format: 'module', source, shortCircuit: true }; }
    if (specifier.includes('/@deepseek-ai/dsh-llm-deepseek/')) throw Error('DSH privacy patch: unqualified module resolution');
    return next(specifier, context);
  } });
  return { deregister: () => hook.deregister(), assertApplied() {
    if (!applied) throw Object.assign(Error('DSH privacy patch was not applied'), { code: 'privacy-unconfirmed' });
  } };
}
module.exports = { VERSION, DIGEST, patchSource, install };
