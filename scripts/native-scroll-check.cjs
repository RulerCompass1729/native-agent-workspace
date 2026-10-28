// Shared, explicitly requested installed-native witness. It must reveal actual
// old CLI content, not merely receive an input packet or scroll the GUI reader.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const start = provider => `NATIVE_SCROLL_START_${provider}`;
const end = provider => `NATIVE_SCROLL_END_${provider}`;
const reply = provider => [start(provider), ...Array.from({ length: 80 }, (_, i) => `${provider} original line ${String(i).padStart(3, '0')}`), end(provider)].join('\n');
async function check({ page, snapshot, base, provider, localCalls }) {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const before = (await snapshot()).sessions.find(s => s.provider === provider), id = before.id;
  const rows = page.locator(`[data-terminal-id="${id}"] .xterm-rows`), text = () => rows.innerText();
  const identity = s => [s.id, s.nativeId, s.pid, s.owner];
  const draft = `${provider} unsent scroll-check draft`;
  await page.locator('#chat-tab').click(); await page.locator('#message-input').fill(draft);
  const deadline = Date.now() + 30000;
  while (!(await text()).includes(end(provider)) && Date.now() < deadline) { assert.equal(localCalls(), 1, 'One task response only'); await sleep(100); }
  assert.ok((await text()).includes(end(provider)), 'Real CLI renders the final fixture lines before scrolling');
  assert.ok(!(await text()).includes(start(provider)), 'Earlier content starts outside the native viewport');
  const samples = [{ phase: 'before', text: await text() }];
  async function scroll(delta, marker) {
    for (let i = 0; i < 100 && !(await text()).includes(marker); i++) {
      assert.equal(localCalls(), 1, 'Scrolling must not start another task');
      const rect = await rows.boundingBox(); assert.ok(rect);
      await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
      await page.mouse.wheel(0, delta); await sleep(80);
      samples.push({ phase: delta < 0 ? 'up' : 'down', step: i, text: await text() });
    }
    fs.writeFileSync(path.join(base, 'native-scroll-views.json'), JSON.stringify(samples, null, 2));
    assert.ok((await text()).includes(marker), 'Actual native viewport must reveal ' + marker);
    if (process.env.NAW_EVIDENCE_DIR) await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, `native-scroll-${provider}-${delta < 0 ? 'earlier' : 'latest'}.png`) });
  }
  await scroll(-480, start(provider)); await scroll(480, end(provider));
  const after = (await snapshot()).sessions.find(s => s.id === id);
  assert.deepEqual(identity(after), identity(before)); assert.equal(after.liveDraft, draft); assert.equal(localCalls(), 1);
  fs.writeFileSync(path.join(base, 'native-scroll-state.json'), JSON.stringify({ before, after, localTaskResponses: localCalls(), physicalTrackpad: 'not tested', iTermComparison: 'not tested' }, null, 2));
  return `${provider}: actual original CLI viewport reveals earlier and latest response content by wheel, with identity/owner/draft retained and no additional task`;
}
module.exports = { reply, check };
