// Reading a space's 信息流 (R249; it replaced the 「对话」 view this script first covered): hidden Electron, disposable
// profile, synthetic providers and synthetic messages only.
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
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ token, pid: process.pid, task: 'space feed reading hidden synthetic test' }));
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
// What a sighted reader sees in each line: its kind, who to whom, and the line.
const rows = () => page.locator('#space-feed .feed-row').evaluateAll(list => list.map(n =>
  [n.dataset.kind, n.querySelector('.feed-who').textContent, n.querySelector('.feed-text').textContent].join(' | ')));
// The name Chromium's accessibility tree gives each line's summary, which a screen reader announces.
async function spokenNames() {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { root: doc } = await cdp.send('DOM.getDocument', { depth: 0 });
    const { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: doc.nodeId, selector: '#space-feed .feed-row summary' });
    const names = [];
    for (const nodeId of nodeIds) names.push((await cdp.send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false })).nodes[0]?.name?.value || '');
    return names;
  } finally { await cdp.detach(); }
}
const listMetrics = () => page.locator('#space-feed .feed-list').evaluate(n => ({ top: n.scrollTop, height: n.scrollHeight, client: n.clientHeight }));
const TABS = ['room-summary', 'room-stream', 'room-overview', 'room-member'];
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
  // The space's queue notices live in the window's room-state.json, read at launch; the service fixture cannot change them.
  const dispatched = { id: 'q-1', kind: 'queue', role: 'system', text: '', time: Date.now() - 25 * 60000, sessionId: ids.b, uiMessage: { key: 'notice.queue.dispatched', params: { text: '写文档', name: 'Claude B' } } };
  fs.writeFileSync(path.join(profile, 'room-state.json'), JSON.stringify({ version: 1, name: '共同工作', notes: '', revision: 1, events: [dispatched], queue: [] }), { mode: 0o600 });
  fs.writeFileSync(path.join(profile, 'views.json'), JSON.stringify([{ owner: 'human-view', active: true, selected: 'room', mode: 'chat' }]), { mode: 0o600 });
  app = await _electron.launch({ executablePath: require('electron'), args: [code], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid), NAW_TEST_UI_LANGUAGE: 'zh' }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message));
  await page.waitForSelector('#room-nav', { state: 'attached', timeout: 60000 });
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
  if (!await page.locator('#room-stream').isVisible()) await page.locator('#room-nav').click();
  await page.locator('#room-stream').click();
  await page.locator('#space-feed').waitFor();
  assert.equal(await page.locator('#room-stream').getAttribute('aria-current'), 'page');
  assert.ok(!await page.locator('#collaboration-overview').isVisible());
  assert.ok(await page.locator('#room-composer').isVisible());
  record('the 信息流 tab opens the feed above the shared composer, in place of the member columns');

  // Only what was said, newest first: no tool, commentary, recovery, timer or NAW dispatch input lines.
  await page.locator('#space-feed [data-group="say"]').click();
  const said = [
    'reply | Claude B | 一半了，今晚交。',
    'say | 大管家 → Claude B | B，文档进度怎么样？',
    'reply | Claude B | 文档写好了，等审查。',
    'reply | Claude A | ' + LONG.replace(/\s+/gu, ' ').trim(),
    'say | 项目经理 → Claude A | A，先修输入框，再补测试。',
    'reply | 项目经理 | 排好了：1. 输入框修复（A）；2. 文档（B）；3. 安装检查（大管家）。',
    'say | 你 → 项目经理 | 把今天要做的三件事排一下。',
  ];
  await until(async () => (await rows()).length === said.length, 'The feed shows the seeded speech: ' + (await rows()).join(' / '));
  assert.deepEqual(await rows(), said);
  const spoken = await spokenNames();
  assert.equal(spoken.length, said.length, JSON.stringify(spoken));
  said.forEach((line, i) => {
    const [, who, text] = line.split(' | ');
    // The shared disclosure CSS draws ▸/▾ as generated text, which Chromium puts in the name (record 11-26, side finding 6).
    assert.match(spoken[i], /^(?:[▸▾] )?\d\d:\d\d /u, spoken[i]);
    assert.ok(spoken[i].includes(who) && spoken[i].includes(text.slice(0, 12)), JSON.stringify({ spoken: spoken[i], who, text }));
  });
  console.log('NAMES', JSON.stringify(spoken.slice(0, 2)));
  record('each line is named by who spoke, to whom, and when');
  await page.locator('#space-feed [data-group="all"]').click();
  const everything = await rows();
  for (const text of ['npm test', '先看队列。', '先跑一遍测试。', '继续', 'wake', '【NAW 派活】写文档：对话视图的说明。']) assert.ok(!everything.some(r => r.endsWith('| ' + text)), 'Not a line: ' + text);
  assert.equal(everything.filter(r => r.startsWith('dispatch |') && r.includes('Claude B') && r.includes('写文档')).length, 1, 'The dispatch is one line of its own: ' + everything.join(' / '));
  record('butler, PM, A and B speech newest first; no tool, commentary, recovery, timer or dispatch-input lines');
  assert.deepEqual(await page.locator('#space-feed .feed-person').allTextContents(), ['你', '大管家', '项目经理', 'Claude A', 'Claude B']);
  assert.equal(await page.locator('#space-feed .feed-person[aria-pressed="true"]').count(), 0);
  assert.equal(await page.locator('#space-feed [aria-live]').count(), 0);
  assert.equal(await page.locator('#space-feed .feed-list').getAttribute('aria-label'), '信息流内容');
  record('names: you, the butler who spoke here, then the members in space order; no live region per line');
  const long = page.locator('#space-feed .feed-row[data-kind="reply"]', { hasText: '输入框修复已完成' });
  assert.ok(await long.locator('.feed-text').evaluate(n => n.scrollWidth > n.clientWidth), 'A long reply is one cut line');
  await long.locator('summary').click();
  assert.equal(await long.locator('.feed-body').textContent(), LONG);
  await long.scrollIntoViewIfNeeded(); await shot('expanded-light-1280');
  await long.locator('summary').click();
  record('a long reply is one line and opens in place to its whole text');

  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const width of [1280, 850]) {
      await size(width);
      // The four tabs stay whole, inside the window and on one line.
      const tabs = await page.evaluate(ids => {
        const boxes = ids.map(id => document.getElementById(id).getBoundingClientRect());
        return { clipped: boxes.filter(r => r.left < 0 || r.right > innerWidth || r.width < 8).length, line: Math.max(...boxes.map(r => r.top)) - Math.min(...boxes.map(r => r.top)) };
      }, TABS);
      assert.equal(tabs.clipped, 0, `Tabs fit at ${width}`); assert.ok(tabs.line < 2, `The tabs share a line at ${width}`);
      await shot(`all-${scheme}-${width}`);
    }
  }
  record('at 1280 and 850, in light and dark, the four tabs fit on one line');
  await page.emulateMedia({ colorScheme: 'light' }); await size(1280);

  await page.locator('#space-feed .feed-person', { hasText: 'Claude A' }).click();
  await page.locator('#space-feed [data-group="say"]').click();
  await until(async () => (await rows()).length === 2, 'Filter to A');
  assert.deepEqual(await rows(), [said[3], said[4]]);
  assert.equal(await page.locator('#space-feed .feed-person[aria-pressed="true"]').textContent(), 'Claude A');
  record('choosing Claude A keeps only what A said and what was sent to A');
  for (const scheme of ['light', 'dark']) { await page.emulateMedia({ colorScheme: scheme }); await shot(`member-${scheme}-1280`); }
  await page.emulateMedia({ colorScheme: 'light' }); await size(850); await shot('member-light-850'); await size(1280);
  await page.locator('#space-feed .feed-person', { hasText: 'Claude A' }).click();
  await page.locator('#space-feed [data-group="all"]').click();
  await until(async () => (await rows()).length === everything.length, 'Back to everyone');

  // No small cap; 50 at a time with earlier ones on request, keeping the reading place.
  await fixture('speechMany', { a: ids.a, count: 70 });
  const total = everything.length + 70, earlier = page.locator('#space-feed .disclosure-more');
  await until(async () => (await rows()).length === 50 && await earlier.isVisible(), 'First page of 50');
  assert.equal(await earlier.textContent(), `显示更早的 ${Math.min(50, total - 50)} 条 · 共 ${total} 条`);
  record(`${total} lines: 50 first`);

  // Scrolled down past newer lines, a new line at the top must not move the line being read.
  const list = page.locator('#space-feed .feed-list');
  await list.evaluate(n => { n.scrollTop = Math.floor((n.scrollHeight - n.clientHeight) / 2); n.dispatchEvent(new Event('scroll')); });
  await delay(100);
  const reading = await page.evaluate(() => {
    const list = document.querySelector('#space-feed .feed-list'), top = list.getBoundingClientRect().top;
    const first = [...list.querySelectorAll('.feed-row')].find(n => n.getBoundingClientRect().top >= top);
    return { id: first.dataset.feedId, offset: Math.round(first.getBoundingClientRect().top - top) };
  });
  await fixture('speechAdd', { pm: ids.pm, a: ids.a, text: '往下翻时的新消息' });
  await until(async () => (await rows())[0] === 'say | 项目经理 → Claude A | 往下翻时的新消息', 'New line on top');
  const moved = await page.evaluate(id => {
    const list = document.querySelector('#space-feed .feed-list'), n = list.querySelector(`[data-feed-id="${CSS.escape(id)}"]`);
    return n ? Math.round(n.getBoundingClientRect().top - list.getBoundingClientRect().top) : null;
  }, reading.id);
  assert.equal(moved, reading.offset, 'The line being read stays where it was');
  record('scrolled into the list, a new line keeps the line being read in place');
  await earlier.click();
  await until(async () => (await rows()).length === Math.min(100, total + 1), 'The next page');
  record('earlier lines on request');
  await list.evaluate(n => { n.scrollTop = 0; n.dispatchEvent(new Event('scroll')); });

  // A line opens its original.
  const answer = page.locator('#space-feed .feed-row', { hasText: '一半了，今晚交。' });
  await answer.scrollIntoViewIfNeeded(); await answer.locator('summary').click();
  await answer.locator('.feed-original').click();
  await until(() => page.locator('#title').innerText().then(text => text.includes('Claude B')), 'Original session opens');
  await until(() => page.locator('#messages [data-message-id="b-answer"][data-search-target]').isVisible(), 'Exact original selected');
  record('a line opens its original in that member\'s session');

  await page.locator('#room-nav').click();
  await page.locator('#space-summary').waitFor();
  await page.locator('#room-stream').click();
  await fixture('speechClear');
  // Only the window's own queue notice is left: 说的话 is empty, 全部 keeps that one line.
  await page.locator('#space-feed [data-group="all"]').click();
  await until(async () => (await rows()).length === 1, 'Only the dispatch is left: ' + (await rows()).join(' / '));
  assert.ok((await rows())[0].startsWith('dispatch |'));
  await page.locator('#space-feed [data-group="say"]').click();
  await until(() => page.locator('#space-feed .feed-empty').isVisible(), 'Nothing said');
  assert.equal(await page.locator('#space-feed .feed-empty').textContent(), '没有符合的记录。');
  for (const scheme of ['light', 'dark']) { await page.emulateMedia({ colorScheme: scheme }); await shot(`empty-${scheme}-1280`); }
  await page.emulateMedia({ colorScheme: 'light' }); await size(850); await shot('empty-light-850'); await size(1280);
  record('when everything said is gone, its lines leave the feed and 说的话 shows the empty line');

  await page.locator('#room-overview').click();
  assert.ok(!await page.locator('#space-feed').isVisible());
  assert.ok(await page.locator('#collaboration-overview').isVisible());
  record('the 网格 tab brings the member columns back');

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
