const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events'), { randomUUID } = require('node:crypto');
const { Claude } = require('../adapters.cjs'), { Workspace } = require('../workspace.cjs');
const { SubmissionChannel } = require('../claude-submit.cjs');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=';
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-claude-media-')), r = Object.create(Claude.prototype); EventEmitter.call(r);
  r.record = { id: 'session', nativeId: randomUUID(), provider: 'claude', messages: [], state: 'working', owner: 'window', controlRevision: 0, memberRevision: 0, connectionRevision: 0 };
  r.terminal = { alive: true }; r.submission = new SubmissionChannel();
  const w = new Workspace({ binaries: {}, close() {} }, dir); w.sessions.set(r.record.id, r.record); w.runtimes.set(r.record.id, r); w.bind(r.record, r);
  t.after(() => { try { w.close(); } finally { fs.rmSync(dir, { recursive: true, force: true }); } });
  const bind = (extra = {}) => r.bindRoot({ sessionId: r.record.nativeId, nativeBlocks: true, nativeInlineInput: true, nativePromptInput: true, nativeMedia: true, ...extra });
  const emit = value => r.observeRoot({ block: true, sessionId: r.record.nativeId, lease: r.rootLease, epoch: r.observationEpoch, sequence: (r.rootObservation?.sequence || 0) + 1, ...value });
  const media = (extra = {}) => emit({ id: 'tool:read', kind: 'tool', status: 'complete', mediaOnly: true, imagePayload: { index: 0, mime: 'image/png', data: png }, ...extra });
  bind();
  const original = () => { emit({ id: 'tool:read', kind: 'tool', title: 'Read', input: '{"file_path":"/synthetic/original.png"}', text: '', turnId: 'T', status: 'running' });
    emit({ id: 'tool:read', kind: 'tool', title: 'Read', text: 'ORIGINAL_NATIVE_RESULT', turnId: 'T', status: 'complete' }); };
  return { dir, r, w, bind, emit, media, original };
}
test('media capability requires an explicit receiver acknowledgement and resets on rebind', t => {
  const f = fixture(t); assert.equal(f.bind().nativeMedia, true);
  for (const value of [undefined, false]) assert.equal(f.bind({ nativeMedia: value }).nativeMedia, false);
  assert.equal(f.bind({ nativeBlocks: false }).nativeMedia, false);
});
test('tool media enriches the exact original row without changing native text, turn or control', t => {
  const f = fixture(t); f.original(); const row = f.r.record.messages[0], revision = f.r.record.controlRevision;
  f.media(); assert.strictEqual(f.r.record.messages[0], row); assert.equal(row.text, 'ORIGINAL_NATIVE_RESULT'); assert.equal(row.turnId, 'T');
  assert.equal(row.images[0].kind, 'native-pixels'); assert.equal(f.r.record.controlRevision, revision);
  assert.deepEqual(fs.readFileSync(row.images[0].cachedPath), Buffer.from(png, 'base64'));
  assert.ok(!JSON.stringify(f.w.snapshot()).includes(png)); f.w.persist(); assert.ok(!fs.readFileSync(path.join(f.dir, 'workspace.json'), 'utf8').includes(png));
});
test('image metadata cannot create an original row, rewrite its text or supply attribution', t => {
  const f = fixture(t); assert.throws(() => f.media()); assert.equal(f.r.record.messages.length, 0); f.original();
  for (const extra of [{ text: 'replacement' }, { inputTag: randomUUID() }, { turnId: 'later' }, { kind: 'response' }, { title: 'Different' }, { mediaOnly: false }]) assert.throws(() => f.media(extra));
  assert.equal(f.r.record.messages[0].text, 'ORIGINAL_NATIVE_RESULT'); assert.equal(f.r.record.messages[0].images, undefined);
});
test('native input media never repeats a human boundary or creates a second input', t => {
  const f = fixture(t), id = 'prompt:' + randomUUID(); let boundaries = 0, inputs = 0;
  f.r.on('nativeControlBoundary', () => boundaries++); f.r.on('nativeInput', () => inputs++);
  f.emit({ id, kind: 'input', inputMode: 'native-inline', title: '工作中插入', text: 'ORIGINAL_INPUT', status: 'complete' });
  const before = { boundaries, inputs, revision: f.r.record.controlRevision };
  f.media({ id, kind: 'input' }); f.media({ id, kind: 'input' });
  assert.deepEqual({ boundaries, inputs, revision: f.r.record.controlRevision }, before);
  assert.equal(f.r.record.messages.length, 1); assert.equal(f.r.record.messages[0].text, 'ORIGINAL_INPUT'); assert.equal(f.r.record.messages[0].images.length, 1);
});
test('old epochs, unqualified consumers, raw non-metadata payloads and foreign native IDs cannot write blobs', t => {
  const f = fixture(t); f.original(); const oldEpoch = f.r.observationEpoch; f.bind();
  assert.throws(() => f.media({ epoch: oldEpoch })); assert.throws(() => f.media({ sessionId: randomUUID() }));
  assert.throws(() => f.media({ mediaOnly: undefined, text: 'ORIGINAL_NATIVE_RESULT' }));
  f.bind({ nativeMedia: false }); assert.throws(() => f.media());
  assert.equal(fs.existsSync(path.join(f.dir, 'native-image-cache')), false);
});
test('only an already accepted complete original can receive media', t => {
  const f = fixture(t); f.original();
  for (const status of ['running', 'failed', 'interrupted']) { f.r.record.messages[0].status = status; assert.throws(() => f.media()); }
  assert.equal(fs.existsSync(path.join(f.dir, 'native-image-cache')), false);
});
test('a retired binding cannot leave a partially delivered image row looking complete and text-only', t => {
  const f = fixture(t); f.original();
  f.emit({ id: 'tool:read', kind: 'tool', text: 'ORIGINAL_NATIVE_RESULT', turnId: 'T', status: 'complete', imageCount: 2 });
  const row = f.r.record.messages[0]; assert.equal(row.images.length, 2);
  f.media(); assert.equal(row.images[0].unavailable, undefined); assert.equal(row.images[1].pending, true);
  const epoch = f.r.observationEpoch; f.bind(); assert.throws(() => f.media({ epoch, imagePayload: { index: 1, mime: 'image/png', data: png } }));
  assert.equal(row.images[1].pending, true); assert.match(row.images[1].unavailable, /同步/);
  f.w.persist(); assert.match(fs.readFileSync(path.join(f.dir, 'workspace.json'), 'utf8'), /图片尚未完整同步/);
  assert.equal(row.text, 'ORIGINAL_NATIVE_RESULT'); assert.equal(row.status, 'complete');
});
test('image enrichment preserves the original submitted state and all native text fields', t => {
  const f = fixture(t), id = 'prompt:' + randomUUID();
  f.emit({ id, kind: 'input', inputMode: 'native-prompt', text: 'ORIGINAL_INPUT', status: 'complete' });
  const row = f.r.record.messages[0]; row.status = 'submitted'; const revision = f.r.record.controlRevision;
  f.media({ id, kind: 'input' });
  assert.equal(row.status, 'submitted'); assert.equal(row.text, 'ORIGINAL_INPUT'); assert.equal(f.r.record.controlRevision, revision);
  assert.equal(row.images[0].kind, 'native-pixels');
});
test('expected image slots require a qualified complete original and a bounded integer', t => {
  const f = fixture(t); f.original();
  for (const imageCount of [0, 18, 1.5, '1']) assert.throws(() => f.emit({ id: 'tool:read', kind: 'tool', status: 'complete', imageCount }));
  assert.throws(() => f.emit({ id: 'tool:read', kind: 'tool', status: 'failed', imageCount: 1 }));
  f.bind({ nativeMedia: false }); assert.throws(() => f.emit({ id: 'tool:read', kind: 'tool', status: 'complete', imageCount: 1 }));
  assert.equal(f.r.record.messages[0].images, undefined);
});
test('actual private HTTP channel expands only qualified observation bodies and keeps action limits', async t => {
  const { createSubmissionServer } = require('../claude-submit.cjs'), http = require('node:http');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-media-http-')), socketPath = path.join(dir, 'submit.sock'); let calls = 0;
  const target = { record: { nativeId: 'synthetic-http-root' }, submission: new SubmissionChannel(), nativeMedia: false, observeRoot() { calls++; return { observed: true }; } };
  const { server, start } = createSubmissionServer(socketPath, new Map([['synthetic-token', target]])); await start();
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  const send = (route, length) => new Promise(resolve => {
    const request = http.request({ socketPath, path: route, method: 'POST', headers: { 'X-Workspace-Token': 'synthetic-token', 'Content-Type': 'application/json' } }, response => {
      response.resume(); response.on('end', () => resolve({ status: response.statusCode }));
    });
    request.on('error', error => resolve({ error: error.code || error.message })); request.setTimeout(2000, () => request.destroy(Error('fixture timeout')));
    request.end(JSON.stringify({ sessionId: 'synthetic-http-root', padding: 'A'.repeat(length) }));
  });
  assert.notEqual((await send('/observation', 650000)).status, 200); assert.equal(calls, 0);
  target.nativeMedia = true; assert.equal((await send('/observation', 650000)).status, 200); assert.equal(calls, 1);
  assert.notEqual((await send('/observation', 2 * 1024 * 1024 + 100)).status, 200); assert.equal(calls, 1);
  assert.notEqual((await send('/authorize', 110000)).status, 200); assert.equal(calls, 1);
});
