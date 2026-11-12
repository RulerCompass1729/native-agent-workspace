// Isolated desktop journey for the queue panel's view of the integration handoff (B6): the person
// opens the space's queue panel and presses its real controls. The real desktop, the main-process
// dispatcher and engine, the real git reader on a temporary repository, the real space record and
// workspace service, with a synthetic provider transport. No native process, no model, no notice
// to the OS, and the system's folder dialog is answered by the script. The handoff switch is open
// for this isolated run only.
const testScratch = require('./fixtures/test-scratch.cjs');
const { joinSpace, leaveSpace } = require('./fixtures/space-membership.cjs');
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
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'handoff-panel-test', task: 'integration handoff in the queue panel', token, pid: process.pid, time: new Date().toISOString() }));
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
const profile = testScratch.directory(path.join(os.tmpdir(), 'naw-handoff-panel-'));
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
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'naw-handoff-panel-test', version, main: 'entry.cjs' }));
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

const locale = require('../app/ui-locale.js');
const say = (key, params) => locale.format('zh', key, params);
const NAMES = ['队员甲', '队员乙', '队员丙', '小周'], TASKS = ['修好列表', '补上说明', '整理配色', '加上导出', '写更新说明'];
let shots = 0;
// The panel as the person sees it, kept as pictures when a folder for them is given.
async function shot(name) {
  if (!process.env.NAW_EVIDENCE_DIR) return;
  fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true });
  shots += 1;
  const base = path.join(process.env.NAW_EVIDENCE_DIR, `${String(shots).padStart(2, '0')}-${name}`);
  if (await page.locator('#queue-dialog[open]').count()) {
    await page.locator('#queue-dialog').evaluate(node => { node.scrollTop = 0; });
    await page.locator('#queue-dialog').screenshot({ path: base + '.png', timeout: 5000 });
  }
  await page.screenshot({ path: base + '-window.png', timeout: 5000 });
}
// What the panel says: the block on top, each row's state, words and buttons, and the button that opens it.
const read = () => page.evaluate(() => ({
  block: document.getElementById('queue-handoff').hidden ? '' : document.getElementById('queue-handoff').innerText,
  rows: [...document.querySelectorAll('#queue-list .queue-row')].map(row => ({ id: row.dataset.queueItem, where: row.dataset.handoff || '', status: row.querySelector('.queue-status').textContent,
    text: row.querySelector('.queue-text').innerText, why: row.querySelector('.queue-handoff-why')?.textContent || '', buttons: [...row.querySelectorAll('.queue-actions button')].map(control => control.textContent) })),
  opener: document.getElementById('room-queue').textContent,
  wide: document.getElementById('queue-dialog').scrollWidth > document.getElementById('queue-dialog').clientWidth,
}));
async function seen(check, label, limit = 60000) {
  let last;
  try { await until(async () => { last = await read(); return check(last); }, label, limit); }
  catch (error) { throw Error(`${label}: ${JSON.stringify(last)}`, { cause: error }); }
  return last;
}
const rowOf = (view, task) => { const found = view.rows.filter(row => row.text.includes(task)); assert.equal(found.length, 1, `One row for ${task}: ${JSON.stringify(view.rows)}`); return found[0]; };
const where = view => view.rows.map(row => row.where);
// When the panel opens, what waits for the person and what a waiting handoff is about come before every other row.
function frontFirst(view, label) {
  const front = view.rows.map(row => ['held', 'returned', 'asking', 'stalled'].includes(row.where));
  assert.ok(!front.some((flag, index) => flag && front.slice(0, index).includes(false)), `${label}: ${JSON.stringify(where(view))}`);
}
// The project folder as its line shows it: the last two parts; the whole path is the line's title.
const shortPath = folder => { const parts = folder.split('/').filter(Boolean); return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : folder; };
async function openPanel() {
  await page.locator('#room-queue').click();
  await page.locator('#queue-dialog[open]').waitFor();
}
async function closePanel() {
  if (await page.locator('#queue-dialog[open]').count()) await page.locator('#close-queue').click();
  await page.locator('#queue-dialog[open]').waitFor({ state: 'detached' }).catch(() => {});
}
// The folder the system's dialog will answer with; null closes the dialog without a choice.
const pick = folder => app.evaluate(({ dialog }, chosen) => {
  globalThis.handoffPanelDialogs = globalThis.handoffPanelDialogs || [];
  dialog.showOpenDialog = async (_window, options) => { globalThis.handoffPanelDialogs.push(options); return chosen === null ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [chosen] }; };
}, folder);

async function run() {
  console.log('Fixture profile:', profile);
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Daemon');
  client = await connect(profile, 'handoff-panel-test');
  await launch();
  const size = /^(\d+)x(\d+)$/.exec(process.env.NAW_TEST_WINDOW_SIZE || '');
  if (size) await app.evaluate(({ BrowserWindow }, [width, height]) => { for (const win of BrowserWindow.getAllWindows()) win.setContentSize(width, height); }, [Number(size[1]), Number(size[2])]);
  await revealDefaultSpace(page);
  const members = [];
  for (const name of NAMES.slice(0, 3)) members.push(await createSession(name, true));
  const integrator = await createSession(NAMES[3], false);
  // "main" lives in a real repository of its own, beside this run's session folders. Git runs only there.
  const folder = integrator.cwd;
  assert.equal(path.dirname(folder), path.resolve(profile) + '-sessions', 'The integrator works in this run\'s own temporary folder');
  assert.ok(fs.statSync(folder).isDirectory() && !fs.existsSync(path.join(folder, '.git')));
  const repo = path.join(path.dirname(folder), 'synthetic-main-repository');
  fs.mkdirSync(repo);
  const gitEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/.test(name))), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Synthetic fixture', '-c', 'user.email=fixture@example.com', ...args],
    { cwd: repo, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const commit = (file, text) => { fs.writeFileSync(path.join(repo, file), text); git('add', '--', file); git('commit', '--quiet', '-m', `Synthetic ${file}`); return git('rev-parse', 'HEAD'); };
  git('init', '--quiet', '--initial-branch=main');
  commit('synthetic-base.txt', 'base\n');
  const deliveries = [];
  for (const letter of ['a', 'b', 'c', 'd', 'e']) { git('checkout', '--quiet', '-b', `lane/${letter}`, 'main'); deliveries.push(commit(`synthetic-${letter}.txt`, `${letter}\n`)); }
  git('checkout', '--quiet', 'main');
  commit('synthetic-other.txt', 'main moved on\n');
  const main = fs.realpathSync(repo);
  const handoffs = async () => (await sends()).filter(send => send.text.startsWith('【NAW 集成交接】'));
  const sentTo = async id => (await sends()).filter(send => send.id === id);

  // 1) Three members deliver; nobody is designated. Each task's own row says so, and the block on top says what to do.
  await page.locator('#room-nav').click();
  for (const [index, member] of members.entries()) await page.evaluate(([text, id]) => workspace.spaceAction('shared', 'queueAdd', [text, id]), [TASKS[index], member.id]);
  for (const [index, member] of members.entries()) {
    await until(async () => (await sentTo(member.id)).length === 1, `Task ${index} sent`);
    await release(member.id, `做完了。\nREADY lane/${'abc'[index]} ${deliveries[index]}`);
  }
  await until(async () => (await overview()).summary.deliverable === 3, 'Three deliveries wait');
  await openPanel();
  const nobody = await seen(view => view.rows.filter(row => row.where === 'queuedNone').length === 3, 'Three delivered rows wait for an integrator');
  assert.ok(nobody.block.includes(say('queue.handoff.none')) && nobody.block.includes(say('queue.handoff.noneCount', { n: 3 })), nobody.block);
  for (const [index, task] of TASKS.slice(0, 3).entries()) assert.equal(rowOf(nobody, task).status, say('queue.handoff.row.queuedNone', { name: NAMES[index] }));
  frontFirst(nobody, 'Nobody designated');
  assert.deepEqual([nobody.opener, nobody.wide, nobody.rows.flatMap(row => row.buttons)], [say('queue.title'), false, []], 'Nothing here waits for a step in this panel');
  await shot('nobody-designated');
  await closePanel();
  passed.push('With nobody designated each delivered task says so on its own row, and the panel says how to designate');

  // 2) The person designates the integrator from that session's own menu. No main repository is chosen yet: the panel says so, and counts it.
  await page.locator(`.session-link[data-session-id="${integrator.id}"]`).click();
  await page.locator('#session-header-more').click();
  await page.getByRole('menuitem', { name: '设为集成者（把交上来的活合进主线）', exact: true }).click();
  await until(async () => (await snapshot()).integrator?.sessionId === integrator.id, 'The integrator is designated');
  await page.locator('#room-nav').click();
  await openPanel();
  const paused = await seen(view => view.rows.filter(row => row.where === 'queuedStopped').length === 3 && view.opener === say('queue.titleNeed', { n: 1 }), 'Without a main repository the rows say handoffs are paused');
  assert.ok(paused.block.includes(say('queue.handoff.integrator', { name: NAMES[3] })) && paused.block.includes(say('queue.handoff.repositoryNone', { who: NAMES[3] })), paused.block);
  assert.equal((await handoffs()).length, 0);
  await shot('no-main-repository');
  // Closing the system's dialog changes nothing; a folder that is no repository is refused in words and not recorded.
  const choose = page.locator('#queue-handoff button[data-handoff-action="repository"]');
  assert.equal(await choose.textContent(), say('queue.handoff.repositoryChoose'));
  await pick(null);
  await choose.click();
  await until(async () => (await app.evaluate(() => globalThis.handoffPanelDialogs.length)) === 1, 'The system dialog was asked once');
  assert.deepEqual(await app.evaluate(() => globalThis.handoffPanelDialogs[0]), { title: say('os.chooseRepository'), properties: ['openDirectory'] });
  await pick(fs.realpathSync(folder));
  await choose.click();
  // The refusal is read inside the panel, where the person is looking: what to do first, the cause under it. It goes away with the next step.
  await page.locator('#queue-handoff-error').filter({ hasText: say('error.handoff.repositoryUnsafe') }).filter({ hasText: say('queue.handoff.repositoryRefused') }).waitFor();
  assert.equal(await page.locator('#toast').isHidden(), true, 'Nothing is said behind the panel');
  await shot('a-folder-that-is-no-repository');
  assert.deepEqual(await page.evaluate(() => workspace.handoff('repository')), { root: null, problem: null });
  // The repository itself: one handoff carries all three, and every row says who has it.
  await pick(main);
  await choose.click();
  await until(async () => (await handoffs()).length === 1, 'The first handoff is sent', 90000);
  assert.equal(await page.locator('#queue-handoff-error').isHidden(), true, 'The refusal went away with the step that worked');
  const handed = await seen(view => view.rows.filter(row => row.where === 'handed').length === 3 && view.opener === say('queue.title'), 'Three rows say the integrator has them');
  assert.ok(handed.block.includes(say('queue.handoff.sent', { n: 3, who: NAMES[3] })) && handed.block.includes(say('queue.handoff.repository', { root: shortPath(main) })), handed.block);
  assert.equal(await page.locator('#queue-handoff .queue-handoff-path').getAttribute('title'), main, 'The whole path is there to read');
  assert.equal(await choose.textContent(), say('queue.handoff.repositoryChange'));
  for (const [index, task] of TASKS.slice(0, 3).entries()) assert.equal(rowOf(handed, task).status, say('queue.handoff.row.handed', { who: NAMES[3], name: NAMES[index] }));
  await shot('handed-out');
  await closePanel();
  passed.push('The integrator is designated from its menu; the missing main repository is said, counted and chosen in the panel (a wrong folder is refused in words); then every row says the integrator has it');

  // 3) The integrator merges one for real, claims another without merging it, and returns the third.
  git('cherry-pick', deliveries[0]);
  const head = git('rev-parse', 'HEAD');
  const note = '和 main 上的改动对不上，基于新的 main 重做';
  await release(integrator.id, `MERGED ${deliveries[0].slice(0, 9)} as ${head.slice(0, 9)} tests 12/12\nMERGED ${deliveries[1].slice(0, 9)} as ${head.slice(0, 9)} tests 12/12\nRETURNED ${deliveries[2].slice(0, 9)} ${note}`);
  await until(async () => { const now = await overview(); return now.summary.held === 1 && now.summary.handoff === null; }, 'Settled: one merged, one on hold, one returned', 90000);
  // The button that opens the panel says how many things wait for the person, before it is opened.
  await seen(view => view.opener === say('queue.titleNeed', { n: 2 }), 'The opener says two things wait');
  await shot('the-button-says-how-many');
  await openPanel();
  const settled = await seen(view => where(view).join() === 'held,returned,merged', 'What waits for the person comes first');
  frontFirst(settled, 'Settled');
  const held = rowOf(settled, TASKS[1]), returned = rowOf(settled, TASKS[2]);
  assert.deepEqual([held.status, held.why, held.buttons], [say('queue.handoff.row.held', { name: NAMES[1] }), say('queue.handoff.why.unverified'), [say('queue.handoff.send', { who: NAMES[3] })]]);
  assert.deepEqual([returned.status, returned.why, returned.buttons], [say('queue.handoff.row.returned', { name: NAMES[2] }), say('queue.handoff.why.returned', { note }), [say('queue.handoff.redo', { name: NAMES[2] })]]);
  assert.deepEqual([rowOf(settled, TASKS[0]).status, rowOf(settled, TASKS[0]).buttons, settled.wide], [say('queue.handoff.row.merged', { name: NAMES[0] }), [], false]);
  await shot('settled');
  await closePanel();
  passed.push('After the answer: the claimed merge that git does not show is on hold with its cause, the returned one shows the integrator\'s reason, both come first, and the opener counts two');

  // 4) A fourth delivery; the integrator asks the person to decide. The question is on top, with where to answer it.
  await page.evaluate(([text, id]) => workspace.spaceAction('shared', 'queueAdd', [text, id]), [TASKS[3], members[0].id]);
  await until(async () => (await sentTo(members[0].id)).length === 2, 'The fourth task is sent');
  await release(members[0].id, `做完了。\nREADY lane/d ${deliveries[3]}`);
  await until(async () => (await handoffs()).length === 2, 'The second handoff is sent', 90000);
  const question = 'lane/d 和 main 上的改动冲突，要我来解，还是退回给队员？';
  await release(integrator.id, `需要你决定：${question}`);
  await until(async () => Boolean((await overview()).waiting), 'The handoff waits for the person', 90000);
  await openPanel();
  const asked = await seen(view => view.block.includes(question) && rowOf(view, TASKS[3]).where === 'asking', 'The question is on top');
  frontFirst(asked, 'Asked');
  assert.deepEqual(where(asked).slice(0, 3).sort(), ['asking', 'held', 'returned'], 'The row the question is about comes first too');
  for (const sentence of [say('queue.handoff.ask.asks', { name: NAMES[3] }), say('queue.handoff.guide.asks', { name: NAMES[3] }), say('queue.handoff.after.asks', { name: NAMES[3] }),
    say('queue.handoff.about', { list: say('queue.handoff.aboutItem', { text: TASKS[3], member: NAMES[0] }) })]) assert.ok(asked.block.includes(sentence), sentence);
  assert.deepEqual([rowOf(asked, TASKS[3]).status, asked.opener], [say('queue.handoff.row.asking', { who: NAMES[3], name: NAMES[0] }), say('queue.titleNeed', { n: 3 })]);
  const buttons = await page.locator('#queue-handoff .queue-handoff-buttons button').evaluateAll(nodes => nodes.map(node => [node.dataset.handoffAction, node.textContent, node.disabled]));
  assert.deepEqual(buttons, [['open', say('queue.handoff.open', { name: NAMES[3] }), false], ['again', say('queue.handoff.again.asks'), false], ['keep', say('queue.handoff.keep'), false]]);
  await shot('the-integrator-asks');
  // With the panel open the person presses the button on each of the two rows. Each row changes where it is; nothing moves.
  const before = asked.rows.map(row => row.id);
  await page.locator(`#queue-list .queue-row[data-handoff="held"] button[data-handoff-action="send"]`).click();
  await seen(view => rowOf(view, TASKS[1]).where === 'queuedAsk', 'The delivery sent again waits behind the question');
  await page.locator(`#queue-list .queue-row[data-handoff="returned"] button[data-handoff-action="redo"]`).click();
  await until(async () => (await sentTo(members[2].id)).length === 2, 'The returned task went back to the member who did it', 60000);
  const acted = await seen(view => view.rows.some(row => row.where === 'redone') && view.rows.length === before.length + 1, 'The returned row says it was given back, and its new task is listed');
  assert.deepEqual(acted.rows.map(row => row.id).slice(0, before.length), before, 'No row changed place while the panel was open');
  assert.deepEqual([rowOf(acted, TASKS[1]).status, rowOf(acted, TASKS[1]).buttons], [say('queue.handoff.row.queuedAsk', { who: NAMES[3], name: NAMES[1] }), []]);
  const again = acted.rows.at(-1), redo = (await sentTo(members[2].id))[1];
  assert.ok(again.text.includes(say('queue.redo.text', { text: TASKS[2], branch: 'lane/c', note })) && redo.text.includes(say('queue.redo.text', { text: TASKS[2], branch: 'lane/c', note })), again.text);
  assert.deepEqual([acted.rows.filter(row => row.where === 'redone').map(row => [row.status, row.buttons]), acted.opener], [[[say('queue.handoff.row.redone', { name: NAMES[2] }), []]], say('queue.titleNeed', { n: 1 })]);
  await shot('after-send-again-and-give-back');
  // "Open its session" closes the panel and shows the integrator's session, where the person answers.
  await page.locator('#queue-handoff button[data-handoff-action="open"]').click();
  await page.locator('#queue-dialog[open]').waitFor({ state: 'detached' });
  await until(async () => (await snapshot()).viewState?.selected === integrator.id, 'The integrator\'s session is shown');
  await shot('opened-the-integrators-session');
  await page.locator('#room-nav').click();
  passed.push('The integrator\'s question is on top with where to answer; "send again" and "give back" act on their rows in place and the task goes back to its member once; the link opens the integrator\'s session');

  // 5) "Hold for now": the delivery it asked about stays on hold, and the one that waited goes out by itself.
  await openPanel();
  const reopened = await seen(view => view.block.includes(question), 'The question is still there');
  frontFirst(reopened, 'Opened again');
  assert.equal(reopened.rows[0].text.includes(TASKS[3]), true, 'The row the question is about is the first row');
  const places = reopened.rows.map(row => row.id);
  await page.locator('#queue-handoff button[data-handoff-action="keep"]').click();
  await until(async () => (await handoffs()).length === 3, 'The third handoff is sent', 90000);
  const third = (await handoffs())[2];
  assert.ok(third.text.includes(deliveries[1]) && !third.text.includes(deliveries[3]), 'Only the delivery that waited behind the question goes out');
  const kept = await seen(view => rowOf(view, TASKS[3]).where === 'held' && rowOf(view, TASKS[1]).where === 'handed' && !view.block.includes(question), 'The held delivery and the handed one');
  assert.deepEqual([rowOf(kept, TASKS[3]).why, rowOf(kept, TASKS[3]).buttons, kept.opener], [say('queue.handoff.why.conflict', { who: NAMES[3] }), [say('queue.handoff.send', { who: NAMES[3] })], say('queue.titleNeed', { n: 1 })]);
  assert.deepEqual(kept.rows.map(row => row.id), places, 'The row that now waits for the person stays where it was while the panel is open');
  await shot('held-for-now');
  // It merges that one for real. The person sends the held one again; the integrator asks once more.
  git('cherry-pick', deliveries[1]);
  const second = git('rev-parse', 'HEAD');
  await release(integrator.id, `MERGED ${deliveries[1].slice(0, 9)} as ${second.slice(0, 9)} tests 12/12`);
  await seen(view => rowOf(view, TASKS[1]).where === 'merged', 'The second delivery is merged', 90000);
  await page.locator(`#queue-list .queue-row[data-handoff="held"] button[data-handoff-action="send"]`).click();
  await until(async () => (await handoffs()).length === 4, 'The fourth handoff is sent', 90000);
  await release(integrator.id, `需要你决定：${question}`);
  await seen(view => view.block.includes(question) && rowOf(view, TASKS[3]).where === 'asking', 'It asks again', 90000);
  // The person has told it to return the delivery, and presses "Done, send again": it reports the return.
  await page.locator('#queue-handoff button[data-handoff-action="again"]').click();
  await until(async () => (await handoffs()).length === 5, 'The fifth handoff is sent', 90000);
  const note2 = '按你说的退回：和 main 冲突，请基于新的 main 重做';
  await release(integrator.id, `RETURNED ${deliveries[3].slice(0, 9)} ${note2}`);
  const last = await seen(view => rowOf(view, TASKS[3]).where === 'returned', 'The fourth delivery is returned', 90000);
  assert.deepEqual([rowOf(last, TASKS[3]).why, rowOf(last, TASKS[3]).buttons, last.wide], [say('queue.handoff.why.returned', { note: note2 }), [say('queue.handoff.redo', { name: NAMES[0] })], false]);
  assert.ok(!last.block.includes(question) && last.block.includes(say('queue.handoff.integrator', { name: NAMES[3] })), last.block);
  await shot('held-sent-again-asked-again-and-returned');
  await closePanel();
  // Opened once more: the row that waits for the person is the first one, as the opener's count leads the person to expect.
  await openPanel();
  const final = await seen(view => view.rows.length > 0 && view.rows[0].where === 'returned', 'The returned row comes first when the panel opens again');
  frontFirst(final, 'At the end');
  assert.deepEqual([final.rows[0].text.includes(TASKS[3]), final.opener], [true, say('queue.titleNeed', { n: 1 })]);
  await closePanel();
  passed.push('"Hold for now" keeps the asked-about delivery on hold and lets the waiting one go out; sent again and asked again, "Done, send again" hands it over once more and the return shows on its row');

  // 6) A fifth delivery is with the integrator when the person puts the integrator's session into this space. From then on
  //    nothing it writes is read as the handoff's answer: the handoff waits, and the panel says why and what to do.
  await page.evaluate(([text, id]) => workspace.spaceAction('shared', 'queueAdd', [text, id]), [TASKS[4], members[1].id]);
  await until(async () => (await sentTo(members[1].id)).length === 2, 'The fifth task is sent');
  await release(members[1].id, `做完了。\nREADY lane/e ${deliveries[4]}`);
  await until(async () => (await handoffs()).length === 6, 'The sixth handoff is sent', 90000);
  await page.locator(`.session-link[data-session-id="${integrator.id}"]`).click();
  await joinSpace(page);
  await page.locator('#room-nav').click();
  await until(async () => (await overview()).waiting?.reason === 'integrator-in-space', 'The handoff waits because its integrator sits in a space', 90000);
  // The space's shared record says that its queue leaves that member alone while the handoff waits.
  await until(async () => (await spaceEvents()).includes(say('notice.handoff.holder.waiting', { name: NAMES[3] })), 'The space is told that the queue leaves the integrator alone');
  // It answers all the same, with words that would be a question to the person. They are not taken for one.
  await release(integrator.id, '需要你决定：这句是写给空间里别人的');
  await delay(4000);
  await openPanel();
  const inSpace = await seen(view => view.block.includes(say('queue.handoff.ask.inSpace', { name: NAMES[3] })) && rowOf(view, TASKS[4]).where === 'stalled', 'The panel says that the integrator is in a space');
  for (const sentence of [say('queue.handoff.guide.inSpace', { name: NAMES[3] }), say('queue.handoff.after.inSpace', { name: NAMES[3] })]) assert.ok(inSpace.block.includes(sentence), sentence);
  assert.ok(!inSpace.block.includes('这句是写给空间里别人的') && !inSpace.block.includes(say('queue.handoff.stopped.inSpace')), inSpace.block);
  frontFirst(inSpace, 'Integrator in a space');
  assert.deepEqual(await page.locator('#queue-handoff .queue-handoff-buttons button').evaluateAll(nodes => nodes.map(node => [node.dataset.handoffAction, node.textContent])),
    [['open', say('queue.handoff.open', { name: NAMES[3] })], ['again', say('queue.handoff.again.inSpace')], ['keep', say('queue.handoff.keep')]]);
  assert.equal((await overview()).waiting.question, '');
  await shot('the-integrator-is-in-a-space');
  await closePanel();
  // The person moves it out again and says so in the panel: the delivery goes out once more, and this time the answer counts.
  await page.locator(`.session-link[data-session-id="${integrator.id}"]`).click();
  await leaveSpace(page);
  await page.locator('#room-nav').click();
  await openPanel();
  await seen(view => view.block.includes(say('queue.handoff.ask.inSpace', { name: NAMES[3] })), 'The handoff still waits for the person\'s word');
  await page.locator('#queue-handoff button[data-handoff-action="again"]').click();
  await until(async () => (await handoffs()).length === 7, 'The seventh handoff is sent', 90000);
  // The space is told once that the handoff it was told about is over.
  await until(async () => (await spaceEvents()).includes(say('notice.handoff.holder.closed', { name: NAMES[3] })), 'The space is told that the handoff is over');
  assert.equal((await spaceEvents()).filter(text => text === say('notice.handoff.holder.waiting', { name: NAMES[3] }) || text === say('notice.handoff.holder.closed', { name: NAMES[3] })).length, 2);
  git('cherry-pick', deliveries[4]);
  const fifth = git('rev-parse', 'HEAD');
  await release(integrator.id, `MERGED ${deliveries[4].slice(0, 9)} as ${fifth.slice(0, 9)} tests 12/12`);
  const out = await seen(view => rowOf(view, TASKS[4]).where === 'merged', 'Moved out and sent again, the delivery is merged', 90000);
  assert.ok(!out.block.includes(say('queue.handoff.ask.inSpace', { name: NAMES[3] })), out.block);
  await shot('moved-out-and-sent-again');
  await closePanel();
  passed.push('With the integrator inside the space its words are not read as an answer: the panel says why, and after it is moved out "Moved out, send again" hands the delivery over again and the merge counts');

  assert.equal(fs.existsSync(path.join(folder, '.git')), false, 'The integrator\'s own session folder never held a repository');
  assert.deepEqual(errors, []);
  assert.equal(app.windows().length, 1);
  const all = await sends();
  assert.equal(all.filter(send => send.id === members[2].id).length, 2, 'The returned task was given back once');
  console.log(JSON.stringify({ passed, errors, handoffs: (await handoffs()).length, syntheticDispatches: all.length, pictures: shots, nativeProviderProcesses: 0, nativeModelCalls: 0 }));
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
