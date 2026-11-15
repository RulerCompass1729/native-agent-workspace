const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const generated = new Set(['dsh/client.js']);

// Execute the real copied module graph, not a second expected-filename list.
// Requiring Workspace does not construct a service, native engine or model.
for (const [manifest, variable] of [['app/service-client.cjs', 'names'], ['scripts/package-mac.cjs', 'sources']]) {
  test(`${manifest} includes the modules needed to load the copied Workspace`, t => {
    const source = fs.readFileSync(path.join(root, manifest), 'utf8');
    const literal = source.match(new RegExp('const ' + variable + ' = (\\[[\\s\\S]*?\\]);'));
    assert.ok(literal, 'Read the actual payload declaration');
    const names = Array.from(vm.runInNewContext(literal[1], Object.create(null), { timeout: 1000 }));
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'naw-runtime-payload-')));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    for (const name of names) {
      assert.equal(typeof name, 'string');
      const target = path.join(directory, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      // scripts/build-ui.cjs writes dsh/client.js and Git ignores it; Workspace never
      // loads it. A checkout that has not built the UI still checks this module graph.
      const source = path.join(root, 'app', name);
      if (generated.has(name) && !fs.existsSync(source)) fs.writeFileSync(target, '');
      else fs.copyFileSync(source, target);
    }
    const load = () => spawnSync(process.execPath, ['-e',
      'const assert = require("node:assert/strict"); const { Workspace } = require(process.argv[1]); assert.equal(typeof Workspace, "function"); Workspace.prototype.assertMaintenanceShutdown.call({ sessions: new Map(), stops: new Map(), rooms: new Map() }, []);',
      path.join(directory, 'workspace.cjs')], { cwd: directory, encoding: 'utf8', timeout: 10000,
      env: { ...process.env, NODE_PATH: path.join(root, 'node_modules'), NODE_OPTIONS: '' } });
    const result = load();
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    // A real missing direct dependency must fail rather than resolving into
    // the checkout through NODE_PATH or another retained runtime directory.
    fs.unlinkSync(path.join(directory, 'goal-continuation.cjs'));
    const missing = load();
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /Cannot find module '\.\/goal-continuation\.cjs'/);
  });
}
