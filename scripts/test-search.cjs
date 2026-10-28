const testScratch = require('./fixtures/test-scratch.cjs');
const { createIn } = require('./fixtures/create-view.cjs');
// Actual hidden Electron/DSH renderer and persistence; synthetic records, no model.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { fork } = testScratch.childProcess, { _electron } = testScratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const { connect } = require(path.join(code, 'app/service-client.cjs'));
const profile = testScratch.directory(path.join(os.tmpdir(), 'naw-search-ui-'));
const child = fork(path.join(code, 'app/daemon.cjs'), [profile], { execArgv: ['--require', path.join(__dirname, 'fixtures/loading-terminal.cjs')], env: { ...process.env, NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_WORKSPACE: profile, NAW_TEST_APP_ROOT: code }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
let app, page, client, sequence = 0;
const checks = [], errors = [], delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { for (let i = 0; i < 160; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
function fixture(method, target, value) { const id = ++sequence; return new Promise((resolve, reject) => {
  const callback = result => { if (result.requestId === id) { clearTimeout(timer); child.off('message', callback); resolve(result); } };
  const timer = setTimeout(() => { child.off('message', callback); reject(Error('Fixture timeout')); }, 8000);
  child.on('message', callback); child.send({ id, method, target, value });
}); }
const snapshot = () => page.evaluate(() => workspace.initial());
async function launch() {
  app = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(12000); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#search-button').waitFor();
  await app.evaluate(({ clipboard }) => { globalThis.copyValues = []; clipboard.writeText = value => globalThis.copyValues.push(value); });
}
async function create(name) {
  await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="codex"]').check();
  await page.locator('#session-name').fill(name); await createIn(page, 'chat');
  await until(async () => (await snapshot()).sessions.some(s => s.name === name && s.state === 'idle'), 'Create');
  return (await snapshot()).sessions.find(s => s.name === name).id;
}
async function search(query) {
  await page.locator('#search-input').fill(query);
  await delay(160);
}
async function searchOptions() { if (!(await page.locator('#search-options').evaluate(el => el.open))) await page.locator('#search-options-summary').click(); }
async function capture(name) { if (process.env.NAW_EVIDENCE_DIR) { fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, name + '.png') }); } }
async function run() {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Service ready'); client = await connect(profile, 'search-observer'); await launch();
  const first = await create('学习记录'), second = await create('已归档笔记');
  await page.locator('#search-button').click();
  await capture('quick-picker');
  const picker = await page.locator('#search-dialog').boundingBox();
  assert.ok(picker.width <= 600 && picker.height < 400, 'Compact input/results picker for two sessions');
  assert.equal(await page.locator('#search-options').evaluate(el => el.open), false);
  assert.equal(await page.locator('#search-input').evaluate(el => el === document.activeElement), true);
  assert.equal(await page.locator('#search-results button').count(), 3);
  await page.locator('#search-input').evaluate(el => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })));
  assert.equal(await page.locator('#search-dialog').evaluate(el => el.open), true, 'IME confirmation cannot open a result');
  await page.locator('#search-input').press('Enter');
  await until(async () => (await snapshot()).viewState.selected === first && !(await page.locator('#search-dialog').evaluate(el => el.open)), 'Enter opens first of multiple results');
  await until(() => page.locator('#message-input').evaluate(el => el === document.activeElement), 'Result navigation keeps destination focus');
  await page.locator('#message-input').press('Meta+f'); await page.locator('#search-input').press('Escape');
  await until(() => page.locator('#message-input').evaluate(el => el === document.activeElement), 'Escape restores shortcut opener');
  await page.locator('#search-button').click();
  await page.locator('#search-input').press('ArrowDown');
  assert.equal(await page.locator('#search-results button').first().evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.locator('#search-results button').nth(1).evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('Home'); await page.keyboard.press('ArrowUp');
  assert.equal(await page.locator('#search-input').evaluate(el => el === document.activeElement), true);
  const inputBox = await page.locator('#search-input').boundingBox();
  await page.mouse.move(inputBox.x + 15, inputBox.y + 15); await page.mouse.down(); await page.mouse.move(5, 5); await page.mouse.up();
  assert.equal(await page.locator('#search-dialog').evaluate(el => el.open), true, 'Dragging text outside must not dismiss search');
  // Outside click falls over a real underlying action. Dismiss only, without
  // clicking through to create a session.
  const createBox = await page.locator('#new-session').boundingBox();
  await page.mouse.click(createBox.x + createBox.width / 2, createBox.y + createBox.height / 2);
  await page.locator('#search-dialog').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#create-dialog').isVisible(), false);
  await until(() => page.locator('#search-button').evaluate(el => el === document.activeElement), 'Outside close restores button opener');
  checks.push('Compact picker opens first result on Enter, preserves IME confirmation, supports arrow navigation and restores opener on Escape/outside click without click-through or drag dismissal');
  await fixture('history', first, Array.from({ length: 160 }, (_, i) => ({ id: `record-${i}`, type: 'agentMessage', text: `记录 ${i}：学习材料。\n\n${i === 45 ? '很长的前文。\n\n'.repeat(100) + '唯一中文关键词 代码核验 <script>不能执行</script>' : '今天的练习'}\n\n\`\`\`js\nconst record = ${i};\n\`\`\`\n\n${'连续阅读的内容。'.repeat(20)}` })));
  await fixture('history', second, [{ id: 'archive-match', type: 'agentMessage', text: '唯一中文关键词：归档中的结论' }]);
  await page.locator(`[data-session-menu="${second}"]`).click(); await page.getByRole('menuitem', { name: '归档会话', exact: true }).click();
  await until(async () => (await snapshot()).sessions.find(s => s.id === second).archived, 'Archived');
  await page.locator(`[data-session-id="${first}"]`).click(); await page.locator('#message-input').fill('未发草稿不应该被搜索到');
  const original = page.locator('#messages [data-message-id="record-20"] .message-body');
  await original.scrollIntoViewIfNeeded(); await delay(100);
  const oldTop = await page.locator('#messages').evaluate(el => el.scrollTop);
  await page.locator('#message-input').focus(); await page.keyboard.press('Meta+f');
  await page.locator('#search-dialog').waitFor(); assert.equal(await page.locator('#search-scope').inputValue(), 'current');
  await search('未发草稿不应该被搜索到'); assert.equal(await page.locator('#search-results button').count(), 0);
  await search('唯一中文关键词'); assert.equal(await page.locator('#search-results button').count(), 1);
  await capture('search-current');
  await page.locator('#search-input').press('Enter');
  await until(() => page.locator('#search-dialog').evaluate(el => !el.open), 'Search selected');
  await until(() => page.locator('#messages [data-message-id="record-45"] .message-body').getByText('唯一中文关键词 代码核验 <script>不能执行</script>', { exact: true }).evaluate(el => { const container = document.getElementById('messages').getBoundingClientRect(), row = el.getBoundingClientRect(); return row.top >= container.top - 3 && row.top < container.top + 40; }), 'Exact paragraph deep inside long message');
  assert.equal(await page.locator('#message-input').inputValue(), '未发草稿不应该被搜索到');
  await fixture('delta', first, { id: 'live', text: '查找期间的新输出' }); await delay(150);
  assert.equal(await page.locator('#messages [data-search-target]').getAttribute('data-message-id'), 'record-45');
  await page.locator('#return-reading').click();
  await until(() => page.locator('#messages').evaluate((el, top) => Math.abs(el.scrollTop - top) < 3, oldTop), 'Original reading position');
  checks.push('Current-session search locates exact historical context and returns to the original reading position; new output and private draft remain intact');
  await page.locator('#search-button').click(); await search('唯一中文关键词');
  assert.equal(await page.locator('#search-results button').count(), 1);
  await searchOptions(); await page.locator('#search-archived').check(); assert.equal(await page.locator('#search-results button').count(), 2);
  await page.locator(`[data-search-key="message:${second}:archive-match"]`).click();
  await page.locator('#messages [data-message-id="archive-match"]').waitFor();
  assert.equal((await snapshot()).sessions.find(s => s.id === second).archived, true);
  assert.equal(await page.locator('#message-input').getAttribute('readonly'), '');
  await page.getByRole('button', { name: '恢复会话', exact: true }).click();
  await until(async () => !(await snapshot()).sessions.find(s => s.id === second).archived, 'Explicit restore');
  checks.push('Archive search opens read-only context without automatic restore; explicit restore retains the same record and native identity');
  await page.locator('#search-button').click(); await search('学习材料');
  assert.match(await page.locator('#search-count').innerText(), /60 \/ 160/);
  await page.locator('#search-more').click(); assert.match(await page.locator('#search-count').innerText(), /120 \/ 160/);
  await page.locator('#search-more').click(); assert.match(await page.locator('#search-count').innerText(), /160 \/ 160/);
  await page.locator('#search-input').press('Escape'); await page.locator('#search-dialog').waitFor({ state: 'hidden' });
  checks.push('Large-result pagination and keyboard dismissal work without replacing native state');
  for (const id of [first, second]) {
    await page.locator(`[data-session-id="${id}"]`).click();
    await page.getByRole('button', { name: '加入协作', exact: true }).click();
    await until(async () => (await snapshot()).sessions.find(s => s.id === id).roomId === 'shared', 'Member joined');
  }
  await page.locator('#room-nav').click(); await page.locator('#room-record').click();
  await page.locator('#room-filter').selectOption(first); await page.locator('#room-search').fill('加入');
  await until(() => page.locator('#room-messages article').count().then(n => n === 1), 'Original room filter');
  await page.locator('#room-search').press('Meta+f'); await search('加入');
  assert.equal(await page.locator('#search-scope').inputValue(), 'room');
  const eventId = (await snapshot()).room.events.find(e => e.sessionId === second && e.kind === 'join').id;
  await page.locator(`[data-search-key="shared:${eventId}"]`).click();
  await until(() => page.locator(`#room-messages [data-message-id="${eventId}"]`).count().then(n => n === 1), 'Shared result context');
  assert.equal(await page.locator('#room-filter').inputValue(), '');
  await page.locator('#return-reading').click();
  assert.equal(await page.locator('#room-filter').inputValue(), first);
  assert.equal(await page.locator('#room-search').inputValue(), '加入');
  await until(() => page.locator('#room-messages article').count().then(n => n === 1), 'Returned room filter');
  checks.push('Returning from a shared result restores both the original member and keyword filters');
  await page.locator('#room-more').click(); await page.getByRole('menuitem', { name: '归档工作区', exact: true }).click();
  await until(async () => (await snapshot()).room.archived, 'Room archived');
  await page.locator('#search-button').click(); await searchOptions(); await page.locator('#search-archived').check(); await search('加入');
  await page.locator(`[data-search-key="shared:${eventId}"]`).click(); await page.locator('#search-preview').waitFor();
  assert.equal((await snapshot()).room.archived, true);
  assert.equal((await snapshot()).sessions.some(s => s.roomId === 'shared'), false);
  assert.match(await page.locator('#search-preview-body').innerText(), /加入/);
  await page.locator('#search-preview-copy').click();
  assert.equal(await app.evaluate(() => globalThis.copyValues.at(-1)), (await snapshot()).room.events.find(e => e.id === eventId).text);
  await page.locator('#search-preview-back').click(); await page.locator('#close-search').click();
  checks.push('Archived shared records can be read and copied without restoring the room or restarting membership');
  await page.locator(`[data-session-id="${first}"]`).click(); await page.locator('#search-button').click(); await search('唯一中文关键词');
  const before = await snapshot(); const disk = fs.readFileSync(path.join(profile, 'views.json'), 'utf8');
  assert.ok(!disk.includes('唯一中文关键词'), 'Search query is not persisted in view state');
  await capture('search-all'); await page.locator('#close-search').click();
  await app.close(); app = null; await launch();
  const after = await snapshot(); assert.deepEqual(after.sessions.map(s => [s.id, s.nativeId, s.messages]), before.sessions.map(s => [s.id, s.nativeId, s.messages]));
  assert.equal(after.sessions.find(s => s.id === first).liveDraft, '未发草稿不应该被搜索到');
  const stats = await fixture('stats'); assert.deepEqual(stats.sends, []); assert.deepEqual(stats.inputs, []); assert.deepEqual(stats.interruptions, []);
  checks.push('Close/reopen preserves histories, identities and drafts; search persists no query and triggers zero native input, model sends or interrupts');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, errors, modelTasks: 0, nativeProcesses: 0, profile, picker, scriptSha256: require('node:crypto').createHash('sha256').update(fs.readFileSync(__filename)).digest('hex') }, null, 2));
}
run().catch(async error => { console.error(error.stack); if (page && !page.isClosed()) await capture('failed'); process.exitCode = 1; }).finally(testScratch.cleanup(async () => {
  try { if (app) await app.close(); if (client) { for (const s of (await client.call('initial')).sessions) await client.call('stop', s.id); await client.call('shutdown'); client.close(); } }
  finally { if (child.connected) child.disconnect(); if (child.exitCode === null) child.kill('SIGTERM'); }
}));
