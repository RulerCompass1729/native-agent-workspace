const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
const decision = source.slice(source.indexOf('function soloAction('), source.indexOf('function renderComposer('));
// Pure decision regression, not a real legacy connection or DOM test. Native
// error journeys separately exercise the production snapshot and actual UI.
test('failure guidance cannot hide first-time legacy connection or claim plugin reload repairs an API error', () => {
  const s = { provider: 'claude', state: 'error', owner: 'owner', chatAvailable: false, legacyInputEligible: true };
  const action = () => vm.runInNewContext(decision + ';soloAction(s)', { s, owner: 'owner', disconnected: false, nativeUsable: () => true, canResume: () => false });
  assert.equal(action().kind, 'connect');
  s.legacyInputPrepared = true;
  assert.equal(action().kind, 'terminal'); assert.match(action().hint, /原生请求未完成/);
  assert.ok(!action().hint.includes('/reload-plugins'));
  s.failedTurnInputAvailable = true;
  assert.equal(action().kind, 'send'); assert.match(action().hint, /不会自动重试/);
  s.nativeInputRequired = true; assert.equal(action().kind, 'terminal');
  s.nativeInputRequired = false; s.failedTurnInputAvailable = false;
  s.owner = 'other'; assert.equal(action().kind, 'claim');
  s.owner = 'owner'; s.state = 'idle'; assert.match(action().hint, /reload-plugins/);
});
