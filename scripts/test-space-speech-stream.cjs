// The space's 「对话」 view: hidden Electron, disposable profile, synthetic providers and synthetic messages only.
// No provider processes or model calls. NAW_EVIDENCE_DIR (private) and NAW_PICTURES_DIR are required.
const scratch = require('./fixtures/test-scratch.cjs');
const { revealDefaultSpace } = require('./fixtures/default-space.cjs');
const { LONG } = require('./fixtures/speech-stream-text.cjs');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { _electron } = scratch.playwright(require('playwright'));
const { connectService } = require('../app/service-connection.cjs');
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const output = process.env.NAW_EVIDENCE_DIR, pictures = process.env.NAW_PICTURES_DIR;
if (!output || !path.isAbsolute(output) || output.startsWith(root + path.sep)) throw Error('Private evidence directory required');
if (!pictures || !path.isAbsolute(pictures)) throw Error('Picture directory required');
fs.mkdirSync(output, { recursive: true, mode: 0o700 }); fs.mkdirSync(pictures, { recursive: true, mode: 0o700 });
const slot = path.join(root, '.local/gui-test-slot.lock'), token = randomUUID();
fs.mkdirSync(path.dirname(slot), { recursive: true });
try { fs.mkdirSync(slot); } catch (e) { if (e.code !== 'EEXIST') throw e; console.error('GUI slot occupied'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ token, pid: process.pid, task: 'space speech stream hidden synthetic test' }));
let child, client, app, page, sequence = 0; const errors = [], checks = [];
const profile = fs.realpathSync(scratch.directory(path.join(os.tmpdir(), 'naw-speech-')));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { for (let i = 0; i < 200; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
const record = name => { checks.push(name); console.log('PASS', name); };
function fixture(method, value) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.off('message', cb); reject(Error('Fixture timeout: ' + method)); }, 10000);
    const cb = r => { if (r.requestId === id) { clearTimeout(timer); child.off('message', cb); r.error ? reject(Error(r.error)) : resolve(r); } };
    child.on('message', cb); child.send({ id, method, value });
  });
}
// What a sighted reader sees in each row: speaker, recipients and text.
const rows = () => page.locator('#speech-stream .speech-msg').evaluateAll(list => list.map(n =>
  [n.querySelector('.speech-from').textContent, n.querySelector('.speech-to').hidden ? '' : n.querySelector('.speech-to').textContent, n.querySelector('.speech-body').textContent].join(' | ')));
const listMetrics = () => page.locator('#speech-stream .speech-list').evaluate(n => ({ top: n.scrollTop, height: n.scrollHeight, client: n.clientHeight }));
async function main() {
  child = scratch.childProcess.fork(path.join(code, 'app/daemon.cjs'), [profile], {
    execArgv: ['--require', path.join(root, 'scripts/fixtures/speech-stream.cjs')],
    env: { ...process.env, NAW_TEST_APP_ROOT: code, NAW_WORKSPACE: profile, NAW_APP_VERSION: require(path.join(code, 'package.json')).version }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Service starts');
  client = await connectService(profile, 'human-view');
  const ids = {};
  for (const [key, name, provider] of [['butler', '大管家', 'claude'], ['pm', '项目经理', 'claude'], ['a', 'Claude A', 'claude'], ['b', 'Claude B', 'claude']]) {
    ids[key] = await client.call('create', { provider, cwd: profile, name, view: 'chat' });
    if (key !== 'butler') await client.call('join', ids[key], true);
  }
  const butler = (await client.call('initial')).sessions.find(s => s.id === ids.butler);
  fs.writeFileSync(path.join(profile, 'steward.json'), JSON.stringify({ version: 1, selected: { sessionId: butler.id, nativeId: butler.nativeId } }), { mode: 0o600 });
  await fixture('speechSeed', ids);
  fs.writeFileSync(path.join(profile, 'views.json'), JSON.stringify([{ owner: 'human-view', active: true, selected: 'room', mode: 'chat' }]), { mode: 0o600 });
  app = await _electron.launch({ executablePath: require('electron'), args: [code], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid), NAW_TEST_UI_LANGUAGE: 'zh' }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message));
  await revealDefaultSpace(page);
  const win = await app.browserWindow(page);
  const size = async (width, height = 820) => { await win.evaluate((w, [x, y]) => w.setContentSize(x, y), [width, height]); await delay(500); };
  async function shot(name) {
    const file = path.join(pictures, name + '.png');
    await page.screenshot({ path: file });
    const d = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
    assert.ok(d.scroll <= d.width, 'No horizontal page overflow: ' + name);
    console.log('SHOT', file);
  }
  await size(1280);
  if (!await page.locator('#room-conversation').isVisible()) await page.locator('#room-nav').click();
  await page.locator('#room-conversation').click();
  await page.locator('#speech-stream').waitFor();
  assert.equal(await page.locator('#room-conversation').getAttribute('aria-current'), 'page');
  const weight = id => page.locator(id).evaluate(n => Number(getComputedStyle(n).fontWeight));
  assert.ok(await weight('#room-conversation') > await weight('#room-overview'), 'Only the current tab looks selected');
  assert.ok(!await page.locator('#collaboration-overview').isVisible());
  assert.ok(await page.locator('#room-composer').isVisible());
  record('the 对话 tab opens the stream above the shared composer, in place of the member columns');
  const saved = () => { try { return JSON.parse(fs.readFileSync(path.join(profile, 'views.json'), 'utf8')).find(v => v.owner === 'human-view')?.roomViews?.shared?.roomSurface; } catch { return undefined; } };
  await until(() => saved() === 'conversation', 'The window saves the 对话 view');
  record('the window saves the 对话 view without an invalid-view error');

  const all = [
    '你 | 项目经理 | 把今天要做的三件事排一下。',
    '项目经理 |  | 排好了：1. 输入框修复（A）；2. 文档（B）；3. 安装检查（大管家）。',
    '项目经理 | Claude A | A，先修输入框，再补测试。',
    'NAW 派活 | Claude B | 【NAW 派活】写文档：对话视图的说明。',
    'Claude A |  | ' + LONG,
    'Claude B |  | 文档写好了，等审查。',
    '大管家 | Claude B | B，文档进度怎么样？',
    'Claude B |  | 一半了，今晚交。',
  ];
  await until(async () => (await rows()).length === all.length, 'Stream shows the seeded speech');
  assert.deepEqual(await rows(), all);
  record('butler, PM, A and B speech in order; no queue, pause, card, tool, thinking, recovery or timer rows');
  assert.deepEqual(await page.locator('#speech-stream .speech-name').allTextContents(), ['全部', '大管家', '项目经理', 'Claude A', 'Claude B']);
  assert.equal(await page.locator('#speech-stream .speech-name[aria-pressed="true"]').textContent(), '全部');
  record('names row: 全部, then the butler, then the members in space order');
  const labels = await page.locator('#speech-stream .speech-msg').evaluateAll(list => list.map(n =>
    n.getAttribute('aria-labelledby').split(' ').map(id => document.getElementById(id).textContent).join(' ')));
  assert.match(labels[2], /^项目经理 发给 Claude A \d\d:\d\d$/u);
  assert.match(labels[1], /^项目经理 \d\d:\d\d$/u);
  assert.equal(await page.locator('#speech-stream [aria-live]').count(), 0);
  assert.equal(await page.locator('#speech-stream .speech-list').getAttribute('aria-label'), '对话内容');
  record('each message is named by speaker, recipient and time; no live region per message');
  const long = page.locator('#speech-stream .speech-msg').nth(4);
  assert.equal(await long.locator('.speech-toggle').textContent(), '展开全文');
  assert.ok(await long.locator('.speech-body').evaluate(n => n.classList.contains('folded') && n.scrollHeight > n.clientHeight));
  record('a long message is folded');

  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const width of [1280, 850]) {
      await size(width);
      // The header's buttons stay whole and inside the window; 概览 and 对话 share one line.
      const tabs = await page.evaluate(() => {
        const shown = [...document.querySelectorAll('#room-tabs > button')].filter(n => !n.hidden && n.offsetWidth).map(n => n.getBoundingClientRect());
        const [overview, conversation] = ['room-overview', 'room-conversation'].map(id => document.getElementById(id).getBoundingClientRect());
        return { clipped: shown.filter(r => r.left < 0 || r.right > innerWidth || r.width < 8).length, sameLine: Math.abs(overview.top - conversation.top) < 2, gap: conversation.left - overview.right };
      });
      assert.equal(tabs.clipped, 0, `Header buttons fit at ${width}`); assert.ok(tabs.sameLine && tabs.gap >= 0, `概览 and 对话 share a line at ${width}`);
      await shot(`all-${scheme}-${width}`);
    }
  }
  record('at 1280 and 850, in light and dark, the header buttons fit and 概览/对话 share a line');
  await page.emulateMedia({ colorScheme: 'light' }); await size(1280);
  await long.locator('.speech-toggle').click();
  assert.equal(await long.locator('.speech-toggle').getAttribute('aria-expanded'), 'true');
  assert.ok(!await long.locator('.speech-body').evaluate(n => n.classList.contains('folded')));
  await long.scrollIntoViewIfNeeded(); await shot('expanded-light-1280');
  await long.locator('.speech-toggle').click();
  record('a long message expands and folds again');

  // Keyboard: arrows move along the names, Enter chooses.
  await page.locator('#speech-stream .speech-name[aria-pressed="true"]').focus();
  for (let n = 0; n < 3; n++) await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Claude A');
  await page.keyboard.press('Enter');
  await until(async () => (await rows()).length === 2, 'Filter to A');
  assert.deepEqual(await rows(), [all[2], all[4]]);
  assert.equal(await page.locator('#speech-stream .speech-name[aria-pressed="true"]').textContent(), 'Claude A');
  assert.deepEqual(await page.locator('#speech-stream .speech-name').evaluateAll(list => list.map(n => n.tabIndex)), [-1, -1, -1, 0, -1]);
  await page.keyboard.press('End'); assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Claude B');
  await page.keyboard.press('Home'); assert.equal(await page.evaluate(() => document.activeElement.textContent), '全部');
  record('keyboard moves through the names; choosing Claude A keeps only what A said and was sent');
  for (const scheme of ['light', 'dark']) { await page.emulateMedia({ colorScheme: scheme }); await shot(`member-${scheme}-1280`); }
  await page.emulateMedia({ colorScheme: 'light' }); await size(850); await shot('member-light-850'); await size(1280);
  await page.locator('#speech-stream .speech-name', { hasText: '全部' }).click();
  await until(async () => (await rows()).length === all.length, 'Back to everyone');

  // No 20-item cap; 50 at a time with earlier ones on request, keeping the reading place.
  await fixture('speechMany', { a: ids.a, count: 70 });
  await until(async () => (await rows()).length === 50, 'First page of 50');
  const earlier = page.locator('#speech-stream .speech-earlier');
  assert.ok(await earlier.isVisible());
  assert.equal(await earlier.textContent(), '显示更早的 28 条 · 共 78 条');
  record('78 messages: 50 first (no 20-item cap)');

  // Review round 1, finding 1: scrolled up with more than one page drawn, a new message must not push the message
  // being read out above, nor move it.
  const list = page.locator('#speech-stream .speech-list');
  await list.evaluate(n => { n.scrollTop = Math.floor((n.scrollHeight - n.clientHeight) / 2); n.dispatchEvent(new Event('scroll')); });
  await delay(100);
  const reading = await page.evaluate(() => {
    const list = document.querySelector('#speech-stream .speech-list'), top = list.getBoundingClientRect().top;
    const first = [...list.querySelectorAll('.speech-msg')].find(n => n.getBoundingClientRect().top >= top);
    return { id: first.dataset.speechId, offset: Math.round(first.getBoundingClientRect().top - top) };
  });
  await fixture('speechAdd', { pm: ids.pm, a: ids.a, text: '往上翻时的新消息' });
  await page.locator('#speech-stream .speech-new').waitFor();
  const moved = await page.evaluate(id => {
    const list = document.querySelector('#speech-stream .speech-list'), n = list.querySelector(`[data-speech-id="${CSS.escape(id)}"]`);
    return n ? Math.round(n.getBoundingClientRect().top - list.getBoundingClientRect().top) : null;
  }, reading.id);
  assert.equal(moved, reading.offset, 'The message being read stays where it was');
  assert.equal(await earlier.textContent(), '显示更早的 28 条 · 共 79 条');
  record('scrolled up past one page, a new message keeps the message being read in place');
  await page.locator('#speech-stream .speech-new').click();
  await earlier.click();
  await until(async () => (await rows()).length === 79, 'All 79 shown');
  assert.ok(!await earlier.isVisible());
  record('the earlier 28 on request');

  // Following the bottom, and holding the reading place when scrolled up.
  await list.evaluate(n => { n.scrollTop = n.scrollHeight; n.dispatchEvent(new Event('scroll')); });
  await fixture('speechAdd', { pm: ids.pm, a: ids.a, text: '第一条新消息' });
  await until(async () => (await rows()).at(-1)?.endsWith('第一条新消息'), 'New message appended');
  let m = await listMetrics();
  assert.ok(m.height - m.top - m.client < 4, 'At the bottom, the stream follows a new message');
  assert.ok(!await page.locator('#speech-stream .speech-new').isVisible());
  await list.evaluate(n => { n.scrollTop = 200; n.dispatchEvent(new Event('scroll')); });
  await delay(100);
  const held = (await listMetrics()).top;
  await fixture('speechAdd', { pm: ids.pm, a: ids.a, text: '第二条新消息' });
  await until(async () => (await rows()).at(-1)?.endsWith('第二条新消息'), 'Second message appended');
  await page.locator('#speech-stream .speech-new').waitFor();
  assert.equal(await page.locator('#speech-stream .speech-new').textContent(), '有 1 条新消息 ↓');
  assert.equal((await listMetrics()).top, held);
  record('scrolled up, a new message shows 「有 1 条新消息 ↓」 and the reading place stays');
  for (const scheme of ['light', 'dark']) { await page.emulateMedia({ colorScheme: scheme }); await shot(`new-${scheme}-1280`); }
  await page.emulateMedia({ colorScheme: 'light' });
  await page.locator('#speech-stream .speech-new').click();
  m = await listMetrics();
  assert.ok(m.height - m.top - m.client < 4);
  assert.ok(!await page.locator('#speech-stream .speech-new').isVisible());
  record('the new-message bar goes to the latest and disappears');

  // Each message opens its original.
  const answer = page.locator('#speech-stream .speech-msg', { hasText: '一半了，今晚交。' });
  await answer.scrollIntoViewIfNeeded(); await answer.hover();
  await answer.locator('.speech-original').click();
  await until(() => page.locator('#title').innerText().then(text => text.includes('Claude B')), 'Original session opens');
  await until(() => page.locator('#messages [data-message-id="b-answer"][data-search-target]').isVisible(), 'Exact original selected');
  record('a message opens its original in that member\'s session');

  await page.locator('#room-nav').click();
  await page.locator('#room-conversation').click();
  await fixture('speechClear');
  await until(() => page.locator('#speech-stream .speech-empty').isVisible(), 'Empty space');
  assert.equal(await page.locator('#speech-stream .speech-empty').textContent(), '这个空间里还没有人说过话。');
  for (const scheme of ['light', 'dark']) { await page.emulateMedia({ colorScheme: scheme }); await shot(`empty-${scheme}-1280`); }
  await page.emulateMedia({ colorScheme: 'light' }); await size(850); await shot('empty-light-850');
  record('an empty space says nobody has spoken yet');

  await page.locator('#room-overview').click();
  assert.ok(!await page.locator('#speech-stream').isVisible());
  assert.ok(await page.locator('#collaboration-overview').isVisible());
  assert.ok(await weight('#room-overview') > await weight('#room-conversation'), 'Only the current tab looks selected');
  record('the 概览 tab brings the member columns back');

  const stats = await fixture('stats'); assert.equal(stats.modelCalls, 0); assert.equal(stats.nativeProcesses, 0);
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ visible: w.isVisible(), focused: w.isFocused() })));
  assert.ok(windows.length && windows.every(w => !w.visible && !w.focused)); record('owned windows remain hidden and unfocused');
  assert.deepEqual(errors, []); record('zero renderer errors and model calls');
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ checks, pictures, stats, windows, errors }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, failed: 0, skipped: 0, pictures }));
}
main().catch(async e => { console.error(e.stack); process.exitCode = 1; if (page && !page.isClosed()) { await page.screenshot({ path: path.join(pictures, 'failure.png') }).catch(() => {}); fs.writeFileSync(path.join(output, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); } })
  .finally(scratch.cleanup(async () => {
    if (app) await app.close().catch(() => {});
    if (client) { await client.call('shutdown').catch(() => {}); client.close(); }
    if (child?.connected) child.disconnect();
    if (child?.exitCode === null) child.kill('SIGTERM');
    const owner = JSON.parse(fs.readFileSync(path.join(slot, 'owner.json')));
    if (owner.token === token) { fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot); }
  }));
