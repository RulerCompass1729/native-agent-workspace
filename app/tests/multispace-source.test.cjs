const test = require('node:test'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const { ViewStore } = require('../view-store.cjs');
const { searchRecords } = require('../renderer/local-search.js');
const { openMessageFile } = require('../local-files.cjs');
const { imageSource } = require('../native-images.cjs');
test('two windows reopen with independent selected spaces, drafts, references and sidebar modes', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-space-views-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const a = randomUUID(), b = randomUUID(), store = new ViewStore(dir); store.load();
  const views = [{ owner: 'one', selected: 'room', spaceId: a, mode: 'chat', sidebarView: 'grouped', sidebarSpaceFilter: b, sharedDraft: 'Original shared draft', roomViews: { shared: { sharedDraft: 'Original shared draft' }, [a]: { sharedDraft: 'Unsent A', roomSession: 'same-native-session', roomSurface: 'overview' }, [b]: { sharedDraft: 'Unsent B', roomThread: 'original-thread' } } }, { owner: 'two', selected: 'room', spaceId: b, mode: 'chat', sidebarView: 'flat', roomViews: { [a]: { sharedDraft: 'Second window A' }, [b]: { sharedDraft: 'Second window B' } } }];
  store.save(views); const reopened = new ViewStore(dir).load(); assert.deepEqual(reopened, views);
  const before = fs.readFileSync(store.file, 'utf8');
  for (const bad of [{ spaceId: '../escape' }, { sidebarView: 'unknown' }, { sidebarSpaceFilter: 'unknown' }, { roomViews: { unknown: { sharedDraft: 'not saved' } } }, { roomViews: { [a]: { sharedDraft: 'x'.repeat(16001) } } }]) {
    assert.throws(() => store.save([{ ...views[0], ...bad }])); assert.equal(fs.readFileSync(store.file, 'utf8'), before);
  }
});
test('search uses source-space identities even for equal message IDs and archived rooms', () => {
  const a = randomUUID(), b = randomUUID(), rooms = [{ id: 'shared', name: 'Original', messages: [] }, { id: a, name: 'A', messages: [{ id: 'same', text: 'needle A', role: 'human' }] }, { id: b, name: 'B', archived: true, messages: [{ id: 'same', text: 'needle B', role: 'human' }] }];
  const state = { sessions: [], rooms, room: rooms[1] };
  const all = searchRecords(state, 'needle', { archived: true }); assert.equal(all.total, 2);
  assert.deepEqual(all.results.map(r => r.roomId), [a, b]); assert.equal(new Set(all.results.map(r => r.key)).size, 2);
  assert.deepEqual(searchRecords(state, 'needle', { scope: 'room' }).results.map(r => r.roomId), [a]);
  assert.equal(searchRecords(state, 'needle').total, 1); assert.equal(searchRecords(state, 'needle', { scope: 'current' }).total, 0);
});
test('original file links remain pinned to A while B is selected and cannot borrow a private or other-space row', async t => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'naw-space-links-'))); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const a = randomUUID(), b = randomUUID(), file = path.join(dir, 'result.md'); fs.writeFileSync(file, 'Synthetic result', { mode: 0o600 });
  const message = { id: 'reply', role: 'assistant', sessionId: 'one', nativeId: 'native-one', text: '[Result](result.md)' };
  const rooms = [{ id: 'shared', messages: [] }, { id: a, messages: [message] }, { id: b, messages: [] }], state = { room: rooms[2], rooms, sessions: [{ id: 'one', nativeId: 'native-one', cwd: dir, messages: [message] }] }, opened = [];
  const deps = { snapshot: async () => state, openPath: async file => { opened.push(file); return ''; } }, source = { kind: 'room', roomId: a, sessionId: 'one', messageId: 'reply', nativeId: 'native-one', cwd: dir };
  await openMessageFile(deps, source, 'result.md'); assert.deepEqual(opened, [file]);
  await assert.rejects(openMessageFile(deps, { ...source, roomId: b }, 'result.md'), /原消息/);
  rooms[1].messages = []; await assert.rejects(openMessageFile(deps, source, 'result.md'), /原消息/); assert.equal(opened.length, 1);
});
test('original native image sources use the explicit shared row in A and never private images or selected B', () => {
  const a = randomUUID(), b = randomUUID(), message = { id: 'image', sessionId: 'one', nativeId: 'native-one', kind: 'tool', status: 'complete', sharedStream: true, images: [{ kind: 'native-pixels', id: 'original-ref' }] };
  const rooms = [{ id: a, messages: [message] }, { id: b, messages: [] }], state = { room: rooms[1], rooms, sessions: [{ id: 'one', messages: [message] }] };
  const source = { kind: 'room', roomId: a, sessionId: 'one', nativeId: 'native-one', messageId: 'image', index: 0 };
  assert.equal(imageSource(state, source).id, 'original-ref'); assert.throws(() => imageSource(state, { ...source, roomId: b }));
  rooms[0].messages = []; assert.throws(() => imageSource(state, source)); assert.throws(() => imageSource(state, { ...source, roomId: '../escape' }));
});
test('both existing runtime copy sets include the new contract required by the actual source modules', () => {
  const root = path.resolve(__dirname, '../..');
  for (const [file, start, end] of [['app/service-client.cjs', '  const names = ', ';\n'], ['scripts/package-mac.cjs', '    const sources = ', ';\n']]) {
    const source = fs.readFileSync(path.join(root, file), 'utf8'), at = source.indexOf(start); assert.ok(at >= 0);
    const literal = source.slice(at + start.length, source.indexOf(end, at)), names = vm.runInNewContext(literal);
    assert.ok(names.includes('collaboration-spaces.cjs'));
    for (const name of ['workspace.cjs', 'native-images.cjs', 'shared-replies.cjs', 'peer-handoffs.cjs']) {
      const actual = fs.readFileSync(path.join(root, 'app', name), 'utf8'); assert.ok(actual.includes("require('./collaboration-spaces.cjs')"));
      assert.ok(names.includes(name));
    }
  }
});
test('actual clear button targets the room captured when privacy opened and shows failure inside the same dialog', async () => {
  const source = fs.readFileSync(require.resolve('../renderer/renderer.js'), 'utf8'), elements = new Map(), calls = [];
  const $ = id => { if (!elements.has(id)) elements.set(id, { open: true, disabled: false, textContent: '' }); return elements.get(id); };
  const context = { $, trustClearRoom: randomUUID(), trustRevision: 1, state: { capabilities: ['clearSharedHistory'] }, attempt: fn => fn(), api: { spaceAction: async (...args) => { calls.push(args); throw Error('Synthetic save failure'); }, clearSharedHistory: () => { throw Error('Wrong default clear'); } } };
  vm.runInNewContext(source.slice(source.indexOf("$('clear-shared-history').onclick"), source.indexOf("$('close-privacy').onclick")), context);
  await $('clear-shared-history').onclick({ type: 'click' });
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [[context.trustClearRoom, 'clearSharedHistory', []]]);
  assert.equal($('trust-refresh-status').textContent, 'Synthetic save failure'); assert.equal($('clear-shared-history').disabled, false);
});
