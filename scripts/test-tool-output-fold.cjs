// Hidden source Electron + real Claude receiver; synthetic events only.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto'), { execFileSync } = require('node:child_process');
const scratch = require('./fixtures/test-scratch.cjs'), { createIn } = require('./fixtures/create-view.cjs');
const { createSourceEntry } = require('./fixtures/synthetic-source-boot.cjs');
const root = path.resolve(__dirname, '..'), old = process.env.NAW_TOOL_FOLD_EXPECT_OLD === '1';
const evidence = process.env.NAW_EVIDENCE_DIR, pictures = process.env.NAW_SCREENSHOTS_DIR;
assert.ok(evidence && pictures && path.isAbsolute(evidence) && path.isAbsolute(pictures));
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.resolve(common, '..', '.local/gui-test-slot.lock'), token = randomUUID();
try { fs.mkdirSync(slot); } catch (e) { if (e.code !== 'EEXIST') throw e; console.error('GUI slot occupied; no launch'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Codex F', task: 'tool-output-fold', token, pid: process.pid }));
const profile = scratch.directory(path.join(os.tmpdir(), 'naw-tool-output-fold-'));
const child = scratch.childProcess.fork(path.join(root, 'app/daemon.cjs'), [profile], {
  execArgv: ['--require', path.join(__dirname, 'fixtures/claude-native-images.cjs')],
  env: { ...process.env, NAW_APP_VERSION: require('../package.json').version, NAW_WORKSPACE: path.join(profile, 'work'), NAW_TEST_APP_ROOT: root },
  stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
});
let app, page, seq = 0; const checks = [], errors = [], delay = ms => new Promise(r => setTimeout(r, ms));
const output = Array.from({ length: 300 }, (_, i) => `elem_${i} - synthetic AX element ${i}`).join('\n');
const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
async function until(fn, label) { for (let n = 0; n < 180; n++) { if (await fn()) return; await delay(50); } throw Error(label); }
function fixture(method, target, value) { const id = ++seq; return new Promise((resolve, reject) => {
  const cb = packet => { if (packet.requestId !== id) return; clearTimeout(timer); child.off('message', cb); packet.error ? reject(Error(packet.error)) : resolve(packet); };
  const timer = setTimeout(() => { child.off('message', cb); reject(Error('Synthetic fixture timeout')); }, 10000);
  child.on('message', cb); child.send({ id, method, target, value });
}); }
const check = text => { checks.push(text); console.log('PASS ' + text); };
async function capture(name) { fs.mkdirSync(pictures, { recursive: true }); await page.screenshot({ path: path.join(pictures, name + '.png') }); }
async function run() {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Own service ready');
  const entry = createSourceEntry({ profile, code: root, fixturePid: child.pid });
  app = await scratch.playwright(require('playwright'))._electron.launch({ executablePath: require('electron'), args: [entry],
    env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 60000 });
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#new-session').waitFor();
  await app.evaluate(({ BrowserWindow, clipboard }) => { for (const w of BrowserWindow.getAllWindows()) { w.setTitle('NAW TEST · tool-output-fold'); w.setSize(1280, 900); } globalThis.foldCopies = []; clipboard.writeText = text => globalThis.foldCopies.push(text); });
  await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="claude"]').check();
  await page.locator('#session-name').fill('Synthetic tool output'); await createIn(page, 'chat');
  let session;
  await until(async () => { session = (await page.evaluate(() => workspace.initial())).sessions.find(s => s.name === 'Synthetic tool output'); return session?.state === 'idle'; }, 'Synthetic session');
  const emit = value => fixture('inlineObservation', session.id, value);
  await page.locator(`[data-session-id="${session.id}"]`).click();
  await fixture('state', session.id, 'working');
  const send = (id, extra = {}) => emit({ id: 'tool:' + id, kind: 'tool', turnId: 'synthetic-turn', title: 'mcp__synthetic__see', input: '{}', text: output, status: 'complete', ...extra });
  await send('unsupported', { incomplete: true });
  const row = id => page.locator(`#messages [data-message-id="native:${session.nativeId}:tool:${id}"]`);
  const missing = row('unsupported'); await missing.waitFor();
  assert.equal(await missing.locator('.message-body').textContent(), output);
  assert.equal(await missing.locator('details').evaluate(el => el.open), old);
  await missing.scrollIntoViewIfNeeded(); await capture(old ? 'before-incomplete-open' : 'after-incomplete-folded');
  check(old ? 'Original incomplete multi-content log reproduces default-open failure' : 'Working turn incomplete multi-content log stays folded');
  if (!old) {
    assert.match(await missing.locator('.process-more').innerText(), /298/); await missing.locator('.process-more').click();
    assert.equal(await missing.locator('.message-body').innerText(), output); await capture('after-expanded-full-text');
    await missing.hover(); await missing.getByRole('button', { name: /^复制：/ }).click();
    await until(async () => await app.evaluate(() => globalThis.foldCopies.length) === 1, 'Exact text copy completed');
    assert.equal(await app.evaluate(() => globalThis.foldCopies.at(-1)), output);
    await missing.locator('summary').click(); check('Open exposes all 300 lines; Copy retains exact full text and collapse works');
  }
  await send('late-image', { status: 'running' });
  const media = row('late-image'); await media.waitFor(); const body = await media.locator('.message-body').elementHandle();
  await send('late-image', { imageCount: 1 });
  await emit({ id: 'tool:late-image', kind: 'tool', status: 'complete', mediaOnly: true, imagePayload: { index: 0, mime: 'image/png', data: pixel } });
  await until(async () => await media.locator('.native-image img').count() === 1 && await media.locator('.native-image img').evaluate(el => el.complete), 'Independent image preview loaded');
  assert.equal(await media.locator('details.process-details').count(), old ? 0 : 1);
  assert.equal(await body.evaluate(el => el.isConnected), true);
  assert.equal(await media.locator('.native-image').evaluate(el => Boolean(el.closest('details.process-details'))), false);
  await media.scrollIntoViewIfNeeded(); await capture(old ? 'before-image-unwrapped' : 'after-image-and-folded-log');
  check(old ? 'Original late image removes the log disclosure' : 'Late image preserves folded text and independently visible image controls');
  if (!old) {
    assert.equal(await media.locator('details').evaluate(el => el.open), false);
    await media.locator('.native-image-toggle').click(); assert.equal(await media.locator('.native-image-toggle').getAttribute('aria-expanded'), 'true');
    await page.keyboard.press('Escape'); assert.equal(await media.locator('.native-image-toggle').getAttribute('aria-expanded'), 'false');
    await media.locator('.process-more').click(); await fixture('state', session.id, 'idle');
    await page.reload(); await page.locator('#new-session').waitFor(); await page.locator(`[data-session-id="${session.id}"]`).click();
    assert.equal(await row('late-image').locator('details').evaluate(el => el.open), true);
    assert.equal(await missing.locator('details').evaluate(el => el.open), false); check('Image expand/Escape and separate text folds persist after turn completion and reload');
  }
  assert.deepEqual(errors, []); const stats = (await fixture('stats')).stats; assert.equal(stats.sends, 0); assert.equal(stats.inputs, 0);
  fs.writeFileSync(path.join(profile, 'tool-output-fold-result.json'), JSON.stringify({ checks, errors, stats, old, providerProcesses: 0, modelCalls: 0 }, null, 2));
}
run().catch(async e => { console.error(e.stack); process.exitCode = 1; if (page && !page.isClosed()) await capture('failure').catch(() => {}); }).finally(async () => {
  try { await scratch.release(); assert.equal(JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))).token, token); fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot);
    fs.writeFileSync(path.join(evidence, 'released.json'), JSON.stringify({ profile, ownProcessesAndProfilesGone: true, token, checks: checks.length, failures: process.exitCode ? 1 : 0 }));
  } catch (e) { console.error('Owned cleanup unconfirmed: ' + e.message); process.exitCode = 1; }
});
