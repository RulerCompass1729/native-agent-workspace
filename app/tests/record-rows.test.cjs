// The rows and cards of operation records, made once per record instead of for each state event (2026-11-25: 30 ms and
// 42 MB of garbage each with 4,473 records). The actual displayState, projections, omission and history store on
// synthetic records; what is kept is compared with what a controller that kept nothing makes of the same records.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { BackgroundControl } = require('../background-control.cjs');
const operation = require('../background-operation.cjs'), shownSessions = require('../shown-sessions.cjs'), confirmationInbox = require('../confirmation-inbox.cjs');
const { omitHidden, reportShown } = shownSessions;
const main = fs.readFileSync(require.resolve('../main.cjs'), 'utf8');
const START = Date.UTC(2026, 10, 25, 12), plain = value => structuredClone(value);

const sessionList = (count = 12) => Array.from({ length: count }, (_, i) => ({ id: 's' + i, nativeId: 'n' + i, provider: i % 2 ? 'codex' : 'claude', name: 'agent ' + i, archived: false, state: 'idle',
  // As on the person's disk: some lists without times, some with a step back, some in order.
  messages: Array.from({ length: 40 }, (_, j) => ({ id: `m${i}-${j}`, role: j % 4 ? 'assistant' : 'user', text: 'text ' + j,
    ...(i % 3 === 0 && j % 3 ? {} : { time: START + j * 1000 - (i % 3 === 1 && j % 10 === 9 ? 60000 : 0) }) })) }));
const roomList = () => [{ id: 'shared', name: 'Shared' }, { id: 'r1', name: 'Room 1' }];
let made = 0;
const withId = r => ({ ...r, command: { ...r.command, operation_id: r.id } });
const record = (i, extra = {}) => withId({ id: 'op' + ++made, at: START + (made * 7919 % 40) * 1000, finishedAt: START + made, state: 'complete',
  actor: { id: 's' + i, nativeId: 'n' + i, provider: i % 2 ? 'codex' : 'claude', name: 'agent ' + i },
  command: { action: 'invoke', method: 'spaceAction', arguments: ['r1', 'join', ['s5']] }, ...extra });
const asked = (i, extra = {}) => record(i, { state: 'confirmation-required', finishedAt: undefined, confirmationRequestedAt: START, guard: { sessions: [] },
  command: { action: 'invoke', method: 'rename', arguments: ['s5', 'new'] }, confirmation: { kind: 'message', options: { message: 'Rename?', detail: 'Full warning', buttons: ['Cancel', 'OK'], cancelId: 0 } }, ...extra });
const answered = i => asked(i, { state: 'complete', finishedAt: START + made, humanDecision: 1, humanDecisionAt: START + made });

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-record-rows-')); fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const clock = { now: START + 60000 };
  const control = new BackgroundControl({ dataDir: dir, handlers: new Map(), context: async () => ({}), now: () => clock.now });
  t.after(() => control.close());
  const archive = record => control.reappend(record);
  // The same records, objects and all, as nothing was kept of.
  const fresh = () => Object.assign(Object.create(BackgroundControl.prototype), control, {
    archivedBySession: new Map([...control.archivedBySession].map(([id, list]) => [id, plain(list)])), data: plain(control.data), namesSeen: undefined, commit(change) { const next = plain(this.data); change(next); this.data = next; } });
  const snapshot = { sessions: sessionList(), rooms: roomList(), room: roomList()[0] };
  return { clock, control, archive, fresh, snapshot, display: displays(control) };
}
// The actual displayState around a controller.
function displays(control) {
  const scope = { roomState: { apply: s => ({ ...s, sessions: s.sessions.map(x => ({ ...x })), rooms: s.rooms.map(r => ({ ...r })) }) }, sessionLabels: { apply: s => s }, submissionState: s => s, confirmationInbox,
    confirmationProjectionKeys: new WeakMap(), recordsChanged: () => {}, confirmationSnapshot: (_client, s) => s, leaveRecords: shownSessions.leaveRecords, backgroundControl: control, backgroundUnavailable: false,
    outboxQuitFailed: false, outboxUnavailable: false, queueSecretary: null, integratorRole: null, stewardRole: null, stewardWake: null, queueDispatcher: null, butlerIngress: null, localVendorIcons: () => ({}),
    roomPeerIdentity: () => null, endedByMove: () => [], viewStorageWarning: '', viewStorageWarningUiMessage: null, backgroundOperation: { conversationSnapshot: v => v }, conversationAccess: () => [] };
  const code = main.slice(main.indexOf('function displayState('), main.indexOf('function reportViewStorage('));
  return new Function(...Object.keys(scope), code + '; return displayState;')(...Object.values(scope));
}
const page = shown => ({ view: { spaceId: 'shared' }, win: {}, shown: shown && new Set(shown) });
// How often the words of a record are made while fn runs.
function projections(fn) {
  const { visibleText } = operation; let count = 0;
  operation.visibleText = text => { count++; return visibleText(text); };
  try { fn(); } finally { operation.visibleText = visibleText; }
  return count;
}
// The page, the bell, the strip, the phone and an agent read the same as from a controller that kept nothing, and
// the page reads the same as from the whole state.
function assertSame(f, step) {
  const fresh = f.fresh(), cold = displays(fresh), { snapshot, control } = f;
  for (const shown of [['s0', 's1', 's2'], [], snapshot.sessions.map(s => s.id), null]) {
    const context = page(shown), sent = plain(omitHidden(f.display(snapshot, context, null, true), context.shown));
    assert.deepStrictEqual(sent, plain(omitHidden(cold(snapshot, page(shown)), context.shown)), `${step}: page showing ${shown?.length}`);
    assert.equal(JSON.stringify(sent), JSON.stringify(plain(omitHidden(cold(snapshot, page(shown)), context.shown))), step + ': and in the same order');
  }
  assert.deepStrictEqual(plain(f.display(snapshot)), plain(cold(snapshot)), step + ': phone');
  const agent = { background: true, view: { selected: 's0' } };
  assert.deepStrictEqual(plain(f.display(snapshot, agent)), plain(cold(snapshot, agent)), step + ': agent');
  assert.deepStrictEqual(plain(f.display(snapshot, agent, null, true)), plain(cold(snapshot, agent)), step + ': agent, by a page path');
  assert.deepStrictEqual(plain(control.pending(snapshot)), plain(fresh.pending(snapshot)), step + ': strip');
  assert.deepStrictEqual(plain(control.confirmations(snapshot, snapshot)), plain(fresh.confirmations(snapshot, snapshot)), step + ': bell');
  assert.deepStrictEqual(control.confirmations(snapshot, snapshot).map(confirmationInbox.summaryText), fresh.confirmations(snapshot, snapshot).map(c => JSON.stringify(confirmationInbox.confirmationSummary(c))), step + ': bell text');
  assert.deepStrictEqual(plain(snapshot.sessions.map(s => control.rows(s.id, null))), plain(snapshot.sessions.map(s => fresh.rows(s.id, null))), step + ': agent rows');
}

test('a state event makes no record again, whatever the size of the archive', t => {
  const f = fixture(t), context = page(['s0', 's1', 's2']), event = () => f.display(f.snapshot, context, null, true), send = () => omitHidden(event(), context.shown);
  const fill = count => { for (let i = 0; i < count; i++) f.control.remember(i % 20 ? record(i % 12) : answered(i % 12)); };
  fill(400); f.control.commit(d => { for (let i = 0; i < 60; i++) d.records.push(record(i % 12)); });
  const cards = 20, first = projections(event);
  assert.ok(first > 0 && first <= cards * 12, `${first}: only the records with a card, not the rows of a session`);
  assert.equal(projections(event), 0, 'the second event');
  const shownRows = [0, 1, 2].reduce((sum, i) => sum + f.control.own('s' + i).length, 0);
  assert.ok(projections(send) > shownRows, 'the send makes the rows of the sessions shown');
  assert.equal(projections(send), 0, 'once');
  fill(400); projections(send); assert.equal(projections(send), 0, 'a longer archive adds nothing');
  f.control.remember(record(7)); assert.equal(projections(send), 0, 'a record of a session the page does not show is not read');
  f.control.remember(record(1)); const one = projections(send); assert.ok(one > 0 && one < 10, `${one}: the record that was added`);
});

test('what is kept reads as made anew through every change of a record or a name', async t => {
  const f = fixture(t), { control, snapshot } = f, edit = (find, values) => control.commit(d => Object.assign(d.records.find(find), values));
  for (let i = 0; i < 48; i++) f.archive(i % 6 ? record(i % 12, i % 5 ? {} : { state: 'unconfirmed', error: 'The outcome is unknown' }) : answered(i % 12));
  control.commit(d => { d.records.push(...[0, 1, 2, 7].map(i => record(i)), asked(0), asked(7), answered(2), record(1, { command: { action: 'invoke', method: 'stop', arguments: ['s5'] } })); });
  const steps = {
    first() {}, unchanged() {},
    'a session renamed': () => { snapshot.sessions[5] = { ...snapshot.sessions[5], name: 'renamed' }; },
    'renamed on the same object': () => { snapshot.sessions[5].name = 'renamed again'; },
    'a room renamed': () => { snapshot.rooms = [snapshot.rooms[0], { id: 'r1', name: 'Other room' }]; },
    'the provider of a stopped session': () => { snapshot.sessions[5].provider = 'claude'; },
    'sessions in another order': () => { snapshot.sessions.reverse(); },
    'a target under another id, its name the same': () => { snapshot.sessions = snapshot.sessions.map(s => s.id === 's5' ? { ...s, id: 's5b' } : s); },
    'and back': () => { snapshot.sessions = snapshot.sessions.map(s => s.id === 's5b' ? { ...s, id: 's5' } : s); },
    'two sessions under one id': () => { snapshot.sessions = [{ ...snapshot.sessions[0], id: 's5', name: 'first of the two' }, ...snapshot.sessions]; },
    'one of them gone': () => { snapshot.sessions.shift(); },
    'a card answered': () => edit(r => r.state === 'confirmation-required', { state: 'running', humanDecision: 1, humanDecisionAt: f.clock.now }),
    'its answer carried out': () => edit(r => r.state === 'running', { state: 'complete', finishedAt: f.clock.now }),
    'an outcome corrected': () => edit(r => r.state === 'complete', { state: 'unconfirmed', error: 'audit failed' }),
    'sent, native receipt awaited': () => edit(r => r.state === 'complete', { state: 'awaiting-native' }),
    'received natively': () => edit(r => r.state === 'awaiting-native', { state: 'received' }),
    'a card asked again': () => control.commit(d => { d.records.push({ ...plain(d.records.find(r => r.state === 'confirmation-required')), id: 'again', at: f.clock.now - 1 }); }),
    'an answer waiting its turn': () => { const r = control.data.records.find(r => r.state === 'confirmation-required'); control.decisions.set(control.key(r.actor) + ':' + r.id, { waiting: true }); },
    'an archived record added again': () => f.archive({ ...plain(control.archivedBySession.get('s1')[0]), state: 'received', delivery: { nativeReceived: true } }),
    'an archived card added again': () => f.archive({ ...plain(control.archivedBySession.get('s0')[0]), state: 'cancelled', humanDecision: 0 }),
    'records moved to the archive': () => { f.clock.now += 25 * 3600000; control.decisions.clear(); control.commit(() => {}); },
    'an archived record of one more session': () => f.archive(record(11)),
    'cards run out': () => { control.commit(d => { d.records.push(asked(3, { at: f.clock.now })); }); f.clock.now += 8 * 86400000; },
    'a card run out, its session at work': () => { control.commit(d => { d.records.push(asked(4, { at: f.clock.now })); }); control.inflight.set(control.key(asked(4).actor), Promise.resolve()); f.clock.now += 8 * 86400000; },
    'a session ended': () => { control.inflight.clear(); snapshot.sessions = snapshot.sessions.filter(s => s.id !== 's1'); },
    'a session archived': () => { snapshot.sessions = snapshot.sessions.map(s => s.id === 's2' ? { ...s, archived: true } : s); },
    'a block deleted': () => { const before = control.archived.size; control.deleteBlocks([control.archive.manifest.blocks[0].name]); assert.ok(control.archived.size < before); },
    'another window a rename behind': () => { control.rows('s0', { ...snapshot, sessions: snapshot.sessions.map(s => ({ ...s, name: 'before' })) }); },
  };
  for (const [step, change] of Object.entries(steps)) { change(); assertSame(f, step); assertSame(f, step + ', read again'); }
  // No reader edits what is kept.
  const kept = control.rows('s0', snapshot), text = JSON.stringify(kept); assertSame(f, 'read by everyone'); assert.equal(JSON.stringify(control.rows('s0', snapshot)), text);
});

test('after a rename no row or card of any session keeps the old name', t => {
  const f = fixture(t), names = () => JSON.stringify([f.display(f.snapshot), f.control.pending(f.snapshot)]);
  for (let i = 0; i < 12; i++) f.archive(i % 2 ? record(i) : answered(i));
  f.control.commit(d => { d.records.push(record(3), answered(4), asked(6)); });
  f.snapshot.sessions[5] = { ...f.snapshot.sessions[5], name: 'OLD-TARGET' }; f.snapshot.rooms[1] = { id: 'r1', name: 'OLD-ROOM' };
  assert.match(names(), /OLD-TARGET/); assert.match(names(), /OLD-ROOM/);
  f.snapshot.sessions[5] = { ...f.snapshot.sessions[5], name: 'NEW-TARGET' }; f.snapshot.rooms[1] = { id: 'r1', name: 'NEW-ROOM' };
  const after = names(); assert.doesNotMatch(after, /OLD-/); assert.match(after, /NEW-TARGET/); assert.match(after, /NEW-ROOM/);
});

test('the times of the records are made for each state and change nothing that is kept', t => {
  const f = fixture(t), lengths = () => [...f.control.recordTimes()].map(([id, list]) => [id, list.length]).sort(), own = () => f.snapshot.sessions.map(s => [s.id, f.control.own(s.id).length]).filter(([, n]) => n).sort();
  for (let i = 0; i < 24; i++) f.archive(record(i % 8));
  f.control.commit(d => { d.records.push(record(2), record(2), record(9)); });
  for (let i = 0; i < 3; i++) assert.deepStrictEqual(lengths(), own(), 'read ' + i);
});

test('a card asked again: the bell reads the earlier one as replaced, an answered one as settled', t => {
  const f = fixture(t), first = asked(0, { at: START }), later = asked(0, { at: START + 1000 });
  const done = asked(3, { state: 'complete', finishedAt: START + 9, humanDecision: 1, humanDecisionAt: START + 5, notExecutedReason: undefined });
  f.archive(done); f.control.commit(d => { d.records.push(first, later, asked(1, { at: START })); });
  const bell = () => Object.fromEntries(f.control.confirmations(f.snapshot, f.snapshot).map(c => [c.operationId, c]));
  for (const round of [1, 2]) {
    const cards = bell();
    assert.equal(cards[first.id].state, 'replaced', 'round ' + round); assert.equal(cards[first.id].actionable, false);
    assert.equal(cards[first.id].replacedBy.state, 'waiting'); assert.equal(cards[first.id].replacedBy.time, later.at);
    assert.notEqual(cards[later.id].state, 'replaced'); assert.equal(cards[later.id].replacedBy ?? null, null);
    assert.equal(cards[done.id].actionable, false); assert.notEqual(cards[done.id].state, 'replaced');
  }
});

test('a state made while a session was hidden still brings its rows when the page shows it by then', t => {
  const f = fixture(t), context = page(['s0']);
  for (let i = 0; i < 24; i++) f.archive(record(i % 12));
  const ids = session => session.messages.filter(m => m.kind === 'background-operation').length, find = (sent, id) => sent.sessions.find(s => s.id === id);
  const made = f.display(f.snapshot, context, null, true);
  assert.equal(find(omitHidden(made, new Set(['s0'])), 's3').messagesOmitted, true);
  assert.equal(ids(find(omitHidden(made, new Set(['s0', 's3'])), 's3')), 2);
  assert.ok(omitHidden(made, null).sessions.every(s => ids(s) === 2), 'a page that has not reported gets every row');
  const report = reportShown(new Set(['s0']), ['s0', 's3'], () => f.display(f.snapshot, context, null, true));
  assert.deepStrictEqual(Object.keys(report.messages), ['s3']); assert.equal(report.messages.s3.filter(m => m.kind === 'background-operation').length, 2);
  for (const sent of [omitHidden(made, new Set(['s0'])), omitHidden(made, null)]) for (const s of sent.sessions) assert.deepStrictEqual(Object.getOwnPropertySymbols(s), [], 'nothing of it goes to the page');
});

test('a hidden session is summed up as with its rows in place, whichever messages have times', () => {
  let seed = 7, moved = 0; const random = n => (seed = (seed * 48271) % 2147483647) % n;
  const newest = list => shownSessions.messageSummary(list).lastAssistant?.id, byTime = (a, b) => a.time - b.time;
  for (let round = 0; round < 300; round++) {
    const messages = Array.from({ length: random(60) }, (_, i) => ({ id: 'm' + i, role: random(2) ? 'assistant' : 'user', text: 'text', ...(random(3) ? { time: START + random(50) } : {}) }));
    const rows = Array.from({ length: random(8) }, (_, i) => ({ id: 'r' + i, role: 'system', kind: 'background-operation', text: 'row', time: START + random(50) }));
    const session = { id: 's', messages }; shownSessions.leaveRecords(session, { times: () => rows.length ? rows.map(({ time }) => ({ time })) : undefined, messages: () => assert.fail('no row is made') });
    const all = rows.length ? [...messages, ...rows].sort(byTime) : messages;
    assert.deepStrictEqual(omitHidden({ sessions: [session] }, new Set()).sessions[0], { id: 's', messages: [], messagesOmitted: true, messageSummary: shownSessions.messageSummary(all) }, 'round ' + round);
    if (newest(all) !== newest([...messages].sort(byTime))) moved++;
  }
  assert.ok(moved > 0, 'among them some where a row moves the newest reply');
});

test('a summary reads a time as a Date does, and none as null', () => {
  const none = { latestAt: null, turnFirstAt: null, turnLastAt: null, hasAssistant: false, lastAssistant: null };
  assert.deepStrictEqual(shownSessions.messageSummary([]), none); assert.deepStrictEqual(shownSessions.messageSummary(undefined), none);
  for (const time of [8.64e15, -8.64e15, 8.64e15 + 1, -8.64e15 - 1, 9e15, 0, 1.5, START, NaN, Infinity, -Infinity, null, undefined, String(START)]) {
    const finite = Number.isFinite(time), date = finite && Number.isFinite(new Date(time).getTime());
    assert.deepStrictEqual(shownSessions.messageSummary([{ role: 'user', time }]), { ...none, latestAt: date ? time : null, turnFirstAt: finite ? time : null, turnLastAt: finite ? time : null }, String(time));
  }
});

test('an agent reads a card run out as run out, and a page does as well', t => {
  const read = agent => { const f = fixture(t), card = asked(0, { at: START }); f.control.commit(d => { d.records.push(card); }); f.clock.now += 8 * 86400000;
    const s0 = f.display(f.snapshot, agent ? { background: true, view: { selected: 's0' } } : undefined).sessions.find(s => s.id === 's0');
    return [f.control.data.records[0]?.state ?? 'archived', s0.messages.find(m => m.kind === 'background-operation').backgroundOperation.state]; };
  for (const agent of [true, false]) { const [kept, shown] = read(agent); assert.notEqual(kept, 'confirmation-required', 'agent ' + agent); assert.notEqual(shown, 'confirmation-required', 'agent ' + agent); }
});

test('every state that leaves the rows out reaches the page through a reader that makes them', () => {
  const calls = main.split('\n').filter(line => /displayState\([^)]*\)/.test(line) && !line.startsWith('function displayState(') && /\btrue\)/.test(line.slice(line.indexOf('displayState('))));
  assert.equal(calls.length, 7, calls.join('\n'));
  // Search and the phone read every message themselves.
  assert.match(main, /const display = displayState\(c\.client\.snapshot\(\), c\), spaceId/); assert.match(main, /snapshot: client => displayState\(confirmationSnapshot\(client\)\), roomState/);
});
