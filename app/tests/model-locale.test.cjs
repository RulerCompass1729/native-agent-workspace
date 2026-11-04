const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Workspace } = require('../workspace.cjs'), { Claude } = require('../adapters.cjs');
const { metadata, claudeMetadata } = require('../native-history.cjs'), locale = require('../ui-locale.js');
test('history placeholders are labeled only by their source branch; exact native model names and empty strings stay native', () => {
  const thread = { id: '11111111-1111-4111-8111-111111111111', cwd: '/synthetic', name: 'RAW 中文' };
  for (const info of [metadata(thread), claudeMetadata(thread.id, { cwd: thread.cwd })]) {
    assert.equal(info.model, '原生默认'); assert.equal(locale.displayText('en', info.model, info.modelUiMessage), 'Native default');
  }
  for (const model of ['', '原生默认', '原生未报告', 'RAW native-model 中文']) {
    const info = metadata({ ...thread, model }); assert.equal(info.model, model);
    assert.equal(locale.displayText('en', info.model, info.modelUiMessage), model);
  }
});
test('an actual Claude model fallback reaches the saved record, then a native model with the same Chinese text removes the label', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-model-locale-'));
  const host = { binaries: {}, close() {}, create() { throw Error('Unexpected native start'); } };
  const w = new Workspace(host, directory), record = { id: 'synthetic', nativeId: '11111111-1111-4111-8111-111111111111', provider: 'claude', name: 'RAW NAME 中文', owner: 'original-owner', cwd: directory, state: 'idle', messages: [], fleet: [] };
  t.after(() => { w.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const r = new Claude(record, host, { attachOnly: true }); w.sessions.set(record.id, record); w.runtimes.set(record.id, r); w.bind(record, r); w.drafts.set(record.id, 'UNSENT 中文');
  r.hook({ session_id: record.nativeId, hook_event_name: 'SessionStart' });
  assert.equal(record.model, '原生未报告'); assert.equal(locale.displayText('en', record.model, record.modelUiMessage), 'Not reported by native process');
  w.persist(); const stored = JSON.parse(fs.readFileSync(path.join(directory, 'workspace.json'))).sessions[0];
  assert.equal(locale.displayText('en', stored.model, stored.modelUiMessage), 'Not reported by native process');
  r.hook({ session_id: record.nativeId, hook_event_name: 'SessionStart', model: '原生未报告' });
  assert.equal(record.model, '原生未报告'); assert.equal(record.modelUiMessage, undefined);
  assert.equal(locale.displayText('en', record.model, record.modelUiMessage), '原生未报告');
  assert.equal(record.nativeId, '11111111-1111-4111-8111-111111111111'); assert.equal(record.owner, 'original-owner'); assert.equal(w.drafts.get(record.id), 'UNSENT 中文');
});
