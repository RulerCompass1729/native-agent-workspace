// R247–R249: a space's left list, four fixed tabs, 总览 and 信息流. Hidden Electron, disposable profile,
// synthetic providers and synthetic messages only; no provider processes or model calls.
// NAW_EVIDENCE_DIR (private, outside the repository) and NAW_PICTURES_DIR are required.
const scratch = require('./fixtures/test-scratch.cjs');
const { revealDefaultSpace } = require('./fixtures/default-space.cjs');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { _electron } = scratch.playwright(require('playwright'));
const { connectService } = require('../app/service-connection.cjs');
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const output = process.env.NAW_EVIDENCE_DIR, pictures = process.env.NAW_PICTURES_DIR;
if (!output || !path.isAbsolute(output) || output.startsWith(root + path.sep)) throw Error('Private evidence directory required');
if (!pictures || !path.isAbsolute(pictures)) throw Error('Picture directory required');
fs.mkdirSync(output, { recursive: true, mode: 0o700 }); fs.mkdirSync(pictures, { recursive: true, mode: 0o700 });
// One GUI slot for every checkout: the main checkout's .local, also from a lane worktree.
const common = path.resolve(root, execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim());
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID();
fs.mkdirSync(path.dirname(slot), { recursive: true });
try { fs.mkdirSync(slot); } catch (e) { if (e.code !== 'EEXIST') throw e; console.error('GUI slot occupied'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ token, pid: process.pid, task: 'space feed hidden synthetic test' }));
let child, client, app, page, sequence = 0; const errors = [], checks = [];
const profile = fs.realpathSync(scratch.directory(path.join(os.tmpdir(), 'naw-space-feed-')));
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
// The default space's queue and events live in the app's space records (room-state.json), read at launch.
function spaceRecords({ pm, a, b }) {
  const now = Date.now(), at = minutes => now - minutes * 60000;
  const notice = (id, time, key, params, extra) => ({ id, kind: 'queue', role: 'system', text: '', time, uiMessage: { key, params }, ...extra });
  const item = (n, text, status, extra) => ({ id: `aa11bb22-0000-4000-8000-00000000000${n}`, text, status, assignee: null, createdAt: at(50 - n), ...extra });
  const queue = [
    item(1, '【NAW 派活】修输入框：中文输入时光标跳到行尾。', 'done', { sentTo: a, sentAt: at(48), finishedAt: at(20), ready: { branch: 'lane/input-fix', commit: 'abc1234def' } }),
    item(2, '【NAW 派活】图标风格定一下', 'waiting', { sentTo: b, sentAt: at(39), reply: '需要你决定：线框还是实心？推荐线框，因为和现有侧栏一致。' }),
    // Held for the busy PM, so no idle member takes it mid-test (review 1: Claude A did once).
    item(3, '设置页文案', 'queued', { assignee: pm }),
    item(4, '【NAW 派活】写文档：信息流的说明。', 'sent', { sentTo: pm, sentAt: at(7), tag: 'tag-pm-doc' }),
  ];
  const [one, two, , four] = queue.map(q => q.id);
  const events = [
    notice('q-d1', at(48), 'notice.queue.dispatched', { text: queue[0].text, name: 'Claude A' }, { sessionId: a, itemId: one }),
    notice('q-r1', at(20), 'notice.queue.ready', { text: '修输入框', name: 'Claude A', branch: 'lane/input-fix', commit: 'abc1234def' }, { sessionId: a, itemId: one }),
    notice('q-d2', at(39), 'notice.queue.dispatched', { text: queue[1].text, name: 'Claude B' }, { sessionId: b, itemId: two }),
    notice('q-w2', at(16), 'notice.queue.waiting', { text: queue[1].text, name: 'Claude B' }, { sessionId: b, itemId: two }),
    notice('q-d4', at(7), 'notice.queue.dispatched', { text: queue[3].text, name: '项目经理' }, { sessionId: pm, itemId: four }),
  ];
  return { version: 1, name: '共同工作', notes: '', revision: 1, events, queue };
}
const layout = () => page.evaluate(() => document.getElementById('header').className + ' | ' + document.getElementById('header').innerText.replace(/\s+/g, ' ').slice(0, 200) + ' | ' + [...document.querySelectorAll('#app > *, #header > *, #room-view > *')].filter(e => e.getClientRects().length).map(e => (e.parentElement.id || '?') + '>' + (e.id || e.className) + ':' + Math.round(e.getBoundingClientRect().y) + '+' + Math.round(e.getBoundingClientRect().height)).join(' '));
const TABS = ['#room-summary', '#room-stream', '#room-overview', '#room-member'];
async function tabBoxes() { return Promise.all(TABS.map(id => page.locator(id).boundingBox().then(b => b && [Math.round(b.x), Math.round(b.y), Math.round(b.height)]))); }
const current = () => page.evaluate(ids => ids.filter(id => document.querySelector(id).getAttribute('aria-current') === 'page'), TABS);
const sidebarRows = () => page.locator('#session-list .session-row:visible').evaluateAll(rows => rows.map(r => r.dataset.occurrence));
const feedRows = () => page.locator('#space-feed .feed-row').evaluateAll(rows => rows.map(r => [r.dataset.kind, r.querySelector('.feed-who').textContent, r.querySelector('.feed-text').textContent].join(' | ')));
async function main() {
  child = scratch.childProcess.fork(path.join(code, 'app/daemon.cjs'), [profile], {
    execArgv: ['--require', path.join(root, 'scripts/fixtures/space-feed.cjs')],
    env: { ...process.env, NAW_TEST_APP_ROOT: code, NAW_WORKSPACE: profile, NAW_APP_VERSION: require(path.join(code, 'package.json')).version }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Service starts');
  client = await connectService(profile, 'human-view');
  const ids = {};
  for (const [key, name, provider] of [['pm', '项目经理', 'claude'], ['a', 'Claude A', 'claude'], ['b', 'Claude B', 'claude'], ['c', '设计 A', 'claude'], ['solo', 'Codex 独立', 'codex']]) {
    ids[key] = await client.call('create', { provider, cwd: profile, name, view: 'chat' });
    if (['pm', 'a', 'b'].includes(key)) await client.call('join', ids[key], true);
  }
  await fixture('feedWorking', ids.pm);
  fs.writeFileSync(path.join(profile, 'room-state.json'), JSON.stringify(spaceRecords(ids)), { mode: 0o600 });
  // F7: the window last showed this space's 信息流 and then Claude B; a restart still opens the space on 总览.
  fs.writeFileSync(path.join(profile, 'views.json'), JSON.stringify([{ owner: 'human-view', active: true, selected: 'room', mode: 'chat', spaceId: 'shared', roomSession: ids.b,
    roomViews: { shared: { roomSurface: 'stream', roomSession: ids.b } } }]), { mode: 0o600 });
  app = await _electron.launch({ executablePath: require('electron'), args: [code], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid), NAW_TEST_UI_LANGUAGE: 'zh' }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message));
  // The startup window becomes the main window; under load that can take longer than revealDefaultSpace's first wait.
  await page.waitForSelector('#room-nav', { state: 'attached', timeout: 60000 });
  await revealDefaultSpace(page);
  // A space is created from the page, as the person does; membership is seeded through the service.
  ids.design = await page.evaluate(name => workspace.spaceCreate(name), '设计');
  await client.call('spaceAction', ids.design, 'join', [ids.c, true], {});
  await fixture('feedSeed', ids);
  const win = await app.browserWindow(page);
  await win.evaluate((w, [x, y]) => w.setContentSize(x, y), [1280, 820]); await delay(500);
  async function shot(name) {
    const file = path.join(pictures, name + '.png');
    await page.screenshot({ path: file });
    const d = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
    assert.ok(d.scroll <= d.width, 'No horizontal page overflow: ' + name);
    console.log('SHOT', file);
  }

  // R248 decision A: a space opens on its 总览, also after a restart that left it on another view.
  await page.locator('#space-summary').waitFor();
  assert.deepEqual(await current(), ['#room-summary']);
  assert.ok(await page.locator('#space-summary').isVisible() && !await page.locator('#space-feed').isVisible());
  for (const id of TABS) assert.ok(await page.locator(id).isVisible(), id + ' is shown');
  assert.equal(await page.locator('#room-member').textContent(), '成员 · 项目经理');
  await until(async () => (await page.locator('#space-summary .summary-row').count()) === 3, 'Three members in the summary');
  assert.deepEqual(await page.locator('#space-summary .summary-wait').evaluateAll(rows => rows.map(r => r.querySelector('strong').textContent + ' | ' + r.querySelector('.summary-question').textContent)),
    ['Claude B | 线框还是实心？推荐线框，因为和现有侧栏一致。']);
  assert.match(await page.locator('#space-summary .summary-queue').textContent(), /队列 · 待派 1：设置页文案/);
  const pmRow = page.locator('#space-summary .summary-row[data-session-id="' + ids.pm + '"]');
  await until(async () => /正在工作.*写文档：信息流的说明.*文档写到一半/.test(await pmRow.textContent()), 'The PM row shows its item and last words: ' + await pmRow.textContent());
  const lastWordsPM = await pmRow.locator('.summary-last').textContent();
  assert.equal(await page.locator('#room-stream-waiting').textContent(), '1');
  assert.ok(!await page.locator('#collaboration-overview').isVisible());
  record('a restart and entering a space land on 总览: waits, one row per member with its item and last words, and the queue line');
  const boxes = await tabBoxes();

  // R247: the left list keeps the other space and the independent session; the open space's members are marked.
  const listed = await sidebarRows();
  assert.ok(listed.includes(ids.solo), 'The independent session stays listed');
  assert.ok(listed.includes(ids.c), 'The other space\'s member stays listed');
  assert.equal(await page.locator('#session-list .session-row.in-current-space').count(), 3);
  assert.ok(await page.locator('#workspace-group').isVisible(), 'The spaces list stays');
  assert.ok(await page.locator('.session-view-switch').isVisible(), 'The list/space switch stays');
  await shot('summary-light-1280');
  record('in a space the left list is unchanged; only the space\'s three members are highlighted');

  // R249: the stream, one line per thing.
  await page.locator('#room-stream').click();
  await page.locator('#space-feed').waitFor();
  assert.deepEqual(await current(), ['#room-stream']); assert.deepEqual(await tabBoxes(), boxes, 'The tab row does not move');
  assert.deepEqual(await sidebarRows(), listed, 'The left list does not change');
  await until(async () => (await feedRows()).length >= 8, 'Stream rows');
  const all = await feedRows();
  for (const kind of ['say', 'reply', 'dispatch', 'ready', 'wait']) assert.ok(all.some(r => r.startsWith(kind + ' |')), 'A ' + kind + ' line');
  assert.ok(!all.some(r => r.includes('npm test')), 'Tool output is not a line');
  // F1 (R249 19:09): the working PM's finished replies are both lines; the newest is what 总览 showed as its last words.
  const pmReplies = all.filter(r => r.startsWith('reply | 项目经理 | '));
  assert.deepEqual(pmReplies.map(r => r.split(' | ')[2].slice(0, 6)), ['文档写到一半', '排好了：1.'], 'Both PM replies: ' + all.join(' / '));
  assert.equal(all[0], pmReplies[0], 'Newest first');
  assert.ok(lastWordsPM.startsWith(pmReplies[0].split(' | ')[2]), '总览 and 信息流 agree: ' + lastWordsPM);
  const wait = page.locator('#space-feed .feed-row.feed-waiting');
  assert.equal(await wait.count(), 1); assert.ok(await wait.locator('.feed-answer').isVisible());
  assert.ok(await page.locator('#room-composer').isVisible());
  await shot('stream-light-1280');
  record('信息流 lists said/dispatch/READY/wait lines newest first, without tool output, the tab row and left list unchanged');

  const ready = page.locator('#space-feed .feed-row[data-kind="ready"]');
  await ready.locator('summary').click();
  assert.ok(await ready.locator('details').evaluate(d => d.open));
  assert.match(await ready.locator('.feed-body').textContent(), /中文输入时光标跳到行尾/);
  await shot('stream-open-light-1280');
  await ready.locator('summary').click();
  record('a line opens in place to the whole task text');

  await page.locator('#space-feed .feed-person', { hasText: 'Claude A' }).click();
  const onlyA = await feedRows();
  assert.ok(onlyA.length > 0 && onlyA.length < all.length && onlyA.every(r => r.includes('Claude A')), 'Only Claude A lines: ' + onlyA.join(' / '));
  await page.locator('#space-feed .feed-person', { hasText: 'Claude B' }).click();
  const ab = await feedRows();
  assert.ok(ab.length > onlyA.length && ab.every(r => /Claude [AB]/.test(r)));
  await page.locator('#space-feed .feed-search').fill('输入框');
  const words = await feedRows();
  assert.ok(words.length > 0 && words.length < ab.length);
  await shot('stream-filter-light-1280');
  await page.locator('#space-feed .feed-search').fill('');
  for (const name of ['Claude A', 'Claude B']) await page.locator('#space-feed .feed-person', { hasText: name }).click();
  await page.locator('#space-feed [data-group="wait"]').click();
  assert.deepEqual((await feedRows()).map(r => r.split(' | ')[0]), ['wait']);
  await page.locator('#space-feed [data-group="all"]').click();
  record('filters: one or several members, words, and one kind');

  await page.locator('#space-feed [data-scope="all"]').click();
  await until(async () => (await feedRows()).some(r => r.includes('设计 A')), 'Other space lines');
  // F1: another space's member's own reply, not copied into its space's record, is a line too.
  assert.ok((await feedRows()).some(r => r === 'reply | 设计 A | 标签宽度也对齐了。'), 'Other space member reply: ' + (await feedRows()).join(' / '));
  assert.ok(await page.locator('#space-feed .feed-space:visible', { hasText: '设计' }).count() > 0);
  await shot('stream-all-spaces-light-1280');
  await page.locator('#space-feed [data-scope="space"]').click();
  await until(async () => !(await feedRows()).some(r => r.includes('设计 A')), 'Back to this space');
  record('one switch shows all spaces with each line\'s space, and back');

  // 「去回答」 opens the member where it answers, without a new screen.
  await page.locator('#space-feed .feed-row.feed-waiting .feed-answer').click();
  await until(async () => (await current()).join() === '#room-member', 'Member tab');
  assert.equal(await page.locator('#room-member').textContent(), '成员 · Claude B');
  assert.deepEqual(await tabBoxes(), boxes, 'The tab row does not move for the member view: ' + await layout());
  assert.deepEqual(await sidebarRows(), listed);
  // The header stays the space's; the member's own controls sit in its toolbar, leaving stays in its ⋯ menu.
  assert.match(await page.locator('#header .header-identity').innerText(), /共同工作/);
  assert.ok(!(await page.locator('#header .header-identity').innerText()).includes('Claude B'));
  for (const id of ['#member-open-session', '#session-header-more', '#usage-button']) assert.ok(await page.locator('#session-toolbar ' + id).isVisible(), id + ' in the member toolbar');
  assert.ok(!await page.locator('#session-toolbar .membership-menu-only').isVisible(), 'Leaving stays in the menu');
  // F3: the open member's row is painted as the selected row; the other members keep the space's tint.
  const paint = await page.evaluate(list => {
    const bg = id => getComputedStyle(document.querySelector(`#session-list .session-row[data-session-row="${id}"]`)).backgroundColor;
    const probe = document.createElement('div'); probe.style.background = 'var(--selected)'; document.querySelector('#session-list').append(probe);
    const selected = getComputedStyle(probe).backgroundColor; probe.remove();
    return { open: bg(list[0]), others: list.slice(1).map(bg), selected };
  }, [ids.b, ids.pm, ids.a]);
  assert.equal(paint.open, paint.selected, 'Open member painted as selected: ' + JSON.stringify(paint));
  assert.ok(paint.others.every(c => c === paint.others[0] && c !== paint.open), 'Other members keep the tint: ' + JSON.stringify(paint));
  await shot('member-b-light-1280');
  record('去回答 opens that member in the 成员 tab; header, tabs and left list stay; its controls are in its toolbar; its left row looks selected');

  // R248: a left member row switches the main area to it.
  await page.locator(`#session-list .session-row[data-session-row="${ids.a}"] .session-link`).click();
  await until(() => page.locator('#room-member').textContent().then(t => t === '成员 · Claude A'), 'Member A');
  assert.deepEqual(await tabBoxes(), boxes); assert.deepEqual(await sidebarRows(), listed);
  assert.equal(await page.locator(`#session-list .session-row[data-session-row="${ids.a}"] .session-link`).getAttribute('aria-current'), 'page');
  record('a left member row opens it in the 成员 tab and is marked there');

  await page.locator('#room-overview').click();
  await until(async () => (await current()).join() === '#room-overview', 'Grid tab');
  assert.ok(await page.locator('#collaboration-overview').isVisible());
  assert.equal(await page.locator('.collaboration-toolbar:visible').count(), 0, 'No 列表 or 简化信息');
  assert.deepEqual(await tabBoxes(), boxes);
  await shot('grid-light-1280');
  await page.locator('#room-member').click();
  await until(() => page.locator('#room-member').textContent().then(t => t === '成员 · Claude A'), 'The 成员 tab reopens the last member');
  record('网格 shows the columns without 列表/简化信息; 成员 reopens the last member');

  // Another space opens on its 总览, and the list still holds this one.
  await page.locator('#workspace-group .room-row', { hasText: '设计' }).locator('.room-nav').click();
  await until(async () => (await current()).join() === '#room-summary', 'Other space summary');
  await until(async () => (await page.locator('#space-summary .summary-row').count()) === 1, 'One member there');
  assert.equal(await page.locator('#session-list .session-row.in-current-space').count(), 1);
  assert.ok((await sidebarRows()).includes(ids.pm));
  record('another space lands on its 总览; the left list keeps every row');

  // Grouped view: the open space's group is highlighted. F5 (R247, the left list as before): a row that is not a
  // member of the open space, and any row outside a space, opens its session alone.
  await page.locator('#sessions-grouped').click();
  await until(() => page.locator('.session-space-group.current-space').count().then(n => n === 1), 'Current group');
  await shot('grouped-light-1280');
  const grouped = id => page.locator(`.session-space-group[data-session-group="shared"] .session-row[data-session-row="${id}"] .session-link`);
  const alone = async id => (await grouped(id).getAttribute('aria-current')) === 'page' && !(await page.locator('#room-member').isVisible());
  await grouped(ids.b).click();
  await until(() => alone(ids.b), 'Claude B opens alone from 设计');
  assert.equal(await page.locator('.session-space-group.current-space').count(), 0);
  await grouped(ids.a).click();
  await until(() => alone(ids.a), 'Claude A opens alone outside a space');
  record('grouped view: the open space\'s group is highlighted; a row outside the open space, or any row outside a space, opens its session alone');
  await page.locator('#sessions-flat').click();
  await page.locator('#workspace-group .room-row', { hasText: '共同工作' }).locator('.room-nav').click();
  await until(async () => (await current()).join() === '#room-summary', 'Back in 共同工作');

  for (const scheme of ['dark']) { await page.emulateMedia({ colorScheme: scheme }); await page.locator('#room-stream').click(); await delay(300); await shot(`stream-${scheme}-1280`); }
  await page.emulateMedia({ colorScheme: 'light' });
  await win.evaluate((w, [x, y]) => w.setContentSize(x, y), [850, 760]); await delay(500);
  await shot('stream-light-850');
  await page.locator('#room-summary').click(); await delay(300); await shot('summary-light-850');
  record('dark and narrow windows keep the page within its width');

  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ visible: w.isVisible(), focused: w.isFocused() })));
  assert.ok(windows.length && windows.every(w => !w.visible && !w.focused)); record('owned windows remain hidden and unfocused');
  assert.deepEqual(errors, []); record('zero renderer errors');
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ checks, pictures, windows, errors }, null, 2));
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
