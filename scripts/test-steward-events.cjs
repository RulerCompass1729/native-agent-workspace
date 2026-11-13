// What the butler reads to report only what is new (stewardEvents; the person, 2026-11-09: 「我希望 NAW 自己可以监控自己的
// agent，并通过自带的 agent（aka 大管家）来进行汇报」): the session the person made the butler calls workspace_control through
// the actual stdio tool and NAW's own service and reads the events NAW recorded, after the position its last read gave.
// A session that is not the butler is refused. After NAW restarts, the old position reads on with nothing lost or
// repeated. Each read is a step in 「大管家的记录」.
// Real hidden Electron UI and service; the native producer is synthetic (the background-control fixture), and the events
// are written into the profile's event record by the record's own code while the app is closed, as NAW writes them.
// No native program is started and no model is called. Takes the GUI test slot itself.
const scratch = require('./fixtures/test-scratch.cjs');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto'), { execFileSync } = require('node:child_process');
const { _electron } = scratch.playwright(require('playwright'));
const { connectService } = require('../app/service-connection.cjs');
const { ButlerLedger } = require('../app/butler-ledger.cjs');
const locale = require('../app/ui-locale.js');
const root = path.resolve(__dirname, '..'), evidence = process.env.NAW_EVIDENCE_DIR;
if (!evidence || !path.isAbsolute(evidence) || path.resolve(evidence).startsWith(root + path.sep)) throw Error('External private evidence directory required');
fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID();
try { fs.mkdirSync(slot); } catch (e) { if (e.code !== 'EEXIST') throw e; console.error('GUI slot occupied; no launch.'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ token, owner: 'claude310', task: 'steward events window check', pid: process.pid, at: new Date().toISOString() }));
execFileSync(process.execPath, [path.join(root, 'scripts/build-ui.cjs')]);
const checks = [], errors = [];
let profile, child, client, app, page, helper, rpc, sequence = 0, butler, worker;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { for (let n = 0; n < 200; n++) { if (await fn()) return; await wait(40); } throw Error(label); }
const save = (name, value) => fs.writeFileSync(path.join(evidence, name + '.json'), JSON.stringify(value, null, 2), { mode: 0o600 });
function fixture(method, target, value) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.off('message', receive); reject(Error('Fixture response timeout')); }, 8000);
    const receive = r => { if ((method === 'backgroundProof' ? r.proofRequestId : r.requestId) !== id) return; clearTimeout(timer); child.off('message', receive); r.error ? reject(Error(r.error)) : resolve(r); };
    child.on('message', receive); child.send({ id, method, target, value });
  });
}
// The stdio tool a native session runs, bound to the app that is running now (its descriptor changes with each start).
function mcp() {
  helper = scratch.childProcess.spawn(process.execPath, [path.join(root, 'app/claude-message-tool.cjs'), '--codex'], {
    env: { ...process.env, NAW_CONTROL_DESCRIPTOR: path.join(profile, 'outbox-owner.json') }, stdio: ['pipe', 'pipe', 'pipe'] });
  let text = ''; const pending = new Map();
  helper.stdout.setEncoding('utf8'); helper.stdout.on('data', part => { text += part; let end; while ((end = text.indexOf('\n')) >= 0) { const r = JSON.parse(text.slice(0, end)); text = text.slice(end + 1); pending.get(r.id)?.(r); pending.delete(r.id); } });
  helper.stderr.on('data', part => errors.push(String(part)));
  return (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => reject(Error('MCP response timeout')), 15000);
    pending.set(id, r => { clearTimeout(timer); r.error ? reject(Error(JSON.stringify(r.error))) : resolve(r.result); });
    helper.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
const invoke = (method, args, id = randomUUID()) => ({ action: 'invoke', method, arguments: args, operation_id: id });
async function control(session, args) {
  const proof = await fixture('backgroundProof', session, { callId: randomUUID(), arguments: args });
  const result = await rpc('tools/call', { name: 'workspace_control', arguments: args,
    _meta: { threadId: proof.nativeId, sessionId: proof.sessionId, callId: proof.callId, 'x-codex-turn-metadata': { thread_id: proof.nativeId, turn_id: proof.turnId } } });
  await fixture('backgroundComplete', session, { callId: proof.callId, arguments: args });
  return JSON.parse(result.content[0].text);
}
const read = (session, position) => control(session, invoke('stewardEvents', [position]));
async function launch() {
  app = await _electron.launch({ args: [root], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 30000 });
  page = await app.firstWindow(); page.setDefaultTimeout(8000); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#message-input').waitFor();
  rpc = mcp(); await rpc('initialize');
}
async function quit() { helper.stdin.end(); helper = null; await app.close(); app = null; }
// Events as NAW records them (butler-ingress.cjs): a failed queue item, a decision asked, a space whose queue ran empty.
function record(write) { const ledger = new ButlerLedger(profile); write(ledger); }
const failure = n => ({ eventId: `butler-source:window-${n}`, sourceRef: `queue-outcome:shared:window-${n}`, kind: 'failure',
  payload: { spaceId: 'shared', itemId: `item-${n}`, memberName: 'Codex 前端', text: `合成任务 ${n}`, reason: `合成失败原因 ${n}` } });
const refused = (value, key) => value.state === 'unconfirmed' && ['zh', 'en'].some(language => value.error === locale.format(language, key));

async function run() {
  profile = fs.realpathSync(scratch.directory(path.join(os.tmpdir(), 'naw-steward-events-'))); const cwd = path.join(profile, 'workspace'); fs.mkdirSync(cwd, { mode: 0o700 });
  child = scratch.childProcess.fork(path.join(root, 'app/daemon.cjs'), [profile], { cwd, execArgv: ['--require', path.join(__dirname, 'fixtures/background-control.cjs')],
    env: { ...process.env, NAW_TEST_APP_ROOT: root, NAW_WORKSPACE: cwd, NAW_APP_VERSION: require('../package.json').version }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Fixture service starts'); client = await connectService(profile, 'human-view');
  butler = await client.call('create', { provider: 'codex', cwd, name: 'Codex 管家', view: 'chat' });
  worker = await client.call('create', { provider: 'codex', cwd, name: 'Codex 前端', view: 'chat' });
  await client.call('join', worker, true);
  fs.writeFileSync(path.join(profile, 'views.json'), JSON.stringify([{ owner: 'human-view', active: true, selected: butler, mode: 'chat' }]), { mode: 0o600 });
  record(ledger => { ledger.ingest(failure(1)); ledger.observeSource('queue-vacancy:shared', true, { spaceId: 'shared', spaceName: '共同工作' }); });
  await launch();
  await page.evaluate(id => workspace.steward(id), butler);
  await until(async () => await page.locator('#steward-slot .session-row').count() === 1, 'The butler sits at the top');

  // 1. The butler reads from the start: both events, oldest first, and a position to read on from.
  const first = await read(butler, null);
  assert.equal(first.state, 'complete', JSON.stringify(first));
  assert.deepEqual(first.value.events.map(e => [e.sequence, e.kind, e.payload.spaceId]), [[1, 'failure', 'shared'], [2, 'queue-empty', 'shared']], JSON.stringify(first.value));
  assert.equal(first.value.events[0].payload.reason, '合成失败原因 1');
  assert.match(first.value.through, /^[0-9a-f]{16}:2$/u); assert.equal(first.value.more, false);
  checks.push('The butler reads the failed item and the empty queue, oldest first, with a position to read on from');
  // 2. At the newest event: nothing, and the position stays.
  const none = await read(butler, first.value.through);
  assert.deepEqual([none.state, none.value], ['complete', { events: [], through: first.value.through, more: false }], JSON.stringify(none));
  checks.push('From the newest position it gets nothing and the same position back');
  // 3. A session that is not the butler is refused; so is a position this record did not give.
  const other = await read(worker, null);
  assert.ok(refused(other, 'error.steward.eventsButlerOnly'), JSON.stringify(other));
  assert.equal(Object.hasOwn(other, 'value') && JSON.stringify(other.value).includes('合成'), false, 'the other session gets no event');
  const stale = await read(butler, first.value.through.replace(/:2$/u, ':9'));
  assert.ok(refused(stale, 'error.steward.eventsPosition'), JSON.stringify(stale));
  checks.push('A session in a space that is not the butler is refused with no event; a position past the newest is refused');
  // 4. Each read by the butler is a step in its record; the other session's try is not the butler's.
  const entries = (await page.evaluate(() => workspace.stewardRecord())).entries.filter(e => e.kind !== 'role');
  assert.deepEqual(entries.map(e => [e.kind, e.method, e.state]), [['invoke', 'stewardEvents', 'unconfirmed'], ['invoke', 'stewardEvents', 'complete'], ['invoke', 'stewardEvents', 'complete']], JSON.stringify(entries));
  checks.push('Each of the butler\'s three reads is a step in 「大管家的记录」, and the other session\'s is not');
  // What it read stays out of every file NAW keeps besides the event record itself (operation log, the butler's record).
  const files = fs.readdirSync(profile, { recursive: true }).map(name => path.join(profile, name))
    .filter(file => path.basename(file) !== 'butler-ledger.jsonl' && fs.lstatSync(file).isFile());
  const keeping = files.filter(file => fs.readFileSync(file).includes('合成失败原因'));
  assert.deepEqual(keeping.map(file => path.relative(profile, file)), [], 'no other file keeps what the butler read');
  checks.push(`None of the ${files.length} other files in the profile keeps what the butler read`);
  save('reads', { first: first.value, none: none.value, other, stale });

  // 5. NAW quits; one more event is recorded; NAW starts again. The old position reads on: only the new event.
  await quit();
  record(ledger => ledger.ingest(failure(3)));
  await launch();
  const resumed = await read(butler, first.value.through);
  assert.equal(resumed.state, 'complete', JSON.stringify(resumed));
  assert.deepEqual(resumed.value.events.map(e => [e.sequence, e.payload.itemId]), [[3, 'item-3']], JSON.stringify(resumed.value));
  assert.equal(resumed.value.through, first.value.through.replace(/:2$/u, ':3'));
  checks.push('After NAW restarts, the old position reads on: only the event recorded since, nothing lost or repeated');
  save('restart', { resumed: resumed.value });

  assert.deepEqual(errors, []);
  const stats = await fixture('stats'); assert.equal(stats.nativeProcesses, 0); assert.equal(stats.modelCalls, 0);
  save('result', { passed: true, checks, nativeProgramsStarted: 0, modelCalls: 0 });
  console.log(JSON.stringify({ passed: true, checks }));
}
(async () => { try { await run(); } catch (e) {
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {});
    save('result', { passed: false, checks, error: e.stack, errors }); console.error(e.stack); process.exitCode = 1; }
  finally {
    if (helper) helper.stdin.end();
    if (client) client.close();
    await scratch.release();
    const owner = JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))); if (owner.token === token) fs.rmSync(slot, { recursive: true });
  }
})();
