const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const scratch = require('./fixtures/test-scratch.cjs'), { _electron } = scratch.playwright(require('playwright'));
const { connect } = require('../app/service-client.cjs'), { createSourceEntry } = require('./fixtures/synthetic-source-boot.cjs');
const code = path.resolve(__dirname, '..'), output = process.env.NAW_EVIDENCE_DIR, pictures = process.env.NAW_PICTURES_DIR;
for (const p of [output, pictures]) { assert.ok(p && path.isAbsolute(p) && !p.startsWith(code + path.sep)); fs.mkdirSync(p, { recursive: true, mode: 0o700 }); }
const slot = process.env.NAW_GUI_TEST_SLOT; assert.ok(slot && path.isAbsolute(slot));
const token = randomUUID(), checks = [], errors = [], blocked = [];
let app, page, client, child, profile, locked = false, sequence = 0;
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label) { const end = Date.now() + 20000; while (Date.now() < end) { if (await fn()) return; await delay(50); } throw Error(label); }
const check = (name, pass) => { assert.ok(pass, name); checks.push(name); console.log('PASS', name); };
const fixture = (method, target) => new Promise((resolve, reject) => {
  const id = ++sequence, timer = setTimeout(() => { child.off('message', cb); reject(Error('Fixture timeout')); }, 8000);
  const cb = r => { if (r.requestId === id) { clearTimeout(timer); child.off('message', cb); resolve(r); } }; child.on('message', cb); child.send({ id, method, target });
});
const env = extra => ({ PATH: process.env.PATH, HOME: path.join(profile, 'home'), TMPDIR: process.env.TMPDIR, LANG: 'en_US.UTF-8', TZ: 'America/Los_Angeles', ...extra });
const clean = scratch.cleanup(async () => {
  if (app) { await app.close(); app = null; }
  if (client) { for (const s of (await client.call('initial')).sessions) await client.call('stop', s.id); await client.call('shutdown'); client.close(); client = null; }
  if (child) { if (child.connected) child.disconnect(); await until(() => child.exitCode !== null || child.signalCode !== null, 'Owned fixture exits'); }
});
(async () => { try {
  const deadline = Date.now() + 8 * 60000;
  while (!locked) { try { fs.mkdirSync(slot); locked = true; } catch (e) { if (e.code !== 'EEXIST' || Date.now() >= deadline) throw e; console.log('GUI slot occupied; wait30s'); await delay(30000); } }
  fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ token, pid: process.pid, task: 'regular popup offline GUI', started: new Date().toISOString() }));
  profile = scratch.directory(path.join(os.tmpdir(), 'naw-discoveries-gui-')); fs.mkdirSync(path.join(profile, 'home'));
  const work = path.join(profile, 'work'); fs.mkdirSync(work);
  child = scratch.childProcess.fork(path.join(code, 'app/daemon.cjs'), [profile], { cwd: work, execArgv: ['--require', path.join(code, 'scripts/fixtures/collaboration-overview.cjs')], env: env({ NAW_TEST_APP_ROOT: code, NAW_WORKSPACE: work, NAW_APP_VERSION: require('../package.json').version }), stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Synthetic service boot');
  client = await connect(profile, 'regular-popup-test');
  const id = await client.call('create', { provider: 'claude', name: 'Claude · 合成示例', cwd: work, view: 'chat' });
  const entry = createSourceEntry({ profile, code, fixturePid: child.pid }), file = path.join(entry, 'entry.cjs');
  const prefix = `const e=require('electron');e.Notification.isSupported=()=>false;require(${JSON.stringify(path.join(code, 'app/preflight.cjs'))}).preflight=()=>({claude:true,codex:true,python:true,paths:{},configured:{}});for(const k of ['show','showInactive','focus'])e.BrowserWindow.prototype[k]=function(){};for(const k of ['showOpenDialog','showSaveDialog','showMessageBox','showOpenDialogSync','showSaveDialogSync','showMessageBoxSync'])e.dialog[k]=()=>{throw Error('OS dialog forbidden')};e.shell.openExternal=e.shell.openPath=async()=>{throw Error('External open forbidden')};
  const m=require(${JSON.stringify(path.join(code, 'app/regular-popup.cjs'))}),original=m.create;m.create=options=>{const engine=original(options),stats={source:0,selection:0,notices:[],realCalls:0};globalThis.discoveryTest={engine,stats,pricingError(){const p=require(${JSON.stringify(path.join(code, 'app/regular-popup-dsh.cjs'))}),previous=p.pricingQualified;p.pricingQualified=()=>false;try{p.assertPricingQualified();}catch(error){return error;}finally{p.pricingQualified=previous;}},arm(){engine.permitted=true;engine.now=()=>new Date(2026,10,18,10).getTime();engine.readSource=async()=>{stats.source++;await new Promise(resolve=>globalThis.discoveryTest.release=resolve);return[{id:'fixture-one',title:'demo/local-notes',description:'A synthetic local-first project',url:'https://github.com/demo/local-notes'},{id:'fixture-two',title:'demo/agent-tests',description:'A synthetic agent test fixture',url:'https://github.com/demo/agent-tests'}]};engine.select=async payload=>{stats.selection++;stats.payload=payload;return{picks:[{id:'fixture-one',why:'本地优先的资料整理方式，适合你关注的离线工作流。'},{id:'fixture-two',why:'可借鉴它的合成测试思路，检查 agent 的失败恢复。'}],costMicros:1200}};engine.notify=value=>stats.notices.push(value);}};return engine;};globalThis.fetch=()=>{globalThis.discoveryTest.stats.realCalls++;throw Error('Real fetch forbidden')};`;
  fs.writeFileSync(file, `require(${JSON.stringify(path.join(code, 'app/regular-popup-transport.cjs'))}).createTransport=()=>{throw Error('Real transport forbidden in GUI')};` + prefix + fs.readFileSync(file, 'utf8'));
  app = await _electron.launch({ executablePath: require('electron'), args: [entry], env: env({ NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid), NAW_TEST_VISIBLE: '0', NAW_TEST_UI_LANGUAGE: 'zh' }), timeout: 60000 });
  page = await app.firstWindow(); page.setDefaultTimeout(12000); page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => { const u = new URL(route.request().url()); if (u.protocol === 'file:' || ['127.0.0.1', 'localhost'].includes(u.hostname)) return route.continue(); blocked.push(u.hostname); return route.abort(); });
  await page.locator('#discoveries-button').waitFor();
  check('all windows stay hidden', await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(w => !w.isVisible() && !w.isFocused())));
  await page.locator('#discoveries-button').click();
  check('one enabled opt-in button starts off', !await page.locator('.discoveries-activate').isDisabled() && await page.locator('.discoveries-activate').textContent() === '启用' && await page.locator('.discoveries-dialog input[type=checkbox]').count() === 0);
  check('production is off and outbound disclosure is visible', (await page.locator('#discoveries-status').textContent()).includes('关闭') && (await page.locator('.discoveries-privacy').textContent()).includes('DeepSeek'));
  await page.screenshot({ path: path.join(pictures, 'default-off.png'), scale: 'css' });
  await page.locator('.discoveries-dialog>header button').click();
  await app.evaluate(() => discoveryTest.arm());
  await page.locator('#discoveries-button').click();
  await page.locator('#discoveries-concern').fill('我关注本地优先工具和 agent 测试。'); await page.locator('#discoveries-time').fill('09:00');
  await page.locator('.discoveries-activate').click();
  await until(() => app.evaluate(() => discoveryTest.stats.source === 1), 'Fixture source requested by scheduled timer');
  await page.locator('.discoveries-dialog>header button').click();
  await page.locator(`.session-link[data-session-id="${id}"]`).first().click();
  if (!((await page.locator('#chat-tab').getAttribute('class')) || '').includes('active')) await page.locator('#chat-tab').click();
  if (await page.locator('#send-button').textContent() === '接管此窗口') await page.locator('#send-button').click();
  await page.locator('#message-input').fill('这份未发送的合成草稿必须保留。'); await page.locator('#message-input').focus();
  await app.evaluate(() => discoveryTest.release());
  await page.locator('.discoveries-popup:popover-open').waitFor();
  check('built UI includes the picked count and original source', await page.locator('#discoveries-popup-title').textContent() === '今天替你挑了2项' && await page.locator('.discoveries-source').textContent() === 'GitHub Trending');
  check('arrival retains genuine composer focus and draft', await page.locator('#message-input').evaluate(e => document.activeElement === e && e.value === '这份未发送的合成草稿必须保留。'));
  check('two reasons and only source links', await page.locator('.discoveries-popup article').count() === 2 && await page.locator('.discoveries-popup .discoveries-why').count() === 2 && await page.locator('.discoveries-popup a').evaluateAll(links => links.every(a => a.href.startsWith('https://github.com/demo/'))));
  await page.locator('#discoveries-button').click();
  await page.locator('#discoveries-concern').fill('正在修改的兴趣草稿'); await page.locator('#discoveries-concern').focus();
  await app.evaluate(() => discoveryTest.engine.changed(discoveryTest.engine.status(), true)); await delay(100);
  check('arrival defers behind a modal and preserves its unsaved draft', await page.locator('.discoveries-popup').isHidden() && await page.locator('#discoveries-concern').evaluate(e => document.activeElement === e && e.value === '正在修改的兴趣草稿'));
  await page.locator('.discoveries-dialog>header button').click(); await page.locator('.discoveries-popup:popover-open').waitFor();
  check('deferred card appears after the modal closes', await page.locator('.discoveries-popup article').count() === 2);
  const measurements = [];
  for (const [width, height] of [[1240, 820], [850, 600]]) for (const theme of ['light', 'dark']) {
    await app.evaluate(({ BrowserWindow, nativeTheme }, { width, height, theme }) => { nativeTheme.themeSource = theme; BrowserWindow.getAllWindows()[0].setContentSize(width, height); }, { width, height, theme });
    await page.emulateMedia({ colorScheme: theme });
    await page.evaluate(() => document.fonts.ready); await delay(100);
    const m = await page.locator('.discoveries-popup').evaluate(e => {
      const r = e.getBoundingClientRect(), background = getComputedStyle(e).backgroundColor, linkColor = getComputedStyle(e.querySelector('a')).color;
      const luminance = color => { const rgb = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => color.startsWith('color(') ? v : v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4); return rgb.reduce((n, v, i) => n + v * [.2126, .7152, .0722][i], 0); };
      const a = luminance(background), b = luminance(linkColor);
      return { left: r.left, right: r.right, bottom: r.bottom, viewport: innerWidth, background, linkColor, linkContrast: (Math.max(a, b) + .05) / (Math.min(a, b) + .05), overflow: e.scrollWidth - e.clientWidth, minFont: Math.min(...[...e.querySelectorAll('p,a,button')].map(n => parseFloat(getComputedStyle(n).fontSize))) };
    });
    console.log('MEASURE', JSON.stringify({ width, height, theme, ...m }));
    check(`${theme}/${width} readable, contained card`, m.left >= 0 && m.right <= width && m.bottom <= height && m.overflow === 0 && m.minFont >= 12 && m.linkContrast >= 4.5); measurements.push({ width, height, theme, ...m });
    await page.screenshot({ path: path.join(pictures, `a-${theme}-${width}x${height}.png`), scale: 'css' });
  }
  check('dark and light use different actual palettes', measurements[0].background !== measurements[1].background);
  await page.locator('.discoveries-popup [data-label=read]').first().click();
  check('read clears one unread without another source call', await page.locator('#discoveries-badge').textContent() === '1' && await page.locator('.discoveries-popup article').count() === 1);
  await page.locator('.discoveries-popup [data-label=ignore]').first().click();
  check('ignore hides card and keeps history', await page.locator('.discoveries-popup').isHidden() && await page.locator('#discoveries-badge').textContent() === '');
  await page.locator('#discoveries-button').click(); check('history retains local read and ignored flags', await page.locator('.discoveries-history [data-read=true]').count() === 1 && await page.locator('.discoveries-history [data-ignored=true]').count() === 1);
  await app.evaluate(async () => {
    const RegularPopup = discoveryTest.engine.constructor; let at = new Date(2026, 10, 18, 23, 59).getTime(), release;
    const f = new RegularPopup({ store: { read: () => null, write() {} }, now: () => at, permitted: true,
      readSource: () => new Promise(resolve => release = resolve), select: async () => { throw Error('Synthetic unknown usage'); } });
    f.configure({ enabled: true, concern: 'tools', time: '00:00' }); const pending = f.tick(); at += 180000;
    release([{ id: 'x', title: 'fixture', description: 'public', url: 'https://github.com/example/tool' }]); await pending;
    discoveryTest.budgetFixture = f; discoveryTest.engine.changed(f.status(), false);
  });
  await page.waitForFunction(() => document.querySelector('.discoveries-run-note').textContent.startsWith('2026-11-19'));
  check('history labels the execution budget date rather than the earlier source period', (await page.locator('.discoveries-run-note').textContent()).startsWith('2026-11-19'));
  await app.evaluate(async () => { const f = discoveryTest.budgetFixture; await f.tick(); discoveryTest.engine.changed(f.status(), false); f.dispose(); });
  await page.waitForFunction(() => document.querySelector('.discoveries-run-note').textContent.includes('今日因预算未确认跳过'));
  check('history makes the unconfirmed-budget skip and reservation visible', (await page.locator('.discoveries-run-note').textContent()).includes('0.007000'));
  await page.screenshot({ path: path.join(pictures, 'budget-unconfirmed-history.png'), scale: 'css' });
  await app.evaluate(async () => {
    const e = new discoveryTest.engine.constructor({ store: { read: () => null, write() {} }, permitted: true,
      readSource: async () => [{ id: 'x', title: 'Public fixture', description: 'public', url: 'https://github.com/demo/tool' }], select: async () => { throw discoveryTest.pricingError(); } });
    e.configure({ enabled: true, concern: 'tools', time: '00:00' }); await e.tick(); discoveryTest.engine.changed(e.status(), false); e.dispose();
  });
  await page.waitForFunction(() => document.querySelector('#discoveries-status').textContent.includes('费率尚未核定'));
  check('unqualified rates show a distinct pause with no unspent reservation', (await page.locator('.discoveries-run-note').textContent()).includes('0.000000') && !(await page.locator('#discoveries-status').textContent()).includes('未确认'));
  await page.screenshot({ path: path.join(pictures, 'pricing-paused.png'), scale: 'css' });
  await app.evaluate(async () => {
    const e = new discoveryTest.engine.constructor({ store: { read: () => null, write() {} }, permitted: true, now: () => Date.parse('2027-01-01T12:00:00Z'),
      readSource: async () => [{ id: 'x', title: 'Public fixture', description: 'public', url: 'https://github.com/demo/tool' }],
      select: async () => ({ picks: [], costMicros: 421, usage: { inputTokens: 1000, cachedInputTokens: 100, outputTokens: 100, totalTokens: 1200, providerAt: Date.parse('2027-01-01T12:00:00Z'), tier: 'peak-bound' } }) });
    e.configure({ enabled: true, concern: 'tools', time: '00:00' }); await e.tick(); discoveryTest.engine.changed(e.status(), false); e.dispose();
  });
  await page.waitForFunction(() => document.querySelector('.discoveries-run-note').textContent.includes('高峰价上界估算'));
  check('unknown calendar accounting is labelled as an upper estimate', (await page.locator('.discoveries-run-note').textContent()).includes('0.000421'));
  await page.screenshot({ path: path.join(pictures, 'peak-upper-bound.png'), scale: 'css' });
  const stats = await app.evaluate(() => discoveryTest.stats);
  check('primary fixture selects once with count-only notification; zero real calls', stats.source === 1 && stats.selection === 1 && stats.realCalls === 0 && JSON.stringify(stats.notices) === '[{"count":2}]');
  check('selector receives no URLs or session data', Object.keys(stats.payload).sort().join() === 'candidates,concern' && stats.payload.candidates.every(c => Object.keys(c).sort().join() === 'description,id,title'));
  check('zero native inputs or sends', (await fixture('screen', id)).stats.inputs === 0 && (await fixture('screen', id)).stats.sends === 0);
  check('no page errors or outbound renderer requests', errors.length === 0 && blocked.length === 0);
  fs.writeFileSync(path.join(output, 'gui-results.json'), JSON.stringify({ checks, errors, blocked, stats, measurements }, null, 2));
  console.log(`GUI ${checks.length}/0/0`);
} catch (e) { console.error(e.stack); process.exitCode = 1; if (page) await page.screenshot({ path: path.join(pictures, 'failure.png') }).catch(() => {}); }
finally { try { await clean(); } finally { if (locked && JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))).token === token) { fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot); } } }
})();
