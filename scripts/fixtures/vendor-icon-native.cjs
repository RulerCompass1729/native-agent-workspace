// Synthetic native identity events through the real service. Never a provider/model.
require('./native-progress.cjs');
const { NativeHost } = require('../../app/adapters.cjs');
const create = NativeHost.prototype.create;
NativeHost.prototype.create = function (record) {
  const runtime = create.call(this, record), start = runtime.start;
  runtime.start = async () => {
    await start();
    const vendor = { 'Synthetic Codex': 'openai', 'Synthetic DeepSeek': 'deepseek' }[record.name];
    if (vendor) runtime.emit('modelProvider', vendor);
  };
  return runtime;
};
// A synthetic shared reply exercises the real space-record message heading.
// No private history is read, and no production sharing/identity gate is changed.
const { Workspace } = require('../../app/workspace.cjs'), snapshot = Workspace.prototype.snapshot;
Workspace.prototype.snapshot = function () {
  const value = snapshot.call(this), member = value.sessions.find(s => s.name === 'Synthetic Codex');
  for (const room of [value.room, ...(value.rooms || [])].filter(r => r && (!r.id || r.id === 'shared'))) {
  if (member && !room.messages?.some(m => m.id === 'synthetic-shared-reply')) room.messages = [...(room.messages || []), { id: 'synthetic-shared-reply',
    role: 'assistant', sessionId: member.id, name: member.name, nativeId: member.nativeId,
    nativeMessageId: 'result-codex', turnId: 'synthetic-turn', sourceTag: 'synthetic-input',
    sharedStream: true, status: 'complete', time: 1794844800000, text: 'Synthetic shared result for the message-header icon.' }];
  }
  return value;
};
