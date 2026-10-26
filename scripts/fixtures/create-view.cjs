// The create dialog asks where a new Codex thread starts; a Claude session opens
// in the last-used tab. Create a session that starts in the given view either way.
const assert = require('node:assert/strict');
async function createIn(page, view) {
  const choice = page.locator('#initial-view');
  const provider = await page.locator('input[name="provider"]:checked').getAttribute('value');
  assert.equal(await choice.isVisible(), provider === 'codex', 'Only Codex asks where a new session starts');
  if (provider === 'codex') await choice.selectOption(view);
  await page.locator('#confirm-create').click();
  // Closing the dialog and selecting the new session happen in one renderer task.
  await page.locator('#create-dialog').waitFor({ state: 'hidden' });
  const tab = page.locator(view === 'chat' ? '#chat-tab' : '#terminal-tab');
  if (!((await tab.getAttribute('class')) || '').split(/\s+/).includes('active')) await tab.click();
}
module.exports = { createIn };
