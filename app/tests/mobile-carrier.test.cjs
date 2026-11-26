const test=require('node:test'),assert=require('node:assert/strict');
const load=()=>require('../mobile-carrier.cjs');
function state(){return {status:{BackendState:'Running',Self:{DNSName:'demo.example.ts.net.',UserID:7},User:{'7':{LoginName:'synthetic-person'}}},serve:{TCP:{'10000':{HTTPS:true}},Web:{'demo.example.ts.net:10000':{Handlers:{'/':{Proxy:'http://127.0.0.1:48765'}}}},AllowFunnel:{}}};}
test('canonical executable validation preserves the existing CLI entry rather than launching a GUI bundle',()=>{const {findExecutable}=load();const found=findExecutable({realpathSync:()=>'/Applications/Tailscale.app/Contents/MacOS/Tailscale',statSync:()=>({isFile:()=>true,mode:0o755,uid:0})});assert.equal(found,'/opt/homebrew/bin/tailscale');});
test('carrier executes only bounded read-only commands with a clean environment',async()=>{const {detect}=load(),f=state(),calls=[];const r=await detect({port:48765},{executable:()=>'/synthetic/tailscale',run(program,args,options,cb){calls.push(args);assert.equal(program,'/synthetic/tailscale');assert.equal(options.timeout,4000);assert.deepEqual(Object.keys(options.env).sort(),['LANG','PATH']);cb(null,JSON.stringify(args[0]==='status'?f.status:f.serve));}});assert.equal(r.port,48765);assert.deepEqual(calls,[['status','--json'],['serve','status','--json']]);});
test('carrier detects only the exact existing private mapping and native login, without mutation',()=>{const f=state(),before=JSON.stringify(f);const r=load().inspect(f.status,f.serve,{port:48765});assert.equal(r.origin,'https://demo.example.ts.net:10000');assert.equal(r.actor,'synthetic-person');assert.equal(r.port,48765);assert.equal(JSON.stringify(f),before);});
test('carrier refuses wrong identity, public funnel, ambiguity, unsafe upstream and mapped port changes',()=>{const {inspect}=load();for(const mutate of [f=>{f.status.Self.UserID=8},f=>{f.status.BackendState='Stopped'},f=>{f.serve.AllowFunnel['demo.example.ts.net:10000']=true},f=>{f.serve.Web['demo.example.ts.net:10000'].Handlers['/'].Proxy='http://localhost:48765'},f=>{f.serve.Web['demo.example.ts.net:10000'].Handlers['/'].Proxy='http://127.0.0.1:7301'},f=>{f.serve.Web['demo.example.ts.net:10001']=f.serve.Web['demo.example.ts.net:10000'];f.serve.TCP['10001']={HTTPS:true}}]){const f=state();mutate(f);assert.throws(()=>inspect(f.status,f.serve,{port:48765}));}});
test('other services on the hostname require an explicit exception rather than a fabricated carrier check',()=>{const f=state();f.serve.Web['demo.example.ts.net:443']={Handlers:{'/':{Proxy:'http://127.0.0.1:7301'}}};assert.throws(()=>load().inspect(f.status,f.serve,{port:48765}),e=>e.code==='MOBILE_SHARED_HOST');assert.equal(load().inspect(f.status,f.serve,{port:48765,sharedHostConfirmed:true}).actor,'synthetic-person');});
test('TLS forwarding and foreground services require a fresh shared-host exception',()=>{
  for(const mutate of [
    f=>{f.serve.TCP[443]={TCPForward:'127.0.0.1:7301',TerminateTLS:'demo.example.ts.net'};},
    f=>{f.serve.Foreground={synthetic:{TCP:{443:{HTTPS:true}},Web:{'demo.example.ts.net:443':{Handlers:{'/':{Proxy:'http://127.0.0.1:7301'}}}}}};},
    f=>{f.serve.Foreground={synthetic:{TCP:{443:{TCPForward:'127.0.0.1:7301',TerminateTLS:'demo.example.ts.net'}}}};},
    f=>{f.serve.TCP[8443]={TCPForward:'127.0.0.1:7301'};}
  ]){
    const f=state();mutate(f);const before=JSON.stringify(f);
    assert.throws(()=>load().inspect(f.status,f.serve,{port:48765}),e=>e.code==='MOBILE_SHARED_HOST');
    assert.equal(load().inspect(f.status,f.serve,{port:48765,sharedHostConfirmed:true}).port,48765);
    assert.throws(()=>load().inspect(f.status,f.serve,{port:48765}),e=>e.code==='MOBILE_SHARED_HOST');
    assert.equal(JSON.stringify(f),before);
  }
});
test('unverifiable foreground configuration and duplicate entry ownership fail closed even with an exception',()=>{
  for(const mutate of [f=>{f.serve.Foreground={bad:null}},f=>{f.serve.Foreground=[]},f=>{f.serve.Foreground={nested:{Foreground:{}}}},f=>{f.serve.Foreground={duplicate:{TCP:f.serve.TCP,Web:f.serve.Web}}},f=>{f.serve.Foreground={shadow:{TCP:f.serve.TCP,Web:{'demo.example.ts.net:10000':{Handlers:{'/':{Proxy:'http://127.0.0.1:7301'}}}}}};},f=>{f.serve.Foreground={funnel:{AllowFunnel:{'demo.example.ts.net:10000':true}}};}]){
    const f=state();mutate(f);assert.throws(()=>load().inspect(f.status,f.serve,{port:48765,sharedHostConfirmed:true}));
  }
  const f=state();f.serve.TCP[443]={TCPForward:'127.0.0.1:7301',TerminateTLS:'other.example.ts.net'};
  assert.equal(load().inspect(f.status,f.serve,{port:48765}).port,48765,'another exact TLS SNI does not share this cookie host');
});

test('shared-host error includes only structured other ports and keeps its original trust predicate',()=>{const f=state();for(const p of [443,8443]){f.serve.TCP[p]={HTTPS:true};f.serve.Web['demo.example.ts.net:'+p]={Handlers:{'/':{Proxy:'http://127.0.0.1:7301'}}};}assert.throws(()=>load().inspect(f.status,f.serve),e=>{assert.equal(e.code,'MOBILE_SHARED_HOST');assert.deepEqual(e.otherPorts,[443,8443]);assert.ok(!JSON.stringify(e.otherPorts).includes('demo'));return true;});assert.equal(load().inspect(f.status,f.serve,{sharedHostConfirmed:true}).port,48765);});
