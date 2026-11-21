const test=require('node:test'),assert=require('node:assert/strict');
const carrier=require('../mobile-carrier.cjs');
function fixture(){
 const host='demo.example.ts.net',status={BackendState:'Running',Self:{DNSName:host+'.',UserID:7},User:{'7':{LoginName:'synthetic-person'}}};
 const serve={TCP:{},Web:{},AllowFunnel:{}};
 for(const [p,target] of [[443,8001],[8443,8780],[10000,48765]]){serve.TCP[p]={HTTPS:true};serve.Web[host+':'+p]={Handlers:{'/':{Proxy:'http://127.0.0.1:'+target}}};}
 return {host,status,serve};
}
test('an exact completed shared-host binding can recover without remembering a confirmation switch',()=>{
 const f=fixture(),entry=carrier.inspect(f.status,f.serve,{sharedHostConfirmed:true}),saved=carrier.binding(entry);
 assert.ok(saved);assert.equal(Object.hasOwn(saved,'sharedHostConfirmed'),false);
 assert.deepEqual(carrier.inspectRestored(f.status,f.serve,saved),entry);
 assert.throws(()=>carrier.inspect(f.status,f.serve),e=>e.code==='MOBILE_SHARED_HOST','A new QR still needs its own confirmation');
 assert.equal(carrier.binding({...entry}),null,'A renderer-supplied lookalike has no detection receipt');
});
test('ordering, empty defaults and ETag do not change the trusted services',()=>{
 const f=fixture(),saved=carrier.binding(carrier.inspect(f.status,f.serve,{sharedHostConfirmed:true}));
 f.serve.ETag='synthetic-new-tag';f.serve.Foreground={};f.serve.Services={};
 f.serve.TCP=Object.fromEntries(Object.entries(f.serve.TCP).reverse());f.serve.Web=Object.fromEntries(Object.entries(f.serve.Web).reverse());
 assert.ok(carrier.inspectRestored(f.status,f.serve,saved));
});
for(const change of ['actor','account-id','origin','mapping','new-service','changed-service','removed-service','foreground','tls-forward','unknown','funnel'])
test('recovery refuses '+change,()=>{
 const f=fixture(),saved=carrier.binding(carrier.inspect(f.status,f.serve,{sharedHostConfirmed:true}));
 if(change==='actor')f.status.User['7'].LoginName='another-person';
 if(change==='account-id'){f.status.Self.UserID=8;f.status.User['8']={LoginName:'synthetic-person'};}
 if(change==='origin'){f.serve.TCP[10001]=f.serve.TCP[10000];delete f.serve.TCP[10000];f.serve.Web[f.host+':10001']=f.serve.Web[f.host+':10000'];delete f.serve.Web[f.host+':10000'];}
 if(change==='mapping')f.serve.Web[f.host+':10000'].Handlers['/'].Proxy='http://127.0.0.1:48766';
 if(change==='new-service'){f.serve.TCP[10443]={HTTPS:true};f.serve.Web[f.host+':10443']={Handlers:{'/':{Proxy:'http://127.0.0.1:8002'}}};}
 if(change==='changed-service')f.serve.Web[f.host+':443'].Handlers['/'].Proxy='http://127.0.0.1:9000';
 if(change==='removed-service'){delete f.serve.TCP[443];delete f.serve.Web[f.host+':443'];}
 if(change==='foreground')f.serve.Foreground={synthetic:{TCP:{'10443':{HTTPS:true}},Web:{[f.host+':10443']:{Handlers:{'/':{Proxy:'http://127.0.0.1:9000'}}}}}};
 if(change==='tls-forward')f.serve.TCP[10443]={TCPForward:'127.0.0.1:9000',TerminateTLS:f.host};
 if(change==='unknown')f.serve.Services={unknown:{}};
 if(change==='funnel')f.serve.AllowFunnel[f.host+':10000']=true;
 assert.throws(()=>carrier.inspectRestored(f.status,f.serve,saved));
});
test('an explicitly accepted unknown topology never creates an automatic recovery binding',()=>{
 const f=fixture();f.serve.Services={unknown:{}};
 const entry=carrier.inspect(f.status,f.serve,{sharedHostConfirmed:true});assert.equal(carrier.binding(entry),null);
 assert.throws(()=>carrier.inspectRestored(f.status,f.serve,null));
});
test('malformed or widened binding records fail closed',()=>{
 const f=fixture(),saved=carrier.binding(carrier.inspect(f.status,f.serve,{sharedHostConfirmed:true}));
 for(const value of [{...saved,sharedHostConfirmed:true},{...saved,version:0},{...saved,topologyHash:'unknown'},null])assert.throws(()=>carrier.inspectRestored(f.status,f.serve,value));
});

test('an imprecise numeric account identity cannot establish automatic recovery proof',()=>{
 const f=fixture();f.status.Self.UserID=Number.MAX_SAFE_INTEGER+1;f.status.User={[String(f.status.Self.UserID)]:{LoginName:'synthetic-person'}};
 assert.equal(carrier.binding(carrier.inspect(f.status,f.serve,{sharedHostConfirmed:true})),null);
});
