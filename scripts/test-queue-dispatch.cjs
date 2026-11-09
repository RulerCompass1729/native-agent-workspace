// Isolated desktop regression for space task queues (board top 2026-11-08 16:12) and
// session rotation (2026-11-08): the real desktop, main-process dispatcher and
// workspace service, with a synthetic provider transport. No native process, no model.
const testScratch = require('./fixtures/test-scratch.cjs');
const { joinSpace } = require('./fixtures/space-membership.cjs');
const { createIn } = require('./fixtures/create-view.cjs');
const { revealDefaultSpace } = require('./fixtures/default-space.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { fork } = testScratch.childProcess;
const { _electron } = testScratch.playwright(require('playwright'));
const { connect } = require('../app/service-client.cjs');

const root = path.resolve(__dirname, '..');
const code = process.env.NAW_TEST_APP_ROOT || root;
const profile = testScratch.directory(path.join(os.tmpdir(), 'naw-queue-dispatch-'));
const version = require(path.join(code, 'package.json')).version;
const child = fork(path.join(code, 'app/daemon.cjs'), [profile], {
  execArgv: ['--require', path.join(__dirname, 'fixtures/queue-native.cjs')],
  env: { ...process.env, NAW_APP_VERSION: version, NAW_WORKSPACE: profile, NAW_TEST_APP_ROOT: code },
  stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
});
// The acceptance from the board: the next item arrives within one minute.
const DISPATCH_LIMIT_MS = 60000;
let app;
let page;
let client;
let sequence = 0;
const errors = [];
const passed = [];
const timings = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(check, label, limit = 30000) {
  const started = Date.now();
  while (Date.now() - started < limit) {
    if (await check()) {
      return Date.now() - started;
    }
    await delay(200);
  }
  throw Error(label);
}

function fixture(method, session = null, reply = '') {
  sequence += 1;
  const id = sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off('message', listener);
      reject(Error('Fixture timeout'));
    }, 5000);
    const listener = message => {
      if (message.requestId === id) {
        clearTimeout(timer);
        child.off('message', listener);
        resolve(message);
      }
    };
    child.on('message', listener);
    child.send({ id, method, session, reply });
  });
}

async function sends() {
  return (await fixture('stats')).sends;
}

async function release(session, reply) {
  const result = await fixture('release', session, reply);
  assert.equal(result.released, true, `release ${reply}`);
}

const snapshot = () => page.evaluate(() => workspace.initial());

async function queue() {
  const state = await snapshot();
  const room = (state.rooms || [state.room]).find(r => r.id === 'shared');
  return room.queue || [];
}

async function events() {
  const state = await snapshot();
  const room = (state.rooms || [state.room]).find(r => r.id === 'shared');
  const texts = [];
  for (const event of room.events || []) {
    texts.push(event.text);
  }
  return texts;
}

async function capture(name) {
  if (!process.env.NAW_EVIDENCE_DIR) {
    return;
  }
  fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true });
  await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, name + '.png') });
}

async function launch(extraEnv = {}) {
  assert.ok(!app, 'One test UI at a time');
  const env = { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid), NAW_TEST_QUEUE_HUMAN_QUIET_MS: '3000', ...extraEnv };
  let executablePath = require('electron');
  let args = [root];
  if (process.env.NAW_APP_EXECUTABLE) {
    executablePath = process.env.NAW_APP_EXECUTABLE;
    args = [];
  }
  app = await _electron.launch({ executablePath, args, env, timeout: 70000 });
  page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await page.locator('#new-session').waitFor();
}

async function relaunch(extraEnv) {
  await app.close();
  app = null;
  await launch(extraEnv);
}

async function createMember(name) {
  await page.locator('#new-session').click();
  await page.locator('input[name="provider"][value="claude"]').check();
  await page.locator('#session-name').fill(name);
  await createIn(page, 'chat');
  await until(async () => (await snapshot()).sessions.some(s => s.name === name), `Created ${name}`);
  await joinSpace(page);
  return (await snapshot()).sessions.find(s => s.name === name).id;
}

async function openSpace() {
  await page.locator('#room-nav').click();
  await page.locator('#room-record').click();
}

async function addItem(text, assignee = '') {
  if (!(await page.locator('#queue-dialog').isVisible())) {
    await page.locator('#room-queue').click();
    await page.locator('#queue-dialog').waitFor();
  }
  await page.locator('#queue-text').fill(text);
  await page.locator('#queue-assignee').selectOption(assignee);
  await page.locator('#add-queue').click();
  await until(async () => (await queue()).some(item => item.text === text), `Queued ${text}`);
}

async function itemByText(text) {
  return (await queue()).find(item => item.text === text);
}

// The next send must reach this member with this text, within the board's one minute.
async function expectSend(count, session, pattern, label) {
  const elapsed = await until(async () => (await sends()).length >= count, label, DISPATCH_LIMIT_MS);
  const all = await sends();
  assert.equal(all.length, count, `${label}: exactly one new send`);
  const last = all[count - 1];
  assert.equal(last.id, session, `${label}: recipient`);
  assert.match(last.text, pattern, `${label}: text`);
  timings.push({ label, ms: elapsed });
  return elapsed;
}

async function expectQuiet(count, label, ms = 14000) {
  await delay(ms);
  assert.equal((await sends()).length, count, label);
}

async function run() {
  console.log('Fixture profile:', profile);
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Daemon');
  client = await connect(profile, 'queue-test');
  await launch();
  await revealDefaultSpace(page);
  const a = await createMember('队员甲');
  const b = await createMember('队员乙');
  await openSpace();

  // 1) Two idle members each get exactly one item; NAW, not the person, sends them.
  await addItem('任务一');
  await expectSend(1, a, /【NAW 派活】[\s\S]*任务一/, 'first item to the first idle member');
  await addItem('任务二');
  await expectSend(2, b, /【NAW 派活】[\s\S]*任务二/, 'second item to the other idle member');
  assert.equal((await itemByText('任务一')).status, 'sent');
  assert.ok((await events()).includes('NAW 派活：任务一 → 队员甲'), 'dispatch record in the space');
  await capture('two-dispatched');
  passed.push('Each idle member received exactly one queued item, recorded in the space');

  // 2) Busy members get nothing more; finishing one item brings the next within one minute.
  await addItem('任务三');
  await expectQuiet(2, 'No item while both members work');
  await release(a, '任务一完成');
  await expectSend(3, a, /任务三/, 'next item after the member finished');
  assert.equal((await itemByText('任务一')).status, 'done');
  passed.push('A member that finished got the next item within one minute; nothing was sent while members worked');

  // 3) A paused member is skipped until the person turns automatic messages back on.
  await page.evaluate(id => workspace.wakePolicy(id, false), b);
  await release(b, '任务二完成');
  await addItem('任务四', b);
  await expectQuiet(3, 'Paused member receives nothing');
  assert.equal((await itemByText('任务四')).status, 'queued');
  await page.evaluate(id => workspace.wakePolicy(id, true), b);
  await expectSend(4, b, /任务四/, 'item after the member was unpaused');
  passed.push('A paused member was not sent its item until unpaused');

  // 4) A reply that asks for a decision stops that member until the person marks it handled.
  await release(a, '需要你决定：要不要合并分支？');
  await until(async () => (await itemByText('任务三')).status === 'waiting', 'Waiting for decision');
  assert.ok((await events()).includes('队员甲 需要你决定：任务三'), 'decision record in the space');
  await addItem('任务五', a);
  await expectQuiet(4, 'No new item while a decision is pending');
  const waitingId = (await itemByText('任务三')).id;
  await page.locator(`#queue-list [data-queue-item="${waitingId}"]`).getByRole('button', { name: '已处理', exact: true }).click();
  await expectSend(5, a, /任务五/, 'item after the person handled the decision');
  await capture('decision-handled');
  passed.push('A decision request paused that member until the person marked it handled');

  // 5) A cancelled item is never sent.
  await addItem('任务六', b);
  const cancelId = (await itemByText('任务六')).id;
  await page.locator(`#queue-list [data-queue-item="${cancelId}"]`).getByRole('button', { name: '取消', exact: true }).click();
  await until(async () => (await itemByText('任务六')).status === 'cancelled', 'Cancelled');
  await release(b, '任务四完成');
  await expectQuiet(5, 'A cancelled item is not sent');
  passed.push('A cancelled item was not sent');

  // 6) Session rotation: an old member writes a handoff, a new member continues, the old one ends.
  await release(a, '任务五完成');
  await relaunch({ NAW_TEST_QUEUE_ROTATE_MS: '60000' });
  await openSpace();
  await addItem('任务七', a);
  await expectSend(6, a, /【NAW 换会话】[\s\S]*只写交接/, 'handoff request to the old member');
  assert.equal((await itemByText('任务七')).status, 'queued', 'The old member does not get new work');
  await release(a, '交接：在 feature-x 分支，下一步跑全量测试。');
  await until(async () => (await snapshot()).sessions.some(s => s.name === '队员甲 · 续'), 'New member created', DISPATCH_LIMIT_MS);
  const fresh = (await snapshot()).sessions.find(s => s.name === '队员甲 · 续').id;
  await expectSend(7, fresh, /你接手「队员甲」[\s\S]*feature-x 分支/, 'handoff to the new member');
  await until(async () => (await snapshot()).sessions.find(s => s.id === a).state === 'ended', 'Old member ended');
  assert.equal((await itemByText('任务七')).assignee, fresh, 'The queue follows the new member');
  const rotated = (await events()).some(text => text.startsWith('NAW 换会话：「队员甲」的工作已交给「队员甲 · 续」'));
  assert.ok(rotated, 'rotation record in the space');
  await release(fresh, '已核对交接。');
  await expectSend(8, fresh, /任务七/, 'queued item to the new member');
  await capture('rotated');
  passed.push('An old member wrote a handoff; a new member took over its queue; the old process ended');

  assert.deepEqual(errors, []);
  assert.equal(app.windows().length, 1);
  console.log(JSON.stringify({ passed, timings, errors, syntheticDispatches: (await sends()).length, nativeProviderProcesses: 0, nativeModelCalls: 0, oneWindow: true }));
}

run().catch(async error => {
  console.error(error.stack);
  if (page) {
    await capture('failed');
  }
  process.exitCode = 1;
}).finally(testScratch.cleanup(async () => {
  if (app) {
    await app.close();
  }
  if (client) {
    const state = await client.call('initial');
    for (const session of state.sessions) {
      if (session.state !== 'ended') {
        await client.call('stop', session.id);
      }
    }
    await client.call('shutdown');
    client.close();
  }
  if (child.connected) {
    child.disconnect();
  }
}));
