// The task board holds what waits for the person (R250, 11-25): one row per item; a card or question opens in place in its row.
module.exports = page => {
  const panel = page.locator('#task-board-panel'), toggle = page.locator('.task-board-toggle');
  const settled = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  // Ids can hold quotes (operator creations embed JSON), so the attribute value is a quoted CSS string.
  const row = id => panel.locator(`.task-board-task:has(.task-board-entry[data-item-id=${JSON.stringify(id)}])`);
  const waiting = () => panel.locator('.task-board-group[data-group-key="waiting"] .task-board-entry');
  async function open() {
    if (!await panel.isVisible()) await toggle.click();
    await panel.waitFor(); await settled();
  }
  async function close() {
    if (await panel.isVisible()) await toggle.click();
    await panel.waitFor({ state: 'hidden' });
  }
  async function expand(id) {
    await open();
    const r = row(id), entry = r.locator('.task-board-entry');
    await entry.waitFor();
    if (await entry.getAttribute('aria-expanded') !== 'true') await entry.click();
    await r.locator('.task-board-detail').waitFor(); await settled();
    return r;
  }
  // The first row of one kind, for ids that embed native ids the caller does not hold.
  async function expandKind(kind) {
    await open();
    const entry = panel.locator(`.task-board-entry[data-kind="${kind}"]`).first();
    await entry.waitFor();
    return expand(await entry.getAttribute('data-item-id'));
  }
  const need = () => toggle.locator('.task-status-need');
  return { panel, toggle, row, waiting, open, close, expand, expandKind, need, settled };
};
