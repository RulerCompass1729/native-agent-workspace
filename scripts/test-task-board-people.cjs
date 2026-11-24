// Hidden source application and synthetic transport only; no provider calls.
// Many members across three spaces: the header fits its squares with +N, and the open board lists every member in full.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto'), { execFileSync } = require('node:child_process'), { createRequire } = require('node:module');
const code = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '..'), req = createRequire(path.join(code, 'package.json'));
const scratch = req('./scripts/fixtures/test-scratch.cjs'), { _electron } = scratch.playwright(req('playwright'));
const { createSourceEntry } = req('./scripts/fixtures/synthetic-source-boot.cjs'), { connect } = req('./app/service-client.cjs'), { RoomState } = req('./app/room-state.cjs');
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' }).trim();
const slot = process.env.NAW_GUI_TEST_SLOT || path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID();
try { fs.mkdirSync(slot); } catch (e) { if (e.code !== 'EEXIST') throw e; console.error('GUI slot occupied; no launch.'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ token, task: 'task board members synthetic GUI', pid: process.pid }));
let profile, app, child, client, page, sequence = 0;
const checks = [], errors = [], observations = [];
const check = (yes, name) => { console.log(yes ? 'PASS' : 'FAIL', name); assert.ok(yes, name); checks.push(name); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, name) { const end = Date.now() + 15000; while (Date.now() < end) { if (await fn()) return; await wait(50); } throw Error(name); }
const settled = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
const env = more => ({ PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: path.join(profile, 'home'), LANG: 'en_US.UTF-8', ...more });
function fixture(method, target, value) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.off('message', receive); reject(Error('Fixture timeout')); }, 8000);
    const receive = row => { if (row.requestId !== id) return; clearTimeout(timer); child.off('message', receive); row.error ? reject(Error(row.error)) : resolve(row); };
    child.on('message', receive); child.send({ id, method, target, value });
  });
}
const clean = scratch.cleanup(async () => {
  if (app) { await app.close(); app = null; }
  if (client) { for (const s of (await client.call('initial')).sessions) await client.call('stop', s.id); await client.call('shutdown'); client.close(); client = null; }
  if (child) { if (child.connected) child.disconnect(); await until(() => child.exitCode !== null || child.signalCode !== null, 'Owned fixture exit'); }
});
const LONG = '合成审查员 Synthetic reviewer, a deliberately long name to wrap';
// [space, name, state]; null space = outside every space.
const CREW = [
  ...['在做 A', LONG, '在做 C', '等你 D', '卡住 E', '已结束 F', '空闲 G', '空闲 H', '在做 I'].map((n, i) => ['dev', n === LONG ? n : 'Dev ' + n, ['working', 'working', 'working', 'approval', 'disconnected', 'ended', 'idle', 'idle', 'working'][i]]),
  ...['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((n, i) => ['design', 'Design ' + n, ['working', 'idle', 'approval', 'idle', 'working', 'idle', 'disconnected'][i]]),
  ...['A', 'B', 'C', 'D', 'E'].map((n, i) => ['docs', 'Docs ' + n, ['idle', 'working', 'idle', 'idle', 'working'][i]]),
  [null, 'Solo working A', 'working'], [null, 'Solo working B', 'working'], [null, 'Solo question', 'approval'], [null, 'Solo off', 'disconnected'],
];
(async () => { try {
  profile = scratch.directory(path.join(os.tmpdir(), 'naw-b-task-people-')); fs.mkdirSync(path.join(profile, 'home'));
  const work = path.join(profile, 'work'); fs.mkdirSync(work);
  const hook = path.join(profile, 'synthetic.cjs'); fs.writeFileSync(hook, `require(${JSON.stringify(path.join(code, 'scripts/fixtures/collaboration-overview.cjs'))});\n`);
  child = scratch.childProcess.fork(path.join(code, 'app/daemon.cjs'), [profile], { cwd: work, execArgv: ['--require', hook], env: env({ NAW_TEST_APP_ROOT: code, NAW_WORKSPACE: work, NAW_APP_VERSION: req('./package.json').version }), stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Synthetic service boot'); client = await connect(profile, 'task-board-people-gui');
  const state = new RoomState(profile);
  state.update({ name: '示例开发' }, undefined, 'shared');
  const rooms = { dev: 'shared', design: state.create('界面设计'), docs: state.create('资料整理') };
  const ids = [];
  for (const [space, name] of CREW) {
    const id = await client.call('create', { name, provider: ids.length % 2 ? 'claude' : 'codex', cwd: work, view: 'chat' }); ids.push(id);
    if (!space) continue;
    let s;
    await until(async () => { s = (await client.call('initial')).sessions.find(x => x.id === id); return s?.nativeId && !s.nativeContextPending; }, 'Native identity ' + name);
    await client.call('moveMembership', id, rooms[space], { operationId: randomUUID(), nativeId: s.nativeId, revision: s.placementRevision || 0, connectionRevision: s.connectionRevision || 0 });
  }
  for (const [i, [, , s]] of CREW.entries()) if (s !== 'idle') await fixture('state', ids[i], s);
  const now = Date.now(), at = name => ids[CREW.findIndex(c => c[1] === name)];
  const item = (status, text, extra) => ({ id: randomUUID(), status, text, assignee: null, createdAt: now - 3600000, ...extra });
  state.update({ queue: [
    item('sent', 'Synthetic layout pass for the status strip\nsecond line stays out', { sentTo: at('Dev 在做 A'), sentAt: now - 1860000, tag: 'synthetic-tag-a' }),
    item('sent', 'Synthetic review of the merged prototype', { sentTo: at(LONG), sentAt: now - 420000, tag: 'synthetic-tag-b' }),
    item('waiting', 'Synthetic decision: keep the old tab order?', { sentTo: at('Dev 等你 D') }),
    item('waiting', 'Synthetic decision left by a session that has ended', { sentTo: at('Dev 已结束 F') }),
    item('queued', 'Synthetic queued follow-up', { assignee: at('Dev 在做 A') }),
  ] }, undefined, 'shared');
  const entry = createSourceEntry({ profile, code, fixturePid: child.pid }), file = path.join(entry, 'entry.cjs');
  const prefix = `const e=require('electron');e.Notification.isSupported=()=>false;require(${JSON.stringify(path.join(code, 'app/preflight.cjs'))}).preflight=()=>({claude:true,codex:true,python:true,paths:{},configured:{}});for(const k of ['show','showInactive','focus'])e.BrowserWindow.prototype[k]=function(){};for(const k of ['showOpenDialog','showSaveDialog','showMessageBox','showOpenDialogSync','showSaveDialogSync','showMessageBoxSync'])e.dialog[k]=()=>{throw Error('OS dialog forbidden')};e.shell.openExternal=e.shell.openPath=async()=>{throw Error('External open forbidden')};`;
  fs.writeFileSync(file, prefix + '\n' + fs.readFileSync(file, 'utf8'));
  const language = process.env.NAW_TEST_UI_LANGUAGE || 'zh', en = language === 'en';
  app = await _electron.launch({ executablePath: req('electron'), args: [entry], env: env({ NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid), NAW_TEST_VISIBLE: '0', NAW_TEST_UI_LANGUAGE: language }), timeout: 60000 });
  page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', e => { errors.push(e.message); console.error('Synthetic renderer error:', e.stack); });
  await page.locator('#header').waitFor(); await settled();
  const pictures = process.env.NAW_SCREENSHOTS_DIR;
  if (pictures) { assert.ok(!path.resolve(pictures).startsWith(fs.realpathSync(code) + path.sep)); fs.mkdirSync(pictures, { recursive: true }); }
  await req('./scripts/fixtures/default-space.cjs').revealDefaultSpace(page); await page.locator('#room-nav').click();
  await until(async () => await page.locator('#agent-distribution .agent-cell').count() >= 20, 'Header squares for the synthetic crew');
  const listed = CREW.filter(([space, , s]) => space || s !== 'disconnected').length;
  for (const [width, height] of [[1240, 820], [850, 600]]) for (const theme of ['light', 'dark']) {
    await app.evaluate(({ BrowserWindow, nativeTheme }, v) => { BrowserWindow.getAllWindows()[0].setContentSize(v.width, v.height); nativeTheme.themeSource = v.theme; }, { width, height, theme });
    await page.emulateMedia({ colorScheme: theme }); await page.waitForFunction(w => innerWidth === w, width); await settled(); await settled();
    const tag = `${width} ${theme}`;
    const h = await page.evaluate(() => {
      const strip = document.querySelector('#agent-distribution .agent-strip'), more = document.querySelector('#agent-distribution .agent-strip-more');
      const cells = [...document.querySelectorAll('#agent-distribution .agent-cell')];
      return { cells: cells.length, hidden: cells.filter(c => c.hidden).length, more: more && !more.hidden ? more.textContent : null, moreLabel: more?.getAttribute('aria-label'),
        strip: { right: strip.getBoundingClientRect().right, last: cells.filter(c => !c.hidden).pop()?.getBoundingClientRect().right ?? 0 }, overflow: document.documentElement.scrollWidth - innerWidth, dark: document.body.hasAttribute('data-ds-dark-theme') };
    });
    observations.push({ width, theme, header: h });
    check(h.dark === (theme === 'dark') && h.overflow <= 0, `${tag}: correct theme, no document overflow`);
    check(h.strip.last <= h.strip.right + 1, `${tag}: no square is cut at the strip edge`);
    check(h.hidden === 0 ? h.more === null : h.more === '+' + h.hidden && h.moreLabel.includes(String(h.hidden)), `${tag}: squares that do not fit are counted as +N (${h.hidden} of ${h.cells})`);
    if (pictures) await page.screenshot({ scale: 'css', path: path.join(pictures, `${language}-people-${theme}-${width}.png`) });
    await page.locator('.task-board-toggle').click(); await settled();
    const b = await page.evaluate(() => {
      const panel = document.getElementById('task-board-panel'), crew = panel.querySelector('.task-board-people'), list = panel.querySelector('.task-board-list');
      const names = [...crew.querySelectorAll('.task-board-person-name')], p = panel.getBoundingClientRect();
      return { before: Boolean(crew.compareDocumentPosition(panel.querySelector('.task-board-tabs')) & Node.DOCUMENT_POSITION_FOLLOWING),
        people: crew.querySelectorAll('.task-board-person').length, cut: names.filter(n => n.scrollWidth > n.clientWidth + 1).map(n => n.textContent),
        long: names.some(n => n.textContent.includes('deliberately long')), summary: crew.querySelector('.task-board-people-summary').textContent,
        spaces: [...crew.querySelectorAll('[data-people-space]')].map(s => [s.dataset.peopleSpace, s.querySelectorAll('.task-board-person').length]),
        stale: crew.querySelector('.task-board-people-stale:not([hidden])')?.textContent || '', list: list.clientHeight, listMin: Math.min(240, innerHeight * 0.3), crewInner: crew.scrollHeight - crew.clientHeight, text: crew.textContent,
        inside: p.left >= 0 && p.right <= innerWidth + 1 && p.bottom <= innerHeight + 1, crewScroll: crew.scrollWidth - crew.clientWidth,
        missing: [...document.querySelectorAll('#agent-distribution .agent-cell')].map(c => c.dataset.sessionId).filter(id => !crew.querySelector(`[data-person-id="${id}"]`)) };
    });
    observations.push({ width, theme, board: b });
    if (pictures) await page.screenshot({ scale: 'css', path: path.join(pictures, `${language}-people-${theme}-${width}-open.png`) });
    check(b.missing.length === 0, `${tag}: every header square's agent is in the member section (${b.missing.length} missing)`);
    check(b.before && b.inside, `${tag}: the member section opens above the task tabs, inside the viewport`);
    check(b.people === listed && b.long && b.cut.length === 0 && b.crewScroll <= 1, `${tag}: all ${listed} members are listed with whole names (${b.cut.length} cut)`);
    check(!b.text.includes('…') && !/至少|at least/u.test(b.text), `${tag}: no ellipsis or lower bound in the member section`);
    check(b.summary.includes(en ? listed + ' members' : '成员 ' + listed), `${tag}: the summary counts every listed member`);
    check(b.stale.includes(en ? '1 old dispatch' : '旧派单 1 件'), `${tag}: the ended session's decision is an old dispatch in its space`);
    check(b.crewInner <= 1, `${tag}: the member section is fully expanded, no inner scroll (${b.crewInner}px hidden)`);
    check(b.list >= b.listMin - 1, `${tag}: the task list keeps its minimum height (${b.list}px of ${Math.round(b.listMin)}px)`);
    const reach = await page.evaluate(() => { const panel = document.getElementById('task-board-panel'), list = panel.querySelector('.task-board-list');
      panel.scrollTop = panel.scrollHeight; const r = list.getBoundingClientRect(), p = panel.getBoundingClientRect(), shown = Math.min(r.bottom, p.bottom) - Math.max(r.top, p.top);
      const head = panel.querySelector('.task-board-heading').getBoundingClientRect(), people = [...panel.querySelectorAll('.task-board-person')];
      // Park a member just under the sticky heading, then focus it: it must not stay covered.
      const target = people[Math.floor(people.length / 2)], heading = panel.querySelector('.task-board-heading');
      panel.scrollTop = 0; panel.scrollTop = target.getBoundingClientRect().top - panel.getBoundingClientRect().top - 4;
      const parked = target.getBoundingClientRect().top - heading.getBoundingClientRect().bottom;
      target.focus(); const focusTop = target.getBoundingClientRect().top - heading.getBoundingClientRect().bottom;
      panel.scrollTop = 0; return { shown, headTop: head.top - p.top, list: list.clientHeight, focused: document.activeElement === target, parked, focusTop }; });
    check(reach.shown >= reach.list - 2 && Math.abs(reach.headTop) <= 2, `${tag}: scrolling the board shows the whole task list, the heading stays on top (${Math.round(reach.shown)}/${reach.list}px)`);
    check(reach.focused && reach.focusTop >= -1, `${tag}: a member focused under the sticky heading scrolls out from under it (${Math.round(reach.parked)}px → ${Math.round(reach.focusTop)}px)`);
    await page.keyboard.press('Escape'); await settled();
  }
  await page.locator('.task-board-toggle').click();
  await page.locator('.task-board-people-stale').first().click();
  check(await page.locator('[data-board-tab="stale"]').getAttribute('aria-selected') === 'true' && await page.locator('[data-board-tab="stale"]').getAttribute('data-count') === '1', 'The old-dispatch line opens its own tab with one item');
  const opened = await page.evaluate(() => { const panel = document.getElementById('task-board-panel'), row = panel.querySelector('.task-board-entry'), head = panel.querySelector('.task-board-heading').getBoundingClientRect();
    const r = row?.getBoundingClientRect(), p = panel.getBoundingClientRect(); return r ? { top: Math.round(r.top - head.bottom), bottom: Math.round(p.bottom - r.bottom), focus: document.activeElement?.dataset.boardTab || '' } : null; });
  check(opened && opened.top >= -1 && opened.bottom >= -1 && opened.focus === 'stale', `The old dispatch it opens is in view, below the heading, with focus on its tab (${JSON.stringify(opened)})`);
  const queued = await page.locator('#stream-waiting-list [data-waiting-id^="queue:"]').allTextContents();
  check(queued.length === 1 && queued[0].includes('keep the old tab order') && !queued.some(t => t.includes('has ended')), `The header's 等你 list holds the live decision and leaves the old dispatch out (${queued.length} queue rows)`);
  await page.keyboard.press('Escape');
  // Test-only stand-in for a crowded header: cap the strip's room, then give it back.
  const room = width => page.evaluate(w => { document.getElementById('agent-distribution').style.maxWidth = w; }, width);
  const strip = () => page.evaluate(() => { const host = document.getElementById('agent-distribution'), more = host.querySelector('.agent-strip-more'), cells = [...host.querySelectorAll('.agent-cell')];
    const shown = cells.filter(c => !c.hidden), right = host.querySelector('.agent-strip').getBoundingClientRect().right;
    const orphans = [...host.querySelectorAll('.agent-group')].filter(g => !g.hidden && ![...g.querySelectorAll('.agent-cell')].some(c => !c.hidden)).length;
    return { orphans, hidden: cells.length - shown.length, more: more.hidden ? null : more.textContent, label: more.getAttribute('aria-label') || '', inside: (shown.pop()?.getBoundingClientRect().right ?? 0) <= right + 1 }; });
  const settle = async (want, name) => { try { await until(async () => want(await strip()), name); } catch { /* reported by the check */ } return strip(); };
  await room('220px');
  const cut = await settle(x => x.hidden > 0, 'Strip cut');
  if (pictures) await page.screenshot({ scale: 'css', path: path.join(pictures, `${language}-people-plusn.png`) });
  check(cut.hidden > 0 && cut.more === '+' + cut.hidden && cut.label.includes(String(cut.hidden)) && cut.inside, `With less room, the squares that do not fit become +${cut.hidden} and none is half cut`);
  check(cut.orphans === 0, `No group count is left without squares beside +N (${cut.orphans})`);
  await page.locator('#agent-distribution .agent-strip-more').click();
  check(await page.locator('#agent-distribution .agent-strip-panel').isVisible(), '+N opens the full agent list');
  await page.keyboard.press('Escape'); await room('');
  const back = await settle(x => x.hidden === 0 && x.more === null, 'Strip restored');
  check(back.hidden === 0 && back.more === null, `When the room comes back, every square returns and +N goes away (${back.hidden} still hidden)`);
  const hidden = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(w => !w.isVisible() && !w.isFocusable()));
  check(hidden, 'All owned windows remain hidden and unfocusable');
  const stats = await fixture('stats', ids[0]); check(stats.stats.sends === 0 && stats.stats.inputs === 0, 'Zero native input/model sends');
  if (errors.length) console.error('Renderer errors:', JSON.stringify(errors)); check(errors.length === 0, 'No renderer errors');
  if (pictures) fs.writeFileSync(path.join(pictures, language + '-people-results.json'), JSON.stringify({ checks, observations, stats, errors }, null, 2));
  console.log(`SUMMARY ${checks.length} pass / 0 fail / 0 skip`);
} finally { try { await clean(); await scratch.release(); } finally { const owner = JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))); if (owner.token === token) { fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot); } } } })().catch(e => { console.error(e); process.exitCode = 1; });
