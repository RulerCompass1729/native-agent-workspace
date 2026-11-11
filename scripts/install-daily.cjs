#!/usr/bin/env node
'use strict';
// Parameter-only candidate installer. No default app/profile and no implicit approval.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const assert = require('node:assert/strict');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const digest = file => sha(fs.readFileSync(file));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const errorRecord = e => ({ code: e.code || 'check-failed', message: e.message });
function atomic(file, bytes, mode = 0o600) {
  const tmp = file + '.' + crypto.randomUUID();
  const fd = fs.openSync(tmp, 'wx', mode);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  const dir = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}
function regular(file) {
  const s = fs.lstatSync(file);
  assert.ok(s.isFile() && s.uid === process.getuid(), 'Expected owned regular file');
  return s;
}
function pin(item) {
  assert.match(item.sha256, /^[a-f0-9]{64}$/); regular(item.path);
  assert.equal(digest(item.path), item.sha256, 'Pinned file changed: ' + path.basename(item.path));
}
function absolute(value) {
  assert.equal(typeof value, 'string'); assert.ok(path.isAbsolute(value));
  assert.equal(path.normalize(value), value); assert.notEqual(value, path.parse(value).root);
}
function disjoint(a, b) {
  assert.ok(a !== b && !a.startsWith(b + path.sep) && !b.startsWith(a + path.sep), 'Paths must not overlap');
}
function ownedDirectory(dir, privateOnly = false) {
  const s = fs.lstatSync(dir);
  assert.ok(s.isDirectory() && s.uid === process.getuid(), 'Expected owned directory');
  assert.equal(fs.realpathSync(dir), dir, 'Symlinked directory refused');
  if (privateOnly) assert.equal(s.mode & 0o077, 0, 'Private directory required');
}
function loadApproval(file, expectedHash, resultDir, apply) {
  assert.match(expectedHash, /^[a-f0-9]{64}$/); regular(file);
  const bytes = fs.readFileSync(file); assert.equal(sha(bytes), expectedHash, 'Approval document changed');
  const c = JSON.parse(bytes); assert.equal(c.format, 1);
  if (apply) assert.equal(c.applyAllowed, true, 'This candidate has no installation approval');
  assert.equal(c.operatorSha256, digest(__filename), 'Installer changed');
  for (const key of ['app', 'candidate', 'data', 'release', 'slot', 'resultDir']) absolute(c[key]);
  assert.equal(c.resultDir, resultDir, 'Result destination is not the approved one');
  for (const a of ['app', 'candidate', 'data', 'resultDir']) for (const b of ['app', 'candidate', 'data', 'resultDir']) if (a < b) disjoint(c[a], c[b]);
  for (const target of [c.app, c.candidate, c.data, c.release]) ownedDirectory(target, target === c.data);
  ownedDirectory(path.dirname(c.slot), true); ownedDirectory(resultDir, true);
  for (const key of ['app', 'candidate', 'data', 'resultDir']) disjoint(c.slot, c[key]);
  for (const app of [c.app, c.candidate]) assert.ok(app.endsWith('.app'));
  assert.match(c.bundleId, /^[a-zA-Z0-9.-]+$/);
  assert.match(c.executableName, /^[^/\x00-\x1f]+$/); assert.ok(!['.', '..'].includes(c.executableName));
  assert.match(c.commit, /^[a-f0-9]{40}$/);
  for (const v of [c.oldVersion, c.newVersion]) assert.match(v, /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/);
  assert.notEqual(c.oldVersion, c.newVersion);
  if (c.guiTimeoutMs !== undefined) assert.ok(Number.isSafeInteger(c.guiTimeoutMs) && c.guiTimeoutMs > 0 && c.guiTimeoutMs <= 20000, 'GUI wait exceeds bounded limit');
  for (const item of [...Object.values(c.code), c.swift, c.archive, c.previousArchive]) { absolute(item.path); pin(item); }
  assert.ok(c.coldLaunch, 'Reviewed cold-launch proof required');
  absolute(c.coldLaunch.path); pin(c.coldLaunch);
  const cold = JSON.parse(fs.readFileSync(c.coldLaunch.path));
  assert.equal(cold.pass, true, 'Cold-launch proof did not pass');
  assert.equal(cold.commit, c.commit, 'Cold-launch source mismatch');
  assert.equal(cold.cdhash, c.newSignature.cdhash, 'Cold-launch signature mismatch');
  c.executable = path.join(c.app, 'Contents/MacOS', c.executableName);
  return c;
}
function appVersion(app) { return JSON.parse(fs.readFileSync(path.join(app, 'Contents/Resources/app/package.json'))).version; }
function inventory(root) {
  const rows = [], device = fs.lstatSync(root).dev;
  assert.equal(device, fs.statSync(path.dirname(root)).dev, 'Mounted bundle refused');
  function walk(file, relative) {
    const s = fs.lstatSync(file);
    assert.equal(s.dev, device, 'Nested mount refused');
    if (s.isSymbolicLink()) rows.push({ path: relative, link: fs.readlinkSync(file), bytes: s.size });
    else if (s.isDirectory()) { rows.push({ path: relative, directory: true }); for (const name of fs.readdirSync(file).sort()) walk(path.join(file, name), path.join(relative, name)); }
    else { assert.ok(s.isFile(), 'Special file in app bundle'); rows.push({ path: relative, bytes: s.size, sha256: digest(file) }); }
  }
  walk(root, '.'); return rows;
}
function receiptSnapshot(file) {
  try { const s = regular(file); assert.equal(s.mode & 0o077, 0); return { bytes: fs.readFileSync(file), mode: s.mode & 0o777 }; }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
function restoreReceipt(file, before, written) {
  const current = receiptSnapshot(file);
  // Do not overwrite a receipt that another actor changed during this attempt.
  const bytes = current?.bytes ?? null;
  assert.ok((bytes === null && !before && !written) || Buffer.isBuffer(bytes) && [written, before?.bytes].some(value => Buffer.isBuffer(value) && bytes.equals(value)), 'Installation record changed concurrently');
  if (before) atomic(file, before.bytes, before.mode);
  else if (current) fs.unlinkSync(file);
  assert.deepEqual(receiptSnapshot(file)?.bytes ?? null, before?.bytes ?? null, 'Installation record restored');
}
async function runInstall(c, { platform, inspector, apply = false }) {
  const record = { format: 1, status: 'checking', stage: 'preflight', exposure: false, errors: [], startedAt: new Date().toISOString() };
  const result = path.join(c.resultDir, 'result.json'), journal = path.join(c.resultDir, 'journal.json');
  const rollback = path.join(c.resultDir, 'previous.app'), receipt = path.join(c.data, 'installation.json');
  let archiveAttempted = false;
  let lease = null, before = null, baseline = null, originalReceipt, writtenReceipt = null, quitRequested = false, movedOld = false;
  const save = () => atomic(journal, JSON.stringify(record, null, 2) + '\n');
  const stage = name => { record.stage = name; save(); };
  const instances = (checkArguments = false) => {
    const rows = platform.bundleApps();
    assert.ok(rows.every(r => r.executable === c.executable), 'Another copy of this application is running');
    assert.ok(rows.length <= 1, 'More than one application instance');
    if (checkArguments) for (const row of rows) platform.assertOrdinaryLaunch(row.pid);
    return rows;
  };
  async function waitGui(count) {
    const until = Date.now() + (c.guiTimeoutMs || 20000);
    do { const rows = instances(); if (rows.length === count && (count === 0 || rows.every(r => r.finishedLaunching))) return rows; await pause(250); } while (Date.now() < until);
    throw Error(count ? 'Application did not finish launching' : 'Application did not quit');
  }
  const verifyBundle = (app, version, expected) => {
    platform.run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
    assert.equal(appVersion(app), version, 'App version');
    const signature = platform.signature(app);
    assert.equal(signature.cdhash, expected.cdhash, 'Signed app changed');
    assert.equal(signature.requirement, expected.requirement, 'Signing requirement changed');
    const plist = key => platform.run('/usr/libexec/PlistBuddy', ['-c', 'Print :' + key, path.join(app, 'Contents/Info.plist')]).trim();
    assert.equal(plist('CFBundleIdentifier'), c.bundleId);
    assert.equal(plist('CFBundleExecutable'), c.executableName);
    if (version === c.newVersion) assert.equal(plist('NAWSourceRevision'), c.commit);
  };
  async function retireOldCopy() {
    if (!movedOld || !fs.existsSync(rollback)) return;
    assert.equal(archiveAttempted, false, 'Archive/remove is not retried'); archiveAttempted = true;
    const rows = platform.bundleApps();
    assert.ok(rows.every(r => !r.executable.startsWith(rollback + path.sep)), 'Old bundle is still running');
    platform.assertUnused(rollback);
    const contents = inventory(rollback), archive = path.join(c.resultDir, 'previous.zip');
    record.removal = { source: rollback, archive, files: contents.filter(r => !r.directory).length, bytes: contents.reduce((n, r) => n + (r.bytes || 0), 0) };
    atomic(path.join(c.resultDir, 'archived-files.json'), JSON.stringify(contents)); save();
    assert.ok(!fs.existsSync(archive), 'Archive destination already exists');
    platform.run('/usr/bin/ditto', ['-c', '-k', '--keepParent', rollback, archive]);
    platform.run('/usr/bin/unzip', ['-t', archive]);
    record.removal.archiveSha256 = digest(archive);
    assert.deepEqual(inventory(rollback), contents, 'Old bundle changed while archiving');
    save(); platform.assertUnused(rollback); fs.rmSync(rollback, { recursive: true });
    assert.ok(!fs.existsSync(rollback)); record.removal.removed = true; save();
  }
  try {
    save();
    platform.checkRelease(c);
    verifyBundle(c.app, c.oldVersion, c.oldSignature); verifyBundle(c.candidate, c.newVersion, c.newSignature);
    const gui = instances(true); before = await inspector.capture(); originalReceipt = receiptSnapshot(receipt);
    record.oldGuiPids = gui.map(r => r.pid); record.before = before.state;
    record.originalReceipt = originalReceipt ? { sha256: sha(originalReceipt.bytes), absent: false } : { sha256: null, absent: true };
    if (!apply) { record.status = 'check-passed'; }
    else {
      assert.equal(c.applyAllowed, true, 'Apply requires approval');
      fs.mkdirSync(c.slot); lease = crypto.randomUUID();
      fs.writeFileSync(path.join(c.slot, 'owner.json'), JSON.stringify({ pid: process.pid, token: lease, owner: 'reviewed-installer' }), { flag: 'wx', mode: 0o600 });
      const last = await inspector.capture(); inspector.retained(before, last);
      assert.deepEqual(instances(true).map(r => r.pid), record.oldGuiPids, 'GUI changed before quit');
      stage('quit-old'); quitRequested = true;
      if (gui.length) platform.quit(); await waitGui(0);
      baseline = await inspector.capture();
      // GUI shutdown may flush drafts; backend/native state must remain intact.
      inspector.retained({ ...last, views: baseline.views }, baseline);
      record.baseline = baseline.state; record.flushedViews = baseline.views;
      record.restartBackups = inspector.backUp(baseline);
      stage('swap');
      fs.renameSync(c.app, rollback); movedOld = true;
      fs.renameSync(c.candidate, c.app);
      verifyBundle(c.app, c.newVersion, c.newSignature);
      stage('installation-record');
      assert.deepEqual(receiptSnapshot(receipt)?.bytes ?? null, originalReceipt?.bytes ?? null, 'Installation record changed before write');
      regular(c.executable); const stat = fs.statSync(c.executable, { bigint: true });
      writtenReceipt = Buffer.from(JSON.stringify({ version: c.newVersion, commit: c.commit, installedAt: new Date().toISOString(), executable: { dev: stat.dev.toString(), ino: stat.ino.toString() } }) + '\n');
      atomic(receipt, writtenReceipt);
      assert.deepEqual(fs.readFileSync(receipt), writtenReceipt);
      // Persist BEFORE invoking LaunchServices: even a thrown open may have launched/written.
      record.exposure = true; stage('launch-new'); platform.open();
      const opened = await waitGui(1);
      assert.deepEqual(instances(true).map(r => r.pid), opened.map(r => r.pid), 'New GUI retained before verification');
      stage('verify-new');
      record.after = await inspector.verifyUpgrade(baseline);
      verifyBundle(c.app, c.newVersion, c.newSignature);
      assert.deepEqual(instances(true).map(r => r.pid), opened.map(r => r.pid), 'Verified GUI changed');
      record.newGuiPid = opened[0].pid; record.verificationPassed = true; record.status = 'installed';
      stage('archive-old'); await retireOldCopy();
    }
  } catch (error) {
    record.errors.push({ stage: record.stage, ...errorRecord(error) });
    if (!quitRequested) record.status = 'unchanged';
    else if (record.exposure) {
      record.status = 'recovery-required';
      record.recovery = record.verificationPassed ? 'New application and backend checks passed; only old-bundle cleanup is incomplete. Keep running the new version, retain the report and archive, and let the integrator resolve the cleanup error. Do not downgrade or restore stores.' : 'New code may have written storage. Do not launch the old archive or restore stores automatically. Preserve this report, installation record and all backend stores; have the integrator inspect identities and new writes, then obtain approval for a version-compatible recovery.';
      try { if (!archiveAttempted) await retireOldCopy(); } catch (e) { record.errors.push({ stage: 'archive-old', ...errorRecord(e) }); }
      record.launchableBackupNeedsAttention = fs.existsSync(rollback);
    } else {
      record.stage = 'restore-before-launch';
      try {
        await waitGui(0);
        if (movedOld) {
          if (fs.existsSync(c.app)) { assert.ok(!fs.existsSync(c.candidate), 'Candidate slot occupied'); fs.renameSync(c.app, c.candidate); }
          fs.renameSync(rollback, c.app);
        }
        restoreReceipt(receipt, originalReceipt, writtenReceipt); record.receiptRestored = true;
        verifyBundle(c.app, c.oldVersion, c.oldSignature);
        platform.open(); const old = await waitGui(1);
        assert.deepEqual(instances(true).map(r => r.pid), old.map(r => r.pid), 'Old GUI retained after recovery');
        inspector.retained(baseline || before, await inspector.capture());
        record.recoveredGuiPid = old[0].pid; record.status = 'rolled-back';
      } catch (e) {
        record.status = 'recovery-required'; record.errors.push({ stage: 'verify-rollback', ...errorRecord(e) });
        record.recovery = 'Pre-launch recovery failed. Preserve the report and stores. The integrator must verify the installed bundle, original receipt, backend identities and old GUI before trying another launch.';
      }
    }
  } finally {
    if (lease) {
      try { assert.equal(JSON.parse(fs.readFileSync(path.join(c.slot, 'owner.json'))).token, lease); fs.unlinkSync(path.join(c.slot, 'owner.json')); fs.rmdirSync(c.slot); }
      catch (e) { record.errors.push({ stage: 'release-slot', ...errorRecord(e) }); record.status = 'recovery-required'; }
    }
    record.finishedAt = new Date().toISOString();
    try { record.observed = { appVersion: fs.existsSync(c.app) ? appVersion(c.app) : null, gui: platform.bundleApps(), rollbackBundlePresent: fs.existsSync(rollback), installationSha256: fs.existsSync(receipt) ? digest(receipt) : null }; }
    catch (e) { record.observationError = errorRecord(e); }
    // A write failure propagates to the CLI, which reports persistence failure explicitly.
    try { atomic(result, JSON.stringify(record, null, 2) + '\n'); }
    catch (error) { error.installResult = record; throw error; }
  }
  return record;
}
async function main(args) {
  let resultDir, created = false;
  try {
    const options = {};
    for (let i = 0; i < args.length; i++) { if (args[i] === '--apply') options.apply = true; else { assert.ok(['--approval', '--approval-sha256', '--result-dir'].includes(args[i]), 'Unknown option'); assert.ok(!Object.hasOwn(options, args[i]), 'Duplicate option'); options[args[i]] = args[++i]; } }
    resultDir = options['--result-dir']; absolute(resultDir); ownedDirectory(path.dirname(resultDir), true);
    fs.mkdirSync(resultDir, { mode: 0o700 }); created = true;
    const c = loadApproval(options['--approval'], options['--approval-sha256'], resultDir, options.apply);
    const platform = require(c.code.platform.path).createPlatform(c);
    // No release code is loaded until the clean committed tree is checked.
    platform.checkRelease(c);
    const inspector = require(c.code.inspector.path).createInspector(c, platform);
    const record = await runInstall(c, { platform, inspector, apply: options.apply });
    console.log(JSON.stringify(record)); if (!['installed', 'check-passed'].includes(record.status)) process.exitCode = 1;
  } catch (error) {
    const record = error.installResult
      ? { ...error.installResult, outcomeStatus: error.installResult.status, status: 'result-write-failed', error: errorRecord(error) }
      : { format: 1, status: 'unchanged', error: errorRecord(error), at: new Date().toISOString() };
    if (created) {
      try { if (!fs.existsSync(path.join(resultDir, 'result.json'))) atomic(path.join(resultDir, 'result.json'), JSON.stringify(record, null, 2) + '\n'); }
      catch (writeError) { record.resultPersistenceError = errorRecord(writeError); }
    }
    console.error(JSON.stringify(record)); process.exitCode = 1;
  }
}
if (require.main === module) main(process.argv.slice(2));
module.exports = { runInstall, loadApproval, inventory, atomic, restoreReceipt, digest };
