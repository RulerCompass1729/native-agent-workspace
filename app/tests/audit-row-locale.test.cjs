const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { RoomState } = require('../room-state.cjs'), locale = require('../ui-locale.js');

// Rows the shared records show (ext-standing-audit-en-20261125): the action, undo step and
// creation labels were stored in one language. Names the agent or person chose stay as written.
const CJK = /[㐀-鿿　-〿＀-￯]/u;
const actor = { id: 'butler', nativeId: 'native-butler', name: '工作管家', provider: 'claude' };
function standing(lang, action, kind, target, extra = {}) {
  const f = (key, params) => locale.format(lang, key, params);
  return { actionText: f('background.action.' + action), undo: f('standing.undo.' + kind, { previous: extra.previous || '', home: extra.home ?? f('sidebar.independent') }),
    target: extra.creation ? f('standing.creationTarget', { target, model: extra.creation.model ?? f('standing.nativeDefault'), effort: extra.creation.effort ?? f('standing.nativeDefault') }) : target,
    ...(extra.creation ? { creation: extra.creation } : {}) };
}
function room(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-audit-locale-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, state: new RoomState(dir) };
}
function rows(dir) {
  const events = new RoomState(dir).apply({ sessions: [], rooms: [{ id: 'shared' }] }).rooms[0].events;
  return Object.fromEntries(events.map(e => [e.id.split(':').at(-1), e]));
}
const record = (id, method, args, state, standingGrant) => ({ id, actor, command: { method, arguments: args }, state, at: 1,
  ...(standingGrant ? { approvedBy: 'standing', standing: standingGrant } : {}) });

for (const written of ['zh', 'en']) test(`standing and asked audit rows written in ${written} read in the reader's language`, t => {
  const { dir, state } = room(t);
  state.recordControlOperation(record('archive', 'archiveSession', ['member'], 'complete', standing(written, 'archiveSession', 'archived', '新开发成员')));
  state.recordControlOperation(record('join', 'join', ['member', true], 'complete', standing(written, 'joinRoom', 'placement', '新开发成员')));
  state.recordControlOperation(record('create', 'create', [{ provider: 'claude', name: '新开发成员' }], 'complete',
    standing(written, 'create', 'created', '新开发成员', { creation: { model: null, effort: null } })));
  state.recordControlOperation(record('asked', 'create', [{ provider: 'codex' }], 'cancelled'));
  state.recordControlOperation(record('leave', 'spaceAction', ['room', 'join', ['member', false]], 'confirmation-required'));
  const shown = rows(dir);
  const en = id => locale.displayText('en', shown[id].text, shown[id].uiMessage), zh = id => locale.displayText('zh', shown[id].text, shown[id].uiMessage);
  assert.equal(en('archive'), '工作管家 · Archive session · 新开发成员 · Standing permission (Executed); Undo: Restore the original item from Archives');
  assert.equal(zh('archive'), '工作管家 · 归档会话 · 新开发成员 · 常设许可（已执行）；撤销：在归档列表中恢复原对象');
  assert.equal(en('join'), '工作管家 · Join or move to space · 新开发成员 · Standing permission (Executed); Undo: Move the member back to “Independent session” from its menu');
  assert.equal(zh('join'), '工作管家 · 加入或移动到空间 · 新开发成员 · 常设许可（已执行）；撤销：在成员菜单中移回「独立会话」');
  assert.equal(en('create'), '工作管家 · Create session · 新开发成员 · Model: Native default · Effort: Native default · Standing permission (Executed); Undo: Archive the new item from its menu; native sessions are retained');
  assert.equal(zh('create'), '工作管家 · 新建会话 · 新开发成员 · 模型：原生默认 · 思考强度：原生默认 · 常设许可（已执行）；撤销：在对象的菜单中归档；原生会话继续保留');
  assert.equal(en('asked'), '工作管家 requested Create session · You declined');
  assert.equal(zh('asked'), '工作管家 请求 新建会话 · 你已拒绝');
  assert.equal(en('leave'), '工作管家 requested Leave space · Waiting for your confirmation');
  assert.equal(zh('leave'), '工作管家 请求 离开空间 · 等待你确认');
  for (const id of Object.keys(shown)) assert.equal(CJK.test(en(id).replaceAll('工作管家', '').replaceAll('新开发成员', '')), false, id);
  // Storage keeps what was written; only the reading changes.
  const stored = new RoomState(dir).value.events.find(e => e.id.endsWith(':archive'));
  assert.equal(stored.uiMessage.labels, undefined);
  assert.equal(stored.uiMessage.params.command, locale.format(written, 'background.action.archiveSession'));
});

test('a chosen name or model is never translated, and a label that does not match its raw words is ignored', t => {
  const { dir, state } = room(t);
  const grant = standing('zh', 'create', 'created', '新建会话', { creation: { model: 'synthetic-model', effort: 'high' } });
  state.recordControlOperation(record('named', 'create', [{ provider: 'claude', name: '新建会话' }], 'complete', grant));
  state.recordControlOperation(record('renamed', 'rename', ['other', '归档会话'], 'complete',
    { actionText: locale.format('zh', 'background.action.rename'), target: '归档会话', undo: locale.format('zh', 'standing.undo.rename', { previous: '归档会话' }) }));
  const shown = rows(dir), en = id => locale.displayText('en', shown[id].text, shown[id].uiMessage);
  assert.equal(en('named'), '工作管家 · Create session · 新建会话 · Model: synthetic-model · Effort: high · Standing permission (Executed); Undo: Archive the new item from its menu; native sessions are retained');
  assert.equal(en('renamed'), '工作管家 · Rename another session · 归档会话 · Standing permission (Executed); Undo: Rename the item back to “归档会话” from its menu');
  const message = shown.named.uiMessage, plain = locale.format('en', message.key, message.params);
  for (const target of [{ key: 'standing.newSession' }, { key: 'error.operation' }, { key: 'background.action.create', params: { x: '1' } }])
    assert.equal(locale.displayText('en', shown.named.text, { ...message, labels: { ...message.labels, target } }), plain);
  assert.equal(locale.displayText('en', shown.named.text, { ...message, labels: { name: { key: 'background.action.create' } } }), plain);
});
