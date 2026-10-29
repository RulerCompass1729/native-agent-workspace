const testScratch = require('./fixtures/test-scratch.cjs');
const { createIn } = require('./fixtures/create-view.cjs');
const { chooseRecipient: inlineRecipient, fillRoomMessage, roomBody } = require('./room-input.cjs');
// Actual Electron renderer/IPC/storage; provider replies and OS dialog selection
// are controlled local fixtures. This does not certify physical macOS dialog use.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { fork } = testScratch.childProcess;
const { execFileSync } = testScratch.childProcess;
const { _electron } = testScratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const { connect } = require(path.join(code, 'app/service-client.cjs'));
const profile = testScratch.directory(path.join(os.tmpdir(), 'naw-desktop-workflow-'));
const evidence = process.env.NAW_EVIDENCE_DIR;
if (evidence) fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
const child = fork(path.join(code, 'app/daemon.cjs'), [profile], { execArgv: ['--require', path.join(__dirname, 'fixtures/daily-native.cjs')], env: { ...process.env, NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_WORKSPACE: profile, NAW_TEST_APP_ROOT: code }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
let app, page, client, sequence = 0, recorder, recording = false, frames = 0; const passed = [], errors = [];
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label) { for (let i = 0; i < 160; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
function native(method = 'stats', text = '') { const id = ++sequence; return new Promise((resolve, reject) => {
  const cb = m => { if (m.requestId === id) { clearTimeout(timer); child.off('message', cb); resolve(m); } };
  const timer = setTimeout(() => { child.off('message', cb); reject(Error('Fixture timeout')); }, 8000);
  child.on('message', cb); child.send({ id, method, text });
}); }
const snapshot = () => page.evaluate(() => workspace.initial());
async function shot(name) { if (evidence) await page.screenshot({ path: path.join(evidence, name + '.png'), timeout: 5000 }); }
async function closeApp() {
  clearInterval(recorder); while (recording) await delay(25);
  await app.close(); app = null;
}
async function launch() {
  app = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root],
    env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(12000); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#new-session').waitFor();
  if (evidence) {
    fs.mkdirSync(path.join(evidence, 'frames'), { recursive: true });
    recorder = setInterval(async () => {
      if (recording) return; recording = true;
      try { await page.screenshot({ path: path.join(evidence, 'frames', String(frames++).padStart(5, '0') + '.png'), timeout: 5000 }); }
      catch {} finally { recording = false; }
    }, 1000);
  }
  await app.evaluate(({ dialog }) => {
    global.__fileChoices = []; global.__saveChoices = [];
    dialog.showOpenDialog = async () => { const file = global.__fileChoices.shift(); if (!file) throw Error('No selected file fixture'); return { canceled: false, filePaths: [file] }; };
    dialog.showSaveDialog = async () => { const file = global.__saveChoices.shift(); if (!file) throw Error('No save target fixture'); return { canceled: false, filePath: file }; };
  });
}
async function chooseFile(file, button = 'room-files') {
  await app.evaluate((_electron, file) => global.__fileChoices.push(file), file); await page.locator('#' + button).click(); await page.locator('#file-dialog').waitFor();
}
async function create(provider) {
  const previous = (await snapshot()).sessions.map(s => s.id);
  await page.locator('#new-session').click(); await page.locator(`input[name="provider"][value="${provider}"]`).check();
  await page.locator('#session-name').fill('伙伴'); await createIn(page, 'chat');
  await until(async () => (await snapshot()).sessions.some(s => !previous.includes(s.id) && s.chatAvailable), 'New distinct session ready');
  const id = (await snapshot()).sessions.find(s => !previous.includes(s.id)).id;
  await page.getByRole('button', { name: '加入协作', exact: true }).click(); return id;
}
async function recipient(id) { await inlineRecipient(page, id); }
async function openRun() { await page.locator('#room-advanced summary').click(); await page.locator('#run-button').click(); await page.locator('#run-dialog').waitFor(); }
async function complete(text) { await native('release', text); }
async function run() {
  console.log('Profile:', profile);
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Fixture ready'); client = await connect(profile, 'workflow-observer'); await launch();
  const a = await create('claude'), b = await create('claude'), c = await create('codex'), d = await create('codex');
  const identities = (await snapshot()).sessions.map(s => [s.id, s.nativeId]);
  await page.locator(`[data-session-menu="${a}"]`).click(); await page.getByRole('menuitem', { name: '重命名…', exact: true }).click();
  await page.locator('#rename-name').fill('计划复核'); await page.locator('#confirm-rename').click();
  await page.locator('#room-nav').click(); await page.locator('#room-record').click(); await recipient(a);
  await page.locator(`[data-room-session="${c}"]`).click();
  assert.equal(await page.locator('#room-record-view').isVisible(),true);
  assert.equal(await page.locator('#terminal-area').isVisible(),true);
  assert.equal(await page.locator('#recipient').inputValue(),a,'Displayed terminal does not choose the file or message recipient');
  const material = path.join(profile, '计划.csv'); fs.writeFileSync(material, '项目,人数,单价\n午餐,3,18\n交通,3,7\n');
  await fillRoomMessage(page, '请核查预算并给出结论。'); await chooseFile(material);
  assert.match(await page.locator('#file-content').innerText(), /午餐,3,18/); assert.equal((await native()).sends.length, 0);
  await shot('material-preview'); await page.locator('#insert-file').click();
  await assert.rejects(page.evaluate(ids => workspace.run(ids, 'stale name should not dispatch', 3, 'replies', Object.fromEntries(ids.map(id => [id, 'obsolete alias']))), [a, b, c]), /名称已变化/);
  assert.equal((await native()).sends.length, 0);
  const goal = await roomBody(page); assert.ok(goal.includes('文件：计划.csv')); assert.ok(!goal.includes(profile));
  const longDraft = '材料'.repeat(3100); await fillRoomMessage(page, longDraft);
  await page.locator('#room-advanced summary').click(); await page.locator('#run-button').click();
  assert.equal(await page.locator('#run-dialog').isVisible(), false); assert.match(await page.locator('#toast').innerText(), /6000/);
  assert.equal(await roomBody(page), longDraft); assert.equal((await native()).sends.length, 0);
  await fillRoomMessage(page, goal);
  await openRun(); await page.locator(`[data-run-member="${c}"]`).check();
  assert.equal(await page.locator(`[data-run-member="${d}"]`).isChecked(), false);
  assert.equal(await page.locator('#confirm-run').isDisabled(), true); assert.match(await page.locator('#run-order').innerText(), new RegExp(c.slice(0, 6)));
  await page.locator('#run-limit').selectOption('3'); await page.locator('#run-consent').check(); await shot('participants-preview'); await page.locator('#confirm-run').click();
  for (let i = 0; i < 3; i++) {
    await until(async () => (await native()).sends.length === i + 1, 'Next authorized reply');
    assert.equal((await native()).sends.at(-1).id, [a, b, c][i]);
    await complete(['总计 75 元。', '复核：54 + 21 = 75 元。', '通过：预算为 75 元。'][i]);
  }
  await until(async () => (await snapshot()).room.run.status === 'completed', 'Reply cap reached');
  const sends = (await native()).sends; assert.equal(sends[0].text, goal.trim()); assert.match(sends[1].text, /计划复核 · Claude/); assert.ok(sends.every(s => !s.text.includes('PRIVATE-HISTORY')));
  assert.equal((await snapshot()).sessions.find(s => s.id === d).messages.some(m => m.text.includes('预算')), false);
  passed.push('GUI text material preview → explicit three-session subset → alias-aware exact order → three-reply cap; excluded member receives nothing');
  const result = path.join(profile, '预算结果.md'), resultText = '# 预算复核\n\n午餐 54 元，交通 21 元，合计 **75 元**。\n';
  fs.writeFileSync(result, resultText); await chooseFile(result); assert.equal(await page.locator('#file-content').textContent(), resultText);
  const copy = path.join(profile, '预算结果-copy.md'); await app.evaluate((_electron, file) => global.__saveChoices.push(file), copy); await page.locator('#save-file').click();
  await until(() => fs.existsSync(copy), 'Visible result exported'); assert.equal(fs.readFileSync(copy, 'utf8'), resultText); await shot('result-preview'); await page.locator('#close-file').click();
  assert.equal((await native()).sends.length, 3); passed.push('Result preview and exact local copy make zero provider calls; original file unchanged');
  // Second provider arrangement, with ordering changed through real controls.
  await recipient(d); await fillRoomMessage(page, '只复核 75 是否正确。'); await openRun();
  assert.equal(await page.locator(`[data-run-member="${a}"]`).isChecked(), true); await page.locator(`[data-run-member="${c}"]`).check();
  await page.getByRole('button', { name: `提前 伙伴 · ${c.slice(0, 6)}`, exact: true }).click();
  await page.locator('#run-consent').check(); await page.locator('#confirm-run').click();
  for (let i = 0; i < 3; i++) {
    await until(async () => (await native()).sends.length === i + 4, 'Other provider arrangement');
    assert.equal((await native()).sends.at(-1).id, [d, c, a][i]); await complete('确认 75，步骤 ' + i);
  }
  await until(async () => (await snapshot()).room.run.status === 'completed', 'Second cap');
  passed.push('One-Claude/two-Codex and two-Claude/one-Codex work with duplicate labels and explicitly reordered participants');
  // Fail draft persistence after insertion; retry must not append another copy.
  await fillRoomMessage(page, '保存故障前的草稿'); await chooseFile(material);
  await app.evaluate(() => { const fs = process.getBuiltinModule('node:fs'); global.__originalRename = fs.renameSync; fs.renameSync = (...args) => { if (String(args[1]).endsWith('/views.json')) throw Error('Synthetic disk full'); return global.__originalRename(...args); }; });
  await page.locator('#insert-file').click(); await until(() => page.locator('#file-dialog').isVisible().then(v => !v), 'Insert closes once even if storage fails');
  assert.equal((await roomBody(page)).split('文件：计划.csv').length, 2);
  await app.evaluate(() => { process.getBuiltinModule('node:fs').renameSync = global.__originalRename; });
  await page.locator('#retry-save').click(); assert.equal((await roomBody(page)).split('文件：计划.csv').length, 2);
  passed.push('Material insertion stays once across persistence failure and retry; draft is retained');
  await page.locator(`[data-session-id="${c}"]`).click(); await page.getByRole('button', { name: '脱出协作', exact: true }).click();
  await page.locator('#chat-tab').click(); await page.locator('#message-input').fill('独立继续的草稿'); await chooseFile(material, 'session-files'); await page.locator('#insert-file').click();
  const privateDraft = await page.locator('#message-input').inputValue(); await until(async () => (await snapshot()).sessions.find(s => s.id === c).liveDraft === privateDraft, 'Solo draft saved');
  assert.equal((await snapshot()).sessions.find(s => s.id === c).roomId, null);
  await page.locator(`[data-session-menu="${c}"]`).click(); await page.getByRole('menuitem', { name: '归档会话', exact: true }).click();
  if (await page.locator('#archive-button').getAttribute('aria-expanded') !== 'true') await page.locator('#archive-button').click(); await page.locator('#archive-list').getByRole('button', { name: '恢复会话', exact: true }).click();
  await page.locator(`[data-session-id="${c}"]`).click(); await page.locator('#chat-tab').click(); await shot('solo-after-detach');
  // A delayed picker must not attach to a newly selected conversation.
  await app.evaluate(({ dialog }) => { global.__normalFileDialog = dialog.showOpenDialog; dialog.showOpenDialog = () => new Promise(resolve => { global.__resolvePicker = resolve; }); });
  await page.locator('#session-files').click();
  await until(() => app.evaluate(() => Boolean(global.__resolvePicker)), 'Picker pending');
  await page.locator(`[data-session-id="${a}"]`).click(); await page.locator('#chat-tab').click();
  const otherDraft = await page.locator('#message-input').inputValue();
  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = global.__normalFileDialog; global.__resolvePicker({ canceled: false, filePaths: [file] }); }, material);
  await delay(250); assert.equal(await page.locator('#file-dialog').isVisible(), false); assert.equal(await page.locator('#message-input').inputValue(), otherDraft);
  await page.locator(`[data-session-id="${c}"]`).click(); await page.locator('#chat-tab').click();
  await chooseFile(material, 'session-files'); await client.call('claim', c, 'chat');
  await until(() => page.locator('#message-input').evaluate(el => el.readOnly), 'Other owner controls draft');
  await page.locator('#insert-file').click(); await page.locator('#file-error').waitFor();
  assert.equal(await page.locator('#message-input').inputValue(), privateDraft);
  await page.locator('#close-file').click(); assert.equal(await page.locator('#send-button').innerText(), '接管此窗口'); await page.locator('#send-button').click();
  passed.push('Delayed picker after navigation and ownership loss during preview cannot append to the wrong or another owner’s draft');
  const before = await snapshot(); await closeApp(); await launch();
  await page.locator('#message-input').waitFor(); const after = await snapshot();
  assert.deepEqual(after.sessions.map(s => [s.id, s.nativeId]), identities); assert.deepEqual(after.room.messages, before.room.messages);
  assert.equal(await page.locator('#message-input').inputValue(), privateDraft); assert.equal(after.sessions.find(s => s.id === c).roomId, null);
  assert.equal((await native()).sends.length, 6); assert.deepEqual(errors, []); assert.equal(app.windows().length, 1); await shot('reopened');
  passed.push('Detach → solo material draft → archive/reopen → app restart retains identity, shared results and private draft without replay');
  console.log(JSON.stringify({ passed, errors, syntheticDispatches: 6, nativeModelCalls: 0, oneWindow: true }, null, 2));
}
run().catch(async e => { console.error(e.stack, errors); if (page) await shot('failed').catch(() => {}); process.exitCode = 1; }).finally(testScratch.cleanup(async () => {
  if (app) await closeApp(); if (client) { for (const s of (await client.call('initial')).sessions) await client.call('stop', s.id); await client.call('shutdown'); client.close(); } if (child.connected) child.disconnect();
  if (evidence && frames && !process.exitCode) execFileSync('ffmpeg', ['-y', '-framerate', '1', '-i', path.join(evidence, 'frames', '%05d.png'), '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(evidence, 'desktop-workflow.mp4')], { stdio: 'ignore' });
}));
