// The phone's space 对话: the real app/mobile-web files in a headless 390-wide browser, answered with what the real
// MobileWorkspace projection returns for a synthetic space. No NAW service, pairing secret, model or network.
// NAW_BROWSER_EXECUTABLE picks the Chromium build when Playwright's own is not installed; NAW_PICTURES_DIR saves pictures.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium } = require('playwright');
const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '..');
const { MobileWorkspace } = require(path.join(root, 'app/mobile-workspace.cjs'));
const { LONG } = require('./fixtures/speech-stream-text.cjs');
const web = path.join(root, 'app/mobile-web'), pictures = process.env.NAW_PICTURES_DIR;
const id = n => `${n}0000000-0000-4000-8000-00000000000${n}`;
const butler = id('b'), pm = id('c'), a = id('a'), b = id('d');
const now = Date.parse('2026-11-23T10:40:00-08:00'), at = minutes => now - minutes * 60000, yesterday = now - 86400000;
const session = (sid, name, messages) => ({ id: sid, nativeId: 'native-' + sid, name, provider: 'claude', state: 'idle', roomIds: ['shared'], messages });
const sessions = [
  { ...session(butler, '大管家会话', []), roomIds: [] },
  session(pm, '项目经理', [
    { id: 'tag-pm', role: 'user', origin: 'room', text: '把今天要做的三件事排一下。', time: yesterday },
    { id: 'pm-think', role: 'assistant', status: 'complete', phase: 'commentary', text: '先看队列。', time: yesterday + 30000 },
    { id: 'pm-reply', role: 'assistant', status: 'complete', text: '排好了：1. 输入框修复（A）；2. 文档（B）；3. 安装检查（大管家）。', time: yesterday + 60000 }]),
  session(a, 'Claude A', [
    { id: 'a-wake', role: 'user', origin: 'agent-wake', name: '来自 项目经理', text: '[Workspace message from 项目经理 · x at y]\nA，先修输入框，再补测试。', time: at(30), wakeSource: { id: 'wake-pm-a', senderId: pm } },
    { id: 'a-tool', role: 'assistant', kind: 'tool', text: 'npm test', time: at(29) },
    { id: 'a-done', role: 'assistant', status: 'complete', text: LONG, time: at(20) },
    { id: 'a-recover', role: 'user', origin: 'capacity-recovery', name: 'NAW', text: '继续', time: at(19) }]),
  session(b, 'Claude B', [
    { id: 'b-dispatch', role: 'user', origin: 'naw-dispatch', name: 'NAW 派活', dispatchItem: 'item-docs', dispatchPurpose: { kind: 'queue' }, text: '【NAW 派活】写文档：对话视图的说明。', time: at(25) },
    { id: 'b-reply', role: 'assistant', status: 'complete', text: '文档写好了，等审查。', time: at(15) },
    { id: 'b-wake', role: 'user', origin: 'agent-wake', name: '来自 大管家', text: '[Workspace message from 大管家 · x at y]\nB，文档进度怎么样？', time: at(10), wakeSource: { id: 'wake-s-b', senderId: butler } },
    { id: 'b-answer', role: 'assistant', status: 'complete', text: '一半了，今晚交。', time: at(9) },
    { id: 'b-timer', role: 'user', origin: 'native', inputSource: 'codex_wakeup', name: '定时唤醒', text: 'wake', time: at(5) }]),
];
const room = { id: 'shared', name: '共同工作', queue: [], messages: [
  { id: 'h-pm', role: 'human', recipientId: pm, text: '把今天要做的三件事排一下。', time: yesterday, deliveries: [{ id: 'tag-pm', recipientId: pm, recipientName: '项目经理' }] },
  { id: 'sys-pause', role: 'system', name: '协作', text: '协作已暂停', time: yesterday + 1000 },
  { id: 'w-pm-a', role: 'system', kind: 'agent-wake', text: '发给原会话的自动消息：原生已接收。\nA，先修输入框，再补测试。', time: at(30),
    wake: { id: 'wake-pm-a', senderId: pm, recipientId: a, senderName: '项目经理', recipientName: 'Claude A', body: 'A，先修输入框，再补测试。' } }] };
const source = { sessions, rooms: [room], room, backgroundConfirmations: [] };
// The queue is empty, so the projection reads no room metadata; nothing is written to disk.
const workspace = new MobileWorkspace({ snapshot: () => source, roomState: { metadata: () => ({ events: [] }) }, now: () => now,
  records: { status: () => ({ count: 0, records: [] }), acknowledge() {} }, steward: () => ({ sessionId: butler, nativeId: 'native-' + butler }) });
const scopes = sessions.map(s => ({ sessionId: s.id, nativeId: s.nativeId, serviceKey: '.', actions: ['read', 'send'] }));
const projection = selection => workspace.read({ async refresh() {}, route: () => ({ key: '.' }) }, { roomIds: ['shared'], records: false }, scopes, selection);
let passed = 0;
const check = (label, fn) => { fn(); passed++; console.log('PASS ' + label); };
async function open(context, hash) {
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', async route => {
    const p = new URL(route.request().url()).pathname, json = value => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
    if (p === '/mobile/') return route.fulfill({ status: 200, contentType: 'text/html', body: fs.readFileSync(path.join(web, 'index.html'), 'utf8').replaceAll('__NAW_SCRIPT_NONCE__', 'n') });
    if (/^\/mobile\/[a-z]+\.(js|css|webmanifest)$/.test(p)) return route.fulfill({ status: 200, contentType: p.endsWith('.css') ? 'text/css' : 'text/javascript', body: fs.readFileSync(path.join(web, path.basename(p))) });
    if (p === '/mobile/session') return json({ deviceId: '10000000-0000-4000-8000-000000000001', csrf: 'c'.repeat(43), workspace: true,
      sessions: sessions.map(s => ({ id: s.id, name: s.name, state: s.state, available: true, actions: ['read', 'send'] })) });
    const match = p.match(/^\/mobile\/workspace\/(summary|session\/[^/]+|room\/[^/]+)$/);
    if (match) {
      const [kind, value] = match[1].split('/'), view = await projection(kind === 'summary' ? { kind } : { kind, id: decodeURIComponent(value) });
      return json({ ...view, capabilities: { ...view.capabilities, push: false } });
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"MOBILE_DENIED"}' });
  });
  await page.goto('http://naw.test/mobile/' + hash);
  await page.waitForFunction(() => document.documentElement.dataset.loading === 'false');
  await page.waitForSelector('.speech-names');
  return { page, errors };
}
// What a sighted reader sees: the speaker, arrow and recipient, without the time or the screen-reader-only 「发给」.
const rows = page => page.$$eval('.thread > .message.speech', list => list.map(n => [...n.querySelector('.author').children]
  .filter(c => c.tagName !== 'TIME' && !c.classList.contains('visually-hidden')).map(c => c.textContent).join(' ') + ' | ' + n.querySelector('.bubble').innerText.split('\n')[0]));
const atBottom = page => page.evaluate(() => innerHeight + scrollY >= document.documentElement.scrollHeight - 2);
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.NAW_BROWSER_EXECUTABLE || undefined, headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'light', deviceScaleFactor: 2 });
    const { page, errors } = await open(context, '#zh/space/shared');
    const shown = await rows(page);
    check('the phone space shows only what was said, oldest first', () => assert.deepEqual(shown, [
      '你 → 项目经理 | 把今天要做的三件事排一下。', '项目经理 | 排好了：1. 输入框修复（A）；2. 文档（B）；3. 安装检查（大管家）。',
      '项目经理 → Claude A | A，先修输入框，再补测试。', 'NAW 派活 → Claude B | 【NAW 派活】写文档：对话视图的说明。',
      'Claude A | 输入框修复已完成，改动如下：', 'Claude B | 文档写好了，等审查。', '大管家 → Claude B | B，文档进度怎么样？', 'Claude B | 一半了，今晚交。']));
    const names = await page.$$eval('.speech-names button', list => list.map(n => [n.textContent, n.getAttribute('aria-pressed')]));
    check('names row: 全部, then the butler, then the members', () => assert.deepEqual(names, [['全部', 'true'], ['大管家', 'false'], ['项目经理', 'false'], ['Claude A', 'false'], ['Claude B', 'false']]));
    const labels = await page.evaluate(() => [document.querySelector('.speech-names').getAttribute('aria-label'), document.querySelector('.thread').getAttribute('aria-label'),
      document.querySelector('.message.speech .visually-hidden')?.textContent, document.querySelectorAll('.thread [aria-live], .thread [role=status], .thread [role=log]').length]);
    check('the names row and list are named; the recipient is read as 发给; no live region per message', () => assert.deepEqual(labels, ['只看谁的对话', '对话内容', '发给', 0]));
    const opened = await atBottom(page);
    check('the space opens at its newest message', () => assert.ok(opened));
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    check('no horizontal page overflow at 390', () => assert.ok(overflow <= 0));
    if (pictures) { fs.mkdirSync(pictures, { recursive: true }); await page.screenshot({ path: path.join(pictures, 'phone-all-light-390.png') }); }
    await page.evaluate(() => scrollTo(0, 0));
    if (pictures) await page.screenshot({ path: path.join(pictures, 'phone-top-light-390.png') });

    const long = page.locator('.message.speech').filter({ hasText: '输入框修复已完成' });
    const foldedBefore = await long.evaluate(n => [n.querySelector('.bubble').classList.contains('folded'), n.querySelector('.speech-toggle')?.textContent, n.querySelector('.speech-toggle')?.getAttribute('aria-expanded'), n.querySelector('.bubble').clientHeight < n.querySelector('.bubble').scrollHeight]);
    const shortToggles = await page.$$eval('.message.speech', list => list.filter(n => !n.textContent.includes('输入框修复已完成') && n.querySelector('.speech-toggle')).length);
    check('a long message is folded behind 展开全文 and short ones have no toggle', () => { assert.deepEqual(foldedBefore, [true, '展开全文', 'false', true]); assert.equal(shortToggles, 0); });
    await long.locator('.speech-toggle').scrollIntoViewIfNeeded(); const placed = await long.evaluate(n => n.getBoundingClientRect().top);
    await long.locator('.speech-toggle').click();
    const opened2 = await page.locator('.message.speech').filter({ hasText: '输入框修复已完成' }).evaluate(n => [n.querySelector('.bubble').classList.contains('folded'), n.querySelector('.speech-toggle').textContent, n.querySelector('.speech-toggle').getAttribute('aria-expanded'), document.activeElement === n.querySelector('.speech-toggle'), Math.round(n.getBoundingClientRect().top)]);
    check('展开全文 opens it in place and keeps focus on the toggle', () => assert.deepEqual(opened2, [false, '收起', 'true', true, Math.round(placed)]));
    if (pictures) await page.screenshot({ path: path.join(pictures, 'phone-expanded-light-390.png') });

    await page.click('.speech-names [data-speech-member="' + a + '"]');
    const onlyA = await rows(page), pressed = await page.$eval('.speech-names [aria-pressed="true"]', n => n.textContent);
    const focused = await page.evaluate(() => document.activeElement?.dataset.speechMember);
    check('choosing Claude A keeps only what A said and was sent, and keeps focus on the chip', () => {
      assert.deepEqual(onlyA, ['项目经理 → Claude A | A，先修输入框，再补测试。', 'Claude A | 输入框修复已完成，改动如下：']);
      assert.equal(pressed, 'Claude A'); assert.equal(focused, a);
    });
    if (pictures) await page.screenshot({ path: path.join(pictures, 'phone-member-light-390.png') });
    await page.click('.speech-names [data-speech-member=""]');

    // A new message while reading the end: the page grows with it. Scrolled up: the reading place stays.
    sessions[2].messages.push({ id: 'a-new', role: 'assistant', status: 'complete', text: '测试补好了。', time: at(1) });
    await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
    await page.click('#connection button');
    await page.waitForFunction(() => [...document.querySelectorAll('.message.speech .bubble')].some(n => n.textContent === '测试补好了。'));
    const followed = await atBottom(page);
    check('at the end, a new message keeps the page at the newest', () => assert.ok(followed));
    sessions[3].messages.push({ id: 'b-new', role: 'assistant', status: 'complete', text: '文档交了。', time: at(0.5) });
    await page.evaluate(() => scrollTo(0, 300)); const top = await page.evaluate(() => scrollY);
    await page.click('#connection button');
    await page.waitForFunction(() => [...document.querySelectorAll('.message.speech .bubble')].some(n => n.textContent === '文档交了。'));
    const after = await page.evaluate(() => scrollY);
    check('scrolled up, a new message leaves the reading place alone', () => assert.equal(after, top));

    const english = await open(context, '#en/space/shared');
    const en = await english.page.$$eval('.speech-names button', list => list.map(n => n.textContent));
    const first = (await rows(english.page))[0];
    check('English names the same people and speaker', () => { assert.deepEqual(en.slice(0, 2), ['All', 'Butler']); assert.match(first, /^You → 项目经理/); });
    check('zero page errors', () => assert.deepEqual([...errors, ...english.errors], []));
  } finally { await browser.close(); }
  console.log(`phone space speech: ${passed} passed, 0 failed`);
})().catch(error => { console.error('FAIL', error); process.exitCode = 1; });
