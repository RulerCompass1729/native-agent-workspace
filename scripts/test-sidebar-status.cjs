// T-142 / T-144 / T-145: the sidebar shows each session's status on its avatar's corner (shape and colour,
// only working and needs-you move, nothing moves with reduced motion), red only for what needs the person,
// a space label with the space's whole name that the grouped view does not repeat, the grouped view's
// headings carrying each space's ⋯ instead of a second space list, no empty 独立会话 group, and one row
// layout. Actual hidden Electron/DSH and service; only the native side is synthetic (0 model).
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const scratch = require(path.join(root, 'scripts/fixtures/test-scratch.cjs')), { createIn } = require(path.join(root, 'scripts/fixtures/create-view.cjs'));
const { _electron } = scratch.playwright(require('playwright'));
const evidence = process.env.NAW_EVIDENCE_DIR;
if (evidence) fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID();
try { fs.mkdirSync(slot); } catch (e) { if (e.code !== 'EEXIST') throw e; console.error('GUI slot occupied; nothing started.'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Claude 3', task: 'T-142 sidebar status', token, pid: process.pid, time: new Date().toISOString() }));
const profile = scratch.directory(path.join(os.tmpdir(), 'naw-sidebar-status-')), workspacePath = path.join(profile, 'workspace');
fs.mkdirSync(workspacePath, { recursive: true, mode: 0o700 });
const child = scratch.childProcess.fork(path.join(code, 'app/daemon.cjs'), [profile], {
  execArgv: ['--require', path.join(root, 'scripts/fixtures/collaboration-overview.cjs')],
  env: { ...process.env, NAW_TEST_APP_ROOT: code, NAW_WORKSPACE: workspacePath, NAW_APP_VERSION: require(path.join(code, 'package.json')).version },
  stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
});
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
async function capture(name) { if (evidence) await page.screenshot({ path: path.join(evidence, name + '.png') }); }
async function create(name) {
  const before = new Set((await snapshot()).sessions.map(s => s.id));
  await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="codex"]').check();
  await page.locator('#session-name').fill(name); await createIn(page, 'chat');
  return (await snapshot()).sessions.find(s => s.name === name && !before.has(s.id)).id;
}
const row = id => page.locator(`#session-list .session-row[data-session-row="${id}"]`).first();
// What a person sees of one row: the mark on the avatar, its place, motion and classes, and the row's lines.
const look = id => row(id).evaluate(el => {
  const avatar = el.querySelector('.agent-icon'), dot = avatar?.querySelector(':scope > .state-dot'), a = avatar.getBoundingClientRect(), d = dot?.getBoundingClientRect();
  const status = el.querySelector('.session-link .label small'), time = el.querySelector('.session-time'), badges = el.querySelector('.session-space-badges');
  return { inAvatar: Boolean(dot), classes: dot ? [...dot.classList] : [], width: Math.round(d?.width || 0), height: Math.round(d?.height || 0), radius: getComputedStyle(dot).borderRadius, image: getComputedStyle(dot).backgroundImage, shadow: getComputedStyle(dot).boxShadow, border: getComputedStyle(dot).borderStyle, dx: Math.round(d.left + d.width / 2 - a.right), dy: Math.round(d.top + d.height / 2 - a.top),
    animation: getComputedStyle(dot).animationName, status: status.textContent, statusAboveTime: status.getBoundingClientRect().bottom <= time.getBoundingClientRect().top + 2,
    sameLine: Math.min(status.getBoundingClientRect().bottom, time.getBoundingClientRect().bottom) - Math.max(status.getBoundingClientRect().top, time.getBoundingClientRect().top) > 1,
    badges: badges.hidden || getComputedStyle(badges).display === 'none' ? null : [...badges.children].map(b => ({ text: b.textContent, title: b.title })) };
});

async function run() {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Owned fixture ready');
  app = await _electron.launch({ executablePath: require('electron'), args: [code], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message)); await page.locator('#new-session').waitFor();
  await (await app.browserWindow(page)).evaluate(w => w.setContentSize(1240, 900));
  const ready = await create('Ready one'), working = await create('Working one'), waiting = await create('Waiting one'), unknown = await create('Unknown children'), solo = await create('Solo one'), chat = await create('Chat only');
  for (const id of [ready, working, waiting, unknown]) await page.evaluate(id => workspace.join(id, true), id);
  await page.locator('#new-space').click(); await page.locator('#space-create-name').fill('一个名字很长的协作空间'); await page.locator('#confirm-space-create').click();
  await until(async () => (await snapshot()).rooms?.some(r => r.name === '一个名字很长的协作空间'), 'Long space created');
  const long = (await snapshot()).rooms.find(r => r.name === '一个名字很长的协作空间').id;
  await page.evaluate(({ id, space }) => workspace.spaceAction(space, 'join', [id, true]), { id: working, space: long });
  await page.locator('#new-space').click(); await page.locator('#space-create-name').fill('Claude 聊天室'); await page.locator('#confirm-space-create').click();
  await until(async () => (await snapshot()).rooms?.some(r => r.name === 'Claude 聊天室'), 'Chat space created');
  const chatRoom = (await snapshot()).rooms.find(r => r.name === 'Claude 聊天室').id;
  await page.evaluate(({ id, space }) => workspace.spaceAction(space, 'join', [id, true]), { id: chat, space: chatRoom });
  await fixture('state', working, 'working');
  await fixture('approval', waiting, { requestId: 41, method: 'item/commandExecution/requestApproval', params: { command: 'echo synthetic', cwd: '/synthetic', reason: '只核对侧栏标记' } });
  await fixture('fleet', unknown, { event: 'thread/started', id: 'fixture-child-unknown', name: 'Unknown native child', stale: false });
  if (await page.locator('#sessions-flat').getAttribute('aria-pressed') !== 'true') await page.locator('#sessions-flat').click();
  await until(async () => (await look(working)).classes.includes('working') && (await look(waiting)).classes.includes('approval') && (await look(unknown)).classes.includes('bg-unknown'), 'Synthetic states shown');
  const rows = { ready: await look(ready), working: await look(working), waiting: await look(waiting), unknown: await look(unknown), solo: await look(solo) };
  measurements.push({ flat: rows });
  for (const [name, r] of Object.entries(rows)) {
    assert.ok(r.inAvatar, `${name}: the mark is on the avatar`); assert.equal(r.width, 10, `${name}: 10px`); assert.equal(r.height, 10); assert.equal(r.radius, '50%', `${name}: round`);
    assert.ok(Math.abs(r.dx) <= 4 && Math.abs(r.dy) <= 4, `${name}: on the avatar's top-right corner (${r.dx}, ${r.dy})`);
    if (r.badges?.length) assert.ok(r.statusAboveTime, `${name}: status on its own line above the space label and time`);
    else assert.ok(r.sameLine, `${name}: with no space label the time shares the status line`);
  }
  assert.ok(rows.ready.classes.includes('idle') && rows.ready.animation === 'none');
  assert.equal(rows.working.animation, 'naw-status-breathe'); assert.equal(rows.waiting.animation, 'naw-status-call');
  assert.ok(!rows.unknown.classes.includes('approval') && rows.unknown.animation === 'none', 'Unknown sub-tasks are not red and do not move');
  assert.match(rows.unknown.status, /1 个子任务状态未知/);
  await capture('01-flat');
  check('Each mark sits 10px on its avatar\'s corner; only working breathes and waiting calls; unknown sub-tasks are a still grey ring with 「1 个子任务状态未知」');

  const labels = rows.working.badges; assert.ok(labels?.length >= 1);
  for (const b of labels.filter(b => !b.text.startsWith('+'))) { assert.ok(!b.text.endsWith('…'), `whole name, not cut at 6 characters: ${b.text}`); assert.match(b.title, /^空间：/); }
  assert.ok(labels.some(b => b.text === '一个名字很长的协作空间' || b.text === '共同工作'), JSON.stringify(labels));
  assert.equal(rows.solo.badges.length, 0, 'An independent session has no space label');
  check('Space labels carry the space\'s whole name (shortened only by width) and say 空间 on hover');

  const chatLabel = await row(chat).locator('.space-badge').first().evaluate(el => ({ text: el.textContent, cut: el.scrollWidth > el.clientWidth + 1 }));
  measurements.push({ chatLabel }); assert.deepEqual(chatLabel, { text: 'Claude 聊天室', cut: false }, '「Claude 聊天室」 is shown whole');
  check('A row in 「Claude 聊天室」 only shows that name whole');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  const still = { ready: await look(ready), working: await look(working), waiting: await look(waiting), unknown: await look(unknown) };
  assert.equal(still.working.animation, 'none'); assert.equal(still.waiting.animation, 'none');
  assert.equal(still.ready.image, 'none'); assert.match(still.working.image, /radial-gradient/, 'Working is a disc with a dot inside, not only another colour');
  assert.match(still.waiting.shadow, /178, 99, 69/, 'Waiting has an outer ring'); assert.equal(still.unknown.border, 'dashed', 'Unknown sub-tasks are a dashed ring');
  measurements.push({ reducedMotion: still });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  check('With reduced motion nothing moves, and ready, working, waiting and unknown still differ in shape, not only colour');

  await row(waiting).locator('.session-link').click();
  await until(async () => await row(waiting).evaluate(el => el.classList.contains('active')), 'Waiting row selected');
  const selectedWaiting = await look(waiting); measurements.push({ selectedWaiting });
  assert.match(selectedWaiting.shadow, /178, 99, 69/, 'The selected row keeps the outer ring');
  check('The selected row keeps its mark\'s shape');

  const flatList = Math.round(await page.locator('#sessions-group').evaluate(el => el.getBoundingClientRect().height));
  await page.locator('#sessions-grouped').click();
  await until(async () => await page.locator('#session-list [data-session-group]').count() >= 2, 'Grouped');
  for (const id of [ready, working, waiting, unknown]) assert.equal((await look(id)).badges, null, 'The grouped view does not repeat the space as a label');
  assert.equal(await page.locator('#workspace-group .room-row').evaluateAll(rows => rows.filter(r => r.getBoundingClientRect().height > 0).length), 0, 'No second space list');
  assert.ok(await page.locator('#panorama-nav').isVisible() && await page.locator('#new-space').isVisible(), '全部空间 and 新建空间 stay');
  // The section's content: from its top to the bottom of 新建空间 (the last thing shown), plus the body's padding.
  const fit = await page.evaluate(() => { const g = document.querySelector('#workspace-group'), body = g.querySelector('.sidebar-group-body'), last = document.querySelector('#new-space');
    return { section: Math.round(g.getBoundingClientRect().height), content: Math.round(last.getBoundingClientRect().bottom - g.getBoundingClientRect().top + parseFloat(getComputedStyle(body).paddingBottom || 0)), list: Math.round(document.querySelector('#sessions-group').getBoundingClientRect().height) }; });
  measurements.push({ groupedFit: fit }); assert.ok(Math.abs(fit.section - fit.content) <= 8, `协作空间 takes only its content's height (${JSON.stringify(fit)})`);
  assert.ok(fit.list > flatList + 40, `The session list gets the freed height (${flatList} → ${fit.list})`);
  assert.equal(await page.locator('#session-list [data-session-group="independent"]').count(), 1, 'Solo one is independent');
  const longGroup = page.locator(`#session-list [data-session-group="${long}"]`);
  await longGroup.locator('.space-group-more').click();
  await page.getByRole('menuitem', { name: '重命名…', exact: true }).waitFor(); await capture('02-grouped-space-menu');
  await page.getByRole('menuitem', { name: '重命名…', exact: true }).click();
  const editor = page.locator('#rename-editor'); await editor.waitFor({ state: 'visible' });
  assert.ok(await editor.evaluate(el => el.contains(document.activeElement)), 'The rename editor is visible and focused');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A'); await page.keyboard.type('长名字空间改名'); await page.keyboard.press('Enter');
  await until(async () => (await longGroup.locator('.session-space-heading').innerText()).startsWith('长名字空间改名'), 'Heading shows the new name');
  await longGroup.locator('.session-space-heading').click();
  await until(async () => await longGroup.locator('.session-space-heading').getAttribute('aria-current') === 'page', 'The open space is marked on its heading');
  const headingLook = locator => locator.evaluate(el => { const s = getComputedStyle(el); return { background: s.backgroundColor, shadow: s.boxShadow }; });
  const openLook = await headingLook(longGroup.locator('.session-space-heading')), otherLook = await headingLook(page.locator('#session-list [data-session-group="shared"] .session-space-heading'));
  measurements.push({ openLook, otherLook }); assert.notDeepEqual(openLook, otherLook, 'The open space\'s heading looks different, not only to a screen reader');
  // A failed rename in the grouped view: its message is shown whole, inside the 协作空间 section.
  await longGroup.locator('.space-group-more').click(); await page.getByRole('menuitem', { name: '重命名…', exact: true }).click(); await editor.waitFor({ state: 'visible' });
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A'); await page.keyboard.press('Backspace'); await page.keyboard.press('Enter');
  const error = page.locator('#rename-error'); await error.waitFor({ state: 'visible' });
  await until(async () => await page.evaluate(() => { const e = document.querySelector('#rename-error').getBoundingClientRect(), g = document.querySelector('#workspace-group').getBoundingClientRect(); return e.height > 0 && e.top >= g.top - 1 && e.bottom <= g.bottom + 1; }), 'The rename error is fully inside the section');
  measurements.push({ renameError: await error.innerText() });
  await page.keyboard.press('Escape'); await editor.waitFor({ state: 'hidden' });
  await page.evaluate(id => workspace.join(id, true), solo);
  await until(async () => await page.locator('#session-list [data-session-group="independent"]').count() === 0, 'The empty 独立会话 group goes');
  await capture('03-grouped');
  await page.locator('#sessions-flat').click();
  await until(async () => await page.locator('#workspace-group .room-row').evaluateAll(rows => rows.filter(r => r.getBoundingClientRect().height > 0).length) >= 2, 'The flat view lists the spaces again');
  check('Grouped: no space labels; no second space list (全部空间 / 新建空间 stay, the section only as tall as they are, the session list taller); a heading\'s ⋯ opens the space\'s menu and renaming from it works; the open space is marked on its heading; no empty 独立会话; flat lists spaces again');

  assert.deepEqual(errors, []); const stats = (await fixture('stats')).stats; measurements.push({ stats });
  assert.equal(stats.sends, 0); check('No page errors; nothing was sent; 0 model');
}

run().catch(e => { failure = e.stack; process.exitCode = 1; console.error(e.stack); }).finally(async () => {
  try {
    if (page && !page.isClosed() && failure) await capture('failure').catch(() => {});
    if (evidence) fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ flowPassed: !failure, failure, checks, errors, measurements, profile, token, productModels: 0 }, null, 2));
    await scratch.release(); const owner = JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))); assert.equal(owner.token, token); fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot);
    console.log('Owned fixture cleaned; exact GUI slot released.');
  } catch (e) { console.error('Cleanup unconfirmed; owned lock retained:', e.stack); process.exitCode = 1; }
});
