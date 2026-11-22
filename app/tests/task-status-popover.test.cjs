const test = require('node:test'), assert = require('node:assert/strict');
const board = require('../renderer/task-board.js'), locale = require('../ui-locale.js');
const { fixture } = require('./fixtures/task-board-dom.cjs');
function setup(width=850) {
  const f=fixture(); f.win.innerWidth=width;let clock=Date.now();const calls=[];
  const sessions=[{id:'member',nativeId:'native',name:'Member',roomIds:['space'],state:'working'},{id:'solo',nativeId:'solo-native',name:'Independent',roomIds:[],state:'working'}];
  const queue=[...Array.from({length:6},(_,i)=>({id:'work'+i,status:'sent',sentTo:'member',text:'Synthetic work '+i})),...Array.from({length:3},(_,i)=>({id:'wait'+i,status:'waiting',text:'Synthetic decision '+i})),{id:'next',status:'queued',text:'Unassigned next task'},...Array.from({length:186},(_,i)=>({id:'done'+i,status:'done',finishedAt:clock}))];
  f.input={rooms:[{id:'space',name:'Example',queue}],sessions,confirmationsAvailable:true,confirmations:[{key:'actor:native:op',id:'message',sessionId:'member',nativeId:'native',operationId:'op',state:'confirmation-required',actionable:true,expiresAt:clock+100000}]};
  f.board=board.bind({host:f.host,document:f.doc,text:(k,p)=>locale.format('en',k,p),now:()=>clock,onQueue:id=>calls.push(['queue',id]),onSession:(...args)=>calls.push(['session',...args]),onConfirmation:r=>calls.push(['card',r])});f.board.update(f.input);
  f.trigger=f.host.querySelector('.task-board-toggle');f.panel=f.host.querySelector('.task-board-panel');f.calls=calls;f.advance=ms=>{clock+=ms;f.board.tick();};return f;
}
test('the bar has no unlabeled task squares; the card chip opens the most urgent card directly',()=>{for(const width of [850,1240]){const f=setup(width);assert.equal(f.host.querySelector('.task-status-square'),null);assert.equal(f.host.querySelector('.task-status-track'),null);const chip=f.host.querySelector('.task-status-card-time');assert.equal(chip.textContent,'Card expires in 1:40');assert.equal(chip.tagName.toLowerCase(),'button');chip.fire('click');assert.equal(f.calls[0][0],'card');assert.equal(f.calls[0][1].operationId,'op');f.board.dispose();}});
test('an unknown card feed says so instead of a precise count',()=>{const f=setup();f.input.confirmationsAvailable=false;f.input.confirmations=[];f.board.update(f.input);const bar=f.host.querySelector('.task-status-chips').textContent;assert.equal(f.host.querySelector('.task-status-card-time').hidden,true,bar);assert.equal(bar,'1 to verify');assert.equal(/\b0 /u.test(bar),false);f.board.dispose();});
test('the same original panel opens nonmodally and second click/Escape return focus',()=>{const f=setup();f.trigger.focus();f.trigger.fire('click');assert.equal(f.panel.getAttribute('popover'),'auto');assert.equal(f.doc.modal,undefined);assert.equal(f.panel.matches(':popover-open'),true);f.trigger.fire('click');assert.equal(f.panel.matches(':popover-open'),false);assert.equal(f.doc.activeElement,f.trigger);f.trigger.fire('click');f.key('Escape');assert.equal(f.panel.matches(':popover-open'),false);assert.equal(f.doc.activeElement,f.trigger);f.board.dispose();});
test('unfinished entries are progressively reachable and keep distinct card/wait/work/queue states',()=>{
 const f=setup();f.trigger.fire('click');assert.equal(f.host.querySelectorAll('.task-board-entry').length,10);f.host.querySelector('.task-board-more').fire('click');
 const entries=f.host.querySelectorAll('.task-board-entry');assert.equal(entries.length,12);
 const card=entries.find(e=>e.dataset.source==='confirmation');assert.ok(card.textContent.includes('1:40'));
 assert.equal(entries.filter(e=>e.dataset.kind==='waiting'&&e.dataset.source!=='confirmation').length,3);
 assert.equal(entries.filter(e=>e.dataset.kind==='queued').length,1);assert.equal(entries.filter(e=>e.dataset.kind==='sent').length,7);
 assert.ok(entries.some(e=>e.textContent.includes('Example')&&e.textContent.includes('Member')));f.board.dispose();
});
test('unassigned rows open their original queue, native rows open the exact session, cards only delegate identity',()=>{const f=setup();f.board.open();f.host.querySelectorAll('.task-board-entry').find(e=>e.dataset.source==='confirmation').fire('click');assert.equal(f.calls[0][0],'card');assert.deepEqual(Object.keys(f.calls[0][1]).sort(),['history','messageId','nativeId','operationId','sessionId']);f.board.open();f.host.querySelectorAll('.task-board-entry').find(e=>e.dataset.kind==='queued').fire('click');assert.deepEqual(f.calls[1],['queue','space']);f.board.open();f.host.querySelectorAll('.task-board-entry').find(e=>e.dataset.source==='conversation').fire('click');assert.deepEqual(f.calls[2],['session','solo','solo-native']);f.board.dispose();});
test('expiry removes the card entry and chip using the existing clock without changing other rows',()=>{const f=setup();f.board.open();const first=f.host.querySelectorAll('.task-board-entry').find(e=>e.dataset.kind==='sent');f.advance(100000);assert.equal(f.host.querySelectorAll('.task-board-entry').some(e=>e.dataset.source==='confirmation'),false);assert.ok(f.host.querySelectorAll('.task-board-entry').includes(first));assert.equal(f.host.querySelector('.task-status-card-time').hidden,true);assert.equal(f.timers.size,0);f.board.dispose();});
test('one popover directly exposes flat/space/member views without a second navigation layer',()=>{
 const f=setup();f.board.open();const panel=f.panel;assert.equal(panel.dataset.mode,'full');assert.equal(panel.matches(':popover-open'),true);
 const mode=f.host.querySelector('.task-board-mode');for(const value of ['space','member','flat']){mode.value=value;mode.fire('change');assert.ok(f.host.querySelector('.task-board-task'));if(value!=='flat')assert.ok(f.host.querySelector('.task-board-group'));}
 assert.equal(f.host.querySelector('.task-board-panel'),panel);assert.equal(f.host.querySelector('.task-board-full'),null);assert.equal(f.host.querySelector('.task-board-current'),null);f.board.dispose();
});
test('light dismissal does not steal focus from the conversation input',()=>{const f=setup();f.board.open();const input=f.doc.createElement('textarea');f.content.append(input);input.focus();f.panel.hidePopover();assert.equal(f.doc.activeElement,input);f.board.dispose();});

test('zero, one and many queued rows stay reachable at both widths',()=>{for(const width of [850,1240])for(const count of [0,1,8,9,20,21,24]){const f=setup(width);f.input={rooms:[{id:'space',name:'Example',queue:Array.from({length:count},(_,i)=>({id:'queued'+i,status:'queued',text:'Synthetic '+i}))}],sessions:[],confirmationsAvailable:true,confirmations:[]};f.board.update(f.input);assert.equal(f.host.querySelector('.task-status-card-time').hidden,true);f.board.open();while(f.host.querySelector('.task-board-more').getAttribute('aria-disabled')!=='true')f.host.querySelector('.task-board-more').fire('click');assert.equal(f.host.querySelectorAll('.task-board-entry').length,count,`${width}/${count}: every row reachable`);f.board.dispose();}});

for (const spec of [
  { name: 'queued planned assignee without sentTo', status: 'queued', assignee: 'planned', expected: ['queue', 'origin'] },
  { name: 'unassigned queued item', status: 'queued', expected: ['queue', 'origin'] },
  { name: 'sent item with a different planned assignee', status: 'sent', assignee: 'planned', sentTo: 'actual', expected: ['session', 'actual', 'native-actual'] },
  { name: 'missing sentTo never falls back to the planned assignee', status: 'sent', assignee: 'planned', sentTo: 'gone', expected: ['queue', 'origin'] },
]) test('entry navigation: ' + spec.name, () => {
  const f = setup();
  try {
    const sessions = ['planned', 'actual'].map(id => ({ id, name: id, nativeId: 'native-' + id, roomIds: ['origin'], state: 'idle' }));
    for (const session of sessions) Object.defineProperty(session, 'messages', { get() { throw Error('Navigation must not read conversation bodies'); } });
    f.board.update({ rooms: [{ id: 'origin', name: 'Origin', queue: [{ id: 'task', text: 'Synthetic navigation task', ...spec }] }], sessions, connected: true, confirmationsAvailable: true, confirmations: [] });
    f.board.open(); f.host.querySelector('.task-board-entry').fire('click');
    assert.deepEqual(f.calls, [spec.expected]); assert.equal(f.panel.matches(':popover-open'), false);
  } finally { f.board.dispose(); }
});
