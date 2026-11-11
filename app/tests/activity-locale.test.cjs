const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { Workspace } = require('../workspace.cjs'), { Codex } = require('../adapters.cjs');
const { uiActivity, uiError } = require('../ui-errors.cjs'), locale = require('../ui-locale.js');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-activity-locale-')), calls = [];
  const host = { binaries: {}, codexTargets: new Map(), close() {}, rpc: { call(...args) { calls.push(args); throw Error('No native RPC is allowed in this fixture'); } } };
  const workspace = new Workspace(host, directory);
  const record = { id: 'synthetic-session', nativeId: '11111111-1111-4111-8111-111111111111', provider: 'codex', name: 'RAW 中文 NAME', cwd: directory, state: 'idle', owner: 'original-window', messages: [], fleet: [], controlRevision: 0, memberRevision: 0 };
  const runtime = new Codex(record, host);
  workspace.sessions.set(record.id, record); workspace.runtimes.set(record.id, runtime); workspace.bind(record, runtime);
  workspace.setDraft(record.id, 'UNSENT 中文 {native}');
  t.after(() => { workspace.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { workspace, record, runtime, calls };
}

function statusFixture(record) {
  const bootstrap = fs.readFileSync(path.join(__dirname, '../dsh/bootstrap.js'), 'utf8');
  const start = bootstrap.indexOf('    function createDisplayBindings('), end = bootstrap.indexOf('    function mountWorkspace(', start);
  const createBindings = vm.runInNewContext('(' + bootstrap.slice(start, end).trim() + ')');
  let language = 'zh'; const attrs = new Map();
  const element = { textContent: '', childElementCount: 0, setAttribute: (key, value) => attrs.set(key, value), removeAttribute: key => attrs.delete(key) };
  const root = { querySelectorAll: () => [element] }, uiText = (key, params) => locale.format(language, key, params);
  const display = createBindings(uiText), ui = { display, displayText: (raw, message) => locale.displayText(language, raw, message) };
  const renderer = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
  const statement = renderer.split('\n').find(line => line.includes("ui.display.computed($('session-status'), 'text'"));
  assert.ok(statement);
  const terminalGuard = renderer.slice(renderer.indexOf('function terminalUnclaimed('), renderer.indexOf('function terminalCanInput('));
  // The status line also names a temporary Claude fallback version; take the real function with it.
  const pinText = renderer.slice(renderer.indexOf('function claudePinText('), renderer.indexOf('function nativeVersionText('));
  vm.runInNewContext(terminalGuard + pinText + statement, { terminalVisible: false, s: record, ui, uiText, $: () => element, sessionStatus: () => 'IDLE', disconnected: false, own: true, terminals: new Map() });
  return { element, switch(value) { language = value; display.refresh(root); } };
}

test('own activity changes language in place while raw native updates clear its previous descriptor', t => {
  const f = fixture(t);
  f.runtime.emit('activity', ...uiActivity('notice.activity.preparingGit'));
  const original = f.record.activity, status = statusFixture(f.record), before = JSON.stringify(f.workspace.snapshot());
  status.switch('en'); assert.equal(status.element.textContent, 'IDLE · Preparing the Git working copy. The native session has not started.');
  assert.equal(f.record.activity, original); assert.equal(JSON.stringify(f.workspace.snapshot()), before);
  const wire = JSON.parse(before).sessions[0]; assert.equal(locale.displayText('en', wire.activity, wire.activityUiMessage), status.element.textContent.slice(7));
  const raw = 'ORIGINAL native tool 中文 <body>{key}'; f.runtime.emit('activity', raw);
  assert.equal(Object.hasOwn(f.record, 'activityUiMessage'), false); status.switch('zh'); assert.equal(status.element.textContent, 'IDLE · ' + raw);
  f.runtime.emit('activity', ...uiActivity('notice.activity.preparingGit')); f.runtime.emit('activity', '');
  status.switch('en'); assert.equal(status.element.textContent, 'IDLE'); assert.equal(Object.hasOwn(f.record, 'activityUiMessage'), false);
  const error = uiError('error.sessionMissing'); f.runtime.emit('activity', error.message, error.uiMessage);
  status.switch('en'); assert.equal(status.element.textContent, 'IDLE · This session could not be found.');
  assert.equal(f.record.name, 'RAW 中文 NAME'); assert.equal(f.record.nativeId, wire.nativeId); assert.equal(f.record.owner, 'original-window');
  assert.equal(f.workspace.drafts.get(f.record.id), 'UNSENT 中文 {native}'); assert.deepEqual(f.calls, []);
});

test('actual Codex failure retains the undefined info scope, closes old grants and preserves the original native error body', t => {
  const f = fixture(t), closed = [];
  f.record.pendingTag = 'private-tag';
  f.workspace.sharedReplies.grants.set('shared-tag', { sessionId: f.record.id, runtime: f.runtime, tag: 'shared-tag' });
  f.workspace.sharedReplies.close = (...args) => closed.push(args);
  const raw = 'ORIGINAL native failure 中文 {body}';
  f.runtime.event({ method: 'error', params: { threadId: f.record.nativeId, error: { message: raw } } });
  assert.ok(closed.some(args => args[0] === 'shared-tag')); assert.ok(closed.some(args => args[0] === 'private-tag'));
  assert.equal(f.record.pendingTag, null);
  assert.equal(locale.displayText('en', f.record.activity, f.record.activityUiMessage), 'The native session returned an error. Check the original text or the terminal on this screen.');
  const originalRow = f.record.messages.find(row => row.text === raw); assert.ok(originalRow); assert.equal(Object.hasOwn(originalRow, 'uiMessage'), false);
  assert.equal(locale.displayText('zh', originalRow.text, originalRow.uiMessage), raw); assert.deepEqual(f.calls, []);
});

test('unknown and stale activity metadata always keeps the entire raw string', () => {
  const [text, message] = uiActivity('notice.activity.preparingGit');
  for (const uiMessage of [undefined, { ...message, version: 2 }, { ...message, params: { injected: 'OTHER' } }, message]) {
    const raw = text + '\nORIGINAL appended native detail';
    assert.equal(locale.displayText('en', raw, uiMessage), raw);
  }
});
