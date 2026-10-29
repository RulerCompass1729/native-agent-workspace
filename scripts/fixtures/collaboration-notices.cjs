// Importing the original text in the standalone runner has no side effects.
const text = 'Original native notice: 内容未完整同步，请核对原生终端。\nSecond line stays readable. ' + 'long-native-token-'.repeat(12);
module.exports = { text };
if (typeof process.send === 'function') {
// This preload runs only inside the owned fixture daemon with an IPC channel.
require('./collaboration-overview.cjs');
const path = require('node:path');
const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '../..');
const { Workspace } = require(path.join(root, 'app/workspace.cjs'));
const create = Workspace.prototype.create;
Workspace.prototype.create = async function (...args) {
  const id = await create.apply(this, args), s = this.sessions.get(id);
  // Exercise an explicitly known empty context list as well as native notices.
  // Missing nativeContexts currently makes the reader's optional toggle add a
  // notice class; that existing rendering issue is outside this CSS repair.
  s.nativeContexts = [];
  s.messages.push(
    { id: 'fixture-notice-' + id, role: 'system', kind: 'gap', title: '原生记录', text, status: 'complete', incomplete: true, volatile: true },
    { id: 'fixture-system-' + id, role: 'system', text: 'Ordinary lifecycle notice', status: 'complete' },
    { id: 'fixture-assistant-' + id, role: 'assistant', text: 'Original **Markdown** reply.\nSecond source line.', status: 'complete' },
  );
  if (!this.room.messages.some(m => m.id === 'fixture-room-system')) this.room.messages.push({
    id: 'fixture-room-system', role: 'system', name: 'Workspace', text: 'Original shared lifecycle notice', status: 'complete',
  });
  this.changed(); return id;
};
}
