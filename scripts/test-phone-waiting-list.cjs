// The phone 「等你」 list on home: actual phone assets in headless WebKit, synthetic HTTP through page.route, no listener.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const scratch = require('./fixtures/test-scratch.cjs');
const { webkit, devices } = require('playwright');
const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '..');
const profile = scratch.directory(path.join(os.tmpdir(), 'naw-phone-waiting-list-'));
const pictures = process.env.NAW_PICTURES_DIR || profile;
fs.mkdirSync(pictures, { recursive: true });
const results = [], errors = [];
const check = (name, pass) => { results.push({ name, pass: Boolean(pass) }); console.log(JSON.stringify(results.at(-1))); };
const now = 1795113660000;
let browser;
function summary(lang, { empty = false, long = false } = {}) {
  const zh = lang === 'zh';
  const sessions = [
    { id: 'butler', nativeId: 'native-butler', name: zh ? '大管家' : 'Butler', provider: 'claude', state: 'idle', question: false, roomIds: ['room'] },
    { id: 'review', nativeId: 'native-review', name: zh ? '代码复核' : 'Code review', provider: 'codex', state: empty ? 'idle' : 'approval', question: false, roomIds: ['room'] },
    { id: 'pages', nativeId: 'native-pages', name: zh ? '手机页面' : 'Phone pages', provider: 'claude', state: 'idle', question: !empty, roomIds: ['room'] },
  ].map(s => ({ ...s, available: true, actions: ['read', 'send', 'answer'], messages: [] }));
  const filler = Array.from({ length: 6 }, (_, n) => ({ id: 'filler-' + n, text: (zh ? '排着的任务 ' : 'Queued task ') + n, status: 'queued' }));
  const decide = { id: 'decide', text: zh ? '整理手机首页的入口' : 'Tidy the phone home entries', status: 'waiting', sentTo: 'pages', time: now - 60000, ownerEnded: false,
    question: long ? (zh ? '很长的问题'.repeat(30) : 'A very long synthetic question '.repeat(12)) : zh ? '底部导航保留四项还是五项？' : 'Keep four or five tabs in the bottom bar?', questionId: 'q1', canAnswer: true };
  const look = { id: 'look', text: zh ? '检查英文按钮有没有换行' : 'Check whether the English button wraps', status: 'waiting', reason: 'no-reply', sentTo: 'review', time: now - 30000, ownerEnded: false };
  const ended = { id: 'ended', text: zh ? '旧会话留下的决定' : 'A decision from an ended session', status: 'waiting', sentTo: 'gone', time: now, ownerEnded: true };
  const card = (id, batch, n) => ({ id, key: id, operationId: 'op-' + id, sessionId: 'review', nativeId: 'native-review', actorName: sessions[1].name, targetName: 'Synthetic target ' + n,
    state: 'confirmation-required', actionable: true, time: now - 10000 + n, expiresAt: now + 3600000, summary: { action: 'archiveSession', target: 'Synthetic target ' + n },
    titles: { zh: '归档会话', en: 'Archive session' }, title: 'Archive session', detail: 'Synthetic target ' + n, canDecide: false, ...(batch ? { batch, batchTitles: { zh: '归档会话', en: 'Archive session' } } : {}) });
  const expired = { ...card('expired', null, 9), expiresAt: now - 1000 };
  return {
    sessions,
    rooms: [{ id: 'room', name: zh ? '手机改版' : 'Phone redesign', members: sessions, messages: [], queue: empty ? filler : [...filler, decide, look, ended] }],
    confirmations: empty ? [] : [card('single', null, 1), card('b1', 'b1', 2), card('b2', 'b1', 3), expired],
    reminders: { count: 0, records: [] }, syncedAt: now, capabilities: { queue: true, records: false, push: false }, steward: { state: 'shared', sessionId: 'butler' },
  };
}
async function open(lang, options = {}, viewport = { width: 390, height: 844 }) {
  const context = await browser.newContext({ ...devices['iPhone 13'], viewport, serviceWorkers: 'block' }), page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  const data = summary(lang, options);
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin !== 'https://phone.invalid') { errors.push('external-request'); return route.abort(); }
    let json;
    if (url.pathname === '/mobile/session') json = { deviceId: '00000000-0000-4000-8000-000000000001', csrf: 'C'.repeat(43), workspace: true, sessions: data.sessions };
    else if (url.pathname.startsWith('/mobile/read/')) json = { id: url.pathname.split('/').at(-1), contextId: 'B'.repeat(43), canSend: true, messages: [], question: null };
    else if (url.pathname === '/mobile/workspace' || /^\/mobile\/workspace\/(summary|session\/[^/]+|room\/[^/]+)$/.test(url.pathname)) json = data;
    if (json) return route.fulfill({ json });
    const file = url.pathname === '/mobile/' ? 'index.html' : url.pathname.slice('/mobile/'.length);
    if (!['index.html', 'client.js', 'workspace.js', 'passkeys.js', 'push.js', 'style.css', 'manifest.webmanifest'].includes(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'application/json', body: fs.readFileSync(path.join(root, 'app/mobile-web', file)) });
  });
  await page.goto('https://phone.invalid/mobile/#' + lang + '/home');
  await page.waitForFunction(() => document.documentElement.dataset.loading === 'false');
  const settled = hash => page.waitForFunction(hash => document.documentElement.dataset.loading === 'false' && document.documentElement.dataset.route === hash, '#' + lang + '/' + hash);
  return { page, context, settled };
}
(async () => {
  browser = await webkit.launch({ headless: true, executablePath: process.env.NAW_BROWSER_EXECUTABLE, env: { PATH: '/usr/bin:/bin', HOME: profile, TMPDIR: profile } });
  console.log('WebKit ' + browser.version());
  for (const lang of ['zh', 'en']) {
    const zh = lang === 'zh', s = await open(lang);
    try {
      const list = s.page.locator('#waiting'), rows = list.locator('a.waiting-row');
      check(lang + ' home shows the list first, above the butler entry', await list.count() === 1 &&
        await s.page.evaluate(() => { const w = document.querySelector('#waiting'), b = document.querySelector('.butler-entry'); return Boolean(w && (!b || w.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)); }));
      const heading = await list.locator('.section-title').innerText();
      check(lang + ' heading says Needs you', heading.includes(zh ? '等你' : 'Needs you'));
      const kinds = await rows.evaluateAll(rs => rs.map(r => r.dataset.waitingKind));
      check(lang + ' rows in the desktop order, batch as one row, expired card and ended decision left out', JSON.stringify(kinds) === JSON.stringify(['decide', 'background-confirmation', 'background-confirmation', 'approval', 'question', 'look']));
      check(lang + ' heading count equals the rows', heading.includes(String(await rows.count())) && await rows.count() === 6);
      const hrefs = await rows.evaluateAll(rs => rs.map(r => r.getAttribute('href')));
      const expected = ['queue/room/decide', 'confirm/batch/b1,b2', 'confirm/single', 'chat/review', 'chat/pages', 'queue/room/look'].map(h => '#' + lang + '/' + h);
      check(lang + ' each row opens the page that already acts on it', JSON.stringify(hrefs) === JSON.stringify(expected));
      const first = await rows.first().innerText();
      check(lang + ' decision row shows the question, who asked and the space', first.includes(zh ? '底部导航' : 'Keep four or five') && first.includes(zh ? '手机页面' : 'Phone pages') && first.includes(zh ? '手机改版' : 'Phone redesign') && first.includes(zh ? '等你决定' : 'Decision'));
      check(lang + ' tags use the desktop words', JSON.stringify(await rows.locator('.tag').allInnerTexts()) === JSON.stringify(zh ? ['等你决定', '待你确认', '待你确认', '待你批准', '问题', '要你看看'] : ['Decision', 'Confirmation', 'Confirmation', 'Approval', 'Question', 'Take a look']));
      check(lang + ' no sideways scroll', await s.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await s.page.screenshot({ path: path.join(pictures, lang + '-home-waiting.png'), scale: 'css' });
      await rows.first().tap(); await s.settled('queue/room/decide');
      const card = s.page.locator('.queue-card[data-item-id="decide"]');
      check(lang + ' tapping a decision opens its space queue with that item in view and marked', await card.count() === 1 && await card.evaluate(el => el.classList.contains('flash')) &&
        await card.evaluate(el => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }));
      await s.page.screenshot({ path: path.join(pictures, lang + '-queue-opened.png'), scale: 'css' });
      await s.page.evaluate(() => nawPhone.refresh());
      await s.page.evaluate(() => scrollTo(0, 0));
      await s.page.evaluate(() => nawPhone.refresh());
      check(lang + ' a refresh does not pull the page back to the item', await s.page.evaluate(() => scrollY) === 0);
      await s.page.evaluate(hash => { location.hash = hash; }, '#' + lang + '/home'); await s.settled('home');
      await rows.nth(2).tap(); await s.settled('confirm/single');
      check(lang + ' tapping a confirmation opens that card', await s.page.locator('[data-confirmation-id="single"]').count() === 1);
      await s.page.evaluate(hash => { location.hash = hash; }, '#' + lang + '/home'); await s.settled('home');
      await rows.nth(1).tap(); await s.settled('confirm/batch/b1,b2');
      check(lang + ' tapping a batch opens the batch', (await s.page.locator('#content').innerText()).includes('2'));
    } finally { await s.context.close(); }
    const quiet = await open(lang, { empty: true });
    try {
      check(lang + ' nothing waiting: no list and home is as before', await quiet.page.locator('#waiting').count() === 0);
      await quiet.page.screenshot({ path: path.join(pictures, lang + '-home-nothing-waiting.png'), scale: 'css' });
    } finally { await quiet.context.close(); }
    const small = await open(lang, { long: true }, { width: 320, height: 568 });
    try {
      const row = small.page.locator('a.waiting-row').first();
      check(lang + ' a long question stays two lines on a small phone', await row.locator('strong').evaluate(el => el.getBoundingClientRect().height <= 2 * 1.6 * parseFloat(getComputedStyle(el).fontSize)) &&
        await small.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await small.page.screenshot({ path: path.join(pictures, lang + '-home-small-long.png'), scale: 'css' });
    } finally { await small.context.close(); }
  }
  check('no script errors or external requests', errors.length === 0);
  const fail = results.filter(r => !r.pass).length; console.log(JSON.stringify({ pass: results.length - fail, fail, skipped: 0, errors }));
  if (fail) process.exitCode = 1;
})().finally(scratch.cleanup(async () => { await browser?.close(); })).catch(error => { console.error(error.stack); process.exitCode = 1; });
