// Drive the public inline-mention interaction, retaining exact recipient IDs.
const { valid, body } = require('../app/room-mention.js');
async function chooseRecipient(page, id) {
  const input = page.locator('#shared-input');
  const saved = (await page.evaluate(() => workspace.initial())).viewState.roomMention;
  const raw = await input.inputValue();
  await input.fill(valid(saved, raw) ? body(saved, raw) : raw);
  await input.evaluate(el => el.setSelectionRange(0, 0));
  await input.pressSequentially('@');
  await page.locator(`[data-mention-id="${id}"]`).click();
  await page.waitForFunction(id => workspace.initial().then(s => s.viewState.roomMention?.id === id), id);
}
async function fillRoomMessage(page, text) {
  const id = await page.locator('#recipient').inputValue();
  await page.locator('#shared-input').fill(text);
  if (id) await chooseRecipient(page, id);
  await page.locator('#shared-input').evaluate(el => el.setSelectionRange(el.value.length, el.value.length));
}
async function roomBody(page) {
  const saved = (await page.evaluate(() => workspace.initial())).viewState.roomMention;
  const raw = await page.locator('#shared-input').inputValue();
  return valid(saved, raw) ? body(saved, raw) : raw;
}
module.exports = { chooseRecipient, fillRoomMessage, roomBody };
