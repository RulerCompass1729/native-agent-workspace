const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../renderer/renderer.js'),'utf8');
const start=source.indexOf('function nativeApprovalPreview('),end=source.indexOf('function renderNativeOnlyApproval(',start);
const helpers=vm.runInNewContext(start>=0&&end>start?source.slice(start,end)+';({nativeApprovalPreview,nativeApprovalExcerpt,nativeApprovalChangeExcerpts})':'({})');
const preview=r=>JSON.parse(JSON.stringify(helpers.nativeApprovalPreview(r)));
test('native Edit fields produce literal before/after previews and preserve the exact original input',()=>{
 const input=' {"file_path":"notes.txt","old_string":"old\\n  literal","new_string":"new\\n  literal","replace_all":true,"other":7} ';
 const p=preview({title:'Edit',input});assert.equal(p.label,'Edit notes.txt');assert.equal(p.kind,'edit');assert.equal(p.before,'old\n  literal');assert.equal(p.after,'new\n  literal');assert.equal(p.raw,input);
});
test('native Bash command is read from its actual command field, with no shell classification',()=>{
 const input=JSON.stringify({command:'printf "a  b"\nnext',description:'Original description'}),p=preview({title:'Bash',input});assert.equal(p.label,'Bash printf "a  b" next');assert.equal(p.command,'printf "a  b"\nnext');assert.equal(p.raw,input);
});
for(const input of ['not JSON','[]','null','{"file_path":"x","old_string":7,"new_string":"new"}'])test('unknown or malformed requests retain raw content: '+input,()=>{
 const p=preview({title:'Edit',input});assert.equal(p.kind,'raw');assert.equal(p.raw,input);
});
test('unknown tools do not acquire Edit or shell semantics from matching input fields',()=>{
 const input=JSON.stringify({file_path:'x',old_string:'old',new_string:'new',command:'git status'}),p=preview({title:'OtherNativeTool',input});assert.equal(p.kind,'raw');assert.equal(p.label,'OtherNativeTool');assert.equal(p.raw,input);
});
test('question headings remain native data and are not GUI approval authority',()=>{
 const input=JSON.stringify({questions:[{header:'Original header',question:'Original question?',options:[{label:'Choice'}]}]}),p=preview({title:'AskUserQuestion',input});assert.equal(p.label,'AskUserQuestion Original header');assert.equal(p.kind,'questions');assert.equal(p.raw,input);
});
test('bounded literal excerpts never split a surrogate or mutate the original body',()=>{
 const long='😀'.repeat(1300),p=helpers.nativeApprovalExcerpt(long);assert.equal(Array.from(p.text).length,1200);assert.equal(p.truncated,true);assert.equal(long.length,2600);
 const lines=Array.from({length:20},(_,i)=>'  line '+i).join('\n'),q=helpers.nativeApprovalExcerpt(lines);assert.equal(q.text,lines.split('\n').slice(0,8).join('\n'));assert.equal(q.truncated,true);
 assert.equal(helpers.nativeApprovalExcerpt('').text,'');assert.equal(helpers.nativeApprovalExcerpt('').truncated,false);
});
test('an empty native request list stays hidden across identical subsequent renders',()=>{
 const el={hidden:false,dataset:{},classList:{toggle(){}},replaceChildren(){}};
 const begin=source.indexOf('function renderApproval('),finish=source.indexOf('function renderAdvanced(',begin);
 const render=vm.runInNewContext(source.slice(begin,finish)+';renderApproval',{$:()=>el,approvalViews:new Map(),nativeStatusFresh:()=>true,renderNativeOnlyApproval:el=>{el.hidden=true;}});
 const session={id:'A',nativeId:'N',name:'Agent',state:'approval',nativeApproval:{nativeOnly:true,requests:[]}};
 render(session,true);assert.equal(el.hidden,true);render(session,true);assert.equal(el.hidden,true);
});

test('Edit replacement scope comes from the original explicit flag, without invented match counts',()=>{
 const base={file_path:'notes.txt',old_string:'old',new_string:'new'};
 assert.equal(preview({title:'Edit',input:JSON.stringify({...base,replace_all:false})}).scope,'单处');
 assert.equal(preview({title:'Edit',input:JSON.stringify({...base,replace_all:true})}).scope,'全部匹配');
 assert.equal(preview({title:'Edit',input:JSON.stringify(base)}).scope,'');
});
test('literal edit excerpts include the actual first changed line after a long common prefix',()=>{
 const common=Array.from({length:40},(_,i)=>'Same original line '+i).join('\n')+'\n';const p=helpers.nativeApprovalChangeExcerpts(common+'OLD changed tail',common+'NEW changed tail');
 assert.ok(p.before.text.includes('OLD changed tail'));assert.ok(p.after.text.includes('NEW changed tail'));assert.equal(p.before.truncated,true);assert.equal(p.after.truncated,true);
});
test('edit excerpts preserve changed Unicode after a long single line and insertion/deletion edges',()=>{
 const common='😀'.repeat(3000);const p=helpers.nativeApprovalChangeExcerpts(common+'OLD',common+'NEW');assert.ok(p.before.text.endsWith('OLD'));assert.ok(p.after.text.endsWith('NEW'));assert.ok(!p.before.text.includes('�'));
 const add=helpers.nativeApprovalChangeExcerpts('','Inserted literal');assert.equal(add.before.text,'');assert.equal(add.after.text,'Inserted literal');
 const remove=helpers.nativeApprovalChangeExcerpts('Removed literal','');assert.equal(remove.before.text,'Removed literal');assert.equal(remove.after.text,'');
});
