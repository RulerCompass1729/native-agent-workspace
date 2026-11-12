// 「大管家的记录」 (steward step 2, batch 1): a session the person made the butler calls workspace_control through the
// actual stdio tool and NAW's own service; each step is in the dialog opened from the butler's menu, a refused one too.
// Real hidden Electron UI and service; the native producer is synthetic (the background-control fixture). No native
// program is started and no model is called. Takes the GUI test slot itself.
const scratch = require('./fixtures/test-scratch.cjs');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto'), { execFileSync } = require('node:child_process');
const { _electron } = scratch.playwright(require('playwright'));
const { connectService } = require('../app/service-connection.cjs');
const locale = require('../app/ui-locale.js');
const root = path.resolve(__dirname, '..'), evidence = process.env.NAW_EVIDENCE_DIR;
if (!evidence || !path.isAbsolute(evidence) || path.resolve(evidence).startsWith(root + path.sep)) throw Error('External private evidence directory required');
fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID();
try { fs.mkdirSync(slot); } catch (e) { if (e.code !== 'EEXIST') throw e; console.error('GUI slot occupied; no launch.'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ token, owner: 'claude310', task: 'steward record window check', pid: process.pid, at: new Date().toISOString() }));
execFileSync(process.execPath, [path.join(root, 'scripts/build-ui.cjs')]);
const checks = [], errors = [], shots = [];
let profile, child, client, app, page, helper, sequence = 0, butler, worker;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { for (let n = 0; n < 200; n++) { if (await fn()) return; await wait(40); } throw Error(label); }
const save = (name, value) => fs.writeFileSync(path.join(evidence, name + '.json'), JSON.stringify(value, null, 2), { mode: 0o600 });
function fixture(method, target, value) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.off('message', receive); reject(Error('Fixture response timeout')); }, 8000);
    const receive = r => { if ((method === 'backgroundProof' ? r.proofRequestId : r.requestId) !== id) return; clearTimeout(timer); child.off('message', receive); r.error ? reject(Error(r.error)) : resolve(r); };
    child.on('message', receive); child.send({ id, method, target, value });
  });
}
function mcp() {
  helper = scratch.childProcess.spawn(process.execPath, [path.join(root, 'app/claude-message-tool.cjs'), '--codex'], {
    env: { ...process.env, NAW_CONTROL_DESCRIPTOR: path.join(profile, 'outbox-owner.json') }, stdio: ['pipe', 'pipe', 'pipe'] });
  let text = ''; const pending = new Map();
  helper.stdout.setEncoding('utf8'); helper.stdout.on('data', part => { text += part; let end; while ((end = text.indexOf('\n')) >= 0) { const r = JSON.parse(text.slice(0, end)); text = text.slice(end + 1); pending.get(r.id)?.(r); pending.delete(r.id); } });
  helper.stderr.on('data', part => errors.push(String(part)));
  return (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => reject(Error('MCP response timeout')), 15000);
    pending.set(id, r => { clearTimeout(timer); r.error ? reject(Error(JSON.stringify(r.error))) : resolve(r.result); });
    helper.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
const invoke = (method, args, id = randomUUID()) => ({ action: 'invoke', method, arguments: args, operation_id: id });
const shot = async name => { await wait(200); await page.screenshot({ path: path.join(evidence, name + '.png') }); shots.push(name); };
async function size(width, height) {
  await (await app.browserWindow(page)).evaluate((win, [w, h]) => win.setContentSize(w, h), [width, height]);
  await until(() => page.evaluate(w => innerWidth === w, width), `Window ${width} wide`); await wait(300);
}
// The dialog as a person reads it: the line under the title, and each row's three cells.
const dialogText = () => page.evaluate(() => {
  const d = document.getElementById('steward-record-dialog');
  return { open: d.open, current: d.querySelector('p')?.innerText.trim(), rows: [...d.querySelectorAll('tbody tr')].map(tr => [...tr.cells].map(td => td.innerText.trim().replace(/\s+/g, ' '))),
    attention: [...d.querySelectorAll('tbody tr.attention')].length, note: [...d.querySelectorAll('p.quiet')].map(p => p.innerText.trim()) };
});
async function openRecord() {
  await page.locator('#steward-slot .session-row').click({ button: 'right' });
  const items = await page.getByRole('menuitem').allTextContents();
  await page.getByRole('menuitem', { name: locale.format(await page.evaluate(() => document.documentElement.lang.startsWith('en') ? 'en' : 'zh'), 'menu.stewardRecord'), exact: true }).click();
  await page.locator('#steward-record-dialog').waitFor({ state: 'visible' }); await wait(200);
  return items;
}
async function run() {
  profile = fs.realpathSync(scratch.directory(path.join(os.tmpdir(), 'naw-steward-record-'))); const cwd = path.join(profile, 'workspace'); fs.mkdirSync(cwd, { mode: 0o700 });
  child = scratch.childProcess.fork(path.join(root, 'app/daemon.cjs'), [profile], { cwd, execArgv: ['--require', path.join(__dirname, 'fixtures/background-control.cjs')],
    env: { ...process.env, NAW_TEST_APP_ROOT: root, NAW_WORKSPACE: cwd, NAW_APP_VERSION: require('../package.json').version }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Fixture service starts'); client = await connectService(profile, 'human-view');
  butler = await client.call('create', { provider: 'codex', cwd, name: 'Codex 管家', view: 'chat' });
  worker = await client.call('create', { provider: 'claude', cwd, name: 'Claude 前端', view: 'chat' });
  await client.call('join', worker, true);
  fs.writeFileSync(path.join(profile, 'views.json'), JSON.stringify([{ owner: 'human-view', active: true, selected: butler, mode: 'chat' }]), { mode: 0o600 });
  app = await _electron.launch({ args: [root], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 30000 });
  page = await app.firstWindow(); page.setDefaultTimeout(8000); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#message-input').waitFor(); await size(1280, 800);
  const say = (key, params) => locale.format('zh', key, params);

  // The person makes the session the butler; it may queue work without also being the secretary (batch 4).
  await page.evaluate(id => workspace.steward(id), butler);
  await until(async () => await page.locator('#steward-slot .session-row').count() === 1, 'The butler sits at the top');
  const rpc = mcp(); await rpc('initialize');
  async function control(args) {
    const proof = await fixture('backgroundProof', butler, { callId: randomUUID(), arguments: args });
    const result = await rpc('tools/call', { name: 'workspace_control', arguments: args,
      _meta: { threadId: proof.nativeId, sessionId: proof.sessionId, callId: proof.callId, 'x-codex-turn-metadata': { thread_id: proof.nativeId, turn_id: proof.turnId } } });
    await fixture('backgroundComplete', butler, { callId: proof.callId, arguments: args });
    return { value: JSON.parse(result.content[0].text), isError: result.isError };
  }
  // 1. Four steps: reading NAW's state, queueing a task, cancelling it (the butler may, batch 4), and a command that
  //    does not exist. Reading the command list is not a step.
  await control({ action: 'catalog' });
  const snap = await control({ action: 'snapshot' }); assert.equal(snap.value.state, 'complete');
  const queued = await control(invoke('spaceAction', ['shared', 'queueAdd', ['首页换新标题', null]])); assert.equal(queued.value.state, 'complete', JSON.stringify(queued));
  // The butler, in no space, reads every space as a member does (batch 4, part 2): the task's text is in its view.
  const seenByButler = await control({ action: 'snapshot' });
  assert.equal([seenByButler.value.value?.room, ...(seenByButler.value.value?.rooms || [])].filter(Boolean).flatMap(room => room.queue || []).find(item => item.id === queued.value.value)?.text, '首页换新标题', JSON.stringify(seenByButler.value).slice(0, 400));
  const cancel = await control(invoke('spaceAction', ['shared', 'queueCancel', [queued.value.value]]));
  assert.equal(cancel.value.state, 'complete', 'The butler may cancel');
  const item = (await page.evaluate(() => workspace.initial())).room.queue.find(i => i.id === queued.value.value);
  assert.deepEqual([item.status, item.addedBy, item.finishedBy, item.creator.kind], ['cancelled', 'steward', 'steward', 'secretary'], 'Each said to be the butler\'s, in a form older builds read');
  const unknown = await control(invoke('madeUpCommand', []));
  assert.deepEqual([unknown.value.state, unknown.value.reason], ['not-executed', 'unknown-command']);
  save('calls', { snap: snap.value.state, queued: queued.value, cancel: cancel.value, unknown: unknown.value });

  // 2. The butler's menu offers its record; the dialog lists each step, newest first, with how it ended.
  const items = await openRecord();
  assert.ok(items.indexOf(say('menu.stewardRecord')) >= 0 && items.indexOf(say('menu.stewardRecord')) < items.indexOf(say('menu.stewardChange')), 'Offered first on the butler\'s menu');
  let seen = await dialogText();
  assert.equal(seen.current, say('stewardRecord.current', { name: 'Codex 管家' }));
  const space = (await page.evaluate(() => workspace.stewardRecord())).entries.find(e => e.spaceAction === 'queueAdd').space;
  assert.deepEqual(seen.rows.map(r => r.slice(1, 2)[0]), [
    say('stewardRecord.step.method', { method: 'madeUpCommand' }),
    say('stewardRecord.step.queueCancel', { space }),
    say('stewardRecord.step.snapshot'),
    say('stewardRecord.step.queueAdd', { text: '首页换新标题', space }),
    say('stewardRecord.step.snapshot'),
    say('stewardRecord.role.designated', { name: 'Codex 管家' })], JSON.stringify(seen.rows));
  assert.equal(seen.rows[0][2], say('stewardRecord.reason.unknown-command'), 'A refusal NAW did not save as an operation is in the record');
  assert.equal(seen.rows[1][2], say('stewardRecord.result.complete'));
  assert.equal(seen.rows[2][2], say('stewardRecord.result.complete')); assert.equal(seen.rows[3][2], say('stewardRecord.result.complete')); assert.equal(seen.rows[4][2], say('stewardRecord.result.complete'));
  assert.ok(seen.attention >= 1, 'The refused row stands out');
  assert.ok(seen.note.includes(say('stewardRecord.note')));
  await shot('zh-1280-steward-record');
  checks.push('The butler queues and cancels a task without being the secretary, both said to be the butler\'s; its menu offers 「大管家的记录」 first, listing reading the state, the queued task, the cancel and the unknown command, newest first, each with how it ended; reading the command list is not a step');

  // 3. The record is the person's: an agent call for it is not a command, and the butler's calls left the record on disk.
  const asAgent = await control(invoke('stewardRecord', []));
  assert.deepEqual([asAgent.value.state, asAgent.value.reason], ['not-executed', 'unknown-command']);
  const lines = fs.readdirSync(path.join(profile, 'history/steward')).filter(n => /\.jsonl$/.test(n)).map(n => fs.readFileSync(path.join(profile, 'history/steward', n), 'utf8')).join('');
  const values = lines.split('\n').filter(Boolean).map(l => JSON.parse(l).value); save('record-lines', values);
  assert.ok(values.every(v => !Object.hasOwn(v, 'value')), 'No line keeps a result');
  assert.equal(JSON.stringify(values).includes('Claude 前端'), false, 'Nothing the snapshot returned (the other session\'s name) is kept');
  await page.keyboard.press('Escape'); await page.locator('#steward-record-dialog').waitFor({ state: 'hidden' });
  checks.push('An agent asking for the record is refused as an unknown command (and that try is itself a step); no result is kept on disk');

  // 4. Small window and English.
  await size(850, 600); await openRecord(); await shot('zh-850-steward-record');
  const fits = await page.evaluate(() => { const d = document.getElementById('steward-record-dialog').getBoundingClientRect(); return d.left >= 0 && d.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth; });
  assert.equal(fits, true, 'The dialog fits the small window');
  await page.keyboard.press('Escape'); await size(1280, 800);
  await page.locator('#setup-button').click(); await page.locator('#ui-language').selectOption('en');
  await until(async () => await page.locator('#ui-language').getAttribute('aria-busy') === 'false' && await page.locator('#setup-title').innerText() === locale.format('en', 'common.settings'), 'English');
  await page.locator('#close-setup').click(); await page.locator('#setup-dialog').waitFor({ state: 'hidden' });
  await openRecord(); seen = await dialogText();
  assert.equal(seen.current, locale.format('en', 'stewardRecord.current', { name: 'Codex 管家' }));
  assert.equal(seen.rows.find(r => r[1] === locale.format('en', 'stewardRecord.step.snapshot'))?.[2], locale.format('en', 'stewardRecord.result.complete'));
  await shot('en-1280-steward-record');
  checks.push('In the 850 by 600 window the dialog fits; in English its words are English');

  // 5. Revoking keeps the record; the dialog of nobody designated is not offered (no butler row), the record stays on disk.
  await page.keyboard.press('Escape'); await page.evaluate(() => workspace.steward(null));
  await until(async () => await page.locator('#steward-slot .session-row').count() === 0, 'Revoked');
  const after = await page.evaluate(() => workspace.stewardRecord());
  assert.equal(after.current, null); assert.equal(after.entries[0].kind, 'role'); assert.equal(after.entries[0].event, 'revoked');
  checks.push('After revoking, the record keeps every step and says the butler was revoked');

  assert.deepEqual(errors, []);
  const stats = await fixture('stats'); assert.equal(stats.nativeProcesses, 0); assert.equal(stats.modelCalls, 0);
  save('result', { passed: true, checks, shots, nativeProgramsStarted: 0, modelCalls: 0 });
  console.log(JSON.stringify({ passed: true, checks: checks.length, shots }));
}
(async () => { try { await run(); } catch (e) {
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {});
    save('result', { passed: false, checks, error: e.stack, errors }); console.error(e.stack); process.exitCode = 1; }
  finally {
    if (helper) helper.stdin.end();
    if (client) client.close();
    await scratch.release();
    const owner = JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))); if (owner.token === token) fs.rmSync(slot, { recursive: true });
  }
})();
