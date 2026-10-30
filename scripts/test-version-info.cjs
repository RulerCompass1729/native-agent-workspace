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
  fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Codex4', task: 'T81 source version information', token, pid: process.pid, time: new Date().toISOString() }));
  if (evidence) fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
  profile = scratch.directory(path.join(os.tmpdir(), 'naw-version-info-'));
  owned = fs.realpathSync(profile); workspacePath = path.join(profile, 'workspace');
  fs.mkdirSync(workspacePath, { mode: 0o700 }); assert.ok(fs.realpathSync(workspacePath).startsWith(owned + path.sep));
  child = scratch.childProcess.fork(path.join(code, 'app/daemon.cjs'), [profile], {
    cwd: workspacePath,
    execArgv: ['--require', path.join(root, 'scripts/fixtures/collaboration-overview.cjs')],
    env: { ...process.env, NAW_TEST_APP_ROOT: code, NAW_WORKSPACE: workspacePath, NAW_APP_VERSION: require(path.join(code, 'package.json')).version },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
}
const sourceFiles = ['app/preflight.cjs', 'app/main.cjs', 'app/workspace-client.cjs', 'app/renderer/renderer.js', 'app/renderer/index.html', 'app/renderer/styles.css', 'scripts/test-version-info.cjs', 'app/dsh/client.js'];
const hashes = () => Object.fromEntries(sourceFiles.map(f => [f, createHash('sha256').update(fs.readFileSync(path.join(code, f))).digest('hex')]));
const sourceBefore = hashes(), checks = [], errors = [], measurements = [];
let app, page, sequence = 0, failure, overrides = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { for (let i = 0; i < 200; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
function fixture(method, target, value) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const callback = reply => { if (reply.requestId === id) { clearTimeout(timer); child.off('message', callback); reply.error ? reject(Error(reply.error)) : resolve(reply); } };
    const timer = setTimeout(() => { child.off('message', callback); reject(Error('Fixture timed out')); }, 12000);
    child.on('message', callback); child.send({ id, method, target, value });
  });
}
const snapshot = () => page.evaluate(() => workspace.initial());
const identity = s => s.sessions.map(({ id, nativeId, owner, liveDraft }) => ({ id, nativeId, owner, liveDraft }));
const row = id => page.locator(`.session-row[data-session-row="${id}"]`);
const check = text => { checks.push(text); console.log('PASS:', text); };
async function capture(name) { if (evidence) await page.screenshot({ path: path.join(evidence, name + '.png') }); }
async function launch() {
  app = await _electron.launch({ executablePath: require('electron'), args: [code], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message)); await page.locator('#new-session').waitFor();
  await app.evaluate(({ clipboard }) => {
    globalThis.versionCopies = []; globalThis.versionCopyFail = false;
    clipboard.writeText = text => { if (globalThis.versionCopyFail) throw Error('Synthetic clipboard failure'); globalThis.versionCopies.push(text); };
  });
  // Rendering-only omissions/differing values through actual main IPC. This is
  // not a retained old binary handshake or a replacement for the router unit.
  await app.evaluate(({ app }) => {
    const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json');
    const { WorkspaceClient } = require('./app/workspace-client.cjs'), original = WorkspaceClient.prototype.snapshot;
    globalThis.versionOverrides = new Map();
    WorkspaceClient.prototype.snapshot = function () {
      const value = original.call(this);
      for (const s of value.sessions) if (globalThis.versionOverrides.has(s.id)) s.runtimeVersion = globalThis.versionOverrides.get(s.id);
      return value;
    };
  });
}
async function applyVersions() {
  await app.evaluate((_, values) => { globalThis.versionOverrides = new Map(values); }, overrides);
  for (const [id] of overrides) await fixture('state', id, 'idle');
}
async function create(name, provider) {
  const before = new Set((await snapshot()).sessions.map(s => s.id));
  await page.locator('#new-session').click(); await page.locator(`input[name="provider"][value="${provider}"]`).check(); await page.locator('#session-name').fill(name); await createIn(page, 'chat');
  const s = (await snapshot()).sessions.find(s => !before.has(s.id)); assert.ok(fs.realpathSync(s.cwd).startsWith(owned + path.sep));
  await page.locator('#message-input').fill('Synthetic private draft ' + name); await until(async () => (await snapshot()).sessions.find(x => x.id === s.id).liveDraft === 'Synthetic private draft ' + name, 'Draft saved'); return s.id;
}
async function copyBy(action) {
  const before = await fixture('stats'), n = await app.evaluate(() => globalThis.versionCopies.length);
  await action(); await until(async () => await app.evaluate(() => globalThis.versionCopies.length) === n + 1, 'Exactly one acknowledged version copy');
  const text = await app.evaluate(() => globalThis.versionCopies.at(-1)), s = await snapshot(), after = await fixture('stats');
  assert.ok(text.startsWith('Native Agent Workspace\n应用版本：' + s.appVersion + '\n提交号：未记录\n安装时间：未记录\n'));
  assert.match(text, /后台仅报告版本号，未报告提交号。/);
  for (const session of s.sessions) for (const secret of [session.id, session.nativeId, session.name, session.cwd, session.liveDraft]) if (secret) assert.equal(text.includes(secret), false);
  assert.equal(after.stats.inputs, before.stats.inputs); assert.equal(after.stats.sends, before.stats.sends); assert.equal(after.overviewCalls.claim, before.overviewCalls.claim);
  assert.equal((await snapshot()).diagnostics.dispatches, 0); measurements.push({ stage: 'explicit-version-copy', before, after }); return text;
}
async function run() {
  setup();
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Owned daemon ready');
  await launch(); const initial = await snapshot(); assert.ok(fs.realpathSync(initial.defaultWorkspace).startsWith(owned + path.sep));
  const version = initial.appVersion; assert.equal(await page.locator('#app-version-label').innerText(), 'v' + version); assert.equal(await page.locator('dialog[open]').count(), 0);
  await copyBy(() => page.locator('#app-version').click()); check('Application version is visible without a dialog; one explicit copy acknowledges safe version metadata only');
  const matching = await create('Fixture matching', 'codex'), older = await create('Fixture retained', 'claude'), missing = await create('Fixture missing', 'codex'), development = await create('Fixture development', 'claude');
  overrides = [[older, '0.1.0-alpha.114'], [missing, undefined], [development, 'development']]; await applyVersions();
  await until(async () => (await row(missing).locator('.session-backend-version').innerText()) === '后台版本未知', 'Missing own version visible');
  assert.equal(await row(matching).locator('.session-backend-version').isVisible(), false);
  assert.equal(await row(older).locator('.session-backend-version').innerText(), '后台 alpha.114');
  assert.equal(await row(development).locator('.session-backend-version').innerText(), '后台 development');
  assert.match(await row(missing).locator('.session-link').getAttribute('aria-label'), /后台未报告版本/);
  assert.match(await row(older).locator('.session-link').getAttribute('title'), /后台 0.1.0-alpha.114/);
  const stable = identity(await snapshot()); await capture('01-visible-own-version-badges');
  check('Matching, differing, missing and development values render independently; exact own values are accessible');
  await row(older).locator('.session-link').focus(); await row(older).locator('.session-backend-version').evaluate(el => { window.savedVersionBadge = el; });
  overrides[0][1] = version; await applyVersions(); await until(async () => !(await row(older).locator('.session-backend-version').isVisible()), 'Matching update hides badge');
  assert.equal(await row(older).locator('.session-backend-version').evaluate(el => el === window.savedVersionBadge), true);
  assert.equal(await row(older).locator('.session-link').evaluate(el => el === document.activeElement), true);
  overrides[0][1] = '0.1.0-alpha.114'; await applyVersions(); await until(() => row(older).locator('.session-backend-version').isVisible(), 'Differing update restores badge');
  check('Native snapshot updates change the stable badge while preserving the focused session row');
  await row(missing).locator('.session-link').click(); await page.locator('#advanced').evaluate(el => { el.open = true; });
  assert.match(await page.locator('#advanced-content').innerText(), /后台版本：未报告/);
  assert.equal(await page.locator('#advanced-content').innerText().then(text => text.includes('后台版本：' + version)), false);
  await page.locator('#app-version').focus(); await copyBy(() => page.locator('#app-version').press('Enter'));
  const window = await app.browserWindow(page); await window.evaluate(win => win.setContentSize(950, 700));
  const sidebar = page.locator('.naw[data-native-surface="sidebar"]');
  const revealSidebar = async () => {
    const archive = page.locator('#archive-button');
    if (await archive.getAttribute('aria-expanded') === 'true') await archive.click();
    await archive.click();
    await until(async () => await sidebar.getAttribute('data-collapsed') === 'false', 'Actual DSH sidebar revealed');
    measurements.push({ stage: 'expanded-before-layout-settles', layout: await sidebar.evaluate(el => {
      const label = el.querySelector('#app-version-label'), brand = el.querySelector('.brand');
      return { collapsed: el.dataset.collapsed, width: el.getBoundingClientRect().width, brandWidth: brand.getBoundingClientRect().width,
        labelWidth: label.getBoundingClientRect().width, labelHeight: label.getBoundingClientRect().height, labelDisplay: getComputedStyle(label).display };
    }) });
    await until(async () => await sidebar.evaluate(el => el.getBoundingClientRect().width >= 200) && await page.locator('#app-version-label').isVisible(), 'Expanded DSH width and full version settle');
  };
  await until(async () => await sidebar.getAttribute('data-collapsed') === 'true', 'Actual DSH narrow rail state');
  assert.equal(await page.locator('#app-version-compact').isVisible(), true);
  assert.equal(await row(older).locator('.session-backend-version').isVisible(), true);
  assert.equal(await page.locator('#app-version').evaluate(el => el.getBoundingClientRect().width <= el.parentElement.clientWidth), true);
  assert.match(await page.locator('#app-version').getAttribute('aria-label'), new RegExp(version.replaceAll('.', '\\.')));
  await copyBy(() => page.locator('#app-version').click()); await capture('02-rail-version-controls');
  // The existing archive action uses DSH's real revealSidebar delegate.
  await revealSidebar();
  assert.equal(await page.locator('#app-version-label').innerText(), 'v' + version); assert.equal(await page.locator('#app-version-label').isVisible(), true);
  assert.equal(await page.locator('#app-version-compact').isVisible(), false);
  await window.evaluate(win => win.setContentSize(1240, 850)); await page.locator('#app-version').focus();
  const platform = await page.evaluate(() => document.documentElement.dataset.platform);
  await page.keyboard.press(platform === 'darwin' ? 'Meta+b' : 'Meta+Alt+b');
  await until(async () => await sidebar.getAttribute('data-collapsed') === 'true', 'Actual DSH collapsed sidebar at wide width via registered layout shortcut');
  assert.equal(await page.locator('#app-version-compact').isVisible(), true); assert.equal(await row(older).locator('.session-backend-version').isVisible(), true);
  await copyBy(() => page.locator('#app-version').click());
  await revealSidebar();
  check('Unknown advanced information never borrows the active version; rail controls and keyboard copy remain usable');
  const n = await app.evaluate(() => globalThis.versionCopies.length); await app.evaluate(() => { globalThis.versionCopyFail = true; }); await page.locator('#app-version').click();
  await until(async () => (await page.locator('#toast').innerText()).includes('复制失败，请重试。'), 'Readable copy failure visible');
  assert.equal(await app.evaluate(() => globalThis.versionCopies.length), n); await app.evaluate(() => { globalThis.versionCopyFail = false; });
  await copyBy(() => page.locator('#app-version').click()); check('A rejected clipboard write reports failure; explicit retry copies once');
  await app.close(); await launch(); await applyVersions(); await until(() => row(older).locator('.session-backend-version').isVisible(), 'Reopened own-version badge');
  assert.deepEqual(identity(await snapshot()), stable); assert.ok((await snapshot()).sessions.every(s => fs.realpathSync(s.cwd).startsWith(owned + path.sep)));
  assert.equal(await page.locator('#app-version-label').textContent(), 'v' + version); assert.deepEqual(errors, []);
  measurements.push({ stage: 'final', stats: await fixture('stats') }); check('Full app reopen retains session identities, ownership, private drafts and the source version metadata');
}
run().catch(async e => { failure = e.stack; process.exitCode = 1; console.error(e.stack); if (page) await capture('failure'); }).finally(async () => {
  try {
    try {
      const sourceAfter = hashes();
      if (JSON.stringify(sourceAfter) !== JSON.stringify(sourceBefore)) { failure ||= 'Source changed during test'; process.exitCode = 1; }
      if (evidence && fs.existsSync(evidence)) fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ flowPassed: !failure, failure, checks, errors, measurements, sourceBefore, sourceAfter, profile, token, qualification: 'One real source service; version-field omissions injected in main snapshot for rendering only; two-owning-backend attribution independently unit-tested. No installed/live-provider/OS clipboard qualification.' }, null, 2));
    } finally {
      await scratch.release();
      if (slotOwned) { const owner = JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))); assert.equal(owner.token, token); fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot); }
      if (evidence && fs.existsSync(evidence)) fs.writeFileSync(path.join(evidence, 'released.json'), JSON.stringify({ profile, token, exists: profile ? fs.existsSync(profile) : false }, null, 2));
    }
  } catch (e) { console.error(e.stack); process.exitCode = 1; }
});
