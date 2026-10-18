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
