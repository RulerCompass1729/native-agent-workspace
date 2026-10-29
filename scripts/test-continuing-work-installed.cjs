// Signed renderer/IPC/service acceptance; existing synthetic native transport.
// Reuse source IPC-delay and clipboard proofs. This never writes OS clipboard.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const scratch = require('./fixtures/test-scratch.cjs'), { createIn } = require('./fixtures/create-view.cjs');
const { _electron } = scratch.playwright({ _electron: require('./fixtures/installed-renderer.cjs') });
assert.ok(process.env.NAW_APP_EXECUTABLE && process.env.NAW_TEST_APP_ROOT && process.env.NAW_EVIDENCE_DIR);
const code = process.env.NAW_TEST_APP_ROOT, evidence = process.env.NAW_EVIDENCE_DIR;
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID();
try { fs.mkdirSync(slot); } catch (error) { if (error.code !== 'EEXIST') throw error; console.error('GUI slot occupied; no app launched.'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Main', task: 'I79 signed continuing-work reading', pid: process.pid, token }));
const profile = scratch.directory(path.join(os.tmpdir(), 'naw-continuing-work-'));
const child = scratch.childProcess.fork(path.join(code, 'app/daemon.cjs'), [profile], {
  execArgv: ['--require', path.join(__dirname, 'fixtures/native-images.cjs')],
  env: { ...process.env, NAW_TEST_APP_ROOT: code, NAW_WORKSPACE: profile, NAW_APP_VERSION: require(path.join(code, 'package.json')).version },
  stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
});
fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(evidence, 'daemon-launch.json'), JSON.stringify({ pid: child.pid, argv: child.spawnargs, code, syntheticNative: true }, null, 2));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms)), checks = [], errors = [];
let app, page, sequence = 0;
async function until(fn, label) { for (let i = 0; i < 160; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
function fixture(method, target, value) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.off('message', receive); reject(Error('Owned fixture timeout')); }, 12000);
    const receive = packet => { if (packet.requestId !== id) return; clearTimeout(timer); child.off('message', receive); packet.error ? reject(Error(packet.error)) : resolve(packet); };
    child.on('message', receive); child.send({ id, method, target, value });
  });
}
const snapshot = () => page.evaluate(() => workspace.initial());
const identities = state => state.sessions.map(s => ({ id: s.id, nativeId: s.nativeId, owner: s.owner }));
async function launch() {
  app = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE, args: [], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(12000); page.on('pageerror', error => errors.push(error.message));
  await page.locator('#new-session').waitFor();
}
async function create(name) {
  await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="codex"]').check();
  await page.locator('#session-name').fill(name); await createIn(page, 'chat');
  await until(async () => (await snapshot()).sessions.some(s => s.name === name && s.state === 'idle'), 'Owned synthetic session ready');
  const id = (await snapshot()).sessions.find(s => s.name === name).id;
  await page.locator('#session-header-more').click(); await page.getByRole('menuitem', { name: '加入协作', exact: true }).click();
  return id;
}
async function capture(name) { await page.screenshot({ path: path.join(evidence, name + '.png') }); fs.writeFileSync(path.join(evidence, name + '.json'), JSON.stringify(await snapshot(), null, 2)); }
async function run() {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Owned daemon ready'); await launch();
  const a = await create('Installed image source'), b = await create('Installed idle peer');
  await page.locator('#message-input').fill('OWNED_PEER_DRAFT');
  await until(async () => (await snapshot()).sessions.find(s => s.id === b).liveDraft === 'OWNED_PEER_DRAFT', 'Peer draft persisted');
  await page.locator(`[data-session-id="${a}"]`).click(); await page.locator('#message-input').fill('OWNED_SOURCE_DRAFT');
  await until(async () => (await snapshot()).sessions.find(s => s.id === a).liveDraft === 'OWNED_SOURCE_DRAFT', 'Source draft persisted');
  const before = identities(await snapshot()), nativeId = before.find(s => s.id === a).nativeId;
  const file = path.join(profile, 'original.png');
  // Existing native-images unit fixture: opaque white 1x1 grayscale/alpha PNG.
  fs.writeFileSync(file, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=', 'base64'));
  await fixture('nativeImageEvent', a, { method: 'item/completed', params: { item: { type: 'imageView', id: 'installed-original', path: file } }, cwd: profile });
  const picture = () => page.locator(`#messages [data-message-id="native:${nativeId}:tool:installed-original"] .native-image`);
  await until(() => picture().locator('img').evaluateAll(images => images.length === 1 && images[0].complete && images[0].naturalWidth === 1), 'Signed native image thumbnail decoded');
  assert.deepEqual(await picture().locator('img').evaluate(img => { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1; const context = canvas.getContext('2d'); context.drawImage(img, 0, 0); return [...context.getImageData(0, 0, 1, 1).data]; }), [255, 255, 255, 255]);
  await picture().locator('.native-image-toggle').click(); await until(() => picture().getAttribute('data-expanded').then(x => x === 'true'), 'Original image expands');
  await picture().locator('.native-image-copy').focus(); assert.equal(await picture().locator('.native-image-copy').isEnabled(), true);
  checks.push('Signed native reader decodes exact fixture pixels, expands in the existing row, and exposes focused copy without writing the OS clipboard'); await capture('image');
  await page.reload(); await page.locator('#new-session').waitFor();
  await until(() => picture().getAttribute('data-expanded').then(x => x === 'true'), 'Original image open choice survives reload');
  assert.equal(await page.locator('#message-input').inputValue(), 'OWNED_SOURCE_DRAFT');
  await page.locator(`.session-more[data-session-menu="${b}"]`).click(); await page.getByRole('menuitem', { name: '脱出协作', exact: true }).click();
  await until(async () => !(await snapshot()).sessions.find(s => s.id === b).roomId, 'Exact peer detached');
  assert.equal((await snapshot()).viewState.selected, a); assert.equal(await page.locator('#message-input').inputValue(), 'OWNED_SOURCE_DRAFT');
  checks.push('Image open choice and draft survive reload; detaching another member preserves the current original reader'); await capture('detached');
  await page.locator(`.session-more[data-session-menu="${b}"]`).click(); await page.getByRole('menuitem', { name: '归档会话', exact: true }).click();
  await until(async () => (await snapshot()).sessions.find(s => s.id === b).archived, 'Exact peer archived');
  await page.locator('#archive-button').click(); await page.locator(`[data-archived-session="${b}"]`).getByRole('button', { name: '恢复会话', exact: true }).click();
  await until(async () => !(await snapshot()).sessions.find(s => s.id === b).archived, 'Exact peer restored');
  assert.equal((await snapshot()).viewState.selected, a); assert.equal(await page.locator('#message-input').inputValue(), 'OWNED_SOURCE_DRAFT');
  await page.getByRole('button', { name: '打开 Installed idle peer', exact: true }).click();
  await until(async () => (await snapshot()).viewState.selected === b, 'Only explicit Open navigates');
  assert.equal(await page.locator('#message-input').inputValue(), 'OWNED_PEER_DRAFT');
  assert.deepEqual(identities(await snapshot()), before); checks.push('Archive/restore stays on the current conversation; explicit Open returns to the same native identity and its original draft'); await capture('restored');
  const stats = (await fixture('stats')).stats; assert.equal(stats.sends, 0); assert.equal(stats.inputs, 0);
  assert.deepEqual(errors, []); const result = { checks, errors, before, after: identities(await snapshot()), stats, productModelCalls: 0, realProviderProcesses: 0, limits: 'Installed steady-path proof only; source Main IPC delay and intercepted clipboard proofs reused. No real provider, physical clipboard/IME or immutable model-image pixel claim.' };
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
}
run().catch(async error => { console.error(error.stack); process.exitCode = 1; if (page && !page.isClosed()) await capture('failure').catch(() => {}); }).finally(async () => {
  try { await scratch.release(); assert.equal(JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))).token, token); fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot); console.log('Owned installed fixture cleaned; canonical GUI slot released.'); }
  catch (error) { console.error('Cleanup unconfirmed; own lock retained:', error.message); process.exitCode = 1; }
});
