'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const main = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8');
const start = main.indexOf("const normalDataDir = app.getPath('userData');"), end = main.indexOf('// NAW_TEST_VISIBLE=1', start);
assert.ok(start >= 0 && end > start);
const bootstrap = main.slice(start, end);
const sameDirectory = (a, b) => a.dev === b.dev && a.ino === b.ino;
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-profile-identity-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const normal = path.join(directory, 'NormalProfileFixture'), isolated = path.join(directory, 'IsolatedProfileFixture');
  fs.mkdirSync(normal, { mode: 0o700 }); fs.mkdirSync(isolated, { mode: 0o700 });
  return { directory, normal, isolated };
}
function run(normal, profile, options = {}) {
  const env = options.noFlags ? {} : { NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: '321', NAW_TEST_BUTLER_ENTRY: '1', NAW_TEST_INTEGRATION_HANDOFF: '1' };
  if (options.noFlags && options.ordinaryDataDir) env.NAW_DATA_DIR = options.ordinaryDataDir;
  if (options.homeEnv) env.HOME = options.homeEnv;
  let runtimeProfile = normal, runtimeSessionPath = normal;
  const setPaths = [], sessionSetPaths = [];
  const context = { fs, path, Object, Number, Boolean, console: { error(message) { options.onError?.(message); } }, os: {
    userInfo() { options.onUserInfo?.(); if (options.userInfoError) throw Error('Synthetic OS account lookup failure');
      return { homedir: Object.hasOwn(options, 'osHome') ? options.osHome : path.join(path.dirname(normal), 'SyntheticOSHome') }; },
    homedir() { throw Error('Environment-derived home must not define the normal reference'); },
  }, app: {
    commandLine: { hasSwitch(name) { assert.equal(name, 'user-data-dir'); options.onHasSwitch?.(); return Object.hasOwn(options, 'userDataSwitch'); },
      getSwitchValue() { throw Error('A test startup must reject the switch without reading its value'); } },
    getName() { options.onGetName?.(); return options.appName || 'Native Agent Workspace'; },
    getPath(name) { if (name === 'sessionData') return runtimeSessionPath;
      assert.equal(name, 'userData'); if (options.getPathError) throw options.getPathError; return runtimeProfile; },
    setPath(name, value) {
      if (name === 'sessionData') { options.onSessionPin?.(); if (options.sessionPinError) throw Error('Synthetic Session pin failure');
        sessionSetPaths.push(value); runtimeSessionPath = value; return; }
      assert.equal(name, 'userData'); if (options.pinError && setPaths.length) throw Error('Synthetic pin failure'); setPaths.push(value); runtimeProfile = value;
    },
  }, process: { env, platform: options.platform || 'darwin', ppid: options.parent ?? 321, getuid: options.noUid ? undefined : () => options.owner ?? process.getuid(),
    exit(status) { assert.equal(status, 1); throw Object.assign(Error('isolated-startup-refused'), { code: 'SYNTHETIC_EXIT' }); } } };
  return { ...vm.runInNewContext(bootstrap + '\n({ backgroundTest, butlerEntryEnabled });', context),
    runtimeProfile: context.app.getPath('userData'), runtimeSessionPath: context.app.getPath('sessionData'), setPaths, sessionSetPaths };
}
function realAliases(normal) {
  const candidates = [path.join(path.dirname(normal), path.basename(normal).toLowerCase()), '/System/Volumes/Data' + normal];
  return candidates.flatMap((alias, index) => {
    try {
      if (!sameDirectory(fs.statSync(normal), fs.statSync(alias))) return [];
      return [{ alias, caseAlias: index === 0, distinctRealpath: fs.realpathSync(normal) !== fs.realpathSync(alias) }];
    } catch { return []; }
  });
}

test('the actual startup rejects real same-inode case and Data-volume aliases of the normal private profile', t => {
  const f = fixture(t), aliases = realAliases(f.normal);
  console.log(JSON.stringify({ realCaseAlias: aliases.some(value => value.caseAlias), realDataAlias: aliases.some(value => !value.caseAlias),
    distinctRealpathAliases: aliases.filter(value => value.distinctRealpath).length }));
  assert.ok(aliases.length > 0, 'A real filesystem alias is required for this regression witness');
  for (const { alias } of aliases) assert.throws(() => run(f.normal, alias), { code: 'SYNTHETIC_EXIT' });
});

test('normal identity aliases are rejected even when normalDataDir uses the alias spelling', t => {
  const f = fixture(t), aliases = realAliases(f.normal);
  assert.ok(aliases.length > 0);
  for (const { alias } of aliases) assert.throws(() => run(alias, f.normal), { code: 'SYNTHETIC_EXIT' });
});

test('the real startup still accepts a different owned private directory and refuses a symlink to normal', t => {
  const f = fixture(t);
  assert.notDeepEqual([fs.statSync(f.normal).dev, fs.statSync(f.normal).ino], [fs.statSync(f.isolated).dev, fs.statSync(f.isolated).ino]);
  const allowed = run(f.normal, f.isolated); assert.equal(allowed.backgroundTest, true); assert.equal(allowed.butlerEntryEnabled, true);
  const alias = path.join(f.directory, 'normal-link'); fs.symlinkSync(f.normal, alias, 'dir');
  assert.throws(() => run(f.normal, alias), { code: 'SYNTHETIC_EXIT' });
});

test('the actual startup keeps parent, owner, private mode and directory guards', t => {
  const f = fixture(t);
  for (const options of [{ parent: 322 }, { owner: process.getuid() + 1 }, { noUid: true }])
    assert.throws(() => run(f.normal, f.isolated, options), { code: 'SYNTHETIC_EXIT' });
  fs.chmodSync(f.isolated, 0o755); assert.throws(() => run(f.normal, f.isolated), { code: 'SYNTHETIC_EXIT' });
  const file = path.join(f.directory, 'regular-file'); fs.writeFileSync(file, 'synthetic', { mode: 0o600 });
  assert.throws(() => run(f.normal, file), { code: 'SYNTHETIC_EXIT' });
});

test('an absent normal profile still permits a distinct existing private test profile; other path errors refuse', t => {
  const f = fixture(t), missing = path.join(f.directory, 'not-created', 'normal');
  assert.equal(run(missing, f.isolated).backgroundTest, true);
  const file = path.join(f.directory, 'not-a-directory'); fs.writeFileSync(file, 'synthetic', { mode: 0o600 });
  assert.throws(() => run(path.join(file, 'normal'), f.isolated), { code: 'SYNTHETIC_EXIT' });
  assert.throws(() => run(f.normal, f.isolated, { getPathError: Error('Synthetic path failure') }), /Synthetic path failure/);
});

test('normal unflagged startup does not acquire any isolated test permission', t => {
  const f = fixture(t), result = run(f.normal, f.isolated, { noFlags: true });
  assert.equal(result.backgroundTest, false); assert.equal(result.butlerEntryEnabled, false);
});

test('after verification, a real symlink swap cannot redirect Electron userData to the normal profile', t => {
  const f = fixture(t), link = path.join(f.directory, 'checked-profile-link');
  fs.symlinkSync(f.isolated, link, 'dir');
  const expected = fs.statSync(f.isolated), result = run(f.normal, link);
  fs.unlinkSync(link); fs.symlinkSync(f.normal, link, 'dir');
  assert.ok(sameDirectory(fs.statSync(result.runtimeProfile), expected), 'The actual stored runtime path must keep the checked isolated inode');
  assert.equal(sameDirectory(fs.statSync(result.runtimeProfile), fs.statSync(f.normal)), false);
  assert.equal(result.runtimeProfile, fs.realpathSync(f.isolated));
});

test('the actual startup rejects a private test child of the normal directory', t => {
  const f = fixture(t), child = path.join(f.normal, 'PrivateTestChild');
  fs.mkdirSync(child, { mode: 0o700 });
  assert.throws(() => run(f.normal, child), { code: 'SYNTHETIC_EXIT' });
});

test('the actual startup rejects a private test parent containing the normal directory', t => {
  const f = fixture(t); fs.chmodSync(f.directory, 0o700);
  assert.throws(() => run(f.normal, f.directory), { code: 'SYNTHETIC_EXIT' });
});

test('normal parent and child exclusion uses real directory identities through case, Data-volume and symlink aliases', t => {
  const f = fixture(t), child = path.join(f.normal, 'PrivateTestChild'); fs.mkdirSync(child, { mode: 0o700 });
  for (const { alias } of realAliases(f.normal)) assert.throws(() => run(alias, child), { code: 'SYNTHETIC_EXIT' });
  const nestedNormal = path.join(f.isolated, 'NestedNormal'); fs.mkdirSync(nestedNormal, { mode: 0o700 });
  const link = path.join(f.directory, 'parent-link'); fs.symlinkSync(f.isolated, link, 'dir');
  assert.throws(() => run(nestedNormal, link), { code: 'SYNTHETIC_EXIT' });
});

test('a missing normal target still excludes its existing test ancestor, including a symlink parent', t => {
  const f = fixture(t), missing = path.join(f.isolated, 'NotCreated', 'Normal');
  assert.throws(() => run(missing, f.isolated), { code: 'SYNTHETIC_EXIT' });
  const link = path.join(f.directory, 'missing-parent-link'); fs.symlinkSync(f.isolated, link, 'dir');
  assert.throws(() => run(path.join(link, 'NotCreated', 'Normal'), f.isolated), { code: 'SYNTHETIC_EXIT' });
});

test('a distinct directory with a shared text prefix stays eligible, and pin failure cannot leave test permissions enabled', t => {
  const f = fixture(t), sibling = f.normal + '-separate'; fs.mkdirSync(sibling, { mode: 0o700 });
  assert.equal(run(f.normal, sibling).backgroundTest, true);
  assert.throws(() => run(f.normal, f.isolated, { pinError: true }), { code: 'SYNTHETIC_EXIT' });
});

function osReference(f, create = true, appName = 'Native Agent Workspace') {
  const home = path.join(f.directory, 'AccountHome'), normal = path.join(home, 'Library', 'Application Support', appName);
  fs.mkdirSync(create ? normal : home, { recursive: true, mode: 0o700 });
  return { home, normal };
}

test('a CLI-moved Electron reference cannot permit the OS account normal profile', t => {
  const f = fixture(t), account = osReference(f);
  assert.throws(() => run(f.normal, account.normal, { osHome: account.home }), { code: 'SYNTHETIC_EXIT' });
});

test('a CLI-moved Electron reference cannot permit a private parent of the OS account normal profile', t => {
  const f = fixture(t), account = osReference(f);
  assert.throws(() => run(f.normal, path.dirname(account.normal), { osHome: account.home }), { code: 'SYNTHETIC_EXIT' });
});

test('a CLI-moved Electron reference cannot permit a private child of the OS account normal profile', t => {
  const f = fixture(t), account = osReference(f), child = path.join(account.normal, 'PrivateTestChild'); fs.mkdirSync(child, { mode: 0o700 });
  assert.throws(() => run(f.normal, child, { osHome: account.home }), { code: 'SYNTHETIC_EXIT' });
});

test('the OS reference uses real same-inode case and Data-volume aliases even when Electron moved elsewhere', t => {
  const f = fixture(t), account = osReference(f), aliases = realAliases(account.normal);
  assert.ok(aliases.length > 0);
  for (const { alias } of aliases) assert.throws(() => run(f.normal, alias, { osHome: account.home }), { code: 'SYNTHETIC_EXIT' });
});

test('HOME redirection is not the OS account reference, while a genuinely separate private test profile still works', t => {
  const f = fixture(t), account = osReference(f), homeEnv = path.join(f.directory, 'RedirectedHOME');
  assert.throws(() => run(f.normal, account.normal, { osHome: account.home, homeEnv }), { code: 'SYNTHETIC_EXIT' });
  assert.equal(run(f.normal, f.isolated, { osHome: account.home, homeEnv }).backgroundTest, true);
});

test('an absent OS normal path still excludes its existing private test ancestor', t => {
  const f = fixture(t), account = osReference(f, false);
  assert.throws(() => run(f.normal, account.home, { osHome: account.home }), { code: 'SYNTHETIC_EXIT' });
});

test('unavailable or non-absolute OS account home fails closed only for the macOS test gate', t => {
  const f = fixture(t);
  for (const options of [{ userInfoError: true }, { osHome: null }, { osHome: '' }, { osHome: 'relative-home' }])
    assert.throws(() => run(f.normal, f.isolated, options), { code: 'SYNTHETIC_EXIT' });
  let calls = 0;
  assert.equal(run(f.normal, f.isolated, { platform: 'linux', userInfoError: true, onUserInfo: () => calls++ }).backgroundTest, true);
  assert.equal(calls, 0);
});

test('ordinary macOS startup never calls the OS account getter or gains a test permission', t => {
  const f = fixture(t); let calls = 0;
  const result = run(f.normal, f.isolated, { noFlags: true, userInfoError: true, onUserInfo: () => calls++ });
  assert.equal(calls, 0); assert.equal(result.backgroundTest, false); assert.equal(result.butlerEntryEnabled, false);
});

test('a CLI initial daily profile plus a different private NAW_DATA_DIR cannot request test permissions', t => {
  const f = fixture(t), errors = [];
  assert.throws(() => run(f.normal, f.isolated, { userDataSwitch: f.normal, onError: message => errors.push(message) }), { code: 'SYNTHETIC_EXIT' });
  assert.deepEqual(errors, ['Invalid isolated headed-test parent/profile; no window opened.']);
});

test('requested tests reject user-data-dir presence for every value and platform before OS-profile verification', t => {
  const f = fixture(t);
  for (const platform of ['darwin', 'linux', 'win32']) for (const profile of [f.normal, f.isolated]) {
    for (const userDataSwitch of [f.normal, f.isolated, '', 'arbitrary-synthetic-value', undefined]) {
      let switchCalls = 0, accountCalls = 0, nameCalls = 0;
      assert.throws(() => run(f.normal, profile, { platform, userDataSwitch,
        onHasSwitch: () => switchCalls++, onUserInfo: () => accountCalls++, onGetName: () => nameCalls++ }), { code: 'SYNTHETIC_EXIT' });
      assert.equal(switchCalls, 1); assert.equal(accountCalls, 0); assert.equal(nameCalls, 0);
    }
  }
});

test('ordinary startup with a CLI profile never queries the test-only switch or name reference', t => {
  const f = fixture(t); let switches = 0, names = 0, accounts = 0;
  const result = run(f.normal, f.isolated, { noFlags: true, userDataSwitch: f.normal,
    onHasSwitch: () => switches++, onGetName: () => names++, onUserInfo: () => accounts++ });
  assert.equal(switches, 0); assert.equal(names, 0); assert.equal(accounts, 0);
  assert.equal(result.runtimeProfile, f.normal); assert.equal(result.setPaths.length, 0);
  assert.equal(result.backgroundTest, false); assert.equal(result.butlerEntryEnabled, false);
  const redirected = run(f.normal, f.isolated, { noFlags: true, ordinaryDataDir: f.isolated, userDataSwitch: f.normal,
    onHasSwitch() { throw Error('Ordinary startup must not inspect test-only CLI restrictions'); } });
  assert.equal(redirected.runtimeProfile, path.resolve(f.isolated)); assert.equal(redirected.setPaths.length, 1);
  assert.equal(redirected.backgroundTest, false); assert.equal(redirected.butlerEntryEnabled, false);
});

test('the macOS account reference follows the current Electron app name rather than a second fixed name', t => {
  const f = fixture(t), appName = 'Synthetic Renamed Workspace', account = osReference(f, true, appName);
  let names = 0;
  assert.throws(() => run(f.normal, account.normal, { osHome: account.home, appName, onGetName: () => names++ }), { code: 'SYNTHETIC_EXIT' });
  assert.equal(names, 1);
  assert.equal(run(f.normal, f.isolated, { osHome: account.home, appName }).backgroundTest, true);
});

test('verified requested startup explicitly pins Session data to the same checked real private directory', t => {
  const f = fixture(t), alias = path.join(f.directory, 'checked-session-profile'); fs.symlinkSync(f.isolated, alias, 'dir');
  const result = run(f.normal, alias), checked = fs.realpathSync(f.isolated);
  assert.equal(result.backgroundTest, true); assert.equal(result.butlerEntryEnabled, true);
  assert.equal(result.runtimeProfile, checked); assert.equal(result.runtimeSessionPath, checked);
  assert.deepEqual(result.sessionSetPaths, [checked]);
  assert.ok(sameDirectory(fs.statSync(result.runtimeSessionPath), fs.statSync(f.isolated)));
  assert.equal(sameDirectory(fs.statSync(result.runtimeSessionPath), fs.statSync(f.normal)), false);
});

test('Session data pin failure refuses requested startup with no test permission or foreground fallback', t => {
  const f = fixture(t), errors = []; let attempts = 0;
  assert.throws(() => run(f.normal, f.isolated, { sessionPinError: true, onSessionPin: () => attempts++,
    onError: message => errors.push(message) }), { code: 'SYNTHETIC_EXIT' });
  assert.equal(attempts, 1); assert.deepEqual(errors, ['Invalid isolated headed-test parent/profile; no window opened.']);
});
