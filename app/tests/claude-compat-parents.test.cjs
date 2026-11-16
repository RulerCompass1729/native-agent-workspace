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
