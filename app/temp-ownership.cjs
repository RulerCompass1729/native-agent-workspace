// Durable creation receipts. A name/prefix is never evidence of ownership.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { createHash } = require('node:crypto');
const { lockIdentity } = require('./service-lock.cjs');
const inside = (root, file) => file === root || file.startsWith(root + path.sep);
// Unrelated store entries grant no ownership. Receipt-shaped entries still
// pass through entry(), including noncanonical hex casing, and fail closed.
const receiptName = name => /^[a-f0-9]{64}\.json$/i.test(name);
const receiptId = r => createHash('sha256').update(JSON.stringify([r.path,r.dev,r.ino,r.uid ?? process.getuid()])).digest('hex');
const roots = () => [...new Set([os.tmpdir(), '/tmp'].map(p => fs.realpathSync(p)))];
const defaultDirectory = () => process.env.NAW_TEMP_REGISTRY_DIR || path.join(process.env.NAW_DATA_DIR ||
  (process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support', 'Native Agent Workspace') : path.join(os.homedir(), '.local', 'share', 'Native Agent Workspace')), 'temp-ownership');
function privateDirectory(directory, create = false) {
  if (create) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const s=fs.lstatSync(directory);
  const expected=process.platform==='darwin'?path.resolve(directory).replace(/^\/(var|tmp)(?=\/|$)/,'/private/$1'):path.resolve(directory);
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid() || s.mode & 0o077 || fs.realpathSync(directory) !== expected) throw Error('Unsafe temporary ownership store');
}
function valid(r) {
  return r?.version === 1 && r.kind === 'naw-test' && typeof r.path === 'string' && path.isAbsolute(r.path) && /^[a-f0-9]{64}$/.test(r.id) &&
    ['uid','dev','ino'].every(k=>Number.isSafeInteger(r[k]) && r[k]>=0) && r.uid===process.getuid() && Number.isFinite(r.createdAt) &&
    Number.isSafeInteger(r.owner?.pid) && r.owner.pid>1 && typeof r.owner.started==='string' && Boolean(r.owner.started) && typeof r.creator==='string';
}
function entry(file) {
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try {const s=fs.fstatSync(fd);if(!s.isFile()||s.uid!==process.getuid()||s.mode&0o077||s.size>8192)throw Error('Unsafe temporary ownership entry');
    const r=JSON.parse(fs.readFileSync(fd,'utf8'));if(!valid(r)||path.basename(file)!==r.id+'.json')throw Error('Invalid temporary ownership receipt');return r;
  } finally {fs.closeSync(fd);}
}
let creator;
function register(directory, { registryDir = defaultDirectory(), now = Date.now, owner } = {}) {
  const s=fs.lstatSync(directory), file=fs.realpathSync(directory);
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid!==process.getuid() || !roots().some(root=>file!==root && inside(root,file))) throw Error('Temporary ownership requires a created directory under a system temporary root');
  owner ||= (creator ||= lockIdentity(process.pid));
  if (!owner?.started) throw Error('Temporary creator identity unavailable');
  const record={version:1,kind:'naw-test',path:file,uid:s.uid,dev:s.dev,ino:s.ino,createdAt:now(),owner,
    creator:path.basename(process.argv[1] || 'NAW test')};
  record.id=receiptId(record);
  privateDirectory(registryDir,true);
  const target=path.join(registryDir,record.id+'.json');
  const pending=path.join(registryDir,'.pending-'+require('node:crypto').randomUUID());
  try {
    fs.writeFileSync(pending,JSON.stringify(record),{mode:0o600,flag:'wx'});
    try {fs.linkSync(pending,target);}
    catch(error) {if(error.code!=='EEXIST')throw error;
      const prior=entry(target);if(prior.path!==file||prior.dev!==s.dev||prior.ino!==s.ino)throw Error('Temporary ownership receipt changed');}
  } finally {try{fs.unlinkSync(pending);}catch(error){if(error.code!=='ENOENT')throw error;}}
  return record.id;
}
function read(registryDir = defaultDirectory()) {
  try { privateDirectory(registryDir); } catch(error) { if(error.code==='ENOENT') return []; throw error; }
  const names=fs.readdirSync(registryDir).filter(receiptName); if(names.length>50000) throw Error('Temporary ownership inventory is too large');
  return names.map(name=>entry(path.join(registryDir,name)));
}
// Stream bounded batches so the small read() inventory limit cannot prevent
// a large ENOENT backlog from being pruned by the scanner.
async function* batches(registryDir = defaultDirectory()) {
  try { privateDirectory(registryDir); } catch(error) { if(error.code==='ENOENT') return; throw error; }
  const directory=await fs.promises.opendir(registryDir);let batch=[];
  for await (const file of directory) {
    if(!receiptName(file.name))continue;
    try {batch.push(entry(path.join(registryDir,file.name)));}
    catch(error) {if(error.code!=='ENOENT')throw error;}
    if(batch.length===256){yield batch;batch=[];await new Promise(resolve=>setImmediate(resolve));}
  }
  if(batch.length)yield batch;
}
function forget(id, registryDir = defaultDirectory()) {
  if(!/^[a-f0-9]{64}$/.test(id)) return;
  privateDirectory(registryDir);
  const file=path.join(registryDir,id+'.json');
  try { const s=fs.lstatSync(file); if(s.isFile() && !s.isSymbolicLink() && s.uid===process.getuid() && !(s.mode&0o077)) fs.unlinkSync(file); }
  catch(error) { if(error.code!=='ENOENT') throw error; }
}
function forgetMissing(record, registryDir = defaultDirectory()) {
  try {fs.lstatSync(record.path);return false;}
  catch(error) {if(error.code!=='ENOENT')throw error;}
  const id=receiptId(record);
  if((record.reminderReceipt||record.id||id)!==id)throw Error('Temporary ownership receipt identity changed');
  try {forget(id,registryDir);}catch(error){if(error.code!=='ENOENT')throw error;}return true;
}
async function pruneMissing(registryDir = defaultDirectory()) {
  const allowed=roots();let removed=0;
  for await(const batch of batches(registryDir)) for(const record of batch) {
    if(!allowed.some(root=>record.path!==root&&inside(root,record.path))||path.resolve(record.path)!==record.path)continue;
    if(forgetMissing(record,registryDir))removed++;
  }
  return removed;
}
module.exports={register,read,batches,forget,forgetMissing,pruneMissing,defaultDirectory,roots,inside};
