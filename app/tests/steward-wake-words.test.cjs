// The butler's wake names how NAW last ended (3fa05f69 ③, PM brief 2026-11-25): a start recorded since the last wake puts
// its own reason code in the message. Real exit marks, version events, event record and wake; nothing is crashed.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { ButlerLedger } = require('../butler-ledger.cjs');
const { RunMark, VersionEvents } = require('../version-events.cjs');
const { StewardWake, GAP_MS, wakeText } = require('../steward-wake.cjs');

const BUTLER = { sessionId: 'butler', nativeId: 'native-butler' };
const V1 = '0.1.0-alpha.300', V2 = '0.1.0-alpha.301';
const failure = (n, reason = `Synthetic failure reason ${n}`) => ({ eventId: `butler-source:${n}`, sourceRef: `queue-outcome:space-1:${n}`, kind: 'failure',
  payload: { spaceId: 'space-1', itemId: `item-${n}`, reason } });

// One profile. A first start on V1 is recorded, the wake is turned on after it, and `start` is a later one.
function profile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-wake-words-')); fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const clock = { now: 1_800_000_000_000 }, now = () => clock.now, sends = [];
  const ledger = new ButlerLedger(dir, { now });
  const env = { dir, clock, ledger, sends, failSend: null };
  env.start = version => {
    clock.now += GAP_MS;
    const run = new RunMark(dir, { version, now });
    const events = new VersionEvents(dir, { version, now, run, record: e => ledger.ingest(e), owe: () => {} });
    events.observe([], () => null);
    return { run, events };
  };
  env.first = env.start(V1);
  env.wake = new StewardWake(dir, { ledger: () => env.ledger, selected: () => BUTLER, record: () => {}, now });
  env.wake.set(true);
  env.send = async text => { if (env.failSend) throw env.failSend; sends.push(text); return `tag-${sends.length}`; };
  env.fire = async () => { clock.now += GAP_MS; return env.wake.wake({ id: 'butler', nativeId: 'native-butler' }, 'claude-test-model', env.send); };
  return env;
}
const codes = text => /原因含 ([a-z0-9、-]+)。$/u.exec(text)?.[1].split('、') ?? [];

test('the last run ended abnormally: the wake carries the reason code', async t => {
  const env = profile(t), before = env.ledger.latest();
  env.start(V1);
  assert.equal((await env.fire()).state, 'sent');
  assert.deepEqual(codes(env.sends[0]), ['version-restarted-after-abnormal-exit']);
  assert.equal(env.sends[0], `${wakeText(before)}原因含 version-restarted-after-abnormal-exit。`, 'the position and how to read it stay as they were');
});

test('the last run ended normally: the wake says a restart, not an abnormal one', async t => {
  const env = profile(t);
  env.first.run.exitClean(); env.start(V1);
  await env.fire();
  assert.deepEqual(codes(env.sends[0]), ['version-restarted']);
});

test('a new version was installed: the wake says so, after a normal and after an abnormal exit', async t => {
  const clean = profile(t);
  clean.first.run.exitClean(); clean.start(V2);
  await clean.fire();
  assert.deepEqual(codes(clean.sends[0]), ['version-installed']);
  const killed = profile(t);
  killed.start(V2);
  await killed.fire();
  assert.deepEqual(codes(killed.sends[0]), ['version-installed-after-abnormal-exit']);
});

test('one wake over several starts and other events names each code once and nothing else of what was recorded', async t => {
  const env = profile(t), before = env.ledger.latest();
  env.ledger.ingest(failure(1));
  env.start(V1); env.start(V1); env.start(V2).run.exitClean(); env.start(V2);
  env.ledger.ingest(failure(2));
  await env.fire();
  assert.equal(env.sends[0], `${wakeText(before)}原因含 version-restarted-after-abnormal-exit、version-installed-after-abnormal-exit、version-restarted。`);
  assert.doesNotMatch(env.sends[0], /Synthetic|space-1|item-|alpha|DiagnosticReports|主进程/u);
});

test('a wake with no start in it reads as before, whatever another event gives as its reason', async t => {
  const env = profile(t);
  env.first.events.quietWindowTimedOut({ scope: 'backend:synthetic', waited: 'busy', deadline: env.clock.now });
  env.ledger.ingest(failure(1));
  env.ledger.ingest(failure(2, 'version-restarted-after-abnormal-exit'));
  const before = env.wake.state.woken;
  await env.fire();
  assert.equal(env.sends[0], wakeText(before));
});

test('a wake that was not sent names the code again; once sent it does not', async t => {
  const env = profile(t);
  env.start(V1);
  env.failSend = Object.assign(Error('refused'), { notSent: true });
  assert.equal((await env.fire()).state, 'not-sent');
  env.failSend = null;
  await env.fire();
  assert.deepEqual(codes(env.sends[0]), ['version-restarted-after-abnormal-exit']);
  env.ledger.ingest(failure(1));
  await env.fire();
  assert.equal(env.sends.length, 2); assert.deepEqual(codes(env.sends[1]), []);
});

test('events that cannot be read do not hold the wake: it goes out without a code', async t => {
  const env = profile(t), before = env.ledger.latest();
  env.start(V1);
  const real = env.ledger;
  env.ledger = { latest: () => real.latest(), eventsAfter: () => { throw Error('unreadable'); } };
  assert.equal((await env.fire()).state, 'sent');
  assert.equal(env.sends[0], wakeText(before));
});

test('a long backlog is read a page at a time, and the start after it is named', async t => {
  const env = profile(t);
  for (let n = 0; n < 250; n++) env.ledger.ingest(failure(n));
  env.start(V1);
  await env.fire();
  assert.deepEqual(codes(env.sends[0]), ['version-restarted-after-abnormal-exit']);
});
