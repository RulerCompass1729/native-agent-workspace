// Isolated desktop journey for the integration handoff (B6 E2b): the real desktop, the
// main-process dispatcher and engine, the real git reader on a temporary repository, the real
// space record and workspace service, with a synthetic provider transport. No native process, no
// model, no notice to the OS. The handoff switch is open for this isolated run only.
const testScratch = require('./fixtures/test-scratch.cjs');
const { joinSpace } = require('./fixtures/space-membership.cjs');
const { createIn } = require('./fixtures/create-view.cjs');
const { revealDefaultSpace } = require('./fixtures/default-space.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { fork } = testScratch.childProcess;
const { _electron } = testScratch.playwright(require('playwright'));
const { connect } = require('../app/service-client.cjs');

const root = path.resolve(__dirname, '..');
// The shared single-GUI slot every desktop script takes: a second interface would move windows.
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock');
const token = randomUUID();
let slotOwned = false;
try {
  fs.mkdirSync(slot);
} catch (error) {
  if (error.code !== 'EEXIST') {
    throw error;
  }
  console.error('GUI slot occupied; nothing started.');
  process.exit(75);
}
slotOwned = true;
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'integration-handoff-test', task: 'integration handoff journey', token, pid: process.pid, time: new Date().toISOString() }));
function releaseSlot() {
  if (!slotOwned) return;
  try {
    if (JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'), 'utf8')).token === token) {
      fs.rmSync(slot, { recursive: true }); slotOwned = false;
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
// A failed Electron close must not strand our lease after scratch cleanup exits.
process.once('exit', releaseSlot);
const profile = testScratch.directory(path.join(os.tmpdir(), 'naw-integration-handoff-'));
const version = require(path.join(root, 'package.json')).version;
const child = fork(path.join(root, 'app/daemon.cjs'), [profile], {
  execArgv: ['--require', path.join(__dirname, 'fixtures/queue-native.cjs')],
  env: { ...process.env, NAW_APP_VERSION: version, NAW_WORKSPACE: profile, NAW_TEST_APP_ROOT: root },
  stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
});
let app;
let page;
let client;
let sequence = 0;
const errors = [];
const passed = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(check, label, limit = 60000) {
  const started = Date.now();
  while (Date.now() - started < limit) {
    if (await check()) {
      return Date.now() - started;
    }
    await delay(250);
  }
  throw Error(label);
}
function fixture(method, session = null, reply = '') {
  sequence += 1;
  const id = sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.off('message', listener); reject(Error('Fixture timeout')); }, 5000);
    const listener = message => {
      if (message.requestId === id) { clearTimeout(timer); child.off('message', listener); resolve(message); }
    };
    child.on('message', listener);
    child.send({ id, method, session, reply });
  });
}
const sends = async () => (await fixture('stats')).sends;
async function release(session, reply) {
  const result = await fixture('release', session, reply);
  assert.equal(result.released, true, `release ${reply}`);
}
const snapshot = () => page.evaluate(() => workspace.initial());
async function spaceEvents() {
  const state = await snapshot();
  const room = (state.rooms || [state.room]).find(r => r.id === 'shared');
  return (room.events || []).map(event => event.text);
}
// What the main process would have shown the person as a system notification (recorded, not shown).
const notices = () => app.evaluate(() => globalThis.decisionNotifications.map(notification => notification.options));
const overview = () => page.evaluate(() => workspace.handoff('list'));
async function capture(name) {
  if (!process.env.NAW_EVIDENCE_DIR) {
    return;
  }
  fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true });
  await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, name + '.png'), timeout: 5000 });
}
async function launch() {
  assert.ok(!app, 'One test UI at a time');
  assert.ok(!process.env.NAW_APP_EXECUTABLE, 'The notification fixture is source-only');
  // The notification fixture is loaded before the app, so nothing reaches the OS.
  const source = path.join(profile, 'source-app'); fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'naw-handoff-test', version, main: 'entry.cjs' }));
  fs.writeFileSync(path.join(source, 'entry.cjs'), `require(${JSON.stringify(path.join(__dirname, 'fixtures/decision-notification.cjs'))});\nrequire(${JSON.stringify(path.join(root, 'app/main.cjs'))});\n`);
  const env = { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid), NAW_TEST_QUEUE_HUMAN_QUIET_MS: '3000', NAW_TEST_INTEGRATION_HANDOFF: '1' };
  app = await _electron.launch({ executablePath: require('electron'), args: [source], env, timeout: 70000 });
  page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await page.locator('#new-session').waitFor({ timeout: 60000 });
}
async function createSession(name, join) {
  await page.locator('#new-session').click();
  await page.locator('input[name="provider"][value="claude"]').check();
  await page.locator('#session-name').fill(name);
  await createIn(page, 'chat');
  await until(async () => (await snapshot()).sessions.some(s => s.name === name), `Created ${name}`);
  if (join) await joinSpace(page);
  return (await snapshot()).sessions.find(s => s.name === name);
}

async function run() {
  console.log('Fixture profile:', profile);
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Daemon');
  client = await connect(profile, 'integration-handoff-test');
  await launch();
  await revealDefaultSpace(page);
  const member = await createSession('队员甲', true);
  const integrator = await createSession('集成者', false);
  assert.ok(integrator.nativeId && member.nativeId, 'The synthetic sessions have native ids');
  // The integrator works in a real repository: main, and the member's delivery on its own branch.
  // Git runs only in the folder this run's own profile gave the session, never anywhere else.
  const folder = integrator.cwd;
  assert.equal(path.dirname(folder), path.resolve(profile) + '-sessions', 'The integrator works in this run\'s own temporary folder');
  assert.ok(fs.statSync(folder).isDirectory() && !fs.existsSync(path.join(folder, '.git')));
  const gitEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/.test(name))), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Synthetic fixture', '-c', 'user.email=fixture@example.com', ...args],
    { cwd: folder, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const commit = (file, text) => { fs.writeFileSync(path.join(folder, file), text); git('add', '--', file); git('commit', '--quiet', '-m', `Synthetic ${file}`); return git('rev-parse', 'HEAD'); };
  git('init', '--quiet', '--initial-branch=main');
  commit('synthetic-base.txt', 'base\n');
  git('checkout', '--quiet', '-b', 'lane/a');
  const delivery = commit('synthetic-delivery.txt', 'delivered\n');
  git('checkout', '--quiet', 'main');
  commit('synthetic-other.txt', 'main moved on\n');

  // 1) The person queues a task; the member gets it and delivers.
  await page.locator('#room-nav').click();
  await page.evaluate(() => workspace.spaceAction('shared', 'queueAdd', ['修好列表', null]));
  await until(async () => (await sends()).some(send => send.id === member.id && /【NAW 派活】[\s\S]*修好列表/.test(send.text)), 'The task reaches the member');
  await release(member.id, `做完了。\nREADY lane/a ${delivery}`);
  await until(async () => (await spaceEvents()).some(text => text.includes('READY') && text.includes('lane/a')), 'The delivery is recorded in the space');
  // Nobody is designated: nothing is handed to anyone, and the person is asked once.
  await until(async () => (await notices()).some(options => options.body === '1 件交付在等集成，但还没有指定集成者'), 'The person is asked to designate an integrator');
  assert.equal((await overview()).summary.deliverable, 1);
  assert.equal((await sends()).filter(send => send.text.includes('【NAW 集成交接】')).length, 0);
  passed.push('A delivery with nobody designated waits, and the person is asked once');

  // 2) The person designates the integrator; one handoff goes to it, and the space says so.
  await page.evaluate(id => workspace.integrator(id), integrator.id);
  await until(async () => (await sends()).some(send => send.id === integrator.id && send.text.startsWith('【NAW 集成交接】')), 'The handoff reaches the integrator');
  const handoff = (await sends()).find(send => send.text.startsWith('【NAW 集成交接】'));
  assert.ok(handoff.text.includes(delivery) && handoff.text.includes('lane/a') && handoff.text.includes('独审：现在关着'), 'The handoff names the delivery and says reviews are off');
  await until(async () => (await spaceEvents()).some(text => text.includes('已交给集成者')), 'The space says the delivery was handed out');
  // The person reads it where space notices are shown: the space's shared record.
  await page.locator('#room-record').click();
  await until(async () => (await page.locator('#room-messages').innerText()).includes('已交给集成者'), 'The person sees the handed-out notice in the space\'s shared record');
  await capture('handed-out');
  passed.push('After the designation one handoff went to the integrator through the dispatcher, and the space says so');

  // 3) The integrator does its work in git and answers; NAW checks the merge in the real repository.
  git('cherry-pick', delivery);
  const head = git('rev-parse', 'HEAD');
  await release(integrator.id, `合好了。\nMERGED ${delivery.slice(0, 9)} as ${head.slice(0, 9)} tests 12/12`);
  await until(async () => (await spaceEvents()).some(text => text.includes('已合入 main') && text.includes(head.slice(0, 12)) && text.includes('12/12')), 'The space says the delivery was merged', 90000);
  await until(async () => (await notices()).some(options => options.body === `main 已合入新的交付（${head.slice(0, 12)}），可以安装`), 'The person is told the new main can be installed');
  const merged = await overview();
  assert.deepEqual([merged.summary.deliverable, merged.summary.held, merged.summary.handed, merged.summary.handoff], [0, 0, 0, null]);
  assert.ok(merged.reasons.some(reason => reason.reason === `installable:${head}`));
  await until(async () => (await page.locator('#room-messages').innerText()).includes(`已合入 main：${head.slice(0, 12)}，测试 12/12`), 'The person sees the merge in the space\'s shared record');
  await capture('merged');
  passed.push('The integrator\'s answer was checked against the real repository; the space says merged and the person is told main can be installed');

  // 4) The person answers the install question from their own window; exactly one handoff was ever sent.
  assert.deepEqual(await page.evaluate(reason => workspace.handoff('answer', reason), `installable:${head}`), { answered: true });
  assert.ok(!(await overview()).reasons.some(reason => reason.reason.startsWith('installable:')));
  await delay(8000);
  const all = await sends();
  assert.equal(all.filter(send => send.text.startsWith('【NAW 集成交接】')).length, 1, 'One handoff, sent once');
  assert.equal(all.filter(send => send.id === member.id).length, 1, 'The member got its one task and never a handoff');
  const shown = (await notices()).map(options => options.title + ' | ' + options.body);
  assert.equal(shown.filter(text => text.startsWith('NAW · 集成交接要你处理')).length, 2, 'Two notices: nobody designated, then installable');
  assert.ok(!shown.some(text => text.includes('修好列表')), 'No notice carries the task text');
  passed.push('The install question was answered from the person\'s window; one handoff and two notices in all, none with task text');

  assert.deepEqual(errors, []);
  assert.equal(app.windows().length, 1);
  console.log(JSON.stringify({ passed, errors, syntheticDispatches: all.length, notices: shown, nativeProviderProcesses: 0, nativeModelCalls: 0 }));
}

run().catch(async error => {
  console.error(error.stack);
  if (page) {
    await capture('failed').catch(failure => console.error('Screenshot:', failure.message));
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
  releaseSlot();
}));
