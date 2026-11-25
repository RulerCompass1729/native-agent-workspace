// Actual source GUI and merge preview storage; only native transport is synthetic.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), { randomUUID, createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const args = process.argv.slice(2), option = key => args.includes(key) ? args[args.indexOf(key) + 1] : undefined;
const plan = { profiles: 1, fakeBackends: 1, windows: 1, guiStarts: 1, syntheticSessions: 1,
  rooms: 2, previews: 4, activeMs: 120000, cleanupMs: 90000, realProviders: 0,
  productModels: 0, nativeInput: 0, sends: 0, OSClipboard: 0, actualOSDialogs: 0 };
if (args.includes('--plan')) { console.log(JSON.stringify(plan)); process.exit(0); }
assert.ok(args.includes('--run'), 'Explicit --run required');
const ownerRoot = path.resolve(__dirname, '..'), root = fs.realpathSync(option('--source-root') || ownerRoot);
const evidence = option('--evidence');
assert.ok(evidence && path.isAbsolute(evidence) && !fs.existsSync(evidence), 'Fresh absolute evidence required');
assert.ok(!process.env.NAW_APP_EXECUTABLE && !process.env.NAW_TEST_APP_ROOT && !process.env.NAW_EVIDENCE_DIR, 'No ambient target');
let ancestor = path.dirname(evidence); while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
const destination = path.join(fs.realpathSync(ancestor), path.relative(ancestor, evidence));
for (const base of [root, fs.realpathSync(ownerRoot)]) assert.ok(destination !== base && !destination.startsWith(base + path.sep));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const files = ['app/main.cjs', 'app/room-state.cjs', 'app/renderer/renderer.js', 'app/renderer/index.html',
  'app/renderer/styles.css', 'app/dsh/client.js', 'app/preload.cjs', 'app/workspace.cjs',
  'scripts/fixtures/loading-terminal.cjs', 'scripts/fixtures/synthetic-source-boot.cjs'];
const pins = Object.fromEntries(files.map(file => [file, hash(fs.readFileSync(path.join(root, file)))]));
pins.driver = hash(fs.readFileSync(__filename));
if (args.includes('--check')) { console.log(JSON.stringify({ sourcePreflight: true, root, pins, plan })); process.exit(0); }
const scratch = require(path.join(root, 'scripts/fixtures/test-scratch.cjs'));
const { _electron } = scratch.playwright(require(path.join(root, 'node_modules/playwright')));
const { connect } = require(path.join(root, 'app/service-client.cjs'));
const { createSourceEntry } = require(path.join(root, 'scripts/fixtures/synthetic-source-boot.cjs'));
const { chooseRecipient, fillRoomMessage } = require(path.join(root, 'scripts/room-input.cjs'));
const locale = require(path.join(root, 'app/ui-locale.js'));
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: ownerRoot, encoding: 'utf8' }).trim();
const slot = path.resolve(common, '..', '.local/gui-test-slot.lock'), token = randomUUID();
try { fs.mkdirSync(slot, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; console.error('OCCUPIED: zero allocation'); process.exit(75); }
const lease = fs.lstatSync(slot);
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Codex2', task: 'T159 merge dismiss actual events', token, pid: process.pid, at: new Date().toISOString(), plan }));
let profile, child, client, app, page, timer, sequence = 0, failure;
const began = Date.now(), result = { at: new Date().toISOString(), plan, pins, errors: [], checks: [] };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const env = extra => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NAW_') && !key.startsWith('ELECTRON_') && !['NODE_OPTIONS', 'NODE_PATH'].includes(key))), ...extra });
async function until(read, label) { for (let n = 0; n < 140; n++) { assert.ok(Date.now() - began < plan.activeMs, 'Active cap'); if (await read()) return; await delay(50); } throw Error(label); }
function fixture(method = 'stats', target, value) { const id = ++sequence; return new Promise((resolve, reject) => {
  const done = message => { if (message.requestId === id) { clearTimeout(timeout); child.off('message', done); fs.appendFileSync(path.join(evidence, 'fixture.jsonl'), JSON.stringify(message) + '\n'); resolve(message); } };
  const timeout = setTimeout(() => { child.off('message', done); reject(Error('Owned fixture timed out')); }, 5000);
  child.on('message', done); child.send({ id, method, target, value });
}); }
async function settle() { for (let n = 0; n < 6; n++) { const stats = await fixture(); assert.deepEqual(stats.waitingInputs, []); if (!stats.pending.length) return; for (const id of new Set(stats.pending)) await fixture('release', id); } throw Error('Passive snapshots did not settle'); }
const snapshot = () => page.evaluate(() => workspace.initial());
const metrics = () => app.evaluate(() => { const { release, ...value } = globalThis.mergeDismissTest; return value; });
async function capture(label) { result.checks.push({ label, metrics: await metrics(), dialog: await page.locator('#space-merge-dialog').evaluate(d => ({ open: d.open, active: document.activeElement?.id, text: d.textContent })) }); await page.screenshot({ path: path.join(evidence, label + '.png') }); }
const clean = scratch.cleanup(async () => {
  if (app) { await app.evaluate(() => globalThis.mergeDismissTest?.release?.()).catch(() => {}); await app.close(); }
  if (client) { for (const s of (await client.call('initial')).sessions) await client.call('stop', s.id); await client.call('shutdown'); client.close(); }
  else if (child?.exitCode === null) child.kill('SIGTERM');
  if (child?.connected) child.disconnect();
  if (child) { const end = Date.now() + plan.cleanupMs; while (child.exitCode === null && Date.now() < end) await delay(25); assert.notEqual(child.exitCode, null); }
});
(async () => {
  try {
    fs.mkdirSync(evidence); fs.writeFileSync(path.join(evidence, 'admitted.json'), JSON.stringify({ ...result, token }));
    profile = scratch.directory(path.join(os.tmpdir(), 'naw-merge-dismiss-')); result.profile = profile;
    child = scratch.childProcess.fork(path.join(root, 'app/daemon.cjs'), [profile], { execArgv: ['--require', path.join(root, 'scripts/fixtures/loading-terminal.cjs')], env: env({ NAW_WORKSPACE: profile, NAW_TEST_APP_ROOT: root, NAW_APP_VERSION: require(path.join(root, 'package.json')).version }), stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    result.backend = { pid: child.pid, start: execFileSync('/bin/ps', ['-p', String(child.pid), '-o', 'lstart='], { encoding: 'utf8' }).trim() };
    fs.writeFileSync(path.join(evidence, 'owned-backend.json'), JSON.stringify(result.backend)); child.stderr.on('data', b => fs.appendFileSync(path.join(evidence, 'backend.log'), b));
    await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Owned service ready'); client = await connect(profile, 'merge-dismiss-seed'); assert.equal((await client.call('initial')).sessions.length, 0);
    const id = await client.call('create', { provider: 'claude', cwd: profile, name: 'Synthetic merge member', view: 'chat' }); await client.call('join', id, true); result.session = id;
    const entry = createSourceEntry({ profile, code: root, fixturePid: child.pid }), entryFile = path.join(entry, 'entry.cjs');
    // Observe actual preview storage and deletion; do not fabricate a preview.
    const prefix = `const e=require('electron');globalThis.mergeDismissTest={guards:{clipboard:0,external:0,dialogs:0},actions:[],created:[],discarded:[],outstanding:[],holdNext:false,held:false};const p=require(${JSON.stringify(path.join(root, 'app/room-state.cjs'))}).RoomState.prototype;const preview=p.mergePreview,discard=p.discardMergePreview;p.mergePreview=async function(...args){const batch=await preview.apply(this,args);const t=globalThis.mergeDismissTest;t.created.push(batch.operationId);t.outstanding=[...this.mergePreviews.keys()];return batch;};p.discardMergePreview=function(id){const result=discard.call(this,id),t=globalThis.mergeDismissTest;t.discarded.push(id);t.outstanding=[...this.mergePreviews.keys()];return result;};require(${JSON.stringify(path.join(root, 'app/preflight.cjs'))}).preflight=()=>({claude:true,codex:true,python:true,paths:{},configured:{}});for(const k of ['readText','writeText','readImage','writeImage','read','write','readBuffer','writeBuffer','clear'])e.clipboard[k]=()=>{globalThis.mergeDismissTest.guards.clipboard++;throw Error('OS clipboard prohibited');};e.shell.openExternal=e.shell.openPath=async()=>{globalThis.mergeDismissTest.guards.external++;throw Error('External open prohibited');};for(const k of ['showOpenDialog','showSaveDialog','showMessageBox','showOpenDialogSync','showSaveDialogSync','showMessageBoxSync'])e.dialog[k]=()=>{globalThis.mergeDismissTest.guards.dialogs++;throw Error('Actual OS dialog prohibited');};\n`;
    fs.writeFileSync(entryFile, prefix + fs.readFileSync(entryFile, 'utf8')); fs.copyFileSync(entryFile, path.join(evidence, 'actual-entry.cjs'));
    app = await _electron.launch({ executablePath: require(path.join(root, 'node_modules/electron')), args: [entry], env: env({ NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }), timeout: 45000 });
    result.gui = { pid: app.process().pid, start: execFileSync('/bin/ps', ['-p', String(app.process().pid), '-o', 'lstart='], { encoding: 'utf8' }).trim() }; fs.writeFileSync(path.join(evidence, 'owned-gui.json'), JSON.stringify(result.gui));
    page = await app.firstWindow(); page.setDefaultTimeout(7000); page.on('pageerror', e => result.errors.push(e.message)); timer = setTimeout(() => app.close().catch(() => {}), Math.max(1, plan.activeMs - (Date.now() - began)));
    await page.locator('#panorama-nav').waitFor(); assert.equal((await snapshot()).servicePid, child.pid);
    result.windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ visible: w.isVisible(), focusable: w.isFocusable() }))); assert.deepEqual(result.windows, [{ visible: false, focusable: false }]);
    await app.evaluate(({ ipcMain }) => {
      const key = 'workspace:spaceMerge', original = ipcMain._invokeHandlers.get(key); assertOriginal();
      function assertOriginal() { if (!original) throw Error('Actual merge IPC missing'); }
      ipcMain.removeHandler(key); ipcMain.handle(key, async (...args) => {
        const t = globalThis.mergeDismissTest, action = args[1]; t.actions.push({ action, spec: args[2] });
        if (!['preview', 'discard'].includes(action) || t.actions.filter(a => a.action === 'preview').length > 4) throw Error('Merge commit/retry prohibited');
        const reply = await original(...args);
        if (action === 'preview' && t.holdNext) { t.holdNext = false; if (!reply.ok || !reply.value?.operationId) throw Error('Actual preview failed before hold'); t.held = true; await new Promise(resolve => { t.release = () => { t.release = null; t.held = false; resolve(); }; }); }
        return reply;
      });
    });
    const member = () => page.locator('[data-panorama-session="' + id + '"]');
    async function privateView() { await page.locator('#panorama-nav').click(); await member().locator('.panorama-member-heading>button').click(); await settle(); }
    async function sharedView() { await page.locator('#panorama-nav').click(); await member().locator('[data-panorama-space="shared"]').click(); await settle(); }
    const privateText = 'PRIVATE UNSENT dismiss', sharedText = 'SHARED UNSENT dismiss';
    await privateView(); await page.locator('#take-control').click(); await page.locator('#message-input').fill(privateText); await until(async () => JSON.stringify((await snapshot()).viewState).includes(privateText), 'Private draft saved');
    await sharedView(); await chooseRecipient(page, id); await fillRoomMessage(page, sharedText); await until(async () => JSON.stringify((await snapshot()).viewState).includes(sharedText), 'Shared draft saved'); const savedShared = await page.locator('#shared-input').inputValue();
    await page.locator('#new-space').click(); await page.locator('#space-create-name').fill('Owned second source'); await page.locator('#space-create-manager').uncheck(); await page.locator('#confirm-space-create').click(); await page.locator('#space-create-dialog').waitFor({ state: 'hidden' }); await until(async () => (await snapshot()).viewState.spaceId !== 'shared', 'Second own space selected'); result.before = await snapshot(); assert.equal(result.before.rooms.length, 2);
    async function open() { await page.locator('#room-header-more').click(); const button = page.getByRole('menuitem', { name: locale.format('zh', 'menu.mergeSpaces'), exact: true }); assert.equal(await button.count(), 1); await button.click(); await page.locator('#space-merge-dialog').waitFor(); assert.equal(await page.locator('#space-merge-sources input').count(), 2); }
    async function startPreview() { await page.locator('#space-merge-sources input[value="shared"]').check(); await page.locator('#preview-space-merge').click(); }
    async function dismiss(kind) {
      if (kind === 'escape') await page.keyboard.press('Escape');
      else if (kind === 'backdrop') { const b = await page.locator('#space-merge-dialog').boundingBox(); assert.ok(b.x > 4 || b.y > 4); await page.mouse.click(4, 4); }
      else await page.locator('#close-space-merge').click();
      await page.locator('#space-merge-dialog').waitFor({ state: 'hidden' });
      await until(() => page.locator('#room-header-more').evaluate(e => e === document.activeElement), 'Focus returned to visible original menu');
    }
    for (const kind of ['escape', 'backdrop', 'button']) {
      await open(); await startPreview(); await page.locator('#confirm-space-merge').waitFor();
      const before = await metrics(), operation = before.created.at(-1); assert.ok(operation && before.outstanding.includes(operation), 'Observe actual stored preview before dismissal');
      await dismiss(kind); await until(async () => !(await metrics()).outstanding.includes(operation), 'Actual preview discarded');
      assert.equal((await metrics()).discarded.filter(x => x === operation).length, 1); await capture('closed-' + kind);
    }
    await open(); await app.evaluate(() => { globalThis.mergeDismissTest.holdNext = true; }); await startPreview(); await until(async () => (await metrics()).held, 'Fourth actual preview reply held');
    const late = (await metrics()).created.at(-1); assert.ok((await metrics()).outstanding.includes(late));
    await dismiss('escape'); await open(); await page.locator('#space-merge-name').fill('NEXT UNSENT DIALOG');
    await app.evaluate(() => globalThis.mergeDismissTest.release()); await until(async () => !(await metrics()).outstanding.includes(late), 'Late actual preview discarded after old dialog dismissal');
    assert.equal(await page.locator('#space-merge-dialog').evaluate(d => d.open), true); assert.equal(await page.locator('#space-merge-name').inputValue(), 'NEXT UNSENT DIALOG'); assert.equal(await page.locator('#space-merge-options').isVisible(), true); assert.equal(await page.locator('#space-merge-preview').isHidden(), true); await capture('late-preview-keeps-new-dialog'); await dismiss('button');
    await sharedView(); assert.equal(await page.locator('#shared-input').inputValue(), savedShared); await privateView(); assert.equal(await page.locator('#message-input').inputValue(), privateText); result.after = await snapshot();
    const identity = s => s.sessions.map(r => [r.id, r.nativeId, r.owner, r.roomIds]); assert.deepEqual(identity(result.after), identity(result.before)); assert.deepEqual(result.after.rooms.map(r => [r.id, r.metadataRevision]), result.before.rooms.map(r => [r.id, r.metadataRevision]));
    const final = await metrics(); result.finalMetrics = final; assert.equal(final.created.length, 4); assert.equal(new Set(final.created).size, 4); assert.deepEqual(final.outstanding, []); assert.deepEqual([...final.discarded].sort(), [...final.created].sort()); assert.equal(final.actions.filter(a => a.action === 'preview').length, 4); assert.ok(final.actions.every(a => ['preview', 'discard'].includes(a.action))); assert.deepEqual(final.guards, { clipboard: 0, external: 0, dialogs: 0 });
    result.fixture = await fixture(); for (const key of ['inputs', 'sends', 'interruptions', 'waitingInputs', 'pending']) assert.deepEqual(result.fixture[key], []); assert.deepEqual(result.errors, []);
    for (const file of files) assert.equal(hash(fs.readFileSync(path.join(root, file))), pins[file]); assert.equal(hash(fs.readFileSync(__filename)), pins.driver);
    result.outcome = 'SOURCE_GUI_MERGE_DISMISS_PASS_NOT_INSTALLED'; result.provenance = 'Actual source GUI Escape/backdrop/Close/focus and actual RoomState preview storage/discard; one reply delayed after actual handler. Native transport synthetic, no commit/merge/provider qualification.';
  } catch (error) { failure = error.stack; process.exitCode = 1; result.outcome = 'INCOMPLETE_NOT_PASS'; if (app) result.stopMetrics = await metrics().catch(() => null); if (page && !page.isClosed()) await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {}); }
  finally {
    clearTimeout(timer); result.failure = failure; result.activeSeconds = (Date.now() - began) / 1000; fs.mkdirSync(evidence, { recursive: true }); fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2) + '\n');
    const at = Date.now(); try { await clean(); assert.ok(!profile || !fs.existsSync(profile)); const current = fs.lstatSync(slot); assert.equal(current.ino, lease.ino); assert.equal(current.dev, lease.dev); assert.equal(JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))).token, token); fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot); const released = { at: new Date().toISOString(), token, profileGone: true, cleanupSeconds: (Date.now() - at) / 1000 }; fs.writeFileSync(path.join(evidence, 'released.json'), JSON.stringify(released)); console.log(JSON.stringify({ outcome: result.outcome, failure, released })); }
    catch (error) { process.exitCode = 1; fs.writeFileSync(path.join(evidence, 'cleanup-failure.txt'), error.stack); console.error(error.stack); }
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
