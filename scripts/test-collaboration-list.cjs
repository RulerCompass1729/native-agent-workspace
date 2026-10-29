// Actual isolated source GUI/service. Only native output is synthetic.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const scratch = require('./fixtures/test-scratch.cjs'), { createIn } = require('./fixtures/create-view.cjs');
const installed = Boolean(process.env.NAW_APP_EXECUTABLE);
const { _electron } = scratch.playwright(installed ? { _electron: require('./fixtures/installed-renderer.cjs') } : require('playwright'));
const evidence = process.env.NAW_EVIDENCE_DIR;
if (evidence) {
  const target = path.resolve(evidence); let existing = target;
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  const destination = path.join(fs.realpathSync(existing), path.relative(existing, target));
  for (const base of [root, code].map(p => fs.realpathSync(p))) assert.ok(destination !== base && !destination.startsWith(base + path.sep));
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
}
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID();
try { fs.mkdirSync(slot); } catch (e) { if (e.code !== 'EEXIST') throw e; console.error('GUI slot occupied; nothing started.'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Codex4', task: 'T91 collaboration list', token, pid: process.pid, time: new Date().toISOString() }));
const profile = scratch.directory(path.join(os.tmpdir(), 'naw-collaboration-list-'));
const workspaceRoot = path.join(profile, 'workspace'); fs.mkdirSync(workspaceRoot);
const child = scratch.childProcess.fork(path.join(code, 'app/daemon.cjs'), [profile], {
  execArgv: ['--require', path.join(__dirname, 'fixtures/loading-terminal.cjs')],
  env: { ...process.env, NAW_TEST_APP_ROOT: code, NAW_WORKSPACE: workspaceRoot, NAW_APP_VERSION: require(path.join(code, 'package.json')).version },
  stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
});
if (process.env.NAW_EVIDENCE_DIR) { fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(process.env.NAW_EVIDENCE_DIR, 'test-daemon-launch.json'), JSON.stringify({ pid: child.pid, argv: child.spawnargs, appRoot: code, syntheticTransport: true }, null, 2)); }
const checks = [], errors = [], measurements = [];
let app, page, sequence = 0, failure = null;
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
const check = text => { checks.push(text); console.log('PASS:', text); };
async function launch() {
  app = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: installed ? [] : [code], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message)); await page.locator('#new-session').waitFor();
  if (!installed) await app.evaluate(({ clipboard }) => { globalThis.pageCopies = []; clipboard.writeText = text => globalThis.pageCopies.push(text); });
}
async function create(name) {
  await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="codex"]').check();
  await page.locator('#session-name').fill(name); await createIn(page, 'chat');
  return (await snapshot()).sessions.find(s => s.name === name).id;
}
async function capture(name) { if (evidence) await page.screenshot({ path: path.join(evidence, name + '.png') }); }
async function readingAnchor(host = page.locator('#messages')) {
  return host.evaluate(el => {
    const top = el.getBoundingClientRect().top;
    const row = [...el.querySelectorAll(':scope > [data-message-id]')].find(n => n.getBoundingClientRect().bottom > top);
    return row && { id: row.dataset.messageId, offset: row.getBoundingClientRect().top - top };
  });
}
async function copyOriginal(host, id, text) {
  const copy = host.locator(`[data-message-id="${id}"] .message-actions`).getByRole('button', { name: '复制', exact: true });
  if (installed) {
    await copy.focus(); assert.equal(await copy.isEnabled(), true);
    assert.equal((await snapshot()).sessions.flatMap(s => s.messages).find(m => m.id === id)?.text, text);
    const body = await host.locator(`[data-message-id="${id}"] .message-body`).innerText();
    assert.ok(text.split(/\n+/).filter(Boolean).every(line => body.includes(line))); return;
  }
  const before = await app.evaluate(() => globalThis.pageCopies.length);
  await copy.focus(); await copy.press('Enter');
  await until(async () => await app.evaluate((_, n) => globalThis.pageCopies.length === n + 1 && globalThis.pageCopies.at(-1), before) === text, 'One fresh original copy receipt');
}
async function run() {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Own fixture started'); await launch();
  const ids = [], names = ['List member A', 'List member B', 'List member C', '长名'.repeat(28) + 'Long'];
  for (let i = 0; i < 4; i++) {
    const id = await create(names[i]); ids.push(id);
    await fixture('history', id, Array.from({ length: 24 }, (_, j) => ({ id: `list-${i}-${j}`, type: 'agentMessage', turnId: `turn-${i}`,
      text: `Original member ${i} line ${j}.\n\n原会话内容，保持独立。` })));
    await page.locator('#message-input').fill('Independent unsent draft ' + i);
    await until(async () => (await snapshot()).sessions.find(s => s.id === id).liveDraft === 'Independent unsent draft ' + i, 'Draft persisted');
    await page.locator('#session-header-more').click(); await page.getByRole('menuitem', { name: '加入协作', exact: true }).click();
  }
  const identity = s => s.sessions.map(x => [x.id, x.nativeId, x.owner, x.liveDraft]);
  const originalIdentity = identity(await snapshot());
  await page.locator('#room-nav').click();
  const overview = page.locator('#collaboration-overview'), list = overview.locator('.collaboration-readers');
  const reader = id => overview.locator(`.collaboration-member-reader[data-member-id="${id}"] .messages`);
  const header = id => overview.locator(`.collaboration-member-status[data-member-id="${id}"]`);
  const layout = name => page.getByRole('button', { name, exact: true });
  await overview.locator('.collaboration-member-reader').nth(3).waitFor();
  await page.evaluate(() => { globalThis.listOriginalNodes = [...document.querySelectorAll('.collaboration-member-reader')].map(r => [r, r.querySelector('.messages')]); });
  async function geometry(name) {
    const rows = await overview.evaluate(el => {
      const list = el.querySelector('.collaboration-readers'), clip = list.getBoundingClientRect();
      return [...el.querySelectorAll('.collaboration-member-reader')].map(r => {
        const id = r.dataset.memberId, h = [...el.querySelectorAll('.collaboration-member-status')].find(x => x.dataset.memberId === id);
        const box = r.getBoundingClientRect(), hb = h.getBoundingClientRect(), unit = r.closest('.collaboration-member-unit');
        let lines = 0;
        for (const body of r.querySelectorAll('.message-body, .collaboration-brief blockquote')) {
          const range = document.createRange(); range.selectNodeContents(body);
          for (const rect of range.getClientRects()) if (rect.height >= 12 && rect.top >= Math.max(box.top, clip.top) - 1 && rect.bottom <= Math.min(box.bottom, clip.bottom, innerHeight) + 1 && rect.left >= clip.left - 1 && rect.right <= clip.right + 1) lines++;
        }
        return { id, unit: Boolean(unit && unit.contains(h)), headerTop: hb.top, headerBottom: hb.bottom, readerTop: box.top, readerBottom: box.bottom,
          unitHeight: unit?.getBoundingClientRect().height || 0, factsVisible: ['state', 'child', 'freshness'].every(k => { const n = h.querySelector('.collaboration-member-' + k), compact = h.querySelector('.collaboration-member-child-compact'); if (!n.textContent.trim() || n.getAttribute('aria-hidden') === 'true') return false; const srOnly = getComputedStyle(n).clipPath === 'inset(50%)'; const shown = k === 'child' && compact?.textContent ? compact : n, b = shown.getBoundingClientRect(); if (srOnly && shown === n) return k !== 'state'; return b.top >= hb.top - 1 && b.bottom <= hb.bottom + 1 && b.left >= hb.left - 1 && b.right <= hb.right + 1 && b.top >= clip.top - 1 && b.bottom <= clip.bottom + 1; }), headerVisible: hb.top >= clip.top - 1 && hb.bottom <= clip.bottom + 1, fullTextLines: lines, headerHeight: hb.height, readerHeight: box.height,
          nameNoHorizontalOverflow: h.querySelector('.collaboration-member-name').scrollWidth <= h.querySelector('.collaboration-member-name').clientWidth + 1 };
      });
    });
    measurements.push({ name, window: await page.evaluate(() => [innerWidth, innerHeight]), list: await list.boundingBox(), listHeight: await list.evaluate(el => ({ content: el.scrollHeight, viewport: el.clientHeight })), rows });
    await capture(name);
    return rows;
  }
  const fixtureBefore = await fixture('stats');
  const gridFont = await reader(ids[0]).locator('.message-body').first().evaluate(el => getComputedStyle(el).fontSize);
  await layout('列表').click();
  const failures = [];
  for (const [width, height] of [[1280, 850], [850, 600]]) {
    if (installed) await page.setViewportSize({ width, height });
    else await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [width, height]);
    await delay(160);
    const started = Date.now(), readiness = [];
    await until(async () => {
      const visible = await overview.evaluate(el => {
        const clip = el.querySelector('.collaboration-readers').getBoundingClientRect();
        return [...el.querySelectorAll('.collaboration-member-reader')].map(reader => {
          const box = reader.getBoundingClientRect();
          return [...reader.querySelectorAll('.message-body')].some(body => {
            const range = document.createRange(); range.selectNodeContents(body);
            return [...range.getClientRects()].some(r => r.height >= 12 && r.top >= Math.max(box.top, clip.top) - 1 && r.bottom <= Math.min(box.bottom, clip.bottom, innerHeight) + 1 && r.left >= clip.left - 1 && r.right <= clip.right + 1);
          });
        });
      });
      readiness.push({ elapsed: Date.now() - started, visible }); return visible.length === 4 && visible.every(Boolean);
    }, 'Four real original lines settle after the native resize');
    measurements.push({ name: 'resize-original-lines-ready-' + width, readiness });
    const rows = await geometry('four-' + width);
    assert.deepEqual(await page.evaluate(() => [innerWidth, innerHeight]), [width, height]);
    const heights = rows.map(r => r.unitHeight); assert.ok(Math.max(...heights) - Math.min(...heights) <= 1);
    assert.ok(await list.evaluate(el => el.scrollHeight <= el.clientHeight + 1));
    assert.equal(await reader(ids[0]).locator('.message-body').first().evaluate(el => getComputedStyle(el).fontSize), gridFont);
    if (!rows.every(r => r.unit && r.headerVisible && r.factsVisible && r.fullTextLines > 0 && r.nameNoHorizontalOverflow)) failures.push('four-' + width);
  }
  assert.deepEqual(failures, [], 'All four list members must have their own attached name/state and one fully visible original text line');
  check('Four list members keep attached identities and visible original text at both normal and minimum window sizes');

  await reader(ids[0]).hover(); await page.mouse.wheel(0, -160);
  await until(() => reader(ids[0]).evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight > 80), 'Wheel actually leaves latest before anchor capture');
  const readingKey = Object.keys((await snapshot()).viewState.readingPositions).find(k => k.startsWith('collaboration:') && k.endsWith(':' + ids[0]));
  await until(async () => (await snapshot()).viewState.readingPositions[readingKey]?.follow === false, 'Real old reading position saved');
  const anchor = await readingAnchor(reader(ids[0])); measurements.push({ name: 'anchor-before-layout', anchor, saved: (await snapshot()).viewState.readingPositions[readingKey] });
  await reader(ids[0]).evaluate(el => {
    const body = [...el.querySelectorAll('.message-body')].find(n => n.getBoundingClientRect().bottom > el.getBoundingClientRect().top);
    const range = document.createRange(); range.selectNodeContents(body); getSelection().removeAllRanges(); getSelection().addRange(range);
  });
  const selected = await page.evaluate(() => getSelection().toString());
  await layout('网格').click();
  assert.equal(await overview.locator('.collaboration-statuses').isVisible(), true);
  for (const id of ids) assert.equal(await header(id).evaluate(el => el.parentElement.classList.contains('collaboration-statuses')), true);
  await layout('列表').click();
  assert.equal(await page.evaluate(() => getSelection().toString()), selected);
  await until(async () => { const a = await readingAnchor(reader(ids[0])); return a?.id === anchor.id && Math.abs(a.offset - anchor.offset) < 3; }, 'Layout restores the same original anchor after its frame');
  assert.equal(await page.evaluate(() => globalThis.listOriginalNodes.every(([r, m]) => r.isConnected && r.querySelector('.messages') === m)), true);
  measurements.push({ name: 'before-brief-layout', data: await reader(ids[0]).evaluate(el => ({ width: el.clientWidth, height: el.clientHeight, scroll: el.scrollHeight, articles: [...el.querySelectorAll('article')].map(n => ({ id: n.dataset.messageId, height: n.getBoundingClientRect().height, width: n.getBoundingClientRect().width })) })) });
  measurements.push({ name: 'anchor-before-brief', anchor: await readingAnchor(reader(ids[0])), saved: (await snapshot()).viewState.readingPositions[readingKey] });
  await layout('简化信息').click(); const briefRows = await geometry('four-brief-850');
  assert.ok(briefRows.every(r => r.fullTextLines > 0));
  for (let i = 0; i < ids.length; i++) assert.ok((await overview.locator(`.collaboration-member-reader[data-member-id="${ids[i]}"] blockquote`).innerText()).includes(`Original member ${i} line 23.`));
  for (const id of ids) assert.equal(await header(id).evaluate(el => el.parentElement.querySelector('.collaboration-member-reader')?.dataset.memberId === el.dataset.memberId), true);
  await layout('简化信息').click();
  assert.equal(await page.evaluate(() => getSelection().toString()), selected);
  await delay(200); await geometry('after-brief-diagnostic'); measurements.push({ name: 'after-brief-layout', data: await reader(ids[0]).evaluate(el => ({ width: el.clientWidth, height: el.clientHeight, scroll: el.scrollHeight, articles: [...el.querySelectorAll('article')].map(n => ({ id: n.dataset.messageId, height: n.getBoundingClientRect().height, width: n.getBoundingClientRect().width })) })) }); measurements.push({ name: 'anchor-after-brief', anchor: await readingAnchor(reader(ids[0])), saved: (await snapshot()).viewState.readingPositions[readingKey] });
  await until(async () => { const a = await readingAnchor(reader(ids[0])); return a?.id === anchor.id && Math.abs(a.offset - anchor.offset) < 3; }, 'Brief return restores original position');
  await page.evaluate(() => getSelection().removeAllRanges());
  await page.locator('#room-record').click();
  for (const id of ids) assert.equal(await header(id).evaluate(el => el.parentElement.classList.contains('collaboration-statuses')), true);
  await page.locator('#room-overview').click();
  const passiveAfter = await fixture('stats');
  for (const key of ['inputs', 'sends', 'interruptions']) assert.deepEqual(passiveAfter[key], fixtureBefore[key]);
  check('Grid/list and brief changes retain the original reader nodes, source anchor, selection and passive native state');

  const name = header(ids[0]).locator('.collaboration-member-name'); await name.focus(); await name.press('Enter');
  await page.locator('#room-session #session-view').waitFor();
  for (const id of ids) { assert.equal(await header(id).isVisible(), true); assert.equal(await header(id).evaluate(el => el.parentElement.classList.contains('collaboration-statuses')), true); }
  await layout('← 返回共同工作').click();
  assert.equal(await name.evaluate(el => document.activeElement === el), true);
  for (const id of ids) assert.equal(await header(id).evaluate(el => el.parentElement.dataset.memberId === el.dataset.memberId), true);
  const more = header(ids[3]).locator('.collaboration-member-more'); await more.focus(); await more.press('Enter');
  const copy = page.getByRole('menuitem', { name: '复制完整 NAW ID', exact: true }); await copy.waitFor();
  const hb = await header(ids[3]).boundingBox(), mb = await page.getByRole('menu', { exact: true }).boundingBox();
  measurements.push({ name: 'lower-member-menu', header: hb, menu: mb });
  assert.ok(Math.min(Math.abs(mb.y - hb.y - hb.height), Math.abs(mb.y + mb.height - hb.y)) <= 12, 'Menu touches its own lower member header');
  for (const id of ids.slice(0, 3)) { const b = await header(id).boundingBox(); assert.ok(mb.y >= b.y + b.height || mb.y + mb.height <= b.y || mb.x >= b.x + b.width || mb.x + mb.width <= b.x, 'Menu never covers another member identity'); }
  if (installed) { await copy.press('Escape'); assert.equal((await snapshot()).sessions.find(s => s.id === ids[3]).id, ids[3]); }
  else {
    const copiedBefore = await app.evaluate(() => globalThis.pageCopies.length); await copy.press('Enter');
    await until(async () => await app.evaluate((_, n) => globalThis.pageCopies.length === n + 1, copiedBefore), 'Exactly one member ID copy');
    assert.equal(await app.evaluate(() => globalThis.pageCopies.at(-1)), ids[3]);
  }
  assert.equal(await more.evaluate(el => document.activeElement === el), true);
  const original = (await snapshot()).sessions.find(s => s.id === ids[0]).messages.find(m => m.id === 'list-0-23');
  await copyOriginal(reader(ids[0]), original.id, original.text);
  assert.deepEqual(identity(await snapshot()), originalIdentity);
  check('List name focus/return and member-menu keyboard actions preserve focus, draft, native identity and ownership');

  for (let i = 4; i < 6; i++) {
    const id = await create('List member ' + i); ids.push(id);
    await fixture('history', id, [{ id: 'extra-' + i, type: 'agentMessage', text: 'Original extra member ' + i }]);
    await page.locator('#session-header-more').click(); await page.getByRole('menuitem', { name: '加入协作', exact: true }).click();
  }
  await page.locator('#room-nav').click();
  await list.evaluate(el => { el.scrollTop = 0; }); await reader(ids[0]).hover();
  await reader(ids[0]).evaluate(el => { el.scrollTop = el.scrollHeight; }); await page.mouse.wheel(0, 900); await delay(180);
  const wheelTop = await list.evaluate(el => el.scrollTop); assert.ok(wheelTop > 20, 'Wheel at member boundary reaches the whole list');
  await list.evaluate(el => { el.scrollTop = 0; });
  await list.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  const lb = await list.boundingBox(), scrollData = await list.evaluate(el => ({ client: el.clientHeight, scroll: el.scrollHeight, gutter: el.offsetWidth - el.clientWidth, before: el.scrollTop }));
  const thumb = scrollData.client * scrollData.client / scrollData.scroll, barX = lb.x + lb.width - (scrollData.gutter ? scrollData.gutter / 2 : 3);
  await capture('six-before-scrollbar');
  await page.mouse.move(barX, lb.y + thumb / 2); await page.mouse.down();
  await page.mouse.move(barX, lb.y + lb.height - 4, { steps: 8 }); await page.mouse.up();
  await delay(100); measurements.push({ name: 'scrollbar-drag', box: lb, barX, thumb, ...scrollData, after: await list.evaluate(el => el.scrollTop) });
  assert.ok(await list.evaluate(el => el.scrollTop >= el.scrollHeight - el.clientHeight - 2), 'Actual scrollbar thumb drag reaches last member');
  assert.equal(await header(ids[5]).evaluate(el => { const r = el.getBoundingClientRect(), c = el.closest('.collaboration-readers').getBoundingClientRect(); return r.top >= c.top - 1 && r.bottom <= c.bottom + 1; }), true);
  await list.evaluate(el => { el.scrollTop = 0; }); await header(ids[0]).locator('.collaboration-member-name').focus();
  let tabPresses = 0, nextActions = 0;
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('Tab'); await page.keyboard.press('Tab'); tabPresses += 2;
    const next = header(ids[i]).locator('.collaboration-member-next');
    assert.equal(await next.evaluate(el => document.activeElement === el), true, 'Tab reaches the visible-on-focus next-member route');
    assert.equal(await next.evaluate(el => { const b = el.getBoundingClientRect(), h = el.closest('.collaboration-member-status').getBoundingClientRect(); return getComputedStyle(el).clipPath === 'none' && b.width > 20 && b.height > 16 && b.top >= h.top && b.bottom <= h.bottom && b.left >= h.left && b.right <= h.right; }), true, 'Focused next-member control is visibly inside its own header');
    if (!i) await capture('next-member-keyboard-focus');
    await next.press('Enter'); nextActions++;
    assert.equal(await header(ids[i + 1]).locator('.collaboration-member-name').evaluate(el => document.activeElement === el), true);
  }
  const six = await geometry('six-850'); assert.ok(six.every(r => r.unitHeight >= 72));
  assert.ok(await list.evaluate(el => el.scrollHeight > el.clientHeight));
  assert.equal(await header(ids[5]).evaluate(el => { const r = el.getBoundingClientRect(), c = el.closest('.collaboration-readers').getBoundingClientRect(); return r.top >= c.top - 1 && r.bottom <= c.bottom + 1; }), true);
  measurements.push({ name: 'tab-reach', tabPresses, nextActions, previousRed: '80 ordinary Tab presses did not reach member6; no limit increase' });
  const stickyBy = await header(ids[0]).evaluate(el => { const u = el.parentElement; return Math.min(u.clientHeight / 2, u.clientHeight - el.offsetHeight - 2); });
  await list.evaluate((el, n) => { el.scrollTop = n; }, stickyBy);
  assert.equal(await header(ids[0]).evaluate(el => { const r = el.getBoundingClientRect(), c = el.closest('.collaboration-readers').getBoundingClientRect(); return Math.abs(r.top - c.top) < 2 && r.bottom <= c.bottom; }), true);
  if (evidence) fs.writeFileSync(path.join(evidence, 'list-accessibility.txt'), await overview.ariaSnapshot());
  check('Six-member list reaches the last named member by wheel, scrollbar position and keyboard without dispatching native input');
  await list.evaluate(el => { el.scrollTop = el.scrollHeight; });
  const removedBefore = (await snapshot()).sessions.find(s => s.id === ids[5]);
  await header(ids[5]).locator('.collaboration-member-more').click(); await page.getByRole('menuitem', { name: '脱出协作', exact: true }).click();
  await until(async () => !(await snapshot()).sessions.find(s => s.id === ids[5]).roomId, 'Member removed');
  const removedAfter = (await snapshot()).sessions.find(s => s.id === ids[5]);
  assert.equal(removedAfter.nativeId, removedBefore.nativeId); assert.equal(removedAfter.owner, removedBefore.owner);
  measurements.push({ name: 'detach-existing-navigation', selectedAfter: (await snapshot()).viewState.selected, scope: 'T92 navigation remains separate' });
  await page.locator('#room-nav').click();
  assert.equal(await overview.locator(`[data-member-id="${ids[5]}"]`).count(), 0);
  assert.deepEqual(await overview.locator('.collaboration-member-unit').evaluateAll(nodes => nodes.map(n => n.dataset.memberId)), ids.slice(0, 5));
  check('Removing one list member disposes its complete unit and preserves the remaining order and removed native session');
  const packet = await fixture('stats'); assert.equal(packet.inputs.length, 0); assert.equal(packet.sends.length, 0); assert.equal(packet.interruptions.length, 0);
  assert.equal((await snapshot()).diagnostics.dispatches, 0); assert.deepEqual(errors, []);
}
run().catch(async error => {
  console.error(error.stack); process.exitCode = 1; failure = error.stack;
  if (evidence && page && !page.isClosed()) {
    const details = await page.evaluate(async () => ({ reading: (await workspace.initial()).viewState.readingPositions,
      toast: document.getElementById('toast')?.innerText, target: document.querySelector('[data-search-target]')?.dataset.messageId }));
    fs.writeFileSync(path.join(evidence, 'failure-details.json'), JSON.stringify({ error: error.stack, ...details }, null, 2));
  }
}).finally(async () => {
  try {
    if (evidence) fs.writeFileSync(path.join(evidence, 'collaboration-list-result.json'), JSON.stringify({ flowPassed: !failure, failure, checks, errors, measurements, profile, token,
      installedLimits: installed ? 'Renderer viewport sizing; source native-window/clipboard receipts reused. Installed copy focus/source/menu dismissal only, no OS clipboard action.' : null }, null, 2));
    await scratch.release(); const owner = JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))); assert.equal(owner.token, token);
    fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot);
    if (evidence) fs.writeFileSync(path.join(evidence, 'released.json'), JSON.stringify({ profile, token, profileExists: fs.existsSync(profile), time: new Date().toISOString() }, null, 2));
    console.log('Owned fixture cleaned; GUI slot released.');
  } catch (e) { console.error('Cleanup not confirmed; owned lock retained:', e.stack); process.exitCode = 1; }
});
