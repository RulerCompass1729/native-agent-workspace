// Synthetic persisted receipts, actual phone assets and WebKit; no native provider.
const scratch = require('./fixtures/test-scratch.cjs');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { webkit, devices } = require('playwright');
const { KEY, receiptContext } = require('../app/mobile-web/client.js');
const { ACTION_KEY } = require('../app/mobile-web/workspace.js');
const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '..');
const profile = scratch.directory(path.join(os.tmpdir(), 'naw-phone-receipts-'));
const pictures = process.env.NAW_PICTURES_DIR || profile;
fs.mkdirSync(pictures, { recursive: true });
const results = [], errors = [], posts = [], deviceId = '10000000-0000-4000-8000-000000000001';
const check = (name, pass) => { results.push({ name, pass: Boolean(pass) }); console.log(JSON.stringify(results.at(-1))); };
const ids = [1, 2, 3].map(n => '20000000-0000-4000-8000-' + String(n).padStart(12, '0'));
let browser;
async function open(lang, { blocked = false, duplicate = false, long = false, uncertain = false, legacy = false, oldPair = false } = {}) {
  const zh = lang === 'zh', context = await browser.newContext({ ...devices['iPhone 13'], viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const names = zh ? ['大管家', '代码复核', '手机页面'] : ['Butler', 'Code review', 'Phone pages'];
  const originals = zh ? ['汇总手机页面的问题', '检查英文按钮有没有换行', '添加一项手机回执检查'] : ['Summarize the phone page issues', 'Check whether the English button wraps', 'Add a phone receipt check'];
  if (long) originals[0] = 'Literal <script>never executed</script> 😀 '.repeat(8);
  const draft = zh ? '再帮我检查一下底部导航' : 'Please check the bottom navigation too';
  const sessions = ['butler', 'review'].map((id, i) => ({ id, nativeId: 'native-' + id, name: names[i], provider: 'claude', state: 'idle', available: true, actions: ['read', 'send', 'answer'] }));
  const native = sessions.map((s, i) => ({ deviceId, sessionId: s.id, requestId: ids[i], action: 'send', text: originals[i], revision: 1, status: uncertain && i === 0 ? 'unconfirmed' : 'submitted',
    context: { ...receiptContext({ target: s.name, scope: 'session', targetId: s.id, nativeId: s.nativeId }), at: 1795113720000 + i * 60000 } }));
  const action = { deviceId, requestId: ids[2], action: 'queueAdd', status: 'complete', roomId: 'room', itemId: 'task',
    context: { ...receiptContext({ target: names[2], text: originals[2], scope: 'room', targetId: 'room' }), at: 1795113840000 } };
  if (duplicate) { native[1] = { ...native[0], requestId: ids[1] }; originals[1] = originals[0]; }
  if (legacy) { for (const row of native) delete row.context; delete action.context; }
  if (oldPair) { for (const row of native) row.deviceId = '10000000-0000-4000-8000-000000000099'; action.deviceId = native[0].deviceId; }
  await context.addInitScript(({ KEY, ACTION_KEY, native, action, draft, deviceId }) => {
    if (!localStorage.getItem(KEY)) {
      localStorage.setItem(KEY, JSON.stringify({ version: 1, drafts: [{ deviceId, sessionId: 'butler', text: draft, revision: 2 }], pending: native }));
      localStorage.setItem(ACTION_KEY, JSON.stringify({ version: 1, pending: [action] }));
    }
  }, { KEY, ACTION_KEY, native, action, draft, deviceId });
  let narrowed = false, confirmReceipt = !uncertain;
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin !== 'https://phone.invalid') { errors.push('External request'); return route.abort(); }
    let data;
    if (req.method() === 'POST') posts.push({ route: url.pathname, value: req.postDataJSON() });
    if (url.pathname === '/mobile/session') data = { deviceId, csrf: (narrowed ? 'd' : 'c').repeat(43), workspace: !narrowed, sessions: narrowed ? sessions.slice(0, 1) : sessions };
    else if (url.pathname.startsWith('/mobile/read/')) data = { id: url.pathname.split('/').at(-1), contextId: 'x'.repeat(43), canSend: !blocked, sendBlocked: blocked ? 'noQueue' : null, messages: [], question: null };
    else if (url.pathname === '/mobile/receipt') data = { requestId: req.postDataJSON().requestId, sessionId: 'butler', action: 'send', status: confirmReceipt ? 'submitted' : 'unconfirmed' };
    else if ((url.pathname === '/mobile/workspace' || /^\/mobile\/workspace\/(summary|session\/[^/]+|room\/[^/]+)$/.test(url.pathname))) data = { sessions: sessions.map(s => ({ ...s, messages: s.id === 'butler' ? [{ id: 'reply', role: 'assistant', text: zh ? '我会分别检查回执和按钮。' : 'I will check the receipts and the button.', time: 1795113660000 }] : [] })),
      rooms: [{ id: 'room', name: names[2], members: [], messages: [], queue: [{ id: 'task', text: originals[2], status: 'queued' }] }], reminders: { count: 0, records: [] }, confirmations: [], syncedAt: 1795113660000,
      capabilities: { queue: true, records: false, push: false }, steward: { state: 'shared', sessionId: 'butler' } };
    if (data) return route.fulfill({ json: data });
    const file = url.pathname === '/mobile/' ? 'index.html' : url.pathname.slice('/mobile/'.length);
    if (!['index.html', 'client.js', 'workspace.js', 'push.js', 'passkeys.js', 'style.css', 'manifest.webmanifest'].includes(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'application/json', body: fs.readFileSync(path.join(root, 'app/mobile-web', file)) });
  });
  await page.goto('https://phone.invalid/mobile/#' + lang + '/chat/butler');
  await page.waitForFunction(() => document.documentElement.dataset.loading === 'false' && document.querySelector('#message'));
  async function go(target) { const hash = '#' + lang + '/' + target; await page.evaluate(hash => { location.hash = hash; }, hash); await page.waitForFunction(hash => document.documentElement.dataset.loading === 'false' && document.documentElement.dataset.route === hash, hash); }
  return { page, context, names, originals, draft, go, confirmReceipt: () => { confirmReceipt = true; }, narrow: async () => { narrowed = true; await page.evaluate(() => nawPhone.refresh()); } };
}
async function framed(page, file) {
  const heading = page.locator('.receipt-heading');
  const anchor = await heading.count() ? heading : page.locator('.receipt').first();
  await anchor.evaluate(el => scrollBy(0, el.getBoundingClientRect().top - 80));
  await page.screenshot({ path: path.join(pictures, file + '.png'), scale: 'css' });
}
(async () => {
  browser = await webkit.launch({ headless: true, executablePath: process.env.NAW_BROWSER_EXECUTABLE, env: { PATH: '/usr/bin:/bin', HOME: profile, TMPDIR: profile } });
  console.log('WebKit ' + browser.version());
  const targets = ['chat/butler', 'chat/review', 'queue/room'];
  const drafts = page => page.evaluate(KEY => JSON.parse(localStorage.getItem(KEY)).drafts, KEY);
  for (const lang of ['zh', 'en']) {
    const s = await open(lang), rows = s.page.locator('.receipt'), labels = [];
    try {
      for (const [i, target] of targets.entries()) {
        await s.go(target);
        const text = await rows.allInnerTexts();
        check(lang + ' source ' + i + ': all three receipts identify their own target and original', text.length === 1 && text[0].includes(s.names[i]) && text[0].includes(s.originals[i]));
        check(lang + ' source ' + i + ': sent input and added task have distinct honest outcomes', text.length === 1 && text[0].includes(i === 2 ? lang === 'zh' ? '任务已添加' : 'Task added' : lang === 'zh' ? '会话已收到' : 'The session received it'));
        check(lang + ' source ' + i + ': initiation time is present for every receipt', await rows.locator('time[datetime]').count() === 1);
        const names = await rows.locator('button.receipt-control').evaluateAll(bs => bs.map(b => b.getAttribute('aria-label')));
        check(lang + ' source ' + i + ': removal names identify the exact original request', names.length === 1 && names[0]?.includes(ids[i]) && names[0].includes(s.names[i]));
        labels.push(...names);
        await framed(s.page, lang + '-source-' + i);
      }
      check(lang + ' removal names are unique across all three source pages', labels.length === 3 && new Set(labels).size === 3);
      await s.go('chat/butler');
      check(lang + ' butler page never includes review or room receipts', await rows.count() === 1 && await s.page.locator('.receipt[data-request-id="' + ids[1] + '"],.receipt[data-request-id="' + ids[2] + '"]').count() === 0 && !(await rows.allInnerTexts()).join('\n').includes(s.names[1]) && !(await rows.allInnerTexts()).join('\n').includes(s.originals[1]) && !(await rows.allInnerTexts()).join('\n').includes(s.originals[2]));
      check(lang + ' draft has a separate persistent label', await s.page.locator('label[for="message"]').innerText() === (lang === 'zh' ? '未发送的草稿' : 'Unsent draft'));
      for (const i of [1, 0, 2]) {
        await s.go(targets[i]);
        if (i === 1) await s.page.locator('#message').fill('SYNTHETIC_REVIEW_DRAFT_' + lang);
        const before = await drafts(s.page), countBefore = await rows.count();
        await rows.locator('button.receipt-control').tap();
        const pending = await s.page.evaluate(({ KEY, ACTION_KEY }) => JSON.parse(localStorage.getItem(KEY)).pending.length + JSON.parse(localStorage.getItem(ACTION_KEY)).pending.length, { KEY, ACTION_KEY });
        check(lang + ' source ' + i + ': deleting a receipt changes its count 1 to 0 and keeps drafts', countBefore === 1 && await rows.count() === 0 && JSON.stringify(await drafts(s.page)) === JSON.stringify(before) && await s.page.locator('.receipt-heading').count() === 0);
        if (i === 1) {
          check(lang + ' removing the second receipt changes count 3 to 2 and keeps the draft', pending === 2 && JSON.stringify(await drafts(s.page)) === JSON.stringify(before));
          const saved = await s.page.evaluate(KEY => JSON.parse(localStorage.getItem(KEY)).pending.map(p => p.requestId), KEY);
          check(lang + ' removal retains only the other original IDs', saved.length === 1 && saved[0] === ids[0]);
          await s.go('chat/butler'); await s.page.reload();
          await s.page.waitForFunction(() => document.documentElement.dataset.loading === 'false' && document.querySelector('#message'));
          const retained = await s.page.evaluate(({ KEY, ACTION_KEY }) => JSON.parse(localStorage.getItem(KEY)).pending.length + JSON.parse(localStorage.getItem(ACTION_KEY)).pending.length, { KEY, ACTION_KEY });
          check(lang + ' removal and draft persist after reload', retained === 2 && await s.page.locator('#message').inputValue() === s.draft);
        }
      }
      await s.go('chat/butler');
      check(lang + ' all exact removals still retain the original chat draft', await rows.count() === 0 && await s.page.locator('#message').inputValue() === s.draft);
    } finally { await s.context.close(); }
    const blocked = await open(lang, { blocked: true });
    try {
      for (const width of [320, 390, 430]) {
        await blocked.page.setViewportSize({ width, height: 844 });
        const geometry = await blocked.page.evaluate(() => {
          const b = document.querySelector('#send-message'), n = document.querySelector('#compose-note'), br = b.getBoundingClientRect(), nr = n.getBoundingClientRect();
          const range = document.createRange(); range.selectNodeContents(b);
          return { disabled: b.disabled, width: br.width, height: br.height, lines: range.getClientRects().length, noteBottom: nr.bottom, buttonTop: br.top, overflow: document.documentElement.scrollWidth > innerWidth };
        });
        check(lang + ' ' + width + ' busy note owns a line; Send is single-line and touch-sized', geometry.disabled && geometry.lines === 1 && geometry.height >= 44 && geometry.width >= 44 && geometry.noteBottom <= geometry.buttonTop && !geometry.overflow);
      }
      await blocked.page.setViewportSize({ width: 390, height: 844 }); await blocked.page.evaluate(() => scrollTo(0, 0));
      await blocked.page.screenshot({ path: path.join(pictures, lang + '-blocked.png'), scale: 'css' });
    } finally { await blocked.context.close(); }
    for (const target of ['chat/review', 'queue/room']) {
      const mask = await open(lang);
      try {
        await mask.go(target);
        const index = target === 'chat/review' ? 1 : 2;
        check(lang + ' masking positive control sees the original source receipt: ' + target, (await mask.page.locator('.receipt').innerText()).includes(mask.originals[index]));
        await mask.narrow(); const body = await mask.page.locator('body').innerText();
        check(lang + ' same-device narrower grant masks the removed session and room snapshots: ' + target, !body.includes(mask.names[1]) && !body.includes(mask.originals[1]) && !body.includes(mask.names[2]) && !body.includes(mask.originals[2]));
        const aria = await mask.page.getByRole('button').evaluateAll(bs => bs.map(b => b.getAttribute('aria-label')).join(' '));
        check(lang + ' masked correlation is absent from accessible removal names too: ' + target, !aria.includes(mask.names[1]) && !aria.includes(mask.originals[1]) && !aria.includes(mask.names[2]));
        await mask.go('chat/butler'); await mask.page.evaluate(() => nawPhone.client.invalidate());
        check(lang + ' revocation masks every local summary while retaining local records: ' + target, !(await mask.page.locator('body').innerText()).includes(mask.originals[0]) && await mask.page.evaluate(({ KEY, original }) => localStorage.getItem(KEY).includes(original), { KEY, original: mask.originals[0] }));
      } finally { await mask.context.close(); }
    }
    const duplicate = await open(lang, { duplicate: true });
    try {
      const labels = await duplicate.page.locator('.receipt button.receipt-control').evaluateAll(bs => bs.map(b => b.getAttribute('aria-label')));
      check(lang + ' duplicates remain distinct on their shared source page', labels.length === 2 && new Set(labels).size === 2 && labels.every((x, i) => x.includes(ids[i])));
      await duplicate.go('queue/room'); labels.push(...await duplicate.page.locator('.receipt button.receipt-control').evaluateAll(bs => bs.map(b => b.getAttribute('aria-label'))));
      check(lang + ' same text, target and minute still identify different requests', labels.length === 3 && new Set(labels).size === 3 && labels.every((x, i) => x?.includes(ids[i])));
    } finally { await duplicate.context.close(); }
    const edge = await open(lang, { long: true, uncertain: true });
    try {
      const first = edge.page.locator('.receipt').first(), summary = first.locator('summary');
      check(lang + ' long original has a native disclosure instead of silently losing text', await summary.count() === 1);
      if (await summary.count()) { await summary.focus(); await summary.press('Enter'); check(lang + ' original disclosure is keyboard operable and literal', await first.locator('details').getAttribute('open') !== null && (await first.locator('details p').innerText()) === edge.originals[0]); }
      check(lang + ' script markup remains literal and creates no script element', await first.locator('script').count() === 0 && (await first.locator('details p').innerText()).includes('<script>never executed</script>'));
      check(lang + ' uncertain receipt has no remove control', !(await first.getByRole('button').allTextContents()).some(t => /Remove|移除/.test(t)));
      const before = posts.length; edge.confirmReceipt(); await first.locator('button.receipt-control').tap();
      await edge.page.waitForFunction(() => nawPhone.client.state.pending[0].status === 'submitted');
      check(lang + ' checking an uncertain receipt uses its original ID without metadata or resend', posts.length === before + 1 && posts.at(-1).route === '/mobile/receipt' && JSON.stringify(posts.at(-1).value) === JSON.stringify({ requestId: ids[0] }));
    } finally { await edge.context.close(); }
    const legacy = await open(lang, { legacy: true });
    try {
      await legacy.go('queue/room'); const text = await legacy.page.locator('.receipt').innerText();
      check(lang + ' legacy action explicitly admits missing original and timestamp', text.includes(lang === 'zh' ? '原任务内容未保存' : 'Original task was not saved') && text.includes(lang === 'zh' ? '时间未记录' : 'Time not saved'));
    } finally { await legacy.context.close(); }
    const old = await open(lang, { oldPair: true });
    try {
      const row = old.page.locator('.receipt');
      check(lang + ' old pairing shows a masked source receipt without controls', await row.count() === 1 && (await row.innerText()).includes(lang === 'zh' ? '旧配对' : 'old pairing') && !(await row.innerText()).includes(old.originals[0]) && await row.getByRole('button').count() === 0);
    } finally { await old.context.close(); }
  }
  check('no script errors or external requests', errors.length === 0);
  const fail = results.filter(r => !r.pass).length; console.log(JSON.stringify({ pass: results.length - fail, fail, skipped: 0 }));
  if (fail) process.exitCode = 1;
})().finally(scratch.cleanup(async () => { await browser?.close(); })).catch(error => { console.error(error.stack); process.exitCode = 1; });
