const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), { randomUUID } = require('node:crypto');
const { Workspace } = require('../workspace.cjs');
const { captureSource, prepareBatch, materializeBatch } = require('../space-merge.cjs');
const { applyImagePayload, imageSource, readImage, copySnapshotImages } = require('../native-images.cjs');
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=', 'base64');
const decoder = { createFromBuffer: bytes => ({ isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }), toPNG: () => bytes, resize() { return this; } }) };
function fixture(t) {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-snapshot-images-')), workspaces = [], counts = { nativeCreates: 0 };
 const make = name => { const w = new Workspace({ binaries: {}, create() { counts.nativeCreates++; throw Error('No native runtime allowed'); }, close() {} }, path.join(dir, name)); workspaces.push(w); return w; };
 const source = make('source'), target = make('target'), sid = randomUUID(), rid = randomUUID();
 const row = { id: 'original-image', sessionId: sid, nativeId: 'synthetic-native', sharedStream: true, role: 'tool', kind: 'tool', text: 'EXACT ORIGINAL IMAGE RESULT', status: 'complete', time: 1 };
 applyImagePayload(row, { index: 0, mime: 'image/png', data: pixel.toString('base64') }, source.dataDir, sid);
 assert.equal(row.images[0].unavailable, undefined);
 source.roomFor(rid, true).messages.push(structuredClone(row));
 const describe = (w, id, name) => ({ id, name, revision: w.roomFor(id).revision, metadataRevision: 0, notes: '', files: [], events: [], messages: w.roomFor(id).messages });
 const empty = () => captureSource({ id: randomUUID(), name: 'Empty', revision: 0, metadataRevision: 0, notes: '', files: [], events: [], messages: [] }, []);
 const batch = (w=source, id=rid) => prepareBatch([captureSource(describe(w,id,'Source'), [], [w.snapshot().nativeImageCacheRoot]),empty()], { operationId: randomUUID(), targetId: randomUUID(), name: 'Copied space', memberIds: [], disposition: 'keep' });
 const selected = (w,b) => { const message = w.roomFor(b.targetId).messages[0]; return imageSource(w.snapshot(), { kind: 'room', roomId: b.targetId, sessionId: sid, nativeId: row.nativeId, messageId: message.id, index: 0 }); };
 t.after(() => { for (const w of workspaces) if (!w.closed) w.close(); fs.rmSync(dir,{recursive:true,force:true}); });
 return { dir, source, target, row, sid, rid, make, batch, selected, counts };
}
test('independent merged native pixels survive source deletion, cold reopen and a second merge without rewriting originals or hashes', async t => {
 const f=fixture(t), batch=f.batch(), originals=materializeBatch(batch);f.target.mergeSnapshot(batch);
 assert.deepEqual(f.target.roomFor(batch.targetId).messages, originals);
 const own=f.selected(f.target,batch);assert.notEqual(own.cachedPath,f.row.images[0].cachedPath);assert.ok(own.cachedPath.startsWith(f.target.dataDir+path.sep));assert.deepEqual((await readImage(own,decoder)).png,pixel);
 f.source.clearSharedHistory(f.rid);if(fs.existsSync(f.row.images[0].cachedPath))fs.unlinkSync(f.row.images[0].cachedPath);assert.equal(fs.existsSync(f.row.images[0].cachedPath),false);
 f.target.close();const reopened=f.make('target');assert.equal(reopened.storageWarning,undefined);
 assert.deepEqual(reopened.roomFor(batch.targetId).messages, originals);
 assert.deepEqual((await readImage(f.selected(reopened,batch),decoder)).png,pixel);
 assert.equal(reopened.mergeSnapshot(batch).persisted,true,'Retry uses already-owned bytes, not the vanished source');
 const next=f.batch(reopened,batch.targetId), third=f.make('third');third.mergeSnapshot(next);
 const copied=third.roomFor(next.targetId).messages[0];assert.deepEqual(copied.images,f.row.images);assert.equal(copied.snapshotHash,originals[0].snapshotHash);assert.deepEqual(copied.snapshotOrigin,originals[0].snapshotOrigin);
 fs.unlinkSync(f.selected(reopened,batch).cachedPath);
 assert.deepEqual((await readImage(f.selected(third,next),decoder)).png,pixel);assert.equal(f.counts.nativeCreates,0);
});
test('tampered pixels and source cache symlinks fail before admitting a snapshot or writing a target copy', t => {
 for (const kind of ['bytes','link']) {
  const f=fixture(t),batch=f.batch(),file=f.row.images[0].cachedPath;
  if(kind==='bytes') fs.writeFileSync(file,Buffer.from(pixel).fill(1,40,42));
  else { const actual=path.join(f.dir,'owned-outside.png');fs.renameSync(file,actual);fs.symlinkSync(actual,file); }
  assert.throws(()=>f.target.mergeSnapshot(batch));assert.equal(f.target.rooms.has(batch.targetId),false);assert.equal(fs.existsSync(path.join(f.target.dataDir,'native-image-cache')),false);
 }
});
test('copy budget failure rolls back only newly-created files and never leaves an admitted partial snapshot', t => {
 const f=fixture(t),second={...structuredClone(f.row),id:'second-source',sessionId:randomUUID()};delete second.images;applyImagePayload(second,{index:0,mime:'image/png',data:pixel.toString('base64')},f.source.dataDir,second.sessionId);f.source.roomFor(f.rid).messages.push(second);const batch=f.batch();assert.throws(()=>copySnapshotImages(f.target.dataDir,batch,pixel.length));assert.equal(fs.existsSync(path.join(f.target.dataDir,'native-image-cache')),false);
});
test('snapshot save failure removes a newly-created copy but keeps preexisting verified cached pixels', t => {
 for (const already of [false,true]) {
  const f=fixture(t),batch=f.batch();let existing;
  if(already){const row=structuredClone(f.row);delete row.images;applyImagePayload(row,{index:0,mime:'image/png',data:pixel.toString('base64')},f.target.dataDir,f.sid);existing=row.images[0].cachedPath;}
  const rename=fs.renameSync;const undo=t.mock.method(fs,'renameSync',(from,to)=>{if(to===path.join(f.target.dataDir,'room-records.json'))throw Error('Synthetic save failure');return rename(from,to);});
  assert.throws(()=>f.target.mergeSnapshot(batch));undo.mock.restore();assert.equal(f.target.rooms.has(batch.targetId),false);
  if(already)assert.deepEqual(fs.readFileSync(existing),pixel);else assert.equal(fs.existsSync(path.join(f.target.dataDir,'native-image-cache')),false);
 }
});
test('invalid cache-location metadata and cache identity cannot alter immutable payloads or use arbitrary files', t=>{
 const f=fixture(t),before=JSON.stringify(f.row);assert.throws(()=>captureSource({id:f.rid,name:'Source',revision:0,metadataRevision:0,notes:'',files:[],events:[],messages:[f.row]},[],['https://example.invalid/native-image-cache']));
 assert.equal(JSON.stringify(f.row),before);
 const altered=structuredClone(f.row);altered.images[0].cachedPath=path.join(f.dir,'outside.png');f.source.roomFor(f.rid).messages=[altered];const batch=f.batch();assert.throws(()=>f.target.mergeSnapshot(batch));assert.equal(f.target.rooms.has(batch.targetId),false);
});

test('a damaged original backend cannot shadow a valid independently retained target image', async t => {
 const f=fixture(t), batch=f.batch();f.target.mergeSnapshot(batch);
 const snapshot=f.target.snapshot();snapshot.nativeImageCacheRoots=[f.source.snapshot().nativeImageCacheRoot,snapshot.nativeImageCacheRoot];
 fs.writeFileSync(f.row.images[0].cachedPath,Buffer.from(pixel).fill(1,40,42));
 const row=f.target.roomFor(batch.targetId).messages[0], source={kind:'room',roomId:batch.targetId,sessionId:f.sid,nativeId:f.row.nativeId,messageId:row.id,index:0};
 assert.deepEqual((await readImage(imageSource(snapshot,source),decoder)).png,pixel);
 const next=f.batch(f.target,batch.targetId),third=f.make('fallback-third');third.mergeSnapshot(next);assert.deepEqual((await readImage(f.selected(third,next),decoder)).png,pixel);
 for(const field of ['snapshotOrigin','snapshotHash']){const forged=structuredClone(f.target.snapshot());delete forged.rooms.find(room=>room.id===batch.targetId).messages[0][field];assert.throws(()=>imageSource(forged,source),'Partial snapshot metadata cannot grant image access');}
 row.text='changed';assert.throws(()=>imageSource(f.target.snapshot(),source),'Saved snapshot hash remains authoritative');
});
test('actual multi-backend routing rejects an old saved owner even after active changes', async t => {
 const {EventEmitter}=require('node:events'),{WorkspaceClient}=require('../workspace-client.cjs');
 const f=fixture(t),batch=f.batch(),calls=[];
 const entries=[f.source,f.target].map((w,index)=>{const state={...w.snapshot(),capabilities:['spaceMergeV1','collaborationSpacesV1']};const client=new EventEmitter();client.close=()=>client.emit('closed');client.call=async method=>{calls.push([index,method]);if(method==='initial')return structuredClone(state);throw Error('Old owner must not receive a merge');};return {key:String(index),client,state};});
 entries[0].state.rooms.push({id:batch.targetId,messages:[],revision:0,snapshotBatches:[{operationId:batch.operationId,binding:batch.binding}]});delete entries[0].state.nativeImageCacheRoot;
 const client=new WorkspaceClient(entries,'1');t.after(()=>client.close());
 assert.equal(client.snapshot().nativeImageCacheRoots.length,1);
 await assert.rejects(client.call('mergeSnapshot',batch));assert.equal(calls.some(([,method])=>method==='mergeSnapshot'),false);
 const {RoomState}=require('../room-state.cjs'),rooms=new RoomState(path.join(f.dir,'rooms'));
 assert.throws(()=>rooms.assertMergeImageSupport({},batch));assert.doesNotThrow(()=>rooms.assertMergeImageSupport({nativeImageCacheRoot:f.target.snapshot().nativeImageCacheRoot},batch));
});
test('recovering an already copied batch uses its saved newer owner when the active backend is older', async t => {
 const {EventEmitter}=require('node:events'),{WorkspaceClient}=require('../workspace-client.cjs'),{RoomState}=require('../room-state.cjs');
 const f=fixture(t),profile=new RoomState(f.dir),a=profile.create('A'),b=profile.create('B');
 f.source.roomFor(a,true).messages.push(structuredClone(f.row));f.target.roomFor(b,true);
 let olderActive=false;
 const state=w=>{const value={...w.snapshot(),capabilities:['spaceMergeV1','collaborationSpacesV1']};if(olderActive&&w===f.source)delete value.nativeImageCacheRoot;return value;};
 const imports=[];
 const entries=[f.source,f.target].map((w,index)=>{const peer=new EventEmitter();peer.call=async(method,...args)=>{if(method==='initial')return state(w);assert.equal(method,'mergeSnapshot');imports.push(index);return w.mergeSnapshot(...args);};peer.close=()=>peer.emit('closed');return {key:String(index),client:peer,state:state(w)};});
 const client=new WorkspaceClient(entries,'1');t.after(()=>client.close());
 const batch=await profile.mergePreview(client,{sourceIds:[a,b],name:'Saved image space',memberIds:[],disposition:'keep'});
 assert.equal((await profile.mergeCommit(client,batch.operationId,batch.binding)).stage,'ready');
 const originals=structuredClone(f.target.roomFor(batch.targetId).messages);
 // The import has persisted; a restart can occur before the joining stage ends.
 profile.setMerge(batch.targetId,{stage:'joining'});olderActive=true;client.active=entries[0];await client.refresh();
 assert.equal(client.snapshot().nativeImageCacheRoot,undefined);assert.ok(entries[1].state.nativeImageCacheRoot);
 assert.equal((await profile.mergeCommit(client,batch.operationId,batch.binding,true)).stage,'ready');
 assert.deepEqual(f.target.roomFor(batch.targetId).messages,originals);assert.deepEqual(imports,[1]);
 // A new image merge into that old active backend still refuses before any import.
 await assert.rejects(profile.mergePreview(client,{sourceIds:[a,b],name:'Unsupported new target',memberIds:[],disposition:'keep'}));assert.deepEqual(imports,[1]);
 assert.equal(f.counts.nativeCreates,0);
});
