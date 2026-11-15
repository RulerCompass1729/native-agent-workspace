const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {randomUUID}=require('node:crypto');
const locale=require('../ui-locale.js');
const bootstrap=fs.readFileSync(require.resolve('../dsh/bootstrap.js'),'utf8');
const begin=bootstrap.indexOf('    function createDisplayBindings('),finish=bootstrap.indexOf('    function mountWorkspace(',begin);
assert.ok(begin>=0&&finish>begin);
const createBindings=vm.runInNewContext('('+bootstrap.slice(begin,finish).trim()+')');
const source=fs.readFileSync(path.join(__dirname,'../renderer/renderer.js'),'utf8');
function fixture() {
  const nodes=new Map(),timers=new Map(),requests=[],defaults=[]; let timer=0;
  const get=id=>{if(!nodes.has(id))nodes.set(id,{checked:false,disabled:false,hidden:false,value:'',textContent:'',open:false,dataset:{},replaceChildren(){},add(){},querySelectorAll:()=>[],childElementCount:0,attrs:new Map(),setAttribute(k,v){this.attrs.set(k,String(v));},getAttribute(k){return this.attrs.get(k)??null;},removeAttribute(k){this.attrs.delete(k);}});return nodes.get(id);};
  const dialog=get('create-dialog'); dialog.open=true; let ticket={valid:true};
  const uiText=(key,params)=>locale.format('zh',key,params),display=createBindings(uiText);
  const context={ $,uiError:locale.createError,uiText,ui:{display,errorText:error=>locale.errorText('zh',error),showError(element,error){display.unbind(element);element.textContent=error.message;}},state:{sessions:[],defaultWorkspace:'/synthetic/shared',newWorkspaceRoot:'/synthetic/sessions',capabilities:['gitWorktreeV1','nativePermissionDefaults','createSkipPermissions','newSessionDirectory'],preflight:{python:true,codex:true}},
    document:{querySelector:()=>({value:'codex'})},crypto:{randomUUID},dialogTickets:new Map([[dialog,ticket]]),
    currentDialogTicket:t=>t===ticket&&ticket.valid&&dialog.open,
    openTransientDialog:()=>{ticket={valid:true};context.dialogTickets.set(dialog,ticket);dialog.open=true;return ticket;},
    allSpaces:()=>[],spaceRecord:()=>undefined,Option:function(){return get('space-placeholder');},
    setTimeout:fn=>{timers.set(++timer,fn);return timer;},clearTimeout:id=>timers.delete(id),
    api:{gitWorktreePreview:(...args)=>new Promise(resolve=>requests.push({args,resolve})),createDefaults:()=>new Promise((resolve,reject)=>defaults.push({resolve,reject})),create:()=>{context.createCalls++;return Promise.resolve('id');}},createCalls:0};
  function $(id){return get(id);}
  context.attempt=fn=>{context.pending=fn();};
  vm.createContext(context);
  // T-115: createReadiness also renders the space choice; an independent session (the default) keeps these checks unchanged.
  const names=['openCreate','resetCreateDirectory','invalidateGitPreview','refreshGitPreview','scheduleGitPreview','createReadiness','renderCreateSpaces','createSpaceReadiness','createSpaceChoice','deepseekProfiles','deepseekChosen','chosenProvider','renderCreateProfiles'];
  const declarations=names.map(name=>source.match(new RegExp('(?:async )?function '+name+'\\([\\s\\S]*?\\n}'))?.[0]);
  assert.ok(declarations.every(Boolean));
  get('create-space-kind').value='independent';
  const defaultsLoader=source.match(/async function loadCreateDirectory\([\s\S]*?\n}/)?.[0]||'';
  vm.runInContext("let folder='/synthetic/repo',newDirectory=false,creatingSession=false,gitWorktreePlan=null,gitWorktreeNonce='nonce',gitPreviewRevision=0,gitPreviewLoading=false,gitPreviewTimer,selectionRevision=0,preference='chat';\n"+declarations.join('\n')+'\n'+defaultsLoader,context);
  get('git-worktree').checked=true; get('chosen-folder').textContent='/synthetic/repo';
  return {get,get ticket(){return ticket;},requests,defaults,timers,context,run:code=>vm.runInContext(code,context)};
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
test('B2 reopening creation defaults to the saved repository worktree and waits for its preview',async()=>{
  const f=fixture(),pending=f.run("openCreate('codex')");
  assert.equal(f.defaults.length,1);assert.equal(f.get('confirm-create').disabled,true);
  f.defaults[0].resolve({repository:'/synthetic/repo',directory:'/synthetic/prior'});await new Promise(setImmediate);
  assert.equal(f.run('folder'),'/synthetic/repo');assert.equal(f.run('newDirectory'),false);assert.equal(f.get('git-worktree').checked,true);
  assert.equal(f.requests.length,1);assert.equal(f.requests[0].args[0],'/synthetic/repo');assert.equal(f.requests[0].args[2],'');
  f.requests[0].resolve(plan());await pending;
  assert.equal(f.get('chosen-folder').textContent,'/synthetic/new-copy');assert.equal(f.get('confirm-create').disabled,false);
});
for(const entry of [{directory:'/synthetic/prior'},{}, {repository:'/synthetic/repo',directory:'/synthetic/prior',unsupported:true}])test(`B2 creation directory fallback ${JSON.stringify(entry)}`,async()=>{
  const f=fixture();if(entry.unsupported)f.context.state.capabilities=f.context.state.capabilities.filter(x=>x!=='gitWorktreeV1');
  const pending=f.run("openCreate('codex')");assert.equal(f.defaults.length,1);f.defaults[0].resolve(entry);await pending;
  assert.equal(f.get('git-worktree').checked,false);assert.equal(f.requests.length,0);
  assert.equal(f.run('newDirectory'),!entry.directory);assert.equal(f.run('folder'),entry.directory||f.get('chosen-folder').textContent);
  if(!entry.directory)assert.match(f.run('folder'),/^\/synthetic\/sessions\/[0-9a-f-]{36}$/);
  assert.equal(f.get('confirm-create').disabled,false);
});
test('B2 old defaults do not change a closed or newer creation dialog',async()=>{
  const f=fixture(),first=f.run("openCreate('codex')");assert.equal(f.defaults.length,1);
  f.get('create-dialog').open=false;f.run('invalidateGitPreview()');
  const second=f.run("openCreate('codex')");assert.equal(f.defaults.length,2);
  f.defaults[0].resolve({repository:'/synthetic/old'});await first;
  assert.equal(f.requests.length,0);assert.notEqual(f.run('folder'),'/synthetic/old');
  f.defaults[1].resolve({directory:'/synthetic/current'});await second;
  assert.equal(f.run('folder'),'/synthetic/current');assert.equal(f.get('confirm-create').disabled,false);
});
test('B2 explicitly requesting a new empty folder wins over a late saved repository',async()=>{
  const f=fixture(),pending=f.run("openCreate('codex')");assert.equal(f.defaults.length,1);
  const initial=f.run('folder');f.run('resetCreateDirectory();createReadiness()');const manual=f.run('folder');assert.notEqual(manual,initial);
  f.defaults[0].resolve({repository:'/synthetic/old'});await pending;
  assert.equal(f.run('folder'),manual);assert.equal(f.run('newDirectory'),true);assert.equal(f.get('git-worktree').checked,false);
  assert.equal(f.requests.length,0);assert.equal(f.get('confirm-create').disabled,false);
});
test('B2 manual folder picker cancels defaults before waiting for the native chooser',async()=>{
  const f=fixture(),pending=f.run("openCreate('codex')");assert.equal(f.defaults.length,1);
  let choose;f.context.api.chooseFolder=()=>new Promise(resolve=>choose=resolve);
  const start=source.indexOf("$('choose-folder').onclick ="),end=source.indexOf("\n$('git-worktree').onchange",start);assert.ok(start>=0&&end>start);
  f.run(source.slice(start,end));f.get('choose-folder').onclick();
  f.defaults[0].resolve({repository:'/synthetic/old'});await pending;assert.equal(f.requests.length,0);
  choose('/synthetic/manual');await f.context.pending;
  assert.equal(f.run('folder'),'/synthetic/manual');assert.equal(f.get('confirm-create').disabled,false);
});
test('B2 failed defaults stay visible and require an explicit directory choice',async()=>{
  const f=fixture(),pending=f.run("openCreate('codex')");assert.equal(f.defaults.length,1);
  f.defaults[0].reject(Error('Synthetic defaults unavailable'));await pending;
  assert.match(f.get('create-error').textContent,/Synthetic defaults unavailable/);assert.equal(f.get('confirm-create').disabled,true);
  f.run('resetCreateDirectory();createReadiness()');assert.equal(f.get('confirm-create').disabled,false);
});
test('B2 form submission cannot create in the temporary empty path while defaults are pending',async()=>{
  const f=fixture();f.get('git-worktree').checked=false;f.ticket.directoryDefaults={};
  f.context.api.initial=async()=>f.context.state;f.context.updateState=()=>{};f.context.render=()=>{};f.context.select=async()=>{};
  f.get('create-dialog').close=()=>{f.get('create-dialog').open=false;};
  const start=source.indexOf("$('create-form').onsubmit ="),end=source.indexOf("\n}); };",start)+"\n}); };".length;assert.ok(start>=0&&end>start);
  f.run(source.slice(start,end));f.get('create-form').onsubmit({preventDefault(){}});
  if(f.context.pending)await f.context.pending;
  assert.equal(f.context.createCalls,0);
});
