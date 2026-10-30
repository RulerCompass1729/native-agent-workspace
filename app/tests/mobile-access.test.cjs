const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const vm = require('node:vm');
const { MobileAccess, verifyTicket, FILE, OFF, PAIR_MS, SESSION_MS, MAX_BYTES } = require('../mobile-access.cjs');
const target = { serviceKey: 'synthetic-service', sessionId: 'session-a', nativeId: 'native-a' };
const actor = 'synthetic-human', site = 'https://mobile.invalid';
function fixture(t, options = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'naw-mobile-access-'))), own = fs.lstatSync(root);
  t.after(() => { const s = fs.lstatSync(root); assert.equal(s.uid, process.getuid()); assert.equal(s.ino, own.ino); assert.equal(s.dev, own.dev); fs.rmSync(root, { recursive: true }); });
  let time = 1000000, exclusive = true;
  const config = { identity: { pid: 900001, started: 'synthetic-issuer' }, now: () => time, exclusive: () => exclusive, ...options };
  const access = new MobileAccess(root, config);
  const f = { root, access, config, setTime(v) { time = v; }, getTime: () => time, exclusive(v) { exclusive = v; },
    scope: { ...target, actions: ['read', 'send', 'answer'] },
    begin(extra) { return access.beginPairing({ actor, origin: site, scopes: [this.scope], ...extra }); },
    pair(extra) { const challenge = this.begin(); return access.pair({ secret: challenge.secret, actor, origin: site, ...extra }); },
    authorize(session, action = 'send', extra) { return access.authorize({ token: session.cookieValue, actor, origin: site, csrf: session.csrf, action, target, ...extra }); },
    verify(ticket, action = 'send', context = target, extra) { return verifyTicket(root, ticket, context, action, { now: () => time, alive: () => true, ...extra }); },
    read: () => fs.readFileSync(path.join(root, FILE), 'utf8') };
  return f;
}
function ready(t, options) { const f = fixture(t, options); f.access.initialize({ alive: () => false }); return f; }
function faultIo({ marker = false, unlink = false } = {}) {
  const io = Object.create(fs);
  io.renameSync = () => { throw Object.assign(Error('Synthetic save failure'), { code: 'ENOSPC' }); };
  io.openSync = (file, ...args) => { if (marker && path.basename(file) === OFF) throw Object.assign(Error('Synthetic marker failure'), { code: 'ENOSPC' }); return fs.openSync(file, ...args); };
  io.unlinkSync = file => { if (unlink && path.basename(file) === FILE) throw Object.assign(Error('Synthetic unlink failure'), { code: 'EPERM' }); return fs.unlinkSync(file); };
  return io;
}
test('construction creates no files; an unknown issuer or absent exclusive ownership cannot enable access', t => {
  const f = fixture(t); assert.deepEqual(fs.readdirSync(f.root), []);
  assert.throws(() => f.begin(), /手机授权/);
  f.exclusive(false); assert.throws(() => f.access.initialize(), /手机授权/); assert.deepEqual(fs.readdirSync(f.root), []);
  assert.throws(() => new MobileAccess(f.root, { identity: null, exclusive: () => true }), /手机授权/);
});
test('a second live issuer cannot replace the first authority', t => {
  const f = ready(t), before = f.read(), other = new MobileAccess(f.root, f.config);
  assert.throws(() => other.initialize({ alive: () => true }), /手机授权/); assert.equal(f.read(), before);
});
test('the default replacement check does not mistake unavailable process inspection for confirmed death', t => {
  const f = ready(t), before = f.read(), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../mobile-access.cjs'), 'utf8'), {
    module, exports: module.exports, process, Buffer, URL,
    require(name) { return name === './platform.cjs' ? { processIdentity: () => null, processMayBeAlive: () => true } : require(name); },
  });
  const next = new module.exports.MobileAccess(f.root, { ...f.config, identity: { pid: 900002, started: 'synthetic-next' } });
  assert.throws(() => next.initialize(), /手机授权/); assert.equal(f.read(), before);
});
test('one explicit pairing stores digests, retains exact scope and keeps the cookie out of JSON', t => {
  const f = ready(t), challenge = f.begin(); assert.equal(challenge.expiresAt, f.getTime() + PAIR_MS);
  assert.ok(!f.read().includes(challenge.secret));
  const session = f.access.pair({ secret: challenge.secret, actor, origin: site });
  assert.equal(session.cookieValue.length, 43); assert.ok(!JSON.stringify(session).includes(session.cookieValue));
  assert.ok(!f.read().includes(session.cookieValue)); assert.ok(!f.read().includes(session.csrf));
  assert.equal(fs.statSync(path.join(f.root, FILE)).mode & 0o777, 0o600);
  const ticket = f.authorize(session); assert.equal(f.verify(ticket), true);
  assert.throws(() => f.access.pair({ secret: challenge.secret, actor, origin: site }), /手机授权/);
  assert.equal(f.verify(ticket), true, 'a duplicate exchange cannot replace the accepted device');
});
test('untrusted pairing failures do not write authority and are bounded within the window', t => {
  const f = ready(t), challenge = f.begin(), before = f.read();
  for (let i = 0; i < 10; i++) assert.throws(() => f.access.pair({ secret: 'bad', actor, origin: site }), /手机授权/);
  assert.throws(() => f.access.pair({ secret: challenge.secret, actor, origin: site }), e => e.code === 'MOBILE_PAIR_LIMIT');
  assert.equal(f.read(), before); f.setTime(f.getTime() + 60000);
  assert.ok(f.access.pair({ secret: challenge.secret, actor, origin: site }).cookieValue);
});
test('expired pairing, wrong actor and a different origin cannot mint a device', t => {
  const f = ready(t), challenge = f.begin();
  for (const extra of [{ actor: 'someone-else' }, { origin: 'https://other.invalid' }]) assert.throws(() => f.access.pair({ secret: challenge.secret, actor, origin: site, ...extra }), /手机授权/);
  f.setTime(challenge.expiresAt); assert.throws(() => f.access.pair({ secret: challenge.secret, actor, origin: site }), /手机授权/);
});
test('reads permit ordinary same-origin GETs while writes require the exact origin and CSRF', t => {
  const f = ready(t), session = f.pair();
  const read = f.authorize(session, 'read', { origin: undefined, csrf: undefined }); assert.equal(f.verify(read, 'read'), true);
  for (const extra of [{ origin: undefined }, { origin: 'null' }, { origin: 'https://other.invalid' }, { csrf: undefined }, { csrf: 'x'.repeat(43) }, { actor: 'someone-else' }]) assert.throws(() => f.authorize(session, 'send', extra), /手机授权/);
  assert.throws(() => f.authorize(session, 'read', { origin: 'https://other.invalid' }), /手机授权/);
});
test('a read ticket cannot authorize a different backend method', t => {
  const f = ready(t), session = f.pair(), read = f.authorize(session, 'read');
  assert.equal(f.verify(read, 'read'), true); assert.throws(() => f.verify(read, 'send'), /手机授权/);
  assert.throws(() => verifyTicket(f.root, read, target), /手机授权/);
});
test('private scope pins the service, logical session, native identity and action', t => {
  const f = ready(t), session = f.pair(), ticket = f.authorize(session);
  for (const changed of [{ serviceKey: 'other-service' }, { sessionId: 'other-session' }, { nativeId: 'native-b' }]) {
    assert.throws(() => f.authorize(session, 'send', { target: { ...target, ...changed } }), /手机授权/);
    assert.throws(() => f.verify(ticket, 'send', { ...target, ...changed }), /手机授权/);
  }
  assert.throws(() => f.verify(ticket, 'send', { ...target, nativeContextPending: { reason: 'clear' } }), /手机授权/);
  assert.throws(() => f.authorize(session, 'approve'), /手机授权/);
  assert.throws(() => f.authorize(session, 'send', { target: { ...target, owner: 'borrowed' } }), /手机授权/);
});
test('session expiry is absolute; reading does not extend it or rewrite authority', t => {
  const f = ready(t), session = f.pair(), before = f.read(), until = session.expiresAt;
  f.setTime(until - 1); const ticket = f.authorize(session); assert.equal(f.verify(ticket), true); assert.equal(f.read(), before);
  f.setTime(until); assert.throws(() => f.authorize(session), /手机授权/); assert.throws(() => f.verify(ticket), /手机授权/);
});
test('replacement requires a Mac action and invalidates the original device before the next exchange', t => {
  const f = ready(t), old = f.pair(), ticket = f.authorize(old);
  assert.throws(() => f.begin(), e => e.code === 'MOBILE_REPLACE_REQUIRED'); assert.equal(f.verify(ticket), true);
  const next = f.begin({ replace: true }); assert.throws(() => f.verify(ticket), /手机授权/);
  const session = f.access.pair({ secret: next.secret, actor, origin: site }); assert.notEqual(session.deviceId, old.deviceId);
  assert.throws(() => f.authorize(old), /手机授权/); assert.equal(f.verify(f.authorize(session)), true);
});
test('a request held before the backend guard cannot dispatch after a confirmed revoke', async t => {
  const f = ready(t), ticket = f.authorize(f.pair()), writes = []; let release;
  const hold = new Promise(resolve => { release = resolve; });
  const pending = (async () => { await hold; f.verify(ticket); writes.push('native dispatch'); })();
  assert.deepEqual(f.access.revoke(), { confirmed: true }); release();
  await assert.rejects(pending, /手机授权/); assert.deepEqual(writes, []);
});
for (const marker of [false, true]) test('a failed revoke save disables shared authority through '+(marker ? 'safe unlink' : 'the marker'), t => {
  const f = ready(t), ticket = f.authorize(f.pair()); f.access.io = faultIo({ marker });
  assert.deepEqual(f.access.revoke(), { confirmed: true }); assert.throws(() => f.verify(ticket), /手机授权/);
  assert.equal(fs.existsSync(path.join(f.root, OFF)), !marker); assert.equal(fs.existsSync(path.join(f.root, FILE)), !marker);
});
test('if every shared invalidation fails, revocation remains unconfirmed instead of hiding an in-flight permission', t => {
  const f = ready(t), session = f.pair(), ticket = f.authorize(session); f.access.io = faultIo({ marker: true, unlink: true });
  assert.deepEqual(f.access.revoke(), { confirmed: false });
  assert.throws(() => f.authorize(session), /手机授权/);
  assert.equal(f.verify(ticket), true, 'the old shared file can still authorize an in-flight action; never report this revoked');
});
test('a pairing save failure issues no cookie and fails the mobile path closed', t => {
  const f = ready(t), challenge = f.begin(); f.access.io = faultIo();
  assert.throws(() => f.access.pair({ secret: challenge.secret, actor, origin: site }), e => e.code === 'MOBILE_STORAGE' && e.revocationConfirmed === true);
  assert.equal(fs.existsSync(path.join(f.root, OFF)), true);
});
test('a revoke read fault closes the local entry even if the old shared authority cannot be confirmed', t => {
  const f = ready(t), session = f.pair(), ticket = f.authorize(session), io = Object.create(fs);
  io.readFileSync = () => { throw Object.assign(Error('Synthetic read fault'), { code: 'EIO' }); }; f.access.io = io;
  assert.deepEqual(f.access.revoke(), { confirmed: false });
  f.access.io = fs; assert.throws(() => f.authorize(session), /手机授权/);
  assert.equal(f.verify(ticket), true, 'shared invalidation was not confirmed; do not pretend a queued action was cancelled');
});
for (const variant of ['readable','symlink','hardlink','invalid-json','invalid-utf8','oversize','extra-field']) test('unsafe authority '+variant+' is never accepted', t => {
  const f = ready(t), ticket = f.authorize(f.pair()), file = path.join(f.root, FILE), raw = f.read();
  if (variant === 'readable') fs.chmodSync(file, 0o644);
  if (['symlink','hardlink'].includes(variant)) { const backup = path.join(f.root, 'owned-backup.json'); fs.renameSync(file, backup); fs[variant === 'symlink' ? 'symlinkSync' : 'linkSync'](backup, file); }
  if (variant === 'invalid-json') fs.writeFileSync(file, '{broken');
  if (variant === 'invalid-utf8') { const bytes = Buffer.from(raw); bytes[bytes.indexOf(actor)] = 255; fs.writeFileSync(file, bytes); }
  if (variant === 'oversize') fs.writeFileSync(file, ' '.repeat(MAX_BYTES + 1));
  if (variant === 'extra-field') fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(raw), extra: 'not authority' }));
  assert.throws(() => f.verify(ticket), /手机授权/);
});
test('missing authority, an unknown issuer and stale device epochs fail closed', t => {
  const f = ready(t), ticket = f.authorize(f.pair());
  assert.throws(() => f.verify(ticket, 'send', target, { alive: () => null }), /手机授权/);
  assert.throws(() => f.verify({ ...ticket, generation: '00000000-0000-0000-0000-000000000000' }), /手机授权/);
  fs.unlinkSync(path.join(f.root, FILE)); assert.throws(() => f.verify(ticket), /手机授权/);
});
test('a new confirmed issuer starts disabled and cannot inherit an old mobile device', t => {
  const f = ready(t), ticket = f.authorize(f.pair()), next = new MobileAccess(f.root, { ...f.config, identity: { pid: 900002, started: 'synthetic-next' } });
  next.initialize({ alive: () => false }); assert.throws(() => f.verify(ticket), /手机授权/);
  assert.deepEqual(f.access.revoke(), { confirmed: false }); assert.equal(JSON.parse(f.read()).issuer.pid, 900002);
});
test('unsafe origins and malformed scope cannot expand an existing grant', t => {
  const f = ready(t), session = f.pair(), before = f.read();
  for (const bad of ['http://mobile.invalid', 'https://mobile.invalid/', 'https://user@example.invalid', 'https://mobile.invalid/#secret']) assert.throws(() => f.begin({ origin: bad, replace: true }), /手机授权/);
  assert.throws(() => f.begin({ scopes: [{ ...f.scope, actions: ['send', 'approve'] }], replace: true }), /手机授权/);
  assert.throws(() => f.begin({ scopes: [f.scope, f.scope], replace: true }), /手机授权/);
  assert.equal(f.read(), before); assert.equal(f.verify(f.authorize(session)), true);
});
test('the backend refuses a forged action or target even when the device and epoch are current', t => {
  const f = ready(t); f.scope.actions = ['read']; const session = f.pair(), read = f.authorize(session, 'read');
  assert.equal(f.verify(read, 'read'), true);
  assert.throws(() => f.verify({ ...read, action: 'send' }, 'send'), /手机授权/);
  const other = { ...target, sessionId: 'session-b', nativeId: 'native-b' };
  assert.throws(() => f.verify({ ...read, ...other }, 'read', other), /手机授权/);
});
for (const field of ['deviceId','tokenHash']) test('an otherwise current backend ticket needs the exact '+field, t => {
  const f = ready(t), ticket = f.authorize(f.pair()); assert.equal(f.verify(ticket), true);
  const wrong = field === 'deviceId' ? '00000000-0000-0000-0000-000000000000' : (ticket.tokenHash[0] === '0' ? '1' : '0') + ticket.tokenHash.slice(1);
  assert.throws(() => f.verify({ ...ticket, [field]: wrong }), /手机授权/);
});
test('a shared disabled marker rejects a current cookie without relying on the local closed flag', t => {
  const f = ready(t), session = f.pair(); assert.ok(f.access.authenticate({ token: session.cookieValue, actor }));
  fs.writeFileSync(path.join(f.root, OFF), '', { mode: 0o600 });
  assert.throws(() => f.access.authenticate({ token: session.cookieValue, actor }), /手机授权/);
});
test('authority replaced during the backend read cannot dispatch using its older valid bytes', t => {
  const f = ready(t), ticket = f.authorize(f.pair()), io = Object.create(fs); assert.equal(f.verify(ticket), true); let changed = false;
  io.readFileSync = (...args) => {
    const bytes = fs.readFileSync(...args);
    if (!changed && typeof args[0] === 'number') {
      changed = true; const next = { ...JSON.parse(bytes), enabled: false, device: null }, file = path.join(f.root, FILE);
      fs.writeFileSync(file + '.replacement', JSON.stringify(next), { mode: 0o600 }); fs.renameSync(file + '.replacement', file);
    }
    return bytes;
  };
  assert.throws(() => f.verify(ticket, 'send', target, { io }), /手机授权/);
  assert.equal(changed, true); assert.equal(JSON.parse(f.read()).enabled, false);
});
test('a disable arriving during the backend read rejects the unchanged current authority', t => {
  const f = ready(t), ticket = f.authorize(f.pair()), io = Object.create(fs); assert.equal(f.verify(ticket), true); let changed = false;
  io.readFileSync = (...args) => {
    const bytes = fs.readFileSync(...args);
    if (!changed && typeof args[0] === 'number') { changed = true; fs.writeFileSync(path.join(f.root, OFF), '', { mode: 0o600 }); }
    return bytes;
  };
  assert.throws(() => f.verify(ticket, 'send', target, { io }), /手机授权/); assert.equal(changed, true);
});
test('a file that becomes unsafe after validation is preserved rather than overwritten by pairing', t => {
  const f = ready(t), io = Object.create(fs), file = path.join(f.root, FILE); let checks = 0;
  io.lstatSync = name => {
    if (name === file && ++checks === 2) { fs.renameSync(file, file + '.prior'); fs.writeFileSync(file, 'operator data', { mode: 0o644 }); }
    return fs.lstatSync(name);
  };
  f.access.io = io;
  assert.throws(() => f.begin(), e => e.code === 'MOBILE_STORAGE');
  assert.equal(f.read(), 'operator data'); assert.equal(fs.statSync(file).mode & 0o777, 0o644);
});
test('other-writable application roots do not acquire or retain mobile authority', t => {
  const f = ready(t), ticket = f.authorize(f.pair()); assert.equal(f.verify(ticket), true);
  try {
    fs.chmodSync(f.root, 0o777);
    assert.throws(() => new MobileAccess(f.root, f.config), /手机授权/);
    assert.throws(() => f.verify(ticket), /手机授权/);
  } finally { fs.chmodSync(f.root, 0o700); }
});
test('replaying a still-valid QR cannot undo a revoke whose authority save failed', t => {
  const f = ready(t), challenge = f.begin(); f.access.io = faultIo();
  assert.deepEqual(f.access.revoke(), { confirmed: true }); f.access.io = fs;
  assert.throws(() => f.access.pair({ secret: challenge.secret, actor, origin: site }), /手机授权/);
  assert.equal(fs.existsSync(path.join(f.root, OFF)), true); assert.equal(JSON.parse(f.read()).enabled, false);
});
test('an explicit Mac re-pair after a marker disable produces a usable new device', t => {
  const f = ready(t), old = f.pair(), oldTicket = f.authorize(old); f.access.io = faultIo();
  assert.deepEqual(f.access.revoke(), { confirmed: true }); assert.equal(fs.existsSync(path.join(f.root, OFF)), true);
  f.access.io = fs; const challenge = f.begin({ replace: true }), session = f.access.pair({ secret: challenge.secret, actor, origin: site });
  assert.equal(fs.existsSync(path.join(f.root, OFF)), false);
  assert.equal(f.verify(f.authorize(session)), true); assert.throws(() => f.verify(oldTicket), /手机授权/);
});
test('unrelated actors and origins cannot exhaust the legitimate pairing secret budget', t => {
  const f = ready(t), challenge = f.begin();
  for (let i = 0; i < 20; i++) assert.throws(() => f.access.pair({ secret: challenge.secret, actor: 'wrong-actor', origin: site }), /手机授权/);
  for (let i = 0; i < 20; i++) assert.throws(() => f.access.pair({ secret: challenge.secret, actor, origin: 'https://other.invalid' }), /手机授权/);
  assert.ok(f.access.pair({ secret: challenge.secret, actor, origin: site }).cookieValue);
});
