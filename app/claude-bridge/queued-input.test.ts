// Actual native mod engine; only its external boundary is mocked. No model turn.
import { test, expect, mock } from 'claude-code/testing';

const session = '11111111-1111-4111-8111-111111111111';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const text = (value: string) => [{ type: 'text' as const, text: value }];
async function fixture($, on, options: { inlineInput?: boolean; promptInput?: boolean } = { inlineInput: true }) {
  const clock = mock.clock(on), stored = mock.session(on), observations = [], calls = [];
  mock.env(on, { NAW_SUBMIT_SOCKET: '/fixture/socket', NAW_HOOK_TOKEN: 'fixture-token' });
  on('session.id', async () => ({ value: session }));
  on('session.version', async () => ({ value: { version: '2.1.312' } }));
  on('session.model', async () => ({ value: 'synthetic-model' }));
  on('session.usage', async () => ({ value: { session: { totalUsd: 0 } } }));
  on('tool.list', async () => ({ value: [] }));
  on('session.start', async ($, e) => e);
  on('turn.start', async ($, e) => e);
  on('turn.complete', async ($, e) => ({ text: e.answer }));
  on('http.fetch', async ($, e) => {
    const route = new URL(e.url).pathname, body = JSON.parse(e.init.body);
    calls.push({ route, body });
    if (route === '/observation') observations.push(body);
    // The real next request long-polls. Keep it beyond this test's clock so
    // an immediate empty reply cannot turn the native zero-delay poll into a loop.
    if (route === '/next') await clock.sleep(1);
    const value = route === '/root-bind' ? { lease: 'synthetic-lease', observationEpoch: 'synthetic-epoch', nativeBlocks: true, nativeInlineInput: options.inlineInput, nativePromptInput: options.promptInput }
      : route === '/next' ? {} : { observed: true };
    return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify(value) } };
  });
  await $.session.start({ cwd: '/fixture' }); await clock.settle();
  expect(calls.find(c => c.route === '/root-bind')?.body.nativeBlocks).toBe(true);
  return { clock, stored, observations, calls, inputs: () => observations.filter(row => row.kind === 'input') };
}
const attachment = (n: number, content = text('ORIGINAL_MIDTURN_TEXT')) => ({
  door: 'attachment' as const, origin: { kind: 'engine' as const }, uuid: id(n),
  message: { type: 'attachment' as const, name: 'queued_command', role: 'user' as const, content },
});

test('qualified ordinary native input uses its accepted original UUID, not a settings-hook surrogate', async ($, on) => {
  const f = await fixture($, on, { inlineInput: true, promptInput: true });
  await $.session.append({ door: 'prompt', origin: { kind: 'composer' }, uuid: id(20),
    message: { type: 'user', role: 'user', content: text('ORDINARY_NATIVE_TEXT') } });
  await f.clock.settle();
  expect(f.inputs().length).toBe(1);
  expect(f.inputs()[0]).toEqual(expect.objectContaining({ id: `prompt:${id(20)}`, kind: 'input',
    inputMode: 'native-prompt', text: 'ORDINARY_NATIVE_TEXT', status: 'complete' }));
  expect(f.inputs()[0].inputTag).toBe(undefined); expect(f.inputs()[0].promptId).toBe(undefined);
});

test('this mod own accepted app prompt keeps its existing app row rather than adding a native duplicate', async ($, on) => {
  const f = await fixture($, on, { inlineInput: true, promptInput: true });
  await $.session.append({ door: 'prompt', origin: { kind: 'plugin', name: 'native-workspace-submit', asUser: true }, uuid: id(21),
    message: { type: 'user', role: 'user', content: text('APP_OWN_INPUT') } });
  await f.clock.settle(); expect(f.inputs()).toEqual([]);
  expect(f.stored.appended().at(-1)?.message.content).toEqual(text('APP_OWN_INPUT'));
});

for (const options of [{}, { inlineInput: false }]) {
  test(`an old backend without confirmed inline-input support receives no unsupported input (${JSON.stringify(options)})`, async ($, on) => {
    const f = await fixture($, on, options);
    await $.session.append(attachment(12)); await f.clock.settle();
    expect(f.inputs()).toEqual([]);
    expect(f.stored.appended().at(-1)?.message.content).toEqual(text('ORIGINAL_MIDTURN_TEXT'));
    expect(f.observations.some(row => row.gap)).toBe(false);
  });
}

test('accepted queued text uses its original UUID/turn; virtual queue records never create a second input', async ($, on) => {
  const f = await fixture($, on);
  await $.turn.start({ turnId: 'native-running-turn' });
  await $.session.append({ door: 'queue', origin: { kind: 'composer' }, uuid: id(1),
    message: { type: 'user', role: 'user', content: text('ORIGINAL_MIDTURN_TEXT') } });
  await $.session.append(attachment(2)); await f.clock.settle();
  expect(f.inputs().length).toBe(1);
  expect(f.inputs()[0]).toEqual(expect.objectContaining({ id: `prompt:${id(2)}`, kind: 'input', turnId: 'native-running-turn',
    text: 'ORIGINAL_MIDTURN_TEXT', title: '工作中插入', inputMode: 'native-inline', status: 'complete', incomplete: false }));
  expect(f.inputs()[0].inputTag).toBe(undefined);
  expect(f.inputs()[0].promptId).toBe(undefined);
  expect(f.calls.some(c => ['/authorize', '/result', '/addressed-message'].includes(c.route))).toBe(false);
  await $.turn.complete({ turnId: 'native-running-turn', reason: 'answer', answer: 'FINAL_NATIVE_ANSWER' }); await f.clock.settle();
});

test('same text under two native IDs remains two inputs; reobserving a UUID retains that row identity', async ($, on) => {
  const f = await fixture($, on);
  for (const n of [3, 4, 3]) await $.session.append(attachment(n));
  await f.clock.settle();
  expect(f.inputs().map(row => row.id)).toEqual([`prompt:${id(3)}`, `prompt:${id(4)}`, `prompt:${id(3)}`]);
  expect(new Set(f.inputs().map(row => row.id)).size).toBe(2);
  expect(f.inputs().every(row => row.text === 'ORIGINAL_MIDTURN_TEXT')).toBe(true);
  expect(f.inputs().every(row => row.turnId === undefined)).toBe(true);
});

test('virtual, meta, subagent, unrelated, ordinary prompt and plugin-authored rows are not guessed into queued input', async ($, on) => {
  const f = await fixture($, on);
  const other = attachment(5);
  for (const row of [
    { ...other, door: 'queue', message: { type: 'user', role: 'user', content: text('VIRTUAL') } },
    { ...attachment(6), message: { ...attachment(6).message, isMeta: true } },
    { ...attachment(7), agentId: 'synthetic-child' },
    { ...attachment(8), message: { ...attachment(8).message, name: 'teammate_mailbox' } },
    { ...attachment(9), door: 'prompt', origin: { kind: 'composer' }, message: { type: 'user', role: 'user', content: text('NORMAL') } },
    { ...attachment(10), origin: { kind: 'plugin', event: 'prompt.submit' } },
  ]) await $.session.append(row);
  await f.clock.settle(); expect(f.inputs()).toEqual([]);
});

test('native projection text stays exact, source content stays unchanged and nontext is honestly incomplete', async ($, on) => {
  const f = await fixture($, on);
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==' } };
  const content = [...text('ORIGINAL_IMAGE_CAPTION\n你好🙂'), image];
  const original = JSON.parse(JSON.stringify(content));
  const result = await $.session.append(attachment(11, content)); await f.clock.settle();
  expect(f.inputs().length).toBe(1);
  expect(f.inputs()[0].text).toBe(result.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n'));
  expect(f.inputs()[0].text).toBe('ORIGINAL_IMAGE_CAPTION\n你好🙂\n');
  expect(f.inputs()[0].incomplete).toBe(true);
  expect(content).toEqual(original);
  // Image display is T78; do not invent an image, path or body here.
  expect(f.inputs()[0].image).toBe(undefined);
});
