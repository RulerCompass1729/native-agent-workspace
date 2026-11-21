// Four complete GUI journeys on the actual source DSH shell. Synthetic calls
// are labelled; this never qualifies an original Claude/Codex producer.
const scratch = require('./fixtures/test-scratch.cjs');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto'), { once } = require('node:events');
const { _electron } = scratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..');
const { connectService } = require('../app/service-connection.cjs');
const { processIdentity, processMayBeAlive } = require('../app/platform.cjs');
const evidence = process.env.NAW_EVIDENCE_DIR;
if (!evidence || !path.isAbsolute(evidence)) throw Error('An explicit private evidence directory is required');
fs.mkdirSync(evidence, { recursive: true });
const canonicalEvidence = fs.realpathSync(evidence), canonicalRoot = fs.realpathSync(root);
if (canonicalEvidence === canonicalRoot || canonicalEvidence.startsWith(canonicalRoot + path.sep)) throw Error('GUI evidence must be outside the repository; no slot or profile was allocated');
const common = require('node:child_process').execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID();
try { fs.mkdirSync(slot); } catch (error) { if (error.code !== 'EEXIST') throw error; console.error('Canonical GUI slot occupied; zero allocation and no launch.'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ token, owner: 'Codex4', task: 'T164 1a four synthetic source journeys', pid: process.pid, at: new Date().toISOString() }));
const pictures = path.join(process.env.NAW_PICTURES_DIR || path.join(os.homedir(), 'Pictures/naw-dogfood'), new Date().toISOString().slice(0, 7), 't164-' + token);
let profile, cwd, child, client, app, page, source, sequence = 0, launchCount = 0, expired = false;
const checks = [], errors = [], trace = [], geometry = [], activeStartedAt = Date.now();
const guiProcesses = [];
let deadline;
const files = ['app/operator-control.cjs', 'app/workspace.cjs', 'app/claude-message-tool.cjs', 'app/claude-submit.cjs', 'app/claude-bridge/hooks/register.js', 'app/renderer/renderer.js', 'app/renderer/reading-list.js', 'app/renderer/styles.css', 'app/dsh/client.js'];
const hashes = () => Object.fromEntries(files.map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
const sourceBefore = hashes();
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { for (let n = 0; n < 100; n++) { if (expired) throw Error('Active GUI budget exhausted'); if (await fn()) return; await wait(50); } throw Error(label); }
const state = () => client.call('initial');
const session = async id => (await state()).sessions.find(s => s.id === id);
function fixture(method, target, value) {
  if (expired) return Promise.reject(Error('Active GUI budget exhausted'));
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.off('message', receive); reject(Error('Synthetic fixture timed out')); }, 5000);
    const receive = result => { if (method === 'operatorCall' ? result.operatorRequestId !== id : result.requestId !== id) return; clearTimeout(timer); child.off('message', receive); trace.push({ method, target, value, result }); fs.writeFileSync(path.join(evidence, 'trace.json'), JSON.stringify(trace, null, 2)); resolve(result); };
    child.on('message', receive); child.send({ id, operatorRequestId: id, method, target, value });
  });
}
async function tool(id, name, args, callId = randomUUID()) { const response = await fixture('operatorCall', id, { name: 'workspace_' + name, arguments: args, callId }); if (response.error) throw Error(response.error); return response.result; }
async function launch() {
  if (expired) throw Error('Active GUI budget exhausted');
  assert.ok(++launchCount <= 2, 'Only initial launch plus one owned reopen');
  app = await _electron.launch({ args: [root], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 30000 });
  const identity = processIdentity(app.process().pid); if (!identity) throw Error('Owned GUI identity could not be recorded'); guiProcesses.push(identity);
  fs.writeFileSync(path.join(evidence, 'allocated.json'), JSON.stringify({ token, profile, childPid: child.pid, guiProcesses, at: new Date().toISOString(), sourceBefore }));
  page = await app.firstWindow(); page.setDefaultTimeout(8000); page.on('pageerror', error => errors.push(error.message)); await page.locator('#new-session').waitFor(); await page.locator('#message-input').waitFor();
}
async function choose(id) { await page.locator(`.session-link[data-session-id="${id}"]`).click(); }
async function menu(id, label) { await page.locator(`[data-session-menu="${id}"]`).click(); await page.getByRole('menuitem', { name: label, exact: true }).click(); }
async function capture(label) { await page.screenshot({ path: path.join(pictures, label + '.png') }); fs.writeFileSync(path.join(evidence, label + '.json'), JSON.stringify(await state(), null, 2)); }
async function readableCard(card, label) {
  assert.equal(await card.count(), 1); await card.scrollIntoViewIfNeeded();
  if (await card.locator(':scope > .operator-task-details').count()) await card.locator(':scope > .operator-task-details').evaluate(el => { el.open = true; });
  const outer = await card.boundingBox(), body = await card.locator('.message-body').first().boundingBox();
  geometry.push({ label, card: outer, body }); fs.writeFileSync(path.join(evidence, 'geometry.json'), JSON.stringify(geometry, null, 2));
  assert.ok(outer && body && body.width >= outer.width * 0.6, 'Report body must remain readable beside its controls');
}
// B5: the person names a space in the grant form. The session created under that grant then joins the space by
// itself and is recorded there; the task stays undelivered. Synthetic backend, no model, no native process.
async function spaceGrantJourney(card, args) {
  const desk = () => page.evaluate(() => workspace.initial());
  const space = card.locator('select').nth(1), consent = card.locator('input[type=checkbox]'), sentence = card.locator('label').filter({ has: page.locator('input[type=checkbox]') }).locator('span');
  assert.equal(await space.inputValue(), '', 'The form starts with no space, as a grant has always been');
  assert.equal(await sentence.innerText(), '允许上面厂商、目录及权限在我填的额度和期限内建会话；会产生厂商用量。首条任务和报告通知当前不会投递。');
  await card.locator('input[type=number]').nth(0).fill('1'); await card.locator('input[type=number]').nth(1).fill('1');
  await card.locator('select').first().selectOption('custom');
  const expiry = new Date(Date.now() + 3600000); expiry.setMinutes(expiry.getMinutes() - expiry.getTimezoneOffset()); await card.locator('input[type=datetime-local]').fill(expiry.toISOString().slice(0, 16));
  await consent.check();
  await space.selectOption('shared');
  assert.equal(await consent.isChecked(), false, 'Choosing a space clears the tick: it is a different consent');
  const name = await space.locator('option[value="shared"]').innerText();
  assert.equal(await sentence.innerText(), `允许上面厂商、目录及权限在我填的额度和期限内建会话，建出的会话加入「${name}」成为那里的成员，并接那里排队的活；会产生厂商用量。首条任务和报告通知当前不会投递。`);
  await card.scrollIntoViewIfNeeded(); await capture('space-01-form-zh');
  await page.locator('#setup-button').click(); await page.locator('#ui-language').selectOption('en');
  await until(async () => await card.locator('button[type=submit]').textContent() === 'Allow and create', 'Grant labels repaint to English');
  const english = await space.locator('option[value="shared"]').innerText();
  assert.equal(await sentence.innerText(), `Allow creation for this provider, directory and permission within my quotas and expiry; the sessions created join “${english}” as members and are sent the work queued there. Provider usage may incur costs. Initial tasks and report notifications are not delivered in this phase.`);
  assert.equal(await space.inputValue(), 'shared'); assert.equal(await card.locator('input[type=number]').nth(0).inputValue(), '1');
  // Nothing in the card keeps the earlier language, the new field and sentence included.
  const leftover = await card.evaluate(form => {
    const box = form.closest('.operator-controls');
    const texts = [...box.querySelectorAll('*')].filter(element => !element.childElementCount).map(element => element.textContent);
    return texts.concat([...box.querySelectorAll('[aria-label]')].map(element => element.getAttribute('aria-label'))).filter(text => /[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/.test(text));
  });
  assert.deepEqual(leftover, [], 'Nothing in the card stays in Chinese after the switch to English');
  await page.locator('#close-setup').click(); if (await page.locator('#stream-waiting-list').isHidden()) await page.locator('.stream-waiting-more').click(); await card.scrollIntoViewIfNeeded(); await capture('space-02-form-en');
  await page.locator('#setup-button').click(); await page.locator('#ui-language').selectOption('zh'); await page.locator('#close-setup').click();
  if (await page.locator('#stream-waiting-list').isHidden()) await page.locator('.stream-waiting-more').click();
  await card.getByRole('button', { name: '允许并创建', exact: true }).click();
  // The cleared tick is a required field, so the form itself refuses to submit: nothing is saved, nothing created.
  await wait(800);
  assert.equal(await consent.evaluate(element => element.validity.valueMissing), true);
  assert.equal((await state()).sessions.length, 1); assert.equal((await state()).operatorPolicy.domains.length, 0, 'Not saved without the tick');
  await consent.check(); await card.getByRole('button', { name: '允许并创建', exact: true }).click();
  await until(async () => (await state()).sessions.length === 2, 'Exactly one session created');
  const [domain] = (await state()).operatorPolicy.domains;
  assert.equal(domain.space, 'shared'); assert.equal(domain.daily, 1);
  const executor = (await state()).sessions.find(s => s.id !== source).id;
  await until(async () => (await desk()).rooms.find(room => room.id === 'shared').events.some(event => event.monitor?.kind === 'opened' && event.monitor.sessionId === executor && event.monitor.joined === true), 'The desktop joined it to the space and recorded it');
  await until(async () => require('../app/collaboration-spaces.cjs').roomIds(await session(executor)).includes('shared'), 'The new session is a member');
  const created = await tool(source, 'open', args);
  assert.equal(created.status, 'created'); assert.equal(created.sessionId, executor); assert.equal(created.space, 'shared'); assert.equal(created.placement, 'joined'); assert.equal(created.delivery, 'pending-1b');
  const openRowId = 'operator:open:' + JSON.stringify([(await session(source)).nativeId, args.action_id]);
  const row = page.locator('#messages [data-message-id=' + JSON.stringify(openRowId) + ']');
  await until(async () => (await row.innerText()).includes(`建出的会话加入「${name}」`), 'The saved grant shows the space');
  await until(async () => (await row.innerText()).includes(`新会话已加入「${name}」`), 'The row says what the desktop did with the new session');
  await row.scrollIntoViewIfNeeded(); await capture('space-03-created-and-joined');
  // Over quota: a second open is refused in the backend; nothing is created or placed.
  await tool(source, 'open', { ...args, action_id: 'gui-space-two' }).then(() => assert.fail('over quota'), error => assert.match(error.message, /quota is exhausted/));
  await wait(1500);
  assert.equal((await state()).sessions.length, 2);
  assert.equal((await desk()).rooms.find(room => room.id === 'shared').events.filter(event => event.monitor?.kind === 'opened').length, 1);
  const stats = await fixture('stats'); assert.equal(stats.sends.length, 0); assert.equal(stats.inputs.length, 0); assert.equal(stats.modelCalls, 0); assert.equal(stats.nativeProcesses, 0);
  assert.equal(await page.locator('#message-input').inputValue(), 'ORIGINAL UNSENT INITIATOR DRAFT'); assert.deepEqual(errors, []); assert.deepEqual(hashes(), sourceBefore);
  checks.push('The person chose a space in the grant form under its own consent sentence (Chinese and English); the session created under the grant joined that space by itself and was recorded; the task stayed undelivered; over quota nothing was created');
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ checks, sourceBefore, sourceAfter: hashes(), launchCount, activeSeconds: (Date.now() - activeStartedAt) / 1000, pictures, profile, trace, stats, errors }, null, 2));
}
async function creationCardJourney() {
  const desk = () => page.evaluate(() => workspace.initial());
  const observer = await client.call('create', { provider: 'claude', cwd, name: 'Other session', view: 'terminal' });
  await choose(observer);
  await until(async () => (await desk()).viewState.selected === observer, 'Other native terminal selected');
  const original = (await session(source)).nativeId;
  const args = { action_id: 'card-one', provider: 'claude', cwd, name: 'Synthetic helper', task: ('Full synthetic task <literal>\n').repeat(90), permission: process.env.NAW_TEST_OPERATOR_BYPASS === '1' ? 'bypass' : 'default' };
  await tool(source, 'open', args);
  await tool(source, 'open', { ...args, action_id: 'card-two', name: 'Second helper' });
  await until(async () => (await page.locator('.stream-waiting-count').innerText()).includes('2'), 'Both requests counted above terminal');
  const omitted = (await desk()).sessions.find(s => s.id === source);
  assert.equal(omitted.messagesOmitted, true, 'Discovery does not load the initiator conversation');
  await page.locator('.stream-waiting-more').click();
  const rows = page.locator('#stream-waiting-list .operator-creation-card');
  const cardFor = action => page.locator('#stream-waiting-list [data-waiting-id=' + JSON.stringify('operator-creation:' + source + ':' + JSON.stringify([original, action])) + '] .operator-creation-card');
  const first = cardFor('card-one');
  await first.waitFor();
  if (args.permission === 'bypass') {
    const warning = first.locator('.operator-bypass'); assert.match(await warning.innerText(), /跳过确认/);
    assert.ok(await warning.evaluate(el => Number(getComputedStyle(el).fontWeight) >= 700), 'Bypass permission is visually emphasized');
  }
  const form = first.locator('form'), daily = form.locator('input[type=number]').nth(0), concurrent = form.locator('input[type=number]').nth(1), consent = form.locator('input[type=checkbox]'), space = form.locator('select').nth(1);
  assert.equal(await daily.inputValue(), '1'); assert.equal(await concurrent.inputValue(), '1'); assert.equal(await space.inputValue(), ''); assert.equal(await consent.isChecked(), false);
  assert.equal(await form.locator('input[type=datetime-local]').isVisible(), false);
  assert.equal(await first.locator('.operator-task-details').evaluate(e => e.open), false);
  assert.equal(await first.locator('.operator-task-body').textContent(), args.task);
  assert.equal(await form.locator('.operator-task-body literal').count(), 0, 'Task is literal text');
  await form.getByRole('button', { name: '允许并创建', exact: true }).click();
  assert.equal((await state()).operatorPolicy.domains.length, 0); assert.equal((await state()).sessions.length, 2);
  await capture('card-01-terminal-discovery');
  const inputHandle = await daily.elementHandle(), formHandle = await form.elementHandle();
  await daily.fill('3'); await concurrent.fill('3'); await consent.check();
  await page.evaluate(id => workspace.rename(id, 'Renamed observer'), observer);
  await page.locator('#setup-button').click(); await page.locator('#ui-language').selectOption('en');
  await until(async () => (await form.locator('button[type=submit]').textContent()) === 'Allow and create', 'English labels painted');
  assert.equal(await daily.evaluate((el, old) => el === old, inputHandle), true);
  assert.equal(await form.evaluate((el, old) => el === old, formHandle), true);
  assert.equal(await daily.inputValue(), '3'); assert.equal(await consent.isChecked(), true);
  const before = await desk(); assert.equal(before.viewState.selected, observer); assert.equal(before.sessions.find(s => s.id === source).nativeId, original);
  await page.locator('#close-setup').click();
  if (await page.locator('#stream-waiting-list').isHidden()) await page.locator('.stream-waiting-more').click();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(850, 780));
  await first.scrollIntoViewIfNeeded();
  const overflow = await first.evaluate(el => ({ width: el.clientWidth, scroll: el.scrollWidth, text: el.innerText }));
  assert.ok(overflow.scroll <= overflow.width + 1, 'Narrow English card has no horizontal overflow');
  await capture('card-02-en-850');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 880));
  await page.locator('#setup-button').click(); await page.locator('#ui-language').selectOption('zh'); await page.locator('#close-setup').click();
  if (await page.locator('#stream-waiting-list').isHidden()) await page.locator('.stream-waiting-more').click();
  await space.selectOption('shared'); assert.equal(await consent.isChecked(), false); await consent.check();
  const untilMs = await form.locator('input[type=datetime-local]').evaluate(e => new Date(e.value).getTime());
  await capture('card-03-zh-scope');
  await form.evaluate(el => { el.requestSubmit(); el.requestSubmit(); });
  await until(async () => (await state()).sessions.length === 3, 'One session after double submit');
  assert.equal((await state()).operatorPolicy.domains.length, 1); const domain = (await state()).operatorPolicy.domains[0];
  assert.equal(domain.daily, 3); assert.equal(domain.concurrent, 3); assert.equal(domain.expiresAt, untilMs); assert.equal(domain.permission, args.permission); assert.equal(domain.space, 'shared');
  const covered = cardFor('card-two');
  await covered.getByRole('button', { name: '使用已有授权', exact: true }).waitFor();
  assert.match(await covered.innerText(), /已被授权/); assert.match(await covered.innerText(), /每天（UTC）最多 3 个/); assert.match(await covered.innerText(), /队列任务/);
  assert.equal(await covered.locator('.operator-new-grant').evaluate(el => el.open), false);
  await capture('card-04-covered');
  await covered.getByRole('button', { name: '使用已有授权', exact: true }).click();
  await until(async () => (await state()).sessions.length === 4, 'Covered request reused the same domain');
  assert.equal((await state()).operatorPolicy.domains.length, 1);
  const result = await tool(source, 'open', args); assert.equal(result.status, 'created'); assert.equal(result.delivery, 'pending-1b');
  assert.equal((await session(result.sessionId)).operatorEnabled, false); assert.equal((await session(source)).liveDraft, 'ORIGINAL UNSENT INITIATOR DRAFT');
  assert.equal((await desk()).viewState.selected, observer, 'Human never left the selected terminal');
  await choose(source);
  const inline = page.locator('#messages [data-message-id]').filter({ has: page.locator('.operator-controls') });
  await until(async () => await inline.count() >= 2, 'Original records loaded');
  assert.equal(await page.locator('#messages .operator-grant').count(), 0, 'No duplicate inline forms');
  const task = page.locator('#messages [data-message-id=' + JSON.stringify('operator:open:' + JSON.stringify([original, 'card-one'])) + '] > .operator-task-details');
  assert.equal(await task.evaluate(el => el.open), false);
  await task.locator('summary').click(); assert.match(await task.innerText(), /Full synthetic task <literal>/);
  await capture('card-05-original-fold');
  const stats = await fixture('stats'); assert.equal(stats.sends.length, 0); assert.equal(stats.inputs.length, 0); assert.equal(stats.modelCalls, 0); assert.equal(stats.nativeProcesses, 0); assert.deepEqual(errors, []);
  checks.push('Two hidden-initiator requests counted above another native terminal; one form each; folded literal task, safe defaults and explicit consent',
    'Same input and form nodes, values and consent survive language and unrelated state updates; 850px English card has no horizontal overflow',
    'Double submit saves one exact domain and creates one session; existing coverage names scope and reuses without a new grant; no implicit task dispatch or executor authority',
    'Selected terminal, native identity and original draft survive; original record folds its full task and has no duplicate grant form');
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ checks, stats, errors, pictures, domain, launchCount }, null, 2));
}
async function quotaJourney() {
  const desk = () => page.evaluate(() => workspace.initial()), native = (await session(source)).nativeId;
  const observer = await client.call('create', { provider: 'claude', cwd, name: 'Quota observer', view: 'terminal' });
  await client.call('operatorAction', observer, 'enabled', true);
  const spec = { providers: ['claude'], directories: [cwd], permission: 'default', daily: 8, concurrent: 6, expiresAt: Date.now() + 3600000, space: 'shared' };
  const domainId = await client.call('operatorAction', source, 'grant', spec), otherId = await client.call('operatorAction', observer, 'grant', { ...spec, daily: 4, concurrent: 2 });
  const open = action_id => tool(source, 'open', { action_id, provider: 'claude', cwd, name: 'Quota executor', task: 'Synthetic quota task', permission: 'default' });
  const one = await open('quota-one'); await open('quota-two'); await choose(observer);
  assert.equal((await desk()).operatorCreations.length, 0);
  const actor = { id: source, nativeId: native, name: 'Synthetic quota actor', provider: 'claude', callId: 'quota-call', turnId: 'quota-turn', operationId: 'quota-operation' };
  const edit = { domainId, daily: 16, concurrent: 6, revision: 0, nativeId: native, consent: true };
  await assert.rejects(require('../app/background-operation.cjs').run(actor, () => client.call('operatorAction', source, 'quota', edit)), /Only the person/);
  await assert.rejects(tool(source, 'quota', edit), /Invalid operator tool|Unknown operator tool/);
  await page.locator('.operator-grants-toggle').click();
  const card = page.locator('#operator-grants-list [data-domain-id=' + JSON.stringify(domainId) + ']');
  await card.waitFor(); assert.equal(await page.locator('#operator-grants-list .operator-quota-card').count(), 2);
  assert.match(await card.innerText(), /2 \/ 8/); assert.match(await card.innerText(), /2 \/ 6/);
  assert.equal(await page.locator('.stream-waiting-lead').isHidden(), true, 'Valid grants are not pending requests');
  await capture('quota-01-no-pending');
  await card.getByRole('button', { name: '调整额度', exact: true }).click();
  const form = card.locator('form'), daily = form.locator('input[type=number]').nth(0), concurrent = form.locator('input[type=number]').nth(1), consent = form.locator('input[type=checkbox]'), save = form.locator('button[type=submit]');
  assert.equal(await daily.inputValue(), '8'); assert.equal(await concurrent.inputValue(), '6'); assert.equal(await consent.isChecked(), false); assert.equal(await save.isDisabled(), true);
  await daily.fill('16'); await consent.check(); await concurrent.fill('5'); assert.equal(await consent.isChecked(), false); await concurrent.fill('6'); await consent.check();
  const handle = await daily.elementHandle(); await open('quota-live-update');
  await until(async () => (await card.innerText()).includes('3 / 8'), 'Actual usage updates while editing');
  assert.equal(await daily.evaluate((el, before) => el === before, handle), true); assert.equal(await daily.inputValue(), '16'); assert.equal(await consent.isChecked(), true);
  await page.locator('#setup-button').click(); await page.locator('#ui-language').selectOption('en'); await page.locator('#close-setup').click();
  await page.locator('.operator-grants-toggle').click();
  assert.equal(await daily.evaluate((el, before) => el === before, handle), true); assert.equal(await consent.isChecked(), true);
  assert.match(await card.innerText(), /stays at 6/); assert.match(await card.innerText(), /changes from 8 to 16/);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(850, 820)); await card.scrollIntoViewIfNeeded();
  assert.ok(await card.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'English quota card has no horizontal overflow at 850px'); await capture('quota-02-en-increase');
  await form.evaluate(el => { el.requestSubmit(); el.requestSubmit(); });
  await until(async () => (await state()).operatorPolicy.domains.find(d => d.id === domainId).quotaRevision === 1, 'One doubled daily quota');
  let domain = (await state()).operatorPolicy.domains.find(d => d.id === domainId);
  assert.deepEqual([domain.daily, domain.concurrent, domain.usage.usedToday, domain.usage.concurrent, domain.expiresAt], [16, 6, 3, 3, spec.expiresAt]);
  await card.getByRole('button', { name: 'Adjust limits', exact: true }).click(); await daily.fill('24'); await consent.check();
  await client.call('operatorAction', source, 'quota', { ...edit, daily: 12, revision: 1 });
  await until(async () => (await card.innerText()).includes('grant or holder changed'), 'Concurrent human edit invalidates old consent');
  assert.equal(await consent.isChecked(), false); assert.equal(await save.isDisabled(), true); await capture('quota-03-stale');
  await card.getByRole('button', { name: 'Cancel', exact: true }).click(); await card.getByRole('button', { name: 'Adjust limits', exact: true }).click();
  await daily.fill('1'); await concurrent.fill('1'); assert.equal(await consent.isChecked(), false); assert.equal(await save.isDisabled(), true);
  assert.match(await card.innerText(), /leave existing sessions running/); await consent.check(); await save.click();
  await until(async () => (await state()).operatorPolicy.domains.find(d => d.id === domainId).quotaRevision === 3, 'Decreased quotas saved with new consent');
  await assert.rejects(open('quota-refused-new'), /quota is exhausted/);
  domain = (await state()).operatorPolicy.domains.find(d => d.id === domainId);
  assert.deepEqual([domain.daily, domain.concurrent, domain.usage.usedToday, domain.usage.concurrent], [1, 1, 3, 3]);
  assert.equal((await session(one.sessionId)).state, 'idle'); assert.equal((await state()).operatorPolicy.domains.length, 2);
  assert.equal((await state()).operatorPolicy.domains.find(d => d.id === otherId).daily, 4, 'A different grant is unchanged');
  await capture('quota-04-lower-than-used');
  assert.equal((await desk()).viewState.selected, observer); assert.equal((await session(source)).nativeId, native); assert.equal((await session(source)).liveDraft, 'ORIGINAL UNSENT INITIATOR DRAFT');
  await client.call('operatorAction', source, 'revoke', domainId);
  await until(async () => await card.count() === 0, 'Revoked grant removed from active cards');
  assert.equal(await page.locator('#operator-grants-list .operator-quota-card').count(), 1);
  const stats = await fixture('stats'); assert.equal(stats.sends.length, 0); assert.equal(stats.inputs.length, 0); assert.equal(stats.modelCalls, 0); assert.equal(stats.nativeProcesses, 0); assert.deepEqual(errors, []);
  checks.push('No pending request: both active grants show scope, actual UTC daily use, concurrency and expiry above another native terminal',
    'Increase8->16 and decrease12->1 require fresh consent; every edit resets it; current use3 survives, no expiry/scope reset and no other domain changes',
    'Same input/value/consent survives real creation usage update and language switch; 850px English readable; double submit writes one quota revision',
    'Concurrent revision invalidates old consent; revoked domain disappears; decrease blocks new creation while existing native identities, sessions and original draft remain',
    'Authenticated background-actor service wire and native operator tool both refuse quota edits before write; no product model/provider/native input/send');
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ checks, stats, errors, pictures, domain, otherId, launchCount }, null, 2));
}
async function run() {
  fs.mkdirSync(pictures, { recursive: true });
  profile = scratch.directory(path.join(os.tmpdir(), 'naw-operator-')); cwd = path.join(profile, 'workspace'); fs.mkdirSync(cwd, { mode: 0o700 }); cwd = fs.realpathSync(cwd);
  child = scratch.childProcess.fork(path.join(root, 'app/daemon.cjs'), [profile], { cwd, execArgv: ['--require', path.join(__dirname, 'fixtures/operator-control.cjs')],
    env: { ...process.env, NAW_TEST_APP_ROOT: root, NAW_WORKSPACE: cwd, NAW_APP_VERSION: require('../package.json').version }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  fs.writeFileSync(path.join(evidence, 'allocated.json'), JSON.stringify({ token, profile, childPid: child.pid, at: new Date().toISOString(), sourceBefore }));
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Owned synthetic service boots'); client = await connectService(profile, 'operator-owner');
  source = await client.call('create', { provider: 'claude', cwd, name: 'Synthetic initiator', view: 'chat' });
  fs.writeFileSync(path.join(profile, 'views.json'), JSON.stringify([{ owner: 'operator-owner', active: true, selected: source, mode: 'chat' }]), { mode: 0o600 });
  await client.call('draft', source, 'ORIGINAL UNSENT INITIATOR DRAFT');
  // This journey starts in an existing shared space; an empty unused legacy room is deliberately hidden.
  await client.call('join', source, true);
  await launch();
  await page.locator('#room-more').click(); await page.getByRole('menuitem', { name: '启用 agent 控制接口…', exact: true }).click();
  await menu(source, '允许此会话使用控制接口'); await until(async () => (await session(source)).operatorEnabled, 'Source explicitly enabled');
  if (process.env.NAW_TEST_OPERATOR_CARD === '1') return creationCardJourney();
  if (process.env.NAW_TEST_OPERATOR_QUOTA === '1') return quotaJourney();
  const args = { action_id: 'gui-one', provider: 'claude', cwd, task: 'Synthetic pending creation task', permission: 'default' };
  const pending = await tool(source, 'open', args); assert.equal(pending.status, 'pending-authorization');
  await page.locator('.stream-waiting-lead').click();
  const card = page.locator('#stream-waiting-list .operator-grant'); await card.waitFor();
  if (process.env.NAW_TEST_OPERATOR_SPACE === '1') return spaceGrantJourney(card, args);
  await card.locator('input[type=number]').nth(0).fill('2'); await card.locator('input[type=number]').nth(1).fill('2');
  await card.locator('select').first().selectOption('custom');
  const expiry = new Date(Date.now() + 3600000); expiry.setMinutes(expiry.getMinutes() - expiry.getTimezoneOffset()); await card.locator('input[type=datetime-local]').fill(expiry.toISOString().slice(0, 16));
  await card.locator('input[type=checkbox]').check();
  await page.locator('#setup-button').click(); await page.locator('#ui-language').selectOption('en');
  await until(async () => await card.locator('button[type=submit]').textContent() === 'Allow and create', 'Grant labels repaint to English');
  assert.equal(await card.locator('input[type=number]').nth(0).inputValue(), '2'); assert.equal(await card.locator('input[type=checkbox]').isChecked(), true);
  // Nothing in the card keeps the earlier language: labels read their inner words when painted, not when the card was drawn.
  const leftover = await card.evaluate(form => {
    const box = form.closest('.operator-controls');
    const texts = [...box.querySelectorAll('*')].filter(element => !element.childElementCount).map(element => element.textContent);
    return texts.concat([...box.querySelectorAll('[aria-label]')].map(element => element.getAttribute('aria-label'))).filter(text => /[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/.test(text));
  });
  assert.deepEqual(leftover, [], 'Nothing in the card stays in Chinese after the switch to English');
  await page.locator('#ui-language').selectOption('zh'); await page.locator('#close-setup').click();
  if (await page.locator('#stream-waiting-list').isHidden()) await page.locator('.stream-waiting-more').click();
  await card.getByRole('button', { name: '允许并创建', exact: true }).click();
  await until(async () => (await state()).sessions.length === 2, 'Exactly one executor created');
  const created = await tool(source, 'open', args), executor = created.sessionId; assert.equal(created.status, 'created');
  const openRowId = 'operator:open:' + JSON.stringify([(await session(source)).nativeId, args.action_id]);
  await readableCard(page.locator('#messages [data-message-id=' + JSON.stringify(openRowId) + ']'), 'private-open');
  assert.equal((await state()).sessions.length, 2); assert.equal((await fixture('stats')).sends.length, 0); assert.equal((await session(executor)).operatorEnabled, false);
  assert.equal(await page.locator('#message-input').inputValue(), 'ORIGINAL UNSENT INITIATOR DRAFT'); await capture('01-explicit-grant-idempotent-create');
  checks.push('Explicit global/session enable and human grant quotas/expiry create once; initial task not delivered; executor has no general interface; original draft unchanged');

  await client.call('join', executor, true);
  const report = (extra = {}) => tool(executor, 'report', { request_id: created.requestId, dispatch_id: created.dispatchId, state: 'blocked', body: 'RAW REPORT <literal> 中文', question: 'Exact question for the person?', ...extra });
  const reported = await report(); const question = page.locator('.operator-attention').filter({ hasText: 'Exact question for the person?' }); await until(async () => await question.count() > 0, 'Question highlighted in original initiator');
  assert.ok((await state()).room.messages.some(m => m.operator?.requestId === created.requestId));
  await page.locator('#room-nav').click(); await page.locator('#room-record').click();
  await page.locator('#room-filter').selectOption(executor);
  const commonReport = page.locator(`#room-messages [data-message-id="operator:report:${reported.reportId}"]`); await commonReport.waitFor(); assert.equal(await commonReport.count(), 1);
  await readableCard(commonReport, 'shared-report');
  await capture('02-common-space-filter'); await page.locator('#room-filter').selectOption(''); await choose(source);
  const reportRow = page.locator(`#messages [data-message-id="operator:report:${reported.reportId}"]`); assert.equal(await reportRow.count(), 1);
  await readableCard(reportRow, 'private-question'); await capture('02-private-question');
  await reportRow.getByRole('button', { name: '打开执行者会话', exact: true }).click();
  await until(async () => await page.locator(`.session-link.active[data-session-id="${executor}"]`).count() === 1, 'The original dispatch executor is selected');
  await until(async () => (await page.locator('#message-input').evaluate(el => el === document.activeElement)), 'Exact executor composer focused');
  if (await page.locator('#message-input').getAttribute('readonly') !== null) {
    const claim = page.locator('#send-button'); assert.equal(await claim.count(), 1); assert.equal(await claim.innerText(), '接管此窗口');
    await claim.click();
    await until(async () => await page.locator('#message-input').getAttribute('readonly') === null, 'Explicit human takeover makes its existing composer editable');
  }
  await page.locator('#message-input').fill('Synthetic human answer'); await page.locator('#send-button').click();
  await choose(source); await until(() => page.getByText('你已回复，等执行者更新', { exact: true }).first().isVisible(), 'Proven human reply removes question emphasis');
  assert.equal((await session(source)).liveDraft, 'ORIGINAL UNSENT INITIATOR DRAFT'); await capture('02-question-visible-human-answer');
  checks.push('Saved report is visible privately and in the common space; exact executor link focuses its composer; actual GUI human send retains question and changes attention to answered');

  await report({ state: 'ready', question: null }).then(() => assert.fail('ready+question must be refused'), error => assert.match(error.message, /ready/));
  const ready = await tool(executor, 'report', { request_id: created.requestId, dispatch_id: created.dispatchId, state: 'ready', body: 'Ready evidence, still awaiting review' });
  await until(() => page.getByText('成果待审', { exact: true }).first().isVisible(), 'Ready is reviewable');
  const readyRow = page.locator(`#messages [data-message-id="operator:report:${ready.reportId}"]`); assert.equal(await readyRow.count(), 1);
  await readyRow.getByRole('button', { name: '已收下', exact: true }).click();
  await until(() => page.getByText('已结束：已收下', { exact: true }).first().isVisible(), 'Human explicitly accepts');
  const acceptedCreation = page.locator('#messages [data-message-id=' + JSON.stringify(openRowId) + ']');
  await acceptedCreation.getByText('已作废，未投递', { exact: true }).waitFor();
  assert.match(await acceptedCreation.locator('.message-body').first().innerText(), /首条任务：/);
  assert.doesNotMatch(await acceptedCreation.locator('.message-body').first().innerText(), /待投递的任务/);
  await report({ state: 'progress' }).then(() => assert.fail('closed report must be refused'), error => assert.match(error.message, /closed/));
  const second = await tool(source, 'open', { ...args, action_id: 'gui-two', task: 'Second pending task' }); assert.equal(second.status, 'created');
  // A newly created record changes the menu action order. Wait for that actual UI update before opening it.
  await page.locator('.session-link[data-session-id=' + JSON.stringify(second.sessionId) + ']').waitFor();
  await menu(source, '撤销此会话的建会话许可');
  await tool(second.sessionId, 'report', { request_id: second.requestId, dispatch_id: second.dispatchId, state: 'progress', body: 'Must not be accepted after revocation' }).then(() => assert.fail('revoked report'), error => assert.match(error.message, /revoked/));
  const openRow = page.locator('[data-message-id]').filter({ hasText: 'Second pending task' });
  await openRow.getByRole('button', { name: '撤销请求…', exact: true }).click();
  assert.equal(await openRow.getByText('撤销会作废尚未执行的动作。已发生的副作用撤不回，原生会话继续运行。', { exact: true }).count(), 1);
  await openRow.getByRole('button', { name: '确认撤销请求', exact: true }).click();
  await until(() => openRow.getByText('已结束：已撤销', { exact: true }).isVisible(), 'Human cancellation keeps its reason');
  await openRow.getByText('已作废，未投递', { exact: true }).waitFor();
  assert.match(await openRow.locator('.message-body').first().innerText(), /首条任务：/); await capture('03-accept-cancel-revoke');
  checks.push('Ready does not close a request; explicit accept and warned cancellation retain different reasons; revoked/closed reports are refused and no native session is stopped');

  const before = await state(); await app.close(); app = null; await launch();
  const after = await state(); assert.deepEqual(after.sessions.map(s => ({ id: s.id, nativeId: s.nativeId })), before.sessions.map(s => ({ id: s.id, nativeId: s.nativeId })));
  const restored = after.sessions.find(s => s.id === source).messages;
  assert.ok(restored.some(m => m.operator?.reportId === reported.reportId && m.operator.closedReason === 'accepted'));
  assert.ok(restored.some(m => m.operator?.requestId === second.requestId && m.operator.closedReason === 'cancelled'));
  await page.locator(`#messages [data-message-id="operator:report:${ready.reportId}"]`).getByText('已结束：已收下', { exact: true }).waitFor();
  await page.locator('[data-message-id]').filter({ hasText: 'Second pending task' }).getByText('已结束：已撤销', { exact: true }).waitFor();
  assert.equal((await session(source)).liveDraft, 'ORIGINAL UNSENT INITIATOR DRAFT');
  const stats = await fixture('stats'); assert.equal(stats.sends.length, 1); assert.equal(stats.inputs.length, 0); assert.equal(stats.modelCalls, 0); assert.equal(stats.nativeProcesses, 0); assert.deepEqual(errors, []); assert.deepEqual(hashes(), sourceBefore);
  await capture('04-reopened-same-records'); checks.push('One ordinary owned reopen retains reports, closure reasons, original IDs and unsent draft; exactly one intended synthetic human send, zero native input/provider/model calls');
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ checks, sourceBefore, sourceAfter: hashes(), launchCount, activeSeconds: (Date.now() - activeStartedAt) / 1000, pictures, profile, trace, geometry, stats, errors }, null, 2));
}
const cleanup = scratch.cleanup(async () => { if (app) await app.close(); client?.close(); if (child?.connected) child.disconnect(); if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } });
Promise.race([run(), new Promise((_, reject) => { deadline = setTimeout(() => { expired = true; reject(Error('150-second final-source GUI budget exhausted')); }, 150000); })]).catch(async error => { console.error(error.stack); fs.writeFileSync(path.join(evidence, 'failure.txt'), error.stack); try { if (page && !page.isClosed()) await capture('failure'); } catch {} process.exitCode = 1; }).finally(async () => {
  clearTimeout(deadline);
  try {
    await cleanup(); const owner = JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))); assert.equal(owner.token, token); if (profile) assert.equal(fs.existsSync(profile), false);
    assert.equal(guiProcesses.some(identity => processMayBeAlive(identity)), false);
    fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot);
    fs.writeFileSync(path.join(evidence, 'released.json'), JSON.stringify({ token, releasedAt: new Date().toISOString(), ownedCleanupConfirmed: true, profile, guiProcesses, childExit: child?.exitCode, childSignal: child?.signalCode }));
    console.log(JSON.stringify({ checks, modelCalls: 0, realProviderProcesses: 0, slotReleased: true }));
  } catch (error) { console.error('Owned cleanup/lease release unconfirmed:', error.stack); process.exitCode = 1; }
});
