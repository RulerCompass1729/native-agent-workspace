const path = require('node:path'), { randomUUID } = require('node:crypto');
const root = process.env.NAW_TEST_APP_ROOT;
require(path.join(root, 'scripts/fixtures/daily-native.cjs'));
const { NativeHost, Claude } = require(path.join(root, 'app/adapters.cjs'));
const { Workspace } = require(path.join(root, 'app/workspace.cjs'));
const native = require(path.join(root, 'app/background-control-native.cjs'));
const { ScopedOutboxRuntime } = require(path.join(root, 'app/scoped-outbox-runtime.cjs'));
const request = ScopedOutboxRuntime.prototype.request;
let inputGate;
ScopedOutboxRuntime.prototype.request = async function(client, action, value, notify) {
 const result = await request.call(this, client, action, value, notify);
 if (action === 'controlCall' && inputGate && result.ok) {
  inputGate.entered = true; await new Promise(resolve => { inputGate.release = resolve; }); inputGate = null;
 }
 return result;
};
const create = NativeHost.prototype.create, bind = Workspace.prototype.bind, sessions = new Map();
NativeHost.prototype.create = function(record) {
 if (record.provider !== 'claude') return create.call(this,record);
 const r = new Claude(record,this,{attachOnly:true}); record.nativeId=randomUUID();
 r.terminal={alive:true,input(){},resize(){},snapshot:async()=>({buffer:'SYNTHETIC ROOT',sequence:0,cols:80,rows:24})};
 r.start=async()=>{
  r.binding={sessionId:record.nativeId,...r.bindRoot({sessionId:record.nativeId,nativeBlocks:true})};
  r.observeRoot({...r.binding,epoch:r.observationEpoch,sequence:1,block:true,id:'control:turn-start',kind:'control',status:'running',turnId:'owned-turn',promptId:'owned-prompt'});
  r.chatAvailable=true;r.queueAvailable=true;r.emit('state','working');r.emit('capability');
 };
 r.openTerminal=async()=>r.terminal;r.stop=async()=>{r.stopped=true;r.terminal.alive=false;};return r;
};
Workspace.prototype.bind=function(s,r){bind.call(this,s,r);sessions.set(s.id,{s,r});};
process.on('message',req=>{
 if(req.method==='p0b-arm-input'){inputGate={entered:false};process.send({p0bRequestId:req.id});return;}
 if(req.method==='p0b-input-status'){process.send({p0bRequestId:req.id,entered:inputGate?.entered===true});return;}
 if(req.method==='p0b-release-input'){inputGate?.release?.();process.send({p0bRequestId:req.id});return;}
 if(!['p0b-proof','p0b-invalidate'].includes(req.method))return;
 if(req.method==='p0b-invalidate'){const {r}=sessions.get(req.target);r.displayGap=true;process.send({p0bRequestId:req.id});return;}
 try {
  const {r,s}=sessions.get(req.target), call=native.rootCall(r,{...r.binding,epoch:r.observationEpoch,turnId:r.turnId,promptId:r.liveTurn.promptId,callId:randomUUID(),arguments:req.value},new AbortController().signal,()=>true);
  process.send({p0bRequestId:req.id,identity:call.identity,before:{control:s.controlRevision,peer:s.peerRevision,turn:r.turnId}});
 } catch(e){process.send({p0bRequestId:req.id,error:e.message});}
});
