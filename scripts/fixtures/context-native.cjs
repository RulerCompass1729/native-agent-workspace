// Controlled transport for actual UI context-transition checks. No native/model process.
const path=require('node:path'),{EventEmitter}=require('node:events'),{randomUUID}=require('node:crypto');
const root=process.env.NAW_TEST_APP_ROOT||path.resolve(__dirname,'../..');
const {NativeHost,Claude}=require(path.join(root,'app/adapters.cjs'));
const {SubmissionChannel}=require(path.join(root,'app/claude-submit.cjs'));
const runtimes=new Map(),sends=[];let held;
NativeHost.prototype.start=async function(){this.binaries={claude:'fixture',codex:'fixture'}};
NativeHost.prototype.close=function(){};
NativeHost.prototype.create=function(record){
 const r=Object.create(Claude.prototype);EventEmitter.call(r);r.record=record;r.ready=true;r.pending=null;r.submission=new SubmissionChannel();
 r.submission.on('change',()=>{r.chatAvailable=r.submission.connected;r.emit('capability')});r.chatAvailable=true;
 r.terminal={alive:true,pid:12345,resize(){},input(){},snapshot:async()=>({buffer:'CONTROLLED CONTEXT TRANSPORT\r\n',sequence:0,cols:100,rows:30})};
 r.start=async()=>r.emit('state','idle');r.openTerminal=async()=>r.terminal;r.stop=async()=>{r.terminal.alive=false;return {state:'ended'}};
 r.send=async(text,tag,guard)=>{if(!guard())throw Error('Revoked');sends.push({id:record.id,text,tag});
  if(held)await new Promise((resolve,reject)=>{held={resolve,reject}});
  r.emit('submitted',tag);
 };
 runtimes.set(record.id,r);return r;
};
process.on('message',q=>{
 try{
  const r=runtimes.get(q.target);
  if(q.method==='hold')held=true;
  if(q.method==='resolve'){const p=held;held=null;p.resolve()}
  if(q.method==='reject'){const p=held;held=null;p.reject(Error('Controlled delayed failure'))}
  if(q.method==='clear'){
   const sessionId=r.record.nativeId,lease=r.bindRoot({sessionId}).lease;
   r.hook({session_id:sessionId,hook_event_name:'SessionEnd',reason:'clear'});
   r.endRoot({sessionId,lease,reason:'clear'});
   const nextSessionId=randomUUID();r.clearRoot({sessionId,lease,nextSessionId,source:'clear'});
   r.chatAvailable=true;r.emit('capability');
  }
  if(q.method==='branch'){
   const sessionId=r.record.nativeId,lease=r.bindRoot({sessionId}).lease;
   r.hook({session_id:sessionId,hook_event_name:'SessionEnd',reason:'resume'});
   r.endRoot({sessionId,lease,reason:'resume'});
   const nextSessionId=randomUUID();r.hook({session_id:nextSessionId,hook_event_name:'SessionStart',source:'fork'});
   r.clearRoot({sessionId,lease,nextSessionId,source:'fork'});
   r.chatAvailable=true;r.emit('capability');
  }
  if(q.method==='reply')r.hook({session_id:r.record.nativeId,hook_event_name:'Stop',prompt_id:randomUUID(),last_assistant_message:q.text});
  process.send({requestId:q.id,sends,modelCalls:0,nativeProcesses:0});
 }catch(error){process.send({requestId:q.id,error:error.message})}
});
