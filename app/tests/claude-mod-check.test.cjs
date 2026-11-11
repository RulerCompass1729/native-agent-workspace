// B3 option B: an unqualified Claude version gets the mod's own tests run once in the
// background, and the result is kept for the manual qualification. Fake programs only,
// run under the real system sandbox; no Claude, no model, no network.
//
// The sandbox lets a program write nowhere but its own folder, which is removed after the
// run, so a fake program reports what it saw the way the real one does: as (pass)/(fail)
// lines and a summary on its output, which come back in the record.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), net = require('node:net'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process'), { randomUUID } = require('node:crypto');
const check = require('../claude-mod-check.cjs');
const root = path.resolve(__dirname, '../..'), mac = { skip: process.platform !== 'darwin' };

const PASS = '\nsubmission.test.ts:\n(pass) first [10.10ms]\n(pass) second [1.20s]\n\n 2 pass\n 0 fail\nRan 2 tests across 1 files. [0.99s]\n';
const FAIL = ['', 'native-media.test.ts:', '(fail) keeps the original input [51.63ms]', '  AssertionError: expect(received).toBe()', '  ', '  the engine reported:',
  "    native-workspace-submit's session.start hook was skipped: $.session.version is not a function.", '(pass) stays inert [3.00ms]', '(fail) second failure [2.00ms]', '  the engine reported:',
  "    native-workspace-submit's session.start hook was skipped: $.session.version is not a function.", '', ' 1 pass', ' 2 fail', 'Ran 3 tests across 1 files. [0.49s]', ''].join('\n');
const say = text => `/bin/cat <<'OUT'\n${text}\nOUT`;
// Shell helpers for a fake program: `ok <name> <status>` counts one condition; `summary` prints the runner's summary.
const HELPERS = `P=0; F=0
ok() { if [ "$2" = 0 ]; then P=$((P+1)); echo "(pass) $1"; else F=$((F+1)); echo "(fail) $1"; fi; }
summary() { echo; echo " $P pass"; echo " $F fail"; echo "Ran $((P+F)) tests across 1 files. [0.01s]"; [ "$F" = 0 ]; }`;
const FILES = [...check.PLUGIN, ...check.TESTS].map(name => './' + name).sort().join(' ');
const COPY = `[ "$(cd "$3" && /usr/bin/find . -type f | /usr/bin/sort | /usr/bin/tr '\\n' ' ')" = "${FILES} " ]; ok "the copy holds the mod and its tests" $?`;

// A private folder and a fake Claude program made of the given shell lines (or a function of the per-start folder).
function fixture(t, body) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'naw-mod-check-')));
  const privateDir = path.join(dir, 'private'), program = path.join(dir, 'claude');
  fs.mkdirSync(privateDir);
  fs.writeFileSync(program, `#!/bin/sh\n${HELPERS}\n${typeof body === 'function' ? body(privateDir) : body}\n`, { mode: 0o700 });
  const f = { dir, privateDir, program, file: path.join(dir, 'claude-mod-check.json'), options: { binary: program, version: '2.1.999', privateDir } };
  t.after(async () => { await f.running; fs.rmSync(dir, { recursive: true, force: true }); });
  return f;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const realSetTimeout = setTimeout;
const realSleep = ms => new Promise(resolve => realSetTimeout(resolve, ms));
async function readyFile(f, name, completed) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    for (const work of fs.readdirSync(f.privateDir)) {
      const file = path.join(f.privateDir, work, 'home', name);
      if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
    }
    assert.equal(completed.value, undefined, 'The run ended before fixture readiness: ' + JSON.stringify(completed.value));
    await realSleep(10);
  }
  assert.fail('The sandbox fixture did not reach ' + name + ' before the independent startup watchdog');
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
  const f = fixture(t, perStart => [
    '[ "$1 $2 $#" = "plugin test 3" ]; ok "started as plugin test <folder>" $?', COPY,
    `[ "$(/usr/bin/env | /usr/bin/cut -d= -f1 | /usr/bin/grep -v -x -e PWD -e SHLVL -e _ -e OLDPWD | /usr/bin/sort | /usr/bin/tr '\\n' ' ')" = "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC CLAUDE_CONFIG_DIR DISABLE_AUTOUPDATER HOME LANG PATH TMPDIR " ]; ok "only the seven fixed variables" $?`,
    'W="$(/usr/bin/dirname "$3")"; [ "$HOME $CLAUDE_CONFIG_DIR $TMPDIR $PWD" = "$W/home $W/config $W/tmp $W" ]; ok "home, configuration and temporary folders are its own" $?',
    '[ -d "$HOME" ] && [ -d "$CLAUDE_CONFIG_DIR" ] && [ -d "$TMPDIR" ]; ok "they exist" $?',
    `[ "$(/usr/bin/dirname "$W")" = '${perStart}' ]; ok "inside the per-start folder" $?`, '[ ! -t 0 ]; ok "no terminal input" $?', 'summary'].join('\n'));
  process.env.NAW_MOD_CHECK_LEAK = 'leak'; t.after(() => { delete process.env.NAW_MOD_CHECK_LEAK; });
  const record = await check.run(f.options);
  assert.deepEqual({ ...record, at: null, seconds: null }, { version: '2.1.999', mod: check.modHash(), at: null, seconds: null, exit: 0, pass: 7, fail: 0, tests: 7, files: 1, failed: [], engine: [] });
  assert.equal(check.passed(record), true); assert.equal(check.complete(record, check.modHash()), true);
  assert.deepEqual(fs.readdirSync(f.privateDir), [], 'The private copy is removed afterwards');
});

test('the run cannot reach the network, a local socket, the keychain or the person\'s Claude configuration, and writes only in its own folder', mac, async t => {
  const reached = [], server = net.createServer(socket => { reached.push('network'); socket.destroy(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  // A stand-in home, with the per-start folder inside it and a local socket like NAW's own beside the run's folder.
  // (A short path, as the service's own per-start folder has: a local socket's path is limited to about a hundred bytes.)
  const home = fs.realpathSync(fs.mkdtempSync('/tmp/naw-mod-check-home-')), real = process.env.HOME;
  process.env.HOME = home; t.after(() => { process.env.HOME = real; fs.rmSync(home, { recursive: true, force: true }); });
  const privateDir = path.join(home, 'private'); fs.mkdirSync(privateDir);
  fs.mkdirSync(path.join(home, '.claude')); fs.writeFileSync(path.join(home, '.claude', 'settings.json'), 'private'); fs.writeFileSync(path.join(home, '.claude.json'), 'private'); fs.writeFileSync(path.join(home, 'other'), 'readable');
  const sock = path.join(privateDir, 'hooks.sock'), local = net.createServer(socket => { reached.push('local'); socket.destroy(); });
  await new Promise(resolve => local.listen(sock, resolve)); t.after(() => local.close());
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'naw-mod-check-outside-'))); t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const port = server.address().port;
  // Outside the sandbox both connections succeed, so the refusals below are the sandbox's.
  execFileSync('/usr/bin/nc', ['-z', '-w', '2', '127.0.0.1', String(port)], { stdio: 'ignore' }); execFileSync('/usr/bin/nc', ['-w', '2', '-U', sock], { stdio: 'ignore' });
  await sleep(100); assert.deepEqual(reached.sort(), ['local', 'network']); reached.length = 0;
  const f = fixture(t, [
    `! /usr/bin/nc -z -w 2 127.0.0.1 ${port} 2>/dev/null; ok "no network connection" $?`, `! /usr/bin/nc -w 2 -U '${sock}' </dev/null 2>/dev/null; ok "no local socket" $?`,
    `! /usr/bin/touch '${home}/outside' 2>/dev/null; ok "no write in the home folder" $?`, `! /usr/bin/touch '${outside}/file' 2>/dev/null; ok "no write outside the home folder" $?`,
    `! /usr/bin/touch '${privateDir}/beside' 2>/dev/null; ok "no write beside its own folder" $?`, `! /bin/rm '${sock}' 2>/dev/null; ok "no removal beside its own folder" $?`,
    `! /bin/cat '${home}/.claude/settings.json' >/dev/null 2>&1; ok "the Claude configuration folder is unreadable" $?`, `! /bin/cat '${home}/.claude.json' >/dev/null 2>&1; ok "the Claude state file is unreadable" $?`,
    `/bin/cat '${home}/other' >/dev/null 2>&1; ok "other files stay readable" $?`,
    // The probe scripts/fixtures/loopback-model.cjs uses: with the keychain service denied, a search for an item that
    // does not exist cannot even be created. Its control is the mutation that removes the denial.
    '/usr/bin/security find-generic-password -s naw-mod-check-nonexistent-item 2>&1 | /usr/bin/grep -q SecKeychainSearchCreateFromAttributes; ok "the keychain service is unreachable" $?',
    'echo probe > /dev/null; ok "/dev stays writable" $?', '/usr/bin/touch "$HOME/inside" "$TMPDIR/inside" "$3/inside"; ok "its own folder stays writable" $?', 'summary'].join('\n'));
  const record = await check.run({ ...f.options, privateDir });
  assert.deepEqual([record.failed, record.pass, record.exit], [[], 12, 0], JSON.stringify(record));
  assert.deepEqual(reached, []); assert.deepEqual(fs.readdirSync(outside), []); assert.deepEqual(fs.readdirSync(privateDir), ['hooks.sock']);
  assert.equal(fs.existsSync(path.join(home, 'outside')), false);
});

test('a failing version is recorded with its failed tests and the engine message; an unreadable output keeps a note', mac, async t => {
  const failing = fixture(t, say(FAIL) + '\nexit 1'), record = await check.run(failing.options);
  assert.deepEqual([record.exit, record.pass, record.fail, record.tests, record.failed.length, record.engine.length], [1, 1, 2, 3, 2, 1]);
  assert.equal(check.passed(record), false); assert.equal(check.complete(record, record.mod), true);
  assert.match(check.describe(record), /^1 pass \/ 2 fail of 3 in 1 files, exit 1; first failure: keeps the original input; engine: .*is not a function\.$/);
  const unknown = fixture(t, `echo "error: unknown command at $3/hooks/register.js" >&2\nexit 2`), other = await check.run(unknown.options);
  assert.deepEqual([other.exit, other.tests, other.note], [2, null, 'error: unknown command at /mod/hooks/register.js'], 'The private path is not kept');
  assert.equal(check.passed(other), false); assert.equal(check.complete(other, other.mod), true); assert.match(check.describe(other), /^no test summary, exit 2: error: unknown command/);
  const zero = fixture(t, say(' 0 pass\n 0 fail\nRan 0 tests across 0 files.'));
  assert.equal(check.passed(await check.run(zero.options)), false, 'No test run is not a pass');
});

test('the time limit ends the whole process group, and the result is not kept as complete', mac, async t => {
  const f = fixture(t, '/bin/sleep 30 &\nCHILD=$!\n/usr/bin/printf "fixture-started\\nchild=%s\\n" "$CHILD"\necho "$CHILD" > "$HOME/child-ready"\nwait');
  const stop = new AbortController(), completed = {};
  t.signal.addEventListener('abort', () => stop.abort(), { once: true });
  // Keep the real sandbox, pipes, process group and SIGKILL. Advance only the
  // deadline after the script proves it created its child and printed the PID.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const running = f.running = check.run({ ...f.options, timeoutMs: 600, signal: stop.signal });
  running.then(value => { completed.value = value; });
  try {
    const expectedChild = Number(await readyFile(f, 'child-ready', completed)); assert.ok(expectedChild > 1);
    const before = Date.now(); t.mock.timers.tick(600); const record = await running;
    // A child left alive would hold the output open until it ends by itself.
    assert.ok(Date.now() - before < 5000, 'The run returns at the limit');
    assert.deepEqual([record.timedOut, record.exit, record.signal], [true, null, 'SIGKILL']);
    assert.equal(check.complete(record, record.mod), false); assert.equal(check.describe(record), 'stopped at the time limit');
    const children = (record.note || '').split('\n').map(line => line.match(/^child=(\d+)$/)).filter(Boolean);
    assert.equal(children.length, 1, 'PID output survives deadline termination: ' + JSON.stringify(record));
    const child = Number(children[0][1]); assert.equal(child, expectedChild);
    assert.match(record.note, /^fixture-started$/m);
    // The kill reaches the whole group at once, but a busy machine can take a while to let the child go: wait for
    // that, bounded, instead of guessing how long it takes.
    const gone = () => { try { process.kill(child, 0); return false; } catch (error) { return error.code === 'ESRCH'; } };
    for (const deadline = Date.now() + 5000; !gone() && Date.now() < deadline;) await realSleep(25);
    assert.throws(() => process.kill(child, 0), { code: 'ESRCH' }, 'The program\'s own child is gone too');
    assert.deepEqual(fs.readdirSync(f.privateDir), []);
  } finally { stop.abort(); await running; }
});

test('a deadline before the fixture prints a child PID is incomplete with no invented output', mac, async t => {
  const f = fixture(t, 'echo ready > "$HOME/before-output"\nwhile [ ! -f "$HOME/release-startup" ]; do /bin/sleep 0.02; done\necho child=unreachable');
  const stop = new AbortController(), completed = {};
  t.signal.addEventListener('abort', () => stop.abort(), { once: true });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const running = f.running = check.run({ ...f.options, timeoutMs: 600, signal: stop.signal });
  running.then(value => { completed.value = value; });
  try {
    await readyFile(f, 'before-output', completed); t.mock.timers.tick(600);
    const record = await running;
    assert.deepEqual([record.timedOut, record.exit, record.signal, record.note], [true, null, 'SIGKILL', ''], JSON.stringify(record));
    assert.equal(check.complete(record, record.mod), false); assert.deepEqual(fs.readdirSync(f.privateDir), []);
  } finally { stop.abort(); await running; }
});

test('when the sandbox is missing or cannot start the program nothing runs, and the record says why', mac, async t => {
  const f = fixture(t, 'summary'), record = await check.run({ ...f.options, sandbox: path.join(f.dir, 'no-sandbox-here') });
  assert.match(record.reason, /ENOENT/); assert.equal(record.exit, undefined);
  assert.equal(check.complete(record, record.mod), false); assert.match(check.describe(record), /^not run \(/);
  assert.deepEqual(fs.readdirSync(f.privateDir), []);
  // The sandbox's own refusal is not the program's exit: the next start tries again.
  const absent = await check.run({ ...f.options, binary: path.join(f.dir, 'no-such-program') });
  assert.match(absent.reason, /^sandbox-exec: /); assert.equal(absent.exit, undefined); assert.equal(check.complete(absent, absent.mod), false);
  const missing = await check.run({ ...f.options, dir: f.dir });
  assert.match(missing.reason, /ENOENT/, 'Missing mod files are a reason, not an exception'); assert.equal(missing.mod, null);
  const kept = await check.checkOnce({ file: f.file, ...f.options, dir: f.dir });
  assert.match(kept.reason, /ENOENT/); assert.deepEqual(check.load(f.file), { '2.1.999': kept }, 'A run that could not happen is recorded too');
});

test('a completed result is kept per version and mod, and run again only when the mod or its tests change', mac, async t => {
  const f = fixture(t, COPY + '\nsummary');
  const first = await check.checkOnce({ file: f.file, ...f.options });
  assert.deepEqual([first.pass, first.failed], [1, []]); assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  assert.deepEqual(check.load(f.file), { '2.1.999': first });
  assert.equal(await check.checkOnce({ file: f.file, ...f.options }), null, 'The stored result stands'); assert.deepEqual(check.load(f.file), { '2.1.999': first });
  assert.equal((await check.checkOnce({ file: f.file, ...f.options, version: '2.1.998' })).version, '2.1.998');
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
  assert.notEqual(again.mod, first.mod); assert.deepEqual([again.pass, again.failed], [1, []], 'The copy made from the runtime layout holds the same seven files');
  // A run that did not finish, or a record that cannot be read, is tried again.
  check.save(f.file, { ...first, exit: null, timedOut: true });
  assert.equal((await check.checkOnce({ file: f.file, ...f.options })).exit, 0);
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
  assert.ok(packaged.includes("'claude-mod-check.cjs'") && client.includes("'claude-mod-check.cjs'"), 'The module itself is copied and packaged; the service loads it at start');
});

test('NAW runs the check once when a session starts under an unqualified launcher, and never for a qualified or chosen program', mac, async t => {
  const { Claude, NativeHost } = require('../adapters.cjs');
  const f = fixture(t, ''), versions = path.join(f.dir, 'versions'), bin = path.join(f.dir, 'bin'), data = path.join(f.dir, 'data'), ran = path.join(f.dir, 'ran');
  for (const folder of [versions, bin, data]) fs.mkdirSync(folder);
  // A session's program notes its start in a file (the check's sandbox allows no such write). Asked for the
  // plugin tests, a program names the file it was started as, in a failed test line.
  for (const v of ['2.1.322', '2.1.999']) fs.writeFileSync(path.join(versions, v), `#!/bin/sh\n${HELPERS}\nif [ "$1 $2" = "plugin test" ]; then ok "version file" 0; ok "started as $0" 1; summary; exit 1; fi\necho "${v} $1" >> '${ran}'\n`, { mode: 0o700 });
  const launcher = path.join(bin, 'claude'), point = v => { fs.rmSync(launcher, { force: true }); fs.symlinkSync(path.join(versions, v), launcher); };
  const host = (extra = {}) => ({ binaries: { claude: launcher }, privateDir: f.privateDir, dataDir: data, hookTargets: new Map(), hookSocket: path.join(f.privateDir, 'hook.sock'), submitSocket: path.join(f.privateDir, 'submit.sock'),
    claudeModChecks: new Map(), serviceBinding: null, closed: false, checkClaudeVersion: NativeHost.prototype.checkClaudeVersion, ...extra });
  const start = async h => { const r = new Claude({ id: randomUUID(), nativeId: randomUUID(), name: 'New', cwd: f.dir }, h); await new Promise(resolve => r.terminal.once('closed', resolve)); r.submission.close(); };
  const sessions = () => fs.readFileSync(ran, 'utf8').trim().split('\n'), file = path.join(data, 'claude-mod-check.json'), stored = v => check.load(file)[v];
  point('2.1.999'); const h = host();
  await start(h); await h.claudeModChecks.get('2.1.999').done;
  assert.deepEqual(sessions(), ['2.1.322 --session-id'], 'The session runs the fallback; the new version runs only the tests');
  const first = stored('2.1.999');
  assert.deepEqual([first.pass, first.fail, first.exit, first.mod, first.failed], [1, 1, 1, check.modHash(), ['started as ' + path.join(versions, '2.1.999')]], 'The tests run the version file the record names, not the launcher');
  assert.equal(fs.existsSync(path.join(f.privateDir, 'claude-mod-check.json')), false, 'The record is kept with the persistent data');
  // Another session in this start, and a new start of NAW, find that result and run nothing.
  await start(h); const next = host(); await start(next); await next.claudeModChecks.get('2.1.999').done;
  assert.equal(stored('2.1.999').at, first.at); assert.equal(sessions().length, 3);
  for (const idle of [host({ serviceBinding: {} }), host({ closed: true })]) { fs.rmSync(file, { force: true }); idle.checkClaudeVersion(); assert.equal(idle.claudeModChecks.size, 0); }
  point('2.1.322'); const qualified = host(); await start(qualified); assert.equal(qualified.claudeModChecks.size, 0, 'A qualified version is not checked');
  const exact = host({ binaries: { claude: path.join(versions, '2.1.999') } }); exact.checkClaudeVersion(); assert.equal(exact.claudeModChecks.size, 0, 'A program the person chose is theirs');
  assert.equal(fs.existsSync(file), false);
  // Two sessions starting while the first check still runs, or after a run with no summary, share that one run.
  fs.writeFileSync(path.join(versions, '2.1.998'), '#!/bin/sh\n/bin/sleep 1\nexit 3\n', { mode: 0o700 });
  point('2.1.998'); const busy = host(); busy.checkClaudeVersion(); await sleep(50);
  const later = new Date().toISOString(); busy.checkClaudeVersion();
  await busy.claudeModChecks.get('2.1.998').done; busy.checkClaudeVersion(); await busy.claudeModChecks.get('2.1.998').done;
  assert.deepEqual([stored('2.1.998').exit, stored('2.1.998').tests], [3, null], 'A run with no summary is still recorded');
  assert.ok(stored('2.1.998').at < later, 'The record is the first call\'s run: no second run started');
});

test('closing NAW ends a running check and keeps no record of it', mac, async t => {
  const f = fixture(t, '/bin/sleep 30'), stop = new AbortController();
  const pending = check.checkOnce({ file: f.file, ...f.options, signal: stop.signal });
  // The program itself, after the sandbox has started it: the sandbox's own command line names the program too.
  const running = () => execFileSync('/bin/ps', ['-axo', 'command='], { encoding: 'utf8' }).split('\n').some(line => line.includes(f.program) && !line.includes('sandbox-exec'));
  for (let i = 0; i < 100 && !running(); i++) await sleep(30);
  assert.equal(running(), true, 'The program is running');
  const before = Date.now(); stop.abort();
  assert.equal(await pending, null); assert.ok(Date.now() - before < 5000);
  await sleep(100); assert.equal(running(), false, 'The program is gone');
  assert.equal(fs.existsSync(f.file), false); assert.deepEqual(fs.readdirSync(f.privateDir), []);
  assert.equal(await check.checkOnce({ file: f.file, ...f.options, signal: stop.signal }), null, 'Nothing starts once NAW is closing');
  assert.equal(fs.existsSync(f.file), false);
});
