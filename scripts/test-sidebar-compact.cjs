// Production renderer + CSS in one hidden source window. Only native IO and
// display facts are synthetic; no row DOM or product stylesheet is injected.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const scratch = require('./fixtures/test-scratch.cjs');
const { _electron } = scratch.playwright(require('playwright'));
const { createSourceEntry } = require('./fixtures/synthetic-source-boot.cjs');
const root = path.resolve(__dirname, '..'), evidence = process.env.NAW_EVIDENCE_DIR;
const pictures = process.env.NAW_SCREENSHOTS_DIR, slot = process.env.NAW_GUI_SLOT;
assert.ok(evidence && pictures && slot && process.env.NAW_VENDOR_ICONS_DIR);
fs.mkdirSync(evidence, { recursive: true }); fs.mkdirSync(pictures, { recursive: true });
const token = randomUUID();
try { fs.mkdirSync(slot); } catch (e) { if (e.code !== 'EEXIST') throw e; process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ token, owner: 'Codex E', task: 'U02 three-line spacing', pid: process.pid }));
function releaseSlot() {
  try { if (JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))).token === token) fs.rmSync(slot, { recursive: true }); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
}
process.once('exit', releaseSlot);
const profile = scratch.directory(path.join(os.tmpdir(), 'naw-sidebar-compact-'));
const cwd = path.join(profile, 'work'); fs.mkdirSync(cwd); fs.mkdirSync(path.join(profile, 'vendor-icons'));
for (const name of ['anthropic', 'openai', 'deepseek']) fs.copyFileSync(path.join(process.env.NAW_VENDOR_ICONS_DIR, name + '.png'), path.join(profile, 'vendor-icons', name + '.png'));
const child = scratch.childProcess.fork(path.join(root, 'app/daemon.cjs'), [profile], {
  execArgv: ['--require', path.join(__dirname, 'fixtures/vendor-icon-native.cjs')],
  env: { ...process.env, NAW_TEST_APP_ROOT: root, NAW_APP_VERSION: require('../package.json').version }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
});
let app, page, client; const ids = [], errors = [], samples = [], checks = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, name) { for (let n = 0; n < 200; n++) { if (await fn()) return; await delay(50); } throw Error(name); }
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
function check(name, ok) { checks.push({ name, pass: Boolean(ok) }); console.log(ok ? 'PASS' : 'FAIL', name); }

async function width(px) {
  // The shell clamps ordinary dragging to 264px. Set only the isolated host's
  // grid tracks to also pressure-test 240px; never alter row CSS or its DOM.
  return page.locator('.naw[data-native-surface="sidebar"]').evaluate((surface, requested) => {
    let child = surface, grid;
    for (let p = surface.parentElement; p; child = p, p = p.parentElement) {
      const s = getComputedStyle(p), tracks = s.gridTemplateColumns.split(' ');
      if (s.display === 'grid' && tracks.length >= 2 && p.getBoundingClientRect().width > child.getBoundingClientRect().width + 100) { grid = p; break; }
    }
    if (!grid) throw Error('Expected the real shell column grid');
    const tracks = getComputedStyle(grid).gridTemplateColumns.split(' ').map(parseFloat);
    if (tracks.some(n => !Number.isFinite(n))) throw Error('Unexpected shell column geometry');
    // The frame includes a half-pixel divider in its left track.
    const before = surface.querySelector('.sidebar').getBoundingClientRect().width;
    const delta = requested - before; tracks[0] += delta; tracks[1] -= delta;
    grid.style.gridTemplateColumns = tracks.map(n => n + 'px').join(' ');
    return { before, requested, track: tracks[0], pressure: requested < 264 };
  }, px);
}
async function metrics() {
  return page.locator('.naw[data-native-surface="sidebar"]').evaluate(surface => {
    const box = e => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height, bottom: b.bottom }; };
    const visible = e => getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().height > 0;
    return { width: box(surface.querySelector('.sidebar')).width,
      sections: [...surface.querySelectorAll('.sidebar-layout>.sidebar-group')].map(e => ({ height: box(e).height, basis: e.style.flexBasis })),
      rows: [...surface.querySelectorAll('#session-list .session-row')].map(e => {
        const name = e.querySelector('.session-title'), folder = e.querySelector('.hier-folder'), task = e.querySelector('.hier-task');
        const state = e.querySelector('.session-metadata>small'), middle = visible(task) ? task : state, link = e.querySelector('.session-link');
        const image = e.querySelector('.vendor-image'), time = e.querySelector('.session-time');
        return { name: name.textContent, folder: folder.textContent, task: task.textContent, state: state.textContent,
          stateVisible: visible(state), taskVisible: visible(task), folderVisible: visible(folder), timeVisible: visible(time),
          height: box(e).height, nameBox: box(name), middleBox: box(middle), folderBox: box(folder),
          fonts: [getComputedStyle(name).fontSize, getComputedStyle(middle).fontSize, getComputedStyle(folder).fontSize],
          image: image && box(image).width, bg: getComputedStyle(e).backgroundColor, linkBg: getComputedStyle(link).backgroundColor,
          title: link.getAttribute('aria-label'), description: link.getAttribute('aria-description'),
          shortId: e.querySelector('.session-short-id').textContent, shortVisible: visible(e.querySelector('.session-short-id')) };
      }) };
  });
}
(async () => {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Synthetic service');
  client = await require('../app/service-client.cjs').connect(profile, 'sidebar-compact-test');
  for (const [name, provider] of [['Synthetic Codex', 'codex'], ['Synthetic Claude', 'claude'], ['Synthetic DeepSeek', 'codex'], ['Synthetic fallback', 'codex'], ['Synthetic same A', 'claude'], ['Synthetic same B', 'codex']])
    ids.push(await client.call('create', { name, provider, cwd, view: 'chat' }));
  const names = ['Codex E · 界面实现', 'Claude · 一个很长的会话名称用于验证悬停时能看到全部文字', 'DeepSeek · 回归检查', '未知厂商 · 等待输入', '同名会话', '同名会话'];
  const entry = createSourceEntry({ profile, code: root, fixturePid: child.pid }), file = path.join(entry, 'entry.cjs');
  fs.writeFileSync(file, `const e=require('electron');e.Notification.isSupported=()=>false;
for(const k of ['showOpenDialog','showSaveDialog','showMessageBox','showOpenDialogSync','showSaveDialogSync','showMessageBoxSync'])e.dialog[k]=()=>{throw Error('OS dialog outside isolated test');};
const {WorkspaceClient}=require(${JSON.stringify(path.join(root, 'app/workspace-client.cjs'))}),snap=WorkspaceClient.prototype.snapshot,ids=${JSON.stringify(ids)},names=${JSON.stringify(names)};
WorkspaceClient.prototype.snapshot=function(...a){const s=structuredClone(snap.apply(this,a));for(const r of s.sessions){const i=ids.indexOf(r.id);if(i<0)throw Error('Unexpected session');r.name=names[i];r.cwd=['/demo/naw-ui','/demo/phone','/demo/engine','/demo/naw-ui','/demo/client-a/web','/demo/client-b/web'][i];r.state=i===0||i===2?'working':'idle';r.nativeInputRequired=i===3;r.lastActivityAt=Date.now();r.runtimeVersion=${JSON.stringify(require('../package.json').version)};}return s;};
const {RoomState}=require(${JSON.stringify(path.join(root, 'app/room-state.cjs'))}),apply=RoomState.prototype.apply;
RoomState.prototype.apply=function(...a){const s=structuredClone(apply.apply(this,a));for(const room of s.rooms||[])room.queue=[...(room.queue||[]),...[0,2].map(i=>({id:'synthetic-u02-'+i,status:'sent',sentTo:ids[i],text:i===0?'整理侧栏对照方案':'回归队列边界'}))];return s;};
` + fs.readFileSync(file, 'utf8'));
  app = await _electron.launch({ executablePath: require('electron'), args: [entry], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 60000 });
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#new-session').waitFor(); const win = await app.browserWindow(page);
  assert.equal(await win.evaluate(w => w.isVisible()), false); assert.equal(await win.evaluate(w => w.isFocusable()), false);
  await win.evaluate(w => w.setContentSize(1240, 1020)); await page.locator('#sessions-flat').click();
  await page.locator(`#session-list [data-session-id="${ids[0]}"]`).click();
  for (const theme of ['light', 'dark']) for (const px of [240, 280, 320]) {
    await page.emulateMedia({ colorScheme: theme }); await page.waitForFunction(d => document.body.hasAttribute('data-ds-dark-theme') === d, theme === 'dark');
    const host = await width(px); await settle(); await page.mouse.move(900, 100);
    await until(() => page.locator('#naw-hover-card').evaluate(e => e.hidden), 'Previous hover closes');
    await settle(); const m = await metrics();
    const normal = m.rows.filter((_, i) => i !== 3), label = theme + '-' + px;
    check(label + ' actual sidebar width', Math.abs(m.width - px) < .1);
    check(label + ' ordinary three-line row height 55.5px', normal.every(r => Math.abs(r.height - 55.5) < .15));
    check(label + ' three text bands retained and do not overlap', m.rows.every(r => r.nameBox.bottom <= r.middleBox.y + .1 && r.middleBox.bottom <= r.folderBox.y + .1 && r.folderVisible && r.timeVisible));
    check(label + ' original font sizes and 26px images', m.rows.every(r => r.fonts.join(',') === '13px,11px,10.5px') && m.rows.filter(r => r.image).every(r => Math.abs(r.image - 26) < .1));
    check(label + ' active task and attention words remain visible', m.rows[0].taskVisible && m.rows[0].task === '整理侧栏对照方案' && m.rows[3].stateVisible && !m.rows[3].state.startsWith('会话就绪'));
    check(label + ' duplicate IDs and full long accessible name retained', m.rows[4].shortVisible && m.rows[5].shortVisible && m.rows[4].shortId !== m.rows[5].shortId && m.rows[1].title.includes(names[1]));
    await page.screenshot({ path: path.join(pictures, 'actual-' + label + '.png') });
    await page.locator(`#session-list [data-session-id="${ids[1]}"]`).hover();
    await page.locator('#naw-hover-card:not([hidden])').waitFor();
    check(label + ' hover reveals complete long name', (await page.locator('#naw-hover-card').innerText()).includes(names[1]));
    if (px === 280) await page.screenshot({ path: path.join(pictures, 'hover-' + theme + '.png') });
    samples.push({ theme, width: px, host, ...m });
  }
  check('no page errors', errors.length === 0);
  fs.writeFileSync(path.join(evidence, 'gui-' + (process.env.NAW_U02_STAGE || 'run') + '.json'), JSON.stringify({ samples, checks, errors }, null, 2));
  const failed = checks.filter(c => !c.pass).length; console.log('U02 GUI', checks.length - failed, 'pass /', failed, 'fail / 0 skip');
  if (failed) process.exitCode = 1;
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => {
  if (app) await app.close().catch(() => {});
  if (client) { for (const record of client.snapshot().sessions) await client.call('stop', record.id).catch(() => {}); await client.call('shutdown').catch(() => {}); client.close(); }
  if (child.exitCode === null) await new Promise(resolve => child.once('exit', resolve));
  releaseSlot(); await scratch.release();
});
