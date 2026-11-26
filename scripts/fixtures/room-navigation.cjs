// Owned source-GUI data only. The existing transport fixture replaces NativeHost
// before the real daemon starts; there is no provider process or model request.
require('./collaboration-overview.cjs');
const assert = require('node:assert/strict'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '../..');
const { Workspace } = require(path.join(root, 'app/workspace.cjs'));
let instance;
const create = Workspace.prototype.create;
Workspace.prototype.create = function (...args) { instance = this; return create.apply(this, args); };
// Which session each read-only terminal snapshot was for: a page reads a terminal once when it first shows it.
const snapshotReads = [], snapshot = Workspace.prototype.terminalSnapshot;
Workspace.prototype.terminalSnapshot = function (id, ...rest) { snapshotReads.push(id); return snapshot.call(this, id, ...rest); };
const send = process.send;
process.send = function (message, ...args) { if (message?.stats) message.snapshotReads = snapshotReads.slice(); return send.call(this, message, ...args); };
process.on('message', async question => {
  if (!question.navigationRequest) return;
  const reply = { navigationReply: question.navigationRequest };
  try {
    assert.ok(instance && instance.sessions.size <= 5, 'Only the owned five-record fixture may be seeded');
    const records = [...instance.sessions.values()];
    assert.ok(records.every(s => s.name.startsWith('Synthetic route ')));
    if (question.method === 'seed') {
      assert.equal(records.length, 5); assert.equal(instance.room.messages.length, 0);
      const now = Date.now();
      records[2].nativeContextPending = { reason: 'synthetic-context-unconfirmed' };
      for (const [index, record] of records.entries()) record.messages.push({ id: randomUUID(), role: 'assistant', name: record.name,
        text: Array.from({ length: 72 }, (_, line) => `Synthetic member ${index + 1}, paragraph ${line + 1}: retain this reading position.`).join('\n\n'), status: 'complete', time: now - 2000 });
      const id = randomUUID();
      instance.room.messages.push(
        { id, role: 'human', name: 'You', recipientId: records[0].id, text: 'Synthetic manual request to member A', time: now - 1500, status: 'unconfirmed' },
        { id: randomUUID(), role: 'assistant', name: records[0].name, sessionId: records[0].id, replyTo: id, text: 'Synthetic explicitly associated reply from A', time: now - 1000, status: 'complete' },
        { id: randomUUID(), role: 'human', name: 'You', recipientId: records[1].id, text: 'Synthetic unrelated request to B', time: now - 500, status: 'submitted' },
        { id: randomUUID(), role: 'system', kind: 'agent-wake', name: 'Synthetic wake', text: 'Synthetic waiting message from B to A', time: now - 750, status: 'complete',
          wake: { senderId: records[1].id, senderName: records[1].name, recipientId: records[0].id, recipientName: records[0].name, body: 'Synthetic waiting message from B to A', status: 'waiting' } },
        { id: randomUUID(), role: 'system', name: 'Past member', sessionId: 'synthetic-departed-member', text: 'Synthetic retained historical record', time: now - 3000, status: 'complete' },
      );
      instance.changed(); instance.persist(); reply.seeded = true;
    } else throw Error('Unknown owned navigation fixture operation');
  } catch (error) { reply.error = error.message; }
  process.send(reply);
});
