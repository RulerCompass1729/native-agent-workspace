// Real hidden Electron UI and service; synthetic native producer, zero models.
const scratch = require('./fixtures/test-scratch.cjs');
const { revealDefaultSpace } = require('./fixtures/default-space.cjs');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto'), { once } = require('node:events');
const { execFileSync } = require('node:child_process');
const { _electron } = scratch.playwright(require('playwright'));
const { connectService } = require('../app/service-connection.cjs');
const root = path.resolve(__dirname, '..'), evidence = process.env.NAW_EVIDENCE_DIR;
if (!evidence || !path.isAbsolute(evidence) || path.resolve(evidence).startsWith(root + path.sep)) throw Error('External private evidence directory required');
fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID();
try { fs.mkdirSync(slot); } catch (e) { if (e.code !== 'EEXIST') throw e; console.error('GUI slot occupied; no launch.'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ token, owner: 'secretary', task: 'background control isolated acceptance', pid: process.pid, at: new Date().toISOString() }));
const pictures = path.join(process.env.NAW_PICTURES_DIR || path.join(os.homedir(), 'Pictures/naw-dogfood'), new Date().toISOString().slice(0, 7), 'background-' + token);
fs.mkdirSync(pictures, { recursive: true });
const checks = [], trace = [], errors = [];
let profile, child, client, app, page, helper, sequence = 0, source, recipient;
const desktop = () => JSON.parse(execFileSync('osascript', ['-l', 'JavaScript', '-e', "ObjC.import('AppKit'); var p=$.NSEvent.mouseLocation; JSON.stringify({frontmostPid:$.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier,x:p.x,y:p.y})"], { encoding: 'utf8' }));
const save = (name, value) => fs.writeFileSync(path.join(evidence, name + '.json'), JSON.stringify(value, null, 2), { mode: 0o600 });
async function checkDesktopState(stage, minimumWindows = 1) {
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ visible: w.isVisible(), focused: w.isFocused() })));
  assert.ok(windows.length >= minimumWindows, 'Owned application windows remain observable');
  assert.ok(windows.every(w => !w.visible && !w.focused), 'Owned application windows stay hidden and unfocused');
  // Hidden, unfocused windows do not rule out this application activating itself without one (a native dialog,
  // app.focus). Whatever the person does, the frontmost application is never this test's own app (review 0a2298c6).
  const sample = desktop(), ownPid = app.process().pid;
  assert.notEqual(sample.frontmostPid, ownPid, 'This application never makes itself the frontmost application');
  // The person can move the pointer or switch apps while this hidden test runs.
  // Global samples cannot attribute such changes to this application.
  save(stage, { ...sample, ownPid, windows, attribution: 'unattributed', physicalPointerIsolation: 'unverified' });
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { for (let n = 0; n < 150; n++) { if (await fn()) return; await wait(40); } throw Error(label); }
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
const state = () => client.call('initial');
const invoke = (method, args, id = randomUUID(), extra = {}) => ({ action: 'invoke', method, arguments: args, operation_id: id, ...extra });
async function run() {
  const before = desktop(); save('desktop-before', before);
  profile = fs.realpathSync(scratch.directory(path.join(os.tmpdir(), 'naw-background-'))); const cwd = path.join(profile, 'workspace'); fs.mkdirSync(cwd, { mode: 0o700 });
  child = scratch.childProcess.fork(path.join(root, 'app/daemon.cjs'), [profile], { cwd, execArgv: ['--require', path.join(__dirname, 'fixtures/background-control.cjs')],
    env: { ...process.env, NAW_TEST_APP_ROOT: root, NAW_WORKSPACE: cwd, NAW_APP_VERSION: require('../package.json').version }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  save('owned', { token, profile, childPid: child.pid });
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Fixture service starts'); client = await connectService(profile, 'human-view');
  source = await client.call('create', { provider: 'codex', cwd, name: 'Synthetic operator', view: 'chat' });
  recipient = await client.call('create', { provider: 'claude', cwd, name: 'Synthetic recipient', view: 'chat' });
  await client.call('join', source, true); await client.call('join', recipient, true);
  await client.call('draft', source, 'HUMAN ORIGINAL UNSENT DRAFT');
  fs.writeFileSync(path.join(profile, 'views.json'), JSON.stringify([{ owner: 'human-view', active: true, selected: source, mode: 'chat' }]), { mode: 0o600 });
  app = await _electron.launch({ args: [root], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 30000 });
  save('owned', { token, profile, childPid: child.pid, appPid: app.process().pid });
  page = await app.firstWindow(); page.setDefaultTimeout(6000); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#message-input').waitFor();
  await until(async () => await page.locator('#message-input').inputValue() === 'HUMAN ORIGINAL UNSENT DRAFT', 'Human draft restored');
  // Count what the main process sends to each window, including windows created later. A background
  // window loads no document, so anything sent to it stays in memory for as long as the app runs.
  await app.evaluate(({ app: electronApp, BrowserWindow }) => {
    globalThis.sendsByWindow = new Map();
    const count = win => {
      const id = win.id;
      const original = win.webContents.send.bind(win.webContents);
      win.webContents.send = (...args) => {
        globalThis.sendsByWindow.set(id, (globalThis.sendsByWindow.get(id) || 0) + 1);
        return original(...args);
      };
    };
    BrowserWindow.getAllWindows().forEach(count);
    electronApp.on('browser-window-created', (_event, win) => count(win));
  });
  const rpc = mcp(); await rpc('initialize'); const catalog = await rpc('tools/list'); assert.ok(catalog.tools.some(t => t.name === 'workspace_control'));
  async function control(args, wrongBody = false) {
    const proof = await fixture('backgroundProof', source, { callId: randomUUID(), arguments: args });
    const result = await rpc('tools/call', { name: 'workspace_control', arguments: wrongBody ? { ...args, method: 'madeUp' } : args,
      _meta: { threadId: proof.nativeId, sessionId: proof.sessionId, callId: proof.callId, 'x-codex-turn-metadata': { thread_id: proof.nativeId, turn_id: proof.turnId } } });
    const value = JSON.parse(result.content[0].text); trace.push({ args, value, isError: result.isError }); save('trace', trace);
    await fixture('backgroundComplete', source, { callId: proof.callId, arguments: args }); return value;
  }
  async function decide(record, response) {
    assert.equal(record.state, 'confirmation-required', JSON.stringify(record));
    assert.equal(record.confirmation.kind, 'message');
    const card = page.locator(`[data-message-id="background:${record.actor.nativeId}:${record.id}"]`);
    await card.getByRole('button', { name: record.confirmation.options.buttons[response], exact: true }).click();
    await until(() => {
      const saved = JSON.parse(fs.readFileSync(path.join(profile, 'background-operations.json'))).records.find(r => r.id === record.id);
      return saved && !['running', 'confirmation-required'].includes(saved.state);
    }, 'Human decision settled for ' + record.id);
    return (await control({ action: 'receipt', operation_id: record.id })).receipt;
  }
  const commands = await control({ action: 'catalog' }); assert.equal(commands.state, 'complete'); assert.ok(commands.commands.length > 70);
  const publicCommands = await page.evaluate(() => Object.keys(window.workspace).filter(name => !name.startsWith('on') && !['backgroundDecision', 'retryStartup', 'startupData', 'uiReady'].includes(name)));
  // The butler's review and controls, and the record reminders, are the person's alone (main.cjs removes them from the agent catalog).
  assert.deepEqual(publicCommands.filter(name => !['butlerReview', 'butler', 'records', 'stewardRecord'].includes(name) && !commands.commands.some(c => c.method === name)), [], 'Every shared preload action has a background command');
  for (const name of ['butlerReview', 'butler', 'records', 'stewardRecord']) assert.equal(commands.commands.some(c => c.method === name), false, `${name} remains exclusive to the person`);
  const reviewDenied = await control(invoke('butlerReview', ['availability']));
  assert.equal(reviewDenied.state, 'not-executed'); assert.equal(reviewDenied.reason, 'unknown-command');
  assert.ok(commands.commands.every(c => Array.isArray(c.parameters))); checks.push('Actual stdio MCP catalog through original runtime proof');
  const rename = await control(invoke('rename', [recipient, 'Background renamed recipient']));
  assert.equal(rename.state, 'confirmation-required');
  assert.equal(await page.evaluate(async id => (await workspace.initial()).sessions.find(s => s.id === id).name, recipient), 'Synthetic recipient');
  const renamed = await decide(rename, 1); assert.equal(renamed.state, 'complete');
  await until(async () => await page.locator(`.session-link[data-session-id="${recipient}"]`).textContent().then(t => t.includes('Background renamed recipient')), 'Shared GUI sees actual rename');
  await control(invoke('draft', [source, 'AGENT PRIVATE DRAFT']));
  const snap = await control({ action: 'snapshot' }); assert.equal(snap.state, 'complete'); assert.equal(await page.locator('#message-input').inputValue(), 'HUMAN ORIGINAL UNSENT DRAFT');
  await control(invoke('viewState', [{ selected: recipient, mode: 'chat' }]));
  assert.equal(await page.locator(`.session-link.active[data-session-id="${source}"]`).count(), 1);
  // Foreign selection is navigation, not permission to read its conversation.
  // This test only needs the roster, so return to the actor's own view.
  await control(invoke('viewState', [{ selected: source, mode: 'chat' }]));
  checks.push('Real shared rename; agent draft and selection preserve human view/draft');
  const target = (await control({ action: 'snapshot' })).value.sessions.find(s => s.id === recipient);
  for (const disabled of [null, recipient]) {
    await client.call('wakePolicy', disabled, false);
    for (const [method, values] of [
      ['send', [recipient, 'Refused input', target.nativeId]], ['forward', [recipient, 'Refused input', target.nativeId]],
      ['queue', [recipient, 'Refused input', target.nativeId]], ['queueShared', [recipient, 'Refused input', target.nativeId]],
      ['steer', [recipient, 'Refused input', target.nativeId, 'turn']], ['steerShared', [recipient, 'Refused input', target.nativeId, 'turn']],
      ['run', [[source, recipient], 'Refused relay', 2]], ['input', [recipient, 'Refused input\r']],
      ['spaceAction', ['shared', 'forward', [recipient, 'Refused input', target.nativeId]]],
    ]) {
      let denied = await control(invoke(method, values));
      if (method === 'input') {
        assert.equal(denied.state, 'confirmation-required');
        const before = await fixture('stats'); assert.equal(before.sends.length, 0); assert.equal(before.inputs.length, 0);
        denied = await decide(denied, 1);
      }
      assert.equal(denied.state, 'unconfirmed'); assert.match(denied.error, /自动 agent 消息已关闭/);
      const after = await fixture('stats'); assert.equal(after.sends.length, 0); assert.equal(after.inputs.length, 0);
    }
    assert.equal((await control({ action: 'snapshot' })).state, 'complete');
    await client.call('wakePolicy', disabled, true);
  }
  checks.push('Actual global and recipient off switches refuse every background input path, including human-approved cross-session input, before native dispatch; own roster reading remains available');
  const text = '  EXACT background message\r\n中文\n  ', args = invoke('forward', [recipient, text, target.nativeId]);
  const sent = await control(args); assert.equal(sent.state, 'received', JSON.stringify(sent));
  assert.equal(sent.delivery.body, text); assert.equal(sent.delivery.nativeReceived, true);
  const stats = await fixture('stats'); assert.equal(stats.sends.length, 1); assert.equal(stats.sends[0].text, text);
  assert.equal((await control(args)).duplicate, true); assert.equal((await fixture('stats')).sends.length, 1);
  assert.equal((await control({ action: 'receipt', operation_id: args.operation_id })).receipt.delivery.nativeReceived, true);
  const raw = await state(), privateRow = raw.sessions.find(s => s.id === recipient).messages.find(m => m.text === text);
  assert.equal(privateRow.agentControl.id, source); assert.equal(privateRow.origin, 'agent-control');
  assert.ok(raw.room.messages.some(m => m.agentControl?.operationId === args.operation_id && m.text === text));
  const sharedRow = raw.room.messages.find(m => m.agentControl?.operationId === args.operation_id && m.text === text);
  checks.push('Exact input submitted once; actual synthetic native event confirms receipt; agent attribution in both histories');
  const queued = await control(invoke('queueShared', [recipient, '  Busy original thread continuation\n', target.nativeId]));
  // Taken within 25 ms: usually received at once; under load it may answer awaiting-native first and settle soon after.
  assert.ok(['received', 'awaiting-native'].includes(queued.state), JSON.stringify(queued)); assert.equal(queued.delivery.body, '  Busy original thread continuation\n');
  if (queued.state !== 'received') await until(async () => (await control({ action: 'receipt', operation_id: queued.id })).receipt?.state === 'received', 'Quick queued input settles received');
  // Claude 2, 87a3b4c0 batch 2: a message native has not taken yet answers awaiting-native and frees the agent at once.
  await fixture('holdQueue');
  const held = await control(invoke('queueShared', [recipient, 'Held until the next tool step\n', target.nativeId]));
  assert.equal(held.state, 'awaiting-native', JSON.stringify(held)); assert.equal(held.delivery.status, 'awaiting-native');
  const meanwhile = await control(invoke('interfaceSettings', ['describe']));
  assert.equal(meanwhile.state, 'complete', 'The same agent\'s next operation runs while the message waits: ' + JSON.stringify(meanwhile));
  assert.equal((await control(invoke('queueShared', [recipient, 'Held until the next tool step\n', target.nativeId], held.id))).duplicate, true, 'Asking again never sends again');
  await fixture('releaseQueue'); // Another fixture may answer first; the receipt below is the proof it was released.
  await until(async () => (await control({ action: 'receipt', operation_id: held.id })).receipt?.state === 'received', 'The held message settles received once native takes it');
  checks.push('A queued message native has not taken answers awaiting-native, frees the agent for its next operation, and settles received later, sent once');
  assert.equal((await state()).sessions.find(s => s.id === recipient).state, 'working');
  checks.push('Busy original recipient receives queue input without pretending idle or starting another session');
  const card = page.locator(`[data-message-id="background:${(await state()).sessions.find(s => s.id === source).nativeId}:${args.operation_id}"]`);
  await card.waitFor(); assert.ok((await card.textContent()).includes('原生会话已收到'));
  const stop = await control(invoke('stop', [recipient])); assert.equal(stop.state, 'confirmation-required');
  assert.equal((await state()).sessions.find(s => s.id === recipient).state, 'working');
  assert.equal((await decide(stop, stop.confirmation.options.cancelId)).state, 'cancelled');
  assert.equal((await state()).sessions.find(s => s.id === recipient).state, 'working');
  checks.push('Existing confirmation is inline and nonmodal; cancellation does not stop native work');
  const selected = path.join(cwd, 'material.txt'); fs.writeFileSync(selected, 'Actual material contents');
  const material = await control(invoke('openLocalFile', [recipient], undefined, { paths: [selected] }));
  assert.equal(material.state, 'confirmation-required'); assert.equal(material.value, undefined, 'No file content before consent');
  const opened = await decide(material, 1); assert.equal(opened.state, 'complete'); assert.equal(opened.value.text, 'Actual material contents');
  const settings = await control(invoke('interfaceSettings', ['describe'])); assert.equal(settings.state, 'complete', JSON.stringify(settings));
  const locale = settings.value.find(s => s.ns === 'locale'); assert.ok(locale);
  const language = await control(invoke('interfaceSettings', ['update', 'locale', { preference: 'en' }, locale.revision])); assert.equal(language.state, 'complete', JSON.stringify(language));
  await until(async () => await page.locator('#setup-button').textContent().then(t => t.includes('Settings')), 'Existing Host updates actual visible interface language');
  const english = language.value.find(s => s.ns === 'locale');
  assert.equal((await control(invoke('interfaceSettings', ['update', 'locale', { preference: 'zh' }, english.revision]))).state, 'complete');
  checks.push('Actual Host settings writer persists a language change and repaints the normal UI');
  await control(invoke('copy', ['AGENT CLIPBOARD'])); assert.equal((await control(invoke('pasteText', []))).value, 'AGENT CLIPBOARD');
  await checkDesktopState('desktop-after', 2);
  assert.equal(await page.locator('#message-input').inputValue(), 'HUMAN ORIGINAL UNSENT DRAFT');
  checks.push('File picker and clipboard independent; owned windows hidden and unfocused; global desktop samples are unattributed');
  const windowSends = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(win => ({
    document: win.webContents.getURL() !== '',
    sends: globalThis.sendsByWindow.get(win.id) || 0,
  })));
  const withoutDocument = windowSends.filter(win => !win.document);
  save('window-sends', windowSends);
  assert.ok(withoutDocument.length >= 1, 'Workspace control created a background window that loads no document: ' + JSON.stringify(windowSends));
  assert.ok(windowSends.some(win => win.document && win.sends > 0), 'The ordinary window kept receiving: ' + JSON.stringify(windowSends));
  assert.deepEqual(withoutDocument.map(win => win.sends), withoutDocument.map(() => 0), 'Nothing is sent to a window that loads no document: ' + JSON.stringify(windowSends));
  checks.push('Nothing is sent to the background window; the ordinary window keeps receiving');
  await page.screenshot({ path: path.join(pictures, 'background-receipts.png') });
  await app.close();
  app = await _electron.launch({ args: [root], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 30000 });
  page = await app.firstWindow(); page.setDefaultTimeout(6000); await page.locator('#message-input').waitFor();
  const recovered = await control({ action: 'receipt', operation_id: args.operation_id }); assert.equal(recovered.receipt.state, 'received');
  assert.equal((await control(args)).duplicate, true); assert.equal((await fixture('stats')).sends.length, 1);
  assert.equal(await page.locator('#message-input').inputValue(), 'HUMAN ORIGINAL UNSENT DRAFT');
  await checkDesktopState('desktop-reopen'); checks.push('Real GUI restart keeps audit, actor draft and human draft; old operation never resends');
  // Inspect the ordinary shared record only after verifying the human draft and
  // selection were preserved. These test-local UI actions never use the mouse.
  await revealDefaultSpace(page);
  await page.locator('#room-nav').click(); await page.locator('#room-record').click();
  const visibleLabel = await page.locator(`#room-messages [data-message-id="${sharedRow.id}"] .message-author`).textContent();
  assert.equal(visibleLabel, 'Synthetic operator → Background renamed recipient');
  save('shared-message-label', { messageId: sharedRow.id, label: visibleLabel });
  await page.screenshot({ path: path.join(pictures, 'shared-agent-attribution.png') });
  // A session takes back an item it queued itself while it is still queued (the person, 11-12 21:1x: 「可以」);
  // anyone else's item stays the person's to cancel. The record line says who took it back, in both languages.
  // Both items are for the busy recipient, so the queue does not send them while this runs.
  const sharedRoom = async () => { const value = await page.evaluate(() => workspace.initial()); return (value.rooms || [value.room]).find(r => r.id === 'shared'); };
  const queueItem = async text => (await sharedRoom()).queue.find(item => item.text === text);
  const ownText = 'Withdrawal check: the project manager\'s item', personsText = 'Withdrawal check: the person\'s item';
  await page.evaluate(id => workspace.spaceManager('shared', id), source);
  const added = await control(invoke('spaceAction', ['shared', 'queueAdd', [ownText, recipient]])); assert.equal(added.state, 'complete', JSON.stringify(added));
  await page.evaluate(([text, id]) => workspace.spaceAction('shared', 'queueAdd', [text, id]), [personsText, recipient]);
  const own = await queueItem(ownText), persons = await queueItem(personsText);
  assert.deepEqual([own.status, persons.status, own.creator.sessionId, persons.creator.kind], ['queued', 'queued', source, 'person']);
  const refusedWithdrawal = await control(invoke('spaceAction', ['shared', 'queueCancel', [persons.id]]));
  assert.equal(refusedWithdrawal.state, 'unconfirmed', JSON.stringify(refusedWithdrawal)); assert.match(refusedWithdrawal.error, /只能撤回自己放进队列/);
  const withdrawn = await control(invoke('spaceAction', ['shared', 'queueCancel', [own.id]]));
  assert.equal(withdrawn.state, 'complete', JSON.stringify(withdrawn)); assert.equal(withdrawn.confirmation, undefined, 'No confirmation for taking back its own item');
  assert.deepEqual([(await queueItem(ownText)).status, (await queueItem(personsText)).status], ['cancelled', 'queued']);
  const withdrawal = (await sharedRoom()).events.findLast(event => event.uiMessage?.key === 'notice.queue.withdrawn');
  assert.deepEqual(withdrawal.uiMessage.params, { text: ownText, name: 'Synthetic operator', sessionId: source });
  const recordLine = async (expected, label, id = withdrawal.id, kind = 'withdrawal') => {
    let row = null;
    await until(async () => {
      row = await page.evaluate(id => {
        const element = document.querySelector('#room-messages [data-message-id="' + id + '"]'); if (!element) return null;
        element.scrollIntoView({ block: 'center' });
        const box = element.getBoundingClientRect(), list = document.querySelector('#room-messages').getBoundingClientRect();
        return { text: element.innerText, inside: box.width > 0 && box.height > 0 && box.top >= list.top - 1 && box.bottom <= list.bottom + 1 };
      }, id);
      return row?.inside && row.text.includes(expected);
    }, `${label}: ${JSON.stringify(row)}`);
    save(`${kind}-record-${label}`, row);
  };
  await recordLine(`队列撤回：${ownText} · Synthetic operator（${source}）撤回了自己放进来的这一件`, 'zh');
  await page.screenshot({ path: path.join(pictures, 'queue-withdrawn-zh.png') });
  const described = (await control(invoke('interfaceSettings', ['describe']))).value.find(s => s.ns === 'locale');
  const inEnglish = await control(invoke('interfaceSettings', ['update', 'locale', { preference: 'en' }, described.revision])); assert.equal(inEnglish.state, 'complete', JSON.stringify(inEnglish));
  await recordLine(`Withdrawn from queue: ${ownText} · taken back by Synthetic operator (${source}), who added it`, 'en');
  await page.screenshot({ path: path.join(pictures, 'queue-withdrawn-en.png') });
  assert.equal((await control(invoke('interfaceSettings', ['update', 'locale', { preference: 'zh' }, inEnglish.value.find(s => s.ns === 'locale').revision]))).state, 'complete');
  // The person cancels their own item and revokes the project manager; nothing was sent.
  await page.evaluate(id => workspace.spaceAction('shared', 'queueCancel', [id]), persons.id);
  await page.evaluate(() => workspace.spaceManager('shared', null));
  assert.deepEqual([(await queueItem(ownText)).status, (await queueItem(personsText)).status], ['cancelled', 'cancelled']);
  assert.equal((await fixture('stats')).sends.length, 1, 'No queue item was sent');
  checks.push('Through the real MCP path, the space\'s project manager takes back its own queued item without confirmation; another\'s is refused; the record names who took it back in Chinese and English');
  // Queue item 6897c6e3, part 1: a member already doing an item queued for it (taken from the board, say) claims it, so
  // that NAW does not send it the same work again; another member's item is refused. The record line says who claimed it.
  // The operator keeps a draft and its turn open, so the queue does not send it anything while this runs.
  const claimText = 'Claim check: work the operator took from the board', othersText = 'Claim check: the recipient\'s item';
  await page.evaluate(([text, id]) => workspace.spaceAction('shared', 'queueAdd', [text, id]), [claimText, source]);
  await page.evaluate(([text, id]) => workspace.spaceAction('shared', 'queueAdd', [text, id]), [othersText, recipient]);
  const toClaim = await queueItem(claimText), others = await queueItem(othersText);
  assert.deepEqual([toClaim.status, toClaim.assignee, others.status], ['queued', source, 'queued']);
  const refusedClaim = await control(invoke('spaceAction', ['shared', 'queueClaim', [others.id]]));
  assert.equal(refusedClaim.state, 'unconfirmed', JSON.stringify(refusedClaim)); assert.match(refusedClaim.error, /只能认领指给自己/);
  const operator = (await state()).sessions.find(s => s.id === source), input = (operator.messages || []).findLast(m => m.role === 'user');
  save('claim-operator', { state: operator.state, controlRevision: operator.controlRevision || 0, input: input?.id || null, queued: (await queueItem(claimText)).status });
  const claimed = await control(invoke('spaceAction', ['shared', 'queueClaim', [toClaim.id]]));
  assert.equal(claimed.state, 'complete', JSON.stringify(claimed)); assert.equal(claimed.confirmation, undefined, 'No confirmation for claiming an item queued for it');
  const afterClaim = await queueItem(claimText);
  assert.deepEqual([afterClaim.status, afterClaim.sentTo, afterClaim.tag, afterClaim.control, (await queueItem(othersText)).status],
    ['sent', source, input?.id || `claimed:${toClaim.id}`, operator.controlRevision || 0, 'queued']);
  save('claim-item', afterClaim);
  const claimEvent = (await sharedRoom()).events.findLast(event => event.uiMessage?.key === 'notice.queue.claimed');
  assert.deepEqual(claimEvent.uiMessage.params, { text: claimText, name: 'Synthetic operator', sessionId: source });
  await recordLine(`队列认领：${claimText} → Synthetic operator（${source}）已经在做这一件，NAW 不再派`, 'zh', claimEvent.id, 'claim');
  await page.screenshot({ path: path.join(pictures, 'queue-claimed-zh.png') });
  const claimLocale = (await control(invoke('interfaceSettings', ['describe']))).value.find(s => s.ns === 'locale');
  const claimEnglish = await control(invoke('interfaceSettings', ['update', 'locale', { preference: 'en' }, claimLocale.revision])); assert.equal(claimEnglish.state, 'complete', JSON.stringify(claimEnglish));
  await recordLine(`Claimed from queue: ${claimText} → Synthetic operator (${source}) is already doing it; NAW will not send it`, 'en', claimEvent.id, 'claim');
  await page.screenshot({ path: path.join(pictures, 'queue-claimed-en.png') });
  assert.equal((await control(invoke('interfaceSettings', ['update', 'locale', { preference: 'zh' }, claimEnglish.value.find(s => s.ns === 'locale').revision]))).state, 'complete');
  // While its claimed item has not settled, the operator cannot claim a second one: both would settle on the same reply.
  const secondText = 'Claim check: a second item for the operator';
  await page.evaluate(([text, id]) => workspace.spaceAction('shared', 'queueAdd', [text, id]), [secondText, source]);
  const second = await queueItem(secondText);
  const busyClaim = await control(invoke('spaceAction', ['shared', 'queueClaim', [second.id]]));
  assert.equal(busyClaim.state, 'unconfirmed', JSON.stringify(busyClaim)); assert.match(busyClaim.error, /还有一件已派出、没结算的任务/);
  save('claim-busy', { state: busyClaim.state, error: busyClaim.error, second: (await queueItem(secondText)).status });
  // The claimed item was never sent; the person cancels the other member's and the second one.
  await page.evaluate(id => workspace.spaceAction('shared', 'queueCancel', [id]), others.id);
  await page.evaluate(id => workspace.spaceAction('shared', 'queueCancel', [id]), second.id);
  assert.deepEqual([(await queueItem(claimText)).status, (await queueItem(othersText)).status, (await queueItem(secondText)).status], ['sent', 'cancelled', 'cancelled']);
  assert.equal((await fixture('stats')).sends.length, 1, 'No queue item was sent');
  checks.push('Through the real MCP path, a member claims an item queued for it without confirmation; another member\'s is refused, and so is a second one while the first has not settled; nothing is sent; the record names who claimed it in Chinese and English');
  await checkDesktopState('desktop-final');
  save('operations', JSON.parse(fs.readFileSync(path.join(profile, 'background-operations.json')))); save('final-state', await state());
  const finalStats = await fixture('stats'); save('fixture-stats', finalStats);
  assert.equal(finalStats.nativeProcesses, 0); assert.equal(finalStats.modelCalls, 0);
  assert.deepEqual(errors, []); save('result', { passed: true, checks, windowSends, sourceProducer: 'synthetic', nativeProviderCalls: 0, installed: false, pictures });
}
(async () => { try { await run(); } catch (e) { save('result', { passed: false, checks, error: e.stack, errors, installed: false }); process.exitCode = 1; }
  finally {
    if (helper) helper.stdin.end();
    if (client) client.close();
    await scratch.release();
    const owner = JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))); if (owner.token === token) fs.rmSync(slot, { recursive: true });
  }
})();
