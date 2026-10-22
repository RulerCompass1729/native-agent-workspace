// Normal quiet relaunch, distinct from the isolated headed-test launch mode.
// One owned profile; no native provider or model calls.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
const root=path.resolve(__dirname, '..');
const {_electron}=require(path.join(root,'node_modules/playwright'));
const executable=process.env.NAW_APP_EXECUTABLE||require(path.join(root,'node_modules/electron'));
const args=process.env.NAW_APP_EXECUTABLE?['--background']:[root,'--background'];
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'naw-background-'));
const env={...process.env,NAW_DATA_DIR:profile}; delete env.NAW_TEST_PARENT_PID;
let app,duplicate;
(async()=>{
 app=await _electron.launch({executablePath:executable,args,env,timeout:70000});
 const page=await app.firstWindow();await page.locator('#new-session').waitFor({timeout:60000});
 const hidden=()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().every(w=>!w.isVisible()&&!w.isFocused()));
 assert.equal(await hidden(),true);
 duplicate=spawn(executable,args,{env,stdio:'ignore'});await new Promise(r=>duplicate.once('exit',r));
 assert.equal(await hidden(),true);
 console.log(JSON.stringify({normalBackgroundStartup:true,repeatedBackgroundLaunch:true,windowsHidden:true,modelCalls:0}));
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{if(app)await app.close();if(duplicate&&duplicate.exitCode===null)duplicate.kill(); const {connect}=require(path.join(root,'app/service-client.cjs'));const c=await connect(profile,'cleanup');for(const e of c.entries)await e.client.call('shutdown');c.close();});
