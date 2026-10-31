const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../renderer/renderer.js'), 'utf8');
const context = vm.createContext({});
vm.runInContext(source.slice(source.indexOf('function versionValue('), source.indexOf('function renderVersions(')), context);
const plain = value => value === null ? null : JSON.parse(JSON.stringify(value));
test('a backend version is compared only to the application, with no other backend fallback', () => {
  const current = '0.1.0-alpha.128';
  assert.equal(context.backendVersionNotice({ runtimeVersion: current }, current), null);
  assert.deepEqual(plain(context.backendVersionNotice({}, current)), { kind: 'unknown', label: '版本未知', title: '这个会话的后台未报告版本，不能用新会话后台的版本代替。' });
  assert.equal(context.backendVersionNotice({ runtimeVersion: '0.1.0-alpha.114' }, current).label, '旧后台');
  assert.equal(context.backendVersionNotice({ runtimeVersion: 'development' }, current).label, '版本不同');
  assert.match(context.backendVersionNotice({ runtimeVersion: '0.1.0-alpha.129' }, current).title, /后台 0.1.0-alpha.129 · 应用 0.1.0-alpha.128/);
  assert.equal(context.backendVersionNotice({ runtimeVersion: current }, undefined).label, '版本不同');
});
test('the rail alpha shorthand is derived only from an exact numeric alpha version', () => {
  for (const [value, expected] of [['0.1.0-alpha.128', 'α128'], ['2.3.4-alpha.7', 'α7'], ['0.1.0-alpha.128-extra', '0.1.0-alpha.128-extra'], ['1.0.0', '1.0.0'], ['development', 'development'], [null, '?']]) assert.equal(context.compactAppVersion(value), expected);
});
test('the copied report contains version metadata and counts, excluding session or machine details', () => {
  const snapshot = { appVersion: '0.1.0-alpha.128', runtimeVersion: '0.1.0-alpha.128', appBuild: { commit: 'a'.repeat(40), installedAt: 1 },
    services: [{ version: '0.1.0-alpha.114', active: false, sessions: 2, cwd: '/synthetic/private-cwd' }, { version: '0.1.0-alpha.128', active: true, sessions: 1 }],
    cwd: '/synthetic/private-cwd', pid: 12345, sessions: [{ id: 'private-id', name: 'private-name', liveDraft: 'private-draft' }] };
  const before = structuredClone(snapshot), report = context.appVersionReport(snapshot);
  assert.equal(report, ['Native Agent Workspace', '应用版本：0.1.0-alpha.128', '提交号：' + 'a'.repeat(40), '安装时间：未记录', '后台仅报告版本号，未报告提交号。', '后台 1：0.1.0-alpha.114 · 保留会话 · 2 个会话', '后台 2：0.1.0-alpha.128 · 新会话 · 1 个会话'].join('\n'));
  for (const privateValue of ['/synthetic', 'private-id', 'private-name', 'private-draft', '12345']) assert.equal(report.includes(privateValue), false);
  assert.deepEqual(snapshot, before);
});
test('malformed metadata never turns into paths, extra report lines or an invented timestamp', () => {
  const report = context.appVersionReport({ appVersion: '/synthetic/private-path', appBuild: { commit: 'a'.repeat(40) + '\nprivate', installedAt: 1 }, services: [{ version: '1.0.0\nprivate', sessions: -1 }] });
  assert.match(report, /应用版本：未报告\n提交号：未记录\n安装时间：未记录/);
  assert.match(report, /后台 1：未报告 · 保留会话 · 未知 个会话$/);
  assert.equal(report.includes('private'), false);
});
test('version copy reports one acknowledged success or one readable failure without a raw-error replacement', async () => {
  const control = {}, toasts = []; let fail = true, copies = 0;
  Object.assign(context, { $: () => control, ui: {}, state: { appVersion: '1.0.0' }, toast: text => toasts.push(text), api: { async copy() { if (fail) throw Error('Synthetic raw clipboard error'); copies++; } } });
  vm.runInContext(source.slice(source.indexOf('ui.copyCode = async'), source.indexOf("$('toast-close').onclick")), context);
  vm.runInContext(source.slice(source.indexOf('async function attempt(action)'), source.indexOf('function persistView()')), context);
  vm.runInContext(source.split('\n').find(line => line.startsWith("$('app-version').onclick")), context);
  await control.onclick(); assert.equal(copies, 0); assert.deepEqual(toasts, ['复制失败，请重试。']);
  fail = false; await control.onclick(); assert.equal(copies, 1); assert.deepEqual(toasts, ['复制失败，请重试。', '已复制']);
});
test('a version click before the first snapshot neither throws nor copies incomplete data', async () => {
  const control = {}; let copies = 0;
  Object.assign(context, { $: () => control, state: undefined, ui: { copyCode() { copies++; return Promise.resolve(); } } });
  vm.runInContext(source.split('\n').find(line => line.startsWith("$('app-version').onclick")), context);
  await assert.doesNotReject(async () => control.onclick()); assert.equal(copies, 0);
});

test('copied installation time is exact UTC receipt data or explicitly unknown', () => {
  const stamp = '2026-10-30T06:08:01.000Z';
  const snapshot = { appVersion: '0.1.0-alpha.130', appBuild: { commit: 'a'.repeat(40), installedAt: stamp } };
  assert.ok(context.appVersionReport(snapshot).includes('安装时间：' + stamp));
  for (const value of [stamp + '\nprivate', '2026-02-30T06:08:01.000Z', null, 1793330881000]) {
    assert.ok(context.appVersionReport({ ...snapshot, appBuild: { ...snapshot.appBuild, installedAt: value } }).includes('安装时间：未记录'));
  }
});
