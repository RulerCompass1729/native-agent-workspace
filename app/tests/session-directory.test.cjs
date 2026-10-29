const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Workspace } = require('../workspace.cjs');

function fixture(t) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-directory-'));
  const root = path.join(data, 'workspace-sessions'), legacy = path.join(data, 'workspace');
  fs.mkdirSync(legacy); fs.writeFileSync(path.join(legacy, 'keep.txt'), 'Existing work');
  const launched = [], host = { binaries: {}, close() {}, create(record) {
    launched.push({ cwd: record.cwd, contents: fs.readdirSync(record.cwd), mode: fs.statSync(record.cwd).mode & 0o777 });
    const r = new EventEmitter(); r.start = async () => r.emit('state', 'idle'); return r;
  } };
  const w = new Workspace(host, data, root);
  t.after(() => { w.close(); fs.chmodSync(data, 0o700); if (fs.existsSync(root) && !fs.lstatSync(root).isSymbolicLink()) fs.chmodSync(root, 0o700); fs.rmSync(data, { recursive: true, force: true }); });
  const preview = () => path.join(root, randomUUID());
  const create = (cwd, options = { newDirectory: true }, name = 'New work') => w.create('codex', cwd, 'owner', name, 'chat', options);
  return { data, root, legacy, w, host, launched, preview, create };
}
test('new directories are private, empty at launch, distinct, and outside legacy work', async t => {
  const f = fixture(t), first = f.preview(), second = f.preview();
  assert.equal(fs.existsSync(first), false);
  const a = await f.create(first), b = await f.create(second);
  assert.notEqual(a, b); assert.notEqual(f.w.get(a).cwd, f.w.get(b).cwd);
  assert.deepEqual(f.launched, [{ cwd: first, contents: [], mode: 0o700 }, { cwd: second, contents: [], mode: 0o700 }]);
  assert.deepEqual(fs.readdirSync(f.legacy), ['keep.txt']);
  assert.equal(fs.readFileSync(path.join(f.legacy, 'keep.txt'), 'utf8'), 'Existing work');
});
test('existing directories and saved cwd/drafts retain their original identity', async t => {
  const f = fixture(t), old = await f.create(f.legacy, {}), fresh = await f.create(f.preview());
  f.w.setDraft(old, 'Unsent original', 'owner'); f.w.persist();
  const reopened = new Workspace(f.host, f.data, f.root); t.after(() => reopened.close());
  assert.equal(reopened.get(old).cwd, f.legacy); assert.equal(reopened.get(fresh).cwd, f.w.get(fresh).cwd);
  assert.equal(reopened.drafts.get(old), 'Unsent original');
  await assert.rejects(f.create(path.join(f.data, 'missing'), {}), /工作目录/);
  assert.equal(fs.existsSync(path.join(f.data, 'missing')), false);
});
test('invalid options and paths fail before creating a folder or launching', async t => {
  const f = fixture(t), candidate = f.preview();
  for (const options of [{ newDirectory: false }, { newDirectory: 'yes' }, { newDirectory: true, skipPermissions: false }, { newDirectory: true, fork: 'picker' }]) await assert.rejects(f.create(candidate, options));
  await assert.rejects(f.create(candidate, { newDirectory: true }, ' '.repeat(4)));
  await assert.rejects(f.w.create('other', candidate, 'owner', 'x', 'chat', { newDirectory: true }));
  await assert.rejects(f.w.create('claude', candidate, 'owner', 'x', 'terminal', { newDirectory: true, fork: 'picker' }));
  await assert.rejects(f.w.create('codex', candidate, 'owner', 'x', 'bad-view', { newDirectory: true }));
  for (const cwd of [undefined, '.', path.join(f.data, randomUUID()), path.join(f.root, 'bad'), candidate + '/', f.root + '/../' + path.basename(f.root) + '/' + path.basename(candidate)]) await assert.rejects(f.create(cwd));
  assert.equal(fs.existsSync(candidate), false); assert.equal(fs.existsSync(f.root), false); assert.equal(f.launched.length, 0);
});
test('collisions, files and symlinks are never reused or overwritten', async t => {
  const f = fixture(t); fs.mkdirSync(f.root);
  const folder = f.preview(); fs.mkdirSync(folder); fs.writeFileSync(path.join(folder, 'keep'), 'unchanged');
  const file = f.preview(); fs.writeFileSync(file, 'unchanged');
  const link = f.preview(); fs.symlinkSync(f.legacy, link);
  for (const cwd of [folder, file, link]) await assert.rejects(f.create(cwd), /已存在/);
  assert.equal(fs.readFileSync(path.join(folder, 'keep'), 'utf8'), 'unchanged'); assert.equal(fs.readFileSync(file, 'utf8'), 'unchanged');
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true); assert.equal(f.launched.length, 0);
});
test('a symlinked, non-directory or unwritable automatic root launches nothing', async t => {
  const f = fixture(t), cwd = f.preview();
  fs.symlinkSync(f.legacy, f.root); await assert.rejects(f.create(cwd)); fs.unlinkSync(f.root);
  fs.writeFileSync(f.root, 'root file'); await assert.rejects(f.create(cwd), /存放位置不可用/); fs.unlinkSync(f.root);
  fs.mkdirSync(f.root, { mode: 0o500 });
  await assert.rejects(f.create(cwd)); assert.equal(f.launched.length, 0); assert.equal(fs.existsSync(cwd), false);
});
test('concurrent requests for one preview can launch only once', async t => {
  const f = fixture(t), cwd = f.preview();
  const results = await Promise.allSettled([f.create(cwd), f.create(cwd)]);
  assert.deepEqual(results.map(r => r.status), ['fulfilled', 'rejected']); assert.equal(f.launched.length, 1);
});
test('startup failure retains its folder, writes and error record rather than deleting work', async t => {
  const f = fixture(t), cwd = f.preview();
  f.host.create = record => { const r = new EventEmitter(); r.start = async () => { fs.writeFileSync(path.join(record.cwd, 'started'), 'keep'); throw Error('Synthetic startup failed'); }; return r; };
  await assert.rejects(f.create(cwd), /Synthetic startup failed/);
  assert.equal(fs.readFileSync(path.join(cwd, 'started'), 'utf8'), 'keep');
  const record = [...f.w.sessions.values()][0]; assert.equal(record.cwd, cwd); assert.equal(record.state, 'error');
  await assert.rejects(f.create(cwd), /已存在/); assert.equal(f.w.sessions.size, 1);
});
