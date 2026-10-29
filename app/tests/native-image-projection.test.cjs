const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const { NativeHost } = require('../adapters.cjs'), { Workspace } = require('../workspace.cjs');
const { toolContent } = require('../codex-tool-content.cjs');
const { applyCodexHistory, persistedMessages } = require('../native-blocks.cjs'), { readImage } = require('../native-images.cjs');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-image-projection-')), host = new NativeHost(dir), w = new Workspace(host, dir);
  const s = { id: 'session', nativeId: randomUUID(), provider: 'codex', cwd: dir, owner: 'window', messages: [],
    state: 'idle', controlRevision: 0, memberRevision: 0, connectionRevision: 0, fleet: [] };
  const r = host.create(s); w.sessions.set(s.id, s); w.runtimes.set(s.id, r); w.bind(s, r);
  t.after(() => { w.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const emit = (method, params) => r.event({ method, params: { threadId: s.nativeId, turnId: 'turn', ...params } });
  return { dir, host, w, s, r, emit };
}
test('imageView keeps its exact local path in explicit references, not terminal-text parsing or remote fetches', () => {
  const content = toolContent({ type: 'imageView', id: 'image', path: '/synthetic/image.png' }, true);
  assert.deepEqual(content.images, [{ path: '/synthetic/image.png' }]);
  assert.ok(!JSON.stringify(content).includes('data:'));
});
test('live start/completion, history and persistence keep one original image row and its first cwd/time', t => {
  const { s, r, emit } = fixture(t);
  emit('turn/started', { turn: { id: 'turn' } });
  emit('item/started', { item: { type: 'imageView', id: 'image', path: 'original.png' } });
  const row = s.messages.find(m => m.toolKind === 'imageView');
  assert.equal(row.images[0].path, 'original.png'); assert.equal(row.images[0].cwd, s.cwd); assert.equal(row.status, 'running');
  const original = { ...row.images[0] }; s.cwd = '/later';
  emit('item/completed', { item: { type: 'imageView', id: 'image', path: 'original.png' } });
  assert.deepEqual(row.images, [original]); assert.equal(row.status, 'complete');
  applyCodexHistory(s, [{ type: 'imageView', id: 'image', path: 'original.png', turnId: 'turn' }], r);
  assert.equal(s.messages.filter(m => m.toolKind === 'imageView').length, 1);
  assert.deepEqual(s.messages.find(m => m.toolKind === 'imageView').images, [original]);
  assert.deepEqual(persistedMessages(s.messages).find(m => m.toolKind === 'imageView').images, [original]);
});
test('cold history normalizes the image reference before a later history refresh changes cwd', async t => {
  const { s, r } = fixture(t), cwd = s.cwd;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=', 'base64');
  fs.writeFileSync(path.join(cwd, 'cold.png'), png);
  applyCodexHistory(s, [{ type: 'imageView', id: 'cold-image', path: 'cold.png', turnId: 'old' }], r);
  const row = s.messages.find(m => m.toolKind === 'imageView'), original = row.images[0];
  assert.equal(row.status, 'complete');
  assert.equal(original.cwd, cwd); assert.ok(Number.isFinite(original.observedAt));
  s.cwd = '/later-history-directory';
  applyCodexHistory(s, [{ type: 'imageView', id: 'cold-image', path: 'cold.png', turnId: 'old' }], r);
  assert.deepEqual(s.messages.find(m => m.toolKind === 'imageView').images[0], original);
  const result = await readImage(original, { createFromBuffer: buffer => ({ isEmpty: () => false,
    getSize: () => ({ width: 1, height: 1 }), toPNG: () => buffer, resize() { return this; } }) });
  assert.deepEqual(result.png, png);
});
test('an original image is an explicit media boundary between collapsed process groups', () => {
  const vm = require('node:vm'), context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/reading-list.js'), 'utf8'), context);
  const tool = id => ({ id, nativeId: 'N', turnId: 'T', nativeBlock: true, kind: 'tool', role: 'tool', title: 'Bash', text: id, status: 'complete' });
  context.rows = [tool('a'), tool('b'), { ...tool('image'), images: [{ path: '/synthetic/image.png' }] }, tool('c'), tool('d')];
  const groups = JSON.parse(vm.runInContext('JSON.stringify([...nativeProcessGroups(rows, false, rows).values()])', context));
  assert.deepEqual(groups.map(g => g.messages.map(m => m.id)), [['a', 'b'], ['c', 'd']]);
});
test('native image-only user input is displayed once and its metadata replay never pauses again', t => {
  const { s, emit } = fixture(t);
  const item = { type: 'userMessage', id: 'native-input', content: [{ type: 'localImage', path: 'input.png' }] };
  emit('item/completed', { item }); const row = s.messages.find(m => m.role === 'user');
  assert.equal(row.text, ''); assert.equal(row.images[0].path, 'input.png'); assert.equal(row.nativeId, s.nativeId);
  const revision = s.controlRevision; emit('item/completed', { item });
  assert.equal(s.messages.filter(m => m.role === 'user').length, 1); assert.equal(s.controlRevision, revision);
});
test('an exact own client input gains image metadata without another row, receipt or human intervention', t => {
  const { s, r, emit } = fixture(t); r.ownInputs.add('own-client');
  s.messages.push({ id: 'own-client', role: 'user', text: 'caption', status: 'awaiting-native' });
  emit('item/completed', { item: { type: 'userMessage', id: 'native-input', clientId: 'own-client', content: [{ type: 'text', text: 'caption' }, { type: 'localImage', path: 'own.png' }] } });
  assert.equal(s.messages.length, 1); assert.equal(s.messages[0].id, 'own-client'); assert.equal(s.messages[0].images[0].path, 'own.png');
  assert.equal(s.messages[0].status, 'awaiting-native'); assert.equal(s.controlRevision, 0);
});
test('history enriches the exact own row and retains image-only native input without native control events', t => {
  const { s, r } = fixture(t); s.messages.push({ id: 'own-client', role: 'user', text: 'caption', status: 'submitted' });
  applyCodexHistory(s, [{ type: 'userMessage', id: 'native-input', clientId: 'own-client', turnId: 'old', content: [{ type: 'localImage', path: 'history.png' }] }], r);
  assert.equal(s.messages.length, 1); assert.equal(s.messages[0].id, 'own-client'); assert.equal(s.messages[0].images[0].path, 'history.png'); assert.equal(s.controlRevision, 0);
});
test('only a current explicit shared grant copies independent image references; later private changes stay private', t => {
  const { s, r, w, emit } = fixture(t); s.roomId = 'shared';
  const tag = randomUUID(); w.sharedReplies.authorize(s, r, tag, { id: tag }); w.sharedReplies.bind(s, tag, { nativeId: s.nativeId, turnId: 'turn' });
  emit('item/completed', { item: { type: 'imageView', id: 'image', path: '/synthetic/shared.png' } });
  const shared = w.room.messages.find(m => m.toolKind === 'imageView'); assert.equal(shared.images[0].path, '/synthetic/shared.png');
  w.sharedReplies.close(tag); s.messages.find(m => m.toolKind === 'imageView').images[0].path = '/synthetic/private.png';
  assert.equal(shared.images[0].path, '/synthetic/shared.png');
  emit('item/completed', { item: { type: 'imageView', id: 'later-image', path: '/synthetic/later-private.png' } });
  assert.ok(!JSON.stringify(w.room.messages).includes('later-private'));
});
test('normal bootstrap copies the image module into its real private runtime and package source list', async t => {
  for (const key of ['NAW_WORKSPACE', 'NAW_APP_VERSION', 'NAW_RUNTIME_CONFIG']) delete process.env[key];
  const { ensureService, connectService } = require('../service-client.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-image-bootstrap-')); let client;
  try {
    await ensureService(dir, process.execPath); client = await connectService(dir, 'image-bootstrap-test');
    const state = await client.call('initial'); assert.equal(state.sessions.length, 0); assert.equal(state.diagnostics.dispatches, 0);
    const runtime = path.join(dir, 'runtimes', fs.readdirSync(path.join(dir, 'runtimes'))[0]);
    const load = require('node:module').createRequire(path.join(runtime, 'adapters.cjs'));
    assert.deepEqual(load('./codex-tool-content.cjs').toolContent({ type: 'imageView', id: 'original', path: '/synthetic/original.png' }, true).images, [{ path: '/synthetic/original.png' }]);
    const source = fs.readFileSync(path.join(__dirname, '../../scripts/package-mac.cjs'), 'utf8');
    const files = require('node:vm').runInNewContext(source.match(/const sources = (\[[\s\S]*?\]);/)[1]);
    assert.ok(files.includes('native-images.cjs'), 'The installed main process also requires this local module');
  } finally {
    if (client) { await client.call('shutdown'); client.close(); }
    for (let n = 0; n < 40 && fs.existsSync(path.join(dir, 'service.lock')); n++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(fs.existsSync(path.join(dir, 'service.lock')), false, 'Owned empty backend confirms shutdown before profile removal');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
