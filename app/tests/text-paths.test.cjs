const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {resolvePath,openTextPath}=require('../text-paths.cjs'),links=require('../renderer/cmd-links.js');
function fixture(t){const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'naw-text-path-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const calls=[];return {dir,calls,file(name,mode=0o600){const p=path.join(dir,name);fs.writeFileSync(p,'synthetic',{mode});return p;},deps:{openPath:async p=>{calls.push(['open',p]);return '';},reveal:p=>calls.push(['reveal',p])}};}
test('spaces, Chinese, literal percent and home paths open without shell interpretation',async t=>{
 const f=fixture(t),p=f.file('图片 sample%20name.png');await openTextPath(p,f.deps);assert.deepEqual(f.calls,[['open',p]]);
 const r=await openTextPath('~/图片 sample%20name.png',{...f.deps,home:f.dir});assert.equal(r.path,p);assert.equal(r.accepted,true);
});
test('directories open in the default file manager; line locations strip only after exact filename lookup',async t=>{
 const f=fixture(t);await openTextPath(f.dir,f.deps);assert.deepEqual(f.calls,[['open',f.dir]]);
 const p=f.file('file.md');const r=await openTextPath(p+':12:4',f.deps);assert.equal(r.line,12);assert.equal(r.lineNavigation,false);assert.deepEqual(f.calls.at(-1),['open',p]);
 const literal=f.file('file.md:12');assert.equal((await resolvePath(literal)).path,literal);assert.equal((await resolvePath(literal)).line,null);
});
for(const ext of ['app','command','sh','tool','terminal','pkg','workflow','scpt','webloc','url','py','html','svg'])test(ext+' is revealed, never opened',async t=>{
 const f=fixture(t),p=path.join(f.dir,'unsafe.'+ext);if(ext==='app')fs.mkdirSync(p);else f.file('unsafe.'+ext);
 const r=await openTextPath(p,f.deps);assert.equal(r.action,'reveal');assert.deepEqual(f.calls,[['reveal',p]]);
});
test('execute bits, active bundle parents, symlinks and unknown types cannot launch',async t=>{
 const f=fixture(t),ex=f.file('material.txt',0o700),unknown=f.file('extensionless');fs.mkdirSync(path.join(f.dir,'Test.app'));const inside=f.file('Test.app/picture.png');
 const alias=path.join(f.dir,'alias.png');fs.symlinkSync(ex,alias);
 for(const p of [ex,unknown,inside,alias])await openTextPath(p,f.deps);
 assert.ok(f.calls.every(x=>x[0]==='reveal'));assert.equal(f.calls.length,4);
});
test('missing, relative, control, URL and network path strings never reach OS opening',async t=>{
 const f=fixture(t);for(const p of ['relative.png','file:///tmp/a','https://example.com/a','//server/share','/missing-naw-fixture',f.dir+'\0/a']){assert.equal(await resolvePath(p),null);await assert.rejects(openTextPath(p,f.deps));}assert.deepEqual(f.calls,[]);
});
test('a window no longer current cannot open; an unconfirmed OS receipt is not accepted',async t=>{
 const f=fixture(t),p=f.file('a.png');await assert.rejects(openTextPath(p,{...f.deps,isCurrent:()=>false}));assert.deepEqual(f.calls,[]);
 await assert.rejects(openTextPath(p,{...f.deps,openPath:async()=>undefined}));
});
test('the actual IPC handler rejects an agent before inspecting or opening anything and is absent from its catalog',async()=>{
 const s=fs.readFileSync(path.join(__dirname,'../main.cjs'),'utf8'),a=s.indexOf("  register('textPath',"),b=s.indexOf("  register('openExternal',",a);let handler,calls=0;const catalog=new Map();
 vm.runInNewContext(s.slice(a,b),{register:(name,fn)=>{handler=fn;catalog.set(name,fn);},applicationHandlers:catalog,isCurrentHumanContext:c=>c.person===true,uiError:key=>Error(key),inspectTextPaths:()=>{calls++;},openTextPath:()=>{calls++;}});
 assert.equal(catalog.has('textPath'),false);assert.throws(()=>handler({background:true},'open','/tmp/a'),/personOnly/);assert.equal(calls,0);
});
test('path parsing retains quoted spaces and Chinese, home/line locations and ordinary URLs',()=>{
 for(const text of ['`~/图片 sample.png:8`','"/tmp/space dir/file.png"','/tmp/图片 sample.png','See /tmp/a.png\nhttps://example.com/path']){
  const r=links.candidates(text);assert.ok(r.length);assert.ok(r.some(x=>x.text.includes('/')));
 }
 assert.ok(links.candidates('`~/图片 sample.png:8`').some(x=>x.text==='~/图片 sample.png:8'));
 assert.equal(links.modifier({metaKey:true}),true);assert.equal(links.modifier({ctrlKey:true}),false);
});
test('real terminal cells reconstruct only soft wraps, retaining wide characters and spaces',async t=>{
 const {Terminal}=require('@xterm/headless'),term=new Terminal({allowProposedApi:true,cols:12,rows:6});t.after(()=>term.dispose());
 const text='/tmp/中文 space/file.png:12';await new Promise(r=>term.write(text+'\r\n/tmp/next.png',r));
 const row=links.logicalLine(term,1);assert.equal(row.text,text);assert.equal(row.cells[text.indexOf('文')].x,8);
 assert.equal(links.logicalLine(term,2).text,text);assert.equal(links.logicalLine(term,4).text.includes('next'),true);
});
test('terminal provider requires Command and disposes its window listeners',async t=>{
 const {Terminal}=require('@xterm/headless'),term=new Terminal({allowProposedApi:true,cols:80,rows:3});t.after(()=>term.dispose());await new Promise(r=>term.write('/tmp/example.png',r));
 const events=new Set(),target={addEventListener:(n,fn)=>events.add(fn),removeEventListener:(n,fn)=>events.delete(fn)};let provider,addon,closed=false;const calls=[];
 const facade={buffer:term.buffer,cols:term.cols,options:{},element:{...target,ownerDocument:{defaultView:target}},registerLinkProvider:p=>{provider=p;return {dispose(){closed=true;}};},loadAddon:a=>{addon=a;}};
 const binding=links.bindTerminal(facade,{api:{textPath:async(action,value)=>{if(action==='inspect')return value.map(text=>({text}));calls.push(value);},openExternal:async()=>{}}});
 const result=await new Promise(r=>provider.provideLinks(1,r));assert.ok(result.length);result[0].activate({metaKey:false});result[0].activate({metaKey:true});assert.deepEqual(calls,['/tmp/example.png']);
 assert.equal(binding.shouldForceSelection({metaKey:true}),false);result[0].hover({metaKey:true});assert.equal(binding.shouldForceSelection({metaKey:true}),true);assert.equal(binding.shouldForceSelection({metaKey:false}),false);assert.equal(result[0].decorations.underline,true);result[0].hover({metaKey:false});assert.equal(result[0].decorations.underline,false);
 result[0].leave();assert.equal(binding.shouldForceSelection({metaKey:true}),false);facade.options.linkHandler.hover({metaKey:true},'https://example.com',{});assert.equal(binding.shouldForceSelection({metaKey:true}),true);facade.options.linkHandler.leave({metaKey:true},'https://example.com',{});assert.equal(binding.shouldForceSelection({metaKey:true}),false);
 addon.dispose();assert.equal(closed,true);assert.equal(events.size,0);
});
test('a filesystem reply for replaced terminal text cannot install or activate stale links',async t=>{
 const {Terminal}=require('@xterm/headless'),term=new Terminal({allowProposedApi:true,cols:80,rows:3});t.after(()=>term.dispose());await new Promise(r=>term.write('/tmp/old.png',r));
 let provider,resolve,addon;const target={addEventListener(){},removeEventListener(){}};
 const facade={buffer:term.buffer,cols:term.cols,options:{},element:{...target,ownerDocument:{defaultView:target}},registerLinkProvider:p=>{provider=p;return {dispose(){}};},loadAddon:a=>{addon=a;}};
 links.bindTerminal(facade,{api:{textPath:()=>new Promise(r=>{resolve=r;})}});
 const result=new Promise(r=>provider.provideLinks(1,r));await new Promise(r=>term.write('\r\x1b[2K/tmp/new.png',r));resolve([{text:'/tmp/old.png'}]);assert.equal(await result,undefined);addon.dispose();
});
test('quoted or inline-code punctuation is literal; upper-case HTTP remains a URL',()=>{
 assert.equal(links.candidates('"/tmp/file.png."')[0].text,'/tmp/file.png.');
 assert.equal(links.candidates('/tmp/文件, image.png.',true)[0].text,'/tmp/文件, image.png.');
 assert.equal(links.candidates('HTTPS://example.com/path')[0].web,true);
});

for(const suffix of ['saver','prefPane','scptd'])test('active package directory '+suffix+' is shown rather than launched',async t=>{
 const f=fixture(t),p=path.join(f.dir,'Synthetic.'+suffix);fs.mkdirSync(p);await openTextPath(p,f.deps);assert.deepEqual(f.calls,[['reveal',p]]);
});
test('an extensionless application bundle and a dotted folder are conservatively revealed',async t=>{
 const f=fixture(t),bundle=path.join(f.dir,'Bundle'),ordinary=path.join(f.dir,'reports.v1');fs.mkdirSync(path.join(bundle,'Contents'),{recursive:true});fs.writeFileSync(path.join(bundle,'Contents/Info.plist'),'synthetic package metadata');fs.mkdirSync(ordinary);
 await openTextPath(bundle,f.deps);await openTextPath(ordinary,f.deps);assert.deepEqual(f.calls,[['reveal',bundle],['reveal',ordinary]]);
});

for(const suffix of ['playground','playgroundbook','unrecognized'])test('a possible code package '+suffix+' cannot auto-open',async t=>{
 const f=fixture(t),p=path.join(f.dir,'Synthetic.'+suffix);fs.mkdirSync(p);await openTextPath(p,f.deps);assert.deepEqual(f.calls,[['reveal',p]]);
});
