const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../main.cjs'),'utf8');
function handler(name,extra={}) {
  const prefix=`  register('${name}', `, start=source.indexOf(prefix), end=source.indexOf('\n  });',start);
  assert.ok(start>=0&&end>start); const expression=source.slice(start+prefix.length,end+4);
  return vm.runInNewContext('('+expression+')',{assertNativeCreation:()=>{},...extra});
}
function context() {
  const calls=[],pending=[];
  return {calls,pending,worktreeSource:'/synthetic/repo',win:{isDestroyed:()=>false},client:{call:async(method,...args)=>{
    calls.push([method,...args]); if(method==='gitWorktreePreview')return new Promise(resolve=>pending.push(resolve)); if(method==='create')return 'synthetic-id'; return {};
  }}};
}
test('only the explicitly picked source can be previewed and older responses cannot replace a newer plan',async()=>{
  const c=context(),preview=handler('gitWorktreePreview'); await assert.rejects(preview(c,'/synthetic/other','bad',''),/先选择/); assert.equal(c.calls.length,0);
  const first=preview(c,c.worktreeSource,'first',''), second=preview(c,c.worktreeSource,'second','src');
  c.pending[1]({source:c.worktreeSource,nonce:'second'}); const current=await second;
  c.pending[0]({source:c.worktreeSource,nonce:'first'}); await assert.rejects(first,/预览已变化/); assert.equal(c.worktreePlan,current);
});
test('create consumes the exact preview once and rejects changed or duplicate plans',async()=>{
  const c=context(),create=handler('create'),plan={source:c.worktreeSource,nonce:'one',cwd:'/synthetic/copy'}; c.worktreePlan=plan;
  await assert.rejects(create(c,{gitWorktree:{...plan,cwd:'/elsewhere'}}),/预览已失效/);
  assert.equal(c.calls.some(([method])=>method==='create'),false);
  assert.equal(await create(c,{gitWorktree:{...plan}}),'synthetic-id'); assert.equal(c.worktreePlan,null);
  await assert.rejects(create(c,{gitWorktree:{...plan}}),/预览已失效/); assert.equal(c.calls.filter(([method])=>method==='create').length,1);
});
test('a newly picked directory invalidates the old preview without creating anything',async()=>{
  const c=context(); c.worktreePlan={nonce:'old'};
  const choose=handler('chooseFolder',{dialog:{showOpenDialog:async()=>({canceled:false,filePaths:['/synthetic/new-repo']})}});
  assert.equal(await choose(c),'/synthetic/new-repo'); assert.equal(c.worktreeSource,'/synthetic/new-repo'); assert.equal(c.worktreePlan,null); assert.equal(c.calls.length,0);
});
