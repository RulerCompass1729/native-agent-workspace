// Drive the public inline-mention interaction, retaining exact recipient IDs.
const { valid, body } = require('../app/room-mention.js');
const { waitForState } = require('./fixtures/wait-state.cjs');
// The open space's own saved room view. Top-level room fields always mirror the default space (main.cjs, since c9800cc);
// another space keeps its draft and recipient in roomViews[spaceId].
// It never falls back to the default space's fields while another space is open.
const roomView = v => v.spaceId && v.spaceId !== 'shared' ? v.roomViews?.[v.spaceId] || {} : v.roomViews?.shared ?? v;
async function chooseRecipient(page, id) {
  const input = page.locator('#shared-input');
  const saved = roomView((await page.evaluate(() => workspace.initial())).viewState).roomMention;
  const raw = await input.inputValue();
  await input.fill(valid(saved, raw) ? body(saved, raw) : raw);
  await input.evaluate(el => el.setSelectionRange(0, 0));
  await input.pressSequentially('@');
  await page.locator(`[data-mention-id="${id}"]`).click();
  // Runs in the page, so it repeats roomView's rule inline.
  await waitForState(page, id => workspace.initial().then(s => (v => v.spaceId && v.spaceId !== 'shared' ? v.roomViews?.[v.spaceId] || {} : v.roomViews?.shared ?? v)(s.viewState).roomMention?.id === id), id, 'the chosen recipient to be saved');
}
async function fillRoomMessage(page, text) {
  const id = await page.locator('#recipient').inputValue();
  await page.locator('#shared-input').fill(text);
  if (id) await chooseRecipient(page, id);
  await page.locator('#shared-input').evaluate(el => el.setSelectionRange(el.value.length, el.value.length));
}
async function roomBody(page) {
  const saved = roomView((await page.evaluate(() => workspace.initial())).viewState).roomMention;
  const raw = await page.locator('#shared-input').inputValue();
  return valid(saved, raw) ? body(saved, raw) : raw;
}
module.exports = { chooseRecipient, fillRoomMessage, roomBody };
