// Only synthetic providers. Seed distinct original/shared message identities.
require('./background-control.cjs');
const path = require('node:path');
const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '../..');
const { Workspace } = require(path.join(root, 'app/workspace.cjs'));
const bind = Workspace.prototype.bind; let workspace;
Workspace.prototype.bind = function (...args) { workspace = this; return bind.apply(this, args); };
process.prependListener('message', request => {
  if (request.method !== 'streamSeed') return;
  const now = Date.now(), room = workspace.roomFor('shared'); room.messages = [];
  for (const [index, session] of [...workspace.sessions.values()].entries()) {
    const text = ['已完成输入框修复，等待审查。', '截图已经准备好，请确认宽窄窗口的效果。', '消息归属核对通过，正在补回归测试。', '构建已经通过，下一步核对安装包。', '需要你决定：是否采用这组图标？', '已记录今日任务，原会话保持可用。'][index];
    const time = index === 0 ? now - 86400000 : now - (6 - index) * 60000;
    const original = { id: 'native-original-' + index, nativeId: session.nativeId, role: 'assistant', text, time, status: 'complete' };
    session.messages = [original];
    room.messages.push({ ...original, id: 'shared-copy-' + index, sessionId: session.id, name: session.name, nativeMessageId: original.id, sharedStream: true });
    workspace.changed(session.id);
  }
  room.messages.push({ id: 'without-original', role: 'assistant', sessionId: request.target, name: 'Codex A', text: '旧记录没有原消息编号，仍能返回原会话。', time: now - 1000 });
  workspace.changed();
});
