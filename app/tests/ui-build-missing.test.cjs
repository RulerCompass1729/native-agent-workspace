const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const main = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8');

// app/dsh/client.js is written by scripts/build-ui.cjs and Git ignores it, so a new
// worktree has none. Without it the isolated window opened on DSH's "Failed to load
// plugins" and kept running. main.cjs's own check runs here with a fake app and exit.
function launch(t, { packaged, built }) {
  const start = main.indexOf('// The window loads app/dsh/client.js'), end = main.indexOf('\n}\n', start) + 3;
  assert.ok(start > 0 && end > start, 'main.cjs checks for the UI build before anything starts');
  assert.ok(start < main.indexOf("require('./service-client.cjs')"), 'The check comes before the service, UI host and window code');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-ui-build-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'dsh'));
  if (built) fs.writeFileSync(path.join(dir, 'dsh', 'client.js'), '');
  const errors = [], exits = [];
  vm.runInNewContext(main.slice(start, end), { app: { isPackaged: packaged }, fs, path, __dirname: dir,
    console: { error: (...line) => errors.push(line.join(' ')) }, process: { exit: code => exits.push(code) } });
  return { errors, exits };
}

test('a source launch without the UI build stops with one line naming the command to run', t => {
  const { errors, exits } = launch(t, { packaged: false, built: false });
  assert.deepEqual(exits, [1]);
  assert.equal(errors.length, 1);
  assert.doesNotMatch(errors[0], /\n/);
  assert.match(errors[0], /app\/dsh\/client\.js is missing/);
  assert.match(errors[0], /node scripts\/build-ui\.cjs/);
});

test('a built source launch and the packaged app start as before', t => {
  assert.deepEqual(launch(t, { packaged: false, built: true }), { errors: [], exits: [] });
  // Packaging runs build-ui itself; the packaged payload is not a checkout to build.
  assert.deepEqual(launch(t, { packaged: true, built: false }), { errors: [], exits: [] });
  // Unit tests run all of main.cjs with a fake Electron app that has no isPackaged.
  assert.deepEqual(launch(t, { packaged: undefined, built: false }), { errors: [], exits: [] });
});
