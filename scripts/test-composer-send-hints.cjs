// One source GUI, actual composer/IPC/drafts; only NativeHost is synthetic.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), { randomUUID, createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const args = process.argv.slice(2), option = key => args.includes(key) ? args[args.indexOf(key) + 1] : undefined;
const plan = { profiles: 1, fakeBackends: 1, windows: 1, guiStarts: 1, syntheticSessions: 2,
  activeMs: 150000, cleanupMs: 90000, syntheticSends: 3, realProviders: 0, productModels: 0, nativeInput: 0, OSClipboard: 0 };
if (args.includes('--plan')) { console.log(JSON.stringify(plan)); process.exit(0); }
assert.ok(args.includes('--run'), 'Explicit --run required');
const ownerRoot = path.resolve(__dirname, '..'), root = fs.realpathSync(option('--source-root') || ownerRoot), evidence = option('--evidence');
assert.ok(evidence && path.isAbsolute(evidence) && !fs.existsSync(evidence), 'Fresh absolute evidence required');
assert.ok(!process.env.NAW_APP_EXECUTABLE && !process.env.NAW_TEST_APP_ROOT && !process.env.NAW_EVIDENCE_DIR, 'No ambient target');
let ancestor = path.dirname(evidence); while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
const destination = path.join(fs.realpathSync(ancestor), path.relative(ancestor, evidence));
for (const base of [root, fs.realpathSync(ownerRoot)]) assert.ok(destination !== base && !destination.startsWith(base + path.sep));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const files = ['app/main.cjs', 'app/renderer/renderer.js', 'app/ui-messages.js', 'app/renderer/session-composer.js',
  'app/renderer/index.html', 'app/renderer/styles.css', 'app/dsh/client.js', 'scripts/fixtures/loading-terminal.cjs'];
const pins = Object.fromEntries(files.map(file => [file, hash(fs.readFileSync(path.join(root, file)))])); pins.driver = hash(fs.readFileSync(__filename));
if (args.includes('--check')) { console.log(JSON.stringify({ root, pins, plan })); process.exit(0); }
const scratch = require(path.join(root, 'scripts/fixtures/test-scratch.cjs'));
const { _electron } = scratch.playwright(require(path.join(root, 'node_modules/playwright')));
const { connect } = require(path.join(root, 'app/service-client.cjs'));
const { createSourceEntry } = require(path.join(root, 'scripts/fixtures/synthetic-source-boot.cjs'));
const { chooseRecipient, fillRoomMessage } = require(path.join(root, 'scripts/room-input.cjs'));
const locale = require(path.join(root, 'app/ui-locale.js'));
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: ownerRoot, encoding: 'utf8' }).trim();
const slot = path.resolve(common, '..', '.local/gui-test-slot.lock'), token = randomUUID();
try { fs.mkdirSync(slot, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; console.error('OCCUPIED: zero allocation'); process.exit(75); }
const lease = fs.lstatSync(slot); fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Codex2', task: 'T60/T166 composer blocked-send hints', token, pid: process.pid, at: new Date().toISOString(), plan }));
let profile, child, client, app, page, timer, sequence = 0, failure;
const began = Date.now(), result = { at: new Date().toISOString(), plan, pins, errors: [], checks: [] };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const env = extra => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NAW_') && !key.startsWith('ELECTRON_') && !['NODE_OPTIONS', 'NODE_PATH'].includes(key))), ...extra });
async function until(read, label) { for (let n = 0; n < 140; n++) { assert.ok(Date.now() - began < plan.activeMs, 'Active cap'); if (await read()) return; await delay(50); } throw Error(label); }
function fixture(method = 'stats', target, value) { const id = ++sequence; return new Promise((resolve, reject) => {
  const done = message => { if (message.requestId === id) { clearTimeout(timeout); child.off('message', done); fs.appendFileSync(path.join(evidence, 'fixture.jsonl'), JSON.stringify(message) + '\n'); resolve(message); } };
  const timeout = setTimeout(() => { child.off('message', done); reject(Error('Owned fixture timed out')); }, 5000); child.on('message', done); child.send({ id, method, target, value });
}); }
async function settle() { for (let n = 0; n < 6; n++) { const stats = await fixture(); assert.deepEqual(stats.waitingInputs, []); if (!stats.pending.length) return; for (const id of new Set(stats.pending)) await fixture('release', id); } throw Error('Passive snapshots did not settle'); }
const snapshot = () => page.evaluate(() => workspace.initial());
async function capture(label, form) { const facts = await form.evaluate(f => { const input = f.querySelector('textarea'), send = f.querySelector('.session-send-button'), hint = f.querySelector('.session-compose-hint'), box = hint.getBoundingClientRect(); return { value: input.value, readOnly: input.readOnly, disabled: send.disabled, hint: hint.textContent, sameInput: input === window.originalHintInput, hintFits: box.bottom <= f.getBoundingClientRect().bottom + 1, font: getComputedStyle(input).fontSize }; }); result.checks.push({ label, ...facts }); await page.screenshot({ path: path.join(evidence, label + '.png') }); }
const clean = scratch.cleanup(async () => {
  if (app) await app.close();
  if (client) { for (const s of (await client.call('initial')).sessions) await client.call('stop', s.id); await client.call('shutdown'); client.close(); }
  else if (child?.exitCode === null) child.kill('SIGTERM');
  if (child?.connected) child.disconnect(); if (child) { const end = Date.now() + plan.cleanupMs; while (child.exitCode === null && Date.now() < end) await delay(25); assert.notEqual(child.exitCode, null); }
});
(async () => {
  try {
    fs.mkdirSync(evidence); fs.writeFileSync(path.join(evidence, 'admitted.json'), JSON.stringify({ ...result, token }));
    profile = scratch.directory(path.join(os.tmpdir(), 'naw-composer-send-hints-')); result.profile = profile;
    child = scratch.childProcess.fork(path.join(root, 'app/daemon.cjs'), [profile], { execArgv: ['--require', path.join(root, 'scripts/fixtures/loading-terminal.cjs')], env: env({ NAW_WORKSPACE: profile, NAW_TEST_APP_ROOT: root, NAW_APP_VERSION: require(path.join(root, 'package.json')).version }), stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    result.backend = { pid: child.pid, start: execFileSync('/bin/ps', ['-p', String(child.pid), '-o', 'lstart='], { encoding: 'utf8' }).trim() }; fs.writeFileSync(path.join(evidence, 'owned-backend.json'), JSON.stringify(result.backend)); child.stderr.on('data', b => fs.appendFileSync(path.join(evidence, 'backend.log'), b));
    await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Owned service ready'); client = await connect(profile, 'composer-hints-seed'); assert.equal((await client.call('initial')).sessions.length, 0);
    const id = await client.call('create', { provider: 'codex', cwd: profile, name: 'Synthetic hint member', view: 'chat' }); await client.call('join', id, true); result.session = id;
    const entry = createSourceEntry({ profile, code: root, fixturePid: child.pid }), entryFile = path.join(entry, 'entry.cjs');
    const prefix = `const e=require('electron');globalThis.hintGuards={clipboard:0,external:0,dialogs:0};require(${JSON.stringify(path.join(root, 'app/preflight.cjs'))}).preflight=()=>({claude:true,codex:true,python:true,paths:{},configured:{}});for(const k of ['readText','writeText','readImage','writeImage','read','write','readBuffer','writeBuffer','clear'])e.clipboard[k]=()=>{globalThis.hintGuards.clipboard++;throw Error('OS clipboard prohibited');};e.shell.openExternal=e.shell.openPath=async()=>{globalThis.hintGuards.external++;throw Error('External open prohibited');};for(const k of ['showOpenDialog','showSaveDialog','showMessageBox','showOpenDialogSync','showSaveDialogSync','showMessageBoxSync'])e.dialog[k]=()=>{globalThis.hintGuards.dialogs++;throw Error('OS dialog prohibited');};\n`;
    fs.writeFileSync(entryFile, prefix + fs.readFileSync(entryFile, 'utf8')); fs.copyFileSync(entryFile, path.join(evidence, 'actual-entry.cjs'));
    app = await _electron.launch({ executablePath: require(path.join(root, 'node_modules/electron')), args: [entry], env: env({ NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }), timeout: 45000 });
    result.gui = { pid: app.process().pid, start: execFileSync('/bin/ps', ['-p', String(app.process().pid), '-o', 'lstart='], { encoding: 'utf8' }).trim() }; fs.writeFileSync(path.join(evidence, 'owned-gui.json'), JSON.stringify(result.gui));
    page = await app.firstWindow(); page.setDefaultTimeout(7000); page.on('pageerror', e => result.errors.push(e.message)); timer = setTimeout(() => app.close().catch(() => {}), Math.max(1, plan.activeMs - (Date.now() - began)));
    await page.locator('#panorama-nav').waitFor(); assert.equal((await snapshot()).servicePid, child.pid); result.windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ visible: w.isVisible(), focusable: w.isFocusable() }))); assert.deepEqual(result.windows, [{ visible: false, focusable: false }]);
    const member = () => page.locator('[data-panorama-session="' + id + '"]'), form = () => page.locator('form[data-composer-session="' + id + '"]');
    async function solo() { await page.locator('#panorama-nav').click(); await member().locator('.panorama-member-heading>button').click(); await settle(); }
    async function room() { await page.locator('#panorama-nav').click(); await member().locator('[data-panorama-space="shared"]').click(); await settle(); }
    async function language(value) { await page.locator('#setup-button').click(); await page.locator('#ui-language').selectOption(value); await until(async () => await page.locator('#compose-hint').textContent() === locale.format(value, 'composer.workingHint'), 'Actual locale hint refresh'); await page.locator('#close-setup').click(); await page.locator('#setup-dialog').waitFor({ state: 'hidden' }); }
    await solo(); await page.locator('#take-control').click(); const input = page.locator('#message-input'), draft = 'PRIVATE UNSENT 中文\nkept <raw>'; await input.fill(draft); await until(async () => (await snapshot()).sessions[0].liveDraft === draft, 'Private draft saved'); await input.evaluate(e => { window.originalHintInput = e; }); const originalFont = await input.evaluate(e => getComputedStyle(e).fontSize);
    await room(); await chooseRecipient(page, id); await fillRoomMessage(page, 'SHARED UNSENT kept'); const shared = await page.locator('#shared-input').inputValue(); await solo();
    result.before = await snapshot(); await fixture('set-state', id, 'working'); await until(async () => (await snapshot()).sessions[0].state === 'working', 'Actual synthetic native state reached renderer');
    const busy = (await snapshot()).sessions[0]; assert.ok(!busy.queueAvailable && !(busy.steerAvailable && busy.activeTurnId));
    await language('zh'); assert.equal(await input.getAttribute('readonly'), null); assert.equal(await form().locator('.session-send-button').isDisabled(), true); assert.match(await form().locator('.session-compose-hint').textContent(), /不能.*发送/); await input.press('Enter'); assert.equal(await input.inputValue(), draft); await capture('01-solo-blocked-zh', form());
    const edited = draft + ' EDITED'; await input.fill(edited); await until(async () => (await snapshot()).sessions[0].liveDraft === edited, 'Working draft edit saved'); await language('en'); assert.match(await form().locator('.session-compose-hint').textContent(), /cannot send/i); await input.press('Enter'); assert.equal(await input.inputValue(), edited); await capture('02-solo-blocked-en', form());
    const zero = await fixture(); assert.deepEqual(zero.sends, []); assert.deepEqual(zero.inputs, []); result.beforeSend = zero;
    await room(); await until(() => form().isVisible(), 'Same composer moved to member column'); assert.equal(await form().locator('textarea').inputValue(), edited); assert.equal(await form().locator('.session-send-button').isDisabled(), true); assert.match(await form().locator('.session-compose-hint').textContent(), /cannot send/i); await form().locator('textarea').press('Enter'); assert.equal(await page.locator('#shared-input').inputValue(), shared); await capture('03-column-blocked', form());
    for (const check of result.checks) { assert.equal(check.sameInput, true); assert.equal(check.font, originalFont); assert.equal(check.hintFits, true); }
    await fixture('set-state', id, 'idle'); await until(async () => await form().locator('.session-send-button').isEnabled(), 'Idle restores legitimate send route'); await form().locator('.session-send-button').click(); await until(async () => (await fixture()).sends.length === 1, 'Exactly one intentional synthetic send'); await until(async () => await form().locator('textarea').inputValue() === '', 'Accepted send clears only the sent private draft');
    await fixture('complete', id, { text: 'Synthetic local reply' }); await settle(); await until(async () => (await snapshot()).sessions[0].state === 'idle', 'Synthetic completion settles'); assert.equal(await page.locator('#shared-input').inputValue(), shared); result.after = await snapshot();
    const identity = s => s.sessions.map(r => [r.id, r.nativeId, r.owner, r.cwd, r.view, r.roomIds, r.model, r.permissions]); assert.deepEqual(identity(result.after), identity(result.before));
    const final = await fixture(); result.finalFixture = final; assert.equal(final.sends.length, 1); assert.equal(final.sends[0].id, id); assert.equal(final.sends[0].text, edited); assert.deepEqual(final.inputs, []); assert.deepEqual(final.interruptions, []); assert.deepEqual(final.pending, []); assert.deepEqual(final.waitingInputs, []); result.guards = await app.evaluate(() => globalThis.hintGuards); assert.deepEqual(result.guards, { clipboard: 0, external: 0, dialogs: 0 }); assert.deepEqual(result.errors, []);
    await capture('04-idle-after-explicit-send', form());
    // Enter right after a turn ended, while typing still holds this page's state: the page picks a queue from that
    // older state and the backend refuses it before writing anything. The page then picks again from the state after it.
    const queueId = await client.call('create', { provider: 'claude', cwd: profile, name: 'Synthetic queue member', view: 'chat' }); await client.call('join', queueId, true); result.queueSession = queueId;
    const daemonSession = async () => (await client.call('initial')).sessions.find(s => s.id === queueId);
    await fixture('queue-capable', queueId, true); await until(async () => (await daemonSession())?.queueAvailable === true, 'Synthetic queue capability');
    await page.locator('#panorama-nav').click(); await page.locator('[data-panorama-session="' + queueId + '"] .panorama-member-heading>button').click(); await settle(); await page.locator('#take-control').click();
    await page.locator('#setup-button').click(); await page.locator('#ui-language').selectOption('zh'); await page.locator('#close-setup').click(); await page.locator('#setup-dialog').waitFor({ state: 'hidden' });
    const queueInput = page.locator('#message-input'), queueSend = page.locator('#send-button'), queueLabel = locale.format('zh', 'composer.queue'), staleText = 'STALE ENTER 回车';
    await page.evaluate(() => { window.statePushes = 0; workspace.onState(() => { window.statePushes++; }); });
    const pushes = () => page.evaluate(() => window.statePushes);
    let stale = null; result.staleAttempts = [];
    for (let attempt = 0; attempt < 6 && !stale; attempt++) {
      await fixture('set-state', queueId, 'working'); await until(async () => (await queueSend.textContent()) === queueLabel, 'Queue offered while working');
      await queueInput.fill('S'); await until(async () => (await daemonSession())?.liveDraft === 'S', 'Typing reached the backend');
      let typed = 'S', seen = await pushes(), ended = false;
      for (let n = 0; n < 60 && !ended; n++) {
        typed += String(n % 10); await queueInput.press(String(n % 10)); await delay(70);
        const now = await pushes();
        if (now !== seen && n >= 2) { await fixture('set-state', queueId, 'idle'); ended = true; }
        seen = now;
      }
      for (const key of ['x', 'y']) { typed += key; await queueInput.press(key); await delay(70); }
      const label = await queueSend.textContent(), backend = (await daemonSession())?.state;
      result.staleAttempts.push({ attempt, ended, label, backend });
      if (!ended || label !== queueLabel || backend !== 'idle') { await delay(1600); continue; }
      await queueInput.fill(staleText);
      result.staleAttempts.at(-1).labelBeforeEnter = await queueSend.textContent();
      if (result.staleAttempts.at(-1).labelBeforeEnter !== queueLabel) { await delay(1600); continue; }
      await page.evaluate(() => { document.getElementById('toast').hidden = true; document.getElementById('toast-text').textContent = ''; });
      await queueInput.press('Enter'); stale = { attempt };
    }
    assert.ok(stale, 'Page state was never held across the turn end: ' + JSON.stringify(result.staleAttempts));
    for (let n = 0; n < 80; n++) { const f = await fixture(); const toastText = await page.evaluate(() => document.getElementById('toast').hidden ? '' : document.getElementById('toast-text').textContent); if (toastText || f.sends.some(x => x.id === queueId)) { stale.toast = toastText; stale.sends = f.sends.filter(x => x.id === queueId); stale.queued = f.queued; break; } await delay(50); }
    await delay(500); stale.toast ||= await page.evaluate(() => document.getElementById('toast').hidden ? '' : document.getElementById('toast-text').textContent); stale.input = await queueInput.inputValue(); const after = await fixture(); stale.sends = after.sends.filter(x => x.id === queueId); stale.queued = after.queued; result.staleEnter = stale;
    await page.screenshot({ path: path.join(evidence, '05-stale-enter.png') });
    assert.equal(stale.toast, '', 'Stale Enter showed an error: ' + stale.toast);
    assert.deepEqual(stale.sends.map(x => x.text), [staleText]); assert.deepEqual(stale.queued, []); assert.equal(stale.input, '');
    await fixture('complete', queueId, { text: 'Synthetic local reply' }); await settle(); await until(async () => (await daemonSession())?.state === 'idle', 'Stale Enter reply settles'); assert.deepEqual(result.errors, []);
    // The same in the space input: the page picks a shared queue from held state, and after the refusal forwards once.
    await page.locator('#panorama-nav').click(); await page.locator('[data-panorama-session="' + queueId + '"] [data-panorama-space="shared"]').click(); await settle();
    await chooseRecipient(page, queueId);
    const sharedInput = page.locator('#shared-input'), forward = page.locator('#forward-button');
    const toastNow = () => page.evaluate(() => document.getElementById('toast').hidden ? '' : document.getElementById('toast-text').textContent);
    let roomStale = null, roomTyped = ''; result.roomStaleAttempts = [];
    for (let attempt = 0; attempt < 6 && !roomStale; attempt++) {
      await fixture('set-state', queueId, 'working'); await until(async () => (await forward.textContent()) === queueLabel, 'Space queue offered while working');
      // Typing here changes no backend state, so the hold is bounded by the push that showed working
      // (state-push remaining(): lastSent + maxHold). An agent that is writing output pushes all the time.
      await sharedInput.evaluate(el => el.setSelectionRange(el.value.length, el.value.length));
      for (let n = 0; n < 3; n++) { const key = String(n); roomTyped += key; await sharedInput.press(key); await delay(70); }
      await fixture('set-state', queueId, 'idle'); const ended = true;
      for (const key of ['x', 'y']) { roomTyped += key; await sharedInput.press(key); await delay(70); }
      const label = await forward.textContent(), backend = (await daemonSession())?.state;
      result.roomStaleAttempts.push({ attempt, ended, label, backend });
      if (!ended || label !== queueLabel || backend !== 'idle') { await delay(1600); continue; }
      await page.evaluate(() => { document.getElementById('toast').hidden = true; document.getElementById('toast-text').textContent = ''; });
      await sharedInput.press('Enter'); roomStale = { attempt };
    }
    assert.ok(roomStale, 'Space input state was never held across the turn end: ' + JSON.stringify(result.roomStaleAttempts));
    for (let n = 0; n < 80; n++) { if (await toastNow() || (await fixture()).sends.filter(x => x.id === queueId).length > 1) break; await delay(50); }
    await delay(500); roomStale.toast = await toastNow(); roomStale.input = await sharedInput.inputValue();
    const roomAfter = await fixture(); roomStale.sends = roomAfter.sends.filter(x => x.id === queueId).slice(1); roomStale.queued = roomAfter.queued; roomStale.typed = roomTyped; result.roomStaleEnter = roomStale;
    await page.screenshot({ path: path.join(evidence, '06-stale-enter-space.png') });
    assert.equal(roomStale.toast, '', 'Stale Enter in the space input showed an error: ' + roomStale.toast);
    assert.equal(roomStale.sends.length, 1); assert.ok(roomStale.sends[0].text.includes(roomTyped), 'Forwarded text: ' + roomStale.sends[0].text); assert.deepEqual(roomStale.queued, []); assert.equal(roomStale.input, '');
    await fixture('complete', queueId, { text: 'Synthetic local reply' }); await settle(); await until(async () => (await daemonSession())?.state === 'idle', 'Space stale Enter reply settles'); assert.deepEqual(result.errors, []);
    for (const file of files) assert.equal(hash(fs.readFileSync(path.join(root, file))), pins[file]); assert.equal(hash(fs.readFileSync(__filename)), pins.driver);
    result.outcome = 'SOURCE_GUI_COMPOSER_HINTS_PASS_NOT_INSTALLED'; result.provenance = 'Actual source Solo/member-column input, language Host setting, saved drafts and one explicit synthetic send only after idle. No real provider/native input or original user session.';
  } catch (error) { failure = error.stack; process.exitCode = 1; result.outcome = 'INCOMPLETE_NOT_PASS'; if (child?.connected) result.stopFixture = await fixture().catch(() => null); if (page && !page.isClosed()) await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {}); }
  finally { clearTimeout(timer); result.failure = failure; result.activeSeconds = (Date.now() - began) / 1000; fs.mkdirSync(evidence, { recursive: true }); fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2) + '\n'); const at = Date.now(); try { await clean(); assert.ok(!profile || !fs.existsSync(profile)); const current = fs.lstatSync(slot); assert.equal(current.ino, lease.ino); assert.equal(current.dev, lease.dev); assert.equal(JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))).token, token); fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot); const released = { at: new Date().toISOString(), token, profileGone: true, cleanupSeconds: (Date.now() - at) / 1000 }; fs.writeFileSync(path.join(evidence, 'released.json'), JSON.stringify(released)); console.log(JSON.stringify({ outcome: result.outcome, failure, released })); } catch (error) { process.exitCode = 1; fs.writeFileSync(path.join(evidence, 'cleanup-failure.txt'), error.stack); console.error(error.stack); } }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
