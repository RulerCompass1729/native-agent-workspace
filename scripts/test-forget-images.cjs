// T-140: 移除本应用记录… removes this app's cached copies of a session's native images, except
// the ones its shared record shows (the removal dialog promises shared content stays); clearing
// that shared record then removes them and the folder. Actual hidden Electron/DSH and service
// with the real Claude receiver; only the native event source is synthetic (0 model).
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const scratch = require('./fixtures/test-scratch.cjs'), { createIn } = require('./fixtures/create-view.cjs');
const { chooseRecipient, fillRoomMessage } = require('./room-input.cjs');
const { _electron } = scratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const evidence = process.env.NAW_EVIDENCE_DIR;
if (evidence) fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID();
try { fs.mkdirSync(slot); } catch (error) { if (error.code !== 'EEXIST') throw error; console.error('GUI slot occupied; no app launched.'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Claude 3', task: 'T-140 removed session images', token, pid: process.pid, at: new Date().toISOString() }));
const profile = scratch.directory(path.join(os.tmpdir(), 'naw-forget-images-'));
const child = scratch.childProcess.fork(path.join(code, 'app/daemon.cjs'), [profile], { execArgv: ['--require', path.join(__dirname, 'fixtures/claude-native-images.cjs')],
  env: { ...process.env, NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_WORKSPACE: path.join(profile, 'workspace'), NAW_TEST_APP_ROOT: code }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
let app, page, sequence = 0, failure = null; const checks = [], errors = [], measurements = [], delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function fixture(method, target, value) { const id = ++sequence; return new Promise((resolve, reject) => {
  const callback = packet => { if (packet.requestId === id) { clearTimeout(timer); child.off('message', callback); packet.error ? reject(Error(packet.error)) : resolve(packet); } };
  const timer = setTimeout(() => { child.off('message', callback); reject(Error('Fixture timeout')); }, 10000);
  child.on('message', callback); child.send({ id, method, target, value });
}); }
async function until(fn, label) { for (let n = 0; n < 160; n++) { if (await fn()) return; await delay(50); } throw Error(label); }
const snapshot = () => page.evaluate(() => workspace.initial());
const emit = (id, value) => fixture('inlineObservation', id, value);
const image = (id, source, payload) => emit(id, { id: source, kind: 'tool', status: 'complete', mediaOnly: true, imagePayload: { index: 0, mime: 'image/png', ...payload } });
const check = text => { checks.push(text); console.log('PASS:', text); };
async function capture(name) { if (evidence) await page.screenshot({ path: path.join(evidence, name + '.png') }); }
async function create(name) {
  await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="claude"]').check();
  await page.locator('#session-name').fill(name); await createIn(page, 'chat');
  await until(async () => (await snapshot()).sessions.some(s => s.name === name && s.state === 'idle'), 'Synthetic Claude ready');
  const id = (await snapshot()).sessions.find(s => s.name === name).id;
  // Joining is 加入此空间 in the session's ⋯ menu; close its 撤销加入 notice as a person would.
  await page.locator('#session-header-more').click(); await page.getByRole('menuitem', { name: '加入此空间', exact: true }).click();
  await page.locator('#toast-text', { hasText: '已加入' }).waitFor(); await page.locator('#toast-close').click(); return id;
}
async function tool(id, source, turn) {
  await emit(id, { id: source, kind: 'tool', title: 'Read', input: '{"file_path":"/shot.png"}', turnId: turn, text: '', status: 'running' });
  await emit(id, { id: source, kind: 'tool', title: 'Read', turnId: turn, text: 'READ_RESULT', status: 'complete' });
}
const cachedFiles = async id => [...new Set((await snapshot()).sessions.find(s => s.id === id).messages.flatMap(m => m.images || []).map(r => r.cachedPath).filter(Boolean))];

async function run() {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Own daemon ready');
  app = await _electron.launch({ executablePath: require('electron'), args: [code], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message)); await page.locator('#new-session').waitFor();
  const pixels = await app.evaluate(({ nativeImage, clipboard }) => {
    const crypto = process.getBuiltinModule('node:crypto'), hash = image => crypto.createHash('sha256').update(image.toBitmap()).digest('hex');
    globalThis.nativeImageCopies = []; clipboard.writeImage = image => globalThis.nativeImageCopies.push({ hash: hash(image) });
    return [30, 190].map(seed => { const buffer = Buffer.alloc(320 * 180 * 4); for (let i = 0; i < buffer.length; i += 4) { buffer[i] = seed; buffer[i + 1] = i % 256; buffer[i + 2] = 240 - seed; buffer[i + 3] = 255; }
      const image = nativeImage.createFromBitmap(buffer, { width: 320, height: 180, scaleFactor: 1 }); return { data: image.toPNG().toString('base64'), hash: hash(image) }; });
  });
  const a = await create('Image A'), b = await create('Image B');
  // A: one private image, and one image that goes to the shared record through an explicit task.
  await tool(a, 'tool:private', 'private-turn'); await image(a, 'tool:private', { data: pixels[1].data });
  await fixture('bindSends', a); await page.locator('#room-nav').click(); await chooseRecipient(page, a); await fillRoomMessage(page, 'EXPLICIT_SHARED_IMAGE_TASK'); await page.locator('#forward-button').click();
  await until(async () => (await fixture('stats', a)).lastSend?.text === 'EXPLICIT_SHARED_IMAGE_TASK', 'One explicit synthetic shared task'); const send = (await fixture('stats', a)).lastSend;
  await emit(a, { id: 'control:turn-start', kind: 'control', turnId: send.turnId, promptId: send.promptId, status: 'running' });
  await tool(a, 'tool:shared-image', send.turnId); await image(a, 'tool:shared-image', { data: pixels[0].data });
  await until(async () => (await snapshot()).room.messages.some(m => m.nativeMessageId?.endsWith('tool:shared-image') && m.images?.[0]?.cachedPath), 'Shared row with its image');
  const shared = (await snapshot()).room.messages.find(m => m.nativeMessageId?.endsWith('tool:shared-image'));
  // B: its own image, which must not be touched.
  await tool(b, 'tool:b-image', 'b-turn'); await image(b, 'tool:b-image', { data: pixels[1].data });
  await until(async () => (await cachedFiles(a)).length === 2 && (await cachedFiles(b)).length === 1, 'Both sessions cached their images');
  const sharedFile = shared.images[0].cachedPath, folder = path.dirname(sharedFile), privateFile = (await cachedFiles(a)).find(f => f !== sharedFile), bFile = (await cachedFiles(b))[0];
  assert.equal(path.dirname(privateFile), folder); assert.notEqual(path.dirname(bFile), folder);
  for (const file of [sharedFile, privateFile, bFile]) assert.ok(fs.realpathSync(file).startsWith(fs.realpathSync(profile) + path.sep) && fs.existsSync(file));
  measurements.push({ before: { folder: path.basename(folder), files: fs.readdirSync(folder), b: path.basename(path.dirname(bFile)) } });
  check('A has a private and a shared cached image, B its own, all inside the owned profile');

  await app.evaluate(({ dialog }) => { globalThis.confirmations = []; dialog.showMessageBox = async (_win, options) => {
    globalThis.confirmations.push(options.message);
    if (!['结束这个原生会话？', '移除此应用中的会话记录？'].includes(options.message) && !/^清除「.*」的共享记录？$/.test(options.message)) throw Error('Unexpected confirmation');
    return { response: 1 };
  }; });
  await page.locator(`[data-session-id="${a}"]`).click();
  if (!(await page.locator('#advanced').evaluate(el => el.open))) await page.locator('#advanced summary').click();
  await page.getByRole('button', { name: '结束这个原生会话…', exact: true }).click();
  await until(async () => (await snapshot()).sessions.find(s => s.id === a)?.state === 'ended', 'Synthetic Claude A ended');
  await page.getByRole('button', { name: '移除本应用记录…', exact: true }).click();
  await until(async () => !(await snapshot()).sessions.some(s => s.id === a), 'A\'s records removed');
  await until(() => !fs.existsSync(privateFile), 'The image only A showed is removed');
  assert.deepEqual(fs.readdirSync(folder), [path.basename(sharedFile)], 'Only the image the shared record shows stays');
  assert.ok(fs.existsSync(bFile), 'B\'s image is untouched');
  await page.reload(); await page.locator('#new-session').waitFor(); await page.locator('#room-nav').click(); await page.locator('#room-record').click();
  const kept = page.locator(`#room-messages [data-message-id="${shared.id}"] .native-image`);
  await until(async () => await kept.locator('img').count() && await kept.locator('img').evaluate(el => el.complete && el.naturalWidth > 0), 'The shared record still shows its image');
  await kept.locator('.native-image-copy').click(); await until(async () => (await app.evaluate(() => globalThis.nativeImageCopies.at(-1)))?.hash === pixels[0].hash, 'The kept image copies its own pixels');
  await capture('01-removed-session-shared-image-kept');
  check('Removing A\'s records removes its private image; the image its shared record shows stays and still opens; B is untouched');

  // 清除…的共享记录 sits under the dialog's closed 清理与完全退出 section; open it as a person would.
  await page.locator('#privacy-button').click(); const clear = page.locator('#clear-shared-history');
  await page.locator('#privacy-dialog summary', { hasText: '清理与完全退出' }).click();
  await until(async () => await clear.isVisible() && await clear.isEnabled(), 'Clear control ready'); await clear.click();
  await until(async () => !(await snapshot()).room.messages.some(m => m.id === shared.id), 'Shared record cleared');
  await until(() => !fs.existsSync(folder), 'Clearing the shared record removes the kept image and A\'s folder');
  await until(async () => (await page.locator('#trust-refresh-status').innerText()) === '这个空间的共享记录已清除；其他空间和未发送草稿保留。', 'Cleared without an error');
  assert.ok(fs.existsSync(bFile), 'B\'s image is still untouched');
  await capture('02-shared-record-cleared');
  measurements.push({ confirmations: await app.evaluate(() => globalThis.confirmations), after: { aFolder: fs.existsSync(folder), b: fs.existsSync(bFile) } });
  check('Clearing the shared record then removes the image kept for it and A\'s folder, with no error; B is untouched');

  assert.deepEqual(errors, []); const stats = (await fixture('stats')).stats; measurements.push({ stats });
  assert.equal(stats.sends, 1); assert.equal(stats.inputs, 0); check('No page errors; one explicit synthetic task, no native input, 0 model');
}
run().catch(async error => { failure = error.stack; console.error(error.stack); process.exitCode = 1; if (page && !page.isClosed()) await capture('failure').catch(() => {}); }).finally(async () => {
  try {
    if (evidence) fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ flowPassed: !failure, failure, checks, errors, measurements, profile, token, productModels: 0 }, null, 2));
    await scratch.release(); assert.equal(JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))).token, token); fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot);
    console.log('Owned fixture cleaned; canonical GUI slot released.');
  } catch (error) { console.error('Cleanup unconfirmed; own token retained:', error.message); process.exitCode = 1; }
});
