// Synthetic providers only: two spaces' messages and member replies for the 总览 and 信息流 (R248/R249).
// The queue and its events are the app's space records; test-space-feed-ui.cjs writes them before launch.
require('./background-control.cjs');
const path = require('node:path');
const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '../..');
const { Workspace } = require(path.join(root, 'app/workspace.cjs'));
const bind = Workspace.prototype.bind; let workspace;
Workspace.prototype.bind = function (...args) { workspace = this; return bind.apply(this, args); };
function seed({ pm, a, b, c, design }) {
  const now = Date.now(), at = minutes => now - minutes * 60000, yesterday = now - 86400000;
  const s = id => workspace.sessions.get(id), shared = workspace.roomFor('shared'), other = workspace.roomFor(design);
  shared.messages = [
    { id: 'h-pm', role: 'human', recipientId: pm, name: '你 → 项目经理', text: '把今天要做的三件事排一下。', time: yesterday, deliveries: [{ id: 'tag-pm', recipientId: pm, recipientName: '项目经理' }] },
    { id: 'pm-final', role: 'assistant', sessionId: pm, name: '项目经理', sharedStream: true, sourceTag: 'tag-pm', nativeMessageId: 'pm-reply', finalReply: true, status: 'complete',
      text: '排好了：1. 输入框修复（A）；2. 图标（B）；3. 文档（我）。', time: yesterday + 60000 },
    { id: 'w-pm-a', role: 'system', kind: 'agent-wake', name: '项目经理 → Claude A', text: '发给原会话的自动消息：原生已接收。\nA，先修输入框，再补测试。', time: at(45),
      wake: { id: 'wake-pm-a', senderId: pm, recipientId: a, senderName: '项目经理', recipientName: 'Claude A', body: 'A，先修输入框，再补测试。' } },
    { id: 'tool-a', role: 'tool', sessionId: a, sharedStream: true, text: 'npm test', time: at(29) },
  ];
  other.messages = [
    { id: 'h-c', role: 'human', recipientId: c, name: '你 → 设计 A', text: '左栏改成保持原样，只高亮当前空间。', time: at(35), deliveries: [{ id: 'tag-c', recipientId: c, recipientName: '设计 A' }] },
    { id: 'c-final', role: 'assistant', sessionId: c, name: '设计 A', sharedStream: true, sourceTag: 'tag-c', nativeMessageId: 'c-reply', finalReply: true, status: 'complete',
      text: '好，原型里四个标签先画好了。', time: at(30) },
  ];
  s(pm).messages = [
    { id: 'tag-pm', role: 'user', origin: 'room', text: '把今天要做的三件事排一下。', time: yesterday },
    { id: 'pm-reply', role: 'assistant', status: 'complete', text: '排好了：1. 输入框修复（A）；2. 图标（B）；3. 文档（我）。', time: yesterday + 60000 },
    { id: 'pm-doc', role: 'assistant', status: 'complete', text: '文档写到一半，先列了信息流的六种记录。', time: at(3) },
  ];
  s(a).messages = [
    { id: 'a-wake', role: 'user', origin: 'agent-wake', name: '来自 项目经理', text: '[Workspace message from 项目经理 · x at 2026-11-23T00:00:00.000Z]\nA，先修输入框，再补测试。', time: at(45), wakeSource: { id: 'wake-pm-a', senderId: pm } },
    { id: 'a-done', role: 'assistant', status: 'complete', text: '修好了，测试 12 个全过。\nREADY lane/input-fix abc1234', time: at(21) },
  ];
  s(b).messages = [
    { id: 'b-dispatch', role: 'user', origin: 'naw-dispatch', name: 'NAW 派活', dispatchItem: 'aa11bb22-0000-4000-8000-000000000002', dispatchPurpose: { kind: 'queue' }, text: '【NAW 派活】图标风格定一下', time: at(39) },
    { id: 'b-reply', role: 'assistant', status: 'complete', text: '需要你决定：线框还是实心？推荐线框，因为和现有侧栏一致。', time: at(16) },
  ];
  s(c).messages = [
    { id: 'tag-c', role: 'user', origin: 'room', text: '左栏改成保持原样，只高亮当前空间。', time: at(35) },
    { id: 'c-reply', role: 'assistant', status: 'complete', text: '好，原型里四个标签先画好了。', time: at(30) },
    { id: 'c-more', role: 'assistant', status: 'complete', text: '标签宽度也对齐了。', time: at(25) },
  ];
  for (const id of [pm, a, b, c]) workspace.changed(id);
  workspace.changed();
}
// A delivered item stays open only while its member works; the app settles an idle member's item at launch.
function working(id) { workspace.sessions.get(id).state = 'working'; workspace.changed(id); }
process.prependListener('message', request => {
  const run = { feedSeed: seed, feedWorking: working }[request.method];
  if (!run) return;
  try { run(request.value); process.send({ requestId: request.id }); } catch (error) { process.send({ requestId: request.id, error: error.stack || String(error) }); }
});
