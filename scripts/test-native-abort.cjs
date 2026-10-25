const testScratch = require('./fixtures/test-scratch.cjs');
// Bounded API probe; NAW_ABORT_PRODUCT=1 tests the real product interrupt button.
// Actual Electron/Claude; two loopback responses, no paid inference.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const assert=require('node:assert/strict'),{execFileSync}=testScratch.childProcess;
const {_electron}=testScratch.playwright(require('playwright')),{executable}=require('../app/platform.cjs'),{connect}=require('../app/service-client.cjs');
const root=path.resolve(__dirname,'..'),base=testScratch.directory(path.join(os.tmpdir(),'naw-native-abort-'));
const profile=path.join(base,'profile'),cwd=path.join(base,'work'),home=path.join(base,'claude'),plugin=path.join(base,'probe');
for(const dir of[profile,cwd,home,path.join(plugin,'.claude-plugin'),path.join(plugin,'hooks')])fs.mkdirSync(dir,{recursive:true,mode:0o700});
const binary=executable('claude');assert.match(execFileSync(binary,['--version'],{encoding:'utf8'}),/^2\.1\.310\b/);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));async function until(fn,label,timeout=45000){const start=Date.now();while(Date.now()-start<timeout){if(await fn())return;await sleep(80);}throw Error(label);}
let app,page,calls=0,held;const errors=[];
const product=process.env.NAW_ABORT_PRODUCT==='1';
function event(res,type,body){res.write(`event: ${type}\ndata: ${JSON.stringify({type,...body})}\n\n`);}
const server=http.createServer((req,res)=>{let body='';req.on('data',b=>body+=b);req.on('end',()=>{
 if(!req.url.startsWith('/v1/messages')||req.url.includes('count_tokens')){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({input_tokens:100,data:[]}));return;}
 const n=++calls;if(n>2){res.writeHead(429);res.end();return;}const input=JSON.parse(body);assert.match(input.model,/haiku/);
 fs.writeFileSync(path.join(base,`request-${n}.json`),JSON.stringify(input,null,2));
 res.writeHead(200,{'content-type':'text/event-stream'});event(res,'message_start',{message:{id:'abort_'+n,type:'message',role:'assistant',model:input.model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:10,output_tokens:0}}});
 event(res,'content_block_start',{index:0,content_block:{type:'text',text:''}});event(res,'content_block_delta',{index:0,delta:{type:'text_delta',text:n===1?'NATIVE_API_BEFORE_ABORT\n':'NATIVE_API_RESUMED\n'}});
 if(n===1){held=res;return;}event(res,'content_block_stop',{index:0});event(res,'message_delta',{delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:10}});event(res,'message_stop',{});res.end();
 });});
const snapshot=()=>page.evaluate(()=>workspace.initial());
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 fs.writeFileSync(path.join(plugin,'.claude-plugin/plugin.json'),JSON.stringify({name:'native-abort-probe',version:'0.0.1'}));fs.writeFileSync(path.join(plugin,'hooks/hooks.json'),JSON.stringify({modules:['./register.js']}));
 const resultFile=path.join(base,'native-api-result.json');
 fs.writeFileSync(path.join(plugin,'hooks/register.js'),`let seen=false;export function register(on){on('turn.start',($,e,next)=>{if(!e.agentId&&!seen){seen=true;$.clock.after(1500,async()=>{try{await $.turn.abort({turnId:e.turnId});await $.fs.write(${JSON.stringify(resultFile)},JSON.stringify({aborted:true}));const result=await $.prompt.submit({text:'Continue this same native session after API abort.',asUser:true});await $.fs.write(${JSON.stringify(resultFile)},JSON.stringify({aborted:true,result}));}catch(error){await $.fs.write(${JSON.stringify(resultFile)},JSON.stringify({error:String(error)}));}});}return next(e);});}`);
 const shim=path.join(base,'claude-local');fs.writeFileSync(shim,'#!/usr/bin/python3\nimport os,sys\nos.environ.pop("ANTHROPIC_AUTH_TOKEN",None)\nos.environ.pop("CLAUDE_CODE_OAUTH_TOKEN",None)\n'+`os.environ.update(ANTHROPIC_BASE_URL=${JSON.stringify('http://127.0.0.1:'+server.address().port)},ANTHROPIC_API_KEY="local-fixture",CLAUDE_CONFIG_DIR=${JSON.stringify(home)},CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1")\n`+`os.execv(${JSON.stringify(binary)},["claude"]+sys.argv[1:]+["--model","haiku"]${product?'':'+["--plugin-dir",'+JSON.stringify(plugin)+']'})\n`,{mode:0o700});
 fs.writeFileSync(path.join(home,'.claude.json'),JSON.stringify({hasCompletedOnboarding:true,projects:{[fs.realpathSync(cwd)]:{hasTrustDialogAccepted:true}}}),{mode:0o600});fs.writeFileSync(path.join(profile,'runtime-locations.json'),JSON.stringify({claude:shim}),{mode:0o600});
 if(!process.env.NAW_APP_EXECUTABLE)execFileSync(process.execPath,[path.join(root,'scripts/build-ui.cjs')]);
 app=await _electron.launch({executablePath:process.env.NAW_APP_EXECUTABLE||require('electron'),args:process.env.NAW_APP_EXECUTABLE?[]:[root],...(process.env.NAW_VIDEO_DIR?{recordVideo:{dir:process.env.NAW_VIDEO_DIR,size:{width:1280,height:900}}}:{}),env:{...process.env,NAW_DATA_DIR:profile,NAW_WORKSPACE:cwd,NAW_TEST_PARENT_PID:String(process.pid)},timeout:70000});
 await until(async()=>{for(const p of app.windows())if(!p.isClosed()&&await p.locator('#new-session').count().catch(()=>0)){page=p;return true;}return false;},'Real product starts');page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
 await page.locator('#new-session').click();await page.locator('input[name="provider"][value="claude"]').check();await page.locator('#initial-view').selectOption('terminal');await page.locator('#session-name').fill('Native abort probe');await page.locator('#confirm-create').click();
 await until(async()=>/Do you want to use this API key/.test(await page.locator('#terminal-area').innerText())||(await snapshot()).sessions[0]?.chatAvailable,'Native startup');
 if((await page.locator('#terminal-area').innerText()).includes('Do you want to use this API key')){await page.locator('#terminal-area .xterm-screen').click();await page.keyboard.press('ArrowUp');await sleep(150);await page.keyboard.press('Enter');}
 await until(async()=>(await snapshot()).sessions[0]?.chatAvailable,'Native bridge ready');const before=(await snapshot()).sessions[0];
 await page.locator('#chat-tab').click();await page.locator('#message-input').fill('Start a small local work item.');await page.locator('#send-button').click();
 if(product){
  await until(async()=>{const s=(await snapshot()).sessions[0];return calls===1&&s.state==='working'&&s.activeTurnId;},'First actual native stream');
  await page.locator('#message-input').fill('Continue this same native session after API abort.');
  await page.locator('#interrupt').click();
  assert.equal(await page.locator('#message-input').getAttribute('readonly'),null,'Editing stays available while abort is pending');
  assert.equal(await page.locator('#send-button').isDisabled(),true,'The next direction waits for native confirmation');
  await page.locator('#message-input').press('Enter');
  await until(async()=>{const s=(await snapshot()).sessions[0];return s.state==='idle'&&!s.nativeInputRequired;},'GUI abort completes and graphical input recovers without native typing');
  assert.equal(calls,1);assert.equal(await page.locator('#message-input').inputValue(),'Continue this same native session after API abort.');
  assert.ok((await snapshot()).sessions[0].messages.some(m=>m.kind==='turn'&&m.status==='interrupted'));
  await page.locator('#send-button').click();
 }else await until(async()=>fs.existsSync(resultFile)&&JSON.parse(fs.readFileSync(resultFile)).aborted,'Native turn.abort returns');
 await until(async()=>calls===2&&(await snapshot()).sessions[0].messages.some(m=>m.text?.includes('NATIVE_API_RESUMED')),'Native plugin can continue after its own API abort');
 await until(async()=>{const s=(await snapshot()).sessions[0];return s.state==='idle'&&!s.pendingTag&&!s.nativeInputRequired&&!s.interruptPending;},'The native completed reply returns graphical input to idle');
 const after=await snapshot();assert.equal(after.sessions[0].nativeId,before.nativeId);assert.equal(after.sessions[0].pid,before.pid);assert.deepEqual(errors,[]);
 fs.writeFileSync(path.join(base,'completed.json'),JSON.stringify(after,null,2));fs.writeFileSync(path.join(base,'native-terminal.txt'),await page.locator('#terminal-area').innerText());
 await page.screenshot({path:path.join(base,'native-abort-completed.png')});
 if(process.env.NAW_VIDEO_DIR)await sleep(1200);
 console.log(JSON.stringify({nativeVersion:'2.1.310',checks:[product?'GUI interrupt uses the original native API, preserves the next draft and continues from the same GUI without native typing':'Actual turn.abort cancels the exact native root and the next public prompt.submit continues that same session'],fixedLocalResponses:calls,paidModelCalls:0,productInterruptButtonTested:product,evidence:base}));
})().catch(async e=>{console.error(e.stack,'\nEvidence:',base);if(page&&!page.isClosed()){fs.writeFileSync(path.join(base,'failure.json'),JSON.stringify(await snapshot(),null,2));fs.writeFileSync(path.join(base,'failure.txt'),await page.locator('body').innerText());}process.exitCode=1;}).finally(testScratch.cleanup(async()=>{
 held?.destroy();if(app)await app.close().catch(()=>{});try{const c=await connect(profile,'abort-probe-cleanup');try{for(const s of(await c.call('initial')).sessions)await c.call('stop',s.id);for(const e of c.entries)await e.client.call('shutdown');}finally{c.close();}}catch(e){console.error('Cleanup',e.message);process.exitCode=1;}server.closeAllConnections();await new Promise(r=>server.close(r));
}));
