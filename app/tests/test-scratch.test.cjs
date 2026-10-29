const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawnSync, spawn } = require('node:child_process');
const helper = path.resolve(__dirname, '../../scripts/fixtures/test-scratch.cjs');
function probe(body, options = {}) {
  const source = (options.prelude || '') + `const scratch=require(${JSON.stringify(helper)}),fs=require('node:fs'),os=require('node:os'),path=require('node:path');const root=scratch.directory(path.join(os.tmpdir(),'naw-scratch-check-'));console.log(JSON.stringify({root}));` + body;
  const r = spawnSync(process.execPath, ['-e', source], { encoding: 'utf8', timeout: 15000, env: { ...process.env, NAW_EVIDENCE_DIR: '', ...options.env } });
  const root = JSON.parse(r.stdout.split('\n')[0]).root;
  return { ...r, root };
}
for (const mode of ['success', 'throw', 'rejection', 'explicit-exit']) test('owned scratch is removed after ' + mode, () => {
  const r = probe({success:"Promise.resolve().finally(scratch.cleanup(async()=>{}));",throw:"throw Error('fixture failure');",rejection:"Promise.reject(Error('fixture rejection'));",'explicit-exit':'process.exit(7);'}[mode]);
  assert.equal(r.status, mode === 'success' ? 0 : mode === 'explicit-exit' ? 7 : 1, r.stderr);
  assert.equal(fs.existsSync(r.root), false, r.stderr);
});
for (const signal of ['SIGINT', 'SIGTERM']) test('signal teardown removes only the owned child and scratch: ' + signal, async () => {
  const child = spawn(process.execPath, ['-e', `const scratch=require(${JSON.stringify(helper)}),fs=require('node:fs'),os=require('node:os'),path=require('node:path');const root=scratch.directory(path.join(os.tmpdir(),'naw-signal-check-'));const owned=scratch.childProcess.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});scratch.cleanup(async()=>{});console.log(JSON.stringify({root,pid:owned.pid}));setInterval(()=>{},1000);`], { env: { ...process.env, NAW_EVIDENCE_DIR: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output='',errors='';child.stderr.on('data',b=>errors+=b);
  const ready=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Signal fixture did not start')),10000);child.stdout.on('data',b=>{output+=b;if(output.includes('\n')){clearTimeout(timer);resolve(JSON.parse(output.split('\n')[0]));}});});
  const ended=new Promise(resolve=>child.once('exit',(code,sig)=>resolve({code,signal:sig})));child.kill(signal);const r=await ended;
  assert.equal(r.signal,signal,errors);assert.equal(fs.existsSync(ready.root),false,errors);assert.throws(()=>process.kill(ready.pid,0));
});
test('explicit export retains success and failure originals outside temporary profiles', () => {
  const target=fs.mkdtempSync(path.join(os.tmpdir(),'evidence-check-'));
  try {
    const r=probe("fs.writeFileSync(path.join(root,'failure.txt'),'Original failure');fs.writeFileSync(path.join(root,'resumed.json'),'{\"original\":true}');Promise.resolve().finally(scratch.cleanup(async()=>{}));",{env:{NAW_EVIDENCE_DIR:target}});
    assert.equal(r.status,0,r.stderr);assert.equal(fs.existsSync(r.root),false);
    const out=path.join(target,'raw',path.basename(r.root));assert.equal(fs.readFileSync(path.join(out,'failure.txt'),'utf8'),'Original failure');assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out,'resumed.json'))),{original:true});
  } finally { fs.rmSync(target,{recursive:true,force:true}); }
});
test('all temporary-profile test entry points use the shared allocator and finalizer', () => {
  const dir=path.resolve(__dirname,'../../scripts');let count=0;
  for(const file of fs.readdirSync(dir).filter(n=>/^test-.*\.cjs$/.test(n))){const source=fs.readFileSync(path.join(dir,file),'utf8');assert.doesNotMatch(source,/\bfs\.mkdtempSync\(/,file);if(source.includes('testScratch.directory(')){count++;assert.ok(/\.finally\(testScratch\.cleanup\(/.test(source)||/const cleanup = testScratch\.cleanup\(/.test(source)&&/\.finally\(async \(\) => \{\s*try \{ await cleanup\(\)/.test(source),file);}}
  assert.ok(count>=57,'Census must cover all existing test profiles');
});
test('a replaced directory is never removed or exported as owned evidence', () => {
  const r=probe("fs.rmSync(root,{recursive:true});fs.mkdirSync(root);fs.writeFileSync(path.join(root,'replacement.txt'),'untouched');Promise.resolve().finally(scratch.cleanup(async()=>{}));");
  try { assert.notEqual(r.status,0,r.stderr);assert.equal(fs.readFileSync(path.join(r.root,'replacement.txt'),'utf8'),'untouched'); }
  finally { fs.rmSync(r.root,{recursive:true,force:true}); }
});
test('cleanup of a registered hard-killed service removes its socket directory', () => {
  const daemon=path.resolve(__dirname,'../daemon.cjs');
  const r=probe(`(async()=>{const child=scratch.childProcess.fork(${JSON.stringify(daemon)},[root],{stdio:'ignore',env:{...process.env,NAW_APP_VERSION:'scratch-fixture',NAW_WORKSPACE:root}});for(let n=0;n<100&&!fs.existsSync(path.join(root,'connection.json'));n++)await new Promise(r=>setTimeout(r,30));const info=JSON.parse(fs.readFileSync(path.join(root,'connection.json')));console.log(JSON.stringify({service:path.dirname(info.endpoint)}));scratch.ownService(root);const done=new Promise(r=>child.once('exit',r));child.kill('SIGKILL');await done;})().finally(scratch.cleanup(async()=>{}));`);
  assert.equal(r.status,0,r.stderr);assert.equal(fs.existsSync(r.root),false);assert.equal(fs.existsSync(JSON.parse(r.stdout.split('\n')[1]).service),false);
});
test('an unrelated process and a forged service directory are left alone', () => {
  const external=fs.mkdtempSync('/tmp/naw-service-');
  const sibling=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
  try {
    const r=probe(`fs.writeFileSync(path.join(root,'connection.json'),JSON.stringify({protocol:1,pid:${sibling.pid},endpoint:${JSON.stringify(path.join(external,'desktop.sock'))}}));fs.writeFileSync(path.join(root,'service.lock'),'${sibling.pid}');scratch.ownService(root);Promise.resolve().finally(scratch.cleanup(async()=>{}));`);
    assert.equal(r.status,0,r.stderr);assert.equal(fs.existsSync(r.root),false);assert.equal(fs.existsSync(external),true);assert.doesNotThrow(()=>process.kill(sibling.pid,0));
  } finally { sibling.kill('SIGTERM');fs.rmSync(external,{recursive:true,force:true}); }
});
test('daemon startup failure removes its own temporary socket directory', () => {
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'daemon-failure-'));
  const adapters=path.resolve(__dirname,'../adapters.cjs'),daemon=path.resolve(__dirname,'../daemon.cjs');
  try {
    const r=spawnSync(process.execPath,['-e',`const {NativeHost}=require(${JSON.stringify(adapters)});NativeHost.prototype.start=async function(){console.log(this.privateDir);throw Error('startup fixture');};process.argv[2]=${JSON.stringify(profile)};require(${JSON.stringify(daemon)});`],{encoding:'utf8',timeout:10000});
    assert.equal(r.status,1);const dir=r.stdout.trim();assert.match(path.basename(dir),/^naw-service-/);assert.equal(fs.existsSync(dir),false,r.stderr);
  } finally { fs.rmSync(profile,{recursive:true,force:true}); }
});
test('an unfinished owned daemon is stopped and awaited before profile deletion', () => {
  const daemon=path.resolve(__dirname,'../daemon.cjs');
  const r=probe(`(async()=>{const child=scratch.childProcess.fork(${JSON.stringify(daemon)},[root],{stdio:'ignore',env:{...process.env,NAW_APP_VERSION:'scratch-live',NAW_WORKSPACE:root}});for(let n=0;n<100&&!fs.existsSync(path.join(root,'connection.json'));n++)await new Promise(r=>setTimeout(r,30));scratch.ownService(root);})().finally(scratch.cleanup(async()=>{}));`);
  assert.equal(r.status,0,r.stderr);assert.equal(fs.existsSync(r.root),false);
});

test('descendants of an exited owned PID are never adopted', () => {
  const r=probe(`const cp=require('node:child_process'),original=cp.execFileSync;const outsider=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});const old=scratch.childProcess.spawn(process.execPath,['-e','0'],{stdio:'ignore'});old.once('exit',()=>{cp.execFileSync=(file,args,opts)=>{const value=original(file,args,opts);return file==='/bin/ps'&&args[0]==='-axo'?value+'\\n'+outsider.pid+' '+old.pid+'\\n':value;};Promise.resolve().finally(scratch.cleanup(async()=>{})).then(()=>{let alive=true;try{process.kill(outsider.pid,0);}catch{alive=false;}console.log(JSON.stringify({outsiderAlive:alive}));outsider.kill('SIGTERM');});});`);
  assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout.trim().split('\n').at(-1)).outsiderAlive,true);assert.equal(fs.existsSync(r.root),false);
});
test('a live spawned child with unavailable identity prevents profile deletion', async () => {
  const prelude=`const cp=require('node:child_process'),original=cp.execFileSync;let failNext=false;cp.execFileSync=(file,args,opts)=>{if(failNext&&file==='/bin/ps'&&args.includes('lstart=')){failNext=false;throw Error('identity lookup unavailable');}return original(file,args,opts);};`;
  const r=probe(`failNext=true;const child=scratch.childProcess.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(JSON.stringify({pid:child.pid}));Promise.resolve().finally(scratch.cleanup(async()=>{})).catch(error=>{console.error(error.message);process.exit(1);});`,{prelude});
  const pid=JSON.parse(r.stdout.split('\n')[1]).pid;
  try { assert.equal(r.status,1,r.stderr);assert.equal(fs.existsSync(r.root),true);assert.doesNotThrow(()=>process.kill(pid,0));assert.match(r.stderr,/identity is unconfirmed/); }
  finally { try{process.kill(pid,'SIGKILL');}catch{}for(let n=0;n<100;n++){try{process.kill(pid,0);await new Promise(resolve=>setTimeout(resolve,20));}catch{break;}}fs.rmSync(r.root,{recursive:true,force:true}); }
});
test('process census failure still runs teardown and retains unconfirmed scratch', () => {
  const r=probe(`const cp=require('node:child_process'),original=cp.execFileSync;cp.execFileSync=(file,args,opts)=>{if(file==='/bin/ps'&&args[0]==='-axo')throw Error('census unavailable');return original(file,args,opts);};Promise.resolve().finally(scratch.cleanup(async()=>fs.writeFileSync(path.join(root,'teardown.txt'),'ran'))).catch(error=>{console.error(error.message);process.exitCode=1;});`);
  try{assert.equal(r.status,1,r.stderr);assert.equal(fs.readFileSync(path.join(r.root,'teardown.txt'),'utf8'),'ran');assert.match(r.stderr,/census unavailable/);}finally{fs.rmSync(r.root,{recursive:true,force:true});}
});
test('an owned process exiting between identity check and signal does not fail cleanup', () => {
  const r=probe(`const cp=require('node:child_process'),originalKill=process.kill;const child=scratch.childProcess.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});let raced=false;process.kill=function(pid,signal){if(!raced&&pid===child.pid&&signal==='SIGTERM'){raced=true;originalKill(pid,'SIGTERM');cp.execFileSync('/bin/sleep',['0.1']);const error=Error('process exited before signal');error.code='ESRCH';throw error;}return originalKill(pid,signal);};Promise.resolve().finally(scratch.cleanup(async()=>{})).then(()=>console.log(JSON.stringify({raced}))).catch(error=>{console.error(error.message);process.exitCode=1;});`);
  try{assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout.trim().split('\n').at(-1)).raced,true);assert.equal(fs.existsSync(r.root),false,r.stderr);}
  finally{fs.rmSync(r.root,{recursive:true,force:true});}
});
test('a refused signal still fails cleanup and retains a live owned process profile', () => {
  const r=probe(`const originalKill=process.kill;const child=scratch.childProcess.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(JSON.stringify({pid:child.pid}));process.kill=function(pid,signal){if(pid===child.pid&&signal==='SIGTERM'){const error=Error('signal denied');error.code='EPERM';throw error;}return originalKill(pid,signal);};Promise.resolve().finally(scratch.cleanup(async()=>{})).catch(error=>{console.error(error.message);process.exit(1);});`);
  const pid=JSON.parse(r.stdout.split('\n')[1]).pid;
  try{assert.equal(r.status,1,r.stderr);assert.match(r.stderr,/signal denied/);assert.equal(fs.existsSync(r.root),true);assert.doesNotThrow(()=>process.kill(pid,0));}
  finally{try{process.kill(pid,'SIGKILL');}catch{}fs.rmSync(r.root,{recursive:true,force:true});}
});

test('owned process exit during final identity read does not turn successful teardown into failure', () => {
  const prelude=`const cp=require('node:child_process'),original=cp.execFileSync,kill=process.kill;let target,armed=false,raced=false;cp.execFileSync=(file,args,options)=>{if(armed&&!raced&&file==='/bin/ps'&&args[1]===String(target)&&args.includes('lstart=')){raced=true;kill(target,'SIGKILL');original('/bin/sleep',['0.1']);throw Error('exited during identity lookup');}return original(file,args,options);};`;
  const r=probe(`const child=scratch.childProcess.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});target=child.pid;Promise.resolve().finally(scratch.cleanup(async()=>{armed=true;})).then(()=>console.log(JSON.stringify({raced}))).catch(error=>{console.error(error.message);process.exitCode=1;});`,{prelude});
  try{assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout.trim().split('\n').at(-1)).raced,true);assert.equal(fs.existsSync(r.root),false);}finally{fs.rmSync(r.root,{recursive:true,force:true});}
});
