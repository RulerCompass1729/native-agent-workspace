// Only authorize the isolated fixture folder after reading the real native UI.
const fs=require('node:fs'),assert=require('node:assert/strict');
async function acceptOwnedFolder(page,cwd,expectTrust=false){
 const start=Date.now(),surface=page.locator('#terminal-area');let text;
 while(Date.now()-start<60000){
  text=await surface.innerText();
  if(text.includes('Trust this folder?')||!expectTrust&&/esc to interrupt|\? for shortcuts/.test(text))break;
  await new Promise(r=>setTimeout(r,80));
 }
 if(!text?.includes('Trust this folder?')){assert.match(text||'',/esc to interrupt|\? for shortcuts/,'Native editor readiness must be observed');return;}
 const compact=text.replace(/\s/g,'');
 assert.ok([cwd,fs.realpathSync(cwd)].some(p=>compact.includes(p.replace(/\s/g,''))),'Only the exact owned fixture directory may be trusted');
 assert.match(text,/› 1\. Trust and continue/);
 await page.locator('#terminal-area .xterm-screen').click();
 while(await page.locator('#terminal-paste').isDisabled()){assert.ok(Date.now()-start<60000,'Native control acknowledgement');await new Promise(r=>setTimeout(r,50));}
 await page.locator('#terminal-area .xterm-helper-textarea').press('Enter');
}
// The other way, for scripts that keep the native TUI from asking at all: record the trust the way Codex saves it,
// in the test's private CODEX_HOME. NAW starts each new session in its own folder (<workspace>-sessions/<id>), which
// a test cannot name before the session exists, so this runs once the session is there. Only a folder inside the
// test's own temporary base may be trusted.
function trustOwnedFolder({home,base,folder}){
 // Compared as real paths: a link inside the base that points elsewhere names a folder outside it.
 const path=require('node:path'),real=fs.realpathSync(folder),realBase=fs.realpathSync(base);
 assert.ok(real.startsWith(realBase+path.sep),'Only a folder inside the owned fixture directory may be trusted: '+folder);
 assert.ok(fs.realpathSync(home).startsWith(realBase+path.sep),'The Codex home is the fixture\'s private one');
 const file=path.join(home,'config.toml');
 // The config is the fixture's own regular file, not a link to another one.
 assert.ok(fs.lstatSync(file).isFile(),'The private Codex config is a regular file');
 for(const name of new Set([folder,real])){
  const table=`[projects.${JSON.stringify(name)}]`;
  // A second table for the same folder would make the whole file unreadable to Codex.
  if(!fs.readFileSync(file,'utf8').includes(table))fs.appendFileSync(file,`\n${table}\ntrust_level = "trusted"\n`);
 }
}
module.exports={acceptOwnedFolder,trustOwnedFolder};
