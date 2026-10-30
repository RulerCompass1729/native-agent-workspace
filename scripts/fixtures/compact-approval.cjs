// Existing synthetic host/daemon transport, with explicit native-only requests.
require('./collaboration-overview.cjs');
const path=require('node:path'),root=process.env.NAW_TEST_APP_ROOT||path.resolve(__dirname,'../..');
const {NativeHost}=require(path.join(root,'app/adapters.cjs'));const create=NativeHost.prototype.create,runtimes=new Map(),opens=[];
NativeHost.prototype.create=function(record){const r=create.call(this,record);runtimes.set(record.id,r);const open=r.openTerminal;r.openTerminal=async function(...args){opens.push(record.id);return open.apply(this,args);};return r;};
process.prependListener('message',packet=>{
 if(packet.method!=='nativeOnlyApproval')return;
 const r=runtimes.get(packet.target);if(!r)return;
 r.nativeApproval=packet.value?.approval||null;
 r.emit('state',packet.value?.state||'approval');
});

const send=process.send;process.send=function(packet,...args){if(packet?.stats)packet.approvalOpens=[...opens];return send.call(this,packet,...args);};
