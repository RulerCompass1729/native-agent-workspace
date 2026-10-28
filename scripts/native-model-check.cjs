// Zero-inference user journey shared by current and retained native boot tests.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
module.exports = async function modelCheck({ page, snapshot, base, reopen, aliases = ['sonnet', 'haiku', 'sonnet'] }) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function until(fn, label) { const start = Date.now(); while (Date.now() - start < 20000) { if (await fn()) return; await sleep(75); } throw Error(label); }
  const before = (await snapshot()).sessions[0];
  await page.locator('#chat-tab').click();
  await page.locator('#message-input').fill('Unsent model-switch draft');
  await page.locator('#terminal-tab').click();
  for (const alias of aliases) {
    await page.locator('#terminal-area .xterm-screen').click();
    await page.keyboard.type('/model ' + alias); await sleep(500);
    const edit = await page.locator('#terminal-area').innerText();
    fs.writeFileSync(path.join(base, alias + '-before-enter.txt'), edit);
    assert.equal(edit.split('\n').filter(line => line.startsWith('❯')).at(-1)?.slice(1).trim(), '/model ' + alias);
    assert.ok(!edit.includes('hooks module did not load'));
    await page.keyboard.press('Enter');
    await until(async () => (await page.locator('#terminal-area').innerText()).includes('Set model to ' + (alias === 'sonnet' ? 'Sonnet' : 'Haiku')), 'Native command completed');
    await until(async () => (await snapshot()).sessions[0].model.includes(alias), 'Native model propagated');
    const after = (await snapshot()).sessions[0];
    assert.equal(after.nativeId, before.nativeId); assert.equal(after.pid, before.pid); assert.equal(after.state, 'idle');
    assert.equal(after.messages.filter(m => m.role === 'user' || m.role === 'assistant').length,
      before.messages.filter(m => m.role === 'user' || m.role === 'assistant').length);
    fs.writeFileSync(path.join(base, alias + '-terminal.txt'), await page.locator('#terminal-area').innerText());
    fs.writeFileSync(path.join(base, alias + '-snapshot.json'), JSON.stringify(after, null, 2));
    await page.locator('#chat-tab').click();
    await until(async () => (await page.locator('#subtitle').innerText()).includes(after.model), 'Actual visible header matches native selection');
    assert.equal(await page.locator('#message-input').inputValue(), 'Unsent model-switch draft');
    await page.locator('#terminal-tab').click();
  }
  if (reopen) page = await reopen(); else await page.reload();
  await page.locator('#new-session').waitFor();
  await page.locator(`[data-session-id="${before.id}"]`).click(); await page.locator('#chat-tab').click();
  await until(async () => (await page.locator('#subtitle').innerText()).includes(aliases.at(-1)), 'Reopen retains actual native model');
  assert.equal(await page.locator('#message-input').inputValue(), 'Unsent model-switch draft');
  const final = (await snapshot()).sessions[0];
  assert.equal(final.nativeId, before.nativeId); assert.equal(final.pid, before.pid);
  fs.writeFileSync(path.join(base, 'model-final.json'), JSON.stringify(final, null, 2));
  fs.writeFileSync(path.join(base, 'model-ui.txt'), await page.locator('body').innerText());
  if (process.env.NAW_EVIDENCE_DIR) {
    fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'model-synced.png') });
  }
};
