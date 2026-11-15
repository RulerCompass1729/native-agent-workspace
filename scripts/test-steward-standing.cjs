// Actual standing-permission switch and synthetic native operations in a hidden Electron window.
// Hidden Electron, disposable profile, real renderer/IPC/confirmation handler;
// synthetic native transport only. No provider processes or product model calls.
const scratch = require('./fixtures/test-scratch.cjs');
const { revealDefaultSpace } = require('./fixtures/default-space.cjs');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { _electron } = scratch.playwright(require('playwright'));
const { connectService } = require('../app/service-connection.cjs');
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const { createSourceEntry } = require('./fixtures/synthetic-source-boot.cjs');
const { execFileSync } = require('node:child_process');
const output = process.env.NAW_EVIDENCE_DIR;
if (!output || !path.isAbsolute(output) || output.startsWith(root + path.sep)) throw Error('Private evidence directory required');
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
const pictures = process.env.NAW_PICTURES_DIR;
if (!pictures || !path.isAbsolute(pictures) || pictures.startsWith(root + path.sep)) throw Error('An explicit private screenshot directory is required');
fs.mkdirSync(pictures, { recursive: true, mode: 0o700 });
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID();
fs.mkdirSync(path.dirname(slot), { recursive: true });
try { fs.mkdirSync(slot); } catch (e) { if (e.code !== 'EEXIST') throw e; console.error('GUI slot occupied'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ token, pid: process.pid, task: 'standing permission acceptance' }));
let child, client, app, page, helper, sequence = 0; const errors = [], checks = [];
const profile = fs.realpathSync(scratch.directory(path.join(os.tmpdir(), 'naw-standing-ui-')));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { for (let i = 0; i < 200; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
const record = name => { checks.push(name); console.log('PASS', name); };
function checkForeground() {
  const pid = Number(execFileSync('osascript', ['-l', 'JavaScript', '-e',
    "ObjC.import('AppKit'); Number($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier)"], { encoding: 'utf8' }).trim());
  assert.ok(Number.isSafeInteger(pid) && pid > 1, 'Foreground app is observable');
  assert.notEqual(pid, app.process().pid, 'The hidden test app never becomes the foreground app');
}
function fixture(method, target, value) {
  const id = ++sequence, field = method === 'backgroundProof' ? 'proofRequestId' : 'requestId';
  if (method === 'backgroundComplete') { child.send({ id, method, target, value }); return Promise.resolve(); }
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
    execArgv: ['--require', path.join(root, 'scripts/fixtures/steward-standing-native.cjs')],
    env: { ...process.env, NAW_TEST_APP_ROOT: code, NAW_WORKSPACE: profile, NAW_APP_VERSION: require(path.join(code, 'package.json')).version },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Synthetic service ready');
  client = await connectService(profile, 'human-view');
  const source = await client.call('create', { provider: 'codex', cwd: profile, name: '工作管家', view: 'chat' });
  const peer = await client.call('create', { provider: 'claude', cwd: profile, name: '开发成员', skipPermissions: true, view: 'chat' });
  await client.call('join', peer, true);
  const state = await client.call('initial'), actor = state.sessions.find(s => s.id === source);
  // Seed only the synthetic designation. The tested permission is changed through the real user checkbox.
  new (require('../app/steward-role.cjs').StewardRole)(profile).set({ sessionId: source, nativeId: actor.nativeId });
  fs.writeFileSync(path.join(profile, 'views.json'), JSON.stringify([{ owner: 'human-view', active: true, selected: source, mode: 'chat' }]), { mode: 0o600 });
  const entry = createSourceEntry({ profile, code, fixturePid: child.pid });
  app = await _electron.launch({ executablePath: require('electron'), args: [entry],
    env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#new-session').waitFor({ timeout: 45000 }); checkForeground();
  const rpc = mcp(); await rpc('initialize');
  async function control(method, args) {
    const request = { action: 'invoke', method, arguments: args, operation_id: randomUUID() };
    const proof = await fixture('backgroundProof', source, { callId: randomUUID(), arguments: request });
    const r = await rpc('tools/call', { name: 'workspace_control', arguments: request, _meta: { threadId: proof.nativeId, sessionId: proof.sessionId,
      callId: proof.callId, 'x-codex-turn-metadata': { thread_id: proof.nativeId, turn_id: proof.turnId } } });
    await fixture('backgroundComplete', source, { callId: proof.callId, arguments: request }); return JSON.parse(r.content[0].text);
  }
  const toggle = page.locator('[data-action="steward-standing"]'), dialog = page.locator('#steward-record-dialog');
  async function open() {
    await page.locator('#session-header-more').click();
    await page.getByRole('menuitem', { name: require('../app/ui-locale.js').format(await page.locator('html').getAttribute('lang') === 'en' ? 'en' : 'zh', 'menu.stewardRecord'), exact: true }).click();
    await toggle.waitFor();
  }
  const shots = [];
  async function shot(name, width, height = 820) {
    name = 'cost-' + name;
    await (await app.browserWindow(page)).evaluate((w, size) => w.setContentSize(size.width, size.height), { width, height }); await delay(200); checkForeground();
    if (name.includes('confirm')) {
      await page.locator('.background-card').filter({ hasText: '需确认的配置' }).evaluate(el => el.scrollIntoView({ block: 'start' }));await delay(100);
    }
    await page.screenshot({ path: path.join(pictures, name + '.png') }); shots.push(name + '.png');
  }
  await open(); assert.equal(await toggle.isChecked(), false); await shot('zh-off-850', 850);
  await toggle.check(); await until(async () => (await page.evaluate(() => workspace.stewardStanding())).on, 'Person enables standing permission');
  await shot('zh-on-1240', 1240); await shot('zh-on-850', 850); await dialog.getByRole('button', { name: '完成', exact: true }).click();
  const unknown = await control('stewardStanding', [true]); assert.equal(unknown.state, 'not-executed'); assert.equal(unknown.reason, 'unknown-command');
  record('switch defaults off; person can enable it; agent cannot invoke it');
  const sessionsBefore = (await page.evaluate(() => workspace.initial())).sessions.length;
  const changed = await control('create', [{ provider: 'claude', cwd: profile, name: '需确认的配置', skipPermissions: true,
    settings: { model: 'synthetic-model-b', effort: 'max' } }]);
  assert.equal(changed.state, 'confirmation-required'); assert.equal(changed.approvedBy, undefined);
  assert.match(changed.confirmation.options.detail, /synthetic-model-b/); assert.match(changed.confirmation.options.detail, /max/);
  assert.equal((await page.evaluate(() => workspace.initial())).sessions.length, sessionsBefore);
  const card = page.locator('.background-card').filter({ hasText: '需确认的配置' });await card.waitFor();
  await page.locator('#chat-maximize').click();
  await card.locator('details summary').click();await shot('zh-confirm-1240',1240);await shot('zh-confirm-850',850);
  await shot('zh-confirm-full',850,1100);
  await page.evaluate(r => workspace.backgroundDecision(r.actor.id, r.actor.nativeId, r.id, 0), changed);
  await page.locator('#chat-maximize').click();
  const effortOnly = await control('create', [{ provider: 'claude', cwd: profile, name: '需确认的思考强度', skipPermissions: true,
    settings: { model: 'synthetic-model-a', effort: 'max' } }]);
  assert.equal(effortOnly.state, 'confirmation-required');
  await page.evaluate(r => workspace.backgroundDecision(r.actor.id, r.actor.nativeId, r.id, 0), effortOnly);
  record('changed model or effort asks before creating a session; the real card contains both selections');
  const matching = await control('create', [{ provider: 'claude', cwd: profile, name: '同配置成员', skipPermissions: true,
    settings: { model: 'synthetic-model-a', effort: 'low' } }]);
  assert.equal(matching.state, 'complete');assert.equal(matching.approvedBy, 'standing');
  assert.deepEqual(matching.standing.creation, { model: 'synthetic-model-a', effort: 'low' });
  const created = await control('create', [{ provider: 'claude', cwd: profile, name: '新开发成员', skipPermissions: true, view: 'chat' }]);
  assert.equal(created.state, 'complete', JSON.stringify(created)); assert.equal(created.approvedBy, 'standing');
  const joined = await control('join', [created.value, true]); assert.equal(joined.state, 'complete', JSON.stringify(joined)); assert.equal(joined.approvedBy, 'standing');
  await fixture('backgroundReport', created.value);
  const archived = await control('archiveSession', [created.value]); assert.equal(archived.state, 'complete', JSON.stringify(archived)); assert.equal(archived.approvedBy, 'standing');
  const s = await page.evaluate(() => workspace.initial()); assert.equal(s.backgroundConfirmations.length, 0);
  const lines = s.room.events.filter(e => e.controlAudit?.approvedBy === 'standing');
  assert.equal(lines.length, 4); assert.ok(lines.every(e => e.uiMessage.params.undo));
  const createdLine = lines.find(e => e.controlAudit.operationId === matching.id);
  assert.deepEqual(createdLine.controlAudit.creation, { model: 'synthetic-model-a', effort: 'low' });
  assert.match(createdLine.uiMessage.params.target, /synthetic-model-a/);assert.match(createdLine.uiMessage.params.target, /low/);
  const defaultLine = lines.find(e => e.controlAudit.operationId === created.id);
  assert.deepEqual(defaultLine.controlAudit.creation, { model: null, effort: null });assert.match(defaultLine.uiMessage.params.target, /原生默认/);
  record('matching settings and provider defaults stay covered and appear in durable audit');
  record('real MCP create, join and archive execute without cards; durable audit lines and standing receipts');
  await revealDefaultSpace(page); await page.locator('#room-nav').click(); await page.locator('#room-record').click();
  await shot('zh-audit-1240', 1240); await shot('zh-audit-850', 850);
  await page.locator('#setup-button').click(); await page.locator('#ui-language').selectOption('en');
  await until(async () => await page.locator('#setup-title').innerText() === 'Settings', 'English accepted'); await page.locator('#close-setup').click();
  await shot('en-audit-850', 850);
  await page.locator(`#steward-slot .session-link[data-session-id="${source}"]`).click(); await open();
  await shot('en-on-1240', 1240); await shot('en-on-850', 850); await toggle.uncheck();
  assert.equal((await page.evaluate(() => workspace.stewardStanding())).on, false); await shot('en-off-850', 850);
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  const asks = await control('spaceCreate', ['要确认的空间']); assert.equal(asks.state, 'confirmation-required');
  await page.evaluate(r => workspace.backgroundDecision(r.actor.id, r.actor.nativeId, r.id, 0), asks);
  record('turning it off restores confirmation');
  const stats = await fixture('stats'); assert.equal(stats.modelCalls, 0); assert.equal(stats.nativeProcesses, 0); assert.deepEqual(errors, []);
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ visible: w.isVisible(), focused: w.isFocused() })));
  assert.ok(windows.every(w => !w.visible && !w.focused));
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ checks, shots, stats, windows, errors }, null, 2));
  fs.writeFileSync(path.join(pictures, 'index.html'), '<!doctype html><meta charset="utf-8"><title>常设许可 · 待用户看图</title><style>body{font:16px sans-serif;max-width:1200px;margin:30px auto}img{width:100%;border:1px solid #ccc}</style><h1>大管家常设许可 · 待你看图确认</h1><p>用户开一次；每小时最多30次本地整理。模型和思考强度仅原生默认或与同一已有成员一致；其他配置仍确认。可随时关，每次有记录和撤销办法。</p>' + shots.map(s => `<h2>${s}</h2><a href="${s}"><img loading="lazy" src="${s}"></a>`).join(''));
  console.log(JSON.stringify({ pass: checks.length, fail: 0, skip: 0, screenshots: shots.length, modelCalls: 0 }));
}
main().catch(async e => { console.error(e.stack); process.exitCode = 1; if (page && !page.isClosed()) {
  await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); fs.writeFileSync(path.join(output, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); }
}).finally(scratch.cleanup(async () => {
  helper?.stdin.end(); if (app) await app.close().catch(() => {});
  if (client) { await client.call('shutdown').catch(() => {}); client.close(); }
  if (child?.connected) child.disconnect(); if (child?.exitCode === null) child.kill('SIGTERM');
  const owner = JSON.parse(fs.readFileSync(path.join(slot, 'owner.json')));
  if (owner.token === token) { fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot); }
}));

