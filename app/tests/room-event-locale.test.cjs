const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { RoomState } = require('../room-state.cjs'), { withMembership } = require('../collaboration-spaces.cjs'), locale = require('../ui-locale.js');
test('actual room event producers persist bilingual owned notices while names, full notes and membership safeguards stay raw', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-room-event-locale-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const room = new RoomState(directory), notes = 'RAW {name} 中文\n'.repeat(600).slice(0, 8000), name = 'RAW name 中文', file = path.join(directory, 'RAW 文件.txt');
  let record = { id: 'synthetic', name, nativeId: 'native-original', model: 'RAW 模型', liveDraft: 'UNSENT 中文', pid: 17, roomId: null }; const calls = [];
  const client = { call: async (method, id, join) => { calls.push(method); if (method === 'initial') return { sessions: [{ ...record }] }; if (method === 'join') record = withMembership(record, 'shared', join); } };
  room.rename(name); room.notes(notes, room.value.revision); room.notes('', room.value.revision);
  room.addFiles([file]); room.removeFile(room.value.files[0].id, room.value.revision);
  await room.membership(client, record.id, true, name); await room.membership(client, record.id, false, name); await room.membership(client, record.id, true, name);
  await room.archiveRoom(client); await room.restoreRoom(client);
  const expected = [
    ['rename', '工作区改名为「'+name+'」', 'Workspace renamed to “'+name+'”'],
    ['notes', '更新了共享笔记（尚未发送给 agent）\n'+notes, 'Shared notes updated (not yet sent to an agent)\n'+notes],
    ['notes', '清空了共享笔记（不会撤回已经发送的内容）', 'Shared notes cleared (already sent content is not recalled)'],
    ['files', '添加了本机文件引用 · 尚未发送给 agent', 'Local file references added · Not yet sent to an agent'],
    ['files', '移除了文件引用 · 本机原文件保留', 'File reference removed · Original local file retained'],
    ['join', '加入了工作区 · 未发送历史或通知模型', 'Joined the workspace · No history sent or model notified'],
    ['leave', '离开了工作区 · 原生会话与已收到的内容保留', 'Left the workspace · Native session and received content retained'],
    ['archive', '工作区已归档 · 后续投递已暂停，原生任务仍可能继续', 'Workspace archived · Further deliveries paused; native tasks may still continue'],
    ['restore', '工作区已恢复 · 原记录与可用成员已保留，没有重发任务', 'Workspace restored · Records and available members retained; no tasks resent'],
  ];
  for (const [kind, raw, english] of expected) { const event = room.value.events.find(e => e.kind === kind && e.text === raw); assert.ok(event, kind); assert.equal(locale.displayText('en', event.text, event.uiMessage), english); assert.equal(locale.displayText('zh', event.text, event.uiMessage), raw); }
  const saved = new RoomState(directory); assert.deepEqual(saved.value.events, room.value.events);
  assert.ok(!calls.some(method => ['send', 'queue', 'steer', 'resume', 'input', 'run'].includes(method)));
  assert.equal(record.nativeId, 'native-original'); assert.equal(record.model, 'RAW 模型'); assert.equal(record.pid, 17); assert.equal(record.liveDraft, 'UNSENT 中文');
  assert.throws(() => room.notes('x'.repeat(8001), room.value.revision), /8000/);
});
