const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../renderer/reading-list.js'), 'utf8');
function reader(extra = {}) { const c = vm.createContext({ ...extra }); vm.runInContext(source, c); return c; }
test('important message clocks use only valid recorded times and local 24-hour dates', () => {
  const r = reader(), now = new Date(2026, 9, 29, 22, 10).getTime(), time = new Date(2026, 9, 29, 9, 5).getTime();
  const clock = r.readingMessageClock({ role: 'user', time }, now);
  assert.equal(clock.text, '09:05'); assert.equal(clock.dateTime, new Date(time).toISOString()); assert.ok(clock.full.includes('2026'));
  const older = r.readingMessageClock({ role: 'assistant', kind: 'response', status: 'complete', time: time - 86400000 }, now);
  assert.ok(older.text.endsWith('09:05')); assert.notEqual(older.text, '09:05');
  for (const time of [undefined, null, NaN, Infinity, 1e20, '1700000000000']) assert.equal(r.readingMessageClock({role:'user', time}, now), null);
  assert.ok(r.readingMessageClock({role:'human', time:0}, now));
});
test('tools, thinking, native boundaries and commentary do not acquire heading clocks', () => {
  const r = reader();
  for (const m of [{role:'tool'}, {role:'system',kind:'turn'}, {role:'assistant',kind:'summary'}, {role:'assistant',kind:'plan'}, {role:'assistant',phase:'commentary'}, {role:'assistant',status:'streaming'}]) assert.equal(r.readingMessageClock({...m,time:1000}), null);
  assert.ok(r.readingMessageClock({role:'assistant',phase:'final_answer',status:'complete',time:1000}));
});
test('copy acknowledgement preserves clicked payload and target even while a live row changes', async () => {
  let resolve, actual; const notices = [], r = reader({api:{copy:text=>{actual=text;return new Promise(r=>resolve=r);}},toast:text=>notices.push(text)});
  const entry = {message:{text:'original'}, displayText:'exact output\n  whitespace\n', actionLabel:'这条命令的输出'};
  const copied = r.copyReadingMessage(entry); assert.equal(actual, entry.displayText); assert.deepEqual(notices, []);
  entry.displayText = 'new streamed output'; entry.actionLabel = 'Other reply'; resolve(); await copied;
  assert.deepEqual(notices, ['已复制：这条命令的输出']);
});
test('rejected copy never reports success', async () => {
  const notices = [], error = Error('Owned copy failure'), r = reader({api:{copy:async()=>{throw error;}},toast:text=>notices.push(text)});
  await assert.rejects(r.copyReadingMessage({message:{text:'body'},actionLabel:'你的输入'}), e=>e===error); assert.deepEqual(notices, []);
});
const native = (id, extra={}) => ({id,nativeId:'N',turnId:'T',nativeBlock:true,kind:'response',role:'assistant',status:'complete',text:id,...extra});
const plain = value => JSON.parse(JSON.stringify(value));
test('visual turn boundaries retain steered inputs and prose without merging their process disclosures', () => {
  const r = reader(), rows = [native('input',{role:'user',kind:'input',inputTag:'first'}),native('tool',{role:'tool',kind:'tool'}),native('prose'),native('steer',{role:'user',kind:'input',inputTag:'second'}),native('answer'),native('end',{role:'system',kind:'turn'}),native('next',{turnId:'T2',role:'user',kind:'input'})];
  const marks = r.readingTurnMarks(rows);
  assert.equal(marks.get('input').start,true); assert.equal(marks.get('steer').start,false); assert.equal(marks.get('answer').start,false); assert.equal(marks.get('next').start,true);
  assert.deepEqual(rows.map(m=>m.id),['input','tool','prose','steer','answer','end','next']);
});
test('paging a long native turn keeps 50 rows and marks its visible beginning as a continuation', () => {
  const r = reader(), rows = Array.from({length:200},(_,i)=>native('r'+i,{role:i?'assistant':'user',kind:i?'response':'input'}));
  const page = r.readingPageRange(r.readingPageData(rows),null,null,{follow:true}); assert.equal(page.end-page.start,50);
  const marks = r.readingTurnMarks(rows.slice(page.start),false,rows); assert.equal(marks.get('r150').start,false); assert.equal(marks.get('r150').continuation,true);
});
test('unknown IDs, gaps, interrupted turns, native context and sharing grants remain boundaries', () => {
  const r = reader(), unknown={id:'unknown',role:'assistant',text:'No identity'};
  const rows=[native('a'),unknown,native('b'),native('stop',{kind:'turn',role:'system',status:'interrupted'}),native('retry'),native('other',{nativeId:'Other'})];
  const marks=r.readingTurnMarks(rows); assert.equal(marks.has('unknown'),false); assert.equal(marks.get('b').start,true); assert.equal(marks.get('retry').start,true); assert.equal(marks.get('other').start,true);
  const shared=(id,sourceTag)=>native(id,{sharedStream:true,sessionId:'S',nativeMessageId:'native:'+id,sourceTag,replyTo:'root',time:1000});
  const grants=r.readingTurnMarks([shared('g1','first'),shared('g2','second'),shared('g3','second')],true);
  assert.equal(grants.get('g2').start,true); assert.equal(grants.get('g3').start,false);
  assert.equal(r.readingTurnMarks([shared('g','')],true).size,0);
});
test('a duplicate native row ID cannot supply a visual identity', () => {
  const r=reader(), original=[native('same'),native('same')]; assert.equal(r.readingTurnMarks(original).size,0);
});
test('an interrupted tool step separates its later retry without hiding either result', () => {
  const r=reader(), marks=r.readingTurnMarks([native('failed',{kind:'tool',role:'tool',status:'interrupted'}),native('retry')]); assert.equal(marks.get('retry').start,true);
});
test('native footer uses exact native metadata, never the local receipt time or message gaps', () => {
  const r=reader(), end=native('end',{kind:'turn',role:'system',nativeDurationMs:30500,nativeCompletedAt:new Date(2026,9,29,21,27).getTime(),time:Date.now()+999999,text:''});
  const info=r.readingTurnFooter(end,new Date(2026,9,29,23).getTime());assert.equal(info.duration,'30s');assert.equal(info.clock.text,'21:27');
  assert.equal(r.readingTurnFooter({...end,nativeDurationMs:undefined,nativeCompletedAt:undefined}),null);
  assert.equal(r.readingTurnFooter({...end,nativeDurationMs:-1,nativeCompletedAt:1e20}),null);
  assert.equal(r.readingTurnFooter({...end,kind:'response'}),null);
  assert.equal(r.readingTurnFooter({...end,nativeDurationMs:500}).duration,'<1s');
  assert.equal(r.readingTurnFooter({...end,nativeDurationMs:3661000}).duration,'1h 1m 1s');
});
