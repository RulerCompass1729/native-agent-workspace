const test = require('node:test'), assert = require('node:assert/strict');
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
// Bound: each directed pair receives at most 3 automatic messages between person checks of
// its recipient (3 is the person's "3 in a row"; it is written here, not read from the
// module, so raising the constant fails this test). A schedule over k pairs then delivers at
// most 3k messages and refuses every attempt after that; with n agents, at most 3·n·(n−1),
// whoever they choose to message. Counting per recipient only (the old rule) also meets this
// bound; counting only an unbroken run from one sender does not, because any other sender in
// between restarts it.
//
// The budget's edge key is the authenticated sender native id. A changed workspace sender id
// therefore stays on the same edge, and workspace_message and outbox share it.
const PER_PAIR = 3;
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
  const results = [sender('A-one'), sender('A-two'), sender('A-three'), sender('A-four')]
    .map((from, i) => { tick(); return attempt(sessions, from, 'B', `changed-${i}`); });
  assert.deepEqual(results, [true, true, true, false]);
});

test('an empty sender id fails closed and reserves no edge budget', t => {
  const sessions = { B: { wakeHumanRevision: 0 } };
  assert.equal(wake.budgetAllows(sessions.B, 'empty', '', 'native-A'), false);
  assert.equal(wake.reserveBudget(sessions.B, 'empty', '', 'native-A'), null);
  assert.equal(sessions.B.wakeBudget, undefined);
});

// 2026-11-23 (the person approved the butler's recommendation): a member's message the designated butler took clears
// the butler's run to that member. The member's own run to the butler is cleared only by the person, so the pair stays
// finite: at most 3 from the member, and at most 3 before and 3 after each of those from the butler.
for (const [name, pattern] of [
  ['the butler and a member answer each other', [['B', 'M'], ['M', 'B']]],
  ['the butler sends three, the member answers once', [['B', 'M'], ['B', 'M'], ['B', 'M'], ['M', 'B']]],
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
