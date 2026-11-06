// Report-only retention planning. Requiring this module never starts a build,
// inspects an installed app, changes an archive, or authorizes deletion.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-alpha\.(0|[1-9]\d*)$/;
const PREFIX = 'native-agent-workspace-';
const SUFFIX = /-mac-arm64\.(zip|dmg)(\.sha256)?$/;
const MAX_ENTRIES = 4096;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function versionKey(version) {
  if (typeof version !== 'string') return null;
  const match = VERSION.exec(version);
  if (!match || match[0] !== version) return null;
  const key = match.slice(1).map(Number);
  return key.every(Number.isSafeInteger) ? key : null;
}
function artifactName(name) {
  if (typeof name !== 'string' || !name.startsWith(PREFIX)) return null;
  const match = SUFFIX.exec(name);
  if (!match || match.index + match[0].length !== name.length) return null;
  const version = name.slice(PREFIX.length, match.index), key = versionKey(version);
  return key ? { version, key, kind: match[1], checksum: Boolean(match[2]) } : null;
}
const identity = s => [s.dev, s.ino, s.mode, s.nlink, s.size, s.mtimeNs, s.ctimeNs].join(':');
const stat = file => fs.lstatSync(file, { bigint: true });
const regular = s => s.isFile() && s.nlink === 1n;

function namesAt(root) {
  const dir = fs.opendirSync(root), names = [];
  try {
    let entry;
    while ((entry = dir.readSync())) {
      if (names.length === MAX_ENTRIES) throw Error('entry-limit');
      names.push(entry.name);
    }
  } finally { dir.closeSync(); }
  return names.sort();
}

// Reads metadata only: not even checksum bodies are opened. The packaging
// operator supplies the four file digests. This observation is not an atomic lease.
function inventoryArtifacts(directory) {
  const result = { root: null, snapshotStable: false, errors: [], entries: [] };
  if (typeof directory !== 'string' || !directory.trim()) { result.errors.push('missing-root'); return result; }
  const root = path.resolve(directory); result.root = root;
  try {
    const initial = stat(root);
    if (!initial.isDirectory() || initial.isSymbolicLink() || fs.realpathSync(root) !== root) throw Error('noncanonical-root');
    result.rootIdentity = identity(initial);
    const names = namesAt(root);
    for (const name of names) {
      const file = path.join(root, name), s = stat(file), parsed = artifactName(name);
      const row = { name, identity: identity(s), regular: regular(s), stable: true,
        type: s.isSymbolicLink() ? 'symlink' : s.isDirectory() ? 'directory' : s.isFile() ? 'file' : 'other', bytes: String(s.size) };
      if (parsed) Object.assign(row, parsed);
      result.entries.push(row);
    }
    for (const row of result.entries) row.stable = identity(stat(path.join(root, row.name))) === row.identity;
    const finalNames = namesAt(root);
    result.snapshotStable = result.entries.every(row => row.stable) && identity(stat(root)) === result.rootIdentity &&
      names.length === finalNames.length && names.every((name, i) => name === finalNames[i]);
    if (!result.snapshotStable) result.errors.push('inventory-changed');
  } catch (error) { result.errors.push(error.code || error.message || 'inventory-unavailable'); }
  return result;
}

const own = (object, key) => object != null && Object.hasOwn(object, key);
function proofMatches(proofs, row, sha256) {
  const proof = own(proofs, row.name) && proofs[row.name];
  return proof && proof.identity === row.identity && proof.sha256 === sha256;
}

// Facts are explicit assertions by the packaging operator, bound to each file's
// observed identity. This function cannot establish their truth or make a plan
// safe to execute later. Unknown facts fail closed; there is no default N.
// Required facts: root/rootIdentity, buildSucceeded, policy:{approved,keepLatest},
// installed:{confirmed,version}, rollback:{verified,version}, pinnedVersions:[],
// newBuildVersion, verifiedFiles:{[basename]:{identity,sha256}}, and
// unoccupiedFiles:{[basename]:identity}. All versions use the complete canonical
// alpha version string. Digests cover BOTH archives AND their checksum files;
// checksum bytes must equal "<archive digest>  <archive basename>\n" exactly.
function planRetention(inventory, facts = {}) {
  if (!facts || typeof facts !== 'object' || Array.isArray(facts)) facts = {};
  const report = { reportOnly: true, root: inventory?.root || null, blockedBy: [], eligible: [], retained: [], ignored: [] };
  const block = reason => { if (!report.blockedBy.includes(reason)) report.blockedBy.push(reason); };
  if (inventory?.snapshotStable !== true || !Array.isArray(inventory.errors) || inventory.errors.length || typeof inventory.root !== 'string') block('stable-inventory-required');
  if (!inventory?.rootIdentity || facts.root !== inventory.root || facts.rootIdentity !== inventory.rootIdentity) block('root-proof-required');
  if (facts.buildSucceeded !== true) block('successful-whole-build-required');
  if (facts.policy?.approved !== true) block('approved-policy-required');
  const n = facts.policy?.keepLatest;
  if (!Number.isSafeInteger(n) || n < 1) block('explicit-retention-count-required');
  if (facts.installed?.confirmed !== true || !versionKey(facts.installed?.version)) block('current-installed-version-required');
  if (facts.rollback?.verified !== true || !versionKey(facts.rollback?.version)) block('verified-rollback-version-required');
  if (!Array.isArray(facts.pinnedVersions) || !facts.pinnedVersions.every(v => versionKey(v))) block('explicit-pinned-versions-required');
  if (!versionKey(facts.newBuildVersion)) block('new-build-version-required');
  if (!facts.verifiedFiles || typeof facts.verifiedFiles !== 'object' || Array.isArray(facts.verifiedFiles)) block('file-verification-required');
  if (!facts.unoccupiedFiles || typeof facts.unoccupiedFiles !== 'object' || Array.isArray(facts.unoccupiedFiles)) block('file-occupancy-required');
  const groups = new Map(), rows = Array.isArray(inventory?.entries) ? inventory.entries : [];
  if (!Array.isArray(inventory?.entries) || rows.length > MAX_ENTRIES) block('bounded-entries-required');
  for (const row of rows.slice(0, MAX_ENTRIES)) {
    if (!row || typeof row.name !== 'string') { block('invalid-entry'); continue; }
    const parsed = artifactName(row.name);
    if (!parsed) { report.ignored.push({ name: row.name, reason: 'nonstandard-or-directory' }); continue; }
    if (!groups.has(parsed.version)) groups.set(parsed.version, { version: parsed.version, key: parsed.key, files: [] });
    groups.get(parsed.version).files.push(row);
  }
  const complete = [];
  for (const group of groups.values()) {
    const files = group.files.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0), byName = new Map(files.map(row => [row.name, row]));
    const names = ['zip', 'dmg'].flatMap(kind => [`${PREFIX}${group.version}-mac-arm64.${kind}`, `${PREFIX}${group.version}-mac-arm64.${kind}.sha256`]);
    if (files.length !== 4 || names.some(name => !byName.has(name)) || files.some(row => row.regular !== true || row.type !== 'file' || row.stable !== true || typeof row.identity !== 'string' || !row.identity)) {
      group.reason = 'partial-or-unsafe-group'; report.retained.push(group); continue;
    }
    let verified = true, unoccupied = true;
    for (const kind of ['zip', 'dmg']) {
      const archive = byName.get(`${PREFIX}${group.version}-mac-arm64.${kind}`), checksum = byName.get(`${archive.name}.sha256`);
      const proof = own(facts.verifiedFiles, archive.name) && facts.verifiedFiles[archive.name], hash = proof?.sha256;
      verified = verified && Boolean(typeof hash === 'string' && hash.length === 64 && /^[a-f0-9]{64}$/.test(hash) &&
        proofMatches(facts.verifiedFiles, archive, hash) && proofMatches(facts.verifiedFiles, checksum, digest(`${hash}  ${archive.name}\n`)));
    }
    for (const row of files) unoccupied = unoccupied && Boolean(own(facts.unoccupiedFiles, row.name) && facts.unoccupiedFiles[row.name] === row.identity);
    if (!verified) block('file-verification-required');
    if (!unoccupied) block('file-occupancy-required');
    if (!verified || !unoccupied) { group.reason = 'verification-or-occupancy-unknown'; report.retained.push(group); continue; }
    complete.push(group);
  }
  if (!complete.some(group => group.version === facts.newBuildVersion)) block('verified-complete-new-build-required');
  const compare = (a, b) => { for (let i = 0; i < 4; i++) if (a.key[i] !== b.key[i]) return a.key[i] - b.key[i]; return 0; };
  complete.sort(compare);
  const protectedVersions = new Set([facts.installed?.version, facts.rollback?.version, facts.newBuildVersion,
    ...(Array.isArray(facts.pinnedVersions) ? facts.pinnedVersions : []), ...complete.slice(-Math.max(1, Number.isSafeInteger(n) ? n : complete.length)).map(group => group.version)]);
  for (const group of complete) {
    group.reason = report.blockedBy.length ? 'missing-required-facts' : protectedVersions.has(group.version) ? 'protected-version' : 'eligible-report-only';
    (group.reason === 'eligible-report-only' ? report.eligible : report.retained).push(group);
  }
  report.retained.sort(compare); report.eligible.sort(compare);
  report.ignored.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  report.protectedVersions = [...protectedVersions].filter(v => versionKey(v)).sort((a, b) => compare({ key: versionKey(a) }, { key: versionKey(b) }));
  report.limitations = ['report-only; no deletion authority', 'metadata snapshot is not an atomic lease', 'file verification and occupancy are supplied by the operator; recheck before any separately authorized action'];
  return report;
}

module.exports = { inventoryArtifacts, planRetention };
