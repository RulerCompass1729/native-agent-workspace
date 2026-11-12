// The executed-operations record kept whole (the person, 2026-11-11: 「全保留，然后切分成小块（比如按天保持）」):
// settled records move from the state file into daily blocks and stay loaded, so receipts, repeated operation ids,
// conversation rows and restarts behave as before. Synthetic agents and handlers; nothing native, no model.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { BackgroundControl } = require('../background-control.cjs');

const DAY = 24 * 3600 * 1000, START = Date.UTC(2026, 10, 1, 12);
const sender = { id: 'agent', nativeId: 'native', provider: 'codex', name: 'Agent' };
const identity = { nativeId: 'native', sessionId: 'native-session', turnId: 'turn', callId: 'call' };
const binding = { sender, identity, valid: () => true };
const invoke = (id, method, args = []) => ({ action: 'invoke', operation_id: id, method, arguments: args });
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-background-history-')); fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = START, received = false; const runs = [];
  const handlers = new Map([['forward', (_c, text) => { runs.push(text); return text; }], ['send', (_c, id, text) => { runs.push(text); return { sent: true }; }]]);
  const config = { dataDir: dir, handlers, now: () => clock, context: async (actor, saved) => ({ background: true, view: saved || { selected: actor.id, draft: '' }, confirmationActors: () => [actor],
    checkActor: async () => {}, client: { close() {} }, win: { destroy() {} },
    delivery: async command => command.method === 'send' ? { recipientId: command.arguments[0], nativeReceived: received, status: received ? 'submitted' : 'unconfirmed' } : null }) };
  const file = path.join(dir, 'background-operations.json'), store = path.join(dir, 'history', 'operations');
  return { dir, file, store, config, runs, controller: new BackgroundControl(config), reopen() { return new BackgroundControl(config); }, at(time) { clock = time; }, get clock() { return clock; },
    receive() { received = true; }, state: () => JSON.parse(fs.readFileSync(file, 'utf8')),
    blocks: () => fs.existsSync(store) ? fs.readdirSync(store).filter(name => /^\d{9,12}-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort() : [],
    lines: () => fs.readdirSync(store).filter(name => name.endsWith('.jsonl')).sort().flatMap(name => fs.readFileSync(path.join(store, name), 'utf8').split('\n').filter(Boolean).map(JSON.parse)) };
}

test('a record that settled moves to the day\'s block and is still found: receipt, repeated id, conversation rows, restart', async t => {
  const f = setup(t);
  await f.controller.call(binding, invoke('op-1', 'forward', ['one']));
  assert.deepEqual([f.state().version, f.state().records.map(r => r.id), f.blocks()], [2, ['op-1'], []], 'Nothing settles within a day');
  f.at(START + DAY + 1);
  await f.controller.call(binding, invoke('op-2', 'forward', ['two']));
  assert.deepEqual(f.state().records.map(r => r.id), ['op-2'], 'The state file no longer holds it');
  assert.deepEqual([f.blocks(), f.lines().map(line => [line.sequence, line.day, line.value.id, line.value.state])], [['000000001-2026-11-02.jsonl'], [[1, '2026-11-01', 'op-1', 'complete']]]);
  for (const controller of [f.controller, f.reopen()]) {
    assert.deepEqual(((await controller.call(binding, { action: 'receipt', operation_id: 'op-1' })).receipt), { ...f.lines()[0].value });
    assert.equal((await controller.call(binding, invoke('op-1', 'forward', ['one']))).duplicate, true);
    await assert.rejects(controller.call(binding, invoke('op-1', 'forward', ['other'])), /different command/);
    assert.deepEqual(controller.rows('agent').map(row => row.backgroundOperation.id), ['op-1', 'op-2']);
  }
  assert.deepEqual(f.runs, ['one', 'two'], 'An operation id that settled is never run again');
});

test('an older version\'s file is kept as it was, its settled records move to blocks, and the state file becomes one it refuses', async t => {
  const f = setup(t); f.controller = null;
  const row = (id, at, state, extra = {}) => ({ id, actor: { ...sender, callId: 'call', turnId: 'turn', operationId: id }, command: invoke(id, 'forward', [id]), state, at, ...(state === 'running' ? {} : { finishedAt: at, value: id }), ...extra });
  const older = { version: 1, records: [row('old', START - 3 * DAY, 'complete'), row('recent', START - 1000, 'complete'), row('stuck', START - 5 * DAY, 'running')], views: {}, refusals: [], refusalActors: {}, refusalReceipts: [] };
  const bytes = JSON.stringify(older); fs.writeFileSync(f.file, bytes, { mode: 0o600 });
  const controller = f.reopen();
  assert.equal(fs.readFileSync(path.join(f.store, 'legacy-0001.json'), 'utf8'), bytes, 'Its bytes are kept');
  assert.equal(f.state().version, 2, 'An older version refuses this file instead of starting empty');
  assert.deepEqual(f.state().records.map(r => [r.id, r.state]), [['recent', 'complete']]);
  assert.deepEqual(f.lines().map(line => [line.value.id, line.value.state]), [['old', 'complete'], ['stuck', 'unconfirmed']], 'A stop while it ran is unconfirmed, never run again');
  for (const id of ['old', 'recent', 'stuck']) assert.equal((await controller.call(binding, invoke(id, 'forward', [id]))).duplicate, true, id);
  assert.deepEqual(f.runs, []);
  // Started again, nothing is moved twice and the older file is kept once.
  f.reopen(); assert.equal(f.lines().length, 2); assert.deepEqual(fs.readdirSync(f.store).filter(name => name.startsWith('legacy-')), ['legacy-0001.json']);
  // An older version's file appearing again (the person went back and its file came back): taken in after what is
  // there; an operation id already recorded keeps what was recorded first.
  const again = { ...older, records: [{ ...row('old', START - 3 * DAY, 'complete'), value: 'changed later' }, row('new-there', START - 2 * DAY, 'complete')] };
  fs.writeFileSync(f.file, JSON.stringify(again), { mode: 0o600 });
  const back = f.reopen();
  assert.equal((await back.call(binding, { action: 'receipt', operation_id: 'old' })).receipt.value, 'old');
  assert.equal((await back.call(binding, invoke('new-there', 'forward', ['new-there']))).duplicate, true);
  assert.deepEqual(fs.readdirSync(f.store).filter(name => name.startsWith('legacy-')).sort(), ['legacy-0001.json', 'legacy-0002.json']);
  assert.deepEqual(f.runs, []);
});

test('a settled send confirmed on a later receipt is added to its block again, and the later line holds after a restart', async t => {
  const f = setup(t);
  assert.equal((await f.controller.call(binding, invoke('send-1', 'send', ['other', 'hello']))).state, 'awaiting-native');
  f.at(START + 2 * DAY); await f.controller.call(binding, invoke('op-2', 'forward', ['two']));
  assert.deepEqual(f.lines().map(line => [line.value.id, line.value.state]), [['send-1', 'awaiting-native']]);
  f.receive();
  assert.equal((await f.controller.call(binding, { action: 'receipt', operation_id: 'send-1' })).receipt.state, 'received');
  assert.deepEqual(f.lines().map(line => [line.value.id, line.value.state]), [['send-1', 'awaiting-native'], ['send-1', 'received']]);
  const reopened = f.reopen();
  assert.equal((await reopened.call(binding, { action: 'receipt', operation_id: 'send-1' })).receipt.state, 'received');
  assert.deepEqual(reopened.rows('agent').map(row => [row.backgroundOperation.id, row.backgroundOperation.state]), [['send-1', 'received'], ['op-2', 'complete']]);
  assert.deepEqual(f.runs, ['hello', 'two']);
});

test('a stop after a record reached its block but before the state file was written leaves it once, as its block has it', async t => {
  const f = setup(t);
  await f.controller.call(binding, invoke('op-1', 'forward', ['one'])); f.at(START + 2 * DAY);
  // The next save moves op-1 to its block, then cannot write the state file: op-2 is not run.
  const rename = fs.renameSync; let failed = 0;
  t.mock.method(fs, 'renameSync', (from, to, ...rest) => { if (to === f.file && !failed++) throw Object.assign(Error('synthetic stop'), { code: 'EIO' }); return rename(from, to, ...rest); });
  await assert.rejects(f.controller.call(binding, invoke('op-2', 'forward', ['two'])), /unconfirmed/);
  t.mock.restoreAll();
  assert.deepEqual([f.state().records.map(r => r.id), f.lines().map(line => line.value.id), f.runs], [['op-1'], ['op-1'], ['one']]);
  const reopened = f.reopen();
  assert.deepEqual(reopened.data.records.map(r => r.id), [], 'The state file\'s copy is set aside');
  assert.deepEqual(reopened.rows('agent').map(row => row.backgroundOperation.id), ['op-1']);
  assert.equal((await reopened.call(binding, invoke('op-1', 'forward', ['one']))).duplicate, true);
  // op-2 was never recorded, so it was never run: asked again, it runs once.
  assert.equal((await reopened.call(binding, invoke('op-2', 'forward', ['two']))).state, 'complete'); assert.deepEqual(f.runs, ['one', 'two']);
});

test('a block that does not read stops background operations; a last line cut short by a stop is kept and sealed', async t => {
  const f = setup(t);
  await f.controller.call(binding, invoke('op-1', 'forward', ['one'])); f.at(START + 2 * DAY);
  await f.controller.call(binding, invoke('op-2', 'forward', ['two'])); f.at(START + 4 * DAY);
  await f.controller.call(binding, invoke('op-3', 'forward', ['three']));
  assert.deepEqual(f.blocks(), ['000000001-2026-11-03.jsonl', '000000002-2026-11-05.jsonl']);
  // Cut short: kept as it is, the block sealed, its whole lines read.
  const open = path.join(f.store, f.blocks()[1]); fs.appendFileSync(open, '{"sequence":3,"ti');
  const reopened = f.reopen(); assert.equal((await reopened.call(binding, invoke('op-2', 'forward', ['two']))).duplicate, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.store, 'manifest.json'))).blocks[1].status, 'sealed');
  // A sealed block changed: nothing can be looked up there, so nothing is run.
  const sealed = path.join(f.store, f.blocks()[0]), text = fs.readFileSync(sealed, 'utf8');
  fs.writeFileSync(sealed, text.replace('"one"', '"two"'), { mode: 0o600 });
  assert.throws(() => f.reopen(), /history cannot be read/);
  // Missing, the same.
  fs.rmSync(sealed); assert.throws(() => f.reopen(), /history cannot be read/);
  assert.deepEqual(f.runs, ['one', 'two', 'three']);
});

test('a record still pending stays in the state file however old: running, awaiting a decision, or an unread copy', async t => {
  const f = setup(t), old = START - 5 * DAY, row = (id, state, extra = {}) => ({ id, actor: { ...sender, callId: 'call', turnId: 'turn', operationId: id }, command: invoke(id, 'forward', [id]), state, at: old, ...extra });
  f.controller.commit(d => d.records.push(row('asks', 'confirmation-required', { confirmation: { kind: 'message', options: { buttons: ['No', 'Yes'] } } }),
    row('copy', 'complete', { finishedAt: old, readState: 'available' }), row('copy-pending', 'complete', { finishedAt: old, readState: 'pending' }), row('done', 'complete', { finishedAt: old })));
  assert.deepEqual(f.state().records.map(r => r.id), ['asks', 'copy', 'copy-pending']);
  assert.deepEqual(f.lines().map(line => line.value.id), ['done']);
});
