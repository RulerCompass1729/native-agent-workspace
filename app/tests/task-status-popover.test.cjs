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
test('the same original panel opens nonmodally and second click/Escape return focus',()=>{const f=setup();f.trigger.focus();f.trigger.fire('click');assert.equal(f.panel.getAttribute('popover'),'auto');assert.equal(f.doc.modal,undefined);assert.equal(f.panel.matches(':popover-open'),true);f.trigger.fire('click');assert.equal(f.panel.matches(':popover-open'),false);assert.equal(f.doc.activeElement,f.trigger);f.trigger.fire('click');f.key('Escape');assert.equal(f.panel.matches(':popover-open'),false);assert.equal(f.doc.activeElement,f.trigger);f.board.dispose();});
test('light dismissal does not steal focus from the conversation input',()=>{const f=setup();f.board.open();const input=f.doc.createElement('textarea');f.content.append(input);input.focus();f.panel.hidePopover();assert.equal(f.doc.activeElement,input);f.board.dispose();});
// Flat/space/member views, chips and tabs left with R250–R251 (11-25); task-board-dialog.test.cjs covers groups, search and navigation.
test('every one of 196 tasks is reachable at both widths, eight more a click', () => {
  for (const width of [850, 1240]) {
    const f = setup(width);
    f.board.open();
    for (const b of f.host.querySelectorAll('.task-board-fold')) if (b.getAttribute('aria-expanded') === 'false') b.fire('click');
    for (let more = f.host.querySelector('.task-board-more'), guard = 0; more && guard < 40; more = f.host.querySelector('.task-board-more'), guard++) more.fire('click');
    assert.equal(f.host.querySelectorAll('.task-board-entry').length, 196);
    assert.deepEqual(f.host.querySelectorAll('.task-board-group').map(g => [g.dataset.groupKey, g.querySelector('.task-board-group-count').textContent]), [['waiting', '3'], ['sent', '6'], ['queued', '1'], ['done', '186']]);
    assert.ok(parseFloat(f.panel.style.width) <= width);
    f.board.dispose();
  }
});
