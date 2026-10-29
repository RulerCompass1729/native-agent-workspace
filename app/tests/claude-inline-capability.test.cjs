const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), { randomUUID } = require('node:crypto');

async function bind(legacy, reply = {}) {
  // Select the same legacy-only mode as the existing observation tests, then
  // exercise the real binding function, native handshake and poll exit.
  const original = fs.readFileSync(path.join(__dirname, '../claude-bridge/hooks/register.js'), 'utf8');
  assert.ok(original.includes('const legacyOnly = false;'));
  const source = original.replace('const legacyOnly = false;', `const legacyOnly = ${legacy};`) +
    '\nnativeBlocks = true; export { bindRoot as testBindRoot }; export const testBinding = () => rootBinding;\n//' + randomUUID();
  const mod = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  const calls = [], session = '11111111-1111-4111-8111-111111111111';
  const api = {
    session: { id: async () => session, version: async () => ({ version: '2.1.310' }) },
    env: { get: async key => ({ NAW_SUBMIT_SOCKET: '/fixture/socket', NAW_HOOK_TOKEN: 'fixture-token' })[key] },
    clock: { after: () => ({ cancel() {} }) }, tool: { list: async () => [] },
    http: { fetch: async url => {
      const route = new URL(url).pathname; calls.push(route);
      assert.ok(['/root-bind', '/next'].includes(route), 'Binding never submits a model task');
      return { ok: true, text: JSON.stringify(route === '/root-bind'
        ? { lease: 'fixture-lease', observationEpoch: 'fixture-epoch', nativeBlocks: true, ...reply }
        : { closed: true }) };
    } },
  };
  await mod.testBindRoot(api, 0);
  assert.deepEqual(calls, ['/root-bind', '/next']);
  return mod.testBinding();
}

for (const legacy of [false, true]) {
  const name = legacy ? 'retained compatibility' : 'managed';
  test(`${name} receiver without inline capability cannot enable a new input class`, async () => {
    assert.equal((await bind(legacy)).nativeInlineInput, false);
  });
  test(`${name} receiver explicitly declining inline input remains disabled`, async () => {
    assert.equal((await bind(legacy, { nativeInlineInput: false })).nativeInlineInput, false);
  });
  test(`${name} receiver explicitly accepting inline input enables it`, async () => {
    assert.equal((await bind(legacy, { nativeInlineInput: true })).nativeInlineInput, true);
  });
  test(`${name} receiver without native blocks cannot enable inline input`, async () => {
    assert.equal((await bind(legacy, { nativeBlocks: false, nativeInlineInput: true })).nativeInlineInput, false);
  });
}
