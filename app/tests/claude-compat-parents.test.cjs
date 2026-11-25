const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { installPlugin } = require('../claude-compat-plugin.cjs');

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-compat-parents-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  return { cwd, file: path.join(cwd, '.claude/skills/native-workspace-compat/hooks/register.js') };
}

// The combined bridge differs from both reviewed parents. Both exact managed
// outputs must remain upgradeable; a modified copy must still fail closed.
for (const commit of ['94840d46b08ae225c73b6bbac59fe5d452e34bf7', '7a3138f3738ad17043402f118ea402c21bedf42a']) for (const existingOnly of [false, true])
test(`PF08 integration: parent ${commit} upgrades with existingOnly=${existingOnly}`, t => {
  const { cwd, file } = fixture(t);
  installPlugin(cwd);
  const current = fs.readFileSync(file, 'utf8');
  const prior = execFileSync('git', ['show', `${commit}:app/claude-bridge/hooks/register.js`],
    { cwd: path.resolve(__dirname, '../..'), encoding: 'utf8' })
    .replace('const legacyOnly = false;', 'const legacyOnly = true;');
  fs.writeFileSync(file, prior);
  assert.equal(installPlugin(cwd, { existingOnly }), true);
  assert.equal(fs.readFileSync(file, 'utf8'), current);

  const edited = prior + '\n// Synthetic user customization\n';
  fs.writeFileSync(file, edited);
  assert.throws(() => installPlugin(cwd, { existingOnly }),
    error => error.uiMessage?.key === 'error.legacy.pluginConflict');
  assert.equal(fs.readFileSync(file, 'utf8'), edited);
});

test('PF08 integration: fresh install and edited-current protection stay intact', t => {
  const { cwd, file } = fixture(t);
  assert.equal(installPlugin(cwd), true);
  const edited = fs.readFileSync(file, 'utf8') + '\n// Synthetic user customization\n';
  fs.writeFileSync(file, edited);
  assert.throws(() => installPlugin(cwd),
    error => error.uiMessage?.key === 'error.legacy.pluginConflict');
  assert.equal(fs.readFileSync(file, 'utf8'), edited);
});

// The installed alpha.261 commit has the byte-identical hook from c08b56a3.
// Use that main ancestor so this fixture survives a clone without release refs.
// These digests were obtained from the historical outputs, not the working tree.
for (const parent of [
  { commit: '907f10a06a2880c15d4e4ef1f1e5a348548ad832', digest: 'c41614cb3c81aa10d7a7b7efe2068ce73aa1546edb1a72fac5ce03d352b1b0ca', label: 'automatic qualification integration: main with workspace_open view' },
  { commit: 'c08b56a3bb49b1f59ca21acee6ea28909df29490', digest: 'eaaa169a4620cd888fbba1d0663b9aa094ff92bbf19b3b78cc56d5451df98991', label: 'automatic qualification integration: installed alpha.261 output' },
  { commit: 'bbbd56fe2f4f2e3ceedd815d60d4d8eb0d6835ea', digest: '7233253cb5c7adcfafef8d9d7ea3ae6ff48afc26840e3a800f18d828a9ef93b6', label: 'compacted turn continuation: main before it' },
  { commit: '6a4b015c027a096a1fa193e5a87e545e5baba9cb', digest: '697dd950a622376d572e7f5dfea291162598cab3b277c3da0f3a5a14db1e75d5', label: 'refused root call report: alpha.286 lane before it' },
  { commit: '3405e65e605e48dbcda513f62b864fe059f29362', digest: 'f96af19e64b8b7efe02dd813b9d584c0367b75e2afa27bb7b64fcad89950be1e', label: 'refused workspace_message report: lane before it' },
  { commit: '77c10ff80e5b5b6b7207eaa5e7fb8ba7547c6c4d', digest: 'eec3fa5fad09c7ca208c7f89f80ae73c8ddb1872a580f9eebe9e0dfee9c2b858', label: 'chosen model report: main before it' },
]) for (const existingOnly of [false, true])
test(`${parent.label} upgrades with existingOnly=${existingOnly}; one byte edits stay`, t => {
  const { cwd, file } = fixture(t);
  installPlugin(cwd); const current = fs.readFileSync(file);
  const prior = Buffer.from(execFileSync('git', ['show', `${parent.commit}:app/claude-bridge/hooks/register.js`],
    { cwd: path.resolve(__dirname, '../..'), encoding: 'utf8' })
    .replace('const legacyOnly = false;', 'const legacyOnly = true;'));
  assert.equal(require('node:crypto').createHash('sha256').update(prior).digest('hex'), parent.digest);
  assert.notDeepEqual(prior, current);
  fs.writeFileSync(file, prior);
  assert.equal(installPlugin(cwd, { existingOnly }), true);
  assert.deepEqual(fs.readFileSync(file), current);

  const edited = Buffer.concat([prior, Buffer.from(' ')]);
  assert.equal(edited.length, prior.length + 1);
  fs.writeFileSync(file, edited);
  assert.throws(() => installPlugin(cwd, { existingOnly }),
    error => error.uiMessage?.key === 'error.legacy.pluginConflict');
  assert.deepEqual(fs.readFileSync(file), edited);
});

for (const existingOnly of [false, true])
test(`automatic qualification integration: unknown hook code is refused with existingOnly=${existingOnly}`, t => {
  const { cwd, file } = fixture(t);
  installPlugin(cwd);
  const unknown = Buffer.from('// Synthetic unknown hook, not a managed historical output\n');
  fs.writeFileSync(file, unknown);
  assert.throws(() => installPlugin(cwd, { existingOnly }),
    error => error.uiMessage?.key === 'error.legacy.pluginConflict');
  assert.deepEqual(fs.readFileSync(file), unknown);
});
