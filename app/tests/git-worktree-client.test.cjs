const test=require('node:test'), assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {WorkspaceClient}=require('../workspace-client.cjs');
const supported=['resume','structuredClaudeSubmit','verifiedHandoffs','nativePermissionDefaults','nativeInputIsolation','claudePromptIdentity'];
function fixture(t) {
  function entry(key,caps) {
    const state={owner:'test-view',runtimeVersion:'development',capabilities:[...supported,...caps],sessions:[],diagnostics:{dispatches:0,shellModelCalls:0},room:{revision:0,messages:[],run:null}};
    const client=new EventEmitter(), calls=[];
    client.call=async(method,...args)=>{calls.push([method,...args]); if(method==='initial')return structuredClone(state); if(method==='create')return 'synthetic-created'; if(method==='gitWorktreePreview')return {source:args[0],nonce:args[1]}; return true;};
    client.close=()=>client.emit('closed'); return {key,client,state:structuredClone(state),real:state,calls};
  }
  const old=entry('old',['gitWorktreeV1']), next=entry('next',[]), c=new WorkspaceClient([old,next],'next',Symbol()); t.after(()=>c.close());
  return {old,next,c,entry};
}
test('retained capability never licenses a new active backend to ignore a copy request',async t=>{
  const {old,next,c}=fixture(t), payload={provider:'codex',cwd:'/synthetic/repo',gitWorktree:{source:'/synthetic/repo'}};
  await assert.rejects(c.call('gitWorktreePreview','/synthetic/repo','nonce',''),/不支持 Git/);
  await assert.rejects(c.call('create',payload),/未使用原目录启动/);
  assert.equal([...old.calls,...next.calls].some(([method])=>method!=='initial'),false);
});
test('supported preview and create retain exact plan and do not pause, claim, send or wake',async t=>{
  const {old,next,c}=fixture(t); next.real.capabilities.push('gitWorktreeV1');
  const epoch=c.control.manualEpoch, plan=await c.call('gitWorktreePreview','/synthetic/repo','nonce','src');
  await c.call('create',{provider:'codex',cwd:'/synthetic/repo',gitWorktree:plan});
  assert.deepEqual(next.calls.filter(([method])=>method!=='initial').map(([method])=>method),['gitWorktreePreview','create']);
  assert.equal(old.calls.some(([method])=>method!=='initial'),false);
  assert.deepEqual(next.calls.find(([method])=>method==='create')[1].gitWorktree,plan);
  assert.equal(c.control.manualEpoch,epoch);
});
test('preview response after replacement is rejected without replay on the new service',async t=>{
  const {next,c,entry}=fixture(t); next.real.capabilities.push('gitWorktreeV1');
  let release; const call=next.client.call;
  next.client.call=async(method,...args)=>method==='gitWorktreePreview'?new Promise(r=>{release=r;}):call(method,...args);
  const pending=c.call('gitWorktreePreview','/synthetic/repo','nonce','');
  await new Promise(setImmediate); assert.equal(typeof release,'function');
  const replacement=entry('next',['gitWorktreeV1']); c.replaceService('next',replacement.client,replacement.state); release({source:'/synthetic/repo'});
  await assert.rejects(pending,/连接已变化/);
  assert.equal(replacement.calls.some(([method])=>method==='gitWorktreePreview'),false);
});
