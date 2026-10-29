const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { randomUUID } = require('node:crypto'), { EventEmitter } = require('node:events');
const { Claude } = require('../adapters.cjs');
const { LegacyClaude } = require('../legacy-claude.cjs');
const { SubmissionChannel } = require('../claude-submit.cjs');
const { Workspace } = require('../workspace.cjs');
const { applyNativeBlock, persistedMessages } = require('../native-blocks.cjs');
const { processIdentity } = require('../platform.cjs');

function managed() {
  const r = Object.create(Claude.prototype); EventEmitter.call(r);
  r.record = { id: 'inline', nativeId: randomUUID(), provider: 'claude', messages: [], state: 'working', owner: 'window', controlRevision: 0, memberRevision: 0, connectionRevision: 0 };
  r.terminal = { alive: true }; r.submission = new SubmissionChannel(); return r;
}
function bind(r, extra = {}) { return r.bindRoot({ sessionId: r.record.nativeId, nativeBlocks: true, nativeInlineInput: true, nativePromptInput: true, ...extra }); }
function emit(r, extra = {}) {
  return r.observeRoot({ block: true, sessionId: r.record.nativeId, lease: r.rootLease, epoch: r.observationEpoch,
    sequence: (r.rootObservation?.sequence || 0) + 1, id: `prompt:${randomUUID()}`, kind: 'input', inputMode: 'native-inline',
    text: '原始插入文字\n第二行 🙂', title: '工作中插入', status: 'complete', ...extra });
}
function retained(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-inline-unit-'));
  const record = { id: 'retained-inline', provider: 'claude', nativeId: randomUUID(), pid: process.pid,
    processIdentity: processIdentity(process.pid), state: 'idle', messages: [] };
  const readers = [], create = () => { const r = new LegacyClaude(record, dir, async () => record); readers.push(r); return r; };
  t.after(() => { readers.forEach(r => r.close()); fs.rmSync(dir, { recursive: true, force: true }); });
  return { record, create, r: create() };
}

test('consumer opt-in is explicit and resets with every root binding', () => {
  const r = managed();
  for (const value of [undefined, false]) assert.equal(bind(r, { nativeInlineInput: value }).nativeInlineInput, false);
  assert.equal(bind(r).nativeInlineInput, true);
  assert.equal(bind(r, { nativePromptInput: undefined }).nativeInlineInput, false);
  assert.equal(bind(r, { nativeBlocks: false }).nativeInlineInput, false);
  assert.throws(() => emit(r), /Invalid native block/);
});

test('accepted managed input preserves exact text, native identity, mode and title without a send or receipt', () => {
  const r = managed(); bind(r); const input = [], bound = [];
  r.on('nativeBlock', e => { input.push(e); applyNativeBlock(r.record, e); });
  r.on('submitted', e => bound.push(e)); r.on('replyBound', e => bound.push(e));
  const uuid = randomUUID(); emit(r, { id: `prompt:${uuid}`, turnId: 'actual-turn' });
  const row = r.record.messages[0];
  assert.equal(row.id, `native:${r.record.nativeId}:prompt:${uuid}`);
  assert.equal(row.text, '原始插入文字\n第二行 🙂'); assert.equal(row.title, '工作中插入');
  assert.equal(row.inputMode, 'native-inline'); assert.equal(row.turnId, 'actual-turn');
  assert.equal(row.role, 'user'); assert.equal(row.nativeBlock, true);
  assert.equal(input[0].inputTag, undefined); assert.equal(input[0].promptId, undefined); assert.deepEqual(bound, []);
});

test('same UUID reobserves one row, equal text under different UUIDs remains two and survives persistence', () => {
  const r = managed(); bind(r); r.on('nativeBlock', e => applyNativeBlock(r.record, e));
  const a = `prompt:${randomUUID()}`, b = `prompt:${randomUUID()}`;
  emit(r, { id: a }); emit(r, { id: b }); emit(r, { id: a, replayed: true });
  assert.equal(r.record.messages.length, 2); assert.equal(new Set(r.record.messages.map(m => m.id)).size, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(persistedMessages(r.record.messages))), JSON.parse(JSON.stringify(r.record.messages)));
});

test('unknown mode, forged correlation and invalid scope cannot enter the new input class', () => {
  const r = managed(); bind(r); const seen = []; r.on('nativeBlock', e => seen.push(e)); r.on('nativeInput', e => seen.push(e));
  for (const extra of [{ inputMode: undefined }, { inputMode: 'queue' }, { inputTag: randomUUID() }, { promptId: randomUUID() },
    { id: 'prompt:guessed' }, { kind: 'input', title: 'invented' }, { status: 'streaming' }, { text: 1 },
    { turnId: 'invalid turn' }, { turnId: 123 }, { delta: 'invented' }, { index: 0 }, { input: 'invented' }, { incomplete: 'true' },
    { displayTurnId: 'invented' }, { epoch: 'stale' }, { lease: 'stale' }, { sessionId: randomUUID() }]) {
    assert.throws(() => emit(r, extra), /Invalid native block/, JSON.stringify(extra));
  }
  assert.deepEqual(seen, []);
});

test('native inline input closes a shared continuation without copying the private input or duplicating its row', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-inline-sharing-'));
  const w = new Workspace({ binaries: {}, close() {} }, dir), r = managed(), s = r.record; bind(r);
  t.after(() => { w.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  s.roomId = 'shared'; w.sessions.set(s.id, s); w.runtimes.set(s.id, r); w.bind(s, r);
  const source = { id: randomUUID() }, tag = randomUUID(), turnId = 'shared-turn', promptId = 'shared-prompt';
  w.sharedReplies.authorize(s, r, tag, source); w.sharedReplies.bind(s, tag, { nativeId: s.nativeId, turnId, promptId });
  emit(r, { id: 'display:shared', kind: 'response', text: undefined, title: undefined, inputMode: undefined, turnId, promptId, index: 0, delta: 'SHARED_PREFIX', status: 'streaming' });
  assert.equal(w.room.messages.find(m => m.text === 'SHARED_PREFIX')?.status, 'streaming');
  w.drafts.set(s.id, 'UNSENT_DRAFT'); const uuid = randomUUID();
  emit(r, { id: 'control:input', kind: 'control', inputMode: undefined, text: undefined, title: undefined });
  emit(r, { id: `prompt:${uuid}`, turnId });
  assert.equal(s.messages.filter(m => m.id === `native:${s.nativeId}:prompt:${uuid}`).length, 1);
  assert.equal(s.controlRevision, 1); assert.equal(w.drafts.get(s.id), 'UNSENT_DRAFT');
  emit(r, { id: 'display:shared', kind: 'response', text: undefined, title: undefined, inputMode: undefined, turnId, promptId, index: 1, delta: 'PRIVATE_CONTINUATION', status: 'streaming' });
  assert.equal(s.messages.find(m => m.id.endsWith('display:shared')).text, 'SHARED_PREFIXPRIVATE_CONTINUATION');
  assert.ok(!JSON.stringify(w.room.messages).includes('PRIVATE_CONTINUATION'));
  assert.ok(!JSON.stringify(w.room.messages).includes('原始插入文字'));
  emit(r, { id: `prompt:${uuid}`, turnId, replayed: true });
  assert.equal(s.controlRevision, 1, 'Reobserving an old UUID is not a new human input');
  assert.equal(w.versions.dispatches, 0);
});

test('one native prompt ingress plus its settings hook and accepted attachment produces one user row and one pause', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-inline-paired-'));
  const w = new Workspace({ binaries: {}, close() {} }, dir), r = managed(), s = r.record; bind(r);
  t.after(() => { w.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  w.sessions.set(s.id, s); w.runtimes.set(s.id, r); w.bind(s, r);
  emit(r, { id: 'control:turn-start', kind: 'control', inputMode: undefined, text: undefined, title: undefined,
    turnId: 'actual-turn', promptId: randomUUID(), status: 'running' });
  emit(r, { id: 'control:input', kind: 'control', inputMode: undefined, text: undefined, title: undefined });
  r.hook({ hook_event_name: 'UserPromptSubmit', session_id: s.nativeId, prompt_id: randomUUID(), prompt: 'PAIRED_NATIVE_INPUT' });
  emit(r, { text: 'PAIRED_NATIVE_INPUT', turnId: 'actual-turn' });
  assert.equal(s.messages.filter(m => m.role === 'user').length, 1);
  assert.equal(s.controlRevision, 1);
  assert.equal(w.versions.dispatches, 0);
});

test('qualified ordinary native input uses its accepted UUID while its settings hook is not a second display row', () => {
  const r = managed(); bind(r); const seen = [];
  r.on('nativeBlock', e => applyNativeBlock(r.record, e)); r.on('nativeInput', (text, item) => seen.push({ text, item }));
  emit(r, { id: 'control:input', kind: 'control', inputMode: undefined, text: undefined, title: undefined });
  r.hook({ hook_event_name: 'UserPromptSubmit', session_id: r.record.nativeId, prompt_id: randomUUID(), prompt: 'ORDINARY_NATIVE_TEXT' });
  const id = `prompt:${randomUUID()}`; emit(r, { id, inputMode: 'native-prompt', title: undefined, text: 'ORDINARY_NATIVE_TEXT' });
  assert.equal(r.record.messages.length, 1); assert.equal(r.record.messages[0].inputMode, 'native-prompt');
  assert.equal(r.record.messages[0].id, `native:${r.record.nativeId}:${id}`);
  assert.deepEqual(seen, [{ text: '', item: { display: false } }]);
});

test('a fresh input after an observation gap still pauses; replayed ingress creates no fresh input or row', () => {
  const r = managed(); bind(r); const boundaries = [];
  r.on('nativeInput', (text, item) => boundaries.push({ text, item }));
  emit(r, { id: 'control:input', kind: 'control', inputMode: undefined, text: undefined, title: undefined, gap: true });
  assert.deepEqual(boundaries, [{ text: '', item: { display: false } }]);
  emit(r, { id: 'control:input', kind: 'control', inputMode: undefined, text: undefined, title: undefined, replayed: true });
  assert.equal(boundaries.length, 1);
});

test('retained queue keeps exact tagged reconciliation and explicitly declines ambiguous inline inputs', async t => {
  const f = retained(t), r = f.r, tag = randomUUID(), text = 'IDENTICAL_QUEUE_TEXT';
  const result = await bind(r, { nativeQueue: true }); assert.equal(result.nativeInlineInput, false);
  r.record.messages.push({ id: tag, role: 'user', nativeId: r.record.nativeId, kind: 'input', inputMode: 'queue', text, status: 'awaiting-native' });
  assert.throws(() => emit(r, { text }), /Invalid native block/);
  emit(r, { inputMode: undefined, inputTag: tag, id: 'prompt:original-tagged-input', title: undefined, text });
  const inputs = r.record.messages.filter(m => m.kind === 'input');
  assert.equal(inputs.length, 1); assert.equal(inputs[0].text, text);
  assert.equal(inputs[0].id, `native:${r.record.nativeId}:prompt:original-tagged-input`);
});

test('retained observer without native queue keeps distinct inline identities and cached original text', async t => {
  const f = retained(t), r = f.r; assert.equal((await bind(r, { nativeQueue: false })).nativeInlineInput, true);
  const uuid = randomUUID(); emit(r, { id: `prompt:${uuid}`, incomplete: true }); emit(r, { id: `prompt:${uuid}`, replayed: true });
  assert.equal(r.record.messages.filter(m => m.kind === 'input').length, 1); r.close();
  const next = f.create(); await bind(next, { nativeQueue: false });
  const row = next.record.messages.find(m => m.kind === 'input');
  assert.equal(row.text, '原始插入文字\n第二行 🙂'); assert.equal(row.inputMode, 'native-inline'); assert.equal(row.incomplete, true);
});

test('clear and a lost clear ACK reaffirm capability while old contexts remain rejected', () => {
  const r = managed(); bind(r); const old = { sessionId: r.record.nativeId, lease: r.rootLease, epoch: r.observationEpoch };
  r.on('contextClear', change => { r.record.nativeId = change.nativeId; change.committed = true; });
  r.endRoot({ ...old, reason: 'clear' }); const request = { ...old, nextSessionId: randomUUID(), source: 'clear' };
  assert.equal(r.clearRoot(request).nativeInlineInput, true); assert.equal(r.clearRoot(request).nativeInlineInput, true);
  assert.throws(() => emit(r, old), /Invalid native block/);
  r.on('nativeBlock', e => applyNativeBlock(r.record, e)); emit(r); assert.equal(r.record.messages.filter(m => m.kind === 'input').length, 1);
});

test('real producer handshake qualifies only inspected native versions and retained queue modes', async () => {
  const original = fs.readFileSync(path.join(__dirname, '../claude-bridge/hooks/register.js'), 'utf8');
  for (const legacy of [false, true]) for (const version of ['2.1.302', '2.1.309', '2.1.310', '2.1.311', '2.1.312', '2.1.313']) {
    const source = original.replace('const legacyOnly = false;', `const legacyOnly = ${legacy};`) + '\nnativeBlocks=true; export { bindRoot as testBind };\n//' + randomUUID();
    const mod = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
    const r = managed(); r.retainedReader = legacy; let reply;
    await mod.testBind({ session: { id: async () => r.record.nativeId, version: async () => ({ version }) }, env: { get: async k => k === 'NAW_SUBMIT_SOCKET' ? '/fixture/socket' : 'fixture-token' },
      clock: { after: () => ({ cancel() {} }) }, tool: { list: async () => [] },
      http: { fetch: async (url, options) => ({ ok: true, text: JSON.stringify(new URL(url).pathname === '/root-bind'
        ? (reply = r.bindRoot(JSON.parse(options.body))) : { closed: true }) }) } }, 0);
    assert.equal(reply.nativeInlineInput, ['2.1.310', '2.1.311', '2.1.312'].includes(version), `${legacy ? 'retained' : 'managed'} ${version}`);
  }
});
