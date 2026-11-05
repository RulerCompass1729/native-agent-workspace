// Actual source Electron/DSH navigation with an owned, synthetic native transport.
// No provider CLI, product model, terminal input or system clipboard is used.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto'), { once } = require('node:events'), cp = require('node:child_process');
const root = path.resolve(__dirname, '..'), scratch = require('./fixtures/test-scratch.cjs');
const { _electron } = scratch.playwright(require('playwright'));
const { connectService } = require('../app/service-connection.cjs'), { RoomState } = require('../app/room-state.cjs');
const { processIdentity, processMayBeAlive } = require('../app/platform.cjs');
const { chooseRecipient } = require('./room-input.cjs');
const layoutOnly = process.env.NAW_NAVIGATION_LAYOUT_ONLY === '1';
assert.ok(!process.env.NAW_NAVIGATION_LAYOUT_ONLY || layoutOnly, 'Unknown targeted navigation mode');
const evidence = process.env.NAW_EVIDENCE_DIR, freezeFile = process.env.NAW_NAVIGATION_FREEZE;
assert.ok(evidence && path.isAbsolute(evidence) && !path.resolve(evidence).startsWith(root + path.sep), 'Explicit external evidence directory required');
let existingEvidence = path.resolve(evidence); while (!fs.existsSync(existingEvidence)) existingEvidence = path.dirname(existingEvidence);
const canonicalEvidence = path.join(fs.realpathSync(existingEvidence), path.relative(existingEvidence, path.resolve(evidence)));
assert.ok(!canonicalEvidence.startsWith(fs.realpathSync(root) + path.sep) && canonicalEvidence !== fs.realpathSync(root), 'Evidence aliases must remain outside the checkout');
assert.ok(!fs.existsSync(evidence) || fs.readdirSync(evidence).length === 0, 'Use a fresh evidence directory; never overwrite an earlier attempt');
assert.ok(freezeFile && path.isAbsolute(freezeFile), 'Review-bound source freeze required');
assert.ok(!process.env.NAW_APP_EXECUTABLE && (!process.env.NAW_TEST_APP_ROOT || fs.realpathSync(process.env.NAW_TEST_APP_ROOT) === fs.realpathSync(root)), 'Only this source checkout is qualified');
const frozen = JSON.parse(fs.readFileSync(freezeFile)), hash = value => createHash('sha256').update(value).digest('hex');
const allowed = ['app/renderer/renderer.js', 'app/renderer/index.html', 'app/renderer/styles.css', 'app/renderer/search-view.js', 'app/ui-messages.js', 'app/dsh/client.js', 'scripts/test-room-navigation.cjs', 'scripts/fixtures/room-navigation.cjs', 'scripts/fixtures/collaboration-overview.cjs', 'scripts/fixtures/native-progress.cjs', 'scripts/fixtures/test-scratch.cjs', 'scripts/room-input.cjs'];
assert.deepEqual(Object.keys(frozen).sort(), allowed.slice().sort());
const sourceHashes = () => Object.fromEntries(allowed.map(file => [file, hash(fs.readFileSync(path.join(root, file)))]));
assert.deepEqual(sourceHashes(), frozen, 'Source and harness must match the reviewed checkpoint before admission');
const common = cp.execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
assert.ok(!canonicalEvidence.startsWith(fs.realpathSync(path.dirname(common)) + path.sep), 'Evidence must remain outside the primary checkout too');
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID(), owner = randomUUID();
try { fs.mkdirSync(slot); } catch (error) { if (error.code !== 'EEXIST') throw error; console.error('GUI slot occupied; no profile, child or GUI allocated.'); process.exit(75); }
const slotIdentity=fs.lstatSync(slot);
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'CodexMain', task: 'T163 UI006/UI007 navigation', token, pid: process.pid, at: new Date().toISOString() }));
fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
let profile, child, client, app, page, expired = false, deadline, launches = 0, sequence = 0, passiveBaseline;
const guiProcesses = [], checks = [], errors = [], trace = [], layoutReadings = [];
const started = Date.now(), pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { for (let i = 0; i < 100; i++) { if (expired) throw Error('Navigation GUI budget exhausted'); if (await fn()) return; await pause(50); } throw Error(label); }
function fixture(method, target, value, navigation = false) {
  const id = ++sequence, request = navigation ? `navigation-${id}` : id;
  return new Promise((resolve, reject) => {
    const receive = reply => {
      if ((navigation ? reply.navigationReply : reply.requestId) !== request) return;
      clearTimeout(timer); child.off('message', receive); trace.push({ method, target, value, reply });
      fs.writeFileSync(path.join(evidence, 'trace.json'), JSON.stringify(trace, null, 2)); reply.error ? reject(Error(reply.error)) : resolve(reply);
    };
    const timer = setTimeout(() => { child.off('message', receive); reject(Error('Owned fixture response timed out')); }, 5000);
    child.on('message', receive); child.send(navigation ? { navigationRequest: request, method, id: target } : { id: request, method, target, value });
  });
}
const snapshot = () => client.call('initial'), uiState = () => page.evaluate(() => workspace.initial());
const tab = id => page.locator(`#room-member-tabs [data-room-session="${id}"]`);
async function capture(name) { await page.screenshot({ path: path.join(evidence, name + '.png') }); }
async function readableMember(label) {
  assert.equal(await page.locator('#collaboration-overview').isVisible(), false, 'Stable tabs replace the duplicate overview ribbon in the full view');
  const box = await page.locator('#messages').boundingBox(); assert.ok(box && box.height >= 120, 'At least five ordinary text lines remain readable');
  layoutReadings.push({ label, messageBox: box, viewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight })) });
}
async function nativeDisplay(id, name, passive = true) {
  const surface = page.locator(`[data-terminal-id="${id}"]`), rows = surface.locator('.xterm-rows');
  await until(async () => await surface.isVisible() && (await rows.innerText()).includes('OWNED NAVIGATION DISPLAY'), 'Exact owned terminal display is visible');
  if (passive) assert.equal(await surface.evaluate(el => el.contains(document.activeElement)), false, 'Restored display does not hold terminal input focus');
  await capture(name);
}
function noUnexpectedCalls(reply) {
  const actual = reply.overviewCalls || {};
  assert.deepEqual(actual, passiveBaseline || Object.fromEntries(Object.keys(actual).map(key => [key, 0])), 'Navigation adds no claim, send, queue, steer, input, approval, run or native terminal call');
  assert.equal(reply.stats.inputs, 0); assert.equal(reply.stats.sends, 0);
}
async function launch() {
  assert.ok(++launches <= (layoutOnly ? 1 : 2)); const before = await snapshot();
  assert.equal(before.servicePid, child.pid); assert.equal(before.runtimeVersion, require('../package.json').version);
  assert.equal(fs.existsSync(path.join(profile, 'backends')), false); assert.deepEqual(sourceHashes(), frozen);
  app = await _electron.launch({ args: [root], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 30000 });
  const identity = processIdentity(app.process().pid); assert.ok(identity); guiProcesses.push(identity);
  fs.writeFileSync(path.join(evidence, 'allocated.json'), JSON.stringify({ token, profile, childIdentity: processIdentity(child.pid), guiProcesses }));
  page = await app.firstWindow(); page.setDefaultTimeout(6500); page.on('pageerror', error => errors.push(error.message));
  await page.locator('#new-session').waitFor(); const initial = await uiState();
  assert.equal(initial.servicePid, child.pid); assert.equal(initial.runtimeVersion, require('../package.json').version); assert.equal(initial.services.length, 1);
}
async function checked(name, body) { assert.ok(checks.length < 5); await body(); noUnexpectedCalls(await fixture('stats')); checks.push(name); fs.writeFileSync(path.join(evidence, 'checks.json'), JSON.stringify(checks, null, 2)); console.log('PASS', name); }
async function run() {
  profile = fs.realpathSync(scratch.directory(path.join(os.tmpdir(), 'naw-room-navigation-')));
  const cwd = path.join(profile, 'workspace'); fs.mkdirSync(cwd, { mode: 0o700 });
  child = scratch.childProcess.fork(path.join(root, 'app/daemon.cjs'), [profile], { cwd, execArgv: ['--require', path.join(__dirname, 'fixtures/room-navigation.cjs')], env: { ...process.env, NAW_TEST_APP_ROOT: root, NAW_WORKSPACE: cwd, NAW_APP_VERSION: require('../package.json').version }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Owned fake service boot'); client = await connectService(profile, owner);
  const ids = []; for (const letter of ['A', 'B', 'C', 'D', 'E']) ids.push(await client.call('create', { provider: 'codex', cwd, name: `Synthetic route ${letter}${letter === 'E' ? ' · source and citation verification' : ''}`, view: 'chat' }));
  for (const [index, id] of ids.entries()) { if (index < 3) await client.call('join', id, true); await client.call('draft', id, `Private unsent ${index}`); }
  await fixture('seed', null, null, true); const original = (await snapshot()).sessions.map(s => [s.id, s.nativeId]);
  new RoomState(profile);
  fs.writeFileSync(path.join(profile, 'views.json'), JSON.stringify([{ owner, active: true, selected: 'room', mode: 'chat', spaceId: 'shared', roomViews: { shared: { roomSurface: 'records', roomFilter: 'synthetic-departed-member', roomSearch: 'retained', sharedDraft: 'Shared unsent' } } }]), { mode: 0o600 });
  await launch();
  await checked('1 historical scope is explicit and recent-all restores the original history without changing the draft', async () => {
    await until(async () => await page.locator('#room-filter').inputValue() === 'synthetic-departed-member', 'Saved historical filter restored');
    assert.equal(await page.locator('#room-member-tabs button').count(), 3); assert.equal(await page.locator('#room-record-scope').isVisible(), true);
    const unknownLabels = ['zh', 'en'].map(language => require('../app/ui-locale.js').format(language, 'collab.contextUnknown'));
    const unknownLabel = await tab(ids[2]).getAttribute('aria-label');
    assert.ok(unknownLabels.some(label => unknownLabel.includes(label)), 'Unknown native context remains visible when the old ribbon is hidden');
    assert.equal(await page.locator('#room-messages [data-message-id]').count(), 1);
    await page.locator('#room-record-clear').click(); assert.equal(await page.locator('#room-filter').inputValue(), '');
    assert.equal(await page.locator('#room-messages [data-message-id]').count(), 5);
    await page.locator('#room-record-restore').click(); assert.equal(await page.locator('#room-filter').inputValue(), 'synthetic-departed-member');
    assert.equal(await page.locator('#room-search').inputValue(), 'retained'); assert.equal(await page.locator('#shared-input').inputValue(), 'Shared unsent');
    await chooseRecipient(page, ids[0]); await capture('01-history-scope');
  });
  const sharedDraft = await page.locator('#shared-input').inputValue();
  await checked('2 full member -> related records -> all recent -> return retains reading, mode, recipient and both drafts', async () => {
    await tab(ids[0]).click(); await until(async () => (await uiState()).viewState.roomSession === ids[0], 'A full view');
    await readableMember('three-member full view');
    await tab(ids[1]).focus();const originalTab=await tab(ids[1]).elementHandle();await page.evaluate(([id,name])=>workspace.rename(id,name),[ids[1],'Synthetic route B · renamed']);
    await until(async()=> (await tab(ids[1]).innerText()).includes('renamed'),'Other member renamed without invalidating the explicitly addressed A');assert.equal(await originalTab.evaluate(el=>el.isConnected&&document.activeElement===el),true,'Rename preserves actual focused button');
    assert.equal(await page.locator('#message-input').inputValue(), 'Private unsent 0');
    await page.locator('#message-input').evaluate(el => el.setSelectionRange(3, 8));
    await page.locator('#messages').evaluate(el => { el.scrollTop = Math.floor(el.scrollHeight / 3); });
    const before = await page.locator('#messages').evaluate(el => el.scrollTop); assert.ok(before > 0);
    await page.locator('#member-related-records').click(); assert.equal(await page.locator('#room-search').isVisible(), false);
    assert.equal(await page.locator('#collaboration-overview').isVisible(), false, 'Shared records do not repeat the overview ribbon');
    assert.equal(await page.locator('#room-search').inputValue(), 'retained'); assert.equal(await page.locator('#room-messages [data-message-id]').count(), 3);
    assert.equal(await page.locator('#shared-input').inputValue(), sharedDraft);
    const wakeText=await page.locator('#room-messages').innerText();assert.ok(wakeText.includes('Synthetic waiting message from B to A'));
    assert.ok(["The sender’s original message could not be verified","The sender's original message could not be verified",'无法核对发送方的原消息'].some(text=>wakeText.includes(text)),'Missing original wake stays unconfirmed without falsely claiming the sender was removed');
    await capture('02-related-records');
    await page.locator('#search-button').click();await page.locator('#search-input').fill('Synthetic unrelated request to B');
    await until(async()=>await page.locator('#search-results button').count()===1,'One unique shared-record search result');await page.locator('#search-results button').click();
    assert.equal(await page.locator('#room-messages [data-search-target="true"]').count(),1,'Explicit searched record becomes visible outside the prior related scope');
    await page.locator('#return-reading').click();await until(async()=> (await uiState()).viewState.roomViews.shared.roomRecordScope===ids[0],'Search returns to original related member scope');
    assert.equal(await page.locator('#room-messages [data-message-id]').count(),3);assert.equal(await page.locator('#shared-input').inputValue(),sharedDraft);
    await page.locator('#room-record-clear').click(); assert.equal(await page.locator('#room-messages [data-message-id]').count(), 5);
    await page.locator('#room-record-return').click();
    await until(async () => Math.abs((await page.locator('#messages').evaluate(el => el.scrollTop)) - before) <= 2, 'Exact member reading position restored');
    assert.equal(await page.locator('#message-input').inputValue(), 'Private unsent 0');
    assert.deepEqual(await page.locator('#message-input').evaluate(el => [el.selectionStart, el.selectionEnd]), [3, 8]);
    const kept = (await uiState()).viewState.roomViews.shared; assert.equal(kept.roomRecipient, ids[0]); assert.equal(kept.sharedDraft, sharedDraft);
    assert.equal(kept.roomFilter, 'synthetic-departed-member'); assert.equal(kept.roomSearch, 'retained');
  });
  await checked('3 explicit native viewing is remembered, while subsequent tab and record navigation does not take control', async () => {
    noUnexpectedCalls(await fixture('stats'));
    await page.locator('#terminal-tab').click(); await until(async () => (await uiState()).viewState.mode === 'terminal', 'Explicit native view');
    await fixture('output', ids[0], { data: '\x1b[2J\x1b[HOWNED NAVIGATION DISPLAY\r\n' });
    await nativeDisplay(ids[0], '06-explicit-native-display', false);
    passiveBaseline = { ...(await fixture('stats')).overviewCalls };
    await tab(ids[1]).click(); await until(async () => (await uiState()).viewState.roomSession === ids[1], 'B full view');
    await tab(ids[0]).click(); await until(async () => (await uiState()).viewState.mode === 'terminal', 'A native view restored');
    await nativeDisplay(ids[0], '07-tab-restored-native-display');
    await page.locator('#member-related-records').click(); await page.locator('#room-record-return').click();
    await until(async () => (await uiState()).viewState.mode === 'terminal', 'Native view restored after related records');
    await nativeDisplay(ids[0], '08-related-restored-native-display');
    noUnexpectedCalls(await fixture('stats'));
  });
  await checked('4 three/four/five members share stable tabs; narrow names remain accessible and removal rejects the old return target', async () => {
    for (const [index, id] of ids.slice(3).entries()) { await client.call('join', id, true); await until(async () => await page.locator('#room-member-tabs button').count() === index + 4, 'New member tab'); }
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(820, 720); });
    await page.locator('#room-overview').focus(); await page.locator('#room-overview').press('End'); assert.equal(await tab(ids[4]).evaluate(el => el === document.activeElement), true);
    assert.equal((await uiState()).viewState.roomSession, ids[0], 'Arrow navigation moves focus only');
    await tab(ids[4]).press('Enter'); await until(async () => (await uiState()).viewState.roomSession === ids[4], 'Fifth member active');
    await readableMember('five-member narrow full view');
    for (const id of ids) assert.ok((await tab(id).getAttribute('aria-label')).includes('Synthetic route'));
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    for (const box of await page.locator('#room-member-tabs button').evaluateAll(elements => elements.map(el => el.getBoundingClientRect().toJSON()))) assert.ok(box.width > 0 && box.left >= -1 && box.right <= viewport.width + 1 && box.top >= 0 && box.bottom <= viewport.height);
    await capture('03-five-members-narrow'); await page.locator('#member-related-records').click();
    await client.call('join', ids[4], false); await until(async () => await page.locator('#room-record-return').isDisabled(), 'Removed member cannot be returned to');
    assert.equal(await page.locator('#room-record-scope').isVisible(), true); await capture('04-removed-member');
    await page.locator('#room-record').click();
    await tab(ids[1]).click();await client.call('join',ids[1],false);
    await until(async()=>await tab(ids[1]).count()===0,'Focused member removed');
    assert.equal(await page.locator('#room-tabs button').evaluateAll(elements=>elements.filter(el=>!el.hidden&&el.tabIndex===0&&['room-overview','room-record'].includes(el.id)||el.dataset.roomSession&&el.tabIndex===0).length),1,'After selected-member removal exactly one navigation button remains a keyboard entry');
    await client.call('join',ids[1],true);await until(async()=>await tab(ids[1]).count()===1,'Same native member rejoins');
    await page.locator('#room-record').click();
  });
  if (!layoutOnly) await checked('5 closing during recent-all preview retains canonical history, original native records and drafts on ordinary owned reopen', async () => {
    await page.locator('#room-record-clear').click(); assert.equal(await page.locator('#room-filter').inputValue(), '');
    assert.equal(await page.locator('#room-record-restore').isVisible(), true);
    await until(async () => (await uiState()).viewState.roomViews.shared.roomFilter === 'synthetic-departed-member', 'Canonical history retained while previewing recent records');
    await page.locator('#search-button').click();await page.locator('#search-input').fill('Synthetic unrelated request to B');
    await until(async()=>await page.locator('#search-results button').count()===1,'Unique result while previewing recent-all');await page.locator('#search-results button').click();
    assert.equal(await page.locator('#room-messages [data-search-target="true"]').count(),1);
    assert.equal((await uiState()).viewState.roomViews.shared.roomFilter,'synthetic-departed-member','Opening a result without Return preserves canonical history on save');
    await capture('09-recent-preview-before-close');
    await app.close(); app = null; await launch();
    await until(async () => await page.locator('#room-filter').inputValue() === 'synthetic-departed-member', 'Original history after reopen');
    assert.equal(await page.locator('#room-record-return').isVisible(), false); assert.equal(await page.locator('#room-search').inputValue(), 'retained');
    assert.equal(await page.locator('#shared-input').inputValue(), sharedDraft); assert.equal((await uiState()).viewState.roomViews.shared.roomRecipient, ids[0]);
    const after = await snapshot(); assert.deepEqual(after.sessions.map(s => [s.id, s.nativeId]), original);
    assert.deepEqual(after.sessions.map(s => s.liveDraft), ids.map((_, i) => `Private unsent ${i}`));
    const final = await fixture('stats'); assert.equal(final.stats.inputs, 0); assert.equal(final.stats.sends, 0); assert.deepEqual(errors, []);
    assert.deepEqual(sourceHashes(), frozen); await capture('05-reopened-history');
  });
  const finalRecords = (await snapshot()).sessions.map(({ id, nativeId, liveDraft }) => ({ id, nativeId, liveDraft }));
  assert.deepEqual(finalRecords.map(s => [s.id, s.nativeId]), original);
  assert.deepEqual(finalRecords.map(s => s.liveDraft), ids.map((_, i) => `Private unsent ${i}`));
  const final = await fixture('stats'); noUnexpectedCalls(final);
  assert.equal(checks.length, layoutOnly ? 4 : 5); assert.deepEqual(errors, []); assert.deepEqual(sourceHashes(), frozen);
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ checks: checks.slice(), scope: layoutOnly ? 'targeted-layout-no-reopen' : 'five-complete-journeys', launches, activeSeconds: (Date.now() - started) / 1000, original, finalRecords, final, errors, layoutReadings, source: frozen }, null, 2));
}
const cleanup = scratch.cleanup(async () => { if (app) await app.close(); client?.close(); if (child?.connected) child.disconnect(); if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } });
Promise.race([run(), new Promise((_, reject) => { deadline = setTimeout(() => { expired = true; reject(Error('Owned navigation GUI cap exhausted')); }, layoutOnly ? 120000 : 180000); })]).catch(async error => {
  process.exitCode = 1; fs.writeFileSync(path.join(evidence, 'failure.txt'), error.stack); try { if (page && !page.isClosed()) await capture('failure'); } catch {} console.error(error.stack);
}).finally(async () => {
  clearTimeout(deadline); const cleanupStarted = Date.now();
  try {
    let cleanupError; try { await cleanup(); } catch (error) { cleanupError = error.stack; }
    assert.ok(Date.now() - cleanupStarted < 90000); assert.ok(!profile || !fs.existsSync(profile)); assert.equal(guiProcesses.some(processMayBeAlive), false);
    assert.ok(!child || child.exitCode !== null || child.signalCode !== null);
    const lease = JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))); assert.equal(lease.token, token);const actualSlot=fs.lstatSync(slot);assert.equal(actualSlot.ino,slotIdentity.ino);assert.equal(actualSlot.dev,slotIdentity.dev); fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot);
    fs.writeFileSync(path.join(evidence, 'released.json'), JSON.stringify({ at: new Date().toISOString(), token, cleanupSeconds: (Date.now() - cleanupStarted) / 1000, cleanupError, profileGone: true, processesGone: true, sourceUnchanged: JSON.stringify(sourceHashes()) === JSON.stringify(frozen) }));
    if (cleanupError) process.exitCode = 1;
  } catch (error) { process.exitCode = 1; console.error('Owned cleanup/release unconfirmed:', error.stack); }
});
