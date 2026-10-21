const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const path = require('node:path');
const { pythonExecutable } = require('../platform.cjs');

const frame = value => Buffer.from(JSON.stringify(value) + '\n');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const reader = `import os,signal,json,fcntl,termios,struct
signal.alarm(4)
os.write(1,b'CHILD_READY\\n')
data=b''
while not data.endswith(b'\\n'):
 data+=os.read(0,4096)
size=struct.unpack('HHHH',fcntl.ioctl(0,termios.TIOCGWINSZ,b'\\0'*8))
os.write(1,('RESULT:'+json.dumps({'text':data.decode('utf-8'),'rows':size[0],'cols':size[1]})+'\\n').encode())
`;
function boot(t, source = reader) {
  const python = pythonExecutable(); assert.ok(python, 'A real Python runtime is required');
  const child = spawn(python, [path.join(__dirname, '../pty_host.py')], { stdio: ['pipe', 'pipe', 'pipe'] });
  const records = [], decoder = new StringDecoder('utf8'); let pending = '', stderr = '', text = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => {
    pending += chunk;
    for (let at; (at = pending.indexOf('\n')) >= 0;) {
      const row = JSON.parse(pending.slice(0, at)); pending = pending.slice(at + 1); records.push(row);
      if (row.type === 'data') text += decoder.write(Buffer.from(row.data, 'base64'));
    }
  });
  child.stdin.on('error', () => {});
  const closed = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => resolve(code)); });
  t.after(async () => { if (child.exitCode === null) child.stdin.end(); await closed; });
  return { child, closed, records, text: () => text, stderr: () => stderr,
    config: frame({ argv: [python, '-c', source], cwd: path.resolve(__dirname, '../..'), env: { SYNTHETIC_LABEL: '启动边界' } }) };
}
async function result(p) {
  assert.equal(await p.closed, 0, p.stderr());
  assert.equal(p.stderr(), '');
  assert.equal(p.records.find(row => row.type === 'exit')?.code, 0, p.text());
  const line = p.text().split(/\r?\n/).find(line => line.startsWith('RESULT:'));
  assert.ok(line, p.text()); return JSON.parse(line.slice(7));
}
async function ready(p) {
  for (let i = 0; i < 150 && !p.text().includes('CHILD_READY'); i++) await delay(10);
  assert.ok(p.text().includes('CHILD_READY'), p.stderr());
}
test('configuration and input in one pipe write reach the real PTY exactly once', async t => {
  const p = boot(t);
  p.child.stdin.write(Buffer.concat([p.config, frame({ type: 'input', data: 'first-' }), frame({ type: 'input', data: '你好🌳\n' })]));
  assert.equal((await result(p)).text, 'first-你好🌳\n');
});
test('split UTF-8 configuration and command frames retain their byte boundaries', async t => {
  const p = boot(t), configSplit = p.config.indexOf(Buffer.from('启动')) + 1;
  p.child.stdin.write(p.config.subarray(0, configSplit)); await delay(20);
  const input = frame({ type: 'input', data: '分段🌳\n' }), inputSplit = input.indexOf(Buffer.from('🌳')) + 2;
  p.child.stdin.write(Buffer.concat([p.config.subarray(configSplit), input.subarray(0, inputSplit)]));
  await ready(p); p.child.stdin.write(input.subarray(inputSplit));
  assert.equal((await result(p)).text, '分段🌳\n');
});
test('a retained startup resize precedes input and later input still works', async t => {
  const p = boot(t);
  p.child.stdin.write(Buffer.concat([p.config, frame({ type: 'resize', rows: 21, cols: 71 }), frame({ type: 'input', data: 'early-' })]));
  await ready(p); p.child.stdin.write(frame({ type: 'input', data: 'later\n' }));
  assert.deepEqual(await result(p), { text: 'early-later\n', rows: 21, cols: 71 });
});
test('a later stop and input EOF both reap the owned PTY process', async t => {
  for (const how of ['stop', 'eof']) {
    const p = boot(t); p.child.stdin.write(p.config); await ready(p);
    if (how === 'stop') p.child.stdin.write(frame({ type: 'stop' })); else p.child.stdin.end();
    assert.equal(await p.closed, 0, p.stderr()); assert.equal(p.stderr(), '');
    assert.ok(Number.isInteger(p.records.find(row => row.type === 'exit')?.code));
  }
});
test('EOF before a complete configuration never starts a native process', async t => {
  const p = boot(t); p.child.stdin.end('{"argv":');
  assert.notEqual(await p.closed, 0); assert.equal(p.records.length, 0);
  assert.match(p.stderr(), /Missing terminal configuration/);
});
