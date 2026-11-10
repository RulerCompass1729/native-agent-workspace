// Real isolated GUI/service and renderer. Provider output is synthetic; no model runs.
// Exercise both a blocked terminal mount and sustained output after it recovers.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'), scratch = require('./fixtures/test-scratch.cjs');
const { _electron } = scratch.playwright(require('playwright'));
const { createIn } = require('./fixtures/create-view.cjs');
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID();
const evidence = process.env.NAW_EVIDENCE_DIR;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let app, page, child, profile, sequence = 0, failure;
const samples = [], errors = [];
async function until(fn, label) { for (let i = 0; i < 200; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
function fixture(method, target, value) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const callback = reply => { if (reply.requestId !== id) return; clearTimeout(timer); child.off('message', callback); resolve(reply); };
    const timer = setTimeout(() => { child.off('message', callback); reject(Error('Synthetic fixture timed out')); }, 12000);
    child.on('message', callback); child.send({ id, method, target, value });
  });
}
async function run() {
  // One canonical GUI slot. Do not interfere with another runner's lease.
  try { fs.mkdirSync(slot); } catch (e) { if (e.code !== 'EEXIST') throw e; console.error('GUI slot occupied; nothing launched.'); process.exitCode = 75; return; }
  fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'C5', task: 'renderer memory', token, pid: process.pid, time: new Date().toISOString() }));
  profile = scratch.directory(path.join(os.tmpdir(), 'naw-renderer-memory-'));
  const cwd = path.join(profile, 'workspace'); fs.mkdirSync(cwd);
  child = scratch.childProcess.fork(path.join(root, 'app/daemon.cjs'), [profile], {
    execArgv: ['--require', path.join(__dirname, 'fixtures/loading-terminal.cjs')],
    env: { ...process.env, NAW_TEST_APP_ROOT: root, NAW_WORKSPACE: cwd, NAW_APP_VERSION: require('../package.json').version }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Synthetic service ready');
  assert.equal(JSON.parse(fs.readFileSync(path.join(profile, 'connection.json'))).pid, child.pid);
  app = await _electron.launch({ executablePath: require('electron'), args: [root], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid), NAW_TEST_VISIBLE: '0' }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(12000); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="codex"]').check();
  await page.locator('#session-name').fill('Synthetic memory history'); await createIn(page, 'chat');
  const id = await page.evaluate(async () => (await workspace.initial()).sessions.find(s => s.name === 'Synthetic memory history').id);
  const text = 'Synthetic original body. '.repeat(84);
  const history = Array.from({ length: 1000 }, (_, i) => ({ id: 'memory-' + i, type: 'agentMessage', turnId: 'memory-turn-' + i, text: i + ': ' + text }));
  await fixture('history', id, history);
  await page.locator('#messages [data-message-id="memory-999"] .message-body p').first().waitFor();
  await page.locator('#message-input').fill('Unsent draft 你好');
  // Keep focus in the draft, not a row: paging follows normal latest output.
  const cdp = await page.context().newCDPSession(page);
  async function sample(label) {
    await delay(100); await cdp.send('HeapProfiler.collectGarbage');
    const heap = await cdp.send('Runtime.getHeapUsage');
    const process = await app.evaluate(({ app, BrowserWindow }) => ({
      memory: globalThis.process.memoryUsage(), metrics: app.getAppMetrics().map(m => ({ type: m.type, memory: m.memory })),
      hidden: BrowserWindow.getAllWindows().every(w => !w.isVisible() && !w.isFocusable()),
    }));
    const articles = await page.locator('#messages article[data-message-id]').count();
    const sample = { label, heap, ...process, articles }; samples.push(sample); console.log(JSON.stringify(sample));
    assert.ok(process.hidden, 'Synthetic app stays hidden and cannot take focus');
    assert.ok(heap.usedSize < 300 * 1024 * 1024, 'Stop diagnosis before imposing excessive memory pressure');
  }
  await sample('baseline');
  const pending = await fixture('inspect');
  assert.deepEqual(pending.pending, [id], 'Exactly one native snapshot is deliberately held');
  for (let batch = 0; batch < 5; batch++) {
    for (let i = 0; i < 10; i++) {
      const n = batch * 10 + i, messageId = 'memory-live-' + n;
      await fixture('delta', id, { id: messageId, text: 'New synthetic row ' + n });
      await page.locator('#messages [data-message-id="' + messageId + '"] .message-body p').first().waitFor();
    }
    await sample('append-' + (batch + 1) * 10);
  }
  const bounded = () => {
    assert.ok(samples.at(-1).heap.usedSize - samples[0].heap.usedSize < 24 * 1024 * 1024, 'New rows must not retain old copies of the two-megabyte history');
    const workingSetKiB = samples.at(-1).metrics.reduce((sum, m) => sum + m.memory.workingSetSize, 0);
    assert.ok(workingSetKiB < 1024 * 1024, 'This bounded synthetic workload stays below one GiB across the GUI processes');
  };
  bounded();
  await fixture('release', id);
  await page.locator('[data-terminal-id="' + id + '"] .terminal-loading').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#message-input').evaluate(el => document.activeElement === el), true, 'Passive terminal recovery does not steal draft focus');
  for (let batch = 0; batch < 4; batch++) {
    for (let i = 0; i < 50; i++) {
      const n = 50 + batch * 50 + i, messageId = 'memory-live-' + n;
      await fixture('delta', id, { id: messageId, text: 'New synthetic row ' + n });
      await page.locator('#messages [data-message-id="' + messageId + '"] .message-body p').first().waitFor();
    }
    await sample('ready-' + (batch + 1) * 50); bounded();
  }
  const receipt = await fixture('inspect'); assert.deepEqual(receipt.sends, [], 'No prompts submitted');
  const retained = await page.evaluate(async id => { const s = (await workspace.initial()).sessions.find(s => s.id === id); return { messages: s.messages.length, first: s.messages.find(m => m.id === 'memory-0')?.text, draft: s.liveDraft }; }, id);
  assert.ok(retained.messages >= 1250); assert.equal(retained.first, history[0].text); assert.equal(retained.draft, 'Unsent draft 你好');
  assert.equal(await page.locator('#message-input').inputValue(), 'Unsent draft 你好');
  assert.deepEqual(errors, []);
  if (evidence) { fs.mkdirSync(evidence, { recursive: true, mode: 0o700 }); await page.screenshot({ path: path.join(evidence, 'renderer-memory.png') }); }
  console.log('PASS: bounded renderer memory, held then recovered terminal; original history/draft/focus preserved; zero model calls');
}
let deadline;
Promise.race([run(), new Promise((_, reject) => { deadline = setTimeout(() => reject(Error('Bounded memory GUI exceeded three minutes')), 180000); })])
.catch(e => { failure = e.stack; console.error(failure); process.exitCode = 1; }).finally(async () => {
  clearTimeout(deadline);
  if (!profile) return;
  if (evidence) { fs.mkdirSync(evidence, { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(evidence, 'renderer-memory.json'), JSON.stringify({ failure, samples, errors, modelCalls: 0, providerFixture: 'loading-terminal' }, null, 2)); }
  try {
    await scratch.release(); assert.equal(JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))).token, token);
    fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot); console.log('Owned fixture cleaned; GUI slot released.');
  } catch (e) { console.error('Cleanup incomplete; owned lease retained:', e.stack); process.exitCode = 1; }
});
