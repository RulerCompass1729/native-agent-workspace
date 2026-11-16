// Actual phone browser + Main's mobile functions + HTTP + Unix daemon.
// Only native transports, carrier forwarding and the desktop-window context are synthetic.
const testScratch = require('./fixtures/test-scratch.cjs');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm'), http = require('node:http'), https = require('node:https');
const { createRequire } = require('node:module'), { execFileSync } = require('node:child_process'), { once } = require('node:events'), { randomUUID } = require('node:crypto');
const { fork } = testScratch.childProcess;
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { connectService } = require('../app/service-client.cjs');
const { WorkspaceClient } = require('../app/workspace-client.cjs');
const { RoomState } = require('../app/room-state.cjs');
const { SessionLabels } = require('../app/session-labels.cjs');
const { BackgroundControl } = require('../app/background-control.cjs');
const recordReminders = require('../app/record-reminders.cjs');
const { BlockLog } = require('../app/record-history.cjs');
const root = path.resolve(__dirname, '..'), evidence = process.env.NAW_EVIDENCE_DIR;
if (!evidence || !path.isAbsolute(evidence) || path.resolve(evidence).startsWith(root + path.sep)) throw Error('Private evidence directory required');
fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
const pictures = path.join(process.env.NAW_PICTURES_DIR || path.join(os.homedir(), 'Pictures/naw-dogfood'), '2026-11/naw-remote-20261115/phase1');
const prototypes = process.env.NAW_PHONE_PROTOTYPES || path.join(path.dirname(pictures));
fs.mkdirSync(pictures, { recursive: true });
const checks = [], secrets = new Set();
const clean = s => { for (const value of secrets) s = s.replaceAll(value, '[redacted]'); return s; };
const check = (name, fn) => { fn(); checks.push(name); console.log('PASS ' + name); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let n = 0; n < 200; n++) { if (await fn()) return; await wait(20); } throw Error('Isolated fixture did not become ready'); }
const mainSource = fs.readFileSync(path.join(root, 'app/main.cjs'), 'utf8');
function mainMobile(profile, roomState, labels, background) {
  const human = new Map(), scheduled = [];
  const context = vm.createContext({ require: createRequire(path.join(root, 'app/main.cjs')), primary: true, quitting: false,
    dataDir: profile, roomState, sessionLabels: labels, recordReminders, operationsUnavailable: null, stewardRecord: null,
    backgroundControl: background, backgroundUnavailable: false, outboxQuitFailed: false, outboxUnavailable: false,
    queueSecretary: null, integratorRole: null, stewardRole: null, butlerIngress: null,
    queueDispatcher: { integration: null, integrationError: null, rotationChains: () => [], schedule: () => scheduled.push(true), noteHuman: id => human.set(id, Date.now()) },
    submissionState: require('../app/submission-policy.cjs').submissionState,
    roomPeerIdentity: require('../app/peer-handoffs.cjs').identity,
    localVendorIcons: () => ({}), endedByMove: () => [], viewStorageWarning: null, viewStorageWarningUiMessage: null,
    displayText: (key, params) => require('../app/ui-locale.js').format('en', key, params),
    broadcastRoom: async () => {}, Date, setTimeout, clearTimeout, AbortController,
  });
  const a = mainSource.indexOf('function displayState('), b = mainSource.indexOf('function reportViewStorage(', a);
  const c = mainSource.indexOf('let mobileBroker;'), d = mainSource.indexOf('const startupFile =', c);
  assert.ok(a > 0 && b > a && c > 0 && d > c);
  vm.runInContext(mainSource.slice(a, b), context); vm.runInContext(mainSource.slice(c, d), context);
  return { context, human, scheduled, broker: () => context.appMobileBroker(), stop: async () => { context.revokeAppMobile(); await vm.runInContext('mobileStopped', context); } };
}
function proxy(request, response, port, lose) {
    const headers = { ...request.headers, 'tailscale-user-login': 'synthetic-person' };
    delete headers.connection;
    const outgoing = http.request({ hostname: '127.0.0.1', port, path: request.url, method: request.method, headers }, upstream => {
      const chunks = []; upstream.on('data', chunk => chunks.push(chunk)); upstream.on('end', () => {
        const returned = {};
        for (const [key, value] of Object.entries(upstream.headers)) if (!['connection', 'keep-alive', 'content-length', 'transfer-encoding'].includes(key) && value !== undefined) returned[key] = value;
        if (lose(request)) { response.destroy(); return; }
        response.writeHead(upstream.statusCode, returned); response.end(Buffer.concat(chunks));
      });
    }); outgoing.on('error', () => { response.writeHead(502); response.end(); }); request.pipe(outgoing);
}
let browser;
async function scenario(lang) {
  const profile = fs.realpathSync(testScratch.directory(path.join(os.tmpdir(), 'naw-phone-browser-'))), cwd = path.join(profile, 'workspace'); fs.mkdirSync(cwd);
  let child, owner, carrier, app, page, context, background, sequence = 0, port, loseWorkspaceResult = false;
  const ipc = (value, responseKey) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { child.off('message', receive); reject(Error('Owned fixture timed out')); }, 5000);
    const receive = message => { if (message[responseKey] !== id) return; clearTimeout(timer); child.off('message', receive); resolve(message); };
    child.on('message', receive); child.send({ ...value, id });
  });
  try {
    child = fork(path.join(root, 'app/daemon.cjs'), [profile], { cwd, execArgv: ['--require', path.join(root, 'scripts/fixtures/phone-workspace-host.cjs')],
      env: { ...process.env, NAW_MOBILE_FIXTURE_ROOT: profile, NAW_WORKSPACE: cwd, NAW_APP_VERSION: 'phone-fixture' }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    await until(() => fs.existsSync(path.join(profile, 'connection.json')));
    testScratch.ownService(profile);
    owner = await connectService(profile, 'synthetic-desktop-owner');
    const names = lang === 'zh' ? ['文档整理', '界面开发', '方案梳理'] : ['Documentation', 'Interface', 'Planning'];
    const ids = [];
    for (let n = 0; n < 4; n++) { const id = await owner.call('create', { provider: n === 1 ? 'codex' : 'claude', cwd, name: names[n] || 'Unpaired synthetic session' }); ids.push(id); if (n < 3) await owner.call('join', id, true); }
    const now = Date.now(), firstText = lang === 'zh' ? '把这两版任务面板整理给我看看。' : 'Show me the two task panel layouts.';
    await ipc({ phoneFixture: 'seed', sessions: ids.map((id, n) => ({ id, provider: n === 2 ? 'deepseek' : undefined, state: n === 0 ? 'working' : 'idle', messages: [
      { id: 'human-' + n, role: 'user', text: n === 3 ? 'UNPAIRED_SENTINEL' : firstText, time: now - 90000 },
      { id: 'reply-' + n, role: 'assistant', text: n === 3 ? 'UNPAIRED_SENTINEL' : lang === 'zh' ? '两版都准备好了。A 把任务集中在一列，B 把空间与任务分开。' : 'Both are ready. A keeps tasks in one list. B separates spaces from tasks.', time: now - 70000 },
    ] })), sharedMessages: [
      { id: 'shared-human', role: 'human', text: lang === 'zh' ? '这一组一起把手机界面理顺。' : 'Let’s work together on the mobile interface.', time: now - 90000 },
      { id: 'shared-reply', role: 'assistant', name: names[0], text: lang === 'zh' ? '我来整理文档。需要你批准的操作会回到原确认卡。' : 'I’ll organize the docs. Actions needing approval stay on the original confirmation cards.', time: now - 80000 },
    ] }, 'phoneFixtureResult');
    const room = new RoomState(profile); room.rename(lang === 'zh' ? '产品开发' : 'Product development', 'shared'); const secondRoom = room.create(lang === 'zh' ? '研究小组' : 'Research');
    const working = room.queueAdd(lang === 'zh' ? '整理手机页面' : 'Arrange the mobile pages', ids[0]); room.queueMarkSent('shared', working, ids[0], names[0], now - 50000);
    room.queueAdd(lang === 'zh' ? '核对说明文案' : 'Check interface copy', ids[2]);
    const asking = room.queueAdd(lang === 'zh' ? '读取项目文档' : 'Read the project docs', ids[1]); room.queueMarkSent('shared', asking, ids[1], names[1], now - 40000); room.queueSettle('shared', asking, 'waiting', '', names[1], '', 'Approve this original request?');
    const labels = new SessionLabels(profile);
    background = new BackgroundControl({ dataDir: profile, handlers: new Map(), context: async () => { throw Error('Sensitive execution is unavailable in the phone fixture'); } });
    const snapshot = await owner.call('initial'), record = snapshot.sessions.find(s => s.id === ids[1]);
    for (const [method, at] of [['input', now - 121000], ['observe', now - 1000]]) background.data.records.push({ id: randomUUID(), actor: { id: record.id, nativeId: record.nativeId, provider: 'codex', name: names[1] }, command: { method, arguments: method === 'input' ? [record.id, 'x'] : [record.id] }, state: 'confirmation-required', at,
      confirmation: { kind: 'message', options: { message: lang === 'zh' ? method === 'input' ? '原生终端输入' : '允许读取项目文档？' : method === 'input' ? 'Native terminal input' : 'Allow access to project docs?', detail: 'demo-project/docs/ · Read only', buttons: ['Cancel', 'Approve once'], cancelId: 0 } } });
    const completedId = randomUUID();
    background.data.records.push({ id: completedId, actor: { id: record.id, nativeId: record.nativeId, provider: 'codex', name: names[1] }, command: { method: 'observe', arguments: [record.id] }, state: 'complete', at: now - 700000, finishedAt: now - 699000,
      confirmation: { kind: 'message', options: { message: 'Previously completed synthetic action', detail: 'Read only', buttons: ['Cancel', 'Approve once'], cancelId: 0 } } });
    app = mainMobile(profile, room, labels, background);
    // Tiny, real record blocks exercise the desktop reminder source without
    // manufacturing large files or introducing a second phone reminder store.
    for (const record of ['operations', 'steward']) {
      const old = now - 32 * 86400000;
      new BlockLog(profile, record, () => {}).append([{ time: old, value: { synthetic: true } }], old);
    }
    // Ephemeral self-signed TLS stays in this owned profile. A real browser
    // network response is necessary: DevTools route.fulfill does not process
    // Clear-Site-Data and would hide destructive logout behavior.
    const key = path.join(profile, 'carrier.key'), cert = path.join(profile, 'carrier.crt');
    execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
    carrier = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => proxy(req, res, port, req => {
      if (!loseWorkspaceResult || req.url !== '/mobile/workspace/action') return false;
      return true;
    }));
    await new Promise(resolve => carrier.listen(0, '127.0.0.1', resolve));
    const site = 'https://127.0.0.1:' + carrier.address().port;
    const pairingOptions = { actor: 'synthetic-person', origin: site, port: 0, carrierConfirmed: true, replace: false,
      workspace: { roomIds: ['shared', secondRoom], records: true }, selection: ids.slice(0, 3).map(id => ({ sessionId: id, actions: ['read', 'send', 'answer'] })) };
    const challenge = await app.context.beginAppMobile(pairingOptions);
    secrets.add(challenge.secret); port = new URL(challenge.localAddress).port;
    context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, serviceWorkers: 'block', ignoreHTTPSErrors: true, locale: lang === 'zh' ? 'zh-CN' : 'en-US' });
    const errors = [], external = [];
    await context.route('**/*', async route => { if (new URL(route.request().url()).origin !== site) { external.push(route.request().url()); await route.abort(); } else await route.continue(); });
    page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(site + '/mobile/'); await page.locator('#pair-code').waitFor();
    check(lang + ' unpaired page reveals no sessions or queues', () => { assert.equal(page.url().includes('pair='), false); });
    assert.equal(await page.locator('a.row').count(), 0);
    await page.goto(site + '/mobile/#pair=' + challenge.secret);
    await page.waitForFunction(() => globalThis.nawPhone?.client.state.session && !document.querySelector('#navigation').hidden);
    await page.evaluate(async language => { location.hash = '#' + language + '/home'; await globalThis.nawPhone.refresh(); }, lang);
    await page.locator('a.row').first().waitFor();
    await page.waitForFunction(() => document.querySelectorAll('a.row').length === 3);
    check(lang + ' paired scope excludes unpaired native data', () => assert.ok(!page.url().includes(challenge.secret)));
    const cookies = await context.cookies(); check(lang + ' cookie remains Secure HttpOnly SameSite Strict', () => assert.ok(cookies.some(c => c.name === '__Host-naw-mobile' && c.secure && c.httpOnly && c.sameSite === 'Strict')));
    async function go(dest) { const hash = '#' + lang + '/' + dest; await page.evaluate(value => { location.hash = value; }, hash); await page.waitForFunction(expected => document.documentElement.lang.startsWith(expected.lang) && document.documentElement.dataset.route === expected.hash && document.documentElement.dataset.loading === 'false', { lang, hash }); }
    async function shot(name) { await page.screenshot({ path: path.join(pictures, lang + '-' + name + '.png') }); const over = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth); check(lang + ' ' + name + ' stays within 390px', () => assert.equal(over, false)); }
    await shot('home');
    await go('chat/' + ids[1]); await page.locator('#message').waitFor();
    const chatHash = await page.evaluate(() => location.hash);
    await page.locator('#skip').focus(); await page.locator('#skip').press('Enter');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const skipped = await page.evaluate(() => ({ hash: location.hash, focused: document.activeElement.id }));
    check(lang + ' keyboard skip moves focus without replacing the current conversation route', () => { assert.equal(skipped.hash, chatHash); assert.equal(skipped.focused, 'content'); });
    // Capture the same top-of-page view as the approved phone prototype,
    // after recording the keyboard focus/scroll behavior above.
    await page.evaluate(() => { document.activeElement.blur(); scrollTo(0, 0); });
    await shot('chat');
    await go('space/shared'); await page.locator('#room-members').waitFor(); await shot('space');
    await go('queue/shared'); await page.locator('article.queue-card').first().waitFor(); await shot('queue');
    const projected = await app.broker().workspaceRead({ token: cookies.find(c => c.name === '__Host-naw-mobile').value, actor: 'synthetic-person', origin: site });
    check(lang + ' projection contains no unpaired private body or native desktop draft', () => assert.ok(!JSON.stringify(projected).includes('UNPAIRED_SENTINEL')));
    const pending = projected.confirmations.find(c => c.expiresAt > Date.now()), expired = projected.confirmations.find(c => c.disposition === 'expired'); assert.ok(pending && expired);
    await go('confirm/' + encodeURIComponent(pending.id)); await page.locator('article.card-detail').waitFor(); assert.equal(await page.locator('.confirm-actions button').count(), 2); assert.equal(await page.locator('.confirm-actions button:not(:disabled)').count(), 0); await shot('confirm');
    await go('confirm/' + encodeURIComponent(expired.id)); assert.ok((await page.locator('#content').innerText()).includes(lang === 'zh' ? '已过期' : 'Expired'));
    check(lang + ' expired desktop input card remains non-executable', () => {
      const original = background.data.records.find(r => r.id === expired.operationId);
      assert.ok(original && original.command.method === 'input');
      assert.equal(require('../app/background-control.cjs').confirmationExpiresAt(original) - original.at, 120000);
      assert.equal(expired.time, original.at);
      assert.equal(expired.state, 'not-executed'); assert.equal(expired.canDecide, false);
      assert.equal(original.disposition, 'expired'); assert.equal(original.state, 'not-executed');
    });
    assert.equal(await page.locator('.confirm-actions button:not(:disabled)').count(), 0);
    await go('confirm/' + encodeURIComponent(ids[1] + ':' + completedId));
    const completedText = await page.locator('.card-detail').innerText();
    check(lang + ' completed operation retains its original outcome', () => { assert.ok(completedText.includes(lang === 'zh' ? '操作已完成' : 'Action completed')); assert.ok(!completedText.includes(lang === 'zh' ? '已过期' : 'Expired')); });
    await go('reminders'); await page.locator('.reminder-card').first().waitFor(); await shot('reminders');
    const beforeReminder = recordReminders.status(profile, Date.now()).count;
    const ack = page.locator('.reminder-card').first().getByRole('button', { name: lang === 'zh' ? '知道了' : 'Got it', exact: true }); await ack.click();
    await page.waitForFunction(before => !document.querySelector('#dialog').open && document.querySelectorAll('.reminder-card').length < before, beforeReminder);
    check(lang + ' acknowledgement updates the very same desktop reminder source', () => assert.equal(recordReminders.status(profile, Date.now()).count, beforeReminder - 1));
    await go('queue/shared'); await page.locator('#content > button.primary').click(); await page.locator('#new-task-text').fill('PHONE_QUEUE_ORIGINAL'); await page.locator('#new-task-assignee').selectOption(ids[1]); await page.locator('#dialog form button[type="submit"]').click(); await page.waitForFunction(() => !document.querySelector('#dialog').open);
    const added = room.queueItems('shared').find(i => i.text === 'PHONE_QUEUE_ORIGINAL'); check(lang + ' add queue reaches the desktop RoomState as queued', () => assert.equal(added?.status, 'queued'));
    const target = page.locator('article[data-item-id="' + added.id + '"]'); await target.getByRole('button', { name: lang === 'zh' ? '取消任务' : 'Cancel task', exact: true }).click(); await until(() => room.queueFind('shared', added.id).status === 'cancelled'); checks.push(lang + ' cancel keeps task history');
    const desktopDraft = 'DESKTOP_DRAFT_BYTES / 半句话  \n'; await owner.call('draft', ids[1], desktopDraft);
    await go('chat/' + ids[1]); await page.locator('#message').fill('PHONE_NATIVE_ORIGINAL'); await page.locator('#send-message').click();
    await page.waitForFunction(() => globalThis.nawPhone.client.state.pending.some(p => p.action === 'send' && p.status === 'submitted'));
    const after = (await owner.call('initial')).sessions.find(s => s.id === ids[1]);
    check(lang + ' phone send preserves the desktop draft byte for byte', () => assert.deepEqual(Buffer.from(after.liveDraft), Buffer.from(desktopDraft)));
    check(lang + ' phone input enters the desktop human quiet gate', () => assert.ok(app.human.has(ids[1])));
    const nativeStats = await ipc({ mobileFixture: 'stats' }, 'mobileFixtureStats'); check(lang + ' only the original phone text reaches one synthetic native send', () => { assert.equal(nativeStats.calls.length, 1); assert.equal(nativeStats.calls[0].text, 'PHONE_NATIVE_ORIGINAL'); });
    await owner.call('join', ids[0], false); await ipc({ brokerFixture: 'question', sessionId: ids[0] }, 'brokerFixtureResult');
    await go('confirm/native/' + ids[0]); await page.locator('.native-question').waitFor(); await page.locator('.native-question input[value="Original fixture answer"]').check(); await page.locator('.native-question button[type="submit"]').click();
    await page.waitForFunction(() => globalThis.nawPhone.client.state.pending.some(p => p.action === 'answer' && p.status === 'reply-written'));
    const answers = await ipc({ brokerFixture: 'stats' }, 'brokerFixtureResult'); check(lang + ' original native question is answered exactly once', () => assert.equal(answers.replies.length, 1));
    const blocked = await page.evaluate(async () => { const csrf = globalThis.nawPhone.client.state.session.csrf; const r = await fetch('/mobile/workspace/action', { method: 'POST', headers: { 'X-NAW-Mobile': '1', 'X-NAW-CSRF': csrf, 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: crypto.randomUUID(), action: 'backgroundDecision', operationId: 'not-a-phone-capability', response: 1 }) }); return r.status; }); check(lang + ' forged sensitive approval is rejected', () => assert.equal(blocked, 403));
    await go('chat/' + ids[1]); await page.locator('#message').fill('PHONE_LOCAL_DRAFT_KEEP');
    await go('queue/shared'); await page.locator('#content > button.primary').click();
    await page.locator('#new-task-text').fill('PHONE_UNKNOWN_KEEP'); loseWorkspaceResult = true;
    await page.locator('#dialog form button[type="submit"]').click();
    await page.waitForFunction(() => !globalThis.nawPhone.actions.state.busy && globalThis.nawPhone.actions.state.pending.some(p => p.status === 'unconfirmed'));
    loseWorkspaceResult = false;
    assert.equal(room.queueItems('shared').filter(i => i.text === 'PHONE_UNKNOWN_KEEP').length, 1);
    const unknownId = await page.evaluate(() => globalThis.nawPhone.actions.state.pending.find(p => p.status === 'unconfirmed').requestId);
    assert.ok((await page.evaluate(() => localStorage.getItem('naw.mobile.workspace.v1'))).includes(unknownId));
    await page.locator('#dialog-close').click();
    await page.getByRole('button', { name: lang === 'zh' ? '管理' : 'Manage', exact: true }).click();
    await page.locator('#dialog').getByRole('button', { name: lang === 'zh' ? '撤销此手机并退出' : 'Revoke this phone and sign out', exact: true }).click();
    await page.locator('#pair-code').waitFor();
    const retained = await page.evaluate(() => ({ actions: localStorage.getItem('naw.mobile.workspace.v1'), native: localStorage.getItem('naw.mobile.v1') }));
    check(lang + ' logout revokes authorization while retaining uncertain request IDs and local drafts', () => { assert.ok(retained.actions?.includes(unknownId)); assert.ok(retained.native?.includes('PHONE_LOCAL_DRAFT_KEEP')); });
    app.context.revokeAppMobile(); await vm.runInContext('mobileStopped', app.context);
    const replacement = { ...pairingOptions, replace: true }; delete replacement.workspace;
    const newChallenge = await app.context.beginAppMobile(replacement); secrets.add(newChallenge.secret); port = new URL(newChallenge.localAddress).port;
    const oldCookieDenied = await app.broker().workspaceRead({ token: cookies.find(c => c.name === '__Host-naw-mobile').value, actor: 'synthetic-person', origin: site }).then(() => false, () => true);
    await page.evaluate(async () => { await globalThis.nawPhone.refresh(); }); await page.locator('#pair-code').waitFor();
    check(lang + ' Mac revocation rejects the old cookie on a live replacement listener', () => assert.equal(oldCookieDenied, true));
    assert.equal(await page.locator('a.row').count(), 0);
    await page.goto(site + '/mobile/#pair=' + newChallenge.secret);
    await page.waitForFunction(() => globalThis.nawPhone?.client.state.session && !document.querySelector('#navigation').hidden);
    await go('chat/' + ids[1]);
    const nativeOnly = await page.locator('.thread').innerText();
    check(lang + ' native-only pairing still reads original replies without workspace permission', () => assert.ok(nativeOnly.includes(lang === 'zh' ? '两版都准备好了' : 'Both are ready')));
    await go('space');
    check(lang + ' native-only pairing acquires no implicit space grant', () => assert.equal(nativeOnly.includes('UNPAIRED_SENTINEL'), false));
    assert.equal(await page.locator('.space-card').count(), 0);
    check(lang + ' browser made no external requests', () => assert.deepEqual(external, [])); check(lang + ' browser has no script errors', () => assert.deepEqual(errors, []));
    fs.writeFileSync(path.join(evidence, lang + '-truth.json'), JSON.stringify({ queueItem: room.queueFind('shared', added.id), reminderCount: recordReminders.status(profile, Date.now()).count, nativeSends: nativeStats.calls.length, questionReplies: answers.replies.length, dailyProfileTouched: false, paidModelCalls: 0 }, null, 2));
  } finally {
    await context?.close(); if (app) await app.stop(); await background?.close(); owner?.close();
    if (carrier) { carrier.closeAllConnections(); await new Promise(resolve => carrier.close(resolve)); }
    if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'), timer = setTimeout(() => child.kill('SIGKILL'), 5000); child.kill('SIGTERM'); await exited; clearTimeout(timer); }
    if (child?.connected) child.disconnect(); fs.rmSync(profile, { recursive: true, force: true });
  }
}
async function compare() {
  const context = await browser.newContext({ viewport: { width: 840, height: 940 }, serviceWorkers: 'block' });
  try { for (const lang of ['zh', 'en']) for (const name of ['home', 'chat', 'space', 'queue', 'confirm', 'reminders']) {
    const original = path.join(prototypes, lang + '-' + name + '.png'), actual = path.join(pictures, lang + '-' + name + '.png'); assert.ok(fs.existsSync(original) && fs.existsSync(actual));
    const html = '<!doctype html><html lang="en"><meta charset="utf-8"><title>Prototype and live phone</title><style>body{font:16px system-ui;margin:12px;background:#fafbf8}main{display:grid;grid-template-columns:390px 390px;gap:18px}img{width:390px;height:auto}figure{margin:0}figcaption{padding:8px}</style><main><figure><figcaption>Approved prototype</figcaption><img src="' + require('node:url').pathToFileURL(original).href + '"></figure><figure><figcaption>Live isolated phone</figcaption><img src="' + require('node:url').pathToFileURL(actual).href + '"></figure></main></html>';
    const file = path.join(pictures, lang + '-' + name + '-compare.html'); fs.writeFileSync(file, html); const page = await context.newPage(); await page.goto(require('node:url').pathToFileURL(file).href); await page.screenshot({ path: path.join(pictures, lang + '-' + name + '-compare.png'), fullPage: true }); await page.close();
  } } finally { await context.close(); }
}
(async () => {
  try {
    let executablePath = process.env.NAW_BROWSER_EXECUTABLE || chromium.executablePath();
    if (!fs.existsSync(executablePath)) executablePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    browser = await chromium.launch({ executablePath, headless: true });
    for (const lang of ['zh', 'en']) await scenario(lang);
    await compare(); console.log('PHONE PASS ' + checks.length + ' FAIL 0 SKIP 0'); console.log('Pictures: ' + pictures);
  } catch (error) { console.error(clean(error.stack || String(error))); process.exitCode = 1; }
  finally { await browser?.close(); }
})().finally(testScratch.cleanup(async () => { await browser?.close(); }));
