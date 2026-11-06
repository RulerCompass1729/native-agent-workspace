const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const locale = require('../ui-locale.js');
const source = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
const start = source.indexOf("    if ($('invite-dialog').open) for");
const end = source.indexOf('    renderHeader(s, inRoom);', start);
assert.ok(start > 0 && end > start, 'Exercise the actual snapshot render block');
const refresh = source.slice(start, end);
function declaration(name) {
  const from = source.indexOf('function ' + name + '('), to = source.indexOf('\n}', from);
  assert.ok(from > 0 && to > from);
  return source.slice(from, to + 2);
}
function fixture(language = 'zh') {
  const state = { sessions: [], positivePrivateDraft: 'PRIVATE UNSENT', positiveSharedDraft: 'SHARED UNSENT' };
  const dialog = { open: true }, list = { children: [] }, writes = [];
  const context = { state, $: id => ({ 'invite-dialog': dialog, 'invite-list': list })[id], members: () => state.sessions,
    ui: { display: { text(element, key, params) { writes.push(key); element.textContent = locale.format(language, key, params); } } } };
  vm.createContext(context);
  vm.runInContext(declaration('sessionShortId') + '\n' + declaration('participantLabel'), context);
  function add(record, blocked) {
    state.sessions.push(record);
    const attributes = blocked ? { 'aria-disabled': 'true' } : {};
    const row = { dataset: { inviteSession: record.id }, attributes, disabled: false,
      getAttribute: key => attributes[key] ?? null, title: blocked ? locale.format(language, 'error.legacySpaceJoin', { name: record.name }) : '' };
    row.textContent = locale.format(language, blocked ? 'invite.legacyBlocked' : 'invite.joinName', { name: context.participantLabel(record, state.sessions) });
    list.children.push(row); return row;
  }
  return { state, dialog, list, writes, add, render: () => vm.runInContext(refresh, context) };
}

for (const language of ['zh', 'en']) test('snapshot refresh retains the visible legacy-backend reason: ' + language, () => {
  const f = fixture(language), row = f.add({ id: 'old-one', name: 'Synthetic legacy', provider: 'codex' }, true);
  const before = row.textContent, title = row.title, state = JSON.stringify(f.state);
  f.render(); f.render();
  assert.equal(row.textContent, before, 'A snapshot must not make a blocked choice look like an ordinary Join choice');
  assert.equal(row.attributes['aria-disabled'], 'true'); assert.equal(row.disabled, false, 'Reason remains keyboard reachable');
  assert.equal(row.title, title); assert.equal(f.list.children[0], row); assert.equal(JSON.stringify(f.state), state);
});
test('eligible choice still refreshes its name without changing its target or state', () => {
  const f = fixture('en'), row = f.add({ id: 'current-one', name: 'Before', provider: 'claude' }, false);
  f.state.sessions = [{ ...f.state.sessions[0], name: 'After' }]; f.render();
  assert.equal(row.textContent, 'Add After'); assert.equal(row.getAttribute('aria-disabled'), null);
  assert.equal(row.title, ''); assert.equal(f.list.children[0], row); assert.equal(row.dataset.inviteSession, 'current-one');
});
test('legacy choice retains the reason while names and collision labels refresh', () => {
  const f = fixture('en'), row = f.add({ id: 'abc12345-one', name: 'Before', provider: 'codex' }, true);
  f.state.sessions = [{ ...f.state.sessions[0], name: 'Same' }, { id: 'abc12345-two', name: 'Same', provider: 'codex' }];
  f.render(); assert.equal(row.textContent, 'Join Same · Codex · abc12345-o · Current backend cannot join new spaces');
  assert.equal(row.getAttribute('aria-disabled'), 'true'); assert.equal(f.list.children[0], row);
});
test('missing sessions and the explanatory paragraph are not relabelled as choices', () => {
  const f = fixture(), row = f.add({ id: 'old-one', name: 'Original', provider: 'codex' }, true), before = row.textContent;
  const help = { dataset: {}, textContent: 'Original help' }; f.list.children.push(help); f.state.sessions = [];
  f.render(); assert.equal(row.textContent, before); assert.equal(help.textContent, 'Original help'); assert.deepEqual(f.writes, []);
});
test('closed invitation does not bind or replace inactive labels', () => {
  const f = fixture(), row = f.add({ id: 'old-one', name: 'Original', provider: 'codex' }, true), before = row.textContent;
  f.dialog.open = false; f.render(); assert.equal(row.textContent, before); assert.deepEqual(f.writes, []);
});
