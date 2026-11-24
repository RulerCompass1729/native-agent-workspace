// 11-24 加项 1+5: 「用户完全看不出到底在干啥」 — the in-progress row, the member card and the session header
// name the running command, its start time and (Codex) the last output line.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const board = require('../renderer/task-board.js'), locale = require('../ui-locale.js'), distribution = require('../renderer/agent-distribution.js');
const { fixture } = require('./fixtures/task-board-dom.cjs');
const now = new Date(2026, 10, 23, 20, 16, 2).getTime(), minute = 60000, started = now - 9 * minute - 2000;
const renderer = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
const slice = (from, to) => { const a = renderer.indexOf(from), b = renderer.indexOf(to, a); assert.ok(a >= 0 && b > a, from); return renderer.slice(a, b); };

const claudeRow = extra => ({ role: 'tool', kind: 'tool', status: 'running', nativeId: 'n-b', turnId: 't-b', time: started, title: 'Bash',
  input: JSON.stringify({ command: 'python3 scripts/build-local.py', description: 'Wait for memory pressure, then package' }), text: '', ...extra });
const codexRow = extra => ({ role: 'tool', kind: 'tool', status: 'running', nativeId: 'n-c', turnId: 't-c', time: started, toolKind: 'commandExecution',
  title: 'node --test app/tests\n--second', text: 'starting\n\x1b[32m▶ suite-1: 5/5\x1b[0m\r\n▶ suite-2: 2/5 files\r\n\n', ...extra });
const claude = (messages, extra) => ({ id: 'b', nativeId: 'n-b', activeTurnId: 't-b', state: 'working', messages, ...extra });

test('a Claude running command gives its description and start, and no output line', () => {
  assert.deepEqual(board.runningStep(claude([{ role: 'user', text: 'go' }, claudeRow()])),
    { tool: 'Bash', detail: 'Wait for memory pressure, then package', startedAt: started, lastLine: '' });
  const bare = board.runningStep(claude([claudeRow({ input: JSON.stringify({ command: 'sleep 600\necho done' }) })]));
  assert.equal(bare.detail, 'sleep 600', 'without a description, the first command line');
  assert.equal(board.runningStep(claude([claudeRow({ title: 'Read', input: JSON.stringify({ file_path: '/synthetic/a.js' }) })])).detail, '/synthetic/a.js');
  assert.equal(board.runningStep(claude([claudeRow({ input: '{not json' })])).detail, '');
});

test('a Codex running command gives its first command line and its last clean output line', () => {
  const step = board.runningStep({ id: 'c', nativeId: 'n-c', activeTurnId: 't-c', state: 'working', messages: [codexRow()] });
  assert.deepEqual(step, { tool: 'Bash', detail: 'node --test app/tests', startedAt: started, lastLine: '▶ suite-2: 2/5 files' });
  const progress = board.runningStep({ id: 'c', nativeId: 'n-c', activeTurnId: 't-c', state: 'working', messages: [codexRow({ text: 'copying 10%\rcopying 55%' })] });
  assert.equal(progress.lastLine, 'copying 55%', 'a carriage-return progress line shows its latest state');
  const long = board.runningStep({ id: 'c', nativeId: 'n-c', activeTurnId: 't-c', state: 'working', messages: [codexRow({ text: 'x'.repeat(500) })] });
  assert.equal(long.lastLine.length, 200);
});

test('only a running tool of the current native turn counts, and the newest one wins', () => {
  assert.equal(board.runningStep(claude([claudeRow({ turnId: 'old-turn' })])), null);
  assert.equal(board.runningStep(claude([claudeRow({ nativeId: 'other-native' })])), null);
  assert.equal(board.runningStep(claude([claudeRow({ status: 'completed' })])), null);
  assert.equal(board.runningStep(claude([claudeRow({ time: undefined })])), null);
  assert.equal(board.runningStep(claude([{ ...claudeRow(), role: 'assistant' }])), null);
  for (const extra of [{ state: 'idle' }, { state: 'approval' }, { transportDisconnected: true }, { backendUnavailable: true }, { activeTurnId: '' }])
    assert.equal(board.runningStep(claude([claudeRow()], extra)), null, JSON.stringify(extra));
  const newest = board.runningStep(claude([claudeRow(), claudeRow({ time: started + 1000, input: JSON.stringify({ description: 'Second' }) })]));
  assert.equal(newest.detail, 'Second');
  const idle = { id: 'i', nativeId: 'n-i', activeTurnId: 't', state: 'idle' };
  Object.defineProperty(idle, 'messages', { get() { throw Error('Conversation bodies of a session that is not working must not be read'); } });
  assert.equal(board.runningStep(idle), null);
});

function boardInput(steps) {
  return {
    rooms: [{ id: 'dev', name: 'Dev space', queue: [
      { id: 'aaaaaaaa1111', status: 'sent', sentTo: 'b', text: 'Install synthetic build', sentAt: now - 16 * minute },
      { id: 'bbbbbbbb2222', status: 'sent', sentTo: 'b', text: 'Older synthetic item', sentAt: now - 40 * minute },
      { id: 'cccccccc3333', status: 'sent', sentTo: 'c', text: 'Run synthetic suite', sentAt: now - 7 * minute },
      { id: 'dddddddd4444', status: 'queued', assignee: 'i', text: 'Queued synthetic' },
    ] }],
    sessions: [
      { id: 'b', nativeId: 'n-b', name: 'B', state: 'working', roomIds: ['dev'], step: steps.b },
      { id: 'c', nativeId: 'n-c', name: 'C', state: 'working', roomIds: ['dev'], step: steps.c },
      { id: 'i', nativeId: 'n-i', name: 'I', state: 'idle', roomIds: ['dev'], step: steps.i },
    ],
    confirmations: [], confirmationsAvailable: true, connected: true,
  };
}
const clock = value => new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(value);
function open(language, steps) {
  const f = fixture();
  f.board = board.bind({ host: f.host, document: f.doc, text: (k, p) => locale.format(language, k, p), now: () => now, onQueue() {}, onSession() {} });
  f.board.update(boardInput(steps)); f.board.open();
  f.row = id => f.host.querySelectorAll('.task-board-task').find(e => e.dataset.taskKey.includes(id));
  f.card = id => f.host.querySelector('.task-board-people').querySelector('[data-person-id="' + id + '"]');
  return f;
}
const action = language => locale.format(language, 'activity.tool.Bash');
const steps = language => ({
  b: { action: action(language), detail: 'Wait for memory pressure, then package', startedAt: started, lastLine: '' },
  c: { action: action(language), detail: 'node --test app/tests', startedAt: now - 5 * minute, lastLine: '▶ suite-2: 2/5 files' },
  i: { action: action(language), detail: 'should not show', startedAt: started, lastLine: 'should not show' },
});

for (const language of ['zh', 'en']) test(language + ': the in-progress row and the card say what runs and since when; only the member\'s newest item carries it', () => {
  const f = open(language, steps(language));
  try {
    const at = clock(started), b = f.row('aaaaaaaa'), older = f.row('bbbbbbbb'), c = f.row('cccccccc');
    const words = language === 'zh' ? '正在运行命令：Wait for memory pressure, then package · ' + at + ' 起' : 'Running a command: Wait for memory pressure, then package · since ' + at;
    assert.equal(b.querySelector('.task-board-task-step').textContent, words);
    assert.equal(b.querySelector('.task-board-task-output'), null, 'Claude: no output line');
    assert.equal(older.querySelector('.task-board-task-step'), null, 'an older in-progress item of the same member');
    assert.equal(c.querySelector('.task-board-task-output').textContent, (language === 'zh' ? '最后输出：' : 'Last output: ') + '▶ suite-2: 2/5 files');
    const card = f.card('b');
    assert.equal(card.querySelector('.task-board-person-step').textContent, words);
    assert.ok(card.getAttribute('aria-label').endsWith(' · ' + words), card.getAttribute('aria-label'));
    assert.ok(f.card('c').getAttribute('aria-label').endsWith('▶ suite-2: 2/5 files'));
    assert.ok(!f.host.textContent.includes('should not show'), 'an idle member shows no step');
    if (language === 'en') assert.ok(!/[一-鿿]/.test(b.textContent + card.textContent), b.textContent);
    f.board.update(boardInput({}));
    assert.equal(f.row('aaaaaaaa').querySelector('.task-board-task-step'), null, 'the step line goes when the tool ends');
    assert.equal(f.card('b').querySelector('.task-board-person-step'), null);
  } finally { f.board.dispose(); }
});

test('a step that is not well formed is ignored by the board', () => {
  for (const bad of [{ action: '', detail: '', startedAt: started, lastLine: '' }, { action: 'x', detail: 1, startedAt: started, lastLine: '' }, { action: 'x', detail: '', startedAt: NaN, lastLine: '' }, { action: 'x', detail: '', startedAt: -1, lastLine: '' }]) {
    const f = open('zh', { b: bad });
    try {
      assert.equal(f.row('aaaaaaaa').querySelector('.task-board-task-step'), null, JSON.stringify(bad));
      assert.equal(f.card('b').querySelector('.task-board-person-step'), null);
    } finally { f.board.dispose(); }
  }
});

function intake(sessions, disconnected = false) {
  let input;
  const context = vm.createContext({ window: { nativeWorkspaceSpaces: require('../collaboration-spaces.cjs'), nativeWorkspaceFleet: require('../renderer/fleet-observation.js'), nativeWorkspaceAgentDistribution: distribution, nativeWorkspaceTaskBoard: board },
    sidebarPresentation: () => ({ compact: '', tone: 'working', workTone: '' }), uiText: (k, p) => locale.format('zh', k, p),
    state: { sessions, backgroundConfirmations: [], backgroundConfirmationsAvailable: true }, disconnected, spaceId: 'dev',
    allSpaces: () => [{ id: 'dev', name: 'Dev', queue: [] }], spaceName: r => r.name, taskBoard: { update(value) { input = value; } } });
  vm.runInContext(slice('function updateTaskBoard() {', '\nconst spaceCall') + '\nupdateTaskBoard();', context);
  return input;
}

test('the renderer hands the board four short facts of the running tool and reads no other session\'s conversation', () => {
  const idle = { id: 'i', nativeId: 'n-i', name: 'I', state: 'idle', roomIds: ['dev'] };
  Object.defineProperty(idle, 'messages', { get() { throw Error('Conversation access forbidden'); } });
  const input = intake([claude([claudeRow()], { name: 'B', roomIds: ['dev'] }), idle]);
  assert.deepEqual(JSON.parse(JSON.stringify(input.sessions[0].step)), { action: '正在运行命令', detail: 'Wait for memory pressure, then package', startedAt: started, lastLine: '' });
  assert.equal(input.sessions[1].step, null);
  assert.equal(JSON.stringify(input).includes('build-local'), false, 'the raw command input does not reach the board when a description exists');
  assert.equal(intake([claude([claudeRow()], { name: 'B', roomIds: ['dev'] })], true).sessions[0].step, null, 'nothing while the service is disconnected');
});

function header(s, extra = {}) {
  const elements = new Map(), $ = id => { if (!elements.has(id)) elements.set(id, { id, hidden: false, textContent: '' }); return elements.get(id); };
  const context = vm.createContext({ $, uiText: (k, p) => locale.format('zh', k, p), disconnected: false, Date: { now: () => now },
    nativeStatusFresh: value => value?.stale !== true, ui: { display: { computed(el, _kind, fn) { el.textContent = fn(); } } },
    window: { nativeWorkspaceTaskBoard: board, nativeWorkspaceAgentDistribution: distribution }, ...extra });
  vm.runInContext(slice('// Only known activity enums', 'const nativeActivityClock =') + slice('// The tool a session is running now', 'const spaceCall'), context);
  vm.runInContext('renderNativeActivity(session)', Object.assign(context, { session: s }));
  return { phase: $('native-phase').textContent, elapsed: $('native-elapsed').textContent, hidden: $('native-activity').hidden };
}

test('the session header names the running command and counts from its start', () => {
  const s = claude([claudeRow()], { name: 'B', nativeActivity: { nativeId: 'n-b', turnId: 't-b', label: 'tool', startedAt: now - 30 * minute } });
  assert.deepEqual(header(s), { phase: 'B · 正在运行命令：Wait for memory pressure, then package', elapsed: ' · 已用 9 分 02 秒', hidden: false });
  assert.equal(header({ ...s, messages: [] }).phase, 'B · 正在运行工具', 'without a running tool row the header stays as it was');
  assert.equal(header({ ...s, claudeQuestion: { pending: true } }).phase, 'B · 等待回答', 'a question comes first');
  assert.equal(header({ ...s, nativeActivity: { ...s.nativeActivity, stale: true } }).phase.includes('正在运行命令'), false, 'a stale status is not dressed up as a running command');
});
