const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { execFileSync } = require('node:child_process');
const gitWorktree = require('../git-worktree.cjs');
const { Workspace } = require('../workspace.cjs');
async function fixture(t) {
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'naw-session-worktree-')));
  const repo = path.join(temporary, 'project'), data = path.join(temporary, 'data'); fs.mkdirSync(repo);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/.test(key))), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  const git = (...args) => execFileSync(gitWorktree.available(), ['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','commit.gpgsign=false','-c','user.name=Synthetic fixture','-c','user.email=fixture@example.com',...args], { cwd: repo, env, encoding:'utf8', stdio:['ignore','pipe','pipe'] }).trim();
  git('init','--quiet'); fs.mkdirSync(path.join(repo,'src')); fs.writeFileSync(path.join(repo,'src/keep'),'Committed fixture'); git('add','--','.'); git('commit','--quiet','-m','Synthetic fixture');
  const starts = [], host = { binaries:{}, close() {}, create(record) {
    starts.push({ id:record.id, cwd:record.cwd, preparation:record.worktreePreparation?.status }); record.nativeId = 'synthetic-'+record.id;
    const runtime = new EventEmitter(); runtime.start = async () => runtime.emit('state','idle'); return runtime;
  } };
  const workspace = new Workspace(host,data), plan = await gitWorktree.preview(repo,randomUUID(),'src');
  t.after(() => { workspace.close(); fs.rmSync(temporary,{recursive:true,force:true}); });
  return {temporary,repo,data,git,host,starts,workspace,plan,create:() => workspace.create('codex',plan.source,'new-owner','Git work','chat',{gitWorktree:plan})};
}
test('preparing row is durable before Git; only the complete new copy starts natively', async t => {
  const f=await fixture(t), original=gitWorktree.prepare; let preparing;
  gitWorktree.prepare=async plan => {
    preparing=JSON.parse(fs.readFileSync(path.join(f.data,'workspace.json'),'utf8')).sessions.find(s=>s.cwd===plan.cwd);
    assert.equal(preparing.worktreePreparation.status,'preparing'); assert.equal(preparing.worktreePreparation.branch,plan.branch);
    assert.equal(fs.existsSync(plan.target),false); assert.equal(f.starts.length,0);
    return original(plan);
  };
  t.after(()=>{gitWorktree.prepare=original;});
  const id=await f.create(); assert.equal(id,preparing.id);
  assert.equal(f.workspace.get(id).activity,'');
  assert.deepEqual(f.starts,[{id,cwd:f.plan.cwd,preparation:'ready'}]);
  assert.equal(fs.readFileSync(path.join(f.plan.cwd,'keep'),'utf8'),'Committed fixture');
  assert.equal(f.workspace.get(id).owner,'new-owner');
  const stored=JSON.parse(fs.readFileSync(path.join(f.data,'workspace.json'),'utf8')).sessions.find(s=>s.id===id);
  assert.equal(stored.worktreePreparation.status,'ready');
  assert.equal(stored.activity,'');
});
test('an existing session keeps its original directory, identity, owner and unsent draft', async t => {
  const f=await fixture(t), old=await f.workspace.create('codex',f.repo,'original-owner','Existing','chat');
  f.workspace.setDraft(old,'Original unsent draft','original-owner'); const native=f.workspace.get(old).nativeId;
  await f.create(); const oldRecord=f.workspace.get(old);
  assert.equal(oldRecord.cwd,f.repo); assert.equal(oldRecord.nativeId,native); assert.equal(oldRecord.owner,'original-owner');
  assert.equal(f.workspace.drafts.get(old),'Original unsent draft'); assert.equal(f.starts.length,2);
});
test('a failed durable reservation cannot create a Git branch or native runtime', async t => {
  const f=await fixture(t), write=fs.writeFileSync;
  fs.writeFileSync=function(file,...args) { if(String(file)===path.join(f.data,'workspace.json.tmp')) throw Object.assign(Error('Synthetic full disk'),{code:'ENOSPC'}); return write.call(this,file,...args); };
  t.after(()=>{fs.writeFileSync=write;});
  try { await assert.rejects(f.create(),/未能安全保存/); }
  finally { fs.writeFileSync=write; }
  assert.equal(f.starts.length,0); assert.equal(fs.existsSync(f.plan.target),false); assert.equal(f.git('branch','--list',f.plan.branch),'');
});
test('Git failure retains the row, branch and full path, with no implicit retry or resume', async t => {
  const f=await fixture(t), original=gitWorktree.prepare;
  gitWorktree.prepare=async plan => { await original(plan); throw Error('Synthetic failure after copy'); };
  t.after(()=>{gitWorktree.prepare=original;});
  await assert.rejects(f.create(),error=>error.message.includes(f.plan.target)&&error.message.includes(f.plan.branch));
  const row=[...f.workspace.sessions.values()][0]; assert.equal(row.state,'error'); assert.equal(row.worktreePreparation.status,'unconfirmed');
  assert.equal(f.starts.length,0); assert.equal(f.git('rev-parse',f.plan.branch),f.plan.revision); assert.ok(fs.statSync(f.plan.target).isDirectory());
  await assert.rejects(f.workspace.resume(row.id,'new-owner'),/尚未确认/); assert.equal(f.starts.length,0);
});
test('closing the backend during preparation cannot launch the native agent afterward', async t => {
  const f=await fixture(t), original=gitWorktree.prepare; let enter,release;
  const entered=new Promise(r=>{enter=r;}), gate=new Promise(r=>{release=r;});
  gitWorktree.prepare=async plan=>{enter(); await gate; return original(plan);}; t.after(()=>{gitWorktree.prepare=original;});
  const pending=f.create(); await entered; f.workspace.close(); release();
  await assert.rejects(pending,/未启动原生会话/); assert.equal(f.starts.length,0); assert.ok(fs.existsSync(f.plan.target));
});
test('restart refuses a persisted incomplete copy and never reconstructs or deletes it', async t => {
  const f=await fixture(t); f.workspace.close();
  const id=randomUUID(); fs.writeFileSync(path.join(f.data,'workspace.json'),JSON.stringify({sessions:[{id,provider:'codex',nativeId:null,cwd:f.plan.cwd,name:'Interrupted preparation',state:'starting',messages:[],fleet:[],worktreePreparation:{...f.plan,status:'preparing'}}],room:{messages:[]},drafts:{[id]:'Retained draft'}}));
  const reopened=new Workspace(f.host,f.data); t.after(()=>reopened.close());
  await assert.rejects(reopened.resume(id,'new-owner'),/尚未确认/);
  assert.equal(f.starts.length,0); assert.equal(fs.existsSync(f.plan.target),false); assert.equal(reopened.drafts.get(id),'Retained draft');
});
test('forgetting a preparing row cannot start an invisible native session afterward',async t=>{
  const f=await fixture(t),original=gitWorktree.prepare;let enter,release;
  const entered=new Promise(r=>{enter=r;}),gate=new Promise(r=>{release=r;});
  gitWorktree.prepare=async plan=>{enter();await gate;return original(plan);};t.after(()=>{gitWorktree.prepare=original;});
  const pending=f.create();await entered;const row=[...f.workspace.sessions.values()][0];f.workspace.forget(row.id);release();
  await assert.rejects(pending,/已变化|取消/);assert.equal(f.starts.length,0);assert.equal(f.workspace.sessions.has(row.id),false);
  assert.equal(fs.readFileSync(path.join(f.plan.cwd,'keep'),'utf8'),'Committed fixture');
});
test('old empty-folder behavior and invalid mixed options stay separate', async t => {
  const f=await fixture(t);
  for(const options of [{gitWorktree:f.plan,newDirectory:true},{gitWorktree:f.plan,fork:'picker'},{gitWorktree:true}]) await assert.rejects(f.workspace.create('codex',f.repo,'new-owner','Invalid','chat',options));
  assert.equal(f.starts.length,0); assert.equal(fs.existsSync(f.plan.target),false);
});
test('ending a preparing session prevents later native start and retains the human-ended state',async t=>{
  const f=await fixture(t),original=gitWorktree.prepare;let enter,release;
  const entered=new Promise(r=>{enter=r;}),gate=new Promise(r=>{release=r;});
  gitWorktree.prepare=async plan=>{enter();await gate;return original(plan);};t.after(()=>{gitWorktree.prepare=original;});
  const pending=f.create();await entered;const row=[...f.workspace.sessions.values()][0];await f.workspace.stop(row.id);assert.equal(row.state,'ended');release();
  await assert.rejects(pending,/已变化|取消/);assert.equal(f.starts.length,0);assert.equal(row.state,'ended');assert.equal(row.owner,null);assert.ok(fs.existsSync(f.plan.target));
  assert.match(row.activity,/已取消原生会话启动/);
});
test('a reloaded ready copy cannot be falsely ended or forgotten while its process may be alive',async t=>{
  const f=await fixture(t),id=await f.create(),row=f.workspace.get(id);
  row.processIdentity=require('../platform.cjs').processIdentity(process.pid);assert.ok(row.processIdentity);
  f.workspace.persist();f.workspace.close();
  const reopened=new Workspace(f.host,f.data);t.after(()=>reopened.close());
  assert.equal(reopened.get(id).state,'recoverable');assert.equal(reopened.get(id).worktreePreparation.status,'ready');
  assert.throws(()=>reopened.stop(id),/会话已经结束/);
  assert.equal(reopened.get(id).state,'recoverable');assert.throws(()=>reopened.forget(id),/原生连接仍存在/);
  assert.ok(reopened.sessions.has(id));assert.equal(f.starts.length,1);
});
