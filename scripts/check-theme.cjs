// Exercise the rendered DSH palette, including native system appearance changes.
// This checks readable output rather than asserting particular implementation colors.
const assert = require('node:assert/strict');

async function checkTheme(page) {
  const results = [];
  try {
    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForFunction(dark => document.body.hasAttribute('data-ds-dark-theme') === dark, scheme === 'dark');
      const samples = await page.evaluate(() => {
        const selectors = ['.brand', '#new-session', '#setup-button', '#room-nav', '#subtitle', '#start-claude', '#start-codex', '#setup-dialog h2', '#setup-status p', '#close-setup', '#create-dialog h2', '#session-name', '#cancel-create', '#run-status', '#room-scope', '#room-record', '#manage-members', '#members-dialog h2', '#shared-input', '#forward-button'];
        const rgba = text => {
          const parts = text.match(/[\d.]+/g).map(Number);
          return [parts[0], parts[1], parts[2], parts[3] ?? 1];
        };
        const over = (fg, bg) => fg.slice(0, 3).map((channel, i) => channel * fg[3] + bg[i] * (1 - fg[3])).concat(1);
        const luminance = rgb => rgb.slice(0, 3).map(v => v / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
        return selectors.flatMap(selector => {
          const el = document.querySelector(selector);
          if (!el || !el.checkVisibility() || el.disabled) return [];
          const chain = []; for (let node = el; node; node = node.parentElement) chain.unshift(node);
          let background = [255, 255, 255, 1];
          for (const node of chain) background = over(rgba(getComputedStyle(node).backgroundColor), background);
          const foreground = over(rgba(getComputedStyle(el).color), background);
          const levels = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
          return [{ selector, ratio: (levels[0] + 0.05) / (levels[1] + 0.05) }];
        });
      });
      assert.ok(samples.length >= 5, 'Theme check requires the actual workspace surface');
      for (const sample of samples) assert.ok(sample.ratio >= 4.5, `${scheme} ${sample.selector}: contrast ${sample.ratio.toFixed(2)} is below 4.5`);
      results.push({ scheme, checked: samples.length, minimumContrast: Math.min(...samples.map(s => s.ratio)) });
    }
    return results;
  } finally {
    // Playwright's light default previously masked real dark-mode startup bugs.
    await page.emulateMedia({ colorScheme: null });
  }
}
module.exports = { checkTheme };
