// T-163: the single-session page's conversation/terminal boundary and input area. Source Electron in a hidden
// window, the synthetic loading-terminal backend, no provider process and no model. Checks what the five
// spacing rules do and, more importantly, what they must leave alone: text, states, the draft, who has the
// input, the controls and their sizes, the type size and the height of the input box. Also the row under the
// input: in the Chinese interface the hint gives way before a button's label breaks, and nowhere does a
// button, a label or the row come out worse than with the earlier styles. And the terminal pane's header: its
// hint and buttons stay together on the title's row wherever they fit, with the hint giving way first.
const scratch = require('./fixtures/test-scratch.cjs');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto'), { execFileSync } = require('node:child_process');
const { _electron } = scratch.playwright(require('playwright'));
const { createSourceEntry } = require('./fixtures/synthetic-source-boot.cjs');
const root = path.resolve(__dirname, '..');
const evidence = process.env.NAW_EVIDENCE_DIR;
if (!evidence || !path.isAbsolute(evidence)) throw Error('An explicit private evidence directory is required');
if (path.resolve(evidence) === root || path.resolve(evidence).startsWith(root + path.sep)) throw Error('GUI evidence must be outside the repository');
fs.mkdirSync(evidence, { recursive: true });
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID();
try { fs.mkdirSync(slot); } catch (error) { if (error.code !== 'EEXIST') throw error; console.error('Canonical GUI slot occupied; zero allocation and no launch.'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ token, owner: 'Claude3', task: 'T163 session split density', pid: process.pid, at: new Date().toISOString() }));
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
// The parts of this surface, as laid out now.
const sample = () => page.evaluate(() => {
  const q = s => document.querySelector(s), shown = e => Boolean(e && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden');
  const box = e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom }; };
  const part = s => shown(q(s)) ? box(q(s)) : null, css = (s, keys) => { const cs = getComputedStyle(q(s)); return Object.fromEntries(keys.map(k => [k, cs[k]])); };
  const messages = q('#messages'), turns = [...messages.querySelectorAll('.message.reading-turn-start')].filter(shown);
  const first = [...messages.children].find(shown);
  return {
    leftBar: part('#conversation-pane-toolbar'), rightBar: part('#native-pane .native-pane-toolbar'), approval: part('#approval'), messages: part('#messages'), activity: part('#native-activity'),
    wrap: part('#composer-wrap'), card: part('#composer'), input: part('#message-input'), send: part('#send-button'), interrupt: part('#interrupt'), hint: part('#compose-hint'), advanced: part('#advanced'), summary: part('#advanced > summary'),
    advancedContent: part('#advanced-content'), take: part('#take-control'),
    leftRule: shown(q('#conversation-pane-toolbar')) ? css('#conversation-pane-toolbar', ['borderBottomWidth', 'borderBottomStyle', 'borderBottomColor']) : null,
    rightRule: css('#native-pane .native-pane-toolbar', ['borderBottomWidth', 'borderBottomStyle', 'borderBottomColor']),
    wrapPadding: css('#composer-wrap', ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft']), cardPadding: css('#composer', ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRadius']),
    advancedPadding: css('#advanced', ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth']),
    wrapScroll: { scrollHeight: q('#composer-wrap').scrollHeight, clientHeight: q('#composer-wrap').clientHeight },
    firstShown: first ? { turnStart: first.classList.contains('reading-turn-start'), earlier: first.classList.contains('reading-page'), top: box(first).y, text: first.textContent.trim().slice(0, 40) } : null,
    turns: turns.map(e => { const cs = getComputedStyle(e); return { rule: cs.borderTopColor, width: cs.borderTopWidth, margin: cs.marginTop, padding: cs.paddingTop, top: box(e).y }; }),
    fonts: { input: getComputedStyle(q('#message-input')).fontSize, hint: getComputedStyle(q('#compose-hint')).fontSize, send: getComputedStyle(q('#send-button')).fontSize, summary: getComputedStyle(q('#advanced > summary')).fontSize,
      body: getComputedStyle(messages.querySelector('.message-body') || messages).fontSize },
    draft: q('#message-input').value, hintText: q('#compose-hint').textContent.trim(), layout: q('#session-layout').className,
    head: (() => { const bar = q('#native-pane .native-pane-toolbar'), group = q('#native-pane .native-pane-actions'), hint = q('#terminal-selection-hint');
      if (!shown(bar)) return null;
      const tops = r => new Set([...r.getClientRects()].filter(c => c.width > 0.5).map(c => Math.round(c.top))).size;
      const parts = [...bar.querySelectorAll('strong, .private-label, #terminal-selection-hint, button')].filter(shown).map(e => ({ id: e.id || e.className, ...box(e), font: parseFloat(getComputedStyle(e).fontSize), button: e.tagName === 'BUTTON' }));
      // A word of the hint is split when its own characters sit on more than one line.
      const split = word => { const node = hint.firstChild, at = node && node.nodeType === 3 ? node.data.indexOf(word) : -1; if (at < 0) return null; const r = document.createRange(); r.setStart(node, at); r.setEnd(node, at + word.length); return tops(r) > 1; };
      const whole = document.createRange(); whole.selectNodeContents(hint);
      // The narrowest the group can be on one row (the hint at its 8em), and the wrapper with the compact class taken
      // off the session view, as it is when a member of a space is opened. Both are read and put back in one step.
      const narrowest = (() => { if (!group || getComputedStyle(group).display !== 'flex') return null; const keep = [group.style.flex, group.style.width]; group.style.flex = 'none'; group.style.width = 'min-content'; const w = group.getBoundingClientRect().width; [group.style.flex, group.style.width] = keep; return w; })();
      const view = q('#session-view'), compact = view.classList.contains('compact-session-surface'); view.classList.remove('compact-session-surface');
      const plain = group ? getComputedStyle(group).display : null; if (compact) view.classList.add('compact-session-surface');
      return { bar: box(bar), grouped: Boolean(group) && ['terminal-controls', 'terminal-more', 'terminal-maximize', 'close-native-terminal'].every(id => group.contains(q('#' + id))) && bar.contains(group),
        layout: group ? getComputedStyle(group).display : null, pane: box(q('#native-pane')), view: innerWidth, narrowest, plain,
        parts, rows: new Set(parts.map(v => Math.round((v.y + v.h / 2) / 4))).size,
        hint: shown(hint) ? { text: hint.textContent.trim(), lines: tops(whole), split: Object.fromEntries(['右键菜单', 'Option', 'context', 'menu', 'select'].map(w => [w, split(w)])) } : null }; })(),
    row: (() => { const lines = e => { const r = document.createRange(); r.selectNodeContents(e); return new Set([...r.getClientRects()].filter(c => c.width > 0.5).map(c => Math.round(c.top))).size; };
      const hint = q('#compose-hint'), stop = q('#interrupt'), wrap = q('#composer-wrap'), hs = getComputedStyle(hint);
      return { send: lines(q('#send-button')), interrupt: shown(stop) ? lines(stop) : null, hint: lines(hint), basis: hs.flexBasis, grow: hs.flexGrow, sideways: wrap.scrollWidth - wrap.clientWidth, language: q('#ui-language').value }; })(),
  };
});
const clear = 'rgba(0, 0, 0, 0)';
// T-163, the terminal pane's header: the hint-and-buttons group and the three buttons after it are one group on the
// right of the title. Where the row is short the hint wraps onto two lines before any button leaves the row, and it
// breaks only at spaces. Nothing in the header is cut, shrunk or reordered.
function header(s, label, { rows, hintLines }) {
  assert.ok(s.head && s.head.grouped && s.head.layout === 'flex', `${label}: the terminal header's hint, copy, paste, more, maximise and close are laid out as one group inside the header (${s.head?.layout})`);
  for (const v of s.head.parts) assert.ok(v.x >= s.head.bar.x - 0.5 && v.right <= s.head.bar.right + 0.5 && v.y >= s.head.bar.y - 0.5 && v.bottom <= s.head.bar.bottom + 0.5, `${label}: ${v.id} stays inside the terminal header`);
  const buttons = s.head.parts.filter(v => v.button).sort((a, b) => Math.round(a.y / 8) - Math.round(b.y / 8) || a.x - b.x);
  assert.deepEqual(buttons.map(v => v.id), ['terminal-copy', 'terminal-paste', 'terminal-more', 'terminal-maximize', 'close-native-terminal'], `${label}: the same controls in the same order`);
  for (const v of buttons) assert.ok(Math.abs(v.h - 26) < 0.6 && v.w >= 20.5 && v.font >= 11, `${label}: ${v.id} keeps its size and type (${v.w}x${v.h}, ${v.font}px)`);
  assert.ok(s.head.parts.find(v => v.id === 'native-pane-title') && s.head.parts.find(v => v.id === 'private-label'), `${label}: the title and the private label are there`);
  assert.equal(s.head.rows, rows, `${label}: the terminal header has ${rows} row(s) of controls`);
  if (rows === 1) assert.ok(Math.abs(s.head.bar.h - 33) < 0.6, `${label}: a one-row terminal header is 33px high (${s.head.bar.h})`);
  else assert.ok(s.head.bar.h <= 52, `${label}: a two-row terminal header is no higher than before (${s.head.bar.h})`);
  assert.ok(s.head.hint && s.head.hint.text.includes('Option'), `${label}: the selection hint is shown`); assert.equal(s.head.hint.lines, hintLines, `${label}: the hint is on ${hintLines} line(s)`);
  // The words are looked for by name, so a hint whose wording has changed fails here instead of passing unmeasured.
  for (const word of s.row.language === 'zh' ? ['右键菜单', 'Option'] : ['Option', 'select', 'context', 'menu']) assert.equal(s.head.hint.split[word], false, `${label}: the hint contains "${word}" and does not break inside it (${s.head.hint.split[word]})`);
  assert.ok(s.head.narrowest !== null && s.head.narrowest <= 300, `${label}: the group fits a 300px header on a row of its own (${s.head.narrowest}px at its narrowest)`);
  assert.equal(s.head.plain, 'contents', `${label}: without the compact session layout, as when a member of a space is opened, the wrapper lays out nothing`);
  assert.ok(s.head.parts.find(v => v.id === 'terminal-selection-hint').font >= 10, `${label}: the hint's type is not smaller`);
}
// T-163, the row under the input. In the Chinese interface, in a card of 320px or more, the hint asks for 16em
// and takes what is left once the labels are whole; anywhere else it is sized as it always was. Checking the
// computed values catches the rule being switched off silently, for instance by a change to the language selector.
const hintGivesWay = (s, label) => assert.deepEqual([s.row.language, s.row.basis, s.row.grow], ['zh', '176px', '1'], `${label}: in Chinese the hint asks for 16em and takes what is left (${s.row.basis}, ${s.row.grow})`);
const hintAsBefore = (s, label) => assert.deepEqual([s.row.basis, s.row.grow], ['auto', '0'], `${label}: the hint is sized as before (${s.row.basis}, ${s.row.grow})`);
const wholeLabels = (s, label) => { assert.equal(s.row.send, 1, `${label}: the send control's label is on one line`); if (s.row.interrupt !== null) assert.equal(s.row.interrupt, 1, `${label}: the interrupt control's label is on one line`); };
const inside = (inner, outer, label) => assert.ok(inner.x >= outer.x - 0.5 && inner.right <= outer.right + 0.5 && inner.y >= outer.y - 0.5 && inner.bottom <= outer.bottom + 0.5, label + ' stays inside its block');
// What holds in every state of this surface.
function invariants(s, label, draft, split = true) {
  assert.equal(s.draft, draft, label + ': the private draft is in the input');
  assert.ok(s.input.h >= 70, `${label}: the input box keeps its height (${s.input.h})`);
  assert.deepEqual([s.fonts.input, s.fonts.hint, s.fonts.send, s.fonts.summary], ['14px', '11px', '12px', '11px'], label + ': no type in the input area is set smaller');
  assert.deepEqual([s.wrapPadding.paddingTop, s.wrapPadding.paddingBottom, s.wrapPadding.paddingLeft], ['6px', '8px', '16px'], label + ': the input area\'s padding');
  assert.deepEqual([s.cardPadding.paddingTop, s.cardPadding.paddingLeft, s.cardPadding.borderTopWidth], ['10px', '12px', '1px'], label + ': the input card keeps its border and has the smaller padding');
  assert.deepEqual([s.advancedPadding.paddingTop, s.advancedPadding.paddingBottom, s.advancedPadding.paddingLeft, s.advancedPadding.borderTopWidth], ['5px', '7px', '16px', '1px'], label + ': the disclosure row');
  inside(s.input, s.card, label + ': the input box'); inside(s.hint, s.card, label + ': the hint');
  if (s.send) { inside(s.send, s.card, label + ': the send control'); assert.ok(s.send.h >= 30 && s.send.w >= 44, `${label}: the send control keeps a usable size (${s.send.w}x${s.send.h})`); }
  // Beside the terminal the input card fills the pane, and the disclosure starts at its left edge. With the
  // conversation alone the card is centred and narrower, as before; the disclosure then starts at the pane's
  // own 16px edge, where the conversation starts, and never further in than the card.
  if (split) assert.ok(Math.abs(s.advanced.x - (s.card.x - 16)) < 1 && Math.abs(s.summary.x - s.card.x) < 1, `${label}: the disclosure starts at the input card's left edge (${s.summary.x} vs ${s.card.x})`);
  else assert.ok(Math.abs(s.advanced.x - s.messages.x) < 1 && s.summary.x <= s.card.x + 0.5 && s.summary.x - s.messages.x <= 34, `${label}: the disclosure starts at the conversation's left edge (${s.summary.x}; conversation ${s.messages.x}, card ${s.card.x})`);
  assert.ok(s.advanced.y >= s.wrap.bottom - 0.5, label + ': the disclosure is below the input area, not over it');
}
// T-163: every label the send control can carry beside every hint in the catalog, with and without the interrupt
// control, at card widths below, at and above the rule's 320px. Each is measured with the rule and with the hint
// put back to how it was sized before, in one synchronous step so the program cannot redraw in between; the
// width is set by narrowing the input area itself, as the divider does. The labels are read from the program's
// own choice of label and hint (soloAction in the renderer) and the hints from the catalog, so one added later
// is swept too.
async function labelsSweep() {
  const catalog = require('../app/ui-messages.js').zh;
  const renderer = fs.readFileSync(path.join(root, 'app/renderer/renderer.js'), 'utf8'), from = renderer.indexOf('function soloAction('), to = renderer.indexOf('\nfunction ', from + 1);
  assert.ok(from > 0 && to > from, 'The renderer still chooses the label and hint in soloAction');
  const keys = [...new Set([...renderer.slice(from, to).matchAll(/'(composer\.\w+)'/g)].map(m => m[1]))], labelKeys = keys.filter(k => !/Hint$/.test(k));
  assert.ok(labelKeys.length >= 13 && labelKeys.includes('composer.send') && labelKeys.includes('composer.steer') && labelKeys.includes('composer.claim'), `soloAction names the send control's labels (${labelKeys.join(', ')})`);
  for (const k of keys) assert.ok(catalog[k], `${k} is in the catalog`);
  const labels = labelKeys.map(k => catalog[k]);
  const hints = Object.keys(catalog).filter(k => /^composer\..*Hint$/.test(k)).map(k => catalog[k]);
  for (const k of keys.filter(k => /Hint$/.test(k))) assert.ok(hints.includes(catalog[k]), `${k} is among the hints swept`);
  assert.ok(hints.length >= 20 && catalog['native.interrupt'], 'The catalog has the hints this row shows and the interrupt control\'s label');
  const widths = [200, 260, 300, 315, 320, 325, 340, 360, 365, 400, 440, 448, 500, 600];
  const measure = before => page.evaluate(({ labels, hints, widths, interrupt, before }) => {
    const q = s => document.querySelector(s), card = q('#composer'), send = q('#send-button'), stop = q('#interrupt'), hint = q('#compose-hint'), wrap = q('#composer-wrap'), footer = q('#composer .composer-footer');
    const keep = { send: send.textContent, stop: stop.textContent, stopHidden: stop.hidden, hint: hint.textContent, width: wrap.style.width, self: wrap.style.alignSelf };
    const earlier = document.createElement('style'); earlier.textContent = '#composer .session-compose-hint{flex:0 1 auto !important;max-width:none !important}'; if (before) document.head.append(earlier);
    const lines = e => { const r = document.createRange(); r.selectNodeContents(e); return new Set([...r.getClientRects()].filter(c => c.width > 0.5).map(c => Math.round(c.top))).size; };
    const pad = parseFloat(getComputedStyle(wrap).paddingLeft) + parseFloat(getComputedStyle(wrap).paddingRight); wrap.style.alignSelf = 'flex-start';
    const out = [];
    try {
      for (const w of widths) {
        wrap.style.width = (w + pad) + 'px'; const row = []; if (Math.abs(card.getBoundingClientRect().width - w) > 0.6) throw Error('The card is not ' + w + 'px wide: ' + card.getBoundingClientRect().width);
        for (let withStop = 0; withStop < 2; withStop++) { stop.hidden = !withStop; stop.textContent = interrupt;
          for (const label of labels) { send.textContent = label;
            for (const text of hints) { hint.textContent = text;
              const c = card.getBoundingClientRect(), s = send.getBoundingClientRect(), t = withStop ? stop.getBoundingClientRect() : null;
              row.push(Math.round(Math.max(0, s.right - c.right, t ? t.right - c.right : 0) * 10), lines(send), t ? lines(stop) : 0, Math.round(footer.getBoundingClientRect().height * 10), Math.round(wrap.scrollWidth - wrap.clientWidth));
            } } }
        out.push(row);
      }
    } finally { earlier.remove(); send.textContent = keep.send; stop.textContent = keep.stop; stop.hidden = keep.stopHidden; hint.textContent = keep.hint; wrap.style.width = keep.width; wrap.style.alignSelf = keep.self; }
    return out;
  }, { labels, hints, widths, interrupt: catalog['native.interrupt'], before });
  const was = await measure(true), now = await measure(false), n = 5, tally = { compared: 0, changed: 0, wholeBefore: 0, wholeNow: 0, shorter: 0 };
  const name = i => { const l = Math.floor(i / hints.length) % labels.length, withStop = Math.floor(i / hints.length / labels.length); return `${withStop ? catalog['native.interrupt'] + ' + ' : ''}${labels[l]} | ${hints[i % hints.length].slice(0, 24)}`; };
  widths.forEach((w, wi) => { for (let i = 0; i < was[wi].length / n; i++) {
    const a = was[wi].slice(i * n, i * n + n), b = now[wi].slice(i * n, i * n + n), at = `card ${w}px, ${name(i)}`; tally.compared++;
    if (w < 320) { assert.deepEqual(b, a, `${at}: under 320px the row is as it was`); continue; }
    if (a.some((v, k) => v !== b[k])) tally.changed++;
    assert.ok(b[0] <= a[0] + 5, `${at}: no control sticks out of the card further than before (${a[0] / 10} to ${b[0] / 10}px)`);
    assert.ok(b[4] <= a[4], `${at}: no more sideways scroll than before (${a[4]} to ${b[4]}px)`);
    assert.ok(b[1] <= a[1] && b[2] <= a[2], `${at}: no label breaks into more lines than before (${a[1]}/${a[2]} to ${b[1]}/${b[2]})`);
    assert.ok(b[3] <= a[3] + 5, `${at}: the row is not taller than before (${a[3] / 10} to ${b[3] / 10}px)`);
    if (a[1] <= 1 && a[2] <= 1) tally.wholeBefore++; if (b[1] <= 1 && b[2] <= 1) tally.wholeNow++; if (b[3] < a[3] - 5) tally.shorter++;
  } });
  assert.ok(tally.wholeNow > tally.wholeBefore && tally.shorter > 0, `The rule keeps more labels whole and makes rows shorter (${tally.wholeBefore} to ${tally.wholeNow} whole, ${tally.shorter} shorter)`);
  tally.labels = labels.length; tally.hints = hints.length;
  return tally;
}
async function language(code) {
  await page.locator('#setup-button').click(); await page.locator('#ui-language').selectOption(code);
  await until(async () => (await page.locator('#setup-title').textContent()) === (code === 'en' ? 'Settings' : '设置'), 'The interface language changed'); await page.locator('#close-setup').click(); await settled();
}
async function run() {
  profile = scratch.directory(path.join(os.tmpdir(), 'naw-split-density-')); const cwd = path.join(profile, 'workspace'); fs.mkdirSync(cwd, { mode: 0o700 });
  child = scratch.childProcess.fork(path.join(root, 'app/daemon.cjs'), [profile], { cwd, execArgv: ['--require', path.join(__dirname, 'fixtures/loading-terminal.cjs')],
    env: env({ NAW_TEST_APP_ROOT: root, NAW_WORKSPACE: cwd, NAW_APP_VERSION: require('../package.json').version }), stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Synthetic backend ready');
  client = await require('../app/service-connection.cjs').connectService(profile, 'split-density-seed');
  const id = await client.call('create', { provider: 'claude', cwd, name: '发布核对 · Release check', view: 'chat' });
  const draft = 'UNSENT private draft · 尚未发送的草稿：先核对 release notes 第 3 节，再跑一次全量。';
  await client.call('draft', id, draft);
  const entry = createSourceEntry({ profile, code: root, fixturePid: child.pid }), entryFile = path.join(entry, 'entry.cjs');
  fs.writeFileSync(entryFile, `const e=require('electron');e.Notification.isSupported=()=>false;globalThis.splitDensity={guards:[]};` +
    `for(const key of ['showOpenDialog','showSaveDialog','showMessageBox','showOpenDialogSync','showSaveDialogSync','showMessageBoxSync'])e.dialog[key]=()=>{splitDensity.guards.push(key);throw Error('OS dialog outside this check');};\n` + fs.readFileSync(entryFile, 'utf8'));
  app = await _electron.launch({ executablePath: require('electron'), args: [entry], env: env({ NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid), NAW_TEST_VISIBLE: '0', NAW_TEST_UI_LANGUAGE: 'zh' }), timeout: 60000 });
  await until(async () => { for (const p of app.windows()) if (!p.isClosed() && await p.locator('#new-session').count()) { page = p; return true; } return false; }, 'The workspace page');
  page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
  assert.deepEqual(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ visible: w.isVisible(), focusable: w.isFocusable() }))), [{ visible: false, focusable: false }], 'The window is hidden and cannot take focus');
  await size(1240, 850);
  await page.locator(`.session-link[data-session-id="${id}"]`).click();
  const time = Date.now() - 600000;
  const turn = (name, extra = {}) => [
    { id: `${name}-input`, turnId: name, status: 'complete', time, kind: 'input', role: 'user', text: `核对发布说明（${name}），然后跑一次全量测试。` },
    { id: `${name}-read`, turnId: name, status: 'complete', time, kind: 'tool', title: 'Read', input: 'docs/release-notes.md', text: '## 3 已知限制\n- 换会话后授权需要重新确认' },
    { id: `${name}-bash`, turnId: name, status: 'failed', time, kind: 'tool', title: 'Bash', input: 'node --test app/tests/*.test.cjs', text: 'tests 5363\npass 5362\nfail 1' },
    { id: `${name}-answer`, turnId: name, status: 'complete', time, kind: 'response', phase: 'final_answer', text: '全量 5362 通过、1 条失败。\n\n需要你决定：先修这条再发版，还是按已知问题记录后继续。', ...extra },
  ];
  for (const item of turn('first')) child.send({ id: ++sequence, method: 'nativeBlock', target: id, value: item });
  await until(async () => (await page.locator('#messages [data-message-id]').count()) >= 3, 'The synthetic conversation is shown');
  if (!(await page.locator('#session-layout').evaluate(e => e.classList.contains('has-terminal')))) await page.locator('#terminal-tab').click();
  await until(() => page.locator('#session-layout').evaluate(e => e.classList.contains('has-terminal')), 'The native terminal pane is open');
  await delay(300); child.send({ id: ++sequence, method: 'release', target: id }); await settled();

  // 1) Read-only: another window has the input. The draft is kept and the take-over control is offered.
  let s = await sample();
  assert.ok(s.take, 'The run starts read-only, with the take-over control in the header'); invariants(s, 'read-only', draft);
  assert.match(s.hintText, /只读/, 'The input area says this window is read-only');
  hintGivesWay(s, 'read-only'); wholeLabels(s, 'read-only');
  await capture('01-read-only-zh');
  check('Read-only: the draft, the read-only hint and the take-over control are there; the input area has the new spacing and nothing leaves the card');

  // 2) This window has the input. One header rule; the first turn draws none of its own.
  await page.locator('#take-control').click(); await until(async () => !(await page.locator('#take-control').isVisible()), 'This window has the input');
  s = await sample(); invariants(s, 'idle', draft);
  assert.deepEqual(s.leftRule, s.rightRule, 'The conversation pane\'s toolbar has the same bottom rule as the terminal pane\'s header');
  assert.equal(s.leftRule.borderBottomWidth, '1px'); assert.notEqual(s.leftRule.borderBottomColor, clear);
  assert.ok(Math.abs(s.leftBar.bottom - s.rightBar.bottom) < 1, `In Chinese at this width the two rules meet (${s.leftBar.bottom} and ${s.rightBar.bottom})`);
  assert.equal(s.firstShown.turnStart, true, 'The first thing shown is the first turn');
  assert.deepEqual([s.turns[0].rule, s.turns[0].margin, s.turns[0].padding], [clear, '0px', '0px'], 'The first turn shown draws no rule and leaves no gap for one');
  assert.ok(s.firstShown.top - s.leftBar.bottom <= 13, `The first message starts right under the header (${s.firstShown.top - s.leftBar.bottom}px)`);
  assert.equal(s.fonts.body, '14px', 'The conversation\'s type size is unchanged');
  hintGivesWay(s, 'idle'); wholeLabels(s, 'idle'); const idleCard = s.card.h;
  header(s, 'idle', { rows: 1, hintLines: 1 });
  await capture('02-idle-zh');
  check('Idle: one header rule across both panes; the first turn has no rule of its own and starts under the header; the input box is ' + s.input.h + 'px high');

  // 3) A second turn keeps its rule: only the first one shown loses it.
  for (const item of turn('second')) child.send({ id: ++sequence, method: 'nativeBlock', target: id, value: item });
  await until(async () => (await sample()).turns.length === 2, 'The second turn is shown');
  s = await sample();
  assert.deepEqual([s.turns[0].rule, s.turns[0].margin], [clear, '0px']);
  assert.notEqual(s.turns[1].rule, clear, 'A later turn keeps its rule'); assert.deepEqual([s.turns[1].width, s.turns[1].margin, s.turns[1].padding], ['1px', '18px', '16px']);
  check('A later turn keeps its rule, margin and padding');

  // 4) Reachability: the input, the send control and the disclosure are in the Tab order, in that order, and
  // none is covered. (The window is hidden and cannot take focus, so no physical key is pressed here.)
  const reach = await page.evaluate(() => ['#message-input', '#send-button', '#advanced > summary'].map(selector => {
    const e = document.querySelector(selector), r = e.getBoundingClientRect(), top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { selector, tab: e.tabIndex, disabled: e.disabled === true, inert: Boolean(e.closest('[inert]')), onTop: top === e || e.contains(top), order: [...document.querySelectorAll('#message-input, #send-button, #advanced > summary')].indexOf(e) };
  }));
  assert.deepEqual(reach, [{ selector: '#message-input', tab: 0, disabled: false, inert: false, onTop: true, order: 0 }, { selector: '#send-button', tab: 0, disabled: false, inert: false, onTop: true, order: 1 },
    { selector: '#advanced > summary', tab: 0, disabled: false, inert: false, onTop: true, order: 2 }], 'The input, the send control and the disclosure are in the Tab order and not covered');
  await page.locator('#advanced > summary').click(); await settled();
  s = await sample(); invariants(s, 'disclosure open', draft);
  // (Its content scrolls inside the row's own height limit, as before, so only its sides and its start are checked.)
  assert.ok(s.advancedContent && s.advancedContent.h > 0, 'The disclosure opened');
  assert.ok(s.advancedContent.x >= s.advanced.x - 0.5 && s.advancedContent.right <= s.advanced.right + 0.5 && s.advancedContent.y >= s.summary.bottom - 1, 'The disclosure\'s content is under its heading and within its sides');
  assert.ok(Math.abs(s.advancedContent.x - s.card.x) < 1, 'Its content starts at the same left edge');
  await capture('03-disclosure-open-zh');
  await page.locator('#advanced > summary').click(); await settled();
  check('Reachability: the input, the send control and the disclosure are in the Tab order and uncovered; the open disclosure lines up with the input card and overlaps nothing');

  // 5) Working: the activity line and the interrupt control.
  child.send({ id: ++sequence, method: 'native-activity', target: id, value: { turnId: 'third', label: '正在运行 Bash' } });
  await until(async () => (await sample()).activity !== null, 'The activity line is shown');
  s = await sample(); invariants(s, 'working', draft);
  assert.ok(s.interrupt, 'The interrupt control is shown'); inside(s.interrupt, s.card, 'working: the interrupt control');
  assert.ok(s.activity.bottom <= s.wrap.y + 0.5, 'The activity line is above the input area');
  assert.match(s.hintText, /不能在回复中发送/, 'Working: the hint says why nothing can be sent now');
  wholeLabels(s, 'working'); assert.ok(s.hint.w >= 175.5, `working: the hint keeps a readable width (${s.hint.w})`);
  assert.ok(Math.abs(s.card.h - idleCard) < 0.6, `working: the input card is as tall as when idle (${s.card.h} and ${idleCard})`);
  await capture('04-working-zh');
  check('Working: the activity line and the interrupt control are there and inside their blocks; both labels are on one line and the card is as tall as when idle');

  // 6) Waiting for the person: the banner sits directly under the header, with no stray rule after it.
  child.send({ id: ++sequence, method: 'native-permission', target: id, value: { id: 'permission-1', kind: 'permission', title: 'Bash', detail: 'synthetic, nothing runs', options: [{ id: 'allow', label: '允许一次' }, { id: 'deny', label: '拒绝' }] } });
  await until(async () => (await sample()).approval !== null, 'The confirmation banner is shown');
  s = await sample(); invariants(s, 'waiting', draft);
  assert.ok(Math.abs(s.approval.y - s.leftBar.bottom) < 1, 'The banner starts at the header rule');
  assert.ok(s.approval.h > 40 && s.messages.y >= s.approval.bottom - 0.5, 'The banner keeps its height and the conversation starts below it');
  wholeLabels(s, 'waiting');
  await capture('05-waiting-for-you-zh');
  child.send({ id: ++sequence, method: 'native-permission', target: id, value: null }); child.send({ id: ++sequence, method: 'native-activity', target: id, value: null });
  await until(async () => { const now = await sample(); return now.approval === null && now.activity === null; }, 'Back to idle');
  check('Waiting for you: the banner is under the header rule and nothing else is between it and the conversation');

  // 7) More than one page: the "show earlier records" button is shown first, and then the first turn on the page keeps its rule.
  for (let n = 0; n < 13; n++) for (const item of turn('more-' + n)) child.send({ id: ++sequence, method: 'nativeBlock', target: id, value: item });
  await until(async () => (await sample()).firstShown?.earlier === true, 'The earlier-records button is shown');
  // (Not scrolled to the top: reaching it loads the earlier page, and the button goes away.)
  s = await sample();
  assert.equal(s.firstShown.earlier, true); assert.ok(s.turns.length >= 2);
  assert.notEqual(s.turns[0].rule, clear, 'With earlier records to load, the first turn on the page keeps its rule'); assert.deepEqual([s.turns[0].margin, s.turns[0].padding], ['18px', '16px']);
  await capture('06-earlier-records-zh');
  check('With earlier records to load, the button comes first and the first turn on the page keeps its rule');

  // 8) The small window and English: nothing leaves the card and the input area does not scroll.
  await size(1000, 700); s = await sample(); header(s, 'zh 1000x700', { rows: 1, hintLines: 1 });
  await size(850, 600); s = await sample(); invariants(s, 'zh 850x600', draft);
  assert.ok(s.wrapScroll.scrollHeight <= s.wrapScroll.clientHeight + 1, `zh 850x600: the input area fits without scrolling (${s.wrapScroll.scrollHeight} in ${s.wrapScroll.clientHeight})`);
  header(s, 'zh 850x600', { rows: 1, hintLines: 2 });
  assert.ok(Math.abs(s.leftBar.bottom - s.rightBar.bottom) < 1, `zh 850x600: the two header rules meet (${s.leftBar.bottom} and ${s.rightBar.bottom})`);
  await capture('07-small-zh');
  // Working in the small window: the labels stay whole and the input area still fits.
  const working = async on => { child.send({ id: ++sequence, method: 'native-activity', target: id, value: on ? { turnId: 'third', label: '正在运行 Bash' } : null }); await until(async () => ((await sample()).interrupt !== null) === on, on ? 'The interrupt control is shown' : 'The interrupt control is gone'); await settled(); };
  await working(true); s = await sample(); invariants(s, 'zh 850x600 working', draft); hintGivesWay(s, 'zh 850x600 working'); wholeLabels(s, 'zh 850x600 working');
  assert.ok(Math.abs(s.card.h - idleCard) < 0.6, `zh 850x600 working: the input card is as tall as when idle (${s.card.h})`);
  assert.ok(s.wrapScroll.scrollHeight <= s.wrapScroll.clientHeight + 1, `zh 850x600 working: the input area fits without scrolling (${s.wrapScroll.scrollHeight} in ${s.wrapScroll.clientHeight})`);
  await capture('07b-small-working-zh'); await working(false);
  // English: the row is sized as it always was, idle and working, at both sizes.
  await size(1240, 850); await language('en'); s = await sample(); invariants(s, 'en 1240x850', draft);
  assert.equal(s.hintText, 'Enter to send · Shift Enter for a new line'); hintAsBefore(s, 'en 1240x850');
  header(s, 'en 1240x850', { rows: 1, hintLines: 2 });
  assert.ok(Math.abs(s.leftBar.bottom - s.rightBar.bottom) < 1, `en 1240x850: the two header rules meet (${s.leftBar.bottom} and ${s.rightBar.bottom})`);
  await capture('08-idle-en');
  await working(true); s = await sample(); invariants(s, 'en 1240x850 working', draft); hintAsBefore(s, 'en 1240x850 working'); inside(s.interrupt, s.card, 'en working: the interrupt control'); assert.equal(s.row.sideways, 0, 'en working: no sideways scroll'); await working(false);
  await size(1000, 700); s = await sample(); header(s, 'en 1000x700', { rows: 1, hintLines: 2 });
  assert.ok(Math.abs(s.leftBar.bottom - s.rightBar.bottom) < 1, `en 1000x700: the two header rules meet (${s.leftBar.bottom} and ${s.rightBar.bottom})`);
  await size(850, 600); s = await sample(); invariants(s, 'en 850x600', draft); hintAsBefore(s, 'en 850x600');
  // English in the small window is the one case that still needs two rows: the group moves down whole.
  header(s, 'en 850x600', { rows: 2, hintLines: 1 });
  assert.ok(s.wrapScroll.scrollHeight <= s.wrapScroll.clientHeight + 1, `en 850x600: the input area fits without scrolling (${s.wrapScroll.scrollHeight} in ${s.wrapScroll.clientHeight})`);
  await capture('09-small-en');
  await size(1240, 850); await language('zh');
  check('Small window and English: the same spacing, nothing leaves the card, and the input area fits without scrolling; working in the small Chinese window keeps whole labels; in English the row is sized as before; the terminal header is one 33px row in Chinese at all three sizes and in English at 1240 and 1000 wide, with the hint on two lines broken at a space where the row is short, and two rows only in the small English window');

  // 8b) The divider dragged to its stop: the card is far narrower than 320px and the row is sized as before.
  const drag = async fraction => { const divider = page.locator('#session-layout > .split-divider'), d = await divider.boundingBox(), host = await page.locator('#session-layout').boundingBox(), from = d.x + d.width / 2, to = host.x + host.width * fraction;
    await page.mouse.move(from, d.y + 120); await page.mouse.down(); for (let n = 1; n <= 6; n++) await page.mouse.move(from + (to - from) * n / 6, d.y + 120); await page.mouse.up(); await page.mouse.move(host.x + host.width - 40, host.y + 300); await settled();
    return divider.getAttribute('aria-valuenow'); };
  assert.equal(await drag(0.1), '20', 'The divider stops at 20%');
  s = await sample(); assert.ok(s.card.w < 320, `With the divider at its stop the card is narrow (${s.card.w})`); hintAsBefore(s, 'narrow card'); assert.equal(s.row.sideways, 0, 'narrow card: no sideways scroll'); inside(s.send, s.card, 'narrow card: the send control');
  await capture('09b-narrow-card-zh');
  assert.equal(await drag(0.5), '50', 'The divider is back in the middle'); s = await sample(); hintGivesWay(s, 'divider back in the middle');
  check('Divider at its 20% stop: the card is under 320px, the row is sized as before and nothing scrolls sideways; back in the middle the rule applies again');

  // 8c) The terminal pane from its narrowest to its widest: nothing in its header leaves the header or the window.
  //     Under a 300px header the wrapper lays out nothing and the row wraps item by item as it always did.
  // The header's height with the group put back to how these parts were laid out before (the wrapper laying out
  // nothing and the hint, the controls block and the buttons with their earlier values), read in one synchronous step.
  const earlierHeader = () => page.evaluate(() => { const style = document.createElement('style');
    style.textContent = '.native-pane-actions{display:contents !important}.native-pane-actions>#terminal-controls{flex:0 1 auto !important;flex-wrap:wrap !important;min-width:0 !important}' +
      '.native-pane-actions #terminal-selection-hint{flex:0 1 auto !important;min-width:auto !important;text-align:start !important;line-height:1.4 !important;word-break:normal !important}.native-pane-actions button{flex:0 1 auto !important}';
    document.head.append(style); const height = document.querySelector('#native-pane .native-pane-toolbar').getBoundingClientRect().height; style.remove(); return height; });
  const paneSweep = async label => { const seen = [];
    for (const fraction of [0.9, 0.74, 0.7, 0.66, 0.62, 0.58, 0.5, 0.3]) { const at = await drag(fraction); s = await sample();
      for (const v of s.head.parts) assert.ok(v.x >= s.head.bar.x - 0.5 && v.right <= s.head.bar.right + 0.5 && v.y >= s.head.bar.y - 0.5 && v.bottom <= s.head.bar.bottom + 0.5 && v.right <= s.head.view + 0.5, `${label}, divider at ${at}%: ${v.id} stays inside the terminal header (${Math.round(v.x)} to ${Math.round(v.right)} in ${Math.round(s.head.bar.x)} to ${Math.round(s.head.bar.right)})`);
      assert.equal(s.head.parts.filter(v => v.button).length, 5, `${label}, divider at ${at}%: the five controls are shown`);
      const wide = s.head.bar.w - 16 >= 300; assert.equal(s.head.layout, wide ? 'flex' : 'contents', `${label}, divider at ${at}%: a ${Math.round(s.head.bar.w)}px header ${wide ? 'groups its controls' : 'leaves its controls as items of the row'}`);
      const hintBox = s.head.parts.find(v => v.id === 'terminal-selection-hint');
      for (const [word, split] of Object.entries(s.head.hint.split)) assert.notEqual(wide && split, true, `${label}, divider at ${at}%: the hint does not break inside "${word}" (header ${Math.round(s.head.bar.w)}x${Math.round(s.head.bar.h)}, hint ${Math.round(hintBox.w)}x${Math.round(hintBox.h)} on ${s.head.hint.lines} lines, ${s.head.rows} rows)`);
      const was = await earlierHeader(); assert.ok(s.head.bar.h <= was + 0.5, `${label}, divider at ${at}%: the header is not taller than before (${was} to ${s.head.bar.h})`);
      if (!wide) assert.ok(Math.abs(s.head.bar.h - was) < 0.5, `${label}, divider at ${at}%: a narrow header is as high as before (${was} to ${s.head.bar.h})`);
      seen.push(`${at}%:${Math.round(s.head.bar.w)}px ${s.head.layout} ${Math.round(was)}→${Math.round(s.head.bar.h)}px`); }
    assert.equal(await drag(0.5), '50'); return seen; };
  const sweptZh = await paneSweep('zh 1240x850'); assert.ok(sweptZh.some(v => v.includes('contents')) && sweptZh.some(v => v.includes('flex')), 'The sweep crosses the 300px boundary: ' + sweptZh.join(', '));
  await capture('09c-pane-sweep-zh');
  // At 900px and narrower the two panes are always equal and there is no divider to drag, so the sweep uses the two larger sizes.
  await size(1000, 700); const sweptSmall = await paneSweep('zh 1000x700'); await size(1240, 850);
  await language('en'); const sweptEn = await paneSweep('en 1240x850'); await size(1000, 700); const sweptEnSmall = await paneSweep('en 1000x700'); await size(1240, 850); await language('zh');
  check(`Terminal pane from narrowest to widest, Chinese and English at 1240 and 1000 wide: every part of its header stays inside it and the window and the header is never taller than with the earlier layout; under a 300px header the controls are items of the row and the header is as high as before (zh 1240: ${sweptZh.join(', ')}; zh 1000: ${sweptSmall.join(', ')}; en 1240: ${sweptEn.join(', ')}; en 1000: ${sweptEnSmall.join(', ')})`);

  // 9) Conversation only: with the terminal pane closed the input area is the same.
  await page.locator('#close-native-terminal').click(); await until(() => page.locator('#session-layout').evaluate(e => !e.classList.contains('has-terminal')), 'The terminal pane is closed');
  s = await sample(); invariants(s, 'conversation only', draft, false);
  await capture('10-conversation-only-zh');
  const swept = await labelsSweep();
  check('Conversation only: the input area has the same spacing; the disclosure starts at the conversation\'s left edge, the centred card being narrower as before');
  s = await sample(); invariants(s, 'after the sweep', draft, false);
  check(`Every label soloAction can choose (${swept.labels}) beside every hint in the catalog (${swept.hints}), with and without the interrupt control, at fourteen card widths (${swept.compared} comparisons with the earlier sizing): under 320px nothing differs; from 320px no control further out, no more sideways scroll, no label in more lines, no row taller; ${swept.wholeBefore} to ${swept.wholeNow} rows have whole labels and ${swept.shorter} are shorter`);

  // 10) An ended session: the input area offers to continue it, inside the same card.
  child.send({ id: ++sequence, method: 'set-state', target: id, value: 'ended' });
  await until(async () => /结束/.test(await page.locator('#header').innerText()), 'The session is shown as ended');
  s = await sample(); invariants(s, 'ended', draft, false);
  await capture('11-ended-zh');
  check('Ended: the draft is kept and the input area has the same spacing');

  const counters = await fixture('inspect');
  assert.deepEqual(counters.sends, []); assert.deepEqual(counters.inputs, []);
  assert.deepEqual(await app.evaluate(() => globalThis.splitDensity.guards), []); assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ checks, errors, sends: counters.sends.length, inputs: counters.inputs.length, modelCalls: 0 }, null, 2));
}
const cleanup = scratch.cleanup(async () => { if (app) await app.close(); client?.close(); if (child?.connected) child.disconnect(); if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); });
let deadline;
Promise.race([run(), new Promise((_, reject) => { deadline = setTimeout(() => reject(Error('240-second GUI budget exhausted')), 240000); })])
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
