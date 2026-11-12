const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const locale = require('../ui-locale.js');
const { RoomState } = require('../room-state.cjs');
const { IntegrationHandoffs } = require('../integrator-handoff.cjs');
const { spaceWords, personWords, rowWords, group } = require('../integrator-words.cjs');

// The sentences a delivery's space and the person are given about an integration handoff (B6 E2b,
// checkpoint H6a). Synthetic deliveries; nothing is sent, shown or connected.
const COMMIT = '61'.repeat(20), HEAD = 'b'.repeat(40), SPACE = 'abcdef01-2345-4678-9abc-def012345678';
const TASK = 'Private task text 中文';
const fact = (extra = {}) => ({ key: 'ready:shared:item-1', roomId: 'shared', itemId: 'item-1', branch: 'lane/a', commit: COMMIT, label: 'handed:H1-abcdef12', outcome: 'handed',
  handoffId: 'H1-abcdef12', memberId: 'member-a', memberName: 'Member a', text: 'Fix the list', ...extra });
const say = (language, words) => locale.format(language, words.key, words.params);
// Every reason the record can produce, with the sentence group it belongs to.
const REASONS = { 'review-off': 'reviewOff', 'review-cap': 'reviewCap', 'checkpoint-invalid': 'checkpointInvalid', 'merge-unverified': 'unverified', 'main-unreadable': 'mainUnreadable', 'merged-earlier': 'mergedEarlier',
  'send-unconfirmed': 'notDelivered', 'send-refused': 'sendRefused', 'record-missing': 'replyUnread', 'no-result': 'noAnswer', 'no-reply': 'noReply', 'person-intervened': 'personTyped',
  'held-other': 'other', 'integrator-unset': 'integratorUnset', 'integrator-in-space': 'integratorInSpace', 'backlog-full': 'backlogFull', 'repository-unset': 'repositoryUnset',
  'lock-held:Claude 终端': 'lockHeld', 'integrator-missing:session-9': 'integratorGone', 'conflict:H2-12345678': 'conflict', [`installable:${HEAD}`]: 'installable', 'returned-limit:shared:lane/a': 'returnedLimit' };

test('every reason the record knows has a sentence group; anything else has none', () => {
  for (const [reason, name] of Object.entries(REASONS)) assert.equal(group(reason)?.name, name, reason);
  assert.deepEqual(group('lock-held:Claude 终端'), { name: 'lockHeld', subject: 'Claude 终端' });
  assert.deepEqual(group('returned-limit:shared:lane/a'), { name: 'returnedLimit', subject: 'shared:lane/a' });
  for (const unknown of ['made-up', 'lock-held', 'lock-held:', 'toString', '__proto__', '', null, 7, 'conflict']) assert.equal(group(unknown), null, String(unknown));
  // The list above is the record's own: each of its reason kinds is here.
  const source = fs.readFileSync(path.join(__dirname, '../integrator-handoff.cjs'), 'utf8');
  const kinds = [...source.match(/const GLOBAL_REASONS = \[([^\]]+)\]/)[1].matchAll(/'([^']+)'/g), ...source.match(/const SUBJECT_REASONS = \[([^\]]+)\]/)[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
  assert.ok(kinds.length >= 20);
  for (const kind of kinds) assert.ok(Object.keys(REASONS).some(reason => reason === kind || reason.startsWith(kind + ':')), kind);
});

test('each state of a delivery has one sentence for its space, in both languages, with the delivery\'s own label', () => {
  const cases = [
    [fact(), '「Fix the list」的交付（lane/a 616161616161）已交给集成者', 'The delivery for “Fix the list” (lane/a 616161616161) was handed to the integrator'],
    [fact({ outcome: 'merged', label: `merged:${HEAD}`, as: HEAD, tests: { passed: 5124, total: 5124 } }), '「Fix the list」的交付（lane/a 616161616161）已合入 main：bbbbbbbbbbbb，测试 5124/5124', 'The delivery for “Fix the list” (lane/a 616161616161) was merged into main as bbbbbbbbbbbb; tests 5124/5124'],
    [fact({ outcome: 'returned', label: 'returned', note: 'needs a rebase' }), '「Fix the list」的交付（lane/a 616161616161）被集成者退回：needs a rebase', 'The delivery for “Fix the list” (lane/a 616161616161) was returned by the integrator: needs a rebase'],
    [fact({ outcome: 'held', reason: 'lock-held:Claude 终端' }), '「Fix the list」的交付（lane/a 616161616161）先搁着：合并锁被 Claude 终端 占着', 'The delivery for “Fix the list” (lane/a 616161616161) is on hold: the merge lock is held by Claude 终端'],
    [fact({ outcome: 'held', reason: 'held-other', note: 'waiting for a design answer' }), '「Fix the list」的交付（lane/a 616161616161）先搁着，集成者写的原因：waiting for a design answer', 'The delivery for “Fix the list” (lane/a 616161616161) is on hold. The integrator\'s reason: waiting for a design answer'],
    [fact({ outcome: 'waiting', reason: 'conflict:H1-abcdef12' }), '「Fix the list」的交付（lane/a 616161616161）在等你处理：集成者遇到冲突，要你决定', 'The delivery for “Fix the list” (lane/a 616161616161) is waiting for you: the integrator met a conflict and asks you to decide'],
    // A delivery without a task label is named by its branch; a return without a reason shows a dash.
    [fact({ text: undefined, outcome: 'returned', note: undefined }), '「lane/a」的交付（lane/a 616161616161）被集成者退回：—', 'The delivery for “lane/a” (lane/a 616161616161) was returned by the integrator: —'],
  ];
  for (const [input, zh, en] of cases) { const words = spaceWords(input); assert.equal(say('zh', words), zh); assert.equal(say('en', words), en); }
  // Every reason a delivery can be held under, and every reason a handoff can wait on, gives a sentence that exists and differs by language.
  const held = Object.keys(REASONS).filter(reason => !['integrator-unset', 'backlog-full'].includes(reason) && !/^(installable|returned-limit):/.test(reason));
  const seen = new Set();
  for (const reason of held) {
    const words = spaceWords(fact({ outcome: 'held', reason, note: 'the integrator\'s own words' }));
    assert.match(words.key, /^notice\.handoff\.held\.[A-Za-z]+$/, reason);
    const zh = say('zh', words), en = say('en', words);
    assert.ok(zh !== en && zh.startsWith('「Fix the list」的交付') && en.startsWith('The delivery for “Fix the list”') && !/\{\w+\}/.test(zh + en), reason);
    seen.add(words.key);
  }
  assert.equal(seen.size, 17, 'Seventeen different sentences for a delivery on hold');
  // A delivery that was already in main's history before its handoff began is said as that, and as waiting for the person's confirmation: never as merged.
  assert.equal(say('en', spaceWords(fact({ outcome: 'held', reason: 'merged-earlier' }))), 'The delivery for “Fix the list” (lane/a 616161616161) is on hold: the integrator reports it as merged, but it was already in main\'s history before this handoff began; it is recorded only once you confirm it');
  assert.equal(say('zh', spaceWords(fact({ outcome: 'held', reason: 'merged-earlier' }))), '「Fix the list」的交付（lane/a 616161616161）先搁着：集成者说已合入，但它在这次交接开始之前就已经在 main 的历史里了，要你确认之后才记为已合入');
  // A handoff that waits because its integrator sits in a space says that, for a delivery inside it and for one held from it afterwards.
  assert.equal(say('zh', spaceWords(fact({ outcome: 'waiting', reason: 'integrator-in-space' }))), '「Fix the list」的交付（lane/a 616161616161）在等你处理：集成者进了一个协作空间，它写的东西不再当作这次交接的答复');
  assert.equal(say('en', spaceWords(fact({ outcome: 'waiting', reason: 'integrator-in-space' }))), 'The delivery for “Fix the list” (lane/a 616161616161) is waiting for you: the integrator is inside a collaboration space, so what it writes is no longer read as this handoff\'s answer');
  assert.equal(say('en', spaceWords(fact({ outcome: 'held', reason: 'integrator-in-space' }))), 'The delivery for “Fix the list” (lane/a 616161616161) is on hold: the integrator was inside a collaboration space during the handoff');
  // The three troubles with the message itself are told apart, because what the person does next differs.
  const onHold = reason => say('en', spaceWords(fact({ outcome: 'held', reason })));
  assert.equal(onHold('send-unconfirmed'), 'The delivery for “Fix the list” (lane/a 616161616161) is on hold: the handoff message could not be confirmed as delivered to the integrator');
  assert.equal(onHold('send-refused'), 'The delivery for “Fix the list” (lane/a 616161616161) is on hold: the handoff message was refused several times before it was sent; automatic messages may be off');
  assert.equal(onHold('record-missing'), 'The delivery for “Fix the list” (lane/a 616161616161) is on hold: NAW could not read the integrator\'s reply; look in its session');
  for (const [reason, name] of [['no-reply', 'noReply'], ['person-intervened', 'personTyped'], ['conflict:H1-abcdef12', 'conflict']]) {
    const words = spaceWords(fact({ outcome: 'waiting', reason }));
    assert.equal(words.key, `notice.handoff.waiting.${name}`); assert.notEqual(say('zh', words), say('en', words));
  }
  // A reason from a later version still gets a sentence: the integrator's words, or the reason's name.
  assert.equal(say('en', spaceWords(fact({ outcome: 'held', reason: 'made-up-later' }))), 'The delivery for “Fix the list” (lane/a 616161616161) is on hold. The integrator\'s reason: made-up-later');
  // A handoff waiting for a reason that has no waiting sentence is not given a cause it does not have.
  for (const reason of ['review-off', 'made-up-later']) {
    const words = spaceWords(fact({ outcome: 'waiting', reason }));
    assert.equal(words.key, 'notice.handoff.waiting.other');
    assert.deepEqual([say('zh', words), say('en', words)], ['「Fix the list」的交付（lane/a 616161616161）在等你处理', 'The delivery for “Fix the list” (lane/a 616161616161) is waiting for you']);
  }
  // A condition that holds no deliveries has no "on hold" sentence of its own.
  for (const reason of ['backlog-full', 'integrator-unset', `installable:${HEAD}`]) assert.equal(spaceWords(fact({ outcome: 'held', reason })).key, 'notice.handoff.held.other', reason);
  // What has no sentence is not written at all.
  for (const bad of [null, {}, fact({ outcome: 'deliverable' }), fact({ outcome: 'superseded' }), fact({ outcome: 'merged' }), fact({ outcome: 'merged', as: HEAD, tests: { passed: '1', total: 1 } }), fact({ commit: 7 })]) assert.equal(spaceWords(bad), null);
});

test('the person\'s notice says how many deliveries and why, in both languages, and never carries task text', () => {
  const cases = [
    [{ reason: 'review-off', count: 3, roomId: 'shared', itemId: 'item-1' }, '3 件交付要独立审查，而审查关着', 'Reviews are off, and deliveries need an independent review. Waiting: 3'],
    [{ reason: 'lock-held:Claude 终端', count: 1 }, '合并锁被 Claude 终端 占着，1 件交付在等', 'The merge lock is held by Claude 终端. Deliveries waiting: 1'],
    [{ reason: 'main-unreadable', count: 2 }, 'NAW 没能读项目文件夹，2 件合入没法核对', 'NAW could not read the project folder. Merges that could not be checked: 2'],
    [{ reason: `installable:${HEAD}`, count: 0 }, 'main 已合入新的交付（bbbbbbbbbbbb），可以安装', 'New deliveries were merged into main (bbbbbbbbbbbb); it can be installed'],
    [{ reason: `returned-limit:${SPACE}:lane/a`, count: 0 }, '分支 lane/a 被退回超过 2 次，请你决定怎么办', 'Branch lane/a was returned more than twice; please decide what to do'],
    [{ reason: 'returned-limit:lane/b', count: 0 }, '分支 lane/b 被退回超过 2 次，请你决定怎么办', 'Branch lane/b was returned more than twice; please decide what to do'],
    [{ reason: 'conflict:H2-12345678', count: 2, sessionId: 'integrator' }, '集成者遇到冲突，要你决定；2 件交付在等', 'The integrator met a conflict and asks you to decide. Deliveries waiting: 2'],
    // A handoff that waits with nothing left inside is not worded as "0 deliveries".
    [{ reason: 'conflict:H2-12345678', count: 0, sessionId: 'integrator' }, '集成者有一件事要你决定，问题在它的会话里', 'The integrator asks you to decide something; its question is in its session'],
    [{ reason: 'backlog-full', count: 500 }, '等集成的交付太多，新的没有收进来', 'Too many deliveries are waiting to be integrated; new ones were not taken in'],
    // No reply says why it matters: the waiting handoff holds the only place.
    [{ reason: 'no-reply', count: 3, sessionId: 'integrator' }, '集成者没有回复这次交接；它占着唯一的位置，后面的交付都要等你处理（里面有 3 件）', 'The integrator did not answer this handoff. It holds the only place, so later deliveries wait until you deal with it. Deliveries inside: 3'],
    [{ reason: 'send-refused', count: 2 }, '交接消息几次都没能发出去，2 件交付搁着；请看自动消息是不是关着', 'The handoff message was refused several times before it was sent; check whether automatic messages are off. Deliveries on hold: 2'],
    [{ reason: 'record-missing', count: 1 }, 'NAW 读不到集成者的回复，1 件交付搁着；请到它的会话里看', 'NAW could not read the integrator\'s reply; look in its session. Deliveries on hold: 1'],
    [{ reason: 'send-unconfirmed', count: 1 }, '交接消息没能确认送到集成者，1 件交付搁着', 'The handoff message could not be confirmed as delivered. Deliveries on hold: 1'],
    [{ reason: 'no-result', count: 1 }, '集成者没有给出 1 件交付的结果', 'The integrator gave no result. Deliveries: 1'],
    [{ reason: 'integrator-in-space', count: 4 }, '指定的集成者在协作空间里，4 件交付先停着；请把它移出空间或另行指定', 'The designated integrator is inside a collaboration space; move it out or designate another. Deliveries paused: 4'],
    [{ reason: 'merged-earlier', count: 2 }, '2 件交付在交接开始之前就已经在主线的历史里了，要你确认之后才记为已合入', 'Deliveries that were already in main\'s history before their handoff began are recorded as merged only once you confirm them. Waiting for you: 2'],
  ];
  for (const [info, zh, en] of cases) {
    const words = personWords(info);
    assert.equal(words.title, 'os.handoffTitle');
    assert.equal(say('zh', words), zh); assert.equal(say('en', words), en);
  }
  assert.equal(locale.format('zh', 'os.handoffTitle'), 'NAW · 集成交接要你处理'); assert.equal(locale.format('en', 'os.handoffTitle'), 'NAW · Integration handoff needs you');
  // Every reason gives a notice, except the person's own typing, which is never announced to them.
  for (const reason of Object.keys(REASONS)) {
    const words = personWords({ reason, count: 2 });
    if (reason === 'person-intervened') { assert.equal(words, null); continue; }
    const zh = say('zh', words), en = say('en', words);
    assert.ok(zh && en && zh !== en && !/\{\w+\}/.test(zh + en), reason);
  }
  for (const bad of [null, {}, { reason: 'made-up', count: 1 }, { reason: 7 }]) assert.equal(personWords(bad), null);
  assert.equal(say('en', personWords({ reason: 'review-off', count: -3 })), 'Reviews are off, and deliveries need an independent review. Waiting: 0');
  assert.equal(say('zh', personWords({ reason: 'repository-unset', count: 2 })), '2 件交付在等集成，但没有可用的项目文件夹：还没有选，或者选的那个现在通不过检查');
  // A notice is built from the record's own notice info, which holds no task text to begin with.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-words-')); fs.chmodSync(directory, 0o700);
  try {
    const handoffs = new IntegrationHandoffs(directory);
    handoffs.noteReady({ key: 'ready:shared:item-1', roomId: 'shared', itemId: 'item-1', branch: 'lane/a', commit: COMMIT, memberName: 'Member a', text: TASK }, 1_800_000_000_000);
    handoffs.hold('ready:shared:item-1', 'review-off', 1_800_000_000_000);
    const info = handoffs.noticeInfo('review-off'), words = personWords(info);
    assert.ok(!JSON.stringify(info).includes('Private') && !JSON.stringify(words).includes('Private') && !say('zh', words).includes('Private'));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('the space record is written once per delivery and state, into the space that delivered it', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-words-room-')); fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const room = new RoomState(directory), other = room.create('Another synthetic team');
  const events = id => room.metadata(id).events.filter(event => event.monitor?.kind === 'handoff');
  assert.deepEqual(room.recordHandoff(fact()), { recorded: true });
  const written = events('shared')[0];
  assert.deepEqual([written.kind, written.role, written.sessionId, written.text, written.uiMessage.key], ['monitor', 'system', 'member-a', '「Fix the list」的交付（lane/a 616161616161）已交给集成者', 'notice.handoff.handed']);
  assert.equal(locale.displayText('en', written.text, written.uiMessage), 'The delivery for “Fix the list” (lane/a 616161616161) was handed to the integrator');
  assert.deepEqual(written.monitor, { kind: 'handoff', key: 'handoff:ready:shared:item-1:handed:H1-abcdef12', itemId: 'item-1', outcome: 'handed', branch: 'lane/a', commit: COMMIT, handoffId: 'H1-abcdef12' });
  assert.ok(Number.isFinite(written.time) && typeof written.id === 'string');
  // The same delivery and label again, as after a crash, writes nothing: also after a restart.
  const before = JSON.stringify(room.metadata('shared'));
  assert.deepEqual(room.recordHandoff(fact()), { recorded: false, why: 'known' });
  assert.deepEqual(new RoomState(directory).recordHandoff(fact()), { recorded: false, why: 'known' });
  assert.equal(JSON.stringify(room.metadata('shared')), before);
  // A new state of the same delivery is a new record; the monitor carries what a reader needs, not the task text.
  assert.deepEqual(room.recordHandoff(fact({ outcome: 'held', label: 'held:lock-held:Claude 终端', reason: 'lock-held:Claude 终端', handoffId: undefined })), { recorded: true });
  assert.deepEqual(room.recordHandoff(fact({ outcome: 'merged', label: `merged:${HEAD}`, as: HEAD, tests: { passed: 9, total: 9 }, handoffId: undefined, text: TASK })), { recorded: true });
  assert.deepEqual(events('shared').map(event => [event.monitor.outcome, event.monitor.reason, event.monitor.as]), [['handed', undefined, undefined], ['held', 'lock-held:Claude 终端', undefined], ['merged', undefined, HEAD]]);
  assert.ok(!JSON.stringify(events('shared').map(event => event.monitor)).includes('Private'));
  // Each record goes to its own space, and only there.
  assert.deepEqual(room.recordHandoff(fact({ key: `ready:${other}:item-9`, roomId: other, itemId: 'item-9' })), { recorded: true });
  assert.deepEqual([events('shared').length, events(other).length], [3, 1]);
  // A space that no longer exists, an id that is not a space, or a fact without a sentence: nothing is written and nothing fails.
  for (const [input, why] of [[fact({ roomId: 'abcdef01-0000-4000-8000-000000000009' }), 'space-missing'], [fact({ roomId: 'not-a-space' }), 'space-missing'], [fact({ outcome: 'superseded' }), 'no-words'],
    [fact({ label: '' }), 'no-words'], [fact({ key: undefined }), 'no-words'], [null, 'no-words']]) assert.deepEqual(room.recordHandoff(input), { recorded: false, why }, why);
  assert.deepEqual([events('shared').length, events(other).length], [3, 1]);
  // A space that is being updated refuses for now, so the caller tries again later.
  room.gates.add('room'); room.gates.add(`room:${other}`);
  assert.throws(() => room.recordHandoff(fact({ label: 'handed:H2-00000000', handoffId: 'H2-00000000' })), error => error.uiMessage?.key === 'error.room.updatingDraftRetained');
  room.gates.clear();
  assert.deepEqual(room.recordHandoff(fact({ label: 'handed:H2-00000000', handoffId: 'H2-00000000' })), { recorded: true });
});

test('a held delivery\'s row in the queue panel says its cause in one short sentence, in both languages, without the task\'s text', () => {
  const OWN = ['reviewOff', 'reviewCap', 'lockHeld', 'checkpointInvalid', 'unverified', 'mainUnreadable', 'mergedEarlier', 'notDelivered', 'sendRefused', 'replyUnread', 'noAnswer', 'noReply', 'personTyped', 'integratorGone', 'integratorInSpace', 'conflict'];
  const seen = new Set();
  for (const [reason, name] of Object.entries(REASONS)) {
    const words = rowWords({ reason, note: 'the integrator wrote this', text: TASK });
    const expected = OWN.includes(name) ? name : 'other';
    assert.equal(words.key, `queue.handoff.why.${expected}`, reason);
    assert.deepEqual(words.params, name === 'lockHeld' ? { owner: 'Claude 终端' } : expected === 'other' ? { note: 'the integrator wrote this' } : {}, reason);
    for (const language of ['zh', 'en']) {
      // (The panel adds what it calls the integrator: its session's name, known to the page.)
      const said = locale.format(language, words.key, { ...words.params, who: 'Riley' });
      assert.ok(said && said !== words.key && !said.includes('{') && !said.includes(TASK), `${language} ${reason}`);
      if (name === 'conflict') assert.ok(said.includes('Riley'), `${language}: the row says whose session to go to`);
      // A person cannot look into main: the row sends them to the integrator's session first, and says which button follows from each answer.
      // (Merged anew, the delivery may be held this way once more: its commits were in main's history before that handoff too. The row says what to press then.)
      if (name === 'mergedEarlier') {
        assert.equal(said, language === 'zh'
          ? 'Riley说这件已经合入，但这件改动在这次交接开始前就进过主线，NAW 查不出后来有没有被撤掉，所以没有自动记为已合入。不确定就先在Riley的会话里问它现在还在不在：在，按「确认已合入」；不在，按「再交给Riley」重新合。重新合之后这一行可能还会出现，那时Riley说合好了，就按「确认已合入」。'
          : 'Riley reports this as merged, but the change was already in main\'s history before this handoff began, and NAW cannot tell whether it was undone since, so it was not recorded as merged. If you are not sure, first ask Riley in its session whether it is still there: if it is, press "Confirm merged"; if it is not, "Send to Riley again" to have it merged anew. This row may come back after that; once Riley says it is in, press "Confirm merged".');
        for (const label of ['queue.handoff.confirm', 'queue.handoff.send']) assert.ok(said.includes(locale.format(language, label, { who: 'Riley' })), `${language}: the sentence names the button as it is written (${label})`);
      }
      if (name === 'lockHeld') assert.ok(said.includes('Claude 终端'));
      if (expected === 'other') assert.ok(said.includes('the integrator wrote this'));
    }
    seen.add(expected);
  }
  assert.deepEqual([...seen].sort(), [...OWN, 'other'].sort(), 'Every sentence of a held row is reached by some reason');
  // A reason without a sentence of its own and without the integrator's words says only that none was given, never the record's name for it.
  for (const item of [{ reason: 'held-other' }, { reason: 'integrator-unset' }, { reason: 'made-up' }, { reason: 'held-other', note: '' }, { reason: 'held-other', note: 7 }, { reason: 7 }, {}, null, undefined]) {
    assert.deepEqual(rowWords(item), { key: 'queue.handoff.why.unknown', params: {} }, JSON.stringify(item));
  }
  assert.notEqual(say('zh', rowWords({})), say('en', rowWords({})));
});

test('the words module only maps: it loads nothing, and only the space record and the main process\'s notice load it', () => {
  const source = fs.readFileSync(path.join(__dirname, '../integrator-words.cjs'), 'utf8');
  assert.deepEqual([...source.matchAll(/require\(/g)].length, 0);
  const root = path.join(__dirname, '../..'), loaders = [];
  const walk = directory => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) { if (!['node_modules', '.git', '.local', 'tests', 'dist'].includes(entry.name)) walk(file); }
    else if (/\.(cjs|mjs|js)$/.test(entry.name) && entry.name !== 'integrator-words.cjs' && /integrator-words(\.cjs)?['"`]/.test(fs.readFileSync(file, 'utf8'))) loaders.push(path.relative(root, file));
  } };
  walk(path.join(root, 'app')); walk(path.join(root, 'scripts'));
  assert.deepEqual(loaders.sort(), ['app/main.cjs', 'app/room-state.cjs', 'scripts/package-mac.cjs']);
});
