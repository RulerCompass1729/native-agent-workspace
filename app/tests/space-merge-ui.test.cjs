const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const { ViewStore } = require('../view-store.cjs');
const spaces = require('../collaboration-spaces.cjs');
const root = path.resolve(__dirname, '../..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');
const renderer = source('app/renderer/renderer.js');
function actualFunction(text, name, next, context) {
  const start = text.indexOf(`function ${name}(`), end = text.indexOf(`function ${next}(`, start + 1);
  assert.ok(start >= 0 && end > start); return vm.runInNewContext(text.slice(start, end) + `;${name}`, context);
}
test('the actual reading timeline keeps source blocks before C activity, resolves imported reply display links and preserves raw payloads', () => {
  const raw = [
    { id: 'a', text: 'A original', time: 99, snapshotBatch: 'batch', snapshotReplyTo: 'parent-in-C', replyTo: 'original-parent' },
    { id: 'b', text: 'B original', time: 1, snapshotBatch: 'batch' },
    { id: 'later', text: 'C activity', time: 0 },
  ], before = JSON.stringify(raw), state = { room: { messages: raw, events: [{ id: 'event', text: 'C metadata event', time: 2 }] } };
  const timeline = actualFunction(renderer, 'timeline', 'renderSnapshotMaterials', { state });
  const result = timeline();
  assert.deepEqual(Array.from(result, row => row.id), ['a', 'b', 'later', 'event']);
  assert.equal(result[0].replyTo, 'parent-in-C'); assert.equal(result[0].text, raw[0].text); assert.equal(JSON.stringify(raw), before);
});
test('an imported original author is not silently renamed when the same native session has a new current name', () => {
  const state = { sessions: [{ id: 's', name: 'Current name', nativeId: 'same-native' }] };
  const label = actualFunction(renderer, 'roomMessageLabel', 'timeline', { state });
  assert.equal(label({ id: 'imported', role: 'assistant', snapshotBatch: 'batch', sessionId: 's', name: 'Original author' }), 'Original author');
});
test('duplicate source-space and historical author names retain distinct visible identity references', () => {
  const rooms = [{ id: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'Same space' }, { id: 'bbbbbbbb-0000-4000-8000-000000000002', name: 'Same space' }];
  const sourceLabel = actualFunction(renderer, 'mergeSourceLabel', 'mergeCheckbox', {});
  assert.equal(sourceLabel(rooms[0], rooms), 'Same space · aaaaaaaa'); assert.equal(sourceLabel(rooms[1], rooms), 'Same space · bbbbbbbb');
  const rows = rooms.map((room, index) => ({ id: `row-${index}`, role: 'assistant', sessionId: room.id, name: 'Original same author', snapshotBatch: 'batch' }));
  const label = actualFunction(renderer, 'roomMessageLabel', 'timeline', { state: { sessions: [], room: { messages: rows } } });
  assert.notEqual(label(rows[0]), label(rows[1]));
});
test('browser selection uses the same completed-shared-record contract as the backend, including pending acceptance and gaps', () => {
  const browser = { window: {} }; vm.runInNewContext(source('app/collaboration-spaces.cjs'), browser);
  const rows = [
    { role: 'assistant', status: 'complete' }, { role: 'tool', status: 'failed' }, { role: 'tool', status: 'streaming' },
    { role: 'human', status: 'complete', deliveryTracked: true, deliveries: [{ status: 'submitted' }] },
    { role: 'human', deliveryTracked: true }, { role: 'system', kind: 'gap' },
  ];
  assert.deepEqual(rows.map(browser.window.nativeWorkspaceSpaces.completedSharedRecord), rows.map(spaces.completedSharedRecord));
  assert.deepEqual(rows.map(spaces.completedSharedRecord), [true, true, false, true, false, false]);
});
test('the actual Main undo guard sees positive C drafts in another persisted window while unrelated native drafts stay separate', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-merge-views-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const c = randomUUID(), other = randomUUID(), store = new ViewStore(directory);
  const records = [{ owner: 'window-a', spaceId: other, selected: 'room', roomViews: { [other]: { sharedDraft: 'Unrelated draft' }, [c]: { sharedDraft: '' } } },
    { owner: 'window-b', active: false, spaceId: c, selected: 'room', roomViews: { [c]: { sharedDraft: 'POSITIVE UNSENT C' } } }];
  store.load(); store.save(records); const reloaded = new ViewStore(directory).load();
  const guard = actualFunction(source('app/main.cjs'), 'hasSavedSpaceDraft', 'register', {});
  assert.equal(guard(reloaded, c), true); assert.equal(guard(reloaded, randomUUID()), false);
  reloaded[1].roomViews[c].sharedDraft = ''; assert.equal(guard(reloaded, c), false);
  reloaded[1].sharedDraft = 'Legacy selected-space C draft'; assert.equal(guard(reloaded, c), true);
});
test('new backend module and its existing name-validation dependency are present in both runtime and bundle copy lists', () => {
  const runtime = source('app/service-client.cjs'), packaged = source('scripts/package-mac.cjs');
  for (const module of ['space-merge.cjs', 'session-labels.cjs', 'collaboration-spaces.cjs', 'service-transport.cjs']) {
    assert.ok(runtime.includes(`'${module}'`), `writable runtime includes ${module}`);
    assert.ok(packaged.includes(`'${module}'`), `signed source staging includes ${module}`);
  }
});
