// T-134: a working member's grid column keeps following its latest output after
// 跳到最新 and after the wheel reaches the end, while rows above change size.
// Actual hidden Electron/DSH and service; only the provider is synthetic (0 model).
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
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Claude 3', task: 'T-134 grid follow', token, pid: process.pid, time: new Date().toISOString() }));
const profile = scratch.directory(path.join(os.tmpdir(), 'naw-grid-follow-')), workspacePath = path.join(profile, 'workspace');
fs.mkdirSync(workspacePath, { recursive: true, mode: 0o700 });
const child = scratch.childProcess.fork(path.join(code, 'app/daemon.cjs'), [profile], {
  execArgv: ['--require', path.join(root, 'scripts/fixtures/collaboration-overview.cjs')],
  env: { ...process.env, NAW_TEST_APP_ROOT: code, NAW_WORKSPACE: workspacePath, NAW_APP_VERSION: require(path.join(code, 'package.json')).version },
  stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
});
const checks = [], errors = [], measurements = [];
let app, page, sequence = 0, failure = null, stream = null;
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
async function create(name, provider) {
  const before = new Set((await snapshot()).sessions.map(s => s.id));
  await page.locator('#new-session').click(); await page.locator(`input[name="provider"][value="${provider}"]`).check();
  await page.locator('#session-name').fill(name); await createIn(page, 'chat');
  return (await snapshot()).sessions.find(s => s.name === name && !before.has(s.id)).id;
}
// Where the reader stands, and whether its last row is shown inside it, not under its input.
// Measured after two frames, so a just-arrived update has had its follow frame.
function geometry(locator) {
  return locator.evaluate(async el => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const box = el.getBoundingClientRect(), last = [...el.querySelectorAll(':scope > [data-message-id]')].at(-1), lastBox = last?.getBoundingClientRect();
    const input = el.closest('.collaboration-member-reader')?.querySelector('.collaboration-member-input:not([hidden])');
    const probe = lastBox && document.elementFromPoint(lastBox.left + 20, Math.min(lastBox.bottom, box.bottom) - 4);
    return { fromBottom: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight), scrollHeight: el.scrollHeight, lastId: last?.dataset.messageId,
      lastShown: Boolean(lastBox && lastBox.top < box.bottom && probe && el.contains(probe)), inputTop: input && Math.round(input.getBoundingClientRect().top), readerBottom: Math.round(box.bottom),
      jumpShown: !el.querySelector('.jump-bar').hidden };
  });
}
// A working member writes a reply that grows; every tenth update adds a tool row,
// which folds the earlier rows of the turn and shortens the content above the end.
function startStream(id) {
  let n = 0;
  stream = setInterval(() => {
    n++; const k = Math.floor(n / 10);
    if (n % 10 === 0) fixture('nativeBlock', id, { id: 'tool-' + k, kind: 'tool', turnId: 'live-turn', title: 'Bash', status: 'complete', text: 'output ' + k }).catch(() => {});
    fixture('nativeBlock', id, { id: 'reply-' + k, kind: 'response', turnId: 'live-turn', status: 'running', text: Array.from({ length: n % 10 + 1 }, (_, i) => `- Streaming bullet ${k}.${i} with **bold** words that wrap in a narrow column`).join('\n') }).catch(() => {});
  }, 100);
}
async function leaveEnd(reader) { for (let i = 0; i < 10; i++) { await reader.hover(); await page.mouse.wheel(0, -600); await delay(40); } }
// The old fault left the reader further from the end with every update and never
// came back. A hidden test window can delay one animation frame, so each check
// allows up to 600ms to be back at the latest.
async function followsFor(reader, label) {
  const started = Date.now(), samples = [];
  for (const at of [300, 800, 1500, 3000]) {
    await delay(Math.max(0, started + at - Date.now()));
    let sample;
    for (let waited = 0; waited <= 600; waited += 50) {
      sample = await geometry(reader); if (sample.fromBottom < 80 && !sample.jumpShown && sample.lastShown) break; await delay(50);
    }
    samples.push({ at, waited: Date.now() - started - at, ...sample });
  }
  measurements.push({ label, samples });
  // Pages keep fifty rows while following, so the height alone can stay flat as rows arrive.
  assert.ok(samples.some(x => x.lastId !== samples[0].lastId || x.scrollHeight !== samples[0].scrollHeight), `${label}: the stream kept changing the content`);
  for (const s of samples) {
    assert.ok(s.fromBottom < 80, `${label}: back at the latest within 600ms of ${s.at}ms (${s.fromBottom}px from the end)`);
    assert.equal(s.jumpShown, false, `${label}: 跳到最新 hidden at ${s.at}ms`); assert.ok(s.lastShown, `${label}: last row shown inside the reader at ${s.at}ms`);
    if (s.inputTop !== null && s.inputTop !== undefined) assert.ok(s.inputTop >= s.readerBottom, `${label}: the column input starts below the reader, not over it`);
  }
}

async function run() {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Owned fixture ready');
  app = await _electron.launch({ executablePath: require('electron'), args: [code], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message)); await page.locator('#new-session').waitFor();
  const ids = [];
  for (const [name, provider] of [['Busy Claude', 'claude'], ['Other Codex', 'codex']]) {
    const id = await create(name, provider); ids.push(id);
    await fixture('history', id, Array.from({ length: 120 }, (_, j) => ({ id: `history-${ids.length}-${j}`, type: 'agentMessage', turnId: 'turn-' + Math.floor(j / 6), text: `${name} paragraph ${j}\n\n` + 'Long line of text that wraps in a narrow column. '.repeat(3) })));
    await page.locator('#session-header-more').click(); await page.getByRole('menuitem', { name: '加入此空间', exact: true }).click();
    await page.locator('#toast-text', { hasText: '已加入' }).waitFor(); await page.locator('#toast-close').click();
  }
  const [busy, other] = ids;
  await (await app.browserWindow(page)).evaluate(w => w.setContentSize(1240, 900));
  await page.locator('#room-nav').click(); await page.getByRole('button', { name: '网格', exact: true }).click();
  const column = id => page.locator(`.collaboration-member-reader[data-member-id="${id}"] .collaboration-messages`);
  await until(async () => (await geometry(column(busy))).lastId === `history-1-119`, 'Grid column shows its latest record');

  await fixture('state', busy, 'working'); startStream(busy);
  await leaveEnd(column(busy)); await delay(300);
  const away = await geometry(column(busy)); assert.ok(away.fromBottom > 1000 && away.jumpShown, 'Wheel up leaves the latest and shows 跳到最新');
  await capture('01-grid-before-jump');
  await column(busy).locator('.jump-latest').click();
  await followsFor(column(busy), 'grid after 跳到最新'); await capture('02-grid-after-jump');
  check('Grid column: 跳到最新 stays at the latest for 3 seconds of streaming while earlier rows fold');

  await leaveEnd(column(busy)); await delay(300);
  assert.ok((await geometry(column(busy))).fromBottom > 1000, 'Wheel up while streaming still leaves the latest');
  let steps = 0;
  while (steps < 600 && (await geometry(column(busy))).fromBottom >= 80) { await column(busy).hover(); for (let i = 0; i < 10; i++) { await page.mouse.wheel(0, 120); await delay(16); } steps += 10; }
  assert.ok(steps < 600, 'Wheel reaches the end of a streaming column');
  await followsFor(column(busy), 'grid after the wheel reached the end'); await capture('03-grid-wheel-end');
  // A trackpad keeps sending wheel-downs at the end; they scroll nothing and must not end following.
  for (let i = 0; i < 20; i++) { await page.mouse.wheel(0, 120); await delay(16); }
  await followsFor(column(busy), 'grid after extra wheel-downs at the end');
  check(`Grid column: wheel up still leaves the latest; the wheel reaches the end (${steps} steps), and it stays there while streaming, also after more wheel-downs at the end`);
  // Dragging the column's own scrollbar upward leaves the latest and is not pulled back.
  // macOS overlay scrollbars appear only after scrolling, and at the end there is nothing
  // to scroll, so a press may miss the hidden bar. Traced presses on a shown overlay bar
  // reached the reader as pointerdown, like a classic bar, so this step draws a classic
  // bar (12px, thumb at least 60px) to press it every time.
  const classicBar = await page.addStyleTag({ content: '.collaboration-messages::-webkit-scrollbar{width:12px}.collaboration-messages::-webkit-scrollbar-thumb{background:#8888;min-height:60px}' });
  const box = await column(busy).boundingBox(), x = box.x + box.width - 6, y = box.y + box.height - 30;
  await page.mouse.move(x, y); await delay(100);
  await column(busy).evaluate(el => { el.presses = []; el.ownerDocument.addEventListener('pointerdown', event => { if (el.contains(event.target)) el.presses.push(event.target === el ? 'reader' : event.target.closest('.jump-bar') ? 'jump' : 'row'); }, { capture: true }); });
  await page.mouse.down(); const during = [];
  for (let i = 1; i <= 10; i++) { await page.mouse.move(x, y - i * 25); await delay(30); during.push((await geometry(column(busy))).fromBottom); }
  await page.mouse.up(); await delay(1500);
  const dragged = await geometry(column(busy)), presses = await column(busy).evaluate(el => el.presses);
  measurements.push({ label: 'scrollbar drag up while following', at: { x, y }, during, dragged, presses });
  // Growth between follow frames alone stays well under 400px; a grabbed scrollbar moves thousands.
  assert.ok(Math.max(...during) > 400, `The press grabbed the column scrollbar (positions during the drag: ${during.join(', ')}; presses reaching the page: ${presses.join(', ') || 'none'})`);
  assert.ok(dragged.fromBottom > 200 && dragged.jumpShown, `Scrollbar drag left the latest and stays away (${dragged.fromBottom}px from the end)`);
  await classicBar.evaluate(node => node.remove());
  check('Grid column: dragging its scrollbar up while following leaves the latest and is not pulled back');
  await column(busy).locator('.jump-latest').click(); await followsFor(column(busy), 'grid after 跳到最新 following the drag');
  // Keyboard: with focus on the following column, PageUp leaves the latest and is not pulled back.
  await column(busy).focus(); await page.keyboard.press('PageUp'); await page.keyboard.press('PageUp'); await delay(1000);
  const keyed = await geometry(column(busy)); measurements.push({ label: 'PageUp twice while following', keyed });
  assert.ok(keyed.fromBottom > 300 && keyed.jumpShown, `PageUp left the latest and stays away (${keyed.fromBottom}px from the end)`);
  await page.keyboard.press('End'); await followsFor(column(busy), 'grid after End');
  check('Grid column: PageUp while following leaves the latest and stays away; End returns to it');
  // A press held on a reply (as on 复制) while following does not end following.
  const text = await column(busy).evaluate(el => { const body = [...el.querySelectorAll(':scope > [data-message-id] .message-body')].at(-1).getBoundingClientRect(); return { x: body.x + 20, y: Math.min(body.y + 8, el.getBoundingClientRect().bottom - 20) }; });
  await page.mouse.move(text.x, text.y); await page.mouse.down(); await delay(300); await page.mouse.up();
  await followsFor(column(busy), 'grid after a press held on a reply');
  // A scrollbar drag down to the end follows the latest once let go.
  const bar = await page.addStyleTag({ content: '.collaboration-messages::-webkit-scrollbar{width:12px}.collaboration-messages::-webkit-scrollbar-thumb{background:#8888;min-height:60px}' });
  await column(busy).focus(); for (let i = 0; i < 3; i++) await page.keyboard.press('PageUp'); await delay(500);
  const left = await column(busy).evaluate(el => ({ top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight }));
  // The classic thumb is at least 60px long; press its middle.
  const area = await column(busy).boundingBox(), barX = area.x + area.width - 6, thumbLength = Math.max(60, left.client * left.client / left.height);
  const thumbY = area.y + left.top / (left.height - left.client) * (left.client - thumbLength) + thumbLength / 2;
  assert.ok((await geometry(column(busy))).fromBottom > 300, 'PageUp left the latest before the drag');
  await column(busy).evaluate(el => { el.presses = []; });
  await page.mouse.move(barX, thumbY); await page.mouse.down(); const downDuring = [];
  for (let i = 1; i <= 8; i++) { await page.mouse.move(barX, thumbY + i * 60); await delay(30); downDuring.push((await geometry(column(busy))).fromBottom); }
  await page.mouse.move(barX, area.y + area.height + 40); await delay(60); downDuring.push((await geometry(column(busy))).fromBottom); await page.mouse.up();
  await delay(50); const afterUp = (await geometry(column(busy))).fromBottom;
  const downPresses = await column(busy).evaluate(el => el.presses); measurements.push({ label: 'scrollbar drag down', downPresses, downDuring, afterUp, thumbY, barX, left });
  assert.deepEqual(downPresses, ['reader'], 'The drag down pressed the column scrollbar');
  await bar.evaluate(node => node.remove());
  await followsFor(column(busy), 'grid after a scrollbar drag down to the end');
  check('Grid column: a press held on a reply keeps following; a scrollbar drag down to the end follows once let go');
  const quiet = await geometry(column(other)); assert.ok(quiet.fromBottom < 80 && quiet.lastShown, 'The idle column is unchanged at its latest');

  await page.locator(`#session-list [data-session-id="${busy}"]`).click(); await page.locator('#chat-tab').click();
  const solo = page.locator('#messages');
  await until(async () => (await geometry(solo)).lastId?.includes('reply-'), 'Solo view shows the streaming reply');
  await leaveEnd(solo); await delay(300); assert.ok((await geometry(solo)).jumpShown, 'Solo view offers 跳到最新 away from the latest');
  await solo.locator('.jump-latest').click();
  await followsFor(solo, 'solo after 跳到最新'); await capture('04-solo-after-jump');
  check('Single-session view: 跳到最新 behaves the same and stays at the latest while streaming');
  clearInterval(stream); stream = null;
  assert.deepEqual(errors, []);
  const stats = await fixture('stats'); measurements.push({ stats: stats.overviewCalls });
  assert.equal(stats.overviewCalls.send, 0); assert.equal(stats.overviewCalls.input, 0);
  check('No page errors; no input or send reached any member');
}

run().catch(e => { failure = e.stack; process.exitCode = 1; console.error(e.stack); }).finally(async () => {
  if (stream) clearInterval(stream);
  try {
    if (evidence) fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ flowPassed: !failure, failure, checks, errors, measurements, profile, token, productModels: 0 }, null, 2));
    await scratch.release(); const owner = JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))); assert.equal(owner.token, token); fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot);
    console.log('Owned fixture cleaned; exact GUI slot released.');
  } catch (e) { console.error('Cleanup unconfirmed; owned lock retained:', e.stack); process.exitCode = 1; }
});
