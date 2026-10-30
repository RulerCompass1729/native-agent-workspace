const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { captureSource, prepareBatch, assertCurrentSources, sameOperation, validateBatch, materializeBatch } = require('../space-merge.cjs');
const { withMembership } = require('../collaboration-spaces.cjs');
const { persistedMessages } = require('../native-blocks.cjs');
const A = '10000000-0000-4000-8000-000000000001', B = '20000000-0000-4000-8000-000000000002';
const room = (id, extra = {}) => ({ id, name: id === A ? 'A' : 'B', revision: 2, metadataRevision: 3,
  notes: '', files: [], events: [], messages: [], run: null, ...extra });
const session = (id, nativeId = `native-${id}`) => withMembership(withMembership({ id, nativeId, provider: 'codex', name: 'Same name',
  roomId: null, controlRevision: 7, connectionRevision: 2, messages: [{ text: 'PRIVATE' }], liveDraft: 'UNSENT',
  goal: { status: 'blocked' }, settings: { model: 'UNCHANGED' } }, A, true), B, true);
const message = (id, extra = {}) => ({ id, role: 'assistant', text: `Original ${id}`, status: 'complete', time: 12, sessionId: 's', ...extra });
const spec = extra => ({ operationId: randomUUID(), targetId: randomUUID(), name: 'New C', disposition: 'keep', memberIds: ['s'], ...extra });
const capture = (a = {}, b = {}, sessions = [session('s')]) => [captureSource(room(A, a), sessions), captureSource(room(B, b), sessions)];

test('a snapshot contains only selected shared room facts, never session drafts, goals, private history or grants', () => {
  const s = session('s'), a = room(A, { messages: [message('m', { grant: 'TOKEN', sourceTag: 'AUTH', runId: 'RUN' })],
    run: { id: 'run', status: 'running', grant: 'TOKEN', goal: 'PRIVATE GOAL' }, sharedDraft: 'PRIVATE ROOM DRAFT' });
  const before = JSON.stringify([s, a]);
  const batch = prepareBatch([captureSource(a, [s]), captureSource(room(B), [s])], spec());
  assert.equal(JSON.stringify([s, a]), before);
  for (const secret of ['PRIVATE', 'UNSENT', 'TOKEN', 'AUTH', 'UNCHANGED', 'blocked']) assert.equal(JSON.stringify(batch).includes(secret), false);
  assert.deepEqual(batch.memberIds, ['s']); assert.equal(batch.blocks[0].pending, true);
  assert.equal(batch.blocks[0].entries[0].payload.text, 'Original m');
  assert.equal(Object.hasOwn(batch, 'run'), false);
});
test('a supplied 220-row selection survives this pure contract; already-evicted runtime rows are not recovered', () => {
  const originals = Array.from({ length: 220 }, (_, i) => message(`tool-${i}`, { role: 'tool', kind: 'tool', volatile: true, text: `Exact tool ${i}` }));
  assert.ok(persistedMessages(originals).filter(row => row.kind !== 'gap').length < 220);
  const batch = prepareBatch(capture({ messages: originals }), spec());
  assert.equal(batch.blocks[0].entries.length, 220);
  assert.deepEqual(batch.blocks[0].entries.map(entry => entry.payload.text), originals.map(row => row.text));
});
test('evicting an older unselected cache row does not invalidate unchanged selected originals; relative order still matters', () => {
  const a = room(A, { messages: [message('volatile', { status: 'streaming', volatile: true }), message('one'), message('two')] }), sessions = [session('s')];
  const cuts = [captureSource(a, sessions), captureSource(room(B), sessions)], batch = prepareBatch(cuts, spec());
  a.messages.shift(); assertCurrentSources(batch, [captureSource(a, sessions), cuts[1]]);
  a.messages.reverse(); assert.throws(() => assertCurrentSources(batch, [captureSource(a, sessions), cuts[1]]));
});
test('an unselected member reconnect or rename does not block the chosen snapshot; selected member generations remain guarded', () => {
  const a = room(A), b = room(B), s = session('s'), t = session('t');
  const cuts = [captureSource(a, [s, t]), captureSource(b, [s, t])], batch = prepareBatch(cuts, spec({ memberIds: ['s'] }));
  const renamed = { ...t, name: 'Renamed later', connectionRevision: t.connectionRevision + 1, controlRevision: t.controlRevision + 1 };
  assertCurrentSources(batch, [captureSource(a, [s, renamed]), captureSource(b, [s, renamed])]);
  assert.throws(() => assertCurrentSources(batch, [captureSource(a, [{ ...s, connectionRevision: s.connectionRevision + 1 }, t]), cuts[1]]));
});
test('original addressed/manual-reply/receipt display facts survive while live stream, run and cache controls are omitted', () => {
  const batch = prepareBatch(capture({ messages: [message('directed', { addressed: true, manualReply: true, deliveryTracked: true,
    sourceTag: 'LIVE GRANT', runId: 'LIVE RUN', sharedStream: true, volatile: true })] }), spec());
  const payload = batch.blocks[0].entries[0].payload;
  for (const key of ['addressed', 'manualReply', 'deliveryTracked']) assert.equal(payload[key], true);
  for (const key of ['sourceTag', 'runId', 'sharedStream', 'volatile']) assert.equal(Object.hasOwn(payload, key), false);
});
test('unfinished, unconfirmed and incomplete records remain visibly omitted; finished failures retain their original status/text', () => {
  const rows = ['streaming', 'running', 'awaiting-native', 'unconfirmed', 'complete', 'failed', 'interrupted'].map(status => message(status, { status }));
  rows.push(message('partial', { incomplete: true }), message('gap', { kind: 'gap' }));
  const batch = prepareBatch(capture({ messages: rows }), spec());
  assert.deepEqual(batch.blocks[0].entries.map(entry => entry.payload.status), ['complete', 'failed', 'interrupted']);
  assert.equal(batch.blocks[0].omitted.length, 6);
  assert.equal(batch.blocks[0].entries[1].payload.text, 'Original failed');
});
test('native acceptance is required for tracked human rows, including all per-recipient deliveries', () => {
  const rows = [
    { id: 'accepted', role: 'human', text: 'accepted goal', deliveryTracked: true, deliveries: [{ status: 'submitted' }] },
    { id: 'partial', role: 'human', text: 'partial goal', deliveryTracked: true, deliveries: [{ status: 'submitted' }, { status: 'unconfirmed' }] },
    { id: 'unknown', role: 'human', text: 'not accepted', deliveryTracked: true },
    { id: 'bad', role: 'human', text: 'bad receipts', status: 'submitted', deliveries: {} },
  ];
  const batch = prepareBatch(capture({ messages: rows }), spec());
  assert.deepEqual(batch.blocks[0].entries.map(entry => entry.payload.id), ['accepted']);
  assert.equal(batch.blocks[0].omitted.length, 3);
});
test('same text and same timestamp with different origin IDs or spaces remain separate events with source order/replies', () => {
  const batch = prepareBatch(capture({ messages: [message('same'), message('next', { text: 'Original same', replyTo: 'same' })] }, { messages: [message('same')] }), spec());
  assert.equal(batch.blocks.flatMap(block => block.entries).length, 3);
  assert.deepEqual(batch.blocks[0].entries.map(entry => entry.sourceIndex), [0, 1]);
  assert.deepEqual(batch.blocks[0].entries[0].origin, { roomId: A, messageId: 'same' });
  assert.deepEqual(batch.blocks[1].entries[0].origin, { roomId: B, messageId: 'same' });
  assert.equal(batch.blocks[0].entries[1].payload.replyTo, 'same');
});
test('a selected shared body change invalidates the cut even when both room revisions stay unchanged', () => {
  const a = room(A, { messages: [message('live', { text: 'Original selected body' })] }), s = [session('s')];
  const cuts = [captureSource(a, s), captureSource(room(B), s)], batch = prepareBatch(cuts, spec());
  a.messages[0].text += ' new bytes';
  assert.throws(() => assertCurrentSources(batch, [captureSource(a, s), cuts[1]]), /重新预览/);
  assert.equal(a.revision, 2); assert.equal(a.metadataRevision, 3);
});
test('later output and omitted streaming progress stay in the source without changing or blocking the fixed selected snapshot', () => {
  const a = room(A, { messages: [message('selected'), message('stream', { status: 'streaming', text: 'partial' })] }), s = [session('s')];
  const cuts = [captureSource(a, s), captureSource(room(B), s)], batch = prepareBatch(cuts, spec());
  a.messages[1].text = 'late completion'; a.messages[1].status = 'complete'; a.messages.push(message('new-output'));
  assertCurrentSources(batch, [captureSource(a, s), cuts[1]]);
  assert.deepEqual(batch.blocks[0].entries.map(entry => entry.payload.id), ['selected']);
  assert.equal(batch.blocks[0].omitted[0].status, 'streaming');
});
test('cuts detect changed notes, file refs, completed original text, identity and leave/rejoin generations', () => {
  const s = session('s'), a = room(A, { messages: [message('m')], files: [{ id: randomUUID(), name: 'same.md', path: '/synthetic/original.md' }] }), b = room(B);
  const cuts = [captureSource(a, [s]), captureSource(b, [s])], batch = prepareBatch(cuts, spec());
  for (const mutate of [copy => copy.notes = 'changed', copy => copy.messages[0].text += ' changed',
    copy => copy.files[0].path = '/synthetic/changed.md']) {
    const copy = structuredClone(a); mutate(copy);
    assert.throws(() => assertCurrentSources(batch, [captureSource(copy, [s]), cuts[1]]));
  }
  const rejoined = withMembership(withMembership(s, A, false), A, true);
  assert.throws(() => assertCurrentSources(batch, [captureSource(a, [rejoined]), captureSource(b, [rejoined])]));
  assert.throws(() => assertCurrentSources(batch, [captureSource(a, [{ ...s, nativeId: 'replacement' }]), cuts[1]]));
});
test('snapshots are detached from later source changes and do not synchronize back to source', () => {
  const rows = [message('m', { images: [{ path: '/synthetic/pic.png', fileIdentity: { ino: 7 } }] })];
  const batch = prepareBatch(capture({ messages: rows }), spec());
  rows[0].text = 'new source output'; rows[0].images[0].fileIdentity.ino = 99;
  assert.equal(batch.blocks[0].entries[0].payload.text, 'Original m');
  assert.equal(batch.blocks[0].entries[0].payload.images[0].fileIdentity.ino, 7);
  batch.blocks[0].entries[0].payload.text = 'new C work'; assert.equal(rows[0].text, 'new source output');
});
test('two full-length notes and same-named file references remain separated by source with no reads or overwrite', () => {
  const f = (prefix) => ({ id: randomUUID(), name: 'same.md', path: `/synthetic/${prefix}/same.md` });
  const a = { notes: '甲'.repeat(8000), files: [f('a')] }, b = { notes: '乙'.repeat(8000), files: [f('b')] };
  const batch = prepareBatch(capture(a, b), spec());
  assert.equal(batch.blocks[0].notes, a.notes); assert.equal(batch.blocks[1].notes, b.notes);
  assert.notEqual(batch.blocks[0].files[0].path, batch.blocks[1].files[0].path);
  assert.equal(Object.hasOwn(batch, 'notes'), false);
});
test('same session reference is selected once while distinct same-name sessions remain distinct; native aliases are conflicts', () => {
  const s = session('s'), t = session('t');
  const cuts = capture({}, {}, [s, t]);
  const batch = prepareBatch(cuts, spec({ memberIds: ['s', 't'] }));
  assert.deepEqual(batch.memberIds, ['s', 't']); assert.deepEqual(batch.conflicts, []);
  const alias = prepareBatch(capture({}, {}, [s, { ...t, nativeId: s.nativeId }]), spec({ memberIds: ['s', 't'] }));
  assert.deepEqual(alias.conflicts, [{ kind: 'native-alias', sessionIds: ['s', 't'] }]);
  assert.throws(() => prepareBatch(cuts, spec({ memberIds: ['s', 's'] })));
});
test('operation binding includes source order/cuts, target, selection and archive choice; identical retries are idempotent', () => {
  const cuts = capture(), choice = spec(), batch = prepareBatch(cuts, choice);
  assert.equal(sameOperation(batch, prepareBatch(cuts, choice)), true);
  assert.equal(sameOperation(batch, prepareBatch(cuts, spec())), false);
  for (const change of [{ targetId: randomUUID() }, { memberIds: [] }, { disposition: 'archive' }, { name: 'Different' }]) {
    assert.throws(() => sameOperation(batch, prepareBatch(cuts, { ...choice, ...change })));
  }
  assert.throws(() => sameOperation(batch, prepareBatch([...cuts].reverse(), choice)));
  assertCurrentSources(batch, cuts);
});
test('byte bounds use UTF-8 serialized bytes and refuse instead of silently truncating', () => {
  const cuts = capture({ messages: [message('m', { text: '字'.repeat(100) })] }), choice = spec(), batch = prepareBatch(cuts, choice);
  const { bytes, binding, ...body } = batch;
  assert.equal(bytes, Buffer.byteLength(JSON.stringify(body), 'utf8'));
  assert.ok(bytes > JSON.stringify(body).length);
  assert.doesNotThrow(() => prepareBatch(cuts, choice, bytes));
  assert.throws(() => prepareBatch(cuts, choice, bytes - 1), /没有裁剪/);
});
test('explicit shared selection shrinks the snapshot while preserving original order and refuses unknown or unfinished selections', () => {
  const f = { id: randomUUID(), name: 'reference.md', path: '/synthetic/reference.md' };
  const cuts = capture({ notes: 'Not chosen', files: [f], messages: [message('first'), message('second'), message('unfinished', { status: 'unconfirmed' })],
    events: [{ id: 'event', role: 'system', text: 'Original event' }] });
  const choice = spec({ selections: [{ roomId: A, messageIds: ['second', 'first'], fileIds: [], eventIds: [], includeNotes: false }] });
  const batch = prepareBatch(cuts, choice);
  assert.deepEqual(batch.blocks[0].entries.map(entry => entry.payload.id), ['first', 'second']);
  assert.equal(batch.blocks[0].notes, null); assert.deepEqual(batch.blocks[0].files, []); assert.deepEqual(batch.blocks[0].events, []);
  assertCurrentSources(batch, cuts);
  for (const messageIds of [['missing'], ['unfinished'], ['first', 'first']]) {
    assert.throws(() => prepareBatch(cuts, spec({ selections: [{ roomId: A, messageIds }] })));
  }
  assert.throws(() => prepareBatch(cuts, spec({ selections: [{ roomId: randomUUID() }] })));
});
test('accepted per-recipient receipts retain original facts but never copy transport or grant fields', () => {
  const row = { id: 'accepted', role: 'human', text: 'Original', status: 'submitted', deliveryTracked: true,
    deliveries: [{ id: 'receipt', recipientId: 's', recipientName: 'Same name', text: 'Exact sent text', status: 'submitted', time: 3, grant: 'SECRET GRANT' }] };
  const batch = prepareBatch(capture({ messages: [row] }), spec());
  assert.deepEqual(batch.blocks[0].entries[0].payload.deliveries, [{ id: 'receipt', recipientId: 's', recipientName: 'Same name', text: 'Exact sent text', status: 'submitted', time: 3 }]);
  assert.equal(JSON.stringify(batch).includes('SECRET GRANT'), false);
});
test('tampering with either persisted batch body or byte accounting cannot be acknowledged as an identical retry', () => {
  const batch = prepareBatch(capture(), spec());
  assert.throws(() => sameOperation({ ...batch, name: 'Corrupt old body' }, batch));
  assert.throws(() => sameOperation(batch, { ...batch, bytes: batch.bytes + 1 }));
});
test('merging an existing snapshot with its original source creates one imported message plus a provenance reference', () => {
  const cuts = capture({ messages: [message('m')] }), first = prepareBatch(cuts, spec()), entry = first.blocks[0].entries[0];
  const imported = { ...entry.payload, id: 'display-in-C', snapshotOrigin: entry.origin, snapshotHash: entry.hash };
  const c = captureSource(room(first.targetId, { name: 'C', messages: [imported] }), []);
  const second = prepareBatch([cuts[0], c], spec());
  assert.equal(second.blocks.flatMap(block => block.entries).length, 1);
  assert.equal(second.blocks[1].references.length, 1);
  assert.equal(second.blocks[1].references[0].sourceMessageId, 'display-in-C');
  assert.deepEqual(second.blocks[1].references[0].origin, { roomId: A, messageId: 'm' });
  assertCurrentSources(second, [cuts[0], c]);
  assert.throws(() => captureSource(room(first.targetId, { messages: [{ ...imported, text: 'changed' }] }), []));
});
test('same origin with two different confirmed bodies is an integrity conflict even when display IDs differ', () => {
  const one = prepareBatch(capture({ messages: [message('m')] }), spec()).blocks[0].entries[0];
  const two = prepareBatch(capture({ messages: [message('m', { text: 'different body' })] }), spec()).blocks[0].entries[0];
  const imported = entry => ({ ...entry.payload, id: `display-${entry.hash.slice(0, 8)}`, snapshotOrigin: entry.origin, snapshotHash: entry.hash });
  const c = captureSource(room(randomUUID(), { messages: [imported(one)] }), [session('s')]);
  const d = captureSource(room(randomUUID(), { messages: [imported(two)] }), [session('s')]);
  assert.throws(() => prepareBatch([c, d], spec({ memberIds: [] })), /同一来源条目的内容不一致/);
});
test('malformed or stale sources fail closed instead of replacing or retargeting a source', () => {
  const cuts = capture();
  assert.throws(() => prepareBatch([cuts[0], cuts[0]], spec()));
  assert.throws(() => prepareBatch(cuts, spec({ targetId: A })));
  assert.throws(() => captureSource(room(A, { messages: [message('dup'), message('dup')] }), [session('s')]));
  assert.throws(() => captureSource(room(A, { unavailable: true }), []));
  assert.throws(() => prepareBatch([{ ...cuts[0], notes: 'tampered' }, cuts[1]], spec()));
  assert.throws(() => prepareBatch([captureSource(room(A, { archived: true }), [session('s')]), cuts[1]], spec()));
});
test('materialized rows preserve original bytes/provenance and use separate reply display links without rewriting source payloads', () => {
  const batch = prepareBatch(capture({ messages: [message('parent'), message('child', { replyTo: 'parent' })] }), spec());
  const rows = materializeBatch(batch); assert.equal(rows[1].replyTo, 'parent'); assert.equal(rows[1].snapshotReplyTo, rows[0].id);
  assert.deepEqual(rows.map(row => row.snapshotOrder), [0, 1]);
  assert.equal(rows[0].snapshotOrigin.roomId, A); assert.equal(rows[0].text, 'Original parent');
  assert.doesNotThrow(() => captureSource(room(batch.targetId, { messages: rows }), []));
  assert.deepEqual(materializeBatch(structuredClone(batch)), rows, 'Repeated materialization is deterministic');
  assert.equal(validateBatch(batch), batch);
});
test('a peer-only human row with confirmed receipts is retained, while a merely complete label without receipt is omitted', () => {
  const a = { messages: [{ id: 'peer', role: 'human', text: 'Original peer goal', status: 'complete', deliveryTracked: true,
    deliveries: [{ id: 'receipt', recipientId: 's', status: 'submitted' }] },
  { id: 'unknown-peer', role: 'human', text: 'Unconfirmed goal', status: 'complete', deliveryTracked: true }] };
  const batch = prepareBatch(capture(a), spec());
  assert.deepEqual(batch.blocks[0].entries.map(entry => entry.payload.id), ['peer']); assert.equal(batch.blocks[0].omitted.length, 1);
  assert.doesNotThrow(() => materializeBatch(batch));
});
