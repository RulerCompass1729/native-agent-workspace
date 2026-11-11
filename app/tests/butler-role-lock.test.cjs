'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { ButlerRole } = require('../butler-role.cjs');
const PROTOCOL = 'naw-butler-role-lock-v1';
const person = Symbol('synthetic person capability');
const identity = { sessionId: 'lock-butler', nativeId: 'lock-native' };
const runner = { runnerRef: 'lock-runner', backendRef: 'lock-backend', purpose: 'butler', profile: 'synthetic-profile', provider: 'synthetic-provider', model: 'synthetic-model' };
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const DARWIN = { skip: process.platform !== 'darwin' && 'Darwin kernel-open locking contract' };
// A finite file-level budget: two crash children plus one held-lock child.
const MAX_CHILDREN = 3; let childrenStarted = 0;
function fixture(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'naw-butler-role-lock-'))); fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const role = new ButlerRole(directory, { authorizePerson: actor => actor === person });
  role.set(person, { identity, runner }, 0);
  return { directory, role, lock: path.join(directory, 'butler.json.lock') };
}
function marker(f, changes = {}) {
  return { protocol: PROTOCOL, stage: `.butler-role-lock-${randomUUID()}.tmp`, ...changes };
}
function writeMarker(f, value = marker(f)) {
  fs.writeFileSync(f.lock, JSON.stringify(value), { mode: 0o600 }); return value;
}
const CHILD = String.raw`
'use strict';
const fs=require('node:fs'),path=require('node:path');
const [moduleFile,directory,mode]=process.argv.slice(1);
const {ButlerRole}=require(moduleFile),person=Symbol('owned child person');
const role=new ButlerRole(directory,{authorizePerson:value=>value===person});
const canonical=path.join(directory,'butler.json.lock');
const raw={open:fs.openSync,link:fs.linkSync,unlink:fs.unlinkSync};
function boundary(phase) {
  const stat=fs.lstatSync(canonical);
  fs.writeSync(1,JSON.stringify({phase,nlink:stat.nlink,size:stat.size,node:process.version})+'\n');
  if(mode==='live') {Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,7000);process.exit(79);}
  process.exit(phase==='published-two-links'?71:phase==='published-one-link'?72:73);
}
fs.openSync=function(file,flags,...args){
  const fd=raw.open.call(this,file,flags,...args);
  // The old empty O_EXCL implementation must leave its real lock behind too.
  if(file===canonical&&typeof flags==='number'&&(flags&fs.constants.O_EXCL))boundary('legacy-open');
  return fd;
};
fs.linkSync=function(from,to,...args){
  const result=raw.link.call(this,from,to,...args);
  if(to===canonical&&(mode==='two-links'||mode==='live'))boundary('published-two-links');
  return result;
};
fs.unlinkSync=function(file,...args){
  const result=raw.unlink.call(this,file,...args);
  if(mode==='one-link'&&path.dirname(file)===directory&&/^\.butler-role-lock-[0-9a-f-]{36}\.tmp$/i.test(path.basename(file)))boundary('published-one-link');
  return result;
};
role.revoke(person,1);process.exit(78);
`;
function childOptions(f) {
  assert.ok(++childrenStarted <= MAX_CHILDREN, 'No retry or extra child is allowed');
  const home = path.join(f.directory, 'private-child-home'); fs.mkdirSync(home, { mode: 0o700 });
  // Deliberately constructed; no parent environment or authentication is copied.
  return { cwd: f.directory, env: { PATH: path.dirname(process.execPath) + ':/usr/bin:/bin', HOME: home, TMPDIR: home }, stdio: ['ignore', 'pipe', 'pipe'] };
}
const childArgs = (f, mode) => ['-e', CHILD, require.resolve('../butler-role.cjs'), f.directory, mode];
function checkPublished(f, observation, wanted) {
  console.log(JSON.stringify({ ownedCrashBoundary: wanted, observed: observation }));
  assert.ok(['legacy-open', wanted].includes(observation.phase));
  if (observation.phase === 'legacy-open') assert.equal(fs.statSync(f.lock).size, 0);
  else {
    const saved = JSON.parse(fs.readFileSync(f.lock, 'utf8'));
    assert.deepEqual(Object.keys(saved).sort(), ['protocol', 'stage']); assert.equal(saved.protocol, PROTOCOL);
    assert.match(saved.stage, /^\.butler-role-lock-[0-9a-f-]{36}\.tmp$/i);
    assert.equal(fs.statSync(f.lock).nlink, wanted === 'published-two-links' ? 2 : 1);
    if (wanted === 'published-two-links') assert.ok(same(fs.statSync(f.lock), fs.statSync(path.join(f.directory, saved.stage))));
    else assert.equal(fs.existsSync(path.join(f.directory, saved.stage)), false);
  }
}

for (const mode of ['two-links', 'one-link']) test(`an owned real child crash after ${mode} publication leaves a recoverable protocol lock`, DARWIN, t => {
  const f = fixture(t), before = fs.readFileSync(f.role.file);
  const child = spawnSync(process.execPath, childArgs(f, mode), { ...childOptions(f), timeout: 5000, killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer: 16384 });
  assert.equal(child.error, undefined); assert.equal(child.signal, null); assert.ok([71, 72, 73].includes(child.status), child.stderr);
  checkPublished(f, JSON.parse(child.stdout.trim()), mode === 'two-links' ? 'published-two-links' : 'published-one-link');
  assert.deepEqual(fs.readFileSync(f.role.file), before, 'The crashed writer had not changed the designation');
  assert.equal(f.role.revoke(person, 1).selected, null);
  assert.equal(f.role.snapshot().revision, 2); assert.equal(fs.existsSync(f.lock), false);
});

function ready(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => finish(Error('Owned child boundary deadline')), 4000);
    const onError = error => finish(error), onExit = () => finish(Error('Owned child exited before its boundary'));
    function onData(chunk) { output += chunk; if (output.includes('\n')) { try { finish(null, JSON.parse(output.slice(0, output.indexOf('\n')))); } catch (error) { finish(error); } } }
    function finish(error, value) { clearTimeout(timer); child.off('error', onError); child.off('exit', onExit); child.stdout.off('data', onData); error ? reject(error) : resolve(value); }
    child.on('error', onError); child.on('exit', onExit); child.stdout.on('data', onData);
  });
}
function reap(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Owned child reap deadline')), 2000);
    child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill('SIGKILL');
  });
}
test('a live owned child is BUSY; only after its exact process is killed and reaped can the abandoned protocol lock recover', DARWIN, async t => {
  const f = fixture(t), before = fs.readFileSync(f.role.file), child = spawn(process.execPath, childArgs(f, 'live'), childOptions(f));
  try {
    const observation = await ready(child); checkPublished(f, observation, 'published-two-links');
    const locked = fs.statSync(f.lock);
    assert.equal(child.exitCode, null); assert.equal(child.signalCode, null);
    assert.throws(() => f.role.revoke(person, 1), { code: 'ERR_BUTLER_BUSY' });
    assert.ok(same(fs.statSync(f.lock), locked)); assert.deepEqual(fs.readFileSync(f.role.file), before);
  } finally { await reap(child); }
  assert.equal(child.signalCode, 'SIGKILL');
  assert.equal(f.role.revoke(person, 1).selected, null);
});

for (const kind of ['empty', 'unknown', 'bad-json', 'wrong-protocol', 'extra-field', 'path-escape', 'unsafe-mode', 'canonical-symlink', 'arbitrary-hardlink', 'wrong-stage-inode', 'stage-symlink', 'three-links']) test(`a private synthetic ${kind} lock stays BUSY and is never removed or rewritten`, t => {
  const f = fixture(t), selected = fs.readFileSync(f.role.file); let value = marker(f);
  if (kind === 'wrong-protocol') value.protocol = 'unknown-protocol';
  if (kind === 'extra-field') value.owner = 'untrusted-assertion';
  if (kind === 'path-escape') value.stage = '../synthetic-outside.tmp';
  if (['empty', 'unknown', 'bad-json'].includes(kind)) fs.writeFileSync(f.lock, kind === 'empty' ? '' : kind === 'unknown' ? 'synthetic unknown writer' : '{incomplete', { mode: 0o600 });
  else writeMarker(f, value);
  if (kind === 'unsafe-mode') fs.chmodSync(f.lock, 0o644);
  if (kind === 'canonical-symlink') { const retained = path.join(f.directory, 'retained-target'); fs.renameSync(f.lock, retained); fs.symlinkSync(retained, f.lock); }
  if (kind === 'arbitrary-hardlink') fs.linkSync(f.lock, path.join(f.directory, 'unrelated-hardlink'));
  if (kind === 'wrong-stage-inode') fs.writeFileSync(path.join(f.directory, value.stage), 'synthetic other inode', { mode: 0o600 });
  if (kind === 'stage-symlink') { const target = path.join(f.directory, 'synthetic-stage-target'); fs.writeFileSync(target, '', { mode: 0o600 }); fs.symlinkSync(target, path.join(f.directory, value.stage)); }
  if (kind === 'three-links') { fs.linkSync(f.lock, path.join(f.directory, value.stage)); fs.linkSync(f.lock, path.join(f.directory, 'unexpected-third-link')); }
  const lockBefore = fs.lstatSync(f.lock), bytes = fs.readFileSync(f.lock);
  assert.throws(() => f.role.revoke(person, 1), { code: 'ERR_BUTLER_BUSY' });
  assert.ok(same(fs.lstatSync(f.lock), lockBefore)); assert.deepEqual(fs.readFileSync(f.lock), bytes);
  assert.deepEqual(fs.readFileSync(f.role.file), selected); assert.equal(f.role.snapshot().revision, 1);
});

test('a stale candidate descriptor never authorizes removal after the canonical path changes to a synthetic legacy inode', DARWIN, t => {
  const f = fixture(t); writeMarker(f); const before = fs.readFileSync(f.role.file), original = fs.openSync; let changed = 0, replacement;
  t.mock.method(fs, 'openSync', (file, flags, ...args) => {
    const fd = original(file, flags, ...args);
    // 0x20 is Darwin's public SDK O_EXLOCK, not a Linux flag assumption.
    if (!changed && file === f.lock && typeof flags === 'number' && (flags & 0x20)) {
      changed++; fs.renameSync(f.lock, path.join(f.directory, 'retained-stale-inode'));
      const fresh = original(f.lock, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600); fs.closeSync(fresh); replacement = fs.statSync(f.lock);
    }
    return fd;
  });
  try { assert.throws(() => f.role.revoke(person, 1), { code: 'ERR_BUTLER_BUSY' }); }
  finally { t.mock.restoreAll(); }
  assert.equal(changed, 1, 'The stale candidate must reach a kernel-lock attempt before the path is swapped');
  assert.ok(same(fs.statSync(f.lock), replacement)); assert.equal(fs.statSync(f.lock).size, 0);
  assert.deepEqual(fs.readFileSync(f.role.file), before);
});

test('a synthetic legacy writer winning the gap after stale recovery keeps its empty lock', DARWIN, t => {
  const f = fixture(t); writeMarker(f); const before = fs.readFileSync(f.role.file), stale = fs.statSync(f.lock), unlink = fs.unlinkSync; let won = 0, legacy;
  t.mock.method(fs, 'unlinkSync', (file, ...args) => {
    const competing = !won && file === f.lock && same(fs.lstatSync(file), stale), result = unlink(file, ...args);
    if (competing) {
      won++; const fd = fs.openSync(f.lock, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600); fs.closeSync(fd); legacy = fs.statSync(f.lock);
    }
    return result;
  });
  try { assert.throws(() => f.role.revoke(person, 1), { code: 'ERR_BUTLER_BUSY' }); }
  finally { t.mock.restoreAll(); }
  assert.equal(won, 1, 'A competing old O_EXCL writer must actually create the new canonical inode');
  assert.ok(same(fs.statSync(f.lock), legacy)); assert.equal(fs.statSync(f.lock).size, 0);
  assert.deepEqual(fs.readFileSync(f.role.file), before);
});

test('human authorization is checked before inspecting or reclaiming a typed lock', t => {
  const f = fixture(t); writeMarker(f); const before = fs.readFileSync(f.lock), open = fs.openSync; let inspected = 0;
  t.mock.method(fs, 'openSync', (file, ...args) => { if (file === f.lock) inspected++; return open(file, ...args); });
  try { for (const actor of [null, { kind: 'person' }, Symbol('synthetic person capability')]) assert.throws(() => f.role.revoke(actor, 1), { code: 'ERR_BUTLER_PERSON' }); }
  finally { t.mock.restoreAll(); }
  assert.equal(inspected, 0); assert.deepEqual(fs.readFileSync(f.lock), before);
});

test('recovering an abandoned typed lock still checks the expected selection revision before changing the record', DARWIN, t => {
  const f = fixture(t); writeMarker(f); const before = fs.readFileSync(f.role.file);
  assert.throws(() => f.role.revoke(person, 0), { code: 'ERR_BUTLER_REVISION' });
  assert.deepEqual(fs.readFileSync(f.role.file), before); assert.equal(f.role.snapshot().revision, 1);
  assert.equal(f.role.revoke(person, 1).revision, 2);
  assert.equal(fs.statSync(f.role.file).mode & 0o777, 0o600); assert.equal(fs.statSync(f.role.file).nlink, 1);
});
