// Complete owned source GUI/service task using real reducers and native pixels.
// Synthetic native event source; clipboard captured, no provider/model/daily app.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const scratch = require('./fixtures/test-scratch.cjs'), { createIn } = require('./fixtures/create-view.cjs');
const { chooseRecipient, fillRoomMessage, roomBody } = require('./room-input.cjs');
const { _electron } = scratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
if (process.env.NAW_EVIDENCE_DIR) {
  const target = path.resolve(process.env.NAW_EVIDENCE_DIR); let existing = target;
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  const destination = path.join(fs.realpathSync(existing), path.relative(existing, target));
  for (const base of [root, code].map(value => fs.realpathSync(value))) assert.ok(destination !== base && !destination.startsWith(base + path.sep));
}
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID();
try { fs.mkdirSync(slot); } catch (error) { if (error.code !== 'EEXIST') throw error; console.error('GUI slot occupied; no app launched.'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Codex 3', task: 'T78 Claude native pixels', token, pid: process.pid, at: new Date().toISOString() }));
const profile = scratch.directory(path.join(os.tmpdir(), 'naw-claude-image-gui-'));
const child = scratch.childProcess.fork(path.join(code, 'app/daemon.cjs'), [profile], { execArgv: ['--require', path.join(__dirname, 'fixtures/claude-native-images.cjs')],
  env: { ...process.env, NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_WORKSPACE: path.join(profile, 'workspace'), NAW_TEST_APP_ROOT: code }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
let app, page, sequence = 0; const checks = [], errors = [], delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function fixture(method, target, value) { const id = ++sequence; return new Promise((resolve, reject) => {
  const callback = packet => { if (packet.requestId === id) { clearTimeout(timer); child.off('message', callback); packet.error ? reject(Error(packet.error)) : resolve(packet); } };
  const timer = setTimeout(() => { child.off('message', callback); reject(Error('Fixture timeout')); }, 10000);
  child.on('message', callback); child.send({ id, method, target, value });
}); }
async function until(fn, label) { for (let n = 0; n < 160; n++) { if (await fn()) return; await delay(50); } throw Error(label); }
const snapshot = () => page.evaluate(() => workspace.initial());
const emit = (id, value) => fixture('inlineObservation', id, value);
const image = (id, source, kind, payload) => emit(id, { id: source, kind, status: 'complete', mediaOnly: true, imagePayload: payload });
const check = text => { checks.push(text); console.log('PASS:', text); };
const identity = state => state.sessions.map(s => [s.id, s.nativeId, s.owner, s.model]).sort();
async function capture(name) { if (process.env.NAW_SCREENSHOTS_DIR) { fs.mkdirSync(process.env.NAW_SCREENSHOTS_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.NAW_SCREENSHOTS_DIR, name + '.png') }); } }
async function create(name) {
  await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="claude"]').check();
  await page.locator('#session-name').fill(name); await createIn(page, 'chat');
  await until(async () => (await snapshot()).sessions.some(s => s.name === name && s.state === 'idle'), 'Synthetic Claude ready');
  const id = (await snapshot()).sessions.find(s => s.name === name).id;
  await page.locator('#session-header-more').click(); await page.getByRole('menuitem', { name: '加入协作', exact: true }).click(); return id;
}
async function tool(id, source, turn, text = '') {
  await emit(id, { id: source, kind: 'tool', title: 'Read', input: '{"file_path":"/requested-before-permission.png"}', turnId: turn, text: '', status: 'running' });
  await emit(id, { id: source, kind: 'tool', title: 'Read', turnId: turn, text, status: 'complete' });
}
async function run() {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Own daemon ready');
  app = await _electron.launch({ executablePath: require('electron'), args: [code], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message)); await page.locator('#new-session').waitFor();
  const workspaceRoot = (await snapshot()).newWorkspaceRoot;
  assert.equal(typeof workspaceRoot, 'string');
  assert.equal(fs.realpathSync(path.dirname(workspaceRoot)), fs.realpathSync(profile), 'New session root must stay strictly inside the owned profile');
  const pixels = await app.evaluate(({ nativeImage, clipboard }) => {
    const crypto = process.getBuiltinModule('node:crypto'), hash = image => crypto.createHash('sha256').update(image.toBitmap()).digest('hex');
    globalThis.nativeImageCopies = []; globalThis.nativeTextCopies = [];
    clipboard.writeImage = image => globalThis.nativeImageCopies.push({ size: image.getSize(), hash: hash(image) }); clipboard.writeText = text => globalThis.nativeTextCopies.push(text);
    return [30, 190].map(seed => { const buffer = Buffer.alloc(640 * 360 * 4); for (let i = 0; i < buffer.length; i += 4) { buffer[i] = seed; buffer[i + 1] = i % 256; buffer[i + 2] = 240 - seed; buffer[i + 3] = 255; }
      const image = nativeImage.createFromBitmap(buffer, { width: 640, height: 360, scaleFactor: 1 }); return { data: image.toPNG().toString('base64'), hash: hash(image) }; });
  });
  const a = await create('Claude Image A'), b = await create('Claude Image B'), c = await create('Claude Image C'), originalIdentity = identity(await snapshot());
  for (const session of (await snapshot()).sessions) assert.ok(fs.realpathSync(session.cwd).startsWith(fs.realpathSync(profile) + path.sep));
  await page.locator(`[data-session-id="${a}"]`).click(); await page.locator('#message-input').fill('UNSENT_NATIVE_IMAGE_PRIVATE_DRAFT');
  await until(async () => (await snapshot()).sessions.find(s => s.id === a).liveDraft === 'UNSENT_NATIVE_IMAGE_PRIVATE_DRAFT', 'Private draft stored');
  const nativeId = (await snapshot()).sessions.find(s => s.id === a).nativeId, sourcePath = path.join(profile, 'native-original.png');
  fs.writeFileSync(sourcePath, Buffer.from(pixels[1].data, 'base64')); // Later private file B; accepted pixels remain A.
  await tool(a, 'tool:read-original', 'read-turn', 'ORIGINAL_NATIVE_READ_TEXT');
  const row = page.locator(`#messages [data-message-id="native:${nativeId}:tool:read-original"]`);
  await row.waitFor(); await until(async () => (await row.locator('.message-body').textContent()) === 'ORIGINAL_NATIVE_READ_TEXT', 'Original tool rendered before selection');
  const disclosure = row.locator('details'); assert.equal(await disclosure.count(), 1);
  if (!(await disclosure.evaluate(el => el.open))) await disclosure.locator(':scope > summary').click();
  const body = row.locator('.message-body'), handle = await body.elementHandle();
  const selected = await body.evaluate(el => { const range = document.createRange(); range.selectNodeContents(el); getSelection().removeAllRanges(); getSelection().addRange(range); return getSelection().toString(); });
  await image(a, 'tool:read-original', 'tool', { index: 0, mime: 'image/png', data: pixels[0].data, sourcePath });
  const widget = row.locator('.native-image'); await until(async () => await widget.locator('img').count() && await widget.locator('img').evaluate(el => el.complete && el.naturalWidth === 256), 'Native image thumb');
  assert.equal(await page.evaluate(() => getSelection().toString()), selected); assert.equal(await handle.evaluate(el => el.isConnected), true);
  assert.equal(await row.evaluate(el => el.classList.contains('process')), false);
  assert.equal(await row.locator('.message-body').textContent(), 'ORIGINAL_NATIVE_READ_TEXT');
  await widget.getByRole('button', { name: '复制图片（Claude Image A）native-original.png', exact: true }).click();
  assert.deepEqual(await app.evaluate(() => globalThis.nativeImageCopies.at(-1)), { size: { width: 640, height: 360 }, hash: pixels[0].hash });
  assert.notEqual(pixels[0].hash, pixels[1].hash);
  await widget.getByRole('button', { name: '查看图片（Claude Image A）native-original.png', exact: true }).click();
  await until(async () => await widget.locator('img').evaluate(el => el.naturalWidth === 640), 'Native pixels expanded'); await capture('01-original-native-pixels');
  await page.keyboard.press('Escape'); assert.equal(await widget.locator('.native-image-toggle').getAttribute('aria-expanded'), 'false');
  await row.hover();
  console.log('Original row action evidence:', JSON.stringify(await row.evaluate(el => [...el.querySelectorAll('.message-actions button')].map(button => ({ text: button.textContent, hidden: button.hidden, parent: button.parentElement.className })))));
  assert.equal(await row.getByRole('button', { name: '复制文字', exact: true }).isVisible(), true);
  await row.getByRole('button', { name: '复制文字', exact: true }).click();
  assert.equal(await app.evaluate(() => globalThis.nativeTextCopies.at(-1)), 'ORIGINAL_NATIVE_READ_TEXT');
  check('Accepted native pixels A are previewed/copied despite source file B; late media preserves selected original text and body identity, with in-place expand/Esc and exact text copy');
  const input = 'prompt:' + randomUUID(); await emit(a, { id: input, kind: 'input', inputMode: 'native-prompt', text: 'ORIGINAL_NATIVE_IMAGE_INPUT', status: 'complete' });
  const revision = (await snapshot()).sessions.find(s => s.id === a).controlRevision;
  await image(a, input, 'input', { index: 0, mime: 'image/png', data: pixels[1].data });
  await image(a, input, 'input', { index: 0, mime: 'image/png', data: pixels[1].data });
  const user = page.locator(`#messages [data-message-id="native:${nativeId}:${input}"] .native-image`);
  await until(async () => await user.locator('img').count() && await user.locator('img').evaluate(el => el.complete), 'Accepted image-only source without path');
  await user.getByRole('button', { name: '复制图片（Claude Image A）原生图片 1', exact: true }).click(); assert.equal((await app.evaluate(() => globalThis.nativeImageCopies.at(-1))).hash, pixels[1].hash);
  const state = await snapshot(), record = state.sessions.find(s => s.id === a);
  assert.equal(record.messages.filter(m => m.id.endsWith(input)).length, 1); assert.equal(record.controlRevision, revision);
  assert.ok(!JSON.stringify(state).includes(pixels[0].data)); assert.ok(!JSON.stringify(state).includes(pixels[1].data));
  check('Native input media without a local path keeps its original accepted UUID and pixels; replay neither repeats human control nor stores base64 in history/state');
  await fixture('bindSends', a); await page.locator('#room-nav').click(); await chooseRecipient(page, a); await fillRoomMessage(page, 'EXPLICIT_NATIVE_IMAGE_SHARED_TASK'); await page.locator('#forward-button').click();
  await until(async () => (await fixture('stats', a)).lastSend?.text === 'EXPLICIT_NATIVE_IMAGE_SHARED_TASK', 'One explicit synthetic shared task'); const send = (await fixture('stats', a)).lastSend;
  await emit(a, { id: 'control:turn-start', kind: 'control', turnId: send.turnId, promptId: send.promptId, status: 'running' });
  await tool(a, 'tool:shared-image', send.turnId);
  await image(a, 'tool:shared-image', 'tool', { index: 0, mime: 'image/png', data: pixels[0].data, sourcePath });
  await fillRoomMessage(page, 'UNSENT_NATIVE_IMAGE_ROOM_DRAFT'); await page.locator('#room-record').click();
  await until(async () => (await snapshot()).room.messages.some(m => m.nativeMessageId?.endsWith('tool:shared-image') && m.images?.length), 'Shared original image ref');
  const shared = (await snapshot()).room.messages.find(m => m.nativeMessageId?.endsWith('tool:shared-image'));
  const sharedWidget = page.locator(`#room-messages [data-message-id="${shared.id}"] .native-image`);
  await until(async () => await sharedWidget.locator('img').count() && await sharedWidget.locator('img').evaluate(el => el.complete), 'Shared record actual image');
  await sharedWidget.locator('.native-image-copy').click(); assert.equal((await app.evaluate(() => globalThis.nativeImageCopies.at(-1))).hash, pixels[0].hash);
  await emit(a, { id: 'control:input', kind: 'control', status: 'complete' }); await tool(a, 'tool:private-after-input', send.turnId);
  await image(a, 'tool:private-after-input', 'tool', { index: 0, mime: 'image/png', data: pixels[1].data });
  assert.ok(!(await snapshot()).room.messages.some(m => m.nativeMessageId?.endsWith('tool:private-after-input'))); assert.equal(await roomBody(page), 'UNSENT_NATIVE_IMAGE_ROOM_DRAFT');
  await page.locator('#room-overview').click(); await capture('02-native-images-three-members');
  for (const name of ['Claude Image A', 'Claude Image B', 'Claude Image C']) assert.equal(await page.getByRole('button', { name: `放大 ${name} 的会话`, exact: true }).isVisible(), true);
  check('Actual shared-record image copies its own accepted pixels; human input closes the old grant and later private media stays private, preserving room draft and all member identities');
  await page.locator(`[data-session-id="${a}"]`).click(); await page.reload(); await page.locator('#new-session').waitFor(); await page.locator(`[data-session-id="${a}"]`).click();
  const reloaded = page.locator(`#messages [data-message-id="native:${nativeId}:tool:read-original"] .native-image`);
  await until(async () => await reloaded.locator('img').count() && await reloaded.locator('img').evaluate(el => el.complete), 'Cached image survives reload');
  await reloaded.locator('.native-image-copy').click(); assert.equal((await app.evaluate(() => globalThis.nativeImageCopies.at(-1))).hash, pixels[0].hash);
  assert.deepEqual(identity(await snapshot()), originalIdentity); assert.equal(await page.locator('#message-input').inputValue(), 'UNSENT_NATIVE_IMAGE_PRIVATE_DRAFT');
  const blob = (await snapshot()).sessions.find(s => s.id === a).messages.find(m => m.id.endsWith('tool:read-original')).images[0].cachedPath;
  assert.ok(fs.realpathSync(blob).startsWith(fs.realpathSync(profile) + path.sep)); fs.unlinkSync(blob);
  await page.reload(); await page.locator('#new-session').waitFor(); await page.locator(`[data-session-id="${a}"]`).click();
  const lost = page.locator(`#messages [data-message-id="native:${nativeId}:tool:read-original"] .native-image`);
  await until(async () => (await lost.innerText()).includes('图片不可用'), 'Lost blob shown honestly');
  assert.equal(await lost.locator('.native-image-caption').innerText(), sourcePath); assert.equal(await lost.locator('.native-image-copy').isDisabled(), true);
  assert.equal(await lost.locator('img').count(), 0); await capture('03-lost-cache-no-private-fallback');
  check('Reload retains accepted pixels, native identities and private draft; a missing cache reports original path/unavailable and never falls back to the private replacement file');
  await tool(a, 'tool:bad-media', 'bad-media-turn', 'ORIGINAL_BAD_MEDIA_TEXT'); await image(a, 'tool:bad-media', 'tool', { index: 0, mime: 'image/png', data: 'AAA' });
  const bad = page.locator(`#messages [data-message-id="native:${nativeId}:tool:bad-media"]`);
  await until(async () => (await bad.innerText()).includes('图片不可用'), 'Corrupt accepted bytes unavailable'); assert.equal(await bad.locator('.message-body').textContent(), 'ORIGINAL_BAD_MEDIA_TEXT');
  assert.deepEqual(errors, []); const stats = (await fixture('stats')).stats; assert.equal(stats.sends, 1); assert.equal(stats.inputs, 0);
  check('Corrupt image data preserves the exact original native result and shows failure with no native send/input or model side effect');
  await emit(a, { id: 'tool:partial-media', kind: 'tool', title: 'Read', text: 'ORIGINAL_PARTIAL_IMAGE_TEXT', status: 'complete', imageCount: 2 });
  await image(a, 'tool:partial-media', 'tool', { index: 0, mime: 'image/png', data: pixels[1].data });
  await page.reload(); await page.locator('#new-session').waitFor(); await page.locator(`[data-session-id="${a}"]`).click();
  const partial = page.locator(`#messages [data-message-id="native:${nativeId}:tool:partial-media"]`);
  await partial.scrollIntoViewIfNeeded();
  await until(async () => await partial.locator('.native-image').count() === 2 && (await partial.locator('.native-image').nth(1).innerText()).includes('图片尚未完整同步'), 'Missing later media remains explicit after reload');
  assert.equal(await partial.locator('.native-image').nth(1).locator('.native-image-copy').isDisabled(), true);
  assert.equal(await partial.locator('.message-body').textContent(), 'ORIGINAL_PARTIAL_IMAGE_TEXT');
  assert.deepEqual(identity(await snapshot()), originalIdentity); assert.equal(await page.locator('#message-input').inputValue(), 'UNSENT_NATIVE_IMAGE_PRIVATE_DRAFT');
  await capture('04-partially-delivered-media-stays-visible');
  check('The original accepted image count survives missing later frames and reload as explicit unavailable slots, preserving original text, IDs and private draft');
  const result = { checks, errors, stats, productModelCalls: 0, realProviderProcesses: 0,
    limits: 'Source GUI/service with actual receiver and synthetic accepted events; native producer SDK separately mocked, no installed/physical clipboard/native runtime image qualification.' };
  fs.writeFileSync(path.join(profile, 'claude-image-result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
}
run().catch(async error => { console.error(error.stack); process.exitCode = 1; if (page && !page.isClosed()) await capture('failure').catch(() => {}); }).finally(async () => {
  try { await scratch.release(); assert.equal(JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))).token, token); fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot);
    if (process.env.NAW_EVIDENCE_DIR) fs.writeFileSync(path.join(process.env.NAW_EVIDENCE_DIR, 'released.json'), JSON.stringify({ owner: 'Codex 3', task: 'T78 Claude', token, profile, ownedProfilesAndProcessesGone: true, at: new Date().toISOString() }, null, 2));
    console.log('Owned fixture cleaned; canonical GUI slot released.');
  } catch (error) { console.error('Cleanup unconfirmed; own token retained:', error.message); process.exitCode = 1; }
});
