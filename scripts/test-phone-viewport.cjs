// Real phone assets in WebKit; visual-only viewport changes are synthetic, not a physical keyboard.
const scratch = require('./fixtures/test-scratch.cjs');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {webkit,devices}=require('playwright');
const root=process.env.NAW_TEST_APP_ROOT||path.resolve(__dirname,'..');
const profile=scratch.directory(path.join(os.tmpdir(),'naw-b-phone-viewport-'));
const pictures=process.env.NAW_PICTURES_DIR||profile;fs.mkdirSync(pictures,{recursive:true});
const results=[],requests=[],errors=[];let browser;
const check=(name,pass,actual)=>{results.push({name,pass:Boolean(pass),actual});console.log(JSON.stringify(results.at(-1)));};
(async()=>{
 browser=await webkit.launch({headless:true,executablePath:process.env.NAW_BROWSER_EXECUTABLE,env:{PATH:'/usr/bin:/bin',HOME:profile,TMPDIR:profile}});
 for(const lang of ['zh','en']){
 const context=await browser.newContext({...devices['iPhone 13'],viewport:{width:390,height:844},serviceWorkers:'block'});
 await context.addInitScript(()=>{
   const v=new EventTarget();Object.assign(v,{height:844,width:390,offsetTop:0,offsetLeft:0,scale:1});
   Object.defineProperty(v,'pageTop',{get:()=>scrollY+v.offsetTop});Object.defineProperty(window,'visualViewport',{value:v});
   window.changeVisual=(height,offsetTop)=>{Object.assign(v,{height,offsetTop});v.dispatchEvent(new Event('resize'));v.dispatchEvent(new Event('scroll'));};
 });
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 const sessions=Array.from({length:120},(_,i)=>({id:'s'+i,name:i===0?'Synthetic manager 28':'Synthetic '+i,provider:'claude',state:'idle',available:true,actions:['read','send'],roomIds:['lab']}));
 const messages=Array.from({length:24},(_,i)=>({id:'m'+i,role:i%2?'assistant':'user',text:'Synthetic message '+i+' '+('Readable text. '.repeat(90)),...(i===2?{}:{time:1795100000000+i*60000})}));
 const deviceId='10000000-0000-4000-8000-000000000001';
 await page.route('**/*',async route=>{
   const u=new URL(route.request().url());if(u.origin!=='https://phone.invalid'){errors.push('external request');return route.abort();}
   let data;
   if(u.pathname==='/mobile/session')data={deviceId,csrf:'c'.repeat(43),workspace:true,sessions};
   else if(u.pathname.startsWith('/mobile/read/'))data={id:u.pathname.split('/').at(-1),contextId:'x'.repeat(43),canSend:true,sendMode:'send',messages:[],question:null};
   else if(u.pathname.startsWith('/mobile/workspace/'))data={sessions:sessions.map((s,i)=>({...s,conversationLoaded:i===0,messages:i===0?messages:[]})),rooms:[{id:'lab',name:'Synthetic Lab',members:[],messages:[],queue:[]}],capabilities:{push:false},reminders:{count:0,records:[]},confirmations:[],steward:{state:'shared',sessionId:'s0'}};
   if(data){const text=JSON.stringify(data),start=performance.now();await new Promise(r=>setTimeout(r,80+Buffer.byteLength(text)/625));await route.fulfill({body:text,contentType:'application/json'});requests.push({path:u.pathname,bytes:Buffer.byteLength(text),ms:performance.now()-start});return;}
   const f=u.pathname==='/mobile/'?'index.html':u.pathname.slice('/mobile/'.length);
   if(!['index.html','client.js','workspace.js','style.css','push.js','passkeys.js','manifest.webmanifest'].includes(f))return route.fulfill({status:404,body:''});
   return route.fulfill({path:path.join(root,'app/mobile-web',f)});
 });
 await page.goto('https://phone.invalid/mobile/#'+lang+'/home');await page.waitForFunction(()=>document.documentElement.dataset.loading==='false');
 for(let trial=0;trial<3;trial++){
   const start=performance.now(),before=requests.length;await page.locator('a[href="#'+lang+'/chat/s0"]').tap();
   await page.waitForFunction(()=>document.documentElement.dataset.loading==='false'&&document.querySelector('.thread'));
   const ms=performance.now()-start,rows=requests.slice(before);check(lang+' open '+trial+' reads input context once',rows.filter(r=>r.path==='/mobile/read/s0').length===1,{ms,requests:rows});
   if(trial<2){await page.locator('#top a[href="#'+lang+'/home"]').tap();await page.waitForFunction(()=>document.documentElement.dataset.loading==='false'&&document.documentElement.dataset.page==='home');}
 }
 check(lang+' visible title names the actual manager', (await page.locator('#top').innerText()).includes('Synthetic manager 28'));
 check(lang+' header retains the authorized space context',(await page.locator('#top').innerText()).includes('Synthetic Lab'));
 check(lang+' every message has a truthful timestamp or explicit unknown',await page.locator('.message .author time,.message .author .message-time-unknown').count()===24);
 check(lang+' reading position is explicit',await page.locator('#reading-position').count()===1);
 await page.waitForTimeout(100);
 const normal=await page.evaluate(()=>{const c=document.querySelector('#compose').getBoundingClientRect(),n=document.querySelector('#navigation').getBoundingClientRect(),l=document.querySelector('.thread .message:last-child').getBoundingClientRect();return {headerTop:document.querySelector('#top').getBoundingClientRect().top,headerBottom:document.querySelector('#top').getBoundingClientRect().bottom,compose:{top:c.top,bottom:c.bottom},nav:{top:n.top,bottom:n.bottom},lastBottom:l.bottom,y:scrollY,height:visualViewport.height};});
 check(lang+' session heading stays wholly on screen',normal.headerTop>=0&&normal.headerBottom<=844,normal);
 check(lang+' normal viewport remains anchored at the latest message',Math.abs(normal.nav.bottom-normal.height)<=1&&Math.abs(normal.compose.bottom-normal.nav.top)<=1&&Math.abs(normal.lastBottom-normal.compose.top)<40,normal);
 await page.screenshot({path:path.join(pictures,lang+'-normal.png'),scale:'css'});
 await page.locator('#message').fill('Synthetic unsent draft');
 for(const [height,offset,y] of [[460,0,0],[460,120,180],[380,160,460],[844,0,120]]){
   await page.evaluate(({height,offset,y})=>{changeVisual(height,offset);scrollTo(0,y);}, {height,offset,y});
   await page.waitForTimeout(100);
   const g=await page.evaluate(()=>{
     const c=document.querySelector('#compose').getBoundingClientRect(),n=document.querySelector('#navigation').getBoundingClientRect(),v=visualViewport;
     const b=document.querySelector('#send-message').getBoundingClientRect(),hit=document.elementFromPoint(b.left+b.width/2,b.top+b.height/2);
     return {compose:{top:c.top,bottom:c.bottom},nav:{top:n.top,bottom:n.bottom},visible:{top:v.offsetTop,bottom:v.offsetTop+v.height},hit:hit?.id,font:parseFloat(getComputedStyle(document.querySelector('#message')).fontSize),overflow:document.documentElement.scrollWidth>innerWidth};
   });
   check(lang+' visual-only '+height+'/'+offset+'/'+y+' composer and navigation align',Math.abs(g.compose.bottom-g.nav.top)<=1&&Math.abs(g.nav.bottom-g.visible.bottom)<=1&&g.compose.top>=g.visible.top,g);
   await page.screenshot({path:path.join(pictures,lang+'-visual-'+height+'-'+offset+'.png'),scale:'css'});
   check(lang+' visual-only '+height+'/'+offset+'/'+y+' Send reachable and draft preserved',g.hit==='send-message'&&!g.overflow&&g.font>=16&&await page.locator('#message').inputValue()==='Synthetic unsent draft');
 }
 await page.screenshot({path:path.join(pictures,lang+'-viewport.png'),scale:'css'});
 await context.close();
 }
 check('no page errors or external requests',errors.length===0,errors);
 const fail=results.filter(r=>!r.pass).length;console.log(JSON.stringify({pass:results.length-fail,fail,skip:0}));if(fail)process.exitCode=1;
})().finally(scratch.cleanup(async()=>{await browser?.close();})).catch(e=>{console.error(e.stack);process.exitCode=1;});
