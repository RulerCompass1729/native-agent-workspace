const testScratch = require('./fixtures/test-scratch.cjs');
// Actual Electron + Codex TUI; fixed loopback inference, isolated credentials/config.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const assert=require('node:assert/strict'),{execFileSync}=testScratch.childProcess;
const {_electron}=testScratch.playwright(require('playwright'));
const {executable,processIdentity,processMayBeAlive}=require('../app/platform.cjs');
const {connect}=require('../app/service-client.cjs');
const root=path.resolve(__dirname,'..'),temporary=testScratch.directory(path.join(os.tmpdir(),'naw-native-context-'));
// Only the explicitly requested reusable native fixture survives; Chromium does not.
const base=process.env.NAW_EVIDENCE_DIR?path.resolve(process.env.NAW_EVIDENCE_DIR,'fixture',path.basename(temporary)):temporary;
fs.mkdirSync(base,{recursive:true,mode:0o700});
fs.writeFileSync(path.join(base,'owned-fixture.json'),JSON.stringify({kind:'naw-native-fixture-v1',producer:'test-native-codex-context.cjs',uid:process.getuid()}),{mode:0o600});
const profile=path.join(temporary,'profile'),cwd=path.join(base,'work'),home=path.join(base,'codex'),userHome=path.join(base,'home');
for(const p of[profile,cwd,home,userHome])fs.mkdirSync(p,{mode:0o700});
const nativeVersion=process.env.NAW_CODEX_VERSION||'0.163.0';assert.ok(['0.163.0','0.164.0'].includes(nativeVersion));
const binary=executable('codex');assert.equal(execFileSync(binary,['--version'],{encoding:'utf8'}).trim(),'codex-cli '+nativeVersion);
let app,page,calls=0,titles=0,seq=0,releaseRetry,releaseSearch,budgetError;const errors=[],checks=[];
const failureTrial=process.env.NAW_NATIVE_FAILURE_TRIAL==='1',failureBody='NATIVE_REJECTED_REQUEST: Keep This BODY exactly.';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,timeout=30000){const start=Date.now();while(Date.now()-start<timeout){if(budgetError)throw budgetError;if(await fn())return;await sleep(80);}throw Error(label);}
function event(res,type,body){res.write(`event: ${type}\ndata: ${JSON.stringify({type,sequence_number:++seq,...body})}\n\n`);}
const server=http.createServer((req,res)=>{let body='';req.on('data',b=>body+=b);req.on('end',async()=>{
 if(!req.url.endsWith('/responses')){res.writeHead(404);res.end();return;}
 const input=JSON.parse(body),title=input.input?.some(m=>m.role==='user'&&m.content?.some(p=>p.text?.startsWith('Generate a concise, single-line task title')));
 const n=title?0:++calls;if(title)titles++;if(calls>(failureTrial||process.env.NAW_NATIVE_RETRY_TRIAL==='1'?2:3)||titles>1){budgetError=Error('Native context task/title budget exceeded');res.writeHead(400);res.end(budgetError.message);return;}
 assert.equal(input.model,'gpt-6-luna');
 fs.writeFileSync(path.join(base,`request-${title?'title-'+titles:n}.json`),JSON.stringify(input,null,2));
 if(failureTrial&&n===1){res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:{type:'invalid_request_error',message:failureBody}}));return;}
 const response={id:'context_'+seq,object:'response',created_at:Math.floor(Date.now()/1000),status:'in_progress',model:input.model,output:[],usage:{input_tokens:10,output_tokens:10,total_tokens:20}};
 res.writeHead(200,{'content-type':'text/event-stream'});event(res,'response.created',{response});
 if(process.env.NAW_NATIVE_WEB_SEARCH_TRIAL==='1'&&!title&&n===1){
  const search={id:'native_web_search',type:'web_search_call',status:'completed',action:{type:'search',query:'Seattle forecast'}};
  event(res,'response.output_item.added',{output_index:0,item:{...search,status:'in_progress'}});
  await new Promise(resolve=>{releaseSearch=resolve;});
  event(res,'response.output_item.done',{output_index:0,item:search});
 }
 if(process.env.NAW_NATIVE_RETRY_TRIAL==='1'&&n===1){
  const item={id:'partial_retry',type:'message',role:'assistant',phase:'commentary',status:'in_progress',content:[]};
  event(res,'response.output_item.added',{output_index:0,item});event(res,'response.output_text.delta',{output_index:0,item_id:item.id,content_index:0,delta:'PARTIAL_BEFORE_NATIVE_RETRY'});setTimeout(()=>res.destroy(),150);return;
 }
 if(process.env.NAW_NATIVE_RETRY_TRIAL==='1'&&n===2)await new Promise(resolve=>{releaseRetry=resolve;});
 if(process.env.NAW_NATIVE_QUESTION_TRIAL==='1'&&n===2){
  const args={questions:[{id:"approach",header:"Approach",question:"Which small implementation should be used?",options:[{label:"Use existing primitives",description:"Reuse the native request and terminal"},{label:"Build a replacement",description:"Create another interaction system"}]}]};
  const item={id:'native_question',type:'function_call',call_id:'native_question_call',name:'request_user_input',arguments:JSON.stringify(args),status:'completed'};
  event(res,'response.output_item.added',{output_index:0,item:{...item,arguments:'',status:'in_progress'}});event(res,'response.function_call_arguments.delta',{output_index:0,item_id:item.id,delta:item.arguments});event(res,'response.function_call_arguments.done',{output_index:0,item_id:item.id,arguments:item.arguments});event(res,'response.output_item.done',{output_index:0,item});event(res,'response.completed',{response:{...response,status:'completed',output:[item]}});res.end();return;
 }
 const item={id:'answer_'+seq,type:'message',role:'assistant',status:'completed',phase:'final_answer',content:[{type:'output_text',text:title?JSON.stringify({title:'Native context check'}):`CONTEXT_TASK_${n}`,annotations:[]}]};
 event(res,'response.output_item.added',{output_index:0,item:{...item,status:'in_progress',content:[]}});
 event(res,'response.output_text.delta',{output_index:0,item_id:item.id,content_index:0,delta:item.content[0].text});
 event(res,'response.output_item.done',{output_index:0,item});event(res,'response.completed',{response:{...response,status:'completed',output:[item]}});res.end();
 });});
const snapshot=()=>page.evaluate(()=>workspace.initial());
async function terminalText(){return page.locator('#terminal-area').innerText();}
async function nativeCommand(command){
 const input=page.locator('#terminal-area .xterm-helper-textarea');await page.locator('#terminal-area .xterm-screen').click();
 // Only an inspected empty native edit line may receive a command.
 fs.writeFileSync(path.join(base,'before-'+command.slice(1)+'.txt'),await terminalText());
 await input.type(command+' ');await until(async()=>(await terminalText()).includes(command+' '),'Native command text visible');
 await sleep(400);fs.writeFileSync(path.join(base,'typed-'+command.slice(1)+'.txt'),await terminalText());
 await input.press('Enter');
}
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 fs.writeFileSync(path.join(home,'config.toml'),`model = "gpt-6-luna"\nmodel_provider = "local_fixture"\nmodel_reasoning_effort = "low"\ncli_auth_credentials_store = "file"\n[features]\ndaemon_auto_start = false\n[model_providers.local_fixture]\nname = "Local protocol fixture"\nbase_url = "http://127.0.0.1:${server.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`,{mode:0o600});
 const shim=path.join(base,'codex-local');fs.writeFileSync(shim,'#!/usr/bin/python3\nimport os,sys\n'+`os.environ["CODEX_HOME"]=${JSON.stringify(home)}\nos.environ["HOME"]=${JSON.stringify(userHome)}\n`+'for key in ["OPENAI_API_KEY","CODEX_API_KEY"]: os.environ.pop(key,None)\n'+`os.execv(${JSON.stringify(binary)},["codex"]+sys.argv[1:])\n`,{mode:0o700});
 fs.writeFileSync(path.join(profile,'runtime-locations.json'),JSON.stringify({codex:shim}),{mode:0o600});
 if(!process.env.NAW_APP_EXECUTABLE)execFileSync(process.execPath,[path.join(root,'scripts/build-ui.cjs')]);
 app=await _electron.launch({executablePath:process.env.NAW_APP_EXECUTABLE||require('electron'),args:process.env.NAW_APP_EXECUTABLE?[]:[root],...(process.env.NAW_VIDEO_DIR?{recordVideo:{dir:process.env.NAW_VIDEO_DIR,size:{width:1280,height:900}}}:{}),env:{...process.env,NAW_DATA_DIR:profile,NAW_WORKSPACE:cwd,NAW_TEST_PARENT_PID:String(process.pid)},timeout:70000});
 await until(async()=>{for(const p of app.windows())if(!p.isClosed()&&await p.locator('#new-session').count().catch(()=>0)){page=p;return true;}return false;},'Main window');
 page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
 const initialTerminal=process.env.NAW_NATIVE_INITIAL_TERMINAL==='1';
 await page.locator('#new-session').click();await page.locator('input[name="provider"][value="codex"]').check();await page.locator('#initial-view').selectOption(initialTerminal?'terminal':'chat');await page.locator('#session-name').fill('Native context');await page.locator('#confirm-create').click();
 if(initialTerminal){await require('./native-trust.cjs').acceptOwnedFolder(page,cwd,true);await page.locator('#chat-tab').click();}
 await until(async()=>(await snapshot()).sessions[0]?.state==='idle','Native ready');const before=(await snapshot()).sessions[0];assert.equal(before.model,'gpt-6-luna');
 if(process.env.NAW_NATIVE_METADATA_ONLY==='1'){
  assert.equal(before.nativeVersion,nativeVersion);assert.equal(before.nativeVersionStatus,'verified');
  await until(async()=>(await page.locator('#session-status').getAttribute('title')).includes('Codex '+nativeVersion+' · 核心接口已验证'),'Actual running handshake is rendered');
  await page.locator('#message-input').fill('Unsent metadata-check draft.');
  assert.equal((await snapshot()).diagnostics.dispatches,0);assert.equal(calls,0);assert.equal(titles,0);assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(base,'native-metadata.json'),JSON.stringify(await snapshot(),null,2));
  console.log(JSON.stringify({checks:['Actual native running handshake reaches the original graphical session without inference or a task'],nativeVersion,localResponses:calls,nativeTitleResponses:titles,paidModelCalls:0,evidence:base}));return;
 }
 await page.locator('#message-input').fill('Make one small local check.');await page.locator('#send-button').click();
 if(failureTrial){
  await until(async()=>{const s=(await snapshot()).sessions[0];return s.messages.some(m=>m.kind==='notice'&&m.text.includes(failureBody))&&s.messages.some(m=>m.kind==='turn'&&m.status==='failed')&&s.state==='idle';},'Native failure finishes without claiming a successful response');
  const failed=await snapshot(),s=failed.sessions[0],notice=s.messages.find(m=>m.kind==='notice'&&m.text.includes(failureBody));
  assert.equal(s.messages.filter(m=>m.role==='assistant').length,0,'A rejected request is not replaced with invented assistant prose');
  assert.equal(await page.locator('#messages').getByText(notice.text,{exact:true}).innerText(),notice.text);
  assert.equal(await page.locator('#native-activity').isVisible(),false);assert.equal(calls,1,'A non-retryable failure is not automatically resubmitted');
  // The native display can hard-wrap inside an identifier; GUI equality above
  // checks the original public body, while this checks that body's native display.
  await until(async()=>(await terminalText()).replace(/\s/g,'').includes(failureBody.replace(/\s/g,'')),'Native TUI retains the error detail across display wraps');
  fs.writeFileSync(path.join(base,'failed-native.txt'),await terminalText());fs.writeFileSync(path.join(base,'failed.json'),JSON.stringify(failed,null,2));
  if(process.env.NAW_EVIDENCE_DIR)await page.screenshot({path:path.join(process.env.NAW_EVIDENCE_DIR,'native-failed.png')});
  await page.locator('#message-input').fill('Continue after the failed native turn.');await page.locator('#send-button').click();
  await until(async()=>{const s=(await snapshot()).sessions[0];return s.state==='idle'&&s.messages.some(m=>m.text==='CONTEXT_TASK_2');},'Explicit next GUI task succeeds after native failure');
  const recovered=await snapshot();assert.equal(recovered.sessions[0].nativeId,before.nativeId);assert.equal(calls,2);
  assert.ok(recovered.sessions[0].messages.some(m=>m.id===notice.id&&m.text===notice.text),'Original error remains after recovery');
  assert.equal(recovered.diagnostics.dispatches,2);assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(base,'failed-recovered.json'),JSON.stringify(recovered,null,2));
  console.log(JSON.stringify({checks:['Native non-retryable failure retains exact error body and failed boundary, creates no assistant reply or automatic replay; one explicit next task completes in the same native thread'],nativeVersion,localTaskAttempts:calls,nativeTitleResponses:titles,paidModelCalls:0,evidence:base}));return;
 }
 if(process.env.NAW_NATIVE_RETRY_TRIAL==='1'){
  await until(async()=>(await snapshot()).sessions[0].messages.some(m=>m.kind==='notice'&&m.text.includes('stream disconnected before completion'))&&releaseRetry,'Actual native retry notification',60000);
  const retry=await snapshot();fs.writeFileSync(path.join(base,'retrying.json'),JSON.stringify(retry,null,2));
  await page.locator('#messages').getByText('stream disconnected before completion',{exact:false}).waitFor();
  assert.equal(retry.sessions[0].state,'working');assert.equal(retry.sessions[0].nativeActivity.label,'willRetry');
  await page.locator('#native-phase').getByText('Native context · willRetry',{exact:true}).waitFor();
  const original=retry.sessions[0].messages.find(m=>m.kind==='notice'&&m.text.includes('stream disconnected before completion'));
  assert.equal(await page.locator('#messages').getByText(original.text,{exact:true}).innerText(),original.text,'Native error body is not translated or replaced');
  await until(async()=>{const text=(await terminalText()).replace(/\s+/g,' ');return text.includes('Reconnecting... 1/5')&&/[Ss]tream disconnected before completion:/.test(text);},'Native TUI shows its reconnect state and error');
  fs.writeFileSync(path.join(base,'retrying-native.txt'),await terminalText());
  if(process.env.NAW_EVIDENCE_DIR)await page.screenshot({path:path.join(process.env.NAW_EVIDENCE_DIR,'retrying-native.png')});
  assert.equal(retry.room.messages.length,0,'Private diagnostics never enter the room');releaseRetry();releaseRetry=null;
  await until(async()=>(await snapshot()).sessions[0].state==='idle'&&(await snapshot()).sessions[0].messages.some(m=>m.text==='CONTEXT_TASK_2'),'Native retry completes in the GUI');
  assert.equal(calls,2);assert.equal((await snapshot()).sessions[0].nativeId,before.nativeId);
  const completed=await snapshot();fs.writeFileSync(path.join(base,'retry-completed.json'),JSON.stringify(completed,null,2));
  assert.equal(await page.locator('#native-activity').isVisible(),false,'Recovered idle turn has no visible running clock');
  assert.equal(await page.locator('#messages .native-turn').count(),0,'Successful recovery does not invent a native footer');
  console.log(JSON.stringify({checks:['Actual native stream loss retains its exact public error body in GUI; same-screen TUI shows native reconnect/error; retry remains working and final completion reaches the same GUI thread with no stale running clock'],nativeVersion,localResponses:calls,nativeTitleResponses:titles,paidModelCalls:0,evidence:base}));return;
 }
 if(process.env.NAW_NATIVE_WEB_SEARCH_TRIAL==='1'){
  await until(async()=>releaseSearch&&(await snapshot()).sessions[0].messages.some(m=>m.toolKind==='webSearch'),'Actual native search starts',60000);
  const working=await snapshot();fs.writeFileSync(path.join(base,'web-search-working.json'),JSON.stringify(working,null,2));
  const nativeSearch=working.sessions[0].messages.find(m=>m.toolKind==='webSearch');
  assert.match(nativeSearch.title,/^(Browsing the web|Searching the web for Seattle forecast)$/);
  await page.locator('#messages').getByText(nativeSearch.title,{exact:true}).waitFor();
  releaseSearch();releaseSearch=null;
 }
 await until(async()=>(await snapshot()).sessions[0].state==='idle'&&calls===1,'One bounded native task');
 if(process.env.NAW_NATIVE_WEB_SEARCH_TRIAL==='1'){
  await until(async()=>(await snapshot()).sessions[0].messages.some(m=>m.toolKind==='webSearch'&&m.status==='complete'),'Search completion in GUI');
  const done=await snapshot(),row=done.sessions[0].messages.find(m=>m.toolKind==='webSearch');
  assert.equal(row.title,'Searched the web for Seattle forecast');
  const rendered=page.locator('#messages .process').filter({hasText:row.title});await rendered.waitFor();
  assert.equal(await rendered.locator('.message-heading').innerText(),'Codex\nSearched the web for Seattle forecast');
  assert.equal(await rendered.locator('.process-label').innerText(),'');
  assert.equal(await rendered.locator('.process-details').evaluate(el=>el.open),false);
  assert.equal(await page.locator('#messages .native-turn').count(),0,'No fabricated completion footer');
  await until(async()=>(await terminalText()).includes('Searched the web for Seattle forecast'),'Actual TUI uses the same original search summary',60000);
  fs.writeFileSync(path.join(base,'web-search-terminal.txt'),await terminalText());fs.writeFileSync(path.join(base,'web-search-completed.json'),JSON.stringify(done,null,2));
  if(process.env.NAW_EVIDENCE_DIR){fs.mkdirSync(process.env.NAW_EVIDENCE_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.NAW_EVIDENCE_DIR,'web-search-completed.png')});}
  await page.reload();await page.locator('#new-session').waitFor();
  await page.locator('#messages').getByText(row.title,{exact:true}).waitFor();
  const reopened=await snapshot(),again=reopened.sessions[0].messages.find(m=>m.id===row.id);
  assert.equal(again.status,'complete');assert.equal(again.title,row.title);assert.equal(reopened.sessions[0].nativeId,before.nativeId);assert.equal(reopened.sessions[0].pid,before.pid);assert.equal(calls,1);
  fs.writeFileSync(path.join(base,'web-search-reopened.json'),JSON.stringify(reopened,null,2));assert.deepEqual(errors,[]);
  console.log(JSON.stringify({checks:['Actual Codex search starts and completes with its original English native summary in the GUI and same TUI; compact disclosure; reader reload preserves exact identity and completed status; no fabricated footer'],nativeVersion,localResponses:calls,nativeTitleResponses:titles,paidModelCalls:0,evidence:base}));return;
 }
 if(initialTerminal){
  await until(async()=>(await snapshot()).sessions[0].messages.some(m=>m.text==='CONTEXT_TASK_1')&&(await terminalText()).includes('CONTEXT_TASK_1'),'First GUI task on the empty actual native-first thread');
  assert.equal((await snapshot()).sessions[0].nativeId,before.nativeId);assert.equal(calls,1);
  console.log(JSON.stringify({checks:['Actual folder trust before any inference; empty native-first session accepts its first GUI input and displays the same native reply without a seed turn'],localResponses:calls,nativeTitleResponses:titles,paidModelCalls:0,evidence:base}));return;
 }
 await until(async()=>/Trust this folder\?|CONTEXT_TASK_1/.test(await terminalText()),'Actual native terminal or folder gate',60000);
 if((await terminalText()).includes('Trust this folder?')){
  const trust=await terminalText();fs.writeFileSync(path.join(base,'folder-trust.txt'),trust);
  assert.ok(trust.replace(/\s/g,'').includes(cwd.replace(/\s/g,'')),'Only this isolated local folder is trusted');
  assert.match(trust,/› 1\. Trust and continue/);await page.locator('#terminal-area .xterm-helper-textarea').press('Enter');
 }
 await until(async()=>(await terminalText()).includes('CONTEXT_TASK_1'),'Same actual native TUI attached',60000);
 if(process.env.NAW_NATIVE_QUESTION_TRIAL==='1'){
  await nativeCommand('/plan');await sleep(500);fs.writeFileSync(path.join(base,'native-plan.txt'),await terminalText());
  await until(async()=>(await snapshot()).sessions[0].nativeSettings?.mode==='plan','Actual native Plan settings reach GUI');
  await page.locator('#subtitle').getByText('Plan',{exact:false}).waitFor();
  const nativeInput=page.locator('#terminal-area .xterm-helper-textarea');
  if(process.env.NAW_NATIVE_GUI_PLAN_TRIAL==='1'){await page.locator('#message-input').fill('Ask me which small approach to use.');await page.locator('#send-button').click();}
  else{await nativeInput.type('Ask me which small approach to use.');await until(async()=>(await terminalText()).includes('Ask me which small approach to use.'),'Native task edit line');await sleep(300);await nativeInput.press('Enter');}
  await until(async()=>(await terminalText()).includes('Which small implementation should be used?'),'Actual native user question');
  await page.locator('#approval').getByText('Which small implementation should be used?',{exact:true}).waitFor();
  await page.locator('#native-phase').getByText('Native context · waitingOnUserInput',{exact:true}).waitFor();
  await page.locator('#approval').getByText('Use existing primitives',{exact:false}).waitFor();
  fs.writeFileSync(path.join(base,'native-question.txt'),await terminalText());fs.writeFileSync(path.join(base,'gui-question.json'),JSON.stringify(await snapshot(),null,2));
  if(process.env.NAW_EVIDENCE_DIR){fs.mkdirSync(process.env.NAW_EVIDENCE_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.NAW_EVIDENCE_DIR,'native-question.png')});}
  if(process.env.NAW_VIDEO_DIR)await sleep(1200);
  assert.equal(calls,2);await page.locator('#approval').getByRole('button',{name:'在 Native context 的原生终端处理',exact:true}).click();
  fs.writeFileSync(path.join(base,'question-control-before-enter.json'),JSON.stringify({ready:!(await page.locator('#terminal-paste').isDisabled()),focused:await page.locator('#terminal-area .xterm-helper-textarea').evaluate(el=>el===document.activeElement)}));
  if(process.env.NAW_NATIVE_FAST_ANSWER!=='1'){await page.locator('#terminal-area .xterm-screen').click();await until(async()=>!(await page.locator('#terminal-paste').isDisabled()),'Actual native input control ready');}
  await page.locator('#terminal-area .xterm-helper-textarea').press('Enter');
  await until(async()=>calls===3&&(await snapshot()).sessions[0].messages.some(m=>m.text==='CONTEXT_TASK_3'),'Actual native answer reaches the original request');
  assert.match(fs.readFileSync(path.join(base,'request-3.json'),'utf8'),/Use existing primitives/);
  await page.locator('#approval').waitFor({state:'hidden'});assert.equal((await snapshot()).sessions[0].nativeId,before.nativeId);
  await until(async()=>(await snapshot()).sessions[0].messages.some(m=>m.title==='原生终端提交的回答'&&m.text.includes('Use existing primitives')),'Actual native submission remains in GUI history');
  assert.equal((await snapshot()).sessions[0].messages.find(m=>m.title==='原生终端提交的回答').text,'Use existing primitives');
  fs.writeFileSync(path.join(base,'question-completed.json'),JSON.stringify(await snapshot(),null,2));
  if(process.env.NAW_EVIDENCE_DIR)await page.screenshot({path:path.join(process.env.NAW_EVIDENCE_DIR,'native-question-completed.png')});
  if(process.env.NAW_VIDEO_DIR)await sleep(1200);
  console.log(JSON.stringify({checks:['Actual native Plan question and exact option descriptions appear in the GUI; native selection returns to the same request, then the GUI receives completion'],localResponses:calls,nativeTitleResponses:titles,paidModelCalls:0,evidence:base}));return;
 }
 await nativeCommand('/status');await until(async()=>(await terminalText()).includes('Session:'),'Native status renders');
 fs.writeFileSync(path.join(base,'original-status.txt'),await terminalText());
 assert.ok((await terminalText()).replace(/\s/g,'').includes(before.nativeId),'Actual TUI identity agrees with GUI before switch');
 await page.locator('#terminal-area .xterm-helper-textarea').press('Escape');
 await page.locator('#message-input').fill('An unsent draft survives native context changes.');
 const nativePid=(await snapshot()).sessions[0].pid;
 await nativeCommand('/new');await sleep(1200);fs.writeFileSync(path.join(base,'new-selection.txt'),await terminalText());
 if(process.env.NAW_CONTEXT_PICKER_PROBE==='1'){console.log(JSON.stringify({pickerProbe:true,text:await terminalText(),evidence:base}));return;}
 await nativeCommand('/status');await until(async()=>/Session:/.test(await terminalText()),'New native status renders');
 const native=await terminalText(),after=await snapshot();fs.writeFileSync(path.join(base,'new-status.txt'),native);fs.writeFileSync(path.join(base,'after-new.json'),JSON.stringify(after,null,2));
 const ids=[...native.replace(/\s/g,'').matchAll(/Session:([a-f0-9-]{36})/g)].map(m=>m[1]);const current=ids.at(-1);assert.ok(current,'Real native status exposes current session identity');assert.notEqual(current,before.nativeId,'Native /new changes thread');
 if(process.env.NAW_REPRODUCE_CONTEXT==='1'){
  assert.equal(after.sessions[0].nativeId,before.nativeId);console.log(JSON.stringify({reproduced:true,guiNativeId:before.nativeId,terminalNativeId:current,localResponses:calls,nativeTitleResponses:titles,paidModelCalls:0,evidence:base}));return;
 }
 assert.equal(after.sessions.find(s=>s.id===before.id)?.nativeId,current,'GUI must follow its actual native terminal context');
 assert.equal(after.sessions[0].pid,nativePid,'A context switch never launches another native display');
 assert.equal(await page.locator('#message-input').inputValue(),'An unsent draft survives native context changes.');
 assert.ok(!after.room.messages.some(m=>m.nativeId===current),'Native context switch does not silently share the new thread');
 checks.push('Native /status proves identity; /new changes the same TUI context and GUI follows without a seed turn');
 await until(async()=>(await snapshot()).sessions[0].chatAvailable,'New native context accepts GUI input');
 await page.locator('#message-input').fill('Check the newly selected context only.');await page.locator('#send-button').click();
 await until(async()=>calls===2&&(await snapshot()).sessions[0].state==='idle'&&(await terminalText()).includes('CONTEXT_TASK_2'),'GUI input and answer reach the new native context');
 const requestTwo=fs.readFileSync(path.join(base,'request-2.json'),'utf8');assert.ok(!requestTwo.includes('Make one small local check.'),'A fresh context never receives old private history');
 assert.ok((await snapshot()).sessions[0].messages.some(m=>m.nativeId===current&&m.text==='CONTEXT_TASK_2'));
 checks.push('GUI sends once to the new native context; actual TUI displays the same reply without carrying old history');
 await nativeCommand('/resume '+before.nativeId);await until(async()=>(await snapshot()).sessions[0].nativeId===before.nativeId,'Native resume follows the exact old context');
 await nativeCommand('/status');await until(async()=>(terminalText()).then(t=>[...t.replace(/\s/g,'').matchAll(/Session:([a-f0-9-]{36})/g)].at(-1)?.[1]===before.nativeId),'Native resumed identity agrees');
 fs.writeFileSync(path.join(base,'resumed.json'),JSON.stringify(await snapshot(),null,2));
 await nativeCommand('/fork');await until(async()=>{const s=(await snapshot()).sessions[0];return s.nativeId!==before.nativeId&&!s.nativeContextPending;},'Native fork follows the exact new context');
 await until(async()=>(await snapshot()).sessions[0].chatAvailable,'Forked history is attached');
 const forked=(await snapshot()).sessions[0];assert.notEqual(forked.nativeId,current);assert.equal(forked.pid,nativePid);
 const oldReply=forked.messages.find(m=>m.text==='CONTEXT_TASK_1'&&m.nativeId===before.nativeId);
 const copiedReply=forked.messages.find(m=>m.text==='CONTEXT_TASK_1'&&m.nativeId===forked.nativeId);
 assert.ok(oldReply&&copiedReply,'Fork retains original provenance and separately imports the inherited native item');assert.notEqual(oldReply.id,copiedReply.id);
 const forkBoundary=forked.nativeContexts.at(-1).boundaryId;
 assert.ok(forked.messages.findIndex(m=>m.id===oldReply.id)<forked.messages.findIndex(m=>m.id===forkBoundary));
 assert.ok(forked.messages.findIndex(m=>m.id===copiedReply.id)>forked.messages.findIndex(m=>m.id===forkBoundary));
 await nativeCommand('/status');await until(async()=>(terminalText()).then(t=>[...t.replace(/\s/g,'').matchAll(/Session:([a-f0-9-]{36})/g)].at(-1)?.[1]===forked.nativeId),'Native forked identity agrees');
 fs.writeFileSync(path.join(base,'forked.json'),JSON.stringify(await snapshot(),null,2));
 checks.push('Native resume and fork preserve the same display/process and update GUI identity and history boundaries');
 for(const command of ['/model','/permissions']){
  await nativeCommand(command);await sleep(500);const screen=await terminalText();fs.writeFileSync(path.join(base,command.slice(1)+'-menu.txt'),screen);
  assert.match(screen,command==='/model'?/Select.*model|Select Model|model.*reasoning|Choose.*model/i:/permission|Read Only|Default|Full Access/i);
  await page.locator('#terminal-area .xterm-helper-textarea').press('Escape');
  assert.equal((await snapshot()).sessions[0].nativeId,forked.nativeId);assert.equal(calls,2);
 }
 checks.push('Real model/permission menus remain native, cancel safely, and do not become model prompts');
 await nativeCommand('/quit');await until(async()=>{const s=(await snapshot()).sessions[0];return s.terminalState?.exitConfirmed&&s.chatAvailable;},'Native display exits and original GUI subscription is restored');
 await page.locator('#message-input').fill('Continue after closing only the native display.');await page.locator('#send-button').click();
 await until(async()=>(await snapshot()).sessions[0].messages.some(m=>m.text==='CONTEXT_TASK_3')&&(await snapshot()).sessions[0].state==='idle','GUI still receives the same native context after terminal exit');
 assert.equal((await snapshot()).sessions[0].nativeId,forked.nativeId);
 checks.push('Native display exit retires its event source once; GUI continuation restores the same thread and receives a complete reply');
 const catalog=await page.evaluate(()=>workspace.nativeHistory({search:''}));
 fs.writeFileSync(path.join(base,'native-history-catalog.json'),JSON.stringify(catalog,null,2));
 assert.ok(catalog.data.some(row=>row.nativeId===before.nativeId||row.nativeId===current),'The original native thread remains in the read-only catalog');
 checks.push('Read-only native history catalog retains the original contexts without another task');
 assert.equal(calls,3);assert.deepEqual(errors,[]);console.log(JSON.stringify({checks,localResponses:calls,nativeTitleResponses:titles,paidModelCalls:0,evidence:base}));
})().catch(async e=>{console.error(e.stack,'\nEvidence:',base);if(page&&!page.isClosed()){fs.writeFileSync(path.join(base,'failure.txt'),await page.locator('body').innerText());await page.screenshot({path:path.join(base,'failure.png')});}process.exitCode=1;}).finally(testScratch.cleanup(async()=>{
 releaseRetry?.();if(app)await app.close().catch(()=>{});server.closeAllConnections();
 try{const c=await connect(profile,'native-context-cleanup');try{for(const s of(await c.call('initial')).sessions)await c.call('stop',s.id);const owned=c.entries.map(e=>processIdentity(e.state.servicePid));for(const p of owned){assert.ok(p&&processMayBeAlive(p));process.kill(p.pid,'SIGTERM');}await until(()=>owned.every(p=>!processMayBeAlive(p)),'Owned service exit',15000);}finally{c.close();}}catch(e){console.error('Cleanup:',e.message);process.exitCode=1;}
 await new Promise(r=>server.close(r));
}));
