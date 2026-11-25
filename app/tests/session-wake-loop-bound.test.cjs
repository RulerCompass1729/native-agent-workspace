const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const wake = require('../session-wake.cjs');

// Gate for the automatic-message cap (2026-11-15). The cap exists to stop agents from
// waking each other without end; the person said the limit itself stays. Changing how it
// counts must keep every loop finite, and must not block ordinary handoffs from several
// agents to one session.
//
// Model: each step is one automatic delivery attempt sender -> recipient, 61 seconds apart,
// so the 60-second cooldown never decides, and nobody types into any session. A refused
// attempt is not delivered; the schedule keeps going, because an agent woken by other work
// (a queue item) can still try again.
//
// Bound: each directed pair receives at most 8 automatic messages between person checks of
// its recipient (8 is the person's "每件最多 8 条", 2026-11-25; it is written here, not read from the
// module, so raising the constant fails this test). A schedule over k pairs then delivers at
// most 8k messages and refuses every attempt after that; with n agents, at most 8·n·(n−1),
// whoever they choose to message. Counting per recipient only (the old rule) also meets this
// bound; counting only an unbroken run from one sender does not, because any other sender in
// between restarts it.
//
// The budget's edge key is the authenticated sender native id. A changed workspace sender id
// therefore stays on the same edge, and workspace_message and outbox share it.
const PER_PAIR = 8;
const OUTBOX = { id: 'outbox', key: 'A' };

function clock(t) {
  const real = Date.now; let now = 1e6;
  Date.now = () => now; t.after(() => { Date.now = real; });
  return () => { now += 61000; };
}
function attempt(sessions, from, to, id) {
  const s = sessions[to] ??= { wakeHumanRevision: 0 };
  const senderId = typeof from === 'string' ? from : from.id;
  const senderKey = typeof from === 'string' ? from : from.key;
  const allowed = wake.budgetAllows(s, id, senderId, senderKey);
  if (allowed) wake.reserveBudget(s, id, senderId, senderKey);
  return allowed;
}
const edge = from => `${typeof from === 'string' ? from : from.key}->`;

const LOOPS = [
  ['A and B message each other', [['A', 'B'], ['B', 'A']]],
  ['a three-agent ring A->B->C->A', [['A', 'B'], ['B', 'C'], ['C', 'A']]],
  ['A and B take turns waking C, and C answers each', [['A', 'C'], ['C', 'A'], ['B', 'C'], ['C', 'B']]],
  ['three agents each alternate whom they message', [['A', 'B'], ['B', 'C'], ['C', 'A'], ['A', 'C'], ['C', 'B'], ['B', 'A']]],
  ['A and B message each other, A alternating workspace_message and the outbox', [['A', 'B'], ['B', 'A'], [OUTBOX, 'B'], ['B', 'A']]],
];

for (const [name, pattern] of LOOPS) {
  test(`with no person input, the loop stops: ${name}`, t => {
    const tick = clock(t), sessions = {}, delivered = new Map();
    const pairs = new Set(pattern.map(([from, to]) => `${edge(from)}${to}`));
    // Enough rounds for a bounded schedule to reach a round in which everything is refused.
    const rounds = PER_PAIR * pairs.size + 2;
    let step = 0, firstRefusal = null, lastRound = [];
    for (let round = 0; round < rounds; round++) {
      lastRound = [];
      for (const [from, to] of pattern) {
        tick(); step++;
        const ok = attempt(sessions, from, to, `m${step}`), key = `${edge(from)}${to}`;
        if (ok) delivered.set(key, (delivered.get(key) || 0) + 1);
        else firstRefusal ??= step;
        lastRound.push(ok);
      }
    }
    const total = [...delivered.values()].reduce((a, b) => a + b, 0);
    t.diagnostic(`pairs ${pairs.size}, delivered ${total} of ${step} attempts, first refusal at ${firstRefusal ?? 'none'}, ` +
      [...pairs].map(key => `${key} ${delivered.get(key) || 0}`).join(', '));
    for (const key of pairs) {
      assert.ok((delivered.get(key) || 0) <= PER_PAIR, `${key} delivered ${delivered.get(key)} automatic messages without a person check; at most ${PER_PAIR}`);
    }
    assert.ok(total <= PER_PAIR * pairs.size, `${total} deliveries over ${pairs.size} pairs; at most ${PER_PAIR * pairs.size}`);
    assert.deepEqual(lastRound, pattern.map(() => false), 'after the bound, every further attempt is refused');
  });
}

test('three different agents each report once to one session, and the first reports again: all are delivered', t => {
  // The 2026-11-15 case: three agents each sent one report to a reviewer session hours
  // apart, then the first one's next message was refused for three hours.
  const tick = clock(t), sessions = {};
  const results = [['E', 'C'], ['claude7', 'C'], ['B', 'C'], ['E', 'C']].map(([from, to], i) => { tick(); return attempt(sessions, from, to, `r${i}`); });
  assert.deepEqual(results, [true, true, true, true]);
});

test('a changed workspace sender id stays on the same native-session edge', t => {
  const tick = clock(t), sessions = {};
  const sender = id => ({ id, key: 'native-A' });
  const results = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'].map(name => sender(`A-${name}`))
    .map((from, i) => { tick(); return attempt(sessions, from, 'B', `changed-${i}`); });
  assert.deepEqual(results, [...Array(PER_PAIR).fill(true), false]);
});

test('an empty sender id fails closed and reserves no edge budget', t => {
  const sessions = { B: { wakeHumanRevision: 0 } };
  assert.equal(wake.budgetAllows(sessions.B, 'empty', '', 'native-A'), false);
  assert.equal(wake.reserveBudget(sessions.B, 'empty', '', 'native-A'), null);
  assert.equal(sessions.B.wakeBudget, undefined);
});

// 2026-11-23 (the person approved the butler's recommendation): a member's message the designated butler took clears
// the butler's run to that member. The member's own run to the butler is cleared only by the person, so the pair stays
// finite: at most 8 from the member, and at most 8 before and 8 after each of those from the butler.
for (const [name, pattern] of [
  ['the butler and a member answer each other', [['B', 'M'], ['M', 'B']]],
  ['the butler sends eight, the member answers once', [...Array(8).fill(['B', 'M']), ['M', 'B']]],
]) {
  test(`with no person input, the loop stops: ${name}`, t => {
    const tick = clock(t), sessions = {}, delivered = { 'B->M': 0, 'M->B': 0 };
    let step = 0, lastRound = [];
    for (let round = 0; round < 3 * PER_PAIR * pattern.length; round++) {
      lastRound = [];
      for (const [from, to] of pattern) {
        tick(); step++;
        const ok = attempt(sessions, from, to, `b${step}`);
        if (ok) delivered[`${from}->${to}`]++;
        if (ok && from === 'M') wake.clearSenderStreak(sessions.M ??= { wakeHumanRevision: 0 }, 'B');
        lastRound.push(ok);
      }
    }
    t.diagnostic(`B->M ${delivered['B->M']}, M->B ${delivered['M->B']} of ${step} attempts`);
    assert.ok(delivered['M->B'] <= PER_PAIR);
    assert.ok(delivered['B->M'] <= PER_PAIR * (PER_PAIR + 1));
    assert.deepEqual(lastRound, pattern.map(() => false), 'after the bound, every further attempt is refused');
  });
}

// R232 (2026-11-25): an item the butler queued for a member, once NAW records it as done, clears the butler's run to
// that member, once an item, and no other run. k items allow the butler at most 8×(k+1) messages to it, whenever they are
// done; with the member's own messages to it, at most 8, also clearing the run, at most 8×(k+1+8).
function items(t, sessions) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-bound-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'steward.json'), JSON.stringify({ version: 1, selected: { sessionId: 'B', nativeId: 'B' } }), { mode: 0o600 });
  return member => {
    for (const [id, s] of Object.entries(sessions)) s.nativeId = id;
    wake.queueDone({ dataDir: directory, sessions: new Map(Object.entries(sessions)), changed() {}, persist() {} }, { sessionId: member, nativeId: member });
  };
}
for (const [name, at] of [
  ['no item is done', []],
  ['one item is done before the butler writes', [0]],
  ['one item is done after the limit', [30]],
  ['four items are done far apart', [5, 20, 40, 60]],
  ['three items are done at the same moment', [12, 12, 12]],
  ['an item is done after every message, until there are none', [1, 2, 3, 4, 5, 6]],
]) {
  test(`with no person input, the butler's messages to a member stop: ${name}`, t => {
    const tick = clock(t), sessions = { M: { wakeHumanRevision: 0 } }, itemDone = items(t, sessions), k = at.length, delivered = { B: 0, A: 0 }, last = [];
    for (let step = 0; step < 140; step++) {
      for (const done of at) if (done === step) itemDone('M');
      for (const from of ['B', 'A']) { tick(); const ok = attempt(sessions, from, 'M', `k${from}${step}`); if (ok) delivered[from]++; last.push(ok); }
    }
    t.diagnostic(`items ${k}, B->M ${delivered.B}, A->M ${delivered.A} of 140 attempts each`);
    assert.ok(delivered.B <= PER_PAIR * (k + 1), `${delivered.B} delivered for ${k} items; at most ${PER_PAIR * (k + 1)}`);
    assert.equal(delivered.A, PER_PAIR, 'another sender to the same member stays at eight, whatever is done');
    assert.deepEqual(last.slice(-20), Array(20).fill(false), 'after the last item, every further attempt is refused');
  });
}
test('with no person input, the butler and a member that also answers stop: items done and replies together', t => {
  const tick = clock(t), sessions = { M: { wakeHumanRevision: 0 }, B: { wakeHumanRevision: 0 } }, itemDone = items(t, sessions), done = [4, 60, 150], k = done.length;
  const delivered = { 'B->M': 0, 'M->B': 0 }, last = [];
  for (let step = 0; step < 400; step++) {
    if (done.includes(step)) itemDone('M');
    tick(); const out = attempt(sessions, 'B', 'M', `c${step}`);
    tick(); const back = step % 9 === 8 && attempt(sessions, 'M', 'B', `r${step}`);
    if (out) delivered['B->M']++;
    if (back) { delivered['M->B']++; wake.clearSenderStreak(sessions.M, 'B'); }
    last.push(out, back);
  }
  t.diagnostic(`items ${k}, B->M ${delivered['B->M']}, M->B ${delivered['M->B']}`);
  assert.equal(delivered['M->B'], PER_PAIR, 'an item done gives the member no more messages to the butler');
  assert.ok(delivered['B->M'] <= PER_PAIR * (k + 1 + PER_PAIR), `${delivered['B->M']} delivered; at most ${PER_PAIR * (k + 1 + PER_PAIR)}`);
  assert.deepEqual(last.slice(-40), Array(40).fill(false), 'after the last item and the last reply, every further attempt is refused');
});
test('items done by a member restart no other direction: each stays at eight', t => {
  const tick = clock(t), sessions = { M: { wakeHumanRevision: 0 }, A: { wakeHumanRevision: 0 }, B: { wakeHumanRevision: 0 } }, itemDone = items(t, sessions);
  const other = [['M', 'B'], ['A', 'M'], ['M', 'A'], ['A', 'B'], ['B', 'A']], delivered = new Map();
  for (let step = 0; step < 60; step++) {
    for (const [from, to] of other) { tick(); if (attempt(sessions, from, to, `o${from}${to}${step}`)) delivered.set(`${from}->${to}`, (delivered.get(`${from}->${to}`) || 0) + 1); }
    itemDone('M');
  }
  assert.deepEqual([...delivered], other.map(([from, to]) => [`${from}->${to}`, PER_PAIR]));
});
test('a message on its way when the run is cleared stays allowed, and the next ones count from it', t => {
  const tick = clock(t), M = { wakeHumanRevision: 0 }, ids = n => Array.from({ length: n }, (_, i) => `m${i + 1}`);
  for (const id of ids(8)) { tick(); assert.equal(wake.budgetAllows(M, id, 'B'), true); wake.reserveBudget(M, id, 'B'); }
  wake.clearSenderStreak(M, 'B');
  assert.equal(wake.budgetAllows(M, 'm8', 'B'), true, 'the one under way');
  assert.equal(wake.budgetAllows(M, 'm9', 'B'), false, 'within the minute');
  const next = ids(9).map(id => { tick(); const ok = wake.budgetAllows(M, `n-${id}`, 'B'); if (ok) wake.reserveBudget(M, `n-${id}`, 'B'); return ok; });
  assert.deepEqual(next, [...Array(8).fill(true), false]);
});
