// Answering a 等你决定 queue row in place (prototype ②a→b→c, ③a), in the real hidden desktop, main-process
// dispatcher and workspace service, with the synthetic provider transport of scripts/fixtures/queue-native.cjs.
// No native process, no model. NAW_EVIDENCE_DIR: where the screenshots go.
const testScratch = require('./fixtures/test-scratch.cjs');
const { joinSpace } = require('./fixtures/space-membership.cjs');
const { createIn } = require('./fixtures/create-view.cjs');
const { revealDefaultSpace } = require('./fixtures/default-space.cjs');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { fork } = testScratch.childProcess, { _electron } = testScratch.playwright(require('playwright'));
const { connect } = require('../app/service-client.cjs');

const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
// The shared single-GUI slot (scripts/test-queue-dispatch.cjs).
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID();
let slotOwned = false;
try {
  fs.mkdirSync(slot);
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.error('GUI slot occupied; nothing started.');
  process.exit(75);
}
slotOwned = true;
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'queue-answer-test', task: 'answer a waiting queue row', token, pid: process.pid, time: new Date().toISOString() }));
function releaseSlot() {
  if (!slotOwned) return;
  try {
    if (JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'), 'utf8')).token === token) { fs.rmSync(slot, { recursive: true }); slotOwned = false; }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
process.once('exit', releaseSlot);
const profile = testScratch.directory(path.join(os.tmpdir(), 'naw-queue-answer-'));
const child = fork(path.join(code, 'app/daemon.cjs'), [profile], {
  execArgv: ['--require', path.join(__dirname, 'fixtures/queue-native.cjs')],
  env: { ...process.env, NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_WORKSPACE: profile, NAW_TEST_APP_ROOT: code },
  stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
});
let app, page, client, sequence = 0;
const errors = [], passed = [], delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, limit = 30000) {
  const started = Date.now();
  while (Date.now() - started < limit) { if (await check()) return; await delay(150); }
  throw Error(label);
}
function fixture(method, session = null, reply = '') {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.off('message', listener); reject(Error('Fixture timeout')); }, 5000);
    const listener = message => { if (message.requestId === id) { clearTimeout(timer); child.off('message', listener); resolve(message); } };
    child.on('message', listener);
    child.send({ id, method, session, reply });
  });
}
const sends = async () => (await fixture('stats')).sends;
const snapshot = () => page.evaluate(() => workspace.initial());
const item = async text => (await snapshot()).rooms.find(r => r.id === 'shared').queue.find(i => i.text === text);
async function capture(name) {
  if (!process.env.NAW_EVIDENCE_DIR) return;
  fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true });
  await page.locator('#queue-dialog').screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, name + '.png'), timeout: 5000 });
}
async function createSession(name) {
  await page.locator('#new-session').click();
  await page.locator('input[name="provider"][value="claude"]').check();
  await page.locator('#session-name').fill(name);
  await createIn(page, 'chat');
  await until(async () => (await snapshot()).sessions.some(s => s.name === name), 'Created ' + name);
  return (await snapshot()).sessions.find(s => s.name === name).id;
}
async function createMember(name) {
  const id = await createSession(name);
  await joinSpace(page);
  return id;
}
async function openQueue() {
  if (await page.locator('#queue-dialog').isVisible()) return;
  await page.locator('#room-nav').click();
  await page.locator('#room-record').click();
  await page.locator('#room-queue').click();
  await page.locator('#queue-dialog').waitFor();
}
async function waitingItem(text, member, reply) {
  await openQueue();
  const before = (await sends()).length;
  await page.locator('#queue-text').fill(text);
  await page.locator('#queue-assignee').selectOption(member);
  await page.locator('#add-queue').click();
  await until(async () => (await sends()).length === before + 1, 'Dispatched ' + text, 60000);
  assert.equal((await fixture('release', member, reply)).released, true);
  await until(async () => (await item(text))?.status === 'waiting', 'Waiting ' + text);
  return (await item(text)).id;
}
const row = id => page.locator(`#queue-dialog .queue-row[data-queue-item="${id}"]`);
const answer = id => row(id).locator('.queue-answer');
// What the person sees on the answer part of the row.
const shown = id => answer(id).evaluate(el => {
  const box = el.querySelector('textarea'), foot = el.querySelector('.queue-answer-foot');
  return { box: box && { value: box.value, readOnly: box.readOnly, label: box.getAttribute('aria-label') },
    why: foot && !foot.hidden ? foot.children[0].textContent : null, button: foot && !foot.hidden ? { text: foot.children[1].textContent, disabled: foot.children[1].disabled } : null,
    lines: [...el.querySelectorAll('.queue-answer-line')].filter(e => !e.hidden && e.textContent).map(e => e.textContent) };
});
// Nothing in the dialog reaches past its right edge or scrolls it sideways (scripts/test-queue-dispatch.cjs queueLayout).
const overflow = () => page.locator('#queue-dialog').evaluate(dialog => {
  const outer = dialog.getBoundingClientRect(), style = getComputedStyle(dialog);
  const right = outer.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight), past = [];
  for (const el of dialog.querySelectorAll('.queue-answer, .queue-answer *')) {
    const box = el.getBoundingClientRect();
    if ((box.width || box.height) && box.right - right > 1) past.push(el.className || el.tagName);
  }
  return { past, sideways: dialog.scrollWidth > dialog.clientWidth + 1, dark: document.body.hasAttribute('data-ds-dark-theme'), viewport: [innerWidth, innerHeight] };
});

async function run() {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Daemon');
  client = await connect(profile, 'queue-answer-test');
  app = await _electron.launch({ executablePath: require('electron'), args: [root], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid), NAW_TEST_QUEUE_HUMAN_QUIET_MS: '3000' }, timeout: 70000 });
  page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await page.locator('#new-session').waitFor({ timeout: 60000 });
  await revealDefaultSpace(page);
  const c = await createSession('旁人'), a = await createMember('队员甲'), b = await createMember('队员乙');

  // ②a: the box under the question, its first line quoting it; 「已处理」 stays.
  const first = await waitingItem('合并 r4', a, '需要你决定：两个提交改了同一处列缓存（提交 1 和 r4）。A：都合；B：只合提交 1。');
  let view = await shown(first);
  assert.equal(view.box.value, '关于「两个提交改了同一处列缓存」：\n');
  assert.equal(view.box.label, '回答 队员甲');
  assert.deepEqual(view.button, { text: '发给 队员甲', disabled: false });
  assert.equal(await row(first).getByRole('button', { name: '已处理', exact: true }).count(), 1);
  const text = '关于「两个提交改了同一处列缓存」：\n选 A，两个都合。';
  await answer(first).locator('textarea').fill(text);
  await capture('2a-before-send');
  passed.push('②a The waiting row has the answer box with the quote line; 已处理 stays');

  // ②b: the box locks; the receipt waits for native; the row still waits for the person.
  const sent = (await sends()).length;
  await fixture('hold-send', a);
  await answer(first).getByRole('button', { name: '发给 队员甲', exact: true }).click();
  await until(async () => (await shown(first)).lines.join() === '发给 队员甲 · 等待原生确认', 'Awaiting receipt');
  view = await shown(first);
  assert.deepEqual([view.box.readOnly, view.box.value, view.button], [true, text, null]);
  assert.equal((await item('合并 r4')).status, 'waiting');
  await capture('2b-awaiting-native');
  passed.push('②b After clicking: the text locks and the row shows 等待原生确认 while it still waits');

  // The person closes the queue and goes to 旁人, a session outside the space, before the receipt comes (F review Q1).
  await page.keyboard.press('Escape');
  await until(async () => !(await page.locator('#queue-dialog').evaluate(el => el.open)), 'Queue closed');
  await page.locator('#independent-nav').click();
  const outside = page.getByRole('menuitem');
  await outside.first().waitFor();
  assert.equal(await outside.count(), 1, 'only 旁人 is outside the space');
  assert.ok((await outside.textContent()).includes('旁人'));
  await outside.click();
  await until(async () => (await page.locator(`.session-link.active[data-session-id="${c}"]`).count()) === 1, 'Showing 旁人');

  // ②c: only native's receipt handles the row, with the answer stored on it; it was sent once.
  await fixture('release-send', a);
  await until(async () => (await item('合并 r4')).status === 'done', 'Handled after the receipt');
  passed.push('With the queue closed and 旁人 (outside the space) shown, the late receipt still handled the row');
  await openQueue();
  const done = await item('合并 r4');
  assert.equal(done.answer.text, text);
  assert.equal(done.answer.deliveredAt, done.finishedAt);
  assert.equal(done.finishedBy, undefined, 'handled as the person');
  assert.deepEqual((await sends()).slice(sent), [{ id: a, text }], 'the box text, once, to its member');
  await until(async () => (await answer(first).count()) === 1 && (await shown(first)).lines[0] === '发给 队员甲 · 原生已接收', 'Delivered row');
  assert.deepEqual((await shown(first)).lines, ['发给 队员甲 · 原生已接收', text]);
  assert.equal(await row(first).getByRole('button', { name: '已处理', exact: true }).count(), 0);
  await capture('2c-delivered');
  passed.push('②c 原生已接收 marked the row done; the answer and its receipt stay on the row; sent exactly once');

  // ③a: the member's session ended: only 「把这句话发给…」, opening the existing dialog with the text.
  const second = await waitingItem('发布 r5', b, '需要你决定：要不要现在发布 r5？');
  const words = '关于「要不要现在发布 r5」：\n先别发。';
  await answer(second).locator('textarea').fill(words);
  await client.call('stop', b);
  await until(async () => (await shown(second)).why === '队员乙 的会话已结束，发不出去', 'Ended member');
  view = await shown(second);
  assert.deepEqual([view.box.readOnly, view.box.value, view.button], [false, words, { text: '把这句话发给…', disabled: false }]);
  await capture('3a-session-ended');
  const before = (await sends()).length;
  await answer(second).getByRole('button', { name: '把这句话发给…', exact: true }).click();
  await page.locator('#send-dialog').waitFor();
  assert.equal(await page.locator('#send-text').inputValue(), words);
  assert.equal(await page.locator('#send-list input[name="send-target"]:checked').count(), 0, 'no session chosen for the person');
  await page.keyboard.press('Escape');
  await until(async () => !(await page.locator('#send-dialog').evaluate(el => el.open)), 'Send dialog closed');
  assert.equal((await sends()).length, before, 'nothing sent to it or a successor');
  assert.equal((await item('发布 r5')).status, 'waiting');
  passed.push('③a Ended member: the box stays editable, the reason shows, and 把这句话发给… opens the send dialog with the text; nothing sent');

  // Dark theme and the narrowest window the app allows (the prototype checked neither).
  await openQueue();
  await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'dark'; });
  await page.emulateMedia({ colorScheme: 'dark' });
  await until(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme')), 'Dark theme');
  let layout = await overflow();
  assert.deepEqual([layout.past, layout.sideways], [[], false], 'dark: nothing past the dialog edge');
  await capture('dark');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(850, 600));
  await until(() => page.evaluate(() => innerWidth === 850 && innerHeight === 600), 'Narrow window');
  await delay(300);
  layout = await overflow();
  assert.deepEqual([layout.past, layout.sideways], [[], false], 'narrow: nothing past the dialog edge');
  await capture('dark-narrow');
  await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'light'; });
  await page.emulateMedia({ colorScheme: 'light' });
  await until(() => page.evaluate(() => !document.body.hasAttribute('data-ds-dark-theme')), 'Light theme');
  layout = await overflow();
  assert.deepEqual([layout.past, layout.sideways], [[], false], 'light narrow: nothing past the dialog edge');
  await capture('light-narrow');
  passed.push('Dark theme and an 850×600 window: nothing in the answer rows passes the dialog edge');

  assert.deepEqual(errors, []);
  assert.equal(app.windows().length, 1);
  console.log(JSON.stringify({ passed, errors, syntheticSends: (await sends()).length, nativeProviderProcesses: 0, nativeModelCalls: 0, oneWindow: true }));
}

run().catch(async error => {
  console.error(error.stack);
  if (page) await capture('failed').catch(failure => console.error('Screenshot:', failure.message));
  process.exitCode = 1;
}).finally(testScratch.cleanup(async () => {
  if (app) await app.close();
  if (client) {
    const state = await client.call('initial');
    for (const session of state.sessions) if (session.state !== 'ended') await client.call('stop', session.id);
    await client.call('shutdown');
    client.close();
  }
  if (child.connected) child.disconnect();
  releaseSlot();
}));
