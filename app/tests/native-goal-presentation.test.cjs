const test = require('node:test'), assert = require('node:assert/strict');
const path = require('node:path'), fs = require('node:fs'), vm = require('node:vm');
const app = process.env.NAW_T117_APP_ROOT || path.resolve(__dirname, '..');
const fleet = require(path.join(app, 'renderer/fleet-observation.js'));
const collaboration = require(path.join(app, 'renderer/collaboration-overview.js'));
const locale = require(path.join(app, 'ui-locale.js'));
const labels = {
  active: ['持续目标已启用', 'Goal enabled'], paused: ['持续目标已暂停', 'Goal paused'],
  blocked: ['持续目标受阻', 'Goal blocked'], usageLimited: ['持续目标受额度限制', 'Goal usage limited'],
  budgetLimited: ['持续目标达预算上限', 'Goal budget reached'], complete: ['持续目标已完成', 'Goal complete'],
};
const record = (status, state = 'idle') => ({ provider: 'codex', nativeId: 'synthetic-goal-native', state,
  nativeGoal: { nativeId: 'synthetic-goal-native', status, observedAt: Date.now() } });

for (const language of ['zh', 'en']) for (const [status, names] of Object.entries(labels)) {
  test(language + ' existing session and member status show verified goal ' + status, () => {
    const r = record(status), text = (key, params) => locale.format(language, key, params), label = names[language === 'zh' ? 0 : 1];
    const before = JSON.stringify(r);
    assert.equal(fleet.fleetStatus(r, text('state.idle'), true, text), text('state.idle') + ' · ' + label);
    const facts = collaboration.statusFacts(r, true, Date.now(), language);
    assert.equal(facts.state, text('collab.ready') + ' · ' + label);
    assert.equal(facts.rootState, text('collab.ready'), 'The root state stays independently available');
    assert.equal(JSON.stringify(r), before, 'Presentation never edits native/session facts');
  });
}

test('never observed, Goals off and explicit cleared retain the original ready display and dot', () => {
  for (const goal of [undefined, null, { nativeId: 'synthetic-goal-native', status: null, observedAt: Date.now() }]) {
    const r = { ...record('blocked'), nativeGoal: goal };
    assert.equal(fleet.fleetStatus(r, '就绪'), '就绪');
    assert.equal(collaboration.statusFacts(r).state, '会话就绪');
    assert.equal(fleet.workTone(r), '');
  }
});

test('only a previously observed goal lost becomes unconfirmed, preserving the connection state', () => {
  const r = { ...record('blocked'), nativeGoal: { nativeId: 'synthetic-goal-native', known: false } };
  assert.equal(fleet.fleetStatus(r, '就绪'), '就绪 · 持续目标未确认');
  assert.equal(fleet.workTone(r), 'bg-unknown');
  r.transportDisconnected = true; r.state = 'disconnected';
  assert.equal(collaboration.statusFacts(r).state, '连接状态待核对 · 持续目标未确认');
  r.nativeGoal = null;
  assert.equal(collaboration.statusFacts(r).state, '连接状态待核对');
});

test('the goal hint never replaces a working turn or a pending approval', () => {
  let r = record('blocked', 'working');
  assert.equal(fleet.fleetStatus(r, '正在工作'), '正在工作 · 持续目标受阻');
  assert.equal(fleet.workTone(r), '');
  r = record('active', 'approval');
  assert.equal(collaboration.statusFacts(r).state, locale.format('zh', 'state.approval') + ' · 持续目标已启用');
  assert.equal(fleet.workTone(r), '');
});

test('goal dots distinguish blocked and enabled from ordinary ready while text provides the meaning', () => {
  assert.equal(fleet.workTone(record('blocked')), 'goal-stopped');
  assert.equal(fleet.workTone(record('usageLimited')), 'goal-stopped');
  assert.equal(fleet.workTone(record('budgetLimited')), 'goal-stopped');
  assert.equal(fleet.workTone(record('paused')), 'bg-unknown');
  assert.equal(fleet.workTone(record('active')), 'goal-enabled');
  assert.equal(fleet.workTone(record('complete')), '');
});

test('Claude background reports remain independent and private goal fields never become labels', () => {
  const r = { ...record('blocked'), provider: 'claude', background: 1, backgroundKinds: ['shell'] };
  assert.equal(fleet.workTone(r), 'bg-work');
  assert.ok(!fleet.fleetStatus(r, '就绪').includes('持续目标'));
  const c = record('blocked'); c.nativeGoal.objective = 'Synthetic private goal text';
  assert.ok(!fleet.fleetStatus(c, '就绪').includes('Synthetic private goal text'));
  c.nativeGoal.status = ['blocked'];
  assert.ok(!fleet.fleetStatus(c, '就绪').includes('持续目标受阻'), 'Malformed status cannot coerce into a known catalog key');
  c.nativeGoal.nativeId = 'another-native-thread';
  assert.ok(!fleet.fleetStatus(c, '就绪').includes('持续目标受阻'));
});

function sidebarPresentation(language = 'zh') {
  const source = fs.readFileSync(path.join(app, 'renderer/renderer.js'), 'utf8');
  const start = source.indexOf('function sidebarPresentation(record) {');
  const end = source.indexOf('\nfunction sidebarDetails(', start);
  assert.ok(start >= 0 && end > start);
  const context = { window: { nativeWorkspaceCollaboration: collaboration, nativeWorkspaceFleet: fleet },
    ui: { language: { getSnapshot: () => ({ active: language }) } },
    uiText: (key, params) => locale.format(language, key, params),
    states: { idle: 'state.idle', working: 'state.working', approval: 'state.approval' },
    disconnected: false, exhaustedRecovery: () => null, recoveryStatusSuffix: () => '', switchedAway: () => false };
  vm.createContext(context);
  return vm.runInContext(source.slice(start, end) + '\nsidebarPresentation', context);
}

test('the actual sidebar function preserves goal facts when compact child summaries replace the root label', () => {
  const present = sidebarPresentation(), r = record('blocked');
  r.fleet = [{ event: 'subAgentActivity', nativeId: 'synthetic-child', kind: 'started', stale: false, time: Date.now() }];
  const p = present(r);
  assert.ok(p.compact.includes('持续目标受阻'));
  assert.ok(p.full.includes('持续目标受阻'));
  assert.equal(p.compact.split('持续目标受阻').length, 2, 'The hint appears exactly once');
  assert.equal(p.tone, 'working', 'A running child is still running');
});
