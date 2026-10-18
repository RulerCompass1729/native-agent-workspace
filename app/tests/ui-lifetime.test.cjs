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
