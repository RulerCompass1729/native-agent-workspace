// Runs inside Claude Code's real mod engine, with its external boundary mocked.
// No login, network, or model turn. Keep this separate from the Node unit tests.
import { test, expect, mock } from 'claude-code/testing';
for (const allowed of [false, true]) {
  test(allowed ? 'authorized exact payload enters once' : 'canceled payload never enters', async ($, on) => {
    const clock = mock.clock(on);
    mock.env(on, {NAW_SUBMIT_SOCKET:'/fixture/socket', NAW_HOOK_TOKEN:'fixture-token'});
    on('session.id', async () => ({value:'fixture-session'}));
    on('session.version', async () => ({value:{version:'2.1.302'}}));
    on('prompt.read', async () => ({value:{text:'',cursor:0}}));
    on('session.start', async ($, e) => e);
    let polls = 0; const calls = []; const entered = []; const results = [];
    on('http.fetch', async ($, e) => {
      const route = new URL(e.url).pathname, body = JSON.parse(e.init.body);
      expect(e.init.socketPath).toBe('/fixture/socket');
      calls.push(route);
      if (route === '/result') results.push(body.status);
      const value = route === '/next' ? (++polls === 1 ? {id:'fixture-id',text:'fixture text'} : {closed:true}) : route === '/authorize' ? {allowed} : {received:true};
      return {value:{ok:true,status:200,headers:{},text:JSON.stringify(value)}};
    });
    on('prompt.submit', async ($, e) => {
      expect(calls).toEqual(['/next','/authorize']);
      expect(e.origin).toEqual({kind:'plugin',name:'native-workspace-submit',asUser:true});
      entered.push(e.text); return {text:e.text};
    });
    await $.session.start({cwd:'/fixture'}); await clock.settle();
    expect(entered).toEqual(allowed ? ['fixture text'] : []);
    expect(results).toEqual([allowed ? 'accepted' : 'blocked']);
  });
}

// 2.1.322: a queued app message held for the running root turn's next tool boundary
// (measured on the real CLI: appended there, the same turn's next request reads it).
const midturnSession = '22222222-2222-4222-8222-222222222222';
async function midturn($, on, options: { version?: string; granted?: boolean; hold?: boolean; allowed?: boolean; deny?: boolean; draft?: string; holdGate?: Promise<unknown>; authorizeGate?: Promise<unknown>; endOnAuthorize?: boolean; midturnText?: string } = {}) {
  const raise = $, clock = mock.clock(on), calls = [], submitted = [], rows = [];
  // A refusing bottom stands for a plugin above that refuses the mod's own row.
  const stored = options.deny ? { appended: () => rows } : mock.session(on);
  if (options.deny) on('session.append', async ($, e) => e.door === 'note' ? { deny: 'refused by a plugin above' } : (rows.push(e), { message: e.message, uuid: e.uuid }));
  mock.env(on, { NAW_SUBMIT_SOCKET: '/fixture/socket', NAW_HOOK_TOKEN: 'fixture-token' });
  on('session.id', async () => ({ value: midturnSession }));
  on('session.version', async () => ({ value: { version: options.version || '2.1.322' } }));
  on('session.model', async () => ({ value: 'synthetic-model' }));
  on('session.usage', async () => ({ value: { session: { totalUsd: 0 } } }));
  on('tool.list', async () => ({ value: [] }));
  let draft = options.draft || '';
  on('prompt.read', async () => ({ value: { text: draft, cursor: draft.length } }));
  on('session.start', async ($, e) => e);
  on('session.end', async ($, e) => ({ sessionId: e.sessionId }));
  on('turn.start', async ($, e) => e);
  on('turn.complete', async ($, e) => ({ text: e.answer }));
  on('turn.step', async function* ($, e) { return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }; });
  on('classic.UserPromptSubmit', async () => ({ value: {} }));
  on('classic.MessageDisplay', async () => ({ value: {} }));
  on('tool.call', { tool: 'Bash' }, async () => ({ result: { stdout: 'TOOL_OUTPUT', stderr: '', interrupted: false } }));
  on('prompt.submit', async ($, e) => { submitted.push(e); return { text: e.text }; });
  let release, delivered = false;
  const gate = new Promise(resolve => { release = resolve; });
  on('http.fetch', async ($, e) => {
    const route = new URL(e.url).pathname, body = JSON.parse(e.init.body);
    calls.push({ route, body });
    let value: object = { observed: true };
    if (route === '/next') {
      if (delivered) await clock.sleep(1);
      else { await gate; delivered = true; value = { id: 'app-held', text: 'HELD_TEXT', midturn: true, ...(options.midturnText ? { midturnText: options.midturnText } : {}) }; }
    } else if (route === '/root-bind') value = { lease: 'synthetic-lease', observationEpoch: 'synthetic-epoch', nativeBlocks: true, nativeMidturnAppend: options.granted !== false };
    else if (route === '/hold') { await options.holdGate; value = { held: options.hold !== false }; }
    else if (route === '/authorize') {
      await options.authorizeGate;
      if (options.endOnAuthorize) await raise.session.end({ reason: 'other', sessionId: midturnSession } as any);
      value = { allowed: options.allowed !== false };
    }
    return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify(value) } };
  });
  await $.session.start({ cwd: '/fixture' }); await clock.settle();
  const routes = () => calls.map(c => c.route).filter(r => !['/observation', '/next', '/root-bind', '/addressed-capability', '/operator-capability'].includes(r));
  return { clock, stored, calls, submitted, release, routes, setDraft: value => { draft = value; },
    bind: () => calls.find(c => c.route === '/root-bind')?.body,
    results: () => calls.filter(c => c.route === '/result').map(c => c.body),
    reads: () => calls.filter(c => c.route === '/midturn-read').map(c => ({ id: c.body.id, uuid: c.body.uuid, turnId: c.body.turnId })),
    held: () => stored.appended().filter(row => JSON.stringify(row.message.content).includes('HELD_TEXT')) };
}
async function drain(stream) { for await (const _ of stream) { /* chunks */ } }
const tool = $ => $.tool.call({ tool: 'Bash', command: 'sleep 1', description: 'wait' });
const ended = { answer: 'done', durationMs: 5, isAborted: false, reason: 'answer' as const };

test('2.1.322: a queued app message enters the running root turn at its next tool boundary', async ($, on) => {
  const f = await midturn($, on);
  expect(f.bind().nativeMidturnAppend).toBe(true);
  await $.turn.start({ turnId: 'running-turn' });
  f.release(); await f.clock.settle();
  // Held: nothing authorized or stored while the model may be writing its reply.
  expect(f.routes()).toEqual(['/hold']); expect(f.held()).toEqual([]);
  const result = await tool($); await f.clock.settle();
  expect(JSON.stringify(result)).toContain('TOOL_OUTPUT');
  expect(f.routes()).toEqual(['/hold', '/authorize', '/result']);
  expect(f.held().length).toBe(1);
  const row = f.held()[0];
  expect(row.door).toBe('note'); expect(row.message.isMeta).toBe(true);
  expect(row.message.content).toEqual([{ type: 'text', text: 'HELD_TEXT' }]);
  expect(f.results()).toEqual([expect.objectContaining({ id: 'app-held', status: 'accepted', mode: 'append', uuid: row.uuid, turnId: 'running-turn' })]);
  expect(f.submitted).toEqual([]);
  // Read: the first root request after the append; a subagent's request is not it.
  try { await drain($.turn.step({ turnId: 'running-turn', index: 0, model: 'synthetic-model', messageCount: 4, agentId: 'child-agent' })); } catch { /* an unknown loop may be refused */ }
  await f.clock.settle(); expect(f.reads()).toEqual([]);
  await drain($.turn.step({ turnId: 'running-turn', index: 1, model: 'synthetic-model', messageCount: 6 }));
  await f.clock.settle(); expect(f.reads()).toEqual([{ id: 'app-held', uuid: row.uuid, turnId: 'running-turn' }]);
  // Once only.
  await drain($.turn.step({ turnId: 'running-turn', index: 2, model: 'synthetic-model', messageCount: 8 }));
  await f.clock.settle(); expect(f.reads().length).toBe(1);
});

test('2.1.322: when the root turn ends before a tool boundary, the message runs as its own turn', async ($, on) => {
  const f = await midturn($, on);
  await $.turn.start({ turnId: 'running-turn' });
  f.release(); await f.clock.settle();
  await $.turn.complete({ turnId: 'running-turn', ...ended }); await f.clock.settle();
  expect(f.held()).toEqual([]);
  expect(f.submitted.map(e => [e.text, e.origin])).toEqual([['HELD_TEXT', { kind: 'plugin', name: 'native-workspace-submit', asUser: true }]]);
  expect(f.routes()).toEqual(['/hold', '/authorize', '/result']);
  expect(f.results()[0].mode).toBe(undefined);
});

test('2.1.322: a held message is not taken by a subagent tool call', async ($, on) => {
  const f = await midturn($, on);
  await $.turn.start({ turnId: 'running-turn' });
  f.release(); await f.clock.settle();
  try { await $.tool.call({ tool: 'Bash', command: 'sleep 1', description: 'wait', agentId: 'child-agent' }); } catch { /* an unknown loop may be refused */ }
  await f.clock.settle();
  expect(f.routes()).toEqual(['/hold']); expect(f.held()).toEqual([]);
  await tool($); await f.clock.settle();
  expect(f.held().length).toBe(1);
});

for (const [name, options, result] of [
  ['the app refuses it at the boundary', { allowed: false }, { status: 'blocked' }],
  ['a plugin above refuses the row', { deny: true }, { status: 'blocked', reason: 'native-rejection' }],
] as const) test(`2.1.322: ${name}: nothing enters and the tool result is unchanged`, async ($, on) => {
  const f = await midturn($, on, options);
  await $.turn.start({ turnId: 'running-turn' });
  f.release(); await f.clock.settle();
  const out = await tool($); await f.clock.settle();
  expect(JSON.stringify(out)).toContain('TOOL_OUTPUT');
  expect(f.held()).toEqual([]); expect(f.submitted).toEqual([]);
  expect(f.results()).toEqual([expect.objectContaining({ id: 'app-held', ...result })]);
  // Taken once: a later boundary or the turn's end does not send it again.
  await tool($); await $.turn.complete({ turnId: 'running-turn', ...ended }); await f.clock.settle();
  expect(f.results().length).toBe(1); expect(f.submitted).toEqual([]);
});

test('2.1.322: the person typing in the native terminal during the hold makes it stale', async ($, on) => {
  const f = await midturn($, on);
  await $.turn.start({ turnId: 'running-turn' });
  f.release(); await f.clock.settle();
  await $.prompt.submit({ text: 'typed during the turn', origin: { kind: 'composer' }, wait: false, turnId: 'running-turn' } as any);
  await tool($); await f.clock.settle();
  expect(f.held()).toEqual([]);
  expect(f.routes()).toEqual(['/hold', '/result']);
  expect(f.results()).toEqual([expect.objectContaining({ id: 'app-held', status: 'blocked', reason: 'input-changed' })]);
});

test('2.1.322: the app not keeping it drops it; an idle root takes the ordinary path at once', async ($, on) => {
  const f = await midturn($, on, { hold: false });
  await $.turn.start({ turnId: 'running-turn' });
  f.release(); await f.clock.settle();
  await tool($); await $.turn.complete({ turnId: 'running-turn', ...ended }); await f.clock.settle();
  expect(f.routes()).toEqual(['/hold']); expect(f.held()).toEqual([]); expect(f.submitted).toEqual([]);
});

test('2.1.322 idle root: no hold, the ordinary submission', async ($, on) => {
  const f = await midturn($, on);
  f.release(); await f.clock.settle();
  expect(f.routes()).toEqual(['/authorize', '/result']);
  expect(f.submitted.map(e => e.text)).toEqual(['HELD_TEXT']);
});

for (const [version, granted] of [['2.1.321', true], ['2.1.322', false]] as const) test(`${version}${granted ? '' : ' without the app grant'}: a running turn keeps the ordinary path`, async ($, on) => {
  const f = await midturn($, on, { version, granted });
  if (version !== '2.1.322') expect(f.bind().nativeMidturnAppend).toBe(false);
  await $.turn.start({ turnId: 'running-turn' });
  f.release(); await f.clock.settle();
  expect(f.routes()).toEqual(['/authorize', '/result']); expect(f.held()).toEqual([]);
});

test('2.1.322: a draft in the native prompt refuses it at once, before any hold', async ($, on) => {
  const f = await midturn($, on, { draft: 'x' });
  await $.turn.start({ turnId: 'running-turn' });
  f.release(); await f.clock.settle();
  expect(f.routes()).toEqual(['/result']); expect(f.results()).toEqual([expect.objectContaining({ id: 'app-held', status: 'draft' })]);
  await tool($); await f.clock.settle(); expect(f.held()).toEqual([]);
});
test('2.1.322: a draft typed during the hold refuses it at the boundary; nothing enters', async ($, on) => {
  const f = await midturn($, on);
  await $.turn.start({ turnId: 'running-turn' });
  f.release(); await f.clock.settle();
  f.setDraft('typed later'); await tool($); await f.clock.settle();
  expect(f.routes()).toEqual(['/hold', '/result']); expect(f.results()).toEqual([expect.objectContaining({ id: 'app-held', status: 'draft' })]);
  expect(f.held()).toEqual([]);
});
test('2.1.322: the person typing during the hold also makes it stale when the turn ends first', async ($, on) => {
  const f = await midturn($, on);
  await $.turn.start({ turnId: 'running-turn' });
  f.release(); await f.clock.settle();
  await $.prompt.submit({ text: 'typed during the turn', origin: { kind: 'composer' }, wait: false, turnId: 'running-turn' } as any);
  await $.turn.complete({ turnId: 'running-turn', ...ended }); await f.clock.settle();
  expect(f.held()).toEqual([]);
  expect(f.submitted.map(e => e.text)).toEqual(['typed during the turn']);
  expect(f.routes()).toEqual(['/hold', '/result']);
  expect(f.results()).toEqual([expect.objectContaining({ id: 'app-held', status: 'blocked', reason: 'input-changed' })]);
});

test('2.1.322: a tool boundary during the /hold round trip takes it; the app\'s late "not kept" does not end it early', async ($, on) => {
  let openHold, openAuthorize;
  const holdGate = new Promise(resolve => { openHold = resolve; }), authorizeGate = new Promise(resolve => { openAuthorize = resolve; });
  const f = await midturn($, on, { hold: false, holdGate, authorizeGate });
  await $.turn.start({ turnId: 'running-turn' });
  f.release(); await f.clock.settle();
  // The tool ends while /hold is still in flight; its take waits on /authorize when the late answer arrives.
  const out = tool($); await f.clock.settle();
  openHold(); await f.clock.settle();
  openAuthorize(); await out; await f.clock.settle();
  expect(f.held().length).toBe(1);
  expect(f.results()).toEqual([expect.objectContaining({ id: 'app-held', status: 'accepted', mode: 'append' })]);
  // The listener asks for the next message only after the take reported its result.
  const routes = f.calls.map(c => c.route), polls = routes.map((r, i) => r === '/next' ? i : -1).filter(i => i >= 0);
  expect(polls.length).toBeGreaterThanOrEqual(2);
  expect(polls[1]).toBeGreaterThan(routes.indexOf('/result'));
});
test('2.1.322: a session that ends during the authorization round trip stores nothing and says not sent', async ($, on) => {
  const f = await midturn($, on, { endOnAuthorize: true });
  await $.turn.start({ turnId: 'running-turn' });
  f.release(); await f.clock.settle();
  await tool($); await f.clock.settle();
  expect(f.held()).toEqual([]);
  expect(f.results()).toEqual([expect.objectContaining({ id: 'app-held', status: 'blocked', reason: 'context-changed' })]);
});

for (const during of ['draft', 'input'] as const) test(`2.1.322: ${during === 'draft' ? 'a draft' : 'the person\'s own input'} during the authorization round trip refuses it; nothing enters`, async ($, on) => {
  let openAuthorize; const authorizeGate = new Promise(resolve => { openAuthorize = resolve; });
  const f = await midturn($, on, { authorizeGate });
  await $.turn.start({ turnId: 'running-turn' });
  f.release(); await f.clock.settle();
  const out = tool($); await f.clock.settle();
  expect(f.routes()).toEqual(['/hold', '/authorize']);
  if (during === 'draft') f.setDraft('typed during the round trip');
  else await $.prompt.submit({ text: 'typed during the round trip', origin: { kind: 'composer' }, wait: false, turnId: 'running-turn' } as any);
  openAuthorize(); await out; await f.clock.settle();
  expect(f.held()).toEqual([]);
  expect(f.results()).toEqual([expect.objectContaining({ id: 'app-held', status: during === 'draft' ? 'draft' : 'blocked', ...(during === 'input' ? { reason: 'input-changed' } : {}) })]);
});

test('2.1.322: the running turn reads the app\'s mid-turn text; a turn of its own gets the plain text', async ($, on) => {
  const framed = '[Workspace space message from the person in the space "S", delivered into your running turn.]\nHELD_TEXT';
  const f = await midturn($, on, { midturnText: framed });
  await $.turn.start({ turnId: 'running-turn' });
  f.release(); await f.clock.settle();
  await tool($); await f.clock.settle();
  expect(f.held().map(row => row.message.content)).toEqual([[{ type: 'text', text: framed }]]);
  // Authorized against the plain text the app recorded.
  expect(f.calls.find(c => c.route === '/authorize').body.text).toBe('HELD_TEXT');
});
test('2.1.322: a framed message whose turn ends first is submitted plain', async ($, on) => {
  const f = await midturn($, on, { midturnText: '[frame]\nHELD_TEXT' });
  await $.turn.start({ turnId: 'running-turn' });
  f.release(); await f.clock.settle();
  await $.turn.complete({ turnId: 'running-turn', ...ended }); await f.clock.settle();
  expect(f.submitted.map(e => e.text)).toEqual(['HELD_TEXT']); expect(f.held()).toEqual([]);
});
