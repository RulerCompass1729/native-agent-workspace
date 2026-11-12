const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const locale = require('../ui-locale.js');
const { model, order } = require('../renderer/handoff-queue.js');
const { rowWords } = require('../integrator-words.cjs');

// What the queue panel says about the integration handoff (B6): the display model on synthetic views.
const sessions = [{ id: 'integrator', name: 'Riley' }, { id: 'member-a', name: 'Member A' }, { id: 'member-b', name: 'Member B' }];
const INTEGRATOR = { sessionId: 'integrator', nativeId: 'native-integrator' };
const item = (name, state, extra = {}) => ({ key: `ready:shared:${name}`, state, branch: `lane/${name}`, commit: 'c'.repeat(40), text: `Task ${name}`, memberId: 'member-a', memberName: 'Member A at delivery', ...extra });
const view = (items = {}, extra = {}) => ({ started: true, engineFault: null, fault: null, repository: { root: '/synthetic/main', problem: null }, reasons: [], waiting: null,
  summary: { deliverable: 0, held: 0, handed: 0, since: null, handoff: null }, held: [], unknownNotices: [], items, ...extra });
const sent = { id: 'H1-00000000', status: 'sent', confirmed: true, sentAt: 1, integrator: INTEGRATOR };
const waitingFor = (reason, entries, question = '') => ({ summary: { handoff: { ...sent, status: 'waiting' } }, waiting: { handoffId: 'H1-00000000', reason, question, sessionId: 'integrator', entries } });
const draw = (input, extra = {}) => model({ view: input, queue: Object.keys(input?.items || {}).map(id => ({ id })), sessions, members: ['member-a', 'member-b'], integrator: INTEGRATOR, unnamed: 'Someone', generic: 'the integrator', ...extra });
const where = result => Object.fromEntries(Object.entries(result.rows).map(([id, row]) => [id, row.where]));
const plain = value => JSON.parse(JSON.stringify(value));

test('where handoffs are not enabled, or a space has no delivery, the panel says nothing about them', () => {
  for (const input of [undefined, {}, { view: null }, { view: view() }, { view: view({}, { engineFault: { message: 'old', at: 1, count: 1, recoveredAt: 2 } }) }]) {
    assert.deepEqual(plain(model(input)), { block: null, rows: {}, keep: [], orphans: [], need: 0 }, JSON.stringify(input));
  }
  // Trouble with the step itself is said in every space, also in one with no delivery.
  assert.deepEqual(plain(model({ failed: true }).block.faults), [{ key: 'queue.handoff.fault.view', params: {} }]);
  assert.deepEqual(plain(model({ view: { started: false, engineFault: { message: 'Synthetic build fault' } } }).block.faults), [{ key: 'queue.handoff.fault.notStarted', params: { message: 'Synthetic build fault' } }]);
  const faulted = draw(view({}, { engineFault: { message: 'Synthetic pass fault', at: 1, count: 2 }, fault: { message: 'Synthetic record fault', at: 1 } }));
  assert.deepEqual(plain(faulted.block.faults), [{ key: 'queue.handoff.fault.step', params: { message: 'Synthetic pass fault' } }, { key: 'queue.handoff.fault.record', params: { message: 'Synthetic record fault' } }]);
  assert.equal(faulted.need, 0);
});

test('a row that waits for the person can be set aside: asked once more in the row first, and afterwards it says so and waits for nobody', () => {
  const held = item('d', 'held', { reason: 'merge-unverified', why: { key: 'queue.handoff.why.unverified', params: {} } }), back = item('e', 'returned', { note: 'needs a rebase' });
  const kept = item('k', 'held', { reason: 'main-unreadable', recheck: true, why: { key: 'queue.handoff.why.mainUnreadable', params: {} } });
  const all = { a: item('a', 'queued'), b: item('b', 'handed'), c: item('c', 'merged', { mergedAs: 'd'.repeat(40) }), d: held, e: back, f: item('f', 'returned', { redone: true }), k: kept };
  const step = (kind, id) => ({ kind, key: `ready:shared:${id}`, label: { key: 'queue.handoff.' + kind, params: {} } });
  // "Not needed" is offered on the rows that wait for the person, apart from their own steps, and on no other row.
  const shown = draw(view(all));
  assert.deepEqual(plain(Object.fromEntries(Object.entries(shown.rows).map(([id, row]) => [id, [row.aside, row.ask]]))),
    { a: [[], null], b: [[], null], c: [[], null], d: [[step('drop', 'd')], null], e: [[step('drop', 'e')], null], f: [[], null], k: [[step('drop', 'k')], null] });
  assert.deepEqual([shown.rows.d.action.kind, shown.rows.d.more, shown.rows.e.action.kind, shown.rows.k.action.kind, shown.rows.k.more.kind, shown.need], ['send', null, 'redo', 'recheck', 'send', 3]);
  // (Also with nobody designated, where a delivery on hold has no other step.)
  const idle = draw(view({ d: held }), { integrator: null }).rows.d;
  assert.deepEqual(plain([idle.action, idle.aside]), [null, [step('drop', 'd')]]);
  // Pressed: that row asks once more, with "keep it" before "yes". Its own steps and its reason stay; the count is what it was.
  const name = shown.rows.d.status.params.name;
  const asked = draw(view(all), { dropping: 'ready:shared:d' });
  assert.deepEqual(plain([asked.rows.d.ask, asked.rows.d.aside, asked.rows.d.action, asked.rows.d.more, asked.rows.d.why, asked.rows.d.need, asked.need]), [
    { key: 'queue.handoff.dropAsk.held', params: { who: 'Riley' } }, [step('dropCancel', 'd'), step('dropNow', 'd')], plain(shown.rows.d.action), null,
    { key: 'queue.handoff.why.unverified', params: { who: 'Riley' } }, true, 3]);
  assert.deepEqual(plain([asked.rows.e, asked.rows.k]), plain([shown.rows.e, shown.rows.k]), 'The other rows are as they were');
  // A returned row asks in its own words; a row with two steps of its own keeps both beside the question.
  assert.equal(draw(view(all), { dropping: 'ready:shared:e' }).rows.e.ask.key, 'queue.handoff.dropAsk.returned');
  const two = draw(view(all), { dropping: 'ready:shared:k' }).rows.k;
  assert.deepEqual([two.action.kind, two.more.kind, two.aside.map(act => act.kind)], ['recheck', 'send', ['dropCancel', 'dropNow']]);
  // A press remembered for a row that no longer waits for the person, or for no row at all, changes nothing, and is
  // forgotten: it must not come back, unpressed, when that delivery waits for the person again later.
  const { pressed } = require('../renderer/handoff-queue.js');
  for (const other of ['ready:shared:c', 'ready:shared:a', 'ready:shared:f', 'ready:shared:zz', '', null, 7]) {
    assert.deepEqual(plain(draw(view(all), { dropping: other })), plain(shown), String(other));
    assert.equal(pressed(draw(view(all), { dropping: other }), other), '', String(other));
  }
  assert.deepEqual([pressed(asked, 'ready:shared:d'), pressed(null, 'ready:shared:d'), pressed(draw(null), 'ready:shared:d'), pressed(draw(view(all), { failed: true, dropping: 'ready:shared:d' }), 'ready:shared:d')],
    ['ready:shared:d', '', '', '']);
  // Set aside: the row says so, has no step, waits for nobody and is no longer kept in front.
  const gone = draw(view({ ...all, d: item('d', 'dropped') }));
  assert.deepEqual(plain([gone.rows.d, gone.need, gone.keep.includes('d')]), [
    { where: 'dropped', status: { key: 'queue.handoff.row.dropped', params: { name, who: 'Riley' } }, why: null, action: null, more: null, ask: null, aside: [], need: false, front: false }, 2, false]);
  for (const language of ['zh', 'en']) {
    for (const key of ['queue.handoff.drop', 'queue.handoff.dropNow', 'queue.handoff.dropCancel', 'queue.handoff.row.dropped', 'queue.handoff.dropAsk.held', 'queue.handoff.dropAsk.returned']) {
      const said = locale.format(language, key, { who: 'Riley', name: 'Member A' });
      assert.ok(said && said !== key && !said.includes('{'), `${language} ${key}`);
      // The question names no member: the task may be redone by anyone, and the member who did it may be gone.
      if (key.startsWith('queue.handoff.dropAsk.')) assert.ok(!said.includes('Member A'), `${language} ${key}`);
    }
    // On a row where the integrator says "merged", "not needed" must not read as "nothing left to do": the question says
    // that the delivery is then not recorded as merged. A returned task was never said to be merged.
    const merged = language === 'zh' ? '不会记为已合入' : 'recorded as merged';
    assert.deepEqual([locale.format(language, 'queue.handoff.dropAsk.held', { who: 'Riley' }).includes(merged), locale.format(language, 'queue.handoff.dropAsk.returned', { who: 'Riley' }).includes(merged)], [true, false], language);
    {
    }
  }
});

test('each delivered task says where it stands, in the name of whoever holds it', () => {
  const items = { a: item('a', 'queued'), b: item('b', 'handed'), c: item('c', 'merged', { mergedAs: 'd'.repeat(40) }), d: item('d', 'held', { reason: 'merge-unverified', why: { key: 'queue.handoff.why.unverified', params: {} } }),
    e: item('e', 'returned', { note: 'needs a rebase' }), f: item('f', 'returned', { redone: true, note: 'again' }), g: item('g', 'returned', { memberId: 'gone', memberName: '' }) };
  // Nobody designated: what was delivered waits for that, and designating somebody is one thing that waits for the person,
  // however many deliveries wait for it.
  const none = draw(view({ a: items.a }), { integrator: null });
  assert.deepEqual([where(none), plain(none.block.none), plain(none.block.head), none.need], [{ a: 'queuedNone' }, { count: 1 }, [], 1]);
  const several = draw(view({ a: items.a, a2: item('a2', 'queued'), c: items.c }), { integrator: null });
  assert.deepEqual([plain(several.block.none), several.need], [{ count: 2 }, 1]);
  // (Nothing in line for an integrator: nothing to designate one for.)
  const settled = draw(view({ c: items.c }), { integrator: null });
  assert.deepEqual([plain(settled.block.none), settled.need], [{ count: 0 }, 0]);
  // A delivery on hold with nobody designated still waits for the person, but there is nobody to send it to again.
  const idle = draw(view({ d: items.d }), { integrator: null });
  assert.deepEqual([idle.rows.d.action, idle.rows.d.need, plain(idle.rows.d.why), idle.need], [null, true, { key: 'queue.handoff.why.unverified', params: { who: 'the integrator' } }, 1]);
  // Both at once are two things.
  assert.equal(draw(view({ a: items.a, d: items.d }), { integrator: null }).need, 2);
  // A hold that keeps the merge that was reported is checked again, with or without an integrator; it is not sent again.
  const kept = item('d', 'held', { reason: 'main-unreadable', recheck: true, why: { key: 'queue.handoff.why.mainUnreadable', params: {} } });
  for (const integrator of [INTEGRATOR, null]) {
    const row = draw(view({ d: kept }), { integrator }).rows.d;
    assert.deepEqual(plain([row.action, row.need, row.front]), [{ kind: 'recheck', key: 'ready:shared:d', label: { key: 'queue.handoff.recheck', params: {} } }, true, true], String(Boolean(integrator)));
    // Sending stays beside it while there is an integrator: a check git can never answer must not leave the row without a step.
    assert.deepEqual(plain(row.more), integrator ? { kind: 'send', key: 'ready:shared:d', label: { key: 'queue.handoff.send', params: { who: 'Riley' } } } : null, String(Boolean(integrator)));
  }
  // A merge made before the handoff began: the second step is the person's confirmation, a step of its own and called that.
  const earlier = draw(view({ d: item('d', 'held', { reason: 'merged-earlier', recheck: true, why: { key: 'queue.handoff.why.mergedEarlier', params: {} } }) })).rows.d;
  assert.deepEqual(plain([earlier.action, earlier.more.kind, earlier.why]), [{ kind: 'confirm', key: 'ready:shared:d', label: { key: 'queue.handoff.confirm', params: {} } }, 'send', { key: 'queue.handoff.why.mergedEarlier', params: { who: 'Riley' } }]);
  const plainHold = draw(view({ d: { ...kept, recheck: undefined } })).rows.d;
  assert.deepEqual([plainHold.action.kind, plainHold.more], ['send', null], 'A hold without a claim has the one step it always had');
  for (const other of Object.values(draw(view(items, { summary: { handoff: sent } })).rows)) assert.equal(other.more, null);
  // A conflict's cause sends the person to the integrator's session and names the button; with nobody designated there is neither, and it says so.
  const clash = { key: 'queue.handoff.why.conflict', params: {} }, held = item('d', 'held', { reason: 'conflict:H1-00000000', why: clash });
  assert.deepEqual([plain(draw(view({ d: held })).rows.d.why), plain(draw(view({ d: held }), { integrator: null }).rows.d.why), clash], [{ key: 'queue.handoff.why.conflict', params: { who: 'Riley' } },
    { key: 'queue.handoff.why.conflictIdle', params: { who: 'the integrator' } }, { key: 'queue.handoff.why.conflict', params: {} }]);
  // One step at a time: the main repository is asked for once there is an integrator, and is not counted before.
  const bare = draw(view({ a: items.a }, { repository: { root: null, problem: null } }), { integrator: null });
  assert.deepEqual([none.block.repository, bare.block.repository, where(bare), bare.need], [null, null, { a: 'queuedNone' }, 1]);
  // Designated and free; busy with a handoff; waiting for the person.
  assert.deepEqual(where(draw(view({ a: items.a }))), { a: 'queuedNext' });
  const busy = draw(view(items, { summary: { handoff: sent } }));
  assert.deepEqual(where(busy), { a: 'queuedBusy', b: 'handed', c: 'merged', d: 'held', e: 'returned', f: 'redone', g: 'returned' });
  assert.deepEqual(plain(busy.block.head), [{ key: 'queue.handoff.integrator', params: { name: 'Riley' } }, { key: 'queue.handoff.sent', params: { n: 1, who: 'Riley' } }, { key: 'queue.handoff.behind', params: { n: 1, who: 'Riley' } }]);
  // The member's name is the session's own now; the one written at delivery when the session is gone; a stand-in when there is none.
  assert.deepEqual([busy.rows.a.status, busy.rows.g.status.params.name].map(plain), [{ key: 'queue.handoff.row.queuedBusy', params: { name: 'Member A', who: 'Riley' } }, 'Someone']);
  assert.equal(draw(view({ a: item('a', 'merged', { memberId: 'gone' }) })).rows.a.status.params.name, 'Member A at delivery');
  // What needs the person: a held delivery (with its cause and "send again") and a returned one (with the reason and "give back").
  assert.deepEqual(plain([busy.rows.d.why, busy.rows.d.action, busy.rows.d.need]), [{ key: 'queue.handoff.why.unverified', params: { who: 'Riley' } }, { kind: 'send', key: 'ready:shared:d', label: { key: 'queue.handoff.send', params: { who: 'Riley' } } }, true]);
  assert.deepEqual(plain([busy.rows.e.why, busy.rows.e.action, busy.rows.e.need]), [{ key: 'queue.handoff.why.returned', params: { note: 'needs a rebase' } }, { kind: 'redo', key: 'ready:shared:e', label: { key: 'queue.handoff.redo', params: { name: 'Member A' } } }, true]);
  // A member who can no longer take it is not named on the button; a line with no reason says so.
  assert.deepEqual(plain(busy.rows.g.action.label), { key: 'queue.handoff.redoAnyone', params: {} });
  assert.deepEqual(plain(draw(view({ e: items.e }), { members: [] }).rows.e.action.label), { key: 'queue.handoff.redoAnyone', params: {} });
  assert.deepEqual(plain(draw(view({ e: item('e', 'returned') })).rows.e.why), { key: 'queue.handoff.why.returnedPlain', params: {} });
  // A member who can take it but has no name is still the one it goes back to, as the main process does it.
  const nameless = model({ view: view({ e: item('e', 'returned', { memberId: 'member-x', memberName: '' }) }), sessions: [...sessions, { id: 'member-x' }], members: ['member-x'], integrator: INTEGRATOR, unnamed: 'Someone' });
  assert.deepEqual(plain(nameless.rows.e.action.label), { key: 'queue.handoff.redo', params: { name: 'Someone' } });
  // Given back, merged, handed, in line: nothing to do, nothing counted.
  for (const id of ['a', 'b', 'c', 'f']) assert.deepEqual([busy.rows[id].action, busy.rows[id].need, busy.rows[id].why], [null, false, null], id);
  assert.equal(busy.need, 3);
  // The open handoff is another session's than the one designated now: the rows name whoever holds it.
  const moved = draw(view({ b: items.b }, { summary: { handoff: { ...sent, integrator: { sessionId: 'member-b' } } } }));
  assert.deepEqual([moved.rows.b.status.params.who, plain(moved.block.head[0].params)], ['Member B', { name: 'Riley' }]);
  // Its session is gone: it is not called by the name of the one designated now.
  const lost = draw(view({ b: items.b }, { summary: { handoff: { ...sent, integrator: { sessionId: 'gone' } } } }));
  assert.deepEqual([lost.rows.b.status.params.who, plain(lost.block.head[0].params)], ['Someone', { name: 'Riley' }]);
  // A queue item named like a property every object has is a row like any other.
  const odd = draw(view({ ['__proto__']: item('odd', 'held') }));
  assert.deepEqual([Object.keys(odd.rows), odd.need], [['__proto__'], 1]);
});

test('a handoff that waits for the person is put on top with what it is about, and counted once', () => {
  const items = { a: item('a', 'asking'), b: item('b', 'queued') };
  const OTHER = '00000000-0000-4000-8000-000000000000';
  const entries = [{ key: 'ready:shared:a', roomId: 'shared', text: 'Task a', memberName: 'Member A' }, { key: `ready:${OTHER}:z`, roomId: OTHER, text: 'Elsewhere', memberName: 'Member Z' }, { key: 'ready:shared:a2', roomId: 'shared', branch: 'lane/x' }];
  const asked = draw(view({ ...items, a2: item('a2', 'asking') }, waitingFor('conflict:H1-00000000', entries, 'lane/a conflicts with main. Resolve or return?')));
  assert.deepEqual(plain(asked.block.ask), { kind: 'asks', here: true, handoffId: 'H1-00000000', sessionId: 'integrator', name: 'Riley', known: true, question: 'lane/a conflicts with main. Resolve or return?',
    about: [{ text: 'Task a', member: 'Member A' }, { text: 'lane/x', member: '' }], elsewhere: [OTHER] });
  assert.deepEqual([where(asked), asked.need], [{ a: 'asking', b: 'queuedAsk', a2: 'asking' }, 1]);
  assert.deepEqual(plain(asked.block.head), [{ key: 'queue.handoff.integrator', params: { name: 'Riley' } }, { key: 'queue.handoff.behindAsk', params: { n: 1, who: 'Riley' } }]);
  // No answer, the person's own step, or any other cause: said as that, with no question, and the rows do not say "your answer".
  for (const [reason, kind] of [['no-reply', 'noReply'], ['person-intervened', 'typed'], ['send-unconfirmed', 'other'], [undefined, 'other']]) {
    const stalled = draw(view(items, waitingFor(reason, entries, 'ignored')));
    assert.deepEqual([stalled.block.ask.kind, stalled.block.ask.question, where(stalled)], [kind, '', { a: 'stalled', b: 'queuedAsk' }], String(reason));
  }
  // A handoff about another space's deliveries. Where this space's deliveries are in line behind it, the panel says so and
  // where it is dealt with, and counts it; the person's steps are not offered here. Where nothing of this space is on its
  // way, it is neither said nor counted.
  const foreign = [{ key: `ready:${OTHER}:z`, roomId: OTHER, text: 'Elsewhere', memberName: 'Member Z' }];
  const behind = draw(view({ b: item('b', 'queued'), c: item('c', 'merged') }, waitingFor('conflict:H1-00000000', foreign, 'About another space')));
  assert.deepEqual([plain(behind.block.ask), where(behind), behind.need], [{ kind: 'asks', here: false, handoffId: 'H1-00000000', sessionId: 'integrator', name: 'Riley', known: true, question: 'About another space', about: [], elsewhere: [OTHER] },
    { b: 'queuedAsk', c: 'merged' }, 1]);
  for (const others of [{ c: item('c', 'merged') }, { c: item('c', 'returned', { redone: true }) }, { c: item('c', 'merged'), d: item('d', 'held') }]) {
    const apart = draw(view(others, waitingFor('conflict:H1-00000000', foreign, 'About another space')));
    assert.deepEqual([apart.block.ask, apart.need, Boolean(apart.block)], [null, others.d ? 1 : 0, true], JSON.stringify(Object.keys(others)));
  }
  // The handoff waits because its integrator sits in a space: said as that in the block, once, with its own steps; the line about paused handoffs is not shown beside it.
  const placed = draw(view(items, { ...waitingFor('integrator-in-space', entries), reasons: [{ reason: 'integrator-in-space', notice: 'shown' }] }));
  assert.deepEqual([placed.block.ask.kind, placed.block.ask.question, plain(placed.block.stops), where(placed), placed.need], ['inSpace', '', [], { a: 'stalled', b: 'queuedStopped' }, 1]);
  // The integrator's session is gone: named as far as known, and the model says it cannot be opened.
  const gone = model({ view: view(items, waitingFor('no-reply', entries)), sessions: [], integrator: INTEGRATOR, unnamed: 'Someone' });
  assert.deepEqual([gone.block.ask.known, gone.block.ask.name], [false, 'Someone']);
});

test('what stops every handoff is said on top and counted, and waiting rows point to it', () => {
  const items = { a: item('a', 'queued') };
  const unchosen = draw(view(items, { repository: { root: null, problem: null } }));
  assert.deepEqual([plain(unchosen.block.repository), where(unchosen), unchosen.need, plain(unchosen.block.head)], [{ root: '', problem: '', need: true, who: 'Riley' }, { a: 'queuedStopped' }, 1, [{ key: 'queue.handoff.integrator', params: { name: 'Riley' } }]]);
  const unreadable = draw(view(items, { repository: { root: '/synthetic/main', problem: 'error.handoff.repositoryUnsafe' } }));
  assert.deepEqual([plain(unreadable.block.repository), where(unreadable), unreadable.need], [{ root: '/synthetic/main', problem: 'error.handoff.repositoryUnsafe', need: true, who: 'Riley' }, { a: 'queuedStopped' }, 1]);
  const fine = draw(view(items));
  assert.deepEqual([plain(fine.block.repository), fine.need], [{ root: '/synthetic/main', problem: '', need: false, who: 'Riley' }, 0]);
  // An engine without a repository object (older view) shows no line.
  assert.equal(draw(view(items, { repository: null })).block.repository, null);
  // The designated integrator sits in a space.
  const inSpace = draw(view(items, { reasons: [{ reason: 'integrator-in-space', notice: 'shown' }] }));
  assert.deepEqual([plain(inSpace.block.stops), where(inSpace), inSpace.need], [[{ key: 'queue.handoff.stopped.inSpace', params: {} }], { a: 'queuedStopped' }, 1]);
  assert.deepEqual(plain(draw(view(items, { reasons: [{ reason: 'review-off', notice: 'shown' }] })).block.stops), []);
  // A space with nothing on its way (all merged, returned or on hold) is not asked for either: the folder is shown, without weight or count.
  for (const settled of [{ c: item('c', 'merged') }, { c: item('c', 'returned') }, { c: item('c', 'held') }]) {
    const quiet = draw(view(settled, { repository: { root: null, problem: null }, reasons: [{ reason: 'integrator-in-space', notice: 'shown' }] }));
    assert.deepEqual([plain(quiet.block.repository), plain(quiet.block.stops), quiet.need], [{ root: '', problem: '', need: false, who: 'Riley' }, [], settled.c.state === 'merged' ? 0 : 1], settled.c.state);
  }
  // A delivery the integrator already has waits for the repository as well: its merge cannot be checked.
  const handedOut = draw(view({ b: item('b', 'handed') }, { summary: { handoff: sent }, repository: { root: '/synthetic/main', problem: 'error.handoff.repositoryUnsafe' } }));
  assert.deepEqual([handedOut.block.repository.need, handedOut.need], [true, 1]);
  // A question left open about an integrator that is no longer designated stops nothing and is not said: what waits for
  // the person there is the one thing "nobody is designated", counted once.
  const left = draw(view(items, { reasons: [{ reason: 'integrator-in-space', notice: 'shown' }] }), { integrator: null });
  assert.deepEqual([plain(left.block.stops), where(left), left.need], [[], { a: 'queuedNone' }, 1]);
});

test('a row that waits for the person stays in the list however old its task is, and comes first when the panel opens', () => {
  const items = { old: item('old', 'held'), gone: item('gone', 'returned', { text: '' }), asked: item('asked', 'asking'), fine: item('fine', 'merged'), back: item('back', 'returned', { redone: true }) };
  const result = model({ view: view(items, waitingFor('no-reply', [])), queue: [{ id: 'old' }, { id: 'asked' }, { id: 'fine' }], sessions, members: [], integrator: INTEGRATOR });
  assert.deepEqual([result.keep, plain(result.orphans)], [['old', 'asked'], [{ itemId: 'gone', text: 'lane/gone' }]]);
  // The same rows are the ones that come first: what needs the person, and what the waiting handoff is about (which needs no step of its own).
  assert.deepEqual(Object.fromEntries(Object.entries(result.rows).map(([id, row]) => [id, [row.front, row.need]])), { old: [true, true], gone: [true, true], asked: [true, false], fine: [false, false], back: [false, false] });
  // Opening: what needs the person first, the rest as they were. Open: nothing moves; what is new goes last; what is gone leaves.
  assert.deepEqual(order(null, ['a', 'b', 'c', 'd'], new Set(['c', 'd'])), ['c', 'd', 'a', 'b']);
  assert.deepEqual(order(['c', 'd', 'a', 'b'], ['a', 'b', 'c', 'e', 'f'], new Set(['a', 'f'])), ['c', 'a', 'b', 'e', 'f']);
  assert.deepEqual(order(null, [], new Set()), []);
});

test('every sentence the panel can show exists in both languages with the same blanks', () => {
  const messages = fs.readFileSync(path.join(__dirname, '../ui-messages.js'), 'utf8');
  const keys = [...new Set([...messages.matchAll(/"(queue\.handoff\.[A-Za-z.]+|queue\.titleNeed|os\.chooseRepository)":/g)].map(match => match[1]))];
  assert.ok(keys.length >= 60, String(keys.length));
  const blanks = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort().join();
  for (const key of keys) {
    const zh = locale.format('zh', key), en = locale.format('en', key);
    assert.ok(zh && en && zh !== key && en !== key && (zh !== en || key === 'queue.handoff.aboutSeparator'), key);
    assert.equal(blanks(zh), blanks(en), key);
  }
  // Whatever the model and the main process name is among them.
  const used = new Set();
  const collect = value => { if (!value || typeof value !== 'object') return; if (typeof value.key === 'string' && value.key.startsWith('queue.handoff.')) used.add(value.key); for (const inner of Object.values(value)) collect(inner); };
  const reasons = ['review-off', 'review-cap', 'checkpoint-invalid', 'merge-unverified', 'main-unreadable', 'send-unconfirmed', 'send-refused', 'record-missing', 'no-result', 'no-reply', 'person-intervened', 'held-other',
    'lock-held:Someone', 'integrator-missing:gone', 'conflict:H1-00000000', 'returned-limit:shared:lane/a', 'integrator-unset', 'made-up', undefined];
  for (const reason of reasons) { collect(rowWords({ reason })); collect(rowWords({ reason, note: 'words' })); }
  const all = { a: item('a', 'queued'), b: item('b', 'handed'), c: item('c', 'merged'), d: item('d', 'held'), e: item('e', 'returned', { note: 'n' }), f: item('f', 'returned', { redone: true }), g: item('g', 'returned', { memberId: 'gone' }), h: item('h', 'asking') };
  for (const extra of [{}, { summary: { handoff: sent } }, waitingFor('conflict:H1-00000000', []), waitingFor('no-reply', []), { repository: { root: null, problem: null } }, { reasons: [{ reason: 'integrator-in-space' }] },
    { engineFault: { message: 'm' }, fault: { message: 'm' } }]) { collect(draw(view(all, extra))); collect(draw(view(all, extra), { integrator: null })); }
  collect(model({ failed: true })); collect(model({ view: { started: false } }));
  for (const key of used) assert.ok(keys.includes(key), key);
  for (const state of ['queuedNone', 'queuedNext', 'queuedBusy', 'queuedAsk', 'queuedStopped', 'handed', 'asking', 'stalled', 'merged', 'held', 'returned', 'redone']) assert.ok(used.has('queue.handoff.row.' + state), state);
  // The renderer's own keys: each one it names literally, and each it builds from a kind.
  const renderer = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
  const literal = [...renderer.matchAll(/'(queue\.handoff\.[A-Za-z.]+|queue\.titleNeed)'/g)].map(match => match[1]);
  assert.ok(literal.length >= 12, String(literal.length));
  // (A key that ends in a dot is completed with the kind of the waiting handoff: every kind has its sentence.)
  for (const key of literal) assert.ok(key.endsWith('.') ? (key === 'queue.handoff.ask.' ? ['asks', 'noReply', 'typed', 'inSpace', 'other'] : ['asks', 'inSpace', 'other']).every(kind => keys.includes(key + kind)) : keys.includes(key), key);
  assert.match(renderer, /words = \['asks', 'inSpace'\]\.includes\(ask\.kind\) \? ask\.kind : 'other'/);
  // And the page is wired: the module is loaded before the renderer in the page and in the bundle, and the panel has its place.
  const html = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8'), build = fs.readFileSync(path.join(__dirname, '../../scripts/build-ui.cjs'), 'utf8');
  assert.ok(html.indexOf('src="handoff-queue.js"') > 0 && html.indexOf('src="handoff-queue.js"') < html.indexOf('src="renderer.js"'));
  assert.match(build, /'handoff-queue\.js', 'renderer\.js'\]/);
  assert.match(html, /<section id="queue-handoff" hidden><\/section><p id="queue-handoff-error" role="alert" hidden><\/p><div id="queue-list"><\/div>/);
  // A refused step is said inside the panel, never in a toast behind it: the panel's buttons do not go through the general error toast.
  const button = renderer.slice(renderer.indexOf('function queueHandoffButton('), renderer.indexOf('// The state of a task\'s delivery on the task\'s own row'));
  assert.ok(button.includes('queueHandoffError(error, refused)') && !/attempt\(|uiButton\(|toast/.test(button), 'The panel shows its own refusals');
  // "Choose another folder" heads only the refusals that are about the folder, never a record or a dialog that failed.
  assert.match(renderer, /const QUEUE_FOLDER_REFUSALS = \['error\.handoff\.repositoryNotMain', 'error\.handoff\.repositoryUnsafe', 'error\.handoff\.repositoryNoMain'\];/);
  assert.match(renderer, /if \(!headline \|\| !QUEUE_FOLDER_REFUSALS\.includes\(error\?\.uiMessage\?\.key\)\) \{ ui\.showError\(line, error\); return; \}/);
  // Nothing is asked of the main process, and nothing drawn, unless the state says handoffs are enabled.
  for (const name of ['loadHandoff', 'noteHandoffState', 'queueHandoffModel', 'renderQueueNeed']) {
    const start = renderer.indexOf(`function ${name}(`);
    assert.ok(start > 0 && /^[^\n]*\n\s*if \(state\.handoffEnabled !== true/.test(renderer.slice(start)), name);
  }
});
