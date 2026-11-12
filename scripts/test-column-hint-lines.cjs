// T-163: the hint under a member column's input in a space's member overview (grid layout). Source Electron in
// a hidden window, the synthetic overview backend, no provider process and no model. The hint says who has the
// input or what went wrong and what to do. Up to four lines of it are shown where the column has the height for
// them beside an 80px conversation and a 64px terminal, never fewer than the two shown before; a longer hint
// scrolls inside them. Checks that, and what must stay as it was: the hint's text and type size, the controls,
// the drafts, and a column that still holds its conversation, terminal and input when a hint appears, the window
// is small or the space has six members.
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
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ token, owner: 'Claude3', task: 'T163 column hint lines', pid: process.pid, at: new Date().toISOString() }));
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
const LINE = 16, MOST = 4;
// Each member's column as laid out now: the conversation, the terminal, the input block and the hint in it.
const sample = () => page.evaluate(() => {
  const shown = e => Boolean(e && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden');
  const box = e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, bottom: r.bottom }; };
  const host = document.querySelector('#collaboration-overview');
  const members = [...host.querySelectorAll('.collaboration-member-status')].filter(shown).map(row => {
    const id = row.dataset.memberId, column = [...host.querySelectorAll('.collaboration-member-reader')].find(e => e.dataset.memberId === id && shown(e));
    const block = column?.querySelector('.collaboration-member-input'), list = column?.querySelector('.messages');
    const hint = block?.querySelector('.session-compose-hint'), terminal = block?.querySelector('.column-native-host'), area = block?.querySelector('.session-message-input'), hs = shown(hint) ? getComputedStyle(hint) : null;
    return { id, state: row.dataset.state || '', name: row.querySelector('.collaboration-member-name')?.textContent.trim() || '', column: column ? box(column) : null,
      messages: shown(list) ? box(list) : null, atEnd: shown(list) ? list.scrollTop + list.clientHeight >= list.scrollHeight - 2 : null, block: shown(block) ? box(block) : null, terminal: shown(terminal) ? box(terminal) : null,
      area: shown(area) ? { h: box(area).h, value: area.value } : null, allow: shown(block) ? Number(getComputedStyle(block).getPropertyValue('--column-hint-lines')) || null : null,
      hint: hs ? { text: hint.textContent.trim(), shown: hint.clientHeight, whole: hint.scrollHeight, font: hs.fontSize, line: hs.lineHeight, overflow: hs.overflowY, colour: hs.color, box: box(hint) } : null,
      buttons: shown(block) ? [...block.querySelectorAll('button')].filter(shown).map(b => [b.textContent.trim(), b.disabled]) : [] };
  });
  return { members, list: host.dataset.listUnits, spaceDraft: document.querySelector('#shared-input').value, window: [innerWidth, innerHeight] };
});
// Up to `most` lines are shown whole (four where the column has the height); a longer hint keeps that many and
// scrolls inside them. Same type as before.
function hintLines(h, label, most = MOST) {
  assert.deepEqual([h.font, h.line], ['12px', '16px'], `${label}: the hint keeps its type size and line height`);
  const lines = Math.round(h.whole / LINE);
  if (lines <= most) assert.ok(h.whole <= h.shown + 1, `${label}: a hint of ${lines} line(s) is shown whole (${h.shown} of ${h.whole}px)`);
  else { assert.ok(Math.abs(h.shown - most * LINE) < 0.6, `${label}: a hint of ${lines} lines shows ${most} (${h.shown}px)`); assert.equal(h.overflow, 'auto', `${label}: the rest of a longer hint can be scrolled to`); }
  return lines;
}
// With four members every column has the height for four lines, down to the smallest window.
const fourLines = (s, label) => { for (const m of s.members) assert.equal(m.allow, MOST, `${label}: ${m.name}: the column has room for a four-line hint`); };
// A column holds its conversation, its terminal and its input, in that order and inside its frame.
function column(m, label, conversation) {
  assert.ok(m.messages && m.block && m.terminal, `${label}: ${m.name} has its conversation, terminal and input`);
  assert.ok(m.terminal.h >= 63.5, `${label}: ${m.name}: the terminal keeps its 64px (${m.terminal.h})`);
  assert.ok(m.messages.h >= conversation - 0.5, `${label}: ${m.name}: the conversation keeps ${conversation}px (${m.messages.h})`);
  assert.ok(m.messages.bottom <= m.block.y + 0.6 && m.block.bottom <= m.column.bottom + 0.6, `${label}: ${m.name}: conversation, terminal and input stay inside the column, in that order`);
  assert.ok(Math.abs(m.area.h - 48) < 0.6, `${label}: ${m.name}: the input box keeps its height (${m.area.h})`);
  assert.equal(m.atEnd, true, `${label}: ${m.name}: the conversation is still at its end`);
}
async function language(code) {
  await page.locator('#setup-button').click(); await page.locator('#ui-language').selectOption(code);
  await until(async () => (await page.locator('#setup-title').textContent()) === (code === 'en' ? 'Settings' : '设置'), 'The interface language changed'); await page.locator('#close-setup').click(); await settled();
}
// Every hint the composer can show, put into one column's hint in turn: how many lines it needs there, how many
// are shown, and what the column keeps once the app has laid itself out again.
async function everyHint(lang, memberId) {
  const catalog = require('../app/ui-messages.js')[lang], keys = Object.keys(catalog).filter(key => /^composer\..*Hint$/.test(key) && key !== 'composer.keyboardHint');
  assert.ok(keys.length >= 20, 'The composer\'s hints are in the message catalog');
  const rows = await page.evaluate(async ({ texts, memberId }) => {
    const reader = [...document.querySelectorAll('#collaboration-overview .collaboration-member-reader')].find(e => e.dataset.memberId === memberId);
    const hint = reader.querySelector('.collaboration-member-input .session-compose-hint'), list = reader.querySelector('.messages'), terminal = reader.querySelector('.column-native-host'), block = reader.querySelector('.collaboration-member-input');
    const keep = hint.textContent, out = [], frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    for (const text of texts) {
      hint.textContent = text; window.dispatchEvent(new Event('resize')); await frame();
      out.push({ whole: hint.scrollHeight, shown: hint.clientHeight, conversation: list.getBoundingClientRect().height, terminal: terminal.getBoundingClientRect().height, inside: block.getBoundingClientRect().bottom <= reader.getBoundingClientRect().bottom + 0.6 });
    }
    hint.textContent = keep; window.dispatchEvent(new Event('resize')); await frame();
    return out;
  }, { texts: keys.map(key => catalog[key]), memberId });
  return rows.map((row, i) => ({ key: keys[i], lines: Math.round(row.whole / LINE), ...row }));
}
async function run() {
  profile = scratch.directory(path.join(os.tmpdir(), 'naw-column-hint-lines-')); const cwd = path.join(profile, 'workspace'); fs.mkdirSync(cwd, { mode: 0o700 });
  child = scratch.childProcess.fork(path.join(root, 'app/daemon.cjs'), [profile], { cwd, execArgv: ['--require', path.join(__dirname, 'fixtures/collaboration-overview.cjs')],
    env: env({ NAW_TEST_APP_ROOT: root, NAW_WORKSPACE: cwd, NAW_APP_VERSION: require('../package.json').version }), stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Synthetic backend ready');
  client = await require('../app/service-client.cjs').connect(profile, 'column-hint-lines-seed');
  const names = ['发布核对 · Release check', '回归排查', 'Docs_and_changelog_writer_with_a_long_name', '集成'], members = [];
  for (const [i, name] of names.entries()) { const id = await client.call('create', { provider: i % 2 ? 'codex' : 'claude', cwd, name, view: 'chat' }); await client.call('join', id, true); members.push(id); }
  const [a, b, c, d] = members, privateDraft = 'UNSENT private draft for one member · 尚未发送给这个成员的草稿', spaceDraft = 'UNSENT space draft · 尚未发送到空间的草稿';
  await client.call('draft', a, privateDraft);
  const entry = createSourceEntry({ profile, code: root, fixturePid: child.pid }), entryFile = path.join(entry, 'entry.cjs');
  fs.writeFileSync(entryFile, `const e=require('electron');e.Notification.isSupported=()=>false;globalThis.columnHintLines={guards:[]};` +
    `for(const key of ['showOpenDialog','showSaveDialog','showMessageBox','showOpenDialogSync','showSaveDialogSync','showMessageBoxSync'])e.dialog[key]=()=>{columnHintLines.guards.push(key);throw Error('OS dialog outside this check');};\n` + fs.readFileSync(entryFile, 'utf8'));
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
  // This window has the input for three members; the second stays with another window, so its column is read-only.
  for (const id of [a, c, d]) await page.evaluate(member => workspace.claim(member, 'chat'), id);
  await until(async () => { const state = await page.evaluate(() => workspace.initial()), owner = id => state.sessions.find(v => v.id === id).owner; return [a, c, d].every(id => owner(id) && owner(id) !== owner(b)); }, 'This window has the input for three members');
  await fillRoomMessage(page, spaceDraft);
  await until(async () => { const s = await sample(); return s.members.length === 4 && s.members.every(m => m.block && m.messages) && s.members[0].state === 'working' && s.members[1].state === 'approval' && s.members[3].state === 'error' && s.members[3].hint; }, 'Four member columns with their states');
  await page.mouse.move(2, 2); await settled();
  const before = (await fixture('stats')).overviewCalls, identityBefore = await page.evaluate(async () => (await workspace.initial()).sessions.map(v => [v.id, v.nativeId, v.owner, v.name]));
  const zhButtons = [[['原生输入', false], ['发送 ↑', true]], [['接管此窗口', false]], [['原生输入', false], ['发送 ↑', true]], [['打开原生终端', false]]];
  const zhHints = { working: '当前原生连接不能在回复中发送。草稿保留，空闲后再发送。', readOnly: '此窗口只读。接管后继续使用原会话，草稿保留。' };
  const kept = (s, label, buttons) => {
    assert.equal(s.spaceDraft, spaceDraft, label + ': the space draft is kept'); assert.equal(s.members[0].area.value, privateDraft, label + ': the private draft is kept');
    assert.deepEqual(s.members.map(m => m.buttons), buttons, label + ': the same controls, which say who has the input');
  };

  // 1) The default window: the failed member's hint needs three lines there, and all three are shown.
  let s = await sample(); kept(s, 'zh 1240x850', zhButtons); fourLines(s, 'zh 1240x850');
  assert.deepEqual([s.members[0].hint.text, s.members[1].hint.text, s.members[2].hint], [zhHints.working, zhHints.readOnly, null], 'The working and the read-only member say so; the ready member has no hint');
  assert.ok(s.members[3].hint.text.startsWith('原生请求未完成。') && s.members[3].hint.text.includes('打开终端'), 'The failed member\'s hint says what to do');
  measured['zh-1240x850'] = s.members.map(m => m.hint ? hintLines(m.hint, 'zh 1240x850 ' + m.name) : 0);
  assert.ok(measured['zh-1240x850'][3] >= 3, `The failed member's hint needs three lines or more in a ${Math.round(s.members[3].column.w)}px column (${measured['zh-1240x850'][3]})`);
  for (const m of s.members) column(m, 'zh 1240x850', 80);
  assert.equal(s.members[1].hint.colour, s.members[3].hint.colour, 'A hint keeps its colour whatever its length');
  await capture('01-default-zh');
  check('In the default window the failed member\'s three-line hint is shown whole; the others are as they were; every column keeps conversation, terminal and input');

  // 2) Smaller windows: the columns are narrower, the same hint needs four lines, and all four are shown.
  for (const [width, height] of [[1000, 700], [850, 600]]) {
    await size(width, height); s = await sample(); kept(s, `zh ${width}x${height}`, zhButtons); fourLines(s, `zh ${width}x${height}`);
    measured[`zh-${width}x${height}`] = s.members.map(m => m.hint ? hintLines(m.hint, `zh ${width}x${height} ${m.name}`) : 0);
    for (const m of s.members) column(m, `zh ${width}x${height}`, 80);
  }
  assert.equal(measured['zh-850x600'][3], 4, 'In the smallest window the failed member\'s hint needs four lines');
  await capture('02-small-zh');
  check('At 1000x700 and 850x600 the hints are shown whole, up to four lines, and every column keeps an 80px conversation and a terminal of 64px or more');

  // 3) A hint that appears while the window stays as it is: the ready member fails. Its terminal gives the room.
  const readyBefore = s.members[2]; assert.equal(readyBefore.hint, null);
  tell('state', c, 'error');
  await until(async () => (await sample()).members[2].hint, 'The member that failed shows its hint'); await settled();
  s = await sample(); const failed = s.members[2];
  assert.equal(hintLines(failed.hint, 'zh 850x600 the member that just failed'), 4);
  column(failed, 'zh 850x600 after a member failed', 80);
  assert.ok(failed.terminal.h < readyBefore.terminal.h, `The terminal made room for the hint (${readyBefore.terminal.h} -> ${failed.terminal.h})`);
  for (const m of s.members) column(m, 'zh 850x600 after a member failed', 80);
  await capture('03-small-zh-hint-appears');
  check('When a hint appears in the smallest window, that column\'s terminal gives the room and its conversation stays 80px');

  // The interface language changes while the window stays: the hints get longer in English, and the columns make
  // room for them without waiting for anything else to be drawn.
  await language('en'); await settled();
  s = await sample(); fourLines(s, 'en 850x600 right after the switch');
  for (const m of s.members) { if (m.hint) hintLines(m.hint, 'en 850x600 right after the switch: ' + m.name); column(m, 'en 850x600 right after the switch', 80); }
  await language('zh'); await settled();
  s = await sample(); for (const m of s.members) column(m, 'zh 850x600 after switching back', 80);
  check('Switching the interface language in the smallest window: the columns make room for the longer hints at once, and every conversation stays 80px');

  // The columns were hidden (the shared records page) while the window changed size, and are shown again: the
  // hints have their lines back and every conversation is at its end, as it was.
  await page.locator('#room-record').click(); await until(async () => (await sample()).members.every(m => !m.block), 'The shared records page hides the columns');
  await size(1240, 850); await size(850, 600);
  await page.locator('#room-overview').click(); await until(async () => { const v = await sample(); return v.members.length === 4 && v.members.every(m => m.block && m.messages && m.terminal); }, 'The member overview again'); await settled();
  s = await sample(); fourLines(s, 'zh 850x600 back from the records page');
  for (const m of s.members) { if (m.hint) hintLines(m.hint, 'zh 850x600 back from the records page: ' + m.name); column(m, 'zh 850x600 back from the records page', 80); }
  check('After the shared records page and a window resize while the columns were hidden, the hints show their four lines again and every conversation is at its end');

  // 4) Every hint of the Chinese interface, in the smallest window and in the default one.
  for (const [width, height] of [[850, 600], [1240, 850]]) {
    await size(width, height);
    const rows = await everyHint('zh', d);
    for (const row of rows) {
      assert.ok(row.lines <= MOST, `zh ${width}x${height}: ${row.key} needs ${row.lines} lines; with four members no Chinese hint needs more than four`);
      assert.ok(row.whole <= row.shown + 1, `zh ${width}x${height}: ${row.key} is shown whole`);
      assert.ok(row.conversation >= 79.5 && row.terminal >= 63.5 && row.inside, `zh ${width}x${height}: ${row.key} leaves the conversation ${row.conversation}px and the terminal ${row.terminal}px, inside the column`);
    }
    measured[`zh-${width}x${height}-every-hint`] = { hints: rows.length, mostLines: Math.max(...rows.map(row => row.lines)), threeOrMore: rows.filter(row => row.lines >= 3).length };
  }
  check('With four members every hint of the Chinese interface is shown whole in both window sizes, and the column keeps its conversation and terminal');

  // 5) English: longer sentences. More than four lines keep four and scroll; the conversation is not pushed under 80px.
  await language('en'); await size(850, 600); await page.mouse.move(2, 2); await settled();
  s = await sample();
  const enButtons = [[['Native input', false], ['Send ↑', true]], [['Take control here', false]], [['Open native terminal', false]], [['Open native terminal', false]]];
  kept(s, 'en 850x600', enButtons); fourLines(s, 'en 850x600');
  measured['en-850x600'] = s.members.map(m => m.hint ? hintLines(m.hint, 'en 850x600 ' + m.name) : 0);
  assert.ok(measured['en-850x600'][3] > MOST, `The failed member's English hint needs more than four lines in the smallest window (${measured['en-850x600'][3]})`);
  for (const m of s.members) column(m, 'en 850x600', 80);
  // The lines beyond the fourth can be scrolled to, and scrolling moves nothing else.
  const scrolled = await page.evaluate(memberId => { const reader = [...document.querySelectorAll('#collaboration-overview .collaboration-member-reader')].find(e => e.dataset.memberId === memberId), hint = reader.querySelector('.collaboration-member-input .session-compose-hint');
    hint.scrollTop = hint.scrollHeight; const end = hint.scrollTop + hint.clientHeight; hint.scrollTop = 0; return [end, hint.scrollHeight]; }, d);
  assert.ok(Math.abs(scrolled[0] - scrolled[1]) <= 1, 'The last line of a longer hint can be scrolled into view');
  await capture('04-small-en');
  let rows = await everyHint('en', d);
  for (const row of rows) {
    if (row.lines <= MOST) assert.ok(row.whole <= row.shown + 1, `en 850x600: ${row.key} (${row.lines} lines) is shown whole`); else assert.ok(Math.abs(row.shown - MOST * LINE) < 0.6, `en 850x600: ${row.key} (${row.lines} lines) shows four`);
    assert.ok(row.conversation >= 79.5 && row.terminal >= 63.5 && row.inside, `en 850x600: ${row.key} leaves the conversation ${row.conversation}px and the terminal ${row.terminal}px, inside the column`);
  }
  measured['en-850x600-every-hint'] = { hints: rows.length, mostLines: Math.max(...rows.map(row => row.lines)), overFour: rows.filter(row => row.lines > MOST).length, shownWhole: rows.filter(row => row.lines <= MOST).length };
  await size(1240, 850); rows = await everyHint('en', d);
  for (const row of rows) { if (row.lines <= MOST) assert.ok(row.whole <= row.shown + 1, `en 1240x850: ${row.key} is shown whole`); assert.ok(row.conversation >= 79.5 && row.terminal >= 63.5 && row.inside, `en 1240x850: ${row.key} keeps the column`); }
  measured['en-1240x850-every-hint'] = { hints: rows.length, mostLines: Math.max(...rows.map(row => row.lines)), overFour: rows.filter(row => row.lines > MOST).length, shownWhole: rows.filter(row => row.lines <= MOST).length };
  await language('zh'); await settled();
  check('In English a hint of up to four lines is shown whole and a longer one keeps four lines and scrolls; in the smallest window every column still has an 80px conversation');

  // 6) Six members: narrower columns, and in the smallest window no height to spare. There a hint keeps the two
  //    lines it had, and the conversation is not made lower than it was.
  for (const [name, provider] of [['测试覆盖 · Coverage', 'claude'], ['Perf_benchmarks', 'codex']]) { const id = await client.call('create', { provider, cwd, name, view: 'chat' }); await client.call('join', id, true); }
  await until(async () => { const v = await sample(); return v.members.length === 6 && v.members.every(m => m.block && m.messages && m.terminal); }, 'Six member columns'); await settled();
  s = await sample(); assert.equal(s.window.join('x'), '1240x850');
  for (const m of s.members) { assert.equal(m.allow, MOST, `zh 1240x850, six members: ${m.name} has room for four lines`); if (m.hint) hintLines(m.hint, 'zh 1240x850, six members: ' + m.name); column(m, 'zh 1240x850, six members', 80); }
  measured['zh-1240x850-six'] = { allow: s.members.map(m => m.allow), lines: s.members.map(m => m.hint ? Math.round(m.hint.whole / LINE) : 0), conversation: s.members.map(m => Math.round(m.messages.h)), terminal: s.members.map(m => Math.round(m.terminal.h)) };
  await capture('05-six-members-zh');
  await size(850, 600); s = await sample();
  for (const m of s.members) {
    assert.ok(m.allow >= 2 && m.allow <= MOST, `zh 850x600, six members: ${m.name} shows between two and four lines (${m.allow})`);
    if (m.hint) hintLines(m.hint, 'zh 850x600, six members: ' + m.name, m.allow); column(m, 'zh 850x600, six members', 80);
  }
  measured['zh-850x600-six'] = { allow: s.members.map(m => m.allow), lines: s.members.map(m => m.hint ? Math.round(m.hint.whole / LINE) : 0), conversation: s.members.map(m => Math.round(m.messages.h)), terminal: s.members.map(m => Math.round(m.terminal.h)) };
  assert.ok(s.members.some(m => m.hint && m.allow < MOST && Math.round(m.hint.whole / LINE) > m.allow), 'In the smallest window with six members a column has no room for all of a long hint, and shows what fits');
  await capture('06-six-members-small-zh');
  await size(1240, 850); await settled();
  check('Six members: four lines where the columns are high enough; in the smallest window a hint shows the lines that fit (two or more), and every conversation is still 80px with a terminal of 64px or more');

  // Looking, resizing and the member that failed sent nothing and gave no input to any session.
  const after = (await fixture('stats')).overviewCalls;
  for (const key of ['send', 'queue', 'steer', 'forward', 'approve', 'answer', 'run', 'resume', 'pause', 'input']) assert.equal(after[key], before[key], `No ${key} call was made`);
  assert.deepEqual((await page.evaluate(async () => (await workspace.initial()).sessions.map(v => [v.id, v.nativeId, v.owner, v.name]))).slice(0, 4), identityBefore, 'The first four sessions and who has their input are unchanged');
  assert.deepEqual(await app.evaluate(() => globalThis.columnHintLines.guards), []); assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ checks, errors, measured, calls: { before, after }, modelCalls: 0 }, null, 2));
}
const cleanup = scratch.cleanup(async () => { if (app) await app.close(); client?.close(); if (child?.connected) child.disconnect(); if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); });
let deadline;
Promise.race([run(), new Promise((_, reject) => { deadline = setTimeout(() => reject(Error('180-second GUI budget exhausted')), 180000); })])
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
