const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.resolve(__dirname,'../..'), renderer=fs.readFileSync(path.join(root,'app/renderer/renderer.js'),'utf8'), bootstrap=fs.readFileSync(path.join(root,'app/dsh/bootstrap.js'),'utf8');
const from=bootstrap.indexOf('    function createDisplayBindings('), to=bootstrap.indexOf('    function mountWorkspace(',from);
const bind=vm.runInNewContext('('+bootstrap.slice(from,to).trim()+')');
class El {
 constructor(tag,text){this.tagName=tag;this._text=text||'';this.children=[];this.attrs=new Map();this.dataset={};this.classList={toggle(){}};}
 get childElementCount(){return this.children.length;} get textContent(){return this._text;} set textContent(x){this._text=x;this.replaceChildren();}
 setAttribute(k,v){this.attrs.set(k,v);} getAttribute(k){return this.attrs.get(k)||null;} removeAttribute(k){this.attrs.delete(k);}
 append(...x){for(const el of x){el.remove();el.parentNode=this;this.children.push(el);}} prepend(...x){for(const el of [...x].reverse()){el.remove();el.parentNode=this;this.children.unshift(el);}} replaceChildren(...x){for(const el of [...this.children])el.remove();this.append(...x);} before(){} addEventListener(type,run){(this.listeners||={})[type]=run;} remove(){if(this.parentNode){this.parentNode.children=this.parentNode.children.filter(el=>el!==this);this.parentNode=null;}} focus(){}
 querySelectorAll(){return this.children.flatMap(e=>[...(e.attrs.has('data-naw-i18n-bound')?[e]:[]),...e.querySelectorAll()]);}
}
const test=require('node:test'),assert=require('node:assert/strict');
function fixture(message) {
 let language='zh';const locale=require(path.join(root,'app/ui-locale.js')),uiText=(key,params)=>locale.format(language,key,params),display=bind(uiText),node=(tag,text)=>new El(tag,text);
 const box=node('div'),entry={item:node('article'),actions:node('div')}; entry.actions.before=el=>box.append(el);
 const calls=[],rooms=[{id:'shared',untouched:true,name:'共同工作'},{id:'10000000-0000-4000-8000-000000000001',name:'Synthetic space'},{id:'20000000-0000-4000-8000-000000000002',name:'Archived space',archived:true}];
 const context=vm.createContext({Date,JSON,Number,node,uiText,uiError:locale.createError,ui:{display,errorText:problem=>locale.errorText(language,problem),language:{getSnapshot:()=>({active:language})}},button:(label,action)=>Object.assign(node('button',label),{onclick:action}),state:{sessions:[{id:'s',nativeId:'n',provider:'claude'}],capabilities:['operatorControl1a'],operatorPolicy:{domains:[]}},disconnected:false,
  // The grant form lists the person's spaces (renderer.js allSpaces and spaceName); the attempt wrapper and the desktop call are recorded.
  allSpaces:()=>rooms,spaceName:room=>room.untouched?uiText('space.defaultName'):room.name,attempt:run=>{context.pending=run();},api:{operatorAction:async(...args)=>{calls.push(args);return 'domain-id';}}});
 vm.runInContext(renderer.slice(renderer.indexOf('const uiNode ='),renderer.indexOf('const states =')),context);
 vm.runInContext(renderer.slice(renderer.indexOf('function renderOperatorCreation('),renderer.indexOf('const roomMenuKey =')),context);
 context.entry=entry;context.message={time:Date.now(),operator:message}; context.state.sessions[0].messages=[context.message]; vm.runInContext('renderOperatorControls(entry,message,{inbox:true})',context);
 const walk=el=>el.children.flatMap(child=>[child,...walk(child)]);
 return {box,entry,calls,rooms,context,walk:()=>walk(box),update(delta={}){context.message={...context.message,operator:delta===null?null:{...context.message.operator,...delta}};context.state.sessions[0].messages=[context.message];vm.runInContext('renderOperatorControls(entry,message,{inbox:true})',context);},disconnect(){context.disconnected=true;this.update();},refresh(){language='en';display.refresh(box);}};
}
test('actual grant card keeps fields and consent through the actual DSH language repaint',()=>{
 const f=fixture({initiatorId:'s',initiatorNativeId:'n',creation:'pending-authorization',args:{provider:'claude',permission:'default'},actual:{actionId:'a',permission:'default',model:'unknown'}});
 const fields=f.walk().filter(el=>el.tagName==='input');assert.equal(fields.length,4);fields[0].value='7';fields[3].checked=true;
 assert.equal(f.walk().filter(el=>el.tagName==='select').length,2,'Expiry preset, and the space new sessions join; permission cannot be widened');
 assert.doesNotThrow(()=>f.refresh());assert.equal(f.walk().filter(el=>el.tagName==='input')[0],fields[0]);assert.equal(fields[0].value,'7');assert.equal(fields[3].checked,true);
});
test('cancellation warning keeps its confirmation buttons through language repaint without cancelling on first click',()=>{
 const f=fixture({recipientId:'s',requestId:'request',version:1,state:'ready',reportState:'ready',actionable:true});
 const cancel=f.walk().find(el=>el.tagName==='button'&&el.textContent==='撤销请求…');assert.ok(cancel);cancel.onclick();
 const confirm=f.walk().find(el=>el.tagName==='button'&&el.textContent==='确认撤销请求');assert.ok(confirm);assert.doesNotThrow(()=>f.refresh());assert.ok(f.walk().includes(confirm));assert.equal(confirm.textContent,'Confirm cancellation');
});
test('the shared participant filter includes report sender and initiator without granting native row attribution',()=>{
 const from=renderer.indexOf('function timelineParticipants('),to=renderer.indexOf('function showRoomRecords(',from);
 let filter='executor';const rows=[{id:'report',text:'Original report body',operator:{senderId:'executor',recipientId:'initiator'}},{id:'other',text:'Other body',operator:{senderId:'other',recipientId:'another'}}];
 const context=vm.createContext({roomRecordReturn:null,roomRecordScope:'',roomThread:'',roomThreads:{roots:new Map()},timeline:()=>rows,$:id=>({value:id==='room-filter'?filter:''})});
 const read=()=>Array.from(vm.runInContext(renderer.slice(from,to)+'\nfilteredTimeline().map(x=>x.id)',context));
 assert.deepEqual(read(),['report']);filter='initiator';assert.deepEqual(read(),['report']);assert.equal(rows[0].sessionId,undefined);
 context.roomRecordReturn={id:'executor'};context.roomRecordScope='executor';filter='another';assert.deepEqual(read(),['report']);
 context.roomRecordReturn=null;context.roomRecordScope='';filter='unknown';assert.deepEqual(read(),[]);
});
test('closed requests show their ending without asking the person to end them again',()=>{
 const f=fixture({recipientId:'s',requestId:'request',version:1,state:'closed',closedReason:'accepted',reportState:'ready',actionable:true,cannotUpdate:true});
 assert.ok(f.walk().some(el=>el.textContent==='已结束：已收下'));
 assert.equal(f.walk().some(el=>el.textContent==='执行者已不能更新；你仍可结束请求'),false);
});
test('accepted and cancelled creation rows show voided delivery in both languages while open requests remain pending',()=>{
 for(const closedReason of ['accepted','cancelled']){
  const f=fixture({recipientId:'s',requestId:'request',version:1,state:'closed',closedReason,reportState:'ready',actionable:true,creation:'created',actual:{actionId:'a',permission:'default',model:'unknown'}});
  const text=()=>f.walk().map(el=>el.textContent).join('\n');
  assert.doesNotMatch(text(),/待投递/);assert.match(text(),/已作废，未投递/);
  f.refresh();assert.doesNotMatch(text(),/pending/i);assert.match(text(),/Voided; not delivered/);
 }
 const open=fixture({recipientId:'s',requestId:'request',version:1,state:'processing',actionable:true,creation:'created',actual:{actionId:'a',permission:'default',model:'unknown'}});
 assert.ok(open.walk().some(el=>el.textContent.includes('待投递')));
 open.refresh();assert.ok(open.walk().some(el=>/pending/i.test(el.textContent)));
});

test('an open cancellation confirmation survives a same-request native status refresh without replacing its buttons',()=>{
 const f=fixture({recipientId:'s',requestId:'request',version:1,state:'processing',actionable:true});
 const open=()=>f.walk().find(el=>el.tagName==='button'&&el.textContent==='撤销请求…').onclick();open();
 const confirm=f.walk().find(el=>el.tagName==='button'&&el.textContent==='确认撤销请求');assert.ok(confirm);
 f.update({cannotUpdate:true});assert.ok(f.walk().includes(confirm),'same target confirmation must remain the identical live node');
 open();assert.equal(f.walk().filter(el=>el.tagName==='button'&&el.textContent==='确认撤销请求').length,1);
 f.refresh();assert.ok(f.walk().includes(confirm));assert.equal(confirm.textContent,'Confirm cancellation');
 f.walk().find(el=>el.tagName==='button'&&el.textContent==='Keep request').onclick();assert.equal(f.walk().includes(confirm),false);
});
for(const delta of [{version:2},{state:'closed',closedReason:'cancelled'},{old:true},null])test('changed cancellation target removes pending confirmation: '+JSON.stringify(delta),()=>{
 const f=fixture({recipientId:'s',requestId:'request',version:1,state:'processing',actionable:true});
 f.walk().find(el=>el.tagName==='button'&&el.textContent==='撤销请求…').onclick();
 const confirm=f.walk().find(el=>el.tagName==='button'&&el.textContent==='确认撤销请求');assert.ok(confirm);f.update(delta);assert.equal(f.walk().includes(confirm),false);
});
test('disconnect removes an open cancellation confirmation instead of leaving stale authority',()=>{
 const f=fixture({recipientId:'s',requestId:'request',version:1,state:'processing',actionable:true});f.walk().find(el=>el.tagName==='button'&&el.textContent==='撤销请求…').onclick();
 const confirm=f.walk().find(el=>el.tagName==='button'&&el.textContent==='确认撤销请求');f.disconnect();assert.equal(f.walk().includes(confirm),false);
});

// B5: the person may name one space in a grant. Default: none, which is what a grant has always been.
const pendingGrant={initiatorId:'s',initiatorNativeId:'n',creation:'pending-authorization',actionKey:'key',args:{provider:'claude',permission:'default',cwd:'/synthetic'},actual:{actionId:'a',permission:'default',model:'unknown'}};
const grantForm=f=>{const all=f.walk(),selects=all.filter(el=>el.tagName==='select'),inputs=all.filter(el=>el.tagName==='input');
 return {space:selects[1],options:selects[1].children,daily:inputs[0],concurrent:inputs[1],expires:inputs[2],consent:inputs[3],consentText:inputs[3].parentNode.children[1],form:all.find(el=>el.tagName==='form'),problem:all.findLast(el=>el.tagName==='p')};};
const fill=g=>{g.daily.value='1';g.concurrent.value='1';g.expires.value=new Date(Date.now()+3600000).toISOString();};
test('defaults do not grant consent or allow changing the requested permission',()=>{
 const f=fixture(pendingGrant),g=grantForm(f);
 assert.equal(g.daily.value,'1');assert.equal(g.concurrent.value,'1');assert.equal(g.space.value,'');assert.equal(g.consent.checked,false);
 assert.ok(new Date(g.expires.value).getTime()>Date.now());assert.equal(g.expires.value.length,16);
 assert.equal(f.walk().some(el=>el.tagName==='select'&&el.name==='permission'),false);
 g.form.listeners.submit({preventDefault(){}});assert.equal(f.calls.length,0);
});
test('an inline pending record links to the single inbox form instead of making another form',()=>{
 const f=fixture(pendingGrant);
 f.context.inline={item:new El('article'),actions:new El('div')};f.context.inline.actions.before=el=>f.box.append(el);
 vm.runInContext('renderOperatorControls(inline,message)',f.context);
 assert.equal(f.walk().filter(el=>el.tagName==='form').length,1);
});
test('native replacement or authoritative request removal cannot save a grant from a retained form',async()=>{
 for(const reason of ['native','removed']){
  const f=fixture(pendingGrant),g=grantForm(f);fill(g);g.consent.checked=true;
  if(reason==='native')f.context.state.sessions[0].nativeId='replacement';else f.context.state.operatorCreations=[];
  g.form.listeners.submit({preventDefault(){}});await f.context.pending;assert.equal(f.calls.length,0);
 }
});
test('duplicate submission saves one exact grant and preserves the immutable permission',async()=>{
 const f=fixture({...pendingGrant,args:{...pendingGrant.args,permission:'bypass'}}),g=grantForm(f);
 fill(g);g.consent.checked=true;g.form.listeners.submit({preventDefault(){}});const pending=f.context.pending;
 g.form.listeners.submit({preventDefault(){}});await pending;
 assert.deepEqual(f.calls.map(c=>c[1]),['grant','authorize']);assert.equal(f.calls[0][2].permission,'bypass');
 assert.equal(f.calls[0][2].expiresAt,new Date(g.expires.value).getTime());
});
test('a cleared custom expiry survives a redraw instead of being silently extended',()=>{
 const f=fixture(pendingGrant),g=grantForm(f);g.expires.value='';g.expires.listeners.input();
 f.update({version:2});assert.equal(grantForm(f).expires.value,'');
});
test('existing coverage exposes its complete scope and reuses it without another grant',async()=>{
 const f=fixture(pendingGrant),d={id:'covered',providers:['claude'],directories:['/synthetic'],daily:8,concurrent:6,permission:'bypass',expiresAt:Date.UTC(2027,0,1),space:'shared'};
 f.context.state.operatorPolicy.domains.push(d);f.update({coveredDomainId:d.id});
 const text=f.walk().map(el=>el.textContent).join('\n');assert.match(text,/每天（UTC）最多 8 个/);assert.match(text,/同时最多 6 个/);assert.match(text,/跳过确认/);assert.match(text,/共同工作.*队列任务/);
 const other=f.walk().find(el=>el.tagName==='details'&&el.children.some(c=>c.textContent==='改用新的授权范围'));assert.ok(other);assert.ok(!other.open);
 await f.walk().find(el=>el.tagName==='button'&&el.textContent==='使用已有授权').onclick();
 assert.deepEqual(f.calls.map(c=>c[1]),['authorize']);assert.equal(f.calls[0][2].domainId,'covered');
});
test('a pending record returning to an ordinary creation receipt drops its card layout',()=>{
 const f=fixture(pendingGrant);assert.match(f.entry.operatorControls.className,/operator-creation-card/);
 f.update({creation:'created'});assert.equal(f.entry.operatorControls.className,'operator-controls');
});
test('an authorize failure stays visible when the grant response repaints the waiting card',async()=>{
 const f=fixture(pendingGrant),g=grantForm(f);fill(g);g.consent.checked=true;
 f.context.api.operatorAction=async(_id,action)=>{
  if(action==='grant'){
   f.context.state.operatorPolicy.domains.push({id:'new-grant',providers:['claude'],directories:['/synthetic'],daily:1,concurrent:1,expiresAt:Date.UTC(2027,0,1),permission:'default'});
   f.update({coveredDomainId:'new-grant'});return 'new-grant';
  }
  throw Error('Synthetic creation failure');
 };
 g.form.listeners.submit({preventDefault(){}});await f.context.pending;
 assert.ok(f.walk().some(el=>el.textContent==='Synthetic creation failure'));
 assert.equal(f.walk().find(el=>el.textContent==='使用已有授权').disabled,false);
 f.refresh();assert.ok(f.walk().some(el=>el.textContent==='Synthetic creation failure'));
});
test('the grant form offers the person\'s open spaces and defaults to none; the consent sentence and a saved grant are then exactly as before',async()=>{
 const f=fixture(pendingGrant),g=grantForm(f);
 assert.deepEqual(g.options.map(o=>[o.value,o.textContent]),[['','不加入（只建会话，和以前一样）'],['shared','共同工作'],['10000000-0000-4000-8000-000000000001','Synthetic space']],'An archived space is not offered');
 assert.equal(g.space.value,'');assert.equal(g.consentText.textContent,'允许上面厂商、目录及权限在我填的额度和期限内建会话；会产生厂商用量。首条任务和报告通知当前不会投递。');
 fill(g);g.consent.checked=true;g.form.listeners.submit({preventDefault(){}});await f.context.pending;
 assert.equal(f.calls[0][1],'grant');assert.equal(Object.hasOwn(f.calls[0][2],'space'),false,'No space key at all');
 assert.deepEqual(Object.keys(f.calls[0][2]).sort(),['concurrent','daily','directories','expiresAt','permission','providers']);
});
test('choosing a space changes the consent sentence to name it, clears the tick, and saves the grant with that space',async()=>{
 const f=fixture(pendingGrant),g=grantForm(f);
 fill(g);g.consent.checked=true;
 g.space.value='10000000-0000-4000-8000-000000000001';g.space.listeners.change();
 assert.equal(g.consent.checked,false,'A different sentence is a different consent');
 assert.equal(g.consentText.textContent,'允许上面厂商、目录及权限在我填的额度和期限内建会话，建出的会话加入「Synthetic space」成为那里的成员，并接那里排队的活；会产生厂商用量。首条任务和报告通知当前不会投递。');
 g.form.listeners.submit({preventDefault(){}});await f.context.pending;
 assert.equal(f.calls.length,0,'Not saved without the tick');assert.equal(g.problem.textContent,'请填写正整数额度、未来到期时间，并明确勾选许可。');
 g.consent.checked=true;g.form.listeners.submit({preventDefault(){}});await f.context.pending;
 assert.equal(f.calls[0][2].space,'10000000-0000-4000-8000-000000000001');assert.equal(f.calls[1][1],'authorize');
 f.refresh();
 assert.equal(g.consentText.textContent,'Allow creation for this provider, directory and permission within my quotas and expiry; the sessions created join “Synthetic space” as members and are sent the work queued there. Provider usage may incur costs. Initial tasks and report notifications are not delivered in this phase.');
 assert.equal(g.options[0].textContent,'None (create only, as before)');assert.equal(g.options[1].textContent,'Shared work','The default space follows the language');
 g.space.value='';g.space.listeners.change();
 assert.equal(g.consentText.textContent,'Allow creation for this provider, directory and permission within my quotas and expiry. Provider usage may incur costs. Initial tasks and report notifications are not delivered in this phase.');
});
test('a space that was archived after it was chosen is not saved: the person chooses again',async()=>{
 const f=fixture(pendingGrant),g=grantForm(f);
 fill(g);g.space.value='10000000-0000-4000-8000-000000000001';g.space.listeners.change();g.consent.checked=true;
 f.rooms[1].archived=true;
 g.form.listeners.submit({preventDefault(){}});await f.context.pending;
 assert.equal(f.calls.length,0);assert.equal(g.consent.checked,false);assert.equal(g.problem.textContent,'选的空间已不存在或已归档；请重新选择并再次勾选许可。');
});
test('a saved grant shows the space its sessions join, by its current name, and says so when the space is gone',()=>{
 const domain={id:'d',daily:2,concurrent:1,expiresAt:Date.UTC(2027,0,1),space:'10000000-0000-4000-8000-000000000001',initiators:[{id:'s',nativeId:'n'}]};
 const f=fixture({initiatorId:'s',initiatorNativeId:'n',creation:'created',args:{provider:'claude',permission:'default'},actual:{actionId:'a',permission:'default',model:'unknown',domainId:'d'}});
 // The card is drawn again when its own record changes.
 f.context.state.operatorPolicy.domains.push(domain);f.update({version:2});
 const summary=()=>f.walk().filter(el=>el.tagName==='p').map(el=>el.textContent).find(text=>text.startsWith('授权域')||text.startsWith('Grant'));
 assert.match(summary(),/^授权域 d：每天（UTC）最多 2 个，同时最多 1 个；.+ 到期；建出的会话加入「Synthetic space」$/);
 f.rooms[1].name='Renamed space';f.refresh();
 assert.match(summary(),/^Grant d: up to 2 new sessions per UTC day, 1 concurrent; expires .+; new sessions join “Renamed space”$/);
 f.rooms[1].archived=true;f.refresh();assert.match(summary(),/new sessions join “Renamed space \(archived\)”$/,'Nothing is placed into an archived space, and the summary says it is archived');
 f.rooms.splice(1,1);f.refresh();assert.match(summary(),/new sessions join “a space that no longer exists”$/);
 delete domain.space;f.update({version:3});assert.match(summary(),/^Grant d: up to 2 new sessions per UTC day, 1 concurrent; expires [^;]+$/);
});
test('the row of a created session says what the desktop did with it: joining, joined, or not joined and why',()=>{
 const space='10000000-0000-4000-8000-000000000001',base={actionId:'a',permission:'default',model:'unknown',domainId:'d'};
 const f=fixture({initiatorId:'s',initiatorNativeId:'n',creation:'created',args:{provider:'claude',permission:'default'},actual:{...base,space:null,placement:null}});
 const line=()=>f.walk().filter(el=>el.tagName==='p').map(el=>el.textContent).find(text=>/^(新会话(正在加入|已加入|没有加入)|The new session )/.test(text));
 assert.equal(line(),undefined,'A grant without a space says nothing about a space');
 const show=(placement,placementError)=>{f.update({actual:{...base,space,placement,...(placementError?{placementError}:{})}});return line();};
 assert.equal(show('pending'),'新会话正在加入「Synthetic space」');
 assert.equal(show('joined'),'新会话已加入「Synthetic space」');
 assert.equal(show('joined','record-failed'),'新会话已加入「Synthetic space」，但空间里的那条记录没写成');
 for(const [code,reason] of [['space-unavailable','这个空间已不存在或已归档'],['session-unavailable','新会话已结束、已归档或已不在'],['initiator-archived','发起它的会话已归档'],['moved-elsewhere','你已经把它放进了别的空间'],
  ['join-refused','重试几次后仍没能加入；可以手动把它拖进去'],['grant-ended','加入之前授权已结束（撤销、到期或接口已关）'],['some-later-code','原因没有记录'],['constructor','原因没有记录']])
  assert.equal(show('not-placed',code),'新会话没有加入「Synthetic space」：'+reason,code);
 // The line follows the language and the space's current name.
 show('not-placed','moved-elsewhere');f.rooms[1].name='Renamed space';f.refresh();
 assert.equal(line(),'The new session did not join “Renamed space”: you had already put it in another space');
 f.rooms.splice(1,1);f.refresh();assert.equal(line(),'The new session did not join “a space that no longer exists”: you had already put it in another space');
});
// After a language switch nothing in the card may keep the earlier language: every label is painted from its key, not from text taken when the card was drawn.
const earlier=/[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/;
const leftovers=f=>f.walk().flatMap(el=>[...(el.children.length?[]:[el.textContent]),el.getAttribute('aria-label')]).filter(text=>text&&earlier.test(text));
for(const [label,message,expected] of [
 ['a pending grant',{initiatorId:'s',initiatorNativeId:'n',creation:'pending-authorization',actionKey:'key',args:{provider:'claude',permission:'default',cwd:'/synthetic'},actual:{actionId:'a',permission:'default',model:'unknown'}},
  ['New session permission: Confirmations required (Claude default / Codex read-only + on-request)']],
 ['a report that needs attention',{recipientId:'s',requestId:'request',version:1,state:'attention',reportState:'blocked',actionable:true},['Needs your attention: Blocked']],
 ['a cancelled request',{recipientId:'s',requestId:'request',version:1,state:'closed',closedReason:'cancelled',actionable:true},['Closed: Cancelled']],
]) test('after a language switch the card of '+label+' keeps nothing in the earlier language',()=>{
 const f=fixture(message);
 assert.ok(leftovers(f).length>0,'It starts in Chinese');
 f.refresh();
 assert.deepEqual(leftovers(f),[]);
 const texts=f.walk().map(el=>el.textContent);
 for(const text of expected)assert.ok(texts.includes(text),text);
 if(label==='a pending grant')assert.equal(f.walk().filter(el=>el.tagName==='select')[0].name,'operator.card.duration');
});
// B5: a grant follows the session NAW replaced. The card of the grant then says which session holds it now.
test('after NAW replaced its holder, the card of a grant says which session holds it now, and is drawn again when that changes',()=>{
 const domain={id:'d',daily:2,concurrent:1,expiresAt:Date.UTC(2027,0,1),initiators:[{id:'s',nativeId:'n'}]};
 const f=fixture({initiatorId:'s',initiatorNativeId:'n',creation:'created',args:{provider:'claude',permission:'default'},actual:{actionId:'a',permission:'default',model:'unknown',domainId:'d'}});
 f.context.state.operatorPolicy.domains.push(domain);f.update({version:2});
 const holder=()=>f.walk().filter(el=>el.tagName==='p').map(el=>el.textContent).find(text=>/持有|held by/.test(text));
 const revoke=()=>f.walk().find(el=>el.tagName==='button'&&/^(撤销此授权域|Revoke this grant)$/.test(el.textContent));
 assert.equal(holder(),undefined,'A grant that never moved says nothing about holders');assert.equal(revoke().disabled,false);
 // The grant goes on to the session that replaced this one. The card's own record is unchanged; it is drawn again because the holder changed.
 f.context.state.sessions.push({id:'t',nativeId:'m',provider:'claude',name:'Lead · 续'});
 domain.initiators=[{id:'t',nativeId:'m'}];domain.carried=[{from:{id:'s',nativeId:'n'},to:{id:'t',nativeId:'m'},at:1}];
 f.update();
 assert.equal(holder(),'换会话后，这份授权现由「Lead · 续」持有');assert.equal(revoke().disabled,false,'It can still be revoked from this card');
 f.context.state.sessions[1].name='Renamed';f.update();assert.equal(holder(),'换会话后，这份授权现由「Renamed」持有');
 f.refresh();assert.equal(holder(),'After a session replacement, this grant is now held by “Renamed”');
 f.context.state.sessions.pop();f.update();assert.equal(holder(),'After a session replacement, this grant is now held by “a session that is no longer listed”');
 domain.revokedAt=1;f.update();assert.equal(revoke().disabled,true,'Revoked elsewhere, the card shows it');
});
