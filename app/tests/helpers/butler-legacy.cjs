'use strict';
// Load the exact rollback consumer from local Git, without copying or simplifying
// its production logic. Like the compatibility-hook tests, this requires history.
const { execFileSync } = require('node:child_process');
const Module = require('node:module'), path = require('node:path');
const revision = '3244066ac39b0e2054a307eb3819812086d33e92';
const root = path.resolve(__dirname, '../../..'), modules = new Map();
function source(name) {
  if (!/^[\w/-]+\.(?:cjs|js)$/.test(name) || name.includes('..')) throw Error('Invalid legacy module');
  return execFileSync('git', ['-c', 'core.fsmonitor=false', 'show', `${revision}:app/${name}`],
    { cwd: root, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: 10000 });
}
function load(name) {
  if (modules.has(name)) return modules.get(name).exports;
  const body = source(name), filename = path.join(root, 'app', name), value = new Module(filename);
  modules.set(name, value); value.filename = filename;
  value.require = request => request.startsWith('.')
    ? load(path.posix.normalize(path.posix.join(path.posix.dirname(name), request))) : require(request);
  value._compile(body, filename); value.loaded = true;
  return value.exports;
}
module.exports = { load, source, revision };
