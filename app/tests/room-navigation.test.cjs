// Existing renderer functions, with the established locale and DOM test helpers.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const os=require('node:os'),path=require('node:path'),{ViewStore}=require('../view-store.cjs');
const localeUI=require('./fixtures/locale-ui.cjs'),spaces=require('../collaboration-spaces.cjs'),threads=require('../room-threads.js');
const source=fs.readFileSync(require.resolve('../renderer/renderer.js'),'utf8');
function actual(name){const start=source.indexOf(`function ${name}(`);assert.ok(start>=0,name);const next=/\n(?:async )?function /g;next.lastIndex=start+1;const end=next.exec(source);assert.ok(end,name);return source.slice(start,end.index)}
function harness(){
 const nodes=new Map(),document={activeElement:null,getSelection:()=>({rangeCount:0,isCollapsed:true}),querySelectorAll:()=>[]},calls={native:[],persisted:0};
 class Element{
  constructor(tag='div'){this.tag=tag;this.children=[];this.attributes={};this.dataset={};this.hidden=false;this.disabled=false;this._value='';this._text='';this.classes=new Set();this.classList={toggle:(c,on)=>on?this.classes.add(c):this.classes.delete(c),contains:c=>this.classes.has(c)}}
  get firstChild(){return this.children[0]}get lastChild(){return this.children.at(-1)}get childElementCount(){return this.children.length}
  get textContent(){return this.children.length?this.children.map(x=>x.textContent).join(''):this._text}set textContent(x){this._text=x;this.children=[]}
  get value(){return this.tag==='select'&&!this.children.some(x=>x.value===this._value)?'':this._value}set value(x){this._value=x}
  get selectedOptions(){return this.children.filter(x=>x.value===this.value)}
  setAttribute(k,v){this.attributes[k]=String(v)}getAttribute(k){return this.attributes[k]??null}removeAttribute(k){delete this.attributes[k]}
  append(...items){for(const x of items)this.insertBefore(x,null)}insertBefore(x,before){x.remove();const i=before?this.children.indexOf(before):this.children.length;this.children.splice(i,0,x);x.parentElement=this}
  replaceChildren(...items){for(const c of this.children)c.parentElement=null;this.children=[];this.append(...items)}remove(){if(!this.parentElement)return;const p=this.parentElement;p.children.splice(p.children.indexOf(this),1);this.parentElement=null}
  addEventListener(k,fn){this[k]=fn}focus(){document.activeElement=this}scrollIntoView(){}contains(x){return x===this||this.children.some(c=>c.contains(x))}
  querySelector(s){for(const c of this.children){if(s.startsWith('.')&&c.className?.split(' ').includes(s.slice(1)))return c;const nested=c.querySelector(s);if(nested)return nested}return null}
  showModal(){this.open=true}close(){this.open=false}
 }
 const $=id=>{if(!nodes.has(id))nodes.set(id,new Element(id==='room-filter'?'select':'div'));return nodes.get(id)};
 const bound=localeUI('en'),node=(tag,text,cls)=>{const el=new Element(tag);if(text!==undefined)el.textContent=text;el.className=cls||'';return el};
 const ctx=vm.createContext({...bound,$,node,document,structuredClone,fitRoomTabs(){},
  uiNode:(tag,key,vars)=>{const el=node(tag);bound.ui.display.text(el,key,vars);return el},button:(label,fn)=>Object.assign(node('button',label),{click:fn}),draggableSession(){},
  spaceId:'shared',selected:'room',roomSurface:'overview',roomSession:'a',mode:'terminal',terminalLayout:'split',roomOverview:null,
  roomViews:{},roomRecordScope:'',roomRecordReturn:null,roomFilterHistory:null,roomRecordSelections:new Map(),roomReturnReading:null,roomHistories:new Map(),roomMention:null,roomMentionHistory:{},
  roomDraftRevision:7,roomThread:'',roomReplyTo:'original-reply',pendingRoomFilter:'',roomSubmitting:null,readingPositions:{},selectionRevision:0,lastRoomMessages:'',lastMessages:'',terminals:new Map(),
  state:{sessions:['a','b'].map(id=>spaces.withMembership({id,name:'Agent '+id,nativeId:'native-'+id,provider:'codex',state:'idle',liveDraft:'PRIVATE '+id},'shared',true)),room:{messages:[],events:[]}},
  window:{nativeWorkspaceThreads:threads,nativeWorkspaceCollaboration:require('../renderer/collaboration-overview.js')},
  current:()=>ctx.state.sessions.find(s=>s.id===ctx.roomSession),activeSessionId:()=>ctx.selected==='room'?ctx.roomSession:ctx.selected,
  members:()=>ctx.state.sessions.filter(s=>spaces.isMember(s,ctx.spaceId)&&!s.archived),orderedMembers:()=>ctx.members(),focusedRoomMember:()=>ctx.selected==='room'&&ctx.roomSurface==='overview'&&Boolean(ctx.roomSession),
  participantLabel:s=>s.name,sessionShortId:id=>id,disconnected:false,exhaustedRecovery:()=>null,recoveryStatusSuffix:()=>'',
  pairRevision:s=>spaces.membershipRevision(s,'shared'),openTransientDialog:id=>$(id).showModal(),captureReadingViews(){},suspendColumnInputs(){},activateSoloComposer(){},render(){},persistView(){calls.persisted++;return ctx.captureRoomView()},attempt:fn=>fn(),toastMessage(){},normalizeRoomMention(){},populateSelect(){},roomRecipient:()=>$('recipient').value,
  nativeWorkspaceMentions:{editHistory:()=>({})},messageList(){},api:new Proxy({},{get:(_,name)=>(...args)=>{calls.native.push([name,args]);throw Error('Navigation reached native API')}})
 });
 $('shared-input').value='@Agent a UNSENT';$('recipient').value='a';
 const fields=source.match(/const roomViewFields = (\[[^;]+\]);/);assert.ok(fields);vm.runInContext(`const roomViewFields=${fields[1]};`,ctx);
 const names=['focusRoomMember','rememberRoomMemberView','restoreRoomMemberView','openRoomMember','timeline','timelineParticipants','filteredTimeline','showRoomRecords','returnRoomRecordMember','clearRoomRecordFilter','restoreRoomRecordFilter','renderTimeline','refreshRoomMemberTabs','roomMemberStatusKey','refreshRoomMemberStatus','openRoomMemberStatus','captureRoomView','persistedRoomViews'];
 for(const name of ['roomRecentPreview','roomNavigationKey','memberTabClick','renderRoomMemberTabs'])if(source.includes('function '+name+'('))names.push(name);
 vm.runInContext(names.map(actual).join('\n'),ctx);vm.runInContext(source.split('\n').find(l=>l.startsWith('const roomReadingKey =')),ctx);ctx.renderSnapshotMaterials=()=>{};
 if(!ctx.renderRoomMemberTabs){const from=source.indexOf("      const tabs = $('room-member-tabs');",source.indexOf('function render()'));const tail='      refreshRoomMemberTabs(people);';const to=source.indexOf(tail,from);assert.ok(from>=0&&to>from);vm.runInContext('function renderRoomMemberTabs(){const people=orderedMembers();\n'+source.slice(from,to+tail.length)+'\n}',ctx)}
 return{ctx,$,document,calls,key:()=>vm.runInContext('roomReadingKey()',ctx)};
}
test('renaming or changing a member state retains the actual focused navigation button',()=>{
 const{ctx,$,document,calls}=harness();ctx.renderRoomMemberTabs();const first=$('room-member-tabs').firstChild;first.focus();
 ctx.state.sessions[0]={...ctx.state.sessions[0],name:'Renamed original',state:'approval',approval:{id:'ask'}};ctx.renderRoomMemberTabs();
 assert.equal($('room-member-tabs').firstChild,first);assert.equal(document.activeElement,first);assert.match(first.getAttribute('aria-label'),/Renamed original/);assert.deepEqual(calls.native,[]);
});
test('a pending historical filter is applied even when its actual candidate list is unchanged',()=>{
 const{ctx,$}=harness();ctx.roomSession='';ctx.roomSurface='records';ctx.renderTimeline();$('room-filter').value='';ctx.pendingRoomFilter='a';ctx.renderTimeline();assert.equal($('room-filter').value,'a');assert.equal(ctx.pendingRoomFilter,'');
});
test('temporary recent-all preserves canonical filters and their separate reading position in the real view store',t=>{
 const{ctx,$,key,calls}=harness();ctx.roomSession='';ctx.roomSurface='records';ctx.pendingRoomFilter='a';$('room-search').value='original';ctx.roomThread='old-thread';ctx.state.room.messages=[{id:'old-thread',recipientId:'a',text:'original'}];ctx.renderTimeline();
 const oldKey=key(),position={top:300,follow:false,anchor:'old-thread',offset:8};ctx.readingPositions[oldKey]=position;ctx.clearRoomRecordFilter();assert.equal($('room-filter').value,'');assert.equal($('room-search').value,'');assert.notEqual(key(),oldKey);
 ctx.captureRoomView();const folder=fs.mkdtempSync(path.join(os.tmpdir(),'naw-navigation-canonical-'));t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));const store=new ViewStore(folder);store.load();store.save([{owner:'owned-test',roomViews:ctx.persistedRoomViews(),readingPositions:ctx.readingPositions}]);const reopened=new ViewStore(folder).load()[0];assert.equal(reopened.roomViews.shared.roomFilter,'a');assert.equal(reopened.roomViews.shared.roomSearch,'original');assert.equal(reopened.roomViews.shared.roomThread,'old-thread');assert.deepEqual(reopened.readingPositions[oldKey],position);assert.equal(reopened.roomViews.shared.sharedDraft,'@Agent a UNSENT');assert.equal(reopened.roomViews.shared.draftRevision,7);assert.deepEqual(calls.native,[]);
});
test('recent-all from related records retains the original member return point and underlying history',()=>{
 const{ctx,$,calls}=harness();ctx.state.room.messages=[{id:'a-row',recipientId:'a',text:'A'},{id:'b-row',recipientId:'b',text:'B'}];$('room-search').value='untouched history';ctx.roomThread='old-thread';ctx.showRoomRecords(true);ctx.clearRoomRecordFilter();
 assert.equal(ctx.roomRecordReturn.id,'a');assert.deepEqual(Array.from(ctx.filteredTimeline(),m=>m.id),['a-row','b-row']);assert.equal($('room-search').value,'untouched history');assert.equal(ctx.roomThread,'old-thread');ctx.returnRoomRecordMember();assert.equal(ctx.roomSession,'a');assert.equal(ctx.mode,'terminal');assert.equal(ctx.roomDraftRevision,7);assert.equal($('shared-input').value,'@Agent a UNSENT');assert.deepEqual(calls.native,[]);
});

test('room navigation keys move focus through the existing buttons without changing the selected native view',()=>{
 const{ctx,$,document,calls}=harness();ctx.renderRoomMemberTabs();const tab=$('room-member-tabs').firstChild;tab.focus();const before=ctx.roomSession;let prevented=0;
 ctx.roomNavigationKey({target:tab,key:'Home',preventDefault(){prevented++}});assert.equal(document.activeElement,$('room-overview'));assert.equal(ctx.roomSession,before);assert.equal(prevented,1);
 ctx.roomNavigationKey({target:$('room-overview'),key:'End',isComposing:true,preventDefault(){assert.fail('IME composition')}});assert.equal(document.activeElement,$('room-overview'));assert.deepEqual(calls.native,[]);
});
test('manual filtering ends only the temporary recent preview and leaves the draft generation alone',()=>{
 const{ctx,$,calls}=harness();ctx.roomSession='';ctx.roomSurface='records';ctx.roomFilterHistory={roomFilter:'a',roomSearch:'original',roomThread:''};$('room-search').value='new explicit query';
 const line=source.split('\n').find(l=>l.startsWith("$('room-search').oninput ="));assert.ok(line);vm.runInContext(line,ctx);$('room-search').oninput();assert.equal(ctx.roomFilterHistory,null);ctx.captureRoomView();assert.equal(ctx.roomViews.shared.roomSearch,'new explicit query');assert.equal(ctx.roomDraftRevision,7);assert.equal($('shared-input').value,'@Agent a UNSENT');assert.deepEqual(calls.native,[]);
});
test('the existing native unknown-state facts remain in the stable accessible member label',()=>{
 const{ctx,$}=harness();ctx.state.sessions[0].nativeContextPending={reason:'owned-fixture'};ctx.renderRoomMemberTabs();const tab=$('room-member-tabs').firstChild;assert.ok(tab.getAttribute('aria-label').includes(ctx.uiText('collab.contextUnknown')));
 ctx.state.sessions[0].backendUnavailable=true;ctx.renderRoomMemberTabs();assert.ok(tab.getAttribute('aria-label').includes(ctx.uiText('collab.connectionUnknown')));
});


for (const scenario of ['missing saved member', 'archived selected member']) test(`room navigation retains one keyboard entry with ${scenario}`, () => {
 const {ctx,$,document,calls}=harness();ctx.renderRoomMemberTabs();$('room-member-tabs').firstChild.focus();
 if(scenario==='missing saved member')ctx.roomSession='gone';else ctx.state.sessions[0].archived=true;
 document.activeElement=null;ctx.renderRoomMemberTabs();
 const routes=[$('room-overview'),$('room-record'),...$('room-member-tabs').children];
 assert.equal(routes.filter(el=>el.tabIndex===0).length,1);assert.equal($('room-overview').tabIndex,0);assert.deepEqual(calls.native,[]);
});

test('opening an explicit search result from recent-all retains the canonical historical filter on save',async()=>{
 const{ctx,$,calls}=harness();ctx.roomSession='';ctx.roomSurface='records';ctx.roomFilterHistory={roomFilter:'a',roomSearch:'original history',roomThread:''};
 ctx.state.room.messages=[{id:'result-b',recipientId:'b',text:'Exact B result'}];
 Object.assign(ctx,{clearTimeout(){},searchTimer:null,searchRevision:0,searchOrigin:{spaceId:'shared',selected:'room'},searchReturn:null,searchNavigating:false,spaceRecord:()=>ctx.state.room,selectSpace:async()=>{},selectRoom:async()=>{},pointToMessage(){}});
 $('search-dialog').close=()=>{};const text=fs.readFileSync(require.resolve('../renderer/search-view.js'),'utf8'),from=text.indexOf('async function openSearchResult('),to=text.indexOf('async function returnToReading(',from);assert.ok(from>=0&&to>from);vm.runInContext(text.slice(from,to),ctx);
 await ctx.openSearchResult({kind:'shared',roomId:'shared',messageId:'result-b'});
 assert.equal(ctx.roomViews.shared.roomFilter,'a');assert.equal(ctx.roomViews.shared.roomSearch,'original history');assert.equal(ctx.roomRecordScope,'');assert.equal(ctx.roomRecordReturn,null);assert.deepEqual(calls.native,[]);
});

// T-121 A: the open member's own tab returns to all members; another member's tab still opens that member.
test('clicking the open member tab returns to all members, but not on a double-click or Control-click',()=>{
 const{ctx,$}=harness();ctx.renderRoomMemberTabs();const tabs=$('room-member-tabs').children,a=tabs.find(t=>t.dataset.roomSession==='a'),b=tabs.find(t=>t.dataset.roomSession==='b');
 assert.equal(a.getAttribute('aria-pressed'),'true');assert.equal(a.getAttribute('title'),ctx.uiText('room.tabRestoreHint',{label:'Agent a · a'}));assert.equal(b.getAttribute('title'),ctx.uiText('room.tabHint',{label:'Agent b · b'}));
 ctx.memberTabClick('a',{detail:2});assert.equal(ctx.roomSession,'a','The second click of a double-click stays');
 ctx.memberTabClick('a',{detail:1,ctrlKey:true});assert.equal(ctx.roomSession,'a','A Control-click stays');
 ctx.memberTabClick('a',{detail:1});assert.equal(ctx.roomSession,'');assert.equal(ctx.roomSurface,'overview');
 ctx.renderRoomMemberTabs();assert.equal(a.getAttribute('aria-pressed'),'false');assert.equal(a.getAttribute('title'),ctx.uiText('room.tabHint',{label:'Agent a · a'}));
 ctx.memberTabClick('b',{detail:1});assert.equal(ctx.roomSession,'b','Another member tab opens that member');
 ctx.memberTabClick('b',{detail:0});assert.equal(ctx.roomSession,'','Enter or Space on the open tab returns too');
 a.click();assert.equal(ctx.roomSession,'a','The tab listener opens a member');
 ctx.memberTabClick('a',{detail:1});ctx.memberTabClick('a',{detail:2});assert.equal(ctx.roomSession,'','A double-click on the open tab returns once and does not reopen');
 ctx.memberTabClick('b',{detail:1});ctx.memberTabClick('b',{detail:2});assert.equal(ctx.roomSession,'b','A double-click on another tab opens it once');
});

test('full member status keeps focused rows on updates and rejects stale identity, membership or space actions',()=>{
 const {ctx,$,document,calls}=harness();ctx.renderRoomMemberTabs();ctx.openRoomMemberStatus();
 const list=$('room-member-status-list'),row=list.children.find(r=>r.dataset.roomStatusMember==='b');row.focus();
 ctx.state.sessions[1].nativeApproval={requests:[{id:'one'},{id:'two'}]};ctx.refreshRoomMemberTabs();
 assert.equal(list.children.find(r=>r.dataset.roomStatusMember==='b'),row);assert.equal(document.activeElement,row);
 assert.match($('room-member-status').textContent,/1 awaiting approval/);assert.match(row.querySelector('.room-member-name').textContent,/Agent b.*Codex.*b/);
 const before=ctx.roomSession;ctx.state.sessions[1].nativeId='replacement-native';row.click({});assert.equal(ctx.roomSession,before);
 ctx.refreshRoomMemberTabs();const replacement=list.children.find(r=>r.dataset.roomStatusMember==='b');assert.notEqual(replacement,row);
 ctx.state.sessions[1]=spaces.withMembership(ctx.state.sessions[1],'shared',false);replacement.click({});assert.equal(ctx.roomSession,before);
 ctx.spaceId='00000000-0000-4000-8000-000000000001';ctx.refreshRoomMemberStatus();assert.equal($('room-member-status-dialog').open,false);replacement.click({});assert.equal(ctx.roomSession,before);
 assert.deepEqual(calls.native,[]);assert.equal(ctx.state.sessions[0].liveDraft,'PRIVATE a');
});
