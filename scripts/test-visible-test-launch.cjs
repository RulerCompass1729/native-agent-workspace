const testScratch = require('./fixtures/test-scratch.cjs');
// Isolated headed-test launches stay hidden by default. NAW_TEST_VISIBLE=1 keeps
// the same isolation but shows the window, without focus, so a person can watch
// it close and reopen. One owned profile; no native provider or model calls.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const { _electron } = testScratch.playwright(require(path.join(root, 'node_modules/playwright')));
const executable = process.env.NAW_APP_EXECUTABLE || require(path.join(root, 'node_modules/electron'));
const common = require('node:child_process').execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = require('node:crypto').randomUUID();
try { fs.mkdirSync(slot); } catch (error) { if (error.code !== 'EEXIST') throw error; console.error('GUI slot occupied; no test app launched.'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'CodexMain', task: 'Isolated visible launch', token, pid: process.pid, at: new Date().toISOString() }), { mode: 0o600 });
const profile = testScratch.directory(path.join(os.tmpdir(), 'naw-visible-test-'));
let app;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function launch(visible) {
  const env = { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) };
  if (visible) env.NAW_TEST_VISIBLE = '1'; else delete env.NAW_TEST_VISIBLE;
  app = await _electron.launch({ executablePath: executable, args: process.env.NAW_APP_EXECUTABLE ? [] : [root], env, timeout: 70000 });
  const page = await app.firstWindow(); await page.locator('#new-session').waitFor({ timeout: 60000 });
  // showInactive runs on ready-to-show; give it a moment after the first paint.
  let windows; for (let i = 0; i < 40; i++) { windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ visible: w.isVisible(), focused: w.isFocused() }))); if (!visible || windows.some(w => w.visible)) break; await sleep(100); }
  return windows;
}
const cleanup = testScratch.cleanup(async () => {
  if (app) await app.close().catch(() => {});
  const { connect } = require(path.join(root, 'app/service-client.cjs'));
  if (fs.existsSync(path.join(profile, 'connection.json'))) { try { const client = await connect(profile, 'visible-test-cleanup'); try { await client.call('shutdown'); } finally { client.close(); } } catch { /* already stopped */ } }
});
(async () => {
  const checks = [];
  for (const round of ['first launch', 'reopen after close']) {
    const windows = await launch(true);
    assert.ok(windows.length > 0 && windows.every(w => w.visible), `${round}: visible test window shown ${JSON.stringify(windows)}`);
    assert.ok(windows.every(w => !w.focused), `${round}: the visible test window does not take focus`);
    checks.push(`${round}: shown without focus`);
    await app.close(); app = null;
  }
  const hidden = await launch(false);
  assert.ok(hidden.length > 0 && hidden.every(w => !w.visible && !w.focused), `Default isolated test stays hidden ${JSON.stringify(hidden)}`);
  checks.push('without NAW_TEST_VISIBLE the isolated test window stays hidden');
  await app.close(); app = null;
  console.log(JSON.stringify({ checks, modelCalls: 0 }));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  try { await cleanup();
    assert.equal(fs.existsSync(profile), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))).token, token);
    fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot);
  } catch (error) { console.error('Owned cleanup failed; this finalizer retains its GUI lock:', error); process.exitCode = 1; }
});
