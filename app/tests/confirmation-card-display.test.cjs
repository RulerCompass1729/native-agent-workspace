// 80184fc5 (2026-11-13): a new-session card in the butler's conversation showed the internal tool name
// ("mcp__native_workspace__workspace_control {"), the raw command twice and no human sentence. These are the page's
// own sentence builders, run from the renderer sources in both display languages.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const locale = require('../ui-locale.js'), operation = require('../background-operation.cjs');
const reading = fs.readFileSync(path.join(__dirname, '../renderer/reading-list.js'), 'utf8');
const renderer = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
const fn = (source, name) => { const found = source.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n}`)); assert.ok(found, name); return found[0]; };
function page(language, sessions = []) {
  // Like the page's lookup (dsh-client-locale translate): an unknown key comes back as the key itself, it does not throw.
  const sandbox = vm.createContext({ uiText: (key, params) => { try { return locale.format(language, key, params); } catch { return key; } }, state: { sessions },
    participantLabel: s => s.name, window: { nativeWorkspaceLocale: locale } });
  vm.runInContext(['uiTextKnown', 'readingNawTool', 'readingNawToolPreview'].map(name => fn(reading, name)).join('\n'), sandbox);
  vm.runInContext(['backgroundActionText', 'backgroundSummaryText', 'backgroundButtonKeys'].map(name => fn(renderer, name)).join('\n'), sandbox);
  return sandbox;
}
const tool = (title, input) => ({ role: 'tool', title, input: JSON.stringify(input, null, 2) });
const create = { action: 'invoke', method: 'create', arguments: [{ provider: 'claude', cwd: '/work/repo', name: 'Claude 5', skipPermissions: true }], operation_id: 'a' };
test('NAW tool rows are named for what they do, from Claude and from Codex, never by the internal tool name', () => {
  for (const [language, title, preview] of [['zh', 'NAW 操作', '新建会话「Claude 5」'], ['en', 'NAW action', 'Create session “Claude 5”']]) {
    const p = page(language);
    for (const name of ['mcp__native_workspace__workspace_control', 'native_workspace.workspace_control']) {
      const found = p.readingNawTool(tool(name, create));
      assert.equal(found.tool, 'control');
      assert.equal(locale.format(language, 'reading.nawTool.' + found.tool), title);
      assert.equal(p.readingNawToolPreview(found), preview);
    }
  }
  const p = page('zh', [{ id: 'butler', name: '大管家' }]);
  assert.equal(p.readingNawToolPreview(p.readingNawTool(tool('mcp__native_workspace__workspace_control', { action: 'snapshot' }))), '查看界面状态');
  assert.equal(p.readingNawToolPreview(p.readingNawTool(tool('mcp__native_workspace__workspace_message', { recipient_id: 'butler', message: 'hi' }))), '发给 大管家');
  // A method this build has no words for is said as a call, not dropped.
  assert.equal(p.readingNawToolPreview(p.readingNawTool(tool('mcp__native_workspace__workspace_control', { action: 'invoke', method: 'futureThing' }))), '调用 futureThing');
  // The butler's most frequent call has no action words of its own; it must not show a lookup key.
  assert.equal(p.readingNawToolPreview(p.readingNawTool(tool('mcp__native_workspace__workspace_control', { action: 'invoke', method: 'spaceAction', arguments: ['room', 'queueAdd', []] }))), '调用 spaceAction');
  // Other tools, and a look-alike name, are left as they are.
  for (const title of ['Bash', 'mcp__other__workspace_control', 'mcp__native_workspace__workspace_controls']) assert.equal(p.readingNawTool(tool(title, {})), null);
});
test('a creation card reads as one sentence in both languages, its risk from the command', () => {
  const summary = operation.operationSummary(create, { id: 'butler', name: '大管家' });
  assert.deepEqual(summary.risks, ['skipPermissions']);
  assert.equal(page('zh').backgroundSummaryText(summary), '新建会话「Claude 5」 · Claude · 文件夹 repo');
  assert.equal(page('en').backgroundSummaryText(summary), 'Create session “Claude 5” · Claude · Folder repo');
  assert.equal(page('zh').backgroundSummaryText(operation.operationSummary({ method: 'mysteryMethod', arguments: [] }, {})), '调用 mysteryMethod');
  assert.equal(page('en').backgroundSummaryText({ action: 'notInThisBuild', method: 'later', risks: [] }), 'Call later');
});
test('every way a new session is let off asking is marked; a stricter mode is not', () => {
  const risks = (options, method = 'create') => operation.operationSummary({ method, arguments: method === 'create' ? [options] : ['history-id', options] }, {}).risks;
  assert.deepEqual(risks({ provider: 'claude', settings: { permissionMode: 'bypassPermissions' } }), ['skipPermissions']);
  assert.deepEqual(risks({ provider: 'claude', skipPermissions: true, settings: { permissionMode: 'bypassPermissions' } }), ['skipPermissions']);
  assert.deepEqual(risks({ provider: 'claude', settings: { permissionMode: 'acceptEdits' } }), ['acceptEdits']);
  assert.deepEqual(risks({ provider: 'claude', settings: { permissionMode: 'auto' } }), ['autoApprove']);
  assert.deepEqual(risks({ provider: 'claude', settings: { permissionMode: 'auto' } }, 'importHistory'), ['autoApprove']);
  // dontAsk refuses whatever was not allowed beforehand; plan and manual ask as usual.
  for (const permissionMode of ['dontAsk', 'plan', 'manual']) assert.deepEqual(risks({ provider: 'claude', settings: { permissionMode } }), []);
  for (const language of ['zh', 'en']) for (const risk of ['skipPermissions', 'acceptEdits', 'autoApprove', 'approvePermission', 'stopsWork', 'writesFile'])
    assert.ok(locale.format(language, 'background.risk.' + risk));
});
test('names in the sentence are escaped as the card detail is, and unknown sessions are left out', () => {
  const summary = operation.operationSummary({ method: 'rename', arguments: ['target', 'New‮name'] }, { id: 'a' }, { sessions: [{ id: 'target', name: 'Tar​get' }] });
  assert.match(summary.name, /\\u202e/i); assert.match(summary.target, /\\u200b/i);
  assert.equal(operation.operationSummary({ method: 'rename', arguments: ['gone', 'x'] }, { id: 'a' }, { sessions: [] }).target, undefined);
});
test('the two buttons main asks with follow the display language; any other set keeps its stored labels', () => {
  const zh = page('zh'), asked = { buttons: ['取消', '确认此操作'], cancelId: 0 };
  assert.deepEqual([...zh.backgroundButtonKeys(asked)], ['common.cancel', 'background.confirm']);
  assert.deepEqual([...zh.backgroundButtonKeys({ buttons: ['Cancel', 'Confirm this action'], cancelId: 0 })], ['common.cancel', 'background.confirm']);
  assert.equal(zh.backgroundButtonKeys({ buttons: ['Cancel', 'Confirm'], cancelId: 0 }), null);
  assert.equal(zh.backgroundButtonKeys({ buttons: ['取消', '确认此操作', '其他'], cancelId: 0 }), null);
});
test('a card keeps its frame when the reading list redraws an unchanged record', () => {
  // The reading list rewrites each row's class name on every pass; the card class must come back even when the
  // record has not changed (the first hidden-window pictures showed bare cards).
  const sandbox = vm.createContext({ disconnected: false });
  vm.runInContext(fn(renderer, 'renderBackgroundControls'), sandbox);
  const classes = new Set(), item = { classList: { toggle: (name, on) => on ? classes.add(name) : classes.delete(name) } };
  const confirmation = { kind: 'message', options: { buttons: ['取消', '确认此操作'] } };
  for (const [op, expected] of [[{ state: 'confirmation-required', confirmation }, ['background-card']],
    [{ state: 'confirmation-required', confirmation, replacedBy: { time: 1, state: 'waiting' } }, ['background-void']],
    [{ state: 'complete' }, []]]) {
    classes.clear();
    const entry = { item, backgroundKey: JSON.stringify([op, false]) };
    sandbox.renderBackgroundControls(entry, { backgroundOperation: op });
    assert.deepEqual([...classes], expected);
  }
});
