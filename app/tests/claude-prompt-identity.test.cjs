const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { randomUUID } = require('node:crypto'), { EventEmitter } = require('node:events');
const { Claude } = require('../adapters.cjs');
const { SubmissionChannel, createSubmissionServer } = require('../claude-submit.cjs');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-identity-'));
  const nativeId = randomUUID(), promptId = randomUUID(), uuid = randomUUID();
  const r = Object.assign(Object.create(Claude.prototype), { record: { nativeId }, terminal: { alive: true }, nativeBlocks: true, nativeQueuedPromptLinks: true, rootLease: 'lease', observationEpoch: 'epoch', nativeTranscript: path.join(directory, `${nativeId}.jsonl`) });
  EventEmitter.call(r);
  const request = { sessionId: nativeId, lease: 'lease', epoch: 'epoch', promptId };
  const row = { type: 'user', uuid, promptId, sessionId: nativeId, isSidechain: false, message: { role: 'user', content: 'private text never returned' } };
  const write = rows => fs.writeFileSync(r.nativeTranscript, rows.map(row => typeof row === 'string' ? row : JSON.stringify(row)).join('\n') + '\n');
  write([row]); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, r, request, row, uuid, write };
}
test('T138 identity: only the accepted user UUID leaves the current root journal', async t => {
  const f = fixture(t);
  assert.deepEqual(await f.r.promptIdentity(f.request), { uuid: f.uuid });
  f.write(['{torn', f.row, '{unfinished']);
  assert.deepEqual(await f.r.promptIdentity(f.request), { uuid: f.uuid });
});
test('T138 identity: a native journal row flushed after the first display is read within the bounded request', async t => {
  const f = fixture(t); f.write([]);
  const timer = setTimeout(() => f.write([f.row]), 35); t.after(() => clearTimeout(timer));
  assert.deepEqual(await f.r.promptIdentity(f.request), { uuid: f.uuid });
});
test('T138 identity: an observer replacement during the journal wait revokes the answer', async t => {
  const f = fixture(t); f.write([]);
  const timer = setTimeout(() => { f.r.observationEpoch = 'replacement'; }, 10); t.after(() => clearTimeout(timer));
  await assert.rejects(() => f.r.promptIdentity(f.request), /Root unavailable/);
});
for (const change of ['prompt', 'session', 'child', 'role', 'uuid', 'duplicate', 'missing']) test(`T138 identity: ${change} cannot supply a prompt link`, async t => {
  const f = fixture(t), row = { ...f.row };
  if (change === 'prompt') row.promptId = randomUUID();
  if (change === 'session') row.sessionId = randomUUID();
  if (change === 'child') row.isSidechain = true;
  if (change === 'role') row.type = 'assistant';
  if (change === 'uuid') row.uuid = 'malformed';
  f.write(change === 'duplicate' ? [row, { ...row, uuid: randomUUID() }] : change === 'missing' ? [] : [row]);
  assert.deepEqual(await f.r.promptIdentity(f.request), { uuid: null });
});
test('T138 identity: journal lookup is bounded and refuses links, directories and other filenames', async t => {
  const f = fixture(t), file = f.r.nativeTranscript;
  fs.appendFileSync(file, ' '.repeat(262144));
  assert.deepEqual(await f.r.promptIdentity(f.request), { uuid: null }, 'An old row outside the bounded tail stays unknown');
  fs.unlinkSync(file); const other = path.join(f.directory, 'other.jsonl'); fs.writeFileSync(other, JSON.stringify(f.row));
  fs.symlinkSync(other, file); assert.deepEqual(await f.r.promptIdentity(f.request), { uuid: null });
  fs.unlinkSync(file); fs.mkdirSync(file); assert.deepEqual(await f.r.promptIdentity(f.request), { uuid: null });
  f.r.nativeTranscript = other; assert.deepEqual(await f.r.promptIdentity(f.request), { uuid: null });
});
for (const change of ['lease', 'session', 'epoch', 'ending', 'ended', 'disposed', 'retained', 'blocks', 'unqualified']) test(`T138 identity: ${change} revokes the private lookup`, async t => {
  const f = fixture(t), request = { ...f.request };
  if (change === 'lease') request.lease = 'older';
  if (change === 'session') request.sessionId = randomUUID();
  if (change === 'epoch') request.epoch = 'older';
  if (change === 'ending') f.r.rootEnding = true;
  if (change === 'ended') f.r.terminal.alive = false;
  if (change === 'disposed') f.r.disposed = true;
  if (change === 'retained') f.r.retainedReader = true;
  if (change === 'blocks') f.r.nativeBlocks = false;
  if (change === 'unqualified') f.r.nativeQueuedPromptLinks = false;
  await assert.rejects(() => f.r.promptIdentity(request), /Root unavailable/);
});
test('T138 identity: socket lookup keeps token/root/epoch checks and ignores caller filesystem paths', async t => {
  const f = fixture(t); f.r.submission = new SubmissionChannel();
  const socketPath = path.join(f.directory, 's'), transport = createSubmissionServer(socketPath, new Map([['root-token', f.r]]));
  await transport.start();
  t.after(async () => { f.r.submission.close(); transport.server.closeAllConnections(); await new Promise(resolve => transport.server.close(resolve)); });
  const request = (token, body) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method: 'POST', path: '/prompt-identity', headers: { 'X-Workspace-Token': token } }, res => {
      let text = ''; res.on('data', data => text += data); res.on('end', () => resolve({ status: res.statusCode, value: JSON.parse(text) }));
    }); req.on('error', reject); req.end(JSON.stringify(body));
  });
  assert.equal((await request('foreign', f.request)).status, 403);
  assert.equal((await request('root-token', { ...f.request, lease: 'stale' })).status, 409);
  assert.equal((await request('root-token', { ...f.request, epoch: 'stale' })).status, 409);
  assert.deepEqual(await request('root-token', { ...f.request, transcriptPath: '/ignored/path' }), { status: 200, value: { uuid: f.uuid } });
});
test('T138 identity: the queued-only capability never enables ordinary inputs, shell rows or whole turn records', () => {
  const r = Object.create(Claude.prototype); EventEmitter.call(r);
  r.record = { nativeId: randomUUID() }; r.terminal = { alive: true };
  const bound = r.bindRoot({ sessionId: r.record.nativeId, nativeBlocks: true, nativeQueuedPromptLinks: true });
  assert.equal(r.nativeTurnRecords, false); assert.equal(r.nativeNarration, false); assert.equal(r.nativeAbortAvailable, false);
  const base = { sessionId: r.record.nativeId, lease: bound.lease, epoch: bound.observationEpoch, block: true, id: 'control:turn-start', kind: 'control', turnId: 'queued-turn', status: 'running' };
  const prompt = randomUUID(), queued = `${prompt}-q1234abcd`, links = []; r.on('nativeTurnTriggers', info => links.push(info));
  for (const triggers of [{ prompts: [prompt], rows: [] }, { prompts: [], rows: [`tool:shell-${randomUUID()}`] }, { prompts: [queued, `${randomUUID()}-q1234abcd`], rows: [] }]) {
    assert.throws(() => r.observeBlock({ ...base, sequence: 1, triggers }), /Invalid native block/);
  }
  r.observeBlock({ ...base, sequence: 1, triggers: { prompts: [queued], rows: [] } });
  assert.deepEqual(links[0].prompts, [queued]);
});
