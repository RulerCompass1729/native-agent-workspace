// Hidden source Electron + synthetic service only; no provider or daily profile.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const code = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '..'), req = createRequire(path.join(code, 'package.json'));
const pictures = process.env.NAW_SCREENSHOTS_DIR, language = process.env.NAW_TEST_UI_LANGUAGE || 'zh';
if (pictures) {
  let parent = path.resolve(pictures); while (!fs.existsSync(parent)) parent = path.dirname(parent);
  const real = path.join(fs.realpathSync(parent), path.relative(parent, path.resolve(pictures)));
  const source = fs.realpathSync(code);
  assert.ok(real !== source && !real.startsWith(source + path.sep), 'Screenshots must stay outside source');
  fs.mkdirSync(pictures, { recursive: true, mode: 0o700 });
}
const scratch = req('./scripts/fixtures/test-scratch.cjs');
const { _electron } = scratch.playwright(req('playwright'));
const { createSourceEntry } = req('./scripts/fixtures/synthetic-source-boot.cjs');
const { revealDefaultSpace } = req('./scripts/fixtures/default-space.cjs');
const { connect } = req('./app/service-client.cjs'), spaces = req('./app/collaboration-spaces.cjs');
const delay = ms => new Promise(r => setTimeout(r, ms)), checks = [], errors = [], observed = {}, shots = [];
const failures = [];
const check = (condition, text) => { (condition ? checks : failures).push(text); console.log(condition ? 'PASS' : 'FAIL', text); };
let child, app, page, client, profile, sequence = 0;
const benign = new Set(['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'SHELL', 'TZ', 'TERM', 'NAW_TEST_UI_LANGUAGE']);
const env = more => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => benign.has(k))), HOME: path.join(profile, 'home'), ...more });
async function until(fn, label, limit = 12000) { const end = Date.now() + limit; while (Date.now() < end) { if (await fn()) return; await delay(40); } throw Error(label); }
function fixture(method, target, value) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const receive = x => { if (x.requestId !== id) return; clearTimeout(timer); child.off('message', receive); x.error ? reject(Error(x.error)) : resolve(x); };
    const timer = setTimeout(() => { child.off('message', receive); reject(Error('Fixture timeout: ' + method)); }, 8000);
    child.on('message', receive); child.send({ id, method, target, value });
  });
}
const settled = async p => { await p.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))); await delay(120); };
const snapshot = () => page.evaluate(() => workspace.initial());
const hiddenWindows = async () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ visible: w.isVisible(), focusable: w.isFocusable() })));
async function size(width, height) { await app.evaluate(({ BrowserWindow }, s) => BrowserWindow.fromId(s.id).setContentSize(s.width, s.height), { id: observed.mainWindowId, width, height }); await settled(page); }
async function capture(name) { if (!pictures) return; const file = path.join(pictures, language + '-' + name + '.png'); await page.mouse.move(2, 2); await page.screenshot({ path: file }); shots.push(file); }
async function checkEntryContrast(selector, context, width, expected) {
  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme }); await settled(page); await delay(200);
    await page.mouse.move(2, 2);
    const values = await page.locator(selector).evaluateAll(xs => xs.map(x => {
      const rgba = value => {
        if (!/^rgba?\(/.test(value)) throw Error('Unsupported computed color: ' + value);
        const channels = value.match(/[\d.]+/g).map(Number);
        return [...channels.slice(0, 3), channels[3] ?? 1];
      };
      let background, layer = x;
      while (layer) {
        const color = rgba(getComputedStyle(layer).backgroundColor);
        if (color[3] === 1) { background = color; break; }
        if (color[3] !== 0) throw Error('Contrast fixture requires an opaque background');
        layer = layer.parentElement;
      }
      if (!background) throw Error('No opaque navigation background');
      const style = getComputedStyle(x), foreground = rgba(style.color);
      const luminance = color => color.slice(0, 3).map(v => {
        v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
      const a = luminance(foreground), b = luminance(background);
      return { foreground, background, contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
        dark: b < 0.5, opaqueText: foreground[3] === 1, button: x.tagName === 'BUTTON',
        underlined: style.textDecorationLine.includes('underline'), visible: Boolean(x.getClientRects().length) };
    }));
    check(values.length === expected && values.every(v => v.visible && v.opaqueText && v.dark === (theme === 'dark') && v.contrast >= 4.5), `${context} text contrast >=4.5 in ${theme} at ${width}px`);
    check(values.every(v => v.button && (context !== 'grid' || v.underlined)), `${context} keeps native buttons and existing underline in ${theme}`);
    console.log('CONTRAST', JSON.stringify({ context, theme, width, values }));
    (observed.contrast ||= []).push({ context, theme, width, values });
    await capture(`${context}-${theme}-${width}`);
  }
  await page.emulateMedia({ colorScheme: 'light' }); await settled(page);
}
const clean = scratch.cleanup(async () => {
  if (app) { await app.close(); app = null; }
  if (client) { for (const s of (await client.call('initial')).sessions) await client.call('stop', s.id); await client.call('shutdown'); client.close(); client = null; }
  if (child) { if (child.connected) child.disconnect(); await until(() => child.exitCode !== null || child.signalCode !== null, 'Owned fixture exit', 15000); }
});
(async () => {
  try {
    profile = scratch.directory(path.join(os.tmpdir(), 'naw-space-nav-'));
    fs.mkdirSync(path.join(profile, 'home'), { mode: 0o700 });
    const work = path.join(profile, 'synthetic-work'); fs.mkdirSync(work, { mode: 0o700 });
    const fixtureFile = path.join(profile, 'nav-fixture.cjs');
    fs.writeFileSync(fixtureFile, `require(${JSON.stringify(path.join(code, 'scripts/fixtures/collaboration-overview.cjs'))});\n`);
    child = scratch.childProcess.fork(path.join(code, 'app/daemon.cjs'), [profile], { cwd: work, execArgv: ['--require', fixtureFile], env: env({ NAW_TEST_APP_ROOT: code, NAW_WORKSPACE: work, NAW_APP_VERSION: req('./package.json').version }), stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Synthetic daemon boot'); client = await connect(profile, 'space-navigation-test');
    const ids = [];
    for (const [name, provider] of [['Codex 甲', 'codex'], ['Claude 乙', 'claude'], ['Codex 丙', 'codex']]) { const id = await client.call('create', { name, provider, cwd: work, view: 'chat' }); await client.call('join', id, true); ids.push(id); }
    for (const [i, id] of ids.entries()) for (let n = 0; n < 28; n++) await fixture('nativeBlock', id, { id: `synthetic-nav-${i}-${n}`, kind: 'response', turnId: 'synthetic-turn-' + n, status: 'complete', text: '【合成内容】导航示例 ' + n + '\n\n核对返回空间与单独打开同一会话。\n\n保留阅读位置及未发送的草稿。' });
    await client.call('draft', ids[0], '【未发送示例】请继续说明第二项。');
    const initial = await client.call('initial'), nativeIds = initial.sessions.map(s => [s.id, s.nativeId]);
    const entry = createSourceEntry({ profile, code, fixturePid: child.pid }), entryFile = path.join(entry, 'entry.cjs');
    const prefix = `const e=require('electron');e.nativeTheme.themeSource='light';e.Notification.isSupported=()=>false;require(${JSON.stringify(path.join(code,'app/preflight.cjs'))}).preflight=()=>({claude:true,codex:true,python:true,paths:{},configured:{}});for(const k of ['show','showInactive','focus'])e.BrowserWindow.prototype[k]=function(){};for(const k of ['showOpenDialog','showSaveDialog','showMessageBox','showOpenDialogSync','showSaveDialogSync','showMessageBoxSync'])e.dialog[k]=()=>{throw Error('OS dialogs prohibited in navigation prototype')};e.shell.openExternal=e.shell.openPath=async()=>{throw Error('External open prohibited')};\n`;
    fs.writeFileSync(entryFile, prefix + fs.readFileSync(entryFile, 'utf8'));
    app = await _electron.launch({ executablePath: req('electron'), args: [entry], env: env({ NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid), NAW_TEST_VISIBLE: '0', NAW_TEST_UI_LANGUAGE: language }), timeout: 60000 });
    page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
    await page.locator('#room-nav').waitFor(); observed.mainWindowId = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].id);
    check((await hiddenWindows()).every(w => !w.visible && !w.focusable), 'Real source app is hidden and unfocusable');
    await revealDefaultSpace(page);
    await size(1240, 820); await page.locator('#room-nav').click(); await page.locator('#collaboration-overview').waitFor(); await settled(page);
    check(await page.locator('.collaboration-member-status').count() === 3, 'Synthetic space renders three members');

    const labels = language === 'zh' ? { back: '← 返回共同工作', solo: '单独打开会话 ↗', remove: '移出当前空间', list: '列表', grid: '网格' }
      : { back: '← Back to Working together', solo: 'Open session separately ↗', remove: 'Remove from current space', list: 'List', grid: 'Grid' };
    // Space names are person content: make this synthetic one deterministic in both locales.
    const spaceLabel = await page.locator('#title').innerText();
    labels.back = language === 'zh' ? '← 返回' + spaceLabel : '← Back to ' + spaceLabel;
    const head = id => page.locator(`.collaboration-member-status[data-member-id="${id}"]`);
    const member = head(ids[0]).locator('.collaboration-member-name');
    const identity = s => s.sessions.map(x => [x.id, x.nativeId, spaces.isMember(x, 'shared')]).sort();
    const original = identity(initial);
    const draft = () => client.call('initial').then(s => { const a = s.sessions.find(x => x.id === ids[0]); return a.liveDraft ?? a.draft; });
    const originalDraft = await draft();
    check(originalDraft === '【未发送示例】请继续说明第二项。', 'Fixture contains a nonempty exact draft');
    async function solo(button) {
      const waiting = app.waitForEvent('window'); await button.click();
      const extra = await waiting; extra.setDefaultTimeout(10000); extra.on('pageerror', e => errors.push(e.message));
      await extra.locator('#messages').waitFor(); await settled(extra);
      check(await extra.evaluate(async id => (await workspace.initial()).viewState.selected === id, ids[0]), 'Separate window selects the exact original session ID');
      check(await extra.locator('#title').innerText() === 'Codex 甲', 'Separate window shows the same selected session');
      check(JSON.stringify(identity(await client.call('initial'))) === JSON.stringify(original), 'Separate window preserves native IDs and all memberships');
      check((await hiddenWindows()).every(w => !w.visible && !w.focusable), 'All windows stay hidden and unfocusable');
      await extra.close(); await settled(page);
    }
    for (const width of [1240, 850]) {
      await size(width, width === 1240 ? 820 : 600);
      for (const label of [labels.list, labels.grid]) {
        await page.locator('.collaboration-layout-controls').getByRole('button', { name: label, exact: true }).click(); await settled(page);
        const nav = await page.evaluate(() => ({ pressed: document.querySelector('#room-overview').getAttribute('aria-pressed'), current: document.querySelector('#room-overview').getAttribute('aria-current'), selected: [...document.querySelectorAll('.collaboration-layout-controls [aria-pressed="true"]')].map(x => x.textContent.trim()) }));
        check(nav.pressed === null && nav.current === 'page' && nav.selected.length === 1 && nav.selected[0] === label, `Neutral location and exactly one selected ${label} layout at ${width}px`);
      }
      const names = await page.locator('.collaboration-name-text').evaluateAll(xs => xs.filter(x => x.closest('.collaboration-member-status')).map(x => ({ text: x.textContent, w: x.clientWidth, scroll: x.scrollWidth })));
      check(names.length === 3 && names.every(x => x.w >= 45 && x.scroll <= x.w + 1), `Member names remain complete at ${width}px`);
      check(await member.evaluate(x => ['none', 'normal', '""'].includes(getComputedStyle(x, '::after').content)), 'Member names have no decorative separate-window arrow');
      const open = head(ids[0]).locator('.collaboration-member-open');
      check(await open.isVisible(), `Grid second-row separate-window control visible at ${width}px`);
      await checkEntryContrast('.collaboration-member-open', 'grid', width, 3);
      if (await open.isVisible()) {
        const secondRow = await head(ids[0]).evaluate(x => x.querySelector('.collaboration-member-open').getBoundingClientRect().top >= x.querySelector('.collaboration-member-heading').getBoundingClientRect().bottom - 1);
        check(secondRow, 'Separate-window control is on the second header row');
        if (width === 1240) await solo(open);
      }
      await capture('grid-' + width);
      const floors = await page.locator('.collaboration-member-reader').evaluateAll(xs => xs.map(x => ({
        messages: x.querySelector('.messages').getBoundingClientRect().height,
        terminal: x.querySelector('.column-native-host')?.getBoundingClientRect().height,
        input: x.querySelector('.session-message-input')?.getBoundingClientRect().height,
      })));
      check(floors.every(x => x.messages >= 79.5 && x.terminal >= 63.5 && x.input >= 39.5), `Conversation, terminal and input floors survive the new header at ${width}px`);
      (observed.floors ||= []).push({ width, floors });
      const messages = page.locator(`.collaboration-member-reader[data-member-id="${ids[0]}"] .collaboration-messages`);
      await messages.evaluate(x => { x.scrollTop = 180; }); await settled(page);
      const scroll = await messages.evaluate(x => x.scrollTop);
      check(scroll >= 100, 'Fixture has a real scrolled member conversation');
      await member.click(); await page.locator('#messages').waitFor(); await settled(page);
      check((await hiddenWindows()).length === 1, 'Name click focuses inside the existing space');
      check(await page.locator('#title').innerText() === 'Codex 甲', 'Focused title is the member name');
      check((await page.locator('#subtitle').innerText()).includes(spaceLabel), 'Focused subtitle retains the space relationship');
      const back = page.locator('#room-overview');
      check(await back.isVisible() && await back.innerText() === labels.back, `Explicit return-to-space control visible at ${width}px`);
      check(await page.locator('#session-header-more').isVisible(), `More menu visible at ${width}px`);
      check(await page.locator('#header-actions').getByRole('button', { name: labels.remove, exact: true }).count() === 0, 'Remove action is absent from the visible header');
      if (await page.locator('#session-header-more').isVisible()) {
        await page.locator('#session-header-more').click();
        check(await page.getByRole('menuitem', { name: labels.remove, exact: true }).isVisible(), 'Remove from current space is available only inside More');
        await capture('focus-menu-' + width); await page.keyboard.press('Escape');
      }
      const focusedOpen = page.locator('#member-open-session');
      check(await focusedOpen.isVisible(), `Focused separate-window control visible at ${width}px`);
      await checkEntryContrast('#member-open-session', 'focus', width, 1);
      if (width === 1240 && await focusedOpen.isVisible()) await solo(focusedOpen);
      await capture('focus-' + width);
      if (width === 850) { await back.focus(); await page.keyboard.press('Enter'); } else await back.click();
      await page.locator('#collaboration-overview').waitFor(); await settled(page);
      check(await member.evaluate(x => document.activeElement === x), 'Returning restores focus to the originating member heading');
      const afterScroll = await messages.evaluate(x => x.scrollTop);
      check(Math.abs(afterScroll - scroll) <= 2, `Returning restores member reading position (${scroll} → ${afterScroll})`);
      check(await draft() === originalDraft, 'Navigation preserves the unsent draft byte for byte');
    }
    check(JSON.stringify(identity(await client.call('initial'))) === JSON.stringify(original), 'Every navigation keeps membership and native identity unchanged');
    // More members than fit on screen: returning must restore the horizontal
    // strip as well as the conversation's own reading position.
    let last;
    for (const name of ['成员 丁', '成员 戊', '成员 己']) {
      last = await client.call('create', { name, provider: 'codex', cwd: work, view: 'chat' });
      await client.call('join', last, true);
    }
    const lastName = head(last).locator('.collaboration-member-name');
    await lastName.waitFor(); await settled(page);
    const scroller = page.locator('.collaboration-readers');
    await scroller.evaluate(x => { x.scrollLeft = x.scrollWidth - x.clientWidth; }); await settled(page);
    const left = await scroller.evaluate(x => x.scrollLeft);
    check(left >= 100, 'Six-member fixture has a horizontally scrolled strip');
    await lastName.click(); await page.locator('#messages').waitFor(); await settled(page);
    await page.locator('#room-overview').click(); await page.locator('#collaboration-overview').waitFor(); await settled(page);
    const restoredLeft = await scroller.evaluate(x => x.scrollLeft);
    check(Math.abs(restoredLeft - left) <= 2, `Returning restores the member-strip scroll position (${left} → ${restoredLeft})`);
    check(await lastName.evaluate(x => document.activeElement === x), 'Returning restores focus to an offscreen-origin member heading');
    const stats = await fixture('stats', ids[0]);
    check(stats.stats.inputs === 0 && stats.stats.sends === 0, 'Navigation emits no native input or model send');
    check(errors.length === 0, 'No renderer page errors: ' + JSON.stringify(errors));
    observed.checks = checks.length; observed.failures = failures; observed.errors = errors; observed.stats = stats;
    if (pictures) fs.writeFileSync(path.join(pictures, language + '-results.json'), JSON.stringify(observed, null, 2));
    console.log(`RESULT ${checks.length} pass / ${failures.length} fail / ${errors.length} page errors`);
    assert.equal(failures.length, 0, failures.join('\n'));
  } finally { await clean(); await scratch.release(); console.log('CLEANUP owned app, daemon and profile released'); }
})().catch(error => { console.error(error); process.exitCode = 1; });
