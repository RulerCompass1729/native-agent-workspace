const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), cp = require('node:child_process');
const source = fs.readFileSync(require.resolve('../butler-dsh-host.mjs'), 'utf8');
const closeSource = source.slice(source.indexOf('async function close()'), source.indexOf("process.on('SIGTERM'"));
test('host hard deadline is unreferenced and armed before a hanging dispose', () => {
  let timer, disposed = false, exits = [];
  vm.runInNewContext(closeSource + '; close(); close();', {
    closing: false, handle: { dispose() { disposed = true; return new Promise(() => {}); } }, ctx: null,
    setTimeout(fn, ms) { assert.equal(timer, undefined); timer = { fn, ms, referenced: true }; return { unref() { timer.referenced = false; } }; },
    process: { pid: 123, kill(pid, signal) { assert.equal(pid, -123); assert.equal(signal, 'SIGKILL'); }, exit(code) { exits.push(code); } },
  });
  assert.equal(disposed, true); assert.ok(timer, 'Hanging disposal must have a hard deadline');
  assert.equal(timer.referenced, false); assert.ok(timer.ms > 0 && timer.ms < 3000);
  timer.fn(); assert.deepEqual(exits, [1]);
});
test('actual host close function exits a subprocess with live handles and hung disposal', () => {
  const result = cp.spawnSync(process.execPath, ['-e',
    'let closing=false,handle={dispose:()=>new Promise(()=>{})},ctx=null;setInterval(()=>{},1000);' + closeSource + '; close();'],
    { detached: true, timeout: 5000, env: { PATH: '/usr/bin:/bin' } });
  assert.equal(result.error, undefined); assert.equal(result.status, null); assert.equal(result.signal, 'SIGKILL');
});
test('unreferenced deadline alone does not delay natural process exit', () => {
  const result = cp.spawnSync(process.execPath, ['-e',
    'let closing=false,handle={dispose:()=>new Promise(()=>{})},ctx=null;' + closeSource + '; close();'],
    { timeout: 1000, env: { PATH: '/usr/bin:/bin' } });
  assert.equal(result.error, undefined); assert.equal(result.status, 0);
});

test('the launcher refuses a host that is not an owned detached process group', () => {
  const result = cp.spawnSync('/usr/bin/python3', ['-I', require.resolve('../butler-dsh-launch.py'), process.execPath, '/nonexistent-host', '/synthetic-home'],
    { env: { PATH: '/usr/bin:/bin', NAW_BUTLER_PROCESS_GROUP: 'forged' } });
  assert.equal(result.status, 1); assert.equal(String(result.stderr), '', 'Refuse before exec or touching a home');
});
