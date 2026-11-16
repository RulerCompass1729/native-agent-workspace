// One hidden, synthetic service/profile. OS opening is replaced before any click.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const scratch=require('./fixtures/test-scratch.cjs'),{createIn}=require('./fixtures/create-view.cjs');
const {_electron}=scratch.playwright(require('playwright'));
const root=path.resolve(__dirname,'..'),profile=scratch.directory(path.join(os.tmpdir(),'naw-cmd-click-'));
const child=scratch.childProcess.fork(path.join(root,'app/daemon.cjs'),[profile],{execArgv:['--require',path.join(__dirname,'fixtures/native-progress.cjs')],env:{...process.env,NAW_APP_VERSION:require('../package.json').version,NAW_WORKSPACE:path.join(profile,'workspace')},stdio:['ignore','ignore','inherit','ipc']});
let app,page,seq=0;const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check,label){for(let n=0;n<120;n++){if(await check())return;await delay(50);}throw Error(label);}
function fixture(method,target,value){const id=++seq;return new Promise((resolve,reject)=>{const done=p=>{if(p.requestId===id){clearTimeout(timer);child.off('message',done);p.error?reject(Error(p.error)):resolve(p);}};const timer=setTimeout(()=>{child.off('message',done);reject(Error('Fixture timeout'));},10000);child.on('message',done);child.send({id,method,target,value});});}
const calls=()=>app.evaluate(()=>globalThis.pathCalls);
async function shot(name){if(process.env.NAW_SCREENSHOTS_DIR){fs.mkdirSync(process.env.NAW_SCREENSHOTS_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.NAW_SCREENSHOTS_DIR,name+'.png')});}}
async function run(){
 console.log('NAW_MOUSE_LINK_PROBE='+(process.env.NAW_MOUSE_LINK_PROBE||'0'));
 await until(()=>fs.existsSync(path.join(profile,'connection.json')),'Service bootstrap');
 app=await _electron.launch({executablePath:require('electron'),args:[root],env:{...process.env,NAW_DATA_DIR:profile,NAW_TEST_PARENT_PID:String(process.pid)},timeout:60000});
 page=await app.firstWindow();page.setDefaultTimeout(10000);await page.locator('#new-session').waitFor();
 await app.evaluate(({shell},owned)=>{globalThis.pathCalls=[];const fs=process.getBuiltinModule('node:fs');const safe=p=>{if(!fs.realpathSync(p).startsWith(fs.realpathSync(owned)+'/'))throw Error('Outside owned fixture');};shell.openPath=async p=>{safe(p);pathCalls.push({kind:'open',path:p});return '';};shell.showItemInFolder=p=>{safe(p);pathCalls.push({kind:'reveal',path:p});};shell.openExternal=async url=>pathCalls.push({kind:'web',url});},profile);
 assert.equal((await page.evaluate(()=>workspace.initial())).servicePid,child.pid,'GUI must retain the synthetic service before any session creation');
 await page.locator('#new-session').click();await page.locator('input[name="provider"][value="codex"]').check();await page.locator('#session-name').fill('Path shortcuts');await createIn(page,'chat');
 await until(async()=>(await page.evaluate(()=>workspace.initial())).sessions.some(s=>s.state==='idle'),'Synthetic session ready');
 const session=(await page.evaluate(()=>workspace.initial())).sessions[0],id=session.id;
 const file=path.join(profile,'图片 sample.png'),script=path.join(profile,'do-not-run.sh');fs.writeFileSync(file,'synthetic picture');fs.writeFileSync(script,'do not run',{mode:0o600});const notes=path.join(profile,'notes.md'),folder=path.join(profile,'A folder');fs.writeFileSync(notes,'synthetic');fs.mkdirSync(folder);const joined=path.join(profile,'hardbreakwrong.png');fs.writeFileSync(joined,'must not open');
 const text='Inline: `'+file+'`\n\nPlain: '+file+'\n\nLocation: `'+notes+':12`\n\nFolder: `'+folder+'`\n\nExecutable: `'+script+'`\n\n[Existing web link](https://example.com/path)\n\nHardbreak: '+path.join(profile,'hardbreak')+'  \nwrong.png';
 await fixture('nativeBlock',id,{id:'cmd-path',kind:'response',text,status:'complete'});
 const code=page.locator('.naw-markdown code').filter({hasText:file});await code.waitFor();
 await code.click();assert.equal((await calls()).length,0,'Ordinary inline-code click preserves selection behavior');
 const box=await code.boundingBox();await page.mouse.move(box.x+8,box.y+9);await page.mouse.down();await page.mouse.move(box.x+100,box.y+9,{steps:10});await page.mouse.up();assert.ok(await page.evaluate(()=>getSelection().toString().length>0),'Ordinary drag still selects native Markdown text');assert.equal((await calls()).length,0);

 await code.click({modifiers:['Meta']});await delay(700);
 assert.equal((await calls()).filter(c=>c.kind==='open').length,1,'Cmd+click on the actual rendered inline-code path must dispatch once');
 assert.equal((await calls())[0].path,fs.realpathSync(file));
 if(process.env.NAW_RED_ONLY==='1')return;
 if(process.env.NAW_REVIEW_PROBES==='1'){
  const failures=[];
  await page.keyboard.down('Meta');await code.hover();await delay(200);assert.equal(await page.evaluate(()=>CSS.highlights.has('naw-cmd-path')),true);
  const survived=await page.evaluate(()=>{const el=document.createElement('div');document.body.append(el);const cleanup=nawCmdLinks.bindMarkdown(el,{api:workspace});cleanup();el.remove();return CSS.highlights.has('naw-cmd-path');});
  console.log('CROSS-HOST cleanup keeps hovered underline='+survived);if(!survived)failures.push('unrelated host cleanup removed hovered underline');
  await page.mouse.move(1,1);await code.hover();await delay(200);await page.keyboard.up('Meta');await page.keyboard.down('Meta');await delay(150);
  const restored=await page.evaluate(()=>CSS.highlights.has('naw-cmd-path'));console.log('REPEATED META restores underline='+restored);if(!restored)failures.push('second Meta press loses hover');await page.keyboard.up('Meta');
  const hard=page.locator('.naw-markdown p').filter({hasText:'Hardbreak:'});console.log('HARD BREAK actual BR count='+await hard.locator('br').count());
  if(await hard.locator('br').count()){
   const point=await hard.evaluate(el=>{const walk=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);let node;while(node=walk.nextNode()){const index=node.textContent.indexOf('/');if(index>=0){const r=document.createRange();r.setStart(node,index+2);r.setEnd(node,index+3);const b=r.getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2};}}});
   const before=(await calls()).length;await page.keyboard.down('Meta');await page.mouse.click(point.x,point.y);await page.keyboard.up('Meta');await delay(250);const added=(await calls()).slice(before);console.log('HARD BREAK open calls='+JSON.stringify(added));if(added.length)failures.push('hardbreak synthesized a different file path');
  }
  assert.deepEqual(failures,[]);return;
 }

 const plain=page.locator('.naw-markdown p').filter({hasText:'Plain: '+file});await plain.click({modifiers:['Meta']});await until(async()=>(await calls()).filter(c=>c.kind==='open').length===2,'Plain text path opens');
 await page.locator('.naw-markdown code').filter({hasText:notes+':12'}).click({modifiers:['Meta']});await until(async()=>(await calls()).filter(c=>c.kind==='open').length===3,'Line suffix resolves original file');
 await page.locator('.naw-markdown code').filter({hasText:folder}).click({modifiers:['Meta']});await until(async()=>(await calls()).filter(c=>c.kind==='open').length===4,'Directory dispatches to default file manager');

 await page.keyboard.down('Meta');await code.hover();await delay(200);assert.equal(await code.evaluate(el=>getComputedStyle(el).cursor),'pointer');assert.equal(await page.evaluate(()=>CSS.highlights.has('naw-cmd-path')),true);await shot('01-message-zh');await page.keyboard.up('Meta');await page.keyboard.down('Meta');await delay(150);assert.equal(await page.evaluate(()=>CSS.highlights.has('naw-cmd-path')),true,'Pressing Command again without mouse movement restores hover');await page.keyboard.up('Meta');
 await page.locator('.naw-markdown code').filter({hasText:script}).click({modifiers:['Meta']});await until(async()=>(await calls()).some(c=>c.kind==='reveal'),'Executable shown in Finder');
 await page.getByRole('link',{name:'Existing web link',exact:true}).click();await until(async()=>(await calls()).some(c=>c.kind==='web'),'Ordinary existing HTTP still opens');
 await page.getByRole('link',{name:'Existing web link',exact:true}).click({modifiers:['Meta']});await until(async()=>(await calls()).some(c=>c.kind==='web'),'Existing HTTP link still opens');
 await page.locator('#terminal-tab').click();
 await fixture('output',id,{data:(process.env.NAW_MOUSE_LINK_PROBE==='1'?'\x1b[?1000h\x1b[?1006h':'')+'\x1b[2J\x1b[H'+file+'\r\nhttps://example.com/terminal\r\n'});
 const terminal=page.locator('.terminal-surface:visible .xterm-screen');await terminal.waitFor();
 await until(async()=>terminal.innerText().then(s=>s.includes('图片')),'Native terminal painted');
 const position=await terminal.evaluate(el=>{const row=[...el.querySelectorAll('.xterm-rows>div')].find(e=>e.textContent.includes('图片'));const r=row.getBoundingClientRect();return {x:r.x+30,y:r.y+r.height/2};});
 const before=(await calls()).length;await page.mouse.click(position.x,position.y);assert.equal((await calls()).length,before,'Ordinary terminal click does not open');
 const nativeBefore=(await fixture('stats',id)).stats.inputs;await page.keyboard.down('Meta');await page.mouse.move(position.x,position.y);await delay(250);await shot('02-terminal-zh');await page.mouse.click(position.x,position.y);await page.keyboard.up('Meta');
 await until(async()=>(await calls()).filter(c=>c.kind==='open').length===5,'Native terminal Cmd+click opens original path');if(process.env.NAW_MOUSE_LINK_PROBE==='1'){const nativeAfter=(await fixture('stats',id)).stats.inputs;console.log('Cmd+click native mouse reports before='+nativeBefore+' after='+nativeAfter);assert.equal(nativeAfter,nativeBefore,'Cmd+link activation must not also send a mouse click into the native program');}
 await page.locator('#setup-button').click();await page.locator('#ui-language').selectOption('en');await page.locator('#close-setup').click();await page.getByRole('button',{name:'New session',exact:true}).waitFor();
 await page.keyboard.down('Meta');await code.hover();await delay(200);assert.equal(await code.evaluate(el=>getComputedStyle(el).cursor),'pointer');await shot('03-message-en');await page.keyboard.up('Meta');
 await page.keyboard.down('Meta');await page.mouse.move(position.x,position.y);await delay(250);await shot('04-terminal-en');await page.keyboard.up('Meta');
 const webPosition=await terminal.evaluate(el=>{const row=[...el.querySelectorAll('.xterm-rows>div')].find(e=>e.textContent.includes('https://'));const r=row.getBoundingClientRect();return {x:r.x+30,y:r.y+r.height/2};});
 await page.keyboard.down('Meta');await page.mouse.move(webPosition.x,webPosition.y);await delay(200);await page.mouse.click(webPosition.x,webPosition.y);await page.keyboard.up('Meta');await until(async()=>(await calls()).some(c=>c.url==='https://example.com/terminal'),'Raw terminal HTTP opens');
 console.log('PASS real hidden GUI: plain clicks do not open; Markdown and terminal Cmd+click dispatch exact local paths; script reveals only; existing HTTP preserved. No real OS viewer or model.');
 console.log(JSON.stringify(await calls()));
}
run().catch(async error=>{console.error(error.stack);process.exitCode=1;await shot('failure').catch(()=>{});}).finally(async()=>{await scratch.release();console.log('Owned profile and processes released.');});
