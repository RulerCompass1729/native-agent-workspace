const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../renderer/renderer.js'), 'utf8');
const locale = require('../ui-locale.js'), { backendPlan } = require('../backend-switch.cjs');
function fixture(language = 'zh') {
  const c = vm.createContext({ uiText: (key, params) => locale.format(language, key, params),
    window: { nativeWorkspaceLocale: locale }, state: { sessions: [], appVersion: '0.1.0-alpha.265' } });
  vm.runInContext(source.slice(source.indexOf('function versionValue('), source.indexOf('function sidebarPresentation(')), c);
  vm.runInContext(source.slice(source.indexOf('function backendOptionLabel('), source.indexOf('function runBackendOption(')), c);
  return c;
}
const old = { id: 'ended', state: 'ended', runtimeVersion: '0.1.0-alpha.251' };
test('old record counts include ended records once and exclude archived/current/unknown ended records', () => {
  const c = fixture(), records = [old, { ...old }, { ...old, id: 'busy', state: 'working' },
    { ...old, id: 'archived', archived: true }, { ...old, id: 'current', runtimeVersion: c.state.appVersion },
    { ...old, id: 'unknown', runtimeVersion: undefined }];
  const before = JSON.stringify(records), summary = c.backendVersionSummary(records, c.state.appVersion);
  assert.equal(summary.old, 2); assert.equal(summary.oldEnded, 1); assert.equal(summary.count, 3); assert.equal(summary.ended, 2);
  assert.equal(JSON.stringify(records), before);
});
for (const language of ['zh', 'en']) test(`${language}: record wording and migration status are explicit without inventing a switch value`, () => {
  const c = fixture(language); c.state.sessions = [old]; c.state.switchEnded = ['unrelated', 'unrelated2'];
  assert.equal(locale.format(language, 'version.summaryOld', { old: 14, more: '' }), language === 'zh' ? '14条旧后台记录' : '14 records on older backends');
  assert.match(c.backendMigrationSummary({ migrate: true }), language === 'zh' ? /1条记录（1条已结束）.*自动迁移已开/ : /1 records \(1 ended\).*Auto-migration is on/);
  assert.match(c.backendMigrationSummary({ migrate: false }), language === 'zh' ? /自动迁移已关/ : /Auto-migration is off/);
  assert.match(c.backendMigrationSummary({}), language === 'zh' ? /迁移设置未确认/ : /Migration setting unverified/);
  assert.match(locale.format(language, 'version.migrationHelp'), language === 'zh' ? /安全检查和安静期/ : /safety and quiet-period checks/);
});
for (const [state, reason] of [['working', '有人正在工作'], ['ended', '原生进程退出待核实'], ['idle', '终端输入待核实']]) {
  test(`actual structured ${state} plan explains the group without parsing raw text or changing its action`, () => {
    const record = { id: 's', nativeId: 'n', name: 'Demo', provider: 'claude', state, terminalInputPending: true,
      processIdentity: state === 'ended' ? { pid: process.pid } : null };
    const plan = backendPlan({ servicePid: 42, capabilities: ['atomicShutdown', 'resume', 'conditionalMaintenanceStopV1'], sessions: [record] });
    const option = { version: '0.1.0-alpha.251', count: 1, ready: false, switch: plan, sessions: [{ id: 's', name: 'Demo' }] };
    const before = JSON.stringify(option), label = fixture().backendOptionLabel(option);
    assert.ok(label.includes(reason), label); assert.ok(label.startsWith('α251 · '));
    assert.ok(label.includes(plan.ready ? '结束并更新…' : '查看原因'));
    assert.equal(JSON.stringify(option), before);
  });
}
test('unknown or mismatched metadata cannot turn raw error prose into a claimed blocker', () => {
  const c = fixture(), option = { count: 1, ready: false, reason: '有人正在工作', reasonUiMessage: locale.createError('error.planWorking').uiMessage };
  option.reason = 'unmatched raw value';
  assert.ok(c.backendOptionLabel(option).includes('原因待核实'));
  delete option.reasonUiMessage; assert.ok(c.backendOptionLabel(option).includes('原因待核实'));
});
