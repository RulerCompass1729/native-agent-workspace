// Real mod engine, mocked external boundary. No provider conversation/model.
import { test, expect, mock } from 'claude-code/testing';
const session = '11111111-1111-4111-8111-111111111111';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=';
const image = (data = png) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } });
async function fixture($, on, options: { media?: boolean; version?: string } = { media: true }) {
  const clock = mock.clock(on), stored = mock.session(on), observations = [], calls = [];
  mock.env(on, { NAW_SUBMIT_SOCKET: '/fixture/socket', NAW_HOOK_TOKEN: 'fixture-token' });
  on('session.id', async () => ({ value: session }));
  on('session.version', async () => ({ value: { version: options.version || '2.1.312' } }));
  on('session.model', async () => ({ value: 'synthetic-model' }));
  on('session.usage', async () => ({ value: { session: { totalUsd: 0 } } }));
  on('tool.list', async () => ({ value: [] }));
  on('session.start', async ($, e) => e); on('turn.start', async ($, e) => e);
  on('turn.complete', async ($, e) => ({ text: e.answer }));
  on('http.fetch', async ($, e) => {
    expect(e.init.socketPath).toBe('/fixture/socket');
    const route = new URL(e.url).pathname, body = JSON.parse(e.init.body); calls.push({ route, body });
    if (route === '/observation') observations.push(body);
    if (route === '/next') await clock.sleep(1);
    const value = route === '/root-bind' ? { lease: 'fixture-lease', observationEpoch: 'fixture-epoch', nativeBlocks: true,
      nativeInlineInput: true, nativePromptInput: true, nativeMedia: options.media } : route === '/next' ? {} : { observed: true };
    return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify(value) } };
  });
  await $.session.start({ cwd: '/fixture' }); await clock.settle();
  return { clock, stored, observations, calls, media: () => observations.filter(row => row.mediaOnly) };
}
test('312 requests the explicit media capability and keeps original accepted input identity/text', async ($, on) => {
  const f = await fixture($, on);
  expect(f.calls.find(c => c.route === '/root-bind')?.body.nativeMedia).toBe(true);
  const result = await $.session.append({ door: 'prompt', origin: { kind: 'composer' }, uuid: uuid(1),
    message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'ORIGINAL_CAPTION' }, image()] } });
  await f.clock.settle(); const original = f.observations.filter(row => row.id === `prompt:${uuid(1)}` && !row.mediaOnly);
  expect(original.length).toBe(1); expect(original[0].text).toBe(result.message.content.filter(b => b.type === 'text').map(b => b.text).join('\n'));
  expect(original[0].imageCount).toBe(1);
  expect(f.media().length).toBe(1); expect(f.media()[0]).toEqual(expect.objectContaining({ id: `prompt:${uuid(1)}`, kind: 'input', status: 'complete', imagePayload: { index: 0, mime: 'image/png', data: png } }));
  expect(f.media()[0].text).toBe(undefined); expect(f.media()[0].inputTag).toBe(undefined); expect(f.media()[0].turnId).toBe(undefined);
  expect(f.stored.appended().at(-1)?.message.content).toEqual(result.message.content);
});
for (const media of [undefined, false]) test(`an old receiver never receives image bytes when media ACK is ${media}`, async ($, on) => {
  const f = await fixture($, on, { media });
  await $.session.append({ door: 'prompt', origin: { kind: 'composer' }, uuid: uuid(2), message: { type: 'user', role: 'user', content: [image()] } });
  await f.clock.settle(); expect(f.media()).toEqual([]); expect(f.observations.find(row => row.id === `prompt:${uuid(2)}`)?.incomplete).toBe(true);
});
test('unqualified runtime version stays inert even if a receiver replies media=true', async ($, on) => {
  const f = await fixture($, on, { version: '2.1.311', media: true });
  await $.session.append({ door: 'prompt', origin: { kind: 'composer' }, uuid: uuid(3), message: { type: 'user', role: 'user', content: [image()] } });
  await f.clock.settle(); expect(f.calls.find(c => c.route === '/root-bind')?.body.nativeMedia).toBe(false); expect(f.media()).toEqual([]);
});
test('a successful native tool image keeps its original tool ID and never invents a source path', async ($, on) => {
  const f = await fixture($, on); await $.turn.start({ turnId: 'original-turn' });
  await $.session.append({ door: 'response', origin: { kind: 'model', model: 'synthetic-model' }, uuid: uuid(4),
    message: { type: 'assistant', role: 'assistant', content: [{ type: 'tool_use', id: 'read-original', name: 'Read', input: { file_path: '/requested-not-verified.png' } }] } });
  await $.session.append({ door: 'tool-result', origin: { kind: 'tool', tool: 'Read' }, uuid: uuid(5),
    message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-original', content: [{ type: 'text', text: 'ORIGINAL_TOOL_TEXT' }, image()] }] } });
  await f.clock.settle(); expect(f.media().length).toBe(1); expect(f.media()[0].id).toBe('tool:read-original');
  expect(f.media()[0].imagePayload.sourcePath).toBe(undefined);
  expect(f.observations.find(row => row.id === 'tool:read-original' && row.status === 'complete' && !row.mediaOnly)?.text).toBe('ORIGINAL_TOOL_TEXT');
});
test('failed, meta and subagent image results do not become successful root previews', async ($, on) => {
  const f = await fixture($, on);
  for (const [n, extra, error] of [[6, {}, true], [7, { agentId: 'child' }, false], [8, { isMeta: true }, false]] as const) {
    await $.session.append({ door: 'tool-result', origin: { kind: 'tool', tool: 'Read' }, uuid: uuid(n), ...('agentId' in extra ? { agentId: extra.agentId } : {}),
      message: { type: 'user', role: 'user', ...('isMeta' in extra ? { isMeta: true } : {}), content: [{ type: 'tool_result', tool_use_id: 'read-' + n, is_error: error, content: [image()] }] } });
  }
  await f.clock.settle(); expect(f.media()).toEqual([]);
  expect(f.observations.find(row => row.id === 'tool:read-6')?.incomplete).toBe(true);
});
test('oversized and remote native images produce bounded unavailable markers and preserve text', async ($, on) => {
  const f = await fixture($, on);
  await $.session.append({ door: 'prompt', origin: { kind: 'composer' }, uuid: uuid(9), message: { type: 'user', role: 'user', content: [
    { type: 'text', text: 'ORIGINAL_MEDIA_TEXT' }, image('A'.repeat(1500000)), { type: 'image', source: { type: 'url', url: 'https://example.invalid/never-fetch' } }] } });
  await f.clock.settle(); expect(f.media().length).toBe(2); expect(f.media().every(row => row.imagePayload.unavailable && row.imagePayload.data === undefined)).toBe(true);
  expect(JSON.stringify(f.calls).includes('example.invalid')).toBe(false);
  expect(f.observations.find(row => row.id === `prompt:${uuid(9)}` && !row.mediaOnly)?.text).toContain('ORIGINAL_MEDIA_TEXT');
});
for (const replacement of [false, true]) test(`effective native Read path is only an exact post-execution pixel label (replacement=${replacement})`, async ($, on) => {
  let callId = '', postCalls = 0;
  const changed = png.slice(0, -4) + 'AAAA';
  on('classic.PostToolUse', async () => { postCalls++; return replacement ? { updatedToolOutput: { type: 'image', file: { base64: changed, type: 'image/png', originalSize: 68 } } } : {}; });
  on('tool.call', { tool: 'Read' }, async (_context, e) => {
    callId = e.tool_use_id;
    await $.classic.PostToolUse({ session_id: session, tool_name: 'Read', tool_use_id: callId,
      tool_input: { file_path: '/effective-after-permission.png' }, tool_response: { type: 'image', file: { base64: png, type: 'image/png', originalSize: 68 } } });
    return { result: { type: 'image', file: { base64: png, type: 'image/png', originalSize: 68 } } };
  });
  const f = await fixture($, on);
  await $.turn.start({ turnId: 'original-read-turn' });
  await $.tool.call({ tool: 'Read', file_path: '/requested-before-permission.png' });
  await $.session.append({ door: 'tool-result', origin: { kind: 'tool', tool: 'Read' }, uuid: uuid(20),
    message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, content: [image(replacement ? changed : png)] }] } });
  await f.clock.settle(); expect(postCalls).toBe(1); expect(f.media().length).toBe(1);
  expect(f.media()[0].imagePayload.sourcePath).toBe(replacement ? undefined : '/effective-after-permission.png');
  expect(f.media()[0].imagePayload.data).toBe(replacement ? changed : png);
});
