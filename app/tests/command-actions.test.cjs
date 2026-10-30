const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/reading-list.js'), 'utf8'), context);
function groups(messages, originals = messages) {
  context.messages = messages; context.originals = originals;
  return JSON.parse(vm.runInContext('JSON.stringify([...commandExplorations(messages, false, originals).values()])', context));
}
const read = (id, extra = {}) => ({ id, role: 'tool', toolKind: 'commandExecution', nativeId: 'N', turnId: 'T', commandSource: 'agent', status: 'complete', commandActions: [{ type: 'read', command: 'cat ' + id, name: id, path: '/' + id }], ...extra });
test('consecutive reads deduplicate names; native search/list labels and command exits remain inspectable', () => {
  const rows = [read('a'), read('b'), read('a2', { commandActions: read('a').commandActions }), read('search', { commandActions: [{ type: 'search', command: 'rg needle src', query: 'needle', path: 'src' }], exitCode: 1, status: 'failed' }), read('list', { commandActions: [{ type: 'listFiles', command: 'ls src', path: 'src' }] })];
  const result = groups(rows); assert.equal(result.length, 1); assert.equal(result[0].messages.length, 5);
  assert.equal(result[0].summary, 'Read a, b\nSearch needle in src (exit 1)\nList src'); assert.equal(result[0].error, '');
});
for (const [name, middle] of [
  ['assistant body', { id: 'body', role: 'assistant', text: 'Original body' }], ['summary', { id: 'summary', role: 'assistant', kind: 'summary', text: 'Original summary' }],
  ['turn boundary', { id: 'end', kind: 'turn', status: 'interrupted', nativeId: 'N', turnId: 'T' }],
  ['ordinary command', read('run', { commandActions: [{ type: 'unknown', command: 'cat misleading-name' }] })],
  ['user shell', read('user', { commandSource: 'userShell' })], ['missing actions', read('legacy', { commandActions: undefined })], ['observation gap', read('gap', { incomplete: true })]
]) test('exploration cannot cross ' + name, () => assert.equal(groups([read('a'), middle, read('b')]).length, 2));
for (const extra of [{ turnId: 'other' }, { nativeId: 'other' }, { sessionId: 'other' }, { inputTag: 'other' }, { promptId: 'other' }, { sourceTag: 'other' }, { replyTo: 'other' }, { displayTurnId: 'other' }])
  test('exploration preserves identity/authorization boundary ' + JSON.stringify(extra), () => assert.equal(groups([read('a'), read('b', extra)]).length, 2));
test('filtering out an assistant body cannot join separated source commands', () => {
  const a = read('a'), b = read('b'); assert.equal(groups([a, b], [a, { id: 'body', role: 'assistant', text: 'Break' }, b]).length, 2);
});
test('failed read is not merged into successful read names; interrupted command ends a group', () => {
  const result = groups([read('a'), read('missing', { status: 'failed', exitCode: 2 }), read('cancelled', { status: 'interrupted' }), read('b')]);
  assert.equal(result.length, 2); assert.equal(result[0].error, 'interrupted'); assert.match(result[0].summary, /Read missing \(exit 2\)/); assert.ok(!result[0].summary.includes('(failed)')); assert.match(result[0].summary, /cancelled \(interrupted\)/);
});

test('native failed nonzero search/read keeps exploration compact in live projection and history hydration', () => {
  const { toolContent } = require('../codex-tool-content.cjs'), { applyCodexProgress, applyCodexHistory } = require('../native-blocks.cjs');
  for (const action of [{ type: 'search', command: 'rg missing src', query: 'missing', path: 'src' }, { type: 'read', command: 'cat absent', name: 'absent', path: '/absent' }]) {
    const item = { id: 'command', type: 'commandExecution', command: action.command, commandActions: [action], source: 'agent', turnId: 'T', status: 'failed', exitCode: 1, aggregatedOutput: 'Native exact result' };
    const live = { nativeId: 'N', messages: [] }, history = { nativeId: 'N', messages: [] };
    applyCodexProgress(live, { id: item.id, source: 'codex-native', kind: item.type, turnId: 'T', status: 'failed', ...toolContent(item) });
    applyCodexHistory(history, [item], {});
    for (const rows of [live.messages, history.messages]) { const result = groups(rows)[0]; assert.equal(result.error, ''); assert.match(result.summary, /\(exit 1\)/); assert.ok(!result.summary.includes('failed')); assert.equal(rows[0].status, 'failed'); }
  }
});
test('ordinary compound captions retain every literal command without guessing operators or ambiguous shell quoting', () => {
  const actions = [{ type: 'read', command: 'cat file', name: 'file', path: '/file' }, { type: 'unknown', command: 'npm test' }];
  for (const [input, expected] of [["/bin/zsh -lc 'cat file && npm test'", 'cat file && npm test'], ['ambiguous shell representation', 'ambiguous shell representation'], ["/bin/zsh -lc 'echo '\"'\"'quoted'", "/bin/zsh -lc 'echo '\"'\"'quoted'"]]) {
    context.message = { input, commandActions: actions }; assert.equal(vm.runInContext('nativeCommandPreview(message)', context), expected);
  }
});

test('collapsed exploration counts observed actions, retaining duplicates and native exits without changing originals', () => {
  const rows=[read('a'),read('again',{commandActions:read('a').commandActions}),read('search',{commandActions:[{type:'search',command:'rg needle src',query:'needle',path:'src'}],exitCode:1,status:'failed'}),read('search2',{commandActions:[{type:'search',command:'rg other src',query:'other',path:'src'}],exitCode:1,status:'failed'}),read('list',{commandActions:[{type:'listFiles',command:'ls src',path:'src'}]})];
  const copy=structuredClone(rows),result=groups(rows)[0];
  assert.deepEqual(result.counts,{read:2,search:2,listFiles:1});
  assert.equal(result.caption,'2 次读取 · 2 次搜索 · 1 次列目录 · exit 1');
  assert.equal(result.summary,'Read a\nSearch needle in src (exit 1)\nSearch other in src (exit 1)\nList src');
  assert.deepEqual(rows,copy);assert.equal(result.error,'');
});
