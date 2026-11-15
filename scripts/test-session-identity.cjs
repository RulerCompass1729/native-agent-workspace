// Hidden real window, isolated profile, real daemon state, synthetic providers.
// Run against another checkout with NAW_TEST_APP_ROOT; build that checkout first.
if (process.argv[2] !== '--run') { console.error('UNARMED'); process.exit(64); }
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const scratch = require('./fixtures/test-scratch.cjs'), { _electron } = scratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..'), code = fs.realpathSync(process.env.NAW_TEST_APP_ROOT || root), evidence = process.env.NAW_EVIDENCE_DIR;
assert.ok(evidence && path.isAbsolute(evidence) && !evidence.startsWith(root + path.sep));
assert.ok(fs.readFileSync(path.join(code, 'app/dsh/client.js'), 'utf8').includes(fs.readFileSync(path.join(code, 'app/renderer/renderer.js'), 'utf8')), 'Build exact renderer first');
const token = randomUUID(), slot = process.env.NAW_GUI_TEST_SLOT || path.join(root, '.local/gui-test-slot.lock');
fs.mkdirSync(path.dirname(slot), { recursive: true });
try { fs.mkdirSync(slot); } catch (e) { if (e.code !== 'EEXIST') throw e; console.error('GUI slot occupied; no launch'); process.exit(75); }
const slotStat = fs.lstatSync(slot); fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ token, pid: process.pid, task: 'session identity' }));
const pictures = path.join(process.env.NAW_PICTURES_DIR || path.join(os.homedir(), 'Pictures/naw-dogfood'), 'session-identity-' + token);
fs.mkdirSync(evidence, { recursive: true, mode: 0o700 }); fs.mkdirSync(pictures, { recursive: true, mode: 0o700 });
const report = { checks: [], pictures, errors: [], models: 0 }, wait = ms => new Promise(r => setTimeout(r, ms));
let parent, profile, daemon, client, app, page, sequence = 0;
async function until(fn, label) { for (let n = 0; n < 160; n++) { if (await fn()) return; await wait(50); } throw Error(label); }
async function check(name, fn) { try { await fn(); report.checks.push({ name, pass: true }); } catch (e) { report.checks.push({ name, pass: false, error: e.message }); } }
function fixture(method, target, value) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { daemon.off('message', receive); reject(Error('Fixture timeout')); }, 8000);
    const receive = r => { if (r.requestId !== id) return; clearTimeout(timer); daemon.off('message', receive); r.error ? reject(Error(r.error)) : resolve(r); };
    daemon.on('message', receive); daemon.send({ id, method, target, value });
  });
}
const truth = () => page.evaluate(() => workspace.initial());
(async () => {
  try {
    parent = scratch.directory(path.join(fs.realpathSync(os.tmpdir()), 'naw-identity-')); profile = path.join(parent, 'profile');
    const cwd = path.join(parent, 'workspace'); fs.mkdirSync(profile, { mode: 0o700 }); fs.mkdirSync(cwd, { mode: 0o700 });
    const sourceIcons = path.join(os.homedir(), 'Library/Application Support/Native Agent Workspace/vendor-icons');
    fs.mkdirSync(path.join(profile, 'vendor-icons'));
    for (const vendor of ['anthropic', 'openai', 'deepseek']) fs.copyFileSync(path.join(sourceIcons, vendor + '.png'), path.join(profile, 'vendor-icons', vendor + '.png'));
    daemon = scratch.childProcess.fork(path.join(code, 'app/daemon.cjs'), [profile], { execArgv: ['--require', path.join(root, 'scripts/fixtures/session-identity.cjs')], env: { ...process.env, NAW_TEST_APP_ROOT: code, NAW_WORKSPACE: cwd, NAW_APP_VERSION: require(path.join(code, 'package.json')).version }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    daemon.stderr.pipe(fs.createWriteStream(path.join(evidence, 'daemon.log')));
    await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Synthetic daemon readiness');
    client = await require(path.join(code, 'app/service-connection.cjs')).connectService(profile, 'identity-fixture');
    const ids = [], names = ['Claude · 方案', 'Codex · 实现与核对', 'DeepSeek · 资料'];
    for (let i = 0; i < names.length; i++) {
      const id = await client.call('create', { provider: i ? 'codex' : 'claude', view: 'terminal', name: names[i], cwd }); ids.push(id);
      await client.call('join', id, true); await client.call('draft', id, '未发送的独立草稿 ' + i);
      await fixture('history', id, [{ id: 'synthetic-' + i, type: 'agentMessage', turnId: 'sample', text: '这是合成会话。\n成员身份与各自内容放在同一列；此处没有调用模型。' }]);
      await fixture('output', id, { data: '\x1bc合成终端 · 同一个原生会话\r\n尚未发送任何输入。' });
    }
    const entry = require('./fixtures/synthetic-source-boot.cjs').createSourceEntry({ profile, code, fixturePid: daemon.pid });
    app = await _electron.launch({ executablePath: require('electron'), args: [entry], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid), NAW_TEST_UI_LANGUAGE: 'zh' }, timeout: 60000 });
    page = await app.firstWindow(); page.setDefaultTimeout(8000); page.on('pageerror', e => report.errors.push(e.message));
    await page.locator('#new-session').waitFor(); await require('./fixtures/default-space.cjs').revealDefaultSpace(page);
    const identities = async () => (await truth()).sessions.map(s => ({ id: s.id, nativeId: s.nativeId, name: s.name, provider: s.provider, draft: s.liveDraft, joined: s.joined }));
    const before = await identities();
    await check('native-reported vendors, independent of shell', async () => assert.deepEqual((await truth()).sessions.map(s => s.vendor), ['anthropic', 'openai', 'deepseek']));
    await check('hidden test window', async () => assert.equal(await (await app.browserWindow(page)).evaluate(w => w.isVisible()), false));
    for (const [width, height] of [[1240, 820], [850, 600]]) {
      await (await app.browserWindow(page)).evaluate((w, size) => w.setContentSize(...size), [width, height]);
      await page.locator('#room-nav').click(); await page.getByRole('button', { name: '网格', exact: true }).click();
      await until(() => page.locator('.collaboration-member-status:visible').count().then(n => n === 3), 'Three member columns');
      await page.screenshot({ path: path.join(pictures, `overview-${width}x${height}.png`) });
      await check(`${width}: one visible member identity per column`, async () => {
        assert.equal(await page.locator('#room-member-tabs').isVisible(), false);
        for (const id of ids) assert.equal(await page.locator(`.collaboration-member-status[data-member-id="${id}"] .collaboration-member-name:visible`).count(), 1);
      });
      await check(`${width}: local logos load and leave status dots clear`, async () => {
        const marks = await page.locator('.session-link .agent-icon').evaluateAll(elements => elements.map(e => {
          const image = e.querySelector('img'), dot = e.querySelector('.state-dot'), a = image?.getBoundingClientRect(), b = dot?.getBoundingClientRect();
          return { loaded: Boolean(image?.complete && image.naturalWidth), overlap: Boolean(a && b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) };
        }));
        assert.equal(marks.length, 3); assert.ok(marks.every(m => m.loaded && !m.overlap));
      });
      // Exact session row, not a text match that could choose a column or another session.
      await page.locator(`.session-link[data-session-id="${ids[0]}"]`).click();
      await until(() => page.locator('#session-view').isVisible(), 'Solo session');
      await page.locator('#terminal-tab').click();
      await page.screenshot({ path: path.join(pictures, `session-${width}x${height}.png`) });
      await check(`${width}: switch A uses each pane's toolbar`, async () => {
        assert.equal(await page.locator('#conversation-pane-toolbar #chat-tab').count(), 1);
        assert.equal(await page.locator('.native-pane-toolbar #terminal-tab').count(), 1);
      });
      await page.locator('#chat-maximize').click();
      await check(`${width}: collapsed terminal can be restored from chat toolbar`, async () => assert.equal(await page.locator('#conversation-pane-toolbar #terminal-tab:visible').count(), 1));
      await page.locator('#terminal-tab').click();
      await page.locator('#terminal-maximize').click();
      await check(`${width}: maximized terminal keeps a visible return to chat`, async () => assert.equal(await page.locator('.native-pane-toolbar #chat-tab:visible').count(), 1));
      await page.locator('#chat-tab').click();
    }
    // A second hidden launch proves the actual missing-file fallback, including
    // a cold desktop cache; only this temporary profile's copies are moved.
    await app.close();
    fs.renameSync(path.join(profile, 'vendor-icons'), path.join(profile, 'vendor-icons-offline'));
    app = await _electron.launch({ executablePath: require('electron'), args: [entry], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid), NAW_TEST_UI_LANGUAGE: 'zh' }, timeout: 60000 });
    page = await app.firstWindow(); page.setDefaultTimeout(8000); page.on('pageerror', e => report.errors.push(e.message));
    await until(() => page.locator('.session-link').count().then(n => n === 3), 'Restored synthetic sessions');
    await check('missing local files restore letters on a hidden cold launch', async () => {
      assert.equal(await (await app.browserWindow(page)).evaluate(w => w.isVisible()), false);
      for (const [i, letter] of ['A', 'O', 'D'].entries()) {
        const mark = page.locator(`.session-link[data-session-id="${ids[i]}"] .agent-icon`);
        assert.equal(await mark.locator('img').count(), 0);
        assert.equal((await mark.textContent()).trim(), letter);
      }
    });
    await check('same sessions, memberships and private drafts survive view switches', async () => assert.deepEqual(await identities(), before));
    await check('no provider sends, terminal input or renderer errors', async () => { const value = await fixture('stats'); assert.equal(value.stats.sends, 0); assert.equal(value.stats.inputs, 0); assert.deepEqual(report.errors, []); });
  } catch (e) { report.failure = e.stack; process.exitCode = 1; }
  finally {
    try {
      scratch.cleanup(async () => { if (app) await app.close(); if (client) { await client.call('shutdown').catch(() => {}); client.close(); } }); await scratch.release();
      report.cleaned = !parent || !fs.existsSync(parent); assert.ok(report.cleaned); assert.ok(!daemon || daemon.exitCode !== null || daemon.signalCode !== null);
      const current = fs.lstatSync(slot); assert.equal(current.ino, slotStat.ino); assert.equal(JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))).token, token);
      fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot);
    } catch (e) { report.cleanupError = e.stack; process.exitCode = 1; }
    report.pass = report.checks.filter(c => c.pass).length; report.fail = report.checks.filter(c => !c.pass).length;
    if (report.fail) process.exitCode = 1;
    fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
  }
})();
