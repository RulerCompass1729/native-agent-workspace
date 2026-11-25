const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { BackgroundControl } = require('../background-control.cjs');
const { StewardStanding } = require('../steward-standing.cjs');
const { StewardRole } = require('../steward-role.cjs');
const { RoomState } = require('../room-state.cjs');
const { uiError } = require('../ui-errors.cjs');
const locale = require('../ui-locale.js');

// R118 (PM brief 2026-11-23): the standing permission stays with the butler it was turned on for. After the person
// designates another butler, the switch says why it reads off, and a card the butler gets instead carries a code only.
// Synthetic sessions only.
const OLD = { id: 'butler-old', nativeId: 'native-old', provider: 'claude', name: 'Synthetic old butler' };
const NEW = { id: 'butler-new', nativeId: 'native-new', provider: 'claude', name: 'Synthetic new butler' };
const MEMBER = { id: 'member', nativeId: 'native-member', provider: 'claude', name: 'Synthetic member' };
const CODE = 'standing-other-designation';
const as = actor => ({ sessionId: actor.id, nativeId: actor.nativeId });

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-standing-follow-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const human = {}, role = new StewardRole(dir);
  const policy = new StewardStanding(dir, { role, person: context => context === human });
  const state = { sessions: [{ ...OLD, roomId: null }, { ...NEW, roomId: null }, { ...MEMBER, roomId: 'shared', roomIds: ['shared'] }],
    rooms: [{ id: 'shared', name: 'Synthetic space', memberOrder: ['member'] }] };
  // Turned on for the old butler, then the person designates the new one.
  role.set(as(OLD)); policy.set(human, true); role.set(as(NEW));
  return { dir, human, role, policy, state };
}
const order = id => ({ method: 'spaceAction', arguments: ['shared', 'memberOrder', ['member']], operation_id: id });

test('a permission turned on for the previous butler reads off with its reason', t => {
  const f = fixture(t);
  assert.deepEqual(f.policy.view(), { on: false, limit: 30, unavailable: false, reason: 'other-designation' });
  assert.equal(f.policy.take(NEW, order('first'), f.state, 'shared'), null, 'still not for the new butler');
});

test('turned off, never turned on, or unreadable: no reason', t => {
  const f = fixture(t);
  f.policy.set(f.human, false);
  assert.deepEqual(f.policy.view(), { on: false, limit: 30, unavailable: false });
  const fresh = new StewardStanding(fs.mkdtempSync(path.join(f.dir, 'none-')), { role: f.role, person: () => true });
  assert.deepEqual(fresh.view(), { on: false, limit: 30, unavailable: false });
  fs.writeFileSync(f.policy.file, '{', { mode: 0o600 });
  assert.deepEqual(f.policy.view(), { on: false, limit: 30, unavailable: true });
});

test('the person revokes the butler: nobody to turn it on for, so no reason and no code', t => {
  const f = fixture(t);
  f.role.set(null);
  assert.deepEqual(f.policy.view(), { on: false, limit: 30, unavailable: false });
  assert.equal(f.policy.fallback(NEW, order('revoked'), f.state, 'shared'), null);
});

test('the person turns it on again: it is for the current butler, which may order members directly', t => {
  const f = fixture(t);
  assert.deepEqual(f.policy.set(f.human, true), { on: true, limit: 30, unavailable: false });
  assert.deepEqual(f.policy.read().designation, as(NEW));
  const grant = f.policy.take(NEW, order('again'), f.state, 'shared');
  assert.equal(grant?.action, 'memberOrder');
  assert.equal(f.policy.take(OLD, order('old'), f.state, 'shared'), null, 'not for the previous butler');
  assert.equal(f.policy.fallback(NEW, order('again'), f.state, 'shared'), null);
});

test('a rotation keeps the designation: the successor keeps the permission and gets no fallback', t => {
  const f = fixture(t);
  f.policy.set(f.human, true);
  const next = { id: 'butler-next', nativeId: 'native-next', provider: 'claude', name: 'Synthetic successor' };
  fs.writeFileSync(path.join(f.dir, 'rotation-log.jsonl'), JSON.stringify({ event: 'done', old: { id: NEW.id, nativeId: NEW.nativeId }, new: { id: next.id, nativeId: next.nativeId } }) + '\n', { mode: 0o600 });
  const state = { ...f.state, sessions: [...f.state.sessions, { ...next, roomId: null }] };
  assert.deepEqual(f.role.selected, as(NEW), 'the person\'s designation is unchanged');
  assert.deepEqual(f.policy.view(), { on: true, limit: 30, unavailable: false });
  assert.equal(f.policy.take(next, order('rotated'), state, 'shared')?.action, 'memberOrder');
  assert.equal(f.policy.fallback(next, order('rotated'), f.state, 'shared'), null);
});

test('the fallback code: only the current butler, only a covered local action, only while it is on for another', t => {
  const f = fixture(t);
  assert.equal(f.policy.fallback(NEW, order('a'), f.state, 'shared'), CODE);
  assert.equal(f.policy.fallback(OLD, order('b'), f.state, 'shared'), null, 'the previous butler is no longer the butler');
  assert.equal(f.policy.fallback(MEMBER, order('c'), f.state, 'shared'), null);
  assert.equal(f.policy.fallback({ ...NEW, nativeId: 'native-other' }, order('d'), f.state, 'shared'), null);
  for (const method of ['initial', 'openLocalFile', 'interrupt', 'input', 'spaceMerge'])
    assert.equal(f.policy.fallback(NEW, { method, arguments: [], operation_id: method }, f.state, 'shared'), null, method);
  // Turning it on again would not cover these either, so the card does not say it would (review round 1, finding 1).
  const create = { method: 'create', arguments: [{ provider: 'codex', cwd: f.dir, name: 'Synthetic' }], operation_id: 'create' };
  assert.equal(f.policy.fallback(NEW, create, f.state, 'shared'), null, 'a creation the permission never covers');
  const inSpace = { ...f.state, sessions: f.state.sessions.map(x => x.id === NEW.id ? { ...x, roomId: 'shared', roomIds: ['shared'] } : x) };
  assert.equal(f.policy.fallback(NEW, order('g'), inSpace, 'shared'), null, 'the butler in a space');
  const archived = { ...f.state, sessions: f.state.sessions.map(x => x.id === NEW.id ? { ...x, archived: true } : x) };
  assert.equal(f.policy.fallback(NEW, order('h'), archived, 'shared'), null, 'the butler archived');
  const kept = f.policy.read(), now = Date.now();
  f.policy.write({ ...kept, used: Array.from({ length: 30 }, (_, i) => ({ at: now - i, id: 'slot-' + i })) });
  assert.equal(f.policy.fallback(NEW, order('i'), f.state, 'shared'), null, 'the hourly limit is used up');
  f.policy.write({ ...kept, used: Array.from({ length: 30 }, (_, i) => ({ at: now - 3600001 - i, id: 'old-' + i })) });
  assert.equal(f.policy.fallback(NEW, order('j'), f.state, 'shared'), CODE, 'slots older than an hour do not count');
  f.policy.write(kept);
  f.policy.set(f.human, false);
  assert.equal(f.policy.fallback(NEW, order('e'), f.state, 'shared'), null, 'off: nothing to explain');
  fs.writeFileSync(f.policy.file, '{', { mode: 0o600 });
  assert.equal(f.policy.fallback(NEW, order('f'), f.state, 'shared'), null, 'unreadable: no claim');
});

test('carried to the next designation only by the person, only while it is on, and once', t => {
  const f = fixture(t);
  assert.equal(f.policy.carry(f.human), null, 'on for an earlier designation is not on');
  f.policy.set(f.human, true);
  assert.equal(f.policy.carry({}), null, 'not the person');
  const carry = f.policy.carry(f.human), used = [{ at: 1, id: 'slot' }];
  f.policy.write({ ...f.policy.read(), used });
  f.role.set(as(OLD));
  carry(true);
  assert.deepEqual([f.policy.read().designation, f.policy.view().on, f.policy.read().used], [as(OLD), true, used], 'the hourly limit goes with it');
  const revision = f.policy.read().revision; carry(true); assert.equal(f.policy.read().revision, revision);
  // Turned off in another window meanwhile: not turned on again.
  const stale = f.policy.carry(f.human); f.policy.set(f.human, false); f.role.set(as(NEW)); stale(true);
  assert.equal(f.policy.view().on, false); assert.equal(f.policy.read().on, false);
});

function control(t, f, standingFallback) {
  const rooms = new RoomState(f.dir), effects = [], handlers = new Map([['join', () => { effects.push('join'); return 'target'; }]]);
  const context = { background: true, view: {}, fingerprint: () => ({ sessions: [NEW], auditRooms: ['shared'] }), checkActor: async () => {},
    client: { snapshot: () => f.state, close() {} }, win: { destroy() {} } };
  const controller = new BackgroundControl({ dataDir: f.dir, handlers, context: () => context,
    standing: (actor, command) => f.policy.take(actor, command, f.state, 'shared'),
    standingValid: (actor, command, _c, grant) => f.policy.valid(actor, command, f.state, 'shared', grant),
    ...(standingFallback === undefined ? {} : { standingFallback }),
    confirmation: () => ({ message: 'Confirm', detail: 'Synthetic detail', buttons: ['Cancel', 'Confirm'], cancelId: 0 }),
    audit: row => rooms.recordControlOperation(row) });
  t.after(() => controller.close());
  const ask = (id, actor = NEW) => controller.call({ sender: actor, identity: { callId: id, turnId: 'turn' }, valid: () => true },
    { action: 'invoke', method: 'join', arguments: ['target', true], operation_id: id });
  return { controller, effects, ask };
}

test('a card in place of the permission carries the code to the butler and to the card, and nothing else', async t => {
  const f = fixture(t);
  const plain = control(t, f, () => null);
  const without = await plain.ask('without-code');
  const c = control(t, f, (actor, command) => f.policy.fallback(actor, command, f.state, 'shared'));
  const result = await c.ask('with-code');
  assert.equal(result.state, 'confirmation-required');
  assert.equal(result.standingFallback, CODE);
  assert.deepEqual(Object.keys(result).filter(key => !Object.hasOwn(without, key)), ['standingFallback'], 'one field more than a card without it');
  assert.deepEqual(c.effects, [], 'still waits for the person');
  const card = c.controller.rows(NEW.id).find(row => row.backgroundOperation.id === 'with-code').backgroundOperation;
  assert.equal(card.standingFallback, CODE);
  assert.equal(plain.controller.rows(NEW.id).find(row => row.backgroundOperation.id === 'without-code').backgroundOperation.standingFallback, undefined);
  // Once the person answers, the question it explained is closed (review round 1, finding 3).
  const answered = await c.controller.decide(NEW.id, NEW.nativeId, 'with-code', 1);
  assert.equal(answered.state, 'complete', JSON.stringify(answered));
  assert.deepEqual(c.effects, ['join']);
  assert.equal(Object.hasOwn(answered, 'standingFallback'), false, 'not in the result the butler reads');
  assert.equal(Object.hasOwn(c.controller.rows(NEW.id).find(row => row.backgroundOperation.id === 'with-code').backgroundOperation, 'standingFallback'), false);
});

test('only the known code is recorded: other values or a failing hook leave the card as it was', async t => {
  const f = fixture(t);
  for (const [i, hook] of [() => 'SECRET body text', () => ({ code: CODE }), () => { throw Error('SECRET hook failure'); }, () => undefined].entries()) {
    const c = control(t, f, hook);
    const result = await c.ask(`other-${i}`);
    assert.equal(result.state, 'confirmation-required');
    assert.equal(Object.hasOwn(result, 'standingFallback'), false, String(i));
    assert.doesNotMatch(JSON.stringify(result), /SECRET/u);
  }
  const absent = control(t, f, undefined);
  assert.equal(Object.hasOwn(await absent.ask('no-hook'), 'standingFallback'), false, 'without the hook: as before');
});

test('the permission applies: no card and no code', async t => {
  const f = fixture(t);
  f.policy.set(f.human, true);
  f.state.sessions.find(s => s.id === NEW.id).roomId = null;
  const c = control(t, f, (actor, command) => f.policy.fallback(actor, command, f.state, 'shared'));
  const result = await c.ask('direct');
  assert.equal(result.state, 'complete');
  assert.equal(result.approvedBy, 'standing');
  assert.equal(Object.hasOwn(result, 'standingFallback'), false);
});

test('the switch stays the person\'s: a background or member call cannot turn it on', async t => {
  const f = fixture(t);
  for (const context of [{ background: true }, {}]) assert.throws(() => f.policy.set(context, true), /person window/u);
  assert.equal(f.policy.read().designation.sessionId, OLD.id, 'unchanged');
  const source = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8');
  const start = source.indexOf("  register('stewardStanding'"), end = source.indexOf("  applicationHandlers.delete('stewardStanding');", start);
  assert.ok(start > 0 && end > start, 'the handler is followed by its removal from background calls');
  let registered, calls = 0, told = 0;
  vm.runInContext(source.slice(start, end), vm.createContext({ register: (_name, fn) => { registered = fn; },
    isCurrentHumanContext: c => !c.background, uiError, broadcastRoom: async () => { told++; }, stewardStanding: { view: () => ({}), set: () => { calls++; } } }));
  await assert.rejects(registered({ background: true }, true), error => error?.uiMessage?.key === 'error.steward.personOnly');
  assert.equal(calls, 0);
  // Reading it (the designation dialog does, each time it opens) tells no window; setting it tells every one.
  await registered({}); assert.deepEqual([calls, told], [0, 0]);
  await registered({}, false); assert.deepEqual([calls, told], [1, 1]);
});

test('main passes the fallback hook; the card and the switch have their words in both languages', () => {
  const main = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8');
  assert.match(main, /standingFallback: \(actor, command, context\) => stewardStanding\.fallback\(actor, command,\s+sessionLabels\.apply\(roomState\.apply\(context\.client\.snapshot\(\)\)\), context\.view\.spaceId \|\| 'shared'\)/u);
  const renderer = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
  assert.match(renderer, /card && !op\.replacedBy && !op\.disposition && op\.standingFallback === 'standing-other-designation'/u);
  for (const language of ['zh', 'en']) for (const key of ['standing.offOther', 'background.card.standingOtherDesignation']) {
    const words = locale.format(language, key);
    assert.ok(words && words !== key, `${language} ${key}`);
  }
});

test('the record dialog shows the reason beside the switch, in either language', async () => {
  const { bind } = require('../renderer/steward-record.js');
  function element(tag) {
    return { tag, children: [], className: '', textContent: '', dataset: {}, open: false, inserted: [],
      append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; },
      setAttribute() {}, addEventListener() {}, showModal() { this.open = true; }, close() { this.open = false; },
      querySelector(selector) { return this.children.find(child => child.tag === selector) || null; },
      after(node) { this.inserted.push(node); } };
  }
  const all = node => [node, ...node.children.flatMap(all)];
  for (const language of ['zh', 'en']) for (const [value, key] of [[{ on: false, limit: 30, unavailable: false, reason: 'other-designation' }, 'standing.offOther'],
    [{ on: false, limit: 30, unavailable: false }, 'standing.off'], [{ on: true, limit: 30, unavailable: false }, 'standing.on']]) {
    const dialog = element('dialog');
    const screen = bind({ dialog, document: { createElement: element }, text: (k, params) => locale.format(language, k, params),
      api: { stewardRecord: async () => ({ at: 1, current: { name: 'Synthetic new butler' }, entries: [], total: 0 }), stewardStanding: async () => value } });
    await screen.open();
    await new Promise(resolve => setImmediate(resolve));
    const box = dialog.querySelector('h2').inserted[0];
    const status = all(box).find(node => node.tag === 'p' && node.textContent === locale.format(language, key));
    assert.ok(status, `${language} ${key}`);
    assert.equal(all(box).find(node => node.tag === 'input').checked, value.on);
  }
});
