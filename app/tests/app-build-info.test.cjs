const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../preflight.cjs'), 'utf8');
function subject(execute, executable = '/synthetic/Fixture.app/Contents/MacOS/Fixture') {
  const module = { exports: {} };
  vm.runInNewContext(source, { module, process: { execPath: executable, getuid: process.getuid }, require(name) {
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

const os = require('node:os'), path = require('node:path');
function receiptFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-build-info-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const executable = fs.statSync(process.execPath, { bigint: true });
  const record = { version: app.getVersion(), commit: 'a'.repeat(40), installedAt: '2026-10-30T06:08:01.000Z', executable: { dev: executable.dev.toString(), ino: executable.ino.toString() } };
  const file = path.join(directory, 'installation.json');
  const write = value => { fs.rmSync(file, { recursive: true, force: true }); fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 }); };
  return { directory, file, record, write, read: subject((_c, _a, _o, reply) => reply(null, 'a'.repeat(40)), process.execPath) };
}
test('installation time comes only from a private receipt for this build and executable', async t => {
  const f = receiptFixture(t);
  assert.equal((await f.read(app, f.directory)).installedAt, null);
  f.write(f.record);
  assert.equal((await f.read(app, f.directory)).installedAt, f.record.installedAt);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)), f.record, 'Reading metadata never updates the installation record');
});
test('another build, copied executable or invalid time never inherits the old installation time', async t => {
  const f = receiptFixture(t);
  for (const delta of [{ version: '0.1.0-alpha.998' }, { commit: 'b'.repeat(40) }, { installedAt: '2026-02-30T06:08:01.000Z' }, { installedAt: 'yesterday' }, { installedAt: 1 }, { executable: { ...f.record.executable, ino: '-1' } }, { executable: { ...f.record.executable, dev: '-1' } }, { executable: undefined }]) {
    f.write({ ...f.record, ...delta });
    assert.equal((await f.read(app, f.directory)).installedAt, null);
  }
});
test('unsafe or unreadable installation records remain unknown without blocking build metadata', async t => {
  const f = receiptFixture(t);
  for (const prepare of [
    () => { f.write(f.record); fs.chmodSync(f.file, 0o644); },
    () => { const target = path.join(f.directory, 'valid-target.json'); fs.writeFileSync(target, JSON.stringify(f.record), { mode: 0o600 }); fs.symlinkSync(target, f.file); },
    () => fs.mkdirSync(f.file),
    () => fs.writeFileSync(f.file, '{bad', { mode: 0o600 }),
    () => fs.writeFileSync(f.file, JSON.stringify(f.record) + ' '.repeat(4097), { mode: 0o600 }),
  ]) {
    fs.rmSync(f.file, { recursive: true, force: true }); prepare();
    const result = await f.read(app, f.directory);
    assert.equal(result.installedAt, null); assert.equal(result.commit, f.record.commit);
  }
});

test('an installation receipt cannot supply a missing packaged commit', async t => {
  const f = receiptFixture(t); f.write(f.record);
  const read = subject((_c, _a, _o, reply) => reply(null, 'not-a-commit'), process.execPath);
  assert.equal((await read(app, f.directory)).installedAt, null);
});
