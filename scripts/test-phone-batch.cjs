// Phone merged confirmation card and composer countdown (2026-11-23, 「别忘了 NAW 的手机端」).
// Same harness as test-phone-consent.cjs: real phone page, Main's mobile functions, HTTP, Unix daemon and
// BackgroundControl; a virtual passkey. Only native transports, carrier forwarding and the desktop window are synthetic.
const testScratch = require('./fixtures/test-scratch.cjs');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm'), http = require('node:http'), https = require('node:https');
const { createRequire } = require('node:module'), { execFileSync } = require('node:child_process'), { once } = require('node:events'), { randomUUID } = require('node:crypto');
const { fork } = testScratch.childProcess;
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { connectService } = require('../app/service-client.cjs');
const { RoomState } = require('../app/room-state.cjs');
const { SessionLabels } = require('../app/session-labels.cjs');
const { BackgroundControl, dialog } = require('../app/background-control.cjs');
const recordReminders = require('../app/record-reminders.cjs');
const root = path.resolve(__dirname, '..'), evidence = process.env.NAW_EVIDENCE_DIR, pictures = process.env.NAW_PICTURES_DIR;
if (!evidence || !path.isAbsolute(evidence) || path.resolve(evidence).startsWith(root + path.sep)) throw Error('Private evidence directory required');
if (!pictures || !path.isAbsolute(pictures) || path.resolve(pictures).startsWith(root + path.sep)) throw Error('Picture directory outside the repository required');
fs.mkdirSync(evidence, { recursive: true, mode: 0o700 }); fs.mkdirSync(pictures, { recursive: true });
const checks = [], secrets = new Set();
const clean = s => { for (const value of secrets) s = s.replaceAll(value, '[redacted]'); return s; };
const check = (name, fn) => { fn(); checks.push(name); console.log('PASS ' + name); };
const pass = name => check(name, () => {});
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label = 'Isolated fixture did not become ready') { for (let n = 0; n < 250; n++) { if (await fn()) return; await wait(20); } throw Error(label); }
const mainSource = fs.readFileSync(path.join(root, 'app/main.cjs'), 'utf8');
function mainMobile(profile, roomState, labels, background) {
  const context = vm.createContext({ require: createRequire(path.join(root, 'app/main.cjs')), primary: true, quitting: false,
    dataDir: profile, roomState, sessionLabels: labels, recordReminders, operationsUnavailable: null, stewardRecord: null,
    confirmationInbox: require('../app/confirmation-inbox.cjs'), tempReminders: null,
    tempSummary: require('../app/temp-reminders.cjs').tempSummary, readTempSummary: require('../app/temp-reminders.cjs').readSummary,
    personActions: null, stewardWake: null, usageAlerts: null,
    backgroundControl: background, backgroundUnavailable: false, outboxQuitFailed: false, outboxUnavailable: false,
    activeManagers: () => ({}), integratorRole: null, stewardRole: null, butlerIngress: null,
    queueDispatcher: { integration: null, integrationError: null, rotationChains: () => [], schedule: () => {}, noteHuman: () => {} },
    submissionState: require('../app/submission-policy.cjs').submissionState,
    roomPeerIdentity: require('../app/peer-handoffs.cjs').identity,
    localVendorIcons: () => ({}), endedByMove: () => [], viewStorageWarning: null, viewStorageWarningUiMessage: null,
    displayText: (key, params) => require('../app/ui-locale.js').format('en', key, params),
    broadcastRoom: async () => {}, Date, setTimeout, clearTimeout, AbortController,
  });
  const a = mainSource.indexOf('function displayState('), b = mainSource.indexOf('function reportViewStorage(', a);
  const c = mainSource.indexOf('let mobileBroker;'), d = mainSource.indexOf('const startupFile =', c);
  const r = mainSource.indexOf('function recordPersonAction('), s = mainSource.indexOf('function observePersonActions(', r);
  assert.ok(a > 0 && b > a && c > 0 && d > c && r > 0 && s > r);
  vm.runInContext(mainSource.slice(r, s), context);
  vm.runInContext(mainSource.slice(a, b), context); vm.runInContext(mainSource.slice(c, d), context);
  return { context, broker: () => context.appMobileBroker(), stop: async () => { context.revokeAppMobile(); await vm.runInContext('mobileStopped', context); } };
}
function proxy(request, response, port) {
  const headers = { ...request.headers, 'tailscale-user-login': 'synthetic-person' };
  delete headers.connection;
  const outgoing = http.request({ hostname: '127.0.0.1', port, path: request.url, method: request.method, headers }, upstream => {
    const chunks = []; upstream.on('data', chunk => chunks.push(chunk)); upstream.on('end', () => {
      const returned = {};
      for (const [key, value] of Object.entries(upstream.headers)) if (!['connection', 'keep-alive', 'content-length', 'transfer-encoding'].includes(key) && value !== undefined) returned[key] = value;
      response.writeHead(upstream.statusCode, returned); response.end(Buffer.concat(chunks));
    });
  }); outgoing.on('error', () => { response.writeHead(502); response.end(); }); request.pipe(outgoing);
}
function desktopAPI(app) {
  const handlers = new Map(), frame = { url: 'https://desktop.invalid/' }, sender = { id: 7, mainFrame: frame };
  const c = app.context;
  c.applicationHandlers = new Map(); c.ipcMain = { handle: (name, fn) => handlers.set(name, fn) };
  c.windows = new Map([[7, { win: { webContents: { id: 7 }, isDestroyed: () => false }, view: {} }]]);
  c.trusted = value => value === frame.url; c.uiError = require('../app/ui-errors.cjs').uiError; c.uiLocale = require('../app/ui-locale.js');
  vm.runInContext(mainSource.slice(mainSource.indexOf('function register('), mainSource.indexOf('async function replaceBackendSockets(')), c);
  vm.runInContext(mainSource.slice(mainSource.indexOf('function isCurrentHumanContext('), mainSource.indexOf('function showDialog(')), c);
  const start = mainSource.indexOf("register('mobilePairing'");
  vm.runInContext(mainSource.slice(start, mainSource.indexOf("register('readingState'", start)), c);
  return async (name, value) => {
    const result = await handlers.get('workspace:' + name)({ sender, senderFrame: frame }, value);
    if (!result.ok) throw Error('Desktop fixture request refused'); return result.value;
  };
}
const words = {
  zh: { actor: '大管家（合成）', targets: ['测试 2', '开发 2', '调研 3'], single: '允许读取项目文档？', archive: name => '归档「' + name + '」？',
    detail: name => '对象：' + name + ' · 合成测试会话', title: '归档会话 · 3 项', all: '逐项确认（1/3）', next: k => '确认下一项（' + k + '/3）',
    stopTitle: '断开 Codex 会话 · 2 项', stopAsk: '断开这个 Codex 会话？', stopDetail: '合成示例：会请求中断当前回合。', stopAll: '逐项确认（1/2）', stopNext: '确认下一项（2/2）',
    chip: /^等你确认 · 剩余 \d+:\d\d$/, chipName: /^等你确认，剩余 (\d+ 分 )?\d+ 秒，跳到这条消息$/, moreName: '还有 1 个计时', manage: '管理', register: '登记敏感确认凭证',
    filler: '合成示例：这是一段较长的回复，用来把上面的确认卡推出可见区。' },
  en: { actor: 'Butler (synthetic)', targets: ['Test 2', 'Dev 2', 'Research 3'], single: 'Allow access to project docs?', archive: name => 'Archive ' + name + '?',
    detail: name => 'Target: ' + name + ' · synthetic session', title: 'Archive session · 3 items', all: 'Confirm one by one (1/3)', next: k => 'Confirm next (' + k + '/3)',
    stopTitle: 'Disconnect Codex session · 2 items', stopAsk: 'Disconnect this Codex session?', stopDetail: 'Synthetic example: requests interruption of the current turn.', stopAll: 'Confirm one by one (1/2)', stopNext: 'Confirm next (2/2)',
    chip: /^Waiting for confirmation · \d+:\d\d left$/, chipName: /^Waiting for confirmation, (\d+ min )?\d+ s left. Jump to this message$/, moreName: 'Other timers: 1', manage: 'Manage', register: 'Register an approval passkey',
    filler: 'Synthetic example: a longer reply that pushes the confirmation cards out of view.' },
};
let browser;
async function scenario(lang) {
  const w = words[lang];
  const profile = fs.realpathSync(testScratch.directory(path.join(os.tmpdir(), 'naw-phone-batch-'))), cwd = path.join(profile, 'workspace'); fs.mkdirSync(cwd);
  let child, owner, carrier, app, context, desktop, background, port, sequence = 0;
  const order = [], audited = [];
  const ipc = value => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { child.off('message', receive); reject(Error('Owned fixture timed out')); }, 5000);
    const receive = message => { if (message.phoneFixtureResult !== id) return; clearTimeout(timer); child.off('message', receive); message.ok ? resolve() : reject(Error('Seed refused')); };
    child.on('message', receive); child.send({ ...value, id });
  });
  try {
    child = fork(path.join(root, 'app/daemon.cjs'), [profile], { cwd, execArgv: ['--require', path.join(root, 'scripts/fixtures/phone-workspace-host.cjs')],
      env: { ...process.env, NAW_MOBILE_FIXTURE_ROOT: profile, NAW_WORKSPACE: cwd, NAW_APP_VERSION: 'phone-batch-fixture' }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    await until(() => fs.existsSync(path.join(profile, 'connection.json'))); testScratch.ownService(profile);
    owner = await connectService(profile, 'synthetic-desktop-owner');
    const id = await owner.call('create', { provider: 'codex', cwd, name: w.actor }); await owner.call('join', id, true);
    const targets = [];
    for (const name of w.targets) targets.push(await owner.call('create', { provider: 'codex', cwd, name }));
    const now = Date.now();
    // Filler after the cards, so the cards sit above the visible area at the bottom of the conversation.
    await ipc({ phoneFixture: 'seed', sessions: [{ id, messages: Array.from({ length: 14 }, (_, n) => ({ id: 'filler-' + n, role: 'assistant', text: w.filler, time: now - 80000 + n * 1000 })) }], sharedMessages: [] });
    await until(async () => (await owner.call('initial')).sessions.filter(s => [id, ...targets].includes(s.id)).every(s => s.nativeId && s.state === 'idle'), 'Synthetic sessions idle');
    const initial = await owner.call('initial'), record = initial.sessions.find(s => s.id === id), room = new RoomState(profile), labels = new SessionLabels(profile);
    const fingerprint = (command, state = initial) => require('../app/background-operation.cjs').controlFingerprint(command,
      { state, actor: { id, nativeId: record.nativeId }, context: { view: {} }, roomState: room, sessionLabels: labels });
    const optionsFor = target => target === 'single' ? { message: w.single, detail: 'demo-project/docs/ · Read only', buttons: ['Cancel', 'Approve'], cancelId: 0 }
      : target === 'stop' ? { message: w.stopAsk, detail: w.stopDetail, buttons: ['Keep', 'Disconnect'], cancelId: 0 }
      : { message: w.archive(w.targets[targets.indexOf(target)]), detail: w.detail(w.targets[targets.indexOf(target)]), buttons: ['Cancel', 'Archive'], cancelId: 0 };
    background = new BackgroundControl({ dataDir: profile, confirmationFingerprint: (row, state) => fingerprint(row.command, state), handlers: new Map([
      ['archiveSession', async (_c, target) => { order.push(target); return true; }],
      ['stop', async (c, target) => { if ((await dialog(c, 'message', optionsFor('stop'))).response === 1) order.push('stop:' + target); return true; }],
      ['synthetic', async c => { await dialog(c, 'message', optionsFor('single')); order.push('single'); return true; }]]),
      // Archive is a maintenance action: BackgroundControl asks its card itself and writes each step to the
      // maintenance space. Main supplies both; this records the events instead of writing a space.
      confirmation: (_actor, args) => optionsFor(args.arguments[0]),
      audit: async record => { audited.push({ id: record.id, state: record.state }); },
      context: async () => ({ background: true, view: {}, fingerprint, checkActor: async () => {}, client: { close() {} }, win: { destroy() {} } }) });
    function card(method, target, at) {
      const operationId = 'approval.stage:' + randomUUID(), actor = { id, nativeId: record.nativeId, provider: 'codex', name: record.name, operationId, callId: 'fixture-call', turnId: 'fixture-turn' };
      const command = { action: 'invoke', operation_id: operationId, method, arguments: [method === 'synthetic' ? operationId : target] };
      // Stored as production stores it (controlGuard clones), so a later commit cannot change its shape.
      background.commit(d => d.records.push({ id: operationId, actor, command, guard: JSON.parse(JSON.stringify(fingerprint(command))), state: 'confirmation-required', at, confirmation: { kind: 'message', options: optionsFor(method === 'synthetic' ? 'single' : method === 'stop' ? 'stop' : target) } }));
      return { id: [id, record.nativeId, operationId].join(':'), operationId, target };
    }
    // One single card that expires first, then three archive cards from the same sender, ten seconds apart.
    const single = card('synthetic', null, now - 150000);
    const batch = targets.map((target, n) => card('archiveSession', target, now - 120000 + n * 10000));
    app = mainMobile(profile, room, labels, background); const invoke = desktopAPI(app);
    const key = path.join(profile, 'carrier.key'), cert = path.join(profile, 'carrier.crt');
    execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
    const desktopFiles = { '/fixture/setup.js': 'renderer/mobile-setup.js', '/fixture/locale.js': 'ui-locale.js', '/fixture/messages.js': 'ui-messages.js' };
    carrier = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
      if (desktopFiles[req.url]) { res.setHeader('Content-Type', 'text/javascript'); res.end(fs.readFileSync(path.join(root, 'app', desktopFiles[req.url]))); return; }
      if (req.url === '/fixture/desktop') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><html lang="' + lang + '"><meta charset="utf-8"><title>Isolated desktop registration</title><main id="mobile-setup"></main><script src="/fixture/messages.js"></script><script src="/fixture/locale.js"></script><script src="/fixture/setup.js"></script></html>'); return; }
      proxy(req, res, port);
    });
    await new Promise(resolve => carrier.listen(0, '127.0.0.1', resolve)); const site = 'https://localhost:' + carrier.address().port;
    const pairing = await app.context.beginAppMobile({ actor: 'synthetic-person', origin: site, port: 0, carrierConfirmed: true, replace: false, selection: [{ sessionId: id, actions: ['read'] }] });
    secrets.add(pairing.secret); port = new URL(pairing.localAddress).port;
    context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', ignoreHTTPSErrors: true });
    await context.route('**/*', route => new URL(route.request().url()).origin === site ? route.continue() : route.abort());
    const page = await context.newPage(), cdp = await context.newCDPSession(page); await cdp.send('WebAuthn.enable');
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    await page.goto(site + '/mobile/#pair=' + pairing.secret);
    await page.waitForFunction(() => globalThis.nawPhone?.client.state.session);
    // Registration exactly as test-phone-consent.cjs: code on the Mac, fingerprint compared on both screens.
    desktop = await browser.newContext({ viewport: { width: 850, height: 700 }, ignoreHTTPSErrors: true, serviceWorkers: 'block' });
    const mac = await desktop.newPage(); await mac.exposeFunction('desktopCall', invoke); await mac.goto(site + '/fixture/desktop');
    await mac.evaluate(({ lang }) => {
      const methods = ['mobilePairing', 'mobileRevoke', 'mobileApprovalStatus', 'mobileApprovalBegin', 'mobileApprovalConfirm', 'mobileApprovalEnable', 'mobileApprovalRevoke'];
      const api = Object.fromEntries(methods.map(name => [name, value => globalThis.desktopCall(name, value)]));
      globalThis.setup = globalThis.nativeWorkspaceMobileSetup.bind({ container: document.querySelector('#mobile-setup'), document, api, getSessions: () => [], text: (key, params) => globalThis.nativeWorkspaceLocale.format(lang, key, params) }); setup.open();
    }, { lang });
    await mac.locator('#mobile-setup > details > summary').click(); await mac.locator('#mobile-advanced > summary').click(); await mac.locator('#mobile-approval-section > summary').click();
    await mac.locator('#mobile-approval-begin:not(:disabled)').waitFor(); await mac.locator('#mobile-approval-begin').click();
    const start = await app.broker().approvalStatus();
    await page.goto(site + '/mobile/#' + lang + '/home'); await page.waitForFunction(() => globalThis.nawPhone?.client.state.session);
    await page.getByRole('button', { name: w.manage, exact: true }).click();
    await page.getByRole('button', { name: w.register, exact: true }).click();
    await page.locator('#registration-code').fill(start.pending.code);
    await page.locator('#dialog form button[type="submit"]').click();
    await page.locator('#dialog-body code').waitFor(); const shown = await page.locator('#dialog-body code').textContent();
    await mac.locator('#mobile-approval-refresh').click(); await mac.waitForFunction(() => document.querySelector('#mobile-approval-fingerprint').value.replaceAll(' ', '').length === 64);
    assert.equal(await mac.locator('#mobile-approval-fingerprint').textContent(), shown);
    await mac.locator('#mobile-approval-matched').check(); await mac.locator('#mobile-approval-confirm').click(); await until(() => app.broker().approvalStatus().registered);
    await mac.locator('#mobile-approval-enabled').check(); await until(() => app.broker().approvalStatus().enabled);
    await page.locator('#dialog-close').click();
    const go = async hash => {
      await page.evaluate(value => { location.hash = value; }, hash);
      await page.waitForFunction(expected => document.documentElement.dataset.route === expected && document.documentElement.dataset.loading === 'false', hash);
    };
    const signs = async () => (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials[0].signCount;
    const state = operationId => background.data.records.find(r => r.id === operationId).state;
    const shot = name => page.screenshot({ path: path.join(pictures, 'phone-' + lang + '-' + name + '.png') });

    // Conversation: one bubble for the three archive cards, its own bubble for the single card, and the chip.
    const chat = '#' + lang + '/chat/' + encodeURIComponent(id);
    await go(chat); await page.locator('#phone-timers:not([hidden]) .phone-timer').waitFor();
    const bubbles = await page.locator('#content article[data-confirmation-id]').evaluateAll(list => list.map(a => ({ id: a.dataset.confirmationId, batch: Boolean(a.querySelector('a[href*="confirm/batch/"]')), text: a.textContent })));
    check(lang + ' thread draws the three archive cards as one bubble, on the newest card', () => {
      assert.equal(bubbles.length, 2, JSON.stringify(bubbles));
      assert.deepEqual(bubbles.filter(b => b.batch).map(b => b.id), [batch.at(-1).id]);
      assert.match(bubbles.find(b => b.batch).text, new RegExp(w.title.replace(/[()]/g, '\\$&')));
    });
    await page.evaluate(() => { document.scrollingElement.scrollTop = document.scrollingElement.scrollHeight; }); await wait(150);
    const visible = target => page.locator('#content article[data-confirmation-id="' + target + '"]').evaluate(a => { const r = a.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; });
    const chip = page.locator('#phone-timers .phone-timer'), more = page.locator('#phone-timers .phone-timer-more');
    const firstText = await chip.textContent(), firstName = await chip.getAttribute('aria-label');
    await chip.evaluate(el => { el.dataset.sameNode = 'yes'; });
    await shot('chip');
    await wait(1100);
    assert.match(firstText, w.chip); assert.match(firstName, w.chipName);
    assert.notEqual(await chip.textContent(), firstText); assert.equal(await chip.getAttribute('data-same-node'), 'yes');
    assert.equal(await more.textContent(), '+1'); assert.equal(await more.getAttribute('aria-label'), w.moreName);
    pass(lang + ' chip shows the soonest countdown and +1; its text changes each second without rebuilding the node');
    const live = await page.locator('#phone-timers[aria-live], #phone-timers [aria-live]').count();
    check(lang + ' chip has no live region', () => assert.equal(live, 0));
    assert.equal(await visible(single.id), false, 'The single card starts out of view');
    await chip.focus(); await page.keyboard.press('Enter'); await wait(500);
    const flashed = await page.locator('#content article[data-confirmation-id="' + single.id + '"]').evaluate(a => a.classList.contains('flash'));
    check(lang + ' Enter on the chip scrolls the soonest card into view and highlights it', () => assert.equal(flashed, true));
    assert.equal(await visible(single.id), true);
    await shot('chip-jumped');
    await page.evaluate(() => { document.scrollingElement.scrollTop = document.scrollingElement.scrollHeight; }); await wait(150);
    await more.click(); await page.locator('#dialog .phone-timer-list button').first().waitFor();
    const others = await page.locator('#dialog .phone-timer-list button').allTextContents();
    await shot('chip-more');
    check(lang + ' +1 lists the other timer with its batch title', () => { assert.equal(others.length, 1); assert.ok(others[0].includes(w.title), others[0]); });
    await page.locator('#dialog .phone-timer-list button').first().click(); await wait(500);
    assert.equal(await page.locator('#dialog').evaluate(d => d.open), false);
    assert.equal(await visible(batch.at(-1).id), true);
    assert.equal(await page.locator('#content article[data-confirmation-id="' + batch.at(-1).id + '"]').evaluate(a => a.classList.contains('flash')), true);
    pass(lang + ' a listed timer jumps to its card');

    // The merged card: confirm list entry, rows that open to the single card's facts, one verification per tap.
    await go('#' + lang + '/confirm');
    const entries = await page.locator('#content .link-row').allTextContents();
    check(lang + ' confirm list shows one entry for the batch and one for the single card', () => assert.deepEqual(entries.filter(e => e.includes(w.title)).length, 1, JSON.stringify(entries)));
    await page.locator('#content .link-row', { hasText: w.title }).click();
    await page.locator('#consent-batch').waitFor();
    const rows = page.locator('.batch-rows > li');
    assert.equal(await rows.count(), 3);
    assert.deepEqual(await page.locator('.batch-rows details').evaluateAll(list => list.map(d => d.open)), [false, false, false]);
    assert.deepEqual(await page.locator('.batch-rows .batch-target').allTextContents(), w.targets);
    assert.equal(await page.locator('#consent-batch').textContent(), w.all);
    pass(lang + ' batch page has one row per card, all closed, each naming its target');
    const before = await signs();
    await rows.nth(1).locator('summary').click();
    await rows.nth(2).locator('summary').focus(); await page.keyboard.press('Enter');
    const expanded = await page.locator('.batch-rows details').evaluateAll(list => list.map(d => d.open));
    const rowFacts = await rows.nth(1).locator('dl.facts').textContent();
    const tree = await cdp.send('Accessibility.getFullAXTree');
    const summaries = tree.nodes.filter(n => n.role?.value === 'DisclosureTriangle').map(n => ({ name: n.name?.value, expanded: n.properties?.find(p => p.name === 'expanded')?.value.value }));
    check(lang + ' rows open by click and by Enter; each summary is a named disclosure with its expanded state', () => {
      assert.deepEqual(expanded, [false, true, true]);
      assert.equal(summaries.length, 3, JSON.stringify(summaries));
      assert.deepEqual(summaries.map(s => s.expanded), [false, true, true]);
      for (const [n, s] of summaries.entries()) assert.ok(s.name.includes(w.targets[n]), JSON.stringify(s));
    });
    assert.deepEqual(order, []); assert.equal(await signs(), before);
    pass(lang + ' opening rows confirms nothing');
    for (const c of [single, ...batch]) assert.equal(state(c.operationId), 'confirmation-required');
    await shot('batch-light');
    await page.emulateMedia({ colorScheme: 'dark' }); await wait(100); await shot('batch-dark'); await page.emulateMedia({ colorScheme: 'light' });
    const batchHash = await page.evaluate(() => location.hash);
    await go('#' + lang + '/confirm/' + encodeURIComponent(batch[1].id));
    const singleFacts = await page.locator('article[data-confirmation-id="' + batch[1].id + '"] dl.facts').textContent();
    check(lang + ' an opened row shows the same facts as that card\'s own page', () => { assert.equal(rowFacts, singleFacts); assert.ok(rowFacts.includes(w.detail(w.targets[1]))); });
    await go(batchHash); await page.locator('#consent-batch').waitFor();
    for (let k = 1; k <= 3; k++) {
      const label = k === 1 ? w.all : w.next(k);
      await page.locator('#consent-batch:not(:disabled)', { hasText: label }).waitFor();
      const signed = await signs();
      await page.locator('#consent-batch').click();
      try { await until(() => order.length === k, 'Card ' + k + ' carried out'); }
      catch (error) {
        const r = background.data.records.find(x => x.id === batch[k - 1].operationId);
        console.error('After tap ' + k + ': ' + JSON.stringify({ state: r.state, reason: r.reason, error: r.error, refusal: r.confirmationRefusal, disposition: r.disposition, signs: await signs() - signed, toast: await page.locator('#toast').textContent().catch(() => null) }));
        throw error;
      }
      await until(async () => k === 3 ? await page.locator('#consent-batch').count() === 0 : (await page.locator('#consent-batch').textContent()) === w.next(k + 1), 'Page shows the next step');
      assert.equal(await signs(), signed + 1);
      assert.deepEqual(order, targets.slice(0, k));
      for (const [n, c] of batch.entries()) assert.equal(state(c.operationId), n < k ? 'complete' : 'confirmation-required');
      pass(lang + ' tap ' + k + ' signs once and carries out card ' + k + ' only');
      if (k === 2) await shot('batch-next');
    }
    const finished = batch.map(c => background.data.records.find(r => r.id === c.operationId));
    const rowStates = await page.locator('.batch-rows .batch-state').allTextContents();
    await shot('batch-done');
    check(lang + ' each card has its own completion receipt, in order; the single card is untouched', () => {
      assert.ok(finished.every(r => r.state === 'complete' && Number.isSafeInteger(r.finishedAt)));
      assert.ok(finished[0].finishedAt <= finished[1].finishedAt && finished[1].finishedAt <= finished[2].finishedAt);
      assert.equal(new Set(rowStates).size, 1, JSON.stringify(rowStates)); assert.equal(rowStates.length, 3);
      assert.equal(state(single.operationId), 'confirmation-required');
      assert.deepEqual(audited, batch.flatMap(c => [{ id: c.operationId, state: 'running' }, { id: c.operationId, state: 'complete' }]));
    });
    await go(chat); await page.locator('#phone-timers:not([hidden]) .phone-timer').waitFor();
    assert.equal(await page.locator('#phone-timers .phone-timer-more').count(), 0);
    pass(lang + ' after the batch is done, the chip keeps only the single card and drops +N');
    // Two stop cards: one batch whose page says once, before any row is opened, what stopping interrupts.
    const stops = targets.slice(0, 2).map((target, n) => card('stop', target, now - 60000 + n * 10000));
    await go('#' + lang + '/confirm'); await page.reload(); await page.waitForFunction(() => globalThis.nawPhone?.client.state.session);
    await page.locator('#content .link-row', { hasText: w.stopTitle }).click(); await page.locator('#consent-batch:not(:disabled)', { hasText: w.stopAll }).waitFor();
    const closed = await page.locator('.batch-rows details').evaluateAll(list => list.map(d => d.open));
    // Every line between the deadline and the rows: after the first answer it must not turn into that card's target.
    const saidNow = () => page.locator('.batch-detail > p.quiet').evaluateAll(list => list.slice(1).map(p => p.textContent)), said = await saidNow();
    await shot('stop-batch');
    check(lang + ' stop batch says once what stopping interrupts, with its rows closed', () => { assert.deepEqual(closed, [false, false]); assert.deepEqual(said, [w.stopDetail]); });
    const stopSigned = await signs();
    await page.locator('#consent-batch').click(); await until(() => order.includes('stop:' + targets[0]), 'First stop carried out');
    await page.locator('#consent-batch:not(:disabled)', { hasText: w.stopNext }).waitFor();
    assert.equal(await signs(), stopSigned + 1); assert.deepEqual(await saidNow(), [w.stopDetail]);
    assert.deepEqual(order.slice(3), ['stop:' + targets[0]]); assert.deepEqual(stops.map(c => state(c.operationId)), ['complete', 'confirmation-required']);
    pass(lang + ' a tap on the stop batch signs once and carries out the first stop only');
    console.log('TRUTH ' + lang + ' order=' + order.map(t => targets.indexOf(t)).join(',') + ' signs=' + (await signs() - before) + ' row_states=' + JSON.stringify(rowStates) + ' daily_profile_touched=false');
  } finally {
    await context?.close(); await desktop?.close(); if (app) await app.stop(); await background?.close(); owner?.close();
    if (carrier) { carrier.closeAllConnections(); await new Promise(resolve => carrier.close(resolve)); }
    if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'), timer = setTimeout(() => child.kill('SIGKILL'), 5000); child.kill('SIGTERM'); await exited; clearTimeout(timer); }
    if (child?.connected) child.disconnect(); fs.rmSync(profile, { recursive: true, force: true });
  }
}
(async () => {
  try {
    const executablePath = process.env.NAW_BROWSER_EXECUTABLE;
    if (!executablePath || !fs.existsSync(executablePath)) throw Error('Set NAW_BROWSER_EXECUTABLE to an isolated headless browser');
    browser = await chromium.launch({ executablePath, headless: true });
    console.log('BROWSER ' + browser.version());
    for (const lang of ['zh', 'en']) await scenario(lang);
    console.log('PHONE BATCH PASS ' + checks.length + ' FAIL 0 SKIP 0'); console.log('Pictures: ' + pictures);
  } catch (error) { console.error(clean(error.stack || String(error))); process.exitCode = 1; }
  finally { await browser?.close(); }
})().finally(testScratch.cleanup(async () => { await browser?.close(); }));
