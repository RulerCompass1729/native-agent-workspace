'use strict';
// Bug ③ (2026-11-23 18:11Z): a backend restarted for a new app version re-checks the
// installed Claude version; a session resumed during that check got an empty
// NAW_CLAUDE_QUALIFIED_VERSION and its plugin never bound the root, although a
// sibling backend of the same app had already passed the same binary.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const qualification = require('../claude-qualification.cjs');
const pin = require('../claude-pin.cjs');

const VERSION = '2.1.330', OWN = '0123456789abcdef0123', SIBLING = 'fedcba9876543210fedc', THIRD = '00112233445566778899';
const passMod = { exit: 0, fail: 0, pass: 74, tests: 74 }, failMod = { exit: 1, fail: 1, pass: 73, tests: 74 };
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
// The restarted backend's own check; a real check answers quickly here with a failing mod run.
function check(i, file = i.own) {
  const calls = [];
  const running = qualification.checkOnce({ file, binary: i.binary, version: VERSION, privateDir: i.root,
    runMod: async () => { calls.push('mod'); return failMod; }, runJourneys: async () => ({ passed: true, journeys }) });
  return { running, calls };
}
const approved = (i, file = i.own) => qualification.launch({ launcher: i.launcher, file }).approvedVersions;

test('a restarted backend takes the sibling backend\'s pass of the same binary and code before its sessions resume', async t => {
  const i = installation(t);
  qualification.save(i.sibling, record(i));
  const { running, calls } = check(i);
  // Same tick as the check's start: the daemon only listens after host.start, so no resume comes earlier.
  assert.deepEqual(approved(i), [VERSION]);
  const selected = qualification.launch({ launcher: i.launcher, file: i.own });
  assert.equal(selected.qualifiedVersion, VERSION);
  // claude-pin then launches this exact version and adapters.cjs passes it as NAW_CLAUDE_QUALIFIED_VERSION.
  const launch = pin.choose({ ...selected, launcher: i.launcher, fresh: false, lastVersion: VERSION, lastWritten: VERSION, stateFile: path.join(i.root, 'pin.json') });
  assert.equal(launch.version, VERSION);
  assert.equal((await running).status, 'passed');
  assert.deepEqual(calls, [], 'No second check of what the sibling already checked');
  assert.equal(qualification.load(i.own)[VERSION].status, 'passed');
});

test('a sibling check is taken only for the same code basis, reference and binary identity, and only when it passed', async t => {
  for (const [name, overrides] of [['basis', { basis: '0'.repeat(64) }], ['reference', { reference: '2.1.323' }], ['binary', { binary: { file: 'x', dev: 0, ino: 0, size: 1, mtime: 0, ctime: 0 } }],
    ['checking', { status: 'checking', mod: undefined, journeys: {} }], ['journey', { journeys: { ...journeys, 'shared-model': false } }], ['mod', { mod: { ...passMod, fail: 1 } }], ['version', { version: '2.1.331' }]]) {
    const i = installation(t);
    qualification.save(i.sibling, record(i, overrides));
    const { running, calls } = check(i);
    assert.deepEqual(approved(i), [], name);
    assert.equal((await running).status, 'failed', name);
    assert.deepEqual(calls, ['mod'], `${name}: checked here`);
  }
});

test('this backend\'s own result stands, and any sibling\'s current failure means checking here', async t => {
  const own = installation(t);
  qualification.save(own.own, record(own, { status: 'failed', reason: 'shared-queue', journeys: { ...journeys, 'shared-queue': false } }));
  qualification.save(own.sibling, record(own));
  const mine = check(own);
  assert.equal((await mine.running).reason, 'shared-queue');
  assert.deepEqual(approved(own), []);
  for (const [reason, adopted] of [['shared-queue', false], ['mod-tests', false], ['timed-out', true], ['cancelled', true]]) {
    const i = installation(t);
    qualification.save(i.sibling, record(i));
    qualification.save(i.backend(THIRD), record(i, { status: 'failed', reason, at: '2026-01-02T00:00:00.000Z' }));
    const { running, calls } = check(i);
    assert.deepEqual(approved(i), adopted ? [VERSION] : [], reason);
    await running;
    assert.deepEqual(calls, adopted ? [] : ['mod'], reason);
  }
});

test('siblings are read only beside a backends/<20-hex key> data directory, from regular files of this user', async t => {
  const i = installation(t);
  qualification.save(i.sibling, record(i));
  // A private directory outside the backends layout keeps its own records only.
  const loose = path.join(i.root, 'private', 'claude-qualification.json'); fs.mkdirSync(path.dirname(loose));
  const outside = check(i, loose);
  assert.deepEqual(approved(i, loose), []); await outside.running; assert.deepEqual(outside.calls, ['mod']);
  // Another folder name under backends is not a backend.
  const j = installation(t);
  const other = path.join(j.root, 'data', 'backends', 'not-a-backend'); fs.mkdirSync(other);
  qualification.save(path.join(other, 'claude-qualification.json'), record(j));
  const named = check(j);
  assert.deepEqual(approved(j), []); await named.running; assert.deepEqual(named.calls, ['mod']);
  // A linked sibling record is ignored.
  const k = installation(t);
  const elsewhere = path.join(k.root, 'elsewhere.json'); qualification.save(elsewhere, record(k));
  fs.symlinkSync(elsewhere, k.sibling);
  const linked = check(k);
  assert.deepEqual(approved(k), []); await linked.running; assert.deepEqual(linked.calls, ['mod']);
});

test('the session list and launch read only this backend\'s own records', t => {
  const i = installation(t);
  qualification.save(i.sibling, record(i));
  assert.deepEqual(qualification.approvedVersions(i.own, path.join(i.root, 'versions')), []);
  assert.deepEqual(approved(i), []);
});
