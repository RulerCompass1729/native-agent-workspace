// Sidebar hover card (11-15): one hidden source-Electron journey per language with synthetic native hosts, an owned
// temporary profile and synthetic names only. Checks the delay, content, placement, dismissal and that the card never
// takes a click, checks card text keeps 4.5:1 over the strict worst backdrop with the live theme tokens, and saves the
// pictures (the person's choice A, 11-15) for the person. No model, provider or send.
// Usage: NAW_HOVER_EVIDENCE_DIR=/abs/new/dir node scripts/test-sidebar-hover-card.cjs zh|en   (run build-ui first)
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto'), { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'), scratch = require('./fixtures/test-scratch.cjs'), { _electron } = scratch.playwright(require('playwright'));
const { createSourceEntry } = require('./fixtures/synthetic-source-boot.cjs'), messages = require('../app/ui-messages.js');
const lang = process.argv[2], out = process.env.NAW_HOVER_EVIDENCE_DIR;
const plan = { task: 'sidebar hover card journey', maxElectronStarts: 1, maxOwnedDaemonStarts: 1, productModels: 0, providers: 0, nativeInputs: 0, sends: 0 };
if (process.argv.includes('--plan')) { console.log(JSON.stringify(plan, null, 2)); process.exit(0); }
assert.ok(['zh', 'en'].includes(lang), 'Language zh or en'); assert.ok(out && path.isAbsolute(out) && !fs.existsSync(out), 'NAW_HOVER_EVIDENCE_DIR: a new absolute directory');
assert.ok(fs.existsSync(path.join(root, 'app/dsh/client.js')), 'Run node scripts/build-ui.cjs first');
const slot = path.resolve(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim(), '..', '.local/gui-test-slot.lock'), token = randomUUID();
const benign = new Set(['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'HOME', 'SHELL', 'USER', 'LOGNAME', 'TZ', 'TERM', 'COLORTERM', 'COMMAND_MODE', '__CF_USER_TEXT_ENCODING']);
const env = extra => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => benign.has(k))), ...extra });
const t = (key, params) => messages[lang][key].replace(/\{(\w+)\}/g, (_, name) => String(params[name]));
let profile, child, client, app, page, sequence = 0, lease = false;
const errors = [], ids = [], rooms = [], shots = [], checks = [];
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label, ms = 4000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await delay(25); } throw Error(label); }
function fixture(method, target, value) {
  const id = ++sequence;
  return new Promise((resolve, reject) => { const cb = reply => { if (reply.requestId !== id) return; clearTimeout(timer); child.off('message', cb); reply.error ? reject(Error(reply.error)) : resolve(reply); };
    const timer = setTimeout(() => { child.off('message', cb); reject(Error('Fixture deadline')); }, 8000); child.on('message', cb); child.send({ id, method, target, value }); });
}
const settle = async () => { await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))); await delay(150); };
const size = async (width, height) => { await app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].setContentSize(s.width, s.height), { width, height }); await settle(); };
const surface = () => page.locator('.naw[data-native-surface="sidebar"]');
const S = id => `.naw[data-native-surface="sidebar"] [data-session-row="${id}"]`, G = id => `.naw[data-native-surface="sidebar"] [data-session-group="${id}"] .session-space-heading`;
const card = () => page.locator('#naw-hover-card');
const shown = () => card().evaluate(el => !el.hidden && el.matches(':popover-open'));
const cardText = () => card().evaluate(el => el.innerText);
async function rail(on) { if (await surface().getAttribute('data-collapsed') !== String(on)) { await page.locator('#sidebar-toggle').click(); await until(async () => await surface().getAttribute('data-collapsed') === String(on), 'Sidebar ' + (on ? 'rail' : 'expanded')); await settle(); } }
async function away() { await page.mouse.move(700, 5); await until(async () => !await shown(), 'Card closes when the pointer leaves', 1500); }
async function reveal(selector) { await page.mouse.move(700, 5); await page.locator(selector).scrollIntoViewIfNeeded(); await settle(); await delay(400); }
async function hover(selector) { const box = await page.locator(selector).boundingBox(); await page.mouse.move(box.x + Math.min(box.width / 2, 60), box.y + Math.min(box.height / 2, 20)); }
async function step(name, fn) { await fn(); checks.push(name); console.log('PASS ' + name); }
async function geometry(selector) {
  return page.evaluate(sel => { const r = document.getElementById('naw-hover-card').getBoundingClientRect(), a = document.querySelector(sel).getBoundingClientRect(), s = document.querySelector('.naw[data-native-surface="sidebar"]').getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, vw: innerWidth, vh: innerHeight, sidebarRight: s.right, overlapsAnchor: !(r.left >= a.right || r.right <= a.left || r.top >= a.bottom || r.bottom <= a.top) }; }, selector);
}
function inside(g, label) {
  assert.ok(g.left >= 0 && g.top >= 0 && g.right <= g.vw && g.bottom <= g.vh, label + ': card inside the window ' + JSON.stringify(g));
  assert.equal(g.overlapsAnchor, false, label + ': card never covers its item');
}

const NAMES = {
  zh: { sessions: ['左栏悬停详情 · 第二轮界面评审与回归核对', '界面整理', '回归检查', '说明文档', '数据核对', '临时讨论'], spaces: ['产品开发', '资料整理'],
    queue: [['把左栏悬停详情做成原型图\n字段和行为写在说明里', 'sent', 0], ['核对窄窗下弹层的位置', 'waiting', 2], ['补英文界面的截图', 'queued'], ['整理空间卡片要显示的字段', 'queued'], ['汇总本周的资料来源', 'queued', null, 1]],
    history: ['把左栏会话行的间距再核对一遍，窄窗和宽窗都看。', '已核对左栏会话行。\n\n宽窗下每行高度一致，标题、状态和时间对齐；窄窗下标题截断为省略号，时间保持在右侧，没有换行。\n\n空间分组的卡片边框和间距在浅色、深色两种外观下都一致。'] },
  en: { sessions: ['Sidebar hover details · round-two UI review and regression', 'UI cleanup', 'Regression check', 'Docs', 'Data check', 'Scratch talk'], spaces: ['Product work', 'Reference notes'],
    queue: [['Make prototype images for the sidebar hover details\nFields and behavior go in the notes', 'sent', 0], ['Check where the card sits in a narrow window', 'waiting', 2], ['Add English screenshots', 'queued'], ['List the fields the space card shows', 'queued'], ['Collect this week\'s sources', 'queued', null, 1]],
    history: ['Check the sidebar row spacing again, in a narrow and a wide window.', 'Checked the sidebar rows.\n\nIn a wide window every row has the same height, and title, status and time line up; in a narrow window the title ends in an ellipsis and the time stays on the right without wrapping.\n\nSpace group borders and spacing match in the light and dark looks.'] },
}[lang];
const PROVIDERS = ['claude', 'claude', 'codex', 'claude', 'codex', 'claude'];
// Session i → [vendor, model, cwd, worktree?]; times relative to launch. Synthetic paths only.
const FACTS = [['deepseek', 'deepseek-v4-pro', '/demo/projects/atlas-desktop-lanes/hover-details-round-2', { repository: '/demo/projects/atlas-desktop', nonce: 'e41f9c-27', branch: 'naw/session-e41f9c27' }],
  ['anthropic', 'claude-opus-5-5', '/demo/projects/atlas-desktop', null], ['openai', 'gpt-6.1-sol', '/demo/projects/atlas-desktop-lanes/check', { repository: '/demo/projects/atlas-desktop', nonce: 'b7720d-11', branch: 'naw/session-b7720d11' }],
  ['anthropic', 'claude-opus-5-5', '/demo/notes', null], ['openai', 'gpt-6.1-sol', '/demo/data', null], ['deepseek', 'deepseek-v4-pro', '', null]];

async function launch() {
  profile = scratch.directory(path.join(os.tmpdir(), 'naw-hover-card-')); const cwd = path.join(profile, 'workspace'); fs.mkdirSync(cwd);
  child = scratch.childProcess.fork(path.join(root, 'app/daemon.cjs'), [profile], { cwd, execArgv: ['--require', path.join(root, 'scripts/fixtures/loading-terminal.cjs')], env: env({ NAW_TEST_APP_ROOT: root, NAW_WORKSPACE: cwd, NAW_APP_VERSION: require(path.join(root, 'package.json')).version }), stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Owned synthetic backend', 20000);
  client = await require(path.join(root, 'app/service-connection.cjs')).connectService(profile, 'hover-seed');
  for (const [i, name] of NAMES.sessions.entries()) ids.push(await client.call('create', { provider: PROVIDERS[i], cwd, name, view: 'chat' }));
  await client.call('wakePolicy', null, false); // automatic messages off: queued items stay queued
  const now = Date.now(), entry = createSourceEntry({ profile, code: root, fixturePid: child.pid }), file = path.join(entry, 'entry.cjs');
  fs.writeFileSync(file, `const e=require('electron');e.Notification.isSupported=()=>false;globalThis.hoverGuards=[];globalThis.hoverQueue={};
for(const name of ['showOpenDialog','showSaveDialog','showMessageBox','showOpenDialogSync','showSaveDialogSync','showMessageBoxSync'])e.dialog[name]=()=>{hoverGuards.push(name);throw Error('OS dialog outside test');};
const {WorkspaceClient}=require(${JSON.stringify(path.join(root, 'app/workspace-client.cjs'))}), old=WorkspaceClient.prototype.snapshot, ids=${JSON.stringify(ids)}, facts=${JSON.stringify(FACTS)}, now=${now};
WorkspaceClient.prototype.snapshot=function(...args){const s=structuredClone(old.apply(this,args));
for(const r of s.sessions){const i=ids.indexOf(r.id);if(i<0)throw Error('Unexpected record');const [vendor,model,cwd,plan]=facts[i];r.vendor=vendor;r.model=model;r.cwd=cwd;if(plan)r.worktreePreparation={...plan,target:cwd};
r.createdAt=now-[3*3600e3,26*3600e3,5*3600e3,2*86400e3,50*60e3,20*60e3][i];r.lastActivityAt=now-[90e3,40*60e3,6*60e3,3*3600e3,12*60e3,15*60e3][i];if(i===0||i===4)r.state='working';if(i===2)r.nativeInputRequired=true;}
return s;};
const {RoomState}=require(${JSON.stringify(path.join(root, 'app/room-state.cjs'))}), oldApply=RoomState.prototype.apply;
RoomState.prototype.apply=function(...args){const s=oldApply.apply(this,args);if(!s||!Object.keys(hoverQueue).length)return s;const c=structuredClone(s);
for(const room of [c.room,...(c.rooms||[])].filter(Boolean))for(const item of room.queue||[]){const p=hoverQueue[item.text];if(p)Object.assign(item,p);}return c;};
` + fs.readFileSync(file, 'utf8'));
  app = await _electron.launch({ executablePath: require('electron'), args: [entry], env: env({ NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid), NAW_TEST_VISIBLE: '0', NAW_TEST_UI_LANGUAGE: lang }), timeout: 60000 });
  await until(async () => { for (const p of app.windows()) if (!p.isClosed() && await p.locator('#new-session').count()) { page = p; return true; } return false; }, 'Workspace page', 30000);
  page.setDefaultTimeout(8000); page.on('pageerror', e => errors.push(e.message));
  assert.deepEqual(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ visible: w.isVisible(), focusable: w.isFocusable() }))), [{ visible: false, focusable: false }]);
  await size(1240, 820);
  for (const name of NAMES.spaces) rooms.push(await page.evaluate(name => workspace.spaceCreate(name), name));
  for (const [r, i] of [[0, 0], [0, 1], [0, 2], [0, 3], [1, 3], [1, 4]]) await page.evaluate(({ room, id }) => workspace.spaceAction(room, 'join', [id, true]), { room: rooms[r], id: ids[i] });
  const patches = {};
  for (const [text, status, to] of NAMES.queue) if (status !== 'queued') patches[text] = { status, sentTo: ids[to], sentAt: now - 20 * 60e3 };
  await app.evaluate((_e, p) => { globalThis.hoverQueue = p; }, patches);
  for (const [text, , , r = 0] of NAMES.queue) await page.evaluate(({ room, text }) => workspace.spaceAction(room, 'queueAdd', [text, null]), { room: rooms[r], text });
  await page.locator('#sessions-grouped').click(); await page.locator(S(ids[1]) + ' .session-link').click(); await settle(); await fixture('release', ids[1]); await settle();
  // Synthetic conversation in the open session, so the translucent card has text behind it.
  const done = Math.floor(Date.now() / 1000) - 60;
  await fixture('history', ids[1], { items: [{ id: 'u1', type: 'userMessage', turnId: 't1', content: [{ type: 'text', text: NAMES.history[0] }] }, { id: 'a1', type: 'agentMessage', turnId: 't1', text: NAMES.history[1] }],
    turns: [{ id: 't1', status: 'completed', completedAt: done, durationMs: 4200 }] });
  await page.locator('#messages .message-body p').first().waitFor(); await settle();
}

async function behaviour() {
  const record = (await page.evaluate(() => workspace.initial())).sessions.find(s => s.id === ids[0]);
  await step('the card is mounted once, hidden, out of the accessibility tree and the mouse, in the top layer when shown', async () => {
    assert.equal(await card().count(), 1);
    assert.deepEqual(await card().evaluate(el => ({ hidden: el.hidden, aria: el.getAttribute('aria-hidden'), popover: el.getAttribute('popover'), events: getComputedStyle(el).pointerEvents })), { hidden: true, aria: 'true', popover: 'manual', events: 'none' });
  });
  await step('the first card waits about 600 ms, then shows the session facts in the interface language', async () => {
    await away(); const start = Date.now(); await hover(S(ids[0]));
    await delay(250); assert.equal(await shown(), false, 'Not yet at 250 ms');
    await until(shown, 'Card after the delay', 2000); assert.ok(Date.now() - start >= 550, 'Waited the delay: ' + (Date.now() - start));
    const text = await cardText();
    for (const part of [NAMES.sessions[0], t('hover.backend', {}), 'deepseek-v4-pro', NAMES.spaces[0], t('hover.doing', {}), NAMES.queue[0][0].split('\n')[0], FACTS[0][2], t('hover.branch', { branch: FACTS[0][3].branch }), t('hover.time', {})])
      assert.ok(text.includes(part), 'Card shows ' + part);
    for (const hidden of [ids[0], record.nativeId, NAMES.queue[0][0].split('\n')[1]].filter(Boolean)) assert.equal(text.includes(hidden), false, 'Card hides ' + hidden);
    const g = await geometry(S(ids[0])); inside(g, 'wide'); assert.ok(g.left >= g.sidebarRight, 'Beside the sidebar, past its edge');
  });
  await step('while a card is open the next row switches at once; leaving closes it', async () => {
    await hover(S(ids[2])); await until(async () => (await cardText()).includes(NAMES.sessions[2]), 'Switched without the delay', 400);
    await away();
  });
  await step('Escape closes the card and it stays closed until the pointer leaves the row', async () => {
    await hover(S(ids[0])); await until(shown, 'Card', 2000); await page.keyboard.press('Escape');
    await until(async () => !await shown(), 'Escape closes'); await delay(900); assert.equal(await shown(), false, 'Stays closed on the same row');
    await away(); await hover(S(ids[0])); await until(shown, 'Back after leaving', 2000); await away();
  });
  await step('the card never takes a click: the row underneath gets it, and a click or right-click closes the card', async () => {
    await hover(S(ids[1])); await until(shown, 'Card', 2000);
    const through = await page.evaluate(() => { const r = document.getElementById('naw-hover-card').getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return Boolean(hit) && !hit.closest('#naw-hover-card'); });
    assert.equal(through, true, 'Hit-testing passes through the card');
    await page.locator(S(ids[1]) + ' .session-link').click(); await until(async () => !await shown(), 'Click closes');
    assert.equal((await page.evaluate(() => workspace.initial())).viewState.selected, ids[1], 'The click still selects its row');
    await away(); await hover(S(ids[1])); await until(shown, 'Card', 2000);
    await page.locator(S(ids[1])).click({ button: 'right' }); await until(async () => !await shown(), 'Right-click closes');
    await page.locator('.naw-session-menu').waitFor(); await page.keyboard.press('Escape'); await page.locator('.naw-session-menu').waitFor({ state: 'hidden' }); await away().catch(() => {});
  });
  await step('keyboard focus on a row shows the card; moving focus away closes it', async () => {
    await page.mouse.move(700, 5); await page.keyboard.press('Shift');
    const link = page.locator(S(ids[3]) + ' .session-link'); await link.focus();
    await until(async () => await shown() && (await cardText()).includes(NAMES.sessions[3]), 'Focus shows the card', 2000);
    await link.evaluate(el => el.blur()); await until(async () => !await shown(), 'Focus leaving closes');
  });
  await step('a space heading shows its members and open queue', async () => {
    await hover(G(rooms[0])); await until(shown, 'Space card', 2000);
    const text = await cardText(), members = (await page.evaluate(() => workspace.initial())).sessions.filter(s => s.roomIds?.includes(rooms[0])).map(s => s.name);
    assert.ok(members.length >= 2, 'Fixture space has members');
    for (const part of [NAMES.spaces[0], t('hover.members', { count: members.length }), ...members, t('hover.queue', {}), t('hover.queueCounts', { queued: 2, sent: 1, waiting: 1 })]) assert.ok(text.includes(part), 'Space card shows ' + part);
    assert.ok(await card().locator('.hover-card-members li').count() <= 6); inside(await geometry(G(rooms[0])), 'space'); await away();
  });
  await step('narrow window and the rail keep the card inside the window beside its item', async () => {
    await size(850, 600);
    for (const target of [ids[0], ids[5]]) { await rail(false); await reveal(S(target)); await hover(S(target)); await until(shown, 'Narrow card', 2000); inside(await geometry(S(target)), 'narrow ' + target); await away(); }
    await rail(true); await reveal(S(ids[0])); await hover(S(ids[0])); await until(shown, 'Rail card', 2000); const g = await geometry(S(ids[0])); inside(g, 'rail'); assert.ok(g.left >= g.sidebarRight); await away(); await rail(false);
    await size(1240, 820);
  });
}

// Strict worst case: the card wholly over an area as dark (light look) or light (dark look) as the page's main text.
// Live tokens and opacity; primary (--ink) and secondary card text must keep 4.5:1. The orange approval tone is not covered.
async function strictWorst() {
  return card().evaluate(el => {
    const rgb = css => { const c = document.createElement('canvas'); c.width = c.height = 1; const x = c.getContext('2d'); x.fillStyle = css; x.fillRect(0, 0, 1, 1); return [...x.getImageData(0, 0, 1, 1).data].slice(0, 3); };
    const ch = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }, lum = ([r, g, b]) => 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
    const ratio = (a, b) => { const [lo, hi] = [lum(a), lum(b)].sort((p, q) => p - q); return (hi + 0.05) / (lo + 0.05); };
    const style = getComputedStyle(el), raised = rgb(style.getPropertyValue('--raised')), ink = rgb(style.getPropertyValue('--ink')), opacity = parseFloat(style.getPropertyValue('--naw-hover-card-opacity')) / 100;
    const backdrop = raised.map((v, i) => opacity * v + (1 - opacity) * ink[i]), failures = [], ratios = {};
    const primary = el.querySelector('.hover-card-name'), secondary = el.querySelector('dt, .hover-card-status:not([data-tone]), .hover-card-member-state:not([data-tone="approval"]):not([data-tone="working"])');
    if (getComputedStyle(primary).color === getComputedStyle(secondary).color) failures.push('secondary text not found');
    for (const [role, node] of [['primary', primary], ['secondary', secondary]]) {
      const r = ratio(rgb(getComputedStyle(node).color), backdrop); ratios[role] = Math.round(r * 100) / 100; if (r < 4.5) failures.push(role + ' ' + r.toFixed(2));
    }
    return { opacity, raised, ink, backdrop: backdrop.map(Math.round), ratios, failures };
  });
}

async function pictures() {
  const plan = [['wide', 1240, 820, 'session', ids[0], false], ['wide', 1240, 820, 'space', rooms[0], false], ['narrow', 850, 600, 'session', ids[0], false], ['narrow-bottom', 850, 600, 'session', ids[5], false], ['narrow-rail', 850, 600, 'session', ids[0], true]];
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForFunction(dark => document.body.hasAttribute('data-ds-dark-theme') === dark, scheme === 'dark');
    for (const [name, w, h, kind, target, onRail] of plan) {
      await size(w, h); await rail(onRail); await away().catch(() => {});
      const selector = kind === 'session' ? S(target) : G(target); await reveal(selector); await hover(selector); await until(shown, 'Card for picture', 2000); await settle();
      const g = await geometry(selector); inside(g, `${name} ${scheme}`);
      const look = await card().evaluate(el => ({ background: getComputedStyle(el).backgroundColor, backdrop: getComputedStyle(el).backdropFilter, font: getComputedStyle(el).fontSize, name: getComputedStyle(el.querySelector('.hover-card-name')).fontSize }));
      assert.equal(look.backdrop, 'blur(8px)', 'Chosen blur');
      const worst = await strictWorst(); assert.deepEqual(worst.failures, [], `${kind} ${name} ${scheme}: text over the strict worst backdrop ${JSON.stringify(worst)}`);
      const shot = `${kind}-${lang}-${name}-${scheme}`;
      await page.screenshot({ path: path.join(out, shot + '.png') });
      const clip = await page.evaluate(sel => { const r = document.getElementById('naw-hover-card').getBoundingClientRect(), a = document.querySelector(sel).getBoundingClientRect();
        const x = Math.max(0, Math.min(r.left, a.left) - 16), y = Math.max(0, Math.min(r.top, a.top) - 16);
        return { x, y, width: Math.min(innerWidth, Math.max(r.right, a.right) + 16) - x, height: Math.min(innerHeight, Math.max(r.bottom, a.bottom) + 16) - y }; }, selector);
      await page.screenshot({ path: path.join(out, shot + '-card.png'), clip });
      shots.push({ shot, kind, name, scheme, width: w, height: h, geometry: g, look, contrast: worst });
      await away(); await rail(false);
    }
  }
  await page.emulateMedia({ colorScheme: null });
}

const cleanup = scratch.cleanup(async () => { if (app) await app.close(); client?.close(); if (child?.connected) child.disconnect(); if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); });
(async () => {
  try { fs.mkdirSync(slot); } catch (e) { if (e.code !== 'EEXIST') throw e; process.exitCode = 75; console.error('OCCUPIED: no launch/profile'); return; }
  lease = true; fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'sidebar-hover-card test', task: plan.task, token, pid: process.pid, at: new Date().toISOString() }));
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  let counters = null;
  try {
    await launch(); await behaviour(); await pictures();
    counters = await fixture('inspect');
    assert.deepEqual(counters.sends, []); assert.deepEqual(counters.inputs, []); assert.deepEqual(errors, []); assert.deepEqual(await app.evaluate(() => globalThis.hoverGuards), []);
    checks.push('0 sends, 0 native inputs, 0 page errors, 0 OS dialogs'); console.log('PASS 0 sends, 0 native inputs, 0 page errors, 0 OS dialogs');
  } catch (error) { process.exitCode = 1; console.error(error.stack); if (page && !page.isClosed()) await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {}); }
  finally {
    await cleanup();
    if (lease) { assert.equal(JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))).token, token); fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot); }
    const result = { lang, checks, shots, errors, sends: counters?.sends?.length ?? null, inputs: counters?.inputs?.length ?? null, failed: process.exitCode ? 1 : 0, modelCalls: 0, slotReleased: lease, profileRemoved: !profile || !fs.existsSync(profile) };
    fs.writeFileSync(path.join(out, `result-${lang}.json`), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ lang, checks: checks.length, shots: shots.length, errors, failed: result.failed, profileRemoved: result.profileRemoved }));
  }
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
