// Actual source Electron, DSH, IPC and Workspace; synthetic provider transport.
// Exercise the existing textarea editing and recipient metadata without inference.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { randomUUID, createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process'), { once } = require('node:events');
const scratch = require('./fixtures/test-scratch.cjs');
const { fork } = scratch.childProcess, { _electron } = scratch.playwright(require('playwright'));
const { chooseRecipient, fillRoomMessage } = require('./room-input.cjs');
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const evidence = process.env.NAW_EVIDENCE_DIR;
if (evidence) {
  let parent = path.resolve(evidence); while (!fs.existsSync(parent)) parent = path.dirname(parent);
  const target = path.join(fs.realpathSync(parent), path.relative(parent, path.resolve(evidence)));
  for (const folder of [root, code]) { const base = fs.realpathSync(folder); if (target === base || target.startsWith(base + path.sep)) throw Error('Evidence must be outside the repository'); }
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
}
const sourceFiles = ['app/renderer/renderer.js', 'app/renderer/index.html', 'app/renderer/context-menu.js', 'app/room-mention.js', 'app/dsh/client.js'];
const hashes = () => Object.fromEntries(sourceFiles.map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(code, file))).digest('hex')]));
const sourceBefore = hashes();
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID();
try { fs.mkdirSync(slot); } catch (error) { if (error.code !== 'EEXIST') throw error; console.error('GUI slot occupied; no GUI launched.'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Codex2', task: 'T94/T95 recipient editing', token, pid: process.pid, at: new Date().toISOString() }));
const profile = scratch.directory(path.join(os.tmpdir(), 'naw-room-mention-edit-'));
const cwd = path.join(profile, 'workspace'); fs.mkdirSync(cwd);
const child = fork(path.join(code, 'app/daemon.cjs'), [profile], { cwd, execArgv: ['--require', path.join(__dirname, 'fixtures/delayed-native.cjs')], env: { ...process.env, NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_TEST_APP_ROOT: code, NAW_WORKSPACE: cwd }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
const { connectService } = require(path.join(code, 'app/service-connection.cjs'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let app, page, client, a, b, sequence = 0;
const checks = [], errors = [];
async function until(fn, message) { for (let i = 0; i < 150; i++) { if (await fn()) return; await delay(50); } throw Error(message); }
function native(method = 'stats', fail = false) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.off('message', receive); reject(Error('Delayed transport reply timed out')); }, 10000);
    const receive = result => { if (result.requestId !== id) return; clearTimeout(timer); child.off('message', receive); resolve(result); };
    child.on('message', receive); child.send({ id, method, fail, reply: 'Synthetic complete reply.' });
  });
}
const snapshot = () => page.evaluate(() => workspace.initial());
const input = () => page.locator('#shared-input');
async function capture(name) { if (evidence) { await page.screenshot({ path: path.join(evidence, name + '.png') }); fs.writeFileSync(path.join(evidence, name + '.json'), JSON.stringify(await snapshot(), null, 2)); } }
async function launch() {
  app = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [code], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#shared-input').waitFor();
}
async function draft(id, text) { await input().fill(text); await chooseRecipient(page, id); }
async function sendAndWait(count) { await page.locator('#forward-button').click(); await until(async () => (await native()).sends.length === count, 'One exact directed dispatch'); }
const check = text => { checks.push(text); console.log('PASS:', text); };
const value = () => input().inputValue();
const recipient = () => page.locator('#recipient').inputValue();
const binding = async () => (await snapshot()).viewState.roomMention;
async function range(start, end = start, direction = 'none') { await input().evaluate((el, pair) => { el.focus(); el.setSelectionRange(...pair); }, [start, end, direction]); }
async function undo() { await page.keyboard.press('Meta+z'); }
async function redo() { await page.keyboard.press('Meta+Shift+z'); }
async function suffixChoices() {
  for (const [label, suffix] of [['newline', '\nnext'], ['space', ' please review']]) {
    const before = (await native()).sends.length;
    await input().fill('@bo' + suffix); await range(3); await page.locator(`[data-mention-id="${b}"]`).click(); await delay(80);
    const proof = { suffix, value: await value(), binding: await binding(), popupVisible: await page.locator('#mention-list').isVisible(), sourceBefore };
    if (evidence) fs.writeFileSync(path.join(evidence, 'suffix-' + label + '.json'), JSON.stringify(proof, null, 2));
    assert.equal(proof.popupVisible, false, 'Explicit choice before existing whitespace must stay closed so Enter sends');
    await input().press('Enter'); await until(async () => (await native()).sends.length === before + 1, 'Enter sends once after explicit mention choice');
    assert.deepEqual((await native()).sends.at(-1), { id: b, text: suffix.trim() }); await native('release');
    await until(async () => await value() === '' && await recipient() === '', 'T87 clears sent body and mention');
    check('Choose single-word Bob before existing ' + label + ': list stays closed and Enter sends exactly once');
  }
}
async function run() {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Owned daemon ready'); client = await connectService(profile, 'mention-setup');
  a = await client.call('create', { provider: 'claude', cwd, name: 'Original A · 核查', view: 'chat' }); b = await client.call('create', { provider: 'claude', cwd, name: 'Bob', view: 'chat' });
  await client.call('join', a, true); await client.call('join', b, true);
  fs.writeFileSync(path.join(profile, 'views.json'), JSON.stringify([{ owner: 'mention-view', active: true, selected: 'room', mode: 'chat' }]), { mode: 0o600 });
  await launch(); await page.locator('#room-record').click();
  if (process.env.NAW_TEST_MENTION_CHOICE_SUFFIX === '1') { await suffixChoices(); return; }
  if (process.env.NAW_TEST_MENTION_BASELINE === '1') {
    await draft(a, 'body'); const raw = await value(); await range(0); await page.keyboard.press('Delete');
    const atomic = await value() === 'body'; await undo(); const restored = await value() === raw && await recipient() === a;
    await input().fill('@ '); await input().press('Backspace'); const popup = await page.locator('#mention-list').isVisible();
    await draft(a, 'body'); const longRaw = await value(), address = await binding(); await range(address.end + 1); await page.keyboard.type('x'.repeat(100)); await undo(); const longTypingUndo = await value();
    const result = { atomic, restored, popup, longRaw, longTypingUndo, sourceBefore, sourceAfter: hashes(), expectedAllTrue: true };
    await capture('baseline'); if (evidence) fs.writeFileSync(path.join(evidence, 'baseline-result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result)); assert.ok(atomic && restored && popup, 'Original user atomic delete/undo/popup must all work'); return;
  }
  await draft(a, 'body'); const original = await value(), selected = await binding();
  await range(0); await page.keyboard.press('Delete'); assert.equal(await value(), 'body'); assert.equal(await recipient(), '');
  assert.match(await page.locator('#mention-status').textContent(), /已移除收件人 Original A/); await capture('01-delete');
  await undo(); await until(async () => await recipient() === a, 'Native Undo restores exact original selected identity'); assert.equal(await value(), original);
  await redo(); assert.equal(await value(), 'body'); assert.equal(await recipient(), ''); await undo(); assert.equal(await recipient(), a);
  check('Forward Delete removes the whole address and separator; native Undo/Redo restores exact text and selected identity');
  await range(selected.end + 1); await page.keyboard.press('Backspace'); assert.equal(await value(), 'body'); await undo(); assert.equal(await recipient(), a);
  await range(3, 6); await page.keyboard.insertText('X'); assert.equal(await value(), 'Xbody'); assert.equal(await recipient(), '');
  await undo(); assert.equal(await value(), original); assert.equal(await recipient(), a);
  check('Backspace and partial replacement edit the entire recipient while preserving body and native Undo');
  await range(selected.end + 1); await page.keyboard.press('ArrowLeft'); assert.equal(await input().evaluate(el => el.selectionStart), 0);
  await page.keyboard.press('ArrowRight'); assert.equal(await input().evaluate(el => el.selectionStart), selected.end + 1);
  const point = await input().evaluate(el => { const r = el.getBoundingClientRect(), style = getComputedStyle(el), context = document.createElement('canvas').getContext('2d'); context.font = style.font; return { x: r.left + parseFloat(style.paddingLeft) + context.measureText(el.value.slice(0, 4)).width, y: r.top + parseFloat(style.paddingTop) + parseFloat(style.fontSize) / 2 }; });
  await page.mouse.click(point.x, point.y); await until(async () => [0, selected.end + 1].includes(await input().evaluate(el => el.selectionStart)), 'Real pointer caret snaps outside the atomic address');
  check('Left/right keys and an actual pointer click keep the caret outside the middle of the selected name');
  await range(selected.end + 1, original.length, 'backward'); await page.keyboard.press('Shift+ArrowLeft'); assert.deepEqual(await input().evaluate(el => [el.selectionStart, el.selectionEnd, el.selectionDirection]), [0, original.length, 'backward']);
  await page.keyboard.press('Shift+ArrowRight'); assert.deepEqual(await input().evaluate(el => [el.selectionStart, el.selectionEnd, el.selectionDirection]), [selected.end + 1, original.length, 'backward']);
  check('Shift arrows preserve the original body-selection anchor while extending across the atomic name');
  await range(selected.end + 1); await page.keyboard.insertText('x'.repeat(100)); await undo();
  assert.equal(await value(), original); assert.equal(await recipient(), a);
  check('One native Undo after a long text insertion retains the explicit recipient anchor');
  await range(0); await page.keyboard.press('Delete'); await input().fill(original); assert.equal(await recipient(), '');
  await range(1); await page.locator(`[data-mention-id="${b}"]`).click(); await undo(); assert.equal(await value(), original); assert.equal(await recipient(), '');
  assert.equal(await page.locator('#forward-button').isDisabled(), true);
  check('Undo to an identical manually entered name stays unbound; an earlier selected occurrence grants no authority');
  await input().fill('@ '); await input().press('Backspace'); await page.locator('#mention-list').waitFor();
  await undo(); assert.equal(await value(), '@ '); assert.equal(await page.locator('#mention-list').isHidden(), true);
  await redo(); assert.equal(await value(), '@'); await page.locator('#mention-list').waitFor();
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Tab'); assert.equal(await recipient(), b);
  check('Backspace to @ reopens the original list; arrow navigation and Tab explicitly select one original ID');
  await input().fill('@'); await page.keyboard.press('Escape'); assert.equal(await page.locator('#mention-list').isHidden(), true);
  await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowRight'); await page.locator('#mention-list').waitFor();
  await page.keyboard.press('Enter'); assert.equal(await recipient(), a);
  await input().fill('@ z');
  const at = await input().evaluate(el => { const r = el.getBoundingClientRect(), style = getComputedStyle(el), context = document.createElement('canvas').getContext('2d'); context.font = style.font; return { x: r.left + parseFloat(style.paddingLeft) + context.measureText('@').width, y: r.top + parseFloat(style.paddingTop) + parseFloat(style.fontSize) / 2 }; });
  await page.mouse.click(at.x, at.y); await page.locator('#mention-list').waitFor(); assert.equal(await input().evaluate(el => el.selectionStart), 1);
  await page.keyboard.press('Escape');
  check('Escape stays closed until a real key/caret move; arrows and an actual pointer after @ reopen choices, Enter selects without sending');
  await input().fill(''); await input().focus();
  await app.evaluate(({ clipboard }) => { clipboard.readText = () => '@'; clipboard.writeText = () => { throw Error('OS clipboard writes are forbidden in this owned test'); }; });
  await page.keyboard.press('Shift+F10'); await page.getByRole('menuitem', { name: '粘贴', exact: true }).click(); await page.locator('#mention-list').waitFor();
  assert.equal(await value(), '@'); assert.equal(await recipient(), ''); await capture('02-paste-popup');
  check('The existing Paste menu reopens choices from synthetic clipboard text without reading or writing the OS clipboard');
  await draft(a, 'body'); const rawBeforePaste = await value(); await range(3, 6);
  await app.evaluate(({ clipboard }) => { clipboard.readText = () => 'replacement'; });
  await page.keyboard.press('Shift+F10'); await page.getByRole('menuitem', { name: '粘贴', exact: true }).click();
  assert.equal(await value(), 'replacementbody'); assert.equal(await recipient(), ''); await undo();
  assert.equal(await value(), rawBeforePaste); assert.equal(await recipient(), a);
  check('Existing context Paste over a partial name replaces the whole token, and native Undo restores exact authority');
  await page.locator('#room-search').fill(''); await page.locator('#room-search').focus(); await page.keyboard.press('Shift+F10'); await page.getByRole('menuitem', { name: '粘贴', exact: true }).click(); assert.equal(await page.locator('#room-search').inputValue(), 'replacement'); await undo(); assert.equal(await page.locator('#room-search').inputValue(), ''); await input().focus();
  await draft(a, 'body'); const beforeCut = await value(), cutBinding = await binding();
  await range(2, 3); await app.evaluate(({ clipboard }) => { global.fixtureCuts = []; clipboard.writeText = text => global.fixtureCuts.push(text); });
  await page.keyboard.press('Shift+F10'); await page.getByRole('menuitem', { name: '剪切', exact: true }).click();
  assert.equal(await value(), 'body'); assert.deepEqual(await app.evaluate(() => global.fixtureCuts), [cutBinding.text + ' ']); await undo(); assert.equal(await value(), beforeCut); assert.equal(await recipient(), a);
  check('Cut of a partial name copies exactly the entire deleted atom into the intercepted clipboard and keeps native Undo');
  await input().fill('prefix @a body'); await range(9); await page.locator(`[data-mention-id="${a}"]`).click();
  const lineRaw = await value(), lineBinding = await binding(); await range(lineBinding.end + 1); await page.keyboard.press('Meta+Backspace');
  assert.equal(await value(), 'body'); assert.equal(await recipient(), ''); await undo(); assert.equal(await value(), lineRaw); assert.equal(await recipient(), a);
  check('Cmd Backspace keeps native beginning-of-line deletion and native Undo instead of deleting only the mention');
  await draft(a, 'body'); const addressLength = (await binding()).end + 1, longBody = 'x'.repeat(16000 - addressLength);
  await fillRoomMessage(page, longBody); const fullRaw = await value(); assert.equal(fullRaw.length, 16000);
  await range(2, 3); await app.evaluate(({ clipboard }) => { clipboard.readText = () => 'YY'; });
  await page.keyboard.press('Shift+F10'); await page.getByRole('menuitem', { name: '粘贴', exact: true }).click();
  assert.equal(await value(), 'YY' + longBody); assert.equal(await recipient(), ''); await undo(); assert.equal(await value(), fullRaw); assert.equal(await recipient(), a);
  await range(fullRaw.length - 1, fullRaw.length); await page.keyboard.press('Shift+F10'); await page.getByRole('menuitem', { name: '粘贴', exact: true }).click();
  await until(() => page.locator('#toast').innerText().then(t => t.includes('16000')), 'Over-limit paste is honestly rejected'); assert.equal(await value(), fullRaw); assert.equal(await recipient(), a);
  check('At the exact length limit, whole-token Paste uses its expanded range; a real over-limit body edit preserves all text and authority');
  await draft(a, 'body');
  await range((await value()).length); const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: '中文', selectionStart: 2, selectionEnd: 2 });
  assert.equal(await page.locator('#mention-list').isHidden(), true); const sendsBefore = (await native()).sends.length;
  await input().dispatchEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true }); assert.equal((await native()).sends.length, sendsBefore);
  await cdp.send('Input.insertText', { text: '中文' }); await cdp.detach();
  assert.equal(await value(), rawBeforePaste + '中文'); assert.equal(await recipient(), a);
  await input().press('Shift+Enter'); assert.equal(await value(), rawBeforePaste + '中文\n'); assert.equal((await native()).sends.length, 0);
  check('Real Chromium IME composition in the body keeps the token, hides choices and does not send on composing Enter; Shift Enter stays a newline');
  await draft(a, 'body'); const beforeStale = await value(); await range(0); await page.keyboard.press('Delete');
  await page.evaluate(async id => { await workspace.join(id, false); await workspace.join(id, true); }, a); await undo(); assert.equal(await value(), beforeStale); assert.equal(await recipient(), '');
  assert.equal(await page.locator('#forward-button').isDisabled(), true);
  check('Undo preserves the old original text after membership metadata changes but cannot revive stale routing authority');
  await draft(a, 'Only this exact task.'); await range(0); await page.keyboard.press('Delete'); await undo();
  assert.equal(await recipient(), a); await page.locator('#forward-button').click(); await until(async () => (await native()).sends.length === 1, 'One explicit send after Undo');
  assert.deepEqual((await native()).sends, [{ id: a, text: 'Only this exact task.' }]); await native('release');
  await until(async () => await value() === '' && await recipient() === '', 'T87 success clearing remains intact');
  await suffixChoices();
  assert.deepEqual(errors, []); assert.deepEqual(hashes(), sourceBefore); await capture('03-final');
  check('Undo-restored original receiver gets exactly the body once, followed by T87 clearing; no implicit send or page errors');
  const result = { checks, errors, sourceBefore, sourceAfter: hashes(), syntheticDispatches: 3, productModels: 0, realProviderProcesses: 0, OSClipboardReadWrites: 0, physicalIME: 'not qualified; Chromium CDP composition only', profile };
  if (evidence) fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
}
const cleanup = scratch.cleanup(async () => { try { if (app) await app.close(); client?.close(); } finally { if (child.connected) child.disconnect(); if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } } });
run().catch(async error => { console.error(error.stack); process.exitCode = 1; if (page && !page.isClosed()) await capture('failure'); if (evidence) fs.writeFileSync(path.join(evidence, 'failure.txt'), error.stack); }).finally(async () => {
  try { await cleanup(); assert.equal(JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))).token, token); fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot); if (evidence) fs.writeFileSync(path.join(evidence, 'released.json'), JSON.stringify({ token, releasedAt: new Date().toISOString(), profile, ownedCleanupConfirmed: true }, null, 2)); console.log('Owned fixture cleaned; canonical GUI token released.'); }
  catch (error) { console.error('Cleanup unconfirmed; own lock retained:', error.stack); process.exitCode = 1; }
});
