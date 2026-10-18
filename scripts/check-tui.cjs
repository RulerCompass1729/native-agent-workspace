// Visible UI checks. No model prompts or native input; native typing is a
// separate, deliberately bounded check against an inspected idle terminal.
const assert = require('node:assert/strict');
const sharedDraft = '协作草稿：保留到重开，不发送。';

async function checkTui(page) {
  const initial = await page.evaluate(() => workspace.initial());
  await page.locator('#privacy-button').click();
  await page.locator('#privacy-dialog').waitFor({ state: 'visible' });
  const trust = await page.locator('#trust-status').innerText();
  assert.match(trust, /原生终端直接输入/);
  assert.match(trust, /不是账单/);
  if (initial.sessions.some(s => !s.usage?.total)) assert.match(trust, /未报告；不能据此判断为零/);
  assert.ok(trust.includes(`应用 ${initial.appVersion}`));
  await page.locator('#close-privacy').click();

  await page.locator('#room-nav').click();
  await page.locator('#room-record').click();
  await page.locator('#shared-input').fill(sharedDraft);
  await page.waitForFunction(async value => (await workspace.initial()).viewState.sharedDraft === value, sharedDraft);
  const controlled = initial.sessions.find(s => s.id === initial.viewState.selected && s.owner === initial.owner && s.state === 'idle' && s.terminalAvailable);
  if (controlled) {
    const select = () => page.locator(`[data-session-id="${controlled.id}"]`).click();
    await select();
    await page.locator('#terminal-tab').click();
    await page.locator('#terminal-display').click();
    await page.locator('#terminal-font-size').fill('17');
    await page.locator('#terminal-palette').selectOption('green');
    await page.locator('#close-terminal-display').click();
    await page.waitForFunction(async () => {
      const v = (await workspace.initial()).viewState;
      return v.terminalDisplay?.fontSize === 17 && v.terminalDisplay.palette === 'green';
    });
    await page.locator('#room-nav').click(); await select();
    await page.waitForFunction(id => document.activeElement?.classList.contains('xterm-helper-textarea') && document.activeElement.closest('[data-terminal-id]')?.dataset.terminalId === id, controlled.id);
    assert.equal(await page.locator('#terminal-paste').isEnabled(), true);
  }
  const after = await page.evaluate(() => workspace.initial());
  assert.equal(after.diagnostics.dispatches, initial.diagnostics.dispatches);
  assert.deepEqual(after.sessions.map(s => [s.id, s.nativeId, s.pid, s.messages.length]), initial.sessions.map(s => [s.id, s.nativeId, s.pid, s.messages.length]));
  // Exercise the IPC boundary, not a duplicate validation implementation.
  for (const patch of [{ roomSession: 42 }, { roomSession: 'x'.repeat(101) }, { sharedDraft: 'x'.repeat(16001) }, { terminalDisplay: { fontSize: 0, palette: 'dark' } }]) {
    assert.equal(await page.evaluate(async patch => { const s = await workspace.initial(); try { await workspace.viewState({ ...s.viewState, ...patch }); return false; } catch { return true; } }, patch), true);
  }
  return { original: initial.viewState, controlled: controlled?.id, saved: after.viewState };
}

async function verifyTui(page, result) {
  const snapshot = await page.evaluate(() => workspace.initial());
  assert.equal(snapshot.viewState.sharedDraft, sharedDraft);
  assert.equal(await page.locator('#shared-input').inputValue(), sharedDraft);
  if (result.controlled) {
    assert.deepEqual(snapshot.viewState.terminalDisplay, { fontSize: 17, palette: 'green' });
    await page.locator('#terminal-display').click();
    assert.equal(await page.locator('#terminal-font-size').inputValue(), '17');
    assert.equal(await page.locator('#terminal-palette').inputValue(), 'green');
    await page.locator('#close-terminal-display').click();
  }
}

async function restoreTui(page, result) {
  if (!result) return;
  const { original } = result;
  await page.evaluate(async original => {
    const snapshot = await workspace.initial();
    const current = snapshot.viewState;
    if (snapshot.sessions.some(s => s.id === original.selected && s.owner === snapshot.owner)) await workspace.claim(original.selected, original.mode);
    await workspace.viewState({ ...current, selected: original.selected, mode: original.mode, preference: original.preference, roomSession: original.roomSession || '', sharedDraft: original.sharedDraft || '', terminalDisplay: original.terminalDisplay || { fontSize: 14, palette: 'dark' } });
  }, original);
}
module.exports = { checkTui, verifyTui, restoreTui };
