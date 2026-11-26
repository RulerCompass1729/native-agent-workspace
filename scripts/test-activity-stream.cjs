// Hidden Electron, disposable profile, real renderer/IPC/confirmation handler;
// synthetic native transport only. No provider processes or product model calls.
const scratch = require('./fixtures/test-scratch.cjs');
const { revealDefaultSpace } = require('./fixtures/default-space.cjs'), boardWaiting = require('./fixtures/board-waiting.cjs');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { _electron } = scratch.playwright(require('playwright'));
const { connectService } = require('../app/service-connection.cjs');
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const before = process.argv.includes('--before');
const output = process.env.NAW_EVIDENCE_DIR;
if (!output || !path.isAbsolute(output) || output.startsWith(root + path.sep)) throw Error('Private evidence directory required');
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
const pictures = path.join(process.env.NAW_PICTURES_DIR || path.join(os.homedir(), 'Pictures/naw-dogfood'), process.env.NAW_STREAM_SHOTS || 'stream-b-' + randomUUID());
fs.mkdirSync(pictures, { recursive: true, mode: 0o700 });
const slot = path.join(root, '.local/gui-test-slot.lock'), token = randomUUID();
fs.mkdirSync(path.dirname(slot), { recursive: true });
try { fs.mkdirSync(slot); } catch (e) { if (e.code !== 'EEXIST') throw e; console.error('GUI slot occupied'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ token, pid: process.pid, task: 'stream B hidden synthetic test' }));
let child, client, app, page, helper, sequence = 0; const errors = [], checks = [];
const profile = fs.realpathSync(scratch.directory(path.join(os.tmpdir(), 'naw-stream-b-')));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { for (let i = 0; i < 200; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
const record = name => { checks.push(name); console.log('PASS', name); };
function fixture(method, target, value) {
  const id = ++sequence, field = method === 'backgroundProof' ? 'proofRequestId' : 'requestId';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.off('message', cb); reject(Error('Fixture timeout: ' + method)); }, 10000);
    const cb = r => { if (r[field] === id) { clearTimeout(timer); child.off('message', cb); r.error ? reject(Error(r.error)) : resolve(r); } };
    child.on('message', cb); child.send({ id, method, target, value });
  });
}
function mcp() {
  helper = scratch.childProcess.spawn(process.execPath, [path.join(code, 'app/claude-message-tool.cjs'), '--codex'], {
    env: { ...process.env, NAW_CONTROL_DESCRIPTOR: path.join(profile, 'outbox-owner.json') }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = ''; const pending = new Map();
  helper.stdout.setEncoding('utf8'); helper.stdout.on('data', chunk => { buffer += chunk; let end; while ((end = buffer.indexOf('\n')) >= 0) {
    const r = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); pending.get(r.id)?.(r); pending.delete(r.id);
  } }); helper.stderr.on('data', value => errors.push(String(value)));
  return (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => reject(Error('MCP timeout')), 20000);
    pending.set(id, r => { clearTimeout(timer); r.error ? reject(Error(JSON.stringify(r.error))) : resolve(r.result); });
    helper.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
async function main() {
  child = scratch.childProcess.fork(path.join(code, 'app/daemon.cjs'), [profile], {
    execArgv: ['--require', path.join(root, 'scripts/fixtures/activity-stream.cjs')],
    env: { ...process.env, NAW_TEST_APP_ROOT: code, NAW_WORKSPACE: profile, NAW_APP_VERSION: require(path.join(code, 'package.json')).version }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Service starts');
  client = await connectService(profile, 'human-view');
  const ids = [];
  for (const name of ['Codex A', 'Claude B', 'Codex C', 'Claude D', 'Codex E', 'Claude F']) {
    const id = await client.call('create', { provider: name.startsWith('Claude') ? 'claude' : 'codex', cwd: profile, name, view: 'chat' });
    ids.push(id); await client.call('join', id, true);
  }
  await fixture('streamSeed', ids[0]);
  fs.writeFileSync(path.join(profile, 'views.json'), JSON.stringify([{ owner: 'human-view', active: true, selected: 'room', mode: 'chat',
    roomViews: { shared: { roomSurface: 'records' } } }]), { mode: 0o600 });
  app = await _electron.launch({ executablePath: require('electron'), args: [code], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid), NAW_TEST_UI_LANGUAGE: 'zh' }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message));
  await revealDefaultSpace(page);
  // The saved view already opens the space, and its members and record leave the sidebar as a rail at this width.
  if (!(await page.locator('#activity-stream').isVisible())) { await page.locator('#room-nav').waitFor(); await page.locator('#room-nav').click(); }
  if (!before) { await page.locator('#activity-stream').waitFor(); assert.ok(await page.locator('#collaboration-overview').isVisible()); record('saved full-page record view restores as sidebar beside members'); }
  const rpc = mcp(); await rpc('initialize');
  async function control(method, args) {
    const request = { action: 'invoke', method, arguments: args, operation_id: randomUUID() };
    const proof = await fixture('backgroundProof', ids[0], { callId: randomUUID(), arguments: request });
    const result = await rpc('tools/call', { name: 'workspace_control', arguments: request, _meta: { threadId: proof.nativeId, sessionId: proof.sessionId, callId: proof.callId,
      'x-codex-turn-metadata': { thread_id: proof.nativeId, turn_id: proof.turnId } } });
    await fixture('backgroundComplete', ids[0], { callId: proof.callId, arguments: request });
    return JSON.parse(result.content[0].text);
  }
  let request = await control('rename', [ids[1], 'Claude B · 已确认']);
  assert.equal(request.state, 'confirmation-required', JSON.stringify(request));
  if (!before) {
    const old = request; request = await control('rename', [ids[1], 'Claude B · 已确认']);
    assert.equal(request.state, 'confirmation-required', JSON.stringify(request));
    await until(async () => {
      const cards = (await page.evaluate(() => workspace.initial())).backgroundConfirmations;
      return cards.some(c => c.operationId === request.id) && !cards.some(c => c.operationId === old.id);
    }, 'Only the replacement confirmation stays in waiting'); record('superseded card excluded by actual replacement rules');
  }
  const win = await app.browserWindow(page);
  async function capture(size, view) {
    await win.evaluate((w, [width, height]) => w.setContentSize(width, height), size); await delay(600);
    const file = path.join(pictures, `${before ? 'before' : 'after'}-${size.join('x')}-${view}.png`);
    await page.screenshot({ path: file });
    const dimensions = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
    assert.ok(dimensions.scroll <= dimensions.width, 'No horizontal page overflow');
    console.log('SHOT', file); record('screenshot ' + size.join('x') + ' ' + view);
  }
  if (before || !await page.locator('#activity-stream').isVisible()) await page.locator('#room-record').click();
  for (const size of [[1240, 820], [850, 600]]) await capture(size, 'stream');
  if (before) {
    assert.equal(await page.locator('#activity-stream').count(), 0);
    assert.equal(await page.locator('#stream-waiting').count(), 0);
    record('baseline lacks stream and waiting strip');
  } else {
    await page.locator('#activity-stream').waitFor();
    assert.ok(await page.locator('#collaboration-overview').isVisible()); record('stream keeps member overview visible');
    const times = await page.locator('.stream-row time').evaluateAll(nodes => nodes.map(n => Date.parse(n.dateTime)).filter(Number.isFinite));
    assert.deepEqual(times, [...times].sort((a, b) => b - a)); assert.ok(await page.locator('.stream-day').count() >= 2); record('descending timestamps with date separators');
    // A record is one line; the way to its original is in the part it opens to.
    const original = async id => {
      const row = page.locator(`[data-record-id="${id}"]`);
      if (!await row.locator('details').evaluate(d => d.open)) await row.locator('summary').click();
      await row.locator('.stream-record-link').click();
    };
    await original(`control:codex:${request.actor.nativeId}:${request.id}`);
    await until(() => page.locator(`[data-message-id="background:${request.actor.nativeId}:${request.id}"][data-search-target]`).isVisible(), 'Exact original operation card selected'); record('audit opens its exact original confirmation card');
    await page.locator('#room-nav').click();
    assert.match(await page.locator('[data-record-id="shared-copy-1"] .disclosure-title').innerText(), /Claude B/); record('shared message identifies its real sender');
    await original('shared-copy-1');
    await until(() => page.locator('[data-message-id="native-original-1"][data-search-target]').isVisible(), 'Exact original selected'); record('click opens exact original message');
    // What waits for the person is on the task board (R250); its card opens in place in the row.
    const board = boardWaiting(page);
    assert.equal(await page.locator('#stream-waiting').count(), 0); assert.ok(await board.need().isVisible()); record('the board, not the stream, counts the waiting card');
    const key = r => [r.actor.id, r.actor.nativeId, r.id].join(':'), pending = await board.expand(key(request));
    for (const size of [[1240, 820], [850, 600]]) await capture(size, 'waiting');
    const clock = pending.locator('.background-state[data-expires-at]'), first = await clock.textContent(); await delay(1600);
    assert.notEqual(await clock.textContent(), first); record('the card opened on the board keeps counting down');
    await pending.getByRole('button', { name: request.confirmation.options.buttons[0], exact: true }).click();
    await until(() => pending.count().then(n => n === 0), 'Cancelled card leaves waiting');
    assert.equal((await client.call('initial')).sessions.find(s => s.id === ids[1]).name, 'Claude B'); record('board cancellation uses original handler without rename');
    const confirm = await control('rename', [ids[1], 'Claude B · 已确认']);
    await until(() => board.row(key(confirm)).count().then(n => n === 1), 'New confirmation listed');
    // The card names its confirm button 确认 (its primary), not the operation's option text.
    await (await board.expand(key(confirm))).locator('.background-buttons .primary').click();
    await until(async () => (await page.evaluate(() => workspace.initial())).sessions.find(s => s.id === ids[1]).name === 'Claude B · 已确认', 'Rename confirmed'); record('board confirmation uses original handler');
    await board.close();
    await page.locator('#room-nav').click();
    if (!await page.locator('#activity-stream').isVisible()) await page.locator('#room-record').click();
    await original('without-original');
    await until(() => page.locator('#title').innerText().then(text => text.includes('Codex A')), 'Fallback opens original session'); record('legacy record falls back to original session');
  }
  const stats = await fixture('stats'); assert.equal(stats.modelCalls, 0); assert.equal(stats.nativeProcesses, 0);
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ visible: w.isVisible(), focused: w.isFocused() })));
  assert.ok(windows.length && windows.every(w => !w.visible && !w.focused)); record('owned windows remain hidden and unfocused');
  assert.deepEqual(errors, []); record('zero renderer errors and model calls');
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ before, checks, pictures, stats, windows, errors }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, failed: 0, skipped: 0, pictures }));
}
main().catch(async e => { console.error(e.stack); process.exitCode = 1; if (page && !page.isClosed()) { await page.screenshot({ path: path.join(pictures, 'failure.png') }).catch(() => {}); fs.writeFileSync(path.join(output, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); } })
  .finally(scratch.cleanup(async () => {
    if (helper) helper.stdin.end();
    if (app) await app.close().catch(() => {});
    if (client) { await client.call('shutdown').catch(() => {}); client.close(); }
    if (child?.connected) child.disconnect();
    if (child?.exitCode === null) child.kill('SIGTERM');
    const owner = JSON.parse(fs.readFileSync(path.join(slot, 'owner.json')));
    if (owner.token === token) { fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot); }
  }));
