'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { runInstall, restoreReceipt, loadApproval, digest } = require('../../scripts/install-daily.cjs');
function fixture(t, fault) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'installer-unit-'))); fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const c = { app: path.join(dir, 'App.app'), candidate: path.join(dir, 'Candidate.app'), data: path.join(dir, 'data'), resultDir: path.join(dir, 'results.noindex/result'), slot: path.join(dir, 'slot'), newVersion: '2.0.0', oldVersion: '1.0.0', commit: 'a'.repeat(40), bundleId: 'test.synthetic', executableName: 'app', guiTimeoutMs: 10, applyAllowed: true, oldSignature: { cdhash: 'old', requirement: 'old-signature' }, newSignature: { cdhash: 'new', requirement: 'new-signature' } };
  c.executable = path.join(c.app, 'Contents/MacOS/app');
  for (const [app, version] of [[c.app, c.oldVersion], [c.candidate, c.newVersion]]) {
    fs.mkdirSync(path.join(app, 'Contents/Resources/app'), { recursive: true }); fs.mkdirSync(path.join(app, 'Contents/MacOS'));
    fs.writeFileSync(path.join(app, 'Contents/Resources/app/package.json'), JSON.stringify({ version })); fs.writeFileSync(path.join(app, 'Contents/MacOS/app'), version);
  }
  fs.mkdirSync(c.data, { mode: 0o700 }); fs.mkdirSync(path.dirname(c.resultDir), { mode: 0o700 }); fs.mkdirSync(c.resultDir, { mode: 0o700 });
  const receipt = path.join(c.data, 'installation.json'), original = Buffer.from('{"version":"1.0.0","extra":"preserved"}\n');
  fs.writeFileSync(receipt, original, { mode: 0o600 });
  let running = true, captureCount = 0, openCount = 0;
  const platform = {
    checkRelease() {}, assertUnused() {}, assertOrdinaryLaunch() {},
    run(file, args) {
      if (file.endsWith('PlistBuddy')) return args[1].includes('CFBundleIdentifier') ? c.bundleId : args[1].includes('CFBundleExecutable') ? c.executableName : c.commit;
      if (file.endsWith('ditto')) fs.writeFileSync(args.at(-1), 'synthetic archive');
      return '';
    },
    signature(app) {
      const version = JSON.parse(fs.readFileSync(path.join(app, 'Contents/Resources/app/package.json'))).version;
      if (fault === 'pre-launch' && app === c.app && version === c.newVersion) throw Error('Installed signature failed');
      return version === c.newVersion ? c.newSignature : c.oldSignature;
    },
    bundleApps: () => running ? [{ pid: 123, executable: c.executable, finishedLaunching: true }] : [],
    quit() { running = false; },
    open() {
      openCount++; if (fault === 'open-throws') { fs.writeFileSync(path.join(c.data, 'new-write'), 'new storage'); throw Error('Launch returned an error after starting'); }
      if (fault === 'old-reopen-fails' || fault === 'new-crash') return;
      running = true;
    },
  };
  const inspector = {
    async capture() { captureCount++; return { state: { backend: 'preserved' }, views: ['draft'], view: {} }; },
    retained(a, b) { assert.deepEqual(a, b); }, backUp() { return []; },
    async verifyUpgrade() { if (['active-timeout', 'wrong-active', 'session', 'settings', 'draft', 'process'].includes(fault)) throw Error(fault); return { version: c.newVersion }; },
  };
  if (fault === 'old-reopen-fails') { const originalSignature = platform.signature; platform.signature = app => { if (app === c.app && JSON.parse(fs.readFileSync(path.join(app, 'Contents/Resources/app/package.json'))).version === c.newVersion) throw Error('Signature refused'); return originalSignature(app); }; }
  return { c, platform, inspector, receipt, original, dir, opened: () => openCount, captured: () => captureCount };
}
for (const fault of ['active-timeout', 'wrong-active', 'session', 'settings', 'draft', 'process', 'new-crash', 'open-throws']) {
  test('post-launch ' + fault + ' preserves new state, refuses downgrade and persists its terminal result', async t => {
    const f = fixture(t, fault), r = await runInstall(f.c, { ...f, apply: true });
    assert.equal(r.status, 'recovery-required'); assert.equal(r.exposure, true); assert.equal(f.opened(), 1);
    assert.equal(JSON.parse(fs.readFileSync(f.receipt)).version, f.c.newVersion);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.c.app, 'Contents/Resources/app/package.json'))).version, f.c.newVersion);
    assert.ok(!fs.existsSync(path.join(f.c.resultDir, 'rollback.noindex/previous.app')));
    assert.equal(r.removal.removed, true); assert.ok(fs.existsSync(r.removal.archive));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.c.resultDir, 'result.json'))), r);
    assert.match(r.recovery, /Do not launch the old archive/);
    if (fault === 'open-throws') assert.equal(fs.readFileSync(path.join(f.c.data, 'new-write'), 'utf8'), 'new storage');
  });
}
test('pre-launch failure restores exact receipt and verifies the old process plus backend state', async t => {
  const f = fixture(t, 'pre-launch'), r = await runInstall(f.c, { ...f, apply: true });
  assert.equal(r.status, 'rolled-back'); assert.equal(r.exposure, false); assert.equal(f.opened(), 1);
  assert.ok(f.captured() >= 4); assert.deepEqual(fs.readFileSync(f.receipt), f.original); assert.equal(r.recoveredGuiPid, 123); assert.equal(r.receiptRestored, true); assert.equal(r.originalReceipt.absent, false);
});
test('failed old relaunch is recovery-required, with both failure causes recorded', async t => {
  const f = fixture(t, 'old-reopen-fails'), r = await runInstall(f.c, { ...f, apply: true });
  assert.equal(r.status, 'recovery-required'); assert.equal(r.errors.length, 2);
  assert.match(r.errors[1].message, /did not finish launching/); assert.deepEqual(fs.readFileSync(f.receipt), f.original);
});
test('success removes the archived launchable copy, keeps archive and result', async t => {
  const f = fixture(t), r = await runInstall(f.c, { ...f, apply: true }); assert.equal(r.status, 'installed');
  assert.equal(r.observed.rollbackBundlePresent, false); assert.ok(fs.existsSync(r.removal.archive));
});
test('archive failure remains explicit and never claims clean success', async t => {
  const f = fixture(t, 'draft'); const run = f.platform.run;
  f.platform.run = (file, args) => { if (file.endsWith('ditto')) throw Object.assign(Error('Archive device full'), { code: 'ENOSPC' }); return run(file, args); };
  const r = await runInstall(f.c, { ...f, apply: true }); assert.equal(r.status, 'recovery-required');
  assert.equal(r.launchableBackupNeedsAttention, true); assert.equal(r.errors.at(-1).code, 'ENOSPC');
});
test('dry checks do not quit or replace anything', async t => {
  const f = fixture(t), r = await runInstall(f.c, f); assert.equal(r.status, 'check-passed'); assert.equal(f.opened(), 0);
  assert.deepEqual(fs.readFileSync(f.receipt), f.original); assert.ok(fs.existsSync(f.c.candidate));
});
test('foreign GUI copy refuses before quit', async t => {
  const f = fixture(t); f.platform.bundleApps = () => [{ pid: 321, executable: '/synthetic/other/app' }];
  assert.equal((await runInstall(f.c, { ...f, apply: true })).status, 'unchanged'); assert.equal(f.opened(), 0);
});
test('restoring a written receipt preserves bytes and absence, refuses concurrent edits', t => {
  const f = fixture(t), newer = Buffer.from('new'); fs.writeFileSync(f.receipt, newer);
  restoreReceipt(f.receipt, { bytes: f.original, mode: 0o600 }, newer); assert.deepEqual(fs.readFileSync(f.receipt), f.original);
  fs.writeFileSync(f.receipt, newer); restoreReceipt(f.receipt, null, newer); assert.equal(fs.existsSync(f.receipt), false);
  fs.writeFileSync(f.receipt, 'another actor', { mode: 0o600 }); assert.throws(() => restoreReceipt(f.receipt, { bytes: f.original, mode: 0o600 }, newer), /changed concurrently/);
});
test('approval document and helper are pinned before code can load', t => {
  const f = fixture(t), file = path.join(f.dir, 'approval.json'); fs.writeFileSync(file, JSON.stringify({ format: 1, applyAllowed: true }));
  const hash = digest(file); fs.appendFileSync(file, ' ');
  assert.throws(() => loadApproval(file, hash, f.c.resultDir, true), /Approval document changed/);
  fs.writeFileSync(file, JSON.stringify({ format: 1, applyAllowed: false }));
  assert.throws(() => loadApproval(file, digest(file), f.c.resultDir, true), /no installation approval/);
});
test('an occupied slot stays untouched and prevents the quit', async t => {
  const f = fixture(t); fs.mkdirSync(f.c.slot); fs.writeFileSync(path.join(f.c.slot, 'owner.json'), 'another-owner');
  const r = await runInstall(f.c, { ...f, apply: true }); assert.equal(r.status, 'unchanged'); assert.equal(f.opened(), 0);
  assert.equal(fs.readFileSync(path.join(f.c.slot, 'owner.json'), 'utf8'), 'another-owner');
});
test('changed Swift source is rejected using the independently pinned approval before any launch', t => {
  const f = fixture(t), c = f.c; fs.rmdirSync(c.resultDir);
  c.format = 1; c.release = path.join(f.dir, 'release'); fs.mkdirSync(c.release);
  c.operatorSha256 = digest(require.resolve('../../scripts/install-daily.cjs'));
  const filePin = (name, value) => { const file = path.join(f.dir, name); fs.writeFileSync(file, value); return { path: file, sha256: digest(file) }; };
  c.code = { platform: filePin('platform.cjs', 'unused'), inspector: filePin('inspector.cjs', 'unused') };
  c.swift = filePin('apps.swift', 'reviewed'); c.archive = filePin('new.zip', 'synthetic'); c.previousArchive = filePin('old.zip', 'synthetic-old');
  const approval = path.join(f.dir, 'approval.json'); fs.writeFileSync(approval, JSON.stringify(c)); const hash = digest(approval);
  fs.appendFileSync(c.swift.path, 'unreviewed');
  assert.throws(() => loadApproval(approval, hash, c.resultDir, true), /Pinned file changed: apps.swift/);
  assert.equal(f.opened(), 0); assert.deepEqual(fs.readFileSync(f.receipt), f.original);
  c.guiTimeoutMs = 60000; fs.writeFileSync(approval, JSON.stringify(c));
  assert.throws(() => loadApproval(approval, digest(approval), c.resultDir, true), /bounded limit/);
  c.guiTimeoutMs = 20; fs.writeFileSync(c.swift.path, 'reviewed'); fs.writeFileSync(approval, JSON.stringify(c));
  assert.throws(() => loadApproval(approval, digest(approval), c.resultDir, true), /cold-launch proof required/);
  c.coldLaunch = filePin('cold.json', JSON.stringify({ pass: true, commit: c.commit, cdhash: c.newSignature.cdhash }));
  fs.writeFileSync(approval, JSON.stringify(c)); assert.doesNotThrow(() => loadApproval(approval, digest(approval), c.resultDir, true));
  for (const delta of [{ pass: false }, { commit: 'b'.repeat(40) }, { cdhash: 'wrong' }]) {
    fs.writeFileSync(c.coldLaunch.path, JSON.stringify({ pass: true, commit: c.commit, cdhash: c.newSignature.cdhash, ...delta })); c.coldLaunch.sha256 = digest(c.coldLaunch.path);
    fs.writeFileSync(approval, JSON.stringify(c)); assert.throws(() => loadApproval(approval, digest(approval), c.resultDir, true), /Cold-launch/);
  }
  // All remaining checks run on a fully pinned otherwise valid approval.
  fs.writeFileSync(c.coldLaunch.path, JSON.stringify({ pass: true, commit: c.commit, cdhash: c.newSignature.cdhash })); c.coldLaunch.sha256 = digest(c.coldLaunch.path);
  const approve = () => { fs.writeFileSync(approval, JSON.stringify(c)); return () => loadApproval(approval, digest(approval), c.resultDir, true); };
  fs.mkdirSync(c.resultDir); assert.throws(approve(), /already exists/); fs.rmdirSync(c.resultDir);
  const approvedResult = c.resultDir;
  c.resultDir = path.join(f.dir, 'unindexed-result'); assert.throws(approve(), /under .noindex/); c.resultDir = approvedResult;
  const stat = fs.statSync;
  t.mock.method(fs, 'statSync', (file, ...args) => { const row = stat(file, ...args); return file === path.dirname(c.resultDir) ? { ...row, dev: row.dev + 1 } : row; });
  assert.throws(approve(), /same volume/); t.mock.restoreAll();
  const lstat = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', (file, ...args) => { if (file === c.resultDir) throw Object.assign(Error('Cannot inspect destination'), { code: 'EACCES' }); return lstat(file, ...args); });
  assert.throws(approve(), { code: 'EACCES' });

});
test('partial bundle removal failure never overwrites the already complete rollback archive', async t => {
  const f = fixture(t); let archived = 0; const run = f.platform.run;
  f.platform.run = (file, args) => { if (file.endsWith('ditto')) archived++; return run(file, args); };
  const remove = fs.rmSync;
  fs.rmSync = (file, options) => {
    if (file === path.join(f.c.resultDir, 'rollback.noindex/previous.app')) {
      const binary = path.join(file, 'Contents/MacOS/app'); if (fs.existsSync(binary)) fs.unlinkSync(binary);
      throw Object.assign(Error('Partial removal fault'), { code: 'EIO' });
    }
    return remove(file, options);
  };
  try {
    const r = await runInstall(f.c, { ...f, apply: true });
    assert.equal(r.status, 'recovery-required'); assert.equal(archived, 1); assert.equal(r.launchableBackupNeedsAttention, true);
  } finally { fs.rmSync = remove; }
});
test('result persistence failure carries the actual mutation/exposure status to the caller', async t => {
  const f = fixture(t, 'draft'), rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (to === path.join(f.c.resultDir, 'result.json')) throw Object.assign(Error('Result device full'), { code: 'ENOSPC' }); return rename(from, to); };
  try { await assert.rejects(runInstall(f.c, { ...f, apply: true }), e => e.code === 'ENOSPC' && e.installResult?.exposure === true && e.installResult?.status === 'recovery-required'); }
  finally { fs.renameSync = rename; }
});
test('an in-use old bundle is retained and explicitly reported, never removed', async t => {
  const f = fixture(t); f.platform.assertUnused = () => { throw Object.assign(Error('Bundle still mapped by a backend'), { code: 'bundle-in-use' }); };
  const r = await runInstall(f.c, { ...f, apply: true }); assert.equal(r.status, 'installed-cleanup-pending');
  assert.equal(r.verificationPassed, true); assert.equal(r.cleanup.reason, 'old-bundle-in-use');
  assert.equal(r.cleanup.status, 'pending'); assert.equal(r.observed.rollbackBundlePresent, true);
  assert.match(r.cleanup.path, /rollback\.noindex[/]previous\.app$/);
  assert.equal(r.errors.length, 0);
});
test('candidate-written installation receipt is accepted by the actual appBuildInfo reader', async t => {
  const f = fixture(t); const result = await runInstall(f.c, { ...f, apply: true }); assert.equal(result.status, 'installed');
  const module = { exports: {} }, source = fs.readFileSync(require.resolve('../preflight.cjs'), 'utf8');
  require('node:vm').runInNewContext(source, { module, process: { execPath: f.c.executable, getuid: process.getuid }, require(name) {
    if (name === 'node:child_process') return { execFile: (_cmd, _args, _options, reply) => reply(null, f.c.commit) };
    if (name === './platform.cjs' || name === './runtime-locations.cjs') return {};
    return require(name);
  } });
  const read = await module.exports.appBuildInfo({ getVersion: () => f.c.newVersion, isPackaged: true }, f.c.data);
  assert.equal(read.installedAt, JSON.parse(fs.readFileSync(f.receipt)).installedAt);
});
test('extra profile arguments refuse before quitting the old GUI', async t => {
  const f = fixture(t); f.platform.assertOrdinaryLaunch = () => { throw Error('Unexpected profile arguments'); };
  const r = await runInstall(f.c, { ...f, apply: true }); assert.equal(r.status, 'unchanged'); assert.equal(f.opened(), 0);
});
test('a stale NSWorkspace row during quit does not turn a normal update into rollback', async t => {
  const f = fixture(t), quit = f.platform.quit, open = f.platform.open, apps = f.platform.bundleApps;
  f.c.guiTimeoutMs = 1000;
  let quitting = false, stale = true;
  f.platform.quit = () => { quitting = true; quit(); };
  f.platform.open = () => { quitting = false; open(); };
  f.platform.bundleApps = () => {
    if (quitting && stale) { stale = false; return [{ pid: 123, executable: f.c.executable, finishedLaunching: true }]; }
    return apps();
  };
  f.platform.assertOrdinaryLaunch = () => { if (quitting) throw Error('ps process already gone'); };
  const r = await runInstall(f.c, { ...f, apply: true }); assert.equal(r.status, 'installed');
});


test('unknown bundle use remains a recovery failure rather than a pending-cleanup success', async t => {
  const f = fixture(t); f.platform.assertUnused = () => { throw Object.assign(Error('lsof timed out'), { code: 'bundle-use-unconfirmed' }); };
  const result = await runInstall(f.c, { ...f, apply: true });
  assert.equal(result.status, 'recovery-required'); assert.equal(result.verificationPassed, true);
  assert.equal(result.launchableBackupNeedsAttention, true);
});
test('a failed upgrade remains recovery-required even when old bundle use is confirmed', async t => {
  const f = fixture(t, 'draft'); f.platform.assertUnused = () => { throw Object.assign(Error('Still mapped'), { code: 'bundle-in-use' }); };
  const result = await runInstall(f.c, { ...f, apply: true });
  assert.equal(result.status, 'recovery-required'); assert.equal(result.verificationPassed, undefined);
  assert.equal(result.cleanup.status, 'pending'); assert.equal(result.observed.rollbackBundlePresent, true);
});
test('production lsof distinguishes confirmed use from unknown inspection and confirmed absence', t => {
  const cp = require('node:child_process'), { createPlatform } = require('../../scripts/install-platform.cjs');
  let answer;
  t.mock.method(cp, 'spawnSync', () => answer);
  const platform = createPlatform({});
  answer = { status: 0, stdout: 'p123\nn/synthetic/Old.app/Contents/MacOS/node\n', stderr: '' };
  assert.throws(() => platform.assertUnused('/synthetic/Old.app'), { code: 'bundle-in-use' });
  answer.status = 1; assert.throws(() => platform.assertUnused('/synthetic/Old.app'), { code: 'bundle-in-use' });
  for (answer of [{ status: null, error: Error('timeout') }, { status: 1, stdout: '', stderr: 'permission denied' }, { status: 0, stdout: 'malformed', stderr: '' }])
    assert.throws(() => platform.assertUnused('/synthetic/Old.app'), { code: 'bundle-use-unconfirmed' });
  answer = { status: 1, stdout: '', stderr: '' }; assert.doesNotThrow(() => platform.assertUnused('/synthetic/Old.app'));
});


for (const refusal of ['dialog', 65, 66]) test(`refused quit (${refusal}) changes no application or receipt`, async t => {
  const f = fixture(t), before = fs.statSync(f.receipt, { bigint: true });
  f.platform.quit = () => { if (refusal !== 'dialog') throw Object.assign(Error('Swift quit refused'), { status: refusal }); };
  const result = await runInstall(f.c, { ...f, apply: true });
  assert.equal(result.status, 'unchanged'); assert.equal(result.exposure, false); assert.equal(f.opened(), 0);
  assert.deepEqual(fs.readFileSync(f.receipt), f.original);
  const after = fs.statSync(f.receipt, { bigint: true }); assert.equal(after.ino, before.ino); assert.equal(after.mtimeNs, before.mtimeNs);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.c.app, 'Contents/Resources/app/package.json'))).version, f.c.oldVersion);
  assert.equal(result.receiptRestored, undefined); assert.equal(result.errors.length, 1);
});
test('receipt restore does not rewrite an already matching record', t => {
  const f = fixture(t), before = fs.statSync(f.receipt, { bigint: true });
  restoreReceipt(f.receipt, { bytes: f.original, mode: 0o600 }, null);
  const after = fs.statSync(f.receipt, { bigint: true }); assert.equal(after.ino, before.ino); assert.equal(after.mtimeNs, before.mtimeNs);
});

for (const reopenFails of [false, true]) test(`a quit error after the old GUI exited still verifies recovery (${reopenFails})`, async t => {
  const f = fixture(t, reopenFails ? 'old-reopen-fails' : undefined), quit = f.platform.quit;
  f.platform.quit = () => { quit(); throw Object.assign(Error('Quit acknowledgement lost'), { status: 66 }); };
  const result = await runInstall(f.c, { ...f, apply: true });
  assert.equal(result.status, reopenFails ? 'recovery-required' : 'rolled-back');
  assert.equal(f.opened(), 1); assert.deepEqual(fs.readFileSync(f.receipt), f.original);
});

for (const changed of ['backend', 'session']) test(`rollback refuses a recovered GUI whose ${changed} changed`, async t => {
  const f = fixture(t, 'pre-launch'), capture = f.inspector.capture;
  f.inspector.capture = async () => { const snapshot = await capture(); if (f.opened()) snapshot.state[changed] = 'different'; return snapshot; };
  const r = await runInstall(f.c, { ...f, apply: true });
  assert.equal(r.status, 'recovery-required'); assert.equal(r.errors.at(-1).stage, 'verify-rollback');
  assert.equal(r.recoveredGuiPid, undefined); assert.deepEqual(fs.readFileSync(f.receipt), f.original);
});
for (const permission of [false, undefined, 'true']) test(`runInstall refuses non-boolean approval (${permission}) before quit`, async t => {
  const f = fixture(t), stat = fs.statSync(f.receipt, { bigint: true }); let quits = 0;
  f.c.applyAllowed = permission; f.platform.quit = () => { quits++; };
  const r = await runInstall(f.c, { ...f, apply: true });
  assert.equal(r.status, 'unchanged'); assert.match(r.errors[0].message, /Apply requires approval/);
  assert.equal(quits, 0); assert.equal(f.opened(), 0); assert.equal(fs.existsSync(f.c.slot), false);
  assert.equal(fs.statSync(f.receipt, { bigint: true }).ino, stat.ino); assert.deepEqual(fs.readFileSync(f.receipt), f.original);
});
test('the production platform rehashes Swift before every list or quit use', t => {
  const f = fixture(t), cp = require('node:child_process'), { createPlatform } = require('../../scripts/install-platform.cjs');
  const source = path.join(f.dir, 'helper.swift'); fs.writeFileSync(source, 'reviewed');
  const platform = createPlatform({ swift: { path: source, sha256: digest(source) } }); let calls = 0;
  t.mock.method(cp, 'execFileSync', () => { calls++; return '[]'; });
  assert.deepEqual(platform.bundleApps(), []); assert.equal(calls, 1);
  fs.writeFileSync(source, 'changed');
  assert.throws(() => platform.quit(), { code: 'helper-pin-mismatch' });
  assert.throws(() => platform.bundleApps(), { code: 'helper-pin-mismatch' }); assert.equal(calls, 1);
});
test('receipt rename failure removes only its temporary file and verifies pre-launch recovery', async t => {
  const f = fixture(t), rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => { if (to === f.receipt) throw Object.assign(Error('Receipt rename failed'), { code: 'EIO' }); return rename(from, to); });
  const r = await runInstall(f.c, { ...f, apply: true });
  assert.equal(r.status, 'rolled-back'); assert.equal(r.exposure, false); assert.deepEqual(fs.readFileSync(f.receipt), f.original);
  assert.deepEqual(fs.readdirSync(f.c.data), ['installation.json']);
});
test('failure writing an empty new slot owner releases that exact slot', async t => {
  const f = fixture(t), write = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (file, ...rest) => { if (file === path.join(f.c.slot, 'owner.json')) throw Object.assign(Error('Owner write failed'), { code: 'ENOSPC' }); return write(file, ...rest); });
  const r = await runInstall(f.c, { ...f, apply: true });
  assert.equal(r.status, 'unchanged'); assert.equal(fs.existsSync(f.c.slot), false); assert.equal(f.opened(), 0);
});
test('results report the original and observed installation versions from the receipt', async t => {
  const f = fixture(t), r = await runInstall(f.c, { ...f, apply: true });
  assert.equal(r.originalReceipt.version, '1.0.0'); assert.equal(r.observed.installationVersion, '2.0.0');
  assert.equal(r.observed.installationSha256, digest(f.receipt));
});
test('CLI rejects untrusted approval before creating its result destination', t => {
  const f = fixture(t), cp = require('node:child_process'), approval = path.join(f.dir, 'invalid.json');
  fs.rmdirSync(f.c.resultDir); fs.writeFileSync(approval, '{}');
  const out = cp.spawnSync(process.execPath, [require.resolve('../../scripts/install-daily.cjs'), '--approval', approval, '--approval-sha256', 'a'.repeat(64), '--result-dir', f.c.resultDir, '--apply'], { encoding: 'utf8' });
  assert.equal(out.status, 1); assert.equal(JSON.parse(out.stderr).status, 'unchanged');
  assert.equal(fs.existsSync(f.c.resultDir), false); assert.deepEqual(fs.readFileSync(f.receipt), f.original);
});

test('atomic writes never remove a preexisting temporary name', t => {
  const f = fixture(t), crypto = require('node:crypto'), { atomic } = require('../../scripts/install-daily.cjs');
  t.mock.method(crypto, 'randomUUID', () => 'collision');
  const temp = f.receipt + '.collision'; fs.writeFileSync(temp, 'another writer');
  assert.throws(() => atomic(f.receipt, 'new'), { code: 'EEXIST' });
  assert.equal(fs.readFileSync(temp, 'utf8'), 'another writer'); assert.deepEqual(fs.readFileSync(f.receipt), f.original);
});
test('atomic write cleanup failures retain the original error and name the remaining temporary file', t => {
  const f = fixture(t), rename = fs.renameSync, unlink = fs.unlinkSync, { atomic } = require('../../scripts/install-daily.cjs');
  t.mock.method(fs, 'renameSync', (from, to) => { if (to === f.receipt) throw Object.assign(Error('rename failure'), { code: 'EIO' }); return rename(from, to); });
  t.mock.method(fs, 'unlinkSync', file => { if (file.startsWith(f.receipt + '.')) throw Object.assign(Error('cleanup failure'), { code: 'EACCES' }); return unlink(file); });
  assert.throws(() => atomic(f.receipt, 'new'), e => e.code === 'EIO' && e.temporaryCleanup.code === 'EACCES' && fs.existsSync(e.temporaryCleanup.path));
  assert.deepEqual(fs.readFileSync(f.receipt), f.original);
});
test('a slot owner write failure never deletes foreign contents that appeared in the slot', async t => {
  const f = fixture(t), write = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (file, ...rest) => {
    if (file === path.join(f.c.slot, 'owner.json')) { write(path.join(f.c.slot, 'foreign'), 'preserve'); throw Object.assign(Error('Owner write failed'), { code: 'ENOSPC' }); }
    return write(file, ...rest);
  });
  const r = await runInstall(f.c, { ...f, apply: true });
  assert.equal(r.status, 'recovery-required'); assert.equal(f.opened(), 0);
  assert.equal(fs.readFileSync(path.join(f.c.slot, 'foreign'), 'utf8'), 'preserve');
});
