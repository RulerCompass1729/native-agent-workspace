// Real source Electron/DSH/daemon/IPC; native output and version omissions are synthetic.
// The owning-backend mapping itself is covered by workspace-client.test.cjs.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), { randomUUID, createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const scratch = require('./fixtures/test-scratch.cjs'), { createIn } = require('./fixtures/create-view.cjs');
const { _electron } = scratch.playwright(require('playwright'));
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID();
const evidence = process.env.NAW_EVIDENCE_DIR;
let profile, owned, workspacePath, child, slotOwned = false;
function setup() {
  if (evidence) {
    const target = path.resolve(evidence); let existing = target;
    while (!fs.existsSync(existing)) existing = path.dirname(existing);
    const destination = path.join(fs.realpathSync(existing), path.relative(existing, target));
    for (const base of [root, code].map(p => fs.realpathSync(p))) assert.ok(destination !== base && !destination.startsWith(base + path.sep));
  }
  try { fs.mkdirSync(slot); } catch (e) { if (e.code !== 'EEXIST') throw e; console.error('GUI slot occupied; nothing started.'); process.exit(75); }
  slotOwned = true;
  fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Codex4', task: 'T93 whole refresh/dialog zero-model source GUI', token, pid: process.pid, time: new Date().toISOString() }));
  if (evidence) fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
  profile = scratch.directory(path.join(os.tmpdir(), 'naw-dialog-lifecycle-'));
  owned = fs.realpathSync(profile); workspacePath = path.join(profile, 'workspace');
  fs.mkdirSync(workspacePath, { mode: 0o700 }); assert.ok(fs.realpathSync(workspacePath).startsWith(owned + path.sep));
  fs.writeFileSync(path.join(workspacePath, 'fixture.txt'), 'Synthetic file contents');
  child = scratch.childProcess.fork(path.join(code, 'app/daemon.cjs'), [profile], {
    execArgv: ['--require', path.join(root, 'scripts/fixtures/dialog-lifecycle.cjs')],
    env: { ...process.env, NAW_TEST_APP_ROOT: code, NAW_WORKSPACE: workspacePath, NAW_APP_VERSION: require(path.join(code, 'package.json')).version },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
}
const sourceFiles = ['app/renderer/renderer.js', 'app/renderer/index.html', 'app/renderer/search-view.js', 'app/renderer/styles.css', 'app/native-usage.js', 'app/workspace-client.cjs', 'scripts/test-dialog-lifecycle.cjs', 'scripts/fixtures/dialog-lifecycle.cjs', 'app/dsh/client.js'];
const hashes = () => Object.fromEntries(sourceFiles.map(f => [f, createHash('sha256').update(fs.readFileSync(path.join(code, f))).digest('hex')]));
const sourceBefore = hashes(), checks = [], errors = [], measurements = [];
let app, page, sequence = 0, failure;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { for (let i = 0; i < 200; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
function fixture(method, target, value) {
 const id = ++sequence; return new Promise((resolve, reject) => {
 const callback = reply => { if (reply.requestId === id) { clearTimeout(timer); child.off('message', callback); reply.error ? reject(Error(reply.error)) : resolve(reply); } };
 const timer = setTimeout(() => { child.off('message', callback); reject(Error('Fixture timed out')); }, 12000);
 child.on('message', callback); child.send({ id, method, target, value }); });
}
const snapshot = () => page.evaluate(() => workspace.initial());
const row = id => page.locator(`.session-row[data-session-row="${id}"]`);
const check = text => { checks.push(text); console.log('PASS:', text); };
async function capture(name) { if (evidence) await page.screenshot({ path: path.join(evidence, name + '.png') }); }
async function launch() {
 app = await _electron.launch({ executablePath: require('electron'), args: [code], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
 page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message)); await page.locator('#new-session').waitFor();
 await app.evaluate(({ app, ipcMain, dialog, clipboard }, paths) => {
  // Wrap the actual main IPC handler. Holds can be before or after real local
  // persistence; synthetic failures are explicit. Never patch renderer handlers.
  const t = globalThis.t93 = { policies: {}, waiting: {}, counts: {}, usage: {}, closedFiles: 0, clipboard: 0 };
  clipboard.writeText = clipboard.readText = () => { t.clipboard++; throw Error('OS clipboard prohibited in this test'); };
  dialog.showOpenDialog = async (_win, options) => ({ canceled: false, filePaths: [options.properties.includes('openDirectory') ? paths.workspace : paths.file] });
  dialog.showSaveDialog = async () => ({ canceled: true });
  const preflight = { claude: true, codex: true, python: true, paths: {}, configured: {} };
  for (const name of ['initial', 'create', 'preflight', 'runtimeLocation', 'roomNotes', 'join', 'viewState', 'chooseFolder', 'openLocalFile', 'closeLocalFile', 'importHistory', 'run', 'send', 'input', 'forward', 'approve', 'answer', 'queue', 'steer']) {
   const key = 'workspace:' + name, original = ipcMain._invokeHandlers.get(key); if (!original) throw Error(key);
   t.counts[name] = 0; ipcMain.removeHandler(key);
   ipcMain.handle(key, async (...args) => {
    t.counts[name] = (t.counts[name] || 0) + 1;
    if (name === 'closeLocalFile') t.closedFiles++;
    const policy = t.policies[name]; delete t.policies[name];
    const wait = async () => { if (policy) await new Promise(resolve => { t.waiting[name] = resolve; }); };
    if (policy?.before) await wait();
    if (policy?.before && policy.fail) return { ok: false, error: 'Synthetic delayed ' + name + ' failure' };
    let result = name === 'preflight' || name === 'runtimeLocation' ? { ok: true, value: preflight } : await original(...args);
    if (name === 'initial' && result.ok) { result.value.preflight = preflight; for (const s of result.value.sessions) if (Object.hasOwn(t.usage, s.id)) s.usage = t.usage[s.id]; }
    if (policy && !policy.before) await wait();
    if (policy?.fail) result = { ok: false, error: 'Synthetic delayed ' + name + ' failure' };
    return result;
   });
  }
 }, { workspace: workspacePath, file: path.join(workspacePath, 'fixture.txt') });
}
async function arm(name, policy = {}) { await app.evaluate((_, q) => { globalThis.t93.policies[q.name] = q.policy; }, { name, policy }); }
async function held(name) { await until(() => app.evaluate((_, n) => Boolean(globalThis.t93.waiting[n]), name), 'IPC held: ' + name); }
async function release(name) { await app.evaluate((_, n) => { const fn = globalThis.t93.waiting[n]; delete globalThis.t93.waiting[n]; if (!fn) throw Error('Not held: ' + n); fn(); }, name); }
async function closed(id, kind = 'outside', button) {
 assert.equal(await page.locator('#' + id).evaluate(el => el.open), true);
 if (kind === 'outside') await page.mouse.click(4, 4);
 else if (kind === 'escape') await page.keyboard.press('Escape');
 else await page.locator('#' + button).click();
 await page.locator('#' + id).waitFor({ state: 'hidden' });
 await until(() => page.locator('#' + id).evaluate(el => el.scrollTop === 0), 'Close cleanup: ' + id);
 // Let the queued close event run before examining transient DOM.
 await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function create(name, provider) {
 const before = new Set((await snapshot()).sessions.map(s => s.id));
 await page.locator('#new-session').click(); await page.locator(`input[name="provider"][value="${provider}"]`).check(); await page.locator('#session-name').fill(name); await createIn(page, 'chat');
 const s = (await snapshot()).sessions.find(s => !before.has(s.id)); assert.ok(fs.realpathSync(s.cwd).startsWith(owned + path.sep)); return s.id;
}
async function usageDialog() {
 if (await page.locator('#usage-button').isVisible()) await page.locator('#usage-button').click();
 else { await page.locator('#session-header-more').click(); await page.getByRole('menuitem', { name: '用量', exact: true }).click(); }
}
async function shareSelection() {
 const action = page.getByRole('button', { name: '分享选中内容', exact: true });
 if (await action.isVisible()) await action.click();
 else { await page.locator('#session-header-more').click(); await page.getByRole('menuitem', { name: '分享选中内容', exact: true }).click(); }
}
async function terminalDisplayDialog() {
 if (await page.locator('#terminal-display').isVisible()) await page.locator('#terminal-display').click();
 else { await page.locator('#terminal-more').click(); await page.getByRole('menuitem', { name: '显示…', exact: true }).click(); }
}
async function notes() { if (!(await page.locator('#room-notes').isVisible())) await page.locator('#room-record').click(); await page.locator('#room-notes').click(); await page.locator('#notes-dialog').waitFor(); }
async function run() {
 setup(); await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Owned daemon ready'); await launch();
 const initial = await snapshot(); assert.ok(fs.realpathSync(initial.defaultWorkspace).startsWith(owned + path.sep));
 assert.equal(await page.locator('dialog[closedby="any"]').count(), 12);
 // All three ordinary cancellation paths discard inputs; no create or permissions.
 const count = initial.sessions.length;
 for (const kind of ['outside', 'escape', 'button']) {
  await page.locator('#new-session').click(); await page.locator('#session-name').fill('Discarded private edit'); await page.locator('#skip-permissions').check();
  await closed('create-dialog', kind, 'cancel-create'); assert.equal(await page.locator('#session-name').inputValue(), ''); assert.equal(await page.locator('#skip-permissions').isChecked(), false); assert.equal(await page.locator('#chosen-folder').textContent(), '');
 }
 assert.equal((await snapshot()).sessions.length, count);
 await page.locator('#new-session').click(); const box = await page.locator('#session-name').boundingBox();
 await page.mouse.move(box.x + 5, box.y + 5); await page.mouse.down(); await page.mouse.move(4, 4); await page.mouse.up(); assert.equal(await page.locator('#create-dialog').evaluate(d => d.open), true);
 const ime = await page.context().newCDPSession(page); await page.locator('#session-name').focus(); await ime.send('Input.imeSetComposition', { text: '拼音', selectionStart: 2, selectionEnd: 2 }); await page.keyboard.press('Escape'); assert.equal(await page.locator('#create-dialog').evaluate(d => d.open), true);
 await ime.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 }); await closed('create-dialog', 'escape'); await ime.detach();
 check('Native backdrop/button/Escape discard private create fields without creating/approving; inside-drag stays open and CDP composing Escape is protected');
 const codex = await create('Fixture Codex', 'codex'), claude = await create('Fixture Claude', 'claude');
 const reportedAt = 1760000000000;
 const usage = { [codex]: { total: { inputTokens: 1200, cachedInputTokens: 300, outputTokens: 60 }, last: { inputTokens: 200, outputTokens: 10 }, modelContextWindow: 200000, reportedAt }, [claude]: { source: 'claude-session-usage', context: { tokens: 3200, window: 200000, percent: 1.6 }, costUsd: 0.0123, rateLimits: [], reportedAt } };
 await app.evaluate((_, value) => { globalThis.t93.usage = value; }, usage);
 await page.locator('#privacy-button').click(); await until(async () => (await page.locator('#trust-refresh-status').innerText()).startsWith('已刷新本机状态'), 'Initial refresh completion');
 await arm('initial'); await page.locator('#refresh-trust').click(); await held('initial'); assert.equal(await page.locator('#refresh-trust').isDisabled(), true); assert.equal(await page.locator('#refresh-trust').innerText(), '正在刷新…');
 const reads = await app.evaluate(() => globalThis.t93.counts.initial); await page.locator('#refresh-trust').evaluate(b => b.click()); assert.equal(await app.evaluate(() => globalThis.t93.counts.initial), reads);
 await capture('01-refresh-busy'); await release('initial'); await until(async () => (await page.locator('#trust-refresh-status').innerText()).startsWith('已刷新本机状态'), 'Refresh finished');
 const globalUsage = await page.locator('#trust-status').innerText(); assert.match(globalUsage, /累计 token/); assert.match(globalUsage, /原生 \/cost 累计金额/); await capture('02-refreshed-usage');
 await arm('initial', { fail: true }); await page.locator('#refresh-trust').click(); await held('initial'); await release('initial'); await until(async () => (await page.locator('#trust-refresh-status').innerText()).includes('Synthetic delayed initial failure'), 'Refresh failure'); assert.equal(await page.locator('#refresh-trust').isDisabled(), false);
 await arm('initial'); await page.locator('#refresh-trust').click(); await held('initial'); await closed('privacy-dialog'); await release('initial'); await delay(80); assert.equal(await page.locator('#trust-status').textContent(), ''); assert.equal(await page.locator('#trust-refresh-status').textContent(), '');
 for (const id of [codex, claude]) {
  await row(id).locator('.session-link').click(); await usageDialog(); await until(async () => (await page.locator('#trust-refresh-status').innerText()).startsWith('已刷新本机状态'), 'Scoped usage');
  assert.equal(await page.locator('[data-usage-session]').count(), 1); assert.equal(await page.locator('[data-usage-session]').getAttribute('data-usage-session'), id); const text = await page.locator('#trust-status').innerText(); assert.ok(text.includes(new Date(reportedAt).toLocaleString()));
  await capture(id === codex ? '03-codex-scoped' : '04-claude-scoped'); await closed('privacy-dialog', 'escape');
 }
 await app.evaluate((_, id) => { globalThis.t93.usage[id] = null; }, claude); await usageDialog(); await until(async () => (await page.locator('#trust-status').innerText()).includes('原生用量未报告；不能据此判断为零。'), 'Unknown usage reason'); await closed('privacy-dialog', 'button', 'close-privacy');
 check('Local refresh shows busy/deduplicates/completion/error, closed refresh cannot refill; both providers retain scoped source timestamps and missing usage is explicit');
 // Old create ACK preserves accepted record but cannot close a newer modal/select it.
 await page.locator('#new-session').click(); await page.locator('#session-name').fill('Accepted after dismissal'); await arm('create'); await page.locator('#confirm-create').click(); await held('create'); assert.equal(await page.locator('#cancel-create').isDisabled(), false); await closed('create-dialog', 'button', 'cancel-create');
 await page.locator('#search-button').click(); await release('create'); await until(async () => (await snapshot()).sessions.some(s => s.name === 'Accepted after dismissal'), 'Accepted row remains'); await delay(100); assert.equal(await page.locator('#search-dialog').evaluate(d => d.open), true); assert.equal((await snapshot()).viewState.selected, claude); await closed('search-dialog');
 check('Accepted create survives cancellation in sidebar without selecting it or closing the newer search dialog');
 // Setup refresh and program-choice callbacks must not reopen or populate hidden paths.
 await page.locator('#setup-button').click(); await page.locator('#setup-status .setup-program').first().waitFor(); await arm('preflight'); await page.locator('#refresh-setup').click(); await held('preflight'); await closed('setup-dialog'); await release('preflight'); await delay(80); assert.equal(await page.locator('#setup-status').textContent(), '');
 await page.locator('#setup-button').click(); await page.locator('#setup-status .setup-program').first().waitFor(); await arm('runtimeLocation'); await page.locator('#setup-status .setup-program').first().getByRole('button', { name: '选择已有程序…', exact: true }).click(); await held('runtimeLocation'); await closed('setup-dialog', 'escape'); await release('runtimeLocation'); await delay(80); assert.equal(await page.locator('#setup-dialog').evaluate(d => d.open), false); assert.equal(await page.locator('#version-info').textContent(), '');
 check('Setup late refresh and program-choice acknowledgements never reopen a dismissed modal or restore paths');
 // Saved notes survive, cancelled notes clear, and each old callback targets its own opening.
 await page.locator('#room-nav').click(); await page.locator('#room-advanced').evaluate(d => { d.open = true; });
 await notes(); await page.locator('#room-notes-text').fill('Saved original notes'); await page.locator('#save-notes').click(); await page.locator('#notes-dialog').waitFor({ state: 'hidden' });
 await notes(); assert.equal(await page.locator('#room-notes-text').inputValue(), 'Saved original notes'); await page.locator('#room-notes-text').fill('Cancelled notes'); await closed('notes-dialog'); assert.equal(await page.locator('#room-notes-text').inputValue(), '');
 await notes(); assert.equal(await page.locator('#room-notes-text').inputValue(), 'Saved original notes'); await page.locator('#room-notes-text').fill('Accepted first notes'); await arm('roomNotes'); await page.locator('#save-notes').click(); await held('roomNotes'); await closed('notes-dialog', 'escape');
 await notes(); await page.locator('#room-notes-text').fill('New unsaved notes'); await release('roomNotes'); await delay(100); assert.equal(await page.locator('#notes-dialog').evaluate(d => d.open), true); assert.equal(await page.locator('#room-notes-text').inputValue(), 'New unsaved notes'); await closed('notes-dialog', 'button', 'cancel-notes');
 // Failure before persistence is separate from accepted persistence.
 await notes(); await arm('roomNotes', { before: true, fail: true }); await page.locator('#room-notes-text').fill('Old failure'); await page.locator('#save-notes').click(); await held('roomNotes'); await closed('notes-dialog'); await notes(); await page.locator('#room-notes-text').fill('Fresh error-free editor'); await release('roomNotes'); await delay(100); assert.equal(await page.locator('#notes-error').isVisible(), false); assert.equal(await page.locator('#room-notes-text').inputValue(), 'Fresh error-free editor'); await closed('notes-dialog', 'escape');
 check('Notes cancellation clears transient edits while saved notes survive; old save success/failure cannot close or write into a reopened editor');
 // Invite late acceptance must leave a reopened invitation intact.
 await page.locator('#manage-members').click(); await arm('join'); await page.locator(`[data-invite-session="${codex}"]`).click(); await held('join'); await closed('invite-dialog'); await page.locator('#manage-members').click(); await release('join'); await delay(100); assert.equal(await page.locator('#invite-dialog').evaluate(d => d.open), true); await closed('invite-dialog', 'button', 'close-invite'); assert.equal(await page.locator('#invite-list').textContent(), '');
 await page.locator('#manage-members').click(); await page.locator(`[data-invite-session="${claude}"]`).click(); await page.locator('#invite-dialog').waitFor({ state: 'hidden' });
 // Context late persistence must not close a new editor. Draft insertion remains accepted.
 await page.locator('#room-advanced').evaluate(d => { d.open = true; }); await page.locator('#attach-context').click(); await page.locator('#context-text').fill('Accepted background'); await arm('viewState'); await page.locator('#insert-context').click(); await held('viewState'); await closed('context-dialog');
 await page.locator('#room-advanced').evaluate(d => { d.open = true; }); await page.locator('#attach-context').click(); await page.locator('#context-text').fill('Fresh background edit'); await release('viewState'); await delay(100); assert.equal(await page.locator('#context-dialog').evaluate(d => d.open), true); assert.equal(await page.locator('#context-text').inputValue(), 'Fresh background edit'); await closed('context-dialog', 'escape'); assert.ok((await page.locator('#shared-input').inputValue()).includes('Accepted background'));
 check('Invite membership and background draft persistence survive accepted operations; stale callbacks cannot dismiss new editors');
 // Open run preview using the ordinary mention binding. Dismiss never grants consent.
 await page.locator('#shared-input').fill('@'); await page.locator(`[data-mention-id="${codex}"]`).click(); await page.locator('#shared-input').press('End'); await page.locator('#shared-input').type(' Synthetic task kept as draft');
 await page.locator('#room-advanced').evaluate(d => { d.open = true; }); await until(async () => !(await page.locator('#run-button').isDisabled()), 'Run available'); await page.locator('#run-button').click(); await page.locator('#run-mode').selectOption('directed'); await page.locator('#run-limit').selectOption('6'); await page.locator('#run-consent').check(); await closed('run-dialog'); assert.equal(await page.locator('#run-preview').textContent(), ''); assert.equal(await page.locator('#run-consent').isChecked(), false);
 await page.locator('#room-advanced').evaluate(d => { d.open = true; }); await page.locator('#run-button').click(); assert.equal(await page.locator('#run-mode').inputValue(), 'replies'); assert.equal(await page.locator('#run-limit').inputValue(), '3'); assert.equal(await page.locator('#confirm-run').isDisabled(), true); await closed('run-dialog', 'escape');
 check('Run cancellation clears consent/participants/task and restores fresh replies/3 defaults without dispatching or losing the actual draft');
 // Actual file preview uses a synthetic chooser result scoped inside owned workspace.
 await page.locator('#room-files').click(); await page.locator('#file-dialog').waitFor(); assert.equal(await page.locator('#file-content').textContent(), 'Synthetic file contents'); await closed('file-dialog'); for (const id of ['file-title','file-info','file-content','file-error']) assert.equal(await page.locator('#'+id).textContent(), ''); assert.ok(await app.evaluate(() => globalThis.t93.closedFiles) > 0);
 // Share selected reading text (no forward/copy).
 await row(codex).locator('.session-link').click(); await fixture('history', codex, [{ id: 'dialog-share', type: 'agentMessage', text: 'Synthetic reading text for sharing and search' }]); await page.locator('#messages [data-message-id="dialog-share"] .message-body').waitFor();
 await page.locator('#messages [data-message-id="dialog-share"] .message-body').evaluate(el => { const range = document.createRange(); range.selectNodeContents(el); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); });
 await shareSelection(); await page.locator('#share-dialog').waitFor(); await page.locator('#share-text').fill('Discarded sharing edit'); await closed('share-dialog'); assert.equal(await page.locator('#share-text').inputValue(), ''); assert.equal(await page.locator('#share-recipient option').count(), 0);
 check('File cancellation releases the preview and clears readonly contents; sharing cancellation clears its private text and recipient without sending');
 // Native focus/blur ordering: Escape must not persist an uncommitted number.
 await page.locator('#terminal-tab').click(); await terminalDisplayDialog(); const saved = await page.locator('#terminal-font-size').inputValue(); await page.locator('#terminal-font-size').fill('18'); await closed('terminal-display-dialog', 'escape'); await terminalDisplayDialog(); assert.equal(await page.locator('#terminal-font-size').inputValue(), saved);
 await page.locator('#terminal-font-size').fill('19'); await closed('terminal-display-dialog', 'button', 'close-terminal-display'); await terminalDisplayDialog(); assert.equal(await page.locator('#terminal-font-size').inputValue(), '19'); await closed('terminal-display-dialog');
 check('Real Escape blur discards the uncommitted font edit, while explicit Done commits the open dialog preference');
 // Search closed render must not refill after incoming native records; reading return survives.
 await page.locator('#chat-tab').click(); await page.locator('#search-button').click(); await page.locator('#search-input').fill('Synthetic reading'); await until(async () => (await page.locator('#search-results button').count()) === 1, 'Search result'); await page.locator('#search-results button').click(); await page.locator('#search-dialog').waitFor({ state: 'hidden' }); await page.locator('#return-reading').click();
 await page.locator('#search-button').click(); await page.locator('#search-input').fill('Discarded search'); await closed('search-dialog', 'escape'); await fixture('history', codex, [{ id: 'after-close', type: 'agentMessage', text: 'New local output after search close' }]); await delay(150); assert.equal(await page.locator('#search-input').inputValue(), ''); assert.equal(await page.locator('#search-results').textContent(), ''); assert.equal(await page.locator('#search-count').textContent(), '');
 check('Search navigation/reading return survives; closed query/results remain cleared during later native output');
 // Native history busy cancel gate is preserved. Forced closed UI ACK is still safe.
 await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="codex"]').check(); await page.locator('#open-native-history').click(); await page.locator('input[name="native-history-choice"]').check(); await arm('importHistory'); await page.locator('#confirm-native-history').click(); await held('importHistory');
 for (const kind of ['escape','outside','escape']) { if (kind === 'escape') await page.keyboard.press('Escape'); else await page.mouse.click(4,4); assert.equal(await page.locator('#native-history-dialog').evaluate(d=>d.open), true); }
 assert.equal(await page.locator('#close-native-history').isDisabled(), true); await release('importHistory'); await page.locator('#native-history-dialog').waitFor({ state:'hidden' });
 await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="codex"]').check(); await page.locator('#open-native-history').click(); await page.locator('input[name="native-history-choice"]').check(); await arm('importHistory'); await page.locator('#confirm-native-history').click(); await held('importHistory');
 // Test-only forced DOM close models a programmatic teardown, not an ordinary cancel.
 await page.locator('#native-history-dialog').evaluate(d=>d.close()); await page.locator('#search-button').click(); const selectedBefore = (await snapshot()).viewState.selected; await release('importHistory'); await delay(100); assert.equal(await page.locator('#search-dialog').evaluate(d=>d.open), true); assert.equal((await snapshot()).viewState.selected, selectedBefore); assert.equal(await page.locator('#native-history-list').textContent(), ''); await closed('search-dialog');
 check('Native history import blocks backdrop/repeated Escape while busy; even forced teardown leaves late ACK unable to close another dialog or change selection');
 await page.locator('#message-input').fill('Persistent private fixture draft'); await until(async () => { const s = await snapshot(); return s.sessions.find(x=>x.id===s.viewState.selected)?.liveDraft === 'Persistent private fixture draft'; }, 'Private draft persisted');
 const beforeReopen = await snapshot(), stable = beforeReopen.sessions.map(({id,nativeId,owner,liveDraft,roomId})=>({id,nativeId,owner,liveDraft,roomId})); const shared = beforeReopen.viewState.sharedDraft, savedNotes = beforeReopen.room.notes;
 measurements.push({ stage:'final', stats: await fixture('stats'), ipc:await app.evaluate(()=>({counts:globalThis.t93.counts,clipboard:globalThis.t93.clipboard})) });
 const stats=measurements.at(-1).stats; for(const name of ['sends','inputs']) assert.equal(stats.stats[name],0); for(const name of ['send','input','forward','approve','answer','queue','steer']) assert.equal(stats.overviewCalls[name],0); for (const name of ['run','send','input','forward','approve','answer','queue','steer']) assert.equal(measurements.at(-1).ipc.counts[name],0); assert.equal(beforeReopen.diagnostics.dispatches,0); assert.equal(measurements.at(-1).ipc.clipboard,0);
 await capture('05-final-drafts'); await app.close(); await launch(); const reopened=await snapshot(); assert.deepEqual(reopened.sessions.map(({id,nativeId,owner,liveDraft,roomId})=>({id,nativeId,owner,liveDraft,roomId})),stable); assert.equal(reopened.viewState.sharedDraft,shared); assert.equal(reopened.room.notes,savedNotes); assert.equal(reopened.viewState.terminalDisplay.fontSize,19); assert.equal(await page.locator('dialog[open]').count(),0); assert.deepEqual(errors,[]);
 check('Full source window reopen preserves all session identities/membership/private+shared drafts/saved notes/preferences; zero native input/send/approval/run/OSclipboard');
}
run().catch(async e => { failure = e.stack; process.exitCode = 1; console.error(e.stack); if (page) await capture('failure'); }).finally(async () => {
  try {
    try {
      const sourceAfter = hashes();
      if (JSON.stringify(sourceAfter) !== JSON.stringify(sourceBefore)) { failure ||= 'Source changed during test'; process.exitCode = 1; }
      if (evidence && fs.existsSync(evidence)) fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ flowPassed: !failure, failure, checks, errors, measurements, sourceBefore, sourceAfter, profile, token, qualification: 'Real source Electron44/DSH/daemon/IPC; synthetic native/history/chooser results and explicit main IPC delays/failures/usage for rendering. CDP composition only, not physical IME or VoiceOver; not installed/daily/live-provider/native OS chooser/OSclipboard qualification.' }, null, 2));
    } finally {
      await scratch.release();
      if (slotOwned) { const owner = JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))); assert.equal(owner.token, token); fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot); }
      if (evidence && fs.existsSync(evidence)) fs.writeFileSync(path.join(evidence, 'released.json'), JSON.stringify({ profile, token, exists: profile ? fs.existsSync(profile) : false }, null, 2));
    }
  } catch (e) { console.error(e.stack); process.exitCode = 1; }
});
