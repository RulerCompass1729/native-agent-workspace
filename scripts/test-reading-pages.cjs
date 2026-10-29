// Actual isolated source GUI/service. Only native output is synthetic.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const { createHash } = require('node:crypto');
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
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Codex4', task: 'T89 reading pages', token, pid: process.pid, time: new Date().toISOString() }));
const profile = scratch.directory(path.join(os.tmpdir(), 'naw-reading-pages-'));
const workspaceRoot = path.join(profile, 'workspace'); fs.mkdirSync(workspaceRoot);
const child = scratch.childProcess.fork(path.join(code, 'app/daemon.cjs'), [profile], {
  execArgv: ['--require', path.join(__dirname, 'fixtures/loading-terminal.cjs')],
  env: { ...process.env, NAW_TEST_APP_ROOT: code, NAW_WORKSPACE: workspaceRoot, NAW_APP_VERSION: require(path.join(code, 'package.json')).version },
  stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
});
const checks = [], errors = [], measurements = [];
let app, page, sequence = 0, failure = null;
const launches = [];
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
  if (installed && evidence) {
    const process = app.process(), contents = path.resolve(code, '../..'), bundle = path.dirname(contents);
    const signature = require('node:child_process').spawnSync('/usr/bin/codesign', ['--display', '--verbose=4', bundle], { encoding: 'utf8' });
    assert.equal(signature.status, 0); const cdhash = signature.stderr.match(/^CDHash=(\w+)$/m)?.[1]; assert.ok(cdhash);
    const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    launches.push({ pid: process.pid, executable: process.spawnfile, argv: process.spawnargs, bundle, cdhash,
      sourceRevision: execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :NAWSourceRevision', path.join(contents, 'Info.plist')], { encoding: 'utf8' }).trim(),
      executableSha256: hash(process.spawnfile), clientSha256: hash(path.join(code, 'app/dsh/client.js')),
      daemon: { pid: child.pid, argv: child.spawnargs, appRoot: code, sourceSha256: hash(path.join(code, 'app/daemon.cjs')) } });
    fs.writeFileSync(path.join(evidence, 'installed-launches.json'), JSON.stringify(launches, null, 2));
  }
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message)); await page.locator('#new-session').waitFor();
  if (!installed) await app.evaluate(({ clipboard }) => { globalThis.pageCopies = []; clipboard.writeText = text => globalThis.pageCopies.push(text); });
}
async function create(name) {
  await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="codex"]').check();
  await page.locator('#session-name').fill(name); await createIn(page, 'chat');
  return (await snapshot()).sessions.find(s => s.name === name).id;
}
async function measure(name, host = page.locator('#messages')) {
  const m = await host.evaluate(el => ({ articles: el.querySelectorAll('article[data-message-id]').length, scrollHeight: el.scrollHeight, height: el.clientHeight,
    top: el.scrollTop, first: el.querySelector('article[data-message-id]')?.dataset.messageId, last: [...el.querySelectorAll('article[data-message-id]')].at(-1)?.dataset.messageId }));
  measurements.push({ name, ...m }); return m;
}
async function capture(name) { if (evidence) await page.screenshot({ path: path.join(evidence, name + '.png') }); }
async function search(text, messageId) {
  await page.locator('#search-button').click(); await page.locator('#search-options-summary').click();
  await page.locator('#search-scope').selectOption('current'); await page.locator('#search-input').fill(text);
  const sessionId = (await snapshot()).viewState.selected;
  const result = page.locator(`#search-results button[data-search-key="message:${sessionId}:${messageId}"]`);
  await result.waitFor({ state: 'visible' }); assert.equal(await result.count(), 1); await result.click();
}
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
    // Keep the user's OS clipboard untouched. The unchanged source-mode copy
    // receipt is reused; this installed check covers focus, source and visibility.
    await copy.focus(); assert.equal(await copy.isEnabled(), true);
    const data = await snapshot(), original = data.sessions.flatMap(s => s.messages).find(m => m.id === id);
    assert.equal(original?.text, text);
    const body = await host.locator(`[data-message-id="${id}"] .message-body`).innerText();
    assert.ok(text.split(/\n+/).filter(Boolean).every(line => body.includes(line)));
    return;
  }
  const before = await app.evaluate(() => globalThis.pageCopies.length);
  await copy.focus(); await copy.press('Enter');
  await until(async () => await app.evaluate((_, n) => globalThis.pageCopies.length === n + 1 && globalThis.pageCopies.at(-1), before) === text, 'One fresh original copy receipt');
}
async function run() {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Own fixture started'); await launch();
  const id = await create('Paged original history'), other = await create('Independent original history');
  await page.locator(`[data-session-id="${id}"]`).click();
  const history = Array.from({ length: 2480 }, (_, i) => ({ id: 'page-' + i, type: 'agentMessage', turnId: 'turn-' + i,
    text: `Page record ${String(i).padStart(4, '0')}. Original source.\n\n保留原文和阅读位置。 Source line ${i}.` }));
  await fixture('history', id, history);
  await page.locator('#messages [data-message-id="page-2479"] .message-body p').first().waitFor();
  const initial = await measure('recent-2480'); await capture('01-recent');
  assert.ok(initial.articles <= 50, 'Initial scrollbar must cover recent records, not all2480');
  assert.equal(initial.first, 'page-2430'); assert.equal(initial.last, 'page-2479');
  assert.equal((await snapshot()).sessions.find(s => s.id === id).messages.filter(m => m.id.startsWith('page-')).length, 2480);
  check('Recent segment renders fifty originals while all2480 local source records remain intact');

  let host = page.locator('#messages');
  const before = await host.evaluate(el => {
    el.scrollTop = 0;
    const row = el.querySelector('[data-message-id="page-2430"]'), body = row.querySelector('.message-body');
    const range = document.createRange(); range.selectNodeContents(body); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    return { selection: selection.toString(), offset: row.getBoundingClientRect().top - el.getBoundingClientRect().top };
  });
  await until(() => host.locator('article[data-message-id]').count().then(n => n === 100), 'One older page prepended');
  const offset = () => host.locator('[data-message-id="page-2430"]').evaluate(el => el.getBoundingClientRect().top - el.closest('.messages').getBoundingClientRect().top);
  await until(async () => Math.abs(await offset() - before.offset) < 3, 'Prepend restores the same visible original anchor');
  assert.equal(await page.evaluate(() => getSelection().toString()), before.selection);
  await measure('older-prepend'); await capture('02-older');
  await fixture('delta', id, { id: 'page-live', text: 'Fresh source below history.\n' });
  await until(() => host.locator('[data-message-id="page-live"]').count().then(n => n === 1), 'Latest-containing range keeps new original output without dropping old rows');
  assert.equal(await page.evaluate(() => getSelection().toString()), before.selection); assert.ok(Math.abs(await offset() - before.offset) < 3);
  await copyOriginal(host, 'page-2430', history[2430].text);
  check('Older prepend and new output preserve the same original text, anchor and selection; ' + (installed ? 'copy focus/source retained, source-mode clipboard receipt reused' : 'exact keyboard copy receipt'));

  await page.locator('#message-input').fill('Unsent original draft 你好');
  await until(async () => (await snapshot()).sessions.find(s => s.id === id).liveDraft === 'Unsent original draft 你好', 'Original draft persisted');
  const returnAnchor = await readingAnchor();
  await search('Page record 0123.', 'page-123'); await host.locator('[data-message-id="page-123"][data-search-target="true"]').waitFor();
  const target = await measure('unloaded-search'); assert.ok(target.articles <= 50); assert.ok(Number(target.last.replace('page-', '')) < 200);
  await until(async () => Math.abs((await readingAnchor()).offset - 16) < 40, 'Unloaded original is in the viewport after Markdown mounts');
  assert.equal(await host.locator('[data-message-id="page-live"]').count(), 0);
  await fixture('delta', id, { id: 'page-live', text: 'Still later source.\n' });
  assert.equal(await host.locator('[data-message-id="page-live"]').count(), 0);
  assert.equal(await host.getByRole('button', { name: '↓ 跳到最新', exact: true }).isVisible(), true);
  const targetOffset = await host.locator('[data-message-id="page-123"]').evaluate(el => el.getBoundingClientRect().top - el.closest('.messages').getBoundingClientRect().top);
  await fixture('delta', id, { id: 'page-124', text: 'Updated already-loaded original.\n' });
  await until(() => host.locator('[data-message-id="page-124"] .message-body').innerText().then(t => t.includes('Updated already-loaded original.')), 'A mounted older record still receives its real update');
  assert.ok(Math.abs(await host.locator('[data-message-id="page-123"]').evaluate(el => el.getBoundingClientRect().top - el.closest('.messages').getBoundingClientRect().top) - targetOffset) < 3);
  await copyOriginal(host, 'page-123', history[123].text);
  await host.getByRole('button', { name: '显示较新的记录', exact: true }).focus(); await page.keyboard.press('Enter');
  await until(() => host.locator('article[data-message-id]').count().then(n => n >= 100), 'Newer-page keyboard navigation loads original neighbours');
  assert.equal(await host.evaluate(el => document.activeElement === el), true, 'Paging leaves focus on the named reader, not an offscreen navigation button');
  await page.locator('#return-reading').click();
  await until(async () => { const a = await readingAnchor(); return a?.id === returnAnchor.id && Math.abs(a.offset - returnAnchor.offset) < 3; }, 'Search returns to the original source anchor and offset');
  assert.equal(await page.locator('#message-input').inputValue(), 'Unsent original draft 你好');
  check('Search loads an existing unloaded original; old segments exclude newer output and return preserves anchor/draft');

  await search('Page record 0200.', 'page-200'); await host.locator('[data-message-id="page-200"][data-search-target="true"]').waitFor();
  await host.hover(); await page.mouse.wheel(0, 100000);
  await delay(180);
  const oldPosition = (await snapshot()).viewState.readingPositions[id];
  assert.equal(oldPosition.follow, false, 'Older loaded bottom must not become follow-latest');
  const oldAnchor = await readingAnchor(); await app.close(); app = null; await launch(); host = page.locator('#messages');
  await until(async () => { const a = await readingAnchor(); return a?.id === oldAnchor.id && Math.abs(a.offset - oldAnchor.offset) < 3; }, 'App reopen restores older section rather than latest');
  assert.equal(await page.locator('#message-input').inputValue(), 'Unsent original draft 你好');
  assert.equal((await snapshot()).sessions.find(s => s.id === id).nativeId, 'synthetic-' + id);
  check('Reopen from an older segment retains the same source anchor, native identity and unsent draft');

  await host.focus(); await host.press('Home'); await host.locator('[data-message-id="page-0"]').waitFor();
  assert.ok((await measure('home-first')).articles <= 50);
  await host.press('End'); await host.locator('[data-message-id="page-live"]').waitFor();
  assert.ok((await measure('end-latest')).articles <= 50);
  await host.dispatchEvent('keydown', { key: 'Home', isComposing: true, keyCode: 229 });
  assert.equal(await host.locator('[data-message-id="page-0"]').count(), 0, 'Composition never pages the reading surface');
  await host.press('Shift+Home'); assert.equal(await host.locator('[data-message-id="page-0"]').count(), 0, 'Native selection shortcut is not replaced by history navigation');
  await page.evaluate(() => getSelection().removeAllRanges());
  assert.equal(await host.getAttribute('role'), 'region'); assert.ok(await host.getAttribute('aria-label'));
  if (evidence) fs.writeFileSync(path.join(evidence, 'solo-accessibility.txt'), await host.ariaSnapshot());
  await page.locator('#message-input').press('Home'); assert.equal(await host.locator('[data-message-id="page-0"]').count(), 0);
  const identities = (await snapshot()).sessions.map(s => [s.id, s.nativeId]);
  await page.locator(`[data-session-id="${other}"]`).click(); await page.locator(`[data-session-id="${id}"]`).click();
  await host.locator('[data-message-id="page-live"]').waitFor(); assert.equal(await page.locator('#message-input').inputValue(), 'Unsent original draft 你好');
  assert.deepEqual((await snapshot()).sessions.map(s => [s.id, s.nativeId]), identities);
  check('Named keyboard reader Home/End reach original history boundaries without paging the editable input');

  await page.locator('#session-header-more').click(); await page.getByRole('menuitem', { name: '加入协作', exact: true }).click();
  await page.locator(`[data-session-id="${other}"]`).click();
  await fixture('history', other, history.slice(0, 120).map(m => ({ ...m, id: 'other-' + m.id })));
  await page.locator('#session-header-more').click(); await page.getByRole('menuitem', { name: '加入协作', exact: true }).click();
  await page.locator('#room-nav').click();
  const member = sid => page.locator(`.collaboration-member-reader[data-member-id="${sid}"] .messages`);
  await until(() => member(id).locator('article').count().then(n => n === 50), 'Member A recent page');
  assert.equal(await member(other).locator('article').count(), 50);
  const otherPosition = await member(other).evaluate(el => el.scrollTop);
  await member(id).evaluate(el => { el.scrollTop = 0; });
  await until(() => member(id).locator('article').count().then(n => n === 100), 'Member A older page');
  assert.equal(await member(other).locator('article').count(), 50); assert.equal(await member(other).evaluate(el => el.scrollTop), otherPosition);
  await page.getByRole('button', { name: '简化信息', exact: true }).click();
  const source = page.locator(`.collaboration-member-reader[data-member-id="${id}"] .collaboration-source`);
  await source.click(); await member(id).locator('[data-message-id="page-live"][data-search-target="true"]').waitFor();
  assert.ok(!(await page.locator('#toast').innerText()).includes('已不在当前'));
  await capture('03-member-pages');
  check('Each member has an independent segment; source excerpts load their exact unloaded original without a missing-record toast');

  await member(id).focus(); await member(id).press('End');
  for (let i = 0; i < 70; i++) await fixture('delta', id, { id: 'follow-' + i, text: `Following original ${i}.\n` });
  await member(id).locator('[data-message-id="follow-69"]').waitFor();
  await until(() => member(id).evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight < 3), 'Followed output actually stays at the visible latest record after Markdown settles');
  const following = await measure('seventy-followed-messages', member(id));
  assert.equal(following.articles, 50); assert.equal(following.first, 'follow-20'); assert.equal(following.last, 'follow-69');
  check('A long followed conversation keeps fifty recent originals instead of regrowing its full-history scrollbar');

  await fixture('native-activity', other, { turnId: 'page-group-turn', label: 'Synthetic original tools' });
  for (let i = 0; i < 60; i++) await fixture('nativeBlock', other, { id: 'page-group-' + i, turnId: 'page-group-turn', kind: 'tool',
    toolKind: 'commandExecution', title: 'Bash', input: 'printf synthetic-' + i, text: 'Atomic original ' + i, status: i === 30 ? 'failed' : 'complete' });
  const firstTool = (await snapshot()).sessions.find(s => s.id === other).messages.find(m => m.text === 'Atomic original 0');
  assert.ok(firstTool); const groupId = 'process:' + firstTool.id;
  let group = member(other).locator(`[data-process-group="${groupId}"]`);
  await until(async () => (await group.locator(':scope > details > summary').innerText()).includes('60 个命令'), 'Actual T67 group keeps all sixty native originals');
  assert.equal(await group.locator('article[data-message-id]').count(), 60); assert.equal(await group.getAttribute('data-running'), 'true');
  assert.match(await group.locator(':scope > details > summary').innerText(), /失败 1/);
  await group.locator(':scope > details > summary').click();
  assert.equal(await group.locator(':scope > details').getAttribute('open'), null);
  // A collapsed group can make the page shorter than its viewport. Wheel-up
  // must still reach older records even when no scroll event can be emitted.
  await member(other).hover(); await page.mouse.wheel(0, -30);
  await until(() => member(other).locator('article[data-message-id]').count().then(n => n > 60), 'Short collapsed page can load earlier originals');
  assert.equal(await group.locator(':scope > details').getAttribute('open'), null, 'Loading history preserves the explicit outer fold');
  assert.equal(await group.locator('article[data-message-id]').count(), 60); assert.match(await group.locator(':scope > details > summary').innerText(), /60 个命令/);
  await member(other).focus(); await member(other).press('End');
  await until(() => member(other).locator('article[data-message-id]').count().then(n => n > 60), 'A short latest page automatically fills with older originals');
  const shortKey = Object.keys((await snapshot()).viewState.readingPositions).find(k => k.startsWith('collaboration:') && k.endsWith(':' + other));
  assert.equal((await snapshot()).viewState.readingPositions[shortKey].follow, true, 'Automatic height filling must preserve follow-latest');
  await group.locator(':scope > details > summary').click();
  const originalTool = group.locator(`[data-message-id="${firstTool.id}"]`);
  await originalTool.locator(':scope > details > summary').click(); await copyOriginal(member(other), firstTool.id, firstTool.text);
  await member(other).evaluate(el => {
    const row = el.querySelector('[data-process-group]'); el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top;
  });
  const readingKey = () => snapshot().then(s => Object.keys(s.viewState.readingPositions).find(k => k.startsWith('collaboration:') && k.endsWith(':' + other)));
  await until(async () => (await snapshot()).viewState.readingPositions[await readingKey()]?.anchor === groupId, 'Actual synthetic process anchor saved');
  const groupAnchor = await readingAnchor(member(other)); assert.equal(groupAnchor.id, groupId);
  await page.reload(); await page.locator('#new-session').waitFor();
  group = member(other).locator(`[data-process-group="${groupId}"]`);
  await until(async () => { const a = await readingAnchor(member(other)); return a?.id === groupId && Math.abs(a.offset - groupAnchor.offset) < 3; }, 'Reload resolves the saved process ID to its original whole group');
  assert.equal(await group.locator('article[data-message-id]').count(), 60); assert.equal(await group.getAttribute('data-running'), 'true');
  assert.equal((await snapshot()).sessions.find(s => s.id === id).liveDraft, 'Unsent original draft 你好');
  if (evidence) fs.writeFileSync(path.join(evidence, 'member-accessibility.txt'), await member(other).ariaSnapshot());
  await capture('04-native-group-anchor');
  check('Actual native process groups remain whole with their caption/failure/running state, explicit fold and saved process anchor; ' + (installed ? 'full source retained, source-mode tool-copy receipt reused' : 'full tool copy receipt'));

  // Review regression: following is a real latest-record intent, not a request
  // to centre the obsolete source anchor that happened to be visible earlier.
  await page.locator(`[data-session-id="${id}"]`).click();
  const followingHost = page.locator('#messages'), followFailures = [];
  async function atRealLatest(expected) {
    for (let i = 0; i < 80; i++) {
      if (await followingHost.evaluate((el, last) => [...el.querySelectorAll('article[data-message-id]')].at(-1)?.dataset.messageId === last &&
        el.scrollHeight - el.scrollTop - el.clientHeight < 3, expected)) return true;
      await delay(25);
    }
    return false;
  }
  async function followedSearchReturn(expected, name) {
    await search('Page record 0123.', 'page-123');
    await followingHost.locator('[data-message-id="page-123"][data-search-target="true"]').waitFor();
    await page.locator('#return-reading').click();
    const latest = await atRealLatest(expected); await measure(name, followingHost);
    measurements.push({ name: name + '-saved', position: (await snapshot()).viewState.readingPositions[id], expectedLatest: expected, latest });
    if (!latest) followFailures.push(name);
  }
  await followingHost.focus(); await followingHost.press('End');
  await followedSearchReturn('follow-69', 'followed-search-empty-anchor');
  async function wheelToLatest(expected) {
    await followingHost.focus(); await followingHost.press('End'); assert.equal(await atRealLatest(expected), true);
    await followingHost.hover(); await page.mouse.wheel(0, -180);
    await until(() => followingHost.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight > 80), 'Wheel really leaves latest');
    await page.mouse.wheel(0, 100000);
    await until(async () => {
      const p = (await snapshot()).viewState.readingPositions[id];
      return p?.follow === true && !!p.anchor && await atRealLatest(expected);
    }, 'Wheel establishes followed latest with an actual source anchor');
  }
  await wheelToLatest('follow-69');
  for (let i = 0; i < 60; i++) await fixture('delta', id, { id: 'wheel-follow-' + i, text: `Wheel-follow original ${i}.\n` });
  const wheelLatest = await atRealLatest('wheel-follow-59'); await measure('wheel-sixty-appends', followingHost);
  if (!wheelLatest) followFailures.push('wheel-sixty-appends');
  await wheelToLatest('wheel-follow-59');
  for (let i = 0; i < 30; i++) await fixture('delta', id, { id: 'return-follow-' + i, text: `Return-follow original ${i}.\n` });
  await followedSearchReturn('return-follow-29', 'followed-search-stale-anchor');
  assert.deepEqual(followFailures, [], 'Following and search-return must show the real latest record for empty and nonempty source anchors');
  check('Wheel-follow survives sixty new records; search return reaches real latest with either an empty or stale followed anchor');

  const packet = await fixture('stats'); assert.equal(packet.inputs.length, 0); assert.equal(packet.sends.length, 0);
  measurements.push({ name: 'native-fixture-actions', inputs: packet.inputs.length, sends: packet.sends.length, interruptions: packet.interruptions.length,
    pendingOwnedTerminalReads: packet.pending });
  assert.equal((await snapshot()).diagnostics.dispatches, 0);
  assert.deepEqual(errors, []);
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
    if (evidence) fs.writeFileSync(path.join(evidence, 'reading-pages-result.json'), JSON.stringify({ flowPassed: !failure, failure, checks, errors, measurements, profile, token,
      clipboard: installed ? 'Source-mode receipt reused; installed checks focus/full source/visible body only, no clipboard action' : 'Source-mode main-process clipboard stub receipt' }, null, 2));
    await scratch.release(); const owner = JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))); assert.equal(owner.token, token);
    fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot);
    if (evidence) fs.writeFileSync(path.join(evidence, 'released.json'), JSON.stringify({ profile, token, profileExists: fs.existsSync(profile), time: new Date().toISOString() }, null, 2));
    console.log('Owned fixture cleaned; GUI slot released.');
  } catch (e) { console.error('Cleanup not confirmed; owned lock retained:', e.stack); process.exitCode = 1; }
});
