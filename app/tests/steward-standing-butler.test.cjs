const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const background = require('../background-control.cjs'), { BackgroundControl } = background;
const { StewardStanding } = require('../steward-standing.cjs');
const { StewardRole } = require('../steward-role.cjs');
const { StewardRecord, cachedSteward, view: recordView, check } = require('../steward-record.cjs');
const backgroundOperation = require('../background-operation.cjs');
const reminders = require('../record-reminders.cjs');
const { roomIds } = require('../collaboration-spaces.cjs');
const { uiError } = require('../ui-errors.cjs');
const locale = require('../ui-locale.js');

// R234 (the person, 2026-11-25: 「允许大管家直接整理本机工作」,这个应该大管家自己可以点): the butler turns the standing
// permission on and off itself; the person's off is only the person's to undo. Synthetic sessions only.
const source = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8');
const cut = (from, to) => { const start = source.indexOf(from), end = source.indexOf(to, start + from.length); assert.ok(start > 0 && end > start, from); return source.slice(start, end); };
const BUTLER = { id: 'butler', nativeId: 'native-butler' }, NEXT = { id: 'next', nativeId: 'native-next' }, OTHER = { id: 'other', nativeId: 'native-other' };
const as = actor => ({ sessionId: actor.id, nativeId: actor.nativeId });
const zh = (key, params) => locale.format('zh', key, params);
const order = id => ({ method: 'spaceAction', arguments: ['shared', 'memberOrder', ['member']], operation_id: id });

function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'naw-standing-butler-'))); fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = { dir, at: Date.parse('2026-11-25T18:48:00Z'), told: 0, rung: 0, calls: 0, file: path.join(dir, 'steward-standing.json') };
  const sessions = [BUTLER, NEXT, OTHER, { id: 'member', nativeId: 'native-member' }].map(s => ({ ...s, name: 'Synthetic ' + s.id, provider: 'claude', state: 'idle', roomIds: s.id === 'member' ? ['shared'] : [], roomId: null }));
  f.sessions = sessions; f.state = { sessions, rooms: [{ id: 'shared', name: 'Synthetic space', memberOrder: ['member'] }] };
  f.role = new StewardRole(dir); f.role.set(as(BUTLER));
  f.person = { win: {} };
  f.open = () => new StewardStanding(dir, { role: f.role, person: c => c === f.person, now: () => f.at });
  f.policy = f.open();
  f.record = new StewardRecord(dir, { steward: cachedSteward(f.role), selected: () => f.role.selected, now: () => f.at });
  const handlers = new Map();
  const client = { call: async () => ({ sessions }), entries: [], refresh: async () => {}, snapshot: () => f.state, close() {} };
  f.context = vm.createContext({ applicationHandlers: handlers, background, backgroundOperation, uiError, roomIds, stewardOf: cachedSteward(f.role), roomState: { apply: x => x }, sessionLabels: { labels: new Map() },
    ipcMain: { handle() {} }, displayText: key => key, stewardStanding: f.policy, stewardRecord: f.record, isCurrentHumanContext: c => c === f.person,
    recordsChanged: () => { f.rung++; }, broadcastRoom: async () => { f.told++; } });
  vm.runInContext(cut('function register(name, handler) {', 'async function replaceBackendSockets'), f.context);
  vm.runInContext(cut('async function stewardCaller(c) {', 'function conversationReaderAllowed(actor) {'), f.context);
  vm.runInContext(cut("  register('stewardStanding', async (c, ...args) => {", '  // Patrol while idle'), f.context);
  f.handlers = handlers;
  const controller = new BackgroundControl({ dataDir: dir, handlers, confirmation: () => ({ message: 'Confirm', detail: '', buttons: ['Cancel', 'Confirm'], cancelId: 0 }),
    context: actor => ({ background: true, actor, view: {}, client, win: { destroy() {} }, checkActor: async () => {}, fingerprint: () => ({ sessions: [], auditRooms: ['shared'] }) }) });
  t.after(() => controller.close()); f.controller = controller;
  f.binding = actor => ({ sender: { ...actor, provider: 'claude', name: 'Synthetic ' + actor.id }, identity: { callId: 'call-' + ++f.calls, turnId: 'turn' }, valid: () => true });
  // As main.cjs runs an agent's call: the butler's own is a step of its record first.
  f.agent = (actor, ...args) => { const call = { action: 'invoke', method: 'stewardStanding', arguments: args, operation_id: 'op-' + (f.calls + 1) }, binding = f.binding(actor);
    return f.record.around(binding.sender, call, () => controller.call(binding, call)); };
  f.window = (...args) => handlers.get('stewardStanding')(f.person, ...args);
  f.read = () => JSON.parse(fs.readFileSync(f.file, 'utf8'));
  f.shown = () => recordView(f.record, f.state, { current: as(BUTLER), now: f.at }).entries.filter(e => e.kind !== 'role');
  f.bell = () => reminders.status(dir, f.at, { standing: f.policy.switches() }).records.find(r => r.record === 'steward').items.filter(i => i.kind === 'standing');
  f.edge = (event, from, to) => fs.appendFileSync(path.join(dir, 'rotation-log.jsonl'), JSON.stringify({ event, old: from, new: to }) + '\n', { mode: 0o600 });
  return f;
}
// Refused before anything was written: not executed, with a code of its own, never an outcome left open.
const CODES = { standingOnly: 'standing-caller', standingInvalid: 'standing-invalid', standingPersonOff: 'standing-person-off', standingUnavailable: 'standing-unchanged', recordUnavailable: 'standing-unrecorded' };
const refused = (result, key) => {
  assert.deepEqual([result.state, result.reason, result.retry], ['not-executed', CODES[key.split('.').at(-1)], false], `${key}: ${JSON.stringify(result)}`);
  assert.equal(result.error, uiError(key).message);
};
// What each row of the butler's record says, newest first, in one language.
const rows = (f, language) => {
  const { bind } = require('../renderer/steward-record.js'), text = (key, params) => locale.format(language, key, params);
  const screen = bind({ dialog: new Element('dialog'), document: { createElement: tag => new Element(tag) }, text, api: {} });
  return f.shown().map(e => [text(...screen.what(e)), screen.result(e) ? text(...screen.result(e)) : null]);
};

test('the current butler turns it on and off itself, without a card: one step of its record and one line in the bell each time', async t => {
  const f = fixture(t);
  const on = await f.agent(BUTLER, true);
  assert.equal(on.state, 'complete', JSON.stringify(on));
  assert.deepEqual(on.value, { on: true, limit: 30, unavailable: false, by: 'butler', at: f.at, changed: true });
  assert.deepEqual(f.read().designation, as(BUTLER));
  assert.equal(f.policy.take(BUTLER, order('covered'), f.state, 'shared')?.action, 'memberOrder');
  assert.deepEqual([f.rung, f.told], [1, 1], 'the bell and the windows are told');
  f.at += 60000;
  const off = await f.agent(BUTLER, false);
  assert.deepEqual(off.value, { on: false, limit: 30, unavailable: false, by: 'butler', at: f.at, changed: true });
  assert.equal(f.policy.take(BUTLER, order('after'), f.state, 'shared'), null);
  assert.deepEqual(f.shown().map(e => [e.kind, e.method, e.standing, e.state]), [['invoke', 'stewardStanding', 'off', 'complete'], ['invoke', 'stewardStanding', 'on', 'complete']]);
  assert.deepEqual(f.bell().map(i => [i.by, i.on, i.at, i.shown]), [['butler', true, f.at - 60000, true], ['butler', false, f.at, true]]);
  assert.equal((await f.agent(BUTLER, true)).value.on, true, 'what it turned off it may turn on again');
  f.at += 1000;
  // Only looking, which a step of its record says too, switches nothing and rings nothing.
  const before = [f.rung, f.told, f.bell().length];
  assert.equal((await f.agent(BUTLER)).value.on, true);
  assert.deepEqual([f.rung, f.told, f.bell().length], before); assert.equal(f.shown()[0].standing, 'check');
});

test('turning it on again while it is on changes nothing: no new line in the bell, and an operation under way keeps its grant', async t => {
  const f = fixture(t);
  await f.window(true);
  const grant = f.policy.take(BUTLER, order('running'), f.state, 'shared'), kept = f.read();
  const again = await f.agent(BUTLER, true);
  assert.deepEqual(again.value, { on: true, limit: 30, unavailable: false, changed: false }, 'the person turned it on, and it still says so');
  assert.deepEqual([f.read(), f.bell().length], [kept, 1]);
  assert.equal(f.policy.valid(BUTLER, order('running'), f.state, 'shared', grant), true);
});

test('nobody else: another session, the previous butler, the butler in a space, archived or ended, a window that is not the person\'s', async t => {
  const f = fixture(t);
  refused(await f.agent(OTHER, true), 'error.steward.standingOnly');
  refused(await f.agent({ ...BUTLER, nativeId: 'native-elsewhere' }, true), 'error.steward.standingOnly');
  const own = f.sessions.find(s => s.id === 'butler');
  for (const change of [{ roomIds: ['shared'] }, { archived: true }, { state: 'ended' }, { nativeContextPending: true }]) {
    const kept = { ...own }; Object.assign(own, change);
    refused(await f.agent(BUTLER, true), 'error.steward.standingOnly');
    for (const key of Object.keys(own)) delete own[key]; Object.assign(own, kept);
  }
  f.role.set(as(NEXT));
  for (const on of [true, false]) refused(await f.agent(BUTLER, on), 'error.steward.standingOnly');
  f.role.set(null);
  refused(await f.agent(BUTLER, true), 'error.steward.standingOnly');
  await assert.rejects(f.handlers.get('stewardStanding')({ win: {} }, true), error => error?.uiMessage?.key === 'error.steward.standingOnly');
  assert.equal(fs.existsSync(f.file), false, 'nothing was written'); assert.deepEqual([f.bell(), f.rung, f.told], [[], 0, 0]);
});

test('once the person turned it off, the butler cannot turn it on again; the person can', async t => {
  const f = fixture(t);
  await f.agent(BUTLER, true);
  await f.window(false);
  const kept = f.read();
  const answer = await f.agent(BUTLER, true);
  refused(answer, 'error.steward.standingPersonOff');
  // Its own off over the person's off does not turn the person's off into its own.
  await f.agent(BUTLER, false);
  refused(await f.agent(BUTLER, true), 'error.steward.standingPersonOff');
  assert.deepEqual(f.read(), kept, 'not touched');
  // After a restart and for the butler that follows, all the same.
  f.context.stewardStanding = f.policy = f.open();
  refused(await f.agent(BUTLER, true), 'error.steward.standingPersonOff');
  f.edge('done', { id: BUTLER.id, nativeId: BUTLER.nativeId }, { id: NEXT.id, nativeId: NEXT.nativeId });
  refused(await f.agent(NEXT, true), 'error.steward.standingPersonOff');
  f.role.set(as(OTHER));
  refused(await f.agent(OTHER, true), 'error.steward.standingPersonOff');
  assert.deepEqual(f.read(), kept);
  assert.equal((await f.window(true)).on, true);
  assert.equal((await f.agent(OTHER, false)).value.on, false);
  assert.equal((await f.agent(OTHER, true)).value.on, true, 'its own off again');
});

test('a file from before: off without who turned it off counts as the person\'s; on for an earlier butler does not; no file is nobody\'s off', async t => {
  const f = fixture(t);
  const write = value => fs.writeFileSync(f.file, JSON.stringify({ version: 1, revision: 4, used: [], ...value }), { mode: 0o600 });
  write({ on: false, designation: as(BUTLER) });
  refused(await f.agent(BUTLER, true), 'error.steward.standingPersonOff');
  write({ on: false, designation: null, revision: 0 });
  refused(await f.agent(BUTLER, true), 'error.steward.standingPersonOff');
  // An earlier NAW knows nothing of who switched it: what the butler did before is not what that NAW wrote since.
  write({ on: false, designation: as(BUTLER), source: { by: 'butler', at: 1, revision: 3 } });
  refused(await f.agent(BUTLER, true), 'error.steward.standingPersonOff');
  for (const source of [{ by: 'other', at: 1, revision: 4 }, { by: 'butler', revision: 4 }, 'butler', { at: 1, revision: 4 }]) {
    write({ on: false, designation: as(BUTLER), source });
    refused(await f.agent(BUTLER, true), 'error.steward.standingPersonOff');
  }
  write({ on: false, designation: as(BUTLER), source: { by: 'butler', at: 1, revision: 4 } });
  assert.equal((await f.agent(BUTLER, true)).value.on, true);
  // The daily file on 2026-11-25: on, for the butler before the one designated now.
  write({ on: true, designation: as(OTHER) });
  assert.equal(f.policy.view().reason, 'other-designation');
  // On by the butler before: it reads off, and that is nobody's switch.
  write({ on: true, designation: as(OTHER), source: { by: 'butler', at: 1, revision: 4 } });
  assert.deepEqual(f.policy.view(), { on: false, limit: 30, unavailable: false, reason: 'other-designation' });
  write({ on: true, designation: as(OTHER) });
  assert.deepEqual((await f.agent(BUTLER, true)).value, { on: true, limit: 30, unavailable: false, by: 'butler', at: f.at, changed: true });
  assert.deepEqual(f.read().designation, as(BUTLER));
  fs.unlinkSync(f.file);
  // The policy checks who it is for itself too, whoever calls it.
  for (const actor of [NEXT, OTHER, { ...BUTLER, nativeId: 'native-elsewhere' }, null]) assert.throws(() => f.policy.setByButler(actor, true), /current butler/);
  assert.equal(fs.existsSync(f.file), false);
  assert.equal((await f.agent(BUTLER, true)).value.on, true);
  fs.writeFileSync(f.file, '{', { mode: 0o600 });
  refused(await f.agent(BUTLER, true), 'error.steward.standingUnavailable');
  assert.equal(fs.readFileSync(f.file, 'utf8'), '{', 'not written over');
});

test('turned on by the butler, it goes on working after an automatic handoff; the successor switches it, the old one no longer', async t => {
  const f = fixture(t);
  await f.agent(BUTLER, true); const kept = f.read();
  f.edge('done', { id: BUTLER.id, nativeId: BUTLER.nativeId }, { id: NEXT.id, nativeId: NEXT.nativeId });
  assert.deepEqual(f.read(), kept, 'the grant stays with the person\'s designation');
  assert.deepEqual(f.policy.view(), { on: true, limit: 30, unavailable: false, by: 'butler', at: f.at });
  assert.equal(f.policy.take(NEXT, order('rotated'), f.state, 'shared')?.action, 'memberOrder');
  assert.equal(f.policy.take(BUTLER, order('old'), f.state, 'shared'), null);
  refused(await f.agent(BUTLER, false), 'error.steward.standingOnly'); assert.equal(f.policy.view().on, true);
  assert.equal((await f.agent(NEXT, false)).value.on, false);
  assert.equal((await f.agent(NEXT, true)).value.on, true);
  assert.deepEqual(f.read().designation, as(BUTLER), 'written for the designation, not for the session of now');
});

test('the person designating another butler: left on it stays on, taken back is the person\'s off, not asked is not an off', async t => {
  const f = fixture(t);
  await f.agent(BUTLER, true);
  let carry = f.policy.carry(f.person); f.role.set(as(NEXT)); carry(true);
  assert.deepEqual(f.policy.view(), { on: true, limit: 30, unavailable: false, by: 'butler', at: f.at }, 'carried, and who turned it on with it');
  assert.equal(f.bell().length, 1, 'no switch');
  carry = f.policy.carry(f.person); f.role.set(as(OTHER)); carry(false);
  refused(await f.agent(OTHER, true), 'error.steward.standingPersonOff');
  assert.deepEqual(f.bell().map(i => [i.by, i.on]), [['butler', true], ['person', false]]);
  await f.window(true); f.role.set(as(BUTLER));
  assert.equal(f.policy.view().reason, 'other-designation');
  assert.equal((await f.agent(BUTLER, true)).value.on, true, 'off only because the designation moved');
  // Asked while it was on and taken back, but the butler turned it off meanwhile: the person's off all the same.
  await f.agent(BUTLER, false);
  assert.equal(f.policy.carry(f.person, true), null); assert.equal(f.policy.carry(f.person), null);
  carry = f.policy.carry(f.person, false); f.role.set(as(NEXT)); assert.equal(carry(false), true);
  refused(await f.agent(NEXT, true), 'error.steward.standingPersonOff');
  const kept = f.read(); assert.equal(f.policy.carry(f.person, false)(false), undefined); assert.deepEqual(f.read(), kept, 'already the person\'s off');
});

test('the person\'s switch is one line of the record and one of the bell, which does not count it', async t => {
  const f = fixture(t);
  await f.window(true); f.at += 1000; await f.window(false);
  assert.deepEqual(f.policy.view(), { on: false, limit: 30, unavailable: false });
  assert.deepEqual(f.shown().map(e => [e.kind, e.on]), [['standingSwitch', false], ['standingSwitch', true]]);
  assert.deepEqual(f.bell().map(i => [i.by, i.on, i.at, i.shown]), [['person', true, f.at - 1000, false], ['person', false, f.at, false]]);
  assert.equal(reminders.status(f.dir, f.at, { standing: f.policy.switches() }).count, 0);
  assert.deepEqual([f.rung, f.told], [2, 2]);
  // Reading it (the dialogs do) tells nobody; a value that is not a switch is refused.
  await f.window(); assert.deepEqual([f.rung, f.told], [2, 2]);
  await assert.rejects(f.window('on'), error => error?.uiMessage?.key === 'error.steward.standingInvalid');
  await assert.rejects(f.window(true, 'extra'), error => error?.uiMessage?.key === 'error.steward.standingInvalid');
  for (const args of [[1], [null], [true, 'extra'], [true, true]]) refused(await f.agent(BUTLER, ...args), 'error.steward.standingInvalid');
  assert.deepEqual([f.rung, f.told], [2, 2]); await f.window(undefined); // As the preload passes it on.
  // A line that cannot be written does not keep the person's switch from working.
  f.record.failed = true; assert.equal((await f.window(true)).on, true);
  check({ kind: 'standingSwitch', at: f.at, on: true }); check({ kind: 'standingSwitch', at: f.at, on: false });
  for (const line of [{ kind: 'standingSwitch', at: f.at }, { kind: 'standingSwitch', at: f.at, on: 'on' }, { kind: 'standingSwitch', at: f.at, on: true, by: 'agent' }]) assert.throws(() => check(line), /Invalid steward record line/);
});

test('without its step in the record the butler switches nothing, and a switch that cannot be saved changes nothing', async t => {
  const f = fixture(t), call = { action: 'invoke', method: 'stewardStanding', arguments: [true], operation_id: 'unrecorded' };
  refused(await f.controller.call(f.binding(BUTLER), call), 'error.steward.recordUnavailable');
  f.context.stewardRecord = null;
  refused(await f.controller.call(f.binding(BUTLER), { ...call, operation_id: 'no-record' }), 'error.steward.recordUnavailable');
  f.context.stewardRecord = f.record;
  f.policy.write = () => { throw Error('SECRET synthetic'); };
  refused(await f.agent(BUTLER, true), 'error.steward.standingUnavailable');
  assert.deepEqual([fs.existsSync(f.file), f.rung, f.told], [false, 0, 0]);
  delete f.policy.write; f.record.failed = true;
  await assert.rejects(f.agent(BUTLER, true), error => error?.uiMessage?.key === 'error.steward.recordUnavailable');
  assert.equal(fs.existsSync(f.file), false);
});

test('what the permission allows is as before: the hourly limit survives its switching, and it covers nothing more', async t => {
  const f = fixture(t);
  await f.agent(BUTLER, true);
  for (let n = 0; n < 30; n++) assert.ok(f.policy.take(BUTLER, order('n' + n), f.state, 'shared'));
  await f.agent(BUTLER, false); await f.agent(BUTLER, true);
  assert.equal(f.policy.take(BUTLER, order('over'), f.state, 'shared'), null);
  f.at += 3600001;
  for (const method of ['spaceMerge', 'quitService', 'saveLocalFile', 'input', 'interrupt', 'steward', 'backgroundDecision']) assert.equal(f.policy.take(BUTLER, { method, arguments: [], operation_id: method }, f.state, 'shared'), null, method);
  assert.equal(f.policy.take(BUTLER, { method: 'create', arguments: [{ provider: 'codex', cwd: f.dir }], operation_id: 'codex' }, f.state, 'shared'), null);
  assert.equal(f.policy.take(OTHER, order('other'), f.state, 'shared'), null);
  // The butler's method is for the one switch; designating and the record stay the person's.
  for (const name of ['steward', 'stewardRecord', 'records']) assert.equal(f.handlers.has(name), false, name);
  assert.match(source, /applicationHandlers\.delete\('stewardRecord'\);/); assert.match(source, /applicationHandlers\.delete\('records'\);/);
});

test('it is kept short: the last switches only, and old ones do not grow the file', async t => {
  const f = fixture(t);
  for (let n = 0; n < 40; n++) { f.at += 1000; assert.equal((await f.agent(BUTLER, n % 2 === 0)).state, 'complete'); }
  assert.deepEqual([f.read().switches.length, f.bell().length, f.bell().at(-1).at], [15, 15, f.at]);
  assert.ok(fs.statSync(f.file).size < 16384 / 4);
  // Read with care: rows that are not switches are left out.
  fs.writeFileSync(f.file, JSON.stringify({ ...f.read(), switches: [null, { by: 'x', on: true, at: 1, revision: 1 }, { by: 'butler', on: 1, at: 1, revision: 1 }, { by: 'person', on: true, at: 5, revision: 2 }] }));
  const left = [{ revision: 2, on: true, by: 'person', at: 5 }];
  assert.deepEqual(f.policy.switches(), { rows: left, known: true });
  fs.writeFileSync(f.file, '{'); assert.deepEqual(f.policy.switches(), { rows: left, known: false });
  assert.deepEqual(f.open().switches(), { rows: [], known: false });
  fs.unlinkSync(f.file); assert.deepEqual(f.open().switches(), { rows: [], known: true });
});

// The bell: the butler's switches wait for the person's 「知道了」; the person's own are listed under 「全部」 only.
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.attributes = {}; this.dataset = {}; this.hidden = false; this.disabled = false; this.textContent = ''; this.className = ''; this.open = false; }
  append(...values) { this.children.push(...values); } replaceChildren(...values) { this.children = values; } setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); } fire(name) { return (this.listeners[name] || []).map(callback => callback())[0]; }
  showModal() { this.open = true; } close() { this.open = false; this.fire('close'); } all() { return [this, ...this.children.flatMap(child => child.all())]; } focus() {}
  querySelector(selector) { return this.children.find(child => child.tag === selector) || null; } after(node) { this.children.push(node); }
}
test('the bell lists each switch with who and when; "知道了" holds until the next one', async t => {
  const f = fixture(t), { bind } = require('../renderer/record-reminders.js');
  await f.window(false); f.at += 60000; await f.window(true); f.at += 60000; await f.agent(BUTLER, false); f.at += 60000; await f.agent(BUTLER, true);
  const status = () => ({ ...reminders.status(f.dir, f.at, { standing: f.policy.switches() }), confirmations: [], confirmationCount: 0 });
  const button = new Element('button'), badge = new Element('span'), dialog = new Element('dialog'), calls = [];
  const api = { records: async (action, ...args) => { calls.push([action, ...args]); if (action === 'acknowledge') reminders.acknowledge(f.dir, ...args); return status(); } };
  const screen = bind({ button, badge, dialog, document: { createElement: tag => new Element(tag) }, api, text: zh, now: () => f.at }); t.after(() => screen.dispose());
  await screen.open();
  const clock = at => { const d = new Date(at); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
  const rows = () => dialog.all().filter(n => n.dataset.kind === 'standing'), words = () => rows().map(n => n.all().find(x => x.tag === 'p').textContent);
  const press = (root, action) => root.all().find(n => n.tag === 'button' && n.dataset.action === action).fire('click');
  assert.equal(badge.textContent, '2', 'the butler\'s two; the person\'s own are not counted');
  assert.deepEqual(words(), [`「允许大管家直接整理本机工作」：大管家关掉的 ${clock(f.at - 60000)}`, `「允许大管家直接整理本机工作」：大管家打开的 ${clock(f.at)}`]);
  assert.equal(rows()[0].all().some(n => n.dataset.action === 'export'), false, 'nothing to export');
  press(dialog, 'allConfirmations');
  assert.deepEqual(words().map(text => text.replace(/ \d\d:\d\d$/, '')), ['你关掉的', '你打开的', '大管家关掉的', '大管家打开的'].map(x => '「允许大管家直接整理本机工作」：' + x));
  assert.equal(rows()[0].all().some(n => n.dataset.action === 'acknowledge'), false, 'nothing to acknowledge in what the person did');
  press(dialog, 'pendingConfirmations');
  await press(rows()[1], 'acknowledge'); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([words(), badge.textContent], [[], '']);
  assert.deepEqual(calls.find(c => c[0] === 'acknowledge').slice(0, 3), ['acknowledge', 'steward', 'standing']);
  // Another day: the date too. A new switch rings again.
  f.at += 60000; await f.agent(BUTLER, false); await screen.refresh();
  assert.equal(badge.textContent, '1');
  const at = f.at; f.at += 26 * 3600000; await screen.refresh();
  const d = new Date(at); assert.deepEqual(words(), [`「允许大管家直接整理本机工作」：大管家关掉的 ${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${clock(at)}`]);
});

test('the record dialog: the switch says the butler turned it on and when, and the steps read as words', async t => {
  const f = fixture(t), { bind } = require('../renderer/steward-record.js');
  for (const step of [() => f.window(true), () => f.window(false), () => f.window(true), () => f.agent(BUTLER, false), () => f.agent(BUTLER, true), () => f.agent(BUTLER), () => f.agent(BUTLER, 'odd'), () => f.agent(BUTLER, false, true)]) { f.at += 1000; await step(); }
  for (const language of ['zh', 'en']) {
    const text = (key, params) => locale.format(language, key, params), dialog = new Element('dialog');
    const open = async value => { const screen = bind({ dialog, document: { createElement: tag => new Element(tag) }, text,
      api: { stewardRecord: async () => ({ ...recordView(f.record, f.state, { current: as(BUTLER) }), at: f.at }), stewardStanding: async () => value } });
      await screen.open(); await new Promise(resolve => setImmediate(resolve)); return { screen, words: dialog.all().map(n => n.textContent) }; };
    const now = new Date(), clock = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0'), at = now.getTime();
    for (const [value, key] of [[{ on: true, by: 'butler', at }, 'standing.onButler'], [{ on: false, by: 'butler', at }, 'standing.offButler'], [{ on: false, reason: 'other-designation' }, 'standing.offOther'], [{ on: true }, 'standing.on'], [{ on: false }, 'standing.off']]) {
      const { words } = await open(value);
      // Off, but not by the person: it does not say that only the person turns it on again, and says who can.
      const own = !['standing.offButler', 'standing.offOther'].includes(key), lock = dialog.all().filter(n => n.textContent === text('standing.lock'));
      assert.deepEqual(lock.map(n => n.hidden), [!own], `${language} ${key}`);
      assert.equal(words.filter(w => w === text('standing.scope')).length, 1);
      if (!own) assert.match(text(key, { time: clock }), language === 'zh' ? /(它可以再打开|你或现任大管家都可以)/ : /(it can turn it on again|you or the current butler can turn it on again)/);
      assert.equal(words.filter(w => w === text(key, { time: clock })).length, 1, `${language} ${key}`); dialog.open = false;
    }
    if (language === 'zh') assert.match(text('standing.onButler', { time: clock }), new RegExp(`大管家打开的 ${clock}`));
    const { screen } = await open({ on: true });
    const said = f.shown().map(e => screen.what(e)[0]);
    assert.deepEqual(said, ['stewardRecord.step.method', 'stewardRecord.step.method', 'stewardRecord.step.standingCheck', 'stewardRecord.step.standingOn', 'stewardRecord.step.standingOff', 'stewardRecord.step.youStandingOn', 'stewardRecord.step.youStandingOff', 'stewardRecord.step.youStandingOn']);
    for (const key of said.slice(2)) assert.notEqual(text(key), key);
    assert.equal(screen.result({ kind: 'standingSwitch', on: true }), null); dialog.open = false;
    assert.equal(dialog.all().some(n => n.dataset.kind === 'standingSwitch' && /attention/.test(n.className)), false);
  }
});

test('a row says it was switched only when it was: asked and refused, or already so, is said as that, and the bell is silent', async t => {
  const f = fixture(t), name = { zh: '「允许大管家直接整理本机工作」', en: '“Let the butler organize work on this Mac”' };
  const quiet = async (run, expected) => {
    const before = [f.bell().length, f.rung, f.told, f.read()]; f.at += 1000;
    const result = await run();
    assert.deepEqual([f.bell().length, f.rung, f.told, f.read()], before, 'no line in the bell, nothing written');
    for (const language of ['zh', 'en']) assert.deepEqual(rows(f, language)[0], expected[language], language);
    return result;
  };
  await f.window(false);
  // (a) The person turned it off and the butler asks for it on.
  refused(await quiet(() => f.agent(BUTLER, true), { zh: ['它要求打开' + name.zh, '没有做：你关掉的，只有你能再打开'],
    en: ['It asked to turn on ' + name.en, 'Not done: you turned it off, so only you can turn it on'] }), 'error.steward.standingPersonOff');
  // (c) The person turned it off and the butler asks for it off.
  const off = await quiet(() => f.agent(BUTLER, false), { zh: ['它要求关掉' + name.zh + '，本来就关着，没有改动', '完成'], en: ['It asked to turn off ' + name.en + ', which was already off; nothing changed', 'Done'] });
  assert.deepEqual([off.state, off.value.changed], ['complete', false]);
  // (b) Already on.
  await f.window(true);
  const on = await quiet(() => f.agent(BUTLER, true), { zh: ['它要求打开' + name.zh + '，本来就开着，没有改动', '完成'], en: ['It asked to turn on ' + name.en + ', which was already on; nothing changed', 'Done'] });
  assert.deepEqual([on.state, on.value.changed], ['complete', false]);
  // Refused before writing for another reason: the same.
  f.policy.write = () => { throw Error('SECRET synthetic'); };
  refused(await quiet(() => f.agent(BUTLER, false), { zh: ['它要求关掉' + name.zh, '没有做：许可的状态读写不了'], en: ['It asked to turn off ' + name.en, 'Not done: the permission could not be read or saved'] }), 'error.steward.standingUnavailable');
  delete f.policy.write;
  // The same call again is answered with the first answer; nothing was switched by it.
  f.at += 1000;
  const call = { action: 'invoke', method: 'stewardStanding', arguments: [false], operation_id: 'twice' };
  for (let n = 0; n < 2; n++) { f.at += 1000; const binding = f.binding(BUTLER); await f.record.around(binding.sender, call, () => f.controller.call(binding, call)); }
  assert.deepEqual(rows(f, 'zh').slice(0, 2), [['它要求关掉' + name.zh, '同一操作已经做过，这次没有再做'], ['它关掉了' + name.zh, '完成']]);
  assert.equal(f.bell().length, 3, 'one switch');
  f.at += 1000; await f.agent(BUTLER, true);
  for (const language of ['zh', 'en']) assert.deepEqual(rows(f, language)[0], { zh: ['它打开了' + name.zh, '完成'], en: ['It turned on ' + name.en, 'Done'] }[language]);
  // A step whose outcome could not be written says what was asked only.
  const entry = { kind: 'step', id: 'x', at: 1, session: { id: 'b', nativeId: 'n', provider: 'claude', name: 'B' }, action: 'invoke', method: 'stewardStanding', arguments: '[true]', operationId: null, state: null, reason: null, error: null, duplicate: false, recorded: false };
  assert.equal(recordView({ entries: () => [entry], periods: () => [], current: () => null }, f.state, {}).entries[0].standing, 'onAsked');
  f.record.did(BUTLER, 'switched'); // Outside a step: nothing to mark.
  // Kept across a restart, as the record reads its own lines.
  f.record = new StewardRecord(f.dir, { steward: cachedSteward(f.role), selected: () => f.role.selected, now: () => f.at });
  assert.equal(rows(f, 'zh')[0][0], '它打开了' + name.zh);
});

test('a save that fails after it took effect is recorded, rung and answered as a switch; one that cannot be read back is not said to have changed nothing', async t => {
  const f = fixture(t), sync = fs.fsyncSync, read = f.policy.read.bind(f.policy);
  // As the directory's own sync failing, once the file is in place.
  let failed = 0; t.after(() => { fs.fsyncSync = sync; });
  const broken = async run => {
    f.policy.write = function (value) {
      fs.fsyncSync = fd => { if (fs.fstatSync(fd).isDirectory()) { failed++; throw Object.assign(Error('EIO synthetic'), { code: 'EIO' }); } return sync(fd); };
      try { return StewardStanding.prototype.write.call(this, value); } finally { fs.fsyncSync = sync; }
    };
    try { return await run(); } finally { delete f.policy.write; }
  };
  const on = await broken(() => f.agent(BUTLER, true));
  assert.deepEqual([on.state, on.value.on, on.value.changed, on.error], ['complete', true, true, undefined], JSON.stringify(on));
  assert.deepEqual([f.bell().map(i => [i.by, i.on]), f.rung, f.told], [[['butler', true]], 1, 1]);
  assert.equal(rows(f, 'zh')[0][0], '它打开了「允许大管家直接整理本机工作」');
  f.at += 1000;
  assert.equal((await broken(() => f.window(false))).on, false);
  assert.deepEqual([f.shown()[0].kind, f.shown()[0].on, f.bell().length, f.rung, f.told], ['standingSwitch', false, 2, 2, 2]);
  refused(await f.agent(BUTLER, true), 'error.steward.standingPersonOff');
  // Left on for the next butler, and taken back: the same.
  await f.window(true); let carry = f.policy.carry(f.person); f.role.set(as(NEXT));
  await broken(async () => carry(true)); assert.equal(f.policy.view().on, true);
  carry = f.policy.carry(f.person); f.role.set(as(BUTLER)); assert.equal(await broken(async () => carry(false)), true);
  assert.equal(failed, 4, 'each of them failed');
  // Failed before the file was replaced: nothing changed, and it says so.
  const rename = fs.renameSync; t.after(() => { fs.renameSync = rename; });
  f.at += 1000; await f.window(true); f.at += 1000; const kept = f.read(), told = [f.rung, f.told, f.bell().length];
  fs.renameSync = (...args) => { if (args[1] === f.file) throw Error('EIO synthetic'); return rename(...args); };
  refused(await f.agent(BUTLER, false), 'error.steward.standingUnavailable');
  await assert.rejects(f.window(false), /EIO synthetic/);
  fs.renameSync = rename;
  assert.deepEqual([f.read(), [f.rung, f.told, f.bell().length]], [kept, told]);
  assert.notEqual(f.shown()[0].kind, 'standingSwitch');
  // Neither known: an open outcome, without "nothing changed"; the windows look again.
  const unread = run => { let written = false; f.policy.write = value => { StewardStanding.prototype.write.call(f.policy, value); written = true; throw Error('SECRET synthetic'); };
    f.policy.read = () => { if (written) throw Error('SECRET unreadable'); return read(); };
    return run().finally(() => { delete f.policy.write; delete f.policy.read; }); };
  f.at += 1000; const unknown = await unread(() => f.agent(BUTLER, false));
  assert.deepEqual([unknown.state, unknown.error], ['unconfirmed', uiError('error.steward.standingUnknown').message]);
  assert.doesNotMatch(locale.format('zh', 'error.steward.standingUnknown') + locale.format('en', 'error.steward.standingUnknown'), /没有改动|nothing changed/);
  assert.deepEqual([f.rung, f.told], [told[0] + 1, told[1] + 1]);
  assert.deepEqual(rows(f, 'zh')[0], ['它要求关掉「允许大管家直接整理本机工作」', '结果未确认']);
  await f.window(true); await assert.rejects(unread(() => f.window(false)), error => error?.uiMessage?.key === 'error.steward.standingUnknown');
  // A window that cannot be told afterwards does not undo the switch or its line.
  f.context.broadcastRoom = async () => { throw Error('SECRET broadcast'); };
  f.at += 1000; assert.equal((await f.window(true)).on, true); assert.deepEqual([f.shown()[0].kind, f.shown()[0].on], ['standingSwitch', true]);
  f.at += 1000; assert.equal((await f.agent(BUTLER, false)).state, 'complete'); assert.equal(rows(f, 'zh')[0][0], '它关掉了「允许大管家直接整理本机工作」');
});

test('a permission that cannot be read does not clear 「知道了」, drop the waiting lines or count them twice', async t => {
  const f = fixture(t), count = policy => reminders.status(f.dir, f.at, { standing: policy.switches() }).count;
  await f.agent(BUTLER, true); reminders.acknowledge(f.dir, 'steward', 'standing', f.bell().at(-1).level);
  f.at += 1000; await f.agent(BUTLER, false);
  assert.equal(count(f.policy), 1);
  const file = fs.readFileSync(f.file);
  fs.writeFileSync(f.file, '{');
  assert.equal(count(f.policy), 1, 'the waiting line stays');
  assert.equal(count(f.open()), 0, 'after a restart the lines are not known');
  fs.writeFileSync(f.file, file);
  assert.deepEqual([count(f.policy), count(f.open())], [1, 1], 'only the one that was waiting');
  reminders.acknowledge(f.dir, 'steward', 'standing', f.bell().at(-1).level);
  fs.writeFileSync(f.file, '{'); assert.deepEqual([count(f.policy), count(f.open())], [0, 0]);
  fs.writeFileSync(f.file, file); assert.deepEqual([count(f.policy), count(f.open())], [0, 0], 'acknowledged before, and still');
  // The app before the permission is there, and one that throws: unknown too.
  const asked = [], status = vm.createContext({ stewardStanding: null, stewardRecord: f.record, recordReminders: { status: (...args) => { asked.push(args[2].standing); throw Error('stop'); } }, dataDir: f.dir, operationsUnavailable: null, Date });
  vm.runInContext(cut('function appRecordsStatus(', '// The one list of fixed alert codes'), status);
  for (const policy of [null, { switches() { throw Error('SECRET'); } }, f.policy]) { status.stewardStanding = policy; assert.throws(() => status.appRecordsStatus(), /stop/); }
  assert.deepEqual(JSON.parse(JSON.stringify(asked)), [{ rows: [], known: false }, { rows: [], known: false }, f.policy.switches()]);
  // Really none: the next one is a new one.
  fs.unlinkSync(f.file); assert.equal(count(f.open()), 0);
  assert.equal((await f.agent(BUTLER, true)).state, 'complete'); assert.equal(count(f.policy), 1);
});

test('the person\'s own off outlives a revoked designation; a permission left on when the person revokes is not an off', async t => {
  const f = fixture(t);
  await f.agent(BUTLER, true); await f.window(false); const kept = f.read();
  f.role.set(null); f.context.stewardStanding = f.policy = f.open(); f.role.set(as(NEXT));
  refused(await f.agent(NEXT, true), 'error.steward.standingPersonOff');
  f.role.set(null); f.role.set(as(BUTLER));
  refused(await f.agent(BUTLER, true), 'error.steward.standingPersonOff');
  assert.deepEqual(f.read(), kept);
  // As the spec has it (section six, 3): revoking is not the person's manual off.
  await f.window(true); f.role.set(null);
  assert.equal(f.policy.view().on, false); f.role.set(as(NEXT));
  assert.equal(f.policy.view().reason, 'other-designation');
  assert.deepEqual([(await f.agent(NEXT, true)).value.on, f.read().designation], [true, as(NEXT)]);
});

test('wiring: an agent command answered by this desktop, in the catalog with its words, its switches in the bell and on the phone', t => {
  const f = fixture(t);
  assert.ok(f.handlers.has('stewardStanding')); assert.doesNotMatch(source, /applicationHandlers\.delete\('stewardStanding'\)/);
  const local = source.match(/const local = new Set\(\[([^\]]*)\]\)/)[1];
  assert.ok(local.includes("'stewardStanding'"), 'no backend capability is needed for it');
  const entry = f.controller.catalog().find(item => item.method === 'stewardStanding');
  assert.match(entry.parameters[0], /true or false[\s\S]*designated butler or the person[\s\S]*person turned it off/u);
  assert.match(source, /let standing = \{ rows: \[\], known: false \}; try \{ standing = stewardStanding\?\.switches\(\) \?\? standing; \} catch[^\n]*\n[^\n]*recordReminders\.status\(dataDir, Date\.now\(\), \{ standing, unavailable: \{/);
  for (const language of ['zh', 'en']) for (const key of ['error.steward.standingOnly', 'error.steward.standingInvalid', 'error.steward.standingPersonOff', 'error.steward.standingUnavailable', 'error.steward.standingUnknown', 'standing.lock',
    ...Object.values(CODES).map(code => 'stewardRecord.reason.' + code)])
    assert.notEqual(locale.format(language, key), key);
  for (const language of ['zh', 'en']) {
    assert.match(locale.format(language, 'standing.scope'), language === 'zh' ? /大管家自己也能开关。$/ : /The butler can turn it on or off itself\.$/);
    assert.match(locale.format(language, 'standing.lock'), language === 'zh' ? /^你关掉后只有你能再打开。$/ : /^ Once you turn it off, only you can turn it on again\.$/);
  }
  const phone = fs.readFileSync(path.join(__dirname, '../mobile-web/workspace.js'), 'utf8');
  for (const word of ['standingOn', 'standingOff', 'standingOffOpen']) assert.equal(phone.match(new RegExp(word + ":? ?[=:']", 'g'))?.length >= 2, true, word);
  // The butler's off is how it stands now only while it is the last switch: then the phone says it can be turned on again.
  assert.match(phone, /const last = r\.items\.filter\(x => x\.kind === 'standing'\)\.at\(-1\) === i, switched = i\.kind === 'standing' \? t\(i\.on \? 'standingOn' : last \? 'standingOffOpen' : 'standingOff'\) : null/);
  assert.match(phone, /standingOffOpen: '[^']*它可以再打开/); assert.match(phone, /standingOffOpen: '[^']*it can turn it on again/);
});
