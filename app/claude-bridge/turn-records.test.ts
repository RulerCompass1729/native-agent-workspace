// Actual native mod engine; only its external boundary is mocked. No model turn.
// Rows are built as Claude Code 2.1.316 builds them: processBashCommand appends
// `<bash-input>` and then `<bash-stdout>…</bash-stdout><bash-stderr>…</bash-stderr>`
// (or `<bash-stderr>` alone), and its append classifier files both on door `command`.
import { test, expect, mock } from 'claude-code/testing';

const session = '11111111-1111-4111-8111-111111111111';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const text = (value: string) => [{ type: 'text' as const, text: value }];
async function fixture($, on, options: { version?: string; granted?: boolean; submit?: string; gate?: Promise<unknown> } = {}) {
  const clock = mock.clock(on), stored = mock.session(on), observations = [], calls = [];
  mock.env(on, { NAW_SUBMIT_SOCKET: '/fixture/socket', NAW_HOOK_TOKEN: 'fixture-token' });
  on('session.id', async () => ({ value: session }));
  on('session.version', async () => ({ value: { version: options.version || '2.1.316' } }));
  on('session.model', async () => ({ value: 'synthetic-model' }));
  on('session.usage', async () => ({ value: { session: { totalUsd: 0 } } }));
  on('tool.list', async () => ({ value: [] }));
  on('prompt.read', async () => ({ value: { text: '', cursor: 0 } }));
  on('session.start', async ($, e) => e);
  on('turn.start', async ($, e) => e);
  on('turn.complete', async ($, e) => ({ text: e.answer }));
  on('classic.UserPromptSubmit', async () => ({ value: {} }));
  on('classic.MessageDisplay', async () => ({ value: {} }));
  let polls = 0;
  on('http.fetch', async ($, e) => {
    const route = new URL(e.url).pathname, body = JSON.parse(e.init.body);
    calls.push({ route, body });
    if (route === '/observation') observations.push(body);
    if (route === '/next' && !(options.submit && ++polls === 1)) await clock.sleep(1);
    else if (route === '/next') await options.gate;
    const value = route === '/root-bind' ? { lease: 'synthetic-lease', observationEpoch: 'synthetic-epoch', nativeBlocks: true, nativeTurnRecords: options.granted !== false }
      : route === '/next' ? (options.submit && polls === 1 ? { id: 'app-request', text: options.submit } : {})
      : route === '/authorize' ? { allowed: true } : { observed: true };
    return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify(value) } };
  });
  await $.session.start({ cwd: '/fixture' }); await clock.settle();
  return { clock, stored, observations, calls,
    shells: () => observations.filter(row => typeof row.id === 'string' && row.id.startsWith('tool:shell-')),
    starts: () => observations.filter(row => row.id === 'control:turn-start'),
    turns: () => observations.filter(row => row.kind === 'turn') };
}
const command = (n: number, value: string, extra = {}) => ({ door: 'command' as const, origin: { kind: 'composer' as const }, uuid: id(n),
  message: { type: 'user' as const, role: 'user' as const, content: text(value), ...extra } });
const prompt = (n: number) => ({ session_id: session, prompt_id: id(n), prompt: 'typed in the native terminal' });

test('a ! command and its output become one row that heads the turn it starts', async ($, on) => {
  const f = await fixture($, on);
  expect(f.calls.find(c => c.route === '/root-bind')?.body.nativeTurnRecords).toBe(true);
  await $.session.append(command(1, '<bash-input>brew pin peekaboo</bash-input>'));
  await $.session.append(command(2, '<bash-stdout>pinned 4.9.7\n</bash-stdout><bash-stderr>warning: already pinned</bash-stderr>'));
  await $.turn.start({ turnId: 'shell-turn' });
  await f.clock.settle();
  expect(f.shells()).toEqual([expect.objectContaining({ id: `tool:shell-${id(1)}`, kind: 'tool', title: 'Bash', userShell: true,
    input: 'brew pin peekaboo', text: 'pinned 4.9.7\nwarning: already pinned', status: 'complete' })]);
  expect(f.shells()[0].turnId).toBe(undefined); expect(f.shells()[0].incomplete).toBe(undefined);
  expect(f.starts().at(-1)).toEqual(expect.objectContaining({ turnId: 'shell-turn', triggers: { prompts: [], rows: [`tool:shell-${id(1)}`] } }));
  // The order on the wire is the engine's: the row arrives before its turn starts.
  expect(f.observations.findIndex(row => row.id === `tool:shell-${id(1)}`)).toBeLessThan(f.observations.findIndex(row => row.id === 'control:turn-start'));
  // The native rows themselves are stored unchanged.
  expect(f.stored.appended().map(row => row.message.content)).toEqual([text('<bash-input>brew pin peekaboo</bash-input>'),
    text('<bash-stdout>pinned 4.9.7\n</bash-stdout><bash-stderr>warning: already pinned</bash-stderr>')]);
});

test('empty, stderr-only and refused outputs keep their own status; an ambiguous separator is not guessed apart', async ($, on) => {
  const f = await fixture($, on);
  await $.session.append(command(1, '<bash-input>true</bash-input>'));
  await $.session.append(command(2, '<bash-stdout></bash-stdout><bash-stderr></bash-stderr>'));
  await $.session.append(command(3, '<bash-input>nosuch</bash-input>'));
  await $.session.append(command(4, '<bash-stderr>Command failed: spawn nosuch ENOENT</bash-stderr>'));
  await $.session.append(command(5, '<bash-input>printf tricky</bash-input>'));
  await $.session.append(command(6, '<bash-stdout>a</bash-stdout><bash-stderr>b</bash-stdout><bash-stderr>c</bash-stderr>'));
  await f.clock.settle();
  const [empty, failed, ambiguous] = f.shells();
  expect(empty).toEqual(expect.objectContaining({ input: 'true', text: '', status: 'complete' })); expect(empty.incomplete).toBe(undefined);
  expect(failed).toEqual(expect.objectContaining({ input: 'nosuch', text: 'Command failed: spawn nosuch ENOENT', status: 'failed' }));
  expect(ambiguous).toEqual(expect.objectContaining({ input: 'printf tricky', text: '', status: 'complete', incomplete: true }));
});

test('an input without its output is shown as incomplete, and the next row is handled as usual', async ($, on) => {
  const f = await fixture($, on);
  await $.session.append(command(1, '<bash-input>sleep 100</bash-input>'));
  await $.session.append({ door: 'prompt', origin: { kind: 'composer' }, uuid: id(2), message: { type: 'user', role: 'user', content: text('[Request interrupted by user]') } });
  await $.session.append(command(3, '<bash-input>ls</bash-input>'));
  await $.session.append({ door: 'prompt', origin: { kind: 'composer' }, uuid: id(4), message: { type: 'user', role: 'user', content: text('something else') } });
  await $.session.append(command(5, '<bash-stdout>late</bash-stdout><bash-stderr></bash-stderr>'));
  await $.turn.start({ turnId: 'next-turn' });
  await f.clock.settle();
  expect(f.shells().map(row => [row.input, row.text, row.incomplete])).toEqual([['sleep 100', '', true], ['ls', '', true]]);
  // Output that does not directly follow its input is never paired.
  expect(f.starts().at(-1).triggers.rows).toEqual([`tool:shell-${id(1)}`, `tool:shell-${id(3)}`]);
});

test('meta, subagent, model-tool and slash-command rows are not a person\'s ! command', async ($, on) => {
  const f = await fixture($, on);
  await $.session.append(command(1, '<local-command-caveat>Caveat: generated by local commands.</local-command-caveat>', { isMeta: true }));
  await $.session.append({ ...command(2, '<bash-input>child</bash-input>'), agentId: 'a1b2c3' });
  await $.session.append({ ...command(3, '<bash-stdout>child</bash-stdout><bash-stderr></bash-stderr>'), agentId: 'a1b2c3' });
  await $.session.append(command(4, '<command-name>/model</command-name>'));
  await $.session.append(command(5, '<local-command-stdout>Set model</local-command-stdout>'));
  await $.session.append(command(6, '<bash-input>meta</bash-input>', { isMeta: true }));
  await $.session.append({ door: 'tool-result', origin: { kind: 'tool', tool: 'Bash' }, uuid: id(7),
    message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: text('<bash-input>x</bash-input>') }] } });
  await f.clock.settle();
  expect(f.shells()).toEqual([]);
});

test('without a ! reply the command waits for the next turn; a typed prompt joins it; inputs during a turn do not', async ($, on) => {
  const f = await fixture($, on);
  // respondToBashCommands:false: the engine adds a meta caveat and starts no turn.
  await $.session.append(command(1, '<local-command-caveat>Caveat</local-command-caveat>', { isMeta: true }));
  await $.session.append(command(2, '<bash-input>git status</bash-input>'));
  await $.session.append(command(3, '<bash-stdout>clean</bash-stdout><bash-stderr></bash-stderr>'));
  await f.clock.settle();
  expect(f.shells().length).toBe(1); expect(f.starts()).toEqual([]);
  await $.classic.UserPromptSubmit(prompt(4));
  await $.turn.start({ turnId: 'typed-turn' });
  await $.classic.UserPromptSubmit(prompt(5)); // delivered into the running turn
  await $.turn.complete({ turnId: 'typed-turn', answer: 'done', durationMs: 1200, isAborted: false, reason: 'answer' });
  await $.classic.UserPromptSubmit(prompt(6));
  await $.turn.start({ turnId: 'third-turn' });
  await f.clock.settle();
  expect(f.starts().map(row => row.triggers)).toEqual([{ prompts: [id(4)], rows: [`tool:shell-${id(2)}`] }, { prompts: [id(6)], rows: [] }]);
});

test('input taken during a root turn is never claimed, even if that turn\'s end was not heard', async ($, on) => {
  const f = await fixture($, on);
  await $.turn.start({ turnId: 'first' });
  await $.classic.UserPromptSubmit(prompt(1)); // delivered into the running turn
  await $.turn.start({ turnId: 'second' });
  await f.clock.settle();
  expect(f.starts().every(row => row.triggers === undefined)).toBe(true);
});

test('an idle ! command before this mod\'s own send is not claimed by that send\'s turn', async ($, on) => {
  const own = $; let release;
  const gate = new Promise(resolve => { release = resolve; });
  on('prompt.submit', async ($, e) => {
    await own.classic.UserPromptSubmit({ session_id: session, prompt_id: id(9), prompt: e.text });
    await own.turn.start({ turnId: 'app-turn' });
    return { text: e.text };
  });
  const f = await fixture($, on, { submit: 'from the app', gate });
  await $.session.append(command(1, '<bash-input>cat notes.txt</bash-input>'));
  await $.session.append(command(2, '<bash-stdout>private</bash-stdout><bash-stderr></bash-stderr>'));
  release(); await f.clock.settle();
  // The person's own command stays where it is: never part of the app's reply.
  expect(f.shells().length).toBe(1);
  const start = f.starts().find(row => row.turnId === 'app-turn');
  expect(start).toEqual(expect.objectContaining({ turnId: 'app-turn' }));
  expect(start.triggers).toBe(undefined);
  expect(f.calls.find(c => c.route === '/result')?.body.status).toBe('accepted');
});

test('a ! turn\'s reply is read as that turn\'s, but never proves a shareable final reply', async ($, on) => {
  const f = await fixture($, on);
  const display = (turn_id, prompt_id, message_id, delta) => $.classic.MessageDisplay({ session_id: session, turn_id, prompt_id, message_id, index: 0, final: true, delta });
  // A typed turn: its display joins through the prompt id, as before.
  await $.classic.UserPromptSubmit(prompt(1));
  await $.turn.start({ turnId: 'typed-turn' });
  await display('d1', id(1), 'm1', 'typed answer');
  await $.turn.complete({ turnId: 'typed-turn', answer: 'typed answer', durationMs: 10, isAborted: false, reason: 'answer' });
  // A ! turn: no UserPromptSubmit, so the display names a prompt nobody announced.
  await $.session.append(command(2, '<bash-input>git status</bash-input>'));
  await $.session.append(command(3, '<bash-stdout>clean</bash-stdout><bash-stderr></bash-stderr>'));
  await $.turn.start({ turnId: 'shell-turn' });
  await display('d2', id(9), 'm2', 'the tree is clean');
  // A display naming an already known prompt (the earlier typed one) is never re-read as this turn's.
  await display('d4', id(1), 'm4', 'known prompt');
  await $.turn.complete({ turnId: 'shell-turn', answer: 'the tree is clean', durationMs: 10, isAborted: false, reason: 'answer' });
  // After that turn ends, an unknown display is not adopted by anyone.
  await display('d3', id(8), 'm3', 'late');
  await f.clock.settle();
  const rows = f.observations.filter(row => typeof row.id === 'string' && row.id.startsWith('display:'));
  expect(rows.map(row => [row.id, row.turnId])).toEqual([['display:m1', 'typed-turn'], ['display:m2', 'shell-turn'], ['display:m4', 'display:d4'], ['display:m3', 'display:d3']]);
  expect(f.turns().find(row => row.id === 'turn:typed-turn').finalDisplayId).toBe('display:m1');
  expect(f.turns().find(row => row.id === 'turn:shell-turn').finalDisplayId).toBe(undefined);
});

test('a typed turn\'s unknown display is not adopted as a ! turn', async ($, on) => {
  const f = await fixture($, on);
  await $.session.append(command(1, '<bash-input>ls</bash-input>'));
  await $.session.append(command(2, '<bash-stdout>a</bash-stdout><bash-stderr></bash-stderr>'));
  await $.classic.UserPromptSubmit(prompt(3));
  await $.turn.start({ turnId: 'mixed-turn' });
  await $.classic.MessageDisplay({ session_id: session, turn_id: 'd1', prompt_id: id(7), message_id: 'm1', index: 0, final: true, delta: 'x' });
  await f.clock.settle();
  expect(f.observations.find(row => row.id === 'display:m1')?.turnId).toBe('display:d1');
});

test('a ! input left unpaired inside a turn is shown, and never heads the next turn', async ($, on) => {
  const f = await fixture($, on);
  await $.turn.start({ turnId: 'running' });
  await $.session.append(command(1, '<bash-input>queued</bash-input>'));
  await $.turn.complete({ turnId: 'running', answer: '', durationMs: 5, isAborted: false, reason: 'answer' });
  await $.turn.start({ turnId: 'next' });
  await f.clock.settle();
  expect(f.shells().map(row => [row.input, row.incomplete])).toEqual([['queued', true]]);
  expect(f.starts().every(row => row.triggers === undefined)).toBe(true);
});

for (const [order, other] of [['hook-first', false], ['hook-first', true], ['row-first', true]] as const) test(`a typed prompt that only looks like <bash-input> is not a ! command (${order}${other ? ', another row next' : ''})`, async ($, on) => {
  const f = await fixture($, on);
  const lookalike = command(2, '<bash-input>not really</bash-input>');
  if (order === 'hook-first') { await $.classic.UserPromptSubmit(prompt(1)); await $.session.append(lookalike); }
  else { await $.session.append(lookalike); await $.classic.UserPromptSubmit(prompt(1)); }
  // The engine can append other rows (e.g. a memory attachment) before the turn starts.
  if (other) await $.session.append({ door: 'attachment', origin: { kind: 'engine' }, uuid: id(5), message: { type: 'attachment', name: 'nested_memory', role: 'user', content: text('memory') } });
  await $.turn.start({ turnId: 'typed-turn' });
  await f.clock.settle();
  expect(f.shells()).toEqual([]);
  expect(f.starts().at(-1).triggers).toEqual({ prompts: [id(1)], rows: [] });
  // A real ! command afterwards is still recognised.
  await $.turn.complete({ turnId: 'typed-turn', answer: '', durationMs: 5, isAborted: false, reason: 'answer' });
  await $.session.append(command(3, '<bash-input>pwd</bash-input>'));
  await $.session.append(command(4, '<bash-stdout>/fixture</bash-stdout><bash-stderr></bash-stderr>'));
  await f.clock.settle();
  expect(f.shells().map(row => row.input)).toEqual(['pwd']);
});

test('a prompt that went on but left no row of its own does not hide the person\'s next ! command', async ($, on) => {
  const f = await fixture($, on);
  await $.classic.UserPromptSubmit(prompt(1)); // e.g. a hook suppressed its row; no turn starts
  await $.session.append(command(2, '<bash-input>git log -1</bash-input>'));
  await $.session.append(command(3, '<bash-stdout>abc123</bash-stdout><bash-stderr></bash-stderr>'));
  await $.turn.start({ turnId: 'shell-turn' });
  await f.clock.settle();
  expect(f.shells().map(row => [row.input, row.text, row.incomplete])).toEqual([['git log -1', 'abc123', undefined]]);
  expect(f.starts().at(-1).triggers.rows).toEqual([`tool:shell-${id(2)}`]);
});

test('after a ! turn ends, its reply adoption ends too, even when older display entries are evicted', async ($, on) => {
  const f = await fixture($, on);
  const display = (turn_id, prompt_id, message_id) => $.classic.MessageDisplay({ session_id: session, turn_id, prompt_id, message_id, index: 0, final: true, delta: 'x' });
  await $.session.append(command(1, '<bash-input>ls</bash-input>'));
  await $.session.append(command(2, '<bash-stdout>a</bash-stdout><bash-stderr></bash-stderr>'));
  await $.turn.start({ turnId: 'shell-turn' });
  await $.turn.complete({ turnId: 'shell-turn', answer: '', durationMs: 5, isAborted: false, reason: 'answer' });
  for (let n = 10; n < 20; n++) await display(`idle-${n}`, id(n), `idle-m${n}`);
  await f.clock.settle();
  const adopted = f.observations.filter(row => typeof row.id === 'string' && row.id.startsWith('display:') && row.turnId === 'shell-turn');
  expect(adopted).toEqual([]);
});

test('a root turn ends with the engine\'s own duration and end time', async ($, on) => {
  const f = await fixture($, on);
  await $.turn.start({ turnId: 'timed-turn' });
  const before = f.clock.now();
  await $.turn.complete({ turnId: 'timed-turn', answer: '', durationMs: 32400, isAborted: false, reason: 'answer' });
  await f.clock.settle();
  const turn = f.turns().find(row => row.id === 'turn:timed-turn');
  expect(turn).toEqual(expect.objectContaining({ nativeDurationMs: 32400, status: 'complete' }));
  expect(turn.nativeCompletedAt).toBe(before);
  // A subagent's turn is not the root's and gets no clock row.
  await $.turn.complete({ turnId: 'child-turn', agentId: 'a1b2c3', answer: '', durationMs: 5, isAborted: false, reason: 'answer' });
  await f.clock.settle();
  expect(f.turns().some(row => row.id === 'turn:child-turn')).toBe(false);
  // Nor does a subagent finishing while the root is idle drop the root's waiting inputs.
  await $.session.append(command(1, '<bash-input>make</bash-input>'));
  await $.session.append(command(2, '<bash-stdout>ok</bash-stdout><bash-stderr></bash-stderr>'));
  await $.turn.complete({ turnId: 'late-child', agentId: 'a1b2c3', answer: '', durationMs: 5, isAborted: false, reason: 'answer' });
  await $.turn.start({ turnId: 'after-child' });
  await f.clock.settle();
  expect(f.starts().find(row => row.turnId === 'after-child')?.triggers).toEqual({ prompts: [], rows: [`tool:shell-${id(1)}`] });
});

for (const options of [{ version: '2.1.312' }, { granted: false }]) {
  test(`an unqualified engine or an older backend gets none of this (${JSON.stringify(options)})`, async ($, on) => {
    const f = await fixture($, on, options);
    expect(f.calls.find(c => c.route === '/root-bind')?.body.nativeTurnRecords).toBe(options.version ? false : true);
    await $.session.append(command(1, '<bash-input>ls</bash-input>'));
    await $.session.append(command(2, '<bash-stdout>a</bash-stdout><bash-stderr></bash-stderr>'));
    await $.classic.UserPromptSubmit(prompt(3));
    await $.turn.start({ turnId: 'plain-turn' });
    await $.turn.complete({ turnId: 'plain-turn', answer: '', durationMs: 10, isAborted: false, reason: 'answer' });
    await f.clock.settle();
    expect(f.shells()).toEqual([]);
    expect(f.starts().every(row => row.triggers === undefined)).toBe(true);
    expect(f.turns().every(row => row.nativeDurationMs === undefined && row.nativeCompletedAt === undefined)).toBe(true);
  });
}
