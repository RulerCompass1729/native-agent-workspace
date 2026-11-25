const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const { assertIsolated, touchesDaily } = require('../../scripts/fixtures/simulated-person.cjs');
const daily = path.join(os.userInfo().homedir, 'Library', 'Application Support', 'Native Agent Workspace');
const runner = path.join(root, 'scripts/test-rotation-person.cjs');
function run(env) {
  const clean = { ...process.env };
  for (const key of Object.keys(clean)) if (/^NAW_/.test(key)) delete clean[key];
  return spawnSync(process.execPath, [runner, 'd'], { env: { ...clean, ...env }, encoding: 'utf8', timeout: 20000 });
}

test('the simulated person refuses the daily data folder and an installed app before anything starts', () => {
  for (const value of [daily, daily + '/', daily.toUpperCase(), path.join(daily, 'services'), path.dirname(daily)]) {
    assert.equal(touchesDaily(value), true, value);
    assert.throws(() => assertIsolated({ env: { NAW_DATA_DIR: value } }), /NAW_DATA_DIR is the daily data folder/);
  }
  assert.throws(() => assertIsolated({ env: { NAW_APP_EXECUTABLE: '/Applications/Native Agent Workspace.app/Contents/MacOS/x' } }), /names an app/);
  let result = run({ NAW_DATA_DIR: daily });
  assert.equal(result.status, 1); assert.match(result.stderr, /Refused: NAW_DATA_DIR is the daily data folder/); assert.equal(result.stdout, '');
  result = run({ NAW_APP_EXECUTABLE: '/Applications/Native Agent Workspace.app/Contents/MacOS/x' });
  assert.equal(result.status, 1); assert.match(result.stderr, /Refused: NAW_APP_EXECUTABLE/); assert.equal(result.stdout, '');
});

test('the simulated person accepts only its own private folder and the repository\'s Electron', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-person-')), profile = path.join(base, 'profile');
  const modules = path.join(base, 'code/node_modules/electron'), executable = path.join(modules, 'electron'), foreign = path.join(base, 'foreign');
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  fs.mkdirSync(profile, { mode: 0o700 }); fs.mkdirSync(modules, { recursive: true });
  for (const file of [executable, foreign]) fs.writeFileSync(file, '');
  const given = { profile, executable, code: path.join(base, 'code'), env: {} };
  assert.doesNotThrow(() => assertIsolated(given));
  assert.throws(() => assertIsolated({ ...given, executable: foreign }), /not the repository/);
  assert.throws(() => assertIsolated({ ...given, profile: base }), /private folder/);
  assert.throws(() => assertIsolated({ ...given, profile: daily }), /daily data folder/);
  if (fs.existsSync(daily)) {
    fs.symlinkSync(daily, path.join(base, 'link'));
    assert.throws(() => assertIsolated({ ...given, profile: path.join(base, 'link') }), /daily data folder/);
  }
  fs.chmodSync(profile, 0o755);
  assert.throws(() => assertIsolated(given), /private folder/);
});

test('the clock fixture needs a test lease and takes only the dispatcher\'s own quiet times', () => {
  const load = env => spawnSync(process.execPath, ['-r', path.join(root, 'scripts/fixtures/rotation-clock.cjs'), '-e', ''], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
  assert.match(load({}).stderr, /isolated test only/);
  const lease = { NAW_TEST_PARENT_PID: '1', NAW_DATA_DIR: '/nonexistent', NAW_TEST_APP_ROOT: root };
  assert.equal(load({ ...lease, NAW_TEST_ROTATION_OPTIONS: '{"quietMs":20000}' }).status, 0);
  assert.match(load({ ...lease, NAW_TEST_ROTATION_OPTIONS: '{"humanQuietMs":0}' }).stderr, /rotation-clock: humanQuietMs/);
});

test('nothing in the product knows the simulated person', () => {
  const names = /simulated-person|rotation-clock|rotation-daemon|NAW_TEST_ROTATION_OPTIONS/;
  const files = fs.readdirSync(path.join(root, 'app'), { recursive: true, withFileTypes: true })
    .filter(file => file.isFile() && /\.(c?js|html)$/.test(file.name) && !path.relative(path.join(root, 'app'), file.parentPath).startsWith('tests'));
  assert.ok(files.length > 100);
  for (const file of files) assert.doesNotMatch(fs.readFileSync(path.join(file.parentPath, file.name), 'utf8'), names, file.name);
});
