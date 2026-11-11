'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { ButlerRole } = require('../butler-role.cjs');
const { ButlerLedger } = require('../butler-ledger.cjs');
const person = Symbol('synthetic proof person');
const A = { sessionId: 'proof-a', nativeId: 'native-proof-a' }, B = { sessionId: 'proof-b', nativeId: 'native-proof-b' }, C = { sessionId: 'proof-c', nativeId: 'native-proof-c' };
const runner = { runnerRef: 'proof-runner', backendRef: 'proof-backend', purpose: 'butler', profile: 'synthetic-profile', provider: 'synthetic-provider', model: 'synthetic-model' };
const edge = (from = A, to = B, event = 'done') => ({ event, old: { id: from.sessionId, nativeId: from.nativeId }, new: { id: to.sessionId, nativeId: to.nativeId } });
const line = value => JSON.stringify(value) + '\n';
const note = line({ event: 'synthetic-note' }), AB = note + line(edge()), ABC = AB + line(edge(B, C));
const stateError = { code: 'ERR_BUTLER_STATE' }, busyError = { code: 'ERR_BUTLER_BUSY' };
const bytes = file => fs.existsSync(file) ? fs.readFileSync(file) : null;
const result = action => { try { return { identity: action()?.identity ?? null }; } catch (error) { return { code: error.code }; } };
const hash = value => createHash('sha256').update(value).digest('hex');
function fixture(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'naw-butler-rotation-proof-'))); fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const open = () => new ButlerRole(directory, { authorizePerson: actor => actor === person });
  const role = open(); role.set(person, { identity: A, runner }, 0);
  return { directory, role, open, proof: path.join(directory, 'butler-rotation-proof.json'), lock: path.join(directory, 'butler.json.lock') };
}
function verifiedB(f) { fs.writeFileSync(f.role.logFile, AB, { mode: 0o600 }); assert.deepEqual(f.role.current().identity, B); }

test('new selectors use disk version two while public set and snapshot stay version one', t => {
  const f = fixture(t);
  assert.equal(f.role.snapshot().version, 1);
  assert.equal(JSON.parse(fs.readFileSync(f.role.file)).version, 2);
  assert.equal(f.role.set(person, { identity: A, runner }, 1).version, 1);
});

for (const mutation of ['delete', 'short-prefix', 'same-length-kept', 'padded-prefix', 'branch', 'cycle', 'appended-kept']) test(`cold current refuses ${mutation} after a real log verified B`, t => {
  const f = fixture(t); verifiedB(f);
  if (mutation === 'delete') fs.unlinkSync(f.role.logFile);
  if (mutation === 'short-prefix') fs.writeFileSync(f.role.logFile, note);
  if (mutation === 'same-length-kept') { const rewritten = note + line(edge(A, B, 'kept')); assert.equal(Buffer.byteLength(rewritten), Buffer.byteLength(AB)); fs.writeFileSync(f.role.logFile, rewritten); }
  if (mutation === 'padded-prefix') fs.writeFileSync(f.role.logFile, note + ' '.repeat(Buffer.byteLength(AB) + 8192));
  if (mutation === 'branch') fs.appendFileSync(f.role.logFile, line(edge(A, C)));
  if (mutation === 'cycle') fs.appendFileSync(f.role.logFile, line(edge(B, A)));
  if (mutation === 'appended-kept') fs.appendFileSync(f.role.logFile, line(edge(A, B, 'kept')));
  assert.deepEqual(result(() => f.open().current()), stateError, 'A new Role cannot turn a previously verified handoff into original or cached authority');
});

test('a cold reader accepts the unchanged verified prefix growing normally from B to C', t => {
  const f = fixture(t); verifiedB(f); fs.appendFileSync(f.role.logFile, line(edge(B, C)));
  assert.deepEqual(f.open().current().identity, C);
});

test('one actual host Node child reopening the selector cannot forget a verified prefix after log deletion', async t => {
  const f = fixture(t); verifiedB(f); fs.unlinkSync(f.role.logFile);
  const home = path.join(f.directory, 'private-child-home'); fs.mkdirSync(home, { mode: 0o700 });
  const source = String.raw`const {ButlerRole}=require(process.argv[1]);const role=new ButlerRole(process.argv[2]);let out;try{out={identity:role.current()?.identity??null};}catch(error){out={code:error.code};}require('node:fs').writeSync(1,JSON.stringify(out)+'\n');`;
  // Exactly one child in this file. Its parent owns its deadline and final reap.
  const child = spawn(process.execPath, ['-e', source, require.resolve('../butler-role.cjs'), f.directory], {
    cwd: f.directory, env: { PATH: path.dirname(process.execPath) + ':/usr/bin:/bin', HOME: home, TMPDIR: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '', spawnError, closed = false;
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', text => { stdout += text; }); child.stderr.on('data', text => { stderr += text; });
  child.once('error', error => { spawnError = error; });
  const exited = new Promise(resolve => child.once('close', (code, signal) => { closed = true; resolve({ code, signal }); }));
  const timer = setTimeout(() => child.kill('SIGKILL'), 6000);
  try {
    const exit = await exited; assert.equal(spawnError, undefined); assert.equal(exit.signal, null); assert.equal(exit.code, 0, stderr);
    const observed = JSON.parse(stdout.trim()); console.log(JSON.stringify({ ownedColdChild: observed }));
    assert.deepEqual(observed, stateError);
  } finally { clearTimeout(timer); if (!closed) { child.kill('SIGKILL'); await exited; } }
});

for (const fault of ['missing', 'bad-json', 'unsafe', 'wrong-context', 'unknown-fields']) test(`a ${fault} proof blocks model current while human snapshot/revoke preserve unrelated evidence`, t => {
  const f = fixture(t), ledger = new ButlerLedger(f.directory);
  ledger.ingest({ eventId: 'retained-event', sourceRef: 'task:retained', kind: 'request', payload: { text: 'Synthetic retained ledger text' } });
  const ledgerFile = path.join(f.directory, 'butler-ledger.jsonl'), ledgerBefore = bytes(ledgerFile);
  if (fault === 'missing') { if (fs.existsSync(f.proof)) fs.unlinkSync(f.proof); }
  else if (fault === 'bad-json') fs.writeFileSync(f.proof, '{synthetic-broken', { mode: 0o600 });
  else {
    const value = fs.existsSync(f.proof) ? JSON.parse(fs.readFileSync(f.proof)) : { version: 1, selection: '0'.repeat(64), revision: 0, prefix: null, identity: A };
    if (fault === 'wrong-context') value.selection = 'f'.repeat(64);
    if (fault === 'unknown-fields') value.body = 'Synthetic unknown proof body retained';
    fs.writeFileSync(f.proof, JSON.stringify(value), { mode: 0o600 });
    if (fault === 'unsafe') fs.chmodSync(f.proof, 0o644);
  }
  const savedProof = bytes(f.proof), observed = result(() => f.role.current());
  assert.equal(f.role.snapshot().revision, 1);
  assert.equal(f.role.revoke(person, 1).selected, null);
  assert.deepEqual(bytes(f.proof), savedProof); assert.deepEqual(bytes(ledgerFile), ledgerBefore);
  assert.deepEqual(observed, stateError, 'Human revoke must remain available without treating the bad proof as model authority');
});

for (const retainProof of [false, true]) test(`a v1 selector ${retainProof ? 'downgrade retaining proof' : 'without proof'} stays human-readable and revocable but cannot authorize file-backed current`, t => {
  const f = fixture(t); verifiedB(f);
  const state = JSON.parse(fs.readFileSync(f.role.file)); state.version = 1; fs.writeFileSync(f.role.file, JSON.stringify(state));
  if (!retainProof && fs.existsSync(f.proof)) fs.unlinkSync(f.proof);
  const before = bytes(f.proof), cold = f.open(), observed = result(() => cold.current());
  assert.equal(cold.snapshot().version, 1); assert.equal(cold.snapshot().revision, 1);
  assert.equal(cold.revoke(person, 1).selected, null); assert.deepEqual(bytes(f.proof), before);
  assert.deepEqual(observed, stateError, 'A v1 file must not auto-migrate or bypass the proof gate');
});

test('the persisted proof has the exact public schema and contains no synthetic log names, reasons or bodies', t => {
  const f = fixture(t), canary = 'SYNTHETIC_PRIVATE_LOG_CANARY';
  const text = line({ ...edge(), old: { ...edge().old, name: canary }, new: { ...edge().new, name: canary }, reason: canary, body: canary });
  fs.writeFileSync(f.role.logFile, text, { mode: 0o600 }); assert.deepEqual(f.role.current().identity, B);
  const raw = fs.readFileSync(f.proof, 'utf8'), proof = JSON.parse(raw);
  assert.deepEqual(Object.keys(proof).sort(), ['identity', 'prefix', 'revision', 'selection', 'version']);
  assert.equal(proof.version, 1); assert.match(proof.selection, /^[0-9a-f]{64}$/);
  assert.equal(proof.selection, hash(JSON.stringify(f.role.snapshot())));
  assert.ok(Number.isSafeInteger(proof.revision) && proof.revision >= 0);
  assert.deepEqual(Object.keys(proof.prefix).sort(), ['digest', 'length']);
  assert.deepEqual(proof.prefix, { length: Buffer.byteLength(text), digest: hash(text) });
  assert.deepEqual(proof.identity, B); assert.equal(raw.includes(canary), false);
});

test('explicit trusted entries remain fixtures and cannot rewrite proof bytes or real log observations', t => {
  const f = fixture(t); verifiedB(f); const before = bytes(f.proof);
  assert.deepEqual(f.role.current([]).identity, A);
  assert.deepEqual(f.role.current([edge(), edge(B, C)]).identity, C);
  assert.deepEqual(bytes(f.proof), before);
  assert.deepEqual(f.role.current().identity, B);
});

test('an actual proof commit holds the Role lock against a second reader, and later C cannot be rolled back to B', t => {
  const f = fixture(t), peer = f.open(), rename = fs.renameSync; let attempts = 0, nested;
  fs.writeFileSync(f.role.logFile, AB, { mode: 0o600 });
  t.mock.method(fs, 'renameSync', (from, to, ...args) => {
    if (to === f.proof && !attempts) { attempts++; nested = result(() => peer.current()); }
    return rename(from, to, ...args);
  });
  try { assert.deepEqual(f.role.current().identity, B); } finally { t.mock.restoreAll(); }
  assert.equal(attempts, 1, 'New-protocol assertion: an actual proof commit must be observed');
  assert.deepEqual(nested, busyError);
  fs.writeFileSync(f.role.logFile, ABC); assert.deepEqual(peer.current().identity, C);
  fs.writeFileSync(f.role.logFile, AB); assert.deepEqual(result(() => f.open().current()), stateError);
});

test('failed human set proof initialization leaves the selector unchanged, releases its lock and still permits revoke', t => {
  const f = fixture(t), before = bytes(f.role.file), rename = fs.renameSync; let fired = 0;
  t.mock.method(fs, 'renameSync', (from, to, ...args) => {
    if (to === f.proof && !fired++) throw Object.assign(Error('Synthetic proof initialization failure'), { code: 'EIO' });
    return rename(from, to, ...args);
  });
  try { assert.throws(() => f.role.set(person, { identity: C, runner }, 1), stateError); }
  finally { t.mock.restoreAll(); }
  assert.equal(fired, 1, 'New-protocol assertion: initialization must reach its proof commit');
  assert.deepEqual(bytes(f.role.file), before); assert.equal(fs.existsSync(f.lock), false);
  assert.equal(f.role.snapshot().revision, 1); assert.equal(f.role.revoke(person, 1).selected, null);
});

test('a failed proof commit returns no new identity and does not poison human snapshot or revoke', t => {
  const f = fixture(t), before = bytes(f.role.file), rename = fs.renameSync; let fired = 0;
  fs.writeFileSync(f.role.logFile, AB, { mode: 0o600 });
  t.mock.method(fs, 'renameSync', (from, to, ...args) => {
    if (to === f.proof && !fired++) throw Object.assign(Error('Synthetic proof persistence failure'), { code: 'EIO' });
    return rename(from, to, ...args);
  });
  try { assert.throws(() => f.role.current(), stateError); } finally { t.mock.restoreAll(); }
  assert.equal(fired, 1, 'New-protocol assertion: the identity must depend on its proof commit');
  assert.deepEqual(bytes(f.role.file), before); assert.equal(fs.existsSync(f.lock), false);
  assert.equal(f.role.snapshot().revision, 1); assert.equal(f.role.revoke(person, 1).selected, null);
});

for (const phase of ['write', 'fsync', 'link']) test(`an owned kernel marker ${phase} EIO cannot acknowledge or alter a selection write`, { skip: process.platform !== 'darwin' }, t => {
  const f = fixture(t), before = bytes(f.role.file), proofBefore = bytes(f.proof);
  const open = fs.openSync, write = fs.writeFileSync, sync = fs.fsyncSync, link = fs.linkSync;
  let stageFd, fired = 0;
  t.mock.method(fs, 'openSync', (file, ...args) => {
    const fd = open(file, ...args);
    if (typeof file === 'string' && /^\.butler-role-lock-[0-9a-f-]{36}\.tmp$/i.test(path.basename(file))) stageFd = fd;
    return fd;
  });
  const fail = () => { fired++; throw Object.assign(Error('Synthetic owned marker failure'), { code: 'EIO' }); };
  if (phase === 'write') t.mock.method(fs, 'writeFileSync', (fd, ...args) => { if (fd === stageFd && !fired) fail(); return write(fd, ...args); });
  if (phase === 'fsync') t.mock.method(fs, 'fsyncSync', fd => { if (fd === stageFd && !fired) fail(); return sync(fd); });
  if (phase === 'link') t.mock.method(fs, 'linkSync', (from, to, ...args) => { if (to === f.lock && !fired) fail(); return link(from, to, ...args); });
  try { assert.throws(() => f.role.revoke(person, 1), stateError); } finally { t.mock.restoreAll(); }
  assert.equal(fired, 1); assert.deepEqual(bytes(f.role.file), before); assert.deepEqual(bytes(f.proof), proofBefore);
  assert.equal(fs.existsSync(f.lock), false);
  assert.equal(fs.readdirSync(f.directory).some(name => name.startsWith('.butler-role-lock-')), false);
  assert.equal(f.open().revoke(person, 1).selected, null);
});


test('an unconfirmed proof fsync is never reused as a durability acknowledgement on the next read', t => {
  const f = fixture(t), rename = fs.renameSync, sync = fs.fsyncSync; let committed = false, failed = 0;
  fs.writeFileSync(f.role.logFile, AB, { mode: 0o600 });
  t.mock.method(fs, 'renameSync', (from, to, ...args) => {
    const value = rename(from, to, ...args); if (to === f.proof) committed = true; return value;
  });
  t.mock.method(fs, 'fsyncSync', fd => {
    if (committed && fs.fstatSync(fd).isDirectory() && !failed) {
      failed++; throw Object.assign(Error('Synthetic proof directory sync failure'), { code: 'EIO' });
    }
    return sync(fd);
  });
  try { assert.throws(() => f.role.current(), stateError); } finally { t.mock.restoreAll(); }
  assert.equal(failed, 1); assert.equal(f.role.snapshot().revision, 1);
  const inode = fs.statSync(f.proof); let confirmed = 0;
  t.mock.method(fs, 'fsyncSync', fd => {
    const stat = fs.fstatSync(fd); if (stat.dev === inode.dev && stat.ino === inode.ino) confirmed++;
    return sync(fd);
  });
  try { assert.deepEqual(f.role.current().identity, B); } finally { t.mock.restoreAll(); }
  assert.ok(confirmed >= 1, 'The newly observed proof inode needs its own successful fsync');
});

for (const mutation of ['revision-rollback', 'same-revision-identity']) test(`observed proof ${mutation} refuses authority without poisoning human revoke`, t => {
  const f = fixture(t); verifiedB(f);
  const proof = JSON.parse(bytes(f.proof));
  if (mutation === 'revision-rollback') { assert.ok(proof.revision > 0); proof.revision--; }
  else proof.identity = A;
  fs.writeFileSync(f.proof, JSON.stringify(proof));
  assert.throws(() => f.role.current(), stateError);
  assert.equal(f.role.snapshot().revision, 1);
  assert.equal(f.role.revoke(person, 1).selected, null);
});
