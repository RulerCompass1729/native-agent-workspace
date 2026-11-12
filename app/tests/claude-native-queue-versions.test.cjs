const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../claude-bridge/hooks/register.js'), 'utf8');
// Exercise the actual binding body after the separate root-start prerequisite.
// This deliberately does not enable or emulate 321/322's cold-start gates.
async function binding(version, legacyOnly = false) {
  const start = source.indexOf('async function bindRoot('), end = source.indexOf('async function syncRoot(', start);
  assert.ok(start >= 0 && end > start);
  let offered;
  const scope = vm.createContext({ legacyOnly, nativeBlocks: true, addressedTool: false,
    generation: 1, stopped: false, rootBinding: null, nativeReadImages: new Map(),
    connection: async () => ({ sessionId: 'synthetic-native' }),
    request: async (_api, route, body) => { assert.equal(route, '/root-bind'); offered = body; return { lease: 'synthetic-lease', nativeBlocks: true }; },
    heartbeat() {}, observeModel() {}, observeUsage() {}, listen: async () => {},
    nativeMediaVersion: () => false,
  });
  vm.runInContext(source.slice(start, end), scope);
  await scope.bindRoot({ session: { version: async () => ({ version }) }, clock: { after() {} } }, 1);
  return JSON.parse(JSON.stringify(offered));
}
for (const version of ['2.1.318', '2.1.319', '2.1.321', '2.1.322']) test(`${version}: the separately qualified native queue is available to an established root`, async () => {
  const result = await binding(version);
  assert.equal(result.nativeQueue, true);
});
for (const version of ['2.1.320', '2.1.323', '2.1.322-beta', '2.1.322+local']) test(`${version}: an unqualified queue version stays off`, async () => {
  assert.equal((await binding(version)).nativeQueue, false);
});
test('317 and retained302 queue support is preserved; retained new versions remain off', async () => {
  assert.equal((await binding('2.1.317')).nativeQueue, true);
  assert.equal((await binding('2.1.302', true)).nativeQueue, true);
  assert.equal((await binding('2.1.322', true)).nativeQueue, false);
});
test('2.1.322 alone offers mid-turn delivery (measured); other versions and the retained mod do not', async () => {
  assert.equal((await binding('2.1.322')).nativeMidturnAppend, true);
  for (const version of ['2.1.321', '2.1.319', '2.1.317', '2.1.323', '2.1.322-beta']) assert.equal((await binding(version)).nativeMidturnAppend, false, version);
  assert.equal((await binding('2.1.322', true)).nativeMidturnAppend, false);
});
