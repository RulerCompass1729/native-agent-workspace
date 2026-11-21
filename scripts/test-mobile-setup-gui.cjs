// One-step phone access, plus the retained explicit subset flow with about 90 sessions.
// One hidden source window, a synthetic provider and synthetic names. No model, no real native runtime,
// no network beyond the loopback pairing listener of the isolated profile.
// Checks: each checkbox sits left of its words on one line; "Q07" is chosen in three steps
// (open Phone access, type Q07, tick it); sensitive approvals start folded; the address, Tailscale
// user and port come back after a restart. Screenshots go to NAW_EVIDENCE_DIR/images.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process'), { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '..'), evidence = process.env.NAW_EVIDENCE_DIR;
assert.ok(evidence && path.isAbsolute(evidence), 'An outside-repository screenshot directory is required');
const gitEnv = { ...process.env }; delete gitEnv.GIT_ASKPASS;
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, env: gitEnv, encoding: 'utf8' }).trim();
for (const repository of [root, path.dirname(common)]) assert.ok(!path.resolve(evidence).startsWith(repository + path.sep), 'Private evidence stays outside the repository');
const slot = path.resolve(process.env.NAW_GUI_TEST_SLOT || path.resolve(common, '../.local/gui-test-slot.lock')), token = randomUUID();
fs.mkdirSync(path.dirname(slot), { recursive: true });
try { fs.mkdirSync(slot); } catch (error) { if (error.code !== 'EEXIST') throw error; console.error('OCCUPIED: no GUI or service started'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'mobile setup GUI test', task: 'phone access setup', token, pid: process.pid, startedAt: new Date().toISOString() }));
const scratch = require('./fixtures/test-scratch.cjs'), { _electron } = scratch.playwright(require('playwright'));
const { connect } = require('../app/service-client.cjs'), locale = require('../app/ui-locale.js');
const profile = scratch.directory(path.join(os.tmpdir(), 'naw-mobile-setup-'));
const home = path.join(profile, 'home'), temporary = path.join(profile, 'tmp');
for (const dir of [home, temporary]) fs.mkdirSync(dir);
const dropped = ['NODE_OPTIONS', 'NODE_PATH', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_CHILD_SESSION'];
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NAW_') && !key.startsWith('ELECTRON_') && !dropped.includes(key))),
  HOME: home, TMPDIR: temporary, TMP: temporary, TEMP: temporary, NAW_DATA_DIR: profile, NAW_WORKSPACE: path.join(profile, 'work'), NAW_TEST_APP_ROOT: root,
  NAW_TEST_PARENT_PID: String(process.pid), NAW_TEST_UI_LANGUAGE: 'zh', NAW_TEST_VISIBLE: '0', NAW_APP_VERSION: require('../package.json').version,
};
const child = scratch.childProcess.fork(path.join(root, 'app/daemon.cjs'), [profile], { execArgv: ['--require', path.join(__dirname, 'fixtures/native-progress.cjs')], env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
let app, page, client, targetLabel, viewportWidth = 1240, errors = ''; const checks = [], failures = [], shots = [], measurements = [];
child.stderr.on('data', data => { errors += data; }); const closed = new Promise(resolve => child.once('close', resolve));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { for (let i = 0; i < 240; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
const check = label => { checks.push(label); console.log('PASS:', label); };
// Layout findings are collected, not thrown, so a run on the old screen still saves every picture.
const fail = label => { failures.push(label); console.log('FAIL:', label); };
async function settle() { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); await delay(120); }
const cleanup = scratch.cleanup(async () => {
  if (app) { await app.close(); app = null; }
  if (client) { try { await client.call('shutdown'); } catch {} client.close(); client = null; }
  if (child.exitCode === null && child.signalCode === null) { await Promise.race([closed, delay(1500)]); if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); }
  await closed;
});
const sessionCount = 90, target = 'Q07 合成验收';
async function launch(sourceEntry) {
  app = await _electron.launch({ executablePath: require('electron'), args: [sourceEntry], env, timeout: 60000 });
  page = await app.firstWindow(); page.setDefaultTimeout(15000);
  await page.locator('#new-session').waitFor();
  if (await page.locator('#setup-dialog').isVisible()) await page.locator('#close-setup').click();
  await require('./fixtures/default-space.cjs').revealDefaultSpace(page);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(win => win.setContentSize(1240, 820)));
}
async function openSettings(lang, theme) {
  await app.evaluate(({ nativeTheme }, theme) => { nativeTheme.themeSource = theme; }, theme);
  await page.emulateMedia({ colorScheme: theme });
  await page.locator('#setup-button').click(); await page.locator('#ui-language').selectOption(lang);
  await page.getByRole('dialog', { name: locale.format(lang, 'common.settings'), exact: true }).waitFor();
  // Step 1 of 3: open Phone access.
  await page.locator('#mobile-setup > details > summary').click(); await settle();
}
async function shoot(name, selector) {
  // Leave room for the sticky panel header so the section's own heading shows.
  await page.locator(selector).first().evaluate(el => { el.style.scrollMarginTop = '64px'; el.scrollIntoView({ block: 'start' }); }); await settle();
  const file = path.join(evidence, 'images', name + '.png');
  await page.locator('#setup-dialog').screenshot({ path: file, scale: 'css' }); shots.push(name);
}
// Every visible checkbox in Phone access: it must sit left of its words, centred on the same line.
async function alignment(tag) {
  const rows = await page.evaluate(() => [...document.querySelectorAll('#mobile-setup input[type=checkbox]')].filter(box => box.getClientRects().length).map(box => {
    // The words are the label's own text, wherever the markup puts them, so the old screen is measured the same way.
    const label = box.closest('label') || (box.id && document.querySelector(`label[for="${box.id}"]`)) || box.parentElement;
    const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT), texts = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.textContent.trim() && !box.contains(node)) texts.push(node);
    let w = null;
    if (texts.length) { const range = document.createRange(); range.setStartBefore(texts[0]); range.setEndAfter(texts[texts.length - 1]); w = range.getBoundingClientRect(); }
    const b = box.getBoundingClientRect();
    return { id: box.id || '', text: texts.map(node => node.textContent).join('').trim().slice(0, 40), box: { left: b.left, right: b.right, top: b.top, bottom: b.bottom }, words: w ? { left: w.left, right: w.right, top: w.top, bottom: w.bottom } : null };
  }));
  let bad = 0;
  for (const row of rows) {
    const centre = r => (r.top + r.bottom) / 2;
    const ok = row.words && row.box.right <= row.words.left && Math.abs(centre(row.box) - centre(row.words)) <= 2;
    if (!ok) bad++;
  }
  measurements.push({ tag, boxes: rows.length, misaligned: bad, sample: rows.slice(0, 6) });
  if (rows.length && !bad) check(`${tag}: ${rows.length} visible checkboxes each sit left of their words, centred within 2px`);
  else fail(`${tag}: ${bad} of ${rows.length} visible checkboxes are not left of and centred with their words`);
}
async function compactHeight(tag) {
  const geometry = await page.evaluate(() => {
    const panel = document.querySelector('#setup-dialog'), title = document.querySelector('#mobile-setup > details > summary'), button = document.querySelector('#mobile-prepare');
    const p = panel.getBoundingClientRect(), h = title.getBoundingClientRect(), b = button.getBoundingClientRect(), sticky = panel.querySelector('.setup-heading').getBoundingClientRect();
    const list = document.querySelector('#mobile-setup .mobile-session-list'), endpoint = document.querySelector('#mobile-connection-summary'), fields = document.querySelector('#mobile-connection-fields');
    return { panelTop: p.top, panelBottom: p.bottom, stickyBottom: sticky.bottom, titleTop: h.top, buttonBottom: b.bottom, height: b.bottom - h.top,
      remembered: !endpoint.hidden, fieldsVisible: !fields.hidden, listHeight: list.getBoundingClientRect().height, listScroll: list.scrollHeight > list.clientHeight, panelOverflow: panel.scrollWidth > panel.clientWidth,
      rowHeight: document.querySelector('#mobile-setup .mobile-session > .mobile-check').getBoundingClientRect().height };
  });
  measurements.push({ tag, ...geometry });
  if (geometry.titleTop >= geometry.stickyBottom - 1 && geometry.buttonBottom <= geometry.panelBottom - 8 && !geometry.panelOverflow) check(`${tag}: title→prepare ${geometry.height.toFixed(1)}px fits without another scroll (${geometry.remembered ? 'remembered' : 'first use'})`);
  else fail(`${tag}: compact geometry ${JSON.stringify(geometry)}`);
  if (geometry.listHeight <= 121 && geometry.rowHeight <= 25 && geometry.listScroll) check(`${tag}: about five rows, internal list scroll`); else fail(`${tag}: list geometry ${JSON.stringify(geometry)}`);
}
async function variant(lang, theme) {
  const tag = `${lang}-${theme}-${viewportWidth}`;
  await openSettings(lang, theme);
  const compact = await page.locator('#mobile-advanced').count();
  const allScope = await page.locator('#mobile-all-sessions').count();
  if (allScope) {
    assert.equal(await page.locator('#mobile-all-sessions').isChecked(), true);
    assert.equal(await page.locator('#mobile-advanced').evaluate(el => el.open), false);
    assert.equal(await page.locator('#mobile-origin').isVisible(), false);
    assert.equal(await page.locator('#mobile-actor').isVisible(), false);
    await shoot(tag + '-all-default', '#mobile-setup > details');
    check(`${tag}: all current and future scope is the default intent; private entry fields stay in advanced`);
    await subset();
    const listHeight = await page.locator('#mobile-setup .mobile-session-list').evaluate(el => ({height:el.getBoundingClientRect().height,scroll:el.scrollHeight>el.clientHeight}));
    assert.ok(listHeight.height<=121 && listHeight.scroll);
    check(`${tag}: the explicit subset retains the bounded internally scrolling list`);
  }
  if (compact && !allScope) {
    assert.equal(await page.locator('#mobile-advanced').evaluate(el => el.open), false);
    assert.equal(await page.locator('#mobile-advanced-title').textContent(), locale.format(lang, 'mobile.advanced'));
    await compactHeight(tag);
    const endpoint = await page.locator('#mobile-connection-summary').isVisible();
    if (!endpoint) {
      assert.deepEqual(await page.locator('#mobile-origin').inputValue(), ''); assert.deepEqual(await page.locator('#mobile-actor').inputValue(), '');
      assert.ok(await page.locator('#mobile-origin').isEditable()); assert.ok(await page.locator('#mobile-actor').isEditable());
      await page.locator('#setup-dialog').screenshot({ path: path.join(evidence, '..', `first-use-${lang}-${theme}-${viewportWidth}.png`), scale: 'css' });
      check(`${tag}: empty address and user inputs are directly editable, not an empty summary`);
    } else {
      assert.equal(await page.locator('#mobile-endpoint-port').textContent(), locale.format(lang, 'mobile.endpointPortAuto'));
      await page.locator('#setup-dialog').screenshot({ path: path.join(evidence, '..', `remembered-${lang}-${theme}-${viewportWidth}.png`), scale: 'css' });
      check(`${tag}: automatic port is labeled in plain language`);
    }
    if (endpoint && viewportWidth === 1240) {
      await page.locator('#setup-dialog').screenshot({ path: path.join(evidence, '..', `final-${lang}-${theme}.png`), scale: 'css' });
    }
    check(`${tag}: advanced setup starts folded without hidden nondefault choices`);
  }
  await shoot(tag + '-list', '#mobile-setup .mobile-sessions');
  await alignment(tag + ' list');
  if (!await page.locator('#mobile-session-filter').count()) fail(`${tag}: no session search`);
  else {
    // Steps 2 and 3: type Q07, tick it.
    await page.locator('#mobile-session-filter').fill('Q07');
    const box = page.getByRole('checkbox', { name: targetLabel, exact: true }); await box.check(); await settle();
    const state = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('#mobile-setup .mobile-session')];
      const read = rows.map(row => row.querySelector('label > input[type=checkbox]'));
      return { visible: rows.filter(row => !row.hidden).length, chosen: read.filter(input => input.checked).map(input => input.closest('label').textContent),
        actionsShown: rows.filter(row => !row.querySelector('.mobile-session-actions').hidden).length, count: document.querySelector('#mobile-setup .mobile-count').textContent };
    });
    if (state.visible === 1 && state.chosen.length === 1 && state.chosen[0].startsWith(target) && state.actionsShown === 1) check(`${tag}: open, type Q07, tick → only ${target} is chosen; its send/answer appear (${state.count})`);
    else fail(`${tag}: Q07 flow ${JSON.stringify(state)}`);
    await shoot(tag + '-q07', '#mobile-setup .mobile-sessions');
    await alignment(tag + ' Q07 chosen');
    await page.locator('#mobile-session-filter').fill(''); await settle();
    const first = await page.locator('#mobile-setup .mobile-session').first().textContent();
    if (first.startsWith(target)) check(`${tag}: cleared search lists the chosen session first`); else fail(`${tag}: first row after clearing is ${first.slice(0, 30)}`);
  }
  if (compact) {
    if (!await page.locator('#mobile-advanced').evaluate(el => el.open)) await page.locator('#mobile-advanced > summary').click();
    await page.locator('#mobile-port').fill('43125'); await page.locator('#mobile-records').check(); await page.locator('#mobile-replace').check();
    const room = page.locator('#mobile-setup .mobile-spaces input[type=checkbox]').first(); await room.check();
    assert.equal(await page.locator('#mobile-advanced-title').textContent(), locale.format(lang, 'mobile.advancedActive', { count: 4 }));
    await page.locator('#mobile-advanced > summary').click();
    assert.equal(await page.locator('#mobile-advanced-title').textContent(), locale.format(lang, 'mobile.advancedActive', { count: 4 }));
    await page.locator('#mobile-advanced > summary').focus(); await page.keyboard.press('Space');
    await page.locator('#mobile-port').fill('0'); await page.locator('#mobile-records').uncheck(); await page.locator('#mobile-replace').uncheck(); await room.uncheck();
    assert.equal(await page.locator('#mobile-advanced-title').textContent(), locale.format(lang, 'mobile.advanced'));
    check(`${tag}: folded title exposes four nondefaults, keyboard Space expands it, clearing restores defaults`);
  }
  const folded = page.locator('#mobile-approval-section');
  if (!await folded.count()) { fail(`${tag}: sensitive approvals are not a folded section`); await shoot(tag + '-approval', '#mobile-approval-begin'); }
  else {
    if (await folded.evaluate(el => el.open === false) && !await page.locator('#mobile-approval-begin').isVisible()) check(`${tag}: sensitive approvals start folded`);
    else fail(`${tag}: sensitive approvals start open`);
    await shoot(tag + '-folded', '#mobile-setup .mobile-spaces');
    await folded.locator('summary').click(); await settle();
    await alignment(tag + ' approvals open');
    if (lang === 'en') {
      const stray = await page.locator('#mobile-approval-section').evaluate(el => (el.innerText.match(/[\u3400-\u9fff]+/g) || []).join(' '));
      if (!stray) check(`${tag}: approval section has no Chinese left after switching language`); else fail(`${tag}: Chinese left in approvals: ${stray}`);
    }
    await shoot(tag + '-approval', '#mobile-approval-section');
  }
  await page.locator('#close-setup').click(); await page.locator('#setup-dialog').waitFor({ state: 'hidden' });
}
async function subset() {
  if (!await page.locator('#mobile-all-sessions').count()) return;
  if (!await page.locator('#mobile-advanced').evaluate(el=>el.open)) await page.locator('#mobile-advanced > summary').click();
  await page.locator('#mobile-all-sessions').uncheck(); await settle();
}
async function verifyFullConnect() {
  let listenPort;
  const nativeFixture = (method, target) => new Promise((resolve,reject) => {
    const id=randomUUID(), timeout=setTimeout(()=>{child.off('message',receive);reject(Error('Synthetic native fixture did not settle'));},5000);
    const receive=message=>{if(message.requestId!==id)return;child.off('message',receive);clearTimeout(timeout);message.error?reject(Error('Synthetic native fixture refused')):resolve(message);};
    child.on('message',receive);child.send({id,method,target});
  });
  const request = (route, { method='GET', actor='synthetic-human', body, cookie, csrf } = {}) => new Promise((resolve, reject) => {
    const req = require('node:http').request({hostname:'127.0.0.1',port:listenPort,path:route,method,headers:{Host:'mobile.invalid','Tailscale-User-Login':actor,'X-NAW-Mobile':'1',Origin:'https://mobile.invalid',...(body?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{}),...(csrf?{'X-NAW-CSRF':csrf}:{})}},response=>{
      const chunks=[];response.on('data',b=>chunks.push(b));response.on('end',()=>{try{resolve({status:response.statusCode,headers:response.headers,value:JSON.parse(Buffer.concat(chunks).toString())})}catch{reject(Error('Synthetic mobile response unavailable'))}});
    });req.on('error',()=>reject(Error('Synthetic mobile carrier unavailable')));req.end(body?JSON.stringify(body):undefined);
  });
  try {
    await openSettings('zh','light'); assert.equal(await page.locator('#mobile-all-sessions').isChecked(),true);
    await page.locator('#mobile-prepare').click();await until(()=>page.locator('#mobile-pair-qr').isVisible(),'Local one-step code');
    listenPort = await app.evaluate(({app}) => app.nawSyntheticMobile.port);
    const png=await page.locator('#mobile-pair-qr').getAttribute('src');assert.ok(png?.startsWith('data:image/png;base64,'));
    assert.equal(await page.locator('#mobile-pair-link').inputValue(),'');
    assert.ok(await page.locator('#mobile-pair-qr').evaluate(img=>img.naturalWidth>0),'Local code renders under the real shell CSP');
    const renderedCode = await page.locator('#mobile-pair-qr').screenshot({scale:'css'});
    const link=execFileSync('/usr/bin/osascript',['-l','JavaScript',path.join(root,'app/tests/fixtures/mobile-qr-decode.jxa')],{input:renderedCode.toString('base64'),encoding:'utf8',timeout:5000,env:{PATH:'/usr/bin:/bin',LANG:'en_US.UTF-8'},stdio:['pipe','pipe','pipe']}).trim();
    const parsed=new URL(link);assert.ok(parsed.origin==='https://mobile.invalid'&&/^#pair=[A-Za-z0-9_-]{43}$/.test(parsed.hash),'Exact private synthetic origin and one-use fragment');
    assert.equal((await request('/mobile/session',{actor:'wrong-synthetic-user'})).status,403);
    const paired=await request('/mobile/pair',{method:'POST',body:{secret:parsed.hash.slice(6)}});assert.equal(paired.status,200);
    const cookie=paired.headers['set-cookie'][0].split(';')[0];
    const candidate=await request('/mobile/session',{cookie});assert.equal(candidate.status,200);assert.equal(candidate.value.candidate,true);assert.equal(candidate.value.sessions.length,0);
    assert.equal((await request('/mobile/workspace',{cookie})).status,403);
    const activated=await request('/mobile/pair/activate',{method:'POST',cookie,csrf:candidate.value.csrf,body:{mode:'basic'}});assert.equal(activated.status,200);assert.equal(activated.value.sensitiveDecisions,false);
    const before=await request('/mobile/session',{cookie});assert.equal(before.status,200);assert.equal(before.value.sessions.length,sessionCount);
    assert.ok(before.value.sessions.every(s=>s.actions.join(',')==='read,send,answer'));
    await client.call('create',{provider:'codex',cwd:profile,name:'Synthetic future member',view:'chat'});
    const after=await request('/mobile/session',{cookie});assert.equal(after.status,200);assert.equal(after.value.sessions.length,sessionCount+1);
    const future=after.value.sessions.find(s=>s.name==='Synthetic future member');assert.ok(future);
    await nativeFixture('bindSends',future.id);
    const desktopDraft='Synthetic desktop draft / 草稿  \n';await client.call('draft',future.id,desktopDraft);
    const nativeRead=await request('/mobile/read/'+future.id,{cookie});assert.equal(nativeRead.status,200);assert.equal(nativeRead.value.canSend,true);
    const sent=await request('/mobile/send',{method:'POST',cookie,csrf:after.value.csrf,body:{contextId:nativeRead.value.contextId,requestId:randomUUID(),text:'FULL_PHONE_SYNTHETIC_MESSAGE'}});
    assert.equal(sent.status,200);assert.equal(sent.value.status,'submitted');
    assert.equal((await nativeFixture('stats',future.id)).stats.sends,1);
    const updated=(await client.call('initial')).sessions.find(s=>s.id===future.id);assert.ok(updated.messages.some(m=>m.text==='FULL_PHONE_SYNTHETIC_MESSAGE'));assert.equal(updated.liveDraft,desktopDraft);
    const workspace=await request('/mobile/workspace',{cookie});assert.equal(workspace.status,200);assert.equal(workspace.value.capabilities.push,true);assert.equal(workspace.value.capabilities.sensitiveDecisions,false);
    const pushInfo=await request('/mobile/push',{cookie});assert.equal(pushInfo.status,200);assert.equal(pushInfo.value.enabled,false);assert.match(pushInfo.value.publicKey,/^[A-Za-z0-9_-]{87}$/);
    assert.equal((await request('/mobile/push',{method:'POST',cookie,csrf:after.value.csrf,body:{action:'subscribe',subscription:{}}})).status,403);
    // Decode was in memory only; never persist a pairing bearer in evidence.
    await page.locator('#mobile-pair-qr').evaluate(el=>{el.style.visibility='hidden';});
    const shot=await page.locator('#setup-dialog').screenshot({scale:'css'});
    await page.locator('#mobile-revoke').click();await until(async()=>!await page.locator('#mobile-pair-qr').isVisible(),'Synthetic revocation');
    fs.writeFileSync(path.join(evidence,'images','one-step-local-code-revoked.png'),shot);
    check('One human click generates a local Core Image code in the real hidden shell; pair, future native send and draft preservation work; reminders are granted, push and sensitive approvals remain off; test code revoked before evidence saved');
    await page.locator('#close-setup').click();
  } finally {
    await app.evaluate(({app})=>app.nawSyntheticMobile.restore());
  }
}
async function run() {
  fs.mkdirSync(path.join(evidence, 'images'), { recursive: true });
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Synthetic service');
  client = await connect(profile, 'mobile-setup-gui-person'); scratch.ownService(profile);
  const names = Array.from({ length: sessionCount }, (_, i) => `Synthetic member ${String(i + 1).padStart(2, '0')}`);
  names.splice(57, 1, target);
  for (const name of names) await client.call('create', { provider: 'codex', cwd: profile, name, view: 'chat' });
  const sourceEntry = require('./fixtures/synthetic-source-boot.cjs').createSourceEntry({ profile, code: root, fixturePid: child.pid });
  // Test-only CommonJS hook: no live Tailscale inspection and no production hook/flag.
  fs.writeFileSync(path.join(sourceEntry,'mobile-test-hook.cjs'), `
const {app}=require('electron'), carrier=require(${JSON.stringify(path.join(root,'app/mobile-carrier.cjs'))}), original=carrier.detect;
let port;carrier.detect=async()=>{if(!port){const server=require('node:net').createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));port=server.address().port;await new Promise(r=>server.close(r));}return {origin:'https://mobile.invalid',actor:'synthetic-human',port};};
app.nawSyntheticMobile={get port(){return port},restore(){carrier.detect=original}};
`,{mode:0o600});
  const entryFile=path.join(sourceEntry,'entry.cjs');fs.writeFileSync(entryFile,"require('./mobile-test-hook.cjs');\n"+fs.readFileSync(entryFile,'utf8'),{mode:0o600});
  await launch(sourceEntry);
  const pageErrors = []; page.on('pageerror', error => pageErrors.push(error.message));
  assert.ok((await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(win => ({ visible: win.isVisible(), focused: win.isFocused() })))).every(win => !win.visible && !win.focused));
  check('Isolated source window stays hidden and unfocused');
  const listed = (await client.call('initial')).sessions.filter(s => s.nativeId && !s.archived && !s.nativeContextPending).length;
  assert.equal(listed, sessionCount, 'Every synthetic session is offered in Phone access');
  targetLabel = target + ' · ' + (await client.call('initial')).sessions.find(s => s.name === target).id.slice(0, 6);
  await verifyFullConnect();
  for (const width of [1240, 850]) {
    viewportWidth = width; await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows().forEach(win => win.setContentSize(width, 820)), width);
    for (const lang of ['zh', 'en']) for (const theme of ['dark', 'light']) await variant(lang, theme);
  }
  if (await page.locator('#mobile-session-filter').count()) {
    // A checked attempt remembers the address, Tailscale user and port; a restart brings them back.
    await openSettings('zh', 'dark');
    await subset();
    for (const lang of ['zh', 'en']) {
      await page.locator('#ui-language').selectOption(lang);
      await page.locator('#mobile-actor').fill('https://device.example.invalid/mobile/#pair=' + 's'.repeat(43));
      await page.locator('#mobile-prepare').click();
      assert.equal(await page.locator('#mobile-status').textContent(), locale.format(lang, 'mobile.invalidActor'));
      assert.equal(await page.locator('#mobile-actor').getAttribute('aria-invalid'), 'true');
      assert.equal(await page.locator('#mobile-pair-link').inputValue(), '');
      assert.ok(!fs.readFileSync(path.join(profile, 'views.json'), 'utf8').includes('pair='));
      await shoot(`${lang}-bad-account`, '#mobile-setup > details');
      check(`${lang}: a pasted link is rejected with an account hint and never remembered`);
    }
    await page.locator('#ui-language').selectOption('zh');
    await page.locator('#mobile-origin').fill('https://device.example.invalid'); await page.locator('#mobile-actor').fill('synthetic-human');
    if (await page.locator('#mobile-advanced').count() && !await page.locator('#mobile-advanced').evaluate(el=>el.open)) await page.locator('#mobile-advanced > summary').click();
    await page.locator('#mobile-port').fill('0'); await page.locator('#mobile-carrier').check();
    await page.locator('#mobile-session-filter').fill('Q07'); await page.getByRole('checkbox', { name: targetLabel, exact: true }).check();
    await page.locator('#mobile-prepare').click();
    await until(async () => await page.locator('#mobile-pair-link').inputValue() !== '', 'Synthetic pairing link');
    await page.locator('#mobile-revoke').click();
    await until(async () => (await page.locator('#mobile-setup [role=status]').first().textContent()) === locale.format('zh', 'mobile.revoked'), 'Synthetic pairing revoked');
    await page.locator('#close-setup').click(); await page.locator('#setup-dialog').waitFor({ state: 'hidden' });
    const saved = JSON.stringify(JSON.parse(fs.readFileSync(path.join(profile, 'views.json'), 'utf8')));
    assert.ok(saved.includes('"mobileEndpoint":{"origin":"https://device.example.invalid","actor":"synthetic-human","port":"0"}'), 'Saved view keeps the endpoint');
    assert.ok(!/pair=|secret|cookie/i.test(saved), 'Saved view holds no link, secret or cookie');
    await app.close(); app = null;
    await launch(sourceEntry); await openSettings('zh', 'dark');
    const values = await page.evaluate(() => ['mobile-origin', 'mobile-actor', 'mobile-port', 'mobile-pair-link'].map(id => document.getElementById(id).value));
    const unticked = await page.evaluate(() => [...document.querySelectorAll('#mobile-setup input[type=checkbox]:not(#mobile-all-sessions)')].every(input => !input.checked));
    if (await page.locator('#mobile-all-sessions').count()) assert.equal(await page.locator('#mobile-all-sessions').isChecked(), true, 'Only the approved all-scope draft default changes after restart; old selected grants are not broadened');
    if (JSON.stringify(values) === JSON.stringify(['https://device.example.invalid', 'synthetic-human', '0', '']) && unticked) check('After a restart the address, Tailscale user and port are filled in; the link and every choice start empty');
    else fail(`restart recall ${JSON.stringify({ values, unticked })}`);
    await shoot('zh-dark-restart', '#mobile-setup > details');
    await page.locator('#close-setup').click();
    for (const width of [1240, 850]) {
      viewportWidth = width; await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows().forEach(win => win.setContentSize(width, 820)), width);
      for (const lang of ['zh', 'en']) for (const theme of ['dark', 'light']) await variant(lang, theme);
    }
  }
  assert.deepEqual(pageErrors, []);
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ checks, failures, measurements, screenshots: shots, pageErrors }, null, 2));
  console.log(`GUI ${checks.length}/${failures.length}; screenshots=${shots.length}; sessions=${sessionCount}; models=0`);
  if (failures.length) process.exitCode = 1;
}
run().catch(async error => {
  console.error(error.stack); console.error(errors);
  if (page) await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
}).finally(async () => {
  try { await cleanup(); } finally { if (JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))).token === token) fs.rmSync(slot, { recursive: true }); }
}).catch(error => { console.error(error.stack); process.exitCode = 1; });
