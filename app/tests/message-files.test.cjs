const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { openMessageFile } = require('../local-files.cjs');
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'naw-message-file-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const a = path.join(root, 'a'), b = path.join(root, 'b'); fs.mkdirSync(a); fs.mkdirSync(b);
  for (const cwd of [a,b]) fs.writeFileSync(path.join(cwd, 'report.md'), cwd === a ? 'FIRST' : 'SECOND', { mode: 0o600 });
  const message = { id: 'reply', nativeId: 'native-a', role: 'assistant', text: '[Report](report.md)', status: 'complete' };
  const snapshot = { sessions: [{ id: 'a', nativeId:'native-a', cwd: a, messages: [message] }, { id: 'b', nativeId:'native-b', cwd: b, messages: [{ ...message, nativeId:'native-b' }] }], room: { messages: [] } };
  const source = { kind: 'session', sessionId:'a', messageId:'reply', nativeId:'native-a', cwd:a }, opened=[];
  const deps={ snapshot:async()=>snapshot, openPath:async file=>{opened.push(file);return '';}};
  return { root,a,b,message,snapshot,source,opened,deps };
}
test('relative targets stay with the original logical session even when another session has the same filename',async t=>{
  const f=fixture(t); const result=await openMessageFile(f.deps,f.source,'report.md');
  assert.equal(result.accepted,true); assert.equal(result.path,path.join(f.a,'report.md'));
  assert.deepEqual(f.opened,[path.join(f.a,'report.md')]);
  assert.equal(fs.readFileSync(f.opened[0],'utf8'),'FIRST');
  assert.equal(f.snapshot.sessions[1].messages[0].nativeId,'native-b');
});
test('absolute paths and a literal percent sequence are not decoded a second time',async t=>{
  const f=fixture(t), file=path.join(f.a,'literal%20name.md');fs.writeFileSync(file,'LITERAL',{mode:0o600});
  fs.writeFileSync(path.join(f.a,'literal name.md'),'WRONG',{mode:0o600});
  const result=await openMessageFile(f.deps,f.source,file,{line:24});assert.deepEqual(f.opened,[file]);
  assert.equal(result.line,24);assert.equal(result.lineNavigation,false);
});
test('a shared row cannot borrow an unshared private message as its source',async t=>{
  const f=fixture(t),source={...f.source,kind:'room'};
  await assert.rejects(openMessageFile(f.deps,source,'report.md'),/原消息/);
  f.snapshot.room.messages.push({...f.message,sessionId:'a',sharedStream:true});
  await openMessageFile(f.deps,source,'report.md');assert.equal(f.opened.length,1);
});
test('old records can bind their explicit unknown native identity without inventing one',async t=>{
  const f=fixture(t);delete f.message.nativeId;
  await openMessageFile(f.deps,{...f.source,nativeId:null},'report.md');assert.equal(f.opened.length,1);
  await assert.rejects(openMessageFile(f.deps,f.source,'report.md'),/原消息/);
});
for (const kind of ['addressed','peer-handoff','fallback-final']) test('an existing '+kind+' room reply opens only from its own shared row',async t=>{
  const f=fixture(t),row={id:'room-reply',role:'assistant',sessionId:'a',text:'[Report](report.md)',...(kind==='fallback-final'?{finalReply:true}:{addressed:true})};
  f.snapshot.room.messages.push(row);
  const source={...f.source,kind:'room',messageId:row.id,nativeId:null};
  await openMessageFile(f.deps,source,'report.md');assert.deepEqual(f.opened,[path.join(f.a,'report.md')]);
  f.snapshot.room.messages=[];
  await assert.rejects(openMessageFile(f.deps,source,'report.md'),/原消息/);
});
for(const context of ['switched','pending','legacy-after-boundary','returned-native-id']) test('unknown original cwd after '+context+' never borrows the current directory',async t=>{
  const f=fixture(t),session=f.snapshot.sessions[0];session.cwd=f.b;
  if(context==='pending')session.nativeContextPending={nativeId:'native-a',reason:'terminal-switch'};
  else{session.nativeContexts=[{nativeId:'native-a',reason:'terminal-switch'}];if(context!=='returned-native-id')session.nativeId='new-native';}
  if(context==='legacy-after-boundary')delete f.message.nativeId;
  const source={...f.source,nativeId:f.message.nativeId||null,cwd:null};
  await assert.rejects(openMessageFile(f.deps,source,'report.md'),/没有可核对的工作目录/);
  assert.deepEqual(f.opened,[]);
  await assert.rejects(openMessageFile(f.deps,{...source,cwd:f.b},'report.md'),/原消息/);
  await openMessageFile(f.deps,source,path.join(f.a,'report.md'));
  assert.deepEqual(f.opened,[path.join(f.a,'report.md')]);
});
for(const mutation of ['cwd','native','removed','window']) test('an async '+mutation+' change prevents the OS open',async t=>{
  const f=fixture(t);let calls=0,alive=true;
  f.deps.isCurrent=()=>alive;
  f.deps.snapshot=async()=>{if(++calls===2){if(mutation==='cwd')f.snapshot.sessions[0].cwd=f.b;else if(mutation==='native')f.message.nativeId='new-native';else if(mutation==='removed')f.snapshot.sessions[0].messages=[];else alive=false;}return f.snapshot;};
  await assert.rejects(openMessageFile(f.deps,f.source,'report.md'),/原消息/);assert.equal(f.opened.length,0);
});
test('a file replaced while source validation is pending is not opened',async t=>{
  const f=fixture(t);let calls=0;
  f.deps.snapshot=async()=>{if(++calls===2){const file=path.join(f.a,'report.md');fs.renameSync(file,file+'.old');fs.writeFileSync(file,'REPLACED',{mode:0o600});}return f.snapshot;};
  await assert.rejects(openMessageFile(f.deps,f.source,'report.md'),/文件在检查时已变化/);assert.equal(f.opened.length,0);
});
test('missing files, directories, symbolic links, executable material and scripts are rejected',async t=>{
  const f=fixture(t);fs.mkdirSync(path.join(f.a,'folder.md'));fs.symlinkSync(path.join(f.a,'report.md'),path.join(f.a,'alias.md'));
  fs.writeFileSync(path.join(f.a,'run.md'),'executable',{mode:0o700});fs.writeFileSync(path.join(f.a,'script.sh'),'echo should-not-run',{mode:0o600});
  for(const file of ['missing.md','folder.md','alias.md','run.md','script.sh'])await assert.rejects(openMessageFile(f.deps,f.source,file));
  assert.equal(f.opened.length,0);
});
test('invalid schemes, unknown contexts and invalid location options fail before dispatch',async t=>{
  const f=fixture(t);
  for(const file of ['https://example.com/a.md','file:///example/a.md','//host/a.md','bad\0.md'])await assert.rejects(openMessageFile(f.deps,f.source,file));
  await assert.rejects(openMessageFile(f.deps,{...f.source,messageId:'other'},'report.md'));
  await assert.rejects(openMessageFile(f.deps,f.source,'report.md',{line:0}));assert.equal(f.opened.length,0);
});
test('default-application rejection and an unknown receipt are not reported as success',async t=>{
  const f=fixture(t);f.deps.openPath=async()=> 'Application rejected the file';
  await assert.rejects(openMessageFile(f.deps,f.source,'report.md'),/Application rejected/);
  f.deps.openPath=async()=>undefined;await assert.rejects(openMessageFile(f.deps,f.source,'report.md'),/没有确认/);
});
