// T-146: joins or leaves the space being viewed for the selected session, the way a person does now.
// These were the 加入协作 / 脱出协作 header buttons, then a 加入协作 item in the session's ⋯ menu;
// today that menu has 加入此空间 or 移出当前空间. Each waits until the change has applied: the header's
// membership button (hidden in a selected session, so includeHidden) then offers the opposite. So a leave
// followed by a join cannot open a menu that is about to be withdrawn. Joining shows the join/move confirmation
// notice with 撤销加入; it is closed as a person would close it, so it covers nothing the script
// clicks next. Every name here is a lookup, so scripts/check-gui-names.cjs checks it.
async function joinSpace(page) {
  if (await page.locator('#toast-close').isVisible()) await page.locator('#toast-close').click();
  await page.locator('#session-header-more').click();
  await page.getByRole('menuitem', { name: '加入此空间', exact: true }).click();
  await page.locator('#header-actions').getByRole('button', { name: '移出当前空间', exact: true, includeHidden: true }).waitFor({ state: 'attached' });
  await page.locator('#toast-text').filter({ hasText: /^(?:已加入|已移到)「/ }).waitFor();
  await page.locator('#toast-close').click();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function leaveSpace(page) {
  await page.locator('#session-header-more').click();
  await page.getByRole('menuitem', { name: '移出当前空间', exact: true }).click();
  await page.locator('#header-actions').getByRole('button', { name: '加入此空间', exact: true, includeHidden: true }).waitFor({ state: 'attached' });
}
// Space members are reached through their content, not hidden sidebar rows.
// Panorama opens that same session in this window without creating an agent.
async function openSession(page, id) {
  const row = page.locator(`#session-list [data-session-id="${id}"]`);
  if (await row.isVisible()) await row.click();
  else {
    await page.locator('#panorama-nav').click();
    await page.locator(`[data-panorama-focus="${id}"]`).click();
  }
  await page.evaluate(async id => {
    const end = Date.now() + 10000;
    while (Date.now() < end) {
      if ((await workspace.initial()).viewState.selected === id) return;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw Error('The existing session selection did not settle');
  }, id);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
module.exports = { joinSpace, leaveSpace, openSession };
