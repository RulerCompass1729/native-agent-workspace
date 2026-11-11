'use strict';
// Real own backend bootstrap; synthetic ended sessions only, no native/model turn.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
assert.ok(path.isAbsolute(config.dataDir) && path.isAbsolute(config.home));
assert.ok(!config.dataDir.startsWith('/Applications/'));
assert.equal(Object.hasOwn(process.env, 'DEEPSEEK_API_KEY'), false);
process.env.NAW_APP_VERSION = config.version;
process.env.NAW_WORKSPACE = path.join(config.dataDir, 'workspace');
const { ensureService, connectService } = require(path.join(config.runtime, 'app/service-client.cjs'));
(async () => {
  if (config.mode === 'active-timeout' && config.version === config.newVersion) return;
  await ensureService(config.dataDir, config.node);
  const client = await connectService(config.dataDir, 'synthetic-installer');
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
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
