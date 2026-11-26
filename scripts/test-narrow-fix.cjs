// Narrow (850x600) visual regressions: confirmation button must not wrap, the
// shared-records panel must not cover the member grid, and member names must stay
// distinguishable. Hidden Electron, disposable profile, synthetic native transport.
const scratch = require('./fixtures/test-scratch.cjs');
const { revealDefaultSpace } = require('./fixtures/default-space.cjs'), boardWaiting = require('./fixtures/board-waiting.cjs');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { _electron } = scratch.playwright(require('playwright'));
const { connectService } = require('../app/service-connection.cjs');
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const tag = process.argv.includes('--before') ? 'before' : 'after';
const output = process.env.NAW_EVIDENCE_DIR;
if (!output || !path.isAbsolute(output) || [root, code].some(p => path.resolve(output) === p || path.resolve(output).startsWith(p + path.sep))) throw Error('Private evidence directory required');
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
const pictures = path.join(process.env.NAW_PICTURES_DIR || path.join(os.homedir(), 'Pictures/naw-dogfood'), 'narrow-fix-' + tag + '-' + randomUUID());
fs.mkdirSync(pictures, { recursive: true, mode: 0o700 });
const slot = path.join(code, '.local/gui-test-slot.lock'), token = randomUUID();
fs.mkdirSync(path.dirname(slot), { recursive: true });
try { fs.mkdirSync(slot); } catch (e) { if (e.code !== 'EEXIST') throw e; console.error('GUI slot occupied'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ token, pid: process.pid, task: 'narrow-fix hidden synthetic test' }));
let child, client, app, page, helper, sequence = 0; const checks = [], errors = [];
const profile = fs.realpathSync(scratch.directory(path.join(os.tmpdir(), 'naw-narrow-fix-')));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { for (let i = 0; i < 200; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
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
    env: { ...process.env, NAW_TEST_APP_ROOT: code, NAW_WORKSPACE: profile, NAW_APP_VERSION: require(path.join(code, 'package.json')).version },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
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
  await page.locator('#room-nav').waitFor(); await page.locator('#room-nav').click();
  await page.locator('#activity-stream').waitFor();
  const rpc = mcp(); await rpc('initialize');
  async function control(method, args) {
    const request = { action: 'invoke', method, arguments: args, operation_id: randomUUID() };
    const proof = await fixture('backgroundProof', ids[0], { callId: randomUUID(), arguments: request });
    const result = await rpc('tools/call', { name: 'workspace_control', arguments: request, _meta: { threadId: proof.nativeId, sessionId: proof.sessionId, callId: proof.callId,
      'x-codex-turn-metadata': { thread_id: proof.nativeId, turn_id: proof.turnId } } });
    await fixture('backgroundComplete', ids[0], { callId: proof.callId, arguments: request });
    return JSON.parse(result.content[0].text);
  }
  const request = await control('rename', [ids[1], 'Claude B · 已确认']);
  assert.equal(request.state, 'confirmation-required');
  // What waits for the person is on the task board (R250); its card opens in place in the row.
  const board = boardWaiting(page);
  await until(() => board.need().isVisible(), 'Board counts the waiting card');
  const win = await app.browserWindow(page);
  async function capture(size, view) {
    await win.evaluate((w, [width, height]) => w.setContentSize(width, height), size); await delay(600);
    const file = path.join(pictures, `${tag}-${size.join('x')}-${view}.png`);
    await page.screenshot({ path: file });
    console.log('SHOT', file);
  }
  // Main interface and the board with the card open, at both requested sizes.
  for (const size of [[1240, 820], [850, 600]]) await capture(size, 'main');
  await board.expand([request.actor.id, request.actor.nativeId, request.id].join(':'));
  for (const size of [[1240, 820], [850, 600]]) await capture(size, 'waiting');
  await board.close();
  // Assertions at 850x600.
  await win.evaluate(w => w.setContentSize(850, 600)); await delay(600);
  // Progressive layouts initially show only one card here. Measure all six names.
  const shownNames = page.locator('#collaboration-overview .collaboration-member-unit .collaboration-name-text:visible');
  for (let i = 0; i < ids.length && await shownNames.count() < ids.length; i++) {
    await page.locator('#collaboration-overview .collaboration-show-more').click();
  }
  await until(async () => await shownNames.count() === ids.length, 'All six member cards shown');
  const state = await page.evaluate(() => {
    const rect = s => { const r = document.querySelector(s)?.getBoundingClientRect(); return r ? { left: r.left, right: r.right, width: r.width } : null; };
    const messageButtons = () => [...document.querySelectorAll('.message .background-buttons button')];
    const cancel = messageButtons().find(b => b.textContent === '取消');
    const confirm = messageButtons().find(b => b.classList.contains('primary'));
    return {
      stream: rect('#activity-stream'), readers: rect('.collaboration-readers'),
      whiteSpace: confirm ? getComputedStyle(confirm).whiteSpace : null,
      confirmH: confirm?.clientHeight ?? null, cancelH: cancel?.clientHeight ?? null,
      names: [...document.querySelectorAll('#collaboration-overview .collaboration-member-unit .collaboration-name-text')].map(t => ({ name: t.textContent.trim(), width: t.clientWidth, content: t.scrollWidth }))
    };
  });
  // 1. The confirmation button stays on one line (no taller than the single-line cancel button).
  assert.notEqual(state.confirmH, null, 'confirmation button present');
  assert.ok(state.confirmH <= state.cancelH + 2, `confirmation button wraps (${state.confirmH}px vs ${state.cancelH}px)`);
  assert.equal(state.whiteSpace, 'nowrap', 'confirmation button text is not kept on one line');
  // 2. The shared-records panel does not cover the member grid.
  assert.ok(state.readers.right <= state.stream.left + 1, `panel overlaps grid (grid right ${state.readers.right}, panel left ${state.stream.left})`);
  // 3. Member names are not ellipsized, so each member stays distinguishable.
  assert.equal(state.names.length, ids.length, 'Every member name is measured');
  for (const name of state.names) assert.ok(name.width > 0 && name.content <= name.width, `member name truncated or hidden: ${name.name} (${name.content}px in ${name.width}px)`);
  const stats = await fixture('stats');
  assert.equal(stats.modelCalls, 0); assert.equal(stats.nativeProcesses, 0);
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ visible: w.isVisible(), focused: w.isFocused() })));
  assert.ok(windows.length && windows.every(w => !w.visible && !w.focused), 'owned windows hidden and unfocused');
  assert.deepEqual(errors, [], 'zero renderer errors');
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ tag, checks, pictures }, null, 2));
  console.log(JSON.stringify({ tag, passed: true, pictures }));
}
main().catch(async e => { console.error(e.stack); process.exitCode = 1; if (page && !page.isClosed()) { await page.screenshot({ path: path.join(pictures, 'failure.png') }).catch(() => {}); } })
  .finally(scratch.cleanup(async () => {
    if (helper) helper.stdin.end();
    if (app) await app.close().catch(() => {});
    if (client) { await client.call('shutdown').catch(() => {}); client.close(); }
    if (child?.connected) child.disconnect();
    if (child?.exitCode === null) child.kill('SIGTERM');
    const owner = JSON.parse(fs.readFileSync(path.join(slot, 'owner.json')));
    if (owner.token === token) { fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot); }
  }));
