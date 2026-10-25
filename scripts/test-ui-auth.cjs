const testScratch = require('./fixtures/test-scratch.cjs');
// Real Electron cookie/header regression. Uses only a private empty profile.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const { _electron } = testScratch.playwright(require('playwright'));
const { connect } = require('../app/service-client.cjs');
const root = path.resolve(__dirname, '..');
const profile = testScratch.directory(path.join(os.tmpdir(), 'naw-ui-auth-'));
let application, page;
async function launch() {
  application = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = null;
  for (let n = 0; n < 600 && !page; n++) {
    for (const candidate of application.windows()) if (!candidate.isClosed() && await candidate.locator('#new-session').count().catch(() => 0)) { page = candidate; break; }
    if (!page) await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(page, 'Main workspace page booted');
}
async function run() {
  await launch();
  await application.evaluate(async ({ session }) => {
    const cookies = session.defaultSession.cookies;
    for (let i = 0; i < 80; i++) await cookies.set({ url: 'http://127.0.0.1/', name: `dsh-auth-${String(i).padStart(43, '0')}`, value: 'x'.repeat(300), path: '/', httpOnly: true, sameSite: 'strict', expirationDate: Date.now() / 1000 + 3600 });
    await cookies.set({ url: 'http://127.0.0.1/', name: 'unrelated-preference', value: 'keep', expirationDate: Date.now() / 1000 + 3600 });
    await cookies.flushStore();
  });
  // Prove this is the observed failure, rather than only testing deletion mocks.
  const failed = await page.reload();
  assert.equal(failed.status(), 431);
  await application.close(); application = null;
  await launch();
  const result = await application.evaluate(async ({ session, BrowserWindow }) => {
    const cookies = await session.defaultSession.cookies.get({ domain: '127.0.0.1' });
    return { auth: cookies.filter(c => c.name.startsWith('dsh-auth-')).length, preference: cookies.find(c => c.name === 'unrelated-preference')?.value, hidden: BrowserWindow.getAllWindows().every(w => !w.isVisible()) };
  });
  assert.deepEqual(result, { auth: 1, preference: 'keep', hidden: true });
  assert.equal((await page.evaluate(() => workspace.initial())).sessions.length, 0);
  await page.locator('#new-session').click();
  await page.locator('#confirm-create').waitFor();
  // Reloads and additional windows must retain this launch's authentication.
  assert.equal((await page.reload()).status(), 200);
  await page.locator('#new-session').waitFor();
  await page.evaluate(() => workspace.newWindow());
  for (let i = 0; i < 100 && application.windows().length < 2; i++) await new Promise(r => setTimeout(r, 50));
  const second = application.windows().find(p => p !== page);
  assert.ok(second); await second.locator('#new-session').waitFor();
  assert.equal((await second.evaluate(() => workspace.initial())).sessions.length, 0);
  console.log('PASS: reproduced HTTP 431 with accumulated UI cookies; restart restores usable UI, keeps unrelated preference, supports reload/second window; zero native sessions or model calls.');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(testScratch.cleanup(async () => {
  if (application) await application.close();
  try { const client = await connect(profile, 'ui-auth-cleanup'); try { await client.call('shutdown'); } finally { client.close(); } } catch { /* No unrelated processes are touched. */ }
}));
