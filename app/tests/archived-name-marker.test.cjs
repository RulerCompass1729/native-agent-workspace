// The person, 2026-11-13 (queue item from the butler): archived sessions often share a name with one still in use,
// so an archived session's name, in lists and in the log, starts with 「[archived]」 (「[已归档]」 in Chinese). The
// marker comes from the archived flag: the stored name is not changed and restoring drops it. Synthetic records only.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const locale = require('../ui-locale.js'), messages = require('../ui-messages.js');
const stewardRecord = require('../steward-record.cjs');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const renderer = read('renderer/renderer.js'), readingList = read('renderer/reading-list.js');
// A top-level declaration up to the next one.
function declaration(source, name) {
  const start = source.indexOf(`function ${name}(`); assert.ok(start >= 0, name);
  const next = /\n(?:async )?function |\n(?:const|let) /g; next.lastIndex = start + 1;
  const end = next.exec(source); assert.ok(end, name);
  return source.slice(start, end.index + 1);
}
const take = (source, from, to) => { const start = source.indexOf(from), end = source.indexOf(to, start); assert.ok(start >= 0 && end > start, from); return source.slice(start, end); };
const LIVE = 'aaaaaa01-0000-4000-8000-000000000001', OLD = 'bbbbbb02-0000-4000-8000-000000000002', SOLO = 'cccccc03-0000-4000-8000-000000000003';
const sessions = () => [
  { id: LIVE, name: 'Claude 2', provider: 'claude', state: 'idle' },
  { id: OLD, name: 'Claude 2', provider: 'claude', state: 'ended', archived: true },
  { id: SOLO, name: 'Codex 后端', provider: 'codex', state: 'ended', archived: true },
];
function page(lang, state = { sessions: sessions() }) {
  const uiText = (key, params) => locale.format(lang, key, params);
  const context = vm.createContext({ state, uiText, window: { nativeWorkspaceLocale: locale },
    ui: { displayText: (raw, message) => locale.displayText(lang, raw, message), language: { getSnapshot: () => ({ active: lang }) } } });
  vm.runInContext([declaration(renderer, 'sessionShortId'), take(renderer, 'function participantLabel(', 'function timeline()'),
    declaration(renderer, 'queueMemberName'), declaration(readingList, 'readingDispatchMember'), declaration(readingList, 'readingOwnText')].join('\n'), context);
  return context;
}
const marker = { zh: '[已归档] ', en: '[archived] ' };

test('both catalogs carry the marker with the name after it', () => {
  assert.equal(messages.zh['session.archivedName'], '[已归档] {name}');
  assert.equal(messages.en['session.archivedName'], '[archived] {name}');
});

for (const lang of ['zh', 'en']) {
  test(`${lang}: an archived session is marked wherever its label is shown; the live one with the same name is not`, () => {
    const p = page(lang), [live, old, solo] = p.state.sessions, before = JSON.stringify(p.state);
    assert.equal(p.participantLabel(old, p.state.sessions), marker[lang] + 'Claude 2 · Claude · bbbbbb');
    assert.equal(p.participantLabel(live, p.state.sessions), 'Claude 2 · Claude · aaaaaa');
    assert.equal(p.participantLabel(solo, p.state.sessions), marker[lang] + 'Codex 后端');
    // Speaker names in a space's history: a reply, and a wake row between the two same-named sessions.
    assert.equal(p.roomMessageLabel({ role: 'assistant', sessionId: OLD, name: 'Claude 2', text: 'x' }), marker[lang] + 'Claude 2 · Claude · bbbbbb');
    assert.equal(p.roomMessageLabel({ role: 'system', wake: { senderId: LIVE, recipientId: OLD, senderName: 'Claude 2', recipientName: 'Claude 2' } }),
      `Claude 2 · Claude · aaaaaa → ${marker[lang]}Claude 2 · Claude · bbbbbb`);
    // The header, the window title and the queue's member name.
    assert.equal(p.archivedName(old), marker[lang] + 'Claude 2');
    assert.equal(p.archivedName(live), 'Claude 2');
    assert.equal(p.sessionWindowTitle(old), marker[lang] + 'Claude 2 — Native Agent Workspace');
    assert.equal(p.sessionWindowTitle(live), 'Claude 2 — Native Agent Workspace');
    assert.equal(p.queueMemberName(OLD), marker[lang] + 'Claude 2');
    assert.equal(p.queueMemberName(LIVE), 'Claude 2');
    assert.equal(JSON.stringify(p.state), before, 'the stored names and flags are not changed');
    // Restored: the marker goes with the flag.
    old.archived = false; solo.archived = false;
    assert.equal(p.participantLabel(old, p.state.sessions), 'Claude 2 · Claude · bbbbbb');
    assert.equal(p.participantLabel(solo, p.state.sessions), 'Codex 后端');
    assert.equal(p.queueMemberName(OLD), 'Claude 2');
  });

  test(`${lang}: 「NAW 派活 → name」 marks an archived recipient when shown; the stored line is unchanged`, () => {
    const p = page(lang), event = { id: 'e1', role: 'system', kind: 'queue', sessionId: OLD, time: 1, ...locale.createNotice('notice.queue.dispatched', { text: 'Fix the header', name: 'Claude 2' }) };
    const stored = JSON.stringify(event), descriptor = locale.displayMessage(event.uiMessage, 'notice.', event.text);
    assert.ok(descriptor);
    assert.equal(p.readingOwnText(event, descriptor), locale.format(lang, 'notice.queue.dispatched', { text: 'Fix the header', name: marker[lang] + 'Claude 2' }));
    assert.equal(JSON.stringify(event), stored);
    const live = { ...event, sessionId: LIVE };
    assert.equal(p.readingOwnText(live, descriptor), locale.format(lang, 'notice.queue.dispatched', { text: 'Fix the header', name: 'Claude 2' }));
    p.state.sessions[1].archived = false;
    assert.equal(p.readingOwnText(event, descriptor), locale.format(lang, 'notice.queue.dispatched', { text: 'Fix the header', name: 'Claude 2' }));
  });
}

test('the butler record flags archived sessions it names, and its dialog marks them in the language shown', async () => {
  const at = Date.parse('2026-11-13T12:00:00Z');
  const entries = [
    { kind: 'role', at, event: 'designated', session: { id: OLD } },
    { kind: 'step', at: at + 1, action: 'invoke', method: 'spaceAction', arguments: JSON.stringify(['room-a', 'queueAdd', ['Fix the header', OLD]]), state: 'complete', recorded: true },
    { kind: 'step', at: at + 2, action: 'invoke', method: 'spaceAction', arguments: JSON.stringify(['room-a', 'queueAdd', ['Fix the footer', LIVE]]), state: 'complete', recorded: true },
  ];
  const record = { entries: () => entries.map(e => ({ ...e })), periods: () => [] }, snapshot = { sessions: sessions(), rooms: [{ id: 'room-a', name: 'Room A' }] };
  const shown = stewardRecord.view(record, snapshot, { current: null, now: at + 10 });
  const byText = text => shown.entries.find(e => e.text === text);
  assert.deepEqual([shown.entries.find(e => e.kind === 'role').name, shown.entries.find(e => e.kind === 'role').nameArchived], ['Claude 2', true]);
  assert.deepEqual([byText('Fix the header').target, byText('Fix the header').targetArchived], ['Claude 2', true]);
  assert.equal(Object.hasOwn(byText('Fix the footer'), 'targetArchived'), false, 'a live session carries no flag');
  assert.equal(Object.hasOwn(stewardRecord.view(record, { ...snapshot, sessions: sessions().map(s => ({ ...s, archived: false })) }, { now: at }).entries.find(e => e.kind === 'role'), 'nameArchived'), false);

  const { bind } = require('../renderer/steward-record.js');
  const el = tag => ({ tag, children: [], className: '', textContent: '', dataset: {}, attrs: {}, hidden: false,
    append(...c) { this.children.push(...c); }, replaceChildren(...c) { this.children = c; }, setAttribute(k, v) { this.attrs[k] = v; }, addEventListener() {} });
  const find = (node, test) => [...(test(node) ? [node] : []), ...(node.children || []).flatMap(child => find(child, test))];
  for (const lang of ['zh', 'en']) {
    const dialog = { ...el('dialog'), id: 'd', open: false, showModal() { this.open = true; }, close() {} };
    await bind({ dialog, document: { createElement: el }, api: { stewardRecord: async () => shown }, text: (key, params) => locale.format(lang, key, params) }).open();
    const what = kind => find(dialog, n => n.tag === 'tr' && n.dataset.kind === kind).map(row => row.children[1].textContent);
    assert.deepEqual(what('invoke'), [
      locale.format(lang, 'stewardRecord.step.queueAddTo', { text: 'Fix the footer', space: 'Room A', target: 'Claude 2' }),
      locale.format(lang, 'stewardRecord.step.queueAddTo', { text: 'Fix the header', space: 'Room A', target: marker[lang] + 'Claude 2' }),
    ]);
    assert.deepEqual(what('role'), [locale.format(lang, 'stewardRecord.role.designated', { name: marker[lang] + 'Claude 2' })]);
  }
});
