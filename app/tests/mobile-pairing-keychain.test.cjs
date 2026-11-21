const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {keychainAdapter}=require('../mobile-pairing-store.cjs');
test('Keychain adapter uses only a fixed helper and bounded private pipes, not argv or inherited environment',async()=>{
 const calls=[],adapter=keychainAdapter({platform:'darwin',run(bin,args,options,done){calls.push({bin,args,options});queueMicrotask(()=>done(null,JSON.stringify({value:null})));return {stdin:{end(){}}};}});
 const value={synthetic:'private fixture value'};await adapter.put('a'.repeat(64),value);assert.equal(await adapter.get('a'.repeat(64)),null);
 assert.equal(calls.length,2);for(const c of calls){assert.equal(c.bin,'/usr/bin/osascript');assert.equal(c.args.length,3);assert.equal(c.args.at(-1),path.join(__dirname,'../mobile-pairing-keychain.jxa'));assert.equal(c.options.timeout,5000);assert.equal(c.options.maxBuffer,512*1024);assert.deepEqual(Object.keys(c.options.env).sort(),['LANG','PATH']);assert.equal(c.args.join(' ').includes(value.synthetic),false);}
 assert.deepEqual(JSON.parse(calls[0].options.input),{action:'put',account:'a'.repeat(64),value});
});
test('unsupported platforms, oversized input and unknown Keychain responses fail closed without fallback',async()=>{
 let calls=0;const run=(_b,_a,_o,done)=>{calls++;queueMicrotask(()=>done(null,JSON.stringify({value:null,extra:true})));return {stdin:{end(){}}};};
 await assert.rejects(()=>keychainAdapter({platform:'linux',run}).get('a'.repeat(64)));assert.equal(calls,0);
 const adapter=keychainAdapter({platform:'darwin',run});await assert.rejects(()=>adapter.get('Z'.repeat(64)));await assert.rejects(()=>adapter.put('a'.repeat(64),'x'.repeat(512*1024)));assert.equal(calls,0);
 await assert.rejects(()=>adapter.get('a'.repeat(64)));assert.equal(calls,1);
});
function helper({mode='get',status=0,update=0,add=0}={}){
 const calls=[],source=fs.readFileSync(path.join(__dirname,'../mobile-pairing-keychain.jxa'),'utf8'),store=JSON.stringify({synthetic:true});
 const dictionary=()=>({values:{},setObjectForKey(v,k){this.values[k]=v&&Object.hasOwn(v,'value')?v.value:v;}});
 const $=value=>({value,dataUsingEncoding:()=>value});
 Object.assign($,{NSFileHandle:{fileHandleWithStandardInput:{readDataToEndOfFile:{length:10}}},NSString:{alloc:{initWithDataEncoding(data){return {js:typeof data==='string'?data:JSON.stringify({action:mode,account:'a'.repeat(64),...(mode==='put'?{value:{synthetic:true}}:{})})};}}},NSMutableDictionary:{alloc:{init:dictionary()}},
  SecKeychainSetUserInteractionAllowed(value){calls.push(['interaction',value]);return 0;},
  SecItemCopyMatching(q,r){calls.push(['get',structuredClone(q.values)]);r[0]={length:store.length,toString:()=>store};return status;},
  SecItemUpdate(q,a){calls.push(['update',structuredClone(q.values),structuredClone(a.values)]);return update;},SecItemAdd(q){calls.push(['add',structuredClone(q.values)]);return add;}});
 Object.defineProperty($.NSMutableDictionary.alloc,'init',{get:dictionary});
 for(const k of ['kSecClassGenericPassword','kSecClass','kSecAttrService','kSecAttrAccount','kSecAttrSynchronizable','kSecUseAuthenticationUIFail','kSecUseAuthenticationUI','kSecValueData','kSecReturnData','kSecMatchLimitOne','kSecMatchLimit'])$[k]=k;
 $.kCFBooleanTrue=true;$.kCFBooleanFalse=false;
 const ObjC={import(){},wrap:()=>store},context=vm.createContext({$,ObjC,Ref:()=>({}),JSON,Error,Number});
 vm.runInContext(source,context);return {run:()=>context.run(),calls};
}
test('native-helper contract suppresses interaction and sync, and distinguishes not-found from access denial',()=>{
 const absent=helper({status:-25300});assert.deepEqual(JSON.parse(absent.run()),{value:null});assert.deepEqual(absent.calls[0],['interaction',false]);
 const q=absent.calls[1][1];assert.equal(q.kSecAttrSynchronizable,false);assert.equal(q.kSecUseAuthenticationUI,'kSecUseAuthenticationUIFail');
 const denied=helper({status:-25308});assert.throws(()=>denied.run());assert.equal(denied.calls.length,2);
});
test('native-helper contract adds only on exact not-found and rejects failed add/update',()=>{
 const found=helper({mode:'put'});found.run();assert.equal(found.calls.some(c=>c[0]==='add'),false);
 const absent=helper({mode:'put',update:-25300});absent.run();assert.equal(absent.calls.filter(c=>c[0]==='add').length,1);
 assert.throws(()=>helper({mode:'put',update:-25308}).run());assert.throws(()=>helper({mode:'put',update:-25300,add:-1}).run());
});
