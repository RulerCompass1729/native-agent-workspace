const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const filename=require.resolve('../../scripts/install-backend-version.cjs');
function fixture(response, timeout=false) {
  const calls=[],module={exports:{}};
  const localRequire=name=>name==='../app/service-connection.cjs'?{connectService:async(...args)=>{
    calls.push(['connect',...args]);return{call(method){calls.push(['call',method]);return timeout?new Promise(()=>{}):response();},socket:{destroy(){calls.push(['destroy']);}}};
  }}:require(name);
  const run=vm.runInNewContext('(function(require,module){'+fs.readFileSync(filename,'utf8')+'\n})',{process,console,setTimeout,clearTimeout});run(localRequire,module);
  return{read:()=>module.exports.readVersion('/synthetic/backend'),calls};
}
test('version helper uses page:false and only initial, projecting no private payload',async()=>{
  const f=fixture(()=>Promise.resolve({servicePid:333,runtimeVersion:'0.1.0-alpha.999',messages:['private sentinel'],token:'not an output',cookie:'not an output'}));
  const result=await f.read();assert.equal(JSON.stringify(result),JSON.stringify({servicePid:333,runtimeVersion:'0.1.0-alpha.999'}));
  assert.equal(JSON.stringify(f.calls),JSON.stringify([['connect','/synthetic/backend','install-version-check',{page:false}],['call','initial'],['destroy']]));
});
test('invalid version or PID never becomes an attestation and always closes',async()=>{
  for(const state of [{servicePid:0,runtimeVersion:'0.1.0-alpha.999'},{servicePid:333},{servicePid:333,runtimeVersion:'unknown'},{servicePid:333,runtimeVersion:['0.1.0-alpha.999']}]){
    const f=fixture(()=>Promise.resolve(state));await assert.rejects(f.read(),/Version unavailable/);assert.equal(f.calls.at(-1)[0],'destroy');
  }
});
test('read failure closes once without a second request',async()=>{
  const f=fixture(()=>Promise.reject(Error('synthetic unavailable')));await assert.rejects(f.read());assert.equal(f.calls.filter(c=>c[0]==='call').length,1);assert.equal(f.calls.filter(c=>c[0]==='destroy').length,1);
});
test('hung read reaches its fixed deadline and closes without retry',async()=>{
  const f=fixture(null,true);await assert.rejects(f.read(),/Version deadline/);assert.equal(f.calls.filter(c=>c[0]==='call').length,1);assert.equal(f.calls.filter(c=>c[0]==='destroy').length,1);
});
