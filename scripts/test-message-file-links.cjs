// Owned source GUI + real IPC/file guards; synthetic native events and OS opener sink.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const { joinSpace } = require('./fixtures/space-membership.cjs');
const assert=require('node:assert/strict'),{randomUUID,createHash}=require('node:crypto');
const {execFileSync}=require('node:child_process');
const scratch=require('./fixtures/test-scratch.cjs'),{createIn}=require('./fixtures/create-view.cjs');
const {chooseRecipient,fillRoomMessage}=require('./room-input.cjs');
const {_electron}=scratch.playwright(require('playwright'));
const root=path.resolve(__dirname,'..'), evidence=process.env.NAW_EVIDENCE_DIR;
if(evidence){const dest=path.resolve(evidence);assert.ok(dest!==root&&!dest.startsWith(root+path.sep));}
const common=execFileSync('git',['rev-parse','--path-format=absolute','--git-common-dir'],{cwd:root,encoding:'utf8'}).trim();
const slot=path.join(path.dirname(common),'.local/gui-test-slot.lock'),token=randomUUID();
try{fs.mkdirSync(slot);}catch(error){if(error.code!=='EEXIST')throw error;console.error('GUI slot occupied; no app launched.');process.exit(75);}
fs.writeFileSync(path.join(slot,'owner.json'),JSON.stringify({owner:'Codex 3',task:'T79/T161 message file links',token,pid:process.pid,at:new Date().toISOString()}));
const profile=scratch.directory(path.join(os.tmpdir(),'naw-message-links-'));
const child=scratch.childProcess.fork(path.join(root,'app/daemon.cjs'),[profile],{execArgv:['--require',path.join(__dirname,'fixtures/native-progress.cjs')],env:{...process.env,NAW_APP_VERSION:require('../package.json').version,NAW_WORKSPACE:path.join(profile,'workspace')},stdio:['ignore','ignore','inherit','ipc']});
let app,page,sequence=0;const errors=[],checks=[],flows=[];
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label){for(let i=0;i<180;i++){if(await fn())return;await delay(50);}throw Error(label);}
function fixture(method,target,value){const id=++sequence;return new Promise((resolve,reject)=>{const callback=p=>{if(p.requestId===id){clearTimeout(timer);child.off('message',callback);p.error?reject(Error(p.error)):resolve(p);}};const timer=setTimeout(()=>{child.off('message',callback);reject(Error('Fixture timeout'));},10000);child.on('message',callback);child.send({id,method,target,value});});}
const state=()=>page.evaluate(()=>workspace.initial());
const opens=()=>app.evaluate(()=>globalThis.messageFileOpens);
const check=text=>{checks.push(text);console.log('PASS:',text);};
const identity=s=>s.sessions.map(x=>[x.id,x.nativeId,x.owner,x.model]).sort();
async function capture(name){if(process.env.NAW_SCREENSHOTS_DIR){fs.mkdirSync(process.env.NAW_SCREENSHOTS_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.NAW_SCREENSHOTS_DIR,name+'.png')});}}
async function create(name){await page.locator('#new-session').click();await page.locator('input[name="provider"][value="codex"]').check();await page.locator('#session-name').fill(name);await createIn(page,'chat');await until(async()=>(await state()).sessions.some(s=>s.name===name&&s.state==='idle'),'Synthetic ready');const id=(await state()).sessions.find(s=>s.name===name).id;await joinSpace(page);return id;}
async function select(id){await page.locator(`.session-link[data-session-id="${id}"]`).click();}
const row=(id,host=page)=>host.locator(`[data-message-id="${id}"]`);
async function activate(target,name){
 const button=target.getByRole('button',{name,exact:true});
 try{await button.waitFor({state:'visible'});assert.equal(await button.count(),1);await button.click();}
 catch(error){const rows=await target.evaluateAll(items=>items.map(el=>({html:el.innerHTML,hidden:el.hidden,inert:el.inert,ariaHidden:el.getAttribute('aria-hidden')}))).catch(()=>[]);fs.writeFileSync(path.join(profile,'activation-failure.json'),JSON.stringify({name,rows},null,2));throw error;}
}
async function response(id,key,text,extra={}){await fixture('nativeBlock',id,{id:key,kind:'response',text,status:'complete',...extra});await until(async()=>(await state()).sessions.find(s=>s.id===id).messages.some(m=>m.text===text),'Original response');return(await state()).sessions.find(s=>s.id===id).messages.find(m=>m.text===text).id;}
async function inlineLayout(message, label, compact = true) {
 const geometry = await message.evaluate(element => {
  const first = [...element.querySelectorAll('button')].find(button => button.textContent === '任务板');
  if (!first) throw Error('Original inline file link missing');
  const paragraph = first.closest('p'), style = getComputedStyle(paragraph), linkStyle = getComputedStyle(first), bounds = paragraph.getBoundingClientRect();
  const textRect = node => { const range = document.createRange(); range.selectNodeContents(node); return range.getBoundingClientRect(); };
  const before = [...paragraph.childNodes].find(node => node.nodeType === Node.TEXT_NODE && node.textContent.includes('查看'));
  const walker = document.createTreeWalker(first, NodeFilter.SHOW_TEXT); let text;
  while ((text = walker.nextNode()) && !text.textContent.includes('任务板')) {}
  if (!before || !text) throw Error('Inline sentence text missing');
  const plain = textRect(before), linked = textRect(text);
  const buttons = [...paragraph.querySelectorAll('button')];
  return { font: style.fontSize, linkFont: linkStyle.fontSize, line: parseFloat(style.lineHeight), height: first.getBoundingClientRect().height,
   baselineDelta: Math.abs(plain.top - linked.top), background: linkStyle.backgroundColor,
   scrollWidth: paragraph.scrollWidth, width: paragraph.clientWidth,
   fragmentsContained: buttons.every(button => [...button.getClientRects()].every(rect => rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1)),
   longFragments: buttons.at(-1).getClientRects().length,
   bodyFont: getComputedStyle(element).fontSize,
   fileClass: first.className, candidateMatches: first.matches('.naw-markdown button[class*="_fileLink_"]'),
   dshClassAncestor: Boolean(first.closest('.dsh-markdown')) };
 });
 console.log('INLINE GEOMETRY', label, JSON.stringify(geometry));
 assert.equal(geometry.candidateMatches,true,label+': controlled file renderer remains in the shared Markdown container');
 if (!compact) return { label, ...geometry };
 assert.equal(geometry.linkFont, geometry.font, label + ': file link keeps paragraph font');
 assert.ok(geometry.height <= geometry.line + 1, label + ': file link does not increase the line height');
 assert.ok(geometry.baselineDelta <= 1, label + ': file label sits on the text baseline');
 assert.equal(geometry.background, 'rgba(0, 0, 0, 0)', label + ': inline link has no action-button background');
 assert.ok(geometry.scrollWidth <= geometry.width + 1 && geometry.fragmentsContained, label + ': long file labels wrap inside the reader');
 return { label, ...geometry };
}
async function run(){
 await until(()=>fs.existsSync(path.join(profile,'connection.json')),'Owned daemon');
 app=await _electron.launch({executablePath:require('electron'),args:[process.env.NAW_TEST_SOURCE_ENTRY||root],env:{...process.env,NAW_DATA_DIR:profile,NAW_TEST_PARENT_PID:String(process.pid)},timeout:60000});page=await app.firstWindow();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));await page.locator('#new-session').waitFor();
 if(process.env.NAW_T161_SYNTHETIC_GUARD==='1')assert.equal(await app.evaluate(()=>Boolean(globalThis.nawSyntheticProcessGuard)),true,'Pre-effect source GUI guard installed');
 const initial=await state();assert.equal(fs.realpathSync(path.dirname(initial.newWorkspaceRoot)),fs.realpathSync(profile));
 await app.evaluate(({shell,clipboard},owned)=>{const fs=process.getBuiltinModule('node:fs'),path=process.getBuiltinModule('node:path'),{createHash}=process.getBuiltinModule('node:crypto');globalThis.messageFileOpens=[];globalThis.messageFileCopies=[];globalThis.messageExternalOpens=[];const real=fs.realpathSync(owned);shell.openPath=async file=>{if(!fs.realpathSync(file).startsWith(real+path.sep))throw Error('Outside owned fixture');globalThis.messageFileOpens.push({file,sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex')});return '';};shell.openExternal=async url=>{globalThis.messageExternalOpens.push(url);};clipboard.writeText=text=>globalThis.messageFileCopies.push(text);},profile);
 const ids=[];for(const name of ['File Alpha','File Beta','File Gamma'])ids.push(await create(name));
 const [a,b,c]=ids, baseline=await state(),originalIdentity=identity(baseline),cwd=new Map(baseline.sessions.map(s=>[s.id,s.cwd]));
 for(const folder of cwd.values())assert.ok(fs.realpathSync(folder).startsWith(fs.realpathSync(profile)+path.sep));
 const pixels=await app.evaluate(({nativeImage})=>[30,180,230].map(seed=>{const b=Buffer.alloc(32*24*4,seed);for(let i=3;i<b.length;i+=4)b[i]=255;return nativeImage.createFromBitmap(b,{width:32,height:24,scaleFactor:1}).toPNG().toString('base64');}));
 for(let i=0;i<ids.length;i++){const folder=cwd.get(ids[i]);fs.writeFileSync(path.join(folder,'report.png'),Buffer.from(pixels[i],'base64'),{mode:0o600});fs.writeFileSync(path.join(folder,'report.md'),'SOURCE '+i,{mode:0o600});fs.writeFileSync(path.join(folder,'literal%20name.md'),'LITERAL '+i,{mode:0o600});fs.writeFileSync(path.join(folder,'literal name.md'),'WRONG '+i,{mode:0o600});fs.writeFileSync(path.join(folder,'script.sh'),'echo never-run',{mode:0o600});}
 const md='[Relative PNG](report.png)\n\n[Literal percent](literal%2520name.md)\n\n[Missing](missing.md) [Script](script.sh) [Line](report.md#L24-L30)\n\n[Web](https://example.com/full/path?q=1)';
 const ma=await response(a,'files-a',md),mb=await response(b,'files-b','[Beta PNG](report.png)');
 await select(a);await page.locator('#message-input').fill('PRIVATE ALPHA DRAFT');const alpha=row(ma);await alpha.getByRole('button',{name:'Relative PNG',exact:true}).waitFor();assert.equal((await opens()).length,0);
 assert.equal(await alpha.getByRole('button',{name:'Relative PNG',exact:true}).getAttribute('title'),'report.png');await alpha.getByRole('button',{name:'Relative PNG',exact:true}).focus();await page.keyboard.press('Enter');await until(async()=>(await opens()).length===1,'OS dispatch receipt');assert.equal((await opens())[0].file,fs.realpathSync(path.join(cwd.get(a),'report.png')));assert.equal((await opens())[0].sha256,createHash('sha256').update(Buffer.from(pixels[0],'base64')).digest('hex'));
 await activate(alpha,'Literal percent');await until(async()=>(await opens()).length===2,'Literal file');assert.equal((await opens())[1].file,fs.realpathSync(path.join(cwd.get(a),'literal%20name.md')));
 await activate(alpha,'Missing');await alpha.locator('.naw-markdown > p[role="status"]').filter({hasText:'文件不存在'}).waitFor();assert.equal((await opens()).length,2);await activate(alpha,'Script');await alpha.locator('.naw-markdown > p[role="status"]').filter({hasText:'不会从消息执行'}).waitFor();assert.equal((await opens()).length,2);
 const web=alpha.getByRole('link',{name:'Web',exact:true});await web.hover();assert.equal(await web.getAttribute('title'),'https://example.com/full/path?q=1');await web.click();await until(async()=>(await app.evaluate(()=>globalThis.messageExternalOpens)).length===1,'HTTP existing gate');
 await activate(alpha,'Line');await until(async()=>(await opens()).length===3,'Line file');await alpha.locator('.naw-markdown > p[role="status"]').filter({hasText:'行号暂未定位'}).waitFor();await alpha.hover();await activate(alpha,'复制：Codex的回复');assert.equal(await app.evaluate(()=>globalThis.messageFileCopies.at(-1)),md);await capture('01-solo-paths-errors-copy');check('Solo original reply: path, literal percent, missing/script errors, HTTP target and exact native copy');flows.push('solo original reply -> explicit correct files/errors -> unchanged source copy/draft');
 await select(b);await page.locator('#message-input').fill('PRIVATE BETA DRAFT');await select(c);await page.locator('#room-nav').click();await page.locator('#room-overview').click();const beta=page.locator(`.collaboration-member-reader[data-member-id="${b}"]`);await activate(row(mb,beta),'Beta PNG');await until(async()=>(await opens()).length===4,'Grid beta source');assert.equal((await opens())[3].file,fs.realpathSync(path.join(cwd.get(b),'report.png')));await capture('02-grid-original-member');check('Grid Beta opens Beta file while last solo session is Gamma');flows.push('three-member overview -> Beta file -> correct original source, no recipient/control change');
 await page.locator('#room-record').click();await fixture('bindSends',b);await chooseRecipient(page,b);await fillRoomMessage(page,'Share the synthetic file reference');await page.locator('#forward-button').click();await until(async()=>(await fixture('stats')).stats.sends===1,'One synthetic dispatch');const sent=(await fixture('stats',b)).lastSend;const sharedText='[Shared Beta PNG](report.png)';await response(b,'shared-file',sharedText,{turnId:sent.turnId,inputTag:sent.tag});await fixture('complete',b,{text:sharedText});await until(async()=>(await state()).room.messages.some(m=>m.sharedStream&&m.text===sharedText),'Explicit shared row');const shared=(await state()).room.messages.find(m=>m.sharedStream&&m.text===sharedText);await activate(row(shared.id),'Shared Beta PNG');await until(async()=>(await opens()).length===5,'Shared source dispatch');assert.equal((await opens())[4].file,fs.realpathSync(path.join(cwd.get(b),'report.png')));await capture('03-shared-row-source');check('Explicit shared row resolves its own source; no private row fallback');flows.push('one synthetic shared exchange -> shared source link -> Beta file');
 await chooseRecipient(page,b);await fillRoomMessage(page,'Share the synthetic fallback reference');await page.locator('#forward-button').click();await until(async()=>(await fixture('stats')).stats.sends===2,'Second bounded synthetic dispatch');const fallbackText='[Fallback Beta PNG](report.png)';await fixture('complete',b,{text:fallbackText});await until(async()=>(await state()).room.messages.some(m=>m.finalReply&&!m.sharedStream&&m.text===fallbackText),'Actual fallback final row');const fallback=(await state()).room.messages.find(m=>m.finalReply&&!m.sharedStream&&m.text===fallbackText);await activate(row(fallback.id),'Fallback Beta PNG');await until(async()=>(await opens()).length===6,'Fallback source dispatch');assert.equal((await opens())[5].file,fs.realpathSync(path.join(cwd.get(b),'report.png')));await capture('04-shared-final-fallback');check('A real non-streamed final room reply uses its own source, without a private-history fallback');flows.push('second synthetic shared exchange -> existing final fallback row -> Beta file');
 await select(a);await page.reload();await page.locator('#new-session').waitFor();await until(async()=>(await state()).sessions.length===3,'Same sessions after reload');await select(a);await activate(row(ma),'Relative PNG');await until(async()=>(await opens()).length===7,'Reopened source');const final=await state();assert.deepEqual(identity(final),originalIdentity);assert.equal(final.sessions.find(s=>s.id===a).liveDraft,'PRIVATE ALPHA DRAFT');assert.equal(final.sessions.find(s=>s.id===b).liveDraft,'PRIVATE BETA DRAFT');assert.equal((await fixture('stats')).stats.sends,2);assert.equal((await fixture('stats')).stats.inputs,0);assert.deepEqual(errors,[]);await capture('05-reload-original-identities');check('Reload preserves identities, owners and private drafts; only explicit file clicks dispatch');flows.push('reload -> same source file -> same IDs/owners/drafts, no native input');
 // T161: files embedded in a sentence must read as text, not full-size actions.
 const longName='very-long-local-document-name-'.repeat(4)+'report.md';
 fs.writeFileSync(path.join(cwd.get(a),longName),'LONG SYNTHETIC FILE',{mode:0o600});
 const inlineLabels={board:'任务板',journal:'秘书日志'};
 const inlineText=`先查看 [${inlineLabels.board}](report.md) 和 [${inlineLabels.journal}](literal%2520name.md)，然后继续阅读。长文件：[${longName}](${longName})。`;
 const inlineId=await response(a,'inline-files',inlineText),inline=row(inlineId),layout=[];
 await select(a);await inline.getByRole('button',{name:'任务板',exact:true}).waitFor();
 const win=await app.browserWindow(page);
 // Remove only the candidate's FileLink rule in this owned GUI. All other
 // styles and the actual DSH renderer are identical to the old Main source.
 await page.evaluate(() => {
  const matches=[];
  const find = rules => { for (const rule of rules) { if (rule.selectorText?.includes('naw-markdown') && rule.selectorText.includes('_fileLink_')) matches.push(rule); if (rule.cssRules) find(rule.cssRules); } };
  for(const style of document.querySelectorAll('style'))find(style.sheet.cssRules);
  if (matches.length !== 1) throw Error('Expected one actual candidate FileLink rule: '+JSON.stringify(matches.map(rule=>rule.selectorText)));
  const rule=matches[0];
  window.inlineFileStyleControl = { rule, text: rule.style.cssText };rule.style.cssText='';
 });
 try {
  const old = await inlineLayout(inline,'old-main-style',false);layout.push(old);
  assert.ok(old.height > old.line + 1 || old.linkFont !== old.font || old.baselineDelta > 1,'Old Main styles reproduce the reported oversized inline link');
  await capture('06-inline-old-style');
 } finally {
  await page.evaluate(() => { const saved=window.inlineFileStyleControl;saved.rule.style.cssText=saved.text;delete window.inlineFileStyleControl; });
 }
 for(const theme of ['light','dark']){
  await page.emulateMedia({colorScheme:theme});
  await page.waitForFunction(dark=>document.body.hasAttribute('data-ds-dark-theme')===dark,theme==='dark');
  for(const zoom of [1,1.5]){
   await win.evaluate((w,zoom)=>{w.setSize(1280,850);w.webContents.setZoomFactor(zoom);},zoom);
   await delay(100);await inline.scrollIntoViewIfNeeded();
   layout.push(await inlineLayout(inline,`solo-${theme}-${zoom}`));
  }
 }
 await win.evaluate(w=>{w.webContents.setZoomFactor(1);w.setSize(850,700);});
 await delay(100);layout.push(await inlineLayout(inline,'solo-narrow'));
 const first=inline.getByRole('button',{name:'任务板',exact:true}),second=inline.getByRole('button',{name:'秘书日志',exact:true});
 assert.equal(await first.getAttribute('title'),'report.md');await first.focus();await page.keyboard.press('Enter');
 await until(async()=>(await opens()).length===8,'Inline Enter opens original file');
 assert.equal((await opens())[7].file,fs.realpathSync(path.join(cwd.get(a),'report.md')));
 await page.keyboard.press('Tab');assert.equal(await second.evaluate(el=>el===document.activeElement),true,'Inline links remain in keyboard order');
 assert.equal(await second.evaluate(el=>{const s=getComputedStyle(el);return el.matches(':focus-visible')&&(s.outlineStyle!=='none'||s.boxShadow!=='none');}),true,'Keyboard focus remains visible');
 await page.keyboard.press('Space');await until(async()=>(await opens()).length===9,'Inline Space opens original file');
 assert.equal((await opens())[8].file,fs.realpathSync(path.join(cwd.get(a),'literal%20name.md')));
 await capture('06-inline-solo-narrow');
 await win.evaluate(w=>w.setSize(1280,850));await page.locator('#room-nav').click();await page.locator('#room-overview').click();
 const memberInline=row(inlineId,page.locator(`.collaboration-member-reader[data-member-id="${a}"]`));
 for(const theme of ['light','dark']){
  await page.emulateMedia({colorScheme:theme});await page.waitForFunction(dark=>document.body.hasAttribute('data-ds-dark-theme')===dark,theme==='dark');
  for(const zoom of [1,1.5]){
   await win.evaluate((w,zoom)=>w.webContents.setZoomFactor(zoom),zoom);await delay(100);await memberInline.scrollIntoViewIfNeeded();
   layout.push(await inlineLayout(memberInline,`member-${theme}-${zoom}`));
  }
 }
 await memberInline.getByRole('button',{name:'任务板',exact:true}).click();await until(async()=>(await opens()).length===10,'Member inline click opens original source');
 assert.equal((await opens())[9].file,fs.realpathSync(path.join(cwd.get(a),'report.md')));await capture('07-inline-member');
 const afterInline=await state();assert.deepEqual(identity(afterInline),originalIdentity);
 assert.equal(afterInline.sessions.find(s=>s.id===a).messages.find(m=>m.id===inlineId).text,inlineText,'Original Markdown and targets stay intact');
 assert.equal(afterInline.sessions.find(s=>s.id===a).liveDraft,'PRIVATE ALPHA DRAFT');assert.equal((await fixture('stats')).stats.sends,2);assert.equal((await fixture('stats')).stats.inputs,0);assert.deepEqual(errors,[]);
 check('Inline files keep text size, baseline, wrapping and keyboard access in solo/member readers, themes and zoom; original targets and drafts remain intact');
 const guard=process.env.NAW_T161_SYNTHETIC_GUARD==='1'?await app.evaluate(()=>globalThis.nawSyntheticProcessGuard):null;
 if(guard){assert.deepEqual(guard.blocked,[],'No fallback service or provider launch attempted');assert.equal(guard.allowedInterfaceStarts,1,'Original UI host launched once');}
 const result={checks,flows,layout,guard,errors,stats:(await fixture('stats')).stats,opens:await opens(),productModelCalls:0,realProviderProcesses:0,actualSystemViewerLaunched:false,limits:'Source Electron + actual IPC/file guards with synthetic native transport and OS-opener/clipboard sinks. Installed/default-viewer/physical input/native producer fidelity not proved.'};fs.writeFileSync(path.join(profile,'message-file-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}
run().catch(async error=>{console.error(error.stack);process.exitCode=1;if(app)console.error('OWN GUI DIAGNOSTIC',JSON.stringify(await app.evaluate(({app})=>({version:app.getVersion(),guard:globalThis.nawSyntheticProcessGuard})).catch(()=>null)));if(page&&!page.isClosed())await capture('failure').catch(()=>{});}).finally(async()=>{
 try{await scratch.release();assert.equal(JSON.parse(fs.readFileSync(path.join(slot,'owner.json'))).token,token);fs.unlinkSync(path.join(slot,'owner.json'));fs.rmdirSync(slot);if(evidence)fs.writeFileSync(path.join(evidence,'released.json'),JSON.stringify({owner:'Codex 3',task:'T79 file links',token,ownedProfilesAndProcessesGone:true,at:new Date().toISOString()},null,2));console.log('Owned profile/processes gone; exact canonical token released.');}catch(error){console.error('Cleanup unconfirmed; own token retained:',error.message);process.exitCode=1;}
});
