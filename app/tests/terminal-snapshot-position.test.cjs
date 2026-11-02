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
for(const [name,input] of [['origin region','\x1b[2;4r\x1b[?6hORIGIN'],['erased pending region','\x1b[2;4r\x1b[44m'+'P'.repeat(40)+'\x1b[2K\x1b[0m'],
  ['blank-led wrap','A'.repeat(40)+'B\x1b[D\x1b[X\x1b[CC'],['trailing background erase','\x1b[44m\x1b[2J\x1b[H']])
test('explicit range, excluded modes and alternate, and scrollback preserve legacy byte behavior: '+name,async t=>{
  const p=producer(t);await p.resize(40);await p.output(input);
  const plain=new Stock();plain.activate(p.terminal.screen);
  try{
    // These inputs change complete default snapshots, so equal option bytes are not vacuous.
    // Each leaves the cursor after its last content, so HEAD adds no absolute move either.
    assert.notEqual(p.terminal.serialize.serialize(),plain.serialize());
    for(const options of [{range:{start:0,end:1}},{excludeModes:true},{excludeAltBuffer:true},{scrollback:0},{scrollback:5}])assert.equal(p.terminal.serialize.serialize(options),plain.serialize(options));
  }
  finally{plain.dispose();}
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


// Default snapshots preserve each buffer's origin/region and pending continuation.
{
  const esc = String.fromCharCode(27), open = esc + ']8;id=origin;https://example.invalid/origin' + esc + '\\', close = esc + ']8;;' + esc + '\\';
  const history = Array.from({ length: 12 }, (_, i) => 'ROW' + i + '\r\n').join('');
  function originCapture(term) {
    const value = capture(term), attr = term._core._inputHandler._curAttrData;
    const id = attr.hasExtendedAttrs() ? attr.extended.urlId : 0;
    value.modes = term.modes;
    value.pen = { fg: attr.fg, bg: attr.bg, extended: attr.hasExtendedAttrs() ? attr.extended.ext : 0,
      uri: id ? term._core._oscLinkService.getLinkData(id)?.uri : null };
    for (const name of Object.keys(value.buffers)) {
      const buffer = term._core._bufferService.buffers[name === 'normal' ? 'normal' : 'alt'];
      value.buffers[name].region = [buffer.scrollTop, buffer.scrollBottom];
    }
    return value;
  }
  function originWitness(term) {
    const value = { current: originCapture(term), stored: {} };
    for (const name of ['normal', 'alternate']) {
      const buffer = term.buffer[name], core = term._core._bufferService.buffers[name === 'normal' ? 'normal' : 'alt'];
      value.stored[name] = { savedX: core.savedX, savedY: core.savedY, region: [core.scrollTop, core.scrollBottom],
        lines: Array.from({ length: buffer.length }, (_, y) => {
          const line = buffer.getLine(y);
          return { wrapped: line.isWrapped, cells: Array.from({ length: line.length }, (_, x) => {
            const cell = line.getCell(x); return [cell.getChars(), cell.getWidth(), cell.fg, cell.bg, cell.extended.ext, cell.extended.urlId];
          }) };
        }) };
    }
    return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }
  const erasedCases = [];
  for (const origin of [false, true]) {
    const base = esc + '[2;4r' + (origin ? esc + '[?6h' : '');
    for (const [label, erase] of [['EL2', '[2K'], ['EL1', '[1K'], ['ED2', '[2J']]) {
      erasedCases.push(['erased-' + label + '-origin=' + origin, base + esc + '[44m' + 'P'.repeat(40) + esc + erase + esc + '[0m']);
    }
    for (const [label, mode] of [['no-wrap', '[?7l'], ['insert', '[4h']]) {
      erasedCases.push(['erased-' + label + '-origin=' + origin, base + esc + '[44m' + 'P'.repeat(40) + esc + '[2K' + esc + '[0m' + esc + mode]);
    }
    erasedCases.push(['erased-wrapped-EL1-origin=' + origin, base + esc + '[44m' + 'P'.repeat(80) + esc + '[1K' + esc + '[0m']);
    erasedCases.push(['erased-RGB-and-open-pen-origin=' + origin,
      base + esc + '[48;2;14;123;91m' + 'P'.repeat(40) + esc + '[2K' + esc + '[0;38;2;177;42;99m' +
      esc + ']8;id=erased-pen;https://example.invalid/erased-pen' + esc + '\\']);
  }
  for (const [label, erase] of [['EL2', '[2K'], ['ED2', '[2J']]) {
    erasedCases.push(['erased-default-region-' + label, esc + '[44m' + 'P'.repeat(40) + esc + erase + esc + '[0m']);
  }
  const cases=[
   ['originDefault',esc+'[?6hORIGIN'],
   ['originRegion',esc+'[2;4r'+esc+'[?6hORIGIN'],
   ['absoluteRegion',esc+'[2;4r'+esc+'[3;4HABS'],
   ['originLinked',esc+'[2;4r'+esc+'[?6h'+esc+'[38;2;12;145;231m'+open+'ORIGIN'],
   ['originHistory',history+esc+'[2;4r'+esc+'[?6hORIGIN'],
   ['originAlternate','NORMAL'+esc+'[?1049h'+esc+'[2;4r'+esc+'[?6hALT'],
   ['inactiveNormalRegion',esc+'[2;4rNORMAL'+esc+'[?1049h'+esc+'[?6hALT'],
   ['originPendingAscii',esc+'[2;4r'+esc+'[?6h'+'A'.repeat(40)],
   ['originPendingWide',esc+'[2;4r'+esc+'[?6h'+'A'.repeat(38)+'中'],
   ['absoluteRegionPending',esc+'[2;4r'+'P'.repeat(40)],
   ['healthyPlain','HEALTHY PLAIN'],
   ['healthyLinked',esc+'[38;2;12;145;231m'+open+'HEALTHY'+close],
   ['healthyPending','A'.repeat(40)],
   ['originPendingStyledLink',esc+'[2;4r'+esc+'[?6h'+esc+'[38;2;12;145;231m'+open+'L'.repeat(40)+close+esc+'[0m'],
   ['originPendingAnonymousWide',esc+'[2;4r'+esc+'[?6h'+esc+'[1;3;4;35m'+esc+']8;;https://example.invalid/wide'+esc+'\\'+'A'.repeat(38)+'中'+close+esc+'[0;32m'],
   ['absolutePendingCurrentPen',esc+'[2;4r'+open+'P'.repeat(40)+close+esc+']8;id=hidden;https://example.invalid/pen'+esc+'\\'+esc+'[0;34m'],
   ['alternatePendingOrigin','NORMAL'+esc+'[?1049h'+esc+'[2;4r'+esc+'[?6h'+'P'.repeat(40)],
   ['inactiveNormalPendingRegion',esc+'[2;4r'+'P'.repeat(40)+esc+'[?1049hALT'],
   ['originDefaultPending',esc+'[?6h'+'P'.repeat(40)],
   ['originInsertPending',esc+'[2;4r'+esc+'[?6h'+esc+'[4h'+'P'.repeat(40)],
   // SGR 22 clears bold and dim together; the reprinted cell and pen must keep each one.
   ['pendingBoldCellDimPen',esc+'[2;4r'+esc+'[1m'+'P'.repeat(40)+esc+'[0;2m'],
   ['pendingDimCellBoldDimPen',esc+'[2;4r'+esc+'[2m'+'P'.repeat(40)+esc+'[1m'],
   ['originPendingDimCellBoldDimPen',esc+'[2;4r'+esc+'[?6h'+esc+'[2m'+'P'.repeat(40)+esc+'[1m'],
   ['inactiveNormalOriginMovedFromFullRow',esc+'[?6h'+'A'.repeat(40)+esc+'[1;5H'+esc+'[?1049hALT'],
   ...erasedCases
  ];
  for (const [name, input] of cases) test('origin and region whole snapshot journey: ' + name, async t => {
    const p = producer(t); await p.resize(40); await p.output(input);
    const before = originWitness(p.terminal.screen), frame = await p.terminal.snapshot();
    assert.equal(originWitness(p.terminal.screen), before, 'Snapshot cannot change source cells, state or saved positions');
    const view = await receiver(t, frame);
    assert.deepEqual(originCapture(view), originCapture(p.terminal.screen));
    await p.output('NEXT'); await write(view, 'NEXT');
    assert.deepEqual(originCapture(view), originCapture(p.terminal.screen));
    const scroll = esc + '[99;1HSCROLL\r\nEND'; await p.output(scroll); await write(view, scroll);
    assert.deepEqual(originCapture(view), originCapture(p.terminal.screen));
    const beforeAgain = originWitness(p.terminal.screen), again = await receiver(t, await p.terminal.snapshot());
    assert.equal(originWitness(p.terminal.screen), beforeAgain);
    assert.deepEqual(originCapture(again), originCapture(p.terminal.screen));
    for (const cols of [25, 30, 40]) {
      await p.resize(cols); for (const term of [view, again]) { term.resize(cols, 5); await write(term); }
      for (const term of [view, again]) assert.deepEqual(originCapture(term), originCapture(p.terminal.screen));
    }
    if (p.terminal.screen.buffer.active.type === 'alternate') {
      const leave = esc + '[?1049l'; await p.output(leave); for (const term of [view, again]) await write(term, leave);
      for (const term of [view, again]) assert.deepEqual(originCapture(term), originCapture(p.terminal.screen));
      await p.output('AFTER'); for (const term of [view, again]) await write(term, 'AFTER');
      for (const term of [view, again]) assert.deepEqual(originCapture(term), originCapture(p.terminal.screen));
    }
    assert.ok(!p.commands.some(command => ['input', 'stop'].includes(command.type)));
  });
  for (const kind of ['output', 'resize']) test('origin ' + kind + ' journal checkpoint uses the same complete formatter', async t => {
    const p = producer(t); await p.resize(40);
    await p.output(esc + '[2;4r' + esc + '[?6h' + esc + '[38;2;12;145;231m' + open + 'P'.repeat(40));
    p.terminal.journal.maxEvents = 0;
    const event = kind === 'output' ? await p.output('NEXT') : await p.resize(40, 6);
    assert.equal(event.checkpointRequired, true);
    const frame = p.terminal.journal.checkpoint; assert.equal(frame.index, event.index);
    const view = await receiver(t, frame); assert.deepEqual(originCapture(view), originCapture(p.terminal.screen));
    await p.output('MORE'); await write(view, 'MORE'); assert.deepEqual(originCapture(view), originCapture(p.terminal.screen));
  });

for (const origin of [false, true]) test('erased pending cursor restores full native state and all three snapshot entry points settle; origin=' + origin, async t => {
  const p = producer(t); await p.resize(40);
  const input = '\x1b[2;4r' + (origin ? '\x1b[?6h' : '') + 'P'.repeat(40) + '\x1b[2K';
  await p.output(input);
  assert.equal(p.terminal.screen.buffer.active.cursorX, 40, 'Actual erase retains the pending cursor');
  const cell = p.terminal.screen.buffer.active.getLine(p.terminal.screen.buffer.active.baseY + p.terminal.screen.buffer.active.cursorY).getCell(39);
  assert.equal(cell.getChars(), '');
  const waitFrame = async promise => {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Snapshot did not settle after pending erase')), 1000); })]); }
    finally { clearTimeout(timer); }
  };
  const frame = await waitFrame(p.terminal.snapshot());
  const initial = await receiver(t, frame); assert.deepEqual(originCapture(initial), originCapture(p.terminal.screen));
  p.terminal.journal.maxEvents = 0;
  const output = await waitFrame(p.output('\x1b[0m'));
  assert.equal(output.checkpointRequired, true); assert.equal(p.terminal.journal.checkpoint.index, output.index); const outputView = await receiver(t, p.terminal.journal.checkpoint); assert.deepEqual(originCapture(outputView), originCapture(p.terminal.screen));
  const resized = await waitFrame(p.resize(40, 6));
  assert.equal(resized.checkpointRequired, true); assert.equal(p.terminal.journal.checkpoint.index, resized.index);
  // Real Buffer.resize clamps x and resets regions; this checkpoint needs the qualified path.
  assert.equal(p.terminal.screen.buffer.active.cursorX, 39);
  assert.equal(p.terminal.screen._core._bufferService.buffer.scrollTop, 0);
  assert.equal(p.terminal.screen._core._bufferService.buffer.scrollBottom, 5);
  const view = await receiver(t, p.terminal.journal.checkpoint);
  assert.deepEqual(originCapture(view), originCapture(p.terminal.screen));
  assert.ok(!p.commands.some(command => ['input', 'stop'].includes(command.type)));
});

for (const location of ['normal', 'alternate', 'inactive-normal', 'above-background-erase']) test('nonuniform selectively erased pending row preserves legacy bytes: ' + location, async t => {
  const p = producer(t); await p.resize(40);
  const selective = esc + '[2;4r' + esc + '[44m' + esc + '[1"qQ' + esc + '[0"q' + 'P'.repeat(39) + esc + '[?2K' + esc + '[0m';
  // Rows erased with a background would otherwise move the content cursor away from the pending row.
  await p.output(location === 'alternate' ? 'NORMAL' + esc + '[?1049h' + selective :
    (location === 'above-background-erase' ? esc + '[44m' + esc + '[2J' + esc + '[0m' : '') +
    selective + (location === 'inactive-normal' ? esc + '[?1049h' + esc + '[HALT' : ''));
  const buffer = location === 'inactive-normal' ? p.terminal.screen.buffer.normal : p.terminal.screen.buffer.active;
  assert.equal(buffer.cursorX, 40);
  assert.equal(buffer.getLine(buffer.baseY + buffer.cursorY).getCell(0).getChars(), 'Q');
  assert.equal(buffer.getLine(buffer.baseY + buffer.cursorY).getCell(39).getChars(), '');
  const plain = new Stock(); plain.activate(p.terminal.screen); t.after(() => plain.dispose());
  const before = originWitness(p.terminal.screen), frame = await p.terminal.snapshot();
  assert.equal(originWitness(p.terminal.screen), before);
  assert.equal(frame.buffer, plain.serialize() + p.terminal.cursorModes.snapshot());
  p.terminal.journal.maxEvents = 0;
  const event = await p.output(esc + '[0m'); assert.equal(event.checkpointRequired, true);
  assert.equal(p.terminal.journal.checkpoint.index, event.index);
  assert.equal(p.terminal.journal.checkpoint.buffer, plain.serialize() + p.terminal.cursorModes.snapshot());
  assert.ok(!p.commands.some(command => ['input', 'stop'].includes(command.type)));
});

}
