// Main control flow is real; Electron IPC, listener and carrier reads are local fixtures.
const fs=require('node:fs'),vm=require('node:vm'),carrier=require('../../mobile-carrier.cjs');
async function resume(broker,{entry,status,serve,root}){
 const source=fs.readFileSync(require.resolve('../../main.cjs'),'utf8'),handlers=new Map(),windows=new Map();let listeners=0;
 const human={view:{},win:{webContents:{id:1},isDestroyed:()=>false}};windows.set(1,human);
 const context=vm.createContext({primary:true,quitting:false,mobileOpening:false,mobileGeneration:0,mobileQrRequest:0,mobileListener:null,mobileStopped:Promise.resolve(true),
  fs,path:require('node:path'),dataDir:root,windows,Error,Number,setTimeout,clearTimeout,appMobileBroker:()=>broker,
  uiError:()=>Error('Synthetic mobile recovery refused'),watchAppMobile(){},isCurrentHumanContext:null,
  register:(name,handler)=>handlers.set(name,handler),applicationHandlers:new Map(),
  connectAppMobile(){throw Error('No pairing in recovery fixture');},cancelAppMobileSetup(){},appMobileSetupStatus(){},
  require(name){
   if(name==='./mobile-carrier.cjs')return {...carrier,detect:async options=>carrier.inspect(status,serve,options),detectRestored:async expected=>carrier.inspectRestored(status,serve,expected)};
   if(name==='./mobile-http.cjs')return {createMobileHandler:()=>()=>{}};
   throw Error('Unexpected recovery dependency');
  },
 });
 const evaluate=(from,to)=>{const start=source.indexOf(from);if(start<0||source.indexOf(to,start)<0)throw Error('Missing Main recovery boundary');vm.runInContext(source.slice(start,source.indexOf(to,start)),context);};
 evaluate('function isCurrentHumanContext(', 'function showDialog(');
 evaluate('async function resumeAppMobile(', 'function suspendAppMobile(');
 evaluate('async function detectAppMobile(', 'async function connectAppMobile(');
 const start=source.indexOf('  for (const [name, action] of Object.entries({ mobileDetect:');
 vm.runInContext(source.slice(start,source.indexOf('  for (const [method, name]',start)),context);
 context.startAppMobileListener=async endpoint=>{listeners++;broker.setEndpoint(endpoint);context.mobileListener={ready:true};};
 context.stopAppMobileListener=()=>{context.mobileListener=null;};
 if(entry==='boot')await context.resumeAppMobileOnBoot();else await handlers.get('mobileResume')(human,{sharedHostConfirmed:true});
 return listeners;
}
module.exports={resume};
