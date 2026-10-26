const testScratch = require('./fixtures/test-scratch.cjs');
const { createIn } = require('./fixtures/create-view.cjs');
// Installed native surfaces, never inferred from a transport ACK or source count.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {execFileSync}=testScratch.childProcess,{_electron}=testScratch.playwright(require('playwright'));
const {executable,processIdentity,processMayBeAlive}=require('../app/platform.cjs'),{connect}=require('../app/service-client.cjs');
const inventory=require('./fixtures/codex164-inventory.json'),root=path.resolve(__dirname,'..');
const base=testScratch.directory(path.join(os.tmpdir(),'naw-native-inventory-')),profile=path.join(base,'profile'),cwd=path.join(base,'work'),home=path.join(base,'codex'),userHome=path.join(base,'home');
for(const p of [profile,cwd,home,userHome])fs.mkdirSync(p,{mode:0o700});
const binary=executable('codex');assert.equal(execFileSync(binary,['--version'],{encoding:'utf8'}).trim(),'codex-cli 0.164.0');
const stock=process.env.NAW_INVENTORY_STOCK==='1',working=process.env.NAW_INVENTORY_WORKING==='1',imageTrial=process.env.NAW_INVENTORY_IMAGE==='1';assert.ok(!stock||!working,'Only one held task, in the candidate');assert.ok(!working||!imageTrial,'Separate finite journeys');
let app,page,requests=0,tasks=0,titles=0,sequence=0,release,budgetError;const sleep=ms=>new Promise(r=>setTimeout(r,ms)),errors=[];
function event(res,type,body){res.write(`event: ${type}\ndata: ${JSON.stringify({type,sequence_number:++sequence,...body})}\n\n`);}
const trap=http.createServer((req,res)=>{let body='';req.on('data',b=>body+=b);req.on('end',async()=>{
 requests++;fs.writeFileSync(path.join(base,'request-'+requests+'.json'),body);
 const input=JSON.parse(body),title=input.input?.some(m=>m.role==='user'&&m.content?.some(p=>p.text?.startsWith('Generate a concise, single-line task title')));
 if(title)titles++;else tasks++;
 fs.writeFileSync(path.join(base,(title?'title-':'task-')+(title?titles:tasks)+'.json'),body);
 if(!(working||imageTrial)||tasks>1||titles>1||!req.url.endsWith('/responses')){budgetError=Error('Inventory budget: one task and at most one native title');res.writeHead(400);res.end(budgetError.message);return;}
 assert.equal(input.model,'gpt-6-luna');
 const response={id:'inventory_held',object:'response',created_at:Math.floor(Date.now()/1000),status:'in_progress',model:input.model,output:[]};
 res.writeHead(200,{'content-type':'text/event-stream'});event(res,'response.created',{response});
 if(title||imageTrial){
  const item={id:title?'inventory_title':'image_reply',type:'message',role:'assistant',status:'completed',phase:'final_answer',content:[{type:'output_text',text:title?JSON.stringify({title:'Inventory fixture'}):'IMAGE_RECEIVED',annotations:[]}]};
  event(res,'response.output_item.added',{output_index:0,item:{...item,status:'in_progress',content:[]}});event(res,'response.output_text.delta',{output_index:0,item_id:item.id,content_index:0,delta:item.content[0].text});event(res,'response.output_item.done',{output_index:0,item});event(res,'response.completed',{response:{...response,status:'completed',output:[item]}});res.end();return;
 }
 const item={id:'inventory_partial',type:'message',role:'assistant',phase:'commentary',status:'in_progress',content:[]};
 event(res,'response.output_item.added',{output_index:0,item});event(res,'response.output_text.delta',{output_index:0,item_id:item.id,content_index:0,delta:'INVENTORY_HELD_RESPONSE'});
 await new Promise(resolve=>{release=resolve;});if(!res.destroyed)res.end();
 });});
async function until(fn,label,ms=30000){const start=Date.now();while(Date.now()-start<ms){if(budgetError)throw budgetError;if(await fn())return;await sleep(75);}throw Error(label);}
const state=()=>page.evaluate(()=>workspace.initial()),text=()=>page.locator('#terminal-area').innerText();
const nativeSession=value=>[...value.replace(/\s/g,'').matchAll(/Session:([a-f0-9-]{36})/g)].at(-1)?.[1];
async function capture(name){fs.writeFileSync(path.join(base,name+'.txt'),await text());fs.writeFileSync(path.join(base,name+'.json'),JSON.stringify(await state(),null,2));if(process.env.NAW_EVIDENCE_DIR){fs.mkdirSync(process.env.NAW_EVIDENCE_DIR,{recursive:true,mode:0o700});await page.screenshot({path:path.join(process.env.NAW_EVIDENCE_DIR,name+'.png')});}}
(async()=>{
 await new Promise(resolve=>trap.listen(0,'127.0.0.1',resolve));
 fs.writeFileSync(path.join(home,'config.toml'),`model = "gpt-6-luna"\nmodel_provider = "local_fixture"\nmodel_reasoning_effort = "low"\ncli_auth_credentials_store = "file"\n[features]\ndaemon_auto_start = false\n[model_providers.local_fixture]\nname = "Local inventory fixture"\nbase_url = "http://127.0.0.1:${trap.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`,{mode:0o600});
 const shim=path.join(base,'codex-local');fs.writeFileSync(shim,'#!/usr/bin/python3\nimport os,sys\n'+`os.environ["CODEX_HOME"]=${JSON.stringify(home)}\nos.environ["HOME"]=${JSON.stringify(userHome)}\n`+'for key in ["OPENAI_API_KEY","CODEX_API_KEY"]: os.environ.pop(key,None)\n'+(stock?'args=sys.argv[1:]\nif "--remote" in args:\n i=args.index("--remote"); args=args[:i]+args[i+2:]; args.append("--no-daemon"); sys.argv=[sys.argv[0]]+args\n':'')+`os.execv(${JSON.stringify(binary)},["codex"]+sys.argv[1:])\n`,{mode:0o700});
 fs.writeFileSync(path.join(base,'effective-features.txt'),execFileSync(shim,['features','list'],{encoding:'utf8'}));
 fs.writeFileSync(path.join(base,'config-input.txt'),fs.readFileSync(path.join(home,'config.toml')));
 fs.writeFileSync(path.join(profile,'runtime-locations.json'),JSON.stringify({codex:shim}),{mode:0o600});
 if(!process.env.NAW_APP_EXECUTABLE)execFileSync(process.execPath,[path.join(root,'scripts/build-ui.cjs')]);
 app=await _electron.launch({executablePath:process.env.NAW_APP_EXECUTABLE||require('electron'),args:process.env.NAW_APP_EXECUTABLE?[]:[root],...(process.env.NAW_VIDEO_DIR?{recordVideo:{dir:process.env.NAW_VIDEO_DIR,size:{width:1280,height:900}}}:{}),env:{...process.env,NAW_DATA_DIR:profile,NAW_WORKSPACE:cwd,NAW_TEST_PARENT_PID:String(process.pid)},timeout:70000});
 await until(async()=>{for(const candidate of app.windows())if(!candidate.isClosed()&&await candidate.locator('#new-session').count().catch(()=>0)){page=candidate;return true;}return false;},'Actual main window');
 page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
 await page.locator('#new-session').click();await page.locator('input[name="provider"][value="codex"]').check();await page.locator('#session-name').fill('Native inventory');await createIn(page, 'terminal');
 await require('./native-trust.cjs').acceptOwnedFolder(page,cwd,true);
 if(!stock)await until(async()=>(await state()).sessions[0]?.state==='idle','Native ready');else await until(async()=>(await text()).includes('OpenAI Codex'),'Stock local native screen');
 const before=(await state()).sessions[0];if(!stock){assert.equal(before.nativeVersion,'0.164.0');assert.equal(before.model,'gpt-6-luna');}
 if(!stock){await page.locator('#chat-tab').click();await page.locator('#message-input').fill('Unsent inventory draft.');await page.locator('#terminal-tab').click();}
 await until(async()=>!(await page.locator('#terminal-paste').isDisabled()),'Native input control');
 const input=page.locator('#terminal-area .xterm-helper-textarea');await page.locator('#terminal-area .xterm-screen').click();
 const captures={};
 async function popup(label){
  await input.type('/');await sleep(250);await capture(label+'-popup');const pages=[];
  for(let i=0;i<inventory.commands.length+10;i++){pages.push(await text());await input.press('ArrowDown');await sleep(35);}
  fs.writeFileSync(path.join(base,label+'-popup-pages.json'),JSON.stringify(pages,null,2));
  await input.press('Escape');await input.press('Control+u');
  const prefixes={};
  for(const command of [...inventory.commands.map(c=>c.name),'clean','cwd','pet','goooal']){
   await input.type('/'+command);await sleep(90);prefixes[command]=await text();await input.press('Control+u');
  }
  fs.writeFileSync(path.join(base,label+'-prefixes.json'),JSON.stringify(prefixes,null,2));
  captures[label]={pages:pages.length,prefixes:Object.keys(prefixes).length};
 }
 async function command(value){
  await input.type(value+' ');await until(async()=>new RegExp('› '+value+'\\s*(?:\\n|$)').test(await text()),'Exact native edit line '+value);
  await sleep(200);fs.writeFileSync(path.join(base,'typed-'+value.slice(1)+'.txt'),await text());await input.press('Enter');await sleep(500);
 }
 if(!imageTrial&&process.env.NAW_INVENTORY_CURSOR!=='1'&&!['NAW_INVENTORY_KEYMAP_ONLY','NAW_INVENTORY_MENUS','NAW_INVENTORY_SETTINGS','NAW_INVENTORY_KEYPROBE'].some(key=>process.env[key]==='1'))await popup(stock?'stock-local-idle':'installed-idle');
 if(process.env.NAW_INVENTORY_KEYPROBE==='1'){
  assert.ok(!working&&!stock&&!imageTrial,'Inspector input journey has no inference');
  await page.locator('#terminal-maximize').click();await command('/keymap debug');await until(async()=>(await text()).includes('Keypress Inspector'),'Native key inspector');
  // Focused regression for the measured input losses; not per-keymap acceptance.
  const keys=['Shift+Enter','Control+Alt+v','Control+/','Control+Shift+a','Alt+ArrowLeft','Alt+Enter'];
  const results=[];
  for(const [index,key]of keys.entries()){
   // A sentinel makes receipt observable even if two keys decode identically.
   await input.press('F12');await until(async()=>(await text()).includes('Config key: f12'),'Inspector sentinel received');
   await input.press(key);let received=true;try{await until(async()=>{const t=await text();return t.includes('Config key:')&&!t.includes('Config key: f12');},'Inspector receives '+key,1800);}catch{received=false;}
   const native=await text();results.push({key,received,configKey:received?native.match(/Config key: ([^\n]+)/)?.[1]?.trim():null});await capture('keyprobe-'+String(index).padStart(2,'0'));
  }
  await input.press('Control+c');await until(async()=>!(await text()).includes('Keypress Inspector'),'Native Ctrl+C closes inspector');await command('/status');await until(async()=>nativeSession(await text())===before.nativeId,'Key inspection preserves root');
  fs.writeFileSync(path.join(base,'keyprobe-results.json'),JSON.stringify(results,null,2));assert.deepEqual(results.filter(r=>!r.received),[],'All tested native keypresses reach the original inspector');
  for(const [key,expected]of [['Shift+Enter','shift-enter'],['Control+Alt+v','ctrl-alt-v'],['Control+/','ctrl-/'],['Control+Shift+a','ctrl-shift-a']])assert.equal(results.find(r=>r.key===key).configKey,expected,'Native inspector preserves '+key);
  await input.type('First native line.');await input.press('Shift+Enter');await input.type('Second native line.');await sleep(250);await capture('native-multiline');
  assert.match(await text(),/First native line\.\s*\n[^\n]*Second native line\./,'Actual native editor retains two lines without submitting');assert.equal(requests,0);
  // Native composer Ctrl+U kills a line; transcript Select All is not a
  // composer editing command. Remove the two unsent lines using native edits.
  await input.press('Control+u');await input.press('Backspace');await input.press('Control+u');await sleep(200);await command('/status');await until(async()=>nativeSession(await text())===before.nativeId,'Native editing clears only the unsent multiline draft');
  await page.reload();await page.locator('#new-session').waitFor();await page.locator('#terminal-tab').click();await until(async()=>!(await page.locator('#terminal-paste').isDisabled()),'Native terminal control after renderer reload');await page.locator('#terminal-area .xterm-screen').click();await command('/keymap debug');await until(async()=>(await text()).includes('Keypress Inspector'),'Restored native inspector');await input.press('Shift+Enter');await until(async()=>(await text()).includes('Config key: shift-enter'),'Canonical keyboard mode survives renderer reload');await capture('keyprobe-reloaded');await input.press('Control+c');
  captures.keyprobe={results,ctrlCClosed:true,multilineUnsent:true,nativeEditClearedDraft:true,modeRestoredAfterReload:true};await page.locator('#terminal-maximize').click();
 }
 if(imageTrial){
  const zlib=require('node:zlib'),crypto=require('node:crypto');
  const chunk=(name,data)=>{const tag=Buffer.from(name),n=Buffer.alloc(4),crc=Buffer.alloc(4);n.writeUInt32BE(data.length);crc.writeUInt32BE(zlib.crc32(Buffer.concat([tag,data])));return Buffer.concat([n,tag,data,crc]);};
  const header=Buffer.alloc(13);header.writeUInt32BE(2,0);header.writeUInt32BE(2,4);header[8]=8;header[9]=6;
  const pixels=Buffer.from([0,255,0,0,255,0,255,0,255,0,0,0,255,255,255,255,0,255]);
  const png=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',zlib.deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
  const filename=path.join(cwd,'fixture.png');fs.writeFileSync(filename,png);
  let attachmentCount=1;
  if(process.env.NAW_INVENTORY_IMAGE_GUI==='1'){
   assert.ok(!stock,'GUI image import uses the installed normal service');
   await page.locator('#chat-tab').click();
   await page.locator('#message-input').evaluate((element,data)=>{const transfer=new DataTransfer();transfer.items.add(new File([Uint8Array.from(data)],'screenshot.png',{type:'image/png'}));element.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:transfer}));},Array.from(png));
   await until(async()=>(await text()).includes('[Image #1]'),'GUI clipboard image reaches native attachment');
   assert.equal((await state()).sessions[0].liveDraft,'Unsent inventory draft.');
   await input.evaluate((element,data)=>{const transfer=new DataTransfer();transfer.items.add(new File([Uint8Array.from(data)],'drop.png',{type:'image/png'}));element.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));},Array.from(png));
   await until(async()=>(await text()).includes('[Image #2]'),'Dropped file becomes native attachment');
   await app.evaluate(({clipboard,nativeImage},data)=>{clipboard.readImage=()=>nativeImage.createFromBuffer(Buffer.from(data,'base64'));},png.toString('base64'));
   await page.locator('#terminal-paste').click();
   await until(async()=>(await text()).includes('[Image #3]'),'Paste button reads an image on demand');
   assert.equal(tasks,0,'Attaching an image never submits a task');attachmentCount=3;
  }else{
   // The actual renderer's paste handler feeds xterm's bracketed paste. Avoid
   // changing the person's system clipboard in a hidden test.
   await input.evaluate((element,value)=>{const data=new DataTransfer();data.setData('text/plain',value);element.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));},filename);
  }
  await until(async()=>(await text()).includes('[Image #1]'),'Native image path becomes an attachment');await capture('image-attached');
  await input.type(' Inspect the attached fixture.');await until(async()=>(await text()).replace(/\s/g,'').includes('Inspecttheattachedfixture.'),'Image task edit line');await sleep(250);await capture('image-before-submit');await input.press('Enter');
  await until(async()=>tasks===1&&(await text()).includes('IMAGE_RECEIVED'),'Native image response completes');
  const task=JSON.parse(fs.readFileSync(path.join(base,'task-1.json'),'utf8'));
  const images=task.input.flatMap(item=>item.content||[]).filter(item=>item.type==='input_image');assert.equal(images.length,attachmentCount);for(const image of images)assert.match(image.image_url,/^data:image\/(png|jpeg);base64,/);
  const encoded=Buffer.from(images[0].image_url.split(',')[1],'base64');const bitmap=await app.evaluate(({nativeImage},data)=>{const im=nativeImage.createFromBuffer(Buffer.from(data,'base64'));return {size:im.getSize(),bitmap:im.toBitmap().toString('base64')};},encoded.toString('base64'));
  assert.deepEqual(bitmap.size,{width:2,height:2});
  if(process.env.NAW_INVENTORY_IMAGE_GUI==='1'){
   const original=await app.evaluate(({nativeImage},data)=>nativeImage.createFromBuffer(Buffer.from(data,'base64')).toBitmap().toString('base64'),png.toString('base64'));assert.equal(bitmap.bitmap,original,'Imported pixels remain unchanged');
   for(const image of images){const pixels=await app.evaluate(({nativeImage},data)=>nativeImage.createFromBuffer(Buffer.from(data,'base64')).toBitmap().toString('base64'),image.image_url.split(',')[1]);assert.equal(pixels,original);}
  }else assert.ok(encoded.equals(png),'Original tiny PNG bytes reach the native model request unchanged');
  captures.image={sourceSHA256:crypto.createHash('sha256').update(png).digest('hex'),modelImageSHA256:crypto.createHash('sha256').update(encoded).digest('hex'),bitmap,attachments:images.length,paste:'actual renderer ClipboardEvent, system clipboard untouched'};
  await capture('image-completed');if(!stock){await until(async()=>(await state()).sessions[0].messages.some(m=>m.text==='IMAGE_RECEIVED'),'Same native image reply reaches GUI');assert.equal((await state()).sessions[0].nativeId,before.nativeId);}
 }
 if(process.env.NAW_INVENTORY_SETTINGS==='1'){
  assert.ok(!working&&!stock,'Native settings journey has no inference');
  const selections=[['gpt-6.1-sol','medium'],['gpt-6-luna','high'],['gpt-6-luna','low']];
  for(const [model,effort]of selections){
   await command('/model '+model+' --reasoning '+effort);
   await until(async()=>{const s=(await state()).sessions[0];return s.model===model&&s.nativeSettings?.effort===effort;},'GUI reflects exact native model and effort');
   await command('/status');await until(async()=>nativeSession(await text())===before.nativeId,'Native settings preserve root');await capture('settings-'+model+'-'+effort);
   await page.locator('#chat-tab').click();assert.ok((await page.locator('#subtitle').innerText()).includes(model));assert.ok((await page.locator('#subtitle').innerText()).includes(effort));assert.equal(await page.locator('#message-input').inputValue(),'Unsent inventory draft.');await page.locator('#terminal-tab').click();await page.locator('#terminal-area .xterm-screen').click();
   assert.equal(requests,0,'A settings change does not start inference');console.log(JSON.stringify({selectedModel:model,effort,inferenceRequests:requests}));
  }
  captures.settings={selections,rootUnchanged:true,guiHeaderMatched:true};
 }
 if(process.env.NAW_INVENTORY_MENUS==='1'){
  assert.ok(!working&&!stock,'Menu cancellation journey has no inference');
  await page.locator('#terminal-maximize').click();await sleep(300);
  const configBefore=fs.readFileSync(path.join(home,'config.toml')),results=[];
  // Open only source-inspected read-only menus. Never select an action that
  // starts a task, installs software, changes auth or deletes native history.
  const menuCases=[
   ['model','Select Model'],['permissions','Update Model Permissions'],
   ['review','Select a review preset'],['archive','Archive this session?'],
   ['delete','Delete this session?'],['tui','TUI mode for next launch'],
   ['statusline','Configure Status Line'],['title','Configure Terminal Title'],
   ['config','Configure'],['theme','Theme'],['skills','Skills'],
   ['experimental','Experimental'],['memories','Memories'],
   ['export','Export conversation'],['warnings','Warnings'],
   ['agents','Agent command center'],['daemon','Daemon'],
  ];
  const requested=process.env.NAW_INVENTORY_MENU_NAMES?.split(',');
  if(requested)assert.ok(requested.length&&requested.every(name=>menuCases.some(([key])=>key===name)),'Only inspected menu cases');
  const menus=requested?menuCases.filter(([name])=>requested.includes(name)):menuCases;
  for(const [name,heading]of menus){
   await command('/'+name);await until(async()=>(await text()).includes(heading),'Native menu '+name);
   await capture('menu-'+name);await input.press('Escape');await sleep(180);
   await input.press('Control+u');
   assert.equal((await state()).sessions[0].nativeId,before.nativeId,'Menu keeps root '+name);
   assert.equal(requests,0,'Native menu does not start inference '+name);
   results.push({command:name,heading,opened:true,cancelled:true});
   console.log(JSON.stringify({menu:name,completed:results.length,total:menus.length,inferenceRequests:requests}));
  }
  await command('/status');await until(async()=>nativeSession(await text())===before.nativeId,'Native status confirms original root after cancelling menus');await capture('menus-return-status');
  assert.ok(fs.readFileSync(path.join(home,'config.toml')).equals(configBefore),'Cancelled settings leave native config unchanged');
  await page.locator('#terminal-maximize').click();captures.menus={results,configUnchanged:true,finalNativeId:before.nativeId};
 }
 if(process.env.NAW_INVENTORY_KEYMAP==='1'){
  assert.ok(!working&&!stock,'Keymap discovery uses zero-model candidate mode');
  await page.locator('#terminal-maximize').click();await sleep(300);const beforeConfig=fs.readFileSync(path.join(home,'config.toml'));
  await command('/keymap');await until(async()=>(await text()).includes('Type to search shortcuts'),'Native keymap picker');await capture('native-keymap');
  const pages=[];for(let i=0;i<inventory.keymapUiCatalog.length+10;i++){pages.push(await text());await input.press('ArrowDown');await sleep(40);}
  fs.writeFileSync(path.join(base,'native-keymap-pages.json'),JSON.stringify(pages,null,2));
  await input.press('Enter');await until(async()=>(await text()).includes('Add alternate binding'),'Actual native keymap action menu');await capture('native-keymap-action');await input.press('Escape');await until(async()=>(await text()).includes('All configurable shortcuts.'),'Keymap parent picker restored');await input.press('Escape');await command('/keymap debug');await until(async()=>(await text()).includes('Keypress Inspector'),'Native keypress inspector');await input.press('F2');await until(async()=>(await text()).includes('f2'),'Native inspector received F2');await capture('native-keymap-debug');await input.press('Control+c');await until(async()=>!(await text()).includes('Keypress Inspector'),'Native inspector closed using its own Ctrl+C instruction');
  await input.press('F2');await until(async()=>(await text()).includes('Warnings'),'Native warnings view');await capture('native-warnings');await input.press('Escape');assert.ok(fs.readFileSync(path.join(home,'config.toml')).equals(beforeConfig),'Opening and cancelling native settings preserves config');await page.locator('#terminal-maximize').click();captures.keymap={catalog:inventory.keymapUiCatalog.length,pages:pages.length,actionMenu:true,inspectorReceivedF2:true,warnings:true,configUnchanged:true};
 }

 if(working && process.env.NAW_INVENTORY_CURSOR==='1'){
  assert.ok(!['NAW_INVENTORY_MENUS','NAW_INVENTORY_KEYMAP','NAW_INVENTORY_KEYMAP_ONLY','NAW_INVENTORY_SETTINGS','NAW_INVENTORY_KEYPROBE'].some(key=>process.env[key]==='1'),'Cursor trial excludes unrelated menu/settings journeys');
  await page.locator('#chat-tab').click();await page.locator('#message-input').fill('Hold one local native cursor task.');await page.locator('#message-input').press('Enter');
  await until(async()=>tasks===1&&(await text()).includes('INVENTORY_HELD_RESPONSE'),'Held native turn');
  await page.locator('#message-input').fill('Unsent inventory draft.');await page.locator('#terminal-tab').click();
  await input.type('abcdef');await input.press('ArrowLeft');await input.press('ArrowLeft');await input.press('ArrowLeft');
  await sleep(1600);await input.type('X');
  await until(async()=>(await text()).includes('abcXdef'),'Native cursor remains at edited position after repeated updates');
  await capture('native-cursor-retained');await input.press('Control+u');await input.press('Escape');release?.();
  await until(async()=>!['working','approval'].includes((await state()).sessions[0].state),'Held native turn interrupted');
  captures.cursor={middleInsertion:'abcXdef',waitMs:1600,taskRequests:tasks};
 }
 if(working && process.env.NAW_INVENTORY_CURSOR!=='1'){
  await page.locator('#chat-tab').click();await page.locator('#message-input').fill('Hold one local inventory task.');await page.locator('#send-button').click();
  await until(async()=>tasks===1&&(await state()).sessions[0].state==='working'&&release,'One held local native turn');
  await page.locator('#message-input').fill('Unsent inventory draft.');await page.locator('#terminal-tab').click();await until(async()=>(await text()).includes('INVENTORY_HELD_RESPONSE'),'Held native output visible');
  await page.locator('#terminal-area .xterm-screen').click();await popup('installed-working');
  await command('/side');await capture('side-start');
  await command('/status');await capture('side-status');assert.ok(nativeSession(await text()));assert.notEqual(nativeSession(await text()),before.nativeId,'The original TUI is actually in its native side thread');assert.equal((await state()).sessions.length,1,'A native side thread never creates another portal participant');assert.equal((await state()).sessions[0].nativeId,before.nativeId);
  await popup('installed-side');
  await input.press('Control+c');await sleep(500);await command('/status');await capture('parent-status');assert.equal(nativeSession(await text()),before.nativeId,'Native close returns to the exact original parent');
  await input.press('Escape');await until(async()=>!['working','approval'].includes((await state()).sessions[0].state),'Native held turn interrupted');
 }
 const after=(await state()).sessions[0];assert.equal(after.nativeId,before.nativeId);assert.equal(after.pid,before.pid);assert.equal(tasks,working||imageTrial?1:0);assert.ok(titles<=(working||imageTrial?1:0));assert.ok(!budgetError);assert.deepEqual(errors,[]);
 if(!stock){await page.locator('#chat-tab').click();assert.equal(await page.locator('#message-input').inputValue(),'Unsent inventory draft.');}
 fs.writeFileSync(path.join(base,'inventory-run.json'),JSON.stringify({nativeVersion:'0.164.0',mode:stock?'stock-local-embedded-comparison-only':'installed-normal-remote',sourceCommit:inventory.commit,captures,nativeIdUnchanged:stock?null:true,pidUnchanged:stock?null:true,guiDraftPreserved:stock?null:true,auth:'isolated file store, loopback provider, no credentials',inferenceRequests:requests,localTaskRequests:tasks,nativeTitleRequests:titles,scope:'Native discovery/state readings only, not operation acceptance; stock comparison has no GUI mapping claim'},null,2));
 console.log(JSON.stringify({nativeVersion:'0.164.0',captures,inferenceRequests:requests,localTaskRequests:tasks,nativeTitleRequests:titles,paidModelCalls:0,guiDraftPreserved:stock?null:true,evidence:base}));
})().catch(async error=>{console.error(error.stack);if(page&&!page.isClosed()){fs.writeFileSync(path.join(base,'failure-state.json'),JSON.stringify(await state(),null,2));fs.writeFileSync(path.join(base,'failure-terminal.txt'),await text());}process.exitCode=1;}).finally(testScratch.cleanup(async()=>{
 release?.();if(app)await app.close();trap.closeAllConnections();await new Promise(resolve=>trap.close(resolve));
 try{const c=await connect(profile,'native-inventory-cleanup');try{for(const s of(await c.call('initial')).sessions)await c.call('stop',s.id);const owned=c.entries.map(e=>processIdentity(e.state.servicePid));for(const p of owned){assert.ok(p&&processMayBeAlive(p));process.kill(p.pid,'SIGTERM');}await until(()=>owned.every(p=>!processMayBeAlive(p)),'Owned backend exit',15000);}finally{c.close();}}catch(e){console.error('Cleanup:',e.message);process.exitCode=1;}
}));
