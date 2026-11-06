// Add one existing background-observation event to the owned transport fixture.
// This never creates real native jobs, processes or model responses.
require('./loading-terminal.cjs');
const path=require('node:path');
const root=process.env.NAW_TEST_APP_ROOT||path.resolve(__dirname,'../..');
const {NativeHost}=require(path.join(root,'app/adapters.cjs'));
const {Workspace}=require(path.join(root,'app/workspace.cjs'));
const {withMembership}=require(path.join(root,'app/collaboration-spaces.cjs'));
let workspace;
const createSession=Workspace.prototype.create;
Workspace.prototype.create=function(...args){workspace=this;return createSession.apply(this,args);};
const create=NativeHost.prototype.create,runtimes=new Map();
NativeHost.prototype.create=function(record){const runtime=create.call(this,record);runtimes.set(record.id,runtime);return runtime;};
process.prependListener('message',request=>{
  // Existing legacy membership vectors remain readable. Current GUI join moves
  // a session, so seed this old record explicitly rather than inventing a join.
  if(request.method==='density-legacy-membership'){
    const record=workspace.get(request.target);
    Object.assign(record,withMembership(record,request.value,true));
    workspace.changed();return;
  }
  if(request.method!=='density-background')return;
  const runtime=runtimes.get(request.target);
  if(!runtime)throw Error('Unknown synthetic background target');
  const {count,scheduled,kinds,ids}=request.value;
  runtime.emit('background',{count,scheduled,kinds,ids});
});
