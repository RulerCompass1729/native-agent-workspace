const test=require('node:test'),assert=require('node:assert/strict');
const {bind}=require('../renderer/mobile-setup.js');
class Element {
  constructor(tag){this.tag=tag;this.children=[];this.listeners={};this.attributes={};this.value='';this.checked=false;this.style={};}
  append(...values){for(const n of values){if(n.parent){n.parent.children=n.parent.children.filter(x=>x!==n);}n.parent=this;this.children.push(n);}}
  prepend(...values){this.append(...values);this.children=[...values,...this.children.filter(n=>!values.includes(n))];}
  insertBefore(n,before){this.append(n);this.children=this.children.filter(x=>x!==n);this.children.splice(this.children.indexOf(before),0,n);}
  replaceChildren(...values){this.children=[];this.append(...values);}
  setAttribute(k,v){this.attributes[k]=v;} removeAttribute(k){delete this.attributes[k];if(k==='src')this.src='';}
  addEventListener(k,v){this.listeners[k]=v;} remove(){} all(){return [this,...this.children.flatMap(c=>c.all())];}
}
function fixture(){const root=new Element('container'),calls=[],timers=new Map();const png='data:image/png;base64,'+Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),Buffer.alloc(32)]).toString('base64');
 const api={mobileApprovalStatus:async()=>({paired:false,registered:false,enabled:false}),mobileConnect:async value=>{calls.push(value);return {qr:png,expiresAt:110000}},mobileRevoke:async()=>({authorizationRevoked:true})};
 const setup=bind({container:root,document:{createElement:t=>new Element(t)},api,getSessions:()=>[{id:'first',nativeId:'native-first',name:'Synthetic'}],now:()=>100000,setTimer:(fn,ms)=>{timers.set(1,{fn,ms});return 1},clearTimer:id=>timers.delete(id)});
 const el=id=>root.all().find(x=>x.id===id);setup.open();return {root,calls,setup,el,timers,png,api};}
test('new one-step surface starts with all scope intent but opening and closing do not grant or broaden anything',()=>{const f=fixture();assert.equal(f.el('mobile-all-sessions').checked,true);assert.equal(f.el('mobile-advanced').open,false);assert.equal(f.el('mobile-records').checked,false);assert.equal(f.el('mobile-approval-enabled').checked,false);assert.deepEqual(f.calls,[]);f.setup.close();assert.deepEqual(f.calls,[]);});
test('retained pairing uses an explicit recovery action and never generates or renews a QR',async()=>{
 const f=fixture(),calls=[];let pending=true;
 f.api.mobileApprovalStatus=async()=>pending?{paired:false,resumeRequired:true,registered:false,enabled:false}:{paired:true,registered:true,enabled:true};
 f.api.mobileResume=async value=>{calls.push(value);pending=false;return {restored:true};};f.setup.close();f.setup.open();await new Promise(setImmediate);
 assert.equal(f.el('mobile-prepare').textContent,'恢复手机连接');assert.equal(f.el('mobile-shared-host').checked,false);assert.equal(f.el('mobile-approval-section').hidden,true);
 await f.el('mobile-prepare').listeners.click();assert.deepEqual(calls,[{sharedHostConfirmed:false}]);assert.deepEqual(f.calls,[]);
 assert.equal(f.el('mobile-pair-qr').hidden,true);assert.equal(f.timers.size,0);assert.equal(f.el('mobile-status').textContent,'手机连接已恢复，授权范围和有效期未改变。');
});
test('recovery never remembers shared-host confirmation when the panel is reopened',async()=>{
 const f=fixture();f.api.mobileApprovalStatus=async()=>({paired:false,resumeRequired:true});f.api.mobileResume=async()=>({restored:true});
 f.setup.close();f.setup.open();await new Promise(setImmediate);f.el('mobile-shared-host').checked=true;f.el('mobile-shared-host').listeners.change();
 f.setup.close();f.setup.open();await new Promise(setImmediate);assert.equal(f.el('mobile-shared-host').checked,false);assert.deepEqual(f.calls,[]);
});
test('one explicit click sends no origin or account and renders only local QR pixels until expiry',async()=>{const f=fixture();await f.el('mobile-prepare').listeners.click();assert.deepEqual(f.calls,[{sharedHostConfirmed:false}]);assert.equal(f.el('mobile-pair-qr').src,f.png);assert.equal(f.el('mobile-pair-link').value,'');assert.equal(f.el('mobile-pair-qr').hidden,false);assert.equal(f.timers.get(1).ms,10000);f.timers.get(1).fn();assert.equal(f.el('mobile-pair-qr').hidden,true);assert.equal(f.el('mobile-pair-qr').src,'');});
test('cancelling all intent reveals the existing individually scoped setup without silently checking rows',()=>{const f=fixture(),a=f.el('mobile-all-sessions');a.checked=false;a.listeners.change();const field=f.root.all().find(n=>n.className==='mobile-sessions');assert.equal(field.hidden,false);assert.ok(f.root.all().filter(n=>n.className==='mobile-session').every(r=>!r.children[0].children[0].checked));assert.deepEqual(f.calls,[]);});
test('scope and carrier edits invalidate a pending QR and immediately permit a new explicit attempt',async()=>{
 for(const [id,event] of [['mobile-all-sessions','change'],['mobile-shared-host','change'],['mobile-origin','input'],['mobile-actor','input'],['mobile-port','input'],['mobile-carrier','change'],['mobile-replace','change'],['mobile-records','change']]){
  const f=fixture();let finish;f.api.mobileConnect=()=>new Promise(resolve=>{finish=resolve;});
  const old=f.el('mobile-prepare').listeners.click();assert.equal(f.el('mobile-prepare').disabled,true);
  const field=f.el(id);field.checked=!field.checked;field.value='changed';field.listeners[event]();
  assert.equal(f.el('mobile-prepare').disabled,false,id);
  finish({qr:f.png,expiresAt:110000});await old;
  assert.equal(f.el('mobile-pair-qr').hidden,true,id);assert.equal(f.el('mobile-pair-qr').src,'',id);assert.equal(f.timers.size,0,id);f.setup.close();
 }
});
test('an older QR completion cannot replace a newer attempt or its enabled state',async()=>{
 const f=fixture(),pending=[];f.api.mobileConnect=()=>new Promise(resolve=>pending.push(resolve));
 const first=f.el('mobile-prepare').listeners.click();f.el('mobile-shared-host').checked=true;f.el('mobile-shared-host').listeners.change();
 const second=f.el('mobile-prepare').listeners.click();pending[0]({qr:f.png,expiresAt:110000});await first;
 assert.equal(f.el('mobile-prepare').disabled,true);assert.equal(f.el('mobile-pair-qr').hidden,true);
 pending[1]({qr:f.png,expiresAt:110000});await second;assert.equal(f.el('mobile-prepare').disabled,false);assert.equal(f.el('mobile-pair-qr').src,f.png);f.setup.close();
});
test('a displayed or late QR setup is cancelled by identity when scope changes, without revoking the active phone',async()=>{
 const f=fixture(),cancelled=[];f.api.mobileCancelSetup=async value=>{cancelled.push(value.setupId);return {cancelled:true};};
 const id='11111111-1111-4111-8111-111111111111';f.api.mobileConnect=async()=>({qr:f.png,expiresAt:110000,setupId:id});await f.el('mobile-prepare').listeners.click();
 f.el('mobile-all-sessions').checked=false;f.el('mobile-all-sessions').listeners.change();assert.deepEqual(cancelled,[id]);assert.equal(f.el('mobile-pair-qr').hidden,true);
 f.setup.open();let finish;f.api.mobileConnect=()=>new Promise(r=>{finish=r});const pending=f.el('mobile-prepare').listeners.click();f.el('mobile-shared-host').listeners.change();finish({qr:f.png,expiresAt:110000,setupId:id});await pending;
 assert.deepEqual(cancelled,[id,id]);assert.equal(f.el('mobile-pair-qr').hidden,true);f.setup.close();
});
test('QR pixel expiry does not cancel a redeemed enrollment window; closing still explicitly cancels that setup',async()=>{
 const f=fixture(),cancelled=[];f.api.mobileCancelSetup=async v=>{cancelled.push(v.setupId);return {cancelled:true};};f.api.mobileConnect=async()=>({qr:f.png,expiresAt:110000,setupId:'11111111-1111-4111-8111-111111111111'});
 await f.el('mobile-prepare').listeners.click();f.timers.get(1).fn();assert.equal(f.el('mobile-pair-qr').hidden,true);assert.equal(cancelled.length,0);f.setup.close();assert.equal(cancelled.length,1);
});
