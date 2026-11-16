const test=require('node:test'),assert=require('node:assert/strict');
const {Terminal}=require('@xterm/headless'),{terminalDialogPrompt}=require('../native-terminal-dialog.cjs'),op=require('../background-operation.cjs');
const write=(screen,text)=>new Promise(resolve=>screen.write(text,resolve));
const dialog=(title='Switch model?',options=['Yes, switch to model-x','No'],selected=0)=>'\x1b[2J\x1b[H'+title+'\r\n'+options.map((o,i)=>(i===selected?'❯ ':'  ')+(i+1)+'. '+o).join('\r\n')+'\r\nPress enter to confirm or esc to cancel';
const A=dialog(),B=dialog('Switch model?',['Yes, switch to model-y','No']);
const lastOption=detail=>dialog('Switch model?',['Cancel','Continue\r\n     '+detail],1);
const modelEffort=level=>dialog('Select model',['Default','Opus\r\n◉ '+level+' effort']);
async function fixture(t,initial=A){
 const screen=new Terminal({cols:100,rows:30,allowProposedApi:true});t.after(()=>screen.dispose());const journal={epoch:'synthetic-epoch',index:1},runtime={terminal:{alive:true,screen,journal}},record={id:'t',provider:'codex',nativeId:'native-t',state:'idle'};
 const snapshot=approval=>({...record,terminalState:{alive:true,epoch:journal.epoch,observationIndex:journal.index},nativeTerminalDialog:terminalDialogPrompt(record,runtime),nativeApproval:approval});
 const change=async text=>{await write(screen,text);journal.index++;return snapshot();};
 await change(initial);return {screen,journal,runtime,record,snapshot,change};
}
const scenarios=[
 ['same dialog redrawn three times',[A,A,A],'valid'],
 ['same-title option text replaced in one chunk',[B],'invalid'],
 ['highlight moves to option two',[dialog('Switch model?',['Yes, switch to model-x','No'],1)],'invalid'],
 ['same-title dialog follows a dialog-free frame',['\x1b[2J\x1b[Hworking...\r\n',B],'invalid'],
 ['a different title replaces the choice',[dialog('Choose effort?',['High','Low'])],'invalid'],
 ['selection moves away and returns',[dialog('Switch model?',['Yes, switch to model-x','No'],1),A],'invalid'],
 ['last option hard-wrapped detail changes',[lastOption('Keep synthetic directory B')],'invalid',lastOption('Keep synthetic directory A')],
 ['a setting after the numbered options changes',[modelEffort('Low')],'invalid',modelEffort('High')],
];
for(const [name,chunks,expected,initial] of scenarios)test('real detector: '+name,async t=>{
 const f=await fixture(t,initial),before=f.snapshot(),proof=op.terminalInputProof(before);for(const text of chunks)await f.change(text);const after=f.snapshot();
 assert.equal(op.checkTerminalInput(proof,{sessions:[after]},'t').status,expected);
 if(name==='same-title option text replaced in one chunk'||name==='highlight moves to option two')assert.equal(after.nativeTerminalDialog.since,before.nativeTerminalDialog.since,'A key change must not restart the butler episode');
});
test('real detector: changed approval request still revokes an unchanged dialog',async t=>{
 const f=await fixture(t),approval=id=>({nativeOnly:true,requests:[{id,title:'Synthetic permission'}]});const proof=op.terminalInputProof(f.snapshot(approval('a')));
 await f.change(A);assert.equal(op.checkTerminalInput(proof,{sessions:[f.snapshot(approval('b'))]},'t').status,'invalid');
});
test('real detector: a wider resize with unchanged logical dialog remains valid',async t=>{
 const f=await fixture(t),before=f.snapshot(),proof=op.terminalInputProof(before);f.screen.resize(140,30);f.journal.index++;
 const after=f.snapshot();assert.equal(op.checkTerminalInput(proof,{sessions:[after]},'t').status,'valid');assert.equal(after.nativeTerminalDialog.since,before.nativeTerminalDialog.since);
});
test('real detector: without a dialog any output still revokes the frame proof',async t=>{
 const f=await fixture(t,'plain output'),proof=op.terminalInputProof(f.snapshot());await f.change('more output');assert.equal(op.checkTerminalInput(proof,{sessions:[f.snapshot()]},'t').status,'invalid');
});
test('real detector: dismissal cannot reuse an instance when the clock has not advanced',async t=>{
 t.mock.method(Date,'now',()=>1000);const f=await fixture(t),proof=op.terminalInputProof(f.snapshot());await f.change('\x1b[2J\x1b[Hworking...');await f.change(A);
 assert.equal(op.checkTerminalInput(proof,{sessions:[f.snapshot()]},'t').status,'invalid');
});
test('real detector: persisted proof contains only dialog metadata, no region text or digest',async t=>{
 const f=await fixture(t),prompt=f.snapshot().nativeTerminalDialog,proof=op.terminalInputProof(f.snapshot());
 assert.deepEqual(Object.keys(proof.stateMark).sort(),['kind','revision','since']);assert.equal(proof.stateMark.revision,0);assert.deepEqual(Object.keys(prompt).sort(),['kind','revision','since','title']);
 assert.doesNotMatch(JSON.stringify(proof),/Switch model|model-x|region|dialogKey/);
});
test('legacy dialogs without a revision retain strict frame invalidation',()=>{
 const s={id:'t',nativeId:'native-t',state:'idle',terminalState:{alive:true,epoch:'e',observationIndex:1},nativeTerminalDialog:{kind:'choice',title:'Legacy?',since:1}};
 const proof=op.terminalInputProof(s);const after={...s,terminalState:{...s.terminalState,observationIndex:2}};assert.equal(op.checkTerminalInput(proof,{sessions:[after]},'t').status,'invalid');
});
