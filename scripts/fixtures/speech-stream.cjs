// Synthetic providers only: seeds what was said in the default space, mixed with NAW's own records.
require('./background-control.cjs');
const path = require('node:path');
const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '../..');
const { Workspace } = require(path.join(root, 'app/workspace.cjs'));
const bind = Workspace.prototype.bind; let workspace;
Workspace.prototype.bind = function (...args) { workspace = this; return bind.apply(this, args); };
const { LONG } = require('./speech-stream-text.cjs');
function seed({ butler, pm, a, b }) {
  const now = Date.now(), at = minutes => now - minutes * 60000, yesterday = now - 86400000;
  const s = id => workspace.sessions.get(id), room = workspace.roomFor('shared');
  room.messages = [
    { id: 'h-pm', role: 'human', recipientId: pm, name: '你 → 项目经理', text: '把今天要做的三件事排一下。', time: yesterday,
      deliveries: [{ id: 'tag-pm', recipientId: pm, recipientName: '项目经理' }] },
    { id: 'sys-pause', role: 'system', name: '协作', text: '协作已暂停', time: yesterday + 1000 },
    { id: 'pm-final', role: 'assistant', sessionId: pm, name: '项目经理', sharedStream: true, sourceTag: 'tag-pm', nativeMessageId: 'pm-reply', finalReply: true, status: 'complete',
      text: '排好了：1. 输入框修复（A）；2. 文档（B）；3. 安装检查（大管家）。', time: yesterday + 60000 },
    { id: 'card', role: 'system', kind: 'background-operation', text: '确认改名', time: at(40), backgroundOperation: { id: 'op-1' } },
    { id: 'w-pm-a', role: 'system', kind: 'agent-wake', name: '项目经理 → Claude A', text: '发给原会话的自动消息：原生已接收。\nA，先修输入框，再补测试。', time: at(30),
      wake: { id: 'wake-pm-a', senderId: pm, recipientId: a, senderName: '项目经理', recipientName: 'Claude A', body: 'A，先修输入框，再补测试。' } },
    { id: 'tool-a', role: 'tool', sessionId: a, sharedStream: true, text: 'npm test', time: at(29) },
  ];
  s(pm).messages = [
    { id: 'tag-pm', role: 'user', origin: 'room', text: '把今天要做的三件事排一下。', time: yesterday },
    { id: 'pm-think', role: 'assistant', status: 'complete', phase: 'commentary', text: '先看队列。', time: yesterday + 30000 },
    { id: 'pm-reply', role: 'assistant', status: 'complete', text: '排好了：1. 输入框修复（A）；2. 文档（B）；3. 安装检查（大管家）。', time: yesterday + 60000 },
  ];
  s(a).messages = [
    { id: 'a-wake', role: 'user', origin: 'agent-wake', name: '来自 项目经理', text: '[Workspace message from 项目经理 · x at 2026-11-23T00:00:00.000Z]\nA，先修输入框，再补测试。', time: at(30), wakeSource: { id: 'wake-pm-a', senderId: pm } },
    { id: 'a-tool', role: 'assistant', kind: 'tool', text: 'npm test', time: at(29) },
    { id: 'a-mid', role: 'assistant', status: 'complete', phase: 'commentary', text: '先跑一遍测试。', time: at(28) },
    { id: 'a-done', role: 'assistant', status: 'complete', text: LONG, time: at(20) },
    { id: 'a-recover', role: 'user', origin: 'capacity-recovery', name: 'NAW', text: '继续', time: at(19) },
  ];
  s(b).messages = [
    { id: 'b-dispatch', role: 'user', origin: 'naw-dispatch', name: 'NAW 派活', dispatchItem: 'item-docs', dispatchPurpose: { kind: 'queue' }, text: '【NAW 派活】写文档：对话视图的说明。', time: at(25) },
    { id: 'b-reply', role: 'assistant', status: 'complete', text: '文档写好了，等审查。', time: at(15) },
    { id: 'b-wake', role: 'user', origin: 'agent-wake', name: '来自 大管家', text: `[Workspace message from 大管家 · ${butler} at 2026-11-23T00:00:00.000Z]\nB，文档进度怎么样？`, time: at(10), wakeSource: { id: 'wake-s-b', senderId: butler } },
    { id: 'b-answer', role: 'assistant', status: 'complete', text: '一半了，今晚交。', time: at(9) },
    { id: 'b-timer', role: 'user', origin: 'native', inputSource: 'codex_wakeup', name: '定时唤醒', text: 'wake', time: at(5) },
  ];
  for (const id of [pm, a, b]) workspace.changed(id);
  workspace.changed();
}
process.prependListener('message', request => {
  if (request.method === 'speechSeed') seed(request.value);
  else if (request.method === 'speechAdd') {
    const { pm, a } = request.value, room = workspace.roomFor('shared'), time = Date.now();
    room.messages.push({ id: 'w-new-' + time, role: 'system', kind: 'agent-wake', name: '项目经理 → Claude A', text: '发给原会话的自动消息：原生已接收。\n' + request.value.text, time,
      wake: { id: 'wake-new-' + time, senderId: pm, recipientId: a, senderName: '项目经理', recipientName: 'Claude A', body: request.value.text } });
    workspace.changed();
  } else if (request.method === 'speechMany') {
    const room = workspace.roomFor('shared'), start = Date.now() - 3600000;
    for (let n = 0; n < request.value.count; n++) room.messages.push({ id: 'many-' + n, role: 'human', recipientId: request.value.a, text: '第 ' + (n + 1) + ' 条', time: start + n * 1000,
      deliveries: [{ id: 'many-tag-' + n, recipientId: request.value.a, recipientName: 'Claude A' }] });
    workspace.changed();
  } else if (request.method === 'speechClear') {
    workspace.roomFor('shared').messages = [];
    for (const session of workspace.sessions.values()) { session.messages = []; workspace.changed(session.id); }
    workspace.changed();
  }
});
