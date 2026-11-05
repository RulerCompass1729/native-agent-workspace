const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { OperatorControl } = require('../operator-control.cjs');
function fixture(t) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'naw-operator-metadata-'));t.after(()=>fs.rmSync(dir,{recursive:true}));
 const source={id:'source',nativeId:'native-source',provider:'claude',name:'Initiator',state:'working'};
 const target={id:'target',nativeId:'native-target',provider:'claude',name:'Executor',state:'working',messages:[{text:'PRIVATE_NATIVE_BODY'}],liveDraft:'PRIVATE_UNSENT_DRAFT'};
 const root={operatorAvailable:true,liveTurn:{id:'source-turn',promptId:'source-prompt'}},runtime={operatorAvailable:true};
 const w={dataDir:dir,sessions:new Map([[source.id,source],[target.id,target]]),runtimes:new Map([[source.id,root],[target.id,runtime]]),get(id){return this.sessions.get(id)},emit(){},create(){assert.fail('Metadata must not allocate a session')},input(){assert.fail('Metadata must not submit input')}};
 const op=new OperatorControl(w);op.settings(null,true);op.settings(source.id,true);
 return {w,op,source,target,runtime,async read(){return op.call(source,root,{nativeId:source.nativeId,turnId:'source-turn',promptId:'source-prompt',callId:'metadata-read'},'workspace_sessions',{})}};
}
for(const [name,flags,record,remove] of [
 ['live',{},{}], ['transport disconnected',{transportDisconnected:true},{}], ['confirmed backend exit',{backendExitConfirmed:true},{}],
 ['stopped runtime',{stopped:true},{}], ['disposed runtime',{disposed:true},{}], ['retained reader',{retainedReader:true},{}], ['root ending',{rootEnding:true},{}],
 ['native context pending',{}, {nativeContextPending:true}], ['record disconnected',{}, {transportDisconnected:true}], ['runtime missing',{}, {},true]
])test('local operator metadata remains truthful: '+name,async t=>{
 const f=fixture(t);Object.assign(f.runtime,flags);Object.assign(f.target,record);if(remove)f.w.runtimes.delete(f.target.id);
 const before=structuredClone(f.target),value=await f.read(),actual=value.sessions.find(s=>s.id===f.target.id),live=name==='live';
 assert.equal(actual.state,live||name==='retained reader'||name==='root ending'?'working':'unknown');assert.equal(actual.canReport,live);
 assert.deepEqual(Object.keys(actual).sort(),['id','name','provider','state','canReport'].sort());assert.doesNotMatch(JSON.stringify(value),/PRIVATE_NATIVE_BODY|PRIVATE_UNSENT_DRAFT/);assert.deepEqual(f.target,before);
 const snapshot=f.op.decorate({sessions:[f.target],rooms:[],room:{id:'shared',messages:[]}});assert.equal(snapshot.sessions[0].operatorAvailable,live,'Published capability uses the same current connection proof');
 const receipt=f.op.openResult({status:'created',sessionId:f.target.id,args:{provider:'claude'},key:'test',id:'action'});assert.equal(receipt.canReport,live,'Idempotent creation receipt uses the same current capability');
});

test('remote declared capability cannot override disconnected or pending metadata',async t=>{
 const f=fixture(t),registry=path.join(f.w.dataDir,'registry');fs.mkdirSync(registry,{mode:0o700});let closed=0,calls=0;
 f.w.peerRunner={root:()=>registry,connect:async()=>({call:async method=>{assert.equal(method,'initial');calls++;return {sessions:[{...f.target,id:'remote',operatorAvailable:true,transportDisconnected:true},{...f.target,id:'pending',operatorAvailable:true,nativeContextPending:true},{...f.target,id:'live-remote',operatorAvailable:true}]}},close(){closed++;}})};
 const value=await f.read();for(const id of ['remote','pending'])assert.deepEqual(value.sessions.find(s=>s.id===id),{id,name:'Executor',provider:'claude',state:'unknown',canReport:false});
 assert.equal(value.sessions.find(s=>s.id==='live-remote').canReport,true);assert.equal(value.sessions.find(s=>s.id==='live-remote').state,'working');assert.equal(closed,1);assert.equal(calls,1);assert.doesNotMatch(JSON.stringify(value),/PRIVATE_NATIVE_BODY|PRIVATE_UNSENT_DRAFT/);
});
