const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const { RoomState } = require('../room-state.cjs');
const { MobileWorkspace } = require('../mobile-workspace.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-mobile-workspace-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const room = new RoomState(root), hidden = room.create('Unshared synthetic space');
  const source = { sessions: [
    { id: 'a', nativeId: 'native-a', name: 'Synthetic A', provider: 'codex', state: 'idle', roomIds: ['shared'], liveDraft: 'PRIVATE_DESKTOP_DRAFT', messages: [
      { id: 'human', role: 'user', text: 'Original human text', time: 1 }, { id: 'reply', role: 'assistant', text: '<script>literal original</script>', time: 2 }] },
    { id: 'b', nativeId: 'native-b', name: 'Synthetic B', state: 'idle', roomIds: [hidden], messages: [{ role: 'assistant', text: 'UNPAIRED_PRIVATE_BODY' }] },
  ], backgroundConfirmations: [] };
  const status = { count: 1, records: [{ record: 'operations', items: [{ kind: 'age', level: 1, shown: true }] }] }, acknowledgements = [];
  const client = { async refresh() {}, route: () => ({ key: '.' }) };
  const snapshot = () => ({ ...source, rooms: [{ id: 'shared', name: 'Shared', messages: [{ role: 'human', text: 'Shared message' }], queue: room.queueItems('shared') },
    { id: hidden, name: 'Unshared', messages: [{ role: 'human', text: 'UNSHARED_SPACE_BODY' }], queue: [] }] });
  const adapter = new MobileWorkspace({ snapshot, roomState: room, now: () => 100,
    records: { status: () => structuredClone(status), acknowledge: (...args) => acknowledgements.push(args) } });
  const scopes = [{ serviceKey: '.', sessionId: 'a', nativeId: 'native-a', actions: ['read', 'send'] }];
  return { adapter, client, room, source, status, acknowledgements, scopes, hidden, grant: { roomIds: ['shared'], records: true }, spec: extra => ({ requestId: randomUUID(), ...extra }) };
}
test('phone confirmation routing preserves opaque desktop operation ids and their full length', t => {
  const f = fixture(t);
  for (const operationId of ['approval.stage:original/card', 'x'.repeat(160)]) {
    f.adapter.confirmation = (sessionId, nativeId, id, decision) => {
      assert.equal(id, operationId); return { sessionId, nativeId, operationId: id, decision, version: 'original', expiresAt: 200 };
    };
    const binding = f.adapter.confirmationBinding(f.client, f.scopes, { id: 'a:' + operationId, version: 'original', decision: 'approve' });
    assert.equal(binding.operationId, operationId); assert.equal(binding.nativeId, 'native-a');
  }
});
test('question home indicator is only a boolean and never copies native approval fields', async t => {
  const f = fixture(t), session = f.source.sessions[0];
  session.approvals = [{ requestId: 'PRIVATE_NATIVE_REQUEST', method: 'item/tool/requestUserInput', nativeOnlyField: 'PRIVATE_NATIVE_FIELD',
    params: { isBlocking: false, questions: [{ id: 'q', header: 'PRIVATE_HEADER', question: 'PRIVATE_QUESTION', isOther: true }] } }];
  const view = await f.adapter.read(f.client, f.grant, f.scopes), row = view.sessions[0];
  assert.equal(row.question, true);
  assert.deepEqual(Object.keys(row).sort(), ['earlierMessagesOmitted', 'id', 'messages', 'name', 'provider', 'question', 'roomIds', 'state']);
  for (const secret of ['PRIVATE_NATIVE_REQUEST', 'PRIVATE_NATIVE_FIELD', 'PRIVATE_HEADER', 'PRIVATE_QUESTION']) assert.equal(JSON.stringify(view).includes(secret), false);
  session.approvals[0].pending = true;
  assert.equal((await f.adapter.read(f.client, f.grant, f.scopes)).sessions[0].question, false);
});
test('phone projection contains only explicit native and room grants and the desktop reminder source', async t => {
  const f = fixture(t), view = await f.adapter.read(f.client, f.grant, f.scopes), raw = JSON.stringify(view);
  assert.equal(view.sessions.length, 1); assert.equal(view.rooms.length, 1);
  assert.equal(view.sessions[0].messages[0].text, 'Original human text'); assert.equal(view.sessions[0].messages[1].text, '<script>literal original</script>'); assert.deepEqual(view.reminders, f.status);
  for (const secret of ['PRIVATE_DESKTOP_DRAFT', 'UNPAIRED_PRIVATE_BODY', 'UNSHARED_SPACE_BODY']) assert.equal(raw.includes(secret), false);
  const readOnly = await f.adapter.read(f.client, { roomIds: [], records: false }, f.scopes); assert.deepEqual(readOnly.rooms, []); assert.equal(readOnly.reminders, null);
  f.source.sessions[0].nativeId = 'successor'; assert.deepEqual((await f.adapter.read(f.client, f.grant, f.scopes)).sessions, []);
});
test('phone queue controls use RoomState and the desktop assignee gate', async t => {
  const f = fixture(t), sent = await f.adapter.action(f.client, f.grant, f.spec({ action: 'queueAdd', roomId: 'shared', text: 'Phone original', assignee: 'a' }), () => {});
  assert.equal(f.room.queueFind('shared', sent.itemId).text, 'Phone original');
  await assert.rejects(f.adapter.action(f.client, f.grant, f.spec({ action: 'queueAdd', roomId: 'shared', text: 'Not a member', assignee: 'b' }), () => {}));
  await assert.rejects(f.adapter.action(f.client, f.grant, f.spec({ action: 'queueAdd', roomId: f.hidden, text: 'No grant', assignee: null }), () => {}));
  await f.adapter.action(f.client, f.grant, f.spec({ action: 'queueCancel', roomId: 'shared', itemId: sent.itemId }), () => {}); assert.equal(f.room.queueFind('shared', sent.itemId).status, 'cancelled');
});
test('revocation while assignee validation waits prevents the later write', async t => {
  const f = fixture(t); let active = true; f.client.refresh = async () => { active = false; };
  await assert.rejects(f.adapter.action(f.client, f.grant, f.spec({ action: 'queueAdd', roomId: 'shared', text: 'Unsent', assignee: 'a' }), () => { if (!active) throw Error('Revoked'); })); assert.equal(f.room.queueItems('shared').length, 0);
});
test('phone reminder acknowledgement cannot hide a future level', async t => {
  const f = fixture(t); await f.adapter.action(f.client, f.grant, f.spec({ action: 'recordAcknowledge', record: 'operations', kind: 'age', level: 1 }), () => {});
  assert.deepEqual(f.acknowledgements, [['operations', 'age', 1]]);
  await assert.rejects(f.adapter.action(f.client, f.grant, f.spec({ action: 'recordAcknowledge', record: 'operations', kind: 'age', level: 999 }), () => {})); assert.equal(f.acknowledgements.length, 1);
});
test('phone cards retain desktop expiry/disposition and grant no sensitive approval', async t => {
  const f = fixture(t); delete f.source.backgroundConfirmations; f.source.sessions[0].messages.push({ id: 'card', role: 'system', time: 10, backgroundOperation: { id: 'card-a', nativeId: 'native-a', state: 'not-executed', disposition: 'expired', expiresAt: 120010, confirmation: { options: { message: 'Original action', detail: 'Exact scope' } } } });
  const view = await f.adapter.read(f.client, f.grant, f.scopes); assert.equal(view.confirmations[0].disposition, 'expired'); assert.equal(view.confirmations[0].expiresAt, 120010); assert.equal(view.confirmations[0].canDecide, false);
  await assert.rejects(f.adapter.action(f.client, f.grant, f.spec({ action: 'backgroundDecision', operationId: 'card-a', response: 1 }), () => {}));
});

test('cards with equal operation IDs in different paired sessions remain distinct', async t => {
  const f = fixture(t); delete f.source.backgroundConfirmations;
  f.source.sessions[1].messages = [];
  for (const s of f.source.sessions) s.messages.push({ id: 'card-' + s.id, role: 'system', time: 1, backgroundOperation: {
    id: 'same-request', nativeId: s.nativeId, state: 'confirmation-required', expiresAt: 600001,
    confirmation: { options: { message: 'For ' + s.name } },
  } });
  const view = await f.adapter.read(f.client, f.grant, [...f.scopes, { serviceKey: '.', sessionId: 'b', nativeId: 'native-b', actions: ['read'] }]);
  assert.deepEqual(view.confirmations.map(c => c.id), ['a:native-a:same-request', 'b:native-b:same-request']);
});

test('the desktop card projection supplies two-minute input and ten-minute other deadlines', () => {
  const { BackgroundControl } = require('../background-control.cjs');
  const control = Object.create(BackgroundControl.prototype);
  control.now = () => 1000;
  control.inflight = new Map();
  control.archivedBySession = new Map();
  control.data = { records: ['input', 'observe'].map(method => ({ id: method, actor: { id: 'a', nativeId: 'n', name: 'Synthetic' }, command: { method, arguments: [] }, at: 1000, state: 'confirmation-required' })) };
  const rows = control.rows('a', null);
  assert.deepEqual(rows.map(r => r.backgroundOperation.expiresAt - r.time), [120000, 600000]);
});

test('unified mobile summaries respect native grants and contain no private card body or cleanup authority', async t => {
  const f=fixture(t),base={id:'original',key:'a:native-a:request',operationId:'request',sessionId:'a',nativeId:'native-a',actorName:'Requester',targetName:'Target',state:'confirmation-required',actionable:true,time:10,expiresAt:120010,summary:{action:'input',target:'Target',folder:'PRIVATE_FOLDER'},title:'PRIVATE_PROMPT',detail:'PRIVATE_APPROVAL',message:{text:'PRIVATE_BODY'},guard:{secret:'PRIVATE_GUARD'}};
  f.source.backgroundConfirmations=[base,{...base,key:'b:native-b:request',sessionId:'b',nativeId:'native-b',actorName:'UNPAIRED_ACTOR'},{...base,key:'a:old:request',nativeId:'old',actorName:'OLD_NATIVE'}];
  f.source.sessions[0].messages.push({id:'original',role:'system',text:'PRIVATE_ARGUMENTS',backgroundOperation:{id:'request',nativeId:'native-a'}},{id:'old',role:'system',text:'OLD_NATIVE_BODY',backgroundOperation:{id:'request',nativeId:'old'}});
  Object.assign(f.status,{count:4,confirmationCount:2,confirmations:f.source.backgroundConfirmations,temp:{id:'naw-temp-files',shown:true,version:1,checkedAt:1,directories:1,bytes:1,oldestDay:null,ticket:'PRIVATE_TICKET',candidates:['PRIVATE_PATH']}});
  const view=await f.adapter.read(f.client,f.grant,f.scopes),raw=JSON.stringify(view);
  assert.equal(view.reminders.count,4);assert.equal(view.confirmations.length,1);assert.equal(view.reminders.confirmations.length,1);assert.equal(view.confirmations[0].messageId,'original');assert.equal(view.confirmations[0].canDecide,false);
  assert.doesNotMatch(raw,/PRIVATE_|UNPAIRED_ACTOR|OLD_NATIVE/);assert.equal(view.sessions[0].messages.at(-1).confirmationId,'a:native-a:request');
});

test('port: full inbox identity retains the exact phone decision presentation and version', async t => {
 const f=fixture(t),operationId='request:with.parts',title='RAW_DECISION_TITLE',detail='RAW_DECISION_SCOPE';
 const row={id:'message',key:'a:native-a:'+operationId,sessionId:'a',nativeId:'native-a',operationId,title,detail,summary:{action:'input',target:'Synthetic target'},state:'confirmation-required',actionable:true,time:1,expiresAt:200};
 f.source.backgroundConfirmations=[row];Object.assign(f.status,{confirmations:[row],confirmationCount:1,count:1});
 f.adapter.confirmation=(sessionId,nativeId,id,decision)=>{assert.equal(id,operationId);return {sessionId,nativeId,operationId:id,decision,version:'bound-proof',expiresAt:200,presentation:'sha256:'+require('node:crypto').createHash('sha256').update(JSON.stringify([title,detail])).digest('hex')};};
 const view=await f.adapter.read(f.client,f.grant,f.scopes),card=view.confirmations[0];
 assert.equal(card.id,row.key);assert.equal(card.title,title);assert.equal(card.detail,detail);assert.equal(card.titles,undefined);assert.equal(card.version,'bound-proof');
 assert.doesNotMatch(JSON.stringify(view.reminders),/RAW_DECISION/,'Reminder summaries keep their safe contract');
 assert.equal(f.adapter.confirmationBinding(f.client,f.scopes,{id:card.id,version:card.version,decision:'approve'}).operationId,operationId);
});
test('port: a mismatched presentation never gains a version or exposes the raw decision body', async t => {
 const f=fixture(t);f.source.backgroundConfirmations=[{key:'a:native-a:req',sessionId:'a',nativeId:'native-a',operationId:'req',title:'PRIVATE_PROMPT',detail:'PRIVATE_DETAIL',summary:{action:'input'},state:'confirmation-required',actionable:true}];
 f.adapter.confirmation=()=>({presentation:'other',version:'wrong'});const view=await f.adapter.read(f.client,f.grant,f.scopes);
 assert.equal(view.confirmations[0].version,undefined);assert.doesNotMatch(JSON.stringify(view),/PRIVATE_|wrong/);
});
test('port: ambiguous legacy and full card identities fail closed before requesting authority', t => {
 const f=fixture(t);let calls=0;
 f.source.backgroundConfirmations=['req','native-a:req'].map(operationId=>({key:'a:native-a:'+operationId,sessionId:'a',nativeId:'native-a',operationId}));
 f.adapter.confirmation=()=>{calls++;throw Error('Authority requested');};
 assert.throws(()=>f.adapter.confirmationBinding(f.client,f.scopes,{id:'a:native-a:req',version:'same',decision:'approve'}));assert.equal(calls,0);
});
test('the phone names the Mac butler only when this pairing already reads it; otherwise only why not', async t => {
  const f = fixture(t), steward = async (grant = f.grant) => (await f.adapter.read(f.client, grant, f.scopes)).steward;
  assert.equal(await steward(), undefined, 'without a designation source the phone shows no butler card');
  f.adapter.steward = () => ({ sessionId: 'a', nativeId: 'native-a' });
  assert.deepEqual(await steward(), { state: 'shared', sessionId: 'a' });
  f.adapter.steward = () => ({ sessionId: 'b', nativeId: 'native-b' });
  const view = await f.adapter.read(f.client, f.grant, f.scopes), raw = JSON.stringify(view);
  assert.deepEqual(view.steward, { state: 'notSelected' });
  for (const identity of ['"b"', 'native-b', 'Synthetic B']) assert.equal(raw.includes(identity), false, 'an unshared butler is never named');
  assert.deepEqual(await steward({ allRooms: true, records: false }), { state: 'unavailable' }, 'all-session pairing: not "not chosen"');
  f.adapter.steward = () => ({ sessionId: 'a', nativeId: 'native-a' }); f.source.sessions[0].nativeId = 'successor';
  assert.deepEqual(await steward(), { state: 'unavailable' }, 'chosen but not current is unavailable');
  f.source.sessions[0].nativeId = 'native-a';
  f.adapter.steward = () => null;
  assert.deepEqual(await steward(), { state: 'none' });
  f.adapter.steward = () => { throw Error('Synthetic unreadable designation'); };
  assert.deepEqual(await steward(), { state: 'unavailable' }, 'an unreadable designation is never reported as none');
});
// The real role record and rotation log, in the window where the old butler ended but the done line is not written yet.
function handover(t) {
  const f = fixture(t), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-mobile-steward-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { StewardRole } = require('../steward-role.cjs'), role = new StewardRole(dir);
  role.set({ sessionId: 'a', nativeId: 'native-a' });
  f.adapter.steward = () => role.current();
  const next = { id: 'c', nativeId: 'native-c', name: 'Synthetic successor', state: 'idle', roomIds: ['shared'], nativeContextPending: true, messages: [] };
  f.source.sessions.push(next);
  const both = [...f.scopes, { serviceKey: '.', sessionId: 'c', nativeId: 'native-c', actions: ['read', 'send'] }];
  const steward = async (scopes = f.scopes, grant = f.grant) => (await f.adapter.read(f.client, grant, scopes)).steward;
  return { f, role, old: f.source.sessions[0], next, both, steward };
}
for (const state of ['ended', 'closed']) test('a chosen butler whose session is ' + state + ' during a handover is unavailable, not the current entry', async t => {
  const h = handover(t);
  assert.deepEqual(await h.steward(), { state: 'shared', sessionId: 'a' });
  h.old.state = state;
  assert.deepEqual(await h.steward(), { state: 'unavailable' }, 'the old session still reads but is not the current butler');
  assert.deepEqual(await h.steward(h.both), { state: 'unavailable' }, 'nor is the pending successor');
  assert.deepEqual(await h.steward(h.f.scopes, { allRooms: true, records: false }), { state: 'unavailable' }, 'all-session pairing agrees');
  assert.equal((await h.f.adapter.read(h.f.client, h.f.grant, h.f.scopes)).sessions.some(s => s.id === 'a'), true, 'the selected historical read is unchanged');
});
test('after the done log the chosen butler card follows the successor again', async t => {
  const h = handover(t);
  h.old.state = 'ended';
  assert.deepEqual(await h.steward(h.both), { state: 'unavailable' });
  fs.writeFileSync(h.role.logFile, JSON.stringify({ event: 'done', old: { id: 'a', nativeId: 'native-a' }, new: { id: 'c', nativeId: 'native-c' } }) + '\n', { mode: 0o600 });
  h.next.nativeContextPending = false;
  assert.deepEqual(await h.steward(h.both), { state: 'shared', sessionId: 'c' });
  assert.deepEqual(await h.steward(), { state: 'notSelected' }, 'a pairing that chose only the old session does not gain the successor');
});
test('a busy butler thread shows its messages, not a page of "not shown" notes from background operations and empty turns', async t => {
  // The daily shape (2026-11-19): about 80 background operations and 40 empty turn rows among the messages.
  const f = fixture(t), s = f.source.sessions[0];
  s.messages = [];
  for (let i = 0; i < 260; i++) {
    const kind = i % 4;
    if (kind === 0) s.messages.push({ id: 'op' + i, role: 'system', kind: 'background-operation', name: 'Synthetic A', text: 'PRIVATE_ARGS', time: i, backgroundOperation: { id: 'op' + i, nativeId: 'native-a' } });
    else if (kind === 1) s.messages.push({ id: 'turn' + i, role: 'system', kind: 'turn', text: '', time: i });
    else if (kind === 2) s.messages.push({ id: 'tool' + i, role: 'tool', text: 'tool output', time: i });
    else s.messages.push({ id: 'reply' + i, role: i % 8 === 3 ? 'user' : 'assistant', text: 'message ' + i, time: i });
  }
  s.messages.push({ id: 'card', role: 'system', kind: 'background-operation', text: 'PRIVATE_CARD_ARGS', time: 300, backgroundOperation: { id: 'card-op', nativeId: 'native-a' } });
  f.source.backgroundConfirmations = [{ id: 'card', key: 'a:native-a:card-op', operationId: 'card-op', sessionId: 'a', nativeId: 'native-a', actorName: 'Synthetic A',
    state: 'confirmation-required', actionable: true, time: 300, expiresAt: 600, summary: { action: 'input', target: 'Synthetic B' }, title: 'Synthetic card' }];
  f.adapter.confirmation = () => { throw Error('No decision grant'); };
  const view = await f.adapter.read(f.client, f.grant, f.scopes), rows = view.sessions[0].messages;
  assert.deepEqual(rows.map(m => m.id), [...Array.from({ length: 65 }, (_, i) => 'reply' + (4 * i + 3)), 'card']);
  assert.equal(rows.filter(m => m.textOmitted).length, 0);
  assert.equal(rows.at(-1).confirmationId, 'a:native-a:card-op');
  assert.equal(view.sessions[0].earlierMessagesOmitted, 0);
  assert.doesNotMatch(JSON.stringify(view), /PRIVATE_/);
});
