// The person, 2026-11-23: after a power cut the phone stayed disconnected until someone clicked on the Mac.
// Actual phone browser + Main's mobile functions + HTTP listener + pairing store + carrier checks + Unix daemon.
// Synthetic: the Tailscale status, the carrier proxy and the Keychain (a file in the owned profile; the real helper
// never runs). Each NAW instance is its own process, as a restart is: a pairing is only resumed once its issuer is gone.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm'), http = require('node:http'), https = require('node:https'), net = require('node:net');
const { createRequire } = require('node:module'), { execFileSync } = require('node:child_process'), { once } = require('node:events');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const host = 'demo.example.ts.net', actor = 'synthetic-person', origin = 'https://' + host + ':10000';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, ms = 10000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await wait(50); } throw Error('Isolated fixture did not become ready'); }

// One NAW instance: Main's mobile slice with the Keychain and Tailscale reads replaced, driven over IPC.
function instance(profile, port) {
  const carrier = require('../app/mobile-carrier.cjs'), pairingStore = require('../app/mobile-pairing-store.cjs');
  const { RoomState } = require('../app/room-state.cjs'), { SessionLabels } = require('../app/session-labels.cjs'), { BackgroundControl } = require('../app/background-control.cjs');
  const file = path.join(profile, 'synthetic-keychain.json');
  const all = () => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const keychain = { get: account => all()[account] ?? null, put: (account, value) => fs.writeFileSync(file, JSON.stringify({ ...all(), [account]: value }), { mode: 0o600 }) };
  const serve = { TCP: { 10000: { HTTPS: true } }, Web: { [host + ':10000']: { Handlers: { '/': { Proxy: 'http://127.0.0.1:' + port } } } }, AllowFunnel: {} };
  const tailscale = { status: { BackendState: 'Running', Self: { DNSName: host + '.', UserID: 7, Online: true }, User: { 7: { LoginName: actor } } }, serve };
  const load = createRequire(path.join(root, 'app/main.cjs'));
  const context = vm.createContext({
    require: name => {
      if (name === './mobile-pairing-store.cjs') return { ...pairingStore, keychainAdapter: () => keychain };
      if (name === './mobile-carrier.cjs') return { ...carrier, detect: async options => carrier.inspect(tailscale.status, tailscale.serve, options),
        detectRestored: async expected => carrier.inspectRestored(tailscale.status, tailscale.serve, expected) };
      return load(name);
    },
    primary: true, quitting: false, fs, path,
    dataDir: profile, roomState: new RoomState(profile), sessionLabels: new SessionLabels(profile), recordReminders: require('../app/record-reminders.cjs'), operationsUnavailable: null, stewardRecord: null,
    confirmationInbox: require('../app/confirmation-inbox.cjs'), tempReminders: null,
    tempSummary: require('../app/temp-reminders.cjs').tempSummary, readTempSummary: require('../app/temp-reminders.cjs').readSummary,
    personActions: null, stewardWake: null, usageAlerts: null,
    backgroundControl: new BackgroundControl({ dataDir: profile, handlers: new Map(), context: async () => { throw Error('Sensitive execution is unavailable in the phone fixture'); } }),
    backgroundUnavailable: false, outboxQuitFailed: false, outboxUnavailable: false,
    activeManagers: () => ({}), integratorRole: null, stewardRole: { current: () => null }, butlerIngress: null,
    queueDispatcher: { integration: null, integrationError: null, rotationChains: () => [], schedule: () => {}, noteHuman: () => {} },
    submissionState: require('../app/submission-policy.cjs').submissionState,
    roomPeerIdentity: require('../app/peer-handoffs.cjs').identity,
    localVendorIcons: () => ({}), endedByMove: () => [], viewStorageWarning: null, viewStorageWarningUiMessage: null,
    displayText: (key, params) => require('../app/ui-locale.js').format('en', key, params),
    broadcastRoom: async () => {}, Date, setTimeout, clearTimeout, AbortController, console: { warn: line => console.log('main ' + process.pid + ': ' + line) },
  });
  const source = fs.readFileSync(path.join(root, 'app/main.cjs'), 'utf8');
  const a = source.indexOf('function displayState('), b = source.indexOf('function reportViewStorage(', a);
  const c = source.indexOf('let mobileBroker;'), d = source.indexOf('const startupFile =', c);
  const r = source.indexOf('function recordPersonAction('), s = source.indexOf('function observePersonActions(', r);
  assert.ok(a > 0 && b > a && c > 0 && d > c && r > 0 && s > r);
  vm.runInContext(source.slice(r, s), context); vm.runInContext(source.slice(a, b), context); vm.runInContext(source.slice(c, d), context);
  const value = name => vm.runInContext(name, context);
  const commands = {
    begin: options => context.beginAppMobile(options).then(challenge => ({ secret: challenge.secret })),
    boot: () => context.resumeAppMobileOnBoot(),
    tailscale: state => { tailscale.status.BackendState = state; },
    state: () => ({ listening: Boolean(value('mobileListener')?.ready), status: context.appMobileApprovalStatus() }),
    // Main's quit path: stop live authorization, then seal the recovery mirror.
    quit: async () => { context.suspendAppMobile(); await value('mobileBroker').settlePersistence(true); context.quitting = true; await value('mobileStopped'); },
  };
  process.on('message', async ({ id, command, argument }) => {
    // A quit ends the process, as the power cut does, so the next instance finds the issuer gone.
    const done = command === 'quit' ? () => process.exit(0) : undefined;
    try { process.send({ id, ok: true, result: await commands[command](argument) }, done); }
    catch (error) { process.send({ id, ok: false, error: String(error?.message || error) }, done); }
  });
  process.send({ ready: true });
}

async function main() {
  const { fork } = testScratch.childProcess;
  const playwright = require('playwright'), { connectService } = require('../app/service-client.cjs');
  const evidence = process.env.NAW_EVIDENCE_DIR;
  if (!evidence || !path.isAbsolute(evidence) || path.resolve(evidence).startsWith(root + path.sep)) throw Error('Private evidence directory required');
  const engine = process.env.NAW_PHONE_ENGINE === 'webkit' ? 'webkit' : 'chromium';
  const executablePath = engine === 'webkit' ? process.env.NAW_WEBKIT_EXECUTABLE : process.env.NAW_BROWSER_EXECUTABLE;
  // Without an isolated headless browser Playwright could open the person's own browser.
  if (!executablePath || !fs.existsSync(executablePath)) throw Error('Isolated headless browser executable required');
  const pictures = path.join(evidence, 'phone-boot-resume-' + engine); fs.mkdirSync(pictures, { recursive: true, mode: 0o700 });
  const checks = [], check = (name, fn) => { fn(); checks.push(name); console.log('PASS ' + name); };
  const profile = fs.realpathSync(testScratch.directory(path.join(os.tmpdir(), 'naw-phone-boot-'))), cwd = path.join(profile, 'workspace'); fs.mkdirSync(cwd);
  let daemon, owner, proxyServer, tunnel, browser, sequence = 0;
  const tunnelSockets = new Set();
  const children = [];
  const ask = (child, message, key = 'id') => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { child.off('message', receive); reject(Error('Owned fixture timed out')); }, 15000);
    const receive = value => { if (value[key] !== id) return; clearTimeout(timer); child.off('message', receive); value.ok === false ? reject(Error(value.error || 'Fixture refused')) : resolve(value.result ?? value); };
    child.on('message', receive); child.send({ ...message, id });
  });
  const start = async port => {
    const child = fork(__filename, ['--main-instance', profile, String(port)], { cwd, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    children.push(child); await new Promise((resolve, reject) => { child.once('message', resolve); child.once('exit', () => reject(Error('Instance exited early'))); });
    return { pid: child.pid, call: (command, argument) => ask(child, { command, argument }), exited: () => child.exitCode !== null || child.signalCode !== null, child };
  };
  try {
    daemon = fork(path.join(root, 'app/daemon.cjs'), [profile], { cwd, execArgv: ['--require', path.join(root, 'scripts/fixtures/phone-workspace-host.cjs')],
      env: { ...process.env, NAW_MOBILE_FIXTURE_ROOT: profile, NAW_WORKSPACE: cwd, NAW_APP_VERSION: 'phone-boot-fixture' }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    await until(() => fs.existsSync(path.join(profile, 'connection.json')));
    testScratch.ownService(profile);
    owner = await connectService(profile, 'synthetic-desktop-owner');
    const ids = [await owner.call('create', { provider: 'claude', cwd, name: '文档整理' }), await owner.call('create', { provider: 'codex', cwd, name: '界面开发' })];
    const port = await new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

    // The carrier: TLS on the tailnet name, forwarding to the local listener with the login header, 502 while nothing listens.
    const key = path.join(profile, 'carrier.key'), cert = path.join(profile, 'carrier.crt');
    execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=' + host], { stdio: 'ignore' });
    proxyServer = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (request, response) => {
      const headers = { ...request.headers, 'tailscale-user-login': actor }; delete headers.connection;
      const outgoing = http.request({ hostname: '127.0.0.1', port, path: request.url, method: request.method, headers }, upstream => {
        const returned = {};
        for (const [name, value] of Object.entries(upstream.headers)) if (!['connection', 'keep-alive', 'transfer-encoding'].includes(name) && value !== undefined) returned[name] = value;
        response.writeHead(upstream.statusCode, returned); upstream.pipe(response);
      });
      outgoing.on('error', () => { response.writeHead(502); response.end(); }); request.pipe(outgoing);
    });
    await new Promise(resolve => proxyServer.listen(0, '127.0.0.1', resolve));
    // The browser reaches the tailnet name through this local tunnel only; every other destination is refused.
    tunnel = http.createServer((req, res) => { res.writeHead(403); res.end(); });
    tunnel.on('connect', (req, socket) => {
      tunnelSockets.add(socket); socket.on('close', () => tunnelSockets.delete(socket));
      if (req.url !== host + ':10000') { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
      const upstream = net.connect(proxyServer.address().port, '127.0.0.1', () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); upstream.pipe(socket); socket.pipe(upstream); });
      upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy());
    });
    await new Promise(resolve => tunnel.listen(0, '127.0.0.1', resolve));

    // 1. Pair through the real carrier check, so the pairing keeps the binding automatic resume compares.
    const first = await start(port);
    const challenge = await first.call('begin', { actor, origin, port, carrierConfirmed: true, replace: false, sharedHostConfirmed: false,
      selection: ids.map(id => ({ sessionId: id, actions: ['read', 'send', 'answer'] })) });
    browser = await playwright[engine].launch({ executablePath, headless: true, proxy: { server: 'http://127.0.0.1:' + tunnel.address().port } });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, ...(engine === 'webkit' ? {} : { isMobile: true }), hasTouch: true, serviceWorkers: 'block', ignoreHTTPSErrors: true, locale: 'zh-CN' });
    const external = [], errors = [];
    await context.route('**/*', async route => { if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); } else await route.continue(); });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/mobile/#pair=' + challenge.secret);
    await page.waitForFunction(() => globalThis.nawPhone?.client.state.session && !document.querySelector('#navigation').hidden, null, { timeout: 15000 });
    await page.evaluate(async () => { location.hash = '#zh/home'; await globalThis.nawPhone.refresh(); });
    await page.waitForFunction(() => document.querySelectorAll('a.row').length === 2, null, { timeout: 15000 });
    const paired = (await first.call('state')).status;
    // Whether the saved pairing kept its carrier binding shows at boot: without it the reason is 'unbound', not 'not-ready'.
    check('pairing is persistent: a Keychain mirror and the authority file exist', () => {
      assert.equal(paired.paired, true); assert.equal(paired.temporaryPairing, undefined);
      assert.ok(Object.keys(JSON.parse(fs.readFileSync(path.join(profile, 'synthetic-keychain.json'), 'utf8'))).length >= 1);
      assert.ok(fs.existsSync(path.join(profile, 'mobile-authority.json')));
    });
    await page.screenshot({ path: path.join(pictures, '01-paired.png') });

    // 2. Power cut: NAW quits through its quit path and exits; the next boot finds Tailscale still starting.
    await first.call('quit'); await until(() => first.exited());
    const second = await start(port);
    check('the restarted NAW is another process', () => assert.notEqual(second.pid, first.pid));
    await second.call('tailscale', 'Starting');
    const bootAt = Date.now();
    await second.call('boot');
    const booting = await second.call('state');
    check('boot while Tailscale starts: no listener yet, the desktop says why and that it reconnects by itself', () => {
      assert.equal(booting.listening, false); assert.equal(booting.status.resumeRequired, true); assert.equal(booting.status.resumeReason, 'not-ready');
    });
    await page.evaluate(() => globalThis.nawPhone.refresh().catch(() => {}));
    await page.waitForFunction(() => document.body.innerText.includes('自动重连'), null, { timeout: 15000 });
    const waiting = await page.evaluate(() => ({ session: Boolean(globalThis.nawPhone.client.state.session), rows: document.querySelectorAll('a.row').length }));
    check('the phone, meanwhile, keeps its pairing and page and says it reconnects automatically', () => { assert.equal(waiting.session, true); assert.equal(waiting.rows, 2); });
    await page.screenshot({ path: path.join(pictures, '02-waiting-for-carrier.png') });

    // 3. Tailscale becomes ready a few seconds later; nobody touches the Mac.
    await wait(2000); await second.call('tailscale', 'Running');
    await until(async () => (await second.call('state')).listening, 15000);
    const resumedMs = Date.now() - bootAt;
    check('the listener comes back by itself at the first backoff step', () => assert.ok(resumedMs >= 4500 && resumedMs < 9000, String(resumedMs)));
    const after = (await second.call('state')).status;
    check('desktop status after the automatic resume carries no reason', () => { assert.equal(after.paired, true); assert.equal(after.resumeReason, undefined); assert.equal(after.resumeRequired, undefined); });
    const log = fs.readFileSync(path.join(profile, 'mobile-persistence.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).map(e => e.phase + ' ' + e.category);
    check('the persistence log records the wait and the automatic resume', () => { assert.ok(log.includes('boot not-ready'), log.join(',')); assert.ok(log.includes('boot-retry ok'), log.join(',')); });
    const reconnectAt = Date.now();
    await page.waitForFunction(() => document.querySelectorAll('a.row').length === 2 && !document.body.innerText.includes('自动重连'), null, { timeout: 40000 });
    const phoneMs = Date.now() - reconnectAt;
    check('the phone reconnects on its own with the same pairing, no new scan', () => assert.ok(phoneMs < 40000));
    await page.screenshot({ path: path.join(pictures, '03-reconnected.png') });

    // 4. A card on the phone after the outage: a synthetic native question, answered once, with its receipt.
    await ask(daemon, { brokerFixture: 'question', sessionId: ids[0] }, 'brokerFixtureResult');
    await page.evaluate(id => { location.hash = '#zh/confirm/native/' + id; }, ids[0]);
    await page.locator('.native-question').waitFor({ timeout: 15000 });
    await page.screenshot({ path: path.join(pictures, '04-card.png') });
    await page.locator('.native-question input[value="Original fixture answer"]').check();
    await page.locator('.native-question button[type="submit"]').click();
    await page.waitForFunction(() => globalThis.nawPhone.client.state.pending.some(p => p.action === 'answer' && p.status === 'reply-written'), null, { timeout: 15000 });
    const answers = await ask(daemon, { brokerFixture: 'stats' }, 'brokerFixtureResult');
    check('the card is answered exactly once and its receipt says the reply was written', () => assert.equal(answers.replies.length, 1));
    await page.screenshot({ path: path.join(pictures, '05-receipt.png') });
    check('the phone made no external requests and had no script errors', () => { assert.deepEqual(external, []); assert.deepEqual(errors, []); });
    console.log('PHONE BOOT RESUME ' + engine + ' PASS ' + checks.length + ' FAIL 0 SKIP 0 listenerMs=' + resumedMs + ' phoneMs=' + phoneMs);
  } finally {
    await browser?.close().catch(() => {});
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
    owner?.close?.();
    // CONNECT sockets leave the server's books once upgraded; WebKit leaves them half closed.
    for (const socket of tunnelSockets) socket.destroy();
    for (const server of [tunnel, proxyServer]) if (server) { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
    if (daemon && daemon.exitCode === null && daemon.signalCode === null) { const exited = once(daemon, 'exit'); daemon.kill('SIGTERM'); await exited; }
  }
}
let testScratch;
if (process.argv[2] === '--main-instance') instance(process.argv[3], Number(process.argv[4]));
else {
  testScratch = require('./fixtures/test-scratch.cjs');
  main().finally(testScratch.cleanup(async () => {}));
}
