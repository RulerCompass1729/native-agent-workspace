#!/usr/bin/env node
// Browser acceptance, real app-local HTTP/RPC, synthetic native boundaries only.
const evidenceEnv = process.env.NAW_EVIDENCE_DIR; delete process.env.NAW_EVIDENCE_DIR; delete process.env.GIT_ASKPASS;
const scratch = require('./fixtures/test-scratch.cjs');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), https = require('node:https'), http = require('node:http');
const { createRequire } = require('node:module'), { execFileSync } = require('node:child_process'), { once } = require('node:events'), { randomUUID } = require('node:crypto');
const { mainMobile } = require('./fixtures/phone-acceptance-instance.cjs');
const browsers = require('playwright');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, ms = 90000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await wait(25); } throw Error('acceptance-timeout'); }
const THRESHOLDS = { backMs: 500, visibleSendMs: 1500, rttMs: 80, bytesPerSecond: 256 * 1024 };
function assertCheckpointChanged(previous, current, visibleChange) {
  if (visibleChange && previous?.equals(current)) throw Object.assign(Error('Claimed visual transition has an identical screenshot'), { code: 'HARNESS_DUPLICATE_CHECKPOINT' });
}
function receiptAssociations(rows, originals) {
  const matches = originals.map(cues => rows.flatMap((text, index) => cues.every(cue => text.includes(cue)) ? [index] : []));
  return { pass: originals.length > 1 && matches.every(m => m.length === 1) && new Set(matches.flat()).size === originals.length,
    expected: originals.length, identified: matches.filter(m => m.length === 1).length };
}
function messageVisibility(element) {
  const doc = element.ownerDocument, view = doc.defaultView, r = element.getBoundingClientRect(), v = view.visualViewport;
  const left = v?.offsetLeft || 0, top = v?.offsetTop || 0, width = v?.width || view.innerWidth, height = v?.height || view.innerHeight;
  const inViewport = element.isConnected && r.width > 0 && r.height > 0 && r.left >= left && r.top >= top && r.right <= left + width && r.bottom <= top + height;
  let painted = true;
  for (let current = element; current; current = current.parentElement) {
    const style = view.getComputedStyle(current);
    if (style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility) || Number(style.opacity) === 0) painted = false;
  }
  const unobscured = inViewport && [0.2, 0.5, 0.8].every(x => [0.2, 0.5, 0.8].every(y => {
    const hit = doc.elementFromPoint(r.left + r.width * x, r.top + r.height * y);
    return hit === element || element.contains(hit);
  }));
  return { visible: Boolean(inViewport && painted && unobscured), inViewport, unobscured, viewport: { width, height },
    bounds: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } };
}
let activeCleanup = async () => {};
const ownedRoots = []; let reportDirectory;
const temporary = prefix => { const root = scratch.directory(prefix); ownedRoots.push(root); process.send?.({ kind: 'phone-acceptance-owned-root', root }); return root; };
function messages(profile, index) {
  const rows = [], now = Date.now();
  for (const d of profile.distribution) for (let n = 0; n < d.count; n++) {
    rows.push({ id: rows.length.toString(36), role: d.role, ...(d.kind !== 'other' ? { kind: d.kind } : {}),
      text: ('Synthetic ' + d.role + ' ' + rows.length + ' ').padEnd(d.length, 's').slice(0, d.length) });
  }
  // Known original human/assistant markers make the visual oracle independent of the projection.
  rows.push({ id: 'latest-human-' + index, role: 'user', text: 'SYNTHETIC_LATEST_QUESTION_' + index, time: now - 2 },
    { id: 'latest-reply-' + index, role: 'assistant', text: 'SYNTHETIC_LATEST_REPLY_' + index, time: now - 1 });
  return rows;
}
function defaultShape() {
  return { sessions: Array.from({ length: 120 }, () => ({ messages: 309, distribution: [
    { role: 'tool', kind: 'tool', length: 800, count: 176 }, { role: 'assistant', kind: 'text', length: 8000, count: 46 },
    { role: 'user', kind: 'text', length: 160, count: 45 }, { role: 'system', kind: 'text', length: 400, count: 42 }] })), rooms: 3, queues: [6, 8, 2] };
}
function validateShape(shape) {
  const integer = (n, max) => Number.isSafeInteger(n) && n >= 0 && n <= max;
  const roles = ['user', 'human', 'assistant', 'tool', 'system', 'other'];
  const kinds = [...roles, 'text', 'tool_call', 'tool_result'];
  if (!shape || Object.keys(shape).some(k => !['version', 'sessions', 'rooms', 'queues'].includes(k)) ||
      !Array.isArray(shape.sessions) || shape.sessions.length < 5 || shape.sessions.length > 256 || !integer(shape.rooms, 32) ||
      !Array.isArray(shape.queues) || shape.queues.length > 32 || shape.queues.some(n => !integer(n, 10000))) throw Error('Invalid metadata-only shape');
  let rows = 0, characters = 0;
  for (const s of shape.sessions) {
    if (Object.keys(s).sort().join(',') !== 'distribution,messages' || !integer(s.messages, 250000) || !Array.isArray(s.distribution)) throw Error('Invalid session shape');
    let count = 0;
    for (const d of s.distribution) {
      if (Object.keys(d).sort().join(',') !== 'count,kind,length,role' || !roles.includes(d.role) || !kinds.includes(d.kind) || !integer(d.length, 16 * 1024 * 1024) || !integer(d.count, 250000)) throw Error('Invalid distribution');
      count += d.count; characters += d.count * d.length;
    }
    if (count !== s.messages) throw Error('Shape count mismatch'); rows += count;
  }
  if (rows > 250000 || characters > 96 * 1024 * 1024) throw Error('Shape exceeds bounded trial; never silently truncate it');
  return shape;
}
function executable(engine) {
  const override = process.env[engine === 'webkit' ? 'NAW_WEBKIT_EXECUTABLE' : 'NAW_CHROMIUM_EXECUTABLE'] || process.env.NAW_BROWSER_EXECUTABLE;
  if (override) return override;
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  return engine === 'webkit' ? path.join(cache, 'webkit-2336/pw_run.sh') : path.join(cache, 'chromium_headless_shell-1254/chrome-headless-shell-mac-arm64/chrome-headless-shell');
}
async function scenario(root, engine, language, shape, output, cases, probe) {
  const selected = name => !cases || cases.includes(name) || cases.includes('receipts') && ['busy', 'steer', 'reminders'].includes(name);
  const profile = fs.realpathSync(temporary(path.join(os.tmpdir(), 'naw-phone-acceptance-'))), cwd = path.join(profile, 'workspace'); fs.mkdirSync(cwd);
  const load = createRequire(path.join(root, 'package.json'));
  const results = [], requests = [], errors = [], contexts = [], active = new Set(), pendingReads = []; let sequence = 0, child, owner, carrier, app, browser, background, localPort, heldRead, stopping, externalRequests = 0;
  const releaseRead = () => { for (const release of pendingReads.splice(0)) release(); };
  const stop = () => stopping ||= (async () => {
    heldRead = null; releaseRead?.(); const failures = [];
    for (const close of [async () => { for (const c of contexts) await c.close(); }, () => browser?.close(), () => app?.stop(), () => background?.close(), () => owner?.close(),
      async () => { for (const u of active) u.destroy(); if (carrier) { carrier.closeAllConnections(); await new Promise(resolve => carrier.close(resolve)); } },
      async () => {
        if (child && child.exitCode === null && child.signalCode === null) {
          const exited = once(child, 'exit'), timer = setTimeout(() => child.kill('SIGKILL'), 10000);
          try { child.kill('SIGTERM'); await exited; } finally { clearTimeout(timer); }
        }
        if (child?.connected) child.disconnect();
      }]) { try { await close(); } catch { failures.push('cleanup-unconfirmed'); } }
    if (failures.length) throw Error('cleanup-unconfirmed');
  })();
  activeCleanup = stop;
  const shots = path.join(output, engine + '-' + language); fs.mkdirSync(shots, { recursive: true });
  let page, previousFrame;
  const checkpoints = [], originals = [];
  const snapshot = async (name, { subject = page, visibleChange = true } = {}) => {
    await subject.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const screenshot = String(checkpoints.length + 1).padStart(2, '0') + '.png';
    const bytes = await subject.screenshot({ path: path.join(shots, screenshot) });
    checkpoints.push({ name, screenshot, visibleChange, page: await subject.evaluate(() => document.documentElement.dataset.page || 'unpaired') });
    fs.writeFileSync(path.join(shots, 'checkpoints.json'), JSON.stringify(checkpoints, null, 2));
    assertCheckpointChanged(previousFrame, bytes, visibleChange); previousFrame = bytes;
    return screenshot;
  };
  const check = async (name, pass, actual = null, frame = false) => {
    results.push({ name, pass: Boolean(pass), actual, ...(frame ? { screenshot: await snapshot(name, frame === true ? {} : frame) } : {}) });
    fs.appendFileSync(path.join(shots, 'steps.jsonl'), JSON.stringify(results.at(-1)) + '\n');
    console.log(JSON.stringify({ engine, language, ...results.at(-1) }));
  };
  const ipc = (phoneAcceptance, extra = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { child.off('message', receive); reject(Error('fixture-timeout')); }, 30000);
    function receive(value) { if (value.phoneAcceptanceResult !== id) return; clearTimeout(timer); child.off('message', receive); value.ok ? resolve(value) : reject(Error('fixture-refused')); }
    child.on('message', receive); child.send({ phoneAcceptance, sequence: id, ...extra });
  });
  try {
    const env = { PATH: path.dirname(process.execPath) + ':/usr/bin:/bin:/usr/sbin:/sbin', HOME: path.join(profile, 'home'), TMPDIR: process.env.TMPDIR || os.tmpdir(),
      NAW_PHONE_TARGET: root, NAW_MOBILE_FIXTURE_ROOT: profile, NAW_WORKSPACE: cwd, NAW_APP_VERSION: 'phone-acceptance-synthetic', LANG: 'en_US.UTF-8' };
    fs.mkdirSync(env.HOME);
    child = scratch.childProcess.fork(path.join(root, 'app/daemon.cjs'), [profile], { cwd, env,
      execArgv: ['--require', path.join(__dirname, 'fixtures/phone-acceptance-host.cjs')], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    await until(() => fs.existsSync(path.join(profile, 'connection.json')), 15000); scratch.ownService(profile);
    owner = await load('./app/service-client.cjs').connectService(profile, 'synthetic-phone-desktop');
    const ids = [];
    for (let i = 0; i < shape.sessions.length; i++) ids.push(await owner.call('create', { provider: i === 2 ? 'codex' : 'claude', view: 'chat', cwd, name: 'Synthetic ' + i }));
    // Batch IPC, never private/native conversation data.
    for (let i = 0; i < ids.length; i += 5) await ipc('seed', { final: i + 5 >= ids.length, sessions: ids.slice(i, i + 5).map((id, n) => ({ id, state: i + n === 1 || i + n === 2 ? 'working' : 'idle', messages: messages(shape.sessions[i + n], i + n) })) });
    const initial = await owner.call('initial'), record = initial.sessions.find(s => s.id === ids[4]);
    const room = new (load('./app/room-state.cjs').RoomState)(profile), labels = new (load('./app/session-labels.cjs').SessionLabels)(profile);
    const roomIds = ['shared']; room.rename('Synthetic space 0', 'shared');
    for (let i = 1; i < Math.max(1, shape.rooms, shape.queues.length); i++) roomIds.push(room.create('Synthetic space ' + i));
    for (let i = 0; i < roomIds.length; i++) for (let n = 0; n < (shape.queues[i] || 0); n++) room.queueAdd('Synthetic task ' + n, null, roomIds[i]);
    await owner.call('join', ids[1], true);
    const options = { message: 'Synthetic harmless approval', detail: 'Synthetic metadata only', buttons: ['Cancel', 'Approve'], cancelId: 0 };
    const fingerprint = (command, state = initial) => load('./app/background-operation.cjs').controlFingerprint(command,
      { state, actor: { id: ids[4], nativeId: record.nativeId }, context: { view: {} }, roomState: room, sessionLabels: labels });
    let executions = 0;
    background = new (load('./app/background-control.cjs').BackgroundControl)({ dataDir: profile, confirmationFingerprint: row => fingerprint(row.command),
      handlers: new Map([['synthetic', async c => { await load('./app/background-control.cjs').dialog(c, 'message', options); executions++; return true; }]]),
      context: async () => ({ background: true, view: {}, fingerprint, checkActor: async () => {}, client: { close() {} }, win: { destroy() {} } }) });
    function card(at = Date.now()) {
      const operationId = 'approval.stage:' + randomUUID(), command = { action: 'invoke', operation_id: operationId, method: 'synthetic', arguments: [operationId] };
      background.commit(d => d.records.push({ id: operationId, command, guard: fingerprint(command), at, state: 'confirmation-required',
        actor: { id: ids[4], nativeId: record.nativeId, provider: 'claude', name: 'Synthetic 4', operationId, callId: 'synthetic-call', turnId: 'synthetic-turn' }, confirmation: { kind: 'message', options } }));
      return [ids[4], record.nativeId, operationId].join(':');
    }
    const cards = [card(), card()], expiredCard = card(Date.now() - 601000);
    const old = Date.now() - 33 * 86400000;
    new (load('./app/record-history.cjs').BlockLog)(profile, 'operations', () => {}).append([{ time: old, value: { synthetic: true } }], old);
    app = mainMobile(root, profile, room, labels, background, { sessionId: ids[0], nativeId: initial.sessions.find(s => s.id === ids[0]).nativeId });
    const key = path.join(profile, 'tls.key'), cert = path.join(profile, 'tls.crt');
    execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
    carrier = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, async (req, res) => {
      const started = performance.now(), route = req.url;
      await wait(THRESHOLDS.rttMs / 2);
      const upstream = http.request({ hostname: '127.0.0.1', port: localPort, path: req.url, method: req.method,
        headers: { ...req.headers, 'tailscale-user-login': 'synthetic-person' } }, response => {
        const chunks = []; response.on('data', b => chunks.push(b)); response.on('end', async () => {
          const data = Buffer.concat(chunks);
          if (heldRead && route === '/mobile/read/' + heldRead) await new Promise(resolve => pendingReads.push(resolve));
          await wait(THRESHOLDS.rttMs / 2);
          const headers = { ...response.headers }; delete headers['transfer-encoding']; delete headers.connection; delete headers['keep-alive'];
          if (res.destroyed) return;
          res.writeHead(response.statusCode, headers);
          for (let offset = 0; offset < data.length && !res.destroyed; offset += 8192) { res.write(data.subarray(offset, offset + 8192)); await wait(8192 / THRESHOLDS.bytesPerSecond * 1000); }
          res.end(); requests.push({ route: route.split('/').slice(0, 3).join('/'), method: req.method, bytes: data.length, ms: Math.round(performance.now() - started), status: response.statusCode });
        });
      });
      active.add(upstream); upstream.on('close', () => active.delete(upstream)); upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); }); req.pipe(upstream);
    });
    await new Promise(resolve => carrier.listen(0, '127.0.0.1', resolve)); const site = 'https://localhost:' + carrier.address().port;
    const pairing = await app.context.beginQrAppMobile({ actor: 'synthetic-person', origin: site, port: 0 }, false, async () => true);
    localPort = require('node:vm').runInContext('mobileListener.server.address().port', app.context);
    browser = await browsers[engine].launch({ headless: true, executablePath: executable(engine) });
    let context = await browser.newContext({ ...browsers.devices['iPhone 13'], viewport: { width: 390, height: 844 }, deviceScaleFactor: 3,
      locale: language === 'zh' ? 'zh-CN' : 'en-US', ignoreHTTPSErrors: true, serviceWorkers: 'block' }); contexts.push(context);
    await context.route('**/*', route => { if (new URL(route.request().url()).origin === site) return route.continue(); externalRequests++; return route.abort(); });
    await context.addInitScript(() => {
      if (typeof CredentialsContainer === 'undefined') return;
      const original = CredentialsContainer.prototype.get;
      CredentialsContainer.prototype.get = async function (...args) {
        globalThis.phoneAcceptanceVerificationPending = true;
        try {
          if (globalThis.phoneAcceptanceHoldVerification) await new Promise(resolve => { globalThis.phoneAcceptanceReleaseVerification = resolve; });
          return await Reflect.apply(original, this, args);
        }
        finally { globalThis.phoneAcceptanceVerificationPending = false; }
      };
    });
    page = await context.newPage(); page.on('pageerror', () => errors.push('page-error'));
    const uv = { registrations: 0, assertions: 0 };
    if (engine === 'chromium') {
      const cdp = await context.newCDPSession(page); await cdp.send('WebAuthn.enable');
      await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
      cdp.on('WebAuthn.credentialAdded', () => uv.registrations++); cdp.on('WebAuthn.credentialAsserted', () => uv.assertions++);
    }
    await page.goto(site + '/mobile/'); await page.locator('#pair-code').waitFor();
    const denied = await context.request.get(site + '/mobile/session', { headers: { 'X-NAW-Mobile': '1' } });
    await check('unpaired-denied', denied.status() !== 200 && await page.locator('a.row').count() === 0, null, true);
    await page.goto(site + '/mobile/#pair=' + pairing.secret); await page.locator('#complete-phone-pairing').waitFor();
    await check('candidate-cannot-read', await page.locator('a.row').count() === 0, null, true);
    await page.locator(engine === 'chromium' ? '#complete-phone-pairing' : '#basic-phone-pairing').tap();
    await page.waitForFunction(() => nawPhone.client.state.session && !nawPhone.client.state.session.candidate && document.querySelectorAll('a.row').length > 3, null, { timeout: 120000 });
    await until(() => page.evaluate(() => document.documentElement.dataset.loading === 'false'));
    const go = async destination => {
      const hash = '#' + language + '/' + destination, [routePage, id] = destination.split('/');
      await page.evaluate(hash => { location.hash = hash; }, hash);
      await page.waitForFunction(({ hash, routePage, id }) => document.documentElement.dataset.route === hash && document.documentElement.dataset.page === routePage && document.documentElement.dataset.loading === 'false' &&
        (routePage !== 'chat' || nawPhone.client.state.selected === id && nawPhone.client.state.row?.id === id && document.querySelector('.thread')), { hash, routePage, id }, { timeout: 120000 });
    };
    const unobscured = async destination => {
      await go('home'); await go(destination);
      await page.locator('#toast').waitFor({ state: 'hidden' });
    };
    await go('home'); await check('home-count-matches-service', await page.locator('a.row').count() === ids.length, { expected: ids.length, actual: await page.locator('a.row').count() }, true);
    if (process.argv.includes('--duplicate-checkpoint-fault')) await snapshot('deliberately-unchanged-home');
    await check('unsupported-create-controls-absent', await page.locator('.section-title button').count() === 0);
    if (engine === 'chromium') await check('pairing-uv-count', uv.registrations === 1 && uv.assertions === 1, { ...uv, simulated: true });
    if (probe) await probe({ page, context, ids, ipc, check, go, snapshot, app });
    if (selected('read')) {
      await go('chat/' + ids[0]);
      const original = await page.locator('.thread').innerText(), latest = await page.locator('.bubble').filter({ hasText: 'SYNTHETIC_LATEST_REPLY_0' }).last().evaluate(e => { const b = e.getBoundingClientRect(); return b.top < innerHeight && b.bottom > 0; }).catch(() => false);
      await check('a-latest-reply-readable-at-entry', latest && original.includes('SYNTHETIC_LATEST_QUESTION_0'), { latestVisible: latest, placeholders: await page.locator('.thread .small-note').count(), bubbles: await page.locator('.thread .bubble').count() }, true);
      const visible = await page.locator('.thread .bubble').evaluateAll(rows => rows.filter(r => { const b = r.getBoundingClientRect(); return b.bottom > 0 && b.top < innerHeight - 180; }).slice(0, 5).map(r => ({ omitted: Boolean(r.querySelector('.small-note')), blank: ![...r.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim() })));
      await check('a-visible-replies-not-placeholder-flood', visible.length > 0 && visible.every(r => !r.omitted && !r.blank), { visible });
    }
    if (selected('send')) {
      await go('chat/' + ids[0]);
      await page.locator('#message').fill('SYNTHETIC_PHONE_SEND'); await snapshot('send-input-before-submit');
      const sendAt = performance.now(); await page.locator('#send-message').tap();
      await until(async () => (await ipc('truth')).calls.some(c => c.text === 'SYNTHETIC_PHONE_SEND'));
      const nativeMs = Math.round(performance.now() - sendAt);
      const sent = page.locator('.thread .bubble').filter({ hasText: 'SYNTHETIC_PHONE_SEND' });
      await until(async () => await sent.count() === 1 && await sent.innerText() === 'SYNTHETIC_PHONE_SEND');
      const domMs = Math.round(performance.now() - sendAt);
      let visibility = await sent.evaluate(messageVisibility);
      while (!visibility.visible && performance.now() - sendAt < THRESHOLDS.visibleSendMs) { await wait(25); visibility = await sent.evaluate(messageVisibility); }
      const visibleMs = visibility.visible ? Math.round(performance.now() - sendAt) : null;
      originals.push(['SYNTHETIC_PHONE_SEND']);
      await check('b-send-visible-within-budget', visibility.visible && visibleMs <= THRESHOLDS.visibleSendMs,
        { nativeMs, domMs, visibleMs, budgetMs: THRESHOLDS.visibleSendMs, visibility }, true);
      await unobscured('chat/' + ids[0]); await snapshot('send-result-without-overlay');
    }
    await ipc('state', { sessionId: ids[0], state: 'idle' });
    if (selected('navigation')) {
      await go('home'); heldRead = ids[0]; await page.locator('a.butler-entry').tap(); await until(() => pendingReads.length > 0);
      await page.locator('#message').fill('SYNTHETIC_UNSENT_DRAFT'); await snapshot('chat-before-return-with-read-stalled');
      const backAt = performance.now(); await page.locator('#top a[href="#' + language + '/home"]').tap();
      await page.waitForFunction(() => document.documentElement.dataset.page === 'home', null, { timeout: 2000 });
      const backMs = Math.round(performance.now() - backAt); heldRead = null; releaseRead();
      await check('c-back-before-stalled-read', backMs <= THRESHOLDS.backMs, { backMs, budgetMs: THRESHOLDS.backMs }, true);
    }
    if (selected('busy') || selected('steer')) {
      await ipc('state', { sessionId: ids[3], state: 'working' }); await ipc('capabilities', { sessionId: ids[3], values: { queueAvailable: false } });
      for (const index of [1, 2, 3].filter(i => i === 2 ? selected('steer') : selected('busy'))) {
        await go('chat/' + ids[index]); await page.locator('#message').fill('SYNTHETIC_BUSY_' + index);
        const state = await page.evaluate(() => ({ enabled: !document.querySelector('#send-message').disabled, mode: nawPhone.client.state.row?.sendMode, blocked: nawPhone.client.state.row?.sendBlocked }));
        await snapshot('busy-' + index + '-input-before-submit');
        if (state.enabled) await page.locator('#send-message').tap();
        if (state.enabled) await until(() => page.evaluate(() => !nawPhone.client.state.busy));
        if (state.enabled) { originals.push(['SYNTHETIC_BUSY_' + index]); await snapshot('busy-' + index + '-submission-feedback'); }
        const truth = await ipc('truth'), calls = truth.calls.filter(c => c.text === 'SYNTHETIC_BUSY_' + index);
      if (index === 2) await check('codex-steer-once-to-original-turn', state.enabled && state.mode === 'steer' && calls.length === 1 && calls[0].type === 'steer' && calls[0].turnId === 'synthetic-turn' && truth.states.find(s => s.id === ids[2])?.nativeId === initial.sessions.find(s => s.id === ids[2]).nativeId, { mode: state.mode, calls: calls.map(c => ({ type: c.type, turnId: c.turnId })) });
      if (index !== 2) {
        const reserved = truth.requests.filter(r => r.sessionId === ids[index] && r.action === 'send' && ['prepared', 'awaiting-native', 'submitted'].includes(r.status));
        if (calls.length === 0) await ipc('state', { sessionId: ids[index], state: 'idle' });
        await ipc('drain', { sessionId: ids[index] });
        if (state.enabled) await until(async () => (await ipc('truth')).calls.some(c => c.text === 'SYNTHETIC_BUSY_' + index), 5000);
        const delivered = (await ipc('truth')).calls.filter(c => c.text === 'SYNTHETIC_BUSY_' + index);
        await check('d-busy-' + (index === 3 ? 'legacy-claude' : 'claude') + '-queues-once', state.enabled && state.mode?.startsWith('queue') && reserved.length === 1 && delivered.length === 1 && !delivered.some(c => c.type === 'steer'), { ...state, reserved: reserved.length, nativeCalls: delivered.map(c => c.type), serviceState: truth.states.find(s => s.id === ids[index])?.state });
      }
      if (state.enabled) {
        const receipt = page.locator('.receipt').getByRole('button', { name: language === 'zh' ? '查看这条消息的状态' : "Check this message's status", exact: true });
        await until(async () => await receipt.count() > 0 || await page.evaluate(id => nawPhone.client.state.pending.filter(p => p.sessionId === id).every(p => ['submitted', 'not-sent', 'reply-written'].includes(p.status)), ids[index]));
        if (await receipt.count() > 1) throw Error('ambiguous-original-receipt');
        if (await receipt.count() === 1) await receipt.tap();
        await until(() => page.evaluate(id => nawPhone.client.state.pending.filter(p => p.sessionId === id).every(p => ['submitted', 'not-sent', 'reply-written'].includes(p.status)), ids[index]));
        await unobscured('chat/' + ids[index]); await snapshot('busy-' + index + '-receipt-without-overlay');
      }
      }
    }
    if (selected('workspace')) {
      await go('space/shared'); await check('space-route', await page.locator('#room-members').count() === 1, null, true);
      await go('queue/shared'); const count = room.queueItems('shared').length;
      await page.locator('#content > button.primary').tap(); await page.locator('#new-task-text').fill('SYNTHETIC_QUEUE_TASK'); await page.locator('#dialog form button[type="submit"]').tap();
      await until(() => room.queueItems('shared').length === count + 1); originals.push(['SYNTHETIC_QUEUE_TASK']);
      await check('queue-write-matches-desktop', room.queueItems('shared').at(-1).text === 'SYNTHETIC_QUEUE_TASK', null, true);
    }
    if (selected('consent')) {
      for (let i = 0; i < cards.length; i++) {
        await go('confirm/' + encodeURIComponent(cards[i])); const before = uv.assertions;
        if (engine === 'chromium') {
          await page.locator('#consent-approve:not(:disabled)').waitFor();
          await snapshot('card-' + i + '-before-approval');
          await page.evaluate(() => { globalThis.phoneAcceptanceHoldVerification = true; });
          await page.locator('.confirm-actions').getByRole('button', { name: language === 'zh' ? '批准本次' : 'Approve once', exact: true }).tap();
        await page.waitForFunction(() => globalThis.phoneAcceptanceVerificationPending === true);
        await check('card-' + i + '-verification-is-pending', executions === i && uv.assertions === before && await page.locator('.confirm-actions button:not(:disabled)').count() === 0,
          { verificationRequested: true, pausedAtNativeGetEntry: true, executions, assertions: uv.assertions - before }, true);
        await page.evaluate(() => { globalThis.phoneAcceptanceHoldVerification = false; globalThis.phoneAcceptanceReleaseVerification(); });
        await until(() => executions === i + 1);
        await until(async () => (await page.locator('#toast').innerText()) === (language === 'zh' ? '操作已完成' : 'Action completed'));
        await page.waitForFunction(pending => document.querySelector('.card-detail > p.quiet')?.textContent !== pending && document.querySelector('.card-detail > p.quiet')?.textContent,
          language === 'zh' ? '待你批准' : 'Awaiting your approval');
        await check('e-card-' + i + '-one-uv-one-execution', uv.assertions - before === 1 && executions === i + 1 && background.data.records.find(r => cards[i] === [r.actor.id, r.actor.nativeId, r.id].join(':'))?.state === 'complete', { assertions: uv.assertions - before, executions }, true);
        await unobscured('confirm/' + encodeURIComponent(cards[i])); await snapshot('card-' + i + '-completed-without-overlay');
        } else await check('cookie-alone-cannot-approve-' + i, await page.locator('.confirm-actions button:not(:disabled)').count() === 0 && executions === 0, null, { visibleChange: i === 0 });
      }
      await go('confirm/' + encodeURIComponent(expiredCard)); await check('expired-card-cannot-execute', await page.locator('.confirm-actions button:not(:disabled)').count() === 0 && executions === (engine === 'chromium' ? 2 : 0), null, true);
    }
    if (selected('reminders')) {
      await go('reminders');
      const beforeReminder = load('./app/record-reminders.cjs').status(profile, Date.now()).count;
      const reminder = page.locator('.reminder-card[data-record="operations"]');
      await reminder.getByRole('button', { name: language === 'zh' ? '知道了' : 'Got it', exact: true }).tap();
      await until(() => load('./app/record-reminders.cjs').status(profile, Date.now()).count === beforeReminder - 1);
      originals.push(language === 'zh' ? ['操作记录', '知道了'] : ['Operations record', 'Got it']);
      await check('reminders-same-source', beforeReminder > 0 && load('./app/record-reminders.cjs').status(profile, Date.now()).count === beforeReminder - 1, null, true);
    }
    if (selected('receipts')) {
      await go('chat/' + ids[0]);
      if (originals.length < 3 || await page.locator('.receipt').count() < 3) throw Error('receipt-originals-not-exercised');
      const association = receiptAssociations(await page.locator('.receipt').allInnerTexts(), originals);
      await check('h-cr1-each-receipt-identifies-original-input-or-action', association.pass, { expected: association.expected, identified: association.identified }, true);
    }
    if (selected('keyboard')) {
      await go('chat/' + ids[0]); await page.locator('#message').focus(); await page.setViewportSize({ width: 390, height: 460 });
      await page.locator('.thread .bubble').last().evaluate(e => {
        let n = e.parentElement;
        while (n && !(['auto', 'scroll'].includes(getComputedStyle(n).overflowY) && n.scrollHeight > n.clientHeight)) n = n.parentElement;
        n ||= document.scrollingElement; n.scrollTop = n.scrollHeight;
        const target = document.querySelector('#compose').getBoundingClientRect().top - 8, delta = e.getBoundingClientRect().bottom - target;
        if (delta < 0) n.scrollTop += delta;
      });
      if (process.argv.includes('--keyboard-overlay-fault')) await page.evaluate(() => {
        const shield = document.createElement('div'); shield.id = 'phone-fixture-shield'; shield.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#0004'; document.body.append(shield);
      });
      const geometry = await page.evaluate(() => {
        const message = [...document.querySelectorAll('.thread .bubble')].at(-1);
        const field = document.querySelector('#message'), compose = document.querySelector('#compose');
        const r = message.getBoundingClientRect(), f = field.getBoundingClientRect(), c = compose.getBoundingClientRect();
        const hit = document.elementFromPoint(f.x + f.width / 2, f.y + f.height / 2);
        return { visualHeight: visualViewport.height, layoutHeight: innerHeight, replyTop: r.top, replyBottom: r.bottom, composerTop: c.top,
          fieldReachable: f.top >= 0 && f.bottom <= visualViewport.height && (hit === field || field.contains(hit)) };
      });
      await check('keyboard-surrogate-keeps-reply-and-input-reachable', geometry.replyTop >= 0 && geometry.replyBottom <= geometry.composerTop + 1 && geometry.fieldReachable, geometry, true);
      await page.evaluate(() => document.querySelector('#phone-fixture-shield')?.remove());
      await page.setViewportSize({ width: 390, height: 844 });
    }
    if (selected('lifecycle')) {
      await unobscured('chat/' + ids[0]); await page.waitForLoadState('networkidle');
      if (!selected('navigation')) await page.locator('#message').fill('SYNTHETIC_UNSENT_DRAFT');
      await check('draft-survives-route-roundtrip', await page.locator('#message').inputValue() === 'SYNTHETIC_UNSENT_DRAFT', null, true);
      const offlineRoute = route => route.abort('internetdisconnected'), offlinePattern = site + '/mobile/**';
      await context.route(offlinePattern, offlineRoute); await context.setOffline(true);
      await page.locator('#connection > button').tap(); await page.locator('#toast').waitFor({ state: 'visible' });
      await wait(20000); await check('offline-never-replays', (await ipc('truth')).calls.filter(c => c.text === 'SYNTHETIC_PHONE_SEND').length === (selected('send') ? 1 : 0) && await page.locator('#message').inputValue() === 'SYNTHETIC_UNSENT_DRAFT', null, true);
      await context.setOffline(false);
      await context.unroute(offlinePattern, offlineRoute);
      await unobscured('chat/' + ids[0]); await snapshot('reconnected-without-overlay');
      const beforeReload = { ...uv };
      await page.reload(); await page.waitForFunction(() => document.documentElement.dataset.loading === 'false', null, { timeout: 120000 });
      await check('reload-restores-draft-without-send', await page.locator('#message').inputValue() === 'SYNTHETIC_UNSENT_DRAFT' && (await ipc('truth')).calls.filter(c => c.text === 'SYNTHETIC_PHONE_SEND').length === (selected('send') ? 1 : 0));
      if (engine === 'chromium') await check('reload-does-not-repeat-enrollment-uv', uv.registrations === beforeReload.registrations && uv.assertions === beforeReload.assertions, { ...uv });
    }
    await check('no-page-errors', errors.length === 0 && externalRequests === 0 && await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), { errors: errors.length, externalRequests });
    if (selected('pairing')) {
      const second = await browser.newContext({ ...browsers.devices['iPhone 13'], viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, ignoreHTTPSErrors: true, serviceWorkers: 'block' }); contexts.push(second);
      await second.route('**/*', r => { if (new URL(r.request().url()).origin === site) return r.continue(); externalRequests++; return r.abort(); });
      const other = await second.newPage(); other.on('pageerror', () => errors.push('page-error'));
      const replacement = () => app.context.beginQrAppMobile({ actor: 'synthetic-person', origin: site, port: localPort }, true, async () => true);
      let nextPair = await replacement(); await other.goto(site + '/mobile/#pair=' + nextPair.secret); await other.locator('#cancel-phone-pairing').tap();
      await until(() => other.evaluate(() => !nawPhone.client.state.session));
      const retained = await context.request.get(site + '/mobile/session', { headers: { 'X-NAW-Mobile': '1' } });
      await check('cancel-replacement-keeps-old-device', retained.status() === 200, null, { subject: other });
      nextPair = await replacement(); await other.goto(site + '/mobile/#pair=' + nextPair.secret); await other.locator('#basic-phone-pairing').tap();
      await other.waitForFunction(() => nawPhone.client.state.session && !nawPhone.client.state.session.candidate && document.querySelectorAll('a.row').length > 3, null, { timeout: 120000 });
      const superseded = await context.request.get(site + '/mobile/session', { headers: { 'X-NAW-Mobile': '1' } });
      page = other; context = second;
      await check('activated-replacement-revokes-old-device', superseded.status() !== 200, null, true);
      if (language === 'en') { await page.locator('#language-link').tap(); await page.waitForFunction(() => document.documentElement.lang === 'en'); }
      await page.getByRole('button', { name: language === 'zh' ? '管理' : 'Manage', exact: true }).tap();
      await page.locator('#dialog-body').getByRole('button', { name: language === 'zh' ? '撤销此手机并退出' : 'Revoke this phone and sign out', exact: true }).tap();
      await until(() => page.evaluate(() => !nawPhone.client.state.session));
      const revoked = await context.request.get(site + '/mobile/session', { headers: { 'X-NAW-Mobile': '1' } });
      await check('revocation-denies-old-browser', revoked.status() !== 200 && await page.locator('a.row').count() === 0, null, true);
    }
  } catch (error) { await check('harness-or-step-error', false, { code: error.code || error.name, message: String(error.message).split('\n')[0].replace(/https?:\/\/\S+/g, '[local-url]') }); }
  finally {
    await stop(); activeCleanup = async () => {};
  }
  const result = { engine, language, results, checkpoints, requests, pass: results.filter(r => r.pass).length, fail: results.filter(r => !r.pass).length };
  fs.writeFileSync(path.join(output, engine + '-' + language + '.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ engine, language, pass: result.pass, fail: result.fail, failures: results.filter(r => !r.pass) })); return result;
}
async function main() {
  const args = process.argv.slice(2), value = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const output = path.resolve(value('--output') || evidenceEnv || path.join(os.homedir(), 'Pictures/naw-dogfood/phone-acceptance-' + Date.now()));
  const repo = path.resolve(__dirname, '..'); if (output === repo || output.startsWith(repo + path.sep)) throw Error('Private output outside source tree required');
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  reportDirectory = output;
  const target = args[0] && !args[0].startsWith('--') ? args[0] : repo;
  let root = path.resolve(target);
  if (!fs.existsSync(path.join(root, 'app/mobile-http.cjs'))) {
    const revision = execFileSync('git', ['rev-parse', '--verify', '--end-of-options', target + '^{commit}'], { cwd: repo, encoding: 'utf8' }).trim();
    if (!/^[a-f0-9]{40}$/.test(revision)) throw Error('Local commit required');
    root = temporary(path.join(os.tmpdir(), 'naw-phone-target-'));
    const archive = execFileSync('git', ['archive', revision], { cwd: repo, maxBuffer: 64 * 1024 * 1024 });
    execFileSync('/usr/bin/tar', ['-x', '-C', root], { input: archive }); fs.symlinkSync(path.join(repo, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  }
  const shape = validateShape(value('--shape') ? JSON.parse(fs.readFileSync(value('--shape'), 'utf8')) : defaultShape());
  const steward = shape.sessions.map((s, index) => ({ s, index })).filter(r => r.s.messages >= 309).sort((a, b) => a.s.messages - b.s.messages)[0];
  if (steward) [shape.sessions[0], shape.sessions[steward.index]] = [shape.sessions[steward.index], shape.sessions[0]];
  // A dedicated case matches the reported 309-row Butler thread, alongside the measured fleet shape.
  const measuredStewardMessages = shape.sessions[0].messages;
  shape.sessions[0] = defaultShape().sessions[0];
  const cases = value('--cases')?.split(',');
  if (cases?.some(c => !['read','send','navigation','busy','steer','workspace','consent','reminders','receipts','keyboard','lifecycle','pairing'].includes(c))) throw Error('Unknown acceptance case');
  const engines = (value('--engines') || 'webkit,chromium').split(','), languages = (value('--languages') || 'zh,en').split(','), results = [];
  for (const engine of engines) for (const language of languages) results.push(await scenario(root, engine, language, shape, output, cases));
  const report = { target: /^[a-f0-9]{7,40}$/.test(target) ? target : 'explicit-local-tree', cases: cases || 'all', thresholds: THRESHOLDS, sessions: shape.sessions.length,
    sourceMessages: shape.sessions.reduce((n, s) => n + s.messages, 0), measuredStewardMessages, referenceButlerMessages: 309, syntheticMarkersPerSession: 2, results,
    pass: results.reduce((n, r) => n + r.pass, 0), fail: results.reduce((n, r) => n + r.fail, 0) };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(output, 'report.md'), '# Phone acceptance\n\n' + `Target: ${report.target}. ${report.pass} pass / ${report.fail} fail. Failures remain failures; exit code is nonzero.\n\n` +
    results.map(r => '## ' + r.engine + ' / ' + r.language + '\n\n| Step | Result | Readings | Screenshot |\n|---|---|---|---|\n' + r.results.map(s => `| ${s.name} | ${s.pass ? 'PASS' : 'FAIL'} | ${JSON.stringify(s.actual)} | ${s.screenshot ? `[frame](${r.engine}-${r.language}/${s.screenshot})` : 'metadata only'} |`).join('\n') +
      '\n\n| Frame | Actual checkpoint |\n|---|---|\n' + r.checkpoints.map(s => `| [${s.screenshot}](${r.engine}-${r.language}/${s.screenshot}) | ${s.name} |`).join('\n')).join('\n\n'));
  fs.writeFileSync(path.join(output, 'cold-read.md'), '# Screenshot-only cold read\n\nDo not read code or prior explanations. Using only the numbered screenshots, explain where you would: (1) say one sentence to the Butler and find its latest reply; (2) send a note while a member is busy; (3) return home; (4) find a pending confirmation and distinguish before verification, verification in progress and completion; (5) identify which original input or action each receipt belongs to. State the exact screenshot and unclear words, missing feedback or ambiguous controls. Do not infer success from a button label. Chromium uses a virtual authenticator: the system biometric UI itself is not captured.\n');
  console.log('SUMMARY ' + JSON.stringify({ pass: report.pass, fail: report.fail, output })); process.exitCode = report.fail ? 1 : 0;
}
if (require.main === module) {
  const cleanup = scratch.cleanup(async () => { await activeCleanup(); });
  main().catch(error => { console.error('BLOCKED acceptance runner:', error.name); process.exitCode = 1; }).finally(async () => {
    await cleanup(); const remaining = ownedRoots.filter(r => fs.existsSync(r));
    const result = { before: 0, after: remaining.length, created: ownedRoots.length };
    if (reportDirectory) fs.writeFileSync(path.join(reportDirectory, 'cleanup.json'), JSON.stringify(result));
    console.log('TEMP ' + JSON.stringify(result)); if (remaining.length) process.exitCode = 1;
  });
}
module.exports = { THRESHOLDS, messages, defaultShape, validateShape, assertCheckpointChanged, receiptAssociations, messageVisibility, scenario };
