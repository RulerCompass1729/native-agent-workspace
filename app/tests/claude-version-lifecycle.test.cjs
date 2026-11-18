const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const cp = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { processIdentity, pythonExecutable } = require('../platform.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const same = identity => identity && processIdentity(identity.pid)?.started === identity.started;
const group = pid => Number(cp.execFileSync('/bin/ps', ['-p', String(pid), '-o', 'pgid='], { encoding: 'utf8' }).trim());
async function until(read, description, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (read()) return; await delay(20); }
  throw Error(description);
}
async function fixture(t, { escapeGroup = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-version-life-'));
  const binary = path.join(directory, 'version-only'), marker = path.join(directory, 'started.json'), nonce = randomUUID();
  const program = escapeGroup ? '#!' + pythonExecutable() + '\nimport os,sys,signal,json,time\nassert sys.argv[1:] == ["--version"]\nos.setsid()\n' +
    'signal.signal(signal.SIGTERM,lambda *_:None)\nsignal.signal(signal.SIGHUP,lambda *_:None)\nsignal.signal(signal.SIGUSR2,lambda *_:sys.exit(0))\n' +
    'open(' + JSON.stringify(marker) + ',"w").write(json.dumps({"pid":os.getpid(),"ppid":os.getppid(),"home":os.environ["HOME"],"nonce":' + JSON.stringify(nonce) + '}))\nwhile True: time.sleep(1)\n'
    : '#!' + process.execPath + '\n' +
    'const fs=require("node:fs"),assert=require("node:assert/strict");assert.deepEqual(process.argv.slice(2),["--version"]);\n' +
    'process.on("SIGTERM",()=>{});process.on("SIGHUP",()=>{});process.on("SIGUSR2",()=>process.exit(0));\n' +
    'fs.writeFileSync(' + JSON.stringify(marker) + ',JSON.stringify({pid:process.pid,ppid:process.ppid,home:process.env.HOME,nonce:' + JSON.stringify(nonce) + '}));setInterval(()=>{},1000);\n';
  fs.writeFileSync(binary, program, { mode: 0o700 });
  const source = path.resolve(__dirname, '../claude-qualification.cjs'), box = { exports: {} };
  let worker, owner, workerIdentity, versionIdentity, receipt;
  vm.runInNewContext(fs.readFileSync(source, 'utf8'), {
    module: box, exports: box.exports, __dirname: path.dirname(source), process, console, AbortController, performance, setTimeout, clearTimeout,
    require: name => name === 'node:child_process' ? { fork: (file, args, options) => {
      owner = JSON.parse(args[2]); worker = cp.fork(file, args, options); workerIdentity = processIdentity(worker.pid); return worker;
    } } : name.startsWith('.') ? require(path.resolve(path.dirname(source), name)) : require(name),
  }, { filename: source });
  const controller = new AbortController();
  const pending = box.exports.nativeJourneys({ binary, version: '2.1.328', privateDir: directory, timeoutMs: 60000, signal: controller.signal })
    .then(value => ({ value }), error => ({ error: error.message }));
  t.after(async () => {
    controller.abort();
    // Fixtures own both identities. Never signal an old/reused PID during a failed test.
    if (same(workerIdentity)) process.kill(workerIdentity.pid, 'SIGCONT');
    if (same(versionIdentity)) process.kill(versionIdentity.pid, 'SIGUSR2');
    await pending;
    if (versionIdentity) await until(() => !same(versionIdentity), 'Fixture version process did not exit');
    if (versionIdentity) assert.equal(Boolean(same(versionIdentity)), false, 'Fixture must leave no version process');
    assert.equal(fs.existsSync(owner.root), false, 'Fixture root must be gone only after cleanup');
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await until(() => fs.existsSync(marker), 'The real worker did not execute the synthetic --version');
  receipt = JSON.parse(fs.readFileSync(marker, 'utf8'));
  assert.equal(receipt.nonce, nonce); assert.equal(receipt.ppid, worker.pid);
  versionIdentity = processIdentity(receipt.pid); assert.ok(versionIdentity);
  return { worker, owner, receipt, versionIdentity, controller, pending };
}

test('real worker cancellation reaps an uncooperative version program before returning or deleting HOME', { timeout: 40000 }, async t => {
  const f = await fixture(t);
  process.kill(f.versionIdentity.pid, 'SIGTERM'); await delay(40);
  assert.equal(same(f.versionIdentity), true, 'Synthetic --version deliberately ignores TERM');
  f.controller.abort(); const outcome = await f.pending;
  assert.equal(outcome.error, 'cancelled');
  assert.equal(Boolean(same(f.versionIdentity)), false, 'Returning from the parent must prove version exit');
  assert.equal(fs.existsSync(f.owner.root), false);
});

test('real worker retains the real 15s version timeout and reaps a program ignoring TERM', { timeout: 40000 }, async t => {
  const started = Date.now(), f = await fixture(t), outcome = await f.pending;
  assert.ok(Date.now() - started >= 14900, 'The production 15s timeout is not accelerated');
  assert.equal(outcome.value.passed, false); assert.equal(outcome.value.reason, 'native-startup');
  assert.equal(Boolean(same(f.versionIdentity)), false); assert.equal(fs.existsSync(f.receipt.home), false);
});

test('real 20s force cleanup of a stopped worker ends its owned version group before settling', { timeout: 45000 }, async t => {
  const f = await fixture(t);
  assert.equal(group(f.worker.pid), f.worker.pid, 'The worker owns a separate group');
  assert.equal(group(f.versionIdentity.pid), f.worker.pid);
  assert.notEqual(group(f.worker.pid), group(process.pid), 'Never signal the service/test group');
  process.kill(f.worker.pid, 'SIGSTOP');
  const started = Date.now(); f.controller.abort();
  await delay(100); assert.equal(same(f.versionIdentity), true); assert.equal(fs.existsSync(f.receipt.home), true);
  const outcome = await f.pending;
  assert.ok(Date.now() - started >= 19900, 'The production 20s cleanup grace is not accelerated');
  assert.equal(outcome.error, 'cancelled'); assert.equal(f.worker.signalCode, 'SIGKILL');
  assert.equal(Boolean(same(f.versionIdentity)), false); assert.equal(fs.existsSync(f.owner.root), false);
});

test('real 20s forced worker cleanup also reaps its registered version after that program changes groups', { timeout: 45000 }, async t => {
  const f = await fixture(t, { escapeGroup: true });
  assert.equal(group(f.versionIdentity.pid), f.versionIdentity.pid);
  assert.notEqual(group(f.versionIdentity.pid), group(f.worker.pid));
  process.kill(f.worker.pid, 'SIGSTOP');
  const started = Date.now(); f.controller.abort(); const outcome = await f.pending;
  assert.ok(Date.now() - started >= 19900);
  assert.equal(outcome.error, 'cancelled'); assert.equal(Boolean(same(f.versionIdentity)), false);
  assert.equal(fs.existsSync(f.owner.root), false);
});

test('force cleanup never signals a reused worker identity, a released child, or the service group', async () => {
  const source = path.resolve(__dirname, '../claude-qualification.cjs'), box = { exports: {} }, signals = [];
  let current = { pid: 424242, started: 'original' }, pgid = current.pid;
  vm.runInNewContext(fs.readFileSync(source, 'utf8') + '\nmodule.exports.testForceWorker = forceWorker;module.exports.testStopVersion = stopVersionProcess;module.exports.testVersionExited = versionProcessExited;', {
    module: box, exports: box.exports, __dirname: path.dirname(source), console, AbortController, performance, setTimeout, clearTimeout,
    process: { pid: process.pid, kill: (...args) => signals.push(args), getuid: () => process.getuid() },
    require: name => name === './platform.cjs' ? { processIdentity: () => current, processGroup: () => pgid }
      : name.startsWith('.') ? require(path.resolve(path.dirname(source), name)) : require(name),
  }, { filename: source });
  const child = { pid: 424242, exitCode: null, signalCode: null }, owned = { ...current };
  child.pid++; assert.equal(box.exports.testForceWorker(child, owned), false); child.pid--;
  current = { ...current, started: 'reused' }; assert.equal(box.exports.testForceWorker(child, owned), false);
  current = { ...owned }; child.exitCode = 0; assert.equal(box.exports.testForceWorker(child, owned), false);
  child.exitCode = null; pgid = process.pid; assert.equal(box.exports.testForceWorker(child, owned), false);
  assert.deepEqual(signals, []);
  pgid = owned.pid; assert.equal(box.exports.testForceWorker(child, owned), true);
  assert.deepEqual(signals, [[owned.pid, 'SIGKILL']]);
  signals.length = 0; current = { ...owned, started: 'reused' };
  assert.equal(box.exports.testStopVersion(owned), false);
  assert.equal(box.exports.testStopVersion({ pid: owned.pid }), false);
  assert.equal(box.exports.testStopVersion({ pid: process.pid, started: owned.started }), false);
  assert.deepEqual(signals, []);
  current = { ...owned }; assert.equal(box.exports.testStopVersion(owned), true);
  assert.deepEqual(signals, [[owned.pid, 'SIGKILL']]);
  signals.length = 0; current = null; let finished = false;
  const unknown = box.exports.testVersionExited(owned).then(() => { finished = true; });
  await delay(40); assert.equal(finished, false, 'An unknown identity is not an exit proof');
  assert.ok(signals.every(([, signal]) => signal === 0));
  current = { ...owned, started: 'reused' }; await unknown;
  assert.ok(signals.every(([, signal]) => signal === 0), 'Never signal the replacement PID');
});
