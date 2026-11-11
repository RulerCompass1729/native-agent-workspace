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
  const context = { fs, path, Object, Number, Boolean, console: { error() {} }, app: {
    getPath(name) { assert.equal(name, 'userData'); if (options.getPathError) throw options.getPathError; return normal; }, setPath() {},
  }, process: { env, ppid: options.parent ?? 321, getuid: options.noUid ? undefined : () => options.owner ?? process.getuid(),
    exit(status) { assert.equal(status, 1); throw Object.assign(Error('isolated-startup-refused'), { code: 'SYNTHETIC_EXIT' }); } } };
  return vm.runInNewContext(bootstrap + '\n({ backgroundTest, butlerEntryEnabled });', context);
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
