// The member tab in the conversation toolbar names the session on screen, on every route out of and into a space
// (the person, 2026-11-22: 「貌似没有和当前的会话匹配上」). Hidden source Electron, real daemon, synthetic native transport;
// no provider, model, native input or clipboard.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const scratch = require('./fixtures/test-scratch.cjs'), { createIn } = require('./fixtures/create-view.cjs');
const { revealDefaultSpace } = require('./fixtures/default-space.cjs');
const { _electron } = scratch.playwright(require('playwright'));

const evidence = process.env.NAW_EVIDENCE_DIR;
assert.ok(evidence && path.isAbsolute(evidence), 'Explicit evidence directory required');
assert.ok(!path.resolve(evidence).startsWith(root + path.sep), 'Evidence stays outside the checkout');
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = [], errors = [];
let profile, owned, child, app, page, slotOwned = false, sequence = 0, profileIdentity, sidebarView;

function fixture(method, target, value) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const receive = packet => {
      if (packet.requestId !== id) return;
      clearTimeout(timer); child.off('message', receive);
      if (packet.error) reject(Error(packet.error)); else resolve(packet);
    };
    const timer = setTimeout(() => { child.off('message', receive); reject(Error('Synthetic fixture timed out')); }, 10000);
    child.on('message', receive); child.send({ id, method, target, value });
  });
}
async function until(fn, label) {
  for (let i = 0; i < 160; i++) { if (await fn()) return; await delay(50); }
  throw Error(label);
}
const snapshot = () => page.evaluate(() => workspace.initial());
const card = id => page.locator(`.collaboration-member-status[data-member-id="${id}"] .collaboration-member-name`);
const sidebarSurface = () => page.locator('.naw[data-native-surface="sidebar"]');
// Inside a space the sidebar is a rail; its 会话 route lists the independent sessions. Elsewhere the person's
// sidebar, grouped by space as in the report, shows every session row.
async function openSession(id, name) {
  if (await page.locator('#independent-nav').isVisible()) {
    await page.locator('#independent-nav').click();
    await page.getByRole('menuitem').filter({ hasText: name }).click();
    return;
  }
  if (await page.locator('#sessions-grouped').getAttribute('aria-pressed') !== 'true') {
    sidebarView ||= await page.locator('#sessions-flat').getAttribute('aria-pressed') === 'true' ? '#sessions-flat' : '#sessions-folders';
    await page.locator('#sessions-grouped').click();
  }
  await sidebarSurface().locator(`[data-session-row="${id}"] .session-link`).first().click();
}
async function settle() { await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))); }

// What the toolbar shows against what is on screen. `onScreen` is the session the conversation pane shows.
async function reading() {
  const view = (await snapshot()).viewState;
  const shown = await page.evaluate(() => {
    const tabs = document.getElementById('room-member-tabs');
    return {
      hiddenAttribute: tabs.hidden,
      visible: tabs.checkVisibility(),
      toolbarVisible: document.getElementById('conversation-pane-toolbar').checkVisibility(),
      tabIds: [...tabs.children].map(tab => tab.dataset.roomSession),
      text: tabs.innerText.trim(),
      records: document.getElementById('room-record').getAttribute('aria-pressed') === 'true',
      pane: document.getElementById('conversation-pane').checkVisibility(),
    };
  });
  const onScreen = view.selected === 'room' ? (shown.pane ? view.roomSession || '' : '') : view.selected || '';
  return { selected: view.selected, roomSession: view.roomSession || '', onScreen, ...shown };
}
async function step(label, expectTab, names) {
  await settle();
  const actual = await reading();
  const passed = expectTab
    ? actual.visible && actual.onScreen === expectTab && actual.tabIds.length === 1 && actual.tabIds[0] === expectTab && actual.text.includes(names[expectTab])
    : !actual.visible;
  results.push({ label, expected: expectTab ? `visible tab for ${names[expectTab]}` : 'no member tab', passed, actual });
  console.log(passed ? 'PASS' : 'FAIL', label, JSON.stringify(actual));
  await page.screenshot({ path: path.join(evidence, `${String(results.length).padStart(2, '0')}-${passed ? 'pass' : 'fail'}.png`) });
}
async function create(label, provider) {
  const before = new Set((await snapshot()).sessions.map(s => s.id));
  await page.locator('#new-session').click();
  await page.locator(`input[name="provider"][value="${provider}"]`).check();
  await page.locator('#session-name').fill(label);
  await createIn(page, 'chat');
  const record = (await snapshot()).sessions.find(s => !before.has(s.id));
  assert.ok(record && fs.realpathSync(record.cwd).startsWith(owned + path.sep));
  return record.id;
}

async function run() {
  try { fs.mkdirSync(slot); } catch (e) { if (e.code !== 'EEXIST') throw e; console.error('OCCUPIED: no profile/daemon/GUI launched'); process.exit(75); }
  slotOwned = true;
  fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Claude stale member tab', token, pid: process.pid, time: new Date().toISOString() }));
  fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
  profile = scratch.directory(path.join(os.tmpdir(), 'naw-stale-tab-')); owned = fs.realpathSync(profile);
  const stat = fs.lstatSync(owned); profileIdentity = { path: owned, uid: stat.uid, dev: stat.dev, ino: stat.ino };
  console.log('OWNED PROFILE', JSON.stringify(profileIdentity));
  const cwd = path.join(profile, 'workspace'); fs.mkdirSync(cwd, { mode: 0o700 });
  child = scratch.childProcess.fork(path.join(root, 'app/daemon.cjs'), [profile], {
    execArgv: ['--require', path.join(root, 'scripts/fixtures/collaboration-overview.cjs')],
    env: { ...process.env, NAW_TEST_APP_ROOT: root, NAW_WORKSPACE: cwd, NAW_APP_VERSION: require('../package.json').version },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Owned synthetic daemon ready');
  app = await _electron.launch({ args: [root], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid), NAW_TEST_VISIBLE: '0' }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(8000);
  page.on('pageerror', error => errors.push(error.message));
  await page.locator('#new-session').waitFor();
  await (await app.browserWindow(page)).evaluate(w => w.setContentSize(1400, 860));
  assert.deepEqual(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => w.isVisible())), [false], 'One hidden test window');

  const names = { };
  const a = await create('Synthetic member Alpha', 'codex'); names[a] = 'Synthetic member Alpha';
  const b = await create('Synthetic member Bravo', 'claude'); names[b] = 'Synthetic member Bravo';
  const c = await create('Synthetic solo Charlie', 'claude'); names[c] = 'Synthetic solo Charlie';
  for (const id of [a, b]) await page.evaluate(id => workspace.join(id, true), id);
  await revealDefaultSpace(page);

  // 1 space -> member A, then an independent session from the sidebar.
  await page.locator('#room-nav').click(); await card(a).waitFor();
  await card(a).click(); await until(async () => (await snapshot()).viewState.roomSession === a, 'Member A focused');
  await step('1a member A focused in the space', a, names);
  await openSession(c, names[c]); await until(async () => (await snapshot()).viewState.selected === c, 'Independent C selected');
  await step('1b member A -> independent C', null, names);
  // 2 independent -> space: the saved member focus returns with its own tab.
  await page.locator('#room-nav').click(); await until(async () => (await snapshot()).viewState.selected === 'room', 'Space selected');
  await step('2a independent C -> space (saved focus on A)', a, names);
  // 3 member -> member.
  await page.locator('#room-overview').click(); await until(async () => !(await snapshot()).viewState.roomSession, 'Whole space');
  await step('3a member A -> whole space', null, names);
  await card(b).click(); await until(async () => (await snapshot()).viewState.roomSession === b, 'Member B focused');
  await step('3b whole space -> member B', b, names);
  // 4 member -> 共享记录. It opens beside the member's conversation, which stays on screen with its tab.
  await page.locator('#room-record').click(); await until(async () => await page.locator('#room-record').getAttribute('aria-pressed') === 'true', 'Records page');
  await step('4a member B -> 共享记录 panel (B stays on screen)', b, names);
  // 5 records -> independent -> member again -> member B as an independent session -> back.
  await page.locator('#room-overview').click(); await card(b).waitFor();
  await card(b).click(); await until(async () => (await snapshot()).viewState.roomSession === b, 'Member B focused again');
  await openSession(c, names[c]); await until(async () => (await snapshot()).viewState.selected === c, 'Independent C again');
  await step('5a member B -> independent C', null, names);
  await openSession(b, names[b]); await settle();
  await step(`5b independent C -> sidebar entry of B (${(await snapshot()).viewState.selected === 'room' ? 'in space' : 'solo'})`, (await snapshot()).viewState.selected === 'room' ? b : null, names);
  // 6 member -> panorama. The grouped list replaces the space row; return to the sidebar view the profile started with.
  if (sidebarView) await page.locator(sidebarView).click();
  await page.locator('#room-nav').click(); await until(async () => (await snapshot()).viewState.selected === 'room', 'Space again');
  if (!(await snapshot()).viewState.roomSession) { await card(a).click(); await until(async () => (await snapshot()).viewState.roomSession === a, 'Member A focused again'); }
  await page.locator('#panorama-nav').click(); await until(async () => (await snapshot()).viewState.selected === 'panorama', 'Panorama');
  await step('6a member -> panorama', null, names);

  const stats = await fixture('stats');
  assert.equal(stats.stats.inputs, 0); assert.equal(stats.stats.sends, 0);
  assert.deepEqual(errors, []);
}

run().catch(async error => {
  process.exitCode = 1; console.error(error.stack);
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {});
}).finally(async () => {
  if (!slotOwned) return;
  const failed = results.filter(r => !r.passed);
  if (failed.length) process.exitCode = 1;
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ passed: !process.exitCode, results, errors, profileIdentity }, null, 2));
  console.log(`SUMMARY pass=${results.length - failed.length} fail=${failed.length}`);
  try {
    await scratch.release(); assert.equal(fs.existsSync(owned), false);
    console.log('OWNED PROFILE REMOVED', JSON.stringify(profileIdentity));
    const owner = JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))); assert.equal(owner.token, token);
    fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot);
  } catch (e) { console.error('Cleanup unconfirmed; slot retained:', e.stack); process.exitCode = 1; }
});
