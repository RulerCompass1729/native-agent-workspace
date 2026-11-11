const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const locks = require('../service-lock.cjs');
function store(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-lock-unit-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
test('the same process keeps its lock identity across launcher language and timezone choices', () => {
  const before = { TZ: process.env.TZ, LC_ALL: process.env.LC_ALL }, identity = locks.lockIdentity(process.pid);
  try { process.env.TZ = 'Asia/Shanghai'; process.env.LC_ALL = 'fr_FR.UTF-8'; assert.deepEqual(locks.lockIdentity(process.pid), identity); }
  finally { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
});
test('both lock formats parse; damaged records and symlinks cannot authorize cleanup', t => {
  const dir = store(t), file = path.join(dir, 'service.lock');
  assert.deepEqual(locks.parseLock(' 123\n'), { pid: 123 });
  for (const raw of ['', '1', '-1', '{}', '{"format":2,"pid":123}', '{"format":1,"pid":123}']) assert.equal(locks.parseLock(raw), null);
  const lock = locks.createLock(file, 'service', dir);
  assert.equal(lock.pid, process.pid); assert.equal(lock.started, locks.lockIdentity(process.pid).started); assert.equal(lock.directory, fs.realpathSync(dir));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const alias = path.join(dir, 'alias'); fs.symlinkSync(file, alias); assert.equal(locks.readLock(alias), null);
  fs.writeFileSync(file, JSON.stringify({ ...locks.parseLock(lock.text), token: 'replacement' }));
  assert.equal(locks.releaseLock(file, lock), false, 'A superseded owner cannot unlink a replacement');
  assert.equal(fs.existsSync(file), true);
});
test('birth identity distinguishes a reused PID; an unavailable identity stays protected', t => {
  const dir = store(t), record = { pid: 123, started: 'original' };
  const probe = started => ({ live: () => true, identity: () => started && ({ pid: 123, started }), command: () => { throw Error('Not needed'); } });
  assert.equal(locks.ownerMayBeAlive(record, dir, 'service', probe('original')), true);
  assert.equal(locks.ownerMayBeAlive(record, dir, 'service', probe('replacement')), false);
  assert.equal(locks.ownerMayBeAlive(record, dir, 'service', probe(null)), true);
  assert.equal(locks.ownerMayBeAlive(record, dir, 'service', { live: () => false }), false);
});
test('legacy daemon scope, root helpers, unavailable probes and ambiguous launchers are distinguished', t => {
  const dir = store(t), other = path.join(dir, 'other store'); fs.mkdirSync(other);
  const record = { pid: process.pid + 100000 };
  const probe = command => ({ live: () => true, identity: () => ({ pid: record.pid, started: 'stable' }), command: () => command });
  for (const kind of ['service', 'startup']) {
    assert.equal(locks.ownerMayBeAlive(record, dir, kind, probe({ executable: '/test/node', command: '/test/node /source/daemon.cjs ' + dir })), true);
    assert.equal(locks.ownerMayBeAlive(record, dir, kind, probe({ executable: '/test/node', command: '/test/node /source/daemon.cjs ' + other })), false);
    assert.equal(locks.ownerMayBeAlive(record, dir, kind, probe({ executable: '/usr/libexec/cryptexd', command: '/usr/libexec/cryptexd' })), false);
    assert.equal(locks.ownerMayBeAlive(record, dir, kind, probe({ executable: '', command: '' })), true);
    assert.equal(locks.ownerMayBeAlive(record, dir, kind, { ...probe(null), command: () => { throw Error('EPERM'); } }), true);
    let n = 0;
    assert.equal(locks.ownerMayBeAlive(record, dir, kind, { ...probe({ executable: '/bin/sleep', command: '/bin/sleep 60' }), identity: () => ({ pid: record.pid, started: String(++n) }) }), true, 'A PID changed during inspection is unknown');
  }
  assert.equal(locks.ownerMayBeAlive(record, dir, 'service', probe({ executable: '/Apps/Native Agent Workspace', command: '/Apps/Native Agent Workspace' })), false);
  assert.equal(locks.ownerMayBeAlive(record, dir, 'startup', probe({ executable: '/Apps/Native Agent Workspace', command: '/Apps/Native Agent Workspace' })), true, 'An old GUI launcher has no provable store');
});
test('a concurrent startup in this process retains its owned lock even if a legacy reader rewrites it', t => {
  const dir = store(t), file = path.join(dir, 'services.lock');
  const lock = locks.createLock(file, 'startup', dir);
  assert.equal(locks.ownerMayBeAlive(lock, dir, 'startup'), true);
  fs.writeFileSync(file, String(process.pid));
  assert.equal(locks.ownerMayBeAlive(locks.readLock(file), dir, 'startup'), true);
  assert.equal(locks.releaseLock(file, lock), false);
});
test('shutdown waiting ignores a reused PID but still requires socket closure and lock release', async t => {
  const dir = store(t), source = fs.readFileSync(require.resolve('../service-client.cjs'), 'utf8');
  const start = source.indexOf('async function waitForShutdown('), end = source.indexOf('async function ensureServiceAt(', start);
  const c = vm.createContext({ fs, path, ownerMayBeAlive: locks.ownerMayBeAlive, uiError: key => Error(key), setTimeout: fn => fn() });
  vm.runInContext(source.slice(start, end), c);
  const replaced = { pid: process.pid, started: 'not this process lifetime' };
  await c.waitForShutdown({ socket: { destroyed: true } }, dir, replaced);
  await assert.rejects(c.waitForShutdown({ socket: { destroyed: false } }, dir, replaced), /backendCloseUnconfirmed/);
  fs.writeFileSync(path.join(dir, 'service.lock'), String(process.pid));
  await assert.rejects(c.waitForShutdown({ socket: { destroyed: true } }, dir, replaced), /backendCloseUnconfirmed/);
});
