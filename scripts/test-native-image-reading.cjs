// Source Electron, real service/IPC/Codex reducers, synthetic native events.
// Clipboard is captured in the owned process; no OS clipboard/provider/model.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const scratch = require('./fixtures/test-scratch.cjs'), { createIn } = require('./fixtures/create-view.cjs');
const { chooseRecipient, fillRoomMessage, roomBody } = require('./room-input.cjs');
const { _electron } = scratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
if (process.env.NAW_EVIDENCE_DIR) {
  const target = path.resolve(process.env.NAW_EVIDENCE_DIR); let existing = target;
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  const destination = path.join(fs.realpathSync(existing), path.relative(existing, target));
  for (const base of [root, code].map(value => fs.realpathSync(value))) assert.ok(destination !== base && !destination.startsWith(base + path.sep), 'Evidence must be outside source repositories');
}
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID();
try { fs.mkdirSync(slot); } catch (error) { if (error.code !== 'EEXIST') throw error; console.error('GUI slot occupied; no app launched.'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Codex 3', task: 'T78 local image reading', token, pid: process.pid, at: new Date().toISOString() }));
const profile = scratch.directory(path.join(os.tmpdir(), 'naw-native-images-'));
const child = scratch.childProcess.fork(path.join(code, 'app/daemon.cjs'), [profile], {
  execArgv: ['--require', path.join(__dirname, 'fixtures/native-images.cjs')],
  env: { ...process.env, NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_WORKSPACE: profile, NAW_TEST_APP_ROOT: code }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
});
let app, page, sequence = 0; const checks = [], errors = [], delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function fixture(method, target, value) { const id = ++sequence; return new Promise((resolve, reject) => {
  const callback = packet => { if (packet.requestId === id) { clearTimeout(timer); child.off('message', callback); packet.error ? reject(Error(packet.error)) : resolve(packet); } };
  const timer = setTimeout(() => { child.off('message', callback); reject(Error('Fixture timeout')); }, 10000);
  child.on('message', callback); child.send({ id, method, target, value });
}); }
async function until(fn, label) { for (let n = 0; n < 160; n++) { if (await fn()) return; await delay(50); } throw Error(label); }
const snapshot = () => page.evaluate(() => workspace.initial());
const check = text => { checks.push(text); console.log('PASS:', text); };
const emit = (id, method, params, cwd) => fixture('nativeImageEvent', id, { method, params, cwd });
const image = (id, item, cwd, method = 'item/completed') => emit(id, method, { item: { type: 'imageView', ...item } }, cwd);
const identity = state => state.sessions.map(s => [s.id, s.nativeId, s.pid, s.owner, s.model]).sort();
async function capture(name) { if (process.env.NAW_SCREENSHOTS_DIR) { fs.mkdirSync(process.env.NAW_SCREENSHOTS_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.NAW_SCREENSHOTS_DIR, name + '.png') }); } }
async function create(name) {
  await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="codex"]').check();
  await page.locator('#session-name').fill(name); await createIn(page, 'chat');
  await until(async () => (await snapshot()).sessions.some(s => s.name === name && s.state === 'idle'), 'Synthetic session ready');
  const id = (await snapshot()).sessions.find(s => s.name === name).id;
  await page.locator('#session-header-more').click(); await page.getByRole('menuitem', { name: '加入协作', exact: true }).click(); return id;
}
async function run() {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Own daemon ready');
  app = await _electron.launch({ executablePath: require('electron'), args: [code], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message)); await page.locator('#new-session').waitFor();
  const pixels = await app.evaluate(({ nativeImage, clipboard }) => {
    const crypto = process.getBuiltinModule('node:crypto'), hash = image => crypto.createHash('sha256').update(image.toBitmap()).digest('hex');
    globalThis.imageCopies = []; clipboard.writeImage = image => globalThis.imageCopies.push({ size: image.getSize(), hash: hash(image) });
    const make = seed => { const buffer = Buffer.alloc(640 * 360 * 4); for (let i = 0; i < buffer.length; i += 4) { buffer[i] = seed; buffer[i + 1] = i % 256; buffer[i + 2] = 240 - seed; buffer[i + 3] = 255; }
      const image = nativeImage.createFromBitmap(buffer, { width: 640, height: 360, scaleFactor: 1 }), jpeg = image.toJPEG(90);
      return { png: image.toPNG().toString('base64'), hash: hash(image), jpeg: jpeg.toString('base64'), jpegHash: hash(nativeImage.createFromBuffer(jpeg)) }; };
    return [make(30), make(190)];
  });
  const dirs = ['first', 'second'].map(name => path.join(profile, name)); dirs.forEach(dir => fs.mkdirSync(dir));
  dirs.forEach((dir, i) => fs.writeFileSync(path.join(dir, 'same.png'), Buffer.from(pixels[i].png, 'base64')));
  const jpegFile = path.join(dirs[0], 'native-photo.jpg'); fs.writeFileSync(jpegFile, Buffer.from(pixels[0].jpeg, 'base64'));
  const a = await create('Image A'), b = await create('Image B'), c = await create('Image C');
  const originalIdentity = identity(await snapshot());
  await page.locator(`[data-session-id="${a}"]`).click(); await page.locator('#message-input').fill('UNSENT_IMAGE_PRIVATE_DRAFT');
  await until(async () => (await snapshot()).sessions.find(s => s.id === a).liveDraft === 'UNSENT_IMAGE_PRIVATE_DRAFT', 'Private draft stored');
  for (const id of ['before-a', 'before-b']) await emit(a, 'item/completed', { item: { type: 'commandExecution', id, command: 'printf original', aggregatedOutput: `ORIGINAL_${id}`, status: 'completed' } });
  const priorGroup = page.locator('#messages [data-process-group]').first();
  await priorGroup.waitFor();
  if (await priorGroup.locator(':scope > details').evaluate(el => el.open)) await priorGroup.locator(':scope > details > summary').click();
  await image(a, { id: 'first-image', path: 'same.png' }, dirs[0], 'item/started');
  const nativeId = (await snapshot()).sessions.find(s => s.id === a).nativeId;
  const row = page.locator(`#messages [data-message-id="native:${nativeId}:tool:first-image"]`), widget = row.locator('.native-image');
  await widget.getByText('等待原生确认图片', { exact: true }).waitFor(); assert.equal(await widget.locator('img').count(), 0);
  await image(a, { id: 'first-image', path: 'same.png' }, dirs[1]);
  await until(async () => await widget.locator('img').evaluate(el => el.complete && el.naturalWidth === 256), 'Original image thumbnail loaded');
  assert.equal(await row.locator('details').count(), 0); assert.equal(await row.evaluate(el => !!el.parentElement.closest('[data-process-group]')), false);
  assert.equal(await priorGroup.locator(':scope > details').evaluate(el => el.open), false);
  assert.equal(await widget.locator('.native-image-toggle').getAttribute('title').then(value => value.startsWith('same.png')), true);
  await widget.getByRole('button', { name: '复制图片（Image A）same.png', exact: true }).click();
  assert.deepEqual(await app.evaluate(() => globalThis.imageCopies.at(-1)), { size: { width: 640, height: 360 }, hash: pixels[0].hash });
  await widget.getByRole('button', { name: '查看图片（Image A）same.png', exact: true }).click();
  await until(async () => (await widget.locator('img').evaluate(el => el.naturalWidth)) === 640, 'Full image expanded in place');
  await capture('01-inline-image-expanded'); await page.keyboard.press('Escape'); assert.equal(await widget.locator('button').first().getAttribute('aria-expanded'), 'false');
  assert.equal(await widget.locator('button').first().evaluate(el => document.activeElement === el), true);
  check('Only native completion previews; first captured cwd wins across completion, image stays outside tool folds, copy matches original 640x360 pixels, expand/Esc restores focus');
  // Hold the real expansion response after its source validation; Esc wins.
  await app.evaluate((_, code) => {
    const load = process.getBuiltinModule('module').createRequire(code + '/package.json'), { ImagePreviews } = load(code + '/app/native-images.cjs');
    const original = ImagePreviews.prototype.expand;
    ImagePreviews.prototype.expand = async function (token) { const value = await original.call(this, token); ImagePreviews.prototype.expand = original;
      return new Promise(resolve => { globalThis.releaseHeldImageExpand = () => resolve(value); }); };
  }, code);
  await widget.locator('.native-image-toggle').click();
  await until(() => app.evaluate(() => typeof globalThis.releaseHeldImageExpand === 'function'), 'Expansion response held');
  await page.keyboard.press('Escape'); await app.evaluate(() => globalThis.releaseHeldImageExpand());
  await until(async () => await widget.locator('.native-image-toggle').getAttribute('aria-busy') === null, 'Cancelled expansion settled');
  assert.equal(await widget.locator('.native-image-toggle').getAttribute('aria-expanded'), 'false'); assert.equal(await widget.locator('img').evaluate(el => el.naturalWidth), 256);
  // A cold native history item has no status field in the native schema.
  await fixture('history', a, [{ type: 'imageView', id: 'cold-image', path: path.join(dirs[0], 'same.png'), turnId: 'old-history' }]);
  const cold = page.locator(`#messages [data-message-id="native:${nativeId}:tool:cold-image"] .native-image`);
  await until(async () => await cold.locator('img').count() && await cold.locator('img').evaluate(el => el.complete), 'Cold history image decoded');
  await cold.locator('.native-image-copy').click(); assert.equal((await app.evaluate(() => globalThis.imageCopies.at(-1))).hash, pixels[0].hash);
  check('Esc cancels a pending real expansion response; a first native-history image without a status field retains a readable file reference and original pixels');
  await image(a, { id: 'second-image', path: 'same.png' }, dirs[1]);
  const second = page.locator(`#messages [data-message-id="native:${nativeId}:tool:second-image"] .native-image`);
  await second.getByRole('button', { name: '复制图片（Image A）same.png', exact: true }).waitFor();
  await until(async () => await second.locator('img').count() && await second.locator('img').evaluate(el => el.complete), 'Second cwd loaded');
  await second.getByRole('button', { name: '复制图片（Image A）same.png', exact: true }).click(); assert.equal((await app.evaluate(() => globalThis.imageCopies.at(-1))).hash, pixels[1].hash);
  await emit(a, 'item/completed', { item: { type: 'userMessage', id: 'user-image', content: [{ type: 'localImage', path: 'same.png' }] } }, dirs[0]);
  const user = page.locator('#messages [data-message-id="user-image"] .native-image');
  await until(async () => await user.locator('img').count() && await user.locator('img').evaluate(el => el.complete), 'Native image-only user row');
  await user.getByRole('button', { name: '复制图片（Image A）same.png', exact: true }).click(); assert.equal((await app.evaluate(() => globalThis.imageCopies.at(-1))).hash, pixels[0].hash);
  const state = await snapshot(), revision = state.sessions.find(s => s.id === a).controlRevision;
  await emit(a, 'item/completed', { item: { type: 'userMessage', id: 'user-image', content: [{ type: 'localImage', path: 'same.png' }] } }, dirs[0]);
  assert.equal((await snapshot()).sessions.find(s => s.id === a).controlRevision, revision);
  check('Same filenames under two original directories copy distinct pixels; image-only native user input keeps one row and replay does not intervene again');
  await image(a, { id: 'jpeg-image', path: jpegFile }, dirs[0]);
  const jpeg = page.locator(`#messages [data-message-id="native:${nativeId}:tool:jpeg-image"] .native-image`);
  await until(async () => await jpeg.locator('img').count() && await jpeg.locator('img').evaluate(el => el.complete), 'Real JPEG decode accepted after header check');
  await jpeg.locator('.native-image-copy').click(); assert.equal((await app.evaluate(() => globalThis.imageCopies.at(-1))).hash, pixels[0].jpegHash);
  const hugeFile = path.join(dirs[0], 'oversized.png'), huge = Buffer.alloc(33); Buffer.from('89504e470d0a1a0a', 'hex').copy(huge); huge.writeUInt32BE(13, 8); huge.write('IHDR', 12); huge.writeUInt32BE(60000, 16); huge.writeUInt32BE(60000, 20); fs.writeFileSync(hugeFile, huge);
  await app.evaluate(({ nativeImage }) => { const original = nativeImage.createFromBuffer; globalThis.guardDecoderCalls = 0;
    nativeImage.createFromBuffer = (...args) => { globalThis.guardDecoderCalls++; return original.apply(nativeImage, args); };
    globalThis.restoreImageDecoder = () => { nativeImage.createFromBuffer = original; }; });
  await image(a, { id: 'oversized-image', path: hugeFile }, dirs[0]);
  const oversized = page.locator(`#messages [data-message-id="native:${nativeId}:tool:oversized-image"] .native-image`); await oversized.scrollIntoViewIfNeeded();
  await until(async () => (await oversized.innerText()).includes('图片不可用'), 'Oversized header rejected in actual Main path');
  assert.equal(await app.evaluate(() => globalThis.guardDecoderCalls), 0); await app.evaluate(() => globalThis.restoreImageDecoder());
  assert.equal(await oversized.locator('.native-image-copy').isDisabled(), true);
  check('Real PNG/JPEG decode and exact image copy pass; a 33-byte 60000-square header is unavailable before the Main decoder is called');
  // Load failure after native confirmation, not a made-up path from the GUI.
  await page.locator(`[data-session-id="${b}"]`).click();
  const missing = path.join(dirs[0], 'deleted.png'); fs.writeFileSync(missing, Buffer.from(pixels[0].png, 'base64'));
  await image(a, { id: 'deleted-image', path: missing }, dirs[0]); fs.unlinkSync(missing);
  await page.locator(`[data-session-id="${a}"]`).click();
  const unavailable = page.locator(`#messages [data-message-id="native:${nativeId}:tool:deleted-image"] .native-image`);
  await until(async () => (await unavailable.innerText()).includes('图片不可用'), 'Deleted image truthful unavailable');
  assert.equal(await unavailable.locator('.native-image-caption').innerText(), missing); assert.equal(await unavailable.locator('.native-image-copy').isDisabled(), true);
  await emit(a, 'item/completed', { item: { type: 'userMessage', id: 'remote-image', content: [{ type: 'image', url: 'https://example.invalid/private-image' }] } });
  const remote = page.locator('#messages [data-message-id="remote-image"] .native-image'); await remote.getByText('图片不可用', { exact: false }).waitFor();
  assert.equal(await remote.locator('img').count(), 0); assert.ok(!JSON.stringify(await snapshot()).includes('example.invalid'));
  check('Deleted confirmed files show image-unavailable plus exact original path with copy disabled; remote-only native images are never fetched or persisted as URLs');
  await fixture('bindSends', a); await page.locator('#room-nav').click(); await chooseRecipient(page, a); await fillRoomMessage(page, 'PUBLIC_IMAGE_TASK'); await page.locator('#forward-button').click();
  await until(async () => (await fixture('stats', a)).lastSend?.text === 'PUBLIC_IMAGE_TASK', 'One explicit synthetic shared send');
  const send = (await fixture('stats', a)).lastSend;
  await emit(a, 'item/completed', { turnId: send.turnId, item: { type: 'imageView', id: 'shared-image', path: path.join(dirs[1], 'same.png') } }, dirs[1]);
  await fillRoomMessage(page, 'UNSENT_IMAGE_ROOM_DRAFT');
  await until(async () => (await snapshot()).room.messages.some(m => m.toolKind === 'imageView'), 'Original grant shares image references');
  const roomImage = (await snapshot()).room.messages.find(m => m.toolKind === 'imageView');
  await page.evaluate(async source => { const preview = await workspace.previewImage(source); await workspace.copyImage(preview.token); await workspace.releaseImage(preview.token); },
    { kind: 'room', sessionId: a, nativeId, messageId: roomImage.id, index: 0 });
  assert.equal((await app.evaluate(() => globalThis.imageCopies.at(-1))).hash, pixels[1].hash);
  await emit(a, 'item/completed', { turnId: send.turnId, item: { type: 'userMessage', id: 'private-native-input', content: [{ type: 'text', text: 'PRIVATE_BOUNDARY' }] } });
  await emit(a, 'item/completed', { turnId: send.turnId, item: { type: 'imageView', id: 'private-later-image', path: path.join(dirs[0], 'same.png') } });
  assert.ok(!(await snapshot()).room.messages.some(m => m.nativeItemId === 'private-later-image' || m.id.includes('private-later-image')));
  assert.equal(await roomBody(page), 'UNSENT_IMAGE_ROOM_DRAFT');
  const member = page.locator(`.collaboration-member-reader[data-member-id="${a}"] .messages`);
  await member.locator('.native-image').first().waitFor(); await capture('02-images-three-members');
  check('Existing shared grant carries only its original image reference; private human boundary blocks later image sharing while room draft and member readers remain available');
  await page.locator(`[data-session-id="${a}"]`).click();
  const firstAgain = page.locator(`#messages [data-message-id="native:${nativeId}:tool:first-image"] .native-image`);
  await firstAgain.locator('.native-image-toggle').click(); await until(async () => await firstAgain.locator('.native-image-toggle').getAttribute('aria-expanded') === 'true', 'Open state saved');
  await page.reload(); await page.locator('#new-session').waitFor(); await page.locator(`[data-session-id="${a}"]`).click();
  const reloaded = page.locator(`#messages [data-message-id="native:${nativeId}:tool:first-image"] .native-image`);
  await until(async () => await reloaded.locator('img').count() && await reloaded.locator('img').evaluate(el => el.naturalWidth === 640), 'Original in-place open state restored');
  assert.equal(await page.locator('#message-input').inputValue(), 'UNSENT_IMAGE_PRIVATE_DRAFT'); assert.deepEqual(identity(await snapshot()), originalIdentity);
  await reloaded.locator('.native-image-toggle').click(); assert.equal(await reloaded.locator('.native-image-toggle').getAttribute('aria-expanded'), 'false');
  await image(b, { id: 'other-image', path: path.join(dirs[1], 'same.png') }, dirs[1]);
  assert.equal(await reloaded.locator('.native-image-toggle').getAttribute('aria-expanded'), 'false');
  check('Reload restores original image open state, click closes it, another member update does not reopen it, and original native identities and unsent private draft survive');
  await app.evaluate((_, code) => {
    const load = process.getBuiltinModule('module').createRequire(code + '/package.json'), { ImagePreviews } = load(code + '/app/native-images.cjs');
    const original = ImagePreviews.prototype.preview;
    ImagePreviews.prototype.preview = async function (source) {
      const result = await original.call(this, source);
      if (!source.messageId.endsWith(':held-image')) return result;
      globalThis.heldImageStore = this; globalThis.heldImageToken = result.token;
      return new Promise(resolve => { globalThis.releaseHeldImagePreview = () => resolve(result); });
    };
  }, code);
  await image(a, { id: 'held-image', path: path.join(dirs[0], 'same.png') }, dirs[0]);
  await page.locator(`#messages [data-message-id="native:${nativeId}:tool:held-image"] .native-image`).scrollIntoViewIfNeeded();
  await until(() => app.evaluate(() => typeof globalThis.releaseHeldImagePreview === 'function'), 'Preview response held');
  await page.locator(`[data-session-id="${b}"]`).click(); await app.evaluate(() => globalThis.releaseHeldImagePreview());
  await until(() => app.evaluate(() => !globalThis.heldImageStore.entries.has(globalThis.heldImageToken)), 'Late token released after changing original reader');
  assert.equal(await page.locator('#messages [data-message-id$=":held-image"]').count(), 0);
  check('Changing session during a pending preview releases its opaque token and never inserts the old image into the new reader');
  assert.deepEqual(errors, []); const stats = (await fixture('stats')).stats; assert.equal(stats.sends, 1); assert.equal(stats.inputs, 0);
  const result = { checks, errors, stats, productModelCalls: 0, realProviderProcesses: 0,
    limits: 'Source synthetic native event proof only; no installed, physical clipboard, native runtime rendering or Claude image proof.' };
  fs.writeFileSync(path.join(profile, 'native-image-result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
}
run().catch(async error => { console.error(error.stack); process.exitCode = 1; if (page && !page.isClosed()) await capture('failure').catch(() => {}); }).finally(async () => {
  try {
    await scratch.release(); assert.equal(JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))).token, token);
    fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot);
    if (process.env.NAW_EVIDENCE_DIR) fs.writeFileSync(path.join(process.env.NAW_EVIDENCE_DIR, 'released.json'), JSON.stringify({ owner: 'Codex 3', task: 'T78', token, profile, ownedProfilesAndProcessesGone: true, at: new Date().toISOString() }, null, 2));
    console.log('Owned fixture cleaned; canonical GUI slot released.');
  } catch (error) { console.error('Cleanup unconfirmed; own lock retained:', error.message); process.exitCode = 1; }
});
