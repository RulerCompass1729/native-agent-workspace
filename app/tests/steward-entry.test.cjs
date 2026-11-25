const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { uiError } = require('../ui-errors.cjs');
const { roomIds } = require('../collaboration-spaces.cjs');
const { StewardRole, DUTY_MAX, validDuty } = require('../steward-role.cjs');
const { StewardStanding } = require('../steward-standing.cjs');
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
  const handlers = new Map(), broadcasts = [], memberships = [], submitted = [], queued = [], wakeOff = [];
  // The real membership function is not under test here: only whether it is reached.
  const roomState = { apply: snapshot => room.apply(snapshot), metadata() {}, serial: action => action(), membership: async (_client, id, join, _label, space) => { memberships.push([id, join, space ?? null]); } };
  const context = vm.createContext({ applicationHandlers: handlers, backgroundOperation, uiError, roomIds, stewardRole: role, stewardOf: require('../steward-record.cjs').cachedSteward(role), roomState, landingOwner, validRoomId: id => typeof id === 'string' && id.length > 0,
    queueDispatcher: null, sessionLabels: { labels: new Map() }, ipcMain: { handle() {} }, broadcastRoom: async () => { broadcasts.push(role.selected); },
    // Waking the butler on events (steward-wake.cjs): only whether the designation turns it off, and when.
    stewardWake: { set: on => { wakeOff.push([on, role.selected]); } },
    // The person's permission to organize, real over the same directory: which designation it is for.
    stewardStanding: new StewardStanding(directory, { role, person: c => c === person }),
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
  vm.runInContext(cut("  register('steward', async (c, id, duty = null, standing = null) => {", "  register('stewardEvents', async (c, position = null) => {"), context);
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
  return { directory, role, handlers, broadcasts, memberships, submitted, queued, wakeOff, client, sessions, person, agent, context, file: path.join(directory, 'steward.json'), call: (...args) => handlers.get('steward')(person, ...args) };
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

test('designating or revoking the butler, the same session again included, turns waking on events off once it is written', async t => {
  const f = fixture(t), OUTSIDE = { sessionId: 'outside', nativeId: 'native-outside' };
  await f.call('outside'); await f.call(null); await f.call('outside');
  // Each after the designation it follows is saved: a switch kept for an earlier designation does not come back on.
  assert.deepEqual(f.wakeOff, [[false, OUTSIDE], [false, null], [false, OUTSIDE]]);
  // A refused designation changes nothing, the switch included.
  await assert.rejects(f.call('member'), key('error.steward.inSpace'));
  assert.equal(f.wakeOff.length, 3);
  // A switch that cannot be saved does not undo the designation.
  f.context.stewardWake = { set() { throw Error('The steward wake state cannot be saved'); } };
  await f.call('other');
  assert.deepEqual(f.role.selected, { sessionId: 'other', nativeId: 'native-other' });
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
  // Each language's default leaves room for the person to add to it in the dialog: a quarter of the limit at least.
  for (const language of ['zh', 'en']) {
    const standard = locale.format(language, 'steward.duty.default'), bytes = Buffer.byteLength(JSON.stringify(standard));
    assert.ok(validDuty(standard) && bytes <= DUTY_MAX * 0.75, `${language}: ${bytes} of ${DUTY_MAX} bytes`);
  }
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
  assert.ok(source.includes("steward, ...(context?.background ? {} : { stewardDuty, vendorIcons: localVendorIcons() }), "));
  // The start of the app names the window that lands: the first one restored, or the one opened when none is.
  assert.match(source, /const restore = views\.filter\(v => v\.active\);\n[^\n]*\n[^\n]*\n  landingOwner = restore\.length > 1 \? null : \(restore\[0\] \|\| views\.at\(-1\)\)\?\.owner \|\| null;\n/);
  // The rule itself, as written: one restored window lands, the last view when none was open, and none of several.
  const rule = (views, restore) => vm.runInNewContext(source.match(/landingOwner = (restore\.length > 1 [^;]*);/)[1], { views, restore });
  const A = { owner: 'a' }, B = { owner: 'b' };
  assert.deepEqual([rule([A, B], [A]), rule([A, B], []), rule([], []), rule([A, B], [A, B])], ['a', 'b', null, null]);
  // Both calls are answered by this desktop, with or without a backend that supports background control.
  assert.match(source, /name === 'handoff' \|\| name === 'steward' \|\| /); assert.match(source, /'chooseFolder', 'copy', 'landing', /);
  const preload = fs.readFileSync(path.join(__dirname, '../preload.cjs'), 'utf8');
  assert.match(preload, /'runtimeLocation', 'retrySave', 'steward', 'stewardRecord', 'stewardStanding', 'stewardWake', 'stewardPatrol', 'landing'\]\) \{/);
  assert.equal(source.match(/stewardRole\.set\(/g).length, 2, 'Only the entry writes the designation');
  // Step 2, batch 2: every join meets one guard (a session NAW opened for a space, a rotation's successor included),
  // and the designation is made in the same queue the joins run in.
  assert.match(source, /roomState = new RoomState\(dataDir\);\n[^\n]*\n  roomState\.joinGuard = id => keepStewardOutside\(id, true\);/);
  assert.match(source, /else await roomState\.serial\(async \(\) => \{\n[^]*?stewardRole\.set\(\{ sessionId: record\.id, nativeId: record\.nativeId \}, duty\);\n[^\n]*\n[^\n]*carry\(keep\)[^\n]*\n[^\n]*\n[^\n]*standingLost = [^\n]*\n    \}\);/);
  for (const file of fs.readdirSync(path.join(__dirname, '..')).filter(name => /\.c?js$/.test(name) && !['main.cjs', 'steward-role.cjs', 'session-wake.cjs'].includes(name))) {
    assert.ok(!/stewardRole|StewardRole|steward\.json/.test(fs.readFileSync(path.join(__dirname, '..', file), 'utf8')), file);
  }
  // The wake proposal, item 2: session-wake.cjs reads the designation as it is now, and only reads it.
  const wake = fs.readFileSync(path.join(__dirname, '../session-wake.cjs'), 'utf8');
  assert.equal(wake.match(/StewardRole/g).length, 1);
  assert.ok(wake.includes("new (require('./steward-role.cjs').StewardRole)(root(w)).current();"));
  // Runtime input counters may use their own WeakMap; designation writes remain forbidden.
  assert.match(wake, /const inputChanges = new WeakMap\(\);/); assert.match(wake, /const causes = new WeakMap\(\);/);
  assert.equal(/stewardRole|steward\.json|\.set\(/.test(wake.replace(/\b(inputChanges|causes)\.set\(/g, '(')), false);
  // The record module shares nothing writable with the other two roles.
  const own = fs.readFileSync(path.join(__dirname, '../steward-role.cjs'), 'utf8');
  assert.equal(/integrator\.json|queue-secretary\.json|butler\.json/.test(own), false); assert.ok(own.includes("path.join(directory, 'steward.json')"));
  // Designating writes the record (and, when the person was asked, the permission's), and tells the windows; no more.
  const handler = cut("  register('steward', async (c, id, duty = null, standing = null) => {", "  register('stewardEvents', async (c, position = null) => {");
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
    'menu.stewardRecord', 'error.steward.recordUnavailable', 'error.steward.designationUnreadable', 'error.stewardRecord.personOnly', 'error.stewardRecord.unavailable', 'records.name.steward', 'records.item.stewardUnavailable', 'records.item.stewardUnavailableOther',
    // The wake proposal, item 2: the butler's extra messages of a turn are withdrawn when the role ends first.
    'notice.wake.stewardEnded',
    // The events the butler reads; their refusals are checked in steward-events.test.cjs.
    'error.steward.eventsButlerOnly', 'error.steward.eventsPosition', 'error.steward.eventsUnavailable',
    // Waking the butler on events; its refusals are checked in steward-wake.test.cjs.
    'error.steward.wakeOnly', 'error.steward.wakeInvalid', 'error.steward.wakeNoButler', 'error.steward.wakeUnavailable',
    // Patrol while idle (R120); checked in steward-wake.test.cjs.
    'error.steward.patrolInvalid', 'error.steward.patrolWakeOff', 'reading.stewardPatrol',
    // The sender of a wake in the butler's conversation; checked in steward-wake.test.cjs.
    'reading.stewardWake', 'stewardWake.openRecord', 'stewardWake.stalled',
    // The butler's own handoff holding its wakes (R117); checked in steward-own-handoff.test.cjs.
    // The banner's own step for it and the undelivered count (R129); checked in steward-wake-banner-step.test.cjs.
    'stewardWake.ownHandoffButton.release', 'stewardWake.ownHandoffButton.update-backend', 'stewardWake.withUndelivered',
    // The wake chip in the header (11-22): its short text and the detail it opens.
    'stewardWake.chip', 'stewardWake.chipDetail', 'distribution.stewardMember',
    ...require('../steward-wake.cjs').BLOCK_REASONS.map(reason => `stewardWake.reason.${reason}`)];
  for (const language of ['zh', 'en']) assert.deepEqual(Object.keys(messages[language]).filter(name => /steward/i.test(name) && !name.startsWith('stewardRecord.')).sort(), [...keys].sort(), language);
  for (const name of keys) assert.equal(/[一-鿿]/.test(messages.en[name]), false, name);
  // What it gives and the one thing it takes away: the person is told both before they confirm.
  assert.equal(locale.format('zh', 'steward.choose.intro'), '你主要和它说话。它固定在侧栏最上面，不再列在「会话」里。指定之后，它能看所有协作空间里的内容（消息、便签、事件、文件、图片、队列），它看到的内容会交给它所用的模型服务；它能经 NAW 往队列里加事、取消和标为已处理，每一步记在「大管家的记录」里；它一回合能给最多 4 个不同的会话各发一条自动消息（其他会话一回合一条）。当大管家期间它不能加入协作空间。只有你能指定、更换或撤销。');
  assert.equal(locale.format('en', 'steward.choose.intro'), 'You mainly talk to it. It stays at the top of the sidebar and is no longer listed under Sessions. Once designated it can see what every collaboration space holds (messages, notes, events, files, images, queues), and what it sees goes to the model service it runs on; it can add, cancel and mark handled queue items through NAW, each step in the butler’s record; in one turn it can send one automatic message each to up to four different sessions (any other session sends one). While it is the butler it cannot join a collaboration space. Only you can designate, change or revoke it.');
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

// R220 (the person, 2026-11-24): 「要跟着新大管家走啊,否则大管家干啥」. The permission to organize was on for a butler whose
// replacement was kept (no done edge), the person designated the next one by hand, and it stayed with the old one.
const OUTSIDE = { sessionId: 'outside', nativeId: 'native-outside' }, OTHER = { sessionId: 'other', nativeId: 'native-other' };
function standing(f) {
  const value = f.context.stewardStanding, read = () => JSON.parse(fs.readFileSync(path.join(f.directory, 'steward-standing.json'), 'utf8'));
  return { value, read, on: () => value.view().on, turn: on => value.set(f.person, on) };
}

test('designating another butler by hand: the permission goes to it when the person leaves it on, and to nobody when they were not asked', async t => {
  const f = fixture(t), s = standing(f);
  await f.call('outside'); s.turn(true); assert.equal(s.on(), true);
  fs.writeFileSync(path.join(f.directory, 'rotation-log.jsonl'), edge('kept', OUTSIDE, OTHER) + '\n', { mode: 0o600 });
  const result = await f.call('other', null, true);
  assert.equal(Object.hasOwn(result, 'standingLost'), false);
  assert.deepEqual(s.read().designation, OTHER); assert.deepEqual(s.value.view(), { on: true, limit: 30, unavailable: false });
  // The person's way back: the previous one does not have it.
  assert.equal(s.value.take({ id: 'outside', nativeId: 'native-outside' }, { method: 'archiveRoom', arguments: ['shared'], operation_id: 'old' }, { sessions: f.sessions, rooms: [] }, 'shared'), null);
  // A caller that does not ask leaves it where it was, as before.
  const g = fixture(t), kept = standing(g);
  await g.call('outside'); kept.turn(true); await g.call('other');
  assert.deepEqual([kept.read().designation, kept.read().on, kept.on(), kept.value.view().reason], [OUTSIDE, true, false, 'other-designation']);
  for (const odd of ['true', 1, {}]) { await g.call('outside'); await g.call('other', null, odd); assert.deepEqual(kept.read().designation, OUTSIDE, String(odd)); }
});

test('the person takes it back while designating: it is off, for the previous butler too', async t => {
  const f = fixture(t), s = standing(f);
  await f.call('outside'); s.turn(true); const before = s.read().revision;
  await f.call('other', null, false);
  assert.deepEqual([s.read().on, s.on(), s.value.view().reason, s.read().revision], [false, false, undefined, before + 1]);
  await f.call('outside'); assert.equal(s.on(), false, 'designated again, it is not on by itself');
});

test('not on for the butler being replaced: leaving the line on turns nothing on', async t => {
  // Never turned on; on only for an earlier designation; turned off; nobody designated; unreadable.
  const never = fixture(t); await never.call('outside'); await never.call('other', null, true);
  assert.equal(fs.existsSync(path.join(never.directory, 'steward-standing.json')), false);
  const earlier = fixture(t), e = standing(earlier); await earlier.call('outside'); e.turn(true); await earlier.call('other'); await earlier.call('busy-codex', null, true);
  assert.deepEqual([e.read().designation, e.on()], [OUTSIDE, false]);
  const off = fixture(t), o = standing(off); await off.call('outside'); o.turn(true); o.turn(false); await off.call('other', null, true); assert.equal(o.on(), false);
  const revoked = fixture(t), r = standing(revoked); await revoked.call('outside'); r.turn(true); await revoked.call(null); await revoked.call('other', null, true); assert.equal(r.on(), false);
  const broken = fixture(t), b = standing(broken); await broken.call('outside'); b.turn(true); fs.writeFileSync(path.join(broken.directory, 'steward-standing.json'), '{', { mode: 0o600 });
  await broken.call('other', null, true); assert.equal(b.value.view().unavailable, true); assert.equal(fs.readFileSync(path.join(broken.directory, 'steward-standing.json'), 'utf8'), '{');
});

test('the same butler again keeps it, also when the rotation log had made it the butler; a refused designation moves nothing', async t => {
  const f = fixture(t), s = standing(f);
  await f.call('outside'); s.turn(true); const same = s.read().revision;
  await f.call('outside'); assert.deepEqual([s.on(), s.read().revision], [true, same], 'nothing written');
  fs.writeFileSync(path.join(f.directory, 'rotation-log.jsonl'), edge('done', OUTSIDE, OTHER) + '\n', { mode: 0o600 });
  assert.equal(s.on(), true, 'the successor has it');
  const write = s.value.write; s.value.write = () => { throw Error('synthetic'); };
  assert.deepEqual([(await f.call('other')).standingLost, s.on()], [true, false], 'not asked, had it, and it could not be kept: said');
  s.value.write = write; f.role.set(OUTSIDE); assert.equal(s.on(), true);
  await f.call('other'); assert.deepEqual([s.read().designation, s.on()], [OTHER, true], 'the duty statement sent again does not take it away');
  for (const id of ['member', 'ended', 'missing']) await assert.rejects(f.call(id, null, true));
  assert.deepEqual([s.read().designation, s.on()], [OTHER, true]);
  // Only the session the log named, native session included, is the same one.
  for (const odd of [{ nativeId: 'native-elsewhere' }, { sessionId: 'elsewhere' }]) {
    const g = fixture(t), other = standing(g); await g.call('outside'); other.turn(true);
    fs.writeFileSync(path.join(g.directory, 'rotation-log.jsonl'), edge('done', OUTSIDE, { ...OTHER, ...odd }) + '\n', { mode: 0o600 });
    await g.call('other'); assert.deepEqual([other.read().designation, other.on()], [OUTSIDE, false], JSON.stringify(odd));
  }
});

test('an agent cannot carry it, and a permission that cannot be saved is said while the designation stands', async t => {
  const f = fixture(t), s = standing(f);
  await f.call('outside'); s.turn(true);
  await assert.rejects(f.agent('other')('steward', ['other', null, true]));
  assert.deepEqual([f.role.selected, s.read().designation], [OUTSIDE, OUTSIDE]);
  // The window the call came from is no longer the person's: the designation is as it was before this change, nothing is carried.
  f.context.stewardStanding.person = () => false;
  await f.call('other', null, true); assert.deepEqual([f.role.selected, s.read().designation], [OTHER, OUTSIDE]);
  f.context.stewardStanding.person = c => c === f.person;
  await f.call('outside'); assert.equal(s.on(), true);
  f.context.stewardStanding.write = () => { throw Error('synthetic'); };
  const lost = await f.call('other', null, true);
  assert.deepEqual([lost.standingLost, lost.duty.state, f.role.selected, s.on()], [true, 'queued', OTHER, false]);
  await f.call('outside');
  f.context.refuseSubmit = Object.assign(Error('x'), { uiMessage: { key: 'error.steward.dutyBusy' } });
  const both = await f.call('other', null, true); assert.deepEqual([both.standingLost, both.duty.state], [true, 'not-sent']);
  await f.call('outside'); const left = await f.call('other', null, false); assert.deepEqual([left.standingLost, s.on(), s.read().on], [true, false, true], 'taken back but not saved: said, since the previous one would have it again');
  // A save that failed after it took place: the permission is on, so nothing is said to be lost.
  const late = fixture(t), l = standing(late); await late.call('outside'); l.turn(true); const write = l.value.write;
  l.value.write = function (next) { write.call(this, next); throw Error('synthetic'); };
  assert.equal(Object.hasOwn(await late.call('other', null, true), 'standingLost'), false); assert.equal(l.on(), true);
  assert.equal((await late.call('outside', null, false)).standingLost, true);
  // Turned off elsewhere while the dialog was open: nothing is carried, and that is said; not asked, nothing is said.
  const g = fixture(t), off = standing(g); await g.call('outside'); off.turn(true); off.turn(false);
  assert.equal((await g.call('other', null, true)).standingLost, true); assert.equal(off.on(), false);
  for (const value of [false, null]) { await g.call('outside'); assert.equal(Object.hasOwn(await g.call('other', null, value), 'standingLost'), false); }
});
