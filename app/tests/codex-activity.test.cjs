const test = require('node:test'), assert = require('node:assert/strict');
const { Codex } = require('../adapters.cjs');
function fixture() {
  const r = new Codex({ nativeId: 'native-a', messages: [] }, { codexTargets: new Map() });
  const event = (method, params) => r.event({ method, params: { threadId: 'native-a', ...params } });
  const start = (id, startedAt) => event('turn/started', { turn: { id, startedAt } });
  return { r, event, start };
}
test('native retry retains its exact notice, stays working and never fails a newer turn',()=>{
 const {r,event,start}=fixture(),notices=[],failures=[];r.on('nativeBlock',n=>notices.push(n));r.on('failed',e=>failures.push(e));
 start('a');event('error',{turnId:'a',willRetry:true,error:{message:'Exact native stream error',additionalDetails:'Exact native detail'}});
 assert.equal(r.nativeActivity.label,'原生将重试');assert.equal(failures.length,0);assert.equal(notices[0].kind,'notice');assert.equal(notices[0].text,'Exact native stream error\n\nExact native detail');
 event('item/started',{turnId:'a',item:{id:'reply',type:'agentMessage'}});assert.equal(r.nativeActivity.label,'正在输出');
 start('b');event('error',{turnId:'a',willRetry:false,error:{message:'Old native failure'}});assert.equal(failures.length,0);assert.equal(r.turnId,'b');
 event('error',{turnId:'b',willRetry:false,error:{message:'Current native failure'}});assert.equal(failures.length,1);
 event('warning',{message:'Native warning text'});assert.equal(notices.at(-1).text,'Native warning text');
});
test('native working phases follow concurrent items and exact turn timestamps', () => {
  const { r, event, start } = fixture(); start('turn-a', 1234);
  assert.equal(r.nativeActivity.startedAt, 1234000);
  event('item/started', { turnId: 'turn-a', item: { id: 'reason', type: 'reasoning', summary: [] } });
  assert.equal(r.nativeActivity.label, '思考中');
  event('item/started', { turnId: 'turn-a', item: { id: 'cmd', type: 'commandExecution', command: 'echo local' } });
  assert.equal(r.nativeActivity.label, '执行命令');
  event('item/completed', { turnId: 'turn-a', item: { id: 'reason', type: 'reasoning', summary: [] } });
  assert.equal(r.nativeActivity.label, '执行命令', 'Another completed item cannot stop the active command');
  event('item/completed', { turnId: 'turn-a', item: { id: 'cmd', type: 'commandExecution', status: 'completed' } });
  assert.equal(r.nativeActivity.label, '正在处理');
  event('item/started', { turnId: 'older-turn', item: { id: 'old', type: 'reasoning', summary: [] } });
  assert.equal(r.nativeActivity.label, '正在处理');
  event('thread/status/changed', { status: { type: 'active', activeFlags: ['waitingOnUserInput'] } });
  assert.equal(r.nativeActivity.label, '等待回答');
  event('thread/status/changed', { status: { type: 'active', activeFlags: ['waitingOnApproval'] } });
  assert.equal(r.nativeActivity.label, '等待确认');
  event('turn/completed', { turn: { id: 'turn-a', status: 'completed' } });
  assert.equal(r.nativeActivity, null);
  start('turn-b'); assert.equal(r.nativeActivity.startedAt, null, 'Missing time is unknown, never local enqueue time');
  r.transportDisconnected = true; assert.equal(r.nativeActivity, null);
});
test('native usage retains thread and turn identity; completion never invents token rates', () => {
  const { r, event } = fixture(); let usage; r.on('usage', value => usage = value);
  event('thread/tokenUsage/updated', { turnId: 'turn-a', tokenUsage: { total: { outputTokens: 19 } } });
  assert.equal(usage.threadId, 'native-a'); assert.equal(usage.turnId, 'turn-a'); assert.equal(usage.total.outputTokens, 19);
});
test('completion carries its own native clock, never the current turn or received time', () => {
  const { r, event, start } = fixture(), blocks = []; r.on('nativeBlock', block => blocks.push(block));
  start('new-turn', 9999);
  event('turn/completed', { turn: { id: 'old-turn', status: 'completed', startedAt: 1234, completedAt: 1237, durationMs: 3456 } });
  assert.equal(r.turnId, 'new-turn'); assert.equal(r.nativeActivity.startedAt, 9999000);
  assert.deepEqual([blocks[0].turnId, blocks[0].nativeStartedAt, blocks[0].nativeCompletedAt, blocks[0].nativeDurationMs], ['old-turn', 1234000, 1237000, 3456]);
  event('turn/completed', { turn: { id: 'untimed', status: 'interrupted', completedAt: null, durationMs: -1 } });
  assert.equal(blocks[1].nativeCompletedAt, undefined); assert.equal(blocks[1].nativeDurationMs, undefined);
});
