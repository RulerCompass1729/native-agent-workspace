// T49: actual source GUI + Codex adapter, synthetic transport, zero inference.
const scratch = require('./fixtures/test-scratch.cjs');
const { createIn } = require('./fixtures/create-view.cjs');
const { chooseRecipient, fillRoomMessage } = require('./room-input.cjs');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const { fork } = scratch.childProcess, { _electron } = scratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const { connect } = require(path.join(code, 'app/service-client.cjs'));
const profile = scratch.directory(path.join(os.tmpdir(), 'naw-capacity-room-'));
const evidence = process.env.NAW_EVIDENCE_DIR, pictures = process.env.NAW_SCREENSHOT_DIR;
if (evidence) fs.mkdirSync(evidence, { recursive: true });
const child = fork(path.join(code, 'app/daemon.cjs'), [profile], {
  execArgv: ['--require', path.join(__dirname, 'fixtures/capacity-room.cjs')],
  env: { ...process.env, NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_WORKSPACE: profile, NAW_TEST_APP_ROOT: code },
  stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
});
let app, page, client, sequence = 0;
const errors = [], states = {}, delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { for (let i = 0; i < 200; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
function native(method = 'stats', extra = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const cb = msg => { if (msg.requestId === id) { clearTimeout(timer); child.off('message', cb); resolve(msg); } };
    const timer = setTimeout(() => { child.off('message', cb); reject(Error('Fixture timeout')); }, 5000);
    child.on('message', cb); child.send({ id, method, ...extra });
  });
}
const snapshot = () => page.evaluate(() => workspace.initial());
const identities = state => state.sessions.map(s => [s.id, s.nativeId, s.name]);
async function shot(name) {
  if (pictures) { fs.mkdirSync(pictures, { recursive: true }); await page.screenshot({ path: path.join(pictures, name + '.png') }); }
}
async function select(id) { await page.locator(`[data-session-id="${id}"]`).click(); await page.locator('#chat-tab').click(); }
async function create(name) {
  await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="codex"]').check();
  await page.locator('#session-name').fill(name); await createIn(page, 'terminal');
  await until(async () => (await snapshot()).sessions.some(s => s.name === name && s.chatAvailable), 'Codex attached');
  return (await snapshot()).sessions.find(s => s.name === name).id;
}
async function room() { await page.locator('#room-nav').click(); await page.locator('#room-record').click(); }
async function release(target, text) { await native('release', { target, text }); }
async function run() {
  console.log(JSON.stringify({ profile, code, executable: process.env.NAW_APP_EXECUTABLE || require('electron'), fixture: 'capacity-room (25ms scheduled delay)' }));
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Fixture service');
  client = await connect(profile, 'capacity-test-observer');
  app = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root],
    env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#new-session').waitFor();
  const a = await create('T49 A'), b = await create('T49 B'), c = await create('T49 C');
  for (const [id, draft] of [[b, 'B unsent draft'], [c, 'C unsent draft']]) {
    await select(id); await page.locator('#message-input').fill(draft); await page.getByRole('button', { name: '加入协作', exact: true }).click();
  }
  await select(a); await page.locator('#message-input').fill('Independent A original task'); await page.locator('#send-button').click();
  await until(async () => (await native()).sends.length === 1, 'A original turn');
  await room(); await chooseRecipient(page, b); await fillRoomMessage(page, 'Bounded B C verification');
  await page.locator('#room-advanced summary').click(); await page.locator('#run-button').click();
  await page.locator(`[data-run-member="${c}"]`).check(); await page.locator('#run-limit').selectOption('4');
  await page.locator('#run-consent').check(); await page.locator('#confirm-run').click();
  await until(async () => (await native()).sends.length === 2, 'B starts bounded run');
  await fillRoomMessage(page, 'Shared unsent draft');
  states.before = await snapshot(); const identity = identities(states.before), runId = states.before.room.run.id;
  assert.deepEqual(states.before.room.run.ids, [b, c]); assert.equal(states.before.room.run.status, 'running');
  assert.equal(states.before.sessions.find(s => s.id === a).roomId, null);
  const turnId = states.before.sessions.find(s => s.id === a).activeTurnId;
  await native('event', { target: a, value: { method: 'turn/completed', params: { threadId: states.before.sessions.find(s => s.id === a).nativeId,
    turn: { id: turnId, status: 'failed', error: { message: 'Synthetic overload', codexErrorInfo: 'serverOverloaded' } } } } });
  await until(async () => (await native()).sends.length === 3, 'A automatic continuation');
  assert.deepEqual((await native()).sends[2], { id: a, text: '继续' });
  states.continued = await snapshot(); assert.equal(states.continued.room.run.status, 'running'); assert.equal(states.continued.room.run.id, runId);
  await shot('t49-a-continued-bc-running');
  await release(b, 'B verified first');
  await until(async () => (await native()).sends.length === 4, 'B reply hands off to C');
  assert.equal((await native()).sends[3].id, c);
  await release(c, 'C verified second');
  await until(async () => (await native()).sends.length === 5, 'C reply hands back to B');
  assert.equal((await native()).sends[4].id, b);
  await page.locator('#room-messages').getByText('C verified second', { exact: true }).waitFor();
  states.handoff = await snapshot(); assert.equal(states.handoff.room.run.status, 'running'); assert.equal(states.handoff.room.run.id, runId);
  assert.deepEqual(identities(states.handoff), identity);
  for (const [id, draft] of [[b, 'B unsent draft'], [c, 'C unsent draft']]) assert.equal(states.handoff.sessions.find(s => s.id === id).liveDraft, draft);
  assert.match(await page.locator('#shared-input').inputValue(), /Shared unsent draft/);
  await shot('t49-bc-handoff-preserved');
  await release(a, 'A continued independently');
  await until(async () => (await snapshot()).sessions.find(s => s.id === a).state === 'idle', 'A idle');
  await select(a); await page.locator('#message-input').fill('Human priority instruction'); await page.locator('#send-button').click();
  await until(async () => (await snapshot()).room.run.status === 'paused' && (await native()).sends.length === 6, 'Human pauses globally and sends');
  states.human = await snapshot(); assert.equal(states.human.room.run.reason, '你暂停了后续交接；已经开始的原生工作仍由原生会话管理。');
  assert.equal((await native()).sends.length, 6); assert.deepEqual(identities(states.human), identity);
  await release(b, 'Late B stays private'); await release(a, 'Human instruction completed');
  await room(); await page.locator('#run-status').getByText('你暂停了后续交接；已经开始的原生工作仍由原生会话管理。', { exact: false }).waitFor();
  await shot('t49-human-global-pause');
  assert.equal((await native()).sends.length, 6, 'No C dispatch after human pause');
  const final = await snapshot(); assert.ok(!final.room.messages.some(m => m.text === 'Late B stays private'));
  assert.deepEqual(errors, []);
  const stats = await native(); assert.equal(stats.modelCalls, 0); assert.equal(stats.nativeProcesses, 0);
  const result = { passed: ['A auto continuation preserves unrelated B/C run', 'B to C to B handoffs, identities and drafts preserved', 'Human send pauses globally; late B reply stays private'], stats, states, final, errors };
  if (evidence) { fs.mkdirSync(evidence, { recursive: true }); fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2)); }
  console.log(JSON.stringify({ passed: result.passed, sends: stats.sends, modelCalls: stats.modelCalls, nativeProcesses: stats.nativeProcesses }));
}
run().catch(async error => {
  console.error(error); process.exitCode = 1;
  if (page && evidence) fs.writeFileSync(path.join(evidence, 'failure-state.json'), JSON.stringify(await snapshot(), null, 2));
  if (page) { await shot('t49-failure').catch(() => {}); if (evidence) { fs.mkdirSync(evidence, { recursive: true }); fs.writeFileSync(path.join(evidence, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); } }
}).finally(scratch.cleanup(async () => {
  if (app) await app.close();
  if (client) { const state = await client.call('initial'); for (const s of state.sessions) await client.call('stop', s.id); await client.call('shutdown'); client.close(); }
  if (child.connected) child.disconnect();
}));
