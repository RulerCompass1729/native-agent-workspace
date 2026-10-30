// Actual isolated Electron/DSH/service with existing synthetic transport only.
// Explicit native turn facts, no provider/model task or OS clipboard operation.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
if (process.env.NAW_EVIDENCE_DIR) {
  const target = path.resolve(process.env.NAW_EVIDENCE_DIR); let existing = target;
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  const destination = path.join(fs.realpathSync(existing), path.relative(existing, target));
  for (const base of [root, code].map(p => fs.realpathSync(p))) if (destination === base || destination.startsWith(base + path.sep)) throw Error('Evidence must be outside the repository; no GUI launched.');
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
}
const scratch = require('./fixtures/test-scratch.cjs'), { createIn } = require('./fixtures/create-view.cjs');
const { chooseRecipient, fillRoomMessage } = require('./room-input.cjs');
const { _electron } = scratch.playwright(require('playwright'));
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID();
try { fs.mkdirSync(slot); } catch (error) { if (error.code !== 'EEXIST') throw error; console.error('GUI slot occupied; no test app launched.'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Codex 3', task: 'T67 process groups', token, pid: process.pid, createdAt: new Date().toISOString() }));
const profile = scratch.directory(path.join(os.tmpdir(), 'naw-process-groups-'));
const shared = (id, text) => ({ id, role: 'tool', kind: 'tool', sharedStream: true, sourceTag: 'synthetic-shared-grant', replyTo: 'synthetic-shared-request', sessionId: 'retained-member', name: 'Synthetic retained member', nativeId: 'synthetic-shared-native', nativeMessageId: `native:synthetic-shared-native:tool:${id}`, turnId: 'shared-turn', title: 'Read', status: 'complete', text, time: 1793210400000 });
fs.writeFileSync(path.join(profile, 'workspace.json'), JSON.stringify({ sessions: [], room: { messages: [shared('shared-1', 'SHARED_MATCH_FIRST'), shared('shared-2', 'SHARED_DETAIL_SECOND'),
  { id: 'shared-answer', role: 'assistant', text: 'ORIGINAL_SHARED_ANSWER_BREAK', time: 1793210400000 }, shared('shared-3', 'SHARED_MATCH_THIRD'), shared('shared-4', 'SHARED_DETAIL_FOURTH'),
  { ...shared('shared-revoked-1', 'ORIGINAL_REVOKED_ONE'), sourceTag: 'revoked-grant', sharingStopped: 'SYNTHETIC_REVOKED' },
  { ...shared('shared-revoked-2', 'ORIGINAL_REVOKED_TWO'), sourceTag: 'revoked-grant', sharingStopped: 'SYNTHETIC_REVOKED' }] } }), { mode: 0o600 });
const child = scratch.childProcess.fork(path.join(code, 'app/daemon.cjs'), [profile], {
  execArgv: ['--require', path.join(__dirname, 'fixtures/process-groups.cjs')],
  env: { ...process.env, NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_WORKSPACE: profile, NAW_TEST_APP_ROOT: code },
  stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let app, page, sequence = 0; const checks = [], errors = [];
function fixture(method, target, value) {
  const id = ++sequence; return new Promise((resolve, reject) => {
    const callback = packet => { if (packet.requestId === id) { clearTimeout(timer); child.off('message', callback); packet.error ? reject(Error(packet.error)) : resolve(packet); } };
    const timer = setTimeout(() => { child.off('message', callback); reject(Error('Fixture reply timed out')); }, 10000);
    child.on('message', callback); child.send({ id, method, target, value });
  });
}
async function until(fn, label) { for (let i = 0; i < 160; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
const snapshot = () => page.evaluate(() => workspace.initial());
const check = text => { checks.push(text); console.log('PASS:', text); };
const identity = state => state.sessions.map(s => [s.id, s.nativeId, s.pid, s.owner, s.controlRevision, s.model]).sort();
const reader = id => page.locator(`.collaboration-member-reader[data-member-id="${id}"] .messages`);
const nativeId = async (id, item) => (await snapshot()).sessions.find(s => s.id === id).messages.find(m => m.id.endsWith(':' + item)).id;
const row = async (id, item, host = reader(id)) => host.locator(`[data-message-id="${await nativeId(id, item)}"]`);
const group = async (id, first, host = reader(id)) => host.locator(`[data-process-group="process:${await nativeId(id, first)}"]`);
const detail = element => element.locator(':scope > details');
const summary = element => detail(element).locator(':scope > summary');
const emit = (id, item, value) => fixture('nativeBlock', id, { id: item, ...value });
async function capture(name) {
  if (!process.env.NAW_SCREENSHOTS_DIR) return;
  fs.mkdirSync(process.env.NAW_SCREENSHOTS_DIR, { recursive: true });
  await page.screenshot({ path: path.join(process.env.NAW_SCREENSHOTS_DIR, `${name}.png`) });
}
async function launch() {
  app = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [code], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message)); await page.locator('#new-session').waitFor();
  await app.evaluate(({ clipboard }) => { globalThis.groupCopies = []; clipboard.writeText = text => globalThis.groupCopies.push(text); });
}
async function create(name, provider) {
  await page.locator('#new-session').click(); await page.locator(`input[name="provider"][value="${provider}"]`).check(); await page.locator('#session-name').fill(name); await createIn(page, 'chat');
  await until(async () => (await snapshot()).sessions.some(s => s.name === name && s.state === 'idle'), 'Synthetic session ready');
  const id = (await snapshot()).sessions.find(s => s.name === name).id;
  await page.locator('#session-header-more').click(); await page.getByRole('menuitem', { name: '加入协作', exact: true }).click(); return id;
}
async function toggle(element, open, key, fold) {
  if (await detail(element).evaluate(el => el.open) !== open) await summary(element).click();
  await until(() => detail(element).evaluate((el, expected) => el.open === expected, open), 'Actual disclosure state');
  if (key) await until(async () => (await snapshot()).viewState.readingPositions?.[key]?.folds?.[fold] === open, 'Manual group/row choice acknowledged');
}
async function run() {
  console.log('Synthetic profile:', profile);
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Own synthetic service ready'); await launch();
  const a = await create('Claude process A', 'claude'), b = await create('Codex process B', 'codex');
  await page.locator('#message-input').fill('UNSENT_PRIVATE_PROCESS_DRAFT');
  await until(async () => (await snapshot()).sessions.find(s => s.id === b).liveDraft === 'UNSENT_PRIVATE_PROCESS_DRAFT', 'Private draft saved');
  await page.locator('#room-nav').click(); await chooseRecipient(page, b); await fillRoomMessage(page, 'UNSENT_SHARED_PROCESS_DRAFT');
  const initial = await snapshot(), nativeIdentity = identity(initial), baseline = await fixture('stats');
  const keyA = `collaboration:shared:${a}`, keyB = `collaboration:shared:${b}`;
  await fixture('processTurn', a, { turnId: 'claude-turn-one', state: 'working' });
  for (const id of ['tool:bash-one', 'tool:bash-two']) await emit(a, id, { kind: 'tool', title: 'Bash', turnId: 'claude-turn-one', status: 'complete', input: `{"command":"echo ${id}"}`, text: `ORIGINAL_${id}` });
  await (await row(a, 'tool:bash-two')).waitFor({ state: 'attached' });
  let ga = await group(a, 'tool:bash-one');
  assert.equal(await reader(a).locator(':scope > [data-process-group]').count(), 1, 'The two painted native tools have one whole-process disclosure');
  await ga.waitFor();
  assert.match(await summary(ga).innerText(), /2 个命令/); assert.equal(await detail(ga).evaluate(el => el.open), false);
  assert.equal(await ga.locator(':scope > .process-latest').isVisible(), true);
  assert.equal(await ga.getAttribute('data-running'), 'true', 'Tool completion does not end the active native turn');
  await capture('01-active-native-tool-group');
  await emit(a, 'turn:claude-turn-one', { kind: 'turn', turnId: 'claude-turn-one', status: 'complete', text: '' });
  await until(() => detail(ga).evaluate(el => !el.open), 'Matching native boundary defaults group closed');
  assert.equal((await snapshot()).sessions.find(s => s.id === a).state, 'working', 'Boundary wins even before top-level metadata settles');
  check('Two original Claude tools form one collapsed disclosure; complete tools keep the active flag until an evidenced native turn boundary');
  const groupAKey = 'process:' + await nativeId(a, 'tool:bash-one');
  await summary(ga).focus(); await page.keyboard.press('Enter'); await until(() => detail(ga).evaluate(el => el.open), 'Enter expands group');
  await until(async () => (await snapshot()).viewState.readingPositions[keyA]?.folds?.[groupAKey] === true, 'Keyboard expansion acknowledged');
  await page.keyboard.press('Space'); await until(() => detail(ga).evaluate(el => !el.open), 'Space closes group');
  await until(async () => (await snapshot()).viewState.readingPositions[keyA]?.folds?.[groupAKey] === false, 'Keyboard close acknowledged');
  check('The native summary keyboard control expands/closes the same group and persists only its independent boolean choice');

  const original = 'ORIGINAL_SECOND_TOOL · 你好🙂\n' + Array.from({ length: 60 }, (_, i) => `Exact retained output ${i}`).join('\n');
  await fixture('processTurn', b, { turnId: 'codex-turn-two', state: 'working' });
  await emit(b, 'summary:public', { kind: 'summary', turnId: 'codex-turn-two', status: 'complete', text: 'PUBLIC_ORIGINAL_SUMMARY: this is native-provided display text.' });
  await emit(b, 'tool:second', { kind: 'tool', toolKind: 'commandExecution', commandSource: 'agent', commandActions: [{ type: 'unknown', command: 'npm test' }], turnId: 'codex-turn-two', status: 'complete', input: 'npm test', text: original });
  await emit(b, 'tool:failed-edit', { kind: 'tool', toolKind: 'fileChange', title: 'Edit', turnId: 'codex-turn-two', status: 'failed', input: '{"file_path":"/synthetic/example.txt"}', text: 'ORIGINAL_EDIT_FAILURE: exact unmatched text.\nOriginal trace retained.' });
  let gb = await group(b, 'summary:public'), second = await row(b, 'tool:second'); await gb.waitFor();
  await until(() => summary(gb).innerText().then(text => text.includes('失败 1')), 'Failed step painted in group heading');
  assert.match(await summary(gb).innerText(), /段思考摘要.*个命令.*失败 1/s);
  await toggle(gb, true, keyB, 'process:' + await nativeId(b, 'summary:public'));
  const publicSummary = await row(b, 'summary:public');
  await toggle(publicSummary, true, keyB, await nativeId(b, 'summary:public'));
  await publicSummary.locator('.message-body').getByText('PUBLIC_ORIGINAL_SUMMARY: this is native-provided display text.', { exact: true }).waitFor();
  await publicSummary.hover(); await publicSummary.locator(':scope > .message-actions').getByRole('button', { name: '复制', exact: true }).click();
  assert.equal(await app.evaluate(() => globalThis.groupCopies.at(-1)), 'PUBLIC_ORIGINAL_SUMMARY: this is native-provided display text.');
  await toggle(publicSummary, false, keyB, await nativeId(b, 'summary:public'));
  await toggle(second, true, keyB, await nativeId(b, 'tool:second')); assert.equal(await second.locator(':scope > details > .process-content > .message-body').textContent(), original);
  const body = second.locator(':scope > details > .process-content > .message-body');
  const selected = await body.evaluate(el => { const node = el.firstChild; getSelection().setBaseAndExtent(node, 0, node, 30); return getSelection().toString(); });
  await emit(a, 'tool:other-stream', { kind: 'tool', title: 'Read', turnId: 'another-a-turn', status: 'running', input: '{"file_path":"/synthetic/other.txt"}', text: 'OTHER_MEMBER_PROGRESS' });
  await emit(b, 'tool:retry', { kind: 'tool', toolKind: 'fileChange', title: 'Edit', turnId: 'codex-turn-two', status: 'complete', text: 'Retry completed; the original failure remains.' });
  await until(() => summary(gb).innerText().then(text => text.includes('2 次工具调用')), 'New step counted');
  assert.equal(await page.evaluate(() => getSelection().toString()), selected);
  const selectionBox = await page.evaluate(() => { const r = getSelection().getRangeAt(0).getBoundingClientRect(); return { x: r.left + 2, y: r.top + 2 }; });
  await page.mouse.click(selectionBox.x, selectionBox.y, { button: 'right' }); await page.getByRole('menuitem', { name: '复制', exact: true }).click();
  assert.equal(await app.evaluate(() => globalThis.groupCopies.at(-1)), selected);
  await second.hover(); await second.locator(':scope > .message-actions').getByRole('button', { name: '复制', exact: true }).click();
  assert.equal(await app.evaluate(() => globalThis.groupCopies.at(-1)), original);
  assert.match(await summary(gb).innerText(), /失败 1/); await capture('02-mixed-original-process-and-failure');
  check('Native public summary and mixed tools retain every original and earlier failure; growth/other-member output preserve selection and exact per-row/selection copies');

  await toggle(second, false, keyB, await nativeId(b, 'tool:second'));
  await toggle(gb, false, keyB, 'process:' + await nativeId(b, 'summary:public'));
  await emit(b, 'tool:later', { kind: 'tool', title: 'Read', turnId: 'codex-turn-two', status: 'complete', input: '{"file_path":"/synthetic/later.txt"}', text: 'LATER_ORIGINAL_STEP' });
  await emit(b, 'turn:codex-turn-two', { kind: 'turn', turnId: 'codex-turn-two', status: 'complete', text: '' });
  await until(() => detail(gb).evaluate(el => !el.open), 'Manual group close survives output and completion');
  assert.equal(await detail(second).evaluate(el => el.open), false);
  const beforeReload = identity(await snapshot()); await app.close(); app = null; await launch();
  gb = await group(b, 'summary:public'); await gb.waitFor(); second = await row(b, 'tool:second');
  assert.equal(await detail(gb).evaluate(el => el.open), false); assert.equal(await detail(second).evaluate(el => el.open), false);
  assert.deepEqual(identity(await snapshot()), beforeReload);
  assert.equal((await snapshot()).sessions.find(s => s.id === b).liveDraft, 'UNSENT_PRIVATE_PROCESS_DRAFT');
  assert.match(await page.locator('#shared-input').inputValue(), /UNSENT_SHARED_PROCESS_DRAFT/);
  check('Group and individual manual choices remain independent through later output, turn completion and GUI reopen, preserving native identities and both drafts');

  await page.locator(`.collaboration-member-status[data-member-id="${b}"] .collaboration-member-name`).click();
  const focused = `collaboration-focus:${b}`; gb = await group(b, 'summary:public', page.locator('#messages')); second = await row(b, 'tool:second', page.locator('#messages'));
  await toggle(gb, true, focused, 'process:' + await nativeId(b, 'summary:public'));
  await toggle(second, true, focused, await nativeId(b, 'tool:second')); await toggle(second, false, focused, await nativeId(b, 'tool:second'));
  await toggle(gb, false, focused, 'process:' + await nativeId(b, 'summary:public'));
  await page.locator('#search-button').click(); await page.locator('#search-input').fill('ORIGINAL_SECOND_TOOL');
  await until(() => page.locator('#search-results button').count().then(n => n === 1), 'One exact original tool search hit'); await page.locator('#search-results button').click();
  await until(() => second.evaluate(el => document.activeElement === el), 'Original hidden tool is synchronously revealed and focused');
  await until(() => detail(second).evaluate(el => el.open), 'Original tool body revealed');
  assert.equal(await detail(gb).evaluate(el => el.open), true); assert.equal(await second.locator('.message-body').textContent(), original);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  let saved = (await snapshot()).viewState.readingPositions[focused].folds;
  assert.equal(saved['process:' + await nativeId(b, 'summary:public')], false); assert.equal(saved[await nativeId(b, 'tool:second')], false);
  await summary(second).click(); await summary(gb).click(); await page.reload(); await page.locator('#messages').waitFor();
  gb = await group(b, 'summary:public', page.locator('#messages')); await until(() => detail(gb).evaluate(el => !el.open), 'Manual close after search does not reopen on reload');
  check('Search reveals and focuses the exact original behind both disclosures without changing saved choices; manual reclose survives rerender/reload');

  await page.locator('#room-record').click(); const sharedHost = page.locator('#room-messages');
  const stopped = await sharedHost.getByText('共享已停止 · SYNTHETIC_REVOKED', { exact: true }).all();
  assert.ok((await Promise.all(stopped.map(label => label.isVisible()))).some(Boolean), 'Existing sharing-revoked warning stays visible outside a collapsed process group');
  await until(() => sharedHost.locator(':scope > [data-process-group]').count().then(n => n === 2), 'Shared answer separates two original process groups');
  const sharedGroup = sharedHost.locator('[data-process-group="process:shared-3"]');
  await toggle(sharedGroup, true, 'room', 'process:shared-3'); await toggle(sharedGroup, false, 'room', 'process:shared-3');
  await page.locator('#room-search').fill('SHARED_MATCH');
  await until(() => sharedHost.locator(':scope > [data-process-group]').count().then(n => n === 2), 'Filtered originals remain distinct');
  assert.equal(await sharedHost.locator(':scope > [data-process-group] > details > summary:visible').count(), 0, 'A hidden answer/omitted source rows cannot be crossed');
  await page.locator('#room-search').fill('SHARED_MATCH_THIRD');
  const third = sharedHost.locator('[data-message-id="shared-3"]'); await toggle(third, true);
  await third.hover(); await third.locator(':scope > .message-actions').getByRole('button', { name: '查看上下文', exact: true }).click();
  await until(() => third.evaluate(el => document.activeElement === el), 'Context navigation focuses original after revealing its parent');
  assert.equal(await detail(sharedGroup).evaluate(el => el.open), true);
  saved = (await snapshot()).viewState.readingPositions.room.folds; assert.equal(saved['process:shared-3'], false);
  await capture('03-shared-source-context-and-boundaries');
  check('Shared provenance/answer/filter boundaries stay separate; context navigation synchronously reveals original rows without overwriting a saved group fold');
  await page.locator('#room-overview').click();
  const uncertainTurn = 'codex-turn-uncertain';
  await fixture('processTurn', b, { turnId: uncertainTurn, state: 'working' });
  await emit(b, 'tool:boundary-edit', { kind: 'tool', toolKind: 'fileChange', title: 'Edit', turnId: uncertainTurn, status: 'complete', text: 'ORIGINAL_BOUNDARY_EDIT' });
  await emit(b, 'tool:boundary-command', { kind: 'tool', toolKind: 'commandExecution', commandSource: 'agent', commandActions: [{ type: 'unknown', command: 'npm test' }], turnId: uncertainTurn, status: 'complete', input: 'npm test', text: 'ORIGINAL_BOUNDARY_COMMAND' });
  for (const [id, status] of [['a', 'complete'], ['u', 'unconfirmed'], ['b', 'complete']]) {
    await emit(b, 'tool:boundary-' + id, { kind: 'tool', toolKind: 'commandExecution', commandSource: 'agent', turnId: uncertainTurn, status,
      commandActions: [{ type: 'read', command: 'cat ' + id, name: id, path: '/synthetic/' + id }], input: 'cat ' + id, text: 'ORIGINAL_BOUNDARY_' + id.toUpperCase() });
  }
  await emit(b, 'turn:' + uncertainTurn, { kind: 'turn', turnId: uncertainTurn, status: 'complete', text: '' });
  const boundaryGroup = await group(b, 'tool:boundary-edit');
  await until(() => detail(boundaryGroup).evaluate(el => !el.open), 'Ended adjacent original group is folded');
  assert.equal(await boundaryGroup.locator('article[data-message-id]').count(), 2, 'An unconfirmed T29 member and its exploration siblings cannot nest inside an outer process group');
  const uncertainRow = await row(b, 'tool:boundary-u'), explorationRow = await row(b, 'tool:boundary-a');
  await summary(explorationRow).getByText('unconfirmed', { exact: true }).waitFor();
  await summary(uncertainRow).getByText('unconfirmed', { exact: true }).waitFor();
  assert.equal(await detail(explorationRow).evaluate(el => el.open), true);
  assert.equal(await uncertainRow.locator('.message-body').innerText(), 'ORIGINAL_BOUNDARY_U');
  assert.equal(await summary(boundaryGroup).locator('.message-heading > span').first().textContent(), '1 次工具调用 · 1 个命令');
  await capture('04-unconfirmed-exploration-boundary');
  check('An original unconfirmed T29 exploration stays outside adjacent folded groups with its exact status and original text visible');
  assert.deepEqual(errors, []); assert.deepEqual(identity(await snapshot()), nativeIdentity);
  const final = await fixture('stats'); assert.equal(final.stats.inputs, 0); assert.equal(final.stats.sends, 0);
  assert.deepEqual(final.overviewCalls, baseline.overviewCalls, 'All reading/disclosure/search/copy actions preserve ownership and native task calls');
  const result = { checks, errors, nativeStats: final.stats, workspaceCalls: final.overviewCalls, productModelCalls: 0, realProviderProcesses: 0, limits: 'Synthetic native transport; Claude thinking has no body here. No physical clipboard/IME/screenreader, installed or new native compatibility certification.' };
  fs.writeFileSync(path.join(profile, 'process-groups-result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
}
run().catch(async error => { console.error(error.stack); process.exitCode = 1; if (page && !page.isClosed()) await capture('failure').catch(() => {}); }).finally(async () => {
  try {
    await scratch.release(); const owner = JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))); assert.equal(owner.token, token);
    fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot);
    if (process.env.NAW_EVIDENCE_DIR) fs.writeFileSync(path.join(process.env.NAW_EVIDENCE_DIR, 'released.json'), JSON.stringify({ owner: 'Codex 3', task: 'T67 process groups', token, releasedAt: new Date().toISOString(), ownedProfilesAndProcessesGone: true, profile }, null, 2));
    console.log('Owned fixture cleaned; GUI slot released.');
  } catch (error) { console.error('Cleanup unconfirmed; own GUI lock retained:', error.stack); process.exitCode = 1; }
});
