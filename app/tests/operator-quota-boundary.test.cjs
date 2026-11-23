const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../main.cjs'), 'utf8');
const uiError = key => Object.assign(Error(key), { key });
test('the real background registration refuses quota edits before any human confirmation or service call', async () => {
  const applicationHandlers = new Map(), calls = [], context = { background: true };
  const scope = { applicationHandlers, uiError, backgroundOperation: { request: () => ({ context, maintenanceApproved: true, valid: async () => calls.push('valid') }) },
    showDialog: async () => { calls.push('dialog'); return { response: 1 }; } };
  const start = source.indexOf('function register(name, handler) {'), end = source.indexOf('  // Sent many times', start);
  vm.runInNewContext(source.slice(start, end) + '\n}\nregister("operatorAction",()=>"forwarded")', scope);
  await assert.rejects(applicationHandlers.get('operatorAction')(context, 'holder', 'quota', { consent: true }), /personOnlyQuota/);
  assert.deepEqual(calls, ['valid']);
});
test('the actual desktop IPC handler also refuses an agent context and forwards a human edit unchanged', async () => {
  let handler; const calls = [], start = source.indexOf("  register('operatorAction',"), end = source.indexOf("  for (const name of ['prepareInput'", start);
  vm.runInNewContext(source.slice(start, end), { uiError, register: (_name, fn) => { handler = fn; } });
  const client = { call: (...args) => { calls.push(args); return 'saved'; } }, value = { consent: true, daily: 16 };
  assert.throws(() => handler({ background: true, client }, 'holder', 'quota', value), /personOnlyQuota/);
  assert.deepEqual(calls, []); assert.equal(handler({ background: false, client }, 'holder', 'quota', value), 'saved');
  assert.deepEqual(calls, [['operatorAction', 'holder', 'quota', value]]);
});
test('background snapshots do not gain human grant usage or editing metadata', () => {
  const actor = { id: 'actor', nativeId: 'native' };
  const value = { sessions: [{ ...actor, messages: [] }], operatorPolicy: { enabled: true, domains: [{ id: 'private-grant', daily: 8, quotaRevision: 2, usage: { usedToday: 3, concurrent: 2 } }] } };
  assert.deepEqual(require('../background-operation.cjs').conversationSnapshot(value, actor).operatorPolicy, { enabled: true });
});
