// Actual isolated source GUI/service, synthetic native transport. No model,
// provider process, task input or real system clipboard read/write.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
if (process.env.NAW_EVIDENCE_DIR) {
  const target = path.resolve(process.env.NAW_EVIDENCE_DIR); let existing = target;
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  const destination = path.join(fs.realpathSync(existing), path.relative(existing, target));
  for (const base of [root, code].map(value => fs.realpathSync(value))) if (destination === base || destination.startsWith(base + path.sep)) throw Error('Evidence must be outside the repository; no GUI launched.');
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
}
const scratch = require('./fixtures/test-scratch.cjs');
const { createIn } = require('./fixtures/create-view.cjs');
const { _electron } = scratch.playwright(require('playwright'));
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID();
try { fs.mkdirSync(slot); } catch (error) { if (error.code !== 'EEXIST') throw error; console.error('GUI slot occupied; no test app launched.'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Codex 3', task: 'T66 failed tool reading', token, pid: process.pid, createdAt: new Date().toISOString() }));
const profile = scratch.directory(path.join(os.tmpdir(), 'naw-failed-tool-reading-'));
// Retained synthetic shared history, loaded through the actual workspace store.
// It creates no session and authorizes no delivery.
const sharedTool = { id: 'synthetic-retained-failed-tool', sessionId: 'synthetic-retained-member', nativeId: 'synthetic-retained-native',
  name: 'Historical fixture', role: 'tool', kind: 'tool', toolKind: 'fileChange', nativeBlock: true, title: 'Edit', status: 'failed',
  text: 'SHARED_QUERY_ERROR: retained original failure.\n' + 'Original shared trace.\n'.repeat(30), input: '{"file_path":"/synthetic/shared.txt"}', time: 1000 };
fs.writeFileSync(path.join(profile, 'workspace.json'), JSON.stringify({ sessions: [], room: { messages: [sharedTool] } }), { mode: 0o600 });
const child = scratch.childProcess.fork(path.join(code, 'app/daemon.cjs'), [profile], {
  execArgv: ['--require', path.join(__dirname, 'fixtures/native-progress.cjs')],
  env: { ...process.env, NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_WORKSPACE: profile, NAW_TEST_APP_ROOT: code },
  stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let app, page, sequence = 0; const checks = [], errors = [];
const originalInput = JSON.stringify({ file_path: '/synthetic/example.txt', old_string: 'SYNTHETIC_OLD_TEXT\n'.repeat(90), new_string: 'SYNTHETIC_NEW_TEXT\n'.repeat(90) });
const originalError = 'SYNTHETIC_EDIT_FAILURE: expected one match, found three.\n' + Array.from({ length: 90 }, (_, i) => `Original failure trace line ${i}: retained without rewriting.`).join('\n');
function fixture(method, target, value) {
  const id = ++sequence; return new Promise((resolve, reject) => {
    const callback = packet => { if (packet.requestId === id) { clearTimeout(timer); child.off('message', callback); packet.error ? reject(Error(packet.error)) : resolve(packet); } };
    const timer = setTimeout(() => { child.off('message', callback); reject(Error('Fixture reply timed out')); }, 10000);
    child.on('message', callback); child.send({ id, method, target, value });
  });
}
async function until(fn, label) { for (let i = 0; i < 160; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
const snapshot = () => page.evaluate(() => workspace.initial());
const identity = state => state.sessions.map(s => [s.id, s.nativeId, s.owner, s.view, s.controlRevision]).sort();
const check = value => { checks.push(value); console.log('PASS:', value); };
async function capture(name) {
  if (!process.env.NAW_SCREENSHOTS_DIR) return;
  fs.mkdirSync(process.env.NAW_SCREENSHOTS_DIR, { recursive: true });
  await page.screenshot({ path: path.join(process.env.NAW_SCREENSHOTS_DIR, `${name}.png`) });
}
async function create(name, provider) {
  await page.locator('#new-session').click(); await page.locator(`input[name="provider"][value="${provider}"]`).check();
  await page.locator('#session-name').fill(name); await createIn(page, 'chat');
  await until(async () => (await snapshot()).sessions.some(s => s.name === name && s.state === 'idle'), 'Synthetic session ready');
  const id = (await snapshot()).sessions.find(s => s.name === name).id;
  await page.getByRole('button', { name: '加入协作', exact: true }).click(); return id;
}
async function emit(id, itemId, status = 'failed', text = originalError) {
  await fixture('nativeBlock', id, { id: `tool:${itemId}`, kind: 'tool', title: 'Edit', toolKind: 'fileChange', turnId: 'failure-turn', input: originalInput, text, status });
}
async function row(id, prefix) {
  const state = await snapshot(), message = state.sessions.find(s => s.id === id).messages.find(m => m.nativeMessageId?.endsWith(prefix) || m.id.endsWith(`tool:${prefix}`));
  assert.ok(message, `Original native message ${prefix} exists`);
  return page.locator(`.collaboration-member-reader[data-member-id="${id}"] [data-message-id="${message.id}"]`);
}
const detail = element => element.locator(':scope > .process-details');
const summary = element => detail(element).locator(':scope > summary');
async function acknowledged(element, expected) {
  const messageId = await element.getAttribute('data-message-id');
  const memberId = await element.evaluate(el => el.closest('.collaboration-member-reader')?.dataset.memberId);
  await until(async () => {
    const state = await snapshot(), key = memberId ? `collaboration:${state.room.id || 'shared'}:${memberId}` : 'room';
    const choice = state.viewState.readingPositions?.[key]?.folds?.[messageId];
    return (typeof choice === 'boolean' ? choice : choice?.open) === expected;
  }, 'Manual choice acknowledged by existing reading metadata');
}
async function toggle(element, expected) {
  await summary(element).click(); await until(() => detail(element).evaluate((el, open) => el.open === open, expected), 'Manual details choice');
  await acknowledged(element, expected);
}
async function run() {
  console.log('Synthetic profile:', profile);
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Own synthetic service ready');
  app = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
  await page.locator('#new-session').waitFor();
  await app.evaluate(({ clipboard }) => { globalThis.failedToolCopies = []; clipboard.writeText = text => globalThis.failedToolCopies.push(text); });
  const a = await create('Failure reader A', 'claude'), b = await create('Other member B', 'codex');
  await page.locator('#room-nav').click();
  await emit(a, 'failed-edit'); await fixture('nativeBlock', a, { id: 'response:retry', kind: 'response', text: 'Subsequent retry succeeded; original failure stays retained.', status: 'complete' });
  let failed = await row(a, 'failed-edit'); await failed.waitFor();
  const before = await snapshot(), statsBefore = { ...(await fixture('stats')).stats };
  const baseline = { open: await detail(failed).evaluate(el => el.open), heading: await summary(failed).innerText(), height: (await failed.boundingBox()).height, originalInput: await failed.locator('.native-tool-input').textContent(), originalError: await failed.locator('.message-body').textContent() };
  fs.writeFileSync(path.join(profile, 'baseline-facts.json'), JSON.stringify(baseline, null, 2)); await capture('01-default-failed-tool');
  assert.equal(baseline.open, false, 'A complete failed tool defaults collapsed even after a successful retry');
  assert.match(baseline.heading, /failed/); assert.match(baseline.heading, /SYNTHETIC_EDIT_FAILURE: expected one match, found three\./);
  assert.ok(baseline.height < 140, `Failed tool remains bounded: ${baseline.height}`);
  assert.equal(baseline.originalInput, originalInput); assert.equal(baseline.originalError, originalError);
  check('Failed Edit is bounded by default with original failure marker/reason and full retained input/output');
  const updatedError = originalError.replace('found three.', 'found four.');
  await emit(a, 'failed-edit', 'failed', updatedError);
  await until(() => summary(failed).innerText().then(text => text.includes('found four.')), 'Original error reason updates without a status change');
  assert.equal(await failed.locator('.message-body').textContent(), updatedError); assert.equal(await detail(failed).evaluate(el => el.open), false);
  await emit(a, 'failed-edit');
  await until(() => summary(failed).innerText().then(text => text.includes('found three.')), 'Original error reason restored');
  await toggle(failed, true); await failed.locator('.message-body').waitFor();
  assert.equal(await failed.locator('.native-tool-input').textContent(), originalInput); assert.equal(await failed.locator('.message-body').textContent(), originalError);
  await failed.hover(); await failed.getByRole('button', { name: '复制', exact: true }).click();
  assert.equal(await app.evaluate(() => globalThis.failedToolCopies.at(-1)), originalError);
  const selected = await failed.locator('.message-body').evaluate(el => { const range = document.createRange(); range.selectNodeContents(el); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); return selection.toString(); });
  await fixture('nativeBlock', b, { id: 'response:other', kind: 'response', text: 'Other member continues streaming.', status: 'streaming' });
  await until(() => page.locator(`.collaboration-member-reader[data-member-id="${b}"]`).innerText().then(text => text.includes('Other member continues')), 'Other member streaming');
  assert.equal(await detail(failed).evaluate(el => el.open), true); assert.equal(await page.evaluate(() => getSelection().toString()), selected);
  await emit(a, 'failed-edit'); assert.equal(await page.evaluate(() => getSelection().toString()), selected);
  await capture('02-manually-open-full-original');
  check('Manual open/read/exact source copy and selection survive same-record rerender and another member streaming');
  await toggle(failed, false); await emit(a, 'failed-edit');
  await fixture('nativeBlock', b, { id: 'response:other', kind: 'response', text: 'Other member continues streaming again.', status: 'streaming' });
  assert.equal(await detail(failed).evaluate(el => el.open), false);
  await page.reload(); await page.locator('#new-session').waitFor(); failed = await row(a, 'failed-edit');
  assert.equal(await detail(failed).evaluate(el => el.open), false);
  await summary(failed).focus(); await page.keyboard.press('Enter');
  await until(() => detail(failed).evaluate(el => el.open), 'Keyboard opens existing disclosure');
  await acknowledged(failed, true);
  await page.reload(); await page.locator('#new-session').waitFor(); failed = await row(a, 'failed-edit');
  assert.equal(await detail(failed).evaluate(el => el.open), true);
  await toggle(failed, false);
  check('Manual close and open each survive stream/rerender and real renderer reload without changing originals');
  await emit(a, 'transition', 'running', 'Synthetic edit in progress.'); let transition = await row(a, 'transition'); await transition.waitFor();
  assert.equal(await detail(transition).evaluate(el => el.open), false); await toggle(transition, true);
  await emit(a, 'transition', 'failed');
  await until(() => transition.locator('.message-body').textContent().then(text => text === originalError), 'Failed source update actually rendered');
  assert.equal(await detail(transition).evaluate(el => el.open), true);
  const completion = 'Synthetic later completion retains explicit open choice.';
  await emit(a, 'transition', 'complete', completion);
  await until(() => transition.locator('.message-body').textContent().then(text => text === completion), 'Complete source update actually rendered');
  assert.equal(await detail(transition).evaluate(el => el.open), true);
  await toggle(transition, false); await emit(a, 'transition', 'failed');
  await until(() => transition.locator('.message-body').textContent().then(text => text === originalError), 'Subsequent failure actually rendered');
  assert.equal(await detail(transition).evaluate(el => el.open), false);
  await page.reload(); await page.locator('#new-session').waitFor(); transition = await row(a, 'transition'); assert.equal(await detail(transition).evaluate(el => el.open), false);
  check('Explicit detail choices win across running/failed/complete transitions and remain persisted');
  await emit(a, 'transition', 'complete', 'Original complete trace with an older explicit open choice.');
  await until(() => transition.locator('.message-body').textContent().then(text => text.startsWith('Original complete trace')), 'Final complete source before legacy metadata setup');
  await delay(100);
  const messageId = await transition.getAttribute('data-message-id'), current = await snapshot();
  const key = `collaboration:${current.room.id || 'shared'}:${a}`, positions = structuredClone(current.viewState.readingPositions);
  positions[key].folds[messageId] = { open: true, error: 'failed' };
  await page.evaluate(value => workspace.readingState(value), positions);
  assert.deepEqual((await snapshot()).viewState.readingPositions[key].folds[messageId], { open: true, error: 'failed' });
  await page.reload(); await page.locator('#new-session').waitFor(); transition = await row(a, 'transition'); assert.equal(await detail(transition).evaluate(el => el.open), true);
  await toggle(transition, false); await emit(a, 'transition', 'unconfirmed', 'Native result remains unconfirmed; no failure is invented.');
  await until(() => transition.locator('.message-body').textContent().then(text => text.startsWith('Native result remains unconfirmed')), 'Unconfirmed original actually rendered');
  await toggle(transition, true); await toggle(transition, false);
  await page.reload(); await page.locator('#new-session').waitFor(); transition = await row(a, 'transition'); assert.equal(await detail(transition).evaluate(el => el.open), false);
  check('Existing legacy object choices and supported boolean metadata preserve intent without schema changes or invented failure');
  await page.locator('#room-record').click(); const retained = page.locator(`#room-messages [data-message-id="${sharedTool.id}"]`); await retained.waitFor();
  assert.equal(await detail(retained).evaluate(el => el.open), false);
  await page.locator('#room-search').fill('SHARED_QUERY_ERROR'); await until(() => detail(retained).evaluate(el => el.open), 'Explicit local query reveals previously unchosen source');
  await toggle(retained, false);
  await fixture('nativeBlock', b, { id: 'response:other', kind: 'response', text: 'Other member updates while a local shared query is active.', status: 'streaming' });
  await page.locator('#room-search').fill('SHARED_QUERY_ERROR:');
  assert.equal(await detail(retained).evaluate(el => el.open), false);
  await until(async () => (await snapshot()).viewState.roomSearch === 'SHARED_QUERY_ERROR:', 'Local query metadata acknowledged');
  await page.reload(); await page.locator('#new-session').waitFor(); await page.locator('#room-record').click();
  assert.equal(await detail(retained).evaluate(el => el.open), false); assert.equal(await retained.locator('.message-body').textContent(), sharedTool.text);
  check('An explicit local query reveals source, then a manual close wins over rerender, query changes and reload');
  await page.locator('#room-overview').click();
  const command = 'npm test -- --runInBand', commandOutput = '> fixture test\nPreparing fixture checks.\nERROR: synthetic test failure\n';
  await fixture('nativeBlock', b, { id: 'tool:failed-command', kind: 'tool', toolKind: 'commandExecution', title: 'Run', turnId: 'failed-command-turn', input: command, text: commandOutput, status: 'failed', exitCode: 1 });
  const commandRow = await row(b, 'failed-command'); await commandRow.waitFor();
  assert.equal(await detail(commandRow).evaluate(el => el.open), false);
  assert.equal(await commandRow.locator('.process-label').textContent(), command, 'A failed native command keeps its command preview');
  assert.equal((await summary(commandRow).innerText()).split(command).length - 1, 1);
  assert.equal(await commandRow.locator('.process-tail').textContent(), '> fixture test\nPreparing fixture checks.');
  await toggle(commandRow, true); assert.equal(await commandRow.locator('.native-tool-input').textContent(), command);
  await commandRow.hover(); await commandRow.getByRole('button', { name: '复制', exact: true }).click();
  assert.equal(await app.evaluate(() => globalThis.failedToolCopies.at(-1)), commandOutput); await toggle(commandRow, false);
  const bashCommand = 'node /synthetic/check.cjs', bashInput = JSON.stringify({ command: bashCommand }), bashOutput = 'Preparing synthetic script.\nERROR: synthetic script failed\nOriginal Bash trace retained.\n';
  await fixture('nativeBlock', a, { id: 'tool:failed-bash', kind: 'tool', title: 'Bash', turnId: 'failed-bash-turn', input: bashInput, text: bashOutput, status: 'failed' });
  const bashRow = await row(a, 'failed-bash'); await bashRow.waitFor();
  assert.equal(await detail(bashRow).evaluate(el => el.open), false);
  assert.equal(await bashRow.locator('.process-label').textContent(), bashCommand, 'A failed Claude Bash keeps its existing parsed command preview');
  assert.equal((await summary(bashRow).innerText()).split(bashCommand).length - 1, 1);
  assert.equal(await bashRow.locator('.process-tail').textContent(), 'Preparing synthetic script.\nERROR: synthetic script failed');
  await toggle(bashRow, true); assert.equal(await bashRow.locator('.native-tool-input').textContent(), bashInput);
  await bashRow.hover(); await bashRow.getByRole('button', { name: '复制', exact: true }).click();
  assert.equal(await app.evaluate(() => globalThis.failedToolCopies.at(-1)), bashOutput); await toggle(bashRow, false);
  await capture('04-failed-commands-preserve-preview');
  check('Failed Codex command and Claude Bash keep their original command preview once, bounded output and exact trace/copy');
  const after = await snapshot(); assert.deepEqual(identity(after), identity(before)); assert.deepEqual((await fixture('stats')).stats, statsBefore);
  assert.deepEqual(errors, []); const final = { checks, errors, productModelCalls: 0, realProviderProcesses: 0, nativeStats: statsBefore, limitations: 'Actual source Electron/DSH/service, synthetic native transport; deterministic DOM Range selection and clipboard method interception, no physical input/OS clipboard read-write/installed proof.' };
  fs.writeFileSync(path.join(profile, 'final-snapshot.json'), JSON.stringify(after, null, 2));
  fs.writeFileSync(path.join(process.env.NAW_EVIDENCE_DIR || profile, 'failed-tool-result.json'), JSON.stringify(final, null, 2));
  await capture('03-manually-closed-final'); console.log(JSON.stringify(final, null, 2));
}
run().catch(async error => { console.error(error.stack); process.exitCode = 1; if (page && !page.isClosed()) await capture('failure').catch(() => {}); }).finally(async () => {
  try { await scratch.release(); const owner = JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))); assert.equal(owner.token, token); fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot); console.log('Owned fixture cleaned; GUI slot released.'); }
  catch (error) { console.error('Cleanup not confirmed; retain owned GUI lock:', error.stack); process.exitCode = 1; }
});
