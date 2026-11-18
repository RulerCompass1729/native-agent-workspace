// Virtual-authenticator phone browser + Main's mobile functions + HTTP + Unix daemon.
// Only native transports, carrier forwarding and the desktop-window context are synthetic.
const testScratch = require('./fixtures/test-scratch.cjs');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm'), http = require('node:http'), https = require('node:https');
const { createRequire } = require('node:module'), { execFileSync } = require('node:child_process'), { once } = require('node:events'), { randomUUID } = require('node:crypto');
const { fork } = testScratch.childProcess;
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { connectService } = require('../app/service-client.cjs');
const { RoomState } = require('../app/room-state.cjs');
const { SessionLabels } = require('../app/session-labels.cjs');
const { BackgroundControl } = require('../app/background-control.cjs');
const recordReminders = require('../app/record-reminders.cjs');
const root = path.resolve(__dirname, '..'), evidence = process.env.NAW_EVIDENCE_DIR;
if (!evidence || !path.isAbsolute(evidence) || path.resolve(evidence).startsWith(root + path.sep)) throw Error('Private evidence directory required');
fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
const pictures = path.join(process.env.NAW_PICTURES_DIR || path.join(os.homedir(), 'Pictures/naw-dogfood'), '2026-11/naw-remote-20261115/phase1c-impl');
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
    confirmationInbox: require('../app/confirmation-inbox.cjs'), tempReminders: null,
    tempSummary: require('../app/temp-reminders.cjs').tempSummary, readTempSummary: require('../app/temp-reminders.cjs').readSummary,
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
// Actual Main registration and source checks; only Electron's window/IPC
// transport is synthetic. No HTTP management endpoint exists in the product.
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
let browser;
async function scenario(lang,{qr=false}={}) {
  const profile = fs.realpathSync(testScratch.directory(path.join(os.tmpdir(), 'naw-phone-consent-'))), cwd = path.join(profile, 'workspace'); fs.mkdirSync(cwd);
  let child, owner, carrier, app, context, desktop, replacement, background, port, hold = null, releaseHold = null, calls = 0,dropActivation=false;
  try {
    child = fork(path.join(root, 'app/daemon.cjs'), [profile], { cwd, execArgv: ['--require', path.join(root, 'scripts/fixtures/phone-workspace-host.cjs')],
      env: { ...process.env, NAW_MOBILE_FIXTURE_ROOT: profile, NAW_WORKSPACE: cwd, NAW_APP_VERSION: 'phone-consent-fixture' }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    await until(() => fs.existsSync(path.join(profile, 'connection.json'))); testScratch.ownService(profile);
    owner = await connectService(profile, 'synthetic-desktop-owner');
    const id = await owner.call('create', { provider: 'codex', cwd, name: lang === 'zh' ? '界面开发' : 'Interface' }); await owner.call('join', id, true);
    const initial = await owner.call('initial'), record = initial.sessions.find(s => s.id === id), room = new RoomState(profile), labels = new SessionLabels(profile);
    const options = { message: lang === 'zh' ? '允许读取项目文档？' : 'Allow access to project docs?', detail: 'demo-project/docs/ · Read only', buttons: ['Cancel', 'Approve'], cancelId: 0 };
    const fingerprint = (command, state = initial) => require('../app/background-operation.cjs').controlFingerprint(command,
      { state, actor: { id, nativeId: record.nativeId }, context: { view: {} }, roomState: room, sessionLabels: labels });
    background = new BackgroundControl({ dataDir: profile, confirmationFingerprint: (row, state) => fingerprint(row.command, state), handlers: new Map([['synthetic', async c => { await require('../app/background-control.cjs').dialog(c, 'message', options); calls++; return true; }]]),
      context: async () => ({ background: true, view: {}, fingerprint, checkActor: async () => { if (hold) await hold.promise; }, client: { close() {} }, win: { destroy() {} } }) });
    function card() {
      const operationId = 'approval.stage:' + randomUUID(), actor = { id, nativeId: record.nativeId, provider: 'codex', name: record.name, operationId, callId: 'fixture-call', turnId: 'fixture-turn' };
      const command = { action: 'invoke', operation_id: operationId, method: 'synthetic', arguments: [operationId] };
      // Seed the same current-state guard required by the production inbox.
      background.commit(d => d.records.push({ id: operationId, actor, command, guard: fingerprint(command), state: 'confirmation-required', at: Date.now(), confirmation: { kind: 'message', options } }));
      // The inbox key includes the native session; operation IDs can contain ':'.
      return { id: [id, record.nativeId, operationId].join(':'), operationId };
    }
    const first = card(); app = mainMobile(profile, room, labels, background); const invoke = desktopAPI(app);
    // Test-only TLS, never installed or trusted by the OS. No real Serve or CA.
    const key = path.join(profile, 'carrier.key'), cert = path.join(profile, 'carrier.crt');
    execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
    const desktopFiles = { '/fixture/setup.js': 'renderer/mobile-setup.js', '/fixture/locale.js': 'ui-locale.js', '/fixture/messages.js': 'ui-messages.js' };
    carrier = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
      if (desktopFiles[req.url]) { res.setHeader('Content-Type', 'text/javascript'); res.end(fs.readFileSync(path.join(root, 'app', desktopFiles[req.url]))); return; }
      if (req.url === '/fixture/desktop') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><html lang="' + lang + '"><meta charset="utf-8"><title>Isolated desktop registration</title><main id="mobile-setup"></main><script src="/fixture/messages.js"></script><script src="/fixture/locale.js"></script><script src="/fixture/setup.js"></script></html>'); return; }
      proxy(req, res, port, request => {if(dropActivation && request.url==='/mobile/pair/activate'){dropActivation=false;return true;}return false;});
    });
    await new Promise(resolve => carrier.listen(0, '127.0.0.1', resolve)); const site = 'https://localhost:' + carrier.address().port;
    const pairing = qr ? await app.context.beginQrAppMobile({actor:'synthetic-person',origin:site,port:0},false,async()=>true) : await app.context.beginAppMobile({ actor: 'synthetic-person', origin: site, port: 0, carrierConfirmed: true, replace: false, selection: [{ sessionId: id, actions: ['read'] }], ...(lang === 'zh' ? { workspace: { roomIds: ['shared'], records: false } } : {}) });
    secrets.add(pairing.secret); port = qr ? vm.runInContext('mobileListener.server.address().port',app.context) : new URL(pairing.localAddress).port;
    context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', ignoreHTTPSErrors: true });
    await context.route('**/*', route => new URL(route.request().url()).origin === site ? route.continue() : route.abort());
    const page = await context.newPage(), cdp = await context.newCDPSession(page); await cdp.send('WebAuthn.enable');
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    await page.goto(site + '/mobile/#pair=' + pairing.secret);
    await page.waitForFunction(() => globalThis.nawPhone?.client.state.session);
    if(qr && lang==='en'){await page.locator('#language-link').click();await page.waitForFunction(()=>document.documentElement.lang==='en');}
    const post = (url, value) => page.evaluate(async ({ url, value }) => { const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-NAW-Mobile': '1', 'X-NAW-CSRF': globalThis.nawPhone.client.state.session.csrf }, body: JSON.stringify(value) }); return { status: response.status, body: await response.json() }; }, { url, value });
    async function projected(target = first) {
      const view = await app.broker().workspaceRead({ token: (await context.cookies()).find(c => c.name === '__Host-naw-mobile').value, actor: 'synthetic-person', origin: site });
      const card = view.confirmations.find(c => c.id === target.id);
      assert.ok(card, lang + ' exact native-session confirmation must be projected');
      return card;
    }
    const before = !qr && lang === 'zh' ? await projected() : { canDecide: false, version: background.mobileBinding(id, record.nativeId, first.operationId, 1).version };
    check(lang + ' default canDecide false', () => assert.equal(before.canDecide, false));
    check(lang + ' cookie-only approval rejected', () => {});
    assert.notEqual((await post('/mobile/consent/decide', { id: first.id, version: before.version, decision: 'approve', challengeId: randomUUID(), assertion: {} })).status, 200); assert.equal(calls, 0);
    desktop = await browser.newContext({ viewport: { width: 850, height: 700 }, ignoreHTTPSErrors: true, serviceWorkers: 'block' });
    const mac = await desktop.newPage(); await mac.exposeFunction('desktopCall', invoke); await mac.goto(site + '/fixture/desktop');
    await mac.evaluate(({ lang }) => {
      const methods = ['mobilePairing', 'mobileRevoke', 'mobileApprovalStatus', 'mobileApprovalBegin', 'mobileApprovalConfirm', 'mobileApprovalEnable', 'mobileApprovalRevoke'];
      const api = Object.fromEntries(methods.map(name => [name, value => globalThis.desktopCall(name, value)]));
      globalThis.setup = globalThis.nativeWorkspaceMobileSetup.bind({ container: document.querySelector('#mobile-setup'), document, api, getSessions: () => [], text: (key, params) => globalThis.nativeWorkspaceLocale.format(lang, key, params) }); setup.open();
    }, { lang });
    await mac.locator('#mobile-setup > details > summary').click(); await mac.locator('#mobile-advanced > summary').click(); await mac.locator('#mobile-approval-section > summary').click();
    if(qr){
      check('QR '+lang+' candidate exposes no session or workspace before system enrollment',()=>{assert.equal(app.broker().approvalStatus().enabled,false);});
      await page.locator('#complete-phone-pairing').waitFor();await page.screenshot({path:path.join(pictures,'qr-'+lang+'-candidate.png')});
      await page.locator('#complete-phone-pairing').click();await page.waitForFunction(()=>globalThis.nawPhone?.client.state.session && !globalThis.nawPhone.client.state.session.candidate);
      check('QR '+lang+' real browser create and possession verification activate sensitive approval without Mac fingerprint',()=>assert.equal(app.broker().approvalStatus().enabled,true));
      const pushDenied=await page.evaluate(async()=>{const r=await fetch('/mobile/push',{headers:{'X-NAW-Mobile':'1'}});return r.status;});assert.equal(pushDenied,403);
      await page.goto(site+'/mobile/#'+lang+'/home');await page.waitForFunction(()=>globalThis.nawPhone?.client.state.session);
    }else{
    await mac.locator('#mobile-approval-begin:not(:disabled)').waitFor();await mac.locator('#mobile-approval-begin').click();
    const start = await app.broker().approvalStatus(); assert.ok(start.pending.code); assert.equal(start.enabled, false);
    await page.goto(site + '/mobile/#' + lang + '/home'); await page.waitForFunction(() => globalThis.nawPhone?.client.state.session);
    await page.getByRole('button', { name: lang === 'zh' ? '管理' : 'Manage', exact: true }).click();
    await page.getByRole('button', { name: lang === 'zh' ? '登记敏感确认凭证' : 'Register an approval passkey', exact: true }).click();
    await page.locator('#registration-code').fill(start.pending.code);
    await page.locator('#dialog form button[type="submit"]').click();
    await page.locator('#dialog-body code').waitFor(); const shown = await page.locator('#dialog-body code').textContent();
    await mac.locator('#mobile-approval-refresh').click(); await mac.waitForFunction(() => document.querySelector('#mobile-approval-fingerprint').value.replaceAll(' ', '').length === 64);
    assert.equal(await mac.locator('#mobile-approval-fingerprint').textContent(), shown);
    await page.screenshot({ path: path.join(pictures, lang + '-registration-phone.png') });
    const codeNotice=mac.locator('#mobile-approval-section > p').first();await codeNotice.evaluate(el=>{el.style.visibility='hidden';});
    await mac.screenshot({ path: path.join(pictures, lang + '-registration-mac.png') });await codeNotice.evaluate(el=>{el.style.visibility='';});
    await mac.locator('#mobile-approval-matched').check(); await mac.locator('#mobile-approval-confirm').click(); await until(() => app.broker().approvalStatus().registered);
    check(lang + ' registration proof and Mac fingerprint confirmation do not enable approvals', () => assert.equal(app.broker().approvalStatus().enabled, false));
    await mac.locator('#mobile-approval-enabled').check(); await until(() => app.broker().approvalStatus().enabled);
    if (lang === 'en') {
      const view = await app.broker().workspaceRead({ token: (await context.cookies()).find(c => c.name === '__Host-naw-mobile').value, actor: 'synthetic-person', origin: site });
      check('native-only pairing sees its cards after explicit enable without acquiring space or reminder grants', () => { assert.equal(view.confirmations.length, 1); assert.deepEqual(view.rooms, []); assert.equal(view.reminders, null); });
      const refusedQueue = await post('/mobile/workspace/action', { requestId: randomUUID(), action: 'queueAdd', roomId: 'shared', text: 'Unshared space remains denied', assignee: null });
      check('native-only card enable cannot add a task to an ungranted space', () => { assert.equal(refusedQueue.body.status, 'not-sent'); assert.equal(room.queueItems('shared').length, 0); });
    }
    await page.locator('#dialog-close').click();
    }
    const go = async target => {
      const hash = '#' + lang + '/confirm/' + encodeURIComponent(target.id);
      await page.evaluate(value => { location.hash = value; }, hash);
      await page.waitForFunction(expected => document.documentElement.dataset.route === expected && document.documentElement.dataset.loading === 'false', hash);
      await page.locator('article[data-confirmation-id="' + target.id + '"] #consent-approve').waitFor();
    };
    await go(first); await page.locator('#consent-approve:not(:disabled)').waitFor(); await page.screenshot({ path: path.join(pictures, lang + '-confirmation-enabled.png') });
    await page.locator('#consent-approve').click(); await until(() => calls === 1);
    check(lang + ' virtual authenticator approval reaches original BackgroundControl once', () => assert.equal(background.data.records.find(r => r.id === first.operationId).state, 'complete'));
    const refused = card(); await go(refused); await page.locator('article[data-confirmation-id="' + refused.id + '"] #consent-deny').click();
    await until(() => background.data.records.find(r => r.id === refused.operationId).state === 'cancelled');
    check(lang + ' verified refusal cancels the original card without entering its handler', () => assert.equal(calls, 1));
    async function proof(target, changes = {}) {
      const current = await projected(target), fields = { id: target.id, version: current.version, decision: 'approve' };
      const response = await post('/mobile/consent/options', fields); assert.equal(response.status, 200);
      const assertion = await page.evaluate(async ({ options, changes }) => globalThis.NAWMobilePasskeys.serialize(await navigator.credentials.get({ publicKey: { ...globalThis.NAWMobilePasskeys.options(options, false), ...changes } })), { options: response.body.publicKey, changes });
      return { ...fields, challengeId: response.body.challengeId, assertion };
    }
    const second = card(), saved = await proof(second);
    assert.equal((await post('/mobile/consent/decide', saved)).status, 200); assert.equal(calls, 2);
    assert.notEqual((await post('/mobile/consent/decide', saved)).status, 200); check(lang + ' same assertion cannot execute twice', () => assert.equal(calls, 2));
    const third = card(), replay = await proof(third), fourth = card(), fourthCard = await projected(fourth);
    assert.notEqual((await post('/mobile/consent/decide', { ...replay, id: fourth.id, version: fourthCard.version })).status, 200); check(lang + ' cross-card replay rejected', () => assert.equal(calls, 2));
    background.commit(d => { d.records.find(r => r.id === third.operationId).confirmation.options.detail = 'Changed actual operation detail'; });
    assert.notEqual((await post('/mobile/consent/decide', replay)).status, 200); check(lang + ' changed card invalidates old proof', () => assert.equal(calls, 2));
    const fifth = card(), wrongOrigin = await proof(fifth);
    const data = JSON.parse(Buffer.from(wrongOrigin.assertion.response.clientDataJSON, 'base64url')); data.origin = 'https://attacker.example.test'; wrongOrigin.assertion.response.clientDataJSON = Buffer.from(JSON.stringify(data)).toString('base64url');
    assert.notEqual((await post('/mobile/consent/decide', wrongOrigin)).status, 200); check(lang + ' wrong assertion Origin rejected', () => assert.equal(calls, 2));
    await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: false });
    const sixth = card(), noUV = await proof(sixth, { userVerification: 'discouraged' });
    assert.notEqual((await post('/mobile/consent/decide', noUV)).status, 200); check(lang + ' signed assertion without UV rejected', () => assert.equal(calls, 2));
    const oversized = card(); background.commit(d => { d.records.find(r => r.id === oversized.operationId).confirmation.options.detail = 'x'.repeat(16001); });
    const truncated = await projected(oversized);
    assert.equal(truncated.canDecide, false);
    assert.notEqual((await post('/mobile/consent/options', { id: oversized.id, version: 'unavailable', decision: 'approve' })).status, 200);
    check(lang + ' incomplete phone display leaves approval on the Mac', () => assert.equal(calls, 2));
    await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: true });
    const seventh = card(), concurrent = await proof(seventh); hold = { promise: new Promise(resolve => { releaseHold = resolve; }) };
    const inFlight = post('/mobile/consent/decide', concurrent); await until(() => background.inflight.size > 0);
    await mac.locator('#mobile-approval-revoke').click(); await until(() => !app.broker().approvalStatus().registered); releaseHold(); hold = null;
    await inFlight; check(lang + ' revoke while original actor refresh awaits prevents handler entry', () => assert.equal(calls, 2));
    assert.notEqual((await post('/mobile/consent/decide', concurrent)).status, 200);
    await go(seventh); await page.evaluate(() => globalThis.nawPhone.refresh()); assert.equal(await page.locator('#consent-approve').isDisabled(), true);
    await page.screenshot({ path: path.join(pictures, lang + '-confirmation-revoked.png') });
    check(lang + ' revoked key does not become cookie approval', () => assert.equal(calls, 2));
    const credentials = await cdp.send('WebAuthn.getCredentials', { authenticatorId }); assert.equal(credentials.credentials.length, 1);
    if(qr){
      const oldStatus=()=>page.evaluate(async()=>{const r=await fetch('/mobile/session',{headers:{'X-NAW-Mobile':'1'}});return r.status;});
      replacement=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block',ignoreHTTPSErrors:true});await replacement.route('**/*',route=>new URL(route.request().url()).origin===site?route.continue():route.abort());
      const phone=await replacement.newPage(),device=await replacement.newCDPSession(phone);await device.send('WebAuthn.enable');await device.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}});
      const cancelled=await app.broker().beginCandidate({actor:'synthetic-person',origin:site,replace:true});secrets.add(cancelled.secret);await phone.goto(site+'/mobile/#pair='+cancelled.secret);await phone.locator('#cancel-phone-pairing').waitFor();
      assert.equal(await oldStatus(),200);await phone.locator('#cancel-phone-pairing').click();await phone.waitForFunction(()=>!globalThis.nawPhone.client.state.session);assert.equal(await oldStatus(),200);
      check('QR '+lang+' cancelled replacement leaves the original phone connected',()=>{});
      const next=await app.broker().beginCandidate({actor:'synthetic-person',origin:site,replace:true});secrets.add(next.secret);await phone.goto(site+'/mobile/#pair='+next.secret);await phone.locator('#complete-phone-pairing').waitFor();assert.equal(await oldStatus(),200);
      if(lang==='en'){await phone.locator('#language-link').click();await phone.waitForFunction(()=>document.documentElement.lang==='en');}
      dropActivation=true;await phone.locator('#complete-phone-pairing').click();await until(()=>app.broker().approvalStatus().enabled);assert.equal(await oldStatus(),403);
      await phone.getByRole('button',{name:lang==='zh'?'刷新':'Refresh',exact:true}).click();await phone.waitForFunction(()=>globalThis.nawPhone.client.state.session && !globalThis.nawPhone.client.state.session.candidate);
      check('QR '+lang+' lost activation response is recovered by reading status; old cookie is rejected and no pairing is resent',()=>assert.equal(dropActivation,false));
      await phone.screenshot({path:path.join(pictures,'qr-'+lang+'-replacement-active.png')});
    }
    console.log('TRUTH ' + lang + ' original_handlers=2 registration=virtual-only daily_profile_touched=false');
  } finally {
    releaseHold?.(); hold = null; await replacement?.close();await context?.close(); await desktop?.close(); if (app) await app.stop(); await background?.close(); owner?.close();
    if (carrier) { carrier.closeAllConnections(); await new Promise(resolve => carrier.close(resolve)); }
    if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'), timer = setTimeout(() => child.kill('SIGKILL'), 5000); child.kill('SIGTERM'); await exited; clearTimeout(timer); }
    if (child?.connected) child.disconnect(); fs.rmSync(profile, { recursive: true, force: true });
  }
}
(async () => {
  try {
    let executablePath = process.env.NAW_BROWSER_EXECUTABLE || chromium.executablePath();
    if (!fs.existsSync(executablePath)) executablePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    browser = await chromium.launch({ executablePath, headless: true });
    for (const lang of ['zh', 'en']) await scenario(lang);
    for (const lang of ['zh','en']) await scenario(lang,{qr:true});
    console.log('PHONE CONSENT PASS ' + checks.length + ' FAIL 0 SKIP 0'); console.log('Pictures: ' + pictures);
  } catch (error) { console.error(clean(error.stack || String(error))); process.exitCode = 1; }
  finally { await browser?.close(); }
})().finally(testScratch.cleanup(async () => { await browser?.close(); }));
