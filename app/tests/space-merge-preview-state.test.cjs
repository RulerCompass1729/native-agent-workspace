const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const locale=require('../ui-locale.js'),spaces=require('../collaboration-spaces.cjs');
const source=fs.readFileSync(path.join(__dirname,'../renderer/renderer.js'),'utf8');
function declaration(name){const a=source.indexOf('function '+name+'('),b=source.indexOf('\n}',a);assert.ok(a>0&&b>a);return source.slice(a,b+2);}
const from=source.indexOf("$('preview-space-merge').onclick ="),to=source.indexOf('async function submitSpaceMerge',from);
assert.ok(from>0&&to>from);const handler=source.slice(from,to);
const refreshFrom=source.indexOf("    if ($('invite-dialog').open) for"),refreshTo=source.indexOf('    renderHeader(s, inRoom);',refreshFrom);
assert.ok(refreshFrom>0&&refreshTo>refreshFrom);const refreshDialogs=source.slice(refreshFrom,refreshTo);
class Element{
 constructor(tag='div'){this.tag=tag;this.children=[];this.dataset={};this.checked=false;this.disabled=false;this.hidden=false;this.value='';}
 append(...items){this.children.push(...items);}replaceChildren(...items){this.children=[...items];}
 get lastElementChild(){return this.children.at(-1);}set textContent(value){this.children=[String(value)];}get textContent(){return this.children.map(c=>typeof c==='string'?c:c.textContent).join('');}
 setAttribute(key,value){this[key]=value;}focus(){this.focused=true;}
 querySelectorAll(){const visit=e=>e.children.flatMap(c=>typeof c==='string'?[]:[c,...visit(c)]);return visit(this).filter(e=>e.tag==='input'&&e.dataset.mergeMember&&e.checked);}
}
function fixture(){
 const ids=['invite-dialog','space-merge-dialog','space-merge-options','space-merge-preview','space-merge-name','space-merge-disposition','space-merge-error','space-merge-members','space-merge-selection','preview-space-merge','confirm-space-merge','back-space-merge','open-space-merge-target','undo-space-merge','recover-space-merge'];
 const elements=Object.fromEntries(ids.map(id=>[id,new Element()])),dialog=elements['space-merge-dialog'];dialog.open=true;dialog.isConnected=true;
 elements['space-merge-name'].value='Original name';elements['space-merge-disposition'].value='keep';
 const dialogTickets=new WeakMap(),ticket={dialog};dialogTickets.set(dialog,ticket);
 const rooms=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222'].map((id,i)=>({id,name:'Source '+i,messages:[],notes:'',files:[],events:[]}));
 const inputs=new Map(rooms.map(r=>{const input=new Element('input');input.checked=true;input.value=r.id;return[r.id,input];}));
 const draft={ticket,rooms,sourceInputs:inputs,memberChoices:new Map(),selections:new Map(),record:null,batch:null},calls=[],errors=[];
 let resolve,reject;const request=new Promise((yes,no)=>{resolve=yes;reject=no;});
 const text=(key,params)=>locale.format('en',key,typeof params==='function'?params():params);
 const context={$:id=>{assert.ok(elements[id],'Known fixture element '+id);return elements[id];},document:{createElement:tag=>new Element(tag)},dialogTickets,mergeDialog:draft,disconnected:false,
  state:{sessions:[]},window:{nativeWorkspaceSpaces:spaces},inSpace:spaces.isMember,uiText:text,Intl,Map,Set,
  ui:{language:{text,getSnapshot:()=>({active:'en'})},display:{text(e,key,params){e.textContent=text(key,params);},computed(e,slot,fn){e.textContent=fn();},attribute(e,slot,key,params){e.setAttribute(slot,text(key,params));},unbind(){}},displayText:t=>t,showError(e,error){e.textContent=error.message;}},
  attempt:run=>run(),toastError:e=>errors.push(e.message),renderMergeBatch:()=>{},
  api:{spaceMerge(action,spec){calls.push({action,spec});return action==='preview'?request:Promise.resolve();}}};
 context.spaceName ??= room => room?.name; vm.createContext(context);
 const helpers=source.split('\n').filter(s=>s.startsWith('const node =')||s.startsWith('const uiNode =')).join('\n');
 const renderBlock=source.slice(source.indexOf('function mergeSourceLabel('),source.indexOf('function openSpaceMerge('));
 vm.runInContext(helpers+'\n'+['currentDialogTicket','mergeSpec'].map(declaration).join('\n')+'\n'+renderBlock+'\n'+handler,context);
 context.renderMergeChoices();
 return{context,draft,elements,dialog,dialogTickets,calls,errors,resolve,reject,submit:()=>elements['preview-space-merge'].onclick(),refresh:()=>vm.runInContext(refreshDialogs,context),deselect(){inputs.values().next().value.checked=false;context.renderMergeChoices();}};
}
for(const mode of['deselect','disconnect'])test('failed preview respects newer '+mode+' eligibility',async()=>{
 const f=fixture(),pending=f.submit();assert.equal(f.elements['preview-space-merge'].disabled,true);
 if(mode==='deselect')f.deselect();else{f.context.disconnected=true;f.context.renderMergeChoices();}
 assert.equal(f.elements['preview-space-merge'].disabled,true);f.reject(Error('Owned metadata preview failed'));await pending;
 assert.equal(f.elements['preview-space-merge'].disabled,true,'The earlier request must not override current eligibility');
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].action,'preview');assert.equal(f.draft.batch,null);assert.equal(f.elements['space-merge-options'].hidden,false);
 assert.equal(f.elements['space-merge-error'].textContent,'Owned metadata preview failed');
});
test('an ordinary failed preview remains explicitly retryable',async()=>{
 const f=fixture(),pending=f.submit();f.reject(Error('Retryable metadata error'));await pending;assert.equal(f.elements['preview-space-merge'].disabled,false);assert.equal(f.calls.length,1);
});
test('a successful preview retains Back eligibility without a second request',async()=>{
 const f=fixture(),pending=f.submit();f.resolve({operationId:'owned-operation'});await pending;
 assert.equal(f.elements['space-merge-options'].hidden,true);assert.equal(f.elements['confirm-space-merge'].hidden,false);assert.equal(f.elements['confirm-space-merge'].focused,true);assert.equal(f.elements['preview-space-merge'].disabled,false);assert.equal(f.calls.length,1);
});
test('an old failed preview cannot enable a reopened dialog',async()=>{
 const f=fixture(),pending=f.submit();f.dialog.open=false;const newTicket={dialog:f.dialog};f.dialogTickets.set(f.dialog,newTicket);f.dialog.open=true;f.elements['preview-space-merge'].disabled=true;
 f.reject(Error('Earlier request failed'));await pending;assert.equal(f.elements['preview-space-merge'].disabled,true);assert.deepEqual(f.errors,['Earlier request failed']);
});
test('a second click while pending cannot start another preview',async()=>{
 const f=fixture(),pending=f.submit();await f.submit();assert.equal(f.calls.length,1);f.reject(Error('Done'));await pending;
});
test('changing and restoring sources while pending cannot enable a duplicate preview',async()=>{
 const f=fixture(),pending=f.submit(),input=f.draft.sourceInputs.values().next().value;
 input.checked=false;f.context.renderMergeChoices();input.checked=true;f.context.renderMergeChoices();
 const stillPending=f.elements['preview-space-merge'].disabled;
 if(!stillPending){f.reject(Error('Done'));await pending;}
 assert.equal(stillPending,true,'Eligibility changes must not remove the pending-request guard');
 await f.submit();assert.equal(f.calls.length,1);f.reject(Error('Done'));await pending;
});
test('finishing a failed preview keeps current option nodes and selection objects',async()=>{
 const f=fixture(),pending=f.submit(),first=f.elements['space-merge-selection'].children[0],choices=f.draft.selections;
 f.reject(Error('Done'));await pending;assert.equal(f.elements['space-merge-selection'].children[0],first,'Do not rebuild focused controls just to refresh one button');assert.equal(f.draft.selections,choices);
});
test('reconnecting after a rejected preview restores retry without changing choices',async()=>{
 const f=fixture(),pending=f.submit(),first=f.elements['space-merge-selection'].children[0];f.context.disconnected=true;f.reject(Error('Disconnected preview'));await pending;assert.equal(f.elements['preview-space-merge'].disabled,true);
 f.context.disconnected=false;f.refresh();assert.equal(f.elements['preview-space-merge'].disabled,false);assert.equal(f.elements['space-merge-selection'].children[0],first);assert.equal(f.calls.length,1);
});
test('an idle open merge dialog reflects connection changes without rebuilding options',()=>{
 const f=fixture(),first=f.elements['space-merge-selection'].children[0];f.context.disconnected=true;f.refresh();assert.equal(f.elements['preview-space-merge'].disabled,true);
 f.context.disconnected=false;f.refresh();assert.equal(f.elements['preview-space-merge'].disabled,false);assert.equal(f.elements['space-merge-selection'].children[0],first);
});
test('a merge-record view with no choice map is unaffected by state refresh',()=>{
 const f=fixture();f.context.mergeDialog={ticket:f.draft.ticket,record:null,batch:null};f.elements['preview-space-merge'].disabled=true;f.refresh();assert.equal(f.elements['preview-space-merge'].disabled,true);
});
