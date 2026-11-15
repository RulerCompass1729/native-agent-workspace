const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { Workspace } = require('../workspace.cjs'), { Codex } = require('../adapters.cjs');
test('only native-reported vendor identity is exposed and saved, separately from the shell', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-vendor-'));
  const host = { binaries: {}, close() {}, create() { const r = new EventEmitter(); r.start = async () => r.emit('state', 'idle'); return r; } };
  const w = new Workspace(host, directory); t.after(() => { w.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const id = await w.create('codex', directory, 'owner', 'DeepSeek is only a name', 'chat');
  const read = () => w.snapshot().sessions.find(s => s.id === id);
  assert.equal(read().vendor, null, 'Never infer the model vendor from the session name');
  assert.equal(read().shell, 'codex');
  w.runtimes.get(id).emit('modelProvider', 'deepseek');
  assert.equal(read().vendor, 'deepseek');
  assert.equal(JSON.parse(w.storeSnapshot().workspace).sessions.find(s => s.id === id).modelProvider, 'deepseek');
  for (const invalid of ['../other', 'a'.repeat(65), '', {}, null]) w.runtimes.get(id).emit('modelProvider', invalid);
  assert.equal(read().vendor, 'deepseek');
  const claude = await w.create('claude', directory, 'owner', 'Research', 'chat');
  assert.equal(w.snapshot().sessions.find(s => s.id === claude).vendor, 'anthropic');
});
test('Codex learns the vendor only from its own thread, without overwriting newer settings', () => {
  const runtime = Object.create(Codex.prototype), observed = [];
  Object.assign(runtime, { record: { nativeId: 'owned-thread' }, nativeSettings: { revision: 2 }, emit: (...args) => observed.push(args), observeSettings() { throw Error('Newer settings must survive'); } });
  runtime.observeReplySettings({ thread: { id: 'other-thread' }, modelProvider: 'openai' }, null, {});
  assert.deepEqual(observed, []);
  runtime.observeReplySettings({ thread: { id: 'owned-thread', modelProvider: 'deepseek' } }, null, {});
  assert.deepEqual(observed, [['modelProvider', 'deepseek']]);
});
