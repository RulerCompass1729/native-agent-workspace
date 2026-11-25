const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const { simulatedPerson, assertIsolated, touchesDaily } = require('../../scripts/fixtures/simulated-person.cjs');
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
  const load = env => spawnSync(process.execPath, ['-r', path.join(root, 'scripts/fixtures/rotation-clock.cjs'), '-e', ''], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', timeout: 20000 });
  assert.match(load({}).stderr, /isolated test only/);
  const lease = { NAW_TEST_PARENT_PID: '1', NAW_DATA_DIR: '/nonexistent', NAW_TEST_APP_ROOT: root };
  assert.equal(load({ ...lease, NAW_TEST_ROTATION_OPTIONS: '{"quietMs":20000}' }).status, 0);
  assert.match(load({ ...lease, NAW_TEST_ROTATION_OPTIONS: '{"humanQuietMs":0}' }).stderr, /rotation-clock: humanQuietMs/);
});

test('the daemon fixture is refused in any process but the test daemon on its private folder', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-person-')), profile = path.join(base, 'profile'), code = path.join(base, 'code');
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  fs.mkdirSync(profile, { mode: 0o700 }); fs.mkdirSync(path.join(code, 'app'), { recursive: true });
  const daemon = path.join(code, 'app/daemon.cjs'), other = path.join(base, 'other.cjs');
  for (const file of [daemon, other]) fs.writeFileSync(file, "console.log('started ' + Boolean(require('./app/adapters.cjs')))".replace('./app', file === other ? './code/app' : '.'));
  fs.writeFileSync(path.join(code, 'app/adapters.cjs'), 'exports.NativeHost = class { start() {} };');
  const load = (args, env = { NAW_TEST_APP_ROOT: code }) => spawnSync(process.execPath, ['-r', path.join(root, 'scripts/fixtures/rotation-daemon.cjs'), ...args], { env: { PATH: process.env.PATH, HOME: base, TMPDIR: os.tmpdir(), ...env }, encoding: 'utf8', timeout: 20000 });
  assert.equal(load([daemon, profile]).stdout, 'started true\n');
  for (const [args, env] of [[['-e', '']], [[other, profile]], [[daemon, profile], {}]]) assert.match(load(args, env).stderr, /isolated test daemon only/);
  for (const folder of [base, daily]) { const result = load([daemon, folder]); assert.match(result.stderr, /Refused: /); assert.equal(result.stdout, ''); }
  assert.match(load([daemon]).stderr, /Refused: no test profile/);
});

test('a simulated person is made only for the repository\'s own hidden app on its private folder', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-person-')), profile = path.join(base, 'profile');
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  fs.mkdirSync(profile, { mode: 0o700 });
  const exe = fs.realpathSync(require('electron')), hidden = { visible: false, focused: false };
  const app = change => ({ evaluate: async () => ({ packaged: false, userData: profile, exe, windows: [hidden], ...change }), firstWindow: async () => ({ page: true }) });
  const made = await simulatedPerson(app({}), profile, { snapshot: async () => ({}) });
  assert.deepEqual(made.page, { page: true });
  const refused = (change, folder = profile) => assert.rejects(simulatedPerson(app(change), folder, { snapshot: async () => ({}) }));
  await refused({ packaged: true }); await refused({ userData: base }); await refused({ windows: [] });
  await refused({ windows: [hidden, { visible: true, focused: false }] }); await refused({ windows: [{ visible: false, focused: true }] });
  await refused({ exe: process.execPath }); await refused({ userData: base }, base);
  await assert.rejects(simulatedPerson(app({ userData: daily }), daily, {}), /daily data folder/);
  await assert.rejects(simulatedPerson({ keyboard: {}, locator() {} }, profile, {}));
  assert.throws(() => new made.constructor({ keyboard: {} }, { snapshot: async () => ({}) }), /Refused/);
  assert.throws(() => new made.constructor(undefined, { keyboard: {} }, { snapshot: async () => ({}) }), /Refused/);
});

test('nothing in the product knows the simulated person', () => {
  const names = /simulated-person|rotation-clock|rotation-daemon|NAW_TEST_ROTATION_OPTIONS/;
  const files = fs.readdirSync(path.join(root, 'app'), { recursive: true, withFileTypes: true })
    .filter(file => file.isFile() && /\.(c?js|html)$/.test(file.name) && !path.relative(path.join(root, 'app'), file.parentPath).startsWith('tests'));
  assert.ok(files.length > 100);
  for (const file of files) assert.doesNotMatch(fs.readFileSync(path.join(file.parentPath, file.name), 'utf8'), names, file.name);
});
