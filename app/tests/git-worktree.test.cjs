const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const worktree = require('../git-worktree.cjs');

function fixture(t) {
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'naw-git-worktree-')));
  const repo = path.join(temporary, 'sample repository'); fs.mkdirSync(repo);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/.test(key))),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
  const git = (...args) => execFileSync(worktree.available(), ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
    '-c', 'commit.gpgsign=false', '-c', 'user.name=Synthetic fixture', '-c', 'user.email=fixture@example.com', ...args], { cwd: repo, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--quiet'); fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src/keep.txt'), 'Committed public fixture\n');
  fs.writeFileSync(path.join(repo, 'README'), 'Synthetic repository\n');
  fs.writeFileSync(path.join(repo, '.gitattributes'), '*.txt filter=poison\n');
  git('add', '--', '.'); git('commit', '--quiet', '-m', 'Synthetic worktree fixture');
  const revision = git('rev-parse', 'HEAD');
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  return { temporary, repo, git, revision, plan: (relative = '', nonce = randomUUID(), selected = repo) => worktree.preview(selected, nonce, relative) };
}
test('preview is read only and the subdirectory starts at the new copy root', async t => {
  const f = fixture(t), plan = await f.plan('', randomUUID(), path.join(f.repo, 'src'));
  assert.equal(plan.repository, f.repo); assert.equal(plan.revision, f.revision);
  assert.equal(plan.cwd, plan.target); assert.equal(plan.relativeDirectory, '');
  assert.equal(fs.existsSync(`${f.repo}-lanes`), false);
  assert.equal(f.git('branch', '--list', plan.branch), '');
  const child = await f.plan('src'); assert.equal(child.cwd, path.join(child.target, 'src'));
});
test('prepare copies only the committed snapshot into a new branch and retains original work', async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.repo, 'src/keep.txt'), 'Uncommitted original\n');
  fs.writeFileSync(path.join(f.repo, 'untracked'), 'Private original fixture\n');
  const plan = await f.plan('src'), cwd = await worktree.prepare(plan);
  assert.equal(cwd, path.join(plan.target, 'src'));
  assert.equal(fs.readFileSync(path.join(cwd, 'keep.txt'), 'utf8'), 'Committed public fixture\n');
  assert.equal(fs.existsSync(path.join(plan.target, 'untracked')), false);
  assert.equal(fs.readFileSync(path.join(f.repo, 'src/keep.txt'), 'utf8'), 'Uncommitted original\n');
  assert.equal(f.git('rev-parse', 'HEAD'), f.revision);
  assert.equal(f.git('rev-parse', plan.branch), f.revision);
  assert.ok(fs.readFileSync(path.join(plan.target, '.git'), 'utf8').startsWith('gitdir: '));
});
test('configured hooks, fsmonitor, smudge and process filters do not execute', async t => {
  const f = fixture(t), marker = path.join(f.temporary, 'unexpected-execution');
  const poison = path.join(f.temporary, 'poison.cjs');
  fs.writeFileSync(poison, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected');\n`);
  const quote = text => "'" + text.replace(/'/g, "'\\''") + "'";
  const command = `${quote(process.execPath)} ${quote(poison)}`;
  f.git('config', 'core.fsmonitor', command);
  for (const field of ['smudge', 'clean', 'process']) f.git('config', `filter.poison.${field}`, command);
  f.git('config', 'filter.poison.required', 'true');
  const hooks = path.join(f.temporary, 'hooks'); fs.mkdirSync(hooks);
  fs.writeFileSync(path.join(hooks, 'post-checkout'), `#!/bin/sh\n${command}\n`, { mode: 0o700 });
  f.git('config', 'core.hooksPath', hooks);
  const plan = await f.plan(); await worktree.prepare(plan);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(fs.readFileSync(path.join(plan.target, 'src/keep.txt'), 'utf8'), 'Committed public fixture\n');
});
test('invalid paths, nonce and noncommitted directories never reserve a path', async t => {
  const f = fixture(t);
  for (const child of ['../escape', '/absolute', 'src/../other', 'src//other', 'src\\other', 'src\x00bad']) await assert.rejects(f.plan(child));
  await assert.rejects(f.plan('', 'not-a-nonce'));
  await assert.rejects(f.plan('README'));
  fs.mkdirSync(path.join(f.repo, 'untracked-dir')); await assert.rejects(f.plan('untracked-dir'));
  assert.equal(fs.existsSync(`${f.repo}-lanes`), false);
});
test('filter configuration introduced between registration and checkout is still disabled', async t => {
  const f=fixture(t), plan=await f.plan(), marker=path.join(f.temporary,'changed-filter-ran'), poison=path.join(f.temporary,'changed-filter.cjs');
  fs.writeFileSync(poison,`require('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected');process.stdin.pipe(process.stdout);\n`);
  const quote=text=>"'"+text.replace(/'/g,"'\\''")+"'",command=`${quote(process.execPath)} ${quote(poison)}`;
  const read=fs.readFileSync,config=path.join(f.repo,'.git/config');let injected=false;
  fs.readFileSync=function(file,...args){
    if(String(file)===config&&!injected&&fs.existsSync(path.join(plan.target,'.git'))){injected=true;f.git('config','filter.poison.smudge',command);}
    return read.call(this,file,...args);
  };
  try{await worktree.prepare(plan);}finally{fs.readFileSync=read;}
  assert.equal(injected,true);assert.equal(fs.existsSync(marker),false);
  assert.equal(fs.readFileSync(path.join(plan.target,'src/keep.txt'),'utf8'),'Committed public fixture\n');
});
test('existing destination files/directories/links are never reused', async t => {
  const f = fixture(t); fs.mkdirSync(`${f.repo}-lanes`);
  for (const kind of ['directory','file','link']) {
    const nonce = randomUUID(), target = path.join(`${f.repo}-lanes`, nonce);
    if (kind === 'directory') fs.mkdirSync(target);
    else if (kind === 'file') fs.writeFileSync(target, 'Keep');
    else fs.symlinkSync(f.repo, target);
    await assert.rejects(f.plan('', nonce), /已存在/); assert.ok(fs.lstatSync(target));
  }
});
test('checkout preserves a file written into the new target while preparation was pending',async t=>{
  const f=fixture(t),plan=await f.plan(),config=path.join(f.repo,'.git/config'),read=fs.readFileSync;let injected=false,failed=false;
  fs.readFileSync=function(file,...args){
    if(String(file)===config&&!injected&&fs.existsSync(path.join(plan.target,'.git'))){injected=true;fs.mkdirSync(path.join(plan.target,'src'));fs.writeFileSync(path.join(plan.target,'src/keep.txt'),'Intervening user work');}
    return read.call(this,file,...args);
  };
  try{await worktree.prepare(plan);}catch{failed=true;}finally{fs.readFileSync=read;}
  assert.equal(injected,true);assert.equal(fs.readFileSync(path.join(plan.target,'src/keep.txt'),'utf8'),'Intervening user work');assert.equal(failed,true);
  assert.equal(f.git('rev-parse',plan.branch),plan.revision);
});
test('changed or forged plans fail before branch or directory mutation', async t => {
  const f = fixture(t), plan = await f.plan();
  for (const change of [{ target: path.join(f.temporary, 'elsewhere') }, { branch: 'main' }, { cwd: f.repo }, { revision: '0'.repeat(40) }, { extra: 'unexpected' }]) await assert.rejects(worktree.prepare({ ...plan, ...change }));
  assert.equal(fs.existsSync(`${f.repo}-lanes`), false);
  fs.writeFileSync(path.join(f.repo, 'later'), 'New committed fixture'); f.git('add', '--', 'later'); f.git('commit', '--quiet', '-m', 'Later synthetic fixture');
  await assert.rejects(worktree.prepare(plan), /已变化/);
  assert.equal(fs.existsSync(`${f.repo}-lanes`), false);
});
test('include, partial-clone and linked metadata are bounded and fail closed', async t => {
  const f = fixture(t), config = path.join(f.repo, '.git/config'), original = fs.readFileSync(config);
  fs.appendFileSync(config, '\n[include]\n path = /synthetic/not-read\n'); await assert.rejects(f.plan(), /外部 Git 配置/); fs.writeFileSync(config, original);
  f.git('config', 'extensions.partialClone', 'origin'); await assert.rejects(f.plan(), /部分克隆/); fs.writeFileSync(config, original);
  const alternates = path.join(f.repo, '.git/objects/info/alternates'); fs.writeFileSync(alternates, '/synthetic/not-read\n'); await assert.rejects(f.plan(), /外部对象/); fs.unlinkSync(alternates);
  const outside = path.join(f.temporary, 'outside-config'); fs.renameSync(config, outside); fs.symlinkSync(outside, config); await assert.rejects(f.plan(), /含链接/); fs.unlinkSync(config); fs.renameSync(outside, config);
  assert.equal(fs.existsSync(`${f.repo}-lanes`), false);
});
test('one prepared copy can itself be the source without cloning a native session', async t => {
  const f = fixture(t), first = await f.plan(); await worktree.prepare(first);
  const next = await worktree.preview(first.target, randomUUID(), 'src');
  assert.equal(next.repository, first.target); assert.equal(next.revision, first.revision);
  await worktree.prepare(next);
  assert.equal(fs.readFileSync(path.join(next.cwd, 'keep.txt'), 'utf8'), 'Committed public fixture\n');
});
test('concurrent use of one preview reserves at most one new copy', async t => {
  const f = fixture(t), plan = await f.plan();
  const results = await Promise.allSettled([worktree.prepare(plan), worktree.prepare(plan)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected').length, 1);
  assert.equal(fs.readFileSync(path.join(plan.target, 'src/keep.txt'), 'utf8'), 'Committed public fixture\n');
});
test('a repository without commits has an actionable message and creates no copy',async t=>{
  const f=fixture(t),empty=path.join(f.temporary,'unborn');fs.mkdirSync(empty);
  execFileSync(worktree.available(),['-c','init.templateDir=','init','--quiet',empty],{env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null'}});
  await assert.rejects(worktree.preview(empty,randomUUID()),/需要先有一个本机提交/);
  assert.equal(fs.existsSync(empty+'-lanes'),false);
});
test('a non-repository folder fails before reserving a path',async t=>{
  const f=fixture(t),folder=path.join(f.temporary,'not a repository');fs.mkdirSync(folder);
  await assert.rejects(worktree.preview(folder,randomUUID()),/不在 Git 工作区/);assert.equal(fs.existsSync(folder+'-lanes'),false);
});
test('a linked selection is refused for automatic copies without making either copy root',async t=>{
  const f=fixture(t),link=path.join(f.temporary,'selected link');fs.symlinkSync(path.join(f.repo,'src'),link);
  await assert.rejects(worktree.preview(link,randomUUID()),/链接.*自动副本/);
  assert.equal(fs.existsSync(f.repo+'-lanes'),false);assert.equal(fs.existsSync(link+'-lanes'),false);
});
test('fake container selections are rejected before realpath or any target metadata read',async t=>{
  const f=fixture(t),container=path.join(f.temporary,'Library/Containers/synthetic.app/Data/repo'),link=path.join(f.temporary,'outside-selected-link');
  fs.mkdirSync(container,{recursive:true});fs.symlinkSync(container,link);
  const real=fs.realpathSync,stat=fs.statSync,lstat=fs.lstatSync;let resolutions=0,targetMetadata=0;
  const forbidden=file=>['Library/Containers','Library/Group Containers'].some(folder=>String(file).toLowerCase().startsWith(path.join(f.temporary,folder).toLowerCase()));
  fs.realpathSync=function(file,...args){if(String(file)===link||forbidden(file)){resolutions++;throw Error('Synthetic forbidden realpath tripwire');}return real.call(this,file,...args);};
  fs.statSync=function(file,...args){if(forbidden(file)){targetMetadata++;throw Error('Synthetic forbidden stat tripwire');}return stat.call(this,file,...args);};
  fs.lstatSync=function(file,...args){if(forbidden(file)){targetMetadata++;throw Error('Synthetic forbidden lstat tripwire');}return lstat.call(this,file,...args);};
  let linkedError;
  try{
    for(const selected of [container,container.replace('/Library/Containers/','/library/containers/'),container.replace('/Library/Containers/','/LiBrArY/cOnTaInErS/'),container.replace('/Library/Containers/','/library/group containers/')])await assert.rejects(worktree.preview(selected,randomUUID()),/不自动访问应用容器/);
    try{await worktree.preview(link,randomUUID());}catch(error){linkedError=error;}
  }
  finally{fs.realpathSync=real;fs.statSync=stat;fs.lstatSync=lstat;}
  assert.ok(linkedError);assert.equal(resolutions,0);assert.equal(targetMetadata,0);assert.match(linkedError.message,/链接.*自动副本/);
  assert.equal(fs.existsSync(f.repo+'-lanes'),false);assert.equal(fs.existsSync(link+'-lanes'),false);
});
test('a filter introduced after read-tree cannot execute during checkout',async t=>{
  const f=fixture(t),plan=await f.plan(),marker=path.join(f.temporary,'after-index-filter-ran'),poison=path.join(f.temporary,'after-index-filter.cjs');
  fs.writeFileSync(poison,`require('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected');process.stdin.pipe(process.stdout);\n`);
  const quote=s=>"'"+s.replace(/'/g,"'\\''")+"'",command=`${quote(process.execPath)} ${quote(poison)}`;
  const cp=require('node:child_process'),exec=cp.execFile,key=require.resolve('../git-worktree.cjs'),cached=require.cache[key];let injected=false;
  cp.execFile=function(binary,args,options,callback){return exec.call(this,binary,args,options,(error,...rest)=>{
    if(!error&&args.includes('read-tree')&&!injected){injected=true;f.git('config','filter.poison.smudge',command);}
    callback(error,...rest);
  });};
  delete require.cache[key];const isolated=require('../git-worktree.cjs');cp.execFile=exec;require.cache[key]=cached;
  await isolated.prepare(plan);assert.equal(injected,true);assert.equal(fs.existsSync(marker),false);
  assert.equal(fs.readFileSync(path.join(plan.target,'src/keep.txt'),'utf8'),'Committed public fixture\n');
  assert.equal(f.git('-C',plan.target,'status','--porcelain'),'');
});
test('isolated checkout supports sha256 repositories with a normal usable worktree index',async t=>{
  const f=fixture(t),repo=path.join(f.temporary,'sha256');fs.mkdirSync(repo);
  f.git('init','--quiet','--template=','--object-format=sha256',repo);
  fs.writeFileSync(path.join(repo,'keep'),'Committed sha256 fixture');f.git('-C',repo,'add','.');f.git('-C',repo,'commit','--quiet','-m','Synthetic sha256 fixture');
  const plan=await worktree.preview(repo,randomUUID());assert.equal(plan.revision.length,64);await worktree.prepare(plan);
  assert.equal(fs.readFileSync(path.join(plan.target,'keep'),'utf8'),'Committed sha256 fixture');assert.equal(f.git('-C',plan.target,'status','--porcelain'),'');
});
test('an index created during preparation is preserved and only owned temporary metadata is cleaned',async t=>{
  const f=fixture(t),plan=await f.plan(),config=path.join(f.repo,'.git/config'),read=fs.readFileSync,mkdtemp=fs.mkdtempSync,temporary=[];let index;
  fs.readFileSync=function(file,...args){
    if(String(file)===config&&!index&&fs.existsSync(path.join(plan.target,'.git'))){
      const marker=read.call(this,path.join(plan.target,'.git'),'utf8');index=path.join(marker.trim().slice(8),'index');fs.writeFileSync(index,'Intervening user index');
    }return read.call(this,file,...args);
  };
  fs.mkdtempSync=function(prefix,...args){const result=mkdtemp.call(this,prefix,...args);if(String(prefix).endsWith('naw-git-checkout-'))temporary.push(result);return result;};
  try{await assert.rejects(worktree.prepare(plan));}finally{fs.readFileSync=read;fs.mkdtempSync=mkdtemp;}
  assert.equal(fs.readFileSync(index,'utf8'),'Intervening user index');assert.equal(temporary.length,1);assert.equal(fs.existsSync(temporary[0]),false);
  assert.equal(fs.readFileSync(path.join(plan.target,'src/keep.txt'),'utf8'),'Committed public fixture\n');assert.equal(f.git('rev-parse',plan.branch),plan.revision);
});
