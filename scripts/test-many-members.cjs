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
const shotsOnly = process.argv.includes('--shots-only');
const check = (n, fn) => { if (shotsOnly) return; if (!only || only === n) fn(); };
const output = process.env.NAW_EVIDENCE_DIR;
if (!output || !path.isAbsolute(output) || [root, code].some(p => path.resolve(output) === p || path.resolve(output).startsWith(p + path.sep))) throw Error('Private evidence directory required');
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
const pictures = path.join(process.env.NAW_PICTURES_DIR || path.join(os.homedir(), 'Pictures/naw-dogfood'), `many-members-${tag}-${membersCount}-${randomId()}`);
function randomId() { return Math.random().toString(36).slice(2, 10); }
const slot = process.env.NAW_GUI_TEST_SLOT || path.join(code, '.local/gui-test-slot.lock'), token = randomId() + randomId();
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
  fs.mkdirSync(pictures, { recursive: true, mode: 0o700 });
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
  assert.equal(await win.evaluate(w => w.isVisible() || w.isFocused()), false, 'The isolated window stays hidden and unfocused');
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
    // A row of the grid is a member's card: its head, then its reader.
    const widths = visible.map(u => Math.round(u.getBoundingClientRect().width));
    const heights = visible.map(u => Math.round(u.getBoundingClientRect().height));
    const grips = visible.map(u => !u.querySelector('.collaboration-resize').hidden);
    const nameOverflow = [...document.querySelectorAll('.collaboration-name-text')].filter(t => t.scrollWidth > t.clientWidth + 1).length;
    const showMore = document.querySelector('.collaboration-show-more');
    const headers = document.querySelector('.collaboration-statuses'), chipsMore = document.querySelector('.collaboration-chips-more');
    let chipsMoreFits = false, chipsMoreText = null;
    const shownChips = headers && !headers.hidden ? [...headers.querySelectorAll('.collaboration-member-chip')].filter(c => !c.hidden) : [];
    const chipLines = new Set(shownChips.map(c => c.offsetTop)).size;
    if (chipsMore && !chipsMore.hidden) {
      chipsMoreText = chipsMore.textContent;
      const chip = headers?.querySelector('.collaboration-member-chip');
      const rowH = chip ? chip.offsetHeight + (parseFloat(getComputedStyle(headers).gap) || 0) : 32;
      chipsMoreFits = chipsMore.offsetTop + chipsMore.offsetHeight <= rowH * 2 + 1;
    }
    return { visible: visible.length, total: units.length, widths, heights, grips, nameOverflow,
      showMore: showMore && !showMore.hidden ? showMore.textContent : null,
      scrollable: readers.scrollHeight > readers.clientHeight + 1, clientH: readers.clientHeight,
      overflowY: getComputedStyle(readers).overflowY, chipsMoreFits, chipsMoreText, chipsShown: shownChips.length, chipLines };
  });
  // Each member's name sits in its own card (.collaboration-member-unit) above its own reader.
  const cards = () => page.evaluate(() => {
    const host = document.querySelector('#collaboration-overview');
    const heads = [...host.querySelectorAll('.collaboration-member-status')];
    return [...host.querySelectorAll('.collaboration-member-reader')].map(reader => {
      const id = reader.dataset.memberId, unit = reader.closest('.collaboration-member-unit');
      const name = heads.find(h => h.dataset.memberId === id)?.querySelector('.collaboration-member-name');
      const shown = Boolean(unit && !unit.hidden && reader.getClientRects().length);
      const n = name?.getBoundingClientRect(), r = reader.getBoundingClientRect(), u = unit?.getBoundingClientRect();
      return { id, label: name?.textContent.trim() || '', inOwnUnit: Boolean(name && unit && unit.dataset.memberId === id && unit.contains(name)),
        beforeReader: Boolean(name && name.compareDocumentPosition(reader) & Node.DOCUMENT_POSITION_FOLLOWING), shown,
        above: shown ? n.bottom <= r.top + 0.5 : null, withinCard: shown ? n.left >= u.left - 0.5 && n.right <= u.right + 0.5 && n.top >= u.top - 0.5 : null };
    });
  });
  const ownCards = (list, label) => {
    assert.equal(list.length, membersCount, `${label}: one reader per member`);
    for (const c of list) {
      assert.ok(c.inOwnUnit, `${label}: ${c.label || c.id}'s name is inside its own .collaboration-member-unit`);
      assert.ok(c.beforeReader, `${label}: ${c.label || c.id}'s name comes before its own reader`);
      if (c.shown) assert.ok(c.above && c.withinCard, `${label}: ${c.label || c.id}'s name is drawn inside its card, above its reader`);
    }
    assert.ok(list.some(c => c.shown), `${label}: at least one card is shown`);
  };
  await shot([1240, 820], '1240-open');
  const m1240 = await measure(), c1240 = await cards();
  console.log('CARDS 1240-open', JSON.stringify(c1240.map(c => [c.inOwnUnit, c.beforeReader, c.above].map(Number).join(''))));
  // 5. Names belong to their own cards (6 members at 1240 with the side panel open; 20 members at 1240).
  check(5, () => ownCards(c1240, '1240 open'));
  // Card-head close-up: the first two cards' frames, heads and the one line under each head.
  if (membersCount <= 6) {
    const clip = await page.evaluate(() => {
      const units = [...document.querySelectorAll('.collaboration-member-unit')].filter(u => !u.hidden).slice(0, 2).map(u => u.getBoundingClientRect());
      const head = document.querySelector('.collaboration-member-unit>.collaboration-member-status').getBoundingClientRect();
      return { x: Math.max(0, units[0].left - 8), y: Math.max(0, units[0].top - 8), width: units[units.length - 1].right - units[0].left + 16, height: head.bottom - units[0].top + 48 };
    });
    await page.screenshot({ path: path.join(pictures, `${tag}-m${membersCount}-card-head.png`), clip });
    console.log('SHOT', path.join(pictures, `${tag}-m${membersCount}-card-head.png`));
  }
  // 1. Six members no longer count as fitting when their columns would be below 300px.
  if (membersCount <= 6) check(1, () => {
    assert.ok(m1240.visible < membersCount, 'only the fitting row is initially shown at 1240');
    assert.ok(m1240.widths.every(width => width >= 299.5), 'every initial column keeps 300px');
    assert.ok(m1240.showMore, 'the other members remain reachable through reveal');
  });
  // 2. The index of names takes at most two lines: every chip when they fit, otherwise a "+N" fold inside them.
  if (membersCount >= 12) check(2, () => {
    if (membersCount >= 20) assert.ok(m1240.chipsMoreText, 'the +N fold is present for 20 members');
    if (m1240.chipsMoreText) assert.ok(m1240.chipsMoreFits, 'the +N fold stays within two lines');
    else assert.ok(m1240.chipsShown === membersCount && m1240.chipLines <= 2, `without a fold every member's chip is shown within two lines (${m1240.chipsShown}, ${m1240.chipLines} lines)`);
  });
  // Folded name-band close-up (the +N fold) before expanding.
  if (membersCount >= 12) {
    await page.locator('.collaboration-statuses').screenshot({ path: path.join(pictures, `${tag}-m${membersCount}-chips-folded.png`) });
    console.log('SHOT', path.join(pictures, `${tag}-m${membersCount}-chips-folded.png`));
  }
  // Collapse the shared-records panel, then capture the full-width grid.
  await page.evaluate(() => { const panel = document.getElementById('activity-stream'); if (panel) panel.hidden = true; const layout = document.getElementById('room-layout'); if (layout) layout.classList.remove('stream-open'); });
  await shot([1240, 820], '1240-collapsed');
  await shot([850, 600], '850');
  const m850 = await measure(), c850 = await cards();
  console.log('CARDS 850', JSON.stringify(c850.map(c => [c.inOwnUnit, c.beforeReader, c.above].map(Number).join(''))));
  check(5, () => ownCards(c850, '850'));
  // 4. The reveal button states how many are already shown.
  if (membersCount >= 6) check(4, () => {
    assert.ok(m850.showMore, 'a reveal button is present when members do not fit');
    assert.match(m850.showMore, /已显示 \d+\/\d+/, `reveal button states the shown count: ${m850.showMore}`);
  });
  // 3. Revealing more rows scrolls instead of squishing the columns.
  if (membersCount >= 12 && m850.showMore) {
    const before = m850.visible;
    await page.locator('.collaboration-show-more').click(); await delay(400);
    await page.locator('.collaboration-show-more').click(); await delay(400);
    const after = await measure();
    check(3, () => {
      assert.ok(after.visible > before, 'show-more reveals more members');
      assert.equal(after.overflowY, 'auto', 'readers scroll after revealing more rows');
      assert.ok(after.heights.every(h => h >= after.clientH - 4), `rows keep their full height: ${after.heights} vs ${after.clientH}`);
    });
    await shot([850, 600], 'more2');
  }
  const chipsMore = page.locator('.collaboration-chips-more');
  if (await chipsMore.count() && await chipsMore.isVisible()) {
    await chipsMore.click(); await delay(400);
    const expanded = await page.evaluate(() => document.querySelector('.collaboration-statuses').style.maxHeight === '');
    assert.ok(expanded, 'chips expand past two lines');
    await shot([1240, 820], 'chips');
  }
  if (!shotsOnly && !only) {
    const results = [], failures = [];
    const runCheck = async (name, fn) => {
      try { await fn(); results.push({ name, passed: true }); console.log('PASS', name); }
      catch (error) { results.push({ name, passed: false, error: error.stack }); failures.push(error); console.error('FAIL', name, error.message); }
    };
    const controls = page.locator('.collaboration-layout-controls');
    const gridButton = controls.getByRole('button', { name: '网格', exact: true });
    const listButton = controls.getByRole('button', { name: '列表', exact: true });
    const order = () => page.locator('.collaboration-readers>.collaboration-member-unit').evaluateAll(nodes => nodes.map(n => n.dataset.memberId));
    // The wide case keeps the real shared-record panel open, as in the reported failure.
    const panel = page.locator('#activity-stream');
    if (!await panel.isVisible()) await page.locator('#room-record').click();
    for (const size of [[1240, 820], [850, 600]]) {
      await resize(size);
      await gridButton.click(); await delay(150);
      const gridBefore = await measure();
      await listButton.click(); await delay(150);
      const listState = await measure();
      console.log('LIST', size[0], JSON.stringify(listState));
      await runCheck(`${size[0]} list: every member is reachable by scrolling`, async () => {
        assert.equal(listState.visible, membersCount, 'List must expose every member without a grid reveal control');
        assert.equal(listState.showMore, null);
        assert.equal(listState.overflowY, 'auto');
        for (const id of await order()) {
          const card = page.locator(`.collaboration-readers>.collaboration-member-unit[data-member-id="${id}"]`);
          await card.scrollIntoViewIfNeeded();
          assert.equal(await card.evaluate(node => {
            const r = node.getBoundingClientRect(), viewport = node.parentElement.getBoundingClientRect();
            return !node.hidden && r.height > 0 && r.bottom > viewport.top && r.top < viewport.bottom;
          }), true, `Member ${id} can enter the scrolling viewport`);
        }
      });
      await page.locator('.collaboration-readers').evaluate(node => { node.scrollTop = 0; });
      const file = path.join(pictures, `m${membersCount}-list-${size[0]}.png`);
      await page.screenshot({ path: file }); console.log('SHOT', file);
      await gridButton.click(); await delay(150);
      await runCheck(`${size[0]} list round trip preserves grid reveal progress`, async () => {
        assert.equal((await measure()).visible, gridBefore.visible);
      });
    }
    // Keep two drag targets in the same visible grid row, matching the original
    // passing ordering probe; list reachability above retains the side panel.
    if (await panel.isVisible()) await page.locator('#room-record').click();
    await resize([1240, 820]); await gridButton.click(); await delay(200);
    const beforeOrder = await order();
    const first = beforeOrder[0], second = beforeOrder[1];
    const name = id => page.locator(`.collaboration-member-unit[data-member-id="${id}"] .collaboration-member-name`);
    const destination = page.locator(`.collaboration-member-unit[data-member-id="${second}"]>.collaboration-member-status`);
    await page.locator('.collaboration-readers').evaluate(node => { node.scrollTop = 0; });
    await runCheck('actual name drag preserves member-card ordering', async () => {
      const box = await destination.boundingBox();
      await name(first).dragTo(destination, { targetPosition: { x: box.width - 3, y: box.height - 3 } }); await delay(200);
      const after = await order();
      assert.notDeepEqual(after, beforeOrder); assert.equal(after.indexOf(first), after.indexOf(second) + 1);
    });
    await runCheck('Alt+ArrowDown preserves keyboard ordering', async () => {
      const before = await order(), index = before.indexOf(second), neighbor = before[index + 1];
      await name(second).press('Alt+ArrowDown'); await delay(200);
      const after = await order(); assert.equal(after.indexOf(second), index + 1); assert.equal(after[index], neighbor);
    });
    await runCheck('grid can reveal every member after visiting list', async () => {
      for (let n = 0; n < membersCount && await page.locator('.collaboration-show-more').isVisible(); n++) {
        await page.locator('.collaboration-show-more').click();
      }
      assert.equal((await measure()).visible, membersCount);
    });
    if (membersCount <= 6) await runCheck('a genuinely fitting member set has no reveal button', async () => {
      await resize([2460, 820]); await delay(200);
      const fitting = await measure();
      assert.equal(fitting.visible, membersCount);
      assert.equal(fitting.showMore, null);
      assert.ok(fitting.widths.every(width => width >= 299.5));
    });
    fs.writeFileSync(path.join(output, 'list-regression.json'), JSON.stringify(results, null, 2));
    console.log(`LIST RESULT passed=${results.filter(r => r.passed).length} failed=${failures.length}`);
    assert.equal(failures.length, 0, 'Every list, grid and ordering check must pass');
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
