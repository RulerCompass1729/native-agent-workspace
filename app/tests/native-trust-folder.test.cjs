// scripts/native-trust.cjs trustOwnedFolder (B11 rollout, 2026-11-10): real-CLI tests record trust for the session
// folder NAW creates, in the test's private Codex home. It must never trust a folder outside the test's own base.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { trustOwnedFolder } = require('../../scripts/native-trust.cjs');

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-trust-unit-')), home = path.join(base, 'codex'), folder = path.join(base, 'work-sessions', 'session-1');
  fs.mkdirSync(home); fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.toml'), 'model = "fixture"\n');
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, home, folder, config: () => fs.readFileSync(path.join(home, 'config.toml'), 'utf8') };
}
const tables = text => text.split('\n').filter(line => line.startsWith('[projects.'));

test('the session folder inside the owned base is recorded once per spelling, as Codex saves it', t => {
  const f = fixture(t);
  trustOwnedFolder(f);
  const names = new Set([f.folder, fs.realpathSync(f.folder)]);
  assert.deepEqual(tables(f.config()).sort(), [...names].map(name => `[projects.${JSON.stringify(name)}]`).sort());
  assert.equal(f.config().split('trust_level = "trusted"').length - 1, names.size);
  const once = f.config(); trustOwnedFolder(f);
  assert.equal(f.config(), once, 'a second call adds no second table, which Codex could not read');
});
test('a folder outside the owned base is refused and nothing is written', t => {
  const f = fixture(t), outside = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-trust-outside-')), before = f.config();
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  assert.throws(() => trustOwnedFolder({ ...f, folder: outside }), /Only a folder inside the owned fixture directory/);
  assert.throws(() => trustOwnedFolder({ ...f, folder: f.base }), /Only a folder inside the owned fixture directory/, 'the base itself is not a session folder');
  // A link inside the base that points outside names an outside folder.
  const link = path.join(f.base, 'link'); fs.symlinkSync(outside, link);
  assert.throws(() => trustOwnedFolder({ ...f, folder: link }), /Only a folder inside the owned fixture directory/);
  assert.equal(f.config(), before);
});
test('a config that is a link to another file is refused', t => {
  const f = fixture(t), elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-trust-link-')), target = path.join(elsewhere, 'config.toml');
  t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }));
  fs.writeFileSync(target, 'model = "person"\n'); fs.rmSync(path.join(f.home, 'config.toml')); fs.symlinkSync(target, path.join(f.home, 'config.toml'));
  assert.throws(() => trustOwnedFolder(f), /regular file/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'model = "person"\n');
});
test('a Codex home outside the owned base is refused', t => {
  const f = fixture(t), elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-trust-home-'));
  t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }));
  fs.writeFileSync(path.join(elsewhere, 'config.toml'), 'model = "person"\n');
  assert.throws(() => trustOwnedFolder({ ...f, home: elsewhere }), /private one/);
  assert.equal(fs.readFileSync(path.join(elsewhere, 'config.toml'), 'utf8'), 'model = "person"\n');
});
