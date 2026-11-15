// Many-member progressive display. Hidden Electron, disposable profile, synthetic
// native transport. Asserts: columns keep a 300px floor, member names stay
// readable, "show more" reveals one row per click, and a fitting member set keeps
// the old per-member column layout. Captures before/after screenshots.
const scratch = require('./fixtures/test-scratch.cjs');
const { revealDefaultSpace } = require('./fixtures/default-space.cjs');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { _electron } = scratch.playwright(require('playwright'));
const { connectService } = require('../app/service-connection.cjs');
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const membersCount = Number(process.env.NAW_MEMBERS || 12);
const wide = process.argv.includes('--wide');
const tag = process.argv.includes('--before') ? 'before' : 'after';
const assertArg = process.argv.find(a => a.startsWith('--assert='));
const only = assertArg ? Number(assertArg.slice('--assert='.length)) : 0;
const check = (n, fn) => { if (!only || only === n) fn(); };
const output = process.env.NAW_EVIDENCE_DIR;
if (!output || !path.isAbsolute(output) || [root, code].some(p => path.resolve(output) === p || path.resolve(output).startsWith(p + path.sep))) throw Error('Private evidence directory required');
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
const pictures = path.join(process.env.NAW_PICTURES_DIR || path.join(os.homedir(), 'Pictures/naw-dogfood'), `many-members-${tag}-${membersCount}-${randomId()}`);
fs.mkdirSync(pictures, { recursive: true, mode: 0o700 });
function randomId() { return Math.random().toString(36).slice(2, 10); }
const slot = path.join(code, '.local/gui-test-slot.lock'), token = randomId() + randomId();
fs.mkdirSync(path.dirname(slot), { recursive: true });
try { fs.mkdirSync(slot); } catch (e) { if (e.code !== 'EEXIST') throw e; console.error('GUI slot occupied'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ token, pid: process.pid, task: 'many members hidden synthetic test' }));
let child, client, app, page, sequence = 0; const errors = [];
const profile = fs.realpathSync(scratch.directory(path.join(os.tmpdir(), 'naw-many-members-')));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { for (let i = 0; i < 200; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
function fixture(method, target, value) {
  const id = ++sequence, field = method === 'backgroundProof' ? 'proofRequestId' : 'requestId';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.off('message', cb); reject(Error('Fixture timeout: ' + method)); }, 10000);
    const cb = r => { if (r[field] === id) { clearTimeout(timer); child.off('message', cb); r.error ? reject(Error(r.error)) : resolve(r); } };
    child.on('message', cb); child.send({ id, method, target, value });
  });
}
async function main() {
  child = scratch.childProcess.fork(path.join(code, 'app/daemon.cjs'), [profile], {
    execArgv: ['--require', path.join(root, 'scripts/fixtures/activity-stream.cjs')],
    env: { ...process.env, NAW_TEST_APP_ROOT: code, NAW_WORKSPACE: profile, NAW_APP_VERSION: require(path.join(code, 'package.json')).version },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Service starts');
  client = await connectService(profile, 'human-view');
  for (let i = 0; i < membersCount; i++) {
    const letter = String.fromCharCode(65 + (i % 26));
    const name = i === 5 ? 'DeepSeek pro 2' : (i % 2 ? `Claude ${letter}` : `Codex ${letter}`);
    const id = await client.call('create', { provider: i % 2 ? 'claude' : 'codex', cwd: profile, name, view: 'chat' });
    await client.call('join', id, true);
  }
  fs.writeFileSync(path.join(profile, 'views.json'), JSON.stringify([{ owner: 'human-view', active: true, selected: 'room', mode: 'chat',
    roomViews: { shared: { roomSurface: 'overview' } } }]), { mode: 0o600 });
  app = await _electron.launch({ executablePath: require('electron'), args: [code], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid), NAW_TEST_UI_LANGUAGE: 'zh' }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message));
  await revealDefaultSpace(page);
  await page.locator('#room-nav').waitFor({ state: 'visible', timeout: 30000 }); await delay(300); await page.locator('#room-nav').click();
  await page.locator('.collaboration-readers').waitFor();
  const win = await app.browserWindow(page);
  async function resize(size) { await win.evaluate((w, [w2, h2]) => w.setContentSize(w2, h2), size); await delay(700); }
  async function shot(size, scenario) {
    await resize(size);
    const file = path.join(pictures, `${tag}-m${membersCount}-${scenario}.png`);
    await page.screenshot({ path: file }); console.log('SHOT', file);
  }
  const measure = () => page.evaluate(() => {
    const readers = document.querySelector('.collaboration-readers');
    const units = [...readers.querySelectorAll('.collaboration-member-unit')];
    const visible = units.filter(u => !u.hidden);
    const widths = visible.map(u => Math.round(u.querySelector('.collaboration-member-reader').getBoundingClientRect().width));
    const grips = visible.map(u => !u.querySelector('.collaboration-resize').hidden);
    const nameOverflow = [...document.querySelectorAll('.collaboration-name-text')].filter(t => t.scrollWidth > t.clientWidth + 1).length;
    const showMore = document.querySelector('.collaboration-show-more');
    return { visible: visible.length, total: units.length, widths, grips, nameOverflow, showMore: showMore && !showMore.hidden ? showMore.textContent : null };
  });
  if (wide) {
    await resize([2100, 900]);
    const m = await measure();
    check(4, () => assert.equal(m.visible, membersCount, 'all fitting members are shown at once'));
    check(4, () => assert.equal(m.grips.filter(Boolean).length, membersCount - 1, 'drag grips stay for every column except the last'));
    check(4, () => assert.equal(m.showMore, null, 'no reveal button when everyone fits'));
    await shot([2100, 900], 'wide');
  } else {
    for (const [size, scenario] of [[[1240, 820], '1240-open']]) await shot(size, scenario);
    // Collapse the shared-records panel, then capture the full-width grid.
    await page.evaluate(() => { const panel = document.getElementById('activity-stream'); if (panel) panel.hidden = true; const layout = document.getElementById('room-layout'); if (layout) layout.classList.remove('stream-open'); });
    await shot([1240, 820], '1240-collapsed');
    await shot([850, 600], '850');
    const m = await measure();
    check(1, () => assert.ok(m.widths.every(w => w >= 300), `columns below 300px: ${m.widths}`));
    check(2, () => assert.equal(m.nameOverflow, 0, 'member names are not ellipsized'));
    if (membersCount >= 6) {
      check(3, () => assert.ok(m.showMore, 'a reveal button is present when members do not fit one row'));
      if (m.showMore) {
        const before = m.visible;
        await page.locator('.collaboration-show-more').click(); await delay(400);
        const after = await measure();
        check(3, () => assert.equal(after.visible, Math.min(membersCount, before * 2), 'show-more reveals exactly one more row'));
        await shot([850, 600], 'more');
      }
    }
    const chipsMore = page.locator('.collaboration-chips-more');
    if (await chipsMore.count() && await chipsMore.isVisible()) {
      await chipsMore.click(); await delay(400);
      const expanded = await page.evaluate(() => document.querySelector('.collaboration-statuses').style.maxHeight === '');
      assert.ok(expanded, 'chips expand past two lines');
      await shot([1240, 820], 'chips');
    }
  }
  const stats = await fixture('stats');
  assert.equal(stats.modelCalls, 0); assert.equal(stats.nativeProcesses, 0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ tag, membersCount, passed: true, pictures }));
}
main().catch(async e => { console.error(e.stack); process.exitCode = 1; if (page && !page.isClosed()) await page.screenshot({ path: path.join(pictures, 'failure.png') }).catch(() => {}); })
  .finally(scratch.cleanup(async () => {
    if (app) await app.close().catch(() => {});
    if (client) { await client.call('shutdown').catch(() => {}); client.close(); }
    if (child?.connected) child.disconnect();
    if (child?.exitCode === null) child.kill('SIGTERM');
    const owner = JSON.parse(fs.readFileSync(path.join(slot, 'owner.json')));
    if (owner.token === token) { fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot); }
  }));
