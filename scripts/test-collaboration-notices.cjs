// Actual isolated Electron/service and synthetic native notices. No models,
// provider processes, user-profile changes or system clipboard reads/writes.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const scratch = require('./fixtures/test-scratch.cjs');
const { createIn } = require('./fixtures/create-view.cjs');
const { text: originalText } = require('./fixtures/collaboration-notices.cjs');
const { _electron } = scratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const evidence = process.env.NAW_EVIDENCE_DIR;
if (evidence) {
  const target = path.resolve(evidence); let existing = target;
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  const destination = path.join(fs.realpathSync(existing), path.relative(existing, target));
  for (const base of [root, code].map(p => fs.realpathSync(p))) assert.ok(destination !== base && !destination.startsWith(base + path.sep), 'Evidence must stay outside source trees');
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
}
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID();
try { fs.mkdirSync(slot); } catch (e) { if (e.code !== 'EEXIST') throw e; console.error('GUI slot occupied; no application or fixture started.'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Codex4', task: 'T90 notices', token, pid: process.pid, createdAt: new Date().toISOString() }));
const profile = scratch.directory(path.join(os.tmpdir(), 'naw-collaboration-notices-'));
const child = scratch.childProcess.fork(path.join(code, 'app/daemon.cjs'), [profile], {
  execArgv: ['--require', path.join(__dirname, 'fixtures/collaboration-notices.cjs')],
  env: { ...process.env, NAW_TEST_APP_ROOT: code, NAW_WORKSPACE: profile, NAW_APP_VERSION: require(path.join(code, 'package.json')).version },
  stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
});
let app, page, sequence = 0;
const errors = [], scenes = [], checks = [], violations = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { for (let i = 0; i < 160; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
function stats() {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const callback = reply => { if (reply.requestId === id) { clearTimeout(timer); child.off('message', callback); resolve(reply.stats); } };
    const timer = setTimeout(() => { child.off('message', callback); reject(Error('Fixture stats timed out')); }, 8000);
    child.on('message', callback); child.send({ id, method: 'stats' });
  });
}
const snapshot = () => page.evaluate(() => workspace.initial());
const reader = id => page.locator(`.collaboration-member-reader[data-member-id="${id}"] .collaboration-messages`);
const notice = (host, id) => host.locator(`[data-message-id="fixture-notice-${id}"]`);
const check = value => { checks.push(value); console.log('PASS:', value); };
async function measure(host, id, name) {
  const row = notice(host, id); await page.mouse.move(5, 5);
  await page.evaluate(() => document.activeElement?.blur()); await row.scrollIntoViewIfNeeded();
  const rest = await row.evaluate(el => ({ height: el.offsetHeight, nextTop: el.nextElementSibling.offsetTop - el.offsetTop,
    opacity: getComputedStyle(el.querySelector('.message-actions')).opacity }));
  await row.hover();
  const measurement = await row.evaluate(el => {
    const rect = node => node.getBoundingClientRect().toJSON();
    const heading = el.querySelector('.message-heading'), body = el.querySelector('.message-body'), actions = el.querySelector('.message-actions');
    return { article: rect(el), heading: rect(heading), body: rect(body), actions: rect(actions),
      bodyScrollWidth: body.scrollWidth, bodyClientWidth: body.clientWidth,
      bodyText: body.textContent, headingText: heading.textContent,
      headingScrollWidth: heading.scrollWidth, headingClientWidth: heading.clientWidth,
      height: el.offsetHeight, nextTop: el.nextElementSibling.offsetTop - el.offsetTop,
      noticeStyles: { display: getComputedStyle(el).display, borderLeft: getComputedStyle(el).borderLeftWidth, paddingLeft: getComputedStyle(el).paddingLeft,
        headingDisplay: getComputedStyle(heading).display, headingFontSize: getComputedStyle(heading).fontSize },
      actionNames: [...actions.querySelectorAll('button')].map(b => b.textContent),
      styles: Object.fromEntries(['display', 'fontSize', 'lineHeight', 'whiteSpace'].map(k => [k, getComputedStyle(body)[k]])),
      actionsVisible: getComputedStyle(actions).opacity === '1' };
  });
  const failures = [];
  if (measurement.body.width < Math.min(120, measurement.article.width * .7)) failures.push('notice body squeezed');
  if (measurement.heading.bottom > measurement.body.top + 1) failures.push('heading not above original body');
  if (measurement.actions.top < Math.max(measurement.heading.bottom, measurement.body.bottom) - 1) failures.push('actions overlap original text');
  if (measurement.bodyScrollWidth > measurement.bodyClientWidth + 1) failures.push('body horizontally overflows');
  if (measurement.actions.right > measurement.article.right + 1) failures.push('actions outside notice');
  if (!measurement.actionsVisible) failures.push('hover actions unavailable');
  if (rest.opacity !== '0') failures.push('actions visible at rest on hover-capable display');
  if (rest.height !== measurement.height || rest.nextTop !== measurement.nextTop) failures.push('hover shifts following row');
  if (measurement.headingScrollWidth > measurement.headingClientWidth + 1) failures.push('heading horizontally overflows');
  assert.equal(measurement.bodyText, originalText);
  assert.match(measurement.headingText, /内容未完整同步/); assert.match(measurement.headingText, /本次运行记录/);
  scenes.push({ name, rest, ...measurement, failures }); violations.push(...failures.map(f => name + ': ' + f));
  if (evidence) await page.screenshot({ path: path.join(evidence, name + '.png') });
  const copy = row.getByRole('button', { name: '复制', exact: true });
  await page.mouse.move(5, 5);
  await copy.focus(); assert.equal(await copy.evaluate(el => getComputedStyle(el.parentElement).opacity), '1');
  const copiesBefore = await app.evaluate(() => globalThis.noticeCopies.length);
  await copy.press('Enter');
  await until(async () => await app.evaluate((_, expected) => globalThis.noticeCopies.length === expected + 1 && globalThis.noticeCopies.at(-1), copiesBefore) === originalText,
    'Exactly one fresh copy of the fixture source');
  scenes.at(-1).copiesBefore = copiesBefore;
  scenes.at(-1).copiesAfter = await app.evaluate(() => globalThis.noticeCopies.length);
  const ordinary = host.locator(`[data-message-id="fixture-system-${id}"] .message-heading`);
  const ordinaryLayout = await ordinary.evaluate(el => ({ display: getComputedStyle(el).display, className: el.parentElement.className,
    inlineStyle: el.getAttribute('style'), html: el.parentElement.outerHTML }));
  scenes.at(-1).ordinary = ordinaryLayout;
  if (ordinaryLayout.display !== 'none') violations.push(name + ': ordinary system heading remains visible');
  assert.match(await host.locator(`[data-message-id="fixture-assistant-${id}"] .message-body strong`).innerText(), /Markdown/);
  return measurement;
}
async function run() {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Own fixture ready');
  app = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [code],
    env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(8000); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#new-session').waitFor();
  await app.evaluate(({ clipboard }) => { globalThis.noticeCopies = []; clipboard.writeText = text => globalThis.noticeCopies.push(text); });
  const nativeInitial = await stats();
  const ids = [];
  for (let i = 0; i < 4; i++) {
    const name = `Notice member ${i + 1}`;
    await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="codex"]').check();
    await page.locator('#session-name').fill(name); await createIn(page, 'chat');
    const s = (await snapshot()).sessions.find(s => s.name === name); ids.push(s.id);
    await page.locator('#session-header-more').click(); await page.getByRole('menuitem', { name: '加入协作', exact: true }).click();
  }
  const nativeBefore = await stats();
  await page.locator('#room-nav').click();
  await page.locator('#room-record').click();
  const timelineActions = await page.locator('#room-messages [data-message-id="fixture-room-system"] .message-actions').evaluate(el => getComputedStyle(el).display);
  assert.equal(timelineActions, 'none', 'Shared timeline retains its separate system action rule');
  await page.locator('#room-overview').click();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 850));
  const narrow = await measure(reader(ids[0]), ids[0], '01-narrow-members');
  assert.ok(narrow.article.width < 260, 'Exercise an actual narrow member column');
  for (const id of ids.slice(1)) await measure(reader(id), id, `narrow-${ids.indexOf(id) + 1}`);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1800, 1000));
  const wide = await measure(reader(ids[0]), ids[0], '02-wide-members'); assert.ok(wide.article.width > 300, 'Exercise wider actual columns');
  await page.locator(`[data-session-id="${ids[0]}"]`).click();
  const solo = await measure(page.locator('#messages'), ids[0], '03-single-session');
  assert.equal(solo.bodyText, narrow.bodyText); assert.deepEqual(solo.styles, narrow.styles);
  if (JSON.stringify(solo.noticeStyles) !== JSON.stringify(narrow.noticeStyles)) violations.push('Notice display/border/padding/heading styles differ between member and solo');
  assert.deepEqual(solo.actionNames, narrow.actionNames);
  const nativeAfter = await stats();
  const copyCount = await app.evaluate(() => globalThis.noticeCopies.length); assert.equal(copyCount, 6);
  for (const k of ['inputs', 'sends']) assert.equal(nativeAfter[k], nativeInitial[k], 'No native input/send, including creation');
  assert.equal(nativeAfter.opens, nativeBefore.opens, 'Reading and copy do not open another native session');
  assert.equal((await snapshot()).diagnostics.dispatches, 0); assert.deepEqual(errors, []);
  check('Exact fixture text and Markdown survive all readers; no native input/send or extra terminal open; explicit window resizes accounted');
  const result = { checks, scenes, violations, errors, profile, token, nativeInitial, nativeBefore, nativeAfter, timelineActions, copyCount,
    transport: 'NativeHost start/create replaced by synthetic fixture; not real-provider qualification',
    limits: 'Source GUI with synthetic native records. Copy writer intercepted; physical pointer/keyboard, OS clipboard, screen reader and installed package unverified.' };
  if (evidence) fs.writeFileSync(path.join(evidence, 'notices-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  assert.deepEqual(violations, []);
  check('Notice headings, bodies and hover/keyboard copy actions do not overlap; ordinary system headings match the single reader');
}
run().catch(error => {
  console.error(error.stack); process.exitCode = 1;
  if (evidence) fs.writeFileSync(path.join(evidence, 'failure-details.json'), JSON.stringify({ error: error.stack, checks, scenes, violations, errors }, null, 2));
}).finally(async () => {
  try {
    await scratch.release();
    const owner = JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))); assert.equal(owner.token, token);
    fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot);
    if (evidence) fs.writeFileSync(path.join(evidence, 'released.json'), JSON.stringify({ token, profile, profileExists: fs.existsSync(profile), slotReleased: true, time: new Date().toISOString() }, null, 2));
    console.log('Owned fixture cleaned; GUI slot released.');
  } catch (error) { console.error('Cleanup unconfirmed; retain owned lock:', error.stack); process.exitCode = 1; }
});
