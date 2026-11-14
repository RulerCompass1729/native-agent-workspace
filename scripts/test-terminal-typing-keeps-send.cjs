const testScratch = require('./fixtures/test-scratch.cjs');
const { createIn } = require('./fixtures/create-view.cjs');
// The person, 2026-11-13: 「对于 Claude 和 codex 这样支持的,我希望两边的输入可以不要锁定」. With both sides open, they
// send a line from the conversation box and go straight on typing in the native terminal:
// 1. Their send, still waiting for the native side to take it, goes through; the terminal gets exactly their keys.
// 2. Counter-example: a NAW queue item being sent while they type in the terminal is taken back, as before.
// Hidden app/IPC/workspace with a held send; no native processes or model tasks.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { fork } = testScratch.childProcess;
const { _electron } = testScratch.playwright(require('playwright')), { connect } = require('../app/service-client.cjs');
const root = path.resolve(__dirname, '..');
// One hidden GUI test at a time on this machine: take the shared GUI slot before anything starts (exit 75 = occupied).
const common = require('node:child_process').execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = require('node:crypto').randomUUID();
try { fs.mkdirSync(slot); } catch (e) { if (e.code !== 'EEXIST') throw e; console.error('GUI slot occupied; no launch.'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ token, owner: 'test-terminal-typing-keeps-send', pid: process.pid, at: new Date().toISOString() }));
const releaseSlot = () => { try { if (JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))).token === token) fs.rmSync(slot, { recursive: true }); } catch {} };
const profile = testScratch.directory(path.join(os.tmpdir(), 'naw-typing-keeps-send-'));
const child = fork(path.join(root, 'app/daemon.cjs'), [profile], { execArgv: ['--require', path.join(__dirname, 'fixtures/loading-terminal.cjs')], env: { ...process.env, NAW_APP_VERSION: require('../package.json').version, NAW_WORKSPACE: profile }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
let app, page, client, sequence = 0; const errors = [], passed = [], measurements = [];
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label) { for (let i = 0; i < 100; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
function fixture(method, target, value) { const id = ++sequence; return new Promise((resolve, reject) => {
  const timer = setTimeout(() => { child.off('message', cb); reject(Error('Fixture timeout')); }, 5000);
  const cb = m => { if (m.requestId === id) { clearTimeout(timer); child.off('message', cb); resolve(m); } }; child.on('message', cb); child.send({ id, method, target, value });
}); }
const snapshot = () => page.evaluate(() => workspace.initial());
async function capture(name) { if (process.env.NAW_EVIDENCE_DIR) { fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, name + '.png') }); } }
async function run() {
  console.log('Fixture profile:', profile); await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Service'); client = await connect(profile, 'typing-keeps-send-test');
  app = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message)); await page.locator('#new-session').waitFor();
  await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="claude"]').check(); await page.locator('#session-name').fill('claude · 边发边打'); await createIn(page, 'chat');
  await until(async () => (await snapshot()).sessions.length === 1, 'Created'); const id = (await snapshot()).sessions[0].id;
  const input = page.locator(`[data-terminal-id="${id}"] .xterm-helper-textarea`), composer = page.locator('#message-input');
  const stats = () => fixture('stats');
  const typed = async () => (await stats()).inputs.filter(x => x.id === id).map(x => x.data).join('');
  const record = () => snapshot().then(s => s.sessions.find(x => x.id === id));
  const toast = () => page.locator('#toast').evaluate(el => el.hidden || getComputedStyle(el).display === 'none' ? '' : el.textContent.trim());

  // A ready terminal beside the conversation: open it once, then go back to the box.
  await page.locator('#terminal-tab').click(); await until(async () => (await stats()).pending.includes(id), 'Snapshot');
  await fixture('release', id); await until(() => input.evaluate(el => el === document.activeElement), 'Terminal ready');
  await page.locator('#chat-tab').click(); await until(async () => (await record()).view === 'chat', 'Chat view settled');

  // 1. Send from the box; while the native side has not taken it yet, type in the terminal.
  const box = '框里发的这一句', keys = 'TERM typed 1';
  await fixture('hold-send', id); await composer.click(); await page.keyboard.type(box); await page.keyboard.press('Enter');
  // The box keeps its text until the native side takes it (renderer submitSession), so a refusal never loses it.
  await until(async () => (await stats()).waitingSends.includes(id), 'The send waits for the native side');
  await input.click(); await until(() => input.evaluate(el => el === document.activeElement), 'The terminal has the keyboard');
  await page.keyboard.type(keys); await until(async () => await typed() === keys, 'Keys typed after sending reach the terminal');
  const control = (await record()).controlRevision;
  await fixture('release-send', id);
  await until(async () => (await stats()).sends.some(x => x.id === id && x.text === box), 'The box send goes through after the person typed in the terminal');
  await until(async () => await composer.inputValue() === '', 'The box empties once the send went through');
  const kept = await stats(), row = (await record()).messages.find(m => m.role === 'user' && m.text === box);
  measurements.push({ revoked: kept.revoked, rowStatus: row?.status, typed: await typed(), draft: (await record()).liveDraft, toast: await toast(), controlRevision: control });
  assert.deepEqual(kept.revoked, [], 'Nothing was taken back');
  assert.notEqual(row?.status, 'unconfirmed', 'The sent line is not left unconfirmed');
  assert.equal(await typed(), keys, 'The terminal received exactly what was typed in it');
  assert.equal((await record()).liveDraft || '', '', 'The sent line does not come back as a draft');
  assert.ok(!/撤销|revoked/i.test(await toast()), 'No revocation notice');
  await capture('01-send-kept');
  passed.push('Sending from the box and then typing in the terminal: the send goes through, the terminal gets exactly the keys, no revocation');

  // 2. Counter-example: a NAW queue item waiting for the native side is taken back by a key in the terminal.
  await fixture('complete', id); await until(async () => (await record()).state === 'idle', 'Idle again');
  const item = '【NAW 派活】synthetic item';
  await fixture('hold-send', id); await fixture('dispatch-send', id, item);
  await until(async () => (await stats()).waitingSends.includes(id), 'The queue item waits for the native side');
  await input.click(); await page.keyboard.type('K'); await until(async () => await typed() === keys + 'K', 'The key reaches the terminal');
  await fixture('release-send', id);
  await until(async () => (await stats()).revoked.some(x => x.id === id && x.text === item), 'The queue item is taken back');
  const after = await stats(); measurements.push({ dispatchRevoked: after.revoked, dispatchErrors: after.dispatchErrors });
  assert.equal(after.sends.some(x => x.text === item), false, 'The queue item was not sent');
  await capture('02-queue-item-taken-back');
  passed.push('A NAW queue item being sent while the person types in the terminal is taken back');

  assert.equal(app.windows().length, 1); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed, measurements, errors, nativeProviderProcesses: 0, nativeModelCalls: 0, oneWindow: true }));
}
run().catch(async e => { console.error(e.stack); if (page) await capture('failed'); process.exitCode = 1; }).finally(testScratch.cleanup(async () => {
  try { if (app) await app.close(); if (client) { const s = await client.call('initial'); for (const x of s.sessions) await client.call('stop', x.id); await client.call('shutdown'); client.close(); } if (child.connected) child.disconnect(); }
  finally { releaseSlot(); }
}));
