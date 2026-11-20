// Actual phone assets and synthetic HTTP; server proof checks run in mobile-broker.test.cjs.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const scratch = require('./fixtures/test-scratch.cjs');
const { webkit, devices } = require('playwright');
const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '..');
const home = scratch.directory(path.join(os.tmpdir(), 'naw-f-phone-waiting-'));
const results = [], errors = [];
const check = (name, pass) => { results.push({ name, pass: Boolean(pass) }); console.log(JSON.stringify(results.at(-1))); };
let browser;
async function scene(status, mode = 'send') {
  const context = await browser.newContext({ ...devices['iPhone 13'], viewport: { width: 375, height: 667 }, serviceWorkers: 'block' }), page = await context.newPage();
  const calls = [], sessions = [{ id: 'a', name: 'Synthetic original', provider: 'codex', state: mode === 'steer' ? 'working' : 'idle', available: true, actions: ['read', 'send'] }];
  const item = { id: 'task', text: 'Synthetic waiting task', status: 'waiting', sentTo: 'a', question: 'Synthetic original question?', questionId: 'question-one', canAnswer: true };
  page.on('pageerror', e => errors.push(e.message));
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin !== 'https://phone.invalid') { errors.push('external-request'); return route.abort(); }
    let data;
    if (req.method() === 'POST') calls.push({ url: url.pathname, body: req.postDataJSON() });
    if (url.pathname === '/mobile/session') data = { deviceId: '00000000-0000-4000-8000-000000000001', csrf: 'C'.repeat(43), workspace: true, sessions };
    else if (url.pathname === '/mobile/read/a') data = { id: 'a', contextId: 'B'.repeat(43), canSend: true, sendMode: mode, messages: [], question: null };
    else if ((url.pathname === '/mobile/workspace' || /^\/mobile\/workspace\/(summary|session\/[^/]+|room\/[^/]+)$/.test(url.pathname))) data = { sessions: sessions.map(s => ({ ...s, messages: [] })), rooms: [{ id: 'shared', name: 'Synthetic space', queue: [item], members: sessions, messages: [] }], confirmations: [], reminders: null, capabilities: { push: false } };
    else if (url.pathname === '/mobile/send') {
      const p = req.postDataJSON(); data = { requestId: p.requestId, sessionId: 'a', action: 'send', status };
    } else if (url.pathname === '/mobile/workspace/action') {
      const p = req.postDataJSON();
      if (p.action === 'queueResolve') { item.status = 'done'; if (p.answerRequestId) item.answer = { text: 'SYNTHETIC_EXPLICIT_ANSWER', deliveredAt: 1 }; }
      data = { requestId: p.requestId, status: 'complete', itemId: 'task' };
    } else if (url.pathname === '/mobile/receipt') {
      const p = req.postDataJSON(); data = { requestId: p.requestId, sessionId: 'a', action: 'send', status: 'unconfirmed' };
    }
    if (data) return route.fulfill({ json: data });
    const file = url.pathname === '/mobile/' ? 'index.html' : url.pathname.slice(8);
    if (!['index.html', 'client.js', 'workspace.js', 'passkeys.js', 'push.js', 'style.css', 'manifest.webmanifest'].includes(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'application/json', body: fs.readFileSync(path.join(root, 'app/mobile-web', file)) });
  });
  await page.goto('https://phone.invalid/mobile/#zh/queue'); await page.waitForFunction(() => document.documentElement.dataset.loading === 'false');
  return { page, calls, item, close: () => context.close() };
}
(async () => {
  try {
    browser = await webkit.launch({ headless: true, executablePath: process.env.NAW_BROWSER_EXECUTABLE, env: { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: home } });
    for (const [status, mode] of [['submitted', 'send'], ['unconfirmed', 'send'], ['not-sent', 'send'], ['submitted', 'steer']]) {
      const s = await scene(status, mode), name = status + '/' + mode;
      try {
        const form = s.page.locator('.queue-answer');
        check(name + ' question and answer form are on the waiting card', await form.count() === 1 && (await s.page.locator('.queue-card').innerText()).includes('Synthetic original question?'));
        if (!await form.count()) continue;
        await form.locator('textarea').fill('SYNTHETIC_EXPLICIT_ANSWER');
        const button = form.getByRole('button', { name: '答复并标为已处理', exact: true });
        await button.tap(); await s.page.waitForTimeout(80); await s.page.waitForLoadState('networkidle');
        const sends = s.calls.filter(c => c.url === '/mobile/send'), marks = s.calls.filter(c => c.url === '/mobile/workspace/action');
        if (mode === 'steer') { check(name + ' busy mode sends and marks nothing', sends.length === 0 && marks.length === 0 && s.item.status === 'waiting'); check(name + ' busy feedback keeps the answer', await form.locator('textarea').inputValue() === 'SYNTHETIC_EXPLICIT_ANSWER' && (await form.innerText()).includes('不会插入或打断')); continue; }
        check(name + ' explicit send is bound to the original task and question', sends.length === 1 && sends[0].body.queueTarget.itemId === 'task' && sends[0].body.queueTarget.questionId === 'question-one');
        if (status === 'submitted') {
          check(name + ' marks only with this input receipt', marks.length === 1 && marks[0].body.answerRequestId === sends[0].body.requestId && s.item.status === 'done');
          const context = await s.page.evaluate(() => nawPhone.actions.state.pending.find(row => row.action === 'queueResolve')?.context);
          check(name + ' handling receipt retains its original space and task snapshot', context?.target === 'Synthetic space' && context?.text === s.item.text && !(await s.page.locator('.receipt').innerText()).includes('原任务内容未保存'));
          check(name + ' question and delivered answer remain on one card', (await s.page.locator('.queue-card').innerText()).includes('SYNTHETIC_EXPLICIT_ANSWER') && (await s.page.locator('.queue-card').innerText()).includes('Synthetic original question?'));
        } else {
          check(name + ' unconfirmed or unsent answer stays waiting', marks.length === 0 && s.item.status === 'waiting');
          check(name + ' answer survives reload without replay', await s.page.locator('.queue-answer textarea').inputValue() === 'SYNTHETIC_EXPLICIT_ANSWER');
          await s.page.reload(); await s.page.waitForFunction(() => document.documentElement.dataset.loading === 'false');
          check(name + ' reload retains the original text and never sends again', await s.page.locator('.queue-answer textarea').inputValue() === 'SYNTHETIC_EXPLICIT_ANSWER' && s.calls.filter(c => c.url === '/mobile/send').length === 1);
        }
      } finally { await s.close(); }
    }
    check('no page errors or external requests', errors.length === 0);
  } finally { await browser?.close(); }
  console.log(JSON.stringify({ pass: results.filter(r => r.pass).length, fail: results.filter(r => !r.pass).length }));
  process.exitCode = results.some(r => !r.pass) ? 1 : 0;
})().catch(e => { console.error(e.stack); process.exitCode = 1; }).finally(scratch.cleanup());
