// Existing compact reading journey, isolated source GUI and synthetic providers only.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const plan = { task: 'I111 Main compact-reading source GUI', fullGuiStarts: 1, ownedSyntheticDaemons: 1, syntheticSessions: 2, syntheticSends: 0, terminalInputs: 0, permissionReplies: 0, reloads: 1, productModels: 0, realProviders: 0, osClipboard: 0, maxRunMs: 300000 };
if (process.argv.includes('--plan')) { console.log(JSON.stringify(plan, null, 2)); process.exit(0); }
assert.equal(process.env.NAW_T33_COMPACT_GUI_AUTHORIZED, '1', 'Record the finite source GUI plan before running');
assert.ok(!process.env.NAW_APP_EXECUTABLE && path.resolve(code) === root, 'This recipe qualifies source only; Main owns installed acceptance');
const evidence = process.env.NAW_EVIDENCE_DIR;
assert.ok(evidence && path.isAbsolute(evidence), 'Private outside-repository evidence is required');
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.resolve(common, '..', '.local/gui-test-slot.lock'), token = randomUUID();
let existing = evidence;
while (!fs.existsSync(existing)) existing = path.dirname(existing);
const destination = path.resolve(fs.realpathSync(existing), path.relative(existing, evidence));
for (const repo of [fs.realpathSync(root), fs.realpathSync(path.resolve(slot, '../..'))]) assert.ok(destination !== repo && !destination.startsWith(repo + path.sep), 'Evidence must be outside both repositories');
try { fs.mkdirSync(slot); } catch (error) { if (error.code !== 'EEXIST') throw error; console.error('OCCUPIED: no profile, daemon or GUI started'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'CodexMain', task: plan.task, token, pid: process.pid, time: new Date().toISOString() }));
const testScratch = require('./fixtures/test-scratch.cjs');
const { fork } = testScratch.childProcess;
const { _electron } = testScratch.playwright(require('playwright'));
const { createIn } = require('./fixtures/create-view.cjs');
const { connect } = require(path.join(code, 'app/service-client.cjs'));
const env = additions => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NAW_') && !key.startsWith('ELECTRON_') && !['NODE_OPTIONS', 'NODE_PATH'].includes(key))), ...additions });
const profile = testScratch.directory(path.join(os.tmpdir(), 'naw-compact-ui-'));
const entry = path.join(profile, 'entry'); fs.mkdirSync(entry);
fs.writeFileSync(path.join(entry, 'package.json'), JSON.stringify({ name: 'naw-owned-compact-gui', version: require('../package.json').version, main: 'main.cjs' }));
fs.writeFileSync(path.join(entry, 'main.cjs'), `const cp=require('node:child_process'),path=require('node:path'),e=require('electron');
globalThis.compactGuards={clipboard:0,external:0,dialogs:0,maintenance:0,replacement:0};
const spawn=cp.spawn;cp.spawn=function(bin,args,...rest){if(Array.isArray(args)&&args.some(arg=>typeof arg==='string'&&path.basename(arg)==='daemon.cjs')){globalThis.compactGuards.replacement++;throw Error('Replacement backend prohibited');}return spawn.call(this,bin,args,...rest);};
for(const name of ['readText','writeText','readImage','writeImage','read','write','readBuffer','writeBuffer','clear'])e.clipboard[name]=()=>{globalThis.compactGuards.clipboard++;throw Error('OS clipboard prohibited');};
e.shell.openPath=e.shell.openExternal=async()=>{globalThis.compactGuards.external++;throw Error('External action prohibited');};
e.dialog.showOpenDialog=e.dialog.showMessageBox=async()=>{globalThis.compactGuards.dialogs++;throw Error('OS dialog prohibited');};
const {WorkspaceClient}=require(${JSON.stringify(path.join(root, 'app/workspace-client.cjs'))});WorkspaceClient.prototype.maintainService=function(){globalThis.compactGuards.maintenance++;throw Error('Backend update prohibited');};
require(${JSON.stringify(path.join(root, 'app/main.cjs'))});`);
const executablePath = require('electron'), args = [entry];
const child = fork(path.join(code, 'app/daemon.cjs'), [profile], { execArgv: ['--require', path.join(__dirname, 'fixtures/native-progress.cjs')], env: env({ NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_WORKSPACE: profile, NAW_TEST_APP_ROOT: code }), stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
let application, page, client, sequence = 0, failure; const errors = [], checks = [], metrics = [], guiPids = [], guardSamples = [];
const started = Date.now();
function check(text) { assert.ok(Date.now() - started < plan.maxRunMs, 'Five-minute stage-entry budget'); checks.push(text); console.log('PASS:', text); }
async function guards() { const values = await application.evaluate(() => globalThis.compactGuards); assert.deepEqual(values, { clipboard: 0, external: 0, dialogs: 0, maintenance: 0, replacement: 0 }); guardSamples.push(values); }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { for (let i = 0; i < 200; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
function fixture(method = 'stats', target, value) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const cb = m => { if (m.requestId === id) { clearTimeout(timer); child.off('message', cb); m.error ? reject(Error(m.error)) : resolve(m); } };
    const timer = setTimeout(() => { child.off('message', cb); reject(Error('Fixture timeout')); }, 20000);
    child.on('message', cb); child.send({ id, method, target, value });
  });
}
const snapshot = () => page.evaluate(() => workspace.initial());
// The native terminal beside the chat is the only live screen (the readonly progress panel was removed).
const nativePane = id => page.locator(`[data-terminal-id="${id}"]`);
async function create(provider) {
  await page.locator('#new-session').click(); await page.locator(`input[name="provider"][value="${provider}"]`).check();
  await page.locator('#session-name').fill(provider + ' · 实时过程'); await createIn(page, 'chat');
  await until(async () => (await snapshot()).sessions.some(s => s.provider === provider && s.state === 'idle'), 'Created');
  const id = (await snapshot()).sessions.find(s => s.provider === provider).id;
  await until(() => nativePane(id).locator('.xterm').count(), 'Native screen'); return id;
}
async function screen(id) {
  return page.evaluate(id => {
    const t = [...window.progressTestTerminals].reverse().find(t => t.element?.isConnected && t.element.closest('[data-terminal-id]')?.dataset.terminalId === id);
    if (!t) return null;
    const b = t.buffer.active;
    return { cols: t.cols, rows: t.rows, type: b.type, cursor: [b.cursorX, b.cursorY], lines: Array.from({ length: b.length }, (_, i) => b.getLine(i).translateToString()) };
  }, id);
}
async function aligned(id) {
  // The canonical screen follows native resizes too, so compare with its latest state.
  await until(async () => JSON.stringify(await screen(id)) === JSON.stringify((await fixture('stats', id)).screen), 'Canonical screen alignment');
}
async function capture(name) {
  if (!page || page.isClosed()) return;
  fs.mkdirSync(evidence, { recursive: true });
  await page.screenshot({ path: path.join(evidence, name + '.png') });
  fs.writeFileSync(path.join(evidence, name + '.json'), JSON.stringify(await snapshot(), null, 2));
}
async function join(id) {
  const room = (await snapshot()).rooms.find(room => room.id === 'shared');
  await page.locator(`[data-session-menu="${id}"]`).click();
  await page.getByRole('menuitem', { name: `加入「${room.name}」`, exact: true }).click();
  await until(async () => (await snapshot()).sessions.find(s => s.id === id).roomIds?.includes('shared'), 'Visible membership acknowledged');
}
async function run() {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Daemon'); client = await connect(profile, 'observer-test');
  const backend = await client.call('initial'); assert.equal(backend.servicePid, child.pid); assert.equal(backend.runtimeVersion, require('../package.json').version); assert.equal(backend.sessions.length, 0);
  application = await _electron.launch({ executablePath, args, env: env({ NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }), timeout: 70000 });
  guiPids.push(application.process().pid);
  page = await application.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message)); await page.locator('#new-session').waitFor();
  // Test-only inspection of the actual xterm instances; no production debug API.
  await page.evaluate(() => {
    window.progressTestTerminals = []; window.progressTestLatencies = [];
    const open = Terminal.prototype.open;
    Terminal.prototype.open = function (...args) { window.progressTestTerminals.push(this); return open.apply(this, args); };
    new MutationObserver(records => { for (const r of records) if (r.attributeName === 'data-paint-latency') window.progressTestLatencies.push(Number(r.target.dataset.paintLatency)); }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-paint-latency'] });
  });

  async function measure(label, room = false, { content = true } = {}) {
    await delay(150);
    const m = await page.evaluate(({ label, room }) => {
      const list = document.querySelector(room ? '#room-messages' : '#messages');
      const input = document.querySelector(room ? '#shared-input' : '#message-input');
      const send = document.querySelector(room ? '#forward-button' : '#send-button');
      const progress = document.querySelector('#native-pane');
      const css = getComputedStyle(list), a = input.getBoundingClientRect(), b = send.getBoundingClientRect();
      return { label, contentHeight: list.clientHeight - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom), contentWidth: list.clientWidth,
        progressHeight: progress?.clientHeight || 0, inputBottom: a.bottom, sendBottom: b.bottom, height: innerHeight,
        inputVisible: a.top >= 0 && a.bottom <= innerHeight, sendVisible: b.top >= 0 && b.bottom <= innerHeight };
    }, { label, room });
    metrics.push(m); await capture(label);
    if (content) assert.ok(m.contentHeight >= 96, label + ': four lines of readable body: ' + JSON.stringify(m));
    assert.ok(m.inputVisible && m.sendVisible, label + ': input and send stay in the window: ' + JSON.stringify(m));
    return m;
  }
  const size = (width, height) => application.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].setSize(...s), [width, height]);
  await size(850, 600);
  const a = await create('claude');
  await fixture('history', a, [{ id: 'answer', type: 'agentMessage', text: '这是需要完整阅读的回答。\n'.repeat(30) }]);
  await fixture('output', a, { data: '原生实时输出\r\n'.repeat(35) }); await aligned(a);
  const draft = '保留中文草稿，不发送。\n'.repeat(12);
  await page.locator('#message-input').fill(draft);
  const before = await measure('solo-compact');
  // Hiding the terminal gives the chat the room; bringing it back keeps the canonical screen.
  await page.locator('#close-native-terminal').click();
  const collapsed = await measure('solo-collapsed');
  // In the compact side-by-side layout the terminal takes width, not height.
  assert.ok(collapsed.contentWidth > before.contentWidth && collapsed.contentHeight >= before.contentHeight, JSON.stringify({ before, collapsed }));
  await page.locator('#terminal-tab').focus(); await page.keyboard.press('Enter'); await page.locator('#chat-tab').click();
  await measure('solo-expanded'); await aligned(a);
  assert.equal(await page.locator('#message-input').inputValue(), draft);
  check('Minimum window preserves four readable lines, input and send; hiding and restoring the terminal by pointer and keyboard keeps canonical output and unsent draft');

  await join(a);
  const b = await create('codex');
  await fixture('output', b, { data: '另一个原生会话的过程\r\n'.repeat(35) });
  await join(b);
  await page.locator('#room-nav').click(); await page.locator('#room-record').click();
  await page.locator('#shared-input').fill('共同讨论的草稿，不发送');
  await measure('room-compact', true); await aligned(a); await aligned(b);
  for (let n = 0; n < 3; n++) {
    const box = await page.locator('#shared-input').boundingBox();
    await page.mouse.move(box.x + box.width - 4, box.y + box.height - 4);
    await page.mouse.down(); await page.mouse.move(box.x + box.width - 4, box.y + box.height + 56, { steps: 12 }); await page.mouse.up();
  }
  assert.ok((await page.locator('#shared-input').boundingBox()).height >= await page.evaluate(() => Math.min(190, innerHeight * .22 - 2)), 'Actual resize reaches the responsive input height limit');
  await measure('room-tall-draft', true);
  await page.locator('#room-overview').click();
  await page.locator(`.collaboration-member-status[data-member-id="${a}"] .collaboration-member-name`).click();
  await page.locator('#terminal-tab').click();
  await page.locator('#terminal-area .xterm:visible').waitFor();
  await nativePane(a).locator('.xterm').waitFor({ state: 'visible' }); await aligned(a);
  await delay(150); const memberTerminal = await page.locator('#terminal-area').boundingBox();
  metrics.push({ label: 'member-terminal-compact', terminalHeight: memberTerminal.height });
  assert.ok(memberTerminal.height >= 200, 'Member terminal height: ' + JSON.stringify(memberTerminal));
  await capture('member-terminal-compact');
  // A focused member uses the same nested split in every responsive band.
  for (const [width, height] of [[1200, 900], [850, 900], [850, 600]]) {
    await size(width, height); await page.locator('#terminal-maximize').click();
    await until(async () => await page.locator('#terminal-maximize').getAttribute('aria-label') === '\u6062\u590d\u5e76\u6392', 'Member terminal maximize acknowledged');
    await delay(150);
    const layout = await page.locator('#session-layout').boundingBox(), pane = await page.locator('#native-pane').boundingBox();
    assert.ok(pane.width >= layout.width - 2 && pane.height >= layout.height - 2, 'Maximized member terminal fills its reading area: ' + JSON.stringify({ width, height, layout, pane }));
    assert.equal(await page.locator('#conversation-pane').isHidden(), true);
    assert.equal(await page.locator('#session-layout > .split-divider').isHidden(), true);
    await capture(`member-maximized-${width}-${height}`);
    await page.locator('#terminal-maximize').click();
    await until(async () => await page.locator('#terminal-maximize').getAttribute('aria-label') === '\u653e\u5927\u7ec8\u7aef', 'Member split restored');
    await aligned(a);
  }
  await size(850, 600);
  await page.locator(`[data-session-id="${a}"]`).click(); await page.locator('#chat-tab').click();
  await measure('solo-from-room');
  assert.equal(await page.locator('#message-input').inputValue(), draft);
  await page.locator('#room-nav').click();
  await page.locator('#room-record').click();
  assert.equal(await page.locator('#shared-input').inputValue(), '共同讨论的草稿，不发送');
  await size(1200, 900); await measure('room-wide', true);
  check('Shared timeline and member conversation remain readable with both canonical live panes; switching retains separate drafts');

  await size(850, 600); await page.locator(`[data-session-id="${b}"]`).click(); await page.locator('#chat-tab').click();
  await fixture('approval', b, { requestId: 17, method: 'item/commandExecution/requestApproval', params: { command: 'echo synthetic\n'.repeat(30), cwd: '/synthetic', reason: '不执行命令，仅核对紧凑窗口' } });
  await page.locator('#approval').waitFor();
  // Beside the terminal at 850×600 the confirmation leaves no conversation lines
  // (T-36, kept as designed); its decision stays keyboard-reachable and the input visible.
  await measure('permission-compact', false, { content: false });
  const decision = page.locator('#approval').getByRole('button', { name: '允许这一次', exact: true });
  await decision.focus();
  assert.ok(await page.locator('#approval').evaluate(el => el.scrollTop > 0));
  await decision.click({ trial: true });
  await capture('permission-actions-reachable');
  // The workaround: a window wider than 900 px. Narrower windows tested from 650 to
  // 850 px tall all fall short (taller ones stack the terminal below), and hiding the
  // terminal does not help; at 1000×600 four conversation lines stay beside it.
  const compact = await screen(b);
  await size(1000, 600); await measure('permission-wider-window');
  // Back to the compact window: wait for the terminal to refit, then for native to follow.
  await size(850, 600); await until(async () => { const now = await screen(b); return now.cols === compact.cols && now.rows === compact.rows; }, 'Terminal refits to the compact window');
  await aligned(b);
  assert.equal((await fixture()).stats.sends, 0);
  assert.deepEqual((await fixture('stats', b)).approvalReplies, [], 'No permission reply sent');
  check('A long confirmation at 850×600 keeps its decision reachable and the input visible; a 1000×600 window keeps four conversation lines beside it; no decision or task sent');

  await fixture('stop');
  await until(async () => (await snapshot()).sessions.every(s => s.state === 'ended'), 'Ended');
  // An ended session keeps its last received native screen beside the chat.
  await page.locator(`[data-session-id="${b}"]`).click(); await page.locator('#chat-tab').click();
  await until(async () => (await nativePane(b).innerText()).includes('另一个原生会话的过程'), 'Last frame kept after ending');
  await aligned(b); await capture('ended-retained-frame');
  await page.locator(`[data-session-id="${a}"]`).click(); await page.locator('#chat-tab').click();
  await until(async () => (await nativePane(a).innerText()).includes('原生实时输出'), 'Ended session keeps its last frame');
  await measure('ended-session');
  assert.equal(await page.locator('#message-input').inputValue(), draft);
  assert.match(await page.locator('#messages').textContent(), /这是需要完整阅读的回答/);
  check('Ended sessions keep their last native screen beside the chat; saved history and the draft stay readable in the compact window');
  // Seed real persisted recovery copies; the UI must handle their geometry
  // independently of the separate ownership-conflict acceptance test.
  await page.evaluate(async id => {
    for (let i = 1; i <= 3; i++) await workspace.retainDraftRecovery(id, `合成待恢复副本 ${i}\n` + '保留副本正文。\n'.repeat(12));
  }, a);
  await page.reload(); await page.locator('#new-session').waitFor();
  // After reloading, this window holds no terminal for the ended session; the pane says so.
  await until(async () => (await page.locator('#terminal-empty').isVisible()) && (await page.locator('#terminal-empty').innerText()) === '会话已结束，本窗口没有保留它的原生终端画面。', 'Ended session without a kept screen says so');
  check('An ended session whose screen this window never kept says it ended, not that a first message will show it');
  await page.locator('#draft-recovery > summary').click();
  await page.getByRole('textbox', { name: '草稿副本 3', exact: true }).focus();
  await capture('recovery-copy-reachable');
  await page.locator('#message-input').focus();
  await page.locator('#send-button').click({ trial: true });
  await measure('recovery-input-reachable');
  assert.equal(await page.locator('#message-input').inputValue(), draft);
  assert.equal(await page.locator('.draft-recovery-text').count(), 3);
  check('Expanded persisted recovery copies and original draft remain keyboard/mouse reachable without pushing controls outside the compact window');
  const stats = (await fixture()).stats;
  // One terminal attach per session beside the chat (two sessions); nothing typed or sent.
  assert.ok(stats.opens <= 2, 'Bounded terminal attaches: ' + stats.opens); assert.equal(stats.inputs, 0); assert.equal(stats.sends, 0);
  assert.deepEqual(errors, []); await guards();
  const windows = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ visible: w.isVisible(), focusable: w.isFocusable() })));
  assert.deepEqual(windows, [{ visible: false, focusable: false }]);
  console.log(JSON.stringify({ checks, metrics, stats, windows, errors }, null, 2));
}
const cleanup = testScratch.cleanup(async () => {
  if (application) await application.close();
  if (client) { await fixture('stop'); await client.call('shutdown'); client.close(); }
  if (child.connected) child.disconnect();
  await until(() => child.exitCode !== null, 'Owned fixture daemon exits');
});
run().catch(async error => { failure = error.stack; console.error(failure); await capture('failed').catch(() => {}); process.exitCode = 1; }).finally(async () => {
  try {
    fs.mkdirSync(evidence, { recursive: true });
    fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ checks, metrics, failure, errors, profile, ownedNodePid: child.pid, ownedGuiPids: guiPids, guards: guardSamples, currentGuards: application ? await application.evaluate(() => globalThis.compactGuards).catch(() => null) : null, fixture: child.connected ? await fixture().catch(() => null) : null }, null, 2));
  } finally {
    await cleanup(); assert.equal(JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))).token, token); fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot);
    fs.writeFileSync(path.join(evidence, 'released.json'), JSON.stringify({ token, releasedAt: new Date().toISOString(), ownedProfileGone: !fs.existsSync(profile) }));
  }
});
