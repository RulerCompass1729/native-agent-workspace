const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { CreationDefaults } = require('../creation-defaults.cjs');
const main = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8');
const personActionsSource = require('./fixtures/main-person-actions.cjs');
function section(start, end) {
  const a = main.indexOf(start), b = main.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, 'Actual production handler exists: ' + start);
  return main.slice(a, b);
}
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-creation-defaults-'));
  fs.chmodSync(dir, 0o700); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { defaultWorkspace: path.join(dir, 'workspace'), newWorkspaceRoot: path.join(dir, 'workspace-sessions') };
  return { dir, options, store: new CreationDefaults(dir, options), file: path.join(dir, 'creation-defaults.json') };
}
const empty = () => ({ repository: null, directory: null });
test('successful worktree and selected-directory creates retain one shared private defaults record', t => {
  const f = fixture(t), repository = path.join(f.dir, 'project'), directory = path.join(f.dir, 'chosen');
  assert.deepEqual(f.store.get(), empty());
  f.store.remember({ cwd: repository, gitWorktree: { repository } });
  f.store.remember({ cwd: directory });
  assert.deepEqual(f.store.get(), { repository, directory });
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  assert.deepEqual(new CreationDefaults(f.dir, f.options).get(), { repository, directory });
  const returned = f.store.get(); returned.repository = '/wrong';
  assert.equal(f.store.get().repository, repository, 'Callers cannot mutate the main process record');
});
test('automatic empty and shared workspaces do not become directory defaults', t => {
  const f = fixture(t), chosen = path.join(f.dir, 'chosen'); f.store.remember({ cwd: chosen });
  for (const options of [{ cwd: f.options.defaultWorkspace },
    { cwd: path.join(f.options.newWorkspaceRoot, '25f12958-a0a5-4e0f-86ad-c687ae419afa') },
    { cwd: path.join(f.dir, 'new'), newDirectory: true }]) f.store.remember(options);
  assert.deepEqual(f.store.get(), { repository: null, directory: chosen });
});
test('an old installation seeds only an absent file from the newest worktree session', t => {
  const f = fixture(t), old = path.join(f.dir, 'old'), recent = path.join(f.dir, 'recent');
  assert.deepEqual(f.store.get([{ createdAt: 1, worktreePreparation: { repository: old } },
    { createdAt: 3, worktreePreparation: { repository: 'relative' } },
    { createdAt: 2, worktreePreparation: { repository: recent } }]), { repository: recent, directory: null });
  assert.deepEqual(new CreationDefaults(f.dir, f.options).get([{ createdAt: 5, worktreePreparation: { repository: old } }]), { repository: recent, directory: null });
});
for (const invalid of ['permissions', 'json', 'extra', 'relative', 'oversize', 'symlink', 'hardlink']) test('unsafe defaults are ignored without seeding or following them: ' + invalid, t => {
  const f = fixture(t), value = { repository: path.join(f.dir, 'repo'), directory: null }, target = path.join(f.dir, 'target');
  if (invalid === 'extra') value.extra = 'untrusted';
  if (invalid === 'relative') value.repository = 'relative';
  const text = invalid === 'json' ? '{' : invalid === 'oversize' ? ' '.repeat(20000) : JSON.stringify(value);
  fs.writeFileSync(invalid === 'symlink' ? target : f.file, text, { mode: 0o600 });
  if (invalid === 'permissions') fs.chmodSync(f.file, 0o644);
  if (invalid === 'symlink') fs.symlinkSync(target, f.file);
  if (invalid === 'hardlink') fs.linkSync(f.file, target);
  assert.deepEqual(new CreationDefaults(f.dir, f.options).get([{ createdAt: 1, worktreePreparation: { repository: '/synthetic/seed' } }]), empty());
  if (invalid === 'symlink') assert.equal(fs.readFileSync(target, 'utf8'), text);
});
function harness(store) {
  const handlers = new Map(); let failCreate = false, created = 0, releaseInitial;
  const client = { call: async (method, ...args) => {
    if (method === 'initial') return releaseInitial ? new Promise(resolve => { releaseInitial.resolve = resolve; }) : { sessions: [] };
    if (method === 'gitWorktreePreview') return { repository: args[0], source: args[0], nonce: args[1] };
    assert.equal(method, 'create'); if (failCreate) throw Error('Synthetic failed native start'); created++; return 'new-id';
  } };
  const context = { client, win: { isDestroyed: () => false } };
  const sandbox = { register: (name, handler) => handlers.set(name, handler), creationDefaults: store,
    backgroundOperation: require('../background-operation.cjs'),
    assertNativeCreation() {}, uiError: key => Object.assign(Error(key), { key }) };
  vm.runInNewContext(section("  register('createDefaults',", "  register('nativeHistory',"), sandbox);
  return { handlers, context, get created() { return created; }, set fail(value) { failCreate = value; },
    deferInitial() { releaseInitial = {}; return releaseInitial; }, call(method, ...args) { return handlers.get(method)(context, ...args); } };
}
test('main createDefaults authorizes only its own persisted repository and invalidates old preview work', async t => {
  const f = fixture(t), repo = path.join(f.dir, 'repo'); f.store.remember({ gitWorktree: { repository: repo } });
  const h = harness(f.store);
  await assert.rejects(h.call('gitWorktreePreview', repo, 'nonce', ''), /selectRepositoryFirst/);
  const defaults = await h.call('createDefaults', '/synthetic/renderer-path');
  assert.equal(defaults.repository, repo); assert.equal(h.context.worktreeSource, repo); assert.equal(h.context.worktreePlan, null);
  await h.call('gitWorktreePreview', repo, 'nonce', '');
  await assert.rejects(h.call('gitWorktreePreview', '/synthetic/renderer-path', 'nonce', ''), /selectRepositoryFirst/);
  const oldRevision = h.context.worktreePreviewRevision; await h.call('createDefaults');
  assert.equal(h.context.worktreePlan, null); assert.ok(h.context.worktreePreviewRevision > oldRevision);
});
test('a late defaults read cannot replace a newer explicit repository selection', async t => {
  const f = fixture(t); f.store.remember({ gitWorktree: { repository: '/synthetic/remembered' } });
  const h = harness(f.store), hold = h.deferInitial(), pending = h.call('createDefaults');
  h.context.worktreeSource = '/synthetic/newly-chosen'; h.context.worktreePreviewRevision++;
  hold.resolve({ sessions: [] }); await pending;
  assert.equal(h.context.worktreeSource, '/synthetic/newly-chosen');
});
test('only a successful foreground create updates defaults; failed and background creates do not', async t => {
  const f = fixture(t), h = harness(f.store), directory = path.join(f.dir, 'chosen');
  h.fail = true; await assert.rejects(h.call('create', { cwd: directory }), /failed native/); assert.deepEqual(f.store.get(), empty());
  h.fail = false; h.context.background = true; await h.call('create', { cwd: '/synthetic/agent-choice' }); assert.deepEqual(f.store.get(), empty());
  h.context.background = false; assert.equal(await h.call('create', { cwd: directory }), 'new-id'); assert.equal(f.store.get().directory, directory);
  const plan = await h.call('createDefaults').then(() => { h.context.worktreeSource = '/synthetic/repo'; return h.call('gitWorktreePreview', '/synthetic/repo', 'nonce', ''); });
  await h.call('create', { cwd: plan.source, gitWorktree: { ...plan } }); assert.equal(f.store.get().repository, plan.repository);
});
test('a defaults save error cannot turn an already-created session into a failed create', async () => {
  const h = harness({ get: empty, remember() { throw Error('Synthetic defaults save failure'); } });
  assert.equal(await h.call('create', { cwd: '/synthetic/chosen' }), 'new-id'); assert.equal(h.created, 1);
});

test('B2: production startup keeps directory migration closed even when the test env switch is set', async () => {
  for (const [backgroundTest, flag, enabled] of [[false, undefined, false], [false, '1', false], [true, undefined, false], [true, '1', true]]) {
    let options;
    const sandbox = { queueDispatcher: null, backgroundTest, process: { env: { NAW_TEST_QUEUE_DIRECTORY_MIGRATION: flag, NAW_QUEUE_DIRECTORY_TRUST_TIMEOUT_MS: '12000' } }, roomState: {}, dataDir: '/synthetic/private', windows: new Map(),
      connect() {}, sessionLabels: { labels: new Map() }, broadcastRoom() {}, notifyRotation() {}, creationDefaults: { get() { return {}; } }, butlerIngress: null, stewardWake: null, answerNotices: null, versionNotices: null, managerNotices: null, quietWindows: null,
      QueueDispatcher: class { constructor(value) { options = value; } async start() { return this; } } };
    await vm.runInNewContext(personActionsSource(main) + '\n' + section('async function startQueueDispatcher()', 'async function broadcastRoom()') + '\nstartQueueDispatcher()', sandbox);
    assert.ok(options, 'production startup constructed the dispatcher');
    assert.equal(options.directoryTrustTimeoutMs, '12000', 'the wait limit is configurable in production without enabling migration');
    assert.equal(options.migrateDirectories === true, enabled, JSON.stringify({ backgroundTest, flag }));
  }
});
