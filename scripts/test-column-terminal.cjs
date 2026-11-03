// T-135: each grid column's terminal height can be dragged or set with the keys, one column
// can give its height to all, and heights survive a restart. Actual hidden Electron/DSH and
// service; only the provider is synthetic (0 model).
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
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Claude 3', task: 'T-135 column terminal height', token, pid: process.pid, time: new Date().toISOString() }));
const profile = scratch.directory(path.join(os.tmpdir(), 'naw-column-terminal-')), workspacePath = path.join(profile, 'workspace');
fs.mkdirSync(workspacePath, { recursive: true, mode: 0o700 });
const child = scratch.childProcess.fork(path.join(code, 'app/daemon.cjs'), [profile], {
  execArgv: ['--require', path.join(root, 'scripts/fixtures/column-input.cjs')],
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
async function launch() {
  app = await _electron.launch({ executablePath: require('electron'), args: [code], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message)); await page.locator('#new-session').waitFor();
  await (await app.browserWindow(page)).evaluate(w => w.setContentSize(1240, 900));
}
async function create(name) {
  const before = new Set((await snapshot()).sessions.map(s => s.id));
  await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="codex"]').check();
  await page.locator('#session-name').fill(name); await createIn(page, 'chat');
  return (await snapshot()).sessions.find(s => s.name === name && !before.has(s.id)).id;
}
const reader = id => page.locator(`.collaboration-member-reader[data-member-id="${id}"]`);
const host = id => reader(id).locator('.column-native-host'), sash = id => reader(id).locator('.column-terminal-sash');
const height = async id => Math.round((await host(id).boundingBox()).height);
async function showTerminal(id) {
  await reader(id).locator('.session-native-button').click();
  await host(id).waitFor({ state: 'visible' }); await sash(id).waitFor({ state: 'visible' });
}
async function dragBy(id, dy) {
  const box = await sash(id).boundingBox(), x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  for (let i = 1; i <= 5; i++) await page.mouse.move(x, y + dy * i / 5);
  await page.mouse.up(); await delay(120);
}
// How much of the box the terminal's own rows fill, and whether its cursor is inside the box.
async function grid(id) {
  return host(id).evaluate(el => {
    const surface = el.querySelector('.terminal-surface'), screen = el.querySelector('.xterm-screen'), cursor = el.querySelector('.xterm-cursor');
    const r = surface.getBoundingClientRect(), c = cursor?.getBoundingClientRect();
    return { box: Math.round(el.getBoundingClientRect().height), rows: Math.round(screen.getBoundingClientRect().height),
      cursorInside: Boolean(c && c.top >= r.top - 1 && c.bottom <= r.bottom + 1 && c.left >= r.left - 1 && c.right <= r.right + 1) };
  });
}
const resizes = async () => (await fixture('stats')).stats.resizes;
async function layout(id) {
  return reader(id).evaluate(el => {
    const box = el.getBoundingClientRect(), messages = el.querySelector('.collaboration-messages'), form = el.querySelector('.collaboration-member-input form, .collaboration-member-input .session-composer');
    return { conversation: Math.round(messages.getBoundingClientRect().height), formBottom: Math.round(form.getBoundingClientRect().bottom), readerBottom: Math.round(box.bottom) };
  });
}

async function run() {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Owned fixture ready'); await launch();
  const ids = [];
  for (let i = 0; i < 3; i++) { const id = await create('Terminal column ' + i); ids.push(id); await page.evaluate(id => workspace.join(id, true), id); }
  await page.locator('#room-nav').click(); await page.getByRole('button', { name: '网格', exact: true }).click();
  const [a, b, c] = ids;
  for (const id of [a, b]) await showTerminal(id);
  assert.equal(await height(a), 112); assert.equal(await height(b), 112);
  assert.equal(await sash(a).getAttribute('role'), 'separator'); assert.match(await sash(a).getAttribute('aria-label'), /调整 .* 的终端高度/);
  await capture('01-default');
  check('Each terminal column starts at 112px and has a labelled separator above its terminal');

  const before = await grid(a), resizedBefore = await resizes();
  await dragBy(a, -80);
  assert.equal(await height(a), 192, 'Dragging up 80px makes only that terminal taller'); assert.equal(await height(b), 112, 'The other column is unchanged');
  await until(async () => await resizes() === resizedBefore + 1, 'One release resizes the native terminal once');
  await until(async () => { const g = await grid(a); return g.rows >= g.box - 24 && g.rows > before.rows + 40; }, 'The terminal rows fill the taller box');
  measurements.push({ label: 'drag', before, after: await grid(a), resizes: [resizedBefore, await resizes()] });
  check('A drag release resizes the native terminal once, and its rows fill the taller box');
  await sash(a).focus(); await page.keyboard.press('ArrowDown');
  assert.equal(await height(a), 176, 'ArrowDown lowers it by 16px'); assert.equal(await sash(a).getAttribute('aria-valuenow'), '176');
  check('Dragging or ArrowDown changes only that column; the separator reports the value');

  await dragBy(a, 1000); assert.equal(await height(a), 64, 'The terminal stops at 64px');
  await until(async () => (await grid(a)).cursorInside, 'At 64px the cursor stays inside the box');
  await dragBy(a, -2000); const tallest = await height(a), room = await layout(a);
  measurements.push({ label: 'tallest', tallest, room });
  assert.ok(room.conversation >= 79, `The conversation keeps at least 80px (${room.conversation})`); assert.ok(room.formBottom <= room.readerBottom + 1, 'The input stays whole in the column');
  assert.equal(await sash(a).getAttribute('aria-valuemax'), String(tallest));
  await capture('02-limits');
  const window = await app.browserWindow(page), resizedTall = await resizes();
  await until(async () => await resizes() === resizedTall, 'settled'); await window.evaluate(w => w.setContentSize(1240, 640));
  await until(async () => await height(a) < tallest, 'A smaller window lowers the tall terminal');
  const small = await layout(a), lowered = await height(a); measurements.push({ label: 'smaller window', lowered, small, cursorInside: (await grid(a)).cursorInside });
  assert.ok(small.formBottom <= small.readerBottom + 1, 'The input stays whole after the window shrinks'); assert.ok(lowered >= 112);
  assert.ok((await grid(a)).cursorInside, 'The cursor stays in view'); assert.equal(await resizes(), resizedTall, 'A window change does not resize the native terminal');
  await window.evaluate(w => w.setContentSize(1240, 900)); await until(async () => await height(a) === tallest, 'The full window brings the chosen height back');
  check(`A smaller window lowers the tall terminal to ${lowered}px (not below 112) with the input whole and no native resize; the full window restores it`);
  check(`Limits: at least 64px; at most ${tallest}px, leaving the conversation ${room.conversation}px and the input whole`);

  await sash(a).focus(); await page.keyboard.press('End'); await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp');
  const chosen = await height(a); assert.equal(chosen, 128, 'End then four ArrowUp: 64 + 4 × 16');
  await page.locator(`.collaboration-member-status[data-member-id="${a}"] .collaboration-member-more`).click();
  await page.getByRole('menuitem', { name: '所有列都用这个终端高度', exact: true }).click();
  await until(async () => await height(b) === chosen, 'The other terminal column took the same height');
  await until(async () => { const g = await grid(b); return g.rows >= g.box - 24; }, 'The other terminal was fitted to its new height');
  await capture('03-all-same');
  check('「所有列都用这个终端高度」 gives every terminal column the chosen height');

  await until(async () => { const v = (await snapshot()).viewState.columnTerminalHeights || {}; return v[a] === chosen && v[b] === chosen && v[c] === chosen; }, 'Heights saved with the view, for every member');
  await app.close(); app = null; await launch();
  await page.locator('#room-nav').click(); await page.getByRole('button', { name: '网格', exact: true }).click();
  for (const id of [a, b]) if (!(await host(id).isVisible())) await showTerminal(id);
  await until(async () => await height(a) === chosen && await height(b) === chosen, 'Heights kept after a restart');
  check('Heights are kept with the window view across a restart');

  assert.deepEqual(errors, []);
  const stats = await fixture('stats'); measurements.push({ stats: stats.stats });
  assert.equal(stats.stats.sends, 0); check('No page errors; no message was sent');
}

run().catch(e => { failure = e.stack; process.exitCode = 1; console.error(e.stack); }).finally(async () => {
  try {
    if (evidence) fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ flowPassed: !failure, failure, checks, errors, measurements, profile, token, productModels: 0 }, null, 2));
    await scratch.release(); const owner = JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))); assert.equal(owner.token, token); fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot);
    console.log('Owned fixture cleaned; exact GUI slot released.');
  } catch (e) { console.error('Cleanup unconfirmed; owned lock retained:', e.stack); process.exitCode = 1; }
});
