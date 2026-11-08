// T-60 batch 3: walk the main screens in English and list Chinese that the interface itself shows.
// Actual source Electron + the existing synthetic NativeHost; no model, provider or native program starts.
// Fixture names are ASCII, so Chinese found on screen is interface-owned or a stored default.
// Each step records its own failure and the walk continues, so one stale step does not hide the rest.
// Each state page also waits for its own English text, so a fixture that stops working fails the walk.
// Not covered: terminal (.xterm) content of the stub terminal, OS menus/dialogs/notifications (stubbed or
// native), canvas and shadow DOM, notices that vanish within the settle delay, and a recovering terminal
// (no visible text of its own to prove the state). Installed builds and real providers are not qualified.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const testScratch = require('./fixtures/test-scratch.cjs'), { createIn } = require('./fixtures/create-view.cjs');
const { _electron } = testScratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const locale = require(path.join(code, 'app/ui-locale.js')), en = (key, params) => locale.format('en', key, params);
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID();
const evidence = process.env.NAW_EVIDENCE_DIR;
if (evidence) {
  fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
  for (const repo of [root, code].map(p => fs.realpathSync(p))) assert.ok(!(fs.realpathSync(evidence) + path.sep).startsWith(repo + path.sep), 'Evidence stays outside the repository');
}
try { fs.mkdirSync(slot); } catch (error) { if (error.code !== 'EEXIST') throw error; console.error('GUI slot occupied; no launch.'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: process.env.NAW_TEST_OWNER || 'Claude2', task: 'T60 English walkthrough', token, pid: process.pid, createdAt: new Date().toISOString() }));
// Until the cleanup below is registered, a failure exits here: release only our own slot then.
let setupDone = false;
process.on('exit', () => { if (setupDone) return; try { if (JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'), 'utf8')).token === token) fs.rmSync(slot, { recursive: true, force: true }); } catch {} });
const profile = testScratch.directory(path.join(os.tmpdir(), 'naw-english-walkthrough-'));
const working = path.join(profile, 'workspace'), folders = ['alpha', 'beta'].map(name => path.join(working, name));
for (const folder of folders) fs.mkdirSync(folder, { recursive: true });
const child = testScratch.childProcess.fork(path.join(code, 'app/daemon.cjs'), [profile], {
  execArgv: ['--require', path.join(__dirname, 'fixtures/loading-terminal.cjs')],
  env: { ...process.env, DSH_TELEMETRY_DISABLED: '1', NAW_TEST_APP_ROOT: code, NAW_WORKSPACE: working, NAW_APP_VERSION: require(path.join(code, 'package.json')).version },
  stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, text) { for (let n = 0; n < 160; n++) { if (await fn()) return; await delay(50); } throw Error(text); }
let sequence = 0;
function fixture(method, target, value) {
  return new Promise((resolve, reject) => {
    const id = ++sequence, receive = reply => { if (reply.requestId === id) { clearTimeout(timer); child.off('message', receive); resolve(reply); } };
    const timer = setTimeout(() => { child.off('message', receive); reject(Error('Fixture response timed out')); }, 8000);
    child.on('message', receive); child.send({ id, method, target, value });
  });
}
// Visible interface text and accessible names holding Chinese. Hidden elements are skipped: they are not shown or read.
function scanPage() {
  const han = /\p{Script=Han}/u, hits = [];
  const visible = el => { if (!el?.isConnected) return false; const style = getComputedStyle(el); return style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0; };
  const where = el => { const parts = []; for (let e = el; e && e !== document.body && parts.length < 4; e = e.parentElement) parts.unshift(e.id ? '#' + e.id : e.tagName.toLowerCase() + (typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\s+/)[0] : '')); return parts.join(' > '); };
  const native = el => !!el.closest('.xterm');
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node; (node = walker.nextNode());) { const text = node.nodeValue.trim(), el = node.parentElement; if (text && han.test(text) && visible(el) && !native(el)) hits.push({ kind: 'text', text: text.slice(0, 160), where: where(el) }); }
  for (const el of document.querySelectorAll('[aria-label],[title],[placeholder],[aria-description],[alt]')) {
    if (!visible(el) || native(el)) continue;
    for (const attr of ['aria-label', 'title', 'placeholder', 'aria-description', 'alt']) { const value = el.getAttribute(attr); if (value && han.test(value)) hits.push({ kind: attr, text: value.slice(0, 160), where: where(el) }); }
  }
  for (const option of document.querySelectorAll('select option')) if (visible(option.parentElement) && han.test(option.textContent)) hits.push({ kind: 'option', text: option.textContent.trim().slice(0, 160), where: where(option.parentElement) });
  for (const el of document.querySelectorAll('input[type="button"],input[type="submit"],input[type="reset"],button[value]')) if (visible(el) && han.test(el.value || '')) hits.push({ kind: 'value', text: el.value.slice(0, 160), where: where(el) });
  for (const title of document.querySelectorAll('svg title')) if (visible(title.closest('svg')) && han.test(title.textContent)) hits.push({ kind: 'svg title', text: title.textContent.trim().slice(0, 160), where: where(title.closest('svg')) });
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el) || native(el)) continue;
    for (const pseudo of ['::before', '::after']) { const content = getComputedStyle(el, pseudo).content; if (content && content !== 'none' && content !== 'normal' && han.test(content)) hits.push({ kind: pseudo, text: content.slice(0, 160), where: where(el) }); }
  }
  if (han.test(document.title)) hits.push({ kind: 'document.title', text: document.title, where: 'document' });
  return hits;
}
// Known items, each with its reason. Every entry must still appear, so a fixed item has to leave this list.
const known = [
  { kind: 'option', text: '中文', where: '#ui-language', why: 'Language choices name each language in its own script.' },
  // Open (T-60): the default shared space is stored as 共同工作. Showing it in English needs a display-time name across
  // the sidebar (Claude · NAW 开发 band) and the panorama. Only the observed exact forms are listed.
  { kind: 'option', text: '共同工作', where: '#panorama-view' },
  { kind: 'text', text: '共同工作', where: '#room-nav-name' },
  ...['aria-label', 'title'].flatMap(kind => [
    { kind, pattern: /^Open space “共同工作” · Members: \d+$/, where: '#room-nav' },
    { kind, text: 'Space actions: 共同工作', where: '#room-more' }]),
];
const matches = (rule, item) => rule.kind === item.kind && (rule.text ? item.text === rule.text : rule.pattern.test(item.text)) && item.where.includes(rule.where);
const pages = [], failures = [], errors = [];
let app, page;
async function visit(name, action, expected) {
  try {
    await action();
    // A state page proves its state by its own English text before it counts.
    if (expected) await (expected.placeholder ? page.getByPlaceholder(expected.placeholder, { exact: true }) : page.getByText(expected, { exact: false })).first().waitFor({ state: 'visible' });
    await delay(250);
    const hits = await page.evaluate(scanPage);
    if (evidence) await page.screenshot({ path: path.join(evidence, `${String(pages.length + 1).padStart(2, '0')}-${name}.png`) });
    pages.push({ name, hits }); console.log(`PAGE ${name}: ${hits.length} Chinese item(s)`);
  } catch (error) { failures.push({ name, error: String(error.message || error).split('\n')[0] }); console.log(`UNREACHED ${name}: ${failures.at(-1).error}`); }
}
const state = () => page.evaluate(() => workspace.initial());
const more = id => page.locator(`[data-session-menu="${id}"]`);
const item = name => page.getByRole('menuitem', { name, exact: true });
const closeMenus = async () => { for (let n = 0; n < 3 && await page.getByRole('menu').count(); n++) await page.keyboard.press('Escape'); };
async function create(name, folder) {
  await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, folder);
  await page.locator('#new-session').click(); await page.locator('#create-dialog').waitFor();
  await page.locator('input[name="provider"][value="codex"]').check();
  await page.locator('#session-name').fill(name); await page.locator('#choose-folder').click();
  await createIn(page, 'chat');
  await until(async () => (await state()).sessions.find(s => s.name === name)?.state === 'idle', `${name} becomes ready`);
  return (await state()).sessions.find(s => s.name === name).id;
}
async function run() {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Own fixture startup');
  app = await _electron.launch({ args: [path.join(__dirname, 'fixtures/interface-language-main.cjs')],
    env: { ...process.env, DSH_TELEMETRY_DISABLED: '1', NAW_TEST_APP_ROOT: code, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid), NAW_TEST_UI_LANGUAGE: 'system' }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(8000); page.on('pageerror', error => errors.push(error.message));
  await page.locator('#new-session').waitFor({ timeout: 60000 });
  assert.equal(await page.locator('#new-session').getAttribute('aria-label'), en('sidebar.newSession'), 'The walk needs an English interface (English system preference)');
  // Positive control: the scanner must find one visible Chinese text and ignore a hidden one.
  const control = await page.evaluate(scan => {
    const shown = document.createElement('span'), hidden = document.createElement('span'), style = document.createElement('style');
    shown.textContent = '自检'; shown.title = '提示'; shown.className = 'walk-control'; hidden.textContent = '隐藏'; hidden.hidden = true;
    style.textContent = '.walk-control::after { content: "后缀"; }'; document.head.append(style); document.body.append(shown, hidden);
    const hits = new Function(`return (${scan})()`)(); shown.remove(); hidden.remove(); style.remove();
    return hits.map(hit => `${hit.kind}:${hit.text}`).sort();
  }, scanPage.toString());
  assert.deepEqual(control, ['::after:"后缀"', 'text:自检', 'title:提示'], 'The scanner finds visible text, attributes and generated content and skips hidden text');
  await visit('welcome-sidebar', async () => {});
  await visit('create-dialog', async () => { await page.locator('#new-session').click(); await page.locator('#create-dialog').waitFor(); });
  await page.keyboard.press('Escape'); await page.locator('#create-dialog').waitFor({ state: 'hidden' }).catch(() => {});
  const alpha = await create('Alpha', folders[0]), beta = await create('Beta', folders[1]);
  await visit('session-chat', async () => { await page.locator(`[data-session-id="${alpha}"]`).first().click(); await page.locator('#chat-tab').click(); });
  await visit('session-terminal', async () => { await page.locator('#terminal-tab').click(); });
  await page.locator('#chat-tab').click().catch(() => {});
  await visit('session-menu', async () => { await more(alpha).first().click(); await page.getByRole('menu').waitFor(); });
  await closeMenus();
  // A new profile has no space yet: create one with an ASCII name, then move both sessions into it.
  await visit('new-space-dialog', async () => { await page.locator('#new-space').click(); await page.locator('#space-create-dialog').waitFor(); });
  await page.locator('#space-create-name').fill('Gamma'); await page.locator('#confirm-space-create').click();
  await page.locator('#space-create-dialog').waitFor({ state: 'hidden' });
  for (const id of [alpha, beta]) { await more(id).first().click(); await item(en('menu.joinSpace', { name: 'Gamma' })).click(); await delay(400); }
  await visit('join-notice', async () => {}, en('toast.joinedSpace', { arg1: 'Gamma' }));
  await page.keyboard.press('Escape');
  await visit('space-overview-grid', async () => {
    if (!await page.locator('#room-view').isVisible()) await page.getByRole('button', { name: en('sidebar.spaceNav', { name: 'Gamma', count: 2 }), exact: true }).click();
    await page.locator('#room-overview').click();
  });
  await visit('space-overview-list', async () => { await page.getByRole('button', { name: en('collab.list'), exact: true }).click(); });
  await page.getByRole('button', { name: en('collab.grid'), exact: true }).click().catch(() => {});
  await visit('space-records', async () => { await page.locator('#room-record').click(); });
  await visit('space-menu', async () => { await page.getByRole('button', { name: en('sidebar.spaceActions', { name: 'Gamma' }), exact: true }).click(); await page.getByRole('menu').waitFor(); });
  await closeMenus();
  await visit('space-notes', async () => { await page.locator('#room-notes').click(); await page.locator('#notes-dialog').waitFor(); });
  await page.locator('#cancel-notes').click().catch(() => {});
  await visit('space-files', async () => { await page.locator('#room-files').click(); await page.locator('#space-files-dialog').waitFor(); });
  await page.locator('#close-space-files').click().catch(() => {});
  await visit('privacy-usage', async () => { await page.locator('#privacy-button').click(); await page.locator('#privacy-dialog').waitFor(); });
  await page.locator('#close-privacy').click().catch(() => {});
  await visit('settings', async () => { await page.locator('#setup-button').click(); await page.locator('#setup-dialog').waitFor(); });
  await page.keyboard.press('Escape'); await page.locator('#setup-dialog').waitFor({ state: 'hidden' }).catch(() => {});
  await visit('panorama', async () => { await page.locator('#panorama-nav').click(); });
  await visit('terminal-menu', async () => { await page.locator(`[data-session-id="${alpha}"]`).first().click(); await page.locator('#terminal-tab').click(); await page.locator('#terminal-more').click(); await page.getByRole('menu').waitFor(); });
  await closeMenus();
  await page.locator('#chat-tab').click().catch(() => {});
  await visit('permission', async () => { await fixture('native-permission', alpha, { kind: 'command', command: 'ls', reason: 'fixture' }); }, en('approval.needed'));
  await fixture('native-permission', alpha, null).catch(() => {});
  await visit('chat-unavailable', async () => { await fixture('unavailable', alpha); }, { placeholder: en('composer.preservedDraft') });
  await fixture('available', alpha).catch(() => {}); await delay(400);
  await visit('connection-closed', async () => { await fixture('native-version', alpha, { version: '0.165.0', closed: true }); }, en('collab.connectionUnknown'));
  await fixture('native-version', alpha, { version: '0.165.0', closed: false }).catch(() => {}); await delay(400);
  await visit('session-error', async () => { await fixture('set-state', alpha, 'error'); }, en('state.error'));
  await fixture('set-state', alpha, 'idle').catch(() => {}); await delay(400);
  await visit('rename-error', async () => { await more(beta).first().click(); await item(en('menu.rename')).click(); await page.locator('#rename-name').fill('   '); await page.locator('#confirm-rename').click(); await page.locator('#rename-error').waitFor();
    assert.ok([en('error.labels.nameRequired'), en('error.labels.nameEmpty')].includes((await page.locator('#rename-error').innerText()).trim()), 'The empty-name error is shown in English'); });
  await page.keyboard.press('Escape');
  await visit('archive', async () => { await more(beta).first().click(); await item(en('menu.archiveSession')).click(); await delay(300); await page.locator('#archive-button').click(); });
}
let result, report;
setupDone = true;
const cleanup = testScratch.cleanup(async () => {
  if (app) await app.close();
  if (child.connected) child.disconnect(); if (child.exitCode === null) child.kill('SIGTERM');
});
let timer;
Promise.race([run(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Bounded walkthrough exceeded 300 seconds')), 300000); })])
  .then(() => { result = { ok: true }; }, error => { result = { ok: false, error: String(error.stack || error) }; console.error(error.stack || error); process.exitCode = 1; })
  // Cleanup runs on every path (the finally below); the slot is released only after it confirms the profile and processes are gone.
  .finally(async () => {
    try {
      const counts = new Map();
      for (const { name, hits } of pages) for (const hit of hits) { const key = `${hit.kind}\t${hit.text}`; const entry = counts.get(key) || { ...hit, pages: [] }; entry.pages.push(name); counts.set(key, entry); }
      const unique = [...counts.values()];
      const clipboard = app ? await app.evaluate(() => ({ attempts: globalThis.t60ClipboardAttempts })).catch(() => null) : null;
      report = { ...result, pages: pages.map(p => ({ name: p.name, count: p.hits.length })), unique: unique.length, items: unique, unreached: failures, pageErrors: errors, clipboard };
      const unexpected = unique.filter(item => !known.some(rule => matches(rule, item)));
      const unseen = known.filter(rule => !unique.some(item => matches(rule, item)));
      report.unexpected = unexpected; report.unseenKnown = unseen.map(rule => rule.text || String(rule.pattern));
      console.log(`UNIQUE Chinese items: ${unique.length} (unexpected ${unexpected.length}, known ${unique.length - unexpected.length}); pages: ${pages.length}; unreached: ${failures.length}; page errors: ${errors.length}`);
      for (const item of unexpected) console.log(`UNEXPECTED [${item.kind}] ${item.text} @ ${item.where} on ${item.pages.join(', ')}`);
      if (result?.ok && (unexpected.length || unseen.length || failures.length || errors.length || JSON.stringify(clipboard?.attempts) !== JSON.stringify(['readText']))) {
        process.exitCode = 1; console.error('FAIL: unexpected Chinese, a known item no longer seen, an unreached page, a page error or a clipboard call.');
      }
    } finally {
      await cleanup().then(() => {
        clearTimeout(timer); assert.equal(fs.existsSync(profile), false);
        assert.equal(JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))).token, token); fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot);
        console.log('Owned GUI/processes/profile cleaned; canonical slot released.');
      }).catch(error => { clearTimeout(timer); process.exitCode = 1; console.error('Cleanup failed; this finalizer did not release the canonical slot:', error.stack); });
      if (evidence) fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(report || { ...result, report: 'not built' }, null, 2));
    }
  });
