const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), { createHash } = require('node:crypto');
const code = process.env.NAW_INSTALL_GATE_TEST_ROOT || path.resolve(__dirname, '../../scripts'), g = require(path.join(code, 'check-install-state.cjs'));
const helper = require('../../scripts/fixtures/install-runtime.cjs');
for (const comment of ['block', '<!--', '-->']) test((comment === 'block' ? 'F-r8-1' : 'F-r9-1: ' + comment) + ': commented old array cannot authenticate a computed extra-file bootstrap', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'naw-closure-definition-'))); let live;
  try {
    const f = helper.fixture(root), bootstrap = path.join(f.app, 'app/service-client.cjs'), original = fs.readFileSync(bootstrap, 'utf8');
    const literal = original.match(/const names = (\[[^;\n]+\]);/)[1], count = [...literal.matchAll(/'([^']+)'/g)].length;
    const replacement = comment === 'block'
      ? 'const baseNames = ' + literal + '; /* const names = ' + literal + "; */ const names = baseNames.concat(['extra-runtime.cjs']);"
      : "const replacement = " + literal + ".concat(['extra-runtime.cjs']); globalThis['names'] = replacement;\n" + comment + ' ; const names = ' + literal + ';\n';
    fs.writeFileSync(bootstrap, original.replace('const names = ' + literal + ';', replacement));
    require('node:child_process').execFileSync(process.execPath, ['--check', bootstrap], { stdio: 'pipe', timeout: 5000 });
    fs.writeFileSync(path.join(f.app, 'app/daemon.cjs'), "const extra=require('./extra-runtime.cjs');process.on('message',()=>process.send({loaded:{sha:extra.sha||'old'}}));setInterval(()=>{},1000);");
    fs.writeFileSync(path.join(f.app, 'app/extra-runtime.cjs'), 'exports.sha="new";');
    const identity = createHash('sha256').update(f.version);
    for (const name of ['daemon.cjs', 'adapters.cjs', 'codex-terminal-bridge.cjs', 'workspace.cjs']) identity.update(fs.readFileSync(path.join(f.app, 'app', name)));
    f.key = 'backends/' + identity.digest('hex').slice(0, 20); f.directory = path.join(f.profile, f.key);
    const oldHash = createHash('sha256'); for (const [name] of f.entries) oldHash.update(fs.readFileSync(path.join(f.app, 'app', name)));
    f.runtimeHash = oldHash.digest('hex').slice(0, 16); f.runtime = path.join(f.directory, 'runtimes', f.runtimeHash); fs.mkdirSync(f.runtime, { recursive: true });
    for (const [name, target] of f.entries) { const file = path.join(f.runtime, target); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.copyFileSync(path.join(f.app, 'app', name), file); }
    fs.writeFileSync(path.join(f.runtime, 'extra-runtime.cjs'), '');
    const actualFiles = [...f.entries.slice(0, count), ['extra-runtime.cjs', 'extra-runtime.cjs'], ...f.entries.slice(count)], expectedHash = createHash('sha256');
    for (const [name] of actualFiles) expectedHash.update(fs.readFileSync(path.join(f.app, 'app', name)));
    const actualHash = expectedHash.digest('hex').slice(0, 16); assert.notEqual(actualHash, f.runtimeHash);
    live = await helper.start(f); assert.equal(live.loaded.sha, 'old');
    let result, reason, combinedOk = false, workerCalls = 0;
    try { result = g.backendState(f.profile, live.target); } catch (error) { reason = error.installStateReason || error.message; }
    if (result) {
      const box = { x: 20, y: 30, width: 640, height: 480 }, before = { profile: f.profile, gui: { pid: 200, started: 'old' }, views: [{ owner: 'view', bounds: box }], windows: [{ id: 1, onScreen: true, bounds: box }], bundle: { version: f.version, revision: 'a'.repeat(40), runtimeHash: g.runtimeClosure(f.app).hash }, backend: result, dsh: { status: 'qualified', digest: 'same-tree' } };
      combinedOk = (await g.post(before, () => ({ ...before, gui: { pid: 201, started: 'new' } }), { version: f.version, revision: 'a'.repeat(40) }, async () => { workerCalls++; }, { minimumMs: 0, quietMs: 0 })).ok;
    }
    console.log(JSON.stringify({ comment, actualTargetFiles: actualFiles.length, parserFiles: result?.files, actualHash, liveHash: f.runtimeHash, loaded: live.loaded.sha, accepted: Boolean(result), combinedOk, workerCalls, reason }));
    assert.equal(Boolean(result), false); assert.equal(combinedOk, false); assert.equal(workerCalls, 0); assert.match(reason, /Runtime closure definition unconfirmed/);
  } finally { await live?.close(); fs.rmSync(root, { recursive: true }); }
});
function bootstrap(t, change) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'naw-closure-definition-'))); t.after(() => fs.rmSync(root, { recursive: true }));
  const f = helper.fixture(root), file = path.join(f.app, 'app/service-client.cjs'), source = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, change(source, root)); return f;
}
test('the existing literal inputs retain their order, mapping and hash', t => {
  const f = bootstrap(t, source => source), closure = g.runtimeClosure(f.app);
  assert.deepEqual(closure.files, f.entries); assert.equal(closure.hash, f.runtimeHash); assert.equal(closure.files.length, f.entries.length);
  console.log(JSON.stringify({ literalInputs: closure.files.length, identicalOrderedHash: true }));
});
for (const kind of ['block comment', 'line comment', 'quoted text', 'template text']) test(kind + ' is not an extra array definition', t => {
  const f = bootstrap(t, source => {
    const literal = source.match(/const names = (\[[^;\n]+\]);/)[1], text = 'const names = ' + literal + ';';
    const prefix = kind === 'block comment' ? '/* ' + text + ' */' : kind === 'line comment' ? '// ' + text : kind === 'quoted text' ? 'const example = ' + JSON.stringify(text) + ';' : 'const example = `' + text + '`;';
    return prefix + '\n' + source;
  });
  assert.equal(g.runtimeClosure(f.app).hash, f.runtimeHash);
});
for (const name of ['names', 'pluginFiles', 'pluginTests']) test('a commented ' + name + ' cannot cover its real computed initializer', t => {
  const f = bootstrap(t, source => {
    const pattern = new RegExp('const ' + name + ' = (\\[[^;\\n]+\\]);'), literal = source.match(pattern)[1];
    return source.replace(pattern, '/* const ' + name + ' = ' + literal + '; */ const ' + name + ' = [].concat(' + literal + ');');
  });
  assert.throws(() => g.runtimeClosure(f.app), /definition unconfirmed/);
});
for (const kind of ['quoted text', 'template text']) test(kind + ' cannot hide the lack of a real literal definition', t => {
  const f = bootstrap(t, source => {
    const literal = source.match(/const names = (\[[^;\n]+\]);/)[1], text = 'const names = ' + literal + ';';
    return source.replace(text, 'const example = ' + (kind === 'quoted text' ? JSON.stringify(text) : '`' + text + '`') + '; const names = [].concat(' + literal + ');');
  });
  assert.throws(() => g.runtimeClosure(f.app), /definition unconfirmed/);
});
for (const extra of [
  'function other(){const names=[];}',
  'names.push("extra-runtime.cjs");',
  'const alias = names;',
]) test('multiple bindings or unsupported array use refuses: ' + extra.split('(')[0], t => {
  const f = bootstrap(t, source => extra.startsWith('function') ? source + '\n' + extra : source.replace('  const localLocations =', '  ' + extra + '\n  const localLocations ='));
  assert.throws(() => g.runtimeClosure(f.app), /definition unconfirmed/);
});
test('comments, newlines, double quotes and trailing commas in a pure array remain provable', t => {
  const f = bootstrap(t, source => source.replace(/const names = (\[[^;\n]+\]);/, (_match, literal) => 'const /* bind */ names\n= [\n' + [...literal.matchAll(/'([^']+)'/g)].map(m => JSON.stringify(m[1])).join(',\n') + ',\n];'));
  assert.equal(g.runtimeClosure(f.app).hash, f.runtimeHash);
});
for (const prefix of ['const re = /const names = [x]/;', 'const hidden = `${(()=>{const names=[];return names})()}`;', 'const na\\u006des = [];']) test('unsupported lexical boundaries refuse: ' + prefix.slice(0, 18), t => {
  const f = bootstrap(t, source => prefix + '\n' + source); assert.throws(() => g.runtimeClosure(f.app), /definition unconfirmed/);
});
test('target source is inspected without executing its top-level side effect', t => {
  let marker;
  const f = bootstrap(t, (source, root) => { marker = path.join(root, 'must-not-exist'); return 'require("node:fs").writeFileSync(' + JSON.stringify(marker) + ',"executed");\n' + source; });
  assert.equal(g.runtimeClosure(f.app).hash, f.runtimeHash); assert.equal(fs.existsSync(marker), false);
});

for (const prefix of [
  'const example = "<!-- -->";',
  "const example = '<!-- -->';",
  'const example = `<!-- -->`;',
  '// <!-- -->',
  '/* <!-- --> */',
]) test('HTML markers inside strings or recognized comments preserve the literal closure: ' + prefix, t => {
  const f = bootstrap(t, source => prefix + '\n' + source), closure = g.runtimeClosure(f.app);
  assert.deepEqual(closure.files, f.entries); assert.equal(closure.hash, f.runtimeHash);
});
