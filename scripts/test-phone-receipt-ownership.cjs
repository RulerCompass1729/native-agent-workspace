// Actual phone assets with synthetic scoped HTTP; no native provider.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const scratch = require('./fixtures/test-scratch.cjs');
const { webkit, devices } = require('playwright');
const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '..');
const home = scratch.directory(path.join(os.tmpdir(), 'naw-f-phone-receipts-'));
const results = [], errors = [];
const check = (name, pass) => { results.push({ name, pass: Boolean(pass) }); console.log(JSON.stringify(results.at(-1))); };
const deviceId = '00000000-0000-4000-8000-000000000001', oldDevice = '00000000-0000-4000-8000-000000000002';
const id = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
let browser;
async function scene(lang) {
  const context = await browser.newContext({ ...devices['iPhone 13'], viewport: { width: 375, height: 667 }, serviceWorkers: 'block' }), page = await context.newPage(), posts = [];
  const pending = [
    { sessionId: 'a', status: 'submitted', text: 'SYNTHETIC_A_INPUT' },
    { sessionId: 'a', status: 'unconfirmed', text: 'SYNTHETIC_A_UNCERTAIN' },
    { sessionId: 'b', action: 'answer', status: 'reply-written', text: '', question: 'SYNTHETIC_B_QUESTION', answer: 'SYNTHETIC_B_ANSWER' },
    { sessionId: 'missing', status: 'not-sent', text: 'SYNTHETIC_UNKNOWN' },
    { sessionId: 'a', status: 'submitted', text: 'SYNTHETIC_OLD_PAIR', deviceId: oldDevice },
  ].map((p, n) => ({ deviceId, requestId: id(n + 10), action: 'send', revision: 0, createdAt: 1000, ...p }));
  const operations = [
    { roomId: 'shared', itemId: 'task', action: 'queueCancel', status: 'complete' },
    { roomId: 'other', itemId: 'other-task', action: 'queueResolve', status: 'complete' },
    { action: 'queueCancel', status: 'unconfirmed' },
    { roomId: 'shared', itemId: 'missing-task', action: 'queueCancel', status: 'not-sent' },
  ].map((p, n) => ({ deviceId, requestId: id(n + 20), createdAt: 1000, ...p }));
  await context.addInitScript(({ pending, operations }) => {
    localStorage.setItem('naw.mobile.v1', JSON.stringify({ version: 1, drafts: [], pending }));
    localStorage.setItem('naw.mobile.workspace.v1', JSON.stringify({ version: 1, pending: operations }));
  }, { pending, operations });
  const sessions = ['a', 'b'].map(id => ({ id, name: 'Synthetic ' + id, provider: 'claude', available: true, state: 'idle', actions: ['read', 'send'] }));
  const rooms = [{ id: 'shared', name: 'Synthetic room', members: sessions, messages: [], queue: [{ id: 'task', text: 'SYNTHETIC_TASK', status: 'cancelled' }] }, { id: 'other', name: 'Other room', members: [], messages: [], queue: [{ id: 'other-task', text: 'SYNTHETIC_OTHER_TASK', status: 'done' }] }];
  page.on('pageerror', e => errors.push(e.message));
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin !== 'https://phone.invalid') { errors.push('external-request'); return route.abort(); }
    if (req.method() === 'POST') posts.push(url.pathname);
    let data;
    if (url.pathname === '/mobile/session') data = { deviceId, csrf: 'C'.repeat(43), workspace: true, sessions };
    else if (url.pathname.startsWith('/mobile/read/')) data = { id: url.pathname.split('/').at(-1), contextId: 'B'.repeat(43), canSend: true, messages: [], question: null };
    else if ((url.pathname === '/mobile/workspace' || /^\/mobile\/workspace\/(summary|session\/[^/]+|room\/[^/]+)$/.test(url.pathname))) data = { sessions: sessions.map(s => ({ ...s, messages: [] })), rooms, confirmations: [], reminders: null, capabilities: { push: false } };
    else if (url.pathname === '/mobile/receipt') data = { requestId: id(11), sessionId: 'a', action: 'send', status: 'unconfirmed' };
    if (data) return route.fulfill({ json: data });
    const file = url.pathname === '/mobile/' ? 'index.html' : url.pathname.slice(8);
    if (!['index.html', 'client.js', 'workspace.js', 'passkeys.js', 'push.js', 'style.css', 'manifest.webmanifest'].includes(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'application/json', body: fs.readFileSync(path.join(root, 'app/mobile-web', file)) });
  });
  await page.goto('https://phone.invalid/mobile/#' + lang + '/chat/a');
  await page.waitForFunction(() => document.documentElement.dataset.loading === 'false');
  async function go(hash) { await page.evaluate(hash => { location.hash = hash; }, '#' + lang + '/' + hash); await page.waitForTimeout(40); await page.waitForFunction(() => document.documentElement.dataset.loading === 'false'); }
  return { page, posts, go, close: () => context.close() };
}
(async () => {
  try {
    browser = await webkit.launch({ headless: true, executablePath: process.env.NAW_BROWSER_EXECUTABLE, env: { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: home } });
    for (const lang of ['zh', 'en']) {
      const s = await scene(lang);
      try {
        let text = await s.page.locator('#content').innerText();
        check(lang + ' only original-session native receipts appear', !text.includes(lang === 'zh' ? '回答已写入' : 'Answer written') && !text.includes(lang === 'zh' ? '操作已完成' : 'Action completed'));
        check(lang + ' current input and uncertain input are identifiable', text.includes('SYNTHETIC_A_INPUT') && text.includes('SYNTHETIC_A_UNCERTAIN'));
        check(lang + ' saved creation times survive missing legacy context', await s.page.locator('.receipt time[datetime=\"1970-01-01T00:00:01.000Z\"]').count() === 2);
        check(lang + ' missing targets are not attached to the current session', !text.includes(lang === 'zh' ? '未执行，输入保留' : 'Not executed; input retained'));
        const old = s.page.locator('.receipt').filter({ hasText: lang === 'zh' ? '旧配对' : 'old pairing' });
        check(lang + ' old pairing receipts have no action controls', await old.getByRole('button').count() === 0);
        const inspect = s.page.getByRole('button', { name: lang === 'zh' ? '查看原输入' : 'View original input', exact: true });
        check(lang + ' original input has a direct inspection control', await inspect.count() >= 1);
        if (await inspect.count()) { await inspect.first().tap(); check(lang + ' inspection shows exact original text', (await s.page.locator('#dialog-body').innerText()).includes('SYNTHETIC_A_INPUT')); await s.page.locator('#dialog-close').tap(); }
        await s.go('chat/b'); text = await s.page.locator('#content').innerText();
        check(lang + ' native answer shows only its recorded question and answer', text.includes('SYNTHETIC_B_QUESTION') && text.includes('SYNTHETIC_B_ANSWER') && !text.includes('SYNTHETIC_A_INPUT'));
        await s.go('queue'); text = await s.page.locator('#content').innerText();
        check(lang + ' queue receipts do not include native or other-room receipts', !text.includes(lang === 'zh' ? '回答已写入' : 'Answer written') && !text.includes('SYNTHETIC_OTHER_TASK'));
        check(lang + ' task operation has its task and operation identity', text.includes(lang === 'zh' ? 'SYNTHETIC_TASK · 取消任务' : 'SYNTHETIC_TASK · Cancel task'));
        await s.go('space/other'); text = await s.page.locator('#content').innerText();
        check(lang + ' other room owns its operation without mixing the first room', text.includes('SYNTHETIC_OTHER_TASK') && !text.includes('SYNTHETIC_TASK ·'));
        check(lang + ' navigation and inspection never resend', s.posts.every(p => p === '/mobile/receipt'));
      } finally { await s.close(); }
    }
    check('no page errors or external requests', errors.length === 0);
  } finally { await browser?.close(); }
  console.log(JSON.stringify({ pass: results.filter(r => r.pass).length, fail: results.filter(r => !r.pass).length }));
  process.exitCode = results.some(r => !r.pass) ? 1 : 0;
})().catch(e => { console.error(e.stack); process.exitCode = 1; }).finally(scratch.cleanup());
