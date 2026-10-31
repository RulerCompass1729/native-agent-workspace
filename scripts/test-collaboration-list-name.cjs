// One bounded source GUI with synthetic native output; no real provider or model.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
assert.ok(process.env.NAW_EVIDENCE_DIR,'NAW_EVIDENCE_DIR is required for this bounded GUI check');
const out=path.resolve(process.env.NAW_EVIDENCE_DIR),picture=out;
let existing=out;while(!fs.existsSync(existing))existing=path.dirname(existing);
const destination=path.join(fs.realpathSync(existing),path.relative(existing,out));
assert.ok(destination!==fs.realpathSync(root)&&!destination.startsWith(fs.realpathSync(root)+path.sep),'Evidence must stay outside the source tree');
if(fs.existsSync(out))assert.equal(fs.readdirSync(out).length,0,'Use a new empty evidence directory');
fs.mkdirSync(out,{recursive:true,mode:0o700});
const scratch=require(path.join(root,'scripts/fixtures/test-scratch.cjs')),{createIn}=require(path.join(root,'scripts/fixtures/create-view.cjs')),{_electron}=scratch.playwright(require('playwright'));
const common=require('node:child_process').execFileSync('git',['rev-parse','--path-format=absolute','--git-common-dir'],{cwd:root,encoding:'utf8'}).trim();
const slot=path.join(path.dirname(common),'.local/gui-test-slot.lock'),token=crypto.randomUUID();
let profile,child,app,page,seq=0,stage='acquire',failure=null,guiPID,daemonPID,lease=false,timer;const checks=[],measurements=[],errors=[];let stopped=false,runPromise;const checkStop=()=>{if(stopped)throw Error('Finite GUI run stopped');};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,ms=5000){const end=Date.now()+ms;while(Date.now()<end){checkStop();const ok=await fn();checkStop();if(ok)return;await delay(50);}throw Error(label);}
function fixture(method,target,value){if(stopped&&method!=='stats')throw Error('Finite GUI run stopped');const id=++seq;return new Promise((resolve,reject)=>{const done=q=>{if(q.requestId===id){clearTimeout(t);child.off('message',done);q.error?reject(Error(q.error)):resolve(q);}};const t=setTimeout(()=>{child.off('message',done);reject(Error('Owned fixture response timeout'));},8000);child.on('message',done);child.send({id,method,target,value});});}
const snapshot=()=>page.evaluate(()=>workspace.initial());
async function shot(name){await page.screenshot({path:path.join(picture,name+'.png')});}
async function measure(name,ids,firstLines,messageIDs){
  checkStop();
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  const rows=await page.locator('#collaboration-overview').evaluate((host,{ids,firstLines,messageIDs})=>{
    const clip=host.querySelector('.collaboration-readers').getBoundingClientRect();
    return ids.map((id,i)=>{
      const unit=host.querySelector(`.collaboration-member-unit[data-member-id="${id}"]`),header=host.querySelector(`.collaboration-member-status[data-member-id="${id}"]`),reader=host.querySelector(`.collaboration-member-reader[data-member-id="${id}"]`),messages=reader.querySelector('.messages'),label=header.querySelector('.collaboration-member-name'),suffix=header.querySelector('.collaboration-name-suffix'),next=header.querySelector('.collaboration-member-next'),targetRow=messages.querySelector(`[data-message-id="${CSS.escape(messageIDs[i])}"]`),body=targetRow.querySelector('.message-body');
      const rb=reader.getBoundingClientRect(),mb=messages.getBoundingClientRect(),hb=header.getBoundingClientRect(),nb=label.getBoundingClientRect(),sb=suffix.getBoundingClientRect(),ub=unit.getBoundingClientRect(),nextBox=next.getBoundingClientRect();
      const walker=document.createTreeWalker(body,NodeFilter.SHOW_TEXT),nodes=[];let text='',current;
      while(current=walker.nextNode()){nodes.push({node:current,start:text.length});text+=current.nodeValue;}
      const begin=text.indexOf(firstLines[i]),end=begin+firstLines[i].length;let rects=[],glyphRects=[];
      if(begin>=0){const a=nodes.findLast(n=>n.start<=begin),b=nodes.findLast(n=>n.start<end),range=document.createRange();range.setStart(a.node,begin-a.start);range.setEnd(b.node,end-b.start);rects=[...range.getClientRects()].filter(r=>r.width>0&&r.height>0).map(r=>({top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height}));for(let c=begin;c<end;c++){const x=nodes.findLast(n=>n.start<=c),y=nodes.findLast(n=>n.start<c+1),glyph=document.createRange();glyph.setStart(x.node,c-x.start);glyph.setEnd(y.node,c+1-y.start);for(const z of glyph.getClientRects())if(z.width>0&&z.height>0)glyphRects.push({left:z.left,right:z.right,top:z.top,bottom:z.bottom});}}
      const top=Math.max(rb.top,mb.top,clip.top,hb.bottom,0),bottom=Math.min(rb.bottom,mb.bottom,clip.bottom,innerHeight),left=Math.max(rb.left,mb.left,clip.left,0),right=Math.min(rb.right,mb.right,clip.right,innerWidth);
      const paint=glyphRects.map(r=>{const hit=document.elementFromPoint((r.left+r.right)/2,(r.top+r.bottom)/2);return{insideBody:Boolean(hit&&body.contains(hit)),tag:hit?.tagName||null,className:typeof hit?.className==='string'?hit.className:null};});
      const targetBox=targetRow.getBoundingClientRect();
      const row=[...messages.querySelectorAll(':scope > [data-message-id]')].find(n=>n.getBoundingClientRect().bottom>mb.top);
      return{id,label:label.textContent,title:label.title,rawName:header.querySelector('.collaboration-name-text').textContent,headerParent:header.parentElement.dataset.memberId,unitHeight:ub.height,headerHeight:hb.height,readerHeight:rb.height,messagesHeight:mb.height,header:{top:hb.top,bottom:hb.bottom,left:hb.left,right:hb.right},suffixInside:sb.left>=nb.left-1&&sb.right<=nb.right+1,nameRevealed:label.classList.contains('is-revealed'),scroll:{top:messages.scrollTop,client:messages.clientHeight,height:messages.scrollHeight,remaining:messages.scrollHeight-messages.scrollTop-messages.clientHeight},anchor:row?.dataset.messageId||'',offset:row?row.getBoundingClientRect().top-mb.top:null,targetMessageID:messageIDs[i],targetOffset:targetBox.top-mb.top,firstGlyphRelativeToTarget:rects.length?rects[0].top-targetBox.top:null,paintHits:paint,firstLine:firstLines[i],firstLineFound:begin>=0,firstLineRects:rects,firstLineFullyVisible:rects.length>0&&rects.every(r=>r.top>=top-0.25&&r.bottom<=bottom+0.25&&r.left>=left-0.25&&r.right<=right+0.25)&&paint.every(p=>p.insideBody),clip:{top,bottom,left,right},nextLabel:next.textContent,nextBox:{top:nextBox.top,bottom:nextBox.bottom,left:nextBox.left,right:nextBox.right,height:nextBox.height},activeNext:document.activeElement===next};
    });
  },{ids,firstLines,messageIDs});
  const state=await snapshot(),reading=state.viewState.readingPositions||{};
  const result={name,at:new Date().toISOString(),window:await page.evaluate(()=>[innerWidth,innerHeight]),sidebar:await page.locator('.naw[data-native-surface="sidebar"]').getAttribute('data-collapsed'),archiveExpanded:await page.locator('#archive-button').getAttribute('aria-expanded'),selected:state.viewState.selected,rows:rows.map(row=>{const keys=Object.keys(reading).filter(k=>k.startsWith('collaboration:')&&k.endsWith(':'+row.id));return{...row,readingKeys:keys,saved:keys.length===1?reading[keys[0]]:null};})};
  measurements.push(result);fs.writeFileSync(path.join(picture,'measurements.json'),JSON.stringify(measurements,null,2));await shot(name);return result;
}
async function settleLayout(label){
  const started=Date.now();let previous='',stableSince=Date.now();
  await until(async()=>{
    const state=await page.evaluate(()=>{
      const changing=[...document.querySelectorAll('[data-animating]')].some(n=>n.getAttribute('data-animating')!=='false');
      const animated=document.getAnimations().some(a=>a.playState==='running'&&a.effect?.getTiming().iterations!==Infinity);
      const boxes=[...document.querySelectorAll('.naw[data-native-surface=sidebar],.collaboration-member-status,.collaboration-member-reader')].map(n=>{const b=n.getBoundingClientRect();return[b.x,b.y,b.width,b.height].map(x=>Math.round(x*100)/100);});
      return{changing,animated,boxes};
    });
    const value=JSON.stringify(state.boxes);if(value!==previous){previous=value;stableSince=Date.now();}
    return!state.changing&&!state.animated&&Date.now()-stableSince>=150&&Date.now()-started>=350;
  },label,10000);
}
function firstLineOracle(frame,index,anchor){const row=frame.rows[index];assert.ok(anchor.saved.top>80&&Math.abs(anchor.offset)>=2.5,'A non-first positive saved bookmark is required');assert.ok(row.firstLineFullyVisible,'The exact original FIRST text line is fully inside this reader');assert.equal(row.anchor,anchor.anchor,'Original manual message anchor survives');assert.ok(Math.abs(row.offset-anchor.offset)<=1,'Original manual anchor offset survives');assert.ok(row.saved&&row.saved.anchor===anchor.saved.anchor&&row.saved.follow===false,'Positive saved original reading state survives');assert.ok(Math.abs(row.saved.offset-anchor.saved.offset)<=1,'Persisted original offset survives');}
async function run(){
  checkStop();stage='owned synthetic setup';profile=scratch.directory(path.join(os.tmpdir(),'naw-list-name-'));const workspaceRoot=path.join(profile,'workspace');fs.mkdirSync(workspaceRoot);
  child=scratch.childProcess.fork(path.join(root,'app/daemon.cjs'),[profile],{execArgv:['--require',path.join(root,'scripts/fixtures/loading-terminal.cjs')],env:{...process.env,NAW_TEST_APP_ROOT:root,NAW_WORKSPACE:workspaceRoot,NAW_APP_VERSION:require(path.join(root,'package.json')).version},stdio:['ignore','ignore','inherit','ipc']});daemonPID=child.pid;
  await until(()=>fs.existsSync(path.join(profile,'connection.json')),'Own daemon connection',10000);
  checkStop();app=await _electron.launch({executablePath:require('electron'),args:[root],env:{...process.env,NAW_DATA_DIR:profile,NAW_TEST_PARENT_PID:String(process.pid)},timeout:70000});guiPID=app.process().pid;page=await app.firstWindow();page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));await page.locator('#new-session').waitFor();const initial=await snapshot();assert.equal(initial.sessions.length,0);assert.ok(fs.realpathSync(initial.defaultWorkspace).startsWith(fs.realpathSync(profile)+path.sep));
  const longName=('\u5b8c\u5168\u91cd\u590d\u7684\u5f88\u957f\u6210\u5458\u540d').repeat(6),names=['Same agent','Same agent',longName,longName],ids=[],texts=[],firstLines=[];
  for(let i=0;i<4;i++){
    checkStop();const previous=new Set((await snapshot()).sessions.map(s=>s.id));await page.locator('#new-session').click();await page.locator('input[name="provider"][value="codex"]').check();await page.locator('#session-name').fill(names[i]);await createIn(page,'chat');const s=(await snapshot()).sessions.find(s=>!previous.has(s.id));assert.ok(s);ids.push(s.id);
    firstLines.push('Member '+i+' FIRST original.');texts.push(Array.from({length:3},(_,j)=>[j===1?firstLines[i]:'Original member '+i+' message '+j+' FIRST line.',...Array.from({length:11},(_,n)=>'Original member '+i+' message '+j+' paragraph '+(n+2)+'.')].join('\n\n')));
    await fixture('history',s.id,texts[i].map((text,j)=>({id:'expanded-'+i+'-'+j,type:'agentMessage',turnId:'turn-'+i+'-'+j,text})));await page.locator('#message-input').fill('UNSENT own draft '+i);await until(async()=>(await snapshot()).sessions.find(x=>x.id===s.id).liveDraft==='UNSENT own draft '+i,'Own draft persisted');await page.evaluate(id=>workspace.join(id,true),s.id);
  }
  await page.locator('#room-nav').click();const overview=page.locator('#collaboration-overview');await overview.waitFor();const layouts=page.locator('.collaboration-layout-controls');assert.equal(await layouts.count(),1);const listButton=layouts.locator('button').nth(1);assert.ok(['List','\u5217\u8868'].includes(await listButton.innerText()));await listButton.click();await(await app.browserWindow(page)).evaluate(win=>win.setContentSize(850,600));await until(async()=>await overview.getAttribute('data-list-units')==='true','Actual list mode');
  const reader=id=>overview.locator(`.collaboration-member-reader[data-member-id="${id}"] .messages`),header=id=>overview.locator(`.collaboration-member-status[data-member-id="${id}"]`),name=id=>header(id).locator('.collaboration-member-name');
  for(const id of ids)await reader(id).locator('.message-body').first().waitFor({state:'attached'});
  await page.locator('#shared-input').fill('UNSENT own shared draft');await until(async()=>(await snapshot()).viewState.sharedDraft==='UNSENT own shared draft','Positive shared draft persisted');
  const identity=await snapshot(),messageIDs=ids.map((id,i)=>{const matches=identity.sessions.find(s=>s.id===id).messages.filter(m=>m.text===texts[i][1]);assert.equal(matches.length,1);return matches[0].id;});fs.writeFileSync(path.join(picture,'before-state.json'),JSON.stringify(identity,null,2));
  checkStop();stage='positive non-first manual FIRST-line anchors';
  await measure('00-initial-context-selected-message1',ids,firstLines,messageIDs);
  for(const index of [2,3]){
    await reader(ids[index]).focus();await reader(ids[index]).hover();
    const current=await measure('01-before-manual-wheel-member'+index,ids,firstLines,messageIDs),target=current.rows[index];
    assert.ok(target.firstLineRects.length>0&&target.firstGlyphRelativeToTarget>3,'Measured text geometry supports a visible nonzero bookmark');
    const lineHeight=Math.max(...target.firstLineRects.map(r=>r.bottom))-Math.min(...target.firstLineRects.map(r=>r.top)),availableHeight=target.clip.bottom-target.clip.top,inset=Math.min(8,(availableHeight-lineHeight)/2,target.firstGlyphRelativeToTarget-3);
    assert.ok(inset>=1&&lineHeight+2<=availableHeight,'Measured FIRST-line must fit with positive top/bottom margin before wheel');
    const desiredOffset=inset-target.firstGlyphRelativeToTarget,delta=target.firstLineRects[0].top-target.clip.top-inset;
    await page.mouse.wheel(0,delta);
    await until(async()=>{
      const state=(await snapshot()).viewState.readingPositions||{},keys=Object.keys(state).filter(k=>k.startsWith('collaboration:')&&k.endsWith(':'+ids[index]));
      const dom=await reader(ids[index]).evaluate((el,messageID)=>{const row=el.querySelector(`[data-message-id="${CSS.escape(messageID)}"]`);return{top:el.scrollTop,offset:row.getBoundingClientRect().top-el.getBoundingClientRect().top};},messageIDs[index]);
      return keys.length===1&&state[keys[0]].anchor===messageIDs[index]&&state[keys[0]].follow===false&&state[keys[0]].top>80&&Math.abs(state[keys[0]].offset-desiredOffset)<=1&&Math.abs(dom.offset-desiredOffset)<=1&&dom.top>80;
    },'Actual non-first saved bookmark/offset established by wheel, not reset-to-top');
  }
  const before=await measure('02-positive-manual-message1-before-sidebar',ids,firstLines,messageIDs);assert.equal(before.sidebar,'true','Collapsed sidebar is a mandatory starting condition; no vacuous expanded pass');
  for(const i of [2,3]){assert.ok(before.rows[i].firstLineFullyVisible,'Selected original message FIRST-line precondition');assert.equal(before.rows[i].anchor,messageIDs[i]);assert.ok(before.rows[i].saved&&before.rows[i].saved.follow===false&&before.rows[i].saved.top>80&&Math.abs(before.rows[i].offset)>=2.5);}
  checks.push('Actual non-first message FIRST-line bookmarks and nonzero offsets are positive before the missing scenario');
  checkStop();stage='exact existing archive control expands sidebar';assert.equal(await page.locator('.naw[data-native-surface="sidebar"]').getAttribute('data-collapsed'),'true');{const archive=page.locator('#archive-button');assert.equal(await archive.count(),1);await archive.click();await until(async()=>await page.locator('.naw[data-native-surface="sidebar"]').getAttribute('data-collapsed')==='false'&&await archive.getAttribute('aria-expanded')==='true','One exact Archive click expands sidebar/group');}
  await settleLayout('Sidebar transition ends and reader/header geometry stabilizes');
  const expanded=await measure('03-expanded-sidebar-manual-first-line',ids,firstLines,messageIDs);assert.equal(expanded.sidebar,'false');for(const i of [2,3])firstLineOracle(expanded,i,before.rows[i]);checks.push('Expanded sidebar preserves exact saved FIRST lines before keyboard navigation');
  checkStop();stage='expanded sidebar keyboard next and exact reading context';await name(ids[2]).focus();await page.keyboard.press('Tab');await page.keyboard.press('Tab');const next=header(ids[2]).locator('.collaboration-member-next');assert.equal(await next.evaluate(el=>document.activeElement===el),true);
  const focusedNext=await measure('04-expanded-next-control-visible',ids,firstLines,messageIDs),n=focusedNext.rows[2];assert.ok(n.activeNext);assert.ok(n.nextLabel.includes(focusedNext.rows[3].title));assert.ok(n.nextBox.top>=n.header.top-1&&n.nextBox.bottom<=n.header.bottom+1&&n.nextBox.left>=n.header.left-1&&n.nextBox.right<=n.header.right+1&&n.nextBox.height>0,'Focused exact next-member label stays inside its own header');
  await page.keyboard.press('Enter');assert.equal(await name(ids[3]).evaluate(el=>document.activeElement===el),true);await settleLayout('Revealed long name layout stabilizes after keyboard Next');const final=await measure('05-expanded-keyboard-next-first-line-context',ids,firstLines,messageIDs);assert.equal(new Set(final.rows.map(x=>x.title)).size,4);for(const row of final.rows){assert.equal(row.headerParent,row.id);assert.ok(row.suffixInside);}for(const i of [2,3])firstLineOracle(final,i,before.rows[i]);checks.push('Expanded sidebar keyboard next retains both exact manual FIRST lines and disambiguated identities');
  assert.equal(final.rows[3].rawName,names[3]);assert.equal(final.rows[3].nameRevealed,true);
  const fullName=await name(ids[3]).evaluate(el=>[el.querySelector('.collaboration-name-text'),el.querySelector('.collaboration-name-suffix')].map(n=>{const range=document.createRange();range.selectNodeContents(n);const h=el.closest('.collaboration-member-status').getBoundingClientRect();return{raw:n.textContent,inside:[...range.getClientRects()].filter(r=>r.width>0&&r.height>0).every(r=>r.left>=h.left-0.25&&r.right<=h.right+0.25&&r.top>=h.top-0.25&&r.bottom<=h.bottom+0.25)};}));
  assert.ok(fullName.every(n=>n.raw&&n.inside),'Full original name and identity suffix stay inside their own header');
  checkStop();stage='settled negative control';
  // Reproduce the original display value as a negative control in this same owned window.
  const oldFlow=await name(ids[3]).evaluate(el=>{const prior={value:el.style.getPropertyValue('display'),priority:el.style.getPropertyPriority('display')};el.style.setProperty('display','flex');return prior;});
  await settleLayout('Original flex negative control settles');const red=await measure('06-original-flex-negative-control',ids,firstLines,messageIDs);
  assert.equal(await name(ids[3]).evaluate(el=>getComputedStyle(el).display),'flex');
  assert.ok(red.rows[3].readerHeight<red.rows[3].firstLineRects[0].height&&!red.rows[3].firstLineFullyVisible,'Original flex flow leaves less than one original line');
  checkStop();stage='actual source restoration';
  await name(ids[3]).evaluate((el,prior)=>{if(prior.value)el.style.setProperty('display',prior.value,prior.priority);else el.style.removeProperty('display');},oldFlow);await settleLayout('Actual source stylesheet settles after control removal');
  const restored=await measure('07-actual-source-restored',ids,firstLines,messageIDs);for(const i of [2,3])firstLineOracle(restored,i,before.rows[i]);
  checks.push('Settled original-flex negative control fails; actual source flow preserves full name/suffix and both original first lines');
  checkStop();stage='Grid and list return';
  await layouts.locator('button').first().click();await settleLayout('Grid control settles');
  assert.equal(await name(ids[3]).evaluate(el=>getComputedStyle(el).display),'flex','Grid name flow keeps its original display');
  await listButton.click();await settleLayout('List return settles');const returned=await measure('08-list-return-context',ids,firstLines,messageIDs);for(const i of [2,3])firstLineOracle(returned,i,before.rows[i]);
  checks.push('Grid layout remains unchanged and list return preserves original reading context');
  const visibleLines=firstLines.map((line,i)=>i<2?texts[i][2].split('\n\n').at(-1):line),visibleIDs=messageIDs.map((id,i)=>i<2?'expanded-'+i+'-2':id);
  const four=await measure('09-four-original-lines-visible',ids,visibleLines,visibleIDs);
  assert.ok(four.rows.every(row=>row.firstLineFullyVisible),'All four attached identities retain one fully painted original text line');
  checks.push('All four original readers have a complete original text line after the complete path');


  checkStop();const after=await snapshot(),facts=s=>s.sessions.map(x=>[x.id,x.nativeId,x.owner,x.liveDraft,x.cwd]).sort();assert.equal(JSON.stringify(facts(after)),JSON.stringify(facts(identity)));assert.equal(after.viewState.selected,identity.viewState.selected);assert.equal(after.viewState.sharedDraft,identity.viewState.sharedDraft);const stats=await fixture('stats');assert.equal(stats.inputs.length,0);assert.equal(stats.sends.length,0);assert.equal(after.diagnostics.dispatches,0);assert.equal(after.diagnostics.shellModelCalls,0);assert.deepEqual(errors,[]);fs.writeFileSync(path.join(picture,'after-state.json'),JSON.stringify(after,null,2));fs.writeFileSync(path.join(picture,'fixture-stats.json'),JSON.stringify(stats,null,2));stage='complete';
}
(async()=>{
 try{fs.mkdirSync(slot);lease=true;}catch(e){if(e.code!=='EEXIST')throw e;fs.writeFileSync(path.join(out,'gui-slot-occupied.json'),JSON.stringify({at:new Date().toISOString(),exit:75,noLaunch:true}));console.log('Canonical GUI slot occupied; no profile/process launch.');process.exitCode=75;return;}
 fs.writeFileSync(path.join(slot,'owner.json'),JSON.stringify({owner:'Codex2',task:'T91 revealed list name source regression',token,pid:process.pid,time:new Date().toISOString()}));
 try{runPromise=run();await Promise.race([runPromise,new Promise((_,reject)=>{timer=setTimeout(()=>{stopped=true;reject(Error('180s finite GUI budget reached'));},180000);})]);}
 catch(e){failure={stage,error:e.stack};process.exitCode=1;if(page&&!page.isClosed()){try{await shot('failure');fs.writeFileSync(path.join(picture,'failure.txt'),await page.locator('body').innerText());fs.writeFileSync(path.join(picture,'failure-state.json'),JSON.stringify(await snapshot(),null,2));}catch{}}console.error('GUI_FAILURE '+JSON.stringify(failure));}
 finally{clearTimeout(timer);stopped=true;
 try{if(child?.connected){try{fs.writeFileSync(path.join(picture,'final-fixture-stats.json'),JSON.stringify(await fixture('stats'),null,2));}catch(e){fs.writeFileSync(path.join(out,'counter-read-failure.json'),JSON.stringify({error:e.message}));}}
 fs.writeFileSync(path.join(out,'gui-result.json'),JSON.stringify({at:new Date().toISOString(),stage,failure,checks,measurements,errors,profile,guiPID,daemonPID,token,picture,sourceOnly:true,GUIlaunches:1,realProviders:0,productModels:0,OSClipboardWrites:0},null,2));
 }finally{
 try{await scratch.release();
 if(runPromise)await runPromise.catch(()=>{});
 for(const pid of [guiPID,daemonPID].filter(Boolean)){try{process.kill(pid,0);throw Error('Owned PID still exists '+pid);}catch(e){if(e.code!=='ESRCH')throw e;}}assert.ok(!profile||!fs.existsSync(profile));
 const owner=JSON.parse(fs.readFileSync(path.join(slot,'owner.json')));
 assert.equal(owner.token,token);
 fs.unlinkSync(path.join(slot,'owner.json'));
 fs.rmdirSync(slot);
 fs.writeFileSync(path.join(out,'gui-released.json'),JSON.stringify({at:new Date().toISOString(),token,guiPID,daemonPID,pids:'ESRCH',profileGone:true,slotReleased:true},null,2));
 console.log('OWNED_GUI_CLEANED_SLOT_RELEASED');}
 catch(e){process.exitCode=1;
 fs.writeFileSync(path.join(out,'gui-cleanup-failure.json'),JSON.stringify({error:e.stack,token}));
 console.error('Owned cleanup unconfirmed; lease retained: '+e.stack);}}}
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
