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
module.exports={acceptOwnedFolder};
