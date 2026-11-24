// After the daily GUI changed version or restarted, the butler and the queue secretary (项目经理) are told (the person,
// 2026-11-23: 「装机结束了你和 NAW 的项目经理貌似都呆住了啥都没发出来(这也是 bug)」). main.cjs's own observeVersion,
// connectionUpdateOptions and boot wiring, a real event record, secretary designation, steward wake and dispatcher.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { ButlerLedger } = require('../butler-ledger.cjs');
const { ButlerIngress } = require('../butler-ingress.cjs');
const { QueueSecretary } = require('../queue-secretary.cjs');
const { StewardWake } = require('../steward-wake.cjs');
const { RoomState } = require('../room-state.cjs');
const { uiError } = require('../ui-errors.cjs');
const { continuationStatus } = require('../service-client.cjs');
const backendSwitch = require('../backend-switch.cjs');
const rules = require('../queue-dispatch.cjs');
// Missing before this change: every test below then fails on what was (not) told, not on loading.
let events = null; try { events = require('../version-events.cjs'); } catch { /* Old code. */ }

const main = fs.readFileSync(require.resolve('../main.cjs'), 'utf8');
const box = { exports: {} };
vm.runInNewContext(process.binding('natives')['internal/deps/acorn/acorn/dist/acorn'], { module: box, exports: box.exports });
const ast = box.exports.parse(main, { ecmaVersion: 'latest' });
function source(name) {
  const node = ast.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === name);
  assert.ok(node, `main.cjs function ${name}`);
  return main.slice(node.start, node.end);
}
const OLD = '0.1.0-alpha.286', NEW = '0.1.0-alpha.287';
const BUTLER = { sessionId: 'butler', nativeId: 'native-butler' }, SECRETARY = { sessionId: 'secretary', nativeId: 'native-secretary' };
const KEY_A = 'backends/e2b6a43aaaaaaaaaaaaa', KEY_B = 'backends/bbbbbbbbbbbbbbbbbbbb';
const CAPS = ['atomicShutdown', 'resume', 'conditionalMaintenanceStopV1'];

function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-version-events-')); fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const seen = (dir, version) => fs.writeFileSync(path.join(dir, 'version-seen.json'), JSON.stringify({ format: 1, version, at: 1 }), { mode: 0o600 });
// A Claude session NAW can stop: what was typed in its terminal is not known, so only a migration may move it.
const stoppable = (id, name, quietForMs, extra = {}) => ({ id, nativeId: `native-${id}`, provider: 'claude', name, state: 'idle', terminalInputPending: true,
  backgroundStale: false, background: 0, scheduled: 0, fleet: [], lastActivityAt: Date.now() - quietForMs,
  messages: [{ role: 'user', text: 'SECRET-CONVERSATION-BODY', time: Date.now() - quietForMs }], ...extra });

// main.cjs's boot lines and observeVersion over a window client holding the given backends.
function app(t, { dir, entries, settings = { auto: true, migrate: true }, secretary = SECRETARY, steward = BUTLER } = {}) {
  dir ||= directory(t);
  const ledger = new ButlerLedger(dir), ingress = new ButlerIngress(dir, { roomState: new RoomState(dir), ledger });
  const queueSecretary = new QueueSecretary(dir);
  if (secretary) queueSecretary.set(secretary);
  const versionNotices = events ? new events.VersionNotices() : null;
  const control = { maintenance: new Set(), generations: new Map(), revision: 0, manualEpoch: 0, views: new Set() };
  const current = { key: '.', client: {}, state: { runtimeVersion: NEW, capabilities: CAPS, servicePid: 4100, sessions: [], room: { messages: [] } } };
  const client = { entries: [...entries, current], active: current, control, socket: { destroyed: false },
    snapshot() { return { sessions: this.entries.flatMap(e => e.state.sessions) }; }, sessionState: value => value.state };
  const context = { client, view: { owner: 'synthetic-owner' }, win: { isDestroyed: () => false } };
  const scope = vm.createContext({ VersionEvents: events?.VersionEvents, versionNotices, versionEvents: null, butlerIngress: ingress, queueSecretary,
    stewardRole: { current: () => steward }, app: { getVersion: () => NEW }, dataDir: dir, continuationStatus, uiError,
    roomState: { apply: state => state }, backendSwitch: { ...backendSwitch, readSettings: () => settings }, windows: new Map([[1, context]]),
    backendSwitching: null, autoSwitchFailed: new Set(), queueDispatcher: null, queueRules: rules, runningRelays: () => new Set(),
    migrateQuietMs: () => rules.MIGRATE_QUIET_MS, migrateUnprovenQuietMs: () => rules.MIGRATE_UNPROVEN_QUIET_MS });
  // Before this change main.cjs had neither: what it then told is what is asserted, nothing.
  const a = main.indexOf('  // The version this start brought, told to the butler'), b = main.indexOf('  const defaultWorkspace', a);
  if (a > 0 && b > a) vm.runInContext(main.slice(a, b), scope);
  vm.runInContext(source('connectionUpdateOptions'), scope);
  if (ast.body.some(node => node.type === 'FunctionDeclaration' && node.id.name === 'observeVersion')) vm.runInContext(source('observeVersion'), scope);
  const recorded = () => ledger.snapshot().events.filter(e => e.eventId.startsWith('version-change:'));
  const owed = () => versionNotices ? versionNotices.take(SECRETARY) : [];
  return { dir, ledger, ingress, versionNotices, scope, client, current, entries, recorded, owed, observe: () => scope.observeVersion?.() };
}
// Two old backends: the butler's (one session at work) and another whose session is not quiet for 10 minutes yet.
function backends() {
  const a = { key: KEY_A, client: {}, state: { runtimeVersion: OLD, capabilities: CAPS, servicePid: 4101, room: { messages: [] }, sessions: [
    stoppable('butler', '大管家', 3600000), stoppable('secretary', '项目经理', 3600000), stoppable('a', 'A', 0, { state: 'working', activeTurnId: 'turn' }), stoppable('b', 'B', 3600000)] } };
  const b = { key: KEY_B, client: {}, state: { runtimeVersion: OLD, capabilities: CAPS, servicePid: 4102, room: { messages: [] }, sessions: [stoppable('c', 'C', 60000)] } };
  return [a, b];
}
// Sessions moved onto the current backend, as a finished migration leaves them.
function move(f, entry) {
  f.current.state.sessions.push(...entry.state.sessions);
  entry.state.sessions = [];
}

test('286 to 287: the butler gets one event and the secretary one notice, with versions, time and what each old backend waits for', async t => {
  const dir = directory(t); seen(dir, OLD);
  const f = app(t, { dir, entries: backends() });
  f.observe();
  const [event] = f.recorded();
  assert.ok(event, 'an event in the butler\'s record');
  assert.equal(f.recorded().length, 1);
  assert.equal(event.kind, 'blocked'); assert.equal(event.payload.reason, 'version-installed');
  assert.equal(event.payload.outcome, `${OLD}->${NEW}`);
  assert.match(event.payload.title, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/u);
  const text = event.payload.text;
  assert.match(text, new RegExp(`^【NAW 版本】已装 ${NEW}（原来是 ${OLD}），\\d{4}-\\d\\d-\\d\\dT[\\d:]+Z 重启完成。\n还有 2 个后台不在 0\\.1\\.0-alpha\\.287：\n`, 'u'));
  assert.match(text, /- e2b6a43（0\.1\.0-alpha\.286；大管家、项目经理、A、B）：4 个会话里 1 个（A）在干活或等人回答，都停下并连续安静 10 分钟/u);
  assert.match(text, /- bbbbbbb（0\.1\.0-alpha\.286；C）：1 个会话里 1 个（C）还没连续安静 10 分钟，安静后自动迁/u);
  assert.match(text, /迁完或失败时再发一条。$/u);
  assert.doesNotMatch(text, /SECRET-CONVERSATION-BODY/u, 'nothing of any conversation');
  const owed = f.owed();
  assert.equal(owed.length, 1, 'one notice owed to the secretary');
  assert.equal(owed[0].text, `${text}\nNAW 只通知，不加任务。`);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'version-seen.json'), 'utf8')).version, NEW);
  // Nothing changed: nothing more.
  f.observe(); f.observe();
  assert.equal(f.recorded().length, 1); assert.equal(f.owed().length, 1);
  assert.equal(f.ledger.snapshot().events.some(e => e.kind === 'request'), false, 'no request, no queue item');
});

test('the butler is woken for the event and the secretary is sent its notice, both through the dispatcher\'s pass', async t => {
  const dir = directory(t); seen(dir, OLD);
  const f = app(t, { dir, entries: backends() });
  const clock = { now: Date.now() };
  const wake = new StewardWake(dir, { ledger: () => f.ledger, selected: () => BUTLER, now: () => clock.now, record: () => {} });
  wake.set(true);
  f.observe();
  const client = new FakeClient([agent('butler'), agent('secretary')]);
  const dispatcher = new rules.QueueDispatcher({ roomState: new RoomState(dir), dataDir: dir, connect: async () => client, now: () => clock.now,
    settleMs: 8000, tickMs: 3000, steward: () => ({ ...BUTLER, duty: '' }), stewardWake: wake, transcriptRoot: path.join(dir, 'none'),
    ...(f.versionNotices ? { versionNotices: f.versionNotices } : {}) });
  t.after(() => dispatcher.close());
  await dispatcher.start(); clearInterval(dispatcher.timer);
  for (let i = 0; i < 5; i++) { clock.now += 3000; await dispatcher.schedule(); }
  const to = id => client.dispatches().filter(call => call[1] === id);
  assert.equal(to('butler').length, 1); assert.match(to('butler')[0][2], /^【NAW 事件】有新事件。用 workspace_control 调 stewardEvents/u);
  assert.equal(to('secretary').length, 1); assert.match(to('secretary')[0][4], /^version-notice:/u);
  assert.match(to('secretary')[0][2], /^【NAW 版本】已装 0\.1\.0-alpha\.287（原来是 0\.1\.0-alpha\.286）/u);
  assert.equal(f.versionNotices?.waiting(), false);
  assert.equal(client.calls.some(call => ['send', 'queue', 'claim', 'input', 'steer'].includes(call[0])), false, 'no human send');
});

test('a restart on the same version says 「重启完成」 and does not say 「已装」 again; a first start without a record does', t => {
  const dir = directory(t);
  const first = app(t, { dir, entries: [] }); first.observe();
  assert.equal(first.recorded()[0].payload.reason, 'version-installed');
  assert.match(first.recorded()[0].payload.text, /^【NAW 版本】已装 0\.1\.0-alpha\.287（原来是 没有记录），/u);
  assert.match(first.recorded()[0].payload.text, /\n后台都已在 0\.1\.0-alpha\.287。$/u);
  for (let start = 0; start < 2; start++) {
    const again = app(t, { dir, entries: [] }); again.observe();
    const rows = again.recorded();
    const last = rows[rows.length - 1];
    assert.equal(rows.length, 2 + start, 'one event per start');
    assert.equal(last.payload.reason, 'version-restarted');
    assert.match(last.payload.text, /^【NAW 版本】重启完成：0\.1\.0-alpha\.287，\d{4}-[\d-]+T[\d:]+Z。\n后台都已在 0\.1\.0-alpha\.287。$/u);
    assert.doesNotMatch(last.payload.text, /已装/u);
    assert.equal(again.scope.versionEvents?.pending(), false, 'nothing left to watch');
  }
});

test('a first start without a seen record names the version the daily installer replaced (290: 「原来是 没有记录」)', t => {
  const dir = directory(t);
  const receipt = (version, previous) => fs.writeFileSync(path.join(dir, 'installation.json'), JSON.stringify({ version, commit: 'c'.repeat(40), previous, installedAt: '2026-11-24T04:24:00.000Z' }), { mode: 0o600 });
  receipt('0.1.0-alpha.287', '0.1.0-alpha.286');
  const first = app(t, { dir, entries: [] }); first.observe();
  assert.match(first.recorded()[0].payload.text, /^【NAW 版本】已装 0\.1\.0-alpha\.287（原来是 0\.1\.0-alpha\.286），/u);
  // A receipt for another version, or one naming no previous version, is not used.
  const other = directory(t);
  fs.writeFileSync(path.join(other, 'installation.json'), JSON.stringify({ version: '0.1.0-alpha.286', previous: '0.1.0-alpha.285' }), { mode: 0o600 });
  const stale = app(t, { dir: other, entries: [] }); stale.observe();
  assert.match(stale.recorded()[0].payload.text, /（原来是 没有记录）/u);
});

test('a backend that moved gets a follow-up with what is left; one that failed gets one too, once; the last one ends it', t => {
  const dir = directory(t); seen(dir, OLD);
  const [a, b] = backends();
  const f = app(t, { dir, entries: [a, b] });
  f.observe();
  move(f, b); f.observe();
  let rows = f.recorded();
  assert.equal(rows.length, 2);
  assert.equal(rows[1].kind, 'blocked'); assert.equal(rows[1].payload.reason, 'backend-moved');
  assert.equal(rows[1].payload.outcome, 'moved:1,gone:0,failed:0,behind:1');
  assert.match(rows[1].payload.text, /^【NAW 版本】后台迁移（0\.1\.0-alpha\.287）：\n- bbbbbbb 迁完：1 个会话里 1 个已在 0\.1\.0-alpha\.287\n还有 1 个后台不在 0\.1\.0-alpha\.287：\n- e2b6a43（[^）]+）：4 个会话里 1 个（A）在干活或等人回答/u);
  f.scope.autoSwitchFailed.add(KEY_A); f.observe(); f.observe();
  rows = f.recorded();
  assert.equal(rows.length, 3, 'a failure is told once');
  assert.equal(rows[2].kind, 'failure'); assert.equal(rows[2].payload.reason, 'backend-move-failed');
  assert.match(rows[2].payload.text, /- e2b6a43：自动迁移失败，这次运行不再自动试，要人点更新\n还有 1 个后台不在 0\.1\.0-alpha\.287：\n- e2b6a43（[^）]+）：自动迁移失败/u);
  // The person clicked: it moved after all.
  move(f, a); f.observe();
  rows = f.recorded();
  assert.equal(rows.length, 4);
  assert.match(rows[3].payload.text, /- e2b6a43 迁完：4 个会话里 4 个已在 0\.1\.0-alpha\.287\n后台都已在 0\.1\.0-alpha\.287。$/u);
  assert.equal(f.scope.versionEvents?.pending(), false);
  f.observe(); assert.equal(f.recorded().length, 4);
  assert.equal(f.owed().length, 4, 'the secretary is owed each as well');
});

test('a backend gone from the list with sessions not on this version is not told as moved', t => {
  const dir = directory(t); seen(dir, OLD);
  const [, b] = backends();
  const f = app(t, { dir, entries: [b] });
  f.observe();
  b.state.sessions[0].archived = true; f.observe();
  const rows = f.recorded();
  assert.equal(rows.length, 2);
  assert.match(rows[1].payload.text, /\n- bbbbbbb 不在待迁列表里了：1 个会话里 0 个已在 0\.1\.0-alpha\.287\n后台都已在 0\.1\.0-alpha\.287。$/u);
  assert.doesNotMatch(rows[1].payload.text, /迁完/u);
  assert.equal(rows[1].payload.outcome, 'moved:0,gone:1,failed:0,behind:0');
});

test('what each old backend waits for, by the same rule as the move NAW chooses', () => {
  assert.ok(rules.moveWait, 'queue-dispatch.cjs moveWait');
  const now = Date.now(), humanAt = new Map(), failed = new Set();
  const entry = sessions => ({ runtimeVersion: OLD, capabilities: CAPS, servicePid: 4200, sessions, room: { messages: [] } });
  const option = sessions => {
    const plan = backendSwitch.backendPlan(entry(sessions));
    return { backendKey: KEY_B, sessions: sessions.map(s => ({ id: s.id, name: s.name })),
      switch: plan && (plan.stops.length || plan.blocked || plan.ready) ? { ready: plan.ready, auto: plan.auto, blocked: plan.blocked, reason: plan.reason, stops: plan.stops } : null,
      moveRefused: plan && !plan.ready && !plan.blocked ? plan.reason || null : null };
  };
  const wait = (sessions, settings = { auto: true, migrate: true }, fail = failed) => rules.moveWait(option(sessions), settings, sessions, humanAt, now, fail);
  const code = (...args) => wait(...args)?.code;
  const quiet = stoppable('q', 'Q', 3600000);
  assert.equal(wait([quiet]), null, 'quiet for long enough: moved');
  assert.equal(rules.nextBackendMove([option([quiet])], { auto: true, migrate: true }, [quiet], humanAt, now, failed)?.backendKey, KEY_B);
  assert.deepEqual(wait([stoppable('q', 'Q', 60000)]), { code: 'quiet-10m', waiting: 1, ids: ['q'] });
  const team = stoppable('t', 'T', 20 * 60000, { fleet: [{ event: 'TeammateIdle', time: now - 20 * 60000 }] });
  assert.deepEqual(wait([team]), { code: 'quiet-30m', waiting: 1, ids: ['t'] });
  assert.equal(wait([stoppable('t', 'T', 40 * 60000, { fleet: [{ event: 'TeammateIdle', time: now - 40 * 60000 }] })]), null);
  assert.deepEqual(wait([quiet, stoppable('w', 'W', 0, { state: 'working' })]), { code: 'busy', waiting: 1, ids: ['w'] });
  assert.deepEqual(wait([quiet, stoppable('w', 'W', 0, { state: 'working' })], { auto: true, migrate: false }), { code: 'busy-auto', waiting: 1, ids: ['w'] });
  assert.deepEqual(wait([stoppable('w', 'W', 0, { state: 'working' }), stoppable('e', 'E', 0, { state: 'ended' })]), { code: 'busy', waiting: 1, ids: ['w'] }, 'an ended session is not at work');
  assert.deepEqual(wait([stoppable('w', 'W', 0, { state: 'approval' })]), { code: 'busy', waiting: 1, ids: ['w'] }, 'one waiting for the person is counted');
  assert.equal(code([stoppable('d', 'D', 3600000, { state: 'disconnected' })]), 'blocked', 'a broken session needs the person');
  assert.match(wait([stoppable('d', 'D', 3600000, { state: 'disconnected' })]).reason, /^等空闲后更新：D/u, 'with the reason that names it');
  for (const stuck of [stoppable('d', 'D', 3600000, { state: 'disconnected' }), stoppable('n', 'N', 3600000, { nativeId: null }), stoppable('o', 'O', 3600000, { provider: 'other' })])
    assert.equal(code([stoppable('w', 'W', 0, { state: 'working' }), stuck]), 'blocked', `not told as passing by itself: ${stuck.id}`);
  assert.equal(code([stoppable('h', 'H', 0, { state: 'working', provider: 'dsh' })]), 'blocked', 'an unsupported provider at work never moves by itself');
  assert.deepEqual(wait([stoppable('s', 'S', 0, { state: 'working', nativeId: null })]), { code: 'busy', waiting: 1, ids: ['s'] }, 'a starting session gets its identity');
  assert.deepEqual(wait([quiet], { auto: true, migrate: false }), { code: 'needs-person' });
  assert.equal(code([stoppable('n', 'N', 3600000, { nativeId: null })]), 'blocked');
  assert.deepEqual(wait([quiet], { auto: true, migrate: true }, new Set([KEY_B])), { code: 'failed' });
  assert.equal(rules.nextBackendMove([option([stoppable('q', 'Q', 60000)])], { auto: true, migrate: true }, [stoppable('q', 'Q', 60000)], humanAt, now, failed), null);
  // Proven by the runtime and automatic updates on: moved at once, whatever the quiet.
  const proven = stoppable('p', 'P', 0, { terminalInputPending: false });
  assert.equal(wait([proven], { auto: true, migrate: false }), null);
  for (const code of ['quiet-10m', 'quiet-30m', 'busy', 'busy-auto', 'needs-person', 'blocked', 'not-movable', 'session-missing', 'failed', 'moving', 'next'])
    assert.equal(typeof events?.WAITS[code], 'function', `a sentence for ${code}`);
});

test('alpha.290: a backend left with only recoverable sessions is queued to move, and one NAW refuses is told with its reason', t => {
  const dir = directory(t); seen(dir, OLD);
  // Codex sessions whose process is gone: nothing to stop, only carried (backend-switch.cjs sessionPlan).
  const carried = { key: KEY_A, client: {}, state: { runtimeVersion: OLD, capabilities: CAPS, servicePid: 4101, room: { messages: [] }, sessions: [
    stoppable('r1', 'R1', 0, { provider: 'codex', state: 'recoverable' }), stoppable('r2', 'R2', 0, { provider: 'codex', state: 'recoverable' })] } };
  const early = { key: KEY_B, client: {}, state: { runtimeVersion: OLD, capabilities: ['atomicShutdown'], servicePid: 4102, room: { messages: [] }, sessions: [stoppable('o', 'O', 3600000)] } };
  const f = app(t, { dir, entries: [carried, early] });
  const [option] = f.scope.connectionUpdateOptions(f.client, NEW, f.scope.roomState);
  assert.deepEqual([option.ready, option.switch?.ready, option.switch?.stops], [false, true, []], 'a plan that stops nothing is kept');
  assert.equal(rules.nextBackendMove([option], { auto: true, migrate: true }, f.client.snapshot().sessions, new Map(), Date.now(), new Set())?.backendKey, KEY_A,
    'the person\'s migration setting moves it');
  assert.deepEqual(rules.moveWait(option, { auto: true, migrate: false }, f.client.snapshot().sessions, new Map(), Date.now(), new Set()), { code: 'needs-person' },
    'without it the person is asked, as for any move the runtime cannot prove');
  f.observe();
  const text = f.recorded()[0].payload.text;
  assert.match(text, /- e2b6a43（0\.1\.0-alpha\.286；R1、R2）：排队自动迁（每分钟迁一个后台）/u);
  assert.match(text, /- bbbbbbb（0\.1\.0-alpha\.286；O）：NAW 不能自己迁：这个早期后台不支持安全的一步更新。/u);
});

test('without a designated secretary only the butler\'s event is kept, without an error; a secretary that is the butler is not told twice', t => {
  const none = app(t, { entries: backends(), secretary: null });
  none.observe();
  assert.equal(none.recorded().length, 1); assert.equal(none.versionNotices?.waiting(), false);
  const same = app(t, { entries: backends(), secretary: BUTLER });
  same.observe();
  assert.equal(same.recorded().length, 1); assert.equal(same.versionNotices?.waiting(), false);
});

test('a secretary at work is not interrupted: it is told once its turn ended and it settled', async t => {
  const dir = directory(t); seen(dir, OLD);
  const f = app(t, { dir, entries: backends() });
  f.observe();
  const clock = { now: Date.now() };
  const client = new FakeClient([agent('secretary', { state: 'working' })]);
  const dispatcher = new rules.QueueDispatcher({ roomState: new RoomState(dir), dataDir: dir, connect: async () => client, now: () => clock.now,
    settleMs: 8000, tickMs: 3000, transcriptRoot: path.join(dir, 'none'), ...(f.versionNotices ? { versionNotices: f.versionNotices } : {}) });
  t.after(() => dispatcher.close());
  await dispatcher.start(); clearInterval(dispatcher.timer);
  const elapse = async ms => { for (let left = ms; left > 0; left -= 3000) { clock.now += 3000; await dispatcher.schedule(); } };
  await elapse(60000);
  assert.deepEqual(client.dispatches(), [], 'at work: nothing yet');
  assert.equal(dispatcher.hasOpenWork(), true, 'the notice keeps the passes going');
  client.set('secretary', { state: 'idle' }); await dispatcher.schedule();
  await elapse(6000);
  assert.deepEqual(client.dispatches(), [], 'just idle: not settled yet');
  await elapse(6000);
  assert.equal(client.dispatches().length, 1);
  assert.match(client.dispatches()[0][2], /^【NAW 版本】已装/u);
  client.set('secretary', { state: 'idle' }); await elapse(60000);
  assert.equal(client.dispatches().length, 1, 'told once');
});

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
      this.state.sessions.find(s => s.id === args[0]).state = 'working';
      return `tag-${this.calls.length}`;
    }
    throw Error(`unexpected ${method}`);
  }
  dispatches() { return this.calls.filter(call => call[0] === 'dispatch'); }
  set(id, changes) { Object.assign(this.state.sessions.find(s => s.id === id), changes); this.emit('state', this.snapshot()); }
}
function agent(id, extra = {}) {
  return { id, name: id, provider: 'claude', nativeId: `native-${id}`, model: 'claude-test-model', state: 'idle', roomIds: [], roomId: null,
    createdAt: Date.now() - 3600000, background: 0, scheduled: 0, backgroundStale: false, chatAvailable: true, liveDraft: '',
    serviceCapabilities: [rules.CAPABILITY], fleet: [], messages: [], ...extra };
}
