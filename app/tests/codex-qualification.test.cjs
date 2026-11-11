// B3: one Codex gate per capability. No model, no provider process.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const q = require('../codex-qualification.cjs');
const { verifiedCodexProtocol, codexVersionInfo } = require('../native-history.cjs');

// The inline gates as they were before the split (main ae17fa9), written out literally.
const before = {
  history: v => ['0.163.0', '0.164.0', '0.165.0', '0.167.0'].includes(v),
  steer: v => ['0.163.0', '0.164.0', '0.165.0', '0.167.0'].includes(v),
  terminalBridge: v => ['0.163.0', '0.164.0', '0.165.0', '0.167.0'].includes(v) || ['0.166.0', '0.167.0'].includes(v),
  spaceImages: v => ['0.166.0', '0.167.0'].includes(v),
  addressedTool: v => ['0.164.0', '0.165.0', '0.166.0', '0.167.0'].includes(v),
  capacity: v => ['0.164.0', '0.165.0', '0.166.0', '0.167.0'].includes(v),
};
const versions = ['0.160.0', '0.162.0', '0.163.0', '0.164.0', '0.165.0', '0.166.0', '0.167.0', '0.168.0', '1.0.0',
  '0.167.0-alpha.1', '0.167.0+build', ' 0.167.0', '0.167', '', null, undefined, 167];

test('every per-capability gate decides exactly as the inline gate it replaced', () => {
  q.setAutomatic({});
  assert.deepEqual([...q.CAPABILITIES].sort(), Object.keys(before).sort());
  for (const capability of q.CAPABILITIES) for (const version of versions) {
    assert.equal(q.allows(capability, version), before[capability](version), `${capability} @ ${JSON.stringify(version)}`);
  }
  for (const version of versions) {
    assert.equal(verifiedCodexProtocol({ nativeVersion: version }), before.history(version));
    const status = codexVersionInfo({ nativeVersion: version, ws: { readyState: 1 } }).nativeVersionStatus;
    if (typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version)) assert.equal(status, before.history(version) ? 'verified' : 'unverified');
  }
  assert.throws(() => q.allows('unknownCapability', '0.167.0'), /Unknown Codex capability/);
});

test('an automatic decision opens only the capabilities it names, for only its version', () => {
  q.setAutomatic({ '0.168.0': { capabilities: { history: true, steer: false } } });
  try {
    assert.equal(q.allows('history', '0.168.0'), true);
    assert.equal(q.allows('steer', '0.168.0'), false);
    for (const capability of ['terminalBridge', 'spaceImages', 'addressedTool', 'capacity']) assert.equal(q.allows(capability, '0.168.0'), false);
    assert.equal(q.allows('history', '0.169.0'), false);
    assert.equal(q.allows('history', '0.168.0-rc.1'), false);
  } finally { q.setAutomatic({}); }
});

test('single-version quirk gates stay literal and never consult automatic qualification', () => {
  const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  assert.match(read('adapters.cjs'), /error\.nativeUnsupportedTurns \|\| rpc\?\.nativeVersion !== '0\.163\.0'/);
  assert.match(read('legacy-codex.cjs'), /sharedReplyAvailable\(\) \{ return this\.connected && !this\.closed && this\.rpc\?\.nativeVersion === '0\.163\.0'; \}/);
  assert.match(read('scoped-outbox-runtime.cjs'), /runtime\.host\?\.rpc\?\.nativeVersion === '0\.167\.0' && scope\.rpc\?\.nativeClientVersion === '0\.167\.0'/);
  for (const file of ['legacy-codex.cjs', 'scoped-outbox-runtime.cjs']) assert.doesNotMatch(read(file), /codex-qualification/);
});
