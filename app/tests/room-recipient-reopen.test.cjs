const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const spaces = require('../collaboration-spaces.cjs'), mentions = require('../room-mention.js');
const { ViewStore } = require('../view-store.cjs');
const source = fs.readFileSync(require.resolve('../renderer/renderer.js'), 'utf8');
const otherSpace = '11111111-1111-4111-8111-111111111111';
const plain = value => JSON.parse(JSON.stringify(value));
function actualFunction(name) {
  const start = source.indexOf(`function ${name}(`); assert.ok(start >= 0, name);
  const next = /\n(?:async )?function /g; next.lastIndex = start + 1;
  const end = next.exec(source); assert.ok(end, `function boundary for ${name}`);
  return source.slice(start, end.index);
}
function actualConst(name) {
  const match = source.match(new RegExp(`^const ${name} = .+;$`, 'm')); assert.ok(match, name);
  return match[0];
}
// Exercise both entry points: app startup has an inline restore block, while
// changing spaces uses restoreRoomView. Neither recipient check is stubbed.
const startupStart = source.indexOf('  const savedRecipient = savedRoomView.roomRecipient;');
const startupEnd = source.indexOf('\n  for (const [id, backup]', startupStart);
assert.ok(startupStart >= 0 && startupEnd > startupStart, 'actual startup recipient restore block');
const startupRecipient = source.slice(startupStart, startupEnd);
function fixture(records, spaceId) {
  const elements = new Map(), calls = [];
  const element = (id = '') => {
    if (id && elements.has(id)) return elements.get(id);
    const e = { value: '', selectionStart: 0, selectionEnd: 0, textContent: '', title: '', dataset: {}, children: [], selectedOptions: [],
      focus() {}, setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
      setAttribute() {}, removeAttribute() {}, addEventListener() {},
      replaceChildren(...children) { this.children = children; }, prepend(child) { this.children.unshift(child); } };
    if (id) elements.set(id, e); return e;
  };
  const context = vm.createContext({
    state: { sessions: plain(records), rooms: [{ id: 'shared' }, { id: otherSpace }] }, spaceId,
    selected: 'room', mode: 'chat', terminalLayout: 'split', roomSession: '', roomSurface: 'overview', ROOM_SURFACES: ['summary', 'stream', 'overview'],
    roomRecordScope: '', roomRecordReturn: null, roomFilterHistory: null,
    roomThread: '', roomReplyTo: '', pendingRoomFilter: '', roomDraftRevision: 0, roomSubmitting: null,
    roomViews: {}, roomHistories: new Map(), roomMention: null, roomMentionHistory: mentions.editHistory(),
    roomMentionEdit: null, mentionRange: null, mentionRoster: '', mentionOptions: [], mentionChanging: false,
    window: { nativeWorkspaceSpaces: spaces }, nativeWorkspaceMentions: mentions,
    $: element, node: (tag, text) => Object.assign(element(), { textContent: text }),
    uiNode: () => element(), toastMessage: key => calls.push(['toast', key]), render() {},
    attempt: fn => fn(), persistView() {},
    document: { execCommand(command, unused, value) {
      assert.equal(command, 'insertText'); element('shared-input').value = value; return true;
    } },
    api: new Proxy({}, { get: (_, method) => (...args) => { calls.push([method, args]); throw Error('No dispatch/native API is allowed'); } }),
  });
  const constants = ['inSpace', 'pairRevision', 'storedSpaces', 'spaceRecord', 'roomViewFields', 'focusedRoomMember', 'activeSessionId', 'current', 'members'];
  const functions = ['roomRecentPreview', 'participantLabel', 'archivedName', 'populateSelect', 'rememberRoomMemberView', 'restoreRoomMemberView', 'captureRoomView', 'restoreRoomView', 'persistedRoomViews', 'roomRecipient', 'normalizeRoomMention', 'closeMentions', 'chooseMention'];
  vm.runInContext(constants.map(actualConst).concat(functions.map(actualFunction)).join('\n'), context);
  return { context, element, calls };
}
function member(spaceId, id = 'member-b') {
  return spaces.withMembership({ id, name: 'Reviewer', provider: 'codex', nativeId: `native-${id}`,
    roomId: null, memberRevision: 0, owner: 'original-owner', liveDraft: 'Private unsent draft',
    queuedInputs: [{ id: 'original-queue', text: 'Original queued material' }] }, spaceId, true);
}
function choose(f, id = 'member-b') {
  f.context.chooseMention(id); assert.equal(f.context.roomRecipient(), id, 'a fresh explicit choice works');
  assert.equal(f.context.roomMention.memberRevision, spaces.membershipRevision(f.context.state.sessions.find(s => s.id === id), f.context.spaceId));
}
function save(t, f, dir) {
  if (!dir) { dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'naw-recipient-reopen-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); }
  f.context.captureRoomView();
  const view = { owner: 'synthetic-window', active: true, selected: 'room', spaceId: f.context.spaceId,
    draft: { id: 'member-b', text: 'Private recovery copy' }, roomViews: plain(f.context.persistedRoomViews()) };
  const store = new ViewStore(dir); store.load(); store.save([view]);
  assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);
  return dir;
}
function reopen(dir, records, spaceId, entry) {
  const [saved] = new ViewStore(dir).load(), f = fixture(records, spaceId), c = f.context;
  assert.deepEqual(saved.draft, { id: 'member-b', text: 'Private recovery copy' });
  c.roomViews = saved.roomViews;
  if (entry === 'startup') {
    // The actual startup block runs after this raw draft assignment.
    c.savedRoomView = c.roomViews[spaceId]; f.element('shared-input').value = c.savedRoomView.sharedDraft || '';
    vm.runInContext(startupRecipient, c);
  } else c.restoreRoomView();
  return f;
}
function invalid(f, raw) {
  assert.equal(f.element('shared-input').value, raw, 'the original @ text/body stays available');
  assert.equal(f.context.roomRecipient(), '', 'no stale recipient authority');
  assert.equal(f.context.roomMention.active, false, 'the saved address remains explicitly inactive');
  assert.deepEqual(f.calls, [], 'view recovery never sends, claims or calls a native API');
}
for (const spaceId of ['shared', otherSpace]) for (const entry of ['startup', 'space-view']) {
  test(`${entry}/${spaceId}: an inactive addressed draft survives disk reopen and rejoin without reviving`, t => {
    const original = member(spaceId), f = fixture([original], spaceId), c = f.context;
    f.element('shared-input').value = 'Keep this shared draft'; choose(f);
    const raw = f.element('shared-input').value, nativeBefore = plain(c.state.sessions[0]);
    c.state.sessions[0] = spaces.withMembership(c.state.sessions[0], spaceId, false);
    c.normalizeRoomMention(); invalid(f, raw);
    const dir = save(t, f), stored = new ViewStore(dir).load()[0].roomViews[spaceId];
    assert.equal(stored.roomRecipient, ''); assert.equal(stored.roomMention.active, false);
    assert.equal(stored.sharedDraft, raw, 'the old address actually crosses the disk boundary');
    const rejoined = spaces.withMembership(c.state.sessions[0], spaceId, true);
    assert.notEqual(spaces.membershipRevision(rejoined, spaceId), spaces.membershipRevision(original, spaceId));
    const next = reopen(dir, [rejoined], spaceId, entry); invalid(next, raw);
    for (const key of ['nativeId', 'owner', 'liveDraft', 'queuedInputs']) assert.deepEqual(plain(next.context.state.sessions[0][key]), nativeBefore[key]);
    next.context.normalizeRoomMention(); invalid(next, raw);
    choose(next); assert.equal(next.element('shared-input').value, raw, 'explicit reselection does not lose the body');
    save(t, next, dir);
    const chosenAgain = reopen(dir, [rejoined], spaceId, entry);
    assert.equal(chosenAgain.context.roomRecipient(), original.id, 'a newly selected current address persists');
    assert.deepEqual(chosenAgain.calls, []);
  });
  test(`${entry}/${spaceId}: leave/rejoin while the window is closed invalidates its still-active disk address`, t => {
    const original = member(spaceId), f = fixture([original], spaceId);
    f.element('shared-input').value = 'Retain the original body'; choose(f);
    const raw = f.element('shared-input').value, dir = save(t, f);
    const stored = new ViewStore(dir).load()[0].roomViews[spaceId];
    assert.equal(stored.roomRecipient, original.id); assert.equal(stored.roomMention.active, true);
    // The old view never received a leave snapshot; only the owning membership
    // writer changes its pair revision while the window is absent.
    const departed = spaces.withMembership(original, spaceId, false);
    const absent = reopen(dir, [departed], spaceId, entry); invalid(absent, raw);
    const replacement = member(spaceId, 'different-member-same-name');
    const sameName = reopen(dir, [departed, replacement], spaceId, entry); invalid(sameName, raw);
    const rejoined = spaces.withMembership(departed, spaceId, true);
    const next = reopen(dir, [rejoined], spaceId, entry); invalid(next, raw);
    save(t, next, dir);
    const again = reopen(dir, [rejoined], spaceId, entry); invalid(again, raw);
    choose(again); assert.equal(again.element('shared-input').value, raw);
  });
}


test('renaming the addressed member preserves raw draft but requires explicit reselection', () => {
  const f = fixture([member('shared')], 'shared');
  f.element('shared-input').value = 'Keep the intended body'; choose(f);
  const raw = f.element('shared-input').value;
  f.context.state.sessions[0].name = 'New visible name';
  f.context.normalizeRoomMention(); invalid(f, raw);
  choose(f); assert.equal(f.context.roomRecipient(), 'member-b');
  assert.ok(f.element('shared-input').value.endsWith('Keep the intended body'));
});
