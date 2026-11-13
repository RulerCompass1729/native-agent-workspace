const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Workspace } = require('../workspace.cjs');

// A timed checkpoint (storeSnapshot with reuse) keeps each session's saved messages as JSON and serialises them again
// only after a change that may have touched them: changed(id) for that session, changed() naming none for all of them.
// Whatever it reuses, its bytes must equal those of a full save taken at the same moment.
async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-snapshot-reuse-')), runtimes = [];
  const host = { binaries: {}, close() {}, create() { const runtime = new EventEmitter(); runtime.start = async () => runtime.emit('state', 'idle'); runtime.send = async () => {}; runtime.finishTurn = () => {}; runtimes.push(runtime); return runtime; } };
  const w = new Workspace(host, directory);
  t.after(() => { w.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const ids = [await w.create('claude', directory, 'owner', 'Claude'), await w.create('codex', directory, 'owner', 'Codex')];
  // The second stands for an old Codex session that shares a backend with the one being worked in.
  for (let i = 0; i < 40; i++) w.get(ids[1]).messages.push({ id: `old-${i}`, role: i % 2 ? 'assistant' : 'user', text: `old row ${i}`, time: 1000 + i, status: 'complete' });
  w.changed();
  // A full save now, without touching what the timed checkpoints keep.
  const full = () => { const kept = w.savedJson, at = w.savedAllAt; w.savedJson = new WeakMap(); try { return w.storeSnapshot().workspace; } finally { w.savedJson = kept; w.savedAllAt = at; } };
  const timed = () => w.storeSnapshot(undefined, true).workspace;
  const kept = id => w.savedJson.get(w.get(id));
  const messagesOf = id => JSON.stringify(w.get(id).messages);
  return { w, directory, ids, claude: runtimes[0], codex: runtimes[1], full, timed, kept, messagesOf };
}

test('each change that touches a session\'s messages has the next timed checkpoint serialise them again, and only them', async t => {
  const f = await fixture(t), { w, claude, codex, ids: [a, b] } = f;
  const named = [
    [a, 'a native block', () => claude.emit('nativeBlock', { nativeId: w.get(a).nativeId, id: 'display:reply', kind: 'response', turnId: 'turn', text: 'part', status: 'streaming' })],
    [a, 'a native tool row', () => claude.emit('nativeBlock', { nativeId: w.get(a).nativeId, id: 'tool:read', kind: 'tool', turnId: 'turn', title: 'Read', text: 'file', status: 'running' })],
    [a, 'Claude progress', () => claude.emit('progress', { id: 'read', source: 'claude-native-message', kind: 'tool', status: 'running', title: 'Read' })],
    [b, 'a Codex delta', () => codex.emit('delta', { id: 'answer', text: 'stre' })],
    [b, 'a Codex message', () => codex.emit('messageItem', { id: 'answer', text: 'streamed' })],
    [b, 'Codex progress', () => codex.emit('progress', { id: 'command', kind: 'commandExecution', status: 'inProgress', source: 'codex-native', turnId: 'turn-1', input: 'ls' })],
    [b, 'an edit reported by name', () => { w.get(b).messages[3].text = 'edited in place'; w.changed(b); }],
  ];
  for (const [id, label, action] of named) {
    f.timed();
    const other = id === a ? b : a, before = f.messagesOf(id), keptBefore = [f.kept(id), f.kept(other)];
    action();
    assert.notEqual(f.messagesOf(id), before, `${label}: the session's messages changed`);
    const out = f.timed();
    assert.notEqual(f.kept(id), keptBefore[0], `${label}: serialised again`);
    assert.equal(f.kept(other), keptBefore[1], `${label}: the other session's kept JSON is used again`);
    assert.equal(out, f.full(), label);
  }
  const unnamed = [
    ['a gap', () => claude.emit('nativeBlock', { nativeId: w.get(a).nativeId, id: 'gap-1', kind: 'gap' })],
    ['an edit reported without a name', () => { w.get(b).messages[5].text = 'edited, no name'; w.changed(); }],
    ['a draft', () => w.setDraft(a, 'typed')],
    ['a turn end', () => claude.emit('state', 'idle')],
  ];
  for (const [label, action] of unnamed) {
    f.timed();
    const keptBefore = [f.kept(a), f.kept(b)];
    action();
    const out = f.timed();
    assert.ok(f.kept(a) !== keptBefore[0] && f.kept(b) !== keptBefore[1], `${label}: every session serialised again`);
    assert.equal(out, f.full(), label);
  }
});

// They name their own session, which is then serialised again although its rows did not change; every other
// session's kept JSON stays in use, as an old Codex session's while a Claude session works beside it.
test('a tool call\'s activity and state, and usage, leave every other session\'s kept messages in use', async t => {
  const f = await fixture(t), { claude, codex, ids: [a, b] } = f;
  for (const [id, other, label, action] of [[a, b, 'activity', () => claude.emit('activity', 'Read')], [a, b, 'state working', () => claude.emit('state', 'working')],
    [a, b, 'Claude usage', () => claude.emit('usage', { total: 2 })], [b, a, 'Codex usage', () => codex.emit('usage', { total: 1 })]]) {
    f.timed();
    const keptBefore = f.kept(other), before = [f.messagesOf(a), f.messagesOf(b)];
    action();
    assert.deepEqual([f.messagesOf(a), f.messagesOf(b)], before, `${label} changes no messages`);
    const out = f.timed();
    assert.equal(f.kept(other), keptBefore, `${label}: the other session's kept JSON used again`);
    assert.equal(out, f.full(), label);
  }
});

// The person's pause of all handoffs, or their own action in one session, cancels that session's waiting wake rows
// without reporting the session by name; a streamed reply in another session must not leave them as kept.
test('wake rows cancelled by the person are saved cancelled by the next timed checkpoint', async t => {
  const f = await fixture(t), { w, claude, ids: [a, b] } = f;
  const stage = body => { const row = { id: `wake-${body}`, role: 'system', kind: 'notice', text: body, status: 'complete', time: 2000, wake: { status: 'staged', body } }; w.get(b).messages.push(row); w.changed(); return row; };
  for (const [label, cancel] of [['pause all', () => w.pauseAll('stop')], ['the person in that session', () => w.pauseParticipant(b, 'typed')]]) {
    const row = stage(label);
    f.timed();
    const keptBefore = f.kept(b);
    cancel();
    assert.equal(row.wake.status, 'cancelled', label);
    claude.emit('nativeBlock', { nativeId: w.get(a).nativeId, id: `display:${label}`, kind: 'response', turnId: 'turn', text: 'part', status: 'streaming' });
    const out = f.timed();
    assert.notEqual(f.kept(b), keptBefore, `${label}: serialised again`);
    assert.equal(out, f.full(), label);
  }
});

// An image event for a prompt row records the row's native session before its payload is checked; a payload refused
// reports no change, and the row's new field must still reach the next timed checkpoint.
test('a refused prompt image still has its row saved with the native session it set', async t => {
  const f = await fixture(t), { w, claude, codex, ids: [a] } = f, { promptTextTag } = require('../adapters.cjs');
  const promptId = '0f8fad5b-d9cb-469f-a165-70867728950e', text = 'look at this picture';
  w.get(a).messages.push({ id: `claude-prompt-${promptId}`, role: 'user', origin: 'native', text, status: 'complete', time: 3000 }); w.changed();
  f.timed();
  const keptBefore = f.kept(a);
  claude.emit('nativePromptImage', { promptId, tag: promptTextTag(text), nativeId: w.get(a).nativeId, imagePayload: { refused: true } });
  assert.equal(w.get(a).messages.at(-1).nativeId, w.get(a).nativeId, 'the row records its native session');
  assert.equal(w.get(a).messages.at(-1).images, undefined, 'the payload was refused');
  codex.emit('delta', { id: 'answer', text: 'stre' });
  const out = f.timed();
  assert.notEqual(f.kept(a), keptBefore, 'serialised again');
  assert.equal(out, f.full());
});

test('random changes through every path: each timed checkpoint equals a full save, byte for byte', async t => {
  const f = await fixture(t), { w, claude, codex, ids: [a, b] } = f;
  let seed = Number(process.env.NAW_REUSE_SEED) || Date.now() % 2147483647;
  const start = seed, random = () => (seed = seed * 48271 % 2147483647) / 2147483647;
  const pick = list => list[Math.floor(random() * list.length)], word = () => Math.floor(random() * 1e9).toString(36).slice(0, 1 + Math.floor(random() * 6));
  const rowOf = id => { const rows = w.get(id).messages; return rows.length ? pick(rows) : null; };
  let n = 0;
  const actions = [
    () => claude.emit('nativeBlock', { nativeId: w.get(a).nativeId, id: `display:r${Math.floor(random() * 4)}`, kind: 'response', turnId: 'turn', text: word(), status: pick(['streaming', 'complete']) }),
    () => claude.emit('nativeBlock', { nativeId: w.get(a).nativeId, id: `tool:t${Math.floor(random() * 6)}`, kind: 'tool', turnId: 'turn', title: 'Read', text: word(), status: pick(['running', 'complete']) }),
    () => claude.emit('progress', { id: `p${Math.floor(random() * 3)}`, source: 'claude-native-message', kind: 'tool', status: pick(['running', 'completed']), title: word() }),
    () => codex.emit('delta', { id: `answer${Math.floor(random() * 3)}`, text: word() }),
    () => codex.emit('messageItem', { id: `answer${Math.floor(random() * 3)}`, text: word() }),
    () => codex.emit('progress', { id: `c${Math.floor(random() * 3)}`, kind: 'commandExecution', status: pick(['inProgress', 'completed']), source: 'codex-native', turnId: 'turn-1', input: word() }),
    () => claude.emit('activity', word()), () => claude.emit('state', 'working'), () => claude.emit('usage', { total: n++ }), () => codex.emit('usage', { total: n++ }),
    () => w.setDraft(pick([a, b]), word()),
    // Rows changed in place, added, removed, reordered or replaced, then reported by name or without one.
    ...[id => w.changed(id), () => w.changed()].flatMap(report => [
      () => { const id = pick([a, b]), row = rowOf(id); if (row) row.text = word(); report(id); },
      () => { const id = pick([a, b]), row = rowOf(id); if (row) { if ('extra' in row) delete row.extra; else row.extra = random() < 0.5 ? word() : undefined; } report(id); },
      () => { const id = pick([a, b]), row = rowOf(id); if (row) { row.uiMessage ||= { version: 1, key: 'notice.x', params: {} }; row.uiMessage.params.value = word(); } report(id); },
      () => { const id = pick([a, b]); w.get(id).messages.push({ id: `new-${n++}`, role: 'user', text: word(), time: n }); report(id); },
      () => { const id = pick([a, b]), rows = w.get(id).messages; rows.splice(Math.floor(random() * rows.length), 1); report(id); },
      () => { const id = pick([a, b]), rows = w.get(id).messages; if (rows.length > 1) rows.push(rows.shift()); report(id); },
      () => { const id = pick([a, b]); w.get(id).messages = w.get(id).messages.map(row => ({ ...row })); report(id); },
    ]),
    // Fields outside the messages are serialised every time, whatever reported them.
    () => { w.get(pick([a, b])).name = word(); },
  ];
  for (let i = 0; i < 600; i++) {
    pick(actions)();
    if (random() < 0.5) assert.equal(f.timed(), f.full(), `seed ${start}, step ${i}`);
  }
  assert.equal(f.timed(), f.full(), `seed ${start}, end`);
});

test('a real timed checkpoint uses the kept JSON of a session no change touched', async t => {
  const f = await fixture(t), { w, claude, directory, ids: [, b] } = f;
  w.persist();
  const keptBefore = f.kept(b);
  claude.emit('activity', 'Read'); claude.emit('state', 'working');
  w.persistLater();
  for (let i = 0; i < 400 && w.saveWriting; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(w.saveWriting, false);
  assert.equal(f.kept(b), keptBefore);
  assert.equal(fs.readFileSync(path.join(directory, 'workspace.json'), 'utf8'), f.full());
});

test('a replacement record is saved with its own rows and leaves the kept JSON of the record alone', async t => {
  const f = await fixture(t), { w, ids: [a] } = f;
  f.timed();
  const keptBefore = f.kept(a), next = { ...w.get(a), messages: [{ id: 'replacement', role: 'user', text: 'the replacement\'s row', time: 1 }] };
  const saved = JSON.parse(w.storeSnapshot({ id: a, next }).workspace).sessions.find(s => s.id === a);
  assert.deepEqual(saved.messages.map(m => m.id), ['replacement']);
  assert.equal(f.kept(a), keptBefore);
  assert.equal(f.timed(), f.full());
});

test('persist() and a checkpoint 30 s after the last full one serialise every session again', async t => {
  const f = await fixture(t), { w, ids: [a, b] } = f;
  f.timed();
  let keptBefore = [f.kept(a), f.kept(b)];
  w.persist();
  assert.ok(f.kept(a) !== keptBefore[0] && f.kept(b) !== keptBefore[1], 'persist() serialises everything');
  keptBefore = [f.kept(a), f.kept(b)];
  f.timed();
  assert.ok(f.kept(a) === keptBefore[0] && f.kept(b) === keptBefore[1], 'a checkpoint right after uses it again');
  let clock = Date.now() + 30 * 1000 + 1;
  t.mock.method(Date, 'now', () => clock);
  f.timed();
  assert.ok(f.kept(a) !== keptBefore[0] && f.kept(b) !== keptBefore[1], 'after 30 s everything again');
  // A persist() is a full save too: the 30 s count starts again from it.
  clock += 20 * 1000; w.persist(); keptBefore = [f.kept(a), f.kept(b)];
  clock += 11 * 1000; f.timed();
  assert.ok(f.kept(a) === keptBefore[0] && f.kept(b) === keptBefore[1], '31 s after the timed full save, 11 s after persist(): used again');
});

test('a session whose messages array was replaced is serialised again even before the change is reported', async t => {
  const f = await fixture(t), { w, ids: [, b] } = f;
  f.timed();
  w.get(b).messages = [...w.get(b).messages, { id: 'unreported', role: 'user', text: 'not yet reported', time: 1 }];
  assert.equal(f.timed(), f.full());
  assert.match(f.timed(), /not yet reported/);
});

test('a record or draft that holds the placeholder is saved whole and right', async t => {
  const f = await fixture(t), { w, ids: [a] } = f;
  let mark; const stringify = JSON.stringify;
  JSON.stringify = function (value, ...rest) { if (typeof value?.messages === 'string' && value.messages.startsWith('\u0000naw-saved-')) mark ??= value.messages; return stringify.call(this, value, ...rest); };
  try { f.timed(); } finally { JSON.stringify = stringify; }
  assert.ok(mark, 'the placeholder was seen');
  w.get(a).name = mark;
  assert.equal(f.timed(), f.full());
  assert.equal(JSON.parse(f.timed()).sessions[0].name, mark);
  w.get(a).name = 'Claude'; w.setDraft(a, mark);
  assert.equal(f.timed(), f.full());
  assert.equal(JSON.parse(f.timed()).drafts[a], mark);
});

test('after timed checkpoints the file on disk is a full save of memory, and a restart reads the same rows back', async t => {
  const f = await fixture(t), { w, claude, codex, directory, ids: [a, b] } = f;
  const settled = async () => { for (let i = 0; i < 400 && (w.saveWriting || w.saveTimer || w.saveDeadline); i++) await new Promise(r => setTimeout(r, 10)); assert.equal(w.saveWriting, false); };
  claude.emit('nativeBlock', { nativeId: w.get(a).nativeId, id: 'display:reply', kind: 'response', turnId: 'turn', text: 'a full reply', status: 'complete' });
  claude.emit('activity', 'Read');
  w.persistLater(); await settled();
  // The last checkpoint touches only b, so a's rows reach the file from the JSON kept by the first one.
  const keptA = f.kept(a);
  codex.emit('messageItem', { id: 'answer', text: 'a Codex answer' });
  w.get(b).messages[2].text = 'edited and reported'; w.changed(b);
  w.persistLater(); await settled();
  assert.equal(f.kept(a), keptA, 'a was not serialised again');
  const disk = fs.readFileSync(path.join(directory, 'workspace.json'), 'utf8');
  assert.equal(disk, f.full());
  // A restart that never saw close(): a fresh Workspace reading a copy of that file.
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-snapshot-reuse-crash-'));
  t.after(() => fs.rmSync(copy, { recursive: true, force: true }));
  fs.copyFileSync(path.join(directory, 'workspace.json'), path.join(copy, 'workspace.json'));
  const cold = new Workspace({ binaries: {}, close() {}, create() { const r = new EventEmitter(); r.start = async () => {}; return r; } }, copy);
  t.after(() => cold.close());
  const rows = id => JSON.parse(disk).sessions.find(s => s.id === id).messages.map(m => [m.id, m.text]);
  for (const id of [a, b]) assert.deepEqual(cold.get(id).messages.map(m => [m.id, m.text]), rows(id));
  assert.ok(rows(b).some(([, text]) => text === 'edited and reported') && rows(b).some(([, text]) => text === 'a Codex answer'));
  assert.ok(rows(a).some(([, text]) => text === 'a full reply'));
});
