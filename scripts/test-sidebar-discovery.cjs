// One bounded source-GUI journey through the existing empty-space sidebar.
// Synthetic transport, no sessions, provider/model turns, native input or create.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), { randomUUID, createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'), code = path.resolve(process.env.NAW_TEST_APP_ROOT || root);
const scratch = require('./fixtures/test-scratch.cjs');
const { createSourceEntry } = require('./fixtures/synthetic-source-boot.cjs');
const { _electron } = scratch.playwright(require('playwright'));
const plan = { task: 'T163/T145 collapsed empty-space discovery', activeMs: 60000, cleanupMs: 90000, profiles: 1, guiStarts: 1, syntheticBackends: 1, sessions: 0, productModels: 0, providers: 0, nativeInputs: 0, creations: 0, osClipboard: 0 };
if (process.argv.includes('--plan')) { console.log(JSON.stringify(plan, null, 2)); process.exit(0); }
assert.equal(process.env.NAW_DISCOVERY_GUI_AUTHORIZED, '1', 'Record the finite source-GUI authorization first');
const evidence = process.env.NAW_DISCOVERY_EVIDENCE_DIR, pictures = process.env.NAW_DISCOVERY_SCREENSHOTS_DIR;
for (const target of [evidence, pictures]) {
  assert.ok(target && path.isAbsolute(target), 'Explicit private evidence and screenshot paths');
  let parent = target; while (!fs.existsSync(parent)) parent = path.dirname(parent);
  const real = path.resolve(fs.realpathSync(parent), path.relative(parent, target));
  for (const source of [root, code]) assert.ok(real !== fs.realpathSync(source) && !real.startsWith(fs.realpathSync(source) + path.sep), 'Evidence outside tested source');
}
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: process.env.NAW_TEST_AUTHOR_ROOT || root, encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID();
const hash = data => createHash('sha256').update(data).digest('hex');
const frozen = () => Object.fromEntries(['app/main.cjs', 'app/dsh/bootstrap.js', 'app/renderer/index.html', 'app/renderer/renderer.js', 'app/renderer/styles.css', 'app/renderer/sidebar-layout.css', 'app/dsh/client.js', 'scripts/test-sidebar-discovery.cjs'].map(file => [file, hash(fs.readFileSync(path.join(code, file)))]));
const source = frozen();
try { fs.mkdirSync(slot, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; console.error('GUI slot occupied; no profile or process allocated.'); process.exit(75); }
const inode = fs.lstatSync(slot);
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Codex2', task: plan.task, token, pid: process.pid, at: new Date().toISOString(), plan }));
let profile, child, application, page, sequence = 0, stopped = false, timer, failure, initial;
const checks = [], errors = [], started = Date.now(), delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function guard() { assert.ok(!stopped && Date.now() - started < plan.activeMs, 'Finite GUI budget'); }
async function until(read, label) { for (let n = 0; n < 100; n++) { guard(); const value = await read(); guard(); if (value) return; await delay(40); } throw Error(label); }
function stats() {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const receive = reply => { if (reply.requestId !== id) return; clearTimeout(deadline); child.off('message', receive); reply.error ? reject(Error(reply.error)) : resolve(reply); };
    const deadline = setTimeout(() => { child.off('message', receive); reject(Error('Owned synthetic stats timeout')); }, 5000);
    child.on('message', receive); child.send({ id, method: 'stats' });
  });
}
const snapshot = () => page.evaluate(() => workspace.initial());
const sidebar = () => page.locator('.naw[data-native-surface="sidebar"]');
async function settle() { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); guard(); }
async function capture(name) {
  guard(); await settle();
  const layout = await sidebar().evaluate(host => {
    const box = node => node.getBoundingClientRect().toJSON(), card = host.querySelector('#space-discovery');
    const text = card.querySelector('strong'), range = document.createRange(); range.selectNodeContents(text);
    return { host: box(host), collapsed: host.dataset.collapsed, discovery: { hidden: card.hidden, visible: card.checkVisibility(), display: getComputedStyle(card).display, box: box(card), text: card.textContent, heading: text.textContent, headingLines: [...range.getClientRects()].map(r => r.toJSON()), font: getComputedStyle(text).fontSize }, createSlotVisible: [...host.querySelectorAll('.sidebar-create-slot')].some(el => el.checkVisibility()), viewSwitchVisible: host.querySelector('.session-view-switch').checkVisibility() };
  });
  const state = await snapshot(); guard();
  checks.push({ name, layout, sessionCount: state.sessions.length });
  fs.writeFileSync(path.join(evidence, name + '.json'), JSON.stringify({ layout, state }, null, 2));
  await page.screenshot({ path: path.join(pictures, name + '.png') }); guard(); return layout;
}
async function openAndCancel(name) {
  await page.locator('#create-first-space').click(); await page.locator('#space-create-dialog').waitFor({ state: 'visible' });
  await page.locator('#space-create-name').fill('Synthetic unsent empty-space name');
  assert.equal(await page.locator('#space-create-name').inputValue(), 'Synthetic unsent empty-space name');
  await capture(name);
  await page.locator('#cancel-space-create').click(); await page.locator('#space-create-dialog').waitFor({ state: 'hidden' }); guard();
}
async function run() {
  fs.mkdirSync(evidence, { recursive: true, mode: 0o700 }); fs.mkdirSync(pictures, { recursive: true, mode: 0o700 });
  profile = fs.realpathSync(scratch.directory(path.join(os.tmpdir(), 'naw-sidebar-discovery-')));
  child = scratch.childProcess.fork(path.join(code, 'app/daemon.cjs'), [profile], { execArgv: ['--require', path.join(root, 'scripts/fixtures/collaboration-overview.cjs')], env: { ...process.env, NAW_TEST_APP_ROOT: code, NAW_WORKSPACE: profile, NAW_APP_VERSION: require(path.join(code, 'package.json')).version }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Owned synthetic backend ready'); guard();
  const entry = createSourceEntry({ profile, code, fixturePid: child.pid });
  application = await _electron.launch({ executablePath: require('electron'), args: [entry], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 30000 }); guard();
  fs.writeFileSync(path.join(evidence, 'allocated.json'), JSON.stringify({ at: new Date().toISOString(), profile, guiPid: application.process().pid, daemonPid: child.pid, token, source }));
  page = await application.firstWindow(); page.setDefaultTimeout(5000); page.on('pageerror', error => errors.push(error.message)); await page.locator('#new-session').waitFor();
  await application.evaluate(({ clipboard }) => { globalThis.discoveryClipboardCalls = []; for (const name of Object.keys(clipboard)) if (typeof clipboard[name] === 'function') clipboard[name] = () => { globalThis.discoveryClipboardCalls.push(name); throw Error('OS clipboard prohibited'); }; });
  initial = await snapshot(); assert.equal(initial.servicePid, child.pid); assert.equal(initial.sessions.length, 0);
  const win = await application.browserWindow(page); assert.equal(await win.evaluate(w => w.isVisible()), false);
  await win.evaluate(w => w.setContentSize(1240, 818));
  await until(async () => await sidebar().getAttribute('data-collapsed') === 'false', 'Expanded existing sidebar');
  await page.locator('#sessions-flat').click(); const flat = await capture('01-expanded-flat');
  assert.equal(flat.discovery.visible, true); assert.ok(flat.discovery.heading && flat.discovery.headingLines.length > 0);
  await openAndCancel('02-flat-create-cancel');
  await page.locator('#sessions-grouped').click(); const grouped = await capture('03-expanded-grouped');
  assert.equal(grouped.discovery.visible, true); assert.equal(grouped.discovery.text, flat.discovery.text); assert.equal(grouped.discovery.font, flat.discovery.font);
  await win.evaluate(w => w.setContentSize(850, 600));
  await until(async () => await sidebar().getAttribute('data-collapsed') === 'true', 'Existing DSH narrow rail');
  const narrow = await capture('04-collapsed-empty');
  assert.equal(narrow.discovery.visible, false, 'Collapsed rail hides full empty-space prose rather than stacking each character');
  assert.equal(narrow.createSlotVisible, false); assert.equal(narrow.viewSwitchVisible, false);
  assert.equal(narrow.discovery.text, flat.discovery.text, 'No empty-state text removed from DOM');
  for (const selector of ['#new-session', '#search-button', '#setup-button', '#privacy-button', '#archive-button .rail-icon']) assert.equal(await page.locator(selector).isVisible(), true, selector);
  assert.ok(await page.locator('#new-session').getAttribute('aria-label'));
  await win.evaluate(w => w.setContentSize(1240, 818));
  if (await sidebar().getAttribute('data-collapsed') === 'true') { await page.locator('#archive-button').focus(); await page.locator('#archive-button').press('Enter'); }
  await until(async () => await sidebar().getAttribute('data-collapsed') === 'false', 'Original archive keyboard action reveals sidebar');
  const restored = await capture('05-restored-empty');
  assert.equal(restored.discovery.visible, true); assert.equal(restored.discovery.text, flat.discovery.text); assert.equal(restored.discovery.font, flat.discovery.font);
  await openAndCancel('06-restored-create-cancel');
  const final = await snapshot(), packet = await stats();
  fs.writeFileSync(path.join(evidence, 'final-before-guards.json'), JSON.stringify({ at: new Date().toISOString(), final, stats: packet, errors, source: frozen(), clipboardCalls: await application.evaluate(() => globalThis.discoveryClipboardCalls) }, null, 2));
  assert.equal(final.sessions.length, 0); assert.deepEqual(final.rooms, initial.rooms); assert.equal(final.viewState.owner, initial.viewState.owner);
  assert.equal(final.diagnostics.dispatches, 0); assert.equal(final.diagnostics.shellModelCalls, 0);
  assert.deepEqual(packet.stats, { inputs: 0, opens: 0, resizes: 0, sends: 0 });
  for (const key of ['claim', 'terminal', 'terminalSnapshot', 'send', 'input', 'queue', 'steer', 'forward', 'approve', 'answer', 'resume', 'pause']) assert.equal(packet.overviewCalls[key], 0, key);
  assert.deepEqual(await application.evaluate(() => globalThis.discoveryClipboardCalls), []); assert.deepEqual(errors, []); assert.deepEqual(frozen(), source);
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ at: new Date().toISOString(), plan, checks, errors, stats: packet, source, zeroProductModelsProvidersNativeInputCreationClipboard: true, seconds: (Date.now() - started) / 1000 }, null, 2));
  console.log('PASS existing empty-space expand/create-cancel/grouped/collapse/reveal/create-cancel journey');
}
const cleanup = scratch.cleanup(async () => { if (application) await application.close(); });
Promise.race([run(), new Promise((_, reject) => { timer = setTimeout(() => { stopped = true; reject(Error('60-second active budget exhausted')); }, plan.activeMs); })])
  .catch(async error => { stopped = true; failure = error; process.exitCode = 1; fs.mkdirSync(evidence, { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(evidence, 'failure.txt'), error.stack); if (page && !page.isClosed()) await page.screenshot({ path: path.join(pictures, 'failure.png') }).catch(() => {}); console.error(error.stack); })
  .finally(async () => {
    stopped = true; clearTimeout(timer); const at = Date.now();
    try {
      await cleanup(); assert.ok(Date.now() - at < plan.cleanupMs); assert.ok(!profile || !fs.existsSync(profile)); assert.ok(!child || child.exitCode !== null || child.signalCode !== null);
      const current = fs.lstatSync(slot); assert.equal(current.ino, inode.ino); assert.equal(current.dev, inode.dev); assert.equal(JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))).token, token);
      fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot);
      fs.writeFileSync(path.join(evidence, 'released.json'), JSON.stringify({ at: new Date().toISOString(), token, profileGone: true, ownedGUIandBackendGone: true, seconds: (Date.now() - at) / 1000, passed: !failure }));
      console.log('Exact owned GUI/profile/backend cleanup and token release confirmed');
    } catch (error) { process.exitCode = 1; console.error('Owned cleanup not confirmed:', error.stack); }
  });
