const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Workspace } = require('../workspace.cjs'), { Claude } = require('../adapters.cjs');
const { ProgressJournal } = require('../observation.cjs'), locale = require('../ui-locale.js');
test('actual Claude hook titles pass through progress and volatile blocks while native text, identity and drafts stay raw', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-hook-locale-'));
  const host = { binaries: {}, close() {}, create() { throw Error('Unexpected provider start'); } }, w = new Workspace(host, directory);
  const record = { id: 'synthetic', nativeId: '11111111-1111-4111-8111-111111111111', provider: 'claude', name: 'RAW NAME 中文', owner: 'original-owner', cwd: directory, state: 'idle', messages: [], fleet: [] };
  t.after(() => { w.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const r = new Claude(record, host, { attachOnly: true }); w.sessions.set(record.id, record); w.runtimes.set(record.id, r); w.bind(record, r); w.drafts.set(record.id, 'UNSENT 中文');
  const titles = { PermissionRequest: ['等待原生权限确认', 'Waiting for native permission approval'], Notification: ['原生通知', 'Native notification'], StopFailure: ['原生请求失败', 'Native request failed'] };
  for (const [hook, [title, english]] of Object.entries(titles)) {
    const body = 'RAW native ' + hook + ' 中文 <tag>{key}\n';
    r.hook({ session_id: record.nativeId, hook_event_name: hook, message: body });
    const row = record.messages.find(row => row.title === title); assert.ok(row, hook); assert.equal(row.text, body);
    assert.equal(locale.displayText('en', row.title, row.uiTitleMessage), english);
    const observed = w.progress.get(record.id).snapshot().items.find(item => item.kind === hook);
    assert.equal(locale.displayText('en', observed.title, observed.uiTitleMessage), english);
    assert.equal(observed.text, body);
  }
  r.hook({ session_id: record.nativeId, hook_event_name: 'PreToolUse', tool_use_id: 'raw-tool', tool_name: '原生通知' });
  const native = record.messages.find(row => row.id.endsWith('observation:raw-tool'));
  assert.equal(native.title, '原生通知'); assert.equal(native.uiTitleMessage, undefined);
  assert.equal(locale.displayText('en', native.title, native.uiTitleMessage), '原生通知');
  w.persist(); const stored = JSON.parse(fs.readFileSync(path.join(directory, 'workspace.json'), 'utf8')).sessions[0];
  assert.equal(stored.messages.some(row => row.id.includes(':observation:')), false, 'Raw legacy observations retain their existing ephemeral privacy boundary');
  assert.equal(record.nativeId, '11111111-1111-4111-8111-111111111111'); assert.equal(record.owner, 'original-owner'); assert.equal(w.drafts.get(record.id), 'UNSENT 中文');
});
test('progress title metadata follows its raw title, survives text/status updates, and clears on an identical raw native replacement', () => {
  const journal = new ProgressJournal(), own = locale.createNotice('notice.run.approval');
  const first = journal.update({ id: 'same', title: own.text, uiTitleMessage: own.uiMessage, text: 'RAW result 中文' }).item;
  assert.equal(locale.displayText('en', first.title, first.uiTitleMessage), 'Waiting for native permission approval');
  const time = first.time;
  const update = journal.update({ id: 'same', status: 'completed', delta: '\nRAW native delta' }).item;
  assert.equal(update.time, time); assert.equal(update.text, 'RAW result 中文\nRAW native delta'); assert.deepEqual(update.uiTitleMessage, first.uiTitleMessage);
  const raw = journal.update({ id: 'same', title: own.text }).item;
  assert.equal(raw.uiTitleMessage, undefined); assert.equal(locale.displayText('en', raw.title, raw.uiTitleMessage), own.text);
  for (const value of [own.uiMessage, { version: 1, key: 'notice.unknownFuture', params: {} }, { version: 1, key: 'notice.run.approval', params: { native: 'x'.repeat(20000) } }]) {
    const row = journal.update({ id: 'same', title: 'RAW native 中文'.repeat(100), uiTitleMessage: value }).item;
    assert.equal(row.title.length, 300); assert.equal(row.uiTitleMessage, undefined);
  }
  for (let i = 0; i < 220; i++) journal.update({ id: String(i), title: own.text, uiTitleMessage: own.uiMessage, text: 'y'.repeat(12000) });
  const state = journal.snapshot(); assert.ok(state.items.length <= 200); assert.ok(Buffer.byteLength(JSON.stringify(state)) <= 1024 * 1024); assert.equal(state.truncated, true);
});
