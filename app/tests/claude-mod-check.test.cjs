// B3 option B: an unqualified Claude version gets the mod's own tests run once in the
// background, and the result is kept for the manual qualification. Fake programs only,
// run under the real system sandbox; no Claude, no model, no network.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), net = require('node:net'), os = require('node:os'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const check = require('../claude-mod-check.cjs');
const root = path.resolve(__dirname, '../..'), mac = { skip: process.platform !== 'darwin' };

const PASS = '\nsubmission.test.ts:\n(pass) first [10.10ms]\n(pass) second [1.20s]\n\n 2 pass\n 0 fail\nRan 2 tests across 1 files. [0.99s]\n';
const FAIL = ['', 'native-media.test.ts:', '(fail) keeps the original input [51.63ms]', '  AssertionError: expect(received).toBe()', '  ', '  the engine reported:',
  "    native-workspace-submit's session.start hook was skipped: $.session.version is not a function.", '(pass) stays inert [3.00ms]', '(fail) second failure [2.00ms]', '  the engine reported:',
  "    native-workspace-submit's session.start hook was skipped: $.session.version is not a function.", '', ' 1 pass', ' 2 fail', 'Ran 3 tests across 1 files. [0.49s]', ''].join('\n');

const say = text => `/bin/cat <<'OUT'\n${text}\nOUT`;
// A private folder with a fake program that reports how it was started, then does what the test asks.
function fixture(t, body) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'naw-mod-check-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const privateDir = path.join(dir, 'private'), report = path.join(dir, 'report'), program = path.join(dir, 'claude');
  fs.mkdirSync(privateDir); fs.mkdirSync(report);
  fs.writeFileSync(program, `#!/bin/sh\nREPORT='${report}'\nprintf '%s\\n' "$@" > "$REPORT/args"\n/usr/bin/env > "$REPORT/env"\n(cd "$3" && /usr/bin/find . -type f | /usr/bin/sort) > "$REPORT/files"\n${body}\n`, { mode: 0o700 });
  const read = name => fs.readFileSync(path.join(report, name), 'utf8').trim().split('\n');
  return { dir, privateDir, report, program, read, file: path.join(dir, 'claude-mod-check.json'), options: { binary: program, version: '2.1.999', privateDir } };
}

test('the summary, the failed tests and the engine message are read from the real output format', () => {
  assert.deepEqual(check.parse(PASS), { pass: 2, fail: 0, tests: 2, files: 1, failed: [], engine: [] });
  assert.deepEqual(check.parse(FAIL), { pass: 1, fail: 2, tests: 3, files: 1, failed: ['keeps the original input', 'second failure'],
    engine: ["native-workspace-submit's session.start hook was skipped: $.session.version is not a function."] });
  assert.deepEqual(check.parse(' 1 pass\n 1 skip\n 0 fail\n 9 expect() calls\nRan 2 tests across 1 files. [1ms]\n'), { pass: 1, fail: 0, tests: 2, files: 1, failed: [], engine: [] });
  // A test that prints a line looking like a count does not replace the runner's own summary at the end.
  assert.equal(check.parse(' 99 pass\nsomething\n' + PASS).pass, 2);
  assert.deepEqual(check.parse("error: unknown command 'test'\n"), { pass: null, fail: null, tests: null, files: null, failed: [], engine: [] });
});

test('the run gets a private copy of the mod and its tests, a private home, and nothing of this process', mac, async t => {
  const f = fixture(t, say(PASS));
  process.env.NAW_MOD_CHECK_LEAK = 'leak'; t.after(() => { delete process.env.NAW_MOD_CHECK_LEAK; });
  const record = await check.run(f.options);
  assert.deepEqual({ ...record, at: null, seconds: null }, { version: '2.1.999', mod: check.modHash(), at: null, seconds: null, exit: 0, pass: 2, fail: 0, tests: 2, files: 1, failed: [], engine: [] });
  assert.equal(check.passed(record), true); assert.equal(check.complete(record, check.modHash()), true);
  const [plugin, command, copy, ...rest] = f.read('args');
  assert.deepEqual([plugin, command, rest], ['plugin', 'test', []]);
  assert.deepEqual(f.read('files'), [...check.PLUGIN, ...check.TESTS].map(name => './' + name).sort());
  const env = Object.fromEntries(f.read('env').map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  assert.deepEqual(Object.keys(env).filter(key => !['PWD', 'SHLVL', '_', 'OLDPWD', 'REPORT'].includes(key)).sort(), ['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'CLAUDE_CONFIG_DIR', 'DISABLE_AUTOUPDATER', 'HOME', 'LANG', 'PATH', 'TMPDIR']);
  const work = path.dirname(copy);
  assert.equal(path.dirname(work), f.privateDir); assert.deepEqual([env.HOME, env.CLAUDE_CONFIG_DIR, env.TMPDIR], ['home', 'config', 'tmp'].map(name => path.join(work, name)));
  assert.deepEqual(fs.readdirSync(f.privateDir), [], 'The private copy is removed afterwards');
});

test('the run cannot reach the network or write under the home folder, only its own private folder', mac, async t => {
  const reached = []; const server = net.createServer(socket => { reached.push(1); socket.destroy(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  // A stand-in home: the program's own folder sits inside it, as the data folder does in daily use.
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'naw-mod-check-home-'))), real = process.env.HOME;
  process.env.HOME = home; t.after(() => { process.env.HOME = real; fs.rmSync(home, { recursive: true, force: true }); });
  const privateDir = path.join(home, 'private'); fs.mkdirSync(privateDir);
  const f = fixture(t, `/usr/bin/nc -z -w 2 127.0.0.1 ${server.address().port}; echo "net=$?"\n/usr/bin/touch '${home}/outside' 2>/dev/null; echo "home=$?"\n/usr/bin/touch "$HOME/inside"; echo "own=$?"`);
  // Outside the sandbox the same command connects, so the refusal below is the sandbox's.
  require('node:child_process').execFileSync('/usr/bin/nc', ['-z', '-w', '2', '127.0.0.1', String(server.address().port)], { stdio: 'ignore' });
  await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(reached.length, 1); reached.length = 0;
  const record = await check.run({ ...f.options, privateDir });
  assert.equal(record.exit, 0, JSON.stringify(record));
  const said = Object.fromEntries(record.note.split('\n').map(line => line.split('=')));
  assert.notEqual(said.net, '0', 'The connection is refused by the sandbox'); assert.deepEqual(reached, []);
  assert.notEqual(said.home, '0'); assert.equal(fs.existsSync(path.join(home, 'outside')), false);
  assert.equal(said.own, '0', 'Its own private folder stays writable');
});

test('a failing version is recorded with its failed tests and the engine message; an unreadable output keeps a note', mac, async t => {
  const failing = fixture(t, say(FAIL) + '\nexit 1'), record = await check.run(failing.options);
  assert.deepEqual([record.exit, record.pass, record.fail, record.tests, record.failed.length, record.engine.length], [1, 1, 2, 3, 2, 1]);
  assert.equal(check.passed(record), false); assert.equal(check.complete(record, record.mod), true);
  assert.match(check.describe(record), /^1 pass \/ 2 fail of 3 in 1 files, exit 1; first failure: keeps the original input; engine: .*is not a function\.$/);
  const unknown = fixture(t, `echo "error: unknown command at $3/hooks/register.js" >&2\nexit 2`), other = await check.run(unknown.options);
  assert.deepEqual([other.exit, other.tests, other.note], [2, null, 'error: unknown command at /mod/hooks/register.js'], 'The private path is not kept');
  assert.equal(check.passed(other), false); assert.match(check.describe(other), /^no test summary, exit 2: error: unknown command/);
  const zero = fixture(t, say(' 0 pass\n 0 fail\nRan 0 tests across 0 files.'));
  assert.equal(check.passed(await check.run(zero.options)), false, 'No test run is not a pass');
});

test('the time limit ends the whole process group, and the result is not kept as complete', mac, async t => {
  const f = fixture(t, '/bin/sleep 30 &\necho $! > "$REPORT/child"\nwait');
  const before = Date.now(), record = await check.run({ ...f.options, timeoutMs: 600 });
  // A child left alive would hold the output open until it ends by itself.
  assert.ok(Date.now() - before < 5000, 'The run returns at the limit');
  assert.equal(record.timedOut, true); assert.equal(record.exit, null); assert.equal(record.signal, 'SIGKILL');
  assert.equal(check.complete(record, record.mod), false); assert.equal(check.describe(record), 'stopped at the time limit');
  const child = Number(f.read('child')[0]); assert.ok(child > 1);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.throws(() => process.kill(child, 0), { code: 'ESRCH' }, 'The program\'s own child is gone too');
  assert.deepEqual(fs.readdirSync(f.privateDir), []);
});

test('without the sandbox nothing runs, and the record says why', async t => {
  const f = fixture(t, 'echo ran'), record = await check.run({ ...f.options, sandbox: path.join(f.dir, 'no-sandbox-here') });
  assert.match(record.reason, /ENOENT/); assert.equal(record.exit, undefined);
  assert.equal(fs.existsSync(path.join(f.report, 'args')), false, 'The program was not started');
  assert.equal(check.complete(record, record.mod), false); assert.match(check.describe(record), /^not run \(/);
  assert.deepEqual(fs.readdirSync(f.privateDir), []);
  const missing = await check.run({ ...f.options, dir: f.dir });
  assert.match(missing.reason, /ENOENT/, 'Missing mod files are a reason, not an exception'); assert.equal(missing.mod, null);
  const kept = await check.checkOnce({ file: f.file, ...f.options, dir: f.dir });
  assert.match(kept.reason, /ENOENT/); assert.deepEqual(check.load(f.file), { '2.1.999': kept }, 'A run that could not happen is recorded too');
});

test('a completed result is kept per version and mod, and run again only when the mod or its tests change', mac, async t => {
  const f = fixture(t, 'echo run >> "$REPORT/count"\n' + say(PASS)), count = path.join(f.report, 'count');
  const runs = () => fs.existsSync(count) ? fs.readFileSync(count, 'utf8').trim().split('\n').length : 0;
  const first = await check.checkOnce({ file: f.file, ...f.options });
  assert.equal(first.pass, 2); assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  assert.deepEqual(check.load(f.file), { '2.1.999': first });
  assert.equal(await check.checkOnce({ file: f.file, ...f.options }), null); assert.equal(runs(), 1, 'The stored result stands');
  assert.equal((await check.checkOnce({ file: f.file, ...f.options, version: '2.1.998' })).version, '2.1.998'); assert.equal(runs(), 2);
  assert.deepEqual(Object.keys(check.load(f.file)).sort(), ['2.1.998', '2.1.999']);
  // The copied runtime layout with one changed test: a different mod, so the version is checked again.
  const runtime = path.join(f.dir, 'runtime');
  for (const name of check.PLUGIN) { const target = path.join(runtime, 'claude-bridge', name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(path.join(root, 'app/claude-bridge', name), target); }
  fs.mkdirSync(path.join(runtime, 'claude-bridge-tests'));
  for (const name of check.TESTS) fs.copyFileSync(path.join(root, 'app/claude-bridge', name), path.join(runtime, 'claude-bridge-tests', name));
  assert.equal(check.modHash(check.sources(runtime)), check.modHash(), 'The same files in the runtime layout are the same mod');
  assert.equal(await check.checkOnce({ file: f.file, ...f.options, dir: runtime }), null);
  fs.appendFileSync(path.join(runtime, 'claude-bridge-tests', check.TESTS[0]), '\n// changed\n');
  const again = await check.checkOnce({ file: f.file, ...f.options, dir: runtime });
  assert.notEqual(again.mod, first.mod); assert.equal(runs(), 3); assert.deepEqual(f.read('files'), [...check.PLUGIN, ...check.TESTS].map(name => './' + name).sort());
  // A run that did not finish, or a record that cannot be read, is tried again.
  check.save(f.file, { ...first, exit: null, timedOut: true });
  assert.equal((await check.checkOnce({ file: f.file, ...f.options })).exit, 0); assert.equal(runs(), 4);
  fs.writeFileSync(f.file, '{ not json');
  assert.deepEqual(check.load(f.file), {}); assert.equal((await check.checkOnce({ file: f.file, ...f.options })).exit, 0);
  assert.deepEqual(Object.keys(check.load(f.file)), ['2.1.999']);
  for (let i = 0; i < 30; i++) check.save(f.file, { ...first, version: `2.2.${i}`, at: new Date(Date.UTC(2026, 0, 1 + i)).toISOString() });
  const kept = Object.keys(check.load(f.file)); assert.equal(kept.length, 20); assert.ok(kept.includes('2.2.29') && !kept.includes('2.2.0'), 'The newest records are kept');
});

test('the tests the check runs are the mod\'s tracked tests, copied beside the mod in the runtime and packaged', () => {
  const onDisk = fs.readdirSync(path.join(root, 'app/claude-bridge')).filter(name => name.endsWith('.test.ts')).sort();
  assert.deepEqual([...check.TESTS], onDisk);
  const client = fs.readFileSync(path.join(root, 'app/service-client.cjs'), 'utf8'), list = name => JSON.parse(client.match(new RegExp(`const ${name} = (\\[[^\\]]*\\]);`))[1].replace(/'/g, '"'));
  assert.deepEqual(list('pluginFiles'), [...check.PLUGIN]); assert.deepEqual(list('pluginTests'), [...check.TESTS]);
  assert.match(client, /for \(const name of pluginTests\) fs\.copyFileSync\(path\.join\(__dirname, 'claude-bridge', name\), path\.join\(runtime, 'claude-bridge-tests', name\)\);/);
  assert.match(client, /for \(const name of pluginTests\) hash\.update\(/, 'A changed test gives a new runtime copy');
  const packaged = fs.readFileSync(path.join(root, 'scripts/package-mac.cjs'), 'utf8');
  for (const name of [...check.PLUGIN, ...check.TESTS]) assert.ok(packaged.includes(`'claude-bridge/${name}'`), `${name} is packaged`);
});

test('NAW runs the check once when a session starts under an unqualified launcher, and never for a qualified or chosen program', mac, async t => {
  const { Claude, NativeHost } = require('../adapters.cjs');
  const f = fixture(t, ''), versions = path.join(f.dir, 'versions'), bin = path.join(f.dir, 'bin'), data = path.join(f.dir, 'data'), ran = path.join(f.dir, 'ran');
  for (const folder of [versions, bin, data]) fs.mkdirSync(folder);
  // Both programs note every start; asked for the plugin tests, they print a passing summary.
  for (const v of ['2.1.322', '2.1.999']) fs.writeFileSync(path.join(versions, v), `#!/bin/sh\necho "${v} $1 $2" >> '${ran}'\n[ "$1 $2" = "plugin test" ] && echo "$0" >> '${ran}.tested' && ${say(PASS)}\nexit 0\n`, { mode: 0o700 });
  const launcher = path.join(bin, 'claude'), point = v => { fs.rmSync(launcher, { force: true }); fs.symlinkSync(path.join(versions, v), launcher); };
  const host = (extra = {}) => ({ binaries: { claude: launcher }, privateDir: f.privateDir, dataDir: data, hookTargets: new Map(), hookSocket: path.join(f.privateDir, 'hook.sock'), submitSocket: path.join(f.privateDir, 'submit.sock'),
    claudeModChecks: new Map(), serviceBinding: null, closed: false, checkClaudeVersion: NativeHost.prototype.checkClaudeVersion, ...extra });
  const start = async h => { const r = new Claude({ id: randomUUID(), nativeId: randomUUID(), name: 'New', cwd: f.dir }, h); await new Promise(resolve => r.terminal.once('closed', resolve)); r.submission.close(); };
  const starts = () => fs.readFileSync(ran, 'utf8').trim().split('\n'), file = path.join(data, 'claude-mod-check.json');
  point('2.1.999'); const h = host();
  await start(h); await h.claudeModChecks.get('2.1.999').done;
  assert.deepEqual(starts().sort(), ['2.1.322 --session-id ' + starts().find(l => l.startsWith('2.1.322')).split(' ')[2], '2.1.999 plugin test'].sort(), 'The session runs the fallback; only the tests run the new version');
  assert.equal(fs.readFileSync(ran + '.tested', 'utf8'), path.join(versions, '2.1.999') + '\n', 'The tests run the version file the record names, not the launcher');
  const stored = check.load(file)['2.1.999'];
  assert.deepEqual([stored.pass, stored.fail, stored.exit, stored.mod], [2, 0, 0, check.modHash()]);
  assert.equal(fs.existsSync(path.join(f.privateDir, 'claude-mod-check.json')), false, 'The record is kept with the persistent data');
  await start(h); assert.equal(starts().filter(l => l.endsWith('plugin test')).length, 1, 'Once per version');
  // A new start of NAW finds the stored result and does not run it again.
  const next = host(); await start(next); await next.claudeModChecks.get('2.1.999').done;
  assert.equal(starts().filter(l => l.endsWith('plugin test')).length, 1);
  for (const h2 of [host({ serviceBinding: {} }), host({ closed: true })]) { fs.rmSync(file, { force: true }); h2.checkClaudeVersion(); assert.equal(h2.claudeModChecks.size, 0); }
  point('2.1.322'); const qualified = host(); await start(qualified); assert.equal(qualified.claudeModChecks.size, 0, 'A qualified version is not checked');
  const exact = host({ binaries: { claude: path.join(versions, '2.1.999') } }); exact.checkClaudeVersion(); assert.equal(exact.claudeModChecks.size, 0, 'A program the person chose is theirs');
  assert.equal(fs.existsSync(file), false); assert.equal(starts().filter(l => l.endsWith('plugin test')).length, 1);
  // Two sessions starting while the first check still runs, or after a run that did not finish, share that one run.
  fs.writeFileSync(path.join(versions, '2.1.998'), `#!/bin/sh\necho "2.1.998 $1 $2" >> '${ran}'\n/bin/sleep 1\nexit 3\n`, { mode: 0o700 });
  point('2.1.998'); const busy = host(); busy.checkClaudeVersion(); busy.checkClaudeVersion();
  await busy.claudeModChecks.get('2.1.998').done; busy.checkClaudeVersion();
  assert.equal(starts().filter(l => l === '2.1.998 plugin test').length, 1);
  assert.deepEqual([check.load(file)['2.1.998'].exit, check.load(file)['2.1.998'].tests], [3, null], 'A run with no summary is still recorded');
});

test('closing NAW ends a running check and keeps no record of it', mac, async t => {
  const f = fixture(t, '/bin/sleep 30'), stop = new AbortController();
  const pending = check.checkOnce({ file: f.file, ...f.options, signal: stop.signal });
  await new Promise(resolve => { const poll = () => fs.existsSync(path.join(f.report, 'files')) ? resolve() : setTimeout(poll, 20); poll(); });
  const before = Date.now(); stop.abort();
  assert.equal(await pending, null); assert.ok(Date.now() - before < 5000);
  assert.equal(fs.existsSync(f.file), false); assert.deepEqual(fs.readdirSync(f.privateDir), []);
  assert.equal(await check.checkOnce({ file: f.file, ...f.options, signal: stop.signal }), null, 'Nothing starts once NAW is closing');
  assert.equal(fs.existsSync(f.file), false);
});
