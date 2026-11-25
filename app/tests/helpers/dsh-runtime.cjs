const fs=require('node:fs'),path=require('node:path');
const tui=require('../../dsh-tui.cjs'),dshCopy=require('../../dsh-copy.cjs'),privacy=require('../../butler-dsh-privacy.cjs'),update=require('../../dsh-tui-update-off.cjs');
const UPDATE='synthetic qualified TUI update source\n';
const llm=fs.readFileSync(require.resolve('@deepseek-ai/dsh-llm-deepseek'),'utf8');
privacy.patchSource(llm,privacy.VERSION);
const write=(file,text)=>{fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});fs.writeFileSync(file,text,{mode:0o600});};
function qualification(t){
 let calls=0;
 t.mock.method(update,'patchSource',(source,version)=>{calls++;if(source!==UPDATE||version!==tui.TUI_VERSION)throw Error('Unqualified synthetic update source');return source;});
 return ()=>calls;
}
function runtime(data){
 fs.mkdirSync(data,{recursive:true,mode:0o700});const w=tui.paths(data);
 write(path.join(w.tui,'package.json'),JSON.stringify({version:tui.TUI_VERSION}));write(path.join(w.dsh,'package.json'),JSON.stringify({version:tui.DSH_VERSION}));
 write(w.hostEntry,'// synthetic host; never execute\n');write(path.join(w.tui,'lib/types/update.js'),UPDATE);
 const m=path.join(w.root,'node_modules/@deepseek-ai/dsh-llm-deepseek');write(path.join(m,'package.json'),JSON.stringify({version:privacy.VERSION}));write(path.join(m,'lib/index.js'),llm);
 tui.verifyRuntime(data);return w;
}
// The copy runs in this process, so a test can mock the copier and its clock.
const inProcess=dsh=>({...dshCopy,copy:(_executable,source,target)=>dsh.inheritRuntime(source,target,{cleanStaging:true})});
module.exports={qualification,runtime,write,inProcess};
