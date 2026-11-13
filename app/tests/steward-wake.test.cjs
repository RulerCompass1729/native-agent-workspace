const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { ButlerLedger } = require('../butler-ledger.cjs');
const { StewardWake, FILE, GAP_MS, wakeText } = require('../steward-wake.cjs');
const stewardRecords = require('../steward-record.cjs');
const rules = require('../queue-dispatch.cjs');
const { RoomState } = require('../room-state.cjs');
const { uiError } = require('../ui-errors.cjs');
const { COOLDOWN } = require('../session-wake.cjs');

// Waking the designated butler when NAW has recorded something new: decided on the task board by the butler then
// designated, 2026-11-13 01:20:41 (「事件来时唤醒大管家，我定了：做，默认关」), on five conditions: (1) the message
// carries only a position; (2) a butler at work is not called, and once idle gets one message for everything since;
// (3) two wakes at least 60 seconds apart; (4) a butler on DeepSeek is never called; (5) every wake is a line in
// 「大管家的记录」 under NAW's name. 「开关只给用户和大管家」, off by default.
const NOW = 1_800_000_000_000;
const BUTLER = { sessionId: 'butler', nativeId: 'native-butler' };
const failure = n => ({ eventId: `butler-source:${n}`, sourceRef: `queue-outcome:space-1:${n}`, kind: 'failure',
  payload: { spaceId: 'space-1', itemId: `item-${n}`, reason: `Synthetic failure reason ${n}` } });
function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-steward-wake-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function fixture(t, options = {}) {
  const dir = directory(t), ledger = new ButlerLedger(dir, { now: () => clock.now });
  const clock = { now: NOW }, lines = [], sends = [];
  const env = { dir, ledger, clock, lines, sends, selected: BUTLER, broken: false, failSend: null };
  env.open = () => new StewardWake(dir, { ledger: () => env.ledger, selected: () => env.selected, now: () => clock.now,
    record: line => { if (env.broken) throw Error('The butler record is unavailable'); lines.push(line); }, ...options });
  env.wake = env.open();
  env.send = async (text, itemId) => {
    if (env.failSend) throw env.failSend;
    sends.push([text, itemId]); return `tag-${sends.length}`;
  };
  env.session = { id: 'butler', nativeId: 'native-butler' };
  return env;
}
const ready = (env, model = 'claude-test-model') => env.wake.wake(env.session, model, env.send);

test('off by default: nothing recorded is a reason to wake the butler until it is turned on', async t => {
  const env = fixture(t);
  env.ledger.ingest(failure(1));
  assert.deepEqual(env.wake.view(), { on: false, at: null, failed: false });
  assert.equal(env.wake.due(), false);
  assert.equal(await ready(env), null);
  assert.deepEqual(env.sends, []); assert.deepEqual(env.lines, []);
  assert.equal(fs.existsSync(path.join(env.dir, FILE)), false, 'nothing is written while nobody turned it on');
});

test('turned on, it starts from what is recorded now; a new event wakes the butler with only a position', async t => {
  const env = fixture(t);
  env.ledger.ingest(failure(1));
  const baseline = env.ledger.latest();
  assert.equal(env.wake.set(true).on, true);
  assert.equal(env.wake.due(), false, 'what was recorded before is not news');
  env.ledger.ingest(failure(2));
  assert.equal(env.wake.due(), true);
  const done = await ready(env);
  assert.deepEqual(done, { state: 'sent', position: baseline, through: env.ledger.latest() });
  assert.equal(env.sends.length, 1);
  const [text, itemId] = env.sends[0];
  // Condition 1: the position and how to read it, nothing of what was recorded.
  assert.equal(text, wakeText(baseline));
  assert.ok(text.startsWith('【NAW 事件】') && text.includes(JSON.stringify(baseline)) && text.includes('stewardEvents'));
  assert.equal(/Synthetic|space-1|item-/u.test(text), false, 'no event content in the message');
  // The position it names reads exactly the new event.
  assert.deepEqual(env.ledger.eventsAfter(baseline).events.map(event => event.sequence), [2]);
  // Condition 5: a line under NAW's name before the send, and its outcome after.
  assert.equal(env.lines.length, 2);
  const [line, outcome] = env.lines;
  assert.deepEqual({ ...line, id: 'x' }, { kind: 'wake', id: 'x', session: { id: 'butler', nativeId: 'native-butler' }, position: baseline });
  assert.equal(itemId, `steward-wake:${line.id}`);
  assert.deepEqual(outcome, { kind: 'outcome', step: line.id, state: 'sent', reason: null, error: null, duplicate: false, operationId: 'tag-1' });
  for (const value of env.lines) stewardRecords.check({ ...value, at: NOW });
  assert.equal(env.wake.due(), false, 'nothing newer after the wake');
});

test('events recorded while the butler works come as one message, naming where the last one left off', async t => {
  const env = fixture(t);
  env.wake.set(true);
  for (const n of [1, 2, 3]) env.ledger.ingest(failure(n));
  await ready(env);
  for (const n of [4, 5, 6]) env.ledger.ingest(failure(n));
  env.clock.now += GAP_MS;
  const second = await ready(env);
  assert.equal(env.sends.length, 2, 'one message for the three events');
  assert.deepEqual(env.ledger.eventsAfter(second.position).events.map(event => event.sequence), [4, 5, 6], 'nothing lost or repeated');
});

test('two wakes are at least a minute apart, the limit of the other automatic messages; a failed attempt counts', async t => {
  assert.equal(GAP_MS, COOLDOWN);
  const env = fixture(t);
  env.wake.set(true);
  env.ledger.ingest(failure(1));
  await ready(env);
  env.ledger.ingest(failure(2));
  env.clock.now += GAP_MS - 1;
  assert.equal(await ready(env), null, 'within the minute');
  env.clock.now += 1;
  const sent = await ready(env);
  assert.equal(sent.state, 'sent');
  // Refused before anything was written: the position stays for the next wake, and the minute starts again.
  env.ledger.ingest(failure(3));
  env.clock.now += GAP_MS;
  env.failSend = Object.assign(Error('backend-update-needed'), { notSent: true });
  const refused = await ready(env);
  assert.deepEqual([refused.state, refused.position], ['not-sent', sent.through]);
  assert.equal(env.lines.at(-1).state, 'not-sent'); assert.equal(env.lines.at(-1).error, 'backend-update-needed');
  env.failSend = null;
  env.clock.now += GAP_MS - 1;
  assert.equal(await ready(env), null, 'a failed attempt is not retried within the minute');
  env.clock.now += 1;
  assert.equal((await ready(env)).position, sent.through, 'the next wake names the same position');
});

test('a wake not known to have arrived keeps its position: one may come twice, none is skipped', async t => {
  const env = fixture(t);
  env.wake.set(true);
  const baseline = env.ledger.latest();
  env.ledger.ingest(failure(1));
  env.failSend = Error('send-timeout');
  assert.equal((await ready(env)).state, 'unconfirmed');
  assert.equal(env.lines.at(-1).state, 'unconfirmed');
  env.failSend = null; env.clock.now += GAP_MS;
  assert.equal((await ready(env)).position, baseline);
});

test('a butler on DeepSeek, or one whose model is unknown, is not called', async t => {
  const env = fixture(t);
  env.wake.set(true);
  env.ledger.ingest(failure(1));
  for (const model of ['deepseek-v4-pro', 'DeepSeek-Chat', 'provider/deepseek-r2', null, '']) assert.equal(await ready(env, model), null, String(model));
  assert.deepEqual(env.sends, []); assert.deepEqual(env.lines, [], 'nothing recorded either');
  assert.equal(env.wake.due(), true, 'still waiting for a model that may be woken');
  assert.equal((await ready(env, 'gpt-5.5-codex')).state, 'sent');
});

test('a wake whose line cannot be written is not sent', async t => {
  const env = fixture(t);
  env.wake.set(true);
  env.ledger.ingest(failure(1));
  env.broken = true;
  await assert.rejects(ready(env));
  assert.deepEqual(env.sends, []);
  assert.equal(env.wake.due(), true, 'it is still owed once the record works');
  env.broken = false;
  assert.equal((await ready(env)).state, 'sent');
});

test('the switch holds for the session it was turned on for, and survives a restart with its position and minute', async t => {
  const env = fixture(t);
  env.wake.set(true);
  env.ledger.ingest(failure(1));
  await ready(env);
  env.ledger.ingest(failure(2));
  const reopened = env.open();
  assert.deepEqual(reopened.view(), { on: true, at: NOW, failed: false });
  assert.equal(reopened.due(), true);
  env.wake = reopened;
  assert.equal(await ready(env), null, 'the minute is kept over a restart');
  env.clock.now += GAP_MS;
  assert.deepEqual(env.ledger.eventsAfter((await ready(env)).position).events.map(event => event.sequence), [2]);
  const stat = fs.statSync(path.join(env.dir, FILE));
  assert.equal(stat.mode & 0o777, 0o600);
  // Another session designated: off for it, until it is turned on for it.
  env.selected = { sessionId: 'other', nativeId: 'native-other' };
  env.ledger.ingest(failure(3));
  assert.equal(env.wake.view().on, false); assert.equal(env.wake.due(), false);
  env.clock.now += GAP_MS;
  assert.equal(await ready(env), null);
  env.selected = null;
  assert.equal(env.wake.due(), false, 'revoked');
  assert.throws(() => env.wake.set(true), { code: 'STEWARD_WAKE_NO_BUTLER' });
  env.selected = { sessionId: 'other', nativeId: 'native-other' };
  env.wake.set(true);
  assert.equal(env.wake.due(), false, 'turned on for the new butler, it starts from now');
});

test('turned off, it clears a switch kept for an earlier designation: designating that session again leaves it off', async t => {
  const env = fixture(t);
  env.wake.set(true);
  // Revoked: off already for nobody, and turned off as the person's designation does (main.cjs steward).
  env.selected = null;
  assert.deepEqual(env.wake.set(false), { on: false, at: null, failed: false });
  assert.equal(JSON.parse(fs.readFileSync(path.join(env.dir, FILE), 'utf8')).on, false);
  // The same session designated again.
  env.selected = BUTLER;
  env.ledger.ingest(failure(1));
  assert.equal(env.wake.view().on, false); assert.equal(env.wake.due(), false);
  assert.equal(await ready(env), null); assert.deepEqual(env.sends, []);
  assert.equal(env.open().view().on, false, 'and so after a restart');
});

test('turned on again while on, it keeps its position; off and on again does not shorten the minute', async t => {
  const env = fixture(t);
  env.wake.set(true);
  const baseline = env.ledger.latest();
  env.ledger.ingest(failure(1));
  env.wake.set(true);
  assert.equal(env.wake.due(), true, 'nothing waiting is skipped');
  assert.equal((await ready(env)).position, baseline);
  env.wake.set(false);
  assert.deepEqual(env.wake.view(), { on: false, at: null, failed: false });
  env.ledger.ingest(failure(2));
  assert.equal(env.wake.due(), false);
  env.wake.set(true);
  env.ledger.ingest(failure(3));
  assert.equal(await ready(env), null, 'still within the minute of the last wake');
  assert.throws(() => env.wake.set('yes'), { code: 'STEWARD_WAKE_INVALID' });
});

test('a saved state that cannot be read is off until it is set again; a replaced event record names no old position', async t => {
  const env = fixture(t);
  fs.writeFileSync(path.join(env.dir, FILE), '{"version":1,"on":true}', { mode: 0o600 });
  env.ledger.ingest(failure(1));
  const broken = env.open();
  assert.deepEqual(broken.view(), { on: false, at: null, failed: true });
  assert.equal(broken.due(), false);
  env.wake = broken;
  assert.equal(broken.set(true).on, true);
  assert.equal(broken.view().failed, false);
  // The record is replaced (a new profile): its events are all new, and the wake reads from the start.
  fs.rmSync(env.ledger.file);
  env.ledger = new ButlerLedger(env.dir, { now: () => env.clock.now });
  env.ledger.ingest(failure(7));
  assert.equal(broken.due(), true);
  assert.equal((await ready(env)).position, null);
  // No event record at all: it cannot be turned on, and is not due.
  env.ledger = null;
  assert.equal(broken.due(), false);
  broken.set(false);
  assert.throws(() => broken.set(true), { code: 'STEWARD_WAKE_UNAVAILABLE' });
});

// The dispatcher's pass (queue-dispatch.cjs wakeSteward): condition 2 and the same send as a queue item.
class FakeClient extends EventEmitter {
  constructor(sessions) {
    super();
    this.state = { sessions, rooms: [{ id: 'shared', revision: 0, run: null, messages: [] }], wakePolicy: { enabled: true }, capabilities: [rules.CAPABILITY] };
    this.calls = [];
  }
  snapshot() { return structuredClone(this.state); }
  async refresh() { return this.snapshot(); }
  close() {}
  route(id) {
    if (!this.state.sessions.some(s => s.id === id)) throw Error('unknown session');
    return { client: this, state: { capabilities: [rules.CAPABILITY] } };
  }
  async call(method, ...args) {
    this.calls.push([method, ...args]);
    if (method === 'initial') return this.snapshot();
    if (method === 'dispatch') {
      const session = this.state.sessions.find(s => s.id === args[0]);
      session.state = 'working';
      return `tag-${this.calls.length}`;
    }
    throw Error(`unexpected ${method}`);
  }
  dispatches() { return this.calls.filter(call => call[0] === 'dispatch'); }
}
function butler(extra = {}) {
  return { id: 'butler', name: 'Synthetic butler', provider: 'claude', nativeId: 'native-butler', model: 'claude-test-model', state: 'idle', roomIds: [], roomId: null,
    createdAt: NOW - 3600000, background: 0, scheduled: 0, backgroundStale: false, chatAvailable: true, liveDraft: '', serviceCapabilities: [rules.CAPABILITY], fleet: [], messages: [], ...extra };
}
function passes(t, session, options = {}) {
  const env = fixture(t);
  const client = new FakeClient([session]);
  const record = new stewardRecords.StewardRecord(env.dir, { steward: () => BUTLER, now: () => env.clock.now });
  env.wake = new StewardWake(env.dir, { ledger: () => env.ledger, selected: () => env.selected, now: () => env.clock.now, record: line => record.append(line) });
  const dispatcher = new rules.QueueDispatcher({ roomState: new RoomState(env.dir), dataDir: env.dir, connect: async () => client, now: () => env.clock.now,
    settleMs: 8000, tickMs: 3600000, steward: () => ({ ...BUTLER, duty: '' }), stewardWake: env.wake, transcriptRoot: path.join(env.dir, 'none'), ...options });
  t.after(() => dispatcher.close());
  return { ...env, client, record, dispatcher, pass: async () => { await dispatcher.schedule(); } };
}

test('the dispatcher wakes the butler only once it is idle and settled, through the same NAW send as a queue item', async t => {
  const env = passes(t, butler({ state: 'working' }));
  await env.dispatcher.start();
  assert.equal(env.dispatcher.hasOpenWork(), false, 'off: no passes are kept going for it');
  env.wake.set(true);
  env.ledger.ingest(failure(1));
  assert.equal(env.dispatcher.hasOpenWork(), true, 'something new keeps the passes going');
  await env.pass();
  assert.deepEqual(env.client.dispatches(), [], 'at work: not called');
  // Its turn ends: the backend says so, as for any member.
  env.client.state.sessions[0].state = 'idle'; env.client.emit('state', env.client.snapshot());
  env.ledger.ingest(failure(2));
  await env.pass();
  assert.deepEqual(env.client.dispatches(), [], 'just idle: not settled yet');
  env.clock.now += 8000;
  await env.pass();
  const sent = env.client.dispatches();
  assert.equal(sent.length, 1, 'one message for both events');
  const [, id, text, nativeId, itemId] = sent[0];
  assert.deepEqual([id, nativeId], ['butler', 'native-butler']);
  assert.equal(text, wakeText(null), 'the record was empty when it was turned on: from the start');
  assert.match(itemId, /^steward-wake:[0-9a-f-]{36}$/u);
  assert.equal(env.client.calls.some(call => ['send', 'queue', 'claim', 'input'].includes(call[0])), false, 'no human send, no takeover');
  // In 「大管家的记录」 under NAW's name, with its outcome; the person's dialog leaves it out until its words are seen.
  const entries = env.record.entries().filter(entry => entry.kind === 'wake');
  assert.deepEqual(entries.map(entry => [entry.position, entry.state]), [[null, 'sent']]);
  assert.match(entries[0].operationId, /^tag-\d+$/u);
  assert.deepEqual(stewardRecords.view(env.record, { sessions: [] }).entries, [], 'the wake is the only line, and the dialog shows none');
  assert.equal(env.dispatcher.hasOpenWork(), false);
});

test('the dispatcher does not wake a butler the person just used, one in a space, one on DeepSeek, or with automatic messages off', async t => {
  const cases = [
    ['the person just used it', butler(), env => env.dispatcher.noteHuman('butler')],
    ['in a space', butler({ roomIds: ['shared'], roomId: 'shared' }), () => {}],
    ['on DeepSeek', butler({ provider: 'codex', model: null, nativeSettings: { model: 'deepseek-v4-pro' } }), () => {}],
    ['model unknown', butler({ model: null }), () => {}],
    ['automatic messages off', butler(), env => { env.client.state.wakePolicy = { enabled: false }; env.client.emit('state', env.client.snapshot()); }],
    ['a draft the person is typing', butler({ liveDraft: 'half a sentence' }), () => {}],
    ['another native session under the id', butler({ nativeId: 'native-other' }), () => {}],
  ];
  for (const [name, session, arrange] of cases) {
    const env = passes(t, session);
    await env.dispatcher.start();
    env.wake.set(true);
    arrange(env);
    env.ledger.ingest(failure(1));
    await env.pass(); env.clock.now += 9000; await env.pass();
    assert.deepEqual(env.client.dispatches(), [], name);
    assert.equal(env.record.entries().some(entry => entry.kind === 'wake'), false, name);
  }
});

test('after the person used the butler, the wake comes once their quiet time has passed', async t => {
  const env = passes(t, butler());
  await env.dispatcher.start();
  env.wake.set(true);
  env.dispatcher.noteHuman('butler');
  env.ledger.ingest(failure(1));
  await env.pass(); env.clock.now += 9000; await env.pass();
  assert.equal(env.client.dispatches().length, 0);
  env.clock.now += rules.HUMAN_QUIET_MS;
  await env.pass();
  assert.equal(env.client.dispatches().length, 1);
});

// The switch in main.cjs: the person's and the designated butler's alone.
function handler({ butler: isButler = true, person = true, wake = { view: () => ({ on: false }), set: on => ({ on }) } } = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8');
  const start = source.indexOf("  register('stewardWake', async (c, on) => {");
  const end = source.indexOf("  // B6: the person's own actions on an integration handoff", start);
  assert.ok(start > 0 && end > start);
  let registered;
  const context = vm.createContext({
    register: (name, fn) => { assert.equal(name, 'stewardWake'); registered = fn; },
    stewardCaller: async c => (c.background && isButler ? { id: 'butler', name: 'Synthetic butler' } : null),
    isCurrentHumanContext: c => !c.background && person,
    stewardWake: wake, uiError,
  });
  vm.runInContext(source.slice(start, end), context);
  return { agent: (...args) => registered({ background: true }, ...args), person: (...args) => registered({ background: false }, ...args) };
}
const refusal = key => error => error?.uiMessage?.key === key;

test('only the person in their window and the designated butler turn it on or off', async () => {
  const changes = [];
  const wake = { view: () => ({ on: 'as is' }), set: on => { changes.push(on); return { on }; } };
  await assert.rejects(handler({ butler: false, wake }).agent(true), refusal('error.steward.wakeOnly'));
  await assert.rejects(handler({ person: false, wake }).person(true), refusal('error.steward.wakeOnly'), 'a window that is not the person\'s current one');
  assert.deepEqual(changes, [], 'a refused call changes nothing');
  assert.deepEqual(await handler({ wake }).agent(true), { on: true });
  assert.deepEqual(await handler({ wake }).person(false), { on: false });
  assert.deepEqual(await handler({ wake }).agent(), { on: 'as is' }, 'no argument only says how it stands');
  assert.deepEqual(changes, [true, false]);
  await assert.rejects(handler({ wake }).agent('on'), refusal('error.steward.wakeInvalid'));
  await assert.rejects(handler({ wake: null }).agent(true), refusal('error.steward.wakeUnavailable'));
  const failing = code => ({ view: () => ({}), set: () => { throw Object.assign(Error('x'), { code }); } });
  await assert.rejects(handler({ wake: failing('STEWARD_WAKE_NO_BUTLER') }).person(true), refusal('error.steward.wakeNoButler'));
  await assert.rejects(handler({ wake: failing('STEWARD_WAKE_UNAVAILABLE') }).person(true), refusal('error.steward.wakeUnavailable'));
});

test('the switch is a local call the butler finds in the catalog, the page can reach, and the dispatcher is given', () => {
  const main = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8');
  const local = main.slice(main.indexOf("const local = new Set(["), main.indexOf(']);', main.indexOf("const local = new Set([")));
  assert.ok(local.includes("'stewardWake'"));
  assert.ok(main.includes('      stewardWake: stewardWake || undefined,\n'));
  assert.ok(fs.readFileSync(path.join(__dirname, '../preload.cjs'), 'utf8').includes("'stewardWake'"));
  const { BackgroundControl } = require('../background-control.cjs');
  const entry = new BackgroundControl({ dataDir: os.tmpdir(), handlers: new Map([['stewardWake', () => null]]) }).catalog().find(item => item.method === 'stewardWake');
  assert.match(entry.parameters[0], /【NAW 事件】[\s\S]*stewardEvents/u);
});

test('the record takes a wake line only as NAW writes it', () => {
  const line = { kind: 'wake', at: NOW, id: 'w1', session: { id: 'butler', nativeId: 'native-butler' }, position: '0123456789abcdef:4' };
  stewardRecords.check(line);
  stewardRecords.check({ ...line, position: null });
  for (const bad of [{ ...line, position: '4' }, { ...line, position: undefined }, { ...line, text: 'event content' }, { ...line, session: { id: 'butler' } }, { ...line, id: '' }]) {
    assert.throws(() => stewardRecords.check(bad), /Invalid steward record line/u);
  }
});
