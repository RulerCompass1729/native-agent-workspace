// Ported from Codex 2's T114 (a97045a) onto main without the T-60 message catalog.
// Runs the production renderer functions in a VM with synthetic records.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
const fleet = require('../renderer/fleet-observation.js'), collaboration = require('../renderer/collaboration-overview.js');
function section(start, end) { const a = source.indexOf(start), b = source.indexOf(end, a + start.length); assert.ok(a >= 0 && b > a); return source.slice(a, b); }
const row = patch => ({ id: 'synthetic-session', nativeId: 'synthetic-native', provider: 'codex', name: 'literal <name> 中文', state: 'idle', runtimeVersion: '0.1.0-alpha.157', messages: [], ...patch });
function harness(record, connected = true) {
  const copied = [], actions = [], menus = [], updates = [], records = [row({ id: 'earlier' }), record, row({ id: 'later' })];
  const more = { isConnected: true, disabled: false, focus() {}, setAttribute() {}, getClientRects: () => [1], getBoundingClientRect: () => ({ left: 0, top: 0 }) };
  const currentRow = { more, spaceId: undefined }, ctx = { disconnected: !connected, state: { sessions: records, rooms: [], capabilities: ['agentWakeV1', 'observe'], appVersion: '0.1.0-alpha.157' },
    ui: { menu: options => { menus.push(options); return Object.assign(() => options.onClose(), { update: items => updates.push(items) }); } },
    window: { workspace: { copy: value => copied.push(value), archiveSession: () => actions.push('archive'), wakePolicy: () => actions.push('wake'), continueConnection: () => actions.push('continue'), newWindow: () => actions.push('window') }, nativeWorkspaceFleet: fleet, nativeWorkspaceCollaboration: collaboration },
    allSpaces: () => ctx.state.rooms, inSpace: (s, id) => (s.roomIds || []).includes(id),
    contentMenu: null, sessionMenu: null, roomMenu: null, sessionRows: new Map([[record.id, currentRow]]), sessionRow: () => currentRow,
    sidebarSessions: () => records, orderedMembers: () => records, attempt: fn => fn(), focusSessionAction: () => {},
    openRename: () => actions.push('rename'), moveSidebarSession: () => actions.push('move'), moveRoomMember: () => actions.push('move'),
    addToSpace: () => actions.push('join'), detach: () => actions.push('leave'), toast() {} };
  vm.createContext(ctx);
  vm.runInContext(source.slice(0, source.indexOf('\nlet state, owner,')) + '\n' + section('function sessionTime(', '\nfunction renderDraftRecovery(') + '\n' + section('function versionValue(', '\nfunction appVersionReport(') + '\n' + section('function sessionShortId(', '\nasync function moveSidebarSession(') + '\n' + section('function sessionMenuModel(', '\nfunction memberMenuKey('), ctx);
  return { ctx, copied, actions, menus, updates, records, record, present: () => ctx.sidebarPresentation(record), details: () => ctx.sidebarDetails(record), open: () => ctx.openSessionMenu(record.id) };
}
const child = (id, kind, stale = false) => ({ event: 'subAgentActivity', nativeId: id, kind, stale });

test('a ready root with mixed children keeps both counts and an attention cue', () => {
  const s = row({ fleet: [child('running', 'started'), child('unknown', 'interacted')] }), before = JSON.stringify(s), p = harness(s).present();
  assert.equal(p.tone, 'approval'); assert.equal(p.marker, '!'); assert.equal(p.detail, true);
  assert.ok(p.compact.includes('1 进行中')); assert.ok(p.compact.includes('1 未知'));
  assert.match(p.full, /部分/); assert.equal(JSON.stringify(s), before);
});
test('the ordinary ready row has no whole-goal completion claim', () => {
  const p = harness(row()).present(); assert.equal(p.tone, 'idle'); assert.equal(p.detail, false);
  assert.equal(p.compact, '会话就绪'); assert.equal(p.marker, '○'); assert.equal(p.workTone, '');
});
test('pending human input takes precedence over an old exhausted descriptor', () => {
  for (const patch of [{ claudeQuestion: {} }, { nativeInputRequired: true }, { state: 'approval', approval: {} }]) {
    const p = harness(row({ ...patch, capacityRecovery: { nativeId: 'synthetic-native', turnId: 'old', status: 'exhausted', attempt: 3, reason: 'capacity' } })).present();
    assert.equal(p.tone, 'approval'); assert.ok(!p.compact.includes('满载停下')); assert.ok(!p.compact.startsWith('会话就绪'));
  }
});
test('exhausted capacity remains explicit and cannot appear live while disconnected', () => {
  const s = row({ capacityRecovery: { nativeId: 'synthetic-native', turnId: 'failed', status: 'exhausted', attempt: 3, reason: 'capacity' } });
  const h = harness(s), p = h.present(); assert.equal(p.tone, 'approval'); assert.ok(p.compact.includes('满载停下')); assert.equal(p.detail, true);
  h.ctx.disconnected = true; const off = h.present(); assert.equal(off.tone, 'disconnected'); assert.ok(!off.compact.includes('满载停下')); assert.ok(!off.compact.startsWith('会话就绪'));
});
test('detail keeps literal names, full IDs, all memberships, actual times and both versions', () => {
  const s = row({ roomIds: ['one', 'two', 'three'], createdAt: Date.now() - 120000, lastActivityAt: Date.now() - 60000 }); const h = harness(s);
  h.ctx.state.rooms = ['one', 'two', 'three'].map((id, i) => ({ id, name: 'literal-space-' + i }));
  const details = Array.from(h.details()); assert.equal(details[0], s.name); assert.ok(details.includes('NAW ' + s.id)); assert.ok(details.includes('Codex ' + s.nativeId));
  const joined = details.join('\n'); for (const room of h.ctx.state.rooms) assert.ok(joined.includes(room.name));
  assert.ok(joined.includes('0.1.0-alpha.157')); assert.match(joined, /[0-9]{2}:[0-9]{2}/, 'Recorded date/time remains in the full detail');
});
test('offline facts open in the existing menu while every original action remains disabled and guarded', () => {
  const h = harness(row(), false); h.open(); assert.equal(h.menus.length, 1); const options = h.menus[0];
  const facts = options.items.filter(item => item.type === 'label'), actions = options.items.filter(item => !item.type);
  assert.ok(facts.some(item => item.text === 'NAW synthetic-session')); assert.ok(actions.length > 4); assert.ok(actions.every(item => item.disabled));
  for (const id of ['rename', 'archive', 'window', 'copy-id', 'wake-session', 'continue', 'up']) options.onSelect(id);
  assert.deepEqual(h.actions, []); assert.deepEqual(h.copied, []);
});
test('the original connected copy action still receives the full stable ID; a later disconnect blocks stale selection', () => {
  const h = harness(row()); h.open(); const options = h.menus[0], ids = options.items.filter(item => !item.type).map(item => item.id);
  for (const id of ['rename', 'up', 'down', 'copy-id', 'copy-native-id', 'window', 'wake-session', 'archive']) assert.ok(ids.includes(id));
  assert.ok(options.items.filter(item => !item.type).every(item => !item.disabled));
  options.onSelect('copy-id'); assert.deepEqual(h.copied, ['synthetic-session']); h.ctx.disconnected = true; options.onSelect('archive'); assert.deepEqual(h.actions, []);
});
test('an unrecognized native state remains unknown rather than inheriting the default green dot', () => {
  const p = harness(row({ state: 'future-native-state' })).present();
  assert.equal(p.tone, 'disconnected'); assert.equal(p.marker, '!'); assert.ok(p.compact.includes('状态未报告'));
});
test('a nonblocking native question preserves working status rather than claiming the root awaits an answer', () => {
  const p = harness(row({ state: 'working', approval: { method: 'item/tool/requestUserInput', params: { isBlocking: false } } })).present();
  assert.ok(p.compact.includes('正在工作 · 有待回答问题')); assert.ok(!p.compact.startsWith('等待回答'));
});
test('generic native-input facts never invent a different provider in the full detail', () => {
  const h = harness(row({ provider: 'codex', nativeInputRequired: true }));
  assert.ok(!h.present().full.includes('Claude')); assert.ok(h.present().compact.includes('原生输入'));
});
test('a confirmed native resume switch keeps its existing explicit fact', () => {
  const p = harness(row({ state: 'stopping', nativeContextPending: { reason: 'resume' } })).present();
  assert.ok(p.compact.includes('原生已切换会话')); assert.ok(p.full.includes('原生已切换会话')); assert.equal(p.tone, 'disconnected');
});
test('waiting labels use the detail layout so their text cannot be sacrificed to badge/time cells', () => {
  for (const patch of [{ state: 'approval', approval: {} }, { claudeQuestion: {} }]) assert.equal(harness(row(patch)).present().detail, true);
});
// T-117 semantics on main: Claude's turn-end background report keeps its own text and dot colour.
test('an idle Claude row with reported background work shows that work, not ready', () => {
  const p = harness(row({ provider: 'claude', background: 2, backgroundKinds: ['shell', 'subagent'], backgroundAt: Date.now() })).present();
  assert.equal(p.compact, '后台任务在跑 · 2 项（命令 1、子 agent 1）'); assert.ok(p.full.startsWith('后台任务在跑 · 2 项')); assert.ok(!p.full.includes('主会话就绪'));
  assert.equal(p.workTone, 'bg-work'); assert.equal(p.marker, '…'); assert.equal(p.detail, true);
});
test('an idle Claude row whose background report is unconfirmed says so and is not plain ready', () => {
  const p = harness(row({ provider: 'claude', backgroundStale: true })).present();
  assert.equal(p.compact, '后台状态待核对'); assert.equal(p.workTone, 'bg-unknown'); assert.equal(p.marker, '!'); assert.equal(p.detail, true);
});
test('background work with running children keeps both facts', () => {
  const p = harness(row({ provider: 'claude', background: 1, backgroundKinds: ['shell'], backgroundAt: 0, fleet: [child('running', 'started')] })).present();
  assert.ok(p.compact.startsWith('后台任务在跑 · 1 项（命令）')); assert.ok(p.compact.includes('1 进行中')); assert.equal(p.workTone, 'bg-work');
});
test('an interrupted Claude row keeps both the native-input request and the unconfirmed background state', () => {
  // A real interrupt sets nativeInputRequired while the earlier working state left backgroundStale.
  const p = harness(row({ provider: 'claude', nativeInputRequired: true, backgroundStale: true })).present();
  for (const text of [p.compact, p.full]) { assert.ok(text.includes('原生输入'), text); assert.ok(text.includes('后台状态待核对'), text); }
  assert.equal(p.workTone, 'bg-unknown'); assert.equal(p.marker, '!');
});
test('a held question on an idle Claude row keeps its reported background work', () => {
  const p = harness(row({ provider: 'claude', claudeQuestion: {}, background: 1, backgroundKinds: ['shell'], backgroundAt: Date.now() })).present();
  for (const text of [p.compact, p.full]) { assert.ok(text.includes('等待回答'), text); assert.ok(text.includes('后台任务在跑 · 1 项（命令）'), text); }
  assert.equal(p.workTone, 'bg-work');
});
test('an exhausted recovery keeps reported background work in the compact line', () => {
  const p = harness(row({ provider: 'claude', background: 1, backgroundKinds: ['shell'], backgroundAt: Date.now(), capacityRecovery: { nativeId: 'synthetic-native', turnId: 'failed', status: 'exhausted', attempt: 3, reason: 'capacity' } })).present();
  assert.ok(p.compact.includes('后台任务在跑 · 1 项（命令）') && p.compact.includes('满载停下'), p.compact);
});
test('a Codex row has no background report and keeps its ordinary dot', () => {
  const p = harness(row({ provider: 'codex', background: 2 })).present(); assert.equal(p.workTone, '');
});
test('an open facts menu refreshes changed state or version in place and closes only when its actions, order or connection change', () => {
  const prefix = section('function renderSessions() {', '\n  const visible =');
  const facts = items => items.filter(item => item.type === 'label').map(item => item.text);
  const setup = () => { const h = harness(row()); h.ctx.renderVersions = h.ctx.renderSidebarGroups = () => {}; vm.runInContext(prefix + '\n}', h.ctx); h.open(); return h; };
  for (const [change, expected] of [[h => { h.record.state = 'working'; }, /正在工作/], [h => { h.record.runtimeVersion = '0.1.0-alpha.140'; }, /后台 0\.1\.0-alpha\.140/]]) {
    const h = setup(), opened = h.ctx.sessionMenu;
    h.record.liveDraft = 'UNSENT original draft'; h.ctx.renderSessions(); assert.strictEqual(h.ctx.sessionMenu, opened, 'Unrelated draft changes do not dismiss a facts menu'); assert.equal(h.updates.length, 0);
    change(h); h.ctx.renderSessions(); assert.strictEqual(h.ctx.sessionMenu, opened, 'A changed fact keeps the same menu open');
    assert.equal(h.updates.length, 1); assert.ok(facts(h.updates[0]).some(text => expected.test(text)), 'The open menu shows the changed fact');
    assert.deepEqual(h.updates[0].filter(item => item.type !== 'label'), h.menus[0].items.filter(item => item.type !== 'label'), 'Actions are unchanged');
    h.ctx.renderSessions(); assert.equal(h.updates.length, 1, 'No re-render without a further change');
  }
  for (const change of [h => { h.ctx.disconnected = true; }, h => { h.record.nativeId = undefined; }, h => { h.records.reverse(); }, h => { h.ctx.state.sessions = h.records.filter(r => r !== h.record); }]) {
    const h = setup(); change(h); h.ctx.renderSessions(); assert.equal(h.ctx.sessionMenu, null, 'A changed action list, order or connection closes the menu');
  }
});
