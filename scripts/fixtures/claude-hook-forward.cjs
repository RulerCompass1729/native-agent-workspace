// Runs NAW's real Claude hook forwarder (app/claude_hook.py) on one hook payload, as Claude runs it, and returns what
// reached NAW's socket and what the forwarder printed. Loopback only: a unix socket in a fresh temporary folder.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process');

async function runForwarder(message, { appRoot = path.resolve(__dirname, '../..') } = {}) {
  const { pythonExecutable } = require(path.join(appRoot, 'app/platform.cjs'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-hook-')), socket = path.join(dir, 'h.sock');
  const received = [];
  const server = net.createServer(c => { let body = ''; c.on('data', d => { body += d; }); c.on('end', () => received.push(body)); });
  try {
    await new Promise(resolve => server.listen(socket, resolve));
    const child = spawn(pythonExecutable(), ['-I', path.join(appRoot, 'app/claude_hook.py')], {
      env: { PATH: process.env.PATH, NAW_HOOK_SOCKET: socket, NAW_HOOK_TOKEN: 'synthetic-token' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stdin.end(JSON.stringify(message));
    await new Promise(resolve => child.on('exit', resolve));
    for (let i = 0; i < 50 && !received.length; i += 1) await new Promise(resolve => setTimeout(resolve, 20));
    return { stdout, received };
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { runForwarder };
