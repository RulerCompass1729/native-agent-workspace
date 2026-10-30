const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {randomUUID}=require('node:crypto');
const source=fs.readFileSync(path.join(__dirname,'../renderer/renderer.js'),'utf8');
function fixture() {
  const nodes=new Map(),timers=new Map(),requests=[]; let timer=0;
  const get=id=>{if(!nodes.has(id))nodes.set(id,{checked:false,disabled:false,hidden:false,value:'',textContent:'',open:false});return nodes.get(id);};
  const dialog=get('create-dialog'); dialog.open=true; const ticket={valid:true};
  const context={ $,state:{capabilities:['gitWorktreeV1','nativePermissionDefaults','createSkipPermissions','newSessionDirectory'],preflight:{python:true,codex:true}},
    document:{querySelector:()=>({value:'codex'})},crypto:{randomUUID},dialogTickets:new Map([[dialog,ticket]]),
    currentDialogTicket:t=>t===ticket&&ticket.valid&&dialog.open,
    setTimeout:fn=>{timers.set(++timer,fn);return timer;},clearTimeout:id=>timers.delete(id),
    api:{gitWorktreePreview:(...args)=>new Promise(resolve=>requests.push({args,resolve})),create:()=>{context.createCalls++;return Promise.resolve('id');}},createCalls:0};
  function $(id){return get(id);}
  context.attempt=fn=>{context.pending=fn();};
  vm.createContext(context);
  const names=['invalidateGitPreview','refreshGitPreview','scheduleGitPreview','createReadiness'];
  const declarations=names.map(name=>source.match(new RegExp('(?:async )?function '+name+'\\([\\s\\S]*?\\n}'))?.[0]);
  assert.ok(declarations.every(Boolean));
  vm.runInContext("let folder='/synthetic/repo',newDirectory=false,creatingSession=false,gitWorktreePlan=null,gitWorktreeNonce='nonce',gitPreviewRevision=0,gitPreviewLoading=false,gitPreviewTimer,selectionRevision=0;\n"+declarations.join('\n'),context);
  get('git-worktree').checked=true; get('chosen-folder').textContent='/synthetic/repo';
  return {get,ticket,requests,timers,context,run:code=>vm.runInContext(code,context)};
}
function plan(source='/synthetic/repo',relative='') {return {source,repository:source,revision:'a'.repeat(40),branch:'naw/synthetic',cwd:'/synthetic/new-copy'+(relative?'/'+relative:'')};}
test('late preview cannot overwrite a newer selected source or re-enable stale creation',async()=>{
  const f=fixture(),first=f.run('refreshGitPreview()');
  const second=f.run("folder='/synthetic/new-repo';invalidateGitPreview(true);refreshGitPreview()");
  f.requests[0].resolve(plan()); await first;
  assert.equal(f.run('gitWorktreePlan'),null); assert.equal(f.get('confirm-create').disabled,true);
  f.requests[1].resolve(plan('/synthetic/new-repo')); await second;
  assert.equal(f.run('gitWorktreePlan.source'),'/synthetic/new-repo'); assert.equal(f.get('confirm-create').disabled,false);
});
test('closing or replacing the dialog discards a pending preview without changing fields',async()=>{
  const f=fixture(),pending=f.run('refreshGitPreview()'); f.get('create-dialog').open=false; f.run('invalidateGitPreview()');
  f.requests[0].resolve(plan()); await pending;
  assert.equal(f.run('gitWorktreePlan'),null); assert.equal(f.get('chosen-folder').textContent,'/synthetic/repo');
});
test('loss of backend capability keeps the requested Git choice and forbids original-directory fallback',async()=>{
  const f=fixture(),pending=f.run('refreshGitPreview()');f.requests[0].resolve(plan());await pending;
  f.context.state.capabilities=f.context.state.capabilities.filter(cap=>cap!=='gitWorktreeV1'); f.run('createReadiness()');
  assert.equal(f.get('git-worktree').checked,true);assert.equal(f.get('confirm-create').disabled,true);assert.equal(f.run('gitWorktreePlan'),null);
  assert.equal(f.get('chosen-folder').textContent,'/synthetic/repo');
  const start=source.indexOf("$('create-form').onsubmit ="),end=source.indexOf("\n}); };",start)+"\n}); };".length;assert.ok(start>=0&&end>start);
  f.run(source.slice(start,end));f.get('create-form').onsubmit({preventDefault(){}});
  await assert.rejects(f.context.pending,/没有改用原目录启动/);assert.equal(f.context.createCalls,0);
});
test('relative input is anchored to the new copy and coalesces preview reads',async()=>{
  const f=fixture();f.get('git-worktree-relative').value='s';f.run('scheduleGitPreview()');f.get('git-worktree-relative').value='src';f.run('scheduleGitPreview()');
  assert.equal(f.requests.length,0);assert.equal(f.timers.size,1);assert.equal(f.get('confirm-create').disabled,true);
  [...f.timers.values()][0]();await new Promise(setImmediate);assert.equal(f.requests.length,1);assert.equal(f.requests[0].args[2],'src');
  f.requests[0].resolve(plan('/synthetic/repo','src'));await new Promise(setImmediate);
  assert.equal(f.get('chosen-folder').textContent,'/synthetic/new-copy/src');assert.equal(f.get('confirm-create').disabled,false);
});
test('a failed create keeps the selected source visible and requires a new explicit preview',async()=>{
  const f=fixture(),pending=f.run('refreshGitPreview()');f.requests[0].resolve(plan());await pending;
  f.context.state.sessions=[];f.context.api.create=async()=>{throw Error('Synthetic repository changed before preparation');};
  f.context.api.initial=async()=>f.context.state;f.context.updateState=()=>{};f.context.render=()=>{};
  const start=source.indexOf("$('create-form').onsubmit ="),end=source.indexOf("\n}); };",start)+"\n}); };".length;assert.ok(start>=0&&end>start);
  f.run(source.slice(start,end));f.get('create-form').onsubmit({preventDefault(){}});await f.context.pending;
  assert.match(f.get('create-error').textContent,/Synthetic repository changed/);
  assert.equal(f.get('chosen-folder').textContent,'/synthetic/repo');assert.equal(f.get('git-worktree').checked,true);
  assert.equal(f.run('gitWorktreePlan'),null);assert.equal(f.get('confirm-create').disabled,true);
});
