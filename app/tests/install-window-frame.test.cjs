const test=require('node:test'),assert=require('node:assert/strict');
const gate=require('../../scripts/check-install-state.cjs');
const pid=424242,basis='native-window-frame-v1';
const views=[{bounds:{x:285,y:160,width:1904,height:1042}},{bounds:{x:660,y:295,width:1240,height:850}}];
function rows(){return[
  {pid,id:1,onScreen:true,bounds:{x:297,y:168,width:1867,height:1022},frame:{...views[0].bounds},frameBasis:basis},
  {pid,id:2,onScreen:true,bounds:{x:672,y:303,width:1216,height:834},frame:{...views[1].bounds},frameBasis:basis},
];}
test('G two-window oracle: CG rectangles alone reproduce the old mismatch',()=>{assert.equal(gate.geometry(views,rows()),false);});
test('G two-window oracle: verified native frame passes and CG remains observation data',()=>{
  const result=gate.projectWindows(rows(),pid);assert.equal(gate.geometry(views,result),true);assert.deepEqual(result[0].cgBounds,rows()[0].bounds);assert.deepEqual(result[0].bounds,views[0].bounds);
});
test('G oracle with a genuine 2px frame displacement still refuses',()=>{
  const input=rows();input[0].frame.x+=2;const result=gate.projectWindows(input,pid);assert.equal(result[0].bounds.x,views[0].bounds.x+2);assert.equal(gate.geometry(views,result),false);
});
for(const name of ['missing frame','unknown basis','wrong GUI PID','duplicate window ID'])test('native frame refuses '+name,()=>{
  const input=rows();if(name==='missing frame')delete input[0].frame;
  if(name==='unknown basis')input[0].frameBasis='unknown';
  if(name==='wrong GUI PID')input[0].pid++;
  if(name==='duplicate window ID')input[1].id=input[0].id;
  assert.throws(()=>gate.projectWindows(input,pid));
});
test('invalid native window ID still refuses',()=>{const input=rows();input[0].id='1';assert.throws(()=>gate.projectWindows(input,pid));});
test('external native bridge fault matrix refuses missing symbols, nonzero status and identity changes',()=>{
  const path=require('node:path'),{spawnSync}=require('node:child_process');
  const result=spawnSync('/usr/bin/python3',['-I','-B',path.join(__dirname,'../../scripts/fixtures/test-install-window-frames.py')],{encoding:'utf8',timeout:5000});
  assert.equal(result.status,0,result.stdout+result.stderr);console.log(result.stdout);
});
