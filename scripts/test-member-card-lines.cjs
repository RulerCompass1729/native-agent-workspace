// T-163, reworked 2026-11-15 as member cards: the lines of a member's card in a space's member overview (grid layout).
// Source Electron in a hidden window, the synthetic overview backend, no provider process and no model. Checks that
// each member is one bordered card with its name row inside it, that one boundary is drawn by one line (name row to
// content, conversation to terminal) and, more importantly, what must stay as it was: names, states, drafts, who has
// the input, the controls and their sizes, the drag handle when it is pointed at, focused or dragged, the list
// layout, and a narrow container, where the cards stack.
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
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ token, owner: 'Claude3', task: 'T163 member card lines', pid: process.pid, at: new Date().toISOString() }));
const benign = new Set(['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'HOME', 'SHELL', 'USER', 'LOGNAME', 'TZ', 'TERM', 'COLORTERM', 'COMMAND_MODE', '__CF_USER_TEXT_ENCODING']);
const env = extra => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => benign.has(key))), ...extra });
let profile, child, client, app, page, sequence = 0;
const checks = [], errors = [];
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
const settled = async () => { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); await delay(150); };
const size = async (width, height) => { await app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].setContentSize(s.width, s.height), { width, height }); await settled(); };
const capture = name => page.screenshot({ path: path.join(evidence, name + '.png') });
function check(text) { checks.push(text); console.log('PASS:', text); }
const clear = 'rgba(0, 0, 0, 0)';
// The member overview as laid out now: per member, the name row, the column under it and the column's input block.
const sample = () => page.evaluate(() => {
  const shown = e => Boolean(e && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden');
  const box = e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom }; };
  const host = document.querySelector('#collaboration-overview'), strip = host.querySelector('.collaboration-statuses');
  // A name's text without its maker mark, which sits inside the name since 1ad3910d.
  const text = (scope, selector) => { const e = scope.querySelector(selector); if (!(shown(e) && e.getBoundingClientRect().height > 2)) return ''; const c = e.cloneNode(true); c.querySelectorAll('.vendor-mark').forEach(v => v.remove()); return c.textContent.trim(); };
  const font = (scope, selector) => { const e = scope.querySelector(selector); return e ? parseFloat(getComputedStyle(e).fontSize) : null; };
  const members = [...host.querySelectorAll('.collaboration-member-status')].filter(shown).map(row => {
    const id = row.dataset.memberId, column = [...host.querySelectorAll('.collaboration-member-reader')].find(e => e.dataset.memberId === id && shown(e));
    const unit = [...host.querySelectorAll('.collaboration-member-unit')].find(e => e.dataset.memberId === id);
    const rs = getComputedStyle(row), cs = column && getComputedStyle(column), block = column?.querySelector('.collaboration-member-input');
    const input = shown(block) ? (() => {
      const sash = block.querySelector('.column-terminal-sash'), terminal = block.querySelector('.column-native-host'), area = block.querySelector('.session-message-input'), hint = block.querySelector('.session-compose-hint');
      const line = shown(sash) ? getComputedStyle(sash, '::before') : null, bs = getComputedStyle(block);
      return { box: box(block), rule: [bs.borderTopWidth, bs.borderTopStyle, bs.borderTopColor],
        sash: shown(sash) ? { box: box(sash), tab: sash.tabIndex, role: sash.getAttribute('role'), cursor: getComputedStyle(sash).cursor, hover: sash.matches(':hover'), focusVisible: sash.matches(':focus-visible'), outline: getComputedStyle(sash).outlineStyle + ' ' + getComputedStyle(sash).outlineWidth,
          line: { width: line.borderTopWidth, color: line.borderTopColor, top: line.top, left: line.left, right: line.right } } : null,
        terminal: shown(terminal) ? box(terminal) : null, area: shown(area) ? { box: box(area), value: area.value, font: parseFloat(getComputedStyle(area).fontSize) } : null,
        hint: shown(hint) ? hint.textContent.trim() : '', buttons: [...block.querySelectorAll('button')].filter(shown).map(b => ({ text: b.textContent.trim(), disabled: b.disabled, box: box(b) })) };
    })() : null;
    const list = column?.querySelector('.messages');
    return { id, state: row.dataset.state || '', focused: row.classList.contains('is-focused'), row: box(row),
      borders: [rs.borderTopWidth, rs.borderRightWidth, rs.borderBottomWidth, rs.borderLeftWidth], bottomColor: rs.borderBottomColor, background: rs.backgroundColor,
      name: text(row, '.collaboration-member-name'), nameFont: font(row, '.collaboration-member-name'), more: shown(row.querySelector('.collaboration-member-more')) ? box(row.querySelector('.collaboration-member-more')) : null,
      stateText: text(row, '.collaboration-member-state'), stateFont: font(row, '.collaboration-member-state'), stateColor: getComputedStyle(row.querySelector('.collaboration-member-state')).color, child: text(row, '.collaboration-member-child-compact'),
      column: column ? { box: box(column), top: [cs.borderTopWidth, cs.borderTopStyle, cs.borderTopColor], sides: [cs.borderLeftWidth, cs.borderRightWidth, cs.borderBottomWidth] } : null,
      unit: unit && getComputedStyle(unit).display !== 'contents' ? { box: box(unit), borders: ['Top', 'Right', 'Bottom', 'Left'].map(side => getComputedStyle(unit)['border' + side + 'Width']) } : null,
      messages: shown(list) ? { box: box(list), originals: [(list.textContent.match(/的第 \d 条原文/g) || []).length, (list.textContent.match(/Original message \d of member/g) || []).length], font: parseFloat(getComputedStyle(list.querySelector('.message-body') || list).fontSize) } : null, input };
  });
  const guide = document.querySelector('.column-terminal-guide'), tip = document.querySelector('.column-terminal-hint');
  return { members, width: host.getBoundingClientRect().width, flags: { list: host.dataset.listUnits, focused: host.dataset.focused, brief: host.dataset.brief, content: host.dataset.content },
    strip: shown(strip) ? { box: box(strip), paddingBottom: getComputedStyle(strip).paddingBottom } : null,
    guide: shown(guide) ? box(guide) : null, tip: shown(tip) ? tip.textContent : '', spaceDraft: document.querySelector('#shared-input').value };
});
// One card per member, one boundary, one line: the name row is inside the member's bordered card, and its bottom
// rule is the line between the name and the member's own content, which starts right under it with no frame of its own.
// The same holds in a narrow container, where the cards stack.
function cards(s, label) {
  assert.equal(s.strip, null, label + ': no separate row of names above the cards');
  for (const m of s.members) {
    assert.ok(m.unit && m.unit.borders.every(v => v === '1px'), `${label}: ${m.name} is one bordered card`);
    assert.ok(m.row.y >= m.unit.box.y - 0.6 && m.column.box.bottom <= m.unit.box.bottom + 0.6, `${label}: ${m.name}: name and content are inside the card`);
    assert.deepEqual(m.borders, ['0px', '0px', '1px', '0px'], `${label}: ${m.name}: the name row's bottom rule is the one line`); assert.notEqual(m.bottomColor, clear);
    assert.equal(m.background, clear, `${label}: ${m.name} has no colour block`);
    assert.ok(Math.abs(m.column.box.y - m.row.bottom) < 0.6, `${label}: ${m.name}: its content starts right under that line (${m.column.box.y - m.row.bottom})`);
    assert.ok(Math.abs(m.column.box.x - m.row.x) < 0.6 && Math.abs(m.column.box.w - m.row.w) < 0.6, `${label}: ${m.name} is exactly as wide as its content`);
    assert.deepEqual([m.column.top[0], ...m.column.sides], ['0px', '0px', '0px', '0px'], `${label}: ${m.name}: the content draws no second line or frame inside the card`);
  }
}
// What a person reads and uses on the cards, whatever the lines do.
function content(s, label, expected) {
  assert.deepEqual(s.members.map(m => [m.state, m.stateText]), expected.states, label + ': every member\'s state');
  assert.deepEqual(s.members.map(m => m.name.replace(/\s+/g, ' ')), expected.names, label + ': every member\'s name');
  assert.equal(s.members[0].child, expected.child, label + ': the working member\'s child task');
  for (const m of s.members) {
    assert.ok(m.nameFont >= 12 && m.stateFont >= 11, `${label}: ${m.name} is not set smaller (${m.nameFont}/${m.stateFont})`);
    assert.ok(m.more && m.more.w >= 18 && m.more.h >= 18, `${label}: ${m.name} keeps its menu button`);
  }
  assert.notEqual(s.members[1].stateColor, s.members[2].stateColor, label + ': waiting for confirmation keeps its own colour');
  assert.equal(s.spaceDraft, expected.spaceDraft, label + ': the space draft is kept');
}
// The column's input block: one line above the terminal at rest, and everything in it as it was.
function columns(s, label, expected) {
  s.members.forEach((m, i) => {
    const b = m.input; assert.ok(b, `${label}: ${m.name} has its input block`);
    assert.deepEqual(b.rule.slice(0, 2), ['1px', 'solid'], `${label}: ${m.name}: the block's top border is the line above the terminal`); assert.notEqual(b.rule[2], clear);
    assert.ok(b.sash && Math.abs(b.sash.box.h - 8) < 0.1, `${label}: ${m.name}: the drag handle keeps its 8px`);
    assert.deepEqual([b.sash.tab, b.sash.role, b.sash.cursor], [0, 'separator', 'row-resize'], `${label}: ${m.name}: the handle is still a separator reached by Tab`);
    assert.deepEqual([b.sash.hover, b.sash.focusVisible], [false, false], `${label}: the handle is at rest`);
    assert.equal(b.sash.line.color, clear, `${label}: ${m.name}: at rest the handle draws no second line`);
    assert.ok(Math.abs(b.sash.box.y - b.box.y - 1) < 0.6, `${label}: ${m.name}: the handle starts right under the line`);
    assert.ok(Math.abs(b.terminal.y - b.sash.box.bottom) < 0.6, `${label}: ${m.name}: the terminal sits directly under the handle (${b.terminal.y - b.sash.box.bottom})`);
    assert.ok(b.terminal.h >= 64, `${label}: ${m.name}: the terminal keeps a usable height (${b.terminal.h})`);
    assert.ok(Math.abs(b.area.box.h - 48) < 0.6 && b.area.font === 14, `${label}: ${m.name}: the input box keeps its height and type size (${b.area.box.h}/${b.area.font})`);
    assert.equal(b.area.value, i === 0 ? expected.privateDraft : '', `${label}: ${m.name}: the private draft`);
    assert.deepEqual(b.buttons.map(v => [v.text, v.disabled]), expected.buttons[i], `${label}: ${m.name}: the same controls, which say who has the input`);
    for (const v of b.buttons) assert.ok(v.box.h >= 24, `${label}: ${m.name}: ${v.text} keeps its height (${v.box.h})`);
    assert.equal(Boolean(b.hint), expected.hints[i], `${label}: ${m.name}: the hint under the input`);
    assert.ok(m.messages && m.messages.box.h >= 20 && m.messages.font === expected.messageFont && m.messages.originals.join() === '6,6', `${label}: ${m.name}: all six original messages, in both languages, at the same type size (${m.messages?.box.h}/${m.messages?.font}/${m.messages?.originals})`);
    assert.ok(m.messages.box.bottom <= b.box.y + 0.6 && b.box.bottom <= m.column.box.bottom + 0.6, `${label}: ${m.name}: conversation, line, terminal and input stay inside the column, in that order`);
  });
}
async function language(code) {
  await page.locator('#setup-button').click(); await page.locator('#ui-language').selectOption(code);
  await until(async () => (await page.locator('#setup-title').textContent()) === (code === 'en' ? 'Settings' : '设置'), 'The interface language changed'); await page.locator('#close-setup').click(); await settled();
}
async function run() {
  profile = scratch.directory(path.join(os.tmpdir(), 'naw-member-card-lines-')); const cwd = path.join(profile, 'workspace'); fs.mkdirSync(cwd, { mode: 0o700 });
  child = scratch.childProcess.fork(path.join(root, 'app/daemon.cjs'), [profile], { cwd, execArgv: ['--require', path.join(__dirname, 'fixtures/collaboration-overview.cjs')],
    env: env({ NAW_TEST_APP_ROOT: root, NAW_WORKSPACE: cwd, NAW_APP_VERSION: require('../package.json').version }), stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Synthetic backend ready');
  client = await require('../app/service-client.cjs').connect(profile, 'member-card-lines-seed');
  const names = ['发布核对 · Release check', '回归排查', 'Docs_and_changelog_writer_with_a_long_name', '集成'], members = [];
  for (const [i, name] of names.entries()) { const id = await client.call('create', { provider: i % 2 ? 'codex' : 'claude', cwd, name, view: 'chat' }); await client.call('join', id, true); members.push(id); }
  const [a, b, c, d] = members, privateDraft = 'UNSENT private draft for one member · 尚未发送给这个成员的草稿', spaceDraft = 'UNSENT space draft · 尚未发送到空间的草稿';
  await client.call('draft', a, privateDraft);
  const entry = createSourceEntry({ profile, code: root, fixturePid: child.pid }), entryFile = path.join(entry, 'entry.cjs');
  fs.writeFileSync(entryFile, `const e=require('electron');e.Notification.isSupported=()=>false;globalThis.memberCardLines={guards:[]};` +
    `for(const key of ['showOpenDialog','showSaveDialog','showMessageBox','showOpenDialogSync','showSaveDialogSync','showMessageBoxSync'])e.dialog[key]=()=>{memberCardLines.guards.push(key);throw Error('OS dialog outside this check');};\n` + fs.readFileSync(entryFile, 'utf8'));
  app = await _electron.launch({ executablePath: require('electron'), args: [entry], env: env({ NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid), NAW_TEST_VISIBLE: '0', NAW_TEST_UI_LANGUAGE: 'zh' }), timeout: 60000 });
  await until(async () => { for (const p of app.windows()) if (!p.isClosed() && await p.locator('#new-session').count()) { page = p; return true; } return false; }, 'The workspace page');
  page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
  assert.deepEqual(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ visible: w.isVisible(), focusable: w.isFocusable() }))), [{ visible: false, focusable: false }], 'The window is hidden and cannot take focus');
  await size(1240, 850);
  // Four members in four states: working with a child task, waiting for the person, ready, and failed.
  for (const [id, letter] of [[a, 'A'], [b, 'B'], [c, 'C'], [d, 'D']]) for (let i = 0; i < 6; i++) child.send({ id: ++sequence, method: 'nativeBlock', target: id, value: { id: `response:${i}`, kind: 'response', turnId: `turn-${letter}`, status: 'complete',
    text: `成员 ${letter} 的第 ${i + 1} 条原文：核对发布说明第 ${i + 1} 节，结果和当前实现一致。\n\nOriginal message ${i + 1} of member ${letter}.` } });
  child.send({ id: ++sequence, method: 'fleet', target: a, value: { event: 'SubagentStart', id: 'child-a', name: '跑全量测试', stale: false } }); child.send({ id: ++sequence, method: 'state', target: a, value: 'working' });
  child.send({ id: ++sequence, method: 'approval', target: b, value: { id: 'approval-b', kind: 'command', command: 'rm -rf build/ (synthetic, nothing runs)', cwd } }); child.send({ id: ++sequence, method: 'state', target: d, value: 'error' });
  await revealDefaultSpace(page); await page.locator('#room-nav').click(); await page.locator('#collaboration-overview .collaboration-member-reader').nth(3).waitFor();
  // This window has the input for three members; the second stays with another window, so its column is read-only.
  for (const id of [a, c, d]) await page.evaluate(member => workspace.claim(member, 'chat'), id);
  await until(async () => { const state = await page.evaluate(() => workspace.initial()), owner = id => state.sessions.find(v => v.id === id).owner; return [a, c, d].every(id => owner(id) && owner(id) !== owner(b)); }, 'This window has the input for three members');
  await fillRoomMessage(page, spaceDraft);
  const host = page.locator('#collaboration-overview'), flag = name => host.evaluate((e, n) => e.dataset[n], name), sash = page.locator('#collaboration-overview .column-terminal-sash').first();
  await until(async () => { const s = await sample(); return s.members.length === 4 && s.members.every(m => m.input && m.messages && m.messages.originals.join() === '6,6') && s.members[0].state === 'working' && s.members[1].state === 'approval' && s.members[3].state === 'error'; }, 'Four member columns with their states');
  await page.mouse.move(2, 2); await settled();
  const before = (await fixture('stats')).overviewCalls, identityBefore = await page.evaluate(async () => (await workspace.initial()).sessions.map(v => [v.id, v.nativeId, v.owner, v.name]));
  let s = await sample();
  const zh = { names: s.members.map(m => m.name.replace(/\s+/g, ' ')), child: '1 个子任务进行中', spaceDraft, privateDraft, messageFont: s.members[0].messages.font,
    states: [['working', '正在工作'], ['approval', '等待确认'], ['idle', '会话就绪'], ['error', '需要检查']],
    buttons: [[['原生输入', false], ['发送 ↑', true]], [['接管此窗口', false]], [['原生输入', false], ['发送 ↑', true]], [['打开原生终端', false]]], hints: [true, true, false, true] };
  assert.ok(zh.names[0].startsWith('发布核对') && zh.names[3].startsWith('集成'), 'The members\' own names are on their cards');

  // 1) Grid layout: one line between a name and its column.
  assert.deepEqual([s.flags.list, s.flags.focused, s.flags.brief], ['false', 'false', 'false']);
  content(s, 'grid', zh); cards(s, 'grid');
  await capture('01-grid-zh');
  check('Grid: each member is one bordered card; its name row is inside it and the row\'s bottom rule is the one line above its content; names, states, child task and menu buttons are as before');

  // 2) Between conversation and terminal: one line at rest, with the terminal directly under the handle.
  columns(s, 'grid', zh);
  check('Grid: at rest the input block\'s top border is the only line above each terminal; drafts, hints, controls, input height and type sizes are as before');

  // 3) Pointing at the handle shows what it showed before: its thick dark line, the guide across the columns on that line, and the hint.
  await sash.hover(); await settled(); s = await sample();
  let h = s.members[0].input.sash;
  assert.equal(h.hover, true); assert.deepEqual([h.line.width, h.line.top, h.line.left, h.line.right], ['2px', '3px', '8px', '8px'], 'Pointed at: the handle\'s thick line, inset as before'); assert.notEqual(h.line.color, clear);
  const ink = h.line.color;
  assert.ok(s.guide && Math.abs(s.guide.y - (h.box.y + h.box.h / 2)) < 1 && Math.abs(s.guide.y - (h.box.y + 3)) <= 2, `Pointed at: the guide across the columns runs through the handle's line (${s.guide?.y} at ${h.box.y})`);
  assert.ok(s.tip.length > 8, 'Pointed at: the hint that says how to drag and align');
  assert.equal(s.members[1].input.sash.line.color, clear, 'Only the handle pointed at draws its line');
  await capture('02-handle-pointed-zh');
  await page.mouse.move(2, 2); await settled(); s = await sample(); assert.equal(s.members[0].input.sash.line.color, clear, 'Leaving the handle returns it to one line'); assert.equal(s.guide, null);
  check('Pointing at the drag handle shows its thick line, the guide through it and the hint, as before; leaving it returns to one line');

  // 4) Reaching the handle with the keyboard shows the same line and the focus outline.
  await page.keyboard.press('Shift'); await sash.focus(); await settled(); s = await sample(); h = s.members[0].input.sash;
  assert.equal(h.focusVisible, true, 'The handle takes keyboard focus'); assert.deepEqual([h.line.width, h.line.color, h.line.top], ['2px', ink, '3px'], 'Focused: the same thick line'); assert.equal(h.outline, 'solid 2px', 'Focused: the outline');
  assert.ok(s.guide && s.tip.length > 8, 'Focused: the guide and the hint');
  await capture('03-handle-focused-zh');
  await sash.evaluate(e => e.blur()); await settled();
  check('Keyboard focus on the drag handle shows the same thick line, the outline, the guide and the hint');

  // 5) A real drag: the terminal grows, and a dark line stays on the handle for the whole drag.
  const tall = (await sample()).members[0].input.terminal.h, grip = await sash.boundingBox(), x = grip.x + grip.width / 2, y = grip.y + grip.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  for (let n = 1; n <= 6; n++) await page.mouse.move(x, y - 6 * n);
  await settled(); s = await sample(); h = s.members[0].input.sash;
  assert.ok(s.members[0].input.terminal.h >= tall + 20, `Dragging up makes the terminal taller (${tall} to ${s.members[0].input.terminal.h})`);
  assert.ok(s.guide && Math.abs(s.guide.y - (h.box.y + h.box.h / 2)) < 1, 'Mid-drag: the guide stays on the handle');
  if (h.hover) assert.deepEqual([h.line.width, h.line.color], ['2px', ink], 'Mid-drag: while the handle counts as pointed at, its thick line is drawn');
  const held = h.hover;
  await capture('04-handle-dragging-zh');
  for (let n = 5; n >= 0; n--) await page.mouse.move(x, y - 6 * n);
  await page.mouse.up(); await page.mouse.move(2, 2); await settled(); s = await sample();
  assert.ok(Math.abs(s.members[0].input.terminal.h - tall) <= 2, `Dragging back returns the terminal to its height (${s.members[0].input.terminal.h} of ${tall})`);
  assert.equal(s.members[0].input.sash.line.color, clear, 'After the drag the handle is back to one line');
  columns(s, 'after a drag', zh);
  check(`Dragging the handle resizes the terminal with the guide on the handle throughout (handle counted as pointed at mid-drag: ${held}); afterwards one line again`);

  // 6) Simplified information: the same cards with a short summary; one line between each name and its content.
  await page.getByRole('button', { name: '简化信息', exact: true }).click(); await until(async () => await flag('brief') === 'true', 'Simplified information is on'); await settled();
  s = await sample(); content(s, 'simplified', zh); cards(s, 'simplified'); assert.ok(s.members.every(m => !m.input), 'Simplified: no column input, as before');
  await capture('05-simplified-zh');
  await page.getByRole('button', { name: '简化信息', exact: true }).click(); await until(async () => await flag('brief') === 'false', 'Simplified information is off'); await settled();
  check('Simplified information: the same cards, one line between each name and its content');

  // 7) List layout: one bordered unit per member, as before.
  await page.locator('.collaboration-layout-controls button').nth(1).click(); await until(async () => await flag('listUnits') === 'true', 'The list layout'); await settled();
  s = await sample(); content(s, 'list', zh);
  assert.equal(s.strip, null, 'List: no separate row of names');
  for (const m of s.members) { assert.ok(m.unit && m.unit.borders.every(v => v === '1px'), `list: ${m.name} is one bordered unit`); assert.deepEqual(m.borders, ['0px', '0px', '0px', '0px']); assert.ok(m.row.y >= m.unit.box.y && m.column.box.bottom <= m.unit.box.bottom + 0.6, `list: ${m.name}: name and content are inside the unit`); }
  await capture('06-list-zh');
  await page.locator('.collaboration-layout-controls button').nth(0).click(); await until(async () => await flag('listUnits') === 'false', 'The grid layout again'); await settled();
  check('List layout: each member is still one bordered unit holding its name and content');

  // 8) One member opened and back: the overview gives way to that member's session; on return the single lines are there again.
  await page.locator(`#collaboration-overview .collaboration-member-status[data-member-id="${c}"] .collaboration-member-name`).click(); await until(async () => await flag('focused') === 'true', 'One member is opened'); await settled();
  assert.equal(await host.isVisible(), false, 'With one member opened the overview and its name rows are not shown'); await page.locator('#conversation-pane').waitFor();
  await capture('07-one-member-opened-zh');
  await page.locator('#room-overview').click(); await until(async () => await flag('focused') === 'false', 'Back to the whole space'); await page.locator('#collaboration-overview .collaboration-member-reader').nth(3).waitFor(); await settled();
  await page.mouse.move(2, 2); await settled();
  s = await sample(); content(s, 'back to the grid', zh); cards(s, 'back to the grid'); columns(s, 'back to the grid', zh);
  check('One member opened and back: the overview is replaced by that member\'s session, and on return every card has its single lines, drafts and controls');

  // 9) A narrow container: since 8ef6ac7a the cards stay side by side while each has 140px, otherwise they wrap.
  //    Either way each card keeps its own name. The window cannot be made that narrow (its minimum width is 850),
  //    so the overview itself is held to 590px.
  await host.evaluate(e => { e.style.width = '590px'; }); await settled();
  s = await sample(); assert.ok(s.width <= 600); content(s, 'narrow container', zh); cards(s, 'narrow container');
  for (const m of s.members) assert.ok(m.unit.box.w >= 130, `Narrow container: ${m.name}'s card keeps a readable width (${m.unit.box.w})`);
  for (const m of s.members) assert.equal(m.input.sash.line.color, clear, 'Narrow container: still one line above each terminal');
  await capture('08-narrow-container-zh');
  await host.evaluate(e => { e.style.width = ''; }); await settled();
  check('Narrow container: each card keeps its name inside with one line under it; one line above each terminal');

  // 10) English and the small window.
  await language('en'); await size(850, 600); await page.mouse.move(2, 2); await settled();
  s = await sample();
  const en = { ...zh, child: '1 subtasks running', states: [['working', 'Working'], ['approval', 'Awaiting approval'], ['idle', 'Session ready'], ['error', 'Needs attention']],
    buttons: [[['Native input', false], ['Send ↑', true]], [['Take control here', false]], [['Native input', false], ['Send ↑', true]], [['Open native terminal', false]]] };
  content(s, 'en 850x600', en); cards(s, 'en 850x600'); columns(s, 'en 850x600', en);
  await capture('09-small-en');
  await size(1240, 850); await language('zh'); await settled();
  s = await sample(); content(s, 'zh again', zh); cards(s, 'zh again'); columns(s, 'zh again', zh);
  check('English in the small window, then Chinese again: the same single lines, texts, states, drafts and controls');

  // Looking at the overview, pointing, focusing and resizing a terminal sent nothing and gave no input to any session.
  const after = (await fixture('stats')).overviewCalls;
  for (const key of ['send', 'queue', 'steer', 'forward', 'approve', 'answer', 'run', 'resume', 'pause', 'input']) assert.equal(after[key], before[key], `No ${key} call was made`);
  assert.deepEqual(await page.evaluate(async () => (await workspace.initial()).sessions.map(v => [v.id, v.nativeId, v.owner, v.name])), identityBefore, 'The sessions and who has their input are unchanged');
  assert.deepEqual(await app.evaluate(() => globalThis.memberCardLines.guards), []); assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ checks, errors, calls: { before, after }, modelCalls: 0 }, null, 2));
}
const cleanup = scratch.cleanup(async () => { if (app) await app.close(); client?.close(); if (child?.connected) child.disconnect(); if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); });
let deadline;
Promise.race([run(), new Promise((_, reject) => { deadline = setTimeout(() => reject(Error('180-second GUI budget exhausted')), 180000); })])
  .catch(async error => { console.error(error.stack); fs.writeFileSync(path.join(evidence, 'failure.txt'), error.stack); try { if (page && !page.isClosed()) await capture('failure'); } catch { /* The page is gone. */ } process.exitCode = 1; })
  .finally(async () => {
    clearTimeout(deadline);
    try {
      await cleanup();
      assert.equal(JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))).token, token); if (profile) assert.equal(fs.existsSync(profile), false);
      fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot);
      console.log(JSON.stringify({ checks, modelCalls: 0, realProviderProcesses: 0, slotReleased: true }));
    } catch (error) { console.error('Owned cleanup/lease release unconfirmed:', error.stack); process.exitCode = 1; }
  });
