// T-146: joins or leaves the space being viewed for the selected session, the way a person does now.
// These were the 加入协作 / 脱出协作 header buttons, then a 加入协作 item in the session's ⋯ menu;
// today that menu has 加入此空间 or 离开此空间. Each waits until the change has applied: the header's
// membership button (hidden in a selected session, so includeHidden) then offers the opposite. So a leave
// followed by a join cannot open a menu that is about to be withdrawn. Joining shows an 已加入「…」
// notice with 撤销加入; it is closed as a person would close it, so it covers nothing the script
// clicks next. Every name here is a lookup, so scripts/check-gui-names.cjs checks it.
async function joinSpace(page) {
  await page.locator('#session-header-more').click();
  await page.getByRole('menuitem', { name: '加入此空间', exact: true }).click();
  await page.locator('#header-actions').getByRole('button', { name: '离开此空间', exact: true, includeHidden: true }).waitFor({ state: 'attached' });
  await page.locator('#toast-text', { hasText: '已加入' }).waitFor();
  await page.locator('#toast-close').click();
}
async function leaveSpace(page) {
  await page.locator('#session-header-more').click();
  await page.getByRole('menuitem', { name: '离开此空间', exact: true }).click();
  await page.locator('#header-actions').getByRole('button', { name: '加入此空间', exact: true, includeHidden: true }).waitFor({ state: 'attached' });
}
module.exports = { joinSpace, leaveSpace };
