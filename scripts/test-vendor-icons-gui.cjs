// Real hidden Electron/DSH and renderer; only native providers are synthetic.
// Set NAW_VENDOR_COMPARE=1 to capture the old GUI, wait for a rebuilt client,
// then relaunch this same owned profile and capture/check the new GUI.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {randomUUID,createHash}=require('node:crypto');
const scratch=require('./fixtures/test-scratch.cjs'),{_electron}=scratch.playwright(require('playwright'));
const {connect}=require('../app/service-client.cjs');
const root=path.resolve(__dirname,'..'),evidence=process.env.NAW_EVIDENCE_DIR,pictures=process.env.NAW_SCREENSHOTS_DIR;
assert.ok(evidence&&pictures&&process.env.NAW_VENDOR_ICONS_DIR&&process.env.NAW_GUI_SLOT);
fs.mkdirSync(evidence,{recursive:true,mode:0o700});fs.mkdirSync(pictures,{recursive:true,mode:0o700});
const slot=process.env.NAW_GUI_SLOT,token=randomUUID();fs.mkdirSync(slot);fs.writeFileSync(path.join(slot,'owner.json'),JSON.stringify({owner:'Codex E',task:'vendor icon C',pid:process.pid,token,at:new Date().toISOString()}));
function releaseSlot(){try{if(JSON.parse(fs.readFileSync(path.join(slot,'owner.json'))).token===token)fs.rmSync(slot,{recursive:true});}catch(e){if(e.code!=='ENOENT')throw e;}}
process.once('exit',releaseSlot);
const profile=scratch.directory(path.join(os.tmpdir(),'naw-vendor-gui-')),cwd=path.join(profile,'work');fs.mkdirSync(cwd);
fs.mkdirSync(path.join(profile,'vendor-icons'));
for(const name of ['anthropic.png','openai.png','deepseek.png'])fs.copyFileSync(path.join(process.env.NAW_VENDOR_ICONS_DIR,name),path.join(profile,'vendor-icons',name));
const child=scratch.childProcess.fork(path.join(root,'app/daemon.cjs'),[profile],{execArgv:['--require',path.join(__dirname,'fixtures/vendor-icon-native.cjs')],env:{...process.env,NAW_TEST_APP_ROOT:root,NAW_WORKSPACE:cwd,NAW_APP_VERSION:require('../package.json').version},stdio:['ignore','ignore','inherit','ipc']});
let app,page,client,seq=0;const errors=[],results={},delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,ms=30000){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await delay(100);}throw Error(label);}
function fixture(method,target,value){const id=++seq;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('fixture timeout')),8000);const on=reply=>{if(reply.requestId===id){clearTimeout(timer);child.off('message',on);reply.error?reject(Error(reply.error)):resolve(reply);}};child.on('message',on);child.send({id,method,target,value});});}
async function launch(){app=await _electron.launch({executablePath:require('electron'),args:[root],env:{...process.env,NAW_DATA_DIR:profile,NAW_TEST_PARENT_PID:String(process.pid)},timeout:60000});page=await app.firstWindow();page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));await page.locator('#new-session').waitFor();const win=await app.browserWindow(page);assert.equal(await win.evaluate(w=>w.isVisible()),false);assert.equal(await win.evaluate(w=>w.isFocusable()),false);await win.evaluate(w=>w.setBounds({width:1240,height:1020}));await page.locator('#sessions-flat').click();}
async function metrics(){return page.evaluate(()=>{
 const bg=el=>{for(let n=el;n;n=n.parentElement){const c=getComputedStyle(n).backgroundColor;if(c!=='rgba(0, 0, 0, 0)'&&c!=='transparent')return c;}return 'transparent';};
 return [...document.querySelectorAll('.vendor-mark')].map(mark=>{const s=getComputedStyle(mark),img=mark.querySelector('.vendor-image'),dot=mark.querySelector('.state-dot'),b=mark.getBoundingClientRect(),i=img?.getBoundingClientRect();return {vendor:mark.dataset.vendor,small:mark.classList.contains('small'),text:mark.textContent,bg:s.backgroundColor,border:s.borderTopWidth,shadow:s.boxShadow,width:b.width,height:b.height,computedImageWidth:img?parseFloat(getComputedStyle(img).width):null,image:i&&{width:i.width,height:i.height,dx:(i.left+i.right-b.left-b.right)/2,dy:(i.top+i.bottom-b.top-b.bottom)/2},dot:dot&&{shadow:getComputedStyle(dot).boxShadow,ring:getComputedStyle(dot).getPropertyValue('--ring').trim()},rowBg:bg(mark.parentElement),sidebar:!!mark.closest('.session-link'),steward:!!mark.closest('.steward-row'),overview:!!mark.closest('.collaboration-overview'),message:!!mark.closest('.message-heading')};});
 });}
async function capture(stage,ids){const all=[];
 for(const theme of ['light','dark']){await page.emulateMedia({colorScheme:theme});await page.waitForFunction(d=>document.body.hasAttribute('data-ds-dark-theme')===d,theme==='dark');
  await page.locator(`#session-list .session-link[data-session-id="${ids.codex}"]`).click();await page.locator('#chat-tab').click();await page.locator('#subtitle').hover();
  await page.screenshot({path:path.join(pictures,`${stage}-${theme}-sidebar.png`)});all.push(...(await metrics()).map(v=>({...v,theme,state:'selected'})));
  await page.locator(`#session-list .session-link[data-session-id="${ids.claude}"]`).hover();await page.screenshot({path:path.join(pictures,`${stage}-${theme}-hover.png`)});all.push(...(await metrics()).filter(v=>v.sidebar).map(v=>({...v,theme,state:'hover'})));
  await page.locator('#room-nav').click();await page.locator('#room-overview').click();await until(()=>page.locator('#collaboration-overview .vendor-image').count(),'overview image');
  await page.screenshot({path:path.join(pictures,`${stage}-${theme}-overview.png`)});all.push(...(await metrics()).map(v=>({...v,theme,state:'overview'})));
  await page.locator('#room-record').click();await page.locator('.message-heading .vendor-image').first().waitFor({state:'attached'});await page.screenshot({path:path.join(pictures,`${stage}-${theme}-record.png`)});all.push(...(await metrics()).map(v=>({...v,theme,state:'record'})));
 }return all;}
function checks(rows){const tests=[];const check=(name,yes)=>tests.push({name,pass:!!yes});
 const images=rows.filter(r=>r.image&&r.width);check('real images in all three vendor sidebar rows',new Set(images.filter(r=>r.sidebar).map(r=>r.vendor)).size===3);
 check('transparent image frames including steward',images.every(r=>r.bg==='rgba(0, 0, 0, 0)'&&r.border==='0px'&&r.shadow==='none'));
 check('large vendor images 26px',images.filter(r=>!r.small).every(r=>Math.abs(r.image.width-26)<.1));
 check('small vendor images proportional',images.filter(r=>r.small).length>0&&images.filter(r=>r.small).every(r=>Math.abs(r.image.width-26*16/28)<.1));
 check('images centered',images.every(r=>Math.abs(r.image.dx)<.1&&Math.abs(r.image.dy)<.1));
 check('steward actually checked',images.some(r=>r.steward));check('overview and small member headers checked',images.some(r=>r.overview)&&images.some(r=>r.small));
 check('state dot has 1.5px separation ring',images.filter(r=>r.dot).every(r=>r.dot.shadow.includes('1.5px')));
 check('state ring matches actual normal, selected and hovered row background',images.filter(r=>r.dot).every(r=>r.dot.shadow.startsWith(r.rowBg+' ')));
 check('legacy message header computed style is proportional (hidden by current stream layout)',rows.some(r=>r.message&&r.small&&Math.abs(r.computedImageWidth-26*16/28)<.1));
 return tests;}
(async()=>{
 await until(()=>fs.existsSync(path.join(profile,'connection.json')),'fixture service');client=await connect(profile,'vendor-test-person');
 const ids={};for(const [key,provider,name] of [['steward','claude','Synthetic steward'],['claude','claude','Synthetic Claude'],['codex','codex','Synthetic Codex'],['deepseek','codex','Synthetic DeepSeek'],['fallback','codex','Synthetic fallback']]){
  ids[key]=await client.call('create',{provider,cwd,name,view:'chat'});if(key!=='steward')await client.call('join',ids[key],true);
  await fixture('history',ids[key],[{id:'result-'+key,type:'agentMessage',turnId:'synthetic-turn',text:'Synthetic result for visual testing. No task was sent.'}]);}
 const steward=(await client.call('initial')).sessions.find(s=>s.id===ids.steward);fs.writeFileSync(path.join(profile,'steward.json'),JSON.stringify({version:1,selected:{sessionId:steward.id,nativeId:steward.nativeId}}),{mode:0o600});
 await launch();
 if(process.env.NAW_VENDOR_BASELINE){results.before=JSON.parse(fs.readFileSync(process.env.NAW_VENDOR_BASELINE,'utf8')).before;results.red=checks(results.before);console.log('REUSED_BASELINE_CHECKS',JSON.stringify(results.red));}
 if(process.env.NAW_VENDOR_COMPARE==='1'){
  const built=path.join(root,'app/dsh/client.js'),hash=()=>createHash('sha256').update(fs.readFileSync(built)).digest('hex'),before=hash();
  results.before=await capture('before',ids);results.red=checks(results.before);console.log('BASELINE_CAPTURED',JSON.stringify(results.red));fs.writeFileSync(path.join(evidence,'before-metrics.json'),JSON.stringify(results,null,2));
  await until(()=>hash()!==before,'waiting for rebuilt client',180000);await app.close();app=null;await launch();
 }
 results.after=await capture('after',ids);results.green=checks(results.after);fs.writeFileSync(path.join(evidence,'gui-metrics.json'),JSON.stringify(results,null,2));
 for(const t of results.green)assert.ok(t.pass,t.name);
 if(results.before){const fallback=rows=>rows.filter(r=>r.sidebar&&!r.image).map(r=>[r.theme,r.state,r.vendor,r.text,r.bg,r.shadow,r.width,r.height]);assert.deepEqual(fallback(results.after),fallback(results.before),'letter fallback unchanged');}
 assert.deepEqual(errors,[]);console.log('GUI',results.green.length,'pass / 0 fail; native model calls 0');
})().catch(async e=>{console.error(e);process.exitCode=1;if(page)await page.screenshot({path:path.join(pictures,'failure.png')}).catch(()=>{});}).finally(async()=>{
 if(app)await app.close().catch(()=>{});if(client){for(const s of client.snapshot().sessions)await client.call('stop',s.id).catch(()=>{});await client.call('shutdown').catch(()=>{});client.close();}
 if(child.exitCode===null)await new Promise(resolve=>child.once('exit',resolve));
 releaseSlot();await scratch.release();
});
