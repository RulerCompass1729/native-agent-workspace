// Actual cold service bootstrap, no sessions or model inference. Every store is owned here.
for (const key of ['NAW_WORKSPACE', 'NAW_APP_VERSION', 'NAW_RUNTIME_CONFIG']) delete process.env[key];
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { ensureService, connectService } = require('../service-client.cjs');
const { processIdentity } = require('../platform.cjs');
const { lockIdentity, createLock, readLock, ownerMayBeAlive } = require('../service-lock.cjs');
const { execFileSync } = require('node:child_process');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function stop(directory) {
  const file = path.join(directory, 'service.lock'), owner = readLock(file);
  let client;
  try { client = await connectService(directory, 'owned-lock-test-cleanup'); await client.call('shutdown'); }
  catch (e) { if (fs.existsSync(path.join(directory, 'connection.json'))) throw e; }
  finally { client?.close(); }
  for (let n = 0; n < 50 && (fs.existsSync(file) || ownerMayBeAlive(owner, directory, 'service')); n++) await pause(100);
  assert.equal(fs.existsSync(file), false, 'Owned daemon released its lock');
  assert.equal(ownerMayBeAlive(owner, directory, 'service'), false, 'Owned daemon process ended before removing its store');
}
async function cleanup(directory, started) {
  if (started) await stop(directory);
  else if (fs.existsSync(path.join(directory, 'runtimes'))) throw Error('Failed bootstrap store retained for inspection: ' + directory);
  fs.rmSync(directory, { recursive: true, force: true });
}
for (const filename of ['service.lock', 'services.lock']) for (const method of ['lstatSync', 'readFileSync']) {
  test(filename + ' disappearing immediately before ' + method + ' permits actual cold bootstrap', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-disappearing-lock-')), file = path.join(directory, filename);
    let started = false, removed = false, client;
    fs.writeFileSync(file, String(process.pid));
    assert.equal(fs.existsSync(file), true);
    const original = fs[method];
    const mock = t.mock.method(fs, method, function (target, ...args) {
      if (target === file && !removed) { fs.unlinkSync(file); removed = true; }
      return original.call(this, target, ...args);
    });
    try {
      await ensureService(directory, process.execPath); started = true;
      assert.equal(removed, true, 'The read really raced with removal');
      client = await connectService(directory, 'disappearing-lock-check');
      const state = await client.call('initial');
      assert.notEqual(state.servicePid, process.pid); assert.deepEqual(state.sessions, []); assert.equal(state.diagnostics.dispatches, 0);
      assert.equal(fs.existsSync(path.join(directory, 'services.lock')), false);
    } finally { mock.mock.restore(); client?.close(); await cleanup(directory, started); }
  });
}
test('both startup paths refuse corrupt, nonregular, foreign-owned and unreadable locks before spawning', async t => {
  for (const filename of ['service.lock', 'services.lock']) for (const kind of ['corrupt', 'directory', 'symlink', 'foreign', 'denied']) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-invalid-lock-')), file = path.join(directory, filename);
    let mock, started = false;
    if (kind === 'directory') fs.mkdirSync(file);
    else if (kind === 'symlink') fs.symlinkSync(path.join(directory, 'missing'), file);
    else fs.writeFileSync(file, kind === 'corrupt' ? '{invalid' : String(process.pid));
    if (kind === 'foreign' || kind === 'denied') {
      const original = fs.lstatSync;
      mock = t.mock.method(fs, 'lstatSync', function (target, ...args) {
        if (target === file && kind === 'denied') throw Object.assign(Error('fixture denied'), { code: 'EACCES' });
        const stat = original.call(this, target, ...args);
        if (target === file) stat.uid = process.getuid() + 1;
        return stat;
      });
    }
    try {
      await assert.rejects(async () => { await ensureService(directory, process.execPath); started = true; }, error => kind === 'denied'
        ? error.code === 'EACCES' : error.uiMessage?.key === (filename === 'service.lock' ? 'error.service.recordCorrupted' : 'error.service.invalidStartupRecord'));
      assert.equal(fs.existsSync(path.join(directory, 'runtimes')), false, 'No replacement runtime allocated');
      t.diagnostic(filename + ': ' + kind + ' retained');
    } finally { mock?.mock.restore(); await cleanup(directory, started); }
  }
});
test('legacy locks naming a live unrelated root process recover even when kill(pid, 0) is EPERM', async () => {
  const processes = execFileSync('/bin/ps', ['-axo', 'pid=,uid=,comm='], { encoding: 'utf8' }).split('\n');
  const row = processes.map(line => line.trim().match(/^(\d+)\s+0\s+(\/usr\/libexec\/logd)$/)).find(Boolean);
  assert.ok(row, 'The macOS root log daemon is present for this read-only EPERM case');
  const pid = Number(row[1]), before = lockIdentity(pid);
  assert.ok(before); assert.throws(() => process.kill(pid, 0), error => error.code === 'EPERM');
  for (const filename of ['service.lock', 'services.lock']) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-root-lock-'));
    let started = false, client;
    try {
      fs.writeFileSync(path.join(directory, filename), String(pid));
      await ensureService(directory, process.execPath); started = true;
      client = await connectService(directory, 'root-lock-check'); const state = await client.call('initial');
      assert.notEqual(state.servicePid, pid); assert.deepEqual(state.sessions, []); assert.equal(state.diagnostics.dispatches, 0);
      assert.deepEqual(lockIdentity(pid), before, 'No signal or replacement of the unrelated root process');
    } finally { client?.close(); await cleanup(directory, started); }
  }
});
test('versioned locks with an old birth time recover while that PID is still alive', async () => {
  for (const [filename, kind] of [['service.lock', 'service'], ['services.lock', 'startup']]) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-birth-lock-')), file = path.join(directory, filename);
    let started = false;
    try {
      const lock = createLock(file, kind, directory), old = JSON.parse(lock.text);
      fs.writeFileSync(file, JSON.stringify({ ...old, started: 'Previous boot process lifetime' }));
      await ensureService(directory, process.execPath); started = true;
      assert.equal(fs.existsSync(path.join(directory, 'services.lock')), false);
    } finally { await cleanup(directory, started); }
  }
});
test('an actual stopped directory daemon retains both legacy and versioned locks, without replacement', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-live-lock-')), file = path.join(directory, 'service.lock'), startup = path.join(directory, 'services.lock');
  let started = false, paused = false, original, identity;
  try {
    await ensureService(directory, process.execPath); started = true;
    original = fs.readFileSync(file, 'utf8'); const lock = JSON.parse(original); identity = lockIdentity(lock.pid);
    assert.equal(identity.started, lock.started);
    const connection = fs.readFileSync(path.join(directory, 'connection.json'), 'utf8');
    process.kill(lock.pid, 'SIGSTOP'); paused = true; // Only this test-created empty backend.
    for (const [filename, kind] of [[file, 'service'], [startup, 'startup']]) for (const legacy of [true, false]) {
      const bytes = legacy ? String(lock.pid) : JSON.stringify({ ...lock, kind }); fs.writeFileSync(filename, bytes);
      await assert.rejects(ensureService(directory, process.execPath), error => error.uiMessage?.key === (kind === 'service' ? 'error.service.existingBackendUnreachable' : 'error.service.connecting'));
      assert.equal(fs.readFileSync(filename, 'utf8'), bytes); assert.deepEqual(lockIdentity(lock.pid), identity);
      assert.equal(fs.readFileSync(path.join(directory, 'connection.json'), 'utf8'), connection);
      t.diagnostic(kind + ' ' + (legacy ? 'PID-only' : 'birth identity') + ': real unresponsive owner preserved');
      if (kind === 'startup') fs.unlinkSync(startup); else fs.writeFileSync(file, original);
    }
  } finally {
    if (original) fs.writeFileSync(file, original);
    fs.rmSync(startup, { force: true });
    if (paused && lockIdentity(identity.pid)?.started === identity.started) process.kill(identity.pid, 'SIGCONT');
    await cleanup(directory, started);
  }
});
for (const filename of ['service.lock', 'services.lock']) {
  test('PID reuse: legacy ' + filename + ' naming the new launcher itself permits cold startup', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-reboot-lock-'));
    let started = false, client;
    const before = processIdentity(process.pid);
    try {
      fs.writeFileSync(path.join(directory, filename), String(process.pid));
      await ensureService(directory, process.execPath); started = true;
      client = await connectService(directory, 'check'); const state = await client.call('initial');
      assert.notEqual(state.servicePid, process.pid); assert.deepEqual(state.sessions, []);
      assert.equal(state.diagnostics.dispatches, 0); assert.deepEqual(processIdentity(process.pid), before);
      assert.equal(fs.existsSync(path.join(directory, 'services.lock')), false);
    } finally { client?.close(); await cleanup(directory, started); }
  });
}
