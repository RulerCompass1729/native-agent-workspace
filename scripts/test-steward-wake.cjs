// Waking the butler when NAW has recorded something new (steward-wake.cjs; decided on the task board by the butler then
// designated, 2026-11-13 01:20:41: 「事件来时唤醒大管家，我定了：做，默认关」, 「开关只给用户和大管家」). The session the
// person made the butler turns it on through the actual stdio tool; a session that is not the butler is refused. A member
// of a space asks the person a decision on its queue item, which NAW records; once the butler is idle and settled, NAW
// sends it one message naming only a position, through the same send as a queue item, and writes that wake in
// 「大管家的记录」 under NAW's name. From that position the butler reads exactly the new event.
// Real hidden Electron UI and service; the native producer is synthetic (the background-control fixture). No native
// program is started and no model is called. Takes the GUI test slot itself.
const scratch = require('./fixtures/test-scratch.cjs');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto'), { execFileSync } = require('node:child_process');
const { _electron } = scratch.playwright(require('playwright'));
const { connectService } = require('../app/service-connection.cjs');
const { ButlerLedger } = require('../app/butler-ledger.cjs');
const { wakeText } = require('../app/steward-wake.cjs');
const locale = require('../app/ui-locale.js');
const root = path.resolve(__dirname, '..'), evidence = process.env.NAW_EVIDENCE_DIR;
if (!evidence || !path.isAbsolute(evidence) || path.resolve(evidence).startsWith(root + path.sep)) throw Error('External private evidence directory required');
fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID();
try { fs.mkdirSync(slot); } catch (e) { if (e.code !== 'EEXIST') throw e; console.error('GUI slot occupied; no launch.'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ token, owner: 'claude310', task: 'steward wake window check', pid: process.pid, at: new Date().toISOString() }));
execFileSync(process.execPath, [path.join(root, 'scripts/build-ui.cjs')]);
const checks = [], errors = [];
let profile, child, client, app, page, helper, rpc, sequence = 0, butler, worker;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, limit = 8000) { const end = Date.now() + limit; while (Date.now() < end) { if (await fn()) return; await wait(100); } throw Error(label); }
const save = (name, value) => fs.writeFileSync(path.join(evidence, name + '.json'), JSON.stringify(value, null, 2), { mode: 0o600 });
function fixture(method, target, value) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.off('message', receive); reject(Error('Fixture response timeout')); }, 8000);
    const receive = r => { if ((method === 'backgroundProof' ? r.proofRequestId : r.requestId) !== id) return; clearTimeout(timer); child.off('message', receive); r.error ? reject(Error(r.error)) : resolve(r); };
    child.on('message', receive); child.send({ id, method, target, value, text: method === 'release' ? value : undefined });
  });
}
// The stdio tool a native session runs, bound to the app that is running now.
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
const thread = session => 'synthetic-' + session;
// One workspace_control call inside a synthetic native turn, and the end of that turn.
async function control(session, args) {
  const proof = await fixture('backgroundProof', session, { callId: randomUUID(), arguments: args });
  const result = await rpc('tools/call', { name: 'workspace_control', arguments: args,
    _meta: { threadId: proof.nativeId, sessionId: proof.sessionId, callId: proof.callId, 'x-codex-turn-metadata': { thread_id: proof.nativeId, turn_id: proof.turnId } } });
  await fixture('backgroundComplete', session, { callId: proof.callId, arguments: args });
  await fixture('event', session, { method: 'turn/completed', params: { threadId: thread(session), turn: { id: proof.turnId, status: 'completed' } } });
  return JSON.parse(result.content[0].text);
}
const refused = (value, key) => value.state === 'unconfirmed' && ['zh', 'en'].some(language => value.error === locale.format(language, key));
const sessionOf = async id => (await client.call('initial')).sessions.find(s => s.id === id);
const sendsTo = async id => (await fixture('stats')).sends.filter(s => s.id === id);
// The lines of 「大管家的记录」 as NAW wrote them (history/steward, one { sequence, time, day, value } per line), read from
// the profile without opening the record.
function recordLines() {
  const dir = path.join(profile, 'history', 'steward');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort().flatMap(name => fs.readFileSync(path.join(dir, name), 'utf8').split('\n')).filter(line => line.trim())
    .map(line => { try { return JSON.parse(line).value; } catch { return null; } }).filter(value => value && typeof value === 'object');
}

async function run() {
  profile = fs.realpathSync(scratch.directory(path.join(os.tmpdir(), 'naw-steward-wake-'))); const cwd = path.join(profile, 'workspace'); fs.mkdirSync(cwd, { mode: 0o700 });
  child = scratch.childProcess.fork(path.join(root, 'app/daemon.cjs'), [profile], { cwd, execArgv: ['--require', path.join(__dirname, 'fixtures/background-control.cjs')],
    env: { ...process.env, NAW_TEST_APP_ROOT: root, NAW_WORKSPACE: cwd, NAW_APP_VERSION: require('../package.json').version }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Fixture service starts', 20000); client = await connectService(profile, 'human-view');
  // The synthetic transport replaces its connection with each session created, which ends the attachment of one still
  // waiting for it: each session attaches before the next is created, as both must take a NAW message.
  butler = await client.call('create', { provider: 'codex', cwd, name: 'Codex 管家', view: 'chat' });
  await until(async () => (await sessionOf(butler))?.chatAvailable === true, 'The butler attaches', 15000);
  worker = await client.call('create', { provider: 'codex', cwd, name: 'Codex 前端', view: 'chat' });
  await until(async () => (await sessionOf(worker))?.chatAvailable === true, 'The member attaches', 15000);
  await client.call('join', worker, true);
  fs.writeFileSync(path.join(profile, 'views.json'), JSON.stringify([{ owner: 'human-view', active: true, selected: butler, mode: 'chat' }]), { mode: 0o600 });
  // One event recorded before anything is turned on: not news once it is.
  new ButlerLedger(profile).ingest({ eventId: 'butler-source:window-old', sourceRef: 'queue-outcome:shared:window-old', kind: 'failure',
    payload: { spaceId: 'shared', itemId: 'item-old', memberName: 'Codex 前端', text: '合成旧任务', reason: '合成旧失败原因' } });
  app = await _electron.launch({ args: [root], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 30000 });
  page = await app.firstWindow(); page.setDefaultTimeout(8000); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#message-input').waitFor();
  rpc = mcp(); await rpc('initialize');
  const designatedAt = Date.now();
  await page.evaluate(id => workspace.steward(id), butler);
  await until(async () => await page.locator('#steward-slot .session-row').count() === 1, 'The butler sits at the top');
  // Designated, it is sent its duty statement; it answers, and its turn ends.
  await until(async () => (await sendsTo(butler)).some(s => s.text.includes('【NAW 职责说明】')), 'The butler gets its duty statement');
  await fixture('release', butler, '收到。');
  await until(async () => { const s = await sessionOf(butler); return s?.state === 'idle' && !s.pendingTag; }, 'The butler is idle');
  // The butler's model as its native settings report it (synthetic, not DeepSeek).
  await fixture('event', butler, { method: 'thread/settings/updated', params: { threadId: thread(butler), threadSettings: { model: 'synthetic-codex-model', effort: null } } });
  await until(async () => (await sessionOf(butler))?.nativeSettings?.model === 'synthetic-codex-model', 'The butler reports its model');

  // 1. Off by default, for the person and for the butler.
  assert.deepEqual(await page.evaluate(() => workspace.stewardWake()), { on: false, at: null, failed: false });
  const asked = await control(butler, invoke('stewardWake', []));
  assert.deepEqual([asked.state, asked.value], ['complete', { on: false, at: null, failed: false }], JSON.stringify(asked));
  checks.push('Off by default: the person\'s window and the butler both see it off');
  // 2. A session that is not the butler cannot turn it on.
  const other = await control(worker, invoke('stewardWake', [true]));
  assert.ok(refused(other, 'error.steward.wakeOnly'), JSON.stringify(other));
  assert.equal((await page.evaluate(() => workspace.stewardWake())).on, false);
  checks.push('A member of a space that is not the butler is refused, and it stays off');
  // 3. The butler turns it on.
  const on = await control(butler, invoke('stewardWake', [true]));
  assert.deepEqual([on.state, on.value], ['complete', { on: true, at: null, failed: false }], JSON.stringify(on));
  assert.equal((await page.evaluate(() => workspace.stewardWake())).on, true);
  checks.push('The butler turns it on through workspace_control; the person\'s window sees it on');
  const before = (await sendsTo(butler)).length;

  // 4. The member's queue item ends in a question for the person: NAW records a decision, then wakes the butler once.
  await page.evaluate(([id, text]) => workspace.spaceAction('shared', 'queueAdd', [text, id]), [worker, '合成任务甲']);
  await until(async () => (await sendsTo(worker)).some(s => /合成任务甲/u.test(s.text)), 'The member gets its item', 90000);
  await fixture('release', worker, '需要你决定：合成问题要不要做？');
  const started = Date.now();
  // The duty statement went to the butler as the person's message, so NAW first waits the person's two quiet minutes
  // since the designation, as for a member's next queue item; then one pass (30 s) and the idle settling.
  try { await until(async () => (await sendsTo(butler)).length > before, 'NAW wakes the butler', 180000); }
  catch (error) {
    const session = (await client.call('initial')).sessions.find(s => s.id === butler);
    save('not-woken', Object.fromEntries(['state', 'roomIds', 'nativeId', 'nativeSettings', 'chatAvailable', 'background', 'scheduled', 'backgroundStale', 'pendingTag', 'pendingQueue', 'liveDraft', 'wakeDisabled'].map(k => [k, session?.[k]])));
    throw error;
  }
  const wokenAfterMs = Date.now() - started, sinceDesignationMs = Date.now() - designatedAt;
  const wakes = (await sendsTo(butler)).slice(before);
  assert.equal(wakes.length, 1, JSON.stringify(wakes));
  const position = /stewardEvents，参数 \[("[0-9a-f]{16}:1")\]/u.exec(wakes[0].text)?.[1];
  assert.ok(position, wakes[0].text);
  assert.ok(wakes[0].text.includes(wakeText(JSON.parse(position))), wakes[0].text);
  assert.equal(/合成|需要你决定|Codex 前端/u.test(wakes[0].text), false, 'the message carries nothing of what was recorded');
  assert.ok(sinceDesignationMs >= 120000, 'not within the person\'s quiet time after the designation');
  checks.push(`NAW woke the butler with one message naming only the position it was turned on at, ${Math.round(wokenAfterMs / 1000)} s after the member's reply and ${Math.round(sinceDesignationMs / 1000)} s after the designation`);
  // 5. In 「大管家的记录」 under NAW's name, with its outcome; the person's dialog does not show it yet.
  // The fixture sees the message before NAW writes its outcome.
  await until(() => recordLines().some(line => line.kind === 'outcome' && recordLines().some(w => w.kind === 'wake' && w.id === line.step)), 'The wake\'s outcome is recorded');
  const lines = recordLines(), wake = lines.filter(line => line.kind === 'wake');
  assert.equal(wake.length, 1, JSON.stringify(lines));
  assert.deepEqual([wake[0].session.id, wake[0].position], [butler, JSON.parse(position)]);
  assert.equal(lines.find(line => line.kind === 'outcome' && line.step === wake[0].id)?.state, 'sent');
  const shown = (await page.evaluate(() => workspace.stewardRecord())).entries;
  assert.equal(shown.some(entry => entry.kind === 'wake' || entry.method === undefined && entry.kind !== 'role'), false, JSON.stringify(shown));
  checks.push('The wake is a line in 「大管家的记录」 under NAW\'s name with the outcome sent; the dialog shows it only once its words are seen');
  // 6. From that position the butler reads exactly the new event: the decision, not the old failure.
  const read = await control(butler, invoke('stewardEvents', [JSON.parse(position)]));
  assert.equal(read.state, 'complete', JSON.stringify(read));
  assert.deepEqual(read.value.events.map(e => [e.sequence, e.kind, e.payload.spaceId]), [[2, 'decision', 'shared']], JSON.stringify(read.value));
  checks.push('From the position in the message the butler reads the decision and nothing older');
  save('wake', { wakeText: wakes[0].text, wokenAfterMs, sinceDesignationMs, record: lines.filter(line => line.kind !== 'invoke' && line.kind !== 'snapshot'), read: read.value });

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
    if (app) await app.close().catch(() => {});
    if (client) client.close();
    await scratch.release();
    const owner = JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))); if (owner.token === token) fs.rmSync(slot, { recursive: true });
  }
})();
