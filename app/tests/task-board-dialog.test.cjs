const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const board=require('../renderer/task-board.js'),locale=require('../ui-locale.js'),{fixture}=require('./fixtures/task-board-dom.cjs');
function setup(language='zh'){
 const f=fixture();let now=new Date(2026,10,18,12).getTime();f.input={connected:true,confirmationsAvailable:true,confirmations:[],activeSpace:'space',rooms:[{id:'space',name:'Synthetic space',queue:[{id:'sent',status:'sent',text:'Synthetic request',sentTo:'member'},{id:'review',status:'waiting',reason:'no-reply',text:'Synthetic review'}]}],sessions:[{id:'member',name:'Synthetic member',state:'working',roomIds:['space']}]};
 f.board=board.bind({host:f.host,document:f.doc,text:(k,p)=>locale.format(language,k,p),onQueue(){},now:()=>now});f.board.update(f.input);
 f.button=f.host.querySelector('.task-board-toggle');f.panel=f.host.querySelector('.task-board-panel');f.advance=ms=>{now+=ms;f.board.tick();};f.now=()=>now;return f;
}
test('the global bar uses no separate height and keeps one original panel',()=>{const f=setup();assert.equal(board.BAR_HEIGHT,0);assert.equal(f.host.querySelectorAll('.task-board-toggle').length,1);assert.equal(f.host.querySelector('.task-board-project'),null);assert.match(fs.readFileSync(require.resolve('../renderer/task-board.css'),'utf8'),/\.task-board-panel\{[^}]*position:fixed/);f.board.dispose();});
test('the bar keeps only things to act on; progress counts live in the panel and hover adds no second layer',()=>{for(const lang of ['zh','en']){const f=setup(lang),bar=f.host.querySelector('.task-status-chips');assert.equal(f.button.textContent.replace('⌄',''),lang==='zh'?'任务板':'Task board');for(const gone of lang==='zh'?['在做','等你','待你处理','今天队列完成']:['working','need you','to handle','Queue done'])assert.equal((bar.textContent+f.button.textContent).includes(gone),false,gone);f.button.fire('pointerenter',{pointerType:'mouse'});f.tick(1000);assert.equal(f.host.querySelector('.task-board-hint'),null);assert.equal(f.timers.size,0);f.board.open();assert.equal(f.host.querySelectorAll('.task-board-tab').find(b=>b.dataset.boardTab==='sent').dataset.count,'1');f.board.dispose();}});
test('native popover lifecycle does not move content and returns focus to the same trigger',()=>{const f=setup(),before=f.content.getBoundingClientRect();f.button.focus();f.button.fire('click');assert.equal(f.doc.modal,undefined);assert.equal(f.panel.matches(':popover-open'),true);assert.equal(f.button.getAttribute('aria-expanded'),'true');assert.deepEqual(f.content.getBoundingClientRect(),before);assert.ok(parseFloat(f.panel.style.width)<=826);assert.ok(parseFloat(f.panel.style.top)+parseFloat(f.panel.style.maxHeight)<=600);f.key('Escape');assert.equal(f.panel.matches(':popover-open'),false);assert.equal(f.doc.activeElement,f.button);assert.equal(f.button.getAttribute('aria-expanded'),'false');f.board.dispose();});
test('another modal Escape is never consumed by a closed task board',()=>{const f=setup(),other=f.doc.createElement('dialog');f.doc.body.append(other);other.showModal();f.key('Escape');assert.equal(other.open,false);f.board.dispose();});
test('state pushes retain the actual trigger and open popover',()=>{const f=setup();f.button.focus();f.button.fire('click');const trigger=f.button,waiting=()=>f.host.querySelectorAll('.task-board-tab').find(b=>b.dataset.boardTab==='waiting').dataset.count;assert.equal(waiting(),'0');f.input.rooms[0].queue.push({id:'wait',status:'waiting'});f.board.update(f.input);assert.equal(f.host.querySelector('.task-board-toggle'),trigger);assert.equal(f.panel.matches(':popover-open'),true);assert.equal(waiting(),'1');f.board.dispose();});
test('pending cards count down while the panel is closed and expire without an RPC',()=>{const f=setup();f.input.confirmations=[{key:'actor:native:operation',id:'message',sessionId:'actor',nativeId:'native',operationId:'operation',state:'confirmation-required',actionable:true,expiresAt:f.now()+100000}];f.board.update(f.input);const chip=f.host.querySelector('.task-status-card-time');assert.equal(chip.textContent,'卡 1:40 后失效');assert.equal(chip.getAttribute('aria-label'),'1 张确认卡，1:40 后失效，打开它');f.advance(1000);assert.equal(chip.textContent,'卡 1:39 后失效');f.advance(99000);assert.equal(chip.hidden,true);assert.equal(f.timers.size,0);f.board.dispose();});
test('unavailable and disconnected snapshots show a visible uncertainty chip instead of a healthy zero',()=>{const healthy=setup();assert.equal(healthy.host.querySelector('.task-status-warning').hidden,true);healthy.board.dispose();for(const change of [f=>f.input.connected=false,f=>f.input.confirmationsAvailable=false,f=>f.input.rooms[0].unavailable=true]){const f=setup();change(f);f.board.update(f.input);const bar=f.host.querySelector('.task-status-chips').textContent;assert.equal(/\b0 /u.test(bar),false);assert.ok(bar.includes('未')||bar.includes('待核实'),bar);f.board.dispose();}});
test('midnight refresh keeps unfinished work and the finished outcome stays reachable',()=>{const f=setup();f.input.rooms[0].queue.push({id:'done',status:'done',finishedAt:f.now()});f.board.update(f.input);f.board.open();const count=tab=>f.host.querySelectorAll('.task-board-tab').find(b=>b.dataset.boardTab===tab).dataset.count;assert.deepEqual([count('sent'),count('done')],['1','1']);f.advance(86400000);assert.equal(count('sent'),'1');assert.equal(count('done'),'1');f.board.dispose();});
test('dispose detaches contents, observers and listeners without a countdown lease',()=>{const f=setup();f.board.dispose();assert.equal(f.host.children.length,0);assert.equal(f.timers.size,0);assert.equal(f.win.listeners.get('resize')?.size||0,0);assert.equal(f.doc.listeners.get('visibilitychange')?.size||0,0);f.advance(1000);});

test('the card link delegates only its stable identity to the existing confirmation path',()=>{const f=setup();let opened;f.board.dispose();f.board=board.bind({host:f.host,document:f.doc,text:(k,p)=>locale.format('zh',k,p),onQueue(){},onConfirmation:r=>opened=r,now:f.now});f.input.confirmations=[{key:'actor:native:operation',id:'message',sessionId:'actor',nativeId:'native',operationId:'operation',state:'confirmation-required',actionable:true,expiresAt:f.now()+100000}];f.board.update(f.input);f.board.open();f.host.querySelector('.task-board-card-link').fire('click');assert.deepEqual(opened,{sessionId:'actor',nativeId:'native',operationId:'operation',messageId:'message',history:true});assert.equal(f.host.querySelector('.task-board-panel').matches(':popover-open'),false);f.board.dispose();});

test('global progression exposes ten at a time with the complete matching total',()=>{
 for(const lang of ['zh','en']){
  const f=setup(lang),format=(k,p)=>locale.format(lang,k,p);
  f.input.rooms[0].queue.push(...Array.from({length:21},(_,i)=>({id:'queued'+i,status:'queued',text:'Synthetic queued '+i})));f.board.update(f.input);f.board.open();
  const more=f.host.querySelector('.task-board-more'),rows=()=>f.host.querySelectorAll('.task-board-task').length;
  assert.deepEqual([rows(),more.textContent],[10,format('taskBoard.earlier',{count:10,total:23})]);
  more.fire('click');assert.deepEqual([rows(),more.textContent],[20,format('taskBoard.earlier',{count:3,total:23})]);
  more.fire('click');assert.deepEqual([rows(),more.textContent,more.getAttribute('aria-disabled')],[23,format('taskBoard.allShown'),'true']);
  f.board.dispose();
 }
});

test('ordinary waiting is neutral, complete and separate from review',()=>{
 for(const lang of ['zh','en']){const f=setup(lang);f.input.rooms[0].queue.push({id:'wait',status:'waiting'},{id:'ip',status:'waiting',reason:'input-purpose-unconfirmed'});f.board.update(f.input);
  assert.equal(f.button.textContent.includes(lang==='zh'?'至少':'At least'),false);
  assert.equal(f.host.querySelector('.task-status-card-time').hidden,true);
  assert.equal(f.host.querySelector('.task-status-warning').hidden,true);
  f.board.open();const count=k=>f.host.querySelectorAll('.task-board-tab').find(b=>b.dataset.boardTab===k).dataset.count;
  assert.equal(count('waiting'),'1');assert.equal(count('review'),'2');
  const reviews=[...f.host.querySelectorAll('.task-board-entry')].filter(e=>e.dataset.kind==='review');assert.equal(reviews.length,2);
  assert.ok(reviews.every(e=>e.textContent.includes(lang==='zh'?'待查看':'To review')));
  f.board.dispose();}
});
test('unverified sources get their own neutral chip without claiming an exact total',()=>{
 for(const lang of ['zh','en']){const f=setup(lang);f.input.rooms[0].queue.push({id:'wait',status:'waiting'});f.input.rooms.push(...Array.from({length:7},(_,i)=>({id:'off'+i,name:'Off '+i,unavailable:true})));f.board.update(f.input);
  const warn=f.host.querySelector('.task-status-warning');
  assert.equal(warn.textContent,lang==='zh'?'7 件待核实':'7 to verify');
  assert.equal(warn.hidden,false);assert.equal(warn.classList.contains('failed'),false);
  assert.equal(f.host.querySelector('.task-status-card-time').hidden,true);
  f.board.dispose();}
});
test('only a failure, not an unverified status, marks the warning chip',()=>{
 for(const lang of ['zh','en']){const f=setup(lang);f.input.rooms[0].queue.push({id:'bad',status:'failed'});f.board.update(f.input);
  const warn=f.host.querySelector('.task-status-warning');
  assert.equal(warn.textContent,lang==='zh'?'1 件异常':'1 failed');assert.equal(warn.classList.contains('failed'),true);
  f.input.connected=false;f.board.update(f.input);assert.equal(warn.classList.contains('failed'),false);
  f.board.dispose();}
});
test('an unverifiable card is listed for checking without an urgent chip or countdown',()=>{
 for(const lang of ['zh','en']){const f=setup(lang);f.input.confirmations=[{key:'actor:native:operation',id:'message',sessionId:'actor',nativeId:'native',operationId:'operation',state:'unverifiable',actionable:false,expiresAt:f.now()+100000}];f.board.update(f.input);
  assert.equal(f.host.querySelector('.task-status-card-time').hidden,true);
  assert.equal(f.host.querySelector('.task-status-warning').textContent,lang==='zh'?'1 件待核实':'1 to verify');
  f.board.open();f.host.querySelector('[data-board-tab="unknown"]').fire('click');const row=f.host.querySelectorAll('.task-board-entry').find(e=>e.dataset.kind==='unknown'),state=row.querySelector('.task-board-status').textContent;
  assert.equal(state,locale.format(lang,'taskBoard.cardsUnverified'));
  assert.equal(/[0-9]+:[0-9]{2}/.test(state),false);
  f.board.dispose();}
});
test('unavailable cards are counted once, in the neutral chip',()=>{
 for(const lang of ['zh','en']){const f=setup(lang);f.input.confirmationsAvailable=false;f.board.update(f.input);
  assert.equal(f.host.querySelector('.task-status-card-time').hidden,true);
  assert.equal(f.host.querySelector('.task-status-warning').textContent,lang==='zh'?'1 件待核实':'1 to verify');
  f.board.dispose();}
});
test('a dispatched review keeps its reason on the row before opening the session',()=>{
 for(const lang of ['zh','en']){const f=setup(lang);let opened;f.board.dispose();
  f.input.rooms[0].queue.push({id:'ip',status:'waiting',reason:'input-purpose-unconfirmed',text:'Synthetic dispatched purpose',sentTo:'member',sentNative:'native'});
  f.input.rooms[0].queue[1]={...f.input.rooms[0].queue[1],sentTo:'member',sentNative:'native'};
  f.board=board.bind({host:f.host,document:f.doc,text:(k,p)=>locale.format(lang,k,p),onQueue(){},onSession:(...args)=>opened=args,now:f.now});
  f.board.update(f.input);f.board.open();f.host.querySelector('[data-board-tab="review"]').fire('click');
  const purpose=f.host.querySelectorAll('.task-board-entry').find(e=>e.dataset.itemId==='ip'),reply=f.host.querySelectorAll('.task-board-entry').find(e=>e.dataset.itemId==='review');
  assert.ok(purpose.textContent.includes(locale.format(lang,'taskBoard.reasonInputPurposeUnconfirmed')));
  assert.ok(reply.textContent.includes(locale.format(lang,'taskBoard.reasonNoReply')));
  assert.ok(purpose.textContent.includes('Synthetic member'));
  purpose.fire('click');assert.equal(opened[0],'member');
  assert.equal(f.host.querySelector('.task-board-panel').matches(':popover-open'),false);
  f.board.dispose();}
});

test('unverifiable cards take neither the card countdown nor the card chip target', () => {
  for (const lang of ['zh', 'en']) {
    const f = setup(lang), start = f.now();
    let opened;
    f.board.dispose();
    f.board = board.bind({ host: f.host, document: f.doc, text: (k, p) => locale.format(lang, k, p), onQueue() {}, onConfirmation: r => opened = r, now: f.now });
    f.input.rooms[0].queue = []; f.input.sessions = [];
    f.input.confirmations = [
      ...Array.from({ length: 8 }, (_, i) => ({ key: 'actor:unknown' + i, id: 'message' + i, sessionId: 'actor', nativeId: 'native', operationId: 'operation' + i, state: 'unverifiable', actionable: false, expiresAt: start + 1000 + i })),
      { key: 'actor:native:operation', id: 'message', sessionId: 'actor', nativeId: 'native', operationId: 'operation', state: 'confirmation-required', actionable: true, expiresAt: start + 100000 }
    ];
    f.board.update(f.input);
    const chip = f.host.querySelector('.task-status-card-time');
    assert.equal(chip.textContent, locale.format(lang, 'taskBoard.cardChipTime', { time: '1:40' }));
    chip.fire('click');
    assert.equal(opened.operationId, 'operation');
    f.board.dispose();
  }
});

test('a finished row does not keep a review reason beside Done', () => {
  for (const lang of ['zh', 'en']) {
    const f = setup(lang);
    f.input.rooms[0].queue.push({ id: 'done', status: 'done', reason: 'person-intervened', text: 'Synthetic finished', finishedAt: f.now() });
    f.board.update(f.input); f.board.open();
    f.host.querySelector('[data-board-tab="done"]').fire('click');
    const row = f.host.querySelectorAll('.task-board-entry').find(e => e.dataset.itemId === 'done');
    assert.ok(row.querySelector('.task-board-status').textContent.includes(locale.format(lang, 'taskBoard.status.done')));
    assert.equal(row.querySelector('small').textContent.includes(locale.format(lang, 'taskBoard.reasonIntervened')), false);
    f.board.dispose();
  }
});
