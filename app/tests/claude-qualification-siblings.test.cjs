'use strict';
// Bug ③ (2026-11-23 18:11Z): a backend restarted for a new app version re-checks the
// installed Claude version; a session resumed during that check got an empty
// NAW_CLAUDE_QUALIFIED_VERSION and its plugin never bound the root, although a
// sibling backend of the same app had already passed the same binary.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const qualification = require('../claude-qualification.cjs');
const pin = require('../claude-pin.cjs');

const VERSION = '2.1.330', OWN = '0123456789abcdef0123', SIBLING = 'fedcba9876543210fedc';
const passMod = { exit: 0, fail: 0, pass: 74, tests: 74 };
const journeys = { 'solo-queue': true, 'shared-queue': true, 'shared-model': true };

function installation(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-qual-sibling-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'versions'));
  for (const version of ['2.1.327', VERSION]) fs.writeFileSync(path.join(root, 'versions', version), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const launcher = path.join(root, 'claude'); fs.symlinkSync(path.join(root, 'versions', VERSION), launcher);
  const backend = key => { const dir = path.join(root, 'data', 'backends', key); fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); return path.join(dir, 'claude-qualification.json'); };
  return { root, launcher, binary: path.join(root, 'versions', VERSION), own: backend(OWN), sibling: backend(SIBLING), backend };
}
function record(i, overrides = {}) {
  return { version: VERSION, reference: qualification.REFERENCE, binary: qualification.identity(i.binary), basis: qualification.basis(),
    at: '2026-01-01T00:00:00.000Z', status: 'passed', mod: passMod, journeys, ...overrides };
}
function checking(i) { qualification.save(i.own, { ...record(i), at: '2026-01-01T00:10:00.000Z', status: 'checking', mod: undefined, journeys: {} }); }

test('a resume during this backend\'s own check uses the sibling backend\'s passed check of the same binary and code', async t => {
  const i = installation(t);
  qualification.save(i.sibling, record(i));
  // The restarted backend's real check: its first save marks the version 'checking'.
  let finish; const held = new Promise(resolve => { finish = resolve; });
  const running = qualification.checkOnce({ file: i.own, binary: i.binary, version: VERSION, privateDir: i.root,
    runMod: async () => { await held; return passMod; }, runJourneys: async () => ({ passed: true, journeys }) });
  // The check's own 5-minute timer must not outlive a failed assertion.
  t.after(async () => { finish(); await running; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(qualification.load(i.own)[VERSION].status, 'checking');
  const selected = qualification.launch({ launcher: i.launcher, file: i.own });
  assert.deepEqual(selected.approvedVersions, [VERSION]);
  assert.equal(selected.qualifiedVersion, VERSION);
  // claude-pin then launches this exact version and adapters.cjs passes it as NAW_CLAUDE_QUALIFIED_VERSION.
  const launch = pin.choose({ ...selected, launcher: i.launcher, fresh: false, lastVersion: VERSION, lastWritten: VERSION, stateFile: path.join(i.root, 'pin.json') });
  assert.equal(launch.version, VERSION);
  assert.equal(selected.approvedVersions.includes(launch.version), true);
  finish(); await running;
  assert.equal(qualification.load(i.own)[VERSION].status, 'passed');
  assert.deepEqual(qualification.launch({ launcher: i.launcher, file: i.own }).approvedVersions, [VERSION]);
});

test('a sibling check is reused only for the same code basis, reference and binary identity', t => {
  for (const [name, overrides] of [['basis', { basis: '0'.repeat(64) }], ['reference', { reference: '2.1.323' }], ['binary', { binary: { file: 'x', dev: 0, ino: 0, size: 1, mtime: 0, ctime: 0 } }],
    ['status', { status: 'failed' }], ['journey', { journeys: { ...journeys, 'shared-model': false } }], ['mod', { mod: { ...passMod, fail: 1 } }], ['version', { version: '2.1.331' }]]) {
    const i = installation(t); checking(i);
    qualification.save(i.sibling, record(i, overrides));
    assert.deepEqual(qualification.launch({ launcher: i.launcher, file: i.own }).approvedVersions, [], name);
  }
});

test('this backend\'s own current failed check is not overridden by a sibling pass', t => {
  const i = installation(t);
  qualification.save(i.own, record(i, { status: 'failed', reason: 'shared-queue', journeys: { ...journeys, 'shared-queue': false } }));
  qualification.save(i.sibling, record(i));
  assert.deepEqual(qualification.launch({ launcher: i.launcher, file: i.own }).approvedVersions, []);
});

test('siblings are read only beside a backends/<20-hex key> data directory, from regular files of this user', t => {
  const i = installation(t);
  // A private directory outside the backends layout keeps its own records only.
  const loose = path.join(i.root, 'private', 'claude-qualification.json'); fs.mkdirSync(path.dirname(loose));
  qualification.save(i.sibling, record(i));
  assert.deepEqual(qualification.launch({ launcher: i.launcher, file: loose }).approvedVersions, []);
  // Another folder name under backends is not a backend.
  const j = installation(t); checking(j);
  const other = path.join(j.root, 'data', 'backends', 'not-a-backend'); fs.mkdirSync(other);
  qualification.save(path.join(other, 'claude-qualification.json'), record(j));
  assert.deepEqual(qualification.launch({ launcher: j.launcher, file: j.own }).approvedVersions, []);
  // A linked sibling record is ignored.
  const k = installation(t); checking(k);
  const elsewhere = path.join(k.root, 'elsewhere.json'); qualification.save(elsewhere, record(k));
  fs.symlinkSync(elsewhere, k.sibling);
  assert.deepEqual(qualification.launch({ launcher: k.launcher, file: k.own }).approvedVersions, []);
});

test('the session list shares the same approval as launch', t => {
  const i = installation(t); checking(i);
  qualification.save(i.sibling, record(i));
  assert.deepEqual(qualification.approvedVersions(i.own, path.join(i.root, 'versions')), [VERSION]);
});
