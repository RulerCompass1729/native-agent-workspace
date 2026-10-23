const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { ViewStore } = require('../view-store.cjs');
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-view-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, store: new ViewStore(dir) };
}
const saved = () => [{ owner: 'synthetic-view', active: true, selected: 'session', mode: 'chat',
  bounds: { x: -1200, y: 20, width: 1100, height: 800 },
  draft: { id: 'session', text: '私人草稿，尚未发送' },
  sharedDraft: '共同工作草稿', draftBackups: { session: { text: '私人草稿，尚未发送', acknowledged: false, recoveries: ['副本一', '副本二'] } },
  futureMetadata: { preserved: true },
}];
test('fresh and existing views retain drafts, recovery copies, geometry and forward-compatible metadata privately', t => {
  const { store } = setup(t);
  assert.deepEqual(store.load(), []);
  store.save(saved());
  assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);
  assert.deepEqual(new ViewStore(path.dirname(store.file)).load(), saved());
});
test('damaged or malformed view records cannot authorize an empty overwrite', t => {
  const { store } = setup(t);
  const invalid = [
    '[{"owner":"synthetic-view","draft":{"id":"session","text":"preserve this"}}',
    '{}', '[null]', JSON.stringify([...saved(), ...saved()]),
    JSON.stringify([{ owner: 'view', draftBackups: { session: { text: 123 } } }]),
    JSON.stringify([{ owner: 'view', draft: { id: 'session' } }]),
  ];
  for (const value of invalid) {
    fs.writeFileSync(store.file, value, { mode: 0o600 });
    assert.throws(() => store.load(), { code: 'NAW_VIEW_RECORD' });
    assert.equal(store.loaded, false);
    assert.throws(() => store.save([]), { code: 'NAW_VIEW_RECORD' });
    assert.equal(fs.readFileSync(store.file, 'utf8'), value);
  }
});
test('read failure and a file disappearing after stat preserve the write lock until an explicit successful reload', t => {
  const { store } = setup(t);
  fs.writeFileSync(store.file, JSON.stringify(saved()), { mode: 0o600 });
  const before = fs.readFileSync(store.file, 'utf8');
  for (const code of ['EACCES', 'EIO', 'ENOENT']) {
    const mocked = t.mock.method(fs, 'readFileSync', () => { throw Object.assign(Error('synthetic read failure'), { code }); });
    assert.throws(() => store.load(), { code: 'NAW_VIEW_RECORD' });
    assert.throws(() => store.save([]), { code: 'NAW_VIEW_RECORD' }); mocked.mock.restore();
    assert.equal(fs.readFileSync(store.file, 'utf8'), before);
  }
  assert.deepEqual(store.load(), saved()); store.save(saved());
});
test('symlink, non-file and group-readable records are not read or replaced', t => {
  const { store, dir } = setup(t), target = path.join(dir, 'original');
  fs.writeFileSync(target, JSON.stringify(saved()), { mode: 0o600 });
  fs.symlinkSync(target, store.file);
  assert.throws(() => store.load(), { code: 'NAW_VIEW_RECORD' });
  assert.throws(() => store.save([])); assert.equal(fs.lstatSync(store.file).isSymbolicLink(), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), saved());
  fs.unlinkSync(store.file); fs.mkdirSync(store.file);
  assert.throws(() => store.load(), { code: 'NAW_VIEW_RECORD' }); fs.rmdirSync(store.file);
  fs.copyFileSync(target, store.file); fs.chmodSync(store.file, 0o644);
  assert.throws(() => store.load(), { code: 'NAW_VIEW_RECORD' }); assert.throws(() => store.save([]));
});
test('an interrupted atomic save keeps the old file and cleans only its own temporary file', t => {
  const { store, dir } = setup(t); store.load(); store.save(saved());
  const before = fs.readFileSync(store.file, 'utf8');
  const oldTemp = store.file + '.tmp', target = path.join(dir, 'unrelated');
  fs.writeFileSync(target, 'do not overwrite'); fs.symlinkSync(target, oldTemp);
  const failure = t.mock.method(fs, 'renameSync', () => { throw Error('synthetic disk failure'); });
  assert.throws(() => store.save([]), /未能保存/);
  assert.equal(fs.readFileSync(store.file, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['unrelated', 'views.json', 'views.json.tmp']);
  failure.mock.restore(); store.save(saved());
  assert.equal(fs.readFileSync(target, 'utf8'), 'do not overwrite');
  assert.equal(fs.lstatSync(oldTemp).isSymbolicLink(), true);
});
test('invalid in-memory draft data cannot replace the last good recovery record', t => {
  const { store } = setup(t); store.load(); store.save(saved());
  const before = fs.readFileSync(store.file, 'utf8'), changed = saved();
  changed[0].draftBackups.session.recoveries.push(null);
  assert.throws(() => store.save(changed), /未覆盖/);
  assert.equal(fs.readFileSync(store.file, 'utf8'), before);
});

test('inline recipient metadata round-trips only with exact draft range and identity', t => {
  const { store } = setup(t), views = saved();
  store.load();
  Object.assign(views[0], { sharedDraft: '@Codex 检查', roomRecipient: 'native-session', roomMention: { id: 'native-session', active: true, memberRevision: 1, text: '@Codex', start: 0, end: 6 } });
  store.save(views); assert.deepEqual(store.load(), views);
  views[0].roomMention.active = false; views[0].roomRecipient = ''; store.save(views); assert.deepEqual(store.load(), views);
  views[0].roomMention.active = true; views[0].roomRecipient = 'native-session'; store.save(views);
  const before = fs.readFileSync(store.file, 'utf8');
  for (const invalid of [{ ...views[0].roomMention, end: 9 }, { ...views[0].roomMention, id: 'other' }]) {
    assert.throws(() => store.save([{ ...views[0], roomMention: invalid }]));
    assert.equal(fs.readFileSync(store.file, 'utf8'), before);
  }
});
