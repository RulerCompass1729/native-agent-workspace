// Preloaded by the copy process (NODE_OPTIONS) and by the test itself: accepts the synthetic runtime, and slows each
// file opened under NAW_TEST_DSH_SLOW_ROOT by real milliseconds and by milliseconds of the copier's own clock.
const fs=require('node:fs'),path=require('node:path'),{performance}=require('node:perf_hooks');
const update=require('../../dsh-tui-update-off.cjs');
if(process.env.NAW_TEST_DSH_CHILD)update.patchSource=source=>{if(!source.startsWith('synthetic qualified'))throw Error('Unqualified synthetic update source');return source;};
const now=performance.now.bind(performance),open=fs.promises.open;let offset=0;
performance.now=()=>now()+offset;
fs.promises.open=async function(file,...args){
 const root=process.env.NAW_TEST_DSH_SLOW_ROOT;
 if(root&&String(file).startsWith(root+path.sep)){
  offset+=Number(process.env.NAW_TEST_DSH_CLOCK_MS||0);
  await new Promise(resolve=>setTimeout(resolve,Number(process.env.NAW_TEST_DSH_FILE_MS||0)));
 }
 return Reflect.apply(open,this,[file,...args]);
};
