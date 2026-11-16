// 80184fc5 (2026-11-13): a new-session card in the butler's conversation showed the internal tool name
// ("mcp__native_workspace__workspace_control {"), the raw command twice and no human sentence. These are the page's
// own sentence builders, run from the renderer sources in both display languages.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const locale = require('../ui-locale.js'), operation = require('../background-operation.cjs');
const reading = fs.readFileSync(path.join(__dirname, '../renderer/reading-list.js'), 'utf8');
const renderer = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
const fn = (source, name) => { const found = source.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n}`)); assert.ok(found, name); return found[0]; };
function page(language, sessions = [], rooms = []) {
  // Like the page's lookup (dsh-client-locale translate): an unknown key comes back as the key itself, it does not throw.
  const sandbox = vm.createContext({ uiText: (key, params) => { try { return locale.format(language, key, params); } catch { return key; } }, state: { sessions, rooms },
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
  assert.equal(page('zh').backgroundSummaryText(summary), '新建会话「Claude 5」 · Claude · 目录 repo · 跳过权限确认');
  assert.equal(page('en').backgroundSummaryText(summary), 'Create session “Claude 5” · Claude · Folder repo · Skip permission prompts');
  assert.equal(page('zh').backgroundSummaryText(operation.operationSummary({ method: 'mysteryMethod', arguments: [] }, {})), '调用 mysteryMethod');
  assert.equal(page('en').backgroundSummaryText({ action: 'notInThisBuild', method: 'later', risks: [] }), 'Call later');
});
test('both shared-history commands name the actual space and warn that deletion keeps native history', () => {
  const names = { rooms: [{ id: 'shared', name: 'Project' }, { id: 'other', name: 'Other' }] };
  for (const [command, room] of [[{ method: 'clearSharedHistory', arguments: [] }, 'Project'],
    // The legacy renderer handler ignores arguments and always clears the default space.
    [{ method: 'clearSharedHistory', arguments: ['other'] }, 'Project'],
    [{ method: 'spaceAction', arguments: ['other', 'clearSharedHistory', []] }, 'Other']]) {
    const summary = operation.operationSummary(command, { id: 'agent' }, names);
    assert.equal(summary.room, room);
    assert.deepEqual(summary.risks, ['deletesSharedHistory']);
    assert.equal(page('zh').backgroundSummaryText(summary), `清空空间「${room}」的共享记录`);
    assert.equal(page('en').backgroundSummaryText(summary), `Clear shared records in “${room}”`);
    for (const language of ['zh', 'en']) {
      const p = page(language, [], names.rooms);
      assert.equal(p.readingNawToolPreview({ tool: 'control', input: { action: 'invoke', ...command } }), p.backgroundSummaryText(summary, true));
    }
    for (const language of ['zh', 'en']) assert.match(locale.format(language, 'background.risk.deletesSharedHistory'), language === 'zh' ? /原生会话历史保留/ : /native history is kept/);
  }
  // Merely archiving a space must not be described as permanent deletion.
  assert.deepEqual(operation.operationSummary({ method: 'archiveRoom', arguments: [] }, {}, names).risks, []);
});
test('the permanent strip counts confirmations separately from decisions and picture reviews', () => {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/activity-stream.js'), 'utf8');
  const sandbox = vm.createContext({}); vm.runInContext(source, sandbox);
  const label = (language, kinds) => sandbox.nativeWorkspaceActivityStream.waitingLabel(kinds.map(kind => ({ kind })),
    (key, params) => locale.format(language, 'stream.' + key, params));
  for (const [language, only, mixed, other] of [['zh', '有 2 件等你确认', '有 2 件等你确认 · 2 件等你', '2 件等你'],
    ['en', '2 actions need your confirmation', '2 actions need your confirmation · 2 waiting for you', '2 waiting for you']]) {
    assert.equal(label(language, ['background-confirmation', 'background-confirmation']), only);
    assert.equal(label(language, ['background-confirmation', 'decide', 'background-confirmation', 'look']), mixed);
    assert.equal(label(language, ['decide', 'look']), other);
    assert.equal(label(language, ['background-confirmation']), language === 'zh' ? '有 1 件等你确认' : '1 action needs your confirmation');
  }
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
test('the approved short confirmation label also covers the exact shared-history dialog, never custom choices', () => {
  const p = page('zh');
  for (const language of ['zh', 'en']) {
    const options = { buttons: ['common.cancel', 'os.clearSharedButton'].map(key => locale.format(language, key)), cancelId: 0 };
    assert.deepEqual([...p.backgroundButtonKeys(options, { action: 'clearSharedHistory' })], ['common.cancel', 'background.confirm']);
    assert.equal(p.backgroundButtonKeys(options, { action: 'create' }), null);
  }
  assert.equal(p.backgroundButtonKeys({ buttons: ['Cancel', 'Erase everything'] }, { action: 'clearSharedHistory' }), null);
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
    [{ state: 'complete' }, []],
    [{ state: 'confirmation-required', confirmation, disposition: 'invalidated' }, ['background-void']],
    [{ state: 'not-executed', disposition: 'expired' }, ['background-void']]]) {
    classes.clear();
    const entry = { item, backgroundKey: JSON.stringify([op, false]) };
    sandbox.renderBackgroundControls(entry, { backgroundOperation: op });
    assert.deepEqual([...classes], expected);
  }
});
