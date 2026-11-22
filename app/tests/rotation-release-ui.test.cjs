const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const locale=require('../ui-locale.js');
const source=fs.readFileSync(require.resolve('../renderer/renderer.js'),'utf8');
function section(a,b){const start=source.indexOf(a),end=source.indexOf(b,start);assert.ok(start>=0&&end>start);return source.slice(start,end);}
for(const language of ['zh','en'])test('queue release is a labelled button with captured identity and visible guidance: '+language,async()=>{
 const calls=[],node=(tag,text,cls)=>({tagName:tag,textContent:text||'',className:cls,children:[],dataset:{},append(...x){this.children.push(...x);}});
 const text=(key,p)=>locale.format(language,key,p),c=vm.createContext({node,queueSpace:'shared',queueMemberName:()=> 'Synthetic member',
 uiNode:(tag,key,p,cls)=>node(tag,text(key),cls),uiButton:(key,click,cls,p)=>Object.assign(node('button',text(key,p),cls),{click}),
 api:{spaceAction:async(...x)=>calls.push(x),initial:async()=>({})},updateState(){},renderQueue(){}});
 vm.runInContext(section('const QUEUE_REASONS =','function queueReasonKey('),c);
 vm.runInContext(section('function queueRotationRow(','function renderQueue('),c);
 const record={id:'member',nativeId:'native',rotationEpisode:{nativeId:'native',epoch:'epoch',tag:'tag',state:'invalid'}};
 for(const state of ['invalid','waiting-provider']){
 record.rotationEpisode.state=state;const row=c.queueRotationRow(record),button=row.children.find(n=>n.tagName==='button');
 assert.equal(row.dataset.rotationSession,'member');assert.equal(button.textContent,text('queue.releaseRotation',{name:'Synthetic member'}));
 assert.ok(row.children.some(n=>n.textContent===text(state==='invalid'?'queue.reason.rotationUnresolved':'queue.reason.waitingProvider')));
 await button.click();assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))),['shared','releaseRotation',['member','native','epoch','tag','discard-unresolved-handoff']]);
 }
});

for(const language of ['zh','en'])test('outside sessions offer the same release action with the captured generation: '+language,async()=>{
 const calls=[],c=vm.createContext({window:{nativeWorkspaceSpaces:require('../collaboration-spaces.cjs')},sessionName:s=>s.name,uiText:(k,p)=>locale.format(language,k,p),api:{spaceAction:async(...x)=>calls.push(x),initial:async()=>({})},updateState(){},render(){}});
 vm.runInContext(section('function rotationReleaseAction(','function sessionMenuModel('),c);
 const record={id:'outside',name:'Synthetic butler',nativeId:'native',roomIds:[],rotationEpisode:{nativeId:'native',epoch:'epoch',tag:'tag',state:'invalid'}};
 assert.equal(c.rotationReleaseAction(record)[0].id,'rotation-release');await c.releaseSessionRotation(record);
 assert.deepEqual(JSON.parse(JSON.stringify(calls)),[['shared','releaseRotation',['outside','native','epoch','tag','discard-unresolved-handoff']]]);
 for(const changed of [{archived:true},{nativeId:'new'},{roomIds:['shared'],roomId:'shared'},{rotationEpisode:{...record.rotationEpisode,state:'open'}}])assert.equal(c.rotationReleaseAction({...record,...changed}).length,0);
 assert.match(source.slice(source.indexOf('function sessionMenuModel('),source.indexOf('async function chooseIntegrator(')),/rotationReleaseAction\(record\)/);
 assert.match(source.slice(source.indexOf('function openHeaderMenu('),source.indexOf('const ROOM_TABS')),/releaseSessionRotation\(rotationTarget\)/);
});

test('standalone release stays visibly disabled while disconnected, without disabling existing usage',()=>{
 const header=section('function openHeaderMenu(','const ROOM_TABS'),start=header.indexOf('items: ')+7,end=header.indexOf(',\n    getAnchorRect:',start),expression=header.slice(start,end);
 const items=[{id:'rotation-release'},{id:'usage',control:{disabled:false}}];
 const offline=vm.runInNewContext(expression,{items,disconnected:true});assert.equal(offline[0].disabled,true);assert.equal(offline[1].disabled,false);
 const online=vm.runInNewContext(expression,{items,disconnected:false});assert.equal(online[0].disabled,false);
});
