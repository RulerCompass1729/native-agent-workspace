const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const { ViewStore, validViews } = require('../view-store.cjs');
const localeUI = require('./fixtures/locale-ui.cjs');
const renderer = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
function facts(state = {}, rooms = []) {
  const locale = localeUI();
  const context = vm.createContext({ state: { sessions: [], ...state }, uiText: locale.uiText, allSpaces: () => rooms });
  const start = renderer.indexOf('const hierBase ='), end = renderer.indexOf('function hierViewButton()', start);
  assert.ok(start >= 0 && end > start, 'Production folder facts must be present');
  vm.runInContext(renderer.slice(start, end), context);
  return { context, language: locale.setLanguage, folder: record => JSON.parse(JSON.stringify(context.hierFolder(record))) };
}
test('recorded worktrees group under their repository and retain the exact path and branch', () => {
  const h = facts(), plan = { repository: '/synthetic/repo', target: '/synthetic/repo-lanes/worker', nonce: 'abc123-45', branch: 'naw/session-abc' };
  const f = h.folder({ cwd: plan.target, worktreePreparation: plan });
  assert.equal(f.kind, 'worktree'); assert.equal(f.group, plan.repository); assert.equal(f.path, plan.target); assert.equal(f.branch, plan.branch);
  assert.equal(f.leaf, '工作树 abc123'); h.language('en'); assert.equal(h.folder({ worktreePreparation: plan }).leaf, 'Worktree abc123');
});
test('main checkout and same-basename folders use full identities; a lanes suffix alone proves no repository', () => {
  const h = facts({ sessions: [{ worktreePreparation: { repository: '/synthetic/repo' } }] });
  assert.equal(h.folder({ cwd: '/synthetic/repo/' }).kind, 'main');
  assert.notEqual(h.folder({ cwd: '/one/repo' }).group, h.folder({ cwd: '/two/repo' }).group);
  assert.equal(h.folder({ cwd: '/synthetic/repo-lanes/manual' }).kind, 'folder');
  assert.equal(h.folder({ cwd: '/synthetic/repo/child' }).kind, 'folder');
});
test('only a direct UUID child of the configured new-folder root is marked as NAW-created', () => {
  const h = facts({ newWorkspaceRoot: '/synthetic/new/' }), id = '12345678-1234-4000-8000-123456789abc';
  assert.equal(h.folder({ cwd: '/synthetic/new/' + id }).kind, 'made');
  assert.equal(h.folder({ cwd: '/synthetic/newer/' + id }).kind, 'folder');
  assert.equal(h.folder({ cwd: '/synthetic/new/sub/' + id }).kind, 'folder');
  assert.equal(h.folder({}).kind, 'unknown'); assert.equal(h.folder({}).path, '');
  assert.equal(h.folder({ cwd: '' }).kind, 'unknown');
});
test('different folders with the same name show enough parent path to tell them apart', () => {
  const h = facts({ sessions: [{ cwd: '/demo/notes' }, { cwd: '/other/notes' }] });
  assert.equal(h.folder({ cwd: '/demo/notes' }).name, 'demo/notes');
  assert.equal(h.folder({ cwd: '/other/notes' }).name, 'other/notes');
});
test('row task facts use only active recorded dispatches and retain creator identity', () => {
  const rooms = [{ queue: [
    { status: 'done', sentTo: 'a', text: 'finished' }, { status: 'queued', sentTo: 'a', text: 'not delivered' },
    { status: 'waiting', sentTo: 'a', text: 'Awaiting choice' },
    { status: 'sent', sentTo: 'b', creator: { kind: 'secretary', sessionId: 'a' }, text: 'Owned request' },
    { status: 'queued', creator: { kind: 'secretary', sessionId: 'other' }, text: 'Other request' },
  ] }];
  const h = facts({}, rooms), result = h.context.hierQueueFacts({ id: 'a' });
  assert.equal(result.doing.text, 'Awaiting choice'); assert.equal(result.added.length, 1); assert.equal(result.added[0].text, 'Owned request');
});
test('the real view-state IPC saves the folder view and fold choices without changing drafts, and rejects invalid folds atomically', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-folder-view-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new ViewStore(dir); store.load(); let handler;
  const owner = { view: { owner: 'synthetic', active: true, selected: 's', mode: 'chat', draft: { id: 's', text: 'UNSENT' }, sharedDraft: 'UNSENT shared' } };
  const main = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8');
  const start = main.indexOf("  register('viewState',"), end = main.indexOf("\n  register('openLocalFile',", start);
  vm.runInNewContext(main.slice(start, end), { register: (_, fn) => { handler = fn; }, validViews, structuredClone, uiError: key => key, saveViews: () => store.save([owner.view]), require });
  handler(owner, { selected: 's', mode: 'chat', sidebarView: 'folder', sidebarCollapsedFolders: ['/one/repo', ':made'] });
  const saved = new ViewStore(dir).load()[0]; assert.equal(saved.sidebarView, 'folder'); assert.deepEqual(saved.sidebarCollapsedFolders, ['/one/repo', ':made']);
  assert.equal(saved.draft.text, 'UNSENT'); assert.equal(saved.sharedDraft, 'UNSENT shared');
  const before = fs.readFileSync(store.file, 'utf8');
  for (const bad of [{}, [''], [3], ['/same', '/same'], ['x'.repeat(4097)], Array.from({ length: 201 }, (_, i) => '/folder/' + i)]) {
    assert.throws(() => handler(owner, { selected: 's', mode: 'chat', sidebarCollapsedFolders: bad })); assert.equal(fs.readFileSync(store.file, 'utf8'), before);
  }
});
