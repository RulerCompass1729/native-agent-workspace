const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const scratch = require('./fixtures/test-scratch.cjs');
const { webkit, devices } = require('playwright');
const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '..');
const profile = scratch.directory(path.join(os.tmpdir(), 'naw-d-phone-keyboard-'));
const results = [], errors = [];
const check = (name, pass) => { results.push({ name, pass: Boolean(pass) }); console.log(JSON.stringify(results.at(-1))); };
async function settled(page) { await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))); }
(async () => {
  let browser;
  try {
    browser = await webkit.launch({ headless: true, executablePath: process.env.NAW_BROWSER_EXECUTABLE, env: { PATH: '/usr/bin:/bin', HOME: profile, TMPDIR: profile } });
    for (const lang of ['zh', 'en']) for (const landscape of [false, true]) {
      const context = await browser.newContext({ ...devices['iPhone 13'], viewport: landscape ? { width: 844, height: 390 } : { width: 390, height: 844 } });
      const page = await context.newPage(), posted = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.addInitScript(() => {
        const viewport = new EventTarget(); Object.assign(viewport, { height: innerHeight, width: innerWidth, offsetTop: 0, scale: 1 });
        Object.defineProperty(window, 'visualViewport', { value: viewport });
        window.syntheticViewport = values => { Object.assign(viewport, values); viewport.dispatchEvent(new Event('resize')); viewport.dispatchEvent(new Event('scroll')); };
      });
      const sessions = [{ id: 'a', name: 'Synthetic member', provider: 'claude', state: 'idle', available: true, actions: ['read', 'send'] }];
      await context.route('**/*', async route => {
        const url = new URL(route.request().url()); if (url.origin !== 'https://phone.invalid') return route.abort();
        let data;
        if (url.pathname === '/mobile/session') data = { deviceId: '00000000-0000-4000-8000-000000000001', csrf: 'A'.repeat(43), workspace: true, sessions };
        else if (url.pathname.startsWith('/mobile/read/')) data = { id: 'a', contextId: 'B'.repeat(43), canSend: true, sendMode: 'send', question: null, messages: [] };
        else if (url.pathname === '/mobile/workspace' || url.pathname.startsWith('/mobile/workspace/')) data = { sessions: sessions.map(s => ({ ...s, messages: [{ id: 'reply', role: 'assistant', text: 'Synthetic latest reply', time: 1 }] })), rooms: [], confirmations: [], reminders: { count: 0, records: [] }, capabilities: { push: false }, syncedAt: 1 };
        else if (url.pathname === '/mobile/send') { const value = route.request().postDataJSON(); posted.push(value); data = { requestId: value.requestId, sessionId: 'a', action: 'send', status: 'submitted' }; }
        if (data) return route.fulfill({ json: data });
        const name = url.pathname === '/mobile/' ? 'index.html' : url.pathname.slice('/mobile/'.length);
        if (!['index.html', 'style.css', 'client.js', 'workspace.js', 'passkeys.js', 'push.js', 'manifest.webmanifest'].includes(name)) return route.fulfill({ status: 404, body: '' });
        await route.fulfill({ contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.html') ? 'text/html' : 'application/json', body: fs.readFileSync(path.join(root, 'app/mobile-web', name)) });
      });
      try {
        await page.goto('https://phone.invalid/mobile/#' + lang + '/home');
        await page.locator(`#content a[href="#${lang}/chat/a"]`).click(); await page.locator('#message').waitFor();
        await page.locator('#message').fill('Synthetic 中文 draft');
        const label = lang + ' ' + (landscape ? 'landscape' : 'portrait');
        const geometry = () => page.evaluate(() => {
          const v = visualViewport, field = document.querySelector('#message'), send = document.querySelector('#send-message');
          const rects = [field, send].map(e => e.getBoundingClientRect().toJSON());
          return { rects, inside: rects.every(r => r.top >= v.offsetTop && r.bottom <= v.offsetTop + v.height && r.left >= 0 && r.right <= innerWidth && r.height >= 44), focused: document.activeElement === field, draft: field.value, note: document.querySelector('#compose-note').textContent, nav: getComputedStyle(document.querySelector('#navigation')).display, keyboard: document.body.classList.contains('keyboard-compose') };
        });
        const note = (await geometry()).note;
        // Layout viewport stays unchanged, as on Safari with its software keyboard open.
        await page.evaluate(height => syntheticViewport({ height, offsetTop: 0 }), landscape ? 66 : 360); await settled(page);
        const first = await geometry(); console.log(JSON.stringify({ label, first }));
        check(label + ' field and send fit the visual viewport', first.inside);
        check(label + ' focused draft and reason survive keyboard layout', first.focused && first.draft === 'Synthetic 中文 draft' && first.note === note);
        await page.evaluate(() => syntheticViewport({ offsetTop: 24 })); await settled(page);
        check(label + ' follows visual viewport scroll', (await geometry()).inside);
        await page.evaluate(() => { syntheticViewport({ height: innerHeight, offsetTop: 0 }); document.querySelector('#message').blur(); }); await settled(page);
        const restored = await geometry();
        check(label + ' dismissal restores navigation and preserves draft', restored.nav !== 'none' && !restored.keyboard && restored.draft === 'Synthetic 中文 draft');
        await page.evaluate(() => { document.querySelector('#message').focus(); syntheticViewport({ height: 200, scale: 2 }); }); await settled(page);
        check(label + ' pinch zoom is not treated as a keyboard', !(await geometry()).keyboard);
        await page.evaluate(() => syntheticViewport({ height: innerHeight, offsetTop: 0, scale: 1 }));
        check(label + ' layout never sends', posted.length === 0);
        await page.evaluate(height => syntheticViewport({ height }), landscape ? 66 : 360); await settled(page);
        for (const end of ['touchcancel', 'outside']) {
          await page.evaluate(end => {
            const button = document.querySelector('#send-message'), rect = button.getBoundingClientRect();
            const touch = { clientX: rect.left + 10, clientY: rect.top + 10 };
            const dispatch = (name, touches, changedTouches) => { const event = new Event(name, { bubbles: true, cancelable: true }); Object.defineProperties(event, { touches: { value: touches }, changedTouches: { value: changedTouches } }); button.dispatchEvent(event); };
            dispatch('touchstart', [touch], []);
            const final = end === 'outside' ? { clientX: rect.left - 20, clientY: rect.top - 20 } : touch;
            dispatch(end === 'outside' ? 'touchend' : end, [], [final]);
          }, end);
          check(label + ' ' + end + ' does not send', posted.length === 0 && await page.locator('#message').inputValue() === 'Synthetic 中文 draft');
        }
        await page.locator('#send-message').tap();
        await page.waitForFunction(() => !document.querySelector('#message').value);
        check(label + ' touch activation retains editing focus and sends once', await page.locator('#message').evaluate(e => document.activeElement === e) && posted.length === 1 && posted[0].text === 'Synthetic 中文 draft');
      } catch (error) { console.error(JSON.stringify({ errors, text: await page.locator('body').innerText() })); throw error; }
      finally { await context.close(); }
    }
    check('no page errors', errors.length === 0);
  } finally { await browser?.close(); await scratch.cleanup(); }
  const summary = { pass: results.filter(r => r.pass).length, fail: results.filter(r => !r.pass).length, skip: 0 }; console.log(JSON.stringify(summary)); if (summary.fail) process.exitCode = 1;
})().catch(e => { console.error(e); process.exitCode = 1; });
