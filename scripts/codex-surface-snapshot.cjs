// Writes the stored used-surface snapshot for one Codex release (B3). Zero model:
// the release's own `app-server generate-json-schema` runs under an empty CODEX_HOME.
// Usage: node scripts/codex-surface-snapshot.cjs <codex binary> <out.json>
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const surface = require('../app/codex-surface.cjs');
const [binary, out] = process.argv.slice(2);
if (!binary || !out) throw Error('usage: codex-surface-snapshot.cjs <codex binary> <out.json>');
const version = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim().replace(/^codex-cli /, '');
if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error(`Unexpected version ${version}`);
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-codex-surface-'));
try {
  const home = path.join(work, 'home'), schema = path.join(work, 'schema');
  fs.mkdirSync(home, { mode: 0o700 }); fs.mkdirSync(schema, { mode: 0o700 });
  // Same conditions as the runtime check: minimal environment, private home, no network.
  const env = { PATH: process.env.PATH, HOME: home, TMPDIR: work, LANG: 'C', CODEX_HOME: home };
  execFileSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)(deny network*)', binary, 'app-server', 'generate-json-schema', '--experimental', '--out', schema], { env, stdio: 'ignore', timeout: 60000 });
  const provenance = { upstream: 'https://github.com/openai/codex', license: 'Apache-2.0', version,
    generatedBy: 'codex app-server generate-json-schema --experimental', binarySha256: crypto.createHash('sha256').update(fs.readFileSync(fs.realpathSync(binary))).digest('hex'),
    notice: 'Only the parts of the Codex app-server protocol schema that NAW uses (app/codex-surface.cjs), descriptions dropped. Codex is Apache-2.0 (docs/licensing.md).' };
  fs.writeFileSync(out, JSON.stringify(surface.pack(surface.extract(schema, version), provenance)) + '\n');
  console.log(`${out}: ${version}, ${fs.statSync(out).size} bytes`);
} finally { fs.rmSync(work, { recursive: true, force: true }); }
