'use strict';
// Real own backend bootstrap; synthetic ended sessions only, no native/model turn.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
assert.ok(path.isAbsolute(config.dataDir) && path.isAbsolute(config.home));
assert.ok(!config.dataDir.startsWith('/Applications/'));
assert.equal(Object.hasOwn(process.env, 'DEEPSEEK_API_KEY'), false);
process.env.NAW_APP_VERSION = config.version;
process.env.NAW_WORKSPACE = path.join(config.dataDir, 'workspace');
// A runtime copy far longer than the start waits for it. Only the new version's copier is slowed.
const slow = config.mode === 'dsh-slow' && config.version === config.newVersion;
if (slow) Object.assign(process.env, { NODE_OPTIONS: '--require ' + JSON.stringify(path.join(config.runtime, 'app/tests/helpers/dsh-copy-child.cjs')),
  NAW_TEST_DSH_CHILD: '1', NAW_TEST_DSH_SLOW_ROOT: path.join(config.dataDir, 'dsh-tui/runtime'), NAW_TEST_DSH_FILE_MS: '5000' });
const { ensureService, connectService } = require(path.join(config.runtime, 'app/service-client.cjs'));
(async () => {
  if (config.mode === 'active-timeout' && config.version === config.newVersion) return;
  await ensureService(config.dataDir, path.resolve(path.dirname(process.argv[2]), config.node));
  const { readLayout } = require(path.join(config.runtime, 'app/service-layout.cjs'));
  const active = readLayout(config.dataDir).active;
  const client = await connectService(path.join(config.dataDir, active), 'synthetic-installer');
  try {
    if (config.version === config.newVersion && config.mode === 'changed-draft') {
      await client.call('claim', 'retained', 'chat');
      await client.call('draft', 'retained', 'DRAFT_WRITTEN_BY_NEW_APP');
      await new Promise(r => setTimeout(r, 350));
      const views = JSON.parse(fs.readFileSync(path.join(config.dataDir, 'views.json')));
      views[0].draft = 'CHANGED_UI_DRAFT';
      fs.writeFileSync(path.join(config.dataDir, 'views.json'), JSON.stringify(views));
    }
    const state = await client.call('initial');
    assert.equal(state.diagnostics.dispatches, 0); assert.equal(state.diagnostics.shellModelCalls, 0);
    fs.writeFileSync(path.join(config.dataDir, 'fixture-started.json'), JSON.stringify({ version: state.runtimeVersion, pid: state.servicePid, dispatches: 0, modelCalls: 0 }), { mode: 0o600 });
  } finally { client.close(); }
  if (!slow) return;
  // This process stands for the window, which stays open and must see DSH appear without another start.
  const tui = require(path.join(config.runtime, 'app/dsh-tui.cjs')), target = path.join(config.dataDir, active), started = Date.now(), window = process.ppid;
  const atStart = tui.installed(target);
  while (!tui.installed(target) && process.ppid === window) await new Promise(r => setTimeout(r, 500));
  if (process.ppid !== window) return;
  fs.writeFileSync(path.join(config.dataDir, 'fixture-dsh.json'), JSON.stringify({ atStart, appearedMs: Date.now() - started }), { mode: 0o600 });
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
