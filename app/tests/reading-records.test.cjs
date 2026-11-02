const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');const {Workspace}=require('../workspace.cjs');
async function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'naw-reading-records-')),runtimes=[];const w=new Workspace({binaries:{},close(){},create(s){const r=new EventEmitter();s.nativeId='synthetic-'+s.id;r.start=async()=>r.emit('state','idle');r.send=async(text,tag)=>{r.emit('submitted',tag);r.emit('replyBound',{tag,nativeId:s.nativeId,turnId:'accepted-turn',promptId:'accepted-prompt'});};r.queueAvailable=r.steerAvailable=true;r.queue=r.steer=async()=>{};r.finishTurn=()=>{};runtimes.push(r);return r;}},dir);t.after(()=>{w.close();fs.rmSync(dir,{recursive:true,force:true});});const a=await w.create('claude',dir,'owner','A'),b=await w.create('codex',dir,'owner','B');return{w,dir,a,b,runtimes};}
test('new live sends, queued/steered and terminal inputs retain their recorded time after persistence',async t=>{
 const {w,dir,a,b,runtimes:[ra,rb]}=await fixture(t),before=Date.now();await w.send(a,'Ordinary input','owner');w.get(a).state='working';await w.queue(a,'Queued input','owner');w.get(b).state='working';rb.turnId='current';await w.steer(b,'Steered input','owner','current');ra.emit('nativeInput','Native input',{id:'native-input'});
 const rows=[...w.get(a).messages,...w.get(b).messages].filter(m=>m.role==='user');assert.equal(rows.length,4);for(const row of rows)assert.ok(Number.isFinite(row.time)&&row.time>=before&&row.time<=Date.now());
 w.get(a).messages.push({id:'old-no-time',role:'user',text:'History without time'});w.persist();const stored=JSON.parse(fs.readFileSync(path.join(dir,'workspace.json')));const saved=stored.sessions.flatMap(s=>s.messages);for(const row of rows)assert.equal(saved.find(m=>m.id===row.id).time,row.time);assert.equal(saved.find(m=>m.id==='old-no-time').time,undefined);
});
test('accepted input identities annotate only the exact existing user row and grant no sharing',async t=>{
 const {w,a,runtimes:[r]}=await fixture(t);await w.send(a,'Input','owner');const s=w.get(a),input=s.messages.find(m=>m.role==='user');assert.equal(input.nativeId,s.nativeId);assert.equal(input.turnId,'accepted-turn');assert.equal(w.sharedReplies.grants.size,0);assert.equal(w.room.messages.length,0);
 const snapshot=JSON.stringify(input);for(const receipt of [{tag:input.id,nativeId:'foreign',turnId:'other'},{tag:'unknown',nativeId:s.nativeId,turnId:'other'},{tag:input.id,nativeId:s.nativeId,turnId:'changed'}])r.emit('replyBound',receipt);assert.equal(JSON.stringify(input),snapshot);
});
test('a native turn start links only its own terminal inputs and ! rows, never moves a row and grants no sharing',async t=>{
 const {w,a,runtimes:[r]}=await fixture(t),s=w.get(a),pid='11111111-1111-4111-8111-111111111111',shell='tool:shell-22222222-2222-4222-8222-222222222222';
 r.emit('nativeInput','typed in the terminal',{id:`claude-prompt-${pid}`});
 r.emit('nativeBlock',{id:shell,nativeId:s.nativeId,kind:'tool',title:'Bash',input:'git status',text:'clean',status:'complete',toolKind:'commandExecution',commandSource:'userShell'});
 await w.send(a,'From the app','owner');const app=s.messages.find(m=>m.role==='user'&&m.origin!=='native');
 const typed=s.messages.find(m=>m.id===`claude-prompt-${pid}`),row=s.messages.find(m=>m.id===`native:${s.nativeId}:${shell}`);
 assert.equal(typed.turnId,undefined);assert.equal(row.turnId,undefined);
 r.emit('nativeTurnTriggers',{nativeId:'foreign',turnId:'other',prompts:[pid],rows:[shell]});assert.equal(typed.turnId,undefined);assert.equal(row.turnId,undefined);
 // A row that only carries the prompt-shaped id (no native origin) is not a terminal input.
 const lookalike={id:'claude-prompt-33333333-3333-4333-8333-333333333333',role:'user',text:'restored history',status:'complete'};s.messages.push(lookalike);
 r.emit('nativeTurnTriggers',{nativeId:s.nativeId,turnId:'typed-turn',prompts:[pid,'33333333-3333-4333-8333-333333333333'],rows:[shell]});
 assert.equal(lookalike.turnId,undefined);assert.equal(lookalike.nativeId,undefined);
 assert.deepEqual([typed.nativeId,typed.turnId,row.turnId],[s.nativeId,'typed-turn','typed-turn']);
 // A later or replayed claim never moves a linked row, nor links an app input.
 r.emit('nativeTurnTriggers',{nativeId:s.nativeId,turnId:'later-turn',prompts:[pid,app.id.replace(/^claude-prompt-/,'')],rows:[shell]});
 assert.deepEqual([typed.turnId,row.turnId,app.turnId],['typed-turn','typed-turn','accepted-turn']);
 assert.equal(w.sharedReplies.grants.size,0);assert.equal(w.room.messages.length,0);
});
test('a typed prompt whose row lands after its turn start is still linked once it arrives',async t=>{
 const {w,a,runtimes:[r]}=await fixture(t),s=w.get(a),pid='44444444-4444-4444-8444-444444444444';
 r.emit('nativeTurnTriggers',{nativeId:s.nativeId,turnId:'late-turn',prompts:[pid],rows:[]});
 r.emit('nativeInput','typed before the hook arrived',{id:`claude-prompt-${pid}`});
 await new Promise(resolve=>setImmediate(resolve));
 const typed=s.messages.find(m=>m.id===`claude-prompt-${pid}`);assert.deepEqual([typed.nativeId,typed.turnId],[s.nativeId,'late-turn']);
 // Consumed once: a second input with the same id is not linked again.
 r.emit('nativeInput','again',{id:'claude-prompt-55555555-5555-4555-8555-555555555555'});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(s.messages.find(m=>m.id==='claude-prompt-55555555-5555-4555-8555-555555555555').turnId,undefined);
});
