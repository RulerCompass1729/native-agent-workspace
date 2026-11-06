const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createHash } = require('node:crypto');
const { inventoryArtifacts, planRetention } = require('../../scripts/artifact-retention.cjs');
const sha = data => createHash('sha256').update(data).digest('hex');
const version = n => `0.1.0-alpha.${n}`;
const name = (n, kind) => `native-agent-workspace-${version(n)}-mac-arm64.${kind}`;
function fixture(t, versions = [1, 2, 3, 8, 9, 10, 11, 12]) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'naw-retention-test-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const n of versions) for (const kind of ['zip', 'dmg']) {
    const file = name(n, kind), data = Buffer.from(`synthetic archive ${n} ${kind}`);
    fs.writeFileSync(path.join(dir, file), data);
    fs.writeFileSync(path.join(dir, `${file}.sha256`), `${sha(data)}  ${file}\n`);
  }
  return dir;
}
function factsFor(inventory) {
  const verifiedFiles = {}, unoccupiedFiles = {};
  for (const row of inventory.entries) if (row.regular && row.type === 'file') {
    const file = path.join(inventory.root, row.name);
    // Test operator verifies its own tiny synthetic files, not production dist.
    verifiedFiles[row.name] = { identity: row.identity, sha256: sha(fs.readFileSync(file)) };
    unoccupiedFiles[row.name] = row.identity;
  }
  return { root: inventory.root, rootIdentity: inventory.rootIdentity, buildSucceeded: true,
    policy: { approved: true, keepLatest: 3 }, installed: { confirmed: true, version: version(1) },
    rollback: { verified: true, version: version(2) }, pinnedVersions: [version(3)], newBuildVersion: version(12), verifiedFiles, unoccupiedFiles };
}
const eligible = report => report.eligible.map(group => group.version);
function snapshot(dir) {
  return fs.readdirSync(dir).sort().map(name => {
    const file = path.join(dir, name), s = fs.lstatSync(file, { bigint: true });
    return [name, String(s.ino), String(s.size), String(s.mtimeNs), s.isFile() ? sha(fs.readFileSync(file)) : s.isSymbolicLink() ? fs.readlinkSync(file) : 'directory'];
  });
}

test('report protects installed, verified rollback, pins, new build and numeric latest N; it never mutates files or inputs', t => {
  const dir = fixture(t), before = snapshot(dir), inventory = inventoryArtifacts(dir), facts = factsFor(inventory);
  const inputs = JSON.stringify({ inventory, facts }), report = planRetention(inventory, facts);
  assert.deepEqual(report.blockedBy, []);
  assert.deepEqual(eligible(report), [version(8), version(9)]);
  assert.deepEqual(report.protectedVersions, [version(1), version(2), version(3), version(10), version(11), version(12)]);
  assert.equal(report.reportOnly, true);
  assert.deepEqual(planRetention(inventory, facts), report);
  const reversed = { ...inventory, entries: [...inventory.entries].reverse() };
  assert.deepEqual(planRetention(reversed, facts), report);
  assert.equal(JSON.stringify({ inventory, facts }), inputs);
  assert.deepEqual(snapshot(dir), before);
});

test('unknown critical facts and unapproved N have no implicit defaults or eligible files', t => {
  const dir = fixture(t), inventory = inventoryArtifacts(dir), base = factsFor(inventory);
  for (const key of ['root', 'rootIdentity', 'buildSucceeded', 'policy', 'installed', 'rollback', 'pinnedVersions', 'newBuildVersion', 'verifiedFiles', 'unoccupiedFiles']) {
    const facts = structuredClone(base); delete facts[key]; const report = planRetention(inventory, facts);
    assert.deepEqual(eligible(report), [], key); assert.ok(report.blockedBy.length, key);
  }
  for (const policy of [{ keepLatest: 3 }, { approved: true }, { approved: false, keepLatest: 3 }, { approved: true, keepLatest: true }, { approved: true, keepLatest: 0 }, { approved: true, keepLatest: 1.5 }]) {
    assert.deepEqual(eligible(planRetention(inventory, { ...base, policy })), []);
  }
  for (const facts of [undefined, null, [], 'unknown']) assert.deepEqual(eligible(planRetention(inventory, facts)), []);
  for (const inv of [undefined, null, {}, { ...inventory, snapshotStable: 'true' }, { ...inventory, entries: [null] }]) assert.deepEqual(eligible(planRetention(inv, base)), []);
});

test('root version is never installed evidence; external installed and rollback identities are explicit', t => {
  const dir = fixture(t, [200, 201, 202]), inventory = inventoryArtifacts(dir), facts = factsFor(inventory);
  facts.newBuildVersion = version(202); facts.installed.version = version(204); facts.rollback.version = version(203); facts.pinnedVersions = [];
  const report = planRetention(inventory, facts);
  assert.deepEqual(report.blockedBy, []); assert.deepEqual(eligible(report), []);
  assert.ok(report.protectedVersions.includes(version(204))); assert.ok(report.protectedVersions.includes(version(203)));
  facts.installed.version = '204'; assert.deepEqual(eligible(planRetention(inventory, facts)), []);
  facts.installed.version = `${version(204)}\n`; assert.deepEqual(eligible(planRetention(inventory, facts)), []);
});

test('failed or partial new builds never enable an old-package plan', t => {
  const dir = fixture(t), archive = name(13, 'zip'); fs.writeFileSync(path.join(dir, archive), 'partial new zip');
  fs.writeFileSync(path.join(dir, `${archive}.sha256`), `${sha('partial new zip')}  ${archive}\n`);
  const inventory = inventoryArtifacts(dir), facts = factsFor(inventory); facts.newBuildVersion = version(13);
  assert.deepEqual(eligible(planRetention(inventory, facts)), []);
  facts.newBuildVersion = version(12); facts.buildSucceeded = false;
  assert.deepEqual(eligible(planRetention(inventory, facts)), []);
});

test('partial, orphan, unknown, noncanonical and directory entries are retained without recursion', t => {
  const dir = fixture(t), outside = path.join(dir, 'history'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, name(0, 'zip')), 'inside-history-do-not-read');
  fs.writeFileSync(path.join(dir, name(4, 'zip')), 'partial');
  fs.writeFileSync(path.join(dir, `${name(5, 'dmg')}.sha256`), 'orphan');
  for (const file of ['other.zip', name(6, 'zip') + '\n', 'native-agent-workspace-0.1.0-alpha.01-mac-arm64.zip', 'native-agent-workspace-0.1.0-mac-arm64.zip']) fs.writeFileSync(path.join(dir, file), 'unknown');
  const inventory = inventoryArtifacts(dir), report = planRetention(inventory, factsFor(inventory));
  assert.deepEqual(eligible(report), [version(8), version(9)]);
  assert.equal(inventory.entries.some(row => row.name.includes('history/')), false);
  assert.ok(report.retained.some(group => group.version === version(4)));
  assert.ok(report.retained.some(group => group.version === version(5)));
  assert.equal(report.ignored.length, 5);
});

test('symlinked root/ancestors, file symlinks and hardlinks cannot become candidates', t => {
  const dir = fixture(t), parent = fixture(t, []), link = path.join(parent, 'linked-root'); fs.symlinkSync(dir, link);
  assert.equal(inventoryArtifacts(link).snapshotStable, false);
  fs.mkdirSync(path.join(dir, 'child')); assert.equal(inventoryArtifacts(path.join(link, 'child')).snapshotStable, false);
  const symlink = path.join(dir, name(8, 'zip')), external = path.join(parent, 'private-target'); fs.writeFileSync(external, 'do-not-open');
  fs.unlinkSync(symlink); fs.symlinkSync(external, symlink);
  const hardlink = path.join(dir, name(9, 'dmg')); fs.linkSync(hardlink, path.join(parent, 'hardlink'));
  const inventory = inventoryArtifacts(dir), facts = factsFor(inventory), report = planRetention(inventory, facts);
  assert.deepEqual(eligible(report), []); assert.equal(fs.readFileSync(external, 'utf8'), 'do-not-open');
  assert.equal(inventory.entries.find(row => row.name === name(8, 'zip')).type, 'symlink');
});

test('archive verification and occupancy are identity-bound, including checksum files and root', t => {
  const dir = fixture(t), inventory = inventoryArtifacts(dir), base = factsFor(inventory);
  for (const kind of ['zip', 'dmg', 'zip.sha256', 'dmg.sha256']) {
    const file = name(8, kind);
    for (const edit of [facts => { delete facts.verifiedFiles[file]; }, facts => { facts.verifiedFiles[file].identity += ':old'; }, facts => { facts.verifiedFiles[file].sha256 = '0'.repeat(64); }, facts => { delete facts.unoccupiedFiles[file]; }, facts => { facts.unoccupiedFiles[file] += ':old'; }]) {
      const facts = structuredClone(base); edit(facts); const report = planRetention(inventory, facts);
      assert.deepEqual(eligible(report), []); assert.ok(report.blockedBy.length);
    }
  }
  assert.deepEqual(eligible(planRetention(inventory, { ...base, root: path.dirname(dir) })), []);
});

test('malformed, wrong-basename, oversized and non-ASCII checksum content fails closed', t => {
  for (const invalid of ['bad\n', `${'0'.repeat(64)}  ../other.zip\n`, 'x'.repeat(513), `${'0'.repeat(64)}  ${name(8, 'zip')}\n\n`, Buffer.from([255, 0])]) {
    const dir = fixture(t); fs.writeFileSync(path.join(dir, `${name(8, 'zip')}.sha256`), invalid);
    const inventory = inventoryArtifacts(dir), report = planRetention(inventory, factsFor(inventory));
    assert.deepEqual(eligible(report), []); assert.ok(report.blockedBy.includes('file-verification-required'));
  }
});

test('changed file identity or directory contents during inventory yields no plan', t => {
  for (const change of ['file', 'directory']) {
    const dir = fixture(t), original = fs.lstatSync; let changed = false;
    try {
      fs.lstatSync = function (...args) {
        const observed = original.apply(this, args), target = String(args[0]);
        if (!changed && path.dirname(target) === dir) { changed = true; fs.writeFileSync(change === 'file' ? target : path.join(dir, 'new-file'), 'changed'); }
        return observed;
      };
      const inventory = inventoryArtifacts(dir);
      assert.equal(inventory.snapshotStable, false);
      assert.deepEqual(eligible(planRetention(inventory, {})), []);
    } finally { fs.lstatSync = original; }
  }
});

test('inventory never opens either archive or checksum bodies', t => {
  const dir = fixture(t), open = fs.openSync, read = fs.readFileSync;
  try {
    fs.openSync = fs.readFileSync = () => { throw Error('unexpected-file-body-open'); };
    const inventory = inventoryArtifacts(dir);
    assert.equal(inventory.snapshotStable, true); assert.deepEqual(inventory.errors, []);
  } finally { fs.openSync = open; fs.readFileSync = read; }
});

test('entry cap and unreadable/missing roots fail closed rather than recursing or allocating unbounded metadata', t => {
  const dir = fixture(t, []);
  for (let i = 0; i < 4097; i++) fs.writeFileSync(path.join(dir, `unknown-${i}`), '');
  const inventory = inventoryArtifacts(dir); assert.equal(inventory.snapshotStable, false); assert.ok(inventory.errors.includes('entry-limit'));
  assert.equal(inventoryArtifacts(path.join(dir, 'absent')).snapshotStable, false);
  assert.equal(inventoryArtifacts('').snapshotStable, false);
});
