const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.resolve(__dirname,'../..'), renderer=fs.readFileSync(path.join(root,'app/renderer/renderer.js'),'utf8'), bootstrap=fs.readFileSync(path.join(root,'app/dsh/bootstrap.js'),'utf8');
const from=bootstrap.indexOf('    function createDisplayBindings('), to=bootstrap.indexOf('    function mountWorkspace(',from);
const bind=vm.runInNewContext('('+bootstrap.slice(from,to).trim()+')');
class El {
 constructor(tag,text){this.tagName=tag;this._text=text||'';this.children=[];this.attrs=new Map();this.dataset={};this.classList={toggle(){}};}
 get childElementCount(){return this.children.length;} get textContent(){return this._text;} set textContent(x){this._text=x;this.replaceChildren();}
 setAttribute(k,v){this.attrs.set(k,v);} getAttribute(k){return this.attrs.get(k)||null;} removeAttribute(k){this.attrs.delete(k);}
 append(...x){for(const el of x){el.remove();el.parentNode=this;this.children.push(el);}} prepend(...x){for(const el of [...x].reverse()){el.remove();el.parentNode=this;this.children.unshift(el);}} replaceChildren(...x){for(const el of [...this.children])el.remove();this.append(...x);} before(){} addEventListener(){} remove(){if(this.parentNode){this.parentNode.children=this.parentNode.children.filter(el=>el!==this);this.parentNode=null;}} focus(){}
 querySelectorAll(){return this.children.flatMap(e=>[...(e.attrs.has('data-naw-i18n-bound')?[e]:[]),...e.querySelectorAll()]);}
}
const test=require('node:test'),assert=require('node:assert/strict');
function fixture(message) {
 let language='zh';const locale=require(path.join(root,'app/ui-locale.js')),uiText=(key,params)=>locale.format(language,key,params),display=bind(uiText),node=(tag,text)=>new El(tag,text);
 const box=node('div'),entry={item:node('article'),actions:node('div')}; entry.actions.before=el=>box.append(el);
 const context=vm.createContext({Date,JSON,node,uiText,uiError:locale.createError,ui:{display,language:{getSnapshot:()=>({active:language})}},button:(label,action)=>Object.assign(node('button',label),{onclick:action}),state:{sessions:[{id:'s',nativeId:'n',provider:'claude'}],capabilities:['operatorControl1a'],operatorPolicy:{domains:[]}},disconnected:false});
 vm.runInContext(renderer.slice(renderer.indexOf('const uiNode ='),renderer.indexOf('const states =')),context);
 vm.runInContext(renderer.slice(renderer.indexOf('function renderOperatorControls('),renderer.indexOf('const roomMenuKey =')),context);
 context.entry=entry;context.message={time:Date.now(),operator:message}; vm.runInContext('renderOperatorControls(entry,message)',context);
 const walk=el=>el.children.flatMap(child=>[child,...walk(child)]);
 return {box,entry,context,walk:()=>walk(box),update(delta={}){context.message={...context.message,operator:delta===null?null:{...context.message.operator,...delta}};vm.runInContext('renderOperatorControls(entry,message)',context);},disconnect(){context.disconnected=true;this.update();},refresh(){language='en';display.refresh(box);}};
}
test('actual grant card keeps fields and consent through the actual DSH language repaint',()=>{
 const f=fixture({initiatorId:'s',initiatorNativeId:'n',creation:'pending-authorization',args:{provider:'claude',permission:'default'},actual:{actionId:'a',permission:'default',model:'unknown'}});
 const fields=f.walk().filter(el=>el.tagName==='input');assert.equal(fields.length,4);fields[0].value='7';fields[3].checked=true;
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
// After a language switch nothing in the card may keep the earlier language: every label is painted from its key, not from text taken when the card was drawn.
const earlier=/[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/;
const leftovers=f=>f.walk().flatMap(el=>[...(el.children.length?[]:[el.textContent]),el.getAttribute('aria-label')]).filter(text=>text&&earlier.test(text));
for(const [label,message,expected] of [
 ['a pending grant',{initiatorId:'s',initiatorNativeId:'n',creation:'pending-authorization',actionKey:'key',args:{provider:'claude',permission:'default',cwd:'/synthetic'},actual:{actionId:'a',permission:'default',model:'unknown'}},
  ['Native provider default; observed model: Unknown','New session permission: Confirmations required (Claude default / Codex read-only + on-request)']],
 ['a report that needs attention',{recipientId:'s',requestId:'request',version:1,state:'attention',reportState:'blocked',actionable:true},['Needs your attention: Blocked']],
 ['a cancelled request',{recipientId:'s',requestId:'request',version:1,state:'closed',closedReason:'cancelled',actionable:true},['Closed: Cancelled']],
]) test('after a language switch the card of '+label+' keeps nothing in the earlier language',()=>{
 const f=fixture(message);
 assert.ok(leftovers(f).length>0,'It starts in Chinese');
 f.refresh();
 assert.deepEqual(leftovers(f),[]);
 const texts=f.walk().map(el=>el.textContent);
 for(const text of expected)assert.ok(texts.includes(text),text);
 if(label==='a pending grant')assert.equal(f.walk().filter(el=>el.tagName==='select')[0].getAttribute('aria-label'),'New session permission: ');
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
