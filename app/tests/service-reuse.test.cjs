const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { ensureService } = require('../service-client.cjs');

test('reusing an older live service pauses unsafe routing without replacing its native sessions', async t => {
  for (const verified of [false, true]) await t.test(verified ? 'current service' : 'legacy service', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'reuse-test-'));
    const endpoint = path.join(directory, 's.sock'), calls = [], clients = new Set();
    const state = { capabilities: verified ? ['verifiedHandoffs', 'structuredClaudeSubmit'] : ['structuredClaudeSubmit'], sessions: [{ id: 'synthetic-native-session', state: 'idle', provider: 'codex' }], room: { run: { status: 'running', ids: ['synthetic-native-session'] } } };
    const server = net.createServer(socket => {
      clients.add(socket); socket.on('close', () => clients.delete(socket)); socket.on('error', () => {});
      let buffer = '', authorized = false;
      socket.on('data', chunk => {
        buffer += chunk;
        for (let end; (end = buffer.indexOf('\n')) >= 0;) {
          const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
          if (!authorized) { authorized = true; socket.write(JSON.stringify({ ready: true }) + '\n'); continue; }
          calls.push(request.method);
          if (request.method === 'pause') state.room.run.status = 'paused';
          socket.write(JSON.stringify({ id: request.id, ok: true, value: request.method === 'initial' ? state : null }) + '\n');
        }
      });
    });
    try {
      fs.writeFileSync(path.join(directory, 'connection.json'), JSON.stringify({ protocol: 1, endpoint, token: 'synthetic-local-auth' }), { mode: 0o600 });
      await new Promise(resolve => server.listen(endpoint, resolve));
      await ensureService(directory, '/nonexistent-test-executable');
      assert.deepEqual(calls, verified ? ['initial'] : ['initial', 'pause']);
      assert.equal(state.room.run.status, verified ? 'running' : 'paused');
      assert.equal(state.sessions[0].id, 'synthetic-native-session');
    } finally {
      for (const socket of clients) socket.destroy();
      await new Promise(resolve => server.close(resolve));
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
