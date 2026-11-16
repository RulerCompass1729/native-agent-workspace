'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {ButlerLedger}=require('../butler-ledger.cjs');
const {RoomState}=require('../room-state.cjs');
const {ButlerIngress,bindQueueOutcomes}=require('../butler-ingress.cjs');
const MARKER='naw-steward-report:1';
function fixture(t){const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'naw-ledger-compat-')));fs.chmodSync(root,0o700);t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
const event=(id,kind)=>({eventId:id,kind,sourceRef:(kind==='done'?'queue-done:':'queue-ready:')+'shared:'+id,payload:{title:kind==='done'?'PASS':'READY lane/synthetic abc1234'}});
const rows=root=>fs.readFileSync(path.join(root,'butler-ledger.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
test('done has one legacy-readable attention-request record and the same logical event slot',t=>{
 const root=fixture(t),ledger=new ButlerLedger(root);for(const [id,kind] of [['before','ready'],['report','done'],['after','ready']])ledger.ingest(event(id,kind));
 const raw=rows(root);assert.equal(raw.length,3);assert.deepEqual(raw.map(r=>r.data.kind),['ready','request','ready']);
 assert.equal(raw[1].version,1);assert.equal(raw[1].data.payload.reason,MARKER);assert.equal(raw[1].data.payload.outcome,'done');
 assert.equal(raw[1].data.payload.title,'PASS');assert.equal(raw[1].data.sourceRef,'queue-done:shared:report');
 const fresh=new ButlerLedger(root),page=fresh.eventsAfter();assert.deepEqual(page.events.map(e=>e.kind),['ready','done','ready']);
 assert.deepEqual(page.events[1].payload,{title:'PASS'});assert.equal(page.through,ledger.latest());assert.equal(page.events[1].sequence,2);
 assert.equal(fs.readdirSync(root).filter(n=>n.startsWith('butler-ledger')).length,1,'No side log or dual write');
});
test('a first done keeps the raw legacy origin and append-only cursor after a legacy-format append',t=>{
 const root=fixture(t),ledger=new ButlerLedger(root);ledger.ingest(event('first','done'));const cursor=ledger.latest(),raw=rows(root);
 const origin=crypto.createHash('sha256').update(JSON.stringify(raw[0])).digest('hex').slice(0,16);assert.equal(cursor,origin+':1');
 const bytes=fs.readFileSync(ledger.file);assert.deepEqual(new ButlerLedger(root).eventsAfter(cursor),{events:[],through:cursor,more:false});assert.deepEqual(fs.readFileSync(ledger.file),bytes);
 const next={version:1,sequence:raw[0].sequence+1,time:Date.now(),type:'event',data:event('legacy-later','ready')};fs.appendFileSync(ledger.file,JSON.stringify(next)+'\n');
 const page=new ButlerLedger(root).eventsAfter(cursor);assert.deepEqual(page.events.map(e=>e.kind),['ready']);assert.equal(page.through,origin+':2');
});
test('reserved envelopes validate strictly, unknown records are refused, and ordinary requests are not decoded',t=>{
 const root=fixture(t),ledger=new ButlerLedger(root);ledger.ingest(event('report','done'));const good=rows(root)[0];
 for(const edit of [r=>r.data.payload.reason='naw-steward-report:2',r=>r.data.payload.outcome='other',r=>r.data.kind='ready',r=>r.data.payload.private='unapproved',r=>r.type='unknown-record']){
  const copy=structuredClone(good);edit(copy);fs.writeFileSync(ledger.file,JSON.stringify(copy)+'\n',{mode:0o600});assert.throws(()=>new ButlerLedger(root));
 }
 fs.writeFileSync(ledger.file,JSON.stringify(good)+'\n',{mode:0o600});
 const fresh=new ButlerLedger(root);fresh.ingest({eventId:'ordinary',kind:'request',sourceRef:'ordinary',payload:{reason:'ordinary',outcome:'done',text:'Synthetic request'}});
 assert.equal(new ButlerLedger(root).eventsAfter().events[1].kind,'request');
});
test('the new reader retains legacy direct done records without rewriting or skipping history',t=>{
 const root=fixture(t),file=path.join(root,'butler-ledger.jsonl'),old={version:1,sequence:1,time:Date.now(),type:'event',data:event('legacy-direct','done')};
 const bytes=Buffer.from(JSON.stringify(old)+'\n');fs.writeFileSync(file,bytes,{mode:0o600});
 const fresh=new ButlerLedger(root);assert.deepEqual(fresh.eventsAfter().events.map(e=>e.kind),['done']);fresh.ingest(event('legacy-direct','done'));assert.deepEqual(fs.readFileSync(file),bytes);
});
test('new done source metadata is opaque to the old source key and recovery still supports the earlier typed source',t=>{
 const root=fixture(t),room=new RoomState(root),ingress=new ButlerIngress(root,{roomState:room});bindQueueOutcomes(room,ingress,()=>{});
 const id=room.queueAdd('Synthetic report',null,'shared',{kind:'secretary',name:'Steward',sessionId:'steward'},'steward');room.queueMarkSent('shared',id,'member','Member');room.queueSettle('shared',id,'done','','Member','PASS');
 const parent=room.metadata().events.find(e=>e.monitor?.kind==='done');assert.ok(parent.butlerDoneSource);assert.equal(Object.hasOwn(parent,'butlerSource'),false);
 ingress.recover();assert.equal(ingress.ledger.eventsAfter().events.length,1);
 const legacy=structuredClone(parent);legacy.butlerSource=legacy.butlerDoneSource;delete legacy.butlerDoneSource;
 assert.equal(require('../butler-ingress.cjs').storedQueueSource('shared',legacy).kind,'done');
});

test('review freezes use the canonical v1 carrier while live event views remain done',t=>{
 const root=fixture(t),person=Symbol('person'),ledger=new ButlerLedger(root,{authorizePerson:p=>p===person});ledger.ingest(event('report','done'));
 const selection={selectionRevision:1,identity:{sessionId:'steward',nativeId:'native'},runnerRef:'synthetic-runner'};
 const batch=ledger.beginBatch(selection),attempt=ledger.beginAttempt(batch.batchId,selection);ledger.recordAttemptUsage(batch.batchId,selection,{costMicros:0},attempt.attempt);
 ledger.completeBatch(batch.batchId,selection,{actions:[{kind:'report',sourceRef:'queue-done:shared:report',text:'Synthetic report result'}]});
 const review=ledger.freezeReview({},person);assert.equal(review.frozen.rows[0].batchSources[0].kind,'request');assert.equal(review.frozen.rows[0].batchSources[0].payload.outcome,'done');
 assert.equal(ledger.snapshot().events[0].kind,'done');
 const fresh=new ButlerLedger(root,{authorizePerson:p=>p===person});assert.deepEqual(fresh.review(review.reviewId,person),ledger.review(review.reviewId,person));assert.equal(fresh.eventsAfter().events[0].kind,'done');
});
