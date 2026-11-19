// The phone home card and chat page for the Mac's butler: the real app/mobile-web files in a headless browser,
// answered by synthetic /mobile/* responses. No NAW service, pairing secret, model or network.
// NAW_BROWSER_EXECUTABLE picks the Chromium build when Playwright's own is not installed.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium } = require('playwright');
const web = path.resolve(__dirname, '../app/mobile-web');
const butler = 'b0000000-0000-4000-8000-000000000019', now = Date.parse('2026-11-18T14:05:00-08:00');
const sessions = [
  { id: butler, name: 'Synthetic butler · 19', provider: 'claude', state: 'idle' },
  { id: 'a0000000-0000-4000-8000-00000000000a', name: 'Synthetic member A', provider: 'claude', state: 'working' },
  { id: 'c0000000-0000-4000-8000-00000000000c', name: 'Synthetic member C', provider: 'codex', state: 'idle' },
];
const reasons = {
  notSelected: ['这次手机访问没选它', '这次是在 Mac 上挑了部分会话给手机，大管家不在其中。要在手机上和它对话，请在 Mac 的手机访问里选上它。'],
  unavailable: ['暂时打不开', '大管家会话现在不能在手机上打开，例如正在交接给新会话。请稍后刷新，或在 Mac 上查看。'],
  none: ['Mac 上还没有指定', '在 Mac 上把一个会话指定为大管家后，这里就能打开它、和它对话。'],
};
// A NAW dispatch, the butler's own reply (no name on the row) and the person's message, as the projection sends them.
const butlerRows = [{ id: 'd', role: 'user', name: 'NAW 派活', text: 'Synthetic dispatch', time: now - 3000 },
  { id: 'r', role: 'assistant', name: '', text: 'Synthetic reply', time: now - 2000 }, { id: 'h', role: 'user', name: '', text: 'Synthetic own message', time: now - 1000 }];
let passed = 0;
const check = (label, fn) => { fn(); passed++; console.log('PASS ' + label); };
let readWhenBusy = {};
async function open(context, { steward, busy = false, hash, rows = butlerRows }) {
  const list = structuredClone(steward && steward.state !== 'shared' ? sessions.slice(1) : sessions);
  if (busy) list[0].state = 'working';
  const page = await context.newPage();
  await page.route('**/*', route => {
    const p = new URL(route.request().url()).pathname, json = value => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
    if (p === '/mobile/') return route.fulfill({ status: 200, contentType: 'text/html', body: fs.readFileSync(path.join(web, 'index.html'), 'utf8').replaceAll('__NAW_SCRIPT_NONCE__', 'n') });
    if (/^\/mobile\/[a-z]+\.(js|css|webmanifest)$/.test(p)) return route.fulfill({ status: 200, contentType: p.endsWith('.css') ? 'text/css' : 'text/javascript', body: fs.readFileSync(path.join(web, path.basename(p))) });
    if (p === '/mobile/session') return json({ deviceId: '10000000-0000-4000-8000-000000000001', csrf: 'c'.repeat(43), workspace: true,
      sessions: list.map(s => ({ id: s.id, name: s.name, state: s.state, available: true, actions: ['read', 'send', 'answer'] })) });
    if (p === '/mobile/workspace') return json({ sessions: list.map(s => ({ ...s, question: false, roomIds: [], messages: s.id === butler ? (typeof rows === 'function' ? rows() : rows) : [], earlierMessagesOmitted: 0 })), rooms: [],
      confirmations: [], reminders: null, syncedAt: now, capabilities: { queue: false, records: false, sensitiveDecisions: false, nativeTerminal: false, push: false }, ...(steward ? { steward } : {}) });
    if (p.startsWith('/mobile/read/')) { const id = decodeURIComponent(p.split('/').pop());
      const idle = list.find(s => s.id === id)?.state === 'idle';
      return json({ id, contextId: 'x'.repeat(43), canSend: idle, ...(idle ? {} : readWhenBusy), question: null, messages: [], earlierMessagesOmitted: 0 }); }
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"MOBILE_DENIED"}' });
  });
  await page.goto('http://naw.test/mobile/' + hash);
  await page.waitForFunction(() => document.documentElement.dataset.loading === 'false');
  return page;
}
const listed = page => page.$$eval('section .box a.row strong', nodes => nodes.map(n => n.textContent));
(async () => {
  const executablePath = process.env.NAW_BROWSER_EXECUTABLE || undefined;
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'light' });
    let page = await open(context, { steward: { state: 'shared', sessionId: butler }, hash: '#zh/home' });
    const card = await page.$eval('.butler-entry', n => ({ tag: n.tagName, href: n.getAttribute('href'), text: n.innerText }));
    check('the butler card opens the current butler conversation', () => {
      assert.equal(card.tag, 'A'); assert.equal(card.href, '#zh/chat/' + butler);
      assert.match(card.text, /大管家/); assert.match(card.text, /Synthetic butler · 19/); assert.match(card.text, /空闲/);
    });
    const shared = await listed(page);
    check('the session list does not repeat the butler', () => assert.deepEqual(shared, ['Synthetic member A', 'Synthetic member C']));
    await page.close();
    page = await open(context, { steward: { state: 'shared', sessionId: butler }, hash: '#zh/chat/' + butler });
    await page.fill('#message', 'Synthetic question');
    const idle = await page.evaluate(() => ({ title: document.querySelector('.top-title').textContent, note: document.getElementById('compose-note').textContent, disabled: document.getElementById('send-message').disabled }));
    check('the butler chat is titled 大管家 and sends while idle', () => assert.deepEqual(idle, { title: '大管家', note: '草稿仅在此浏览器保存', disabled: false }));
    const authors = await page.$$eval('.thread .message', nodes => nodes.map(n => [n.classList.contains('human'), n.querySelector('.author span').textContent, n.querySelector('.avatar')?.textContent || null]));
    check('a NAW dispatch is not labelled as you; the butler\'s replies carry its name', () => assert.deepEqual(authors,
      [[false, 'NAW 派活', 'N'], [false, 'Synthetic butler · 19', 'C'], [true, '你', null]]));
    await page.close();
    // A long butler chat opens at its newest message, and its page has no 中断/接管 strip; a member's chat keeps it (2026-11-19).
    const long = Array.from({ length: 60 }, (_, i) => ({ id: 'l' + i, role: i % 2 ? 'assistant' : 'user', name: '', text: 'Synthetic line ' + i, time: now - (60 - i) * 1000 }));
    page = await open(context, { steward: { state: 'shared', sessionId: butler }, hash: '#zh/chat/' + butler, rows: long });
    const opened = await page.evaluate(() => { const last = [...document.querySelectorAll('.thread .message')].at(-1).getBoundingClientRect(), compose = document.getElementById('compose').getBoundingClientRect();
      return { scrolled: window.scrollY > 0, lastAboveCompose: last.bottom <= compose.top && last.bottom > 0, controls: document.querySelectorAll('.control-strip').length }; });
    check('a long butler chat opens at its newest message, above the input, with no 中断/接管', () => assert.deepEqual(opened, { scrolled: true, lastAboveCompose: true, controls: 0 }));
    await page.close();
    // A repaint (after a send, or 刷新) keeps a reader at the end at the end, and leaves one reading earlier rows where they were.
    let grown = false;
    const growing = () => grown ? [...long, { id: 'new', role: 'user', name: '', text: 'Synthetic sent', time: now }] : long;
    const repaint = async () => { grown = true; await page.click('.top button[aria-label="管理"]'); await page.click('.dialog-menu button:first-child'); await page.waitForFunction(() => document.querySelector('.thread .message:last-child')?.textContent.includes('Synthetic sent'));
      return page.evaluate(() => { const last = [...document.querySelectorAll('.thread .message')].at(-1).getBoundingClientRect(), compose = document.getElementById('compose').getBoundingClientRect();
        return { y: Math.round(window.scrollY), lastInView: last.bottom <= compose.top && last.bottom > 0 }; }); };
    page = await open(context, { steward: { state: 'shared', sessionId: butler }, hash: '#zh/chat/' + butler, rows: growing });
    const atEnd = await repaint();
    await page.close();
    grown = false; page = await open(context, { steward: { state: 'shared', sessionId: butler }, hash: '#zh/chat/' + butler, rows: growing });
    await page.evaluate(() => window.scrollTo(0, 400)); const earlier = await repaint();
    check('a repaint keeps the end in view for a reader at the end, and keeps an earlier place', () => {
      assert.equal(atEnd.lastInView, true); assert.equal(earlier.y, 400); assert.equal(earlier.lastInView, false);
    });
    await page.close();
    page = await open(context, { steward: { state: 'shared', sessionId: butler }, hash: '#zh/chat/' + sessions[1].id });
    const member = await page.$$eval('.control-strip button', nodes => nodes.map(n => n.textContent));
    check('a member chat keeps its 中断/接管 strip', () => assert.deepEqual(member, ['中断', '接管']));
    await page.close();
    // A busy butler takes a queued message, as a busy Claude session does; only a named refusal disables the button (2026-11-19).
    const compose = () => page.evaluate(() => ({ button: document.getElementById('send-message').textContent, note: document.getElementById('compose-note').textContent, disabled: document.getElementById('send-message').disabled }));
    const buttonHeight = () => page.$eval('#send-message', n => Math.round(n.getBoundingClientRect().height));
    readWhenBusy = { canSend: true, sendMode: 'queueMidturn' };
    page = await open(context, { steward: { state: 'shared', sessionId: butler }, busy: true, hash: '#zh/chat/' + butler });
    await page.fill('#message', 'Synthetic question');
    const queued = await compose();
    check('a busy butler queues the message instead of waiting for idle', () => assert.deepEqual(queued,
      { button: '工具结束时送进本轮\u00a0↑', note: 'Claude 在本轮下一个工具结束时读到；本轮先结束就作为下一条发送。不中断当前工作。', disabled: false }));
    await page.close();
    for (const [reason, note] of [['storage', /保存不了记录/], ['noQueue', /不支持回复中排队/], [undefined, /收不了消息/]]) {
      readWhenBusy = { canSend: false, sendMode: null, sendBlocked: reason };
      page = await open(context, { steward: { state: 'shared', sessionId: butler }, busy: true, hash: '#zh/chat/' + butler });
      await page.fill('#message', 'Synthetic question');
      const refused = await compose(), height = await buttonHeight();
      check('a refusal says why in plain words, never "wait until idle", and 发送 stays on one line: ' + reason, () => {
        assert.match(refused.note, note); assert.doesNotMatch(refused.note, /空闲/); assert.equal(refused.disabled, true); assert.ok(height <= 46, 'button height ' + height);
      });
      await page.close();
    }
    readWhenBusy = {};
    for (const [state, [line, help]] of Object.entries(reasons)) {
      page = await open(context, { steward: { state }, hash: '#zh/home' });
      const tag = await page.$eval('.butler-entry', n => n.tagName), shown = await page.$eval('.butler-entry p', n => n.textContent);
      await page.click('.butler-entry');
      const dialog = await page.$eval('#dialog-body', n => n.innerText), card = await page.$eval('.butler-entry', n => n.innerText);
      check('an unopened butler card says the actual reason: ' + state, () => {
        assert.equal(tag, 'BUTTON'); assert.equal(shown, line); assert.equal(dialog, help);
        assert.doesNotMatch(card + dialog, /未在本次配对授权内|本次配对未授权此范围/);
      });
      await page.close();
    }
    page = await open(context, { hash: '#zh/home' });
    const legacy = { card: await page.$('.butler-entry'), list: await listed(page) };
    check('a view without the field shows no butler card and keeps every session', () => {
      assert.equal(legacy.card, null); assert.deepEqual(legacy.list, sessions.map(s => s.name));
    });
    await page.close();
    page = await open(context, { steward: { state: 'notSelected' }, hash: '#en/home' });
    const english = await page.$eval('.butler-entry', n => n.innerText);
    check('English names the same reason', () => { assert.match(english, /Butler/); assert.match(english, /Not chosen for this phone/); });
    await page.close();
  } finally { await browser.close(); }
  console.log(`phone steward: ${passed} passed, 0 failed`);
})().catch(error => { console.error('FAIL', error); process.exitCode = 1; });
