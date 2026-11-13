const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { uiError } = require('../ui-errors.cjs');
const { roomIds } = require('../collaboration-spaces.cjs');
const { StewardRole, DUTY_MAX, validDuty } = require('../steward-role.cjs');
const { IntegratorRole } = require('../integrator-role.cjs');
const { QueueSecretary } = require('../queue-secretary.cjs');
const { RoomState } = require('../room-state.cjs');
const backgroundOperation = require('../background-operation.cjs');
const messages = require('../ui-messages.js'), locale = require('../ui-locale.js');

// The butler the person talks to (大管家), step 1: the record of who it is, the person's own entry in main.cjs, the
// rule that keeps it outside every space, and the one-time landing mark. Synthetic sessions only. The designation
// gives the session nothing, so nothing here is about powers.
const source = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8');
const cut = (from, to) => { const start = source.indexOf(from), end = source.indexOf(to, start + from.length); assert.ok(start > 0 && end > start, from); return source.slice(start, end); };
const ONE = { sessionId: 'session-1', nativeId: 'native-1' };
const edge = (event, from, to) => JSON.stringify({ event, old: { id: from.sessionId, nativeId: from.nativeId }, new: { id: to.sessionId, nativeId: to.nativeId } });
const key = name => error => error.uiMessage?.key === name;

function fixture(t, { landingOwner = null } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-steward-entry-'));
  t.after(() => { try { fs.chmodSync(directory, 0o700); } catch {} fs.rmSync(directory, { recursive: true, force: true }); });
  const role = new StewardRole(directory), room = new RoomState(directory);
  const handlers = new Map(), broadcasts = [], memberships = [], submitted = [], queued = [];
  // The real membership function is not under test here: only whether it is reached.
  const roomState = { apply: snapshot => room.apply(snapshot), metadata() {}, serial: action => action(), membership: async (_client, id, join, _label, space) => { memberships.push([id, join, space ?? null]); } };
  const context = vm.createContext({ applicationHandlers: handlers, backgroundOperation, uiError, roomIds, stewardRole: role, roomState, landingOwner, validRoomId: id => typeof id === 'string' && id.length > 0,
    queueDispatcher: null, sessionLabels: { labels: new Map() }, ipcMain: { handle() {} }, broadcastRoom: async () => { broadcasts.push(role.selected); },
    // What designating sends: the person's own input, as the composer gives it, in the person's language.
    validDuty, displayText: key => locale.format('zh', key), uiLocale: locale, refuseSubmit: null,
    submit: async (c, method, ...args) => {
      if (context.refuseSubmit) throw context.refuseSubmit;
      submitted.push([c === person, method, ...args]);
      if (method !== 'queue') return;
      // As the workspace does: the message is recorded, waiting, and Claude answers only once its running turn has taken it.
      return new Promise((resolve, reject) => { queued.push({ resolve, reject }); setImmediate(() => {
        const session = sessions.find(session => session.id === args[0]);
        // Another message queued at the same moment comes first: it is not taken for this one.
        (session.messages ||= []).push({ id: `other-${queued.length}`, role: 'user', inputMode: 'queue', status: 'awaiting-native', text: 'the person\'s own' }); client.emit('state');
        setImmediate(() => { session.messages.push({ id: `row-${queued.length}`, role: 'user', inputMode: 'queue', status: 'awaiting-native', text: args[1].trim() }); client.emit('state'); });
      }); });
    } });
  vm.runInContext(cut('function register(name, handler) {', 'async function replaceBackendSockets'), context);
  vm.runInContext(cut('function keepStewardOutside(id, join) {', 'function conversationReaderAllowed(actor) {'), context);
  vm.runInContext(cut("  register('steward', async (c, id, duty = null) => {", "  // B6: the person's own actions on an integration handoff"), context);
  vm.runInContext(cut("  register('join', async (c, id, join) => {", "  register('roomRename',"), context);
  // The space action's own join branch, as written, in a handler of its own.
  vm.runInContext("register('spaceJoin', async (c, roomId, action, args = []) => {\n" + cut("    if (action === 'join') {\n      keepStewardOutside(", "    if (['stageImages', 'removeImage'].includes(action)) {") + '});', context);
  vm.runInContext(cut("  register('landing', c => {", '\n'), context);
  const sessions = [
    { id: 'outside', nativeId: 'native-outside', name: 'Outside', state: 'idle', roomIds: [] },
    { id: 'other', nativeId: 'native-other', name: 'Other', state: 'working', provider: 'claude', roomIds: [] },
    { id: 'busy-codex', nativeId: 'native-busy-codex', name: 'Busy Codex', state: 'working', provider: 'codex', roomIds: [] },
    { id: 'member', nativeId: 'native-member', name: 'Member', state: 'idle', roomIds: ['shared'] },
    { id: 'legacy-member', nativeId: 'native-legacy', name: 'Legacy member', state: 'idle', roomId: 'shared' },
    { id: 'no-native', nativeId: null, name: 'No native id', state: 'idle', roomIds: [] },
    { id: 'pending', nativeId: 'native-pending', name: 'Pending', state: 'idle', nativeContextPending: true, roomIds: [] },
    { id: 'ended', nativeId: 'native-ended', name: 'Ended', state: 'ended', roomIds: [] },
    { id: 'background', nativeId: 'native-background', name: 'Background', state: 'background', roomIds: [] },
    { id: 'broken', nativeId: 'native-broken', name: 'Broken membership', state: 'idle', roomIds: 'shared' },
  ];
  const client = Object.assign(new EventEmitter(), { call: async () => ({ sessions }), entries: [{ state: { sessions: [{ id: 'old' }], capabilities: [] } }], refresh: async () => {}, snapshot: () => ({ wakePolicy: { enabled: true }, sessions }) });
  const person = { client, view: { owner: 'first-window' } };
  const agent = id => {
    const record = sessions.find(session => session.id === id);
    const actor = { id, nativeId: record.nativeId, name: record.name, provider: 'claude', turnId: 'turn', callId: 'call', operationId: 'op' };
    const c = { background: true, actor, client, view: { selected: id, owner: 'first-window' }, win: { destroy() {} }, checkActor: async () => {} };
    return (name, args) => backgroundOperation.run(actor, () => handlers.get(name)(c, ...args), { context: c, valid: async () => {} });
  };
  return { directory, role, handlers, broadcasts, memberships, submitted, queued, client, sessions, person, agent, context, file: path.join(directory, 'steward.json'), call: (...args) => handlers.get('steward')(person, ...args) };
}

test('nobody is the butler until the person designates one session; the record survives a restart, follows a finished replacement, and can be cleared', t => {
  const f = fixture(t);
  assert.equal(f.role.current(), null); assert.equal(fs.existsSync(f.file), false);
  f.role.set(ONE);
  assert.deepEqual(new StewardRole(f.directory).current(), ONE);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file, 'utf8')), { version: 1, selected: ONE }, 'The record names a session and nothing else');
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  // After a rotation the written log decides: a finished, single replacement moves it; a kept old session does not.
  const TWO = { sessionId: 'session-2', nativeId: 'native-2' }, THREE = { sessionId: 'session-3', nativeId: 'native-3' };
  fs.writeFileSync(path.join(f.directory, 'rotation-log.jsonl'), edge('done', ONE, TWO) + '\n', { mode: 0o600 });
  assert.deepEqual(new StewardRole(f.directory).current(), TWO);
  fs.appendFileSync(path.join(f.directory, 'rotation-log.jsonl'), edge('kept', TWO, THREE) + '\n');
  assert.deepEqual(new StewardRole(f.directory).current(), TWO, 'A replacement whose old session is kept does not carry the designation');
  f.role.set(null); assert.equal(new StewardRole(f.directory).current(), null);
  // Only a session id with its native id is a designation.
  for (const bad of [{}, { sessionId: 'a' }, { sessionId: 'a', nativeId: 'b', extra: 1 }, { sessionId: '', nativeId: 'b' }, 'session-1', ['session-1', 'native-1']]) assert.throws(() => f.role.set(bad));
});

test('the three designations keep three records: setting the butler never touches the secretary or the integrator', t => {
  const f = fixture(t), secretary = new QueueSecretary(f.directory), integrator = new IntegratorRole(f.directory);
  secretary.set({ sessionId: 'sec', nativeId: 'native-sec' }); integrator.set({ sessionId: 'int', nativeId: 'native-int' });
  const others = () => ['queue-secretary.json', 'integrator.json'].map(name => fs.readFileSync(path.join(f.directory, name), 'utf8'));
  const before = others();
  f.role.set(ONE); f.role.set(null); f.role.set(ONE);
  assert.deepEqual(others(), before);
  assert.deepEqual([new QueueSecretary(f.directory).current().sessionId, new IntegratorRole(f.directory).current().sessionId, new StewardRole(f.directory).current().sessionId], ['sec', 'int', 'session-1']);
  // And the reverse: the other two leave the butler's record as it is.
  const mine = fs.readFileSync(f.file, 'utf8'); secretary.set(null); integrator.set(null);
  assert.equal(fs.readFileSync(f.file, 'utf8'), mine);
});

test('a record or log that cannot be trusted is an error, never "nobody designated"; designating again restores it', t => {
  const state = key('error.steward.state');
  for (const damage of [file => fs.writeFileSync(file, '{broken', { mode: 0o600 }), file => fs.writeFileSync(file, JSON.stringify({ version: 2, selected: ONE }), { mode: 0o600 }), file => fs.chmodSync(file, 0o644),
    file => { fs.rmSync(file); fs.symlinkSync(path.join(path.dirname(file), 'elsewhere.json'), file); }]) {
    const f = fixture(t); f.role.set(ONE); damage(f.file);
    assert.throws(() => new StewardRole(f.directory).current(), state);
  }
  const f = fixture(t); f.role.set(ONE); fs.writeFileSync(path.join(f.directory, 'rotation-log.jsonl'), 'not json\n', { mode: 0o600 });
  assert.throws(() => new StewardRole(f.directory).current(), state);
  // Designating again writes a new record over a damaged one. (A rotation log that cannot be read is not cured by it.)
  const again = fixture(t); again.role.set(ONE); fs.writeFileSync(again.file, '{broken', { mode: 0o600 });
  const damaged = new StewardRole(again.directory); assert.throws(() => damaged.current(), state);
  damaged.set({ sessionId: 'session-9', nativeId: 'native-9' }); assert.deepEqual(new StewardRole(again.directory).current(), { sessionId: 'session-9', nativeId: 'native-9' });
  // A designation that cannot be saved is refused, and the record is not trusted until it is read again.
  const g = fixture(t); fs.chmodSync(g.directory, 0o500);
  assert.throws(() => g.role.set(ONE), state); assert.throws(() => g.role.current(), state);
});

test('the person designates a session outside every space, replaces it, and revokes it; every window is told', async t => {
  const f = fixture(t);
  await f.call('outside');
  assert.deepEqual(new StewardRole(f.directory).current(), { sessionId: 'outside', nativeId: 'native-outside' });
  await f.call('other');
  assert.deepEqual(f.role.current(), { sessionId: 'other', nativeId: 'native-other' }, 'There is one butler: the newer replaces the older');
  await f.call(null);
  assert.equal(new StewardRole(f.directory).current(), null); assert.equal(f.broadcasts.length, 3);
});

test('the queue dispatcher is told who the butler is now and the duty statement it is handed on with (batch 3)', async t => {
  // main.cjs's own option, as written: a mistake there would only be swallowed by the dispatcher, which then never
  // replaces the butler.
  const f = fixture(t), option = vm.runInContext('(' + cut('      steward: () => {', '      creationDefaults:').trim().replace(/^steward: /u, '').replace(/,$/u, '') + ')', f.context);
  const header = locale.format('zh', 'steward.duty.header'), standard = locale.format('zh', 'steward.duty.default');
  // Made in the sandbox's realm: compared as the plain values they are.
  const told = () => JSON.parse(JSON.stringify(option()));
  assert.equal(option(), null);
  f.role.set(ONE);
  assert.deepEqual(told(), { ...ONE, duty: header + '\n' + standard });
  f.role.set(ONE, '只管派活。');
  assert.deepEqual(told(), { ...ONE, duty: header + '\n只管派活。' }, 'the person\'s own statement');
  const TWO = { sessionId: 'session-2', nativeId: 'native-2' };
  fs.writeFileSync(path.join(f.directory, 'rotation-log.jsonl'), edge('done', ONE, TWO) + '\n', { mode: 0o600 });
  assert.deepEqual(told(), { ...TWO, duty: header + '\n只管派活。' }, 'after a finished replacement, its successor');
  fs.writeFileSync(path.join(f.directory, 'rotation-log.jsonl'), 'not json\n', { mode: 0o600 });
  assert.throws(option, key('error.steward.state'), 'a record that cannot be read is not taken for nobody');
});

test('designating sends the duty statement into the session as the person\'s message; it stays the butler when that cannot be done (batch 4)', async t => {
  const f = fixture(t), header = locale.format('zh', 'steward.duty.header'), standard = locale.format('zh', 'steward.duty.default');
  f.call = async (...args) => JSON.parse(JSON.stringify(await f.handlers.get('steward')(f.person, ...args)) ?? 'null');
  // An idle session is sent the default text of the person's language, which is not written into the record.
  assert.deepEqual(await f.call('outside'), { duty: { state: 'sent' } });
  assert.deepEqual(f.submitted, [[true, 'send', 'outside', header + '\n' + standard, 'native-outside']]);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file, 'utf8')), { version: 1, selected: { sessionId: 'outside', nativeId: 'native-outside' } });
  // A Claude session in a turn is queued after it; the person's own text is sent and kept for the next time. The answer
  // comes once the message stands waiting in its conversation, not when the running turn ends and takes it.
  assert.deepEqual(await f.call('other', '只做排期，不做执行。'), { duty: { state: 'queued' } });
  assert.deepEqual([f.queued.length, f.sessions.find(s => s.id === 'other').messages.map(m => m.id), f.client.listenerCount('state')], [1, ['other-1', 'row-1'], 0]);
  assert.deepEqual(f.submitted[1], [true, 'queue', 'other', header + '\n只做排期，不做执行。', 'native-other']);
  assert.equal(new StewardRole(f.directory).duty, '只做排期，不做执行。');
  // Confirming the same butler again sends it again; null goes back to the default.
  assert.deepEqual(await f.call('other'), { duty: { state: 'queued' } }); assert.equal(f.submitted[2][3], header + '\n' + standard); assert.equal(f.role.duty, null);
  // A session that can take neither is still the butler, and the person is told why the statement did not go in.
  const busy = await f.call('busy-codex');
  assert.deepEqual([busy.duty.state, busy.duty.error.uiMessage.key, f.role.current().sessionId, f.submitted.length], ['not-sent', 'error.steward.dutyBusy', 'busy-codex', 3]);
  f.context.refuseSubmit = Error('The session closed');
  const refused = await f.call('outside');
  assert.deepEqual([refused.duty, f.role.current().sessionId], [{ state: 'not-sent', error: { message: 'The session closed' } }, 'outside']);
  // A queue refused before the message is recorded is said, in the form a thrown error is shown in.
  f.context.refuseSubmit = uiError('error.workspace.nativeWaitingInputUnavailable');
  const unqueued = await f.call('other');
  assert.deepEqual([unqueued.duty.state, unqueued.duty.error.message, unqueued.duty.error.uiMessage, f.client.listenerCount('state')],
    ['not-sent', f.context.refuseSubmit.message, locale.displayMessage(f.context.refuseSubmit.uiMessage), 0]);
  // A refusal after the row stands is that row's own state; it is not an unhandled failure here.
  f.queued[0].reject(Object.assign(Error('Closed'), { notSent: true }));
  f.context.refuseSubmit = Object.assign(Error(''), { uiMessage: { version: 1, key: 'error.steward.dutyBusy' } });
  const incomplete = uiError('error.main.operationIncomplete');
  assert.deepEqual((await f.call('outside')).duty, { state: 'not-sent', error: { message: incomplete.message, uiMessage: incomplete.uiMessage } }, 'No message: the same fallback as a thrown error');
  // Revoking sends nothing. Text that is empty or too long is refused before anything changes.
  f.context.refuseSubmit = null; assert.equal(await f.call(null), null); assert.equal(f.submitted.length, 3);
  const before = fs.readFileSync(f.file, 'utf8');
  for (const bad of ['', '   ', 'x'.repeat(DUTY_MAX), 'a\u0000b', 7, {}]) await assert.rejects(f.call('outside', bad), key('error.steward.dutyInvalid'), JSON.stringify(bad));
  assert.deepEqual([fs.readFileSync(f.file, 'utf8'), f.submitted.length], [before, 3]);
  // An agent cannot have anything sent this way either.
  await assert.rejects(f.agent('outside')('steward', ['outside', 'text']), key('error.steward.personOnly')); assert.equal(f.submitted.length, 3);
});

test('the duty statement is bounded so that the record stays readable by every build, and a damaged one is an error', t => {
  // The longest ids with the longest statement still fit the 4096 bytes every build reads.
  const f = fixture(t), long = { sessionId: '会'.repeat(100), nativeId: '話'.repeat(100) };
  let most = ''; while (validDuty(most + '说')) most += '说';
  f.role.set(long, most);
  assert.ok(fs.statSync(f.file).size <= 4096, String(fs.statSync(f.file).size));
  assert.deepEqual([new StewardRole(f.directory).current(), new StewardRole(f.directory).duty], [long, most]);
  assert.throws(() => f.role.set(long, most + '说'), key('error.steward.dutyInvalid'));
  // JSON writes a lone surrogate as six bytes: such ids with the longest statement would pass the old limit, so the
  // whole file is measured, and the record on disk stays as it was.
  const before = fs.readFileSync(f.file, 'utf8'), odd = { sessionId: '\ud800'.repeat(100), nativeId: '\udfff'.repeat(100) };
  assert.throws(() => f.role.set(odd, most), key('error.steward.dutyInvalid'));
  assert.deepEqual([fs.readFileSync(f.file, 'utf8'), f.role.duty], [before, most]);
  f.role.set(odd, '短'); assert.ok(fs.statSync(f.file).size <= 4096); assert.deepEqual(new StewardRole(f.directory).current(), odd);
  // Tabs and new lines are text; other control characters are not.
  assert.equal(validDuty('一\n二\t三\r\n'), true); assert.equal(validDuty('a\u001bb'), false);
  for (const duty of ['', 5, null, 'a\u0007']) {
    const g = fixture(t); fs.writeFileSync(g.file, JSON.stringify({ version: 1, selected: ONE, duty }), { mode: 0o600 });
    assert.throws(() => new StewardRole(g.directory).current(), key('error.steward.state'), JSON.stringify(duty));
  }
});
test('a session NAW opened to replace another, before it has moved in, cannot be designated (steward step 2, batch 2)', async t => {
  const f = fixture(t);
  f.context.queueDispatcher = { rotations: { old: { phase: 'joining', newId: 'outside' } } };
  await assert.rejects(f.call('outside'), key('error.steward.invalid')); assert.equal(fs.existsSync(f.file), false);
  // A failed rotation still to stop its unused successor: not yet; one it had handed work to: yes.
  f.context.queueDispatcher = { rotations: { old: { phase: 'failed', newId: 'outside' } } };
  await assert.rejects(f.call('outside'), key('error.steward.invalid'));
  f.context.queueDispatcher = { rotations: { old: { phase: 'failed', newId: 'outside', handoffConfirmed: true } } };
  await f.call('outside'); await f.call(null);
  // Once the rotation is over (kept), it can.
  f.context.queueDispatcher = { rotations: { old: { phase: 'kept' }, outside: { phase: 'kept', successorOf: 'old' } } };
  await f.call('outside'); assert.deepEqual(f.role.selected, { sessionId: 'outside', nativeId: 'native-outside' });
});
test('a session that cannot hold the designation is refused, in words, and nothing is written', async t => {
  const f = fixture(t);
  await f.call('outside'); const before = fs.readFileSync(f.file, 'utf8');
  for (const [id, error] of [['member', 'error.steward.inSpace'], ['legacy-member', 'error.steward.inSpace'], ['no-native', 'error.steward.invalid'], ['pending', 'error.steward.invalid'], ['ended', 'error.steward.invalid'],
    ['background', 'error.steward.invalid'], ['broken', 'error.steward.invalid'], ['no-such-session', 'error.steward.invalid'], [undefined, 'error.steward.invalid'], [{ id: 'outside' }, 'error.steward.invalid']]) {
    await assert.rejects(f.call(id), key(error), String(id));
  }
  assert.equal(fs.readFileSync(f.file, 'utf8'), before); assert.equal(f.broadcasts.length, 1);
  // A session the person archived is known from the desktop's own record, not from the backend's list.
  f.context.roomState.apply = snapshot => ({ ...snapshot, sessions: snapshot.sessions.map(s => s.id === 'other' ? { ...s, archived: true } : s) });
  await assert.rejects(f.call('other'), key('error.steward.invalid'));
});

test('an agent can neither designate nor revoke, whoever it is and whatever it names', async t => {
  const f = fixture(t);
  await f.call('outside'); const before = fs.readFileSync(f.file, 'utf8');
  for (const who of ['outside', 'other', 'member']) for (const target of [null, 'outside', 'other', who]) await assert.rejects(f.agent(who)('steward', [target]), key('error.steward.personOnly'), `${who} -> ${target}`);
  assert.equal(fs.readFileSync(f.file, 'utf8'), before); assert.equal(f.broadcasts.length, 1);
});

test('the butler is not joined to a space, by either way of joining; leaving and everyone else go through', async t => {
  const f = fixture(t);
  await f.call('outside');
  for (const join of [() => f.handlers.get('join')(f.person, 'outside', true), () => f.handlers.get('spaceJoin')(f.person, 'space-1', 'join', ['outside', true])]) await assert.rejects(join(), key('error.steward.joinSpace'));
  assert.deepEqual(f.memberships, [], 'The refusal comes before anything is changed');
  // Leaving is never refused, and another session joins as before.
  await f.handlers.get('join')(f.person, 'outside', false); await f.handlers.get('spaceJoin')(f.person, 'space-1', 'join', ['other', true]); await f.handlers.get('join')(f.person, 'other', true);
  assert.deepEqual(f.memberships, [['outside', false, null], ['other', true, 'space-1'], ['other', true, null]]);
  // With nobody designated, and with a record that cannot be read, joining is as it always was.
  await f.call(null); await f.handlers.get('join')(f.person, 'outside', true);
  fs.writeFileSync(f.file, '{broken', { mode: 0o600 }); f.context.stewardRole = new StewardRole(f.directory);
  await f.handlers.get('join')(f.person, 'outside', true);
  assert.equal(f.memberships.length, 5);
});

test('only the first window of a start of the app is told to land, once; a second window, a later ask and an agent\'s view are not', async t => {
  const f = fixture(t, { landingOwner: 'first-window' }), landing = f.handlers.get('landing');
  assert.equal(await landing({ view: { owner: 'second-window' } }), false);
  // An agent's view of the same window is never told to land, and its asking does not use the mark up.
  const asked = await f.agent('outside')('landing', []).then(value => value, error => error);
  assert.ok(asked === false || asked instanceof Error, String(asked));
  assert.equal(await landing(f.person), true); assert.equal(await landing(f.person), false, 'A reload of the same window asks again and is told no');
  // No start to land for.
  assert.equal(await fixture(t).handlers.get('landing')(f.person), false);
});

test('the entry is wired: the record is built from the data folder, shown in the state, reachable from the window, and nothing else writes it', () => {
  assert.ok(source.includes("const { StewardRole, validDuty } = require('./steward-role.cjs');"));
  assert.match(source, /integratorRole = new IntegratorRole\(dataDir\);\n[^\n]*\n  stewardRole = new StewardRole\(dataDir\);/);
  assert.match(source, /try \{ stewardDuty = stewardRole\?\.duty \?\? null; steward = stewardRole\?\.current\(\) \|\| null; \} catch \{ stewardWarning = displayText\('error\.steward\.state'\); \}/);
  assert.match(source, /const warning = \[outboxWarning, secretaryWarning, integratorWarning, stewardWarning\]/);
  assert.match(source, /queueSecretary: secretary, integrator, \.\.\.handoffEnabled, steward, /);
  // The duty statement the person chose is shown to the person's windows only, never in an agent's view.
  assert.ok(source.includes("steward, ...(context?.background ? {} : { stewardDuty }), "));
  // The start of the app names the window that lands: the first one restored, or the one opened when none is.
  assert.match(source, /const restore = views\.filter\(v => v\.active\);\n[^\n]*\n[^\n]*\n  landingOwner = restore\.length > 1 \? null : \(restore\[0\] \|\| views\.at\(-1\)\)\?\.owner \|\| null;\n/);
  // The rule itself, as written: one restored window lands, the last view when none was open, and none of several.
  const rule = (views, restore) => vm.runInNewContext(source.match(/landingOwner = (restore\.length > 1 [^;]*);/)[1], { views, restore });
  const A = { owner: 'a' }, B = { owner: 'b' };
  assert.deepEqual([rule([A, B], [A]), rule([A, B], []), rule([], []), rule([A, B], [A, B])], ['a', 'b', null, null]);
  // Both calls are answered by this desktop, with or without a backend that supports background control.
  assert.match(source, /name === 'handoff' \|\| name === 'steward' \|\| /); assert.match(source, /'chooseFolder', 'copy', 'landing', /);
  const preload = fs.readFileSync(path.join(__dirname, '../preload.cjs'), 'utf8');
  assert.match(preload, /'runtimeLocation', 'retrySave', 'steward', 'stewardRecord', 'landing'\]\) \{/);
  assert.equal(source.match(/stewardRole\.set\(/g).length, 2, 'Only the entry writes the designation');
  // Step 2, batch 2: every join meets one guard (a session NAW opened for a space, a rotation's successor included),
  // and the designation is made in the same queue the joins run in.
  assert.match(source, /roomState = new RoomState\(dataDir\);\n[^\n]*\n  roomState\.joinGuard = id => keepStewardOutside\(id, true\);/);
  assert.match(source, /else await roomState\.serial\(async \(\) => \{\n[^]*?stewardRole\.set\(\{ sessionId: record\.id, nativeId: record\.nativeId \}, duty\);\n    \}\);/);
  for (const file of fs.readdirSync(path.join(__dirname, '..')).filter(name => /\.c?js$/.test(name) && !['main.cjs', 'steward-role.cjs'].includes(name))) {
    assert.ok(!/stewardRole|StewardRole|steward\.json/.test(fs.readFileSync(path.join(__dirname, '..', file), 'utf8')), file);
  }
  // The record module shares nothing writable with the other two roles.
  const own = fs.readFileSync(path.join(__dirname, '../steward-role.cjs'), 'utf8');
  assert.equal(/integrator\.json|queue-secretary\.json|butler\.json/.test(own), false); assert.ok(own.includes("path.join(directory, 'steward.json')"));
  // The designation gives nothing: the entry's handler touches the record and tells the windows, and no more.
  const handler = cut("  register('steward', async (c, id, duty = null) => {", "  // B6: the person's own actions on an integration handoff");
  assert.deepEqual([...new Set(handler.match(/\b(queueSecretary|integratorRole|operator[A-Z]\w*|butler[A-Z]\w*|backgroundControl|queueDispatcher)\b/g) || [])], []);
});

test('every sentence exists in both languages, and the words say what the designation does and does not do', () => {
  const keys = ['menu.stewardSet', 'menu.stewardChange', 'menu.stewardRevoke', 'error.steward.invalid', 'error.steward.inSpace', 'error.steward.joinSpace', 'error.steward.state', 'error.steward.personOnly', 'steward.emptyLabel',
    'steward.rowLabel', 'steward.rowStatus', 'steward.choose.title', 'steward.choose.intro', 'steward.choose.current', 'steward.choose.inSpace', 'steward.choose.unusable', 'steward.choose.none', 'steward.choose.confirm',
    // Batch 4: the duty statement designating sends (the activation checklist, item 6).
    'steward.choose.resend', 'steward.duty.label', 'steward.duty.default', 'steward.duty.header', 'steward.duty.notSent', 'error.steward.dutyInvalid', 'error.steward.dutyBusy',
    // The butler's record (step 2, batch 1); its own sentences are checked in steward-record.test.cjs.
    // Batch 4: what the butler does to a queue says so.
    'notice.queue.addedBySteward', 'notice.queue.cancelledBySteward', 'notice.queue.resolvedBySteward', 'queue.creator.steward', 'queue.status.cancelledBySteward', 'queue.status.doneBySteward',
    'menu.stewardRecord', 'error.steward.recordUnavailable', 'error.steward.designationUnreadable', 'error.stewardRecord.personOnly', 'error.stewardRecord.unavailable', 'records.name.steward', 'records.item.stewardUnavailable', 'records.item.stewardUnavailableOther'];
  for (const language of ['zh', 'en']) assert.deepEqual(Object.keys(messages[language]).filter(name => /steward/i.test(name) && !name.startsWith('stewardRecord.')).sort(), [...keys].sort(), language);
  for (const name of keys) assert.equal(/[一-鿿]/.test(messages.en[name]), false, name);
  // It gives nothing and takes one thing away, and the person is told both before they confirm.
  assert.equal(locale.format('zh', 'steward.choose.intro'), '你主要和它说话。它固定在侧栏最上面，不再列在「会话」里。指定之后，它能看所有协作空间里的内容（消息、便签、事件、文件、图片、队列），它看到的内容会交给它所用的模型服务；它能经 NAW 往队列里加事、取消和标为已处理，每一步记在「大管家的记录」里。当大管家期间它不能加入协作空间。只有你能指定、更换或撤销。');
  assert.equal(locale.format('en', 'steward.choose.intro'), 'You mainly talk to it. It stays at the top of the sidebar and is no longer listed under Sessions. Once designated it can see what every collaboration space holds (messages, notes, events, files, images, queues), and what it sees goes to the model service it runs on; it can add, cancel and mark handled queue items through NAW, each step in the butler’s record. While it is the butler it cannot join a collaboration space. Only you can designate, change or revoke it.');
  assert.equal(/不改变它的任何权限|changes none of its permissions/.test(JSON.stringify(messages)), false);
  // The warning says what the row shows and that it is not "nobody". It promises no cure: a damaged record is cured by
  // designating again, a rotation log that cannot be read is not.
  assert.equal(locale.format('zh', 'error.steward.state'), '大管家的指定现在读不到；侧栏最上面显示成「未指定」，这不表示没有指定。');
  assert.equal(locale.format('en', 'error.steward.state'), 'The butler designation cannot be read right now; the top of the sidebar shows \u201cNot designated\u201d, which does not mean that nobody is designated.');
  assert.equal(/就能恢复|restores it/.test(messages.zh['error.steward.state'] + messages.en['error.steward.state']), false);
  assert.equal(locale.format('zh', 'menu.stewardSet'), '设为大管家（我主要和它说话）'); assert.equal(locale.format('zh', 'error.steward.joinSpace'), '大管家不能加入协作空间。先撤销大管家，再把这个会话加入空间。');
  assert.equal(locale.format('zh', 'steward.choose.inSpace', { space: '网站改版' }), '在协作空间「网站改版」里，先移出才能当大管家');
  assert.equal(locale.format('zh', 'steward.rowStatus', { name: 'A', status: '会话就绪' }), 'A · 会话就绪');
});
