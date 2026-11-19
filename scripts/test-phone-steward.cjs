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
let passed = 0;
const check = (label, fn) => { fn(); passed++; console.log('PASS ' + label); };
async function open(context, { steward, busy = false, hash }) {
  const list = structuredClone(steward && steward.state !== 'shared' ? sessions.slice(1) : sessions);
  if (busy) list[0].state = 'working';
  const page = await context.newPage();
  await page.route('**/*', route => {
    const p = new URL(route.request().url()).pathname, json = value => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
    if (p === '/mobile/') return route.fulfill({ status: 200, contentType: 'text/html', body: fs.readFileSync(path.join(web, 'index.html'), 'utf8').replaceAll('__NAW_SCRIPT_NONCE__', 'n') });
    if (/^\/mobile\/[a-z]+\.(js|css|webmanifest)$/.test(p)) return route.fulfill({ status: 200, contentType: p.endsWith('.css') ? 'text/css' : 'text/javascript', body: fs.readFileSync(path.join(web, path.basename(p))) });
    if (p === '/mobile/session') return json({ deviceId: '10000000-0000-4000-8000-000000000001', csrf: 'c'.repeat(43), workspace: true,
      sessions: list.map(s => ({ id: s.id, name: s.name, state: s.state, available: true, actions: ['read', 'send', 'answer'] })) });
    if (p === '/mobile/workspace') return json({ sessions: list.map(s => ({ ...s, question: false, roomIds: [], messages: [], earlierMessagesOmitted: 0 })), rooms: [],
      confirmations: [], reminders: null, syncedAt: now, capabilities: { queue: false, records: false, sensitiveDecisions: false, nativeTerminal: false, push: false }, ...(steward ? { steward } : {}) });
    if (p.startsWith('/mobile/read/')) { const id = decodeURIComponent(p.split('/').pop());
      return json({ id, contextId: 'x'.repeat(43), canSend: list.find(s => s.id === id)?.state === 'idle', question: null, messages: [], earlierMessagesOmitted: 0 }); }
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
    await page.close();
    page = await open(context, { steward: { state: 'shared', sessionId: butler }, busy: true, hash: '#zh/chat/' + butler });
    await page.fill('#message', 'Synthetic question');
    const busy = await page.evaluate(() => ({ note: document.getElementById('compose-note').textContent, disabled: document.getElementById('send-message').disabled }));
    check('a busy session says why sending waits and keeps the draft', () => assert.deepEqual(busy, { note: '对方空闲后才能从手机发送；草稿会保留。', disabled: true }));
    await page.close();
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
