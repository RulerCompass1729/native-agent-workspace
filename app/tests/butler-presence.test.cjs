'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const source = fs.readFileSync(require.resolve('../butler-presence.cjs'), 'utf8');
function fixture(result, options = {}) {
  const calls = [], module = { exports: {} };
  new Function('require', 'module', '__dirname', 'process', source)(name => {
    if (name === 'node:path') return path;
    if (name === './platform.cjs') return { pythonExecutable() { calls.push(['python']); return options.python === undefined ? '/synthetic/python' : options.python; } };
    if (name === 'node:child_process') return { spawnSync(...args) { calls.push(['spawn', ...args]); if (options.throwSpawn) throw Error('Synthetic spawn failure'); return result; } };
    throw Error('Unexpected display adapter dependency: ' + name);
  }, module, path.dirname(require.resolve('../butler-presence.cjs')), { env: new Proxy({}, { get() { throw Error('Environment values are not available to JavaScript'); } }) });
  return { probe: module.exports.displayCredentialPresent, calls };
}

test('display probe returns only exact successful true or false metadata and reads no environment values', () => {
  for (const value of [true, false]) {
    const result = { status: 0, stdout: ' \n{ "credentialPresent" : ' + value + ' }\t\n' };
    Object.defineProperty(result, 'stderr', { get() { throw Error('Do not read diagnostics'); } });
    const f = fixture(result); assert.equal(f.probe(), value); assert.deepEqual(f.calls.map(call => call[0]), ['python', 'spawn']);
    const [, binary, args, options] = f.calls[1];
    assert.equal(binary, '/synthetic/python'); assert.deepEqual(args, ['-I', path.join(__dirname, '../butler-dsh-launch.py'), '--presence']);
    assert.deepEqual(options, { encoding: 'utf8', timeout: 3000, maxBuffer: 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  }
});

test('display process errors, timeout, signals and unsuccessful or missing exit status remain unknown', () => {
  for (const result of [undefined, null, {}, { status: 1, stdout: '{"credentialPresent":false}' },
    { status: null, error: { code: 'ETIMEDOUT' }, stdout: '' }, { status: 0, error: { code: 'ENOENT' }, stdout: '{"credentialPresent":true}' },
    { status: 0, signal: 'SIGTERM', stdout: '{"credentialPresent":false}' }]) assert.equal(fixture(result).probe(), null);
  assert.equal(fixture(undefined, { throwSpawn: true }).probe(), null);
  const unavailable = fixture(null, { python: null }); assert.equal(unavailable.probe(), null); assert.equal(unavailable.calls.length, 1);
});

test('malformed, nonboolean, duplicate, extra, diagnostic and oversized output cannot become an absence claim', () => {
  for (const stdout of ['', 'invalid', 'null', '[]', 'false', '{"credentialPresent":null}', '{"credentialPresent":0}',
    '{"credentialPresent":"false"}', '{"credentialPresent":false,"extra":"synthetic"}', '{"credentialPresent":false,"credentialPresent":true}',
    'diagnostic\n{"credentialPresent":false}', '\ufeff{"credentialPresent":false}', ' '.repeat(1024) + '{"credentialPresent":false}',
    null, Buffer.from('{"credentialPresent":false}')]) assert.equal(fixture({ status: 0, stdout }).probe(), null);
});
