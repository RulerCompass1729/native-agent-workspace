const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const vm = require('node:vm'), crypto = require('node:crypto');
const cp = require('node:child_process'), { EventEmitter, once } = require('node:events');
const { Terminal: Screen } = require('@xterm/headless'), { SerializeAddon: Stock } = require('@xterm/addon-serialize');
const write = (term, data = '') => new Promise(resolve => term.write(data, resolve));
function producer(t) {
  const worker = new EventEmitter(), commands = [];
  worker.stdout = new EventEmitter(); worker.stdout.setEncoding = () => worker.stdout;
  worker.stderr = new EventEmitter(); worker.stdin = new EventEmitter(); worker.stdin.writable = true;
  worker.stdin.write = line => { const value = JSON.parse(line); commands.push(value); assert.ok(!value.type || value.type === 'resize'); return true; };
  const forbidden = () => { throw Error('Snapshot checks cannot launch native processes or read runtime configuration'); };
  const names = ['spawn','spawnSync','fork','exec','execSync','execFile','execFileSync'], saved = Object.fromEntries(names.map(n => [n,cp[n]]));
  const cached = new Set(Object.keys(require.cache)), file = require.resolve('../adapters.cjs'), isolated = new Module(file,module);
  isolated.filename = file; isolated.paths = Module._nodeModulePaths(path.dirname(file)); const original = isolated.require.bind(isolated);
  isolated.require = name => name === 'node:child_process' ? { ...saved, execFileSync: forbidden,
    spawn(binary,args) { assert.equal(binary,'/synthetic/no-exec'); assert.equal(path.basename(args[0]),'pty_host.py'); return worker; } } :
    name === './platform.cjs' ? { executable:forbidden, pythonExecutable:()=>'/synthetic/no-exec', nativeEnvironment:env=>({...env}) } : original(name);
  let terminal;
  try { for (const name of names) cp[name] = forbidden; isolated._compile(fs.readFileSync(file,'utf8'),file); terminal = new isolated.exports.Terminal(['synthetic-no-provider'],'/synthetic/workspace'); }
  finally { Object.assign(cp,saved); for (const name of Object.keys(require.cache)) if (!cached.has(name)) delete require.cache[name]; }
  t.after(() => { terminal.cursorModes.dispose(); terminal.keyboardModes.dispose(); terminal.screen.dispose(); worker.removeAllListeners(); });
  return { terminal, commands, async output(data) { const done = once(terminal,'data'); worker.stdout.emit('data',JSON.stringify({type:'data',data:Buffer.from(data).toString('base64')})+'\n'); return (await done)[0]; },
    async resize(cols,rows=5) { const done=once(terminal,'data');terminal.resize(cols,rows);return(await done)[0]; } };
}
function capture(term) {
  const groups = new Map(), buffers = {};
  for (const name of ['normal',...(term.buffer.active.type === 'alternate' ? ['alternate'] : [])]) {
    const b=term.buffer[name];buffers[name]={x:b.cursorX,y:b.cursorY,base:b.baseY,lines:Array.from({length:b.length},(_,y)=>{
      const l=b.getLine(y);return{wrapped:l.isWrapped,cells:Array.from({length:term.cols},(_,x)=>{
        const c=l.getCell(x),id=c.hasExtendedAttrs()?c.extended.urlId:0,data=id?term._core._oscLinkService.getLinkData(id):null;
        const a=c.clone();a.extended.urlId=0;a.updateExtended();if(id&&!groups.has(id))groups.set(id,groups.size+1);
        return{text:c.getChars(),width:c.getWidth(),fg:a.fg,bg:a.bg,ext:a.extended.ext,uri:data?.uri||null,group:id?groups.get(id):0};
      })};
    })};
  }
  return{cols:term.cols,rows:term.rows,active:term.buffer.active.type,buffers};
}
async function receiver(t,frame) {
  const term=new Screen({cols:100,rows:30,scrollback:5000,allowProposedApi:true});t.after(()=>term.dispose());
  assert.equal(term.buffer.active.getLine(0).translateToString(true),'','Checkpoint reader starts empty');
  term.resize(frame.cols,frame.rows);assert.equal(term.cols,frame.cols);assert.equal(term.rows,frame.rows);
  await write(term,frame.buffer);return term;
}
const open='\x1b]8;id=original;https://example.invalid/snapshot\x1b\\',close='\x1b]8;;\x1b\\';
test('normal snapshot restores native cursor and styled links through continuation, another capture and regrow',async t=>{
  const p=producer(t);await p.resize(40);await p.output('\x1b[6 q\x1b[38;2;12;145;231m'+open+'A'.repeat(70)+close+'B');await p.resize(25);
  const source=capture(p.terminal.screen),frame=await p.terminal.snapshot();assert.deepEqual(capture(p.terminal.screen),source,'Capture cannot mutate source cells or cursor');
  const view=await receiver(t,frame);assert.deepEqual(capture(view),source);assert.equal(frame.cols,25);
  await p.output('NEXT');await write(view,'NEXT');assert.deepEqual(capture(view),capture(p.terminal.screen));
  const again=await receiver(t,await p.terminal.snapshot());assert.deepEqual(capture(again),capture(p.terminal.screen));
  for(const cols of [30,40]){await p.resize(cols);view.resize(cols,5);again.resize(cols,5);await write(view);await write(again);assert.deepEqual(capture(view),capture(p.terminal.screen));assert.deepEqual(capture(again),capture(p.terminal.screen));}
});
test('erased wrapped line does not regain a serializer filler character',async t=>{
  const p=producer(t);await p.resize(40);await p.output('\x1b[44m'+'A'.repeat(70)+'\x1b[49m\x1b[H\x1b[2K');await p.resize(25);
  const view=await receiver(t,await p.terminal.snapshot());assert.deepEqual(capture(view),capture(p.terminal.screen));assert.equal(view.buffer.normal.getLine(0).translateToString(true),'');
});
for(const kind of ['output','resize'])test('journal '+kind+' checkpoint retains the same native snapshot cursor',async t=>{
  const p=producer(t);await p.resize(40);await p.output('\x1b[38;2;12;145;231m'+open+'A'.repeat(70)+close+'B');await p.resize(25);p.terminal.journal.maxEvents=0;
  const event=kind==='output'?await p.output('\x1b[2;25H'):await p.resize(25,6);
  assert.equal(event.checkpointRequired,true);const frame=p.terminal.journal.checkpoint;assert.ok(frame);assert.equal(frame.index,event.index);
  const view=await receiver(t,frame);assert.deepEqual(capture(view),capture(p.terminal.screen));
});
test('wrapped normal history remains correct while alternate is active, then returns after regrow',async t=>{
  const p=producer(t);await p.resize(40);await p.output(Array.from({length:12},(_,i)=>'ROW'+i+'\r\n').join('')+'A'.repeat(70)+'\r\nPROMPT\x1b[?1049hX');await p.resize(25);
  const view=await receiver(t,await p.terminal.snapshot());assert.deepEqual(capture(view),capture(p.terminal.screen));
  await p.output('NEXT');await write(view,'NEXT');for(const cols of [30,40]){await p.resize(cols);view.resize(cols,5);await write(view);assert.deepEqual(capture(view),capture(p.terminal.screen));}
  await p.output('\x1b[?1049l');await write(view,'\x1b[?1049l');assert.deepEqual(capture(view),capture(p.terminal.screen));
});
for(const [name,data]of[['ASCII','A'.repeat(40)],['wide','A'.repeat(38)+'中']])test('already pending right-margin '+name+' snapshot keeps bytes and NEXT wrapping',async t=>{
  const p=producer(t);await p.resize(40);await p.output(data);assert.equal(p.terminal.screen.buffer.active.cursorX,40);
  const plain=new Stock();plain.activate(p.terminal.screen);try{assert.equal((await p.terminal.snapshot()).buffer,plain.serialize()+p.terminal.cursorModes.snapshot());}finally{plain.dispose();}
  const view=await receiver(t,await p.terminal.snapshot());assert.deepEqual(capture(view),capture(p.terminal.screen));await p.output('NEXT');await write(view,'NEXT');assert.deepEqual(capture(view),capture(p.terminal.screen));
});
test('origin and explicit range preserve legacy byte behavior',async t=>{
  const p=producer(t);await p.resize(40);await p.output('\x1b[2;4r\x1b[?6hORIGIN');
  const plain=new Stock();plain.activate(p.terminal.screen);
  try{assert.equal((await p.terminal.snapshot()).buffer,plain.serialize()+p.terminal.cursorModes.snapshot());const options={range:{start:0,end:1}};assert.equal(p.terminal.serialize.serialize(options),plain.serialize(options));}
  finally{plain.dispose();}
  // Byte compatibility is not origin-mode fidelity qualification.
});

for(const fault of ['anchor','hash'])test('unqualified serializer '+fault+' uses existing stock fallback and generic warning',async t=>{
  const adapter=require.resolve('../adapters.cjs'),requireAt=Module.createRequire(adapter),file=requireAt.resolve('@xterm/addon-serialize');
  const original=fs.readFileSync(file,'utf8');let library=original;
  const needle='s+='+String.fromCharCode(96,27)+'['+'$'+'{e.length-this._nullCellCount}C'+String.fromCharCode(96);
  if(fault==='anchor'){assert.equal(library.split(needle).length,2);library=library.replace(needle,needle.replace('s+=','s +='));}
  else library+=' ';
  const adapterText=fs.readFileSync(adapter,'utf8');let factory=adapterText.slice(adapterText.indexOf('function createTerminalSerializeAddon()'),adapterText.indexOf('\nconst delay ='));
  if(fault==='anchor')factory=factory.replace(crypto.createHash('sha256').update(original).digest('hex'),crypto.createHash('sha256').update(library).digest('hex'));
  const warnings=[],fakeFs={...fs,readFileSync(name,...args){return name===file?library:fs.readFileSync(name,...args);}};
  const Ctor=vm.runInNewContext(factory+'\ncreateTerminalSerializeAddon()',{fs:fakeFs,path,crypto,require:requireAt,module,Buffer,console:{warn(value){warnings.push(value);}}});
  const screen=new Screen({cols:40,rows:5,allowProposedApi:true}),addon=new Ctor();screen.loadAddon(addon);t.after(()=>screen.dispose());
  await write(screen,open+'LINK'+close);const data=addon.serialize();assert.equal(data.includes('\x1b]8;'),false);
  assert.deepEqual(warnings,['Native hyperlink snapshot extension unavailable; using the stock terminal serializer.']);
  assert.equal(data,addon.serializePlain());
});
