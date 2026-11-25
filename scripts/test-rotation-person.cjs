// Session rotation with a simulated person (R206, R211, R221): the real hidden desktop app, the real daemon and the real
// Claude CLI against fixed local replies (every start of it, --version included, sandboxed to loopback with no key;
// Codex and any other provider's CLI are stubs that must never be called). The person's keys and clicks go
// through the hidden window's own input path (fixtures/simulated-person.cjs). Quiet times are shortened with the
// dispatcher's own constructor options (fixtures/rotation-clock.cjs); no gate is removed.
// Usage: node scripts/test-rotation-person.cjs <scenario> [--code <other checkout>] [--no-window]
// --no-window (d, f and f2 only): the same daemon, CLI and dispatcher without Electron. Nobody acts in those, so nothing
// of the person's path is stood in for; the set-up goes through the service.
// --dry-run (any scenario): everything up to the window: the loopback, the daemon, a real CLI's first turn and its tools.
// Prints the raw rotation log rows and PASS or FAIL; exits non-zero on failure. Takes the GUI test slot itself (75: taken).
const scratch = require('./fixtures/test-scratch.cjs');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto'), { execFileSync, spawnSync } = require('node:child_process');
const { simulatedPerson, assertIsolated, assertHidden } = require('./fixtures/simulated-person.cjs');
const { joinSpace } = require('./fixtures/space-membership.cjs');
const { createIn } = require('./fixtures/create-view.cjs');
const { revealDefaultSpace } = require('./fixtures/default-space.cjs');

const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2), flag = name => { const at = args.indexOf(name); if (at >= 0) args.splice(at, 1); return at >= 0; };
const dry = flag('--dry-run'), windowless = flag('--no-window') || dry;
const at = args.indexOf('--code');
const code = at >= 0 ? path.resolve(args.splice(at, 2)[1]) : root, scenario = args[0];
const QUIET_MS = 20000, HUMAN_QUIET_MS = 3000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), started = Date.now();
const say = (...parts) => console.log(((Date.now() - started) / 1000).toFixed(1).padStart(6), ...parts);

assertIsolated({});
// Nothing of a running NAW is inherited, here or by what starts here: its outbox descriptor names the daily app. Kept:
// where test-scratch.cjs leaves the evidence. Its receipts go to a registry of this test's own, not the daily folder's.
const evidence = process.env.NAW_EVIDENCE_DIR;
for (const key of Object.keys(process.env)) if (key.startsWith('NAW_')) delete process.env[key];
if (evidence) process.env.NAW_EVIDENCE_DIR = evidence;
const electron = require(path.join(code, 'node_modules', 'electron'));
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID();
process.env.NAW_TEMP_REGISTRY_DIR = path.join(path.dirname(common), '.local/person-sim-temp-registry');
function takeSlot() {
  const busy = execFileSync('/bin/ps', ['-axo', 'command='], { encoding: 'utf8' }).split('\n').filter(line => /scripts\/(package-mac|package-dmg|install-daily)\.cjs|\.local\/evidence\/release-[\w-]+\/(scratch\.noindex|pkg|preflight\.noindex)\//.test(line));
  if (busy.length) { console.error('A package or install is running; nothing started.'); process.exit(75); }
  if (fs.existsSync(path.join(path.dirname(slot), 'fullsuite.lock'))) { console.error('The full suite is running; nothing started.'); process.exit(75); }
  try { fs.mkdirSync(slot); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    console.error('GUI slot occupied; nothing started.'); process.exit(75);
  }
  fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'ext-person-sim', task: 'rotation with a simulated person: ' + scenario, token, pid: process.pid, at: new Date().toISOString() }));
  process.once('exit', releaseSlot);
}
function releaseSlot() {
  try { if (JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'), 'utf8')).token === token) fs.rmSync(slot, { recursive: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

// The loopback stand-in for Claude: fixed replies by what the turn was asked, held back while a scenario asks for it.
const CONTROL = 'mcp__native_workspace__workspace_control';
class Model {
  constructor() { this.turns = []; this.holds = []; this.rules = []; this.number = 0; }
  // The next turn that matches waits until release(); arrived(): it has reached the model.
  hold(pattern) {
    const held = { pattern, arrived: false, done: null };
    held.released = new Promise(resolve => { held.release = resolve; });
    this.holds.push(held);
    return held;
  }
  rule(pattern, reply) { this.rules.unshift({ pattern, reply }); }
  reply(text, history) {
    const rule = this.rules.find(r => r.pattern.test(text));
    if (rule) return typeof rule.reply === 'function' ? rule.reply(text, history) : rule.reply;
    if (text.includes('请现在只写交接')) return { text: 'HANDOFF_WRITTEN 在 feature-x 分支，提交 abc1234，下一步跑全量测试。' };
    if (text.includes('请现在只补一段')) return { text: 'SUPPLEMENT_WRITTEN 交接之后人说了一句，没有别的变化。' };
    if (text.includes('交接之后又有新内容，它补的一段如下')) return { text: 'SUPPLEMENT_TAKEN 已并进交接。' };
    if (text.includes('】你接手「')) return { text: 'HANDOFF_TAKEN 已核对交接。' };
    return { text: 'FIXED_REPLY' };
  }
  async respond(req, res, body) {
    if (!req.url.startsWith('/v1/messages') || req.url.includes('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ input_tokens: 100, data: [] })); return; }
    const request = JSON.parse(body), last = request.messages.findLast(m => m.role === 'user');
    const blocks = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content;
    const result = blocks.find(b => b.type === 'tool_result'), history = JSON.stringify(request.messages);
    const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n');
    // Only the root's turns have tools; the CLI's own side requests (a title) get a word.
    const main = Boolean(request.tools?.length), number = ++this.number;
    const answer = result ? { text: 'TOOL_RESULT_READ ' + JSON.stringify(result.content).slice(0, 60) } : main ? this.reply(text, history) : { text: 'ok' };
    const row = { number, main, history, text: text.slice(-400), tools: request.tools?.length || 0, control: request.tools?.some(t => t.name === CONTROL) || false, search: request.tools?.some(t => t.name === 'ToolSearch') || false, ...(result ? { result: typeof result.content === 'string' ? result.content : (result.content || []).map(c => c.text || '').join('') } : {}) };
    this.turns.push(row);
    const held = main && !result ? this.holds.find(h => !h.arrived && h.pattern.test(text)) : null;
    if (held) { held.arrived = true; await held.released; }
    const usage = { input_tokens: 10, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, ...(answer.usage || {}) };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const event = (type, fields) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
    event('message_start', { message: { id: `msg_local_${number}`, type: 'message', role: 'assistant', model: request.model, content: [], stop_reason: null, stop_sequence: null, usage } });
    if (answer.tool) {
      event('content_block_start', { index: 0, content_block: { type: 'tool_use', id: `toolu_local_${number}`, name: answer.tool.name, input: {} } });
      event('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(answer.tool.input) } });
    } else {
      event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: answer.text } });
    }
    event('content_block_stop', { index: 0 });
    event('message_delta', { delta: { stop_reason: answer.tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } });
    event('message_stop', {}); res.end();
  }
}

const base = fs.realpathSync(scratch.directory(path.join(os.tmpdir(), 'naw-person-')));
const profile = path.join(base, 'profile'), cwd = path.join(base, 'work'), config = path.join(base, 'claude'), home = path.join(base, 'home');
const stubs = path.join(base, 'stubs'), stubCalls = path.join(base, 'stub-calls.log');
for (const dir of [profile, cwd, config, home, stubs]) fs.mkdirSync(dir, { mode: 0o700 });
const errors = [], model = new Model();
let fixture, child, client, app, page, person, dispatcher, own;

async function until(check, label, limit = 90000) {
  const from = Date.now();
  while (Date.now() - from < limit) { const value = await check(); if (value) return value; await sleep(200); }
  throw Error('Not reached: ' + label);
}
const snapshot = () => client.call('initial');
const session = async id => (await snapshot()).sessions.find(s => s.id === id);
const windowState = async () => windowless ? own.roomState.apply(await snapshot()) : page.evaluate(() => workspace.initial());
const rotationRows = () => { try { return fs.readFileSync(path.join(profile, 'rotation-log.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };
const rowsOf = id => rotationRows().filter(row => row.old?.id === id);
const dispatchRecord = id => { try { return JSON.parse(fs.readFileSync(path.join(profile, 'queue-dispatch.json'), 'utf8')).rotations?.[id] ?? null; } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };

async function start({ options = {}, env = {}, permissions = {} } = {}) {
  const modules = path.join(code, 'app', 'claude-loopback.cjs'), loopback = require(modules);
  const binary = fs.realpathSync(path.join(os.userInfo().homedir, '.local/bin/claude'));
  fixture = loopback.create({ directory: base, provider: 'claude', respond: (req, res, body) => model.respond(req, res, body) });
  await fixture.start(); await fixture.preflight();
  const shim = path.join(base, 'claude-local');
  fixture.wrapper(binary, { file: shim, env: { CLAUDE_CONFIG_DIR: config, DISABLE_AUTO_COMPACT: '1' } });
  const version = execFileSync(shim, ['--version'], { encoding: 'utf8', timeout: 30000, env: { PATH: '/usr/bin:/bin', HOME: home } }).trim().split(' ')[0];
  assert.match(version, /^\d+\.\d+\.\d+$/, 'The Claude CLI');
  for (const name of ['claude', 'codex', 'dsh', 'opencode', 'gemini', 'kimi'])
    fs.writeFileSync(path.join(stubs, name), `#!/bin/sh\necho "${name} $*" >> '${stubCalls}'\nexit 97\n`, { mode: 0o700 });
  assert.equal(spawnSync(path.join(stubs, 'codex'), ['--version']).status, 97);
  assert.equal(fs.readFileSync(stubCalls, 'utf8'), 'codex --version\n', 'A stub that is started says so'); fs.rmSync(stubCalls);
  const trusted = {}; for (const dir of [cwd, fs.realpathSync(cwd)]) for (const name of [dir, dir + '-sessions']) trusted[name] = { hasTrustDialogAccepted: true };
  fs.writeFileSync(path.join(config, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, autoCompactEnabled: false, customApiKeyResponses: { approved: [loopback.FIXTURE_KEY], rejected: [] }, theme: 'dark', projects: trusted }), { mode: 0o600 });
  fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify({ model: 'claude-opus-5-5', effortLevel: 'high', permissions: { allow: ['mcp__native_workspace__workspace_control'], ...permissions } }), { mode: 0o600 });
  fs.writeFileSync(path.join(profile, 'runtime-locations.json'), JSON.stringify({ claude: shim, codex: path.join(stubs, 'codex') }), { mode: 0o600 });
  assertIsolated({ profile, executable: electron, code });
  const outer = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NAW_')));
  const shared = { ...outer, PATH: stubs + path.delimiter + process.env.PATH, CLAUDE_CONFIG_DIR: config, CODEX_HOME: path.join(base, 'codex'), NAW_WORKSPACE: cwd, NAW_TEST_APP_ROOT: code, NAW_TEST_CLAUDE_VERSION: version, NAW_RUNTIME_CONFIG: path.join(profile, 'runtime-locations.json') };
  for (const key of ['CLAUDE_CODE_CHILD_SESSION', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'DEEPSEEK_API_KEY', 'GIT_ASKPASS']) delete shared[key];
  child = scratch.childProcess.fork(path.join(code, 'app/daemon.cjs'), [profile], { cwd, execArgv: ['--require', path.join(__dirname, 'fixtures/rotation-daemon.cjs')],
    env: { ...shared, HOME: home, NAW_OUTBOX_DESCRIPTOR: path.join(profile, 'outbox-owner.json'), NAW_APP_VERSION: require(path.join(code, 'package.json')).version }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'the test service');
  const { connectService } = require(path.join(code, 'app/service-connection.cjs'));
  client = await connectService(profile, 'person-sim-observer');
  const given = { quietMs: QUIET_MS, quietCompactMs: QUIET_MS, ...options };
  for (const key of Object.keys(given)) if (given[key] === null) delete given[key];
  const limit = Number(env.NAW_TEST_QUEUE_CONTENT_LIMIT);
  if (windowless) {
    const { connect } = require(path.join(code, 'app/service-client.cjs')), { RoomState } = require(path.join(code, 'app/room-state.cjs'));
    const { QueueDispatcher } = require(path.join(code, 'app/queue-dispatch.cjs')), { CompactionCounter } = require(path.join(code, 'app/compaction-count.cjs'));
    const roomState = new RoomState(profile);
    own = { roomState, client: await connect(profile, 'person-sim-setup', { page: false }) };
    // Quiet members are looked at through a window's client only (QueueDispatcher.tick); this connection stands for it.
    dispatcher = new QueueDispatcher({ roomState, dataDir: profile, clients: () => own.client, connect: owner => connect(profile, owner, { page: false }), transcriptRoot: path.join(config, 'projects'),
      compactions: new CompactionCounter({ claudeRoot: path.join(config, 'projects'), codexRoot: path.join(base, 'codex', 'sessions') }), humanQuietMs: HUMAN_QUIET_MS,
      ...(limit ? { contentLimits: { claude: limit, codex: limit } } : {}), ...given });
    const tick = dispatcher.tick.bind(dispatcher);
    dispatcher.tick = () => tick().catch(error => { say('pass failed:', error.stack); throw error; });
    await dispatcher.start();
    say(`Claude ${version} on loopback; code ${code}; no window; options ${JSON.stringify({ ...given, humanQuietMs: HUMAN_QUIET_MS, ...env })}`);
    return;
  }
  const { _electron } = scratch.playwright(require(path.join(code, 'node_modules', 'playwright')));
  app = await _electron.launch({ executablePath: electron, args: ['-r', path.join(__dirname, 'fixtures/rotation-clock.cjs'), code], timeout: 70000,
    env: { ...shared, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid), NAW_TEST_QUEUE_HUMAN_QUIET_MS: String(HUMAN_QUIET_MS), NAW_TEST_ROTATION_OPTIONS: JSON.stringify(given), ...env } });
  page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  await page.locator('#new-session').waitFor({ timeout: 60000 });
  const seen = await assertHidden(app, profile);
  person = await simulatedPerson(app, profile, { snapshot, log: row => say('person', JSON.stringify(row)) });
  say(`Claude ${version} on loopback; code ${code}; hidden Electron ${seen.windows.length} window(s); options ${JSON.stringify({ ...given, humanQuietMs: HUMAN_QUIET_MS, ...env })}`);
}
const ready = async id => { const s = await session(id); return s?.chatAvailable && s.state === 'idle' && !s.pendingTag; };
async function create(name, { join = true } = {}) {
  if (windowless) {
    const id = await client.call('create', { provider: 'claude', cwd, name, view: 'chat' });
    await until(() => ready(id), 'ready ' + name, 120000);
    if (join) { await own.client.refresh(); await own.roomState.membership(own.client, id, true, name, 'shared'); }
    return id;
  }
  await page.locator('#new-session').click();
  await page.locator('input[name="provider"][value="claude"]').check();
  await page.locator('#session-name').fill(name);
  await createIn(page, 'chat');
  const id = await until(async () => (await snapshot()).sessions.find(s => s.name === name)?.id, 'created ' + name);
  await until(() => ready(id), 'ready ' + name, 120000);
  if (join) await joinSpace(page);
  return id;
}
// The set-up's message: the person's own in the window; the service's without one.
async function tell(id, text) {
  if (!windowless) return person.sendMessage(id, text);
  const s = await session(id);
  await client.call('claim', id, 'chat');
  await client.call('send', id, text, s.nativeId);
  return s;
}
async function finished(id, limit = 300000) {
  await until(() => rowsOf(id).some(row => ['done', 'kept', 'failed'].includes(row.event)), 'an end of the rotation', limit);
  if (rowsOf(id).some(row => row.event === 'done')) await until(() => rowsOf(id).some(row => row.event === 'archived'), 'the archive', 60000);
}
// What every finished rotation shows, whatever interrupted it.
async function assertFinished(id, { waited } = {}) {
  const rows = rowsOf(id), events = rows.map(row => row.event), shown = await windowState(), state = await snapshot();
  assert.ok(!events.includes('kept'), 'Nothing was kept: ' + events);
  assert.ok(!events.includes('failed'), 'Nothing failed: ' + JSON.stringify(rows.filter(row => row.event === 'failed')));
  assert.equal(events.filter(event => event === 'done').length, 1, 'Done once: ' + events);
  assert.ok(events.indexOf('archived') > events.indexOf('done'), 'Archived after done: ' + events);
  if (waited === true) assert.ok(events.includes('waiting') && events.indexOf('waiting') < events.indexOf('done'), 'It waited first: ' + events);
  if (waited === false) assert.ok(!events.includes('waiting'), 'It did not wait: ' + events);
  const done = rows.find(row => row.event === 'done'), old = state.sessions.find(s => s.id === id), next = state.sessions.find(s => s.id === done.new.id);
  const archived = of => shown.sessions.find(s => s.id === of).archived;
  assert.equal(old.state, 'ended', 'The old session is ended'); assert.equal(archived(id), true, 'and archived');
  assert.ok(next && next.state === 'idle' && !archived(next.id), 'The successor is there');
  assert.equal(done.new.nativeId, next.nativeId, 'and is the native session the log names');
  assert.ok(next.messages.some(m => m.role === 'user' && m.text?.includes('HANDOFF_WRITTEN')), 'It has the handoff');
  const ids = [...new Set(rows.map(row => row.new?.id).filter(Boolean))];
  assert.deepEqual(ids, [done.new.id], 'One successor in the whole log');
  const record = dispatchRecord(id);
  assert.ok(!record || record.phase !== 'kept', 'The dispatcher keeps no kept record of the old session');
  return { old, next, done, rows };
}
const supplementsTo = next => next.messages.filter(m => m.role === 'user' && m.text?.includes('交接之后又有新内容，它补的一段如下'));
// What the product itself recorded of the person on a session: control changes, the human input revision, the
// dispatcher's own time of their last act, and the messages that are not NAW's.
const typedBy = s => s.messages.filter(m => m.role === 'user' && !m.dispatchPurpose && !m.text?.startsWith('【NAW ')).map(m => m.text);
const humanAt = id => windowless ? dispatcher.humanAt.get(id) ?? null : app.evaluate((_, id) => globalThis.nawRotationHumanAt(id), id);
async function personMarks(id) {
  const s = await session(id);
  return { control: s.controlRevision, human: s.wakeHumanRevision ?? 0, at: await humanAt(id), typed: typedBy(s).length };
}
// The rotation ends with the person doing nothing from `marks` on, by the product's own values: at every look until NAW
// itself stops the old session (which counts as a control change of its own), and at the end.
async function finishedAlone(id, marks, limit = 300000) {
  say('the person\'s marks', JSON.stringify(marks));
  let looks = 0;
  await until(async () => {
    const s = await session(id);
    if (!['stopping', 'ended'].includes(s.state)) { looks++; assert.equal(s.controlRevision, marks.control, 'No control change by anyone'); }
    return rowsOf(id).some(row => ['done', 'kept', 'failed'].includes(row.event));
  }, 'an end of the rotation', limit);
  await finished(id);
  const { control: _, ...end } = await personMarks(id), { control: __, ...before } = marks;
  assert.ok(looks > 3, 'It was looked at meanwhile');
  assert.deepEqual(end, before, 'The product recorded no act of the person on the old session since');
  const next = rowsOf(id).find(row => row.event === 'done')?.new.id;
  if (!next) return;
  const after = await personMarks(next);
  assert.deepEqual([after.human, after.typed, after.at], [0, 0, null], 'nor on the successor');
}
// The successor is asked for work, as the person would: it answers from the conversation that was handed over.
async function assertWorks(id, next) {
  const ask = '接着做并回一句 ' + randomUUID().slice(0, 8), answer = 'SUCCESSOR_ANSWER ' + ask.slice(-8);
  model.rule(new RegExp(ask), { text: answer });
  if (!windowless) await person.open(next, 'chat');
  await tell(next, ask);
  await until(async () => (await ready(next)) && (await session(next)).messages.some(m => m.role === 'assistant' && m.text === answer), 'the successor does what it is asked');
  const turn = model.turns.find(t => t.main && t.text.includes(ask));
  assert.ok(turn.history.includes('HANDOFF_WRITTEN'), 'from the conversation with the handoff');
  assert.equal((await session(id)).state, 'ended', 'The old session stays ended');
  say('the successor was asked for work and answered:', answer);
}
// A member whose conversation is past the record limit, left alone: due by its quiet alone.
async function dueMember() {
  if (!windowless) await revealDefaultSpace(page);
  const id = await create('合成成员');
  await tell(id, '合成任务：回复即可');
  await until(async () => (await ready(id)) && (await session(id)).messages.some(m => m.role === 'assistant'), 'its first turn');
  return id;
}
// The successor's first turn is held at the model, so the rotation stays between handed and confirmed until released.
async function heldAtSuccessor(id, held) {
  await until(() => held.arrived, 'the successor\'s handoff turn at the model', 180000);
  await until(() => dispatchRecord(id)?.phase === 'handed', 'phase handed');
  say('the successor has the handoff turn, held; rows', rowsOf(id).map(row => row.event).join(','));
}
const CONTENT = { NAW_TEST_QUEUE_CONTENT_LIMIT: '2' };

const scenarios = {
  // (a) The person types in the old session's native terminal while the handoff waits, deletes it and goes quiet.
  async a() {
    await start({ env: CONTENT });
    const held = model.hold(/】你接手「/), id = await dueMember();
    await heldAtSuccessor(id, held);
    await person.open(id, 'terminal');
    const before = (await session(id)).controlRevision;
    await person.type(id, 'wait', 'terminal');
    await until(async () => /wait/.test(await person.screen(id)), 'the keys on the native screen');
    await person.erase(id, 4, 'terminal');
    await until(async () => (await session(id)).controlRevision > before, 'the keys reached the native session');
    held.release();
    await until(() => rowsOf(id).some(row => ['waiting', 'kept', 'done'].includes(row.event)), 'the rotation says what it does');
    say('after the interruption', rowsOf(id).map(row => `${row.event}:${row.reason}`).join(','));
    await finishedAlone(id, await personMarks(id));
    const r = await assertFinished(id, { waited: true });
    assert.equal(supplementsTo(r.next).length, 1, 'The successor was told once');
    await assertWorks(id, r.next.id);
  },
  // (a2) The person types in the old session's composer while it writes its handoff, and clears it.
  async a2() {
    await start({ env: CONTENT });
    const held = model.hold(/请现在只写交接/), id = await dueMember();
    await until(() => held.arrived, 'the handoff request at the model', 180000);
    await person.open(id, 'chat');
    await person.keepDraft(id, '等一下'); await person.erase(id, 3, 'chat');
    await until(async () => !(await session(id)).liveDraft, 'the draft is cleared');
    held.release();
    await until(() => rowsOf(id).some(row => ['waiting', 'kept', 'failed', 'done'].includes(row.event)), 'the rotation says what it does');
    say('after the interruption', rowsOf(id).map(row => `${row.event}:${row.reason}`).join(','));
    await finishedAlone(id, await personMarks(id));
    const r = await assertFinished(id, { waited: true });
    await assertWorks(id, r.next.id);
  },
  // (b) A draft left in the old session's composer: it waits as long as the draft is there, and finishes once cleared.
  async b() {
    await start({ env: CONTENT });
    const held = model.hold(/】你接手「/), id = await dueMember();
    await heldAtSuccessor(id, held);
    await person.open(id, 'chat');
    await person.keepDraft(id, '还没发的草稿');
    held.release();
    await until(() => rowsOf(id).some(row => ['waiting', 'kept', 'done'].includes(row.event)), 'the rotation says what it does');
    await person.idle(QUIET_MS * 3);
    assert.ok(!rowsOf(id).some(row => ['kept', 'done', 'failed'].includes(row.event)), 'Still waiting three quiet times later: ' + rowsOf(id).map(row => row.event));
    assert.equal((await session(id)).liveDraft, '还没发的草稿', 'The draft is untouched');
    assert.equal(await page.locator('#message-input').inputValue(), '还没发的草稿', 'in the window too');
    await person.erase(id, 6, 'chat');
    await until(async () => !(await session(id)).liveDraft, 'the draft is cleared');
    await finishedAlone(id, await personMarks(id));
    const r = await assertFinished(id, { waited: true });
    await assertWorks(id, r.next.id);
  },
  // (b2) The same with text left in the native terminal's prompt, then sent.
  async b2() {
    await start({ env: CONTENT });
    const held = model.hold(/】你接手「/), id = await dueMember();
    await heldAtSuccessor(id, held);
    await person.open(id, 'terminal');
    await person.type(id, 'draftleft', 'terminal');
    await until(async () => /draftleft/.test(await person.screen(id)), 'the prompt holds it');
    held.release();
    await until(() => rowsOf(id).some(row => ['waiting', 'kept', 'done'].includes(row.event)), 'the rotation says what it does');
    await person.idle(QUIET_MS * 3);
    assert.ok(!rowsOf(id).some(row => ['kept', 'done', 'failed'].includes(row.event)), 'Still waiting three quiet times later: ' + rowsOf(id).map(row => row.event));
    assert.ok(/draftleft/.test(await person.screen(id)), 'The prompt is untouched');
    await person.focus(id, 'terminal'); await person.pressEnter();
    await until(async () => (await session(id)).messages.some(m => m.role === 'user' && m.text === 'draftleft'), 'it was sent');
    await finishedAlone(id, await personMarks(id));
    const r = await assertFinished(id, { waited: true });
    assert.equal(supplementsTo(r.next).length, 1, 'The successor was told once');
    await assertWorks(id, r.next.id);
  },
  // (c) The person sends the old session a message after its handoff: a supplement goes to the same successor, then it ends.
  async c() {
    await start({ env: CONTENT });
    const held = model.hold(/】你接手「/), id = await dueMember();
    await heldAtSuccessor(id, held);
    const before = dispatchRecord(id).newId;
    await person.open(id, 'chat');
    const said = '交接之后人说的一句 ' + randomUUID().slice(0, 8);
    await person.sendMessage(id, said);
    // The old session's addition says the person's sentence only if its own request to the model carried it.
    model.rule(/请现在只补一段/, (text, history) => ({ text: 'SUPPLEMENT_WRITTEN ' + (history.includes(said) ? said : 'NOT_SEEN') }));
    const told1 = model.hold(/交接之后又有新内容，它补的一段如下/);
    held.release();
    await until(() => rowsOf(id).some(row => ['waiting', 'kept', 'done'].includes(row.event)), 'the rotation says what it does');
    const marks = await personMarks(id);
    await until(() => told1.arrived, 'the addition at the successor\'s model', 180000);
    const still = await session(id);
    assert.ok(still && still.state !== 'ended' && !rowsOf(id).some(row => ['done', 'archived'].includes(row.event)), 'The old session still runs while its successor is told: ' + still?.state);
    told1.release();
    await finishedAlone(id, marks);
    const r = await assertFinished(id, { waited: true });
    assert.equal(r.done.new.id, before, 'The same successor');
    const told = supplementsTo(r.next);
    assert.equal(told.length, 1, 'The successor was told once');
    assert.ok(told[0].text.includes('SUPPLEMENT_WRITTEN ' + said), 'The person\'s own sentence, in what the old session added');
    assert.ok(model.turns.find(t => t.main && t.text.includes('交接之后又有新内容，它补的一段如下')).history.includes(said), 'It reached the successor\'s model');
    assert.ok(r.old.messages.some(m => m.role === 'user' && m.text === said), 'The message stays in the old record');
    await assertWorks(id, r.next.id);
  },
  // (d) Nobody interrupts.
  async d() {
    await start({ env: CONTENT });
    const id = await dueMember();
    await finishedAlone(id, await personMarks(id));
    const r = await assertFinished(id, { waited: false });
    assert.equal(supplementsTo(r.next).length, 0, 'Nothing was added');
    await assertWorks(id, r.next.id);
  },
  // (f) A member left alone, its conversation large and its cache warm: changed for its size, nobody acting.
  async f() {
    await start({ options: CONTEXT });
    if (!windowless) await revealDefaultSpace(page);
    const id = await create('合成成员');
    const at = await fill(id);
    await finishedAlone(id, await personMarks(id), 240000);
    const r = await assertFinished(id, { waited: false });
    const asked = r.rows.find(row => row.event === 'requested');
    assert.equal(asked.reason, 'context', 'for its size');
    assert.ok(asked.time - at >= CONTEXT.quietContextMs, `not before the quiet time: ${asked.time - at} ms after its last request`);
    await assertWorks(id, r.next.id);
  },
  // (f2) The same, 990 tokens below the production limit: left as it is through twice the quiet time.
  async f2() {
    await start({ options: CONTEXT });
    if (!windowless) await revealDefaultSpace(page);
    const id = await create('合成成员');
    await fill(id, 174000);
    await sleep(CONTEXT.quietContextMs * 2 + 65000);
    assert.deepEqual(rowsOf(id), [], 'Not changed for its size');
    assert.equal(dispatchRecord(id), null);
    assert.equal((await session(id)).state, 'idle');
  },
  // (e) The butler, left alone: changed the same way; its successor has the role, is woken and reads stewardEvents.
  async e() {
    await start({ options: CONTEXT });
    const id = await create('合成大管家', { join: false });
    // Set-up: the person's designation and the wake switch, as the window's own calls (not under test here).
    await page.evaluate(id => workspace.steward(id), id);
    await until(async () => (await ready(id)) && (await session(id)).messages.some(m => m.role === 'assistant'), 'the duty statement\'s turn');
    await page.evaluate(() => workspace.stewardWake(true));
    assert.deepEqual(await stewardSlot(), [id], 'The butler sits at the top');
    model.rule(/【NAW 事件】/, text => ({ tool: { name: CONTROL, input: { action: 'invoke', method: 'stewardEvents', arguments: positionIn(text), operation_id: randomUUID() } } }));
    await fill(id);
    await finishedAlone(id, await personMarks(id), 240000);
    const r = await assertFinished(id, { waited: false });
    assert.equal(r.rows.find(row => row.event === 'requested').reason, 'context', 'for its size');
    await until(async () => (await stewardSlot()).join() === r.next.id, 'the successor sits at the top, alone');
    assert.ok(r.next.messages.some(m => m.role === 'user' && m.text?.includes('大管家由你接着当')), 'Its handoff says it goes on as the butler');
    assert.equal((await page.evaluate(() => workspace.stewardWake())).on, true, 'Waking on events is still on');
    say('role: the successor', r.next.id, 'holds the seat; old', id);
    // Whatever was recorded before (a fresh profile's own start) is read first; the wake asked for is another one.
    const events = () => fs.readFileSync(path.join(profile, 'butler-ledger.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(row => row.type === 'event');
    const woken = () => Number((JSON.parse(fs.readFileSync(path.join(profile, 'steward-wake.json'), 'utf8')).woken || ':0').split(':')[1]);
    const wakes = async () => (await session(r.next.id)).messages.filter(m => m.role === 'user' && m.text?.startsWith('【NAW 事件】'));
    const reads = from => model.turns.slice(from).filter(t => t.result).map(t => { try { return JSON.parse(t.result); } catch { return null; } }).filter(Boolean);
    await until(async () => woken() === events().length && reads(0).length >= (await wakes()).length && await ready(r.next.id), 'earlier events are read', 240000);
    say('drained:', events().map(row => row.data.kind + ':' + row.data.payload?.reason).join(','), 'wakes', (await wakes()).length, 'reads', JSON.stringify(reads(0)).slice(0, 600));
    for (const read of reads(0)) assert.equal(read.state, 'complete', 'An earlier read went through');
    const drained = events().length, turnsBefore = model.turns.length;
    // Something NAW records as an event: a member's item ends in a question for the person.
    model.rule(/合成任务甲/, { text: '需要你决定：合成问题要不要做？' });
    await revealDefaultSpace(page);
    const member = await create('合成成员');
    await page.evaluate(([id, text]) => workspace.spaceAction('shared', 'queueAdd', [text, id]), [member, '合成任务甲']);
    const decision = await until(() => events().slice(drained).find(row => row.data.kind === 'decision'), 'NAW records the decision', 120000);
    const wake = await until(async () => (await wakes()).find(m => m.time >= decision.time), 'NAW wakes the successor for it', 240000);
    say('decision recorded', decision.time, 'woken', wake.time, wake.text.slice(0, 160).replaceAll('\n', ' '));
    const answer = await until(() => reads(turnsBefore).find(read => read.value?.events?.some(event => event.kind === 'decision')), 'the successor reads the decision', 120000);
    say('stewardEvents answered the successor:', JSON.stringify(answer).slice(0, 900));
    assert.equal(answer.state, 'complete', 'The call went through');
    assert.equal(answer.value.events.find(event => event.kind === 'decision').payload.spaceId, 'shared');
    assert.equal((await session(id)).messages.filter(m => m.text?.startsWith('【NAW 事件】') && m.time >= r.done.time).length, 0, 'The old session was not woken');
    await assertWorks(id, r.next.id);
  },
  // (g) Each named action once, on one session: what the harness does reaches NAW as the person's.
  async g() {
    await start({ options: { quietMs: null }, permissions: { defaultMode: 'default' } });
    const id = await create('合成成员', { join: false });
    await person.open(id, 'chat');
    await person.keepDraft(id, 'draft kept');
    const kept = await personMarks(id);
    assert.ok(kept.at, 'A kept draft is the person at the session');
    await person.idle(1500);
    assert.deepEqual(await personMarks(id), kept, 'Idle is nothing to the product');
    assert.equal((await session(id)).liveDraft, 'draft kept', 'A kept draft stays');
    await person.pressEnter();
    await until(async () => (await session(id)).messages.some(m => m.role === 'user' && m.text === 'draft kept'), 'Enter sends it');
    await until(() => ready(id), 'its turn ended');
    const held = model.hold(/stop me/);
    await person.sendMessage(id, 'stop me');
    await until(() => held.arrived, 'a running turn');
    await person.open(id, 'terminal');
    await person.focus(id, 'terminal'); await person.pressEsc();
    await until(async () => ['idle'].includes((await session(id)).state), 'Esc in the terminal stops the turn');
    held.release();
    const control = (await session(id)).controlRevision;
    await person.type(id, 'typed', 'terminal');
    await until(async () => /typed/.test(await person.screen(id)), 'typed text is on the native screen');
    assert.ok((await session(id)).controlRevision > control, 'and counts as the person\'s control');
    assert.equal((await session(id)).terminalInputPending, true);
    await person.erase(id, 5, 'terminal');
    await until(async () => !/typed/.test(await person.screen(id)), 'erase takes it off the native screen');
    model.rule(/ask first/, { tool: { name: 'Bash', input: { command: 'touch synthetic-card-check', description: 'Synthetic check' } } });
    await person.open(id, 'chat');
    await person.sendMessage(id, 'ask first');
    await until(async () => (await session(id)).state === 'approval', 'a card asks');
    await person.clickCard(require(path.join(code, 'app/ui-messages.js')).zh['approval.inTerminal'].replace('{name}', '合成成员'));
    await until(async () => await page.locator('#terminal-area .xterm-screen').first().isVisible(), 'the card\'s button opens the terminal');
    await person.pressEsc();
    await until(async () => (await session(id)).state === 'idle', 'the request is refused');
    const s = await session(id), end = await personMarks(id);
    assert.deepEqual(typedBy(s), ['draft kept', 'stop me', 'ask first'], 'The product has exactly what the person sent');
    assert.equal(fs.existsSync(path.join(s.cwd, 'synthetic-card-check')), false, 'The refused command did not run');
    assert.ok(end.at > kept.at && end.control > kept.control && end.human > 0, 'The product counted the acts as the person\'s: ' + JSON.stringify(end));
  },
};
// The production numbers stay: 180,000 tokens, a one hour cache, nine tenths of it. Shortened: the quiet time before a
// change for size (45 minutes) and the age a session needs (60 minutes). quietMs keeps its 30 minutes.
const CONTEXT = { quietMs: null, quietCompactMs: null, quietContextMs: 45000, memoryMinAgeMs: 20000 };
const FILL = { input_tokens: 10, cache_creation_input_tokens: 5000, cache_read_input_tokens: 180000, cache_creation: { ephemeral_1h_input_tokens: 5000, ephemeral_5m_input_tokens: 0 } };
const positionIn = text => JSON.parse(/参数 (\[[^\]]*\])/.exec(text)[1]);
async function dryRun() {
  await start({ options: ['e', 'f', 'f2'].includes(scenario) ? CONTEXT : {}, env: ['a', 'a2', 'b', 'b2', 'c', 'd'].includes(scenario) ? CONTENT : {} });
  const id = await create('合成成员', { join: false });
  await tell(id, '合成任务：回复即可');
  await until(async () => (await ready(id)) && (await session(id)).messages.some(m => m.role === 'assistant'), 'its first turn');
  const { wakeText } = require(path.join(code, 'app/steward-wake.cjs'));
  assert.deepEqual(positionIn(wakeText('0123456789abcdef:1')), ['0123456789abcdef:1']);
  const turn = model.turns.findLast(t => t.main);
  say('first turn:', JSON.stringify({ tools: turn.tools, workspace_control: turn.control, ToolSearch: turn.search }));
  for (const name of ['package-mac.cjs', 'install-daily.cjs']) assert.ok(fs.existsSync(path.join(root, 'scripts', name)), name);
  assert.ok(fs.existsSync(electron), 'the repository\'s Electron'); assertIsolated({ profile, executable: electron, code, env: {} });
  say('dry run: everything but the window');
}
async function fill(id, read = 180000) {
  model.rule(/CONTEXT_FILL/, { text: 'FILLED', usage: { ...FILL, cache_read_input_tokens: read } });
  await tell(id, 'CONTEXT_FILL');
  await until(async () => (await ready(id)) && (await session(id)).messages.some(m => m.role === 'assistant' && m.text === 'FILLED'), `a request of ${read + 5010} tokens`);
  return (await session(id)).messages.findLast(m => m.role === 'assistant').time;
}
const stewardSlot = () => page.locator('#steward-slot .session-row').evaluateAll(rows => rows.map(row => row.dataset.sessionRow));

async function teardown() {
  try { await stopAll(); } finally { releaseSlot(); } // A signal ends the process without 'exit'.
}
async function stopAll() {
  if (dispatcher) { dispatcher.close(); await dispatcher.pending?.catch(() => {}); }
  own?.client.close();
  if (app) await app.close().catch(() => {});
  if (client) {
    try {
      for (const s of (await snapshot()).sessions) if (!['ended', 'background'].includes(s.state)) await client.call('stop', s.id).catch(() => {});
      await client.call('shutdown').catch(() => {});
    } finally { client.close(); }
  }
  if (fixture) { for (const held of model.holds) held.release(); await fixture.stop().catch(() => {}); }
}
const cleanup = scratch.cleanup(teardown);
(async () => {
  if (windowless && !dry && !['d', 'f', 'f2'].includes(scenario)) { console.error('--no-window: d, f and f2 only'); process.exitCode = 2; return; }
  if (!scenarios[scenario]) { console.error('Scenarios: ' + Object.keys(scenarios).join(' ')); process.exitCode = 2; return; }
  if (!windowless) takeSlot();
  if (!windowless) execFileSync(process.execPath, [path.join(code, 'scripts/build-ui.cjs')], { cwd: code });
  let failure = null;
  let timer; const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Over the time limit')), 540000); });
  try { await Promise.race([(dry ? dryRun : scenarios[scenario])(), limit]); } catch (error) { failure = error; } finally { clearTimeout(timer); }
  let raw = []; try { raw = rotationRows(); } catch (error) { failure ||= error; }
  console.log('--- rotation-log.jsonl (raw)'); for (const row of raw) console.log(JSON.stringify(row)); console.log('---');
  if (!failure) try { assert.deepEqual(errors, [], 'No page errors'); fixture.assertClean(); assert.equal(fs.existsSync(stubCalls) ? fs.readFileSync(stubCalls, 'utf8') : '', '', 'No other provider was started'); if (!windowless) await assertHidden(app, profile); } catch (error) { failure = error; }
  if (failure) {
    try {
      const state = await snapshot();
      for (const s of state.sessions) console.log('session', JSON.stringify({ id: s.id, name: s.name, state: s.state, cwd: path.relative(base, s.cwd), prompt: s.nativeStartupPrompt, version: s.nativeVersion, control: s.controlRevision, draft: Boolean(s.liveDraft), pending: s.terminalInputPending, messages: s.messages.map(m => [m.role, String(m.text).slice(0, 80)]) }));
      console.log('terminal', await page?.locator('#terminal-area').innerText().catch(() => ''));
      console.log('dispatch', fs.readFileSync(path.join(profile, 'queue-dispatch.json'), 'utf8').slice(0, 4000));
      console.log('model', JSON.stringify(model.turns.map(t => [t.number, t.main, t.text.slice(-120)])));
      if (evidence && page) await page.screenshot({ path: path.join(evidence, `failure-${scenario}.png`) }).catch(() => {});
    } catch (error) { console.log('state after the failure unavailable:', error.message); }
  }
  console.log(`${failure ? 'FAIL' : 'PASS'} ${dry ? 'dry run of ' : ''}${scenario} ${code === root ? '' : 'code ' + code + ' '}(${((Date.now() - started) / 1000).toFixed(0)}s)${failure ? ': ' + failure.message : ''}`);
  if (failure) { console.error(failure.stack); process.exitCode = 1; }
})().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(cleanup);
