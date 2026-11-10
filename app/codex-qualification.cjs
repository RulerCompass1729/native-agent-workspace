// Codex version gates, one per capability (B3). Each static list is the set of
// exact versions that capability was qualified for by hand; together they
// reproduce the gates that used to be written inline. Automatic qualification
// can add a version for one capability only through allows(); quirk gates that
// exist for one old version's behaviour (adapters.cjs nativeUnsupportedTurns on
// 0.163, legacy-codex.cjs shared replies on 0.163, scoped-outbox-runtime.cjs
// terminal edits on 0.167) are not capabilities here and are never extended.
const STATIC = Object.freeze({
  // Outside history, turn metadata hydration and paged thread reads (native-history.cjs, adapters.cjs).
  history: Object.freeze(['0.163.0', '0.164.0', '0.165.0', '0.167.0']),
  // Input sent into the running native turn.
  steer: Object.freeze(['0.163.0', '0.164.0', '0.165.0', '0.167.0']),
  // The attached terminal goes through NAW's bridge instead of the raw socket.
  terminalBridge: Object.freeze(['0.163.0', '0.164.0', '0.165.0', '0.166.0', '0.167.0']),
  // Images forwarded from a shared space into a native turn.
  spaceImages: Object.freeze(['0.166.0', '0.167.0']),
  // The workspace message tool called from a native turn.
  addressedTool: Object.freeze(['0.164.0', '0.165.0', '0.166.0', '0.167.0']),
  // Automatic continuation after a capacity failure.
  capacity: Object.freeze(['0.164.0', '0.165.0', '0.166.0', '0.167.0']),
});
const CAPABILITIES = Object.freeze(Object.keys(STATIC));

// Decisions written by automatic qualification: version -> { capabilities: { name: true } }.
let automatic = Object.create(null);

function allows(capability, version) {
  if (!Object.hasOwn(STATIC, capability)) throw Error(`Unknown Codex capability ${capability}`);
  if (typeof version !== 'string') return false;
  return STATIC[capability].includes(version) || automatic[version]?.capabilities?.[capability] === true;
}
function setAutomatic(table) { automatic = Object.assign(Object.create(null), table || {}); }

// Automatic qualification (b3-spec.md section 1). A version newer than the baseline,
// the newest version qualified for every capability, is compared with the baseline's
// stored used surface. Zero model: the release's own schema generator runs under an
// empty private CODEX_HOME with a minimal environment and a timeout. Anything that
// fails is undecidable and leaves that version's gates closed, as before B3.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const surface = require('./codex-surface.cjs');
const BASELINE = '0.167.0';
const baselineFile = path.join(__dirname, 'codex-surface', `${BASELINE}.json`);
// Stored decisions are valid only for the baseline and manifest they were made against.
const basisSha = () => crypto.createHash('sha256').update(fs.readFileSync(baselineFile)).update(JSON.stringify([surface.MANIFEST, surface.VARIANTS, surface.PERMISSION])).digest('hex');
const semver = v => typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v);
const newer = (v, than) => { const a = v.split('.').map(Number), b = than.split('.').map(Number); for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]; return false; };
const needsCheck = version => semver(version) && newer(version, BASELINE) && !(version in automatic);

function run(binary, args, env, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { env, stdio: ['ignore', 'pipe', 'ignore'], detached: true });
    let out = '';
    child.stdout.on('data', chunk => { if (out.length < 4096) out += chunk; });
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} reject(Error('schema generator timed out')); }, timeoutMs);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => { clearTimeout(timer); code === 0 ? resolve(out) : reject(Error(`schema generator exited ${code}`)); });
  });
}
async function qualify({ binary, version, privateDir, timeoutMs = 60000 }) {
  const decidedAt = new Date().toISOString();
  if (!needsCheck(version)) return { version, basis: BASELINE, capabilities: {}, records: [{ kind: 'undecidable', reason: 'not a newer exact version' }], decidedAt };
  const work = fs.mkdtempSync(path.join(privateDir, 'codex-qualify-'));
  try {
    const home = path.join(work, 'home'), schema = path.join(work, 'schema');
    fs.mkdirSync(home, { mode: 0o700 }); fs.mkdirSync(schema, { mode: 0o700 });
    const env = { PATH: process.env.PATH || '/usr/bin:/bin', HOME: process.env.HOME || home, TMPDIR: work, LANG: process.env.LANG || 'C', CODEX_HOME: home };
    // The file at the server's path can be replaced by an updater; judge only the running version.
    const reported = (await run(binary, ['--version'], env, 15000)).trim().replace(/^codex-cli /, '');
    if (reported !== version) throw Error(`binary reports ${reported}, running server reports ${version}`);
    await run(binary, ['app-server', 'generate-json-schema', '--experimental', '--out', schema], env, timeoutMs);
    const decision = surface.decide(surface.unpack(JSON.parse(fs.readFileSync(baselineFile, 'utf8'))), surface.extract(schema, version));
    return { ...decision, method: 'schema', decidedAt };
  } catch (error) {
    return { version, basis: BASELINE, capabilities: {}, records: [{ kind: 'undecidable', reason: String(error.message).slice(0, 200) }], method: 'schema', decidedAt };
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}
const decided = d => !d.records.some(r => r.kind === 'undecidable');
// Load stored decisions for the current basis; returns them for inspection.
function load(file) {
  let stored = {};
  try { const doc = JSON.parse(fs.readFileSync(file, 'utf8')); if (doc.basisSha === basisSha()) stored = doc.decisions || {}; } catch {}
  setAutomatic(stored); return stored;
}
// Keep a decided result for its version. An undecidable result is kept only in memory,
// so the next start tries again.
function record(file, decision) {
  automatic[decision.version] = decision;
  if (!decided(decision)) return;
  const decisions = {}; for (const [v, d] of Object.entries(automatic)) if (decided(d)) decisions[v] = d;
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ version: 1, basisSha: basisSha(), decisions }, null, 1), { mode: 0o600 });
  fs.renameSync(temp, file);
}
const decision = version => automatic[version];

module.exports = { STATIC, CAPABILITIES, BASELINE, allows, setAutomatic, needsCheck, qualify, load, record, decision };
