// Actual source/installed UI, actual Workspace and quota observer; synthetic transport only.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const scratch = require('./fixtures/test-scratch.cjs'), { createIn } = require('./fixtures/create-view.cjs');
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const installed = Boolean(process.env.NAW_APP_EXECUTABLE);
const { _electron } = scratch.playwright(installed ? { _electron: require('./fixtures/installed-renderer.cjs') } : require('playwright'));
const { connectService } = require(path.join(code, 'app/service-connection.cjs'));
const { createSourceEntry } = require('./fixtures/synthetic-source-boot.cjs');
const locale = require(path.join(code, 'app/ui-locale.js'));
const slot = path.join(root, '.local/gui-test-slot.lock'), token = randomUUID();
try { fs.mkdirSync(slot, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; console.log('OCCUPIED; no fixture or GUI launched'); process.exit(75); }
const slotStat = fs.statSync(slot), owner = { owner: 'CodexMain', task: 'I181 native quota usage UI', token, pid: process.pid };
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify(owner));
const profile = scratch.directory(path.join(os.tmpdir(), 'naw-account-usage-'));
const child = scratch.childProcess.fork(path.join(code, 'app/daemon.cjs'), [profile], {
  execArgv: ['--require', path.join(__dirname, 'fixtures/codex-account-usage.cjs')],
  env: { ...process.env, NAW_TEST_APP_ROOT: code, NAW_WORKSPACE: profile, NAW_APP_VERSION: require(path.join(code, 'package.json')).version },
  stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
});
const evidence = process.env.NAW_EVIDENCE_DIR;
if (evidence) { assert.ok(!path.resolve(evidence).startsWith(root + path.sep)); fs.mkdirSync(evidence, { recursive: true, mode: 0o700 }); }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms)), errors = [], checks = [];
let application, page, client, sequence = 0;
async function until(fn, label) { for (let i = 0; i < 200; i++) { if (await fn()) return; await delay(40); } throw Error(label); }
function fixture(method = 'inspect', target, value) {
  const id = ++sequence;
  return new Promise((resolve, reject) => { const timer = setTimeout(() => { child.off('message', received); reject(Error('Fixture timeout')); }, 8000);
    const received = m => { if (m.requestId !== id) return; child.off('message', received); clearTimeout(timer); resolve(m); };
    child.on('message', received); child.send({ id, method, target, value }); });
}
const snapshot = () => client.call('initial');
const check = name => { checks.push(name); console.log('PASS:', name); };
const shot = name => evidence && page && !page.isClosed() ? page.screenshot({ path: path.join(evidence, name + '.png') }) : null;
async function run() {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Owned synthetic daemon ready');
  const entry = createSourceEntry({ profile, code, fixturePid: child.pid });
  application = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: installed ? [] : [entry],
    env: { ...process.env, NAW_DATA_DIR: profile, NAW_WORKSPACE: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await application.firstWindow(); page.setDefaultTimeout(12000); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#new-session').waitFor(); client = await connectService(profile, 'owned-quota-ui');
  const make = async (provider, name) => { await page.locator('#new-session').click(); await page.locator(`input[name="provider"][value="${provider}"]`).check(); await page.locator('#session-name').fill(name); await createIn(page, 'chat');
    await until(async () => (await snapshot()).sessions.find(s => s.name === name)?.state === 'idle', 'Synthetic session ready'); return (await snapshot()).sessions.find(s => s.name === name); };
  const a = await make('codex', 'Quota A'), b = await make('codex', 'Quota B'), cl = await make('claude', 'Context label');
  await page.locator('#setup-button').click(); await page.locator('#ui-language').selectOption('en'); await page.locator('#close-setup').click();
  await page.locator(`[data-session-id="${a.id}"]`).click();
  const draft = 'Unsent quota fixture draft 你好'; await page.locator('#message-input').fill(draft);
  await page.locator('#privacy-button').click(); await page.locator('#privacy-dialog').waitFor();
  const row = id => page.locator(`[data-usage-session="${id}"]`);
  assert.doesNotMatch(await row(a.id).innerText(), /0%|81%/);
  await fixture('quota-token', a.id, { total: { inputTokens: 12, cachedInputTokens: 3, outputTokens: 7 }, last: {}, reportedAt: Date.now() });
  await fixture('quota-update', a.id, { limitId: 'codex', limitName: 'Native quota', primary: { usedPercent: 37, windowDurationMins: 300, resetsAt: 1730947200 }, secondary: { usedPercent: 81, windowDurationMins: 10080, resetsAt: null } });
  await page.locator('#refresh-trust').click();
  await until(async () => (await row(a.id).innerText()).includes('81%'), 'Actual GUI renders native quota');
  for (const id of [a.id, b.id]) { assert.match(await row(id).innerText(), /Shared account limits.*Native quota/); assert.match(await row(id).innerText(), /37%/); assert.match(await row(id).innerText(), /81%/); assert.doesNotMatch(await row(id).innerText(), /162%/); }
  assert.doesNotMatch(await row(cl.id).innerText(), /81%|Native quota/);
  assert.match(await row(a.id).innerText(), /12/); await shot('account-quota-en');
  check('Existing usage area shows native account windows, preserves token usage and never sums across sessions/providers');
  await page.locator('#close-privacy').click(); assert.equal(await page.locator('#message-input').inputValue(), draft);
  await page.locator('#setup-button').click(); await page.locator('#ui-language').selectOption('zh'); await page.locator('#close-setup').click();
  await page.locator('#privacy-button').click(); await until(async () => (await row(a.id).innerText()).includes('账户共享额度'), 'Chinese account labels');
  assert.match(await row(a.id).innerText(), /81%/); await shot('account-quota-zh');
  check('Both interface languages retain the original native bucket label and numeric readings');
  await fixture('quota-account-change', a.id); await page.locator('#refresh-trust').click();
  await until(async () => !(await row(a.id).innerText()).includes('81%'), 'Account identity change removes old quota');
  assert.doesNotMatch(await row(a.id).innerText(), /0%/); assert.match(await row(a.id).innerText(), /12/); await shot('account-unknown');
  await page.locator('#close-privacy').click(); assert.equal(await page.locator('#message-input').inputValue(), draft);
  check('Account invalidation clears stale quota on the existing refresh without losing tokens or the unsent draft');
  await page.locator(`[data-session-id="${cl.id}"]`).click(); const pendingDraft = 'Unsent original context draft'; await page.locator('#message-input').fill(pendingDraft);
  await fixture('context-pending', cl.id);
  await until(async () => (await page.locator('#session-status').innerText()).includes(locale.format('zh', 'collab.contextUnknown')), 'Pending native context has its exact existing label');
  assert.doesNotMatch(await page.locator('#session-status').innerText(), /退出确认/); assert.equal(await page.locator('#message-input').inputValue(), pendingDraft); assert.equal(await page.locator('#send-button').isDisabled(), true); await shot('pending-context');
  check('I177 pending context is not reported as native exit, and its draft remains retained without permission to send');
  const stats = await fixture(); assert.deepEqual(stats.sends, []); assert.deepEqual(stats.inputs, []); assert.deepEqual(stats.interruptions, []); assert.equal(stats.accountReads, 2); assert.equal((await snapshot()).diagnostics.dispatches, 0); assert.deepEqual(errors, []);
  const result = { checks, errors, stats, productModelCalls: 0, providerProcesses: 0, limits: 'Actual GUI with synthetic native quota/state facts; not current-account/native-client-menu/original-author lifecycle proof.' };
  if (evidence) fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
}
scratch.cleanup(async () => {
  if (application) await application.close();
  if (client) { for (const s of (await snapshot()).sessions) await client.call('stop', s.id); await fixture('quota-finish'); await client.call('shutdown'); client.close(); }
  if (child.connected) child.disconnect(); if (child.exitCode === null) child.kill('SIGTERM');
});
run().catch(async e => { process.exitCode = 1; console.error(e.stack); if (evidence) { fs.writeFileSync(path.join(evidence, 'failure.json'), JSON.stringify({ error: e.message, checks, errors })); await shot('failure').catch(() => {}); } }).finally(async () => {
  try { await scratch.release(); const ownerNow = JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))); assert.equal(ownerNow.token, token); const st = fs.statSync(slot); assert.equal(st.dev, slotStat.dev); assert.equal(st.ino, slotStat.ino); fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot); if (evidence) fs.writeFileSync(path.join(evidence, 'released.json'), JSON.stringify({ ...owner, ownedCleanup: true })); }
  catch (e) { console.error('Cleanup unconfirmed; exact lease retained:', e.message); process.exitCode = 1; }
});
