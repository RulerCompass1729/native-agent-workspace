const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../preflight.cjs'), 'utf8');
function subject(execute) {
  const module = { exports: {} };
  vm.runInNewContext(source, { module, process: { execPath: '/synthetic/Fixture.app/Contents/MacOS/Fixture' }, require(name) {
    if (name === 'node:child_process') return { execFile: execute };
    if (name === './platform.cjs') return {};
    if (name === './runtime-locations.cjs') return {};
    return require(name);
  } });
  return module.exports.appBuildInfo;
}
const app = { getVersion: () => '0.1.0-alpha.999', isPackaged: true };
const plain = value => JSON.parse(JSON.stringify(value));
test('packaged source revision uses one asynchronous bounded extraction from its own executable', async () => {
  let reply, calls = 0;
  const read = subject((command, args, options, callback) => {
    calls++; reply = callback;
    assert.equal(command, '/usr/bin/plutil');
    assert.deepEqual(Array.from(args), ['-extract', 'NAWSourceRevision', 'raw', '-o', '-', '/synthetic/Fixture.app/Contents/Info.plist']);
    assert.deepEqual(plain(options), { encoding: 'utf8', timeout: 1000, maxBuffer: 4096 });
  });
  let finished = false; const pending = read(app).then(value => { finished = true; return value; });
  await Promise.resolve(); assert.equal(finished, false); assert.equal(calls, 1);
  reply(null, 'a'.repeat(40) + '\n');
  assert.deepEqual(plain(await pending), { version: app.getVersion(), commit: 'a'.repeat(40), installedAt: null });
});
test('an unpackaged app never reads the installed binary metadata or guesses a git commit', async () => {
  const read = subject(() => assert.fail('No system child expected'));
  assert.deepEqual(plain(await read({ ...app, isPackaged: false })), { version: app.getVersion(), commit: null, installedAt: null });
});
test('only exact commit hashes and a single terminal newline are accepted', async () => {
  for (const raw of ['b'.repeat(64), 'C'.repeat(40) + '\n', ' ' + 'a'.repeat(40), 'a'.repeat(40) + '\n\n', 'a'.repeat(40) + '\r\n', 'a'.repeat(39), 'a'.repeat(40) + 'payload', null]) {
    const read = subject((_command, _args, _options, reply) => reply(null, raw));
    const result = await read(app);
    assert.equal(result.commit, raw === 'b'.repeat(64) ? raw : raw === 'C'.repeat(40) + '\n' ? 'C'.repeat(40) : null);
    assert.equal(result.installedAt, null);
  }
});
test('missing, oversized or timed-out metadata and synchronous child errors resolve as unknown', async () => {
  for (const code of ['ENOENT', 'ETIMEDOUT', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER']) {
    const read = subject((_command, _args, _options, reply) => reply(Object.assign(Error('synthetic'), { code }), 'a'.repeat(40)));
    assert.equal((await read(app)).commit, null);
  }
  assert.equal((await subject(() => { throw Error('synthetic spawn error'); })(app)).commit, null);
  assert.deepEqual(plain(await subject(() => assert.fail())({ getVersion() { throw Error('metadata unavailable'); } })), { version: null, commit: null, installedAt: null });
});
