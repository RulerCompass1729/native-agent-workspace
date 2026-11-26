// 11-24 加项 1+5: 「用户完全看不出到底在干啥」 — the session header
// name the running command, its start time and (Codex) the last output line.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const board = require('../renderer/task-board.js'), locale = require('../ui-locale.js'), distribution = require('../renderer/agent-distribution.js');
const now = new Date(2026, 10, 23, 20, 16, 2).getTime(), minute = 60000, started = now - 9 * minute - 2000;
const renderer = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
const slice = (from, to, source = renderer) => { const a = source.indexOf(from), b = source.indexOf(to, a); assert.ok(a >= 0 && b > a, from); return source.slice(a, b); };
// The real short form the transcript already uses for a Codex command (reading-list.js).
const preview = slice('function nativeCommandPreview(message) {', '\nfunction updateProcessTail', fs.readFileSync(path.join(__dirname, '../renderer/reading-list.js'), 'utf8'));

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
  const big = board.runningStep({ id: 'c', nativeId: 'n-c', activeTurnId: 't-c', state: 'working', messages: [codexRow({ text: 'old line\n'.repeat(100000) + 'newest line\n' })] });
  assert.equal(big.lastLine, 'newest line', 'only the tail of a long output is read');
  const wrapped = board.runningStep({ id: 'c', nativeId: 'n-c', activeTurnId: 't-c', state: 'working', messages: [codexRow({ title: "/bin/zsh -lc 'npm run package'" })] }, m => m.title.slice(14, -1));
  assert.equal(wrapped.detail, 'npm run package', 'the renderer chooses the short form of a Codex command');
});

test('only a running tool of the current native turn counts, and the newest one wins', () => {
  assert.equal(board.runningStep(claude([claudeRow({ turnId: 'old-turn' })])), null);
  assert.equal(board.runningStep(claude([claudeRow({ nativeId: 'other-native' })])), null);
  assert.equal(board.runningStep(claude([claudeRow({ status: 'completed' })])), null);
  assert.equal(board.runningStep(claude([claudeRow({ time: undefined })])), null);
  assert.equal(board.runningStep(claude([{ ...claudeRow(), role: 'assistant' }])), null);
  for (const extra of [{ state: 'idle' }, { state: 'approval' }, { transportDisconnected: true }, { backendUnavailable: true }, { activeTurnId: '' }])
    assert.equal(board.runningStep(claude([claudeRow()], extra)), null, JSON.stringify(extra));
  // r1 #1: the native interface waits for the person while the session still says working and its tool row still runs.
  for (const extra of [{ nativeInputRequired: true }, { claudeQuestion: { id: 'q' } }, { approval: { id: 'a' } }, { approvals: [{ id: 'a' }] }, { nativeApproval: { requests: [{ id: 'r' }] } }, { approvalOverflow: true }])
    assert.equal(board.runningStep(claude([claudeRow()], extra)), null, 'waiting for the person: ' + JSON.stringify(extra));
  assert.equal(board.runningStep(claude([claudeRow(), ...Array.from({ length: 200 }, () => ({ role: 'assistant', text: 'x' }))])), null, 'the scan stops after the newest 200 rows');
  const newest = board.runningStep(claude([claudeRow(), claudeRow({ time: started + 1000, input: JSON.stringify({ description: 'Second' }) })]));
  assert.equal(newest.detail, 'Second');
  const idle = { id: 'i', nativeId: 'n-i', activeTurnId: 't', state: 'idle' };
  Object.defineProperty(idle, 'messages', { get() { throw Error('Conversation bodies of a session that is not working must not be read'); } });
  assert.equal(board.runningStep(idle), null);
});

// The board's row steps and agent cards left with R250 (11-25); the session header keeps the running tool.
const clock = value => new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(value);
// renders each session in turn into the same header elements
function header(...sessions) {
  const elements = new Map(), $ = id => { if (!elements.has(id)) elements.set(id, { id, hidden: false, textContent: '' }); return elements.get(id); };
  class FixedDate extends Date { static now() { return now; } }
  const context = vm.createContext({ $, uiText: (k, p) => locale.format('zh', k, p), disconnected: false, Date: FixedDate,
    nativeStatusFresh: value => value?.stale !== true, ui: { display: { computed(el, _kind, fn) { el.textContent = fn(); } }, language: { getSnapshot: () => ({ active: 'zh' }) } },
    window: { nativeWorkspaceTaskBoard: board, nativeWorkspaceAgentDistribution: distribution } });
  vm.runInContext(slice('// Only known activity enums', 'const nativeActivityClock =') + slice('// The tool a session is running now', 'const spaceCall'), context);
  for (const s of sessions) vm.runInContext('renderNativeActivity(session)', Object.assign(context, { session: s }));
  return { phase: $('native-phase').textContent, step: $('native-step').textContent, elapsed: $('native-elapsed').textContent, hidden: $('native-activity').hidden };
}

test('the session header names the running command and its start; the detail stays out of the live status', () => {
  const s = claude([claudeRow()], { name: 'B', nativeActivity: { nativeId: 'n-b', turnId: 't-b', label: 'tool', startedAt: now - 30 * minute } });
  // r1 #2: 「已用」 stays the turn's; r1 #4: only the action is in the role=status #native-phase.
  assert.deepEqual(header(s), { phase: 'B · 正在运行命令', step: ' · Wait for memory pressure, then package · ' + clock(started) + ' 起', elapsed: ' · 已用 30 分 00 秒', hidden: false });
  assert.equal(header(claude([claudeRow({ input: '{}' })], { name: 'B', nativeActivity: s.nativeActivity })).step, ' · ' + clock(started) + ' 起');
  const before = header({ ...s, messages: [] });
  assert.deepEqual([before.phase, before.step], ['B · 正在运行工具', ''], 'without a running tool row the header stays as it was');
  assert.deepEqual([header({ ...s, claudeQuestion: { pending: true } }).phase, header({ ...s, claudeQuestion: { pending: true } }).step], ['B · 等待回答', ''], 'a question comes first');
  const input = header({ ...s, nativeInputRequired: true });
  assert.ok(!input.phase.includes('正在运行命令') && input.step === '', 'r1 #1: the native interface waits for input: ' + input.phase);
  const stale = header({ ...s, nativeActivity: { ...s.nativeActivity, stale: true } });
  assert.ok(!stale.phase.includes('正在运行命令') && stale.step === '', 'a stale status is not dressed up as a running command');
  const recovery = header(s, { ...s, capacityRecovery: { status: 'exhausted', reason: 'routing' } });
  assert.equal(recovery.step, '', 'a recovery notice clears the step');
});
