const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const root=process.env.NAW_TEST_APP_ROOT||path.resolve(__dirname,'../..'), q=require(path.join(root,'app/queue-dispatch.cjs')), board=require(path.join(root,'app/renderer/task-board.js')), locale=require(path.join(root,'app/ui-locale.js')), {fixture}=require(path.join(root,'app/tests/fixtures/task-board-dom.cjs'));
const now=1800000000000;
function scenario(mode){
 const item={id:'task',text:'Synthetic bounded task',status:'sent',sentTo:'member',sentNative:'synthetic-native',sentAt:now-30000,tag:'dispatch',control:0,createdAt:now-31000};
 const messages=[{id:'dispatch',role:'user',text:'Synthetic dispatch',origin:'naw-dispatch',dispatchItem:item.id,dispatchPurpose:{kind:'queue',itemId:item.id,nativeId:item.sentNative,epoch:null},status:'submitted',time:now-30000}];
 if(mode==='human')messages.push({id:'human',role:'user',text:'Synthetic follow-up',origin:'human',time:now-20000});
 messages.push({id:'decision',role:'assistant',text:'需要你决定：是否继续这个合成任务？',time:now-10000});
 const s={id:'member',name:'Synthetic member',provider:'claude',nativeId:'synthetic-native',state:'idle',roomIds:['space'],roomId:'space',createdAt:now-100000,background:0,scheduled:0,backgroundStale:false,chatAvailable:true,liveDraft:'',controlRevision:mode==='control'?1:0,draftRevision:0,placementRevision:0,serviceCapabilities:[q.CAPABILITY],fleet:[],messages};
 const room={id:'space',name:'Synthetic space',queue:[item]};
 const actions=q.planDispatch({rooms:[room],sessions:[s],wakePolicy:{enabled:true},idleSince:new Map([[s.id,now-60000]]),now});
 const settle=actions.find(a=>a.kind==='settle');assert.ok(settle,'real production settle reached');
 Object.assign(item,{status:settle.status,...(settle.reason?{reason:settle.reason}:{}),reply:settle.reply});
 const input={rooms:[room],sessions:[s],connected:true,confirmationsAvailable:true,confirmations:[]};
 const projection=board.overview(input,now);const rows=projection.groups.flatMap(g=>g.all);
 return {settle,input,rows};
}
test('positive control: an unchanged untouched explicit decision stays waiting',()=>{const x=scenario('none'); assert.equal(x.settle.status,'waiting');assert.equal(x.settle.reason,undefined);assert.equal(x.rows[0].kind,'waiting');});
for(const mode of ['human','control'])for(const language of ['zh','en'])test(mode+' '+language+': a real outstanding decision must not promise that no reply is requested',()=>{
 const x=scenario(mode);assert.equal(x.settle.status,'waiting');assert.equal(x.settle.reason,'person-intervened');assert.ok(q.startsWithDecision(x.settle.reply));assert.equal(x.rows.length,1);assert.equal(x.rows[0].kind,'review');
 const f=fixture();let b=board.bind({host:f.host,document:f.doc,text:(k,p)=>locale.format(language,k,p),now:()=>now,onQueue:()=>{}});
 try {b.update(x.input);b.open();
  // The board has no state help since R250 (11-25): the row itself must still say the person is needed.
  const head=f.host.querySelector('.task-board-group');assert.equal(head.dataset.groupKey,'waiting');
  const entry=f.host.querySelector('.task-board-entry');assert.equal(entry.dataset.itemId,'task');assert.equal(f.host.querySelector('.task-board-sub').textContent,locale.format(language,'taskBoard.status.review'));
  assert.equal(f.host.querySelector('.task-status-need').textContent,locale.format(language,'taskBoard.needOne',{count:1}));
  entry.fire('click');assert.equal(f.host.querySelector('.task-board-reason').textContent,locale.format(language,'taskBoard.reasonIntervened'));assert.equal(f.host.querySelector('.task-board-action').dataset.action,'checkIn');
  assert.doesNotMatch(f.host.textContent,/不要求你回复|No reply is requested/,'An actual unanswered decision is hidden behind an unconditional no-reply promise');} finally {b.dispose();}
});
