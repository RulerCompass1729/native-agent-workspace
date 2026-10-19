const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');
const lease = path.resolve(__dirname, '../ui-parent-lease.cjs');
const { startupMessage } = require('../ui-errors.cjs');

test('startup messages never expose upstream URLs, tokens, paths, or error text', () => {
  const privateValue = 'SYNTHETIC_PRIVATE_VALUE';
  for (const code of ['ERR_FAILED', 'NAW_NODE_MISSING', 'NAW_UI_BUSY', '__proto__', privateValue]) {
    const message = startupMessage({ code, message: `loading http://localhost/?token=${privateValue}` });
    assert.equal(typeof message, 'string');
    assert.ok(!message.includes(privateValue));
    assert.ok(!message.includes('http:'));
  }
});

test('an unowned UI host cannot start', async () => {
  const child = spawn(process.execPath, ['--require', lease, '-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const result = await once(child, 'exit');
  assert.equal(result[0], 1);
});

test('desktop disconnect ends only its UI host, including a stuck shutdown handler', { timeout: 7000 }, async () => {
  const sibling = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const child = spawn(process.execPath, ['--require', lease, '-e', "process.on('SIGTERM',()=>{});process.send({ready:true});setInterval(()=>{},1000)"], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  try {
    await once(child, 'message');
    const closed = once(child, 'exit'); child.disconnect();
    const result = await closed;
    assert.equal(result[0], 0);
    assert.doesNotThrow(() => process.kill(sibling.pid, 0));
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    sibling.kill('SIGTERM');
  }
});

test('headed startup isolates before windows and rejects unsafe test flags before locking', () => {
  const fs = require('node:fs'), os = require('node:os'), vm = require('node:vm'), { createRequire } = require('node:module');
  const main = path.resolve(__dirname, '../main.cjs'), nativeRequire = createRequire(main);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-launch-policy-'));
  const normal = path.join(temp, 'normal'), isolated = path.join(temp, 'isolated'), alias = path.join(temp, 'normal-alias');
  fs.mkdirSync(normal); fs.mkdirSync(isolated, { mode: 0o700 }); fs.symlinkSync(normal, alias);
  const shared = path.join(temp, 'shared'); fs.mkdirSync(shared, { mode: 0o755 });
  try { for (const [label, env, parent, outcome] of [
    ['isolated', { NAW_DATA_DIR: isolated, NAW_TEST_PARENT_PID: '321' }, 321, 'background'],
    ['normal', {}, 321, 'normal'],
    ['missing normal profile', { NAW_DATA_DIR: isolated, NAW_TEST_PARENT_PID: '321' }, 321, 'background'],
    ['normal profile', { NAW_DATA_DIR: normal, NAW_TEST_PARENT_PID: '321' }, 321, 'reject'],
    ['normal symlink', { NAW_DATA_DIR: alias, NAW_TEST_PARENT_PID: '321' }, 321, 'reject'],
    ['wrong parent', { NAW_DATA_DIR: isolated, NAW_TEST_PARENT_PID: '321' }, 322, 'reject'],
    ['invalid flag', { NAW_DATA_DIR: isolated, NAW_TEST_PARENT_PID: 'bad' }, 321, 'reject'],
    ['missing profile', { NAW_TEST_PARENT_PID: '321' }, 321, 'reject'],
    ['nonprivate mode', { NAW_DATA_DIR: shared, NAW_TEST_PARENT_PID: '321' }, 321, 'reject'],
  ]) {
    const calls = [], noop = () => {};
    const electron = {
      app: { setName: noop, getVersion: () => 'fixture', commandLine: { appendSwitch: noop }, getPath: () => label === 'missing normal profile' ? path.join(temp, 'not-created') : normal, setPath: noop,
        setActivationPolicy: p => calls.push(['policy', p]), requestSingleInstanceLock: () => { calls.push(['lock']); return false; }, quit: noop, on: noop, whenReady: () => ({ then: noop }) },
      ipcMain: { handle: noop },
      BrowserWindow: class { constructor(options) { this.options = options; calls.push(['window']); } showInactive() { calls.push(['inactive']); } show() { calls.push(['show']); } focus() { calls.push(['focus']); } isDestroyed() { return false; } isMinimized() { return false; } },
    };
    const context = vm.createContext({ require: n => n === 'electron' ? electron : nativeRequire(n), __dirname: path.dirname(main), process: { env, ppid: parent, platform: 'darwin', getuid: process.getuid, exit: () => { throw Error('TEST_EXIT'); } }, URL, setInterval: () => ({ unref: noop }), console: { error: noop } });
    const load = () => vm.runInContext(fs.readFileSync(main, 'utf8'), context);
    if (outcome === 'reject') { assert.throws(load, /TEST_EXIT/, label); assert.deepEqual(calls, [], label); continue; }
    load();
    const options = vm.runInContext('startupWindow = createWindow({ bounds: { show: true, focusable: true } }); focusOrOpen(); startupWindow.options', context);
    const background = outcome === 'background';
    assert.equal(options.show, background ? false : true, label);
    assert.equal(options.focusable, background ? false : true, label);
    assert.deepEqual(calls, background ? [['policy', 'accessory'], ['lock'], ['window']] : [['lock'], ['window'], ['show'], ['focus']], label);
  } } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
