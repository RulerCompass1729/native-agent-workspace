const test = require('node:test'), assert = require('node:assert/strict');
const { nativeApprovalPolicy } = require('../approval-policy.js');
test('native question content is preserved without creating permission decisions',()=>{
 const questions=[{id:'approach',header:'Approach',question:'Which route?',isOther:true,options:[{label:'Existing native UI',description:'Reuse the existing surface'}]}];
 const p=nativeApprovalPolicy({method:'item/tool/requestUserInput',params:{questions,isBlocking:true}});
 assert.deepEqual(p.questions,questions);assert.deepEqual(p.decisions,[]);
 assert.equal(nativeApprovalPolicy({method:'item/tool/requestUserInput',params:{questions:[...questions,...questions]}}).questions,null);
});
const command = params => ({ method: 'item/commandExecution/requestApproval', params: { command: 'first line\nsecond line', cwd: '/synthetic/work', reason: 'Requested scope reason', ...params } });
test('ordinary command displays all material text and only one-time decision options', () => {
  for (const params of [{}, { kind: 'command', environmentId: null }, { kind: 'command', environmentId: 'local' }]) {
    const p = nativeApprovalPolicy(command(params));
    assert.deepEqual(p.decisions, ['accept', 'decline']);
    assert.equal(p.command, 'first line\nsecond line'); assert.equal(p.cwd, '/synthetic/work'); assert.equal(p.reason, 'Requested scope reason');
    assert.equal(p.nativeRequired, false);
  }
});
test('local approval and cancellation preserve the native list and retained-backend boundary', () => {
  const request = command({ kind: 'command', environmentId: 'local', availableDecisions: ['accept', { acceptWithExecpolicyAmendment: {} }, 'cancel'] });
  assert.deepEqual(nativeApprovalPolicy(request).decisions, ['accept', 'cancel']);
  assert.deepEqual(nativeApprovalPolicy(request, { localDecisions: false }).decisions, []);
  assert.deepEqual(nativeApprovalPolicy(command(), { localDecisions: false }).decisions, ['accept', 'decline']);
  assert.deepEqual(nativeApprovalPolicy(command({ environmentId: 'remote', availableDecisions: ['accept', 'cancel'] })).decisions, ['cancel']);
  assert.deepEqual(nativeApprovalPolicy({ method: 'item/fileChange/requestApproval', params: { availableDecisions: ['accept', 'cancel'] } }).decisions, ['cancel']);
});
test('native available decisions are literal and an explicit malformed/empty field fails closed', () => {
  for (const availableDecisions of [null, [], false, 'accept', ['acceptForSession'], [{ acceptWithExecpolicyAmendment: {} }]]) {
    assert.deepEqual(nativeApprovalPolicy(command({ availableDecisions })).decisions, []);
  }
  assert.deepEqual(nativeApprovalPolicy(command({ availableDecisions: ['decline', 'acceptForSession'] })).decisions, ['decline']);
  assert.deepEqual(nativeApprovalPolicy(command({ availableDecisions: ['accept'] })).decisions, ['accept']);
});
test('special or incomplete scope never offers GUI acceptance, while a supported refusal remains possible', () => {
  for (const params of [{ kind: 'writeStdin' }, { kind: null }, { kind: 'future' }, { environmentId: 'remote' }, { additionalPermissions: {} },
    { networkApprovalContext: { host: 'synthetic.example' } }, { command: null }, { command: ' ' }, { cwd: null }, { cwd: '' }]) {
    const p = nativeApprovalPolicy(command(params));
    assert.deepEqual(p.decisions, ['decline']); assert.equal(p.nativeRequired, true); assert.ok(p.notice);
  }
  const file = nativeApprovalPolicy({ method: 'item/fileChange/requestApproval', params: { grantRoot: '/synthetic' } });
  assert.deepEqual(file.decisions, ['decline']); assert.equal(file.nativeRequired, true);
  assert.deepEqual(nativeApprovalPolicy({ method: 'item/permissions/requestApproval', params: {} }).decisions, []);
});
