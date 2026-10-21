// Actual Electron navigation with controlled provider output; no model calls.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { fork } = require('node:child_process');
const { _electron } = require('playwright');
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-progress-reading-'));
const child = fork(path.join(code, 'app/daemon.cjs'), [profile], {
  execArgv: ['--require', path.join(__dirname, 'fixtures/native-progress.cjs')],
  env: { ...process.env, NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_WORKSPACE: profile, NAW_TEST_APP_ROOT: code },
  stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
});
let application, page, sequence = 0;
const errors = [], checks = [], delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { for (let i = 0; i < 200; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
function fixture(method, target, value) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const cb = message => { if (message.requestId === id) { clearTimeout(timer); child.off('message', cb); message.error ? reject(Error(message.error)) : resolve(message); } };
    const timer = setTimeout(() => { child.off('message', cb); reject(Error('Fixture timeout')); }, 20000);
    child.on('message', cb); child.send({ id, method, target, value });
  });
}
const snapshot = () => page.evaluate(() => workspace.initial());
const panel = id => page.locator(`[data-progress-id="${id}"]`);
const row = (id, item = 'reading-result') => panel(id).locator(`[data-item-id="${item}"]`);
async function create(provider) {
  await page.locator('#new-session').click(); await page.locator(`input[name="provider"][value="${provider}"]`).check();
  await page.locator('#initial-view').selectOption('chat'); await page.locator('#session-name').fill(provider + ' reading'); await page.locator('#confirm-create').click();
  await until(async () => (await snapshot()).sessions.some(s => s.provider === provider && s.state === 'idle'), 'Session ready');
  return (await snapshot()).sessions.find(s => s.provider === provider).id;
}
async function openTrace(id) {
  const trace = panel(id).locator('.progress-trace');
  if (await trace.getAttribute('open') === null) await trace.locator(':scope > summary').click();
}
async function reading(id, item) { return row(id, item).evaluate(el => ({ open: el.open, top: el.querySelector('pre').scrollTop, left: el.querySelector('pre').scrollLeft })); }
async function restored(id, expected, item) {
  try { await until(async () => JSON.stringify(await reading(id, item)) === JSON.stringify(expected), 'Exact expanded result and reading position'); }
  catch (error) { throw Error(`${error.message}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(await reading(id, item))}`); }
}
async function visibleResult(id) {
  return row(id).locator('pre').evaluate(el => { const a = el.getBoundingClientRect(), b = el.closest('.progress-panels').getBoundingClientRect(); return Math.max(0, Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)); });
}
async function capture(name) {
  if (!process.env.NAW_EVIDENCE_DIR || !page || page.isClosed()) return;
  fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true });
  await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, name + '.png') });
}
async function run() {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Daemon');
  application = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root],
    env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await application.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message)); await page.locator('#new-session').waitFor();
  const a = await create('claude'), b = await create('codex');
  const text = Array.from({ length: 120 }, (_, i) => `Private result line ${i}: ` + 'test content '.repeat(8)).join('\n');
  const emit = (id, item = 'reading-result') => fixture('progress', id, { id: item, kind: 'tool', status: 'completed', title: 'Read this result', text });
  await emit(a); await emit(b);
  await page.locator(`[data-session-id="${a}"]`).click(); await openTrace(a); await row(a).locator(':scope > summary').click();
  await row(a).locator('pre').hover(); await page.mouse.wheel(0, 280);
  await until(async () => (await reading(a)).top > 100, 'Pointer scroll in actual result'); await delay(150);
  const expected = await reading(a); assert.equal(expected.open, true);
  await page.locator('#message-input').fill('Unsent private draft');
  await page.locator(`[data-session-id="${b}"]`).click(); await openTrace(b); assert.equal((await reading(b)).open, false, 'Same item ID in another session remains independent');
  await page.locator(`[data-session-id="${a}"]`).click(); await restored(a, expected);
  assert.equal(await page.locator('#message-input').inputValue(), 'Unsent private draft');
  await until(async () => await visibleResult(a) >= 20, 'Previously read result remains visible after switch');
  checks.push('Pointer-read result and unsent draft survive session switch; same item ID in another session stays independent');

  await page.getByRole('button', { name: '原生终端', exact: true }).click();
  await page.getByRole('button', { name: '对话', exact: true }).click(); await restored(a, expected);
  await panel(a).locator('.progress-trace > summary').click();
  await page.locator(`[data-session-id="${b}"]`).click(); await page.locator(`[data-session-id="${a}"]`).click();
  assert.equal(await panel(a).locator('.progress-trace').getAttribute('open'), null);
  await openTrace(a); await restored(a, expected);
  await row(a).locator(':scope > summary').click();
  await page.locator(`[data-session-id="${b}"]`).click(); await page.locator(`[data-session-id="${a}"]`).click();
  assert.equal((await reading(a)).open, false, 'A deliberately collapsed result stays collapsed');
  await row(a).locator(':scope > summary').click(); await restored(a, expected);
  checks.push('GUI/TUI switch, collapsed container and deliberately collapsed result preserve reading intent');

  // Collapsing a result can clamp the outer scrollbar. Resume reading its
  // body before leaving, so visibility on return has a meaningful baseline.
  await row(a).locator('pre').hover();
  await until(async () => await visibleResult(a) >= 20, 'Result body visible before leaving for the room');
  await page.getByRole('button', { name: '加入协作', exact: true }).click();
  await page.locator(`[data-session-id="${b}"]`).click(); await page.getByRole('button', { name: '加入协作', exact: true }).click();
  await page.locator('#room-nav').click(); await page.locator('#room-record').click(); await restored(a, expected);
  await page.locator(`[data-session-id="${a}"]`).click(); await page.getByRole('button', { name: '脱出协作', exact: true }).click(); await restored(a, expected);
  assert.equal((await snapshot()).room.messages.length, 0);
  await until(async () => await visibleResult(a) >= 20, 'Previously read result remains visible after room detach');
  await capture('restored-result');
  checks.push('Solo/room and detach retain private result position without sharing its text');

  // A delayed snapshot must respect a newer gesture on the outer scrollbar
  // or container, including an area outside the child progress panel.
  await page.locator(`[data-session-id="${b}"]`).click(); await fixture('hold', a);
  await page.locator(`[data-session-id="${a}"]`).click();
  await until(async () => (await fixture('stats')).waiting.includes(a), 'Held returning snapshot');
  // Before the held result arrives the pane may have no scrollbar. Exercise
  // its own event boundary explicitly; the earlier cases use real pointer
  // wheel input on visible content, this is not a physical scrollbar test.
  await page.locator('#solo-progress').dispatchEvent('pointerdown', { bubbles: true });
  await delay(100); const chosenTop = await page.locator('#solo-progress').evaluate(el => el.scrollTop);
  await fixture('release', a); await row(a).waitFor(); await delay(150);
  assert.equal(await page.locator('#solo-progress').evaluate(el => el.scrollTop), chosenTop, 'New outer reading intent defeats late saved anchor');
  checks.push('Synthetic outer-container pointer intent wins over a late observation snapshot');

  // A new native connection must not inherit UI state for accidentally reused IDs.
  await fixture('connection', a, 'idle');
  await until(async () => !(await reading(a)).open, 'New connection resets obsolete item reading');
  await row(a).locator(':scope > summary').click();
  for (let i = 0; i < 205; i++) await fixture('progress', a, { id: `replacement-${i}`, title: `Retained ${i}`, status: 'completed', text: 'Bounded local output' });
  await until(async () => await row(a).count() === 0, 'Evicted item disappears');
  await page.locator(`[data-session-id="${b}"]`).click(); await page.locator(`[data-session-id="${a}"]`).click();
  await emit(a); await row(a).waitFor(); assert.equal((await reading(a)).open, false, 'Evicted ID does not resurrect earlier expansion');
  checks.push('Connection replacement and retention eviction retire stale per-item reading state');
  const final = await snapshot(), stats = (await fixture('stats')).stats;
  assert.equal(final.diagnostics.dispatches, 0); assert.equal(stats.sends, 0); assert.equal(stats.inputs, 0); assert.deepEqual(errors, []);
  await capture('progress-reading'); console.log(JSON.stringify({ checks, exactReading: expected, dispatches: 0, stats, errors }, null, 2));
}
run().catch(async error => { await capture('failure').catch(() => {}); console.error(error.stack); process.exitCode = 1; }).finally(async () => {
  if (application) await application.close().catch(() => {});
  child.kill('SIGTERM');
});
