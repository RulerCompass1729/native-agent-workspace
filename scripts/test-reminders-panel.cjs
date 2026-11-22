// Real browser layout of the bell, with synthetic records and no service connection.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..'), evidence = process.env.NAW_EVIDENCE_DIR, pictures = process.env.NAW_PICTURES_DIR || evidence;
if (!evidence || !pictures || !process.env.NAW_BROWSER_EXECUTABLE) throw Error('Set NAW_EVIDENCE_DIR, NAW_PICTURES_DIR and NAW_BROWSER_EXECUTABLE');
fs.mkdirSync(evidence, { recursive: true }); fs.mkdirSync(pictures, { recursive: true });
const now = Date.now(), cards = Array.from({ length: 40 }, (_, n) => ({
  id: 'past-' + n, key: 'synthetic:native:' + n, sessionId: 'synthetic', nativeId: 'native', operationId: 'op-' + n,
  actorName: 'Agent A', targetName: 'Agent B', title: n === 39 ? 'A complete action with a deliberately long description that must remain available after visual truncation' : 'Review current task',
  state: n === 38 ? 'confirmation-required' : 'complete', disposition: n === 38 ? 'expired' : undefined, actionable: false,
  time: now - (41 - n) * 3600000, finishedAt: now - (41 - n) * 3600000 + 40000,
}));
cards.push({ ...cards[0], id: 'pending', key: 'synthetic:native:pending', state: 'confirmation-required', disposition: undefined, actionable: true, time: now - 60000, expiresAt: now + 300000 });
const checks = [], failures = [], metrics = [];
async function check(name, action) { try { await action(); checks.push(name); console.log('PASS: ' + name); } catch (error) { failures.push({ name, error: error.message }); console.error('FAIL: ' + name + ': ' + error.message); } }
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.NAW_BROWSER_EXECUTABLE, headless: true });
  try {
    for (const language of ['zh', 'en']) for (const theme of ['light', 'dark']) {
      const name = language + '-' + theme, page = await browser.newPage({ viewport: { width: 860, height: 820 }, locale: language, timezoneId: 'America/Los_Angeles' });
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => route.abort());
      await page.setContent('<!doctype html><html lang="' + language + '"><head><meta charset="utf-8"></head><body><button id="bell">Reminders</button><span id="badge"></span><dialog id="records-dialog" class="records-dialog"></dialog></body></html>');
      await page.addStyleTag({ content: fs.readFileSync(path.join(root, 'app/renderer/styles.css'), 'utf8') });
      await page.addStyleTag({ content: 'dialog{border:1px solid var(--border);background:var(--raised);color:var(--ink);border-radius:12px}' + (theme === 'dark' ? ':root{--dsw-alias-label-primary:#e4e7e1;--dsw-alias-label-secondary:#a1aa9a;--dsw-alias-bg-base:#1d211c;--dsw-alias-bg-layer-1:#262c24;--dsw-alias-bg-layer-2:#2b3029;--dsw-alias-interactive-bg-hover-solid:#394134;--dsw-alias-border-l2:#485242}' : '') });
      for (const file of ['ui-messages.js', 'ui-locale.js', 'renderer/disclosure-list.js', 'renderer/record-reminders.js']) await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'app', file), 'utf8') });
      await page.evaluate(async ({ cards, now, language }) => {
        globalThis.calls = []; globalThis.visited = [];
        globalThis.view = nativeWorkspaceRecordReminders.bind({ button: document.getElementById('bell'), badge: document.getElementById('badge'), dialog: document.getElementById('records-dialog'), document, now: () => now,
          text: (key, params) => nativeWorkspaceLocale.format(language, key, params),
          api: { records: async action => { calls.push(action); return { count: 1, records: [], confirmations: cards }; } },
          confirmation: async target => { visited.push(target); return true; } });
        await view.open();
      }, { cards, now, language });
      await page.screenshot({ path: path.join(pictures, name + '-actual-pending.png') });
      await page.locator('[data-action="allConfirmations"]').click();
      const dialog = page.locator('#records-dialog');
      const geometry = await page.locator('.records-confirmation-link').evaluateAll(links => links.map(link => ({ key: link.dataset.confirmationKey, height: link.getBoundingClientRect().height })));
      metrics.push({ name, geometry, historySummaryHeights: await dialog.locator('details.records-history > summary').evaluateAll(rows => rows.map(row => row.getBoundingClientRect().height)) });
      await check(name + ' absolute timestamps', async () => {
        assert.equal(await dialog.locator('.records-confirmation-time').count(), 16);
        assert.ok(await dialog.locator('.records-confirmation-time').first().getAttribute('datetime'));
        assert.ok(await dialog.locator('.records-confirmation-time').first().getAttribute('aria-label'));
      });
      await check(name + ' finished rows occupy one line', async () => {
        const heights = await dialog.locator('details.records-history > summary').evaluateAll(rows => rows.map(row => row.getBoundingClientRect().height));
        assert.equal(heights.length, 15); assert.ok(heights.every(height => height >= 28 && height <= 38), JSON.stringify(heights));
        assert.equal(await dialog.locator('details .records-confirmation-waited').count(), 0);
      });
      await check(name + ' expired disposition is not presented as waiting', async () => {
        const expired = dialog.locator('details.records-history').filter({ has: page.locator('[data-confirmation-key="synthetic:native:38"]') });
        assert.equal(await expired.count(), 1);
        assert.equal(await expired.locator('.records-confirmation-waited').count(), 0);
        assert.ok((await expired.locator('summary').innerText()).includes(language === 'zh' ? '已过期' : 'Expired'));
      });
      await check(name + ' All has a history heading', async () => {
        assert.equal(await dialog.locator('[data-record="confirmations"] > h3').innerText(), language === 'zh' ? '确认记录' : 'Confirmation history');
      });
      await page.screenshot({ path: path.join(pictures, name + '-actual-collapsed.png') });
      await check(name + ' history expands with keyboard and survives refresh', async () => {
        const summary = dialog.locator('details.records-history > summary').first(); assert.equal(await summary.count(), 1);
        await summary.focus(); await page.keyboard.press('Enter');
        await page.waitForFunction(() => document.querySelector('details.records-history')?.open);
        await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
        await page.evaluate(() => view.refresh());
        assert.equal(await dialog.locator('details.records-history').first().getAttribute('open'), '');
        assert.equal(await dialog.locator('details.records-history > summary').first().evaluate(el => el === document.activeElement), true);
      });
      await check(name + ' older history collapses without hiding a live request', async () => {
        await dialog.locator('.disclosure-more').click();
        assert.equal(await dialog.locator('[data-action="openConfirmation"]').count(), 31);
        const first = dialog.locator('details.records-history').first();
        if (await first.count() && await first.getAttribute('open') === null) await first.locator('summary').click();
        await page.screenshot({ path: path.join(pictures, name + '-actual-expanded.png') });
        const collapse = dialog.locator('[data-action="collapseConfirmations"]'); assert.equal(await collapse.isVisible(), true);
        await collapse.click(); assert.equal(await dialog.locator('[data-action="openConfirmation"]').count(), 16);
        assert.equal(await dialog.locator('[data-confirmation-key="synthetic:native:pending"]').isVisible(), true);
        assert.equal(await dialog.locator('[data-action="allConfirmations"]').evaluate(el => el === document.activeElement), true);
        assert.equal(await page.evaluate(() => calls.every(action => action === 'status')), true);
      });
      await check(name + ' narrow dialog has no horizontal overflow', async () => {
        await page.setViewportSize({ width: 390, height: 740 });
        const fits = await dialog.evaluate(d => { const r = d.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && d.scrollWidth <= d.clientWidth + 1; }); assert.equal(fits, true);
      });
      await check(name + ' original-card link keeps exact identity and cannot approve', async () => {
        await page.setViewportSize({ width: 860, height: 820 });
        const details = dialog.locator('details.records-history').first(); assert.equal(await details.count(), 1);
        await details.locator('summary').click();
        const key = await details.locator('[data-action="openConfirmation"]').getAttribute('data-confirmation-key');
        const original = cards.find(card => card.key === key);
        await details.locator('[data-action="openConfirmation"]').click();
        assert.deepEqual(await page.evaluate(() => visited), [{ sessionId: original.sessionId, nativeId: original.nativeId, messageId: original.id, operationId: original.operationId, history: true }]);
        assert.equal(await page.evaluate(() => calls.every(action => action === 'status')), true);
      });
      assert.deepEqual(errors, []); await page.evaluate(() => view.dispose()); await page.close();
    }
  } finally { await browser.close(); }
  fs.writeFileSync(path.join(evidence, 'browser-result.json'), JSON.stringify({ pass: checks.length, fail: failures.length, skipped: 0, failures, metrics, serviceConnections: 0, modelCalls: 0 }, null, 2));
  if (failures.length) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
