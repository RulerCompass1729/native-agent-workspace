// T29: actual source GUI + Codex adapter, synthetic transport, zero inference.
const scratch = require('./fixtures/test-scratch.cjs');
const { createIn } = require('./fixtures/create-view.cjs');
const { chooseRecipient, fillRoomMessage } = require('./room-input.cjs');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const { fork } = scratch.childProcess, { _electron } = scratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const { connect } = require(path.join(code, 'app/service-client.cjs'));
const profile = scratch.directory(path.join(os.tmpdir(), 'naw-command-actions-'));
const evidence = process.env.NAW_EVIDENCE_DIR, pictures = process.env.NAW_SCREENSHOT_DIR;
if (evidence) fs.mkdirSync(evidence, { recursive: true });
const child = fork(path.join(code, 'app/daemon.cjs'), [profile], {
  execArgv: ['--require', path.join(__dirname, 'fixtures/daily-native.cjs')],
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
const commandStates = {}, checks = [], startedItems = new Set();
function row(id) { return page.locator(`#messages [data-message-id="native:${commandStates.nativeId}:tool:${id}"]`); }
async function events(target, value) { await native('events', { target, value }); }
async function item(target, id, actions, options = {}) {
  const s = (await snapshot()).sessions.find(s => s.id === target);
  const command = options.command || "/bin/zsh -lc '" + actions.map(a => a.command).join(' && ') + "'";
  const data = { type: 'commandExecution', id, command, source: 'agent', commandActions: actions, status: options.running ? 'inProgress' : options.status || (options.exitCode ? 'failed' : 'completed'), exitCode: options.exitCode ?? (options.running ? null : 0), aggregatedOutput: options.output || '' };
  const key = [target, s.activeTurnId, id].join(':'), batch = [];
  if (!startedItems.has(key)) { startedItems.add(key); batch.push({ method: 'item/started', params: { threadId: s.nativeId, turnId: s.activeTurnId, item: { ...data, status: 'inProgress', aggregatedOutput: null, exitCode: null } } }); }
  if (!options.running) batch.push({ method: 'item/completed', params: { threadId: s.nativeId, turnId: s.activeTurnId, item: data } });
  else if (options.output) batch.push({ method: 'item/commandExecution/outputDelta', params: { threadId: s.nativeId, turnId: s.activeTurnId, itemId: id, delta: options.output } });
  await events(target, batch);
  return data;
}
const read = name => [{ type: 'read', command: 'cat ' + name, name, path: '/synthetic/' + name }];
async function run() {
  console.log(JSON.stringify({ profile, code, executable: process.env.NAW_APP_EXECUTABLE || require('electron'), fixture: 'daily-native actual Codex adapter; synthetic transport' }));
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Fixture service');
  client = await connect(profile, 'command-actions-observer');
  app = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root],
    env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#new-session').waitFor(); const a = await create('Commands A'), b = await create('Commands B');
  await select(a); await page.locator('#message-input').fill('Inspect local files'); await page.locator('#send-button').click();
  await until(async () => (await native()).sends.length === 1, 'Solo task received');
  commandStates.nativeId = (await snapshot()).sessions.find(s => s.id === a).nativeId;
  const first = await item(a, 'read1', read('first.txt'), { running: true, output: 'partial read' });
  const firstRow = row('read1'), firstSummary = firstRow.locator(':scope > .process-details > summary');
  await firstSummary.getByText('Exploring', { exact: true }).waitFor();
  await item(a, 'read1', read('first.txt'), { output: 'First complete result\n' });
  await item(a, 'read2', read('second.txt'), { output: 'Second complete result\n' });
  await item(a, 'search', [{ type: 'search', command: 'rg needle src', query: 'needle', path: 'src' }], { output: 'No matches\n', exitCode: 1 });
  await item(a, 'list', [{ type: 'listFiles', command: 'ls src', path: 'src' }], { output: 'first.js\nsecond.js\n' });
  await firstSummary.getByText('Explored', { exact: true }).waitFor();
  await until(async () => (await firstRow.locator(':scope > .process-tail').innerText()).includes('List src'), 'Full exploration summary');
  assert.equal(await page.locator('#messages > .message.tool').count(), 1);
  assert.equal(await firstRow.locator(':scope > .process-details').evaluate(el => el.open), false, 'Native search exit1 keeps exploration folded');
  assert.ok(!(await firstSummary.innerText()).includes('failed'));
  assert.equal(await firstRow.locator(':scope > .process-tail').innerText(), 'Read first.txt, second.txt\nSearch needle in src (exit 1)\nList src');
  await shot('t29-explored-read-search-list');
  await firstSummary.click();
  for (const [id, output] of [['read1', 'First complete result\n'], ['read2', 'Second complete result\n'], ['search', 'No matches\n'], ['list', 'first.js\nsecond.js\n']]) {
    const entry = row(id), detail = entry.locator(':scope > .process-details');
    if (!await detail.evaluate(el => el.open)) await detail.locator(':scope > summary').click();
    assert.equal(await entry.locator(':scope > .process-details > .process-content > .message-body').textContent(), output);
    assert.match(await entry.locator(':scope > .process-details > .process-content > .native-tool-input').innerText(), /\/bin\/zsh -lc/);
  }
  checks.push('Actual Codex adapter read/search/list records form one exploration; native exit1 and complete raw commands/results remain expandable');
  const active = (await snapshot()).sessions.find(s => s.id === a);
  await events(a, [{ method: 'item/completed', params: { threadId: active.nativeId, turnId: active.activeTurnId, item: { id: 'body', type: 'agentMessage', text: 'Original assistant paragraph.', phase: 'commentary' } } }]);
  await item(a, 'after-body', read('after.txt'), { output: 'After body result' });
  await row('after-body').locator(':scope > .process-details > summary').getByText('Explored', { exact: true }).waitFor();
  assert.equal(await page.locator('#messages > .message.tool').count(), 2);
  const output = Array.from({ length: 12 }, (_, i) => 'Runtime output ' + i).join('\n');
  await item(a, 'run', [{ type: 'read', command: 'cat misleading-name', name: 'misleading-name', path: '/synthetic/misleading-name' }, { type: 'unknown', command: 'npm test' }], { running: true, output });
  const runRow = row('run'); await runRow.locator(':scope > .process-details > summary').getByText('Running', { exact: true }).waitFor();
  assert.equal(await runRow.locator('.process-label').innerText(), 'cat misleading-name && npm test');
  assert.ok(!(await runRow.locator(':scope > .process-details > summary').innerText()).includes('/bin/zsh'));
  await item(a, 'run', [{ type: 'read', command: 'cat misleading-name', name: 'misleading-name', path: '/synthetic/misleading-name' }, { type: 'unknown', command: 'npm test' }], { status: 'failed', exitCode: 2, output });
  await runRow.locator(':scope > .process-details > summary').getByText('failed', { exact: true }).waitFor();
  await runRow.locator(':scope > .process-details > summary').getByText('exit 2', { exact: true }).waitFor();
  assert.equal(await runRow.locator('.message-body').innerText(), output);
  await runRow.scrollIntoViewIfNeeded(); await shot('t29-ordinary-command-failed-full-output');
  await item(a, 'cancel', read('slow.txt'), { running: true, output: 'Partial before interrupt' });
  await page.locator('#interrupt').click();
  const before = (await snapshot()).sessions.find(s => s.id === a);
  await events(a, [{ method: 'turn/completed', params: { threadId: before.nativeId, turn: { id: before.activeTurnId, status: 'interrupted' } } }]);
  await row('cancel').locator(':scope > .process-details > summary').getByText('interrupted', { exact: true }).waitFor();
  commandStates.solo = await snapshot(); const identity = identities(commandStates.solo);
  assert.equal(commandStates.solo.sessions.find(s => s.id === a).messages.find(m => m.id.endsWith(':tool:cancel')).text, 'Partial before interrupt');
  checks.push('Assistant body breaks exploration; unknown shell-looking command stays Ran; failed and interrupted native content remains visible');
  await row('cancel').scrollIntoViewIfNeeded(); await shot('t29-interrupted-command');
  for (const id of [a, b]) { await select(id); await page.getByRole('button', { name: '加入协作', exact: true }).click(); }
  await select(a); await page.locator('#message-input').fill('Unsent private draft');
  await room(); await chooseRecipient(page, a); await fillRoomMessage(page, 'Inspect shared files'); await page.locator('#forward-button').click();
  await until(async () => (await native()).sends.length === 2, 'Directed shared task');
  await item(a, 'shared1', read('shared-a.txt'), { output: 'Shared result A' }); await item(a, 'shared2', read('shared-b.txt'), { output: 'Shared result B' });
  const shared = page.locator('#room-messages > .message.tool');
  await until(async () => await shared.count() === 1 && (await shared.locator(':scope > .process-tail').innerText()).includes('shared-b.txt'), 'Shared exploration grouped');
  await page.locator('#room-search').fill('Shared result B');
  const contextRow = page.locator('#room-messages [data-message-id]').filter({ hasText: 'Shared result B' });
  await contextRow.hover(); await contextRow.getByRole('button', { name: '查看上下文', exact: true }).click();
  await until(async () => await page.locator('#room-search').inputValue() === '', 'Context clears filter');
  const contextState = await snapshot(), nestedId = contextState.room.messages.find(m => m.text === 'Shared result B').id;
  const nestedRow = page.locator(`#room-messages [data-message-id="${nestedId}"]`);
  await until(async () => nestedRow.evaluate(el => el.getBoundingClientRect().height > 0 && !el.parentElement.closest('details')?.matches(':not([open])')), 'Context opens enclosing exploration');
  assert.equal(await nestedRow.evaluate(el => document.activeElement === el), true, 'Context focuses original nested message');
  await shot('t29-shared-context-jump');
  const currentA = (await snapshot()).sessions.find(s => s.id === a);
  await events(a, [{ method: 'item/completed', params: { threadId: currentA.nativeId, turnId: currentA.activeTurnId, item: { id: 'final', type: 'agentMessage', text: 'Shared inspection completed.', phase: 'final_answer' } } }, { method: 'turn/completed', params: { threadId: currentA.nativeId, turn: { id: currentA.activeTurnId, status: 'completed' } } }]);
  commandStates.shared = await snapshot(); await shot('t29-shared-exploration');
  assert.ok(!JSON.stringify(commandStates.shared.room.messages).includes('First complete result'));
  await page.reload(); await page.locator('#new-session').waitFor(); await room();
  await page.locator('#room-messages').getByText('Shared inspection completed.', { exact: true }).waitFor();
  commandStates.reloaded = await snapshot(); assert.deepEqual(identities(commandStates.reloaded), identity);
  await select(a); assert.equal(await page.locator('#message-input').inputValue(), 'Unsent private draft');
  assert.equal((await snapshot()).sessions.find(s => s.id === a).messages.find(m => m.id.endsWith(':tool:read1')).input, first.command);
  const disk = JSON.parse(fs.readFileSync(path.join(profile, 'workspace.json'), 'utf8'));
  assert.equal(disk.sessions.find(s => s.id === a).messages.find(m => m.id.endsWith(':tool:read1')).commandActions[0].name, 'first.txt');
  assert.equal(disk.room.messages.filter(m => m.commandActions).length, 2);
  // A nested source row remains the search target; opening it reveals both
  // its parent exploration and its own full result, preserving original IDs.
  const parentDetail = row('read1').locator(':scope > .process-details');
  if (await parentDetail.evaluate(el => el.open)) await parentDetail.locator(':scope > summary').click();
  await page.locator('#search-button').click(); await page.locator('#search-input').fill('Second complete result');
  await until(async () => await page.locator('#search-results button').count() === 1, 'Nested result search');
  await page.locator('#search-input').press('Enter'); await page.locator('#search-dialog').waitFor({ state: 'hidden' });
  await until(async () => await parentDetail.evaluate(el => el.open) && await row('read2').locator(':scope > .process-details').evaluate(el => el.open), 'Nested search reveals parent and child');
  assert.equal(await row('read2').locator('.message-body').textContent(), 'Second complete result\n');
  checks.push('Authorized shared records group without leaking solo output; disk/reload retain actions, full command/output, identity and unsent draft');
  assert.deepEqual(errors, []); const stats = await native(); assert.equal(stats.modelCalls, 0); assert.equal(stats.nativeProcesses, 0); assert.equal(stats.sends.length, 2);
  if (evidence) fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ checks, states: commandStates, stats, errors }, null, 2));
  console.log(JSON.stringify({ checks, modelCalls: stats.modelCalls, nativeProcesses: stats.nativeProcesses, sends: stats.sends.length }));
}
run().catch(async error => {
  console.error(error); process.exitCode = 1;
  if (page && evidence) fs.writeFileSync(path.join(evidence, 'failure-state.json'), JSON.stringify(await snapshot(), null, 2));
  if (page) { await shot('t29-failure').catch(() => {}); if (evidence) { fs.mkdirSync(evidence, { recursive: true }); fs.writeFileSync(path.join(evidence, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); } }
}).finally(scratch.cleanup(async () => {
  if (app) await app.close();
  if (client) { const state = await client.call('initial'); for (const s of state.sessions) await client.call('stop', s.id); await client.call('shutdown'); client.close(); }
  if (child.connected) child.disconnect();
}));
