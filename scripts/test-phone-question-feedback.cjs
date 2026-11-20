// Actual phone UI; synthetic HTTP only, with no provider runtime.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const scratch = require('./fixtures/test-scratch.cjs');
const { webkit, devices } = require('playwright');
const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '..');
const home = scratch.directory(path.join(os.tmpdir(), 'naw-f-phone-question-'));
const results = [], errors = [];
const check = (name, pass) => { results.push({ name, pass: Boolean(pass) }); console.log(JSON.stringify(results.at(-1))); };
let browser;
async function scene(lang, status = 'reply-written') {
  const context = await browser.newContext({ ...devices['iPhone 13'], viewport: { width: 375, height: 667 }, serviceWorkers: 'block' });
  const page = await context.newPage(), writes = [];
  const sessions = [{ id: 'one', name: 'Synthetic question', provider: 'claude', available: true, state: 'approval', actions: ['read', 'send'] }];
  let question = { questions: [{ id: 'choice', question: 'Synthetic choice?', options: [{ label: 'First' }, { label: 'Second' }] }] };
  let deviceId = '00000000-0000-4000-8000-000000000001', csrf = 'C'.repeat(43);
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== 'https://phone.invalid') { errors.push('external-request'); return route.abort(); }
    let data;
    if (url.pathname === '/mobile/session') data = { deviceId, csrf, workspace: true, sessions };
    else if (url.pathname === '/mobile/read/one') data = { id: 'one', contextId: 'B'.repeat(43), canSend: false, question, messages: [] };
    else if (url.pathname === '/mobile/answer') {
      writes.push(request.postDataJSON());
      if (status === 'reply-written') question = null;
      data = { requestId: writes.at(-1).requestId, sessionId: 'one', action: 'answer', status };
    } else if (url.pathname === '/mobile/workspace') data = { sessions: sessions.map(s => ({ ...s, messages: [] })), rooms: [], confirmations: [], reminders: null, capabilities: { push: false } };
    if (data) return route.fulfill({ json: data });
    const file = url.pathname === '/mobile/' ? 'index.html' : url.pathname.slice('/mobile/'.length);
    if (!['index.html', 'client.js', 'workspace.js', 'passkeys.js', 'push.js', 'style.css', 'manifest.webmanifest'].includes(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'application/json', body: fs.readFileSync(path.join(root, 'app/mobile-web', file)) });
  });
  await page.goto('https://phone.invalid/mobile/#' + lang + '/confirm/native/one');
  await page.waitForFunction(() => document.documentElement.dataset.loading === 'false' && document.querySelector('.native-question'));
  async function settled() { await page.waitForTimeout(60); await page.waitForLoadState('networkidle'); await page.waitForFunction(() => !nawPhone.client.state.busy); }
  return { page, writes, async answer() { await page.locator('.native-question input[value="First"]').check(); await page.locator('.native-question button[type="submit"]').tap(); await settled(); },
    async refresh() { await page.locator('#connection button').tap(); await settled(); },
    removeQuestion() { question = null; }, newQuestion() { question = { questions: [{ id: 'new', question: 'A different question?', options: [{ label: 'First' }] }] }; },
    newGrant() { deviceId = '00000000-0000-4000-8000-000000000002'; csrf = 'D'.repeat(43); }, close: () => context.close() };
}
(async () => {
  try {
    browser = await webkit.launch({ headless: true, executablePath: process.env.NAW_BROWSER_EXECUTABLE, env: { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: home } });
    for (const lang of ['zh', 'en']) {
      const s = await scene(lang);
      try {
        await s.answer();
        const text = await s.page.locator('#content').innerText();
        check(lang + ' answered question shows written feedback', text.includes(lang === 'zh' ? '回答已写入' : 'Answer written') && !text.includes(lang === 'zh' ? '请在 Mac 处理' : 'Handle this native'));
        check(lang + ' answer is posted once', s.writes.length === 1 && s.writes[0].answers.choice[0] === 'First');
        await s.refresh(); check(lang + ' refresh preserves completion', (await s.page.locator('#content').innerText()).includes(lang === 'zh' ? '回答已写入' : 'Answer written'));
        s.newQuestion(); await s.refresh(); check(lang + ' a new question remains actionable', await s.page.locator('.native-question').count() === 1);
        s.removeQuestion(); await s.refresh(); check(lang + ' a later disappeared question is not marked answered', await s.page.locator('.native-answer-status').count() === 0);
        check(lang + ' read and refresh never replay answers', s.writes.length === 1);
      } finally { await s.close(); }
    }
    for (const status of ['unconfirmed', 'not-sent']) {
      const s = await scene('zh', status);
      try { await s.answer(); s.removeQuestion(); await s.refresh(); check(status + ' cannot claim a written answer', await s.page.locator('.native-answer-status').count() === 0); check(status + ' posts once', s.writes.length === 1); }
      finally { await s.close(); }
    }
    const s = await scene('zh');
    try { await s.answer(); s.newGrant(); await s.refresh(); check('a replacement grant cannot inherit answered feedback', await s.page.locator('.native-answer-status').count() === 0); check('replacing the grant never replays', s.writes.length === 1); }
    finally { await s.close(); }
    check('no page errors or external requests', errors.length === 0);
  } finally { await browser?.close(); }
  console.log(JSON.stringify({ pass: results.filter(r => r.pass).length, fail: results.filter(r => !r.pass).length }));
  process.exitCode = results.some(r => !r.pass) ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(scratch.cleanup());
