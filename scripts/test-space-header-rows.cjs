// T-163: the second row of a space's header (member overview, no member opened). Source Electron in a hidden
// window, the synthetic overview backend, no provider process and no model. The row holds what to look at (the
// two pages and a tab for each member) and how the overview is laid out and what to do (grid, list, simplify,
// invite, queue). On one row a rule stands between the two. Where a member tab cannot show three characters of
// its name and the window is at least 700px high, the second kind takes a row of its own. Checks both, and what
// must stay as it was: every control, its name, state and size, the order they are read and reached in, the
// drafts, a header of at most 100px in the smallest window, and columns that keep their conversation and terminal.
const scratch = require('./fixtures/test-scratch.cjs');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto'), { execFileSync } = require('node:child_process');
const { _electron } = scratch.playwright(require('playwright'));
const { createSourceEntry } = require('./fixtures/synthetic-source-boot.cjs');
const { fillRoomMessage } = require('./room-input.cjs');
const { revealDefaultSpace } = require('./fixtures/default-space.cjs');
const root = path.resolve(__dirname, '..');
const evidence = process.env.NAW_EVIDENCE_DIR;
if (!evidence || !path.isAbsolute(evidence)) throw Error('An explicit private evidence directory is required');
if (path.resolve(evidence) === root || path.resolve(evidence).startsWith(root + path.sep)) throw Error('GUI evidence must be outside the repository');
fs.mkdirSync(evidence, { recursive: true });
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID();
try { fs.mkdirSync(slot); } catch (error) { if (error.code !== 'EEXIST') throw error; console.error('Canonical GUI slot occupied; zero allocation and no launch.'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ token, owner: 'Claude3', task: 'T163 space header rows', pid: process.pid, at: new Date().toISOString() }));
const benign = new Set(['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'HOME', 'SHELL', 'USER', 'LOGNAME', 'TZ', 'TERM', 'COLORTERM', 'COMMAND_MODE', '__CF_USER_TEXT_ENCODING']);
const env = extra => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => benign.has(key))), ...extra });
let profile, child, client, app, page, sequence = 0;
const checks = [], errors = [], measured = {};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { for (let n = 0; n < 300; n++) { if (await fn()) return; await delay(50); } throw Error(label); }
function fixture(method, target, value) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const receive = reply => { if (reply.requestId !== id) return; clearTimeout(timer); child.off('message', receive); resolve(reply); };
    const timer = setTimeout(() => { child.off('message', receive); reject(Error('Synthetic fixture did not answer ' + method)); }, 8000);
    child.on('message', receive); child.send({ id, method, target, value });
  });
}
const tell = (method, target, value) => child.send({ id: ++sequence, method, target, value });
const settled = async () => { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); await delay(150); };
const size = async (width, height) => { await app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].setContentSize(s.width, s.height), { width, height }); await settled(); };
const capture = name => page.screenshot({ path: path.join(evidence, name + '.png') });
function check(text) { checks.push(text); console.log('PASS:', text); }
const NAME = 48, HIGH = 700, clear = 'rgba(0, 0, 0, 0)';
// The header's second row as laid out now, and what the page under it keeps.
const sample = () => page.evaluate(() => {
  const shown = e => Boolean(e && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden');
  const box = e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom }; };
  const header = document.querySelector('#header'), tabs = document.querySelector('#room-tabs'), host = document.querySelector('#collaboration-overview');
  const ellipsis = e => { const probe = document.createElement('span'); probe.textContent = '…'; probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap'; e.append(probe); const w = probe.getBoundingClientRect().width; probe.remove(); return w; };
  // How many characters of a one-line text can be read: up to `right`, less the ellipsis when the text is cut.
  const readable = (e, right, cut) => {
    const node = [...e.childNodes].find(n => n.nodeType === 3), chars = [...e.textContent]; if (!node || !chars.length) return 0;
    const limit = right - (cut ? ellipsis(e) : 0), range = document.createRange(); let n = 0, offset = 0;
    for (const ch of chars) { range.setStart(node, 0); range.setEnd(node, offset + ch.length); if (range.getBoundingClientRect().right > limit + 0.5) break; offset += ch.length; n++; }
    return n;
  };
  const line = e => { const cut = e.scrollWidth > e.clientWidth + 1; return { text: e.textContent, of: [...e.textContent].length, cut, room: e.clientWidth, shown: readable(e, e.getBoundingClientRect().left + e.clientWidth, cut), font: getComputedStyle(e).fontSize }; };
  const members = [...document.querySelectorAll('#room-member-tabs > button')].filter(shown).map(tab => {
    const edge = tab.getBoundingClientRect().right - parseFloat(getComputedStyle(tab).borderRightWidth), id = tab.querySelector('.room-member-id');
    return { session: tab.dataset.roomSession, pressed: tab.getAttribute('aria-pressed'), attention: tab.classList.contains('needs-attention'), label: tab.getAttribute('aria-label'), box: box(tab),
      name: line(tab.querySelector('.room-member-name')), state: line(tab.querySelector('.room-member-state')), id: id && shown(id) ? { text: id.textContent, of: [...id.textContent].length, shown: readable(id, edge, false) } : null };
  });
  // The row's flex items in document order; the layout controls' wrapper is display:contents, so its children count.
  const flat = []; for (const item of tabs.children) { if (getComputedStyle(item).display === 'contents') flat.push(...item.children); else flat.push(item); }
  const centres = [], items = flat.filter(shown).map(e => ({ id: e.id || (e.className || '').toString().split(' ')[0] || e.textContent.trim().slice(0, 20), box: box(e) }));
  for (const item of items) { const c = item.box.y + item.box.h / 2; let row = centres.findIndex(v => Math.abs(v - c) < 14); if (row < 0) { centres.push(c); row = centres.length - 1; } item.row = row; }
  const group = tabs.querySelector('.collaboration-layout-controls'), rule = shown(group) ? getComputedStyle(group, '::before') : null;
  const controls = [...tabs.querySelectorAll('button')].filter(shown).map(e => ({ id: e.id || null, text: e.textContent.trim().slice(0, 80), aria: e.getAttribute('aria-label'), pressed: e.getAttribute('aria-pressed'), disabled: e.disabled, tab: e.tabIndex, font: getComputedStyle(e).fontSize, member: Boolean(e.closest('#room-member-tabs')), w: box(e).w, h: box(e).h }));
  const columns = [...host.querySelectorAll('.collaboration-member-reader')].filter(shown).map(reader => { const list = reader.querySelector('.messages'), terminal = reader.querySelector('.column-native-host'), block = reader.querySelector('.collaboration-member-input'), hint = block?.querySelector('.session-compose-hint'), area = block?.querySelector('.session-message-input');
    return { conversation: shown(list) ? list.getBoundingClientRect().height : null, atEnd: shown(list) ? list.scrollTop + list.clientHeight >= list.scrollHeight - 2 : null, terminal: shown(terminal) ? terminal.getBoundingClientRect().height : null,
      hint: shown(hint) ? Math.round(hint.clientHeight / 16) : 0, inside: shown(block) ? block.getBoundingClientRect().bottom <= reader.getBoundingClientRect().bottom + 0.6 : null, draft: shown(area) ? area.value : null }; });
  return { window: [innerWidth, innerHeight], compact: header.classList.contains('compact-room'), two: header.classList.contains('room-tabs-two-rows'), header: box(header), row: shown(tabs) ? box(tabs) : null, inHeader: tabs.parentElement === header,
    rows: centres.length, items, members, controls, columns, group: shown(group) ? box(group) : null,
    rule: rule ? { content: rule.content, width: rule.borderLeftWidth, colour: rule.borderLeftColor, left: parseFloat(rule.left), height: parseFloat(rule.height) } : null,
    overflow: [tabs.scrollWidth > tabs.clientWidth + 1, header.scrollWidth > header.clientWidth + 1, document.documentElement.scrollWidth > innerWidth + 1],
    page: document.querySelector('#room-record').getAttribute('aria-pressed') === 'true' ? 'records' : 'overview', spaceDraft: document.querySelector('#shared-input').value };
});
// What the one-row layout would give each cut name, read by taking the second row away for a moment. Used only to
// check that the app decided again after something changed, not to decide what is expected in the fixed cases.
const oneRowNames = () => page.evaluate(() => {
  const header = document.querySelector('#header'), was = header.classList.contains('room-tabs-two-rows'); header.classList.remove('room-tabs-two-rows');
  const names = [...document.querySelectorAll('#room-member-tabs > button .room-member-name')].map(e => [e.clientWidth, e.scrollWidth > e.clientWidth + 1]);
  header.classList.toggle('room-tabs-two-rows', was); return names;
});
const order = s => s.items.map(item => item.id);
// Read left to right and top to bottom, the row is in document order, which is the order the Tab key walks.
function inOrder(s, label) {
  for (let i = 1; i < s.items.length; i++) { const a = s.items[i - 1], b = s.items[i]; assert.ok(b.row > a.row || b.row === a.row && b.box.x >= a.box.right - 1, `${label}: ${b.id} comes after ${a.id} on screen as in the document`); }
  assert.deepEqual(s.overflow, [false, false, false], label + ': nothing runs outside the row, the header or the window');
}
function oneRow(s, label, { rule = true } = {}) {
  assert.equal(s.two, false, label + ': one row'); assert.equal(s.rows, 1, label + ': every control is on the same row'); inOrder(s, label);
  if (!rule) { assert.equal(s.rule, null, label + ': no layout controls, so no rule'); return; }
  // One rule, between the last member tab and the layout controls, as high as the row.
  const last = s.items.find(item => item.id === 'room-member-tabs').box, x = s.group.x + s.rule.left;
  assert.deepEqual([s.rule.width, s.rule.content], ['1px', '""'], label + ': a 1px rule stands before the layout controls'); assert.notEqual(s.rule.colour, clear);
  assert.ok(x >= last.right + 4 && x <= s.group.x - 4, `${label}: the rule stands between the member tabs and the layout controls, with room on both sides (${x - last.right}/${s.group.x - x})`);
  assert.ok(s.rule.height >= s.row.h - 1, `${label}: the rule is as high as the row (${s.rule.height} of ${s.row.h})`);
}
function twoRows(s, label) {
  assert.equal(s.two, true, label + ': two rows'); assert.equal(s.rows, 2, label + ': exactly two rows'); inOrder(s, label);
  const row = id => s.items.find(item => item.id === id)?.row;
  assert.deepEqual([row('room-overview'), row('room-record'), row('room-member-tabs')], [0, 0, 0], label + ': the pages and the member tabs share the first row');
  const second = s.items.filter(item => item.row === 1).map(item => item.id);
  // On the records page there are no layout controls; in the overview the third item is the simplify switch.
  if (s.page === 'records') assert.deepEqual(second, ['manage-members', 'room-queue'], label + ': the two actions are the second row');
  else { assert.equal(second.length, 4, label + ': layout controls, simplify, invite and queue are the second row'); assert.deepEqual([second[0], second[2], second[3]], ['collaboration-layout-controls', 'manage-members', 'room-queue'], label + ': in that order'); }
  if (s.rule) assert.equal(s.rule.content, 'none', label + ': the rule is not drawn when the rows are apart');
  const queue = s.items.find(item => item.id === 'room-queue').box; assert.ok(Math.abs(queue.right - s.row.right) < 1.5, label + ': the actions end at the row\'s right edge');
  for (const m of s.members) assert.ok(m.name.shown >= Math.min(3, m.name.of), `${label}: "${m.name.text}" shows three characters or all of it (${m.name.shown} of ${m.name.of})`);
  for (const m of s.members) assert.ok(!m.id || m.id.shown === m.id.of, `${label}: the short id of "${m.name.text}" is whole`);
}
// What a person reads and uses in the row, whatever the rows do.
function same(s, reference, label) {
  const told = v => v.controls.map(c => [c.id, c.text, c.aria, c.pressed, c.disabled, c.tab, c.font]);
  const now = told(s), then = told(reference), differs = now.map((v, i) => JSON.stringify(v) === JSON.stringify(then[i]) ? null : [then[i], v]).filter(Boolean);
  assert.deepEqual(now, then, label + ': the same controls in the same order, with the same names and states' + (differs.length ? ' (first difference: ' + JSON.stringify(differs[0]) + ')' : ''));
  const fixed = v => v.controls.filter(c => !c.member).map(c => [c.id || c.text, Math.round(c.w), Math.round(c.h)]);
  assert.deepEqual(fixed(s), fixed(reference), label + ': every control but the member tabs keeps its size');
  for (const m of s.members) { assert.equal(m.name.font, '13px', label + ': a member tab\'s name keeps its type size'); assert.equal(m.state.font, '11px'); assert.ok(m.box.h >= 26 && m.box.w >= 24, `${label}: the tab of "${m.name.text}" can be pressed`); }
}
function columns(s, label, conversation = 80) {
  for (const [i, c] of s.columns.entries()) {
    assert.ok(c.terminal >= 63.5, `${label}: column ${i + 1}: the terminal keeps its 64px (${c.terminal})`); assert.ok(c.conversation >= conversation - 0.5, `${label}: column ${i + 1}: the conversation keeps ${conversation}px (${c.conversation})`);
    assert.equal(c.inside, true, `${label}: column ${i + 1}: the input stays inside the column`); assert.equal(c.atEnd, true, `${label}: column ${i + 1}: the conversation is still at its end`);
  }
}
async function language(code) {
  await page.locator('#setup-button').click(); await page.locator('#ui-language').selectOption(code);
  await until(async () => (await page.locator('#setup-title').textContent()) === (code === 'en' ? 'Settings' : '设置'), 'The interface language changed'); await page.locator('#close-setup').click(); await settled();
}
async function sidebar(expanded) {
  const state = async () => (await page.locator('.naw[data-native-surface=sidebar]').getAttribute('data-collapsed')) === 'true';
  if (await state() === expanded) await page.keyboard.press('Meta+Alt+b');
  await until(async () => await state() === !expanded, 'The sidebar is in the requested state');
  let previous, stable = 0;
  await until(async () => { const x = (await page.locator('#header').boundingBox()).x; stable = x === previous ? stable + 1 : 0; previous = x; return stable >= 3; }, 'The sidebar has stopped moving');
  await settled();
}
async function run() {
  profile = scratch.directory(path.join(os.tmpdir(), 'naw-space-header-rows-')); const cwd = path.join(profile, 'workspace'); fs.mkdirSync(cwd, { mode: 0o700 });
  child = scratch.childProcess.fork(path.join(root, 'app/daemon.cjs'), [profile], { cwd, execArgv: ['--require', path.join(__dirname, 'fixtures/collaboration-overview.cjs')],
    env: env({ NAW_TEST_APP_ROOT: root, NAW_WORKSPACE: cwd, NAW_APP_VERSION: require('../package.json').version }), stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Synthetic backend ready');
  client = await require('../app/service-client.cjs').connect(profile, 'space-header-rows-seed');
  const names = ['发布核对 · Release check', '回归排查', 'Docs_and_changelog_writer_with_a_long_name', '集成'], members = [];
  for (const [i, name] of names.entries()) { const id = await client.call('create', { provider: i % 2 ? 'codex' : 'claude', cwd, name, view: 'chat' }); await client.call('join', id, true); members.push(id); }
  const [a, b, c, d] = members, privateDraft = 'UNSENT private draft for one member · 尚未发送给这个成员的草稿', spaceDraft = 'UNSENT space draft · 尚未发送到空间的草稿';
  await client.call('draft', a, privateDraft);
  const entry = createSourceEntry({ profile, code: root, fixturePid: child.pid }), entryFile = path.join(entry, 'entry.cjs');
  fs.writeFileSync(entryFile, `const e=require('electron');e.Notification.isSupported=()=>false;globalThis.spaceHeaderRows={guards:[]};` +
    `for(const key of ['showOpenDialog','showSaveDialog','showMessageBox','showOpenDialogSync','showSaveDialogSync','showMessageBoxSync'])e.dialog[key]=()=>{spaceHeaderRows.guards.push(key);throw Error('OS dialog outside this check');};\n` + fs.readFileSync(entryFile, 'utf8'));
  app = await _electron.launch({ executablePath: require('electron'), args: [entry], env: env({ NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid), NAW_TEST_VISIBLE: '0', NAW_TEST_UI_LANGUAGE: 'zh' }), timeout: 60000 });
  await until(async () => { for (const p of app.windows()) if (!p.isClosed() && await p.locator('#new-session').count()) { page = p; return true; } return false; }, 'The workspace page');
  page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
  assert.deepEqual(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ visible: w.isVisible(), focusable: w.isFocusable() }))), [{ visible: false, focusable: false }], 'The window is hidden and cannot take focus');
  await size(1240, 850);
  // Four members in four states: working with a child task, waiting for the person, ready, and failed.
  for (const [id, letter] of [[a, 'A'], [b, 'B'], [c, 'C'], [d, 'D']]) for (let i = 0; i < 6; i++) tell('nativeBlock', id, { id: `response:${i}`, kind: 'response', turnId: `turn-${letter}`, status: 'complete',
    text: `成员 ${letter} 的第 ${i + 1} 条原文：核对发布说明第 ${i + 1} 节，结果和当前实现一致。\n\nOriginal message ${i + 1} of member ${letter}.` });
  tell('fleet', a, { event: 'SubagentStart', id: 'child-a', name: '跑全量测试', stale: false }); tell('state', a, 'working');
  tell('approval', b, { id: 'approval-b', kind: 'command', command: 'rm -rf build/ (synthetic, nothing runs)', cwd }); tell('state', d, 'error');
  await revealDefaultSpace(page); await page.locator('#room-nav').click(); await page.locator('#collaboration-overview .collaboration-member-reader').nth(3).waitFor();
  for (const id of [a, c, d]) await page.evaluate(member => workspace.claim(member, 'chat'), id);
  await until(async () => { const state = await page.evaluate(() => workspace.initial()), owner = id => state.sessions.find(v => v.id === id).owner; return [a, c, d].every(id => owner(id) && owner(id) !== owner(b)); }, 'This window has the input for three members');
  await fillRoomMessage(page, spaceDraft);
  await until(async () => { const s = await sample(); return s.compact && s.inHeader && s.members.length === 4 && s.columns.length === 4 && s.columns.every(col => col.conversation && col.terminal) && s.members[1].attention; }, 'The space\'s overview with four members');
  await page.mouse.move(2, 2); await settled();
  const before = (await fixture('stats')).overviewCalls, identityBefore = await page.evaluate(async () => (await workspace.initial()).sessions.map(v => [v.id, v.nativeId, v.owner, v.name]));
  const zhOrder = ['room-overview', 'room-record', 'room-member-tabs', 'collaboration-layout-controls', '简化信息', 'manage-members', 'room-queue'];
  const drafts = (s, label) => { assert.equal(s.spaceDraft, spaceDraft, label + ': the space draft is kept'); if (s.columns.length) assert.equal(s.columns[0].draft, privateDraft, label + ': the private draft is kept'); };
  const note = (key, s) => { measured[key] = { rows: s.rows, header: Math.round(s.header.h), tab: Math.round(s.members[0].box.w), names: s.members.map(m => `${m.name.shown}/${m.name.of}`), states: s.members.map(m => `${m.state.shown}/${m.state.of}`), conversation: s.columns.map(col => Math.round(col.conversation)), terminal: s.columns.map(col => Math.round(col.terminal)) }; };

  // 1) Chinese, four members: the names fit, so it stays one row, with the rule, in all three window sizes.
  let s = await sample(); const zh = s; note('zh-1240x850', s);
  assert.deepEqual(order(s), zhOrder, 'The row holds the two pages, the member tabs, the layout controls, simplify, invite and queue, in that order');
  oneRow(s, 'zh 1240x850'); drafts(s, 'zh 1240x850'); columns(s, 'zh 1240x850');
  assert.deepEqual(s.members.map(m => [m.name.text, m.pressed, m.attention]), [['发布核对 · Release check', 'false', false], ['回归排查', 'false', true], ['Docs_and_changelog_writer_with_a_long_name', 'false', false], ['集成', 'false', false]], 'Each member has a tab; the one waiting for the person is marked');
  for (const m of s.members) assert.ok(!m.name.cut || m.name.room >= NAME, `zh 1240x850: "${m.name.text}" has room for three characters (${m.name.room}px)`);
  await capture('01-one-row-zh');
  for (const [width, height] of [[1000, 700], [850, 600]]) {
    await size(width, height); s = await sample(); note(`zh-${width}x${height}`, s);
    oneRow(s, `zh ${width}x${height}`); same(s, zh, `zh ${width}x${height}`); drafts(s, `zh ${width}x${height}`); columns(s, `zh ${width}x${height}`);
  }
  // In the smallest window the names no longer fit, and the row still does not break: the window is too low.
  assert.ok(s.members.some(m => m.name.cut && m.name.room < NAME), 'At 850x600 a member name has less room than three characters');
  assert.ok(s.header.h <= 100, `At 850x600 the header is at most 100px (${s.header.h})`);
  await capture('02-smallest-zh-one-row');
  check('Chinese, four members: one row with a rule between the member tabs and the layout controls at 1240x850, 1000x700 and 850x600; in the smallest window the header stays under 100px although the names are cut');

  // 2) English: the fixed controls are wider. Two rows where the window is high enough; one in the smallest window.
  await language('en'); await page.mouse.move(2, 2);
  // A tab's accessible name repeats its state line and follows it at the next one-second refresh.
  await until(async () => (await sample()).members.every(m => m.state.text && !/[\u4e00-\u9fff]/.test(m.state.text) && m.label.endsWith(m.state.text)), 'The member tabs are in English'); await settled();
  s = await sample(); const en = s; note('en-850x600', s);
  oneRow(s, 'en 850x600'); drafts(s, 'en 850x600'); columns(s, 'en 850x600');
  assert.ok(s.header.h <= 100, `en 850x600: the header is at most 100px (${s.header.h})`);
  assert.ok(s.members.every(m => m.name.cut && m.name.room < NAME), 'en 850x600: no member name has room for three characters, and the row still does not break');
  await capture('03-smallest-en-one-row');
  for (const [width, height] of [[1000, 700], [1240, 850]]) {
    await size(width, height); await until(async () => (await sample()).two, `en ${width}x${height}: the controls take a row of their own`); await settled();
    s = await sample(); note(`en-${width}x${height}`, s);
    twoRows(s, `en ${width}x${height}`); same(s, en, `en ${width}x${height}`); drafts(s, `en ${width}x${height}`); columns(s, `en ${width}x${height}`);
    assert.ok(Math.abs(s.header.h - en.header.h - 30) < 1.5, `en ${width}x${height}: the header is one control row higher (${en.header.h} -> ${s.header.h})`);
  }
  await capture('04-two-rows-en');
  check('English, four members: one row in the smallest window (header under 100px); at 1000x700 and 1240x850 the layout controls and actions take a second row, every name shows three characters or more, and nothing else changes');

  // 3) The height decides, not what a column shows. One pixel under 700 is one row again; a member that fails
  //    and shows its hint changes nothing in either state.
  await size(1000, 699); await until(async () => !(await sample()).two, 'Under 700px high the row is one row'); await settled();
  s = await sample(); oneRow(s, 'en 1000x699'); columns(s, 'en 1000x699');
  tell('state', c, 'error'); await until(async () => (await sample()).columns[2].hint > 0, 'The member that failed shows its hint'); await settled();
  s = await sample(); oneRow(s, 'en 1000x699 with one more hint'); columns(s, 'en 1000x699 with one more hint');
  await size(1000, 700); await until(async () => (await sample()).two, 'At 700px high the controls take their row again'); await settled();
  s = await sample(); twoRows(s, 'en 1000x700 with one more hint'); columns(s, 'en 1000x700 with one more hint');
  assert.ok(s.columns[2].hint >= 2, 'The failed member\'s hint is on the page while the header has two rows');
  await size(850, 600); await until(async () => !(await sample()).two, 'The smallest window is one row'); await settled();
  s = await sample(); oneRow(s, 'en 850x600 with one more hint'); columns(s, 'en 850x600 with one more hint'); note('en-850x600-both-slices', s);
  assert.ok(s.header.h <= 100 && s.columns[2].hint >= 2 && s.columns[3].hint >= 2, `en 850x600: two columns show their hints, the header is ${s.header.h}px, and every column keeps its conversation and terminal`);
  await capture('05-smallest-en-with-hints');
  check('The second row follows the window\'s height (699px: one row, 700px: two) and not the columns: a member that fails and shows a hint changes it in neither state; in the smallest window two long hints leave every conversation 80px');

  // A column the person scrolled to its end by hand (no message drawn since, so it has no pending reading target)
  // keeps following when one resize takes the header from two rows to one.
  await size(1000, 700); await until(async () => (await sample()).two, 'Two rows at 1000x700'); await settled();
  const reader = page.locator(`#collaboration-overview .collaboration-member-reader[data-member-id="${a}"] .messages`);
  const at = await reader.boundingBox(); await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
  await page.mouse.wheel(0, -240); await settled(); await page.mouse.wheel(0, 4000); await settled(); await page.mouse.move(2, 2);
  assert.equal(await reader.evaluate(el => el.scrollTop + el.clientHeight >= el.scrollHeight - 2), true, 'The column was scrolled back to its end by hand');
  await size(850, 600); await until(async () => !(await sample()).two, 'One resize down to the smallest window: one row'); await settled();
  s = await sample(); assert.equal(s.columns[0].atEnd, true, 'After the resize the column the person scrolled by hand is still at its end');
  tell('nativeBlock', a, { id: 'response:late', kind: 'response', turnId: 'turn-A-late', status: 'complete', text: '成员 A 的新原文：调整窗口之后到达。\n\nA late message of member A.' });
  await until(async () => (await reader.textContent()).includes('A late message of member A.'), 'The new message is drawn'); await settled();
  assert.equal(await reader.evaluate(el => el.scrollTop + el.clientHeight >= el.scrollHeight - 2), true, 'The new message is in view: the column still follows its latest message');
  check('A column scrolled to its end by hand keeps following when one resize takes the header from two rows to one');

  // 4) The shared records page has the same row without the layout controls.
  await size(1240, 850); await until(async () => (await sample()).two, 'en 1240x850: two rows'); await settled();
  await page.locator('#room-record').click(); await until(async () => (await sample()).page === 'records', 'The shared records page'); await settled();
  s = await sample(); note('en-1240x850-records', s);
  if (s.two) twoRows(s, 'en 1240x850 records'); else oneRow(s, 'en 1240x850 records', { rule: false });
  const tight = (await oneRowNames()).some(([room, cut]) => cut && room < NAME);
  assert.equal(s.two, tight, 'On the records page the row breaks exactly when a name has no room for three characters');
  await size(850, 600); await settled(); s = await sample(); oneRow(s, 'en 850x600 records', { rule: false }); assert.ok(s.header.h <= 100);
  await size(1240, 850); await page.locator('#room-overview').click(); await until(async () => { const v = await sample(); return v.page === 'overview' && v.columns.length === 4 && v.two; }, 'The member overview again, with two rows'); await settled();
  // Back from the records page, after the window was resized while the columns were hidden: every column is whole and at its end.
  s = await sample(); twoRows(s, 'en 1240x850 back from the records page'); columns(s, 'en 1240x850 back from the records page');
  check('The shared records page: the same rule for the same row; under 700px high it is one row there too');

  // 5) One member opened: another header layout, which this change leaves alone.
  await page.locator(`#collaboration-overview .collaboration-member-status[data-member-id="${members[1]}"] .collaboration-member-name`).click();
  await until(async () => !(await sample()).compact, 'One member is opened'); await settled();
  s = await sample(); assert.equal(s.two, false, 'With a member opened the header is not the compact space header and has no second-row state');
  await page.locator('#room-overview').click(); await until(async () => { const v = await sample(); return v.compact && v.two && v.columns.length === 4; }, 'Back to the whole space, with two rows'); await settled();
  check('Opening one member and coming back: the opened member\'s header is untouched, and the overview has its two rows again');

  // 6) Chinese again, and two more members: with six the names no longer fit at 1240x850.
  await language('zh'); await until(async () => { const v = await sample(); return !v.two && v.members.every(m => m.label.endsWith(m.state.text)); }, 'Chinese with four members is one row again'); await settled();
  s = await sample(); oneRow(s, 'zh 1240x850 again'); same(s, { ...zh, controls: zh.controls.map((v, i) => ({ ...v, text: s.controls[i].text, aria: s.controls[i].aria })) }, 'zh 1240x850 again');
  for (const [name, provider] of [['测试覆盖 · Coverage', 'claude'], ['Perf_benchmarks', 'codex']]) { const id = await client.call('create', { provider, cwd, name, view: 'chat' }); await client.call('join', id, true); members.push(id); }
  await until(async () => { const v = await sample(); return v.members.length === 6 && v.columns.length === 6 && v.two; }, 'Six members: the controls take a row of their own'); await settled();
  s = await sample(); note('zh-1240x850-six', s); twoRows(s, 'zh 1240x850, six members'); drafts(s, 'zh 1240x850, six members');
  await capture('06-six-members-zh-two-rows');
  // The sidebar closes: the row is wider with no window resize, and the choice is made again.
  await sidebar(false); s = await sample();
  assert.equal(s.two, (await oneRowNames()).some(([room, cut]) => cut && room < NAME), 'After the sidebar closed the row was fitted again');
  measured['zh-1240x850-six-sidebar-closed'] = { rows: s.rows, tab: Math.round(s.members[0].box.w) };
  await sidebar(true); await until(async () => (await sample()).two, 'With the sidebar open again the row is two rows'); s = await sample(); twoRows(s, 'zh 1240x850, six members, sidebar open again');
  await size(850, 600); await until(async () => !(await sample()).two, 'Six members in the smallest window: one row'); await settled();
  s = await sample(); note('zh-850x600-six', s); oneRow(s, 'zh 850x600, six members'); assert.ok(s.header.h <= 100, `Six members at 850x600: the header is at most 100px (${s.header.h})`);
  await size(1240, 850); await settled();
  check('Six members: two rows at 1240x850 with every name readable; the choice is made again when the sidebar closes or opens; one row and a header under 100px in the smallest window');

  // Looking, resizing, switching language and adding members sent nothing and gave no input to any session.
  const after = (await fixture('stats')).overviewCalls;
  for (const key of ['send', 'queue', 'steer', 'forward', 'approve', 'answer', 'run', 'resume', 'pause', 'input']) assert.equal(after[key], before[key], `No ${key} call was made`);
  assert.deepEqual((await page.evaluate(async () => (await workspace.initial()).sessions.map(v => [v.id, v.nativeId, v.owner, v.name]))).slice(0, 4), identityBefore.slice(0, 4), 'The first four sessions and who has their input are unchanged');
  assert.deepEqual(await app.evaluate(() => globalThis.spaceHeaderRows.guards), []); assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ checks, errors, measured, calls: { before, after }, modelCalls: 0 }, null, 2));
}
const cleanup = scratch.cleanup(async () => { if (app) await app.close(); client?.close(); if (child?.connected) child.disconnect(); if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); });
let deadline;
Promise.race([run(), new Promise((_, reject) => { deadline = setTimeout(() => reject(Error('240-second GUI budget exhausted')), 240000); })])
  .catch(async error => { console.error(error.stack); fs.writeFileSync(path.join(evidence, 'failure.txt'), error.stack + '\n' + JSON.stringify(measured)); try { if (page && !page.isClosed()) await capture('failure'); } catch { /* The page is gone. */ } process.exitCode = 1; })
  .finally(async () => {
    clearTimeout(deadline);
    try {
      await cleanup();
      assert.equal(JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))).token, token); if (profile) assert.equal(fs.existsSync(profile), false);
      fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot);
      console.log(JSON.stringify({ checks, measured, modelCalls: 0, realProviderProcesses: 0, slotReleased: true }));
    } catch (error) { console.error('Owned cleanup/lease release unconfirmed:', error.stack); process.exitCode = 1; }
  });
