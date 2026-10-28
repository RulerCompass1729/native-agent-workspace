const testScratch = require('./fixtures/test-scratch.cjs');
const { createIn } = require('./fixtures/create-view.cjs');
// Actual hidden Electron/DSH and the existing trusted copy IPC. Intercept its
// writer only in this owned process: all system clipboard formats stay intact.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { fork } = testScratch.childProcess, { _electron } = testScratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const { connect } = require(path.join(code, 'app/service-client.cjs'));
const profile = testScratch.directory(path.join(os.tmpdir(), 'naw-markdown-copy-'));
const checks = [], errors = [], delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let app, page, client, sequence = 0;
const token = 'lane/codex3-' + 'continuous-token-'.repeat(12);
const command = `git -C /tmp/synthetic-code-copy merge --ff-only ${token}`;
const snippet = '\tconst greeting = "你好";\n\n  console.log(greeting);\n';
const markdown = ['Original command', '', '```', command, '```', '', '```js', snippet, '```'].join('\n');
// A previously saved shared reply exercises the shared reader without sending
// a setup task or publishing the newly created session's private history.
fs.writeFileSync(path.join(profile, 'workspace.json'), JSON.stringify({ sessions: [], room: { messages: [{ id: 'shared-copy-fixture', role: 'assistant', sessionId: 'departed-fixture', name: '合成历史成员', time: Date.now(), status: 'complete', text: markdown }] } }), { mode: 0o600 });
const child = fork(path.join(code, 'app/daemon.cjs'), [profile], { execArgv: ['--require', path.join(__dirname, 'fixtures/loading-terminal.cjs')], env: { ...process.env, NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_TEST_APP_ROOT: code, NAW_WORKSPACE: profile }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
async function until(fn, label) { for (let i = 0; i < 160; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
function fixture(method = 'stats', target, value) { const id = ++sequence; return new Promise((resolve, reject) => {
  const cb = result => { if (result.requestId === id) { clearTimeout(timer); child.off('message', cb); resolve(result); } };
  const timer = setTimeout(() => { child.off('message', cb); reject(Error('Fixture timeout')); }, 8000);
  child.on('message', cb); child.send({ id, method, target, value });
}); }
const snapshot = () => page.evaluate(() => workspace.initial());
const blocks = () => page.locator('#messages [data-message-id="copy-fixture"] .md-code-block');
const copyButton = index => blocks().nth(index).locator('[data-code-block-banner]').getByRole('button', { name: '复制', exact: true });
const count = () => app.evaluate(() => globalThis.codeCopyCalls);
// Compare only the synthetic payload reaching the existing main-process writer.
const clipboardMatches = expected => app.evaluate((_electron, value) => globalThis.codeCopyValues.at(-1) === value, expected);
async function dismissToast() { if (await page.locator('#toast').isVisible()) await page.locator('#toast-close').click(); }
async function capture(name) { if (process.env.NAW_EVIDENCE_DIR) { fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true, mode: 0o700 }); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, name + '.png') }); } }
async function run() {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Service ready'); client = await connect(profile, 'code-copy-observer');
  app = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message)); await page.locator('#new-session').waitFor();
  await app.evaluate(({ clipboard }) => {
    globalThis.originalCodeCopy = clipboard.writeText.bind(clipboard); globalThis.codeCopyCalls = 0; globalThis.codeCopyValues = [];
    globalThis.holdCodeCopy = true; globalThis.failCodeCopy = false;
    clipboard.writeText = text => {
      globalThis.codeCopyCalls++;
      if (globalThis.failCodeCopy) throw Error('Synthetic clipboard write refused');
      if (globalThis.holdCodeCopy) return new Promise(resolve => { globalThis.releaseCodeCopy = () => { globalThis.codeCopyValues.push(text); resolve(); }; });
      globalThis.codeCopyValues.push(text);
    };
  });
  // Reproduce the denied browser clipboard boundary deterministically. The
  // product must use its existing native IPC instead of asking for permission.
  await page.evaluate(() => { window.browserCodeCopyCalls = 0; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => { window.browserCodeCopyCalls++; return Promise.reject(new DOMException('Synthetic browser clipboard denied', 'NotAllowedError')); } } }); });
  await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="codex"]').check(); await page.locator('#session-name').fill('代码阅读与复制'); await createIn(page, 'chat');
  const id = (await snapshot()).sessions[0].id;
  await page.locator('#message-input').fill('私人草稿仍然保留，不发送');
  await until(async () => (await snapshot()).sessions[0].liveDraft === '私人草稿仍然保留，不发送', 'Draft saved');
  const stable = s => [s.id, s.nativeId, s.pid, s.owner, s.liveDraft], original = stable((await snapshot()).sessions[0]);
  await fixture('history', id, [{ id: 'copy-fixture', type: 'agentMessage', text: markdown }]);
  await until(async () => await blocks().count() === 2, 'Both native Markdown code blocks');
  assert.equal(await blocks().nth(0).locator('pre').textContent(), command);
  assert.equal(await blocks().nth(1).locator('pre').textContent(), snippet);
  await dismissToast(); await copyButton(0).click();
  await until(async () => await count() === 1, 'Native clipboard handler invoked');
  assert.equal(await copyButton(0).getAttribute('aria-busy'), 'true');
  assert.equal(await page.locator('#toast').isVisible(), false, 'No copied feedback before native acknowledgement');
  await copyButton(0).focus(); await page.keyboard.press('Enter'); await delay(100); assert.equal(await count(), 1, 'Pending click cannot issue a second copy');
  await app.evaluate(() => { globalThis.holdCodeCopy = false; globalThis.releaseCodeCopy(); });
  await until(async () => (await page.locator('#toast-text').innerText()) === '已复制' && await clipboardMatches(command), 'Exact native copy IPC payload and acknowledged feedback');
  assert.equal(await page.evaluate(() => window.browserCodeCopyCalls), 0);
  assert.equal(await copyButton(0).evaluate(el => el === document.activeElement), true);
  checks.push('Mouse and keyboard reach the existing native copy writer once, bypass denied browser clipboard, and report success only after acknowledgement');

  await dismissToast(); await app.evaluate(() => { globalThis.failCodeCopy = true; });
  await copyButton(1).focus(); await page.keyboard.press('Space');
  await until(async () => (await page.locator('#toast-text').innerText()) === '复制失败，请重试。', 'Visible clipboard failure');
  assert.equal(await clipboardMatches(command), true, 'Failed write retains the previous synthetic fixture');
  await app.evaluate(() => { globalThis.failCodeCopy = false; }); await copyButton(1).press('Enter');
  await until(async () => await clipboardMatches(snippet) && (await page.locator('#toast-text').innerText()) === '已复制', 'Explicit retry copies exact Unicode/tab/newline source');
  assert.deepEqual(stable((await snapshot()).sessions[0]), original);
  checks.push('Failure is truthful and retryable; successful native copy payload preserves Unicode, tabs and blank/trailing lines without Markdown fences or identity/draft changes');

  const win = await app.browserWindow(page); await win.evaluate(w => w.setSize(850, 600)); await delay(200);
  const layout = await blocks().nth(0).evaluate((block, token) => {
    const pre = block.querySelector('pre'), button = block.querySelector('[data-code-block-banner] button');
    const b = block.getBoundingClientRect(), p = pre.getBoundingClientRect(), c = button.getBoundingClientRect(), style = getComputedStyle(pre);
    const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT); let text;
    while ((text = walker.nextNode()) && !text.textContent.includes(token)) {}
    if (!text) throw Error('Original token missing');
    const range = document.createRange(), start = text.textContent.indexOf(token); range.setStart(text, start); range.setEnd(text, start + token.length);
    const tops = [...range.getClientRects()].map(r => r.top);
    return { preTop: p.top - b.top, buttonTop: c.top - b.top, buttonRight: c.right <= b.right + 1, scrollWidth: pre.scrollWidth, clientWidth: pre.clientWidth, whiteSpace: style.whiteSpace, wordBreak: style.wordBreak, tokenTopSpread: Math.max(...tops) - Math.min(...tops) };
  }, token);
  assert.ok(layout.preTop < 3 && layout.buttonTop < 20 && layout.buttonRight, 'Copy sits at code corner, with no separate blank banner row');
  assert.equal(layout.whiteSpace, 'pre'); assert.equal(layout.wordBreak, 'normal'); assert.ok(layout.scrollWidth > layout.clientWidth); assert.ok(layout.tokenTopSpread < 1, 'Long command token is not split across display lines');
  const pre = blocks().nth(0).locator('pre'); await pre.hover(); await page.mouse.wheel(320, 0);
  await until(() => pre.evaluate(el => el.scrollLeft > 0), 'Real horizontal wheel exposes long command');
  await capture('compact-code-small');
  checks.push('Small-window code starts beside its copy action, preserves unbroken tokens and supports actual horizontal scrolling');

  await page.getByRole('button', { name: '加入协作', exact: true }).click(); await page.locator('#room-nav').click(); await page.locator('#shared-input').fill('保留的共享草稿');
  const shared = page.locator('#room-messages [data-message-id="shared-copy-fixture"] .md-code-block');
  await until(async () => await shared.count() === 2, 'Saved shared assistant code appears');
  await dismissToast(); await shared.first().getByRole('button', { name: '复制', exact: true }).click(); await until(() => clipboardMatches(command), 'Saved shared code copies through the same native IPC');
  assert.equal(await page.locator('#shared-input').inputValue(), '保留的共享草稿');
  assert.deepEqual(stable((await snapshot()).sessions[0]), original);
  await page.locator(`[data-session-id="${id}"]`).click();
  await page.reload(); await page.locator('#new-session').waitFor(); await until(async () => await blocks().count() === 2, 'Code reopens unchanged');
  assert.deepEqual(stable((await snapshot()).sessions[0]), original);
  assert.equal((await snapshot()).viewState.sharedDraft, '保留的共享草稿');
  const stats = await fixture(); assert.deepEqual(stats.sends, []); assert.deepEqual(stats.inputs, []); assert.deepEqual(stats.interruptions, []); assert.deepEqual(errors, []);
  checks.push('Saved shared code and reload preserve original text, private/shared drafts and native identity; copying dispatches no native task or input');
  console.log(JSON.stringify({ checks, errors, layout, nativeWriterAttempts: await count(), confirmedFixtureCopies: await app.evaluate(() => globalThis.codeCopyValues.length), modelTasks: 0, nativeProcesses: 0, nativeDispatches: 0, systemClipboard: 'all formats/content untouched; validated main copy backend reused', profile, scriptSha256: require('node:crypto').createHash('sha256').update(fs.readFileSync(__filename)).digest('hex') }, null, 2));
}
run().catch(async error => { console.error(error.stack); console.error(JSON.stringify({ partialChecks: checks, errors })); await capture('failed'); process.exitCode = 1; }).finally(testScratch.cleanup(async () => {
  try { if (app) { await app.evaluate(({ clipboard }) => { if (globalThis.originalCodeCopy) clipboard.writeText = globalThis.originalCodeCopy; }); await app.close(); } if (client) { for (const s of (await client.call('initial')).sessions) await client.call('stop', s.id); await client.call('shutdown'); client.close(); } }
  finally { if (child.connected) child.disconnect(); if (child.exitCode === null) child.kill('SIGTERM'); }
}));
