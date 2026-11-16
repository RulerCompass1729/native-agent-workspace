// Intentional orphan candidates for the person-only cleanup journey. The caller
// owns and finally removes the enclosing test-scratch root; never use a daily root.
const fs=require('node:fs'),path=require('node:path'),own=require('../../app/temp-ownership.cjs');
const base=fs.realpathSync(process.argv[2]),registry=process.argv[3];
const old=Date.now()-8*86400000,dirs=[];
for(let n=0;n<3;n++) {
  const dir=fs.mkdtempSync(path.join(base,'owned-')); fs.writeFileSync(path.join(dir,'data'),Buffer.alloc(8192,n));
  own.register(dir,{registryDir:registry,now:()=>old});
  for(const file of [path.join(dir,'data'),dir]) fs.utimesSync(file,new Date(old),new Date(old)); dirs.push(dir);
}
const unknown=fs.mkdtempSync(path.join(base,'naw-unregistered-')); fs.utimesSync(unknown,new Date(old),new Date(old));
console.log(JSON.stringify({dirs,unknown}));
