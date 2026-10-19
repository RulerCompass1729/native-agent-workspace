const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { NativeHost } = require('../adapters.cjs');

test('a failed Codex executable can be corrected after its own child has exited', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-start-'));
  const host = new NativeHost(dir);
  t.after(() => { host.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const bad = path.join(dir, 'bad'); fs.writeFileSync(bad, '#!/bin/sh\nexit 2\n', { mode: 0o700 });
  host.binaries.codex = bad;
  await assert.rejects(host.startCodex(), /后台未能启动/);
  assert.equal(host.starting, null); assert.equal(host.codexBinary, null); assert.equal(host.codexProcess, null);
  const good = path.join(dir, 'good');
  fs.writeFileSync(good, `#!${process.execPath}\nconst http=require('node:http');
const {WebSocketServer}=require(${JSON.stringify(require.resolve('ws'))});
const server=http.createServer(),ws=new WebSocketServer({server});
ws.on('connection',s=>s.on('message',data=>{const m=JSON.parse(data);if(m.id)s.send(JSON.stringify({id:m.id,result:{userAgent:'synthetic-no-model'}}))}));
server.listen(process.argv.at(-1).slice(7));\n`, { mode: 0o700 });
  host.binaries.codex = good;
  await host.startCodex();
  assert.equal(host.codexBinary, good); assert.ok(host.rpc);
  const pid = host.codexProcess.pid; await host.startCodex(); assert.equal(host.codexProcess.pid, pid);
  host.close(); await new Promise(resolve => host.codexProcess.once('exit', resolve));
});
