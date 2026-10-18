// Exercise the real desktop and existing idle native sessions. No prompt/input.
const assert = require('node:assert/strict');
const snapshot = page => page.evaluate(() => workspace.initial());
const identity = s => s.sessions.map(x => [x.id, x.nativeId, x.pid, x.messages.length]);
const focus = (page, id) => page.waitForFunction(id => document.activeElement?.classList.contains('xterm-helper-textarea') && document.activeElement.closest('[data-terminal-id]')?.dataset.terminalId === id, id);
const tab = (page, id) => page.locator(`[data-room-session="${id}"]`);

async function checkRoom(page, application, result) {
  const before = await snapshot(page);
  // Never alter an active task or a room already used by the person.
  const people = before.sessions.filter(s => s.owner === before.owner && s.state === 'idle' && s.terminalAvailable && !s.roomId && !s.liveDraft && !s.messages.length);
  if (before.room.run || before.room.messages.length || before.sessions.some(s => s.roomId) || people.length !== 2) {
    result.skipped = true;
    console.log('SKIP: room workflow needs exactly two controlled, empty idle terminals and an unused room.');
    return;
  }
  result.people = people;
  result.before = before;
  result.changed = true; // Cleanup must also run if the next assertion fails.
  for (const person of people) {
    await page.locator(`[data-session-id="${person.id}"]`).click();
    await page.locator('#header-actions').getByRole('button', { name: '加入协作', exact: true }).click();
    await page.waitForFunction(async id => (await workspace.initial()).sessions.find(s => s.id === id).roomId === 'shared', person.id);
  }
  await page.locator('#room-nav').click();
  const joined = await snapshot(page);
  for (const person of people) {
    await tab(page, person.id).click(); await focus(page, person.id);
    assert.equal(await page.locator('#room-session #terminal-area').isVisible(), true);
    assert.equal(await page.locator('#pause-button').isVisible(), true);
    assert.equal(await page.locator('#terminal-paste').isEnabled(), true);
    assert.equal(await tab(page, person.id).getAttribute('aria-pressed'), 'true');
    assert.match(await page.locator('#room-scope').innerText(), /查看不会新增共享/);
    // The terminal element survives a shared-record visit, including selection.
    const handle = await page.locator(`[data-terminal-id="${person.id}"]`).elementHandle();
    await page.locator('#room-record').focus(); await page.keyboard.press('Enter');
    assert.equal(await page.locator('#room-record-view').isVisible(), true);
    await tab(page, person.id).click(); await focus(page, person.id);
    assert.equal(await handle.evaluate(el => el.isConnected && el === document.querySelector(`[data-terminal-id="${el.dataset.terminalId}"]`)), true);
    await handle.dispose();
  }
  const viewed = await snapshot(page);
  assert.equal(viewed.room.revision, joined.room.revision);
  assert.deepEqual(viewed.sessions.map(s => [s.id, s.controlRevision]), joined.sessions.map(s => [s.id, s.controlRevision]));

  // Intentional second view: viewing is read-only until explicit takeover.
  const person = people.at(-1);
  const windowEvent = application.waitForEvent('window');
  await page.locator(`[data-session-menu="${person.id}"]`).click();
  await page.getByRole('menuitem', { name: '在独立窗口打开', exact: true }).click();
  const second = await windowEvent;
  try {
    await second.locator('#take-control').waitFor({ state: 'visible' });
    assert.equal(await second.locator('#terminal-paste').isDisabled(), true);
    assert.equal((await snapshot(second)).sessions.find(s => s.id === person.id).owner, before.owner);
    await second.locator('#take-control').click();
    await page.locator('#take-control').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#terminal-paste').isDisabled(), true);
    await page.locator('#take-control').click(); await focus(page, person.id);
    await second.locator('#take-control').waitFor({ state: 'visible' });
  } finally { await second.close(); }
  assert.equal(application.windows().length, 1);

  await page.locator('#header-actions').getByRole('button', { name: '脱出协作', exact: true }).click();
  await page.locator('#solo-session #terminal-area').waitFor({ state: 'visible' });
  await focus(page, person.id);
  const detached = await snapshot(page);
  assert.equal(detached.sessions.find(s => s.id === person.id).roomId, null);
  assert.equal(detached.viewState.selected, person.id);
  assert.deepEqual(identity(detached), identity(before));
  await page.locator('#header-actions').getByRole('button', { name: '加入协作', exact: true }).click();
  await page.waitForFunction(async id => (await workspace.initial()).sessions.find(s => s.id === id).roomId === 'shared', person.id);
  await page.locator('#room-nav').click();
  assert.equal(await page.locator('#room-view').isVisible(), true, 'Room navigation must open the room after rejoin');
  await tab(page, person.id).click(); await focus(page, person.id);
  await page.waitForFunction(async id => { const v = (await workspace.initial()).viewState; return v.selected === 'room' && v.roomSession === id; }, person.id);
  const after = await snapshot(page);
  assert.equal(after.diagnostics.dispatches, before.diagnostics.dispatches);
  assert.deepEqual(after.room.messages, before.room.messages);
  assert.deepEqual(identity(after), identity(before));
  const nativeWindow = await application.browserWindow(page);
  const bounds = await nativeWindow.evaluate(win => win.getBounds());
  try {
    await nativeWindow.evaluate(win => win.setSize(850, 600));
    await page.waitForFunction(() => document.querySelector('#terminal-area').getBoundingClientRect().width > 0 && document.querySelector('#terminal-area').getBoundingClientRect().height > 150);
    await page.waitForFunction(() => document.querySelector('#new-session').getBoundingClientRect().height < 60);
    const overflow = await page.evaluate(() => ['#new-session', '#room-nav', '#setup-button', '#privacy-button', '#pause-button', '#manage-members', '#terminal-paste'].some(selector => { const r = document.querySelector(selector).getBoundingClientRect(); return r.right > innerWidth || r.bottom > innerHeight; }));
    assert.equal(overflow, false, 'Core room controls must fit the minimum window');
    await require('./check-theme.cjs').checkTheme(page);
    if (process.env.NAW_EVIDENCE_DIR) {
      const fs = require('node:fs'), path = require('node:path');
      fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true, mode: 0o700 });
      await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'room-terminal-small.png') });
      await page.locator('#room-record').click();
      await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'room-record-small.png') });
      await tab(page, person.id).click(); await focus(page, person.id);
    }
  } finally { await nativeWindow.evaluate((win, value) => win.setBounds(value), bounds); }
  result.selected = person.id;
  console.log('PASS: both native room terminals, shared record, explicit takeover, detach and same-session return; no new dispatch or history.');
}
async function verifyRoom(page, result) {
  if (!result?.selected) return;
  const state = await snapshot(page);
  assert.equal(state.viewState.selected, 'room');
  assert.equal(state.viewState.roomSession, result.selected);
  await focus(page, result.selected);
  assert.equal(await page.locator('#room-session #terminal-area').isVisible(), true);
  assert.deepEqual(identity(state), identity(result.before));
  assert.equal(state.diagnostics.dispatches, result.before.diagnostics.dispatches);
}
async function restoreRoom(page, result) {
  if (!result?.changed) return;
  await page.evaluate(async ({ people }) => {
    for (const person of people) { await workspace.join(person.id, false); await workspace.claim(person.id, person.view); }
  }, result);
}
module.exports = { checkRoom, verifyRoom, restoreRoom };
