'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), Module = require('node:module');
const { ButlerRole } = require('../butler-role.cjs');
const production = require('../butler-role-lock.cjs');
const HELPER = require.resolve('../butler-role-lock.cjs'), ROLE = require.resolve('../butler-role.cjs');
const EXLOCK = 0x20, DARWIN = { skip: process.platform !== 'darwin' && 'Darwin exclusive-open kernel-lock check' };
const person = Symbol('synthetic kernel-check person');
const selected = { identity: { sessionId: 'check-butler', nativeId: 'check-native' }, runner: { runnerRef: 'check-runner', backendRef: 'check-backend', purpose: 'butler', profile: 'synthetic-profile', provider: 'synthetic-provider', model: 'synthetic-model' } };
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const stage = file => typeof file === 'string' && /^\.butler-role-lock-[0-9a-f-]{36}\.tmp$/i.test(path.basename(file));
function fixture(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'naw-butler-lock-check-'))); fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const role = new ButlerRole(directory, { authorizePerson: actor => actor === person }); role.set(person, selected, 0);
  return { directory, role, lock: path.join(directory, production.ROLE_LOCK_NAME) };
}
function compile(file, helper) {
  const isolated = new Module(file, module); isolated.filename = file; isolated.paths = Module._nodeModulePaths(path.dirname(file));
  if (helper) isolated.require = name => name === './butler-role-lock.cjs' ? helper : Module.prototype.require.call(isolated, name);
  isolated._compile(fs.readFileSync(file, 'utf8'), file);
  return isolated.exports;
}
function fresh() { const helper = compile(HELPER); return { helper, Role: compile(ROLE, helper).ButlerRole }; }
function directoryFd(f) { return fs.openSync(f.directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW); }
function releaseOwn(f, fd) {
  if (fd === undefined) return;
  const held = fs.fstatSync(fd);
  if (fs.existsSync(f.lock) && same(fs.lstatSync(f.lock), held)) fs.unlinkSync(f.lock);
  fs.closeSync(fd);
}
function outcome(action) { try { return { returned: action() }; } catch (error) { return { code: error.code }; } }

test('ignoring EXLOCK cannot reclaim a real live kernel-held inode, and the fresh bad module stays BUSY after the runtime mock is removed', DARWIN, t => {
  const f = fixture(t), originalCache = require.cache[HELPER], bad = fresh(), badRole = new bad.Role(f.directory, { authorizePerson: actor => actor === person });
  const dir = directoryFd(f), holder = production.acquireRoleLock(f.directory, dir), held = fs.fstatSync(holder);
  const selectorBefore = fs.readFileSync(f.role.file), markerBefore = fs.readFileSync(f.lock), open = fs.openSync;
  let stripped = 0, first, selectorAfter, sameNamed, sameMarker, heldAfter;
  t.mock.method(fs, 'openSync', (file, flags, ...args) => {
    if (typeof flags === 'number' && (flags & EXLOCK) && (file === f.lock || stage(file) && path.dirname(file) === f.directory)) {
      stripped++; return open(file, flags & ~EXLOCK, ...args);
    }
    return open(file, flags, ...args);
  });
  try {
    first = outcome(() => badRole.revoke(person, 1));
    selectorAfter = fs.readFileSync(f.role.file);
    sameNamed = fs.existsSync(f.lock) && same(fs.lstatSync(f.lock), held);
    sameMarker = fs.existsSync(f.lock) && fs.readFileSync(f.lock).equals(markerBefore);
    heldAfter = fs.fstatSync(holder);
  } finally { t.mock.restoreAll(); releaseOwn(f, holder); fs.closeSync(dir); }
  assert.ok(stripped > 0, 'The scoped bad runtime must actually strip the kernel bit');
  // Run the later call before asserting the first result, so old code exposes
  // both the live-lock takeover and the absence of a sticky runtime refusal.
  const anotherBadRole = new bad.Role(f.directory, { authorizePerson: actor => actor === person });
  const second = outcome(() => anotherBadRole.revoke(person, anotherBadRole.snapshot().revision));
  const healthy = fresh(), healthyRole = new healthy.Role(f.directory, { authorizePerson: actor => actor === person });
  const healthyResult = healthyRole.revoke(person, healthyRole.snapshot().revision);
  console.log(JSON.stringify({ ignoredKernelFlag: { firstCode: first.code ?? null, sameNamed, sameMarker, heldLinksAfterAttempt: heldAfter.nlink, selectorChanged: !selectorBefore.equals(selectorAfter), laterCode: second.code ?? null } }));
  assert.deepEqual(first, { code: 'ERR_BUTLER_BUSY' });
  assert.equal(sameNamed, true); assert.equal(sameMarker, true); assert.deepEqual(selectorAfter, selectorBefore);
  assert.deepEqual(second, { code: 'ERR_BUTLER_BUSY' });
  assert.equal(healthyResult.selected, null); assert.equal(require.cache[HELPER], originalCache, 'Fresh compilation must not replace the global helper module');
});

for (const alias of [false, true]) test(`a healthy stage self-check sees an actual kernel contention${alias ? ' under the EWOULDBLOCK alias' : ''}`, DARWIN, t => {
  const f = fixture(t), freshHelper = fresh().helper, dir = directoryFd(f), open = fs.openSync;
  let fd, attempts = 0, conflicts = 0;
  t.mock.method(fs, 'openSync', (file, flags, ...args) => {
    const probing = stage(file) && path.dirname(file) === f.directory && typeof flags === 'number' && (flags & EXLOCK);
    if (probing) attempts++;
    try { return open(file, flags, ...args); }
    catch (error) {
      if (probing && ['EAGAIN', 'EWOULDBLOCK'].includes(error.code)) {
        conflicts++;
        if (alias) throw Object.assign(Error('Synthetic spelling of actual kernel contention'), { code: 'EWOULDBLOCK' });
      }
      throw error;
    }
  });
  try { fd = freshHelper.acquireRoleLock(f.directory, dir); assert.ok(same(fs.fstatSync(fd), fs.lstatSync(f.lock))); }
  finally { t.mock.restoreAll(); releaseOwn(f, fd); fs.closeSync(dir); }
  assert.ok(attempts >= 2, 'New-protocol assertion: the held stage must be opened a second time');
  assert.ok(conflicts >= 1, 'The second open must encounter actual kernel contention, not a fabricated success');
});

test('an unexpected self-check open error cannot publish a lock or change the selector', DARWIN, t => {
  const f = fixture(t), freshHelper = fresh().helper, dir = directoryFd(f), before = fs.readFileSync(f.role.file), open = fs.openSync;
  const counts = new Map(); let fd, fired = 0, observed, published;
  t.mock.method(fs, 'openSync', (file, flags, ...args) => {
    if (stage(file) && path.dirname(file) === f.directory && typeof flags === 'number' && (flags & EXLOCK)) {
      const count = (counts.get(file) || 0) + 1; counts.set(file, count);
      if (count === 2) { fired++; throw Object.assign(Error('Synthetic check-phase storage failure'), { code: 'EIO' }); }
    }
    return open(file, flags, ...args);
  });
  try { observed = outcome(() => { fd = freshHelper.acquireRoleLock(f.directory, dir); return true; }); published = fs.existsSync(f.lock); }
  finally { t.mock.restoreAll(); releaseOwn(f, fd); fs.closeSync(dir); }
  assert.equal(fired, 1, 'New-protocol assertion: the unexpected error must reach the second stage open');
  assert.equal(Object.hasOwn(observed, 'returned'), false); assert.equal(published, false);
  assert.deepEqual(fs.readFileSync(f.role.file), before);
  assert.equal(fs.readdirSync(f.directory).some(name => name.startsWith('.butler-role-lock-')), false);
});
