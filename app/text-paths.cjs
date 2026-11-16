// A person explicitly activates a displayed absolute path. Never run a shell or
// inspect file contents. Unknown/active file types are revealed, not launched.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {uiError}=require('./ui-errors.cjs');
const passive=new Set(['png','jpg','jpeg','gif','webp','bmp','tif','tiff','heic','avif','pdf','txt','md','markdown','csv','tsv','json','log','yaml','yml','toml','xml','mp3','wav','m4a','mp4','mov']);
const active=/\.(app|command|sh|tool|terminal|pkg|mpkg|workflow|scpt|scptd|playground|playgroundbook|saver|prefpane|bundle|plugin|kext|qlgenerator|mdimporter|appex|xpc|framework|osax|component|vst|vst3|wdgt|service|applescript|automator|action|webloc|url|desktop|exe|bat|cmd|ps1|js|mjs|cjs|py|rb|pl|html|htm|svg)$/i;
const identity=s=>[s.dev,s.ino,s.mode,s.size,s.mtimeNs,s.ctimeNs].map(String).join(':');
function explicit(raw,home) {
  if(typeof raw!=='string'||!raw||raw.length>8192||/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(raw)||raw.startsWith('//'))return null;
  return raw.startsWith('~/')?path.join(home,raw.slice(2)):path.isAbsolute(raw)?path.normalize(raw):null;
}
async function resolvePath(raw,{home=os.homedir()}={}) {
  let target=explicit(raw,home);if(!target)return null;
  let line=null,stat;
  try {stat=await fs.promises.lstat(target,{bigint:true});}
  catch(error) {
    if(!['ENOENT','ENOTDIR'].includes(error.code))throw error;
    const match=raw.match(/:(\d+)(?::\d+)?$/);if(!match||!Number.isSafeInteger(Number(match[1]))||Number(match[1])<1)return null;
    target=explicit(raw.slice(0,match.index),home);line=Number(match[1]);
    try {stat=await fs.promises.lstat(target,{bigint:true});}catch(e){if(['ENOENT','ENOTDIR'].includes(e.code))return null;throw e;}
  }
  const canonical=await fs.promises.realpath(target),actual=await fs.promises.stat(canonical,{bigint:true});
  if(!actual.isDirectory()&&!actual.isFile())return null;
  // A folder inside an application bundle is still an active target. Symlinks
  // are conservatively revealed at their displayed location as well.
  const bundle=actual.isDirectory()&&(Boolean(path.extname(canonical))||(await Promise.all(['Info.plist','Contents/Info.plist'].map(async name=>{
    try{await fs.promises.lstat(path.join(canonical,name));return true;}catch(error){return !['ENOENT','ENOTDIR'].includes(error.code);}
  }))).some(Boolean));
  const executable=bundle||stat.isSymbolicLink()||[target,canonical].some(p=>p.split(path.sep).some(part=>active.test(part)))||actual.isFile()&&(Boolean(actual.mode&0o111n)||!passive.has(path.extname(canonical).slice(1).toLowerCase()));
  return {text:raw,path:target,canonical,line,lineNavigation:false,action:executable?'reveal':'open',identity:identity(stat),targetIdentity:identity(actual)};
}
async function openTextPath(raw,{openPath,reveal,isCurrent=()=>true,...options}) {
  const first=await resolvePath(raw,options);if(!first)throw uiError('error.files.missing');
  const final=await resolvePath(raw,options);
  if(!isCurrent()||!final||['identity','targetIdentity','canonical','action'].some(k=>first[k]!==final[k]))throw uiError('error.files.changedBeforeOpen');
  if(final.action==='reveal')await reveal(final.path);
  else {const error=await openPath(final.canonical);if(error!=='')throw (error?Error(error):uiError('error.localOpenUnconfirmed'));}
  return {accepted:true,action:final.action,path:final.path,line:final.line,lineNavigation:false};
}
async function inspectTextPaths(values) {
  if(!Array.isArray(values)||values.length>32)throw Error('Invalid path candidates');
  return Promise.all(values.map(async value=>{try{const r=await resolvePath(value);return r?{text:r.text,action:r.action,line:r.line}:null;}catch{return null;}}));
}
module.exports={resolvePath,openTextPath,inspectTextPaths};
