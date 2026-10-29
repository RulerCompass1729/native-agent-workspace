const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { SessionLabels, validateName } = require('../session-labels.cjs');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-label-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, 'session-labels.json'), labels: new SessionLabels(dir) };
}

test('labels persist by application session ID without changing native identity or history', t => {
  const { dir, file, labels } = fixture(t);
  const snapshot = {
    sessions: [
      { id: 'session-one', name: 'Claude', nativeId: null, pid: 123, roomId: 'shared', messages: [{ text: 'synthetic fixture' }] },
      { id: 'session-two', name: 'Codex', nativeId: 'thread-two', pid: 456, roomId: null, messages: [] },
    ],
    room: { messages: [{ sessionId: 'session-one', name: 'Claude', text: 'already shared fixture' }] },
  };
  const original = structuredClone(snapshot);
  assert.equal(labels.set('session-one', '  学习笔记  '), '学习笔记');
  labels.set('session-two', '学习笔记'); // Same labels do not merge session identity.
  const display = new SessionLabels(dir).apply(snapshot);
  assert.deepEqual(display.sessions.map(s => [s.id, s.name, s.nativeId, s.pid]), [
    ['session-one', '学习笔记', null, 123], ['session-two', '学习笔记', 'thread-two', 456],
  ]);
  assert.deepEqual(snapshot, original);
  assert.equal(display.room, snapshot.room);
  assert.equal(display.sessions[0].messages, snapshot.sessions[0].messages);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  labels.remove('session-one');
  assert.equal(new SessionLabels(dir).apply(snapshot).sessions[0].name, 'Claude');
  assert.equal(new SessionLabels(dir).apply(snapshot).sessions[1].name, '学习笔记');
});

test('invalid labels cannot replace a saved name', t => {
  const { file, labels } = fixture(t);
  labels.set('session-one', 'Original');
  const before = fs.readFileSync(file, 'utf8');
  for (const value of ['', '   ', null, {}, 'x'.repeat(61), 'first\nsecond', 'first\u0000second']) assert.throws(() => labels.set('session-one', value));
  assert.throws(() => labels.set('', 'Valid'));
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(validateName('名'.repeat(60)), '名'.repeat(60));
});

test('failed atomic replacement preserves old file and in-memory name, then permits retry', t => {
  const { dir, file, labels } = fixture(t);
  labels.set('session-one', 'Original');
  const before = fs.readFileSync(file, 'utf8');
  const rename = fs.renameSync;
  const stub = t.mock.method(fs, 'renameSync', (source, target) => { if (target === file) throw new Error('Synthetic disk error'); return rename(source, target); });
  assert.throws(() => labels.set('session-one', 'Replacement'), /未能保存/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(labels.apply({ sessions: [{ id: 'session-one', name: 'Provider' }] }).sessions[0].name, 'Original');
  assert.deepEqual(fs.readdirSync(dir), ['session-labels.json']);
  assert.throws(() => labels.remove('session-one'), /未能保存/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  stub.mock.restore();
  labels.set('session-one', 'Replacement');
  assert.equal(new SessionLabels(dir).apply({ sessions: [{ id: 'session-one', name: 'Provider' }] }).sessions[0].name, 'Replacement');
});

test('unreadable or malformed metadata falls back visibly without overwriting it', t => {
  const { dir, file } = fixture(t);
  const invalid = '{partial data';
  fs.writeFileSync(file, invalid, { mode: 0o600 });
  const labels = new SessionLabels(dir);
  const snapshot = labels.apply({ sessions: [{ id: 'session-one', name: 'Provider' }] });
  assert.match(snapshot.sessionNameWarning, /无法读取/);
  assert.equal(snapshot.sessions[0].name, 'Provider');
  assert.throws(() => labels.set('session-one', 'New'), /未覆盖/);
  assert.equal(fs.readFileSync(file, 'utf8'), invalid);
});

test('metadata symlinks and overly open files are refused without touching their contents', t => {
  const { dir, file } = fixture(t);
  const other = path.join(dir, 'other.json');
  const contents = JSON.stringify({ version: 1, labels: { 'session-one': 'Other' } });
  fs.writeFileSync(other, contents, { mode: 0o600 });
  fs.symlinkSync(other, file);
  assert.throws(() => new SessionLabels(dir).set('session-one', 'Changed'), /未覆盖/);
  assert.equal(fs.readFileSync(other, 'utf8'), contents);
  fs.unlinkSync(file); fs.writeFileSync(file, contents, { mode: 0o644 });
  assert.match(new SessionLabels(dir).warning, /无法读取/);
});

test('sidebar migrates existing labels and persists profile presentation without touching native records', t => {
  const { dir, file } = fixture(t);
  fs.writeFileSync(file, JSON.stringify({ version: 1, labels: { a: 'Original label' } }), { mode: 0o600 });
  const labels = new SessionLabels(dir), records = [{ id: 'a', nativeId: 'original', pid: 123, owner: 'owner', roomId: 'shared', liveDraft: 'unsent' }, { id: 'b' }, { id: 'c', archived: true }];
  const before = structuredClone(records);
  assert.deepEqual(labels.sidebar, { order: [], sessionsCollapsed: false, workspaceCollapsed: false });
  labels.updateSidebar({ type: 'move', id: 'b', target: 'a', after: false }, records);
  labels.updateSidebar({ type: 'collapse', section: 'sessions', collapsed: true }, records);
  labels.set('b', 'Renamed');
  const reopened = new SessionLabels(dir), snapshot = reopened.apply({ sessions: records });
  assert.deepEqual(reopened.sidebar, { order: ['b', 'a', 'c'], sessionsCollapsed: true, workspaceCollapsed: false });
  assert.deepEqual(records, before);
  assert.deepEqual(snapshot.sessions[0], { ...records[0], name: 'Original label' });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('sidebar moves preserve archived positions, append new sessions and prune forgotten IDs', t => {
  const { labels } = fixture(t);
  const records = [{ id: 'a' }, { id: 'b' }, { id: 'c', archived: true }];
  labels.updateSidebar({ type: 'move', id: 'b', target: 'a', after: false }, records);
  labels.updateSidebar({ type: 'move', id: 'a', target: 'b', after: false }, [...records, { id: 'd' }]);
  assert.deepEqual(labels.sidebar.order, ['a', 'b', 'c', 'd']);
  labels.updateSidebar({ type: 'move', id: 'd', target: 'b', after: true }, records.filter(s => s.id !== 'a').concat({ id: 'd' }));
  assert.deepEqual(labels.sidebar.order, ['b', 'd', 'c']);
  const before = structuredClone(labels.sidebar);
  for (const change of [null, [], {}, { type: 'move', id: 'missing', target: 'b', after: true }, { type: 'move', id: 'c', target: 'b', after: true }, { type: 'move', id: 'b', target: 'd', after: 'false' }, { type: 'collapse', section: '__proto__', collapsed: true }, { type: 'collapse', section: 'workspace', collapsed: 1 }]) assert.throws(() => labels.updateSidebar(change, records));
  assert.deepEqual(labels.sidebar, before);
});

test('sidebar failed replacement leaves old order/collapse and labels intact for retry', t => {
  const { labels, file, dir } = fixture(t), records = [{ id: 'a' }, { id: 'b' }];
  labels.set('a', 'Original');
  const before = fs.readFileSync(file, 'utf8'), sidebar = structuredClone(labels.sidebar);
  const stub = t.mock.method(fs, 'renameSync', () => { throw Error('Synthetic disk failure'); });
  assert.throws(() => labels.updateSidebar({ type: 'move', id: 'b', target: 'a', after: false }, records), /未能保存/);
  assert.throws(() => labels.updateSidebar({ type: 'collapse', section: 'workspace', collapsed: true }, records), /未能保存/);
  assert.equal(fs.readFileSync(file, 'utf8'), before); assert.deepEqual(labels.sidebar, sidebar);
  assert.deepEqual(fs.readdirSync(dir), ['session-labels.json']); stub.mock.restore();
  labels.updateSidebar({ type: 'move', id: 'b', target: 'a', after: false }, records);
  assert.deepEqual(new SessionLabels(dir).sidebar.order, ['b', 'a']);
});

test('malformed sidebar metadata cannot erase existing names or permit overwrite', t => {
  const { file, dir } = fixture(t);
  for (const sidebar of [null, [], { order: ['a', 'a'], sessionsCollapsed: false, workspaceCollapsed: false }, { order: [], sessionsCollapsed: 'false', workspaceCollapsed: false }]) {
    const content = JSON.stringify({ version: 1, labels: { a: 'Original' }, sidebar }); fs.writeFileSync(file, content, { mode: 0o600 });
    const labels = new SessionLabels(dir); assert.match(labels.warning, /无法读取/);
    assert.throws(() => labels.updateSidebar({ type: 'collapse', section: 'sessions', collapsed: true }, []), /未覆盖/);
    assert.equal(fs.readFileSync(file, 'utf8'), content);
  }
});

test('sidebar section sizing persists beside legacy folds and retains closed section preferences', t => {
  const { dir, labels } = fixture(t); labels.set('a', 'Original');
  labels.updateSidebar({ type: 'resize', weights: [5000, 3000, 2000] }, []);
  labels.updateSidebar({ type: 'collapse', section: 'archive', collapsed: false }, []);
  labels.updateSidebar({ type: 'collapse', section: 'workspace', collapsed: true }, []);
  assert.deepEqual(new SessionLabels(dir).sidebar.weights, [5000, 3000, 2000]);
  assert.equal(new SessionLabels(dir).sidebar.archiveCollapsed, false);
  labels.set('a', 'Renamed');
  assert.deepEqual(new SessionLabels(dir).sidebar.weights, [5000, 3000, 2000]);
  assert.equal(new SessionLabels(dir).sidebar.workspaceCollapsed, true);
});
test('invalid sizes and failed sizing writes preserve existing labels and sidebar preferences', t => {
  const { file, labels } = fixture(t); labels.set('a', 'Original');
  const before = fs.readFileSync(file, 'utf8');
  for (const weights of [null, [], [1, 2], [1, 2, 3, 4], [0, 5000, 5000], [5000, -1, 5001], [NaN, 5000, 5000], [5000, Infinity, 5000], [4000.5, 3000, 2999.5], ['5000', 3000, 2000], [5000, 3000, 3000], Object.assign(new Array(3), { 0: 9998, 2: 2 })]) {
    assert.throws(() => labels.updateSidebar({ type: 'resize', weights }, []));
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  }
  const stub = t.mock.method(fs, 'renameSync', () => { throw Error('Synthetic size save failure'); });
  assert.throws(() => labels.updateSidebar({ type: 'resize', weights: [5000, 3000, 2000] }, []), /未能保存/);
  assert.equal(fs.readFileSync(file, 'utf8'), before); assert.equal(labels.sidebar.weights, undefined);
  stub.mock.restore(); labels.updateSidebar({ type: 'resize', weights: [5000, 3000, 2000] }, []);
  assert.deepEqual(labels.sidebar.weights, [5000, 3000, 2000]);
});
test('malformed saved optional sizing fields cannot silently overwrite existing local data', t => {
  const { dir, file } = fixture(t);
  for (const extra of [{ archiveCollapsed: 'false' }, { weights: [0, 5000, 5000] }, { weights: [1, 2, 3] }, { weights: { sessions: 5000 } }]) {
    const data = JSON.stringify({ version: 1, labels: { a: 'Original' }, sidebar: { order: [], sessionsCollapsed: false, workspaceCollapsed: false, ...extra } });
    fs.writeFileSync(file, data, { mode: 0o600 }); const loaded = new SessionLabels(dir);
    assert.match(loaded.warning, /无法读取/); assert.throws(() => loaded.set('a', 'New'), /未覆盖/);
    assert.equal(fs.readFileSync(file, 'utf8'), data);
  }
});
